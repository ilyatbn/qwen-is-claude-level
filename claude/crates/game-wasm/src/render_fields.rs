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
//! | B | `back`, carved-out rock (cave wall): 255 hard, soft wall fading from open sky (R24) | 0–255 |
//! | A | `relief`, boulders and strata ledges (`world.js::derive`) | `f32(relief)·255`, truncated |
//!
//! ×4 in 8 bits saturates at 63.75 px; that saturation is what makes the dirty
//! rectangle exact (see [`RenderFields::dirty`]).
//!
//! ## `back` — the cave wall (R17)
//!
//! `back = was rock ∧ air now`. R24's final form (T23.07C, [`classify`]): hard wall (255) is round-start
//! rock ∪ landform in the closing of round-start rock by [`WALL_CLOSING_R`]; the rest fades from its
//! open-sky edge over [`BACK_RAMP_PX`] (an enclosed chamber has no such edge, so the fade draws it whole).
//! The mockup's `back` is exactly the pixels its `buildMask`
//! spec carved out of a landform — generated tunnels and craters alike — and R17 rules
//! the game does the same: "was rock" is the generator's landform **or** the mask at
//! round start. It is an input ([`RenderFields::full_with_wall`]) so either source plugs
//! in: [`RenderFields::full`] feeds the round-start mask alone (every carve made in
//! play), and T23.05B supplies the generator's landform, which the client does not have
//! yet. `chunkBake-math.ts::BackdropMask` (`pristine solid ∪ enclosure-classified air`,
//! a heuristic with 2.5–16 % open-sky false positives, off via `CAVE_BACKDROP`) differs
//! from the mockup and is not used.

use game_core::constants::{MapGenerator, MapScale, MapShape, WorldLook};
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
/// R24 final form (T23.07C): the closing radius of [`closed`], px. **Basis: the smallest R keeping
/// look-terrain Level A exact** — F1's tunnel mouths (look-lab = game): `deltaE_cave` 9.6–9.9 at R 24–44,
/// 4.6 at 46–47, 0.00689 (unchanged) at 48; and the arena-E fixture loses 7164 wall px at 47, none at 48.
pub const WALL_CLOSING_R: u32 = 48;
/// R24 final form: soft wall (landform outside the hard set) fades into open sky over this many px — T23.07B's
/// ramp. Basis: the review's hard edges stepped 28–59 in luminance at the median (max 85); over 10 px the step
/// per px falls under look-terrain's 12, and 10 is narrower than the rock's 14 px bevel (F1's `bevel`). ≤
/// [`WRITE_MARGIN`] so `dirty` still equals `full`.
const BACK_RAMP_PX: f64 = 10.0;
/// `world.js::THEMES.dusk.boulders` — F1/F5's theme (`variant_F1.js`, R5: one world).
const BOULDER_MIN_ID: f64 = 0.8;
/// T23.20: `world.js::derive`'s default (`T.boulders ?? 0.62`) — `THEMES.asteroid`, F3's theme, sets none: space's
/// rock (`MapGenerator::Space`, the client's asteroid albedo, `albedo.ts::ASTEROID_PALETTE`).
const ASTEROID_BOULDER_MIN_ID: f64 = 0.62;
/// T23.31: `world.js::THEMES.volcanic.boulders` — F2's theme, the volcanic world look's rock (`docs/78` §A7).
const VOLCANIC_BOULDER_MIN_ID: f64 = 0.75;
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
    /// T23.06B (F6): the grid as little-endian `u32` words (px `i` = bit `i % 32` of word
    /// `i / 32`) — a worker hands the "was rock" mask back in 1/32 of a byte-per-px buffer.
    pub fn to_u32_words(&self) -> Vec<u32> {
        let n = (self.w as usize * self.h as usize).div_ceil(32);
        let mut out = Vec::with_capacity(n);
        for &b in &self.bits {
            out.push(b as u32);
            out.push((b >> 32) as u32);
        }
        out.truncate(n);
        out
    }

    /// The inverse of [`to_u32_words`](Self::to_u32_words); `None` on a wrong length.
    pub fn from_u32_words(w: u32, h: u32, words: &[u32]) -> Option<Self> {
        if words.len() != (w as usize * h as usize).div_ceil(32) {
            return None;
        }
        let mut g = BitGrid::new(w, h);
        for (i, b) in g.bits.iter_mut().enumerate() {
            let lo = words.get(2 * i).copied().unwrap_or(0) as u64;
            let hi = words.get(2 * i + 1).copied().unwrap_or(0) as u64;
            *b = lo | (hi << 32);
        }
        Some(g)
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

/// A call the fields cannot honour. Returned rather than silently degraded (T23.03B, F9):
/// before, a wrong-size wall fell back to the round-start mask and a `dirty` with no
/// snapshot did a full pass against the mask *as it is now* — both a picture that is
/// quietly wrong (caves or craters without their wall) with nothing to report it.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FieldsError {
    /// The "was rock" input is not the mask's size: `(got, want)` in px.
    WallSize(usize, usize),
    /// `dirty` before any full pass, or after the map changed size: nothing to update.
    /// Call a full pass (round start) first.
    NoSnapshot,
    /// T23.06: an installed field buffer is not `w * h * 4` bytes: `(got, want)`.
    FieldSize(usize, usize),
}

impl std::fmt::Display for FieldsError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            FieldsError::WallSize(got, want) => {
                write!(f, "render_fields: wall has {got} px, the mask {want}")
            }
            FieldsError::NoSnapshot => write!(
                f,
                "render_fields: dirty() before a full pass for this map — call render_fields_full first"
            ),
            FieldsError::FieldSize(got, want) => {
                write!(f, "render_fields: installed buffer has {got} bytes, the map {want}")
            }
        }
    }
}

/// The world field buffer and the round-start snapshot `back` is measured against.
#[derive(Default)]
pub struct RenderFields {
    w: u32,
    h: u32,
    rgba: Vec<u8>,
    /// T23.06: `dIn²` exactly (an integer ≤ 65², so `u16`), 0 in air — the albedo reads `dIn`
    /// unquantised, as `world.js::derive` does (the RGBA's ×4-in-8-bits moved its soil and grass
    /// bands: 97.4 % of F1's albedo px exact with it, see `look-albedo`).
    din2: Vec<u16>,
    /// "Was rock": round-start rock ∪ the generator's landform (R17).
    wall: Option<BitGrid>,
    /// R24 final form: the part of `wall` drawn whole (`back` 255); the rest fades from open sky.
    hard: Option<BitGrid>,
    /// T23.05B: the last generator landform derived, keyed by what derived it, so a
    /// resync of the same map (a second `map_init`) costs no second generation — and (T23.07C)
    /// its hard/soft split, computed once per map, never per carve.
    landform: Option<(LandformKey, WallClass)>,
    /// T23.20: the relief's boulder threshold is space's (`boulder_min_id`) — set from the core's generator before
    /// every pass (`GameCore::render_fields_*`), so a carve's update shades as the full pass did.
    asteroid: bool,
    /// T23.31: the map's world look — its theme's boulder threshold on a ground map ([`boulder_min_id`]). Set beside
    /// `asteroid`, from the core's `MapMeta::look` (or the worker's key), before every pass.
    look: WorldLook,
}

/// **The relief's boulder threshold for a map** — `world.js::derive`'s `T.boulders ?? 0.62` for the theme the map is
/// drawn in: space's asteroid (none set: 0.62) whatever the look says (space has no look), else the look's — classic
/// dusk's 0.8, volcanic's 0.75. T23.31 found the volcanic world shaded at dusk's (`look-volcanic`'s relief gap).
fn boulder_min_id(asteroid: bool, look: WorldLook) -> f64 {
    match (asteroid, look) {
        (true, _) => ASTEROID_BOULDER_MIN_ID,
        (false, WorldLook::Classic) => BOULDER_MIN_ID,
        (false, WorldLook::Volcanic) => VOLCANIC_BOULDER_MIN_ID,
    }
}

/// What identifies a generated landform: `map_init`'s seed, scale, generator, theme.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub struct LandformKey {
    pub seed: u64,
    pub scale: MapScale,
    pub generator: MapGenerator,
    pub theme: u8,
    /// T23.30: the map shape — a shaped map's landform is its shape's generator's.
    pub shape: MapShape,
}

impl RenderFields {
    /// R17's generator half (T23.05B): the landform for `key`, re-derived with
    /// `gen::rederive_landform` (exact — see there) and cached by `key`. The caller always
    /// names the map, so a cached landform can never be applied to a different one.
    /// **T23.06B (F4): it includes the map build's ground fill**, so a client that joined
    /// after a carve opened a filled column derives the same "was rock" as one that saw
    /// the round start.
    pub fn landform(&mut self, key: LandformKey) -> &WallClass {
        if self.landform.as_ref().map(|(k, _)| *k) != Some(key) {
            let r = game_core::map::gen::rederive_landform(
                key.seed,
                key.scale,
                key.generator,
                key.shape,
                key.theme,
            );
            let class = classify(&BitGrid::from_solid(&r.landform), &r.mask, WALL_CLOSING_R);
            self.landform = Some((key, class));
        }
        &self.landform.as_ref().expect("set above").1
    }

    /// **R17 whole, guarded (T23.06B F9).** The full pass against the landform for `key`
    /// — unless the mask has rock the landform lacks. Carving only removes rock and the
    /// fill is in the landform, so on matching builds `mask ⊆ landform` whenever the mask
    /// was taken; a px outside it means this client's generator is not the server's
    /// (version skew) or the key names another map. Then the landform cannot be trusted
    /// and the pass falls back to "was rock" = the mask ([`full`](Self::full)): craters
    /// carved from here on show their wall, generated caves read as sky. Returns the rect
    /// and the stray px count (0 = the landform was used). A landform of another size is
    /// refused ([`FieldsError::WallSize`]).
    pub fn full_landform(
        &mut self,
        mask: &impl Solid,
        key: LandformKey,
    ) -> Result<(Rect, u64), FieldsError> {
        let (w, h) = mask.dims();
        let class = self.landform(key);
        let land = &class.all;
        if land.dims() != (w, h) {
            let (lw, lh) = land.dims();
            return Err(FieldsError::WallSize(
                lw as usize * lh as usize,
                w as usize * h as usize,
            ));
        }
        let mut strays = 0u64;
        for y in 0..h {
            for x in 0..w {
                strays += u64::from(mask.solid(x, y) && !land.solid(x, y));
            }
        }
        if strays > 0 {
            return Ok((self.full(mask), strays));
        }
        // Already classified against the round-start mask (`landform`), which a late joiner's mask is not.
        let (all, hard) = (class.all.clone(), class.hard.clone());
        Ok((self.full_with_class(mask, all, hard)?, 0))
    }
}

impl RenderFields {
    /// The whole world, with the mask as it is now as the "was rock" mask. **Call it at
    /// round start**, when the mask is pristine — the moment `terrain.ts::buildAll`
    /// snapshots today. Craters carved later then show the wall.
    pub fn full(&mut self, mask: &impl Solid) -> Rect {
        self.wall = Some(BitGrid::from_solid(mask));
        self.hard = Some(BitGrid::from_solid(mask));
        self.full_against_snapshot(mask)
    }

    /// The whole world against an explicit "was rock" mask (R17): the round-start mask
    /// OR'd with the generator's landform (T23.05B), or a scene's own `back` ∪ solid (the
    /// look-lab). **R24 final form (T23.07C)**: [`classify`] splits it into hard and soft wall against
    /// `mask` as the round start (call it then) — lab and game one rule. A `wall`
    /// of the wrong size is refused ([`FieldsError::WallSize`]) and nothing is written.
    pub fn full_with_wall(
        &mut self,
        mask: &impl Solid,
        wall: BitGrid,
    ) -> Result<Rect, FieldsError> {
        if wall.dims() != mask.dims() {
            let px = |(w, h): (u32, u32)| w as usize * h as usize;
            return Err(FieldsError::WallSize(px(wall.dims()), px(mask.dims())));
        }
        let class = classify(&wall, mask, WALL_CLOSING_R);
        self.full_with_class(mask, class.all, class.hard)
    }

    /// The full pass against a wall already classified ([`classify`]); both OR'd with the mask now.
    fn full_with_class(
        &mut self,
        mask: &impl Solid,
        all: BitGrid,
        hard: BitGrid,
    ) -> Result<Rect, FieldsError> {
        if all.dims() != mask.dims() || hard.dims() != mask.dims() {
            let px = |(w, h): (u32, u32)| w as usize * h as usize;
            return Err(FieldsError::WallSize(px(all.dims()), px(mask.dims())));
        }
        let now = BitGrid::from_solid(mask);
        let (mut all, mut hard) = (all, hard);
        all.union_with(&now);
        hard.union_with(&now);
        self.wall = Some(all);
        self.hard = Some(hard);
        Ok(self.full_against_snapshot(mask))
    }

    fn full_against_snapshot(&mut self, mask: &impl Solid) -> Rect {
        let (w, h) = mask.dims();
        self.w = w;
        self.h = h;
        self.rgba.clear();
        self.rgba.resize(w as usize * h as usize * 4, 0);
        self.din2.clear();
        self.din2.resize(w as usize * h as usize, 0);
        let all = Rect { x: 0, y: 0, w, h };
        self.compute(mask, all, all, all);
        all
    }

    /// After a carve with bounds `(x, y, w, h)`: rewrite the rectangle grown by
    /// [`WRITE_MARGIN`], reading it grown by [`READ_MARGIN`]. Byte-identical to
    /// [`full`](Self::full) because nothing outside `dirty + 64` can change (every
    /// channel saturates or is local by 64 px) and every px written sees all px
    /// within 64 of it. Returns the rectangle written, or [`FieldsError::NoSnapshot`] —
    /// writing nothing — if there has been no full pass for a map of this size.
    pub fn dirty(
        &mut self,
        mask: &impl Solid,
        x: i32,
        y: i32,
        w: i32,
        h: i32,
    ) -> Result<Rect, FieldsError> {
        let (mw, mh) = mask.dims();
        if self.wall.as_ref().map(|p| p.dims()) != Some((mw, mh)) || (self.w, self.h) != (mw, mh) {
            return Err(FieldsError::NoSnapshot);
        }
        Ok(self.dirty_reading(mask, (x, y, w, h), READ_MARGIN))
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

    /// T23.06: `dIn²` per px, exact (see the field).
    pub fn din2(&self) -> &[u16] {
        &self.din2
    }

    /// T23.06: the "was rock" mask the last full pass used — what a worker that ran the
    /// full pass hands back with [`rgba`](Self::rgba). T23.06B (F6): as bit words
    /// ([`BitGrid::to_u32_words`]), not a byte per px (8 MB on a Large map → 1 MB).
    /// T23.07C: the hard set's words follow (`[wall.., hard..]`, two equal halves) — the worker hands
    /// both back, so the main thread never re-derives the split.
    pub fn wall_words(&self) -> Vec<u32> {
        match (&self.wall, &self.hard) {
            (Some(a), Some(b)) => {
                let mut v = a.to_u32_words();
                v.extend(b.to_u32_words());
                v
            }
            _ => Vec::new(),
        }
    }

    /// T23.06: take a full pass computed elsewhere (a worker's copy of this map, so the
    /// ~1 s of a Large map's derive + full pass never runs on the frame) — its "was rock"
    /// mask and its field buffer, verbatim. Afterwards [`dirty`](Self::dirty) works as
    /// after [`full_with_wall`](Self::full_with_wall); a carve made on this mask since the
    /// worker's copy was taken is **not** in the buffer, so the caller replays those
    /// carves' rectangles through `dirty` (incremental == full makes that exact). Wrong
    /// sizes are refused, writing nothing.
    ///
    /// T23.06B (F6): the buffers are **moved in**, not copied — the JS → wasm transfer is
    /// the one copy (it was two: that, then `extend_from_slice`, 48 MB each on Large).
    pub fn install(
        &mut self,
        mask: &impl Solid,
        wall: BitGrid,
        hard: BitGrid,
        rgba: Vec<u8>,
        din2: Vec<u16>,
    ) -> Result<Rect, FieldsError> {
        let (w, h) = mask.dims();
        let px = w as usize * h as usize;
        if wall.dims() != (w, h) || hard.dims() != (w, h) {
            let (ww, wh) = wall.dims();
            return Err(FieldsError::WallSize(ww as usize * wh as usize, px));
        }
        if rgba.len() != px * 4 {
            return Err(FieldsError::FieldSize(rgba.len(), px * 4));
        }
        if din2.len() != px {
            return Err(FieldsError::FieldSize(din2.len() * 2, px * 2));
        }
        self.w = w;
        self.h = h;
        self.rgba = rgba;
        self.din2 = din2;
        self.wall = Some(wall);
        self.hard = Some(hard);
        Ok(Rect { x: 0, y: 0, w, h })
    }

    /// Distances and `back` over `write` (reading `read`); relief over `relief` ⊆ `write`.
    fn compute(&mut self, mask: &impl Solid, read: Rect, write: Rect, relief: Rect) {
        let boulders = boulder_min_id(self.asteroid, self.look);
        let ww = self.w as usize;
        let rgba = &mut self.rgba;
        let din2 = &mut self.din2;
        // R + relief: distance from solid to air.
        distance_pass(mask, true, read, write, |x, y, d| {
            let o = (y as usize * ww + x as usize) * 4;
            rgba[o] = encode_dist(d);
            // `d` is √ of an integer ≤ 65² in f32: squaring and rounding gives it back exactly.
            din2[y as usize * ww + x as usize] = (d as f64 * d as f64).round() as u16;
            if relief.contains(x, y) {
                let rel = if mask.solid(x, y) {
                    relief_at(x, y, d, boulders)
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
        // B: carved-out rock (module docs) — 255 where hard, else the fade from open sky (R24 final form).
        if let (Some(p), Some(hard)) = (&self.wall, &self.hard) {
            let closed = NotOpenAir { mask, wall: p };
            // The ramp saturates at `BACK_RAMP_PX`, so a px written needs only the sky within that of it:
            // read `write` grown by one more px, not `read`.
            let reach = BACK_RAMP_PX.ceil() as u32 + 1;
            let near = Rect::grown(
                write.x as i32,
                write.y as i32,
                write.w as i32,
                write.h as i32,
                reach,
                self.w,
                self.h,
            )
            .intersect(read);
            distance_pass(&closed, true, near, write, |x, y, d| {
                let b = if !p.solid(x, y) || mask.solid(x, y) {
                    0
                } else if hard.solid(x, y) {
                    255
                } else {
                    back_coverage(d)
                };
                rgba[(y as usize * ww + x as usize) * 4 + 2] = b;
            });
        }
    }
}

/// **R24, second amendment (T23.07C): the closing rule.** The "was rock" px of `wall` that count:
/// every round-start rock px, and a px that was only landform (a generated cave, a shaft) only where
/// it lies in the **morphological closing** of round-start rock by a disk of radius [`WALL_CLOSING_R`]
/// — round-start rock dilated by R, then eroded by R (two exact EDT passes, [`distance_pass`]). Gaps
/// narrower than 2R between rock lips (tunnel mouths, as the mockup draws them) stay wall; a slab
/// with open sky on one side is cut back along an arc, never along a column. Measured against the
/// round-start mask, so digging rock away mid-round keeps the wall, and a late joiner (who
/// re-derives that mask, `rederive_landform`) sees the same wall. Once per map, never per carve.
pub fn closed(wall: &BitGrid, round_start: &impl Solid, r: u32) -> BitGrid {
    let (w, h) = wall.dims();
    let all = Rect { x: 0, y: 0, w, h };
    let r = r as f32;
    // Dilate: rock, or air within R of rock.
    let mut dil = BitGrid::from_solid(round_start);
    distance_pass(round_start, false, all, all, |x, y, d| {
        if d <= r {
            dil.put(x, y, true);
        }
    });
    // Erode: dilated px farther than R from anything not dilated.
    let mut out = BitGrid::new(w, h);
    distance_pass(&dil, true, all, all, |x, y, d| {
        if d > r && wall.solid(x, y) {
            out.put(x, y, true);
        }
    });
    out.union_with(&BitGrid::from_solid(round_start));
    out
}

/// "Was rock", split: `all` = round-start rock ∪ landform (R17); `hard` = the part drawn whole.
#[derive(Clone, Debug)]
pub struct WallClass {
    pub all: BitGrid,
    pub hard: BitGrid,
}

/// **R24 final form (fourth amendment, T23.08C).** Hard wall = round-start rock ∪ (landform ∩
/// closing(round-start rock, R)): tunnel mouths and gaps under 2R keep the mockup's edge. Landform outside
/// it is soft: drawn with T23.07B's fade from its open-sky edge ([`back_coverage`]). T23.07C's second term
/// (every landform air region touching no open sky) is gone: it changed zero `back` bytes on seeds 4, 6, 9,
/// 11, 4242 and 7 (T23.08 review F6) — an enclosed chamber has no open-sky edge, so the fade already draws
/// it at 255. Derive, do not add. Once per map.
pub fn classify(landform: &BitGrid, round_start: &impl Solid, r: u32) -> WallClass {
    let mut all = landform.clone();
    all.union_with(&BitGrid::from_solid(round_start));
    let hard = closed(landform, round_start, r);
    WallClass { all, hard }
}

/// Everything that is not open sky: solid now, or was rock (the wall). Its complement is the air
/// soft wall fades against.
struct NotOpenAir<'a, M: Solid> {
    mask: &'a M,
    wall: &'a BitGrid,
}

impl<M: Solid> Solid for NotOpenAir<'_, M> {
    fn dims(&self) -> (u32, u32) {
        self.mask.dims()
    }
    #[inline]
    fn solid(&self, x: u32, y: u32) -> bool {
        self.mask.solid(x, y) || self.wall.solid(x, y)
    }
}

/// Soft wall's `back`: `255·min(1, d / BACK_RAMP_PX)`, `d` its distance to open sky, rounded.
#[inline]
fn back_coverage(d: f32) -> u8 {
    (255.0 * (d as f64 / BACK_RAMP_PX).min(1.0)).round() as u8
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
fn relief_at(x: u32, y: u32, d_in: f32, boulder_min_id: f64) -> f32 {
    let (x, y) = (x as f64, y as f64);
    let warp = fbm(x * 0.02, y * 0.02, 3, 11);
    let band = (y * 0.045 + warp * 3.2 + fbm(x * 0.004, 0.0, 2, 12) * 4.0) % 4.0;
    let bt = band - band.floor();
    let grain = fbm(x * 0.25, y * 0.25, 3, 13);
    let (b1, b2, bid) = cell2(x * 0.022 + warp * 0.6, y * 0.03 + warp * 0.4, 21);
    let mut rel = 0.0f64;
    if bid > boulder_min_id && d_in as f64 > BOULDER_MIN_DEPTH {
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
//
// **For T23.07 (T23.03B, F9): rebuild the `render_fields_ptr` view after every call.**
// A full pass `resize`s the buffer — it can move it — and any allocation in any call can
// grow wasm memory, which detaches every `Uint8Array` over the old `memory.buffer`. A
// view kept from round start reads a detached (zero-length) array or a stale address.
//
// Refusals throw in JS (`Result<_, String>`): a wrong-length wall and a dirty update
// before a full pass are caller bugs, and a thrown error is the one a caller sees.

use crate::GameCore;
use wasm_bindgen::prelude::wasm_bindgen;

/// T23.06B (F11): [`READ_MARGIN`] for the client, which merges dirty rects this close
/// (`terrainFields.ts::mergeRects`) — read from here, not hand-copied into TypeScript.
#[wasm_bindgen]
pub fn render_fields_read_margin() -> u32 {
    READ_MARGIN
}

#[wasm_bindgen]
impl GameCore {
    /// Every field for the whole world, and the `back` snapshot. Call at round start.
    /// Returns the rect written, `[x, y, w, h]`.
    pub fn render_fields_full(&mut self) -> Vec<u32> {
        self.render_fields.asteroid = self.map.meta.generator == MapGenerator::Space;
        self.render_fields.look = self.map.meta.look;
        self.render_fields.full(&self.map.mask).to_vec()
    }

    /// R17: like `render_fields_full`, with an extra "was rock" mask — one byte per px,
    /// row-major, nonzero = rock (the generator's landform, T23.05B; or a look-lab scene's
    /// `back`). OR'd with the mask as it is now. A buffer of the wrong length throws and
    /// writes nothing.
    pub fn render_fields_full_with_wall(&mut self, wall: &[u8]) -> Result<Vec<u32>, String> {
        let (w, h) = (self.map.mask.w, self.map.mask.h);
        if wall.len() != w as usize * h as usize {
            return Err(FieldsError::WallSize(wall.len(), w as usize * h as usize).to_string());
        }
        let mut g = BitGrid::new(w, h);
        for (i, &b) in wall.iter().enumerate() {
            if b != 0 {
                g.put(i as u32 % w, i as u32 / w, true);
            }
        }
        self.render_fields.asteroid = self.map.meta.generator == MapGenerator::Space;
        self.render_fields.look = self.map.meta.look;
        self.render_fields
            .full_with_wall(&self.map.mask, g)
            .map(Rect::to_vec)
            .map_err(|e| e.to_string())
    }

    /// **R17 whole (T23.05B): the production full pass for a networked map.** "Was rock"
    /// = the generator's landform for `map_init`'s own fields (seed — the one it carries,
    /// the attempt that passed — scale byte, generator byte, theme byte), with the map
    /// build's ground fill (T23.06B F4), OR the mask as it is now, so generated caves and
    /// craters both show the wall. The landform is re-derived by running the generator
    /// once (cached per map, so a resync is free); cost in T23.05B's journal line.
    /// Unknown scale/generator bytes throw, writing nothing.
    ///
    /// Returns `[x, y, w, h, strays]`: the rect written, and the mask px the landform
    /// lacks. **`strays > 0` is version skew (F9)**: the pass fell back to "was rock" =
    /// the mask ([`RenderFields::full_landform`]) and the caller should say so.
    #[allow(clippy::too_many_arguments)] // T23.31: the key's seventh field; a wasm export takes no struct.
    pub fn render_fields_full_landform(
        &mut self,
        seed_lo: u32,
        seed_hi: u32,
        scale: u8,
        generator: u8,
        theme: u8,
        shape: u8,
        look: u8,
    ) -> Result<Vec<u32>, String> {
        let key = LandformKey {
            shape: MapShape::from_u8(shape).ok_or(format!("render_fields: shape byte {shape}"))?,
            seed: ((seed_hi as u64) << 32) | seed_lo as u64,
            scale: MapScale::from_u8(scale).ok_or(format!("render_fields: scale byte {scale}"))?,
            generator: MapGenerator::from_u8(generator)
                .ok_or(format!("render_fields: generator byte {generator}"))?,
            theme,
        };
        self.render_fields.asteroid = key.generator == MapGenerator::Space;
        // T23.31: the look shades the relief (not the landform — the cache key leaves it out).
        self.render_fields.look =
            WorldLook::from_u8(look).ok_or(format!("render_fields: look byte {look}"))?;
        let (rect, strays) = self
            .render_fields
            .full_landform(&self.map.mask, key)
            .map_err(|e| e.to_string())?;
        let mut out = rect.to_vec();
        out.push(strays.min(u32::MAX as u64) as u32);
        Ok(out)
    }

    /// T23.06: what names this core's own map to `render_fields_full_landform` —
    /// `[seed_lo, seed_hi, scale, generator, theme]` from its meta. **Only for a map this core
    /// generated** (sandbox, preview): after `load_mask` the meta is the startup map's, and a
    /// networked client names its map from `map_init` instead.
    pub fn render_fields_own_key(&self) -> Vec<u32> {
        let m = &self.map.meta;
        vec![
            m.seed as u32,
            (m.seed >> 32) as u32,
            m.scale.as_u8() as u32,
            m.generator.to_u8() as u32,
            m.theme as u32,
            m.shape.to_u8() as u32,
            m.look.to_u8() as u32,
        ]
    }

    /// After a carve with bounds `(x, y, w, h)` (world px, may overhang the map).
    /// Returns the rect written, `[x, y, w, h]` — upload exactly that. Throws, writing
    /// nothing, before a full pass for this map.
    pub fn render_fields_dirty(
        &mut self,
        x: i32,
        y: i32,
        w: i32,
        h: i32,
    ) -> Result<Vec<u32>, String> {
        self.render_fields.asteroid = self.map.meta.generator == MapGenerator::Space;
        self.render_fields.look = self.map.meta.look;
        self.render_fields
            .dirty(&self.map.mask, x, y, w, h)
            .map(Rect::to_vec)
            .map_err(|e| e.to_string())
    }

    /// T23.06: the last full pass's "was rock" mask — a worker returns it with the field
    /// buffer for [`render_fields_install`](Self::render_fields_install). T23.06B (F6): bit
    /// words, `ceil(w * h / 32)` of them ([`BitGrid::to_u32_words`]).
    pub fn render_fields_wall_words(&self) -> Vec<u32> {
        self.render_fields.wall_words()
    }

    /// T23.06: install a full pass a worker computed on a copy of this map (`wall` as bit
    /// words, `rgba` the field buffer, `din2` the exact squared distances) — **moved in**,
    /// one copy across the boundary (T23.06B F6). Then replay, through
    /// `render_fields_dirty`, every carve made here since the copy was taken. Wrong sizes
    /// throw, writing nothing.
    pub fn render_fields_install(
        &mut self,
        wall: Vec<u32>,
        rgba: Vec<u8>,
        din2: Vec<u16>,
    ) -> Result<Vec<u32>, String> {
        let (w, h) = (self.map.mask.w, self.map.mask.h);
        let px = w as usize * h as usize;
        // `[wall.., hard..]` (`render_fields_wall_words`): two equal halves.
        let half = wall.len() / 2;
        let (a, b) = wall.split_at(half);
        let err = || FieldsError::WallSize(wall.len() * 16, px).to_string();
        let g = BitGrid::from_u32_words(w, h, a).ok_or_else(err)?;
        let hard = BitGrid::from_u32_words(w, h, b).ok_or_else(err)?;
        self.render_fields
            .install(&self.map.mask, g, hard, rgba, din2)
            .map(Rect::to_vec)
            .map_err(|e| e.to_string())
    }

    /// T23.06B (F7): the carve boxes since the last call, flattened `[x0, y0, x1, y1]*`
    /// (inclusive world px, each within one chunk) — `Map::drain_carve_boxes`. The client's
    /// terrain fields diff only these, not whole 256² chunks.
    pub fn render_fields_take_carve_boxes(&mut self) -> Vec<i32> {
        self.map.drain_carve_boxes().into_iter().flatten().collect()
    }

    /// T23.06: a copy of the field buffer (a worker transfers it; the main thread reads the
    /// buffer in place through `render_fields_ptr`).
    pub fn render_fields_rgba_copy(&self) -> Vec<u8> {
        self.render_fields.rgba().to_vec()
    }

    /// T23.06: a copy of the exact `dIn²` buffer (a worker transfers it).
    pub fn render_fields_din2_copy(&self) -> Vec<u16> {
        self.render_fields.din2().to_vec()
    }

    /// T23.06: address of the `dIn²` buffer, `width * height` `u16`s, row-major.
    pub fn render_fields_din2_ptr(&self) -> *const u16 {
        self.render_fields.din2().as_ptr()
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

    /// R24 final form (T23.07C). In units of R: a tunnel R tall through a hill is hard wall, mouth
    /// included; a slab of landform standing in open sky is soft (it fades from its sky edge — kept, not
    /// removed); an enclosed chamber 3R across (wider than 2R, so outside the closing) is soft but drawn
    /// whole, since it has no open-sky edge to fade from (R24's fourth amendment: why the enclosed-region
    /// term was deleted); a dug-away roof keeps the tunnel's wall (the split read the round start).
    /// Control: the slab's sky edge px would be 255 were it hard.
    #[test]
    fn hard_wall_is_the_closing_the_rest_fades_and_a_chamber_is_whole() {
        let r = WALL_CLOSING_R;
        let (w, h) = (16 * r, 16 * r);
        let ground = 8 * r;
        let mut rock = BitGrid::new(w, h);
        for y in ground..h {
            for x in 0..w {
                rock.put(x, y, true);
            }
        }
        let tunnel = 5 * r..6 * r;
        for y in 4 * r..ground {
            for x in 8 * r..14 * r {
                rock.put(x, y, !tunnel.contains(&y));
            }
        }
        let mut land = rock.clone();
        // The slab, columns R..3R, rows R..8R, open sky left, right and above.
        for y in r..ground {
            for x in r..3 * r {
                land.put(x, y, true);
            }
        }
        for y in tunnel.clone() {
            for x in 8 * r..14 * r {
                land.put(x, y, true);
            }
        }
        // An enclosed chamber, 3R across, deep in the ground.
        let (cx, cy) = (5 * r as i32, 12 * r as i32);
        circle(&mut rock, cx, cy, (3 * r / 2) as i32, false);
        let mut f = RenderFields::default();
        f.full_with_wall(&rock, land).unwrap();
        let b = |f: &RenderFields, x: u32, y: u32| f.rgba()[((y * w + x) * 4 + 2) as usize];
        let hard = |f: &RenderFields, x: u32, y: u32| f.hard.as_ref().unwrap().solid(x, y);
        let (tx, ty) = (11 * r, 5 * r + r / 2);
        assert!(
            hard(&f, tx, ty) && b(&f, tx, ty) == 255,
            "the tunnel is hard wall"
        );
        // The closing's disk reaches 0.134 R into a mouth R tall (the lips' corners stop it): past that, hard.
        assert!(
            hard(&f, 8 * r + r / 4, ty) && b(&f, 8 * r + r / 4, ty) == 255,
            "and its mouth, R/4 in"
        );
        assert!(!hard(&f, r, 3 * r), "the slab is not hard");
        assert_eq!(b(&f, r, 3 * r), back_coverage(1.0), "its sky edge fades");
        assert_eq!(
            b(&f, 2 * r, 3 * r),
            255,
            "its inside, farther than the ramp from sky, is whole"
        );
        assert!(
            !hard(&f, 2 * r, 3 * r) && b(&f, 2 * r, 3 * r) > 0,
            "kept, not removed"
        );
        // The chamber's centre is outside the closing (not hard), and the fade draws it whole anyway.
        assert!(
            !hard(&f, cx as u32, cy as u32),
            "the chamber is outside the closing"
        );
        assert_eq!(
            b(&f, cx as u32, cy as u32),
            255,
            "the enclosed chamber is drawn whole"
        );
        // Its rim, one px in from the rock: still no open sky within the ramp, still whole.
        let rim = cx as u32 - (3 * r / 2) + 1;
        assert_eq!(b(&f, rim, cy as u32), 255, "and so is its rim");
        // Dig the hill's top away mid-round: the tunnel stays hard wall.
        let mut dug = rock.clone();
        for y in 4 * r..5 * r {
            for x in 8 * r..14 * r {
                dug.put(x, y, false);
            }
        }
        f.dirty(&dug, 8 * r as i32, 4 * r as i32, 6 * r as i32, r as i32)
            .unwrap();
        assert_eq!(b(&f, tx, ty), 255, "a dug-away roof keeps the wall");
        assert_eq!(
            b(&f, tx, 4 * r + r / 2),
            255,
            "and the dug roof itself is crater wall"
        );
    }

    /// Carve random circles into random terrain, update per dirty rect, compare with a
    /// from-scratch full pass. `read_margin` is the live parameter of `dirty`.
    fn incremental_mismatches(read_margin: u32) -> (usize, usize) {
        let (mut bad_seeds, mut changed, mut written) = (0, 0, 0u64);
        for seed in 0..20u64 {
            let mut g = random_grid(100 + seed, 384, 256);
            let mut f = RenderFields::default();
            // T23.07C: a random landform too, so hard wall, soft (faded) wall and sky all meet the carves.
            f.full_with_wall(&g, random_grid(200 + seed, 384, 256))
                .unwrap();
            let (wall, hard) = (f.wall.clone(), f.hard.clone());
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
                hard: hard.clone(),
                ..Default::default()
            };
            fresh.full_against_snapshot(&g);
            changed += channel(&fresh, 2).iter().filter(|&&b| b == 255).count();
            if f.rgba() != fresh.rgba() || f.din2() != fresh.din2() {
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
        core.render_fields_full_with_wall(&wall).unwrap();
        // R24 final form (T23.07C): an input px is hard wall iff it lies in the closing of the rock.
        let mask = core.map.mask.clone();
        let mut input = BitGrid::new(w, h);
        for &i in &air {
            input.put(i as u32 % w, i as u32 / w, true);
        }
        let kept = closed(&input, &mask, WALL_CLOSING_R);
        let (under, open): (Vec<usize>, Vec<usize>) = air
            .iter()
            .partition(|&&i| kept.solid(i as u32 % w, i as u32 / w));
        assert!(
            under.len() > 20 && open.len() > 20,
            "both kinds sampled: {} closed, {} open",
            under.len(),
            open.len()
        );
        // Independent of `closed`: a px in a closing by R has rock within R of it.
        let rr = WALL_CLOSING_R as i32;
        let near_rock = |i: usize| {
            let (x, y) = (i as i32 % w as i32, i as i32 / w as i32);
            (-rr..=rr).any(|dy| {
                (-rr..=rr).any(|dx| dx * dx + dy * dy <= rr * rr && core.solid_at(x + dx, y + dy))
            })
        };
        assert!(
            under.iter().all(|&i| near_rock(i)),
            "a closed px lies within R of rock"
        );
        assert!(
            under.iter().all(|&i| b(&core, i) == 255),
            "the closed input px are hard wall"
        );
        // Outside the closing a lone input px is soft wall beside open sky: the fade's first step.
        assert!(
            open.iter().all(|&i| b(&core, i) == back_coverage(1.0)),
            "the open-sky input px are soft wall"
        );
        let walled = core
            .render_fields
            .rgba()
            .chunks_exact(4)
            .filter(|p| p[2] > 0)
            .count();
        assert_eq!(walled, air.len(), "and nothing else is wall");
    }

    /// T23.05B (R17): a **generated** cave shows as cave wall, through both production
    /// entry points — a locally generated map, and a networked one that only has what
    /// `map_init` carries (the RLE mask and the meta bytes). Control: the round-start-only
    /// pass on the same pristine map has no wall at all.
    #[test]
    fn a_generated_cave_is_cave_wall_on_the_client() {
        for generator in [0u8, 1] {
            let mut local = GameCore::new();
            local.generate_with(0x1234_5678, 0, 0, generator);
            let backs = |c: &GameCore| {
                c.render_fields
                    .rgba()
                    .chunks_exact(4)
                    .filter(|p| p[2] == 255)
                    .count()
            };
            local.render_fields_full();
            assert_eq!(
                backs(&local),
                0,
                "gen {generator}: pristine map, round-start wall only"
            );
            own_landform(&mut local);
            let m = &local.map;
            let o = game_core::map::gen::rederive(
                m.meta.seed,
                m.meta.scale,
                m.meta.generator,
                m.meta.shape,
                m.meta.theme,
            );
            // Counted per px, not as a difference of totals: pass 8's ground fill puts
            // rock in the map that is not in the landform.
            let (w, h) = (m.mask.w as i32, m.mask.h as i32);
            // R24 final form (T23.07C): every cave px is wall (back > 0); the hard ones are 255.
            let caves = (0..w * h)
                .filter(|i| o.landform.get(i % w, i / w) && !m.mask.get(i % w, i / w))
                .count() as u64;
            assert!(caves > 1000, "gen {generator}: only {caves} cave px");
            let walled = local
                .render_fields
                .rgba()
                .chunks_exact(4)
                .filter(|p| p[2] > 0)
                .count() as u64;
            assert_eq!(walled, caves, "gen {generator}: every cave px is wall");
            let hard_caves = {
                let hd = local.render_fields.hard.as_ref().unwrap();
                (0..w * h)
                    .filter(|i| {
                        hd.solid((i % w) as u32, (i / w) as u32) && !m.mask.get(i % w, i / w)
                    })
                    .count() as u64
            };
            let fading = local
                .render_fields
                .rgba()
                .chunks_exact(4)
                .filter(|p| p[2] > 0 && p[2] < 255)
                .count();
            eprintln!("gen {generator}: {caves} cave px, {hard_caves} hard, {fading} on a fade");
            assert!(
                hard_caves > 1000 && hard_caves <= caves,
                "gen {generator}: hard {hard_caves}"
            );
            // Networked: `worldMirror.applyMapInit`'s calls, then the fields.
            let mut net = GameCore::new();
            net.set_map_generator(generator);
            let rle = game_core::map::rle::encode(&m.mask);
            assert!(net.load_mask(m.mask.w, m.mask.h, &rle));
            let seed = m.meta.seed;
            let out = net
                .render_fields_full_landform(
                    seed as u32,
                    (seed >> 32) as u32,
                    m.meta.scale.as_u8(),
                    m.meta.generator.to_u8(),
                    m.meta.theme,
                    m.meta.shape.to_u8(),
                    m.meta.look.to_u8(),
                )
                .unwrap();
            assert_eq!(out[4], 0, "gen {generator}: strays on a matching build");
            assert!(
                net.render_fields.rgba() == local.render_fields.rgba(),
                "gen {generator}: net ≠ local"
            );
        }
        let mut c = GameCore::new();
        assert!(c
            .render_fields_full_landform(1, 0, 9, 1, 0, 0, 0)
            .is_err_and(|e| e.contains("scale byte 9")));
    }

    /// T23.06: `din2` is the exact squared distance to the nearest air px (capped at 65²), 0 in
    /// air — against a brute-force search, on random grids of several seeds.
    #[test]
    fn din2_is_the_exact_squared_distance() {
        for seed in 0..4u64 {
            let g = random_grid(seed, 96, 80);
            let mut f = RenderFields::default();
            f.full(&g);
            let (w, h) = g.dims();
            let mut solid = 0;
            for y in 0..h {
                for x in 0..w {
                    let want = if !g.solid(x, y) {
                        0
                    } else {
                        solid += 1;
                        let mut best = u32::MAX;
                        for yy in 0..h {
                            for xx in 0..w {
                                if !g.solid(xx, yy) {
                                    let (dx, dy) = (x.abs_diff(xx), y.abs_diff(yy));
                                    best = best.min(dx * dx + dy * dy);
                                }
                            }
                        }
                        best.min(CAP_SQ)
                    };
                    assert_eq!(
                        f.din2()[(y * w + x) as usize] as u32,
                        want,
                        "seed {seed} ({x}, {y})"
                    );
                }
            }
            assert!(solid > 100);
        }
    }

    /// T23.06: the worker path — a full pass on a copy, installed, then a carve made on
    /// the main copy meanwhile replayed through `dirty` — is byte-identical to a full pass
    /// on the carved map. Control: without the replay the crater is missing (bytes differ).
    #[test]
    fn an_installed_worker_pass_plus_replayed_carves_equals_a_full_pass() {
        let mut main = GameCore::new();
        main.generate_with(4242, 0, 0, 1);
        let mut worker = GameCore::new();
        worker.set_map_generator(1);
        assert!(worker.load_mask(main.width(), main.height(), &main.mask_rle()));
        let m = &main.map.meta;
        let (seed, scale, gen, theme) = (m.seed, m.scale.as_u8(), m.generator.to_u8(), m.theme);
        worker
            .render_fields_full_landform(seed as u32, (seed >> 32) as u32, scale, gen, theme, 0, 0)
            .unwrap();
        let (wall, rgba, din2) = (
            worker.render_fields_wall_words(),
            worker.render_fields.rgba().to_vec(),
            worker.render_fields_din2_copy(),
        );
        // Meanwhile, on the main copy: a crater, in the ground under the first spawn.
        let sp = main.map.meta.spawn_points[0];
        let (cx, cy, r) = (sp.x, sp.y + 30, 60);
        main.carve(cx, cy, r);
        main.render_fields_install(wall.clone(), rgba.clone(), din2.clone())
            .unwrap();
        let stale = main.render_fields.rgba().to_vec();
        main.render_fields_dirty(cx - r, cy - r, 2 * r + 1, 2 * r + 1)
            .unwrap();
        let mut truth = GameCore::new();
        truth.generate_with(4242, 0, 0, 1);
        truth.carve(cx, cy, r);
        let n = (truth.width() * truth.height()) as usize;
        // The truth's "was rock" is the landform ∪ the mask **before** the carve.
        let mut pre = GameCore::new();
        pre.generate_with(4242, 0, 0, 1);
        own_landform(&mut pre);
        // `pre`'s wall is already classified against the round start; `truth`'s mask is carved.
        let words = pre.render_fields_wall_words();
        let (a, b) = words.split_at(words.len() / 2);
        let (tw, th) = (truth.width(), truth.height());
        let pre_all = BitGrid::from_u32_words(tw, th, a).unwrap();
        let pre_hard = BitGrid::from_u32_words(tw, th, b).unwrap();
        let truth_mask = truth.map.mask.clone();
        truth
            .render_fields
            .full_with_class(&truth_mask, pre_all, pre_hard)
            .unwrap();
        assert_eq!(main.render_fields.rgba().len(), n * 4);
        assert!(
            main.render_fields.rgba() == truth.render_fields.rgba(),
            "installed + replayed ≠ full"
        );
        assert!(
            main.render_fields.din2() == truth.render_fields.din2(),
            "dIn² installed + replayed ≠ full"
        );
        assert!(
            stale != truth.render_fields.rgba(),
            "control: the un-replayed install already matched"
        );
        assert!(main
            .render_fields_install(wall[1..].to_vec(), rgba.clone(), din2.clone())
            .is_err_and(|e| e.contains("wall has")));
        assert!(main
            .render_fields_install(wall, rgba[4..].to_vec(), din2)
            .is_err_and(|e| e.contains("installed buffer")));
    }

    /// `render_fields_full_landform` for a map **this core generated**: its own meta names
    /// it, exactly as `map_init` would (was a wasm export only tests called — T23.06B F11).
    fn own_landform(core: &mut GameCore) -> Vec<u32> {
        let m = &core.map.meta;
        let (seed, scale, generator, theme) = (m.seed, m.scale, m.generator, m.theme);
        let (shape, look) = (m.shape.to_u8(), m.look.to_u8());
        core.render_fields_full_landform(
            seed as u32,
            (seed >> 32) as u32,
            scale.as_u8(),
            generator.to_u8(),
            theme,
            shape,
            look,
        )
        .unwrap()
    }

    /// The last full pass's "was rock" mask, a byte per px (for `render_fields_full_with_wall`).
    /// T23.06B (F6): the wall's bit words round-trip, and a wrong length is refused.
    #[test]
    fn wall_words_round_trip() {
        let g = random_grid(7, 97, 33);
        let words = g.to_u32_words();
        assert_eq!(words.len(), (97 * 33usize).div_ceil(32));
        assert_eq!(BitGrid::from_u32_words(97, 33, &words), Some(g));
        assert_eq!(BitGrid::from_u32_words(97, 33, &words[1..]), None);
    }

    /// T23.06B (F4): **the cave wall does not depend on when a client joined.** A client
    /// at round start (full pass on the pristine mask, then the carve through `dirty`) and a
    /// client that joined after the carve (full pass on the carved mask) hold the same
    /// fields, byte for byte — with the carve opening a column the map build filled under a
    /// pad. Control: the landform **without** the fill (T23.05B's) gives the late joiner
    /// sky where the round-start client has wall.
    #[test]
    fn a_late_joiner_and_a_round_start_client_derive_the_same_wall() {
        let mut checked = 0;
        for (seed, generator) in [(4242u32, 1u8), (7, 0), (12161, 1)] {
            let mut start = GameCore::new();
            start.generate_with(seed, 0, 0, generator);
            let m = start.map.clone();
            let gen = game_core::map::gen::rederive(
                m.meta.seed,
                m.meta.scale,
                m.meta.generator,
                m.meta.shape,
                m.meta.theme,
            );
            // The fill: rock in the round-start mask the generator did not make.
            let (w, h) = (m.mask.w as i32, m.mask.h as i32);
            let fill: Vec<(i32, i32)> = (0..w * h)
                .map(|i| (i % w, i / w))
                .filter(|&(x, y)| m.mask.get(x, y) && !gen.mask.get(x, y))
                .collect();
            // The highest filled px away from the side walls: the fill's lowest rows can reach
            // bedrock and the map's edges are not carvable, and neither opens (measured: seed
            // 12161's topmost fill px sits at x 124 and a carve there changes nothing).
            let Some(&(fx, fy)) = fill
                .iter()
                .filter(|p| p.0 > w / 4 && p.0 < 3 * w / 4)
                .min_by_key(|p| p.1)
            else {
                continue;
            };
            own_landform(&mut start);
            let r = 24;
            start.carve(fx, fy, r);
            let opened = fill
                .iter()
                .filter(|&&(x, y)| !start.map.mask.get(x, y))
                .count();
            assert!(opened > 0, "seed {seed}: the carve opened no filled px");
            start
                .render_fields_dirty(fx - r, fy - r, 2 * r + 1, 2 * r + 1)
                .unwrap();
            let mut late = GameCore::new();
            late.set_map_generator(generator);
            let rle = game_core::map::rle::encode(&start.map.mask);
            assert!(late.load_mask(m.mask.w, m.mask.h, &rle));
            let s = m.meta.seed;
            let out = late
                .render_fields_full_landform(
                    s as u32,
                    (s >> 32) as u32,
                    m.meta.scale.as_u8(),
                    m.meta.generator.to_u8(),
                    m.meta.theme,
                    m.meta.shape.to_u8(),
                    m.meta.look.to_u8(),
                )
                .unwrap();
            assert_eq!(out[4], 0, "seed {seed}: strays");
            assert!(
                late.render_fields.rgba() == start.render_fields.rgba(),
                "seed {seed}: the late joiner's fields ≠ the round-start client's"
            );
            // Control: T23.05B's landform (no fill) — the opened fill reads as sky late.
            let mut old = GameCore::new();
            old.set_map_generator(generator);
            assert!(old.load_mask(m.mask.w, m.mask.h, &rle));
            let bytes: Vec<u8> = (0..w * h)
                .map(|i| u8::from(gen.landform.get(i % w, i / w)))
                .collect();
            old.render_fields_full_with_wall(&bytes).unwrap();
            assert!(
                old.render_fields.rgba() != start.render_fields.rgba(),
                "seed {seed}: control — without the fill the late wall already matched"
            );
            checked += 1;
        }
        assert!(checked >= 2, "only {checked} maps had ground fill to carve");
    }

    /// T23.06B (F9): **version skew falls back, visibly.** A mask with rock the re-derived
    /// landform lacks (a doctored `map_init`, or another generator build) reports strays and
    /// takes "was rock" = the mask: no generated cave is wall. Control: the true mask —
    /// no strays, and the caves are wall.
    #[test]
    fn a_mask_the_landform_does_not_cover_falls_back_to_the_mask() {
        let mut local = GameCore::new();
        local.generate_with(4242, 0, 0, 1);
        let m = local.map.clone();
        let s = m.meta.seed;
        let key = |c: &mut GameCore| {
            c.render_fields_full_landform(
                s as u32,
                (s >> 32) as u32,
                m.meta.scale.as_u8(),
                m.meta.generator.to_u8(),
                m.meta.theme,
                m.meta.shape.to_u8(),
                m.meta.look.to_u8(),
            )
            .unwrap()
        };
        let walls = |c: &GameCore| {
            c.render_fields
                .rgba()
                .chunks_exact(4)
                .filter(|p| p[2] == 255)
                .count()
        };
        let mut good = GameCore::new();
        good.set_map_generator(1);
        assert!(good.load_mask(m.mask.w, m.mask.h, &game_core::map::rle::encode(&m.mask)));
        assert_eq!(key(&mut good)[4], 0);
        assert!(
            walls(&good) > 1000,
            "control: the true mask shows its caves"
        );
        // Doctored: a 20×20 block of rock in the open sky at the top of the map.
        let mut doctored = m.mask.clone();
        for y in 4..24 {
            doctored.set_run(y, 100, 119);
        }
        let mut bad = GameCore::new();
        bad.set_map_generator(1);
        assert!(bad.load_mask(m.mask.w, m.mask.h, &game_core::map::rle::encode(&doctored)));
        let out = key(&mut bad);
        assert_eq!(out[4], 400, "the doctored px are the strays");
        assert_eq!(
            walls(&bad),
            0,
            "fallback: wall = the mask, no generated cave is wall"
        );
    }

    /// F9: the two calls that used to degrade silently now refuse, write nothing and say
    /// why — through `game-core` and through the WASM boundary. Control: the same calls
    /// in the right order succeed.
    #[test]
    fn a_wrong_wall_and_an_early_dirty_are_refused_not_degraded() {
        let mut core = GameCore::new();
        let n = (core.width() * core.height()) as usize;
        // No full pass yet: dirty is refused, and nothing was allocated or written.
        let early = core.render_fields_dirty(10, 10, 20, 20);
        assert!(
            early
                .as_ref()
                .is_err_and(|e| e.contains("before a full pass")),
            "{early:?}"
        );
        assert_eq!(
            core.render_fields_len(),
            0,
            "an early dirty wrote something"
        );
        // A wall one byte short is refused and leaves the buffer as it was.
        let short = core.render_fields_full_with_wall(&vec![0u8; n - 1]);
        assert_eq!(
            short,
            Err(FieldsError::WallSize(n - 1, n).to_string()),
            "short wall"
        );
        assert_eq!(
            core.render_fields_len(),
            0,
            "a refused wall wrote something"
        );
        // Control: the right order and the right size both succeed.
        assert!(core.render_fields_full_with_wall(&vec![0u8; n]).is_ok());
        assert_eq!(core.render_fields_len(), n * 4);
        assert!(core.render_fields_dirty(10, 10, 20, 20).is_ok());
        // Grid level: a size-changed map is also no snapshot.
        let mut f = RenderFields::default();
        f.full(&BitGrid::new(64, 32));
        assert_eq!(
            f.dirty(&BitGrid::new(32, 32), 0, 0, 4, 4),
            Err(FieldsError::NoSnapshot)
        );
        assert!(f.dirty(&BitGrid::new(64, 32), 0, 0, 4, 4).is_ok());
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
        f.full_with_wall(&solid, back).unwrap();
        // Control (R17): the generated caves are wall only because the landform was fed.
        let mut round_start_only = RenderFields::default();
        round_start_only.full(&solid);
        assert!(channel(&round_start_only, 2).iter().all(|&b| b == 0));
        assert!(channel(&f, 2).iter().filter(|&&b| b == 255).count() > 1000);

        let mut relief = Vec::new();
        for y in 0..h {
            for x in 0..w {
                let bits = if solid.solid(x, y) {
                    relief_at(x, y, exact_din(&solid, x, y), BOULDER_MIN_ID).to_bits()
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
            let (wall, hard) = (f.wall.clone(), f.hard.clone());
            let p = map.meta.surface_points[map.meta.surface_points.len() / 2];
            let (cx, cy, r) = (p.x, p.y, 60);
            map.carve_circle(cx, cy, r);
            let t = std::time::Instant::now();
            let wrote = f
                .dirty(&map.mask, cx - r, cy - r, 2 * r + 1, 2 * r + 1)
                .unwrap();
            let crater = t.elapsed().as_secs_f64() * 1e3;
            let mut fresh = RenderFields {
                wall,
                hard,
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

    /// T23.20: space's rock (F3's asteroid) raises boulders from `derive`'s default 0.62, the ground's from dusk's
    /// 0.8 — so the asteroid's relief has more domes, and the dusk threshold (the control) fewer, on the same rock.
    #[test]
    fn volcanic_relief_has_the_volcanic_boulders() {
        // T23.31: the volcanic look raises its rock's boulders at `THEMES.volcanic`'s 0.75; space keeps the asteroid's
        // whatever its look byte; classic is dusk's.
        assert_eq!(
            boulder_min_id(false, WorldLook::Volcanic),
            VOLCANIC_BOULDER_MIN_ID
        );
        assert_eq!(boulder_min_id(false, WorldLook::Classic), BOULDER_MIN_ID);
        assert_eq!(
            boulder_min_id(true, WorldLook::Volcanic),
            ASTEROID_BOULDER_MIN_ID
        );
        // Through the core, end to end: the same map's relief channel differs by look, and only the relief.
        let fields = |look: WorldLook| {
            let mut core = GameCore::new();
            core.generate_with(7, 0, 0, 1);
            core.map.meta.look = look;
            core.render_fields_full();
            core.render_fields.rgba.clone()
        };
        let (c, v) = (fields(WorldLook::Classic), fields(WorldLook::Volcanic));
        let differ = |ch: usize| {
            c.chunks(4)
                .zip(v.chunks(4))
                .filter(|(a, b)| a[ch] != b[ch])
                .count()
        };
        assert!(
            differ(3) > 0,
            "the volcanic look's relief is the classic one"
        );
        assert_eq!(
            (differ(0), differ(1), differ(2)),
            (0, 0, 0),
            "a look moved a distance field"
        );
    }

    #[test]
    fn asteroid_relief_has_the_asteroid_boulders() {
        let domes = |t: f64| {
            (0..256u32)
                .flat_map(|y| (0..256u32).map(move |x| (x, y)))
                .filter(|&(x, y)| relief_at(x, y, 30.0, t) > 0.6)
                .count()
        };
        // Measured: 13498 vs 10840 over this 256² patch at depth 30. A lower threshold only adds domes: every px is
        // at least as high, and a tenth more of them are high.
        let (a, d) = (domes(ASTEROID_BOULDER_MIN_ID), domes(BOULDER_MIN_ID));
        assert!(
            a > d + d / 10 && d > 0,
            "asteroid {a} vs dusk {d} high-relief px"
        );
        for y in 0..64 {
            for x in 0..64 {
                assert!(
                    relief_at(x, y, 30.0, ASTEROID_BOULDER_MIN_ID)
                        >= relief_at(x, y, 30.0, BOULDER_MIN_ID)
                );
            }
        }
    }
}
