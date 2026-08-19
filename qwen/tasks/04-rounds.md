# Phase 4 — Rounds, effects, multiplayer

State after this phase: full loop works over the network — lobby →
countdown → 4-min round with day/night, all 4 weather effects, scoring +
respawn → round end → restart on a new seed. Two real clients can see,
shoot, and kill each other.

Read `docs/05-server.md` and `docs/02-map-effects.md` in full before
starting this file.

---

## T4.1 — Round state machine [x]

**Goal**: lobby → countdown → round (240 s) → end; restart with new seed.
**Read**: `docs/05-server.md` §2, `docs/02-map-effects.md` §1 (cycle start).
**Files**: `server/game-core/src/round.rs`, `server/server/src/rooms.rs`
**Steps**:
1. `RoundState { Lobby | Countdown(f32) | Running | Ended }` in game-core;
   `Round::step(tick, inputs)` advances timers (countdown 3 s, round 240 s).
2. `Round::start_round(seed, scale, players)`: generate map (T1.6),
   shuffle spawns, build effect schedule (T4.8 stub ok), place items
   (T3.2/T3.3), spawn players (T2.1).
3. Rooms: join/leave/ready per docs/05 §2; all-ready OR 6 players →
   countdown; restart → NEW seed (server entropy; `WIPGAME_SEED` override
   pins it).
4. Emit `round_started` / `round_ended` (scores) per docs/06 §2.
5. Tests: `round_state_machine_full_cycle` (fake inputs, 240 s of ticks →
   Ended, round_time_s ≈ 240); `round_240s`; `restart_new_seed` (new seed
   ≠ old unless pinned).
**Acceptance**: a 6-player fake lobby reaches Running after exactly 3 s
  of countdown ticks.
**Test**: `cd server && cargo test -p game-core round && cargo test -p server rooms`

---

## T4.2 — Day/night cycle [x]

**Goal**: `day_phase` in snapshot; 60/60 s with 5 s transitions.
**Read**: `docs/02-map-effects.md` §1.
**Files**: `server/game-core/src/effects.rs`
**Steps**:
1. `day_phase(round_time_s) -> f32` per doc formula (c = t mod 120).
2. Include in Snapshot (field exists in protocol).
3. Test `day_night_phase_values`: t=0 → 0.0; t=55 → ~0.0 (start of
   transition: 0.0 at 55, 1.0 at 60); t=60 → 1.0; t=115 → 1.0; t=120 → 0.0.
   (Linear within the 5 s windows.)
**Acceptance**: values are continuous (no jumps > 0.1 between consecutive
  0.5 s samples over a full 120 s cycle).
**Test**: `cd server && cargo test -p game-core day_night`

---

## T4.3 — Scoring + respawn [x]

**Goal**: +1 kill / −1 death; 3 s respawn keeping inventory; weather kills
score no one.
**Read**: `docs/03-player.md` §6, §2.
**Files**: `server/game-core/src/player.rs`, `server/game-core/src/round.rs`
**Steps**:
1. `apply_damage` death path (T3.8) → score ±1, kill event,
   `respawn_at_tick = now + 60 ticks`.
2. Respawn: farthest spawn from living players (Chebyshev on tiles),
   health 100, shield cleared, jetpack full, inventory KEPT.
3. Weather/self kills: victim −1, no +1 to anyone.
4. Tests: `death_scores_kill_and_death`, `weather_kill_no_score`,
   `respawn_after_3s_keeps_inventory`, `score_kill_plus_death_minus`
   (3 kills 2 deaths → +1).
**Acceptance**: a player can die and come back with their rocket still in
  slot 2.
**Test**: `cd server && cargo test -p game-core respawn && cargo test -p game-core score`

---

## T4.4 — Toxic rain [x]

**Goal**: 5 staggered spots, 10 hp/s inside, 8 s window.
**Read**: `docs/02-map-effects.md` §3.
**Files**: `server/game-core/src/effects.rs`
**Steps**:
1. On start: 5 random solid-tile centers (RNG); spot i active
   `[i*1.2, i*1.2+4]` s after start; total 8 s.
2. Per tick: players within 40 px of an active spot take 10*dt hp.
3. `effect_started`/`effect_ended` events; spots in snapshot EffectData.
4. Tests: `toxic_rain_damages_in_spot_only` (player in spot loses ~10 hp/s;
   50 px away loses 0); spots stagger correctly (spot 4 ends at 8 s).
**Acceptance**: a player standing still in spot 0 for its 4 s window loses
  ≈ 40 hp (±2).
**Test**: `cd server && cargo test -p game-core toxic`

---

## T4.5 — Meteor shower [x]

**Goal**: 3 meteors, 0.8 s apart, blast 48 px / 60 dmg, destroys tiles.
**Read**: `docs/02-map-effects.md` §4.
**Files**: `server/game-core/src/effects.rs`
**Steps**:
1. On start: 3 random surface targets (RNG).
2. At i*0.8 s: `apply_blast(target, 48, 60)` (default `skip_items=false` —
  meteors CAN uncover hidden items per docs/01 §5) + player falloff damage
   (same formula as tiles) + `meteor_impact` event (use `explosion` event
   from docs/06 — same shape).
3. Test `meteor_destroys_tiles_and_damages`: blast removes the expected
  tile set; a player at 20 px takes ~45 (60*(1-20/48)); at 60 px takes 0.
**Acceptance**: meteor impact visibly digs a crater (tile count > 0 in
  test).
**Test**: `cd server && cargo test -p game-core meteor`

---

## T4.6 — Lava burst [x]

**Goal**: 3×3 dig, 5 s spew, 3 s ground fire, 15 hp/s.
**Read**: `docs/02-map-effects.md` §5.
**Files**: `server/game-core/src/effects.rs`
**Steps**:
1. On start: 1 site; dig 3×3 around it with `apply_blast`-style removal
   BUT `skip_items=true` (weather skips uncovery) — add a
   `clear_area(map, cx, cy)` helper for exact 3×3 removal.
2. Spew (0–5 s): per tick 2 fire particles from site, random direction
   (RNG, 30° width, upward-biased), speed 150 px/s, life 1 s; overlap with
   player → 15*dt hp.
3. Ground fire (5–8 s): the 3×3 area + any tile touched by fire particles
   burns; players on burning tiles take 15*dt hp.
4. `lava_sites` in snapshot (site, phase, remaining).
5. Tests: `lava_spew_then_ground_fire` (phase switch at 5 s; damage in
  both phases; no damage after 8 s); dug area is exactly 9 tiles (± tiles
  already AIR).
**Acceptance**: after the burst the hole persists (tiles stay AIR).
**Test**: `cd server && cargo test -p game-core lava`

---

## T4.7 — Heavy fog [ ]

**Goal**: 15 s fog, FOV ×0.45, no damage.
**Read**: `docs/02-map-effects.md` §6.
**Files**: `server/game-core/src/effects.rs`, `server/game-core/src/player.rs`
  (fog factor in compute_fov — T2.10 already has the parameter; wire it).
**Steps**:
1. On start: `fog = { active: true, remaining: 15 }`; ends at 15 s.
2. compute_fov multiplies by 0.45 while active (already in formula).
3. Client: fog layer visual (translucent white, alpha 0.25) while active.
4. Test `fog_reduces_fov`: fov with fog ≈ 0.45 × without (same inputs).
**Acceptance**: during fog, a player at 300 px is outside a full-day FOV
  holder's view? NO — fog shrinks YOUR fov: assert local fov drops from 420
  to 189 at full day.
**Test**: `cd server && cargo test -p game-core fog`

---

## T4.8 — Seeded effect scheduler [ ]

**Goal**: deterministic effect timeline per seed.
**Read**: `docs/02-map-effects.md` §7, §8.
**Files**: `server/game-core/src/effects.rs`, `server/game-core/src/round.rs`
  (schedule built at round start, step checks it)
**Steps**:
1. `build_schedule(rng, round_duration=240) -> Vec<(start_tick, EffectKind)>`
   per doc §8 (first 10–20 s, gaps 18–32 s, weights 30/25/25/20, stop
   before 225 s).
2. Round.step: if next scheduled effect's tick reached AND no effect
   active → start it.
3. Enforce: one at a time, no effect in first 10 s / last 15 s.
4. Test `schedule_deterministic_per_seed` (3 seeds → identical timelines);
   `no_effect_in_first_10s`, `no_effect_in_last_15s`,
   `one_effect_at_a_time` (simulate full round, assert invariants).
**Acceptance**: seed 12345 always produces the same effect list (print it
  in the test output for the first seed).
**Test**: `cd server && cargo test -p game-core schedule`

---

## T4.9 — Snapshot + event broadcast tuning [ ]

**Goal**: server sends snapshots at 10 Hz + events immediately; payload
logged.
**Read**: `docs/05-server.md` §3, §4, §5.
**Files**: `server/server/src/tick.rs`, `server/server/src/net.rs`
**Steps**:
1. tick.rs: every 2nd tick → serialize Snapshot → broadcast to room;
   events from `round.step` → broadcast immediately.
2. Log per docs/05 §5: `[net] snap=NNN B clients=N` every 100 ticks;
   `[dmg]`, `[tiles]`, `[effect]` lines from game-core via `tracing`
   (game-core uses `tracing` macros — allowed, it's not IO).
3. `set_log_level` handler (runtime toggle) per docs/05 §5.
4. Input queue: latest-wins per player; log `[input] P3 dropped N frames`
   when > 2 frames queued for one tick.
**Acceptance**: with 6 fake clients, snapshot rate is 10 Hz (±1) over a
  10 s window (assert in a server integration test with a timer).
**Test**: `cd server && cargo test -p server`

---

## T4.10 — Two-client integration [ ]

**Goal**: end-to-end: two real clients, one kills the other, both see it.
**Read**: `docs/05-server.md` §2, §4, `docs/06-protocol.md` (all).
**Files**: `server/server/tests/two_clients.rs` (integration),
  `client/src/scenes/LobbyScene.ts`, `client/src/scenes/RoundEndScene.ts`
**Steps**:
1. Server integration test: two socket.io clients join, both ready,
   round starts (use `WIPGAME_SEED` for a known map), P1 aims at P2's
   spawn and fires a rocket (scripted inputs), assert: P2 receives
   `kill` event, P1's score +1 in next snapshot, P2 respawns after 3 s
   (`respawned` event).
2. LobbyScene: name input, skin picker (placeholder colors), ready button,
   player list, countdown display.
3. RoundEndScene: score table, "Restart (new map)" + "Quit" buttons →
   `restart` / `quit`.
4. Manual: run server + 2 browser tabs (or 1 tab + devtools socket
   console), play 30 s, confirm positions match between tabs.
**Acceptance**: the integration test passes headless; manual check shows
  both players visible in both tabs.
**Test**: `cd server && cargo test && cd ../client && npm run build`
