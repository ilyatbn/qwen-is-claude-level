//! T23.26E — bots fight on open ground (owner, 2026-10-01: *"bots jump nonstop now and
//! really like digging instead of engaging one another … they should always prefer open
//! grounds. also they can use teleports."*). Carved fixtures in the real simulation, each
//! with its planted-red control, as `scenarios.rs`.

use super::nav::tests::{block, fill, seal, stand_at};
use super::tests::*;
use crate::constants::{BOT_ENGAGE_RANGE, BOT_WANDER_GIVE_UP, SIM_HZ};
use crate::player::state::PlayerId;

/// How long a fixture gets: twice the wander give-up, as `scenarios.rs`.
const FIXTURE_S: f32 = 2.0 * BOT_WANDER_GIVE_UP;

/// The bot (1, armed with a pistol) at `bot`, a held-still enemy (2) at `enemy`, nothing
/// else on the floor.
fn duel(w: &mut World, bot: (i32, i32), enemy: (i32, i32)) -> (PlayerId, Vec2) {
    w.set_phase(RoundPhase::Playing);
    w.add_player(1, 0, "bot".into());
    w.add_player(2, 0, "enemy".into());
    let _ = w.drain_events();
    let ids: Vec<_> = w.items.iter().map(|i| i.id).collect();
    for id in ids {
        w.items.remove(id);
    }
    if let Some(p) = w.player_mut(1) {
        p.body = crate::physics::body::Body::new(stand_at(bot.0, bot.1));
    }
    give(w, 1, PISTOL, crate::constants::PISTOL_AMMO);
    wield(w, 1, PISTOL);
    (1, stand_at(enemy.0, enemy.1))
}

/// Play `b` against the pinned enemy until it has a clear line to it within sight range,
/// or the bound; `(got a line, dig swings)`.
fn hunt(mut w: World, enemy: Vec2, b: Bot) -> (bool, u32) {
    let mut bots = vec![b];
    for t in 0..((FIXTURE_S * SIM_HZ as f32) as u32) {
        if let Some(p) = w.player_mut(2) {
            p.body.pos = enemy;
            p.body.vel = Vec2::ZERO;
            p.health = 100.0;
        }
        crate::bots::drive(&mut w, &mut bots, t as f32 * SIM_DT, SIM_DT);
        w.step(SIM_DT);
        let _ = w.drain_events();
        let at = w.player(1).expect("bot").body.pos;
        if (at - enemy).len() < BOT_ENGAGE_RANGE && super::nav::Grid::new(&w.map).clear(at, enemy) {
            return (true, bots[0].stats().dig_swings);
        }
    }
    (false, bots[0].stats().dig_swings)
}

/// **F1: an enemy behind a thin wall is reached over open ground, not tunnelled to.** D3's
/// gallery fixture with the pistol swapped for an enemy: one cell of rock between the bot
/// and it, a gallery over the top and a shaft down each side. The bot gets its line with
/// **no dig swing**. Control: the old rule (`with_dig_first`) — the wall is the cheaper
/// route, and it digs. And the presence half: sealed in a pocket with no open way out, the
/// bot still digs to its enemy (§A2: "unless no open route exists").
#[test]
fn an_enemy_behind_a_thin_wall_is_reached_over_open_ground() {
    let gallery = || {
        let cols = 9;
        let (mut w, ox, oy) = block(MapScale::Small, cols + 2, 12);
        let wall = ox + 5;
        fill(&mut w, ox + 1, oy + 1, ox + cols, oy + 2, false);
        fill(&mut w, ox + 1, oy + 3, ox + 2, oy + 8, false);
        fill(&mut w, ox + cols - 1, oy + 3, ox + cols, oy + 8, false);
        fill(&mut w, ox + 1, oy + 7, wall - 1, oy + 10, false);
        fill(&mut w, wall + 1, oy + 7, ox + cols, oy + 10, false);
        seal(&mut w);
        let (_, enemy) = duel(&mut w, (wall - 1, oy + 10), (wall + 2, oy + 10));
        (w, enemy)
    };
    let (w, enemy) = gallery();
    let (got, digs) = hunt(w, enemy, Bot::new(1, SEED, 0, 0.6));
    assert!(
        got && digs == 0,
        "open ground first: line {got}, {digs} dig swings"
    );
    let (w, enemy) = gallery();
    let (_, digs) = hunt(w, enemy, Bot::new(1, SEED, 0, 0.6).with_dig_first());
    assert!(
        digs > 0,
        "control: routed with dig steps from the start it never dug — the fixture"
    );
    // Cornered: a pocket three cells of rock from the enemy's open ground.
    let (mut w, ox, oy) = block(MapScale::Small, 30, 22);
    fill(&mut w, ox + 4, oy + 8, ox + 8, oy + 11, false);
    fill(&mut w, ox + 12, oy + 1, ox + 28, oy + 19, false);
    seal(&mut w);
    let (_, enemy) = duel(&mut w, (ox + 6, oy + 11), (ox + 14, oy + 11));
    let (got, digs) = hunt(w, enemy, Bot::new(1, SEED, 0, 0.6));
    assert!(
        got && digs > 0,
        "control, sealed in: line {got}, {digs} swings — with no open route it digs"
    );
}
