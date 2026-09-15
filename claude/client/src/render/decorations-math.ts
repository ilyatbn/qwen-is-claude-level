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
  /** Sprite origin y that puts the art's base row on the feet line (T21.28). */
  originY: number
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
 * How far below a decoration's feet line rock may start and still count as the
 * ground it stands on, in px (T21.28).
 *
 * **Coordinator's ruling, 2026-09-15**: a decoration is drawn only when rock sits
 * directly under **every column of its drawn base**, within this slack. Reported
 * from play: *"make sure … nothing you place on the map looks like it floats"*.
 * Pads and gun platforms get ground filled under them; decorations are pictures
 * with no collision, so rather than stamping rock for them the client holds them
 * to the standard instead, and a prop that would hang is simply not drawn.
 *
 * The rule it replaces asked for 3 solid pixels anywhere in a 16 px span, which a
 * prop balanced on one corner of a slope satisfies. Equal to `constants.rs`'s
 * `DECOR_GROUND_SLACK`, which the generator seats decorations with — asserted in
 * `decorations-real.test.ts`.
 */
export const DECOR_GROUND_SLACK_PX = 2

/**
 * Turn wire decorations into placements, dropping any whose ground has gone.
 *
 * `solidAt` is the live mask, so a decoration generated on ground that a
 * mid-round joiner receives already blown away is never placed at all — the same
 * test that removes one later, applied once at build time.
 */
export function place(
  decorations: WireDecoration[],
  baseOf: (frame: string) => ArtBase | null,
  solidAt: (x: number, y: number) => boolean,
): PlacedDecoration[] {
  const out: PlacedDecoration[] = []
  for (const d of decorations) {
    const frame = frameFor(d.kind)
    // A theme with no art for this kind: skip it silently, by design.
    const base = baseOf(frame)
    if (!base) continue
    const { flip, scale } = decodeFlags(d.flags)
    if (!supported(d.x, d.y, baseColumns(d.x, base, scale, flip), solidAt)) continue
    out.push({ kind: d.kind, frame, x: d.x, y: d.y, flip, scale, originY: baseOriginY(base) })
  }
  return out
}

/** Alpha at or above which an atlas pixel is part of the drawn prop. */
export const OPAQUE_ALPHA = 128

/**
 * Where a frame's art actually meets the ground (T21.28, coordinator's ruling):
 * its lowest opaque row, and that row's opaque span, `[left, right)` in frame
 * pixels. A tuft's transparent margins touch nothing, so they are not its base.
 */
export interface ArtBase {
  frameW: number
  frameH: number
  row: number
  left: number
  right: number
}

/** Measure a frame's `ArtBase` from its alpha. `null` for a fully transparent frame. */
export function opaqueBase(
  alphaAt: (x: number, y: number) => number,
  frameW: number,
  frameH: number,
): ArtBase | null {
  for (let row = frameH - 1; row >= 0; row--) {
    let left = -1
    let right = -1
    for (let x = 0; x < frameW; x++) {
      if (alphaAt(x, row) >= OPAQUE_ALPHA) {
        if (left < 0) left = x
        right = x + 1
      }
    }
    if (left >= 0) return { frameW, frameH, row, left, right }
  }
  return null
}

/**
 * The sprite origin that stands the base row **on** the feet line.
 *
 * Eight of the eighteen frames have transparent rows under their art (measured:
 * `decor_3`'s lowest opaque row is 13 of 18), so anchoring at the frame's bottom
 * edge drew them hovering by their own art on perfectly flat ground.
 */
export function baseOriginY(base: ArtBase): number {
  return (base.row + 1) / base.frameH
}

/**
 * The world columns a drawn base covers, for a sprite at `x` with origin x 0.5,
 * scaled and possibly flipped. Rounded outward, so a partly covered column counts.
 */
export function baseColumns(
  x: number,
  base: ArtBase,
  scale: number,
  flip: boolean,
): { x0: number; x1: number } {
  const half = base.frameW / 2
  const a = flip ? half - base.right : base.left - half
  const b = flip ? half - base.left : base.right - half
  return { x0: Math.floor(x + a * scale), x1: Math.ceil(x + b * scale) }
}

/**
 * Does rock sit under **every** column of the drawn base, within
 * `DECOR_GROUND_SLACK_PX` of the feet line? (T21.28)
 */
export function supported(
  x: number,
  y: number,
  cols: { x0: number; x1: number },
  solidAt: (x: number, y: number) => boolean,
): boolean {
  void x
  for (let col = cols.x0; col < cols.x1; col++) {
    let ground = false
    for (let dy = 1; dy <= 1 + DECOR_GROUND_SLACK_PX; dy++) {
      if (solidAt(col, y + dy)) {
        ground = true
        break
      }
    }
    if (!ground) return false
  }
  return true
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
