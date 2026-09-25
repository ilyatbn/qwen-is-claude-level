//! `MapGenerator::Space` — the zero-gravity arena (M22, `T22.05A`).
//!
//! ```text
//! 1 geometry → 2 rim → 3 asteroids → 4 levels → 5 surface → 6 validation
//! ```
//!
//! **The shape is a square-cornered rectangle** (T22.17, `M22-OWNER-ROUND-2`
//! R104: *"edge of the map should be square around the edges"*), inset
//! `SPACE_RIM_INSET` from all four map edges. It supersedes R13's ellipse, which
//! was inscribed in the 2:1 map so it drew as a true circle on the 2:1 minimap;
//! the rectangle is what the owner asked for, and it reclaims the four corners
//! the ellipse left as dead map. [`SpaceGeometry`] is the one rim predicate every
//! reader asks.
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
    MapGenerator, MapScale, JETPACK_CLIMB_BUDGET, MAX_GEN_ATTEMPTS, MAX_PLAYERS, PLAYER_H,
    PLAYER_W, SPACE_ASTEROID_CORE_FRAC, SPACE_ASTEROID_GAP_MIN, SPACE_ASTEROID_MASS_MAX,
    SPACE_ASTEROID_R_MAX, SPACE_ASTEROID_R_MIN, SPACE_ASTEROID_TRIES, SPACE_LEVEL_JITTER,
    SPACE_LEVEL_MAX, SPACE_LUMPS_MAX, SPACE_LUMPS_MIN, SPACE_LUMP_R_MAX_FRAC,
    SPACE_LUMP_R_MIN_FRAC, SPACE_OPEN_SPACE_TRIES, SPACE_RIM_CLEARANCE, SPACE_RIM_INSET,
    SPACE_RIM_THICKNESS, SPACE_SPAWN_GRID, SPACE_VOID_GRACE, SPAWN_COUNT_MIN,
};
use crate::map::gen::silhouette::force_borders;
use crate::map::gen::spawns::pick_separated;
use crate::map::gen::surface;
use crate::map::gen::traversal::TraversalReport;
use crate::map::meta::Asteroid;
use crate::map::shape::stamp_circle;
use crate::map::Mask;
use crate::math::Point;
use crate::rng::{range_f32, range_i32, range_u32, substream, ChaCha8Rng};

use super::GenOutcome;

/// The rim's **centreline rectangle**, in world pixels (T22.17, R104).
///
/// **The one rim predicate.** Every reader of the rim — closure, breaches, the
/// void, vortex placement, meteors, spawns, bots — asks one of the methods
/// below; none of them carries its own copy of the shape. That is what let the
/// ellipse become a rectangle by editing this struct.
///
/// `rx`/`ry` are the **half-extents** of the centreline rectangle (they were the
/// ellipse's semi-axes, and every caller that used them as "the far side of the
/// arena from the centre" still reads them that way).
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct SpaceGeometry {
    pub cx: f32,
    pub cy: f32,
    /// Half-width of the rim centreline, not of its outer edge.
    pub rx: f32,
    /// Half-height of the rim centreline, not of its outer edge.
    pub ry: f32,
    pub thickness: f32,
}

impl SpaceGeometry {
    pub fn for_scale(scale: MapScale) -> Self {
        let p = scale.params();
        Self::for_dims(p.width, p.height)
    }

    /// The same geometry, **from the mask's own dimensions** (`T22.05B`).
    ///
    /// The primitive, because two callers hold a mask and no trustworthy
    /// `MapScale`: `gen::surface_for` and `gen::reanalyse` run over a mask that
    /// pass 8 has just changed, and `game-wasm`'s `load_mask` runs over a mask
    /// that arrived from the server while `meta.scale` is whatever the client
    /// last generated. Deriving from `(w, h)` makes a scale mismatch
    /// unrepresentable rather than merely unlikely — the rim is a function of
    /// the map rect and of nothing else.
    ///
    /// **The outer edge sits `SPACE_RIM_INSET` in from all four map edges**
    /// (R104; the constant's doc says why that is `SKY_MARGIN` and why the sides
    /// and bottom do not hug the solid borders). The centreline is half a
    /// thickness further in. Supersedes R13's ellipse, which was inscribed in the
    /// same rect so that it drew as a circle on the 2:1 minimap; the owner asked
    /// for square edges, and the rectangle reclaims the four corners the ellipse
    /// left as dead map.
    pub fn for_dims(width: u32, height: u32) -> Self {
        let (w, h) = (width as f32, height as f32);
        let t = SPACE_RIM_THICKNESS as f32;
        let inset = SPACE_RIM_INSET as f32 + t * 0.5;
        SpaceGeometry {
            cx: w * 0.5,
            cy: h * 0.5,
            rx: w * 0.5 - inset,
            ry: h * 0.5 - inset,
            thickness: t,
        }
    }

    /// Normalised rectangle "radius": `max(|dx| / rx, |dy| / ry)` — `< 1` inside
    /// the centreline, `> 1` outside, exactly `1` on it. Cheap, and used only
    /// where inside/outside is the whole question.
    pub fn norm(&self, x: f32, y: f32) -> f32 {
        ((x - self.cx).abs() / self.rx).max((y - self.cy).abs() / self.ry)
    }

    /// Is `(x, y)` **inside the arena** — the side of the rim a player belongs
    /// on?
    ///
    /// The test is the centreline, not the inner edge, and the choice is
    /// deliberate: `extract_surface` reports a *feet line*, which on the rim's
    /// inner face is the air row directly above the rock, and on the rim's
    /// **outer** top face (`y = SKY_MARGIN`) it is a perfectly standable ledge
    /// looking out over the void. `norm < 1` separates those two by half a
    /// thickness either way and needs no second constant to do it.
    ///
    /// **This is not `is_in_the_void`'s predicate and must not drift into
    /// one.** R16 puts the void *outside the rim plus a grace band*, so the
    /// rim's own rock is neither inside the arena by this test nor lethal by
    /// that one — the two agree about everywhere a body can actually be, and
    /// disagree only about pixels of solid rock.
    pub fn inside(&self, x: f32, y: f32) -> bool {
        self.norm(x, y) < 1.0
    }

    /// `(x, y)` moved along its ray from the centre onto the rim centreline, rounded
    /// — where a breach's vortex sits (T22.10). Radial rather than closest-point:
    /// inside a thickness of the rim, which is the only place a breach can be, the
    /// two differ only within a half-thickness of a corner, and this one is exact
    /// arithmetic.
    pub fn onto_rim(&self, x: f32, y: f32) -> (i32, i32) {
        let (dx, dy) = (x - self.cx, y - self.cy);
        let (px, py) = if self.norm(x, y) < 1e-6 {
            (self.cx + self.rx, self.cy)
        } else {
            self.along_ray(dx, dy, 0.0)
        };
        (px.round() as i32, py.round() as i32)
    }

    /// The point on the ray from the centre along `(dx, dy)` that lies `inset` px
    /// **inside** the rim centreline — on the rectangle shrunk by `inset` on every
    /// side. `inset` 0 is the centreline itself ([`SpaceGeometry::onto_rim`]);
    /// `thickness / 2 + METEOR_SPACE_INSET` is where a meteor starts (R99).
    ///
    /// Because the shrunk rectangle keeps square corners, a point on the diagonal
    /// lands `inset` from **both** faces — so nothing started there sits in the rim.
    pub fn along_ray(&self, dx: f32, dy: f32, inset: f32) -> (f32, f32) {
        let (hx, hy) = ((self.rx - inset).max(1.0), (self.ry - inset).max(1.0));
        let n = (dx.abs() / hx).max(dy.abs() / hy);
        if n < 1e-9 {
            return (self.cx + hx, self.cy);
        }
        (self.cx + dx / n, self.cy + dy / n)
    }

    /// The rim's **inward normal** at the side nearest `(x, y)` — the side that
    /// decides [`SpaceGeometry::norm`]: straight down under the top, straight left
    /// from the right side, and so on. Where "inward" means *away from the rim*,
    /// which on a rectangle is not *toward the centre* (the two agree only at the
    /// middle of each side; a hole near a corner sent a body at the centre diagonally).
    pub fn inward_normal(&self, x: f32, y: f32) -> (f32, f32) {
        let (dx, dy) = (x - self.cx, y - self.cy);
        if dx.abs() / self.rx >= dy.abs() / self.ry {
            (-dx.signum(), 0.0)
        } else {
            (0.0, -dy.signum())
        }
    }

    /// Past the rim's **outer edge** by more than `SPACE_VOID_GRACE`: the void
    /// (`M22-RULINGS` R16). `World::is_in_the_void`'s space arm, here so the band
    /// and the rim it is measured from live together.
    pub fn in_the_void(&self, x: f32, y: f32) -> bool {
        self.norm(x, y) > 1.0
            && self.distance_to_rim(x, y) > self.thickness * 0.5 + SPACE_VOID_GRACE
    }

    /// Is **pixel** `(x, y)` part of the rim's rock as stamped — is its centre
    /// within half a thickness of the centreline? `stamp_rim` fills exactly these
    /// pixels. Judged at the pixel's centre (`+ 0.5`), so the band is `thickness`
    /// px on every side and symmetric: the first rock is column/row
    /// `SPACE_RIM_INSET` from the left and top, the last is `SPACE_RIM_INSET + 1`
    /// from the right and bottom, and no pixel sits exactly on an edge.
    pub fn in_rim_band(&self, x: i32, y: i32) -> bool {
        self.signed_distance(x as f32 + 0.5, y as f32 + 0.5).abs() < self.thickness * 0.5
    }

    /// Distance from `(x, y)` to the rim **centreline**, in px.
    ///
    /// **Inside, exact Euclidean** — the nearer of the four sides, which is the
    /// distance to a rectangle from within. **Outside, the Chebyshev distance**
    /// (the larger per-axis overshoot), deliberately: its level sets are
    /// square-cornered, so the rim's outer edge, the band `breach_in` floods from
    /// and the void's grace line are all rectangles with square corners, matching
    /// the rock `stamp_rim` lays. Euclidean outside would round those corners and
    /// let a breach flood seed from rim rock at the corner. The two agree
    /// everywhere off the corners' diagonals.
    pub fn distance_to_rim(&self, x: f32, y: f32) -> f32 {
        self.signed_distance(x, y).abs()
    }

    /// Negative inside the centreline, positive outside; see
    /// [`SpaceGeometry::distance_to_rim`] for the metric on each side.
    fn signed_distance(&self, x: f32, y: f32) -> f32 {
        ((x - self.cx).abs() - self.rx).max((y - self.cy).abs() - self.ry)
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
    /// The most extra mass a rock draws (R103): `SPACE_ASTEROID_MASS_MAX`, or 0
    /// for the control that shows the draw is what grew the rocks.
    pub mass_max: f32,
    // **No `theme` field**, unlike `GenParams` and `V2Params`. Theme is carried
    // on those two because `objects::stamp_objects` weights its categories by
    // it — and this pipeline does not run `stamp_objects`, because there is no
    // ground to stand a tree on. The field was here, written twice by
    // `generate_terrain` and read by nothing; `MapMeta`'s theme still comes
    // from `meta::theme_for`, as it does for every generator.
}

impl SpaceParams {
    pub fn default_for(scale: MapScale) -> Self {
        SpaceParams {
            scale,
            asteroid_count: scale.params().asteroid_count,
            gap_min: SPACE_ASTEROID_GAP_MIN,
            mass_max: SPACE_ASTEROID_MASS_MAX,
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

/// Pass 2. The rim: every pixel [`SpaceGeometry::in_rim_band`] names, set solid.
///
/// **A square-cornered rectangular band, `thickness` px on every side** (T22.17,
/// R104). It replaces R13's disc chain on an ellipse, which scalloped to 29.75-30
/// px (R34); a band stamped from the predicate has nothing to scallop, and
/// `the_rim_is_thicker_than_one_minimap_cell` measures exactly `thickness` off the
/// mask. Closed by construction — the band is a rectangle's annulus — and
/// `rim_is_closed` asserts the closure off the mask rather than trusting this.
///
/// Only the four strips are visited, not the arena: the rows of the top and
/// bottom strips whole, and a thickness-wide run at each side of every other row.
/// Each pixel is still decided by the predicate, so the loop bounds are an
/// economy, not a second copy of the shape — `the_stamped_rim_is_exactly_the_band`
/// compares the two over every pixel of the map.
pub fn stamp_rim(mask: &mut Mask, geo: &SpaceGeometry) {
    let half = geo.thickness * 0.5;
    // One pixel of slack past each edge of the band, so rounding cannot drop a row.
    let (ox0, ox1) = (
        (geo.cx - geo.rx - half).floor() as i32 - 1,
        (geo.cx + geo.rx + half).ceil() as i32 + 1,
    );
    let (oy0, oy1) = (
        (geo.cy - geo.ry - half).floor() as i32 - 1,
        (geo.cy + geo.ry + half).ceil() as i32 + 1,
    );
    let (ix0, ix1) = (
        (geo.cx - geo.rx + half).ceil() as i32 + 1,
        (geo.cx + geo.rx - half).floor() as i32 - 1,
    );
    let (iy0, iy1) = (
        (geo.cy - geo.ry + half).ceil() as i32 + 1,
        (geo.cy + geo.ry - half).floor() as i32 - 1,
    );
    let row = |y: i32, from: i32, to: i32, mask: &mut Mask| {
        for x in from..=to {
            if geo.in_rim_band(x, y) {
                mask.set(x, y);
            }
        }
    };
    for y in oy0..=oy1 {
        if y < iy0 || y > iy1 {
            row(y, ox0, ox1, mask);
        } else {
            row(y, ox0, ix0, mask);
            row(y, ix1, ox1, mask);
        }
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
/// and it would be neither. (Those are the ellipse's figures; on T22.17's square
/// rim with the R103 mass draw, whose grown radius pushes levels up, Large reads
/// `1:12.5% 2:25.4% 3:23.3% 4:22.1% 5:16.7%` — level 5 one rock in six.)
///
/// **R103 (T22.17): some rocks are bigger.** After the uniform base radius, each
/// candidate draws an extra mass `m` on `[0, params.mass_max]` from its **own**
/// sub-stream, `"asteroid_mass"`, one draw per candidate so the two streams stay
/// in step — and its radius becomes [`grown_radius`]. Everything downstream (rim
/// clearance, spacing, the level, the stamp, the wire) sees the grown radius, so
/// the lanes are measured between the rocks as they are drawn. The level is read
/// off the grown radius too: *"a big rock with a weak pull reads as wrong"*.
pub fn place_asteroids(seed: u64, geo: &SpaceGeometry, params: &SpaceParams) -> Vec<Asteroid> {
    place_asteroids_drawn(seed, geo, params)
        .into_iter()
        .map(|(a, _)| a)
        .collect()
}

/// A rock's radius after `m` extra mass: mass goes as area, so `r · sqrt(1 + m)`,
/// rounded (R103).
pub fn grown_radius(base: i32, m: f32) -> i32 {
    (base as f32 * (1.0 + m).sqrt()).round() as i32
}

/// [`place_asteroids`], with each rock's mass draw beside it — so the 0-20 % spread
/// is measured off the draw the generator made, not re-derived from a radius.
fn place_asteroids_drawn(
    seed: u64,
    geo: &SpaceGeometry,
    params: &SpaceParams,
) -> Vec<(Asteroid, f32)> {
    let mut rng = substream(seed, "asteroids");
    let mut mass_rng = substream(seed, "asteroid_mass");
    let target = params.asteroid_count as usize;
    let mut out: Vec<(Asteroid, f32)> = Vec::with_capacity(target);

    for _ in 0..(params.asteroid_count * SPACE_ASTEROID_TRIES) {
        if out.len() >= target {
            break;
        }
        let base = range_i32(&mut rng, SPACE_ASTEROID_R_MIN, SPACE_ASTEROID_R_MAX);
        let x = range_f32(&mut rng, geo.cx - geo.rx, geo.cx + geo.rx);
        let y = range_f32(&mut rng, geo.cy - geo.ry, geo.cy + geo.ry);
        let m = range_f32(&mut mass_rng, 0.0, params.mass_max);
        let r = grown_radius(base, m);

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
        let clash = out.iter().any(|(a, _)| {
            let (dx, dy) = (a.x as f32 - x, a.y as f32 - y);
            (dx * dx + dy * dy).sqrt() < a.r as f32 + r as f32 + params.gap_min
        });
        if clash {
            continue;
        }
        let level = level_for(r, &mut rng);
        out.push((
            Asteroid {
                x: x.round() as i32,
                y: y.round() as i32,
                r,
                level,
            },
            m,
        ));
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

    let surface = arena_surface(&mask, &geo);
    let spawn_points = choose_space_spawns(&mask, &geo, &asteroids, seed);
    let report = analyse_space(&mask, &surface, &asteroids, &geo, &spawn_points);

    GenOutcome {
        mask,
        surface,
        report,
        spawn_points,
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

/// `extract_surface`, with everything **outside the arena** dropped.
///
/// The filter is the whole of T22.05B's fix for *"everything that assumes
/// up"*, and it is one line because every consumer already agrees on what a
/// surface point means — *somewhere a body can stand* — and disagrees only
/// about whether the full-width floor crust counts. Measured at seed 4242
/// before the filter: `Small surface 148 = crust 84, asteroid 14, rim 37,
/// other 13` (R35). The crust is at `y = h - FLOOR_CRUST - 1`, **outside the
/// rim**, in the band R16 makes lethal — so it is not somewhere a body can
/// stand, it is somewhere a body dies.
///
/// Six readers are corrected by this one call and none of them had to change:
/// `spawns::choose_spawns`, `player/state.rs::choose_respawn`'s fallback,
/// `items/spawning.rs::place_initial` and `::resample_surface`,
/// `effects/lava.rs::LavaBurst::new` and `effects/toxic.rs::pick_column`. Each
/// of those would otherwise put a player, an item or a vent on the crust.
///
/// **What it costs, stated rather than discovered:**
/// `MapMeta.surface_points` for a space map is therefore **not**
/// `extract_surface(mask)`, which is true of every other generator and which
/// `meta.rs::surface_points_match_the_final_mask` asserts for the default one.
/// `gen::surface_for` is the shared spelling, and `game-wasm`'s `load_mask`
/// calls it too, so the client's re-extraction lands on the same set rather
/// than quietly re-admitting the crust.
pub fn arena_surface(mask: &Mask, geo: &SpaceGeometry) -> Vec<Point> {
    surface::extract_surface(mask)
        .into_iter()
        .filter(|p| geo.inside(p.x as f32, p.y as f32))
        .collect()
}

/// The space half of `gen::generate_terrain_with`: retries, then the safe
/// preset.
pub fn generate_terrain(requested_seed: u64, scale: MapScale) -> GenOutcome {
    let params = SpaceParams::default_for(scale);

    for attempt in 0..MAX_GEN_ATTEMPTS {
        let seed = requested_seed.wrapping_add(attempt as u64);
        let mut outcome = generate_once(seed, &params);
        if outcome.report.passed {
            outcome.requested_seed = requested_seed;
            outcome.attempts = attempt + 1;
            return outcome;
        }
    }

    let safe = SpaceParams::safe_for(scale);
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
/// - **`passed`** is: the rim is closed; the map ships at least
///   `SPAWN_COUNT_MIN` spawn points that are open space *in this mask*; and
///   every rock is within one `JETPACK_CLIMB_BUDGET` of another rock or of the
///   rim. The third clause is **not** in R17's list and is added deliberately —
///   it is what makes R17's own justification for the next line true rather
///   than assumed.
/// - **`traversable_fraction` is 1.0 by construction**, because under thrust
///   everything in a connected scatter is reachable. Said here because
///   `tests/map_sweep.rs` cross-checks the fraction against
///   `largest_component.len()`, and a mismatch there reads as a generator bug.
/// - **`largest_component` is every index**, and it now means *all reachable*
///   rather than *the largest walk-connected set*. That is a field meaning two
///   things, and it is flagged rather than swallowed: the alternative is a
///   second report type `MapMeta` cannot hold.
///
/// # The spawn clause now names the list the map ships (R35, `T22.05B`)
///
/// It used to call `open_space_candidates(..)`, count the result and **throw
/// the list away**, while `MapMeta.spawn_points` came from `choose_spawns` over
/// the surface — which put all six on the floor crust, outside the rim, in the
/// void. The verdict named a property of the shipped map and measured a
/// different one. Now `generate_once` chooses the list once, hands it here, and
/// hands the *same* list to `generate_full_with`, so the two cannot disagree.
///
/// **Be exact about what each half of the clause buys, because they are not
/// equal.** At `generate_once` the `is_open_space` filter is true of every
/// element by construction — the same predicate chose them — so what that half
/// is worth there is *zero*, and saying otherwise would be the
/// assertion-that-rules-out-nothing shape this file is full of warnings about.
/// The count is the live gate there: a crowded map yields fewer than
/// `SPAWN_COUNT_MIN` candidates, fails, and is re-rolled. The filter earns its
/// keep at the **other** call site — `gen::reanalyse`, after pass 8 has filled
/// ground under standing props — which is the one place the mask can have moved
/// under a spawn since it was picked.
pub fn analyse_space(
    mask: &Mask,
    surface: &[Point],
    asteroids: &[Asteroid],
    geo: &SpaceGeometry,
    spawn_points: &[Point],
) -> TraversalReport {
    let closed = rim_is_closed(mask, geo);
    let half_w = (PLAYER_W as i32) / 2;
    let body_h = PLAYER_H as i32;
    let usable = spawn_points
        .iter()
        .filter(|p| is_open_space(mask, geo, asteroids, **p, half_w, body_h))
        .count();
    let connected = rocks_are_within_reach(asteroids, geo);

    TraversalReport {
        total_points: surface.len(),
        largest_component: (0..surface.len()).collect(),
        traversable_fraction: 1.0,
        passed: closed && usable >= SPAWN_COUNT_MIN && connected,
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

/// **Does air cross the rim inside `(x0, y0, x1, y1)`?** — `rim_is_closed`'s
/// question asked of one box, for a carve at runtime (T22.10).
///
/// **The same claim, and it has to be**: `rim_is_closed` is a statement about
/// generation — the map is born closed — and this is the runtime half, where a hole
/// is a vortex and not an exit. Both stand. The flood is `rim_is_closed`'s: air
/// 4-connected (the dual of 8-connected rock), seeded from every air pixel in the
/// box **past the outer edge**, and the answer is yes the moment it reaches air
/// **past the inner edge**. Confined to the box, so a carve costs its own
/// neighbourhood; the caller pads the box by a rim thickness so a hole the carve
/// completes is inside it.
pub fn breach_in(mask: &Mask, geo: &SpaceGeometry, (x0, y0, x1, y1): (i32, i32, i32, i32)) -> bool {
    let (x0, y0) = (x0.max(0), y0.max(0));
    let (x1, y1) = (x1.min(mask.w as i32 - 1), y1.min(mask.h as i32 - 1));
    if x1 < x0 || y1 < y0 {
        return false;
    }
    let bw = (x1 - x0 + 1) as usize;
    let mut seen = vec![false; bw * (y1 - y0 + 1) as usize];
    let idx = |x: i32, y: i32| (y - y0) as usize * bw + (x - x0) as usize;
    let half = geo.thickness * 0.5;
    let mut stack: Vec<(i32, i32)> = Vec::new();
    for y in y0..=y1 {
        for x in x0..=x1 {
            let (fx, fy) = (x as f32, y as f32);
            if !mask.get(x, y) && geo.norm(fx, fy) > 1.0 && geo.distance_to_rim(fx, fy) > half {
                seen[idx(x, y)] = true;
                stack.push((x, y));
            }
        }
    }
    while let Some((x, y)) = stack.pop() {
        let (fx, fy) = (x as f32, y as f32);
        if geo.norm(fx, fy) < 1.0 && geo.distance_to_rim(fx, fy) > half {
            return true;
        }
        for (dx, dy) in [(1, 0), (-1, 0), (0, 1), (0, -1)] {
            let (nx, ny) = (x + dx, y + dy);
            if nx < x0 || ny < y0 || nx > x1 || ny > y1 || seen[idx(nx, ny)] || mask.get(nx, ny) {
                continue;
            }
            seen[idx(nx, ny)] = true;
            stack.push((nx, ny));
        }
    }
    false
}

/// Every grid point in **open space** — air a player box fits in, inside the
/// rim, clear of every rock.
///
/// Open space rather than standable ground (R17): in space you do not land to
/// spawn. The grid is `SPACE_SPAWN_GRID` px, which on Large is 64 x 32 = 2048
/// probes — cheap enough to run on every generation attempt, and fine enough
/// that no gap a player fits through is missed by more than half a step.
///
/// **No separation rule is applied here, and that is the change `T22.05B`
/// made.** The old version took the first `limit` points that were
/// `SPAWN_MIN_SEPARATION` apart *in scan order*, which is a pool biased to the
/// top-left corner of the arena — fine for answering *"is there room for six?"*
/// and wrong as a set to sample spawns from. Separation is now
/// [`choose_space_spawns`]' job, through the same farthest-point sampler the
/// landscape generators use.
pub fn open_space_grid(mask: &Mask, geo: &SpaceGeometry, asteroids: &[Asteroid]) -> Vec<Point> {
    let half_w = (PLAYER_W as i32) / 2;
    let body_h = PLAYER_H as i32;
    let mut out: Vec<Point> = Vec::new();

    let mut y = (geo.cy - geo.ry) as i32;
    while y < (geo.cy + geo.ry) as i32 {
        let mut x = (geo.cx - geo.rx) as i32;
        while x < (geo.cx + geo.rx) as i32 {
            let p = Point::new(x, y);
            if is_open_space(mask, geo, asteroids, p, half_w, body_h) {
                out.push(p);
            }
            x += SPACE_SPAWN_GRID;
        }
        y += SPACE_SPAWN_GRID;
    }
    out
}

/// The spawn points a space map ships (`T22.05B`).
///
/// **The same sampler the landscape uses, over a different pool.**
/// `spawns::pick_separated` is farthest-point sampling with
/// `MAX_RELAXATIONS` fallbacks — *"random placement clusters, and clustered
/// spawns mean two players start in each other's faces while a third of the map
/// is empty"* — and none of that reasoning is about gravity. Only the pool
/// changes: open space inside the rim instead of standable ground in the
/// traversable component. A second copy of the sampler here would drift from
/// that one the first time either was tuned.
///
/// The `"spawns"` sub-stream tag is `choose_spawns`' own, because this *is*
/// `choose_spawns` for this generator and no space map ever calls both.
pub fn choose_space_spawns(
    mask: &Mask,
    geo: &SpaceGeometry,
    asteroids: &[Asteroid],
    seed: u64,
) -> Vec<Point> {
    let pool = open_space_grid(mask, geo, asteroids);
    if pool.is_empty() {
        return Vec::new();
    }
    let mut rng = substream(seed, "spawns");
    let first = range_i32(&mut rng, 0, pool.len() as i32 - 1) as usize;
    pick_separated(&pool, first, SPAWN_COUNT_MIN.max(MAX_PLAYERS))
}

/// One point in open space, drawn at random, or `None` if this map has none.
///
/// For the things that arrive **during** a round rather than at generation:
/// supply crates, which R16 takes off the sky drop, and the periodic item
/// spawns R14 takes off the ground. Rejection sampling rather than
/// [`open_space_grid`] because those callers want a *different* point each
/// time and the grid is a fixed 2048-entry list; building it per crate would
/// also be 2048 probes to use one.
///
/// Draws from `rng` exactly once per attempt, so the caller's stream position
/// stays a function of the map and the number of attempts — both deterministic.
///
/// **`clearance` is the caller's own filter** (T22.10C, `M22-RULINGS` R86): a
/// drawn open point is taken when `clearance(p) >= 0`. Every caller but the
/// vortex passes `|_| 0.0`, which accepts the first open point — the draws, and
/// so the `"items"` and `"crates"` streams, are exactly what they were. When no
/// draw is both open and clear, the answer is **the open point with the greatest
/// clearance** among the draws and the whole [`open_space_grid`] — never `None`
/// for a picky caller while the map has open space at all, because a caller that
/// skips on `None` (a vortex that declines to take you) is the bug R86 fixed.
/// The grid costs its 2048 probes only on that path.
pub fn random_open_space(
    mask: &Mask,
    geo: &SpaceGeometry,
    asteroids: &[Asteroid],
    rng: &mut ChaCha8Rng,
    clearance: impl Fn(Point) -> f32,
) -> Option<Point> {
    let half_w = (PLAYER_W as i32) / 2;
    let body_h = PLAYER_H as i32;
    let mut best: Option<(f32, Point)> = None;
    for _ in 0..SPACE_OPEN_SPACE_TRIES {
        let p = Point::new(
            range_i32(rng, (geo.cx - geo.rx) as i32, (geo.cx + geo.rx) as i32),
            range_i32(rng, (geo.cy - geo.ry) as i32, (geo.cy + geo.ry) as i32),
        );
        if is_open_space(mask, geo, asteroids, p, half_w, body_h) {
            let c = clearance(p);
            if c >= 0.0 {
                return Some(p);
            }
            best = farther(best, (c, p));
        }
    }
    open_space_grid(mask, geo, asteroids)
        .into_iter()
        .map(|p| (clearance(p), p))
        .fold(best, farther)
        .map(|(_, p)| p)
}

/// The greater clearance, the earlier one on a tie — so the fallback is a
/// function of the draws and the grid's scan order, both deterministic.
fn farther(best: Option<(f32, Point)>, next: (f32, Point)) -> Option<(f32, Point)> {
    match best {
        Some(b) if b.0 >= next.0 => Some(b),
        _ => Some(next),
    }
}

/// Does a player body fit at `p` — **the space answer to
/// `surface::is_standable`** (`T22.05B`)?
///
/// Exported because the rest of the game asks that question in the landscape's
/// words and gets the wrong answer here. `is_standable` requires
/// `MIN_SUPPORT_PX` of rock directly under the body box, so **no open-space
/// spawn point can ever pass it** — which is not a detail: `World::spawn_for`
/// and `player::state::choose_respawn` both gate the listed spawn points on it,
/// so every space spawn would be silently rejected and both would fall through
/// to their surface fallback. The chosen, well-separated points would have been
/// computed, shipped, validated, hashed into the golden table, and never used.
///
/// `Map::body_fits_at` is the predicate that picks between the two, and it is
/// the only place that choice is made.
pub fn body_fits(mask: &Mask, geo: &SpaceGeometry, asteroids: &[Asteroid], p: Point) -> bool {
    is_open_space(
        mask,
        geo,
        asteroids,
        p,
        (PLAYER_W as i32) / 2,
        PLAYER_H as i32,
    )
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
    use crate::constants::{
        FLOOR_CRUST, MAP_LARGE_W, MINIMAP_W, MIN_BLOB_PX, SKY_MARGIN, SPAWN_MIN_SEPARATION, WALL_W,
    };
    use crate::map::gen::borders_hold;
    use crate::map::gen::objects::PlacedObject;
    use crate::map::gen::spawns::{MAX_RELAXATIONS, RELAX_FACTOR};
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

    /// **R104: the rim is square-cornered**, read off the mask. At each of the four
    /// corners the pixel at the band's outer corner and the one at its inner corner
    /// are rock — an ellipse, or a rectangle with rounded corners, leaves both air —
    /// and the controls: one pixel diagonally outside the outer corner and one
    /// diagonally inside the inner corner are air, so "rock at the corner" is not a
    /// rim that fills everything.
    #[test]
    fn the_rim_is_square_cornered() {
        for scale in MapScale::ALL {
            let o = generate_terrain(7, scale);
            let (w, h) = (o.mask.w as i32, o.mask.h as i32);
            let (i, t) = (SPACE_RIM_INSET as i32, SPACE_RIM_THICKNESS as i32);
            // (outer corner pixel, the step that goes *outward* along the diagonal)
            for ((ox, oy), (sx, sy)) in [
                ((i, i), (-1, -1)),
                ((w - 1 - i, i), (1, -1)),
                ((i, h - 1 - i), (-1, 1)),
                ((w - 1 - i, h - 1 - i), (1, 1)),
            ] {
                let inner = (ox - sx * (t - 1), oy - sy * (t - 1));
                let beyond = (ox + sx, oy + sy);
                let within = (inner.0 - sx, inner.1 - sy);
                let at = |p: (i32, i32)| o.mask.get(p.0, p.1);
                assert!(at((ox, oy)), "{scale:?}: outer corner ({ox}, {oy}) is air");
                assert!(at(inner), "{scale:?}: inner corner {inner:?} is air");
                assert!(!at(beyond), "{scale:?}: {beyond:?} past the corner is rock");
                assert!(
                    !at(within),
                    "{scale:?}: {within:?} inside the corner is rock"
                );
            }
        }
    }

    /// The rim's outer edge sits `SPACE_RIM_INSET` in from **every** map edge
    /// (R104), which at the top is exactly the `SKY_MARGIN` band `force_borders`
    /// owns — a pixel higher and `borders_hold` breaks, which three other files
    /// assert — and read off the mask: the first rock down the centre column is
    /// that row, and the first rock in from each side along the middle row is that
    /// column. The bottom edge stays clear of the `FLOOR_CRUST` and the sides of the
    /// `WALL_W` bands, with air between (the void a breach opens into).
    #[test]
    fn the_rim_sits_the_inset_from_every_edge() {
        let inset = SPACE_RIM_INSET as f32;
        assert_eq!(
            SPACE_RIM_INSET, SKY_MARGIN,
            "the top edge is the forced band's"
        );
        for scale in MapScale::ALL {
            let geo = SpaceGeometry::for_scale(scale);
            let (w, h) = (scale.params().width as f32, scale.params().height as f32);
            let half = geo.thickness * 0.5;
            assert_eq!(geo.cy - geo.ry - half, inset, "{scale:?} top");
            assert_eq!(geo.cy + geo.ry + half, h - inset, "{scale:?} bottom");
            assert_eq!(geo.cx - geo.rx - half, inset, "{scale:?} left");
            assert_eq!(geo.cx + geo.rx + half, w - inset, "{scale:?} right");
            assert!(
                h - inset < h - FLOOR_CRUST as f32,
                "{scale:?}: the rim sits on the crust"
            );
            assert!(
                inset > WALL_W as f32,
                "{scale:?}: the rim reaches the side band"
            );

            let o = generate_terrain(7, scale);
            let (cx, cy) = (geo.cx as i32, geo.cy as i32);
            let first_down = (0..o.mask.h as i32).find(|&y| o.mask.get(cx, y));
            assert_eq!(
                first_down,
                Some(SPACE_RIM_INSET as i32),
                "{scale:?}: top edge in the mask"
            );
            let first_right = (WALL_W as i32..o.mask.w as i32).find(|&x| o.mask.get(x, cy));
            assert_eq!(
                first_right,
                Some(SPACE_RIM_INSET as i32),
                "{scale:?}: left edge in the mask"
            );
            let (mw, mh) = (o.mask.w as i32, o.mask.h as i32);
            let last_left = (0..mw - WALL_W as i32).rev().find(|&x| o.mask.get(x, cy));
            assert_eq!(
                last_left,
                Some(mw - 1 - SPACE_RIM_INSET as i32),
                "{scale:?}: right edge"
            );
            let last_up = (0..mh - FLOOR_CRUST as i32)
                .rev()
                .find(|&y| o.mask.get(cx, y));
            assert_eq!(
                last_up,
                Some(mh - 1 - SPACE_RIM_INSET as i32),
                "{scale:?}: bottom edge"
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

    /// The distance function, against a brute-force search of the centreline
    /// rectangle: **Euclidean from inside** and **Chebyshev from outside**, the two
    /// metrics `distance_to_rim`'s doc names (square-cornered offsets outside). A
    /// hand-written expectation is what this project's first version of this test
    /// got wrong on the ellipse, so the reference is a search, not arithmetic.
    #[test]
    fn the_distance_to_the_rim_matches_a_brute_force_search() {
        let geo = SpaceGeometry::for_scale(MapScale::Small);
        // The centreline, sampled every quarter pixel along all four sides.
        let mut rim: Vec<(f32, f32)> = Vec::new();
        let (x0, x1, y0, y1) = (
            geo.cx - geo.rx,
            geo.cx + geo.rx,
            geo.cy - geo.ry,
            geo.cy + geo.ry,
        );
        let mut t = 0.0;
        while t <= 2.0 * geo.rx {
            rim.push((x0 + t, y0));
            rim.push((x0 + t, y1));
            t += 0.25;
        }
        let mut t = 0.0;
        while t <= 2.0 * geo.ry {
            rim.push((x0, y0 + t));
            rim.push((x1, y0 + t));
            t += 0.25;
        }
        for &(fx, fy) in &[
            (0.0f32, 0.0f32),
            (0.5, 0.0),
            (0.9, 0.0),
            (0.0, 0.5),
            (0.0, 0.9),
            (0.5, 0.5),
            (0.7, 0.3),
            (-0.2, -0.8),
            (0.95, 0.95),
            // Outside, including off a corner's diagonal where the metrics differ.
            (1.05, 0.0),
            (0.0, -1.1),
            (1.04, 1.08),
            (-1.1, 1.1),
        ] {
            let (x, y) = (geo.cx + fx * geo.rx, geo.cy + fy * geo.ry);
            let outside = geo.norm(x, y) > 1.0;
            let brute = rim
                .iter()
                .map(|&(ex, ey)| {
                    let (dx, dy) = ((ex - x).abs(), (ey - y).abs());
                    if outside {
                        dx.max(dy)
                    } else {
                        (dx * dx + dy * dy).sqrt()
                    }
                })
                .fold(f32::MAX, f32::min);
            let d = geo.distance_to_rim(x, y);
            assert!(
                (d - brute).abs() < 0.5,
                "at ({fx}, {fy}) of the half-extents ({}): {d:.2}, brute force {brute:.2}",
                if outside { "outside" } else { "inside" }
            );
        }
    }

    /// Every pixel `stamp_rim` sets is one `in_rim_band` names, and every one it
    /// names is set — over the whole of a Small map, so `stamp_rim`'s loop bounds
    /// (it visits only the four strips) cannot have dropped a row or a corner. The
    /// band's area is the control: `thickness` px around the whole rectangle.
    #[test]
    fn the_stamped_rim_is_exactly_the_band() {
        let (w, h) = (
            MapScale::Small.params().width,
            MapScale::Small.params().height,
        );
        let geo = SpaceGeometry::for_dims(w, h);
        let mut mask = Mask::new_empty(w, h);
        stamp_rim(&mut mask, &geo);
        let mut set = 0u64;
        for y in 0..h as i32 {
            for x in 0..w as i32 {
                let want = geo.in_rim_band(x, y);
                assert_eq!(mask.get(x, y), want, "pixel ({x}, {y})");
                set += want as u64;
            }
        }
        let t = geo.thickness as u64;
        let (ow, oh) = ((2.0 * geo.rx) as u64 + t, (2.0 * geo.ry) as u64 + t);
        assert_eq!(
            set,
            ow * oh - (ow - 2 * t) * (oh - 2 * t),
            "the band's area"
        );
    }

    /// R13 point 2: `Minimap::resampleTerrain` point-samples `core.solidAt` once
    /// per cell, so a rim thinner than `mapW / MINIMAP_W` — 20.48 px on Large —
    /// aliases into a dashed frame or vanishes.
    ///
    /// **Measured off the mask, not asserted against the constant.** Every column
    /// across the top and bottom strips and every row across the two side strips
    /// is walked perpendicular to its side, and the run of rock counted. The
    /// ellipse's disc chain delivered 29.75-30.00 px against a nominal 32 (R34);
    /// the band stamped from the predicate delivers `thickness` exactly, and this
    /// is where that sentence in `stamp_rim`'s doc is re-run rather than trusted.
    /// Seed 7's rocks cannot reach the rim (`SPACE_RIM_CLEARANCE`), so a longer
    /// run would be a rock in the lane, which `no_asteroid_pixel_touches_the_rim`
    /// owns.
    #[test]
    fn the_rim_is_thicker_than_one_minimap_cell() {
        let floor = MAP_LARGE_W as f32 / MINIMAP_W as f32;
        for scale in MapScale::ALL {
            let o = generate_terrain(7, scale);
            let geo = SpaceGeometry::for_scale(scale);
            let reach = geo.thickness as i32 * 2;
            let run = |xy: &dyn Fn(i32) -> (i32, i32)| {
                (-reach..=reach)
                    .filter(|&t| {
                        let (x, y) = xy(t);
                        o.mask.get(x, y)
                    })
                    .count() as f32
            };
            let (x0, x1) = ((geo.cx - geo.rx) as i32, (geo.cx + geo.rx) as i32);
            let (y0, y1) = ((geo.cy - geo.ry) as i32, (geo.cy + geo.ry) as i32);
            let (mut thinnest, mut thickest) = (f32::MAX, 0.0f32);
            // Off the corners by a thickness: across a corner the run is along
            // the other side's strip, and the corners are
            // `the_rim_is_square_cornered`'s.
            let t = geo.thickness as i32;
            for x in x0 + t..=x1 - t {
                for y in [y0, y1] {
                    let r = run(&|t| (x, y + t));
                    thinnest = thinnest.min(r);
                    thickest = thickest.max(r);
                }
            }
            for y in y0 + t..=y1 - t {
                for x in [x0, x1] {
                    let r = run(&|t| (x + t, y));
                    thinnest = thinnest.min(r);
                    thickest = thickest.max(r);
                }
            }
            println!("{scale:?}: rim {thinnest:.0}-{thickest:.0} px across, every side");
            assert!(
                thinnest >= floor,
                "{scale:?}: {thinnest} px, under the {floor:.2} px cell"
            );
            assert_eq!(
                (thinnest, thickest),
                (geo.thickness, geo.thickness),
                "{scale:?}: the rim is not `thickness` px on every side"
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
                        (SPACE_ASTEROID_R_MIN
                            ..=grown_radius(SPACE_ASTEROID_R_MAX, SPACE_ASTEROID_MASS_MAX))
                            .contains(&a.r),
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

    /// No rock is stamped into the rim: the **lane** just inside the rim's
    /// inner edge is empty mask, all the way round.
    ///
    /// **This reads pixels**, which the previous version of it did not — it
    /// restated `place_asteroids`' float filter against the same
    /// `distance_to_rim` the filter itself calls, so it could not have seen a
    /// lump escaping the bounding radius or a rounding error in
    /// `stamp_circle`, and its doc comment already claimed it measured the
    /// mask.
    ///
    /// The lane is what `SPACE_RIM_CLEARANCE` buys and what `T22.10`'s vortex
    /// needs to work in, so it is the right thing to measure: rays are cast
    /// inward from every pixel of the centreline rectangle, along its side's
    /// normal, and every pixel from just
    /// past the rim's inner edge to `SPACE_RIM_CLEARANCE` in must be air.
    /// `a_rock_in_the_lane_is_seen` is the control.
    #[test]
    fn no_asteroid_pixel_touches_the_rim() {
        for scale in MapScale::ALL {
            let geo = SpaceGeometry::for_scale(scale);
            for seed in seeds(6) {
                let o = generate_terrain(seed, scale);
                let intruder = first_pixel_in_the_lane(&o.mask, &geo);
                assert!(
                    intruder.is_none(),
                    "{scale:?} seed {seed}: solid pixel {:?} in the lane inside the rim",
                    intruder
                );
            }
        }
    }

    /// The first solid pixel in the lane between the rim's inner edge and
    /// `SPACE_RIM_CLEARANCE` inside it, if there is one.
    ///
    /// Shared by the test above and its control, so the two cannot disagree
    /// about where the lane is.
    ///
    /// The two margins: **+2 px** at the near end, because `stamp_rim` rounds
    /// each disc's centre to an integer pixel and so a rim pixel can sit a
    /// fraction past `thickness / 2`; **-4 px** at the far end, because a
    /// lump's radius and centre are rounded the same way and a rock's pixels
    /// can reach a pixel or two beyond the bounding radius the placement
    /// filter reasons in.
    fn first_pixel_in_the_lane(mask: &Mask, geo: &SpaceGeometry) -> Option<(i32, i32)> {
        let half = geo.thickness * 0.5;
        // Every pixel along each side of the centreline rectangle, cast inward
        // along that side's normal. The walks along the top and bottom cover the
        // lane's corner squares too (the pixels there that are nearer the other
        // side's rock are skipped as rim, not lane), and at one-pixel spacing
        // nothing can slip between two walks.
        let (x0, x1) = (geo.cx - geo.rx, geo.cx + geo.rx);
        let (y0, y1) = (geo.cy - geo.ry, geo.cy + geo.ry);
        let mut starts: Vec<((f32, f32), (f32, f32))> = Vec::new();
        let mut t = 0.0;
        while t <= 2.0 * geo.rx {
            starts.push(((x0 + t, y0), (0.0, 1.0)));
            starts.push(((x0 + t, y1), (0.0, -1.0)));
            t += 1.0;
        }
        let mut t = 0.0;
        while t <= 2.0 * geo.ry {
            starts.push(((x0, y0 + t), (1.0, 0.0)));
            starts.push(((x1, y0 + t), (-1.0, 0.0)));
            t += 1.0;
        }
        for ((px, py), (nx, ny)) in starts {
            let mut t = half + 2.0;
            while t <= half + SPACE_RIM_CLEARANCE - 4.0 {
                let (x, y) = ((px + nx * t).round() as i32, (py + ny * t).round() as i32);
                // Near a corner a walk runs down the *other* side's rock; the lane
                // is what lies past the inner edge of the nearest side.
                let lane = geo.distance_to_rim(x as f32, y as f32) >= half + 2.0;
                if lane && mask.get(x, y) {
                    return Some((x, y));
                }
                t += 1.0;
            }
        }
        None
    }

    /// The control for the lane measurement: put a rock in the lane by hand and
    /// the sweep must find it. Without this, "no solid pixel in the lane" is
    /// satisfied by a sweep that looks in the wrong place.
    #[test]
    fn a_rock_in_the_lane_is_seen() {
        let scale = MapScale::Small;
        let geo = SpaceGeometry::for_scale(scale);
        let mut o = generate_terrain(4242, scale);
        assert!(
            first_pixel_in_the_lane(&o.mask, &geo).is_none(),
            "control: the generated map's lane is clear"
        );

        // One rock, flush against the rim's inner edge at the left end of the
        // major axis — the placement filter would have refused it by
        // `SPACE_RIM_CLEARANCE`.
        let r = SPACE_ASTEROID_R_MIN;
        let intruder = Asteroid {
            x: (geo.cx - geo.rx + geo.thickness * 0.5) as i32 + r,
            y: geo.cy as i32,
            r,
            level: 1,
        };
        let mut rng = substream(4242, "control");
        stamp_asteroid(&mut o.mask, &intruder, &mut rng);
        assert!(
            first_pixel_in_the_lane(&o.mask, &geo).is_some(),
            "a rock stamped flush against the rim was not seen in the lane"
        );
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

    /// **R35's red-before-green.** The spawn clause, pointed at the list the
    /// map actually *ships* instead of at a count `analyse_space` throws away.
    ///
    /// `analyse_space` measures `open_space_candidates(..).len()`, which is a
    /// statement about the map (*"there is somewhere to put six players"*) and
    /// not about `MapMeta.spawn_points` (*"they are put there"*). This test
    /// asserts the second, through `map::generate_with` — the whole pipeline,
    /// pass 8 included — and it was red on all three scales the moment it was
    /// written:
    ///
    /// ```text
    /// Small:  h=1024 crust_line=1007 spawns=6 ys=[1007 x6] outside=6
    /// Medium: h=1536 crust_line=1519 spawns=6 ys=[1519 x6] outside=6
    /// Large:  h=2048 crust_line=2031 spawns=6 ys=[2031 x6] outside=6
    /// ```
    ///
    /// The predicate is `is_open_space` itself, not a restatement of it, so a
    /// spawn that the verdict would count is exactly a spawn this accepts.
    #[test]
    fn every_shipped_spawn_point_is_in_open_space_inside_the_rim() {
        let half_w = (PLAYER_W as i32) / 2;
        let body_h = PLAYER_H as i32;
        for scale in MapScale::ALL {
            let geo = SpaceGeometry::for_scale(scale);
            let map = crate::map::generate_with(4242, scale, MapGenerator::Space);
            let ys: Vec<i32> = map.meta.spawn_points.iter().map(|p| p.y).collect();
            let outside: Vec<Point> = map
                .meta
                .spawn_points
                .iter()
                .copied()
                .filter(|p| {
                    !is_open_space(&map.mask, &geo, &map.meta.asteroids, *p, half_w, body_h)
                })
                .collect();
            println!(
                "{scale:?}: h={} crust_line={} spawns={} ys={ys:?} pads={} outside={}",
                map.mask.h,
                map.mask.h as i32 - FLOOR_CRUST as i32 - 1,
                map.meta.spawn_points.len(),
                map.meta.teleport_pads.len(),
                outside.len()
            );
            assert!(
                map.meta.spawn_points.len() >= SPAWN_COUNT_MIN,
                "{scale:?}: only {} spawn points",
                map.meta.spawn_points.len()
            );
            assert!(
                outside.is_empty(),
                "{scale:?}: {} of {} shipped spawn points are not open space inside the rim: {:?}",
                outside.len(),
                map.meta.spawn_points.len(),
                outside
            );
        }
    }

    #[test]
    fn there_is_open_space_to_spawn_into() {
        for scale in MapScale::ALL {
            let geo = SpaceGeometry::for_scale(scale);
            for seed in seeds(6) {
                let o = generate_terrain(seed, scale);
                let found = open_space_grid(&o.mask, &geo, &o.asteroids).len();
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
        // **Large, not Small.** On Small the arena's own centre is 400 px from
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
    ///
    /// **It used to be `!o.surface.is_empty()`, which tested nothing this test
    /// is named for** (R35). `force_borders` lays a full-width `FLOOR_CRUST`
    /// band across the bottom of every map, and its top row is standable — so
    /// the crust alone outnumbers the rocks about 6:1 in `o.surface` and the
    /// old assertion would have passed for a generator that stamped **no
    /// asteroids at all**. Here the points are attributed: a surface point
    /// counts only if it is inside some rock's bounding radius.
    ///
    /// `a_map_with_no_asteroids_has_no_standable_rock` is the falsification,
    /// and it is the version of this map the old assertion could not see.
    #[test]
    fn asteroid_tops_are_standable() {
        for scale in MapScale::ALL {
            let o = generate_terrain(4242, scale);
            let (on_rocks, rocks_used) = standable_rock_points(&o);
            println!(
                "{scale:?}: {} surface points, {on_rocks} of them on rock, \
                 {rocks_used} of {} rocks carrying at least one",
                o.surface.len(),
                o.asteroids.len()
            );
            // Most rocks, not merely one: `extract_surface` samples x every
            // `SURFACE_SAMPLE_STEP`, so a rock can fall between two columns,
            // but a pipeline that only ever produced a handful of standable
            // rocks would be the bug this test is for.
            assert!(
                rocks_used * 2 >= o.asteroids.len(),
                "{scale:?}: only {rocks_used} of {} rocks have a standable point",
                o.asteroids.len()
            );
        }
    }

    /// Surface points that sit on a rock, and how many distinct rocks carry
    /// one. Shared by the test above and its falsification so the two cannot
    /// drift apart on what "on a rock" means.
    fn standable_rock_points(o: &GenOutcome) -> (usize, usize) {
        let mut used = vec![false; o.asteroids.len()];
        let mut on_rocks = 0usize;
        for p in &o.surface {
            for (i, a) in o.asteroids.iter().enumerate() {
                let (dx, dy) = ((p.x - a.x) as f32, (p.y - a.y) as f32);
                // `+ 1.0`: the feet line of a standable point is the air row
                // directly above the solid one, so a point on the very top of
                // a rock sits one pixel outside its bounding radius.
                if (dx * dx + dy * dy).sqrt() <= a.r as f32 + 1.0 {
                    on_rocks += 1;
                    used[i] = true;
                    break;
                }
            }
        }
        (on_rocks, used.iter().filter(|u| **u).count())
    }

    /// The falsification, kept: **a space map with no rocks at all still has a
    /// surface** — the **rim's inner face**. This is the map the old
    /// `!o.surface.is_empty()` assertion would have passed.
    ///
    /// **T22.05C/F4 corrected this doc**, which used to say *"because the floor
    /// crust is one"*. `GenOutcome.surface` is `arena_surface` — `extract_surface`
    /// filtered by `geo.inside` — and the crust sits at `y = h - FLOOR_CRUST - 1`,
    /// outside the rim, which is exactly what that filter removes. Its
    /// neighbour `the_arena_surface_drops_everything_outside_the_rim` asserts
    /// the same thing one screen away, so the two disagreed and the wrong one
    /// was the one a reader reaches for.
    ///
    /// Measured rather than re-reasoned, and now asserted below: Small/4242
    /// with `asteroid_count: 0` yields **111 surface points, 0 of them on the
    /// crust line, all 111 within 1.0 px of the rim's inner face** (thickness
    /// 32; the ellipse gave 22 within 2.8 px — the square rim's bottom is one flat
    /// standable face, T22.17). That is what keeps the fixture falsifying.
    #[test]
    fn a_map_with_no_asteroids_has_no_standable_rock() {
        let scale = MapScale::Small;
        let params = SpaceParams {
            asteroid_count: 0,
            ..SpaceParams::default_for(scale)
        };
        let o = generate_once(4242, &params);
        assert!(
            o.asteroids.is_empty(),
            "the fixture stamped rocks after all"
        );
        assert!(
            !o.surface.is_empty(),
            "the rim's inner face is gone from the arena surface, so this fixture no \
             longer falsifies what it was built to"
        );
        let (on_rocks, rocks_used) = standable_rock_points(&o);
        // Where those points actually are, asserted rather than described.
        // Without this the doc above is a second unchecked claim about the
        // surface, which is the defect F4 is.
        let geo = SpaceGeometry::for_dims(o.mask.w, o.mask.h);
        let crust_line = o.mask.h as i32 - crate::constants::FLOOR_CRUST as i32 - 1;
        let on_crust = o.surface.iter().filter(|p| p.y == crust_line).count();
        let worst = o
            .surface
            .iter()
            .map(|p| (geo.distance_to_rim(p.x as f32, p.y as f32) - geo.thickness * 0.5).abs())
            .fold(0.0f32, f32::max);
        println!(
            "no-asteroid map: {} surface points, {on_rocks} on rock, {rocks_used} rocks used, \
             {on_crust} on the crust line, worst {worst:.1} px off the rim's inner face",
            o.surface.len()
        );
        assert_eq!(on_rocks, 0);
        assert_eq!(
            on_crust, 0,
            "the floor crust is back in the arena surface — the doc above and \
             `the_arena_surface_drops_everything_outside_the_rim` both say it is filtered out"
        );
        assert!(
            worst <= geo.thickness,
            "a surface point is {worst:.1} px from the rim's inner face (thickness {}), \
             so this map's surface is not the rim after all",
            geo.thickness
        );
    }

    /// The hit rate [`SPACE_OPEN_SPACE_TRIES`] is derived from, measured
    /// rather than assumed.
    ///
    /// Two numbers, because they are different: the **grid** rate is the share
    /// of `open_space_grid`'s probes that land in open space, and the **draw**
    /// rate is the share of uniform draws from the centreline rectangle (it was
    /// the ellipse's bounding box, `4/pi` bigger than the ellipse, until R104) that
    /// do — the draw rate being what the attempt budget actually has to survive.
    #[test]
    #[ignore = "a measurement, not a gate"]
    fn the_open_space_hit_rate() {
        for scale in MapScale::ALL {
            let geo = SpaceGeometry::for_scale(scale);
            let (mut grid_hits, mut grid_probes) = (0usize, 0usize);
            let (mut draw_hits, mut draw_probes) = (0usize, 0usize);
            let half_w = (PLAYER_W as i32) / 2;
            let body_h = PLAYER_H as i32;
            for seed in seeds(60) {
                let o = generate_terrain(seed, scale);
                let mut probes = 0usize;
                let mut y = (geo.cy - geo.ry) as i32;
                while y < (geo.cy + geo.ry) as i32 {
                    let mut x = (geo.cx - geo.rx) as i32;
                    while x < (geo.cx + geo.rx) as i32 {
                        probes += 1;
                        x += SPACE_SPAWN_GRID;
                    }
                    y += SPACE_SPAWN_GRID;
                }
                grid_probes += probes;
                grid_hits += open_space_grid(&o.mask, &geo, &o.asteroids).len();

                let mut rng = substream(seed, "hit_rate");
                for _ in 0..400 {
                    let p = Point::new(
                        range_i32(&mut rng, (geo.cx - geo.rx) as i32, (geo.cx + geo.rx) as i32),
                        range_i32(&mut rng, (geo.cy - geo.ry) as i32, (geo.cy + geo.ry) as i32),
                    );
                    draw_probes += 1;
                    if is_open_space(&o.mask, &geo, &o.asteroids, p, half_w, body_h) {
                        draw_hits += 1;
                    }
                }
            }
            let draw = draw_hits as f64 / draw_probes as f64;
            println!(
                "{scale:?}: grid {:.3} ({grid_hits}/{grid_probes}), draw {draw:.3} \
                 ({draw_hits}/{draw_probes}); P(all {SPACE_OPEN_SPACE_TRIES} miss) = {:.3e}",
                grid_hits as f64 / grid_probes as f64,
                (1.0 - draw).powi(SPACE_OPEN_SPACE_TRIES as i32)
            );
        }
    }

    /// `random_open_space` finds somewhere, on every seed and every scale —
    /// and the attempt budget has the headroom its constant claims.
    ///
    /// **Two assertions, and the second is the one that keeps
    /// `SPACE_OPEN_SPACE_TRIES` honest.** *"It returned `Some`"* is satisfied
    /// by a budget of a thousand, so it cannot tell a well-chosen 24 from a
    /// lucky one. What the constant's doc claims is a **rate** — a single draw
    /// succeeding better than half the time, which makes 24 misses a 1e-8
    /// event — so that is what is measured here and re-derived into the
    /// probability the doc states.
    ///
    /// A rate is the right statistic and the worst *observed* draw is not: the
    /// worst of N draws grows with N, so an assertion on it tightens every time
    /// the sample does, which is a gate that fails on how long you looked.
    #[test]
    fn random_open_space_finds_a_point_on_every_seed() {
        let half_w = (PLAYER_W as i32) / 2;
        let body_h = PLAYER_H as i32;
        for scale in MapScale::ALL {
            let geo = SpaceGeometry::for_scale(scale);
            let (mut hits, mut draws) = (0u32, 0u32);
            let mut worst = 0u32;
            for seed in seeds(20) {
                let o = generate_terrain(seed, scale);
                let mut rng = substream(seed, "crates");
                for _ in 0..40 {
                    // The draw is re-run a step at a time so the *cost* is
                    // visible; `random_open_space` only reports the result.
                    let mut used = 0u32;
                    let mut found = None;
                    while used < SPACE_OPEN_SPACE_TRIES && found.is_none() {
                        used += 1;
                        draws += 1;
                        let p = Point::new(
                            range_i32(&mut rng, (geo.cx - geo.rx) as i32, (geo.cx + geo.rx) as i32),
                            range_i32(&mut rng, (geo.cy - geo.ry) as i32, (geo.cy + geo.ry) as i32),
                        );
                        if is_open_space(&o.mask, &geo, &o.asteroids, p, half_w, body_h) {
                            hits += 1;
                            found = Some(p);
                        }
                    }
                    assert!(
                        found.is_some(),
                        "{scale:?} seed {seed}: no open point in {SPACE_OPEN_SPACE_TRIES} tries"
                    );
                    worst = worst.max(used);
                }
            }
            let rate = hits as f64 / draws as f64;
            let miss = (1.0 - rate).powi(SPACE_OPEN_SPACE_TRIES as i32);
            println!(
                "{scale:?}: single-draw hit rate {rate:.3} over {draws} draws, worst draw \
                 {worst} attempts, P(all {SPACE_OPEN_SPACE_TRIES} miss) = {miss:.2e}"
            );
            assert!(
                miss < 1e-6,
                "{scale:?}: a hit rate of {rate:.3} makes {SPACE_OPEN_SPACE_TRIES} attempts \
                 miss with probability {miss:.2e} — `SPACE_OPEN_SPACE_TRIES`' doc claims \
                 better than 1e-6"
            );
        }
    }

    /// **A picky caller nothing satisfies still gets a point** (T22.10C, R86): the
    /// open point with the greatest clearance, over the draws and the whole grid —
    /// never `None` while the map has open space, because the vortex that received
    /// `None` declined to take a player and the void took them instead. The
    /// clearance here is "further right is better, nothing is enough", so the
    /// answer must be open and no grid point may lie further right.
    #[test]
    fn a_clearance_nothing_meets_gets_the_clearest_open_point_not_none() {
        let half_w = (PLAYER_W as i32) / 2;
        let body_h = PLAYER_H as i32;
        let geo = SpaceGeometry::for_scale(MapScale::Small);
        for seed in seeds(4) {
            let o = generate_terrain(seed, MapScale::Small);
            let mut rng = substream(seed, "vortex");
            let p = random_open_space(&o.mask, &geo, &o.asteroids, &mut rng, |q| {
                q.x as f32 - 1.0e6
            })
            .unwrap_or_else(|| panic!("seed {seed}: a picky caller was told nowhere"));
            assert!(is_open_space(
                &o.mask,
                &geo,
                &o.asteroids,
                p,
                half_w,
                body_h
            ));
            let grid_max = open_space_grid(&o.mask, &geo, &o.asteroids)
                .iter()
                .map(|q| q.x)
                .max()
                .expect("control: the grid has open space");
            assert!(
                p.x >= grid_max,
                "seed {seed}: {p:?} is not the clearest (grid has x {grid_max})"
            );
        }
    }

    /// Every point `random_open_space` returns really is open space inside the
    /// rim — the thing crates and periodic items are placed on.
    ///
    /// The falsification is `a_point_outside_the_rim_is_not_open_space`.
    #[test]
    fn random_open_space_returns_open_space() {
        let half_w = (PLAYER_W as i32) / 2;
        let body_h = PLAYER_H as i32;
        for scale in MapScale::ALL {
            let geo = SpaceGeometry::for_scale(scale);
            for seed in seeds(8) {
                let o = generate_terrain(seed, scale);
                let mut rng = substream(seed, "crates");
                for _ in 0..50 {
                    let p = random_open_space(&o.mask, &geo, &o.asteroids, &mut rng, |_| 0.0)
                        .unwrap_or_else(|| panic!("{scale:?} seed {seed}: nowhere open"));
                    assert!(
                        is_open_space(&o.mask, &geo, &o.asteroids, p, half_w, body_h),
                        "{scale:?} seed {seed}: {p:?} is not open space"
                    );
                }
            }
        }
    }

    /// The control for both pickers: the places a space map used to put things
    /// must be refused.
    ///
    /// Three of them, and each one is a **real** site rather than an invented
    /// coordinate: the crust line every spawn and pad sat on before this task
    /// (R35), the sky drop `tick_crates` used (`y = SKY_MARGIN / 2`, R16), and
    /// the centre of a rock. Without this, *"every point is open space"* is
    /// satisfied by a predicate that accepts everything.
    #[test]
    fn the_places_this_map_used_to_put_things_are_not_open_space() {
        let half_w = (PLAYER_W as i32) / 2;
        let body_h = PLAYER_H as i32;
        for scale in MapScale::ALL {
            let geo = SpaceGeometry::for_scale(scale);
            let o = generate_terrain(4242, scale);
            let h = scale.params().height as i32;
            let w = scale.params().width as i32;

            let crust = Point::new(w / 2, h - FLOOR_CRUST as i32 - 1);
            assert!(
                !is_open_space(&o.mask, &geo, &o.asteroids, crust, half_w, body_h),
                "{scale:?}: the floor crust at {crust:?} passed as open space"
            );
            let sky = Point::new(w / 2, (SKY_MARGIN / 2) as i32);
            assert!(
                !is_open_space(&o.mask, &geo, &o.asteroids, sky, half_w, body_h),
                "{scale:?}: the old crate drop at {sky:?} passed as open space"
            );
            let rock = o.asteroids[0];
            assert!(
                !is_open_space(
                    &o.mask,
                    &geo,
                    &o.asteroids,
                    Point::new(rock.x, rock.y),
                    half_w,
                    body_h
                ),
                "{scale:?}: the middle of a rock passed as open space"
            );

            // And the control on the control: somewhere that *is* open, so the
            // three refusals above are not a predicate that refuses everything.
            let open = open_space_grid(&o.mask, &geo, &o.asteroids);
            assert!(!open.is_empty(), "{scale:?}: nothing at all is open space");
        }
    }

    /// **The population claim the deliverable asks for:** over many seeds and
    /// every scale, every spawn a space map ships is inside the boundary, in
    /// open space, and clear of the others.
    ///
    /// One draw is not a population — `every_shipped_spawn_point_is_in_open_
    /// space_inside_the_rim` is seed 4242 and reproduces R35's table; this is
    /// the sweep behind it.
    ///
    /// **The separation floor is the relaxed one, deliberately** (§A19).
    /// `pick_separated` relaxes `SPAWN_MIN_SEPARATION` up to `MAX_RELAXATIONS`
    /// times by `RELAX_FACTOR`, because *"a slightly tighter set of six is
    /// better than four well-spread ones"* — so pinning the unrelaxed constant
    /// here would assert something the sampler does not promise. The worst
    /// separation actually seen is printed, so the gap between what is promised
    /// and what is delivered is a number a reader can see rather than infer.
    #[test]
    fn spawns_are_inside_and_clear_of_each_other_over_many_seeds() {
        let half_w = (PLAYER_W as i32) / 2;
        let body_h = PLAYER_H as i32;
        let floor = SPAWN_MIN_SEPARATION * RELAX_FACTOR.powi(MAX_RELAXATIONS as i32);
        for scale in MapScale::ALL {
            let geo = SpaceGeometry::for_scale(scale);
            let mut worst_sep = f32::MAX;
            let mut worst_at = (0u64, 0.0f32);
            let mut maps = 0usize;
            for seed in seeds(60) {
                let map = crate::map::generate_with(seed, scale, MapGenerator::Space);
                maps += 1;
                assert_eq!(
                    map.meta.spawn_points.len(),
                    SPAWN_COUNT_MIN.max(MAX_PLAYERS),
                    "{scale:?} seed {seed}: wrong spawn count"
                );
                for (i, p) in map.meta.spawn_points.iter().enumerate() {
                    assert!(
                        is_open_space(&map.mask, &geo, &map.meta.asteroids, *p, half_w, body_h),
                        "{scale:?} seed {seed}: spawn {p:?} is not open space inside the rim"
                    );
                    for q in map.meta.spawn_points.iter().skip(i + 1) {
                        let d = (p.distance_sq(*q) as f32).sqrt();
                        if d < worst_sep {
                            worst_sep = d;
                            worst_at = (seed, d);
                        }
                        assert!(
                            d >= floor,
                            "{scale:?} seed {seed}: two spawns {d:.0} px apart, under the \
                             relaxed floor {floor:.0}"
                        );
                    }
                }
            }
            println!(
                "{scale:?}: {maps} maps, closest two spawns {:.0} px (seed {}), \
                 SPAWN_MIN_SEPARATION {SPAWN_MIN_SEPARATION:.0}, relaxed floor {floor:.0}",
                worst_at.1, worst_at.0
            );
        }
    }

    /// The surface a space map ships is the **arena's**, not the whole mask's.
    ///
    /// Three claims, and the third is the one R35 is about:
    /// 1. it is non-empty, so the things that read it have something to read;
    /// 2. every point is inside the rim;
    /// 3. it is a **strict** subset of `extract_surface` — which is the control,
    ///    and it is what says the filter is doing anything at all. Without it,
    ///    *"every point is inside"* passes for a map whose unfiltered surface
    ///    was already inside.
    #[test]
    fn the_arena_surface_drops_everything_outside_the_rim() {
        for scale in MapScale::ALL {
            let geo = SpaceGeometry::for_scale(scale);
            let o = generate_terrain(4242, scale);
            let unfiltered = surface::extract_surface(&o.mask);
            let crust_line = o.mask.h as i32 - FLOOR_CRUST as i32 - 1;

            let on_crust = unfiltered.iter().filter(|p| p.y == crust_line).count();
            println!(
                "{scale:?}: {} surface points unfiltered, {} kept, {on_crust} of the dropped \
                 ones on the floor crust at y={crust_line}",
                unfiltered.len(),
                o.surface.len()
            );
            assert!(!o.surface.is_empty(), "{scale:?}: the arena has no surface");
            assert!(
                on_crust > 0,
                "{scale:?}: the control is gone — `extract_surface` no longer returns the \
                 crust, so this test can no longer show the filter removing it"
            );
            assert!(
                o.surface.len() < unfiltered.len(),
                "{scale:?}: the filter removed nothing"
            );
            for p in &o.surface {
                assert!(
                    geo.inside(p.x as f32, p.y as f32),
                    "{scale:?}: surface point {p:?} is outside the rim"
                );
                assert_ne!(p.y, crust_line, "{scale:?}: a crust point survived");
            }
        }
    }

    /// And the whole pipeline ships that same set — `MapMeta.surface_points` is
    /// `gen::surface_for`'s answer, not `extract_surface`'s.
    ///
    /// The **other end** of the count (`CLAUDE.md`: count the thing at both
    /// ends). `meta.rs::surface_points_match_the_final_mask` asserts the
    /// landscape's equality with `extract_surface`; this asserts the space
    /// map's equality with the function that replaces it, so neither claim is
    /// left resting on the other's generator.
    #[test]
    fn a_space_maps_shipped_surface_is_the_arena_surface() {
        for scale in MapScale::ALL {
            let map = crate::map::generate_with(4242, scale, MapGenerator::Space);
            assert_eq!(
                map.meta.surface_points,
                crate::map::gen::surface_for(MapGenerator::Space, &map.mask),
                "{scale:?}"
            );
            assert_ne!(
                map.meta.surface_points,
                surface::extract_surface(&map.mask),
                "{scale:?}: the shipped surface is the unfiltered one after all"
            );
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
    /// 999-seed sweep — `T21.40`'s shape. T22.17 added the three R103/R104 asked to
    /// be measured: the **fraction of the map inside the rim's inner edge** (pixel
    /// count, off the mask's own geometry), the **open-space spawn candidates** per
    /// map (`open_space_grid`, the pool the six spawns are sampled from), and the
    /// **mass draw** (R103) with the radius it grew each rock to.
    #[test]
    #[ignore = "a measurement, not a gate"]
    fn density_and_gap_report() {
        for scale in MapScale::ALL {
            let geo = SpaceGeometry::for_scale(scale);
            let p = scale.params();
            let inner = |x: f32, y: f32| {
                geo.norm(x, y) < 1.0 && geo.distance_to_rim(x, y) >= geo.thickness * 0.5
            };
            let mut arena_px = 0u64;
            for y in 0..p.height as i32 {
                for x in 0..p.width as i32 {
                    arena_px += inner(x as f32, y as f32) as u64;
                }
            }
            let arena = arena_px as f32;
            let mut counts: Vec<usize> = Vec::new();
            let mut coverage: Vec<f32> = Vec::new();
            let mut gaps: Vec<f32> = Vec::new();
            let mut candidates: Vec<f32> = Vec::new();
            let mut masses: Vec<f32> = Vec::new();
            let mut growth: Vec<f32> = Vec::new();
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
                candidates.push(open_space_grid(&o.mask, &geo, &o.asteroids).len() as f32);
                let params = if o.used_safe_preset {
                    SpaceParams::safe_for(scale)
                } else {
                    SpaceParams::default_for(scale)
                };
                for (a, m) in place_asteroids_drawn(o.seed, &geo, &params) {
                    masses.push(m);
                    growth.push(a.r as f32);
                }
                let rock_area: f32 = o
                    .asteroids
                    .iter()
                    .map(|a| std::f32::consts::PI * (a.r as f32) * (a.r as f32))
                    .sum();
                coverage.push(rock_area / arena);
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
                "  arena inside the rim's inner edge: {arena_px} px, {:.3} of the map",
                arena / (p.width as f32 * p.height as f32)
            );
            println!(
                "  rocks per map: min {} p50 {} max {}",
                counts[0],
                counts[counts.len() / 2],
                counts[counts.len() - 1]
            );
            println!(
                "  open-space spawn candidates per map: min {:.0} p50 {:.0} max {:.0}",
                pct(&mut candidates, 0.0),
                pct(&mut candidates, 0.5),
                pct(&mut candidates, 1.0)
            );
            println!(
                "  coverage of the arena: p05 {:.3} p50 {:.3} p95 {:.3}",
                pct(&mut cov, 0.05),
                pct(&mut cov, 0.50),
                pct(&mut cov, 0.95)
            );
            println!(
                "  mass drawn: min {:.3} p50 {:.3} max {:.3}; radius min {:.0} p50 {:.0} max {:.0}",
                pct(&mut masses, 0.0),
                pct(&mut masses, 0.5),
                pct(&mut masses, 1.0),
                pct(&mut growth, 0.0),
                pct(&mut growth, 0.5),
                pct(&mut growth, 1.0)
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

    /// **R103: every rock draws 0-20 % extra mass, and the draw is what grew it.**
    ///
    /// Over 8 seeds on every scale, off the generator's own draws
    /// (`place_asteroids_drawn`): every `m` is in `[0, SPACE_ASTEROID_MASS_MAX]`,
    /// the spread reaches both ends (the lowest under a tenth of the range, the
    /// highest over nine tenths — a draw pinned at 0 or at the top fails), every
    /// shipped radius is `grown_radius(base, m)` of a base on the old band, and
    /// the per-seed spread is printed.
    ///
    /// **The control is the live binding site**: the same seeds with
    /// `mass_max: 0.0` give rocks whose mean area is smaller by the mean draw —
    /// so the growth is the mass, not a side effect of the rim moving. The ratio
    /// is asserted near `1 + E[m]` = 1.10, loose enough for rounding and the
    /// placement's bias against big rocks.
    #[test]
    fn some_asteroids_are_bigger_by_up_to_a_fifth_of_their_mass() {
        let grown_max = grown_radius(SPACE_ASTEROID_R_MAX, SPACE_ASTEROID_MASS_MAX);
        for scale in MapScale::ALL {
            let geo = SpaceGeometry::for_scale(scale);
            let with = SpaceParams::default_for(scale);
            let without = SpaceParams {
                mass_max: 0.0,
                ..SpaceParams::default_for(scale)
            };
            let (mut lo, mut hi) = (f32::MAX, 0.0f32);
            let (mut area_with, mut area_without) = (0.0f64, 0.0f64);
            let (mut n_with, mut n_without) = (0usize, 0usize);
            for seed in seeds(8) {
                let drawn = place_asteroids_drawn(seed, &geo, &with);
                let ms: Vec<f32> = drawn.iter().map(|(_, m)| *m).collect();
                let (slo, shi) = ms
                    .iter()
                    .fold((f32::MAX, 0.0f32), |(l, h), &m| (l.min(m), h.max(m)));
                println!(
                    "{scale:?} seed {seed}: {} rocks, mass +{:.1}% .. +{:.1}%",
                    ms.len(),
                    slo * 100.0,
                    shi * 100.0
                );
                lo = lo.min(slo);
                hi = hi.max(shi);
                for (a, m) in &drawn {
                    assert!(
                        (0.0..=SPACE_ASTEROID_MASS_MAX).contains(m),
                        "{scale:?} seed {seed}: mass {m}"
                    );
                    assert!(
                        (SPACE_ASTEROID_R_MIN..=grown_max).contains(&a.r),
                        "{scale:?} seed {seed}: radius {} off the grown band",
                        a.r
                    );
                    let base_ok = (SPACE_ASTEROID_R_MIN..=SPACE_ASTEROID_R_MAX)
                        .any(|b| grown_radius(b, *m) == a.r);
                    assert!(
                        base_ok,
                        "{scale:?} seed {seed}: radius {} is no base grown by {m}",
                        a.r
                    );
                    area_with += (a.r as f64).powi(2);
                    n_with += 1;
                }
                assert_eq!(
                    drawn.iter().map(|(a, _)| *a).collect::<Vec<_>>(),
                    place_asteroids(seed, &geo, &with),
                    "the measured draw is not the shipped one"
                );
                for a in place_asteroids(seed, &geo, &without) {
                    area_without += (a.r as f64).powi(2);
                    n_without += 1;
                }
            }
            assert!(
                lo < SPACE_ASTEROID_MASS_MAX * 0.1,
                "{scale:?}: lowest draw {lo}"
            );
            assert!(
                hi > SPACE_ASTEROID_MASS_MAX * 0.9,
                "{scale:?}: highest draw {hi}"
            );
            let ratio = (area_with / n_with as f64) / (area_without / n_without as f64);
            println!(
                "{scale:?}: mass {lo:.3}..{hi:.3}, mean area with/without the draw {ratio:.3}"
            );
            assert!(
                (1.04..=1.16).contains(&ratio),
                "{scale:?}: mean rock area moved by {ratio:.3}, not by the ~1.10 the draw gives"
            );
        }
    }
}
