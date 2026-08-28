#!/usr/bin/env node
/**
 * The lobby is a place you sit in (`docs/74-amendments-v6.md` §E1/§E6/§E7).
 *
 *   node scripts/checks/lobby.mjs
 *
 * **This is the only gate on T17.07's subject.** `vite.config.ts` is
 * `environment: 'node'` with no canvas, so the unit suite can reach the reducer
 * and the payload parser and nothing else — a green `npm test` says the roster
 * *shape* is right and says nothing about whether a lobby appears on screen.
 * `tasks/DECISIONS.md` D-26 records what that cost in M16: T16.03's central
 * claim sat unproven for four commits while a green unit gate read as coverage.
 *
 * So the assertions here are on **rendered pixels**, with a control frame from
 * before the second player joins (§C2). A screen that rendered nothing would
 * leave the roster region unchanged between the two frames and fail.
 */
import { startStack, sleep, shotsDir } from './harness.mjs'
import { samplePatch } from './pixels.mjs'
import { join } from 'node:path'

const PORT = 3126
const { fail, ok, finish } = (await import('./harness.mjs')).tally('lobby')

const stack = await startStack({
  port: PORT,
  label: 'lobby',
  env: {
    // Bots would fill the lobby and start the match before anything could be
    // read off the screen. §E2's timeout is `public_lobby`'s subject.
    BOT_COUNT: '0',
    FIXED_SEED: '4242',
  },
})
const { browser, viteUrl } = stack

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

const roster = (c) => c.page.evaluate('window.__menu.roster()')
const inGame = (c) =>
  c.page.waitForFunction('window.__game && window.__game.debug().ready === true', null, {
    timeout: 60_000,
  })

// --- ana hosts, and stays in the lobby -----------------------------------
const ana = await openAtMenu('ana')
await ana.page.evaluate(() => {
  // §E7: hosting is behind Private Game now — Quick Game takes no options, so
  // the map-size stepper lives on the step that can actually use it.
  document.querySelector('#private')?.click()
})
await ana.page.evaluate(() => document.querySelector('#host')?.click())
await ana.page.waitForFunction('window.__menu.visibleCode().length === 6', null, {
  timeout: 30_000,
})
const code = await ana.page.evaluate('window.__menu.visibleCode()')
if (!/^[A-HJ-NP-Z2-9]{6}$/.test(code)) fail(`the code on screen is not a code: "${code}"`)
else ok(`the host sees a join code on screen: ${code}`)

// **The client is not in the game.** This is the defect: the lobby used to be a
// panel drawn over a world the player was already standing in.
const inGameEarly = await ana.page.evaluate('!!(window.__game && window.__game.debug().ready)')
if (inGameEarly) fail('the host is already in the game while sitting in a lobby (§E1)')
else ok('control: the host is in the menu, not the game, while the lobby is open')

// The roster region, in viewport pixels. Sampled rather than measured from the
// element so a roster that failed to render at all still has a region to
// compare — an empty selector would make the control vacuous.
const ROSTER = { x: 440, y: 190, w: 400, h: 200 }

const before = await samplePatch(ana.page, ROSTER)
await ana.page.screenshot({ path: join(shotsDir, 'lobby-one-player.png') })

const namesBefore = await roster(ana)
if (namesBefore.length === 0) fail('the roster rendered no rows at all, so the diff below is vacuous')
else ok(`control frame: ${namesBefore.length} roster rows, ${namesBefore.filter((n) => n !== 'empty').length} seated`)

// --- bo joins by the code ------------------------------------------------
const bo = await openAtMenu('bo')
await bo.page.evaluate(() => document.querySelector('#private')?.click())
await bo.page.evaluate(() => document.querySelector('#join')?.click())
await bo.page.evaluate((c) => {
  const input = document.querySelector('#code')
  input.value = c
  input.dispatchEvent(new Event('input', { bubbles: true }))
  document.querySelector('#go')?.click()
}, code)
await bo.page.waitForFunction('window.__menu.roster().length > 0', null, { timeout: 30_000 })

// ana's roster must gain bo without ana doing anything: `lobby_state` is pushed.
await ana.page
  .waitForFunction('window.__menu.roster().some((r) => r.startsWith("bo"))', null, {
    timeout: 20_000,
  })
  .catch(async () => fail(`ana never saw bo arrive; roster is ${JSON.stringify(await roster(ana))}`))

const after = await samplePatch(ana.page, ROSTER)
await ana.page.screenshot({ path: join(shotsDir, 'lobby-two-players.png') })

// **The pixel assertion.** The same region, two frames, one join between them.
// A lobby that renders nothing leaves both frames identical.
//
// On the **digest**, not the mean: `pixels.mjs` builds it because "different
// pixels arranged to the same mean" is exactly what one more row of small text
// can look like. `lum` is reported alongside because a number that moves is
// worth reading, but the digest is what discriminates.
if (before.digest === after.digest) {
  fail(
    `the roster region is pixel-identical after a second player joined ` +
      `(lum ${before.lum.toFixed(1)}): nothing is being drawn`,
  )
} else {
  ok(
    `the roster redrew when bo joined (lum ${before.lum.toFixed(1)} -> ` +
      `${after.lum.toFixed(1)}, digest changed)`,
  )
}

// Both ends: what the DOM shows against what the wire said.
const namesAfter = await roster(ana)
const seated = namesAfter.filter((n) => n !== 'empty')
if (seated.length !== 2) fail(`two players are seated, the screen shows ${seated.length}: ${JSON.stringify(namesAfter)}`)
else ok(`the roster names both players: ${JSON.stringify(seated)}`)
if (!seated.some((n) => n.startsWith('ana')) || !seated.some((n) => n.startsWith('bo'))) {
  fail(`the roster is not the two players who joined: ${JSON.stringify(seated)}`)
} else ok('and they are the two who joined, by name')

// --- the ready gate (§E3) ------------------------------------------------
// Neither is ready, so nothing should start. Asserted as an absence **with the
// presence half below it**: on its own this passes for a lobby that can never
// start at all.
await sleep(2000)
const startedEarly = await ana.page.evaluate('!!(window.__game && window.__game.debug().ready)')
if (startedEarly) fail('the private match started before anyone was ready (§E3)')
else ok('control: nobody is ready, and the match has not started')

await ana.page.evaluate(() => window.__menu.ready(true))
await bo.page.evaluate(() => window.__menu.ready(true))
await inGame(ana).catch(() => fail('both players readied and the match never started'))
await inGame(bo).catch(() => fail('bo readied and never reached the game'))
ok('both ready: the match started and both clients reached the game')

// **The same game, not merely a game.** This is the assertion the check was
// missing, and it is the one that catches a broken socket handover: if
// `GameScene` opens its own connection instead of adopting the lobby's, each
// client quick-matches into a room of its own and both still report `ready`.
// Two seats, two rooms, one lobby — invisible to every assertion above.
// **On the roster, not on the seed.** `debug().seed` is the *local core's*
// seed, not the round's, and this check pins `FIXED_SEED` so every room would
// report the same one anyway — an assertion on it passes for two clients in two
// rooms, which is precisely the failure being hunted. Who each client can see
// is the thing that cannot be true across a room boundary.
const namesOf = async (c) =>
  (await c.page.evaluate('window.__game.debug().scores')).map((s) => s.name).sort()
const [seenByAna, seenByBo] = [await namesOf(ana), await namesOf(bo)]
if (!seenByAna.includes('bo') || !seenByBo.includes('ana')) {
  fail(
    `ana and bo are in different rooms: ana sees ${JSON.stringify(seenByAna)}, ` +
      `bo sees ${JSON.stringify(seenByBo)} — the lobby's socket was not handed ` +
      `over, so each client joined a room of its own`,
  )
} else {
  ok(`both clients are in one room and can see each other: ${JSON.stringify(seenByAna)}`)
}

// **And it is the room they were sitting in.** Seeing each other is necessary
// and not sufficient: if `GameScene` opened its own socket, both clients would
// have abandoned the private lobby and quick-matched into one *new* public room
// together — indistinguishable on the roster, and still two rooms on the server.
// One room means the socket was handed over rather than reopened.
const health = await (await fetch(`http://127.0.0.1:${PORT}/healthz`)).json()
if (health.rooms !== 1) {
  fail(
    `the server holds ${health.rooms} rooms for one lobby: the private room was ` +
      `abandoned and the clients re-joined somewhere else`,
  )
} else {
  ok(`one room on the server, and it is the one they waited in`)
}

// The scene actually moved — the lobby DOM is gone, not merely covered.
const menuGone = await ana.page.evaluate(
  '!document.querySelector(".menu-screen") || !document.querySelector("#roster")',
)
if (!menuGone) fail('the lobby screen is still in the DOM after the match started')
else ok('the lobby screen was torn down when the match began')

// The panels this task deleted must not have come back.
const panels = await ana.page.evaluate(
  '!!(document.querySelector("#lobby-panel") || document.querySelector("#join-code"))',
)
if (panels) fail('GameScene is drawing a lobby panel or a code banner again (§E1)')
else ok('no lobby panel or code banner is drawn over the world')

for (const c of [ana, bo]) {
  if (c.errors.length) fail(`${c.name} page errors: ${c.errors.join(' | ')}`)
  else ok(`no page errors (${c.name})`)
}

await finish()
