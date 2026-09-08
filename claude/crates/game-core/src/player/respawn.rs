//! Where a death puts you: a teleport pad (`docs/72-amendments-v4.md` §C5).
//!
//! ## The two bugs this fixes
//!
//! Respawn landed **in mid-air** and **always in the same spot**. Both came from
//! the same place: `choose_respawn` walks `MapMeta.spawn_points` in order and
//! returns the first one far enough from the living, so an eight-minute round of
//! deaths returns the same point every time, and once the map has been dug about
//! the surviving points are wherever the rubble left them.
//!
//! Pads fix both by construction. They are indestructible (`TeleportPad`), so the
//! surface is guaranteed rather than re-validated and hoped for; and the choice is
//! *furthest from the nearest living player*, which moves as the round does.
//!
//! ## `docs/21` §4 is still enforced
//!
//! §4 says a respawn point must be re-validated against the damaged map. With
//! indestructible pads that check should never fail — so it stays, and
//! [`choose_respawn_pad`] reports when it fires. `a_pad_respawn_never_falls_back`
//! is the test that it does not, over fifty deaths on a map carved to pieces: an
//! assertion that the fallback is dead code is worth more than the fallback.

use crate::map::meta::TeleportPad;
use crate::map::Map;
use crate::math::Vec2;
use crate::player::state::surface_to_centre;
use crate::rng::ChaCha8Rng;

/// A respawn position, and whether it came from a pad.
///
/// The flag is not decoration: `docs/21` §4's re-validation is supposed to be
/// unreachable now, and a caller that cannot tell "pad" from "fell back to the
/// old surface scan" cannot assert that. Returning it is cheaper than a log line
/// nobody reads (`CLAUDE.md`: return what the caller needs).
#[derive(Copy, Clone, Debug, PartialEq)]
pub struct RespawnChoice {
    /// Body **centre**, ready for `Body::new` — not a feet line.
    pub pos: Vec2,
    /// The pad chosen, or `None` if every pad failed re-validation.
    pub pad: Option<u8>,
}

/// The pad furthest from the nearest living player (§C5).
///
/// `living` are body centres. Ties are broken by pad id, which keeps the whole
/// thing deterministic without consuming the RNG — the `rng` argument exists only
/// for the fallback, which is the path §C5 expects never to run.
///
/// **Furthest from the *nearest*, not from the mean.** Maximising mean distance
/// puts you in the middle of a spread-out fight; maximising the distance to the
/// closest living player is what "somewhere safe to land" means.
pub fn choose_respawn_pad(map: &Map, living: &[Vec2], rng: &mut ChaCha8Rng) -> RespawnChoice {
    let mut best: Option<(f32, &TeleportPad)> = None;

    for pad in &map.meta.teleport_pads {
        // §4's re-validation. Indestructible pads make this a formality; it is
        // here so that if the guarantee is ever broken, respawn degrades to the
        // old behaviour rather than burying somebody in rock.
        if !crate::map::gen::surface::is_standable(&map.mask, pad.pos.x, pad.pos.y) {
            continue;
        }
        let here = Vec2::new(pad.pos.x as f32, pad.pos.y as f32);
        let nearest = living
            .iter()
            .map(|q| (here - *q).len())
            .fold(f32::INFINITY, f32::min);
        // Strictly greater, so ties go to the lower id and the result does not
        // depend on iteration order being stable for a reason nobody wrote down.
        if best.is_none_or(|(d, _)| nearest > d) {
            best = Some((nearest, pad));
        }
    }

    match best {
        Some((_, pad)) => RespawnChoice {
            pos: surface_to_centre(Vec2::new(pad.pos.x as f32, pad.pos.y as f32)),
            pad: Some(pad.id),
        },
        None => RespawnChoice {
            pos: crate::player::state::choose_respawn(map, living, rng),
            pad: None,
        },
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::constants::{MapScale, PLAYER_H, TELEPORT_PADS};
    use crate::map::generate;
    use crate::rng::substream;

    /// Every pad, blasted at. Radius large enough to obliterate ordinary rock.
    fn carve_the_map_to_pieces(map: &mut Map) {
        let (w, h) = (map.mask.w as i32, map.mask.h as i32);
        let mut y = 0;
        while y < h {
            let mut x = 0;
            while x < w {
                map.carve_circle(x, y, 90);
                x += 120;
            }
            y += 120;
        }
    }

    #[test]
    fn a_respawn_lands_standing_on_a_pad() {
        let map = generate(4242, MapScale::Medium);
        let mut rng = substream(1, "test");
        let choice = choose_respawn_pad(&map, &[], &mut rng);
        let pad = choice.pad.expect("no pad chosen on a pristine map");
        let p = map.meta.teleport_pads[pad as usize];
        // A centre, not a feet line — the bug that buried the lower half of the
        // player in rock when `World` first called `choose_respawn`.
        assert_eq!(choice.pos.y, p.pos.y as f32 - PLAYER_H / 2.0);
        assert_eq!(choice.pos.x, p.pos.x as f32);
    }

    /// The §C5 rule, on a fixture where the right answer is not the first pad.
    #[test]
    fn the_pad_chosen_is_the_one_furthest_from_the_nearest_living_player() {
        let map = generate(4242, MapScale::Medium);
        let mut rng = substream(1, "test");
        let pads = &map.meta.teleport_pads;
        assert_eq!(pads.len(), TELEPORT_PADS);

        // Stand a living player on top of pad 0. The answer must not be pad 0,
        // and must be whichever pad maximises the distance to them.
        let occupied = Vec2::new(pads[0].pos.x as f32, pads[0].pos.y as f32);
        let choice = choose_respawn_pad(&map, &[occupied], &mut rng);
        let got = choice.pad.expect("no pad chosen");
        assert_ne!(got, 0, "respawned on top of the living player");

        let expected = pads
            .iter()
            .map(|p| {
                let d = (Vec2::new(p.pos.x as f32, p.pos.y as f32) - occupied).len();
                (p.id, d)
            })
            .max_by(|a, b| a.1.total_cmp(&b.1))
            .expect("pads")
            .0;
        assert_eq!(got, expected, "not the furthest pad");
    }

    /// The assertion that `docs/21` §4's fallback is unreachable.
    ///
    /// Fifty deaths against a map carved to pieces. The control is the carving
    /// itself: `the_carving_actually_destroys_the_map` proves the fixture is doing
    /// something, or "no fallback fired" would be true of a map nobody touched.
    #[test]
    fn a_pad_respawn_never_falls_back_on_a_map_carved_to_pieces() {
        let mut map = generate(8123, MapScale::Medium);
        carve_the_map_to_pieces(&mut map);
        let mut rng = substream(9, "test");

        for i in 0..50 {
            // Move the "living" around so the choice moves with them.
            let living = [Vec2::new((i * 61 % 3000) as f32, (i * 37 % 1400) as f32)];
            let choice = choose_respawn_pad(&map, &living, &mut rng);
            let pad = choice
                .pad
                .unwrap_or_else(|| panic!("death {i}: fell back — a pad was destroyed"));
            let p = map.meta.teleport_pads[pad as usize];
            assert!(
                crate::map::gen::surface::is_standable(&map.mask, p.pos.x, p.pos.y),
                "death {i}: pad {pad} at {:?} is not standable",
                p.pos
            );
        }
    }

    #[test]
    fn the_carving_actually_destroys_the_map() {
        let mut map = generate(8123, MapScale::Medium);
        let before = map.mask.count_solid();
        carve_the_map_to_pieces(&mut map);
        let after = map.mask.count_solid();
        assert!(
            after * 2 < before,
            "the fixture removed only {} of {before} px, so it is not 'carved to pieces'",
            before - after
        );
    }

    #[test]
    fn two_consecutive_deaths_do_not_always_give_the_same_pad() {
        // §C5's second bug: respawn "always in the same spot". With the living
        // moving — which they do — consecutive deaths must land differently.
        let map = generate(777, MapScale::Medium);
        let mut rng = substream(3, "test");
        let mut seen = std::collections::HashSet::new();
        let pads = &map.meta.teleport_pads;
        for pad in pads {
            let living = [Vec2::new(pad.pos.x as f32, pad.pos.y as f32)];
            if let Some(id) = choose_respawn_pad(&map, &living, &mut rng).pad {
                seen.insert(id);
            }
        }
        assert!(
            seen.len() > 1,
            "every death returned the same pad: {seen:?}"
        );
    }

    #[test]
    fn a_map_with_no_pads_falls_back_rather_than_panicking() {
        let mut map = generate(11, MapScale::Small);
        map.meta.teleport_pads.clear();
        let mut rng = substream(5, "test");
        let choice = choose_respawn_pad(&map, &[], &mut rng);
        assert_eq!(choice.pad, None);
        assert!(choice.pos.x.is_finite() && choice.pos.y.is_finite());
    }
}
