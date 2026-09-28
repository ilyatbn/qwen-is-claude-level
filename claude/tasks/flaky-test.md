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
| `terrain-render` | browser | **RETIRED by T23.07** (2026-09-27): it photographed Phaser's rock, which the lit terrain replaced; its guard (§C0, a crater changes the picture) moved to `look-terrain`'s live half, which reads the crater in the frame it is carved against a from-scratch repaint. History: red in the T21.18 laser gate (camera motion), stale layer pin fixed in T22.08D | — |
| `boots-visible` | browser | **UNPARKED by T23.14** (2026-09-27): rewritten on the stick figure's world-canvas pixels with the scene frozen (no camera ease between its frames — the cause below); green in 4 runs incl. two parallel subsets. Was: same gate: control region changed by 12.8; T21.23 measured it **2-in-3 red on an idle box** at HEAD, camera ease moving a screen-space band | ironman boots are visible on the player |
| `fire-visible` | browser | Parked by T23.19A (2026-09-27), **not caused by it** (measured). Red twice in its runs, green four times, alone and serial: *"only 78 flames stayed alive — the field this measures does not exist"* (the 21-check subset, `gate-t2319a-subset.txt`) and *"a full flame field costs 50.40 ms/frame — under 20 fps"* (alone, `gate-t2319a-rerun.txt`). The same check with T23.19A's gates/turrets planted back on Phaser read 49.1 and 48.2 ms (`gate-t2319a-fire-base{1,2}.txt`); with them in the world renderer 47.9 and 47.3 (`…-fire-mine{1,2}.txt`) — so the budget sits within 1–4 ms of its 20-fps floor either way, and the live-flame count (78–110 of a 160 cap) moves across its own floor run to run. An instrument measuring the box's margin; the owner decides | molotov fire is drawn where it burns, and a full flame field keeps 20 fps |
| `two-clients` | browser | red in a T21.26 gate (2026-09-14); a gun-platform flake that T21.22b was meant to close | the M6 checkpoint — two clients, one server, one round |
| `bullets-visible` | browser | carried on the known-flaky list since M19 (`HANDOFF-M19.md`); T23.18 (2026-09-28): red 4 of 6 runs by one shape — a bright column at strip x 623, luminance +175.25 exactly, static across 2–3 samples from attempt 4 on — **and the same with the effects hidden** (`hideLayers(['fx'])`, 2/2), so not the rounds' drawing; the moving round is caught in the attempts before it (+139–148 at x 711) and verified on a frozen frame (`shots/t2318-bprobe-0.png`). Cause not found. | a bullet is drawn while it flies (§F2) |
| `hud-timer` | browser | carried on the known-flaky list since M19 | the round timer and event banner (§C8) |
| `night-combat` | browser | carried on the known-flaky list since M19. **UN-PARKED by T23.09C (2026-09-28):** not a flake — since T23.09 it could never pass (it wanted ≥ 3 effect lights from SMG fire, which is a light only as a 2-list muzzle flash) and its noon control read the last *drawn* frame's radius straight after the clock moved (165 at noon). Rewritten on the effect lights (rocket light in the renderer's list, muzzle flashes at the gun, control none before firing); then its muzzle leg found the sandbox's own F2 case (flash 34–49 px out where a round was first drawn) — fixed with the spawn point as the flash's origin: 18.0 px in 3/3 (`gate-t2309c-nc3-{1,2,3}.txt`), plants (flash at the round; no origin) red | beams light the dark at night |
| `m10-checkpoint` | browser | red twice in M19 full gates, green on standalone re-run both times | the M10 checkpoint — rooms and join codes |
| `inventory-ui` | browser | red in 4 of 6 suite runs on 2026-09-14 (builder B's `--jobs` measurements), **including one at `--jobs 1`**, so not a concurrency effect. Every time the same line: "the shovel is still in slot 8 and the bag went 6 -> 7 slots — something else was dropped instead". The bag *grew* during a fixed `sleep(600)` after right-clicking the kit — a pickup — and the assertion reads any change in bag size as a drop | the starting kit cannot be dropped (§F5), and a drag that reaches the server (§C10) |
| `teleport` | browser | **Fixed, ready to un-park — owner decides** (T22.10D F7: a check bug; details at the end of this cell). Red 3 times on 2026-09-14: both own-stack `--jobs 4` runs ("the charge never left zero — jumping did not arm the pad"), then **alone**, in the serial tail of builder B's `check.sh --changed` gate at `1160eac` at load ~10 ("timed out after 30 s waiting for the respawn — last seen: health 0, alive true, death overlay false"), so `serial` did not cure it; green in two `--jobs 1` runs. A 30 s wall-clock wait on a server-side respawn. **T22.10D F7 (2026-09-24): a check bug, not a flake — and ready to un-park (the owner decides; the flag is left in place).** Red on every run by 2026-09-24 (`gate-t2210d-teleport-before.txt`: *"timed out after 30 s waiting for the respawn — last seen: health 0, alive true"*): it read the wire's `u8`-truncated health ≤ 0 as death, so a body at 0.4 hp stopped being shot and was waited on forever. It now waits for the server's word (`death.meAlive` / the overlay); green in three runs after (`gate-t2210d-net{1,2,3}.txt`) | teleport pads charge, fire and move the player (§C5) |
| `fog-visible` | browser | **Fixed, ready to un-park — owner decides** (T22.00G; details at the end of this cell). Red in the coordinator's batch gate at `54b2b88` (2026-09-24, `--jobs 4`): *"the layer filled at 0.782 where FOG_SCREEN_ALPHA x strength is 0.794"* — **the exact defect `T22.00G` already names** (`fogStrength` computed live at the `debug()` call vs `fogAlpha` from the last drawn frame, compared at 0.01 while the ramp climbs); green alone on an idle box minutes later, filling at 0.800 (`gate-coordinator-fog-visible.txt`). Not a new flake: a known cause with an open task. Un-park when T22.00G lands. **Fixed, ready to un-park (T22.00G, 2026-09-25):** both ends now come off one drawn frame (`debug().fogDrawnStrength`, written beside `fogAlpha` in `weather.ts::drawFog`); 0.01 kept. Green 3/3 alone and 2/2 at `--jobs 4` beside thrusters-match, radiation-match, breach-vortex (`gate-t2200g-alone-*.txt`, `gate-t2200g-jobs4-*.txt`); the old live-clock read under a 4 fps stall plant reproduced the gate's red (0.781 vs 0.794, `gate-t2200g-stall-live.txt`). `flaky: true` left for the owner | heavy fog's screen veil reaches `FOG_SCREEN_ALPHA` × strength |
| `solar-flare-match` | browser | **Fixed, ready to un-park — owner decides** (T22.08F; details at the end of this cell). Red in the same gate: *"only 3 of 12 probe brackets were narrower than 50 ms [115, 37, 77, 74, 71, 92, 98, 45, 130, 46, 84, 93]"*; green alone on the idle box minutes later (`gate-coordinator-solar-flare-match.txt`). T22.08E's own journal measured widths of 48–85 ms on 1–2 probes in a third of **idle** runs, and its reviewer predicted exactly this. **The bracket width is a wall-clock round trip, so under load the assertion measures the box, not the clock** — a coin flip by construction. Fix filed as `T22.08F` (measure the client clock against the server's tick without a round trip). **Fixed, ready to un-park (T22.08F, 2026-09-25):** `probeFlare` returns the client's `FlareClock` at the tick the server answered for, asserted within 2 ms (reads 0.00 ms; +0.5 s origin plant red at 500 ms); the narrow-count and narrow-worst-case assertions are reported, not asserted (the second read 73 ms against 66.7 at `--jobs 4` — the server's tick clock runs late on a loaded box). Green 3/3 at `--jobs 4` beside thrusters-match, radiation-match, breach-vortex after the change (`gate-t2208f-jobs4-1,3,4.txt`; run 2 was the worst-case red that led to reporting it). The bracket `off` arm stays asserted and is still load-exposed in principle: 22–36 ms under `--jobs 4` against 66.7. `flaky: true` left for the owner | the client draws the flare at the server's instant (±one snapshot) |
| `perf` | browser | *(R37's single-chunk rebake budget, which T22.00C moved in here, left again at the M22 close-out — it is its own gated serial check, `chunk-rebake`, because a budget inside a parked check gates nothing.)* Red in the coordinator's full gate at `5b1d587` (2026-09-14): 51.3 fps against the 55 floor, running `serial` in the tail right after the parallel phase; 54.9 fps alone while that load decayed (1-min load 6.6); then **59.9 and 59.5 fps alone on an idle box** (load 0.86). No game code changed since it last passed. The frame rate is fine; the check reads the box's leftover load | frame time stays at 60 fps (§A38) |
| `platforms` — **UN-PARKED by T23.19E (2026-09-28)**: not flaky, broken; fixed at the cause (the turret leg decides on the changed-pixel share of its band, 51.1 % vs a 15 % floor, not the band's mean; plant "turret not drawn" → 0.0 %, red); green 3/3 alone | browser | red once in the same gate at `--jobs 4`: "the mean moved only 2.2 (threshold 8), though the pixels did rearrange"; green alone at load 6.6 in 6.1 s. One sighting — a candidate for `serial` instead if it recurs only in parallel. **T23.19D (2026-09-28): now red every run, alone and unloaded — 6.4 < 8 on 712f18c (stash) and on eeacded, 2 of 2 each; not a flake any more: the turret band moves 6.4, deterministically (cause not instrumented; a guess is the tripod turret of T23.19A). Parked (`flaky: true`), so batch gates do not run it** | a gun platform's turret layer is drawn |
| `m4-checkpoint` | browser | **Not a flake — fixed by T23.09D (2026-09-28).** Red in T23.14D's subset and in the batch gate at `cf087fd`: an smg round that strikes rock ~25 px out lives ~3 sim ticks, so a frame long enough to hold them all never drew it (T23.14E F3: **not** reproduced at `544d27f` — green 2/2 there; only audio was). A round is now drawn on at least one frame; the new slow-frame leg (`stepsPerFrame(4)`) went red with the fix planted out (peak 0) and is green 4/4 with it | every shot is visible in flight (M4) |
| R40's socket family — **UN-PARKED by T22.00E (2026-09-27)**: `lobby.rs::{a_second_client_joins_a_private_room_by_its_code, a_lobby_room_has_no_bots, lobby_state_names_everyone_in_the_room_including_yourself}`, `integration.rs::a_seventh_client_is_told_the_room_is_full` (the four `#[ignore]`d, now running again) and the six noted-only rows (`in_progress.rs::a_join_by_code_…`, `checksum.rs::two_clients_agree_…`, `rooms.rs::{a_room_with_a_human_in_it_is_never_reaped, two_rooms_run_side_by_side_…}`, `lobby.rs::{a_refused_set_scale_…, a_tombstone_skin_…}`) | Rust | **One harness cause, traced.** `rust_engineio` 0.6 (the test client) sends an unsolicited Pong on connect *and* answers the server's t = 0 Ping; `engineioxide` 0.17 queues pongs in a capacity-1 channel and treats a full one as `HeartbeatTimeout`. On a loaded box the server closed the session in the millisecond of its CONNECT (server trace: `error when handling packet: HeartbeatTimeout`, `close_session{reason=HeartbeatTimeout}` — all 3 silent clients of the traced probe loop, each followed by `rust_socketio`'s reconnect to a second, unjoined session; the logs were not kept). The test then emitted into the dead socket (`AlreadyClosed` / `SendAfterClosing`), or its event met a closed session (`cannot find socketio socket`) and `rust_socketio` silently reconnected an unjoined one (`saw []`, empty inbox). The shipping browser client sends no unsolicited Pong. **Fix (harness):** `tests/common::open` returns only a session that answered a `ping_rtt` echo, replacing a dead one before the test sends anything (`reconnect(false)`, a fresh builder per attempt — clones share callbacks). **Plus a server race found on the way:** the connect handler registered `socket.on`s in a task socketioxide spawns *after* acking, so an emit on the ack could meet no handler (one trace; forced by a 50 ms delay: 23/24 unanswered) — handlers now register in a connect middleware (`session.rs::register`). **Evidence:** deterministic — `open_replaces_a_session_closed_at_connect` (server closes the first session; red with the echo removed) and `the_first_event_after_the_connect_ack_is_never_dropped` (red with the delay plant). Loops (scratchpad `stress.sh`/`ack.sh`, 12 spin loops): the five socket binaries ×130 runs — before 3 family-shaped reds in 130 (`waited 37 s … saw 0`; `ana had a map` and `lobby_error saw 0`, both traced to the handler race — that loop ran with the server trace on), after **0 in 130 while `open` replaced 27 dead sessions**; the 24-client probe, pre-fix vs final interleaved, 1/320 vs 0/320 (3 replacements). Not reproduced in ~1 000 loaded runs: `AlreadyClosed` itself (explained by the trace, not observed). Seen in the after-loop, **not this family** (no handshake; wall-clock/event-count assertions at load ~90): see *Noted under load (T22.00E)* below | the lobby over the wire: private codes, the cap told to a seventh client, lobby_state names, no bots in a lobby |
| `thrusters-match` (the bell arm's "no rubber-band after the bell") | browser | **Parked T22.14E (2026-09-25, `flaky: true`)** — **T23.14B (2026-09-27):** rewritten for the figure's flame (`debug().flames`; arm 4 reversed — the flame burns under standard gravity); one run: every flame arm green, the bell arm's precondition red (*"not a moving airborne burn … moveState 0, grounded true"*) — the parked cause, untouched by the rewrite, so it stays parked (`gate-t2314b-tm1.txt`). see the T22.14E paragraph at the end of this cell. **`flaky: true` parks the whole check, not the arm**: every other arm (a remote's plume in a real match, none after the bell, none under standard gravity, none on a player killed mid-burn, the standard arm's jump) is ungated until the bell arm is split out — filed in `TASKS.md` (*T22.00C: split `thrusters-match`*). Earlier: T22.14D, 2026-09-25: red 2 of 10 runs at `8b842e8` (1 of 3 alone: *"2 corrections in 3 s after the bell (the first 67.58 px), worst later jump 4.96 px"*, bo at 1301 px/s at the bell; 1 of 2 at `--jobs 4`: *"first 23.43 px, worst later jump 33.21 px"*), green 5/5 alone in a later batch (`gate-t2214d-tm-after.txt`, `gate-t2214d-canvas.txt`, `gate-t2214d-tm-bisect.txt`); with 93aeb4b's `prediction.ts` swapped in, 6/6 green (`gate-t2214d-tm-bisect2.txt`), and 11/11 green before the change (3 at 93aeb4b in `gate-t2214d-tm-before.txt`, 3 in the review's `gate-review2214-{canvas,net}.txt`, 5 in T22.14C's `gate-t2214c-{e2e-tm,thrusters-jobs4}.txt`). **Measured against the change, no path found:** bo presses w/s/a/d, no JUMP bit, and the only thing F1 changes is the previous input's buttons, which movement reads through `input::edges` for JUMP and FIRE alone (space engages off the current input, `space::engaging`); F3's relocation writes the same position and velocity as before. What the two reds share: a **second** correction after the bell, in space, after a fast burn. Owed: that correction's context (tick, ack, speed, what bo hit) printed on the failure path. **T22.14E:** now printed on every run, pass or fail (`Predictor.stats.lastCorrection` → `debug().vortex.lastCorrection`; the check logs `bell arm: the corrections after the bell (each one's context)`). **Re-measured, interleaved, alone, HEAD vs `8b842e8^` (its client, wasm and server, same diagnostic):** the rubber-band assertion red **0 of 9 at HEAD, 0 of 10 before** (`gate-t2214e-{after,before}.txt`), and 0 of 5 at HEAD at `--jobs 4` beside breach-vortex, black-hole, canvas-renderer (`gate-t2214e-jobs4.txt`). Pooled: 2 red in 24 at `8b842e8`+, 0 in 27 before — not distinguishable from chance (Fisher p ≈ 0.2), and **not attributed**: no red came, so no context. **No path from T22.14D exists:** after the bell `reconcileNeutral` corrects through `setPlayerState` and never reads `steppedButtons`, and the neutral ticks carry buttons 0 on both sides. Every counted post-bell correction printed was ~2 px under the 2.35 bound, and two of them show the class a large one would be: **a contact one side made and the other did not** (at the tick, prediction `vx -282.7` against the server's `0`, position 1.6 px apart; another `vy -78.2` against `0`). **Why parked, not just recorded:** the same arm's **precondition** also went red at random, 2 of 24 at HEAD — "the last frame before the bell was not a moving airborne burn" (once landed, `grounded true, v -22.6, 5.9`; once pinned, `moveState 2, v 0, 0`, at `--jobs 4`). Two random reds in one arm is a coin flip in the gate. The next red prints its own context, which should attribute it: `at` vs `server` velocity says whether it was a contact. Side note for the owner: `breach-vortex` read 2.04 px against its 2.0 bound once in the `--jobs 4` runs (5/6 green). | after the bell the prediction steps as the server's `Ended` does (T22.10E F-3) |
| `world-canvas` | browser | **UN-PARKED by T23.09B (2026-09-27): fixed, 5/5 green alone (`gate-t2309b-final1..5.txt`).** Cause, from the instrumented candidates (`gate-t2309b-inst1.txt`, frame 628): the watch pan carried the marker's *tall* bar onto the probe column, so the column read along the bar's length — Phaser `[[0,719]]`, three `[[0,92],[134,718]]` (the moon's glow, screen-fixed, cuts the bar in the world canvas) — and "first run" gave 359.5 vs 46 = the constant 313.5. Unpinned map ⇒ spawn side ⇒ pan direction ⇒ random. Fix: only a bar-thick run is a crossing (`worldHandle.ts::crossing`), two are ambiguous (fails by name); `FIXED_SEED` 4242 pinned (its pan crosses the column on 2 frames every run). Plants: old first-run search on the pinned seed → red 2/2 with 313.50; a decoy bar on the probe row → red by name on every leg. — *Was:* **Parked by T23.08C (2026-09-27), cause named, not fixed.** Its match leg's map is **unpinned** (`startStack` env has no `FIXED_SEED`), and on some maps the match-pan leg reads the two canvases' markers 313.50 px apart on one frame — the same 313.50 on every red run, at different views, so a marker-search mismatch on a map feature, not a sync drift. Measured on an idle box, one run at a time: **new tree 3/5 red** (`gate-t2308c-extra.txt`, `-wc2`, `-wc5` red; `-wc3`, `-wc4` green), **with T23.08's `render_fields.rs` put back 1/5 red** (`-wc-base-rf`, `-wcold1`, `-wcold2`, `-wcold4` green; `-wcold3` red, the same 313.50) — red on both, so not T23.08C's F6 change (five draws each cannot rank the two rates). Fix: pin `FIXED_SEED` in its stack and re-measure, or make the marker search reject a second match | the three.js world canvas and Phaser's camera agree while a match pans |

**Noted under load (T22.00E, 2026-09-27) — not the socket family, not parked.** Seen in T22.00E's after-loop (the five
socket binaries ×130, 12 spin loops plus the binaries, 1-min load up to ~96; `gate` logs in the builder's scratchpad,
counts from `stress.sh`), none of them a handshake — each is a wall-clock or event-count assertion on a loaded room:
`integration.rs::a_joiner_never_receives_another_player_s_inventory` **19/130** (*"received 2 inventory events"*; 5/60
at load ~30 before the fix, so not caused by it — the T22.18B note below, now with a rate); `checksum.rs::
a_joiner_that_delays_ready_still_gets_every_carve` 3/130 (*"should have seen the fires during its ready window; got
7/8"*); `checksum.rs::two_clients_agree_on_the_mask_after_a_hundred_carves` 1/130 (*"clients agreed with each other but
not with the server at seq 143"*); `in_progress.rs::a_join_by_code_into_a_started_match_is_refused_and_seats_nobody`
1/130 (*"a `player_join` was announced for a refused joiner"*). All green in the plain `cargo test -p game-server`.
The last two assert server behaviour, not timing, and deserve a look of their own — the coordinator's call.
**Resolved by T22.00F (2026-09-27):** the mask mismatch was the test reading the server before its inboxes (one carve
past, traced; now cut at the server's sequence); the refused-joiner count read the bot's own `player_join` late (now by
name); the inventory count was a real seat-path duplicate (`session.rs::seat`, fixed: 33/48 → 0/48); the ready-window
count is a 400 ms settle budget, still asserted, now self-reporting. Same loaded loop: 34 reds in 144 → 0 in 144.

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

**Not parked, noted (T22.18B, 2026-09-25): `game-server/tests/integration.rs::a_joiner_never_receives_another_player_s_inventory`**
— red once in the builder's `cargo test -p game-wasm -p game-server` (three suites building and running at once):
*"the second client received 2 inventory events; exactly one — its own — is correct"* (left 2); green alone right after
(1/1) and in the next full `cargo test -p game-server --no-fail-fast` (all suites ok). The change under test widened
`map_init`'s asteroid record (lumps) and touched no event scope (`events.rs::scope_of` unchanged, `Inventory` still
`Only(owner)`), so no causal path is known; it counts events over a wall-clock window on a socket, the R40 family's
shape. One sighting: recorded, not `#[ignore]`d — the coordinator's call.

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
  **Red again 3/3 at HEAD after T22.00F, and a different cause — found and fixed by T22.00H (2026-09-25).** *"stroked 75.2 % changed … does not animate"* on every commit a bisect tried, both ends included, so there was no first bad commit: the **still-strokes control** was never still. The flicker band is sky, and the sky's day cycle runs on the round clock — fastest in a round's first seconds, which is where a check run alone lands (~3 s in); a batched run lands ~17 s in, where the gradient barely moves, which is why every green was batched and every red alone. Fix: `__game.holdSky(t)` pins the sky and its parallax band to one round time across the five steps (darkness, fog and the shader's own `time` keep the live clock); **no threshold touched**. Plants red both ways: the hold ignored → stroked 75.2 %; the beam ripple's `time` zeroed → painted 0.0 %. Not parked; the row stays closed.

**Not parked, noted (T23.09, 2026-09-27): `death`.** Red once in the 77-check `--only` run after T23.09
(`gate-t2309-e2e.txt`): *"timed out waiting for the death overlay"* and *"no death event for this player arrived"*,
117.9 s; green alone straight after (`gate-t2309-death1.txt`, 23.1 s). No causal path from T23.09 (client light list;
the missing event is the server's). One sighting, recorded rather than parked — the coordinator's call.

**`teleport`, re-measured by T23.19A (2026-09-27) — red again, and not by that change.** Its charge half's terrain
control moved 5.3–11.6 between the uncharged and charging frames (*"the control patch moved … something global
changed"*) on 4 of 6 runs alone: 2 of 3 with the F gate in the world renderer (`gate-t2319a-teleport-mine{1,2,3}.txt`),
2 of 3 with the gates planted back on Phaser (`…-base{1,2,3}.txt`); green runs read control 2.1 and 1.4. The charge
indicator itself moved 79.3 (F gate) and 184.7 (old fill) against its 8. Stays parked; the control, not the gate, is
what moves.
