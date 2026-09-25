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
  bg: Background
  terrain: TerrainLook & { scorch?: Scorch[] }
  lights: Light[]
  fogBack: Fog | null
  fogFront: Fog | null
  fg: Foreground | null
  /** UnrealBloomPass `[strength, radius, threshold]`. */
  bloom: Rgb
  grade: Grade
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
}

/** One `S.glow` of a flamethrower's flame, relative to the muzzle. */
export interface Glow {
  x: number
  y: number
  r: number
  rgb: RgbString
  a: number
}

export type ActorKind = 'stick' | 'turret' | 'gate' | 'crystals' | 'beetle' | 'spider' | 'bird' | 'rocket' | 'smoke'

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
  /** rocket: heading, radians. */
  ang?: number
  /** smoke: the trail, mask px. */
  pts?: [number, number][]
  rgb?: RgbString
  a?: number
  size?: number
  grow?: number
}

export interface Actor {
  kind: ActorKind
  x: number
  y: number
  opts: ActorOpts
  lit: LitOpts | null
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
