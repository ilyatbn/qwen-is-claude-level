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

// --- §F7's settings panel ------------------------------------------------
//
// **Read off the DOM, not off `__menu.debug()`.** `debug()` returns the local
// `MenuModel`, which has never held any of these — for a guest it holds nothing
// at all — so a check reading settings from it would be meaningless on exactly
// the half that matters. `settings()` reads the rendered rows the way
// `visibleCode` and `roster` do.
const settings = (c) => c.page.evaluate('window.__menu.settings()')
const anaPanel = await settings(ana)
const boPanel = await settings(bo)
const IDS = ['scale', 'bots', 'kit', 'timer']
const missing = IDS.filter((id) => !anaPanel[id])
if (missing.length) fail(`the host's panel is missing rows: ${JSON.stringify(missing)}`)
else ok(`the host sees all four settings on screen: ${JSON.stringify(anaPanel)}`)

// The guest sees the same rows and cannot touch any of them. Both halves: a
// guest with no panel at all would satisfy "disabled" vacuously.
const guestMissing = IDS.filter((id) => !boPanel[id])
if (guestMissing.length) fail(`the guest's panel is missing rows: ${JSON.stringify(guestMissing)}`)
else if (!IDS.every((id) => boPanel[id].prevDisabled && boPanel[id].nextDisabled)) {
  fail(`a non-host can move a setting: ${JSON.stringify(boPanel)}`)
} else ok('the guest sees every setting and every control is disabled')

// The control: the host's are not disabled, so "disabled" above is about the
// seat and not about the panel.
const hostLocked = IDS.filter((id) => anaPanel[id].prevDisabled && anaPanel[id].nextDisabled)
if (hostLocked.length) {
  fail(`the host's controls are disabled too: ${JSON.stringify(hostLocked)}`)
} else ok("control: the host's controls are enabled, so the guest's are locked by seat")

// --- the host changes all three, and the guest sees it -------------------
const before3 = { bots: anaPanel.bots.value, kit: anaPanel.kit.value, timer: anaPanel.timer.value }
for (const id of ['bots', 'kit', 'timer']) {
  await ana.page.evaluate((i) => window.__menu.step(i, 1), id)
}
await bo.page
  .waitForFunction(
    (b) => {
      const s = window.__menu.settings()
      return s.bots && s.bots.value !== b.bots && s.kit.value !== b.kit && s.timer.value !== b.timer
    },
    before3,
    { timeout: 20_000 },
  )
  .catch(() => {})

const anaAfter = await settings(ana)
const boAfter = await settings(bo)
for (const id of ['bots', 'kit', 'timer']) {
  if (anaAfter[id].value === before3[id]) {
    fail(`the host changed ${id} and the screen still reads "${before3[id]}"`)
  } else if (boAfter[id].value !== anaAfter[id].value) {
    fail(
      `the guest's ${id} reads "${boAfter[id].value}" and the host's reads ` +
        `"${anaAfter[id].value}" — the change did not reach the other seat`,
    )
  } else {
    ok(`${id}: "${before3[id]}" -> "${anaAfter[id].value}", and the guest sees the same`)
  }
}

// The timer is in minutes on screen, and seconds are what crossed the wire.
if (!/^\d+ min$/.test(anaAfter.timer.value)) {
  fail(`the timer is not shown in minutes: "${anaAfter.timer.value}"`)
} else ok(`the timer reads in minutes: "${anaAfter.timer.value}"`)

// §F7: it "ends disabled at each bound". Walk it down until the arrow goes
// dead, then check it really is the bottom by pressing again and seeing no
// change. Bounded by a step count, not by a wall-clock wait.
//
// **One press per step, and the wait is on the value changing.** Reading the
// DOM straight after a press reads the frame *before* the room's `lobby_state`
// arrives, so a naive loop fires eight presses to take one step and its final
// "it did not move" read can land before the last one does.
let panel = anaAfter
let presses = 0
while (!panel.timer.prevDisabled && presses < 40) {
  const was = panel.timer.value
  await ana.page.evaluate(() => window.__menu.step('timer', -1))
  await ana.page
    .waitForFunction((v) => window.__menu.settings().timer.value !== v, was, { timeout: 10_000 })
    .catch(() => {})
  panel = await settings(ana)
  presses += 1
  if (panel.timer.value === was) break
}
if (!panel.timer.prevDisabled) {
  fail(`the timer never reached its lower bound after ${presses} steps`)
} else {
  const atBound = panel.timer.value
  await ana.page.evaluate(() => window.__menu.step('timer', -1))
  // Long enough for a `lobby_state` to arrive if one were coming: the claim is
  // that nothing was sent, and an immediate read cannot tell that from a slow
  // round trip.
  await sleep(1000)
  const still = (await settings(ana)).timer.value
  if (still !== atBound) fail(`the timer moved below its disabled bound: ${atBound} -> ${still}`)
  // The other end must still be live, or "disabled" is just a dead control.
  else if (panel.timer.nextDisabled) fail('both timer arrows are disabled at the lower bound')
  else ok(`the timer ends disabled at its lower bound (${atBound}, after ${presses} steps)`)
}

// --- a settings change clears the ready ticks (§E3) ----------------------
//
// Only ana readies: two ready humans start the match, and a match that has
// started has no panel to change.
await ana.page.evaluate(() => window.__menu.ready(true))
await ana.page
  .waitForFunction('window.__menu.roster().some((r) => r.endsWith("✓"))', null, { timeout: 20_000 })
  .catch(async () => fail(`ana readied and no tick appeared: ${JSON.stringify(await roster(ana))}`))
const ticked = await roster(ana)
if (!ticked.some((r) => r.endsWith('✓'))) {
  fail('control: no ready tick in the roster, so "the tick cleared" below proves nothing')
} else {
  ok(`control: the roster shows a ready tick: ${JSON.stringify(ticked.filter((r) => r.endsWith('✓')))}`)
  await ana.page.evaluate(() => window.__menu.step('kit', 1))
  await ana.page
    .waitForFunction('!window.__menu.roster().some((r) => r.endsWith("✓"))', null, {
      timeout: 20_000,
    })
    .catch(() => {})
  const cleared = await roster(ana)
  if (cleared.some((r) => r.endsWith('✓'))) {
    fail(`a settings change did not clear the ready ticks: ${JSON.stringify(cleared)}`)
  } else ok('a settings change cleared every ready tick in the roster (§E3)')
}

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

// --- a public lobby has no panel at all (§F7) ----------------------------
//
// **Last, on purpose.** A quick-matching client opens a *second* room, and the
// one-room assertion above is the check's guard against the socket being
// reopened rather than handed over. Running this before it turned that
// assertion red for a reason that had nothing to do with the handover.
const cass = await openAtMenu('cass')
await cass.page.evaluate(() => document.querySelector('#quick')?.click())
await cass.page.waitForFunction('window.__menu.roster().length > 0', null, { timeout: 30_000 })
const publicPanel = await settings(cass)
if (Object.keys(publicPanel).length !== 0) {
  fail(`a public lobby is showing a settings panel: ${JSON.stringify(publicPanel)}`)
} else ok('control: a public lobby renders no settings panel at all (§F7)')
if ((await roster(cass)).length === 0) {
  fail('the public lobby rendered nothing, so "no panel" above is vacuous')
} else ok('and it did render a lobby, so the absence above is about the panel')
if (cass.errors.length) fail(`cass page errors: ${cass.errors.join(' | ')}`)
const cassCtx = cass.page.context()
await cass.page.close()
await cassCtx.close()

for (const c of [ana, bo]) {
  if (c.errors.length) fail(`${c.name} page errors: ${c.errors.join(' | ')}`)
  else ok(`no page errors (${c.name})`)
}

await finish()
