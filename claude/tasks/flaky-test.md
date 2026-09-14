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
| `escape-menu` | browser | red in the T21.18 smoke `--changed` gate (2026-09-15, 45/48, load ~3): "turning High Quality on moved the field by 6.5 — nothing reads it yet"; **green alone** straight after ("unchanged (0.5)"). Its claim also predates the cloud and beam shaders, which do read High Quality — the owner should decide whether the assertion still means anything | the escape menu, the Options panel, and High Quality defaulting to Off |
| `void` | browser | **not random — red every time, and not caused by T21.18**: red in the smoke gate ("held a for 4000 ms … stopped 34 px short"), red alone at `e9a4333` ("two rockets in a row left x=1037 at 26 px"), and red alone again with every code file of `e9a4333` reverted to its parent ("x=1040 at 19 px", no death overlay). Parked so it stops reddening every `--changed` run; it wants fixing, not waiting | the M15 checkpoint — dig through the floor, fall into the void, die (§C15) |

**Not parked, noted (T21.18, 2026-09-15):** `client/src/render/backdrop-real.test.ts` takes **216 s alone** (42/42 green). In one `--changed` gate at load the vitest worker lost its RPC (`Timeout calling "onTaskUpdate"`, 872/914 reported) and the stage went red; the gate before and after it were 914/914. There is no parking mechanism for a vitest file, so it is recorded here — one slow file sits near the runner timeout, and the owner should decide whether it moves out of the default run.

## Considered and not parked

- `skins-ingame` — red once on 2026-09-14, but that was a real bug (the T21.20 ridge skirt),
  fixed in `d73968b`.
- `teleport` — red once on 2026-09-14 before T19.29 turned weather off for it; then green in
  five straight gates. **Since parked** (table above): three more reds the same day.
