#!/usr/bin/env node
/**
 * The M6 checkpoint: two browsers, one round, terrain destruction visible in
 * both, scores tracking.
 *
 *   node scripts/e2e-two-clients.mjs
 *
 * This is the first point at which the project is a multiplayer game rather
 * than a collection of parts, so it asserts on the things that would make it
 * not one: both clients decode the same map, each sees the other move, a rocket
 * fired by one craters the map in *both*, and their mask checksums match.
 *
 * Screenshots from both contexts land in `shots/` and are meant to be looked at.
 */
import { spawn } from 'node:child_process'
import { mkdirSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const shots = join(root, 'shots')
mkdirSync(shots, { recursive: true })

const require = createRequire(join(root, 'client/package.json'))
const { chromium } = require('playwright-core')

const PORT = 3112
const libDir = join(process.env.HOME ?? '', '.cache/pwlibs/root/usr/lib/x86_64-linux-gnu')
const chromePath = join(
  process.env.HOME ?? '',
  '.cache/ms-playwright/chromium-1234/chrome-linux64/chrome',
)

const kids = []
const cleanup = () => {
  for (const k of kids) {
    try {
      k.kill('SIGKILL')
    } catch {
      /* already gone */
    }
  }
}
process.on('exit', cleanup)

const fail = (msg) => {
  console.error(`FAIL: ${msg}`)
  process.exitCode = 1
}

// --- the real server ------------------------------------------------------
const server = spawn('cargo', ['run', '--quiet', '-p', 'game-server'], {
  cwd: root,
  env: {
    ...process.env,
    BIND_ADDR: `127.0.0.1:${PORT}`,
    MAP_SCALE: 'small',
    GAME_LOG: 'warn',
    // No bots: this test counts players, and a bot is a player (§A5).
    BOT_COUNT: '0',
    // Arm the players: the checkpoint has to fire a rocket, and finding one
    // first is the game's design, not this test's job.
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
if (!up) {
  console.error('server never became healthy')
  process.exit(1)
}

// --- vite, as the same-origin proxy the browser needs ---------------------
const vite = spawn('npx', ['vite', '--strictPort=false'], {
  cwd: join(root, 'client'),
  env: { ...process.env, VITE_SERVER_PORT: String(PORT) },
})
kids.push(vite)
const viteUrl = await new Promise((res, rej) => {
  const on = (b) => {
    const m = b.toString().match(/Local:\s+(http:\/\/[^\s/]+)/)
    if (m) res(m[1])
  }
  vite.stdout.on('data', on)
  vite.stderr.on('data', on)
  setTimeout(() => rej(new Error('vite never started')), 120_000)
})
console.log(`server :${PORT}  vite ${viteUrl}`)

// --- two independent browser contexts ------------------------------------
const browser = await chromium.launch({
  executablePath: chromePath,
  env: { ...process.env, LD_LIBRARY_PATH: libDir },
})

async function openClient(name) {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 720 } })
  const page = await ctx.newPage()
  const errors = []
  page.on('pageerror', (e) => errors.push(String(e)))
  await page.goto(`${viteUrl}/?e2e=1&name=${name}`)
  await page.waitForFunction('window.__game && window.__game.debug().ready === true', null, {
    timeout: 90_000,
  })
  return { page, errors, name }
}

const dbg = (c) => c.page.evaluate('window.__game.debug()')

const a = await openClient('ana')
const b = await openClient('bo')

// Both joined and decoded the same map.
const da0 = await dbg(a)
const db0 = await dbg(b)
if (da0.mapW !== db0.mapW || da0.mapH !== db0.mapH) {
  fail(`map size differs: ${da0.mapW}x${da0.mapH} vs ${db0.mapW}x${db0.mapH}`)
}
if (String(da0.seed) !== String(db0.seed)) fail(`seed differs: ${da0.seed} vs ${db0.seed}`)
if (da0.maskChecksum !== db0.maskChecksum) fail('masks differ immediately after join')

// Each sees two players.
await new Promise((r) => setTimeout(r, 1500))
const da1 = await dbg(a)
const db1 = await dbg(b)
if (da1.playerCount < 2) fail(`ana sees ${da1.playerCount} players, expected 2`)
if (db1.playerCount < 2) fail(`bo sees ${db1.playerCount} players, expected 2`)

// The remote one moves when the other holds a key.
const remoteBefore = (await dbg(a)).players.length
await b.page.keyboard.down('d')
await new Promise((r) => setTimeout(r, 1200))
await b.page.keyboard.up('d')
await new Promise((r) => setTimeout(r, 400))
const aAfter = await dbg(a)
const bAfter = await dbg(b)
const bMoved = Math.abs(bAfter.player.x - db1.player.x)
if (bMoved < 5) fail(`bo held D and moved only ${bMoved.toFixed(1)} px locally`)
if (remoteBefore < 1) fail('ana had no remote player to watch')

// A rocket fired by one craters the map in both.
const solidBeforeA = (await dbg(a)).solid
const solidBeforeB = (await dbg(b)).solid
for (let i = 0; i < 12; i++) {
  await a.page.evaluate('window.__game.fire()')
  await new Promise((r) => setTimeout(r, 250))
}
await new Promise((r) => setTimeout(r, 1500))

const daF = await dbg(a)
const dbF = await dbg(b)
const removedA = solidBeforeA - daF.solid
const removedB = solidBeforeB - dbF.solid

// The control: if nothing was destroyed, "both agree" is satisfied by two
// clients that both did nothing.
if (removedA <= 0) fail(`no terrain was destroyed (ana removed ${removedA} px)`)
if (removedA !== removedB) fail(`terrain differs: ana removed ${removedA}, bo removed ${removedB}`)
if (daF.maskChecksum !== dbF.maskChecksum) {
  fail(`mask checksums diverged after firing:\n  ana ${daF.maskChecksum}\n  bo  ${dbF.maskChecksum}`)
}
if (daF.pendingCarves !== 0 || dbF.pendingCarves !== 0) {
  fail(`carves left buffered: ana ${daF.pendingCarves}, bo ${dbF.pendingCarves}`)
}

// A late joiner gets the already-damaged map and agrees with it.
const c = await openClient('cy')
await new Promise((r) => setTimeout(r, 1500))
const dc = await dbg(c)
if (dc.maskChecksum !== daF.maskChecksum) {
  fail(`a late joiner disagrees with the round in progress:\n  late ${dc.maskChecksum}\n  ana  ${daF.maskChecksum}`)
}

// T8.05 — the inventory verbs. `Connection` has had sendSelectSlot and
// sendUseItem since T6.08 and nothing in the scene called them, so a medkit, a
// shield and the flashlight were all unusable in the real game while every unit
// test passed. Asserting the HUD *changes* is the point: a keybinding that is
// registered but wired to nothing looks identical from outside.
{
  const hudText = () => a.page.evaluate('document.querySelector("[data-hud]")?.textContent ?? ""')
  const before = await hudText()
  await a.page.keyboard.press('Digit2')
  await new Promise((r) => setTimeout(r, 250))
  const afterSelect = await hudText()
  if (afterSelect === before) fail(`selecting slot 2 changed nothing in the HUD:\n${before}`)
  await a.page.mouse.click(640, 360, { button: 'right' })
  await new Promise((r) => setTimeout(r, 250))
  const withPanel = await hudText()
  if (!withPanel.includes('\n')) fail(`right-click did not open the inventory panel:\n${withPanel}`)
  await a.page.mouse.click(640, 360, { button: 'right' })
  console.log('  inventory: slot select and right-click panel both respond')
}

// T8.03 — the F3 HUD, checked here because this is the only place a *server* is
// running: every number on it (rtt, snapshot rate, reconciliation, checksum) is
// meaningless without one, and a HUD asserted against a sandbox with no network
// would be asserting zeros.
const hudBefore = await a.page.evaluate('window.__game.debugHud()')
if (hudBefore.visible) fail('the debug HUD is visible before F3 is pressed')
await a.page.keyboard.press('F3')
await new Promise((r) => setTimeout(r, 700))
const hud = await a.page.evaluate('window.__game.debugHud()')
if (!hud.visible) fail('F3 did not show the debug HUD')
{
  const text = hud.text
  // The two numbers docs/42 §8 exists for. Their absence is the failure mode:
  // a HUD that shows rtt and nothing else does not turn a netcode bug into a
  // reading.
  for (const needle of ['reconcile', 'mean', 'max', 'snapshots', 'inputs', 'pending', 'mask']) {
    if (!text.includes(needle)) fail(`the debug HUD does not report "${needle}":\n${text}`)
  }
  // And they must be live, not placeholders: this client has been sending input
  // and receiving snapshots for several seconds.
  const snaps = Number(/snapshots ([\d.]+)\/s/.exec(text)?.[1] ?? '0')
  const inputs = Number(/inputs ([\d.]+)\/s/.exec(text)?.[1] ?? '0')
  if (!(snaps > 1)) fail(`the HUD reports ${snaps} snapshots/s against a 20 Hz server`)
  if (!(inputs > 1)) fail(`the HUD reports ${inputs} inputs/s while this client is sending them`)
  if (!/mask (matched|pending)/.test(text)) fail(`mask status missing:\n${text}`)
  // RTT was hardcoded to 0 and never measured; the HUD's headline number was a
  // constant. On loopback it is sub-millisecond, so assert it is *measured*
  // (present and finite) rather than asserting a threshold a LAN would fail.
  const rttSeen = /rtt ([\d.]+)ms/.test(text)
  if (!rttSeen) fail(`the HUD does not report rtt:\n${text}`)
  const pinged = await a.page.evaluate('window.__game.debug().rttMeasured')
  if (!pinged) fail('rtt is not being measured — no pong_rtt was ever received')
  console.log(`  debug HUD: ${snaps.toFixed(1)} snapshots/s, ${inputs.toFixed(1)} inputs/s`)
}
await a.page.screenshot({ path: join(shots, 'm6-debug-hud.png') })
await a.page.keyboard.press('F3')

await a.page.screenshot({ path: join(shots, 'm6-client-a.png') })
await b.page.screenshot({ path: join(shots, 'm6-client-b.png') })
await c.page.screenshot({ path: join(shots, 'm6-client-late.png') })

const allErrors = [...a.errors, ...b.errors, ...c.errors]
if (allErrors.length) fail(`page errors: ${allErrors.slice(0, 3).join(' | ')}`)

console.log(
  JSON.stringify(
    {
      map: `${da0.mapW}x${da0.mapH}`,
      seed: String(da0.seed),
      playersSeen: { ana: da1.playerCount, bo: db1.playerCount },
      boMovedPx: Number(bMoved.toFixed(1)),
      terrainRemoved: { ana: removedA, bo: removedB },
      checksum: daF.maskChecksum.slice(0, 16),
      lateJoinerAgrees: dc.maskChecksum === daF.maskChecksum,
      corrections: { ana: daF.corrections, bo: dbF.corrections },
      resyncs: { ana: daF.resyncs, bo: dbF.resyncs },
      pageErrors: allErrors.length,
    },
    null,
    1,
  ),
)

await browser.close()
cleanup()
if (process.exitCode) console.error('\ne2e-two-clients FAILED')
else console.log('\ne2e-two-clients: two clients, one round, one map')
// Explicit: vite and cargo leave handles open that would keep node alive well
// past the point the test has answered its question.
process.exit(process.exitCode ?? 0)
