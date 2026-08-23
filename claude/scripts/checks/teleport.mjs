#!/usr/bin/env node
/**
 * T15.01 / §C5 — teleport pads, in a real round.
 *
 *   node scripts/checks/teleport.mjs
 *   node scripts/e2e.mjs teleport
 *
 * The unit tests in `world::teleport`, `player::respawn` and `map::meta` prove
 * the rules. This proves the parts they cannot reach.
 *
 * ## It gets onto a pad by dying, not by walking
 *
 * The first version walked the player across the map to the nearest pad, and it
 * was a coin flip: on some runs the terrain between them was a chasm and the
 * check reported "could not reach pad 0" — a true statement about the map with
 * nothing to say about §C5. **A gate that fails on a coin flip gates nothing.**
 *
 * Dying is both more reliable and a better test, because §C5's respawn rule
 * lands you *on a pad* by construction. So: one rocket at your own feet, and the
 * respawn is the subject of every assertion below. Nothing here depends on the
 * shape of the terrain.
 *
 * The arming rule then has a real subject — a player who genuinely has not moved
 * since spawning — and a **jump** is what arms them, which needs no ground but
 * the pad's own.
 *
 * ## What it asserts
 *
 *   1. **Both ends** (§A39): six pads on the wire, six drawn. One number would
 *      have passed for a renderer with no caller — twelve of those have shipped.
 *   2. **Respawn lands on a pad**, from the client's own view of its position.
 *   3. **Arming**: standing still on the respawn pad does nothing. The absence.
 *   4. **The presence**: jump (which arms), stand, and the pad fires — to a
 *      different pad.
 *   5. **It is on the screen** (§C2): the same rect at two moments, uncharged and
 *      charging, with a control rect in terrain that must not move between them.
 */
import { samplePatch, colourDelta } from './pixels.mjs'
import { startStack, enterBattle, tally, sleep, standStill, selectWeapon } from './harness.mjs'

const PORT = 3131
const { fail, ok, finish } = tally('teleport')

const stack = await startStack({
  port: PORT,
  label: 'teleport',
  env: {
    ROUND_SECONDS: '300',
    // No bots: one wandering onto a pad would fire it and move the subject of
    // every assertion here.
    BOT_COUNT: '0',
    MAP_SCALE: 'small',
    DEV_LOADOUT: '1',
    // Low, so the kill loop below is short. It is still an entirely real death:
    // fired, resolved by the server, attributed. Only the starting health is
    // arranged — the same thing `death.mjs` does and for the same reason.
    DEV_START_HEALTH: '20',
  },
})
const { page, dbg, shot, pageErrors } = await stack.openClient({ name: 'ana' })
await enterBattle(page, { waitPlaying: true, label: 'teleport' })
await standStill(page)

const k = await page.evaluate(() => window.__game.constants())

/** Poll `pred` to a deadline. Never a flat sleep — see §A28. */
async function until(pred, deadlineMs, what) {
  const end = Date.now() + deadlineMs
  while (Date.now() < end) {
    const d = await dbg()
    if (pred(d)) return d
    await sleep(100)
  }
  fail(`timed out after ${deadlineMs / 1000} s waiting for ${what}`)
  return null
}

// --- 1. both ends -----------------------------------------------------------
const d0 = await dbg()
if (d0.pads !== k.TELEPORT_PADS) {
  fail(`map_init carried ${d0.pads} pads, expected TELEPORT_PADS (${k.TELEPORT_PADS})`)
} else {
  ok(`map_init carried all ${d0.pads} pads`)
}
if (d0.padsDrawn !== d0.pads) {
  fail(`${d0.pads} pads on the wire but ${d0.padsDrawn} drawn — the layer has no caller`)
} else {
  ok(`and the client drew all ${d0.padsDrawn} of them`)
}

/** World point → screen point, through the live camera (never a fixed pixel). */
async function toScreen(wx, wy) {
  return page.evaluate(
    ([x, y]) => {
      const raw = window.__game.debug().worldView
      const v = { x: raw.x, y: raw.y, w: raw.width ?? raw.w, h: raw.height ?? raw.h }
      const cv = document.querySelector('canvas')
      const r = cv.getBoundingClientRect()
      return {
        x: r.left + ((x - v.x) / v.w) * r.width,
        y: r.top + ((y - v.y) / v.h) * r.height,
        scale: r.width / v.w,
      }
    },
    [wx, wy],
  )
}

// --- 2. die, and respawn on a pad -------------------------------------------
//
// A **loop**, not one rocket, and for the reason `death.mjs` records: each blast
// deepens the crater under you, so the next detonates further away and does less.
// One shot killed on some runs and left 20 health on others, which is the coin
// flip this whole restructure was meant to remove.
const killDeadline = Date.now() + 90_000
for (let i = 0; Date.now() < killDeadline; i++) {
  const d = await dbg()
  if (!d.player || d.health <= 0 || d.death?.visible) break
  // The stack empties into the smg, and hitscan excludes its owner
  // (`docs/31` §4), so it cannot self-damage. Re-select by name.
  if (i > 0 && i % 3 === 0) await selectWeapon(page, 'bazooka')
  // Step aside so the next rocket lands on ground rather than in the last hole.
  if (i > 0) {
    const dir = i % 2 === 0 ? 'd' : 'a'
    await page.keyboard.down(dir)
    await sleep(500)
    await page.keyboard.up(dir)
  }
  for (let w = 0; w < 20 && !(await dbg()).player?.grounded; w++) await sleep(200)
  // §C20: standing still is a precondition of firing.
  await standStill(page)
  // Below mid-screen is below the body in world space whatever the camera did.
  await page.mouse.move(640, 700)
  const hpBefore = (await dbg()).health ?? 0
  await page.evaluate('window.__game.fire()')
  // Wait for the rocket to **land**, not for a flat 900 ms: the client steps off
  // requestAnimationFrame, so a loaded box lands fewer rockets per second and a
  // fixed sleep makes this a measurement of the box (§A28).
  for (let w = 0; w < 24; w++) {
    const now = await dbg()
    if ((now.health ?? 0) < hpBefore || now.death?.visible) break
    await sleep(100)
  }
}

const died = await until((d) => d.health <= 0 || d.death?.visible, 20_000, 'the player to die')
if (!died) {
  fail('the player never died, so no respawn could be observed')
} else {
  ok('killed by their own rocket')
}

// `alive` again, and then let the body settle onto the pad.
const back = await until((d) => d.health > 0 && !d.death?.visible, 30_000, 'the respawn')
if (back) {
  await until((d) => d.player?.grounded, 10_000, 'the respawned body to land')
}

const afterRespawn = await dbg()
if (afterRespawn.onPad === null || afterRespawn.onPad === undefined) {
  fail(
    `respawned at (${afterRespawn.player.x.toFixed(0)}, ${afterRespawn.player.y.toFixed(0)}), ` +
      `which is no pad — §C5 says a death puts you on one. Pads: ` +
      JSON.stringify(afterRespawn.padPositions),
  )
} else {
  ok(`respawned standing on pad ${afterRespawn.onPad}`)
}
await shot('teleport-respawned')

const home = afterRespawn.padPositions?.find((p) => p.id === afterRespawn.onPad)

// --- 3. arming: the absence -------------------------------------------------
//
// This player has not moved since spawning, and they are standing on a pad. That
// is exactly the case §C5's arming rule exists for, and the only moment in the
// round it can be observed.
if (home) {
  const before = (await dbg()).player
  await standStill(page)
  await sleep(k.TELEPORT_CHARGE * 2500)
  const after = await dbg()
  const moved = Math.hypot(after.player.x - before.x, after.player.y - before.y)
  if (moved > k.PAD_W) {
    fail(
      `a player who has not moved since spawning was teleported ${moved.toFixed(0)} px ` +
        `after ${(k.TELEPORT_CHARGE * 2.5).toFixed(1)} s on pad ${afterRespawn.onPad}`,
    )
  } else if (after.teleportCharge > 0.05) {
    fail(`an unarmed pad accumulated ${(after.teleportCharge * 100).toFixed(0)}% of a charge`)
  } else {
    ok(
      `standing still on the respawn pad for ${(k.TELEPORT_CHARGE * 2.5).toFixed(1)} s did nothing`,
    )
  }
}

// --- 4 + 5. the presence, and the pixels ------------------------------------
if (!home) {
  fail('no home pad, so the firing half of this check cannot run')
} else {
  // The rect: the ellipse's right lobe, clear of the player sprite. The pad is
  // `PAD_W` (40) wide and the body `PLAYER_W` (16), so 0.4 × PAD_W off centre is
  // outside the player and inside the ring.
  const rectAt = async (wx, wy) => {
    const s = await toScreen(wx, wy)
    const w = Math.max(10, k.PAD_W * 0.36 * s.scale)
    const h = Math.max(10, k.PAD_H * 2.2 * s.scale)
    return { x: s.x - w / 2, y: s.y - h / 2, w, h }
  }
  const padRect = () => rectAt(home.x + k.PAD_W * 0.4, home.y)
  // The control: **inside the ground below the pad**, not sky. An earlier
  // version used open sky and it failed honestly — the sky animates (§A4's
  // cycle, the sun, the stars) and moved 5.0 between the two frames on its own.
  // Terrain does not animate and nothing carves it here.
  const ctrlRect = () => rectAt(home.x + k.PAD_W * 0.4, home.y + k.PAD_H * 6)

  // Frame A: on the pad, unarmed, nothing drawn but the idle ring.
  const padA = await samplePatch(page, await padRect())
  const ctrlA = await samplePatch(page, await ctrlRect())
  await shot('teleport-uncharged')

  // Arm by **jumping**: `JUMP_VELOCITY` gives an apex around 66 px, comfortably
  // past `TELEPORT_ARM_DISTANCE` (32), and it lands back on the same pad — so it
  // needs no ground but the pad's own, unlike a walk, which is an assumption
  // about the terrain.
  //
  // Held for 250 ms rather than `keyboard.press`: the client samples input once
  // per frame, and a press whose down and up land inside one frame is never seen
  // held. That is exactly what happened — the charge stayed at 0 and the check
  // reported "jumping did not arm the pad", which was true of the keystroke
  // rather than of the game.
  const yBeforeJump = (await dbg()).player.y
  await page.keyboard.down('Space')
  await sleep(250)
  await page.keyboard.up('Space')
  const airborne = await until(
    (d) => Math.abs(d.player.y - yBeforeJump) >= k.TELEPORT_ARM_DISTANCE,
    8_000,
    `the jump to clear TELEPORT_ARM_DISTANCE (${k.TELEPORT_ARM_DISTANCE} px)`,
  )
  if (!airborne) {
    fail('the jump never left the ground, so nothing below is about the arming rule')
  }
  await until((d) => d.player?.grounded, 8_000, 'the jump to land')
  await standStill(page)

  let peak = 0
  let padB = null
  let ctrlB = null
  const before = (await dbg()).player
  let moved = null
  const deadline = Date.now() + k.TELEPORT_CHARGE * 1000 * 8
  while (Date.now() < deadline) {
    const d = await dbg()
    if (d.teleportCharge > peak) peak = d.teleportCharge
    // Frame B: the arc is well past half. Grabbed inside the loop, because the
    // charge is gone the tick it fires.
    if (padB === null && d.teleportCharge > 0.5) {
      padB = await samplePatch(page, await padRect())
      ctrlB = await samplePatch(page, await ctrlRect())
      await shot('teleport-charging')
    }
    const dist = Math.hypot(d.player.x - before.x, d.player.y - before.y)
    // A teleport is to another pad, and pads are `SPAWN_MIN_SEPARATION`-ish
    // apart; nothing else in this scene moves a standing player that far.
    if (dist > k.PAD_W * 4) {
      moved = { dist, to: { x: d.player.x, y: d.player.y }, onPad: d.onPad }
      break
    }
    await sleep(80)
  }

  if (peak <= 0) {
    fail('the charge never left zero — jumping did not arm the pad')
  } else {
    ok(`after a jump, the charge climbed to ${(peak * 100).toFixed(0)}%`)
  }

  if (padB === null) {
    fail('the charge never passed 50%, so the pad was never sampled while drawn')
  } else {
    const padDelta = colourDelta(padA, padB)
    const ctrlDelta = colourDelta(ctrlA, ctrlB)
    if (ctrlDelta > 4) {
      fail(
        `the control patch moved by ${ctrlDelta.toFixed(1)} between the two frames — ` +
          'something global changed, so the pad delta is not evidence',
      )
    } else if (padDelta < 8) {
      fail(
        `the pad's pixels changed by only ${padDelta.toFixed(1)} while the charge went ` +
          `0 -> ${(peak * 100).toFixed(0)}% — the indicator is not on the screen`,
      )
    } else {
      ok(
        `the charge indicator is drawn: the pad's pixels moved ${padDelta.toFixed(1)}, ` +
          `a terrain control moved ${ctrlDelta.toFixed(1)}`,
      )
    }
  }

  if (!moved) {
    const d = await dbg()
    fail(
      `stood on pad ${home.id} for ${(k.TELEPORT_CHARGE * 8).toFixed(0)} s and was never ` +
        `moved (charge peaked at ${(peak * 100).toFixed(0)}%, onPad ${d.onPad})`,
    )
  } else {
    ok(`the pad fired: moved ${moved.dist.toFixed(0)} px`)
    await shot('teleport-arrived')
    // It landed on a pad, and a different one.
    const settled = await until((d) => d.onPad !== null, 6_000, 'the arrival to settle on a pad')
    const landedOn = settled ? settled.onPad : moved.onPad
    if (landedOn === null || landedOn === undefined) {
      fail(
        `the teleport landed at (${moved.to.x.toFixed(0)}, ${moved.to.y.toFixed(0)}), which is no pad`,
      )
    } else if (landedOn === home.id) {
      fail('the teleport landed back on the pad it started from')
    } else {
      ok(`and it is a different pad (${home.id} -> ${landedOn})`)
    }
  }
}

if (pageErrors.length) fail(`page errors: ${pageErrors.slice(0, 3).join(' | ')}`)
else ok('no page errors')

await finish(() => stack.close())
