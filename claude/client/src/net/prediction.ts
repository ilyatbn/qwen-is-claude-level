/**
 * Client-side prediction with server reconciliation.
 *
 * The reason this works without any tuning is that `core.applyInput` is the
 * **same compiled Rust** the server runs (`docs/01-architecture.md`). Replaying
 * `n` pending inputs from a corrected state lands exactly where the server will
 * land when it processes those same `n` inputs. There is no approximation here,
 * and if there ever appears to be, the bug is that the two are running different
 * code — not that a constant needs adjusting.
 */

import { C, type Core, type PlayerState } from '../core'
import type { InputFrame } from './codec'

export interface PredictorStats {
  pending: number
  corrections: number
  lastCorrectionPx: number
  maxCorrectionPx: number
  /** Corrections large enough to snap the render too, rather than smooth it. */
  snaps: number
}

/** What a snapshot tells us about ourselves. */
export interface LocalSnapshotView {
  lastInputSeq: number
  state: PlayerState
}

/**
 * Above this error the *render* teleports as well as the simulation. Smoothing a
 * respawn or a big knockback across 100 ms looks worse than the teleport does —
 * the player reads it as the camera sliding rather than as being thrown.
 */
const SNAP_PX = 64

/** Render smoothing time constant, ~100 ms as `docs/42` §2 asks for. */
const RENDER_SMOOTH_PER_SEC = 12

export class Predictor {
  private readonly core: Core
  private readonly localId: number
  private readonly pending: Array<{ input: InputFrame; dt: number }> = []
  private render = { x: 0, y: 0 }
  private started = false

  readonly stats: PredictorStats = {
    pending: 0,
    corrections: 0,
    lastCorrectionPx: 0,
    maxCorrectionPx: 0,
    snaps: 0,
  }

  constructor(core: Core, localId: number) {
    this.core = core
    this.localId = localId
  }

  get state(): PlayerState | null {
    return this.core.playerState(this.localId)
  }

  get renderPos(): { x: number; y: number } {
    return { ...this.render }
  }

  /** Sample, buffer, and apply locally — all in the same frame, at zero latency. */
  pushInput(input: InputFrame, dt: number): void {
    this.pending.push({ input, dt })
    this.core.applyInput(this.localId, input.seq, input.buttons, input.aim, dt)
    this.stats.pending = this.pending.length
    const s = this.state
    if (s && !this.started) {
      this.render = { x: s.x, y: s.y }
      this.started = true
    }
  }

  /**
   * Drop what the server has seen, then correct and replay the rest.
   *
   * The order matters: dropping first means the replay covers exactly the inputs
   * the server has *not* processed, which is the whole identity this rests on.
   */
  reconcile(snap: LocalSnapshotView): void {
    while (this.pending.length && this.pending[0]!.input.seq <= snap.lastInputSeq) {
      this.pending.shift()
    }
    this.stats.pending = this.pending.length

    const local = this.state
    if (!local) return

    const err = Math.hypot(local.x - snap.state.x, local.y - snap.state.y)
    if (err <= C().RECONCILE_EPSILON_PX) return

    this.stats.corrections++
    this.stats.lastCorrectionPx = err
    this.stats.maxCorrectionPx = Math.max(this.stats.maxCorrectionPx, err)

    // Snap the simulation immediately. Letting it lag the truth compounds the
    // error into every prediction after it.
    this.core.setPlayerState(this.localId, snap.state)
    for (const { input, dt } of this.pending) {
      this.core.applyInput(this.localId, input.seq, input.buttons, input.aim, dt)
    }

    if (err > SNAP_PX) {
      this.stats.snaps++
      const s = this.state
      if (s) this.render = { x: s.x, y: s.y }
    }
  }

  /** Ease the rendered position toward the simulation. */
  updateRender(dt: number): void {
    const s = this.state
    if (!s) return
    if (!this.started) {
      this.render = { x: s.x, y: s.y }
      this.started = true
      return
    }
    // Frame-rate independent exponential smoothing: a fixed per-frame lerp makes
    // the smoothing time depend on the frame rate, so a 144 Hz display would
    // correct nearly three times faster than a 50 Hz one.
    const t = 1 - Math.exp(-RENDER_SMOOTH_PER_SEC * dt)
    this.render.x += (s.x - this.render.x) * t
    this.render.y += (s.y - this.render.y) * t
  }

  /** Inputs the server has not acknowledged, oldest first. */
  get pendingInputs(): ReadonlyArray<{ input: InputFrame; dt: number }> {
    return this.pending
  }
}
