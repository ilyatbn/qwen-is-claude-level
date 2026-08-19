# How to work a task

## The loop

1. Read the last 3 entries of `JOURNAL.md` — that is what the previous session
   left you.
2. Open `TASKS.md` and take the **first unticked task**. Tasks are ordered by
   dependency — do not skip ahead.
3. Open that task's file, e.g. `M1/T1.03-noise.md`.
4. Read **only** the documents listed under **Read first**. Nothing else.
5. Create or edit **only** the files listed under **Touch only**.
6. Write the tests listed under **Tests**.
7. Run the command under **Done when**. Paste its output in your report.
8. Tick the box in `TASKS.md`.
9. Append one entry to `JOURNAL.md`.
10. **Stop.** Report what you did. Do not start the next task.

One task per session. That is the whole discipline, and it is what keeps each
piece of work small enough to do correctly.

The full operating instructions are `../prompt.md`; this file is the short version.

## The task file format

```
# T1.03 — Value noise and fBm
Milestone:   M1
Depends on:  T0.02
Size:        1 file, ~120 lines

Read first
  docs/10-map-generation.md §Pass 2
  docs/02-constants.md → Map generation

Touch only
  crates/game-core/src/map/noise.rs
  crates/game-core/src/map/mod.rs      (add `mod noise;`)

Deliverable
  <exact function signatures>

Notes
  <the non-obvious parts, gotchas, why it is done this way>

Tests
  <named test cases>

Done when
  cargo test -p game-core noise
```

## Rules that are not negotiable

- **Never edit `docs/`.** They are the specification. If a doc is wrong or missing
  something you need, stop and report it. Do not fix it yourself and do not work
  around it silently.
- **Never touch a file not listed.** If you think you must, stop and say why.
- **Never invent a constant.** Every number lives in `docs/02-constants.md` and
  `crates/game-core/src/constants.rs`. A number you need that is not there is a
  spec gap — report it.
- **Never report done with failing tests.** Say they fail and show the output. A
  half-finished task honestly reported is more useful than a broken one marked
  complete.
- **Never read outside this project folder.** Sibling directories on this machine
  are off limits.

## When a task is too big

If your implementation is heading well past ~250 lines, stop. Report which part
you completed, which part remains, and how you would split the task. That is a
correct outcome, not a failure — a task that needs splitting is a planning
mistake, not yours.

## When you are blocked

Report, do not improvise:

- a doc contradicts another doc;
- a dependency you need was not built by an earlier task;
- a constant is missing;
- the API from an earlier task does not match what this task expected.

Each of these is a real signal. Guessing past it produces work that has to be
undone later.

## When you are running low on context

Stop, make sure what is on disk compiles, write an `IN PROGRESS` entry to
`JOURNAL.md`, and ask for a fresh session.

## Milestone checkpoints

At the end of each milestone there is something you can actually look at. They are
listed in `TASKS.md`. After the last task of a milestone, run the checkpoint and
report what you saw — that is the moment problems surface, and it is worth the
extra minute.
