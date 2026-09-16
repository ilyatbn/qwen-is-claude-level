# Handoff — owner play session, 2026-09-16

Written at the owner's request at the end of a live interactive session. The box is
**clean**: server, vite, Chrome and the tracer are all stopped, nothing is listening on
3000/5173/9222, and the tree is committed.

Commits, oldest first, on top of `9196b59`: `4f28b2e` (the session's work),
`e44cecc` (lava check-skips), `525c255` (this file), `77d6842` + `f22e2ee` (the
quick-game seat fix and its check, added after this file was first written).

**One thing on the box is not mine.** `make stop` left nothing running, but two
containers from `make docker-up` — `docker-server-1` on :3000 and `docker-client-1`
on :8080 — came up partway through and are still up. I did not start them and I have
not touched them: `ss -ltnp` shows no process for :3000 because the listener is in a
container, so they are unattributable from inside this session and get reported rather
than swept. `curl :3000/healthz` answers, so that stack is live. **Anyone running the
gate should stop them first** — the gate needs the box, and a second server stack is
exactly the load that turns a wall-clock assertion into a coin flip.

## State of the gate

**The full gate has not been run.** `node scripts/affected.mjs HEAD~1` says this change
touches **all 59 browser checks** — `constants.rs` and every client scene are in it, and
"the wasm is in every page". So `--changed` is the full gate here; there is no cheaper
honest run.

What *was* run, and passed:

    cargo test --workspace --release   exit 0
    cargo fmt --all --check            clean
    cargo clippy --workspace --all-targets -- -D warnings   clean
    npm --prefix client run typecheck  clean
    npm --prefix client run test       71 files, 953 tests, 0 failed

**Nothing browser-side has been executed at all.** That is the single biggest open risk
below.

## What landed

Eleven owner reports plus two things found while chasing them.

**Tooling — `scripts/play.mjs`.** The played-in window had **no WebGL**: the gate launches
Chrome with `--use-gl=swiftshader --enable-unsafe-swiftshader` (`scripts/lib/browser-args.mjs`)
and `play.mjs` never did. Phaser fell back to CANVAS, `optionsPanel.ts::QUALITY_HINT_NO_WEBGL`
disabled High Quality, and every T21.17/T21.18 shader has been verified in a browser
configuration nobody played in. Measured both ways on this box: without the flags a fresh
canvas returns no WebGL context; with them, SwiftShader via ANGLE. Also added `e2e=1` (without
it `make probe` returns `null` for every real match — the interactive loop `CLAUDE.md`
describes never worked in a game) and **dropped `debug=1`** from the default, which was drawing
debug mode's own `#debug-fps` beside the Options one and the aim ring around the player.

**Balance.** `FALL_SAFE_SPEED` 480 → 678.8 (free drop height 82 → 165 px — the owner asked for
double the *height*, which is `sqrt(2)` on the speed). `FALL_DAMAGE_PER_SPEED` 0.025 → 0.046;
the owner chose *"keep the worst fall meaningful"* over *"keep falls gentle"*, and the workable
window is only **0.0452–0.0475** because the tenth-of-a-bar floor and T21.29's "a third of what
it cost" both bind at terminal velocity. `BOOTS_JUMP_HEIGHT_MULT` 3.0 → 2.25 with fall
protection split out as the new `BOOTS_FALL_HEIGHT_MULT` (held at 3.0) — cutting both would
have made boots *more fragile than bare feet*, which `bare > deepest` catches.
`WINGS_SPEED_MULT` 0.9. Wings refuse pads (`teleport::step` gained `eligible`) and platforms
(`step_mount` reports no platform underfoot). `LAVA_ENABLED = false`. `REPLAY_VERSION` 12 → 13.

**Two fixes that never worked, both found by measuring rather than reading.**

## Open items, most load-bearing first

1. **Run the gate.** Nothing in the browser has been executed. Commit first, gate second,
   nobody edits under `claude/` while it runs, and name the output `gate-<who>.txt`.

2. **`terrain-seed` does not cover the bug it was written for.** T21.15 was reported fixed,
   and the owner reported the same symptom again this session. The cause: `WorldView` seeded
   the rock from `core.meta.seed`, and `Core.loadMask` clones the client's *startup* meta —
   measured live as **`meta.seed` = 1 across four different `roundSeed`s**, with `meta.theme`
   always 0. Both values were on the wire all along (`codec.rs` writes them, `codec.ts`
   decodes them); `WorldView` takes them as arguments now.
   **`scripts/checks/terrain-seed.mjs` runs in the sandbox**, which generates its own map and
   therefore has a real `meta.seed` — so it passed throughout, for the whole time the
   networked game was broken. It needs a networked-round sibling: two rounds, different seeds,
   same theme, compare a rock patch with a screen-space control. Until that exists this can
   regress silently a third time.

3. **The weather is now a strict alternation.** Two kinds live (meteor, fog) plus
   never-repeat leaves exactly one non-zero weight, so the sequence is meteor, fog, meteor,
   fog with no randomness. `scheduler.rs::two_live_kinds_alternate` pins it so it is noticed
   rather than discovered. **The owner has been told and has not ruled.** Switching either
   disabled kind back on, or dropping never-repeat, restores a real draw.

4. **Lava needs a placement task.** Switched off on the owner's *"coming out of weird places"*.
   Every line of the effect is kept; `lava-lights` and `weather-visible`'s lava section and
   `m5-weather`'s lava row all skip off `LAVA_ENABLED`. This wants a `T21.4x` the way toxic
   rain got `T21.41`.

5. **The three weapons that have art still never draw in a real match.** `setWeapon`'s only
   production caller is `SandboxScene` — `GameScene` has none, so the held weapon was the
   placeholder for everyone, always. The owner asked for the black bar to go and it is gone,
   but nothing replaced it: players now hold *nothing* visible. Wiring `setWeapon` from the
   snapshot's selected slot is the follow-up, and `weaponTextures.ts` only covers bazooka,
   grenade and SMG out of fourteen.

6. **Boots' own-jump protection is now redundant.** Everyone is safe to 165 px and a booted
   jump reaches 141, so the booted jump is free by the *base* rule. `boots_fall_safe_speed`
   still does real work on deep falls, and the test now asserts that directly (a drop between
   the two thresholds: charged bare, free booted) plus an explicit
   `booted_impact < FALL_SAFE_SPEED` that will red and explain itself if this reverses.

7. **`make probe` is still blind outside a match.** `TitleScene` and `MenuScene` expose
   `__title` and `__menu`; `probe.mjs` reads only `__game`, so it prints `null` on the title
   and menu screens. Harmless but confusing — it looks like the handle is missing.

8. **Carried over, untouched this session:** T21.40's *"seated ignores rock poking up through
   the base"* (15 of 26 placements on three maps partly sunk into slopes); `drawClouds` culls
   on last frame's `worldView`; **M21 is not finished** — T21.04–T21.08 and T21.10, the
   *"new match settings"* half of the milestone (day/night toggle, low gravity, zero-g with
   its own movement model, map generator and forced skin) were never written as task files.

## Fixed after this file was first written

**Quick game → Esc → quick game seated you twice** (`77d6842`, `f22e2ee`).
`keydown-ESC` is bound once, scene-wide, straight to `dispatch({type:'back'})`, and the
only exit that called `leaveLobby` was the rendered lobby's Back button — so three of
four ways out of a seated screen kept the socket and the seat. The server was correct
throughout; `session.rs`'s `leave_room` had already written down the consequence of not
calling it. Fixed in `dispatch`, beside the guard that does the same for `pendingEntry`
and for the reason that comment already gives: *Esc does not go through the Back button.*
New check `quick-rejoin`, falsified by disabling the guard (roster comes back
`["ana","ana","empty","empty","empty"]`). `lobby`, `lobby-start`, `title` and `rematch`
re-run green beside it.

## Raised at the end of the session, not yet built

**The owner asked why the weather switches are compile-time constants rather than a
server-side feature flag.** The premise needs one correction and the answer is mostly
"you are right".

*They are not client-side.* `TOXIC_RAIN_ENABLED` and `LAVA_ENABLED` are in
`game-core/constants.rs`, shared by both sides, and the scheduler that picks the weather
runs on the **server** inside `World::step`. The client's copy only draws (or hides) the
sandbox buttons and lets the browser checks skip their section. So the decision is already
server-side; what is client-visible is only the consequence.

*The real limitation is compile-time, not client-side.* They are `const`, so flipping one
needs a rebuild of the server **and** the wasm.

*There is already a runtime lever, and it is server-side.* `WEATHER` (env → `Config` →
`World::weather_mode`) takes `off`, which `WorldMode`'s own doc defines as *"No effect ever
starts"*, and `WEATHER=<kind>` forces exactly one. So **"disable the events from triggering"
is available today with no rebuild — `WEATHER=off`.** What does not exist is a *per-kind*
runtime disable: off is all-or-nothing, and `Always` is one kind only.

*Today's refactor left it one step from runtime.* `EffectScheduler` no longer holds a
`toxic_enabled` bool — it holds `enabled: [bool; 4]`, a per-instance field that is already
hashed and already injected through `with_enabled`. Only `enabled_from_constants()` ties it
to the constants. A per-kind runtime flag is: parse `WEATHER_DISABLED=lava,toxic` in
`config.rs`, carry it on `World` beside `weather_mode`, and pass it to the scheduler's
constructor — the same path `weather_mode` already takes.

**Three things need deciding before that is built, and they are the reason it was not done
in passing:**

1. **Replay.** `weather_mode` is *deliberately* absent from the replay header — the comment
   above `WeatherMode` says so, grouping it with `dev_poisoned` and `dev_start_health` on the
   grounds that a round recorded under a dev switch is already not reproducible. A per-kind
   flag changes the **hashed** scheduler state, so either it goes into the header (a carrier
   and a version bump) or it inherits that same "knowingly not reproducible" policy. The
   current constants avoid the question by being the same in every build that exists.
2. **The client.** The sandbox reads `C().LAVA_ENABLED` to decide whether to draw the button.
   Against a server flag that has to come over the wire (`welcome` or `map_init`) or the
   sandbox keeps its own local answer — defensible, since the sandbox has no server.
3. **The checks.** `m5-weather` and `weather-visible` skip off `rustFlag('LAVA_ENABLED')`.
   Those become config reads, and a check that sets the env itself is the cleaner shape.

Scope guess: one task, `config.rs` + `world/mod.rs` + `scheduler.rs` + the three checks,
comfortably inside the one-file-250-line budget if the replay question is answered first.

## Two rules this session paid for again

- **A fix verified in a configuration nobody plays in is not verified.** It happened twice
  here in two different layers: the shaders (gate has WebGL, the play window did not) and
  the terrain texture (check runs the sandbox, the bug lives in the networked path). Both
  passed everything for weeks.
- **Freeze a historical basis completely or not at all.**
  `a_landing_costs_at_most_a_third_of_what_it_did_when_the_owner_reported_it` froze the rate
  as a literal and read the threshold from the live constant, so its "what it cost then"
  moved whenever the constant did — and when the threshold doubled, the baseline went
  negative and the test's own control fired with *"which was free anyway"* about a drop that
  cost 6.0 hp on the day in question. `THRESHOLD_WHEN_REPORTED` added beside
  `RATE_WHEN_REPORTED`.
