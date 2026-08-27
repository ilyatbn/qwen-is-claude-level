#!/usr/bin/env node
/**
 * T14.04 / §C11 — `E` throws a grenade from anywhere in the inventory.
 *
 *   node scripts/checks/quick-throw.mjs
 *   node scripts/e2e.mjs quick-throw
 *
 * ## Why a browser check as well as the unit tests
 *
 * `world::quickthrow` proves the choice, the order, the cooldown and the
 * untouched selection. What it cannot prove is that **the key is wired to any of
 * it**: `E` used to send `use_item`, and a keybinding that goes nowhere passes
 * every simulation test there is. Twelve mechanisms on this project were built,
 * tested and wired to nothing (§A15), so the assertion here is on the real key
 * going through the real socket to the real server.
 */
import { startStack, enterBattle, tally, sleep, standStill } from './harness.mjs'

const PORT = 3124
const { fail, ok, finish } = tally('quick-throw')

const stack = await startStack({
  port: PORT,
  label: 'quick-throw',
  // The dev loadout carries molotovs, which are grenade-class. No bots: another
  // player's projectiles would be counted by the same field.
  // **`FIXED_SEED` so the terrain is the same every run.** This asserts a
  // mechanism — E throws a grenade-class item, leaves the selection alone, and
  // does nothing at all with none — none of which is about maps. Unpinned, the
  // throw's clear lane depended on the map: the bottle detonated at the player's
  // feet, laid a fire zone, and `standStill` held them in it until they died,
  // which surfaced as two assertions blaming production code.
  env: { FIXED_SEED: '4242', ROUND_SECONDS: '180', BOT_COUNT: '0', DEV_LOADOUT: '1' },
})
const { page, dbg, shot, pageErrors } = await stack.openClient({ name: 'ana' })
await enterBattle(page, { waitPlaying: true, label: 'quick-throw' })

const held = async () => {
  const slots = (await page.evaluate(() => window.__game.debug().slots)) ?? []
  return slots.filter((s) => s.key).map((s) => `${s.slot + 1}:${s.key}x${s.count}`)
}

// The dev loadout's selection starts on the bazooka in slot 1. §C11's whole
// point is that the throw does not disturb it.
const before = await dbg()
const selectedBefore = before.selectedSlot
const molotovBefore = (before.slots ?? []).find((s) => s.key === 'molotov')?.count ?? 0
ok(`holding ${(await held()).join(' ')}, selection on slot ${selectedBefore + 1}`)

if (molotovBefore === 0) {
  fail('the dev loadout carries no grenade-class item, so there is nothing to throw')
} else {
  /**
   * Aim up and to the right, then press.
   *
   * Two reasons, both learned the hard way here. The aim is sampled from the
   * pointer, and the pointer starts at (0, 0) — up and to the *left* of a player
   * at the screen centre — so an unaimed throw lobs the bottle a few pixels and
   * it is on the ground before the first poll. And a molotov at your own feet is
   * fatal: the same trap `ordnance` fell into, where the player burned to death
   * and every assertion afterwards was about a respawned one.
   *
   * §C20 also refuses a shot from a moving player, silently, so the settle is
   * not optional either.
   */
  /**
   * A screen point to aim at, **probed from the mask** rather than hardcoded.
   *
   * `(1100, 220)` used to sit here and it was already the second attempt at this
   * problem. It works only while the player happens to spawn with open sky in
   * that screen direction — and T15.02 regenerated every map, so on a spawn like
   * (160, 526) that fixed point aims into rock: the bottle detonates at the
   * player's own feet, lays a fire zone, `standStill` holds them in it, and they
   * burn to death. Measured, that killed the player in roughly one run in four,
   * and the two assertions that then failed both blamed `E`.
   *
   * So: march the mask outward along several upward headings and take the first
   * that is clear for `REACH` px. A molotov arcs, so a clear straight line is a
   * proxy rather than a guarantee — but it rules out the case that actually
   * happens, which is rock within a body's length of the muzzle.
   */
  const REACH = 260
  const aimScreen = async () =>
    page.evaluate((reach) => {
      const d = window.__game.debug()
      const core = window.__game.core
      const raw = d.worldView
      const v = { x: raw.x, y: raw.y, w: raw.width ?? raw.w, h: raw.height ?? raw.h }
      const rect = document.querySelector('canvas').getBoundingClientRect()
      // Up and outward, both ways, shallowest first: a flatter throw travels
      // further before gravity brings it down, which is what puts it on screen.
      const headings = [-0.5, -0.8, -0.3, -1.1, -1.6]
      // Scored, not first-past-the-post: the *longest* clear lane throws the
      // bottle furthest from the thrower, and distance is the whole point.
      let best = null
      for (const dy of headings) {
        for (const dx of [1, -1]) {
          const len = Math.hypot(dx, dy)
          let open = 0
          for (let t = 24; t <= reach; t += 8) {
            const wx = d.player.x + (dx / len) * t
            const wy = d.player.y + (dy / len) * t
            if (core.solidAt(Math.round(wx), Math.round(wy))) break
            open = t
          }
          if (!best || open > best.open) best = { dx, dy, len, open }
        }
      }
      if (!best || best.open < 120) return null
      const wx = d.player.x + (best.dx / best.len) * best.open
      const wy = d.player.y + (best.dy / best.len) * best.open
      return {
        x: rect.left + ((wx - v.x) / v.w) * rect.width,
        y: rect.top + ((wy - v.y) / v.h) * rect.height,
        dx: best.dx,
        dy: best.dy,
        open: best.open,
      }
    }, REACH)

  const throwIt = async (during = () => sleep(900)) => {
    await standStill(page)
    // A spawn can land in a pocket with no room to throw. That is a fact about
    // the map, not a defect in `E`, so walk and look again before giving up —
    // the same move `debug-mode` makes when its first run has no room to run in.
    let aim = await aimScreen()
    for (let tries = 0; !aim && tries < 3; tries++) {
      const dir = tries % 2 === 0 ? 'd' : 'a'
      await page.keyboard.down(dir)
      await sleep(600)
      await page.keyboard.up(dir)
      await standStill(page)
      aim = await aimScreen()
    }
    if (!aim) {
      // Asserted, not assumed: without a clear lane the throw is fatal and every
      // assertion after it would be about a corpse.
      fail('no clear lane of at least 120 px to throw along, even after moving — boxed in')
      return false
    }
    await page.mouse.move(aim.x, aim.y)
    await sleep(140)
    await page.keyboard.press('e')

    // **Then walk the other way while it is in the air.**
    //
    // A clear lane is not enough and the third run proved it: a molotov arcs
    // under gravity at `gravity_scale` 1.0, so a lane that is clear in a straight
    // line still ends with the bottle on the ground a short hop away — and
    // `explode_on_contact` lays a fire zone `LAVA_BURN_RADIUS` wide right there.
    // Standing in it is what killed the player. `ordnance` learned the same
    // lesson on the same weapon and leaves while the bottle is airborne; this
    // does too. The walk is after the press, so §C20's moving-shooter rule has
    // already been satisfied by the settle above.
    // The walk runs **while the caller watches**, not before it starts looking.
    // Doing the 900 ms first and polling afterwards spends exactly the window the
    // bottle is airborne in, and turns "it was in the air" into a report about an
    // empty sky — which is the failure this check began with.
    const away = aim.dx > 0 ? 'a' : 'd'
    await page.keyboard.down(away)
    try {
      await during()
    } finally {
      await page.keyboard.up(away)
    }
    return true
  }

  /**
   * Deaths, read **at the point of use**.
   *
   * The check already had a death guard, and it ran once, against a read taken
   * before the last `E`. The player then burned to death during the sleeps that
   * followed, `die()` emptied all 24 slots, and the final assertion read an empty
   * inventory and reported "`E` spent something else" — a false accusation
   * against production code. Every assertion that depends on the player being the
   * one that was armed now asks first.
   */
  const diedYet = async () => ((await dbg()).observed?.deaths ?? []).length

  const beforeThrow = await dbg()
  const projBefore = beforeThrow.projectilesLive ?? 0
  const spawnsBefore = beforeThrow.observed?.projectileSpawns ?? 0
  let sawInAir = 0
  const watch = async () => {
    for (let i = 0; i < 25; i++) {
      const live = (await dbg()).projectilesLive ?? 0
      if (live > 0) {
        sawInAir = live
        return
      }
      await sleep(40)
    }
  }
  const threw = await throwIt(watch)

  // `watch` above did the polling, from the instant of the press and while the
  // player was walking clear. Polled rather than read once, because a molotov's
  // flight is short and it stops existing when it lands: a single read half a
  // second later sees an empty sky and reports "no projectile was ever
  // announced" about a throw that happened.
  await sleep(400)

  const after = await dbg()
  const molotovAfter = (after.slots ?? []).find((s) => s.key === 'molotov')?.count ?? 0

  // 1. Something was thrown, and it came off the molotov stack.
  if (!threw) {
    // `throwIt` already said why. Saying it again in three more voices would
    // report one cause as four defects.
  } else if (molotovAfter === molotovBefore - 1) {
    ok(`E threw one: molotov ${molotovBefore} → ${molotovAfter}`)
  } else {
    fail(`E did not spend a molotov: ${molotovBefore} → ${molotovAfter}`)
  }

  // 2. Both ends (§A39): the server had a projectile in the air, and the client
  //    drew it. A stack that fell with nothing in the air is a decrement, not a
  //    throw.
  const spawnsAfter = after.observed?.projectileSpawns ?? 0
  if (!threw) {
    // Same cause as above.
  } else if (spawnsAfter > spawnsBefore) {
    ok(
      `and the server announced it — projectile spawns ${spawnsBefore} → ${spawnsAfter}` +
        (sawInAir > projBefore ? `, and it was caught in flight (${sawInAir} live)` : ''),
    )
  } else {
    fail(
      `a molotov left the inventory and the server never announced a projectile ` +
        `(spawns ${spawnsBefore} → ${spawnsAfter}, live peak ${sawInAir})`,
    )
  }

  // 3. The selection is untouched, which is the reason the key exists.
  if (!threw) {
    // Same cause as above.
  } else if (after.selectedSlot === selectedBefore) {
    ok(`the selection is unchanged (slot ${after.selectedSlot + 1})`)
  } else {
    fail(
      `the throw moved the selection from slot ${selectedBefore + 1} to ` +
        `${after.selectedSlot + 1} — §C11 exists so you do not lose your weapon`,
    )
  }

  // 4. The control: `E` with nothing throwable is refused and spawns nothing.
  //    Throw the rest away first, then press it again.
  for (let i = 0; i < 8 && ((await dbg()).slots ?? []).some((s) => s.key === 'molotov'); i++) {
    if (!(await throwIt())) break
    await sleep(700)
    if ((await diedYet()) > 0) break
  }
  const empty = await dbg()
  const deaths = (empty.observed?.deaths ?? []).length
  // The player has to still be the one that was armed: a death drops all 24
  // slots, and then "the bazooka is gone" is true and says nothing about `E`.
  // **One message, and the dependent assertions do not run** — they would only
  // report the death a second time, in the language of a bug they did not find.
  if (deaths > 0) {
    fail(
      `the player died ${deaths} time(s) throwing its own molotovs, so the ` +
        'empty-handed control would be about a corpse and did not run',
    )
  } else if ((empty.slots ?? []).some((s) => s.key === 'molotov')) {
    fail('could not empty the molotov stack, so the empty-handed control did not run')
  } else {
    // **Counted, not sampled.** `projectilesLive` used to be the baseline here and
    // it was read the moment the emptying loop finished, while the last molotov
    // was still resolving — the count then fell and rose on its own, and the
    // control reported "E threw something" about a press that did nothing. The
    // cumulative spawn count cannot be raced in either direction: it is the
    // number of projectiles the server announced, and E must add none.
    await standStill(page)
    // **The empty-handed control is the last press of the drain, not a separate
    // press afterwards.**
    //
    // Two things went wrong with a standalone control. The premise was assumed:
    // the loop above empties the *molotov* stack, and this then asserted "no
    // grenade-class item in the inventory" — which stopped being true when pass
    // 6b moved the surface points items spawn on. Measured, the slots at the
    // moment of failure read `smokex1`, so E threw the smoke exactly as it
    // should and the check called a correct throw a bug.
    //
    // Draining first fixes the premise but not the race: the player is standing
    // where items land, so one can arrive between the drain and the control, and
    // then the control throws that. There is no gap to lose if the drain's own
    // terminal press *is* the control — E pressed with nothing throwable,
    // announcing no projectile. That is the claim, and it is observed rather
    // than set up.
    const seen = []
    let empty = false
    for (let i = 0; i < 12; i++) {
      const n0 = (await dbg()).observed?.projectileSpawns ?? 0
      const slotsBefore = ((await dbg()).slots ?? [])
        .filter((sl) => sl.key && sl.key !== 'null' && sl.count > 0)
        .map((sl) => `${sl.key}x${sl.count}`)
      await page.keyboard.press('e')
      await sleep(600)
      const d1 = await dbg()
      const n1 = d1.observed?.projectileSpawns ?? 0
      seen.push(`${slotsBefore.join(',')} -> spawns ${n0}->${n1}`)
      if ((d1.observed?.deaths ?? []).length > 0) {
        fail('the player died during the empty-handed control, so it proves nothing')
        empty = true
        break
      }
      if (n1 === n0) {
        ok(`control: E with nothing to throw announced no projectile (${n1})`)
        empty = true
        break
      }
    }
    if (!empty) {
      // Twelve presses and every one threw. Either E is throwing with nothing in
      // hand, or the world keeps handing the player throwables — the slot
      // history separates those, so it is printed rather than guessed at.
      fail(
        `E announced a projectile on all 12 presses — either it throws empty-handed ` +
          `or pickups kept refilling it. Slots before each press: ${seen.join(' | ')}`,
      )
    }
    {
      const none = await dbg()
      // ...and it did not quietly reach for something else.
      const stillArmed = (none.slots ?? []).some((s) => s.key === 'bazooka')
      if (stillArmed) ok('and it did not spend a weapon instead')
      else fail('E with no grenade spent something else — it is falling through to fire')
    }
  }
  await shot('quick-throw')
}

if (pageErrors.length) fail(`page errors: ${pageErrors.slice(0, 3).join(' | ')}`)
else ok('no page errors')

await finish(() => stack.close())
