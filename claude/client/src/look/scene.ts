/**
 * T23.01 (R11): the renderer's input. **Plain data**, shaped like the scene the mockup
 * builds (`tasks/M23/reference/mockup-src/f_kit.js::frame` and its `lit()` calls), so the
 * look-lab can hand the renderer the reference scenes verbatim (`scenes/F*.ts`) and
 * `GameScene`/`SandboxScene` can fill the same shape from the sim.
 *
 * Coordinates are the mockup's: mask px, y down, on a 1280×720 strip at zoom 1. The
 * mockup's fx code flips y (`kit.js::wy`); the data here is before that flip.
 * Colours keep the mockup's encodings: `'r,g,b'` sRGB strings for lights and the 2D
 * cast, `0xRRGGBB` for the background, `[r, g, b]` linear triples for terrain and fog.
 */

import type { Pose } from './actors/figure'

export type Rgb = [number, number, number]
/** `'r,g,b'`, 0–255 sRGB — what `lit()` and the 2D cast read. */
export type RgbString = string

/** A mask as runs of alternating value, the first run 0; `w × h`, row-major. */
export interface MaskRuns {
  w: number
  h: number
  /** Solid rock. */
  solid: number[]
  /** Carved-out rock, the cave wall (R17: "was rock" ∧ air now). */
  back: number[]
}

/** The two masks the renderer takes, as the game has them: one byte per px. */
export interface Masks {
  w: number
  h: number
  solid: Uint8Array
  back: Uint8Array
}

export function decodeMask(m: MaskRuns): Masks {
  const unrun = (runs: number[]): Uint8Array => {
    const out = new Uint8Array(m.w * m.h)
    let i = 0
    runs.forEach((n, k) => {
      if (k % 2 === 1) out.fill(1, i, i + n)
      i += n
    })
    if (i !== m.w * m.h) throw new Error(`mask runs cover ${i} px, want ${m.w * m.h}`)
    return out
  }
  return { w: m.w, h: m.h, solid: unrun(m.solid), back: unrun(m.back) }
}

/** `f_scene.js`'s `L(x, y, z, r, rgb, i)`. */
export interface Light {
  x: number
  y: number
  z: number
  r: number
  rgb: RgbString
  i: number
  /**
   * T23.18: a gun's muzzle light (`effectLights.ts::MUZZLE_LIGHT`) — the effects layer draws F1's muzzle glow where it
   * is, as strong: one bookkeeping of which rounds flash, not two. Absent on every other light (and in the look-lab).
   */
  muzzle?: true
}

/** The key light `lit()` falls back to, and the cool fill from the sky. */
export interface Moon {
  dx: number
  dy: number
  rgb: RgbString
  w: number
  fill: RgbString
}

export interface BgLayer {
  shape: 'pyramid' | 'mesa' | 'zig' | 'arc'
  x: number
  y: number
  slope?: number
  top?: number
  r?: number
  color: number
  step: number
  soft: number
  fade: [number, number, number]
  jitter: number
  /**
   * T23.04, the game's sky only (`skyLayout.ts::gameSky`; the mockup's scenes leave these out and
   * draw one shape at a fixed screen place): the parallax factor, the repeat in screen px, and
   * the key of each copy's seeded apex jitter.
   */
  parallax?: number
  period?: number
  seed?: number
}

/** F5's moons in the sky (distinct from `Moon`, the light). */
export interface SkyMoon {
  x: number
  y: number
  r: number
  color: number
  rays: number
  rayLen: number
  phase: number
  halo: number
}

/** `e_style.js::bgMaterial`'s options. */
export interface Background {
  skyTop: number
  skyBottom: number
  haze: number
  horizon: number
  grainK?: number
  sun?: { x: number; y: number; r: number; k: number; color: number }
  rays?: [number, number, number, number]
  rayColor?: number
  stars?: number
  glowY?: number
  glowColor?: number
  moons?: SkyMoon[]
  layers: BgLayer[]
  /** T23.04: the gradient, horizon glow and haze band's parallax factor (the game's sky only). */
  parallax?: number
}

export interface Scorch {
  x: number
  y: number
  r: number
}

/** `kit.js::terrainMaterial`'s options (lit terrain). */
export interface TerrainLook {
  sunDir: Rgb
  sunCol: Rgb
  sky: Rgb
  ground: Rgb
  rimCol: Rgb
  rimK: number
  lipK: number
  lipCol: Rgb
  interior: number
  bevel: number
  lava?: Rgb
  lavaK?: number
}

/** `f_kit.js::fog`'s options. */
export interface Fog {
  color: Rgb
  y0: number
  y1: number
  k: number
  scale?: number
  seed?: number
}

/** `kit.js::foregroundDoF`'s options. */
export interface Foreground {
  tint: Rgb
  spots: { x: number; y: number; r: number; n: number }[]
}

export interface Grade {
  vignette?: number
  sat?: number
  warm?: Rgb
  cool?: Rgb
}

/** Everything `f_kit.js::frame` receives besides the world and the draw callbacks. */
export interface FrameLook {
  /** `null`: no sky is drawn — a space map (T23.04; space keeps T22.06's backdrop until T23.20). */
  bg: Background | null
  terrain: TerrainLook & { scorch?: Scorch[] }
  lights: Light[]
  fogBack: Fog | null
  fogFront: Fog | null
  fg: Foreground | null
  /** UnrealBloomPass `[strength, radius, threshold]`; strength 0 = no bloom pass (T23.08). */
  bloom: Rgb
  /** `kit.js::post`'s grade pass; `null` = none (T23.08: the look-lab's `only=sky`/`only=terrain`, whose references have none). */
  grade: Grade | null
  exposure: number
  moon: Moon
}

/**
 * `P`, the palette `f_scene.js::combatF` reads (F1, F2, F5). Every field it reads is
 * required — the mockup's two defaults (`timer ?? '2:57'`, `extra2d` absent) are stated
 * in the data rather than left to default silently.
 */
export interface CombatPalette {
  theme: string
  bg: Background
  terrain: TerrainLook
  fogBack: Fog
  fogFront: Fog
  fg: Foreground
  moon: Moon
  teamA: string
  teamB: string
  fire: RgbString
  laser: RgbString
  muzzle: RgbString
  gate: RgbString
  crystal: RgbString
  gateAccent: string
  gateInner: string
  halo: RgbString
  smoke: { rgb: RgbString; a: number; size: number }
  plume: number
  bloom: Rgb
  grade: Grade
  exposure: number
  timer: string
  extra2d: 'embers' | null
}

/** How `lit()` drew an actor: `null` for what the mockup draws unlit (smoke). */
export interface LitOpts {
  size: number
  halo: RgbString | null
  shadow: boolean
  /**
   * T23.13 (the game's actors): the halo to draw when the actor stands on the cave wall — F's `halo` option,
   * decided per frame from the terrain's `back` field under the actor (`WorldRenderer`), so a figure in a tunnel is
   * never ink on ink. Absent: `halo` as given (the mockup's scenes).
   */
  darkHalo?: RgbString
}

/** One `S.glow` of a flamethrower's flame, relative to the muzzle. */
export interface Glow {
  x: number
  y: number
  r: number
  rgb: RgbString
  a: number
}

export type ActorKind = 'stick' | 'turret' | 'gate' | 'crystals' | 'beetle' | 'spider' | 'bird' | 'rocket' | 'smoke' | 'figure' | 'weapon' | 'grave' | 'item' | 'label'

/** The union of `e_style.js`'s option bags, as the ink pass received them. */
export interface ActorOpts {
  s?: number
  face?: number
  rot?: number
  aim?: number
  weapon?: 'bazooka' | 'laser' | 'flamer'
  accent?: string
  jet?: boolean
  pose?: 'stand' | 'jet'
  marker?: string | false
  flame?: Glow[]
  muzzle?: boolean
  inner?: string
  glowRGB?: RgbString
  n?: number
  seed?: number
  eye?: string
  flap?: number
  /**
   * T23.16 (F6): `weapon` — a weapon alone, `actors/weapons.ts::WEAPONS[key]` drawn in its shoulder frame at (x, y)
   * scaled by `s` (F6's sheet, a pickup, an icon). `stick` — `held` is a weapon in the hands (`weapons.js::held`,
   * F6's 1× row) in place of `weapon`, its accents in `heldAccent`.
   */
  key?: string
  /** `weapon`: where its shoulder frame's origin is, px from the actor's anchor (F6 lights it at its visual centre). */
  origin?: [number, number]
  held?: string
  heldAccent?: string
  /** T23.19 `label`: its text. (`item` names its registry sprite in `key`.) */
  text?: string
  /** T23.14 figure: its pose (`actors/figure.ts::Pose`, `poses.js`'s J) and visor colour (space). */
  J?: Pose
  visor?: string
  /** rocket: heading, radians. */
  ang?: number
  /** smoke: the trail, mask px. */
  pts?: [number, number][]
  rgb?: RgbString
  a?: number
  size?: number
  grow?: number
}

/** A half-open pixel rect `[x0, y0, x1, y1]`, mask px, y down. */
export type Box = [number, number, number, number]

export interface Actor {
  kind: ActorKind
  x: number
  y: number
  opts: ActorOpts
  lit: LitOpts | null
  /**
   * T23.02: every pixel this actor paints (halo, shadow, rim passes, marker, flame), measured
   * from the mockup's own drawing (`scenes/measure-boxes.mjs`); `null` if it paints nothing on
   * screen. The look-compare `actors` region is the union of these.
   */
  box: Box | null
  /**
   * T23.14B: additive soft glows the actor carries (its jet flame's), drawn over the actors into the HDR scene
   * (`actors/glow.ts`) — the mockup's `sprite(softTex(), …, true)`. Not part of the atlas cell.
   */
  glows?: ActorGlow[]
}

/** One `kit.js::sprite(softTex(), x, y, z, size, color, opacity, true)`: mask px, `color` linear (may exceed 1). */
export interface ActorGlow {
  x: number
  y: number
  size: number
  color: Rgb
  alpha: number
}

export type Fx =
  | { kind: 'ribbon'; pts: [number, number][]; width: number; core: Rgb; glow: Rgb; z: number; fadePow: number; headBoost: number }
  | { kind: 'sprite'; tex: 'soft'; x: number; y: number; z: number; size: number; color: Rgb; alpha: number; additive: boolean }
  | { kind: 'explosion'; x: number; y: number; scale: number; smoke: number; z: number }

export interface Hud {
  timer: string
  accent: string
  dark: boolean
  bottomLight: boolean
  timerLight: boolean
}

/** Text drawn into the 2D layer (F4's captions). */
export interface Label {
  text: string
  x: number
  y: number
  font: string
  fill: string
  align: 'left' | 'center' | 'right'
}

/** A reference scene as ported: data only. */
export interface SceneData {
  id: string
  title: string
  /** `world.js::THEMES` key the mockup derived the albedo with. */
  theme: string
  camera: { x: number; y: number; w: number; h: number }
  mask: MaskRuns
  look: FrameLook
  palette: CombatPalette | null
  /** In draw order. */
  actors: Actor[]
  /** In draw order. */
  fx: Fx[]
  hud: Hud | null
  labels: Label[]
}

/** A camera rect in mask px, y down: what the renderer is asked to show. */
export interface ViewRect {
  x: number
  y: number
  w: number
  h: number
}

/**
 * What a renderer is handed (R11): a scene with its masks decoded, one byte per px, the way
 * the game holds them. The look-lab builds it from `SceneData` (`describeScene`); the game
 * scenes build it from the sim. `masks` is `null` where no mask is fed yet — the game until
 * the terrain layer reads one (T23.07); a renderer must draw its sky without one.
 */
export interface SceneDescription {
  /**
   * T23.09A: `false` draws no cave wall (the terrain shader's `back` branch) — carved air shows what is
   * behind the rock. Absent: drawn, as in every mockup scene (the look-lab).
   */
  caveWall?: boolean
  /** T23.13: draw `lit()`'s two rim passes on the actors (absent: drawn; the look-lab's `knob=actor-rim-off` is the control). */
  actorRim?: boolean
  id: string
  camera: ViewRect
  /** The mask's size in px — known even while `masks` is null; the renderer's y flip reads `h`. */
  world: { w: number; h: number }
  masks: Masks | null
  /**
   * T23.07: draw the lit terrain (`terrainMaterial.ts`) from the terrain fields the scene feeds
   * (`WorldRenderer.setTerrain`), once they are whole. The fields — not `masks` — are what it reads.
   */
  litTerrain: boolean
  look: FrameLook
  palette: CombatPalette | null
  actors: Actor[]
  fx: Fx[]
  labels: Label[]
  hud: Hud | null
}

/** The look-lab's description of a reference scene: the data verbatim, the mask decoded. */
export function describeScene(d: SceneData): SceneDescription {
  return {
    id: d.id,
    camera: { ...d.camera },
    world: { w: d.mask.w, h: d.mask.h },
    masks: decodeMask(d.mask),
    litTerrain: true,
    look: d.look,
    palette: d.palette,
    actors: d.actors,
    fx: d.fx,
    labels: d.labels,
    hud: d.hud,
  }
}

/** T23.02: the screen boxes of a scene's actors, in draw order — the look-compare `actors` region. */
export function actorBoxes(d: Pick<SceneDescription, 'actors'>): Box[] {
  return d.actors.flatMap((a) => (a.box ? [a.box] : []))
}
