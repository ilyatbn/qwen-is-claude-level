# Handoff — Phase 3 (Items, inventory, weapons; T3.1–T3.9)

State: the full item catalog exists with every documented number pinned; all four
spawn sources place items deterministically; players pick up, equip and consume them;
weapons fire projectiles that damage players; and the client renders a 6-slot panel
with health, shield, jetpack and ammo.

Commits `39c6e94`(T3.1) … `5673dd4`(T3.9), one per task.

---

## Where the code lives

### `server/game-core/src/items.rs` — everything below is new this phase

| Area | Items |
|---|---|
| Catalog (T3.1) | `ItemKind`, `ItemDef`, `CATALOG`, `def()`, `SpawnWeights`, `pick_item` |
| Source A (T3.2) | `GroundItem`, `ItemIdCounter`, `place_initial`, `surface_candidates` |
| Source B (T3.3) | `rock_pockets`, `place_hidden` |
| Source C (T3.4) | `Crate`, `spawn_crate`, `step_crate`, `open_crate`, `player_reaches_crate` |
| Source D (T3.5) | `source_d_times`, `spawn_timed_item` |
| Pickup (T3.6) | `Pickup`, `try_pickup` |
| Use (T3.7) | `UseOutcome`, `use_slot` |
| Weapons (T3.8) | `Projectile`, `ProjectileStep`, `fire_weapon`, `try_fire`, `Cooldowns`, `FireResult`, `step_projectile`, `enforce_projectile_cap`, `starting_ammo` |

`player.rs` gains `OverchargeState`, `heal`, `apply_overcharge`, `apply_shield`,
`step_timers`, `apply_damage`, `blast_damage_at`, and the consumable constants in
`player_config`.

### `client/src/`

| File | Contents |
|---|---|
| `logic/inventoryModel.ts` | **Pure** panel/HUD derivation from a snapshot. Vitest-tested. |
| `hud/InventoryUi.ts` | 6-slot panel. Rendering only. |
| `hud/Hud.ts` | Crosshair (T2.8) + health/shield/jetpack bars. Rendering only. |

---

## What is tested

**Rust — 246 unit + 9 integration.** docs/08 §1 names honoured verbatim:
`catalog_ammo_matches_doc`, `placement_a_deterministic`, `hidden_items_in_rock_tiles`,
`crate_lands_on_surface`, `pickup_requires_free_slot`,
`pickup_full_inventory_leaves_item`, `weapon_cooldown_respected`,
`shotgun_5_pellets_fixed_spread`, `grenade_bounces_once_then_explodes`,
`ammo_depletes_and_weapon_removed`, `damage_pipeline_shield_halves`,
`heal_clamps_to_max`, `overcharge_max150_then_clamp`.

**Client — 118 Vitest**, 15 new for the inventory model.

**Every T3.x Test command was run verbatim and selects**: catalog 10, `items::initial`
9, `items::hidden` 8, crate 16, `items::timed` 7, inventory 10, use_item 9,
projectile 18, damage 12. Module names were chosen **before** writing code this phase,
specifically to avoid the D27 class that cost four review rounds.

### The new determinism anchor

`item_placement_matches_golden_hashes` (in `tests/determinism.rs`) pins sources A and B
to literal FNV-1a hashes for three seed/scale pairs. **It will need re-pinning at
T4.1/T4.8**, when spawn shuffling and the effect schedule start consuming draws before
placement — that is expected, and documented at the anchor itself.

---

## Injection sweeps — run before each gate, not after review

| Task | Injections | Unguarded found | Outcome |
|---|---|---|---|
| T3.1 catalog | 20 | 0 | every field and both weight tables |
| T3.2 source A | 8 | **1** | source A silently using the *Hidden* weight table |
| T3.3 source B | 2 | 0 | plus the new placement anchor |
| T3.4 crates | 8 | **1** | crate contents using the *Hidden* table |
| T3.5 source D | 5 | 0 | |
| T3.6 pickup | 6 | 0 | |
| T3.7 use | 11 | 0 | |
| T3.8 weapons | 16 | **2** | hit radius, grenade fuse |
| T3.9 HUD | 7 | **1** | the NaN guard was unreachable |

**Five gaps found by sweeping, none by review.** Every one was a test that passed for
the wrong reason:

- **The weight-table gap, twice.** A draw-order test that reconstructs only the RNG
  *state* cannot tell which weight table was used — `weighted_index` consumes one draw
  from either. Fixed by reconstructing the **items**, plus a statistical check
  (Ground → 7.7% flashlight, Hidden → 14.3%). The same shape appeared in T3.2 and T3.4;
  T3.5 got the fix pre-emptively.
- **`PLAYER_HIT_RADIUS`** — the hit test put the player exactly on the projectile path,
  so any radius passed. Now straddles 11/12/13/20 px.
- **`GRENADE_FUSE_S`** — two successive versions of the fuse test let the grenade leave
  the map before a lengthened fuse expired. Now runs on a Large empty map and asserts
  `fuse_s <= 0` at termination, proving the fuse is what ended it.
- **`clamp01`'s NaN guard** — unreachable, because the `max_health` divisor is
  separately guarded. Now reached via non-finite jetpack fuel.

### Two harness defects, both of which would have invalidated sweep results

1. **A semantic no-op injection** (T3.2): swapping `accepted.push()` with `pick_item()`
   changes nothing, because `push` consumes no randomness. It "passed" and proved
   nothing.
2. **False COMPILE detection** (T3.5): the harness keyed on `/^error/` to spot a
   non-compiling injection, but `cargo test` prints `error: test failed` for ordinary
   failures too — so every *guarded* injection was reported as a compile error. A whole
   sweep came back `COMPILE ×5`. Keying on `could not compile` separates them.

Both are recorded because **a sweep is only worth running if its negative results can
be trusted**, and a false COMPILE destroys exactly that. The harness is now
`scripts/injection-sweep.sh`, with the reasoning in its header.

---

## Deviations recorded this phase

| ID | Summary |
|---|---|
| **D37** | Spawn weights are stated as percentages but sum to 130 / 140, and the itemised weapon weights total 80 against a "weapons 50%" claim in the same sentence. Implemented as relative weights. Flashlight is 1.86× more likely in rock, not 2×. |
| **D38** | An anchor's coverage boundary can differ silently from its apparent scope — adding `Tile.item` to `golden_hash` anchored nothing, because `Map::generate` never writes it. A distinct variant: the test *could* fail, just never for the thing it was assumed to cover. |
| **D39** | Projectiles use a tile lookup, not the player's shape-cast path, exactly as docs/04 §2 specifies. **Measured cost**: the pistol passes through a 1-tile wall 62.5% of the time. **Promoted to a Phase 4 prerequisite with a decision to fix at T4.1** — the entry stays as the record of what the spec said. |
| **D40** | The grenade's range (400 px) and fuse (1.5 s) conflict; range wins at tick 26 and the documented fuse never fires. The fuse governs; "(throw)" is read as throw distance. |

---

## Deferred — carried forward

**Phase 4 prerequisites — all four are collision-geometry decisions on one code path,
and should be taken together at T4.1 rather than piecemeal:**

| # | Item | Owner |
|---|---|---|
| **D26** | Spawn overlap: 70–80% of spawns embed the body up to 175 px into neighbouring terrain. Widen `find_spawns` to require `x-1..=x+1` clear, re-pin anchors in the same commit. | **before T4.1** |
| **D35** | Slope-dependent ground speed — recorded, no action. Do not "fix" a 7.45 px tick. | — |
| **D36** | Jump-to-climb vs one-tile autostep is an undecided movement model. | **T4.1 decision** |
| **D39** | **Projectile tunnelling — FIX at T4.1.** Measured over 64 sub-tile offsets: the pistol passes through a solid 1-tile wall **62.5%** of the time (24/64 hits), the rocket 31.3% (44/64). The starting weapon against the game's central mechanic. Same shape as D29 for players, and the fix is near-free since swept casts already exist. It will otherwise make **T4.10 flaky** — that test asserts P1's rocket kills P2, carrying a ~5% miss rate that would be misdiagnosed as a networking fault. Keep D39 as the record that the spec specified a point lookup; that is the experiment's finding. | **T4.1** |

New from Phase 3:

| # | Item | Owner |
|---|---|---|
| **23** | **Nothing wires items into a round.** `place_initial`/`place_hidden` are never called by a round; crates and timed items have no scheduler; `try_fire` is not called from `step_tick`; picked-up weapons have no ammo array owner. `round.rs` owns all of it. | **T4.1** |
| **24** | **Ammo lives outside `Inventory`.** `try_fire` takes `&mut [u8; 6]` because docs/06 §4 carries `ammo` as a parallel snapshot array. Whoever owns round state must keep the two in step, and reset ammo on pickup via `starting_ammo`. | **T4.1** |
| **25** | **Scoring and respawn are not implemented.** `apply_damage` returns whether the blow was lethal and does nothing else — no score, no kill event, no respawn timer. | **T4.3** |
| **26** | **`skip_items` is implemented and tested but has no caller.** T4.6's lava is the first. | **T4.6** |
| **28** | **The placement anchor must be re-pinned** once T4.1/T4.8 add draws before placement. | **T4.1 / T4.8** |

---

## Notes for Phase 4

- **Round-start order is docs/04 §6**: map → shuffle spawns → effect schedule → place A
  → place B. Steps 2 and 3 do not exist yet; inserting them shifts every later draw, so
  expect `item_placement_matches_golden_hashes` to fail and re-pin it deliberately.
- **Each new round-start step needs its own anchor** (D38). The map hash will not cover
  the spawn shuffle or the effect schedule, and will not say so.
- **`Player::step_tick` is the production tick** (D32/D33); its step order is
  load-bearing. Firing, pickup and timers need to join it in `round.rs`, not replace it.
- **D1 is asserted**: `blast_damage_at(20, 48, 60) == 35`, not the "~45" T4.5 claims.
- **Tick task checkboxes with a binary-mode replacement** — text mode converts CRLF→LF.
- **Run all three sweeps before the gate**: constants, Test-command selection, and
  interaction coverage for any rewired path.
