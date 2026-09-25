//! T23.05 (R4): the terrain fields the M23 terrain shader reads, derived from the mask.
//!
//! **Render-only.** Nothing in `game-core` reads this module and nothing here writes
//! the mask: it is a pure function of the mask (plus a round-start snapshot of it),
//! kept in Rust only because CLAUDE.md forbids map logic in TypeScript (R4).
//!
//! One world-sized RGBA8 buffer, the encoding of `mockup-src/kit.js::fieldTextures`
//! byte for byte, so the mockup's shader constants port unchanged:
//!
//! | ch | meaning | encoding |
//! |---|---|---|
//! | R | `dIn`, distance from a solid px to the nearest air px | `min(255, f32(√d²)·4)`, truncated |
//! | G | `dOut`, distance from an air px to the nearest solid px | same |
//! | B | `back`, carved-out rock (cave wall) | 255 / 0 |
//! | A | `relief`, boulders and strata ledges (`world.js::derive`) | `f32(relief)·255`, truncated |
//!
//! ×4 in 8 bits saturates at 63.75 px; that saturation is what makes the dirty
//! rectangle exact (see [`RenderFields::dirty`]).
//!
//! ## `back` — the cave wall (R17)
//!
//! `back = was rock ∧ air now`. The mockup's `back` is exactly the pixels its `buildMask`
//! spec carved out of a landform — generated tunnels and craters alike — and R17 rules
//! the game does the same: "was rock" is the generator's landform **or** the mask at
//! round start. It is an input ([`RenderFields::full_with_wall`]) so either source plugs
//! in: [`RenderFields::full`] feeds the round-start mask alone (every carve made in
//! play), and T23.05B supplies the generator's landform, which the client does not have
//! yet. `chunkBake-math.ts::BackdropMask` (`pristine solid ∪ enclosure-classified air`,
//! a heuristic with 2.5–16 % open-sky false positives, off via `CAVE_BACKDROP`) differs
//! from the mockup and is not used.

use game_core::map::mask::Mask;

/// Distances are stored ×4 (`kit.js::fieldTextures`).
const DIST_SCALE: f64 = 4.0;
/// Squared-distance cap. Anything ≥ 65 px encodes to 255 exactly as the uncapped
/// value would (65·4 > 255), and a capped column value can only raise a result that
/// was ≥ 65 px anyway, so capping is invisible in the bytes and lets the scratch be
/// `u16`. Proven against brute force in the tests, not just argued.
const CAP_SQ: u32 = 65 * 65;
/// The written rectangle is the dirty rectangle grown by this (the saturation distance).
pub const WRITE_MARGIN: u32 = 64;
/// The read rectangle is the dirty rectangle grown by this: the write margin plus one
/// saturation distance, so every px written sees every px within 64 of it.
pub const READ_MARGIN: u32 = 128;
/// Relief reads only `solid` and `dIn > BOULDER_MIN_DEPTH` at its own px, so a carve
/// can change it only where a changed px is within that depth: the dirty rectangle
/// grown by it, exactly (planted `- 1`, `an_incremental_update_equals_a_full_pass`
/// goes red on 10 of 20 seeds). Relief was ~70 % of a crater update, hence the margin.
pub const RELIEF_MARGIN: u32 = BOULDER_MIN_DEPTH as u32;
/// `world.js::THEMES.dusk.boulders` — F1/F5's theme (`variant_F1.js`, R5: one world).
const BOULDER_MIN_ID: f64 = 0.8;
/// `world.js::derive`: boulders only deeper than this into the rock.
const BOULDER_MIN_DEPTH: f64 = 10.0;

/// Anything with a solid/air answer per pixel. The game's [`Mask`] and the tests' grids.
pub trait Solid {
    fn dims(&self) -> (u32, u32);
    fn solid(&self, x: u32, y: u32) -> bool;
}

impl Solid for Mask {
    fn dims(&self) -> (u32, u32) {
        (self.w, self.h)
    }
    #[inline]
    fn solid(&self, x: u32, y: u32) -> bool {
        self.get(x as i32, y as i32)
    }
}

/// A plain bit grid of any size (the mockup's 1280×720 is not a `CHUNK_SIZE` multiple).
#[derive(Clone, PartialEq, Eq, Debug)]
pub struct BitGrid {
    w: u32,
    h: u32,
    bits: Vec<u64>,
}

impl BitGrid {
    pub fn new(w: u32, h: u32) -> Self {
        BitGrid {
            w,
            h,
            bits: vec![0; (w as usize * h as usize).div_ceil(64)],
        }
    }
    pub fn from_solid(src: &impl Solid) -> Self {
        let (w, h) = src.dims();
        let mut g = BitGrid::new(w, h);
        for y in 0..h {
            for x in 0..w {
                g.put(x, y, src.solid(x, y));
            }
        }
        g
    }
    /// `self |= other`; same size.
    pub fn union_with(&mut self, other: &BitGrid) {
        for (a, b) in self.bits.iter_mut().zip(&other.bits) {
            *a |= *b;
        }
    }
    pub fn put(&mut self, x: u32, y: u32, on: bool) {
        let i = y as usize * self.w as usize + x as usize;
        if on {
            self.bits[i >> 6] |= 1 << (i & 63);
        } else {
            self.bits[i >> 6] &= !(1 << (i & 63));
        }
    }
}

impl Solid for BitGrid {
    fn dims(&self) -> (u32, u32) {
        (self.w, self.h)
    }
    #[inline]
    fn solid(&self, x: u32, y: u32) -> bool {
        let i = y as usize * self.w as usize + x as usize;
        (self.bits[i >> 6] >> (i & 63)) & 1 != 0
    }
}

/// A rectangle in world px. `w == 0 || h == 0` is empty.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub struct Rect {
    pub x: u32,
    pub y: u32,
    pub w: u32,
    pub h: u32,
}

impl Rect {
    /// `(x, y, w, h)` in signed world px grown by `m` on every side, clipped to the world.
    fn grown(x: i32, y: i32, w: i32, h: i32, m: u32, ww: u32, wh: u32) -> Rect {
        let m = m as i64;
        let x0 = (x as i64 - m).clamp(0, ww as i64);
        let y0 = (y as i64 - m).clamp(0, wh as i64);
        let x1 = (x as i64 + w.max(0) as i64 + m).clamp(0, ww as i64);
        let y1 = (y as i64 + h.max(0) as i64 + m).clamp(0, wh as i64);
        if w <= 0 || h <= 0 || x1 <= x0 || y1 <= y0 {
            return Rect {
                x: 0,
                y: 0,
                w: 0,
                h: 0,
            };
        }
        Rect {
            x: x0 as u32,
            y: y0 as u32,
            w: (x1 - x0) as u32,
            h: (y1 - y0) as u32,
        }
    }
    fn intersect(self, o: Rect) -> Rect {
        let x0 = self.x.max(o.x);
        let y0 = self.y.max(o.y);
        let x1 = (self.x + self.w).min(o.x + o.w);
        let y1 = (self.y + self.h).min(o.y + o.h);
        if x1 <= x0 || y1 <= y0 {
            return Rect {
                x: 0,
                y: 0,
                w: 0,
                h: 0,
            };
        }
        Rect {
            x: x0,
            y: y0,
            w: x1 - x0,
            h: y1 - y0,
        }
    }
    #[inline]
    fn contains(self, x: u32, y: u32) -> bool {
        x >= self.x && y >= self.y && x < self.x + self.w && y < self.y + self.h
    }
    pub fn to_vec(self) -> Vec<u32> {
        vec![self.x, self.y, self.w, self.h]
    }
}

/// The world field buffer and the round-start snapshot `back` is measured against.
#[derive(Default)]
pub struct RenderFields {
    w: u32,
    h: u32,
    rgba: Vec<u8>,
    wall: Option<BitGrid>,
}

impl RenderFields {
    /// The whole world, with the mask as it is now as the "was rock" mask. **Call it at
    /// round start**, when the mask is pristine — the moment `terrain.ts::buildAll`
    /// snapshots today. Craters carved later then show the wall.
    pub fn full(&mut self, mask: &impl Solid) -> Rect {
        self.wall = Some(BitGrid::from_solid(mask));
        self.full_against_snapshot(mask)
    }

    /// The whole world against an explicit "was rock" mask (R17): the round-start mask
    /// OR'd with the generator's landform (T23.05B), or a scene's own `back` ∪ solid (the
    /// look-lab). A `wall` of the wrong size is ignored for the round-start mask.
    pub fn full_with_wall(&mut self, mask: &impl Solid, wall: BitGrid) -> Rect {
        if wall.dims() != mask.dims() {
            return self.full(mask);
        }
        let mut wall = wall;
        wall.union_with(&BitGrid::from_solid(mask));
        self.wall = Some(wall);
        self.full_against_snapshot(mask)
    }

    fn full_against_snapshot(&mut self, mask: &impl Solid) -> Rect {
        let (w, h) = mask.dims();
        self.w = w;
        self.h = h;
        self.rgba.clear();
        self.rgba.resize(w as usize * h as usize * 4, 0);
        let all = Rect { x: 0, y: 0, w, h };
        self.compute(mask, all, all, all);
        all
    }

    /// After a carve with bounds `(x, y, w, h)`: rewrite the rectangle grown by
    /// [`WRITE_MARGIN`], reading it grown by [`READ_MARGIN`]. Byte-identical to
    /// [`full`](Self::full) because nothing outside `dirty + 64` can change (every
    /// channel saturates or is local by 64 px) and every px written sees all px
    /// within 64 of it. Returns the rectangle written. Falls back to a full pass if
    /// the map changed size or there is no snapshot yet.
    pub fn dirty(&mut self, mask: &impl Solid, x: i32, y: i32, w: i32, h: i32) -> Rect {
        let (mw, mh) = mask.dims();
        if self.wall.as_ref().map(|p| p.dims()) != Some((mw, mh)) || (self.w, self.h) != (mw, mh) {
            return self.full(mask);
        }
        self.dirty_reading(mask, (x, y, w, h), READ_MARGIN)
    }

    /// The live body of [`dirty`](Self::dirty), with the read margin a parameter only
    /// so the tests can shrink it and watch incremental-equals-full go red.
    fn dirty_reading(
        &mut self,
        mask: &impl Solid,
        d: (i32, i32, i32, i32),
        read_margin: u32,
    ) -> Rect {
        let write = Rect::grown(d.0, d.1, d.2, d.3, WRITE_MARGIN, self.w, self.h);
        let read = Rect::grown(d.0, d.1, d.2, d.3, read_margin, self.w, self.h);
        let write = write.intersect(read);
        if write.w == 0 {
            return write;
        }
        let relief =
            Rect::grown(d.0, d.1, d.2, d.3, RELIEF_MARGIN, self.w, self.h).intersect(write);
        self.compute(mask, read, write, relief);
        write
    }

    pub fn rgba(&self) -> &[u8] {
        &self.rgba
    }

    /// Distances and `back` over `write` (reading `read`); relief over `relief` ⊆ `write`.
    fn compute(&mut self, mask: &impl Solid, read: Rect, write: Rect, relief: Rect) {
        let ww = self.w as usize;
        let rgba = &mut self.rgba;
        // R + relief: distance from solid to air.
        distance_pass(mask, true, read, write, |x, y, d| {
            let o = (y as usize * ww + x as usize) * 4;
            rgba[o] = encode_dist(d);
            if relief.contains(x, y) {
                let rel = if mask.solid(x, y) {
                    relief_at(x, y, d)
                } else {
                    0.0
                };
                rgba[o + 3] = (rel as f64 * 255.0) as u8;
            }
        });
        // G: distance from air to solid.
        distance_pass(mask, false, read, write, |x, y, d| {
            rgba[(y as usize * ww + x as usize) * 4 + 1] = encode_dist(d);
        });
        // B: carved-out rock (module docs).
        if let Some(p) = &self.wall {
            for y in write.y..write.y + write.h {
                for x in write.x..write.x + write.w {
                    let back = p.solid(x, y) && !mask.solid(x, y);
                    rgba[(y as usize * ww + x as usize) * 4 + 2] = if back { 255 } else { 0 };
                }
            }
        }
    }
}

/// `kit.js`: `Math.min(255, dIn[i] * 4)` stored to a `Uint8Array` (truncation).
#[inline]
fn encode_dist(d: f32) -> u8 {
    (d as f64 * DIST_SCALE).min(255.0) as u8
}

/// Exact EDT (`world.js::edt`, Felzenszwalb) over `read`, reporting each px of `write`:
/// for px where `solid == want`, the distance to the nearest px in `read` where it is
/// not; 0 elsewhere. Squared distances are capped at [`CAP_SQ`] (see there).
fn distance_pass(
    mask: &impl Solid,
    want: bool,
    read: Rect,
    write: Rect,
    mut emit: impl FnMut(u32, u32, f32),
) {
    let (rw, rh) = (read.w as usize, read.h as usize);
    let mut g = vec![0u16; rw * rh];
    // Columns: 1-D distance to the nearest "other" px in the column — what the
    // column pass of `edt1d` computes when f ∈ {0, ∞}.
    for cx in 0..rw {
        let x = read.x + cx as u32;
        let mut last: Option<usize> = None;
        for cy in 0..rh {
            let inside = mask.solid(x, read.y + cy as u32) == want;
            let v = if !inside {
                last = Some(cy);
                0
            } else {
                last.map_or(CAP_SQ, |l| ((cy - l) as u32).pow(2).min(CAP_SQ))
            };
            g[cy * rw + cx] = v as u16;
        }
        let mut next: Option<usize> = None;
        for cy in (0..rh).rev() {
            let i = cy * rw + cx;
            if g[i] == 0 {
                next = Some(cy);
            } else if let Some(n) = next {
                g[i] = g[i].min(((n - cy) as u32).pow(2).min(CAP_SQ) as u16);
            }
        }
    }
    // Rows: `world.js::edt1d`, ported operation for operation.
    let mut f = vec![0f64; rw];
    let mut d = vec![0f64; rw];
    let mut v = vec![0usize; rw];
    let mut z = vec![0f64; rw + 1];
    for y in write.y..write.y + write.h {
        let cy = (y - read.y) as usize;
        for (k, fk) in f.iter_mut().enumerate() {
            *fk = g[cy * rw + k] as f64;
        }
        edt1d(&f, &mut d, &mut v, &mut z);
        for x in write.x..write.x + write.w {
            let sq = d[(x - read.x) as usize].min(CAP_SQ as f64);
            // `world.js`: `Math.sqrt` into a `Float32Array`.
            emit(x, y, sq.sqrt() as f32);
        }
    }
}

/// `world.js::edt1d`, operation for operation.
fn edt1d(f: &[f64], d: &mut [f64], v: &mut [usize], z: &mut [f64]) {
    let n = f.len();
    let sq = |q: usize| (q * q) as f64;
    let mut k = 0usize;
    v[0] = 0;
    z[0] = -1e20;
    z[1] = 1e20;
    for q in 1..n {
        let meet =
            |vk: usize| ((f[q] + sq(q)) - (f[vk] + sq(vk))) / (2.0 * q as f64 - 2.0 * vk as f64);
        let mut s = meet(v[k]);
        while s <= z[k] {
            k -= 1;
            s = meet(v[k]);
        }
        k += 1;
        v[k] = q;
        z[k] = s;
        z[k + 1] = 1e20;
    }
    k = 0;
    for (q, dq) in d.iter_mut().enumerate().take(n) {
        while z[k + 1] < q as f64 {
            k += 1;
        }
        *dq = (q as f64 - v[k] as f64).powi(2) + f[v[k]];
    }
}

// ---- relief: `world.js::derive`, bit-exact (fixture test) ----------------------

/// `world.js::hash`: `(x*374761393 + y*668265263 + s*144665) | 0`, then `Math.imul`.
/// The sum is exact in f64 for every argument this module passes (< 2^53), so the
/// i64 sum then wrap is the same 32 bits `| 0` keeps.
#[inline]
fn hash(x: i64, y: i64, s: i64) -> f64 {
    let h = (x * 374_761_393 + y * 668_265_263 + s * 144_665) as i32 as u32;
    let h = (h ^ (h >> 13)).wrapping_mul(1_274_126_177);
    (h ^ (h >> 16)) as f64 / 4_294_967_296.0
}

fn vnoise(x: f64, y: f64, s: i64) -> f64 {
    let (xi, yi) = (x.floor(), y.floor());
    let (xf, yf) = (x - xi, y - yi);
    let u = xf * xf * (3.0 - 2.0 * xf);
    let v = yf * yf * (3.0 - 2.0 * yf);
    let (xi, yi) = (xi as i64, yi as i64);
    let a = hash(xi, yi, s);
    let b = hash(xi + 1, yi, s);
    let c = hash(xi, yi + 1, s);
    let d = hash(xi + 1, yi + 1, s);
    a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v
}

fn fbm(x: f64, y: f64, oct: i64, s: i64) -> f64 {
    let (mut t, mut a, mut f, mut n) = (0.0, 0.5, 1.0, 0.0);
    for i in 0..oct {
        t += a * vnoise(x * f, y * f, s + i * 17);
        n += a;
        a *= 0.5;
        f *= 2.03;
    }
    t / n
}

/// `world.js::cell2`: Worley F1, F2 and the F1 site's id. `(p - x) ** 2` is `p*p`
/// in V8 bit for bit (checked over 5 M random doubles; `Math.pow(b, 3)` is not
/// `b*b*b`, which is why `relief_at` calls `powf`).
fn cell2(x: f64, y: f64, s: i64) -> (f64, f64, f64) {
    let (xi, yi) = (x.floor() as i64, y.floor() as i64);
    let (mut f1, mut f2, mut id) = (9.0f64, 9.0f64, 0.0f64);
    for j in -1..=1 {
        for i in -1..=1 {
            let (cx, cy) = (xi + i, yi + j);
            let px = cx as f64 + hash(cx, cy, s);
            let py = cy as f64 + hash(cx, cy, s + 9);
            let d = ((px - x) * (px - x) + (py - y) * (py - y)).sqrt();
            if d < f1 {
                f2 = f1;
                f1 = d;
                id = hash(cx, cy, s + 5);
            } else if d < f2 {
                f2 = d;
            }
        }
    }
    (f1, f2, id)
}

/// `world.js::derive`'s `relief[i]` for a solid px at depth `d_in`.
fn relief_at(x: u32, y: u32, d_in: f32) -> f32 {
    let (x, y) = (x as f64, y as f64);
    let warp = fbm(x * 0.02, y * 0.02, 3, 11);
    let band = (y * 0.045 + warp * 3.2 + fbm(x * 0.004, 0.0, 2, 12) * 4.0) % 4.0;
    let bt = band - band.floor();
    let grain = fbm(x * 0.25, y * 0.25, 3, 13);
    let (b1, b2, bid) = cell2(x * 0.022 + warp * 0.6, y * 0.03 + warp * 0.4, 21);
    let mut rel = 0.0f64;
    if bid > BOULDER_MIN_ID && d_in as f64 > BOULDER_MIN_DEPTH {
        rel = ((b2 - b1) * 2.2).min(1.0).sqrt();
    }
    rel = rel.max(0.25 * bt.powf(3.0) + 0.2 * grain);
    rel as f32
}

// ---- the WASM boundary -------------------------------------------------------------
//
// Here rather than in `lib.rs` so the M23 renderer's surface stays in one file. The
// buffer is owned by this `GameCore` and read by JS through a pointer, exactly as the
// mask is (`lib.rs` module docs: the view detaches on memory growth, re-acquire it
// when `view.buffer !== memory.buffer`). **No production caller yet**: T23.07's
// terrain renderer is the first (it uploads the returned rect with `texSubImage2D`).

use crate::GameCore;
use wasm_bindgen::prelude::wasm_bindgen;

#[wasm_bindgen]
impl GameCore {
    /// Every field for the whole world, and the `back` snapshot. Call at round start.
    /// Returns the rect written, `[x, y, w, h]`.
    pub fn render_fields_full(&mut self) -> Vec<u32> {
        self.render_fields.full(&self.map.mask).to_vec()
    }

    /// R17: like `render_fields_full`, with an extra "was rock" mask — one byte per px,
    /// row-major, nonzero = rock (the generator's landform, T23.05B; or a look-lab scene's
    /// `back`). OR'd with the mask as it is now. A buffer of the wrong length is ignored.
    pub fn render_fields_full_with_wall(&mut self, wall: &[u8]) -> Vec<u32> {
        let (w, h) = (self.map.mask.w, self.map.mask.h);
        if wall.len() != w as usize * h as usize {
            return self.render_fields_full();
        }
        let mut g = BitGrid::new(w, h);
        for (i, &b) in wall.iter().enumerate() {
            if b != 0 {
                g.put(i as u32 % w, i as u32 / w, true);
            }
        }
        self.render_fields
            .full_with_wall(&self.map.mask, g)
            .to_vec()
    }

    /// After a carve with bounds `(x, y, w, h)` (world px, may overhang the map).
    /// Returns the rect written, `[x, y, w, h]` — upload exactly that.
    pub fn render_fields_dirty(&mut self, x: i32, y: i32, w: i32, h: i32) -> Vec<u32> {
        self.render_fields
            .dirty(&self.map.mask, x, y, w, h)
            .to_vec()
    }

    /// Address of the RGBA8 field buffer, `width * height * 4` bytes, row-major.
    pub fn render_fields_ptr(&self) -> *const u8 {
        self.render_fields.rgba().as_ptr()
    }

    pub fn render_fields_len(&self) -> usize {
        self.render_fields.rgba().len()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use game_core::constants::MapScale;
    use game_core::map::generate;
    use game_core::rng::{chance, range_i32, range_u32, substream};

    fn fnv32(bytes: impl Iterator<Item = u8>) -> u32 {
        let mut h = 0x811c_9dc5u32;
        for b in bytes {
            h ^= b as u32;
            h = h.wrapping_mul(0x0100_0193);
        }
        h
    }

    fn channel(f: &RenderFields, c: usize) -> Vec<u8> {
        f.rgba().chunks_exact(4).map(|p| p[c]).collect()
    }

    fn circle(g: &mut BitGrid, cx: i32, cy: i32, r: i32, on: bool) {
        for y in (cy - r).max(0)..(cy + r + 1).min(g.h as i32) {
            for x in (cx - r).max(0)..(cx + r + 1).min(g.w as i32) {
                if (x - cx).pow(2) + (y - cy).pow(2) <= r * r {
                    g.put(x as u32, y as u32, on);
                }
            }
        }
    }

    /// Blobby terrain with holes: some px deep in rock and far out in air (> 64 px),
    /// so both saturation and exact distances are exercised.
    fn random_grid(seed: u64, w: u32, h: u32) -> BitGrid {
        let mut rng = substream(seed, "render_fields");
        let mut g = BitGrid::new(w, h);
        for y in h / 2..h {
            for x in 0..w {
                g.put(x, y, true);
            }
        }
        for _ in 0..range_u32(&mut rng, 3, 12) {
            let x = range_i32(&mut rng, 0, w as i32 - 1);
            let y = range_i32(&mut rng, 0, h as i32 - 1);
            let r = range_i32(&mut rng, 3, 70);
            let on = chance(&mut rng, 0.5);
            circle(&mut g, x, y, r, on);
        }
        for _ in 0..range_u32(&mut rng, 0, 200) {
            let (x, y) = (range_u32(&mut rng, 0, w - 1), range_u32(&mut rng, 0, h - 1));
            let on = chance(&mut rng, 0.5);
            g.put(x, y, on);
        }
        g
    }

    /// The oracle: nearest opposite px by exhaustive search, encoded as `kit.js` does.
    fn brute(g: &BitGrid, want: bool) -> Vec<u8> {
        let (w, h) = g.dims();
        let others: Vec<(i64, i64)> = (0..h)
            .flat_map(|y| (0..w).map(move |x| (x, y)))
            .filter(|&(x, y)| g.solid(x, y) != want)
            .map(|(x, y)| (x as i64, y as i64))
            .collect();
        let mut out = Vec::with_capacity((w * h) as usize);
        for y in 0..h as i64 {
            for x in 0..w as i64 {
                if g.solid(x as u32, y as u32) != want {
                    out.push(0);
                    continue;
                }
                let best = others
                    .iter()
                    .map(|&(ox, oy)| (ox - x).pow(2) + (oy - y).pow(2))
                    .min();
                let d = best.map_or(1e5f32, |b| (b as f64).sqrt() as f32);
                out.push((d as f64 * 4.0).min(255.0) as u8);
            }
        }
        out
    }

    #[test]
    fn distances_equal_a_brute_force_nearest_pixel_search() {
        let mut saturated = 0usize;
        let mut exact = 0usize;
        let mut grids: Vec<(u64, BitGrid)> = [
            (1u64, 61u32, 47u32),
            (2, 150, 90),
            (3, 257, 33),
            (4, 40, 160),
            (5, 128, 128),
        ]
        .into_iter()
        .map(|(seed, w, h)| (seed, random_grid(seed, w, h)))
        .collect();
        // Far from anything: a lone rock in open air (dOut saturates) and a lone
        // hole in solid rock (dIn saturates), neither centred.
        let mut rock = BitGrid::new(190, 150);
        circle(&mut rock, 40, 50, 9, true);
        let mut hole = BitGrid::from_solid(&rock);
        for y in 0..150 {
            for x in 0..190 {
                hole.put(x, y, !rock.solid(x, y));
            }
        }
        grids.push((6, rock));
        grids.push((7, hole));
        for (seed, g) in grids {
            let (w, h) = g.dims();
            let mut f = RenderFields::default();
            f.full(&g);
            let (din, dout) = (channel(&f, 0), channel(&f, 1));
            assert_eq!(din, brute(&g, true), "dIn, seed {seed} {w}x{h}");
            assert_eq!(dout, brute(&g, false), "dOut, seed {seed} {w}x{h}");
            saturated += din.iter().chain(&dout).filter(|&&b| b == 255).count();
            exact += din
                .iter()
                .chain(&dout)
                .filter(|&&b| b > 0 && b < 255)
                .count();
        }
        // Controls: the oracle agreement covers both regimes, not just one.
        assert!(
            saturated > 1000 && exact > 10_000,
            "saturated {saturated}, exact {exact}"
        );
    }

    /// Carve random circles into random terrain, update per dirty rect, compare with a
    /// from-scratch full pass. `read_margin` is the live parameter of `dirty`.
    fn incremental_mismatches(read_margin: u32) -> (usize, usize) {
        let (mut bad_seeds, mut changed, mut written) = (0, 0, 0u64);
        for seed in 0..20u64 {
            let mut g = random_grid(100 + seed, 384, 256);
            let mut f = RenderFields::default();
            f.full(&g);
            let wall = f.wall.clone();
            let mut rng = substream(seed, "carves");
            for _ in 0..4 {
                let cx = range_i32(&mut rng, -20, 404);
                let cy = range_i32(&mut rng, -20, 276);
                let r = range_i32(&mut rng, 4, 70);
                circle(&mut g, cx, cy, r, false);
                let wrote =
                    f.dirty_reading(&g, (cx - r, cy - r, 2 * r + 1, 2 * r + 1), read_margin);
                written += wrote.w as u64 * wrote.h as u64;
            }
            let mut fresh = RenderFields {
                wall,
                ..Default::default()
            };
            fresh.full_against_snapshot(&g);
            changed += channel(&fresh, 2).iter().filter(|&&b| b == 255).count();
            if f.rgba() != fresh.rgba() {
                bad_seeds += 1;
            }
        }
        // Control: the updates were partial — a `dirty` that quietly did a full pass
        // would pass the equality and this is what would catch it.
        assert!(written < 20 * 4 * 384 * 256 / 2, "written {written} px");
        (bad_seeds, changed)
    }

    #[test]
    fn an_incremental_update_equals_a_full_pass() {
        let (bad, carved) = incremental_mismatches(READ_MARGIN);
        assert_eq!(bad, 0, "seeds where incremental != full");
        // Control: the carves really removed rock (the `back` channel saw them).
        assert!(carved > 1000, "carved px {carved}");
    }

    /// The falsification, kept as a test: the same code reading +32 px, and reading
    /// only 32 px past the written rectangle, both go red.
    #[test]
    fn a_shrunk_read_margin_breaks_incremental_equals_full() {
        assert!(
            incremental_mismatches(32).0 > 0,
            "+32 px read margin still matched"
        );
        assert!(
            incremental_mismatches(WRITE_MARGIN + 32).0 > 0,
            "+96 px read margin still matched"
        );
    }

    /// The WASM entry point for R17's input: a "was rock" byte mask turns air into wall
    /// there and only there; without it the same px is sky (the control).
    #[test]
    fn the_wall_input_reaches_the_back_channel_through_game_core() {
        let mut core = GameCore::new();
        let (w, h) = (core.width(), core.height());
        let air: Vec<usize> = (0..(w * h) as usize)
            .filter(|&i| !core.solid_at(i as i32 % w as i32, i as i32 / w as i32))
            .step_by(997)
            .collect();
        assert!(air.len() > 100);
        let mut wall = vec![0u8; (w * h) as usize];
        for &i in &air {
            wall[i] = 1;
        }
        core.render_fields_full();
        let b = |core: &GameCore, i: usize| core.render_fields.rgba()[i * 4 + 2];
        assert!(
            air.iter().all(|&i| b(&core, i) == 0),
            "no wall without the input"
        );
        core.render_fields_full_with_wall(&wall);
        assert!(
            air.iter().all(|&i| b(&core, i) == 255),
            "the input's px are wall"
        );
        let walled = core
            .render_fields
            .rgba()
            .chunks_exact(4)
            .filter(|p| p[2] == 255)
            .count();
        assert_eq!(walled, air.len(), "and nothing else is");
    }

    fn unrle(runs: &[u64], w: u32, h: u32) -> BitGrid {
        let mut g = BitGrid::new(w, h);
        let (mut i, mut on) = (0u64, false);
        for &n in runs {
            for k in i..i + n {
                g.put((k % w as u64) as u32, (k / w as u64) as u32, on);
            }
            i += n;
            on = !on;
        }
        assert_eq!(i, w as u64 * h as u64);
        g
    }

    /// `render_fields.fixture.json` was dumped from the mockup itself: copy
    /// `tasks/M23/reference/mockup-src/{world,maps}.js` to a scratch dir as `.mjs`, then
    /// `derive(buildMask(ARENA_E), 'dusk')` and `kit.js::fieldTextures`'s encoding,
    /// FNV-1a-32 of each channel, of the `relief` Float32Array's bytes, and the f32 bits
    /// of every 1009th px that is solid. The mask and back mask travel as RLE, so this
    /// test does not depend on porting `buildMask` (whose `atan2` is not bit-portable).
    #[test]
    fn every_channel_matches_the_mockup_for_arena_e() {
        let fx: serde_json::Value =
            serde_json::from_str(include_str!("render_fields.fixture.json")).expect("fixture");
        let (w, h) = (
            fx["w"].as_u64().unwrap() as u32,
            fx["h"].as_u64().unwrap() as u32,
        );
        let runs = |k: &str| -> Vec<u64> {
            fx[k]
                .as_array()
                .unwrap()
                .iter()
                .map(|v| v.as_u64().unwrap())
                .collect()
        };
        let solid = unrle(&runs("solid_rle"), w, h);
        let back = unrle(&runs("back_rle"), w, h);
        // The mockup's `back` is carved landform, so it is the "was rock" input (R17).
        let mut f = RenderFields::default();
        f.full_with_wall(&solid, back);
        // Control (R17): the generated caves are wall only because the landform was fed.
        let mut round_start_only = RenderFields::default();
        round_start_only.full(&solid);
        assert!(channel(&round_start_only, 2).iter().all(|&b| b == 0));
        assert!(channel(&f, 2).iter().filter(|&&b| b == 255).count() > 1000);

        let mut relief = Vec::new();
        for y in 0..h {
            for x in 0..w {
                let bits = if solid.solid(x, y) {
                    relief_at(x, y, exact_din(&solid, x, y)).to_bits()
                } else {
                    0
                };
                relief.push(bits);
            }
        }
        for s in fx["relief_samples"].as_array().unwrap() {
            let (i, want) = (
                s[0].as_u64().unwrap() as usize,
                s[1].as_u64().unwrap() as u32,
            );
            assert_eq!(
                relief[i],
                want,
                "relief f32 at px {i}: {} vs {}",
                f32::from_bits(relief[i]),
                f32::from_bits(want)
            );
        }
        let hashes = &fx["fnv32"];
        let got = |c| fnv32(channel(&f, c).into_iter()) as u64;
        assert_eq!(
            fnv32(relief.iter().flat_map(|b| b.to_le_bytes())) as u64,
            hashes["relief_f32_le"],
            "relief f32"
        );
        assert_eq!(got(0), hashes["din"], "dIn channel");
        assert_eq!(got(1), hashes["dout"], "dOut channel");
        assert_eq!(got(2), hashes["back"], "back channel");
        assert_eq!(got(3), hashes["relief_u8"], "relief channel");
        // Controls: the fixture is not degenerate, and a one-byte change is seen.
        let over_half = relief.iter().filter(|&&b| f32::from_bits(b) > 0.5).count() as u64;
        assert_eq!(over_half, fx["relief_over_half"]);
        let mut tampered = channel(&f, 3);
        tampered[fx["relief_samples"][0][0].as_u64().unwrap() as usize] ^= 1;
        assert_ne!(fnv32(tampered.into_iter()) as u64, hashes["relief_u8"]);
    }

    /// `dIn` for one px, f32 as `world.js` stores it (the relief's `d > 10`).
    fn exact_din(g: &BitGrid, x: u32, y: u32) -> f32 {
        let (w, h) = g.dims();
        let mut best = u64::MAX;
        let r = 12i64; // only `> 10` matters; farther is "deep" either way
        for yy in (y as i64 - r).max(0)..(y as i64 + r + 1).min(h as i64) {
            for xx in (x as i64 - r).max(0)..(x as i64 + r + 1).min(w as i64) {
                if !g.solid(xx as u32, yy as u32) {
                    best = best.min(((xx - x as i64).pow(2) + (yy - y as i64).pow(2)) as u64);
                }
            }
        }
        if best == u64::MAX {
            1e5
        } else {
            (best as f64).sqrt() as f32
        }
    }

    /// Full pass per scale and a radius-60 crater update, on real generated maps
    /// through the production carve. Guard: the crater's incremental result equals a
    /// full pass. Report: the timings. `--release -- --ignored --nocapture`.
    #[test]
    #[ignore = "measurement: run in release"]
    fn render_fields_bench() {
        for scale in [MapScale::Small, MapScale::Medium, MapScale::Large] {
            let mut map = generate(7, scale);
            let mut f = RenderFields::default();
            let mut fulls = Vec::new();
            for _ in 0..3 {
                let t = std::time::Instant::now();
                f.full(&map.mask);
                fulls.push(t.elapsed().as_secs_f64() * 1e3);
            }
            let wall = f.wall.clone();
            let p = map.meta.surface_points[map.meta.surface_points.len() / 2];
            let (cx, cy, r) = (p.x, p.y, 60);
            map.carve_circle(cx, cy, r);
            let t = std::time::Instant::now();
            let wrote = f.dirty(&map.mask, cx - r, cy - r, 2 * r + 1, 2 * r + 1);
            let crater = t.elapsed().as_secs_f64() * 1e3;
            let mut fresh = RenderFields {
                wall,
                ..Default::default()
            };
            fresh.full_against_snapshot(&map.mask);
            assert!(f.rgba() == fresh.rgba(), "{scale:?}: crater update != full");
            fulls.sort_by(|a, b| a.partial_cmp(b).unwrap());
            println!(
                "{scale:?} {}x{}: full {:.1} ms (median of 3; min {:.1}), r=60 crater {:.2} ms over {}x{} written",
                map.mask.w, map.mask.h, fulls[1], fulls[0], crater, wrote.w, wrote.h
            );
        }
    }
}
