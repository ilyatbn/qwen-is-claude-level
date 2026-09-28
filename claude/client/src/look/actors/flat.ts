/**
 * T23.12: a 2D context whose broken curves are straight lines — `roundRect`, `ellipse`, a partial `arc` and a
 * **stroked** whole circle are flattened to `lineTo`s fine enough (`FLAT_TOLERANCE` px on screen) that the picture
 * is the same; a **filled** whole circle and `quadraticCurveTo` stay the context's own (both draw right on the GPU
 * below, and flattening them costs Level A: F4's actor boxes 0.125 → 0.167 mean ΔE on SwiftShader, measured —
 * the rasteriser anti-aliases a polygon's edge a little differently from its own curve's).
 *
 * Why: **on the owner's GPU, Chrome's accelerated canvas draws curved paths wrong.** Measured on the owner's
 * machine (headed Chrome, `GALLIUM_DRIVER=d3d12`, D3D12 Intel Arc B390 — `make play`'s configuration): a filled
 * `roundRect` comes out as a bow-tie at every scale (1.15×, 1.8×, 3.45×; `arcTo` and `arc`-built rounded rects
 * too), a half-ellipse closed by two lines (the beetle's back) as a thin strip, a stroked `arc` (the gate's ring)
 * not at all. Straight-edged paths and whole circles draw correctly there, and the same flattened paths draw
 * correctly on it (checked: a 16-segment rounded rect). SwiftShader and the CPU rasteriser draw both right, so
 * nothing on the checks' back end could have shown it — only a look at the GPU's frame did.
 *
 * Canvas transforms a path's points by the transform current **when each call is made**, so emitting the flattened
 * points at call time, through the same context, is the same path — the flattening only needs the transform's
 * scale to pick a segment count.
 */

/** The 2D context calls the cast's drawing makes (`draw.ts`) — a real context satisfies it, and so does `Flat`. */
export interface G {
  fillStyle: string | CanvasGradient | CanvasPattern
  strokeStyle: string | CanvasGradient | CanvasPattern
  lineWidth: number
  lineCap: CanvasLineCap
  lineJoin: CanvasLineJoin
  globalAlpha: number
  globalCompositeOperation: GlobalCompositeOperation
  save(): void
  restore(): void
  translate(x: number, y: number): void
  rotate(a: number): void
  scale(x: number, y: number): void
  beginPath(): void
  closePath(): void
  moveTo(x: number, y: number): void
  lineTo(x: number, y: number): void
  quadraticCurveTo(cx: number, cy: number, x: number, y: number): void
  arc(x: number, y: number, r: number, a0: number, a1: number, ccw?: boolean): void
  ellipse(x: number, y: number, rx: number, ry: number, rot: number, a0: number, a1: number, ccw?: boolean): void
  roundRect(x: number, y: number, w: number, h: number, r: number): void
  rect(x: number, y: number, w: number, h: number): void
  fill(): void
  stroke(): void
  clip(): void
  fillRect(x: number, y: number, w: number, h: number): void
  createRadialGradient(x0: number, y0: number, r0: number, x1: number, y1: number, r1: number): CanvasGradient
  createLinearGradient(x0: number, y0: number, x1: number, y1: number): CanvasGradient
  /** T23.19: a pickup's label (`draw.ts::label`) — text is the context's own. */
  font: string
  textAlign: CanvasTextAlign
  textBaseline: CanvasTextBaseline
  fillText(text: string, x: number, y: number): void
  measureText(text: string): TextMetrics
}

/** The largest distance, screen px, between a curve and the lines that replace it. */
export const FLAT_TOLERANCE = 0.05

const TAU = Math.PI * 2

/** Canvas's sweep for `arc`/`ellipse` from a0 to a1 (the spec's: a full turn at most, signed by direction). */
export function sweep(a0: number, a1: number, ccw: boolean): number {
  if (!ccw && a1 - a0 >= TAU) return TAU
  if (ccw && a0 - a1 >= TAU) return -TAU
  let d = (a1 - a0) % TAU
  if (!ccw && d < 0) d += TAU
  if (ccw && d > 0) d -= TAU
  return d
}

/** Segments for a sweep of `angle` on radius `r` screen px so the chord's sagitta stays under the tolerance. */
export function segments(angle: number, r: number): number {
  if (r <= FLAT_TOLERANCE) return 1
  const step = 2 * Math.acos(1 - FLAT_TOLERANCE / r)
  return Math.max(1, Math.min(512, Math.ceil(Math.abs(angle) / step)))
}

export class Flat implements G {
  private cur: [number, number] | null = null
  private start: [number, number] | null = null
  /** Whole circles in the current path drawn as the context's own arcs, and whether anything else is in it. */
  private circles: [number, number, number, number, number, boolean][] = []
  private other = false

  constructor(readonly g: CanvasRenderingContext2D) {}

  get fillStyle(): string | CanvasGradient | CanvasPattern {
    return this.g.fillStyle
  }
  set fillStyle(v: string | CanvasGradient | CanvasPattern) {
    this.g.fillStyle = v
  }
  get strokeStyle(): string | CanvasGradient | CanvasPattern {
    return this.g.strokeStyle
  }
  set strokeStyle(v: string | CanvasGradient | CanvasPattern) {
    this.g.strokeStyle = v
  }
  get lineWidth(): number {
    return this.g.lineWidth
  }
  set lineWidth(v: number) {
    this.g.lineWidth = v
  }
  get lineCap(): CanvasLineCap {
    return this.g.lineCap
  }
  set lineCap(v: CanvasLineCap) {
    this.g.lineCap = v
  }
  get lineJoin(): CanvasLineJoin {
    return this.g.lineJoin
  }
  set lineJoin(v: CanvasLineJoin) {
    this.g.lineJoin = v
  }
  get globalAlpha(): number {
    return this.g.globalAlpha
  }
  set globalAlpha(v: number) {
    this.g.globalAlpha = v
  }
  get globalCompositeOperation(): GlobalCompositeOperation {
    return this.g.globalCompositeOperation
  }
  set globalCompositeOperation(v: GlobalCompositeOperation) {
    this.g.globalCompositeOperation = v
  }

  save(): void {
    this.g.save()
  }
  restore(): void {
    this.g.restore()
  }
  translate(x: number, y: number): void {
    this.g.translate(x, y)
  }
  rotate(a: number): void {
    this.g.rotate(a)
  }
  scale(x: number, y: number): void {
    this.g.scale(x, y)
  }
  beginPath(): void {
    this.g.beginPath()
    this.cur = this.start = null
    this.circles = []
    this.other = false
  }
  closePath(): void {
    this.g.closePath()
    this.cur = this.start
  }
  moveTo(x: number, y: number): void {
    this.other = true
    this.g.moveTo(x, y)
    this.cur = this.start = [x, y]
  }
  lineTo(x: number, y: number): void {
    if (!this.cur) return this.moveTo(x, y)
    this.other = true
    this.g.lineTo(x, y)
    this.cur = [x, y]
  }
  rect(x: number, y: number, w: number, h: number): void {
    this.other = true
    this.g.rect(x, y, w, h)
    this.cur = this.start = [x, y]
  }
  fill(): void {
    this.g.fill()
  }
  stroke(): void {
    if (this.circles.length && !this.other) {
      // A path of whole circles, stroked: the GPU drops the context's own (the gate's ring) — flatten it.
      const cs = this.circles
      this.beginPath()
      for (const [x, y, r, a0, a1, ccw] of cs) {
        this.cur = null
        this.ellipse(x, y, r, r, 0, a0, a1, ccw)
      }
    }
    this.g.stroke()
  }
  clip(): void {
    this.g.clip()
  }
  fillRect(x: number, y: number, w: number, h: number): void {
    this.g.fillRect(x, y, w, h)
  }
  createRadialGradient(x0: number, y0: number, r0: number, x1: number, y1: number, r1: number): CanvasGradient {
    return this.g.createRadialGradient(x0, y0, r0, x1, y1, r1)
  }
  createLinearGradient(x0: number, y0: number, x1: number, y1: number): CanvasGradient {
    return this.g.createLinearGradient(x0, y0, x1, y1)
  }
  get font(): string {
    return this.g.font
  }
  set font(v: string) {
    this.g.font = v
  }
  get textAlign(): CanvasTextAlign {
    return this.g.textAlign
  }
  set textAlign(v: CanvasTextAlign) {
    this.g.textAlign = v
  }
  get textBaseline(): CanvasTextBaseline {
    return this.g.textBaseline
  }
  set textBaseline(v: CanvasTextBaseline) {
    this.g.textBaseline = v
  }
  fillText(text: string, x: number, y: number): void {
    this.g.fillText(text, x, y)
  }
  measureText(text: string): TextMetrics {
    return this.g.measureText(text)
  }

  /** The transform's scale: screen px per unit along its larger axis. */
  private pxPerUnit(): number {
    const m = this.g.getTransform()
    return Math.max(Math.hypot(m.a, m.b), Math.hypot(m.c, m.d))
  }

  arc(x: number, y: number, r: number, a0: number, a1: number, ccw = false): void {
    if (Math.abs(sweep(a0, a1, ccw)) === TAU && !this.cur) {
      // A whole circle starting its own subpath: the context's own, unless the path is stroked (`stroke`).
      this.g.arc(x, y, r, a0, a1, ccw)
      this.circles.push([x, y, r, a0, a1, ccw])
      this.cur = this.start = [x + r * Math.cos(a1), y + r * Math.sin(a1)]
      return
    }
    this.other = true
    this.ellipse(x, y, r, r, 0, a0, a1, ccw)
  }

  ellipse(x: number, y: number, rx: number, ry: number, rot: number, a0: number, a1: number, ccw = false): void {
    const sw = sweep(a0, a1, ccw)
    const n = segments(sw, Math.max(rx, ry) * this.pxPerUnit())
    const cr = Math.cos(rot)
    const sr = Math.sin(rot)
    for (let k = 0; k <= n; k++) {
      const a = a0 + (sw * k) / n
      const ex = rx * Math.cos(a)
      const ey = ry * Math.sin(a)
      const px = x + ex * cr - ey * sr
      const py = y + ex * sr + ey * cr
      // The spec: an arc joins the current point with a line, or starts the subpath.
      if (k === 0 && !this.cur) this.moveTo(px, py)
      else this.lineTo(px, py)
    }
  }

  quadraticCurveTo(cx: number, cy: number, x: number, y: number): void {
    if (!this.cur) this.moveTo(cx, cy)
    this.other = true
    this.g.quadraticCurveTo(cx, cy, x, y)
    this.cur = [x, y]
  }

  /** `roundRect` with one radius (the only form the cast uses), as the spec builds it: clockwise from top-left. */
  roundRect(x: number, y: number, w: number, h: number, r: number): void {
    const q = Math.PI / 2
    this.moveTo(x + r, y)
    this.lineTo(x + w - r, y)
    this.ellipse(x + w - r, y + r, r, r, 0, -q, 0)
    this.lineTo(x + w, y + h - r)
    this.ellipse(x + w - r, y + h - r, r, r, 0, 0, q)
    this.lineTo(x + r, y + h)
    this.ellipse(x + r, y + h - r, r, r, 0, q, 2 * q)
    this.lineTo(x, y + r)
    this.ellipse(x + r, y + r, r, r, 0, 2 * q, 3 * q)
    this.closePath()
    // The spec leaves the current point at the start (a new subpath there).
    this.moveTo(x, y)
  }
}
