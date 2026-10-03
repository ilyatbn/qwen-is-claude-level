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
import type { Box, Fog, Foreground, SeaTint, ViewRect } from './scene'
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
/** `f_kit.js::fog`'s noise octaves (5), and the low tier's. */
export const FOG_OCTAVES = 5
/**
 * T23.18B, R14: the low tier's fog noise drops its two finest octaves (periods of 16 and 8 world px at the mockup's
 * `scale` 0.004 — under the fog's own soft ramp). Measured on the checks' SwiftShader (frozen sandbox, `drawCost`):
 * the fog layers 1.0 → 0.7 ms a frame. The full tier (and every Level A gate) keeps the mockup's 5.
 */
export const FOG_OCTAVES_LOW = 3
/**
 * T23.41: the leaves' renderOrder — **under the effects**, not the mockup's 10 over everything. The mockup's leaves sit at
 * F1's frame corners where no effect is; the game's sit on the ground where the fight is, and over a fire, a smoke cloud
 * or a blast they hid the danger itself (fire-fx: 24 of 192 damage-circle points under a leaf at alpha 0.96 — "burned by
 * fire you cannot see"; smoke-fx, blast-fx the same). R10 keeps strong colour for danger and identity: identity is the
 * player boxes (`occluders`), danger is this order. After the actors (7), their glows (8) and the flare (8.5); before
 * every effect batch (`fx/layer.ts`: `FX_ORDER` − 0.2 and up). Where no effect overlaps a leaf — every F picture — the
 * frame is unchanged. *Reverse it by:* 10.
 */
export const FG_ORDER = 8.7
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
    float n = fbm(vec2(p.x*scale + seed, p.y*scaleY), FOG_OCTAVES);
    float a = k * ramp * smoothstep(0.3, 0.75, n);
    gl_FragColor = vec4(c, a); }`

/**
 * T23.30 (`docs/78` §A5, Islands): **the cloud sea** — "high up in the clouds". World-anchored: below `top` (mask
 * px, y down) the world is cloud, its upper edge billowing (two fBm octaves of the world x), lit on top and
 * shading into the fog's colour with depth and with the billows' own noise, so it reads as heaped cloud rather
 * than a band. In the fog's style: the same noise (`NOISE_GLSL`), the look's front-fog colour (so it follows the
 * daylight blend), drawn just after the front fog. Not animated (no clock: the redraw skip stands).
 */
/** T23.30's cloud sea: how far its billows' tops are lifted from the colour toward white (a world may name its own). */
const SEA_LIFT = 0.62

const SEA_FS =
  NOISE_GLSL +
  FRAG_P +
  /* glsl */ `
  uniform vec3 c; uniform float top; uniform vec3 liftTo; uniform float lift;
  void main(){ vec2 p = worldP();
    float edge = top - 70. * fbm(vec2(p.x*0.0045, 3.1), 3) - 34. * fbm(vec2(p.x*0.017, 7.7), 3);
    float a = smoothstep(edge - 6., edge + 26., p.y);
    if (a <= 0.) discard;
    float depth = clamp((p.y - edge) / 260., 0., 1.);
    float billow = fbm(vec2(p.x*0.008, p.y*0.016), 4);
    vec3 lit = mix(c, liftTo, lift);
    vec3 col = mix(lit, c * 0.85, clamp(depth*0.8 + (0.55 - billow)*0.9, 0., 1.));
    gl_FragColor = vec4(col, a * 0.97); }`

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
 * the back fog at −5, the terrain, the front fog at 5, the foreground at `FG_ORDER` (the mockup's
 * `q.renderOrder = 10`, moved under the effects — T23.41), the dev markers at 1000.
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
    FG_ORDER,
  )
  /** T23.30: the Islands shape's cloud sea, after the front fog and before the leaves. */
  readonly cloudSea = quad(
    new ShaderMaterial({
      uniforms: { ...common(), c: { value: new Vector3() }, top: { value: 0 }, liftTo: { value: new Vector3(1, 1, 1) }, lift: { value: SEA_LIFT } },
      vertexShader: VS,
      fragmentShader: SEA_FS,
      transparent: true,
      depthWrite: false,
      depthTest: false,
    }),
    6,
  )
  /** Dev (`look-gate-f1`): the occluder boxes the last frame faded the leaves over. */
  drawnOccluders: Box[] = []

  private fogMat(): ShaderMaterial {
    return new ShaderMaterial({
      uniforms: { ...common(), c: { value: new Vector3() }, y0: { value: 0 }, y1: { value: 1 }, k: { value: 0 }, scale: { value: 0.004 }, scaleY: { value: 0.014 }, seed: { value: 0 } },
      vertexShader: FOG_VS,
      fragmentShader: FOG_FS,
      defines: { FOG_OCTAVES },
      transparent: true,
      depthWrite: false,
      depthTest: false,
    })
  }

  get meshes(): Mesh[] {
    return [this.fogBack, this.fogFront, this.cloudSea, this.fg]
  }

  /** T23.18B: the tier's fog noise (`FOG_OCTAVES_LOW` on the low tier); a change recompiles the two fog programs. */
  setTier(low: boolean): void {
    const n = low ? FOG_OCTAVES_LOW : FOG_OCTAVES
    for (const m of [this.fogBack, this.fogFront]) {
      const mat = m.material as ShaderMaterial
      if (mat.defines['FOG_OCTAVES'] === n) continue
      mat.defines['FOG_OCTAVES'] = n
      mat.needsUpdate = true
    }
  }

  /**
   * Lay the layers out for this frame: `view` (mask px) drawn into a `res` buffer. `hidden`: dev
   * switches (the per-pass cost, `look-gate-f1`'s layer hunt). `occluders`: every player box, mask px.
   */
  place(
    look: { fogBack: Fog | null; fogFront: Fog | null; fg: Foreground | null },
    view: ViewRect,
    res: [number, number],
    occluders: Box[],
    hidden: ReadonlySet<string>,
    cloudSea: number | null = null,
    seaTint: SeaTint | null = null,
  ): void {
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
    // T23.30: the cloud sea, in the front fog's colour (or the back's, or a pale lilac when a look has neither).
    const sea = set(this.cloudSea, cloudSea !== null && !hidden.has('cloudSea'))
    if (sea && cloudSea !== null) {
      // T23.31: a world with its own sea (volcanic's ash) names it; the rest keep the fog's, lifted toward white.
      ;(sea.uniforms['c']!.value as Vector3).set(...(seaTint?.color ?? look.fogFront?.color ?? look.fogBack?.color ?? [0.62, 0.6, 0.78]))
      ;(sea.uniforms['liftTo']!.value as Vector3).set(...(seaTint?.liftTo ?? [1, 1, 1]))
      sea.uniforms['lift']!.value = seaTint?.lift ?? SEA_LIFT
      sea.uniforms['top']!.value = cloudSea
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
