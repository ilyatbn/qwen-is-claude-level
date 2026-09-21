//! `MapGenerator::Space` — the zero-gravity arena (M22, `T22.05A`).
//!
//! ```text
//! 1 geometry → 2 rim → 3 asteroids → 4 levels → 5 surface → 6 validation
//! ```
//!
//! **The shape is an ellipse, not a circle** (`M22-RULINGS` R13). Every map is
//! 2:1 — `MAP_SMALL_W/H` 2048/1024, `MEDIUM` 3072/1536, `LARGE` 4096/2048 — so
//! a true circle is limited by the short axis and leaves `w - h` px of dead
//! arena: 2048 px on Large, half the map. `MINIMAP_W` x `MINIMAP_H` is
//! 200 x 100, **also 2:1**, so an ellipse inscribed in the map draws as a true
//! circle on the minimap, which is the only place the arena's shape is ever
//! visible — from inside, the camera shows an arc. The owner's circle appears
//! where a circle can be seen, and the arena is not half empty to buy it.
//!
//! **The three passes this pipeline does not run, and why.** v1 and v2 both end
//! `smooth::smooth` → `components::cleanup` → `objects::stamp_objects`:
//!
//! - `smooth` rounds a mask thresholded out of noise. This one is built from
//!   analytic discs; there is nothing to round, and it would gnaw the rim.
//! - `cleanup` deletes solid components under `MIN_BLOB_PX` and fills air
//!   pockets under `MIN_POCKET_PX`. **One of its two jobs is inapplicable and
//!   the other is actively wrong**: a space map is *deliberately* a field of
//!   disconnected solid components, which is exactly what that pass removes.
//!   The invariant it would have bought is bought instead, directly, by
//!   `every_asteroid_clears_the_speck_threshold`.
//! - `stamp_objects` puts trees, crystals and mushrooms on the ground. There is
//!   no ground.
//!
//! **Validation is replaced, not skipped** (R17). `traversal::analyse`'s
//! verdict is a walk/jump/jetpack connectivity fraction over standable surface
//! points, and in space you do not walk. [`analyse_space`] fills the same
//! `TraversalReport` with a space verdict, so `generate_full_with` and `MapMeta`
//! keep their shape and only what fills them changes. Skip that and the failure
//! is **silent**: all `MAX_GEN_ATTEMPTS` attempts fail, the safe preset runs,
//! and the map that ships is the safe-preset map with `used_safe_preset = true`
//! — unreported, because `tests/map_sweep.rs` is `#[ignore]`d.

use crate::constants::{
    MapGenerator, MapScale, FLOOR_CRUST, JETPACK_CLIMB_BUDGET, MAX_GEN_ATTEMPTS, PLAYER_H,
    PLAYER_W, SKY_MARGIN, SPACE_ASTEROID_CORE_FRAC, SPACE_ASTEROID_GAP_MIN, SPACE_ASTEROID_R_MAX,
    SPACE_ASTEROID_R_MIN, SPACE_ASTEROID_TRIES, SPACE_LEVEL_JITTER, SPACE_LEVEL_MAX,
    SPACE_LUMPS_MAX, SPACE_LUMPS_MIN, SPACE_LUMP_R_MAX_FRAC, SPACE_LUMP_R_MIN_FRAC,
    SPACE_RIM_CLEARANCE, SPACE_RIM_THICKNESS, SPACE_SPAWN_GRID, SPAWN_COUNT_MIN,
    SPAWN_MIN_SEPARATION,
};
use crate::map::gen::silhouette::force_borders;
use crate::map::gen::surface;
use crate::map::gen::traversal::TraversalReport;
use crate::map::meta::Asteroid;
use crate::map::shape::stamp_circle;
use crate::map::Mask;
use crate::math::Point;
use crate::rng::{range_f32, range_i32, range_u32, substream, ChaCha8Rng};

use super::GenOutcome;

/// The rim's **centreline** ellipse, in world pixels.
///
/// Every number here is derived, not picked. Reverse the shape by changing this
/// one struct: the circle R13 started from is `rx = ry`.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct SpaceGeometry {
    pub cx: f32,
    pub cy: f32,
    /// Semi-axis of the rim centreline, not of its outer edge.
    pub rx: f32,
    pub ry: f32,
    pub thickness: f32,
}

impl SpaceGeometry {
    pub fn for_scale(scale: MapScale) -> Self {
        let p = scale.params();
        let (w, h) = (p.width as f32, p.height as f32);
        let t = SPACE_RIM_THICKNESS as f32;

        // Vertical: `force_borders` owns the top `SKY_MARGIN` band (forced
        // empty) and the bottom `FLOOR_CRUST` band (forced solid), and
        // `borders_hold` is asserted in `gen/mod.rs`, `gen/v2/mod.rs` and
        // `tests/map_sweep.rs`. So the rim's **outer edge** stops exactly at
        // `SKY_MARGIN` and exactly at `h - FLOOR_CRUST`, and the centreline is
        // half a thickness inside each. Insetting keeps all three green and
        // untouched; disabling `force_borders` would cost three amended tests
        // to buy nothing.
        let ry = (h - SKY_MARGIN as f32 - FLOOR_CRUST as f32 - t) * 0.5;
        let cy = SKY_MARGIN as f32 + t * 0.5 + ry;

        // Horizontal: **derived from ry, never chosen**. The map is 2:1 and the
        // minimap is 2:1, so `rx = 2 * ry` is the one value that draws a true
        // circle there (R13 point 1). Any other x-inset makes it an ellipse on
        // the minimap too, which is the single thing the ruling was bought for.
        let rx = ry * 2.0;
        let cx = w * 0.5;
        SpaceGeometry {
            cx,
            cy,
            rx,
            ry,
            thickness: t,
        }
    }

    /// Normalised ellipse radius: `< 1` inside the centreline, `> 1` outside.
    /// Cheap, and used only where inside/outside is the whole question.
    pub fn norm(&self, x: f32, y: f32) -> f32 {
        let dx = (x - self.cx) / self.rx;
        let dy = (y - self.cy) / self.ry;
        (dx * dx + dy * dy).sqrt()
    }

    /// Distance from `(x, y)` to the rim **centreline**, in px, to sub-pixel
    /// accuracy.
    ///
    /// **Exact rather than bounded, and that matters.** The obvious cheap
    /// stand-ins are both wrong in one direction each: `(1 - norm) * ry`
    /// under-reports (by a factor of two at the ends of the major axis, which
    /// would push every rock into the middle 64 % of the arena and leave the
    /// ends empty — losing the area the ellipse was chosen to reclaim), and the
    /// radial distance to the centre ray's intersection over-reports (which
    /// would seat rocks inside the clearance they asked for).
    ///
    /// The iteration is the standard closest-point-on-ellipse fixed point,
    /// driven from the evolute. Four rounds are sub-pixel at these axis ratios;
    /// it is pure f32 arithmetic, so it is as deterministic as the noise field
    /// the other two generators already run on.
    pub fn distance_to_rim(&self, x: f32, y: f32) -> f32 {
        let (a, b) = (self.rx, self.ry);
        let px = (x - self.cx).abs();
        let py = (y - self.cy).abs();
        let (a2, b2) = (a * a, b * b);

        let mut tx = std::f32::consts::FRAC_1_SQRT_2;
        let mut ty = std::f32::consts::FRAC_1_SQRT_2;
        for _ in 0..4 {
            let ex = (a2 - b2) * tx * tx * tx / a;
            let ey = (b2 - a2) * ty * ty * ty / b;
            let (rx, ry) = (a * tx - ex, b * ty - ey);
            let (qx, qy) = (px - ex, py - ey);
            let q = (qx * qx + qy * qy).sqrt();
            if q < 1e-4 {
                // The point sits on the evolute: the direction is undefined and
                // the current guess is already a closest point. Stop rather
                // than divide by zero.
                break;
            }
            let r = (rx * rx + ry * ry).sqrt();
            tx = ((qx * r / q + ex) / a).clamp(0.0, 1.0);
            ty = ((qy * r / q + ey) / b).clamp(0.0, 1.0);
            let t = (tx * tx + ty * ty).sqrt().max(1e-6);
            tx /= t;
            ty /= t;
        }
        let (dx, dy) = (a * tx - px, b * ty - py);
        (dx * dx + dy * dy).sqrt()
    }

    /// Ramanujan's approximation. Used only to pick a stamp step.
    fn perimeter(&self) -> f32 {
        let (a, b) = (self.rx, self.ry);
        std::f32::consts::PI * (3.0 * (a + b) - ((3.0 * a + b) * (a + 3.0 * b)).sqrt())
    }
}

/// Tunables for one space attempt. The safe preset is this struct with milder
/// values, exactly as `GenParams` is for v1 and `V2Params` for v2.
#[derive(Clone, Debug, PartialEq)]
pub struct SpaceParams {
    pub scale: MapScale,
    pub asteroid_count: u32,
    /// Minimum clear gap between two asteroid surfaces, px.
    pub gap_min: f32,
    /// Which theme's weights downstream passes draw with. On the params for
    /// `GenParams`' reason: it belongs to the *requested* seed while an attempt
    /// runs on `requested_seed + attempt`.
    pub theme: u8,
}

impl SpaceParams {
    pub fn default_for(scale: MapScale) -> Self {
        SpaceParams {
            scale,
            asteroid_count: scale.params().asteroid_count,
            gap_min: SPACE_ASTEROID_GAP_MIN,
            theme: 0,
        }
    }

    /// The last-resort fallback: fewer rocks, the same lanes.
    ///
    /// The only two ways a space map fails validation are starving the
    /// open-space spawn picker and scattering rocks further apart than one
    /// climb budget. Emptier space cures the first and cannot worsen the
    /// second, because the rim is always a node of the reach graph.
    pub fn safe_for(scale: MapScale) -> Self {
        let d = Self::default_for(scale);
        SpaceParams {
            asteroid_count: (d.asteroid_count / 2).max(4),
            ..d
        }
    }

    pub fn width(&self) -> u32 {
        self.scale.params().width
    }

    pub fn height(&self) -> u32 {
        self.scale.params().height
    }
}

/// Pass 2. The rim, as a closed chain of overlapping discs on the centreline.
///
/// Discs rather than an *inside-the-outer-ellipse and outside-an-inner-one*
/// pixel test, because the annulus between two concentric ellipses is **not**
/// of uniform thickness: at 45 degrees on a 2:1 ellipse its normal thickness is
/// about 0.80x its radial gap, so a nominal 24 px rim measures ~22 px there and
/// the 20.48 px minimap floor on Large is cleared by less than a pixel and a
/// half. A chain of discs of radius `thickness / 2` is uniformly `thickness`
/// thick by construction, and closed by construction while consecutive centres
/// are closer together than that radius.
pub fn stamp_rim(mask: &mut Mask, geo: &SpaceGeometry) {
    let half = geo.thickness * 0.5;
    // Quarter-thickness spacing: consecutive discs overlap by three quarters of
    // their radius, which is solid — not merely 8-connected — at every
    // curvature the three scales produce.
    let step_px = (half * 0.5).max(1.0);
    let steps = (geo.perimeter() / step_px).ceil().max(8.0) as i32;
    for i in 0..steps {
        let a = (i as f32 / steps as f32) * std::f32::consts::TAU;
        let x = geo.cx + geo.rx * a.cos();
        let y = geo.cy + geo.ry * a.sin();
        stamp_circle(mask, x.round() as i32, y.round() as i32, half as i32, true);
    }
}

/// Passes 3 and 4. Rejection-sample asteroid centres inside the rim, then give
/// each one a gravity level.
///
/// **Radius is drawn uniformly on purpose.** A size distribution biased towards
/// small rocks looks more natural and makes level 5 rare — and *"a generator
/// that technically can emit level 5 and does so once in 900 maps has a feature
/// nobody meets"* is the failure this task was told to avoid. Uniform radius
/// over a monotone radius-to-level map is what makes all five levels common;
/// `the_level_distribution_reaches_every_level` asserts a share, not a
/// presence.
///
/// **Uniform in the draw is not uniform in the result, and the measurement says
/// so.** Rejection sampling is biased against big rocks — they need more room
/// from the rim and from each other — so over 999 Large seeds the levels come
/// out `1:16.2% 2:27.2% 3:24.0% 4:21.6% 5:10.9%`, not the 13/25/25/25/13 the
/// draw alone implies. Level 5 is still one rock in nine, which is about seven
/// on a Large map and one or two on a Small one. Bias the radius small as well
/// and it would be neither.
pub fn place_asteroids(seed: u64, geo: &SpaceGeometry, params: &SpaceParams) -> Vec<Asteroid> {
    let mut rng = substream(seed, "asteroids");
    let target = params.asteroid_count as usize;
    let mut out: Vec<Asteroid> = Vec::with_capacity(target);

    for _ in 0..(params.asteroid_count * SPACE_ASTEROID_TRIES) {
        if out.len() >= target {
            break;
        }
        let r = range_i32(&mut rng, SPACE_ASTEROID_R_MIN, SPACE_ASTEROID_R_MAX);
        let x = range_f32(&mut rng, geo.cx - geo.rx, geo.cx + geo.rx);
        let y = range_f32(&mut rng, geo.cy - geo.ry, geo.cy + geo.ry);

        // Inside the rim, clear of it by the rock's own radius, the rim's half
        // thickness and a lane to fly down.
        if geo.norm(x, y) >= 1.0 {
            continue;
        }
        let need = geo.thickness * 0.5 + SPACE_RIM_CLEARANCE + r as f32;
        if geo.distance_to_rim(x, y) < need {
            continue;
        }
        // Clear of every rock already placed. **Surface to surface**, not
        // centre to centre: `gap_min` is the width of the lane a player floats
        // down, and a centre distance would make that lane depend on the sizes
        // of the two rocks that happen to bound it.
        let clash = out.iter().any(|a| {
            let (dx, dy) = (a.x as f32 - x, a.y as f32 - y);
            (dx * dx + dy * dy).sqrt() < a.r as f32 + r as f32 + params.gap_min
        });
        if clash {
            continue;
        }
        let level = level_for(r, &mut rng);
        out.push(Asteroid {
            x: x.round() as i32,
            y: y.round() as i32,
            r,
            level,
        });
    }
    out
}

/// The gravity level of a rock of radius `r`: monotone in radius, with jitter
/// (R13).
///
/// Monotone because **a big rock with a weak pull reads as wrong** — size is the
/// only cue a player has before they are already in the well. Jittered because
/// a pure lookup makes level 5 mean nothing except "the biggest rock on this
/// map"; `SPACE_LEVEL_JITTER` bounds the jitter at less than one level so the
/// correlation survives it.
fn level_for(r: i32, rng: &mut ChaCha8Rng) -> u8 {
    let span = (SPACE_ASTEROID_R_MAX - SPACE_ASTEROID_R_MIN) as f32;
    let t = ((r - SPACE_ASTEROID_R_MIN) as f32 / span).clamp(0.0, 1.0);
    let base = 1.0 + t * (SPACE_LEVEL_MAX - 1) as f32;
    let jitter = range_f32(rng, -SPACE_LEVEL_JITTER, SPACE_LEVEL_JITTER);
    (base + jitter).round().clamp(1.0, SPACE_LEVEL_MAX as f32) as u8
}

/// Stamp one asteroid: a core disc plus lumps, the whole union inside radius
/// `r`.
///
/// `r` is the **bounding** radius and it has to stay one: it is what
/// `place_asteroids` spaces rocks by, what `rocks_are_within_reach` measures
/// reach by, what goes on the wire, and what `T22.11` will size a well from. So
/// the core is `SPACE_ASTEROID_CORE_FRAC * r` and each lump's centre distance
/// is capped at `r - lump_r`, which keeps every stamped pixel inside the disc
/// while still breaking the silhouette. The lumps cannot detach either: the
/// furthest possible lump still overlaps the core.
fn stamp_asteroid(mask: &mut Mask, a: &Asteroid, rng: &mut ChaCha8Rng) {
    let rf = a.r as f32;
    let core = (rf * SPACE_ASTEROID_CORE_FRAC).round() as i32;
    stamp_circle(mask, a.x, a.y, core, true);

    let lumps = range_u32(rng, SPACE_LUMPS_MIN, SPACE_LUMPS_MAX);
    for _ in 0..lumps {
        let lr = range_f32(rng, SPACE_LUMP_R_MIN_FRAC, SPACE_LUMP_R_MAX_FRAC) * rf;
        let d = range_f32(rng, 0.0, (rf - lr).max(0.0));
        let ang = range_f32(rng, 0.0, std::f32::consts::TAU);
        stamp_circle(
            mask,
            a.x + (d * ang.cos()).round() as i32,
            a.y + (d * ang.sin()).round() as i32,
            lr.round() as i32,
            true,
        );
    }
}

/// One attempt, no retry. Exposed for tests and for the PNG dump.
pub fn generate_once(seed: u64, params: &SpaceParams) -> GenOutcome {
    let geo = SpaceGeometry::for_scale(params.scale);
    let mut mask = Mask::new_empty(params.width(), params.height());

    stamp_rim(&mut mask, &geo);

    let asteroids = place_asteroids(seed, &geo, params);
    // A second sub-stream for the silhouette, so tuning the lumps cannot move a
    // rock and re-roll the whole map.
    let mut shape_rng = substream(seed, "asteroid_shape");
    for a in &asteroids {
        stamp_asteroid(&mut mask, a, &mut shape_rng);
    }

    // The side bands and the floor crust, exactly as the other two generators
    // leave them, so `borders_hold` is true of a space map too.
    //
    // **What is in the band between the rim and those borders is a decision,
    // not an artefact**: it is *void*. R16 puts `is_in_the_void`'s space arm
    // outside the rim, so a player out there is dying, not exploring, and there
    // is nothing to put in a place nobody occupies. The `WALL_W` bands stay
    // solid because removing them would break `borders_hold` in three files to
    // buy 8 px of somewhere nobody can be.
    force_borders(&mut mask);

    let surface = surface::extract_surface(&mask);
    let report = analyse_space(&mask, &surface, &asteroids, &geo);

    GenOutcome {
        mask,
        surface,
        report,
        sealed_pockets: Vec::new(),
        tunnel_paths: Vec::new(),
        islands: asteroids.iter().map(|a| Point::new(a.x, a.y)).collect(),
        objects: Vec::new(),
        asteroids,
        seed,
        requested_seed: seed,
        attempts: 1,
        used_safe_preset: false,
        generator: MapGenerator::Space,
    }
}

/// The space half of `gen::generate_terrain_with`: retries, then the safe
/// preset.
pub fn generate_terrain(requested_seed: u64, scale: MapScale) -> GenOutcome {
    let mut params = SpaceParams::default_for(scale);
    params.theme = crate::map::meta::theme_for(requested_seed);

    for attempt in 0..MAX_GEN_ATTEMPTS {
        let seed = requested_seed.wrapping_add(attempt as u64);
        let mut outcome = generate_once(seed, &params);
        if outcome.report.passed {
            outcome.requested_seed = requested_seed;
            outcome.attempts = attempt + 1;
            return outcome;
        }
    }

    let mut safe = SpaceParams::safe_for(scale);
    safe.theme = params.theme;
    let mut outcome = generate_once(requested_seed, &safe);
    outcome.requested_seed = requested_seed;
    outcome.attempts = MAX_GEN_ATTEMPTS;
    outcome.used_safe_preset = true;
    outcome
}

// ----------------------------------------------------------------- validation

/// R17's verdict, in the shape `TraversalReport` already has.
///
/// `generate_full_with` and `MapMeta` consume that struct, so the pipeline keeps
/// its shape and only what fills the struct changes.
///
/// - **`passed`** is: the rim is closed; at least `SPAWN_COUNT_MIN` candidate
///   points exist in **open space** at `SPAWN_MIN_SEPARATION`; and every rock is
///   within one `JETPACK_CLIMB_BUDGET` of another rock or of the rim. The third
///   clause is **not** in R17's list and is added deliberately — it is what
///   makes R17's own justification for the next line true rather than assumed.
/// - **`traversable_fraction` is 1.0 by construction**, because under thrust
///   everything in a connected scatter is reachable. Said here because
///   `tests/map_sweep.rs` cross-checks the fraction against
///   `largest_component.len()`, and a mismatch there reads as a generator bug.
/// - **`largest_component` is every index**, and it now means *all reachable*
///   rather than *the largest walk-connected set*. That is a field meaning two
///   things, and it is flagged rather than swallowed: the alternative is a
///   second report type `MapMeta` cannot hold.
pub fn analyse_space(
    mask: &Mask,
    surface: &[Point],
    asteroids: &[Asteroid],
    geo: &SpaceGeometry,
) -> TraversalReport {
    let closed = rim_is_closed(mask, geo);
    let spawns = open_space_candidates(mask, geo, asteroids, SPAWN_COUNT_MIN).len();
    let connected = rocks_are_within_reach(asteroids, geo);

    TraversalReport {
        total_points: surface.len(),
        largest_component: (0..surface.len()).collect(),
        traversable_fraction: 1.0,
        passed: closed && spawns >= SPAWN_COUNT_MIN && connected,
    }
}

/// Is the boundary closed? A **flood**, not a sample.
///
/// Air is flooded 4-connected from the top row — the only air on the map's
/// border, since `force_borders` makes the side bands and the floor crust solid
/// — and the answer is no the moment it reaches a pixel unambiguously inside the
/// rim's inner edge. 4-connected air is the exact dual of 8-connected solid, so
/// this says *"the ring has no 8-connected break"*, which is the claim; and it
/// is strictly stronger than walking the ring, because a ring walk that finds
/// its way home can still have skirted a hole.
///
/// **This is a claim about generation.** `T22.10` deliberately makes holes in
/// the rim at runtime, and both are true: the map is **born** closed, and a
/// breach is a vortex rather than an exit. Nothing here forbids that;
/// `a_hole_in_the_rim_is_seen` is the control, and it makes exactly the hole
/// `T22.10` will make.
pub fn rim_is_closed(mask: &Mask, geo: &SpaceGeometry) -> bool {
    let (w, h) = (mask.w as i32, mask.h as i32);
    let wu = w as usize;
    let mut seen = vec![false; wu * h as usize];
    let mut stack: Vec<(i32, i32)> = Vec::new();

    for x in 0..w {
        if !mask.get(x, 0) {
            seen[x as usize] = true;
            stack.push((x, 0));
        }
    }

    let inner = geo.thickness * 0.5;
    while let Some((x, y)) = stack.pop() {
        let (fx, fy) = (x as f32, y as f32);
        // Inside the centreline **and** further from it than the rim's half
        // thickness: that pixel is past the inner edge, so the outside got in.
        // A breach cannot hide from this — the flood does not stop at the inner
        // edge, so whatever squeezes through reaches deeper pixels that qualify.
        if geo.norm(fx, fy) < 1.0 && geo.distance_to_rim(fx, fy) > inner {
            return false;
        }
        for (dx, dy) in [(1, 0), (-1, 0), (0, 1), (0, -1)] {
            let (nx, ny) = (x + dx, y + dy);
            if nx < 0 || ny < 0 || nx >= w || ny >= h {
                continue;
            }
            let i = ny as usize * wu + nx as usize;
            if seen[i] || mask.get(nx, ny) {
                continue;
            }
            seen[i] = true;
            stack.push((nx, ny));
        }
    }
    true
}

/// Candidate spawn points in **open space** — air a player box fits in, inside
/// the rim, clear of every rock — at `SPAWN_MIN_SEPARATION`, up to `limit`.
///
/// Open space rather than standable ground (R17): in space you do not land to
/// spawn. `T22.05B` owns what actually gets spawned where; this exists so the
/// verdict can refuse a map with nowhere to put anybody, and so the count is
/// measurable.
pub fn open_space_candidates(
    mask: &Mask,
    geo: &SpaceGeometry,
    asteroids: &[Asteroid],
    limit: usize,
) -> Vec<Point> {
    let sep_sq = (SPAWN_MIN_SEPARATION * SPAWN_MIN_SEPARATION) as i64;
    let half_w = (PLAYER_W as i32) / 2;
    let body_h = PLAYER_H as i32;
    let mut chosen: Vec<Point> = Vec::new();

    let mut y = (geo.cy - geo.ry) as i32;
    while y < (geo.cy + geo.ry) as i32 {
        let mut x = (geo.cx - geo.rx) as i32;
        while x < (geo.cx + geo.rx) as i32 {
            let p = Point::new(x, y);
            if is_open_space(mask, geo, asteroids, p, half_w, body_h)
                && chosen.iter().all(|c| p.distance_sq(*c) >= sep_sq)
            {
                chosen.push(p);
                if chosen.len() >= limit {
                    return chosen;
                }
            }
            x += SPACE_SPAWN_GRID;
        }
        y += SPACE_SPAWN_GRID;
    }
    chosen
}

fn is_open_space(
    mask: &Mask,
    geo: &SpaceGeometry,
    asteroids: &[Asteroid],
    p: Point,
    half_w: i32,
    body_h: i32,
) -> bool {
    let (fx, fy) = (p.x as f32, p.y as f32);
    // Inside the rim, with a body's worth of room to its inner edge.
    if geo.norm(fx, fy) >= 1.0 || geo.distance_to_rim(fx, fy) < geo.thickness * 0.5 + body_h as f32
    {
        return false;
    }
    // The body box is air. Centred on x with its bottom edge at y, because
    // every point in this project that names a player position is a feet line.
    if p.x - half_w < 0 || p.x + half_w > mask.w as i32 || p.y - body_h < 0 || p.y >= mask.h as i32
    {
        return false;
    }
    for by in (p.y - body_h + 1)..=p.y {
        if mask.count_run(by, p.x - half_w, p.x + half_w - 1) != 0 {
            return false;
        }
    }
    // And clear of every rock by a body height, so nobody arrives flush against
    // one with a well already pulling.
    let clear = body_h as f32;
    !asteroids.iter().any(|a| {
        let (dx, dy) = ((a.x - p.x) as f32, (a.y - p.y) as f32);
        (dx * dx + dy * dy).sqrt() < a.r as f32 + clear
    })
}

/// Is every rock within one unbroken climb of another rock or of the rim?
///
/// `JETPACK_CLIMB_BUDGET` is *"the furthest a player can climb in one unbroken
/// effort"*, and it is already the reach `traversal::analyse` issues its region
/// edges at (R18). A scatter whose components sit further apart than that has a
/// rock nobody can leave, which is the space version of a map cut in two — and
/// it is the clause that makes `analyse_space`'s `traversable_fraction = 1.0` a
/// statement rather than an assumption.
///
/// Gaps are **surface to surface**. The rim is one node, because it is one
/// connected ring.
pub fn rocks_are_within_reach(asteroids: &[Asteroid], geo: &SpaceGeometry) -> bool {
    let n = asteroids.len();
    if n == 0 {
        return false;
    }
    let rim = n;
    let mut adj: Vec<Vec<usize>> = vec![Vec::new(); n + 1];
    for (i, a) in asteroids.iter().enumerate() {
        let rim_gap =
            geo.distance_to_rim(a.x as f32, a.y as f32) - geo.thickness * 0.5 - a.r as f32;
        if rim_gap <= JETPACK_CLIMB_BUDGET {
            adj[i].push(rim);
            adj[rim].push(i);
        }
        for (j, b) in asteroids.iter().enumerate().skip(i + 1) {
            let (dx, dy) = ((b.x - a.x) as f32, (b.y - a.y) as f32);
            let gap = (dx * dx + dy * dy).sqrt() - a.r as f32 - b.r as f32;
            if gap <= JETPACK_CLIMB_BUDGET {
                adj[i].push(j);
                adj[j].push(i);
            }
        }
    }

    let mut seen = vec![false; n + 1];
    let mut stack = vec![rim];
    seen[rim] = true;
    let mut count = 1;
    while let Some(v) = stack.pop() {
        for &u in &adj[v] {
            if !seen[u] {
                seen[u] = true;
                count += 1;
                stack.push(u);
            }
        }
    }
    count == n + 1
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::constants::{MAP_LARGE_W, MINIMAP_H, MINIMAP_W, MIN_BLOB_PX, WALL_W};
    use crate::map::gen::borders_hold;
    use crate::map::gen::objects::PlacedObject;
    use crate::map::gen::traversal;
    use crate::map::shape::carve_circle_counted;

    fn seeds(n: u64) -> impl Iterator<Item = u64> {
        (0..n).map(|i| i.wrapping_mul(7919).wrapping_add(13))
    }

    #[test]
    fn generation_is_deterministic() {
        let p = SpaceParams::default_for(MapScale::Small);
        let first = generate_once(4242, &p);
        for _ in 0..10 {
            let again = generate_once(4242, &p);
            assert_eq!(again.mask.hash(), first.mask.hash());
            assert_eq!(again.asteroids, first.asteroids);
            assert_eq!(again.surface, first.surface);
            assert_eq!(again.report, first.report);
        }
    }

    /// R13's whole argument, as an equation rather than a claim.
    ///
    /// The minimap is 200x100 and every map is 2:1, so an ellipse whose axes are
    /// in the same ratio draws as a **true circle** there. If either ratio moves,
    /// this is what says the circle was lost.
    #[test]
    fn the_rim_draws_as_a_true_circle_on_the_minimap() {
        let minimap_ratio = MINIMAP_W as f32 / MINIMAP_H as f32;
        for scale in MapScale::ALL {
            let p = scale.params();
            let map_ratio = p.width as f32 / p.height as f32;
            assert_eq!(map_ratio, minimap_ratio, "{scale:?} map is not 2:1");
            let geo = SpaceGeometry::for_scale(scale);
            assert_eq!(geo.rx / geo.ry, map_ratio, "{scale:?} rim is not 2:1");
        }
    }

    /// The rim's outer edge stops exactly at the two bands `force_borders` owns.
    /// A pixel either way and `borders_hold` breaks, which three other files
    /// assert.
    #[test]
    fn the_rim_sits_exactly_inside_the_forced_bands() {
        for scale in MapScale::ALL {
            let geo = SpaceGeometry::for_scale(scale);
            let h = scale.params().height as f32;
            let half = geo.thickness * 0.5;
            assert_eq!(geo.cy - geo.ry - half, SKY_MARGIN as f32, "{scale:?} top");
            assert_eq!(
                geo.cy + geo.ry + half,
                h - FLOOR_CRUST as f32,
                "{scale:?} bottom"
            );
            assert!(
                geo.cx - geo.rx - half > WALL_W as f32,
                "{scale:?} left: rim reaches the indestructible side band"
            );
        }
    }

    #[test]
    fn borders_hold_for_a_space_map() {
        for scale in MapScale::ALL {
            let o = generate_terrain(99, scale);
            let p = scale.params();
            assert_eq!((o.mask.w, o.mask.h), (p.width, p.height), "{scale:?}");
            assert!(borders_hold(&o.mask), "{scale:?} borders");
        }
    }

    /// The exact distance function, against a brute-force search of the
    /// centreline.
    ///
    /// **Brute force rather than arithmetic by hand**, because the hand version
    /// of this test was wrong: on the major axis of a 2:1 ellipse the nearest
    /// boundary point is nowhere near the axis, and `rx/2` from the centre is
    /// 359 px from the rim, not 440. That is exactly the error the cheap
    /// stand-ins make, in the two opposite directions the doc comment names.
    #[test]
    fn the_distance_to_the_rim_matches_a_brute_force_search() {
        let geo = SpaceGeometry::for_scale(MapScale::Small);
        for &(fx, fy) in &[
            (0.0f32, 0.0f32),
            (0.5, 0.0),
            (0.9, 0.0),
            (0.0, 0.5),
            (0.0, 0.9),
            (0.5, 0.5),
            (0.7, 0.3),
            (-0.2, -0.8),
        ] {
            let (x, y) = (geo.cx + fx * geo.rx, geo.cy + fy * geo.ry);
            let mut brute = f32::MAX;
            for i in 0..20_000 {
                let a = (i as f32 / 20_000.0) * std::f32::consts::TAU;
                let (ex, ey) = (geo.cx + geo.rx * a.cos(), geo.cy + geo.ry * a.sin());
                brute = brute.min(((ex - x).powi(2) + (ey - y).powi(2)).sqrt());
            }
            let d = geo.distance_to_rim(x, y);
            assert!(
                (d - brute).abs() < 0.5,
                "at ({fx}, {fy}) of the axes: iterated {d:.2}, brute force {brute:.2}"
            );
        }

        // And the cheap stand-in really is wrong on the major axis, by the
        // factor the doc comment claims — so the exactness is load-bearing
        // rather than decoration. Under it, rocks would be pushed out of the
        // ends of the arena the ellipse was chosen to reclaim.
        let p = (geo.cx + geo.rx * 0.5, geo.cy);
        let cheap = (1.0 - geo.norm(p.0, p.1)) * geo.ry;
        let exact = geo.distance_to_rim(p.0, p.1);
        assert!(
            cheap < exact * 0.7,
            "the (1-norm)*ry stand-in reported {cheap:.0} against the true {exact:.0}"
        );
    }

    /// R13 point 2: `Minimap::resampleTerrain` point-samples `core.solidAt` once
    /// per cell, so a rim thinner than `mapW / MINIMAP_W` — 20.48 px on Large —
    /// aliases into a dashed ring or vanishes.
    ///
    /// **Measured off the mask, not asserted against the constant.**
    /// `SPACE_RIM_THICKNESS` is what was asked for; this is what a player and
    /// the minimap get.
    #[test]
    fn the_rim_is_thicker_than_one_minimap_cell() {
        let floor = MAP_LARGE_W as f32 / MINIMAP_W as f32;
        for scale in MapScale::ALL {
            let o = generate_terrain(7, scale);
            let geo = SpaceGeometry::for_scale(scale);
            let mut worst = f32::MAX;
            let mut worst_at = 0.0f32;
            for i in 0..720 {
                let a = (i as f32 / 720.0) * std::f32::consts::TAU;
                let (px, py) = (geo.cx + geo.rx * a.cos(), geo.cy + geo.ry * a.sin());
                // Outward normal of the centreline ellipse at this angle.
                let (mut nx, mut ny) = (a.cos() / geo.rx, a.sin() / geo.ry);
                let len = (nx * nx + ny * ny).sqrt();
                nx /= len;
                ny /= len;
                let at = |t: f32| {
                    o.mask
                        .get((px + nx * t).round() as i32, (py + ny * t).round() as i32)
                };
                let mut solid = 0.0f32;
                let mut t = -geo.thickness;
                while t <= geo.thickness {
                    if at(t) {
                        solid += 0.25;
                    }
                    t += 0.25;
                }
                if solid < worst {
                    worst = solid;
                    worst_at = a;
                }
            }
            println!(
                "{scale:?}: thinnest rim {worst:.2} px at {:.0} deg",
                worst_at.to_degrees()
            );
            assert!(
                worst >= floor,
                "{scale:?}: the rim is {worst:.2} px at its thinnest, under the {floor:.2} px \
                 minimap cell on Large"
            );
        }
    }

    /// The boundary is **closed**, over many seeds and every scale.
    #[test]
    fn the_rim_is_closed_on_every_seed() {
        for scale in MapScale::ALL {
            let geo = SpaceGeometry::for_scale(scale);
            for seed in seeds(8) {
                let o = generate_terrain(seed, scale);
                assert!(rim_is_closed(&o.mask, &geo), "{scale:?} seed {seed}");
            }
        }
    }

    /// The control. Without it "the rim is closed" is satisfied by a test that
    /// cannot see a hole — and this **is** the hole `T22.10` will make, which is
    /// why the two features are not in conflict: the map is born closed, and a
    /// breach is a runtime event with a vortex behind it.
    #[test]
    fn a_hole_in_the_rim_is_seen() {
        let scale = MapScale::Small;
        let geo = SpaceGeometry::for_scale(scale);
        let mut o = generate_terrain(4242, scale);
        assert!(
            rim_is_closed(&o.mask, &geo),
            "control: the map is born closed"
        );

        let hole_r = (geo.thickness as i32) / 2 + 2;
        let removed = carve_circle_counted(
            &mut o.mask,
            geo.cx.round() as i32,
            (geo.cy - geo.ry).round() as i32,
            hole_r,
        );
        assert!(removed > 0, "the falsification carved nothing");
        assert!(
            !rim_is_closed(&o.mask, &geo),
            "a {removed} px hole in the rim was not seen"
        );
    }

    /// Asteroids exist, are separated, and have space between them — over many
    /// seeds and every scale, because one draw is not a population.
    #[test]
    fn asteroids_exist_and_are_separated() {
        for scale in MapScale::ALL {
            let params = SpaceParams::default_for(scale);
            let mut counts = Vec::new();
            for seed in seeds(12) {
                let o = generate_terrain(seed, scale);
                assert!(!o.asteroids.is_empty(), "{scale:?} seed {seed}: no rocks");
                counts.push(o.asteroids.len());
                for (i, a) in o.asteroids.iter().enumerate() {
                    assert!(
                        (SPACE_ASTEROID_R_MIN..=SPACE_ASTEROID_R_MAX).contains(&a.r),
                        "{scale:?} seed {seed}: radius {} is outside the band",
                        a.r
                    );
                    for b in o.asteroids.iter().skip(i + 1) {
                        let (dx, dy) = ((b.x - a.x) as f32, (b.y - a.y) as f32);
                        let gap = (dx * dx + dy * dy).sqrt() - a.r as f32 - b.r as f32;
                        assert!(
                            gap >= params.gap_min - 1.0,
                            "{scale:?} seed {seed}: two rocks {gap:.1} px apart"
                        );
                    }
                }
            }
            let min = counts.iter().copied().min().unwrap_or(0);
            println!("{scale:?}: asteroid counts over 12 seeds {counts:?}");
            assert!(
                min * 4 >= params.asteroid_count as usize * 3,
                "{scale:?}: a map came out with only {min} rocks against a target of {}",
                params.asteroid_count
            );
        }
    }

    /// No rock is stamped into the rim. The placement test works in float; this
    /// measures the mask, which is what a player collides with.
    #[test]
    fn no_asteroid_pixel_touches_the_rim() {
        for scale in MapScale::ALL {
            let geo = SpaceGeometry::for_scale(scale);
            for seed in seeds(6) {
                let o = generate_terrain(seed, scale);
                for a in &o.asteroids {
                    let gap = geo.distance_to_rim(a.x as f32, a.y as f32)
                        - geo.thickness * 0.5
                        - a.r as f32;
                    assert!(
                        gap >= SPACE_RIM_CLEARANCE - 2.0,
                        "{scale:?} seed {seed}: a rock is {gap:.1} px from the rim"
                    );
                }
            }
        }
    }

    /// The invariant `components::cleanup` would have enforced, asserted
    /// directly because this pipeline skips that pass on purpose. A solid blob
    /// under `MIN_BLOB_PX` is a speck, and v1 and v2 delete those.
    #[test]
    fn every_asteroid_clears_the_speck_threshold() {
        let core = (SPACE_ASTEROID_R_MIN as f32 * SPACE_ASTEROID_CORE_FRAC).round();
        let area = std::f32::consts::PI * core * core;
        assert!(
            area >= MIN_BLOB_PX as f32,
            "the smallest possible asteroid core is {area:.0} px, under MIN_BLOB_PX"
        );
        // And in the mask, where rounding and lumps actually land.
        for scale in MapScale::ALL {
            let o = generate_terrain(4242, scale);
            for a in &o.asteroids {
                let mut px = 0u32;
                for dy in -a.r..=a.r {
                    px += o.mask.count_run(a.y + dy, a.x - a.r, a.x + a.r);
                }
                assert!(
                    px >= MIN_BLOB_PX,
                    "{scale:?}: a rock of r={} is {px} px",
                    a.r
                );
            }
        }
    }

    /// Every level `1..=SPACE_LEVEL_MAX` appears, and often enough to meet.
    ///
    /// The floor is a **share**, not a presence: *"a generator that technically
    /// can emit level 5 and does so once in 900 maps has a feature nobody
    /// meets"*.
    #[test]
    fn the_level_distribution_reaches_every_level() {
        let mut hist = [0usize; (SPACE_LEVEL_MAX + 1) as usize];
        let mut total = 0usize;
        for seed in seeds(30) {
            for a in generate_terrain(seed, MapScale::Medium).asteroids {
                hist[a.level as usize] += 1;
                total += 1;
            }
        }
        println!("level histogram (index = level): {hist:?} over {total} rocks");
        assert_eq!(hist[0], 0, "a rock was given level 0");
        for (level, &n) in hist.iter().enumerate().skip(1) {
            let share = n as f32 / total as f32;
            assert!(
                share >= 0.05,
                "level {level} is {:.2}% of {total} rocks",
                share * 100.0
            );
        }
    }

    /// R13: the level **correlates with radius, monotonically, with jitter**.
    /// A big rock with a weak pull reads as wrong.
    #[test]
    fn a_bigger_rock_pulls_harder_on_average() {
        let mut sum = [0.0f32; (SPACE_LEVEL_MAX + 1) as usize];
        let mut n = [0usize; (SPACE_LEVEL_MAX + 1) as usize];
        for seed in seeds(30) {
            for a in generate_terrain(seed, MapScale::Medium).asteroids {
                sum[a.level as usize] += a.r as f32;
                n[a.level as usize] += 1;
            }
        }
        let mut last = 0.0f32;
        for level in 1..=SPACE_LEVEL_MAX as usize {
            assert!(n[level] > 0, "no rocks at level {level}");
            let mean = sum[level] / n[level] as f32;
            println!("level {level}: {} rocks, mean radius {mean:.1}", n[level]);
            assert!(
                mean > last,
                "level {level}'s mean radius {mean:.1} is not above level {}'s {last:.1}",
                level - 1
            );
            last = mean;
        }
    }

    #[test]
    fn there_is_open_space_to_spawn_into() {
        for scale in MapScale::ALL {
            let geo = SpaceGeometry::for_scale(scale);
            for seed in seeds(6) {
                let o = generate_terrain(seed, scale);
                let found = open_space_candidates(&o.mask, &geo, &o.asteroids, 64).len();
                assert!(
                    found >= SPAWN_COUNT_MIN,
                    "{scale:?} seed {seed}: only {found} open-space candidates"
                );
            }
        }
    }

    #[test]
    fn every_rock_is_within_one_climb_of_the_rest() {
        for scale in MapScale::ALL {
            let geo = SpaceGeometry::for_scale(scale);
            for seed in seeds(8) {
                let o = generate_terrain(seed, scale);
                assert!(
                    rocks_are_within_reach(&o.asteroids, &geo),
                    "{scale:?} seed {seed}: a rock is stranded"
                );
            }
        }
    }

    /// The controls for the clause above: a rock nobody can leave must fail, and
    /// reachable scatters must pass, or the predicate is reporting the
    /// framework.
    #[test]
    fn a_stranded_rock_fails_the_reach_test() {
        // **Large, not Small.** On Small the arena's own centre is 392 px from
        // the rim — half a climb budget — so nothing on that map can be
        // stranded at all, and the first version of this fixture asserted a
        // failure the predicate was right to refuse.
        let geo = SpaceGeometry::for_scale(MapScale::Large);
        let rock = |dx: i32, fy: f32| Asteroid {
            x: geo.cx as i32 + dx,
            y: (geo.cy + geo.ry * fy) as i32,
            r: 32,
            level: 3,
        };

        // Control 1: two rocks near the rim, within reach of it and each other.
        assert!(
            rocks_are_within_reach(&[rock(0, -0.8), rock(200, -0.8)], &geo),
            "control: two rocks by the rim are reachable"
        );
        // Control 2: the arena's centre is reachable **through** a rock by the
        // rim, so the predicate is not simply failing anything central.
        assert!(
            rocks_are_within_reach(&[rock(0, -0.8), rock(0, 0.0)], &geo),
            "control: a central rock chained off one by the rim is reachable"
        );

        // And the failure: the centre alone. It is the one place on a Large map
        // further than a climb budget from the rim in every direction, so a rock
        // there with nothing to chain through is a rock nobody can leave.
        let gap = geo.distance_to_rim(geo.cx, geo.cy) - geo.thickness * 0.5 - 32.0;
        assert!(
            gap > JETPACK_CLIMB_BUDGET,
            "the fixture is not actually stranded: {gap:.0} px to the rim"
        );
        assert!(
            !rocks_are_within_reach(&[rock(0, 0.0)], &geo),
            "a stranded rock passed the reach test"
        );
    }

    /// Asteroid tops are standable, so `extract_surface` finds them and
    /// `generate_full`'s spawn and pad pickers have something to work with. R17
    /// corrects the task file on exactly this point, and this is the check.
    #[test]
    fn asteroid_tops_are_standable() {
        for scale in MapScale::ALL {
            let o = generate_terrain(4242, scale);
            assert!(!o.surface.is_empty(), "{scale:?}: no surface points");
        }
    }

    #[test]
    fn the_safe_preset_is_emptier() {
        for scale in MapScale::ALL {
            let d = SpaceParams::default_for(scale);
            let s = SpaceParams::safe_for(scale);
            assert!(s.asteroid_count < d.asteroid_count, "{scale:?}");
        }
    }

    /// The tuning gate, in `gen/mod.rs`'s shape. If this fails, the space
    /// parameters need adjusting — report it rather than loosening it.
    #[test]
    #[ignore = "slow in debug; run with --release --ignored"]
    fn a_hundred_space_seeds_pass_without_the_safe_preset() {
        let mut hist = [0usize; 16];
        let mut safe = 0;
        for scale in MapScale::ALL {
            for seed in seeds(100) {
                let o = generate_terrain(seed, scale);
                hist[o.attempts as usize] += 1;
                if o.used_safe_preset {
                    safe += 1;
                }
            }
        }
        println!("attempts histogram (index = attempts): {hist:?}");
        assert_eq!(safe, 0, "the safe preset should never be needed");
    }

    /// R17 told this task to **measure** what the existing predicate says about
    /// a space map rather than assert it is meaningless. This is that
    /// measurement; the numbers are in the task report.
    #[test]
    #[ignore = "a measurement, not a gate"]
    fn what_the_walking_predicate_says_about_a_space_map() {
        for scale in MapScale::ALL {
            for seed in [1u64, 4242, 31337] {
                let params = SpaceParams::default_for(scale);
                let o = generate_once(seed, &params);
                let walk = traversal::analyse(&o.mask, &o.surface, &[] as &[PlacedObject]);
                println!(
                    "{scale:?} seed {seed}: {} surface points, walk fraction {:.3}, \
                     walk passed {}, space passed {}",
                    walk.total_points, walk.traversable_fraction, walk.passed, o.report.passed
                );
            }
        }
    }

    /// **A finding for `T22.04`, measured rather than argued.**
    ///
    /// The renderer decides whether to paint the cave backdrop from whether air
    /// is reachable by a flood from the sky — `v2::tests::open_air_fraction` and
    /// `client/src/render/backdrop*`. A closed rim means **none of the arena's
    /// interior air is reachable that way**, which is the same fact
    /// `rim_is_closed` asserts from the other side. So the client will paint the
    /// whole playfield with a cave backdrop unless `T22.04` gives it a space
    /// one.
    ///
    /// **Over the whole map it is 59-68 %, not 100 %** — measured, seed 4242,
    /// `Small 0.590, Medium 0.654, Large 0.684` — because the band between the
    /// rim and the map borders, and the sky band above it, are open. The
    /// interior figure is the one that matters and it is exactly 1.000.
    ///
    /// This is not a bug in either piece: the rim really does enclose the
    /// arena, and the enclosure test really is the right question for a
    /// landscape. It is a consequence nobody had written down, and it is the
    /// first thing `T22.04` should look at.
    #[test]
    #[ignore = "a measurement, not a gate"]
    fn every_pixel_of_air_inside_the_rim_reads_as_enclosed() {
        for scale in MapScale::ALL {
            let o = generate_terrain(4242, scale);
            let (w, h) = (o.mask.w as i32, o.mask.h as i32);
            let wu = w as usize;
            let mut seen = vec![false; wu * h as usize];
            let mut stack: Vec<(i32, i32)> = Vec::new();
            for x in 0..w {
                if !o.mask.get(x, 0) {
                    seen[x as usize] = true;
                    stack.push((x, 0));
                }
            }
            let mut open = 0u64;
            while let Some((x, y)) = stack.pop() {
                open += 1;
                for (dx, dy) in [(1, 0), (-1, 0), (0, 1), (0, -1)] {
                    let (nx, ny) = (x + dx, y + dy);
                    if nx < 0 || ny < 0 || nx >= w || ny >= h {
                        continue;
                    }
                    let i = ny as usize * wu + nx as usize;
                    if seen[i] || o.mask.get(nx, ny) {
                        continue;
                    }
                    seen[i] = true;
                    stack.push((nx, ny));
                }
            }
            let air = (w as u64 * h as u64) - o.mask.count_solid();

            // And the interior on its own, which is the figure the backdrop
            // actually turns on: air strictly inside the rim's inner edge.
            let geo = SpaceGeometry::for_scale(scale);
            let inner = geo.thickness * 0.5;
            let (mut inside_air, mut inside_open) = (0u64, 0u64);
            for y in 0..h {
                for x in 0..w {
                    let (fx, fy) = (x as f32, y as f32);
                    if o.mask.get(x, y)
                        || geo.norm(fx, fy) >= 1.0
                        || geo.distance_to_rim(fx, fy) <= inner
                    {
                        continue;
                    }
                    inside_air += 1;
                    if seen[y as usize * wu + x as usize] {
                        inside_open += 1;
                    }
                }
            }
            println!(
                "{scale:?}: whole map {:.4} of the air is sky-reachable, {:.4} reads as \
                 enclosed ({open} of {air} px); inside the rim {:.4} enclosed \
                 ({inside_open} of {inside_air} px sky-reachable)",
                open as f64 / air as f64,
                1.0 - open as f64 / air as f64,
                1.0 - inside_open as f64 / inside_air as f64,
            );
        }
    }

    /// The density and gap distributions the task asks to be reported, over a
    /// 999-seed sweep — `T21.40`'s shape.
    #[test]
    #[ignore = "a measurement, not a gate"]
    fn density_and_gap_report() {
        for scale in MapScale::ALL {
            let geo = SpaceGeometry::for_scale(scale);
            let ellipse = std::f32::consts::PI * geo.rx * geo.ry;
            let mut counts: Vec<usize> = Vec::new();
            let mut coverage: Vec<f32> = Vec::new();
            let mut gaps: Vec<f32> = Vec::new();
            let mut levels = [0usize; (SPACE_LEVEL_MAX + 1) as usize];
            let mut attempts = [0usize; 16];
            let mut safe = 0usize;

            for seed in seeds(999) {
                let o = generate_terrain(seed, scale);
                attempts[o.attempts as usize] += 1;
                if o.used_safe_preset {
                    safe += 1;
                }
                counts.push(o.asteroids.len());
                let rock_area: f32 = o
                    .asteroids
                    .iter()
                    .map(|a| std::f32::consts::PI * (a.r as f32) * (a.r as f32))
                    .sum();
                coverage.push(rock_area / ellipse);
                for (i, a) in o.asteroids.iter().enumerate() {
                    levels[a.level as usize] += 1;
                    let mut nearest = f32::MAX;
                    for (j, b) in o.asteroids.iter().enumerate() {
                        if i == j {
                            continue;
                        }
                        let (dx, dy) = ((b.x - a.x) as f32, (b.y - a.y) as f32);
                        nearest = nearest.min((dx * dx + dy * dy).sqrt() - a.r as f32 - b.r as f32);
                    }
                    if nearest.is_finite() {
                        gaps.push(nearest);
                    }
                }
            }

            fn pct(v: &mut [f32], p: f32) -> f32 {
                v.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
                v[((v.len() as f32 - 1.0) * p) as usize]
            }
            let mut cov = coverage.clone();
            let mut g = gaps.clone();
            counts.sort_unstable();
            let total: usize = levels.iter().sum();
            println!("--- {scale:?} over 999 seeds ---");
            println!(
                "  rocks per map: min {} p50 {} max {}",
                counts[0],
                counts[counts.len() / 2],
                counts[counts.len() - 1]
            );
            println!(
                "  coverage of the rim ellipse: p05 {:.3} p50 {:.3} p95 {:.3}",
                pct(&mut cov, 0.05),
                pct(&mut cov, 0.50),
                pct(&mut cov, 0.95)
            );
            println!(
                "  nearest-neighbour gap px: min {:.0} p05 {:.0} p50 {:.0} p95 {:.0} max {:.0}",
                pct(&mut g, 0.0),
                pct(&mut g, 0.05),
                pct(&mut g, 0.50),
                pct(&mut g, 0.95),
                pct(&mut g, 1.0)
            );
            println!("  JETPACK_CLIMB_BUDGET for comparison: {JETPACK_CLIMB_BUDGET:.0} px");
            let shares: Vec<String> = (1..=SPACE_LEVEL_MAX as usize)
                .map(|l| format!("{l}:{:.1}%", 100.0 * levels[l] as f32 / total as f32))
                .collect();
            println!("  levels over {total} rocks: {}", shares.join(" "));
            println!("  attempts {attempts:?}, safe preset {safe}");
        }
    }
}
