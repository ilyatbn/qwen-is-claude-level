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
import { spawn } from 'node:child_process'
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
    url: '',
    ready: '!!window.__title',
  },
  // Reached through the menu, not at `?skins=1`: the Skins button was a caller
  // with no callee (§A39), and a check that types the URL would not have noticed.
  {
    name: 'skins',
    file: 'scripts/checks/skins.mjs',
    url: '?menu=1',
    ready: '!!window.__menu',
  },
  { name: 'sandbox', file: 'scripts/checks/sandbox.mjs', url: '?sandbox=1&seed=4242' },
  { name: 'wasd', file: 'scripts/checks/wasd.mjs', url: '?sandbox=1&seed=4242' },
  { name: 'sky', file: 'scripts/checks/sky.mjs', url: '?sandbox=1&seed=4242' },
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

// `detached` so this gets its own process group. `npm run dev` forks `vite` as a
// grandchild, and killing npm leaves that grandchild running — ten orphaned vite
// servers were found accumulating on this box, which is itself the "loaded
// machine" that has been blamed for three separate flakes. Killing the group
// kills the grandchild too.
const vite = spawn('npm', ['--prefix', 'client', 'run', 'dev'], {
  detached: true,
  cwd: root,
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

const results = []
let browser

try {
  await portReady
  browser = await chromium.launch({
    executablePath: chromePath,
    env: { ...process.env, LD_LIBRARY_PATH: libDir },
    args: ['--no-sandbox', '--use-gl=swiftshader', '--enable-unsafe-swiftshader'],
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

process.exit(failed.length ? 1 : 0)
