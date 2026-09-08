/**
 * Remote players are rendered `INTERP_DELAY_MS` in the past, between the two
 * snapshots that bracket that moment.
 *
 * 100 ms is two snapshot intervals at 20 Hz, so a single dropped snapshot still
 * leaves a bracketing pair and interpolation continues without a hitch. That is
 * *why* the number is what it is — it is not a feel knob. Remote players are not
 * meant to be responsive, they are meant to be accurate; shortening the buffer
 * trades correctness for a responsiveness the player cannot act on anyway.
 */

import { C } from '../core'
import type { SnapshotPlayer } from './codec'

export interface InterpolatedPlayer {
  id: number
  x: number
  y: number
  vx: number
  vy: number
  /** Radians, already unwrapped — safe to hand straight to a sprite. */
  aim: number
  health: number
  flags: number
  /** True while this player's position is being guessed rather than known. */
  extrapolated: boolean
}

interface Frame {
  tick: number
  time: number
  players: Map<number, SnapshotPlayer>
}

export interface InterpStats {
  bufferDepth: number
  extrapolatingMs: number
  frozen: boolean
}

/** Beyond this, a guessed position is worse than an honest freeze. */
const MAX_EXTRAPOLATION_MS = 250

const TAU = Math.PI * 2

/** Shortest signed angular difference, in radians. */
export function wrapToPi(a: number): number {
  let x = (a + Math.PI) % TAU
  if (x < 0) x += TAU
  return x - Math.PI
}

/** Interpolate an angle the short way round, so a weapon never spins on wrap. */
export function shortestArcLerp(a: number, b: number, t: number): number {
  return a + wrapToPi(b - a) * t
}

export function dequantAim(q: number): number {
  return (q / 65536) * TAU
}

export class RemoteInterpolator {
  private readonly frames: Frame[] = []
  private readonly bufferMs: number
  readonly stats: InterpStats = { bufferDepth: 0, extrapolatingMs: 0, frozen: false }

  constructor(bufferMs?: number) {
    this.bufferMs = bufferMs ?? C().INTERP_DELAY_MS
  }

  /**
   * Snapshots may arrive out of order; the buffer is kept sorted by time so the
   * bracketing search is always correct rather than only usually correct.
   */
  push(tick: number, serverTime: number, players: readonly SnapshotPlayer[]): void {
    const frame: Frame = {
      tick,
      time: serverTime,
      players: new Map(players.map((p) => [p.id, p])),
    }
    let i = this.frames.length
    while (i > 0 && this.frames[i - 1]!.time > serverTime) i--
    if (i > 0 && this.frames[i - 1]!.time === serverTime) {
      this.frames[i - 1] = frame // a re-sent tick replaces, never duplicates
    } else {
      this.frames.splice(i, 0, frame)
    }

    // Keep a little more than the render delay; anything older can never bracket.
    const cutoff = serverTime - this.bufferMs * 4
    while (this.frames.length > 2 && this.frames[0]!.time < cutoff) this.frames.shift()
    this.stats.bufferDepth = this.frames.length
  }

  sample(now: number): Map<number, InterpolatedPlayer> {
    const out = new Map<number, InterpolatedPlayer>()
    if (this.frames.length === 0) return out

    const renderTime = now - this.bufferMs
    const last = this.frames[this.frames.length - 1]!

    if (renderTime >= last.time) {
      // No future snapshot: extrapolate, then freeze.
      const ahead = renderTime - last.time
      const clamped = Math.min(ahead, MAX_EXTRAPOLATION_MS)
      this.stats.extrapolatingMs = ahead
      this.stats.frozen = ahead > MAX_EXTRAPOLATION_MS
      const dt = clamped / 1000
      for (const p of last.players.values()) {
        out.set(p.id, {
          id: p.id,
          x: p.x + p.vx * dt,
          y: p.y + p.vy * dt,
          vx: p.vx,
          vy: p.vy,
          aim: dequantAim(p.aim),
          health: p.health,
          flags: p.flags,
          extrapolated: ahead > 0,
        })
      }
      return out
    }

    this.stats.extrapolatingMs = 0
    this.stats.frozen = false

    // Oldest frame is already in the future: hold at it rather than guess backwards.
    const first = this.frames[0]!
    if (renderTime <= first.time) {
      for (const p of first.players.values()) out.set(p.id, still(p))
      return out
    }

    let a = first
    let b = last
    for (let i = 0; i < this.frames.length - 1; i++) {
      if (this.frames[i]!.time <= renderTime && renderTime <= this.frames[i + 1]!.time) {
        a = this.frames[i]!
        b = this.frames[i + 1]!
        break
      }
    }

    const span = b.time - a.time
    const t = span > 0 ? (renderTime - a.time) / span : 0
    for (const [id, pa] of a.players) {
      const pb = b.players.get(id)
      if (!pb) {
        // Present then gone: hold the last known state rather than vanishing
        // mid-interval — the roster is authoritative on the snapshot, not here.
        out.set(id, still(pa))
        continue
      }
      out.set(id, {
        id,
        x: pa.x + (pb.x - pa.x) * t,
        y: pa.y + (pb.y - pa.y) * t,
        vx: pa.vx + (pb.vx - pa.vx) * t,
        vy: pa.vy + (pb.vy - pa.vy) * t,
        aim: shortestArcLerp(dequantAim(pa.aim), dequantAim(pb.aim), t),
        health: t < 0.5 ? pa.health : pb.health,
        flags: t < 0.5 ? pa.flags : pb.flags,
        extrapolated: false,
      })
    }
    // A player who appears only in the later frame should still be drawn.
    for (const [id, pb] of b.players) {
      if (!out.has(id)) out.set(id, still(pb))
    }
    return out
  }
}

function still(p: SnapshotPlayer): InterpolatedPlayer {
  return {
    id: p.id,
    x: p.x,
    y: p.y,
    vx: p.vx,
    vy: p.vy,
    aim: dequantAim(p.aim),
    health: p.health,
    flags: p.flags,
    extrapolated: false,
  }
}

/**
 * A simple EWMA clock offset with outlier rejection. Nothing gameplay-critical
 * depends on it — it orders events and drives the interpolation clock — which is
 * exactly why it is allowed to stay this simple (`docs/42` §7).
 */
export class ClockSync {
  private _offset = 0
  private _rtt = 0
  private samples = 0
  private mean = 0
  private varAcc = 0

  addSample(serverTime: number, localTime: number, rtt: number): void {
    const offset = serverTime + rtt / 2 - localTime
    this._rtt = this.samples === 0 ? rtt : this._rtt * 0.8 + rtt * 0.2

    if (this.samples < 4) {
      // Not enough history to call anything an outlier yet.
      this.samples++
      const d = offset - this.mean
      this.mean += d / this.samples
      this.varAcc += d * (offset - this.mean)
      this._offset = this.samples === 1 ? offset : this._offset * 0.5 + offset * 0.5
      return
    }

    const sd = Math.sqrt(this.varAcc / (this.samples - 1))
    if (sd > 0 && Math.abs(offset - this.mean) > 3 * sd) return // 3σ outlier

    this.samples++
    const d = offset - this.mean
    this.mean += d / this.samples
    this.varAcc += d * (offset - this.mean)
    this._offset = this._offset * 0.9 + offset * 0.1
  }

  get offset(): number {
    return this._offset
  }

  get rtt(): number {
    return this._rtt
  }
}
