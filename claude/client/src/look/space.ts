/**
 * T23.20 — **space in the new look (F3).** `P_space` (`variant_F3.js`'s palette: the dark starry sky, the distant
 * star with its god rays, the giant stepped planet arcs, the asteroid-lit rock, F3's back fog, bloom, grade and
 * exposure), the game's space description built from it, and the feed that carries T22.06's **behaviour** — where
 * the star, the planet and the moon are on the round's clock, and the drifting star field — from the scene's
 * `SpaceSky` (`render/spaceSky.ts`, which computes it) to the world renderer (which draws it).
 *
 * **What moves and how, without rebaking the sky** (R21): the sky is F3's `bg` with each body baked once at the
 * centre of its path (`spaceBackground`), then each frame the star is moved as the night moon set is (`setColours`
 * with the star's new place: a set offset, whole texels), and the planet's and the moon's arcs are bands whose
 * offsets are the feed's places less their baked ones (`WorldRenderer.placeSpace`). The third arc, the near planet's
 * limb along the bottom, is a band with parallax only. F3's own star dust (`bg.stars`, a static hash grid) is off in
 * the game: T22.06's seeded field is drawn instead (`SpaceStars`), drifting on the round's clock.
 *
 * **No day in space** (T22.06: darkness is 0), so `P_space` is used alone — no blend (T23.19G's F1-at-every-hour
 * stand-in is retired here).
 */
import { AdditiveBlending, BufferAttribute, BufferGeometry, OrthographicCamera, Points, Scene, ShaderMaterial, type WebGLRenderer, WebGLRenderTarget } from 'three'
import { C } from '../core'
import { F1 } from './scenes/F1'
import { F3 } from './scenes/F3'
import type { Background, BgLayer, CombatPalette, FrameLook, Moon, SceneDescription } from './scene'
import { HORIZON_PARALLAX } from './skyLayout'
import type { SmokeLook } from './fx/game'
import { rgbToLinear } from './fx/kit'
import { F3_EARTH_PATH, F3_MOON_FROM_EARTH, F3_SUN_PATH } from '../render/spaceSky-math'
import { EARTH_BAND, MOON_BAND, type SpaceFeed } from './spaceFeed'

export { EARTH_BAND, MOON_BAND, spaceFeed, type SpaceFeed, type SpacePart } from './spaceFeed'

/** F3's sky as drawn (`variant_F3.js`): its three arcs are the planet, the moon and the near limb, in that order. */
const F3_BG = F3.look.bg as Background
/** World px past the map's clamp the camera may sit (`skyLayout.ts::SKY_PAN_SLACK` — the bake's margin). */
const PAN_SLACK = 64

/**
 * T23.20: `P_space` — `variant_F3.js`'s values in the palette shape the game reads (`CombatPalette`): F3's sky, rock,
 * back fog, key light (`moon`), smoke, gate, halo, bloom, grade and exposure; where F3 states nothing (the front fog,
 * the leaves, the plume, the two team colours, which are F3's `A`/`B` and F1's alike) F1's.
 */
export const P_SPACE: CombatPalette = {
  ...(F1.palette as CombatPalette),
  theme: 'asteroid',
  bg: F3_BG,
  terrain: F3.look.terrain,
  fogBack: F3.look.fogBack ?? (F1.palette as CombatPalette).fogBack,
  moon: F3.look.moon,
  fire: '255,140,50',
  laser: '40,225,210',
  muzzle: '255,200,110',
  gate: '255,120,220',
  gateAccent: '#ff9adf',
  gateInner: 'rgba(40,20,50,0.9)',
  halo: '110,120,190',
  smoke: { rgb: '120,110,140', a: 0.12, size: 5 },
  bloom: F3.look.bloom,
  grade: F3.look.grade ?? (F1.palette as CombatPalette).grade,
  exposure: F3.look.exposure,
}

/**
 * T23.20: space's smoke (`fx/game.ts::SmokeLook`) — F3's: its smoke trail's colour (`S.smoke` `120,110,140`) and its
 * explosion's plume (`explosion(…, { smoke: 0x14121c })`), not the hour's (space has none).
 */
export const SPACE_SMOKE: SmokeLook = { plume: 0x14121c, smoke: rgbToLinear(P_SPACE.smoke.rgb) }

/** Where each body is baked (frame px): the centre of its F3 path — so it moves as far either way. */
export function bakedPlaces(frameW: number, frameH: number): { sun: [number, number]; earth: [number, number]; moon: [number, number] } {
  const earth: [number, number] = [F3_EARTH_PATH.cx * frameW, F3_EARTH_PATH.cy * frameH]
  return {
    sun: [F3_SUN_PATH.cx * frameW, F3_SUN_PATH.cy * frameH],
    earth,
    moon: [earth[0] + F3_MOON_FROM_EARTH[0], earth[1] + F3_MOON_FROM_EARTH[1]],
  }
}

/**
 * How far (frame px, x and y) each body may sit from its baked place on a `map` flown by a `frameW × frameH` view at
 * zoom 1: its path's half-extents (`SPACE_*_PATH_RX/RY`), the moon's orbit (`SPACE_MOON_ORBIT`, `_TILT`), and the
 * parallax a camera at the map's edge (plus the slack) gives it.
 */
export function bodyReach(map: { w: number; h: number }, frameW: number, frameH: number): { sun: [number, number]; earth: [number, number]; moon: [number, number] } {
  const c = C()
  const par = c.SPACE_BODY_PARALLAX
  const px = (Math.max(0, (map.w - frameW) / 2) + PAN_SLACK) * par
  const py = (Math.max(0, (map.h - frameH) / 2) + PAN_SLACK) * par
  const earth: [number, number] = [c.SPACE_EARTH_PATH_RX * frameW + px, c.SPACE_EARTH_PATH_RY * frameH + py]
  return {
    sun: [c.SPACE_SUN_PATH_RX * frameW + px, c.SPACE_SUN_PATH_RY * frameH + py],
    earth,
    moon: [earth[0] + c.SPACE_MOON_ORBIT, earth[1] + c.SPACE_MOON_ORBIT * c.SPACE_MOON_TILT],
  }
}

/**
 * Space's sky for a map: F3's `bg`, each body baked at its path's centre (`bakedPlaces`) and given its reach (the
 * bands: `BgLayer.reach`; the star: the set's reach, `spaceDescription`), the near limb a parallax band, and no static
 * star dust (T22.06's field is drawn instead). The body bands' offsets are the feed's, not a parallax's: their
 * `parallax` only sizes their bake for the camera's travel (`skyLayout.ts::bakeExtents`).
 */
export function spaceBackground(map: { w: number; h: number }, frameW: number, frameH: number): Background {
  const at = bakedPlaces(frameW, frameH)
  const reach = bodyReach(map, frameW, frameH)
  const par = C().SPACE_BODY_PARALLAX
  const layers: BgLayer[] = F3_BG.layers.map((l, i) => {
    if (i === EARTH_BAND) return { ...l, x: at.earth[0], y: at.earth[1], parallax: 0, reach: reach.earth }
    if (i === MOON_BAND) return { ...l, x: at.moon[0], y: at.moon[1], parallax: 0, reach: reach.moon }
    return { ...l, parallax: par }
  })
  const sun = F3_BG.sun ? { ...F3_BG.sun, x: at.sun[0], y: at.sun[1] } : undefined
  const rays = F3_BG.rays ? ([at.sun[0], at.sun[1], F3_BG.rays[2], F3_BG.rays[3]] as [number, number, number, number]) : undefined
  return { ...F3_BG, ...(sun ? { sun } : {}), ...(rays ? { rays } : {}), stars: 0, layers, parallax: HORIZON_PARALLAX }
}

/** The key light's direction for the cast's rim (`Moon`): from the screen's centre toward the star, F3's colours. */
export function starKey(sun: [number, number], frameW: number, frameH: number): Moon {
  const dx = sun[0] - frameW / 2
  const dy = sun[1] - frameH / 2
  const l = Math.hypot(dx, dy) || 1
  return { ...F3.look.moon, dx: dx / l, dy: dy / l }
}

/**
 * The game's description of a space map: `P_space`'s look, the asteroid albedo, the lit terrain, the sky above with its
 * bodies moving (`spaceSky`: their baked places — the feed's places are measured from them). No daylight.
 */
export function spaceDescription(map: { w: number; h: number }, caveWall: boolean): SceneDescription {
  const c = C()
  const [W, H] = [c.VIEWPORT_W, c.VIEWPORT_H]
  const bg = spaceBackground(map, W, H)
  const look: FrameLook = { ...F3.look, bg, lights: [], fg: null, fogFront: null }
  return {
    id: 'game',
    camera: { x: 0, y: 0, w: map.w, h: map.h },
    world: { w: map.w, h: map.h },
    masks: null,
    litTerrain: true,
    albedo: 'asteroid',
    caveWall,
    look,
    palette: P_SPACE,
    spaceSky: { places: bakedPlaces(W, H), reach: bodyReach(map, W, H).sun },
    actors: [],
    fx: [],
    labels: [],
    hud: null,
  }
}

/**
 * T22.06's star field, drawn in the world: one point per star at its place this frame (the feed's, frame px), its
 * colour × alpha, 1 or 2 frame px square at the buffer's scale — rendered into a buffer-sized target the sky's
 * composite adds **where F3 adds its star dust** (`skyMaterial.ts`, `SSTARS`: before the bands mix, so the planets'
 * arcs cover the stars behind them as `bgMaterial`'s layers cover its dust). The colours are the sky's pre-`lin`
 * values (sRGB 0–1), as the dust's are.
 */
export class SpaceStars {
  readonly target = new WebGLRenderTarget(1, 1, { depthBuffer: false })
  private readonly points: Points<BufferGeometry, ShaderMaterial>
  private readonly scene = new Scene()
  private readonly cam = new OrthographicCamera(-1, 1, 1, -1, 0, 1)
  private cap = 0
  /** The star count last drawn (dev). */
  drawn = 0

  constructor() {
    const mat = new ShaderMaterial({
      uniforms: { RES: { value: [1280, 720] }, scale: { value: 1 } },
      vertexShader: /* glsl */ `attribute vec4 star; attribute vec3 rgb; uniform vec2 RES; uniform float scale; varying vec4 vC;
        void main(){ vC = vec4(rgb, star.z); gl_PointSize = max(1., star.w*scale);
          gl_Position = vec4((star.x + 0.5*star.w)/RES.x*2. - 1., 1. - (star.y + 0.5*star.w)/RES.y*2., 0., 1.); }`,
      fragmentShader: /* glsl */ `varying vec4 vC; void main(){ gl_FragColor = vec4(vC.rgb*vC.a, 1.); }`,
      blending: AdditiveBlending,
      depthTest: false,
      depthWrite: false,
    })
    this.points = new Points(new BufferGeometry(), mat)
    this.points.frustumCulled = false
    this.scene.add(this.points)
  }

  /**
   * Draw this frame's stars from `feed` (a `frame`-sized frame) into `target` at `buffer` px; whether any were drawn —
   * none (an empty target) when space is not shown or a check hid them. Leaves the renderer's target as it found it.
   */
  render(renderer: WebGLRenderer, feed: SpaceFeed | null, frame: [number, number], buffer: [number, number]): boolean {
    if (this.target.width !== buffer[0] || this.target.height !== buffer[1]) this.target.setSize(buffer[0], buffer[1])
    const on = !!feed?.shown && !feed.hidden.has('stars') && feed.starCount > 0
    this.drawn = on && feed ? feed.starCount : 0
    const g = this.points.geometry
    if (on && feed) {
      if (feed.starCount > this.cap) {
        this.cap = feed.starCount
        g.setAttribute('star', new BufferAttribute(new Float32Array(this.cap * 4), 4))
        g.setAttribute('rgb', new BufferAttribute(new Float32Array(this.cap * 3), 3))
      }
      const s = g.getAttribute('star') as BufferAttribute
      const c = g.getAttribute('rgb') as BufferAttribute
      ;(s.array as Float32Array).set(feed.stars.subarray(0, feed.starCount * 4))
      ;(c.array as Float32Array).set(feed.starRgb.subarray(0, feed.starCount * 3))
      s.needsUpdate = true
      c.needsUpdate = true
      g.setDrawRange(0, feed.starCount)
      const u = this.points.material.uniforms
      u['RES']!.value = frame
      u['scale']!.value = buffer[0] / frame[0]
    }
    this.points.visible = on
    const prev = renderer.getRenderTarget()
    const clear = renderer.getClearAlpha()
    renderer.setRenderTarget(this.target)
    renderer.setClearAlpha(0)
    renderer.clear(true, false, false)
    if (on) renderer.render(this.scene, this.cam)
    renderer.setClearAlpha(clear)
    renderer.setRenderTarget(prev)
    return on
  }

  dispose(): void {
    this.target.dispose()
    this.points.geometry.dispose()
    this.points.material.dispose()
  }
}
