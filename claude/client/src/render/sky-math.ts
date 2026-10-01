/**
 * The client's copy of the day/night cycle (§A8): the cycle position, its named phase and the
 * darkness at it — the twin `world/cycle.rs::cycle_matches_the_client` pins.
 *
 * T23.04 retired the rest of this file with the sky it drew (the gradient keyframes, the sun and
 * moon arcs, the star field, the ridge profile and the cloud tint): the sky is the world
 * renderer's now (`look/skyMaterial.ts`), and R7's night / moonlit-day blend (T23.11) reads
 * `darkness`, which stays here.
 *
 * `darkness` — the gameplay-facing scalar — is **not** computed here in a match. It stays
 * server-authoritative exactly as `docs/14-daynight-visibility.md` §1 specifies.
 */

export type SkyPhase = 'morning' | 'day' | 'afternoon' | 'evening' | 'night' | 'dawn'

/** One full day, in seconds. `DAY_DURATION + NIGHT_DURATION`. */
export const CYCLE_LENGTH = 120

/**
 * T23.19G F7: the darkness curve's bounds (`world/cycle.rs`'s `DUSK_START`, `NIGHT_START`, `DAWN_START`, as cycle
 * positions) — exported so what hangs off the day (`daylight.ts`'s moon anchors and reach) is derived, not re-typed.
 */
export const DUSK_START = 0.5
export const NIGHT_START = 0.62
export const DAWN_START = 0.9

/** Phase boundaries, from §A4. Upper bound exclusive. */
const PHASES: Array<[SkyPhase, number, number]> = [
  ['morning', 0.0, 0.15],
  ['day', 0.15, 0.4],
  ['afternoon', 0.4, DUSK_START],
  ['evening', DUSK_START, NIGHT_START],
  ['night', NIGHT_START, DAWN_START],
  ['dawn', DAWN_START, 1.0],
]

/** Position in the day, wrapped to `[0, 1)`. */
export function cycleU(roundTime: number): number {
  const u = (roundTime / CYCLE_LENGTH) % 1
  return u < 0 ? u + 1 : u
}

export function skyPhase(u: number): SkyPhase {
  const t = cycleU(u * CYCLE_LENGTH)
  for (const [name, lo, hi] of PHASES) {
    if (t >= lo && t < hi) return name
  }
  return 'dawn'
}

/**
 * Darkness at cycle position `u`, derived from the **same phase table the sky
 * uses** (§A13).
 *
 * The original spec ramped over `CYCLE_TRANSITION` (8 s) centred on t = 60, so the
 * world was fully dark at t = 64 while the sky was still showing the orange sunset
 * keyframe at u = 0.55 — ten of evening's fourteen seconds played a sunset
 * underneath a black overlay. One description of the day, and everything reads
 * from it.
 *
 * This is the client's copy for the sandbox. In a real round the server owns the
 * clock and sends `darkness` in the snapshot header; M6 replaces the *call*, not
 * this function, which stays as the shared definition.
 */
export function darknessAt(u: number, nightDarkness: number): number {
  const t = cycleU(u * CYCLE_LENGTH)
  const smooth = (x: number) => {
    const k = Math.max(0, Math.min(1, x))
    return k * k * (3 - 2 * k)
  }
  if (t < DUSK_START) return 0
  if (t < NIGHT_START) return nightDarkness * smooth((t - DUSK_START) / (NIGHT_START - DUSK_START))
  if (t < DAWN_START) return nightDarkness
  return nightDarkness * (1 - smooth((t - DAWN_START) / (1 - DAWN_START)))
}

/**
 * The darkness a scene draws and computes vision with — **one spelling for every
 * call site** (T22.06).
 *
 * - **In space it is 0: there is no night in orbit.** `World::darkness` sends the same
 *   0, and this cannot rely on that byte, because of the next point.
 * - Otherwise the server's byte, falling back to the local clock. **The fallback is a
 *   falsy `||` on purpose and it is the trap this exists to fence off**: a server `0`
 *   reads as "no byte yet" and the client's own 120-second cycle is substituted. That
 *   is harmless on the ground, where the server says 0 only in daylight and the local
 *   clock agrees; it would have been a night falling over every space round.
 *
 * `darkness` also feeds `fovRadius`, so this is a vision rule, not only a tint.
 */
export function sceneDarkness(
  space: boolean,
  serverDarkness: number,
  roundTime: number,
  nightDarkness: number,
): number {
  if (space) return 0
  return serverDarkness || darknessAt(cycleU(roundTime), nightDarkness)
}
