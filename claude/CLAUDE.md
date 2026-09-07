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
  **Know what that costs, because it is measured: a suite where every assertion is pinned to
  the constant cannot detect the constant itself changing.** Planting
  `ITEM_SPAWN_INTERVAL` 14 → 42 leaves **all 1296 gate tests passing, none failing** — every
  assertion moved with it, exactly as this rule requires. Pinning tests the implementation
  against the constant; **nothing then tests the constant against reality.**
  **And the ignored measurements do not save you either — verified by planting it and running
  them: all five pass too.** An earlier note here claimed that suite caught it; it does not, and
  the claim was repeated once before anyone re-ran it. So for `ITEM_SPAWN_INTERVAL` the true
  statement is the strong one: **nothing in this repository detects that constant changing.**
  A tunable whose *value* matters needs an assertion of a different kind — against a measured
  basis, the way `capacity.rs::max_rooms_carries_its_basis` pins the claim its doc comment
  makes, or against a golden (`golden.rs::generated_masks_match_the_golden_table` does catch
  every terrain parameter this way, checked). **Beware the near miss**: `density_report` floors
  item *variety* and the plant moves *rate* — 37.1 spawns → 26.1 — so a test that looks like it
  covers the area passes while the thing it is named for moves by a third.
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
  code deleted, you are testing the framework, not your code. **This applies to a task's
  Done-when, not only to its tests** — run the Done-when *before* you start and watch it fail.
  A Done-when that is already green is a task nobody has to do, and it is how a requirement
  gets added without anything being able to report its violation.
- **Cite a rule by its invariant, not by its slogan — a rule cited by its wording is a line
  number by another name.** These rules get sharpened; three were reworded this week, and each
  rewording orphans whatever cited the old phrasing. A task file once pointed at
  "count-a-listing-do-not-read-its-tail" after that rule had been renamed, so a reader
  following it found nothing and would have concluded it was retired. **Before rewording a
  rule, `grep -rn "<old phrase>" tasks/ CLAUDE.md`** — the same check the `TASKS.md` link guard
  performs for links.

  **The discriminator is whether the title states the claim or merely labels it.** Two other
  task files cite rules by title — "the count-the-thing-at-both-ends rule", "the
  field-means-two-things rule" — and both still resolve, because those titles *are* the
  invariant: reading them tells you the rule. "count-a-listing-do-not-read-its-tail" named an
  *instrument* instead, so it moved the moment the instrument generalised to `head` and a
  truncated terminal. **A title that states its invariant is safe to cite; a slogan naming a
  tool is not.** Do not go rewriting citations of the first kind — they are not the bug.
- **Never write a command's output you did not run.** Twice this session, both times inside
  text arguing for rigour: a commit sha supplied from memory because the command ended
  `&& echo ok` and never printed one, and `grep -rn fixed_seed …/tests/ returns 0` in a
  paragraph whose whole subject was greps that mislead — it returns 6, and the six were the
  best evidence in the section. **A remembered output is not a measurement**, and the moment
  you are most likely to invent one is while writing about care. Run it, paste it, then write
  the sentence.
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
  nothing carried the number to the screen. **A comment claiming an invariant is an
  intention too, and reading one retired a live bug here for half an hour.** A catch-up
  block documents itself as unreachable in production; the guard it rests on is a bare
  atomic read taken outside the room task and acted on two command round-trips later, so
  the claim is true when sampled and false when used. Confirm a comment's invariant at the
  code that maintains it before you believe it about the code that reads it.
- **For anything visible, assert on rendered pixels** (`docs/72` §C2), with a
  control region and a control frame. Four "I cannot see it" bugs shipped past 905
  tests because every assertion checked simulation state.
- **A population claim needs more than one draw.** Aggregate across seeds.
- **"The failure moves" is evidence against *one broken test*, not evidence *for* load.**
  A flaky-list entry once reasoned that because a different member failed each run and none
  recurred, no single test could be broken. But those tests **shared a fixture**, and one cause
  produces exactly that pattern: a different member each time, none recurring.
  **Before concluding "load", ask what the failing tests share.**
  **The conclusion held and my first guess at the shared thing did not — which is the reason
  to measure rather than to reason.** I named a timeout budget that happened to equal the
  constant it waited on. Thirteen full-suite runs with the budget instrumented: **277 waits,
  213 of them consumed 0 % of their deadline and the worst consumed 17 %** — nothing was within
  a factor of six of binding, and the coincidence was real but inert. The shared thing was
  `test_config`'s inherited `fixed_seed: None`: an unpinned map, re-rolled every run, deciding
  where a player spawns. **A plausible shared cause is still a hypothesis; instrument the
  suspect before you fix it.**
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
  **Its commonest form when checking someone's work: verifying against the artifact as it
  stands rather than as they wrote it.** Three times in one day, by two people in both
  directions — a survey "named all thirteen" in the message but nine in the file, and a
  re-validation's own added citations counted as evidence that the original's citations were
  maintained. `git show <commit>^:<path>` is the artifact under review; the working tree is
  the artifact after everyone's corrections, including yours.
- **A status line is a measurement, and it is only valid at the moment it was taken.** Three
  consecutive reviews here closed with "one dirty path" while the tree had five — a value read
  once and restated as though re-read, by the reviewer who had spent those same three reviews
  correctly refusing other people's remembered numbers. Re-run it; do not carry it.
  **The costly half is not the wrong number, it is what the wrong number displaced.** The four
  unreported paths included the one file whose presence answered the open question about the
  work in flight, so the habitual field crowded out the informative one. When you report
  state, ask what would have to appear in it to change your next decision — and check that
  your report is capable of showing it.
  **The lapse lives in the register, not the subject.** All three of one reviewer's errors in a
  single day — a carried dirty-path count, load read as process liveness, and a milestone
  comparison that was backwards — were *closing* sentences, added after the verified body, in a
  voice that felt like summary rather than assertion. The analysis was measured; the prose
  around it was not. **Any sentence carrying a comparison, a count, or a claim about current
  state gets a command before it gets written, wherever it sits in the message.**

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
- **Never read a filtered listing as a population.** `tail -4`, `head -12`, `| head -N` and a
  terminal that truncated the output are all one failure. It has happened twice here: sixteen
  files read as seventeen off `tail -4`, and eight `test_config` copies read as five off
  `grep | head -12` — the second by the person who had just written this rule. **Any claim of
  the form "there are N of these" gets `| wc -l`.** `ls | wc -l` is the assertion; `ls | tail`
  is a glance.
  **But `wc -l` counts lines that contain the string, not the things the string names, and
  that is a different number.** Counting `#[ignore]` attributes this way returned 14 where
  there were 13: the fourteenth was a module doc comment containing the literal
  `` `#[ignore]`d `` as prose about a test already counted at its attribute. Following this
  rule produced the wrong count, which is why the correction lives here. **Anchor the pattern
  to the syntax of the thing** — `^\s*#\[ignore` — and when the count decides something,
  enumerate what matched and read the outliers.
- **Interactive debugging is headed, not headless.** This box has WSLg; `make play`
  opens a real Chrome with CDP and `make probe` reads it without closing it. When a
  person is watching, they take the controls.

## If you are running low on context

Stop. Make sure what is on disk compiles, write an `IN PROGRESS` entry to
`tasks/JOURNAL.md` saying exactly what is done and what is not, and say so. Stopping
cleanly at a task boundary has been the right call eight times on this project.
