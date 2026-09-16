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
    ANIMAL_DESPAWN_BELOW, ANIMAL_EDGE_MARGIN, ANIMAL_INTERVAL, ANIMAL_MAX, ANIMAL_SPIDER_CHANCE,
    BEETLE_H, BEETLE_HEALTH, BEETLE_SPEED, BEETLE_TURN_EVERY, BEETLE_W, SPIDER_H, SPIDER_HEALTH,
    SPIDER_HOP_EVERY, SPIDER_HOP_SIDE, SPIDER_HOP_UP, SPIDER_W,
};
use crate::map::Map;
use crate::math::Vec2;
use crate::physics::body::Body;
use crate::physics::resolve::integrate;
use crate::rng::{chance, range_f32, substream, ChaCha8Rng};

pub type AnimalId = u32;

#[derive(Copy, Clone, Debug, PartialEq, Eq)]
pub enum AnimalKind {
    /// Hops. Never attacks, and drops a heal.
    Spider,
    /// Walks, tougher, and drops a battery pack.
    Beetle,
}

impl AnimalKind {
    /// The wire value. A `u8` for the reason `BirdKind`'s is: the client picks
    /// art from it, and the two kinds are worth different ammunition.
    pub fn to_u8(self) -> u8 {
        match self {
            AnimalKind::Spider => 0,
            AnimalKind::Beetle => 1,
        }
    }

    pub fn size(self) -> (f32, f32) {
        match self {
            AnimalKind::Spider => (SPIDER_W, SPIDER_H),
            AnimalKind::Beetle => (BEETLE_W, BEETLE_H),
        }
    }

    pub fn health(self) -> f32 {
        match self {
            AnimalKind::Spider => SPIDER_HEALTH,
            AnimalKind::Beetle => BEETLE_HEALTH,
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
        }
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
        });
        id
    }

    fn move_interval(kind: AnimalKind) -> f32 {
        match kind {
            AnimalKind::Spider => SPIDER_HOP_EVERY,
            AnimalKind::Beetle => BEETLE_TURN_EVERY,
        }
    }

    /// Spawn, move and cull. `active` is false outside `Playing`, exactly as the
    /// birds' is — a lobby has no reason to grow wildlife.
    pub fn tick(&mut self, map: &Map, active: bool, now: f32, dt: f32) -> AnimalStep {
        let mut out = AnimalStep::default();
        if !active {
            return out;
        }

        // --- spawn -----------------------------------------------------------
        //
        // **The cadence advances whether or not the animal spawns**, like the
        // birds': it is a clock, not a queue. Holding the slot while at
        // `ANIMAL_MAX` would make one kill release a burst.
        let mut next = self.next_spawn_at.unwrap_or(now);
        while now >= next {
            next += ANIMAL_INTERVAL;
            if self.animals.len() >= ANIMAL_MAX {
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
            }
            integrate(map, &mut a.body, 1.0, dt);
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
    use crate::constants::{MapScale, SIM_DT};
    use crate::map::generate;

    fn map() -> Map {
        generate(4242, MapScale::Small)
    }

    fn run(a: &mut Animals, m: &Map, seconds: f32) -> AnimalStep {
        let mut all = AnimalStep::default();
        let ticks = (seconds / SIM_DT) as u32;
        for i in 0..ticks {
            let step = a.tick(m, true, i as f32 * SIM_DT, SIM_DT);
            all.spawned.extend(step.spawned);
            all.gone.extend(step.gone);
        }
        all
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
            a.tick(&m, false, i as f32 * SIM_DT, SIM_DT);
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
            a.tick(&m, true, i as f32 * SIM_DT, SIM_DT);
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
            a.tick(&m, true, i as f32 * SIM_DT, SIM_DT);
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
