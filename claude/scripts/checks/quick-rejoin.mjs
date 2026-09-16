#!/usr/bin/env node
/**
 * Backing out of a quick game gives the seat back.
 *
 *   node scripts/checks/quick-rejoin.mjs
 *
 * Reported from play, 2026-09-16: *"if i click quick game, escape, then quick
 * game again, 2 slots with my username fill. as soon as a user cancels their
 * request for a quick game, they should be removed from the list."*
 *
 * ## Why this is a browser check and not a unit test
 *
 * The defect was not in the reducer — `menuReducer` moved the screen correctly
 * every time. It was that `keydown-ESC` is bound once, scene-wide, straight to
 * `dispatch({type:'back'})`, while the **only** exit that called `leaveLobby`
 * was the rendered lobby's Back button. Three of four ways out of a seated
 * screen kept the socket, and `vite.config.ts` is `environment: 'node'` — there
 * is no Phaser, no key binding and no socket in the unit suite, so nothing there
 * can see the difference between the two paths. This asserts on the roster the
 * player is actually looking at.
 *
 * ## What each assertion rules out
 *
 * "Exactly one seat named ana" is satisfied by a roster that never rendered and
 * by a client that never seated at all, so both are asserted **positively**
 * first: the name is present after the first join, and present again after the
 * second. Only then is the count meaningful.
 *
 * Falsified by reverting the `SEATED_SCREENS` guard in `MenuScene.dispatch`:
 * the second join then reports 2 seats named ana and this check fails on the
 * count, which is the owner's report in one line.
 */
import { startStack, shotsDir, freePort, tally } from './harness.mjs'
import { join } from 'node:path'
import { key as clientKey } from '../lib/client-keys.mjs'

const PORT = await freePort()
const { fail, ok, finish } = tally('quick-rejoin')

const stack = await startStack({
  port: PORT,
  label: 'quick-rejoin',
  env: {
    // Nobody may fill the lobby and start the match underneath us — this check
    // is about the seat, and a started match has left the menu entirely.
    BOT_COUNT: '0',
    // §E2's timeout would do the same thing on its own clock. Far past the run.
    LOBBY_BOT_TIMEOUT: '600',
    FIXED_SEED: '4242',
  },
})
const { browser, viteUrl } = stack

const NAME_KEY = clientKey('NAME_KEY')
const NAME = 'ana'

const ctx = await browser.newContext({ viewport: { width: 1280, height: 720 } })
const page = await ctx.newPage()
const errors = []
page.on('pageerror', (e) => errors.push(String(e)))
await page.goto(`${viteUrl}/?e2e=1&menu=1&name=${NAME}`)
await page.waitForFunction('!!window.__menu', null, { timeout: 60_000 })
await page.evaluate((k) => localStorage.setItem(k[0], k[1]), [NAME_KEY, NAME])

const screen = () => page.evaluate('window.__menu.debug().screen')
const roster = () => page.evaluate('window.__menu.roster()')
/** Seats showing this player's name. The bug made this 2. */
const mine = async () => (await roster()).filter((r) => r.includes(NAME)).length

async function quickGame(label) {
  await page.evaluate(() => document.querySelector('#quick')?.click())
  await page.waitForFunction(
    `window.__menu.roster().some((r) => r.includes(${JSON.stringify(NAME)}))`,
    null,
    { timeout: 30_000 },
  )
  const n = await mine()
  if (n === 0) fail(`${label}: never seated — the count below would be vacuous`)
  else ok(`${label}: seated, ${n} seat(s) named ${NAME}`)
  return n
}

// --- first quick game ----------------------------------------------------
const first = await quickGame('first quick game')
await page.screenshot({ path: join(shotsDir, 'quick-rejoin-first.png') })
if (first !== 1) fail(`the FIRST join already shows ${first} seats named ${NAME}`)
else ok(`control: one seat on a clean join`)

// --- escape, the way a player does it ------------------------------------
//
// A real key press, not `__menu.dispatch({type:'back'})`. The whole defect was
// that the key binding took a different route out than the button, so a check
// that drove the model directly would have passed against the broken build.
await page.keyboard.press('Escape')
await page.waitForFunction("window.__menu.debug().screen === 'menu'", null, { timeout: 15_000 })
ok('Esc returned to the main menu')

// The server needs the round trip: `leave_room` goes out, the room frees the
// seat. Waiting on the *next* join's roster is what actually proves it, but a
// stall here would otherwise show up as a confusing count below.
await page.waitForTimeout(1000)

// --- second quick game ---------------------------------------------------
const second = await quickGame('second quick game')
await page.screenshot({ path: join(shotsDir, 'quick-rejoin-second.png') })

if (second === 1) {
  ok(`the seat was given back: still one ${NAME} after quick → Esc → quick`)
} else {
  const rows = await roster()
  fail(
    `${second} seats named ${NAME} after quick → Esc → quick — the cancelled ` +
      `request kept its seat. Roster: ${JSON.stringify(rows)}`,
  )
}

if (errors.length) fail(`page errors: ${errors.join(' | ')}`)
else ok('no page errors')

await finish()
