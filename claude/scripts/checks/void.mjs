#!/usr/bin/env node
/**
 * T15.02 / §C15 — dig a hole through the floor, fall in, and die.
 *
 *   node scripts/checks/void.mjs
 *   node scripts/e2e.mjs void
 *
 * ## Why this exists when 19 lib tests already pass
 *
 * Because they did, and the overlay still said the wrong thing. The void's
 * server half is covered from every angle in `world::void`, and with all of it
 * green the dying player read **"Killed by void"** — `deathOverlay-math.ts` had
 * no arm for the new cause and fell through to a `default` that echoes the raw
 * wire string. The kill feed, two inches away on the same screen, said "ana fell
 * out of the world". No test in `game-core` can see that, because the sentence is
 * assembled in the client from a payload the server is right about.
 *
 * That is the M15 checkpoint word for word — "dig a hole through the floor, fall
 * in and die" — and it is a claim about a frame, so it is asserted on one (§C2).
 *
 * ## Why it does not hardcode where to dig
 *
 * It asks the client's own mask. A fixture carrying `x = 464` is a statement
 * about one seed's terrain that goes quietly wrong the moment generation moves,
 * and §C15 moved generation — every golden hash changed with it. `solidAt` is
 * right there on the debug handle, so the check probes for a spot where the rock
 * between the player and `y = mapH` is thin enough for one rocket, and says so
 * plainly if there is none.
 */
import { join } from 'node:path'
import { startStack, enterBattle, standStill, selectWeapon, tally, sleep, shotsDir } from './harness.mjs'
import { samplePatch, colourDelta } from './pixels.mjs'

const PORT = 3132
const { fail, ok, finish } = tally('void')

// FIXED_SEED so the terrain is the same every run — this check needs a map with
// somewhere you can stand on the floor crust, and picking that by luck is how a
// gate becomes a coin flip. No bots: a bot landing a hit would change the
// attribution the cause line is asserted against, exactly as `death.mjs` found.
const stack = await startStack({
  port: PORT,
  label: 'void',
  env: {
    FIXED_SEED: '1',
    MAP_SCALE: 'small',
    ROUND_SECONDS: '180',
    BOT_COUNT: '0',
    DEV_LOADOUT: '1',
  },
})

const { page, dbg, pageErrors } = await stack.openClient({ name: 'ana' })
await enterBattle(page, { waitPlaying: true, label: 'void' })

const start = await dbg()
const mapH = start.mapH
ok(`in a round on a ${start.mapW}x${mapH} map, seed ${start.seed}`)

// --- the control frame ------------------------------------------------------
//
// Alive, overlay down, and the frame recorded. Without this, "the overlay is up
// after the fall" is also satisfied by an overlay that is up always (§A26).
if (start.death.visible) fail('the overlay is up while the player is alive')
else ok('control: the overlay is down while alive')

// The overlay is centred. **The control is a second frame, not a second region**:
// the overlay dims the entire viewport, so every corner changes with it and a
// spatial control is guaranteed to fail — measured at 105.7 on the first run.
// What has to be ruled out is that this patch churns on its own, so it is sampled
// twice while alive and the death delta is compared against that idle delta.
const OVERLAY = { x: 440, y: 250, w: 400, h: 220 }
const overlayIdleA = await samplePatch(page, OVERLAY)
await page.screenshot({ path: join(shotsDir, 'void-alive.png') })
await sleep(900)
const overlayIdleB = await samplePatch(page, OVERLAY)

// --- find somewhere the floor is one rocket thick ---------------------------
//
// Asked of the client's mask rather than assumed. Returns the player's own
// column when it already works, so a spawn on the crust costs no walking.
const site = await page.evaluate((h) => {
  const core = window.__game.core
  const me = core.playerState(window.__game.debug().me ?? 0)
  const feet = me ? me.y + 14 : 0
  /** Solid pixels between `y` and the bottom of the map, in this column. */
  const rockBelow = (x, y) => {
    let n = 0
    for (let probe = Math.floor(y); probe < h; probe++) if (core.solidAt(x, probe)) n += 1
    return n
  }
  const usable = (x, y) => rockBelow(x, y) > 0 && rockBelow(x, y) <= 40
  if (me && usable(Math.round(me.x), feet)) {
    return { x: Math.round(me.x), y: feet, rock: rockBelow(Math.round(me.x), feet), walk: 0 }
  }
  // Otherwise sweep for the nearest column that works, so the check can say how
  // far away it is instead of failing with "something went wrong".
  let best = null
  for (let x = 16; x < core.width - 16; x += 8) {
    for (let y = h - 200; y < h; y += 4) {
      if (!core.solidAt(x, y) && usable(x, y + 1)) {
        const walk = me ? Math.abs(x - me.x) : Infinity
        if (!best || walk < best.walk) best = { x, y: y + 1, rock: rockBelow(x, y + 1), walk }
        break
      }
    }
  }
  return best
}, mapH)

if (!site) {
  fail('no column on this map has a floor thin enough to blow through in one shot')
} else {
  ok(`dig site at x=${site.x}: ${site.rock} px of rock to the void, ${site.walk} px away`)
}

const me0 = (await dbg()).player
ok(`the player is at (${me0.x.toFixed(0)}, ${me0.y.toFixed(0)}), map bottom is ${mapH}`)

// The precondition, stated: this check digs one hole, so the player has to be
// standing on the thin part already. Said out loud rather than silently walking
// somewhere and asserting on whatever happened.
if (site && site.walk > 0) {
  fail(
    `the player spawned ${site.walk} px from the only diggable floor — this check ` +
      'assumes a spawn on the crust and does not path across terrain',
  )
}

// --- dig through the floor --------------------------------------------------
//
// A real rocket through the real fire path, aimed below the body. §C20 makes
// standing still a precondition of firing, so stop first exactly as a player has
// to. The camera follows the player, so a point below mid-screen is below them
// in world space whatever the camera has done.
await selectWeapon(page, 'bazooka')
await standStill(page)
await page.mouse.move(640, 719)
await page.evaluate('window.__game.fire()')

// Wait for the hole, not for a duration: the client steps a fixed timestep off
// requestAnimationFrame, so a loaded box simulates fewer ticks per wall-clock
// second and a flat sleep would make this a coin flip (§A28).
const opened = await (async () => {
  for (let w = 0; w < 40; w++) {
    const gap = await page.evaluate((h) => {
      const core = window.__game.core
      const me = core.playerState(window.__game.debug().me ?? 0)
      if (!me) return null
      // Look across the body's own width and a little past it, and report the
      // nearest column with nothing under it. Which side the crater opened on is
      // a fact about where the rocket landed, so it is measured, not assumed —
      // the first version of this walked left because one run happened to.
      const feet = Math.floor(me.y + 14)
      for (let dx = 0; dx <= 48; dx += 4) {
        for (const sign of [-1, 1]) {
          const x = Math.round(me.x) + sign * dx
          let rock = 0
          for (let y = feet; y < h; y++) if (core.solidAt(x, y)) rock += 1
          if (rock === 0) return { dx: sign * dx, x }
        }
      }
      return null
    }, mapH)
    if (gap) return gap
    await sleep(150)
  }
  return null
})()

if (!opened) {
  fail('one rocket into the floor opened no column through to the void')
} else {
  ok(`the floor is open ${Math.abs(opened.dx)} px to the ${opened.dx <= 0 ? 'left' : 'right'}`)
}

// **Wait out the assist window before falling in.**
//
// Not padding. The rocket that opened the floor self-damaged for 12, and
// `killer()` hands an environmental death to anyone who damaged you inside
// `ASSIST_WINDOW` — `docs/21` §4's rule, which §C15 deliberately shares so that
// blasting someone off the edge credits the shooter. Measured on the first run:
// the death came back attributed `"self"` and the overlay read "You killed
// yourself", which is *correct* and is not the path with the new sentence in it.
// Waiting lets the credit lapse so this observes a pure void death.
//
// The duration comes from the sim's own constant, never a literal: a wait
// hardcoded against a tunable is a test that expires.
const assistWindow = await page.evaluate(() => window.__game.constants().ASSIST_WINDOW)
ok(`waiting out ASSIST_WINDOW (${assistWindow}s) so the rocket stops taking the credit`)
await sleep(assistWindow * 1000 + 700)

// **Walk in.** The body perches on the lip of its own crater — `supported` keeps
// you up while *any* part of the base has rock under it — so blowing the hole is
// only half of "dig a hole through the floor and fall in". Measured: after the
// shot the left half of the footprint had 0 px under it and the right half still
// had 16.
let fell = false
if (opened) {
  const key = opened.dx <= 0 ? 'a' : 'd'
  const deadline = Date.now() + 25_000
  await page.keyboard.down(key)
  while (Date.now() < deadline) {
    const now = await dbg()
    if (now.death.visible || (now.player && now.player.y > mapH)) {
      fell = true
      break
    }
    await sleep(100)
  }
  await page.keyboard.up(key)
  if (fell) ok('walked off the edge and out of the world')
  else fail('walked into the hole and never left the map')
}

// --- what the player sees ---------------------------------------------------
const dead = await (async () => {
  const until = Date.now() + 12_000
  while (Date.now() < until) {
    const d = await dbg()
    if (d.death.visible) return d
    await sleep(200)
  }
  return null
})()

if (!dead) {
  const d = await dbg()
  fail(
    `no death overlay: player y=${d.player?.y?.toFixed(0)}, map bottom ${mapH}, ` +
      `health ${d.health}`,
  )
  await page.screenshot({ path: join(shotsDir, 'FAILED-void.png') })
} else {
  ok('the death overlay came up')
  await page.screenshot({ path: join(shotsDir, 'void-death.png') })

  // **The sentence**, read from the DOM the host renders — not from the payload.
  // This is the assertion that would have caught "Killed by void".
  const text = String(dead.death.cause)
  if (/fell out of the world/i.test(text)) {
    ok(`the overlay reads "${text}"`)
  } else {
    fail(`the overlay reads "${text}", expected the void wording`)
  }
  if (/killed by/i.test(text)) {
    fail(`"${text}" still uses the "Killed by" prefix, which is not grammatical here`)
  }

  // Rendered pixels, against a control frame (§C2): the overlay's patch moved far
  // more at death than it did between two frames of ordinary play.
  const overlayAfter = await samplePatch(page, OVERLAY)
  const idleDelta = colourDelta(overlayIdleA, overlayIdleB)
  const deathDelta = colourDelta(overlayIdleB, overlayAfter)
  if (deathDelta < 8) {
    fail(`the overlay's patch moved only ${deathDelta.toFixed(1)} when the player died`)
  } else if (deathDelta < idleDelta * 3) {
    fail(
      `the patch moved ${deathDelta.toFixed(1)} at death but ${idleDelta.toFixed(1)} between ` +
        'two idle frames — it churns on its own, so the change proves nothing',
    )
  } else {
    ok(`the frame changed where the overlay is: ${deathDelta.toFixed(1)} at death against ${idleDelta.toFixed(1)} idle`)
  }

  // **Both ends** (§A39): one death event from the server, and one overlay on
  // screen. An overlay with no server death is the bug this pairing catches, and
  // so is the reverse — the fall counted once server-side while the player saw
  // nothing.
  const events = dead.observed.deaths
  if (events.length === 1) ok('the server narrated exactly one death')
  else fail(`the server narrated ${events.length} deaths for one fall: ${JSON.stringify(events)}`)

  // And the server called it the void, with nobody credited. The overlay's
  // sentence is assembled from these two fields, so asserting the sentence alone
  // would pass for a client that ignores them.
  const e = events[0]
  if (e && e.cause === 'void') ok(`the server attributed it to "${e.cause}"`)
  else fail(`the server attributed it to "${e?.cause}", expected "void"`)
  if (e && e.attacker === null) ok('and credited nobody')
  else fail(`credited player ${e?.attacker} for a solo fall`)

  // It cost a point — §C15 says DEATH_POINTS like any death.
  const mine = dead.scores.find((s) => s.id === dead.me)
  if (mine && mine.score < 0) ok(`and it cost a point (score ${mine.score})`)
  else fail(`score is ${mine?.score}, expected the death to cost a point`)
}

if (pageErrors.length) fail(`page errors: ${pageErrors.join(' | ')}`)
else ok('no page errors')

await stack.close()
await finish()
