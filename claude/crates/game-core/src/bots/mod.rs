//! Bots, so one player is still a deathmatch (`docs/70-amendments-v2.md` §A5).
//!
//! A bot is not a special entity. It produces an `Input` and nothing else, so it
//! goes through the same `apply_input`, the same weapons and the same damage
//! path a human does. There is no branch anywhere in the sim asking "is this a
//! bot", which means a bug that affects bots affects players — and, more useful
//! during development, a bug that affects players shows up while bots are the
//! only thing playing.
//!
//! Here: the goal (`choose_goal`), belief and aim, and `think`, which calls the rest.
//! `walk.rs` is the walking model (and the winged sweep), `space.rs` the flying one,
//! `arms.rs` what a bot holds and when it fires, `explore.rs` where it has been. Each
//! file's tests are in it; the shared fixtures are `tests`' `pub(super)` items.

use rand::Rng;
use rand_chacha::ChaCha8Rng;

mod arms;
mod explore;
mod space;
mod walk;

use explore::Coverage;

use crate::constants::{
    GravityMode, BATTERY_MAX, BOT_FLEE_HEALTH, BOT_HAZARD_CLEARANCE, BOT_SUIT_SHOP_BELOW,
    BOT_WANDER_ARRIVED, BOT_WANDER_GIVE_UP, FLAME_RADIUS, FOV_DAY, INVENTORY_SLOTS, PICKUP_RADIUS,
};

use crate::items::registry::{def, ItemKind};
use crate::math::{Vec2, TAU};
use crate::player::input::{button, Input};
use crate::player::state::PlayerId;
use crate::rng::substream;
use crate::weapons::explode::DamageSource;
use crate::world::World;

/// A hazard a bot can see, and who lit it.
///
/// The lighter is carried because §B24's denial measure has to count only the
/// hazards an *enemy* laid: a bot fleeing its own molotov has denied ground to
/// nobody, and counting it would make a weapon look strongest exactly when it
/// is hurting its user most — the mistake T11.09's first instrument made.
#[derive(Debug, Clone, Copy)]
struct Hazard {
    pos: Vec2,
    lit_by: Option<PlayerId>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Goal {
    Enemy(PlayerId),
    /// Break contact with this enemy (§E10).
    ///
    /// A separate goal rather than a flag on `Enemy`, because the two disagree
    /// about the *only* thing a goal decides — which way to walk — and a field
    /// that means "chase" or "run" depending on a second field is the shape
    /// `CLAUDE.md` warns about. The bot still aims at them and may still shoot;
    /// it is retreating, not surrendering.
    Flee(PlayerId),
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
    /// Ticks spent walking out of a hazard **somebody else** lit.
    ///
    /// §B24: damage-per-second cannot see denied space, so a zone weapon that
    /// works looks like one that does nothing. These two count the denial
    /// directly — an enemy who is moving because of your fire is the effect the
    /// weapon is for. Only *other* players' hazards count, or a bot fleeing its
    /// own molotov would score as having denied ground to itself.
    pub ticks_hazard_evaded: u32,
    /// Ticks where a step toward the goal was refused because a hazard was ahead.
    pub ticks_hazard_blocked: u32,
    /// Throws refused because the arc lands on us (T11.15), as distinct from
    /// `rej_blast_guard`, which refuses on the target's distance. Separate
    /// counters because they answer different questions.
    pub rej_impact_guard: u32,
    /// T22.03I F4: ticks a **winged** bot counted itself stuck (its sweep held), and
    /// of them the ticks it was in fact moving sideways faster than half
    /// `WINGS_FLY_SPEED` — the review's measure of a stuck test that fires in open
    /// air (74 % of winged stuck ticks at `c3f7861`).
    pub ticks_winged_stuck: u32,
    pub ticks_winged_stuck_moving: u32,
    /// T22.14B M1: ticks a flying bot's destination lay inside a keep-out disc
    /// (`space::forbidden`), and of them the ticks it was **frozen short of it**: still
    /// (under `BOT_SPACE_STUCK_SPEED`), pressing no movement button, and further than a
    /// body past its stop from the nearest point it may fly to (`space::approach`) — the
    /// audit's freeze (an enemy beside a vortex was a destination `steer` refused), and
    /// not a bot holding at a keep-out's edge, which is where it is meant to be.
    pub ticks_dest_forbidden: u32,
    pub ticks_dest_forbidden_idle: u32,
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
    /// Where this bot has been (§E10). Built on the first `think`, because the
    /// map's size is not known until then and a bot outlives no world.
    coverage: Option<Coverage>,
    /// Seconds spent heading for the current wander target.
    ///
    /// A cell whose middle sits inside rock can never be *entered*, so without
    /// this a bot fixates on one it will never reach. Giving up marks it seen —
    /// "seen" means "been there or tried", which is what a coverage grid for
    /// exploring wants it to mean.
    wander_for: f32,
    /// For stuck detection: the `x` it is measured from — for a winged bot, the
    /// current `BOT_STUCK_WINDOW`'s start, `stuck_window` s ago (T22.03I F4); for a
    /// walking bot, the last tick's (see `think`).
    stuck_from: f32,
    stuck_window: f32,
    still_for: f32,
    /// T22.03I F4: a winged bot that swept for `BOT_WINGED_SWEEP_LEGS` legs and stayed
    /// stuck gives the way up until this round time — it stops pressing into the
    /// face and hovers, rather than zig-zagging for the rest of the round.
    sweep_refused_until: f32,
    /// T22.03D: the flying model's blocked-by-rock memory (`space::steer`).
    flight: space::Flight,
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
            coverage: None,
            wander_for: 0.0,
            stuck_from: 0.0,
            stuck_window: 0.0,
            still_for: 0.0,
            sweep_refused_until: 0.0,
            flight: space::Flight::default(),
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

        self.choose_goal(world, pos, dt);
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

        let mut buttons = self.walk_buttons(world, me, pos, aim_at, now, dt);

        // **In space the walking model's buttons are replaced, not amended**
        // (T22.03B, R5): the goal and the point it resolves to are the same, and
        // only how a body nothing damps gets there differs — `space::steer`.
        if space::flies(world, me) {
            buttons = self.space_buttons(world, me, pos, aim_at, dt);
        }

        // --- aim --------------------------------------------------------
        let err = (self.rng.gen::<f32>() - 0.5) * 2.0 * self.aim_error;
        let angle = (aim_at.y - pos.y).atan2(aim_at.x - pos.x) + err;
        let aim = ((angle.rem_euclid(TAU) / TAU) * 65536.0) as u16;

        // --- fire -------------------------------------------------------
        //
        // **§C20 is repealed (§F4), so a bot simply shoots.** It no longer plants
        // itself first: there is nothing to plant for, and the planting was only
        // ever compensation for a gate that refused a moving shooter.
        //
        // What went with it is worth recording, because it was the measured
        // reason the planting existed at all. Over the balance harness's eight
        // seeds at SKILL 0.85 the gate refused **910 of 1063** wanted trigger
        // pulls — 86 % — and the refusal rate tracked airborne time almost
        // exactly, because a bot in the air has no ground friction to slow it
        // under the threshold. Bots are airborne most of the time, so for most of
        // their lives they could not shoot at all.
        if let Goal::Enemy(_) = self.goal {
            if self.should_fire(world, me, pos, aim_at, now) {
                buttons |= button::FIRE;
                self.stats.fires += 1;
            }
        }

        // --- items ------------------------------------------------------
        self.want_use = self.choose_item(me);
        self.want_select = self.choose_weapon(world, me, aim_at, pos);

        Input {
            seq: 0, // the room owns sequencing; a bot has no packets to order
            buttons,
            aim,
        }
    }

    /// T22.03B: the goal as a destination for `space::steer`, and its buttons.
    /// Fleeing is a point a sight radius away from the enemy; an enemy is held at
    /// the stand-off; an item is flown onto; a wander cell is reached when the
    /// bot is within the quarter-cell `choose_goal` counts as arrived.
    fn space_buttons(
        &mut self,
        world: &World,
        me: &crate::player::state::PlayerState,
        pos: Vec2,
        aim_at: Vec2,
        dt: f32,
    ) -> u8 {
        let dest = match self.goal {
            Goal::Flee(_) => {
                let off = pos - aim_at;
                let away = if off.len() > f32::EPSILON {
                    off.normalized()
                } else {
                    Vec2::new(1.0, 0.0)
                };
                // T22.03D: the nearest turn of "away" whose point is not in a
                // keep-out — straight away into a vortex's disc is a destination
                // `steer` refuses, and the bot sat 65 s against its rock.
                let at = space::turns(away)
                    .map(|d| pos + d * FOV_DAY)
                    .find(|&p| !space::forbidden(world, p))
                    .unwrap_or(pos + away * FOV_DAY);
                space::Dest { at, stop: 0.0 }
            }
            // T22.03D: the stand-off is where it can shoot *from*. With rock in
            // the line it closes on the enemy instead — into the rock, which is
            // what `space::steer`'s detour turns off — rather than holding a
            // distance it has already reached and cannot fire across (two bots
            // parked a rock apart for 35 s, `gate-t2203d-*.txt`).
            //
            // And **inside the weapon's range**: `stand_off`'s 40 px floor is
            // outside a shovel's reach (`effective_reach`, 28 px), and a flying bot
            // measures the whole distance where the walking model measures only
            // `dx` — two shovel bots held 32 px apart refusing every swing as out
            // of range (`should_fire`'s `rej_range`).
            Goal::Enemy(_) => space::Dest {
                at: aim_at,
                stop: if self.reachable(world, pos, aim_at) {
                    self.hold_off(world)
                } else {
                    0.0
                },
            },
            Goal::Item(_) => space::Dest {
                at: aim_at,
                stop: PICKUP_RADIUS * 0.5,
            },
            Goal::Wander => space::Dest {
                at: aim_at,
                stop: BOT_WANDER_ARRIVED,
            },
        };
        let fire = self
            .hazard_at(world, pos, BOT_HAZARD_CLEARANCE)
            .map(|h| h.pos);
        let b = space::steer(world, me, Some(dest), fire, &mut self.flight, dt);
        if space::forbidden(world, dest.at) {
            self.stats.ticks_dest_forbidden += 1;
            let moves = button::LEFT | button::RIGHT | button::UP | button::DOWN | button::JUMP;
            let short = (space::approach(world, pos, dest.at) - pos).len()
                > dest.stop + crate::constants::PLAYER_H;
            let still = me.body.vel.len() < crate::constants::BOT_SPACE_STUCK_SPEED;
            self.stats.ticks_dest_forbidden_idle += u32::from(b & moves == 0 && still && short);
        }
        b
    }

    fn choose_goal(&mut self, world: &World, pos: Vec2, dt: f32) {
        let mut best: Option<(f32, Goal)> = None;

        let health = world.player(self.player).map_or(0.0, |p| p.health);
        // §E10: below this a bot breaks contact. Decided here rather than in the
        // movement code so `Goal` stays the single answer to "which way", and so
        // `target_pos` and the aim keep working — a retreating bot still faces
        // the thing it is retreating from.
        let flee = health > 0.0 && health < BOT_FLEE_HEALTH;

        for p in &world.players {
            if p.id == self.player || !p.alive {
                continue;
            }
            let d = (p.body.pos - pos).len();
            if d <= FOV_DAY && best.is_none_or(|(bd, _)| d < bd) {
                best = Some((
                    d,
                    if flee {
                        Goal::Flee(p.id)
                    } else {
                        Goal::Enemy(p.id)
                    },
                ));
            }
        }

        // Unarmed, or nothing in sight: go shopping. **Any** firable slot counts,
        // not just the one in hand — see `has_firable_weapon`.
        let armed = self.has_firable_weapon(world);
        // T22.03B: **a suit running flat is the one errand that beats a fight** — an
        // unsealed suit loses `RADIATION_DPS` for the rest of the round, and the bot
        // that ignored it was radiation's commonest victim (0.54 deaths a bot a round,
        // measured). Only when it carries no battery to use (`choose_item` does that).
        let charge = world.player(self.player).is_some_and(|me| {
            world.gravity.wears_suit()
                && me.battery <= BATTERY_MAX * BOT_SUIT_SHOP_BELOW
                && !(0..INVENTORY_SLOTS as u8).any(|s| {
                    me.inventory
                        .slot(s)
                        .and_then(|st| def(st.item))
                        .is_some_and(|d| matches!(d.kind, ItemKind::Battery { .. }))
                })
        });
        if best.is_none() || !armed || charge {
            let mut item_best: Option<(bool, f32, Goal)> = None;
            for it in world.items.iter() {
                let d = (it.pos - pos).len();
                // §E10, reachability. Two gates, and they are the ones the enemy
                // search already applies to *people*: you cannot want what you
                // cannot see. Without them a bot walked the width of the map
                // toward an item on the far side of a mountain, which is the
                // behaviour exploration is supposed to replace.
                if d > FOV_DAY || !self.reachable(world, pos, it.pos) {
                    continue;
                }
                // T22.12C F2: never shop inside the black hole's reach (or where a
                // telegraphed one will open, T22.14A H2) — the one line
                // of avoidance that needs no flight model. Steering out of the pull
                // is T22.03B's (bots fly in space there, not here).
                if crate::world::black_hole::clearance(world.black_hole_site(), it.pos) < 0.0 {
                    continue;
                }
                // T22.03G: nothing the pickup would refuse (a full counter or stack) —
                // a bot parked on one waited out the round beside it. The pickup's own
                // rule, shared (`items::world::would_take`), not a second copy.
                if !world.player(self.player).is_some_and(|me| {
                    crate::items::world::would_take(it.item, &me.inventory, me.heals, me.batteries)
                }) {
                    continue;
                }
                // A weapon outranks a medkit **when we have no weapon** (§E10).
                // Nearest-of-anything sent an unarmed bot past a bazooka to the
                // battery beyond it; arming yourself is the thing that makes the
                // next ten seconds go differently.
                let is_weapon = def(it.item).is_some_and(|d| matches!(d.kind, ItemKind::Weapon(_)));
                let is_charge =
                    def(it.item).is_some_and(|d| matches!(d.kind, ItemKind::Battery { .. }));
                let rank = if charge {
                    is_charge
                } else {
                    !armed && is_weapon
                };
                // Space (T22.03B): nothing a flight to it would end in a keep-out disc for.
                if space::forbidden(world, it.pos) && world.gravity == GravityMode::Space {
                    continue;
                }
                if item_best.is_none_or(|(br, bd, _)| (rank, -d) > (br, -bd)) {
                    item_best = Some((rank, d, Goal::Item(it.id)));
                }
            }
            if let Some((rank, d, g)) = item_best {
                // A visible enemy still wins if we are armed — unless the suit needs
                // the pack (T22.03B).
                if !armed || best.is_none() || (charge && rank) {
                    best = Some((d, g));
                }
            } else if !armed && !flee {
                // §E10: **arm first.** Nothing to pick up that we can see, and
                // nothing to shoot with — so go and find one rather than walking
                // at somebody we cannot hurt. Dropping the enemy here is what
                // sends the bot into exploration below, which is the only way it
                // reaches a weapon that is not already in view.
                //
                // Fleeing is exempt: a hurt bot running away is not shopping, and
                // an unarmed one has more reason to run than most.
                best = None;
            }
        }

        self.goal = match best {
            Some((_, g)) => g,
            None => Goal::Wander,
        };

        if self.goal == Goal::Wander {
            self.wander_for += dt;
            let cov = self.coverage.get_or_insert_with(|| {
                let mut c = Coverage::new(world.map.mask.w as i32, world.map.mask.h as i32);
                c.mark_outside(world);
                c
            });
            let (cx, cy) = cov.cell_of(pos);
            let here = cov.index(cx, cy);
            cov.mark(here);

            // Arrived, or gave up. Both mark the cell: "seen" means "been there
            // or tried", because a cell whose middle is buried in rock can never
            // be entered and a bot that insists on it stops exploring.
            let arrived = self.wander_to.is_some_and(|w| {
                cov.cell_of(w) == (cx, cy) || (w - pos).len() < BOT_WANDER_ARRIVED
            });
            // T22.03D: a cell in a space keep-out (a permanent vortex's disc, the
            // hole's reach) is one `space::steer` will not approach, so the bot sat
            // out `BOT_WANDER_GIVE_UP` against whatever rock it was on — "seen" at once.
            let barred = world.gravity == GravityMode::Space
                && self.wander_to.is_some_and(|w| space::forbidden(world, w));
            let gave_up = self.wander_for > BOT_WANDER_GIVE_UP || barred;
            if arrived || gave_up {
                if let Some(w) = self.wander_to {
                    let (wx, wy) = cov.cell_of(w);
                    let i = cov.index(wx, wy);
                    cov.mark(i);
                }
                self.wander_to = None;
            }

            if self.wander_to.is_none() {
                self.wander_for = 0.0;
                // Every cell visited: start again rather than stand still. The
                // map is destructible and full of respawning items, so a second
                // lap is not a wasted one.
                if cov.all_seen() {
                    cov.clear();
                    cov.mark_outside(world);
                    cov.mark(here);
                }
                self.wander_to = cov.nearest_unseen(pos);
            }
        } else {
            self.wander_to = None;
            self.wander_for = 0.0;
        }
    }

    fn target_pos(&self, world: &World, pos: Vec2) -> Option<Vec2> {
        match self.goal {
            // `Flee` aims at the enemy too — only the walking direction differs,
            // and it is inverted where the buttons are chosen.
            Goal::Enemy(id) | Goal::Flee(id) => {
                world.player(id).filter(|p| p.alive).map(|p| p.body.pos)
            }
            Goal::Item(id) => world.items.iter().find(|i| i.id == id).map(|i| i.pos),
            Goal::Wander => self.wander_to.or(Some(pos)),
        }
    }

    /// The nearest damaging ground hazard whose reach covers `at`, if any.
    ///
    /// Bots had a guard for a blast *radius* and none for a hazard that
    /// **lingers**, so they threw a molotov and walked into the fire. T11.09
    /// measured the result: molotov 0.46 damage dealt against 1.68 self, toxic
    /// 0.60 against 1.79 — three times more harm to their user than to anyone
    /// else. That is a perception gap, not a weapon-balance one, which is why
    /// widening the flamethrower's range measured *worse* and was reverted.
    ///
    /// Only hazards within `FOV_DAY` count. A bot reacting to fire it cannot see
    /// would be cheating (§A5); a human sees the fire they are standing in.
    fn hazard_at(&self, world: &World, at: Vec2, margin: f32) -> Option<Hazard> {
        let mut best: Option<(f32, Hazard)> = None;
        let mut consider = |pos: Vec2, radius: f32, lit_by: Option<PlayerId>| {
            let d = (pos - at).len();
            if d > FOV_DAY {
                return; // out of sight: not knowable, so not usable
            }
            if d <= radius + margin && best.is_none_or(|(bd, _)| d < bd) {
                best = Some((d, Hazard { pos, lit_by }));
            }
        };
        for p in world.burn.patches() {
            let lit_by = match p.source {
                DamageSource::Player { id, .. } => Some(id),
                // A fall lights no fires, so this arm is unreachable — but it is
                // spelled out rather than defaulted, because a `_ =>` here is
                // what would swallow the next source that *can* light one.
                DamageSource::SelfInflicted { .. }
                | DamageSource::Weather(_)
                | DamageSource::Fall
                | DamageSource::Radiation => None,
            };
            consider(p.pos, p.radius, lit_by);
        }
        // §F10.2. **Flames, or bots silently stop avoiding fire.** Every fire in
        // the game left `BurnField` when the molotov, the flamethrower and the
        // vent became flame emitters, and nothing in the suite names this
        // behaviour — so without this loop a bot would keep dodging toxic clouds
        // and walk straight into a burning floor, with every test green. It is
        // the "mechanism wired to nothing" shape from the other direction: a
        // reader wired to nothing.
        //
        // `u8::MAX` is the weather's owner (`detonate`), so a vent's fire is
        // nobody's and cannot be excused as "my own".
        for f in world.projectiles.iter() {
            if !crate::weapons::flame::is_flame(f.weapon) {
                continue;
            }
            let lit_by = (f.owner != u8::MAX).then_some(f.owner);
            consider(f.pos, FLAME_RADIUS, lit_by);
        }
        best.map(|(_, h)| h)
    }
}

#[cfg(test)]
mod tests {
    pub(super) use super::*;
    pub(super) use crate::constants::{
        MapScale, BOT_LOS_MAX_BLOCKED, BOT_LOS_STEP, PLAYER_H, SIM_DT,
    };
    pub(super) use crate::items::registry::{BAZOOKA, MEDKIT, MOLOTOV, PISTOL};
    // `wield` because §F5 puts a shovel in slot 0 of every player: `give` appends
    // to the first free slot, so a fixture that only gives a weapon is holding a
    // shovel and measuring a swing. See `world::wield`.
    pub(super) use crate::world::{give, wield, RoundPhase, World};

    pub(super) const SEED: u64 = 4242;

    /// A point with 260 px of clear air to its right.
    ///
    /// Placing two players at arbitrary coordinates and asserting the bot shoots
    /// is a test of the terrain, not of the bot: the line of sight runs through
    /// whatever the generator put there. Same trap as carving into empty sky.
    pub(super) fn clear_line(w: &World) -> Vec2 {
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

    pub(super) fn world_with(ids: &[PlayerId]) -> World {
        let mut w = World::for_test(SEED, MapScale::Small);
        w.set_phase(RoundPhase::Playing);
        for id in ids {
            w.add_player(*id, 0, format!("p{id}"));
        }
        let _ = w.drain_events();
        w
    }

    /// A flat shelf with clear air above it, carved into the map.
    ///
    /// Returns the y a player stands at. `clear_line` finds clear *air*, which is
    /// what a shot needs and the wrong thing for a walking test: in the first
    /// version of the retreat fixture both players fell, and a distance between
    /// two falling bodies measures nothing about which way anybody walked. The
    /// second stood them on generated ground, and the two columns differed enough
    /// in height to put the enemy outside `FOV_DAY`, so the bot never engaged.
    ///
    /// Carving the ground makes this a test of the bot rather than of whatever
    /// the generator happened to put there — the same reason `clear_line` exists.
    pub(super) fn flat_shelf(w: &mut World, at: Vec2, span: i32) -> f32 {
        let floor = at.y as i32 + PLAYER_H as i32;
        // **Ground behind as well as ahead.** The shelf used to start 40 px to
        // the left, which is ground enough to stand on and not enough to walk
        // away over: T18.04's terrain change left a retreating bot at the edge
        // after 40 px, and the retreat read as stalling at 219 px and closing
        // back to 180. A fixture that carves its own ground has to carve all the
        // ground the behaviour needs.
        let back = span * 2;
        for y in floor..(floor + 24) {
            w.map
                .mask
                .set_run(y, at.x as i32 - back, at.x as i32 + span);
        }
        for y in (floor - 96)..floor {
            w.map
                .mask
                .clear_run(y, at.x as i32 - back, at.x as i32 + span);
        }
        // The coarse grid is a cache of the mask and collision reads it, so a
        // hand-carved shelf that skipped this would be solid to the mask and
        // empty to the physics.
        w.map.coarse = crate::map::coarse::CoarseGrid::build(&w.map.mask);
        floor as f32 - PLAYER_H / 2.0 - 1.0
    }

    /// Put an item on the ground where the test wants it, not where the world
    /// would have. Returns its id so an assertion can name which one.
    pub(super) fn drop_at(w: &mut World, item: crate::items::registry::ItemId, pos: Vec2) -> u32 {
        w.items.spawn(
            item,
            1,
            pos,
            Vec2::new(0.0, 0.0),
            crate::items::world::SpawnSource::Initial,
            0.0,
        )
    }

    /// §E10: arming yourself outranks the nearest thing on the floor.
    #[test]
    fn an_unarmed_bot_goes_for_the_weapon_past_a_nearer_medkit() {
        let mut w = world_with(&[1]);
        let at = clear_line(&w);
        if let Some(p) = w.player_mut(1) {
            p.body.pos = at;
        }
        // The medkit is nearer. Nearest-of-anything would take it and leave the
        // bot unarmed, which is what this replaces.
        let heal = drop_at(&mut w, MEDKIT, Vec2::new(at.x + 60.0, at.y));
        let gun = drop_at(&mut w, BAZOOKA, Vec2::new(at.x + 200.0, at.y));
        let mut b = Bot::new(1, SEED, 0, 0.6);
        b.think(&w, 0.0, SIM_DT);
        assert_eq!(
            b.goal,
            Goal::Item(gun),
            "an unarmed bot took the nearer medkit (item {heal}) over the weapon",
        );

        // The control: once armed, nearest wins again — the rule is "arm
        // yourself first", not "always prefer weapons".
        give(&mut w, 1, MOLOTOV, 1);
        let mut armed = Bot::new(1, SEED, 0, 0.6);
        armed.think(&w, 0.0, SIM_DT);
        assert_eq!(
            armed.goal,
            Goal::Item(heal),
            "an armed bot ignored the nearer medkit, so the preference is not conditional",
        );
    }

    /// **T22.03G: a bot does not go for an item the pickup would refuse.** Traced in
    /// `space_bots_report`: bots parked 2–12 px from an item for 10–40 s with
    /// `is_full_for` true, because the goal never checked what `resolve_pickups`
    /// would take. Two refusals, two arms — a §C9 counter at its cap (medkits at
    /// `MAX_HEALS`) and a held weapon stack at its `max_stack` — each with the same
    /// item and the room to take it as the control.
    #[test]
    fn a_bot_does_not_go_for_an_item_it_cannot_pick_up() {
        use crate::constants::MAX_HEALS;
        use crate::items::registry::max_stack;
        // Counter arm: a medkit 60 px off, heals full vs empty.
        let goal_for_heal = |heals: u8| {
            let mut w = world_with(&[1]);
            let at = clear_line(&w);
            give(&mut w, 1, MOLOTOV, 1); // armed, so no weapon ranking in play
            if let Some(p) = w.player_mut(1) {
                p.body.pos = at;
                p.heals = heals;
            }
            let heal = drop_at(&mut w, MEDKIT, Vec2::new(at.x + 60.0, at.y));
            let mut b = Bot::new(1, SEED, 0, 0.6);
            b.think(&w, 0.0, SIM_DT);
            (b.goal, heal)
        };
        let (g, heal) = goal_for_heal(0);
        assert_eq!(
            g,
            Goal::Item(heal),
            "control: room for a heal, and it was not wanted"
        );
        let (g, heal) = goal_for_heal(MAX_HEALS);
        assert_ne!(
            g,
            Goal::Item(heal),
            "went for a medkit with heals at MAX_HEALS"
        );

        // Inventory arm: a molotov 60 px off, the held molotov stack full vs one.
        let goal_for_molotov = |held: u8| {
            let mut w = world_with(&[1]);
            let at = clear_line(&w);
            give(&mut w, 1, MOLOTOV, held);
            if let Some(p) = w.player_mut(1) {
                p.body.pos = at;
                assert_eq!(p.inventory.is_full_for(MOLOTOV), held == max_stack(MOLOTOV));
            }
            let m = drop_at(&mut w, MOLOTOV, Vec2::new(at.x + 60.0, at.y));
            let mut b = Bot::new(1, SEED, 0, 0.6);
            b.think(&w, 0.0, SIM_DT);
            (b.goal, m)
        };
        let (g, m) = goal_for_molotov(1);
        assert_eq!(
            g,
            Goal::Item(m),
            "control: room for a molotov, and it was not wanted"
        );
        let (g, m) = goal_for_molotov(max_stack(MOLOTOV));
        assert_ne!(g, Goal::Item(m), "went for a molotov with its stack full");
    }

    /// **T22.12C F2: a bot does not shop inside the black hole's reach** — the
    /// same unarmed bot and the same weapon as above, with a hole just past the gun
    /// so the gun is inside its reach and the medkit is not: it goes for the medkit.
    /// The control is the test above, where the gun wins.
    #[test]
    fn an_unarmed_bot_does_not_shop_inside_the_black_holes_reach() {
        let mut w = world_with(&[1]);
        let at = clear_line(&w);
        if let Some(p) = w.player_mut(1) {
            p.body.pos = at;
        }
        let heal = drop_at(&mut w, MEDKIT, Vec2::new(at.x + 60.0, at.y));
        let gun_at = Vec2::new(at.x + 200.0, at.y);
        let gun = drop_at(&mut w, BAZOOKA, gun_at);
        // Beyond the gun, so the gun is inside the reach and the medkit is not.
        let hole = gun_at + Vec2::new(crate::constants::BLACK_HOLE_REACH - 10.0, 0.0);
        w.place_black_hole_for_test(hole);
        let mut b = Bot::new(1, SEED, 0, 0.6);
        b.think(&w, 0.0, SIM_DT);
        assert_eq!(
            b.goal,
            Goal::Item(heal),
            "an unarmed bot did not settle for the medkit clear of the hole (the gun, item \
             {gun}, is inside its reach)"
        );
    }

    /// **T22.03B: a suit running flat sends an armed bot to a pack in sight, past a
    /// visible enemy** — radiation was the commonest environmental death in space.
    /// Three arms on one fixture: battery at a third (goes for the pack); full
    /// (fights — the control); low but carrying a battery (fights, and uses it via
    /// `choose_item`). And the mode gate: the same low battery under standard gravity
    /// has no suit to seal, so it fights.
    #[test]
    fn a_bot_whose_suit_runs_flat_goes_for_a_battery_pack() {
        use crate::items::registry::{BATTERY_PACK, PISTOL};
        let goal = |battery: f32, carry: bool, gravity: GravityMode| {
            let mut w = world_with(&[1, 2]);
            w.gravity = gravity;
            let at = clear_line(&w);
            crate::world::give(&mut w, 1, PISTOL, 1);
            if carry {
                crate::world::give(&mut w, 1, BATTERY_PACK, 1);
            }
            if let Some(p) = w.player_mut(1) {
                p.body.pos = at;
                p.battery = battery;
            }
            if let Some(p) = w.player_mut(2) {
                p.body.pos = Vec2::new(at.x + 100.0, at.y);
            }
            let pack = drop_at(&mut w, BATTERY_PACK, Vec2::new(at.x + 150.0, at.y));
            let mut b = Bot::new(1, SEED, 0, 0.6);
            b.think(&w, 0.0, SIM_DT);
            (b.goal, pack)
        };
        let low = BATTERY_MAX * crate::constants::BOT_SUIT_SHOP_BELOW * 0.6;
        let (g, pack) = goal(low, false, GravityMode::Space);
        assert_eq!(
            g,
            Goal::Item(pack),
            "a flat suit in space fought instead of charging"
        );
        let (g, _) = goal(BATTERY_MAX, false, GravityMode::Space);
        assert_eq!(g, Goal::Enemy(2), "control: a full suit should fight");
        let (g, _) = goal(low, true, GravityMode::Space);
        assert_eq!(
            g,
            Goal::Enemy(2),
            "carrying a battery, it should fight and use it"
        );
        let (g, _) = goal(low, false, GravityMode::Standard);
        assert_eq!(
            g,
            Goal::Enemy(2),
            "no suit under standard gravity, yet it went shopping"
        );
    }

    /// §E10: an item behind a wall is not a target.
    #[test]
    fn an_item_behind_solid_rock_is_not_a_target() {
        let mut w = world_with(&[1]);
        let at = clear_line(&w);
        if let Some(p) = w.player_mut(1) {
            p.body.pos = at;
        }
        // Inside `FOV_DAY` (320) — an item further than that is invisible and
        // the presence half below would fail for the wrong reason, which the
        // first version of this fixture did — and far enough that a wall between
        // can exceed `BOT_LOS_MAX_BLOCKED * BOT_LOS_STEP` (192 px).
        let clear = drop_at(&mut w, BAZOOKA, Vec2::new(at.x + 300.0, at.y));
        let mut b = Bot::new(1, SEED, 0, 0.6);
        b.think(&w, 0.0, SIM_DT);
        // The presence half: with a clear line the bot wants it. Without this
        // the absence below passes for a bot that never targets an item at all.
        assert_eq!(
            b.goal,
            Goal::Item(clear),
            "a bot ignored an item in plain sight"
        );

        // Now wall it off. The tolerance is a **count**: `BOT_LOS_MAX_BLOCKED`
        // samples at `BOT_LOS_STEP` px is 192 px of rock, so a 160 px wall passes it
        // — which the first version of this test discovered by failing. This one
        // is 300 px along the line, "behind a mountain" rather than "over a
        // hill", and it is derived from the two constants rather than picked.
        let thick = (BOT_LOS_MAX_BLOCKED as f32 * BOT_LOS_STEP * 1.25) as i32;
        for dx in 30..(30 + thick) {
            for dy in -200..200 {
                w.map.mask.set(at.x as i32 + dx, at.y as i32 + dy);
            }
        }
        let mut walled = Bot::new(1, SEED, 0, 0.6);
        walled.think(&w, 0.0, SIM_DT);
        assert_ne!(
            walled.goal,
            Goal::Item(clear),
            "a bot targeted an item behind {thick} px of solid rock",
        );
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

    // --- T11.14: bots and lingering hazards ------------------------------

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

    /// A round in which the bots damage each other at all.
    ///
    /// The unit tests above only prove the bot *asks* to fire. Whether a shot
    /// leaves the barrel depends on the driver turning that request into
    /// `World::fire`, which is a different layer — and the layer where it was
    /// broken.
    #[test]
    fn bots_actually_hurt_each_other_over_a_round() {
        // **A spread of seeds, not one.** This asserted on seed 99 alone, and
        // T11.03–T11.06 added eleven items — which reshuffled the seeded spawn
        // stream and turned that particular round into one where four bots never
        // meet (§B17: the pool is a budget, and changing it moves everything).
        //
        // Measured across eight seeds after the arsenal landed:
        //   damage 191 / 0 / 644 / 0 / 401 / 31 / 210 / 0
        // Five of eight fight. Seed 99 draws a round where nobody finds anyone,
        // which is a real property of a 2048×1024 map with a 320 px sight radius
        // — not a broken bot. Pinning to one sample made a population claim from
        // a single draw, which is how `a_round_of_bots_is_a_fight` became a
        // coin flip before it was removed (§A28).
        //
        // Asserting on the population is *stricter* than one lucky seed: it
        // cannot be flipped by a spawn reshuffle, and it fails for real if bots
        // stop fighting.
        const SEEDS: [u64; 8] = [1, 7, 42, 99, 4242, 31337, 5, 11];
        let rounds: Vec<_> = SEEDS
            .iter()
            .map(|s| harness::run_round(*s, 4, 0.85, 150.0))
            .collect();

        let damage: f32 = rounds.iter().map(|r| r.damage_dealt).sum();
        let fired = rounds.iter().filter(|r| r.stats.fires > 0).count();
        let bled = rounds.iter().filter(|r| r.damage_dealt > 0.0).count();

        assert!(
            damage > 0.0,
            "four bots over {} rounds of 150 s and nobody took a scratch",
            SEEDS.len()
        );
        assert!(
            fired >= SEEDS.len() / 2,
            "a trigger was pulled in only {fired} of {} rounds",
            SEEDS.len()
        );
        assert!(
            bled >= 3,
            "only {bled} of {} rounds drew blood (total damage {damage:.0}) — \
             bots are not fighting",
            SEEDS.len()
        );
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
            ticks_hazard_evaded: a.ticks_hazard_evaded + b.ticks_hazard_evaded,
            ticks_hazard_blocked: a.ticks_hazard_blocked + b.ticks_hazard_blocked,
            rej_impact_guard: a.rej_impact_guard + b.rej_impact_guard,
            ticks_winged_stuck: a.ticks_winged_stuck + b.ticks_winged_stuck,
            ticks_winged_stuck_moving: a.ticks_winged_stuck_moving + b.ticks_winged_stuck_moving,
            ticks_dest_forbidden: a.ticks_dest_forbidden + b.ticks_dest_forbidden,
            ticks_dest_forbidden_idle: a.ticks_dest_forbidden_idle + b.ticks_dest_forbidden_idle,
        }
    }

    pub fn run_round(seed: u64, n_bots: usize, skill: f32, seconds: f32) -> RoundResult {
        run_round_inner(seed, n_bots, skill, seconds, None)
    }

    /// A round where every bot starts **holding** `selected` (selected, and with
    /// its battery flat if it is an energy weapon) and carrying `spare`.
    ///
    /// This exists because measuring the spawn pool does not discriminate: a
    /// weapon at spawn weight 10 in a fourteen-item pool is rarely in anyone's
    /// hands inside a minute, so a round-level assertion passes whether or not
    /// the weapon is usable at all.
    pub fn run_round_holding(
        seed: u64,
        n_bots: usize,
        skill: f32,
        seconds: f32,
        selected: crate::items::registry::ItemId,
        spare: crate::items::registry::ItemId,
    ) -> RoundResult {
        run_round_inner(seed, n_bots, skill, seconds, Some((selected, spare)))
    }

    fn run_round_inner(
        seed: u64,
        n_bots: usize,
        skill: f32,
        seconds: f32,
        loadout: Option<(
            crate::items::registry::ItemId,
            crate::items::registry::ItemId,
        )>,
    ) -> RoundResult {
        let mut w = World::new(seed, MapScale::Small);
        w.set_phase(RoundPhase::Playing);
        let mut bots = Vec::new();
        for i in 0..n_bots {
            let id = i as PlayerId;
            w.add_player(id, 0, format!("Bot {i}"));
            if let Some((sel, spare)) = loadout {
                crate::world::give(&mut w, id, sel, 1);
                crate::world::give(&mut w, id, spare, 20);
                let slot = (0..crate::constants::INVENTORY_SLOTS as u8).find(|s| {
                    w.player(id)
                        .and_then(|p| p.inventory.slot(*s))
                        .is_some_and(|st| st.item == sel)
                });
                if let Some(slot) = slot {
                    w.select_slot(id, slot);
                }
                if let Some(p) = w.player_mut(id) {
                    p.battery = 0.0;
                }
            }
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
                // Selection is a command too (`docs/30` §4), and a harness that
                // skips it has the same defect as one that skips firing: it
                // measures a bot that can never change weapons. Before `fire`,
                // so a bot that just picked up something better uses it now.
                if let Some(slot) = b.wants_select() {
                    w.select_slot(b.player, slot);
                }
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
                        // A void death is environmental, like the weather is.
                        // Counted together because the balance report's question
                        // is "how many deaths did the map cause", not which part
                        // of it (§C15).
                        // Radiation too (T22.09A): the map's, not a player's.
                        DeathCause::Weather
                        | DeathCause::Void
                        | DeathCause::Radiation
                        | DeathCause::BlackHole => r.weather_deaths += 1,
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
