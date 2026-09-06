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
    BATTERY_MAX, BOT_EXPLORE_CELL, BOT_FLEE_HEALTH, FLAME_GRAVITY_SCALE, FLAME_RADIUS, FOV_DAY,
    GRAVITY, INVENTORY_SLOTS, JETPACK_MAX_FUEL, PICKUP_RADIUS, STEP_UP,
};
use crate::items::registry::{def, ItemId, ItemKind};
use crate::math::{Vec2, TAU};
use crate::player::input::{button, Input};
use crate::player::state::PlayerId;
use crate::rng::substream;
use crate::weapons::defs::Delivery;
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
/// A bot that has not moved this far in `STUCK_WINDOW` jumps.
/// Margin around a burning patch a bot treats as unsafe, on top of its radius.
/// One player-width, so a bot standing at the rim is already leaving.
const HAZARD_CLEARANCE: f32 = 20.0;
/// How far ahead a bot looks before stepping into fire — about a walk-second.
const HAZARD_LOOKAHEAD: f32 = 48.0;
/// How far ahead the throw predictor flies the arc, in ticks. Two seconds is
/// past every fuse in the arsenal, and capping it matters: running to
/// `PROJECTILE_MAX_LIFETIME` for every bot every tick is a tick-budget problem,
/// not a safety improvement.
const PREDICT_TICKS: u32 = 120;

const STUCK_PX: f32 = 6.0;
const STUCK_WINDOW: f32 = 0.5;
/// Seconds a bot heads for one unvisited cell before marking it seen and
/// choosing another (§E10).
///
/// The escape hatch for a cell whose middle is inside rock: without it a bot
/// walks at a wall for the rest of the round. Local like the rest of the bot's
/// tuning; `BOT_EXPLORE_CELL` is in `constants.rs` because §E15 names it.
const WANDER_GIVE_UP: f32 = 6.0;

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

/// Which cells of the map a bot has been to (§E10).
///
/// **This is not pathfinding and must not become it.** A bot marks the cell it
/// is standing in, heads for the middle of the nearest cell it has not marked,
/// and gives up on one it cannot reach. There is no graph, no route and no
/// A* — the map is destructible, so any route is stale the moment somebody
/// fires, and the behaviour this exists to produce is "went somewhere else",
/// not "took the best way there".
///
/// Per bot, not shared: five bots that agreed on where they had been would
/// spread out like a search party rather than like opponents.
#[derive(Debug, Clone)]
struct Coverage {
    cols: i32,
    rows: i32,
    /// One bit per cell, row-major.
    seen: Vec<u64>,
}

impl Coverage {
    fn new(map_w: i32, map_h: i32) -> Self {
        let cols = (map_w.max(1) + BOT_EXPLORE_CELL - 1) / BOT_EXPLORE_CELL;
        let rows = (map_h.max(1) + BOT_EXPLORE_CELL - 1) / BOT_EXPLORE_CELL;
        let cells = (cols.max(1) * rows.max(1)) as usize;
        Coverage {
            cols: cols.max(1),
            rows: rows.max(1),
            seen: vec![0; cells.div_ceil(64)],
        }
    }

    fn index(&self, cx: i32, cy: i32) -> usize {
        (cy * self.cols + cx) as usize
    }

    fn cell_of(&self, p: Vec2) -> (i32, i32) {
        (
            ((p.x as i32) / BOT_EXPLORE_CELL).clamp(0, self.cols - 1),
            ((p.y as i32) / BOT_EXPLORE_CELL).clamp(0, self.rows - 1),
        )
    }

    fn is_seen(&self, i: usize) -> bool {
        self.seen
            .get(i / 64)
            .is_some_and(|w| w & (1 << (i % 64)) != 0)
    }

    fn mark(&mut self, i: usize) {
        if let Some(w) = self.seen.get_mut(i / 64) {
            *w |= 1 << (i % 64);
        }
    }

    fn all_seen(&self) -> bool {
        (0..(self.cols * self.rows) as usize).all(|i| self.is_seen(i))
    }

    fn clear(&mut self) {
        for w in &mut self.seen {
            *w = 0;
        }
    }

    /// The middle of the nearest cell this bot has not been to, if any.
    ///
    /// Ties break on the lower index rather than at random, so two bots with the
    /// same coverage make the same choice — the sim is deterministic and this is
    /// read on the hot path, where a coin flip would cost a draw from the RNG
    /// and buy nothing.
    fn nearest_unseen(&self, from: Vec2) -> Option<Vec2> {
        let mut best: Option<(f32, Vec2)> = None;
        for cy in 0..self.rows {
            for cx in 0..self.cols {
                let i = self.index(cx, cy);
                if self.is_seen(i) {
                    continue;
                }
                let c = Vec2::new(
                    (cx * BOT_EXPLORE_CELL + BOT_EXPLORE_CELL / 2) as f32,
                    (cy * BOT_EXPLORE_CELL + BOT_EXPLORE_CELL / 2) as f32,
                );
                let d = (c - from).len();
                if best.is_none_or(|(bd, _)| d < bd) {
                    best = Some((d, c));
                }
            }
        }
        best.map(|(_, c)| c)
    }
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
            coverage: None,
            wander_for: 0.0,
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

        let mut buttons = 0u8;

        // --- move -------------------------------------------------------
        let dx = aim_at.x - pos.x;
        if matches!(self.goal, Goal::Flee(_)) {
            // §E10: away, and **not gated on `stand_off`**. Stopping at the
            // stand-off distance is what a bot does when it wants to shoot from
            // there; a retreating bot that stopped at it would flee to exactly
            // the range it was just losing at, take another hit and flee again —
            // an oscillation that satisfies a two-sample distance check and is
            // worse than never fleeing at all. It keeps walking while its health
            // is low, and `choose_goal` stops choosing `Flee` once healed.
            buttons |= if dx > 0.0 {
                button::LEFT
            } else {
                button::RIGHT
            };
        } else {
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
        }

        // Standing in fire beats reaching the target. Overriding the direction
        // rather than adding to it matters: a bot that keeps its original
        // buttons set walks *through* the patch it is trying to leave, and the
        // hazards that hurt bots most are the ones they are standing on.
        // `fleeing` was tracked here and read only by the trigger-planting block
        // §F4 deleted — it stopped a bot planting itself inside a burning patch.
        // With nothing to plant, the flag has no second reader.
        if let Some(h) = self.hazard_at(world, pos, HAZARD_CLEARANCE) {
            buttons &= !(button::LEFT | button::RIGHT);
            buttons |= if pos.x >= h.pos.x {
                button::RIGHT
            } else {
                button::LEFT
            };
            if h.lit_by.is_some_and(|id| id != self.player) {
                self.stats.ticks_hazard_evaded += 1;
            }
        } else if buttons & (button::LEFT | button::RIGHT) != 0 {
            // Not in one yet — do not step into one. Probe one walk-second
            // ahead in the direction already chosen.
            let ahead = Vec2::new(
                pos.x
                    + if buttons & button::RIGHT != 0 {
                        HAZARD_LOOKAHEAD
                    } else {
                        -HAZARD_LOOKAHEAD
                    },
                pos.y,
            );
            if let Some(h) = self.hazard_at(world, ahead, 0.0) {
                buttons &= !(button::LEFT | button::RIGHT);
                if h.lit_by.is_some_and(|id| id != self.player) {
                    self.stats.ticks_hazard_blocked += 1;
                }
            }
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
        self.want_select = self.choose_weapon(me, aim_at, pos);

        Input {
            seq: 0, // the room owns sequencing; a bot has no packets to order
            buttons,
            aim,
        }
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
        if best.is_none() || !armed {
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
                // A weapon outranks a medkit **when we have no weapon** (§E10).
                // Nearest-of-anything sent an unarmed bot past a bazooka to the
                // battery beyond it; arming yourself is the thing that makes the
                // next ten seconds go differently.
                let is_weapon = def(it.item).is_some_and(|d| matches!(d.kind, ItemKind::Weapon(_)));
                let rank = !armed && is_weapon;
                if item_best.is_none_or(|(br, bd, _)| (rank, -d) > (br, -bd)) {
                    item_best = Some((rank, d, Goal::Item(it.id)));
                }
            }
            if let Some((_, d, g)) = item_best {
                // A visible enemy still wins if we are armed.
                if !armed || best.is_none() {
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
                Coverage::new(world.map.mask.w as i32, world.map.mask.h as i32)
            });
            let (cx, cy) = cov.cell_of(pos);
            let here = cov.index(cx, cy);
            cov.mark(here);

            // Arrived, or gave up. Both mark the cell: "seen" means "been there
            // or tried", because a cell whose middle is buried in rock can never
            // be entered and a bot that insists on it stops exploring.
            let arrived = self
                .wander_to
                .is_some_and(|w| cov.cell_of(w) == (cx, cy) || (w - pos).len() < 64.0);
            let gave_up = self.wander_for > WANDER_GIVE_UP;
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
                | DamageSource::Fall => None,
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

    /// How close to close. Never inside the guard that stops us firing, or the
    /// bot walks to a range where it has forbidden itself to shoot.
    ///
    /// **`blast_radius` alone is the wrong number**, and this is the second place
    /// it was: it is 0 for exactly the `Burst::Zone` weapons — molotov, toxic —
    /// so a bot closed to the 40 px floor and stood in the fire it had just
    /// thrown. `zone_reach` already existed for the throw guard; the approach
    /// used the old number, which is why molotov self-harm stayed the highest in
    /// the arsenal after T11.14's first pass.
    fn stand_off(&self, world: &World) -> f32 {
        let w = self
            .selected_weapon(world)
            .and_then(def)
            .and_then(|d| match d.kind {
                ItemKind::Weapon(wid) => crate::weapons::defs::def(wid),
                _ => None,
            });
        let reach = w.map_or(0.0, |w| zone_reach(w).unwrap_or(w.blast_radius));
        (reach * 2.0).max(40.0)
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

    /// Whether **any** slot holds a weapon that could be fired right now.
    ///
    /// Distinct from `selected_weapon`, which asks about the one in hand, and the
    /// distinction matters at exactly one place: deciding whether to go shopping.
    /// A bot holding a flat laser with a loaded gun two slots over is *armed* —
    /// `choose_weapon` switches it on this same tick — and treating it as unarmed
    /// sent it looking for a weapon it already had. Measured against the laser
    /// fixture, that read as 12583 shots refused for being unarmed against 474
    /// fired.
    ///
    /// **Melee does not count (§F5).** Every player now spawns holding a shovel,
    /// so a slot-counting answer is `true` for every bot for the whole round and
    /// "arm yourself first" stops meaning anything — no bot ever walks to a gun
    /// again. The question this function is asked at its one call site is "do I
    /// need to go shopping?", and the honest answer for someone holding only the
    /// thing everybody is issued is yes. The shovel is still *fired* — it is
    /// `choose_weapon`'s best option inside its reach — it just is not what being
    /// armed means.
    fn has_firable_weapon(&self, world: &World) -> bool {
        let Some(me) = world.player(self.player) else {
            return false;
        };
        (0..INVENTORY_SLOTS as u8).any(|slot| {
            me.inventory.slot(slot).is_some_and(|stack| {
                def(stack.item).is_some_and(|d| match d.kind {
                    ItemKind::Weapon(wid) => {
                        let Some(w) = crate::weapons::defs::def(wid) else {
                            return false;
                        };
                        if matches!(w.delivery, Delivery::Melee { .. }) {
                            return false;
                        }
                        w.energy_cost <= 0.0 || me.battery >= w.energy_cost
                    }
                    _ => false,
                })
            })
        })
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
        // A weapon that leaves a zone is dangerous well past its blast radius:
        // the fire outlives the explosion and the thrower walks into it. Guard
        // on the zone's own reach, not on `blast_radius`, which is 0 for these.
        if let Some(reach) = zone_reach(w) {
            if dist < reach + HAZARD_CLEARANCE {
                self.stats.rej_blast_guard += 1;
                return false;
            }
            // T11.15, §B26. The check above asks how far away the *target* is,
            // and a molotov is ballistic: thrown uphill or into a rise it falls
            // short, onto the thrower, and no target-distance guard can see
            // that. Walk the arc and ask where the hazard actually lands.
            //
            // `None` is "still flying after the cap", which is also a refusal:
            // not knowing where it lands is not a reason to throw it.
            let aim_at = (target - pos).angle();
            let landing = crate::weapons::projectile::predict_impact(
                &world.map,
                wid,
                pos,
                aim_at,
                world.wind,
                PREDICT_TICKS,
                crate::constants::SIM_DT,
            );
            match landing {
                Some(at) if (at - pos).len() < reach + HAZARD_CLEARANCE => {
                    self.stats.rej_impact_guard += 1;
                    return false;
                }
                None => {
                    self.stats.rej_impact_guard += 1;
                    return false;
                }
                Some(_) => {}
            }
        }
        // **Melee is not a blast and its range is not `range`.** For a swing,
        // `blast_radius` is the carve at the *tip* of the arc — `melee::swing`
        // skips the owner outright, so no swing can ever hurt the swinger — and
        // the distance it can hit from lives in `Delivery::Melee`, leaving
        // `range` at 0.0. Run the two guards below unchanged on a shovel and a
        // bot refuses everything inside 21 px as a self-blast and accepts
        // everything outside 28 px as in range: it swings at air across the map
        // and never at anyone it could actually hit. §F5 made that universal by
        // issuing one to every player. Both are `blast_radius`/`range` meaning a
        // second thing for one delivery kind.
        if let Delivery::Melee { reach, .. } = w.delivery {
            if dist > crate::weapons::melee::effective_reach(reach) {
                self.stats.rej_range += 1;
                return false;
            }
        } else {
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
        }

        // Line of sight. A weapon that carves 42 px treats a hill as cover to
        // remove rather than a wall to walk around, so the tolerance is
        // generous — but it stays a *count*, not a distance test: a
        // near-the-muzzle guard was measured and refused 87 % of the shots the
        // count allows, because a bot standing on the ground has rock within
        // 28 px of its muzzle almost always.
        if !self.reachable(world, pos, target) {
            self.stats.rej_los += 1;
            return false;
        }
        true
    }

    /// Whether a straight line from `from` to `to` is clear enough to matter.
    ///
    /// **One implementation, two callers**, because a second copy of this rule
    /// would be a second answer to "can I get at that" — and `should_fire` and
    /// item choice would drift apart the first time either was tuned
    /// (`CLAUDE.md`: share the guard, or share the function).
    ///
    /// The tolerance is deliberately generous and it is a **count**, not a
    /// distance: every weapon in this game digs (§A3), so rock between you and a
    /// target is soft cover rather than a wall, and a near-the-muzzle guard was
    /// measured refusing 87 % of the shots this allows. The same generosity is
    /// right for items for a different reason — a bot walks over hills, and a
    /// straight line clips every one of them, so anything stricter would reject
    /// items on the far side of ordinary ground.
    fn reachable(&self, world: &World, from: Vec2, to: Vec2) -> bool {
        let dist = (to - from).len();
        let steps = (dist / LOS_STEP).ceil() as u32;
        let mut blocked = 0u32;
        for i in 1..steps {
            let t = i as f32 / steps as f32;
            let p = from + (to - from) * t;
            if crate::physics::collide::solid_at(&world.map, p.x as i32, p.y as i32) {
                blocked += 1;
                if blocked > MAX_BLOCKED_SAMPLES {
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
            // How far this weapon can actually hit from. **Melee carries its
            // range in `Delivery`, not in `range`** (§F5): `w.range` is 0.0 for a
            // swing, so before the shovel existed the penalty below never applied
            // to melee and a bot scored a 54 dps shovel above every gun in the
            // game from any distance. It cost nothing while melee was a rare
            // pickup; every player spawning with one made it the default.
            // `effective_reach` because that is the number the hit test uses.
            let reach = match w.delivery {
                Delivery::Melee { reach, .. } => crate::weapons::melee::effective_reach(reach),
                _ => w.range,
            };
            if reach > 0.0 && dist > reach {
                score *= 0.25;
            }
            // The self-blast penalty, and **not for melee**: a swing's
            // `blast_radius` is the carve at the tip of the arc and `swing` skips
            // the owner, so it can never catch the swinger. `should_fire` makes
            // the same distinction, for the same reason — the two must agree, or
            // a bot selects a weapon it will then refuse to use.
            let self_blast = !matches!(w.delivery, Delivery::Melee { .. });
            if self_blast && w.blast_radius > 0.0 && dist < w.blast_radius * 1.5 {
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

    /// **Takes only what it reads.** It used to take `world` and `pos` for a
    /// threat scan that had no reader; keeping them "in case" is how the scan
    /// stayed alive through a review.
    fn choose_item(&self, me: &crate::player::state::PlayerState) -> Option<u8> {
        let hurt = me.health < HEAL_BELOW;

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
        // **No shield branch** (T20.08), and the decision is worth stating rather
        // than leaving as a deletion. This used to be "am I threatened and is my
        // shield down? then select the generator and use it". Under the new rule
        // a generator protects you **while it is in the bag** and `use_item`
        // refuses it, so the branch was not merely broken by the field going
        // away — it was meaningless: a bot that "used" a generator would spend a
        // decision doing nothing, and selecting it would put an unarmed slot in
        // its hand in the middle of a fight.
        //
        // **A bot with a generator is already shielded**, and the charge branch
        // above is what keeps it that way — the battery is the shield's ammunition
        // now, so "charge when low" is the shield behaviour as well as the laser
        // one. Picking generators up is `wants_item`'s business and is unchanged;
        // there is nothing left to do with one once it is held.
        //
        // **And `threatened` is gone with it.** That comment used to say it was
        // "still read by the caller above"; it was not read anywhere, so what it
        // guarded was a `let _ =` over an O(players) distance scan running on
        // every bot decision tick. `SHIELD_WITHIN` went with it — a constant
        // named for a mechanic that no longer exists is the same shape this
        // commit's parent correctly refused to leave behind for `SHIELD_DURATION`.
        None
    }
}

/// The radius a `Burst::Zone` weapon actually denies, or `None` if it leaves
/// nothing behind.
///
/// `blast_radius` is 0 for these — the zone *is* the weapon — so a guard written
/// against `blast_radius` never fires for exactly the weapons that need one.
fn zone_reach(w: &crate::weapons::defs::WeaponDef) -> Option<f32> {
    match w.burst {
        crate::weapons::defs::Burst::Zone {
            radius, scatter, ..
        } => Some(radius + scatter),
        // §F10.2. **The molotov's reach had to be re-derived or the regression
        // is silent.** It used to be `Burst::Zone`'s `radius + scatter`; a
        // molotov that is now `Burst::Flames` would fall through to
        // `w.blast_radius`, which is **0.0** for it, and `stand_off`'s `.max(40)`
        // floor would put a bot 40 px from a fire it had just thrown. That is
        // exactly the bug the comment on `stand_off` records having already been
        // fixed once.
        //
        // Derived from the burst and the flame's own physics, not from a new
        // constant: flames leave the impact at `speed` into an upward half-turn
        // and fall under `GRAVITY * FLAME_GRAVITY_SCALE`, so the crowd's spread
        // is the ballistic range `v^2 / g` of the fastest of them.
        //
        // `speed * FLAME_LIFE / 2` was the first attempt and it is **wrong by
        // 2.7x** — 560 px against a measured spread of about 100 — because a
        // flame spends most of `FLAME_LIFE` on the ground, not in the air. A bot
        // with that number refused every throw: the blast guard rejected 120
        // ticks out of 120 at a target 260 px away.
        crate::weapons::defs::Burst::Flames { speed, .. } => {
            Some(speed * speed / (GRAVITY * FLAME_GRAVITY_SCALE) + FLAME_RADIUS)
        }
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::constants::{MapScale, PLAYER_H, SIM_DT};
    use crate::items::registry::{BAZOOKA, MEDKIT, MOLOTOV, PISTOL};
    // `wield` because §F5 puts a shovel in slot 0 of every player: `give` appends
    // to the first free slot, so a fixture that only gives a weapon is holding a
    // shovel and measuring a swing. See `world::wield`.
    use crate::world::{give, wield, RoundPhase, World};

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
    fn flat_shelf(w: &mut World, at: Vec2, span: i32) -> f32 {
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
    fn drop_at(w: &mut World, item: crate::items::registry::ItemId, pos: Vec2) -> u32 {
        w.items.spawn(
            item,
            1,
            pos,
            Vec2::new(0.0, 0.0),
            crate::items::world::SpawnSource::Initial,
            0.0,
        )
    }

    /// Distinct `BOT_EXPLORE_CELL` cells the bots stood in over `seconds`.
    ///
    /// Sampled from the world rather than read off the bots' own grids: a
    /// coverage grid asserting on itself would pass for a grid that marks
    /// everything and a bot that never moves.
    fn cells_visited(seed: u64, scale: MapScale, n_bots: usize, seconds: f32) -> usize {
        let mut w = World::new(seed, scale);
        w.set_phase(RoundPhase::Playing);
        let mut bots = Vec::new();
        for i in 0..n_bots {
            let id = i as PlayerId;
            w.add_player(id, 0, format!("p{i}"));
            bots.push(Bot::new(id, seed, i as u32, 0.85));
        }
        let _ = w.drain_events();
        let mut seen: std::collections::BTreeSet<(i32, i32)> = std::collections::BTreeSet::new();
        let ticks = (seconds / SIM_DT) as u32;
        for t in 0..ticks {
            let now = t as f32 * SIM_DT;
            for b in bots.iter_mut() {
                let inp = b.think(&w, now, SIM_DT);
                w.queue_input(b.player, inp);
                if let Some(slot) = b.wants_select() {
                    w.select_slot(b.player, slot);
                }
                if inp.buttons & button::FIRE != 0 {
                    let _ = w.fire(b.player, now);
                }
                if let Some(slot) = b.wants_use() {
                    let _ = w.use_item(b.player, slot, now);
                }
            }
            w.step(SIM_DT);
            let _ = w.drain_events();
            for p in &w.players {
                if p.alive {
                    seen.insert((
                        p.body.pos.x as i32 / BOT_EXPLORE_CELL,
                        p.body.pos.y as i32 / BOT_EXPLORE_CELL,
                    ));
                }
            }
        }
        seen.len()
    }

    /// §E10: exploration, against the model it replaced.
    ///
    /// **The `before` numbers were measured at `9a19b2d`** — the commit before
    /// this task — with five bots at skill 0.85 for 120 simulated seconds, the
    /// same seeds, scales and sim time used here. They cannot be re-measured
    /// in-tree, because the random-spawn-point `Wander` they describe no longer
    /// exists; that is why they are written down with their provenance rather
    /// than left as a remembered figure. A metric with no control is a number.
    ///
    /// | seed / scale | before | after |
    /// |---|---|---|
    /// | 4242 small | 11 of 32 | 21 |
    /// | 4242 medium | 18 of 72 | 24 |
    /// | 31337 medium | 24 of 72 | **24 — a tie** |
    ///
    /// **Two of the three improve and the third ties**, so the assertion is a
    /// population one: no case is worse, and the total is strictly better. Said
    /// that way rather than as three wins, because it is not three wins — and a
    /// `>` on every case would have to be weakened to a `>=` to pass, which is
    /// the same thing said dishonestly.
    #[test]
    fn exploring_covers_more_map_than_the_random_wander_it_replaced() {
        const BEFORE: [(u64, MapScale, usize, &str); 3] = [
            (4242, MapScale::Small, 11, "4242 small"),
            (4242, MapScale::Medium, 18, "4242 medium"),
            (31337, MapScale::Medium, 24, "31337 medium"),
        ];
        let mut before_total = 0;
        let mut after_total = 0;
        for (seed, scale, before, label) in BEFORE {
            let after = cells_visited(seed, scale, 5, 120.0);
            assert!(
                after >= before,
                "{label}: {after} cells against {before} measured at 9a19b2d — \
                 exploration covered *less* ground than picking a random spawn point",
            );
            before_total += before;
            after_total += after;
        }
        assert!(
            after_total > before_total,
            "across all three: {after_total} cells against {before_total} at 9a19b2d — \
             no better than the model this replaced",
        );
    }

    /// The vacuity control the comparison above needs.
    ///
    /// Five bots that never moved would still occupy up to five cells, so a
    /// "more than before" comparison could in principle be satisfied by a wrong
    /// before-number rather than by movement. The floor here is **derived from
    /// the setup** — one cell per bot — rather than picked, which is the whole
    /// difference between a control and another threshold.
    #[test]
    fn bots_visit_more_cells_than_they_could_by_standing_still() {
        const N: usize = 5;
        let seen = cells_visited(SEED, MapScale::Small, N, 120.0);
        assert!(
            seen > N,
            "{N} bots reached {seen} cells in 120 s — no more than standing still would",
        );
    }

    /// §E10: below `BOT_FLEE_HEALTH` a bot breaks contact.
    ///
    /// The control is that a healthy bot in **the same situation** does not.
    /// Not "closes": both start at 120 px, which is a bazooka's stand-off, so a
    /// healthy bot has already arrived and stands still to shoot (§C20) — that
    /// is correct behaviour and asserting it walked closer would be asserting
    /// against the range-holding this project measured and fixed. Same map, same
    /// positions, same weapon; health is the only variable, and it is the only
    /// thing that decides whether the bot walks away.
    ///
    /// **The trend across the window, not two samples.** A bot that flees, clears
    /// `stand_off`, re-engages, is hit and flees again would satisfy a
    /// before/after pair while oscillating on the spot — which is worse than
    /// never fleeing. So this requires the distance to be greater than the start
    /// at *every* sample after the first second, and the healthy control to close
    /// over the same window on the same map.
    #[test]
    fn a_hurt_bot_breaks_contact_and_a_healthy_one_holds_its_ground() {
        // Distance per tick, and whether the bot was *fleeing* on that tick.
        // The window that matters is the one where it has chosen to run: once it
        // has broken contact the enemy is out of `FOV_DAY`, the goal stops being
        // `Flee`, and exploration takes over — which is the retreat succeeding,
        // not the retreat ending. Asserting past that point would demand the bot
        // never come back to a map it has to keep playing on.
        let track = |health: f32| -> Vec<(f32, bool, i8)> {
            let mut w = world_with(&[1, 2]);
            let at = clear_line(&w);
            // **No items anywhere.** A fresh world spawns them, and an unarmed
            // bot goes shopping rather than engaging — measured, the first
            // version of this fixture watched a bot walk to `Item(5)` for forty
            // ticks. With the floor bare the only goal available is the enemy,
            // which is the choice this test is about.
            let ids: Vec<_> = w.items.iter().map(|i| i.id).collect();
            for id in ids {
                w.items.remove(id);
            }
            // Standing on flat ground, not hanging in the air above it.
            let y = flat_shelf(&mut w, at, 240);
            if let Some(p) = w.player_mut(1) {
                p.body.pos = Vec2::new(at.x, y);
                p.health = health;
            }
            if let Some(p) = w.player_mut(2) {
                // Close, so breaking contact is a walk rather than a step:
                // `FOV_DAY` is 320, so a pair starting at 220 leaves only 100 px
                // of retreat before the goal stops being `Flee` — measured, 29
                // ticks, too short to have a trend in.
                p.body.pos = Vec2::new(at.x + 120.0, y);
            }
            // Armed, because §E10's "arm first" means an *unarmed* bot goes
            // looking for a weapon rather than closing — so an unarmed control
            // would not chase and the comparison would be between two different
            // decisions rather than between two healths.
            // A **pistol**, not a bazooka: `stand_off` is twice the blast radius, and
            // a bazooka's is ~300 px — so an armed-with-a-bazooka bot is *already at*
            // its firing range against a target 300 px away and correctly presses
            // nothing. A weapon with no blast closes to 40 px, which is the walking
            // this control is about.
            give(&mut w, 1, PISTOL, 10);
            let mut b = Bot::new(1, SEED, 0, 0.6);
            let mut d = Vec::new();
            for t in 0..300 {
                let now = t as f32 * SIM_DT;
                let inp = b.think(&w, now, SIM_DT);
                w.queue_input(1, inp);
                // Health is pinned: the question is which way it walks at this
                // health, not whether it survives long enough to be asked.
                if let Some(p) = w.player_mut(1) {
                    p.health = health;
                }
                w.step(SIM_DT);
                let _ = w.drain_events();
                let (a, c) = (w.player(1).unwrap().body.pos, w.player(2).unwrap().body.pos);
                // Which way it *pressed*, relative to the enemy. This is the
                // decision itself; distance is that decision plus whatever the
                // physics did afterwards, and a bazooka blast throws both bodies
                // apart hard enough to swamp a walk (`docs/21` §5).
                let toward = if inp.buttons & button::RIGHT != 0 {
                    if c.x > a.x {
                        1
                    } else {
                        -1
                    }
                } else if inp.buttons & button::LEFT != 0 {
                    if c.x < a.x {
                        1
                    } else {
                        -1
                    }
                } else {
                    0
                };
                d.push(((a - c).len(), matches!(b.goal, Goal::Flee(_)), toward));
            }
            d
        };

        let hurt = track(BOT_FLEE_HEALTH - 5.0);
        let healthy = track(100.0);

        // The retreat window: every tick from the first on which it chose to
        // flee, up to the last.
        let first = hurt.iter().position(|(_, f, _)| *f).expect(
            "a bot below BOT_FLEE_HEALTH never chose to flee, so the trend below is vacuous",
        );
        let last = hurt.iter().rposition(|(_, f, _)| *f).unwrap();
        let window = last - first;
        assert!(
            window > 40,
            "the retreat lasted {window} ticks — too short to have a trend",
        );

        // **The trend across the window, not two samples.** A bot that fled,
        // cleared `stand_off`, re-engaged and fled again would satisfy a
        // before/after pair while oscillating on the spot.
        let start = hurt[first].0;
        let settle = first + window / 4;
        for (i, (d, _, _)) in hurt.iter().enumerate().take(last + 1).skip(settle) {
            assert!(
                *d > start,
                "a fleeing bot closed back to {d:.0} px at tick {i} (retreat began at \
                 {start:.0}) — it is oscillating, not retreating",
            );
        }
        assert!(
            hurt[last].0 > hurt[settle].0,
            "the retreat stalled: {:.0} px at tick {settle}, {:.0} at {last}",
            hurt[settle].0,
            hurt[last].0,
        );

        // And the direction it pressed, which is the decision rather than its
        // consequences. Counted over the flee window on one side and the whole
        // run on the other.
        let away = hurt[first..=last].iter().filter(|(_, _, t)| *t < 0).count();
        assert!(
            away * 2 > window,
            "a fleeing bot pressed *toward* the enemy on most of its {window} \
             retreating ticks ({away} away)",
        );

        // The control. Without it "it walked away" is satisfied by a bot that
        // walks away whatever its health, which is not the behaviour asked for.
        assert!(
            !healthy.iter().any(|(_, f, _)| *f),
            "the healthy control chose to flee, so the two runs differ by something \
             other than health",
        );
        // It holds: at its stand-off it presses nothing horizontal and shoots.
        // What matters is that it never *retreats*, which is the behaviour under
        // test — and that its distance stays inside the range it chose, rather
        // than growing the way the hurt one's does.
        let retreating = healthy.iter().filter(|(_, _, t)| *t < 0).count();
        assert_eq!(
            retreating, 0,
            "the healthy control pressed away from the enemy on {retreating} ticks — \
             it is retreating, so health is not what decides this",
        );
        assert!(
            healthy[299].0 < hurt[last].0,
            "the healthy control ended {:.0} px away and the hurt one {:.0} — \
             they did not end up doing different things",
            healthy[299].0,
            hurt[last].0,
        );
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

    /// A weapon in the bag counts as armed, even when the one in hand is dead.
    ///
    /// `choose_goal` asked `selected_weapon`, so a bot holding a flat laser with
    /// a loaded pistol two slots over was treated as **unarmed** and went
    /// shopping for a weapon it already had. `choose_weapon` switches it on the
    /// same tick, so the shopping trip was pure waste — and once §E10 stopped
    /// unarmed bots from chasing, it became the difference between fighting and
    /// wandering off.
    ///
    /// This exists because the falsification found nothing: reverting the fix on
    /// its own left every test green. The laser fixture only caught it in
    /// combination with the rest of this task, which is not a guard.
    #[test]
    fn a_loaded_gun_in_the_bag_counts_as_armed_even_with_a_dead_one_in_hand() {
        use crate::items::registry::{LASER_PISTOL, PISTOL};

        let setup = |with_spare: bool| {
            let mut w = world_with(&[1, 2]);
            let at = clear_line(&w);
            let y = flat_shelf(&mut w, at, 240);
            let ids: Vec<_> = w.items.iter().map(|i| i.id).collect();
            for id in ids {
                w.items.remove(id);
            }
            if let Some(p) = w.player_mut(1) {
                p.body.pos = Vec2::new(at.x, y);
            }
            if let Some(p) = w.player_mut(2) {
                p.body.pos = Vec2::new(at.x + 120.0, y);
            }
            give(&mut w, 1, LASER_PISTOL, 1);
            if with_spare {
                give(&mut w, 1, PISTOL, 10);
            }
            // The laser in hand, and no charge to fire it: `selected_weapon` is
            // `None` either way, so the two runs differ only by what is in the bag.
            let slot = (0..INVENTORY_SLOTS as u8).find(|s| {
                w.player(1)
                    .and_then(|p| p.inventory.slot(*s))
                    .is_some_and(|st| st.item == LASER_PISTOL)
            });
            if let Some(slot) = slot {
                w.select_slot(1, slot);
            }
            if let Some(p) = w.player_mut(1) {
                p.battery = 0.0;
            }
            // Something on the floor to be tempted by.
            let bait = drop_at(&mut w, MEDKIT, Vec2::new(at.x + 40.0, y));
            let mut b = Bot::new(1, SEED, 0, 0.6);
            b.think(&w, 0.0, SIM_DT);
            assert!(
                b.selected_weapon(&w).is_none(),
                "the fixture armed the bot in hand, so it proves nothing about the bag",
            );
            (b.goal, bait)
        };

        let (with_spare, _) = setup(true);
        assert!(
            matches!(with_spare, Goal::Enemy(2)),
            "a bot with a loaded pistol in the bag went shopping ({with_spare:?}) \
             instead of engaging — it is armed and does not know it",
        );

        // The control: with nothing in the bag it really is unarmed, and then
        // going for the item is correct. Without this the assertion above passes
        // for a bot that always engages.
        let (without, bait) = setup(false);
        assert_eq!(
            without,
            Goal::Item(bait),
            "a genuinely unarmed bot did not go shopping, so the contrast above is \
             not about the spare weapon",
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
        // can exceed `MAX_BLOCKED_SAMPLES * LOS_STEP` (192 px).
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

        // Now wall it off. The tolerance is a **count**: `MAX_BLOCKED_SAMPLES`
        // samples at `LOS_STEP` px is 192 px of rock, so a 160 px wall passes it
        // — which the first version of this test discovered by failing. This one
        // is 300 px along the line, "behind a mountain" rather than "over a
        // hill", and it is derived from the two constants rather than picked.
        let thick = (MAX_BLOCKED_SAMPLES as f32 * LOS_STEP * 1.25) as i32;
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

    /// The control for `a_bot_steps_out_of_fire`.
    ///
    /// "The bot moved away from the patch" also passes for a bot that wanders,
    /// or for one that was walking that way anyway. Same geometry, no fire.
    #[test]
    fn a_bot_with_no_fire_under_it_does_not_walk_away() {
        let mut w = world_with(&[1, 2]);
        let at = clear_line(&w);
        // **No items, and a weapon.** An unarmed bot goes shopping and does not
        // chase (§E10), so with the floor as the generator left it this asserted
        // "walks right" while the bot was actually walking to whichever item
        // happened to be nearest — and T18.04's bigger objects moved that item to
        // the other side, which is how a test that had been passing for the
        // wrong reason since T18.02 finally said so.
        //
        // The claim is that the bot closes on an *enemy*. So the enemy is the
        // only thing to close on, and the bot is armed enough to want to.
        let ids: Vec<_> = w.items.iter().map(|i| i.id).collect();
        for id in ids {
            w.items.remove(id);
        }
        // A **pistol**, not a bazooka: `stand_off` is twice the blast radius, and
        // a bazooka's is ~300 px — so an armed-with-a-bazooka bot is *already at*
        // its firing range against a target 300 px away and correctly presses
        // nothing. A weapon with no blast closes to 40 px, which is the walking
        // this control is about.
        give(&mut w, 1, PISTOL, 10);
        if let Some(p) = w.player_mut(1) {
            p.body.pos = at;
        }
        // Target to the RIGHT, so "walk right" is the wanted behaviour.
        if let Some(p) = w.player_mut(2) {
            p.body.pos = Vec2::new(at.x + 300.0, at.y);
        }
        let mut b = Bot::new(1, SEED, 0, 1.0);
        let inp = b.think(&w, 0.0, SIM_DT);
        // **It does not walk away** — which is what the name says and all the
        // control needs. The claim being controlled for is the paired test's
        // LEFT, so the absence of a LEFT here is exactly what attributes that
        // one to the fire.
        assert_eq!(
            inp.buttons & button::LEFT,
            0,
            "with no fire under it the bot walked away anyway, so `a_bot_steps_out_of_fire` \
             is not evidence that fire is what moved it"
        );
        // And it closes, which is the stronger form of the same control.
        //
        // The RIGHT press used to be asserted here and was dropped when §C20
        // made an armed bot plant itself to shoot rather than close — so "does
        // not walk away" was all that survived. **§F4 repealed §C20**: a bot
        // fires on the move, this one is armed with a pistol whose `stand_off`
        // is 40 px against a target 300 px away, and closing is once again the
        // behaviour. Restored rather than left as prose, because a comment
        // citing a repealed gate to justify a weaker assertion is how the
        // weaker assertion becomes permanent.
        assert_ne!(
            inp.buttons & button::RIGHT,
            0,
            "the bot neither fled nor closed on an enemy 300 px away — with §C20 repealed \
             there is nothing left to keep an armed bot standing still"
        );
    }

    /// §B24's denial measure counts only hazards an **enemy** lit, and that
    /// distinction is the whole point: a bot fleeing its own molotov has denied
    /// ground to nobody, and counting it would score a weapon highest exactly
    /// when it is hurting its user most — which is the mistake T11.09's first
    /// instrument made when it folded self-damage into damage dealt.
    #[test]
    fn deflections_count_only_an_enemy_s_fire() {
        fn deflect_ticks(lit_by: DamageSource) -> u32 {
            let mut w = world_with(&[1, 2]);
            let at = clear_line(&w);
            if let Some(p) = w.player_mut(1) {
                p.body.pos = at;
            }
            if let Some(p) = w.player_mut(2) {
                p.body.pos = Vec2::new(at.x + 300.0, at.y);
            }
            // §F10.2: fire is flames now, so a fixture about standing in fire
            // has to make one. `light_fan` is the same spawn every emitter uses.
            let owner = match lit_by {
                DamageSource::Player { id, .. } => id,
                _ => u8::MAX,
            };
            w.projectiles.spawn_raw(
                crate::items::registry::WEAPON_FLAME,
                owner,
                Vec2::new(at.x + 10.0, at.y),
                Vec2::ZERO,
                0.0,
            );
            let mut b = Bot::new(1, SEED, 0, 1.0);
            b.think(&w, 0.0, SIM_DT);
            b.stats().ticks_hazard_evaded + b.stats().ticks_hazard_blocked
        }

        let enemy = deflect_ticks(DamageSource::Player {
            id: 2,
            weapon: crate::items::registry::WeaponId(0),
        });
        let own = deflect_ticks(DamageSource::Player {
            id: 1,
            weapon: crate::items::registry::WeaponId(0),
        });
        // The control is the first assertion: without it, "own fire counts zero"
        // passes for a counter that is never incremented at all.
        assert_eq!(
            enemy, 1,
            "an enemy's fire moved the bot and was not counted"
        );
        assert_eq!(own, 0, "the bot's own fire was counted as denying ground");
    }

    /// Standing in fire beats reaching the target.
    #[test]
    fn a_bot_steps_out_of_fire() {
        let mut w = world_with(&[1, 2]);
        let at = clear_line(&w);
        // The same setup as its control, so the two differ **only** by the fire.
        let ids: Vec<_> = w.items.iter().map(|i| i.id).collect();
        for id in ids {
            w.items.remove(id);
        }
        give(&mut w, 1, PISTOL, 10);
        if let Some(p) = w.player_mut(1) {
            p.body.pos = at;
        }
        if let Some(p) = w.player_mut(2) {
            p.body.pos = Vec2::new(at.x + 300.0, at.y);
        }
        // Fire slightly to the RIGHT of the bot — the same side as the target,
        // so the target's pull and the hazard's push disagree.
        // §F10.2: a flame, owned by the weather (`u8::MAX`), which is what a
        // vent's fire is.
        w.projectiles.spawn_raw(
            crate::items::registry::WEAPON_FLAME,
            u8::MAX,
            Vec2::new(at.x + 10.0, at.y),
            Vec2::ZERO,
            0.0,
        );
        let mut b = Bot::new(1, SEED, 0, 1.0);
        let inp = b.think(&w, 0.0, SIM_DT);
        assert!(
            inp.buttons & button::LEFT != 0,
            "stood in fire at +10 px and did not move away from it"
        );
        assert!(
            inp.buttons & button::RIGHT == 0,
            "kept walking toward the target through the fire it is standing in"
        );
    }

    /// A zone weapon is dangerous well past its blast radius, which is 0.
    #[test]
    fn a_bot_does_not_throw_a_molotov_at_its_own_feet() {
        let mut w = world_with(&[1, 2]);
        give(&mut w, 1, MOLOTOV, 2);
        wield(&mut w, 1, MOLOTOV);
        let at = clear_line(&w);
        if let Some(p) = w.player_mut(1) {
            p.body.pos = at;
        }
        // Well inside the zone's reach (radius + scatter).
        if let Some(p) = w.player_mut(2) {
            p.body.pos = Vec2::new(at.x + 30.0, at.y);
        }
        let mut b = Bot::new(1, SEED, 0, 1.0);
        let mut fired = false;
        for t in 0..60 {
            if b.think(&w, t as f32 * SIM_DT, SIM_DT).buttons & button::FIRE != 0 {
                fired = true;
                break;
            }
        }
        assert!(
            !fired,
            "threw a molotov at a target 30 px away, inside its own zone: {:?}",
            b.stats()
        );
    }

    /// T11.15, §B26 — the guard the distance test cannot express.
    ///
    /// The target is 260 px away, which the distance guard is happy with (the
    /// control below is the same geometry and it throws). A wall sits 40 px in
    /// front of the thrower, so the arc lands almost immediately, on them.
    ///
    /// The assertion that matters is not "did not throw" — the old guard could
    /// produce that for the wrong reason. It is that **`rej_impact_guard`**
    /// fired: the refusal came from walking the arc, not from measuring the
    /// target.
    #[test]
    fn a_bot_does_not_throw_a_molotov_into_a_wall_in_front_of_it() {
        let mut w = world_with(&[1, 2]);
        give(&mut w, 1, MOLOTOV, 2);
        wield(&mut w, 1, MOLOTOV);
        let at = clear_line(&w);
        if let Some(p) = w.player_mut(1) {
            p.body.pos = at;
        }
        if let Some(p) = w.player_mut(2) {
            p.body.pos = Vec2::new(at.x + 260.0, at.y);
        }
        // A pillar just ahead: high enough that any throw at the target clips it.
        for dx in 40..52 {
            for dy in -90..40 {
                w.map.fill_circle(at.x as i32 + dx, at.y as i32 + dy, 1);
            }
        }
        let mut b = Bot::new(1, SEED, 0, 1.0);
        let mut fired = false;
        for t in 0..120 {
            if b.think(&w, t as f32 * SIM_DT, SIM_DT).buttons & button::FIRE != 0 {
                fired = true;
                break;
            }
        }
        assert!(
            !fired,
            "threw a molotov into a wall 40 px away: {:?}",
            b.stats()
        );
        assert!(
            b.stats().rej_impact_guard > 0,
            "it refused, but not because of the arc — impact guard never fired: {:?}",
            b.stats()
        );
    }

    /// The presence beside that absence: far enough away, it does throw.
    #[test]
    fn a_bot_does_throw_a_molotov_from_a_safe_distance() {
        let mut w = world_with(&[1, 2]);
        give(&mut w, 1, MOLOTOV, 2);
        wield(&mut w, 1, MOLOTOV);
        let at = clear_line(&w);
        if let Some(p) = w.player_mut(1) {
            p.body.pos = at;
        }
        if let Some(p) = w.player_mut(2) {
            p.body.pos = Vec2::new(at.x + 260.0, at.y);
        }
        let mut b = Bot::new(1, SEED, 0, 1.0);
        let mut fired = false;
        for t in 0..120 {
            if b.think(&w, t as f32 * SIM_DT, SIM_DT).buttons & button::FIRE != 0 {
                fired = true;
                break;
            }
        }
        assert!(
            fired,
            "never threw a molotov at a target 260 px away: {:?}",
            b.stats()
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
        wield(&mut w, 1, BAZOOKA);
        let at = clear_line(&w);
        if let Some(p) = w.player_mut(1) {
            p.body.pos = at;
        }
        if let Some(p) = w.player_mut(2) {
            p.body.pos = Vec2::new(at.x + 200.0, at.y);
        }
        // The trigger is left **ready**, unlike under §C20. That gate made a bot
        // stop dead to shoot, so this test had to put the weapon on cooldown to
        // ask about pathing at all; §F4 repealed it, a bot shoots on the move,
        // and the direction choice can now be read straight off a live tick.
        let mut b = Bot::new(1, SEED, 0, 1.0); // perfect skill: no reaction lag
        let inp = b.think(&w, 0.0, SIM_DT);
        assert!(
            inp.buttons & button::RIGHT != 0,
            "did not press right toward a target 200 px to the right"
        );
        assert!(inp.buttons & button::LEFT == 0);
    }

    /// The other side of the same tick: with the trigger ready, the same bot in
    /// the same place **shoots without stopping** (§F4).
    ///
    /// **This replaces `a_bot_that_can_shoot_stands_still_instead_of_closing`**,
    /// which asserted the opposite and was correct until §C20 was repealed. The
    /// pairing survives: one fixture, one difference, so what changed the
    /// behaviour is not in doubt — the bot presses the same direction as the
    /// test above *and* pulls the trigger, where it used to have to choose.
    #[test]
    fn a_bot_that_can_shoot_fires_without_breaking_stride() {
        let mut w = world_with(&[1, 2]);
        give(&mut w, 1, BAZOOKA, 4);
        wield(&mut w, 1, BAZOOKA);
        let at = clear_line(&w);
        if let Some(p) = w.player_mut(1) {
            p.body.pos = at;
        }
        if let Some(p) = w.player_mut(2) {
            p.body.pos = Vec2::new(at.x + 200.0, at.y);
        }
        let mut b = Bot::new(1, SEED, 0, 1.0);
        let inp = b.think(&w, 0.0, SIM_DT);
        // It still closes on the target: the direction is not sacrificed.
        assert_ne!(
            inp.buttons & button::RIGHT,
            0,
            "the bot stopped walking toward a target 200 px to its right — the \
             planting behaviour §F4 removed is still there"
        );
        // And it takes the shot on the same tick. Without this half a bot that
        // walks and never fires passes, which is the §A26 shape the test it
        // replaces already guarded against.
        assert_ne!(
            inp.buttons & button::FIRE,
            0,
            "the bot walked but did not pull the trigger"
        );
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
        wield(&mut w, 1, BAZOOKA);
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

    /// A bot that has closed to a range its own blast guard forbids will stand
    /// there forever. Measured as the largest single rejection reason.
    #[test]
    fn a_bot_holds_at_a_range_it_can_actually_shoot_from() {
        let mut w = world_with(&[1, 2]);
        give(&mut w, 1, BAZOOKA, 4);
        wield(&mut w, 1, BAZOOKA);
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
        wield(&mut w, 1, BAZOOKA);
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
            ticks_hazard_evaded: a.ticks_hazard_evaded + b.ticks_hazard_evaded,
            ticks_hazard_blocked: a.ticks_hazard_blocked + b.ticks_hazard_blocked,
            rej_impact_guard: a.rej_impact_guard + b.rej_impact_guard,
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
                        DeathCause::Weather | DeathCause::Void => r.weather_deaths += 1,
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

/// T11.04 — energy weapons, and the bot selection that makes them usable (§B5).
#[cfg(test)]
mod energy {
    use super::*;
    use crate::items::registry::{self, ItemKind, LASER_PISTOL, PISTOL};
    // No `wield` here: these fixtures select their own slots explicitly — a flat
    // laser *in hand* is the whole premise — so §F5's shovel in slot 0 is stepped
    // past by the test itself.
    use crate::world::{give, RoundPhase, World};

    /// Two bots, each **holding a flat laser** with a loaded pistol in the bag.
    ///
    /// The obvious version of this test — "run a round with lasers in the spawn
    /// pool and assert bots engage" — **does not discriminate**: at a spawn
    /// weight of 10 in a pool of fourteen items, most bots never pick a laser up
    /// in 60 s, so it passes whether or not they can use one. Disabling
    /// `wants_select` left it green, which is how I found out (§B11: ask what a
    /// passing assertion rules out).
    ///
    /// This puts the paperweight in their hands instead. Without selection a bot
    /// is stuck on a weapon it cannot fire for the whole round — T11.02's
    /// measured `ticks_engaged: 0` — and with it, it switches and fights.
    #[test]
    fn a_bot_stuck_on_a_flat_laser_still_fights() {
        // **Eight seeds, not one.** It was seed 4242 alone, and pass 6b moved
        // that map: the four bots on it now never get a shot off at all
        // (`fires 0`), which says something about where scenery put them and
        // nothing about weapon selection. Whether four bots find each other in
        // 60 s is a property of the map; whether they can *use* what they are
        // holding is the claim, and a claim about a population needs more than
        // one draw. Same shape as `most_rounds_see_a_bot_fire` above.
        const SEEDS: [u64; 8] = [1, 7, 42, 99, 4242, 31337, 5, 11];
        let rounds: Vec<_> = SEEDS
            .iter()
            .map(|&seed| harness::run_round_holding(seed, 4, 0.85, 60.0, LASER_PISTOL, PISTOL))
            .collect();

        let dealt = rounds.iter().filter(|r| r.damage_dealt > 0.0).count();
        let fires: u32 = rounds.iter().map(|r| r.stats.fires).sum();
        let rej: u32 = rounds.iter().map(|r| r.stats.rej_unarmed).sum();
        assert!(
            dealt >= SEEDS.len() / 2,
            "bots holding an unusable weapon dealt damage in only {dealt} of {} rounds — \
             they are not switching to the loaded gun in their own inventory \
             (fires {fires}, rej_unarmed {rej})",
            SEEDS.len()
        );

        // The control that makes the count above mean something: a bot that
        // never switched would be refused every shot it tried. Plenty of fires
        // and no wall of `rej_unarmed` is what "it switched" looks like.
        assert!(fires > 0, "no bot fired in any round");
        assert!(
            rej < fires,
            "more shots refused as unarmed ({rej}) than fired ({fires}) — \
             the bots are stuck on the laser after all"
        );
    }

    /// The half that was missing: a bot must be able to move **off** a weapon it
    /// cannot fire. An uncharged laser is a paperweight (§B5), and before
    /// `wants_select` the only thing that changed a selection was a stack running
    /// out — which an energy weapon's stack never does.
    #[test]
    fn a_bot_holding_a_flat_laser_switches_to_a_loaded_gun() {
        let mut w = World::new(4242, crate::constants::MapScale::Small);
        w.set_phase(RoundPhase::Playing);
        w.add_player(0, 0, "bot".into());
        give(&mut w, 0, LASER_PISTOL, 1);
        give(&mut w, 0, PISTOL, 10);
        // Select the laser, then flatten the battery.
        let laser_slot = (0..crate::constants::INVENTORY_SLOTS as u8)
            .find(|s| {
                w.player(0)
                    .and_then(|p| p.inventory.slot(*s))
                    .is_some_and(|st| st.item == LASER_PISTOL)
            })
            .expect("laser slot");
        w.select_slot(0, laser_slot);
        if let Some(p) = w.player_mut(0) {
            p.battery = 0.0;
        }

        let mut bot = Bot::new(0, 4242, 0, 0.85);
        let _ = bot.think(&w, 1.0, crate::constants::SIM_DT);
        let want = bot.wants_select().expect("a flat laser must not be kept");
        let held = w
            .player(0)
            .and_then(|p| p.inventory.slot(want))
            .expect("chosen slot is empty");
        assert_eq!(
            held.item, PISTOL,
            "the bot stayed on a weapon it cannot fire"
        );

        // Control: charge the battery and the laser becomes a candidate again —
        // otherwise this passes for a bot that simply always avoids lasers.
        if let Some(p) = w.player_mut(0) {
            p.battery = crate::constants::BATTERY_MAX;
        }
        let mut bot2 = Bot::new(0, 4242, 0, 0.85);
        let _ = bot2.think(&w, 1.0, crate::constants::SIM_DT);
        let choice = bot2.wants_select().unwrap_or(laser_slot);
        let item = w
            .player(0)
            .and_then(|p| p.inventory.slot(choice))
            .map(|s| s.item);
        assert!(
            item == Some(LASER_PISTOL) || item == Some(PISTOL),
            "a charged bot chose neither of the two weapons it holds: {item:?}"
        );
    }

    /// §B5 exists only if the items can be found. T11.02 shipped the defs with
    /// every weight at zero because bots could not use them; that is now closed.
    #[test]
    fn the_energy_weapons_are_obtainable() {
        for key in ["laser_pistol", "laser_smg"] {
            let d = registry::by_key(key).unwrap_or_else(|| panic!("{key} is not an item"));
            assert!(
                d.spawn_weight > 0 || d.crate_weight > 0 || d.buried_weight > 0,
                "{key} can never be obtained — §B5's whole branch is dead weight"
            );
            let ItemKind::Weapon(wid) = d.kind else {
                panic!("{key} is not a weapon")
            };
            let w = crate::weapons::defs::def(wid).expect("weapon def");
            assert!(w.is_energy(), "{key} does not cost battery");
        }
        // The battery must be findable too, or the weapons that need it are not.
        let b = registry::by_key("battery_pack").expect("battery pack");
        assert!(b.spawn_weight > 0, "no charge on the ground");
    }
}

#[cfg(test)]
mod bots_already_throw_what_they_carry {
    use super::*;
    use crate::constants::{MapScale, SIM_DT};
    use crate::items::registry::GRENADE;
    // No `wield` here on purpose: this module is about what the bot *asks* to
    // select, so the shovel §F5 puts in slot 0 is part of the question rather
    // than something the fixture should reach past.
    use crate::world::{give, RoundPhase, World};

    /// T14.04 asks whether bots need §C11's quick-throw "or they carry grenades
    /// they never throw", and to **check rather than assume** (§B19). Checked:
    /// they do not.
    ///
    /// `choose_weapon` scans every slot and scores by damage per second, with no
    /// filter on delivery kind — a grenade is scored exactly like a rocket — and
    /// the bot then asks for that slot via `select_slot` and fires it through the
    /// ordinary path. Giving bots a second route to the same act would be two
    /// mechanisms for one job, which is how they drift.
    ///
    /// This test is the evidence, and it is here so that a future change to
    /// `choose_weapon` that starts skipping thrown weapons fails loudly instead of
    /// quietly leaving bots with pockets full of grenades.
    #[test]
    fn a_bot_carrying_only_a_grenade_asks_to_select_it() {
        let mut w = World::new(4242, MapScale::Small);
        w.set_phase(RoundPhase::Playing);
        w.add_player(0, 0, "bot".into());
        w.add_player(1, 0, "target".into());
        give(&mut w, 0, GRENADE, 3);
        for _ in 0..120 {
            w.step(SIM_DT);
        }

        // Put the target within reach, so the bot has something to choose *for*.
        let at = w.player(0).expect("bot").body.pos;
        if let Some(t) = w.player_mut(1) {
            t.body.pos = Vec2::new(at.x + 140.0, at.y);
        }

        let mut bot = Bot::new(0, 4242, 0, 1.0);
        let mut asked = None;
        for _ in 0..60 {
            bot.think(&w, w.round_time, SIM_DT);
            if let Some(slot) = bot.wants_select() {
                asked = Some(slot);
                break;
            }
        }

        let held = w
            .player(0)
            .expect("bot")
            .inventory
            .iter()
            .find(|(_, s)| s.item == GRENADE)
            .map(|(slot, _)| slot);
        assert!(held.is_some(), "the fixture never gave the bot a grenade");
        // Either it asked for the grenade's slot, or it was already selected —
        // `choose_weapon` only reports a *change*.
        let selected = w.player(0).expect("bot").inventory.selected();
        assert!(
            asked == held || Some(selected) == held,
            "the bot neither selected nor asked for its grenade: asked {asked:?}, \
             selected {selected}, grenade in {held:?}",
        );
    }
}
