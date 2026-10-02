/**
 * T23.31 (docs/78 §A7): the volcanic world's **distant painted layer** — the owner's background idea
 * (`mapideas/volcanic.jpg`, `volcanic2.jpg`): a smoking volcano with glowing lava rivers down its flanks and an ash
 * plume rising from the crater, two lesser peaks beside it, ringed planets in the dark sky, red mist along the
 * horizon. **Painted by code** (R12) into two Canvas2D textures once per map (seeded: the river courses, the plume's
 * puffs, where the volcano stands), drawn between the sky (renderOrder −10) and the back fog (−5), so F2's back fog
 * reddens its foot as it does the sky's ranges.
 *
 * Two parallax bands, like the sky's (`skyLayout.ts`): the planets at `PLANET_PARALLAX` (all but fixed, as the
 * moons), the volcano, its plume and mist at `VOLCANO_PARALLAX` — farther than the sky's nearest ranges, nearer than
 * its gradient. Placed in the pictures' 1280 × 720 frame at zoom 1 (R6), as the sky: the volcano's foot on the
 * look's horizon line.
 *
 * **HDR:** the colour canvas is sRGB, decoded to linear in the shader; the lava is a second canvas (a mask) added as
 * `LAVA` × the mask, above 1 where it is hottest — so the rivers bloom, as F2's seams do. Static (no clock): the
 * redraw skip stands.
 */
import { CanvasTexture, LinearFilter, Mesh, PlaneGeometry, ShaderMaterial, SRGBColorSpace, NoColorSpace, Vector2, Vector3, Vector4 } from 'three'
import type { ViewRect } from './scene'
import { rng } from './skyLayout'

/** The volcano band's canvas, frame px: wide enough for the volcano, its two side peaks and the mist. */
export const VOLCANO_W = 1500
export const VOLCANO_H = 820
/** The planets' canvas, frame px: the upper sky. */
export const PLANETS_W = 1280
export const PLANETS_H = 330
/** Parallax factors (`skyLayout.ts::LAYER_PARALLAX`'s scale): the planets as far as the moons, the volcano past the ranges. */
export const PLANET_PARALLAX = 0.01
export const VOLCANO_PARALLAX = 0.03
/** The lava's emission at a river's core, linear — F2's seams' hue (`lava` [1.6, 0.45, 0.08] × `lavaK` 0.6) a little dimmer: it is far away. */
export const LAVA: [number, number, number] = [1.5, 0.42, 0.075]

/** The painted colours by the volcanic day (`t` 0), × linear — the dusky red day lifts the far shapes; night is 1. */
export const DAY_TINT: [number, number, number] = [1.9, 1.45, 1.3]

type G = CanvasRenderingContext2D

/** The volcano band's two canvases — colour (sRGB, alpha) and lava (white = hottest) — for map seed `seed`. */
export function paintVolcano(seed: number): { colour: HTMLCanvasElement; lava: HTMLCanvasElement } {
  const r = rng(seed ^ 0x701c)
  const colour = canvas(VOLCANO_W, VOLCANO_H)
  const lava = canvas(VOLCANO_W, VOLCANO_H)
  const g = colour.getContext('2d') as G
  const l = lava.getContext('2d') as G
  const foot = VOLCANO_H - 140 // the horizon line in band px; the mist covers the band below it
  const cx = VOLCANO_W / 2
  // Two lesser peaks behind, lighter with distance (volcanic.jpg's shoulders).
  peak(g, r, cx - 330, foot, 300, 250, '#2a1613', '#1c0f0d')
  peak(g, r, cx + 300, foot, 260, 210, '#26140f', '#1a0e0c')
  // The plume first, so the cone's crater cuts into its root.
  const apexY = foot - 330
  plume(g, r, cx, apexY)
  // The cone: a jagged, slightly concave profile with a notched crater.
  const crater = 46
  const left: [number, number][] = []
  const right: [number, number][] = []
  const N = 22
  for (let i = 0; i <= N; i++) {
    const t = i / N
    const y = apexY + t * (foot - apexY)
    const half = crater / 2 + (Math.pow(t, 1.35) * 440 + t * 30) + (i > 0 && i < N ? (r() - 0.5) * 18 : 0)
    left.push([cx - half, y])
    right.push([cx + half, y])
  }
  g.beginPath()
  g.moveTo(cx - crater / 2 - 4, apexY + 6)
  g.lineTo(cx - 10, apexY + 16)
  g.lineTo(cx + 12, apexY + 12)
  g.lineTo(cx + crater / 2 + 4, apexY + 4)
  for (const p of right) g.lineTo(...p)
  for (let i = left.length - 1; i >= 0; i--) g.lineTo(...left[i]!)
  g.closePath()
  const body = g.createLinearGradient(0, apexY, 0, foot)
  body.addColorStop(0, '#4a2018')
  body.addColorStop(0.5, '#351711')
  body.addColorStop(1, '#22100c')
  g.fillStyle = body
  g.fill()
  // Faces: the left flank catches the plume's red glow, the right is in shadow; gullies run down both.
  g.save()
  g.clip()
  const shade = g.createLinearGradient(cx - 450, 0, cx + 450, 0)
  shade.addColorStop(0, 'rgba(90,36,24,0.35)')
  shade.addColorStop(0.45, 'rgba(60,24,18,0.15)')
  shade.addColorStop(0.55, 'rgba(0,0,0,0.25)')
  shade.addColorStop(1, 'rgba(0,0,0,0.45)')
  g.fillStyle = shade
  g.fillRect(0, 0, VOLCANO_W, VOLCANO_H)
  g.lineCap = 'round'
  for (let k = 0; k < 26; k++) {
    const side = k % 2 ? 1 : -1
    const x0 = cx + side * (crater / 2 + r() * 60)
    const len = 0.45 + r() * 0.5
    g.strokeStyle = side < 0 ? `rgba(80,34,24,${0.25 + r() * 0.2})` : `rgba(8,3,2,${0.3 + r() * 0.25})`
    g.lineWidth = 2 + r() * 5
    gully(g, r, x0, apexY + 14, side, len, foot - apexY)
  }
  g.restore()
  // The lava rivers: from the crater's lip down the flanks, meandering, branching once or twice; each also drawn in
  // the colour canvas as a hot core so it reads before the bloom does.
  l.lineCap = l.lineJoin = 'round'
  g.lineCap = g.lineJoin = 'round'
  const rivers = 4
  for (let k = 0; k < rivers; k++) {
    const side = k % 2 ? 1 : -1
    // Two from the crater's lip, two breaking out lower on the flanks (volcanic2.jpg's), inside the cone's outline.
    const t0 = k < 2 ? 0 : 0.12 + r() * 0.2
    const half = crater / 2 + Math.pow(t0, 1.35) * 440 + t0 * 30
    const start: [number, number] = [cx + side * (6 + r() * (half * 0.6)), apexY + 12 + t0 * (foot - apexY) + r() * 10]
    river(l, g, r, start, side, (foot - apexY) * (0.4 + r() * 0.35), 0)
  }
  // Glow where the rivers reach the plain, and the crater's own.
  for (const [x, y, rad, a] of [
    [cx, apexY + 14, 30, 0.22],
  ] as const) {
    const gr = l.createRadialGradient(x, y, 0, x, y, rad)
    gr.addColorStop(0, `rgba(255,255,255,${a})`)
    gr.addColorStop(1, 'rgba(255,255,255,0)')
    l.fillStyle = gr
    l.fillRect(x - rad, y - rad, rad * 2, rad * 2)
  }
  mist(g, r, foot)
  return { colour, lava }
}

/** The planets' canvas: a large ringed planet and a smaller one (volcanic.jpg), dark discs with a lit rim. */
export function paintPlanets(seed: number): HTMLCanvasElement {
  const r = rng(seed ^ 0x9a3e)
  const c = canvas(PLANETS_W, PLANETS_H)
  const g = c.getContext('2d') as G
  const big = r() < 0.5
  ringed(g, big ? 250 : 1010, 150 + r() * 40, 58, -0.28 + r() * 0.1, r)
  ringed(g, big ? 1000 : 300, 90 + r() * 40, 34, 0.32 - r() * 0.1, r)
  return c
}

function canvas(w: number, h: number): HTMLCanvasElement {
  const c = document.createElement('canvas')
  c.width = w
  c.height = h
  return c
}

function peak(g: G, r: () => number, x: number, foot: number, half: number, h: number, top: string, bottom: string): void {
  g.beginPath()
  g.moveTo(x - half, foot)
  const n = 9
  for (let i = 1; i < n; i++) {
    const t = i / n
    const up = 1 - Math.abs(t - 0.5) * 2
    g.lineTo(x - half + t * 2 * half + (r() - 0.5) * 20, foot - h * Math.pow(up, 0.8) + (r() - 0.5) * 16)
  }
  g.lineTo(x + half, foot)
  g.closePath()
  const gr = g.createLinearGradient(0, foot - h, 0, foot)
  gr.addColorStop(0, top)
  gr.addColorStop(1, bottom)
  g.fillStyle = gr
  g.fill()
}

function gully(g: G, r: () => number, x0: number, y0: number, side: number, len: number, height: number): void {
  g.beginPath()
  g.moveTo(x0, y0)
  let x = x0
  let y = y0
  const steps = 12
  for (let i = 0; i < steps; i++) {
    y += (height * len) / steps
    x += side * (8 + r() * 22) * (0.6 + i / steps)
    g.lineTo(x, y)
  }
  g.stroke()
}

function river(l: G, g: G, r: () => number, start: [number, number], side: number, drop: number, depth: number): void {
  // A course down the flank: it leaves the crater steeply, swings out across the slope as it falls (the cone widens),
  // meanders, and thins toward its end — volcanic2.jpg's rivers. Each segment is drawn at its own width.
  const pts: [number, number][] = [start]
  let [x, y] = start
  const steps = 22
  let drift = 0
  const phase = r() * 6.28
  for (let i = 0; i < steps; i++) {
    const t = i / steps
    // A slope that steepens out as the cone widens, wandering about it, with a meander on top — never a ruled line.
    drift += (r() - 0.5) * 0.7
    drift = Math.max(-1.1, Math.min(1.1, drift))
    y += drop / steps
    x += (side * (0.35 + 0.9 * t) + drift * 0.6) * (drop / steps) + Math.sin(i * 0.9 + phase) * 3.5
    pts.push([x, y])
  }
  const w0 = (3.2 - depth * 1.1) * (0.8 + r() * 0.4)
  for (let i = 1; i < pts.length; i++) {
    const t = i / pts.length
    const w = Math.max(0.6, w0 * (1 - 0.65 * t))
    const seg = (c: G, width: number, style: string): void => {
      c.strokeStyle = style
      c.lineWidth = width
      c.beginPath()
      c.moveTo(...pts[i - 1]!)
      c.lineTo(...pts[i]!)
      c.stroke()
    }
    seg(l, w + 2.5, 'rgba(255,255,255,0.18)')
    seg(l, w, `rgba(255,255,255,${0.9 - 0.45 * t})`)
    seg(g, w, 'rgba(190,80,36,0.9)')
  }
  if (depth < 2) {
    const n = depth === 0 ? 2 : 1
    for (let k = 0; k < n; k++) {
      if (r() > 0.75) continue
      const at = pts[5 + Math.floor(r() * 10)]!
      river(l, g, r, [at[0], at[1]], r() < 0.6 ? side : -side, drop * (0.3 + r() * 0.3), depth + 1)
    }
  }
}

function plume(g: G, r: () => number, x: number, y: number): void {
  // Puffs rising and drifting with the wind, darker and larger with height; the lowest lit red from the crater.
  for (let i = 0; i < 46; i++) {
    const t = i / 46
    const px = x + t * 260 + (r() - 0.5) * 120 * (0.4 + t)
    const py = y - 10 - t * 300 + (r() - 0.5) * 50
    const rad = 30 + t * 110 + r() * 30
    const lit = Math.max(0, 1 - t * 3)
    const gr = g.createRadialGradient(px, py, 0, px, py, rad)
    // Ash: a dark warm grey, lit red from the crater at its root — lighter than F2's near-black upper sky, so it reads.
    const red = Math.round(52 + lit * 90)
    gr.addColorStop(0, `rgba(${red},${Math.round(36 + lit * 22)},${Math.round(34 + lit * 6)},${0.6 - t * 0.25})`)
    gr.addColorStop(0.6, `rgba(${red - 10},${30 + Math.round(lit * 10)},28,${0.32 - t * 0.14})`)
    gr.addColorStop(1, 'rgba(40,28,26,0)')
    g.fillStyle = gr
    g.fillRect(px - rad, py - rad, rad * 2, rad * 2)
  }
}

function mist(g: G, r: () => number, foot: number): void {
  // A red band along the horizon, thickest at the foot, with soft billows rising into the lower flanks.
  const band = g.createLinearGradient(0, foot - 120, 0, VOLCANO_H)
  band.addColorStop(0, 'rgba(150,60,40,0)')
  band.addColorStop(0.45, 'rgba(160,64,42,0.38)')
  band.addColorStop(0.75, 'rgba(120,44,30,0.5)')
  band.addColorStop(1, 'rgba(90,30,20,0.0)')
  g.fillStyle = band
  g.fillRect(0, foot - 120, VOLCANO_W, VOLCANO_H - foot + 120)
  for (let i = 0; i < 60; i++) {
    const px = r() * VOLCANO_W
    const py = foot - 30 - r() * 90
    const rad = 40 + r() * 80
    const gr = g.createRadialGradient(px, py, 0, px, py, rad)
    gr.addColorStop(0, `rgba(170,70,46,${0.12 + r() * 0.12})`)
    gr.addColorStop(1, 'rgba(170,70,46,0)')
    g.fillStyle = gr
    g.fillRect(px - rad, py - rad, rad * 2, rad * 2)
  }
  // Fade the band's edges into the sky so the canvas's ends never show as a cut.
  g.globalCompositeOperation = 'destination-in'
  const ends = g.createLinearGradient(0, 0, VOLCANO_W, 0)
  ends.addColorStop(0, 'rgba(0,0,0,0)')
  ends.addColorStop(0.12, 'rgba(0,0,0,1)')
  ends.addColorStop(0.88, 'rgba(0,0,0,1)')
  ends.addColorStop(1, 'rgba(0,0,0,0)')
  g.fillStyle = ends
  g.fillRect(0, 0, VOLCANO_W, VOLCANO_H)
  g.globalCompositeOperation = 'source-over'
}

function ringed(g: G, x: number, y: number, rad: number, tilt: number, r: () => number): void {
  const ring = (front: boolean): void => {
    g.save()
    g.translate(x, y)
    g.rotate(tilt)
    g.beginPath()
    // The near half of the ring (front) or the far half (behind the disc).
    g.ellipse(0, 0, rad * 2.05, rad * 0.42, 0, front ? 0 : Math.PI, front ? Math.PI : Math.PI * 2)
    g.strokeStyle = 'rgba(140,100,88,0.6)'
    g.lineWidth = rad * 0.1
    g.stroke()
    g.beginPath()
    g.ellipse(0, 0, rad * 1.7, rad * 0.34, 0, front ? 0 : Math.PI, front ? Math.PI : Math.PI * 2)
    g.strokeStyle = 'rgba(90,64,58,0.4)'
    g.lineWidth = rad * 0.05
    g.stroke()
    g.restore()
  }
  ring(false)
  const body = g.createRadialGradient(x - rad * 0.35, y - rad * 0.35, rad * 0.1, x, y, rad)
  body.addColorStop(0, '#3e3234')
  body.addColorStop(0.7, '#251c1e')
  body.addColorStop(1, '#161112')
  g.fillStyle = body
  g.beginPath()
  g.arc(x, y, rad, 0, Math.PI * 2)
  g.fill()
  // A thin warm rim where the volcano's glow catches it from below-left.
  g.save()
  g.beginPath()
  g.arc(x, y, rad, 0, Math.PI * 2)
  g.clip()
  const rim = g.createRadialGradient(x - rad * 0.2, y + rad * 0.9, rad * 0.2, x, y, rad * 1.4)
  rim.addColorStop(0, `rgba(200,96,60,${0.4 + r() * 0.1})`)
  rim.addColorStop(1, 'rgba(170,80,50,0)')
  g.fillStyle = rim
  g.fillRect(x - rad, y - rad, rad * 2, rad * 2)
  g.restore()
  ring(true)
}

const VS = /* glsl */ `void main(){ gl_Position = vec4(position.xy, 0., 1.); }`
/** One band: `org` (frame px, its top-left at the frame's centre camera) + `off` (parallax), `size` its canvas. */
const FS = /* glsl */ `
  uniform sampler2D colour; uniform sampler2D lava; uniform float lavaOn;
  uniform vec2 res; uniform vec2 frame; uniform vec4 band; // org.xy + offset, size.xy (frame px)
  uniform vec3 lavaCol; uniform vec3 tint;
  void main(){
    vec2 fp = vec2(gl_FragCoord.x * frame.x / res.x, (res.y - gl_FragCoord.y) * frame.y / res.y);
    vec2 uv = (fp - band.xy) / band.zw;
    if (uv.x < 0. || uv.x > 1. || uv.y < 0. || uv.y > 1.) discard;
    vec4 c = texture2D(colour, vec2(uv.x, 1. - uv.y));
    // The mask is the canvas's alpha: its colour is white wherever alpha > 0 once un-premultiplied (its .r read 1 at every faint edge).
    float g = lavaOn > 0. ? texture2D(lava, vec2(uv.x, 1. - uv.y)).a : 0.;
    vec3 col = c.rgb * tint + lavaCol * g;
    float a = max(c.a, clamp(g, 0., 1.));
    if (a <= 0.) discard;
    gl_FragColor = vec4(col, a);
  }`

function texture(c: HTMLCanvasElement, srgb: boolean): CanvasTexture {
  const t = new CanvasTexture(c)
  t.colorSpace = srgb ? SRGBColorSpace : NoColorSpace
  t.minFilter = t.magFilter = LinearFilter
  t.generateMipmaps = false
  return t
}

function bandMaterial(colour: CanvasTexture, lava: CanvasTexture | null): ShaderMaterial {
  return new ShaderMaterial({
    uniforms: {
      colour: { value: colour },
      lava: { value: lava ?? colour },
      lavaOn: { value: lava ? 1 : 0 },
      res: { value: new Vector2(1, 1) },
      frame: { value: new Vector2(1280, 720) },
      band: { value: new Vector4() },
      lavaCol: { value: new Vector3(...LAVA) },
      tint: { value: new Vector3(1, 1, 1) },
    },
    vertexShader: VS,
    fragmentShader: FS,
    transparent: true,
    depthWrite: false,
    depthTest: false,
  })
}

/** Where the two bands sit in the pictures' frame at the map's centre (frame px, top-left), from the seed. */
export function backdropLayout(seed: number, horizon: number): { volcano: [number, number]; planets: [number, number] } {
  const r = rng(seed ^ 0x3b0d)
  // The volcano's axis somewhere across the middle 60 % of the frame; its foot on the horizon line.
  const axis = 1280 * (0.2 + 0.6 * r())
  return { volcano: [axis - VOLCANO_W / 2, horizon - (VOLCANO_H - 140)], planets: [0, 0] }
}

/** The world renderer's backdrop layer (see the module comment). */
export class Backdrop {
  readonly volcano: Mesh
  readonly planets: Mesh
  private seed: number | null = null
  private textures: CanvasTexture[] = []
  private layout: { volcano: [number, number]; planets: [number, number] } = { volcano: [0, 0], planets: [0, 0] }

  constructor() {
    const q = (order: number): Mesh => {
      const m = new Mesh(new PlaneGeometry(2, 2), bandMaterial(texture(canvas(1, 1), true), null))
      m.frustumCulled = false
      m.renderOrder = order
      m.visible = false
      return m
    }
    this.planets = q(-8)
    this.volcano = q(-7)
  }

  get meshes(): Mesh[] {
    return [this.planets, this.volcano]
  }

  /** Paint the bands for map seed `seed` (once per seed). */
  private paint(seed: number, horizon: number): void {
    if (this.seed === seed) return
    this.seed = seed
    for (const t of this.textures) t.dispose()
    const v = paintVolcano(seed)
    const cv = texture(v.colour, true)
    const lv = texture(v.lava, false)
    const pl = texture(paintPlanets(seed), true)
    this.textures = [cv, lv, pl]
    ;(this.volcano.material as ShaderMaterial).dispose()
    ;(this.planets.material as ShaderMaterial).dispose()
    this.volcano.material = bandMaterial(cv, lv)
    this.planets.material = bandMaterial(pl, null)
    this.layout = backdropLayout(seed, horizon)
  }

  /**
   * Lay the bands out for this frame, or hide them (`on` false: a look with no backdrop, or a dev switch). `view`
   * (world px) over a `world`, drawn into a `res` buffer whose frame is `frame` (Phaser's game px).
   */
  place(on: boolean, seed: number, horizon: number, view: ViewRect, world: { w: number; h: number }, frame: [number, number], res: [number, number], night: number): void {
    this.volcano.visible = this.planets.visible = on
    if (!on) return
    this.paint(seed, horizon)
    const zoom = frame[0] / view.w
    const dx = view.x + view.w / 2 - world.w / 2
    const dy = view.y + view.h / 2 - world.h / 2
    // The frame is the pictures' 1280 × 720 at zoom 1; a wider view (zoomed out) sees the band smaller, as the sky.
    const k = frame[0] / 1280
    for (const [m, at, size, f] of [
      [this.volcano, this.layout.volcano, [VOLCANO_W, VOLCANO_H], VOLCANO_PARALLAX],
      [this.planets, this.layout.planets, [PLANETS_W, PLANETS_H], PLANET_PARALLAX],
    ] as const) {
      const u = (m.material as ShaderMaterial).uniforms
      ;(u['res']!.value as Vector2).set(res[0], res[1])
      ;(u['frame']!.value as Vector2).set(frame[0], frame[1])
      ;(u['tint']!.value as Vector3).set(...DAY_TINT.map((d) => d + (1 - d) * night) as [number, number, number])
      ;(u['band']!.value as Vector4).set(at[0] * k - dx * zoom * f, at[1] * k - dy * zoom * f, size[0] * k, size[1] * k)
    }
  }

  dispose(): void {
    for (const t of this.textures) t.dispose()
    for (const m of this.meshes) {
      m.geometry.dispose()
      ;(m.material as ShaderMaterial).dispose()
    }
  }
}
