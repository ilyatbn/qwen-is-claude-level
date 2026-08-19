# Handoff — Phase 2 (Player movement, physics, stats; T2.1–T2.10)

State: a player spawns on terrain, walks, jumps with direction bias and air control,
jetpacks with fuel and recharge, aims, and is resolved against terrain colliders that
rebuild when the map is destroyed. The client interpolates snapshots at 100 ms delay,
sends input at 20 Hz, draws a crosshair, and masks the world outside the FOV radius.

Commits `5661995`(T2.1) … `fd08e38`(T2.10), one per task.

---

## Where the code lives

### `server/game-core/src/`

| File | Added this phase |
|---|---|
| `player.rs` | `player_config` (every tunable from docs/03 §4/§5/§7), `Player`, `ShieldState`, `JetpackState`, `PlayerInputState` + edge detection, ground probe, `step_horizontal`/`step_jump`/`step_jetpack`, `integrate` (Verlet), `clamp_fall_speed`, `set_aim`, `compute_fov`, **`step_tick` (the production per-tick sequence) and `apply_collision`**. |
| `physics.rs` | `Segment` + `row_segments`/`all_segments` (docs/01 §6 colliders), `PhysicsWorld` wrapping rapier's `KinematicCharacterController`, `rebuild_segments`. |
| `items.rs` | `Inventory` (6 slots) — `Player` embeds it; pickup/use is T3.6/T3.7. |
| `examples/fov_vectors.rs` | Generates the shared FOV fixture (D31). |
| `examples/measure_spawn_fit.rs`, `measure_spawn_formula.rs` | Evidence for D25/D26. |

### `client/src/`

| File | Contents |
|---|---|
| `logic/aim.ts` | Angle convention + crosshair geometry. **Pure.** |
| `logic/interpolation.ts` | Snapshot buffer, lerp, `lerpAngle`, 100 ms delay. **Pure.** |
| `logic/inputFrame.ts` | 20 Hz input pacing. **Pure.** |
| `logic/fov.ts` + `fov-vectors.json` | FOV mirror, pinned to the generated fixture. **Pure.** |
| `entities/PlayerSprite.ts`, `hud/Hud.ts` | Rendering only. Not unit-tested (need WebGL). |
| `scenes/GameScene.ts` | Wires the above; darkness mask. |

---

## Public entry points

- `Player::{new, spawn, spawn_position, feet_y, on_ground, input_direction}`
- **`Player::step_tick(&PhysicsWorld, &Map, &InputFrame, InputEdges, dt) -> TickOutcome`** — the production per-tick sequence. `round.rs` (T4.1) calls this; do not re-derive it.
- `Player::apply_collision` — the single point rapier's output re-enters pure state (D32).
- `Player::{step_horizontal, step_jump, step_jetpack, integrate, clamp_air_speed, clamp_fall_speed}`
- `Player::{set_aim, compute_fov}` · `player::DT` (0.05) · `player::player_config::*`
- `PlayerInputState::{receive, tick}` → `(InputFrame, InputEdges)`
- `PhysicsWorld::{new, move_player, rebuild_segments, collider_count, segments, last_rebuild_rows}`
- `physics::{row_segments, all_segments, Segment}`
- Client: `aimAngle`, `crosshairPosition`, `SnapshotInterpolator`, `lerpAngle`,
  `interpolationFactor`, `InputSender`, `computeFov`

---

## What is tested — and what is a *guard*

Following the Phase 1 rule: **a test called a guard has been seen to fail when its
invariant is violated.** Every row below was injected and reverted this phase.

| Injection | Result |
|---|---|
| Spawn y = `(tile_y+1)*16` (T2.1's literal formula) | 3 FAIL — "feet at 624 should rest on the tile TOP edge 608" |
| `jump_pressed = frame.jump` (edge detection dropped) | 2 FAIL — "held jump produced 10 edges, expected 1" |
| `use_slot` passed through unfiltered | 1 FAIL |
| `MOVE_SPEED` 140 → 150 | 2 FAIL — "Δx over 10 ticks was 75, expected exactly 70" |
| Ground probe 2 px → 8 px | 1 FAIL |
| Ground movement accelerates instead of setting | 3 FAIL |
| **Semi-implicit Euler** instead of Verlet | 1 FAIL — "apex 52.5 px is outside the documented 58–63 range" |
| `JUMP_VY` −330 → −300 · `GRAVITY` 900 → 800 · `JUMP_DIR_BIAS` 0.5 → 1.0 | 1 FAIL each |
| `JETPACK_THRUST` 1100 → 1000 | 2 FAIL |
| `JETPACK_BURN_RATE` 1.0 → 2.0 | 2 FAIL |
| `JETPACK_RECHARGE_RATE` 0.5 → 1.0 | 1 FAIL |
| `JETPACK_VERTICAL_ASSIST` 300 → 500 | 1 FAIL *(0 before the fix — see below)* |
| Jetpack allowed to start on the ground | 1 FAIL |
| Collision resolution bypassed | 4 FAIL |
| Terminal-velocity clamp removed | 1 FAIL — "displacement 64.125 exceeded the Verlet bound 46.125" |
| Segment tail-run one tile short | 3 FAIL — "tile (95,42) solid=true covered 0 times" |
| Segment half-extents halved | 4 FAIL |
| `rebuild_segments` made a no-op | 3 FAIL |
| Rebuild ALL rows instead of affected | 2 FAIL *(0 before the fix — see below)* |
| Aim y-negation dropped | 5 FAIL |
| `CROSSHAIR_RADIUS` 60 → 40 · crosshair `+sin` | 1 / 2 FAIL |
| Interpolation delay 100 → 0 | 2 FAIL |
| Extrapolate instead of clamp | 1 FAIL |
| Plain `lerp` for facing (±π wrap) | 1 FAIL |
| Accept out-of-order snapshots | 1 FAIL |
| Input interval 50 → 16 ms | 3 FAIL |
| **FOV: TS-only** change (`FOV_NIGHT_MIN` 0.45→0.50) | 6 TS FAIL |
| **FOV: Rust-only** (`FOV_NIGHT_MIN` 0.45→0.40), fixture regenerated | 5 TS FAIL |
| **FOV: Rust-only** (`FOV_LOW_HEALTH_FACTOR` 0.7→0.8), fixture regenerated | 4 TS FAIL |
| Collision→velocity rule removed (D32) | 3 FAIL — "resting player accumulated vel.y = 900 over 200 ticks" |
| `AIR_ACCEL` 600→700 · `AIR_MAX` 140→155 | 1 FAIL each *(0 before the fix — see below)* |

Regenerating the fixture does not launder a one-sided FOV change: the client
implementation still disagrees with the new vectors. Failure counts differ by which
constant is injected — both rows above are measured, not estimates.

### A full constant sweep

Every tunable in docs/03 §4/§5/§7 was injected individually. **All 20 are guarded**,
none fails zero tests: `MOVE_SPEED` 3, `AIR_ACCEL` 1, `AIR_MAX` 1, `GRAVITY` 2,
`JUMP_VY` 3, `JUMP_DIR_BIAS` 1, `JETPACK_THRUST` 2, `JETPACK_VERTICAL_ASSIST` 1,
`JETPACK_FUEL_MAX` 4, `JETPACK_BURN_RATE` 2, `JETPACK_RECHARGE_RATE` 1,
`BASE_HEALTH` 1, `FOV_BASE` 3, `FOV_NIGHT_MIN` 2, `FOV_FOG` 1,
`FOV_LOW_HEALTH_FACTOR` 1, `FOV_LOW_HEALTH` 2, `TERMINAL_VELOCITY` 1,
`BODY_HALF_WIDTH` 1, `BODY_HALF_HEIGHT` 1.

Review found the `AIR_ACCEL` / `AIR_MAX` instances; the sweep's own contribution was the
**negative result** — confirming the other 18 constants are genuinely guarded, so the
shape was two specific tests rather than a pervasive rot. That negative result is the
reason to run a sweep: it bounds the problem instead of leaving it open.

### Tests the injection pass caught as worthless

Each looked authoritative, each was green, none constrained anything:

0. **Air control was self-referential on both constants.**
   `air_control_accelerates_toward_the_cap` asserted `vel.x - AIR_ACCEL * DT` and
   `vel.x - AIR_MAX`; `air_control_reverses_direction` set `vel.x = AIR_MAX` and
   asserted only `vel.x < AIR_MAX`, constraining the *sign* of the change and nothing
   else. Now asserts the literals 30.0 (600 × 0.05), 140.0, and 110.0.
1. **`w_and_s_assist_in_flight` was self-referential.** It asserted against
   `JETPACK_VERTICAL_ASSIST` itself, so changing the constant moved both sides —
   `300 → 500` failed **zero** tests. Rewritten against docs/03 §5's literals.
   The same shape exists in `assert_eq!(vel.x, MOVE_SPEED)` in T2.3; there the
   companion `Δx == 70` literal is what actually bites.
2. **`rebuild_touches_only_affected_rows` compared results, not work.** Rebuilding
   every row produces identical segments, so "rebuild all rows" failed **zero** tests.
   Fixed by exposing `last_rebuild_rows()` and asserting the scope directly.

The lesson generalises: an assertion written in terms of the thing under test, or in
terms of an output that is invariant under the bug, is decoration. The injection step
is what tells the difference, and running it unprompted found both.

---

## Deviations recorded this phase

| ID | Summary |
|---|---|
| **D25** | T2.1's spawn formula `(tile_y+1)*16` buries the player one tile. Measured: literal 600/600 buried, corrected 0/600. |
| **D26** | Spawn candidate rule checks one column; the body is 1.5 tiles wide. 70–80% of spawns overlap neighbouring terrain, up to 175 px deep. Left as documented — fixing it is T1.5's code and invalidates golden anchors. |
| **D27** | T2.2's Test command (`cargo test … input`) selected none of T2.2's tests — it ran one unrelated T0.2 test that passes regardless. Fixed by module naming. |
| **D28** | T2.4's jump apex is satisfiable only by velocity Verlet. Semi-implicit 52.5 px, explicit 69.0 px, Verlet 60.375 px against an asserted 58–63. |
| **D29** | T2.6's "never moves > 45 px" is unsatisfiable under Verlet (46.125 px) **and** meaningless (45 px spans 2.9 tiles). Replaced with shape-cast movement, which prevents tunneling at any speed. |
| **D30** | Cross-platform determinism **decided**: same-platform guaranteed, cross-platform not. Records cost, and the three triggers that force a revisit. |
| **D31** | docs/08 §3 mandates duplicating the FOV formula across languages with no "update both" rule. Pinned to a generated shared fixture. |
| **D32** | The collision→velocity rule is load-bearing and absent from docs/03. Also promoted the per-tick sequence out of a test helper into `Player::step_tick`. |
| **D33** | Step order in the tick is load-bearing — jump must follow horizontal, or the ground rule overwrites `JUMP_DIR_BIAS` (140 instead of 70). |
| **D34** | Combined-axis collision silently cost 20% of walking speed (56 px per 10 ticks instead of 70). Axes now resolve in two separate shape-casts. |
| **D35** | Ground speed is slope-dependent; T2.3's "exactly 140 px/s" holds only on flat ground. Not a violation — correct Verlet integration on airborne ticks. **Documentation only.** |
| **D36** | A player cannot walk up a single 16 px step (`autostep: None`). Every upward terrain feature needs a jump. **Phase 4 decision.** |

---

## Deferred — carried forward

| # | Item | Owner |
|---|---|---|
| 1 | `effects.rs`, `round.rs` still stubs; `items.rs` has only `Inventory`. | T3.1 on |
| 5 | Client `PROTOCOL_VERSION` mismatch warning. | T4.10 |
| 6 | `MissedTickBehavior::Skip` decouples game time from wall time. | T4.9 |
| 7 | `game-core` needs a `tracing` dep. | T4.9 |
| 12 | `Tile.item` always `None`. **`golden_hash` covers it**, so T3.3 will fail `generation_matches_golden_hashes` — re-pin deliberately there. | T3.3 |
| 13 | `apply_blast` does no player damage. | T3.8 / T4.5 |
| 15 | `decor` / `spawns` generated but unrendered. | T5.x |
| 16 | Protocol pinning partial (22/43 Rust, 12/30 TS). | ongoing |
| **17** | **`PhysicsWorld` is built but never driven by a round.** `Player::step_tick` now *is* the sequence (D32) and is production code; T4.1 must call it per player per tick, and call `rebuild_segments` after destruction. Do not reimplement the sequence. | **T4.1** |
| **18** | **Player damage, shield, overcharge, respawn, scoring are unimplemented.** docs/08 lists them under `player` but their tasks are Phase 3/4, so they were correctly not pulled forward. | T3.7 / T3.8 / T4.3 |
| **21** | **D36: jump-to-climb vs autostep is an undecided movement model.** A player cannot walk up a 16 px step, and D3 measured adjacent-column deltas up to 7/10/14 tiles, so every upward feature requires a jump. Decide at T4.1: enable one-tile autostep, or accept jump-to-climb and record it as intended. | **T4.1 decision** |
| **22** | **D35 is recorded, not open.** No action — but do not "fix" a 7.45 px tick on sloped terrain as a bug; it is correct Verlet integration, and T2.3's flat-ground assertion is not a global invariant. | — |
| **19** | **D26's spawn overlap is a Phase 4 PREREQUISITE, not an open item.** 70–80% of spawns embed the body up to 175 px into neighbouring terrain; ejection direction from that depth is undefined. Phase 3 is unaffected (item placement and pickup geometry are independent of spawns), but T4.1 wires physics and T4.3 makes "farthest spawn from living players" a scoring input. Fix: widen `find_spawns` to require columns `x-1..=x+1` clear, and re-pin the golden anchors in the same commit. | **before T4.1** |
| **20** | **`GameScene.localPlayerId` is hardcoded 0.** Set it from `joined` (docs/06 §2). | T4.10 |

---

## The standing rule for Phase 3 onward: sweep the class, not the instance

Phase 1 left a rule — *a test described as guarding an invariant must have been seen to
fail when that invariant is violated* — and it worked, because it was written here and
so got applied unprompted. This phase produced a second rule, from a failure that has
now recurred four times:

> **When a defect is found, fix the instance, then sweep for the class before
> reporting.** Ask: *what else has this shape?* and *what does this change affect that
> nothing observes?* Answer both with a script over every candidate, not by inspection.

The record it comes from:

| Phase | Instance fixed | Class missed |
|---|---|---|
| 0 | TS drift guard | protocol pinning gap persisted |
| 1 | D22's non-discriminating test | a deleted test went unnoticed |
| 2 | T2.2's Test filter | T2.1 had the same defect |
| 2 | jetpack self-referential assertion | `AIR_ACCEL`/`AIR_MAX` had it too |
| 2 | promoted the tick sequence (D32) | reordering broke `JUMP_DIR_BIAS`, and the combined-axis cast cost 20% walking speed (D33, D34) |

The last row is the sharpest: the fix was correct and necessary, and it introduced two
regressions in exactly the interactions the old code path never exercised. A green suite
before and after is not evidence — it is the symptom.

**Concretely, before each phase gate**, and not after a reviewer asks:

1. **Constant sweep** — inject every documented constant the phase touches, one at a
   time; record failure counts; any zero is an unguarded constant. The negative result
   matters as much as the positive: it bounds the problem.
2. **Test-command sweep** — run every task's Test command verbatim and record how many
   tests each selects. Any zero means a task is gated on nothing.
3. **Interaction sweep** — for any code path promoted, reordered or rewired, enumerate
   the input dimensions it now covers that its predecessor did not, and assert each one
   end to end. This is what D33/D34 came from.

## Standing rule 3: run a full end-to-end pass at every phase gate

Added after the post-Phase-3 E2E pass found a **hard failure that 375 unit tests and
83 injections missed** — a player standing on a tile could not pick up the item on it
(D41). Every unit test passed because each placed the player *at* the item or within
16 px of it; none derived the player's position from the geometry of standing. The
defect lived in a seam between three subsystems that were each individually correct.

> **At the end of every phase, run `examples/e2e_scenario.rs` and
> `examples/e2e_stress.rs` before reporting, and fix what they find.** Extend both as
> each phase adds capability. Treat their failures as **blocking**, not as notes for
> later.

Sweeps and injections verify that each part matches its spec. They cannot find a defect
that only exists when the parts are combined, because no part is wrong. That is what
the E2E pass is for, and it is cheap: the whole harness took under an hour to write and
found the defect on its first adversarial run.

Both harnesses report and continue rather than panicking on the first failure, so one
run surfaces everything. Keep that property.

**The E2E pass must include the LIVE server**, not only the in-process harnesses. D44
was a bug where every broadcast silently did nothing — `BroadcastOperators::emit`
returns a Future and was never awaited — and it was invisible to 364 tests because they
all stop one layer short of the socket. Run `client/scripts/ping-check.mjs` and
`client/scripts/round-check.mjs` against a real server at every gate.

## Standing rule 4: a ticked box means the steps are implemented

Phase 4 ticked five tasks whose mechanics were implemented and unit-tested but never
integrated — the effect scheduler was built and never consulted, and a full round had no
weather. Every documented Test command passed, because each tests its mechanic
standalone.

> **Before ticking, re-read the task's numbered steps and confirm each one is
> implemented in the shipping path — not that its Test command is green.**

qwen's Test commands have selected the wrong thing five times now (D14, D27 for T2.2 and
T2.1, T1.5's `spawn_spacing` filter, and T4.8). A green command is evidence about the
command, not about the task.

## Notes for Phase 3

- **`Player::integrate` takes acceleration and uses Verlet** (D28). Do not "simplify"
  it; `jump_arc` fails with an explanation if you do.
- **`destroy_tile` converts; `destroy_tile_deferred` + one `apply_surface_conversion()`
  for batches** (D22). T4.6's `clear_area` is the next batch caller.
- **`compute_fov` has a mirror.** Change it and run
  `cargo run -p game-core --example fov_vectors`, or the client suite fails (D31).
- **Tick task checkboxes with a binary-mode replacement.** A Python text-mode write
  converts CRLF→LF wholesale; `01-map.md` is already LF from the Phase 1 repair and the
  rest must stay CRLF.
- **Run `./scripts/test-inventory.sh check`** in the gate; `update` only after an
  intentional removal.
- **`Player::step_tick` order is load-bearing** (D33): horizontal → jetpack → jump, so
  the jump's directional bias overrides the ground rule. Do not reorder.
- **`apply_collision` resolves axes in two separate casts** (D34). A single combined
  cast drops whole ticks of horizontal movement. Do not merge them.
- **The body penetrates the floor by up to 1.115 px while walking** (0 px standing).
  Bounded and non-accumulating — it stays ~1.12 px over 120 ticks and slowly decreases,
  with `on_ground` and `blocked_y` true throughout and Δx exact. Not a defect, but it is
  the same order of magnitude as Phase 3's **16 px pickup radius** and **12 px hit
  circle**, so geometry that assumes feet sit exactly on the surface will be off by
  about a pixel.
- **Three Phase 4 prerequisites share one code path** — D26 (spawn overlap), D35 (slope
  speed) and D36 (step climbing) all sit on the spawn/collision path. Decide them
  together at T4.1, not piecemeal.
