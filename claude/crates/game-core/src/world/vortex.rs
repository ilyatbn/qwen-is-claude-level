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

use crate::constants::{MAX_ACTIVE_VORTICES, VORTEX_CAPTURE_R, VORTEX_REACH};
use crate::math::Vec2;

/// One live vortex. The list is kept in opening order, which is the order both
/// sides sum the pull in (R11: the order is part of the contract).
#[derive(Copy, Clone, Debug, PartialEq)]
pub struct Vortex {
    pub id: u32,
    pub pos: Vec2,
}

/// What a breach did to the list.
#[derive(Copy, Clone, Debug, PartialEq)]
pub enum Opened {
    /// The breach is inside an existing vortex's capture radius: the same hole,
    /// widened. Nothing changes.
    SameHole,
    /// A new vortex `id`, and the oldest one it displaced past the cap, if any
    /// (R9, point 2: a fourth breach replaces the oldest, which stops pulling).
    /// **Returned whole, not as an id**: the caller keeps it catching (R88), so
    /// it needs the position the list just forgot.
    New { id: u32, replaced: Option<Vortex> },
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
    let replaced = (vortices.len() > MAX_ACTIVE_VORTICES).then(|| vortices.remove(0));
    Opened::New { id, replaced }
}

/// A vortex the cap displaced joins the spent list, where it keeps catching
/// (R88) — **unless a spent one already sits within `VORTEX_CAPTURE_R` of it**
/// (T22.10D F11). `open` merges only against the *pulling* list, so a hole whose
/// vortex was displaced opens a fresh one when it is breached again, and that one
/// is displaced in its turn: without this, every cycle appended a second spent
/// vortex at the same hole — the list grew without bound for a hole that was one
/// hole, and every capture and clearance walked all of them. The earlier entry
/// already catches there. Returns whether it was added.
pub fn retire(spent: &mut Vec<Vortex>, old: Vortex) -> bool {
    if spent
        .iter()
        .any(|v| (v.pos - old.pos).len() <= VORTEX_CAPTURE_R)
    {
        return false;
    }
    spent.push(old);
    true
}

/// The vortex that catches a body centred at `pos`, if any: the first within
/// `VORTEX_CAPTURE_R`, the pulling ones in opening order and then the spent ones.
/// **Everyone** — wings included (R9, point 1). Wings refuse pads and gun
/// platforms because those are things you *choose to use*; a vortex is a thing
/// that happens to you. `World::fire_pads` carries the other half of that sentence.
///
/// **`spent` catches too** (`M22-RULINGS` R88): a vortex the cap displaced stops
/// pulling, but its hole is still open — a hole never heals (R9, point 3) — and a
/// hole in the rim never kills. Only the *pull* is capped at three.
pub fn captor(vortices: &[Vortex], spent: &[Vortex], pos: Vec2) -> Option<u32> {
    vortices
        .iter()
        .chain(spent)
        .find(|v| capture_clearance(v, pos) <= 0.0)
        .map(|v| v.id)
}

/// How far a body centre at `pos` is outside `v`'s capture radius, px — zero or less
/// is caught. [`captor`]'s test, and the bots' keep-out from a **spent** hole, which
/// catches (R88) but no longer pulls (T22.14B: one predicate, not a copy).
pub fn capture_clearance(v: &Vortex, pos: Vec2) -> f32 {
    (v.pos - pos).len() - VORTEX_CAPTURE_R
}

/// How far `pos` is outside the reach of a **live** vortex's pull, px (negative
/// inside) — `attractors::Attractor::vortex`'s reach, past which it pulls nothing.
/// The bots' keep-out from a live hole (T22.14B M5): anywhere inside it a body at rest
/// is drawn in, so a bot that stops there holds station on thrust until its tank runs
/// dry — and then it is taken.
pub fn pull_clearance(v: &Vortex, pos: Vec2) -> f32 {
    (v.pos - pos).len() - VORTEX_REACH
}

/// How far `centre` is outside the `VORTEX_REACH / 2` disc of every hole, px —
/// negative inside one. The clearance `World::step_vortices` hands the shared picker
/// (`Map::random_body_site_where`, `M22-RULINGS` R86): **a caught player is put
/// down beyond `VORTEX_REACH / 2` of every hole**, so the trip cannot deliver them
/// into a second vortex's mouth. *Not a no-escape disc* (T22.14A L): R86 set the
/// distance when thrust stopped winning there; since R97 thrust beats every vortex's
/// pull outside the capture radius, and the half-reach stands as a margin, not a
/// line. Spent holes are held to the same distance although they no longer pull:
/// one number, and the stricter one.
pub fn clearance(vortices: &[Vortex], spent: &[Vortex], centre: Vec2) -> f32 {
    vortices
        .iter()
        .chain(spent)
        .map(|v| (v.pos - centre).len() - VORTEX_REACH * 0.5)
        .fold(f32::INFINITY, f32::min)
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
                replaced: Some(Vortex {
                    id: 0,
                    pos: Vec2::new(0.0, 0.0)
                })
            }
        );
        assert_eq!(vs.len(), MAX_ACTIVE_VORTICES);
        assert_eq!(vs.iter().map(|v| v.id).collect::<Vec<_>>(), vec![1, 2, 3]);
        // A breach at the replaced one's hole pulls again as a new vortex (the
        // merge asks only the pulling list); the spent one keeps catching (R88).
        assert!(matches!(
            open(&mut vs, &mut seq, Vec2::new(0.0, 0.0)),
            Opened::New { .. }
        ));
    }

    /// T22.10D F11: one hole, breached again every time its vortex is
    /// displaced, is one spent entry — not one per cycle. The control: a hole
    /// just past the radius is retired as its own.
    #[test]
    fn a_hole_re_breached_after_it_was_displaced_is_spent_once() {
        let (mut vs, mut seq, mut spent) = (Vec::new(), 0, Vec::new());
        let apart = VORTEX_CAPTURE_R * 3.0;
        let hole = Vec2::new(0.0, 0.0);
        let cycles = 4 * MAX_ACTIVE_VORTICES;
        for i in 0..cycles {
            // The hole again, then enough other holes to push it out.
            for at in std::iter::once(hole).chain(
                (1..=MAX_ACTIVE_VORTICES).map(|k| Vec2::new((i * 10 + k) as f32 * apart, 0.0)),
            ) {
                if let Opened::New {
                    replaced: Some(old),
                    ..
                } = open(&mut vs, &mut seq, at)
                {
                    retire(&mut spent, old);
                }
            }
        }
        let at_hole = spent
            .iter()
            .filter(|v| (v.pos - hole).len() <= VORTEX_CAPTURE_R)
            .count();
        assert_eq!(
            at_hole, 1,
            "{cycles} displacements of one hole left {at_hole} spent vortices on it"
        );
        let beside = Vortex {
            id: 99,
            pos: hole + Vec2::new(0.0, VORTEX_CAPTURE_R * 1.1),
        };
        assert!(
            retire(&mut spent, beside),
            "control: a hole of its own was refused"
        );
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
        assert_eq!(captor(&vs, &[], Vec2::new(5.0, 0.0)), Some(7));
        assert_eq!(
            captor(&vs, &[], Vec2::new(0.0, VORTEX_CAPTURE_R - 0.5)),
            Some(7)
        );
        assert_eq!(
            captor(&vs, &[], Vec2::new(0.0, -VORTEX_CAPTURE_R - 12.0)),
            None
        );
        // R88: a spent vortex catches, after every pulling one.
        let spent = [Vortex {
            id: 3,
            pos: Vec2::new(0.0, -VORTEX_CAPTURE_R - 12.0),
        }];
        assert_eq!(
            captor(&vs, &spent, Vec2::new(0.0, -VORTEX_CAPTURE_R - 12.0)),
            Some(3)
        );
        assert_eq!(captor(&vs, &spent, Vec2::new(5.0, 0.0)), Some(7));
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

    /// Breach the top, left and right arcs, one step each, so three vortices pull.
    fn three_vortices(w: &mut World) {
        let geo = w.map.space_geometry().expect("space");
        breach_top(w);
        for (x, y) in [(geo.cx - geo.rx, geo.cy), (geo.cx + geo.rx, geo.cy)] {
            let _ = w
                .map
                .carve_circle(x.round() as i32, y.round() as i32, METEOR_CARVE_R as i32);
            step(w);
        }
        assert_eq!(
            w.vortices.len(),
            3,
            "control: three breaches, three vortices"
        );
        let _ = w.drain_events();
    }

    /// T22.10D F11, **through the world's own step** — `retire`'s live call site.
    /// Three vortices, a fourth displaces the top one; then a narrow carve just
    /// clear of the top hole's probe box, but inside its capture radius, breaches
    /// the rim again there: `open` merges only against the pulling list, so that is
    /// a new vortex at the same hole. Three more fresh holes displace it too. The
    /// top hole must then be spent **once**, not twice.
    #[test]
    fn a_hole_re_breached_after_it_was_displaced_is_spent_once_in_the_world() {
        use crate::constants::{SPACE_RIM_THICKNESS, VORTEX_CAPTURE_R};
        let mut w = space_world(4242);
        three_vortices(&mut w);
        let geo = w.map.space_geometry().expect("space");
        let top = Vec2::new(geo.cx, geo.cy - geo.ry);
        let breach = |w: &mut World, (x, y): (i32, i32), r: i32| {
            w.players[0].body = Body::new(Vec2::new(geo.cx, geo.cy));
            let _ = w.map.carve_circle(x, y, r);
            step(w);
            opened(&w.drain_events())
        };
        let at = |t: f32| geo.onto_rim(geo.cx + geo.rx * t.cos(), geo.cy + geo.ry * t.sin());
        use std::f32::consts::PI;
        assert_eq!(
            breach(&mut w, at(PI / 2.0), METEOR_CARVE_R as i32),
            1,
            "control: the fourth"
        );
        assert_eq!(w.spent_vortices.len(), 1, "control: the top one displaced");
        // Just wide enough to cut the rim; far enough along it that its probe box
        // misses the top hole, near enough to be inside that hole's capture radius.
        let narrow = (SPACE_RIM_THICKNESS / 2 + 2) as i32;
        let along = (VORTEX_CAPTURE_R - 12.0).round();
        let again = geo.onto_rim(top.x + along, top.y);
        assert!(
            (Vec2::new(again.0 as f32, again.1 as f32) - top).len() <= VORTEX_CAPTURE_R,
            "control: the re-breach is not at the top hole"
        );
        assert_eq!(
            breach(&mut w, again, narrow),
            1,
            "control: the re-breach opened nothing"
        );
        for t in [PI / 4.0, 3.0 * PI / 4.0, 5.0 * PI / 4.0] {
            assert_eq!(
                breach(&mut w, at(t), METEOR_CARVE_R as i32),
                1,
                "control: a fresh hole at {t}"
            );
        }
        let at_top = w
            .spent_vortices
            .iter()
            .filter(|v| (v.pos - top).len() <= VORTEX_CAPTURE_R)
            .count();
        assert!(
            w.spent_vortices
                .iter()
                .any(|v| (v.pos - top).len() > VORTEX_CAPTURE_R),
            "control: nothing else was spent, so the count below is not about retiring"
        );
        assert_eq!(
            at_top, 1,
            "the top hole is spent {at_top} times: {:?}",
            w.spent_vortices
        );
    }

    /// **An idle player caught by a vortex never dies in the void** (T22.10C F1,
    /// R86) — the review's shape: at rest 1.5 capture radii inside a live vortex,
    /// with three of them pulling, over twelve maps, for ten seconds; once fresh and
    /// once with a pad's cooldown still running. Before R86 a running cooldown let
    /// the vortex decline, and the picker could put a caught player straight into
    /// another vortex's pull: 2–5 of 12 seeds died. The trips are counted too, so
    /// this cannot pass for a world where nobody was ever taken.
    #[test]
    fn an_idle_player_a_vortex_takes_never_dies_in_the_void() {
        use crate::constants::{TELEPORT_COOLDOWN, VORTEX_CAPTURE_R};
        for cooldown in [false, true] {
            let (mut died, mut taken) = (Vec::new(), 0);
            for seed in 0..12u64 {
                let mut trips = 0;
                let mut w = space_world(seed);
                three_vortices(&mut w);
                let v = w.vortices[0].pos;
                w.players[0].body = Body::new(v + Vec2::new(0.0, 1.5 * VORTEX_CAPTURE_R));
                if cooldown {
                    w.players[0].teleport.ready_at = w.round_time + TELEPORT_COOLDOWN;
                }
                for _ in 0..600 {
                    step(&mut w);
                    for e in w.drain_events() {
                        match e {
                            GameEvent::VortexTrip { id: 0, .. } => trips += 1,
                            GameEvent::Death {
                                victim: 0,
                                cause: DeathCause::Void,
                                ..
                            } => died.push(seed),
                            _ => {}
                        }
                    }
                }
                taken += usize::from(trips > 0);
            }
            // The control. Measured: 8 of 12 maps take the player; on the other
            // four they come to rest on an asteroid lip first, a well outweighing
            // the pull there — so this is a claim about captures, not about
            // players who never reached one.
            assert!(
                taken >= 6,
                "cooldown {cooldown}: control — only {taken} of 12 maps took the player"
            );
            assert!(
                died.is_empty(),
                "cooldown {cooldown}: the void took an idle player on seeds {died:?}"
            );
        }
    }

    /// **A trip lands clear of every hole's pull** (R86): the destination is past
    /// `VORTEX_REACH / 2` of every vortex — where thrust beats the pull — over twelve
    /// maps with three vortices. The ten-second test above passes without this
    /// half (measured: the capture ignoring the cooldown is enough to keep an idle
    /// player alive there), so this is the test that holds the destination rule.
    #[test]
    fn a_trip_lands_clear_of_every_holes_pull() {
        use crate::constants::VORTEX_REACH;
        for seed in 0..12u64 {
            let mut w = space_world(seed);
            three_vortices(&mut w);
            for k in 0..3 {
                let v = w.vortices[k].pos;
                w.players[0].body = Body::new(v);
                step(&mut w);
                let dest = w
                    .drain_events()
                    .into_iter()
                    .find_map(|e| match e {
                        GameEvent::VortexTrip { id: 0, x, y, .. } => Some(Vec2::new(x, y)),
                        _ => None,
                    })
                    .unwrap_or_else(|| panic!("seed {seed}: vortex {k} took nobody"));
                for u in &w.vortices {
                    let d = (u.pos - dest).len();
                    assert!(
                        d >= VORTEX_REACH * 0.5,
                        "seed {seed}: put down {d} px from vortex {}, inside its pull",
                        u.id
                    );
                }
            }
        }
    }

    /// **T22.12C F3: a trip never lands inside the black hole's reach** — the
    /// destination filter at its live binding (`World::step_vortices`' `clear`):
    /// the same map and the same trip twice, the second with the hole put on the very
    /// spot the first one landed — which the unfiltered draw would choose again (the
    /// control asserts the draw repeats without the hole).
    #[test]
    fn a_trip_never_lands_inside_the_black_holes_reach() {
        use crate::world::black_hole::{clearance, BlackHole};
        // H2 (T22.14A): `warned` puts the hole on the spot **telegraphed** rather
        // than here — it opens there two seconds later, so a trip landing there is
        // the same death with no warning.
        let trip = |hole: Option<(Vec2, bool)>| {
            let mut w = space_world(7);
            three_vortices(&mut w);
            if let Some((pos, warned)) = hole {
                w.black_hole = if warned {
                    BlackHole::Warned {
                        at: 1.0e6,
                        index: 0,
                        pos,
                    }
                } else {
                    BlackHole::Here { pos }
                };
            }
            let v = w.vortices[0].pos;
            w.players[0].body = Body::new(v);
            step(&mut w);
            w.drain_events()
                .into_iter()
                .find_map(|e| match e {
                    GameEvent::VortexTrip { id: 0, x, y, .. } => Some(Vec2::new(x, y)),
                    _ => None,
                })
                .expect("the vortex took nobody")
        };
        let first = trip(None);
        assert_eq!(
            trip(None),
            first,
            "control: the same trip did not land in the same place"
        );
        for warned in [false, true] {
            let dest = trip(Some((first, warned)));
            assert!(
                clearance(Some(first), dest) >= 0.0,
                "a trip landed {:.1} px from a hole (warned {warned}) on the spot the unfiltered \
                 draw picks",
                (dest - first).len()
            );
        }
    }

    /// **R88: a vortex the cap displaced stops pulling and keeps catching.** Four
    /// breaches; the first is spent. A player at rest beside its hole is not pulled
    /// (the control: the same spot beside a pulling one is), and a player on it is
    /// still taken — its hole never becomes an exit.
    #[test]
    fn a_spent_vortex_pulls_nothing_and_still_catches() {
        use crate::constants::VORTEX_CAPTURE_R;
        let four = || {
            let mut w = space_world(4242);
            three_vortices(&mut w);
            let geo = w.map.space_geometry().expect("space");
            let _ = w.map.carve_circle(
                geo.cx.round() as i32,
                (geo.cy + geo.ry).round() as i32,
                METEOR_CARVE_R as i32,
            );
            step(&mut w);
            w
        };
        let mut w = four();
        let geo = w.map.space_geometry().expect("space");
        assert_eq!(w.vortices.len(), 3, "the pull is capped at three");
        assert_eq!(w.spent_vortices.len(), 1, "the fourth displaced one");
        let spent = w.spent_vortices[0];
        assert!(
            w.drain_events()
                .iter()
                .any(|e| matches!(e, GameEvent::VortexClose { id, .. } if *id == spent.id)),
            "the displaced one was not announced as closed"
        );

        // Through the world's own step, not `env_at` by hand: a player at rest
        // 1.5 capture radii inward of a hole, for a quarter second, against the
        // same world with that hole's vortex removed. Spent: no difference.
        // Pulling (the control): a difference.
        let drift = |forget: &dyn Fn(&mut World), hole: Vec2| {
            let mut w = four();
            forget(&mut w);
            let inward = (Vec2::new(geo.cx, geo.cy) - hole).normalized();
            w.players[0].body = Body::new(hole + inward * 1.5 * VORTEX_CAPTURE_R);
            for _ in 0..15 {
                step(&mut w);
            }
            w.players[0].body.vel
        };
        let keep = |_: &mut World| {};
        assert_eq!(
            drift(&keep, spent.pos),
            drift(&|w: &mut World| w.spent_vortices.clear(), spent.pos),
            "a spent vortex still pulls"
        );
        let live = w.vortices[0].pos;
        assert_ne!(
            drift(&keep, live),
            drift(
                &|w: &mut World| {
                    w.vortices.remove(0);
                },
                live
            ),
            "control: a pulling vortex adds nothing either, so the absence proves nothing"
        );

        w.players[0].body = Body::new(spent.pos);
        step(&mut w);
        assert!(
            w.drain_events().iter().any(
                |e| matches!(e, GameEvent::VortexTrip { id: 0, vortex, .. } if *vortex == spent.id)
            ),
            "a spent vortex's hole let a player through"
        );
    }

    /// The dev seam `breach-vortex.mjs` drives (T22.10B): a hole on the ray through
    /// the player, announced as a `carve` (so a client's mirror cuts it too), and a
    /// vortex from it on the next step — through the chokepoint, not beside it.
    #[test]
    fn the_dev_breach_carves_through_the_blast_path_and_opens_a_vortex() {
        let mut w = space_world(4242);
        let geo = w.map.space_geometry().expect("space");
        let toward = Vec2::new(geo.cx - 100.0, geo.cy - 50.0);
        let at = w.dev_breach_toward(toward).expect("a space map");
        assert!(
            geo.distance_to_rim(at.x, at.y) <= 1.0,
            "not on the rim: {at:?}"
        );
        assert!(
            w.drain_events()
                .iter()
                .any(|e| matches!(e, GameEvent::Carve { .. })),
            "no carve event: a client's mirror would never cut the hole"
        );
        let placed = w.dev_place_inward_of(0, at).expect("somewhere inward fits");
        let d = (placed - at).len();
        assert!(
            d >= 1.5 * crate::constants::VORTEX_CAPTURE_R - 0.5,
            "placed inside the capture ring: {d}"
        );
        step(&mut w);
        assert_eq!(w.vortices.len(), 1, "the breach opened no vortex");
        assert!((w.vortices[0].pos - at).len() <= 1.5);
        // And the placement has a clear run: idle, the pull delivers the player.
        let _ = w.drain_events();
        let taken = (0..120).any(|_| {
            step(&mut w);
            w.drain_events()
                .iter()
                .any(|e| matches!(e, GameEvent::VortexTrip { id: 0, .. }))
        });
        assert!(taken, "placed at {placed:?}, never taken in two seconds");
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
    ///
    /// **Measured where R97's cap does not bind** (T22.03I): at 1.5 capture radii the
    /// vortex alone is 1125 px/s², over the cap, so the shape is read at
    /// `PROBE_REACH_FRAC` of the reach, where the capped sum equals the raw one —
    /// asserted, or the shape below would be the cap's.
    #[test]
    fn a_vortex_pulls_toward_itself_and_the_control_without_one_does_not() {
        use crate::constants::SPACE_WELL_ACCEL_MAX;
        let d = crate::constants::VORTEX_REACH * PROBE_REACH_FRAC;
        let (dir, hole) = {
            let mut w = space_world(4242);
            let hole = breach_top(&mut w);
            // Both arms under the cap for the whole approach's start: the wells alone
            // (the control) and the wells with the vortex.
            let under = |wells: Vec2, with: Vec2| {
                wells.len() < SPACE_WELL_ACCEL_MAX * 0.9 && with.len() < SPACE_WELL_ACCEL_MAX * 0.9
            };
            (
                probe(&w, hole, d, under).expect("no probe point under the cap"),
                hole,
            )
        };
        let mut pulled = Vec::new();
        for with_vortex in [true, false] {
            let mut w = space_world(4242);
            assert_eq!(breach_top(&mut w), hole);
            if !with_vortex {
                w.vortices.clear();
            }
            let at = hole + dir * d;
            w.players[0].body = Body::new(at);
            for _ in 0..15 {
                step(&mut w);
            }
            pulled.push(w.players[0].body.vel.dot(-dir));
        }
        // The control is not zero — an asteroid's well reaches this point too — so
        // what is the vortex's is the difference, against the shape it is built on.
        let want = crate::constants::VORTEX_ACCEL_MAX
            * (1.0 - d / crate::constants::VORTEX_REACH)
            * 15.0
            * SIM_DT;
        let got = pulled[0] - pulled[1];
        // The band, with its basis (T22.10C F8): `want` is the pull at the start
        // point, but the body closes on the vortex through the window — at most
        // `½·a·t²` at the start point's pull — and the linear falloff raises the
        // pull by that distance over what is left of the reach. That fraction
        // (≈ 11 % here) bounds the error both ways; measured: 0.991.
        let t = 15.0 * SIM_DT;
        let a = crate::constants::VORTEX_ACCEL_MAX * (1.0 - d / crate::constants::VORTEX_REACH);
        let band = 0.5 * a * t * t / (crate::constants::VORTEX_REACH - d);
        assert!(
            ((1.0 - band) * want..(1.0 + band) * want).contains(&got),
            "the vortex added {got} px/s toward itself, its shape says {want}: {pulled:?}"
        );
    }

    /// A direction into the arena from `hole` (the lower half-turn, 5° steps) whose
    /// point `d` px out a body fits at and where `ok(raw wells, raw wells + vortex)`
    /// holds — so a fixture states the condition it needs rather than trusting one
    /// map's layout.
    fn probe(w: &World, hole: Vec2, d: f32, ok: impl Fn(Vec2, Vec2) -> bool) -> Option<Vec2> {
        use crate::world::attractors::{asteroid_attractors, field_at, Attractor};
        (2..=34).find_map(|k| {
            let a = (k as f32 * 5.0).to_radians();
            let dir = Vec2::new(a.cos(), a.sin());
            let at = hole + dir * d;
            let fits = w.map.body_fits_at(crate::math::Point::new(
                at.x.round() as i32,
                at.y.round() as i32,
            ));
            let wells = field_at(asteroid_attractors(&w.map), at);
            let with = wells + Attractor::vortex(hole).pull_at(at);
            (fits && ok(wells, with)).then_some(dir)
        })
    }

    /// Where [`a_vortex_pulls_toward_itself_and_the_control_without_one_does_not`]
    /// reads the shape: three quarters of the reach, where the vortex alone is a
    /// quarter of `VORTEX_ACCEL_MAX` (450 px/s²) and under R97's cap with room for the
    /// wells there.
    const PROBE_REACH_FRAC: f32 = 0.75;

    /// **R97's presence control (T22.03I): capping the pull did not stop the vortex
    /// taking people.** Beside it the pull is the cap — no more — while the raw sum
    /// there is over it (so the cap is what binds); an idle body there is still drawn
    /// in and taken; a body inside the capture radius is taken on the next tick.
    #[test]
    fn beside_a_vortex_the_pull_is_the_cap_and_an_idle_body_is_still_taken() {
        use crate::constants::{SPACE_WELL_ACCEL_MAX, VORTEX_CAPTURE_R};
        use crate::world::attractors::{env_at, field_at, Attractor};
        let mut w = space_world(4242);
        let hole = breach_top(&mut w);
        let d = 1.5 * VORTEX_CAPTURE_R;
        let dir = probe(&w, hole, d, |_, with| with.len() > SPACE_WELL_ACCEL_MAX)
            .expect("control: nowhere 1.5 capture radii off is the raw sum over the cap");
        let at = hole + dir * d;
        let raw = field_at(
            crate::world::attractors::asteroid_attractors(&w.map)
                .chain(std::iter::once(Attractor::vortex(hole))),
            at,
        );
        let got = env_at(&w.map, GravityMode::Space, &[hole], None, false, at).accel;
        assert!(
            got.len() <= SPACE_WELL_ACCEL_MAX * (1.0 + 4.0 * f32::EPSILON) && got.dot(dir) < 0.0,
            "beside the vortex: {got:?} (raw {raw:?}), cap {SPACE_WELL_ACCEL_MAX}"
        );

        let taken_within = |w: &mut World, from: Vec2, ticks: u32| {
            w.players[0].body = Body::new(from);
            let _ = w.drain_events();
            (0..ticks).any(|_| {
                step(w);
                w.drain_events()
                    .iter()
                    .any(|e| matches!(e, GameEvent::VortexTrip { id: 0, .. }))
            })
        };
        assert!(
            taken_within(&mut w, at, (2.0 / SIM_DT) as u32),
            "an idle body 1.5 capture radii from the vortex was not taken in 2 s"
        );
        assert!(
            taken_within(&mut w, hole + Vec2::new(0.0, 0.9 * VORTEX_CAPTURE_R), 1),
            "a body inside the capture radius was not taken on the next tick"
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
