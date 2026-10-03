/**
 * T23.43 — the foreground leaves as **tiny dark flecks drifting across the screen**, in place of T23.08B's big
 * out-of-focus clusters. The owner, seeing a cluster as a blurry dark clump mid-screen: *"you can make them really
 * small like the fire dots on the lava level."* So this is `embers.ts`'s field with leaves in it: a world-anchored,
 * seeded field, a pure function of (seed, view, time) — cells of `FLECK_CELL` world px each hold `FLECK_PER_CELL`
 * flecks at hashed places, each carried `FLECK_TRAVEL` px on a slow breeze (sideways, sinking a little, swaying and
 * turning over) and faded in and out over that trip, so a pan shows the same flecks, every client of a round sees
 * the same ones, and nothing is kept between frames. A 1280 × 720 view holds about three dozen.
 *
 * Classic maps only: the volcanic world keeps its embers (`gameDescription`'s `leafFlecks`), space has neither.
 * Drawn after the actors and **under every effect** (`FG_ORDER`, T23.41's order — a fleck never sits on a fire), and
 * faded to `FG_ALPHA_OVER_PLAYER` over a player's box as the clusters were. **Cosmetic**: nothing reads it.
 */
import { AddEquation, BufferAttribute, BufferGeometry, CustomBlending, Mesh, OneFactor, OneMinusSrcAlphaFactor, OrthographicCamera, ShaderMaterial } from 'three'
import type { WebGLRenderer, WebGLRenderTarget } from 'three'
import { FG_ALPHA_OVER_PLAYER, FG_FADE_PX, FG_ORDER } from './atmosphere'
import type { Box, ViewRect } from './scene'
import { toWorld } from './worldRenderer-math'

/** World px a field cell spans (square), and flecks per cell: ~36 in a 1280 × 720 view (`(1280·720 / 320²) · 4`). */
export const FLECK_CELL = 320
export const FLECK_PER_CELL = 4
/**
 * A fleck's length, mask px, `[min, max]` — the embers' cores are 1.3–4.4 px inside a 16-px glow; a dark leaf has no
 * glow to be seen by, and at 2.5–5 px it vanished on the checks' half-resolution tier (one dot in the whole sky of
 * `shots/leaves-flecks.png`), so it is drawn about the size of an ember's core and glow together.
 */
export const FLECK_LEN: readonly [number, number] = [3.5, 7]
/** Its width as a share of its length (a leaf, not a dot). */
export const FLECK_THIN = 0.45
/** The longest a fleck can be on screen, mask px — what the `leaves` check bounds every speck by. */
export const FLECK_MAX_PX = FLECK_LEN[1]
/** How far a fleck travels over its life, px, and the breeze: sideways px/s (the slowest; each adds up to the same again). */
export const FLECK_TRAVEL = 360
export const FLECK_DRIFT = 11
/** How far it sinks per px it drifts, its sway (px) and the sway's rate (rad/s), its turn-over rate (rad/s, up to). */
const FLECK_SINK = 0.35
const FLECK_SWAY = 7
const FLECK_SWAY_RATE = 1.3
const FLECK_SPIN = 1.6
/** Its opacity at the middle of its trip, and its colour: F1's leaf tint (`scenes/F1.ts` `fg.tint`), near-black. */
export const FLECK_ALPHA = 0.85
export const FLECK_TINT: readonly [number, number, number] = [0.005, 0.004, 0.008]
/** Steps per second the field is redrawn at (a moved fleck ends the renderer's redraw skip at most this often). */
export const FLECK_HZ = 30
/** Half a fleck's quad, px: its longest half-length and a pixel of edge. */
const QUAD = FLECK_MAX_PX / 2 + 1

/** One fleck: centre (mask px), length, angle (rad), opacity share (its fade in and out). */
export interface Fleck {
  x: number
  y: number
  len: number
  angle: number
  a: number
}

/** A small integer hash to [0, 1) (render-only; the simulation's RNG rule is game-core's). */
function h01(x: number, y: number, s: number, seed: number): number {
  let h = (Math.imul(x, 374761393) + Math.imul(y, 668265263) + Math.imul(s, 144665) + Math.imul(seed | 0, 1442695041)) | 0
  h = Math.imul(h ^ (h >>> 13), 1274126177)
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296
}

/** Fleck `k` of field cell (`cx`, `cy`) at `seconds` — where it is on its trip, how long, which way it faces. */
export function fleckAt(seed: number, cx: number, cy: number, k: number, seconds: number): Fleck {
  const r = (j: number): number => h01(cx, cy, k * 8 + j, seed)
  const speed = FLECK_DRIFT * (1 + r(3))
  const u = (seconds / (FLECK_TRAVEL / speed) + r(2)) % 1
  const along = u * FLECK_TRAVEL
  const sway = FLECK_SWAY * Math.sin(seconds * FLECK_SWAY_RATE * (0.7 + 0.6 * r(6)) + r(7) * 6.283)
  return {
    x: (cx + r(0)) * FLECK_CELL + along,
    y: (cy + r(1)) * FLECK_CELL + along * FLECK_SINK + sway,
    len: FLECK_LEN[0] + (FLECK_LEN[1] - FLECK_LEN[0]) * r(4),
    angle: r(5) * 6.283 + seconds * FLECK_SPIN * (r(6) - 0.5) * 2,
    a: Math.sin(Math.PI * u),
  }
}

/** The map's flecks in `view` (mask px) at `seconds`: every cell a trip could carry one in from, culled to the view. */
export function leafFlecks(seed: number, view: ViewRect, seconds: number): Fleck[] {
  const out: Fleck[] = []
  const reach = FLECK_TRAVEL + FLECK_SWAY
  const cx0 = Math.floor((view.x - reach) / FLECK_CELL) - 1
  const cx1 = Math.floor((view.x + view.w) / FLECK_CELL) + 1
  const cy0 = Math.floor((view.y - reach * FLECK_SINK) / FLECK_CELL) - 1
  const cy1 = Math.floor((view.y + view.h + FLECK_SWAY) / FLECK_CELL) + 1
  for (let cy = cy0; cy <= cy1; cy++) {
    for (let cx = cx0; cx <= cx1; cx++) {
      for (let k = 0; k < FLECK_PER_CELL; k++) {
        const f = fleckAt(seed, cx, cy, k, seconds)
        if (f.x < view.x - QUAD || f.x > view.x + view.w + QUAD || f.y < view.y - QUAD || f.y > view.y + view.h + QUAD) continue
        out.push(f)
      }
    }
  }
  return out
}

/** A fleck's opacity at (x, y): `FLECK_ALPHA` × its fade, eased to `FG_ALPHA_OVER_PLAYER` over every player box. */
export function fleckAlpha(f: Fleck, occluders: readonly Box[]): number {
  let a = FLECK_ALPHA * f.a
  for (const b of occluders) {
    const dx = Math.max(b[0] - f.x, f.x - b[2], 0)
    const dy = Math.max(b[1] - f.y, f.y - b[3], 0)
    const t = Math.min(1, Math.hypot(dx, dy) / FG_FADE_PX)
    a = Math.min(a, FLECK_ALPHA * f.a * (FG_ALPHA_OVER_PLAYER + (1 - FG_ALPHA_OVER_PLAYER) * t * t * (3 - 2 * t)))
  }
  return a
}

const VS = /* glsl */ `
attribute vec2 aLocal; attribute vec2 aParam;
varying vec2 vLocal; varying vec2 vParam;
void main(){ vLocal = aLocal; vParam = aParam; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.); }`

// vLocal: px along / across the fleck. vParam: length, alpha. A leaf: an ellipse `len × len·THIN`, one px of soft edge.
const FS = /* glsl */ `
uniform vec3 tint;
varying vec2 vLocal; varying vec2 vParam;
void main(){
  vec2 r = vec2(vParam.x * 0.5, vParam.x * 0.5 * ${FLECK_THIN});
  float d = (length(vLocal / r) - 1.) * r.y;
  float a = smoothstep(0.5, -0.5, d) * vParam.y;
  if (a <= 0.) discard;
  gl_FragColor = vec4(tint * a, a);
}`

const FLOATS = { position: 3, aLocal: 2, aParam: 2 } as const
type AttrName = keyof typeof FLOATS

/** The flecks drawn: one quad each, premultiplied over (the ink darkens what is behind it), at `FG_ORDER`. */
export class FleckLayer {
  readonly mesh: Mesh
  private readonly geometry = new BufferGeometry()
  private readonly material: ShaderMaterial
  private capacity = 0
  /** Dev: what the last `place` drew — each fleck's centre and length (mask px) — and the boxes it faded over. */
  drawn: { x: number; y: number; len: number }[] = []
  occluders: Box[] = []

  constructor() {
    this.material = new ShaderMaterial({
      name: 'leafFlecks',
      uniforms: { tint: { value: [...FLECK_TINT] } },
      vertexShader: VS,
      fragmentShader: FS,
      transparent: true,
      blending: CustomBlending,
      blendEquation: AddEquation,
      blendSrc: OneFactor,
      blendDst: OneMinusSrcAlphaFactor,
      depthTest: false,
      depthWrite: false,
    })
    this.mesh = new Mesh(this.geometry, this.material)
    this.mesh.frustumCulled = false
    this.mesh.renderOrder = FG_ORDER
    this.mesh.visible = false
    this.grow(64)
  }

  private grow(n: number): void {
    this.capacity = n
    for (const [k, size] of Object.entries(FLOATS) as [AttrName, number][]) {
      this.geometry.setAttribute(k, new BufferAttribute(new Float32Array(n * 4 * size), size))
    }
    const idx = new Uint32Array(n * 6)
    // As `fireflyLayer.ts`: clockwise in mask px is anticlockwise once y is flipped up.
    for (let i = 0; i < n; i++) idx.set([i * 4, i * 4 + 2, i * 4 + 1, i * 4, i * 4 + 3, i * 4 + 2], i * 6)
    this.geometry.setIndex(new BufferAttribute(idx, 1))
  }

  /** Lay out `flecks` (mask px), faded over `occluders`; `maskH` for the y flip. An empty list hides the layer. */
  place(flecks: readonly Fleck[], occluders: readonly Box[], maskH: number): void {
    if (flecks.length > this.capacity) this.grow(Math.max(flecks.length, this.capacity * 2))
    const at = (k: AttrName): Float32Array => (this.geometry.getAttribute(k) as BufferAttribute).array as Float32Array
    const pos = at('position')
    const loc = at('aLocal')
    const par = at('aParam')
    let n = 0
    this.drawn = []
    for (const f of flecks) {
      const a = fleckAlpha(f, occluders)
      if (!(a > 0)) continue
      this.drawn.push({ x: f.x, y: f.y, len: f.len })
      const c = Math.cos(f.angle)
      const s = Math.sin(f.angle)
      for (let k = 0; k < 4; k++) {
        const u = (k === 1 || k === 2 ? 1 : -1) * QUAD
        const v = (k >= 2 ? 1 : -1) * QUAD
        const i = n * 4 + k
        const w = toWorld(f.x + u * c - v * s, f.y + u * s + v * c, maskH)
        pos[i * 3] = w.x
        pos[i * 3 + 1] = w.y
        pos[i * 3 + 2] = 0
        loc[i * 2] = u
        loc[i * 2 + 1] = v
        par[i * 2] = f.len
        par[i * 2 + 1] = a
      }
      n++
    }
    for (const k of Object.keys(FLOATS)) (this.geometry.getAttribute(k) as BufferAttribute).needsUpdate = true
    this.geometry.setDrawRange(0, n * 6)
    this.occluders = occluders.map((b) => [...b] as Box)
    this.mesh.visible = n > 0
  }

  /** Build the program at scene start, as `fireflyLayer.ts::warm` does — an empty draw into 1 px of `target`. */
  warm(r: WebGLRenderer, target: WebGLRenderTarget): void {
    const prev = r.getRenderTarget()
    const autoClear = r.autoClear
    const vis = this.mesh.visible
    const range = { ...this.geometry.drawRange }
    r.autoClear = false
    target.scissor.set(0, 0, 1, 1)
    target.scissorTest = true
    r.setRenderTarget(target)
    this.mesh.visible = true
    this.geometry.setDrawRange(0, 0)
    r.render(this.mesh, new OrthographicCamera(0, 1, 1, 0, -1, 1))
    this.geometry.setDrawRange(range.start, range.count)
    this.mesh.visible = vis
    target.scissor.set(0, 0, target.width, target.height)
    target.scissorTest = false
    r.setRenderTarget(prev)
    r.autoClear = autoClear
  }

  dispose(): void {
    this.geometry.dispose()
    this.material.dispose()
  }
}
