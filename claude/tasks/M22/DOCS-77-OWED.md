# docs/77 — what the M22 amendment must say (collected as it is found)

The coordinator writes `docs/77-amendments-v9.md` when M22 lands (CLAUDE.md). Builders never edit `docs/`; points
that surface mid-milestone are collected here so they are not lost. Each names its source.

## The input path (T22.10B/T22.10D, from the review of `d2d4c07`; points 3–6 rewritten by T22.10F for R89)
1. **docs/40 §2 `input`:** redundancy no longer means "a dropped packet costs nothing" — every input of a frame is
   sent, in `inputPackets` chunks of `INPUT_REDUNDANCY`. Replace "at most `MAX_INPUT_QUEUE` (8) … per tick are
   processed" with: the room accepts ≤ `MAX_INPUT_QUEUE` = `MAX_FRAME_TICKS` = ceil(`MAX_FRAME_DT`·`SIM_HZ`) = 15 per
   player per tick as a flood guard; excess newest dropped and logged. Same change to the docs/40 test-list line
   ("more than MAX_INPUT_QUEUE in a tick").
2. **New constants:** `MAX_FRAME_DT` 0.25 (shared server/client), `MAX_FRAME_TICKS` 15, `INPUT_BACKLOG_TARGET` 2.
3. **docs/70 §A30:** `MAX_INPUT_QUEUE` 15, not 8, and only the room's per-tick flood guard. "Exactly one input per
   tick" becomes **one simulated step per player per tick (R89, T22.10F)**: every live player is stepped every tick
   the phase takes input — the next expected input if it has arrived, else a **stand-in**: the newest received input's
   held buttons and aim under the next seq (edges are current-vs-previous, so nothing re-fires; `fire`/`use_item`/
   `select_slot` are commands and never stood in). The expected seq advances one per simulated tick, real or stand-in;
   an input at or below it is discarded (after it has updated the held state); future inputs wait in a jitter buffer
   of `INPUT_BACKLOG_TARGET` (2), the **oldest** excess dropped and the seq jumping past them. Never two steps in a
   tick, no standing delay, no hover. A stand-in claims a seq only within `MAX_FRAME_TICKS` of the newest seq sent,
   and none before the first (a client that lost time past one capped frame is otherwise locked out). An input with
   seq 0 is numbered next by the world (bots; no client can send 0). **The T22.10D/E catch-up credit is withdrawn** —
   it was never in a doc; do not add it.
4. **docs/42 §2:** the reconcile gate compares the prediction *at the acked seq* (position ≤ eps and
   |Δv|/`SNAPSHOT_HZ` ≤ eps) plus moveMods, alive, health; the acked prediction is kept for repeated acks; the render
   snap keys on the correction jump > 64 px. **The client's fixed step runs on the wall clock** (`performance.now()`),
   capped per frame at `MAX_FRAME_DT` — under R89 a client simulating slower than real time disagrees with every
   stand-in (Phaser's smoothed `delta` clamps unfocused pages to 16.7 ms/frame). **In a phase that takes no input
   (`Ended`, T22.10E F-3)** the client keeps no inputs for replay (pending and the per-seq predictions are cleared at
   the bell), steps its own body one neutral tick per local step exactly as the server does
   (`RoundPhase::accepts_input`, read through the wasm core), and reconciles on the snapshot's **tick** instead of the
   frozen ack: the local state labelled with that tick is compared by the same gate; a correction re-anchors and
   replays the neutral ticks the local body was ahead (with the last aim); a local body behind by more than
   `MAX_FRAME_TICKS` re-anchors instead of catching up. The snapshot tick is therefore part of what the client's
   reconciliation reads. Also: the gate re-installs only position/velocity-visible state plus moveMods, alive,
   health — fuel, mount, jump buffer and cooldowns are not re-installed while the position agrees.
5. **The snapshot ack** is the last *simulated* seq, real or stand-in (`World::last_simulated_seq`; T22.10F — T22.10B
   made it the last consumed, not the last received).
6. **Quantization (for the coordinator, not yet a rule):** snapshot velocity is `as i16` whole px/s; a free-flying
   zero-g body re-anchored on it drifts past `RECONCILE_EPSILON_PX` within ~1.5 s at ~500 px/s (T22.10F,
   `thrusters-match`'s results screen). A finer quantum would need a wire change.

## Other M22 points already recorded elsewhere
- `docs/13` §7 "never a hazard position" is contradicted by lava and the solar flare (T22.08A).
- `docs/13`, `docs/14`, `docs/10` describe behaviour space overrides; `docs/20-player-movement.md` still refuses fall
  damage outright (TASKS.md M22 section).
