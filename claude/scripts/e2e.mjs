#!/usr/bin/env node
/**
 * T8.07 — the end-to-end suite.
 *
 *   node scripts/e2e.mjs            # everything
 *   node scripts/e2e.mjs wasd sky   # only checks whose name matches
 *
 * Every check drives a **real browser against the real client** and reads the
 * simulation's own state through `window.__game`, never the rendered sprite: a
 * sprite can move for reasons that have nothing to do with input.
 *
 * Every check writes at least one screenshot to `shots/`. On this box there is no
 * display, so a screenshot is the only way a failure is ever *seen* — the numbers
 * say what broke and the picture says what it looked like.
 *
 * ## Why this is not `@playwright/test`
 *
 * `docs/70` T8.07 names `playwright.config.ts` and `e2e/*.spec.ts`. The checks
 * already existed as `scripts/checks/*.mjs` driven by `drive.mjs`, and that
 * harness already solves the two things that are actually hard here: reading
 * vite's port from its own output (it falls back to 5174+ when 5173 is taken),
 * and pointing Chromium at the libraries unpacked under `~/.cache/pwlibs`, which
 * this box does not have installed system-wide. Adding a second runner would mean
 * a second way to launch a browser and a second place for those two workarounds
 * to drift.
 *
 * What the task actually asked for was a suite that runs in the gate rather than
 * a pile of scripts nobody runs. That is what this is — and booting vite and
 * Chromium **once** for all of them, instead of once per check, is what makes
 * putting it in the gate affordable.
 */
import { spawn, spawnSync, execSync } from 'node:child_process'
import { mkdirSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { createRequire } from 'node:module'
import { matchVitePort } from './vite-url.mjs'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const shotsDir = join(root, 'shots')
mkdirSync(shotsDir, { recursive: true })

const libDir = join(process.env.HOME ?? '', '.cache/pwlibs/root/usr/lib/x86_64-linux-gnu')
const chromePath = join(
  process.env.HOME ?? '',
  '.cache/ms-playwright/chromium-1234/chrome-linux64/chrome',
)

/**
 * The suite. `url` is the query string the check needs; a check that regenerates
 * the map itself only needs `?sandbox=1`.
 *
 * Ordered cheapest-first, so a broken build fails on `sandbox` in seconds rather
 * than after the two-client round.
 */
const CHECKS = [
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
  { name: 'sandbox', file: 'scripts/checks/sandbox.mjs', url: '?sandbox=1&seed=4242' },
  // §C0's gate: destroying terrain must change the picture, not just the mask.
  { name: 'terrain-render', file: 'scripts/checks/terrain-render.mjs', url: '?sandbox=1&seed=4242' },
  // §D1's gate: destroying terrain must take the SCENERY's pixels with it.
  // Standalone — it needs a real round for `map_init` to carry the objects.
  { name: 'objects', file: 'scripts/checks/objects.mjs', standalone: true },
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
  { name: 'bullets-visible', file: 'scripts/checks/bullets-visible.mjs', standalone: true },
  // §C6: the weather must reach the screen, not just the simulation.
  { name: 'weather-visible', file: 'scripts/checks/weather-visible.mjs', url: '?sandbox=1&seed=4242' },
  { name: 'wasd', file: 'scripts/checks/wasd.mjs', url: '?sandbox=1&seed=4242' },
  { name: 'sky', file: 'scripts/checks/sky.mjs', url: '?sandbox=1&seed=4242' },
  // §C14: the mountains and clouds must reach the frame, not just the maths.
  { name: 'living-sky', file: 'scripts/checks/living-sky.mjs', url: '?sandbox=1&seed=4242' },
  { name: 'lightmap', file: 'scripts/checks/lightmap.mjs', url: '?sandbox=1&seed=4242' },
  {
    name: 'night_darkens_the_world',
    file: 'scripts/checks/night_darkens_the_world.mjs',
    url: '?sandbox=1&seed=4242',
  },
  { name: 'm4-checkpoint', file: 'scripts/checks/m4-checkpoint.mjs', url: '?sandbox=1&seed=12345' },
  { name: 'night-combat', file: 'scripts/checks/night-combat.mjs', url: '?sandbox=1&seed=12345' },
  { name: 'feel', file: 'scripts/checks/feel.mjs', url: '?sandbox=1&seed=12345' },
  { name: 'minimap', file: 'scripts/checks/minimap.mjs', url: '?sandbox=1&seed=12345' },
  { name: 'audio', file: 'scripts/checks/audio.mjs', url: '?sandbox=1&seed=12345' },
  { name: 'decorations', file: 'scripts/checks/decorations.mjs', url: '?sandbox=1&seed=4242' },
  { name: 'm9-checkpoint', file: 'scripts/checks/m9-checkpoint.mjs', url: '?sandbox=1&seed=1' },
  { name: 'perf', file: 'scripts/checks/perf.mjs', url: '?sandbox=1&seed=4242' },
  // §C7: a supply crate falls where you can see it fall. Standalone — it needs a
  // real server, because crates come from the server's spawn schedule and there
  // is no sandbox path to one.
  { name: 'crates', file: 'scripts/checks/crates.mjs', standalone: true },
  // §F10.3: **a molotov's fire, in the game, in pixels.** Standalone — it needs
  // a real server, because a molotov's crowd is `Burst::Flames` narrated as 24
  // `projectile_spawn` events and the sandbox has no molotov in its loadout. It
  // also carries §F10.3's full-flame-field frame time, for the same reason.
  { name: 'fire-visible', file: 'scripts/checks/fire-visible.mjs', standalone: true },
  // §F9: the fog veil **in the game**, not only in the sandbox. Standalone — it
  // needs a real server, because a networked client learns that fog exists from
  // an `effect_start` event and the sandbox path never sends one.
  { name: 'fog-visible', file: 'scripts/checks/fog-visible.mjs', standalone: true },
  // §C3: the round ends and you are told. Standalone — it drives a real phase
  // machine on a shortened ROUND_SECONDS, and there is no sandbox path to `Ended`.
  { name: 'round-end', file: 'scripts/checks/round-end.mjs', standalone: true },
  { name: 'lobby-start', file: 'scripts/checks/lobby-start.mjs', standalone: true },
  // §E1/§E6/§E7. The only gate on the lobby screen: vitest is `environment:
  // 'node'` with no canvas, so a green unit run proves the reducer and says
  // nothing about whether a lobby appears (D-26).
  { name: 'lobby', file: 'scripts/checks/lobby.mjs', standalone: true },
  // §C26 — the jetpack number reaches the screen. Standalone: fuel comes from
  // the snapshot, so it needs a real server rather than the sandbox. Named
  // `hud-bars` because T14.02's Done-when names the same check for §C8's bars,
  // which it will add here.
  { name: 'hud-bars', file: 'scripts/checks/hud-bars.mjs', standalone: true },
  // T14.01 / §C8: the round timer and the event banner. Standalone because it
  // drives a 90 s round to its warning threshold and waits for the weather
  // scheduler's first roll — it needs its own server, not a shared one.
  { name: 'hud-timer', file: 'scripts/checks/hud-timer.mjs', standalone: true },
  // T14.04 / §C11: `E` throws a grenade from anywhere in the inventory.
  { name: 'quick-throw', file: 'scripts/checks/quick-throw.mjs', standalone: true },
  // T14.05 / §C10: the quick bar, the backpack, and a drag that reaches the server.
  { name: 'inventory-ui', file: 'scripts/checks/inventory-ui.mjs', standalone: true },
  // T14.06 / §C13: the escape menu, and a quit that actually leaves the room.
  { name: 'escape-menu', file: 'scripts/checks/escape-menu.mjs', standalone: true },
  // T14.07 / §C12: debug mode off by default, F1 on, and it changes nothing.
  { name: 'debug-mode', file: 'scripts/checks/debug-mode.mjs', standalone: true },
  // T14.08 / §C17: the dev surface is compiled out. Standalone and no shared
  // stack — it builds the client twice and drives the *artifact*, not the dev
  // server, which is the whole point.
  { name: 'no-dev-surface', file: 'scripts/checks/no-dev-surface.mjs', standalone: true },
  // T15.01 / §C5: teleport pads. Standalone — it needs a real server (the pads
  // arrive in `map_init` and the charge in the snapshot) and it walks a player
  // across the map, which wants its own round rather than a shared one.
  { name: 'teleport', file: 'scripts/checks/teleport.mjs', standalone: true },
  // T15.04 / §C16. Standalone: it needs a real server, because birds are
  // server-simulated and the drop has to travel the wire.
  { name: 'birds', file: 'scripts/checks/birds.mjs', standalone: true },
  // T15.02 / §C15: the M15 checkpoint — dig through the floor, fall in, die.
  // Standalone: it needs a real server (the void kill and its attribution are
  // server-side) and a FIXED_SEED map of its own.
  { name: 'void', file: 'scripts/checks/void.mjs', standalone: true },
  // Standalone: it launches its own vite and browser and calls `process.exit`.
  // Imported into this process it would terminate the suite mid-run — and exit 0
  // while doing it, hiding every earlier failure. Run as a subprocess instead.
  { name: 'm5-weather', file: 'scripts/checks/m5-weather.mjs', standalone: true },
  // T10.06. Standalone: it needs a real game-server, because the overlay's
  // visibility follows the **snapshot's** alive flag (§B4) and no sandbox or
  // synthetic event can raise it — which is the property worth having.
  { name: 'death', file: 'scripts/checks/death.mjs', standalone: true },
  // T11.10 — melee, cones, mines and hazards are drawn, not merely narrated.
  // The mine assertion counts the client's live mines against the server's own
  // narration (placed − ended); one number would have passed for the whole
  // period the bug existed (§A39).
  { name: 'ordnance', file: 'scripts/checks/ordnance.mjs', standalone: true },
  // T20.13: what happens *after* a round ends — one player votes to replay, one
  // exits and quick-matches. Standalone: it needs two clients and a real round
  // driven to `Ended`, which is the sequence nothing else in the suite reaches.
  { name: 'rematch', file: 'scripts/checks/rematch.mjs', standalone: true },
  // T20.05: the one weather assertion that is **not** a sandbox check. Every
  // other one drives `?sandbox=1`, which pokes the weather sub-layers by hand and
  // therefore cannot see whether the shared `WorldView` path works — the §C0 shape
  // that hid a broken `ordnance.update` for three milestones. Standalone: it needs
  // `WEATHER=toxic` on a real server and a real round.
  { name: 'toxic-rain-game', file: 'scripts/checks/toxic-rain-game.mjs', standalone: true },
  // §B9's gate, and the only assertion in the tree about a **rendered** player's
  // skin (T20.04). Standalone: two clients on two different skins, in one frame,
  // on a real server — `skins.mjs` never enters a game, which is why everybody
  // was a Recruit for four milestones with a green suite.
  { name: 'skins-ingame', file: 'scripts/checks/skins-ingame.mjs', standalone: true },
  // The M6 checkpoint: two browser contexts, one server, one round. Standalone
  // because it needs a real game-server and two clients rather than the sandbox.
  { name: 'two-clients', file: 'scripts/e2e-two-clients.mjs', standalone: true },
  // The M10 checkpoint: three browsers, two rooms, a code read off the screen.
  // It found two real bugs on its first run — nothing subscribed to
  // `room_created`, and every room shared one hardcoded seed — so it earns its
  // place in the default suite rather than behind a flag.
  { name: 'm10-checkpoint', file: 'scripts/checks/m10-checkpoint.mjs', standalone: true },
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

const filters = process.argv.slice(2)
const selected = filters.length
  ? CHECKS.filter((c) => filters.some((f) => c.name.includes(f)))
  : // An opt-in check is only skipped when nothing was asked for by name, so
    // `e2e.mjs full-round` still runs it.
    CHECKS.filter((c) => !c.optIn)
if (!selected.length) {
  console.error(`no checks match ${filters.join(', ')}`)
  console.error(`available: ${CHECKS.map((c) => c.name).join(', ')}`)
  process.exit(2)
}

const require = createRequire(join(root, 'client/package.json'))
const { chromium } = require('playwright-core')

/**
 * **Build the wasm before the clock starts, not inside it** (T19.16).
 *
 * This used to be `npm --prefix client run dev`, whose `predev` hook runs
 * `scripts/wasm-build.mjs` — so the 90 s budget below, whose failure message
 * says *"vite did not report a port"*, was in fact a budget for **a release
 * Rust build plus a lock wait plus vite**. Measured on an idle box: 11.7 s to
 * the port line, of which **11.6 s was `predev` and 0.1 s was vite**. The
 * deadline was 99 % a build timer wearing vite's name.
 *
 * That is not academic. `wasm-build.mjs` takes a lock (T19.15) whose wait is
 * bounded at ten minutes, and every concurrent build adds one build to the
 * queue. Reproduced, exactly: 24 queued `wasm-build.mjs` processes, then
 * `node scripts/e2e.mjs title` →
 * `(startup): vite did not report a port within 90 s`, with vite never asked to
 * do anything. A single blocking build put a straight run at 19.9 s and a
 * twelve-deep queue at 93.3 s.
 *
 * So the build happens here, synchronously and **outside** the deadline, and
 * vite is then started the way every standalone check starts it — `npx vite`,
 * which runs no npm hooks. The 90 s is untouched and now measures what it
 * names: a step that takes 0.1 s. Nothing was widened; the wrong work was
 * moved out.
 */
console.log('building wasm before starting the clock (T19.16)')
const built = spawnSync('node', [join(root, 'scripts/wasm-build.mjs')], {
  cwd: root,
  stdio: 'inherit',
  env: process.env,
})
if (built.status !== 0) {
  console.error(`wasm-build failed (${built.status}) — vite would serve a stale or missing pkg`)
  process.exit(1)
}

// `detached` so this gets its own process group. `npx vite` forks the real vite
// as a grandchild, and killing npx leaves that grandchild running — ten orphaned
// vite servers were found accumulating on this box, which is itself the "loaded
// machine" that has been blamed for three separate flakes. Killing the group
// kills the grandchild too.
const vite = spawn('npx', ['vite', '--strictPort=false'], {
  detached: true,
  cwd: join(root, 'client'),
  env: { ...process.env, LD_LIBRARY_PATH: libDir },
})

let port = null
const portReady = new Promise((res, rej) => {
  // Shared parse (scripts/vite-url.mjs): vite puts an ANSI bold escape between
  // `localhost:` and the port, and whether it colourises at all depends on the
  // inherited environment — a shell exporting FORCE_COLOR makes it do so even
  // through a pipe. Four scripts each wrote this by hand and all four broke.
  const onData = (b) => {
    const found = matchVitePort(b)
    const m = found ? [null, String(found)] : null
    if (m && !port) {
      port = Number(m[1])
      res(port)
    }
  }
  vite.stdout.on('data', onData)
  vite.stderr.on('data', onData)
  // 90 s for a step measured at 0.1 s. It is generous because it is now only
  // about vite: see the comment above the build for why it used to be a
  // coin flip and what it was really timing.
  setTimeout(() => rej(new Error('vite did not report a port within 90 s')), 90_000)
})

const shutdown = () => {
  try {
    // Negative pid = the whole group, which is where the real vite lives.
    process.kill(-vite.pid, 'SIGTERM')
  } catch {
    try {
      vite.kill('SIGTERM')
    } catch {
      /* already gone */
    }
  }
}
process.on('exit', shutdown)

/**
 * Processes the suite is responsible for, sampled before and after.
 *
 * `npx vite`, `npm run dev` and `cargo run` each fork the process that actually
 * holds the port, so a naive `child.kill()` reaps the wrapper and orphans the
 * server. Five scripts wrote that naive version and all five leaked. The load
 * accumulated silently and three sessions recorded the result as "two-clients is
 * flaky under contention" — the contention was self-inflicted, and the box got
 * slower every time the suite ran.
 *
 * Counting at both ends turns that from an invisible drift into a loud failure
 * (§A39). Only pids that are NEW since the suite started are reported, so a dev
 * server someone already had running is not blamed on the suite.
 */
const STRAY_PATTERNS = [
  ['vite', /node .*\.bin\/vite/],
  ['chromium', /chrome-linux64\/chrome/],
  ['game-server', /target\/(debug|release)\/game-server/],
]
const strayPids = () => {
  const out = new Map()
  let ps = ''
  try {
    ps = execSync('ps -eo pid=,args=', { encoding: 'utf8' })
  } catch {
    return out // ps unavailable: the guard simply does not run
  }
  for (const line of ps.split('\n')) {
    const m = line.trim().match(/^(\d+)\s+(.*)$/)
    if (!m) continue
    for (const [name, re] of STRAY_PATTERNS) {
      if (re.test(m[2])) out.set(Number(m[1]), name)
    }
  }
  return out
}
const straysBefore = strayPids()

const results = []
let browser

try {
  await portReady
  browser = await chromium.launch({
    executablePath: chromePath,
    env: { ...process.env, LD_LIBRARY_PATH: libDir },
    args: [
      '--no-sandbox',
      '--use-gl=swiftshader',
      '--enable-unsafe-swiftshader',
      // rAF is throttled in a backgrounded page and the client steps off rAF,
      // so a check whose page is not foreground barely simulates. See the same
      // flags in `scripts/checks/harness.mjs` for what that cost.
      '--disable-background-timer-throttling',
      '--disable-backgrounding-occluded-windows',
      '--disable-renderer-backgrounding',
    ],
  })

  for (const check of selected) {
    process.stdout.write(`\n\x1b[1;34m=== ${check.name} ===\x1b[0m\n`)
    const started = Date.now()

    if (check.standalone) {
      const code = await new Promise((res) => {
        const p = spawn('node', [check.file], { cwd: root, stdio: 'inherit', env: process.env })
        p.on('exit', (c) => res(c ?? 1))
      })
      const ok = code === 0
      results.push({
        name: check.name,
        ok,
        ms: Date.now() - started,
        err: ok ? undefined : `exited ${code}`,
      })
      console.log(`  ${ok ? '\x1b[1;32mok\x1b[0m' : '\x1b[1;31mFAILED\x1b[0m'} (${((Date.now() - started) / 1000).toFixed(1)}s)`)
      continue
    }

    // A fresh page per check: shared page state is how one check's leftover
    // keyboard or paused clock silently changes the next one's result.
    const page = await browser.newPage({ viewport: { width: 1280, height: 720 } })
    const errors = []
    page.on('pageerror', (e) => errors.push(String(e)))
    let shots = 0
    try {
      await page.goto(`http://localhost:${port}/${check.url}`, { waitUntil: 'load' })
      // What "loaded" means is per check. It defaults to the game handle,
      // because thirteen checks drive the sandbox — but the title screen has no
      // `__game` and never will, and hardcoding one scene's handle here made
      // the harness silently un-runnable for any other screen.
      await page.waitForFunction(check.ready ?? (() => !!window.__game), null, {
        timeout: 60_000,
      })

      const shot = async (name) => {
        await page.screenshot({ path: join(shotsDir, `${name}.png`) })
        shots += 1
        console.log(`  shot: shots/${name}.png`)
      }
      const log = (...a) => console.log(' ', ...a)

      const mod = await import(pathToFileURL(resolve(root, check.file)).href)
      // A check that is not a module would otherwise run its body on import and
      // take the suite with it. Say so, rather than failing three frames deeper.
      if (typeof mod.default !== 'function') {
        throw new Error(
          `${check.file} does not export a default function — mark it \`standalone: true\``,
        )
      }
      await mod.default({ page, shot, log })

      // A page error is a failure even when every assertion passed: an exception
      // in a render path leaves the numbers intact and the picture broken.
      if (errors.length) throw new Error(`page errors:\n${errors.join('\n')}`)
      if (shots === 0) throw new Error('the check wrote no screenshot')

      results.push({ name: check.name, ok: true, ms: Date.now() - started })
      console.log(`  \x1b[1;32mok\x1b[0m (${((Date.now() - started) / 1000).toFixed(1)}s)`)
    } catch (e) {
      // Capture the frame at the moment of failure — on a headless box this is
      // usually the only evidence of what it looked like.
      try {
        await page.screenshot({ path: join(shotsDir, `FAILED-${check.name}.png`) })
        console.log(`  shot: shots/FAILED-${check.name}.png`)
      } catch {
        /* the page may be gone */
      }
      results.push({ name: check.name, ok: false, ms: Date.now() - started, err: e.message })
      console.log(`  \x1b[1;31mFAILED\x1b[0m ${e.message}`)
    } finally {
      await page.close()
    }
  }
} catch (e) {
  console.error(`\nsuite could not start: ${e.message}`)
  results.push({ name: '(startup)', ok: false, ms: 0, err: e.message })
} finally {
  await browser?.close()
  shutdown()
}

const failed = results.filter((r) => !r.ok)
console.log('\n\x1b[1;34m=== e2e summary ===\x1b[0m')
for (const r of results) {
  console.log(`  ${r.ok ? '\x1b[1;32mok  \x1b[0m' : '\x1b[1;31mFAIL\x1b[0m'} ${r.name.padEnd(28)} ${(r.ms / 1000).toFixed(1)}s`)
}
console.log(`  ${results.length - failed.length}/${results.length} passed`)
for (const f of failed) console.log(`\n  ${f.name}: ${f.err}`)

// Did the suite leave anything running? See STRAY_PATTERNS above.
// Stop our own vite FIRST: it is still alive at this point and the `exit`
// handler only reaps it after this code runs, so sampling before shutting down
// counts the suite's own server as a leak. That false positive is the same
// shape as the bugs this guard exists to catch — an assertion that includes
// something it did not mean to.
shutdown()
// Sample twice with a grace window between. A process still winding down from
// `browser.close()` has not leaked — it is exiting — and reporting it would make
// this guard fail on teardown timing rather than on the thing it exists to catch.
// Only pids that survive the grace period count.
let leaked = []
for (let attempt = 0; attempt < 2; attempt++) {
  await new Promise((r) => setTimeout(r, 2000))
  leaked = [...strayPids()].filter(([pid]) => !straysBefore.has(pid))
  if (!leaked.length) break
}
if (leaked.length) {
  const byKind = {}
  for (const [, kind] of leaked) byKind[kind] = (byKind[kind] ?? 0) + 1
  console.log(
    `\n  \x1b[1;31mLEAKED\x1b[0m ${leaked.length} process(es): ` +
      Object.entries(byKind).map(([k, n]) => `${n} ${k}`).join(', '),
  )
  console.log('  These accumulate across runs and slow every later run. See scripts/proc-group.mjs.')
  for (const [pid, kind] of leaked) {
    try {
      process.kill(-pid, 'SIGKILL')
    } catch {
      try {
        process.kill(pid, 'SIGKILL')
      } catch {
        /* already gone */
      }
    }
    console.log(`    killed ${kind} ${pid}`)
  }
}

process.exit(failed.length || leaked.length ? 1 : 0)
