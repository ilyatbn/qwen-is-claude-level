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
import { samplePatch, colourDelta, toScreen } from './pixels.mjs'

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
    FIXED_SEED: process.env.VOID_SEED ?? '5',
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
// `roundSeed`, not `seed`: the latter is this client's *local* core, which in a
// networked round never generates the map. It printed a constant unrelated to
// the round, which is how the same mistake survived as a real assertion in
// `e2e-two-clients`.
ok(`in a round on a ${start.mapW}x${mapH} map, round seed ${start.roundSeed}`)

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
const probeSite = () =>
  page.evaluate((h) => {
  const core = window.__game.core
  // Read in page context so the thresholds below are the shipped numbers rather
  // than a copy: a fixture that spells them stays green against a drifted
  // implementation, which is the one thing CLAUDE.md says a test must never do.
  const k = window.__game.constants()
  const me = core.playerState(window.__game.debug().me ?? 0)
  const feet = me ? me.y + k.PLAYER_H / 2 : 0
  /** Solid pixels between `y` and the bottom of the map, in this column. */
  const rockBelow = (x, y) => {
    let n = 0
    for (let probe = Math.floor(y); probe < h; probe++) if (core.solidAt(x, probe)) n += 1
    return n
  }
  /**
   * A column this check can actually blow through with one rocket.
   *
   * **The rock has to be under the feet, not merely somewhere in the column.**
   * This was `rockBelow(x, y) > 0 && <= 40`, which counts every solid pixel
   * between the feet and the map bottom however far down it is. Pass 6b moved
   * the spawn onto a ledge with air beneath it and the floor crust 114 px lower:
   * total rock 16, so the column looked ideal, and the rocket cleared the ledge
   * and dropped the player onto a crust it could not reach. Measured after the
   * shot — `me y=994, feet 1007, rockBelow 16` across the whole body width.
   *
   * A rocket clears about `BAZOOKA_BLAST_RADIUS` around where it lands, so the
   * floor must both start at the feet and be thin enough to go through.
   */
  const usable = (x, y) => {
    const feetY = Math.floor(y)
    if (!core.solidAt(x, feetY)) return false
    const n = rockBelow(x, feetY)
    return n > 0 && n <= k.BAZOOKA_BLAST_RADIUS
  }
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

let site = await probeSite()

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
/**
 * **Dig your own shaft, straight down, from wherever you are.**
 *
 * This required the player to already be standing on the thin floor and failed
 * outright otherwise. That was never part of T15.02's claim — *the floor can be
 * dug through and below it is death* — it was a convenience the old map granted
 * by spawning on the crust. Pass 6b moved the spawn points
 * (`OBJECT_CLEAR_OF_SPAWN` pushes spawn candidates away from scenery) and the
 * convenience went with it: the spawn is at y~881 with `FLOOR_CRUST` at 1008 and
 * nothing diggable underfoot for the whole width of the body.
 *
 * Everything tried in between failed for its own reason and is recorded so the
 * next person does not retry it: walking to a diggable column overshot by 42 px
 * (each poll is a round trip, so real sampling is ~100 ms and the body steps
 * over any window); braking from the observed speed did not change that; a
 * sign-change test still coasted past; and converging by walk-settle-reprobe
 * oscillated 42 px, then 22 px, and never reached zero.
 *
 * So make the situation instead of looking for it. `BAZOOKA_BLAST_RADIUS` is 42
 * against ~127 px of descent, and **each shot drops the player into its own
 * crater**, so the next is fired from lower down. No walking, no pathfinding, no
 * pinned seed, and it tests strictly more of the claim than standing on the
 * crust already did.
 *
 * Two things this has to respect. A rocket at your own feet throws you
 * (`docs/21` §5 — the same thing that bit `fireUntil` in the ordnance work), so
 * the position is re-probed between shots rather than assumed. And the shaft is
 * bounded by the ammunition actually in the inventory: running dry is a finding
 * about `DEV_LOADOUT`, not a reason to weaken the assertion.
 */
await selectWeapon(page, 'bazooka')

/** Solid pixels between the player's feet and the bottom of the map, in a column. */
const depthAt = (x) =>
  page.evaluate(
    ([col, h]) => {
      const core = window.__game.core
      const me = core.playerState(window.__game.debug().me ?? 0)
      if (!me) return null
      const feet = Math.floor(me.y + 14)
      const at = col === null ? Math.round(me.x) : col
      let rock = 0
      for (let y = feet; y < h; y++) if (core.solidAt(at, y)) rock += 1
      return { rock, x: Math.round(me.x), y: Math.round(me.y), feet, col: at }
    },
    [x, mapH],
  )
const shaftDepth = () => depthAt(null)

/**
 * **Dig beside you, wait out the window, then walk in.**
 *
 * That is what this check always did, and the only thing pass 6b broke was the
 * *distance to the crust*: the spawn stopped landing on thin floor, so there was
 * nothing beside you worth shooting. The seed is now probed for that property
 * rather than assumed to have it.
 *
 * Digging **underneath** yourself was tried and is wrong, and the reason is
 * worth keeping: the shaft opens under you, you fall the instant it does, and
 * that is always inside `ASSIST_WINDOW` of your own last rocket — so the kill is
 * credited to the rocket and the overlay reads *"You killed yourself"*. Measured
 * on seeds 5 and 25. It also costs ~25 health a shot, and four rockets is all
 * `DEV_LOADOUT` grants.
 *
 * A hole to the side costs far less health, leaves you standing, and lets the
 * assist window expire before you step in — which is what keeps the death
 * attributed to the void.
 */
const loadout = await page.evaluate(() => {
  const slots = window.__game.debug().slots ?? []
  return { bazooka: slots.find((sl) => sl.key === 'bazooka')?.count ?? 0 }
})
const PLAYER_W = await page.evaluate(() => window.__game.constants().PLAYER_W)
const BLAST = await page.evaluate(() => window.__game.constants().BAZOOKA_BLAST_RADIUS)
/**
 * How much rock one rocket can be expected to take out of a column.
 *
 * A claim about penetration, so it is derived from `BAZOOKA_BLAST_RADIUS` rather
 * than spelled as a number. It was `40`, which is `42` with the reason filed
 * off — and a literal like that stays green against a blast radius that has
 * moved, which is the failure this project wrote its constants rule for.
 */
const ONE_ROCKET_PX = BLAST
/**
 * Far enough that the crater cannot undermine the player's own footing.
 *
 * **Derived from the blast radius, not from the body.** This was
 * `PLAYER_W * 1.5` — 24 px — against a `BAZOOKA_BLAST_RADIUS` of 42, so the
 * crater reached 18 px *past* the player's centre and always ate the ground
 * they were standing on. Staying upright through the `ASSIST_WINDOW` wait was
 * then luck: measured, they were unsupported on the first poll after the shot,
 * and on 2 runs in 8 they fell before the wait could react — inside the window,
 * so the server credited the rocket and the check read "You killed yourself".
 *
 * `BLAST + PLAYER_W` puts the crater's near edge a half-body clear of the
 * footprint, which is what makes "dig beside, wait, walk in" mean what it says.
 */
const DIG_OFFSET = Math.round(BLAST + PLAYER_W)
const before = await shaftDepth()

/**
 * The column to open: one body-width to the side, whichever side has floor.
 *
 * Probed, not assumed — a hole dug into thin air is not a hole, and which side
 * of the player the crust continues on is a fact about the map.
 */
const dig = await (async () => {
  for (const side of [1, -1]) {
    const col = before.x + side * DIG_OFFSET
    const d = await depthAt(col)
    if (d && d.rock > 0 && d.rock <= ONE_ROCKET_PX) return { col, side, rock: d.rock }
  }
  return null
})()
if (!dig) {
  fail(
    `no thin floor within a body width either side of the player at (${before.x}, ` +
      `${before.y}) — nothing to dig through here`,
  )
}
ok(
  `digging beside the player: column x=${dig?.col} carries ${dig?.rock} px of rock to the ` +
    `void, ${loadout.bazooka} rockets in hand`,
)

/**
 * Deaths before any digging starts.
 *
 * Taken **here**, not at the fall loop. The player can die during the
 * `ASSIST_WINDOW` wait that follows the dig, and the fall loop would then be
 * looking for a death already in the past.
 */
const deathsBefore = ((await dbg()).observed?.deaths ?? []).length

/** Why the dig stopped, when it did. Named, never collapsed into one number. */
let stopped = null
const opened = await (async () => {
  if (!dig) return null
  let prev = dig.rock
  let dead = 0
  for (let shot = 1; shot <= loadout.bazooka; shot++) {
    await selectWeapon(page, 'bazooka')
    await standStill(page)
    // Beside, at floor level, **through the live camera** — not a fixed screen
    // pixel, which is only the right column when the camera happens to centre
    // the player.
    const here = await shaftDepth()
    const aimAt = await toScreen(page, dig.col, here.feet + 6)
    if (!aimAt || !aimAt.onScreen) {
      stopped = `cannot aim at the column beside the player — (${dig.col}) is off screen`
      return null
    }
    await page.mouse.move(aimAt.x, aimAt.y)
    await page.evaluate('window.__game.fire()')

    for (let w = 0; w < 25; w++) {
      await sleep(150)
      const d = await depthAt(dig.col)
      if (d && d.rock === 0) return { shot, col: dig.col }
    }

    const after = await depthAt(dig.col)
    const health = (await dbg()).health ?? 0
    console.log(
      `    dig: rocket ${shot}/${loadout.bazooka} into x=${dig.col}, ${after?.rock} px left, ` +
        `health ${health}`,
    )
    // Two consecutive shots that change nothing: the crater is not where we are
    // aiming. One dead shot happens for ordinary reasons.
    if (after && after.rock === prev) dead++
    else dead = 0
    if (dead >= 2) {
      stopped =
        `two rockets in a row left x=${dig.col} at ${after?.rock} px — the blast is not ` +
        'reaching the column being dug'
      return null
    }
    // This check asserts the *cause* of death, so dying to your own ordnance is
    // not a pass and must not be read as one.
    if (health <= 0) {
      stopped = `the player died of their own ordnance after rocket ${shot}`
      return null
    }
    prev = after?.rock ?? prev
  }
  const left = await depthAt(dig.col)
  stopped =
    `spent all ${loadout.bazooka} rockets and left ${left?.rock} px of rock in x=${dig.col} — ` +
    'DEV_LOADOUT does not carry a hole this deep'
  return null
})()

if (!opened) {
  fail(stopped ?? 'the shaft did not reach the void')
} else {
  ok(`the floor beside the player is open after ${opened.shot} rocket(s), at x=${opened.col}`)
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
// **Poll through the wait, do not sleep through it.** On a map where the shaft
// opens under the player, they fall and die during this window — and the
// overlay comes up and is cleared by the respawn before anything looks at it.
// Measured on seed 5: `walked off the edge` passed and the very next assertion
// reported `no death overlay` about a player already back at y=652 with full
// health. Latching here catches the overlay wherever in the sequence it appears.
/**
 * The nearest column the player would **fall through**, as an offset.
 *
 * **Measured across the body, not down one line.** This scanned a single
 * centre column, and a single column is not what holds a player up: the
 * physics supports you if solid meets your body box, which is `PLAYER_W`
 * wide. Standing on the lip of a freshly dug hole, the centre column reads
 * empty while the box is still resting on the far edge — so this reported
 * `dx: 0` ("you are already over it"), the loop below held no key and waited
 * for a gravity that was never coming, and 25 s later the check said the
 * player never left the map.
 *
 * Measured: `col={"dx":0} me=(945,1004) grounded=true` for the whole
 * deadline, unmoved, while the hole it had just dug sat at x=984. The death
 * the check went on to assert was real — it happened after the walk loop gave
 * up, inside the 12 s fallback below.
 *
 * Asking the same question the game asks is what makes `dx: 0` mean "nothing
 * is holding me".
 */
const openColumn = () =>
  page.evaluate(
    ([h, halfW]) => {
      const core = window.__game.core
      const me = core.playerState(window.__game.debug().me ?? 0)
      if (!me) return null
      const feet = Math.floor(me.y + 14)
      const unsupported = (cx) => {
        for (let x = cx - halfW; x <= cx + halfW - 1; x++) {
          for (let y = feet; y < h; y++) if (core.solidAt(x, y)) return false
        }
        return true
      }
      for (let dx = 0; dx <= 64; dx += 4) {
        for (const sign of [-1, 1]) {
          if (unsupported(Math.round(me.x) + sign * dx)) return { dx: sign * dx }
        }
      }
      return null
    },
    [mapH, 8],
  )

let deathSnapshot = null
{
  const until = Date.now() + assistWindow * 1000 + 700
  // **Stay on solid ground while the window runs.**
  //
  // Waiting the window out only works if the player is still standing at the
  // end of it. Once the footing probe below started asking the question the
  // physics asks — across the body box rather than down one column — the dig
  // sometimes leaves the player already unsupported, and they fall *inside*
  // `ASSIST_WINDOW`. The server then credits the rocket, correctly, and the
  // check fails on the wording: measured, 2 runs in 8 read "You killed
  // yourself" and `attributed to "self"`.
  //
  // So if nothing is holding them up, step away from the hole until the window
  // expires. This is the same trap M16 hit from the other side — digging
  // *underneath* produced a rocket-attributed death — and it is why the wait
  // exists at all.
  let backedOff = null
  while (Date.now() < until) {
    const d = await dbg()
    if (d.death.visible) {
      deathSnapshot = d
      break
    }
    const col = await openColumn()
    // `dx === 0` now means "the body box has nothing under it".
    const away = col && col.dx === 0 ? (dig.side < 0 ? 'd' : 'a') : null
    if (backedOff !== away) {
      if (backedOff) await page.keyboard.up(backedOff)
      if (away) await page.keyboard.down(away)
      backedOff = away
    }
    await sleep(100)
  }
  if (backedOff) await page.keyboard.up(backedOff)
  if (Date.now() < until) await sleep(until - Date.now())
}

// **Heal before walking in, so only the void can kill.**
//
// The dig costs ~25 health a rocket, and the check then asks the *void* to be
// the cause of death. On 1 run in 8 the blast or the fall finished the player a
// few pixels above the line: the server returned `SelfInflicted`, correctly —
// `is_in_the_void` was false, so the rocket inside `ASSIST_WINDOW` took the
// credit. The fixture was competing with itself for the kill.
//
// `Q` is the shipped binding (§C9) and `DEV_LOADOUT` now grants medkits, so this
// uses the real path and adds no dev surface. Asserted, not assumed: a heal that
// silently did nothing would put the confound straight back.
{
  const before = (await dbg()).health
  for (let i = 0; i < 3; i++) {
    await page.keyboard.press('q')
    await sleep(250)
  }
  const after = (await dbg()).health
  if (!(after > before) && before < 100) {
    fail(`healing did nothing: ${before} -> ${after} health, heals ${(await dbg()).hudBars?.heals}`)
  } else {
    ok(`healed before walking in: ${before} -> ${after} health`)
  }
}

// **Walk in.** The body perches on the lip of its own crater — `supported` keeps
// you up while *any* part of the base has rock under it — so blowing the hole is
// only half of "dig a hole through the floor and fall in". Measured: after the
// shot the left half of the footprint had 0 px under it and the right half still
// had 16.
let fell = false
if (opened) {
  /**
   * Steer from a **fresh** probe, not from where the hole was when it opened.
   *
   * The direction was computed once, from `opened.dx`, and `dx === 0` — the hole
   * directly underfoot — resolved to "walk left", away from it. It is also stale
   * by the time it is used: the blast drops the player into the crater, they
   * settle on whatever rock is left, and the open column is no longer where it
   * was when it was found. Measured, the player came to rest at y=1004 with the
   * map bottom at 1024 and simply stood there.
   */


  const deadline = Date.now() + 25_000
  let held = null
  // **Count the deaths, do not try to catch the overlay.** Falling out of the
  // world kills and then respawns, and both can happen between two polls: on
  // seed 5 the player went through the hole and the next sample read y=652 with
  // health 100 — a fresh spawn — so `death.visible` was false and `y > mapH` had
  // already stopped being true. The counter cannot be missed that way, and its
  // baseline is taken before the first rocket for the same reason.
  // **Latch the overlay while we are still looking**, the way `death.mjs` does
  // (`f1d2d2a`). The old code broke out of this loop the moment the death was
  // detected and only then began polling for the overlay — by which time the
  // respawn had cleared it, so `no death overlay` was reported about a death
  // that had displayed one perfectly well.
  let graceUntil = null
  while (Date.now() < deadline) {
    const now = await dbg()
    const died = ((now.observed?.deaths ?? []).length) > deathsBefore
    if (died || now.death.visible || (now.player && now.player.y > mapH)) {
      fell = true
      if (now.death.visible) {
        deathSnapshot = now
        break
      }
      // Died but the overlay has not come up yet: keep watching for it rather
      // than leaving and finding it gone.
      graceUntil ??= Date.now() + 6000
      if (Date.now() > graceUntil) break
      await sleep(100)
      continue
    }
    const col = await openColumn()

    // Directly over it: hold nothing and let gravity do the work. Holding a
    // direction here is what walks off the hole instead of into it.
    const want = !col || col.dx === 0 ? null : col.dx < 0 ? 'a' : 'd'
    if (held !== want) {
      if (held) await page.keyboard.up(held)
      if (want) await page.keyboard.down(want)
      held = want
    }
    await sleep(100)
  }
  if (held) await page.keyboard.up(held)
  if (fell) ok('walked off the edge and out of the world')
  else fail('walked into the hole and never left the map')
}

// --- what the player sees ---------------------------------------------------
const dead = await (async () => {
  if (deathSnapshot) return deathSnapshot
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
