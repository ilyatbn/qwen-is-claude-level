//! v2 pass 1: the ground, from a 1D height profile.
//!
//! The whole difference between v1 and v2 lives in this file. v1 asks "is this
//! *pixel* solid?" of a 2D field, which has no notion of where the ground is and
//! therefore puts rock in the sky and air underground in equal measure. v2 asks
//! "how high is the ground at this *column*?" and fills everything below it.
//!
//! A pure profile would be a smooth sine hill, which is not a Worms map either.
//! Four things are laid on top of it, in this order, because each one is allowed
//! to overwrite the last:
//!
//! 1. **fBm** — a couple of hills with shoulders and bumps.
//! 2. **Terraces** — stretches quantised to `TERRACE_STEP`, which is where the
//!    flat ledges you stand and fight on come from.
//! 3. **Mesas** — flat-topped columns with stepped sides.
//! 4. **Chasms** — canyons cut back down, some of them to the bedrock.
//!
//! The profile is then filled row-major and its crest is roughened with small
//! circles, so the boundary reads as rock rather than as a plotted function.

use crate::constants::{
    CHASM_PARTIAL_DEPTH_MAX, CHASM_PARTIAL_DEPTH_MIN, CHASM_SHOULDER, CHASM_TO_BEDROCK_CHANCE,
    CHASM_WIDTH_MAX, CHASM_WIDTH_MIN, FLOOR_CRUST, GROUND_BASE_FRAC, GROUND_CREST_HEADROOM,
    GROUND_DETAIL_AMPLITUDE, GROUND_DETAIL_WAVELENGTH, GROUND_OCTAVES, GROUND_WAVELENGTH_FRAC,
    LEDGE_WIDTH_MAX, LEDGE_WIDTH_MIN, MESA_RISE_MAX, MESA_RISE_MIN, MESA_SHOULDER, MESA_WIDTH_MAX,
    MESA_WIDTH_MIN, ROUGHEN_CARVE_CHANCE, ROUGHEN_OFFSET, ROUGHEN_PLACE_CHANCE, ROUGHEN_RADIUS_MAX,
    ROUGHEN_RADIUS_MIN, ROUGHEN_STEP, SKY_MARGIN, TERRACE_FRACTION, TERRACE_RUN_FRAC, TERRACE_STEP,
    WALL_W,
};
use crate::map::gen::silhouette::force_borders;
use crate::map::noise::fbm_octaves;
use crate::map::shape::stamp_circle;
use crate::map::Mask;
use crate::rng::{chance, range_i32, substream, ChaCha8Rng};

use super::V2Params;

/// The ground line, one y per column. Larger y is lower.
#[derive(Clone, Debug, PartialEq)]
pub struct Profile {
    pub y: Vec<i32>,
    /// Top of the bedrock band: the lowest a column's ground line may go.
    pub floor: i32,
    /// Highest a column's ground line may go.
    pub ceiling: i32,
}

impl Profile {
    /// Ground line at `x`, clamped to the map.
    pub fn at(&self, x: i32) -> i32 {
        let i = x.clamp(0, self.y.len() as i32 - 1) as usize;
        self.y[i]
    }

    /// Rock below the ground line at `x`, in px.
    pub fn thickness(&self, x: i32) -> i32 {
        self.floor - self.at(x)
    }

    /// Lowest ground line (largest y) over `[x0, x1]`.
    pub fn lowest(&self, x0: i32, x1: i32) -> i32 {
        (x0..=x1).map(|x| self.at(x)).max().unwrap_or(self.floor)
    }

    /// Highest ground line (smallest y) over `[x0, x1]`.
    pub fn highest(&self, x0: i32, x1: i32) -> i32 {
        (x0..=x1).map(|x| self.at(x)).min().unwrap_or(self.ceiling)
    }
}

/// Build the profile: fBm, then terraces, mesas and chasms over it.
pub fn build_profile(seed: u64, params: &V2Params) -> Profile {
    let (w, h) = (params.width() as i32, params.height() as i32);
    let floor = h - FLOOR_CRUST as i32;
    let ceiling = SKY_MARGIN as i32 + GROUND_CREST_HEADROOM;

    let base = (h as f32 * GROUND_BASE_FRAC).round() as i32;
    let amp = h as f32 * params.amplitude_frac;
    let wavelength = (w as f32 * GROUND_WAVELENGTH_FRAC).max(1.0);

    // One `u64` for the whole profile: the noise is pure, so it needs the seed and
    // nothing else. The sub-stream is only consulted for the discrete features.
    let nseed: u64 = {
        use rand::Rng;
        substream(seed, "v2-profile").gen()
    };

    // Sample along a line through the 2D field. The fixed second coordinate is
    // arbitrary but must not be an integer: on the lattice, `value_noise`
    // interpolates between two identical rows and the octaves collapse.
    let raw: Vec<f32> = (0..w)
        .map(|x| fbm_octaves(x as f32 / wavelength, 0.37, nseed, GROUND_OCTAVES))
        .collect();

    // Stretch the sampled range to the full amplitude before using it.
    //
    // fBm is nominally 0..1 but a few thousand samples of it only cover the middle
    // — measured 0.36..0.63 across a medium map — so the nominal amplitude buys a
    // quarter of the swing it promises and the map comes out a plain with a couple
    // of dents. Normalising is what makes `GROUND_AMPLITUDE_FRAC` mean what it
    // says. It is deterministic: the same samples give the same bounds.
    let lo = raw.iter().copied().fold(f32::MAX, f32::min);
    let hi = raw.iter().copied().fold(f32::MIN, f32::max);
    let span = (hi - lo).max(f32::EPSILON);

    let y: Vec<i32> = raw
        .iter()
        .map(|n| base - (((n - lo) / span - 0.5) * 2.0 * amp).round() as i32)
        .collect();

    let mut profile = Profile { y, floor, ceiling };

    let mut rng = substream(seed, "v2-ground");
    apply_terraces(&mut profile, &mut rng, w);
    apply_mesas(&mut profile, &mut rng, w, params.mesa_count);
    apply_chasms(&mut profile, &mut rng, w, params.chasm_count);
    apply_detail(&mut profile, nseed, w);

    for v in &mut profile.y {
        *v = (*v).clamp(ceiling, floor);
    }
    profile
}

/// A last, fine wobble over everything — ledges, cliff faces and canyon floors
/// alike. Applied **after** the features precisely so it disturbs them: a ledge
/// that is exactly flat and a riser that is exactly vertical read as masonry.
fn apply_detail(profile: &mut Profile, nseed: u64, w: i32) {
    for x in 0..w {
        let n = fbm_octaves(
            x as f32 / GROUND_DETAIL_WAVELENGTH,
            11.61,
            nseed ^ 0x5bf0_3635_9a1d_c4e7,
            2,
        );
        profile.y[x as usize] += ((n - 0.5) * 2.0 * GROUND_DETAIL_AMPLITUDE).round() as i32;
    }
}

/// Quantise stretches of the profile to `TERRACE_STEP`, leaving the rest rolling.
///
/// A run is quantised as a whole so its steps line up: quantising per column with
/// a per-column decision produces a comb, not a staircase.
fn apply_terraces(profile: &mut Profile, rng: &mut ChaCha8Rng, w: i32) {
    let run = ((w as f32 * TERRACE_RUN_FRAC).round() as i32).max(LEDGE_WIDTH_MAX);
    let runs = ((w as f32 * TERRACE_FRACTION) / run as f32).round() as i32;

    for _ in 0..runs.max(0) {
        let x0 = range_i32(rng, 0, (w - run).max(1));
        let end = (x0 + run).min(w);

        // Walk the run in ledges. Each ledge takes **one** height for its whole
        // width — the mean of the profile under it, snapped to `TERRACE_STEP` —
        // so the result is a staircase with risers you can see, not a comb.
        let mut x = x0;
        while x < end {
            let mut x1 = (x + range_i32(rng, LEDGE_WIDTH_MIN, LEDGE_WIDTH_MAX)).min(end);
            // Absorb a stub tail into this ledge. A 10 px ledge snapped to its own
            // mean is a one-column needle sticking out of the hillside, and the
            // truncation at `end` produces one every time.
            if end - x1 < LEDGE_WIDTH_MIN {
                x1 = end;
            }
            let span = (x1 - x).max(1);
            let mean: i32 =
                (x..x1).map(|i| profile.y[i as usize] as i64).sum::<i64>() as i32 / span;
            let snapped = (mean as f32 / TERRACE_STEP as f32).round() as i32 * TERRACE_STEP;
            for i in x..x1 {
                profile.y[i as usize] = snapped;
            }
            x = x1;
        }
    }
}

/// Raise flat-topped columns out of the profile, with stepped sides.
fn apply_mesas(profile: &mut Profile, rng: &mut ChaCha8Rng, w: i32, count: u32) {
    let margin = WALL_W as i32 + MESA_SHOULDER * 2;
    for _ in 0..count {
        let width = range_i32(rng, MESA_WIDTH_MIN, MESA_WIDTH_MAX);
        let rise = range_i32(rng, MESA_RISE_MIN, MESA_RISE_MAX);
        let lo = margin;
        let hi = w - margin - width;
        if hi <= lo {
            continue;
        }
        let x0 = range_i32(rng, lo, hi);
        let x1 = x0 + width;

        // The top is flat at one height rather than the profile minus a constant:
        // a constant offset keeps the underlying wobble and the "column" reads as
        // a hill that happens to be higher.
        let top = (profile.highest(x0, x1) - rise).max(profile.ceiling);
        for x in x0..x1 {
            profile.y[x as usize] = top;
        }

        // Two shoulder steps a side, so the flanks are a staircase rather than a
        // sheer 300 px wall nobody can climb.
        for (i, step) in [(1, top + rise / 3), (2, top + (rise * 2) / 3)] {
            let sw = MESA_SHOULDER;
            let (l0, l1) = (x0 - sw * i, x0 - sw * (i - 1));
            let (r0, r1) = (x1 + sw * (i - 1), x1 + sw * i);
            for x in l0.max(0)..l1.max(0) {
                profile.y[x as usize] = profile.y[x as usize].min(step).max(top);
            }
            for x in r0.min(w)..r1.min(w) {
                profile.y[x as usize] = profile.y[x as usize].min(step).max(top);
            }
        }
    }
}

/// Cut canyons back down through the profile.
fn apply_chasms(profile: &mut Profile, rng: &mut ChaCha8Rng, w: i32, count: u32) {
    let margin = WALL_W as i32 + CHASM_SHOULDER + 24;
    for _ in 0..count {
        let width = range_i32(rng, CHASM_WIDTH_MIN, CHASM_WIDTH_MAX);
        let lo = margin;
        let hi = w - margin - width;
        if hi <= lo {
            continue;
        }
        let x0 = range_i32(rng, lo, hi);
        let x1 = x0 + width;

        // To the bedrock, or a deep notch. Both are wanted: the first is the gap
        // between the two towers in a Worms map, the second is a pit you can
        // climb out of.
        let bottom = if chance(rng, CHASM_TO_BEDROCK_CHANCE) {
            profile.floor
        } else {
            profile.lowest(x0, x1)
                + range_i32(rng, CHASM_PARTIAL_DEPTH_MIN, CHASM_PARTIAL_DEPTH_MAX)
        }
        .min(profile.floor);

        for x in x0..x1 {
            profile.y[x as usize] = profile.y[x as usize].max(bottom);
        }
        // Shoulders: one step, so the canyon has a lip rather than a bevel.
        let lip = bottom - (bottom - profile.highest(x0, x1)) / 3;
        for x in (x0 - CHASM_SHOULDER).max(0)..x0 {
            profile.y[x as usize] = profile.y[x as usize].max(lip);
        }
        for x in x1..(x1 + CHASM_SHOULDER).min(w) {
            profile.y[x as usize] = profile.y[x as usize].max(lip);
        }
    }
}

/// Fill every column below its ground line, row-major.
///
/// Row-major with a run accumulator for the same reason `silhouette` is: the mask
/// writes whole words when adjacent columns agree, which on a height profile is
/// almost always.
pub fn fill(mask: &mut Mask, profile: &Profile) {
    let (w, h) = (mask.w as i32, mask.h as i32);
    for y in 0..h {
        let mut run_start: i32 = -1;
        for x in 0..w {
            if profile.y[x as usize] <= y {
                if run_start < 0 {
                    run_start = x;
                }
            } else if run_start >= 0 {
                mask.set_run(y, run_start, x - 1);
                run_start = -1;
            }
        }
        if run_start >= 0 {
            mask.set_run(y, run_start, w - 1);
        }
    }
    force_borders(mask);
}

/// Break the crest up with small circles, half of them bitten out.
///
/// Without this the ground is the graph of a function: every column has exactly
/// one air/rock boundary and the silhouette is visibly one-valued. The circles
/// are small on purpose — big ones would undo the terraces.
pub fn roughen(mask: &mut Mask, profile: &Profile, seed: u64) {
    let mut rng = substream(seed, "v2-roughen");
    let w = mask.w as i32;

    let mut x = WALL_W as i32 + ROUGHEN_STEP;
    while x < w - WALL_W as i32 - ROUGHEN_STEP {
        if chance(&mut rng, ROUGHEN_PLACE_CHANCE) {
            let r = range_i32(&mut rng, ROUGHEN_RADIUS_MIN, ROUGHEN_RADIUS_MAX);
            let dy = range_i32(&mut rng, -ROUGHEN_OFFSET, ROUGHEN_OFFSET);
            let solid = !chance(&mut rng, ROUGHEN_CARVE_CHANCE);
            stamp_circle(mask, x, profile.at(x) + dy, r, solid);
        }
        x += ROUGHEN_STEP + range_i32(&mut rng, -ROUGHEN_STEP / 3, ROUGHEN_STEP / 3);
    }

    force_borders(mask);
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::constants::MapScale;

    fn params() -> V2Params {
        V2Params::default_for(MapScale::Small)
    }

    #[test]
    fn the_profile_stays_between_the_sky_and_the_bedrock() {
        for seed in 0..12u64 {
            let p = build_profile(seed * 7919, &params());
            for (x, &y) in p.y.iter().enumerate() {
                assert!(
                    y >= p.ceiling && y <= p.floor,
                    "seed {seed} column {x}: ground line {y} outside {}..{}",
                    p.ceiling,
                    p.floor
                );
            }
        }
    }

    #[test]
    fn the_profile_is_deterministic() {
        let p = params();
        let first = build_profile(4242, &p);
        for _ in 0..8 {
            assert_eq!(build_profile(4242, &p), first);
        }
    }

    #[test]
    fn different_seeds_give_different_profiles() {
        let p = params();
        assert_ne!(build_profile(1, &p).y, build_profile(2, &p).y);
    }

    /// The headline property: a filled column is solid from the ground line down
    /// and air above it. This is what "not a cave system" means, and it is the one
    /// thing v1 cannot say about its output.
    #[test]
    fn fill_puts_air_above_the_line_and_rock_below_it() {
        let params = params();
        let p = build_profile(31337, &params);
        let mut m = Mask::new_empty(params.width(), params.height());
        fill(&mut m, &p);

        let w = m.w as i32;
        for x in (WALL_W as i32 + 4)..(w - WALL_W as i32 - 4) {
            let g = p.at(x);
            assert!(!m.get(x, g - 1), "column {x}: rock just above the line");
            assert!(m.get(x, g + 1), "column {x}: air just below the line");
            assert!(
                !m.get(x, SKY_MARGIN as i32 + 4),
                "column {x}: rock in the sky"
            );
        }
    }

    /// A control for the test above: with the profile deleted the map is empty, so
    /// "air above the line" would hold vacuously. Assert the rock is really there.
    #[test]
    fn fill_produces_a_substantial_amount_of_rock() {
        let params = params();
        let p = build_profile(31337, &params);
        let mut m = Mask::new_empty(params.width(), params.height());
        fill(&mut m, &p);
        let f = m.count_solid() as f32 / (m.w as f32 * m.h as f32);
        assert!((0.20..=0.60).contains(&f), "solid fraction {f}");
    }

    /// Terraces make ledges: stretches of *one* height, at least a ledge wide.
    ///
    /// Driven against `apply_terraces` rather than the finished profile, because
    /// `apply_detail` runs last and deliberately puts a few px of wobble on
    /// everything — a finished profile has no exactly-flat run and this would be
    /// asserting on the wobble. The ramp is the control: a 1-px-per-column ramp
    /// has no flat run at all, so a passing assertion is this pass's doing.
    #[test]
    fn terraces_turn_a_ramp_into_ledges() {
        let longest_flat = |p: &Profile| {
            let (mut best, mut run) = (1, 1);
            for i in 1..p.y.len() {
                run = if p.y[i] == p.y[i - 1] { run + 1 } else { 1 };
                best = best.max(run);
            }
            best
        };

        let w = 2048i32;
        let ramp = Profile {
            y: (0..w).map(|x| 200 + x / 4).collect(),
            floor: 1000,
            ceiling: 100,
        };
        assert_eq!(longest_flat(&ramp), 4, "the control ramp is not a ramp");

        let mut terraced = ramp.clone();
        apply_terraces(&mut terraced, &mut substream(4242, "test"), w);
        assert!(
            longest_flat(&terraced) >= LEDGE_WIDTH_MIN,
            "longest ledge is only {} px, under LEDGE_WIDTH_MIN",
            longest_flat(&terraced)
        );
    }

    /// The stub-tail guard. Without it the last ledge of a run can be a handful of
    /// columns wide, snapped to its own mean, and that is a one-column needle
    /// sticking out of the hillside — visible in the first v2 dump.
    #[test]
    fn no_terrace_ledge_is_narrower_than_a_ledge() {
        let w = 2048i32;
        let mut p = Profile {
            y: (0..w).map(|x| 200 + x / 4).collect(),
            floor: 1000,
            ceiling: 100,
        };
        apply_terraces(&mut p, &mut substream(7, "test"), w);

        // Walk the constant-height runs. Anything shorter than a ledge that is not
        // part of the untouched ramp (run length 4) is a stub.
        let (mut start, mut i) = (0usize, 1usize);
        while i <= p.y.len() {
            if i == p.y.len() || p.y[i] != p.y[start] {
                let len = i - start;
                assert!(
                    len <= 4 || len >= LEDGE_WIDTH_MIN as usize,
                    "a {len} px ledge at {start}"
                );
                start = i;
            }
            i += 1;
        }
    }

    #[test]
    fn a_chasm_reaches_the_bedrock_on_some_seed() {
        // Not every seed: `CHASM_TO_BEDROCK_CHANCE` is a coin flip and a gate that
        // fails on one gates nothing. Over 20 seeds it must happen at least once.
        let p = params();
        let hits = (0..20u64)
            .filter(|s| {
                let pr = build_profile(s * 104_729, &p);
                pr.y.iter().any(|&y| y >= pr.floor)
            })
            .count();
        assert!(hits > 0, "no seed of 20 cut a chasm to the bedrock");
    }

    #[test]
    fn roughen_changes_the_crest_without_touching_the_borders() {
        let params = params();
        let p = build_profile(7, &params);
        let mut m = Mask::new_empty(params.width(), params.height());
        fill(&mut m, &p);
        let before = m.hash();
        roughen(&mut m, &p, 7);
        assert_ne!(m.hash(), before, "roughen did nothing");
        assert!(crate::map::gen::borders_hold(&m));
    }
}
