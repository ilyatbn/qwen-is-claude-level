#!/usr/bin/env node
/**
 * T11.10 — the ordnance the server narrates is actually on screen.
 *
 *   node scripts/checks/ordnance.mjs
 *   node scripts/e2e.mjs ordnance
 *
 * ## Why
 *
 * `melee`, `cone`, `mine_placed`, `mine_ended` and three `hazard_spawn` kinds
 * have been emitted since T11.05–T11.08 with **nothing subscribing**. §A39, tenth
 * instance. The design names the consequence directly:
 *
 * - §B6: "a mine must be visible at close range — invisible instant death is not
 *   fun; a trap you could have spotted is."
 * - §B21: heavy fog ran for five milestones and changed nothing visible, because
 *   its tests all asserted the *formula* returned the right number and nothing
 *   asserted the number reached the screen. This is the other half of that.
 *
 * ## What it asserts, and why it is two numbers
 *
 * The client's live-mine count against the **server's own narration** (placed
 * minus ended). One number — "the server placed a mine" — passes for the whole
 * period the bug existed. Those two were silently different for world items for
 * three milestones (§A39).
 */

import { spawn } from 'node:child_process'
import { mkdirSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { matchVitePort } from '../vite-url.mjs'
import { killGroup } from '../proc-group.mjs'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const shots = join(root, 'shots')
mkdirSync(shots, { recursive: true })

const require = createRequire(join(root, 'client/package.json'))
const { chromium } = require('playwright-core')

const PORT = 3121
const libDir = join(process.env.HOME ?? '', '.cache/pwlibs/root/usr/lib/x86_64-linux-gnu')
const chromePath = join(
  process.env.HOME ?? '',
  '.cache/ms-playwright/chromium-1234/chrome-linux64/chrome',
)

const kids = []
process.on('exit', () => {
  for (const k of kids) {
    try {
      killGroup(k)
    } catch {
      /* already gone */
    }
  }
})

const failures = []
const fail = (m) => {
  console.error(`  FAIL: ${m}`)
  failures.push(m)
}
const ok = (m) => console.log(`  ok   ${m}`)

// No bots: a bot swinging or placing its own mine would make the counts
// ambiguous about whose ordnance is being asserted.
const server = spawn('cargo', ['run', '--quiet', '--release', '-p', 'game-server'], {
  detached: true,
  cwd: root,
  env: {
    ...process.env,
    BIND_ADDR: `127.0.0.1:${PORT}`,
    MAP_SCALE: 'small',
    GAME_LOG: 'warn',
    ROUND_SECONDS: '180',
    BOT_COUNT: '0',
    DEV_LOADOUT: '1',
  },
  stdio: ['ignore', 'inherit', 'inherit'],
})
kids.push(server)

let up = false
for (let i = 0; i < 900 && !up; i++) {
  try {
    up = (await fetch(`http://127.0.0.1:${PORT}/healthz`)).ok
  } catch {
    /* not listening yet */
  }
  if (!up) await new Promise((r) => setTimeout(r, 250))
}
if (!up) {
  console.error('server never became healthy')
  process.exit(1)
}

const vite = spawn('npx', ['vite', '--strictPort=false'], {
  detached: true,
  cwd: join(root, 'client'),
  env: { ...process.env, VITE_SERVER_PORT: String(PORT) },
})
kids.push(vite)
const viteUrl = await new Promise((res, rej) => {
  const on = (b) => {
    const port = matchVitePort(b)
    if (port) res(`http://localhost:${port}`)
  }
  vite.stdout.on('data', on)
  vite.stderr.on('data', on)
  setTimeout(() => rej(new Error('vite never started')), 120_000)
})

const browser = await chromium.launch({
  executablePath: chromePath,
  env: { ...process.env, LD_LIBRARY_PATH: libDir },
  args: ['--no-sandbox', '--use-gl=swiftshader', '--enable-unsafe-swiftshader'],
})
const ctx = await browser.newContext({ viewport: { width: 1280, height: 720 } })
const page = await ctx.newPage()
const pageErrors = []
page.on('pageerror', (e) => pageErrors.push(String(e)))
await page.goto(`${viteUrl}/?e2e=1&game=1&name=ana`)
await page.waitForFunction('window.__game && window.__game.debug().ready === true', null, {
  timeout: 90_000,
})
const dbg = () => page.evaluate('window.__game.debug()')

async function until(pred, deadlineMs, what) {
  const started = Date.now()
  for (;;) {
    const d = await dbg()
    if (pred(d)) return d
    if (Date.now() - started > deadlineMs) {
      fail(`timed out waiting for ${what}`)
      return null
    }
    await new Promise((r) => setTimeout(r, 200))
  }
}

const settle = (ms) => new Promise((r) => setTimeout(r, ms))
/** Fire whatever is selected, aiming at a screen point. */
async function fireAt(sx, sy) {
  await page.mouse.move(sx, sy)
  // The aim is sampled from the pointer in the update loop, so a fire issued in
  // the same turn as the move can use the previous angle.
  await settle(120)
  await page.evaluate('window.__game.fire()')
}

/**
 * Fire until it demonstrably lands, or give up.
 *
 * `fire_ready_at` is per **player**, not per weapon — deliberately, so swapping
 * weapons cannot bypass a cooldown. A check that fires once right after another
 * weapon is therefore rejected silently, which is what made the first version of
 * this flaky at roughly one run in three. Retry on the *effect*, not the attempt.
 */
async function fireUntil(sx, sy, pred, deadlineMs, what) {
  const started = Date.now()
  for (;;) {
    if (pred(await dbg())) return true
    if (Date.now() - started > deadlineMs) {
      fail(`timed out waiting for ${what}`)
      return false
    }
    await fireAt(sx, sy)
    await settle(400)
  }
}

await until((d) => d.phase === 'playing', 60_000, 'phase playing')

// --- the control ----------------------------------------------------------
//
// Nothing has been fired yet, so nothing should be drawn. Without this,
// "a mine is drawn after placing one" also passes for a layer that draws a mine
// unconditionally (§A26).
const before = await dbg()
if (before.minesDrawn === 0 && before.swings === 0 && before.jets === 0) {
  ok('control: nothing drawn before anything is fired')
} else {
  fail(
    `something was already drawn: mines ${before.minesDrawn}, swings ${before.swings}, jets ${before.jets}`,
  )
}

// --- melee: a swing you can see -------------------------------------------
//
// The axe is slot 5 (bazooka / smg / bazooka / mine / axe / flamethrower /
// molotov — appended, never inserted, so the hotkeys other checks press stay put).
await page.keyboard.press('Digit5')
await settle(300)
await fireAt(900, 400)
await settle(400)
const swung = await until((d) => d.swings > 0, 8000, 'a melee swing to arrive')
if (swung) ok(`melee: ${swung.swings} swing(s) received and drawn`)

// --- flamethrower: a jet, and a light ---------------------------------------
await page.keyboard.press('Digit6')
await settle(300)
for (let i = 0; i < 6; i++) {
  await fireAt(900, 420)
  await settle(120)
}
const sprayed = await until((d) => d.jets > 0, 8000, 'a flame jet to arrive')
if (sprayed) ok(`cone: ${sprayed.jets} jet(s) received and drawn`)

// --- the mine, counted at both ends ----------------------------------------
//
// This is the assertion whose absence let the whole thing ship. The client's
// live count must equal the server's narration: placed minus ended.
//
// No walking anywhere in here. Earlier versions stepped off the mine to
// photograph it and stepped back to blow it up, and spent three runs proving
// that a check doing platforming walks into a wall (x=16) or falls off a ledge
// (mine 200 px overhead). None of it was needed: the fx layer draws at
// DEPTH.particles, above DEPTH.actors, so a mine at your feet is drawn over your
// own sprite and is visible without moving at all.
await page.keyboard.press('Digit4')
await settle(300)
await fireUntil(640, 700, (d) => d.minesPlaced > 0, 20_000, 'a mine to be placed')
const placed = (await dbg()).minesPlaced > 0 ? await dbg() : null
if (placed) {
  const expect = placed.minesPlaced - placed.minesEnded
  if (placed.minesDrawn === expect) {
    ok(
      `mine: server says ${placed.minesPlaced} placed - ${placed.minesEnded} ended, client draws ${placed.minesDrawn}`,
    )
  } else {
    fail(
      `mine count disagrees: server ${placed.minesPlaced}-${placed.minesEnded}=${expect}, client draws ${placed.minesDrawn}`,
    )
  }
  await page.screenshot({ path: join(shots, 'ordnance-mine.png') })
}

// --- a hazard on the ground -------------------------------------------------
//
// A molotov leaves fire, which is a hazard the server narrates and (until now)
// nothing drew. Assert on hazards *drawn*, not on `hazard_spawn` being counted —
// counting was already happening and was exactly the bug.
await page.keyboard.press('Digit7')
await settle(300)
await fireAt(900, 500)
await settle(1200)
const burnt = await until((d) => d.hazardsDrawn > 0, 10_000, 'a hazard to be drawn')
if (burnt) {
  // §B15: read the field that exists. The first version of this line printed
  // `burnt.hazards` — top-level, where the counter is not — and rendered
  // "server announced undefined". A log line is forgiving about that; an
  // assertion is not, because every comparison against `undefined` is quietly
  // false and reads exactly like a pass.
  const announced = burnt.observed?.hazards
  if (typeof announced !== 'number') {
    fail(`observed.hazards is ${announced} — the check is reading a field that does not exist`)
  } else if (burnt.hazardsDrawn > announced) {
    fail(`drew ${burnt.hazardsDrawn} hazards but the server only announced ${announced}`)
  } else {
    ok(`hazard: ${burnt.hazardsDrawn} zone(s) drawn of ${announced} announced`)
  }
}

await page.screenshot({ path: join(shots, 'ordnance-hazard.png') })


// --- and the mine must go away again ---------------------------------------
//
// §B6 makes mines destructible "because that is what stops a map filling up
// with them", and T11.07 found `destroy_in_blast` had no production caller at
// all. A layer that adds and never removes passes every "is it drawn" check
// while leaving ghosts on the map forever. Last, because rocketing your own
// feet costs health and craters the ground the earlier steps stand on.
if (placed) {
  // Mines ignore their owner (§B6), so standing on one is safe, and a rocket
  // straight down certainly puts the 42 px blast over it.
  await page.keyboard.press('Digit1')
  await settle(300)
  // Deadlines with headroom, not fixed sleeps. `fireUntil` and `until` already
  // wait on the *effect*; the deadline only bounds how long a genuinely stuck
  // run may hang. Under a loaded box the client steps fewer fixed-timestep ticks
  // per wall-clock second, so 25 s was enough standalone and not enough after
  // three other specs — which is how this read as flaky rather than as slow.
  await fireUntil(640, 700, (d) => d.minesEnded > 0, 60_000, 'the rocket to end the mine')
  const gone = await until(
    (d) => d.minesDrawn === d.minesPlaced - d.minesEnded && d.minesEnded > 0,
    20_000,
    'the mine to leave the layer',
  )
  if (gone) {
    ok(
      `mine removed: ${gone.minesPlaced} placed, ${gone.minesEnded} ended, ${gone.minesDrawn} drawn`,
    )
  }
}
if (pageErrors.length) fail(`page errors: ${pageErrors.join(' | ')}`)
else ok('no page errors')

await browser.close()
console.log(failures.length ? `\nordnance: ${failures.length} FAILED` : '\nordnance: ok')
process.exit(failures.length ? 1 : 0)
