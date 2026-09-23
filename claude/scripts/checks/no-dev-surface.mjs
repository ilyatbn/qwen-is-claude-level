#!/usr/bin/env node
/**
 * T14.08 / §C17 — the dev surface is **compiled out**, not gated.
 *
 *   node scripts/checks/no-dev-surface.mjs
 *   node scripts/e2e.mjs no-dev-surface
 *
 * ## Why this greps the artifact
 *
 * A test that asserts the code sits inside an `if (DEV)` block passes for a build
 * where the eliminator never ran, which is the shape §A15 keeps catching. The
 * only evidence that something is not shipped is that it is **not in the file
 * that ships**. So: build it, read it, grep it.
 *
 * And with a control, because a grep that finds nothing is also what a broken
 * build produces: the `--mode e2e` bundle has to contain every one of the same
 * strings. If it does not, this check is measuring its own build failure.
 *
 * ## Why the query parameters are not in the grep list
 *
 * The first version of this file looked for `preview=1`, `boot=1` and `skins=1`
 * and the **control caught it**: none of the three is a contiguous string in any
 * bundle, because the minifier emits `q.get("preview")==="1"`. Dropping to the
 * bare words is worse, not better — Phaser's own source says `boot` 91 times and
 * `preview` 10, so those greps would fail against a perfectly clean build, and
 * `skins` is a **player** feature that is supposed to ship.
 *
 * So the parameters are asserted the only way that means anything: by loading the
 * production bundle with each of them and looking at what comes up (§C2). The
 * grep list is the identifiers that are unambiguously dev-only.
 *
 * ## This is the deploy path
 *
 * `docker/Dockerfile.client` runs `npm --prefix client run build`, which is
 * `tsc --noEmit && vite build` — the same plain build this file greps. There is no
 * second command that could ship a different bundle.
 */
import { spawn } from 'node:child_process'
import { readFileSync, readdirSync, existsSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { chromePath, chromium, libDir, root, shotsDir, sleep, tally } from './harness.mjs'
import { killGroup, spawnGroup } from '../proc-group.mjs'

const { fail, ok, finish } = tally('no-dev-surface')
const clientDir = join(root, 'client')

/**
 * Every identifier §C17 names, plus the three dev scene classes — a scene that
 * is compiled out has no class name left in the bundle either.
 */
const FORBIDDEN = [
  '__game',
  // Added after both shipped. `__title` (T18.01) and `__menu` (T17.07) were in
  // the production bundle and **this check passed anyway**, because the list was
  // written before either handle existed — the guard whose whole purpose is
  // §C17 could not see the two newest violations of it. A list of names is only
  // as good as its last update, so anything that writes to `window` belongs here
  // the moment it is written.
  '__title',
  '__menu',
  'sandbox',
  'toggleOverlays',
  'regenerate',
  'SandboxScene',
  'PreviewScene',
  'BootScene',
  // The FPS readout's element id — §C17's deliverable names the debug overlays
  // and the FPS counter alongside the scenes.
  'debug-fps',
]

function run(cmd, args, cwd) {
  return new Promise((res, rej) => {
    const p = spawn(cmd, args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] })
    let out = ''
    p.stdout.on('data', (b) => (out += b))
    p.stderr.on('data', (b) => (out += b))
    p.on('exit', (code) => (code === 0 ? res(out) : rej(new Error(`${cmd} ${args.join(' ')} failed:\n${out}`))))
  })
}

/** Every emitted JS chunk, concatenated. */
function bundleText(dir) {
  const assets = join(clientDir, dir, 'assets')
  if (!existsSync(assets)) throw new Error(`${dir} produced no assets/ directory`)
  return readdirSync(assets)
    .filter((f) => f.endsWith('.js'))
    .map((f) => readFileSync(join(assets, f), 'utf8'))
    .join('\n')
}

for (const dir of ['dist', 'dist-e2e']) {
  rmSync(join(clientDir, dir), { recursive: true, force: true })
}

console.log('  building (this is a real production build, not a dev server)')
await run('npx', ['vite', 'build'], clientDir)
await run('npx', ['vite', 'build', '--mode', 'e2e', '--outDir', 'dist-e2e'], clientDir)

const prod = bundleText('dist')
const e2e = bundleText('dist-e2e')
console.log(`  prod ${(prod.length / 1024).toFixed(0)} KB, e2e ${(e2e.length / 1024).toFixed(0)} KB`)

// --- the control first ------------------------------------------------------
//
// If the e2e bundle is missing these, the grep below finds nothing for a reason
// that has nothing to do with §C17 and this check is worthless.
const missingFromE2e = FORBIDDEN.filter((s) => !e2e.includes(s))
if (missingFromE2e.length) {
  fail(
    `the --mode e2e bundle is missing ${missingFromE2e.join(', ')} — the control ` +
      'failed, so a clean production grep would prove nothing',
  )
} else {
  ok(`control: the --mode e2e bundle contains all ${FORBIDDEN.length} of them`)
}

// --- and then the artifact that ships ---------------------------------------
const found = FORBIDDEN.filter((s) => prod.includes(s))
if (found.length) {
  fail(`the production bundle still contains: ${found.join(', ')}`)
} else {
  ok(`a plain \`vite build\` contains none of: ${FORBIDDEN.join(', ')}`)
}

// The dev scenes should not be chunks at all, rather than being present and
// unreachable.
const prodChunks = readdirSync(join(clientDir, 'dist', 'assets')).filter((f) => f.endsWith('.js'))
const devChunks = prodChunks.filter((f) => /Sandbox|Preview|Boot/.test(f))
if (devChunks.length) fail(`the production build emitted dev chunks: ${devChunks.join(', ')}`)
else ok(`no dev scene chunks in the production build (${prodChunks.length} chunk(s))`)

// --- what a person would actually try ---------------------------------------
//
// Serve the production bundle and open it with each dev parameter. Asserted from
// what is on screen (§C2): the title screen comes up every time.
//
// `#start-game` is the title's Start button and `#game-hud` is the in-round HUD,
// so the pair distinguishes "the parameter was ignored" from "the parameter
// worked" *and* from "the bundle threw on boot", which would show neither.
let browser = null
let server = null
try {
  server = spawnGroup('npx', ['vite', 'preview', '--port', '4318', '--strictPort'], {
    cwd: clientDir,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  await new Promise((res, rej) => {
    const on = (b) => {
      if (String(b).includes('4318')) res()
    }
    server.stdout.on('data', on)
    server.stderr.on('data', on)
    setTimeout(() => rej(new Error('vite preview never started')), 60_000)
  })

  browser = await chromium.launch({
    executablePath: chromePath,
    env: { ...process.env, LD_LIBRARY_PATH: libDir },
    args: ['--no-sandbox', '--use-gl=swiftshader', '--enable-unsafe-swiftshader'],
  })
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 } })

  const load = async (query) => {
    await page.goto(`http://localhost:4318/${query}`, { waitUntil: 'load' })
    await page.waitForSelector('canvas', { timeout: 30_000 })
    await sleep(4000)
  }

  await load('?sandbox=1&e2e=1')

  const handle = await page.evaluate(() => typeof window.__game)
  if (handle !== 'undefined') {
    fail(`window.__game is \`${handle}\` in the production bundle`)
  } else {
    ok('window.__game does not exist in the production bundle')
  }

  // The sandbox has a DOM control panel with a "Regenerate" button; the title has
  // none.
  const sandboxPanel = await page.evaluate(() =>
    Boolean([...document.querySelectorAll('button')].find((b) => /regenerate/i.test(b.textContent ?? ''))),
  )
  if (sandboxPanel) {
    fail('`?sandbox=1` reached the sandbox in a production build')
  } else {
    ok('`?sandbox=1` does not reach the sandbox')
  }
  await page.screenshot({ path: join(shotsDir, 'no-dev-surface.png') })

  // ...and it is the title screen rather than a blank page: a build that threw
  // on boot would also have no sandbox panel.
  const titled = await page.evaluate(() => Boolean(document.querySelector('#start-game')))
  if (titled) ok('and the normal title screen is rendering')
  else fail('the production bundle rendered no title screen at all')

  // The parameters the grep cannot see, one load each.
  for (const q of ['preview=1', 'boot=1', 'game=1', 'menu=1', 'skins=1']) {
    await load(`?${q}&e2e=1`)
    const seen = await page.evaluate(() => ({
      title: Boolean(document.querySelector('#start-game')),
      hud: Boolean(document.querySelector('#game-hud')),
    }))
    if (seen.title && !seen.hud) ok(`\`?${q}\` lands on the title screen`)
    else fail(`\`?${q}\` reached something other than the title (${JSON.stringify(seen)})`)
  }
} finally {
  await browser?.close().catch(() => {})
  killGroup(server)
}

await finish()
