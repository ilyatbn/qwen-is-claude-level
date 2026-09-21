# Flaky tests — parked out of the gate

Parked by the owner on 2026-09-14, **pending a decision** on each: fix it, delete it, or
put it back. Nothing here is deleted; a parked test still runs when asked for by name.

- Browser checks carry `flaky: true` in `scripts/lib/e2e-checks.mjs` — skipped by the default run,
  run with `node scripts/e2e.mjs <name>`.
- Rust tests carry `#[ignore = "flaky: …"]` — run with
  `cargo test -p <crate> --test <file> <name> -- --ignored`.

**Parking a test removes its coverage.** Each one below guards something real; the "guards"
column is what nobody is checking while it sits here.

| test | kind | evidence | guards |
|---|---|---|---|
| `terrain-render` | browser | red in the T21.18 laser gate (2026-09-14): "19.0 % of the frame changed — the view is moving" | a crater changes the rendered picture (§C0) |
| `boots-visible` | browser | same gate: control region changed by 12.8; T21.23 measured it **2-in-3 red on an idle box** at HEAD, camera ease moving a screen-space band | ironman boots are visible on the player |
| `two-clients` | browser | red in a T21.26 gate (2026-09-14); a gun-platform flake that T21.22b was meant to close | the M6 checkpoint — two clients, one server, one round |
| `bullets-visible` | browser | carried on the known-flaky list since M19 (`HANDOFF-M19.md`) | a bullet is drawn while it flies (§F2) |
| `hud-timer` | browser | carried on the known-flaky list since M19 | the round timer and event banner (§C8) |
| `night-combat` | browser | carried on the known-flaky list since M19 | beams light the dark at night |
| `m10-checkpoint` | browser | red twice in M19 full gates, green on standalone re-run both times | the M10 checkpoint — rooms and join codes |
| `inventory-ui` | browser | red in 4 of 6 suite runs on 2026-09-14 (builder B's `--jobs` measurements), **including one at `--jobs 1`**, so not a concurrency effect. Every time the same line: "the shovel is still in slot 8 and the bag went 6 -> 7 slots — something else was dropped instead". The bag *grew* during a fixed `sleep(600)` after right-clicking the kit — a pickup — and the assertion reads any change in bag size as a drop | the starting kit cannot be dropped (§F5), and a drag that reaches the server (§C10) |
| `teleport` | browser | red 3 times on 2026-09-14: both own-stack `--jobs 4` runs ("the charge never left zero — jumping did not arm the pad"), then **alone**, in the serial tail of builder B's `check.sh --changed` gate at `1160eac` at load ~10 ("timed out after 30 s waiting for the respawn — last seen: health 0, alive true, death overlay false"), so `serial` did not cure it; green in two `--jobs 1` runs. A 30 s wall-clock wait on a server-side respawn | teleport pads charge, fire and move the player (§C5) |
| `perf` | browser | red in the coordinator's full gate at `5b1d587` (2026-09-14): 51.3 fps against the 55 floor, running `serial` in the tail right after the parallel phase; 54.9 fps alone while that load decayed (1-min load 6.6); then **59.9 and 59.5 fps alone on an idle box** (load 0.86). No game code changed since it last passed. The frame rate is fine; the check reads the box's leftover load | frame time stays at 60 fps (§A38) |
| `platforms` | browser | red once in the same gate at `--jobs 4`: "the mean moved only 2.2 (threshold 8), though the pixels did rearrange"; green alone at load 6.6 in 6.1 s. One sighting — a candidate for `serial` instead if it recurs only in parallel | a gun platform's turret layer is drawn |
| `game-server/tests/lobby.rs::a_second_client_joins_a_private_room_by_its_code` | Rust | died once at its first emit on an already-closed socket during Builder A's 2026-09-14 speed work; 5/5 green standalone. Same `AlreadyClosed` shape as the row below | a second client joins a private room by its code |
| `game-server/tests/lobby.rs::a_lobby_room_has_no_bots` | Rust | red in a T21.20 gate (2026-09-14): `emit: IncompleteResponseFromEngineIo(WebsocketError(AlreadyClosed))`; 5/5 green standalone | a lobby room seats no bots at construction (§C18) |
| `game-server/tests/integration.rs::a_seventh_client_is_told_the_room_is_full` | Rust | T22.01's gate, 2026-09-21: **green and red in the same file, on the same tree, from the same binary** — `ok` in the Done-when's own `cargo test -p game-server`, then `FAILED` ~30 min later in `check.sh --changed`'s three-crate `cargo test` at 1-min load 7.01, with `never received 'welcome' within 15s; saw []`. `saw []` is an empty inbox, so it is the socket.io handshake and not the seating path. **3/3 green standalone at 0.6 s each** against a 15.45 s failure — the wall-clock margin is a factor of 24 on an idle box and zero under load. Same family as the two `lobby.rs` rows above | a seventh client is refused **over the wire** with `join_error: full`, and is not also welcomed |
| `game-server/tests/lobby.rs::lobby_state_names_everyone_in_the_room_including_yourself` | Rust | T22.03's Done-when, 2026-09-21: `emit: IncompleteResponseFromEngineIo(WebsocketError(AlreadyClosed))` at `tests/lobby.rs`'s emit, in `cargo test -p game-server` — **the third `AlreadyClosed` in this one file**, and the two above it are already parked for it. Green alone in **0.83 s** on the same tree immediately afterwards, at 1-min load 2.37. It also passed in the same command's pre-run on the tree **without** T22.03, so it is not deterministic in either direction. **No causal path from the change:** T22.03 is physics, and this dies at a websocket emit during lobby setup — a lobby does not simulate at all, which `a_lobby_ticks_but_does_not_simulate` in the same file asserts. **Parked, not re-run, per `CLAUDE.md`; one isolated run is the evidence above and no loop was run.** | the lobby roster names every seated player including the reader |

**Not parked, noted (T21.18, 2026-09-15):** `client/src/render/backdrop-real.test.ts` takes **216 s alone** (42/42 green). In one `--changed` gate at load the vitest worker lost its RPC (`Timeout calling "onTaskUpdate"`, 872/914 reported) and the stage went red; the gate before and after it were 914/914. There is no parking mechanism for a vitest file, so it is recorded here — one slow file sits near the runner timeout, and the owner should decide whether it moves out of the default run. **Red again in the coordinator's full gate at `bf76714` on an idle box (load 1.35):** `873 passed (915)`, two `onTaskUpdate` errors, then **915/915 in 217 s alone**. **Split per map on 2026-09-15** into six `backdrop-real-*.test.ts` files over `backdrop-real.suite.ts` (assertions unchanged), so the six run in parallel workers; `backdrop-real-cases.test.ts` asserts every case is still run once.

## Disabled, not flaky

`toxic-rain-game` carries `disabled: 'T21.41'`, not `flaky`: toxic rain is switched off by the
owner's ruling of 2026-09-15 (`TOXIC_RAIN_ENABLED`, T21.39), and `WEATHER=toxic` is refused, so the
check cannot run until the rewrite turns it back on. Out of the default suite, still runs by name,
listed under `disabled:` in `e2e.mjs --help`. The toxic halves of `m5-weather`, `weather-visible`,
`hud-bars` and `ambient-rain` skip themselves off the same constant and the rest of each runs.

## Considered and not parked

- **`smoke-shader` — one sighting, 2026-09-21, T22.01's gate.** Red at 28.0 s in the 58-check
  `--changed` suite at 1-min load 7.8–10.8: *"the painted cloud changed 1.0 % of its pixels in
  300 ms against 0.0 % flat — it does not animate"*. **Green alone on the same tree at 20.3 s,
  reading 11.8 % against the same 0.0 % control** — a factor of twelve, so the assertion is not
  marginal, the frames simply were not drawn. Every other assertion in the check passed in both
  runs, including the two that share its fixture, so it is the one *wall-clock* claim in the file
  (300 ms of real time) and nothing else. Handled like `platforms` above rather than parked: one
  sighting, and the owner should decide between `serial` and `flaky` if it recurs. **The task that
  saw it changed no client render code at all** — a Rust enum, a lobby row and a replay header.

  **Second sighting, 2026-09-21, T22.02's review-fix gate — so the trigger this row named has
  fired.** Red at 27.7 s in the same 58-check `--changed` suite: *"the painted cloud changed
  0.5 % of its pixels in 300 ms against 0.0 % flat — it does not animate"*. **Green alone on the
  same tree at 18.4 s, reading 9.9 % against the same 0.0 % control** — a factor of twenty. Every
  other assertion passed in the suite run too, including `painted cloud against no cloud: 86.8`,
  so the cloud *was* drawn and only the *animation over 300 ms of wall clock* was missing. The
  task that saw it changed **no client file and no render code** either: four Rust doc comments,
  two Rust tests and a bash manifest.

  Two sightings, identical signature, both only in the parallel pool, green alone both times.
  **`smoke-shader` carries `standalone: true` but not `serial: true`**, so it runs in the pool.
  The choice this row reserved for the owner is now live, and it is **not** made here, for a
  stated reason: `serial` is an unfalsified remedy. The `teleport` row above is the counterexample
  — it went red *alone, in the serial tail, at load ~10*, so the tail is not an idle box and
  `serial` did not cure that one. Proving `serial` cures this one costs a suite run per trial,
  which is the loop `CLAUDE.md` forbids. So: evidence recorded, coverage left in place, decision
  with the owner. `flaky: true` would delete the only assertion in the repository that says the
  smoke shader *moves*, which is the "I cannot see it" class.

  **Fixed at the cause instead, T22.00B (2026-09-21) — and the load reading above is wrong.**
  The check no longer sleeps: it advances 18 *drawn* frames at a time, five times, and the
  largest change from the first photograph decides. Three measurements, all on this box:

  - **Load is real but it was not the cause.** With 24 spinners at 1-min load 21.4 the check
    read 13.3 %, and with four shader checks at once at load 39.9 it read 27.9 % — both green,
    both **above** the idle reading. CDP CPU throttling does cut frames drawn per 300 ms from
    **18 at x1 to 3 at x64**, so "fewer frames under load" is a true mechanism; it is simply not
    the one that fired here, and **I could not reproduce either sighting by loading the box.**
  - **The 300 ms window is marginal on an idle box.** `time` is wall clock (Phaser's
    `TimeStep::getDuration`) and the fbm warp moves ~0.05 noise units in 300 ms, so how many
    pixels cross `PIXEL_MOVED` depends on where in the noise the cloud is. Photographed 39 times
    running at ~260 ms apart, idle, the reading waved between **0.0 % and 11.2 %**.
  - **Head to head, 15 trials each, idle (CPU throttle x1):** the old form read
    `10.1 13.7 1.5 0.1 4.3 9.9 10.7 3.9 6.5 0.0 8.0 0.9 1.4 0.3 7.6` — **4 of 15 at or under the
    1.0 % floor**, including two 0.0 %; the new form read min **13.1 %**, 0 of 15 under. At x16
    the old form was 2 of 15 under (two 0.0 %) and the new form min **31.6 %**, 0 of 15 under.
    So the old check failed on a coin flip **whatever the load**, and the suite only ever
    re-rolled the coin.

  Both arms falsified at the live binding site: pinning `time` to 0 in `SMOKE_FRAGMENT` gives
  *"changed 0.0 % of its pixels at most over 90 drawn frames (1.6 s) … it does not animate"*, and
  killing `requestAnimationFrame` gives *"the page drew 0 of 90 frames in 40.0 s … the box stopped
  rendering, so this says nothing about whether the smoke shader animates"* — the distinction this
  check could not make for two sightings. **Neither `serial` nor `flaky` is needed; the row stays
  closed.** The twins are untouched and listed in T22.00B's report: `fire-shader`,
  `explosion-shader`, `beams-shader` and `fog-shader` all still sample two frames across a wall
  clock.
- `skins-ingame` — red once on 2026-09-14, but that was a real bug (the T21.20 ridge skirt),
  fixed in `d73968b`.
- `teleport` — red once on 2026-09-14 before T19.29 turned weather off for it; then green in
  five straight gates. **Since parked** (table above): three more reds the same day.
