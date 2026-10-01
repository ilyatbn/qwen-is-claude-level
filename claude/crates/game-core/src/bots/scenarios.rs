//! T23.26 D — the route planner in the real simulation (`docs/78` §A2): carved
//! fixtures, never the generator's luck, each with its control — the same fixture with
//! the route planted out (`Bot::without_routes`, the greedy walking model alone),
//! which is red where the planner is the reason it worked.
//!
//! Every bot here is unarmed but for its shovel, so its goal is the one pistol on the
//! floor (§E10's "arm first") and the scenario is the only way to it.

use super::nav::tests::{block, fill, seal, stand_at};
use super::tests::*;
use crate::constants::{BOT_NAV_CELL, BOT_WANDER_GIVE_UP, SIM_HZ};
use crate::map::gen::traversal::JUMP_HEIGHT;
use crate::player::state::PlayerId;

/// How long a scenario gets: twice the wander give-up — far over any route here, and a
/// bound a greedy bot pressing into rock never beats.
const SCENARIO_S: f32 = 2.0 * BOT_WANDER_GIVE_UP;

/// The fixture's world: the carved block, the bot alone in it, no item but `pistol_at`.
fn scenario(w: &mut World, bot_at: (i32, i32), pistol_at: (i32, i32)) -> (PlayerId, u32) {
    w.set_phase(RoundPhase::Playing);
    w.add_player(1, 0, "bot".into());
    let _ = w.drain_events();
    let ids: Vec<_> = w.items.iter().map(|i| i.id).collect();
    for id in ids {
        w.items.remove(id);
    }
    if let Some(p) = w.player_mut(1) {
        p.body = crate::physics::body::Body::new(stand_at(bot_at.0, bot_at.1));
    }
    let gun = drop_at(w, PISTOL, stand_at(pistol_at.0, pistol_at.1));
    (1, gun)
}

/// Run the scenario; `(picked the pistol up, dig swings, furthest x reached)`.
fn play(mut w: World, routes: bool) -> (bool, u32, f32) {
    let mut bots = vec![Bot::new(1, SEED, 0, 0.6)];
    if !routes {
        bots[0] = Bot::new(1, SEED, 0, 0.6).without_routes();
    }
    let mut furthest = f32::MIN;
    for t in 0..((SCENARIO_S * SIM_HZ as f32) as u32) {
        crate::bots::drive(&mut w, &mut bots, t as f32 * SIM_DT, SIM_DT);
        w.step(SIM_DT);
        let _ = w.drain_events();
        let p = w.player(1).expect("bot");
        furthest = furthest.max(p.body.pos.x);
        if p.inventory.count_of(PISTOL) > 0 {
            return (true, bots[0].stats().dig_swings, furthest);
        }
    }
    (false, bots[0].stats().dig_swings, furthest)
}

/// **D1: a wall three jumps high is flown over.** A room, the bot at the foot of a wall
/// `3 × JUMP_HEIGHT` tall and eight cells thick (so digging it is dearer than the
/// climb), the pistol beyond it. It gets the pistol, and without digging. Control: the
/// greedy model alone presses into the wall and hops for the whole bound.
#[test]
fn a_wall_three_jumps_high_is_jetted_over() {
    let rows = (3.0 * JUMP_HEIGHT / BOT_NAV_CELL).ceil() as i32;
    let make = || {
        let (mut w, ox, oy) = block(MapScale::Small, 30, rows + 9);
        let floor = oy + rows + 7;
        fill(&mut w, ox + 1, oy + 1, ox + 28, floor - 1, false);
        fill(&mut w, ox + 12, floor - rows, ox + 19, floor - 1, true);
        seal(&mut w);
        let _ = scenario(&mut w, (ox + 8, floor - 1), (ox + 24, floor - 1));
        w
    };
    let (got, digs, _) = play(make(), true);
    assert!(
        got,
        "a bot never got over a {rows}-cell wall to the pistol in {SCENARIO_S} s"
    );
    assert_eq!(
        digs, 0,
        "it dug a wall eight cells thick instead of flying it"
    );
    let (got, _, _) = play(make(), false);
    assert!(
        !got,
        "control: the greedy model got over the wall without a route"
    );
}

/// **D2: a sealed cave is dug out of.** The bot in a pocket closed by three cells of
/// rock on every side, the pistol in open ground beyond. It digs out and gets it.
/// Control: the greedy model presses at the pocket's wall for the whole bound.
#[test]
fn a_bot_in_a_sealed_cave_digs_out() {
    let make = || {
        let (mut w, ox, oy) = block(MapScale::Small, 30, 22);
        // The pocket.
        fill(&mut w, ox + 4, oy + 8, ox + 8, oy + 11, false);
        // The open ground, three cells of rock away.
        fill(&mut w, ox + 12, oy + 1, ox + 28, oy + 19, false);
        seal(&mut w);
        let _ = scenario(&mut w, (ox + 6, oy + 11), (ox + 16, oy + 19));
        w
    };
    let (got, digs, _) = play(make(), true);
    assert!(
        got && digs > 0,
        "a sealed-in bot did not dig out to the pistol ({digs} swings)"
    );
    let (got, _, _) = play(make(), false);
    assert!(!got, "control: the greedy model left a sealed cave");
}

/// **D3: a thin wall is dug through and a thick one is gone round** — in the simulation,
/// the planner's own test (`nav::tests::a_thin_wall_is_dug_through_and_a_thick_one_is_gone_round`)
/// played out: both reach the pistol, the thin one by digging, the thick one without a
/// swing. Control: the greedy model reaches neither.
#[test]
fn a_thin_wall_is_dug_and_a_thick_one_is_gone_round_in_play() {
    let make = |thick: i32| {
        let cols = 8 + thick;
        let (mut w, ox, oy) = block(MapScale::Small, cols + 2, 12);
        let wall = ox + 5;
        // The gallery, and a shaft two cells wide (a body needs slack to climb one —
        // a shaft exactly a body wide is a lip at every pixel off its middle) down into
        // each chamber.
        fill(&mut w, ox + 1, oy + 1, ox + cols, oy + 2, false);
        fill(&mut w, ox + 1, oy + 3, ox + 2, oy + 8, false);
        fill(&mut w, ox + cols - 1, oy + 3, ox + cols, oy + 8, false);
        fill(&mut w, ox + 1, oy + 7, wall - 1, oy + 10, false);
        fill(&mut w, wall + thick, oy + 7, ox + cols, oy + 10, false);
        seal(&mut w);
        let _ = scenario(&mut w, (wall - 1, oy + 10), (wall + thick + 1, oy + 10));
        w
    };
    let (got, digs, _) = play(make(1), true);
    assert!(
        got && digs > 0,
        "thin wall: got {got}, {digs} swings — it should dig through"
    );
    let (got, digs, _) = play(make(12), true);
    assert!(
        got && digs == 0,
        "thick wall: got {got}, {digs} swings — it should go round"
    );
    assert!(
        !play(make(1), false).0,
        "control: the greedy model through a thin wall"
    );
    assert!(
        !play(make(12), false).0,
        "control: the greedy model round a thick wall"
    );
}

/// Cells of rock anywhere over the head of a body with its feet in `(x, y)`.
fn rock_overhead(w: &World, x: i32, y: i32) -> i32 {
    let g = super::nav::Grid::new(&w.map);
    (2..=y)
        .filter(|k| g.cell(x, y - k) != super::nav::Cell::Air)
        .count() as i32
}

/// The body's node, by the planner's own reading.
fn node_of(w: &World, id: PlayerId) -> Option<(i32, i32)> {
    super::nav::Grid::new(&w.map).locate(w.player(id)?.body.pos)
}

/// **D4 (T23.26C, `docs/78` §A3): a meteor shower changes no goal.** T23.26 C's fixture —
/// open ground, an overhang six cells off, the bot armed, an enemy on the open side — and
/// a shower announced and falling: the bot keeps its enemy as its goal through the
/// telegraph and the first seconds of the fall, and does not go under the overhang at the
/// warning (T23.26 C had it there by the first drop).
/// The presence half is the shots: a bot that froze would satisfy "never hid" too.
/// (Planted red by hand: T23.26 C's `Goal::Cover` restored, the goal turns at the
/// telegraph and the bot ends under the overhang — the journal has it.)
#[test]
fn a_meteor_shower_changes_no_goal() {
    use crate::constants::{EFFECT_TELEGRAPH, METEOR_CARVE_R};
    use crate::weapons::explode::EffectKind;
    let rows = (METEOR_CARVE_R / BOT_NAV_CELL).ceil() as i32 + 2;
    let (mut w, ox, oy) = block(MapScale::Small, 30, rows + 12);
    let floor = oy + rows + 10;
    fill(&mut w, ox + 1, oy + rows + 1, ox + 28, floor - 1, false);
    fill(&mut w, ox + 1, 0, ox + 14, oy + rows, false);
    seal(&mut w);
    w.set_phase(RoundPhase::Playing);
    w.add_player(1, 0, "bot".into());
    w.add_player(2, 0, "post".into());
    let _ = w.drain_events();
    let ids: Vec<_> = w.items.iter().map(|i| i.id).collect();
    for id in ids {
        w.items.remove(id);
    }
    if let Some(p) = w.player_mut(1) {
        p.body = crate::physics::body::Body::new(stand_at(ox + 8, floor - 1));
    }
    let post = stand_at(ox + 3, floor - 1);
    // A full stack: an unarmed bot goes shopping (§E10), which is not the shower's doing.
    give(&mut w, 1, PISTOL, crate::constants::PISTOL_AMMO);
    let mut bots = vec![Bot::new(1, SEED, 0, 0.6)];
    w.force_effect(EffectKind::MeteorShower, 0.0);
    let ticks = ((EFFECT_TELEGRAPH + 3.0) * SIM_HZ as f32) as u32;
    let mut off_goal = 0;
    let mut deepest = 0;
    for t in 0..ticks {
        if let Some(p) = w.player_mut(2) {
            p.body.pos = post;
            p.health = 100.0;
        }
        if let Some(p) = w.player_mut(1) {
            p.health = 100.0;
        }
        crate::bots::drive(&mut w, &mut bots, t as f32 * SIM_DT, SIM_DT);
        w.step(SIM_DT);
        let _ = w.drain_events();
        off_goal += u32::from(bots[0].goal != Goal::Enemy(2));
        // Under rock during the warning is hiding; once meteors fall, a sidestep may
        // well end under the overhang, and that is a dodge (`dodge`), not a goal.
        if (t as f32) * SIM_DT < EFFECT_TELEGRAPH {
            deepest = deepest.max(node_of(&w, 1).map_or(0, |(x, y)| rock_overhead(&w, x, y)));
        }
    }
    assert_eq!(
        off_goal, 0,
        "a shower took the bot off its enemy for {off_goal} of {ticks} ticks"
    );
    assert!(
        deepest < rows,
        "the bot went under the overhang ({deepest} rows of rock over it) at a shower's warning"
    );
    assert!(
        bots[0].stats().fires > 0,
        "presence: the bot never shot its enemy through the shower"
    );
}

/// **D4b (T23.26C, §A3): a meteor coming down on a bot is stepped out from under — when
/// there is time.** Open sky over a shelf, the bot holding at its enemy and shooting; a
/// meteor dropped straight onto it from a height its fall takes the bot's noticing lag
/// plus **twice** the walk out of the crater: no meteor damage. Controls on the same
/// fixture: the dodge planted out (`without_dodge`) — hit; and a meteor dropped from a
/// height that leaves a **quarter** of the walk after the lag — hit even with the dodge
/// ("not always succeeding", §A3, a property of `BOT_DODGE_LAG_*` and the walk).
#[test]
fn a_bot_steps_out_from_under_a_meteor_it_has_time_to_see() {
    use crate::constants::{GRAVITY, METEOR_CARVE_R, METEOR_SPEED, WALK_SPEED};
    use crate::items::registry::WEAPON_METEOR;
    use crate::weapons::explode::EffectKind;
    let clear_s = super::dodge::reach(METEOR_CARVE_R) / WALK_SPEED;
    let lag = super::dodge::lag(0.6);
    // Meteor damage the bot took, dropped to land `fall` s later.
    let hit = |fall: f32, dodge: bool| -> f32 {
        let mut w = world_with(&[1, 2]);
        let at = clear_line(&w);
        let ids: Vec<_> = w.items.iter().map(|i| i.id).collect();
        for id in ids {
            w.items.remove(id);
        }
        let y = flat_shelf(&mut w, at, 240);
        // Open sky over the shelf: nothing between the meteor and the bot but air.
        for row in 0..(y as i32 - PLAYER_H as i32) {
            w.map
                .mask
                .clear_run(row, at.x as i32 - 240, at.x as i32 + 240);
        }
        w.map.coarse = crate::map::coarse::CoarseGrid::build(&w.map.mask);
        if let Some(p) = w.player_mut(1) {
            p.body.pos = Vec2::new(at.x, y);
            // No spawn protection: a burst inside it deals nothing, dodged or not (the
            // late control's first run read 0 for exactly that).
            p.iframes_until = 0.0;
        }
        let enemy = Vec2::new(at.x + 60.0, y);
        give(&mut w, 1, PISTOL, 10);
        wield(&mut w, 1, PISTOL);
        let mut b = Bot::new(1, SEED, 0, 0.6);
        if !dodge {
            b = b.without_dodge();
        }
        let mut bots = vec![b];
        // Settle: let it reach its stand and start shooting before anything falls.
        let settle = SIM_HZ;
        let mut taken = 0.0;
        let mut burst_tick: Option<u32> = None;
        for t in 0..(settle + 3 * SIM_HZ) {
            let now = t as f32 * SIM_DT;
            if let Some(p) = w.player_mut(2) {
                p.body.pos = enemy;
                p.health = 100.0;
            }
            if t == settle {
                let me = w.player(1).expect("bot").body.pos;
                let drop = METEOR_SPEED * fall + 0.5 * GRAVITY * fall * fall;
                w.projectiles.spawn_raw(
                    WEAPON_METEOR,
                    u8::MAX,
                    Vec2::new(me.x, me.y - drop),
                    Vec2::new(0.0, METEOR_SPEED),
                    now,
                );
            }
            crate::bots::drive(&mut w, &mut bots, now, SIM_DT);
            let meteor_flying = w.projectiles.iter().any(|p| p.weapon == WEAPON_METEOR);
            w.step(SIM_DT);
            if meteor_flying && !w.projectiles.iter().any(|p| p.weapon == WEAPON_METEOR) {
                burst_tick.get_or_insert(t);
            }
            for e in w.drain_events() {
                if let crate::world::GameEvent::Damage {
                    victim: 1,
                    amount,
                    effect: Some(EffectKind::MeteorShower),
                    ..
                } = e
                {
                    // The meteor's own burst: fragments fly on after it and are a second
                    // threat this test is not about.
                    if burst_tick.is_none_or(|b| b == t) {
                        burst_tick = Some(t);
                        taken += amount;
                    }
                }
            }
        }
        taken
    };
    let in_time = lag + 2.0 * clear_s;
    let late = lag + 0.25 * clear_s;
    let dodged = hit(in_time, true);
    assert_eq!(
        dodged, 0.0,
        "a bot with {in_time:.2} s to see and clear a meteor took {dodged} from it"
    );
    assert!(
        hit(in_time, false) > 0.0,
        "control: with the dodge planted out the meteor missed anyway — the fixture"
    );
    assert!(
        hit(late, true) > 0.0,
        "control: a meteor landing {late:.2} s after release was dodged — the lag is not real"
    );
}

/// **D5: a hurt bot breaks contact out of sight, digging in.** The §E10 retreat
/// fixture (`walk.rs::a_hurt_bot_breaks_contact_and_a_healthy_one_holds_its_ground`) on
/// a floor of solid rock: a hurt bot with its shovel ends where its enemy has no line to
/// it. The control is that test itself, kept green with the shovel taken away — no
/// cover reachable, so it still runs (§A2: "§E10's retreat stands where no cover is
/// reachable").
#[test]
fn a_hurt_bot_digs_in_out_of_its_enemys_sight() {
    let mut w = world_with(&[1, 2]);
    let at = clear_line(&w);
    let ids: Vec<_> = w.items.iter().map(|i| i.id).collect();
    for id in ids {
        w.items.remove(id);
    }
    let y = flat_shelf(&mut w, at, 240);
    // Solid rock under the shelf, so a hole dug in it is a hole in the ground.
    let floor = y as i32 + PLAYER_H as i32 / 2 + 1;
    for row in floor..(floor + 160) {
        w.map
            .mask
            .set_run(row, at.x as i32 - 480, at.x as i32 + 240);
    }
    w.map.coarse = crate::map::coarse::CoarseGrid::build(&w.map.mask);
    let enemy = Vec2::new(at.x + 120.0, y);
    if let Some(p) = w.player_mut(1) {
        p.body.pos = Vec2::new(at.x, y);
    }
    give(&mut w, 1, PISTOL, 10);
    let health = crate::constants::BOT_FLEE_HEALTH - 5.0;
    let mut bots = vec![Bot::new(1, SEED, 0, 0.6)];
    let g = |w: &World| super::nav::Grid::new(&w.map).clear(w.player(1).unwrap().body.pos, enemy);
    for t in 0..((SCENARIO_S * SIM_HZ as f32) as u32) {
        if let Some(p) = w.player_mut(2) {
            p.body.pos = enemy;
            p.health = 100.0;
        }
        if let Some(p) = w.player_mut(1) {
            p.health = health;
        }
        crate::bots::drive(&mut w, &mut bots, t as f32 * SIM_DT, SIM_DT);
        w.step(SIM_DT);
        let _ = w.drain_events();
    }
    assert!(
        !g(&w),
        "a hurt bot with a shovel ended in its enemy's line of sight (dug {} swings)",
        bots[0].stats().dig_swings
    );
    assert!(
        bots[0].stats().dig_swings > 0,
        "it hid without digging — the fixture has cover"
    );
}

/// **D7 (T23.26C item 7): a hurt bot runs first, and digs in only when cornered.** A long
/// corridor, the hurt bot in it and an enemy six cells off; at the corridor's far end a
/// shaft up into a gallery out of the enemy's sight. With the shaft, the bot gets out of
/// sight **without a swing** and further from its enemy than it began by at least
/// `BOT_FLEE_GAIN`. The control is the same corridor with the shaft filled — cornered:
/// it digs (presence of the fallback, and the proof the run is what made the first arm
/// swing-free). Planted red by hand: Flee straight to `hide_target` → the open arm digs.
#[test]
fn a_hurt_bot_runs_out_of_sight_and_digs_in_only_when_cornered() {
    use crate::constants::{BOT_FLEE_GAIN, BOT_FLEE_HEALTH};
    let run = |shaft: bool| {
        let (mut w, ox, oy) = block(MapScale::Small, 40, 20);
        let feet = oy + 17;
        fill(&mut w, ox + 1, feet - 3, ox + 38, feet, false);
        if shaft {
            fill(&mut w, ox + 2, oy + 3, ox + 3, feet - 4, false);
            fill(&mut w, ox + 2, oy + 3, ox + 14, oy + 5, false);
        }
        seal(&mut w);
        w.set_phase(RoundPhase::Playing);
        w.add_player(1, 0, "bot".into());
        w.add_player(2, 0, "enemy".into());
        let _ = w.drain_events();
        let ids: Vec<_> = w.items.iter().map(|i| i.id).collect();
        for id in ids {
            w.items.remove(id);
        }
        let start = stand_at(ox + 20, feet);
        let enemy = stand_at(ox + 26, feet);
        if let Some(p) = w.player_mut(1) {
            p.body = crate::physics::body::Body::new(start);
        }
        give(&mut w, 1, PISTOL, 10);
        let mut bots = vec![Bot::new(1, SEED, 0, 0.6)];
        // Swings while fleeing: once out of range the goal is a wander, and a wander may
        // dig — that is not the run's doing.
        let mut digs = 0;
        for t in 0..((SCENARIO_S * SIM_HZ as f32) as u32) {
            if let Some(p) = w.player_mut(2) {
                p.body.pos = enemy;
                p.health = 100.0;
            }
            if let Some(p) = w.player_mut(1) {
                p.health = BOT_FLEE_HEALTH - 5.0;
            }
            let before = bots[0].stats().dig_swings;
            crate::bots::drive(&mut w, &mut bots, t as f32 * SIM_DT, SIM_DT);
            if matches!(bots[0].goal, Goal::Flee(_)) {
                digs += bots[0].stats().dig_swings - before;
            }
            w.step(SIM_DT);
            let _ = w.drain_events();
        }
        let at = w.player(1).expect("bot").body.pos;
        let seen = super::nav::Grid::new(&w.map).clear(at, enemy);
        (seen, (at - enemy).len() - (start - enemy).len(), digs)
    };
    let (seen, gained, digs) = run(true);
    assert!(
        !seen && gained >= BOT_FLEE_GAIN && digs == 0,
        "with a way out: in sight {seen}, gained {gained:.0} px (wants {BOT_FLEE_GAIN}), \
         {digs} swings — it should run, not dig"
    );
    let (seen, _, digs) = run(false);
    assert!(
        !seen && digs > 0,
        "control, cornered: in sight {seen}, {digs} swings — it should dig in"
    );
}

/// Put a teleport pad with its surface on the floor under nav cell `(x, feet)`.
fn pad_at(w: &mut World, id: u8, x: i32, feet: i32) {
    let c = stand_at(x, feet);
    w.map
        .meta
        .teleport_pads
        .push(crate::map::meta::TeleportPad {
            id,
            pos: crate::math::Point {
                x: c.x as i32,
                y: (feet + 1) * BOT_NAV_CELL as i32,
            },
        });
}

/// **D8 (T23.26C item 4, §A3 "teleport gates are routes"): a pistol in a sealed room
/// the bot cannot dig into (its shovel taken) is reached through a pad pair.** With a pad
/// in each room it gets the pistol; the control — the same rooms with no pads — never
/// does, and **gives the goal up** (§A3: "or gives the goal up"): its goal leaves the
/// item within `BOT_NAV_RETRY` of the start, where before T23.26 a sealed item was a goal
/// it pressed at forever.
#[test]
fn a_sealed_room_is_reached_by_a_pad_and_given_up_without_one() {
    use crate::constants::BOT_NAV_RETRY;
    let run = |pads: bool| {
        let (mut w, ox, oy) = block(MapScale::Small, 40, 12);
        let feet = oy + 9;
        // Two rooms, ten cells of rock apart.
        fill(&mut w, ox + 1, feet - 4, ox + 12, feet, false);
        fill(&mut w, ox + 23, feet - 4, ox + 38, feet, false);
        if pads {
            pad_at(&mut w, 0, ox + 9, feet);
            pad_at(&mut w, 1, ox + 26, feet);
        }
        seal(&mut w);
        let _ = scenario(&mut w, (ox + 3, feet), (ox + 33, feet));
        if let Some(p) = w.player_mut(1) {
            let _ = p.inventory.take_slot(0);
        }
        let mut bots = vec![Bot::new(1, SEED, 0, 0.6)];
        let mut gave_up_at = None;
        for t in 0..((SCENARIO_S * SIM_HZ as f32) as u32) {
            crate::bots::drive(&mut w, &mut bots, t as f32 * SIM_DT, SIM_DT);
            w.step(SIM_DT);
            let _ = w.drain_events();
            if gave_up_at.is_none() && !matches!(bots[0].goal, Goal::Item(_)) {
                gave_up_at = Some(t as f32 * SIM_DT);
            }
            if w.player(1).expect("bot").inventory.count_of(PISTOL) > 0 {
                return (true, gave_up_at);
            }
        }
        (false, gave_up_at)
    };
    let (got, _) = run(true);
    assert!(
        got,
        "a bot with a pad in each room never reached the pistol"
    );
    let (got, gave_up) = run(false);
    assert!(!got, "control: the sealed pistol was reached with no pad");
    assert!(
        gave_up.is_some_and(|t| t <= BOT_NAV_RETRY),
        "control: with no way in, the bot kept the item as its goal ({gave_up:?})"
    );
}

/// **D9 (T23.26C item 4): the jetpack is a tank.** A wall twelve cells tall, the pistol on
/// top, the bot at its foot with a full tank — and once its route is under way the tank
/// is drained to a fifth (a fight or a dodge burns fuel the plan never saw). It gets the
/// pistol **without ever flying the tank dry** (airborne under what starting the pack
/// takes): it stood, refilled and climbed. Control: the follower's tank rule planted out
/// (`without_tank_rule`) — it presses on, and flies dry.
#[test]
fn a_climb_the_tank_cannot_finish_waits_for_a_refill() {
    use crate::constants::{JETPACK_MAX_FUEL, JETPACK_MIN_FUEL_TO_ENGAGE};
    let run = |rule: bool| {
        let (mut w, ox, oy) = block(MapScale::Small, 14, 20);
        let feet = oy + 18;
        fill(&mut w, ox + 1, oy + 1, ox + 12, feet, false);
        fill(&mut w, ox + 7, oy + 6, ox + 12, feet, true);
        seal(&mut w);
        let _ = scenario(&mut w, (ox + 3, feet), (ox + 10, oy + 5));
        let mut b = Bot::new(1, SEED, 0, 0.6);
        if !rule {
            b = b.without_tank_rule();
        }
        let mut bots = vec![b];
        let (mut drained, mut dry) = (false, 0u32);
        for t in 0..((SCENARIO_S * SIM_HZ as f32) as u32) {
            crate::bots::drive(&mut w, &mut bots, t as f32 * SIM_DT, SIM_DT);
            if !drained && bots[0].route.following() {
                drained = true;
                if let Some(p) = w.player_mut(1) {
                    p.jetpack.fuel = JETPACK_MAX_FUEL * 0.2;
                }
            }
            w.step(SIM_DT);
            let _ = w.drain_events();
            let p = w.player(1).expect("bot");
            dry += u32::from(!p.body.grounded && p.jetpack.fuel < JETPACK_MIN_FUEL_TO_ENGAGE);
            if p.inventory.count_of(PISTOL) > 0 {
                return (true, dry, drained);
            }
        }
        (false, dry, drained)
    };
    let (got, dry, drained) = run(true);
    assert!(
        drained,
        "the fixture never drained the tank: no route was followed"
    );
    assert!(
        got && dry == 0,
        "with the tank rule: got the pistol {got}, {dry} ticks flying dry"
    );
    let (_, dry, _) = run(false);
    assert!(
        dry > 0,
        "control: without the rule it never flew dry — the fixture"
    );
}

/// **D10 (T23.26C item 3, §A3: "a bot with wings hunts and shops with them"): a winged
/// bot flies the way round to an enemy ~1000 px off.** Two chambers at the bottom of a
/// block, sixty cells of rock between them, a gallery over the top and a shaft down into
/// each; the bot winged (and frenzied, so an enemy that far is its goal), the enemy in the
/// far chamber. It ends with a clear line to the enemy, inside `BOT_ENGAGE_RANGE`.
/// Control: the same bot with its routes planted out — the old sweep — does not.
#[test]
fn a_winged_bot_flies_round_to_an_enemy_a_thousand_px_off() {
    use crate::constants::BOT_ENGAGE_RANGE;
    use crate::items::registry::UNICORN_WINGS;
    let run = |routes: bool| {
        let (mut w, ox, oy) = block(MapScale::Small, 70, 24);
        let feet = oy + 21;
        fill(&mut w, ox + 1, oy + 2, ox + 68, oy + 4, false);
        fill(&mut w, ox + 2, oy + 5, ox + 4, feet, false);
        fill(&mut w, ox + 65, oy + 5, ox + 67, feet, false);
        fill(&mut w, ox + 2, feet - 3, ox + 8, feet, false);
        fill(&mut w, ox + 61, feet - 3, ox + 67, feet, false);
        seal(&mut w);
        w.set_phase(RoundPhase::Playing);
        w.add_player(1, 0, "bot".into());
        w.add_player(2, 0, "enemy".into());
        let _ = w.drain_events();
        let ids: Vec<_> = w.items.iter().map(|i| i.id).collect();
        for id in ids {
            w.items.remove(id);
        }
        let enemy = stand_at(ox + 63, feet);
        if let Some(p) = w.player_mut(1) {
            p.body = crate::physics::body::Body::new(stand_at(ox + 6, feet));
        }
        give(&mut w, 1, UNICORN_WINGS, 1);
        give(&mut w, 1, PISTOL, 10);
        let mut b = Bot::new(1, SEED, 0, 0.6).frenzied(true);
        if !routes {
            b = b.without_routes();
        }
        let mut bots = vec![b];
        let start = (w.player(1).expect("bot").body.pos - enemy).len();
        for t in 0..((2.0 * SCENARIO_S * SIM_HZ as f32) as u32) {
            if let Some(p) = w.player_mut(2) {
                p.body.pos = enemy;
                p.health = 100.0;
            }
            crate::bots::drive(&mut w, &mut bots, t as f32 * SIM_DT, SIM_DT);
            w.step(SIM_DT);
            let _ = w.drain_events();
            let at = w.player(1).expect("bot").body.pos;
            if (at - enemy).len() < BOT_ENGAGE_RANGE
                && super::nav::Grid::new(&w.map).clear(at, enemy)
            {
                return (true, start);
            }
        }
        (false, start)
    };
    let (got, start) = run(true);
    assert!(
        start > 2.5 * BOT_ENGAGE_RANGE,
        "the fixture's enemy is only {start:.0} px off"
    );
    assert!(
        got,
        "a winged bot never got a line on an enemy {start:.0} px off"
    );
    let (got, _) = run(false);
    assert!(!got, "control: the unrouted winged bot got there too");
}
