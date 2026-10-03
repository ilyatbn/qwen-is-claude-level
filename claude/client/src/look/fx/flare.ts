/**
 * T23.20 part C — the solar flare in the world renderer, F3's way (`variant_F3.js`: *"effects as key lights"*): the
 * prominence loop is **light**, added into the HDR scene before the post — a white-hot core along the loop going
 * orange to deep red at its edge (kit.js's ribbon: a tight HDR core over a wide warm glow), the plasma's
 * field-aligned streaks, three magnetic strands twisting round it pinned at the footpoints, a ragged corona and wisps
 * thrown off it. The bloom gives it its shine, and it lights the rock and the figures near it (`flareLights`).
 *
 * **What is drawn is what burns** (T22.08B, R80): the polyline is `GameCore::flare_points` at the flare's own clock —
 * the samples the server's contact test runs on — handed over by `render/flareFx.ts` through the feed
 * (`fx/feed.ts::FlareView`); nothing here re-derives a position. **The body is lit to the contact radius** at every
 * sample: its glow never falls below `BODY_FLOOR` inside `SOLAR_FLARE_RIBBON_R` (the noise only adds), so
 * `solar-flare`'s probes at the centre and ±0.8 of the radius are under painted flare on every frame.
 *
 * **Additive** (F3's ribbons and sprites are `AdditiveBlending`): the loop crosses rock as easily as space, and the
 * rock shows through it lit. The telegraph's ghost is the same picture at `strength` (`flareStrength`, < 0.5).
 *
 * Who is burning stays `render/flareFx.ts`'s (its flame tongues on the bodies, both paths): a burn is read on the
 * figure, over everything.
 */
import { AdditiveBlending, BufferAttribute, BufferGeometry, Mesh, OrthographicCamera, ShaderMaterial } from 'three'
import type { WebGLRenderer, WebGLRenderTarget } from 'three'
import { NOISE_GLSL } from '../skyMaterial'
import { toWorld } from '../worldRenderer-math'
import type { Light } from '../scene'

/** With the effects (`fx/layer.ts`, 9) — over the actors: a flare is light, and it crosses a body as it crosses rock. */
export const FLARE_ORDER = 8.5
/** The most samples the shader's polyline holds (`SOLAR_FLARE_SAMPLES` is 48; `flare.test.ts` pins it fits). */
export const FLARE_MAX_POINTS = 64
/** The glow's floor inside the contact radius (HDR, before `strength`): every point that burns is lit. By eye. */
export const BODY_FLOOR = 0.4
/** The white-hot core's HDR peak (kit.js's ribbon core is [4, 3, 1.4]; the loop is wider, so less). By eye. */
export const CORE_HEAT = 1.3
/** The loop as lights for the rock and the figures: at these shares along it, F3's fire light, × `strength`. */
export const FLARE_LIGHT_AT: readonly number[] = [0.12, 0.5, 0.88]
export const FLARE_LIGHT = { z: 40, r: 130, rgb: '255,140,50', i: 1.5 } as const

const VS = /* glsl */ `
attribute vec2 aP;
varying vec2 vP;
void main(){ vP = aP; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.); }`

// vP and pts: mask px from the quad's top-left. ribbon/glow: SOLAR_FLARE_RIBBON_R / SOLAR_FLARE_GLOW; len: the loop's
// length (px), so the noise is measured in the world.
const FS = /* glsl */ `
uniform vec2 pts[${FLARE_MAX_POINTS}]; uniform int n;
uniform float time; uniform float ribbon; uniform float glow; uniform float len; uniform float strength; uniform float seed;
uniform float floorK; uniform float heat;
varying vec2 vP;
${NOISE_GLSL}
const float DRAIN = 2.4;   // plasma draining from the apex down both legs, ribbon radii per second
const float TWIST = 15.0;  // strand turns along the loop
const float ROLL = 1.7;    // how fast the strands roll
void main(){
  float best = 1.0e12; float along = 0.0; float side = 1.0;
  for (int i = 0; i < ${FLARE_MAX_POINTS - 1}; i++) {
    if (i >= n - 1) break;
    vec2 a = pts[i]; vec2 ab = pts[i + 1] - a;
    float l2 = max(dot(ab, ab), 1.0e-4);
    float t = clamp(dot(vP - a, ab) / l2, 0.0, 1.0);
    vec2 d = vP - (a + ab * t);
    float dd = dot(d, d);
    if (dd < best) { best = dd; along = (float(i) + t) / float(n - 1); side = ab.x * d.y - ab.y * d.x < 0.0 ? -1.0 : 1.0; }
  }
  float d = sqrt(best);
  if (d > ribbon + glow) { gl_FragColor = vec4(0.0); return; }
  float s = side * d / ribbon;                       // across, in contact radii (signed)
  float leg = abs(along - 0.5) * len / ribbon;       // along, from the apex, in the same unit
  float streak = fbm(vec2(leg * 0.22 - time * DRAIN * 0.22 + seed, s * 1.9 + seed * 0.7), 5);
  float boil = fbm(vec2(leg * 0.6 + time * 0.9, s * 3.1 - time * 1.4 + seed), 3);
  float wisp = fbm(vec2(leg * 0.12 - time * 0.35 + seed, abs(s) * 0.45 - time * 0.55), 3);
  // The body: lit to the contact radius whatever the noise does, ragged only outside it.
  float body = 1.0 - smoothstep(ribbon, ribbon * (1.15 + 0.7 * wisp), d);
  float pin = sin(3.14159265 * along);
  float strands = 0.0;
  for (int j = 0; j < 3; j++) {
    float fj = float(j);
    float off = 0.7 * pin * sin(along * TWIST + fj * 2.094 + time * (ROLL + 0.4 * fj) + seed);
    float w = 0.09 + 0.06 * boil;
    strands += exp(-pow((s - off) / w, 2.0));
  }
  strands = clamp(strands, 0.0, 1.0);
  float foot = exp(-min(along, 1.0 - along) * len / ribbon * 0.35);
  float core = exp(-s * s * 2.2);
  float temp = -0.1 + 0.4 * core + 0.75 * (streak - 0.45) + 0.2 * boil + 0.3 * foot + 0.55 * strands * core;
  vec3 col = mix(vec3(0.55, 0.05, 0.02), vec3(1.0, 0.36, 0.05), smoothstep(0.0, 0.45, temp));
  col = mix(col, vec3(1.0, 0.78, 0.28), smoothstep(0.45, 0.85, temp));
  col = mix(col, vec3(1.0, 0.97, 0.88), smoothstep(0.85, 1.25, temp));
  // F3's ribbon: a tight HDR core over a wide warm glow, plus the plasma's structure on top.
  // The plasma's streaks modulate the glow (never below the floor); the strands are the white-hot threads.
  float e = body * (floorK + heat * core * (0.2 + 0.5 * smoothstep(0.35, 0.8, streak) + 0.6 * strands) * (0.75 + 0.5 * boil));
  // The corona: past the body, a warm glow fading out by ribbon + glow, wispy.
  float k = max(d - ribbon * 0.6, 0.0) / glow;
  float halo = exp(-k * k * 3.0) * (0.35 + 0.65 * wisp) * (1.0 - smoothstep(0.7, 1.0, k));
  vec3 haloCol = mix(vec3(0.9, 0.18, 0.03), vec3(1.0, 0.55, 0.12), clamp(halo * 1.5, 0.0, 1.0));
  vec3 c = col * e + haloCol * halo * 0.45 * (1.0 - body);
  gl_FragColor = vec4(c * strength, 1.0);
}`

/** What the scene hands over each frame: the loop (mask px, x/y pairs), its strength, whether a check hid it. */
export interface FlareView {
  points: ArrayLike<number>
  /** `flareStrength`: < 0.5 in the telegraph, 1 lit. */
  strength: number
  hidden: boolean
  /** Per flare, so two flares do not writhe in step. */
  seed: number
  /** `SOLAR_FLARE_RIBBON_R` and `SOLAR_FLARE_GLOW` (mask px). */
  ribbon: number
  glow: number
}

export class FlareLayer {
  readonly mesh: Mesh
  private readonly geometry = new BufferGeometry()
  private readonly material: ShaderMaterial
  private readonly pts: Float32Array = new Float32Array(FLARE_MAX_POINTS * 2)
  /** Dev: drawn on the last placed frame, and how many samples. */
  drawn = false
  samples = 0

  constructor() {
    this.material = new ShaderMaterial({
      name: 'solarFlare',
      uniforms: {
        pts: { value: this.pts },
        n: { value: 0 },
        time: { value: 0 },
        ribbon: { value: 14 },
        glow: { value: 34 },
        len: { value: 1 },
        strength: { value: 0 },
        seed: { value: 0 },
        floorK: { value: BODY_FLOOR },
        heat: { value: CORE_HEAT },
      },
      vertexShader: VS,
      fragmentShader: FS,
      transparent: true,
      blending: AdditiveBlending,
      depthTest: false,
      depthWrite: false,
    })
    this.geometry.setAttribute('position', new BufferAttribute(new Float32Array(12), 3))
    this.geometry.setAttribute('aP', new BufferAttribute(new Float32Array(8), 2))
    this.geometry.setIndex(new BufferAttribute(new Uint32Array([0, 2, 1, 0, 3, 2]), 1))
    this.mesh = new Mesh(this.geometry, this.material)
    this.mesh.frustumCulled = false
    this.mesh.renderOrder = FLARE_ORDER
    this.mesh.visible = false
  }

  /** Lay the quad over the loop (or hide it), at clock `t` (s, the scene's — a paused scene's plasma holds still). */
  place(f: FlareView | null, t: number, maskH: number): void {
    const n = f ? Math.min(FLARE_MAX_POINTS, Math.floor(f.points.length / 2)) : 0
    if (!f || f.hidden || !(f.strength > 0) || n < 2) {
      this.mesh.visible = false
      this.drawn = false
      this.samples = 0
      return
    }
    const pad = f.ribbon + f.glow
    let x0 = Infinity
    let y0 = Infinity
    let x1 = -Infinity
    let y1 = -Infinity
    for (let i = 0; i < n; i++) {
      const x = f.points[2 * i]!
      const y = f.points[2 * i + 1]!
      x0 = Math.min(x0, x)
      y0 = Math.min(y0, y)
      x1 = Math.max(x1, x)
      y1 = Math.max(y1, y)
    }
    x0 -= pad
    y0 -= pad
    x1 += pad
    y1 += pad
    let len = 0
    for (let i = 0; i < n; i++) {
      this.pts[2 * i] = f.points[2 * i]! - x0
      this.pts[2 * i + 1] = f.points[2 * i + 1]! - y0
      if (i) len += Math.hypot(this.pts[2 * i]! - this.pts[2 * i - 2]!, this.pts[2 * i + 1]! - this.pts[2 * i - 1]!)
    }
    const pos = (this.geometry.getAttribute('position') as BufferAttribute).array as Float32Array
    const ap = (this.geometry.getAttribute('aP') as BufferAttribute).array as Float32Array
    for (let k = 0; k < 4; k++) {
      const mx = k === 1 || k === 2 ? x1 : x0
      const my = k >= 2 ? y1 : y0
      const w = toWorld(mx, my, maskH)
      pos[k * 3] = w.x
      pos[k * 3 + 1] = w.y
      pos[k * 3 + 2] = 0
      ap[k * 2] = mx - x0
      ap[k * 2 + 1] = my - y0
    }
    ;(this.geometry.getAttribute('position') as BufferAttribute).needsUpdate = true
    ;(this.geometry.getAttribute('aP') as BufferAttribute).needsUpdate = true
    const u = this.material.uniforms
    u['n']!.value = n
    u['time']!.value = t
    u['ribbon']!.value = f.ribbon
    u['glow']!.value = f.glow
    u['len']!.value = Math.max(1, len)
    u['strength']!.value = Math.min(1, f.strength)
    u['seed']!.value = f.seed
    this.mesh.visible = true
    this.drawn = true
    this.samples = n
  }

  /** As `blackHole.ts::warm`: the program exists from scene start, not from the first flare (`context-budget`). */
  warm(r: WebGLRenderer, target: WebGLRenderTarget): void {
    const prev = r.getRenderTarget()
    const autoClear = r.autoClear
    const vis = this.mesh.visible
    r.autoClear = false
    target.scissor.set(0, 0, 1, 1)
    target.scissorTest = true
    r.setRenderTarget(target)
    this.mesh.visible = true
    this.geometry.setDrawRange(0, 0)
    r.render(this.mesh, new OrthographicCamera(0, 1, 1, 0, -1, 1))
    this.geometry.setDrawRange(0, Infinity)
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

/** The loop as lights (mask px): `FLARE_LIGHT` at `FLARE_LIGHT_AT` along its samples, as strong as the flare. */
export function flareLights(f: Pick<FlareView, 'points' | 'strength' | 'hidden'> | null): Light[] {
  if (!f || f.hidden || !(f.strength > 0)) return []
  const n = Math.floor(f.points.length / 2)
  if (n < 2) return []
  const k = Math.min(1, f.strength)
  return FLARE_LIGHT_AT.map((a) => {
    const i = Math.round(a * (n - 1))
    return { x: f.points[2 * i]!, y: f.points[2 * i + 1]!, z: FLARE_LIGHT.z, r: FLARE_LIGHT.r, rgb: FLARE_LIGHT.rgb, i: FLARE_LIGHT.i * k }
  })
}
