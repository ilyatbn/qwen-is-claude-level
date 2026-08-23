#!/usr/bin/env node
/**
 * T14.06 / §C13 — the escape menu, and what "quit" has to actually do.
 *
 *   node scripts/checks/escape-menu.mjs
 *   node scripts/e2e.mjs escape-menu
 *
 * `handleEscape` owns the stacking rule and is unit-tested. Three things need a
 * running stack:
 *
 * - the menu is **on the screen**, not merely flagged open (§C2);
 * - the round **keeps running behind it** — §C13 is explicit that this is an
 *   overlay and not a pause, and a scene that paused would satisfy every DOM
 *   assertion here;
 * - **Quit leaves the room.** A quit that only changes scene keeps the seat and
 *   the room never reaps, which is §B14's shape exactly. That is asserted from
 *   the *server's* player count, not from the client's opinion of itself.
 */
import { startStack, enterBattle, tally, sleep } from './harness.mjs'

const PORT = 3126
const { fail, ok, finish } = tally('escape-menu')

const stack = await startStack({
  port: PORT,
  label: 'escape-menu',
  env: { ROUND_SECONDS: '180', BOT_COUNT: '0', DEV_LOADOUT: '1' },
})
const { page, dbg, shot, pageErrors } = await stack.openClient({ name: 'ana' })
await enterBattle(page, { waitPlaying: true, label: 'escape-menu' })

const shown = (id) =>
  page.evaluate((elId) => {
    const el = document.getElementById(elId)
    if (!el) return false
    const r = el.getBoundingClientRect()
    return r.width > 1 && r.height > 1
  }, id)

// --- control: nothing is up ------------------------------------------------
if (await shown('escape-menu')) fail('the escape menu is showing before Esc was pressed')
else ok('control: the menu is down at the start')

// --- Esc opens it, on the screen -------------------------------------------
await page.keyboard.press('Escape')
await sleep(250)
if (!(await shown('escape-menu'))) {
  fail('Esc did not put the menu on the screen')
} else {
  ok('Esc opens the menu')
  await shot('escape-menu')

  // Options: present, disabled, and out of the tab order (§C13).
  const options = await page.evaluate(() => {
    const el = document.getElementById('escape-options')
    if (!el) return null
    return { text: el.textContent ?? '', disabled: el.disabled, tabIndex: el.tabIndex }
  })
  if (!options) {
    fail('Options is missing — §C13 asks for it present and disabled, not hidden')
  } else if (!options.disabled || options.tabIndex >= 0) {
    fail(`Options is reachable: disabled=${options.disabled}, tabIndex=${options.tabIndex}`)
  } else {
    ok(`Options is present, disabled and unfocusable — "${options.text.trim()}"`)
  }

  // --- the round keeps running behind it (§C13, §B4) -----------------------
  const t0 = await dbg()
  await sleep(800)
  const t1 = await dbg()
  if (t1.serverRoundTime > t0.serverRoundTime + 0.4) {
    ok(`the round ran on behind it (${t0.serverRoundTime.toFixed(1)}s → ${t1.serverRoundTime.toFixed(1)}s)`)
  } else {
    fail(
      `the world barely advanced with the menu open: ` +
        `${t0.serverRoundTime.toFixed(2)}s → ${t1.serverRoundTime.toFixed(2)}s`,
    )
  }

  // --- Esc closes it again, and Resume does too ---------------------------
  await page.keyboard.press('Escape')
  await sleep(250)
  if (await shown('escape-menu')) fail('a second Esc did not close the menu')
  else ok('Esc closes it again')

  await page.keyboard.press('Escape')
  await sleep(200)
  await page.click('#escape-resume')
  await sleep(250)
  if (await shown('escape-menu')) fail('Resume did not close the menu')
  else ok('Resume closes it')
}

// --- the stacking rule, driven for real ------------------------------------
//
// The unit test proves the decision; this proves the two overlays are wired to
// it. With the backpack open, one Esc closes the backpack and leaves the menu
// down — the case that is easy to get wrong and impossible to see from a unit
// test of either component alone.
await page.mouse.click(640, 360, { button: 'right' })
await sleep(250)
const both = await dbg()
if (!both.overlays?.inventory) {
  fail('right-click did not open the backpack, so the stacking case cannot be driven')
} else {
  await page.keyboard.press('Escape')
  await sleep(250)
  const after = await dbg()
  if (after.overlays?.inventory) {
    fail('Esc did not close the backpack')
  } else if (after.overlays?.escapeMenu) {
    fail('Esc closed the backpack and opened the menu on top of it in one press')
  } else {
    ok('with the backpack open, Esc closes the backpack and nothing else')
  }
  // ...and the *next* Esc gets the menu, which is the other half of the rule.
  await page.keyboard.press('Escape')
  await sleep(250)
  if (!(await dbg()).overlays?.escapeMenu) fail('the next Esc did not open the menu')
  else ok('and the next Esc opens the menu')
}

// --- Quit leaves the room --------------------------------------------------
//
// Asserted from the **server's** seat count. A client that changed scene while
// staying connected would look identical from the browser and would keep its
// seat forever.
/** Seated players, from the server's own `/metrics`. */
const seated = async () => {
  try {
    const r = await fetch(`http://localhost:${PORT}/metrics`)
    if (!r.ok) return -1
    const body = await r.text()
    const m = /^players (\d+)$/m.exec(body)
    return m ? Number(m[1]) : -1
  } catch {
    return -1
  }
}

const seatedBefore = await seated()
if (seatedBefore !== 1) {
  fail(`the server reports ${seatedBefore} seated player(s) before quitting, not 1`)
}
await page.keyboard.press('Escape')
await sleep(200)
if (!(await shown('escape-menu'))) {
  // It may already be open from the stacking case above.
  await page.keyboard.press('Escape')
  await sleep(200)
}
await page.click('#escape-quit')
await sleep(1200)

const back = await page.evaluate(() => document.querySelector('canvas') !== null)
if (!back) fail('the page lost its canvas after quitting')

// The room should now have nobody in it. Polled: the disconnect is a round trip,
// and `players` is refreshed on the room's own tick.
let players = 1
for (let i = 0; i < 24 && players > 0; i++) {
  players = await seated()
  if (players > 0) await sleep(250)
}
if (players === -1) {
  fail('could not read /metrics, so "quit leaves the room" was never checked')
} else if (players > 0) {
  fail(`quitting left ${players} player(s) seated — the room will never reap (§B14)`)
} else {
  ok(`quit to title left the room empty (was ${seatedBefore ?? '?'})`)
}

if (pageErrors.length) fail(`page errors: ${pageErrors.slice(0, 3).join(' | ')}`)
else ok('no page errors')

await finish(() => stack.close())
