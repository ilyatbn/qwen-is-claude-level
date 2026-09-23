/**
 * T22.08B — the solar flare's drawing rules, the pure half (§A8: Phaser cannot be
 * imported under vitest). `flareFx.ts` paints what these decide.
 *
 * **Nothing here says where the ribbon is.** That is `GameCore::flare_points` — the
 * points the server damages with (`R80`) — and every function below takes them as
 * given. What lives here is how to paint around them: the quad a shader needs, the
 * passes a Canvas stroke needs, how visible a telegraph is, and who is burning.
 */

/** A ribbon as the core returns it: `[x0, y0, x1, y1, …]`, world px. */
type FlarePoints = ArrayLike<number>

/** An axis-aligned world rectangle. */
export interface Box {
  x: number
  y: number
  w: number
  h: number
}

/**
 * The rectangle a shader quad must cover: every point, padded by `pad` on each
 * side — the ribbon's radius plus its glow, so nothing the shader paints is cut
 * off at the quad's edge. `null` for an empty ribbon.
 */
export function flareBounds(pts: FlarePoints, pad: number): Box | null {
  if (pts.length < 2) return null
  let x0 = Infinity
  let y0 = Infinity
  let x1 = -Infinity
  let y1 = -Infinity
  for (let i = 0; i + 1 < pts.length; i += 2) {
    const x = pts[i]!
    const y = pts[i + 1]!
    if (x < x0) x0 = x
    if (x > x1) x1 = x
    if (y < y0) y0 = y
    if (y > y1) y1 = y
  }
  return { x: x0 - pad, y: y0 - pad, w: x1 - x0 + 2 * pad, h: y1 - y0 + 2 * pad }
}

/**
 * The points relative to `box`'s top-left, for the shader's `pts` uniform. Written
 * into `out` so a frame allocates nothing; `out` is the uniform's own array.
 */
export function toLocal(pts: FlarePoints, box: Box, out: Float32Array): void {
  const n = Math.min(pts.length, out.length)
  for (let i = 0; i + 1 < n; i += 2) {
    out[i] = pts[i]! - box.x
    out[i + 1] = pts[i + 1]! - box.y
  }
}

/**
 * How strongly to paint the flare, `0..1`, `elapsed` seconds after its start.
 *
 * - **telegraph** (`elapsed < telegraph`): a ghost that brightens toward
 *   `GHOST` — the loop is forming, and a player can see where it will be. It burns
 *   nobody (contact is `lit` only), so it must never look like the real thing.
 * - **lit**: `1`, from the first lit instant. No fade-in: the ribbon burns from
 *   that tick, and a fire that is still fading in is a fire you cannot see.
 * - **the burn's tail** (not lit, past the telegraph): `0` — the ribbon is gone
 *   while the scheduler still lists the effect (T22.08C F1).
 */
export const GHOST = 0.35
export function flareStrength(elapsed: number, telegraph: number, lit: boolean): number {
  if (lit) return 1
  if (elapsed < 0 || elapsed >= telegraph) return 0
  return GHOST * Math.min(1, Math.max(0, elapsed / telegraph))
}

/**
 * The outline of a ribbon of half-width `hw` around the centre line, as one closed
 * polygon `[x0, y0, …]` with round caps — for `Graphics.fillPoints`.
 *
 * **A polygon, not a thick stroke.** Phaser's WebGL `strokePoints` draws each segment
 * as its own quad, so a wide translucent stroke overlaps itself at every one of the
 * 47 joints and the corona came out as a fan of radial stripes (screenshotted). One
 * filled outline has no overlaps, on either renderer.
 *
 * Each side is the centre line pushed along its normal (the tangent averaged over the
 * two neighbouring segments); `capSteps` points round each end.
 */
export function ribbonOutline(pts: FlarePoints, hw: number, out: number[], capSteps = 8): void {
  out.length = 0
  const n = Math.floor(pts.length / 2)
  if (n < 2) return
  const nx: number[] = []
  const ny: number[] = []
  for (let i = 0; i < n; i++) {
    const a = Math.max(0, i - 1)
    const b = Math.min(n - 1, i + 1)
    const tx = pts[2 * b]! - pts[2 * a]!
    const ty = pts[2 * b + 1]! - pts[2 * a + 1]!
    const len = Math.hypot(tx, ty) || 1
    nx.push(-ty / len)
    ny.push(tx / len)
  }
  for (let i = 0; i < n; i++) out.push(pts[2 * i]! + nx[i]! * hw, pts[2 * i + 1]! + ny[i]! * hw)
  // A cap turns half a circle from `from`, the way that passes outside the line's
  // end: the far end from the left normal to the right, the near end back again.
  const cap = (i: number, from: number) => {
    for (let k = 1; k < capSteps; k++) {
      const a = from - (Math.PI * k) / capSteps
      out.push(pts[2 * i]! + Math.cos(a) * hw, pts[2 * i + 1]! + Math.sin(a) * hw)
    }
  }
  cap(n - 1, Math.atan2(ny[n - 1]!, nx[n - 1]!))
  for (let i = n - 1; i >= 0; i--) out.push(pts[2 * i]! - nx[i]! * hw, pts[2 * i + 1]! - ny[i]! * hw)
  cap(0, Math.atan2(ny[0]!, nx[0]!) + Math.PI)
}

/** Total length of the centre line, world px — the shader measures its noise in it. */
export function ribbonLength(pts: FlarePoints): number {
  let len = 0
  for (let i = 2; i + 1 < pts.length; i += 2) len += Math.hypot(pts[i]! - pts[i - 2]!, pts[i + 1]! - pts[i - 1]!)
  return len
}

/**
 * One Canvas stroke pass: a width in world px, a colour and an alpha.
 *
 * Widest and faintest first, so each pass lies over the one before: a dark-red
 * corona, an orange mantle, **the body** — `2 × ribbon`, the contact width, near
 * opaque, so every point that burns is painted — then a yellow core and a white
 * thread. The corona bands are filled outlines (`ribbonOutline`), never strokes. The Canvas path is the fallback (T21.33/T21.36): the same event in the
 * same place at the same width, not the shader's look.
 */
interface StrokePass {
  width: number
  color: number
  alpha: number
}
export function strokePasses(ribbon: number, glow: number): StrokePass[] {
  return [
    // Three corona bands narrowing as they brighten, so they stack into a gradient
    // rather than one flat sleeve.
    // Added, not painted (`flareFx.ts`), so these are light over the sky.
    // Narrow and bright: a wide dim band reads as a brown sleeve, whatever the blend.
    { width: 2 * (ribbon + glow * 0.55), color: 0xff5a18, alpha: 0.14 },
    { width: 2 * (ribbon + glow * 0.34), color: 0xff7020, alpha: 0.2 },
    { width: 2 * (ribbon + glow * 0.16), color: 0xff9038, alpha: 0.3 },
    { width: 2 * ribbon, color: 0xff6a14, alpha: 0.93 },
    { width: ribbon * 1.2, color: 0xffb040, alpha: 0.95 },
    { width: ribbon * 0.45, color: 0xfff0c8, alpha: 1 },
  ]
}

/**
 * A twisting strand for the Canvas path: the ribbon's centre line pushed sideways
 * by `amp × sin(k·u + ω·t + phase)` along its normal — the magnetic threads the
 * shader draws, in the fallback's terms. Returns the new points into `out`.
 */
export function strand(pts: FlarePoints, amp: number, phase: number, t: number, out: number[]): void {
  out.length = 0
  const n = pts.length / 2
  for (let i = 0; i < n; i++) {
    const a = Math.max(0, i - 1)
    const b = Math.min(n - 1, i + 1)
    const tx = pts[2 * b]! - pts[2 * a]!
    const ty = pts[2 * b + 1]! - pts[2 * a + 1]!
    const len = Math.hypot(tx, ty) || 1
    const u = i / Math.max(1, n - 1)
    // Pinned at the footpoints, where the loop meets the surface it rises from.
    const off = amp * Math.sin(Math.PI * u) * Math.sin(18 * u + 2.3 * t + phase)
    out.push(pts[2 * i]! - (ty / len) * off, pts[2 * i + 1]! + (tx / len) * off)
  }
}

/**
 * Who is burning, as the client can know it (`R80`: not on the wire).
 *
 * **Contact proposes, the server confirms** (T22.08D F3). The core's contact test —
 * the server's rule, `flare_touches` — is asked about each drawn body every lit
 * frame, but on the client's copy of the positions: predicted for you, interpolated
 * for everyone else. Those can disagree with the server's for a whole burn, so a
 * touch is **provisional**: it writes `now + burn` (rewritten, never added to — `R79`,
 * `poison()`'s rule) and a deadline `confirmWithin` out. **Evidence** — a `weather`
 * `damage` to you, a health drop in the snapshot for anyone else — confirms it and
 * keeps the flames lit `confirmWithin` past each word. Unconfirmed by the deadline,
 * the flames go out, and contact alone does not relight them for one `burn`: a body
 * the client wrongly thinks is in the ribbon would otherwise flicker on and off for
 * as long as it stood there. Evidence with **no** touch lights them only when the
 * caller says the evidence cannot be anything else's (`start`): yours, not a
 * remote's health drop, which a bullet also causes. A death clears it, as `die()`
 * does on the server. Keyed by player id; `now` is the flare's server clock.
 */
export class BurnTracker {
  private readonly runs = new Map<number, { until: number; confirmBy: number | null; quietUntil: number }>()

  /** The client's contact test says `id` is in the ribbon. */
  touch(id: number, now: number, burn: number, confirmWithin: number): void {
    const r = this.runs.get(id)
    if (r && now < r.quietUntil) return
    if (r && now < r.until) {
      r.until = Math.max(r.until, now + burn)
      return
    }
    this.runs.set(id, { until: now + burn, confirmBy: now + confirmWithin, quietUntil: 0 })
  }

  /**
   * The server says `id` is burning. Confirms a provisional burn; with `start`,
   * lights one with no touch at all.
   */
  confirm(id: number, now: number, confirmWithin: number, start: boolean): void {
    const r = this.runs.get(id)
    if (r && now < r.until) {
      r.confirmBy = null
      r.until = Math.max(r.until, now + confirmWithin)
      return
    }
    if (start) this.runs.set(id, { until: now + confirmWithin, confirmBy: null, quietUntil: 0 })
  }

  burning(id: number, now: number): boolean {
    const r = this.runs.get(id)
    if (!r) return false
    if (r.confirmBy !== null && now >= r.confirmBy) {
      // Refuted: the server never said so. Out, and contact alone stays quiet until
      // the burn it proposed would have ended.
      r.quietUntil = r.until
      r.until = 0
      r.confirmBy = null
    }
    return now < r.until
  }

  /** Seconds of burn left, `0` when not burning. */
  left(id: number, now: number): number {
    return this.burning(id, now) ? this.runs.get(id)!.until - now : 0
  }

  clear(id: number): void {
    this.runs.delete(id)
  }

  clearAll(): void {
    this.runs.clear()
  }
}
