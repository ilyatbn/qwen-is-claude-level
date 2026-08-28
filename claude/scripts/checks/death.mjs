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
//
// **`FIXED_SEED` so the terrain is the same every run.** This is a *mechanism*
// check — does dying raise the overlay, place a tombstone, and leave the round
// running — and none of it is a claim about maps in general, so one map is the
// right amount of map. Unpinned it drew a new one every run and failed roughly
// one in five: the player needs ground thick enough to rocket its own feet
// without the crater reaching the void that T15.02 put under the floor, and
// picking that by luck is how a gate becomes a coin flip. The pad and terrain
// population claims live in Rust, across every scale and more than one seed.
//
// **4242 specifically**: measured, it spawns the player on **704 px** of solid
// rock. Seed 1 spawns them on the 16 px `FLOOR_CRUST` itself and seed 7 on 19 px
// — both pass today, and both are one crater away from the rocket digging
// through to the void and the cause line reading "You fell out of the world"
// instead of "You killed yourself", which is the 2-in-8 this check was failing
// before it was pinned. The seed is chosen for depth under the feet, not because
// it is the one that happened to go green.
const stack = await startStack({
  port: PORT,
  label: 'death',
  env: {
    FIXED_SEED: '4242',
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
    // **1, not 20.** 20 was chosen so one *clean* rocket kills — but the
    // failure this check has always had is that the rocket is not clean: on a
    // ledge it flies past the feet, detonates far below and lands a fraction of
    // the damage. Measured here, health fell 20 -> 10 and the loop ran out of
    // clock, which is why the overlay was never told: **the player never died.**
    //
    // The check's own notes record it at 6 of 8, and two attempts to make the
    // rocket cleaner both made it worse. So make the damage sufficient instead
    // of making the aim perfect: at 1 health any real hit is lethal, and the
    // death is still fired, resolved and attributed by the server through the
    // same path. The `killed yourself` assertion below is what stops this
    // passing on a *different* death.
    DEV_START_HEALTH: '1',
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

/**
 * The overlay reading, captured the first time **any** poll sees it up.
 *
 * §B4 keeps the overlay up for `RESPAWN_DELAY` (5 s) and then the respawn clears
 * it. This check's choreography between shots — a 700 ms walk, a grounded wait of
 * up to 4 s, `standStill`, then up to 2.4 s waiting for the rocket — can exceed
 * that on a slow box, so the whole death-and-respawn could happen between two
 * samples. It did: a run reported `death events 1 (1 mine), hasInfo=false,
 * respawns 1, health 20 → 100` — the player had died, the overlay had come up,
 * and the respawn had taken it down again before anything looked.
 *
 * So the reading is **latched** rather than polled for afterwards. It is the same
 * lesson `quick-throw` learned about counting projectile spawns: a state that
 * exists for a bounded window has to be recorded when it is seen, not looked up
 * once the window has closed.
 */
/** World point → screen point, through the live camera (never a fixed pixel). */
const toScreen = (wx, wy) =>
  page.evaluate(
    ([x, y]) => {
      const raw = window.__game.debug().worldView
      const v = { x: raw.x, y: raw.y, w: raw.width ?? raw.w, h: raw.height ?? raw.h }
      const r = document.querySelector('canvas').getBoundingClientRect()
      return {
        x: r.left + ((x - v.x) / v.w) * r.width,
        y: r.top + ((y - v.y) / v.h) * r.height,
      }
    },
    [wx, wy],
  )

/**
 * The ground directly under the player: where its surface is, and how much solid
 * rock is beneath it.
 *
 * Asked of the mask, not assumed. The aim used to be the fixed screen point
 * `(640, 700)` — about 170 world px below the body at `CAMERA_ZOOM` 2 — on the
 * reasoning that it is "your own feet". On a player standing on a ledge the
 * rocket flies that whole distance before hitting anything, detonates far below,
 * and does a fraction of the damage; the loop then fires again, and again, each
 * blast deepening the hole. T15.02 made the floor destructible, so that hole now
 * reaches the **void** — two runs in eight died with "You fell out of the world"
 * instead of to their own rocket, which is a correct §C15 death and the wrong
 * death for this check.
 */
const groundUnder = () =>
  page.evaluate(() => {
    const g = window.__game
    const p = g.debug().player
    if (!p) return null
    const core = g.core
    const x = Math.round(p.x)
    let surface = null
    for (let y = Math.round(p.y); y < core.height; y++) {
      if (core.solidAt(x, y)) {
        surface = y
        break
      }
    }
    if (surface === null) return { surface: null, depth: 0, drop: Infinity }
    let depth = 0
    for (let y = surface; y < core.height && core.solidAt(x, y); y++) depth++
    return { surface, depth, drop: surface - p.y }
  })

let latched = null
const sample = async () => {
  const d = await dbg()
  if (latched === null && d.death?.visible) {
    latched = { cause: d.death.cause, text: d.death.text, health: d.health }
  }
  return d
}
/** Deaths of *this* player the client has been told about — cumulative, so it
 *  cannot be missed the way a live `health <= 0` can. */
const myDeaths = (d) => (d.observed?.deaths ?? []).filter((x) => x.victim === d.me).length
//
// Walk **further than the crater** between shots. A bazooka's blast radius is 42,
// so a 260 ms step (~39 px at WALK_SPEED 150) lands the next rocket inside the
// hole the last one dug, where it detonates below your feet for a fraction of the
// damage — measured by T9.06 at ~12 against ~25. 700 ms clears it.
//
// The loop runs to a deadline rather than a fixed count: at 8 rockets and
// variable terrain, a fixed 14 made this a coin flip, and a gate that fails on a
// coin flip gates nothing (§A28).
// **A note on the void, measured and not fixed here.**
//
// T15.02 made the floor destructible, so a self-kill fired downward can dig
// toward it. Two attempts to prevent that both made this check *worse*, and the
// numbers are worth keeping so the next person does not repeat them:
//
//   latch + probed aim (this file)              6 of 8
//   ... plus walking to fresh ground each shot  5 of 8
//   ... plus requiring 3 blast radii of rock    4 of 8
//
// Both additions spend the same clock the weather schedule is racing — it starts
// at `EFFECT_INTERVAL_MIN` (30 s) and cannot be turned off from the server env —
// and the depth precondition additionally rejects maps where the player legitimately
// stands on the 16 px `FLOOR_CRUST`, on two of which the self-kill then worked
// perfectly. The residual failures are honest and named; see the journal.

const killDeadline = Date.now() + 90_000
for (let i = 0; Date.now() < killDeadline; i++) {
  const d = await sample()
  // Cumulative, not `health <= 0`: a respawn puts health back to `BASE_HEALTH`,
  // so a death that happened during the last iteration's waits is invisible to a
  // live reading by the time this line runs.
  if (!d.player || myDeaths(d) > 0 || d.health <= 0 || latched) break
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
  // Latching while it waits, because this is the longest gap in the loop (up to
  // 4 s) and the overlay only lives for 5.
  for (let w = 0; w < 20; w++) {
    const g = await sample()
    if (g.player?.grounded || latched || myDeaths(g) > 0) break
    await sleep(200)
  }
  if (latched || myDeaths(await sample()) > 0) break
  // §C20: standing still is now a precondition of firing, so stop before every
  // shot exactly as a player must. Without it the walk above refuses the rocket
  // it was setting up, the kill takes 100 s instead of 30, and the weather gets
  // there first — this check reported the cause line as "Killed by weather" and
  // read as an attribution bug.
  await standStill(page)
  // `standStill` can wait seconds for the body to settle, and the overlay only
  // lives for five. Sample the moment it returns so that gap cannot swallow the
  // window either.
  if (latched || myDeaths(await sample()) > 0) break
  // Aim at the rock immediately under the feet, probed from the mask, so the
  // rocket detonates against the surface the player is standing on and does full
  // self-damage. One rocket then ends it at `DEV_START_HEALTH` 20, which is the
  // arrangement this check is built on — and nothing digs toward the void.
  //
  // Probed every shot, not once: `supported` keeps a body up while any part of
  // its base has rock under it, so after a blast the player often stands on the
  // crater's *lip* and the ground under them has moved. Re-asking the mask each
  // time is what keeps the rocket detonating against the surface they are on.
  //
  // (An earlier version also walked until the ground was within
  // `BAZOOKA_BLAST_RADIUS`. Measured, that was worse — 5 runs in 8 against 6 —
  // because the walking spent the same clock the weather is racing. Reverted;
  // the numbers are in the journal.)
  let under = await groundUnder()
  // A player in the air between blasts momentarily has nothing under them at
  // this x. That is a moment, not a defect, so look again before calling it one.
  for (let w = 0; w < 10 && (!under || under.surface === null); w++) {
    await sleep(200)
    if (latched || myDeaths(await sample()) > 0) break
    under = await groundUnder()
  }
  if (latched) break
  if (!under || under.surface === null) {
    fail(`no ground under the player to fire at (${JSON.stringify(under)})`)
    break
  }
  if (i === 0) {
    ok(`ground ${under.drop.toFixed(0)} px below the feet, ${under.depth} px thick`)
  }
  const aim = await toScreen((await sample()).player.x, under.surface + 2)
  await page.mouse.move(aim.x, aim.y)
  const hpBefore = (await dbg()).health ?? 0
  await page.evaluate('window.__game.fire()')
  // Wait for the rocket to *land*, not for 900 ms. The client steps a fixed
  // timestep off requestAnimationFrame, so a busy box simulates fewer ticks per
  // wall-clock second and a flat sleep lands fewer rockets inside the same
  // deadline — which is how this check failed in the suite while passing
  // standalone. Waiting on the effect makes load irrelevant instead of moving a
  // threshold (§A28); the cap is only so a dud shot cannot stall the loop.
  for (let w = 0; w < 24; w++) {
    const now = await sample()
    if ((now.health ?? 0) < hpBefore || latched || myDeaths(now) > 0) break
    await sleep(100)
  }
}

// The latch first: if any poll during the kill loop saw the overlay, that *is*
// the observation, and waiting again would only ask whether it is still up.
// `until` remains for the case where the loop ended before the overlay rose.
const live = latched ? null : await until((d) => d.death.visible, 12_000, 'the death overlay to appear')
const dead = latched
  ? { death: { cause: latched.cause, text: latched.text }, cause: latched.cause }
  : live
if (dead) {
  ok(
    `the overlay appeared — cause "${dead.cause ?? dead.death.cause}", health ` +
      `${startHealth} → 0${latched ? ' (latched during the kill loop)' : ''}`,
  )

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
  // Neither branch taken means the overlay cleared while this ran — a respawn,
  // not a stopped clock. Say so out loud: a silently skipped assertion reads
  // exactly like one that passed.
  else ok('countdown not re-read — the respawn cleared the overlay first')

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
  // **Name which of the three it was.** The old line printed
  // `dead=${!d.death.visible}`, which is a tautology in this branch — the
  // overlay is down, so its negation is always true — and it read as "the
  // player is dead", which is the one thing it did not say.
  //
  // The overlay is `meAlive === false && info !== null` (`shouldShow`), and the
  // two arrive by different routes: the alive flag from the snapshot *and* the
  // death event, the info from the event alone. So:
  //   no death event          -> deaths 0, hasInfo false
  //   event arrived, no flag  -> deaths >= 1, hasInfo true, meAlive true
  //   raised then lowered     -> deaths >= 1, hasInfo false (cleared by respawn)
  const d = await dbg()
  const mine = (d.observed?.deaths ?? []).filter((x) => x.victim === d.me)
  console.error(
    `  health ${startHealth} → ${d.health}; death events ${
      (d.observed?.deaths ?? []).length
    } (${mine.length} mine); overlay meAlive=${d.death.meAlive} hasInfo=${
      d.death.hasInfo
    } visible=${d.death.visible}; respawns ${
      d.observed?.respawns ?? '?'
    }; phase ${d.phase}`,
  )
  // Health 0 for the whole 12 s wait means no respawn either, and
  // `RESPAWN_DELAY` is 5 — so the client stopped hearing from the server rather
  // than hearing something it mishandled. Say so, because "the overlay did not
  // appear" points at the overlay and this would not be the overlay's fault.
  if ((d.health ?? 0) <= 0 && (d.observed?.respawns ?? 0) === 0) {
    console.error(
      `  note: dead for the whole ${12}s wait with RESPAWN_DELAY 5 and no respawn — ` +
        'the client may have stopped receiving',
    )
  }
  if (mine.length === 0) {
    fail('no death event for this player arrived — the overlay was never told')
  } else if (!d.death.hasInfo) {
    fail('the death event arrived and the overlay had no info left — it was cleared')
  } else if (d.death.meAlive) {
    fail('the death event arrived and the overlay has info, but the alive flag never went false')
  }
  await page.screenshot({ path: join(shotsDir, 'FAILED-death.png') })
}

if (pageErrors.length) fail(`page errors: ${pageErrors.join(' | ')}`)
else ok('no page errors')

await stack.close()
console.log(failures.length ? `\ndeath: ${failures.length} FAILED` : '\ndeath: ok')
process.exit(failures.length ? 1 : 0)
