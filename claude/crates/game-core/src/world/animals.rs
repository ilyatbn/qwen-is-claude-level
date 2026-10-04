//! Ground animals (T20.10): jumping spiders and beetles.
//!
//! **No doc governs these.** Birds are `docs/72` §C16; a grep for
//! `animal|spider|wildlife|creature` over `docs/` and `tasks/` returns nothing,
//! and the task file asks that the gap be reported rather than papered over — an
//! amendment would be the durable home for both this and its constants block.
//!
//! ## They never attack, and that is a structural claim
//!
//! There is **no damage path from an animal to a player at all** — not a path
//! with a zero in it. An animal has no weapon, no contact rule and no entry in
//! any damage log; the only direction damage flows is *into* it, through the same
//! `HitTarget` slice every weapon already walks. The test that asserts this pairs
//! with a control that an animal can itself be killed, because "never attacks" is
//! otherwise satisfied by an animal that does not exist.
//!
//! ## Where the bird template does not carry
//!
//! A bird's `y` is a sampled sine and it has no terrain collision. A ground
//! animal has to stand on the ground, so it owns a real `Body` and goes through
//! `physics::resolve::integrate` — the same call `tombstones.rs`, `placed.rs` and
//! `items/world.rs` make for their non-player bodies. That is the whole of the
//! difference; everything else here is `birds.rs` with different verbs.

use crate::constants::{
    GravityMode, ANIMAL_DESPAWN_BELOW, ANIMAL_EDGE_MARGIN, ANIMAL_INTERVAL, ANIMAL_MAX,
    ANIMAL_SPIDER_CHANCE, BEETLE_H, BEETLE_HEALTH, BEETLE_SPEED, BEETLE_TURN_EVERY, BEETLE_W,
    COW_FLEE_SECS, COW_FLEE_SPEED, COW_GRAZE_CHANCE, COW_H, COW_HEALTH, COW_LEASH, COW_SPEED,
    COW_THINK_EVERY, COW_W, SPIDER_H, SPIDER_HEALTH, SPIDER_HOP_EVERY, SPIDER_HOP_SIDE,
    SPIDER_HOP_UP, SPIDER_W,
};
use crate::map::Map;
use crate::math::Vec2;
use crate::physics::body::Body;
use crate::physics::resolve::{integrate, Forces};
use crate::rng::{chance, range_f32, substream, ChaCha8Rng};

pub type AnimalId = u32;

#[derive(Copy, Clone, Debug, PartialEq, Eq)]
pub enum AnimalKind {
    /// Hops. Never attacks, and drops a heal.
    Spider,
    /// Walks, tougher, and drops a battery pack.
    Beetle,
    /// T24.01 task 4: the alien cow — one grazes by each durian tree, from the round's start (`with_cow_homes`), and
    /// drops a durian grenade. Ambles and grazes within `COW_LEASH` of its tree, sleeps there at night, flees when hurt.
    Cow,
}

impl AnimalKind {
    /// The wire value. A `u8` for the reason `BirdKind`'s is: the client picks
    /// art from it, and the two kinds are worth different ammunition.
    pub fn to_u8(self) -> u8 {
        match self {
            AnimalKind::Spider => 0,
            AnimalKind::Beetle => 1,
            AnimalKind::Cow => 2,
        }
    }

    pub fn size(self) -> (f32, f32) {
        match self {
            AnimalKind::Spider => (SPIDER_W, SPIDER_H),
            AnimalKind::Beetle => (BEETLE_W, BEETLE_H),
            AnimalKind::Cow => (COW_W, COW_H),
        }
    }

    pub fn health(self) -> f32 {
        match self {
            AnimalKind::Spider => SPIDER_HEALTH,
            AnimalKind::Beetle => BEETLE_HEALTH,
            AnimalKind::Cow => COW_HEALTH,
        }
    }
}

#[derive(Clone, Debug)]
pub struct Animal {
    pub id: AnimalId,
    pub kind: AnimalKind,
    pub body: Body,
    pub health: f32,
    /// Next time this one hops (spider) or reconsiders its heading (beetle).
    next_move_at: f32,
    /// Signed heading, -1 or 1. Kept rather than derived from `vel.x`, which is
    /// zero for most of a spider's life and would flip its art mid-hop.
    dir: f32,
    /// T24.01: a cow's tree (its trunk's foot), which it grazes by; `None` for every other animal.
    pub home: Option<Vec2>,
    /// T24.01: a cow is grazing (standing) rather than ambling until its next choice.
    grazing: bool,
    /// T24.01: a hurt cow flees until this round time.
    flee_until: f32,
}

impl Animal {
    pub fn size(&self) -> (f32, f32) {
        self.kind.size()
    }

    pub fn pos(&self) -> Vec2 {
        self.body.pos
    }

    /// Facing, for the client. `true` when heading right.
    pub fn facing_right(&self) -> bool {
        self.dir > 0.0
    }
}

/// One animal that has just died, and what it leaves.
#[derive(Copy, Clone, Debug)]
pub struct AnimalKill {
    pub id: AnimalId,
    pub kind: AnimalKind,
    pub at: Vec2,
}

/// What one `Animals::tick` did.
///
/// Named fields rather than two bare `Vec<AnimalId>`, for the reason `BirdStep`
/// gives: two lists that mean opposite things handed over positionally is how a
/// caller announces a spawn for something that has just despawned.
#[derive(Clone, Debug, Default)]
pub struct AnimalStep {
    pub spawned: Vec<AnimalId>,
    /// Fell out of the world. **Not** the same as killed — nothing drops.
    pub gone: Vec<AnimalId>,
}

#[derive(Clone, Debug)]
pub struct Animals {
    rng: ChaCha8Rng,
    animals: Vec<Animal>,
    next_id: AnimalId,
    /// `None` until the first tick that is allowed to spawn, like `Birds`.
    next_spawn_at: Option<f32>,
    /// T24.01: where the cows live (each durian tree's foot and the side its cow starts on), hatched on the first
    /// active tick and never again — a dead cow stays dead for the round.
    cow_homes: Vec<(Vec2, f32)>,
    cows_hatched: bool,
}

impl Animals {
    /// **Its own substream.** Drawing from the world's RNG would make the
    /// animals' rolls a function of how many bullets had been fired, which is the
    /// whole reason `substream` exists.
    pub fn new(seed: u64) -> Self {
        Self {
            rng: substream(seed, "animals"),
            animals: Vec::new(),
            next_id: 0,
            next_spawn_at: None,
            cow_homes: Vec::new(),
            cows_hatched: false,
        }
    }

    /// T24.01: one cow per `(tree foot, side)` — `World::new` hands the map's durian trees over.
    pub fn with_cow_homes(mut self, homes: Vec<(Vec2, f32)>) -> Self {
        self.cow_homes = homes;
        self
    }

    /// T24.01: a cow is hurt — it flees away from `from` (the nearest player) for `COW_FLEE_SECS`. Any other
    /// animal ignores it.
    pub fn scare(&mut self, id: AnimalId, from: Vec2, now: f32) {
        if let Some(a) = self
            .animals
            .iter_mut()
            .find(|a| a.id == id && a.kind == AnimalKind::Cow)
        {
            a.dir = if a.body.pos.x >= from.x { 1.0 } else { -1.0 };
            a.flee_until = now + COW_FLEE_SECS;
        }
    }

    /// T24.01: hatch a cow at each home — on the map's surface point (a validated standing spot, `MapMeta`) nearest
    /// `COW_HOME_OFFSET` to the home's side **on the tree's own level** (within a body's height of its foot; a point
    /// below a narrow ledge would put the cow in the pit beside it — measured: seed 7's two cows landed 64 px under
    /// their trees and one never moved again), else on the tree's foot itself.
    fn hatch_cows(&mut self, map: &Map, now: f32) -> Vec<AnimalId> {
        let mut out = Vec::new();
        let (w, h) = AnimalKind::Cow.size();
        let level = crate::constants::PLAYER_H;
        for (foot, side) in self.cow_homes.clone() {
            let want = foot.x + side * crate::constants::COW_HOME_OFFSET;
            let at = map
                .meta
                .surface_points
                .iter()
                .map(|p| Vec2::new(p.x as f32, p.y as f32))
                .filter(|p| (p.y - foot.y).abs() <= level && (p.x - foot.x).abs() <= COW_LEASH)
                .min_by(|a, b| (a.x - want).abs().total_cmp(&(b.x - want).abs()))
                .unwrap_or(foot);
            let id = self.next_id;
            self.next_id += 1;
            self.animals.push(Animal {
                id,
                kind: AnimalKind::Cow,
                body: Body::sized(Vec2::new(at.x, at.y - h / 2.0), w, h),
                health: COW_HEALTH,
                next_move_at: now + COW_THINK_EVERY,
                dir: -side,
                home: Some(foot),
                grazing: true,
                flee_until: f32::NEG_INFINITY,
            });
            out.push(id);
        }
        out
    }

    pub fn iter(&self) -> impl Iterator<Item = &Animal> {
        self.animals.iter()
    }

    pub fn len(&self) -> usize {
        self.animals.len()
    }

    pub fn is_empty(&self) -> bool {
        self.animals.is_empty()
    }

    pub fn get(&self, id: AnimalId) -> Option<&Animal> {
        self.animals.iter().find(|a| a.id == id)
    }

    /// Put a known animal in a known place.
    ///
    /// **Essential, not a convenience.** Natural spawn takes `ANIMAL_INTERVAL`
    /// and picks its own column, so a test that waited for one would be slow and
    /// a test that then shot at it would be a lottery. `birds.rs` has the same
    /// seam for the same reason.
    pub fn place_for_test(&mut self, kind: AnimalKind, at: Vec2, now: f32) -> AnimalId {
        let id = self.next_id;
        self.next_id += 1;
        let (w, h) = kind.size();
        self.animals.push(Animal {
            id,
            kind,
            body: Body::sized(at, w, h),
            health: kind.health(),
            next_move_at: now + Self::move_interval(kind),
            dir: 1.0,
            home: None,
            grazing: false,
            flee_until: f32::NEG_INFINITY,
        });
        id
    }

    fn move_interval(kind: AnimalKind) -> f32 {
        match kind {
            AnimalKind::Spider => SPIDER_HOP_EVERY,
            AnimalKind::Beetle => BEETLE_TURN_EVERY,
            AnimalKind::Cow => COW_THINK_EVERY,
        }
    }

    /// Spawn, move and cull. `active` is false outside `Playing`, exactly as the
    /// birds' is — a lobby has no reason to grow wildlife.
    ///
    /// **And false for the whole of a space round** (`M22-RULINGS` R14's
    /// *"no animals at all in space"*, assigned by R58 to T22.13). The caller
    /// folds that in: `world/mod.rs::World::wildlife_allowed` is the one guard,
    /// shared with `step_birds`, and it is keyed on the **generator** — which
    /// R15 derives from the gravity mode — rather than on the mode field. It
    /// is not done here because `Birds::tick` has no `&Map` to do it with, and
    /// a rule with two homes is a rule that drifts.
    ///
    /// The `gravity` argument below is a **separate** question and stays: R14
    /// zeroes an animal's fall in space (and scales it by `LOW_GRAVITY_SCALE`
    /// under `Low`), which is
    /// what a beetle put here by `place_for_test` still needs.
    pub fn tick(
        &mut self,
        map: &Map,
        active: bool,
        gravity: GravityMode,
        now: f32,
        dt: f32,
    ) -> AnimalStep {
        self.tick_at_night(map, active, gravity, false, now, dt)
    }

    /// [`Animals::tick`], told whether it is night (T24.01: a cow sleeps by its tree at night).
    pub fn tick_at_night(
        &mut self,
        map: &Map,
        active: bool,
        gravity: GravityMode,
        night: bool,
        now: f32,
        dt: f32,
    ) -> AnimalStep {
        let mut out = AnimalStep::default();
        if !active {
            return out;
        }
        // T24.01: the cows, once, on the first tick wildlife may live.
        if !self.cows_hatched {
            self.cows_hatched = true;
            out.spawned.extend(self.hatch_cows(map, now));
        }

        // --- spawn -----------------------------------------------------------
        //
        // **The cadence advances whether or not the animal spawns**, like the
        // birds': it is a clock, not a queue. Holding the slot while at
        // `ANIMAL_MAX` would make one kill release a burst.
        let mut next = self.next_spawn_at.unwrap_or(now);
        while now >= next {
            next += ANIMAL_INTERVAL;
            // T24.01: the cows are their trees', not the spawner's — the cap counts the rest.
            if self
                .animals
                .iter()
                .filter(|a| a.kind != AnimalKind::Cow)
                .count()
                >= ANIMAL_MAX
            {
                continue;
            }
            if let Some(id) = self.hatch(map, now) {
                out.spawned.push(id);
            }
        }
        self.next_spawn_at = Some(next);

        // --- move ------------------------------------------------------------
        for a in self.animals.iter_mut() {
            if now >= a.next_move_at {
                a.next_move_at = now + Self::move_interval(a.kind);
                match a.kind {
                    // A hop only leaves the ground from the ground. A spider that
                    // fired its impulse mid-air would climb a wall.
                    AnimalKind::Spider => {
                        if a.body.grounded {
                            a.dir = if chance(&mut self.rng, 0.5) {
                                1.0
                            } else {
                                -1.0
                            };
                            a.body.vel.y = -SPIDER_HOP_UP;
                            a.body.vel.x = a.dir * SPIDER_HOP_SIDE;
                        }
                    }
                    AnimalKind::Beetle => {
                        a.dir = if chance(&mut self.rng, 0.5) {
                            1.0
                        } else {
                            -1.0
                        };
                    }
                    // T24.01: graze (stand) or amble; past the leash, head home. Both draws made every choice, so
                    // the stream does not depend on where the cow happens to be.
                    AnimalKind::Cow => {
                        let graze = chance(&mut self.rng, COW_GRAZE_CHANCE);
                        let right = chance(&mut self.rng, 0.5);
                        a.grazing = graze;
                        a.dir = if right { 1.0 } else { -1.0 };
                        if let Some(home) = a.home {
                            let off = a.body.pos.x - home.x;
                            if off.abs() > COW_LEASH {
                                a.grazing = false;
                                a.dir = -off.signum();
                            } else if graze {
                                // Grazing faces the trunk, as the tongue reaches for it.
                                a.dir = if off > 0.0 { -1.0 } else { 1.0 };
                            }
                        }
                    }
                }
            }
            // A beetle walks continuously; a spider coasts between hops and is
            // slowed by the ground it lands on.
            match a.kind {
                AnimalKind::Beetle => a.body.vel.x = a.dir * BEETLE_SPEED,
                AnimalKind::Spider => {
                    if a.body.grounded {
                        a.body.vel.x = 0.0;
                    }
                }
                // T24.01: fleeing beats sleeping beats grazing; else it ambles — and an ambling cow turns back at a
                // drop deeper than a body (it grazes by its tree; one that walked off the ledge could not climb back).
                AnimalKind::Cow => {
                    if now >= a.flee_until && a.body.grounded && !Self::ground_ahead(map, a) {
                        a.dir = -a.dir;
                    }
                    a.body.vel.x = if now < a.flee_until {
                        a.dir * COW_FLEE_SPEED
                    } else if night || a.grazing {
                        0.0
                    } else {
                        a.dir * COW_SPEED
                    };
                }
            }
            // **The match's gravity setting, not a literal `1.0`**
            // (`M22-RULINGS` R30, R14, R48). Until T22.11A this passed `1.0`
            // and `false` unconditionally, so in a low-gravity match this body
            // fell at twice the speed of the player who dropped it — a bug
            // visible in a shipped mode, not polish. `Forces::falling` is the
            // one place the mode becomes this body's scale **and** its contact
            // rules, so the two cannot drift apart at four call sites.
            integrate(map, &mut a.body, Forces::falling(gravity), dt);
        }

        // --- cull ------------------------------------------------------------
        //
        // Only for falling out of the world. Nothing here removes a healthy
        // animal, which is what makes `ANIMAL_MAX` a population rather than a
        // turnover — `apply_damage` is the only other way one leaves.
        let floor = map.mask.h as f32 + ANIMAL_DESPAWN_BELOW;
        self.animals.retain(|a| {
            if a.body.pos.y <= floor {
                true
            } else {
                out.gone.push(a.id);
                false
            }
        });
        out
    }

    /// T24.01: is there ground a step ahead of `a` (just past its leading edge), no deeper than `PLAYER_H` below its
    /// feet? False at a ledge's lip.
    fn ground_ahead(map: &Map, a: &Animal) -> bool {
        let (w, h) = a.size();
        let x = (a.body.pos.x + a.dir * (w / 2.0 + 2.0)) as i32;
        let feet = (a.body.pos.y + h / 2.0) as i32;
        (feet - 2..=feet + crate::constants::PLAYER_H as i32).any(|y| map.mask.get(x, y))
    }

    /// Where a new animal goes: a clear column, standing on the ground.
    fn hatch(&mut self, map: &Map, now: f32) -> Option<AnimalId> {
        let kind = if chance(&mut self.rng, ANIMAL_SPIDER_CHANCE) {
            AnimalKind::Spider
        } else {
            AnimalKind::Beetle
        };
        let (w, h) = kind.size();
        let lo = ANIMAL_EDGE_MARGIN;
        let hi = (map.mask.w as f32 - ANIMAL_EDGE_MARGIN).max(lo + 1.0);
        // A handful of tries rather than a scan: the column has to have ground in
        // it, and on a cave-heavy map most do. Giving up is a spawn that did not
        // happen, which the cadence above already treats as normal.
        for _ in 0..8 {
            let x = range_f32(&mut self.rng, lo, hi);
            let col = x as i32;
            // **`continue`, not `?`.** A `?` here gave up on all eight tries the
            // first time a column had no ground in it, which is the opposite of
            // what the comment above says this loop does. Unreachable on the
            // shipped generator — measured, **0 of 2048/3072/4096 columns across
            // three scales x four seeds have no ground**, which is why it never
            // bit — but a void map or a future generator makes it a spawner that
            // gives up on its first bad draw.
            let Some(top) = (0..map.mask.h as i32).find(|y| map.mask.get(col, *y)) else {
                continue;
            };
            // Sitting **on** the surface: the body's centre is half its height
            // above the first solid pixel, so `integrate`'s ground snap has
            // nothing to correct on the first frame.
            let y = top as f32 - h / 2.0;
            if y <= 0.0 {
                continue;
            }
            let id = self.next_id;
            self.next_id += 1;
            self.animals.push(Animal {
                id,
                kind,
                body: Body::sized(Vec2::new(x, y), w, h),
                health: kind.health(),
                next_move_at: now + Self::move_interval(kind),
                dir: if chance(&mut self.rng, 0.5) {
                    1.0
                } else {
                    -1.0
                },
                home: None,
                grazing: false,
                flee_until: f32::NEG_INFINITY,
            });
            return Some(id);
        }
        None
    }

    /// Apply a tick's worth of damage and return what died.
    ///
    /// Shaped exactly like `Birds::apply_damage`, and deliberately: the caller
    /// resolves both through one loot path, so two different return shapes would
    /// be two different call sites to keep in step.
    pub fn apply_damage(&mut self, log: &[(AnimalId, f32)]) -> Vec<AnimalKill> {
        for (id, amount) in log {
            if let Some(a) = self.animals.iter_mut().find(|a| a.id == *id) {
                a.health -= amount;
            }
        }
        let mut kills = Vec::new();
        self.animals.retain(|a| {
            if a.health > 0.0 {
                true
            } else {
                kills.push(AnimalKill {
                    id: a.id,
                    kind: a.kind,
                    at: a.body.pos,
                });
                false
            }
        });
        kills
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::constants::{MapScale, LOW_GRAVITY_SCALE, SIM_DT};
    use crate::map::generate;

    fn map() -> Map {
        generate(4242, MapScale::Small)
    }

    fn run(a: &mut Animals, m: &Map, seconds: f32) -> AnimalStep {
        let mut all = AnimalStep::default();
        let ticks = (seconds / SIM_DT) as u32;
        for i in 0..ticks {
            let step = a.tick(m, true, GravityMode::Standard, i as f32 * SIM_DT, SIM_DT);
            all.spawned.extend(step.spawned);
            all.gone.extend(step.gone);
        }
        all
    }

    /// **An animal falls at the match's rate, and in space it does not fall at
    /// all** — `M22-RULINGS` R30, R14, R48.
    ///
    /// Until T22.11A this stepper passed a literal `1.0`. Vertical only: R14's
    /// *"no animals at all in space"* is a spawning rule and not this stepper's,
    /// so a beetle placed in a vacuum still walks — what it must not do is fall.
    ///
    /// The `Standard` arm is the control; without it the `Low` and `Space`
    /// assertions are both satisfied by a stepper that stopped integrating.
    #[test]
    fn an_animal_falls_by_the_match_gravity_and_not_at_all_in_space() {
        let m = map();
        let fall = |mode: GravityMode| -> f32 {
            let mut a = Animals::new(7);
            let id = a.place_for_test(AnimalKind::Beetle, Vec2::new(300.0, 40.0), 0.0);
            for i in 0..25 {
                a.tick(&m, true, mode, i as f32 * SIM_DT, SIM_DT);
            }
            let b = a.get(id).expect("the beetle left the world");
            assert!(!b.body.grounded, "precondition: it landed, not a fall");
            b.body.pos.y - 40.0
        };
        let (std, low, space) = (
            fall(GravityMode::Standard),
            fall(GravityMode::Low),
            fall(GravityMode::Space),
        );
        // See `tombstones`' twin for why this is an epsilon and not `assert_eq!`.
        assert!(
            (low - std * LOW_GRAVITY_SCALE).abs() < 0.001,
            "R30: a beetle fell {low} px in low gravity against {std} px in \
             standard, which is not the mode's scale"
        );
        assert!(std > 0.0, "control: the fixture cannot see gravity at all");
        assert_eq!(space, 0.0, "R14: an animal fell in space");
    }

    #[test]
    fn a_round_grows_animals_up_to_the_cap_and_stops() {
        let m = map();
        let mut a = Animals::new(7);
        // Long enough for many more than `ANIMAL_MAX` cadences to fire.
        run(&mut a, &m, ANIMAL_INTERVAL * (ANIMAL_MAX as f32 + 6.0));
        assert_eq!(
            a.len(),
            ANIMAL_MAX,
            "the population settled at {} rather than the cap",
            a.len()
        );
    }

    #[test]
    fn nothing_spawns_while_inactive() {
        // The control for the test above: without it, "animals appear" would pass
        // for a spawner that ignores the phase and runs in a lobby.
        let m = map();
        let mut a = Animals::new(7);
        for i in 0..3600 {
            a.tick(&m, false, GravityMode::Standard, i as f32 * SIM_DT, SIM_DT);
        }
        assert!(a.is_empty(), "a lobby grew {} animals", a.len());
    }

    #[test]
    fn both_kinds_are_reachable_across_seeds() {
        // A population claim needs more than one draw.
        let m = map();
        let mut seen_spider = false;
        let mut seen_beetle = false;
        for seed in 0..12u64 {
            let mut a = Animals::new(seed);
            run(&mut a, &m, ANIMAL_INTERVAL * (ANIMAL_MAX as f32 + 2.0));
            for x in a.iter() {
                match x.kind {
                    AnimalKind::Spider => seen_spider = true,
                    AnimalKind::Beetle => seen_beetle = true,
                    // T24.01: the spawner never hatches a cow (`Animals::new` has no homes).
                    AnimalKind::Cow => panic!("the natural spawner hatched a cow"),
                }
            }
        }
        assert!(seen_spider && seen_beetle, "one kind never appeared");
    }

    #[test]
    fn every_animal_stands_on_the_ground_rather_than_falling_through_it() {
        let m = map();
        let mut a = Animals::new(11);
        run(&mut a, &m, ANIMAL_INTERVAL * (ANIMAL_MAX as f32 + 2.0));
        assert!(!a.is_empty(), "nothing spawned, so nothing is asserted");
        for x in a.iter() {
            assert!(
                x.body.pos.y < m.mask.h as f32,
                "an animal is below the world at {:?}",
                x.body.pos
            );
        }
    }

    /// **A spider leaves the ground, and a beetle does not.** The name of the
    /// thing has to be true.
    #[test]
    fn a_spider_hops_and_a_beetle_walks() {
        let m = map();
        let mut a = Animals::new(3);
        // On the surface of a known column, so neither is falling to begin with.
        let col = m.mask.w as i32 / 2;
        let top = (0..m.mask.h as i32)
            .find(|y| m.mask.get(col, *y))
            .expect("a column with ground in it");
        let spider = a.place_for_test(
            AnimalKind::Spider,
            Vec2::new(col as f32, top as f32 - SPIDER_H / 2.0),
            0.0,
        );
        let beetle = a.place_for_test(
            AnimalKind::Beetle,
            Vec2::new(col as f32 + 40.0, top as f32 - BEETLE_H / 2.0),
            0.0,
        );

        let mut spider_lift = 0.0f32;
        let mut beetle_lift = 0.0f32;
        let start_s = a.get(spider).expect("placed").body.pos.y;
        let start_b = a.get(beetle).expect("placed").body.pos.y;
        let ticks = ((SPIDER_HOP_EVERY * 3.0) / SIM_DT) as u32;
        for i in 0..ticks {
            a.tick(&m, true, GravityMode::Standard, i as f32 * SIM_DT, SIM_DT);
            if let Some(s) = a.get(spider) {
                spider_lift = spider_lift.max(start_s - s.body.pos.y);
            }
            if let Some(b) = a.get(beetle) {
                beetle_lift = beetle_lift.max(start_b - b.body.pos.y);
            }
        }
        assert!(
            spider_lift > SPIDER_H,
            "the spider never left the ground: peak lift {spider_lift}"
        );
        // The control: a beetle on the same terrain over the same window does
        // not, so "it hops" is about the spider and not about the ground.
        assert!(
            beetle_lift < SPIDER_H,
            "the beetle hopped too: peak lift {beetle_lift}"
        );
    }

    #[test]
    fn a_beetle_covers_ground_and_a_resting_spider_does_not_drift() {
        let m = map();
        let mut a = Animals::new(5);
        let col = m.mask.w as i32 / 2;
        let top = (0..m.mask.h as i32)
            .find(|y| m.mask.get(col, *y))
            .expect("ground");
        let beetle = a.place_for_test(
            AnimalKind::Beetle,
            Vec2::new(col as f32, top as f32 - BEETLE_H / 2.0),
            0.0,
        );
        let from = a.get(beetle).expect("placed").body.pos.x;
        for i in 0..((BEETLE_TURN_EVERY / SIM_DT) as u32) {
            a.tick(&m, true, GravityMode::Standard, i as f32 * SIM_DT, SIM_DT);
        }
        let moved = (a.get(beetle).expect("alive").body.pos.x - from).abs();
        assert!(moved > BEETLE_W, "the beetle walked {moved} px in a turn");
    }

    #[test]
    fn damage_kills_and_reports_what_it_was() {
        let m = map();
        let mut a = Animals::new(1);
        let id = a.place_for_test(AnimalKind::Beetle, Vec2::new(100.0, 100.0), 0.0);
        // Less than its health: nothing dies, which is the control for the kill.
        let kills = a.apply_damage(&[(id, BEETLE_HEALTH - 1.0)]);
        assert!(kills.is_empty(), "a beetle died to a graze");
        assert_eq!(a.len(), 1);

        let kills = a.apply_damage(&[(id, 1.0)]);
        assert_eq!(kills.len(), 1);
        assert_eq!(kills[0].kind, AnimalKind::Beetle);
        assert!(a.is_empty());
        let _ = &m;
    }

    #[test]
    fn a_spider_dies_to_one_hit_of_anything() {
        let mut a = Animals::new(1);
        let id = a.place_for_test(AnimalKind::Spider, Vec2::new(100.0, 100.0), 0.0);
        assert_eq!(a.apply_damage(&[(id, SPIDER_HEALTH)]).len(), 1);
    }

    #[test]
    fn the_same_seed_grows_the_same_animals() {
        let m = map();
        let describe = |seed: u64| {
            let mut a = Animals::new(seed);
            run(&mut a, &m, ANIMAL_INTERVAL * (ANIMAL_MAX as f32 + 2.0));
            a.iter()
                .map(|x| (x.id, x.kind, x.body.pos.x, x.body.pos.y))
                .collect::<Vec<_>>()
        };
        assert_eq!(describe(99), describe(99));
        // The control: a different seed is a different population, or the
        // equality above holds for a spawner that ignores its RNG.
        assert_ne!(describe(99), describe(100));
    }
}
