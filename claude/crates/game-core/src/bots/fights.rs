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

/// Run an unarmed bot (`b`) at the one pistol on the floor until it picks it up, or the
/// bound; `(got it, dig swings, seconds enclosed by rock)`.
fn fetch(mut w: World, b: Bot) -> (bool, u32, f32) {
    let mut bots = vec![b];
    let mut watch = super::movement::Watcher::default();
    for t in 0..((FIXTURE_S * SIM_HZ as f32) as u32) {
        crate::bots::drive(&mut w, &mut bots, t as f32 * SIM_DT, SIM_DT);
        w.step(SIM_DT);
        let _ = w.drain_events();
        watch.observe(&w, SIM_DT);
        if w.player(1).expect("bot").inventory.count_of(PISTOL) > 0 {
            return (true, bots[0].stats().dig_swings, watch.of(1).in_rock_s);
        }
    }
    (false, bots[0].stats().dig_swings, watch.of(1).in_rock_s)
}

/// **F2 (step 4): a wall five rows tall and one cell thick is flown over, not dug
/// through.** A room, the bot on one side, the pistol on the other. Priced on time alone
/// the bore wins (one dug node, ~0.55 s, against a jet up five rows, the fall and the
/// fuel's refill, ~1.5 s); priced as open ground (`BOT_NAV_DIG_FACTOR`,
/// `BOT_NAV_ENCLOSED_S`) the jet does. It gets the pistol with no swing and no time
/// enclosed. Control: the pricing planted out (`without_open_ground`) — it digs.
#[test]
fn a_wall_is_flown_over_rather_than_bored_through() {
    let room = || {
        let (mut w, ox, oy) = block(MapScale::Small, 24, 14);
        let feet = oy + 12;
        fill(&mut w, ox + 1, oy + 1, ox + 22, feet, false);
        fill(&mut w, ox + 11, feet - 4, ox + 11, feet, true);
        seal(&mut w);
        w.set_phase(RoundPhase::Playing);
        w.add_player(1, 0, "bot".into());
        let _ = w.drain_events();
        let ids: Vec<_> = w.items.iter().map(|i| i.id).collect();
        for id in ids {
            w.items.remove(id);
        }
        if let Some(p) = w.player_mut(1) {
            p.body = crate::physics::body::Body::new(stand_at(ox + 7, feet));
        }
        let _ = drop_at(&mut w, PISTOL, stand_at(ox + 15, feet));
        w
    };
    let (got, digs, rock) = fetch(room(), Bot::new(1, SEED, 0, 0.6));
    assert!(
        got && digs == 0 && rock == 0.0,
        "open ground: got {got}, {digs} swings, {rock:.2} s in rock"
    );
    let (_, digs, _) = fetch(room(), Bot::new(1, SEED, 0, 0.6).without_open_ground());
    assert!(
        digs > 0,
        "control: priced on time alone it never bored the wall — the fixture"
    );
}

/// **F3 (step 4): exploration aims at open ground.** A block of rock with one room carved
/// in it, the bot alone in the room: the first wander target is a node it can stand on
/// with open space round its head (`Grid::stands`, not `Grid::enclosed`). Control: the
/// open-ground rule planted out — the nearest unseen cell's middle, inside the rock (the
/// target a route then dug to).
#[test]
fn exploration_aims_at_open_ground_not_into_rock() {
    let target = |open: bool| {
        let (mut w, ox, oy) = block(MapScale::Small, 60, 40);
        fill(&mut w, ox + 2, oy + 30, ox + 57, oy + 36, false);
        seal(&mut w);
        w.set_phase(RoundPhase::Playing);
        w.add_player(1, 0, "bot".into());
        let _ = w.drain_events();
        let ids: Vec<_> = w.items.iter().map(|i| i.id).collect();
        for id in ids {
            w.items.remove(id);
        }
        if let Some(p) = w.player_mut(1) {
            p.body = crate::physics::body::Body::new(stand_at(ox + 5, oy + 36));
        }
        let mut b = Bot::new(1, SEED, 0, 0.6);
        if !open {
            b = b.without_open_ground();
        }
        let _ = b.think(&w, 0.0, SIM_DT);
        let g = super::nav::Grid::new(&w.map);
        let to = b.wander_to.expect("a wander target");
        let (x, y) = (
            (to.x / crate::constants::BOT_NAV_CELL).floor() as i32,
            (to.y / crate::constants::BOT_NAV_CELL).floor() as i32,
        );
        g.stands(x, y) && !g.enclosed(x, y)
    };
    assert!(
        target(true),
        "exploration aimed somewhere a body cannot stand in the open"
    );
    assert!(
        !target(false),
        "control: the nearest cell's middle was open ground anyway — the fixture"
    );
}

/// **F4 (owner: *"engaging one another"*): a bot goes to a shot it hears.** A long open
/// gallery, the armed bot at one end with nothing in sight; an enemy `BOT_HEAR_RANGE` ×
/// 0.85 off fires a round upward every second. Within the bound the bot closes to sight
/// range of it. Control: hearing and chasing planted out (`without_chase`) — it explores
/// the way it would have, and ends further off.
#[test]
fn a_bot_goes_to_a_shot_it_hears() {
    use crate::constants::BOT_HEAR_RANGE;
    use crate::items::registry::WEAPON_PISTOL;
    let run = |chase: bool| {
        let (mut w, ox, oy) = block(MapScale::Small, 90, 12);
        let feet = oy + 10;
        fill(&mut w, ox + 1, oy + 1, ox + 88, feet, false);
        seal(&mut w);
        let off = ((BOT_HEAR_RANGE * 0.85) / crate::constants::BOT_NAV_CELL) as i32;
        let (_, enemy) = duel(&mut w, (ox + 3, feet), (ox + 3 + off, feet));
        let mut b = Bot::new(1, SEED, 0, 0.6);
        if !chase {
            b = b.without_chase();
        }
        let mut bots = vec![b];
        let mut nearest = f32::MAX;
        for t in 0..((FIXTURE_S * SIM_HZ as f32) as u32) {
            if let Some(p) = w.player_mut(2) {
                p.body.pos = enemy;
                p.body.vel = Vec2::ZERO;
                p.health = 100.0;
            }
            if t % SIM_HZ == 0 {
                let now = t as f32 * SIM_DT;
                let _ = w.projectiles.spawn_raw(
                    WEAPON_PISTOL,
                    2,
                    enemy - Vec2::new(0.0, crate::constants::PLAYER_H),
                    Vec2::new(0.0, -300.0),
                    now,
                );
            }
            crate::bots::drive(&mut w, &mut bots, t as f32 * SIM_DT, SIM_DT);
            w.step(SIM_DT);
            let _ = w.drain_events();
            nearest = nearest.min((w.player(1).expect("bot").body.pos - enemy).len());
        }
        let start = (stand_at(ox + 3, feet) - enemy).len();
        (nearest, start)
    };
    let (heard, start) = run(true);
    assert!(
        start > BOT_ENGAGE_RANGE && heard < BOT_ENGAGE_RANGE,
        "a bot {start:.0} px from a shooting enemy came no nearer than {heard:.0}"
    );
    let (deaf, _) = run(false);
    assert!(
        deaf > heard,
        "control: deaf it came as near ({deaf:.0} px) — the fixture, not the hearing"
    );
}

/// **F5: an enemy lost from sight is chased to where it was last seen.** The gallery, the
/// armed bot in its middle, an enemy in sight down it for a quarter second — then gone
/// (moved off, out of all sight). Within six seconds the bot gets to the spot it saw it
/// at. Control: `without_chase` — it explores instead, and comes no nearer.
#[test]
fn a_lost_enemy_is_chased_to_where_it_was_seen() {
    let run = |chase: bool| {
        let (mut w, ox, oy) = block(MapScale::Small, 90, 12);
        let feet = oy + 10;
        fill(&mut w, ox + 1, oy + 1, ox + 88, feet, false);
        seal(&mut w);
        // The bot mid-gallery, the enemy to its right: unseen cells tie left and right,
        // and exploration breaks ties on the lower index — left, away from the fight.
        let seen = (ox + 45 + 18, feet);
        let (_, enemy) = duel(&mut w, (ox + 45, feet), seen);
        let gone = Vec2::new(enemy.x, enemy.y + 4.0 * BOT_ENGAGE_RANGE);
        let mut b = Bot::new(1, SEED, 0, 0.6);
        if !chase {
            b = b.without_chase();
        }
        let mut bots = vec![b];
        let mut nearest = f32::MAX;
        for t in 0..(6 * SIM_HZ) {
            if let Some(p) = w.player_mut(2) {
                p.body.pos = if t < SIM_HZ / 4 { enemy } else { gone };
                p.body.vel = Vec2::ZERO;
                p.health = 100.0;
            }
            crate::bots::drive(&mut w, &mut bots, t as f32 * SIM_DT, SIM_DT);
            w.step(SIM_DT);
            let _ = w.drain_events();
            if t >= SIM_HZ / 4 {
                nearest = nearest.min((w.player(1).expect("bot").body.pos - enemy).len());
            }
        }
        nearest
    };
    let chased = run(true);
    assert!(
        chased < crate::constants::BOT_WANDER_ARRIVED,
        "the bot never reached where it last saw its enemy ({chased:.0} px off)"
    );
    let forgot = run(false);
    assert!(
        forgot > chased,
        "control: forgetting, it came as near ({forgot:.0} px) — the fixture"
    );
}
