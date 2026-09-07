//! Lava bursts: the effect that punishes players who have dug themselves a hole.
//!
//! Timeline per vent, and getting this wrong by a phase is the most likely error
//! in the milestone (`docs/13-weather-effects.md` §5):
//!
//! ```text
//!   t=0                 t=3s              t=6s              t=9s
//!   |---- telegraph ----|---- jet -------|---- burn -------|
//!   (the scheduler's)    channel carved    flames spat out   out
//!                        LAVA_JET_DPS      LAVA_FLAMES_PER_SECOND
//! ```
//!
//! **§F10.2 changed the third column and nothing else.** The afterburn used to
//! be a `LAVA_BURN_RADIUS` disc dealing `LAVA_BURN_DPS`; it is now a stream of
//! flames, which is the same hazard made of objects you can see and walk around.
//! The telegraph, the channel and the jet are untouched, and `LAVA_BURN_DURATION`
//! still names the window.
//!
//! The scheduler owns the telegraph; this type's `active` flag goes true at t=3,
//! so its own clock runs 0..LAVA_JET_DURATION+LAVA_BURN_DURATION.

use crate::constants::{
    LAVA_BURN_DURATION, LAVA_CHANNEL_R, LAVA_FLAMES_PER_SECOND, LAVA_JET_DPS, LAVA_JET_DURATION,
    LAVA_VENTS_MAX, LAVA_VENTS_MIN, PLAYER_H, PLAYER_W,
};
use crate::map::carve::CarveResult;
use crate::map::Map;
use crate::math::Vec2;
use crate::rng::{range_f32, range_u32, substream, ChaCha8Rng};
use crate::weapons::explode::{DamageSource, EffectKind, HitTarget};

/// Minimum separation between vents, so a burst covers ground rather than
/// stacking on one spot.
const VENT_SEPARATION: f32 = 200.0;
/// Jet geometry: a cone from the vent, leaning up to 30 degrees off vertical.
const JET_HEIGHT: f32 = 180.0;
const JET_HALF_ANGLE: f32 = 0.35; // ~20 degrees
const JET_MAX_LEAN: f32 = 0.52; // ~30 degrees

#[derive(Copy, Clone, Debug, PartialEq)]
pub struct Vent {
    pub id: u32,
    pub pos: Vec2,
    pub jet_until: f32,
    pub burn_until: f32,
    /// Radians off vertical, positive is to the right.
    pub lean: f32,
}

pub struct LavaBurst {
    vents: Vec<Vent>,
    opened: bool,
}

impl LavaBurst {
    /// Vent positions are chosen at construction — during the telegraph — so the
    /// client can draw cracks at exactly the points that will open.
    pub fn new(seed: u64, map: &Map, now: f32) -> Self {
        let mut rng: ChaCha8Rng = substream(seed, "lava");
        let want = range_u32(&mut rng, LAVA_VENTS_MIN, LAVA_VENTS_MAX) as usize;
        let pts = &map.meta.surface_points;
        let mut vents: Vec<Vent> = Vec::new();

        if !pts.is_empty() {
            // Rejection sampling with a hard attempt cap: on a small or heavily
            // carved map the separation may be unsatisfiable, and looping until it
            // is would hang the tick.
            for _ in 0..200 {
                if vents.len() >= want {
                    break;
                }
                let i = range_u32(&mut rng, 0, pts.len() as u32 - 1) as usize;
                let p = Vec2::new(pts[i].x as f32, pts[i].y as f32);
                if vents.iter().any(|v| (v.pos - p).len() < VENT_SEPARATION) {
                    continue;
                }
                vents.push(Vent {
                    id: vents.len() as u32,
                    pos: p,
                    jet_until: now + LAVA_JET_DURATION,
                    burn_until: now + LAVA_JET_DURATION + LAVA_BURN_DURATION,
                    lean: range_f32(&mut rng, -JET_MAX_LEAN, JET_MAX_LEAN),
                });
            }
        }

        Self {
            vents,
            opened: false,
        }
    }

    pub fn vents(&self) -> &[Vent] {
        &self.vents
    }

    /// Opens the channels on the first active tick, then damages each tick.
    /// Where a venting mouth should spit flames this tick, and how fast.
    ///
    /// Returned rather than spawned, so this module keeps knowing nothing about
    /// `Projectiles` — the same shape `tick` already uses for its carves. The
    /// caller hands them to `flame::light_fan`, which is the single spawn point
    /// all three emitters share (§F10.2).
    ///
    /// **A derived cadence, not a stored counter.** `LAVA_FLAMES_PER_SECOND`
    /// flames a second is one every `1 / rate`, and which interval `now` falls
    /// in is a function of the vent's own `burn_until` — so there is no
    /// per-vent emitter state to keep in step with the clock, exactly as
    /// `flame`'s scorch timer avoids a `last_scorched_at` field.
    pub fn smoulder(&self, now: f32, dt: f32) -> Vec<Vec2> {
        let mut out = Vec::new();
        if LAVA_FLAMES_PER_SECOND <= 0.0 {
            return out;
        }
        let every = 1.0 / LAVA_FLAMES_PER_SECOND;
        for v in &self.vents {
            // Only inside the burn window: the jet phase spits no flames, which
            // is what keeps the two halves of the timeline distinguishable.
            if now < v.jet_until || now >= v.burn_until {
                continue;
            }
            if crate::math::fired_this_tick(v.jet_until, every, now, dt) {
                out.push(v.pos);
            }
        }
        out
    }

    pub fn tick(
        &mut self,
        map: &mut Map,
        players: &mut [HitTarget],
        active: bool,
        now: f32,
        dt: f32,
    ) -> Vec<CarveResult> {
        let mut carves = Vec::new();
        if !active {
            return carves;
        }

        if !self.opened {
            self.opened = true;
            for v in &mut self.vents {
                // Re-base the clock on the moment the vent actually opened, so a
                // telegraph of a different length cannot shift the jet or burn.
                v.jet_until = now + LAVA_JET_DURATION;
                v.burn_until = now + LAVA_JET_DURATION + LAVA_BURN_DURATION;
                let (x, y) = (v.pos.x.round() as i32, v.pos.y.round() as i32);
                carves.push(map.carve_capsule(
                    x,
                    y,
                    x,
                    y + (3.0 * LAVA_CHANNEL_R) as i32,
                    LAVA_CHANNEL_R as i32,
                ));
            }
        }

        for target in players.iter_mut() {
            if !target.alive {
                continue;
            }
            let p = target.pos;
            for v in &self.vents {
                let dps = if now < v.jet_until {
                    if in_jet(v, p) {
                        LAVA_JET_DPS
                    } else {
                        0.0
                    }
                } else {
                    // §F10.2: the afterburn deals **no damage of its own** any
                    // more. What it does is spit flames, which do the burning —
                    // see `smoulder` below. A dps here as well would charge for
                    // the fire twice.
                    0.0
                };
                if dps > 0.0 {
                    (target.apply_damage)(dps * dt, DamageSource::Weather(EffectKind::LavaBurst));
                }
            }
        }

        carves
    }

    /// True once every vent has finished burning.
    pub fn finished(&self, now: f32) -> bool {
        self.opened && self.vents.iter().all(|v| now >= v.burn_until)
    }
}

/// Is the player's centre inside this vent's jet cone?
///
/// Cone from the vent, pointing up with `lean`, half-angle `JET_HALF_ANGLE`,
/// length `JET_HEIGHT`. Testing the centre rather than exact cone-box
/// intersection: the difference is under half a player width and the effect is
/// area denial, not a precision instrument.
fn in_jet(v: &Vent, p: Vec2) -> bool {
    let d = p - v.pos;
    let dist = d.len();
    if !(1e-3..=JET_HEIGHT).contains(&dist) {
        // Standing exactly on the vent counts as inside; beyond the jet's reach
        // does not.
        return dist <= JET_HEIGHT;
    }
    // Screen coords: up is negative y.
    let up = Vec2::new(v.lean.sin(), -v.lean.cos());
    let cos = (d.x * up.x + d.y * up.y) / dist;
    cos >= JET_HALF_ANGLE.cos()
}

/// Height of the jet, for the client's particle emitter.
pub fn jet_height() -> f32 {
    JET_HEIGHT
}

/// The player box, so callers can size their own overlap checks consistently.
pub fn player_box() -> (f32, f32) {
    (PLAYER_W, PLAYER_H)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::constants::MapScale;
    use crate::map::gen::silhouette::force_borders;
    use crate::map::meta::MapMeta;
    use crate::map::{CoarseGrid, Mask};
    use crate::math::Point;
    use crate::weapons::explode::HitId;

    const DT: f32 = 1.0 / 60.0;
    const W: u32 = 1024;
    const H: u32 = 512;

    /// A solid map with a row of surface points across the middle. Built directly
    /// rather than generated: these tests need known vent candidates, and the
    /// generator costs seconds per call in debug.
    fn lava_map() -> Map {
        let mut mask = Mask::new_full(W, H);
        force_borders(&mut mask);
        let coarse = CoarseGrid::build(&mask);
        let mut m = MapMeta {
            seed: 1,
            requested_seed: 1,
            attempts: 1,
            used_safe_preset: false,
            scale: MapScale::Small,
            theme: 0,
            spawn_points: Vec::new(),
            teleport_pads: Vec::new(),
            surface_points: Vec::new(),
            objects: Vec::new(),
            buried_slots: Vec::new(),
            decorations: Vec::new(),
            wind: 0.0,
            traversable_fraction: 1.0,
            largest_component: Vec::new(),
        };
        for x in (60..(W as i32 - 60)).step_by(16) {
            m.surface_points.push(Point::new(x, 300));
        }
        Map::from_parts(mask, coarse, m)
    }

    struct Dummy {
        pos: Vec2,
        vel: Vec2,
        health: f32,
        shielded: bool,
    }

    fn targets(ds: &mut [Dummy]) -> Vec<HitTarget<'_>> {
        ds.iter_mut()
            .enumerate()
            .map(|(i, d)| {
                let shielded = d.shielded;
                let health = &mut d.health;
                HitTarget {
                    id: HitId::Player(i as u8),
                    w: crate::constants::PLAYER_W,
                    h: crate::constants::PLAYER_H,
                    pos: d.pos,
                    vel: &mut d.vel,
                    alive: true,
                    apply_damage: Box::leak(Box::new(move |a: f32, s: DamageSource| {
                        assert_eq!(s, DamageSource::Weather(EffectKind::LavaBurst));
                        *health -= if shielded { a * 0.5 } else { a };
                        true
                    })),
                }
            })
            .collect()
    }

    fn dummy(pos: Vec2) -> Dummy {
        Dummy {
            pos,
            vel: Vec2::ZERO,
            health: 1000.0,
            shielded: false,
        }
    }

    #[test]
    fn it_picks_between_three_and_six_separated_vents_on_the_surface() {
        for seed in 0..40u64 {
            let map = lava_map();
            let lava = LavaBurst::new(seed, &map, 0.0);
            let n = lava.vents().len();
            assert!(
                (LAVA_VENTS_MIN as usize..=LAVA_VENTS_MAX as usize).contains(&n),
                "seed {seed}: {n} vents"
            );
            for (i, a) in lava.vents().iter().enumerate() {
                assert!(
                    map.meta
                        .surface_points
                        .iter()
                        .any(|p| p.x as f32 == a.pos.x && p.y as f32 == a.pos.y),
                    "vent not on a surface point"
                );
                for b in &lava.vents()[i + 1..] {
                    assert!(
                        (a.pos - b.pos).len() >= VENT_SEPARATION,
                        "vents {} apart",
                        (a.pos - b.pos).len()
                    );
                }
            }
        }
    }

    #[test]
    fn activation_carves_a_channel_at_every_vent() {
        let mut map = lava_map();
        let before = map.mask.count_solid();
        let mut lava = LavaBurst::new(3, &map, 0.0);
        let n = lava.vents().len();
        let carves = lava.tick(&mut map, &mut [], true, 0.0, DT);
        assert_eq!(carves.len(), n, "one channel per vent");
        assert!(map.mask.count_solid() < before, "nothing was carved");
        for c in &carves {
            assert!(c.pixels_removed > 0);
        }
        // Only once, however long it runs.
        let again = lava.tick(&mut map, &mut [], true, DT, DT);
        assert!(again.is_empty(), "channels re-carved on a later tick");
    }

    #[test]
    fn nothing_happens_while_inactive() {
        let mut map = lava_map();
        let before = map.mask.count_solid();
        let mut lava = LavaBurst::new(3, &map, 0.0);
        let mut ds = vec![dummy(Vec2::new(200.0, 300.0))];
        for i in 0..600 {
            let mut t = targets(&mut ds);
            assert!(lava
                .tick(&mut map, &mut t, false, i as f32 * DT, DT)
                .is_empty());
        }
        assert_eq!(map.mask.count_solid(), before);
        assert_eq!(ds[0].health, 1000.0);
    }

    #[test]
    fn a_player_in_the_jet_takes_jet_dps_and_one_outside_takes_nothing() {
        let mut map = lava_map();
        let mut lava = LavaBurst::new(3, &map, 0.0);
        let v = lava.vents()[0];

        // Directly above the vent, well inside the cone.
        let inside = v.pos + Vec2::new(v.lean.sin() * 60.0, -v.lean.cos() * 60.0);
        // Beside it, past the cone's half-angle and outside the burn disc.
        let outside = v.pos + Vec2::new(160.0, 0.0);
        let mut ds = vec![dummy(inside), dummy(outside)];

        let ticks = (LAVA_JET_DURATION / DT) as u32;
        for i in 0..ticks {
            let mut t = targets(&mut ds);
            lava.tick(&mut map, &mut t, true, i as f32 * DT, DT);
        }
        let took = 1000.0 - ds[0].health;
        let expected = LAVA_JET_DPS * LAVA_JET_DURATION;
        assert!(
            (took - expected).abs() < LAVA_JET_DPS * DT * 3.0,
            "in-jet took {took}, expected {expected}"
        );
        assert_eq!(ds[1].health, 1000.0, "a player outside the cone was burned");
    }

    /// The jet still burns, and **the afterburn no longer does** (§F10.2).
    ///
    /// It used to be `LAVA_JET_DPS x LAVA_JET_DURATION + LAVA_BURN_DPS x
    /// LAVA_BURN_DURATION`. The second term is gone with the disc: the vent now
    /// spits flames and *they* do the burning, so a dps here as well would
    /// charge for the same fire twice. The flames themselves are asserted in
    /// `the_afterburn_spits_flames_and_the_jet_does_not` below.
    #[test]
    fn a_vent_deals_jet_damage_and_the_afterburn_deals_none_itself() {
        let mut map = lava_map();
        let mut lava = LavaBurst::new(3, &map, 0.0);
        let v = lava.vents()[0];
        let mut ds = vec![dummy(v.pos)];

        let total = LAVA_JET_DURATION + LAVA_BURN_DURATION;
        let ticks = ((total + 2.0) / DT) as u32;
        let mut at_jet_end = 0.0;
        for i in 0..ticks {
            let now = i as f32 * DT;
            let mut t = targets(&mut ds);
            lava.tick(&mut map, &mut t, true, now, DT);
            drop(t);
            if at_jet_end == 0.0 && now >= LAVA_JET_DURATION {
                at_jet_end = 1000.0 - ds[0].health;
            }
        }
        let took = 1000.0 - ds[0].health;
        let expected = LAVA_JET_DPS * LAVA_JET_DURATION;
        assert!(
            (took - expected).abs() < 1.0,
            "total {took}, expected the jet alone ({expected})"
        );
        // The control the assertion above needs: the jet really did hurt, so
        // "the afterburn adds nothing" is not "nothing hurts".
        assert!(
            (at_jet_end - expected).abs() < 1.0,
            "at the jet's end {at_jet_end}, expected {expected}"
        );
        assert!(lava.finished(total + 1.0));
    }

    /// The afterburn's actual output, and the jet phase as its control.
    #[test]
    fn the_afterburn_spits_flames_and_the_jet_does_not() {
        let mut map = lava_map();
        let mut lava = LavaBurst::new(3, &map, 0.0);
        let mut ds: Vec<Dummy> = Vec::new();
        {
            let mut t = targets(&mut ds);
            lava.tick(&mut map, &mut t, true, 0.0, DT);
        }
        let vents = lava.vents().len();

        let mut during_jet = 0;
        let mut during_burn = 0;
        let total = LAVA_JET_DURATION + LAVA_BURN_DURATION;
        let ticks = ((total + 1.0) / DT) as u32;
        for i in 1..ticks {
            let now = i as f32 * DT;
            {
                let mut t = targets(&mut ds);
                lava.tick(&mut map, &mut t, true, now, DT);
            }
            let n = lava.smoulder(now, DT).len();
            if now < LAVA_JET_DURATION {
                during_jet += n;
            } else {
                during_burn += n;
            }
        }
        assert_eq!(
            during_jet, 0,
            "the jet phase spat {during_jet} flames — the two halves of the \
             timeline are supposed to be different"
        );
        // `LAVA_FLAMES_PER_SECOND` per vent for `LAVA_BURN_DURATION`, and the
        // window is walked in `DT` steps so the last interval may not close.
        let want = (LAVA_FLAMES_PER_SECOND * LAVA_BURN_DURATION) as usize * vents;
        assert!(
            during_burn >= want.saturating_sub(vents) && during_burn <= want + vents,
            "the afterburn spat {during_burn} flames from {vents} vent(s), expected about \
             {want} (LAVA_FLAMES_PER_SECOND {LAVA_FLAMES_PER_SECOND} x \
             LAVA_BURN_DURATION {LAVA_BURN_DURATION})"
        );
        // And it stops. Otherwise "it emits during the burn" is satisfied by a
        // vent that emits forever.
        assert_eq!(lava.smoulder(total + 1.0, DT).len(), 0);
    }

    #[test]
    fn a_shielded_player_takes_half() {
        let mut map = lava_map();
        let mut lava = LavaBurst::new(3, &map, 0.0);
        let v = lava.vents()[0];
        let mut ds = vec![dummy(v.pos), dummy(v.pos)];
        ds[1].shielded = true;
        let ticks = (LAVA_JET_DURATION / DT) as u32;
        for i in 0..ticks {
            let mut t = targets(&mut ds);
            lava.tick(&mut map, &mut t, true, i as f32 * DT, DT);
        }
        let full = 1000.0 - ds[0].health;
        let half = 1000.0 - ds[1].health;
        assert!(full > 0.0);
        assert!((half - full / 2.0).abs() < 0.01, "{half} vs {full}");
    }

    #[test]
    fn the_same_seed_produces_the_same_vents_and_leans() {
        let map = lava_map();
        let sample = || {
            LavaBurst::new(77, &map, 0.0)
                .vents()
                .iter()
                .map(|v| (v.pos.x.to_bits(), v.pos.y.to_bits(), v.lean.to_bits()))
                .collect::<Vec<_>>()
        };
        let first = sample();
        assert!(!first.is_empty());
        for _ in 0..10 {
            assert_eq!(sample(), first);
        }
    }

    #[test]
    fn a_map_with_no_surface_points_produces_no_vents_and_does_not_hang() {
        let mut mask = Mask::new_full(W, H);
        force_borders(&mut mask);
        let coarse = CoarseGrid::build(&mask);
        let m = MapMeta {
            seed: 1,
            requested_seed: 1,
            attempts: 1,
            used_safe_preset: false,
            scale: MapScale::Small,
            theme: 0,
            spawn_points: Vec::new(),
            teleport_pads: Vec::new(),
            surface_points: Vec::new(),
            objects: Vec::new(),
            buried_slots: Vec::new(),
            decorations: Vec::new(),
            wind: 0.0,
            traversable_fraction: 1.0,
            largest_component: Vec::new(),
        };
        let mut map = Map::from_parts(mask, coarse, m);
        let mut lava = LavaBurst::new(1, &map, 0.0);
        assert!(lava.vents().is_empty());
        assert!(lava.tick(&mut map, &mut [], true, 0.0, DT).is_empty());
    }
}

#[cfg(test)]
mod t19_24_client_side_vents {
    use super::*;
    use crate::constants::MapScale;
    use crate::map::gen::surface::extract_surface;
    use crate::map::{generate, CoarseGrid, Map};

    /// One effect seed, fixed. The value does not matter; that both sides use the
    /// same one does.
    const EFFECT_SEED: u64 = 0x5EED_1A7A;
    const NOW: f32 = 12.5;

    /// The map a networked client ends up with, built the way `game-wasm`'s
    /// `load_mask` builds it: the server's mask, a coarse grid rebuilt from it,
    /// and **`meta.surface_points` cleared**.
    fn client_map_today(server: &Map) -> Map {
        let mask = server.mask.clone();
        let coarse = CoarseGrid::build(&mask);
        let mut meta = server.meta.clone();
        meta.surface_points.clear();
        Map::from_parts(mask, coarse, meta)
    }

    /// The same, but with the surface re-extracted from the mask that arrived —
    /// the one line T19.24 proposes adding.
    fn client_map_fixed(server: &Map) -> Map {
        let mask = server.mask.clone();
        let coarse = CoarseGrid::build(&mask);
        let mut meta = server.meta.clone();
        meta.surface_points = extract_surface(&mask);
        Map::from_parts(mask, coarse, meta)
    }

    fn vent_positions(map: &Map) -> Vec<(i32, i32)> {
        LavaBurst::new(EFFECT_SEED, map, NOW)
            .vents()
            .iter()
            .map(|v| (v.pos.x as i32, v.pos.y as i32))
            .collect()
    }

    /// **The control, and the finding.** A client built the way the shipping one
    /// is built derives **no vents at all**, however good its seed is.
    ///
    /// This is why T19.24's option-2 deliverable — a wasm entry point taking
    /// `(kind, seed, now)` — would have been the *fourth* no-op this task
    /// attracted: `LavaBurst::new` reads `map.meta.surface_points` and nothing
    /// else, and `load_mask` clears exactly that field. The seed being on the
    /// wire was necessary and never sufficient.
    #[test]
    fn todays_client_derives_no_vents_however_good_the_seed() {
        let server = generate(4242, MapScale::Small);
        let server_vents = vent_positions(&server);
        assert!(
            !server_vents.is_empty(),
            "the server itself found no vents — this fixture proves nothing"
        );
        assert!(
            vent_positions(&client_map_today(&server)).is_empty(),
            "a client whose `surface_points` are cleared should derive nothing"
        );
    }

    /// The cross-check T19.24 asks for: same seed, same map, **same vents**.
    ///
    /// Positions only. `jet_until` and `burn_until` are `now`-relative and the
    /// two sides do not share a clock; what must agree is *where the ground
    /// opens*, which is a pure function of the effect seed and the surface.
    #[test]
    fn a_client_that_re_extracts_the_surface_derives_the_servers_vents() {
        for scale in MapScale::ALL {
            let server = generate(4242, scale);
            let server_vents = vent_positions(&server);
            assert!(
                !server_vents.is_empty(),
                "{scale:?}: no vents on the server side — nothing is being compared"
            );
            assert_eq!(
                vent_positions(&client_map_fixed(&server)),
                server_vents,
                "{scale:?}: the client derived different vents from the same seed"
            );
        }
    }

    /// **What the cross-check does not cover, asserted rather than hoped.**
    ///
    /// The server picks vents from the surface as it was at *generation*;
    /// re-extraction on the client reads the mask as it *arrived*. Those are the
    /// same thing only while nothing has been carved. Once the ground is dug,
    /// they diverge — so a client that joins mid-round, or re-extracts after
    /// carving, will not agree.
    ///
    /// Stated as a test so the limit is a fact rather than a caveat somebody has
    /// to remember: this is why the re-extraction has to happen at `map_init`
    /// and not lazily when a lava effect starts.
    #[test]
    fn re_extracting_after_a_carve_no_longer_matches_the_server() {
        let server = generate(4242, MapScale::Small);
        let mut carved = server.clone();
        // A crater big enough to remove standable ground, in the middle of the
        // map where there is some.
        let (cx, cy) = (carved.mask.w as i32 / 2, carved.mask.h as i32 / 2);
        carved.carve_circle(cx, cy, 60);
        let after = extract_surface(&carved.mask);
        assert_ne!(
            after, server.meta.surface_points,
            "carving did not change the extracted surface — this limit test is vacuous"
        );
    }
}
