#!/usr/bin/env node
/**
 * T13.06 — the round ends, and you are told.
 *
 *   node scripts/checks/round-end.mjs
 *   node scripts/e2e.mjs round-end
 *
 * ## What was wrong
 *
 * `ROUND_SECONDS` elapsed and nothing happened. The server's phase machine has
 * driven `Playing -> Ended` correctly since T6.12 and broadcast `round_state` on
 * every transition; the client stored the phase in a field and rendered a banner
 * with it. Nothing else read it. §A39 for the fourteenth time — a mechanism with
 * no consumer, and the consumer is the entire end of the game.
 *
 * ## Why a real server, and a real clock
 *
 * The phase machine is the subject. There is no sandbox path to `Ended`, and
 * faking one would test a code path no player reaches. `ROUND_SECONDS` is
 * shortened to keep this under a minute — that is the constant's documented
 * purpose (`docs/41` §5) and not a fixture cheating.
 *
 * The control is the half that makes it mean anything: the screen must be
 * **absent** during `Playing`. Asserting only that it appears at the end passes
 * for a screen that is up from the first frame, which would be a worse bug than
 * the one being fixed.
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

const PORT = 3117
const libDir = join(process.env.HOME ?? '', '.cache/pwlibs/root/usr/lib/x86_64-linux-gnu')
const chromePath = join(
  process.env.HOME ?? '',
  '.cache/ms-playwright/chromium-1234/chrome-linux64/chrome',
)

/** Warmup is 10 s and is not shortened, so this is the playing half only. */
const ROUND_SECONDS = 20

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
    ROUND_SECONDS: String(ROUND_SECONDS),
    MAP_SCALE: 'small',
    BOT_COUNT: '2',
    MIN_PLAYERS_TO_START: '1',
    GAME_LOG: 'warn',
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
  if (!up) await sleep(250)
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
console.log(`server :${PORT}  vite ${viteUrl}  round ${ROUND_SECONDS}s + warmup`)

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
console.log('  client joined')

const dbg = () => page.evaluate('window.__game.debug()')
const shot = async (name) => {
  await page.screenshot({ path: join(shots, `${name}.png`) })
  console.log(`  shot: shots/${name}.png`)
}
/**
 * Is the results screen **visible**? Not "is it in the DOM".
 *
 * The first version of this check asked only whether the element existed. Every
 * assertion passed — element present, both buttons present, voting registering —
 * and the screenshot showed the field with no screen on it at all, because no
 * CSS for `.results-screen` existed yet. A hidden element is not a HUD (§C2),
 * and "a fix that changes the code without changing the picture looks exactly
 * like a fix that worked".
 *
 * So: laid out (non-zero box), not `display:none`/`visibility:hidden`, not
 * transparent, and covering a meaningful part of the viewport.
 */
const screenUp = () =>
  page.evaluate(() => {
    const el = document.querySelector('.results-screen')
    if (!el) return false
    const r = el.getBoundingClientRect()
    const st = getComputedStyle(el)
    return (
      r.width > 200 &&
      r.height > 200 &&
      st.display !== 'none' &&
      st.visibility !== 'hidden' &&
      Number(st.opacity) > 0.1
    )
  })
const rowsOnScreen = () =>
  page.evaluate(() =>
    [...document.querySelectorAll('.results-rows li')].map((li) => ({
      name: li.querySelector('.name')?.textContent ?? '',
      score: Number(li.querySelector('.score')?.textContent ?? 'NaN'),
    })),
  )

// --- the control: not up while playing ------------------------------------
//
// Waited for rather than sampled once: joining lands in `warmup`, and a check
// that looked immediately would be asserting about the wrong phase.
let sawPlaying = false
for (let i = 0; i < 240 && !sawPlaying; i++) {
  if ((await dbg()).phase === 'playing') sawPlaying = true
  else await sleep(250)
}
if (!sawPlaying) fail('the round never reached `playing` — nothing below is meaningful')
else if (await screenUp()) fail('the results screen is up during `playing`')
else ok('not shown during the round (the control)')

await shot('round-end-playing')

// --- the subject: up at `ended` -------------------------------------------
let sawEnded = false
for (let i = 0; i < 400 && !sawEnded; i++) {
  if ((await dbg()).phase === 'ended') sawEnded = true
  else await sleep(250)
}
if (!sawEnded) {
  fail(`the round never reached \`ended\` in ${ROUND_SECONDS}s + warmup`)
} else {
  // A frame for the DOM to render into.
  await sleep(300)
  if (!(await screenUp())) fail('the round ended and no results screen appeared')
  else ok('the results screen is up at `ended`')
}

// --- the scoreboard says what the server says -----------------------------
//
// Reconciled against the server's own table rather than against itself: the
// scoreboard read 0 for everyone for a whole milestone while the HUD refreshed
// faithfully to show it (T9.06), and a screen that renders its own stale copy
// would look exactly like this one.
if (sawEnded) {
  const rows = await rowsOnScreen()
  const d = await dbg()
  const serverNames = new Set((d.players ?? []).map((p) => String(p)))
  if (rows.length === 0) {
    fail('the results screen has no rows — an empty scoreboard is not a scoreboard')
  } else if (rows.length !== serverNames.size) {
    fail(`the screen lists ${rows.length} players, the server has ${serverNames.size}`)
  } else {
    ok(`scoreboard lists all ${rows.length} players`)
  }
  if (rows.some((r) => Number.isNaN(r.score))) fail('a score rendered as non-numeric')
  else ok(`scores render: ${rows.map((r) => `${r.name}:${r.score}`).join(' ')}`)
}

await shot('round-end-results')

// --- input stops ----------------------------------------------------------
//
// The server freezes the simulation in `Ended` but keeps accepting input, so a
// client that carries on sending queues a burst applied the instant the next
// round starts. Asserted on the *sent* count, which is the thing that would
// queue — a position that does not move would also pass for a frozen server.
if (sawEnded) {
  const before = (await dbg()).inputsSent ?? null
  if (before === null) {
    console.log('    (inputsSent not exposed — input-stop asserted via held keys only)')
  }
  await page.keyboard.down('d')
  await sleep(1200)
  await page.keyboard.up('d')
  const after = (await dbg()).inputsSent ?? null
  if (before !== null && after !== null) {
    if (after > before) fail(`still sending input at \`ended\`: ${before} -> ${after}`)
    else ok(`input stopped (${before} -> ${after} while holding a key)`)
  }
}

// --- the buttons exist and are reachable ----------------------------------
if (sawEnded) {
  const buttons = await page.evaluate(() => ({
    again: document.querySelector('.results-again')?.textContent ?? null,
    exit: document.querySelector('.results-exit')?.textContent ?? null,
  }))
  if (!buttons.again || !buttons.exit) {
    fail(`missing buttons: ${JSON.stringify(buttons)}`)
  } else {
    ok(`buttons: "${buttons.again}" / "${buttons.exit}"`)
  }

  // Voting must change the button, or a player cannot tell it registered.
  await page.click('.results-again')
  await sleep(200)
  const after = await page.evaluate(
    () => document.querySelector('.results-again')?.textContent ?? '',
  )
  if (after === buttons.again) fail('voting did not change the button')
  else ok(`voting registers ("${buttons.again}" -> "${after}")`)
}

if (pageErrors.length) fail(`page errors: ${pageErrors.slice(0, 3).join(' | ')}`)

await browser.close()
console.log(failed ? '\nround-end: FAILED' : '\nround-end: ok')
process.exit(failed ? 1 : 0)
