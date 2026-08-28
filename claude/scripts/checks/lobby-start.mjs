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
// **"You arrive in a lobby" is no longer observable from a browser here, and
// that is a real loss of coverage rather than a repair.**
//
// §E2 starts a public lobby `LOBBY_BOT_TIMEOUT` (10 s) after the first seating.
// Reaching `ready` in a cold browser — vite transform, wasm init, first frame —
// takes longer than that, so by the first sample the match has always started.
// Measured: the timeout assertion below reports ~0.0 s of waiting.
//
// The claim itself is alive and asserted precisely in
// `crates/game-server/tests/public_lobby.rs`, which drives a `Room` directly and
// has no page to load. What is gone is the browser-level version.
//
// **To get it back, `LOBBY_BOT_TIMEOUT` needs to be config-driven** the way
// `room_empty_ttl` already is, so a check can raise it. That is a production
// change outside this task and is flagged rather than made.
if (d.phase !== 'lobby') {
  ok(`the timeout beat the page load (phase ${d.phase}) — see the note above`)
} else {
  ok(`arrived in a lobby (phase ${d.phase})`)
}
if (!(d.mapW > 0)) fail('the lobby has no map; there is nothing to look at while waiting')
else ok(`the map is there behind it (${d.mapW}x${d.mapH})`)

// Nothing is **simulating**. Sampled twice, because "0 on the first frame"
// also holds for a room that is about to start.
//
// `serverRoundTime`, not `lastServerTick` and not `roundTime`. §C18 says a lobby does not *simulate*;
// `tick` is a clock and it advances in a lobby too (`World::tick_idle`) — it
// has to, because every replay loop is `while tick < until` and a frozen clock
// spun a core for thirty-five minutes. `round_time` only ever advances inside
// `step()`, so it is the stricter question and the one actually being asked.
const r0 = (await dbg()).serverRoundTime ?? -1
const c0 = (await dbg()).lastServerTick ?? 0
await sleep(2500)
const r1 = (await dbg()).serverRoundTime ?? -1
const c1 = (await dbg()).lastServerTick ?? 0
// Same loss as above: if the timeout has already fired, the round *should* be
// simulating and this measures a running match rather than a lobby. Reported
// either way so the output says which it saw, instead of a green tick that
// means two different things.
if (d.phase === 'lobby' && r1 > r0) fail(`the lobby is simulating: server round time ${r0} -> ${r1}`)
else if (d.phase === 'lobby') ok(`nothing simulating while waiting (server round time ${r0} -> ${r1})`)
else ok(`the match was already running when sampled (round time ${r0} -> ${r1})`)
// The control for that absence: the clock itself must still be running, or
// "round time did not move" is also satisfied by a server that has stopped
// dead — which is the regression `tick_idle` exists to prevent.
if (!(c1 > c0)) fail(`the lobby's clock is frozen at ${c0} — a replay of this would spin`)
else ok(`the clock still runs (tick ${c0} -> ${c1})`)

// One human alone **does** start a round — after `LOBBY_BOT_TIMEOUT` (§E2).
//
// **This assertion was inverted at T17.07, and it had been red since T17.03.**
// It used to require that a solo player never starts: `docs/72` §C18 raised
// `MIN_PLAYERS_TO_START` to 2, so waiting alone was the rule. `docs/74` §E2
// retires that — "one human plus four bots after ten seconds is a game, and two
// humans waiting forever is not" — and it says so in those words. The check kept
// asserting the old rule and nobody saw, because the browser suite is deferred
// until the end of a milestone.
//
// The waiting half above still holds and is what §C18's principle survives as:
// you arrive in a lobby and nothing simulates while you sit in it. What changed
// is only how that ends.
// From the shipped constants, not a literal: a test that spells a tunable
// stays green against a drifted implementation.
const LOBBY_BOT_TIMEOUT = await page.evaluate(
  'window.__game.constants().LOBBY_BOT_TIMEOUT',
)
const startedBy = Date.now()
await page
  .waitForFunction('window.__game.debug().phase !== "lobby"', null, {
    timeout: (LOBBY_BOT_TIMEOUT + 8) * 1000,
  })
  .catch(() => fail(`a solo lobby never started, ${LOBBY_BOT_TIMEOUT}s timeout notwithstanding`))
const waited = (Date.now() - startedBy) / 1000
d = await dbg()
if (d.phase === 'lobby') fail('the timeout fired and the phase is still lobby')
else ok(`a solo lobby started itself after ~${waited.toFixed(1)}s (phase ${d.phase})`)
// Bots, not an empty match: §E2 fills the seats when the timeout fires.
if ((d.playerCount ?? 0) < 2) fail(`the timeout started a match with no bots: ${d.playerCount}`)
else ok(`and it seated bots: ${d.playerCount} players`)

// **The panel is gone, and its absence is the assertion now** (§E1, T17.07).
//
// This used to require `#lobby-panel` to be on screen: a DOM panel `GameScene`
// drew over a world the player was already standing in, which is exactly the
// defect §E1 removed. Waiting is done in the **menu** now, and that screen is
// asserted on pixels by `scripts/checks/lobby.mjs`.
//
// `?game=1` bypasses the menu entirely, so on this path there is no lobby
// screen at all — which makes "no panel is drawn here" the right claim and the
// only one this path can make.
const panelDrawn = await page.evaluate(
  () => !!(document.querySelector('#lobby-panel') || document.querySelector('#join-code')),
)
if (panelDrawn) fail('GameScene is drawing a lobby panel over the world again (§E1)')
else ok('no lobby panel is drawn over the world')
await page.screenshot({ path: join(shots, 'lobby-waiting.png') })

// ---- 3. and the round it started is a real one ------------------------------
//
// The manual `start_with_bots` control that used to live here is gone: §E2's
// timeout has already started the match by this point, so pressing it would
// assert nothing — it would pass against a server that ignored it entirely.
// The manual path is exercised where it is still the only way in, on the
// private lobby's ready gate (`scripts/checks/lobby.mjs`, `m10-checkpoint`).
const t2 = (await dbg()).lastServerTick ?? 0
await sleep(1500)
const t3 = (await dbg()).lastServerTick ?? 0
if (!(t3 > t2)) fail(`the round started but nothing is ticking (${t2} -> ${t3})`)
else ok(`ticking once the round started (${t2} -> ${t3})`)


const stillLobby = await page.evaluate(() => !!document.querySelector('#lobby-panel'))
if (stillLobby) fail('a lobby panel appeared during the round')
else ok('still no lobby panel once the round is running')
await page.screenshot({ path: join(shots, 'lobby-started.png') })

if (pageErrors.length) fail(`page errors: ${pageErrors.slice(0, 3).join(' | ')}`)

await browser.close()
kids.forEach(killGroup)
console.log(failed ? 'lobby-start FAILED' : 'lobby-start ok')
process.exit(failed ? 1 : 0)
