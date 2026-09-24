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
   exceed ticks elapsed. Backlog cap 15 still drops the oldest. The credit rule as fixed by T22.10E (alive only,
   cleared once caught up, reset on respawn and at Playing).
4. **docs/42 §2:** the reconcile gate compares the prediction *at the acked seq* (position ≤ eps and
   |Δv|/`SNAPSHOT_HZ` ≤ eps) plus moveMods, alive, health; the acked prediction is kept for repeated acks; the render
   snap keys on the correction jump > 64 px. State what the client does in `Ended` (T22.10E).
5. **The snapshot ack** is the last *consumed* seq (`Room::last_seqs`), not the last received (T22.10B).

## Other M22 points already recorded elsewhere
- `docs/13` §7 "never a hazard position" is contradicted by lava and the solar flare (T22.08A).
- `docs/13`, `docs/14`, `docs/10` describe behaviour space overrides; `docs/20-player-movement.md` still refuses fall
  damage outright (TASKS.md M22 section).
