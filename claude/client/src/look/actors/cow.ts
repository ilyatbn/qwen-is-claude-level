/**
 * T24.01 task 4: **the alien cow's animation** — what `draw.ts::cow` is told each frame, from what the client already
 * knows: where the cow is and whether it has moved (the server's `animal_move`), the night, and the trees `map_init`
 * carried. Cosmetic (R3): the simulation decides where a cow is and that it sleeps at night (`world/animals.rs`);
 * how it chews and where its tongue goes is drawn here and read by nothing.
 *
 * - **Chewing:** a cow standing still chews, its jaw in `CHEW_STEPS` steps a `CHEW_PERIOD_S`.
 * - **The tongue:** a cow standing still with a tree's canopy within `COW_TONGUE_REACH` of its mouth reaches its long
 *   tongue out to it — out and back once a `TONGUE_PERIOD_S`, curling side to side in a **random pattern**: each
 *   reach curls by its own hashed amount (cow id × reach number), so no two reaches are alike and two clients agree.
 * - **Sleep:** at night (`night` ≥ `COW_SLEEP_NIGHT`) a cow that is not moving lays its head down, eyes shut.
 */
import type { Actor } from '../scene'
import { FRUIT_AT } from './durianTree'
import { nightHalo, ANIMAL_LIT_PER_S } from './furniture'

type P = [number, number]

/**
 * How far the tongue reaches from the mouth, px. The cow grazes **beside** its tree, not under it (the owner: *"make
 * the cow be near the tree so it's fully visible? just extend the tongue"*): it stands `COW_CLEAR` (140) to
 * `COW_LEASH` (230) from the trunk, its mouth 29 px ahead of its middle, and the nearest canopy point (a low bough's
 * cluster, 66 px out and 70 up) is then 45–135 px across and up to ~40 px up from the mouth on level ground. Beside a
 * tree on a pillar the cow stands on the ground below (`COW_BELOW`, up to 170 px under the foot), and measured on seed
 * 7 its canopy was 140–170 px up and 110 across — 220 reaches it there too, the tongue's curl on top.
 */
export const COW_TONGUE_REACH = 220
/** One reach out and back, s, drawn in `TONGUE_STEPS` steps (one atlas cell each). */
export const TONGUE_PERIOD_S = 2.4
export const TONGUE_STEPS = 12
/** The jaw: one chew a `CHEW_PERIOD_S`, in `CHEW_STEPS` steps. */
export const CHEW_PERIOD_S = 0.7
export const CHEW_STEPS = 4
/** Standing this long (s) without moving, a cow is grazing — chewing, and reaching if a tree is near. */
export const COW_STILL_S = 0.5
/** The scene's night (0 day … 1 night) past which a still cow is asleep. */
export const COW_SLEEP_NIGHT = 0.5
/** The mouth, px from the cow's feet (facing right): `draw.ts::cow`'s head (22, −42) and snout (+7, +1.5). */
export const COW_MOUTH: P = [29, -40.5]
/** Walk-cycle steps, as the other animals' (`furniture.ts::GAIT_STEPS`). */
export const COW_GAIT_STEPS = 6

/** A small integer hash to [0, 1) — render-only (the simulation's RNG rule is game-core's). */
function h01(a: number, b: number): number {
  let h = (Math.imul(a | 0, 374761393) + Math.imul(b | 0, 668265263)) | 0
  h = Math.imul(h ^ (h >>> 13), 1274126177)
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296
}

/** Where a cow standing at (x, feet) facing `right` has its mouth, world px. */
export function cowMouth(x: number, feet: number, right: boolean): P {
  return [x + (right ? 1 : -1) * COW_MOUTH[0], feet + COW_MOUTH[1]]
}

/** The canopy points a tongue may reach on a tree at its foot: its fruit and the low boughs' leaf clusters. */
export function canopyPoints(t: { x: number; y: number; flip: boolean }): P[] {
  const m = t.flip ? -1 : 1
  const pts: P[] = FRUIT_AT.map(([dx, dy]) => [t.x + m * dx, t.y + dy])
  for (const [dx, dy] of [[-66, -70], [66, -70], [-56, -104], [58, -100]] as const) pts.push([t.x + m * dx, t.y + dy])
  return pts
}

/** The nearest canopy point within `COW_TONGUE_REACH` of `mouth`, as an offset from it; null with none near. */
export function tongueTarget(mouth: P, trees: readonly { x: number; y: number; flip: boolean }[]): P | null {
  let best: P | null = null
  let bd = COW_TONGUE_REACH
  for (const t of trees) {
    for (const [px, py] of canopyPoints(t)) {
      const d = Math.hypot(px - mouth[0], py - mouth[1])
      if (d <= bd) {
        bd = d
        best = [px - mouth[0], py - mouth[1]]
      }
    }
  }
  return best
}

/** The tongue at `t` seconds for cow `id`: out (0–1) and curl (−1…1), quantised — each reach curls its own way. */
export function tonguePose(t: number, id: number): { out: number; curl: number } {
  const cycle = Math.floor(t / TONGUE_PERIOD_S)
  const u = Math.floor(((t / TONGUE_PERIOD_S) % 1) * TONGUE_STEPS) / TONGUE_STEPS
  const out = Math.sin(Math.PI * u)
  // The random pattern: an amount and a direction per reach, waving once or twice as it goes.
  const amp = 0.4 + 0.6 * h01(id, cycle)
  const waves = 1 + Math.floor(h01(id + 7919, cycle) * 2)
  const curl = amp * Math.sin(u * Math.PI * 2 * waves + h01(id, cycle + 31337) * 6.283)
  return { out: Math.round(out * 100) / 100, curl: Math.round(curl * 100) / 100 }
}

/** The jaw at `t` seconds for cow `id` (0 shut … 1 open), quantised. */
export function chewPose(t: number, id: number): number {
  const u = Math.floor((((t + id * 0.37) / CHEW_PERIOD_S) % 1) * CHEW_STEPS) / CHEW_STEPS
  return Math.round((0.5 - 0.5 * Math.cos(u * Math.PI * 2)) * 100) / 100
}

/** What a cow is doing this frame (`AnimalLayer`'s view of it). */
export interface CowState {
  id: number
  /** Hit-box centre (the wire's position) and size, world px. */
  x: number
  y: number
  w: number
  h: number
  right: boolean
  /** Seconds since it last moved. */
  still: number
  /** The walk cycle's phase, 0–1. */
  gait: number
}

/** The cow as an actor at the scene's `night` and clock `t`, with the map's `trees` for its tongue. */
export function cowActor(c: CowState, night: number, t: number, trees: readonly { x: number; y: number; flip: boolean }[]): Actor {
  const feet = c.y + c.h / 2
  const grazing = c.still >= COW_STILL_S
  const sleep = grazing && night >= COW_SLEEP_NIGHT
  const s = 1
  let tongue: { to: P; out: number; curl: number } | null = null
  if (grazing && !sleep) {
    const to = tongueTarget(cowMouth(c.x, feet, c.right), trees)
    if (to) {
      const pose = tonguePose(t, c.id)
      // The drawing is mirrored by `face`; the offset is handed over in its own (unmirrored) frame.
      tongue = { to: [to[0] * (c.right ? 1 : -1), to[1]], ...pose }
    }
  }
  const step = Math.round((((c.gait % 1) + 1) % 1) * COW_GAIT_STEPS) % COW_GAIT_STEPS
  return {
    kind: 'cow',
    x: c.x,
    y: feet,
    opts: { s, face: c.right ? 1 : -1, gait: grazing ? 0 : step / COW_GAIT_STEPS, chew: grazing && !sleep && !tongue ? chewPose(t, c.id) : 0, sleep, tongue },
    lit: { size: ANIMAL_LIT_PER_S * 2, ...nightHalo(night), shadow: false },
    box: null,
  }
}
