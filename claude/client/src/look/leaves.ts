/**
 * T23.08B — the foreground leaves in a match: `kit.js::foregroundDoF`'s out-of-focus clusters, placed per map.
 *
 * F1's two clusters are placed for its 1280×720 frame (`scenes/F1.ts`'s `fg.spots`: low at its corners, over the
 * ground's edge). A map gets its own, **anchored in the world** (mask px) so they move with it like everything else,
 * and **seeded by the map seed**, so every client of a round places the same leaves. Cosmetic: nothing simulated reads
 * them; the placement reads the mask through the scene's core, as the minimap does.
 *
 * - One cluster per `LEAF_STRIP` of the map's width (F1's frame is 1280 px wide and holds two clusters, so a frame
 *   sees about two), at a seeded x in the strip, centred just under the **terrain's surface** in that
 *   column (the first rock from the top; a column with none gets no cluster). Sizes from F1's range (`LEAF_R`,
 *   `LEAF_N`).
 * - The shader has six slots (`atmosphere.ts::FG_SPOTS`): `visibleSpots` picks the clusters that reach into the view,
 *   nearest its centre first.
 * - A leaf never hides a player: the scenes hand over every drawn player's box (`occluderBox`) — `setOccluders`.
 */
import type { Box, Foreground, ViewRect } from './scene'

export type LeafSpot = Foreground['spots'][number]

/** F1's clusters' radii and leaf counts (`scenes/F1.ts`: r 90 / 110, n 9 / 10) — a map's are drawn from this range. */
export const LEAF_R: readonly [number, number] = [90, 110]
export const LEAF_N: readonly [number, number] = [9, 10]
/** One cluster per this many px of map width: F1's 1280-px frame holds two clusters, so one per half a frame. */
export const LEAF_STRIP = 640
/** How far below the surface a cluster's centre sits, as a share of its radius — F1's sit half under the ground's edge. */
export const LEAF_SINK = 0.35
/** Rows scanned per step when finding a column's surface, px. */
const SURFACE_STEP = 4
/**
 * How far a cluster's leaves reach from its centre, in radii: `foregroundDoF` scatters leaf centres ±0.8 r and a leaf is
 * up to 0.95 r long — the reach the view test grows each cluster by.
 */
export const LEAF_REACH = 1.75

/** mulberry32 — a seeded stream (no ambient randomness), one per strip. */
function stream(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/** The map's clusters, mask px. Same (seed, size, mask) in, same clusters out. */
export function leafClusters(seed: number, w: number, h: number, solidAt: (x: number, y: number) => boolean): LeafSpot[] {
  const out: LeafSpot[] = []
  const strips = Math.max(1, Math.round(w / LEAF_STRIP))
  const stripW = w / strips
  for (let i = 0; i < strips; i++) {
    const rnd = stream((seed ^ Math.imul(i + 1, 0x9e3779b9)) >>> 0)
    const x = Math.min(w - 1, Math.floor(i * stripW + rnd() * stripW))
    const r = Math.round(LEAF_R[0] + rnd() * (LEAF_R[1] - LEAF_R[0]))
    const n = rnd() < 0.5 ? LEAF_N[0] : LEAF_N[1]
    let surface = -1
    for (let y = 0; y < h; y += SURFACE_STEP) {
      if (solidAt(x, y)) {
        surface = y
        break
      }
    }
    if (surface < 0) continue
    out.push({ x, y: Math.min(h - 1, Math.round(surface + r * LEAF_SINK)), r, n })
  }
  return out
}

/** The clusters reaching into `view` (mask px), nearest its centre first, at most `max` (the shader's slots). */
export function visibleSpots(all: readonly LeafSpot[], view: ViewRect, max: number): LeafSpot[] {
  const cx = view.x + view.w / 2
  const cy = view.y + view.h / 2
  return all
    .filter((s) => {
      const reach = s.r * LEAF_REACH
      return s.x + reach > view.x && s.x - reach < view.x + view.w && s.y + reach > view.y && s.y - reach < view.y + view.h
    })
    .map((s) => ({ s, d: (s.x - cx) ** 2 + (s.y - cy) ** 2 }))
    .sort((a, b) => a.d - b.d)
    .slice(0, max)
    .map((e) => e.s)
}

/**
 * A drawn player's box for `setOccluders`, mask px `[x0, y0, x1, y1]`, around the body's centre: the drawn figure, not
 * the hitbox — F1's stick box is 51×56 (`scenes/actor-boxes.json`) over a 16×28 body (`PLAYER_W`/`PLAYER_H`), so
 * ±1.6 widths across and ±1 height up and down (arms, the held weapon, the scarf).
 */
export function occluderBox(x: number, y: number, playerW: number, playerH: number): Box {
  return [x - 1.6 * playerW, y - playerH, x + 1.6 * playerW, y + playerH]
}
