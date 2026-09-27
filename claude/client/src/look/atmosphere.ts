/**
 * T23.08: the fog and the foreground — `mockup-src/f_kit.js::fog` (back fog behind the terrain, front
 * fog over it) and `kit.js::foregroundDoF` (the out-of-focus leaves drawn over everything), ported
 * **verbatim where the mockup has an answer**: each fragment shader is the mockup's, expression for
 * expression, with the mockup's per-scene numbers passed as uniforms instead of spliced into the source.
 *
 * **What the mockup could not say** — it draws one fixed 1280×720 frame, so its `p` is at once the
 * screen pixel and the world pixel. The game moves a camera, so each use of `p` picks one:
 *
 * - **The fog's height ramp is the screen's** (`smoothstep(y0, y1, sy)`, `sy` in the pictures' 720-px
 *   frame): fog lies in the lower part of the view wherever the camera is, as in every picture. A ramp
 *   anchored to the map would fog one band of rows and leave most views clear.
 * - **The fog's noise and the leaves are the world's** (mask px): the patches pass by as the camera
 *   pans, instead of sliding with the lens; the task names the leaves world-anchored.
 *
 * In the look-lab the view is the scene's own 0,0 → 1280×720 rect, so both readings are the mockup's
 * `p` and the lab draws the pictures' fog and leaves exactly. `p` is read from `gl_FragCoord` and the
 * view (`view`, `res` uniforms): one full-screen triangle pair per layer, no per-map geometry.
 *
 * **A foreground element may never hide a player** (the task, and R10's "identity" colours): the
 * leaves' alpha is capped at `FG_ALPHA_OVER_PLAYER` over every player box (`occluders`) and eased back
 * to the mockup's over `FG_FADE_PX` outside it. The mockup's F1 has no player behind a leaf, so the cap
 * does not move the lab's picture (look-gate-f1 measures it).
 *
 * Not animated: nothing here reads a clock, so the redraw skip stays valid.
 */
import { Mesh, PlaneGeometry, ShaderMaterial, Vector2, Vector3, Vector4 } from 'three'
import type { Box, Fog, Foreground, ViewRect } from './scene'
import { NOISE_GLSL } from './skyMaterial'

/** `foregroundDoF`'s spot slots (`spots[6]`). */
export const FG_SPOTS = 6
/** Player boxes the foreground fades over — `MAX_PLAYERS` (6) with room for a spectated pair. */
export const FG_OCCLUDERS = 8
/**
 * The leaves' alpha over a player box: at most this. The task's bound is 0.25; 0.2 keeps the
 * dark, near-black leaf a visible veil while the scarf and the ink under it read (the check asserts ≤ 0.25).
 */
export const FG_ALPHA_OVER_PLAYER = 0.2
/** Mask px outside a player box over which the leaves ease back to their own alpha. */
export const FG_FADE_PX = 24
/** The height of the pictures' frame, px: the fog's `y0`/`y1` are in it. */
export const PICTURE_H = 720

/** The mockup's `p`, split: `pw` = the world's mask px (y down), `sy` = the screen row in the pictures' frame. */
const FRAG_P = /* glsl */ `
  uniform vec4 view; uniform vec2 res;
  vec2 worldP(){ return vec2(view.x + gl_FragCoord.x * view.z / res.x, view.y + (res.y - gl_FragCoord.y) * view.w / res.y); }
  float screenY(){ return (res.y - gl_FragCoord.y) * ${PICTURE_H}.0 / res.y; }
`
const VS = /* glsl */ `void main(){ gl_Position = vec4(position.xy, 0., 1.); }`
/**
 * The fog's quad covers only the rows at or below its ramp's start (`y0`, in the pictures' frame): above it
 * the mockup's alpha is exactly 0 (`k·0·…`), so those rows are not rasterised at all — the top 53 % (back)
 * and 78 % (front) of the frame in F1. A `discard` there saved nothing on SwiftShader (measured, T23.08).
 */
const FOG_VS = /* glsl */ `uniform float y0;
  void main(){ float top = 1. - 2. * y0 / ${PICTURE_H}.0; gl_Position = vec4(position.x, mix(-1., top, position.y*0.5 + 0.5), 0., 1.); }`

/** `f_kit.js::fog`: `a = k·smoothstep(y0, y1, p.y)·smoothstep(0.3, 0.75, fbm(p.x·scale + seed, p.y·scale·3.5))` (`scaleY` = scale·3.5). */
const FOG_FS =
  NOISE_GLSL +
  FRAG_P +
  /* glsl */ `
  uniform vec3 c; uniform float y0, y1, k, scale, scaleY, seed;
  void main(){ vec2 p = worldP(); float sy = screenY();
    float ramp = smoothstep(y0, y1, sy);
    float n = fbm(vec2(p.x*scale + seed, p.y*scaleY), 5);
    float a = k * ramp * smoothstep(0.3, 0.75, n);
    gl_FragColor = vec4(c, a); }`

/** `kit.js::foregroundDoF`, verbatim, plus the player fade (`occ`). */
const FG_FS =
  NOISE_GLSL +
  FRAG_P +
  /* glsl */ `
  uniform vec4 spots[${FG_SPOTS}]; uniform vec3 tint; uniform vec4 occ[${FG_OCCLUDERS}]; uniform int nOcc;
  void main(){
    vec2 p = worldP();
    float a = 0.; float rim = 0.;
    for (int s=0;s<${FG_SPOTS};s++){
      vec4 sp = spots[s];
      // A leaf's centre is within 0.8·r·√2 of its spot and it reaches (1 + blur)·L ≤ 1.22·0.95·r from it:
      // past 2.4·r no leaf of this spot touches p, and skipping it changes nothing.
      if (length(p - sp.xy) > sp.z*2.4) continue;
      for (int k=0;k<12;k++){
        if (float(k) >= sp.w) break;
        float h1 = hash12(vec2(float(k), float(s))), h2 = hash12(vec2(float(k)+5., float(s)+1.)), h3 = hash12(vec2(float(k)+9., float(s)+3.));
        vec2 c = sp.xy + (vec2(h1,h2)-0.5)*sp.z*1.6;
        float ang = h3*6.283; vec2 d = p - c; d = mat2(cos(ang),-sin(ang),sin(ang),cos(ang))*d;
        float L = sp.z*(0.55+0.4*h2);
        float leaf = length(vec2(d.x/(L), d.y/(L*0.36)));
        float blur = 0.22;
        float m = smoothstep(1.+blur, 1.-blur, leaf);
        a = max(a, m);
        rim += smoothstep(1.+blur, 1., leaf)*smoothstep(0.6,1.,leaf)*step(0., d.y);
      }
    }
    if (a <= 0.) discard;  // alpha 0: blending it changes nothing
    vec3 col = tint + vec3(0.25,0.2,0.08)*clamp(rim,0.,1.)*0.3;
    float alpha = a*0.96;
    for (int i=0;i<${FG_OCCLUDERS};i++){
      if (i >= nOcc) break;
      vec4 b = occ[i];
      vec2 q = max(max(b.xy - p, p - b.zw), 0.);
      alpha = min(alpha, mix(${FG_ALPHA_OVER_PLAYER}, 1., smoothstep(0., ${FG_FADE_PX}.0, length(q))));
    }
    gl_FragColor = vec4(col, alpha);
  }`

const common = (): Record<string, { value: unknown }> => ({ view: { value: new Vector4(0, 0, 1, 1) }, res: { value: new Vector2(1, 1) } })

function quad(mat: ShaderMaterial, order: number): Mesh {
  const m = new Mesh(new PlaneGeometry(2, 2), mat)
  m.frustumCulled = false
  m.renderOrder = order
  m.visible = false
  return m
}

/**
 * The three layers, in `f_kit.js::frame`'s order around the terrain (renderOrder 0): the sky at −10,
 * the back fog at −5, the terrain, the front fog at 5, the foreground at 10 (the mockup's
 * `q.renderOrder = 10`), the dev markers at 1000.
 */
export class Atmosphere {
  readonly fogBack = quad(this.fogMat(), -5)
  readonly fogFront = quad(this.fogMat(), 5)
  readonly fg = quad(
    new ShaderMaterial({
      uniforms: {
        ...common(),
        spots: { value: Array.from({ length: FG_SPOTS }, () => new Vector4()) },
        tint: { value: new Vector3() },
        occ: { value: Array.from({ length: FG_OCCLUDERS }, () => new Vector4()) },
        nOcc: { value: 0 },
      },
      vertexShader: VS,
      fragmentShader: FG_FS,
      transparent: true,
      depthWrite: false,
      depthTest: false,
    }),
    10,
  )
  /** Dev (`look-gate-f1`): the occluder boxes the last frame faded the leaves over. */
  drawnOccluders: Box[] = []

  private fogMat(): ShaderMaterial {
    return new ShaderMaterial({
      uniforms: { ...common(), c: { value: new Vector3() }, y0: { value: 0 }, y1: { value: 1 }, k: { value: 0 }, scale: { value: 0.004 }, scaleY: { value: 0.014 }, seed: { value: 0 } },
      vertexShader: FOG_VS,
      fragmentShader: FOG_FS,
      transparent: true,
      depthWrite: false,
      depthTest: false,
    })
  }

  get meshes(): Mesh[] {
    return [this.fogBack, this.fogFront, this.fg]
  }

  /**
   * Lay the layers out for this frame: `view` (mask px) drawn into a `res` buffer. `hidden`: dev
   * switches (the per-pass cost, `look-gate-f1`'s layer hunt). `occluders`: every player box, mask px.
   */
  place(look: { fogBack: Fog | null; fogFront: Fog | null; fg: Foreground | null }, view: ViewRect, res: [number, number], occluders: Box[], hidden: ReadonlySet<string>): void {
    const set = (m: Mesh, on: boolean): ShaderMaterial | null => {
      m.visible = on
      if (!on) return null
      const u = (m.material as ShaderMaterial).uniforms
      ;(u['view']!.value as Vector4).set(view.x, view.y, view.w, view.h)
      ;(u['res']!.value as Vector2).set(res[0], res[1])
      return m.material as ShaderMaterial
    }
    for (const [m, f, name] of [[this.fogBack, look.fogBack, 'fogBack'], [this.fogFront, look.fogFront, 'fogFront']] as const) {
      const mat = set(m, !!f && !hidden.has(name))
      if (!mat || !f) continue
      const u = mat.uniforms
      ;(u['c']!.value as Vector3).set(...f.color)
      u['y0']!.value = f.y0
      u['y1']!.value = f.y1
      u['k']!.value = f.k
      // `fog()`'s defaults: `scale = 0.004`, `seed = 0`.
      u['scale']!.value = f.scale ?? 0.004
      // The mockup splices `scale * 3.5` computed in JS (a double) into the source; so here.
      u['scaleY']!.value = (f.scale ?? 0.004) * 3.5
      u['seed']!.value = f.seed ?? 0
    }
    const mat = set(this.fg, !!look.fg && !hidden.has('fg'))
    this.drawnOccluders = []
    if (!mat || !look.fg) return
    const u = mat.uniforms
    const spots = u['spots']!.value as Vector4[]
    // `foregroundDoF`: unused slots are `(-999, -999, 1, 0)` — no leaves.
    spots.forEach((v, i) => {
      const s = look.fg?.spots[i]
      if (s) v.set(s.x, s.y, s.r, s.n)
      else v.set(-999, -999, 1, 0)
    })
    ;(u['tint']!.value as Vector3).set(...look.fg.tint)
    const occ = u['occ']!.value as Vector4[]
    const n = Math.min(FG_OCCLUDERS, occluders.length)
    for (let i = 0; i < n; i++) occ[i]!.set(...occluders[i]!)
    u['nOcc']!.value = n
    this.drawnOccluders = occluders.slice(0, n)
  }

  dispose(): void {
    for (const m of this.meshes) {
      m.geometry.dispose()
      ;(m.material as ShaderMaterial).dispose()
    }
  }
}
