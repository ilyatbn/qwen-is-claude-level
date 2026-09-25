/**
 * **The one seq ↔ tick mapping** (T22.14C LOW-5), and the round clock's
 * monotonic reading (MED-3).
 *
 * A snapshot says input seq `ack` ran on server tick `tick`. Under R89 the server
 * steps every player exactly once a tick, one seq each, so from that anchor seq
 * `ack + k` runs on tick `tick + k` — until the next snapshot re-anchors (a trim or a
 * lost frame moves the offset, which is why every caller re-derives from the latest
 * anchor rather than keeping a seq it computed once).
 *
 * It had three spellings: the bell's (`black_hole::bell_seq` in Rust, fed an anchor
 * from `GameScene`), `Predictor.enterNeutral`'s (tick of a predicted seq) and
 * `Predictor.predictionAt`'s (seq of a relocation's tick). The vortices' and the
 * black hole's switch-over (LOW-4) is the fourth reader; there is one spelling.
 *
 * **An event on tick `t` changes the steps from tick `t + 1` on**: `World::step` runs
 * `apply_inputs` first, then opens and closes vortices, brings the black hole and
 * advances the phase — so the seq the event first affects is `firstSeqAfter(t)`. The
 * bell is the same rule with `t` = `ends_tick`, the last tick stepped in `Playing`.
 * `game-core`'s `the_bell_predicted_at_round_start_is_the_servers` checks it against
 * the server for every round length.
 */

/** Input seq `ack` ran on server tick `tick` (a snapshot's footer and header). */
export interface SeqAnchor {
  ack: number
  tick: number
}

/** The input seq that runs (or ran) on server tick `tick`. */
export function seqAtTick(tick: number, a: SeqAnchor): number {
  return a.ack + (tick - a.tick)
}

/** The server tick input seq `seq` runs (or ran) on. */
export function tickAtSeq(seq: number, a: SeqAnchor): number {
  return a.tick + (seq - a.ack)
}

/**
 * The first input seq stepped **after** something the server did on tick `tick` —
 * clamped at 0, because the core takes a `u32` and "before every seq" is 0 there.
 */
export function firstSeqAfter(tick: number, a: SeqAnchor): number {
  return Math.max(0, seqAtTick(tick + 1, a))
}

/**
 * T22.14C MED-3: the round clock a frame reads — the server's exact round time as the
 * newest snapshot carried it, extrapolated by the frames since, **never stepped
 * back**. A snapshot arriving later than the last (jitter) says the server was
 * further behind than the local extrapolation assumed; taking it as-is stepped the
 * clock back every such snapshot (the death countdown and the flare ribbon both read
 * it). The largest of the two is also the least-delayed estimate, `ServerClock`'s
 * rule. A **restart** (the server's clock below the last one it sent) is adopted
 * whole, and so is a local clock more than `maxLead` ahead (`MAX_FRAME_DT`: more
 * than one frame's worth is not arrival jitter but a clock that ran fast, and
 * keeping the larger would keep it fast for the rest of the round).
 */
export function roundClockOnSnapshot(local: number, server: number, lastServer: number, maxLead: number): number {
  if (server < lastServer || local - server > maxLead) return server
  return Math.max(local, server)
}
