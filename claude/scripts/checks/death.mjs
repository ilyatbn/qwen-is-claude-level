#!/usr/bin/env node
/**
 * T10.06 — the death overlay, seen to appear in a running game.
 *
 *   node scripts/checks/death.mjs
 *   node scripts/e2e.mjs death
 *
 * ## Why this check exists as a separate thing
 *
 * The overlay's logic is unit-tested and its wiring reads correct, and that was
 * true for a whole session in which **it had never once been seen on screen**.
 * `docs/70-amendments-v2.md` §A39 is the pattern: five mechanisms on this project
 * were built, unit-tested and never wired, and no unit test can catch that,
 * because a unit test's premise is that it calls the unit itself.
 *
 * ## Why a synthetic `death` event cannot prove it
 *
 * The previous session fed the client a hand-made `death` payload through the
 * real handlers and the overlay stayed down. That was not a bug — it is the
 * design. `DeathOverlay.update` takes `dead` from the **snapshot's** alive flag
 * (§B4: "visibility follows the server's alive flag rather than the countdown
 * reaching zero"), so an injected event that the server never agreed with is
 * correctly ignored. Nothing short of a real death can raise it, which is
 * exactly the property worth having.
 *
 * So this kills the player for real, with their own rocket, and asserts on what
 * the player can see.
 */
import { spawn } from 'node:child_process'
import { mkdirSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { matchVitePort } from '../vite-url.mjs'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const shots = join(root, 'shots')
mkdirSync(shots, { recursive: true })

const require = createRequire(join(root, 'client/package.json'))
const { chromium } = require('playwright-core')

const PORT = 3117
const libDir = join(process.env.HOME ?? '', '.cache/pwlibs/root/usr/lib/x86_64-linux-gnu')
const chromePath = join(
  process.env.HOME ?? '',
  '.cache/ms-playwright/chromium-1234/chrome-linux64/chrome',
)

const kids = []
process.on('exit', () => {
  for (const k of kids) {
    try {
      k.kill('SIGKILL')
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

// No bots: this check is about one player's death, and a bot landing the killing
// blow would change the attribution the cause line is asserted against.
const server = spawn('cargo', ['run', '--quiet', '--release', '-p', 'game-server'], {
  cwd: root,
  env: {
    ...process.env,
    BIND_ADDR: `127.0.0.1:${PORT}`,
    MAP_SCALE: 'small',
    GAME_LOG: 'warn',
    ROUND_SECONDS: '120',
    BOT_COUNT: '0',
    DEV_LOADOUT: '1',
    // 40 health, so two clean rockets kill. The death is still entirely real —
    // fired, resolved by the server, attributed to the player. Only the starting
    // health is arranged, exactly as `world_step`'s unit test arranges 20 before
    // firing once. Without it this check is a coin flip: each blast deepens the
    // crater so the next detonates further below you, and eight rockets against
    // 100 health killed on some runs and left 22 on others.
    DEV_START_HEALTH: '40',
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

/** Poll until `pred(debug())` or the deadline. */
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

// --- the control ----------------------------------------------------------
//
// Before killing anyone: the overlay must be **down** while alive. Without this,
// "the overlay is up after death" also passes for an overlay that is up always
// (§A26 — a test asserting a presence needs the absence, and vice versa).
await until((d) => d.phase === 'playing', 60_000, 'phase playing')
const alive = await dbg()
if (alive.death.visible) fail('the overlay is up while the player is alive')
else ok('control: overlay is down while alive')

// --- kill the player, for real --------------------------------------------
//
// Aim at your own feet and fire. Self-damage is full (`docs/31` §2,
// `SELF_DAMAGE_MULT` 1.0), so this is a real death through the real fire path
// with real attribution — not a debug hook that zeroes health.
//
// Two things blunt a rocket at your own feet, both measured by T9.06: knockback
// throws you (it applies through everything — that is what makes rocket-jumping
// work) and a rocket fired airborne flies off instead of landing; and each blast
// deepens the crater so the next detonates further below you. Stepping sideways
// onto fresh ground before each shot restores the damage.
await page.keyboard.press('Digit1') // the rocket stack
await new Promise((r) => setTimeout(r, 300))
const startHealth = (await dbg()).health
if (startHealth > 60) fail(`DEV_START_HEALTH did not apply: ${startHealth}`)
else ok(`starting on ${startHealth} health`)
let switched = false
//
// Walk **further than the crater** between shots. A bazooka's blast radius is 42,
// so a 260 ms step (~39 px at WALK_SPEED 150) lands the next rocket inside the
// hole the last one dug, where it detonates below your feet for a fraction of the
// damage — measured by T9.06 at ~12 against ~25. 700 ms clears it.
//
// The loop runs to a deadline rather than a fixed count: at 8 rockets and
// variable terrain, a fixed 14 made this a coin flip, and a gate that fails on a
// coin flip gates nothing (§A28).
const killDeadline = Date.now() + 60_000
for (let i = 0; Date.now() < killDeadline; i++) {
  const d = await dbg()
  if (!d.player || d.health <= 0 || d.death.visible) break
  // When the first stack empties, selection moves to the smg — and hitscan
  // excludes its owner (`docs/31` §4), so it cannot self-damage. Take the
  // second rocket stack.
  if (!switched && i >= 3) {
    switched = true
    await page.keyboard.press('Digit3')
    await new Promise((r) => setTimeout(r, 300))
  }
  // Alternate direction so a wall does not trap the walk on one side.
  const dir = i % 2 === 0 ? 'd' : 'a'
  await page.keyboard.down(dir)
  await new Promise((r) => setTimeout(r, 700))
  await page.keyboard.up(dir)
  for (let w = 0; w < 20 && !(await dbg()).player?.grounded; w++) {
    await new Promise((r) => setTimeout(r, 200))
  }
  // The camera follows the player, so a point below mid-screen is below the body
  // in world space whatever the camera has done.
  await page.mouse.move(640, 700)
  await page.evaluate('window.__game.fire()')
  await new Promise((r) => setTimeout(r, 900))
}

const dead = await until((d) => d.death.visible, 12_000, 'the death overlay to appear')
if (dead) {
  ok(`the overlay appeared — cause "${dead.cause ?? dead.death.cause}", health ${startHealth} → 0`)

  // The countdown is the reason §B4 puts `respawn_at` on the wire: a local timer
  // started when the event arrives is late by that event's own latency and stays
  // late. Assert it reads a plausible remaining time rather than a stopped clock.
  const secs = Number(String(dead.death.text).replace(/[^0-9.]/g, ''))
  if (!Number.isFinite(secs) || secs <= 0 || secs > 5.05) {
    fail(`countdown reads "${dead.death.text}", expected 0 < t <= RESPAWN_DELAY (5.0)`)
  } else {
    ok(`countdown reads ${dead.death.text}`)
  }

  if (/killed yourself/i.test(dead.death.cause)) ok(`cause: "${dead.death.cause}"`)
  else fail(`cause reads "${dead.death.cause}", expected the self-kill wording`)

  await page.screenshot({ path: join(shots, 'death-overlay.png') })

  // §B8 — a grave where you fell, and one that is actually drawn.
  //
  // Two numbers, not one (§A39): the mirror's count against the layer's. They
  // were silently different for three milestones in the item layer, and
  // "the server placed a tombstone" passes the whole time.
  const g = await dbg()
  if (g.tombstones >= 1) ok(`the server placed ${g.tombstones} grave(s)`)
  else fail(`no tombstone after a death: ${g.tombstones}`)
  if (g.tombstonesDrawn === g.tombstones) {
    ok(`and all ${g.tombstonesDrawn} are drawn`)
  } else {
    fail(`${g.tombstones} graves tracked but ${g.tombstonesDrawn} drawn`)
  }

  // It is an overlay, not a pause: the world behind it must still be running.
  const t0 = (await dbg()).roundTime
  await new Promise((r) => setTimeout(r, 1200))
  const t1 = (await dbg()).roundTime
  if (t1 > t0 + 0.5) ok(`the round kept running behind it (${t0.toFixed(1)}s → ${t1.toFixed(1)}s)`)
  else fail(`round time did not advance behind the overlay: ${t0} → ${t1}`)

  // The countdown must fall, not sit — a stopped clock also satisfies "0 < t <= 5".
  const later = Number(String((await dbg()).death.text).replace(/[^0-9.]/g, ''))
  if (Number.isFinite(later) && later < secs) ok(`countdown fell ${secs} → ${later}`)
  else if ((await dbg()).death.visible) fail(`countdown did not fall: ${secs} → ${later}`)

  // And it clears on respawn, driven by the server's alive flag.
  const cleared = await until((d) => !d.death.visible, 12_000, 'the overlay to clear on respawn')
  if (cleared) {
    ok('the overlay cleared on respawn')
    if (cleared.health > 0) ok(`respawned with ${cleared.health} health`)
    else fail(`respawned with ${cleared.health} health`)
  }
} else {
  const d = await dbg()
  console.error(`  health ${startHealth} → ${d.health}, alive-flag dead=${!d.death.visible}`)
  await page.screenshot({ path: join(shots, 'FAILED-death.png') })
}

if (pageErrors.length) fail(`page errors: ${pageErrors.join(' | ')}`)
else ok('no page errors')

await browser.close()
console.log(failures.length ? `\ndeath: ${failures.length} FAILED` : '\ndeath: ok')
process.exit(failures.length ? 1 : 0)
