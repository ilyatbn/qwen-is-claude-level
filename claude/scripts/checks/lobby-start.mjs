#!/usr/bin/env node
/**
 * T13.06.1 — no battle exists until players ask for one (`docs/72` §C18).
 *
 *   node scripts/checks/lobby-start.mjs
 *   node scripts/e2e.mjs lobby-start
 *
 * ## The bug, as reported
 *
 * "Every time I join a game now I join an already active battle." A room was
 * created at **server startup**, seated bots and began ticking — map, timers,
 * scoring, items, weather. There was nowhere to arrive except mid-round.
 *
 * ## What this asserts, and its controls
 *
 * A fresh server has no rooms; connecting puts you in a **lobby** with a map
 * behind it and nothing simulating; and — the control — pressing "Start with
 * bots" does start a real round. Without that last half, "you are not in a
 * battle" also passes for a server that can never start one, which would be a
 * worse bug than the one being fixed.
 *
 * `MIN_PLAYERS_TO_START` is left at its default of 2 here **on purpose**: the
 * point is that one human alone does not begin a battle.
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
let failed = false
const fail = (m) => {
  console.error(`FAIL: ${m}`)
  failed = true
}
const ok = (m) => console.log(`  ok   ${m}`)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
process.on('exit', () => kids.forEach(killGroup))

const server = spawn('cargo', ['run', '-q', '-p', 'game-server', '--release'], {
  detached: true,
  cwd: root,
  env: {
    ...process.env,
    BIND_ADDR: `127.0.0.1:${PORT}`,
    MAP_SCALE: 'small',
    BOT_COUNT: '3',
    GAME_LOG: 'warn',
  },
  stdio: ['ignore', 'inherit', 'inherit'],
})
kids.push(server)

let health = null
for (let i = 0; i < 900 && !health; i++) {
  try {
    const r = await fetch(`http://127.0.0.1:${PORT}/healthz`)
    if (r.ok) health = await r.json()
  } catch {
    /* not listening yet */
  }
  if (!health) await sleep(250)
}
if (!health) {
  console.error('server never became healthy')
  process.exit(1)
}

// ---- 1. a fresh server is empty -------------------------------------------
if (health.rooms !== 0) {
  fail(`a fresh server already has ${health.rooms} room(s) — there is a battle nobody asked for`)
} else {
  ok(`fresh server: rooms ${health.rooms}, players ${health.players}`)
}

// And it stays empty: nothing creates a room on a timer.
await sleep(3000)
const idle = await (await fetch(`http://127.0.0.1:${PORT}/healthz`)).json()
if (idle.rooms !== 0) fail(`a room appeared on its own after 3 s: ${idle.rooms}`)
else ok('still empty after 3 s idle')

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
  timeout: 120_000,
})

// ---- 2. you arrive in a lobby, not a battle --------------------------------
const dbg = () => page.evaluate('window.__game.debug()')
let d = await dbg()
if (d.phase !== 'lobby') {
  fail(`connected straight into phase "${d.phase}" — the bug as reported`)
} else {
  ok(`arrived in a lobby (phase ${d.phase})`)
}
if (!(d.mapW > 0)) fail('the lobby has no map; there is nothing to look at while waiting')
else ok(`the map is there behind it (${d.mapW}x${d.mapH})`)

// Nothing is simulating. Sampled twice, because "tick 0" on the first frame
// also holds for a room that is about to start.
const t0 = (await dbg()).lastServerTick ?? 0
await sleep(2500)
const t1 = (await dbg()).lastServerTick ?? 0
if (t1 > t0) fail(`the lobby is simulating: server tick ${t0} -> ${t1}`)
else ok(`nothing ticking while waiting (tick ${t0} -> ${t1})`)

// One human alone must not start a round — past the countdown, twice over.
await sleep(7000)
d = await dbg()
if (d.phase !== 'lobby') fail(`one human alone started a battle (phase ${d.phase})`)
else ok('one human alone still waiting after 2x the countdown')

const lobbyVisible = await page.evaluate(() => {
  const el = document.querySelector('#lobby-panel')
  if (!el) return false
  const r = el.getBoundingClientRect()
  const st = getComputedStyle(el)
  return r.width > 0 && r.height > 0 && st.display !== 'none' && Number(st.opacity) > 0.1
})
if (!lobbyVisible) fail('the lobby panel is not on screen — the player is waiting with no idea why')
else ok('lobby panel is visible')
await page.screenshot({ path: join(shots, 'lobby-waiting.png') })

// ---- 3. the control: asking does start it ----------------------------------
await page.click('#lobby-start')
await sleep(3000)
d = await dbg()
if (d.phase === 'lobby') {
  fail('"Start with bots" did nothing — the solo path is broken')
} else {
  ok(`start with bots -> phase ${d.phase}`)
}
const t2 = (await dbg()).lastServerTick ?? 0
await sleep(1500)
const t3 = (await dbg()).lastServerTick ?? 0
if (!(t3 > t2)) fail(`the round started but nothing is ticking (${t2} -> ${t3})`)
else ok(`ticking once the round started (${t2} -> ${t3})`)
if ((d.playerCount ?? 0) < 2) fail(`no bots were seated: playerCount ${d.playerCount}`)
else ok(`bots seated on start: ${d.playerCount} players`)

const stillLobby = await page.evaluate(() => !!document.querySelector('#lobby-panel'))
if (stillLobby) fail('the lobby panel is still up during the round')
else ok('lobby panel cleared when the round started')
await page.screenshot({ path: join(shots, 'lobby-started.png') })

if (pageErrors.length) fail(`page errors: ${pageErrors.slice(0, 3).join(' | ')}`)

await browser.close()
kids.forEach(killGroup)
console.log(failed ? 'lobby-start FAILED' : 'lobby-start ok')
process.exit(failed ? 1 : 0)
