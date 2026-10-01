#!/usr/bin/env node
/**
 * `respawn-kit` — T23.28 item 3. Owner, 2026-10-01: *"when you die in full weapons mode you respawn and your inventory
 * is empty until you click something in it (switch from 1 to 2 or something)."*
 *
 * The cause was the server's: the kit is re-granted after the step that respawns you, through `give`, which announces
 * nothing — so the last `inventory` the client heard was the death's empty bag (`room.rs::tick_once`, and
 * `a_respawn_announces_the_start_kit` there).
 *
 * ana hosts a private room with the **All** kit (the menu's route), plays, and is put below the map (`debugPlace`)
 * to die. Three ends, compared at three moments: the server's bag (`probeRound().players[].filled`), the client's
 * (`debug().slots`) and the hotbar's filled tiles (`#inventory [data-filled="1"]`).
 *
 * 1. At spawn — the control: all three hold the kit (more than the shovel).
 * 2. Dead: the bag is empty at all three (the death's `inventory` arrives — the precondition for 3 to mean anything).
 * 3. Respawned, **no key pressed**: all three hold the kit again.
 *
 *   node scripts/checks/respawn-kit.mjs
 */
import { startStack, freePort, tally, sleep, openAtMenu } from './harness.mjs'
import { constants as rustConstants } from '../lib/rust-constants.mjs'

const { fail, ok, finish } = tally('respawn-kit')
const RESPAWN_DELAY = rustConstants().get('RESPAWN_DELAY')

const stack = await startStack({
  port: await freePort(),
  label: 'respawn-kit',
  env: { BOT_COUNT: '0', FIXED_SEED: '4242', WEATHER: 'off', DEV_WARMUP_SECONDS: '2', DEV_PROBE: '1' },
})
let ana = null
const teardown = async () => {
  if (ana?.errors?.length) fail(`page errors: ${ana.errors.join(' | ')}`)
  await stack.close()
}
const until = async (what, fn, ms) => {
  const end = Date.now() + ms
  for (;;) {
    const v = await fn()
    if (v) return v
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`)
    await sleep(100)
  }
}

try {
  ana = await openAtMenu(stack, 'ana')
  const p = ana.page
  await p.evaluate(() => document.querySelector('#private')?.click())
  await p.evaluate(() => document.querySelector('#host')?.click())
  await p.waitForFunction('window.__menu.visibleCode().length === 6', null, { timeout: 30_000 })
  const kit = () => p.evaluate(() => window.__menu.settings().kit.value)
  for (let i = 0; i < 3 && (await kit()) !== 'All'; i++) {
    const was = await kit()
    await p.evaluate(() => window.__menu.step('kit', 1))
    await p.waitForFunction((v) => window.__menu.settings().kit.value !== v, was, { timeout: 10_000 }).catch(() => {})
  }
  if ((await kit()) !== 'All') throw new Error(`the kit never reached All: "${await kit()}"`)
  await p.evaluate(() => window.__menu.ready(true))
  await p.waitForFunction('window.__game && window.__game.debug().phase === "playing"', null, { timeout: 90_000 })

  const ends = async () => {
    const s = await p.evaluate(() => window.__game.probeRound())
    return p.evaluate((server) => {
      const d = window.__game.debug()
      const mine = server?.players?.find((q) => q.id === d.me)
      return {
        server: mine?.filled ?? -1,
        client: d.slots.filter((sl) => sl.key !== null).length,
        hotbar: document.querySelectorAll('#inventory [data-filled="1"]').length,
        alive: d.death.meAlive,
        mapH: d.mapH,
      }
    }, s)
  }
  const agree = (e) => e.server === e.client && e.client === e.hotbar
  const show = (e) => `server ${e.server}, client ${e.client}, hotbar ${e.hotbar}`

  // ------------------------------------------------------------------ 1. at spawn, the control
  const spawn = await until('the kit at all three ends', async () => {
    const e = await ends()
    return agree(e) && e.server > 1 ? e : null
  }, 10_000).catch(() => null)
  const at = spawn ?? (await ends())
  if (!spawn) fail(`at spawn the kit is not at all three ends: ${show(at)}`)
  else ok(`at spawn: ${show(at)} — the kit, everywhere`)

  // ------------------------------------------------------------------ 2. dead
  await p.evaluate((h) => window.__game.debugPlace(200, h + 400), at.mapH)
  const dead = await until('a death', async () => {
    const e = await ends()
    return e.alive ? null : e
  }, 10_000)
  const empty = await until('the dead bag at all three ends', async () => {
    const e = await ends()
    return !e.alive && agree(e) && e.server <= 1 ? e : null
  }, 3000).catch(() => null)
  if (!empty) fail(`dead, the bag is not empty at all three ends: ${show(await ends())} — the respawn leg cannot see a change`)
  else ok(`dead: ${show(empty)} (first read ${show(dead)})`)

  // ------------------------------------------------------------------ 3. respawned, no key pressed
  await until('the respawn', async () => (await ends()).alive, (RESPAWN_DELAY + 10) * 1000)
  const back = await until('the kit back at all three ends', async () => {
    const e = await ends()
    return agree(e) && e.server === at.server ? e : null
  }, 3000).catch(() => null)
  if (!back) fail(`respawned with no key pressed, the kit is not back everywhere: ${show(await ends())} (at spawn: ${show(at)})`)
  else ok(`respawned, no key pressed: ${show(back)} — the kit at every end`)
} catch (e) {
  fail(String(e?.stack ?? e))
}
await finish(teardown)
