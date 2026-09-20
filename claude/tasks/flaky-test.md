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
- `skins-ingame` — red once on 2026-09-14, but that was a real bug (the T21.20 ridge skirt),
  fixed in `d73968b`.
- `teleport` — red once on 2026-09-14 before T19.29 turned weather off for it; then green in
  five straight gates. **Since parked** (table above): three more reds the same day.
