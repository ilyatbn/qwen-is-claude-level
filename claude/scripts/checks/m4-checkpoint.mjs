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
import { simClock } from './sim-clock.mjs'

export default async function ({ page, shot, log }) {
  const inv = () => page.evaluate(() => window.__game.inventory())
  const solid = () =>
    page.evaluate(() => {
      const v = window.__game.core.maskView()
      let n = 0
      for (let i = 0; i < v.length; i++) { let b = v[i]; while (b) { n += b & 1; b >>= 1 } }
      return n
    })

  /**
   * **The sandbox's own clock, not the wall's** — see `sim-clock.mjs` for the
   * measurement. Every wait below that is waiting for the *simulation* to do
   * something is paced by this; the ones waiting for a render or an input round
   * trip are still `waitForTimeout`, because that is the browser's work.
   */
  const sim = simClock(page)

  /**
   * Where the player is drawn, in screen space.
   *
   * The aim below used to be written as an offset from `(640, 360)` — the
   * middle of the 1280x720 viewport — on the assumption that the player is at
   * the centre of it. They are not: measured on this seed, the body is drawn at
   * **(512, 334)**, so `(640 + 300, 360)` is not "sideways", it is a few degrees
   * below the horizontal into the wall the player is standing beside. See the
   * SMG section for what that cost. `shieldBubble` below already derives this
   * the correct way; this is the same arithmetic, shared rather than copied.
   */
  const screenPos = () =>
    page.evaluate(() => {
      const g = window.__game
      const me = g.core.playerState(0)
      const raw = g.debug().worldView
      const v = { x: raw.x, y: raw.y, w: raw.width ?? raw.w, h: raw.height ?? raw.h }
      const r = document.querySelector('canvas').getBoundingClientRect()
      return {
        x: r.left + ((me.x - v.x) / v.w) * r.width,
        y: r.top + ((me.y - v.y) / v.h) * r.height,
      }
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
  const me = await screenPos()
  await page.mouse.move(me.x, me.y + 200)
  await page.waitForTimeout(200)

  const before = await solid()
  const ev = await page.evaluate(() => window.__game.fire())
  log(`fire -> ${JSON.stringify(ev).slice(0, 120)}`)
  if (ev.rejected) throw new Error(`fire rejected: ${ev.rejected}`)
  if (!ev.projectile) throw new Error('the bazooka spawned no projectile')
  // **Anchored on the shot being accepted, not on the send.** `fire_ready_at` is
  // per player and is set to `now + cooldown` from the sandbox's own clock
  // (`PlayerState::try_fire_slot`), so the SMG below cannot be fired until that
  // many *simulated* seconds have passed — whatever the wall says. Sampled here
  // rather than before `fire()`, because anchoring before the action is
  // optimistic and reds on its own.
  const firedAt = await sim.now()

  // Let it fly and explode — **in the sandbox's seconds, and on the effect**.
  // This was `waitForTimeout(1200)`, which is 1200 ms of wall clock; see
  // `sim-clock.mjs` for the 0.06 ratio that measured. The budget is this check's own,
  // not a shipped tunable: a rocket fired into the floor at the muzzle detonates
  // within a frame or two, and 1.2 simulated seconds is two orders of magnitude
  // of slack on that.
  const CRATER_BUDGET_S = 1.2
  const carved = await sim.until(
    async () => (await solid()) < before,
    CRATER_BUDGET_S,
    'the bazooka crater',
  )
  if (!carved) {
    throw new Error(
      `no crater after ${CRATER_BUDGET_S}s of SIMULATED time — the rocket never went off`,
    )
  }
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
  // **Aim into open air, from where the player actually is.** The bazooka above
  // fires at the player's own feet — that is the rocket-jump case it is testing
  // — so the SMG has to be aimed somewhere else before it is fired. Two things
  // were wrong with how it was:
  //
  // 1. The aim was `(640 + 300, 360)`, an offset from the middle of the
  //    viewport. The player is drawn at **(512, 334)** on this seed, so that
  //    point is *below* the horizontal, not level with it — see `screenPos`.
  // 2. Dead level is into a wall. Traced frame by frame for T21.23: at that
  //    angle the round spawns at x=274 and is gone in **0 frames** — it dies
  //    inside the same `combat_step` that spawned it, so `syncProjectiles` never
  //    sees it and nothing can ever observe it in flight. Up and to the right it
  //    lives 6 frames, crossing 278→325 px, and still carves 21 px when it
  //    lands. The assertion below had a nought-to-three frame window to hit; on
  //    a busy box it missed, and reported "no round in the air" about a shot
  //    that was fired correctly.
  const from = await screenPos()
  await page.mouse.move(from.x + 300, from.y - 300)
  await page.waitForTimeout(200)
  const beforeSmg = await solid()

  // **Wait out the bazooka's cooldown in the clock that spends it.** The old
  // `waitForTimeout(1200)` after the rocket happened to cover this as a side
  // effect; waiting on the crater instead returns as soon as the rocket lands,
  // which is sooner, so the cooldown now has to be waited for on purpose. It is
  // counted in `world`/sandbox seconds, so that is what it is waited in — the
  // shape T21.22b arrived at for the same rejection on the networked path.
  const cd = await page.evaluate(() => window.__game.constants().BAZOOKA_COOLDOWN)
  // Guard the constant before trusting it: a missing key is `undefined`, and
  // every comparison against `undefined` is false, so the wait below would fall
  // through instantly and the rejection would come back looking like a game bug.
  if (typeof cd !== 'number' || !(cd > 0)) {
    throw new Error(`BAZOOKA_COOLDOWN is not exposed to the client (got ${cd})`)
  }
  const cooled = await sim.until(
    async () => (await sim.now()) - firedAt > cd,
    cd * 4,
    "the bazooka's cooldown",
  )
  if (!cooled) throw new Error(`the sandbox clock never advanced ${cd}s past the rocket`)

  // **Latched in the page, on every animation frame, from before the trigger.**
  // The layer is filled from the mirror once per frame, and a round is only in
  // it for a handful of frames. The old code polled from node —
  // `waitForFunction` on one round trip, then `ordnance()` on a *second* — so
  // the value asserted on was re-read after the wait that proved it, and both
  // trips have to land inside the same few frames. This latches the high-water
  // mark where the frames are, so a single drawn frame cannot be missed, and
  // nothing is re-read.
  await page.evaluate(() => {
    const w = window
    w.__m4SmgPeak = 0
    const tick = () => {
      const n = w.__game.ordnance().projectiles
      if (n > w.__m4SmgPeak) w.__m4SmgPeak = n
      w.__m4SmgRaf = requestAnimationFrame(tick)
    }
    w.__m4SmgRaf = requestAnimationFrame(tick)
  })

  const smg = await page.evaluate(() => window.__game.fire())
  if (!smg.projectile) throw new Error(`the smg did not fire: ${JSON.stringify(smg)}`)

  // Wait for the round to land, and pace it by the **sandbox's** clock. The
  // budget is the constants' own flight time — range/speed — rather than a
  // literal, so it tracks the speed instead of expiring against it (§A19); what
  // changed for T21.23 is the clock it is spent in. As `Date.now()` it was
  // 1375 ms of wall, which under load buys 83 ms of simulation. Polled with the
  // same `solid()` the crater half uses, so both halves measure the mask the
  // same way.
  const k = await page.evaluate(() => window.__game.constants())
  const flightS = k.SMG_RANGE / k.SMG_MUZZLE_SPEED + 0.5
  let afterSmg = beforeSmg
  await sim.until(
    async () => {
      afterSmg = await solid()
      return afterSmg < beforeSmg
    },
    flightS,
    'the smg round landing',
  )

  const peak = await page.evaluate(() => {
    cancelAnimationFrame(window.__m4SmgRaf)
    return window.__m4SmgPeak
  })
  const ord = await page.evaluate(() => window.__game.ordnance())
  log(`ordnance layer: peak ${peak} projectile(s) drawn in flight; now ${JSON.stringify(ord)}`)
  if (peak < 1) throw new Error('the smg put no round in the air — every shot must be visible')
  log(`smg: dug ${beforeSmg - afterSmg} px after flight`)
  if (beforeSmg - afterSmg <= 0) throw new Error('the smg round left no mark')

  await shieldBubble({ page, shot, log, screenPos })
}

// --- the shield bubble, on your own body (T20.08) ---------------------------
//
// Its own function, called from the end of the default export, so the crater half
// above is untouched and a failure here names itself.
async function shieldBubble({ page, shot, log, screenPos }) {
  await page.evaluate(() => window.__game.regenerate('12345', 'medium'))
  await page.waitForTimeout(500)

  // Where the player is drawn, in screen space, so the patch follows the camera
  // rather than a coordinate that expires the next time the spawn moves.
  //
  // **`screenPos` is the caller's, not a second copy.** This projection was
  // written out twice, and the other user of it — the SMG aim — was written with
  // a *third* answer, `(640, 360)`, which is what put that shot into a wall
  // (T21.23). One function, so a body drawn somewhere new moves both.
  const at = await screenPos()
  const rect = { x: Math.round(at.x - 40), y: Math.round(at.y - 60), w: 80, h: 80 }

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
