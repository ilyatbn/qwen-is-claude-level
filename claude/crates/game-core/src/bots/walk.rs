//! The walking model — how a bot on legs or wings turns its goal into buttons, and
//! what it does when it is stuck (the hop, the winged sweep). Split out of
//! `bots/mod.rs` by T22.14B, unchanged; `space.rs` is the flying model it hands over to.

use super::{space, Bot, Goal};
use crate::constants::{
    GravityMode, BOT_HAZARD_CLEARANCE, BOT_HAZARD_LOOKAHEAD, BOT_JETPACK_RISE, BOT_STUCK_PX,
    BOT_STUCK_WINDOW, BOT_WANDER_GIVE_UP, BOT_WINGED_SWEEP_LEGS, JETPACK_MAX_FUEL, PICKUP_RADIUS,
    STEP_UP, WINGS_FLY_SPEED,
};
use crate::math::Vec2;
use crate::player::input::button;
use crate::player::state::PlayerState;
use crate::world::World;

/// Would a winged sweep leg pressing `b` (UP or DOWN) from `pos` head somewhere that
/// kills — the void (`World::body_in_the_void`, the world's own test) or a space
/// keep-out (`space::forbidden`: the black hole's reach, a vortex's pull or mouth)?
/// Probed one window's flight along the leg, the distance a first leg covers.
fn leg_barred(world: &World, pos: Vec2, b: u8) -> bool {
    let reach = WINGS_FLY_SPEED * BOT_STUCK_WINDOW;
    let at = pos + Vec2::new(0.0, if b == button::UP { -reach } else { reach });
    world.body_in_the_void(&crate::physics::body::Body::new(at)) || space::forbidden(world, at)
}

/// The wings' buttons for a unit heading (T22.14B M4): each axis pressed when the
/// heading leans on it by more than `sin 22.5°`, so the eight turns `space::escape`
/// sweeps map onto the eight button pairs.
fn wing_buttons(dir: Vec2) -> u8 {
    let lean = (std::f32::consts::PI / 8.0).sin();
    let mut b = 0u8;
    if dir.x > lean {
        b |= button::RIGHT;
    } else if dir.x < -lean {
        b |= button::LEFT;
    }
    if dir.y < -lean {
        b |= button::UP;
    } else if dir.y > lean {
        b |= button::DOWN;
    }
    b
}

/// T22.03F: which leg of a stuck winged bot's outward vertical sweep `t` seconds
/// in — leg `k` lasts `(k + 1) × BOT_STUCK_WINDOW`, so legs alternate up/down and
/// each reaches one window past the last one's start.
fn winged_sweep_leg(t: f32) -> u32 {
    let (mut k, mut end) = (0u32, BOT_STUCK_WINDOW);
    while t >= end {
        k += 1;
        end += (k + 1) as f32 * BOT_STUCK_WINDOW;
    }
    k
}

impl Bot {
    /// This tick's movement buttons from the walking model (and, for a winged bot in
    /// space, its keep-outs), before `space::steer` replaces them for a body that flies.
    pub(super) fn walk_buttons(
        &mut self,
        world: &World,
        me: &PlayerState,
        pos: Vec2,
        aim_at: Vec2,
        now: f32,
        dt: f32,
    ) -> u8 {
        let mut buttons = 0u8;

        // --- move -------------------------------------------------------
        // T22.14B M4: **a winged bot in space closes only to the nearest point outside a
        // keep-out** (`space::approach`, the flying model's), not onto an enemy beside a
        // vortex. Everywhere else — and always under gravity, where there are no
        // keep-outs — it walks for the goal itself. Fleeing is away from it, never onto it.
        let winged = me.move_mods().flying;
        let wing_space =
            winged && world.gravity == GravityMode::Space && me.mount.mounted.is_none();
        let move_to = if wing_space && !matches!(self.goal, Goal::Flee(_)) {
            space::approach(world, pos, aim_at)
        } else {
            aim_at
        };
        let dx = move_to.x - pos.x;
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
            let stop_within = self.stop_within(world);
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
        if let Some(h) = self.hazard_at(world, pos, BOT_HAZARD_CLEARANCE) {
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
                        BOT_HAZARD_LOOKAHEAD
                    } else {
                        -BOT_HAZARD_LOOKAHEAD
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

        // T22.03I F4: a winged bot that gave its way up hovers instead of pressing.
        if winged && now < self.sweep_refused_until {
            buttons &= !(button::LEFT | button::RIGHT);
        }

        // Stuck against a wall: pressing a direction and going nowhere.
        //
        // **A winged bot measures its displacement over each `BOT_STUCK_WINDOW`** from the
        // window's start (T22.03I F4). The test compared one tick's movement with
        // `BOT_STUCK_PX`, which
        // wings (3.3 px a tick) never reach: 74 % of winged "stuck" ticks in space
        // were moving faster than 100 px/s, and the sweep below zig-zagged bots across
        // open air. **A walking bot keeps the per-tick test** — a walk (2.5 px a tick)
        // never reaches it either, so it hops every `BOT_STUCK_WINDOW` while it walks, and
        // that is load-bearing and not re-measured here: moving walkers to the window
        // turned `a_hurt_bot_breaks_contact_and_a_healthy_one_holds_its_ground` red (a
        // bot at the map's edge sampled grounded instead of mid-hop). Filed in T22.03I.
        // (A first cut measured from where it last moved `BOT_STUCK_PX` instead; a bot
        // sliding a few px a second along a face then resets every few windows and
        // never reaches the long legs. The window is what `BOT_STUCK_PX`'s doc says.)
        let pressing = buttons & (button::LEFT | button::RIGHT) != 0;
        if !pressing {
            self.still_for = 0.0;
            self.stuck_window = 0.0;
            self.stuck_from = pos.x;
        } else if winged {
            self.still_for += dt;
            self.stuck_window += dt;
            if self.stuck_window >= BOT_STUCK_WINDOW {
                if (pos.x - self.stuck_from).abs() >= BOT_STUCK_PX {
                    self.still_for = 0.0;
                }
                self.stuck_window = 0.0;
                self.stuck_from = pos.x;
            }
        } else {
            if (pos.x - self.stuck_from).abs() < BOT_STUCK_PX {
                self.still_for += dt;
            } else {
                self.still_for = 0.0;
            }
            self.stuck_from = pos.x;
        }

        let rise = pos.y - move_to.y; // positive when the target is above
        let stuck = self.still_for > BOT_STUCK_WINDOW;
        let wants_jump = stuck || (rise > STEP_UP as f32 && me.body.grounded);
        if wants_jump {
            buttons |= button::JUMP;
            // A winged bot keeps its stuck time: its way over is held, below.
            if !winged {
                self.still_for = 0.0;
            }
        }

        // Jetpack for a real climb, and only with fuel to spare — a bot that
        // empties its tank hovering is a bot that cannot escape.
        if rise > BOT_JETPACK_RISE && me.jetpack.fuel > JETPACK_MAX_FUEL * 0.5 {
            buttons |= button::JUMP | button::UP;
        } else if rise < -BOT_JETPACK_RISE * 2.0 && !me.body.grounded {
            buttons |= button::DOWN;
        }
        // **T22.03F: the stuck-jump is refused while the wings are held, so a winged
        // bot's way over a wall is the wings' own — UP, held for as long as it stays
        // stuck** (still pressing sideways and not moving). T21.03's note here expected
        // it to "walk out sideways"; traced, it pressed RIGHT into rock for the rest of
        // the round — 3–10 runs ≥ 10 s per 32-seed draw in *both* modes, to 152 s —
        // so this is the walking model's, not `space::steer`'s (R5 keeps wings "as
        // anywhere"). The sideways press stays: it rises along the face and moves off
        // the top, which resets `still_for` and releases UP. **Under an overhang UP is
        // blocked too** (traced after the first cut: JUMP|UP|RIGHT held under rock,
        // runs to 73 s), so the vertical press **sweeps outward**: up for one
        // `BOT_STUCK_WINDOW`, down for two, up for three — each leg one window longer,
        // so the search reaches past the start in both directions and a face of any
        // height is eventually rounded.
        if winged && stuck {
            self.stats.ticks_winged_stuck += 1;
            if me.body.vel.x.abs() > WINGS_FLY_SPEED * 0.5 {
                self.stats.ticks_winged_stuck_moving += 1;
            }
            buttons &= !(button::UP | button::DOWN);
            let leg = winged_sweep_leg(self.still_for - BOT_STUCK_WINDOW);
            if leg >= BOT_WINGED_SWEEP_LEGS {
                // T22.03I F4: **a way up that is not there is given up** — a closed
                // pocket swept forever before. A wander cell is marked tried; any other
                // goal is left alone for `BOT_WANDER_GIVE_UP`, hovering, then tried again.
                self.sweep_refused_until = now + BOT_WANDER_GIVE_UP;
                self.still_for = 0.0;
                self.stuck_window = 0.0;
                self.stuck_from = pos.x;
                if self.goal == Goal::Wander {
                    self.wander_for = BOT_WANDER_GIVE_UP;
                }
                buttons &= !(button::LEFT | button::RIGHT);
            } else {
                // And the legs keep out of what kills (T22.03I F4): a leg into the
                // void or a keep-out disc is swapped for the other; both barred, none.
                let (first, second) = if leg.is_multiple_of(2) {
                    (button::UP, button::DOWN)
                } else {
                    (button::DOWN, button::UP)
                };
                buttons |= [first, second]
                    .into_iter()
                    .find(|&b| !leg_barred(world, pos, b))
                    .unwrap_or(0);
            }
        }

        // T22.14B M4: **and a winged bot in space leaves what kills the way a flying one
        // does** — the same `space::escape` (the black hole's reach, a vortex's pull or
        // capture, a flare's ribbon, a fire), its heading pressed on the wings' four
        // buttons (UP rises and DOWN descends under wings, with no fuel). Before, its only
        // guard was `leg_barred` on the sweep's legs: it walked onto an enemy standing in a
        // vortex's mouth and was taken (`a_winged_bot_in_space_keeps_out_of_a_vortex`).
        if wing_space {
            let fire = self
                .hazard_at(world, pos, BOT_HAZARD_CLEARANCE)
                .map(|h| h.pos);
            if let Some(out) = space::escape(world, pos, me.body.vel, fire) {
                buttons &=
                    !(button::LEFT | button::RIGHT | button::UP | button::DOWN | button::JUMP);
                buttons |= wing_buttons(out);
            }
        }
        buttons
    }

    /// How near the walking model closes on its goal along `dx` (T22.03I F1: one
    /// function, so the rule has a unit — `the_walking_stop_is_the_weapons_range_only_for_an_enemy`).
    ///
    /// An item is walked onto. Everything else holds at a range the weapon can
    /// actually be fired at: closing to a flat 40 px walked bazooka-armed bots inside
    /// their own blast guard (blast_radius * 1.5 = 63 px), where the rule that stops
    /// them suiciding also stopped them shooting — measured as the single largest
    /// rejection reason, 8469 against 91 shots taken.
    ///
    /// **Inside the weapon's range only for an enemy** (T22.03H, narrowed by T22.03I
    /// F1): `hold_off` exists to put a swing in reach, and a wander cell is not
    /// something to swing at. On the wander arm it walked bots with a shovel in hand
    /// 19 px nearer each cell's middle — over pits — and standard void deaths rose
    /// 363 → 424 over four 32-seed draws (369 of the 424 shovel-selected, not engaged).
    /// `space_bots_report` bounds it (`STANDARD_VOID_MAX`).
    fn stop_within(&self, world: &World) -> f32 {
        match self.goal {
            Goal::Item(_) => PICKUP_RADIUS * 0.5,
            Goal::Enemy(_) => self.hold_off(world),
            Goal::Wander | Goal::Flee(_) => self.stand_off(world),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::super::tests::*;
    use super::*;

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

    /// **T22.03I F4: a winged bot crossing open air never counts itself stuck.** The
    /// stuck test compared one tick's movement with `BOT_STUCK_PX` (6 px), and wings fly
    /// 3.3 px a tick — so a winged bot half a second into any sideways flight "was
    /// stuck" and swept up and down across open air (74 % of winged stuck ticks in
    /// space moving over 100 px/s). The control: it really did cross (≥ half the gap),
    /// so zero stuck ticks is not a bot that never pressed. Both gravities.
    #[test]
    fn a_winged_bot_crossing_open_air_never_sweeps() {
        use crate::items::registry::UNICORN_WINGS;
        for gravity in [GravityMode::Standard, GravityMode::Space] {
            let mut w = world_with(&[1, 2]);
            w.gravity = gravity;
            let at = clear_line(&w);
            let ids: Vec<_> = w.items.iter().map(|i| i.id).collect();
            for id in ids {
                w.items.remove(id);
            }
            let y = flat_shelf(&mut w, at, 240);
            let gap = 200.0;
            if let Some(p) = w.player_mut(1) {
                p.body.pos = Vec2::new(at.x, y - PLAYER_H);
                p.body.grounded = false;
            }
            if let Some(p) = w.player_mut(2) {
                p.body.pos = Vec2::new(at.x + gap, y);
            }
            give(&mut w, 1, UNICORN_WINGS, 1);
            give(&mut w, 1, PISTOL, 10);
            let mut b = Bot::new(1, SEED, 0, 0.6);
            for t in 0..(2 * crate::constants::SIM_HZ) {
                let inp = b.think(&w, t as f32 * SIM_DT, SIM_DT);
                w.queue_input(1, inp);
                if let Some(p) = w.player_mut(2) {
                    p.health = 100.0;
                }
                w.step(SIM_DT);
                let _ = w.drain_events();
            }
            let crossed = w.player(1).unwrap().body.pos.x - at.x;
            assert!(
                crossed >= gap * 0.5,
                "{gravity:?} control: it crossed only {crossed:.0} px"
            );
            assert_eq!(
                b.stats().ticks_winged_stuck,
                0,
                "{gravity:?}: a winged bot flying {crossed:.0} px across open air swept as if stuck"
            );
        }
    }

    /// **T22.03I F4: a sweep leg does not head into what kills.** A leg DOWN from just
    /// above the map's bottom is barred (the void) and UP from there is not; in a
    /// space round, a leg toward a live vortex's keep-out disc is barred and the other
    /// way is not — the same `space::forbidden` the flying model steers by.
    #[test]
    fn a_winged_sweep_leg_keeps_out_of_the_void_and_the_keep_outs() {
        let w = world_with(&[1]);
        let low = Vec2::new(w.map.mask.w as f32 * 0.5, w.map.mask.h as f32 - PLAYER_H);
        assert!(
            leg_barred(&w, low, button::DOWN),
            "a leg into the void was allowed"
        );
        assert!(
            !leg_barred(&w, low, button::UP),
            "control: the leg away from it was barred too"
        );

        let mut w = World::with_gravity(
            SEED,
            MapScale::Small,
            0,
            crate::constants::DEFAULT_MAP_GENERATOR,
            GravityMode::Space,
        );
        w.set_phase(RoundPhase::Playing);
        let geo = w.map.space_geometry().expect("space");
        // T22.14B M5: a live vortex's keep-out is the reach of its pull — the vortex a
        // reach above the centre, so the leg away from it stays inside the arena.
        let v = Vec2::new(geo.cx, geo.cy - crate::constants::VORTEX_REACH);
        let mut seq = 0;
        let _ = crate::world::vortex::open(&mut w.vortices, &mut seq, v);
        let below = v + Vec2::new(
            0.0,
            crate::constants::VORTEX_REACH + WINGS_FLY_SPEED * BOT_STUCK_WINDOW,
        );
        assert!(
            leg_barred(&w, below, button::UP),
            "a leg into a vortex's pull was allowed"
        );
        assert!(
            !leg_barred(&w, below, button::DOWN),
            "control: the leg away from the vortex was barred"
        );
    }

    /// **T22.03I F4: a winged bot shut in a closed pocket gives the way up within a
    /// bound** — it swept up and down for the rest of the round before. A cavity two
    /// body heights tall in a block of rock, the enemy outside it: the bot presses
    /// toward the enemy, is stuck, sweeps its `BOT_WINGED_SWEEP_LEGS` legs, and then stops
    /// pressing. The control: it did press and sweep first. Both gravities.
    /// **T22.14B M4: a winged bot in space keeps out of a vortex.** Wings walk the
    /// walking model in every mode (R5), and in space nothing kept that model out of what
    /// kills: sent at an enemy standing by a vortex's mouth it closed to its stand-off, in
    /// the pull, and was drawn in. Now it leaves the pull (`space::escape`, on the wings'
    /// buttons) and holds outside it (`space::approach`). Both sides of the vortex, 8 s
    /// each; the enemy is put back beside the mouth every tick. Control: the same bot with
    /// the vortex gone reaches the enemy — the goal is live.
    #[test]
    fn a_winged_bot_in_space_keeps_out_of_a_vortex() {
        use crate::constants::{VORTEX_CAPTURE_R, VORTEX_REACH};
        use crate::items::registry::UNICORN_WINGS;
        // (trips, nearest to the vortex, where it ended, where it started)
        let run = |side: f32, with_vortex: bool| -> (u32, f32, f32, f32) {
            let mut w = World::with_gravity(
                SEED,
                MapScale::Small,
                0,
                crate::constants::DEFAULT_MAP_GENERATOR,
                GravityMode::Space,
            );
            w.set_phase(RoundPhase::Playing);
            w.add_player(1, 0, "bot".into());
            w.add_player(2, 0, "enemy".into());
            let _ = w.drain_events();
            let geo = w.map.space_geometry().expect("space");
            let v = Vec2::new(geo.cx, geo.cy);
            if with_vortex {
                let mut seq = 0;
                let _ = crate::world::vortex::open(&mut w.vortices, &mut seq, v);
            }
            // Where the pull (capped, `SPACE_WELL_ACCEL_MAX`) is under what wings fly
            // against: nearer, a winged body pressing away is still drawn in (measured
            // at the half-reach: 13 px/s² net inward — filed, a world question, not a
            // bot's). The enemy is just outside the capture radius, on the bot's side.
            let start = v + Vec2::new(side * 0.75 * VORTEX_REACH, 0.0);
            let enemy = v + Vec2::new(side * (VORTEX_CAPTURE_R + PLAYER_H), 0.0);
            if let Some(p) = w.player_mut(1) {
                p.body = crate::physics::body::Body::new(start);
            }
            give(&mut w, 1, UNICORN_WINGS, 1);
            give(&mut w, 1, PISTOL, 10);
            let mut b = Bot::new(1, SEED, 0, 0.6);
            let (mut trips, mut nearest) = (0u32, f32::INFINITY);
            for t in 0..(8 * crate::constants::SIM_HZ) {
                if let Some(p) = w.player_mut(2) {
                    p.body = crate::physics::body::Body::new(enemy);
                    p.health = 100.0;
                }
                let inp = b.think(&w, t as f32 * SIM_DT, SIM_DT);
                w.queue_input(1, inp);
                w.step(SIM_DT);
                for e in w.drain_events() {
                    if matches!(e, crate::world::GameEvent::VortexTrip { id: 1, .. }) {
                        trips += 1;
                    }
                }
                if let Some(p) = w.player(1) {
                    nearest = nearest.min((p.body.pos - v).len());
                }
            }
            let p = w.player(1).expect("bot");
            assert!(
                p.move_mods().flying,
                "premise: the bot kept its wings (side {side})"
            );
            (trips, nearest, (p.body.pos - v).len(), (start - v).len())
        };
        let mut bad = Vec::new();
        for side in [-1.0, 1.0] {
            let (trips, nearest, end, from) = run(side, true);
            if trips > 0 || nearest < from - PLAYER_H || end < VORTEX_REACH {
                bad.push((side, trips, nearest, end, from));
            }
            let (_, reached, ..) = run(side, false);
            assert!(
                reached < VORTEX_CAPTURE_R + PLAYER_H,
                "control (side {side}): with no vortex it never closed on the enemy \
                 (nearest {reached:.0} px to where the vortex was)"
            );
        }
        assert!(
            bad.is_empty(),
            "(side, trips, nearest to the vortex, where it ended, where it started) — a winged \
             bot went into a vortex's pull, or did not leave it: {bad:?}"
        );
    }

    #[test]
    fn a_winged_bot_in_a_closed_pocket_gives_up_within_a_bound() {
        use crate::items::registry::UNICORN_WINGS;
        // Stuck after one window, four legs of 1..=4 windows: 5.5 s; a second's slack.
        let bound =
            BOT_STUCK_WINDOW * (1.0 + (1..=BOT_WINGED_SWEEP_LEGS).sum::<u32>() as f32) + 1.0;
        for gravity in [GravityMode::Standard, GravityMode::Space] {
            let mut w = world_with(&[1, 2]);
            w.gravity = gravity;
            let at = clear_line(&w);
            let ids: Vec<_> = w.items.iter().map(|i| i.id).collect();
            for id in ids {
                w.items.remove(id);
            }
            let (x, y) = (at.x as i32, at.y as i32);
            let (half_w, half_h) = (PLAYER_H as i32, PLAYER_H as i32);
            for row in (y - 4 * half_h)..(y + 4 * half_h) {
                w.map.mask.set_run(row, x - 4 * half_w, x + 4 * half_w);
            }
            for row in (y - half_h)..(y + half_h) {
                w.map.mask.clear_run(row, x - half_w, x + half_w);
            }
            w.map.coarse = crate::map::coarse::CoarseGrid::build(&w.map.mask);
            if let Some(p) = w.player_mut(1) {
                p.body.pos = Vec2::new(at.x, at.y);
                p.body.grounded = false;
            }
            if let Some(p) = w.player_mut(2) {
                p.body.pos = Vec2::new(at.x + 240.0, at.y);
            }
            give(&mut w, 1, UNICORN_WINGS, 1);
            give(&mut w, 1, PISTOL, 10);
            let mut b = Bot::new(1, SEED, 0, 0.6);
            let (mut pressed_after, mut pressed_before) = (0u32, 0u32);
            let end = bound + 2.0;
            for t in 0..((end / SIM_DT) as u32) {
                let now = t as f32 * SIM_DT;
                let inp = b.think(&w, now, SIM_DT);
                let sideways = inp.buttons & (button::LEFT | button::RIGHT) != 0;
                if now < bound {
                    pressed_before += u32::from(sideways);
                } else {
                    pressed_after += u32::from(sideways);
                }
                w.queue_input(1, inp);
                if let Some(p) = w.player_mut(2) {
                    p.health = 100.0;
                    p.body.pos = Vec2::new(at.x + 240.0, at.y);
                }
                w.step(SIM_DT);
                let _ = w.drain_events();
            }
            assert!(
                pressed_before > 0 && b.stats().ticks_winged_stuck > 0,
                "{gravity:?} control: it never pressed toward the enemy ({pressed_before}) or \
                 never swept ({})",
                b.stats().ticks_winged_stuck
            );
            assert_eq!(
                pressed_after, 0,
                "{gravity:?}: still pressing into the pocket's wall {bound:.1} s in"
            );
        }
    }

    /// **T22.03F: a winged bot pressed against a wall rises over it.** The stuck
    /// response is a jump, and wings refuse the jump — so a winged bot hovering
    /// against rock kept pressing sideways for the rest of the round (traced: RIGHT
    /// held, still, touching rock; runs ≥ 10 s in *both* modes, to 152 s). A wall
    /// taller than a step sits between the bot and an enemy on a flat shelf; the bot
    /// hovers against it. It must get past it. The control: the same bot with no
    /// wall reaches the far side — so a red here is the wall, not a bot that never
    /// moves. Both gravities, since the walking model drives wings in both (R5).
    #[test]
    fn a_winged_bot_against_a_wall_rises_over_it() {
        use crate::items::registry::UNICORN_WINGS;
        for gravity in [GravityMode::Standard, GravityMode::Space] {
            let run = |wall: bool| {
                let mut w = world_with(&[1, 2]);
                w.gravity = gravity;
                let at = clear_line(&w);
                let ids: Vec<_> = w.items.iter().map(|i| i.id).collect();
                for id in ids {
                    w.items.remove(id);
                }
                let y = flat_shelf(&mut w, at, 240);
                let wall_x = at.x as i32 + 60;
                if wall {
                    // Three body heights tall, standing on the shelf.
                    let floor = y as i32 + PLAYER_H as i32 / 2 + 1;
                    for row in (floor - 3 * PLAYER_H as i32)..floor {
                        w.map.mask.set_run(row, wall_x, wall_x + 16);
                    }
                    w.map.coarse = crate::map::coarse::CoarseGrid::build(&w.map.mask);
                }
                // Hovering just off the shelf, clear of the wall's left face.
                if let Some(p) = w.player_mut(1) {
                    p.body.pos = Vec2::new(at.x, y - 4.0);
                    p.body.grounded = false;
                }
                if let Some(p) = w.player_mut(2) {
                    p.body.pos = Vec2::new(at.x + 200.0, y);
                }
                give(&mut w, 1, UNICORN_WINGS, 1);
                give(&mut w, 1, PISTOL, 10);
                assert!(
                    w.player(1).unwrap().move_mods().flying,
                    "the fixture bot has no wings"
                );
                let mut b = Bot::new(1, SEED, 0, 0.6);
                let mut furthest = f32::MIN;
                for t in 0..(4 * crate::constants::SIM_HZ) {
                    let now = t as f32 * SIM_DT;
                    let inp = b.think(&w, now, SIM_DT);
                    w.queue_input(1, inp);
                    if let Some(p) = w.player_mut(2) {
                        p.health = 100.0;
                    }
                    w.step(SIM_DT);
                    let _ = w.drain_events();
                    furthest = furthest.max(w.player(1).unwrap().body.pos.x);
                }
                furthest - (wall_x + 16) as f32
            };
            let past = run(false);
            assert!(
                past > 0.0,
                "{gravity:?} control: no wall, and it never got there"
            );
            let past = run(true);
            assert!(
                past > 0.0,
                "{gravity:?}: a winged bot against a wall {} px tall never got past it \
                 ({past:.1} px short)",
                3 * PLAYER_H as i32
            );
        }
    }

    /// **T22.03I F1: the walking model closes to the weapon's range only on an
    /// enemy.** T22.03H's `hold_off` served the wander arm too, and a bot with the
    /// shovel in hand walked 19 px nearer every wander cell's middle — standard void
    /// deaths 363 → 424 over four draws. The control is that the two distances differ
    /// for the shovel at all (`hold_off` < `stand_off`), so the wander arm's equality is
    /// the rule and not the weapon; and the enemy arm still gets the reach.
    #[test]
    fn the_walking_stop_is_the_weapons_range_only_for_an_enemy() {
        use crate::items::registry::SHOVEL;
        let w = world_with(&[1, 2]);
        assert!(
            w.player(1).is_some_and(|p| p
                .inventory
                .slot(p.inventory.selected())
                .is_some_and(|s| s.item == SHOVEL)),
            "fixture: the bot does not start with the shovel in hand"
        );
        let mut b = Bot::new(1, SEED, 0, 1.0);
        let (hold, stand) = (b.hold_off(&w), b.stand_off(&w));
        assert!(
            hold < stand,
            "control: the shovel's range ({hold}) is not inside the stand-off ({stand}), so \
             the arms below cannot tell the two apart"
        );
        b.goal = Goal::Wander;
        assert_eq!(
            b.stop_within(&w),
            stand,
            "a wandering bot closed to the shovel's reach"
        );
        b.goal = Goal::Enemy(2);
        assert_eq!(
            b.stop_within(&w),
            hold,
            "an engaged bot no longer closes to its reach"
        );
    }

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
}
