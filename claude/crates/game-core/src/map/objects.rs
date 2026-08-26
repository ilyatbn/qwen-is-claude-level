//! The object mask table, embedded at compile time.
//!
//! `scripts/build-object-masks.mjs` thresholds each sprite pack PNG into a 1-bit
//! mask and writes them end to end into `assets/objects/masks.bin`. This module
//! embeds that file with `include_bytes!`, so the pure crate reads its own art
//! table with no `std::fs` and no new dependency (`CLAUDE.md`,
//! `docs/73-amendments-v5.md` §D2).
//!
//! The blob carries a fixed-width index in front of the bits. `manifest.json`
//! repeats those extents for the client; nothing here reads the JSON, and the
//! suite asserts the two agree rather than assuming it.

/// The bytes `O B J M`, read little-endian.
const MAGIC: u32 = 0x4d4a_424f;
const VERSION: u32 = 1;
const HEADER_BYTES: usize = 12;
const RECORD_BYTES: usize = 20;

/// The table, as written by `scripts/build-object-masks.mjs`.
static BLOB: &[u8] = include_bytes!("../../../../assets/objects/masks.bin");

fn u16_at(bytes: &[u8], at: usize) -> u16 {
    u16::from_le_bytes([bytes[at], bytes[at + 1]])
}

fn u32_at(bytes: &[u8], at: usize) -> u32 {
    u32::from_le_bytes([bytes[at], bytes[at + 1], bytes[at + 2], bytes[at + 3]])
}

/// One object's silhouette: `w * h` bits, row-major, MSB first, no row padding.
#[derive(Copy, Clone, Debug)]
pub struct ObjectMask {
    pub id: u32,
    pub w: u32,
    pub h: u32,
    /// Where the object meets the ground: bottom centre, in mask pixels.
    pub anchor_x: u32,
    pub anchor_y: u32,
    bits: &'static [u8],
}

impl ObjectMask {
    /// Solid at `(x, y)`? Out of bounds is empty, never a panic.
    #[inline]
    pub fn solid(&self, x: u32, y: u32) -> bool {
        if x >= self.w || y >= self.h {
            return false;
        }
        let i = (y * self.w + x) as usize;
        self.bits[i >> 3] & (0x80 >> (i & 7)) != 0
    }

    /// Solid at `(x, y)` with the silhouette mirrored left to right.
    ///
    /// Exact on a bitmask and free, which is why §D4 stores flip as a flag rather
    /// than baking a second mask: 40 rocks are 80 silhouettes at no cost.
    #[inline]
    pub fn solid_flipped(&self, x: u32, y: u32, flip: bool) -> bool {
        if flip {
            if x >= self.w {
                return false;
            }
            self.solid(self.w - 1 - x, y)
        } else {
            self.solid(x, y)
        }
    }

    pub fn bits(&self) -> &'static [u8] {
        self.bits
    }

    /// How many pixels this object stamps. `OBJECT_PIXEL_BUDGET` is measured in
    /// these, because a ruin is worth twenty bushes (§D5).
    pub fn solid_px(&self) -> u32 {
        self.bits.iter().map(|b| b.count_ones()).sum()
    }
}

fn valid_header() -> bool {
    BLOB.len() >= HEADER_BYTES && u32_at(BLOB, 0) == MAGIC && u32_at(BLOB, 4) == VERSION
}

/// How many objects the table holds.
pub fn count() -> usize {
    if !valid_header() {
        return 0;
    }
    u32_at(BLOB, 8) as usize
}

/// The mask at `id`, which is also its position in the table (§B16).
pub fn mask(id: usize) -> Option<ObjectMask> {
    if id >= count() {
        return None;
    }
    let at = HEADER_BYTES + id * RECORD_BYTES;
    let offset = u32_at(BLOB, at + 12) as usize;
    let len = u32_at(BLOB, at + 16) as usize;
    if offset.checked_add(len)? > BLOB.len() {
        return None;
    }
    Some(ObjectMask {
        id: u32_at(BLOB, at),
        w: u16_at(BLOB, at + 4) as u32,
        h: u16_at(BLOB, at + 6) as u32,
        anchor_x: u16_at(BLOB, at + 8) as u32,
        anchor_y: u16_at(BLOB, at + 10) as u32,
        bits: &BLOB[offset..offset + len],
    })
}

/// Every mask, in id order.
pub fn all() -> impl Iterator<Item = ObjectMask> {
    (0..count()).filter_map(mask)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_table_is_not_empty() {
        // The control for every assertion below: they all pass over an empty
        // table, and an empty table is exactly what a missing build produces.
        assert!(count() > 0, "masks.bin holds no objects");
    }

    #[test]
    fn every_record_is_addressable_and_its_length_matches_its_extent() {
        for id in 0..count() {
            let m = mask(id).unwrap_or_else(|| panic!("id {id} does not resolve"));
            assert_eq!(m.id as usize, id, "id {id} is stored as {}", m.id);
            assert!(m.w > 0 && m.h > 0, "id {id} is {}x{}", m.w, m.h);
            let expected = (m.w as usize * m.h as usize).div_ceil(8);
            assert_eq!(
                m.bits().len(),
                expected,
                "id {id} is {}x{} but holds {} bytes",
                m.w,
                m.h,
                m.bits().len()
            );
        }
    }

    #[test]
    fn every_mask_stamps_something() {
        let empty: Vec<u32> = all().filter(|m| m.solid_px() == 0).map(|m| m.id).collect();
        assert!(empty.is_empty(), "these masks are blank: {empty:?}");
    }

    #[test]
    fn ids_run_out_and_stop() {
        assert!(mask(count()).is_none(), "an id past the end resolved");
    }

    #[test]
    fn out_of_bounds_reads_are_empty_not_panics() {
        let m = mask(0).expect("at least one object");
        assert!(!m.solid(m.w, 0));
        assert!(!m.solid(0, m.h));
    }

    #[test]
    fn flipping_mirrors_the_silhouette() {
        // The control: a mask that is not left-right symmetric, so "flipped equals
        // unflipped" cannot pass by accident.
        let asymmetric = all()
            .find(|m| (0..m.w).any(|x| (0..m.h).any(|y| m.solid(x, y) != m.solid(m.w - 1 - x, y))))
            .expect("no asymmetric object in the table");
        for y in 0..asymmetric.h {
            for x in 0..asymmetric.w {
                assert_eq!(
                    asymmetric.solid_flipped(x, y, true),
                    asymmetric.solid(asymmetric.w - 1 - x, y),
                    "({x},{y}) of id {}",
                    asymmetric.id
                );
            }
        }
    }
}
