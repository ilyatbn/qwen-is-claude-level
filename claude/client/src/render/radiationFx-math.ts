/**
 * T22.09B — space's radiation, as a player sees it: the pure half (§A8: no DOM or
 * Phaser here).
 *
 * The owner: *"players who dont have a shield are hit by radiation taking 1 damage
 * per second."* `M22-RULINGS` R6: **it is not silent** — T21.25's finding was that a
 * health bar drifting down for no visible reason is the real defect, not the damage.
 *
 * # Three states, from two inputs the client already has
 *
 * - **none** — not in space (or dead): nothing is drawn.
 * - **sealed** — in space, suit charged: a quiet status line and no vignette. The
 *   draining energy bar says the rest. **No bubble**: the suit is not the shield
 *   generator's bubble, which stays the generator's (R26).
 * - **irradiated** — suit flat: a pulsing edge glow and a loud line that says what
 *   to do about it.
 *
 * `irradiated` is **never derived here**. It is snapshot bit 7 in a match and
 * `Core.irradiated` in the sandbox — both `PlayerState::irradiated` in Rust — so this
 * file only chooses a picture for an answer it was given.
 *
 * # The look numbers live here, not in `constants.rs`
 *
 * They tune a DOM overlay nothing simulates, the same standing `feel-math.ts`'s
 * `VIGNETTE_MAX_ALPHA` has. The pulse's *period* is not one of them: it is the damage
 * tick's own interval (`RADIATION_LOG_INTERVAL`), passed in, so each throb lands with
 * the number it announces.
 */

export type SuitState = 'none' | 'sealed' | 'irradiated'

/** The glow's opacity at the trough of a pulse. High enough that no frame is dark. */
export const RADIATION_EDGE_MIN = 0.5
/** And at the crest — the frame the damage number lands on. */
export const RADIATION_EDGE_MAX = 0.9

/**
 * What the suit is doing, for the picture.
 *
 * `irradiated` wins over the rest because its source already folded in space and
 * alive; `space && alive` alone is a sealed suit.
 *
 * **Nothing outside a live round** (T22.09C F8). Radiation and the seal's drain are
 * `Playing`-only in `World::step`, so in warmup and after the bell the sealed line
 * ("uses energy") and the RADIATION glow would both be saying something false. Bit 7
 * itself is not phase-gated — a flat suit in warmup *is* unsealed — so the gate is
 * here, on the picture, not on the flag. The sandbox has no round and passes `true`.
 */
export function suitState(space: boolean, alive: boolean, irradiated: boolean, live: boolean): SuitState {
  if (!live) return 'none'
  if (irradiated) return 'irradiated'
  return space && alive ? 'sealed' : 'none'
}

/**
 * The HUD line. **Player-facing copy, and it says the suit softens every hit**
 * (review of T22.09A, F4): the suit *is* the shield (`M22-RULINGS` R2), so a charged
 * suit takes a share off a rocket too, not only off the radiation — a player who does
 * not know that cannot value a battery pack properly.
 */
export function suitLine(state: SuitState): string | null {
  switch (state) {
    case 'sealed':
      return 'SUIT SEALED · blocks radiation, softens every hit · uses energy'
    case 'irradiated':
      return '☢ RADIATION · suit energy empty · [R] battery pack'
    case 'none':
      return null
  }
}

/**
 * The glow's opacity `t` seconds into an exposure: a cosine from the crest, so the
 * very first frame is the brightest — the onset is the moment worth noticing.
 * Always within `[RADIATION_EDGE_MIN, RADIATION_EDGE_MAX]`; a non-positive or
 * non-finite period holds the crest rather than dividing by it.
 */
export function edgeAlpha(t: number, period: number): number {
  if (!(period > 0) || !Number.isFinite(t)) return RADIATION_EDGE_MAX
  const wave = 0.5 + 0.5 * Math.cos((2 * Math.PI * t) / period)
  return RADIATION_EDGE_MIN + (RADIATION_EDGE_MAX - RADIATION_EDGE_MIN) * wave
}

/**
 * The exposure clock: seconds since the suit last went flat, or 0 when it is not.
 * Restarting at each onset is what puts the crest on the first frame.
 */
export class ExposureClock {
  private t = 0

  update(dt: number, state: SuitState): void {
    this.t = state === 'irradiated' ? this.t + Math.max(0, dt) : 0
  }

  get seconds(): number {
    return this.t
  }
}
