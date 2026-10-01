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
    BOT_ENGAGE_RANGE, BOT_NAV_CELL, BOT_STUCK_PX, BOT_STUCK_WINDOW, JETPACK_MIN_FUEL_TO_ENGAGE,
};
use crate::items::registry::SHOVEL;
use crate::math::Vec2;
use crate::player::state::PlayerId;
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
    }

    /// One line of the human-vs-bot table.
    pub fn row(&self) -> String {
        format!(
            "{:>6.0} {:>5.0}% {:>5.0}% {:>5.0}% {:>7.0} {:>6.1} {:>5.2} {:>4.1} {:>5.1} {:>5.1} \
             {:>6.0} {:>6} | {:>5.0}% {:>7.0} {:>5.0}%",
            self.alive_s,
            100.0 * self.air_share(),
            100.0 * self.jet_share(),
            100.0 * self.still_share(),
            self.per_min(self.dist_px),
            self.per_min(self.burns as f32),
            self.mean_burn_fuel(),
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
        "alive_s   air   jet still  px/min burn/m fuel@ tp/m dig/m shot/m fightd deaths | \
         shower: air  px/min still"
    }
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
                        m: Movement::default(),
                    });
                    self.tracks.len() - 1
                }
            };
            let t = &mut self.tracks[i];
            let pos = p.body.pos;
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
                let held = p.inventory.selected_stack().map(|s| s.item);
                if held == Some(SHOVEL) {
                    t.m.shovel_swings += 1;
                } else {
                    t.m.shots += 1;
                    let near = world
                        .players
                        .iter()
                        .filter(|o| o.id != p.id && o.alive)
                        .map(|o| (o.body.pos - pos).len())
                        .fold(f32::INFINITY, f32::min);
                    if near <= BOT_ENGAGE_RANGE {
                        t.m.fight_dist_sum += near;
                        t.m.fight_shots += 1;
                    }
                }
            }
            t.ready_at = p.fire_ready_at;
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
}
