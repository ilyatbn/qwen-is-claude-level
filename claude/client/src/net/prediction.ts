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
import { seqAtTick, tickAtSeq, type SeqAnchor } from './seqClock'

export interface PredictorStats {
  pending: number
  corrections: number
  lastCorrectionPx: number
  maxCorrectionPx: number
  /** Corrections large enough to snap the render too, rather than smooth it. */
  snaps: number
  /**
   * T22.10B: **how far the last correction moved the predicted body** — the state
   * before `setPlayerState` against the state after the replay. This is the
   * rubber-band a player sees. `lastCorrectionPx` is not: it compares the
   * *current* prediction with the server's state *at the acknowledged input*, so a
   * body moving at `v` with `p` inputs pending reads `v·p·dt` there however right
   * the prediction is (measured: 3–16 px at vortex speeds, while this read ~1 px).
   */
  lastJumpPx: number
  maxJumpPx: number
  /**
   * T22.10B: **the prediction's own error** — where this client predicted the body
   * after the acknowledged input, against where the server says it is after that
   * input. Free of pending travel (unlike `lastCorrectionPx`) and of what the
   * replay does next (unlike `lastJumpPx`). NaN until a snapshot acks an input
   * this predictor applied.
   */
  lastAckErrorPx: number
  /**
   * T22.10D: the worst `lastAckErrorPx` and the worst jump over the snapshots that
   * did **not** relocate the body — a spawn, a respawn, a pad or a vortex trip is a
   * correction of hundreds of pixels by design, and a maximum that includes them
   * measures the map, not the netcode. The harness prints both per client.
   */
  maxAckErrorPx: number
  maxEasedJumpPx: number
  /**
   * T22.10D: the seq the last snapshot acknowledged. A step between two snapshots
   * larger than the ticks between them is inputs the server skipped — the other
   * cause of a rubber-band, beside a wrong prediction (`breach-vortex`'s report).
   */
  lastAck: number
  /**
   * T22.10E F-4: reconciles left out of both maxima because they followed a
   * relocation or an ack gap (a rematch's skipped seqs, or a stand-in's seqs run
   * ahead of a client that lost time, T22.10F), or flipped `alive` — the event's
   * numbers. Since T22.10G also an ack-0 correction with inputs pending (the startup)
   * and an ack that ran more seqs than server ticks (a jitter-buffer trim).
   */
  settled: number
  /**
   * T22.10G: **where `maxEasedJumpPx` was taken** — so the worst rubber-band a check
   * reports can be attributed from its log rather than guessed: the ack's step and
   * the server ticks between that snapshot and the one before, the inputs pending,
   * whether the ack ran past the last pushed seq (a local stand-in), the error at
   * the ack and the server's speed there. Null until a counted correction.
   */
  worstJump: WorstJump | null
  /**
   * T22.12D F1: **the bell's own error** — where this client had predicted its body
   * when it heard the bell, against where the server says it was at that tick. The
   * predictions made before the page heard `ended` are keyed by the server tick each
   * seq ran on (R89: one seq per tick, `ack` on the snapshot's tick), the neutral ticks
   * after it continue the count until the anchoring snapshot, and the **latest**
   * snapshot whose tick falls in that record is the comparison (snapshots come every
   * `SIM_HZ / SNAPSHOT_HZ` ticks, so within that many of its end) — like for like,
   * which the anchoring correction's jump is not (it
   * compares "now", a lead ahead, with the snapshot). A prediction that kept pulling
   * past the server's `Ended` tick (`Core.setBell` not told) carries the extra pull of
   * every tick until the page heard. A diagnostic only: nothing is corrected by it.
   * NaN until a bell is measured.
   */
  bellErrorPx: number
}

/** The context of the correction behind `maxEasedJumpPx` (T22.10G). */
export interface WorstJump {
  px: number
  ackStep: number
  tickStep: number
  pending: number
  stoodIn: boolean
  ackErrorPx: number
  speed: number
  tick: number
}

/** What a snapshot tells us about ourselves. */
export interface LocalSnapshotView {
  /**
   * The server tick the snapshot was taken at (T22.10E F-3). While the phase
   * takes no input the ack stands still, so the results screen's reconciliation
   * keys on this instead.
   */
  tick: number
  lastInputSeq: number
  /**
   * **Minus `landingImpact`**, which no snapshot carries (T20.11): it is
   * measured locally by `integrate` on the tick the body touches down, and a
   * caller asked for one here would have to invent it.
   */
  state: Omit<PlayerState, 'landingImpact'>
}

/**
 * Above this error the *render* teleports as well as the simulation. Smoothing a
 * respawn or a big knockback across 100 ms looks worse than the teleport does —
 * the player reads it as the camera sliding rather than as being thrown.
 */
const SNAP_PX = 64

/** Render smoothing time constant, ~100 ms as `docs/42` §2 asks for. */
const RENDER_SMOOTH_PER_SEC = 12

type Kinematics = { x: number; y: number; vx: number; vy: number }

/**
 * T22.10E F-3: the prediction while the phase takes no input (`ended`). The
 * server drops every input then and steps each body a **neutral** tick
 * (T21.30), so there is nothing to keep for replay and the ack stands still —
 * the server's *tick* is the clock. `label` is the server tick the local body's
 * state stands for (`null` until a snapshot anchors it); `at` is the state after
 * each labelled local tick, `predicted`'s counterpart.
 */
type Neutral = {
  label: number | null
  at: Map<number, Kinematics>
  /**
   * T22.12D F1 (`bellErrorPx`): the local states keyed by the server tick they stand
   * for, recorded until the anchoring snapshot (`frozen` after it); `label`, the newest
   * recorded. Null once a snapshot passes it, or when no ack anchored the count.
   */
  bell: { at: Map<number, Kinematics>; label: number; frozen: boolean } | null
}

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
    lastJumpPx: 0,
    maxJumpPx: 0,
    lastAckErrorPx: Number.NaN,
    maxAckErrorPx: 0,
    maxEasedJumpPx: 0,
    lastAck: 0,
    settled: 0,
    worstJump: null,
    bellErrorPx: Number.NaN,
  }
  /** This reconcile's context, for `stats.worstJump` (T22.10G). */
  private step: Omit<WorstJump, 'px' | 'ackErrorPx'> | null = null
  /**
   * Where each unacknowledged input left the body, by seq — `lastAckErrorPx`'s
   * other end, and the prediction `reconcile`'s gate compares (T22.10D F8).
   */
  private readonly predicted = new Map<number, Kinematics>()
  private neutral: Neutral | null = null
  /**
   * T22.10E F-4: the next reconcile follows a relocation or an ack gap, so its
   * numbers are the event's, not the prediction's — kept out of the maxima.
   */
  private unsettled = false
  /**
   * The aim of the newest input (T22.10E review, (d)): what the server's neutral
   * tick carries (`World::apply_inputs` keeps the last aim), so the catch-up and
   * the replay step with it too — one answer to "which aim", not 0 in two places.
   */
  private lastAim = 0
  /** A repeated ack was seen (lost time, T22.10F); the next new ack is its residue. */
  private afterHitch = false
  /**
   * T22.10F: the newest seq pushed while the phase takes input, its held buttons,
   * and the newest seq the local body was **stood in** for — see `standIn`.
   */
  private lastPushed = 0
  private lastButtons = 0
  private stoodIn = 0
  /** The server tick of the last snapshot reconciled (T22.10G's trim rule); null before one. */
  private lastTick: number | null = null

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
    this.lastAim = input.aim
    // T22.10E F-3: in a phase that takes no input the server integrates a neutral
    // tick and drops what was sent, so this does exactly that and keeps nothing.
    // It kept every input (`pending` grew 14 → 301 over a results screen), then
    // compared a stale prediction with a body the server went on moving and
    // replayed the whole lot on every snapshot: 104 corrections, jumps to 41 px.
    if (!this.core.acceptsInput()) {
      this.stepNeutral(this.enterNeutral(), input.seq, input.aim, dt)
      return
    }
    this.neutral = null
    this.lastPushed = Math.max(this.lastPushed, input.seq)
    this.lastButtons = input.buttons
    // T22.10F: the server already ran this seq as a stand-in and will discard it
    // (it still steers the server's next stand-in, so it is sent), and the local
    // body already ran the same stand-in (`standIn`) — applying it again would
    // count the tick twice.
    if (input.seq <= this.stoodIn) return
    this.pending.push({ input, dt })
    this.core.applyInput(this.localId, input.seq, input.buttons, input.aim, dt)
    this.stats.pending = this.pending.length
    const s = this.state
    if (s) this.predicted.set(input.seq, { x: s.x, y: s.y, vx: s.vx, vy: s.vy })
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
    if (!this.core.acceptsInput()) {
      this.reconcileNeutral(snap)
      return
    }
    this.neutral = null
    const explained = this.standIn(snap.lastInputSeq)
    const at = this.predicted.get(snap.lastInputSeq)
    // T22.10E F-4: **an ack gap** — the server acknowledged seqs this predictor
    // never pushed. The seq runs on through the results screen while nothing is
    // kept or sent, so the first ack of a rematch skips them; what that snapshot
    // corrects is the round change, not a misprediction.
    const prevAck = this.stats.lastAck
    const pushedSince = this.pending.filter((q) => q.input.seq > prevAck && q.input.seq <= snap.lastInputSeq).length
    if (prevAck > 0 && !explained && pushedSince < snap.lastInputSeq - prevAck) this.unsettled = true
    // T22.10F: **a repeated ack while the phase takes input is time this client
    // lost.** The server steps every player every tick (R89); a stand-in claims the
    // next seq only within `MAX_FRAME_TICKS` of the newest this client sent, so once
    // a frame longer than `MAX_FRAME_DT` (a hitch, a hidden tab) has run past that,
    // the server goes on moving the body under the same ack — ticks this client
    // never simulated, because its fixed step is capped. The correction is the
    // hitch's, like a relocation's: counted, kept out of the maxima.
    // The first new ack after them is the hitch's too: the server went on stepping
    // between the last repeated-ack snapshot and this client's first input after it.
    if (prevAck > 0 && snap.lastInputSeq === prevAck) {
      this.unsettled = true
      this.afterHitch = true
    } else if (this.afterHitch) {
      this.unsettled = true
      this.afterHitch = false
    }
    // And **the first ack is an anchor, not a prediction** (T22.10F): the server
    // steps a new player every tick from the moment it is seated, before its first
    // input arrives (a body in space drifts to its rock meanwhile), while this
    // predictor starts from the spawn it was handed — so the first correction
    // measures the loading screen, not the netcode.
    if (prevAck === 0 && snap.lastInputSeq > 0) this.unsettled = true
    // T22.10G, from the T22.10F review's classification of every counted correction:
    // - **ack 0 with inputs pending**: the server has not simulated this client's first
    //   input yet (it waits out the jitter buffer's lead, `World::apply_inputs`), so there
    //   is no prediction at the ack to compare, and the correction installs the spawn and
    //   replays — the loading screen's, not the netcode's (80 of them in the review, all
    //   the server stepping a body before any input reached it);
    // - **a server trim**: the ack advanced by more seqs than the server ran ticks since
    //   the last snapshot, so the jitter buffer dropped inputs this client simulated (a
    //   burst past `INPUT_BACKLOG_TARGET`: the review's startup frame of 14, 11 trimmed,
    //   63.7 px). One step per tick is the rule (R89); more acked than ticked is a hitch.
    //   Only when the tick moved: two snapshots never share a tick outside a test.
    if (snap.lastInputSeq === 0 && this.pending.length > 0) this.unsettled = true
    if (
      this.lastTick !== null &&
      snap.tick > this.lastTick &&
      snap.lastInputSeq - prevAck > snap.tick - this.lastTick
    ) {
      this.unsettled = true
    }
    this.step = {
      ackStep: snap.lastInputSeq - prevAck,
      tickStep: snap.tick - (this.lastTick ?? snap.tick),
      pending: this.pending.filter((q) => q.input.seq > snap.lastInputSeq).length,
      stoodIn: explained,
      speed: Math.hypot(snap.state.vx, snap.state.vy),
      tick: snap.tick,
    }
    this.lastTick = snap.tick
    this.stats.lastAck = snap.lastInputSeq
    const ackErr = at ? Math.hypot(at.x - snap.state.x, at.y - snap.state.y) : Number.NaN
    if (at) this.stats.lastAckErrorPx = ackErr
    // The acked one is kept (T22.10D): the next snapshot may ack the same seq — a
    // player whose inputs stopped reaching the world (the results screen stops
    // sending) — and the gate needs the prediction there to compare with.
    for (const seq of this.predicted.keys()) if (seq < snap.lastInputSeq) this.predicted.delete(seq)
    while (this.pending.length && this.pending[0]!.input.seq <= snap.lastInputSeq) {
      this.pending.shift()
    }
    this.stats.pending = this.pending.length

    const local = this.state
    if (!local) return

    const err = Math.hypot(local.x - snap.state.x, local.y - snap.state.y)
    // **A positional epsilon must not gate a non-positional input to
    // `applyInput`** (T21.02).
    //
    // This early return exists so a good prediction is not snapped for nothing,
    // and it is a comparison of *positions*. `moveMods` is not a position: it
    // says how fast this body walks and how high it jumps, and the mirror reads
    // it every predicted tick. Gating it behind a position check would mean the
    // frame a player picks boots up, the mirror keeps predicting the old speed
    // until the error it causes grows past two pixels — a correction that only
    // fires *because* the mirror was told too late.
    //
    // So the gate is now "nothing this reconciler cares about has changed",
    // rather than "the position is close". When the passives move, the mirror's
    // model of the player has changed and its prediction is stale by
    // definition, so it takes the full correction — which is the one path that
    // already carries them. **No second setter**: this is the same
    // `setPlayerState` below, reached on one more condition.
    //
    // T20.19 and T20.21 were both a value the mirror needed arriving on a path
    // that could skip it. This is the third, caught before it shipped.
    // `alive` and `health` beside `moveMods`, for the same reason (T22.10D): the
    // mirror reads both every predicted tick (`alive` stops the body, `health` is
    // `speed_multiplier`'s input, T20.21), prediction never changes either, and the
    // gate below now holds while moving — so it can no longer be relied on to
    // carry them in on the position error.
    //
    // T22.10E F-6, said where it applies: **every other hidden value is not
    // re-installed while the position agrees.** Fuel, the mount, the jump buffer
    // and every cooldown reach the mirror only through the correction below, so a
    // server that changes one of them without moving the body leaves the mirror's
    // copy stale until something else corrects. Each is on this list only once a
    // misprediction it causes is measured; fuel shows up as a position error the
    // first tick a burn differs, which is what corrects it.
    const modsChanged = this.hiddenChanged(local, snap)
    // **T22.10D F8: the gate compares the prediction *at the ack* with the server's
    // state at the ack** — like with like. It compared the *current* prediction,
    // which is `pending` inputs further on: a body moving at `v` read `v·p·dt`
    // there however right it was, so the gate almost never held while moving (11
    // of 12 snapshots "corrected" under a vortex). With nothing pending the current
    // state *is* the prediction at the ack; with pending inputs and no record of
    // the acked one, there is nothing to compare, so it corrects.
    //
    // Velocity too: a knockback the prediction lacks leaves the position right at
    // the ack and wrong a snapshot later, so a velocity error that would carry the
    // body past the epsilon within one snapshot interval is corrected now.
    const ref = at ?? (this.pending.length === 0 ? local : null)
    if (ref !== null && this.agrees(ref, snap) && !modsChanged) {
      this.settle(ackErr)
      return
    }

    // Snap the simulation immediately. Letting it lag the truth compounds the
    // error into every prediction after it.
    const was = { x: local.x, y: local.y }
    const lifeChanged = local.alive !== snap.state.alive
    // T22.14C HIGH-1: from the movement state the mirror had **at the ack** (its
    // previous input, jump buffer, jetpack), not the newest one — or the first
    // replayed input's edges read against the last input pushed.
    this.core.correctPlayerState(this.localId, snap.lastInputSeq, snap.state)
    // The truth at the ack is now the prediction there, for a snapshot that acks it again.
    this.predicted.set(snap.lastInputSeq, { x: snap.state.x, y: snap.state.y, vx: snap.state.vx, vy: snap.state.vy })
    for (const { input, dt } of this.pending) {
      this.core.applyInput(this.localId, input.seq, input.buttons, input.aim, dt)
      const s = this.state
      if (s) this.predicted.set(input.seq, { x: s.x, y: s.y, vx: s.vx, vy: s.vy })
    }
    this.corrected(was, err, ackErr, lifeChanged)
  }

  /**
   * T22.10E F-3: `reconcile` while the phase takes no input. The same gate and
   * the same correction, keyed on the server tick instead of the (frozen) ack:
   * the local body runs one neutral tick per local step, each labelled with the
   * server tick it stands for, and a snapshot is compared with the local state
   * labelled with *its* tick. Both sides run the same neutral ticks through the
   * same compiled code, so a right prediction agrees however far ahead the
   * local body runs; a local body *behind* the snapshot first runs the ticks it
   * owes. A correction re-anchors the label on the snapshot and replays as many
   * neutral ticks as the local body was ahead — the pending replay's counterpart.
   */
  private reconcileNeutral(snap: LocalSnapshotView): void {
    const n = this.enterNeutral()
    // The anchoring reconcile at the bell (T22.10G review): nothing is labelled yet,
    // so this correction installs the server's post-bell state over inputs it dropped —
    // the bell's event, like a relocation, not a misprediction; kept out of the maxima.
    if (n.label === null) this.unsettled = true
    if (n.bell) {
      n.bell.frozen = true
      const b = n.bell.at.get(snap.tick)
      if (b) this.stats.bellErrorPx = Math.hypot(b.x - snap.state.x, b.y - snap.state.y)
      if (snap.tick >= n.bell.label) n.bell = null
    }
    this.stats.lastAck = snap.lastInputSeq
    // `ackStep` 0 marks a results-screen correction in `worstJump`.
    this.step = {
      ackStep: 0,
      tickStep: snap.tick - (this.lastTick ?? snap.tick),
      pending: 0,
      stoodIn: false,
      speed: Math.hypot(snap.state.vx, snap.state.vy),
      tick: snap.tick,
    }
    this.lastTick = snap.tick
    const local = this.state
    if (!local) return
    const dt = C().SIM_DT
    // Owed ticks are one frame's worth at most (`MAX_FRAME_DT`, the fixed step's
    // own ceiling); further behind than that, the local clock has lost the server's
    // (a hidden tab) and the correction re-anchors instead.
    if (n.label !== null && snap.tick - n.label > C().MAX_FRAME_TICKS) {
      n.label = null
      // Lost time (T22.10F): the re-anchor is the hitch's correction, not a misprediction.
      this.unsettled = true
    }
    while (n.label !== null && n.label < snap.tick) this.stepNeutral(n, snap.lastInputSeq, this.lastAim, dt)
    const at = n.label !== null ? n.at.get(snap.tick) : undefined
    for (const t of n.at.keys()) if (t < snap.tick) n.at.delete(t)
    const ackErr = at ? Math.hypot(at.x - snap.state.x, at.y - snap.state.y) : Number.NaN
    if (at) this.stats.lastAckErrorPx = ackErr
    if (at && this.agrees(at, snap) && !this.hiddenChanged(local, snap)) {
      this.settle(ackErr)
      return
    }
    const now = this.state ?? local
    const was = { x: now.x, y: now.y }
    const err = Math.hypot(now.x - snap.state.x, now.y - snap.state.y)
    const ahead = n.label !== null ? n.label - snap.tick : 0
    // Not `correctPlayerState`: every neutral tick runs under the one frozen seq, so
    // the mirror's copy "at the ack" is its newest — and a neutral tick has no edges.
    this.core.setPlayerState(this.localId, snap.state)
    n.label = snap.tick
    n.at.clear()
    n.at.set(snap.tick, { x: snap.state.x, y: snap.state.y, vx: snap.state.vx, vy: snap.state.vy })
    for (let i = 0; i < ahead; i++) this.stepNeutral(n, snap.lastInputSeq, this.lastAim, dt)
    this.corrected(was, err, ackErr, local.alive !== snap.state.alive)
  }

  /**
   * T22.10F: **the local body stands in exactly as the server does.** The fixed step
   * produces a frame's inputs at the frame's end, for ticks the server has already
   * run — and under R89 it ran them, as stand-ins with the newest held input, and
   * acks them. A snapshot acking seqs this client has not pushed yet is therefore
   * the normal case on a slow page (every frame at 15 fps), not a gap: comparing it
   * with the state at the last pushed seq read the stand-in ticks as an error,
   * installed the server's state, and then applied the late inputs on top — a tick
   * counted twice and corrected back, on every snapshot (145 corrections in one
   * `crates` run). So the local body runs the same stand-ins — the last pushed
   * buttons and aim — labelled with those seqs, and the gate compares like with
   * like; the late inputs are skipped when they are pushed. Only within
   * `MAX_FRAME_TICKS` of the last pushed seq, the server's own claim ceiling (a
   * wider gap is a rematch or lost time). Returns whether it stood in.
   */
  private standIn(ack: number): boolean {
    const from = Math.max(this.lastPushed, this.stoodIn)
    if (this.lastPushed === 0 || ack <= from) return false
    if (ack - this.lastPushed > C().MAX_FRAME_TICKS) return false
    const dt = C().SIM_DT
    for (let seq = from + 1; seq <= ack; seq++) {
      this.core.applyInput(this.localId, seq, this.lastButtons, this.lastAim, dt)
      const s = this.state
      if (s) this.predicted.set(seq, { x: s.x, y: s.y, vx: s.vx, vy: s.vy })
    }
    this.stoodIn = ack
    return true
  }

  /** Enter the no-input prediction (T22.10E F-3): nothing kept is worth replaying. */
  private enterNeutral(): Neutral {
    if (this.neutral) return this.neutral
    // Every input pending was predicted from, and none will ever be acked: the
    // server dropped its queue at the bell (T21.30).
    this.pending.length = 0
    // T22.12D F1: before they go, the predictions keyed by the tick each seq ran on.
    let bell: Neutral['bell'] = null
    const anchor = this.anchor()
    if (anchor && this.stats.lastAck > 0 && this.predicted.size > 0) {
      const at = new Map<number, Kinematics>()
      let label = -Infinity
      for (const [seq, k] of this.predicted) {
        const t = tickAtSeq(seq, anchor)
        at.set(t, k)
        label = Math.max(label, t)
      }
      bell = { at, label, frozen: false }
    }
    this.predicted.clear()
    this.stats.pending = 0
    this.neutral = { label: null, at: new Map(), bell }
    return this.neutral
  }

  /** One neutral tick — no buttons, as the server's — labelled once anchored. */
  private stepNeutral(n: Neutral, seq: number, aim: number, dt: number): void {
    this.core.applyInput(this.localId, seq, 0, aim, dt)
    const s = this.state
    if (s && !this.started) {
      this.render = { x: s.x, y: s.y }
      this.started = true
    }
    if (n.bell && !n.bell.frozen && s) {
      n.bell.label++
      n.bell.at.set(n.bell.label, { x: s.x, y: s.y, vx: s.vx, vy: s.vy })
    }
    if (n.label === null || !s) return
    n.label++
    n.at.set(n.label, { x: s.x, y: s.y, vx: s.vx, vy: s.vy })
  }

  /**
   * The gate's position half (T22.10D F8): at the prediction for the snapshot's
   * moment, position within `RECONCILE_EPSILON_PX`, and a velocity error that
   * would not carry it past that within one snapshot interval.
   */
  private agrees(ref: Kinematics, snap: LocalSnapshotView): boolean {
    const eps = C().RECONCILE_EPSILON_PX
    return (
      Math.hypot(ref.x - snap.state.x, ref.y - snap.state.y) <= eps &&
      Math.hypot(ref.vx - snap.state.vx, ref.vy - snap.state.vy) / C().SNAPSHOT_HZ <= eps
    )
  }

  /** The gate's other half: a value `applyInput` reads that prediction never changes. */
  private hiddenChanged(local: PlayerState, snap: LocalSnapshotView): boolean {
    return (
      local.moveMods !== snap.state.moveMods ||
      local.alive !== snap.state.alive ||
      local.health !== snap.state.health
    )
  }

  /** A snapshot the prediction agreed with. */
  private settle(ackErr: number): void {
    if (this.unsettled) {
      this.unsettled = false
      this.stats.settled++
    } else this.noteAckError(ackErr)
  }

  /**
   * The bookkeeping of a correction that moved the body from `was`. `lifeChanged`:
   * the snapshot flips `alive` (T22.10E review, (a)) — a void death freezes the
   * server's body where it died while the local copy fell on, so its jump is the
   * death's, not the prediction's, and stays out of the maxima like a relocation.
   * (Explosion knockback is not excluded: it is unpredictable by design — the
   * client never simulates projectiles — and its correction is a real one.)
   */
  private corrected(was: { x: number; y: number }, err: number, ackErr: number, lifeChanged = false): void {
    this.stats.corrections++
    this.stats.lastCorrectionPx = err
    this.stats.maxCorrectionPx = Math.max(this.stats.maxCorrectionPx, err)
    const now = this.state
    if (now) {
      this.stats.lastJumpPx = Math.hypot(now.x - was.x, now.y - was.y)
      this.stats.maxJumpPx = Math.max(this.stats.maxJumpPx, this.stats.lastJumpPx)
    }
    // On how far the correction **moved** the body (T22.10D F8), not on `err`:
    // `err` includes the pending travel, so a fast body on a slow page read past
    // `SNAP_PX` on a correction of a few pixels and teleported the render.
    if (now && this.stats.lastJumpPx > SNAP_PX) {
      this.stats.snaps++
      this.render = { x: now.x, y: now.y }
      this.unsettled = false
    } else if (this.unsettled || lifeChanged) {
      // T22.10E F-4: the first correction after a relocation or an ack gap is
      // the event's, whatever its size — counted, not folded into the maxima.
      // So is a death or a respawn (above).
      this.unsettled = false
      this.stats.settled++
    } else {
      if (this.stats.lastJumpPx > this.stats.maxEasedJumpPx && this.step) {
        this.stats.worstJump = { ...this.step, px: this.stats.lastJumpPx, ackErrorPx: ackErr }
      }
      this.stats.maxEasedJumpPx = Math.max(this.stats.maxEasedJumpPx, this.stats.lastJumpPx)
      this.noteAckError(ackErr)
    }
  }

  /**
   * Fold an error at the ack into `maxAckErrorPx`, **unless it is a relocation**:
   * past `SNAP_PX` the prediction there was across the map (a `relocate` already
   * moved the body, and the snapshot arrives acking an input from before it), and
   * a maximum that includes those measures the map, not the netcode.
   */
  private noteAckError(err: number): void {
    if (Number.isFinite(err) && err <= SNAP_PX) this.stats.maxAckErrorPx = Math.max(this.stats.maxAckErrorPx, err)
  }

  /**
   * The server moved us: a pad (`teleport`) or a vortex trip (`vortex_trip`,
   * T22.10B). **One handler for both** — `GameScene.onRelocated` — because they are
   * one event with two sources, and the arrival is a teleport's either way: at
   * `(x, y)`, at rest (`World::fire_pads` / `step_vortices` assign a fresh body).
   *
   * Snaps the simulation *and* the render, for `SNAP_PX`'s reason: easing a
   * relocation across the map reads as the camera sliding. Skipped when the
   * prediction is already there — a snapshot reconciled it first — so an event
   * arriving second cannot undo the replay of inputs sent since. Returns whether
   * it snapped.
   *
   * **A short relocation is still the event's** (T22.12D F3): the dev hook's
   * placement moves the body tens of pixels (44 in `black-hole`), under `SNAP_PX`,
   * so it did not snap — and the snapshot after it counted the move as a 44 px
   * misprediction. Past the reconcile gate, and not far enough to snap, it is left
   * to that snapshot (which may already have come) but that correction is the
   * relocation's: kept out of the maxima, like the one after a snap.
   *
   * **Measured at the event's `tick`, not now** (T22.12E F1). `tick` is the first
   * server tick whose state holds the move (the event's own tick for a pad or a
   * trip, stepped then; one past it for a dev placement, made between ticks). A
   * snapshot at or past it already reconciled the move into the prediction, so
   * there is nothing to mark — and comparing with the current prediction, a lead
   * ahead, made a *moving* body look unexplained and hid the next correction, a
   * genuine misprediction included. Before its snapshot, the arrival is compared
   * with the prediction **at that tick** (the seq that ran on it, `lastTick + seq −
   * ack` as `bellErrorPx` keys it), so a move the core predicted itself (a vortex
   * trip) marks nothing either; the current prediction only when there is none.
   */
  relocate(x: number, y: number, tick: number): boolean {
    const s = this.state
    if (!s) return false
    if (this.lastTick !== null && Number.isFinite(tick) && this.lastTick >= tick) return false
    const d = Math.hypot(s.x - x, s.y - y)
    if (d <= SNAP_PX) {
      const then = this.predictionAt(tick) ?? s
      if (Math.hypot(then.x - x, then.y - y) > C().RECONCILE_EPSILON_PX) this.unsettled = true
      return false
    }
    this.core.setPlayerState(this.localId, { ...s, x, y, vx: 0, vy: 0, grounded: false })
    this.render = { x, y }
    this.stats.snaps++
    // T22.10E F-4: the next snapshot may still ack an input from before the trip.
    this.unsettled = true
    return true
  }

  /** Where the prediction left the body at server tick `tick`, if a pending seq ran on it. */
  private predictionAt(tick: number): Kinematics | undefined {
    const anchor = this.anchor()
    if (!anchor || !Number.isFinite(tick)) return undefined
    return this.predicted.get(seqAtTick(tick, anchor))
  }

  /** The last reconciled snapshot's seq ↔ tick anchor (`seqClock.ts`), or `null` before one. */
  private anchor(): SeqAnchor | null {
    return this.lastTick === null ? null : { ack: this.stats.lastAck, tick: this.lastTick }
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
