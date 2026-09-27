/**
 * T23.14D F4: a remote's jet push, estimated — its input is not on the wire (R3), so the push is read off its motion:
 * the interpolated velocity's change per second, less what pulls the body there (`Core.bodyPullAt`: the field and the
 * mode's gravity on it). The core's own identity (`game-wasm`'s `acceleration_less_the_pull_is_the_push`): a stepped
 * body's acceleration less that pull is the push it was stepped with — braking included, which is the case velocity
 * got wrong (a body drifting right while braking with LEFT drew its flame pushing it right).
 *
 * Smoothed (`PUSH_SMOOTH_S`): the interpolated velocity is piecewise linear between snapshots, so its derivative is a
 * staircase a snapshot interval wide. While the estimate is weaker than `PUSH_HOLD_FRACTION` of a full flame's push
 * (a body at the speed cap, a snapshot gap the interpolator extrapolates over) the last clear push is held, so the
 * flame keeps its direction rather than going out and coming back.
 */

/** The estimate's smoothing time constant, s: a snapshot interval (`SNAPSHOT_HZ` 20) and a half. */
export const PUSH_SMOOTH_S = 0.075
/** Below this share of the full flame's push, the last clear push is held. */
export const PUSH_HOLD_FRACTION = 0.15

export type Vec = { x: number; y: number }

export class PushEstimate {
  private last: { vx: number; vy: number } | null = null
  private smooth: Vec | null = null
  private held: Vec | null = null

  /**
   * One frame: the body's (interpolated) velocity, the pull on it, the frame's dt and the full flame's push. Returns
   * the push to draw, or null while not jetting (and the estimate starts afresh at the next burn).
   */
  step(jetting: boolean, vx: number, vy: number, pull: ArrayLike<number>, dt: number, full: number): Vec | null {
    const prev = this.last
    this.last = { vx, vy }
    if (!jetting) {
      this.smooth = null
      this.held = null
      return null
    }
    if (!prev || dt <= 0) return this.held
    const ax = (vx - prev.vx) / dt - (pull[0] ?? 0)
    const ay = (vy - prev.vy) / dt - (pull[1] ?? 0)
    const f = this.smooth ? 1 - Math.exp(-dt / PUSH_SMOOTH_S) : 1
    const s0 = this.smooth ?? { x: ax, y: ay }
    this.smooth = { x: s0.x + (ax - s0.x) * f, y: s0.y + (ay - s0.y) * f }
    if (Math.hypot(this.smooth.x, this.smooth.y) >= PUSH_HOLD_FRACTION * full) this.held = { ...this.smooth }
    return this.held
  }
}
