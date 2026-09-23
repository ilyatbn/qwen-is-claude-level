//! Run-length encoding of the mask for `map_init`.
//!
//! Alternating runs, row-major, starting with a run of **clear** pixels (length 0
//! if the first pixel is solid). Starting with a known colour removes the need for
//! a per-run flag byte — the parity of the run index tells you the value. It costs
//! one byte in the worst case and simplifies both sides.
//!
//! Run lengths are LEB128 varints, in pixels.
//!
//! **The decoder handles untrusted input.** It is reached directly from a network
//! message, so it must never panic, never allocate on an unvalidated length, and
//! never write past the mask. A panic here is a remote crash.
//!
//! See `docs/40-net-protocol.md` §3.

use crate::map::Mask;

/// A varint longer than this cannot represent a `u64` and is malformed.
const MAX_VARINT_BYTES: usize = 10;

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum RleError {
    /// Input ended before `w*h` pixels were produced.
    Truncated,
    /// A run would push the total past `w*h`, or trailing bytes followed a
    /// complete mask.
    Overrun {
        expected: u64,
        got: u64,
    },
    VarintTooLong,
    /// Dimensions that cannot describe a mask.
    BadDimensions,
}

impl core::fmt::Display for RleError {
    fn fmt(&self, f: &mut core::fmt::Formatter<'_>) -> core::fmt::Result {
        match self {
            RleError::Truncated => write!(f, "RLE input ended early"),
            RleError::Overrun { expected, got } => {
                write!(f, "RLE describes {got} pixels, expected {expected}")
            }
            RleError::VarintTooLong => write!(f, "RLE varint longer than {MAX_VARINT_BYTES} bytes"),
            RleError::BadDimensions => write!(f, "RLE dimensions are not a valid mask"),
        }
    }
}

fn push_varint(out: &mut Vec<u8>, mut v: u64) {
    loop {
        let byte = (v & 0x7f) as u8;
        v >>= 7;
        if v == 0 {
            out.push(byte);
            return;
        }
        out.push(byte | 0x80);
    }
}

fn read_varint(bytes: &[u8], at: &mut usize) -> Result<u64, RleError> {
    let mut result = 0u64;
    let mut shift = 0u32;
    for i in 0..MAX_VARINT_BYTES {
        let Some(&b) = bytes.get(*at) else {
            return Err(RleError::Truncated);
        };
        *at += 1;
        result |= ((b & 0x7f) as u64) << shift;
        if b & 0x80 == 0 {
            return Ok(result);
        }
        shift += 7;
        if i == MAX_VARINT_BYTES - 1 {
            return Err(RleError::VarintTooLong);
        }
    }
    Err(RleError::VarintTooLong)
}

/// Encode a mask as alternating runs, starting with clear.
///
/// Scans whole words with `trailing_zeros`/`trailing_ones` rather than per pixel —
/// a large mask is 8 M pixels and this runs at every round start.
pub fn encode(mask: &Mask) -> Vec<u8> {
    let total = mask.w as u64 * mask.h as u64;
    let mut out = Vec::with_capacity(4096);

    let mut pos = 0u64;
    let mut run_solid = false; // the first run is clear, per the format
    let mut run_len = 0u64;

    let words = mask.words();
    while pos < total {
        let word_idx = (pos / 64) as usize;
        let bit_in_word = (pos % 64) as u32;
        let word = words[word_idx];

        // How many bits from here match the current run's colour?
        let shifted = if run_solid {
            // Count leading ones from bit_in_word: invert and count zeros.
            (!word) >> bit_in_word
        } else {
            word >> bit_in_word
        };
        let same = if shifted == 0 {
            64 - bit_in_word
        } else {
            shifted.trailing_zeros()
        };

        let remaining_in_word = 64 - bit_in_word;
        let take = same.min(remaining_in_word) as u64;
        let take = take.min(total - pos);

        if take > 0 {
            run_len += take;
            pos += take;
            continue;
        }

        // The colour changed at exactly this bit: close the run and flip.
        push_varint(&mut out, run_len);
        run_len = 0;
        run_solid = !run_solid;
    }

    if run_len > 0 {
        push_varint(&mut out, run_len);
    }

    out
}

/// Decode into a mask of the given dimensions.
pub fn decode(w: u32, h: u32, bytes: &[u8]) -> Result<Mask, RleError> {
    if w == 0 || h == 0 || !w.is_multiple_of(64) {
        return Err(RleError::BadDimensions);
    }
    let total = w as u64 * h as u64;

    // The mask starts empty, so clear runs are a pure skip.
    let mut mask = Mask::new_empty_raw(w, h).ok_or(RleError::BadDimensions)?;
    let mut at = 0usize;
    let mut pos = 0u64;
    let mut solid = false;

    while pos < total {
        let len = read_varint(bytes, &mut at)?;
        let end = pos.checked_add(len).ok_or(RleError::Overrun {
            expected: total,
            got: u64::MAX,
        })?;
        if end > total {
            return Err(RleError::Overrun {
                expected: total,
                got: end,
            });
        }

        if solid && len > 0 {
            write_run(&mut mask, pos, end);
        }

        pos = end;
        solid = !solid;
    }

    // Trailing bytes after a complete mask are an error, not something to ignore:
    // they mean the sender and receiver disagree about the format.
    if at != bytes.len() {
        return Err(RleError::Overrun {
            expected: total,
            got: total + (bytes.len() - at) as u64,
        });
    }

    Ok(mask)
}

/// Set the linear bit range `[from, to)`, splitting it into per-row runs.
fn write_run(mask: &mut Mask, from: u64, to: u64) {
    let w = mask.w as u64;
    let mut pos = from;
    while pos < to {
        let y = (pos / w) as i32;
        let x0 = (pos % w) as i32;
        let row_end = ((y as u64 + 1) * w).min(to);
        let x1 = ((row_end - 1) % w) as i32;
        mask.set_run(y, x0, x1);
        pos = row_end;
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::constants::MapScale;
    use crate::map::gen::generate_terrain;
    use crate::rng::substream;
    use rand::Rng;

    const W: u32 = 512;
    const H: u32 = 256;

    fn round_trip(m: &Mask) {
        let bytes = encode(m);
        let back = decode(m.w, m.h, &bytes).expect("decode");
        assert_eq!(back.hash(), m.hash(), "round trip changed the mask");
    }

    #[test]
    fn round_trips_the_degenerate_masks() {
        round_trip(&Mask::new_empty(W, H));
        round_trip(&Mask::new_full(W, H));

        let mut one = Mask::new_empty(W, H);
        one.set(0, 0);
        round_trip(&one);

        let mut last = Mask::new_empty(W, H);
        last.set(W as i32 - 1, H as i32 - 1);
        round_trip(&last);

        let mut hole = Mask::new_full(W, H);
        hole.clear(100, 100);
        round_trip(&hole);

        let mut first_solid = Mask::new_empty(W, H);
        first_solid.set_run(0, 0, 9);
        round_trip(&first_solid);
    }

    #[test]
    fn an_empty_mask_encodes_to_a_single_run() {
        let bytes = encode(&Mask::new_empty(W, H));
        let back = decode(W, H, &bytes).expect("decode");
        assert_eq!(back.count_solid(), 0);
        // One varint for the whole clear run.
        assert!(
            bytes.len() <= 5,
            "expected a tiny encoding, got {}",
            bytes.len()
        );
    }

    #[test]
    fn a_full_mask_starts_with_a_zero_length_clear_run() {
        let bytes = encode(&Mask::new_full(W, H));
        assert_eq!(
            bytes[0], 0,
            "the leading clear run must be present, length 0"
        );
        let back = decode(W, H, &bytes).expect("decode");
        assert_eq!(back.count_solid(), W as u64 * H as u64);
    }

    #[test]
    fn round_trips_real_maps_at_every_scale() {
        for scale in MapScale::ALL {
            let o = generate_terrain(4242, scale);
            round_trip(&o.mask);
        }
    }

    #[test]
    fn round_trips_random_run_masks() {
        for seed in 0..20u64 {
            let mut rng = substream(seed, "rle-fuzz");
            let mut m = Mask::new_empty(W, H);
            for _ in 0..200 {
                let y = rng.gen_range(0..H as i32);
                let x0 = rng.gen_range(0..W as i32);
                let x1 = (x0 + rng.gen_range(0..80)).min(W as i32 - 1);
                m.set_run(y, x0, x1);
            }
            round_trip(&m);
        }
    }

    #[test]
    fn the_pathological_alternating_mask_round_trips_within_bounds() {
        let mut m = Mask::new_empty(W, H);
        for y in 0..H as i32 {
            let mut x = if y % 2 == 0 { 0 } else { 1 };
            while x < W as i32 {
                m.set(x, y);
                x += 2;
            }
        }
        round_trip(&m);

        let bytes = encode(&m);
        let pixels = W as usize * H as usize;

        // The task file suggests a bound of w*h/4. That is arithmetically
        // impossible for this input and no encoder could meet it: alternating
        // single pixels means w*h runs, and a LEB128 varint is at least one byte
        // per run. The floor is w*h bytes.
        //
        // The bound worth asserting is therefore "never worse than one byte per
        // pixel", which is what catches a naive fixed-width or per-pixel-record
        // encoding. Measured: 130818 bytes for 131072 pixels — the encoder is at
        // the information-theoretic floor for this pattern, and slightly under it
        // because row parity alternates, so runs merge at row boundaries.
        assert!(
            bytes.len() <= pixels,
            "alternating mask encoded to {} bytes for {pixels} pixels — worse than \
             one byte per pixel means the run encoding is not working at all",
            bytes.len()
        );
    }

    #[test]
    fn a_real_medium_map_compresses_well() {
        let o = generate_terrain(4242, MapScale::Medium);
        let bytes = encode(&o.mask);
        println!("medium map RLE: {} bytes", bytes.len());
        assert!(
            bytes.len() < 120_000,
            "medium map encoded to {} bytes",
            bytes.len()
        );
    }

    #[test]
    fn truncated_input_is_rejected() {
        let m = Mask::new_full(W, H);
        let bytes = encode(&m);
        for cut in [0, 1, bytes.len() / 2] {
            let err = decode(W, H, &bytes[..cut]).expect_err("must reject");
            assert!(
                matches!(err, RleError::Truncated | RleError::Overrun { .. }),
                "unexpected error for cut {cut}: {err:?}"
            );
        }
    }

    #[test]
    fn a_run_claiming_more_than_the_mask_is_an_overrun() {
        // A leading clear run of w*h + 1 pixels.
        let mut bytes = Vec::new();
        push_varint(&mut bytes, (W as u64 * H as u64) + 1);
        assert!(matches!(
            decode(W, H, &bytes),
            Err(RleError::Overrun { .. })
        ));
    }

    #[test]
    fn an_over_long_varint_is_rejected() {
        let bytes = vec![0x80u8; MAX_VARINT_BYTES + 1];
        assert_eq!(decode(W, H, &bytes), Err(RleError::VarintTooLong));
    }

    #[test]
    fn trailing_garbage_is_rejected() {
        let m = Mask::new_full(W, H);
        let mut bytes = encode(&m);
        bytes.push(0x00);
        assert!(matches!(
            decode(W, H, &bytes),
            Err(RleError::Overrun { .. })
        ));
    }

    #[test]
    fn bad_dimensions_are_rejected() {
        assert_eq!(decode(0, 10, &[0]), Err(RleError::BadDimensions));
        assert_eq!(decode(10, 0, &[0]), Err(RleError::BadDimensions));
        // Not a multiple of 64: rows would not start on word boundaries.
        assert_eq!(decode(100, 100, &[0]), Err(RleError::BadDimensions));
    }

    /// A panic in this decoder is a remote crash.
    #[test]
    fn fuzzing_with_random_bytes_never_panics() {
        let mut rng = substream(31337, "rle-fuzz-bytes");
        for _ in 0..10_000 {
            let len = rng.gen_range(0..64);
            let bytes: Vec<u8> = (0..len).map(|_| rng.gen::<u8>()).collect();
            // Small dimensions so a valid decode is actually reachable.
            let _ = decode(64, 64, &bytes);
        }
    }

    #[test]
    fn fuzzing_with_structured_garbage_never_panics() {
        // Random varints, which are far more likely to reach deep code paths than
        // uniform random bytes.
        let mut rng = substream(4242, "rle-fuzz-varints");
        for _ in 0..5_000 {
            let mut bytes = Vec::new();
            for _ in 0..rng.gen_range(0..12) {
                push_varint(&mut bytes, rng.gen_range(0..8192u64));
            }
            let _ = decode(64, 64, &bytes);
        }
    }

    #[test]
    fn varints_round_trip() {
        for v in [0u64, 1, 127, 128, 255, 300, 16_383, 16_384, u32::MAX as u64] {
            let mut bytes = Vec::new();
            push_varint(&mut bytes, v);
            let mut at = 0;
            assert_eq!(read_varint(&bytes, &mut at), Ok(v), "value {v}");
            assert_eq!(at, bytes.len());
        }
    }
}
