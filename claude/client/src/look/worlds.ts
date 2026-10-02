/**
 * T23.31 (docs/78 §A7): **the world looks — an open list.** A look is everything render-only a map is drawn with: its
 * two palettes for T23.11's day/night blend (each a `FrameLook` and a `CombatPalette`, the mockup's shapes), the
 * terrain albedo they name (`palette.theme` → `albedo.ts::albedoTheme`; the lava seams are the terrain look's
 * `lava`/`lavaK`), the sky and its distant backdrop (`backdrop.ts`), the air's embers (`palette.extra2d`), and which
 * animals live there (`fauna`). Nothing here reaches the simulation (§A7: render-only plus fauna).
 *
 * - **`classic`** — today's: F1's night and F5's moonlit day (R7), verbatim. `gameDescription` builds exactly what it
 *   built before T23.31 for it (the classic look checks are unchanged).
 * - **`volcanic`** — night is **F2's palette verbatim** (the look-lab's `?look=F2` is its Level A); its "day" is a
 *   dusky red version of it (`VOLCANIC_DAY`, below — composition, not a reference picture: no picture of it exists),
 *   with the ash sky lit orange from the horizon, a stronger warm key and less vignette — the same shapes as F2, so the
 *   blend walks every field. Its distant layer is the smoking volcano with lava rivers, ringed planets and red mist
 *   (`mapideas/volcanic*.jpg`), its animals the tripod walker and the octopus crawler.
 *
 * Adding a look is adding an entry here (and an id the server can send — part 1, the coordinator's wiring).
 */
import type { CombatPalette, FrameLook, SeaTint } from './scene'
import { F1 } from './scenes/F1'
import { F2 } from './scenes/F2'
import { F5 } from './scenes/F5'
import { isWorldLookId, type WorldLookId } from './worldLookId'
export { WORLD_LOOK_IDS, worldLookOverride, type WorldLookId } from './worldLookId'

/** One end of the day/night blend. */
export interface LookEnd {
  look: FrameLook
  palette: CombatPalette
}

/** Which animals live in a look (`actors/furniture.ts::animalActor`). */
export type Fauna = 'classic' | 'volcanic'

export interface WorldLook {
  id: WorldLookId
  /** R7's two ends: `t` 0 the day, 1 the night (`daylight.ts`). */
  day: LookEnd
  night: LookEnd
  /** The distant painted layer between the sky and the back fog (`backdrop.ts`), or none. */
  backdrop: 'volcano' | null
  fauna: Fauna
  /**
   * T23.31: the Islands shape's cloud sea in this world (`scene.ts::SeaTint`) — null: today's, the fog's colour lifted
   * toward white (classic). Volcanic's is an ash sea lit from below by the lava's glow: a near-white sea under F2's
   * dark red air read as a hole in the picture (seen on the GPU; after: `shots/t2331-islands-volcanic-sea.png`).
   */
  sea: SeaTint | null
}

const end = (look: FrameLook, palette: CombatPalette | null): LookEnd => {
  if (!palette) throw new Error('a world look needs a combat palette')
  return { look, palette }
}

/**
 * The volcanic "day": F2 with its sky, light, fog and grade raised to a dusky red — every field below replaces F2's
 * same field, and every field F2 has is kept (the blend needs the shapes equal). The sun direction is F2's: the low
 * tier bakes the night's shadows for every hour (`worldRenderer.ts::syncBake`), so the ends must agree on it.
 */
const DAY_BG: Partial<FrameLook['bg'] & object> = {
  skyTop: 0x241010,
  skyBottom: 0x7a3420,
  haze: 0x9a4628,
  grainK: 0.02,
  glowColor: 0x6a2008,
}
const DAY_LAYER_COLOURS = [0x5a3026, 0x47241d, 0x3a1b15]
const DAY_TERRAIN: Partial<FrameLook['terrain']> = {
  sunCol: [0.62, 0.24, 0.1],
  sky: [0.16, 0.08, 0.06],
  ground: [0.2, 0.06, 0.02],
  rimK: 0.4,
  lipK: 0.12,
  lavaK: 0.45,
}
const DAY_FOG_BACK = { color: [0.5, 0.17, 0.07] as [number, number, number], k: 0.55 }
const DAY_FOG_FRONT = { color: [0.32, 0.1, 0.04] as [number, number, number], k: 0.3 }
const DAY_MOON = { rgb: '255,160,100', w: 0.8, fill: '150,80,60' }
const DAY_POST = { bloom: [0.55, 0.5, 0.72] as [number, number, number], exposure: 1.15 }
const DAY_GRADE = { vignette: 0.5, sat: 1.05 }

function volcanicDayLook(n: FrameLook): FrameLook {
  const bg = n.bg ? { ...n.bg, ...DAY_BG, layers: n.bg.layers.map((l, i) => ({ ...l, color: DAY_LAYER_COLOURS[i] ?? l.color })) } : null
  return {
    ...n,
    bg,
    terrain: { ...n.terrain, ...DAY_TERRAIN },
    fogBack: n.fogBack ? { ...n.fogBack, ...DAY_FOG_BACK } : null,
    fogFront: n.fogFront ? { ...n.fogFront, ...DAY_FOG_FRONT } : null,
    moon: { ...n.moon, ...DAY_MOON },
    grade: n.grade ? { ...n.grade, ...DAY_GRADE } : null,
    ...DAY_POST,
  }
}

function volcanicDayPalette(p: CombatPalette): CombatPalette {
  const look = volcanicDayLook({ ...F2.look, bg: p.bg, terrain: p.terrain, fogBack: p.fogBack, fogFront: p.fogFront, moon: p.moon, grade: p.grade, bloom: p.bloom, exposure: p.exposure })
  return {
    ...p,
    bg: look.bg ?? p.bg,
    terrain: look.terrain,
    fogBack: look.fogBack ?? p.fogBack,
    fogFront: look.fogFront ?? p.fogFront,
    moon: look.moon,
    grade: look.grade ?? p.grade,
    bloom: look.bloom,
    exposure: look.exposure,
    smoke: { ...p.smoke, rgb: '110,70,60' },
  }
}

export const WORLD_LOOKS: Readonly<Record<WorldLookId, WorldLook>> = {
  classic: { id: 'classic', day: end(F5.look, F5.palette), night: end(F1.look, F1.palette), backdrop: null, fauna: 'classic', sea: null },
  volcanic: {
    id: 'volcanic',
    day: end(volcanicDayLook(F2.look), F2.palette && volcanicDayPalette(F2.palette)),
    night: end(F2.look, F2.palette),
    backdrop: 'volcano',
    fauna: 'volcanic',
    // Ash in the troughs, the billows' tops caught orange — the backdrop's lava rivers' colour, a third of the way.
    sea: { color: [0.13, 0.06, 0.05], liftTo: [0.95, 0.42, 0.16], lift: 0.26 },
  },
}

/** A look by id; an unknown id (a newer server's look this client has not got) is the classic one. */
export function worldLook(id: string | null | undefined): WorldLook {
  return isWorldLookId(id) ? WORLD_LOOKS[id] : WORLD_LOOKS.classic
}
