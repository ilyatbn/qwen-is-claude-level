/**
 * Decoration placement, the parts that are arithmetic (§A8 — no Phaser here).
 *
 * `MapMeta.decorations` has been generated since M1 and shipped in `map_init`
 * since T6.04. It carries kind, position, flip and a scale tier; everything
 * below turns that into "where does this sprite sit, and is it still there".
 *
 * Decoration kinds are `theme * 6 + 0..5`
 * (`crates/game-core/src/map/meta.rs`), so grassland is 0–5, desert 6–11 and
 * frost 12–17. A theme with no art for a kind simply skips it (`docs/50` §6),
 * which is what lets kinds and themes evolve independently.
 */

/** As sent on the wire (`docs/40` §3): flip and scale tier packed into flags. */
export interface WireDecoration {
  kind: number
  x: number
  y: number
  flags: number
}

export interface PlacedDecoration {
  kind: number
  /** Frame key in the `decor` atlas. */
  frame: string
  x: number
  /** Feet line: the surface point it was anchored to at generation. */
  y: number
  flip: boolean
  scale: number
}

/** Bit 0 is flip; bits 1–2 are the scale tier (`Decoration` in map/meta.rs). */
export const FLIP_BIT = 1
export const SCALE_SHIFT = 1
export const SCALE_MASK = 0b11

/** Three tiers, so a field of props is not uniformly sized. */
export const SCALE_TIERS = [0.8, 1.0, 1.25] as const

/**
 * The two shapes the same data arrives in.
 *
 * The sandbox reads `MapMeta` straight out of WASM, where flip and scale tier
 * are separate fields; the game reads `map_init`, where the server packs them
 * into one byte. Normalising here means the layer below has one input, rather
 * than each scene decoding its own — which is how the two would drift.
 */
export function fromMeta(
  decorations: Array<{ kind: number; pos: { x: number; y: number }; flip: boolean; scale_tier: number }>,
): WireDecoration[] {
  return decorations.map((d) => ({
    kind: d.kind,
    x: d.pos.x,
    y: d.pos.y,
    flags: (d.flip ? FLIP_BIT : 0) | ((d.scale_tier & SCALE_MASK) << SCALE_SHIFT),
  }))
}

export function decodeFlags(flags: number): { flip: boolean; scale: number } {
  const tier = (flags >> SCALE_SHIFT) & SCALE_MASK
  return {
    flip: (flags & FLIP_BIT) !== 0,
    scale: SCALE_TIERS[Math.min(tier, SCALE_TIERS.length - 1)] ?? 1,
  }
}

export function frameFor(kind: number): string {
  return `decor_${kind}`
}

/**
 * Half-width of the footprint checked for support, in px.
 *
 * **Not a single pixel under the centre.** `is_standable` in
 * `map/gen/surface.rs` tests support across the whole body width, and its
 * comment records why: on a slope the box rests on the highest ground beneath
 * it and the centre column is often air, so a centre-only test rejected 168 of
 * 192 sampled columns. Decorations are anchored to those same surface points, so
 * the centre-only test drops them the same way — measured at 25 of 35 on
 * seed 4242 before this was a span. The span and the threshold are the same
 * numbers surface.rs uses, so the client agrees with the generator by
 * construction rather than by a similar-looking guess.
 */
export const SUPPORT_HALF_W = 8
/** Solid pixels required in that span, matching `MIN_SUPPORT_PX` in surface.rs. */
export const MIN_SUPPORT_PX = 3

/**
 * Turn wire decorations into placements, dropping any whose ground has gone.
 *
 * `solidAt` is the live mask, so a decoration generated on ground that a
 * mid-round joiner receives already blown away is never placed at all — the same
 * test that removes one later, applied once at build time.
 */
export function place(
  decorations: WireDecoration[],
  hasFrame: (frame: string) => boolean,
  solidAt: (x: number, y: number) => boolean,
): PlacedDecoration[] {
  const out: PlacedDecoration[] = []
  for (const d of decorations) {
    const frame = frameFor(d.kind)
    // A theme with no art for this kind: skip it silently, by design.
    if (!hasFrame(frame)) continue
    if (!supported(d.x, d.y, solidAt)) continue
    const { flip, scale } = decodeFlags(d.flags)
    out.push({ kind: d.kind, frame, x: d.x, y: d.y, flip, scale })
  }
  return out
}

/** Is there ground under this prop's footprint, one pixel below its feet? */
export function supported(
  x: number,
  y: number,
  solidAt: (x: number, y: number) => boolean,
): boolean {
  let solid = 0
  for (let dx = -SUPPORT_HALF_W; dx < SUPPORT_HALF_W; dx++) {
    if (solidAt(x + dx, y + 1) && ++solid >= MIN_SUPPORT_PX) return true
  }
  return false
}

/**
 * Indices of the decorations a carve destroyed.
 *
 * Cosmetic, so this can be lazy — but a tuft of grass floating over a fresh
 * crater is exactly the detail that makes destruction look fake, and the map is
 * being blown apart continuously.
 */
export function destroyedBy(
  placed: PlacedDecoration[],
  cx: number,
  cy: number,
  r: number,
): number[] {
  const hit: number[] = []
  const rr = r * r
  for (let i = 0; i < placed.length; i++) {
    const d = placed[i]
    if (!d) continue
    const dx = d.x - cx
    const dy = d.y - cy
    if (dx * dx + dy * dy <= rr) hit.push(i)
  }
  return hit
}
