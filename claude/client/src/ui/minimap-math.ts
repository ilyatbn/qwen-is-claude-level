/**
 * T8.06 — the minimap's arithmetic (§A8 — no Phaser in this file).
 *
 * A large map is 4096 × 2048 and the camera shows 640 × 360 of it (§A1), so you
 * see about 1/36th of the world at a time. The minimap is what makes that
 * legible — and it only shows what you have **seen**, so it is a record of
 * exploration rather than a free map.
 *
 * ## What it must not do
 *
 * §A6: it never shows a remote player outside your FoV. The minimap is a
 * *presentation* of information you already have; leaking a position onto it
 * that the screen does not give you would make it strictly better to play
 * looking at the corner of the screen.
 */

/** One byte per minimap cell: 0 unexplored, 255 fully explored. */
export class ExploredMask {
  readonly w: number
  readonly h: number
  readonly cells: Uint8Array

  constructor(w: number, h: number) {
    this.w = Math.max(1, Math.floor(w))
    this.h = Math.max(1, Math.floor(h))
    this.cells = new Uint8Array(this.w * this.h)
  }

  at(cx: number, cy: number): number {
    if (cx < 0 || cy < 0 || cx >= this.w || cy >= this.h) return 0
    return this.cells[cy * this.w + cx] ?? 0
  }

  /**
   * Reveal a disc, in **minimap cells**. Integer span fill, the same shape as
   * the mask carve — a float distance test here and an integer one there is how
   * two rasterisers end up disagreeing at the edges.
   */
  revealCells(cx: number, cy: number, r: number): number {
    if (r < 0) return 0
    let painted = 0
    const ri = Math.floor(r)
    for (let dy = -ri; dy <= ri; dy++) {
      const y = cy + dy
      if (y < 0 || y >= this.h) continue
      const dx = Math.floor(Math.sqrt(Math.max(0, ri * ri - dy * dy)))
      const x0 = Math.max(0, cx - dx)
      const x1 = Math.min(this.w - 1, cx + dx)
      for (let x = x0; x <= x1; x++) {
        const i = y * this.w + x
        if (this.cells[i] !== 255) {
          this.cells[i] = 255
          painted++
        }
      }
    }
    return painted
  }

  /** How many cells have ever been revealed. Monotonic by construction. */
  get exploredCount(): number {
    let n = 0
    for (let i = 0; i < this.cells.length; i++) if (this.cells[i] === 255) n++
    return n
  }
}

export interface MinimapGeometry {
  mapW: number
  mapH: number
  /** Minimap size in its own pixels — one cell each. */
  w: number
  h: number
}

/**
 * World point → minimap cell.
 *
 * Exact at both corners: `(0,0)` maps to `(0,0)` and `(mapW, mapH)` maps to the
 * cell one past the last, which is what a caller clamping to `w-1` expects.
 */
export function worldToCell(x: number, y: number, g: MinimapGeometry): { x: number; y: number } {
  return {
    x: Math.floor((x / g.mapW) * g.w),
    y: Math.floor((y / g.mapH) * g.h),
  }
}

/** The same mapping without the floor, for drawing a marker between cells. */
export function worldToMinimap(x: number, y: number, g: MinimapGeometry): { x: number; y: number } {
  return { x: (x / g.mapW) * g.w, y: (y / g.mapH) * g.h }
}

/** World px → minimap cells, for a reveal radius. Never smaller than one cell. */
export function radiusToCells(worldR: number, g: MinimapGeometry): number {
  return Math.max(1, Math.round((worldR / g.mapW) * g.w))
}

/**
 * Which remote players may be drawn.
 *
 * The FoV test is the same one the renderer uses to decide whether to draw the
 * player at all, so the minimap can never show someone the screen is hiding.
 */
export function visibleRemotes<T extends { x: number; y: number }>(
  me: { x: number; y: number },
  others: readonly T[],
  fovRadius: number,
): T[] {
  const r2 = fovRadius * fovRadius
  return others.filter((o) => {
    const dx = o.x - me.x
    const dy = o.y - me.y
    return dx * dx + dy * dy <= r2
  })
}

/**
 * T21.19: is the crate beacon lit at `roundTime`?
 *
 * Lit for `on` seconds at the start of every `period`, on the round clock (see
 * `MINIMAP_CRATE_PERIOD`). A non-finite clock or a non-positive period is dark
 * rather than lit: a beacon that is always on is the failure the blink exists to avoid.
 */
export function crateBeaconLit(roundTime: number, period: number, on: number): boolean {
  if (!(period > 0) || !Number.isFinite(roundTime)) return false
  const t = ((roundTime % period) + period) % period
  return t < on
}

/**
 * Which world items get a beacon: **dropped crates** — from a crate, and landed.
 *
 * A crate still under its parachute is not a pickup yet, so it does not blink on the
 * way down. And **regardless of field of view**, unlike `visibleRemotes`: the point
 * is finding crates, and the coordinator ruled the beacon map-wide — a deliberate
 * exception to §A6's "the minimap never shows what the screen hides", decided for
 * crates and nothing else. Buried items are not world items, so `docs/32` §5's
 * withholding is untouched.
 */
export function beaconCrates<T extends { source: string; grounded: boolean }>(items: Iterable<T>): T[] {
  const out: T[] = []
  for (const it of items) if (it.source === 'Crate' && it.grounded) out.push(it)
  return out
}
