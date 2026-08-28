#!/usr/bin/env node
/**
 * The M10 checkpoint: two browsers, one creates a private game and the other
 * joins by the code **read off the screen**, while a third runs quick match —
 * all three rounds at once.
 *
 *   node scripts/checks/m10-checkpoint.mjs
 *
 * The code is read from the DOM rather than from the socket on purpose. The
 * whole point of a private game is that a human can read six characters aloud,
 * and a check that takes the code off the wire proves the server knows it, not
 * that anyone can see it. That distinction is not hypothetical here: nothing
 * subscribed to `room_created` at all, so creating a private game never showed
 * anyone the code, and every unit test passed.
 *
 * The strongest assertion is the negative one (§B1): a rocket fired in the
 * private room must crater it in *both* of its clients and leave the
 * quick-match room's terrain untouched. Rooms that leak into each other is the
 * multi-room form of the inventory leak in `docs/30` §6.
 *
 * These clients start at the **menu**, not at `?game=1`, so they keep their own
 * opener — but they reach a running round through `harness.mjs`'s `enterBattle`
 * like every other check (§C18). The quick-match player is alone in their room:
 * before that shared helper existed, "all three rounds are ticking" was a
 * one-player room that had no round at all.
 */
import { join } from 'node:path'
import { startStack, enterBattle, sleep, shotsDir } from './harness.mjs'

const PORT = 3114
const shots = shotsDir

const log = (m) => console.log(`  ${m}`)
const die = (m) => {
  console.error(`  FAILED ${m}`)
  process.exit(1)
}

const stack = await startStack({
  port: PORT,
  label: 'm10-checkpoint',
  env: {
    // No bots: this counts players, and a bot is a player (§A5).
    BOT_COUNT: '0',
    DEV_LOADOUT: '1',
  },
})
const { browser, viteUrl } = stack

/** A browser that starts at the menu, as a player does. */
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

const inGame = (c) =>
  c.page.waitForFunction('window.__game && window.__game.debug().ready === true', null, {
    timeout: 90_000,
  })
const dbg = (c) => c.page.evaluate('window.__game.debug()')

// --- host creates a private room -----------------------------------------
const host = await openAtMenu('ana')
await host.page.evaluate(() => {
  // §E7: hosting is behind Private Game now — Quick Game takes no options, so
  // the map-size stepper lives on the step that can actually use it.
  document.querySelector('#private')?.click()
})
await host.page.evaluate(() => document.querySelector('#host')?.click())
// **Stays in the lobby.** Since T17.07 creating a private game seats the client
// in a menu screen holding the live socket; `map_init` is what moves it to
// `GameScene`, and that does not happen until the match starts. Waiting for
// `__game` here would hang for the full ninety seconds.

// Read the six characters the way a person would: off the screen.
//
// **`__menu`, not `__game`, since T17.07.** The code is shown in the lobby now
// — a menu screen holding the live socket — rather than as a banner over a world
// the host is already standing in. `__game.debug().visibleCode` still exists and
// is now always `''`, which is the truthful answer from a scene that draws no
// code; reading it here would wait thirty seconds and then fail.
await host.page.waitForFunction(
  'window.__menu && window.__menu.visibleCode().length === 6',
  null,
  { timeout: 30_000 },
)
const code = await host.page.evaluate('window.__menu.visibleCode()')
if (!/^[A-HJ-NP-Z2-9]{6}$/.test(code)) die(`the code on screen is not a code: "${code}"`)
log(`host sees code ${code}`)

// --- guest joins by that code --------------------------------------------
const guest = await openAtMenu('bo')
await guest.page.evaluate(() => document.querySelector('#private')?.click())
await guest.page.evaluate(() => document.querySelector('#join')?.click())
await guest.page.evaluate((c) => {
  const input = document.querySelector('#code')
  input.value = c
  input.dispatchEvent(new Event('input', { bubbles: true }))
  document.querySelector('#go')?.click()
}, code)
// Both are now sitting in the same private lobby. §E3 starts it when everyone is
// ready — but this check is about three rooms not leaking into each other, not
// about the ready gate (`private_lobby` owns that), so the host starts it with
// bots rather than putting a two-client handshake in front of every assertion
// below.
await guest.page.waitForFunction('window.__menu && window.__menu.visibleCode().length === 6', null, {
  timeout: 30_000,
})
await host.page.evaluate(() => window.__menu.startWithBots())
await inGame(host)
await inGame(guest)
await enterBattle(guest.page, { press: false, waitPlaying: true, label: 'm10/guest' })
await enterBattle(host.page, { press: false, waitPlaying: true, label: 'm10/host-playing' })

// --- a third player quick-matches into a different room -------------------
const solo = await openAtMenu('cy')
await solo.page.evaluate(() => document.querySelector('#quick')?.click())
// A public lobby: §E2 seats bots and starts it after `LOBBY_BOT_TIMEOUT`, so
// this one reaches the game on its own without being told to.
await inGame(solo)
// Alone in a room of their own: nobody else is coming, so this one asks.
await enterBattle(solo.page, { waitPlaying: true, label: 'm10/solo' })

/** Wait for the roster rather than sampling once: the count arrives with the
 *  first snapshot, so reading it immediately after `ready` races it. */
const expectPlayers = async (c, n) => {
  await c.page
    .waitForFunction(`window.__game.debug().playerCount === ${n}`, null, { timeout: 20_000 })
    .catch(async () => {
      const got = (await dbg(c)).playerCount
      die(`${c.name} should see ${n} players, sees ${got}`)
    })
}
await expectPlayers(host, 2)
await expectPlayers(guest, 2)
await expectPlayers(solo, 1)

const [dh, dg, ds] = [await dbg(host), await dbg(guest), await dbg(solo)]
// Room identity is the *mask*, not `debug().seed` — that field is the client's
// own core placeholder, because a client decodes the mask over the wire rather
// than regenerating it from a seed. It reads `1` in every room, so asserting on
// it would have compared two constants and passed on any build.
if (dh.maskChecksum !== dg.maskChecksum) {
  die(`host and guest hold different maps (${dh.maskChecksum} vs ${dg.maskChecksum})`)
}
if (ds.maskChecksum === dh.maskChecksum) {
  die('the quick-match room has the same map as the private one — rooms are not seeded apart')
}
log(`private room ${dh.maskChecksum.slice(0, 12)} (2 players)`)
log(`quick-match room ${ds.maskChecksum.slice(0, 12)} (1 player)`)

// --- all three rounds are running at once ---------------------------------
// `lastServerTick`, not `tick` — there is no `tick` on this handle, and reading
// one would compare undefined against undefined, which is false forever. An
// assertion that cannot fail is not an assertion (§B11).
const tickOf = (d) => d.lastServerTick
const before = [dh, dg, ds].map(tickOf)
for (const [i, name] of ['ana', 'bo', 'cy'].entries()) {
  if (!Number.isFinite(before[i])) die(`${name} reports no server tick at all`)
}
await sleep(1500)
const after = [await dbg(host), await dbg(guest), await dbg(solo)].map(tickOf)
for (const [i, name] of ['ana', 'bo', 'cy'].entries()) {
  if (after[i] <= before[i]) die(`${name}'s room is not ticking (${before[i]} → ${after[i]})`)
}
log(`three rounds ticking at once: ${before.join('/')} → ${after.join('/')}`)

// --- the negative: rooms do not leak into each other ----------------------
const soloSolidBefore = (await dbg(solo)).solid
// Fire the way full-round does: select the rocket stack, aim below mid-screen
// (the camera follows the player, so that is below the body in world space
// whatever the camera has done) and shoot.
await host.page.keyboard.press('Digit1')
await sleep(300)
await host.page.mouse.move(640, 700)
for (let i = 0; i < 4; i++) {
  await host.page.mouse.down()
  await sleep(80)
  await host.page.mouse.up()
  await sleep(500)
}
await sleep(1500)

const [ah, ag, as_] = [await dbg(host), await dbg(guest), await dbg(solo)]
if (ah.solid >= dh.solid) die('the host fired and its own terrain did not change')
if (ag.maskChecksum !== ah.maskChecksum) {
  die(`the two clients in one room disagree: ${ah.maskChecksum} vs ${ag.maskChecksum}`)
}
log(`host carved ${dh.solid - ah.solid} px; guest agrees (${ah.maskChecksum})`)

if (as_.solid !== soloSolidBefore) {
  die(`the other room's terrain changed: ${soloSolidBefore} → ${as_.solid}`)
}
log(`the quick-match room is untouched (${as_.solid} px)`)

for (const c of [host, guest, solo]) {
  await c.page.screenshot({ path: join(shots, `m10-${c.name}.png`) })
  if (c.errors.length) die(`${c.name} had page errors: ${c.errors[0]}`)
}
log('shots: shots/m10-ana.png, m10-bo.png, m10-cy.png')

await stack.close()
console.log('  ok')
process.exit(0)
