//! T22.10 — the breach vortex: a hole in the space rim that recycles whoever it
//! catches (owner: *"it creates a vortex that sucks you in and pops you back out in a
//! random location on the map"*).
//!
//! **The rim is the only thing keeping players in the arena, and a hole in it is a
//! way out. This is what makes that not true.** Breaching the rim does not let you
//! leave, it recycles you — **containment dressed as a reward**, which is why it
//! works as a secret rather than an exploit. It is not decoration: a build that makes
//! it optional ships a player floating off the map. `space::rim_is_closed` is the
//! generation-time half (the map is born closed); this is the runtime half (a hole
//! is a vortex, not an exit). Both claims stand.
//!
//! Where each rule lives (`M22-RULINGS` R9, R11, R16, R19):
//! - **detection**: `Map::carve_circle` / `Map::carve_capsule` (`map::carve`), once
//!   per carve call — never at the call sites, of which there are seven;
//! - **the pull**: `attractors::Attractor::vortex`, summed by the one `field_at`
//!   beside the asteroid wells, on both sides through `attractors::env_at`;
//! - **the rules here**: which breach is a new vortex, the cap of three, who is
//!   caught. Pure functions over the list, so they are testable without a world.

use crate::constants::{MAX_ACTIVE_VORTICES, VORTEX_CAPTURE_R};
use crate::math::Vec2;

/// One live vortex. The list is kept in opening order, which is the order both
/// sides sum the pull in (R11: the order is part of the contract).
#[derive(Copy, Clone, Debug, PartialEq)]
pub struct Vortex {
    pub id: u32,
    pub pos: Vec2,
}

/// What a breach did to the list.
#[derive(Copy, Clone, Debug, PartialEq, Eq)]
pub enum Opened {
    /// The breach is inside an existing vortex's capture radius: the same hole,
    /// widened. Nothing changes.
    SameHole,
    /// A new vortex `id`, and the oldest one it displaced past the cap, if any
    /// (R9, point 2: a fourth breach replaces the oldest, which stops pulling).
    New { id: u32, replaced: Option<u32> },
}

/// A breach at `at`. **Many holes, at most three vortices** (R9): a breach within
/// `VORTEX_CAPTURE_R` of a live vortex is that vortex's hole, and anything further
/// is a new one — which is also what keeps every part of a widened hole inside some
/// vortex's capture disc (`VORTEX_CAPTURE_R`'s basis).
pub fn open(vortices: &mut Vec<Vortex>, seq: &mut u32, at: Vec2) -> Opened {
    if vortices
        .iter()
        .any(|v| (v.pos - at).len() <= VORTEX_CAPTURE_R)
    {
        return Opened::SameHole;
    }
    let id = *seq;
    *seq = seq.wrapping_add(1);
    vortices.push(Vortex { id, pos: at });
    let replaced = (vortices.len() > MAX_ACTIVE_VORTICES).then(|| vortices.remove(0).id);
    Opened::New { id, replaced }
}

/// The vortex that catches a body centred at `pos`, if any: the first in opening
/// order within `VORTEX_CAPTURE_R`. **Everyone** — wings included (R9, point 1).
/// Wings refuse pads and gun platforms because those are things you *choose to
/// use*; a vortex is a thing that happens to you. `World::fire_pads` carries the
/// other half of that sentence.
pub fn captor(vortices: &[Vortex], pos: Vec2) -> Option<u32> {
    vortices
        .iter()
        .find(|v| (v.pos - pos).len() <= VORTEX_CAPTURE_R)
        .map(|v| v.id)
}

/// The live centres as a fixed array, for `attractors::env_at` — no allocation in
/// the tick, in opening order.
pub fn centres(vortices: &[Vortex]) -> ([Vec2; MAX_ACTIVE_VORTICES], usize) {
    let mut out = [Vec2::ZERO; MAX_ACTIVE_VORTICES];
    let n = vortices.len().min(MAX_ACTIVE_VORTICES);
    for (o, v) in out.iter_mut().zip(vortices) {
        *o = v.pos;
    }
    (out, n)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_breach_inside_a_live_vortex_is_the_same_hole_and_one_outside_is_new() {
        let (mut vs, mut seq) = (Vec::new(), 0);
        assert_eq!(
            open(&mut vs, &mut seq, Vec2::new(500.0, 100.0)),
            Opened::New {
                id: 0,
                replaced: None
            }
        );
        // The same hole, widened by a second carve right beside it.
        let beside = Vec2::new(500.0 + VORTEX_CAPTURE_R * 0.9, 100.0);
        assert_eq!(open(&mut vs, &mut seq, beside), Opened::SameHole);
        assert_eq!(vs.len(), 1);
        // The control: just past the radius is a hole of its own.
        let apart = Vec2::new(500.0 + VORTEX_CAPTURE_R * 1.1, 100.0);
        assert_eq!(
            open(&mut vs, &mut seq, apart),
            Opened::New {
                id: 1,
                replaced: None
            }
        );
    }

    /// R9, point 2: the fourth replaces the oldest, and the list never exceeds the cap.
    #[test]
    fn at_most_three_and_a_fourth_replaces_the_oldest() {
        let (mut vs, mut seq) = (Vec::new(), 0);
        let apart = VORTEX_CAPTURE_R * 3.0;
        for i in 0..MAX_ACTIVE_VORTICES {
            open(&mut vs, &mut seq, Vec2::new(i as f32 * apart, 0.0));
        }
        assert_eq!(vs.len(), MAX_ACTIVE_VORTICES);
        let fourth = open(&mut vs, &mut seq, Vec2::new(10.0 * apart, 0.0));
        assert_eq!(
            fourth,
            Opened::New {
                id: MAX_ACTIVE_VORTICES as u32,
                replaced: Some(0)
            }
        );
        assert_eq!(vs.len(), MAX_ACTIVE_VORTICES);
        assert_eq!(vs.iter().map(|v| v.id).collect::<Vec<_>>(), vec![1, 2, 3]);
        // The replaced one's hole is open again: a breach there is a new vortex.
        assert!(matches!(
            open(&mut vs, &mut seq, Vec2::new(0.0, 0.0)),
            Opened::New { .. }
        ));
    }

    #[test]
    fn capture_is_a_radius_and_the_first_in_opening_order_wins() {
        let vs = vec![
            Vortex {
                id: 7,
                pos: Vec2::new(0.0, 0.0),
            },
            Vortex {
                id: 9,
                pos: Vec2::new(10.0, 0.0),
            },
        ];
        assert_eq!(captor(&vs, Vec2::new(5.0, 0.0)), Some(7));
        assert_eq!(captor(&vs, Vec2::new(0.0, VORTEX_CAPTURE_R - 0.5)), Some(7));
        assert_eq!(captor(&vs, Vec2::new(0.0, -VORTEX_CAPTURE_R - 12.0)), None);
        let (c, n) = centres(&vs);
        assert_eq!(&c[..n], &[Vec2::new(0.0, 0.0), Vec2::new(10.0, 0.0)]);
    }
}

/// The vortex in a running space round, through `World::step` — the carve sites'
/// own chokepoint, the stage that opens and takes, and R16's void beside it.
#[cfg(test)]
mod world_tests {
    use crate::constants::{
        GravityMode, MapScale, DEFAULT_MAP_GENERATOR, METEOR_CARVE_R, SIM_DT, SPACE_MAX_SPEED,
    };
    use crate::math::Vec2;
    use crate::physics::body::Body;
    use crate::player::state::DeathCause;
    use crate::world::{GameEvent, RoundPhase, World};

    /// One tick with an idle input queued for ana — the world only integrates a
    /// player it has an input for.
    fn step(w: &mut World) {
        let seq = w.tick + 1;
        w.queue_input(0, crate::player::input::Input::new(seq, 0, 0));
        w.step(SIM_DT);
    }

    fn space_world(seed: u64) -> World {
        let mut w = World::with_gravity(
            seed,
            MapScale::Small,
            0,
            DEFAULT_MAP_GENERATOR,
            GravityMode::Space,
        );
        w.set_round_seconds(600.0);
        w.set_phase(RoundPhase::Playing);
        w.add_player(0, 0, "ana".into());
        w
    }

    /// Carve straight through the rim's top arc, as a meteor would, and step once.
    /// Returns the rim point the hole is at.
    fn breach_top(w: &mut World) -> Vec2 {
        let geo = w.map.space_geometry().expect("space");
        let (tx, ty) = (geo.cx.round() as i32, (geo.cy - geo.ry).round() as i32);
        // Parked well inside the arena, so the step that opens the vortex takes nobody.
        w.players[0].body = Body::new(Vec2::new(geo.cx, geo.cy));
        let _ = w.map.carve_circle(tx, ty, METEOR_CARVE_R as i32);
        step(w);
        Vec2::new(tx as f32, ty as f32)
    }

    fn opened(events: &[GameEvent]) -> usize {
        events
            .iter()
            .filter(|e| matches!(e, GameEvent::VortexOpen { .. }))
            .count()
    }

    /// **A breach makes a vortex, and a captured player comes out somewhere valid**
    /// — inside the rim, in air a body fits, at rest, with the fuel they went in
    /// with. Over twelve maps: a population claim, not one draw.
    #[test]
    fn a_breach_opens_a_vortex_and_what_it_takes_comes_out_inside_the_arena() {
        for seed in 0..12u64 {
            let mut w = space_world(seed);
            let hole = breach_top(&mut w);
            assert_eq!(
                opened(&w.drain_events()),
                1,
                "seed {seed}: the breach opened no vortex"
            );
            assert_eq!(w.vortices.len(), 1);
            let v = w.vortices[0].pos;
            assert!(
                (v - hole).len() <= 1.5,
                "seed {seed}: the vortex is not at the hole"
            );

            w.players[0].body = Body::new(v);
            w.players[0].body.vel = Vec2::new(0.0, -SPACE_MAX_SPEED);
            w.players[0].jetpack.fuel = 0.37;
            step(&mut w);
            let trips = w
                .drain_events()
                .into_iter()
                .filter(|e| matches!(e, GameEvent::VortexTrip { id: 0, .. }))
                .count();
            assert_eq!(
                trips, 1,
                "seed {seed}: a player on the vortex was not taken"
            );
            let p = &w.players[0];
            let geo = w.map.space_geometry().expect("space");
            assert!(p.alive, "seed {seed}");
            assert!(
                geo.inside(p.body.pos.x, p.body.pos.y),
                "seed {seed}: popped out at {:?}",
                p.body.pos
            );
            assert!(
                !crate::physics::collide::aabb_overlaps_solid(&w.map, p.body.aabb()),
                "seed {seed}: popped out inside rock at {:?}",
                p.body.pos
            );
            assert_eq!(p.body.vel, Vec2::ZERO, "seed {seed}: arrived still moving");
            assert!(
                (p.jetpack.fuel - 0.37).abs() < 1e-6,
                "seed {seed}: the fuel did not survive the trip"
            );
        }
    }

    /// **You cannot leave through the hole** — the point of the feature. A player
    /// driven straight out through a breach at the fastest a body moves is inside
    /// the arena a moment later. **The control is the same drive with the vortex
    /// gone**: the hole is then an exit, and R16's void takes them — so the first
    /// half is the vortex's doing and not a wall nobody opened.
    #[test]
    fn you_cannot_leave_through_the_hole_and_without_the_vortex_the_void_takes_you() {
        for with_vortex in [true, false] {
            let mut w = space_world(4242);
            let hole = breach_top(&mut w);
            let _ = w.drain_events();
            if !with_vortex {
                w.vortices.clear();
            }
            w.players[0].body = Body::new(hole + Vec2::new(0.0, 200.0));
            let (mut trips, mut void) = (0, 0);
            for _ in 0..90 {
                w.players[0].body.vel = Vec2::new(0.0, -SPACE_MAX_SPEED);
                step(&mut w);
                for e in w.drain_events() {
                    match e {
                        GameEvent::VortexTrip { id: 0, .. } => trips += 1,
                        GameEvent::Death {
                            victim: 0,
                            cause: DeathCause::Void,
                            ..
                        } => void += 1,
                        _ => {}
                    }
                }
                if void > 0 {
                    break;
                }
            }
            let geo = w.map.space_geometry().expect("space");
            if with_vortex {
                assert!(trips >= 1, "never taken");
                assert_eq!(void, 0, "the void took a player the vortex should have");
                let p = &w.players[0];
                assert!(
                    p.alive && geo.inside(p.body.pos.x, p.body.pos.y),
                    "left the arena: {:?}",
                    p.body.pos
                );
            } else {
                assert_eq!(trips, 0);
                assert_eq!(
                    void, 1,
                    "control: out through an unguarded hole and nothing took them"
                );
            }
        }
    }

    /// **R9, point 1: it catches a player wearing wings.** Wings refuse pads because
    /// a pad is something you choose; a vortex happens to you.
    #[test]
    fn the_vortex_takes_a_player_wearing_wings() {
        let mut w = space_world(4242);
        breach_top(&mut w);
        crate::world::give(&mut w, 0, crate::items::registry::UNICORN_WINGS, 1);
        assert!(w.players[0].holds_utility(crate::items::registry::UtilityId::UnicornWings));
        w.players[0].body = Body::new(w.vortices[0].pos);
        let _ = w.drain_events();
        step(&mut w);
        assert!(w
            .drain_events()
            .iter()
            .any(|e| matches!(e, GameEvent::VortexTrip { id: 0, .. })));
    }

    /// **It pulls, through the one summation** (R11): a player near a vortex is
    /// accelerated toward it by `env_at`, and the same world with the vortex gone is
    /// not. Speed toward the hole after a quarter second, both ways.
    #[test]
    fn a_vortex_pulls_toward_itself_and_the_control_without_one_does_not() {
        let mut pulled = Vec::new();
        for with_vortex in [true, false] {
            let mut w = space_world(4242);
            let hole = breach_top(&mut w);
            if !with_vortex {
                w.vortices.clear();
            }
            let at = hole + Vec2::new(0.0, crate::constants::VORTEX_CAPTURE_R * 1.5);
            w.players[0].body = Body::new(at);
            for _ in 0..15 {
                step(&mut w);
            }
            pulled.push(-w.players[0].body.vel.y);
        }
        // The control is not zero — an asteroid's well reaches this point too — so
        // what is the vortex's is the difference, against the shape it is built on.
        let d = crate::constants::VORTEX_CAPTURE_R * 1.5;
        let want = crate::constants::VORTEX_ACCEL_MAX
            * (1.0 - d / crate::constants::VORTEX_REACH)
            * 15.0
            * SIM_DT;
        let got = pulled[0] - pulled[1];
        assert!(
            (0.8 * want..1.3 * want).contains(&got),
            "the vortex added {got} px/s toward itself, its shape says {want}: {pulled:?}"
        );
    }

    /// **R16's void is outside the rim, past a grace band** — and not inside it.
    #[test]
    fn past_the_rim_and_its_band_is_the_void_and_inside_the_band_is_not() {
        let w = space_world(4242);
        let geo = w.map.space_geometry().expect("space");
        let outer = geo.cy - geo.ry - geo.thickness * 0.5;
        let band = crate::constants::SPACE_VOID_GRACE;
        assert!(
            !geo.in_the_void(geo.cx, outer - band + 2.0),
            "inside the band is not the void"
        );
        assert!(
            geo.in_the_void(geo.cx, outer - band - 2.0),
            "past the band is"
        );
        assert!(
            !geo.in_the_void(geo.cx, geo.cy),
            "control: the arena's middle"
        );
    }

    /// Replays agree: the same breach and the same capture give the same hash.
    #[test]
    fn two_runs_of_a_capture_hash_the_same() {
        let run = || {
            let mut w = space_world(77);
            breach_top(&mut w);
            w.players[0].body = Body::new(w.vortices[0].pos);
            for _ in 0..30 {
                step(&mut w);
            }
            w.state_hash()
        };
        assert_eq!(run(), run());
    }
}

/// **Every carve path opens one** — asserted per path, not per carve function, so a
/// site that one day reaches the mask some other way goes red here (R19's census:
/// `explode.rs` ×2, `bullet.rs`, `flame.rs`, `melee.rs`, `lava.rs`,
/// `world::detonate`). Each path gets a rim thinned to a two-pixel membrane on the
/// centreline — written straight into the mask, beneath the chokepoint — so even a
/// six-pixel toxic bite completes a hole, and each is asked for exactly one breach.
#[cfg(test)]
mod every_carve_path {
    use crate::constants::{MapGenerator, MapScale, PLAYER_H};
    use crate::items::registry::{
        WEAPON_BAZOOKA, WEAPON_LASER_PISTOL, WEAPON_PISTOL, WEAPON_SHOVEL, WEAPON_TOXIC_DROP,
    };
    use crate::map::Map;
    use crate::math::Vec2;
    use crate::weapons::defs::def;
    use crate::weapons::explode::BlastSource;

    /// A space map whose rim's top arc has a corridor cut through it except for a
    /// membrane two rows thick at the centreline; returns the membrane's centre.
    fn membrane(map: &mut Map) -> Vec2 {
        let geo = map.space_geometry().expect("space");
        let (tx, ty) = (geo.cx.round() as i32, (geo.cy - geo.ry).round() as i32);
        let t = geo.thickness as i32;
        for y in (ty - t)..=(ty + t) {
            if y == ty || y == ty - 1 {
                continue;
            }
            map.mask.clear_run(y, tx - 5, tx + 5);
        }
        assert!(
            map.take_breaches().is_empty(),
            "the fixture itself is not a breach"
        );
        assert!(
            crate::map::gen::space::rim_is_closed(&map.mask, &geo),
            "control: the membrane still closes the rim"
        );
        Vec2::new(tx as f32, ty as f32)
    }

    fn space_map() -> Map {
        crate::map::meta::generate_with(4242, MapScale::Small, MapGenerator::Space)
    }

    fn src(w: crate::items::registry::WeaponId) -> BlastSource {
        BlastSource::Fired {
            owner: 0,
            weapon: w,
        }
    }

    #[test]
    fn an_explosion_opens_one() {
        let mut map = space_map();
        let at = membrane(&mut map);
        crate::weapons::explode::explode(&mut map, &mut [], at, 4.0, 1.0, src(WEAPON_BAZOOKA));
        assert_eq!(map.take_breaches().len(), 1);
    }

    #[test]
    fn a_bullet_opens_one() {
        let mut map = space_map();
        let at = membrane(&mut map);
        let pistol = def(WEAPON_PISTOL).expect("pistol");
        crate::weapons::bullet::resolve(&mut map, &mut [], pistol, at, None, src(WEAPON_PISTOL));
        assert_eq!(map.take_breaches().len(), 1);
    }

    #[test]
    fn a_hitscan_shot_opens_one() {
        let mut map = space_map();
        let at = membrane(&mut map);
        let laser = def(WEAPON_LASER_PISTOL).expect("laser");
        let mut rng = crate::rng::substream(1, "test");
        // From inside the arena, straight up the corridor at the membrane.
        let from = at + Vec2::new(0.0, 30.0);
        crate::weapons::explode::fire_hitscan(
            &mut map,
            &mut [],
            laser,
            0,
            from,
            -std::f32::consts::FRAC_PI_2,
            &mut rng,
            0.0,
        );
        assert_eq!(map.take_breaches().len(), 1);
    }

    #[test]
    fn a_shovel_opens_one() {
        let mut map = space_map();
        let at = membrane(&mut map);
        let shovel = def(WEAPON_SHOVEL).expect("shovel");
        let origin = at + Vec2::new(0.0, PLAYER_H * 0.5 + 4.0);
        crate::weapons::melee::swing(
            &mut map,
            &mut [],
            origin,
            -std::f32::consts::FRAC_PI_2,
            shovel,
            crate::constants::SHOVEL_REACH,
            crate::constants::SHOVEL_ARC,
            0.0,
            src(WEAPON_SHOVEL),
        );
        assert_eq!(map.take_breaches().len(), 1, "one swing, one breach");
    }

    /// A resting flame's scorch (`FLAME_SCORCH_R`, three pixels) on the membrane.
    /// Stepped under standard gravity so it falls onto the membrane and rests: a
    /// space flame floats and never scorches, which is the flame's rule, not this one.
    #[test]
    fn a_flame_scorch_opens_one() {
        let mut map = space_map();
        let at = membrane(&mut map);
        let mut ps = crate::weapons::projectile::Projectiles::new();
        ps.spawn_raw(
            crate::items::registry::WEAPON_FLAME,
            0,
            at - Vec2::new(0.0, 4.0),
            Vec2::ZERO,
            0.0,
        );
        let mut now = 0.0;
        while now < 4.0 * crate::constants::FLAME_SCORCH_EVERY && map.breaches.is_empty() {
            now += crate::constants::SIM_DT;
            ps.step(
                &map,
                &[],
                &[],
                0.0,
                crate::constants::GravityMode::Standard,
                now,
                crate::constants::SIM_DT,
            );
            crate::weapons::flame::tick(&ps, &mut map, &mut [], now, crate::constants::SIM_DT);
        }
        assert_eq!(map.take_breaches().len(), 1);
    }

    #[test]
    fn a_toxic_drop_bite_opens_one() {
        let mut w = crate::world::World::with_gravity(
            4242,
            MapScale::Small,
            0,
            MapGenerator::Space,
            crate::constants::GravityMode::Space,
        );
        let at = membrane(&mut w.map);
        w.land_on_terrain_for_test(at, WEAPON_TOXIC_DROP, 0.0);
        assert_eq!(w.map.take_breaches().len(), 1);
    }
}
