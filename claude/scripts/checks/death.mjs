#!/usr/bin/env node
/**
 * T10.06 — the death overlay, seen to appear in a running game.
 *
 *   node scripts/checks/death.mjs
 *   node scripts/e2e.mjs death
 *
 * ## Why this check exists as a separate thing
 *
 * The overlay's logic is unit-tested and its wiring reads correct, and that was
 * true for a whole session in which **it had never once been seen on screen**.
 * `docs/70-amendments-v2.md` §A39 is the pattern: five mechanisms on this project
 * were built, unit-tested and never wired, and no unit test can catch that,
 * because a unit test's premise is that it calls the unit itself.
 *
 * ## Why a synthetic `death` event cannot prove it
 *
 * The previous session fed the client a hand-made `death` payload through the
 * real handlers and the overlay stayed down. That was not a bug — it is the
 * design. `DeathOverlay.update` takes `dead` from the **snapshot's** alive flag
 * (§B4: "visibility follows the server's alive flag rather than the countdown
 * reaching zero"), so an injected event that the server never agreed with is
 * correctly ignored. Nothing short of a real death can raise it, which is
 * exactly the property worth having.
 *
 * So this kills the player for real, with their own rocket, and asserts on what
 * the player can see.
 *
 * The stack and the route into a battle are `harness.mjs` (§C18): this check
 * spent a session reporting "health 40 -> 40, the overlay never appeared" when
 * what had happened was that the round never started, because a room is a lobby
 * until someone asks.
 */
import {
  startStack,
  enterBattle,
  standStill,
  selectWeapon,
  tally,
  sleep,
  shotsDir,
} from './harness.mjs'
import { join } from 'node:path'

const PORT = 3117
const { fail, ok, failures } = tally('death')

// No bots: this check is about one player's death, and a bot landing the killing
// blow would change the attribution the cause line is asserted against.
const stack = await startStack({
  port: PORT,
  label: 'death',
  env: {
    ROUND_SECONDS: '120',
    BOT_COUNT: '0',
    DEV_LOADOUT: '1',
    // 20 health, so ONE clean rocket kills — exactly as `world_step`'s unit test
    // arranges 20 before firing once. The death is still entirely real: fired,
    // resolved by the server, attributed to the player. Only the starting health
    // is arranged. Without it this check is a coin flip, because each blast
    // deepens the crater so the next detonates further below you — eight rockets
    // against 100 health killed on some runs and left 22 on others.
    //
    // It was 40 (two rockets) until §C20 made standing still a precondition of
    // firing. Stopping between shots pushed the kill past 50 s, and the weather
    // schedule starts at EFFECT_INTERVAL_MIN (30 s) with no way to turn it off —
    // so the round killed the player before the rockets did and this check
    // reported `cause "Killed by weather"`, which reads as an attribution bug
    // rather than a slow fixture. One rocket lands inside the first 30 s.
    DEV_START_HEALTH: '20',
  },
})
const { page, dbg, pageErrors } = await stack.openClient({ name: 'ana' })
await enterBattle(page, { waitPlaying: true, label: 'death' })

/** Poll until `pred(debug())` or the deadline. */
async function until(pred, deadlineMs, what) {
  const started = Date.now()
  for (;;) {
    const d = await dbg()
    if (pred(d)) return d
    if (Date.now() - started > deadlineMs) {
      fail(`timed out waiting for ${what}`)
      return null
    }
    await sleep(200)
  }
}

// --- the control ----------------------------------------------------------
//
// Before killing anyone: the overlay must be **down** while alive. Without this,
// "the overlay is up after death" also passes for an overlay that is up always
// (§A26 — a test asserting a presence needs the absence, and vice versa).
const alive = await dbg()
if (alive.death.visible) fail('the overlay is up while the player is alive')
else ok('control: overlay is down while alive')

// --- kill the player, for real --------------------------------------------
//
// Aim at your own feet and fire. Self-damage is full (`docs/31` §2,
// `SELF_DAMAGE_MULT` 1.0), so this is a real death through the real fire path
// with real attribution — not a debug hook that zeroes health.
//
// Two things blunt a rocket at your own feet, both measured by T9.06: knockback
// throws you (it applies through everything — that is what makes rocket-jumping
// work) and a rocket fired airborne flies off instead of landing; and each blast
// deepens the crater so the next detonates further below you. Stepping sideways
// onto fresh ground before each shot restores the damage.
await selectWeapon(page, 'bazooka')
const startHealth = (await dbg()).health
if (startHealth > 60) fail(`DEV_START_HEALTH did not apply: ${startHealth}`)
else ok(`starting on ${startHealth} health`)
let switched = false
//
// Walk **further than the crater** between shots. A bazooka's blast radius is 42,
// so a 260 ms step (~39 px at WALK_SPEED 150) lands the next rocket inside the
// hole the last one dug, where it detonates below your feet for a fraction of the
// damage — measured by T9.06 at ~12 against ~25. 700 ms clears it.
//
// The loop runs to a deadline rather than a fixed count: at 8 rockets and
// variable terrain, a fixed 14 made this a coin flip, and a gate that fails on a
// coin flip gates nothing (§A28).
const killDeadline = Date.now() + 90_000
for (let i = 0; Date.now() < killDeadline; i++) {
  const d = await dbg()
  if (!d.player || d.health <= 0 || d.death.visible) break
  // When the stack empties, selection moves to the smg — and hitscan excludes
  // its owner (`docs/31` §4), so it cannot self-damage. Re-select the rockets
  // by name rather than by a hotkey: there used to be a *second* bazooka stack
  // at Digit3, and §C24 merged it into the first, so that press now selects the
  // mine. It went unnoticed because one rocket at 20 health ends the loop
  // before this line is reached.
  if (!switched && i >= 3) {
    switched = true
    await selectWeapon(page, 'bazooka')
  }
  // Alternate direction so a wall does not trap the walk on one side. Skipped
  // for the first shot: the crater that makes walking necessary does not exist
  // yet, and the clock matters now (see DEV_START_HEALTH above).
  if (i > 0) {
    const dir = i % 2 === 0 ? 'd' : 'a'
    await page.keyboard.down(dir)
    await sleep(700)
    await page.keyboard.up(dir)
  }
  for (let w = 0; w < 20 && !(await dbg()).player?.grounded; w++) {
    await sleep(200)
  }
  // §C20: standing still is now a precondition of firing, so stop before every
  // shot exactly as a player must. Without it the walk above refuses the rocket
  // it was setting up, the kill takes 100 s instead of 30, and the weather gets
  // there first — this check reported the cause line as "Killed by weather" and
  // read as an attribution bug.
  await standStill(page)
  // The camera follows the player, so a point below mid-screen is below the body
  // in world space whatever the camera has done.
  await page.mouse.move(640, 700)
  const hpBefore = (await dbg()).health ?? 0
  await page.evaluate('window.__game.fire()')
  // Wait for the rocket to *land*, not for 900 ms. The client steps a fixed
  // timestep off requestAnimationFrame, so a busy box simulates fewer ticks per
  // wall-clock second and a flat sleep lands fewer rockets inside the same
  // deadline — which is how this check failed in the suite while passing
  // standalone. Waiting on the effect makes load irrelevant instead of moving a
  // threshold (§A28); the cap is only so a dud shot cannot stall the loop.
  for (let w = 0; w < 24; w++) {
    const now = await dbg()
    if ((now.health ?? 0) < hpBefore || now.death?.visible) break
    await sleep(100)
  }
}

const dead = await until((d) => d.death.visible, 12_000, 'the death overlay to appear')
if (dead) {
  ok(`the overlay appeared — cause "${dead.cause ?? dead.death.cause}", health ${startHealth} → 0`)

  // The countdown is the reason §B4 puts `respawn_at` on the wire: a local timer
  // started when the event arrives is late by that event's own latency and stays
  // late. Assert it reads a plausible remaining time rather than a stopped clock.
  const secs = Number(String(dead.death.text).replace(/[^0-9.]/g, ''))
  if (!Number.isFinite(secs) || secs <= 0 || secs > 5.05) {
    fail(`countdown reads "${dead.death.text}", expected 0 < t <= RESPAWN_DELAY (5.0)`)
  } else {
    ok(`countdown reads ${dead.death.text}`)
  }

  if (/killed yourself/i.test(dead.death.cause)) ok(`cause: "${dead.death.cause}"`)
  else fail(`cause reads "${dead.death.cause}", expected the self-kill wording`)

  await page.screenshot({ path: join(shotsDir, 'death-overlay.png') })

  // §B8 — a grave where you fell, and one that is actually drawn.
  //
  // Two numbers, not one (§A39): the mirror's count against the layer's. They
  // were silently different for three milestones in the item layer, and
  // "the server placed a tombstone" passes the whole time.
  const g = await dbg()
  if (g.tombstones >= 1) ok(`the server placed ${g.tombstones} grave(s)`)
  else fail(`no tombstone after a death: ${g.tombstones}`)
  if (g.tombstonesDrawn === g.tombstones) {
    ok(`and all ${g.tombstonesDrawn} are drawn`)
  } else {
    fail(`${g.tombstones} graves tracked but ${g.tombstonesDrawn} drawn`)
  }

  // It is an overlay, not a pause: the world behind it must still be running.
  const t0 = (await dbg()).roundTime
  await sleep(1200)
  const t1 = (await dbg()).roundTime
  if (t1 > t0 + 0.5) ok(`the round kept running behind it (${t0.toFixed(1)}s → ${t1.toFixed(1)}s)`)
  else fail(`round time did not advance behind the overlay: ${t0} → ${t1}`)

  // The countdown must fall, not sit — a stopped clock also satisfies "0 < t <= 5".
  const later = Number(String((await dbg()).death.text).replace(/[^0-9.]/g, ''))
  if (Number.isFinite(later) && later < secs) ok(`countdown fell ${secs} → ${later}`)
  else if ((await dbg()).death.visible) fail(`countdown did not fall: ${secs} → ${later}`)

  // And it clears on respawn, driven by the server's alive flag.
  const cleared = await until((d) => !d.death.visible, 12_000, 'the overlay to clear on respawn')
  if (cleared) {
    ok('the overlay cleared on respawn')
    // Wait on the effect being asserted, not on a neighbouring one. The overlay
    // clears on the snapshot's `alive` flag and health arrives in the snapshot
    // body; reading health out of the sample that reported the clear assumes
    // both land together. They usually do, which is why this passed for months
    // and failed once under a loaded suite run.
    const healed = await until((d) => (d.health ?? 0) > 0, 5_000, 'respawn health to arrive')
    if (healed) ok(`respawned with ${healed.health} health`)
    else fail(`respawned with ${(await dbg()).health} health`)
  }
} else {
  const d = await dbg()
  console.error(`  health ${startHealth} → ${d.health}, alive-flag dead=${!d.death.visible}`)
  await page.screenshot({ path: join(shotsDir, 'FAILED-death.png') })
}

if (pageErrors.length) fail(`page errors: ${pageErrors.join(' | ')}`)
else ok('no page errors')

await stack.close()
console.log(failures.length ? `\ndeath: ${failures.length} FAILED` : '\ndeath: ok')
process.exit(failures.length ? 1 : 0)
