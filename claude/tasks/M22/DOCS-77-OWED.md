# docs/77 — what the M22 amendment must say (collected as it is found)

The coordinator writes `docs/77-amendments-v9.md` when M22 lands (CLAUDE.md). Builders never edit `docs/`; points
that surface mid-milestone are collected here so they are not lost. Each names its source.

## The input path (T22.10B/T22.10D, from the review of `d2d4c07`)
1. **docs/40 §2 `input`:** redundancy no longer means "a dropped packet costs nothing" — every input of a frame is
   sent, in `inputPackets` chunks of `INPUT_REDUNDANCY`. Replace "at most `MAX_INPUT_QUEUE` (8) … per tick are
   processed" with: the room accepts ≤ `MAX_INPUT_QUEUE` = `MAX_FRAME_TICKS` = ceil(`MAX_FRAME_DT`·`SIM_HZ`) = 15 per
   player per tick as a flood guard; excess newest dropped and logged. Same change to the docs/40 test-list line
   ("more than MAX_INPUT_QUEUE in a tick").
2. **New constants:** `MAX_FRAME_DT` 0.25 (shared server/client), `MAX_FRAME_TICKS` 15, `INPUT_BACKLOG_TARGET` 2.
3. **docs/70 §A30:** `MAX_INPUT_QUEUE` 15, not 8. "Exactly one input per tick" becomes: one per tick, plus one extra
   while the backlog is above `INPUT_BACKLOG_TARGET` and the player has credit; invariant: inputs consumed never
   exceed ticks elapsed. Backlog cap 15 still drops the oldest. **The credit rule (T22.10E F-1):** one credit per
   tick with no input, capped at `MAX_FRAME_TICKS`, earned **only while the player is alive and the phase accepts
   input** (zero while dead, so a respawn starts at zero); **cleared at the end of any tick in which the player
   consumed an input and has ≤ `INPUT_BACKLOG_TARGET` left** (credit pays only for the gap just before a burst); zeroed
   on every phase transition (so Warmup's silence never pays for Playing). Without it: bank while dead, dash at 2×
   later (5.00 px/tick vs 2.50, measured in the review of `d2d4c07`).
4. **docs/42 §2:** the reconcile gate compares the prediction *at the acked seq* (position ≤ eps and
   |Δv|/`SNAPSHOT_HZ` ≤ eps) plus moveMods, alive, health; the acked prediction is kept for repeated acks; the render
   snap keys on the correction jump > 64 px. **In a phase that takes no input (`Ended`, T22.10E F-3)** the client keeps
   no inputs for replay (pending and the per-seq predictions are cleared at the bell), steps its own body one neutral
   tick per local step exactly as the server does (`RoundPhase::accepts_input`, read through the wasm core), and
   reconciles on the snapshot's **tick** instead of the frozen ack: the local state labelled with that tick is
   compared by the same gate; a correction re-anchors and replays the neutral ticks the local body was ahead. The
   snapshot tick is therefore part of what the client's reconciliation reads. Also: the gate re-installs only
   position/velocity-visible state plus moveMods, alive, health — fuel, mount, jump buffer and cooldowns are not
   re-installed while the position agrees.
5. **The snapshot ack** is the last *consumed* seq (`Room::last_seqs`), not the last received (T22.10B).

## Other M22 points already recorded elsewhere
- `docs/13` §7 "never a hazard position" is contradicted by lava and the solar flare (T22.08A).
- `docs/13`, `docs/14`, `docs/10` describe behaviour space overrides; `docs/20-player-movement.md` still refuses fall
  damage outright (TASKS.md M22 section).
