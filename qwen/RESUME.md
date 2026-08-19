# RESUME — state of the build

Single source of truth for picking this up cold. Updated at each phase gate.

**Last updated:** end of Phase 4 (T4.10, review in progress) · commit `bb5c46d`

> **This file is part of the phase gate.** It has been stale at two consecutive
> gates. Update it *before* reporting a phase complete, not after.

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
| 4 — Rounds | T4.1–T4.10 | code complete, **review found map delivery missing** |
| 5 — Sprites | T5.1–T5.5 | not started |

42/42 checkboxes ticked through Phase 4. 43 deviations recorded.

**Open at the Phase 4 gate:**
- **The server never sends the map.** `MapData` is never constructed; `joined` and
  `round_started` omit it; `base64` (added in T0.1 for exactly this) has never been
  called. The client still renders `devmap.ts`'s local sine wave, so every client
  draws terrain unrelated to the map the server simulates. Phase 4 work, not Phase 5.
- `game-core` declares `tracing` with a comment claiming it is used; it has **zero**
  tracing calls. Use it per T4.9 step 2 or drop it.

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

1. `HANDOFF-phase3.md` — most recent; has the deferred items for Phase 4.
2. `HANDOFF-phase2.md` — the standing rules live here.
3. `DEVIATIONS.md` — 40 entries; D1–D40 with gaps.
4. `HANDOFF-phase0.md`, `HANDOFF-phase1.md` for earlier context.

## Phase gate checklist

1. Every task's numbered steps implemented in the shipping path (not just its Test command green).
2. Full suite + client + inventory green, 0 build warnings.
3. Full E2E pass **including the live server**, failures treated as blocking.
4. Constants sweep + Test-command-selection sweep.
5. **Update this file.** It is the cold-restart artefact and has been stale twice.

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
