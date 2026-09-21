# M22 handoff — what the diff cannot say

Written by the coordinator, appended as the milestone lands. **Read this, `CLAUDE.md`,
`tasks/M22/M22-RULINGS.md` and your own task file. Nothing else is required reading.**

## The three files that bind you

1. **`CLAUDE.md`** — the rules. The loop, the commit form, what this project has learned.
2. **`tasks/M22/M22-RULINGS.md`** — R1–R13. Where your task file says *"owner question N"*
   or *"decide before writing"*, the ruling there is binding and the task file's "assumed"
   is superseded.
3. **Your task file**, `tasks/M22/T22.NN-*.md`.

## The box, and who owns it

**One agent runs cargo/npm/browser checks at a time.** The coordinator hands the box over
explicitly. If you were not told the box is yours, you do not run a gate — and *"the box is
free"* in a message from anyone, including the coordinator, is not a measurement. Re-run
`pgrep` yourself immediately before you start, and name your output `gate-<you>.txt`.

**Never run the full `./scripts/check.sh`.** Per task it is the **Done when** command and
then `./scripts/check.sh --changed`. The full gate is one run per batch and the coordinator
does it.

## STATE — 2026-09-22, after a fully green batch gate

**The gate is green, on an idle box, with nothing else running:** `58/58` browser checks,
**1532** Rust tests passed / **0** failed / 24 ignored, net smoke 25/25, assets ok,
`all checks passed`. That is the batch gate R53 says is the coordinator's, and it is owed again
only when the next batch lands.

**Nine of twenty-one M22 rows are ticked.** Done: T22.00, T22.00B, T22.01, T22.02, T22.03,
T22.05A, T22.05B, **T22.05C**, **T22.11A**. `HEAD` is `ca9d681`; the tree is clean.

### Read this before you trust an earlier gate log

An earlier full gate the same night read **54/58**, and **all four failures were the
coordinator's fault, not the code's**: two read-only subagents were grepping the tree during the
browser phase. Read-only cannot corrupt the tree, which is what I had reasoned about, and is
entirely beside the point — CPU is the resource. All four re-ran **4/4 green** on a quiet box,
and the four prior gate logs on disk all read 58/58. **Two of the four looked exactly like real
regressions** (both movement-related, and the only code commit in the window was the task under
review), so this was one bisect away from costing an hour. **While a gate runs, no subagents at
all.**

### The two commits in this batch, and one thing that is odd about them

- `876cb9d` **T22.11A** — the force seam. `integrate` 5 → **4** parameters, `apply_input` 9 →
  **8**, both measured by command. Changed no pixel: the golden table did not move and
  `a_resting_body_is_bit_identical_after_600_ticks` passed untouched.
- `c401def` **T22.05C** — the follow-ups from T22.05B's review, F1–F8.

**`876cb9d` does not compile on its own.** `game-core` needed three arity fixes in
`items/spawning.rs`, a file I had assigned to the *other* builder; it made them rather than leave
the tree broken for both, which was right. They land in `c401def`, so `876cb9d` is green only
with that one. **My split caused this** (`R52`): next time the task changing a signature owns
every file that calls it.

### What the batch actually established

- **R48 was a live bug in a shipped mode.** In low gravity a dropped item fell **318.17 px**
  while the player who dropped it fell **159.45** — almost exactly 2×. Four steppers passed a
  literal `1.0`. Red first at each of the four live binding sites, green now.
- **The guard four documents named does not exist** (`R50`). R10, R45, T22.11A's own task file
  and the scout all said `no_tunnelling_at_ten_times_terminal_velocity_through_integrate` would
  catch a `max_speed` leak. It does not: `Forces::gravity` carrying `Some(MAX_FALL_SPEED)` leaves
  **1062/1062** passing, because `apply_gravity` has already clamped `vel.y` to 900. The test is
  named for a speed and asserts a **distance**, and an upper bound at that. Four of us read the
  name; none read the assertion. **T22.11B must write its own.**
- **F1 refuted the review** (`R55`). All five furniture guards are live: with each flipped
  separately a space map ships 6 pads / 3 platforms / 3–10 decorations / 1–10 buried slots.
  Bonus measurement: `surface_points` 69 → **75** with only the pads guard off — that is
  `fill_standing_ground` adding rock outside an asteroid's bounding radius.
- **F5 is a follow-up, not a blocker.** Space respawns do run the branch whose own doc calls it
  unreachable dead code, **and land exactly on a listed spawn point**. T22.05B's headline fix
  covers the death path.
- **`accel` is `Vec2::ZERO` everywhere and nothing can tell.** Deleting its application left
  1062/1062 passing. Every `player/space.rs` test runs on an asteroid-free fixture. **That hole
  is T22.11B's first test or it is nobody's.**

### Two process rules that came out of this batch, both binding

- **`R53` — `--changed` IS the full gate for any `game-core` task.** `affected.mjs` maps every
  `crates/game-core/src/**` path to all 58 e2e checks, because the wasm is on every page. So the
  per-task economy buys nothing for most of this milestone. Builders run the **non-browser** half
  with exit codes, plus any single check mapped to a file they touched; **the sweep is the
  coordinator's alone.** Both builders reached this independently and declined the sweep for the
  right reason.
- **`R54` — concurrent builders do not write `JOURNAL.md` or `TASKS.md`.** The pathspec rule
  guards *files*, not lines inside one shared file. Both builders' entries were swept into
  whichever commit landed first — twice, in opposite directions. They hand me the entry; I append
  it.

### The next action

**`T22.11B` — the field**, and **`T22.06` — the backdrop**, which are disjoint (core physics vs
client rendering). T22.11B's task file carries the three rulings that overturned earlier ones:
**R46** (ceiling against `JETPACK_THRUST_DOWN`, not UP — the underside of a rock is the binding
case and R18 got it wrong), **R47** (linear falloff to a cutoff, not inverse-square), **R50** (no
borrowing the tripwire). Then T22.11C, T22.04, T22.07, T22.08, T22.09, T22.10, T22.12.

Filed, not M22: T22.00C, T22.00D, T22.00E, T22.03B.

## Per-task log

(appended as tasks land)
