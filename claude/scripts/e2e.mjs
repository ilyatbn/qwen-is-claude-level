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
  { name: 'perf', file: 'scripts/checks/perf.mjs', url: '?sandbox=1&seed=4242' },
  // Standalone: it launches its own vite and browser and calls `process.exit`.
  // Imported into this process it would terminate the suite mid-run — and exit 0
  // while doing it, hiding every earlier failure. Run as a subprocess instead.
  { name: 'm5-weather', file: 'scripts/checks/m5-weather.mjs', standalone: true },
  // The M6 checkpoint: two browser contexts, one server, one round. Standalone
  // because it needs a real game-server and two clients rather than the sandbox.
  { name: 'two-clients', file: 'scripts/e2e-two-clients.mjs', standalone: true },
]

const filters = process.argv.slice(2)
const selected = filters.length
  ? CHECKS.filter((c) => filters.some((f) => c.name.includes(f)))
  : CHECKS
if (!selected.length) {
  console.error(`no checks match ${filters.join(', ')}`)
  console.error(`available: ${CHECKS.map((c) => c.name).join(', ')}`)
  process.exit(2)
}

const require = createRequire(join(root, 'client/package.json'))
const { chromium } = require('playwright-core')

const vite = spawn('npm', ['--prefix', 'client', 'run', 'dev'], {
  cwd: root,
  env: { ...process.env, LD_LIBRARY_PATH: libDir },
})

let port = null
const portReady = new Promise((res, rej) => {
  const onData = (b) => {
    const m = b.toString().match(/localhost:(\d+)/)
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
    vite.kill('SIGTERM')
  } catch {
    /* already gone */
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
      await page.waitForFunction(() => !!window.__game, null, { timeout: 60_000 })

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
