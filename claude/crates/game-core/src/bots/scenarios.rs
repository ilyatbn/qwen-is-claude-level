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
