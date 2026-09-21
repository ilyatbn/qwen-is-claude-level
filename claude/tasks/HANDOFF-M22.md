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

**6 of 19 boxes ticked.** `T22.00` (title check), `T22.00B` (smoke-shader),
`T22.01` (the gravity setting), `T22.02` (low gravity), `T22.03` (zero-g movement),
`T22.05A` (the space map generator). Each one went build → harsh review → fix pass, and every
fix pass is committed.

**`HEAD` is `5a42b86`. 28 commits this session, all on `claude_builds`, none pushed.**
Last full gate: **green in 16m49s** over `T22.00`+`T22.01` — 1459 Rust tests, 954 client,
58/58 browser. **Everything since has been `--changed` only**, so *a full gate is owed*
before the milestone closes.

### ⚠️ There is unfinished work in the working tree and it is NOT mine

`T22.05B`'s builder was running when the machine closed. It left **13 modified files**,
uncommitted and unverified:

```
client/src/core/index.ts          crates/game-core/src/map/gen/spawns.rs
crates/game-core/src/constants.rs crates/game-core/src/map/gen/v2/mod.rs
crates/game-core/src/items/spawning.rs  crates/game-core/src/map/meta.rs
crates/game-core/src/map/gen/mod.rs     crates/game-core/src/player/state.rs
crates/game-core/src/map/gen/space.rs   crates/game-core/src/world/mod.rs
crates/game-wasm/src/lib.rs             crates/game-core/tests/golden_hashes.txt
```

**`golden_hashes.txt` is among them, so the golden table has been regenerated and not
verified.** Do not assume it is right.

**The recovery procedure that already worked once this session** (`T22.02`'s builder died the
same way, with ~1300 lines in the tree):

1. `git status --porcelain` and `git diff --stat` — see what is actually there.
2. Check whether any source file has moved **since** the builder's own last green run:
   `find crates client -newer <its gate log> -name "*.rs" -o -newer <log> -name "*.ts"`.
   An empty result means the tree matches a run it already did.
3. **Verify independently — do not trust its logs.** `cargo test -p game-core`,
   `cargo test -p game-server`, `cargo fmt --all -- --check`,
   `cargo clippy --workspace --all-targets --all-features -- -D warnings`.
4. If green, commit it with a message that says **plainly** it was recovered, unreviewed, and
   that its falsifications are not on the record. Then run the harsh review.
5. If red or half-finished, **discard it and re-dispatch `T22.05B`** — it is cheaper than
   reasoning about a stranger's half-state.

Gate logs are now `.gitignore`d, so `gate-t2205b.txt` may exist and will not show as untracked.

**`node scripts/verify-repo.mjs` is RED right now, and it is the in-flight work, not `HEAD`:**

```
crates/game-core/src/map/gen/space.rs: the_open_space_hit_rate is #[ignore]d
  and not in scripts/ignored.sh's manifest
ignored tests: 24 in crates/, 23 in the manifest
repo guards: 2 problem(s)
```

`verify-repo` reads the **working tree**, and `space.rs` is one of the 13 modified files — the
builder added an `#[ignore]`d measurement and had not yet added its `scripts/ignored.sh` row.
**That is the guard doing its job on a half-finished edit, not a broken repository.** If you
discard the uncommitted work it goes green on its own; if you keep the work, the missing row is
part of finishing it. (`T22.05A`'s builder hit the identical thing and it cost it a whole
`--changed` run, because the guard runs *before* the browser stage — add the row **with** the
`#[ignore]`, not after.)

### What `T22.05B` was doing, and why it matters

**A space match is currently unplayable.** Measured through the real pipeline: all 6 spawn
points and all 6 teleport pads land at `y = h − FLOOR_CRUST − 1`, on the full-width floor
crust **outside the rim**, in the band `R16` kills you in. The crust outnumbers asteroid tops
**6:1** in the surface list, so `choose_spawns` finds it first.

Its red-before-green is `R35`: point `analyse_space`'s spawn clause at `MapMeta.spawn_points`
instead of the candidate list it currently counts and discards. **Red on all three scales.**

### The next five, in order

`T22.05B` (in flight) → `T22.11` (asteroid gravity wells — writes `world/attractors.rs`, which
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
