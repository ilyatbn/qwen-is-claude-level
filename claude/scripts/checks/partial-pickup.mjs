#!/usr/bin/env node
/**
 * `partial-pickup` — T23.41 (T23.37 item 1's browser leg): **after a partial pickup, both ends hold the same stack.**
 *
 * The server sends `item_pickup { remaining }` (T23.29 item 1) and the client keeps the ground item at that count
 * (`net/worldMirror.ts`, T23.37 item 1) instead of deleting it. Until this check only a vitest fed the mirror a
 * hand-written event; nothing staged a real partial pickup and read both ends.
 *
 * One human on a `DEV_PROBE=1` server, standing on open ground (`debugPlace`):
 * 1. **The partial pickup.** A medkit stack of `MAX_HEALS + 1` is laid at her feet (`debugItem` →
 *    `World::dev_drop_item`). Heals are a counter capped at `MAX_HEALS`, so she can take at most that many and at least
 *    one stays. Then the server is asked what it holds of that world item (`debugItem({ id })`) and the client's
 *    mirror is read (`debug().mirrorItems`): both counts must be equal, above 0, and below the stack laid.
 * 2. **The control — a whole pickup.** A single pistol (an inventory item with room) at her feet: the server holds 0
 *    of it and the mirror no longer has it — "gone" agreed at both ends, so (1) is not a client that never deletes.
 *
 * Planted (the mirror deletes on every `item_pickup`, as before T23.37): (1) red — the server 1, the client none.
 *
 *   node scripts/checks/partial-pickup.mjs
 */
import { startStack, enterBattle, freePort, tally, sleep } from './harness.mjs'

const { fail, ok, finish } = tally('partial-pickup')

const stack = await startStack({
  port: await freePort(),
  label: 'partial-pickup',
  env: { BOT_COUNT: '0', FIXED_SEED: '4242', WEATHER: 'off', DEV_PROBE: '1', ROUND_SECONDS: '300' },
})
try {
  const client = await stack.openClient({ name: 'ana' })
  const page = client.page
  await enterBattle(page, { expectPlayers: 1, waitPlaying: true, label: 'partial-pickup/ana' })
  const k = await page.evaluate(() => window.__game.constants())
  for (const n of ['MAX_HEALS', 'PLAYER_H']) if (!Number.isFinite(k[n])) throw new Error(`${n} is not exposed to the client (${k[n]})`)

  // Open ground near the map's middle: the first rock in a column with clear air above it.
  const spot = await page.evaluate((h) => {
    const c = window.__game.core
    for (let k = 0; k < 80; k++) {
      const x = Math.round(c.width / 2 + (k % 2 ? -1 : 1) * Math.ceil(k / 2) * 37)
      for (let y = 40; y < c.height - 4; y++) {
        if (!c.solidAt(x, y)) continue
        let clear = true
        for (let yy = y - h * 2; yy < y && clear; yy += 2) clear = !c.solidAt(x, yy)
        if (clear) return { x, y: y - h / 2 - 1 }
        break
      }
    }
    return null
  }, k.PLAYER_H)
  if (!spot) throw new Error('no open ground on seed 4242')
  await page.evaluate(([x, y]) => window.__game.debugPlace(x, y), [spot.x, spot.y])
  await page.waitForFunction(() => window.__game.debug().stand.lastPlace !== null, null, { timeout: 10_000 })
  await sleep(1000)

  const ask = async (spec) => {
    await page.evaluate((s) => window.__game.debugItem(s), spec)
    await page.waitForFunction(() => window.__game.debug().lastItem !== null, null, { timeout: 10_000 })
    return page.evaluate(() => window.__game.debug().lastItem)
  }
  const mirrored = (id) => page.evaluate((id) => window.__game.debug().mirrorItems.find((i) => i.id === id) ?? null, id)
  /** Lay `count` of `key` at her feet, wait until a pickup is heard (or 5 s), then read both ends. */
  const pickups = () => page.evaluate(() => window.__game.debug().observed.itemPickups)
  const layAndWait = async (key, count) => {
    const before = await pickups()
    const laid = await ask({ key, count, x: spot.x, y: spot.y })
    if (!laid || !Number.isFinite(laid.id)) throw new Error(`debug_item laid nothing: ${JSON.stringify(laid)}`)
    const heard = await page
      .waitForFunction((n) => window.__game.debug().observed.itemPickups > n, before, { timeout: 5_000, polling: 50 })
      .then(() => true)
      .catch(() => false)
    await sleep(500) // a few ticks more, so a later (wrong) change would have landed too
    const server = await ask({ id: laid.id })
    const client = await mirrored(laid.id)
    return { laid, heard, server: server?.count, client: client ? client.count : null }
  }

  // --- 1. the partial pickup ------------------------------------------------------------------------------------
  const stackN = k.MAX_HEALS + 1
  const p = await layAndWait('medkit', stackN)
  const l1 = `a medkit stack of ${stackN} (MAX_HEALS ${k.MAX_HEALS}) laid at her feet: a pickup heard ${p.heard}; the server holds ${p.server}, the client's mirror ${p.client === null ? 'nothing' : p.client}`
  if (!p.heard) fail(`${l1} — no pickup reached the mirror`)
  else if (p.client === null) fail(`${l1} — the client dropped a stack the server still holds`)
  else if (p.server !== p.client) fail(`${l1} — the two ends disagree`)
  else if (!(p.server > 0 && p.server < stackN)) fail(`${l1} — not a partial pickup (want 0 < left < ${stackN})`)
  else ok(l1)

  // --- 2. the control: a whole pickup, agreed gone ---------------------------------------------------------------
  const w = await layAndWait('pistol', 1)
  const l2 = `control — one pistol laid at her feet: the server holds ${w.server}, the client's mirror ${w.client === null ? 'nothing' : w.client}`
  if (w.server === 0 && w.client === null) ok(l2)
  else fail(`${l2} — a whole pickup is not "gone" at both ends`)
  await client.shot('partial-pickup')
} finally {
  await stack.close()
}
await finish()
