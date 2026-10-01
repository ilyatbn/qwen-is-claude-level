/**
 * T23.11 (R7): night and moonlit day — **two palettes as data, one blend**.
 *
 * `P_night` is F1's (`variant_F1.js`), `P_day` is F5's (`variant_F5.js`, "only the palette object P differs"):
 * the look-lab's scene data, verbatim. `blend(day, night, t)` walks **every** field of the two and mixes it at
 * `t = darkness / NIGHT_DARKNESS` (0 moonlit day, 1 night):
 *
 * - colours in **linear** space, with the mockup's own linearisation (`f_kit.js::toLin`, `pow 2.2`) — the hex
 *   `0xRRGGBB` fields (`HEX_KEYS`), `'r,g,b'` strings, `'#rrggbb'` and `'rgba(…)'` strings; `[r, g, b]` triples in
 *   the terrain and fog are linear already and mix as numbers;
 * - every other number linearly (fog heights, rim strengths, bloom, grade, exposure, the moonlight's direction);
 * - **shapes never blend**: a string or a flag that differs (`theme`, a layer's `shape`) is the nearer end's.
 *   The layers' positions, slopes, steps and fades are equal in F1 and F5, so mixing them is the identity;
 * - a thing only one end has — F1's moon disc (`bg.sun`, its `rays`, `rayColor`) and F5's three `moons` — is
 *   kept at the visibility of its end (`vis`: `t` for night's, `1 − t` for day's) and **omitted at the far end**,
 *   so `blend(0) ≡ P_day` and `blend(1) ≡ P_night` exactly, field for field (`daylight.test.ts` counts both ends).
 *
 * The moons move (`moonArcs`): positions from the cycle position `u` (`world/cycle.rs::cycle_u`, the client's
 * `sky-math.ts::cycleU`), each through its picture's place at its picture's moment.
 */
import type { Background, CombatPalette, FrameLook, SkyMoon } from './scene'
import { DAWN_START, DUSK_START, NIGHT_START } from '../render/sky-math'

/** Number fields that hold a `0xRRGGBB` colour (`e_style.js::bgMaterial`'s options and `P.plume`). */
export const HEX_KEYS: ReadonlySet<string> = new Set(['skyTop', 'skyBottom', 'haze', 'glowColor', 'rayColor', 'color', 'plume'])

const GAMMA = 2.2
const lin = (c: number): number => Math.pow(Math.max(0, c) / 255, GAMMA)
const srgb = (l: number): number => 255 * Math.pow(Math.max(0, l), 1 / GAMMA)
const mixN = (a: number, b: number, t: number): number => (t <= 0 ? a : t >= 1 ? b : a + (b - a) * t)
/** One sRGB channel (0–255) mixed in linear space. */
const mixC = (a: number, b: number, t: number): number => (t <= 0 ? a : t >= 1 ? b : srgb(mixN(lin(a), lin(b), t)))

function mixHex(a: number, b: number, t: number): number {
  if (t <= 0) return a
  if (t >= 1) return b
  const ch = (h: number, s: number): number => (h >> s) & 255
  const m = (s: number): number => Math.max(0, Math.min(255, Math.round(mixC(ch(a, s), ch(b, s), t))))
  return (m(16) << 16) | (m(8) << 8) | m(0)
}

const RGB_STRING = /^\s*[\d.]+\s*,\s*[\d.]+\s*,\s*[\d.]+\s*$/
const HASH = /^#[0-9a-f]{6}$/i
const RGBA = /^rgba\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)\s*\)$/i
/** Channels written back: two decimals (a string colour is read by `Number`, so it need not be whole). */
const fmt = (v: number): string => String(Math.round(v * 100) / 100)

function mixString(a: string, b: string, t: number): string {
  if (a === b || t <= 0) return a
  if (t >= 1) return b
  if (RGB_STRING.test(a) && RGB_STRING.test(b)) {
    const x = a.split(',').map(Number)
    const y = b.split(',').map(Number)
    return x.map((v, i) => fmt(mixC(v, y[i]!, t))).join(',')
  }
  if (HASH.test(a) && HASH.test(b)) {
    const h = mixHex(parseInt(a.slice(1), 16), parseInt(b.slice(1), 16), t)
    return `#${h.toString(16).padStart(6, '0')}`
  }
  const ra = RGBA.exec(a)
  const rb = RGBA.exec(b)
  if (ra && rb) {
    const c = [1, 2, 3].map((i) => fmt(mixC(Number(ra[i]), Number(rb[i]), t)))
    return `rgba(${c.join(',')},${fmt(mixN(Number(ra[4]), Number(rb[4]), t))})`
  }
  // A shape, a name, a flag: never blended — the nearer end's.
  return t < 0.5 ? a : b
}

/** Keys whose object exists at one end only and is faded by its end's visibility (`vis`). */
const FADED = new Set(['sun', 'moons'])

/**
 * A value kept from one end only, at visibility `vis` (0 at the far end: omitted). The sky reads `vis`
 * (`skyMaterial.ts`); `rays`' intensity (its third number) is scaled instead, as `bgMaterial` has no field for it.
 */
function faded(key: string, v: unknown, vis: number): unknown {
  if (vis >= 1) return v
  if (key === 'rays' && Array.isArray(v)) return v.map((x, i) => (i === 2 ? (x as number) * vis : x))
  if (key === 'moons' && Array.isArray(v)) return (v as SkyMoon[]).map((m) => ({ ...m, vis: (m.vis ?? 1) * vis }))
  if (FADED.has(key) && v && typeof v === 'object') return { ...(v as object), vis: ((v as { vis?: number }).vis ?? 1) * vis }
  return v
}

/** Every field of `a` and `b` mixed at `t` (the rules in the header). `key` is the field's name, for the hex set. */
export function mixValue(a: unknown, b: unknown, t: number, key = ''): unknown {
  if (typeof a === 'number' && typeof b === 'number') return HEX_KEYS.has(key) ? mixHex(a, b, t) : mixN(a, b, t)
  if (typeof a === 'string' && typeof b === 'string') return mixString(a, b, t)
  if (Array.isArray(a) && Array.isArray(b)) {
    // An element has no name of its own: a `[r, g, b]` triple under `color` (the fog's) is linear, not hex.
    if (a.length === b.length) return a.map((v, i) => mixValue(v, b[i], t))
    return t < 0.5 ? a : b
  }
  if (a && b && typeof a === 'object' && typeof b === 'object') {
    const out: Record<string, unknown> = {}
    const ao = a as Record<string, unknown>
    const bo = b as Record<string, unknown>
    for (const k of new Set([...Object.keys(ao), ...Object.keys(bo)])) {
      const inA = ao[k] !== undefined
      const inB = bo[k] !== undefined
      if (inA && inB) out[k] = mixValue(ao[k], bo[k], t, k)
      // One end only: faded by its end's weight; absent at the far end (t exactly 0 or 1).
      else if (inA && t < 1) out[k] = faded(k, ao[k], 1 - t)
      else if (inB && t > 0) out[k] = faded(k, bo[k], t)
    }
    return out
  }
  // null against a value (a scene with no fog at one end): the nearer end's, whole.
  return t < 0.5 ? a : b
}

/** The frame look at `t` (0 moonlit day, 1 night). */
export function blendLook(day: FrameLook, night: FrameLook, t: number): FrameLook {
  return mixValue(day, night, clamp01(t)) as FrameLook
}

/** The combat palette at `t`. */
export function blendPalette(day: CombatPalette | null, night: CombatPalette | null, t: number): CombatPalette | null {
  return mixValue(day, night, clamp01(t)) as CombatPalette | null
}

export const clamp01 = (v: number): number => (v > 0 ? (v < 1 ? v : 1) : 0)

/** `t` from the scene's darkness (the server's byte in a match): 0 moonlit day, 1 night. */
export function nightShare(darkness: number, nightDarkness: number): number {
  return nightDarkness > 0 ? clamp01(darkness / nightDarkness) : 0
}

// --------------------------------------------------------------------------------------------- moons

/**
 * Where each picture's moons stand in the cycle: F5's at the middle of the day (`u` 0.25 — day runs 0 → 0.5,
 * `world/cycle.rs::DUSK_START`), F1's at the middle of full night (0.76 — 0.62 → 0.90). At that `u` a moon is at
 * its picture's place; the wrap (half a cycle away) falls where its end's visibility is 0.
 */
export const DAY_MOON_U = DUSK_START / 2
export const NIGHT_MOON_U = (NIGHT_START + DAWN_START) / 2
/**
 * Screen px the moons travel per whole cycle — **composition, not tuning**: over the half-cycle a set is seen (60 s)
 * it drifts ±400 px either side of its picture's place, a third of the frame, slow enough to read as the sky
 * turning (≈ 13 px/s, a buffer px every few frames on the low tier) and far enough that a round's day and night
 * do not look like one still. **A set moves together** (F5's three moons in their picture's formation): each set is
 * shaded once, in its own frame, and read at the set's offset (`skyMaterial.ts`) — measured on SwiftShader, three
 * moons shaded per pixel cost 3 ms a frame, their loop even when every moon was hidden.
 */
export const MOON_TRAVEL = 1600
/** How far below its apex a set is at the ends of its half-cycle, px: the arc's sag (a quarter of this at the day's ends). */
export const MOON_SAG = 240

/** A set's offset from its picture's place at cycle position `u`: `k` ∈ [−½, ½) half-cycles from its moment. */
export function arcOffset(u: number, uRef: number): [number, number] {
  const k = ((((u - uRef + 0.5) % 1) + 1) % 1) - 0.5
  return [k * MOON_TRAVEL, MOON_SAG * (2 * k) * (2 * k)]
}

/**
 * How far from its moment (in cycle positions) a set is while any of it shows — derived from the
 * darkness curve's bounds (T23.19G F7; `sky-math.ts`, `world/cycle.rs`). The day moons show until night is whole
 * (`t` < 1: u `DAWN_START` → 1 → `NIGHT_START`), the night moon while `t` > 0 (`DUSK_START` → 1). Today 0.37 and 0.26.
 */
export const MOON_SHOWN_K: { day: number; night: number } = {
  day: Math.max(NIGHT_START - DAY_MOON_U, DAY_MOON_U - (DAWN_START - 1)),
  night: Math.max(NIGHT_MOON_U - DUSK_START, 1 - NIGHT_MOON_U),
}
const REACH_K = Math.max(MOON_SHOWN_K.day, MOON_SHOWN_K.night)

/**
 * How far from its picture's place a set can be while any of it shows (px, x either way and y down): `arcOffset` at
 * the farther of the two `MOON_SHOWN_K`. The sky bakes each set this far past the frame.
 */
export const MOON_REACH: [number, number] = [REACH_K * MOON_TRAVEL, MOON_SAG * (2 * REACH_K) * (2 * REACH_K)]

/**
 * `bg` with its moons moved to cycle position `u`: the day moons along `DAY_MOON_U`'s arc, the night moon
 * (`sun`, with its `rays`) along `NIGHT_MOON_U`'s. `null` `u` (the look-lab): unmoved, the pictures' places.
 */
export function moonArcs(bg: Background, u: number | null): Background {
  if (u === null) return bg
  const out: Background = { ...bg }
  const [dx, dy] = arcOffset(u, DAY_MOON_U)
  if (bg.moons) out.moons = bg.moons.map((m) => ({ ...m, x: m.x + dx, y: m.y + dy }))
  const [nx, ny] = arcOffset(u, NIGHT_MOON_U)
  if (bg.sun) out.sun = { ...bg.sun, x: bg.sun.x + nx, y: bg.sun.y + ny }
  if (bg.rays) out.rays = [bg.rays[0] + nx, bg.rays[1] + ny, bg.rays[2], bg.rays[3]]
  return out
}
