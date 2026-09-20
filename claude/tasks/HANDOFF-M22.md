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

## Per-task log

(appended as tasks land)
