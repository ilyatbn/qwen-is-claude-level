# Rules for the implementing model

Read this file first, every session. It is short on purpose.

`prompt.md` is the session-start prompt; this file is the rules.

## The specification

- `docs/00`–`62` are the original spec.
- **`docs/70`–`75` are amendments and they override the originals**
  where they disagree. Read the sections a task names.
- **Never edit `docs/`.** If a doc is wrong or missing something, stop and report
  the gap — amendments are written by the coordinator, not by a builder. Reporting a
  spec defect is a valued outcome: ten of them have been found this way, and every
  one was a real error.

## The loop

One task per assignment. A task is one file in `tasks/M*/T*.md`. Open it, do what it
says, run its **Done when** command, then:

1. Paste the **real** output of that command.
2. **Run `./scripts/check.sh`.** A Done-when proves the task; the gate proves the
   repository. A crate-scoped Done-when has twice let a commit land that broke the
   workspace build — it cannot see a type that grew in one crate and not its
   consumers.
3. Tick the box in `tasks/TASKS.md`.
4. Append a ≤8-line entry to `tasks/JOURNAL.md` — the handoff.
5. **Commit**, from the repo root, staging **only** paths under `claude/`. Never
   `git add -A`; never stage `qwen/`.

Never report a task done if its tests fail. Say so and show the output.

## Scope

- The project root is the folder containing this file. Never read or write outside
  it, except `../sprite_packs`, which is an input the coordinator has approved.
- Only touch the files a task lists under **Touch only**. If you must edit another,
  stop and say why.
- A task is ~one file and ~250 lines. Heading well past that means it needs
  splitting — say so rather than finishing at 800 lines.

## Code rules

- `game-core` is **pure**: no tokio, no `std::fs`, no networking, no ambient
  randomness. Seeded `ChaCha8Rng` only — never `thread_rng()` or `StdRng`.
  Determinism is a hard requirement.
- Every numeric tunable lives in `constants.rs`, mirroring the docs. Never inline a
  number, and **never hardcode one in a test** — pin to the constant, or the fixture
  stays green against a drifted implementation.
- No `unwrap()`/`expect()` in `game-server` request paths. Fine in `game-core` and
  tests.
- TypeScript is `strict`, no `any`. No physics or map logic in TS — that is
  `game-core`, through WASM.
- Rust tests live in the same file under `#[cfg(test)] mod tests`.
- `cargo fmt --check`, `cargo clippy --all-targets -- -D warnings` and typecheck
  must pass.

## What this project has learned

Every rule below was paid for with a real bug. They are the difference between a
green suite and a working game.

**On tests**

- **Ask what a passing assertion rules out.** If the property would hold with your
  code deleted, you are testing the framework, not your code.
- **Cite the symbol, not the line.** `world/mod.rs::apply_damage_log`, not
  `world/mod.rs:1924`. A line number is a claim with nothing re-validating it, and it rots
  fast: `world/mod.rs` gained ~700 lines in one task and `player/state.rs` ~380 in another,
  so **four of five citations in a task file written two weeks earlier pointed 200–400 lines
  early**. A `grep -n "fn apply_damage_log"` is right today and stays right through any
  amount of growth. Line numbers are fine for a *review* of a fixed commit; they are wrong in
  anything meant to be read later.
- **A proposed guard is a claim, and it needs the same falsification as the code it guards.**
  Ask it of the *remedy*, not only of the bug. This has now been missed three times in one
  milestone from three different roles: a coder shipping a falsification that edited a path
  its test never used; a reviewer proposing `set -e` as the fix for the one idiom `set -e`
  cannot see; and a coordinator writing a rule about instruments while citing a commit sha
  it had never read back.
- **Falsify at the *live* binding site.** Seven falsifications here proved nothing
  because they edited a default, a constructor argument or a path the test never
  used. Break the thing the test actually calls.
- **A test asserting an absence needs a control asserting the presence.** "No damage
  during warmup" is satisfied by a game that never deals damage.
- **A metric with no control is a number, not evidence** — and the instrument is
  often the bug. One measurement timed six players standing still; one counted
  `attacker.is_some()` and reported the two worst weapons as the best.
- **Assert on effects, not intentions.** A counter saying work was attempted is not
  evidence it happened. Heavy fog's formula was correct for five milestones while
  nothing carried the number to the screen.
- **For anything visible, assert on rendered pixels** (`docs/72` §C2), with a
  control region and a control frame. Four "I cannot see it" bugs shipped past 905
  tests because every assertion checked simulation state.
- **A population claim needs more than one draw.** Aggregate across seeds.
- **A gate that fails on a coin flip gates nothing.** Remove such an assertion or fix
  its cause; do not weaken it.
- **A test count going up is not evidence that no test was removed.**
- **An assertion on a field that does not exist cannot fail** — `undefined <=
  undefined` is false forever. Print a debug field once before trusting it.
- **A wait hardcoded against a tunable is a test that expires.**
- **The recurring shape, under most of the above: a claim reported through something other
  than the thing it claims.** `EXIT=0` standing in for "assets ok"; `debug().phase` standing
  in for a rendered frame; `attacker.is_some()` standing in for damage dealt; a `Set` of two
  literals standing in for a check of the real source; `ls | tail` standing in for a file
  count. When you write an assertion, ask what it would report if the thing it names had not
  happened at all.

**On code**

- **Grep for the *production* callers of anything you build.** Twelve mechanisms
  here were built, unit-tested and wired to nothing — including bots that never
  fired a shot and a terrain renderer never told the map had changed. **A test
  calling the function is not a caller.**
- **Count the thing at both ends** and assert the two numbers against each other.
- **Grep the layer that owns the state**, not the layer you happen to be reading.
- **A field that means two things** is a bug waiting for the first caller that wants
  one of them.
- **Derive, do not add a fourth flag** — three flags can disagree.
- **Return what the caller needs.** An API that makes the caller preserve state it
  is about to destroy will be called wrong.
- **Share the guard, or share the function.** A second function that touches the
  same invariant will drop the guard the first one earned.
- **Measure before changing**, and **revert what you cannot explain.**
- **A fix that changes the code without changing the picture looks exactly like a
  fix that worked.** Screenshot it and look.

**On the machine**

- **Kill process *groups*.** `vite`, `npm run dev` and `cargo run` all fork the
  process that holds the port. Ten orphaned servers once accumulated and were blamed
  for three sessions of "flaky test". Use `scripts/proc-group.mjs`.
- **Never hand-write the vite port parse** — the bold escape sits between the colon
  and the digits. Use `scripts/vite-url.mjs`. Six copies, six identical breaks.
- **Do not run the gate while another vite or cargo run is active.** A loaded box
  makes every wall-clock assertion a coin flip.
- **Never chain file authoring behind `cd X &&` — and know that `set -e` will not save you.**
  Measured, not argued — **in an empty scratch dir**, or `nonexistent/` may exist and you
  will get four different answers and conclude the rule is wrong:

      ( cd nonexistent && echo hi > a.txt ); echo $?            → 1   a.txt missing
      bash -c 'cd nonexistent && echo hi > a.txt
               echo second > b.txt'                             → 0   a.txt missing, b.txt written
      bash -c 'set -e
               cd nonexistent && echo hi > a.txt
               echo second > c.txt'                             → 0   c.txt STILL written
      bash -c 'set -e
               cd nonexistent
               echo second > d.txt'                             → 1   d.txt missing

  So: the chain **does** signal failure in isolation (exit 1). What swallows it is being one
  line among many, where the invocation's status is the last command's. And **`set -e` does
  not help**, because POSIX exempts every command of an AND-OR list except the last from
  errexit — line 3 above proves it. Only a **bare** `cd` on its own line under `set -e`, or an
  explicit `cd X || exit 1`, actually stops.

  Hit twice in one session by two different agents twenty minutes apart, so it is a property
  of the idiom rather than a slip. **Use an absolute path, or a bare `cd` on its own line, or
  `cd X || exit 1`.**
- **Put `set -e` on any multi-line Bash that authors files** — it catches the *other* ways a
  middle line dies quietly (an unterminated heredoc, a `mkdir` into a read-only path, a
  `git add` of a path that does not exist). It just does not catch the one above.
- **Count a listing, do not read its tail.** The tell for the above was `ls` showing sixteen
  files where seventeen were expected, and it was missed by looking at `tail -4`. `ls | wc -l`
  is the assertion; `ls | tail` is a glance.
- **Interactive debugging is headed, not headless.** This box has WSLg; `make play`
  opens a real Chrome with CDP and `make probe` reads it without closing it. When a
  person is watching, they take the controls.

## If you are running low on context

Stop. Make sure what is on disk compiles, write an `IN PROGRESS` entry to
`tasks/JOURNAL.md` saying exactly what is done and what is not, and say so. Stopping
cleanly at a task boundary has been the right call eight times on this project.
