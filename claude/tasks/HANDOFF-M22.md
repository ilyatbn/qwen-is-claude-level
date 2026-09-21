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

## STATE AT PAUSE — 2026-09-21, owner closing the machine

**Read this section first. It is the only part that goes stale.**

### Where M22 is

**7 of 19 boxes ticked.** `T22.00` (title check), `T22.00B` (smoke-shader),
`T22.01` (the gravity setting), `T22.02` (low gravity), `T22.03` (zero-g movement),
`T22.05A` (the space map generator) and `T22.05B` (spawns and everything that assumed "up").
The first six each went build → harsh review → fix pass, all committed. **`T22.05B` has had no
harsh review and no `--changed` run** — it is the one piece of this milestone that has not been
through the loop.

**`HEAD` is `5a42b86`. 28 commits this session, all on `claude_builds`, none pushed.**
Last full gate: **green in 16m49s** over `T22.00`+`T22.01` — 1459 Rust tests, 954 client,
58/58 browser. **Everything since has been `--changed` only**, so *a full gate is owed*
before the milestone closes.

### ⚠️ SUPERSEDED — `T22.05B` finished and committed before the stop landed

The paragraph that was here described 13 uncommitted files. **That state is gone.** The builder
completed, committed and cleaned up; `git status --porcelain` shows **0 tracked changes**, no
`.bak` files, no planted code, no processes, and `verify-repo` is **ok (24/24)**.

- `6e1ef91` — T22.05B: space spawns, objects, and everything that assumed "up"
- `00d7dc4` — T22.05B: journal entry

**The one thing it was not allowed to do: `./scripts/check.sh --changed` never ran**, because
the stop order forbade it. It touches a client file, so per `R22` that is the full browser
suite. **That is the single next action**, before `T22.05B` is trusted or anything is built on
it. Everything else it ran is green: `cargo test -p game-core` 1056 + integration binaries,
golden, `cargo test -p game-server --lib` 152, fmt, clippy, `tsc`, and
`node scripts/e2e.mjs minimap` 2/2 with a new space arm.

**Two findings from it worth carrying forward.**

1. **The feature would have shipped wired to nothing, and no test would have said so.**
   `World::spawn_for` and `player/state.rs::choose_surface_point` both gate
   `MapMeta.spawn_points` on `surface::is_standable`, which demands `MIN_SUPPORT_PX` of rock
   under the body box — **an open-space spawn fails that by definition**. Every space spawn
   would have been chosen, validated, shipped, hashed into the golden table, and **silently
   discarded at the moment of use**, with both callers falling through to a surface fallback
   that returns a perfectly legal-looking position. Found by greping production callers, not by
   a test. `Map::body_fits_at` is now the single place that choice is made.
2. **A build-system trap that cost it ten minutes and would cost more next time.** Its
   falsification sweep restored each planted file from a backup whose **mtime was earlier than
   the planted write**, so cargo reused the **planted binary** on the next run and one test
   read red against correct source. **`touch` every planted file before believing any
   post-sweep run.**

**One open question it reported rather than quietly dropping:** one plant of sixteen stayed
**green** — forcing `random_body_site`'s space arm to `None` left
`initial_items_land_inside_the_arena_in_space` passing, because once the surface filter landed,
a surface point *is* inside the arena, so the test cannot tell "items in open air" from "items
on asteroid tops". It still catches the void-crust regression it was written for. If `R14`'s
open-air placement should be gated, that needs an assertion that the item is **not** on a
surface point — a two-line follow-up.

### What `T22.05B` was doing, and why it matters

**A space match is currently unplayable.** Measured through the real pipeline: all 6 spawn
points and all 6 teleport pads land at `y = h − FLOOR_CRUST − 1`, on the full-width floor
crust **outside the rim**, in the band `R16` kills you in. The crust outnumbers asteroid tops
**6:1** in the surface list, so `choose_spawns` finds it first.

Its red-before-green is `R35`: point `analyse_space`'s spawn clause at `MapMeta.spawn_points`
instead of the candidate list it currently counts and discards. **Red on all three scales.**

### The next five, in order

**`T22.05B`'s `--changed` run and its harsh review** → `T22.11` (asteroid gravity wells — writes `world/attractors.rs`, which
`T22.10` and `T22.12` then share, per `R11`) → `T22.04` (thrusters) → `T22.06` (backdrop) →
`T22.08`/`T22.09` (flares, radiation) → `T22.10`/`T22.12`/`T22.07`.

**`T22.11` carries three debts** that other tasks parked on it: absorb `apply_input`'s ninth
argument **and** `integrate`'s fifth into `Forces`/`Env` (`R10` amended, `R44`); put the
asteroid levels into the state hash (`R36`); and scale the four non-player bodies under `Low`
as well as zeroing them under `Space` (`R30`).

### Not M22, filed, do after

`T22.00C` (three more unfired wall-clock coin flips + the `objects` rebake budget),
`T22.00D` (`airborne_ticks` is unhashed and is not derived), `T22.00E` (four parked socket
flakes sharing one harness), `T22.03B` (bots in space — measured at **20 % of the damage and
18 % of the kills**).

### The two things the owner should be told when he is back

1. **Low gravity is the most violent mode in the game**, not the gentlest — 8.5× the shots
   fired and 4.3× the kills over 8 seeds. Physics, not a bug: things arc further, so fights
   start more often. `R31` ships it rather than retuning a number he never saw.
2. **Projectiles fly dead straight in space** — a grenade is as accurate as a bullet. `R38`
   keeps it as the honest meaning of no gravity, and says so out loud because nobody asked
   for it in those words.

---

## Per-task log

(appended as tasks land)
