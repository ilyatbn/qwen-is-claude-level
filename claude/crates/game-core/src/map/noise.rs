//! Hand-written value noise, fBm and domain warp.
//!
//! Hand-written rather than a crate for three reasons: no licensing question, no
//! dependency, and — most importantly — it is directly unit-testable in a way an
//! opaque dependency is not. It is about a hundred lines.
//!
//! Everything here is **pure and stateless**: same inputs, same output, no RNG
//! threading. The generator draws one `u64` from `substream(seed, "terrain")` and
//! passes it in; calling an RNG inside a multi-million-iteration loop would be both
//! slow and pointless.
//!
//! See `docs/10-map-generation.md` §Pass 2.

use crate::constants::{NOISE_BASE_SCALE, NOISE_GAIN, NOISE_LACUNARITY, NOISE_OCTAVES};
use crate::math::smoothstep;

/// Deterministic integer hash of a lattice point.
///
/// `x` and `y` are packed into **disjoint halves** of the word rather than being
/// combined arithmetically. That matters: mixing them with `x*A ^ y*B` lets
/// transposed and negated pairs alias — `hash2(-3, 7)` and `hash2(3, -7)` collide,
/// which puts a visible diagonal symmetry in the terrain. Packing is injective, and
/// every step after it (multiply by an odd constant, xor-shift) is a bijection, so
/// distinct `(x, y)` can never collide for a given seed.
///
/// Two multiplies. This is the hot loop — roughly 60 calls per generated pixel.
#[inline]
pub fn hash2(x: i32, y: i32, seed: u64) -> u64 {
    let mut z = (x as u32 as u64) | ((y as u32 as u64) << 32);
    z ^= seed;
    z ^= z >> 32;
    z = z.wrapping_mul(0xd6e8_feb8_6659_fd93);
    z ^= z >> 32;
    z = z.wrapping_mul(0xd6e8_feb8_6659_fd93);
    z ^ (z >> 32)
}

/// Value at a lattice point, in `0..1`.
#[inline]
pub fn lattice(x: i32, y: i32, seed: u64) -> f32 {
    // Top 24 bits over 2^24: exactly representable in f32, so this is uniform with
    // no rounding bias.
    ((hash2(x, y, seed) >> 40) as f32) / 16_777_216.0
}

/// Smooth 2D value noise in `0..1`: bilinear interpolation between lattice values,
/// with smoothstep easing so the derivative is continuous at cell edges.
#[inline]
pub fn value_noise(x: f32, y: f32, seed: u64) -> f32 {
    let xi = x.floor();
    let yi = y.floor();
    let (x0, y0) = (xi as i32, yi as i32);
    let (fx, fy) = (smoothstep(x - xi), smoothstep(y - yi));

    let v00 = lattice(x0, y0, seed);
    let v10 = lattice(x0 + 1, y0, seed);
    let v01 = lattice(x0, y0 + 1, seed);
    let v11 = lattice(x0 + 1, y0 + 1, seed);

    let a = v00 + (v10 - v00) * fx;
    let b = v01 + (v11 - v01) * fx;
    a + (b - a) * fy
}

/// fBm with an explicit octave count. Exposed so the normalisation can be tested
/// directly — the public [`fbm`] is this with `NOISE_OCTAVES`.
///
/// Normalisation divides by the **sum of the amplitudes actually used**
/// (`1 + gain + gain² + …`), not by the octave count. Without that, the output
/// range would depend on `NOISE_OCTAVES`, so `SOLID_THRESHOLD` would silently
/// change meaning whenever the octave count was tuned.
pub fn fbm_octaves(x: f32, y: f32, seed: u64, octaves: u32) -> f32 {
    let mut sum = 0.0f32;
    let mut amp = 1.0f32;
    let mut amp_total = 0.0f32;
    let mut fx = x;
    let mut fy = y;

    for o in 0..octaves.max(1) {
        // Offset each octave's seed so the layers are independent rather than the
        // same field at different zooms.
        sum += amp
            * value_noise(
                fx,
                fy,
                seed ^ (o as u64).wrapping_mul(0x9e37_79b9_7f4a_7c15),
            );
        amp_total += amp;
        amp *= NOISE_GAIN;
        fx *= NOISE_LACUNARITY;
        fy *= NOISE_LACUNARITY;
    }

    if amp_total <= 0.0 {
        return 0.0;
    }
    sum / amp_total
}

/// Fractal Brownian motion over `NOISE_OCTAVES`, in `0..1`.
#[inline]
pub fn fbm(x: f32, y: f32, seed: u64) -> f32 {
    fbm_octaves(x, y, seed, NOISE_OCTAVES)
}

/// Domain-warped fBm: displace the sample point by a low-frequency field before
/// sampling, so the result does not read as axis-aligned.
///
/// The x and y displacements use **two independent offsets**. Using the same field
/// for both collapses the warp onto the diagonal and looks obviously wrong.
pub fn warped_fbm(x: f32, y: f32, seed: u64) -> f32 {
    let seed_a = seed ^ 0xa24b_1f57_9c3d_e801;
    let seed_b = seed ^ 0x51e1_7d3b_66af_2c95;

    // The warp field is sampled at half frequency, per docs/10 §Pass 2. The
    // sample point is already scaled by NOISE_BASE_SCALE, and WARP_STRENGTH is in
    // pixels, so the displacement is converted into the same scaled space.
    let wx = fbm(x * 0.5, y * 0.5, seed_a) * 2.0 - 1.0;
    let wy = fbm(x * 0.5, y * 0.5, seed_b) * 2.0 - 1.0;

    let d = crate::constants::WARP_STRENGTH * NOISE_BASE_SCALE;
    fbm(x + wx * d, y + wy * d, seed)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::rng::substream;
    use rand::Rng;

    #[test]
    fn value_noise_is_deterministic() {
        let first = value_noise(3.25, -7.5, 42);
        for _ in 0..1000 {
            assert_eq!(value_noise(3.25, -7.5, 42), first);
        }
    }

    #[test]
    fn everything_stays_in_the_unit_range() {
        let mut rng = substream(7, "noise-test");
        for _ in 0..100_000 {
            let x: f32 = rng.gen_range(-5000.0..5000.0);
            let y: f32 = rng.gen_range(-5000.0..5000.0);
            let seed: u64 = rng.gen();

            let v = value_noise(x, y, seed);
            assert!((0.0..=1.0).contains(&v), "value_noise({x},{y}) = {v}");
            let f = fbm(x * 0.01, y * 0.01, seed);
            assert!((0.0..=1.0).contains(&f), "fbm = {f}");
            let w = warped_fbm(x * 0.01, y * 0.01, seed);
            assert!((0.0..=1.0).contains(&w), "warped_fbm = {w}");
        }
    }

    #[test]
    fn value_noise_is_smooth() {
        // Noise that is not smooth produces speckled terrain that the CA pass then
        // has to clean up — better to not create the mess.
        let mut x = -20.0f32;
        while x < 20.0 {
            let mut y = -20.0f32;
            while y < 20.0 {
                let a = value_noise(x, y, 99);
                let b = value_noise(x + 0.01, y, 99);
                let c = value_noise(x, y + 0.01, 99);
                assert!((a - b).abs() < 0.05, "dx jump at ({x},{y}): {a} vs {b}");
                assert!((a - c).abs() < 0.05, "dy jump at ({x},{y}): {a} vs {c}");
                y += 0.137;
            }
            x += 0.137;
        }
    }

    #[test]
    fn value_noise_equals_the_lattice_at_integer_points() {
        for x in -5..5 {
            for y in -5..5 {
                let expected = lattice(x, y, 1234);
                let actual = value_noise(x as f32, y as f32, 1234);
                assert!(
                    (expected - actual).abs() < 1e-6,
                    "({x},{y}): {expected} vs {actual}"
                );
            }
        }
    }

    #[test]
    fn different_seeds_produce_different_fields() {
        let mut total = 0.0f32;
        let mut n = 0;
        for i in 0..100 {
            for j in 0..100 {
                let (x, y) = (i as f32 * 0.3, j as f32 * 0.3);
                total += (value_noise(x, y, 1) - value_noise(x, y, 2)).abs();
                n += 1;
            }
        }
        let mean = total / n as f32;
        assert!(mean > 0.1, "fields too similar: mean abs diff {mean}");
    }

    #[test]
    fn fbm_range_does_not_shift_with_octave_count() {
        // The property that keeps SOLID_THRESHOLD meaningful when octaves are tuned.
        let mut rng = substream(11, "fbm-range");
        for octaves in [1u32, 3, 8] {
            let mut min = f32::MAX;
            let mut max = f32::MIN;
            let mut sum = 0.0f64;
            let n = 20_000;
            for _ in 0..n {
                let x: f32 = rng.gen_range(-100.0..100.0);
                let y: f32 = rng.gen_range(-100.0..100.0);
                let v = fbm_octaves(x, y, 5, octaves);
                assert!((0.0..=1.0).contains(&v), "octaves {octaves}: {v}");
                min = min.min(v);
                max = max.max(v);
                sum += v as f64;
            }
            let mean = sum / n as f64;
            // Value noise is symmetric about 0.5, so every octave count must land
            // its mean near 0.5 rather than drifting with the octave count.
            assert!(
                (mean - 0.5).abs() < 0.05,
                "octaves {octaves}: mean {mean} drifted from 0.5"
            );
            assert!(
                min < 0.3 && max > 0.7,
                "octaves {octaves}: range {min}..{max}"
            );
        }
    }

    #[test]
    fn warp_actually_applies() {
        let mut differs = 0;
        for i in 0..200 {
            let (x, y) = (i as f32 * 0.05, i as f32 * 0.037);
            if (warped_fbm(x, y, 77) - fbm(x, y, 77)).abs() > 1e-4 {
                differs += 1;
            }
        }
        assert!(differs > 190, "warp barely changed anything: {differs}/200");
    }

    #[test]
    fn warp_uses_independent_fields_for_x_and_y() {
        // If both displacements came from one field the warp would collapse onto
        // the diagonal: dx would always equal dy. Reconstruct them and check.
        let seed = 4242u64;
        let seed_a = seed ^ 0xa24b_1f57_9c3d_e801;
        let seed_b = seed ^ 0x51e1_7d3b_66af_2c95;
        let mut same = 0;
        for i in 0..200 {
            let (x, y) = (i as f32 * 0.11, i as f32 * 0.07);
            let wx = fbm(x * 0.5, y * 0.5, seed_a);
            let wy = fbm(x * 0.5, y * 0.5, seed_b);
            if (wx - wy).abs() < 1e-6 {
                same += 1;
            }
        }
        assert_eq!(same, 0, "x and y displacement fields are not independent");
    }

    #[test]
    fn hash2_avalanches() {
        // Flipping one input bit must change at least a quarter of the output bits
        // on average. A weak hash here shows up as grid artefacts in the terrain.
        let mut rng = substream(13, "avalanche");
        let mut total_changed = 0u64;
        let mut samples = 0u64;

        for _ in 0..2000 {
            let x: i32 = rng.gen();
            let y: i32 = rng.gen();
            let seed: u64 = rng.gen();
            let base = hash2(x, y, seed);

            for bit in 0..32 {
                let flipped = hash2(x ^ (1 << bit), y, seed);
                total_changed += (base ^ flipped).count_ones() as u64;
                samples += 1;
            }
        }

        let mean_changed = total_changed as f64 / samples as f64;
        assert!(
            mean_changed >= 16.0,
            "weak avalanche: {mean_changed} of 64 bits changed on average"
        );
    }

    #[test]
    fn hash2_distinguishes_transposed_and_negated_coordinates() {
        // (x,y) and (y,x) must differ, or the terrain is diagonally symmetric.
        assert_ne!(hash2(3, 7, 1), hash2(7, 3, 1));
        assert_ne!(hash2(-3, 7, 1), hash2(3, -7, 1));
        assert_ne!(hash2(0, 0, 1), hash2(0, 0, 2));
        assert_ne!(hash2(1, 0, 0), hash2(0, 1, 0));
    }

    #[test]
    fn lattice_spans_the_unit_interval() {
        let mut min = f32::MAX;
        let mut max = f32::MIN;
        for x in 0..200 {
            for y in 0..200 {
                let v = lattice(x, y, 5);
                assert!((0.0..=1.0).contains(&v));
                min = min.min(v);
                max = max.max(v);
            }
        }
        assert!(min < 0.01 && max > 0.99, "lattice range {min}..{max}");
    }
}
