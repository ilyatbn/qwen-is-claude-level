/**
 * T23.20 part C — the black hole in the world renderer, the owner's look (2026-10-03: *"like the image but animated"*,
 * an Interstellar-style render — style only, never copied): a **pitch-dark shadow** with a thin bright **photon ring**
 * at its edge; a **tilted accretion disc** of glowing gas, white-hot near the shadow going yellow → orange → deep red
 * outward; the disc's far side **lensed up and over** the shadow; **filaments** streaming off the outer edge; a soft
 * orange glow into the starfield. Animated: the disc swirls with differential rotation (inner faster), the filaments
 * drift, a slow shimmer. One shader on one quad, in the HDR scene before the post — the bloom gives it its shine.
 *
 * **The rule is drawn at full size from the arrival** (T22.14A L, R90): the shadow is the horizon, black to its edge,
 * and the ring band just outside it is bright — both at their true radii whatever `grow` is; only the decoration (the
 * disc, the lensed arc, the glow) swells in over `BLACK_HOLE_GROW_MS`. The disc's near side crosses in front of the
 * shadow's lower edge, as in the picture, but never within `NEAR_CLEAR` of the centre (`black-hole`'s disc probes at
 * 0.4 horizons stay black — the horizon is the kill line and reads as a black disc).
 *
 * **Premultiplied over** (`One, OneMinusSrcAlpha`), as the fireflies: the shadow is colour 0 at alpha 1 (it hides the
 * stars and the planets behind it), the gas adds light and covers what is behind it by its density, the glow only adds.
 *
 * Where: the hole the scene's `BlackHoleFx` hands the feed (`fx/feed.ts::BlackHoleSource`) — `WorldMirror.blackHole`,
 * the server's place. The telegraph before it opens and the reach ring stay Phaser's (`render/blackHoleFx.ts`): a
 * warning and a range line are read as UI, over everything.
 */
import { AddEquation, BufferAttribute, BufferGeometry, CustomBlending, Mesh, OneFactor, OneMinusSrcAlphaFactor, OrthographicCamera, ShaderMaterial } from 'three'
import type { WebGLRenderer, WebGLRenderTarget } from 'three'
import { NOISE_GLSL } from '../skyMaterial'
import { toWorld } from '../worldRenderer-math'
import type { Light } from '../scene'

/** After the front fog (5) and the fireflies (6), before the actors (7): a body falling in is drawn over the disc. */
export const BLACK_HOLE_ORDER = 6.5
/** The quad's half-side, in horizons: the disc's filaments and the glow fit inside it. */
export const HOLE_QUAD_HORIZONS = 5.2
/** The disc's tilt off horizontal (rad, rising to the right as in the picture) and how flat it is seen (minor/major). */
export const DISC_TILT = 0.38
export const DISC_INCLINATION = 0.36
/** The disc's inner and outer edge, in horizons (in the disc's plane). */
export const DISC_INNER = 1.3
export const DISC_OUTER = 3.9
/**
 * The near side never comes closer to the centre than this many horizons on screen — `black-hole` probes the shadow
 * at 0.4 horizons, and the near band's inner edge crosses at `DISC_INNER · DISC_INCLINATION` (0.47) below it
 * (`blackHole.test.ts` asserts it).
 */
export const NEAR_CLEAR = DISC_INNER * DISC_INCLINATION
/** The inner edge's angular speed (rad/s); farther out it falls as ρ^−1.5 (Kepler). By eye: a visible swirl. */
export const DISC_SPIN = 0.9
/** HDR peak of the white-hot inner disc and the photon ring (the post's bloom threshold is 0.7). By eye. */
export const DISC_HEAT = 1.1
export const PHOTON_RING_HEAT = 1.4
/** The photon ring's half-width (px) and the soft glow's reach (horizons) and strength. */
export const PHOTON_RING_HALF = 1.0
export const GLOW_REACH = 3.0
export const GLOW_STRENGTH = 0.06
/** The hole as a light for the rock and the figures near it (mask px; `effectLights.ts`'s shape): a warm, wide glow. */
export const BLACK_HOLE_LIGHT = { z: 60, r: 420, rgb: '255,150,70', i: 2.2 } as const

const VS = /* glsl */ `
attribute vec2 aP;
varying vec2 vP;
void main(){ vP = aP; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.); }`

// vP: px from the hole's centre, y up. R: the horizon; ringR / ringW: the rule's ring band (`blackHoleRadii`).
const FS = /* glsl */ `
uniform float time; uniform float R; uniform float ringR; uniform float ringW; uniform float grow;
uniform float tilt; uniform float incl; uniform float rin; uniform float rout; uniform float spin;
uniform float heat; uniform float ringHeat; uniform float ringHalf; uniform float glowReach; uniform float glowK;
uniform vec3 ringCol;
varying vec2 vP;
${NOISE_GLSL}
// Blackbody-ish ramp, t 0 (cool, outer) .. 1 (hot, inner): deep red, orange, yellow, white.
vec3 ramp(float t){
  vec3 c = mix(vec3(0.45, 0.04, 0.0), vec3(1.0, 0.3, 0.03), smoothstep(0.0, 0.35, t));
  c = mix(c, vec3(1.0, 0.6, 0.1), smoothstep(0.3, 0.72, t));
  return mix(c, vec3(1.0, 0.9, 0.7), smoothstep(0.72, 1.0, t));
}
// One layer of the gas at disc radius rho (horizons), disc angle phi, flowed for tt seconds from offset o.
vec4 gasLayer(float rho, float phi, float tt, vec2 o){
  float w = spin * pow(rin / max(rho, rin * 0.5), 1.5);
  float a = phi + w * tt;
  vec2 c = vec2(cos(a), sin(a));
  // Turbulent flow along the orbit: a warped field, coarse in radius so it reads as tufts and flows, not rings.
  vec2 wq = c * 4.2 + vec2(rho * 1.4, -rho * 0.9) + o;
  vec2 warp = vec2(fbm(wq * 0.7 + vec2(1.3, 0.0), 3), fbm(wq.yx * 0.8 - vec2(0.7, 2.1), 3)) - 0.5;
  float n = fbm(wq + warp * 2.2, 4);
  float fine = fbm(c * 11.0 + vec2(rho * 3.5, 0.0) + warp * 3.0 + o, 3);
  float wispN = fbm(c * 8.0 + vec2(rho * 1.8, 0.0) + warp * 2.0 + o * 1.7, 3);
  return vec4(n, fine, wispN, 0.0);
}
// The gas: emission (HDR) and density. Inner orbits turn faster (Kepler), so the noise is advected for at most
// FLOW_T seconds and two layers half a period apart cross-fade: an endless swirl that never winds into rings.
vec4 gas(float rho, float phi){
  const float FLOW_T = 7.0;
  float p1 = fract(time / FLOW_T);
  float p2 = fract(time / FLOW_T + 0.5);
  float k = abs(2.0 * p1 - 1.0);
  vec4 L = mix(gasLayer(rho, phi, p1 * FLOW_T, vec2(0.0)), gasLayer(rho, phi, p2 * FLOW_T, vec2(5.2, 1.3)), k);
  float n = L.x, fine = L.y;
  float clump = fbm(vec2(cos(phi), sin(phi)) * 1.6 + vec2(rho * 0.6, 4.1 + time * 0.03), 3);
  float streak = clamp(0.8 * n + 0.35 * fine - 0.12, 0.0, 1.0) * (0.5 + 1.0 * clump);
  float inner = smoothstep(rin, rin + 0.16, rho);
  float outer = 1.0 - smoothstep(rout * 0.55, rout, rho);
  float body = inner * outer;
  // Filaments: wisps past the outer edge where the noise runs high.
  float wisp = smoothstep(rout * 0.7, rout * 1.05, rho) * (1.0 - smoothstep(rout * 1.0, rout * 1.35, rho));
  wisp *= smoothstep(0.5, 0.8, L.z);
  float hot = pow(rin / max(rho, rin), 1.6);
  float t = clamp(hot * (0.55 + 0.7 * streak), 0.0, 1.0);
  // The side coming toward us is brighter (beaming): the left in the picture.
  float beam = 1.0 + 0.4 * cos(phi - 3.14159);
  float e = (body * (0.1 + 1.15 * streak) * beam * (0.2 + 1.15 * hot) + wisp * 0.25) * heat;
  vec3 col = ramp(t) * e;
  // Dense near the hot inner edge (the near side hides the photon ring behind it, as in the picture), thinner outward.
  float dens = clamp(body * (0.45 + 0.75 * streak + 0.5 * hot) + wisp * 0.3, 0.0, 0.95);
  return vec4(col, dens);
}
void main(){
  float r0 = length(vP);
  float g = max(grow, 0.001);
  vec2 p = vP / (g * R);            // horizons, the decoration swollen in by grow
  float r = length(p);
  float ct = cos(tilt), st = sin(tilt);
  vec2 q = vec2(p.x * ct + p.y * st, -p.x * st + p.y * ct);   // the disc's frame: x along it, y across (up = far side)
  // The disc is thick gas, not a plate: its across-coordinate wanders with the noise (a puffy, ragged edge).
  float puff = fbm(vec2(q.x * 1.7, time * 0.05), 3) - 0.5;
  vec2 dq = vec2(q.x, (q.y + puff * 0.22 * smoothstep(1.2, 3.5, abs(q.x))) / incl);
  float rho = length(dq);
  float phi = atan(dq.y, dq.x);
  float deco = step(0.001, grow);

  // Behind the shadow: the glow into the starfield, the far half of the disc, the far side lensed up and over.
  vec3 back = vec3(1.0, 0.45, 0.12) * glowK * exp(-max(r - 1.0, 0.0) / glowReach * 2.2) * step(1.0, r);
  vec4 far = q.y > 0.0 ? gas(rho, phi) : vec4(0.0);
  // The lensed image: the far disc's light bent round the shadow, widest over the top, a thin echo under it.
  float sa = atan(p.y, p.x) - tilt;                    // screen angle, measured in the disc's frame
  float up = sin(sa);
  float band = r - 1.0;
  float topW = 0.16 + 0.75 * smoothstep(-0.2, 1.0, up);
  float lensTop = smoothstep(0.0, 0.04, band) * (1.0 - smoothstep(topW * 0.35, topW, band)) * smoothstep(-0.45, 0.35, up);
  float lensBot = smoothstep(0.0, 0.02, band) * (1.0 - smoothstep(0.04, 0.12, band)) * smoothstep(0.0, 0.8, -up) * 0.5;
  // The far disc seen over the top: its inner edge hugs the shadow, its outer gas fans out above.
  vec4 lg = gas(rin + 0.04 + band * 2.4, sa + 3.14159);
  float hug = 1.0 - smoothstep(0.0, 0.22, band);
  vec3 lens = lg.rgb * 1.35 * (lensTop + lensBot) + ramp(0.85) * heat * 0.35 * hug * (lensTop + lensBot);
  float lensA = clamp((lensTop + lensBot) * 0.9, 0.0, 1.0);
  vec3 col = (back + far.rgb * (1.0 - lensA) + lens) * deco;
  float a = max(far.a, lensA) * deco;

  // The rule, full size whatever grow is: the shadow, black and opaque to its edge, and the ring band outside it.
  float shadow = 1.0 - smoothstep(R - 1.0, R, r0);
  col *= 1.0 - shadow;
  a = max(a, shadow);
  float band0 = 1.0 - smoothstep(ringW * 0.5, ringW * 0.5 + 1.0, abs(r0 - ringR));
  // The band glows at least the ring's colour (the lensed light is brighter on top), a thin white-hot photon ring at
  // its inner edge.
  float photon = 1.0 - smoothstep(ringHalf, ringHalf + 1.2, abs(r0 - (R + ringHalf + 0.5)));
  col = max(col, ringCol * 0.5 * band0);
  col += vec3(1.0, 0.93, 0.8) * ringHeat * photon;
  a = max(a, max(band0, photon));

  // In front of the shadow: the near half of the disc, never inside NEAR_CLEAR (the probes' black core).
  vec4 near = q.y <= 0.0 ? gas(rho, phi) : vec4(0.0);
  // While it swells in, the scaled-down disc would sit inside the shadow (measured: an orange slab across the black
  // on the arrival frames): the near side crosses the shadow only once the disc is (nearly) full size.
  near *= deco * (r0 >= R ? 1.0 : smoothstep(0.9, 1.0, grow));
  col = col * (1.0 - near.a) + near.rgb;
  a = a + near.a * (1.0 - a);
  gl_FragColor = vec4(col, a);
}`

/** What the scene hands over each frame: the hole (mask px), its swell-in (0 → 1) and whether a check hid it. */
export interface BlackHoleView {
  x: number
  y: number
  growth: number
  hidden: boolean
  /** `blackHoleRadii`: the horizon, the rule's ring band and its width (mask px). */
  horizon: number
  ring: number
  ringW: number
  /** `BLACK_HOLE_RING_COLOR` as 0–255. */
  ringRgb: readonly [number, number, number]
}

export class BlackHoleLayer {
  readonly mesh: Mesh
  private readonly geometry = new BufferGeometry()
  private readonly material: ShaderMaterial
  /** Dev: drawn on the last placed frame, where (mask px), and at what swell. */
  drawn = false
  at: { x: number; y: number } | null = null
  growth = 0

  constructor() {
    this.material = new ShaderMaterial({
      name: 'blackHole',
      uniforms: {
        time: { value: 0 },
        R: { value: 64 },
        ringR: { value: 71 },
        ringW: { value: 8 },
        grow: { value: 1 },
        tilt: { value: DISC_TILT },
        incl: { value: DISC_INCLINATION },
        rin: { value: DISC_INNER },
        rout: { value: DISC_OUTER },
        spin: { value: DISC_SPIN },
        heat: { value: DISC_HEAT },
        ringHeat: { value: PHOTON_RING_HEAT },
        ringHalf: { value: PHOTON_RING_HALF },
        glowReach: { value: GLOW_REACH },
        glowK: { value: GLOW_STRENGTH },
        ringCol: { value: [1, 0.78, 0.44] },
      },
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
    this.geometry.setAttribute('position', new BufferAttribute(new Float32Array(12), 3))
    this.geometry.setAttribute('aP', new BufferAttribute(new Float32Array(8), 2))
    // As `fireflyLayer.ts`: clockwise in mask px is anticlockwise once y is flipped up.
    this.geometry.setIndex(new BufferAttribute(new Uint32Array([0, 2, 1, 0, 3, 2]), 1))
    this.mesh = new Mesh(this.geometry, this.material)
    this.mesh.frustumCulled = false
    this.mesh.renderOrder = BLACK_HOLE_ORDER
    this.mesh.visible = false
  }

  /** Lay the quad on the hole (or hide it), at clock `t` (s, the scene's — a paused scene's disc holds still). */
  place(h: BlackHoleView | null, t: number, maskH: number): void {
    if (!h || h.hidden) {
      this.mesh.visible = false
      this.drawn = false
      this.at = null
      return
    }
    const half = HOLE_QUAD_HORIZONS * h.horizon
    const pos = (this.geometry.getAttribute('position') as BufferAttribute).array as Float32Array
    const ap = (this.geometry.getAttribute('aP') as BufferAttribute).array as Float32Array
    for (let k = 0; k < 4; k++) {
      const u = (k === 1 || k === 2 ? 1 : -1) * half
      const v = (k >= 2 ? 1 : -1) * half
      const w = toWorld(h.x + u, h.y + v, maskH)
      pos[k * 3] = w.x
      pos[k * 3 + 1] = w.y
      pos[k * 3 + 2] = 0
      // y up from the centre: a vertex below the hole in mask px (v > 0) is below it on screen.
      ap[k * 2] = u
      ap[k * 2 + 1] = -v
    }
    ;(this.geometry.getAttribute('position') as BufferAttribute).needsUpdate = true
    ;(this.geometry.getAttribute('aP') as BufferAttribute).needsUpdate = true
    const u = this.material.uniforms
    u['time']!.value = t
    u['R']!.value = h.horizon
    u['ringR']!.value = h.ring
    u['ringW']!.value = h.ringW
    u['grow']!.value = h.growth
    u['ringCol']!.value = [h.ringRgb[0] / 255, h.ringRgb[1] / 255, h.ringRgb[2] / 255]
    this.mesh.visible = true
    this.drawn = true
    this.at = { x: h.x, y: h.y }
    this.growth = h.growth
  }

  /** As `fireflyLayer.ts::warm`: the program exists from scene start, not from the first hole (`context-budget`). */
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

/** The bloom is kept out of the shadow inside this share of the horizon, and is whole again at its edge. */
export const SHADE_INNER = 0.85

/** The shadow as `post.ts::applyHoleShade`'s circle: drawing-buffer px, bottom up (as `nightUniforms`). */
export function holeShade(h: Pick<BlackHoleView, 'x' | 'y' | 'horizon'>, view: { x: number; y: number; w: number; h: number }, buf: { w: number; h: number }): { x: number; y: number; inner: number; outer: number } {
  const sx = buf.w / view.w
  const sy = buf.h / view.h
  return { x: (h.x - view.x) * sx, y: buf.h - (h.y - view.y) * sy, inner: h.horizon * SHADE_INNER * sx, outer: h.horizon * sx }
}

/** The hole as a light (mask px), full once it has swollen in. */
export function blackHoleLight(h: Pick<BlackHoleView, 'x' | 'y' | 'growth' | 'hidden'> | null): Light | null {
  if (!h || h.hidden) return null
  const k = Math.min(1, Math.max(0, h.growth))
  if (!(k > 0)) return null
  return { x: h.x, y: h.y, z: BLACK_HOLE_LIGHT.z, r: BLACK_HOLE_LIGHT.r, rgb: BLACK_HOLE_LIGHT.rgb, i: BLACK_HOLE_LIGHT.i * k }
}
