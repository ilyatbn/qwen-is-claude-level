#!/usr/bin/env node
/**
 * T22.08B — the solar flare in a **real** match: `GameScene`'s half.
 *
 *   node scripts/checks/solar-flare-match.mjs
 *
 * `solar-flare` proves the picture in the sandbox, whose `weatherStep` hands the layer
 * its query. A networked client has none of that: it learns of a flare from
 * `effect_start` alone, keeps the seed and the origin in `FlareClock`, and derives the
 * ribbon through `flare_points` (`R80`). That is the path `LavaClock`'s history warns
 * about — *"until it existed the networked client drew none of it"* — and no sandbox run
 * reaches it.
 *
 * One human alone in a private space room on a server forcing flares (`WEATHER=flare`):
 *
 * 1. the scene's clock picks the flare up and the layer draws it lit (`debug().flare`);
 * 2. **coverage** — the damage points, asked of the core off the scene's own
 *    `flareQuery` (not the layer's report), are under painted flare wherever they are on
 *    screen, against the same frozen instant with the flare hidden, and a control point
 *    clear of the ribbon does not change.
 */
import { startStack, freePort, tally, shotsDir } from './harness.mjs'
import { key as clientKey } from '../lib/client-keys.mjs'
import { deadlineMs } from '../lib/deadline.mjs'
import { comparePhotos, photo, toScreen } from './pixels.mjs'
import { join } from 'node:path'

const { fail, ok, finish } = tally('solar-flare-match')
const NAME_KEY = clientKey('NAME_KEY')
const WARMUP_S = 3
const ROUND_S = 120
/** Frames drawn after moving the camera, before photographing. */
const SETTLE_FRAMES = 6
/** Of the samples, at least this share must be on screen for the coverage to mean anything. */
const MIN_ON_SCREEN = 0.5

const dbg = (page) => page.evaluate(() => window.__game.debug())
const frames = (page, n) =>
  page.evaluate(
    (count) =>
      new Promise((resolve) => {
        let left = count
        const tick = () => (--left <= 0 ? resolve() : requestAnimationFrame(tick))
        requestAnimationFrame(tick)
      }),
    n,
  )

/** One human alone in a private room set to Space — `radiation-match`'s route. */
async function soloSpace(stack, name) {
  const ctx = await stack.browser.newContext({ viewport: { width: 1280, height: 720 } })
  const page = await ctx.newPage()
  const errors = []
  page.on('pageerror', (e) => errors.push(String(e)))
  await page.goto(`${stack.viteUrl}/?e2e=1&menu=1&name=${name}`)
  await page.waitForFunction('!!window.__menu', null, { timeout: 60_000 })
  await page.evaluate((k) => localStorage.setItem(k[0], k[1]), [NAME_KEY, name])
  await page.evaluate(() => document.querySelector('#private')?.click())
  await page.evaluate(() => document.querySelector('#host')?.click())
  await page.waitForFunction('window.__menu.visibleCode().length === 6', null, { timeout: 30_000 })
  const seen = () => page.evaluate(() => window.__menu.settings().gravity.value)
  for (let i = 0; i < 3 && (await seen()) !== 'Space'; i++) {
    const was = await seen()
    await page.evaluate(() => window.__menu.step('gravity', 1))
    await page.waitForFunction((v) => window.__menu.settings().gravity.value !== v, was, { timeout: 10_000 }).catch(() => {})
  }
  if ((await seen()) !== 'Space') throw new Error(`gravity never reached Space: "${await seen()}"`)
  await page.evaluate(() => window.__menu.ready(true))
  await page.waitForFunction('window.__game && window.__game.debug().ready === true', null, { timeout: 60_000 })
  return { page, errors }
}

const stack = await startStack({
  port: await freePort(),
  label: 'solar-flare-match',
  env: { BOT_COUNT: '0', FIXED_SEED: '4242', WEATHER: 'flare', DEV_WARMUP_SECONDS: String(WARMUP_S), ROUND_SECONDS: String(ROUND_S) },
})
try {
  const { page, errors } = await soloSpace(stack, 'ana')
  const k = await page.evaluate(() => window.__game.constants())
  const lit = await page
    .waitForFunction(() => window.__game.debug().flare?.lit === true, null, {
      timeout: deadlineMs(WARMUP_S + k.EFFECT_TELEGRAPH + 30, 'a lit flare in the match'),
      polling: 'raf',
    })
    .then(() => true)
    .catch(() => false)
  const d0 = await dbg(page)
  if (!lit) {
    fail(`GameScene never drew a lit flare on a WEATHER=flare space server: ${JSON.stringify({ phase: d0.phase, flare: d0.flare && { ...d0.flare, points: d0.flare.points.length }, query: d0.flareQuery })}`)
  } else {
    ok(`GameScene picked the flare up off effect_start and drew it lit (${d0.flareQuery.elapsed.toFixed(2)} s in)`)
    // Frame the ribbon, then freeze the scene; rendering goes on.
    const aim = await page.evaluate(() => Array.from(window.__game.core.flarePoints(window.__game.debug().flareQuery)))
    let cx = 0
    let cy = 0
    for (let i = 0; i < aim.length; i += 2) {
      cx += aim[i]
      cy += aim[i + 1]
    }
    await page.evaluate(([x, y]) => window.__game.watch(x, y), [(2 * cx) / aim.length, (2 * cy) / aim.length])
    await frames(page, SETTLE_FRAMES)
    await page.evaluate(() => window.__game.freeze(true))
    try {
      await frames(page, 2)
      const d = await dbg(page)
      const burns = await page.evaluate((q) => Array.from(window.__game.core.flarePoints(q)), d.flareQuery)
      if (!d.flare.drawn || !d.flare.lit) throw new Error(`frozen on an undrawn flare: ${JSON.stringify({ ...d.flare, points: d.flare.points.length })}`)
      const n = burns.length / 2
      const probes = []
      for (let i = 0; i < n; i++) {
        const a = Math.max(0, i - 1)
        const b = Math.min(n - 1, i + 1)
        const tx = burns[2 * b] - burns[2 * a]
        const ty = burns[2 * b + 1] - burns[2 * a + 1]
        const l = Math.hypot(tx, ty) || 1
        const off = k.SOLAR_FLARE_RIBBON_R * 0.8
        for (const side of [0, 1, -1]) probes.push({ x: burns[2 * i] - (ty / l) * off * side, y: burns[2 * i + 1] + (tx / l) * off * side })
      }
      // Clear of the HUD's corners: the top and bottom sixth of the frame hold DOM.
      const bounds = await page.evaluate(() => {
        const r = document.querySelector('canvas').getBoundingClientRect()
        return { left: r.left, top: r.top, w: r.width, h: r.height }
      })
      const inView = (s) => s.onScreen && s.y > bounds.top + bounds.h / 6 && s.y < bounds.top + (bounds.h * 5) / 6
      const shown = []
      for (const p of probes) {
        const s = await toScreen(page, p.x, p.y)
        if (inView(s)) shown.push({ x: s.x, y: s.y })
      }
      const ctrlWorld = await page.evaluate(
        ([p, gap]) => {
          const v = window.__game.debug().worldView
          const w = v.width ?? v.w
          const h = v.height ?? v.h
          for (let y = v.y + h / 5; y < v.y + (h * 4) / 5; y += 13) {
            for (let x = v.x + w / 5; x < v.x + (w * 4) / 5; x += 13) {
              let clear = true
              for (let i = 0; clear && i + 1 < p.length; i += 2) if (Math.hypot(p[i] - x, p[i + 1] - y) < gap) clear = false
              if (clear) return { x, y }
            }
          }
          return null
        },
        [burns, k.SOLAR_FLARE_RIBBON_R + k.SOLAR_FLARE_GLOW + 40],
      )
      const on = await photo(page)
      await page.screenshot({ path: join(shotsDir, 'solar-flare-match.png') })
      await page.evaluate(() => window.__game.showFlare(false))
      await frames(page, 2)
      const off = await photo(page)
      await page.evaluate(() => window.__game.showFlare(true))
      const ctrl = ctrlWorld ? await toScreen(page, ctrlWorld.x, ctrlWorld.y) : null
      const cmp = await comparePhotos(page, on, off, { points: ctrl ? [...shown, { x: ctrl.x, y: ctrl.y }] : shown })
      const covered = cmp.points.slice(0, shown.length).filter(Boolean).length
      if (shown.length < probes.length * MIN_ON_SCREEN) {
        fail(`only ${shown.length} of ${probes.length} damage points were in view after framing the ribbon — coverage would mean nothing`)
      } else if (covered < shown.length) {
        const bad = cmp.detail.slice(0, shown.length).filter((_, i) => !cmp.points[i])
        fail(`only ${covered} of ${shown.length} damage points in view are under painted flare (${d.flare.shader ? 'shader' : 'flat'}): ${JSON.stringify(bad.slice(0, 5))}`)
      } else ok(`${covered}/${shown.length} damage points in view painted in GameScene (${d.flare.shader ? 'shader' : 'flat'}), off the scene's own FlareClock query`)
      if (!ctrl) fail('no point in view clear of the ribbon for the control')
      else if (cmp.points[shown.length]) fail(`control: a point clear of the flare changed too: ${JSON.stringify(cmp.detail[shown.length])}`)
      else ok('control: a point clear of the ribbon did not change')
    } finally {
      await page.evaluate(() => window.__game.freeze(false))
    }
  }
  if (errors.length) fail(`page errors: ${errors.join(' | ')}`)
} catch (e) {
  fail(`${e?.stack ?? e}`)
} finally {
  await stack.close()
}

await finish()
