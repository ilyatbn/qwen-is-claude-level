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
  // **`FIXED_SEED` so the terrain is the same every run.** Every assertion here
  // is a mechanism — a swing, a cone, a hazard zone and a mine kill are received
  // and drawn — and none is a claim about maps. Unpinned, the mine kill depended
  // on where the blast threw the player and how far the next rocket fell on the
  // way back, which is a map fact wearing a renderer's clothes.
  // `DEV_START_HEALTH` at the cap, because this check sets fire to the ground it
  // is standing on and then rockets its own feet. Both are deliberate — they are
  // what makes a hazard and a mine-kill happen — and at `BASE_HEALTH` the sum of
  // them is fatal on a slow box: measured, the player walked out of its own
  // molotov on 9 health and the next rocket would have finished it. A dead player
  // drops its inventory, and the failure then reads "bazooka is not in the
  // inventory", which is true and says nothing.
  env: {
    FIXED_SEED: '4242',
    ROUND_SECONDS: '180',
    BOT_COUNT: '0',
    DEV_LOADOUT: '1',
    DEV_START_HEALTH: '150',
  },
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
async function fireUntil(aim, pred, deadlineMs, what, weapon, approach) {
  const started = Date.now()
  for (;;) {
    if (pred(await dbg())) return true
    if (Date.now() - started > deadlineMs) {
      fail(`timed out waiting for ${what}`)
      return false
    }
    // **Close the range before aiming**, when the caller knows how.
    //
    // A bazooka rocket is ballistic: aimed straight at a target it drops below
    // the aim point on the way and lands short, and only `BAZOOKA_BLAST_RADIUS`
    // rescues the shot. That is survivable at point-blank range and not at
    // distance — which is exactly the situation a rocket creates, because one at
    // your own feet throws you (`docs/21` §5). Shot one is fired from on top of
    // the mine; shots two onward were fired from wherever the blast put you, and
    // that is why four aimed rockets could all miss.
    //
    // Recomputing the *screen* point per shot was the previous fix and it is
    // necessary but not sufficient: it corrects where you are pointing, not how
    // far the rocket falls on the way there.
    if (approach) await approach()
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
    // **Spend no more of the stack than it holds.**
    //
    // The two fixes above — waiting for the shot to resolve, then polling `pred`
    // for 2 s — bought patience, and under full-suite load it still is not
    // enough: the gate reproduced the documented signature again, `Held: 2:smg
    // 3:mine 4:axe 5:flamethrower 6:molotov`, exactly the rockets gone. Patience
    // alone cannot fix this, because there is no wait long enough to be safe on
    // every box.
    //
    // So the loop is ammo-aware. Running dry is a **finding** — "the mine
    // survived every rocket it had" — and saying that is far more use than
    // letting `selectWeapon` throw `"bazooka" is not in the inventory`, which is
    // a true statement about a stack this loop had just spent and reads like a
    // broken loadout.
    if (weapon) {
      const ammo = ((await dbg()).slots ?? []).find((x) => x.key === weapon)?.count ?? 0
      if (ammo === 0) {
        fail(`${what}: spent every ${weapon} and it never happened — the stack is empty`)
        return false
      }
      await selectWeapon(page, weapon)
    }
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
    // ...and then give the **server** time to report what the shot did, before
    // deciding the shot failed and taking another.
    //
    // This is where the ammo went. `DEV_LOADOUT` grants 4 rockets; the mine dies
    // to the first one when the loop is patient. Under full-suite load the
    // server's `mines_ended` arrives a beat later than the projectile leaves the
    // air, the loop read "not yet" and fired again — four times, and then
    // `selectWeapon` correctly refused to carry on with `"bazooka" is not in the
    // inventory. Held: 2:smg 3:mine ...`, which is a true statement about a stack
    // this loop had just spent.
    //
    // Polled on `pred` rather than slept flat: it costs nothing when the shot
    // worked, and 2 s only when it did not.
    for (let w = 0; w < 20; w++) {
      if (pred(await dbg())) return true
      await settle(100)
    }
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

// --- a hazard on the ground -------------------------------------------------
//
// A molotov leaves fire, which is a hazard the server narrates and (until now)
// nothing drew. Assert on hazards *drawn*, not on `hazard_spawn` being counted —
// counting was already happening and was exactly the bug.
await holding('mine')
// **Before the mine, not after it.**
//
// Moving it last was tried — nothing depends on surviving the fire there, which
// is attractive — and it does not work: after the rocket the player is standing
// in the crater it made, and a bottle thrown out of a pit does not produce a
// hazard the layer ever draws. Three runs, three "timed out waiting for a hazard
// to be drawn". Thrown from open ground it lands every time.
await selectWeapon(page, 'molotov')
// Thrown **up** and to the right, not down at 45 degrees.
//
// A molotov is a thrown weapon: the aim sets the launch angle and the speed is
// fixed, so where it lands is governed by the arc rather than by the point
// clicked. Aimed below the horizontal from a player standing on a slope the
// bottle goes straight into the ground at its feet, and on this map it stopped
// being thrown at all — molotov x2 before the step and x2 after, with the
// failure reading "timed out waiting for a hazard to be drawn". Aimed above the
// horizontal it carries, lands clear, and lights.
// Thrown **up** and to the right.
//
// A molotov is a thrown weapon: the aim sets the launch angle and the speed is
// fixed, so where it lands is governed by the arc, not by the point clicked.
// Aimed below the horizontal the bottle lands at the player's own feet, and its
// fire kills — health went 14 → 1 → 0 over 800 ms in a frame-by-frame watch.
// Aimed above it, the same throw carries clear; the run below still walks away
// as well, because how far it carries depends on the ground it is thrown from.
await fireAt(1060, 180)
// **Walk out from under it while it is still in the air.**
//
// The bottle lands roughly where the player was standing, and its fire kills:
// watched frame by frame, health went 14 -> 1 -> 0 over 800 ms of standing in
// it. What made that hard to see is that the client's `slots` do not refresh on
// death — the loadout was still listed in full for five seconds after the player
// was dead, so every diagnostic said "holding four rockets" about a corpse, and
// the failure surfaced two steps later as `"bazooka" is not in the inventory`.
// (That staleness is a real client defect; it is recorded in the journal.)
//
// Aiming further away was tried and is not reliable: a molotov is thrown, so
// where it lands depends on the ground it is thrown from, and on a slope an
// up-and-away aim still lands short. Moving is reliable.
// Keep walking **until the burning stops**, not for a fixed time.
//
// 1400 ms was a guess and it is the wrong kind of number: how far that carries
// depends on the ground. Measured, the player was still alight at the end of it
// on 64 health and died a moment later. Walk while health is falling, stop when
// it has been steady for three reads.
// **Leave while it is in the air**, and keep going.
//
// The fire lands roughly where the player was standing and it kills — measured
// frame by frame, health went 14 → 1 → 0 over 800 ms — and a death drops the
// inventory, so the rocket step below would be about a respawned player. Walking
// starts before the bottle lands and runs for 1.5 s, which at `WALK_SPEED` is
// 225 px: further than the zones spread. The hazard is polled **during** the
// walk, because it appears the moment the bottle lands and this walk outlasts
// the flames.
await page.keyboard.down('a')
const burnt = await until((d) => d.hazardsDrawn > 0, 10_000, 'a hazard to be drawn')
await settle(1500)
await page.keyboard.up('a')
await settle(300)
const survived = await dbg()
if ((survived.observed?.deaths ?? []).length > 0) {
  fail(
    'the player died in its own molotov — the rocket step below would be about a ' +
      'respawned player with a dropped inventory, not about ordnance',
  )
} else {
  ok(`walked clear of its own fire on ${Math.round(survived.health)} health`)
}
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

// --- the mine, counted at both ends ----------------------------------------
//
// This is the assertion whose absence let the whole thing ship. The client's
// live count must equal the server's narration: placed minus ended.
//
// No walking anywhere in here, and **after** the molotov for that reason. The
// hazard step has to run away from its own fire; doing that with a mine already
// placed meant walking back to it afterwards, and a check doing platforming
// walks into a wall or fails to arrive — "the target is not on screen". Placed
// last, the mine is at the player's feet and stays there.
//
// The fx layer draws at DEPTH.particles, above DEPTH.actors, so a mine at your
// feet is drawn over your own sprite and is visible without moving at all.
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

// --- and the mine must go away again ---------------------------------------
//
// §B6 makes mines destructible "because that is what stops a map filling up
// with them", and T11.07 found `destroy_in_blast` had no production caller at
// all. A layer that adds and never removes passes every "is it drawn" check
// while leaving ghosts on the map forever.
//
// Last, because rocketing your own feet costs health and craters the ground the
// earlier steps stand on. Moving it earlier was tried and is worse: the molotov
// then falls into the fresh crater and never lights, and the player is still
// being thrown around by its own blast when §C20 refuses the throw.
//
// The four rockets it used to spend here were not the ordering's fault — see
// `fireUntil`, which fired again before the server had reported the first hit.
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
  // Within one blast radius, **derived** rather than chosen: a rocket that falls
  // short by less than `BAZOOKA_BLAST_RADIUS` still puts the blast over the mine.
  // Reading it from the constants table rather than copying 42 into the fixture
  // is §A19 — a fixture carrying its own number stays green against a drifted
  // sim.
  const kk = await page.evaluate(() => window.__game.constants())
  const NEAR = kk.BAZOOKA_BLAST_RADIUS
  /**
   * How close is **too** close to shoot a mine.
   *
   * `approachMine` had a maximum distance and no minimum, so it walked the
   * player onto the mine and stopped: measured, player (1284, 526) against a
   * mine at (1285, 526). A rocket fired one pixel away detonates on the muzzle
   * rather than travelling, and four bazookas went that way without ever ending
   * the mine — reported as "the stack is empty", which reads as an obstruction
   * and is not one. The lane was clear the whole time.
   *
   * **One** body width, not two. The window has to be wider than the walk step
   * or the controller cannot land in it: one burst is `WALK_SPEED` 150 px/s for
   * 160 ms — about 24 px before the release adds momentum — so a 32..42 band is
   * a 10 px target hit by a 24 px stride, and the approach oscillates
   * (1 -> ~25 -> ~49 -> ~25) until the iteration bound falls through to "firing
   * from here". Half of that oscillation sits *outside* `BAZOOKA_BLAST_RADIUS`,
   * which is the exact failure the approach exists to prevent. 16..42 is a 26 px
   * window, wider than the stride, still a full body clear of the muzzle, and
   * still derived rather than picked.
   */
  const STANDOFF = Math.round(kk.PLAYER_W)

  /**
   * Walk back onto the mine between shots.
   *
   * Mines ignore their owner (§B6), so standing on one is safe and the range can
   * be closed all the way. Bounded, and it does **not** fail when it cannot
   * arrive — a mine across a chasm is a map fact, not a defect, and the ammo
   * budget in `fireUntil` is what reports a rocket that genuinely never reaches.
   * Turning "I could not walk there" into a failure would make this check about
   * platforming, which the comment above says it must not be.
   */
  const approachMine = async () => {
    for (let i = 0; i < 12; i++) {
      const d = await dbg()
      const m = (d.mines ?? [])[0]
      if (!m || !d.player) return
      const dx = m.x - d.player.x
      const gap = Math.abs(dx)
      if (gap <= NEAR && gap >= STANDOFF) return
      // Too close as well as too far: back away when standing on top of it.
      const toward = dx > 0 ? 'd' : 'a'
      const away = dx > 0 ? 'a' : 'd'
      const key = gap < STANDOFF ? away : toward
      await page.keyboard.down(key)
      await sleep(160)
      await page.keyboard.up(key)
      await sleep(140)
    }
    const d = await dbg()
    const m = (d.mines ?? [])[0]
    if (m && d.player) {
      console.log(
        // Both bounds, not one. The approach wants a gap inside
        // [STANDOFF, NEAR] — close enough that the blast reaches, far enough
        // that the rocket clears the muzzle — and naming only the max sends
        // the reader looking for an obstruction when the miss was on the near
        // side.
        `    could not settle between ${STANDOFF} and ${NEAR} px of the mine ` +
          `(${Math.abs(m.x - d.player.x).toFixed(0)} px away) — firing from here`,
      )
    }
  }

  const aimAtMine = async () => {
    const d = await dbg()
    const m = (d.mines ?? [])[0]
    if (!m || !d.worldView) return null
    const sx = (m.x - d.worldView.x) * d.zoom
    const sy = (m.y - d.worldView.y) * d.zoom
    return sx > 0 && sx < 1280 && sy > 0 && sy < 720 ? { sx, sy } : null
  }

  await fireUntil(
    aimAtMine,
    (d) => d.minesEnded > 0,
    60_000,
    'the rocket to end the mine',
    'bazooka',
    approachMine,
  )
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
