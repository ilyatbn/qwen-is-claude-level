#!/usr/bin/env node
/**
 * The M10 checkpoint: two browsers, one creates a private game and the other
 * joins by the code **read off the screen**, while a third runs quick match —
 * all three rounds at once.
 *
 *   node scripts/checks/m10-checkpoint.mjs
 *
 * The code is read from the DOM rather than from the socket on purpose. The
 * whole point of a private game is that a human can read six characters aloud,
 * and a check that takes the code off the wire proves the server knows it, not
 * that anyone can see it. That distinction is not hypothetical here: nothing
 * subscribed to `room_created` at all, so creating a private game never showed
 * anyone the code, and every unit test passed.
 *
 * The strongest assertion is the negative one (§B1): a rocket fired in the
 * private room must crater it in *both* of its clients and leave the
 * quick-match room's terrain untouched. Rooms that leak into each other is the
 * multi-room form of the inventory leak in `docs/30` §6.
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

const PORT = 3114
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

const log = (m) => console.log(`  ${m}`)
const die = (m) => {
  console.error(`  FAILED ${m}`)
  process.exit(1)
}

// --- server ---------------------------------------------------------------
const server = spawn('cargo', ['run', '--quiet', '-p', 'game-server'], {
  cwd: root,
  env: {
    ...process.env,
    BIND_ADDR: `127.0.0.1:${PORT}`,
    MAP_SCALE: 'small',
    GAME_LOG: 'warn',
    // No bots: this counts players, and a bot is a player (§A5).
    BOT_COUNT: '0',
    DEV_LOADOUT: '1',
  },
  stdio: ['ignore', 'inherit', 'inherit'],
})
kids.push(server)

let up = false
for (let i = 0; i < 600 && !up; i++) {
  try {
    up = (await fetch(`http://127.0.0.1:${PORT}/healthz`)).ok
  } catch {
    /* not listening yet */
  }
  if (!up) await new Promise((r) => setTimeout(r, 250))
}
if (!up) die('server never became healthy')

// --- vite -----------------------------------------------------------------
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
log(`server :${PORT}  vite ${viteUrl}`)

const browser = await chromium.launch({
  executablePath: chromePath,
  env: { ...process.env, LD_LIBRARY_PATH: libDir },
})

/** A browser that starts at the menu, as a player does. */
async function openAtMenu(name) {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 720 } })
  const page = await ctx.newPage()
  const errors = []
  page.on('pageerror', (e) => errors.push(String(e)))
  await page.goto(`${viteUrl}/?e2e=1&menu=1&name=${name}`)
  await page.waitForFunction('!!window.__menu', null, { timeout: 60_000 })
  await page.evaluate((n) => localStorage.setItem('deepcut.name', n), name)
  return { page, errors, name }
}

const inGame = (c) =>
  c.page.waitForFunction('window.__game && window.__game.debug().ready === true', null, {
    timeout: 90_000,
  })
const dbg = (c) => c.page.evaluate('window.__game.debug()')

// --- host creates a private room -----------------------------------------
const host = await openAtMenu('ana')
await host.page.evaluate(() => document.querySelector('#create')?.click())
await inGame(host)

// Read the six characters the way a person would: off the screen.
await host.page.waitForFunction(
  'window.__game.debug().visibleCode && window.__game.debug().visibleCode.length === 6',
  null,
  { timeout: 30_000 },
)
const code = (await dbg(host)).visibleCode
if (!/^[A-HJ-NP-Z2-9]{6}$/.test(code)) die(`the code on screen is not a code: "${code}"`)
log(`host sees code ${code}`)

// --- guest joins by that code --------------------------------------------
const guest = await openAtMenu('bo')
await guest.page.evaluate((c) => {
  document.querySelector('#join')?.click()
  const input = document.querySelector('#code')
  input.value = c
  input.dispatchEvent(new Event('input', { bubbles: true }))
  document.querySelector('#go')?.click()
}, code)
await inGame(guest)

// --- a third player quick-matches into a different room -------------------
const solo = await openAtMenu('cy')
await solo.page.evaluate(() => document.querySelector('#quick')?.click())
await inGame(solo)

/** Wait for the roster rather than sampling once: the count arrives with the
 *  first snapshot, so reading it immediately after `ready` races it. */
const expectPlayers = async (c, n) => {
  await c.page
    .waitForFunction(`window.__game.debug().playerCount === ${n}`, null, { timeout: 20_000 })
    .catch(async () => {
      const got = (await dbg(c)).playerCount
      die(`${c.name} should see ${n} players, sees ${got}`)
    })
}
await expectPlayers(host, 2)
await expectPlayers(guest, 2)
await expectPlayers(solo, 1)

const [dh, dg, ds] = [await dbg(host), await dbg(guest), await dbg(solo)]
// Room identity is the *mask*, not `debug().seed` — that field is the client's
// own core placeholder, because a client decodes the mask over the wire rather
// than regenerating it from a seed. It reads `1` in every room, so asserting on
// it would have compared two constants and passed on any build.
if (dh.maskChecksum !== dg.maskChecksum) {
  die(`host and guest hold different maps (${dh.maskChecksum} vs ${dg.maskChecksum})`)
}
if (ds.maskChecksum === dh.maskChecksum) {
  die('the quick-match room has the same map as the private one — rooms are not seeded apart')
}
log(`private room ${dh.maskChecksum.slice(0, 12)} (2 players)`)
log(`quick-match room ${ds.maskChecksum.slice(0, 12)} (1 player)`)

// --- all three rounds are running at once ---------------------------------
// `lastServerTick`, not `tick` — there is no `tick` on this handle, and reading
// one would compare undefined against undefined, which is false forever. An
// assertion that cannot fail is not an assertion (§B11).
const tickOf = (d) => d.lastServerTick
const before = [dh, dg, ds].map(tickOf)
for (const [i, name] of ['ana', 'bo', 'cy'].entries()) {
  if (!Number.isFinite(before[i])) die(`${name} reports no server tick at all`)
}
await new Promise((r) => setTimeout(r, 1500))
const after = [await dbg(host), await dbg(guest), await dbg(solo)].map(tickOf)
for (const [i, name] of ['ana', 'bo', 'cy'].entries()) {
  if (after[i] <= before[i]) die(`${name}'s room is not ticking (${before[i]} → ${after[i]})`)
}
log(`three rounds ticking at once: ${before.join('/')} → ${after.join('/')}`)

// --- the negative: rooms do not leak into each other ----------------------
const soloSolidBefore = (await dbg(solo)).solid
// Fire the way full-round does: select the rocket stack, aim below mid-screen
// (the camera follows the player, so that is below the body in world space
// whatever the camera has done) and shoot.
await host.page.keyboard.press('Digit1')
await new Promise((r) => setTimeout(r, 300))
await host.page.mouse.move(640, 700)
for (let i = 0; i < 4; i++) {
  await host.page.mouse.down()
  await new Promise((r) => setTimeout(r, 80))
  await host.page.mouse.up()
  await new Promise((r) => setTimeout(r, 500))
}
await new Promise((r) => setTimeout(r, 1500))

const [ah, ag, as_] = [await dbg(host), await dbg(guest), await dbg(solo)]
if (ah.solid >= dh.solid) die('the host fired and its own terrain did not change')
if (ag.maskChecksum !== ah.maskChecksum) {
  die(`the two clients in one room disagree: ${ah.maskChecksum} vs ${ag.maskChecksum}`)
}
log(`host carved ${dh.solid - ah.solid} px; guest agrees (${ah.maskChecksum})`)

if (as_.solid !== soloSolidBefore) {
  die(`the other room's terrain changed: ${soloSolidBefore} → ${as_.solid}`)
}
log(`the quick-match room is untouched (${as_.solid} px)`)

for (const c of [host, guest, solo]) {
  await c.page.screenshot({ path: join(shots, `m10-${c.name}.png`) })
  if (c.errors.length) die(`${c.name} had page errors: ${c.errors[0]}`)
}
log('shots: shots/m10-ana.png, m10-bo.png, m10-cy.png')

await browser.close()
console.log('  ok')
process.exit(0)
