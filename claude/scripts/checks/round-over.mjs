#!/usr/bin/env node
/**
 * The round after the round (T21.32) — one human, three bots, through the menu.
 *
 *   node scripts/checks/round-over.mjs
 *
 * Reported from play, 2026-09-15: *"Play again" does nothing* — the owner clicked it,
 * it read "Voted", and no round came; the same map every round; and a round timer
 * reading 0:00 under "Waiting for players".
 *
 * `rematch.mjs` only votes **inside** the window, so it could not see any of it. This
 * waits the window out.
 *
 * ## What is asserted, and the control for each
 *
 * 1. **Item 4.** The first frames of a match reached through the menu are not
 *    `lobby` / `0:00`. Measured at 1173c70: five samples of `{"phase":"lobby",
 *    "timer":"0:00"}` across the whole warmup.
 * 2. **Item 1, the subject.** A lone human who does not vote sees a countdown with
 *    words, and when the window closes is back on the title — not left on "Round
 *    over" forever. `docs/72` §C3: "If it does not, the client returns to the title."
 * 3. **Item 2.** Quick matching again lands in the same room (it is not started and
 *    the TTL is the shipped one), and the map is built on a different seed.
 * 4. **Item 1, the control.** The same lone human voting **inside** the window gets a
 *    new round — so (2) is about the vote, not a client that leaves every results
 *    screen. Since T21.38 it comes on the vote, not at the close: one human is every
 *    human, and the three bots do not count ("0 of 1" in (2) shows they are not).
 *
 * The instruments: the rendered DOM (`#hud-timer`, `.results-count`,
 * `.results-again`, `#start-game`), and `debug().phase` only where the phase itself
 * is the claim.
 */
import { startStack, sleep, freePort, tally } from './harness.mjs'
import { constants as rustConstants } from '../lib/rust-constants.mjs'
import { key as clientKey } from '../lib/client-keys.mjs'

const PORT = await freePort()
const { fail, ok, finish } = tally('round-over')

// From the shipped constants, never literals: the window is what everything below
// waits on, and a wait spelled here expires the day it moves.
const ENDED_SECONDS = rustConstants().get('ENDED_SECONDS')
// Long enough that item 4's samples land well inside the warmup countdown: at 3 s the
// first run sampled a warmup that had already counted down to `0:00` honestly, which
// is the reading the bug produces. Short of the shipped 10 s only to save time.
const WARMUP_S = 8
const ROUND_S = 20
const LOBBY_S = 3

const stack = await startStack({
  port: PORT,
  label: 'round-over',
  env: {
    DEV_WARMUP_SECONDS: String(WARMUP_S),
    ROUND_SECONDS: String(ROUND_S),
    // The owner's room: one human, three bots.
    BOT_COUNT: '3',
    LOBBY_BOT_TIMEOUT: String(LOBBY_S),
    WEATHER: 'off',
  },
})
const health = async () => (await fetch(`http://127.0.0.1:${PORT}/healthz`)).json()

const ctx = await stack.browser.newContext({ viewport: { width: 1280, height: 720 } })
const page = await ctx.newPage()
const errors = []
page.on('pageerror', (e) => errors.push(e?.stack ? String(e.stack) : String(e)))

/** `debug()`, or null once the scene is torn down and the handle points at nothing. */
const dbg = () =>
  page.evaluate(() => {
    try {
      return window.__game ? window.__game.debug() : null
    } catch {
      return null
    }
  })
const text = (sel) => page.evaluate((s) => document.querySelector(s)?.textContent ?? null, sel)

/** Title → menu → quick match → a match on screen. */
async function quickMatch(label) {
  await page.click('#start-game', { timeout: 30_000 })
  await page.click('#quick', { timeout: 30_000 })
  await page.waitForFunction(
    () => {
      try {
        return window.__game?.debug().ready === true
      } catch {
        return false
      }
    },
    null,
    { timeout: (LOBBY_S + 90) * 1000 },
  )
  ok(`${label}: in a match`)
}

/** Wait for the results screen, bounded by the round it ends. */
async function toResults(label) {
  await page
    .waitForSelector('.results-screen', { timeout: (WARMUP_S + ROUND_S + 60) * 1000 })
    .catch(() => fail(`${label}: the round never ended`))
}

await page.goto(`${stack.viteUrl}/?e2e=1`)
await page.waitForSelector('#start-game', { timeout: 60_000 })
await page.evaluate((kv) => localStorage.setItem(kv[0], kv[1]), [clientKey('NAME_KEY'), 'owner'])

// --- round one ---------------------------------------------------------------
await quickMatch('round one')

// 1. Item 4. Sampled for a second from the first frame the map is up: long enough
// for the latched `round_state` to be replayed, and far inside a warmup the bug held
// for its whole length.
const early = []
for (let i = 0; i < 5; i++) {
  const d = await dbg()
  early.push({ phase: d?.phase, timer: d?.hudTimer?.text })
  await sleep(250)
}
const settled = early.slice(2)
if (settled.some((s) => s.phase === 'lobby' || s.timer === '0:00')) {
  fail(`a match began showing the lobby: ${JSON.stringify(early)}`)
} else if (!settled.some((s) => /^\d+:\d\d$/.test(s.timer ?? ''))) {
  // The control: a blank timer everywhere would pass the line above.
  fail(`the round timer shows nothing in a running match: ${JSON.stringify(early)}`)
} else {
  ok(`the first frames of the match are the match: ${JSON.stringify(settled)}`)
}

const seed1 = (await dbg())?.roundSeed
await toResults('round one')

// 2. Item 1, the subject: nobody votes.
const count1 = await text('.results-count')
if (!/^Vote closes in \d+ s$/.test(count1 ?? '')) {
  fail(`the results countdown does not say what it counts: ${JSON.stringify(count1)}`)
} else ok(`the window counts down in words: "${count1}"`)

// T21.38: the tally reaches the screen, and the three bots are not in it. "0 of 1"
// is both halves at once — a tally that counted bots would read "0 of 4", and one
// that never arrived reads "" (the `null` a missing field parses to).
await page
  .waitForFunction(() => document.querySelector('.results-tally')?.textContent !== '', null, {
    timeout: 5_000,
  })
  .catch(() => {})
const tally1 = await text('.results-tally')
if (tally1 !== '0 of 1 player wants a rematch') {
  fail(`one human and three bots, nobody voted, and the tally reads ${JSON.stringify(tally1)}`)
} else ok(`the tally counts the one human and no bots: "${tally1}"`)

await page
  .waitForSelector('#start-game', { timeout: (ENDED_SECONDS + 15) * 1000 })
  .then(() => ok('the window closed with no vote and the player is back on the title'))
  .catch(async () =>
    fail(
      `the window closed and the player is still on "Round over": ` +
        `${JSON.stringify({ phase: (await dbg())?.phase, count: await text('.results-count') })}`,
    ),
  )
if (await page.evaluate(() => !!document.querySelector('.results-screen'))) {
  fail('the results screen is still up on the title')
}

// --- round two: the same room, a new map --------------------------------------
await quickMatch('round two')
const rooms = (await health()).rooms
const seed2 = (await dbg())?.roundSeed
if (rooms !== 1) fail(`quick match made a second room (${rooms}), so the seed comparison is moot`)
else if (!seed1 || !seed2) fail(`no seed to compare: ${seed1} / ${seed2}`)
else if (seed1 === seed2) fail(`the same room built the same map twice: seed ${seed1}`)
else ok(`same room, new map: seed ${seed1} -> ${seed2}`)

await toResults('round two')

// 4. Item 1, the control: vote inside the window.
//
// T21.38: a lone human is every human, so the server restarts **on the vote** rather
// than at the window's close (R3). That also means "Voted" may never be on screen —
// the results screen goes as the new round arrives — so the button's wording is
// `rematch.mjs`'s to assert, where a second human holds the window open.
//
// The early restart is asserted against the window's own clock as the player sees
// it: the seconds the countdown read just before the click. A restart that waited
// for the close would take all of them.
const secsAtClick = Number((await text('.results-count'))?.match(/(\d+) s$/)?.[1] ?? NaN)
const clickedAt = Date.now()
await page.click('.results-again')
const EARLY_MARGIN_S = 3
if (!(secsAtClick > EARLY_MARGIN_S * 2)) {
  fail(`too little of the window left to tell early from on-time: ${secsAtClick} s`)
}
await page
  .waitForFunction(
    () => {
      try {
        return window.__game?.debug().phase === 'warmup'
      } catch {
        return false
      }
    },
    null,
    { timeout: (ENDED_SECONDS + 15) * 1000 },
  )
  .then(() => {
    const took = (Date.now() - clickedAt) / 1000
    if (took < secsAtClick - EARLY_MARGIN_S) {
      ok(`a lone human's yes started a new round in ${took.toFixed(1)} s, with ${secsAtClick} s of window left`)
    } else {
      fail(`the new round waited for the window: ${took.toFixed(1)} s after a vote with ${secsAtClick} s left`)
    }
  })
  .catch(async () => fail(`no new round after a counted vote: ${(await dbg())?.phase}`))
if (await page.evaluate(() => !!document.querySelector('#start-game'))) {
  fail('a player whose vote carried was sent to the title')
}

if (errors.length) fail(`page errors: ${errors.join(' | ')}`)
else ok('no page errors')

await finish(stack.close)
