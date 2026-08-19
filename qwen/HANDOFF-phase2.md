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
| `player.rs` | `player_config` (every tunable from docs/03 §4/§5/§7), `Player`, `ShieldState`, `JetpackState`, `PlayerInputState` + edge detection, ground probe, `step_horizontal`/`step_jump`/`step_jetpack`, `integrate` (Verlet), `clamp_fall_speed`, `set_aim`, `compute_fov`. |
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
| **FOV: TS-only** change | 6 TS FAIL |
| **FOV: Rust-only** change, fixture regenerated | 4 TS FAIL — regenerating does not launder it |

### Two tests the injection pass caught as worthless

Both looked authoritative, both were green, neither constrained anything:

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
| **17** | **`PhysicsWorld` is built but never driven by a round.** Nothing calls `move_player` outside tests; `round.rs` must own the per-tick sequence: probe → step → integrate → resolve → rebuild. | **T4.1** |
| **18** | **Player damage, shield, overcharge, respawn, scoring are unimplemented.** docs/08 lists them under `player` but their tasks are Phase 3/4, so they were correctly not pulled forward. | T3.7 / T3.8 / T4.3 |
| **19** | **D26's spawn overlap will be visible.** Rapier ejects the body, so players pop out of terrain on spawn. Real fix: widen `find_spawns` to check columns `x-1..=x+1`. | T4.1 or a T1.5 revision |
| **20** | **`GameScene.localPlayerId` is hardcoded 0.** Set it from `joined` (docs/06 §2). | T4.10 |

---

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
