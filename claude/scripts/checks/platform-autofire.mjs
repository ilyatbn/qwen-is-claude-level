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
import {
  startStack,
  enterBattle,
  standStill,
  selectWeapon,
  tally,
  sleep,
  shotsDir,
  freePort,
} from './harness.mjs'

const PORT = await freePort()
const { fail, ok, failures } = tally('platform-autofire')

const stack = await startStack({
  port: PORT,
  label: 'platform-autofire',
  // No bots: a bot's bullets would be drawn too, and the drawn count would stop
  // being hers. `FIXED_SEED` so the walk to the platform is the same every run.
  //
  // **320 small, not 4242 (T21.40).** T21.40 seats platforms or does not place them,
  // and 4242's nearest platform moved to (1456, 530), half sunk in a slope: 30 of its
  // 48 drawn columns have rock at or above its surface line. The walk reached it 2 runs
  // in 3 and then could not stand still on the sliver of real surface to mount. 320 was
  // chosen by measurement over seeds 1..400: spawn 0 at (176, 335), platform #0 at
  // (240, 335), level, flat ground between, no rock above its base.
  env: { FIXED_SEED: '320', MAP_SCALE: 'small', ROUND_SECONDS: '180', BOT_COUNT: '0', DEV_START_HEALTH: '150' },
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
  const byDistance = [...plats].sort(
    (u, v) => Math.hypot(u.x - me(d0).x, u.y - me(d0).y) - Math.hypot(v.x - me(d0).x, v.y - me(d0).y),
  )
  console.log(
    `[platform-autofire] ana at (${Math.round(me(d0).x)},${Math.round(me(d0).y)}); platforms ` +
      byDistance.map((g) => `#${g.id}@(${g.x},${g.y})`).join(' '),
  )

  const jetpackHop = async (holdMs) => {
    await page.keyboard.down('Space')
    await sleep(80)
    await page.keyboard.up('Space')
    await sleep(80)
    await page.keyboard.down('Space')
    await sleep(holdMs)
    await page.keyboard.up('Space')
  }

  /**
   * Walk to one platform, or give up on it. **Nearest first, each on its own
   * deadline**: a platform can sit in a pocket under the rock a spawn stands on,
   * and the first version of this spent its whole minute ten pixels to the side
   * of one, 108 px above it.
   *
   * Three moves: walk toward it; jump and jetpack when a step stops the walk;
   * and **dig straight down with the shovel** when it is underneath — §F5 seats
   * one in every bag, and a platform's footprint is indestructible, so digging
   * stops on it rather than through it.
   */
  const walkTo = async (target, deadlineMs) => {
    const by = Date.now() + deadlineMs
    let key = null
    let lastX = me(await dbg()).x
    let lastY = me(await dbg()).y
    let lastProgressAt = Date.now()
    let dug = 0
    try {
      for (;;) {
        const d = await dbg()
        const p = me(d)
        if (d.mount.platformUnderfoot === target.id && d.player?.grounded === true) return { ok: true, dug }
        if (Date.now() > by) return { ok: false, at: p, dug }
        const dx = target.x - p.x
        // **Level but not on it yet: keep stepping to the centre (T21.40).** The walk
        // used to stop steering within a quarter footprint, which is only right when
        // the platform is a body above or below (the hop and dig branches). On 4242,
        // after T21.40 moved #0 to (1456, 530), she stopped at (1445, 508) on rock 8 px
        // above its surface line — 11 px off centre, not underfoot, no branch firing —
        // and waited out the deadline (1 run in 3).
        const near = Math.abs(dx) < k.GUN_PLATFORM_W / 4
        const vertical = target.y > p.y + k.PLAYER_H || target.y < p.y - k.PLAYER_H
        const want = near && (vertical || Math.abs(dx) < 2) ? null : dx > 0 ? 'd' : 'a'
        if (want !== key) {
          if (key) await page.keyboard.up(key)
          if (want) await page.keyboard.down(want)
          key = want
        }
        if (Math.abs(p.x - lastX) > 4 || Math.abs(p.y - lastY) > 4) {
          lastX = p.x
          lastY = p.y
          lastProgressAt = Date.now()
        } else if (want && Date.now() - lastProgressAt > 500) {
          // **Stuck: dig toward it, then hop.** Measured on seed 4242, a hop alone
          // left her pinned against the rise between the spawn gate and #0, and
          // in a pit on the way to #2 — the jetpack does not clear either. So
          // swing the shovel along the line to the platform first, the way a
          // player tunnels, aimed through the camera transform so the swing
          // points where the platform is rather than at a guessed screen spot.
          if (key) await page.keyboard.up(key)
          key = null
          const { toScreen } = await import('./pixels.mjs')
          const s = await toScreen(page, target.x, target.y - k.PLAYER_H / 2)
          if (dug === 0) await selectWeapon(page, 'shovel')
          const c = await toScreen(page, p.x, p.y)
          // Off camera still has a direction: clamp the aim onto the screen edge.
          const ax = Math.max(20, Math.min(1260, c.x + (s.x - c.x) * 0.5))
          const ay = Math.max(20, Math.min(700, c.y + (s.y - c.y) * 0.5))
          await page.mouse.move(ax, ay)
          await sleep(120)
          for (let n = 0; n < 3; n++) {
            await page.evaluate('window.__game.fire()')
            dug += 1
            await sleep(600)
          }
          await jetpackHop(450)
          lastProgressAt = Date.now()
        } else if (!want && target.y < p.y - k.PLAYER_H) {
          await jetpackHop(350)
        } else if (!want && target.y > p.y + k.PLAYER_H && d.player?.grounded === true) {
          if (dug === 0) await selectWeapon(page, 'shovel')
          await page.mouse.move(640, 360 + 200)
          await sleep(100)
          await page.evaluate('window.__game.fire()')
          dug += 1
          await sleep(350)
        }
        await sleep(60)
      }
    } finally {
      if (key) await page.keyboard.up(key)
    }
  }

  let target = null
  for (const g of byDistance) {
    const r = await walkTo(g, 40_000)
    if (r.ok) {
      target = g
      console.log(`[platform-autofire] reached #${g.id} (dug ${r.dug} times)`)
      break
    }
    console.log(
      `[platform-autofire] gave up on #${g.id}: ana at (${Math.round(r.at.x)},${Math.round(r.at.y)}), dug ${r.dug}`,
    )
    await page.screenshot({ path: join(shotsDir, `platform-autofire-walk-${g.id}.png`) })
  }
  if (!target) throw new Error('could not reach any gun platform')
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

  // **Aim down the open cave, to the left.** A round lives long enough to be
  // drawn only if it survives a snapshot (`SNAPSHOT_HZ` 20, so 50 ms). The first
  // run aimed up and right: on seed 4242 platform #0 sits in a cave with rock
  // ~60 px that way, a round at 1500 px/s hit it in ~40 ms, and 7 of 34 spawned
  // rounds were never in a snapshot at all — drawn 27, measured. That is the aim
  // starving the instrument, not the layer dropping rounds; the cave is open
  // for several hundred px to the left.
  //
  // **T21.40: aim where the mask is open, not at a fixed screen point.** T21.40
  // seats platforms or does not place them, and 4242's platform #0 moved to
  // (1456, 530) on a slope beside the spawn; the fixed "down and left" then ran
  // into rock and the drawn count read 8 of 32 and 12 of 30 — the aim starving the
  // instrument again, exactly as above. So the direction is chosen from the live
  // mask: the one, of a fan, whose ray from her body stays in air longest, and it
  // must stay open for `CLEAR_SNAPSHOTS` snapshots of flight or the drawn count
  // cannot mean anything and this says so.
  const { constants: rustConstants } = await import('../lib/rust-constants.mjs')
  const rk = rustConstants()
  const CLEAR_SNAPSHOTS = 3
  const need = (rk.get('GUN_PLATFORM_MUZZLE_SPEED') * CLEAR_SNAPSHOTS) / rk.get('SNAPSHOT_HZ')
  const here = (await dbg()).player
  const aim = await page.evaluate(
    ([ox, oy, reach]) => {
      let best = { deg: 0, run: -1 }
      for (let deg = -180; deg <= 180; deg += 10) {
        const r = (deg * Math.PI) / 180
        let run = 0
        while (run < reach && !window.__game.core.solidAt(Math.round(ox + Math.cos(r) * run), Math.round(oy + Math.sin(r) * run))) run += 4
        if (run > best.run) best = { deg, run }
      }
      return best
    },
    [here.x, here.y, need * 2],
  )
  console.log(`[platform-autofire] aim ${aim.deg}° from (${Math.round(here.x)},${Math.round(here.y)}): ${aim.run} px clear, need ${need}`)
  if (aim.run < need) {
    throw new Error(`no direction from platform #${target.id} is open for ${need} px — the drawn count would measure the rock`)
  }
  const { toScreen: aimToScreen } = await import('./pixels.mjs')
  const rad = (aim.deg * Math.PI) / 180
  const aimAt = await aimToScreen(page, here.x + Math.cos(rad) * 120, here.y + Math.sin(rad) * 120)
  await page.mouse.move(aimAt.x, aimAt.y)
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
