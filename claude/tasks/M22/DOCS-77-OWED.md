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
   **R89's buffer, as built (T22.10G):** the expected seq *starts* `INPUT_BACKLOG_TARGET` behind the newest sent — a
   client's first input waits that many ticks unless more are already queued (a trim, which runs newest − target and
   keeps the target: the same lead). World-numbered (seq 0) inputs do not wait. **Before its first input a player is
   not stepped in `Lobby`/`Warmup`** (what the client predicts from; bounded by the warmup, since joins are refused
   mid-match); in `Playing` it gets a neutral step claiming no seq. `REPLAY_VERSION` 19.
4. **docs/42 §2:** the reconcile gate compares the prediction *at the acked seq* (position ≤ eps and
   |Δv|/`SNAPSHOT_HZ` ≤ eps) plus moveMods, alive, health; the acked prediction is kept for repeated acks; the render
   snap keys on the correction jump > 64 px. **The client's fixed step runs on the wall clock** (`performance.now()`),
   capped per frame at `MAX_FRAME_DT` — under R89 a client simulating slower than real time disagrees with every
   stand-in (Phaser's smoothed `delta` clamps unfocused pages to 16.7 ms/frame). Its first frame elapses 0 (T22.10G: the boot's
   `delta` sent a first burst of 14–15 inputs the jitter buffer trimmed). **In a phase that takes no input
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
6. **Quantization (T22.10H, ruled by the coordinator):** docs/40 §3's player record grows to
   `SNAPSHOT_PLAYER_BYTES` 28: position and velocity are four **`i32` counts of `SNAPSHOT_QUANTUM` (1/8 px, 1/8
   px/s), rounded** half away from zero (they were `i16` whole px, truncated). The range arithmetic is at the
   constant: an `i16` of eighths stops at ±4095.875, short of `MAP_LARGE_W`, and upward velocity is unclamped. Health
   stays the floored `u8` — `speed_multiplier` reads `health.floor()`, so the floor is the parity rule. New constant
   `SNAPSHOT_QUANTUM` 0.125 (exported to the client). Replays store inputs, not snapshots: `REPLAY_VERSION` unchanged.
   Measured (worst `lastAckErrorPx` per client, 2 runs each): `radiation-match` 2.12–2.61 → 1.40–2.24 px,
   `breach-vortex` 2.02–2.25 → 2.08–2.23 px (its pull arm 1.00–1.09 → 0.10–0.13 px), `black-hole`'s pull arm 1.26 →
   0.19 px. Check slacks derive from it: `black-hole` ε + √2·q (was ε + √2), `thrusters-match` after the bell
   ε + √2·q·(1 + 3 s)/2 (was 2ε).

## The black hole (T22.12A/B, rewritten by T22.12C for R90–R93)
7. **New constants:** `BLACK_HOLE_WINDOW` 60, `BLACK_HOLE_LATEST` 10, `BLACK_HOLE_TELEGRAPH` 2,
   `BLACK_HOLE_HORIZON_R` = `SPACE_ASTEROID_R_MAX`, `BLACK_HOLE_ESCAPE_MARGIN` 0.9, `BLACK_HOLE_EDGE_PULL` =
   `JETPACK_THRUST_DOWN` × margin (810), `BLACK_HOLE_REACH` = 4 × horizon (256), `BLACK_HOLE_ACCEL_MAX` =
   `EDGE_PULL / (1 − HORIZON_R / REACH)` (1080). **Not** `BLACK_HOLE_CAPTURE_R` / `BLACK_HOLE_THRUST_BOUND`
   (T22.12A's; deleted by R90). **New events** `black_hole {tick, x, y}` and `black_hole_warn {tick, x, y,
   arrives_in}` (both Everyone; both in the join catch-up); **new death cause** `"black_hole"`; dev-only
   `debug_black_hole {dist?, warn?}`. `REPLAY_VERSION` 21. `SNAPSHOT_QUANTUM` is point 6's.
8. **Rules for docs/13-or-a-space-section:** one per space round, arriving uniformly in `[end − W, end − W/6]`
   s where `W` = 60 s, or on a round shorter than 62 s the round's length less the telegraph (scaled, not
   clipped); **telegraphed 2 s before** at the spot (`black_hole_warn`); at the centre of one asteroid it removes
   (list, mask, well) — never the last one. Pull through the shared attractor sum, linear from 1080 px/s² at the
   centre to 0 at the reach — **810 at the horizon, under the weakest thrust (DOWN 900), so outside the horizon
   every thrust escapes and inside it you die: the horizon is the one rule, and the ring drawn at it is the
   line** (R90). **Within its reach the asteroid wells do not pull** (R91). A black-hole death **drops nothing**
   (R92). Frozen and still drawn after the bell — and with the wells muted inside its reach, nothing there pulls
   then; the death is named the hole's only while it pulls (F9). Shown on the minimap (R93). Respawns, mid-round
   joins and vortex trips never inside its reach. *(T22.12C's "the round ends on the tick nearest its deadline,
   `phase_time_left() ≤ SIM_DT/2`" is superseded by point 9.)* A client derives the bell from `round_state`'s
   `ends_tick` (point 9): the first input seq stepped in `Ended` is `ack + ends_tick − snap_tick + 1`.

## Round phases in ticks (T22.12D, R94)
9. **docs/41 §2–3 (round lifecycle) and docs/40 `round_state`:** every phase is **counted in ticks**. A phase of
   `s` seconds (`WARMUP_SECONDS`, the round length, `ENDED_SECONDS`) begins on the tick `set_phase` runs and is
   stepped for exactly round(`s` × `SIM_HZ`) ticks — a 240 / 300 / 600 s round is 14400 / 18000 / 36000 `Playing`
   ticks (it was 14401 / 18002 / 36006: an `f32` sum reaching a float deadline). Warmup, Playing and the Ended vote
   window all end by that one rule. `round_state` gains **`ends_tick`** (integer, the last tick stepped in the phase;
   `null` in `lobby`), and `time_left` is derived from it (`(ends_tick − tick) / SIM_HZ`; `null` in `lobby`, as
   before). **The round clock is derived from the step count**, not summed: `round_time` at `k` steps is `k /
   SIM_HZ` correctly rounded (plus the dev `DEV_ROUND_CLOCK` origin). What moved with it: the day/night cycle and
   the weather schedule by the old drift (−6 … +1 ticks inside 600 s; the golden weather table regenerated), the
   Ended window 1201 → 1200 ticks. `REPLAY_VERSION` 22. Dev-only: a `relocate {tick, id, x, y}` event (Everyone)
   for the black-hole dev hook's placement (T22.12D F3).

## Other M22 points already recorded elsewhere
- `docs/13` §7 "never a hazard position" is contradicted by lava and the solar flare (T22.08A).
- `docs/13`, `docs/14`, `docs/10` describe behaviour space overrides; `docs/20-player-movement.md` still refuses fall
  damage outright (TASKS.md M22 section).
