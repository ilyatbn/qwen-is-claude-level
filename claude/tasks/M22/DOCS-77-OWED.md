# docs/77 — what the M22 amendment must say (collected as it is found)

The coordinator writes `docs/77-amendments-v9.md` when M22 lands (CLAUDE.md). Builders never edit `docs/`; points
that surface mid-milestone are collected here so they are not lost. Each names its source.

**Closed 2026-09-25: every point below is in [`docs/77-amendments-v9.md`](../../docs/77-amendments-v9.md)** —
points 1–5 in §H13, 4/19/20/26 in §H16, 6/18/25 in §H15, 7–8/11/12/16 in §H11, 9 in §H14, 10/11/21 in §H10,
13–14 in §H12, 15/27 in §H4, 17/24 in §H19, 22 in §H11, 23 in §H12. Kept as the record of where each came from.

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

## The summed wells (T22.03G, R96)
10. **The asteroid wells' sum is capped at `SPACE_WELL_ACCEL_MAX`** (= `JETPACK_THRUST_DOWN` ×
    `SPACE_WELL_ESCAPE_MARGIN`, 675 px/s²): each well was already under it, their sum was not ((18, −919) px/s² under a
    rock ceiling at seed 451383 held a body in every direction). One clamp in the one summation, on both sides. **Wells
    only** — the breach vortex and the black hole add on top, uncapped. `REPLAY_VERSION` 23.
    **Superseded in part by R97 (T22.03I):** the wells **and every live vortex's pull** are summed and capped
    together at `SPACE_WELL_ACCEL_MAX`; only the black hole adds on top, uncapped. So outside a vortex's capture
    radius (`VORTEX_CAPTURE_R`) thrust always escapes; inside it the vortex takes the body (unchanged). The vortex's
    own doc text — "thrust wins only beyond half the reach", "no-escape radius `VORTEX_REACH / 2`" — must not reach
    docs/77. `REPLAY_VERSION` 24.

## Other M22 points already recorded elsewhere
- `docs/13` §7 "never a hazard position" is contradicted by lava and the solar flare (T22.08A).
- `docs/13`, `docs/14`, `docs/10` describe behaviour space overrides; `docs/20-player-movement.md` still refuses fall
  damage outright (TASKS.md M22 section).

## The final audit's hazards (T22.14A; R99 and the H3 ruling are in its addenda)
11. **Amends point 8 (R91):** within the black hole's reach **neither the asteroid wells nor any vortex pulls** — only
    the hole (H1: a capped vortex pull of 675 on top of the hole's 810 dragged bodies in from outside the horizon). A
    vortex still *captures* there (by radius), so no exit through the rim opens.
12. **Amends point 8's placement sentence:** respawns, mid-round joins and vortex trips keep clear of the hole's reach
    **from the telegraph on** (`World::black_hole_site`: warned or here), not only once it is here (H2).
13. **docs/13 (weather) and docs/41 §3:** weather-sourced damage is refused in `Ended`, as in Warmup. New constant
    `METEOR_FALL_TIME` = 2 × `PROJECTILE_MAX_LIFETIME` (16 s); a shower's `Active` phase is `METEOR_DURATION` +
    `METEOR_FALL_TIME` (meteors drop only in the first `METEOR_DURATION`), so `effect_start.duration` for a shower is
    26 s and a shower rolled within 29 s of the bell is refused (H3; the standard weather golden lost one row).
14. **Space's shower (R99), for the space section:** meteors start `METEOR_SPACE_INSET` (= one tick's flight) inside
    the rim's inner face at a random angle and fly at a random asteroid at `METEOR_SPEED`; weather ordnance that
    reaches the rim — past its inner face, or an impact whose blast would bite it — despawns without carving, damage or
    fragments (`projectile_despawn` reason `void`). The rim breaks only from player weapons. A space block joins the
    weather golden.
15. **docs/40 `map_init`:** one new byte after `theme` — the map's generator (`0` v1, `1` v2, `2` space; any other value
    refused). `MapMeta` gains `generator`, the one answer to "is this a space map?" (it was the asteroid list being
    non-empty, which the black hole mutates). The client installs it before `loadMask`. The day/night darkness is zero on
    a space *map* (was keyed on the gravity field).
16. **The black hole's picture:** the disc and the accretion ring are full size from the arrival frame; only the
    decoration swells in (`BLACK_HOLE_GROW_MS`). The vortex swirl is sized off the capture ring (drawing only), not
    `VORTEX_REACH / 2`.
17. `REPLAY_VERSION` 25 (H1, H2, H3, R99; no layout change).

## The final audit's netcode (T22.14C; R100 is the coordinator's ruling, recorded in its "As ruled")
18. **docs/40 §3 snapshot header:** `round_time` is the server's `f32`, exact (it was a `u16` of deciseconds,
    truncated); `SNAPSHOT_HEADER_BYTES` 8 → 10, so 182 B at 6 players. A death countdown never reads more than
    `RESPAWN_DELAY`, and the client's round clock is never stepped back by a late snapshot (a restart, or a local
    lead past `MAX_FRAME_DT`, is adopted whole).
19. **docs/42 §2 (amends point 4's last sentence):** a correction restores the mirror's movement state **at the acked
    seq** — previous input, jump buffer, jetpack state, airborne ticks — before it installs the snapshot, so the replay
    steps from where the server's step did (`GameCore::correct_player_state`; `PREDICTION_HISTORY_TICKS` = 2 × `SIM_HZ`
    seqs kept, client-only; an older ack falls back to the current state). The mirror advances a dead player's input
    stream as the server does (the seq and `prev_input`, the body still), and `alive` false → true resets jump,
    jetpack and airborne ticks as `PlayerState::respawn` does. Position/velocity-visible state is still the only thing
    that *triggers* a correction.
20. **docs/42 (the bell and the attractors, amends point 8's last sentence):** one seq ↔ tick rule on the client —
    seq `ack` ran on tick `snap_tick`, one a tick, so something the server did on tick `t` first changes seq
    `ack + t − snap_tick + 1`. From the bell's seq (`t` = `ends_tick`) the prediction steps as the server's `Ended`:
    **no buttons and no hole pull** (one rule; the buttons used to wait for `ended` to be heard). A vortex pulls for
    the seqs from its `vortex_open` tick's to its `vortex_close` tick's, and the black hole from its arrival tick's,
    re-derived on every snapshot while the phase takes input (in `Ended`, at once). `MAX_FRAME_TICKS` and
    `METEOR_DURATION` join `constants_json`.
21. **R100, for the space section (amends points 8, 10, 11):** a winged player (wings, not mounted — the flying
    regime) in space feels **no field**: not the asteroid wells, not a vortex's pull, and — the builder's measured
    reading of "decide whether the hole's outer pull applies" — **not the black hole's pull either**: with it, 26 of
    208 winged flights from one pixel outside the horizon died (wings' horizontal control is below the hole's
    810 px/s² there), which breaks R90's "outside the horizon every escape works"; without it, 0. A vortex still takes
    a winged player inside its capture radius, and the horizon still kills. One `env_at` on both sides.
22. **Placements (amends point 12):** a respawn and a mid-round join keep the clearance a vortex trip's destination
    keeps — clear of the hole's reach from the telegraph on, **and of every vortex's `VORTEX_REACH / 2`, live or
    spent** (the ruling asked for the capture radius at least; the trip's margin is stricter and was already one of
    the three placements' rule).
23. **The HUD banner:** anchored on the activation (`effect_phase`), where `Active` lasts `effect_start`'s `duration` —
    before, it ended `EFFECT_TELEGRAPH` early. A meteor shower's banner counts its dropping window
    (`METEOR_DURATION`), then reads `CLEARING` until the effect ends.
24. `REPLAY_VERSION` 26 (R100, the placement clearance; no layout change).
25. **docs/40 §3 (the snapshot footer; T22.14D):** 5 bytes — the per-recipient ack `u32`, then **the buttons the
    server stepped that player at the ack** `u8` (a stand-in's held buttons when the seq was one). 183 B at 6 players.
26. **docs/42 §2 (amends point 19):** the correction's restored previous input takes the footer's stepped buttons, so a
    press sent under seqs the server stood in for is replayed as the server stepped it — a stand-in later. A pad or
    vortex arrival (and a dev placement) resets the prediction's jump buffer, jetpack (fuel kept) and airborne ticks,
    now and in the history from the arrival's seq, as the server's arrival does.
27. `constants_json` gains `MAP_GENERATOR_MAX` (the last byte `MapGenerator::from_u8` names; `map_init`'s bound).

## Owner round 2 — for a §H22 (T22.15–T22.18; collected by T22.18, one list)
Open — not yet in `docs/77`. Each names its source; §-numbers are `docs/77-amendments-v9.md`'s.
28. **§H4 "the rim is an ellipse"** (and its 29.75–30 px, the 128 px x-inset): superseded by R104 — a square-cornered
    rectangular band `SPACE_RIM_INSET` (= `SKY_MARGIN`, 96) in from all four edges, exactly 32 px; Chebyshev outside
    (T22.17). Asteroids draw +0–20 % mass, radius × √(1 + m), up to 70 (R103).
29. **§H4 "Asteroids"** (T22.16): add the R102 core, `SPACE_CORE_FRAC` × r, destroyed at ≥ `SPACE_CORE_DESTROYED_FRAC`
    of its pixels air; `MapMeta::asteroids` gains `core_intact`; "The asteroid table is hashed" + `core_intact`.
30. **§H10 "Asteroid wells"** (T22.15/16): `SPACE_WELL_REACH_MAX`'s reach is gone (R101) — a step: full strength out to
    `SPACE_ASTEROID_CORE_FRAC·r + PLAYER_H/2 + WELL_SURFACE_BAND` from the centre, zero beyond; no field between rocks.
31. **§H11 "It eats one asteroid"** (T22.16): not a core destruction — no battery. New line: `core_destroyed {tick,x,y}`
    (Everyone, join catch-up, seq-keyed like §H16's attractors); the well is off for the round, the core crumbles, one
    battery pack floats **at the centre if a body can get within `PICKUP_RADIUS` of it, else at the body-reachable point
    nearest it** (T22.18, `cores::battery_site`).
32. **§H9 (R105, T22.18):** `VORTEX_CAPTURE_R` = `SPACE_RIM_THICKNESS` (32; was 127), `VORTEX_REACH` = 4 × = 128 (was
    508); drawn ring 32, swirl 64. Replace "It takes everyone inside `VORTEX_CAPTURE_R`" with: inside it, **or anyone past
    the rim's outer edge — taken by the nearest vortex, live or spent** (R16 restated: a hole never kills). The same-hole
    merge stays at `VORTEX_CAPTURE_R`; the trip destination stays `VORTEX_REACH / 2` (now 64) clear.
33. **§H11 (R106, T22.18):** `BLACK_HOLE_REACH` = 8 × horizon = 512 (was 256); `BLACK_HOLE_ACCEL_MAX` = 810 / 0.875 ≈ 925.7
    (was 1080); pull outside the horizon still ≤ 810 = 0.9 × DOWN. R91 mutes the wells over the larger reach. The horizon
    stays 64 — the largest *base* radius (not the largest rock, 70). The drawn glow ends at `BLACK_HOLE_GLOW_HORIZONS` (4)
    horizons, not at the reach (client drawing only), and the telegraph's closing ring starts there.
34. **§H7 (R108, T22.18):** `RADIATION_SHIELD_COST` = 0.5 × `RADIATION_DPS` (was equal): one energy holds off two damage;
    a full suit 200 s, a pack 100 s. Thruster fuel unchanged.
35. **§H19:** `REPLAY_VERSION` 27 (T22.17), 28 (T22.15), 29 (T22.16), **30 (T22.18)**.
36. **§H20:** add `SPACE_RIM_INSET`, `SPACE_ASTEROID_MASS_MAX` 0.2 (T22.17), `WELL_SURFACE_BAND` = `PLAYER_H` (T22.15),
    `SPACE_CORE_FRAC` 0.3, `SPACE_CORE_DESTROYED_FRAC` 0.2 (T22.16); strike `SPACE_WELL_REACH_MAX`; change the rows
    `VORTEX_CAPTURE_R … | 127, 1800, 4 × capture` → `32 (= SPACE_RIM_THICKNESS), 1800, 4 × capture`;
    `BLACK_HOLE_… | 64, 0.9, 810, 256, 1080` → `64, 0.9, 810, 512, ≈925.7`; `RADIATION_… | 1, 1, 1 s` → `1, 0.5, 1 s`.
37. **§H4 / §H10 (T22.18B F1):** `MapMeta::asteroids[]` gains `lumps` — `ASTEROID_LUMP_SLOTS` (= `SPACE_LUMPS_MAX`, 4)
    slots of `{dx, dy, r}` (radius 0 = empty), the generator's rounded lumps, which the stamp now reads. `map_init`'s
    asteroid record: `i16 x, i16 y, u16 r, u8 level`, then 4 × `i16 dx, i16 dy, u8 r` (27 bytes, was 7). A well's band
    now ends at `outline_radius(bearing) + PLAYER_H/2 + WELL_SURFACE_BAND` — the generated body-and-lumps outline on the
    body's bearing, not the round body — and the state hash covers the lumps. `REPLAY_VERSION` **31**.
38. **§H11 (T22.18B F4):** while the hole is here a faint ring (`BLACK_HOLE_RING_COLOR` at 0.35) is drawn at
    `BLACK_HOLE_REACH` on both render paths, and the minimap marker carries a circle of the reach's radius — the edge of
    the pull and of R91's muted wells; the death rule is still the horizon alone.
