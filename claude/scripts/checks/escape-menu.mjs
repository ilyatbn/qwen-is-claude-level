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
import { startStack, enterBattle, standStill, selectWeapon, tally, sleep, freePort } from './harness.mjs'

const PORT = await freePort()
const { fail, ok, finish } = tally('escape-menu')

const stack = await startStack({
  port: PORT,
  label: 'escape-menu',
  env: { ROUND_SECONDS: '180', BOT_COUNT: '0', DEV_LOADOUT: '1' },
})
const { page, dbg, shot, pageErrors } = await stack.openClient({ name: 'ana' })
await enterBattle(page, { waitPlaying: true, label: 'escape-menu' })

/**
 * Fire a laser with the menu down and report the most beam quads the ordnance layer
 * painted while that beam lived — `null` if no beam was ever held.
 *
 * **The most, over the beam's life, not the first reading.** `tracersDrawn` is the
 * state's tracer count and rises the moment the shot arrives, *before* the render
 * that paints it, so a single read took `beamShadersDrawn` from the previous frame
 * and reported 0 with High Quality On (measured, first run of this check). A beam is
 * used because it is the one High Quality effect a player can make on demand; what it
 * *looks like* is `beams-shader`'s claim, not this check's.
 */
async function beamQuadsAfterAShot() {
  await selectWeapon(page, 'laser_pistol')
  await standStill(page)
  await page.mouse.move(1000, 300)
  await sleep(150)
  for (let shot = 0; shot < 10; shot++) {
    await page.evaluate(() => window.__game.fire())
    let held = false
    let most = 0
    for (let i = 0; i < 60; i++) {
      const d = await dbg()
      if ((d.tracersDrawn ?? 0) > 0) {
        held = true
        if (typeof d.beamShadersDrawn !== 'number') return null
        most = Math.max(most, d.beamShadersDrawn)
      } else if (held) {
        break
      }
      await sleep(20)
    }
    if (held) return most
  }
  return null
}

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

  // Options: **enabled since T21.16**, and it opens a panel.
  //
  // This asserted the opposite until now — present, disabled and out of the tab
  // order — which was right while it was a stub and is a lie once it works.
  const options = await page.evaluate(() => {
    const el = document.getElementById('escape-options')
    if (!el) return null
    return { text: el.textContent ?? '', disabled: el.disabled }
  })
  if (!options) {
    fail('Options is missing')
  } else if (options.disabled) {
    fail('Options is still disabled — T21.16 enables it')
  } else {
    ok(`Options is present and enabled — "${options.text.trim()}"`)
  }

  // --- T21.16: the panel, and the toggle inside it -------------------------
  const panelShut = await page.evaluate(
    () => !!document.getElementById('options-panel')?.hidden,
  )
  if (!panelShut) fail('the options panel is open before anyone clicked Options')

  await page.evaluate(() => document.getElementById('escape-options')?.click())
  await sleep(150)
  const opened = await page.evaluate(() => {
    const panel = document.getElementById('options-panel')
    const btn = document.getElementById('options-quality')
    return { shown: panel ? !panel.hidden : false, label: btn?.textContent ?? '' }
  })
  if (!opened.shown) fail('clicking Options opened nothing')
  else ok(`the options panel opened, High Quality reads "${opened.label}"`)
  if (opened.label !== 'Off') {
    fail(`High Quality defaults to "${opened.label}" — it must default to Off, because the ` +
      `toggle exists for machines that cannot run shaders`)
  }
  await shot('options-panel')

  // **T21.36: the click is stored, and the renderer reads it live.**
  //
  // This used to assert that turning High Quality on left a patch of the field
  // unchanged, "because nothing reads it yet". Since T21.18 the cloud, beam, smoke,
  // fire and explosion shaders all read it, so that patch moved or not depending on
  // what was in it (red 6.5 in a gate, green 0.5 alone). **What the setting paints is
  // those five checks' claim**, each with a control frame. This check's claim is the
  // menu's: the click reaches storage, and a layer drawing *after* it reads the new
  // value without a restart — measured as beam quads painted by the ordnance layer.
  await page.evaluate(() => document.getElementById('options-quality')?.click())
  await sleep(150)
  const flipped = await page.evaluate(() => ({
    label: document.getElementById('options-quality')?.textContent ?? '',
    stored: localStorage.getItem('deepcut.highQuality'),
  }))
  if (flipped.label !== 'On') fail(`the toggle read "${flipped.label}" after a click`)
  if (flipped.stored !== '1') fail(`the click did not reach storage: deepcut.highQuality is ${JSON.stringify(flipped.stored)}`)
  else ok('one click turns High Quality On, and it is stored')

  // And it persists: re-opening reads the stored value rather than the default.
  await page.evaluate(() => document.getElementById('options-close')?.click())
  await sleep(120)
  await page.evaluate(() => document.getElementById('escape-options')?.click())
  await sleep(150)
  const reopened = await page.evaluate(
    () => document.getElementById('options-quality')?.textContent ?? '',
  )
  if (reopened !== 'On') fail(`re-opening options read "${reopened}", not the stored On`)
  else ok('the setting survives closing and re-opening the panel')
  await page.evaluate(() => document.getElementById('options-close')?.click())
  await sleep(120)
  await page.keyboard.press('Escape')
  await sleep(250)

  const onBeams = await beamQuadsAfterAShot()
  // The control, set from the same panel: Off must paint none, or "On painted some"
  // is a statement about a layer that ignores the setting.
  await page.keyboard.press('Escape')
  await sleep(250)
  await page.evaluate(() => document.getElementById('escape-options')?.click())
  await sleep(150)
  await page.evaluate(() => document.getElementById('options-quality')?.click())
  await sleep(120)
  const offLabel = await page.evaluate(() => document.getElementById('options-quality')?.textContent ?? '')
  await page.evaluate(() => document.getElementById('options-close')?.click())
  await sleep(120)
  await page.keyboard.press('Escape')
  await sleep(250)
  const offBeams = await beamQuadsAfterAShot()
  console.log(`  beam quads painted after a shot: High Quality On ${onBeams}, Off ${offBeams} (label "${offLabel}")`)
  if (onBeams === null || offBeams === null) {
    fail('no beam was drawn after ten shots, so "read live" was never measured')
  } else if (!(onBeams > 0) || offBeams !== 0 || offLabel !== 'Off') {
    fail(`the renderer did not follow the panel live: On painted ${onBeams} beam quad(s), Off painted ${offBeams}`)
  } else {
    ok(`the renderer follows the panel with no restart: On painted ${onBeams} beam quad(s), Off 0`)
  }

  // Back to the menu, as the section below expects to find it.
  await page.keyboard.press('Escape')
  await sleep(250)

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

// **Not `querySelector('canvas')`** (T20.13). Phaser's canvas element is created
// by the `Game`, not by a `Scene`, and it outlives every scene — so that probe was
// true over the blank page it was written to catch, and it stayed green while
// `?game=1` registered `GameScene` alone and `scene.start('Title')` left the page
// with **no running scene at all**. The title screen's own button is the thing
// that is absent when the quit fails, so wait for it.
const back = await page
  .waitForSelector('#start-game', { timeout: 15_000 })
  .then(() => true)
  .catch(() => false)
if (!back) fail('quitting did not reach the title screen — #start-game never appeared')
else ok('quit to title brought up the title screen')

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
