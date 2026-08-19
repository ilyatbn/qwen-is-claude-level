# Handoff — Phase 4 (Rounds, effects, multiplayer; T4.1–T4.10)

State: a full round runs end to end. Lobby → 3 s countdown → 240 s round → Ended, with
day/night, all four weather effects, a seeded effect timeline, scoring, respawn, item
scheduling, 10 Hz snapshots, and a live socket a real client can join and play through.

Commits `0cbb99f`(T4.1) … `384bf04`, plus `89ca5ff` (geometry prerequisites).

---

## Where the code lives

| File | Added this phase |
|---|---|
| `game-core/src/round.rs` | `Round`, `RoundState`, `RoundPlayer`, `DamageSource`, `Event`, `step`, `start_round`, `snapshot`, kill/respawn/scoring, spawn scheduler. **No longer a stub.** |
| `game-core/src/effects.rs` | `day_phase`, toxic rain, meteors, lava, fog, `EffectSchedule`. **No longer a stub.** |
| `server/src/rooms.rs` | `Room` — socket identity, input queue, join/leave/ready/restart. **New.** |
| `server/src/tick.rs` | `step_room`, `broadcast`, the 20 Hz loop driving rooms. |
| `server/src/net.rs` | All docs/06 §1 handlers wired to rooms. |
| `server/tests/two_clients.rs` | T4.10 integration. **New.** |
| `client/src/scenes/LobbyScene.ts`, `RoundEndScene.ts` | **New.** |
| `client/scripts/round-check.mjs` | Live join-and-play check. **New.** |

---

## The five E2E seams — all owned, all tested

Each was "nobody owns this" before T4.1. `e2e_stress.rs` section H now drives a whole
round through `Round::step` and asserts every one:

| Seam | Owner | Evidence |
|---|---|---|
| `ammo[]` inherited stale counts | `RoundPlayer::ammo`, reset from `starting_ammo` on pickup | no slot exceeds its weapon's capacity after 4800 ticks |
| stale colliders after destruction | `Round::step` always rebuilds | a rocket under a settled player makes them fall |
| players leaving the map | `Round::enforce_bounds` | **0/6 off-map** (was 1/6) |
| `apply_damage` had no killer | `DamageSource` | player kill scores both sides; weather and self-kill score nobody |
| no crate/timed scheduler | `Round::run_spawn_schedule` | **all 5 crate drops fired** |

---

## Anchors

Three now, each covering a subsystem the others do not — **D38's rule applied, not
re-learned**:

| Anchor | Covers |
|---|---|
| `generation_matches_golden_hashes` + `seed1_small_ascii_dump_is_unchanged` | `Map::generate` |
| `item_placement_matches_golden_hashes` | `place_initial` / `place_hidden` from a fresh RNG |
| **`round_start_matches_golden_hashes`** | the whole docs/04 §6 round-start order |

Re-pinned twice this phase, both deliberate and both isolated:
- **T4.0** (D26 widened the spawn rule) → only the map hash moved; the ASCII and
  placement anchors stayed green, proving tiles and items were untouched.
- **T4.8** (the schedule stub began consuming draws) → only the round-start hash moved;
  the map and placement anchors stayed green, proving the change was confined.

The T4.1 schedule stub deliberately consumed **no** randomness so there would be exactly
one re-pin, at T4.8, rather than two.

---

## Deviations this phase

| ID | Summary |
|---|---|
| **D43** | T4.10's integration test drives `Room`/`step_room`, not a real socket — socketioxide 0.18 has no in-process client harness. States plainly what it does **not** cover. |
| **D44** | **Every broadcast silently did nothing.** `BroadcastOperators::emit` returns a Future; `let _ = ns.emit(..)` dropped it unpolled. Compiled clean, logged success, sent nothing — invisible to all 364 tests, found by a real client. |

D1 (meteor 35 not 45), D4 (toxic clamp), D12 (`tick % 2`), D22 (batch conversion),
D26/D36/D39 (geometry) all applied as recorded.

---

## Deferred

| # | Item | Owner |
|---|---|---|
| 29 | **Effects are built but not run by the round.** `EffectSchedule` is created and every effect's mechanics are implemented and tested, but `Round::step` does not yet start scheduled effects or apply their damage. `Snapshot.effect`/`fog` are hard-coded `None`/inactive. | **T5.x or a T4 follow-up** |
| 30 | **`lobby_state` and `round_ended` are not broadcast.** The scenes exist and render them; nothing sends them. | T5.x |
| 31 | **`joined` omits `map`** (docs/06 §2). The client cannot render terrain from the server yet — `devmap.ts` still supplies it. Needs `MapData` with base64 tiles. | T5.x |
| 32 | Client never consumes `snapshot`/`tile_destroyed`; `GameScene.applySnapshot` exists but nothing calls it from the socket. | T5.x |
| 16 | Protocol pinning still partial. | ongoing |

---

## Notes for Phase 5

- **`Round::step` is the only entry point.** Effects, when wired, belong inside it.
- **Run the live checks, not just the harnesses** (standing rule 3). D44 is why.
- **Three anchors now.** A new round-start step needs its own, or it is silently
  uncovered — that is D38, and it has now happened twice.
- `EffectSchedule::build` consumes draws; anything inserted before it in `start_round`
  shifts the round-start hash and needs a deliberate re-pin.
