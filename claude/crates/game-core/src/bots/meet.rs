//! T23.26F — bots seek open ground and each other (`docs/78` §A6; owner, 2026-10-01:
//! *"their top priority is to find as much open ground and each other … calculating the
//! best path to places outside of caves"*). Carved fixtures in the real simulation, each
//! with its planted-red control, as `fights.rs`.

use super::nav::tests::{block, fill, seal, stand_at};
use super::tests::*;
use crate::constants::{BOT_WANDER_GIVE_UP, SIM_HZ};

/// How long a fixture gets: twice the wander give-up, as `fights.rs`.
const FIXTURE_S: f32 = 2.0 * BOT_WANDER_GIVE_UP;

/// A world with the bot (1) alone in it, armed with a pistol, standing at `at`, and no
/// item on the floor.
fn alone(w: &mut World, at: Vec2) {
    unarmed(w, at);
    give(w, 1, PISTOL, crate::constants::PISTOL_AMMO);
    wield(w, 1, PISTOL);
}

/// The same with only the shovel every player spawns with.
fn unarmed(w: &mut World, at: Vec2) {
    w.set_phase(RoundPhase::Playing);
    w.add_player(1, 0, "bot".into());
    let _ = w.drain_events();
    let ids: Vec<_> = w.items.iter().map(|i| i.id).collect();
    for id in ids {
        w.items.remove(id);
    }
    if let Some(p) = w.player_mut(1) {
        p.body = crate::physics::body::Body::new(at);
    }
}

/// **M1: a bot in a cave goes out of its mouth to open ground.** Rock over the whole map;
/// a low chamber (four rows — a cave by the volume rule, though no tunnel by
/// `Grid::enclosed`) with the bot at one end and a shaft at the other up into a wide hall
/// (open). A second hall lies sealed **under** the chamber, nearer by a straight line than
/// the mouth. The bot reaches the open hall through the mouth with **no dig swing**.
/// Control: the escape planted out (`without_escape`) — exploration's nearest unseen open
/// ground is the sealed hall, and the bot digs down to it. (Plant: `closed_in` `false` at
/// its one site → red.)
#[test]
fn a_bot_in_a_cave_goes_out_of_its_mouth_to_open_ground() {
    let run = |escape: bool| {
        let (mut w, ox, oy) = block(MapScale::Small, 124, 62);
        let feet = oy + 40;
        // The chamber, and the shaft at its far end up to the hall.
        fill(&mut w, ox + 10, feet - 3, ox + 50, feet, false);
        fill(&mut w, ox + 48, oy + 19, ox + 50, feet, false);
        fill(&mut w, ox + 36, oy + 6, ox + 70, oy + 19, false);
        // The sealed hall, under the chamber's near end.
        fill(&mut w, ox + 2, feet + 6, ox + 30, feet + 18, false);
        seal(&mut w);
        alone(&mut w, stand_at(ox + 12, feet));
        // Nearest-first exploration in both arms (`without_converge`): the drift to the
        // open middle is M3's, and here would lead the control to the hall as well.
        let mut b = Bot::new(1, SEED, 0, 0.6).without_converge();
        if !escape {
            b = b.without_escape();
        }
        let mut bots = vec![b];
        let mut open = super::open::Openness::default();
        open.build(&super::nav::Grid::new(&w.map));
        let start_open = open.open_at(&super::nav::Grid::new(&w.map), stand_at(ox + 12, feet));
        let hall_open = open.ground(&super::nav::Grid::new(&w.map), ox + 60, oy + 19);
        let mut out_at = None;
        for t in 0..((2.0 * FIXTURE_S * SIM_HZ as f32) as u32) {
            crate::bots::drive(&mut w, &mut bots, t as f32 * SIM_DT, SIM_DT);
            w.step(SIM_DT);
            let _ = w.drain_events();
            let at = w.player(1).expect("bot").body.pos;
            if at.y < ((oy + 20) * crate::constants::BOT_NAV_CELL as i32) as f32 {
                out_at = Some(t as f32 * SIM_DT);
                break;
            }
        }
        (start_open, hall_open, out_at, bots[0].stats().dig_swings)
    };
    let (start_open, hall_open, out, digs) = run(true);
    assert!(
        !start_open && hall_open,
        "fixture: the chamber reads open {start_open}, the hall {hall_open}"
    );
    assert!(
        out.is_some() && digs == 0,
        "out of the cave by its mouth: reached the hall at {out:?} s with {digs} swings"
    );
    let (_, _, out, digs) = run(false);
    assert!(
        out.is_none() || digs > 0,
        "control: exploring from inside, it still left by the mouth at {out:?} s without \
         a swing — the fixture"
    );
}

/// **M2 (*"stop shoveling"*): an unarmed bot goes for a gun before it swings.** Rock over
/// the whole map and one long open hall: the bot with only its shovel, a still enemy six
/// cells (~100 px) to one side and a pistol most of `BOT_ARM_SIGHT` (~600 px) away to the
/// other. It picks the pistol up and never swings before it has. Control: no gun anywhere
/// — the shovel is all there is, and it swings at the enemy. (Plant: `far_gun` `false` at
/// its site → red: the pistol is past `BOT_ENGAGE_RANGE`, unseen, and the bot explores.)
#[test]
fn an_unarmed_bot_goes_for_a_gun_rather_than_shovelling() {
    let cell = crate::constants::BOT_NAV_CELL;
    let gun_cells = (crate::constants::BOT_ARM_SIGHT * 0.94 / cell) as i32;
    let run = |gun: bool| {
        let (mut w, ox, oy) = block(MapScale::Small, 124, 62);
        let feet = oy + 40;
        fill(&mut w, ox + 1, feet - 9, ox + 122, feet, false);
        seal(&mut w);
        let at = ox + 4 + gun_cells;
        unarmed(&mut w, stand_at(at, feet));
        w.add_player(2, 0, "enemy".into());
        let _ = w.drain_events();
        let enemy = stand_at(at + 6, feet);
        if gun {
            let _ = drop_at(&mut w, PISTOL, stand_at(ox + 4, feet));
        }
        let mut bots = vec![Bot::new(1, SEED, 0, 0.6)];
        let mut swings_before = 0u32;
        let mut got = None;
        for t in 0..((2.0 * FIXTURE_S * SIM_HZ as f32) as u32) {
            if let Some(p) = w.player_mut(2) {
                p.body.pos = enemy;
                p.body.vel = Vec2::ZERO;
                p.health = 100.0;
            }
            crate::bots::drive(&mut w, &mut bots, t as f32 * SIM_DT, SIM_DT);
            w.step(SIM_DT);
            let _ = w.drain_events();
            if got.is_none() {
                swings_before = bots[0].stats().fires_by_kind[0];
                if w.player(1).expect("bot").inventory.count_of(PISTOL) > 0 {
                    got = Some(t as f32 * SIM_DT);
                }
            }
        }
        (got, swings_before, bots[0].stats().fires_by_kind[0])
    };
    let (got, before, _) = run(true);
    assert!(
        got.is_some() && before == 0,
        "the gun first: picked up at {got:?} s, {before} swings at the enemy before it"
    );
    let (got, _, swings) = run(false);
    assert!(
        got.is_none() && swings > 0,
        "control: with no gun anywhere it never swung ({swings}) — the fixture"
    );
}

/// **M3 (*"find each other"*): exploration drifts toward the middle of the open ground.**
/// Rock over the whole map and one hall right across it; the bot near its left end, where
/// the nearest unexplored cell is the one further left. Its first target lies toward the
/// middle (right). Control: `without_converge` — nearest first, left, toward the rim.
/// (Plant: the drift's `filter` `false` at its site → red.)
#[test]
fn exploration_drifts_toward_the_middle_of_the_open_ground() {
    let first = |converge: bool| {
        let (mut w, ox, oy) = block(MapScale::Small, 124, 62);
        let feet = oy + 39;
        fill(&mut w, ox + 1, feet - 9, ox + 122, feet, false);
        seal(&mut w);
        let at = ox + 20;
        alone(&mut w, stand_at(at, feet));
        let mut b = Bot::new(1, SEED, 0, 0.6);
        if !converge {
            b = b.without_converge();
        }
        let _ = b.think(&w, 0.0, SIM_DT);
        let to = b.wander_to.expect("a wander target");
        to.x - stand_at(at, feet).x
    };
    let dx = first(true);
    assert!(
        dx > 0.0,
        "the first target was {dx:.0} px off — away from the middle"
    );
    let dx = first(false);
    assert!(
        dx < 0.0,
        "control: nearest first, the target was {dx:.0} px off — the fixture has no rim side"
    );
}
