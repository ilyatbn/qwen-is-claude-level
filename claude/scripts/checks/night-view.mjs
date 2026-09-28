/**
 * `night-view` — T23.10 (R7): **night is drawn as F1 draws it** — your field of view (`fovRadius`) stays as the scene
 * is, and outside it the scene fades into the night palette (the world renderer's output pass, `post.ts::NIGHT_VIEW`)
 * — never the old black MULTIPLY lightmap (`render/lightmap.ts`, retired with this check's two predecessors,
 * `lightmap` and `night_darkens_the_world`, which photographed that layer).
 *
 * Every photograph is the same frozen frame with and without the night view (`__world.hideLayers(['night'])`):
 * - **Both ends:** the scene hands a night view at night and none at noon (`debug().nightView`), and the renderer drew
 *   uniforms from it (`__world.nightDrawn()`) — at noon none (the control).
 * - **Inside sight nothing moves; outside it the light drops to about `NIGHT_VIEW_KEEP`**, measured on rock patches
 *   at 0.5 × and 1.5 × the radius from the player — **and never to black**: outside keeps a floor.
 * - **Lit by effect lights:** a lava jet staged outside sight still reads bright through the night.
 * - Both tiers. Shots: `night-view-{low,full}`, `night-view-noon`.
 */
import { patchRGBA, toScreen } from './pixels.mjs'

/** Night and noon (`setTime`, s into the sandbox's cycle — `furniture`'s), read back and asserted. */
const NIGHT_T = 90
/** Inside sight, a patch's mean luminance moves at most this much with the night view on (0–255). */
const INSIDE_MAX = 1.5
/** Outside: the kept share of luminance, measured on the drawn (tone-mapped) frame — around `NIGHT_VIEW_KEEP`
 * after ACES and sRGB, which lift a 30 % linear share to about half. Bounds with room; a missing night view is ~1. */
const OUTSIDE_KEPT_MAX = 0.8
/** …and not black: the outside patch's mean luminance with the night view on stays above this (0–255). */
const OUTSIDE_FLOOR = 2
/**
 * A staged jet outside sight keeps this share of its brightest pixels (p95 luminance) through the night view — more
 * than the rock beside it keeps (the tone map compresses its HDR: light survives the fade, stone does not).
 */
const JET_KEPT_MIN = 0.85

const lum = (d, i) => 0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2]
function stats(rgba) {
  const v = []
  for (let i = 0; i < rgba.length; i += 4) v.push(lum(rgba, i))
  v.sort((a, b) => a - b)
  return { mean: v.reduce((a, b) => a + b, 0) / v.length, p95: v[Math.floor(v.length * 0.95)] ?? 0 }
}

/** The solid 16×10 patch nearest to (x, y) within `reach` (world px), or null. */
async function rockNear(page, x, y, reach) {
  return page.evaluate(([cx, cy, reach]) => {
    const c = window.__game.core
    let best = null
    for (let dy = -reach; dy <= reach; dy += 4) {
      for (let dx = -reach; dx <= reach; dx += 4) {
        const d = Math.hypot(dx, dy)
        if (d > reach || (best && d >= best.d)) continue
        let solid = true
        for (let yy = -5; yy <= 5 && solid; yy += 2) for (let xx = -8; xx <= 8 && solid; xx += 2) if (!c.solidAt(Math.round(cx + dx + xx), Math.round(cy + dy + yy))) solid = false
        if (solid) best = { x: cx + dx, y: cy + dy, d }
      }
    }
    return best
  }, [x, y, reach])
}

export default async function ({ page, shot, log }) {
  await page.waitForFunction(() => window.__game && window.__world && window.__world.litTerrain()?.drawn, null, { timeout: 120_000 })
  const problems = []
  const nightOff = (on) => page.evaluate((v) => window.__world.hideLayers(v ? ['night'] : []), on)
  const rect = async (p) => {
    const s = await toScreen(page, p.x, p.y)
    return s.onScreen ? { x: Math.round(s.x - 8 * s.scale), y: Math.round(s.y - 5 * s.scale), w: Math.round(16 * s.scale), h: Math.round(10 * s.scale) } : null
  }

  // --- noon: the control — no night view handed over, none drawn --------------------------------------
  await page.evaluate(() => window.__game.setTime(0))
  await page.waitForTimeout(400)
  const noon = await page.evaluate(() => ({ d: window.__game.debug().darkness, v: window.__game.debug().nightView, drawn: window.__world.nightDrawn() }))
  log(`noon: darkness ${noon.d}, night view ${JSON.stringify(noon.v)}, drawn ${JSON.stringify(noon.drawn)}`)
  if (noon.v !== null || noon.drawn !== null) problems.push(`at noon a night view was handed over or drawn: ${JSON.stringify(noon)}`)
  await shot('night-view-noon')

  await page.evaluate((t) => window.__game.setTime(t), NIGHT_T)
  await page.waitForTimeout(400)
  const d0 = await page.evaluate(() => window.__game.debug())
  if (!(d0.darkness > 0.5)) problems.push(`setTime(${NIGHT_T}) is not night: darkness ${d0.darkness}`)
  const fov = d0.fov
  const me = d0.player
  const inside = await rockNear(page, me.x, me.y + 20, fov * 0.5)
  const ring = []
  for (const a of [0, Math.PI / 3, (2 * Math.PI) / 3, Math.PI, (4 * Math.PI) / 3, (5 * Math.PI) / 3]) {
    const p = await rockNear(page, me.x + Math.cos(a) * fov * 1.5, me.y + Math.sin(a) * fov * 1.5, fov * 0.2)
    if (p && Math.hypot(p.x - me.x, p.y - me.y) > fov * 1.25) ring.push(p)
  }
  if (!inside) problems.push(`no rock within ${Math.round(fov * 0.5)} px of the player`)
  if (ring.length === 0) problems.push(`no rock at 1.5 × the ${Math.round(fov)} px sight`)
  log(`night: darkness ${d0.darkness.toFixed(2)}, sight ${Math.round(fov)} px; rock inside at ${inside ? Math.round(inside.d) : '—'} px, ${ring.length} outside patches`)

  for (const hq of [false, true]) {
    const tier = hq ? 'full' : 'low'
    await page.evaluate((v) => window.__game.setHighQuality(v), hq)
    // The tier's lit terrain whole before anything is measured on it (a swap mid-leg reads as a change).
    await page.waitForFunction((t) => window.__world.info().tier === t && window.__world.litTerrain()?.drawn && !window.__game.debug().terrainSwapPending, hq ? 'full' : 'low', { timeout: 60_000 })
    await page.waitForTimeout(500)
    await page.evaluate(() => window.__game.freeze(true))
    const both = await page.evaluate(() => ({ v: window.__game.debug().nightView, drawn: window.__world.nightDrawn() }))
    // Both ends: every sight circle handed over is drawn first; the rest are the effect lights'.
    if (!both.v || !both.drawn || both.drawn.circles.length < both.v.circles.length) problems.push(`${tier}: handed ${JSON.stringify(both.v)}, drew ${JSON.stringify(both.drawn)}`)
    else log(`${tier}: both ends — ${both.v.circles.length} sight circle handed over and drawn, + ${both.drawn.circles.length - both.v.circles.length} effect lights; k ${both.drawn.k.toFixed(3)}`)
    // Outside patches clear of every effect light's circle (a gate or a crystal lights its ground in the dark too —
    // the jet leg below measures that): the circles as drawn, in buffer px, bottom up.
    const buf = await page.evaluate(() => window.__world.info().buffer)
    const lightCircles = (both.drawn?.circles ?? []).slice(both.v?.circles.length ?? 0)
    const inLight = async (p) => {
      const sp = await toScreen(page, p.x, p.y)
      const k = buf[0] / 1280
      return lightCircles.some((c) => Math.hypot(sp.x * k - c.x, (720 - sp.y) * k - c.y) < c.outer)
    }
    const dark = []
    for (const p of ring) if (!(await inLight(p))) dark.push(p)
    log(`${tier}: ${dark.length} of ${ring.length} outside patches clear of the ${lightCircles.length} effect lights' circles`)
    const patches = inside ? [inside, ...dark] : dark
    const on = []
    for (const p of patches) on.push(await rect(p))
    const withN = []
    for (const r of on) withN.push(r ? stats((await patchRGBA(page, r)).rgba) : null)
    await nightOff(true)
    await page.waitForTimeout(250)
    const without = []
    for (const r of on) without.push(r ? stats((await patchRGBA(page, r)).rgba) : null)
    await nightOff(false)
    await page.waitForTimeout(250)
    if (inside && withN[0] && without[0]) {
      const dIn = Math.abs(withN[0].mean - without[0].mean)
      log(`${tier}: inside sight the rock moved ${dIn.toFixed(2)} (max ${INSIDE_MAX})`)
      if (!(dIn <= INSIDE_MAX)) problems.push(`${tier}: the rock inside sight moved ${dIn.toFixed(2)} with the night view`)
    }
    const outs = (inside ? withN.slice(1) : withN).map((w, i) => ({ w, wo: (inside ? without.slice(1) : without)[i] })).filter((o) => o.w && o.wo && o.wo.mean > 4)
    for (const o of outs) {
      const kept = o.w.mean / o.wo.mean
      log(`${tier}: outside sight the rock keeps ${(kept * 100).toFixed(0)} % (${o.wo.mean.toFixed(1)} → ${o.w.mean.toFixed(1)}; max ${OUTSIDE_KEPT_MAX * 100} %, floor ${OUTSIDE_FLOOR})`)
      if (!(kept <= OUTSIDE_KEPT_MAX)) problems.push(`${tier}: outside sight the rock keeps ${(kept * 100).toFixed(0)} % — the night view does not darken it`)
      if (!(o.w.mean >= OUTSIDE_FLOOR)) problems.push(`${tier}: outside sight is black (${o.w.mean.toFixed(2)})`)
    }
    if (outs.length === 0) problems.push(`${tier}: no outside patch bright enough to measure`)
    await shot(`night-view-${tier}`)

    // Lit by effect lights: a jet out there.
    const far = ring[0]
    if (far) {
      await page.evaluate(() => window.__game.freeze(false))
      const gy = await page.evaluate(([x, y]) => { const c = window.__game.core; for (let d = -200; d < 200; d++) if (c.solidAt(Math.round(x), Math.round(y + d))) return Math.round(y + d); return null }, [far.x, far.y - 100])
      if (gy !== null) {
        await page.evaluate(([x, y]) => window.__game.stageHazards({ vents: [{ x, y, jetting: true, burning: false, lean: 0 }] }), [far.x, gy])
        await page.waitForTimeout(500)
        await page.evaluate(() => window.__game.freeze(true))
        const jr = await rect({ x: far.x, y: gy - 60 })
        const js = jr ? stats((await patchRGBA(page, jr)).rgba) : null
        await nightOff(true)
        await page.waitForTimeout(250)
        const jo = jr ? stats((await patchRGBA(page, jr)).rgba) : null
        await nightOff(false)
        const rockKept = Math.max(...outs.map((o) => o.w.mean / o.wo.mean))
        const jetKept = js && jo ? js.p95 / jo.p95 : 0
        log(`${tier}: a lava jet ${Math.round(Math.hypot(far.x - me.x, gy - me.y))} px out (sight ${Math.round(fov)}) keeps ${(jetKept * 100).toFixed(0)} % of its p95 (${jo?.p95.toFixed(0)} → ${js?.p95.toFixed(0)}; min ${JET_KEPT_MIN * 100} %), the rock out there at most ${(rockKept * 100).toFixed(0)} %`)
        if (!(jetKept >= JET_KEPT_MIN && jetKept > rockKept)) problems.push(`${tier}: a lava jet outside sight is lost in the night (keeps ${(jetKept * 100).toFixed(0)} %)`)
        await page.evaluate(() => window.__game.freeze(false))
        await page.evaluate(() => window.__game.stageHazards(null))
      }
    }
    await page.evaluate(() => window.__game.freeze(false))
  }
  await page.evaluate(() => window.__game.setHighQuality(false))
  await page.evaluate(() => window.__game.setTime(null))
  if (problems.length) throw new Error(`night-view: ${problems.join('; ')}`)
}
