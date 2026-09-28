#!/usr/bin/env node
/**
 * `night-view-match` — T23.10 (R7): **the night seeing rule, in a real match, on pixels.** Three humans on a
 * `DEV_PROBE=1` server at night (`DEV_ROUND_CLOCK`): ana stands on flat ground, bo at 0.9 × her sight (`fovRadius` at
 * night: `FOV_NIGHT`), cy at 1.1 ×. In ana's one frame bo is drawn and cy is not (`renderRemotes`: hidden beyond `fov`
 * at night) — counted at both ends (`debug().sight`: what the scene decided) and on pixels: each one's box against
 * the same box after both walk off (`debugPlace` far away) — bo's box changes, cy's does not, a control box does not.
 *
 *   node scripts/checks/night-view-match.mjs
 */
import { startStack, enterBattle, freePort, tally, sleep, drawnFrames } from './harness.mjs'
import { photo, comparePhotos, toScreen } from './pixels.mjs'
import { constants as rustConstants } from '../lib/rust-constants.mjs'

const { fail, ok, finish } = tally('night-view-match')
const RC = rustConstants()
/** Night: the round clock this far into the cycle when warmup ends (`cycle.rs::NIGHT_START` 0.62 of the cycle, +). */
const NIGHT_CLOCK = Math.round((RC.get('DAY_DURATION') + RC.get('NIGHT_DURATION')) * 0.68)
/** A box counts as drawn when this share of its pixels changes with its figure gone. */
const DRAWN_MIN = 0.1
const BLANK_MAX = 0.01
/** Distances as shares of the sight, and the allowance on each after the bodies settle on the ground. */
const NEAR = 0.9
const FAR = 1.1
const TOL = 0.035

const stack = await startStack({
  port: await freePort(),
  label: 'night-view-match',
  env: { BOT_COUNT: '0', FIXED_SEED: '4242', WEATHER: 'off', DEV_PROBE: '1', ROUND_SECONDS: '600', DEV_ROUND_CLOCK: String(NIGHT_CLOCK) },
})
try {
  const clients = []
  for (const name of ['ana', 'bo', 'cy']) clients.push(await stack.openClient({ name }))
  await enterBattle(clients[0].page, { expectPlayers: 3, waitPlaying: true, label: 'night-view-match/ana' })
  for (const c of clients.slice(1)) await enterBattle(c.page, { press: false, expectPlayers: 3, waitPlaying: true, label: `night-view-match/${c.name ?? ''}` })
  const [ana, bo, cy] = clients.map((c) => c.page)
  await ana.waitForFunction(() => window.__game.debug().terrainReady === true, null, { timeout: 120_000 })
  const k = await ana.evaluate(() => window.__game.constants())
  const dark = await ana.evaluate(() => window.__game.debug().drawnDarkness)
  if (!(dark > 0.5)) fail(`not night: darkness ${dark}`)
  else ok(`night: darkness ${dark.toFixed(2)}`)

  // Ground to stand on: ana at a column x, bo on the ground to her right whose body centre is NEAR·F from hers, cy on
  // the ground to her left at FAR·F — the distance in 2-D (the ground need not be level), air above each.
  const F = k.FOV_NIGHT
  const spot = await ana.evaluate(([F, near, far, h]) => {
    const c = window.__game.core
    const ground = (x) => {
      for (let y = 40; y < c.height - 4; y++) if (c.solidAt(Math.round(x), y)) return y
      return null
    }
    const clear = (x, g) => {
      for (let y = g - h * 2; y < g; y += 2) if (c.solidAt(Math.round(x), y)) return false
      return true
    }
    const centre = (x) => {
      const g = ground(x)
      return g !== null && clear(x, g) ? { x, y: g - h / 2 - 1, g } : null
    }
    const at = (a, share, dir) => {
      let best = null
      for (let x = a.x + dir * share * F * 0.6; dir > 0 ? x < Math.min(c.width - 8, a.x + share * F * 1.05) : x > Math.max(8, a.x - share * F * 1.05); x += dir) {
        const b = centre(x)
        if (!b) continue
        const e = Math.abs(Math.hypot(b.x - a.x, b.y - a.y) / F - share)
        if (!best || e < best.e) best = { ...b, e }
      }
      return best && best.e < 0.005 ? best : null
    }
    for (let x = 300; x < c.width - 300; x += 16) {
      const a = centre(x)
      if (!a) continue
      const b = at(a, near, 1)
      const cc = b && at(a, far, -1)
      if (b && cc) return { a, b, c: cc }
    }
    return null
  }, [F, NEAR, FAR, k.PLAYER_H])
  if (!spot) throw new Error('no ground on seed 4242 with a stand at both distances')
  const place = async (page, p) => {
    await page.evaluate(([x, y]) => window.__game.debugPlace(x, y), [p.x, p.y])
    await page.waitForFunction(() => window.__game.debug().stand.lastPlace !== null, null, { timeout: 10_000 }).catch(() => {})
    return page.evaluate(() => window.__game.debug().stand.lastPlace)
  }
  const got = [await place(ana, spot.a), await place(bo, spot.b), await place(cy, spot.c)]
  console.log(`  asked ${JSON.stringify([spot.a, spot.b, spot.c].map((p) => [Math.round(p.x), Math.round(p.y)]))}; the server placed ${JSON.stringify(got)}`)
  await sleep(1500)
  await drawnFrames(ana, 10)
  const sight = await ana.evaluate(() => {
    const d = window.__game.debug()
    return { fov: d.sight.fov, me: d.renderPos, remotes: d.sight.remotes }
  })
  const boId = await bo.evaluate(() => window.__game.debug().me)
  const cyId = await cy.evaluate(() => window.__game.debug().me)
  const rB = sight.remotes.find((r) => r.id === boId)
  const rC = sight.remotes.find((r) => r.id === cyId)
  if (!rB || !rC) throw new Error(`ana does not have both remotes: ${JSON.stringify(sight.remotes)}`)
  const dist = (r) => Math.hypot(r.x - sight.me.x, r.y - sight.me.y) / sight.fov
  const dB = dist(rB)
  const dC = dist(rC)
  console.log(`  ana at ${JSON.stringify(sight.me)}; remotes ${JSON.stringify(sight.remotes)}; cy's own ${JSON.stringify(await cy.evaluate(() => window.__game.debug().renderPos))}`)
  const l = `ana's sight ${sight.fov.toFixed(0)} px (FOV_NIGHT ${F}); bo at ${dB.toFixed(3)} × it, drawn ${rB.visible}; cy at ${dC.toFixed(3)} ×, drawn ${rC.visible}`
  if (Math.abs(dB - NEAR) > TOL || Math.abs(dC - FAR) > TOL) fail(`${l} — the bodies did not settle at ${NEAR} and ${FAR}`)
  else if (!(rB.visible === true && rC.visible === false)) fail(`${l} — the seeing rule decided wrong`)
  else ok(`both ends, the scene: ${l}`)

  // Pixels: the same frame, then both gone far away.
  const box = async (r) => {
    const a = await toScreen(ana, r.x - k.PLAYER_W, r.y - k.PLAYER_H * 0.7)
    const b = await toScreen(ana, r.x + k.PLAYER_W, r.y + k.PLAYER_H * 0.55)
    return { x: Math.round(a.x), y: Math.round(a.y), w: Math.max(6, Math.round(b.x - a.x)), h: Math.max(6, Math.round(b.y - a.y)) }
  }
  const bB = await box(rB)
  const bC = await box(rC)
  const ctl = { ...bB, y: Math.max(0, bB.y - bB.h * 3) }
  const withThem = await photo(ana)
  await place(bo, { x: spot.a.x + 2 * F * 2.2, y: spot.a.y - 400 })
  await place(cy, { x: spot.a.x - 2 * F * 2.2, y: spot.a.y - 400 })
  await sleep(1200)
  await drawnFrames(ana, 10)
  const gone = await photo(ana)
  const pB = (await comparePhotos(ana, withThem, gone, { rect: bB })).fraction
  const pC = (await comparePhotos(ana, withThem, gone, { rect: bC })).fraction
  const pK = (await comparePhotos(ana, withThem, gone, { rect: ctl })).fraction
  const m = `pixels in ana's frame: bo's box ${(pB * 100).toFixed(1)} % changes when he leaves (min ${DRAWN_MIN * 100}), cy's ${(pC * 100).toFixed(1)} % (max ${BLANK_MAX * 100}), control ${(pK * 100).toFixed(1)} %`
  if (pB >= DRAWN_MIN && pC <= BLANK_MAX && pK <= BLANK_MAX) ok(m)
  else fail(m)
} finally {
  await stack.close()
}
await finish()
