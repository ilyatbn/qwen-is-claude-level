#!/usr/bin/env node
/**
 * T21.43 — the gun platform fires while the button is held.
 *
 *   node scripts/checks/platform-autofire.mjs
 *
 * A real round, a real server, a real mouse. Ana walks onto a gun platform,
 * stands still until the **server** says she is mounted, then holds the left
 * button for about a second.
 *
 * ## Three numbers, compared to each other
 *
 * - **the server's spawns** — `observed.ownProjectileSpawns`, her own rounds as
 *   the server narrated them;
 * - **the rounds drawn** — `projectilesAddedByKind.bullet`, every bullet the
 *   ordnance layer started drawing (no bots, so every bullet is hers);
 * - **the interval** — the hold measured in the *server's* clock
 *   (`serverRoundTime`), divided by `GUN_PLATFORM_FIRE_INTERVAL` from the WASM.
 *
 * Any one alone passes against a broken other: spawns with nothing drawn is the
 * "I cannot see it" bug, and a count with no cadence is satisfied by one volley.
 *
 * ## The control
 *
 * A **single click** on the same platform fires exactly one round. Without it,
 * "holding fired many" is satisfied by a client that fires every frame whatever
 * the button does.
 */
import { join } from 'node:path'
import { startStack, enterBattle, standStill, tally, sleep, shotsDir, freePort } from './harness.mjs'

const PORT = await freePort()
const { fail, ok, failures } = tally('platform-autofire')

const stack = await startStack({
  port: PORT,
  label: 'platform-autofire',
  // No bots: a bot's bullets would be drawn too, and the drawn count would stop
  // being hers. `FIXED_SEED` so the walk to the platform is the same every run.
  env: { FIXED_SEED: '4242', ROUND_SECONDS: '180', BOT_COUNT: '0', DEV_START_HEALTH: '150' },
})

try {
  const { page, dbg, pageErrors } = await stack.openClient({ name: 'ana' })
  await enterBattle(page, { waitPlaying: true, label: 'platform-autofire' })
  const k = await page.evaluate(() => window.__game.constants())
  const interval = k.GUN_PLATFORM_FIRE_INTERVAL
  if (typeof interval !== 'number' || !(interval > 0)) {
    throw new Error(`GUN_PLATFORM_FIRE_INTERVAL is not exposed (got ${interval}) — no cadence to compare`)
  }

  // §B15: read the fields once before anything leans on them.
  const d0 = await dbg()
  if (typeof d0.mount?.mounted !== 'boolean' || !d0.projectilesAddedByKind || !d0.observed) {
    throw new Error(`debug() lacks mount / projectilesAddedByKind / observed: ${JSON.stringify(d0.mount)}`)
  }

  // ------------------------------------------------------------ get on one
  const me = (d) => d.serverPlayer ?? d.player
  const plats = d0.platformPositions ?? []
  if (plats.length === 0) throw new Error('the round has no gun platforms')
  const target = [...plats].sort(
    (u, v) => Math.hypot(u.x - me(d0).x, u.y - me(d0).y) - Math.hypot(v.x - me(d0).x, v.y - me(d0).y),
  )[0]
  console.log(`[platform-autofire] ana at (${Math.round(me(d0).x)},${Math.round(me(d0).y)}), walking to #${target.id} at (${target.x},${target.y})`)

  const walkBy = Date.now() + 60_000
  let key = null
  let lastX = me(d0).x
  let lastProgressAt = Date.now()
  for (;;) {
    const d = await dbg()
    const p = me(d)
    if (d.mount.platformUnderfoot === target.id && d.player?.grounded === true) break
    if (Date.now() > walkBy) {
      throw new Error(`could not reach platform #${target.id}: ana at (${Math.round(p.x)},${Math.round(p.y)})`)
    }
    const dx = target.x - p.x
    const want = Math.abs(dx) < k.GUN_PLATFORM_W / 4 ? null : dx > 0 ? 'd' : 'a'
    if (want !== key) {
      if (key) await page.keyboard.up(key)
      if (want) await page.keyboard.down(want)
      key = want
    }
    if (Math.abs(p.x - lastX) > 4) {
      lastX = p.x
      lastProgressAt = Date.now()
    } else if (want && Date.now() - lastProgressAt > 500) {
      // Stuck on a step or a wall: jump, then hold for the jetpack to climb.
      await page.keyboard.down('Space')
      await sleep(80)
      await page.keyboard.up('Space')
      await sleep(80)
      await page.keyboard.down('Space')
      await sleep(450)
      await page.keyboard.up('Space')
      lastProgressAt = Date.now()
    } else if (!want && target.y < p.y - k.PLAYER_H) {
      // Right under it: climb straight up.
      await page.keyboard.down('Space')
      await sleep(80)
      await page.keyboard.up('Space')
      await sleep(80)
      await page.keyboard.down('Space')
      await sleep(350)
      await page.keyboard.up('Space')
    }
    await sleep(60)
  }
  if (key) await page.keyboard.up(key)
  await standStill(page)
  const mountBy = Date.now() + 10_000
  let mounted = false
  while (Date.now() < mountBy) {
    if ((await dbg()).mount.mounted === true) {
      mounted = true
      break
    }
    await sleep(100)
  }
  if (!mounted) throw new Error(`stood on platform #${target.id} and the server never mounted her`)
  ok(`mounted platform #${target.id}`)

  // Aim up and to the right: open sky, so a round lives long enough to be drawn
  // rather than hitting the ground inside one snapshot.
  await page.mouse.move(640 + 260, 360 - 200)
  await sleep(300)

  const sample = async () => {
    const d = await dbg()
    return {
      spawns: d.observed.ownProjectileSpawns ?? 0,
      drawn: d.projectilesAddedByKind.bullet ?? 0,
      t: d.serverRoundTime,
      mounted: d.mount.mounted,
    }
  }

  // ------------------------------------------------------------ hold ~1 s
  const HOLD_MS = 1000
  const a = await sample()
  await page.mouse.down({ button: 'left' })
  const tDown = (await sample()).t
  await sleep(HOLD_MS / 2)
  await page.screenshot({ path: join(shotsDir, 'platform-autofire-held.png') })
  await sleep(HOLD_MS / 2)
  const tUp = (await sample()).t
  await page.mouse.up({ button: 'left' })
  await sleep(900)
  const b = await sample()
  if (!b.mounted) fail('ana dismounted during the hold — the counts below are not the platform')
  const heldServer = tUp - tDown
  const spawns = b.spawns - a.spawns
  const drawn = b.drawn - a.drawn
  const ideal = heldServer / interval
  console.log(
    `[platform-autofire] held ${HOLD_MS} ms wall / ${heldServer.toFixed(3)} s server: ` +
      `${spawns} spawned, ${drawn} drawn, interval ${interval.toFixed(4)} s → ideal ${ideal.toFixed(1)}`,
  )
  // Bounds: the server sample brackets the hold only to a poll's accuracy, so
  // the ideal is ±1 round of slop either side, plus 25 % for the client's frame
  // clock beating against the tick. The floor is what matters — a stream, not a
  // volley; the ceiling says it is not firing every frame.
  if (spawns >= Math.floor(ideal * 0.75) - 1 && spawns <= Math.ceil(ideal * 1.25) + 2 && spawns > 4) {
    ok(`holding fired ${spawns} rounds against a cadence of ~${ideal.toFixed(1)}`)
  } else {
    fail(`holding for ${heldServer.toFixed(3)} s fired ${spawns} rounds, expected ~${ideal.toFixed(1)}`)
  }
  if (drawn >= spawns * 0.9 && drawn <= spawns) {
    ok(`drawn ${drawn} of ${spawns} spawned`)
  } else {
    fail(`the server spawned ${spawns} rounds and the layer drew ${drawn}`)
  }

  // ------------------------------------------------------------ the control
  const c0 = await sample()
  await page.mouse.down({ button: 'left' })
  await page.mouse.up({ button: 'left' })
  await sleep(900)
  const c1 = await sample()
  const clickSpawns = c1.spawns - c0.spawns
  if (clickSpawns === 1) ok('a single click fired exactly 1 round')
  else fail(`a single click fired ${clickSpawns} rounds, expected exactly 1`)
  if (spawns <= clickSpawns) fail(`the hold (${spawns}) did not out-fire the click (${clickSpawns})`)

  if (pageErrors.length) fail(`page errors: ${pageErrors.join(' | ')}`)
} catch (e) {
  fail(String(e?.stack ?? e))
} finally {
  await stack.close()
}
console.log(failures.length ? `\nplatform-autofire: ${failures.length} FAILED` : '\nplatform-autofire: ok')
process.exit(failures.length ? 1 : 0)
