//! T23.38 — **the black hole swallows everything** (owner, 2026-10-03: *"black holes
//! swallow tombstones, items, everything. there shouldn't be anything on top of it."*).
//!
//! Three rules, each in one place:
//! - **the pull** on loose things — items, crates, graves, mines — is [`loose_forces`]:
//!   `Forces::falling`, plus the hole's own pull (`Attractor::black_hole`, the body's
//!   law and numbers) inside its reach while it [`black_hole::pulls`], capped at
//!   `SPACE_MAX_SPEED` as a body is. *R14 ("nothing attracts these bodies — loot
//!   drifting into one is loot deletion") is overridden here by the owner's ruling, for
//!   the hole only*: the asteroid wells and the vortices still leave loot alone.
//!   **Projectiles are not pulled** (a rocket curving into the hole is a balance change
//!   nobody asked for); they are only swallowed if they fly into the horizon;
//! - **the swallow** is [`World::swallow_at_horizon`], from `step_black_hole` after the
//!   horizon's kill: anything whose centre is inside the horizon ([`black_hole::in_horizon`],
//!   the one predicate the kill uses) is removed, announced by its own despawn event
//!   (which is what removes it on the client) **and** a [`GameEvent::Swallowed`] (which
//!   draws it going in);
//! - **nothing spawns inside the reach** while the hole is telegraphed or open
//!   (`items::spawning::outside_reach`, keyed on `World::black_hole_site`), and a death
//!   in the hole leaves no grave (`resolve_deaths`, beside R92's no-drop) — the buried
//!   items of the rock it eats are never revealed (`arrive_black_hole`).
//!
//! Graves and mines had no move event (the client drew them where they were placed for
//! good), so a pulled one would have sat still on screen and vanished: they now have
//! `TombstoneMove` / `MineMove` on [`Motion`]'s rule, which also carries a grave whose
//! ground is blown away under standard gravity.

use crate::constants::{GravityMode, CRATE_H, CRATE_W, SPACE_MAX_SPEED};
use crate::items::world::SpawnSource;
use crate::math::Vec2;
use crate::physics::body::Body;
use crate::physics::collide::aabb_overlaps_solid;
use crate::physics::resolve::Forces;
use crate::weapons::placed::{MineEnd, Mines};
use crate::world::attractors::Attractor;
use crate::world::black_hole::{self, in_horizon};
use crate::world::tombstones::Tombstones;
use crate::world::{DespawnReason, GameEvent, World};

/// What the hole swallowed — the `swallowed` event's `what`. Cosmetic: the client picks
/// the streak's colour by it.
#[derive(Copy, Clone, Debug, PartialEq, Eq)]
pub enum SwallowKind {
    Item,
    Crate,
    Grave,
    Mine,
    Projectile,
}

impl SwallowKind {
    /// The wire's word.
    pub fn as_str(self) -> &'static str {
        match self {
            SwallowKind::Item => "item",
            SwallowKind::Crate => "crate",
            SwallowKind::Grave => "grave",
            SwallowKind::Mine => "mine",
            SwallowKind::Projectile => "projectile",
        }
    }
}

/// The forces on a loose body at `pos`, and whether the hole pulls it: `hole` is the
/// black hole while it pulls (`World::pulling_hole`), `None` otherwise. Outside the
/// reach (or with no hole) this is exactly `Forces::falling(gravity)`, so every other
/// game is untouched.
pub fn loose_forces(gravity: GravityMode, hole: Option<Vec2>, pos: Vec2) -> (Forces, bool) {
    let falling = Forces::falling(gravity);
    let pull = hole.map_or(Vec2::ZERO, |h| Attractor::black_hole(h).pull_at(pos));
    if pull == Vec2::ZERO {
        return (falling, false);
    }
    let pulled = Forces {
        accel: pull,
        max_speed: Some(SPACE_MAX_SPEED),
        ..falling
    };
    (pulled, true)
}

/// Each loose thing's id and position before a step — what [`Motion`]'s rule compares
/// against after it.
pub type Before = Vec<(u32, Vec2)>;

/// Which loose thing a motion record is for (`World::loose_sent`'s key).
#[derive(Copy, Clone, Debug, PartialEq, Eq, PartialOrd, Ord)]
pub enum LooseKind {
    Grave,
    Mine,
}

/// **When a grave's or a mine's position goes out** — `ItemMove`'s two rules: at
/// `SNAPSHOT_HZ` while it is somewhere other than where it was last said to be, and
/// **on the tick it stops** there (it did not move this step) — so the resting place
/// is always the last thing heard. Compared against what was last *sent*
/// (`World::loose_sent`), not against the velocity: a grave settling onto a slope
/// moves a fraction of a pixel with its velocity still set (`ground_snap`), and a
/// velocity rule sent the landing and missed the settle.
struct Motion;

impl Motion {
    fn due(tick: u32) -> bool {
        let every = (crate::constants::SIM_HZ / crate::constants::SNAPSHOT_HZ).max(1);
        tick.is_multiple_of(every)
    }

    fn goes_out(due: bool, before: Vec2, pos: Vec2, sent: Vec2) -> bool {
        pos != sent && (due || before == pos)
    }
}

/// Every grave's id and position, before the step.
pub fn grave_motion(t: &Tombstones) -> Before {
    t.all().iter().map(|g| (g.id as u32, g.pos)).collect()
}

/// Every mine's id and position, before the step.
pub fn mine_motion(m: &Mines) -> Before {
    m.iter().map(|m| (m.id, m.pos())).collect()
}

impl World {
    /// The black hole, while it pulls (R8.4: not after the bell) — what the loose
    /// things' step is handed.
    pub(super) fn pulling_hole(&self) -> Option<Vec2> {
        self.black_hole().filter(|_| black_hole::pulls(self.phase))
    }

    /// Will `pos` be swallowed at the end of this tick (`step_black_hole` → [`World::swallow_at_horizon`])? A thing
    /// there gets **no move event**: the move would be drawn inside the horizon until its despawn lands (T23.42 found
    /// a mine drawn there; the unit test asserts no move of any kind does). The one guard both motion paths share.
    pub(super) fn swallowed_this_tick(&self, pos: Vec2) -> bool {
        self.phase == crate::world::RoundPhase::Playing
            && self.map.space_geometry().is_some()
            && self
                .black_hole
                .pos()
                .is_some_and(|hole| in_horizon(hole, pos))
    }

    /// [`Motion`]'s rule over one kind: `now` is every thing's id and position after
    /// the step. A thing first seen is taken to have been sent where it was before the
    /// step (its spawn event said so); a thing gone is forgotten.
    fn loose_motion(&mut self, kind: LooseKind, before: &Before, now: &Before) -> Vec<(u32, Vec2)> {
        let due = Motion::due(self.tick);
        self.loose_sent
            .retain(|(k, id), _| *k != kind || now.iter().any(|(i, _)| i == id));
        let mut out = Vec::new();
        for &(id, pos) in now {
            let Some(&(_, b)) = before.iter().find(|(i, _)| *i == id) else {
                // Spawned during the step: its spawn event carries this position.
                self.loose_sent.insert((kind, id), pos);
                continue;
            };
            let sent = *self.loose_sent.entry((kind, id)).or_insert(b);
            if Motion::goes_out(due, b, pos, sent) && !self.swallowed_this_tick(pos) {
                self.loose_sent.insert((kind, id), pos);
                out.push((id, pos));
            }
        }
        out
    }

    pub(super) fn emit_grave_motion(&mut self, before: &Before) {
        let tick = self.tick;
        let now = grave_motion(&self.tombstones);
        for (id, at) in self.loose_motion(LooseKind::Grave, before, &now) {
            self.events.push(GameEvent::TombstoneMove {
                tick,
                id: id as crate::world::tombstones::TombstoneId,
                x: at.x,
                y: at.y,
            });
        }
    }

    pub(super) fn emit_mine_motion(&mut self, before: &Before) {
        let tick = self.tick;
        let now = mine_motion(&self.mines);
        for (id, at) in self.loose_motion(LooseKind::Mine, before, &now) {
            self.events.push(GameEvent::MineMove {
                tick,
                id,
                x: at.x,
                y: at.y,
            });
        }
    }

    /// A bearing from the hole along which a crate-sized box (the largest loose body)
    /// fits all the way out to `d` — nearest straight down first, so a check's camera
    /// sees it. `None` if no bearing of `BEARINGS` is clear.
    pub fn clear_bearing_from(&self, hole: Vec2, d: f32) -> Option<Vec2> {
        const BEARINGS: usize = 32;
        let steps = (d / CRATE_W).ceil() as i32;
        (0..BEARINGS)
            .map(|i| {
                std::f32::consts::FRAC_PI_2 + i as f32 * std::f32::consts::TAU / BEARINGS as f32
            })
            .map(|a| Vec2::new(a.cos(), a.sin()))
            .find(|dir| {
                (0..=steps).all(|i| {
                    let at = hole + *dir * (d * i as f32 / steps as f32);
                    !aabb_overlaps_solid(&self.map, Body::sized(at, CRATE_W, CRATE_H).aabb())
                })
            })
    }

    /// Dev seam (`debug_black_hole`'s `litter`, `DEV_PROBE=1`): an item, a crate, a
    /// grave and a mine at rest from `dist` out along a clear bearing, a crate's width
    /// apart, each announced exactly as its ordinary spawn is — so a browser check can
    /// watch them drift in and go. Returns the first one's place; `None` with no hole
    /// or no clear bearing.
    pub fn dev_litter_near_black_hole(&mut self, dist: f32) -> Option<Vec2> {
        let hole = self.black_hole()?;
        let dir = self.clear_bearing_from(hole, dist + 4.0 * CRATE_W)?;
        let at = |i: f32| hole + dir * (dist + i * CRATE_W);
        let (tick, now) = (self.tick, self.round_time);
        let item = crate::items::registry::FLASHLIGHT;
        let id = self
            .items
            .spawn(item, 1, at(0.0), Vec2::ZERO, SpawnSource::Periodic, now);
        self.events.push(GameEvent::ItemSpawn {
            tick,
            world_item_id: id,
            item_id: item,
            count: 1,
            x: at(0.0).x,
            y: at(0.0).y,
            source: SpawnSource::Periodic,
        });
        let id = self
            .items
            .spawn(item, 1, at(1.0), Vec2::ZERO, SpawnSource::Crate, now);
        self.events.push(GameEvent::CrateSpawn {
            tick,
            world_item_id: id,
            x: at(1.0).x,
            y: at(1.0).y,
        });
        let owner = self.players.first().map_or(0, |p| p.id);
        let (stone, removed) = self.tombstones.place(owner, at(2.0), 0, now);
        for gone in removed {
            self.events
                .push(GameEvent::TombstoneDespawn { tick, id: gone });
        }
        self.events.push(GameEvent::TombstoneSpawn {
            tick,
            id: stone.id,
            owner,
            x: stone.pos.x,
            y: stone.pos.y,
            skin_id: stone.skin_id,
        });
        let weapon = crate::items::registry::WEAPON_MINE;
        if let Some(d) = crate::weapons::defs::def(weapon) {
            if let crate::weapons::defs::Delivery::Placed {
                arm_time,
                trigger_radius,
                lifetime,
            } = d.delivery
            {
                let id =
                    self.mines
                        .place(owner, d, at(3.0), arm_time, trigger_radius, lifetime, now);
                self.events.push(GameEvent::MinePlaced {
                    tick,
                    id,
                    owner,
                    weapon,
                    x: at(3.0).x,
                    y: at(3.0).y,
                });
            }
        }
        Some(at(0.0))
    }

    /// Take everything inside the horizon — items, crates, graves, mines,
    /// projectiles — each announced by its own despawn and a `Swallowed`. Called by
    /// `step_black_hole` (`Playing` only, after the horizon's kill).
    pub(super) fn swallow_at_horizon(&mut self, hole: Vec2) {
        let tick = self.tick;
        let mut out = Vec::new();
        let gone = |what, at: Vec2| GameEvent::Swallowed {
            tick,
            x: at.x,
            y: at.y,
            what,
        };
        for it in self.items.take_where(|it| in_horizon(hole, it.pos)) {
            out.push(GameEvent::ItemDespawn {
                tick,
                world_item_id: it.id,
            });
            let what = if it.is_crate() {
                SwallowKind::Crate
            } else {
                SwallowKind::Item
            };
            out.push(gone(what, it.pos));
        }
        for g in self.tombstones.take_where(|g| in_horizon(hole, g.pos)) {
            out.push(GameEvent::TombstoneDespawn { tick, id: g.id });
            out.push(gone(SwallowKind::Grave, g.pos));
        }
        for m in self.mines.take_where(|m| in_horizon(hole, m.pos())) {
            // Not detonated: it is gone, not set off (`MineEnd::Destroyed`, the
            // silent removal a blast already uses).
            out.push(GameEvent::MineEnded {
                tick,
                id: m.id,
                reason: MineEnd::Destroyed,
            });
            out.push(gone(SwallowKind::Mine, m.pos()));
        }
        let shots: Vec<_> = self
            .projectiles
            .iter()
            .filter(|p| in_horizon(hole, p.pos))
            .map(|p| (p.id, p.pos))
            .collect();
        for (id, at) in shots {
            self.projectiles.remove(id);
            out.push(GameEvent::ProjectileDespawn {
                tick,
                id,
                reason: DespawnReason::Void,
            });
            out.push(gone(SwallowKind::Projectile, at));
        }
        self.events.extend(out);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::constants::{
        MapScale, BLACK_HOLE_HORIZON_R, BLACK_HOLE_REACH, CRATE_INTERVAL, DEFAULT_MAP_GENERATOR,
        ITEM_SPAWN_INTERVAL, SIM_DT, TOMBSTONE_H, TOMBSTONE_W,
    };
    use crate::items::registry::{FLASHLIGHT, WEAPON_GRENADE, WEAPON_MINE};
    use crate::player::state::DeathCause;
    use crate::weapons::defs::{def, Delivery};
    use crate::world::RoundPhase;

    /// A space world with the hole open at the rock nearest the centre, and ana parked
    /// on the far side of the arena (clear of the reach, so she neither dies nor picks
    /// anything up).
    fn hole_world(seed: u64) -> (World, Vec2) {
        let mut w = World::with_gravity(
            seed,
            MapScale::Small,
            0,
            DEFAULT_MAP_GENERATOR,
            GravityMode::Space,
        );
        w.set_round_seconds(600.0);
        w.set_phase(RoundPhase::Playing);
        w.add_player(0, 0, "ana".into());
        let geo = w.map.space_geometry().expect("space");
        let hole = w
            .summon_black_hole_near(Vec2::new(geo.cx, geo.cy), w.round_time)
            .expect("summoned");
        let far = far_from(&w, hole);
        w.player_mut(0).expect("ana").body = Body::new(far);
        w.drain_events();
        (w, hole)
    }

    /// The point on the arena's long axis farthest from `hole`.
    fn far_from(w: &World, hole: Vec2) -> Vec2 {
        let geo = w.map.space_geometry().expect("space");
        [
            Vec2::new(geo.cx - geo.rx * 0.8, geo.cy),
            Vec2::new(geo.cx + geo.rx * 0.8, geo.cy),
        ]
        .into_iter()
        .max_by(|a, b| (*a - hole).len().total_cmp(&(*b - hole).len()))
        .expect("two")
    }

    /// A clear bearing, so a pull test is about the pull, not the rock in the way.
    fn clear_bearing(w: &World, hole: Vec2, d: f32) -> Vec2 {
        w.clear_bearing_from(hole, d).expect("a clear bearing")
    }

    /// One of each loose thing at `at`: an item, a crate, a grave, a mine, a grenade
    /// at rest. Returns their ids (the grenade's only when `with_shot`).
    fn put_everything(w: &mut World, at: Vec2, with_shot: bool, owner: u8) -> [Option<u32>; 5] {
        let now = w.round_time;
        let item = w
            .items
            .spawn(FLASHLIGHT, 1, at, Vec2::ZERO, SpawnSource::Periodic, now);
        let krate = w
            .items
            .spawn(FLASHLIGHT, 1, at, Vec2::ZERO, SpawnSource::Crate, now);
        let (grave, _) = w.tombstones.place(owner, at, 0, now);
        let mine = def(WEAPON_MINE).and_then(|d| match d.delivery {
            Delivery::Placed {
                arm_time,
                trigger_radius,
                lifetime,
            } => Some(
                w.mines
                    .place(0, d, at, arm_time, trigger_radius, lifetime, now),
            ),
            _ => None,
        });
        let shot = with_shot.then(|| {
            w.projectiles
                .spawn_raw(WEAPON_GRENADE, 0, at, Vec2::ZERO, now)
        });
        [Some(item), Some(krate), Some(grave.id as u32), mine, shot]
    }

    /// Which of `ids` (in `put_everything`'s order) are still in the world.
    fn present(w: &World, ids: &[Option<u32>; 5]) -> [bool; 5] {
        let [item, krate, grave, mine, shot] = *ids;
        [
            item.is_some_and(|i| w.items.get(i).is_some()),
            krate.is_some_and(|i| w.items.get(i).is_some()),
            grave.is_some_and(|i| w.tombstones.all().iter().any(|g| g.id as u32 == i)),
            mine.is_some_and(|i| w.mines.iter().any(|m| m.id == i)),
            shot.is_some_and(|i| w.projectiles.get(i).is_some()),
        ]
    }

    fn swallowed(events: &[GameEvent]) -> Vec<SwallowKind> {
        events
            .iter()
            .filter_map(|e| match e {
                GameEvent::Swallowed { what, .. } => Some(*what),
                _ => None,
            })
            .collect()
    }

    /// **Inside the horizon, everything goes on the tick** — item, crate, grave, mine,
    /// projectile — each with its own despawn and a `Swallowed` (counted at both
    /// ends: five things in, five despawns, five swallows). Control: the same five far
    /// outside the reach are all still there.
    #[test]
    fn everything_inside_the_horizon_is_swallowed_on_the_tick() {
        for seed in [3u64, 11, 4242] {
            let (mut w, hole) = hole_world(seed);
            let inside = put_everything(
                &mut w,
                hole + Vec2::new(BLACK_HOLE_HORIZON_R * 0.5, 0.0),
                true,
                8,
            );
            let far = far_from(&w, hole) + Vec2::new(0.0, BLACK_HOLE_HORIZON_R);
            let outside = put_everything(&mut w, far, true, 9);
            assert!(
                inside.iter().all(Option::is_some),
                "seed {seed}: placed all five"
            );
            w.step(SIM_DT);
            let events = w.drain_events();
            assert_eq!(
                present(&w, &inside),
                [false; 5],
                "seed {seed}: left inside the horizon"
            );
            assert_eq!(
                present(&w, &outside),
                [true; 5],
                "seed {seed}: control swallowed"
            );
            let mut kinds = swallowed(&events);
            kinds.sort_by_key(|k| k.as_str());
            let mut want = vec![
                SwallowKind::Item,
                SwallowKind::Crate,
                SwallowKind::Grave,
                SwallowKind::Mine,
                SwallowKind::Projectile,
            ];
            want.sort_by_key(|k| k.as_str());
            assert_eq!(kinds, want, "seed {seed}");
            let despawns = events
                .iter()
                .filter(|e| match e {
                    GameEvent::ItemDespawn { world_item_id, .. } => {
                        [inside[0], inside[1]].contains(&Some(*world_item_id))
                    }
                    GameEvent::TombstoneDespawn { id, .. } => inside[2] == Some(*id as u32),
                    GameEvent::MineEnded { id, reason, .. } => {
                        inside[3] == Some(*id) && *reason == MineEnd::Destroyed
                    }
                    GameEvent::ProjectileDespawn { id, .. } => inside[4] == Some(*id),
                    _ => false,
                })
                .count();
            assert_eq!(
                despawns,
                want.len(),
                "seed {seed}: a despawn for each swallow"
            );
        }
    }

    /// **Inside the reach a loose thing drifts in and is swallowed, within the bound
    /// the pull itself sets**: from `d`, under at least the pull at `d` (it only grows
    /// inward) and at most `SPACE_MAX_SPEED`, the run in to the horizon takes no more
    /// than `√(2D/a) + D/v_max`, `D = d − R`. Its moves go out on the way (an
    /// `ItemMove` / `TombstoneMove` / `MineMove` before it goes). Control: the same
    /// four just outside the reach never move.
    #[test]
    fn a_loose_thing_in_the_reach_is_pulled_in_within_the_bound() {
        for seed in [3u64, 11, 4242] {
            let (mut w, hole) = hole_world(seed);
            let d = (BLACK_HOLE_HORIZON_R + BLACK_HOLE_REACH) / 2.0;
            let dir = clear_bearing(&w, hole, BLACK_HOLE_REACH + CRATE_W);
            let at = hole + dir * d;
            let pulled = put_everything(&mut w, at, false, 8);
            let beyond = hole + dir * (BLACK_HOLE_REACH + CRATE_W);
            let kept = put_everything(&mut w, beyond, false, 9);
            let a = Attractor::black_hole(hole).pull_at(at).len();
            let run = d - BLACK_HOLE_HORIZON_R;
            let bound = (2.0 * run / a).sqrt() + run / SPACE_MAX_SPEED;
            let ticks = (bound / SIM_DT).ceil() as usize + 1;
            let mut events = Vec::new();
            for _ in 0..ticks {
                w.step(SIM_DT);
                events.extend(w.drain_events());
            }
            assert_eq!(
                present(&w, &pulled)[..4],
                [false; 4],
                "seed {seed}: not swallowed within {bound:.2} s"
            );
            assert_eq!(
                present(&w, &kept)[..4],
                [true; 4],
                "seed {seed}: control gone"
            );
            assert_eq!(
                w.items.get(kept[0].expect("item")).expect("kept").pos,
                beyond
            );
            let moved = |id: u32, kind: usize| {
                events.iter().any(|e| match (kind, e) {
                    (0, GameEvent::ItemMove { world_item_id, .. }) => *world_item_id == id,
                    (2, GameEvent::TombstoneMove { id: g, .. }) => *g as u32 == id,
                    (3, GameEvent::MineMove { id: m, .. }) => *m == id,
                    _ => false,
                })
            };
            for (kind, name) in [(0, "item"), (2, "grave"), (3, "mine")] {
                assert!(
                    moved(pulled[kind].expect("placed"), kind),
                    "seed {seed}: the {name}'s drift never went out"
                );
            }
            // T23.42 found it (`black-hole.mjs`, a mine drawn inside the horizon on a Small map): no move tells a
            // client a thing is **inside** the horizon — on the tick it crosses, it is swallowed, and a move sent
            // first is drawn there until the despawn lands. The control is the drift above: moves did go out.
            let inside: Vec<_> = events
                .iter()
                .filter_map(|e| match e {
                    GameEvent::ItemMove { x, y, .. }
                    | GameEvent::TombstoneMove { x, y, .. }
                    | GameEvent::MineMove { x, y, .. } => Some(Vec2::new(*x, *y)),
                    _ => None,
                })
                .filter(|p| in_horizon(hole, *p))
                .collect();
            assert!(
                inside.is_empty(),
                "seed {seed}: {} move(s) put a loose thing inside the horizon: {inside:?}",
                inside.len()
            );
        }
    }

    /// **A death in the hole leaves no grave** (the owner's report: graves drawn on
    /// it). Control: a death clear of it does leave one.
    #[test]
    fn a_death_in_the_hole_leaves_no_grave() {
        let graves = |in_hole: bool| {
            let (mut w, hole) = hole_world(3);
            let at = if in_hole {
                hole + Vec2::new(BLACK_HOLE_HORIZON_R * 0.5, 0.0)
            } else {
                far_from(&w, hole)
            };
            let p = w.player_mut(0).expect("ana");
            p.body = Body::new(at);
            if !in_hole {
                p.health = 0.0;
            }
            w.step(SIM_DT);
            let events = w.drain_events();
            let died: Vec<_> = events
                .iter()
                .filter_map(|e| match e {
                    GameEvent::Death { cause, .. } => Some(*cause),
                    _ => None,
                })
                .collect();
            assert_eq!(died.len(), 1, "in_hole {in_hole}: nobody died");
            assert_eq!(died[0] == DeathCause::BlackHole, in_hole);
            w.tombstones.len()
        };
        assert_eq!(
            graves(false),
            1,
            "control: a death clear of the hole left no grave"
        );
        assert_eq!(graves(true), 0, "a grave in the hole");
    }

    /// **Nothing spawns inside the reach** — the world's own spawn step, many item
    /// beats and crate beats, every `ItemSpawn` / `CrateSpawn` outside it. Control: the
    /// same beats with no hole put some inside that disc (an empty disc passes "none
    /// inside" vacuously).
    #[test]
    fn nothing_spawns_inside_the_reach() {
        let inside = |with_hole: bool| {
            let (mut w, hole) = hole_world(11);
            if !with_hole {
                w.black_hole = black_hole::BlackHole::Unrolled;
            }
            let beats = (CRATE_INTERVAL / ITEM_SPAWN_INTERVAL).ceil() as u32 * 24;
            let (mut spawns, mut within) = (0, 0);
            for i in 1..=beats {
                // Room for every beat: the cap and the crate limit would stop the draws.
                w.items = crate::items::world::WorldItems::new();
                w.step_item_spawns(w.round_time + ITEM_SPAWN_INTERVAL * i as f32);
                for e in w.drain_events() {
                    let at = match e {
                        GameEvent::ItemSpawn { x, y, .. } | GameEvent::CrateSpawn { x, y, .. } => {
                            Vec2::new(x, y)
                        }
                        _ => continue,
                    };
                    spawns += 1;
                    if (at - hole).len() < BLACK_HOLE_REACH {
                        within += 1;
                    }
                }
            }
            assert!(spawns > 0, "with_hole {with_hole}: nothing spawned at all");
            within
        };
        assert!(
            inside(false) > 0,
            "control: no spawn landed in the disc without a hole"
        );
        assert_eq!(inside(true), 0, "a spawn inside the reach");
    }

    /// Graves use the motion rule under standard gravity too: one placed in the sky
    /// falls, and the last move heard is where it rests. Once at rest it says nothing
    /// more (the absence, with the fall's moves as its presence).
    #[test]
    fn a_falling_grave_says_where_it_lands() {
        let mut w = World::with_gravity(
            7,
            MapScale::Small,
            0,
            DEFAULT_MAP_GENERATOR,
            GravityMode::Standard,
        );
        w.set_phase(RoundPhase::Playing);
        let start = Vec2::new(w.map.mask.w as f32 / 2.0, TOMBSTONE_H);
        let (g, _) = w.tombstones.place(9, start, 0, 0.0);
        let moves = |w: &mut World, secs: u32| {
            let mut heard = Vec::new();
            for _ in 0..(crate::constants::SIM_HZ * secs) {
                w.step(SIM_DT);
                for e in w.drain_events() {
                    if let GameEvent::TombstoneMove { id, x, y, .. } = e {
                        if id == g.id {
                            heard.push(Vec2::new(x, y));
                        }
                    }
                }
            }
            heard
        };
        let fall = moves(&mut w, 10);
        let rest = w
            .tombstones
            .all()
            .iter()
            .find(|t| t.id == g.id)
            .expect("grave")
            .pos;
        assert!(rest.y > start.y + TOMBSTONE_W, "it never fell: {rest:?}");
        assert_eq!(
            fall.last(),
            Some(&rest),
            "the last move heard is not where it rests"
        );
        assert!(moves(&mut w, 2).is_empty(), "a grave at rest kept talking");
    }
}
