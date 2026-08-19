# RESUME — state of the build

Single source of truth for picking this up cold. Updated at each phase gate.

**Last updated:** end of Phase 2 (T2.10 signed off) · commit `4b6d7d9`

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
| 3 — Items | T3.1–T3.9 | not started |
| 4 — Rounds | T4.1–T4.10 | not started |
| 5 — Sprites | T5.1–T5.5 | not started |

23/23 checkboxes ticked through Phase 2. 35 deviations recorded.

## How to verify the current state

```bash
cd qwen/server && cargo build && cargo test      # expect 158 + 8, 0 warnings
cd qwen/client && npm test && npm run build      # expect 103 passed
cd qwen && bash scripts/test-inventory.sh        # expect OK (270 tests)
```

## Process (agreed with the user)

- **One commit per task**, made only after that task's own Test command passes.
- **Phase gates**: run a phase end-to-end, report, wait for go-ahead before the next.
- Two long-lived agents: a coder and a harsh reviewer, both forks sharing the spec in
  context. Review loop runs until the reviewer signs off; the orchestrator verifies
  findings independently rather than trusting either agent's report.
- **Stop rule** (qwen's own): if a task's test fails twice, stop and report.

## Read these before writing code

1. `HANDOFF-phase2.md` — most recent; has the standing rules and deferred items.
2. `DEVIATIONS.md` — 35 entries; D1–D36 with gaps.
3. `HANDOFF-phase0.md`, `HANDOFF-phase1.md` for earlier context.

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

- **D26** — spawn candidates check one column but the body is 1.5 tiles wide, so
  70–80% of spawns overlap terrain by up to 175 px. Fix: require columns `x-1..=x+1`
  clear. Must land before T4.1 (T4.3 makes spawn choice a scoring input).
- **D35** — ground speed is slope-dependent (7.525 px/tick downhill vs 7.0 flat).
  Not a violation; T2.3's "exactly 140 px/s" is a flat-ground property. Recorded only.
- **D36** — the player cannot walk up a single 16 px step (`autostep: None`). Given
  D3's measured column deltas of 7/10/14 tiles, most terrain is jump-only. **An open
  decision**: enable one-tile autostep, or accept jump-to-climb as the movement model.

## Other deferred items

See `HANDOFF-phase2.md`'s deferred table. Notably: `PhysicsWorld` is not yet driven by
a round (T4.1 owns the per-tick sequence); T3.3 will deliberately break
`generation_matches_golden_hashes` and must re-pin it in that commit; `game-core` still
needs its `tracing` dep for T4.9.
