# RESUME — read this first

Cold-start handoff. Trust this file over anything remembered.

**Last updated:** after the M13 playtest round. Tree clean, nothing uncommitted.
HEAD: `a5d8ed3`.

---

## Where the project is

**141 tasks done, 28 open.** The game is playable: menus, matchmaking with join
codes, 20 weapons, destructible terrain that agrees bit-for-bit across clients,
weather, day/night, bots, tombstones, minimap, replay determinism.

**Backend gate is green.** `cargo test --workspace` → **921 passed, EXIT=0**, fmt and
clippy `-D warnings` clean.

**Browser suite is RED: 22/27.** That is the thing blocking everything else.

```
FAIL crates · death · ordnance · two-clients · m10-checkpoint
```

---

## What happened last session, honestly

The plan was the playtester's eight items (T13.06.2–.9). **None of them were
started.** The whole session went into T13.06.1 and a regression it caused:

1. **T13.06.1 landed** — no battle exists until players ask for one. The feature
   works.
2. **It was committed on an unverified gate.** The gate exited at the Rust stage, so
   the browser suite never ran. The summary printed an empty `e2e` line and that was
   read past. → reopened.
3. **It froze `world.tick`**, because §C18 said "a Lobby room does not tick" and
   `tick` is incremented inside `step()`. Every replay loop is `while tick < until`,
   so **any recording containing a lobby spun forever at 100 % CPU** — two orphaned
   `replay` processes burned a core for 35 minutes on the playtester's machine.
   Fixed in `ba02c01` (`World::tick_idle`, plus stall guards).
4. **The determinism test was found to be vacuous** (§C27): it could not tell a real
   1400-tick round from 1400 idle lobby ticks and would have passed against any
   build. Now carries a non-vacuity assert.

Net: one feature, one severe regression found and fixed, one flagship test repaired,
and **zero of the reported gameplay bugs addressed.**

---

## Next session: do these in this order

### 1. T13.06.1 — finish it (the suite is red because of it)

`tasks/M13/T13.06.1-rooms-on-demand.md`, "Reopened" section at the bottom.

Add **one shared `enterBattle(page, opts)`** helper and route every browser check
through it. **Do not** add the room's start config to five more checks — eight copies
of one setup is eight places to forget one, and this repo has paid for that four
times (five vite parses, four wasm hooks, two capsule rasterisers, two escapers).

**But note: the five failures are not all lobby-entry.** Measured:

- **`crates`** — the client *is* in a battle and walking. The crate landed 300 px
  above it on a ledge; closest approach **91 px** against a `PICKUP_RADIUS` of 20.
  Fixture fragility, probably exposed because room-on-demand changed the room id and
  therefore the seed (§B13).
- **`death`** — reaches the battle and dies (`alive-flag dead=true`, health 40→40)
  and **the overlay never appears.** That is a real bug, not a harness problem.
- `ordnance`, `two-clients`, `m10-checkpoint` — not yet diagnosed.

Acceptance: `node scripts/e2e.mjs` is **27/27**.

### 2. T13.06.11 — the room reaper has no caller

`RoomRegistry::reap()` exists; all five callers are tests in its own `#[cfg(test)]`
module. Observed live: a server with **zero players** held `rooms: 2` steady for
40 s. Rooms accumulate until `MAX_ROOMS` (32), after which the server cannot start a
game and the player sees "create game does nothing". Sixteenth §A39.

### 3. T13.06.2 → T13.06.9 — the playtester's list, untouched

| task | the report |
|---|---|
| T13.06.2 | melee/axe/bat hitbox reaches far too far — should be immediate proximity |
| T13.06.3 | cannot attack or fire while moving |
| T13.06.4 | toxic rain shows underground; should fall from a cloud as projectiles |
| T13.06.5 | meteors show only their explosions; need to be visible and dodgeable |
| T13.06.6 | **gun projectiles still invisible** — T13.03 shipped with a *passing* pixel test, so the test samples what the player is not looking at. Find which class (projectile vs hitscan tracer) before changing anything, and fix the test too |
| T13.06.7 | a weapon should occupy one slot ever; a duplicate pickup refills ammo |
| T13.06.8 | the round-end countdown does not count down |
| T13.06.9 | jetpack refill looks wrong — **measure the curve** against `JETPACK_DRAIN`/`REFILL_DELAY`/`REFILL` before changing anything, and add the numeric readout |

### 4. T13.06.10 — the gate self-loads

11 lobby tests each spawn a server on a 4-worker runtime; wall-clock waits become a
coin flip. Filed, not urgent.

**M14 does not start until every T13.06.x box is ticked.**

---

## Traps that cost real time here — all in `CLAUDE.md`, all still worth repeating

- **`make stop` and `proc-group.mjs` do not cover `cargo test` children.** After any
  gate run, look for `target/debug/{replay,game-server}` orphans yourself. A hung
  `replay` looks exactly like a busy box.
- **A gate that exits early never reached e2e.** An empty e2e line is not a pass.
- **`pkill -f <pattern>` matches the shell running it.** Two sessions killed their own
  shell with it despite the rule being written down; use `ps -eo pid,args | awk`.
- **Never run the gate while a person's vite/Chrome is up** — and never kill theirs.
- **Falsify at the live binding site**, and check that the falsification *fails*. Three
  falsifications this milestone passed against the bug they were written for.

## Running it

```sh
make start      # server :3000 + client :5173
make play       # headed Chrome with CDP (this box has WSLg)
make probe      # read that window's state + screenshot, without closing it
make test       # the full gate — needs an idle box
```
