#!/usr/bin/env node
/**
 * T11.10 — the ordnance the server narrates is actually on screen.
 *
 *   node scripts/checks/ordnance.mjs
 *   node scripts/e2e.mjs ordnance
 *
 * ## Why
 *
 * `melee`, `cone`, `mine_placed`, `mine_ended` and three `hazard_spawn` kinds
 * have been emitted since T11.05–T11.08 with **nothing subscribing**. §A39, tenth
 * instance. The design names the consequence directly:
 *
 * - §B6: "a mine must be visible at close range — invisible instant death is not
 *   fun; a trap you could have spotted is."
 * - §B21: heavy fog ran for five milestones and changed nothing visible, because
 *   its tests all asserted the *formula* returned the right number and nothing
 *   asserted the number reached the screen. This is the other half of that.
 *
 * ## What it asserts, and why it is two numbers
 *
 * The client's live-mine count against the **server's own narration** (placed
 * minus ended). One number — "the server placed a mine" — passes for the whole
 * period the bug existed. Those two were silently different for world items for
 * three milestones (§A39).
 *
 * The stack and the route into a battle are `harness.mjs` (§C18) — a room is a
 * lobby until someone asks for a round, and every wait below is meaningless
 * until one is running.
 */
import { join } from 'node:path'
import {
  startStack,
  enterBattle,
  standStill,
  selectWeapon,
  tally,
  sleep,
  shotsDir,
} from './harness.mjs'

const PORT = 3122
const { fail, ok, failures } = tally('ordnance')

// No bots: a bot swinging or placing its own mine would make the counts
// ambiguous about whose ordnance is being asserted.
const stack = await startStack({
  port: PORT,
  label: 'ordnance',
  env: { ROUND_SECONDS: '180', BOT_COUNT: '0', DEV_LOADOUT: '1' },
})
const { page, dbg, pageErrors } = await stack.openClient({ name: 'ana' })
await enterBattle(page, { waitPlaying: true, label: 'ordnance' })


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

const settle = sleep
/** Fire whatever is selected, aiming at a screen point. */
async function fireAt(sx, sy) {
  // §C20: a shot from a moving player is refused, silently and by design. This
  // check walks between assertions, and without stopping first every one of
  // them timed out on its own effect — "waiting for a melee swing to arrive",
  // which reads as a missing subscription rather than a refused swing.
  await standStill(page)
  await page.mouse.move(sx, sy)
  // The aim is sampled from the pointer in the update loop, so a fire issued in
  // the same turn as the move can use the previous angle.
  await settle(120)
  await page.evaluate('window.__game.fire()')
}

/**
 * Fire until it demonstrably lands, or give up.
 *
 * `fire_ready_at` is per **player**, not per weapon — deliberately, so swapping
 * weapons cannot bypass a cooldown. A check that fires once right after another
 * weapon is therefore rejected silently, which is what made the first version of
 * this flaky at roughly one run in three. Retry on the *effect*, not the attempt.
 */
/**
 * `aim` is either a fixed `{sx, sy}` or a function returning one — **recompute
 * it per shot when the target is a world object.**
 *
 * A rocket at your own feet throws you (`docs/21` §5, and it is what makes
 * rocket-jumping work), the camera follows, and a screen point worked out
 * before the first shot points somewhere else entirely by the second. That is
 * how four rockets aimed "at the mine" all missed it: only the first one was.
 */
async function fireUntil(aim, pred, deadlineMs, what, weapon) {
  const started = Date.now()
  for (;;) {
    if (pred(await dbg())) return true
    if (Date.now() - started > deadlineMs) {
      fail(`timed out waiting for ${what}`)
      return false
    }
    const at = typeof aim === 'function' ? await aim() : aim
    if (!at) {
      fail(`${what}: the target is not on screen, so nothing can be aimed at it`)
      return false
    }
    const [sx, sy] = [at.sx, at.sy]
    // Re-select before every shot, when the caller names a weapon.
    //
    // A stack that empties does not leave the trigger idle — selection moves on,
    // and the next pull fires whatever is now under it. That is how this loop,
    // asked to rocket a mine, silently **placed a second mine**: `DEV_LOADOUT`
    // grants 4 rockets since §C24 collapsed its two bazooka stacks into one
    // (it used to grant 8), the loop ran dry, and the check reported "timed out
    // waiting for the rocket to end the mine" while cheerfully rearming the
    // field. `selectWeapon` throws a named error once the weapon is gone, so
    // running out now says so instead of testing a different weapon.
    if (weapon) await selectWeapon(page, weapon)
    await fireAt(sx, sy)
    // Wait for the shot to **resolve**, not for 400 ms.
    //
    // A fixed settle is a bet on how fast the box is, and the ammo budget is
    // what pays when the bet is wrong: `DEV_LOADOUT` grants 4 rockets, so four
    // premature retries empty the stack and `selectWeapon` then correctly refuses
    // to carry on — reported from a full-suite run as `"bazooka" is not in the
    // inventory. Held: 2:smg 3:mine 4:axe 5:flamethrower 6:molotov`, i.e. exactly
    // the rockets gone and nothing else, while the same check passed standalone.
    //
    // A projectile in the air means the previous shot has not landed and firing
    // again cannot be informed by it. The 1.5 s ceiling keeps a shot that never
    // resolves — one that flew off the map — from hanging the loop, and the
    // trailing settle covers the blast and the server's report of it.
    for (let w = 0; w < 30; w++) {
      const d = await dbg()
      if ((d.projectilesLive ?? d.projectiles ?? 0) === 0) break
      await settle(50)
    }
    await settle(250)
  }
}

/**
 * What the player is holding, for the log.
 *
 * Printed after every step because a `selectWeapon` failure at the end of the
 * run says only what is left, not when it went. Under full-suite load this check
 * has reported "bazooka is not in the inventory. Held: 1:mine 2:axe
 * 3:flamethrower" — four rockets, sixty smg rounds and two molotovs gone between
 * the start and the last step, and nothing in the transcript to say which step
 * spent them. One line per step turns that into a bisect.
 */
async function holding(where) {
  const slots = (await page.evaluate('window.__game.debug().slots')) ?? []
  const held = slots.filter((s) => s.key).map((s) => `${s.key}x${s.count}`)
  console.log(`    holding after ${where}: ${held.join(' ') || '(nothing)'}`)
}

// --- the control ----------------------------------------------------------
//
// Nothing has been fired yet, so nothing should be drawn. Without this,
// "a mine is drawn after placing one" also passes for a layer that draws a mine
// unconditionally (§A26).
const before = await dbg()
if (before.minesDrawn === 0 && before.swings === 0 && before.jets === 0) {
  ok('control: nothing drawn before anything is fired')
} else {
  fail(
    `something was already drawn: mines ${before.minesDrawn}, swings ${before.swings}, jets ${before.jets}`,
  )
}

// --- melee: a swing you can see -------------------------------------------
//
// By name. The loadout order used to be bazooka / smg / bazooka / mine / axe /
// flamethrower / molotov and this pressed Digit5; §C24 merged the two bazooka
// stacks and every index after the smg moved, so Digit5 became the flamethrower
// and this assertion timed out on a swing that was never asked for.
await selectWeapon(page, 'axe')
await fireAt(900, 400)
await settle(400)
const swung = await until((d) => d.swings > 0, 8000, 'a melee swing to arrive')
if (swung) ok(`melee: ${swung.swings} swing(s) received and drawn`)

// --- flamethrower: a jet, and a light ---------------------------------------
await holding('melee')
await selectWeapon(page, 'flamethrower')
for (let i = 0; i < 6; i++) {
  await fireAt(900, 420)
  await settle(120)
}
const sprayed = await until((d) => d.jets > 0, 8000, 'a flame jet to arrive')
if (sprayed) ok(`cone: ${sprayed.jets} jet(s) received and drawn`)

// --- the mine, counted at both ends ----------------------------------------
//
// This is the assertion whose absence let the whole thing ship. The client's
// live count must equal the server's narration: placed minus ended.
//
// No walking anywhere in here. Earlier versions stepped off the mine to
// photograph it and stepped back to blow it up, and spent three runs proving
// that a check doing platforming walks into a wall (x=16) or falls off a ledge
// (mine 200 px overhead). None of it was needed: the fx layer draws at
// DEPTH.particles, above DEPTH.actors, so a mine at your feet is drawn over your
// own sprite and is visible without moving at all.
await holding('cone')
await selectWeapon(page, 'mine')
await fireUntil({ sx: 640, sy: 700 }, (d) => d.minesPlaced > 0, 20_000, 'a mine to be placed', 'mine')
const placed = (await dbg()).minesPlaced > 0 ? await dbg() : null
if (placed) {
  const expect = placed.minesPlaced - placed.minesEnded
  if (placed.minesDrawn === expect) {
    ok(
      `mine: server says ${placed.minesPlaced} placed - ${placed.minesEnded} ended, client draws ${placed.minesDrawn}`,
    )
  } else {
    fail(
      `mine count disagrees: server ${placed.minesPlaced}-${placed.minesEnded}=${expect}, client draws ${placed.minesDrawn}`,
    )
  }
  await page.screenshot({ path: join(shotsDir, 'ordnance-mine.png') })
}

// --- a hazard on the ground -------------------------------------------------
//
// A molotov leaves fire, which is a hazard the server narrates and (until now)
// nothing drew. Assert on hazards *drawn*, not on `hazard_spawn` being counted —
// counting was already happening and was exactly the bug.
await holding('mine')
await selectWeapon(page, 'molotov')
await fireAt(900, 500)
await settle(1200)
const burnt = await until((d) => d.hazardsDrawn > 0, 10_000, 'a hazard to be drawn')
if (burnt) {
  // §B15: read the field that exists. The first version of this line printed
  // `burnt.hazards` — top-level, where the counter is not — and rendered
  // "server announced undefined". A log line is forgiving about that; an
  // assertion is not, because every comparison against `undefined` is quietly
  // false and reads exactly like a pass.
  const announced = burnt.observed?.hazards
  if (typeof announced !== 'number') {
    fail(`observed.hazards is ${announced} — the check is reading a field that does not exist`)
  } else if (burnt.hazardsDrawn > announced) {
    fail(`drew ${burnt.hazardsDrawn} hazards but the server only announced ${announced}`)
  } else {
    ok(`hazard: ${burnt.hazardsDrawn} zone(s) drawn of ${announced} announced`)
  }
}

await page.screenshot({ path: join(shotsDir, 'ordnance-hazard.png') })
await holding('hazard')


// --- and the mine must go away again ---------------------------------------
//
// §B6 makes mines destructible "because that is what stops a map filling up
// with them", and T11.07 found `destroy_in_blast` had no production caller at
// all. A layer that adds and never removes passes every "is it drawn" check
// while leaving ghosts on the map forever. Last, because rocketing your own
// feet costs health and craters the ground the earlier steps stand on.
if (placed) {
  // Mines ignore their owner (§B6), so standing on one is safe, and a rocket
  // straight down certainly puts the 42 px blast over it.
  // Deadlines with headroom, not fixed sleeps. `fireUntil` and `until` already
  // wait on the *effect*; the deadline only bounds how long a genuinely stuck
  // run may hang. Under a loaded box the client steps fewer fixed-timestep ticks
  // per wall-clock second, so 25 s was enough standalone and not enough after
  // three other specs — which is how this read as flaky rather than as slow.
  // Aimed at the mine itself, converted from its world position, not at a fixed
  // screen point below the player.
  //
  // `DEV_LOADOUT` grants **4 rockets** since §C24 collapsed its two bazooka
  // stacks into one — 4 is `BAZOOKA`'s `max_stack`, so it is now the most a
  // player can hold, and the old 8 was only reachable through the second-slot
  // bug §C24 fixes. Spraying at (640, 700) and hoping burned the stack, and
  // `selectWeapon` then correctly refused to carry on: `"bazooka" is not in the
  // inventory. Held: 2:smg 3:mine ...`. Four rockets are plenty when each one
  // is aimed at the thing it has to hit.
  const aimAtMine = async () => {
    const d = await dbg()
    const m = (d.mines ?? [])[0]
    if (!m || !d.worldView) return null
    const sx = (m.x - d.worldView.x) * d.zoom
    const sy = (m.y - d.worldView.y) * d.zoom
    return sx > 0 && sx < 1280 && sy > 0 && sy < 720 ? { sx, sy } : null
  }
  await fireUntil(aimAtMine, (d) => d.minesEnded > 0, 60_000, 'the rocket to end the mine', 'bazooka')
  const gone = await until(
    (d) => d.minesDrawn === d.minesPlaced - d.minesEnded && d.minesEnded > 0,
    20_000,
    'the mine to leave the layer',
  )
  if (gone) {
    ok(
      `mine removed: ${gone.minesPlaced} placed, ${gone.minesEnded} ended, ${gone.minesDrawn} drawn`,
    )
  }
}
if (pageErrors.length) fail(`page errors: ${pageErrors.join(' | ')}`)
else ok('no page errors')

await stack.close()
console.log(failures.length ? `\nordnance: ${failures.length} FAILED` : '\nordnance: ok')
process.exit(failures.length ? 1 : 0)
