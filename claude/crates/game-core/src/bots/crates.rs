//! T23.36: **crates are beacons.** The owner: *"bots should 'see' the location of crates
//! and they want to go pick them up to get more weapons."* A crate falls out of the sky in
//! plain view — an event, like a shot heard — so where it comes to rest is known to every
//! bot, map-wide, not only inside `BOT_ENGAGE_RANGE` as other items are (`Bot::choose_goal`).
//!
//! What a bot routes to is the crate's **landing spot**: while it falls it is somewhere in
//! the sky, and a route to the sky is a route nowhere. It falls straight down (no
//! horizontal velocity at spawn, `SpawnSchedule::tick_crates`), so the spot is the first
//! rock under it — read off the map now, and moving with the crate if the ground under it
//! is blown away (it falls again, and so does this answer).

use crate::constants::{GravityMode, CRATE_H, CRATE_W};
use crate::items::world::WorldItem;
use crate::math::Vec2;
use crate::world::World;

/// Where a world item will be when it comes to rest: its own position once grounded (or in
/// space, where nothing falls — R14), else straight down onto the first solid pixel under
/// it. `None` for one falling into nothing — out through a hole in the floor (§C15).
pub(super) fn landing(world: &World, it: &WorldItem) -> Option<Vec2> {
    if it.grounded || world.gravity == GravityMode::Space {
        return Some(it.pos);
    }
    // Across the whole base, as `WorldItems::supported` asks: the crate rests on the
    // highest rock under any part of it, not under its middle.
    let x0 = (it.pos.x - CRATE_W / 2.0).round() as i32;
    let x1 = (it.pos.x + CRATE_W / 2.0).round() as i32 - 1;
    let top = (it.pos.y + CRATE_H / 2.0).round().max(0.0) as i32;
    (top..world.map.mask.h as i32)
        .find(|&y| (x0..=x1).any(|x| crate::physics::collide::solid_at(&world.map, x, y)))
        .map(|y| Vec2::new(it.pos.x, y as f32 - CRATE_H / 2.0))
}

/// Does this bot see `it` from anywhere on the map? A crate, to a bot with nothing it can
/// fire at range (`Bot::has_firable_weapon` — the shovel is not a gun, §F5). An armed bot
/// keeps the ordinary sight: a crate is a gun to the bot without one, not a detour from a
/// fight for the bot that has one.
pub(super) fn beacon(it: &WorldItem, armed: bool) -> bool {
    it.is_crate() && !armed
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::constants::{SIM_DT, SKY_MARGIN};
    use crate::items::registry::PISTOL;
    use crate::items::world::SpawnSource;
    use crate::world::RoundPhase;

    /// The landing spot read off the map is where the crate does come to rest: dropped from
    /// the sky on a real map, stepped until it lands, within a pixel. Control: the same
    /// crate's spawn position is hundreds of px above it — the sky, which is what a route
    /// to `it.pos` would have aimed at.
    #[test]
    fn a_falling_crates_landing_spot_is_where_it_lands() {
        let mut w = World::new(7, crate::constants::DEFAULT_MAP_SCALE);
        w.set_phase(RoundPhase::Playing);
        let mut checked = 0;
        for x in [600.0, 1200.0, 1800.0] {
            let at = Vec2::new(x, (SKY_MARGIN / 2) as f32);
            let id = w
                .items
                .spawn(PISTOL, 1, at, Vec2::ZERO, SpawnSource::Crate, 0.0);
            let Some(spot) = w.items.get(id).and_then(|it| landing(&w, it)) else {
                continue;
            };
            assert!(
                spot.y - at.y > 100.0,
                "control: the drop is not in the sky ({spot:?})"
            );
            for _ in 0..(20.0 / SIM_DT) as u32 {
                w.step(SIM_DT);
                if w.items.get(id).is_none_or(|it| it.grounded) {
                    break;
                }
            }
            let Some(it) = w.items.get(id) else { continue };
            assert!(it.grounded, "never landed");
            assert!(
                (it.pos - spot).len() <= 1.5,
                "landed at {:?}, predicted {spot:?}",
                it.pos
            );
            checked += 1;
        }
        assert!(checked >= 2, "only {checked} crates checked");
    }

    /// **The owner's ask: an unarmed bot sees a crate and goes to get it.** Rock over the
    /// whole map and one long open hall; the bot with only its shovel, alone, in the hall's
    /// middle, and a crate dropped from the hall's ceiling 50 cells (800 px) to one side —
    /// past `BOT_ARM_SIGHT`, so no ordinary sight reaches it — once to each side. It makes
    /// the crate its goal on its first think (while the crate is still falling) and opens
    /// it. Control: `without_crates` — the same bot does not see it and explores instead,
    /// and has not opened it by the time the bot that saw it had. From the middle the
    /// blind bot's exploration goes one way first, so the two sides are both asked, or one
    /// would be exploration's luck. (Plant: `beacon` `false` at its one site → red.)
    #[test]
    fn an_unarmed_bot_goes_to_a_crate_it_cannot_otherwise_see() {
        use super::super::nav::tests::{block, fill, seal, stand_at};
        use super::super::{Bot, Goal};
        use crate::constants::{MapScale, BOT_ARM_SIGHT, BOT_NAV_CELL, BOT_WANDER_GIVE_UP};
        let away = 50;
        assert!(
            away as f32 * BOT_NAV_CELL > BOT_ARM_SIGHT,
            "the fixture: the crate is in sight"
        );
        let run = |sees: bool, dir: i32| {
            let (mut w, ox, oy) = block(MapScale::Small, 124, 62);
            let feet = oy + 40;
            fill(&mut w, ox + 1, feet - 9, ox + 122, feet, false);
            seal(&mut w);
            w.set_phase(RoundPhase::Playing);
            w.add_player(1, 0, "bot".into());
            let ids: Vec<_> = w.items.iter().map(|i| i.id).collect();
            for id in ids {
                w.items.remove(id);
            }
            let at = ox + 62;
            if let Some(p) = w.player_mut(1) {
                p.body = crate::physics::body::Body::new(stand_at(at, feet));
            }
            let _ = w.drain_events();
            let top = stand_at(at + dir * away, feet - 8);
            let id = w
                .items
                .spawn(PISTOL, 1, top, Vec2::ZERO, SpawnSource::Crate, 0.0);
            let mut b = Bot::new(1, 7, 0, 0.6);
            if !sees {
                b = b.without_crates();
            }
            let mut bots = vec![b];
            let mut first = None;
            let mut opened = None;
            for t in 0..((2.0 * BOT_WANDER_GIVE_UP / SIM_DT) as u32) {
                crate::bots::drive(&mut w, &mut bots, t as f32 * SIM_DT, SIM_DT);
                if first.is_none() {
                    first = Some(bots[0].goal);
                }
                w.step(SIM_DT);
                let _ = w.drain_events();
                if opened.is_none() && w.items.get(id).is_none() {
                    opened = Some(t as f32 * SIM_DT);
                }
            }
            (first, opened, id)
        };
        for dir in [-1, 1] {
            let (first, opened, id) = run(true, dir);
            assert_eq!(
                first,
                Some(Goal::Item(id)),
                "side {dir}: the crate was not its first goal"
            );
            let Some(t) = opened else {
                panic!("side {dir}: it never opened the crate");
            };
            let (first, late, _) = run(false, dir);
            println!("side {dir}: seen, opened at {t:.2} s; blind, {late:?}");
            assert_ne!(
                first,
                Some(Goal::Item(id)),
                "control: blind, it still went for it"
            );
            assert!(
                late.is_none_or(|l| l > t),
                "control, side {dir}: blind, it opened the crate at {late:?} s, no later than {t} s"
            );
        }
    }
}
