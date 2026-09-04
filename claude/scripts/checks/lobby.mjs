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
import { constants as rustConstants } from '../lib/rust-constants.mjs'
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

// **`deepcut.*`, spelled out.** Three browser fixtures do this, and the keys did
// not change in T20.02 for exactly that reason — a rename here that missed them
// would seed a value nobody reads and every "the roster names the player" check
// would go on passing against the default. If they are ever renamed, this line
// is part of the rename.
const NAME_KEY = 'deepcut.name'

/**
 * @param name the nickname to seed, or `null` to arrive with **nothing stored**
 *   — which is the state T20.02's prompt exists for.
 */
async function openAtMenu(name, seed = true) {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 720 } })
  const page = await ctx.newPage()
  const errors = []
  page.on('pageerror', (e) => errors.push(String(e)))
  await page.goto(`${viteUrl}/?e2e=1&menu=1&name=${name}`)
  await page.waitForFunction('!!window.__menu', null, { timeout: 60_000 })
  if (seed) await page.evaluate((k) => localStorage.setItem(k[0], k[1]), [NAME_KEY, name])
  else await page.evaluate((k) => localStorage.removeItem(k), NAME_KEY)
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
// When the host took its seat, for the §E3 wait far below. `sweep_unready`
// measures `joined_at.elapsed()`, so the clock the assertion needs is this one
// and not the one that starts when the wait does — everything between here and
// there counts, which is most of the thirty seconds.
const hostSeatedAt = Date.now()
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

// --- §E3: no timeout, ever (T20.01) --------------------------------------
//
// **The only assertion in the tree that can see the reported bug**, because it
// is the only one that sits in a lobby long enough. `sweep_unready` freed every
// seat that had not sent `ready` after `READY_TIMEOUT_SECS`, lobby or match —
// and a private-lobby host never sends one, since the tick-box is the only
// `ready` a lobby has. The host was swept out of its own lobby at t≈30 s,
// `settings_owner()` (the longest-seated human) answered `None`, and every arrow
// came back *"only the host can change the settings"* on a screen that still
// drew them enabled, because the sweep told nobody.
//
// It has to be a **real** wait: the sweep reads `joined_at.elapsed()`, so
// nothing but the wall clock reaches it. `docs/74:110` — *"No timeout, ever. A
// private lobby waits as long as its players do."*
const READY_TIMEOUT_SECS = rustConstants().get('READY_TIMEOUT_SECS')
// The margin is slack for the tick that notices, not a tunable: the sweep runs
// once a frame and `>` is strict, so landing exactly on the boundary would be a
// coin flip.
const MARGIN_MS = 2_000
const sat = Date.now() - hostSeatedAt
const remaining = READY_TIMEOUT_SECS * 1000 + MARGIN_MS - sat
if (remaining > 0) await sleep(remaining)
const satFor = (Date.now() - hostSeatedAt) / 1000
if (satFor <= READY_TIMEOUT_SECS) {
  fail(`the lobby was only open ${satFor.toFixed(1)} s, under the ${READY_TIMEOUT_SECS} s timeout: the wait proves nothing`)
} else {
  ok(`the host sat in its own lobby for ${satFor.toFixed(1)} s, past READY_TIMEOUT_SECS=${READY_TIMEOUT_SECS}`)
}

// Nobody was swept: the roster still seats both.
const stillSeated = (await roster(ana)).filter((n) => n !== 'empty')
if (stillSeated.length !== 2) {
  fail(`after ${satFor.toFixed(1)} s in the lobby the roster seats ${stillSeated.length}: ${JSON.stringify(stillSeated)} — §E3 says a private lobby has no timeout`)
} else ok(`both players are still seated after the timeout: ${JSON.stringify(stillSeated)}`)

// And the host still owns the settings — on the screen **and** on the wire. The
// panel being drawn enabled is exactly what the bug did; the discriminator is
// whether a press actually moves the value, which only the room can grant.
const aged = await settings(ana)
if (!aged.kit || aged.kit.nextDisabled) {
  fail(`the host's settings went dead after ${satFor.toFixed(1)} s: ${JSON.stringify(aged)}`)
} else {
  const was = aged.kit.value
  await ana.page.evaluate(() => window.__menu.step('kit', 1))
  await ana.page
    .waitForFunction((v) => window.__menu.settings().kit.value !== v, was, { timeout: 10_000 })
    .catch(() => {})
  const now = (await settings(ana)).kit.value
  if (now === was) {
    fail(`the host was refused its own setting after ${satFor.toFixed(1)} s: kit is still "${was}" — the host was swept out of its own lobby`)
  } else ok(`the host still changes settings after the timeout: kit "${was}" -> "${now}"`)
}

// The reported error text, asserted where a player would read it.
const banner = await ana.page.evaluate(
  '(document.querySelector(".menu-screen .error") || {}).textContent || ""',
)
if (banner.includes('Could not join')) {
  fail(`the host is being told it could not join the lobby it is sitting in: "${banner}"`)
} else ok(`no join refusal on the host's screen${banner ? ` (banner reads "${banner}")` : ''}`)

// The control: the guest's controls are still locked, so "enabled" above is
// about the seat and not about a panel that never disables anything.
const boAged = await settings(bo)
if (!boAged.kit || !boAged.kit.nextDisabled) {
  fail(`the guest can move a setting after the timeout: ${JSON.stringify(boAged)}`)
} else ok('control: the guest is still locked out, so the host is enabled by seat')

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
const cassRoster = await roster(cass)
if (cassRoster.length === 0) {
  fail('the public lobby rendered nothing, so "no panel" above is vacuous')
} else ok('and it did render a lobby, so the absence above is about the panel')
// T20.03: and no crown either. `settings_owner` is derived on **every** room and
// the server sends it for public lobbies too, but `check_settings_change`
// refuses a public lobby before it ever looks at the owner — so a marker here
// would name somebody who owns nothing. The presence half is asserted on the
// private lobby below.
if (cassRoster.some((r) => r.includes('(host)'))) {
  fail(`a public lobby is marking a host: ${JSON.stringify(cassRoster)}`)
} else ok('control: no host marker on a public lobby (§F7 gates the panel; the roster too)')
if (cass.errors.length) fail(`cass page errors: ${cass.errors.join(' | ')}`)
const cassCtx = cass.page.context()
await cass.page.close()
await cassCtx.close()

// --- T20.03: the host leaves and the survivor is told ---------------------
//
// **Last, after the one-room assertion**, for the reason the public-lobby block
// above gives: a new lobby is a new room, and `health.rooms !== 1` is this
// check's guard on the socket handover.
//
// Reported: *"if the host leaves the waiting room, the next active player should
// be promoted to host."* Promotion itself already worked — `settings_owner()` is
// derived from the seat list and moves on its own — and **nothing on screen said
// so**: the promoted player got working arrows with no explanation and the old
// host got dead ones. So the assertion is on the rendered roster text, through
// `__menu.roster()`, which reads `textContent`.
const dan = await openAtMenu('dan')
await dan.page.evaluate(() => document.querySelector('#private')?.click())
await dan.page.evaluate(() => document.querySelector('#host')?.click())
await dan.page.waitForFunction('window.__menu.visibleCode().length === 6', null, {
  timeout: 30_000,
})
const danCode = await dan.page.evaluate('window.__menu.visibleCode()')

const eve = await openAtMenu('eve')
await eve.page.evaluate(() => document.querySelector('#private')?.click())
await eve.page.evaluate(() => document.querySelector('#join')?.click())
await eve.page.evaluate((c) => {
  const input = document.querySelector('#code')
  input.value = c
  input.dispatchEvent(new Event('input', { bubbles: true }))
  document.querySelector('#go')?.click()
}, danCode)
await eve.page
  .waitForFunction('window.__menu.roster().some((r) => r.startsWith("dan"))', null, {
    timeout: 30_000,
  })
  .catch(async () => fail(`eve never saw dan's lobby: ${JSON.stringify(await roster(eve))}`))

// The control frame: dan is marked, eve is not, on eve's own screen.
const seatedRows = (rows) => rows.filter((r) => r !== 'empty')
const hostBefore = seatedRows(await roster(eve))
const hostedBefore = hostBefore.filter((r) => r.includes('(host)'))
if (hostedBefore.length !== 1 || !hostedBefore[0].startsWith('dan')) {
  fail(`the roster does not mark the host before anyone leaves: ${JSON.stringify(hostBefore)}`)
} else ok(`control: exactly one host on screen and it is the host: ${JSON.stringify(hostedBefore)}`)
const eveLocked = await settings(eve)
if (!eveLocked.kit || !eveLocked.kit.nextDisabled) {
  fail(`the guest's controls are live before promotion: ${JSON.stringify(eveLocked)}`)
} else ok("control: eve's controls are disabled while dan is host")

// dan leaves the waiting room, by the button a player would press.
await dan.page.evaluate(() => document.querySelector('#back')?.click())

await eve.page
  .waitForFunction('window.__menu.roster().some((r) => r.startsWith("eve") && r.includes("(host)"))', null, {
    timeout: 20_000,
  })
  .catch(() => {})
const hostAfter = seatedRows(await roster(eve))
const hostedAfter = hostAfter.filter((r) => r.includes('(host)'))
if (hostedAfter.length !== 1 || !hostedAfter[0].startsWith('eve')) {
  fail(
    `the host left and the marker did not move to the survivor: ${JSON.stringify(hostAfter)} ` +
      `(was ${JSON.stringify(hostBefore)})`,
  )
} else ok(`the marker moved to the promoted player: ${JSON.stringify(hostedAfter)}`)
if (hostAfter.some((r) => r.startsWith('dan'))) {
  fail(`dan left and is still on eve's roster: ${JSON.stringify(hostAfter)}`)
} else ok('and the player who left is off the roster')

// **The screen and the wire must agree.** A marker that moved while the arrows
// stayed dead would be a decoration; a working arrow with no marker is the bug
// as reported. Both, and the arrow proved by the value actually moving — only
// the room can grant that.
const evePanel = await settings(eve)
if (!evePanel.kit || evePanel.kit.nextDisabled) {
  fail(`eve is marked host and her controls are still disabled: ${JSON.stringify(evePanel)}`)
} else {
  const was = evePanel.kit.value
  await eve.page.evaluate(() => window.__menu.step('kit', 1))
  await eve.page
    .waitForFunction((v) => window.__menu.settings().kit.value !== v, was, { timeout: 10_000 })
    .catch(() => {})
  const now = (await settings(eve)).kit.value
  if (now === was) fail(`eve was marked host and the room refused her change: kit stayed "${was}"`)
  else ok(`the promoted player can actually change a setting: kit "${was}" -> "${now}"`)
}

for (const c of [dan, eve]) {
  if (c.errors.length) fail(`${c.name} page errors: ${c.errors.join(' | ')}`)
  const ctx = c.page.context()
  await c.page.close()
  await ctx.close()
}

// --- T20.02: a nickname you are asked for once ----------------------------
//
// **Last, with the other room-making blocks**, for the reason the public-lobby
// section above gives.
//
// The control for "the prompt appears" is every client above: `ana`, `bo`,
// `cass`, `dan` and `eve` all had a name in storage and every one of them walked
// straight into a lobby. This client has nothing stored.
const zed = await openAtMenu('zed', false)
await zed.page.evaluate(() => document.querySelector('#private')?.click())
await zed.page.evaluate(() => document.querySelector('#host')?.click())
await zed.page
  .waitForFunction('!!document.querySelector("#nickname")', null, { timeout: 20_000 })
  .catch(() => {})
if (!(await zed.page.evaluate('!!document.querySelector("#nickname")'))) {
  fail('a player with no stored nickname was not asked for one before hosting')
} else ok('a player with no stored nickname is asked for one before hosting')
// And the join really is held: the prompt is a gate, not a banner over a lobby
// that opened anyway.
if (await zed.page.evaluate('!!document.querySelector("#roster")')) {
  fail('the nickname prompt is on screen and the lobby opened behind it')
} else ok('control: the lobby did not open behind the prompt')

await zed.page.evaluate(() => {
  const input = document.querySelector('#nickname')
  input.value = 'zed'
  input.dispatchEvent(new Event('input', { bubbles: true }))
  document.querySelector('#go-name')?.click()
})
await zed.page
  .waitForFunction('window.__menu.visibleCode().length === 6', null, { timeout: 30_000 })
  .catch(() => fail('the nickname was accepted and the host never reached a lobby'))

// **Read off the roster, not out of `localStorage`.** The claim is that the name
// crossed the wire and came back in `lobby_state`, which a storage read cannot
// see: the old `identity()` sent `Number("banana")` as `null` from a storage
// that looked perfectly fine.
const zedRoster = (await roster(zed)).filter((r) => r !== 'empty')
if (!zedRoster.some((r) => r.startsWith('zed'))) {
  fail(`the name typed at the prompt is not on the roster: ${JSON.stringify(zedRoster)}`)
} else ok(`the typed nickname came back off the roster: ${JSON.stringify(zedRoster)}`)

// **Once.** Leave and host again: no prompt the second time.
await zed.page.evaluate(() => document.querySelector('#back')?.click())
await zed.page.waitForFunction('!document.querySelector("#roster")', null, { timeout: 20_000 })
await zed.page.evaluate(() => document.querySelector('#private')?.click())
await zed.page.evaluate(() => document.querySelector('#host')?.click())
await zed.page
  .waitForFunction('window.__menu.visibleCode().length === 6', null, { timeout: 30_000 })
  .catch(() => {})
if (await zed.page.evaluate('!!document.querySelector("#nickname")')) {
  fail('the nickname prompt came back for a player who had already answered it')
} else ok('and it is asked once: the second host went straight to a lobby')

if (zed.errors.length) fail(`zed page errors: ${zed.errors.join(' | ')}`)
{
  const ctx = zed.page.context()
  await zed.page.close()
  await ctx.close()
}

for (const c of [ana, bo]) {
  if (c.errors.length) fail(`${c.name} page errors: ${c.errors.join(' | ')}`)
  else ok(`no page errors (${c.name})`)
}

await finish()
