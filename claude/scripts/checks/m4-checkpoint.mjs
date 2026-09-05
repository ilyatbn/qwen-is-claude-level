/**
 * The M4 checkpoint, driven headlessly: pick up a bazooka, fire it, watch the
 * crater form, take self-damage, and open the inventory on right-click.
 *
 * **Plus the shield bubble** (T20.08), which lives here because this is the
 * sandbox check that already has a player standing still on known ground and a
 * screenshot habit. It is a **rendered-pixel** assertion for a reason: the bubble
 * was drawn for every remote player and hardcoded `shield: false` for the local
 * one in *both* scenes, so the one player who needs to know they are protected
 * has never seen it — an "I cannot see it" bug that no simulation assertion could
 * have caught.
 */
import { samplePatch, colourDelta } from './pixels.mjs'

export default async function ({ page, shot, log }) {
  const inv = () => page.evaluate(() => window.__game.inventory())
  const solid = () =>
    page.evaluate(() => {
      const v = window.__game.core.maskView()
      let n = 0
      for (let i = 0; i < v.length; i++) { let b = v[i]; while (b) { n += b & 1; b >>= 1 } }
      return n
    })

  await page.evaluate(() => window.__game.regenerate('12345', 'medium'))
  await page.waitForTimeout(500)

  const start = await inv()
  log(`inventory at start: ${start.slots.filter(Boolean).map((s) => `${s.key} x${s.count}`).join(', ')}`)
  if (!start.slots.some((s) => s && s.key === 'bazooka')) throw new Error('no bazooka')
  log(`health ${start.health}`)

  // Straight down, into the ground at my own feet: the rocket spawns MUZZLE_OFFSET
  // below centre, which is at or inside the floor, so it goes off well within its
  // own 42 px blast radius. This is the rocket-jump case.
  await page.mouse.move(640, 360 + 200)
  await page.waitForTimeout(200)

  const before = await solid()
  const ev = await page.evaluate(() => window.__game.fire())
  log(`fire -> ${JSON.stringify(ev).slice(0, 120)}`)
  if (ev.rejected) throw new Error(`fire rejected: ${ev.rejected}`)
  if (!ev.projectile) throw new Error('the bazooka spawned no projectile')

  // Let it fly and explode.
  await page.waitForTimeout(1200)
  const after = await solid()
  const now = await inv()
  log(`terrain solid ${before} -> ${after}  (crater removed ${before - after} px)`)
  log(`health ${start.health} -> ${now.health}`)
  await shot('m4-crater')

  if (!(after < before)) throw new Error('firing a bazooka carved nothing')
  if (!(before - after > 2000)) throw new Error(`crater too small: ${before - after} px`)
  if (!(now.health < start.health)) throw new Error('no self-damage from a rocket at my own feet')
  if (now.slots.find((s) => s && s.key === 'bazooka').count !== 3) {
    throw new Error('ammo was not consumed')
  }
  log('self-damage and ammo consumption both confirmed')

  // Right-click opens the inventory panel.
  const open = await page.evaluate(() => window.__game.toggleInventory())
  if (!open) throw new Error('the inventory did not open')
  await page.waitForTimeout(200)
  await shot('m4-inventory')
  log('inventory panel open')

  // SMG: a visible round, and it digs.
  //
  // **A bullet, not a tracer, since §F1.** `fire()` returned `{hitscan: [...]}`
  // and the shot resolved in the tick it was fired; it returns `{projectile}`
  // now and the round has to *fly* to the wall before it digs. So the dig is
  // asserted after stepping the sim rather than on the next line — a check that
  // measured the mask immediately would read 0 px and call it a regression.
  await page.evaluate(() => window.__game.toggleInventory())
  // **By key, not by index.** §F5 puts a shovel in slot 0 of every player, which
  // moved the sandbox loadout one slot along: `selectSlot(2)` was the smg and is
  // now the grenade — which is also a projectile, so the assertion below would
  // have gone on passing while measuring the wrong weapon.
  await page.evaluate(() => {
    const inv = window.__game.inventory()
    const i = inv.slots.findIndex((s) => s && s.key === 'smg')
    if (i < 0) throw new Error(`no smg in the sandbox loadout: ${JSON.stringify(inv.slots)}`)
    window.__game.selectSlot(i)
  })
  // **Aim sideways first.** The bazooka above fires at the player's own feet —
  // that is the rocket-jump case it is testing — and the mouse was never moved
  // afterwards, so the SMG fired into the ground 18 px below the muzzle. A
  // hitscan round did not care: it resolved instantly and drew a tracer. A
  // bullet (§F1) explodes on its first step and is never airborne for a single
  // frame, so "no round in the air" was a true reading of a shot with nowhere
  // to go.
  await page.mouse.move(640 + 300, 360)
  await page.waitForTimeout(200)
  const beforeSmg = await solid()
  const smg = await page.evaluate(() => window.__game.fire())
  if (!smg.projectile) throw new Error(`the smg did not fire: ${JSON.stringify(smg)}`)
  // **Waited for, not read once.** The layer is filled from the mirror on the
  // next frame, so reading it in the same turn as `fire()` samples the instant
  // before the round exists. Measured: this read 0 in the full suite while
  // passing standalone, which is what a race looks like.
  await page
    .waitForFunction('window.__game.ordnance().projectiles > 0', null, { timeout: 3000 })
    .catch(() => {})
  const ord = await page.evaluate(() => window.__game.ordnance())
  log(`ordnance layer: ${JSON.stringify(ord)}`)
  if (ord.projectiles < 1) throw new Error('the smg put no round in the air — every shot must be visible')
  // Wait for it to land. The deadline comes from the constants — flight time is
  // range/speed — rather than a literal, so it tracks the speed instead of
  // expiring against it (§A19). Polled with the same `solid()` the crater half
  // uses, so both halves measure the mask the same way.
  const k = await page.evaluate(() => window.__game.constants())
  const flightMs = (k.SMG_RANGE / k.SMG_MUZZLE_SPEED) * 1000 + 500
  const deadline = Date.now() + Math.ceil(flightMs)
  let afterSmg = beforeSmg
  while (Date.now() < deadline) {
    afterSmg = await solid()
    if (afterSmg < beforeSmg) break
    await page.waitForTimeout(50)
  }
  log(`smg: dug ${beforeSmg - afterSmg} px after flight`)
  if (beforeSmg - afterSmg <= 0) throw new Error('the smg round left no mark')

  await shieldBubble({ page, shot, log })
}

// --- the shield bubble, on your own body (T20.08) ---------------------------
//
// Its own function, called from the end of the default export, so the crater half
// above is untouched and a failure here names itself.
async function shieldBubble({ page, shot, log }) {
  await page.evaluate(() => window.__game.regenerate('12345', 'medium'))
  await page.waitForTimeout(500)

  // Where the player is drawn, in screen space, so the patch follows the camera
  // rather than a coordinate that expires the next time the spawn moves.
  const rect = await page.evaluate(() => {
    const g = window.__game
    const me = g.core.playerState(0)
    const raw = g.debug().worldView
    const v = { x: raw.x, y: raw.y, w: raw.width ?? raw.w, h: raw.height ?? raw.h }
    const cv = document.querySelector('canvas')
    const r = cv.getBoundingClientRect()
    const sx = r.left + ((me.x - v.x) / v.w) * r.width
    const sy = r.top + ((me.y - v.y) / v.h) * r.height
    return { x: Math.round(sx - 40), y: Math.round(sy - 60), w: 80, h: 80 }
  })

  // A far patch, which must be sampled **over the same window as the subject** —
  // both endpoints straddling the grant. It was not: `cBefore` and `cAfter` were
  // both taken *after* the generator was handed over, 200 ms apart, so the
  // "control" measured a different 200 ms from the one the subject spans. The
  // 9.9-vs-1.3 margin made it moot in practice and the code still did not do what
  // its own comment said, which is a drift this repo has been bitten by six times.
  const controlRect = { x: rect.x + 320, y: rect.y, w: rect.w, h: rect.h }

  // **The control frame**: the same patch with no generator. Without it "there
  // are blue pixels here" is satisfied by the sky.
  const before = await samplePatch(page, rect)
  const cBefore = await samplePatch(page, controlRect)
  const shieldedBefore = await page.evaluate(() => window.__game.core.shieldActive(0))
  if (shieldedBefore) throw new Error('the sandbox player starts shielded — the control is void')

  const on = await page.evaluate(() => window.__game.giveShieldGenerator())
  if (!on) throw new Error('a granted generator and a full battery did not shield the player')
  await page.waitForTimeout(200)
  const after = await samplePatch(page, rect)
  const cAfter = await samplePatch(page, controlRect)
  await shot('shield-bubble')

  const moved = colourDelta(before, after)
  const controlMoved = colourDelta(cBefore, cAfter)

  log(`shield bubble: the player patch moved ${moved.toFixed(1)}, control ${controlMoved.toFixed(1)}`)
  if (controlMoved >= moved) {
    throw new Error(
      `the control region moved ${controlMoved.toFixed(1)} against the player's ` +
        `${moved.toFixed(1)} — the frame is changing everywhere, so nothing is attributable`,
    )
  }
  // 4, not 2: the falsification measured **1.3** of idle animation over the same
  // window with the bubble off, against 9.9 with it on. A threshold at 2 sits two
  // units from the noise; this one has margin in both directions.
  if (moved < 4) {
    throw new Error(
      `carrying a shield generator changed the player by ${moved.toFixed(1)} pixels — the ` +
        'bubble is not drawn on your own body (it was hardcoded `shield: false`)',
    )
  }
}
