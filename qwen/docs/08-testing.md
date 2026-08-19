# 08 — Testing strategy

Principle: **all game rules live in `game-core` (pure) → all meaningful
tests are Rust unit/integration tests.** Client tests cover only pure
logic. No e2e framework in v1.

## 1. Rust (`game-core`) — the main test surface

Run: `cd server && cargo test -p game-core`

| Module | Tests (named) |
|---|---|
| rng | `seeded_rng_deterministic` (same seed → same 1000-value sequence); `different_seeds_differ` |
| map | `generate_deterministic_100_seeds` (100 seeds × 3 scales: two generations byte-identical); `spawns_at_least_6`; `spawn_spacing`; `surface_within_bounds`; `pockets_below_surface_and_sized` (≤15 tiles, all below surface); `all_columns_have_ground` (every column has ≥1 solid tile) |
| tiles | `blast_falloff_center_max_edge_zero`; `blast_destroys_only_in_radius`; `surface_conversion_grass_on_air_above`; `destroy_tile_returns_event`; `version_increments` |
| physics | `player_falls_and_lands` (spawn above ground → lands on surface, vel.y ≈ 0); `player_walks_on_ground` (input left → x decreases, stays on surface); `jump_arc`; `jetpack_rises_and_fuel_drains`; `jetpack_recharge_rate`; `player_falls_into_hole` (destroyed tiles → player falls) |
| player | `damage_pipeline_shield_halves`; `overcharge_max150_then_clamp`; `heal_clamps_to_max`; `death_scores_kill_and_death`; `weather_kill_no_score`; `respawn_after_3s_keeps_inventory`; `fov_night_fog_lowhealth` (assert exact values for given inputs); `fov_flashlight_restores_night` |
| items | `catalog_ammo_matches_doc` (assert each ItemDef against docs/04 §1 table); `placement_a_deterministic` (10 items, same seed → same positions); `hidden_items_in_rock_tiles`; `crate_lands_on_surface`; `pickup_requires_free_slot`; `pickup_full_inventory_leaves_item`; `weapon_cooldown_respected`; `shotgun_5_pellets_fixed_spread`; `grenade_bounces_once_then_explodes`; `ammo_depletes_and_weapon_removed` |
| effects | `schedule_deterministic_per_seed`; `no_effect_in_first_10s`; `no_effect_in_last_15s`; `one_effect_at_a_time`; `toxic_rain_damages_in_spot_only`; `meteor_destroys_tiles_and_damages`; `lava_spew_then_ground_fire`; `fog_reduces_fov`; `day_night_phase_values` (assert day_phase at t=0,55,60,115,120) |
| round | `round_state_machine_full_cycle` (lobby→countdown→round→end, with fake inputs); `round_240s`; `restart_new_seed`; `score_kill_plus_death_minus`; `max_6_players` |

Integration (in `game-core/tests/`):
- `determinism.rs`: 3 seeds, 300 ticks of scripted inputs → identical final
  state (positions, hp, scores, map version, effect timeline).
- `full_round.rs`: simulate 240 s (4800 ticks) with 6 scripted players
  firing at each other → no panics, scores sum consistent (kills == total
  deaths), all players respawned at least once.

## 2. Server (`server` crate)

Run: `cd server && cargo test -p server`

- `rooms.rs` tests: join assigns ids 0..5; 7th rejected with `room_full`;
  disconnect removes player; ready logic starts countdown; restart
  generates a NEW seed (≠ old) unless `WIPGAME_SEED` set.
- One integration test with two fake socket.io clients (socketioxide test
  support or manual TCP): join both, start round, send inputs, assert both
  receive snapshots and a kill event when P1's rocket hits P2's position.
  (Keep it coarse — the fine logic is already covered in game-core.)

## 3. Client (Vitest, pure logic only)

Run: `cd client && npm test`

- `interpolation.ts`: `lerp_snapshots` — same snapshot → same point;
  t=0 → prev, t=1 → next; wrap-around across map edge NOT needed (no
  wrapping) but assert monotonic.
- `fov.ts`: same formula as server (copy of the math) — assert night/fog/
  health/flashlight cases match docs/03 §7 values.
- `protocol.ts`: `PROTOCOL_VERSION === 1`; a round-trip JSON parse of a
  fixture snapshot matches expected field names (guards against TS/Rust
  drift).

## 4. What is NOT tested (v1)

- Rendering (manual playtest; each task's Acceptance has a manual check
  where relevant).
- Network latency/jitter (latest-wins input + 100 ms interpolation is
  forgiving by design).
- Anti-cheat (server-authoritative; v1 is a friendly dev game).

## 5. Task/test contract

Every task file entry ends with a **Test** line = the exact command that
must pass. A task is done only when:
1. its Test command passes,
2. the full `cargo test` (server) or `npm test` (client) suite still passes
   (no regressions),
3. the task is marked `[x]`.
