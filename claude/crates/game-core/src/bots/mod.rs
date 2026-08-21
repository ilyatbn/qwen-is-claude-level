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
    BATTERY_MAX, FOV_DAY, INVENTORY_SLOTS, JETPACK_MAX_FUEL, PICKUP_RADIUS, PLAYER_H, STEP_UP,
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
///
/// Generous on purpose: every weapon in this game digs (`docs/70-amendments-v2.md`
/// §A3), so rock between you and your target is soft cover, not a wall. Shooting
/// through a hill is a legitimate play and the terrain opens as you do it.
const MAX_BLOCKED_SAMPLES: u32 = 24;

/// Spacing of those samples, in px.
const LOS_STEP: f32 = 8.0;
/// Below this, a bot reaches for a medkit.
const HEAL_BELOW: f32 = 40.0;
/// Top up below this fraction of a full battery — enough that a laser is
/// usable and a shield is worth raising.
const CHARGE_BELOW: f32 = 0.4;
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

/// Why a bot did not pull the trigger this tick.
///
/// Counting these is the only way to tell "the bots are bad shots" from "the
/// bots never get a shot at all" — four indistinguishable symptoms with four
/// different fixes (`tasks/M9/T9.09-bot-lethality.md`).
#[derive(Debug, Default, Clone, Copy, PartialEq, Eq)]
pub struct BotStats {
    /// `think` calls while alive.
    pub ticks: u32,
    /// ...of those, with a living enemy chosen as the goal.
    pub ticks_engaged: u32,
    /// ...of those, holding a weapon.
    pub ticks_armed: u32,
    /// Trigger pulls actually issued.
    pub fires: u32,
    pub rej_cooldown: u32,
    pub rej_unarmed: u32,
    /// Target inside our own blast radius.
    pub rej_blast_guard: u32,
    pub rej_range: u32,
    pub rej_los: u32,
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
    want_select: Option<u8>,
    stats: BotStats,
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
            want_select: None,
            stats: BotStats::default(),
        }
    }

    /// Where the kill chain broke. Read by the lethality harness; free otherwise.
    pub fn stats(&self) -> BotStats {
        self.stats
    }

    /// Item use is a command rather than an input, so it is reported separately
    /// and the room applies it (`docs/30` §4).
    pub fn wants_use(&self) -> Option<u8> {
        self.want_use
    }

    /// The slot the bot wants selected, when that is not the one it holds.
    ///
    /// Selection is a command for exactly the same reason firing is: a human's
    /// client sends `select_slot` (`docs/30` §4), and nothing in `Input` carries
    /// it. Before this the only thing that ever changed a bot's selection was the
    /// inventory auto-advancing when a stack ran out — so a bot could neither
    /// switch **to** a better weapon nor **away** from an uncharged energy one,
    /// which is why the lasers shipped with every spawn weight at zero.
    pub fn wants_select(&self) -> Option<u8> {
        self.want_select
    }

    /// This tick's input. Reads the world, never mutates it.
    pub fn think(&mut self, world: &World, now: f32, dt: f32) -> Input {
        let Some(me) = world.player(self.player) else {
            return Input::default();
        };
        if !me.alive {
            self.believed = None;
            self.want_use = None;
            self.want_select = None;
            return Input::default();
        }
        let pos = me.body.pos;
        self.stats.ticks += 1;

        self.choose_goal(world, pos);
        if matches!(self.goal, Goal::Enemy(_)) {
            self.stats.ticks_engaged += 1;
        }
        if self.selected_weapon(world).is_some() {
            self.stats.ticks_armed += 1;
        }
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
            // Hold at a range the weapon can actually be fired at. Closing to a
            // flat 40 px walked bazooka-armed bots inside their own blast guard
            // (blast_radius * 1.5 = 63 px), where the rule that stops them
            // suiciding also stopped them shooting — measured as the single
            // largest rejection reason, 8469 against 91 shots taken.
            self.stand_off(world)
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
                self.stats.fires += 1;
            }
        }

        // --- items ------------------------------------------------------
        self.want_use = self.choose_item(world, me, pos);
        self.want_select = self.choose_weapon(me, aim_at, pos);

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
                // NOTE: this branch is very nearly dead. `choose_goal` only
                // falls through to Wander when the map holds no items at all,
                // and items respawn every ITEM_SPAWN_INTERVAL up to
                // MAX_WORLD_ITEMS — so in a real round a bot is always either
                // engaging or shopping. Measured: replacing the random spawn
                // point below with "walk toward the nearest living player"
                // changed the round statistics by exactly nothing, in every
                // counter, on every seed.
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

    /// How close to close. Never inside the blast guard, or the bot arrives at a
    /// range where it has forbidden itself to fire.
    fn stand_off(&self, world: &World) -> f32 {
        let blast = self
            .selected_weapon(world)
            .and_then(def)
            .and_then(|d| match d.kind {
                ItemKind::Weapon(wid) => crate::weapons::defs::def(wid),
                _ => None,
            })
            .map_or(0.0, |w| w.blast_radius);
        (blast * 2.0).max(40.0)
    }

    /// The selected weapon, **if it can actually be fired**.
    ///
    /// "Armed" has to mean "able to shoot", not "holding something
    /// weapon-shaped". Since §B5 an energy weapon with a flat battery is a
    /// paperweight, and a bot that counts it as a weapon stops shopping, walks at
    /// an enemy and never pulls the trigger — which is precisely what happened
    /// when the lasers landed: `ticks_armed 5003, ticks_engaged 0, fires 0`.
    fn selected_weapon(&self, world: &World) -> Option<ItemId> {
        let me = world.player(self.player)?;
        let stack = me.inventory.slot(me.inventory.selected())?;
        match def(stack.item)?.kind {
            ItemKind::Weapon(wid) => {
                let cost = crate::weapons::defs::def(wid).map_or(0.0, |w| w.energy_cost);
                (cost <= 0.0 || me.battery >= cost).then_some(stack.item)
            }
            _ => None,
        }
    }

    fn should_fire(
        &mut self,
        world: &World,
        me: &crate::player::state::PlayerState,
        pos: Vec2,
        target: Vec2,
        now: f32,
    ) -> bool {
        if now < me.fire_ready_at {
            self.stats.rej_cooldown += 1;
            return false;
        }
        let Some(item) = self.selected_weapon(world) else {
            self.stats.rej_unarmed += 1;
            return false;
        };
        let Some(d) = def(item) else {
            self.stats.rej_unarmed += 1;
            return false;
        };
        let ItemKind::Weapon(wid) = d.kind else {
            self.stats.rej_unarmed += 1;
            return false;
        };
        let Some(w) = crate::weapons::defs::def(wid) else {
            self.stats.rej_unarmed += 1;
            return false;
        };

        let dist = (target - pos).len();
        // Never fire at something inside our own blast radius: a bot that
        // rockets its own feet is not a difficulty setting, it is a bug that
        // looks like one.
        if w.blast_radius > 0.0 && dist < w.blast_radius * 1.5 {
            self.stats.rej_blast_guard += 1;
            return false;
        }
        if w.range > 0.0 && dist > w.range {
            self.stats.rej_range += 1;
            return false;
        }

        // Line of sight. A weapon that carves 42 px treats a hill as cover to
        // remove rather than a wall to walk around, so the tolerance is
        // generous — but it stays a *count*, not a distance test: a
        // near-the-muzzle guard was measured and refused 87 % of the shots the
        // count allows, because a bot standing on the ground has rock within
        // 28 px of its muzzle almost always.
        let steps = (dist / LOS_STEP).ceil() as u32;
        let mut blocked = 0u32;
        for i in 1..steps {
            let t = i as f32 / steps as f32;
            let p = pos + (target - pos) * t;
            if crate::physics::collide::solid_at(&world.map, p.x as i32, p.y as i32) {
                blocked += 1;
                if blocked > MAX_BLOCKED_SAMPLES {
                    self.stats.rej_los += 1;
                    return false;
                }
            }
        }
        true
    }

    /// Pick the best **firable** weapon slot, or `None` to keep the current one.
    ///
    /// "Firable" is the same rule `selected_weapon` uses, so an energy weapon with
    /// a flat battery scores nothing and the bot moves off it — which is the half
    /// that was missing. A weapon out of range still scores, just lower: walking
    /// closer with a bazooka beats standing still with nothing.
    fn choose_weapon(
        &self,
        me: &crate::player::state::PlayerState,
        target: Vec2,
        pos: Vec2,
    ) -> Option<u8> {
        let dist = (target - pos).len();
        let mut best: Option<(f32, u8)> = None;
        for slot in 0..INVENTORY_SLOTS as u8 {
            let Some(stack) = me.inventory.slot(slot) else {
                continue;
            };
            let Some(d) = def(stack.item) else { continue };
            let ItemKind::Weapon(wid) = d.kind else {
                continue;
            };
            let Some(w) = crate::weapons::defs::def(wid) else {
                continue;
            };
            // Can it be fired *right now*? Energy needs charge; everything else
            // needs a stack, which the inventory guarantees by holding it.
            if w.energy_cost > 0.0 && me.battery < w.energy_cost {
                continue;
            }
            // Damage per second is the axis that matters; a weapon that cannot
            // reach the target, or whose blast would catch us, is heavily
            // penalised but not disqualified — it is still better than nothing.
            let dps = w.damage / w.cooldown.max(0.01);
            let mut score = dps;
            if w.range > 0.0 && dist > w.range {
                score *= 0.25;
            }
            if w.blast_radius > 0.0 && dist < w.blast_radius * 1.5 {
                score *= 0.1;
            }
            if best.is_none_or(|(bs, _)| score > bs) {
                best = Some((score, slot));
            }
        }
        // Only ask for a change: `select_slot` on the slot already held is a
        // no-op, but reporting it every tick makes the intent unreadable.
        best.and_then(|(_, slot)| (slot != me.inventory.selected()).then_some(slot))
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
        // Charge when low (§B5). Without this a bot picks up a battery pack, never
        // uses it, and any energy weapon it is holding stays a paperweight —
        // while both occupy slots a working weapon would fill. That is not
        // hypothetical: adding the battery and the lasers with no rule here took
        // bot rounds from fighting to `ticks_engaged: 0`, because a bot holding an
        // uncharged laser is permanently unarmed and permanently shopping.
        if me.battery <= BATTERY_MAX * CHARGE_BELOW {
            for slot in 0..INVENTORY_SLOTS as u8 {
                let Some(stack) = me.inventory.slot(slot) else {
                    continue;
                };
                let Some(d) = def(stack.item) else { continue };
                if matches!(d.kind, ItemKind::Battery { .. }) {
                    return Some(slot);
                }
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

    /// The positive control for the blast-guard test below.
    ///
    /// "A bot does not fire at X" passes against a bot that never fires at
    /// anything — and for the whole life of this project that is exactly what
    /// shipped, because nothing consumed the FIRE bit. An absence needs a
    /// presence beside it.
    #[test]
    fn a_bot_fires_at_an_armed_clear_shot_at_a_sane_range() {
        let mut w = world_with(&[1, 2]);
        give(&mut w, 1, BAZOOKA, 4);
        let at = clear_line(&w);
        if let Some(p) = w.player_mut(1) {
            p.body.pos = at;
        }
        if let Some(p) = w.player_mut(2) {
            p.body.pos = Vec2::new(at.x + 200.0, at.y);
        }
        let mut b = Bot::new(1, SEED, 0, 1.0);
        let mut fired = false;
        for t in 0..30 {
            let inp = b.think(&w, t as f32 * SIM_DT, SIM_DT);
            if inp.buttons & button::FIRE != 0 {
                fired = true;
                break;
            }
        }
        assert!(
            fired,
            "armed, clear line, 200 px away, and never pulled the trigger: {:?}",
            b.stats()
        );
    }

    /// A round in which the bots damage each other at all.
    ///
    /// The unit tests above only prove the bot *asks* to fire. Whether a shot
    /// leaves the barrel depends on the driver turning that request into
    /// `World::fire`, which is a different layer — and the layer where it was
    /// broken.
    #[test]
    fn bots_actually_hurt_each_other_over_a_round() {
        let r = harness::run_round(99, 4, 0.85, 150.0);
        assert!(
            r.damage_dealt > 0.0,
            "four bots, 150 s, and nobody took a scratch: {:?}",
            r.stats
        );
        assert!(
            r.stats.fires > 0,
            "no trigger was pulled at all: {:?}",
            r.stats
        );
    }

    /// A bot that has closed to a range its own blast guard forbids will stand
    /// there forever. Measured as the largest single rejection reason.
    #[test]
    fn a_bot_holds_at_a_range_it_can_actually_shoot_from() {
        let mut w = world_with(&[1, 2]);
        give(&mut w, 1, BAZOOKA, 4);
        let b = Bot::new(1, SEED, 0, 0.6);
        let stand = b.stand_off(&w);
        let blast = crate::weapons::defs::def(match def(BAZOOKA).map(|d| d.kind) {
            Some(ItemKind::Weapon(wid)) => wid,
            _ => panic!("the bazooka stopped being a weapon"),
        })
        .map_or(0.0, |w| w.blast_radius);
        assert!(
            stand > blast * 1.5,
            "stands at {stand} px inside a {} px blast guard",
            blast * 1.5
        );
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

/// The lethality harness: a real headless round, driven exactly as the room
/// drives one, reporting where the kill chain breaks.
///
/// Not a test of the bots' *code* — a test of whether a round they play is a
/// deathmatch (`docs/70-amendments-v2.md` §A5). It is `#[cfg(test)]` rather than
/// a binary because it needs nothing a test does not already have.
#[cfg(test)]
pub(crate) mod harness {
    use super::*;
    use crate::constants::{MapScale, SIM_DT};
    use crate::player::state::DeathCause;
    use crate::world::{GameEvent, RoundPhase, World};

    #[derive(Debug, Default, Clone, Copy)]
    pub struct RoundResult {
        pub combat_deaths: u32,
        pub self_deaths: u32,
        pub weather_deaths: u32,
        pub damage_dealt: f32,
        pub pickups: u32,
        pub stats: BotStats,
    }

    /// Sum the per-bot counters, so the report is about the population rather
    /// than about whichever bot happened to be looked at.
    fn fold(a: BotStats, b: BotStats) -> BotStats {
        BotStats {
            ticks: a.ticks + b.ticks,
            ticks_engaged: a.ticks_engaged + b.ticks_engaged,
            ticks_armed: a.ticks_armed + b.ticks_armed,
            fires: a.fires + b.fires,
            rej_cooldown: a.rej_cooldown + b.rej_cooldown,
            rej_unarmed: a.rej_unarmed + b.rej_unarmed,
            rej_blast_guard: a.rej_blast_guard + b.rej_blast_guard,
            rej_range: a.rej_range + b.rej_range,
            rej_los: a.rej_los + b.rej_los,
        }
    }

    pub fn run_round(seed: u64, n_bots: usize, skill: f32, seconds: f32) -> RoundResult {
        let mut w = World::new(seed, MapScale::Small);
        w.set_phase(RoundPhase::Playing);
        let mut bots = Vec::new();
        for i in 0..n_bots {
            let id = i as PlayerId;
            w.add_player(id, 0, format!("Bot {i}"));
            bots.push(Bot::new(id, seed, i as u32, skill));
        }
        let _ = w.drain_events();

        let mut r = RoundResult::default();
        let ticks = (seconds / SIM_DT) as u32;
        for t in 0..ticks {
            let now = t as f32 * SIM_DT;
            for b in bots.iter_mut() {
                let inp = b.think(&w, now, SIM_DT);
                w.queue_input(b.player, inp);
                // Firing is a *command*, not a button the sim reads: a human's
                // client sends `fire` alongside its input (`docs/30` §4). A bot
                // has no client, so whatever drives it has to do the same — and
                // a harness that skips this measures a game nobody plays.
                if inp.buttons & crate::player::input::button::FIRE != 0 {
                    let _ = w.fire(b.player, now);
                }
                if let Some(slot) = b.wants_use() {
                    let _ = w.use_item(b.player, slot, now);
                }
            }
            w.step(SIM_DT);
            for e in w.drain_events() {
                match e {
                    GameEvent::Death { cause, .. } => match cause {
                        DeathCause::Player(_) => r.combat_deaths += 1,
                        DeathCause::SelfInflicted => r.self_deaths += 1,
                        DeathCause::Weather => r.weather_deaths += 1,
                    },
                    GameEvent::Damage {
                        amount, attacker, ..
                    } => {
                        if attacker.is_some() {
                            r.damage_dealt += amount;
                        }
                    }
                    GameEvent::ItemPickup { .. } => r.pickups += 1,
                    _ => {}
                }
            }
        }
        r.stats = bots
            .iter()
            .map(|b| b.stats())
            .fold(BotStats::default(), fold);
        r
    }

    /// Print the kill chain for a spread of seeds. `--ignored --nocapture`.
    pub fn report(label: &str, skill: f32, seeds: &[u64]) -> Vec<RoundResult> {
        let out: Vec<_> = seeds
            .iter()
            .map(|s| run_round(*s, 4, skill, 150.0))
            .collect();
        let n = out.len() as f32;
        let s = out.iter().map(|r| r.stats).fold(BotStats::default(), fold);
        let mut deaths: Vec<u32> = out.iter().map(|r| r.combat_deaths).collect();
        deaths.sort_unstable();
        println!(
            "\n== {label} (skill {skill}, {} rounds of 150 s, 4 bots) ==",
            out.len()
        );
        println!(
            "  combat deaths   per round: {deaths:?}  median {}",
            deaths[deaths.len() / 2]
        );
        println!(
            "  damage dealt    per round: {:.0}",
            out.iter().map(|r| r.damage_dealt).sum::<f32>() / n
        );
        println!(
            "  pickups         per round: {:.1}",
            out.iter().map(|r| r.pickups).sum::<u32>() as f32 / n
        );
        println!("  ticks                    : {}", s.ticks);
        println!(
            "    engaged (enemy goal)   : {} ({:.1}%)",
            s.ticks_engaged,
            100.0 * s.ticks_engaged as f32 / s.ticks.max(1) as f32
        );
        println!(
            "    armed                  : {} ({:.1}%)",
            s.ticks_armed,
            100.0 * s.ticks_armed as f32 / s.ticks.max(1) as f32
        );
        println!("  fires                    : {}", s.fires);
        println!(
            "  rejections: cooldown {} unarmed {} blast-guard {} range {} los {}",
            s.rej_cooldown, s.rej_unarmed, s.rej_blast_guard, s.rej_range, s.rej_los
        );
        out
    }
}

#[cfg(test)]
mod lethality {
    use super::harness;

    const SEEDS: [u64; 10] = [1, 4242, 12345, 777, 99, 5, 31337, 8123, 64, 202];

    /// The round-level acceptance test.
    ///
    /// **The floor is damage, not deaths, and that is a finding rather than a
    /// convenience.** Measured over 10 seeds at every skill level, 8 of 10
    /// rounds contain *zero* combat deaths — not because the bots cannot shoot
    /// (they now deal 82-143 damage a round) but because four players with a
    /// 320 px sight radius on a 2048x1024 map mostly never meet: engagement is
    /// 4 % of ticks. Asserting "median deaths >= 1" would fail on a correct
    /// build, and asserting "median >= 0" would pass on the broken one that
    /// fired 16,861 times for nothing.
    ///
    /// Damage separates those two worlds cleanly and deaths do not, so damage
    /// is what the gate asserts. The encounter rate is a density problem and it
    /// is written up rather than tuned away.
    #[test]
    fn a_round_of_bots_is_a_fight() {
        let seeds = [1u64, 4242, 12345, 777, 99];
        let rounds: Vec<_> = seeds
            .iter()
            .map(|s| harness::run_round(*s, 4, 0.6, 150.0))
            .collect();
        let total: f32 = rounds.iter().map(|r| r.damage_dealt).sum();
        let mean = total / rounds.len() as f32;
        // One player's worth of health per round, across four bots. Below this
        // they are not fighting; the broken build scored exactly 0.
        assert!(
            mean >= 50.0,
            "four bots dealt {mean:.0} damage a round on average, which is not a fight"
        );
        // There is deliberately **no** assertion on kills.
        //
        // The paragraph above measured it: ~8 of 10 rounds contain zero combat
        // deaths on a correct build. `any(kill)` across five seeds therefore
        // fails about a third of the time by arithmetic — it only ever passed
        // because these five happened to include a lucky one, and adding a
        // single item to the registry reshuffled the seeded spawn stream and
        // took the luck away. Damage stayed well above the floor throughout,
        // so bot lethality never changed; only the coin landed differently.
        //
        // A gate that fails on a coin flip gates nothing (§A28), and one whose
        // own doc comment explains why it cannot be trusted is worse. The
        // damage floor above is the sound version of the same intent.
    }

    /// The measurement, not an assertion. `--ignored --nocapture`.
    #[test]
    #[ignore = "measurement; run with --ignored --nocapture"]
    fn kill_chain() {
        harness::report("default skill", 0.6, &SEEDS);
        harness::report("high skill", 0.85, &SEEDS);
        harness::report("skill 0", 0.0, &SEEDS);
        harness::report("skill 1", 1.0, &SEEDS);
    }
}
