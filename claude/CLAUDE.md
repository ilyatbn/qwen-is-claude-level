# Rules for the implementing model

Read this file first, every session. It is short on purpose.

`prompt.md` at the project root is the session-start prompt; this file is the rules.

## The single most important rule

**Do exactly one task per session.** A task is one file in `tasks/M*/T*.md`.
Open it, do what it says, run the command in its "Done when" section, tick its box
in `tasks/TASKS.md`, then stop and report. Do not start the next task.

## Scope confinement

- The project root is the folder containing this file. **Never** read, copy, or
  reference anything outside it. Sibling folders (`../idk_wtf__ignore`, `../qwen`)
  are off limits — no assets, no code, no inspiration.
- Only touch the files listed under **Touch only** in the task. If you believe you
  need to edit a file that is not listed, stop and say so instead of editing it.
- **Never edit anything in `docs/`.** Those are the specification. If a doc looks
  wrong or is missing information you need, stop and report the gap.

## Context discipline

Each task lists a **Read first** section naming the exact doc sections you need.
Read those and nothing else. You do not need to read the whole project, and you
should not try. If a task feels like it needs more than its listed files, that is
a signal the task is mis-scoped — say so rather than expanding it.

## Size budget

A task is sized for roughly **one file and at most ~250 lines of code**. If your
implementation is heading well past that, stop and report that the task needs
splitting. Do not "just finish it" at 800 lines.

## Code rules

- Rust: `game-core` is **pure** — no `tokio`, no `std::fs`, no networking, no
  randomness other than a `ChaCha8Rng` passed in explicitly. Anything impure
  belongs in `game-server`.
- Never use `rand::thread_rng()` or `StdRng`. Seeded `ChaCha8Rng` only. Determinism
  is a hard requirement — a seed must always produce the same map.
- Never write a numeric tunable inline. Every constant lives in
  `crates/game-core/src/constants.rs`, mirroring `docs/02-constants.md`.
- Tests go in the same file, in `#[cfg(test)] mod tests`, unless the task says otherwise.
- No `unwrap()` / `expect()` in `game-server` request paths. In `game-core` and in
  tests it is fine.
- TypeScript: `strict` is on. No `any`. No physics or map logic in TypeScript —
  that all lives in `game-core` and reaches the client through WASM.

## Before you say you are done

1. Run the exact command in the task's **Done when** section and paste the result.
2. Run `./scripts/check.sh` if it exists (from M0.8 onward).
3. Tick the checkbox for your task in `tasks/TASKS.md`.
4. Append one entry to `tasks/JOURNAL.md` — the handoff note for the next session.
5. Report: what you built, the test output, and anything you noticed but did not fix.

Never report a task as done if its tests fail. Say they fail and show the output.

## If you are running low on context

Stop. Make sure what is on disk compiles, write an `IN PROGRESS` entry to
`tasks/JOURNAL.md` saying exactly what is done and what is not, and ask for a fresh
session. Asking for a refresh is never the wrong call.
