# RESUME — state of the build

Single source of truth for picking this up cold. Updated at each phase gate.

**Last updated:** Phase 4 signed off

> **Updating this file is the LAST action of a phase gate**, after the reviewer signs
> off — not a mid-round note. It went stale three gates running: twice by being
> forgotten, once by being updated mid-round to record findings that were then closed
> in the same round.

---

## What this is

Branch `claude_builds_qwen`. The job is to implement **qwen's design exactly as
written** (`docs/`, `tasks/`) and see whether it survives a compiler. This is an
experiment, not a product: where the spec is broken, implement around it minimally
and record it in `DEVIATIONS.md`. **Never silently improve the design** — the defects
are the finding.

Root is `qwen/`. Ignore everything above it (the sibling `claude/` is a competing
design and is not used).

## Status

| Phase | Tasks | State |
|---|---|---|
| 0 — Scaffold | T0.1–T0.3 | **done, signed off** |
| 1 — Map | T1.1–T1.10 | **done, signed off** |
| 2 — Player | T2.1–T2.10 | **done, signed off** |
| 3 — Items | T3.1–T3.9 | **done, signed off** |
| 4 — Rounds | T4.1–T4.10 | **done, signed off** |
| 5 — Sprites | T5.1–T5.5 | **next** |

42/42 checkboxes ticked through Phase 4. 45 deviations recorded.

**Carried into Phase 5 (neither blocks its content):**
- `tick.rs` hand-builds **13 S→C event payloads** with `serde_json::json!` instead of
  their typed structs (`TileDestroyedMsg`, `Kill`, `Respawned`, `RoundEnded`, …). Field
  names are currently all correct, so this is latent drift risk, not a live bug — but
  for 11 of 19 documented events the protocol pins constrain nothing about what ships.
  **Fix before any protocol change, not after.**
- Map delivery (D46) and `game-core` `tracing` are both **closed**.

**End-to-end pass (post-Phase-3)** — see `dev_summary.md`:
- **D41** — a player standing on a tile could not pick up the item on it (22 px
  separation vs a 16 px radius; 0 of 500 items reachable across 50 maps).
  **Fixed at the start of Phase 4** by measuring pickup distance from the
  player's body rather than their centre, which preserves both documented
  numbers. The finding is kept in DEVIATIONS as the experiment's output.
- **D42** — **corrected; the original claim was wrong.** It said no weapon
  reaches ROCK's 80 hp and that source-B items were permanently unreachable.
  Tile hp persists between blasts, so ROCK falls to 2 rockets or 2 grenades and
  hidden items are reachable. What remains is a balance note: a rocket
  underground destroys 1 tile, or 0 if poorly aligned.

## How to verify the current state

```bash
cd qwen/server && cargo build && cargo test      # expect 323 + 11 + 17 + 23, 0 warnings
cd qwen/client && npm test && npm run build      # expect 118 passed
cd qwen && bash scripts/test-inventory.sh        # expect OK (478 tests)
cd qwen/server && cargo run -q -p game-core --example e2e_scenario   # 48/48
cd qwen/server && cargo run -q -p game-core --example e2e_stress     # 23/23
```

## Process (agreed with the user)

- **One commit per task**, made only after that task's own Test command passes.
- **Phase gates**: run a phase end-to-end, report, wait for go-ahead before the next.
- Two long-lived agents: a coder and a harsh reviewer, both forks sharing the spec in
  context. Review loop runs until the reviewer signs off; the orchestrator verifies
  findings independently rather than trusting either agent's report.
- **Stop rule** (qwen's own): if a task's test fails twice, stop and report.

## Read these before writing code

1. `HANDOFF-phase4.md` — most recent; deferred items for Phase 5.
2. `HANDOFF-phase2.md` — standing rules 1–3 live here; rule 4 in phase 4's.
3. `DEVIATIONS.md` — 45 entries; D1–D46 with gaps.
4. `HANDOFF-phase0.md`, `HANDOFF-phase1.md` for earlier context.

## Phase gate checklist

1. Every task's numbered steps implemented in the shipping path (not just its Test command green).
2. Full suite + client + inventory green, 0 build warnings.
3. Full E2E pass **including the live server**, failures treated as blocking.
4. Constants sweep + Test-command-selection sweep.
5. **Update this file — last, after sign-off.** Cold-restart artefact; stale 3× so far.

## Standing rules earned the hard way

- **A test described as guarding an invariant must have been seen to fail when that
  invariant is violated.** Otherwise call it coverage, not a guard.
- **Fix the instance, then sweep for the class before reporting.** Five rounds of
  review were spent on the same failure: fixing the one case shown while an adjacent
  identical case survived.
- **A green suite before and after a change is not evidence — it is the symptom.**
- `scripts/test-inventory.sh` + `tests-inventory.txt` exist because no test-running
  gate can detect a *deleted* test. Run it; a removed test is a deleted line.

## Blocking prerequisites for Phase 4 (decide together — one shared code path)

All four are collision-geometry decisions on the same code path. Do not fix piecemeal.

- ~~**D26**~~ — **fixed** at T4.0; neighbour overlap 70–80% → 0%.
- **D35** — ground speed is slope-dependent (7.525 px/tick downhill vs 7.0 flat).
  Not a violation; T2.3's "exactly 140 px/s" is a flat-ground property. Recorded only.
- **D36** — the player cannot walk up a single 16 px step (`autostep: None`). Given
  D3's measured column deltas of 7/10/14 tiles, most terrain is jump-only. **An open
  decision**: enable one-tile autostep, or accept jump-to-climb as the movement model.
- **D39** — **every projectile can pass through a single-tile wall.** docs/04 §2
  specifies a point lookup ("tile under new pos solid → impact"), but at 20 Hz every
  weapon moves further than one 16 px tile per tick: pistol 35.0 px (2.19 tiles),
  shotgun 30.0, rocket 25.0, grenade 20.0. Measured over 64 sub-tile offsets, the
  **pistol passes through a solid 1-tile wall 62% of the time and through a player
  standing in its path 23% of the time**; the rocket misses a 1-tile wall 31% of the
  time. **Decision: fix at T4.1** using the existing swept-cast machinery (the same
  resolution as D29 for players, for the same reason), keeping the deviation as the
  record of what the spec asked for. Left unfixed it also makes T4.10's "P1's rocket
  kills P2" integration test flaky at ~5%, which would be misdiagnosed as networking.

## Other deferred items

See `HANDOFF-phase2.md`'s deferred table. Notably: `PhysicsWorld` is not yet driven by
a round (T4.1 owns the per-tick sequence); T3.3 will deliberately break
`generation_matches_golden_hashes` and must re-pin it in that commit; `game-core` still
needs its `tracing` dep for T4.9.
