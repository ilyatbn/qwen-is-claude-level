//! Bots, so one player is still a deathmatch (`docs/70-amendments-v2.md` §A5).
//!
//! A bot is not a special entity. It produces an `Input` and nothing else, so it
//! goes through the same `apply_input`, the same weapons and the same damage
//! path a human does. There is no branch anywhere in the sim asking "is this a
//! bot", which means a bug that affects bots affects players — and, more useful
//! during development, a bug that affects players shows up while bots are the
//! only thing playing.

use rand::Rng;
use rand_chacha::ChaCha8Rng;

use crate::constants::{
    FOV_DAY, INVENTORY_SLOTS, JETPACK_MAX_FUEL, PICKUP_RADIUS, PLAYER_H, STEP_UP,
};
use crate::items::registry::{def, ItemId, ItemKind};
use crate::math::{Vec2, TAU};
use crate::player::input::{button, Input};
use crate::player::state::PlayerId;
use crate::rng::substream;
use crate::world::World;

/// How far above the bot a target must be before it reaches for the jetpack.
const JETPACK_RISE: f32 = 120.0;
/// Solid samples along the firing line that still count as a clear shot.
const MAX_BLOCKED_SAMPLES: u32 = 12;
/// Spacing of those samples, in px.
const LOS_STEP: f32 = 8.0;
/// Below this, a bot reaches for a medkit.
const HEAL_BELOW: f32 = 40.0;
/// An enemy this close justifies burning a shield.
const SHIELD_WITHIN: f32 = 200.0;
/// A bot that has not moved this far in `STUCK_WINDOW` jumps.
const STUCK_PX: f32 = 6.0;
const STUCK_WINDOW: f32 = 0.5;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Goal {
    Enemy(PlayerId),
    Item(u32),
    Wander,
}

pub struct Bot {
    pub player: PlayerId,
    rng: ChaCha8Rng,
    /// Where the bot *believes* its target is: the truth, lagged, so a low-skill
    /// bot leads badly rather than tracking perfectly and then adding noise.
    believed: Option<Vec2>,
    reaction: f32,
    aim_error: f32,
    goal: Goal,
    wander_to: Option<Vec2>,
    /// For stuck detection.
    last_x: f32,
    still_for: f32,
    want_use: Option<u8>,
}

impl Bot {
    pub fn new(player: PlayerId, seed: u64, index: u32, skill: f32) -> Self {
        let skill = skill.clamp(0.0, 1.0);
        Bot {
            player,
            // Its own sub-stream. A shared one would make two bots in the same
            // situation act identically, which reads as a formation rather than
            // as opponents.
            rng: substream(seed, &format!("bot{index}")),
            believed: None,
            reaction: (1.0 - skill) * 0.4,
            aim_error: (1.0 - skill) * 0.35,
            goal: Goal::Wander,
            wander_to: None,
            last_x: 0.0,
            still_for: 0.0,
            want_use: None,
        }
    }

    /// Item use is a command rather than an input, so it is reported separately
    /// and the room applies it (`docs/30` §4).
    pub fn wants_use(&self) -> Option<u8> {
        self.want_use
    }

    /// This tick's input. Reads the world, never mutates it.
    pub fn think(&mut self, world: &World, now: f32, dt: f32) -> Input {
        let Some(me) = world.player(self.player) else {
            return Input::default();
        };
        if !me.alive {
            self.believed = None;
            self.want_use = None;
            return Input::default();
        }
        let pos = me.body.pos;

        self.choose_goal(world, pos);
        let target = self.target_pos(world, pos);

        // Belief lags the truth by the reaction time, so a weak bot shoots where
        // you were. Modelling the delay is what makes low skill read as slow
        // rather than as randomly inaccurate.
        let lag = if self.reaction <= 0.0 {
            1.0
        } else {
            (dt / self.reaction).clamp(0.0, 1.0)
        };
        self.believed = Some(match (self.believed, target) {
            (Some(b), Some(t)) => Vec2::new(b.x + (t.x - b.x) * lag, b.y + (t.y - b.y) * lag),
            (None, Some(t)) => t,
            (Some(b), None) => b,
            (None, None) => pos,
        });
        let aim_at = self.believed.unwrap_or(pos);

        let mut buttons = 0u8;

        // --- move -------------------------------------------------------
        let dx = aim_at.x - pos.x;
        let want_close = matches!(self.goal, Goal::Item(_));
        let stop_within = if want_close {
            PICKUP_RADIUS * 0.5
        } else {
            40.0
        };
        if dx.abs() > stop_within {
            buttons |= if dx > 0.0 {
                button::RIGHT
            } else {
                button::LEFT
            };
        }

        // Stuck against a wall: pressing a direction and going nowhere.
        if (pos.x - self.last_x).abs() < STUCK_PX && buttons & (button::LEFT | button::RIGHT) != 0 {
            self.still_for += dt;
        } else {
            self.still_for = 0.0;
        }
        self.last_x = pos.x;

        let rise = pos.y - aim_at.y; // positive when the target is above
        let wants_jump =
            self.still_for > STUCK_WINDOW || (rise > STEP_UP as f32 && me.body.grounded);
        if wants_jump {
            buttons |= button::JUMP;
            self.still_for = 0.0;
        }

        // Jetpack for a real climb, and only with fuel to spare — a bot that
        // empties its tank hovering is a bot that cannot escape.
        if rise > JETPACK_RISE && me.jetpack.fuel > JETPACK_MAX_FUEL * 0.5 {
            buttons |= button::JUMP | button::UP;
        } else if rise < -JETPACK_RISE * 2.0 && !me.body.grounded {
            buttons |= button::DOWN;
        }

        // --- aim --------------------------------------------------------
        let err = (self.rng.gen::<f32>() - 0.5) * 2.0 * self.aim_error;
        let angle = (aim_at.y - pos.y).atan2(aim_at.x - pos.x) + err;
        let aim = ((angle.rem_euclid(TAU) / TAU) * 65536.0) as u16;

        // --- fire -------------------------------------------------------
        if let Goal::Enemy(_) = self.goal {
            if self.should_fire(world, me, pos, aim_at, now) {
                buttons |= button::FIRE;
            }
        }

        // --- items ------------------------------------------------------
        self.want_use = self.choose_item(world, me, pos);

        Input {
            seq: 0, // the room owns sequencing; a bot has no packets to order
            buttons,
            aim,
        }
    }

    fn choose_goal(&mut self, world: &World, pos: Vec2) {
        let mut best: Option<(f32, Goal)> = None;

        for p in &world.players {
            if p.id == self.player || !p.alive {
                continue;
            }
            let d = (p.body.pos - pos).len();
            if d <= FOV_DAY && best.is_none_or(|(bd, _)| d < bd) {
                best = Some((d, Goal::Enemy(p.id)));
            }
        }

        // Unarmed, or nothing in sight: go shopping.
        let armed = self.selected_weapon(world).is_some();
        if best.is_none() || !armed {
            let mut item_best: Option<(f32, Goal)> = None;
            for it in world.items.iter() {
                let d = (it.pos - pos).len();
                if item_best.is_none_or(|(bd, _)| d < bd) {
                    item_best = Some((d, Goal::Item(it.id)));
                }
            }
            if let Some(found) = item_best {
                // A visible enemy still wins if we are armed.
                if !armed || best.is_none() {
                    best = Some(found);
                }
            }
        }

        self.goal = match best {
            Some((_, g)) => g,
            None => Goal::Wander,
        };

        if self.goal == Goal::Wander {
            let need_new = self.wander_to.is_none_or(|w| (w - pos).len() < 64.0);
            if need_new {
                let spawns = &world.map.meta.spawn_points;
                if !spawns.is_empty() {
                    let i = self.rng.gen_range(0..spawns.len());
                    let s = spawns[i];
                    self.wander_to = Some(Vec2::new(s.x as f32, s.y as f32 - PLAYER_H / 2.0));
                }
            }
        } else {
            self.wander_to = None;
        }
    }

    fn target_pos(&self, world: &World, pos: Vec2) -> Option<Vec2> {
        match self.goal {
            Goal::Enemy(id) => world.player(id).filter(|p| p.alive).map(|p| p.body.pos),
            Goal::Item(id) => world.items.iter().find(|i| i.id == id).map(|i| i.pos),
            Goal::Wander => self.wander_to.or(Some(pos)),
        }
    }

    fn selected_weapon(&self, world: &World) -> Option<ItemId> {
        let me = world.player(self.player)?;
        let stack = me.inventory.slot(me.inventory.selected())?;
        match def(stack.item)?.kind {
            ItemKind::Weapon(_) => Some(stack.item),
            _ => None,
        }
    }

    fn should_fire(
        &self,
        world: &World,
        me: &crate::player::state::PlayerState,
        pos: Vec2,
        target: Vec2,
        now: f32,
    ) -> bool {
        if now < me.fire_ready_at {
            return false;
        }
        let Some(item) = self.selected_weapon(world) else {
            return false;
        };
        let Some(d) = def(item) else { return false };
        let ItemKind::Weapon(wid) = d.kind else {
            return false;
        };
        let Some(w) = crate::weapons::defs::def(wid) else {
            return false;
        };

        let dist = (target - pos).len();
        // Never fire at something inside our own blast radius: a bot that
        // rockets its own feet is not a difficulty setting, it is a bug that
        // looks like one.
        if w.blast_radius > 0.0 && dist < w.blast_radius * 1.5 {
            return false;
        }
        if w.range > 0.0 && dist > w.range {
            return false;
        }

        // Line of sight: a few solid samples are a hill to shoot over, many are
        // a wall to walk around.
        let steps = (dist / LOS_STEP).ceil() as u32;
        let mut blocked = 0u32;
        for i in 1..steps {
            let t = i as f32 / steps as f32;
            let p = pos + (target - pos) * t;
            if crate::physics::collide::solid_at(&world.map, p.x as i32, p.y as i32) {
                blocked += 1;
                if blocked > MAX_BLOCKED_SAMPLES {
                    return false;
                }
            }
        }
        true
    }

    fn choose_item(
        &self,
        world: &World,
        me: &crate::player::state::PlayerState,
        pos: Vec2,
    ) -> Option<u8> {
        let hurt = me.health < HEAL_BELOW;
        let threatened = world
            .players
            .iter()
            .any(|p| p.id != self.player && p.alive && (p.body.pos - pos).len() < SHIELD_WITHIN);

        for slot in 0..INVENTORY_SLOTS as u8 {
            let Some(stack) = me.inventory.slot(slot) else {
                continue;
            };
            let Some(d) = def(stack.item) else { continue };
            match d.kind {
                ItemKind::Heal { .. } if hurt => return Some(slot),
                _ => {}
            }
        }
        if threatened && me.shield_until.is_none_or(|t| t <= world.round_time) {
            for slot in 0..INVENTORY_SLOTS as u8 {
                let Some(stack) = me.inventory.slot(slot) else {
                    continue;
                };
                let Some(d) = def(stack.item) else { continue };
                if matches!(d.kind, ItemKind::Shield { .. }) {
                    return Some(slot);
                }
            }
        }
        None
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::constants::{MapScale, SIM_DT};
    use crate::items::registry::{BAZOOKA, MEDKIT};
    use crate::world::{give, RoundPhase, World};

    const SEED: u64 = 4242;

    /// A point with 260 px of clear air to its right.
    ///
    /// Placing two players at arbitrary coordinates and asserting the bot shoots
    /// is a test of the terrain, not of the bot: the line of sight runs through
    /// whatever the generator put there. Same trap as carving into empty sky.
    fn clear_line(w: &World) -> Vec2 {
        for y in (200..(w.map.mask.h as i32 - 200)).step_by(16) {
            'x: for x in (100..(w.map.mask.w as i32 - 400)).step_by(16) {
                for s in (0..=260).step_by(4) {
                    if crate::physics::collide::solid_at(&w.map, x + s, y) {
                        continue 'x;
                    }
                }
                return Vec2::new(x as f32, y as f32);
            }
        }
        panic!("no clear 260 px span on this map; the fixture is wrong, not the bot");
    }

    fn world_with(ids: &[PlayerId]) -> World {
        let mut w = World::new(SEED, MapScale::Small);
        w.set_phase(RoundPhase::Playing);
        for id in ids {
            w.add_player(*id, 0, format!("p{id}"));
        }
        let _ = w.drain_events();
        w
    }

    /// A bot's inputs must be reproducible, or a replay does not reproduce the
    /// round and every determinism guarantee downstream is void.
    #[test]
    fn the_same_seed_and_world_give_byte_identical_inputs() {
        let run = || {
            let mut w = world_with(&[1, 2]);
            let mut b = Bot::new(1, SEED, 0, 0.6);
            let mut out = Vec::new();
            for t in 0..600 {
                let inp = b.think(&w, t as f32 * SIM_DT, SIM_DT);
                out.push((inp.buttons, inp.aim));
                w.queue_input(1, inp);
                w.step(SIM_DT);
            }
            out
        };
        assert_eq!(run(), run());
    }

    /// Different indices must diverge, or a row of bots moves as one body.
    #[test]
    fn two_bots_with_different_indices_do_not_act_identically() {
        let w = world_with(&[1, 2]);
        let mut a = Bot::new(1, SEED, 0, 0.6);
        let mut b = Bot::new(1, SEED, 1, 0.6);
        let mut same = 0;
        let mut total = 0;
        for t in 0..300 {
            let now = t as f32 * SIM_DT;
            let ia = a.think(&w, now, SIM_DT);
            let ib = b.think(&w, now, SIM_DT);
            if ia.aim == ib.aim {
                same += 1;
            }
            total += 1;
        }
        assert!(
            same < total,
            "both bots produced identical aim on every one of {total} ticks"
        );
    }

    #[test]
    fn a_bot_with_no_target_and_no_items_still_produces_valid_input() {
        let w = world_with(&[1]);
        let mut b = Bot::new(1, SEED, 0, 0.6);
        for t in 0..120 {
            let inp = b.think(&w, t as f32 * SIM_DT, SIM_DT);
            // Never both directions at once — that is a bot fighting itself.
            assert!(
                inp.buttons & button::LEFT == 0 || inp.buttons & button::RIGHT == 0,
                "pressed left and right together"
            );
        }
    }

    #[test]
    fn a_bot_walks_toward_a_target_on_its_right() {
        let mut w = world_with(&[1, 2]);
        // Armed, or it correctly goes shopping instead of hunting — which is
        // what the first version of this test actually measured.
        give(&mut w, 1, BAZOOKA, 4);
        let at = clear_line(&w);
        if let Some(p) = w.player_mut(1) {
            p.body.pos = at;
        }
        if let Some(p) = w.player_mut(2) {
            p.body.pos = Vec2::new(at.x + 200.0, at.y);
        }
        let mut b = Bot::new(1, SEED, 0, 1.0); // perfect skill: no reaction lag
        let inp = b.think(&w, 0.0, SIM_DT);
        assert!(
            inp.buttons & button::RIGHT != 0,
            "did not press right toward a target 200 px to the right"
        );
        assert!(inp.buttons & button::LEFT == 0);
    }

    /// A bot that rockets its own feet is a bug that looks like a difficulty
    /// setting.
    #[test]
    fn a_bot_does_not_fire_at_a_target_inside_its_own_blast_radius() {
        let mut w = world_with(&[1, 2]);
        give(&mut w, 1, BAZOOKA, 4);
        let at = clear_line(&w);
        if let Some(p) = w.player_mut(1) {
            p.body.pos = at;
        }
        if let Some(p) = w.player_mut(2) {
            p.body.pos = Vec2::new(at.x + 10.0, at.y); // point blank
        }
        let mut b = Bot::new(1, SEED, 0, 1.0);
        let inp = b.think(&w, 100.0, SIM_DT);
        assert!(
            inp.buttons & button::FIRE == 0,
            "fired a bazooka at a target 10 px away"
        );

        // The control: at a sane range with a clear line it *does* fire, so the
        // assertion above is not satisfied by a bot that never shoots at all.
        if let Some(p) = w.player_mut(2) {
            p.body.pos = Vec2::new(at.x + 200.0, at.y);
        }
        let mut fired = false;
        let mut b2 = Bot::new(1, SEED, 0, 1.0);
        for t in 0..30 {
            let inp = b2.think(&w, 100.0 + t as f32 * SIM_DT, SIM_DT);
            if inp.buttons & button::FIRE != 0 {
                fired = true;
                break;
            }
        }
        assert!(fired, "never fired even at 200 px with a clear line");
    }

    #[test]
    fn a_hurt_bot_reaches_for_a_medkit() {
        let mut w = world_with(&[1]);
        give(&mut w, 1, MEDKIT, 1);
        if let Some(p) = w.player_mut(1) {
            p.health = 20.0;
        }
        let mut b = Bot::new(1, SEED, 0, 0.6);
        b.think(&w, 0.0, SIM_DT);
        assert!(
            b.wants_use().is_some(),
            "did not reach for the medkit at 20 health"
        );

        // Control: at full health it leaves the medkit alone.
        if let Some(p) = w.player_mut(1) {
            p.health = 100.0;
        }
        b.think(&w, 0.0, SIM_DT);
        assert_eq!(b.wants_use(), None, "used a medkit at full health");
    }

    #[test]
    fn a_dead_bot_does_nothing() {
        let mut w = world_with(&[1]);
        if let Some(p) = w.player_mut(1) {
            p.alive = false;
        }
        let mut b = Bot::new(1, SEED, 0, 0.6);
        let inp = b.think(&w, 0.0, SIM_DT);
        assert_eq!(inp.buttons, 0);
        assert_eq!(b.wants_use(), None);
    }
}
