/**
 * The browser-check table, shared by `scripts/e2e.mjs` (which runs it) and
 * `scripts/lib/affected.mjs` (which maps changed files onto it). One table, so
 * the two cannot disagree about which checks exist.
 *
 * Flags: `standalone` runs as a subprocess with its own stack; `serial` runs
 * alone under `--jobs`; `flaky` is parked out of the default suite
 * (tasks/flaky-test.md); `optIn` runs only when named; `disabled: '<task>'` is out of
 * the default suite because the feature it checks is switched off — **not flaky** —
 * and still runs when named. The value is the task that turns it back on.
 */
/**
 * The suite. `url` is the query string the check needs; a check that regenerates
 * the map itself only needs `?sandbox=1`.
 *
 * Ordered cheapest-first, so a broken build fails on `sandbox` in seconds rather
 * than after the two-client round.
 */
export const CHECKS = [
  // T19.28 — the runner's self-test, first because it costs under a second and
  // because a runner that misreports its children misreports everything below.
  // Standalone: it spawns real children and kills one, which is the only way to
  // observe the `(code, signal)` pair the suite reads.
  { name: 'runner-outcome', file: 'scripts/checks/runner-outcome.mjs', standalone: true },
  // The front end a player actually meets first (§B3). Its URL has no scene
  // flag: the title screen is the default.
  {
    name: 'title',
    file: 'scripts/checks/title.mjs',
    // `?e2e=1` because the debug handle is behind §C17's guard now; without it
    // `__title` does not exist even in a dev build, which is the point.
    url: '?e2e=1',
    ready: '!!window.__title',
  },
  // Reached through the menu, not at `?skins=1`: the Skins button was a caller
  // with no callee (§A39), and a check that types the URL would not have noticed.
  {
    name: 'skins',
    file: 'scripts/checks/skins.mjs',
    url: '?menu=1&e2e=1',
    ready: '!!window.__menu',
  },
  // The pixel harness self-test. It runs on a synthetic page — it is proving the
  // *harness* can detect a change and, more importantly, can FAIL to detect one.
  { name: 'pixels', file: 'scripts/checks/pixels.mjs', url: '', ready: '!!document.body' },
  // T23.00: WebGL2 + half-float colour buffers in this browser. Every M23 renderer check
  // depends on both, so this fails by name before any of them photographs a black canvas.
  { name: 'webgl2', file: 'scripts/checks/webgl2.mjs', url: '', ready: '!!document.body' },
  // T23.01: the look-lab — each reference scene F1–F5 described and handed to the world
  // renderer, counted at both ends of the hand-over; an unknown id is the control.
  {
    name: 'look-lab',
    file: 'scripts/checks/look-lab.mjs',
    url: '?look=F1',
    ready: '!!window.__look && (window.__look.ready || !!window.__look.error)',
  },
  // T23.04: the sky — the look-lab's F1/F5 sky alone against the mockup's sky alone at Level A
  // (full tier, every look-thresholds.json metric, F5's sky as the must-fail control), then live
  // in the sandbox: each band's pan shift = pan × zoom × parallax, far < near, a moon fixed;
  // seeded; none on a space map.
  {
    name: 'look-sky',
    file: 'scripts/checks/look-sky.mjs',
    url: '?look=F1&only=sky',
    ready: '!!window.__look && (window.__look.ready || !!window.__look.error)',
  },
  // T23.06: the rock's albedo painted on the GPU — the look-lab's F1 albedo (lighting flat) against
  // the mockup's (fields = T23.05's dump, GLSL hash = world.js's, Level A), and live: a sandbox blast
  // changes only the repainted rects and scorches only its circle (pre-blast frame as the control).
  {
    name: 'look-albedo',
    file: 'scripts/checks/look-albedo.mjs',
    url: '?look=F1&only=albedo',
    ready: '!!window.__look && (window.__look.ready || !!window.__look.error)',
  },
  // T23.07: the lit terrain — the look-lab's F1 sky + terrain against the mockup's (Level A, full tier;
  // rim off, bevel off and no terrain must fail), the low tier's bake against the full shader.
  {
    name: 'look-terrain',
    file: 'scripts/checks/look-terrain.mjs',
    url: '?look=F1&only=world',
    ready: '!!window.__look && (window.__look.ready || !!window.__look.error)',
  },
  // T23.03: three.js under Phaser — canvas order, the world canvas where Phaser draws nothing,
  // one camera (a marker read back from both canvases in the same frame while panning), the
  // tier plumbing, and `&world=off` as the control. Standalone: it needs a networked match too.
  { name: 'world-canvas', file: 'scripts/checks/world-canvas.mjs', standalone: true },
  { name: 'sandbox', file: 'scripts/checks/sandbox.mjs', url: '?sandbox=1&seed=4242' },
  // T23.04C (R22): one page cycles title → quick match → results → exit twenty times; live WebGL
  // contexts ≤ 3, Phaser's never lost, three's memory and the GPU process flat. Serial: it reads the
  // GPU process's memory, which other checks' pages would move.
  { name: 'context-budget', file: 'scripts/checks/context-budget.mjs', standalone: true, serial: true },
  // T23.04C F8: no WebGL2 — title and sandbox boot on the stub renderer, no page errors, flat backdrop.
  { name: 'no-webgl2', file: 'scripts/checks/no-webgl2.mjs', url: '?e2e=1', ready: '!!window.__title' },
  // T21.28: rock in the rendered pixels under both ends of every gate's drawn base,
  // against the open air above the arch as the control. Seed 7, not 4242: on 4242
  // no asserted pad has an end the fill changes at the sampled rows, so the check
  // could not tell the fill from its absence (measured). Seed 7 is grassland with
  // all six pads on ground and four such ends.
  { name: 'gate-ground', file: 'scripts/checks/gate-ground.mjs', url: '?sandbox=1&seed=7' },
  // T23.07 retired `terrain-render` (§C0: a crater changes the picture — photographed on Phaser's rock,
  // parked flaky; `look-terrain`'s live half now asserts the crater lit in the very frame it is carved,
  // against a from-scratch repaint) and `terrain-seed` (two seeds wear different procTextures tiles —
  // the lit terrain's albedo is keyed by world position, as the mockup's is, so the property retired
  // with the tiles).
  { name: 'fog-shader', file: 'scripts/checks/fog-shader.mjs', url: '?sandbox=1&seed=4242' },
  // T23.04 retired `clouds`, `clouds-canvas` and `cloud-rain` with the clouds (F has haze, not
  // clouds) and the ambient rain that fell from them.
  // T21.02: the boots have to be visible on the player. In the sandbox
  // because it is the one scene that can supply a **control frame** — the
  // same body, in the same place, before and after picking them up.
  { name: 'boots-visible', file: 'scripts/checks/boots-visible.mjs', url: '?sandbox=1&seed=4242', flaky: true },
  // T22.11C / R63: an asteroid's gravity well on **rendered pixels**, with the
  // patch the body moves away from as its control region and the same map with
  // `setAsteroids([])` as its control frame. `?gravity=space` is R22's parameter
  // — without it the sandbox generates a landscape and the check has no rocks to
  // aim at, which it says rather than passing.
  {
    name: 'asteroid-gravity',
    file: 'scripts/checks/asteroid-gravity.mjs',
    url: '?sandbox=1&seed=4242&gravity=space',
  },
  // T22.16 (R102): each asteroid's core drawn at its centre, distinct from the rock
  // (a warm heart against a grey body patch, the control region), and gone with its
  // pixels when carved (the control frame). Both render paths, like the thrusters.
  { name: 'asteroid-cores', file: 'scripts/checks/asteroid-cores.mjs', url: '?sandbox=1&seed=4242&gravity=space' },
  {
    name: 'asteroid-cores-canvas',
    file: 'scripts/checks/asteroid-cores.mjs',
    url: '?sandbox=1&seed=4242&gravity=space&renderer=canvas',
    serial: true,
  },
  // T22.21 (R113): an iron asteroid drawn darker than ordinary rock (two frames lit
  // alike, open space the control) and darker on the minimap. Both render paths.
  { name: 'iron-asteroids', file: 'scripts/checks/iron-asteroids.mjs', url: '?sandbox=1&seed=4242&gravity=space' },
  {
    name: 'iron-asteroids-canvas',
    file: 'scripts/checks/iron-asteroids.mjs',
    url: '?sandbox=1&seed=4242&gravity=space&renderer=canvas',
    serial: true,
  },
  // T22.04: the thruster burst on the side opposite travel, photographed against its
  // own control frame on both sides of the body, every render path. Space-only, so
  // `?gravity=space` (R22). The Canvas twin is `serial` like the other Canvas checks.
  { name: 'thrusters', file: 'scripts/checks/thrusters.mjs', url: '?sandbox=1&seed=4242&gravity=space' },
  {
    name: 'thrusters-canvas',
    file: 'scripts/checks/thrusters.mjs',
    url: '?sandbox=1&seed=4242&gravity=space&renderer=canvas',
    serial: true,
  },
  // T22.04B F1: the same file under normal gravity — a firing jetpack draws **no**
  // plume, on `debug()` and on the pixels against the hidden-plume frame. The two
  // entries above are its presence control. `plumeOn(…, true)` planted at the live
  // call left the whole suite green before this existed.
  { name: 'thrusters-standard', file: 'scripts/checks/thrusters.mjs', url: '?sandbox=1&seed=4242&gravity=standard' },
  // T22.09B: space's radiation on the rendered frame — the edge glow and the HUD line
  // against a **sealed** control frame, a centre control region, and `Core.irradiated`
  // (bit 7's Rust predicate) read rather than assumed. `-standard` is the absence, with
  // the space entry as its presence control.
  { name: 'radiation', file: 'scripts/checks/radiation.mjs', url: '?sandbox=1&seed=4242&gravity=space' },
  { name: 'radiation-standard', file: 'scripts/checks/radiation.mjs', url: '?sandbox=1&seed=4242&gravity=standard' },
  // T22.06: the space backdrop — sun, earth, moon and stars each located on the frame
  // against its own hidden-body control frame, moving across a round with the camera and
  // an asteroid patch held still, seeded, and the ground sky (T23.04: the world renderer's) and
  // night absent in space beside their presence after a regenerate to standard. Both paths.
  { name: 'space-sky', file: 'scripts/checks/space-sky.mjs', url: '?sandbox=1&seed=4242&gravity=space' },
  {
    name: 'space-sky-canvas',
    file: 'scripts/checks/space-sky.mjs',
    url: '?sandbox=1&seed=4242&gravity=space&renderer=canvas',
    serial: true,
  },
  // T22.08B: the solar flare — every damage sample point under painted flare in both
  // render paths against a hidden-flare frame and a clear control point, a ghost in the
  // telegraph, a wander counted in drawn frames (R69), and a burning player on fire clear
  // of the ribbon. `-standard` is the absence: refused, undrawn, no button.
  { name: 'solar-flare', file: 'scripts/checks/solar-flare.mjs', url: '?sandbox=1&seed=4242&gravity=space' },
  {
    name: 'solar-flare-canvas',
    file: 'scripts/checks/solar-flare.mjs',
    url: '?sandbox=1&seed=4242&gravity=space&renderer=canvas',
    serial: true,
  },
  { name: 'solar-flare-standard', file: 'scripts/checks/solar-flare.mjs', url: '?sandbox=1&seed=4242&gravity=standard' },
  // T21.34: the unicorn wings on the body, same control-frame shape as boots.
  // Possible only since wings hover — under T21.03 the body flew off mid-check.
  // Not parked: a new check that starts on the flaky list gates nothing.
  { name: 'wings-visible', file: 'scripts/checks/wings-visible.mjs', url: '?sandbox=1&seed=4242' },
  // T23.07 retired `objects` (§D1: the scenery's atlas art goes with the carve) with the art: stamped
  // objects are rock in the mask and drawn as the lit rock (R5), so a carve through one is a carve
  // through rock — `look-terrain`'s live crater.
  // §C4/§C23: you must be able to see what you fired — in the GAME, and for both
  // delivery kinds. Standalone and on a real server since T13.06.6: it ran on
  // `?sandbox=1`, and the sandbox is the one scene that calls
  // `world.ordnance.update(dt)` itself, so it drew projectiles perfectly while
  // `GameScene` drew none at all. A check that passes only where the bug is
  // absent is worse than no check.
  { name: 'ordnance-visible', file: 'scripts/checks/ordnance-visible.mjs', standalone: true },
  // §F2: a bullet is drawn **while it flies**, proved without stopping time.
  // Standalone and on a real server for the reason `ordnance-visible` is: the
  // sandbox is the one scene that drives its own ordnance layer, so a check that
  // ran there would pass with `GameScene` drawing nothing at all.
  { name: 'bullets-visible', file: 'scripts/checks/bullets-visible.mjs', standalone: true, flaky: true },
  // §C6: the weather must reach the screen, not just the simulation.
  { name: 'weather-visible', file: 'scripts/checks/weather-visible.mjs', url: '?sandbox=1&seed=4242' },
  { name: 'wasd', file: 'scripts/checks/wasd.mjs', url: '?sandbox=1&seed=4242' },
  // T23.04 retired `sky` (the §A4 keyframe gradient's phases), `living-sky` (the ridges) and
  // `canvas-renderer` (every region of it was the ridge band: foot, tint, wrap seam) with the
  // sky they photographed; `look-sky` is the new sky's check. The night/moonlit-day look is T23.11's.
  // T21.37: the red Recruit is red on Canvas too, against the plain Recruit in the same frame.
  {
    name: 'canvas-tinted-skin',
    file: 'scripts/checks/canvas-tinted-skin.mjs',
    url: '?sandbox=1&seed=4242&renderer=canvas',
    serial: true,
  },
  // `disabled: 'T23.11'` (T23.07): both photograph night as Phaser's MULTIPLY lightmap darkening Phaser's
  // rock. The rock is the lit terrain on the world canvas now, F1's night at every hour, and that layer
  // cannot darken it; R7 replaces the lightmap with the night/moonlit-day blend, which T23.11 builds
  // and re-points these at. Measured: "night corner 14 vs day 14", "kept 100% of daylight".
  { name: 'lightmap', file: 'scripts/checks/lightmap.mjs', url: '?sandbox=1&seed=4242', disabled: 'T23.11' },
  {
    name: 'night_darkens_the_world',
    file: 'scripts/checks/night_darkens_the_world.mjs',
    url: '?sandbox=1&seed=4242',
    disabled: 'T23.11',
  },
  { name: 'm4-checkpoint', file: 'scripts/checks/m4-checkpoint.mjs', url: '?sandbox=1&seed=12345' },
  { name: 'night-combat', file: 'scripts/checks/night-combat.mjs', url: '?sandbox=1&seed=12345', flaky: true },
  { name: 'feel', file: 'scripts/checks/feel.mjs', url: '?sandbox=1&seed=12345' },
  { name: 'minimap', file: 'scripts/checks/minimap.mjs', url: '?sandbox=1&seed=12345' },
  // `serial` (measured): red in 3 of 4 `--jobs 4` runs — a landing played at
  // 0.250 against a predicted 0.561-0.894, an impact speed from a starved frame
  // clock — and green in both `--jobs 1` runs.
  { name: 'audio', file: 'scripts/checks/audio.mjs', url: '?sandbox=1&seed=12345', serial: true },
  // T23.07 retired `decorations` with the `decor` atlas and `decorations.ts` (R15).
  // `flaky` (parked, tasks/flaky-test.md): red once at `--jobs 4` in a full gate
  // ("the mean moved only 2.2"), green alone.
  { name: 'platforms', file: 'scripts/checks/platforms.mjs', url: '?sandbox=1&seed=4242', flaky: true },
  { name: 'm9-checkpoint', file: 'scripts/checks/m9-checkpoint.mjs', url: '?sandbox=1&seed=1' },
  // `serial`: it fails on measured frame time (feel-layer ms/frame, fps p50,
  // p99 spikes), and those are exactly what a concurrent check steals.
  // `flaky` (parked, tasks/flaky-test.md): red at 51.3 fps in the serial tail of a
  // full gate, still under the decaying load of the parallel phase; 59.9 and 59.5
  // fps alone on an idle box. `serial` does not wait for the load to fall.
  { name: 'perf', file: 'scripts/checks/perf.mjs', url: '?sandbox=1&seed=4242', serial: true, flaky: true },
  // R37's single-chunk rebake budget: moved into `perf` by T22.00C, where the flaky flag
  // meant nothing gated it; its own serial check since the M22 close-out.
  { name: 'chunk-rebake', file: 'scripts/checks/chunk-rebake.mjs', url: '?sandbox=1&seed=4242', serial: true },
  // §C7: a supply crate falls where you can see it fall. Standalone — it needs a
  // real server, because crates come from the server's spawn schedule and there
  // is no sandbox path to one.
  // `serial` (measured): red in both shared-vite `--jobs 4` runs — "the crate was
  // never framed in flight" — and green at `--jobs 1` and in both own-stack runs.
  { name: 'crates', file: 'scripts/checks/crates.mjs', standalone: true, serial: true },
  // §F10.3: **a molotov's fire, in the game, in pixels.** Standalone — it needs
  // a real server, because a molotov's crowd is `Burst::Flames` narrated as 24
  // `projectile_spawn` events and the sandbox has no molotov in its loadout. It
  // also carries §F10.3's full-flame-field frame time, for the same reason.
  // `serial`: it fails when a full flame field's median frame time passes 50 ms,
  // a wall-clock rendering cost that sharing the box would inflate.
  { name: 'fire-visible', file: 'scripts/checks/fire-visible.mjs', standalone: true, serial: true },
  // §F9: the fog veil **in the game**, not only in the sandbox. Standalone — it
  // needs a real server, because a networked client learns that fog exists from
  // an `effect_start` event and the sandbox path never sends one.
  { name: 'fog-visible', file: 'scripts/checks/fog-visible.mjs', standalone: true, flaky: true },
  // T19.24. Standalone and networked: the claim is that a lava vent lights the
  // ground **in a real match**, and the sandbox — which already did — proves the
  // half that was never broken. It waits for night, which the server only
  // reaches through `round_time`, so it is one of the slower members here.
  // Owner 2026-09-16: lava is switched off. This check starts its server with
  // `WEATHER=lava`, which `config.rs` now **refuses** — the server would not come
  // up at all, so the failure would read as a broken harness rather than as a
  // disabled effect. Out of the suite the way `toxic-rain-game` is, and for the
  // same reason: the effect's code is all still here, waiting on the placement
  // fix the owner asked for (*"coming out of weird places"*).
  {
    name: 'lava-lights',
    file: 'scripts/checks/lava-lights.mjs',
    standalone: true,
    disabled: 'lava switched off (LAVA_ENABLED), owner 2026-09-16',
  },
  // §C3: the round ends and you are told. Standalone — it drives a real phase
  // machine on a shortened ROUND_SECONDS, and there is no sandbox path to `Ended`.
  { name: 'round-end', file: 'scripts/checks/round-end.mjs', standalone: true },
  // T21.30: after "Round over", a held direction leaves the rendered local player
  // where it is; the same hold during `Playing` is the control. Standalone for
  // round-end's reason — `Ended` exists only on a real phase machine.
  { name: 'round-over-frozen', file: 'scripts/checks/round-over-frozen.mjs', standalone: true },
  // `ownStack`: it starts its own server, vite and browser by hand rather than
  // through `startStack`, so the shared-stack variables would reach nothing.
  { name: 'lobby-start', file: 'scripts/checks/lobby-start.mjs', standalone: true, ownStack: true },
  // §E1/§E6/§E7. The only gate on the lobby screen: vitest is `environment:
  // 'node'` with no canvas, so a green unit run proves the reducer and says
  // nothing about whether a lobby appears (D-26).
  { name: 'lobby', file: 'scripts/checks/lobby.mjs', standalone: true },
  // Owner 2026-09-16: quick → Esc → quick seated the same name twice.
  { name: 'quick-rejoin', file: 'scripts/checks/quick-rejoin.mjs', standalone: true },
  // §C26 — the jetpack number reaches the screen. Standalone: fuel comes from
  // the snapshot, so it needs a real server rather than the sandbox. Named
  // `hud-bars` because T14.02's Done-when names the same check for §C8's bars,
  // which it will add here.
  // `serial` (measured): red in 3 of 4 `--jobs 4` runs — the poisoned bar's green
  // channel against the predicted blend — and green in both `--jobs 1` runs.
  { name: 'hud-bars', file: 'scripts/checks/hud-bars.mjs', standalone: true, serial: true },
  // T14.01 / §C8: the round timer and the event banner. Standalone because it
  // drives a 90 s round to its warning threshold and waits for the weather
  // scheduler's first roll — it needs its own server, not a shared one.
  { name: 'hud-timer', file: 'scripts/checks/hud-timer.mjs', standalone: true, flaky: true },
  // T14.04 / §C11: `E` throws a grenade from anywhere in the inventory.
  { name: 'quick-throw', file: 'scripts/checks/quick-throw.mjs', standalone: true },
  // T14.05 / §C10: the quick bar, the backpack, and a drag that reaches the server.
  // `flaky` (parked, tasks/flaky-test.md): red in 4 of 6 runs including one at
  // `--jobs 1`, so not a concurrency effect. Its own diagnosis: the bag GREW 6 -> 7
  // during a fixed 600 ms sleep — a pickup — and the assertion reads any change as
  // a drop.
  { name: 'inventory-ui', file: 'scripts/checks/inventory-ui.mjs', standalone: true, flaky: true },
  // T14.06 / §C13: the escape menu, and a quit that actually leaves the room.
  { name: 'escape-menu', file: 'scripts/checks/escape-menu.mjs', standalone: true },
  // T21.24: the player-facing FPS counter, in pixels. Standalone — it lives on
  // `GameScene`'s HUD, and the sandbox has a debug HUD of its own, so a sandbox
  // check would pass against a build where the real game drew nothing (§C0).
  { name: 'fps-counter', file: 'scripts/checks/fps-counter.mjs', standalone: true },
  // T14.07 / §C12: debug mode off by default, F1 on, and it changes nothing.
  { name: 'debug-mode', file: 'scripts/checks/debug-mode.mjs', standalone: true },
  // T14.08 / §C17: the dev surface is compiled out. Standalone and no shared
  // stack — it builds the client twice and drives the *artifact*, not the dev
  // server, which is the whole point.
  // `ownStack`: it builds and serves the production artifact and drives *that*;
  // the shared dev server is exactly what it must not use.
  { name: 'no-dev-surface', file: 'scripts/checks/no-dev-surface.mjs', standalone: true, ownStack: true },
  // T15.01 / §C5: teleport pads. Standalone — it needs a real server (the pads
  // arrive in `map_init` and the charge in the snapshot) and it walks a player
  // across the map, which wants its own round rather than a shared one.
  // `serial` (measured, 2026-09-14): red in both own-stack `--jobs 4` runs — "the
  // charge never left zero", a pad charge polled against a wall-clock deadline —
  // and green at `--jobs 1`. Then `flaky` (parked, tasks/flaky-test.md): red again
  // running ALONE in the serial tail of the 1160eac `check.sh --changed` gate —
  // "timed out after 30 s waiting for the respawn", health 0 but still alive.
  { name: 'teleport', file: 'scripts/checks/teleport.mjs', standalone: true, serial: true, flaky: true },
  // T15.04 / §C16. Standalone: it needs a real server, because birds are
  // server-simulated and the drop has to travel the wire.
  // `serial` (measured): red in both `--jobs 4` runs — "73s and every bird is still
  // flying", a wall-clock hunting budget — and green at `--jobs 1`.
  { name: 'birds', file: 'scripts/checks/birds.mjs', standalone: true, serial: true },
  // T15.02 / §C15: the M15 checkpoint — dig through the floor, fall in, die.
  // Standalone: it needs a real server (the void kill and its attribution are
  // server-side) and a FIXED_SEED map of its own. Un-parked in T21.35: it was
  // firing before its aim reached the server, not flaking.
  { name: 'void', file: 'scripts/checks/void.mjs', standalone: true },
  // Standalone: it launches its own vite and browser and calls `process.exit`.
  // Imported into this process it would terminate the suite mid-run — and exit 0
  // while doing it, hiding every earlier failure. Run as a subprocess instead.
  // `serial` (measured): red in both `--jobs 4` runs — toxic "reached the active
  // phase" still telegraphing after a fixed `waitForTimeout(3600)` — green at `--jobs 1`.
  // `ownStack`: it launches its own vite and browser, with no harness, so the
  // shared-stack variables would reach nothing.
  { name: 'm5-weather', file: 'scripts/checks/m5-weather.mjs', standalone: true, serial: true, ownStack: true },
  // T10.06. Standalone: it needs a real game-server, because the overlay's
  // visibility follows the **snapshot's** alive flag (§B4) and no sandbox or
  // synthetic event can raise it — which is the property worth having.
  { name: 'death', file: 'scripts/checks/death.mjs', standalone: true },
  // T11.10 — melee, cones, mines and hazards are drawn, not merely narrated.
  // The mine assertion counts the client's live mines against the server's own
  // narration (placed − ended); one number would have passed for the whole
  // period the bug existed (§A39).
  { name: 'ordnance', file: 'scripts/checks/ordnance.mjs', standalone: true },
  // T21.43 — a mounted player holding the button fires a stream from the gun
  // platform: the server's spawns, the rounds drawn and the interval against
  // each other, with a single click as the control. Standalone: mounting is the
  // server's word, and only a real round can give it.
  { name: 'platform-autofire', file: 'scripts/checks/platform-autofire.mjs', standalone: true },
  // T20.13: what happens *after* a round ends — one player votes to replay, one
  // exits and quick-matches. Standalone: it needs two clients and a real round
  // driven to `Ended`, which is the sequence nothing else in the suite reaches.
  // `serial` (measured): red in both `--jobs 4` runs — "the player who left and
  // quick-matched never got a match", then a crashed page — green at `--jobs 1`.
  { name: 'rematch', file: 'scripts/checks/rematch.mjs', standalone: true, serial: true },
  // T21.32: what `rematch` cannot see — a round whose vote window is waited out, a
  // lobby start on a new map, and the first frames of a match reached through the
  // menu. Standalone: it needs a short round and three bots on its own server.
  { name: 'round-over', file: 'scripts/checks/round-over.mjs', standalone: true },
  // T20.05: the one weather assertion that is **not** a sandbox check. Every
  // other one drives `?sandbox=1`, which pokes the weather sub-layers by hand and
  // therefore cannot see whether the shared `WorldView` path works — the §C0 shape
  // that hid a broken `ordnance.update` for three milestones. Standalone: it needs
  // `WEATHER=toxic` on a real server and a real round.
  // `disabled` (T21.39): toxic rain is switched off and `WEATHER=toxic` is refused, so
  // this can only run once T21.41's rewrite flips `TOXIC_RAIN_ENABLED` back on.
  { name: 'toxic-rain-game', file: 'scripts/checks/toxic-rain-game.mjs', standalone: true, disabled: 'T21.41' },
  // T23.04 retired `ambient-rain` with the ambient rain (F has no rain; no gameplay reader).
  { name: 'minimap-crates', file: 'scripts/checks/minimap-crates.mjs', standalone: true },
  { name: 'beams-shader', file: 'scripts/checks/beams-shader.mjs', standalone: true },
  { name: 'smoke-shader', file: 'scripts/checks/smoke-shader.mjs', standalone: true },
  { name: 'fire-shader', file: 'scripts/checks/fire-shader.mjs', standalone: true },
  { name: 'explosion-shader', file: 'scripts/checks/explosion-shader.mjs', standalone: true },
  // T22.04B F2/F3: GameScene's plume wiring, which no sandbox run reaches — a remote's
  // plume on the other client in space, none after the bell, none under standard
  // gravity, none on a player killed mid-burn. Standalone: two real servers (the
  // second poisons everyone, for the death) and six clients.
  // T22.14E: parked — the bell arm fails at random, on two assertions; see `tasks/flaky-test.md`.
  { name: 'thrusters-match', file: 'scripts/checks/thrusters-match.mjs', standalone: true, flaky: true },
  // T22.09C F1: GameScene's bit-7 reader, which no sandbox run reaches — a flat suit
  // (`DEV_START_BATTERY=0`) irradiated in a real space match, a full one sealed, and
  // neither drawn in warmup. Standalone: two servers, one client each.
  { name: 'radiation-match', file: 'scripts/checks/radiation-match.mjs', standalone: true },
  // T22.06: the space backdrop in GameScene — the sky seeded off `welcome`'s seed (a
  // networked client's `core.meta.seed` is the startup map's), darkness 0 at the
  // ground's night on the wire *and* on the frame, the ground sky off (T23.04), the bodies
  // moving on the round's clock; a standard stack at the same clock is the control.
  { name: 'space-sky-match', file: 'scripts/checks/space-sky-match.mjs', standalone: true },
  // T22.08B: GameScene's flare, which no sandbox run reaches — `effect_start` into
  // `FlareClock`, the ribbon derived through `flare_points` and painted over every damage
  // point in view, against a hidden-flare frame. Standalone: a WEATHER=flare space server.
  { name: 'solar-flare-match', file: 'scripts/checks/solar-flare-match.mjs', standalone: true, flaky: true },
  // T22.10B: the breach vortex — a sandbox vortex photographed flat and shader, then a
  // real match on a DEV_PROBE server that breaches the rim: the vortex where the server
  // put it, no prediction correction while it pulls (the rubber-band an untold client
  // shows), the trip inside the rim, the capture ring painted in both paths against a
  // hidden frame, and the minimap unchanged. Standalone: its own server.
  { name: 'breach-vortex', file: 'scripts/checks/breach-vortex.mjs', standalone: true },
  // T22.12B: the black hole in a real match on a DEV_PROBE server — where the server
  // put it and the rock it ate at both ends, no rubber-band while it pulls, the named
  // death (feed + overlay), no escape from inside the capture radius, the disc and ring
  // painted in both paths against a hidden frame, frozen at the bell. Standalone.
  { name: 'black-hole', file: 'scripts/checks/black-hole.mjs', standalone: true },
  // T22.19 (R107): a body in a rock's band is drawn with its feet along the pull — feet-up
  // under a rock (the figure matches itself posed upright turned 180°, against the
  // actors-hidden frame), upright on top and easing back in free space (the controls),
  // the aim still screen-space. Two humans on a DEV_PROBE server: the host's own body on
  // WebGL, the guest's view of it (a remote) on Canvas. Standalone.
  { name: 'stand-on-asteroid', file: 'scripts/checks/stand-on-asteroid.mjs', standalone: true },
  // T20.10: ground animals, counted at both ends and then photographed.
  // Standalone: it needs a real round on a fixed seed with no bots, because a
  // bot's stray rocket killing one changes the counts it compares.
  { name: 'animals', file: 'scripts/checks/animals.mjs', standalone: true },
  // §B9's gate, and the only assertion in the tree about a **rendered** player's
  // skin (T20.04). Standalone: two clients on two different skins, in one frame,
  // on a real server — `skins.mjs` never enters a game, which is why everybody
  // was a Recruit for four milestones with a green suite.
  { name: 'skins-ingame', file: 'scripts/checks/skins-ingame.mjs', standalone: true },
  // The M6 checkpoint: two browser contexts, one server, one round. Standalone
  // because it needs a real game-server and two clients rather than the sandbox.
  { name: 'two-clients', file: 'scripts/e2e-two-clients.mjs', standalone: true, flaky: true },
  // The M10 checkpoint: three browsers, two rooms, a code read off the screen.
  // It found two real bugs on its first run — nothing subscribed to
  // `room_created`, and every room shared one hardcoded seed — so it earns its
  // place in the default suite rather than behind a flag.
  { name: 'm10-checkpoint', file: 'scripts/checks/m10-checkpoint.mjs', standalone: true, flaky: true },
  // T9.06 — one *complete* round, ~3 minutes of wall clock. Opt-in rather than
  // in the default path: it is the slowest thing in the repo by an order of
  // magnitude, and a gate people skip because it takes four minutes is a gate
  // that gates nothing.
  {
    name: 'full-round',
    file: 'scripts/checks/full-round.mjs',
    standalone: true,
    optIn: true,
  },
]
