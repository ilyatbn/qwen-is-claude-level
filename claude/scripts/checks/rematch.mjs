#!/usr/bin/env node
/**
 * What happens after a round ends: one player replays, one leaves and
 * quick-matches (T20.13).
 *
 *   node scripts/checks/rematch.mjs
 *
 * ## Why this exists
 *
 * Reported: *"at the end of the game, if one player stays and votes to play
 * another match, and another one leaves and starts a new quick match, they both
 * appear on the list. The replay player gets a new match, but the player in the
 * public lobby gets an empty screen."*
 *
 * **It reproduces, and it is a client bug.** The measurement is in
 * `tasks/HANDOFF-M20.md` under T20.13. With `resetForNewRound()` removed from
 * `GameScene` this check goes red twice: one uncaught
 * `Cannot read properties of null (reading 'x')` out of `CameraRig.update`, and a
 * **frozen canvas** on the leaver. The server is not the subject — `quick_match`
 * correctly skips a room that `has_started()`, so the sequence produces two rooms,
 * and two rooms is not a hang.
 *
 * ## The mechanism, because it decides what this file may assert on
 *
 * Phaser constructs a `Scene` **once** and runs `create()` on every
 * `scene.start('Game')`, so every `GameScene` field with a `= value` initializer
 * outlives a round. `update` guards on `ready && world && predictor`, all three
 * stale after an exit, so it drives a camera Phaser has destroyed and throws.
 * `RequestAnimationFrame.step` calls its callback **before** re-arming itself, so
 * **one** throw ends the render loop for the life of the page. A refresh works
 * because a refresh builds a new `Scene`. That is the report, term for term.
 *
 * ## The instruments, and the three this does not use
 *
 * - **Not `debug().phase`.** The socket runs on the event loop and keeps the
 *   client's state current over a dead render loop: with the bug present, `phase`
 *   reads `playing` while the canvas holds the last frame it managed to draw.
 *   Measured, not assumed. Assert on **pixels** (§C2) — and on `pageerror`, which
 *   catches the throw itself.
 * - **Not `/healthz`'s `players`.** That is a gauge every room overwrites on its
 *   own tick (`m.set_players(room.player_count())`), so with two rooms it is
 *   whichever ticked last and not a total. `rooms` is trustworthy and is used.
 * - **Not `.menu-screen`.** The menu and the lobby are the same element, so it
 *   cannot tell "stuck on the front page" from "seated and waiting" — which is
 *   the entire question. The roster is what separates them.
 */
import { startStack, sleep } from './harness.mjs'
import { samplePatch, colourDelta } from './pixels.mjs'
import { constants as rustConstants } from '../lib/rust-constants.mjs'
import { key as clientKey } from '../lib/client-keys.mjs'

const PORT = 3135
const { fail, ok, finish } = (await import('./harness.mjs')).tally('rematch')

// From the shipped constants, never a literal: the `Ended` window is what the
// vote resolves at, and a wait spelled here would expire the day it moves.
const ENDED_SECONDS = rustConstants().get('ENDED_SECONDS')
const WARMUP_SECONDS = rustConstants().get('WARMUP_SECONDS')

const stack = await startStack({
  port: PORT,
  label: 'rematch',
  env: {
    // Short enough to reach `Ended` without waiting out a real round; the
    // `Ended` window itself is a constant and cannot be shortened.
    ROUND_SECONDS: '20',
    // A bot is a player, and this check counts who is in which room.
    BOT_COUNT: '0',
    // Long enough that two cold pages are both seated before §E2 starts the
    // round without the second one, and short enough that the leaver's new room
    // starts inside this check.
    LOBBY_BOT_TIMEOUT: '15',
    WEATHER: 'off',
  },
})

const health = async () => (await fetch(`http://127.0.0.1:${PORT}/healthz`)).json()

/**
 * Click a button that **must** be there.
 *
 * `document.querySelector('#quick')?.click()` on a missing button is a silent
 * no-op, and the next `waitForFunction` then spends its whole timeout reporting
 * "never got a match" about a click that never happened — the wrong failure, two
 * minutes later. Playwright's own `click` waits for the element and names it.
 */
const mustClick = (page, sel, timeout = 30_000) => page.click(sel, { timeout })

async function open(name) {
  const ctx = await stack.browser.newContext({ viewport: { width: 1280, height: 720 } })
  const page = await ctx.newPage()
  const errors = []
  // The **stack**, not just the message: this check crosses a scene teardown and
  // a re-entry, and "Cannot read properties of null" names no file on its own.
  page.on('pageerror', (e) => errors.push(e?.stack ? String(e.stack) : String(e)))
  // **No `menu=1`.** That flag omitted `TitleScene` until T20.13, so
  // `scene.start('Title')` did nothing and the page went blank — a repro built
  // on it reproduced an "empty screen" a player never sees. A player loads the
  // site with no flags, and so does this.
  await page.goto(`${stack.viteUrl}/?e2e=1`)
  await page.waitForSelector('#start-game', { timeout: 60_000 })
  // The key from `skins.ts`, never spelled here: a rename that missed this line
  // would seed a value nobody reads, and the roster assertions below would go on
  // passing against the default name.
  await page.evaluate((kv) => localStorage.setItem(kv[0], kv[1]), [clientKey('NAME_KEY'), name])
  await mustClick(page, '#start-game')
  await page.waitForFunction('!!window.__menu', null, { timeout: 60_000 })
  const dbg = () =>
    page.evaluate(() => {
      try {
        return window.__game ? window.__game.debug() : null
      } catch {
        // A torn-down scene leaves `window.__game` behind pointing at a dead
        // camera. Reported as absent rather than thrown, so a poll can say
        // "not in a game" without dying.
        return null
      }
    })
  const seated = () =>
    page.evaluate(() => (window.__menu?.roster?.() ?? []).filter((r) => r !== 'empty'))
  return { page, errors, name, dbg, seated }
}

const a = await open('ana')
const b = await open('bo')
for (const c of [a, b]) await mustClick(c.page, '#quick')
for (const c of [a, b]) {
  await c.page
    .waitForFunction('window.__game && window.__game.debug().ready === true', null, {
      timeout: 120_000,
    })
    .catch(() => fail(`${c.name} never reached the game`))
}

// One room, both players in it — the premise. Without this the whole check is
// about two people who were never in the same match.
//
// **Waited for, not sampled.** `debug().players` is `mirror.players`, which is
// filled *only* by `applySnapshot` — the 20 Hz stream. The loop above waits on
// `debug().ready`, which is the map-decoded flag. They are different events and
// nothing orders them, so reading `players` the instant `ready` flips is a race
// that happens to win on an idle box: instrumented over three runs here,
// `players` was **already 2 at the first sample every time** — the 21/25/29 ms
// recorded was the poll loop's own first iteration, so the gap had closed before
// anything could observe it. It lost inside a full gate that was logging
// `tick overrun lagging=2995`, and read `[]` — while the very next assertion,
// which reads `debug().scores`, listed both names in the same run. Two fields of
// one object, filled by two different paths.
//
// The wait does not weaken the claim, and that was falsified rather than
// asserted: with `bo` prevented from joining, this still fails, and with the
// right message — `ana sees [0], not two players`.
await a.page
  .waitForFunction('(window.__game?.debug().players ?? []).length === 2', null, {
    timeout: 30_000,
  })
  .catch(() => {})
const h0 = await health()
const seenByAna = (await a.dbg())?.players ?? []
if (h0.rooms !== 1) fail(`the two clients did not share a room: ${h0.rooms} rooms`)
else if (seenByAna.length !== 2) fail(`ana sees ${JSON.stringify(seenByAna)}, not two players`)
else ok(`both players are in one room: ${JSON.stringify(seenByAna)}`)

// **The presence half of the absence asserted after the re-entry.** "ana's new
// scoreboard does not list bo" is satisfied by a scoreboard that never lists
// anybody, so the same instrument has to be shown listing him first.
const namesOf = async (c) =>
  (await c.page.evaluate('window.__game ? window.__game.debug().scores : []'))
    .map((r) => r.name)
    .sort()
const rosterTogether = await namesOf(a)
if (!rosterTogether.includes('bo')) {
  fail(`ana's scoreboard does not list bo while they share a room: ${JSON.stringify(rosterTogether)}`)
} else ok(`control: ana's scoreboard lists both players: ${JSON.stringify(rosterTogether)}`)

// --- to the end of the round ----------------------------------------------
for (const c of [a, b]) {
  await c.page
    .waitForSelector('.results-screen', { timeout: 120_000 })
    .catch(() => fail(`${c.name} never saw the results screen`))
}
ok('the round ended and both players got the results screen')

// --- bo votes replay; ana exits and quick-matches --------------------------
await mustClick(b.page, '.results-again')
// **The vote is registered, not merely clicked.** `ResultsScreen` disables the
// button and relabels it `Voted` when it has sent one, so that is the effect to
// wait for — a bare sleep here would order the two clicks by hope, and if the
// vote were dropped the check would blame the restart that never came.
await b.page
  .waitForSelector('.results-again[disabled]', { timeout: 10_000 })
  .then(() => ok("the replay vote was registered (the button reads 'Voted')"))
  .catch(() => fail('the replay vote was never registered — the button stayed live'))
await mustClick(a.page, '.results-exit')

// **Exit reaches the title.** This is the step that was blank on `?menu=1`, and
// the reason that flag now registers `TitleScene`.
await a.page
  .waitForSelector('#start-game', { timeout: 30_000 })
  .then(() => ok('the leaver reached the title screen'))
  .catch(() => fail('"Exit to title" left the leaver on a blank page'))

await mustClick(a.page, '#start-game')
await a.page
  .waitForFunction('!!window.__menu', null, { timeout: 30_000 })
  .catch(() => fail('the leaver never reached the menu'))
// `mustClick` waits for `#quick` itself, which is what the bare sleep here was
// approximating.
await mustClick(a.page, '#quick')

// **Seated, not merely on a screen.** `.menu-screen` is the menu *and* the
// lobby, so the roster is the only thing that says which.
await a.page
  .waitForFunction('(window.__menu.roster() ?? []).some((r) => r.startsWith("ana"))', null, {
    timeout: 30_000,
  })
  .catch(() => {})
const anaSeat = await a.seated()
if (!anaSeat.some((r) => r.startsWith('ana'))) {
  fail(`the leaver quick-matched and is not seated anywhere: roster ${JSON.stringify(anaSeat)}`)
} else ok(`the leaver is seated in a new lobby: ${JSON.stringify(anaSeat)}`)

// **Two rooms, and that is correct.** `quick_match` skips a room that
// `has_started()`, and room #1 is started for its whole `Ended` window. Asserted
// so a future change that silently merged them is noticed, not because two rooms
// is a fault.
const h1 = await health()
if (h1.rooms !== 2) {
  fail(`the leaver's quick match produced ${h1.rooms} rooms, not two — §E4 keeps a started room closed`)
} else ok('two rooms: the replaying one, and the one the leaver quick-matched into')

// --- and both of them get a match ------------------------------------------
//
// The reported symptom in both directions, bounded by the constants that govern
// each: the voter's room restarts when the `Ended` window closes, and the
// leaver's starts on `LOBBY_BOT_TIMEOUT`.
const started = (c, label, ms) =>
  c.page
    .waitForFunction(
      'window.__game && ["warmup", "playing"].includes(window.__game.debug().phase)',
      null,
      { timeout: ms },
    )
    .then(() => ok(`${label} is in a running round`))
    .catch(async () =>
      fail(`${label} never got a match: ${JSON.stringify(await c.dbg().then((d) => d?.phase))}`),
    )

await started(b, 'the player who voted to replay', (ENDED_SECONDS + WARMUP_SECONDS + 20) * 1000)
await started(a, 'the player who left and quick-matched', 60_000)

// --- and the new match's scoreboard is the new match's -----------------------
//
// *"They both appear on the list"*, literally. `GameScene.scores` is a
// constructor field initializer, so it is built once for the life of the tab;
// `create()` never cleared it, `SHUTDOWN` never cleared it, the `lobby_state`
// handler **seeds rather than overwrites**, and the only removal is `dropRemote`
// on a `player_leave` — which is the path where the *other* player leaves, not
// this one. So the previous room's players, scores and deaths rode into the new
// match's Tab scoreboard and results screen. `resetForNewRound` clears it.
//
// bo is a different room's player and is still connected, so nothing on ana's new
// socket would ever remove him: if he is on this roster, he was carried.
const rosterAfter = await namesOf(a)
if (rosterAfter.includes('bo')) {
  fail(
    `the leaver's new match lists a player from the room she left: ` +
      `${JSON.stringify(rosterAfter)} — scores survived the scene teardown`,
  )
} else ok(`the leaver's new scoreboard is her new room's: ${JSON.stringify(rosterAfter)}`)

// --- and the leaver's screen is actually being drawn ------------------------
//
// **`phase` is not enough, and this check proved it.** With the teardown defect
// present, `debug().phase` read `playing` on a page whose render loop was dead:
// the socket pump runs on the browser's event loop and keeps the client's state
// current, while `RequestAnimationFrame.step` calls `callback(time)` *before*
// re-arming itself (`phaser.js`, `RequestAnimationFrame`), so a single throw out
// of `GameScene.update` ends the loop for good. Simulation state says "in a
// running round"; the canvas holds whatever it last drew. That is the reported
// symptom exactly — "an empty screen, and a refresh fixes it" — and only a
// **rendered pixel** can tell the two apart (§C2).
//
// The subject is the leaver. The control is the player who never left, sampled
// over the same window: if his frame is frozen too, the box stalled and the
// measurement says nothing about the leaver.
const patch = async (c) => {
  const rect = await c.page.evaluate(() => {
    const b = document.querySelector('canvas').getBoundingClientRect()
    return { x: b.left + b.width / 2 - 160, y: b.top + b.height / 2 - 120, w: 320, h: 240 }
  })
  return samplePatch(c.page, rect)
}

// Movement, so "the frame advanced" does not rest on whatever happens to be
// animating: a live client that pans its camera cannot produce two equal frames,
// and a dead one cannot produce two different ones. Warmup locks input, so both
// clients are taken to `playing` first.
for (const c of [a, b]) {
  await c.page
    .waitForFunction('window.__game && window.__game.debug().phase === "playing"', null, {
      timeout: (WARMUP_SECONDS + 30) * 1000,
    })
    .catch(() => fail(`${c.name} never reached the playing phase`))
}
const before = { a: await patch(a), b: await patch(b) }
for (const c of [a, b]) await c.page.keyboard.down('d')
await sleep(600)
const after = { a: await patch(a), b: await patch(b) }
for (const c of [a, b]) await c.page.keyboard.up('d')

const MIN_DELTA = 8
const dLeaver = colourDelta(before.a, after.a)
const dControl = colourDelta(before.b, after.b)
const frozen = (d, s0, s1) => d < MIN_DELTA && s0.digest === s1.digest
if (frozen(dControl, before.b, after.b)) {
  fail(
    `the CONTROL frame is frozen too (delta ${dControl.toFixed(1)}) — the box stalled, ` +
      `so the leaver's frame proves nothing`,
  )
} else if (frozen(dLeaver, before.a, after.a)) {
  fail(
    `the leaver's canvas is frozen: delta ${dLeaver.toFixed(1)} and an identical digest, ` +
      `while the control moved ${dControl.toFixed(1)}. The render loop is dead and only ` +
      `a refresh will revive it — T20.13's reported empty screen`,
  )
} else {
  ok(
    `the leaver's canvas is still being drawn (moved ${dLeaver.toFixed(1)}, ` +
      `control ${dControl.toFixed(1)})`,
  )
}

for (const c of [a, b]) {
  if (c.errors.length) fail(`${c.name} page errors: ${c.errors.join(' | ')}`)
  else ok(`no page errors (${c.name})`)
}

await finish()
