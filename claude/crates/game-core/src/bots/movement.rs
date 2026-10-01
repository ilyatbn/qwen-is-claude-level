//! T23.26C item 5 — **how a body moves**, measured the same way for a human and a bot.
//!
//! The owner's verdict on the routed bots was *"they should run around and fly more"*,
//! and the only way to say "more" is against a measured human. This observer reads
//! nothing but the world's own player state each tick — position, ground contact, the
//! jetpack, the trigger's cooldown — so the replay of a recorded round
//! (`replay --player-stats`) and a bots-only round in `tests/balance.rs` report the same
//! columns from the same code. Nothing here steers; it is a report.
//!
//! **State, not events**, on purpose: the room drains the world's events to broadcast
//! them, so a replay sees state only — and a measure built on events would have needed a
//! second copy for it.

use crate::constants::{
    BOT_ENGAGE_RANGE, BOT_LOS_STEP, BOT_NAV_CELL, BOT_STUCK_PX, BOT_STUCK_WINDOW,
    JETPACK_MIN_FUEL_TO_ENGAGE, JUMP_VELOCITY, PLAYER_H, PLAYER_W, SHOVEL_COOLDOWN,
};
use crate::items::registry::SHOVEL;
use crate::math::Vec2;
use crate::physics::collide::solid_at;
use crate::player::state::{PlayerId, ASSIST_WINDOW};
use crate::weapons::explode::EffectKind;
use crate::world::World;

/// A one-tick move longer than this is not a move: a teleport, a vortex trip or a
/// respawn. Eight cells in a tick is ~7700 px/s at 60 Hz — no movement in the game
/// comes near it.
const JUMP_PX: f32 = 8.0 * BOT_NAV_CELL;

/// One player's totals.
#[derive(Debug, Default, Clone, Copy, PartialEq)]
pub struct Movement {
    pub alive_s: f32,
    /// Alive and not touching the ground (riding a platform counts as ground).
    pub air_s: f32,
    /// The jetpack thrusting.
    pub jet_s: f32,
    /// Path length, teleports and respawns excluded.
    pub dist_px: f32,
    /// Whole `BOT_STUCK_WINDOW`s alive in which the body moved under `BOT_STUCK_PX`.
    pub still_s: f32,
    /// Jet burns started, and the tank summed at each start — the mean says whether a
    /// player waits for a refill or flies on what is left.
    pub burns: u32,
    pub burn_fuel_sum: f32,
    /// Ticks alive with the tank under what starting the pack needs: flown dry.
    pub dry_s: f32,
    pub teleports: u32,
    /// Trigger pulls that went off (the cooldown restarted), by what was in hand.
    pub shovel_swings: u32,
    pub shots: u32,
    /// The nearest living enemy's distance at each shot, summed, and the shots that had
    /// one within `BOT_ENGAGE_RANGE`.
    pub fight_dist_sum: f32,
    pub fight_shots: u32,
    pub deaths: u32,
    /// The same, only while a meteor shower is falling.
    pub shower_alive_s: f32,
    pub shower_air_s: f32,
    pub shower_dist_px: f32,
    pub shower_still_s: f32,
    /// T23.26E — **fighting**, which nothing measured while every movement number went
    /// up. Seconds with a living enemy inside the held weapon's band (`arms::band`) and
    /// a clear line to it, or a shot fired with one in sight range.
    pub engaged_s: f32,
    /// Health taken off other players with this player named as the damager
    /// (`last_damaged_by` at that tick), and deaths credited to it within `ASSIST_WINDOW`.
    pub damage: f32,
    pub kills: u32,
    /// Take-offs at jump speed: ground one tick, in the air the next, rising faster than
    /// half `JUMP_VELOCITY`, the pack off. A jump press that left the ground.
    pub jumps: u32,
    /// Shovel swings with no enemy within the swing's reach: digs, not blows.
    pub dig_swings: u32,
    /// Seconds enclosed by rock — [`enclosed`].
    pub in_rock_s: f32,
}

impl Movement {
    pub fn per_min(&self, v: f32) -> f32 {
        v * 60.0 / self.alive_s.max(1e-6)
    }
    pub fn air_share(&self) -> f32 {
        self.air_s / self.alive_s.max(1e-6)
    }
    pub fn still_share(&self) -> f32 {
        self.still_s / self.alive_s.max(1e-6)
    }
    pub fn jet_share(&self) -> f32 {
        self.jet_s / self.alive_s.max(1e-6)
    }
    pub fn mean_burn_fuel(&self) -> f32 {
        self.burn_fuel_sum / (self.burns.max(1)) as f32
    }
    pub fn mean_fight_dist(&self) -> f32 {
        self.fight_dist_sum / (self.fight_shots.max(1)) as f32
    }

    /// Add another's totals (a population).
    pub fn add(&mut self, o: &Movement) {
        self.alive_s += o.alive_s;
        self.air_s += o.air_s;
        self.jet_s += o.jet_s;
        self.dist_px += o.dist_px;
        self.still_s += o.still_s;
        self.burns += o.burns;
        self.burn_fuel_sum += o.burn_fuel_sum;
        self.dry_s += o.dry_s;
        self.teleports += o.teleports;
        self.shovel_swings += o.shovel_swings;
        self.shots += o.shots;
        self.fight_dist_sum += o.fight_dist_sum;
        self.fight_shots += o.fight_shots;
        self.deaths += o.deaths;
        self.shower_alive_s += o.shower_alive_s;
        self.shower_air_s += o.shower_air_s;
        self.shower_dist_px += o.shower_dist_px;
        self.shower_still_s += o.shower_still_s;
        self.engaged_s += o.engaged_s;
        self.damage += o.damage;
        self.kills += o.kills;
        self.jumps += o.jumps;
        self.dig_swings += o.dig_swings;
        self.in_rock_s += o.in_rock_s;
    }

    /// T23.26E: share of time digging — each dig swing is one `SHOVEL_COOLDOWN` spent.
    pub fn dig_share(&self) -> f32 {
        self.dig_swings as f32 * SHOVEL_COOLDOWN / self.alive_s.max(1e-6)
    }

    /// T23.26E: one line of the fighting table — engaged share, shots, damage and kills a
    /// minute, jumps a minute, airborne, digging and in-rock shares, pad uses a minute,
    /// still share.
    pub fn fight_row(&self) -> String {
        format!(
            "{:>6.0} {:>5.0}% {:>6.1} {:>6.1} {:>5.2} {:>6.1} {:>5.0}% {:>5.1}% {:>5.1}% {:>5.2} {:>5.0}%",
            self.alive_s,
            100.0 * self.engaged_s / self.alive_s.max(1e-6),
            self.per_min(self.shots as f32),
            self.per_min(self.damage),
            self.per_min(self.kills as f32),
            self.per_min(self.jumps as f32),
            100.0 * self.air_share(),
            100.0 * self.dig_share(),
            100.0 * self.in_rock_s / self.alive_s.max(1e-6),
            self.per_min(self.teleports as f32),
            100.0 * self.still_share(),
        )
    }

    /// The header [`fight_row`](Self::fight_row) lines up under.
    pub fn fight_header() -> &'static str {
        "alive_s engaged shot/m  dmg/m kill/m jump/m   air   dig inrock  tp/m still"
    }

    /// One line of the human-vs-bot table.
    pub fn row(&self) -> String {
        format!(
            "{:>6.0} {:>5.0}% {:>5.0}% {:>5.0}% {:>7.0} {:>6.1} {:>5.2} {:>4.1}% {:>4.1} {:>5.1} \
             {:>5.1} {:>6.0} {:>6} | {:>5.0}% {:>7.0} {:>5.0}%",
            self.alive_s,
            100.0 * self.air_share(),
            100.0 * self.jet_share(),
            100.0 * self.still_share(),
            self.per_min(self.dist_px),
            self.per_min(self.burns as f32),
            self.mean_burn_fuel(),
            100.0 * self.dry_s / self.alive_s.max(1e-6),
            self.per_min(self.teleports as f32),
            self.per_min(self.shovel_swings as f32),
            self.per_min(self.shots as f32),
            self.mean_fight_dist(),
            self.deaths,
            100.0 * self.shower_air_s / self.shower_alive_s.max(1e-6),
            self.shower_dist_px * 60.0 / self.shower_alive_s.max(1e-6),
            100.0 * self.shower_still_s / self.shower_alive_s.max(1e-6),
        )
    }

    /// The header [`row`](Self::row) lines up under.
    pub fn header() -> &'static str {
        "alive_s   air   jet still  px/min burn/m fuel@   dry tp/m dig/m shot/m fightd deaths \
         | shower: air  px/min still"
    }
}

/// T23.26E: **a body enclosed by rock** — of five points half a cell out from its box
/// (left, up-left, up, up-right, right), at least three are rock. A tunnel (the three
/// above), a shaft (both sides and their tops) or a pocket count; open ground (none), a
/// wall beside you (two) or a ledge overhead alone (one to three only when walled) mostly
/// do not.
pub fn enclosed(world: &World, pos: Vec2) -> bool {
    let (dx, dy) = (
        PLAYER_W * 0.5 + BOT_NAV_CELL * 0.5,
        PLAYER_H * 0.5 + BOT_NAV_CELL * 0.5,
    );
    let pts = [(-dx, 0.0), (-dx, -dy), (0.0, -dy), (dx, -dy), (dx, 0.0)];
    pts.iter()
        .filter(|(x, y)| solid_at(&world.map, (pos.x + x) as i32, (pos.y + y) as i32))
        .count()
        >= 3
}

/// T23.26E: no rock on the straight line between two points, walked at `BOT_LOS_STEP`.
fn sight(world: &World, from: Vec2, to: Vec2) -> bool {
    let steps = ((to - from).len() / BOT_LOS_STEP).ceil() as u32;
    (1..steps).all(|i| {
        let p = from + (to - from) * (i as f32 / steps as f32);
        !solid_at(&world.map, p.x as i32, p.y as i32)
    })
}

#[derive(Debug, Clone, Copy)]
struct Track {
    id: PlayerId,
    was_alive: bool,
    last: Vec2,
    jet: bool,
    ready_at: f32,
    window_s: f32,
    window_from: Vec2,
    window_shower_s: f32,
    grounded: bool,
    health: f32,
    m: Movement,
}

/// Every player's [`Movement`], fed one world per tick.
#[derive(Debug, Default, Clone)]
pub struct Watcher {
    tracks: Vec<Track>,
}

impl Watcher {
    /// Read the world after a step of `dt`.
    pub fn observe(&mut self, world: &World, dt: f32) {
        let shower = world.effects.active().iter().any(|e| {
            e.kind == EffectKind::MeteorShower
                && e.phase == crate::effects::scheduler::EffectPhase::Active
        });
        // T23.26E: who hurt whom this tick — a victim's health drop goes to the player its
        // `last_damaged_by` names now, and a death to the one it names within the assist
        // window. Read before the tracks move on, credited after.
        let now = world.round_time;
        let mut credit: Vec<(PlayerId, f32, u32)> = Vec::new();
        for p in &world.players {
            let Some(t) = self.tracks.iter().find(|t| t.id == p.id) else {
                continue;
            };
            let Some((k, when)) = p.last_damaged_by.filter(|(k, _)| *k != p.id) else {
                continue;
            };
            if !t.was_alive {
                continue;
            }
            let drop = t.health - p.health.max(0.0);
            if drop > 0.0 && now - when <= 3.0 * dt {
                credit.push((k, drop, 0));
            }
            if !p.alive && now - when <= ASSIST_WINDOW {
                credit.push((k, 0.0, 1));
            }
        }
        for p in &world.players {
            let i = match self.tracks.iter().position(|t| t.id == p.id) {
                Some(i) => i,
                None => {
                    self.tracks.push(Track {
                        id: p.id,
                        was_alive: false,
                        last: p.body.pos,
                        jet: false,
                        ready_at: p.fire_ready_at,
                        window_s: 0.0,
                        window_from: p.body.pos,
                        window_shower_s: 0.0,
                        grounded: p.body.grounded,
                        health: p.health,
                        m: Movement::default(),
                    });
                    self.tracks.len() - 1
                }
            };
            let t = &mut self.tracks[i];
            let pos = p.body.pos;
            t.health = p.health;
            if !p.alive {
                if t.was_alive {
                    t.m.deaths += 1;
                }
                t.was_alive = false;
                t.window_s = 0.0;
                t.window_shower_s = 0.0;
                t.jet = false;
                t.last = pos;
                t.ready_at = p.fire_ready_at;
                continue;
            }
            if !t.was_alive {
                // A new life: nothing to measure a move from yet.
                t.was_alive = true;
                t.grounded = p.body.grounded;
                t.last = pos;
                t.window_from = pos;
                t.window_s = 0.0;
                t.ready_at = p.fire_ready_at;
            }
            let step = (pos - t.last).len();
            let jumped = step > JUMP_PX;
            if jumped {
                t.m.teleports += 1;
                t.window_from = pos;
                t.window_s = 0.0;
                t.window_shower_s = 0.0;
            } else {
                t.m.dist_px += step;
                if shower {
                    t.m.shower_dist_px += step;
                }
            }
            t.last = pos;
            t.m.alive_s += dt;
            let airborne = !p.body.grounded && p.mount.mounted.is_none();
            if airborne {
                t.m.air_s += dt;
            }
            if shower {
                t.m.shower_alive_s += dt;
                if airborne {
                    t.m.shower_air_s += dt;
                }
                t.window_shower_s += dt;
            }
            if p.jetpack.active {
                t.m.jet_s += dt;
                if !t.jet {
                    t.m.burns += 1;
                    t.m.burn_fuel_sum += p.jetpack.fuel;
                }
            }
            t.jet = p.jetpack.active;
            if p.jetpack.fuel < JETPACK_MIN_FUEL_TO_ENGAGE {
                t.m.dry_s += dt;
            }
            // T23.26E: a take-off at jump speed, and the rock around the body.
            if t.grounded
                && !p.body.grounded
                && !p.jetpack.active
                && p.body.vel.y < -0.5 * JUMP_VELOCITY
            {
                t.m.jumps += 1;
            }
            t.grounded = p.body.grounded;
            if enclosed(world, pos) {
                t.m.in_rock_s += dt;
            }
            let held = p.inventory.selected_stack().map(|s| s.item);
            let band = held.and_then(super::arms::band);
            let enemies = || {
                world
                    .players
                    .iter()
                    .filter(move |o| o.id != p.id && o.alive)
            };
            let mut engaged = band.is_some_and(|b| {
                enemies().any(|o| (o.body.pos - pos).len() <= b && sight(world, pos, o.body.pos))
            });
            t.window_s += dt;
            if t.window_s >= BOT_STUCK_WINDOW - dt * 0.5 {
                if (pos - t.window_from).len() < BOT_STUCK_PX {
                    t.m.still_s += t.window_s;
                    t.m.shower_still_s += t.window_shower_s;
                }
                t.window_s = 0.0;
                t.window_shower_s = 0.0;
                t.window_from = pos;
            }
            // A use went off: the trigger's cooldown restarted.
            if p.fire_ready_at > t.ready_at {
                let near = enemies()
                    .map(|o| (o.body.pos - pos).len())
                    .fold(f32::INFINITY, f32::min);
                if held == Some(SHOVEL) {
                    t.m.shovel_swings += 1;
                    if band.is_none_or(|b| near > b) {
                        t.m.dig_swings += 1;
                    }
                } else {
                    t.m.shots += 1;
                    if near <= BOT_ENGAGE_RANGE {
                        t.m.fight_dist_sum += near;
                        t.m.fight_shots += 1;
                        engaged = true;
                    }
                }
            }
            if engaged {
                t.m.engaged_s += dt;
            }
            t.ready_at = p.fire_ready_at;
        }
        for (k, dmg, kill) in credit {
            if let Some(t) = self.tracks.iter_mut().find(|t| t.id == k) {
                t.m.damage += dmg;
                t.m.kills += kill;
            }
        }
    }

    /// One player's totals so far.
    pub fn of(&self, id: PlayerId) -> Movement {
        self.tracks
            .iter()
            .find(|t| t.id == id)
            .map_or_else(Movement::default, |t| t.m)
    }

    /// Every player seen, by id.
    pub fn ids(&self) -> Vec<PlayerId> {
        let mut v: Vec<_> = self.tracks.iter().map(|t| t.id).collect();
        v.sort_unstable();
        v
    }
}

#[cfg(test)]
mod tests {
    use super::super::tests::*;
    use super::*;

    /// The observer measures a move and not a stand: a body walked across a shelf for
    /// two seconds covers over one second's walk and is not still; the same body pinned in place is still for
    /// its whole life and covers nothing. Both arms on one fixture.
    #[test]
    fn the_watcher_counts_a_walk_as_distance_and_a_stand_as_still() {
        let run = |walk: bool| {
            let mut w = world_with(&[1]);
            let at = clear_line(&w);
            let y = flat_shelf(&mut w, at, 240);
            if let Some(p) = w.player_mut(1) {
                p.body.pos = Vec2::new(at.x, y);
            }
            let mut watch = Watcher::default();
            for _ in 0..120 {
                let b = if walk {
                    crate::player::input::button::RIGHT
                } else {
                    0
                };
                w.queue_input(
                    1,
                    crate::player::input::Input {
                        seq: 0,
                        buttons: b,
                        aim: 0,
                    },
                );
                w.step(SIM_DT);
                let _ = w.drain_events();
                watch.observe(&w, SIM_DT);
            }
            watch.of(1)
        };
        let walked = run(true);
        let stood = run(false);
        assert!(
            walked.dist_px > crate::constants::WALK_SPEED && walked.still_share() < 0.2,
            "a walk read as {walked:?}"
        );
        assert!(
            stood.dist_px < BOT_STUCK_PX && stood.still_share() > 0.8,
            "control: a stand read as {stood:?}"
        );
    }

    /// T23.26E: the fighting columns read what happened and nothing else. One body hops
    /// twice on a shelf with an armed enemy in sight and its pistol fired: two jumps,
    /// engaged the whole time, a shot, the enemy's health it took credited to it. The
    /// control stands still in the same place holding only the shovel, the enemy far out
    /// of its band: no jump, not engaged. And a roof carved over the stander makes it enclosed; the open shelf not.
    #[test]
    fn the_watcher_counts_jumps_engagement_damage_and_rock_around_a_body() {
        use crate::items::registry::PISTOL;
        let run = |hop: bool, near: bool, roof: bool| {
            let mut w = world_with(&[1, 2]);
            let at = clear_line(&w);
            let y = flat_shelf(&mut w, at, 240);
            let gap = 120.0;
            if near {
                give(&mut w, 1, PISTOL, 30);
                wield(&mut w, 1, PISTOL);
            }
            if let Some(p) = w.player_mut(1) {
                p.body.pos = Vec2::new(at.x, y);
            }
            if let Some(p) = w.player_mut(2) {
                p.body.pos = Vec2::new(at.x + gap, y);
                p.iframes_until = 0.0;
            }
            if roof {
                // A roof a cell over the head and walls a cell either side: a dug pocket.
                let (x, top) = (at.x as i32, (y - PLAYER_H) as i32);
                for yy in (top - 16)..(top - 4) {
                    w.map.mask.set_run(yy, x - 30, x + 30);
                }
                for yy in (top - 4)..(y as i32 + 14) {
                    w.map.mask.set_run(yy, x - 30, x - 14);
                    w.map.mask.set_run(yy, x + 14, x + 30);
                }
                w.map.coarse = crate::map::coarse::CoarseGrid::build(&w.map.mask);
            }
            let mut watch = Watcher::default();
            let band = super::super::arms::band(PISTOL).unwrap_or(0.0);
            for i in 0..240 {
                let b = if hop && i % 120 == 30 {
                    crate::player::input::button::JUMP
                } else {
                    0
                };
                w.queue_input(
                    1,
                    crate::player::input::Input {
                        seq: 0,
                        buttons: b,
                        aim: 0,
                    },
                );
                if i == 110 && near {
                    let now = w.round_time;
                    let _ = w.fire(1, now);
                }
                w.step(SIM_DT);
                let _ = w.drain_events();
                watch.observe(&w, SIM_DT);
            }
            (watch.of(1), band, gap)
        };
        let (fought, band, gap) = run(true, true, false);
        assert!(
            band > gap,
            "fixture: the pistol's band is {band}, the enemy {gap} off"
        );
        assert_eq!(fought.jumps, 2, "two hops read as {fought:?}");
        assert!(
            fought.shots == 1 && fought.damage > 0.0,
            "a hit read as {fought:?}"
        );
        assert!(
            fought.engaged_s > 0.9 * fought.alive_s,
            "an enemy in the band in sight read as {fought:?}"
        );
        assert_eq!(
            fought.in_rock_s, 0.0,
            "the open shelf read as rock: {fought:?}"
        );
        let (stood, ..) = run(false, false, false);
        assert!(
            stood.jumps == 0 && stood.engaged_s == 0.0 && stood.damage == 0.0,
            "control: a stand out of the band read as {stood:?}"
        );
        let (dug, ..) = run(false, false, true);
        assert!(
            dug.in_rock_s > 0.9 * dug.alive_s,
            "control: a body in a dug pocket read as {dug:?}"
        );
    }
}
