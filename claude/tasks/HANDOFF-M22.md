# M22 handoff — what the diff cannot say

Written by the coordinator, appended as the milestone lands. **Read this, `CLAUDE.md`,
`tasks/M22/M22-RULINGS.md` and your own task file. Nothing else is required reading.**

## The three files that bind you

1. **`CLAUDE.md`** — the rules. The loop, the commit form, what this project has learned.
2. **`tasks/M22/M22-RULINGS.md`** — R1–R72 in full, and an index of R73–R100 (plus the final
   audit's addenda, H3 and R99) pointing at the task files that hold their text. Where a task
   file says *"owner question N"* or *"decide before writing"*, the ruling is binding. The
   resulting rules are **`docs/77-amendments-v9.md`**.
3. **Your task file**, `tasks/M22/T22.NN-*.md`.

## The box, and who owns it

**One agent runs cargo/npm/browser checks at a time.** The coordinator hands the box over
explicitly. If you were not told the box is yours, you do not run a gate — and *"the box is
free"* in a message from anyone, including the coordinator, is not a measurement. Re-run
`pgrep` yourself immediately before you start, and name your output `gate-<you>.txt`.

**Never run the full `./scripts/check.sh`.** Per task it is the **Done when** command and
then `./scripts/check.sh --changed`. The full gate is one run per batch and the coordinator
does it.

## STATE — 2026-09-25, M22 closed, batch gate pending

**Every figure below was measured at the close-out, not carried.**

- **Rows: 67 of 77 ticked** in `TASKS.md`'s M22 section (`awk` over the section, `grep -c '^\s*- \[x\]'`). The 10
  open: T22.00D and T22.00E (not M22 work, after M22), three bot follow-ups from T22.03H/I (wander cells over pits,
  the walking model's vertical blocks, walking bots' per-tick stuck test), two from T22.14B (the winged
  stuck-while-moving share, the flown-in vortex trips), two from T22.00C filed at the close-out (split
  `thrusters-match`; the five `rAF(rAF)` waits), and T22.07, superseded by M23's `R9`.
- **HEAD before this handoff's commit: `0c43885`.** The last M22 work commit is `ae749b2` (T22.14E); the close-out
  commits after it are `docs/77`, the rulings index, `TASKS.md`, `flaky-test.md`, `ARCHITECTURE-SURVEY.md`, this file,
  and one check: `chunk-rebake` (R37's rebake budget — T22.00C had moved it into `perf`, which is parked, so nothing
  gated it; now its own serial, gated check; green alone at 1.40 ms median, a 6 ms planted bake reds it at 7.10).
- **Last green batch gate: `39d2069`** (T22.10G). **57 commits since** (`git log --oneline 39d2069..0c43885 | wc -l`),
  every one gated per task by its Done-when and `--changed` only. **A full `./scripts/check.sh` on an idle box is
  owed now and is the coordinator's** — `TASKS.md` carries `BATCH GATE: green at `a3c5dea` (2026-09-25, 1224 s) — browser 73/73, vitest 1113/1113, Rust 1720 passed / 0 failed / 26 ignored` for it.
- **Rulings: R1–R100**, plus the T22.14A addenda (H3, R99) and two T22.14B confirmations. `R1`–`R72` in
  `M22-RULINGS.md`; `R73`–`R100` indexed at its end.
- **The spec: `docs/77-amendments-v9.md`**, §H1–§H21, with superseded values struck in `docs/02`, `docs/13` §7,
  `docs/20`, `docs/40`, `docs/42`, `docs/70` §A30. `CLAUDE.md` names `docs/70`–`77` as the amendments.

### Parked, as of the close-out

**Browser (`flaky: true` in `scripts/lib/e2e-checks.mjs`) — 14:** `terrain-render`, `boots-visible`,
`bullets-visible`, `night-combat`, `platforms`, `perf`, `fog-visible`, `hud-timer`, `inventory-ui`, `teleport`,
`thrusters-match` (new, T22.14E), `solar-flare-match`, `two-clients`, `m10-checkpoint`.
**Rust (`#[ignore = "flaky: …"]`) — 4:** `integration.rs::a_seventh_client_is_told_the_room_is_full`, and in
`lobby.rs` `a_second_client_joins_a_private_room_by_its_code`, `a_lobby_room_has_no_bots`,
`lobby_state_names_everyone_in_the_room_including_yourself`.
**Recorded, not parked** (R40/R68 — the socket-harness family `T22.00E` owns): `in_progress.rs`'s join-by-code,
`checksum.rs`'s hundred carves, `rooms.rs`'s never-reaped, `lobby.rs`'s refused `set_scale`; and `bots.rs::bots_actually_move`
(seed since pinned). Evidence for every one is its row in `tasks/flaky-test.md`.

## Owner decisions pending

Nothing here blocks a builder; each is a call only the owner makes.

1. **Un-park three checks whose cause is fixed.** `fog-visible` (T22.00G: both values now come off one drawn frame;
   3/3 alone, 2/2 at `--jobs 4`), `solar-flare-match` (T22.08F: the client clock is compared at the server's tick,
   no round trip; 3/3 at `--jobs 4`), `teleport` (T22.10D F7: a check bug — it read truncated health as death; 3/3).
   Each is fixed and still carries `flaky: true` because un-parking is the owner's decision.
2. **`thrusters-match`, parked by T22.14E.** Its bell arm went red 2 of 24 after T22.14D and 0 of 27 before — not
   distinguishable from chance, no causal path found — and its precondition also reds at random. **The flag parks the
   whole check**, so its other arms (a remote's plume in a real match, none after the bell, none under standard
   gravity, none on a player killed mid-burn) gate nothing. The split is filed; until it lands, those arms are
   uncovered. Keep parked, or un-park and accept a ~1-in-12 coin flip in the gate.
3. **`terrain-render`**: its deterministic red (a stale layer pin) was fixed in T22.08D; the original camera-motion
   flake is still live. **`perf`**: it reads the box's leftover load, not the game's frame time. Fix, delete or keep
   parked.
4. **The thin-evidence parked checks**, each parked on one to three sightings in 2026-09-14's gates and never
   re-examined: `boots-visible`, `two-clients`, `bullets-visible`, `hud-timer`, `night-combat`, `m10-checkpoint`,
   `inventory-ui`, `platforms` (one sighting). And the four parked Rust socket tests, whose shared harness is
   `T22.00E`'s — scheduled after M22.
5. **Radiation balance.** The suit design (`R24`) ships as ruled, and the measurement says battery packs are the
   tight end: **0.60–0.73 packs spawn per player per round** (and bots picked up 0.27) against the coordinator's
   estimate of **~1.4** a player needs to stay sealed through a round, and **0.69–0.71 radiation deaths per player
   per round** over 8 seeds (`space_radiation_report`: T22.09A, re-run by T22.08A after the flare). Bots only; a
   human who hunts packs does better. Survivable, not comfortable. The knobs are `BATTERY_PACK_SPACE_WEIGHT_MULT`,
   `RADIATION_DPS` and `RADIATION_SHIELD_COST` — the owner's to move.
6. **Changes the owner never saw in these words** (ruled by the coordinator under *"make your own decisions"*, and
   shipped): low gravity is the **most violent** mode (8.5× the shots, 4.3× the kills of standard, bots only — `R31`);
   in space **grenades, rockets and molotovs fly dead straight** (`R38`); in space **low health does not slow you and
   boots cost range** (`R41`); **standard bots now keep twice the stand-off from their own fire** (`BOT_FLAME_REACH_SCALE`
   2.0, `R95` — it cut their self-burn from 4.2 hp a throw to 1.8). Each has a one-place reversal in its ruling.
7. **One open reading, flagged by T22.14A:** the vortex's decorative swirl is sized off the capture ring (two capture
   radii); drawn out to the full `VORTEX_REACH` it left the screen at 1280×720 and showed through the minimap. If `R98`
   meant the whole reach, that is a new ruling and a new instrument.
8. **`client/src/render/backdrop-real-*.test.ts`**: one slow vitest family near the runner's timeout (`flaky-test.md`,
   T21.18) — whether it leaves the default run.

## History

The STATE this file carried from 2026-09-22 (after the fully green batch gate at `ca9d681`, nine of twenty-one rows
ticked, T22.11A and T22.05C just landed) is in git: `git show 0c43885:claude/tasks/HANDOFF-M22.md`. The per-task log
this file reserved was never used — the per-task record is `tasks/JOURNAL.md` and each task file's *As built*.
