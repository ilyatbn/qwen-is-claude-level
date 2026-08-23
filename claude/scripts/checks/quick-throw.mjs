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
  env: { ROUND_SECONDS: '180', BOT_COUNT: '0', DEV_LOADOUT: '1' },
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
  const throwIt = async () => {
    await standStill(page)
    await page.mouse.move(1100, 220)
    await sleep(140)
    await page.keyboard.press('e')
  }

  const projBefore = (await dbg()).projectilesLive ?? 0
  await throwIt()

  // Polled, not read once. A molotov's flight is short and it stops existing
  // when it lands, so a single read half a second later sees an empty sky and
  // reports "no projectile was ever announced" about a throw that happened.
  let sawInAir = 0
  for (let i = 0; i < 25; i++) {
    const live = (await dbg()).projectilesLive ?? 0
    if (live > 0) {
      sawInAir = live
      break
    }
    await sleep(60)
  }
  await sleep(400)

  const after = await dbg()
  const molotovAfter = (after.slots ?? []).find((s) => s.key === 'molotov')?.count ?? 0

  // 1. Something was thrown, and it came off the molotov stack.
  if (molotovAfter === molotovBefore - 1) {
    ok(`E threw one: molotov ${molotovBefore} → ${molotovAfter}`)
  } else {
    fail(`E did not spend a molotov: ${molotovBefore} → ${molotovAfter}`)
  }

  // 2. Both ends (§A39): the server had a projectile in the air, and the client
  //    drew it. A stack that fell with nothing in the air is a decrement, not a
  //    throw.
  if (sawInAir > projBefore) {
    ok(`and it was in the air — ${sawInAir} live against ${projBefore} before the press`)
  } else {
    fail(
      `a molotov left the inventory and the server never had one in the air ` +
        `(${projBefore} before, peak ${sawInAir})`,
    )
  }

  // 3. The selection is untouched, which is the reason the key exists.
  if (after.selectedSlot === selectedBefore) {
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
    await throwIt()
    await sleep(700)
  }
  const empty = await dbg()
  // The player has to still be the one that was armed: a death drops the
  // inventory, and then "the bazooka is gone" is true and says nothing about `E`.
  if ((empty.observed?.deaths ?? []).length > 0) {
    fail(
      `the player died ${(empty.observed?.deaths ?? []).length} time(s) throwing its own ` +
        'molotovs, so the empty-handed control is about a respawned player',
    )
  }
  if ((empty.slots ?? []).some((s) => s.key === 'molotov')) {
    fail('could not empty the molotov stack, so the empty-handed control did not run')
  } else {
    const liveBefore = empty.projectilesLive ?? 0
    await standStill(page)
    await page.keyboard.press('e')
    await sleep(500)
    const none = await dbg()
    if ((none.projectilesLive ?? 0) > liveBefore) {
      fail('E threw something with no grenade-class item in the inventory')
    } else {
      ok('control: E with nothing to throw spawns nothing')
    }
    // ...and it did not quietly reach for something else.
    const stillArmed = (none.slots ?? []).some((s) => s.key === 'bazooka')
    if (stillArmed) ok('and it did not spend a weapon instead')
    else fail('E with no grenade spent something else — it is falling through to fire')
  }
  await shot('quick-throw')
}

if (pageErrors.length) fail(`page errors: ${pageErrors.slice(0, 3).join(' | ')}`)
else ok('no page errors')

await finish(() => stack.close())
