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
| `terrain-render` | browser | red in the T21.18 laser gate (2026-09-14): "19.0 % of the frame changed — the view is moving". **Since T22.06 it was also red deterministically, not at random**: its layer list lacked T22.06's sky depth −27 ("the sandbox builds world layers [-30,-29,-28,-27,…], expected [-30,-29,-28,-22,…]"). Fixed in T22.08D: green alone (`gate-t2208d-terrain.txt`), but **the original flake is still live** — the same session, run beside `solar-flare-match`, it read "15.5 % of the frame changed — the view is moving" (`gate-t2208d-donewhen-e2e.txt`). Un-parkable as far as the stale pin goes; the camera-motion flake is the owner's call. Flag left in place | a crater changes the rendered picture (§C0) |
| `boots-visible` | browser | same gate: control region changed by 12.8; T21.23 measured it **2-in-3 red on an idle box** at HEAD, camera ease moving a screen-space band | ironman boots are visible on the player |
| `two-clients` | browser | red in a T21.26 gate (2026-09-14); a gun-platform flake that T21.22b was meant to close | the M6 checkpoint — two clients, one server, one round |
| `bullets-visible` | browser | carried on the known-flaky list since M19 (`HANDOFF-M19.md`) | a bullet is drawn while it flies (§F2) |
| `hud-timer` | browser | carried on the known-flaky list since M19 | the round timer and event banner (§C8) |
| `night-combat` | browser | carried on the known-flaky list since M19 | beams light the dark at night |
| `m10-checkpoint` | browser | red twice in M19 full gates, green on standalone re-run both times | the M10 checkpoint — rooms and join codes |
| `inventory-ui` | browser | red in 4 of 6 suite runs on 2026-09-14 (builder B's `--jobs` measurements), **including one at `--jobs 1`**, so not a concurrency effect. Every time the same line: "the shovel is still in slot 8 and the bag went 6 -> 7 slots — something else was dropped instead". The bag *grew* during a fixed `sleep(600)` after right-clicking the kit — a pickup — and the assertion reads any change in bag size as a drop | the starting kit cannot be dropped (§F5), and a drag that reaches the server (§C10) |
| `teleport` | browser | red 3 times on 2026-09-14: both own-stack `--jobs 4` runs ("the charge never left zero — jumping did not arm the pad"), then **alone**, in the serial tail of builder B's `check.sh --changed` gate at `1160eac` at load ~10 ("timed out after 30 s waiting for the respawn — last seen: health 0, alive true, death overlay false"), so `serial` did not cure it; green in two `--jobs 1` runs. A 30 s wall-clock wait on a server-side respawn. **T22.10D F7 (2026-09-24): a check bug, not a flake — and ready to un-park (the owner decides; the flag is left in place).** Red on every run by 2026-09-24 (`gate-t2210d-teleport-before.txt`: *"timed out after 30 s waiting for the respawn — last seen: health 0, alive true"*): it read the wire's `u8`-truncated health ≤ 0 as death, so a body at 0.4 hp stopped being shot and was waited on forever. It now waits for the server's word (`death.meAlive` / the overlay); green in three runs after (`gate-t2210d-net{1,2,3}.txt`) | teleport pads charge, fire and move the player (§C5) |
| `fog-visible` | browser | red in the coordinator's batch gate at `54b2b88` (2026-09-24, `--jobs 4`): *"the layer filled at 0.782 where FOG_SCREEN_ALPHA x strength is 0.794"* — **the exact defect `T22.00G` already names** (`fogStrength` computed live at the `debug()` call vs `fogAlpha` from the last drawn frame, compared at 0.01 while the ramp climbs); green alone on an idle box minutes later, filling at 0.800 (`gate-coordinator-fog-visible.txt`). Not a new flake: a known cause with an open task. Un-park when T22.00G lands. **Fixed, ready to un-park (T22.00G, 2026-09-25):** both ends now come off one drawn frame (`debug().fogDrawnStrength`, written beside `fogAlpha` in `weather.ts::drawFog`); 0.01 kept. Green 3/3 alone and 2/2 at `--jobs 4` beside thrusters-match, radiation-match, breach-vortex (`gate-t2200g-alone-*.txt`, `gate-t2200g-jobs4-*.txt`); the old live-clock read under a 4 fps stall plant reproduced the gate's red (0.781 vs 0.794, `gate-t2200g-stall-live.txt`). `flaky: true` left for the owner | heavy fog's screen veil reaches `FOG_SCREEN_ALPHA` × strength |
| `solar-flare-match` | browser | red in the same gate: *"only 3 of 12 probe brackets were narrower than 50 ms [115, 37, 77, 74, 71, 92, 98, 45, 130, 46, 84, 93]"*; green alone on the idle box minutes later (`gate-coordinator-solar-flare-match.txt`). T22.08E's own journal measured widths of 48–85 ms on 1–2 probes in a third of **idle** runs, and its reviewer predicted exactly this. **The bracket width is a wall-clock round trip, so under load the assertion measures the box, not the clock** — a coin flip by construction. Fix filed as `T22.08F` (measure the client clock against the server's tick without a round trip). **Fixed, ready to un-park (T22.08F, 2026-09-25):** `probeFlare` returns the client's `FlareClock` at the tick the server answered for, asserted within 2 ms (reads 0.00 ms; +0.5 s origin plant red at 500 ms); the narrow-count and narrow-worst-case assertions are reported, not asserted (the second read 73 ms against 66.7 at `--jobs 4` — the server's tick clock runs late on a loaded box). Green 3/3 at `--jobs 4` beside thrusters-match, radiation-match, breach-vortex after the change (`gate-t2208f-jobs4-1,3,4.txt`; run 2 was the worst-case red that led to reporting it). The bracket `off` arm stays asserted and is still load-exposed in principle: 22–36 ms under `--jobs 4` against 66.7. `flaky: true` left for the owner | the client draws the flare at the server's instant (±one snapshot) |
| `perf` | browser | red in the coordinator's full gate at `5b1d587` (2026-09-14): 51.3 fps against the 55 floor, running `serial` in the tail right after the parallel phase; 54.9 fps alone while that load decayed (1-min load 6.6); then **59.9 and 59.5 fps alone on an idle box** (load 0.86). No game code changed since it last passed. The frame rate is fine; the check reads the box's leftover load | frame time stays at 60 fps (§A38) |
| `platforms` | browser | red once in the same gate at `--jobs 4`: "the mean moved only 2.2 (threshold 8), though the pixels did rearrange"; green alone at load 6.6 in 6.1 s. One sighting — a candidate for `serial` instead if it recurs only in parallel | a gun platform's turret layer is drawn |
| `game-server/tests/lobby.rs::a_second_client_joins_a_private_room_by_its_code` | Rust | died once at its first emit on an already-closed socket during Builder A's 2026-09-14 speed work; 5/5 green standalone. Same `AlreadyClosed` shape as the row below | a second client joins a private room by its code |
| `game-server/tests/lobby.rs::a_lobby_room_has_no_bots` | Rust | red in a T21.20 gate (2026-09-14): `emit: IncompleteResponseFromEngineIo(WebsocketError(AlreadyClosed))`; 5/5 green standalone | a lobby room seats no bots at construction (§C18) |
| `game-server/tests/integration.rs::a_seventh_client_is_told_the_room_is_full` | Rust | T22.01's gate, 2026-09-21: **green and red in the same file, on the same tree, from the same binary** — `ok` in the Done-when's own `cargo test -p game-server`, then `FAILED` ~30 min later in `check.sh --changed`'s three-crate `cargo test` at 1-min load 7.01, with `never received 'welcome' within 15s; saw []`. `saw []` is an empty inbox, so it is the socket.io handshake and not the seating path. **3/3 green standalone at 0.6 s each** against a 15.45 s failure — the wall-clock margin is a factor of 24 on an idle box and zero under load. Same family as the two `lobby.rs` rows above | a seventh client is refused **over the wire** with `join_error: full`, and is not also welcomed |
| `game-server/tests/lobby.rs::lobby_state_names_everyone_in_the_room_including_yourself` | Rust | T22.03's Done-when, 2026-09-21: `emit: IncompleteResponseFromEngineIo(WebsocketError(AlreadyClosed))` at `tests/lobby.rs`'s emit, in `cargo test -p game-server` — **the third `AlreadyClosed` in this one file**, and the two above it are already parked for it. Green alone in **0.83 s** on the same tree immediately afterwards, at 1-min load 2.37. It also passed in the same command's pre-run on the tree **without** T22.03, so it is not deterministic in either direction. **No causal path from the change:** T22.03 is physics, and this dies at a websocket emit during lobby setup — a lobby does not simulate at all, which `a_lobby_ticks_but_does_not_simulate` in the same file asserts. **Parked, not re-run, per `CLAUDE.md`; one isolated run is the evidence above and no loop was run.** | the lobby roster names every seated player including the reader |
| `game-server/tests/in_progress.rs::a_join_by_code_into_a_started_match_is_refused_and_seats_nobody` | Rust | T22.11C's Done-when, 2026-09-22: `cass: waited 37 s for 1 `room_created`, saw 0 (inbox: )`. **Green and red on the same tree from the same source ~25 minutes apart** — `cargo test -p game-core -p game-server -p game-wasm` EXIT=0 in `gate-t2211c.txt`, then this in the Done-when's `cargo test -p game-server`. An **empty inbox** at the socket handshake, which is the `saw []` shape of the `integration.rs` and `lobby.rs` rows above and the fifth member of R40's family. No causal path from the change: T22.11C is the asteroid table, the wasm mirror and a browser check, and this dies before a room exists. **Not `#[ignore]`d**, per R40 — *"parking a fourth is the wrong direction"*, `T22.00E` owns the harness — so it is recorded here and still runs. | a join by code into a started match is refused and seats nobody |
| `game-server/tests/checksum.rs::two_clients_agree_on_the_mask_after_a_hundred_carves` | Rust | T22.13's gate, 2026-09-22: `never received 'welcome' within 15s; saw []` — **the sixth member of R40's family and the same `saw []` empty-inbox handshake** as the `integration.rs`, `in_progress.rs` and two `lobby.rs` rows. **Attributed, not guessed:** T22.13's builder neutralised its own guard to pre-task behaviour and re-ran — it still failed, and the failure *moved* to `in_progress.rs`, so the family is not that change's. Before calling it load it asked what the failures share: both wait on a wall-clock deadline for a socket handshake event, and both are green when their binary runs alone (`cargo test -p game-server --test checksum` → **7/7 in 13.13s**). Both reds overlapped a concurrent builder's gate; the run with no overlap was **1553 passed, 0 failed**. **Not `#[ignore]`d**, per R40 — parking a sixth is the wrong direction and `T22.00E` owns the harness. | two clients agree on the carved mask after a hundred carves — the determinism guarantee the whole project rests on |
| `game-server/tests/rooms.rs::a_room_with_a_human_in_it_is_never_reaped` | Rust | T22.06's `--changed HEAD --fast`, 2026-09-23: `emit: IncompleteResponseFromEngineIo(WebsocketError(AlreadyClosed))` at `tests/rooms.rs`'s emit, then *"the client never joined, so nothing here is a control"* — **the seventh member of R40's family**, the `AlreadyClosed` shape of the `lobby.rs` rows. Green alone immediately afterwards (**1/1 in 4.23 s**, 1-min load 1.98); the same command re-run once later was green in full. **No causal path from the change:** T22.06 is client rendering plus `World::darkness` returning 0 in space, and this dies at a websocket emit before a room simulates. One isolated run is the evidence; no loop. **Not `#[ignore]`d**, per R40/R68 — `T22.00E` owns the harness. | a room with a human in it is never reaped |
| `game-server/tests/lobby.rs::a_refused_set_scale_tells_the_sender_why` | Rust | T22.14D's `--changed 93aeb4b --fast`, 2026-09-25: `emit: IncompleteResponseFromEngineIo(WebsocketError(AlreadyClosed))` at `tests/lobby.rs`'s emit (`gate-t2214d-changed.txt`) — **the eighth member of R40's family**, the `AlreadyClosed` shape of the `lobby.rs` rows. Green in the same task's own three-crate `cargo test` minutes earlier (`gate-t2214d-rust.txt`, lobby 18 passed) and alone right after (**1/1 in 1.65 s**, 1-min load 5.8, `gate-t2214d-lobby-alone.txt`). **No causal path from the change:** T22.14D adds a snapshot byte and prediction fixes; this dies at a websocket emit during lobby setup, before a room simulates. One isolated run; no loop. **Not `#[ignore]`d**, per R40/R68. | a refused `set_scale` tells the sender why |
| `thrusters-match` (the bell arm's "no rubber-band after the bell") | browser | **Parked T22.14E (2026-09-25, `flaky: true`)** — see the T22.14E paragraph at the end of this cell. Earlier: T22.14D, 2026-09-25: red 2 of 10 runs at `8b842e8` (1 of 3 alone: *"2 corrections in 3 s after the bell (the first 67.58 px), worst later jump 4.96 px"*, bo at 1301 px/s at the bell; 1 of 2 at `--jobs 4`: *"first 23.43 px, worst later jump 33.21 px"*), green 5/5 alone in a later batch (`gate-t2214d-tm-after.txt`, `gate-t2214d-canvas.txt`, `gate-t2214d-tm-bisect.txt`); with 93aeb4b's `prediction.ts` swapped in, 6/6 green (`gate-t2214d-tm-bisect2.txt`), and 11/11 green before the change (3 at 93aeb4b in `gate-t2214d-tm-before.txt`, 3 in the review's `gate-review2214-{canvas,net}.txt`, 5 in T22.14C's `gate-t2214c-{e2e-tm,thrusters-jobs4}.txt`). **Measured against the change, no path found:** bo presses w/s/a/d, no JUMP bit, and the only thing F1 changes is the previous input's buttons, which movement reads through `input::edges` for JUMP and FIRE alone (space engages off the current input, `space::engaging`); F3's relocation writes the same position and velocity as before. What the two reds share: a **second** correction after the bell, in space, after a fast burn. Owed: that correction's context (tick, ack, speed, what bo hit) printed on the failure path. **T22.14E:** now printed on every run, pass or fail (`Predictor.stats.lastCorrection` → `debug().vortex.lastCorrection`; the check logs `bell arm: the corrections after the bell (each one's context)`). **Re-measured, interleaved, alone, HEAD vs `8b842e8^` (its client, wasm and server, same diagnostic):** the rubber-band assertion red **0 of 9 at HEAD, 0 of 10 before** (`gate-t2214e-{after,before}.txt`), and 0 of 5 at HEAD at `--jobs 4` beside breach-vortex, black-hole, canvas-renderer (`gate-t2214e-jobs4.txt`). Pooled: 2 red in 24 at `8b842e8`+, 0 in 27 before — not distinguishable from chance (Fisher p ≈ 0.2), and **not attributed**: no red came, so no context. **No path from T22.14D exists:** after the bell `reconcileNeutral` corrects through `setPlayerState` and never reads `steppedButtons`, and the neutral ticks carry buttons 0 on both sides. Every counted post-bell correction printed was ~2 px under the 2.35 bound, and two of them show the class a large one would be: **a contact one side made and the other did not** (at the tick, prediction `vx -282.7` against the server's `0`, position 1.6 px apart; another `vy -78.2` against `0`). **Why parked, not just recorded:** the same arm's **precondition** also went red at random, 2 of 24 at HEAD — "the last frame before the bell was not a moving airborne burn" (once landed, `grounded true, v -22.6, 5.9`; once pinned, `moveState 2, v 0, 0`, at `--jobs 4`). Two random reds in one arm is a coin flip in the gate. The next red prints its own context, which should attribute it: `at` vs `server` velocity says whether it was a contact. Side note for the owner: `breach-vortex` read 2.04 px against its 2.0 bound once in the `--jobs 4` runs (5/6 green). | after the bell the prediction steps as the server's `Ended` does (T22.10E F-3) |

**Not parked, noted (T22.08E, 2026-09-24): `game-server/tests/bots.rs::bots_actually_move`.** Red once in
`check.sh --changed HEAD --fast` (`gate-t2208e-changed.txt`): *"no bot moved in two seconds: [1920.0, 96.0] ->
[1920.0, 96.0]"* — **both** bots at exactly their seated x after a 2 s wall-clock `sleep`. Green in the same
tree's Done-when `cargo test -p game-server` minutes earlier, and **4/4 alone** straight after (2.19 s each).
One sighting, so recorded rather than `#[ignore]`d — the coordinator's call. No causal path from T22.08E (a
`Damage` field, the flare clock, the catch-up list); what it shares with R40's family is a wall-clock wait on a
room task under the three-crate `cargo test`'s load, though this one is not a socket handshake.
**Follow-up (T22.10C F6, 2026-09-24):** its `config` built on `..Config::default()` and so inherited
`fixed_seed: None` — an unpinned map re-rolled every run, deciding where both bots are seated, which is the
shared cause CLAUDE.md records for the last "moving" family. Pinned to `Some(4242)`; 4/4 green after
(`cargo test -p game-server --test bots`). Not proven to be *this* sighting's cause — one sighting cannot
say — so the entry stays, and a red on a pinned seed now reproduces.

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
  closed.** The twins were untouched and listed in T22.00B's report: `fire-shader`,
  `explosion-shader`, `beams-shader` and `fog-shader` all still sampled two frames across a wall
  clock. **All four carry the frames-plus-steps instrument as of T22.00F** (2026-09-22); the row
  below is the sighting that paid for it.
- `skins-ingame` — red once on 2026-09-14, but that was a real bug (the T21.20 ridge skirt),
  fixed in `d73968b`.
- `teleport` — red once on 2026-09-14 before T19.29 turned weather off for it; then green in
  five straight gates. **Since parked** (table above): three more reds the same day.
- `beams-shader` — red in the 2026-09-22 batch gate on an **idle** box: *"the painted beam changed 0.9% of its pixels in 200 ms against 0.0% for the still strokes"*, against a hardcoded `Math.max(0.01, still * 3)`. **Not parked, and not re-run to green.** It is the failure `T22.00B`'s report predicted in as many words, and the fix is known and written — parking four shader checks would remove far more coverage than fixing the instrument costs. **Owned by `T22.00F`.** Five of the check's other assertions passed in the same run, including both that prove the painted beam is on screen and differs from the stroked one, so the shader is not the suspect.
  **Fixed at the cause, T22.00F (2026-09-22), and the row closes without `flaky` or `serial`.**
  All four twins now step 5 x 18 **drawn** frames and take the largest change, as `smoke-shader`
  does. On an idle box the same assertion that read **0.9 %** reads **19.3–46.2 %** over three
  runs against an untouched 1.0 % floor, and its still control reads 0.0 % with 90/90 frames
  drawn. **The threshold was not moved** — `CLAUDE.md`'s *do not weaken a coin-flip gate* — only
  the window it is read over. Both arms falsified at the live binding site for each of the four:
  pinning `time` in the fragment shader gives *"the painted beam changed 0.0 % of its pixels at
  most over 90 drawn frames (4.1 s) … the beam shader does not animate"*, and killing
  `requestAnimationFrame` gives *"the page drew 0 of 90 frames in 40.0 s painted and 90 of 90 in
  3.1 s stroked — the box stopped rendering, so this says nothing about whether the beam shader
  animates"* — two different messages, which is the distinction that produced two false sightings
  on `smoke-shader`.
