/**
 * `rock-opaque` (T23.19C) — solid rock hides the sky, on the world canvas's own pixels.
 *
 * The coordinator read the sky's purple bands and mountain triangles through solid rock in the night sandbox shots
 * (seed 31337). The test is the one the task names: the same frozen frame drawn twice with the sky as it is (the noise
 * floor), then with the whole sky swapped for flat magenta (`__world.skyFlat`), read per pixel —
 *
 * - over **deep solid rock** (every mask px within `MARGIN` of the pixel solid: no edge, anti-alias or bevel) the
 *   magenta sky must change nothing: at most `MAX_ROCK_CHANGED` of those pixels may move by more than `PIXEL_STEP`;
 * - over **open air** (no solid px within `MARGIN`, cave wall off) — the control — nearly every pixel must change, or
 *   the swap never reached the frame and the rock half proves nothing.
 *
 * **Bloom is switched off for the gated read** (`hideLayers(['bloom'])`): bloom spreads every bright pixel over its
 * neighbours by design, and a flat magenta sky is far brighter than any night sky, so with it on the swap moves rock by
 * glow, not by transparency — measured on HEAD (seed 31337, low tier): 27 % / 94 % of deep rock in two sky-heavy views,
 * mean |Δ| 2.9 / 8.3 levels, **0 px with bloom off** (fog or grade off instead changed nothing: bloom alone). The
 * bloom-on numbers are logged beside each view, not gated.
 *
 * **Measured against the mockup (coordinator's question):** the real sky's bloom into deep rock (bloom on, the sky
 * swapped for black) is 0 on the mockup's own F1 world render (`controls/worldonly.js` + a black-sky knob, max 1 level)
 * and 0 on the look-lab F1 through this renderer, full and low (max 1 / 0) — the bloom is the mockup's. In the game it
 * comes from the moon's HDR disc where the camera puts rock beside it (seed 31337, 1280-px frame: mean 3.5–9.5, p95
 * 13–26 levels full; 4.0–10.4, 15–32 low — the low tier spreads ~10 % more, not a different bloom). Logged per view.
 *
 * Four seeds × three views at night (a population, not one draw), on the checks' low tier; the entry
 * `rock-opaque-full` runs the same on the full tier (`&tier=full`). Plant: the terrain's coverage × 0.97 in
 * `terrainMaterial.ts::SHADE` must turn this red on every view with rock.
 */
import { HIGH_QUALITY_KEY } from '../lib/check-tier.mjs'

/** Mask px round a sampled pixel that must all be solid (rock) or all air (control): wider than the bevel's AA. */
const MARGIN = 12
/** A channel step, 0–255, that counts as a pixel moving: over the frozen frame's own noise (measured 0 px). */
const PIXEL_STEP = 3
/** The share of deep-rock pixels that may move with the sky swapped (measured 0 on HEAD with bloom off, both tiers). */
const MAX_ROCK_CHANGED = 0.002
/** The share of open-air pixels that must move (the control; measured 98.0–100 %). */
const MIN_AIR_CHANGED = 0.9
/** Seeds (31337 is the report's). */
const SEEDS = ['31337', '4242', '7', '11']
/**
 * The cycle time: night (`furniture`'s NIGHT_T; darkness asserted > 0.5), the report's. A noon leg drew the same
 * frames to the last level on every view (measured: the sandbox's world look does not follow `darkness` yet — the
 * moonlit day is T23.10's), so it bought nothing and was dropped.
 */
const NIGHT_T = 90
/** Map fractions the camera is pointed at on each seed. */
const POINTS = [[0.25, 0.55], [0.5, 0.6], [0.75, 0.5]]
/** Sample every STRIDE-th buffer pixel each way. */
const STRIDE = 2
const MAGENTA = [1, 0, 1]
/** Deep-rock pixels the whole run must sample, or the rock half measured too little (HEAD: 425 860 low). */
const MIN_ROCK_TOTAL = 20000

const frame = (page) => page.evaluate(() => window.__world.readFrame())
const bytes = (f) => Buffer.from(f.rgba, 'base64')

/** Per sampled buffer px: 1 deep rock, 2 open air, 0 neither — read from the mask through the frame's own view. */
function classify(page, f) {
  return page.evaluate(
    ([w, h, view, margin, stride]) => {
      const c = window.__game.core
      const out = []
      const offs = []
      for (let dy = -margin; dy <= margin; dy += margin / 2) for (let dx = -margin; dx <= margin; dx += margin / 2) offs.push([dx, dy])
      for (let j = 0; j < h; j += stride)
        for (let i = 0; i < w; i += stride) {
          const x = Math.round(view.x + ((i + 0.5) * view.w) / w)
          const y = Math.round(view.y + ((j + 0.5) * view.h) / h)
          let solid = 0
          for (const [dx, dy] of offs) if (c.solidAt(x + dx, y + dy)) solid++
          out.push(solid === offs.length ? 1 : solid === 0 ? 2 : 0)
        }
      return out
    },
    [f.w, f.h, f.view, MARGIN, STRIDE],
  )
}

const moved = (a, b, i) => Math.abs(a[i] - b[i]) > PIXEL_STEP || Math.abs(a[i + 1] - b[i + 1]) > PIXEL_STEP || Math.abs(a[i + 2] - b[i + 2]) > PIXEL_STEP

/** How many deep-rock and open-air px moved between frames `a` and `b` (decoded), and the rock's summed mean |Δ|. */
function tally(cls, f, a, b) {
  let k = 0
  const r = { rock: 0, rockMoved: 0, rockSum: 0, air: 0, airMoved: 0 }
  for (let j = 0; j < f.h; j += STRIDE)
    for (let i = 0; i < f.w; i += STRIDE) {
      const c = cls[k++]
      const p = (j * f.w + i) * 4
      if (c === 1) {
        r.rock++
        if (moved(a, b, p)) r.rockMoved++
        r.rockSum += (Math.abs(a[p] - b[p]) + Math.abs(a[p + 1] - b[p + 1]) + Math.abs(a[p + 2] - b[p + 2])) / 3
      } else if (c === 2) {
        r.air++
        if (moved(a, b, p)) r.airMoved++
      }
    }
  return r
}

/** Per deep-rock px, the largest channel |Δ| between two frames. */
function rockDeltas(cls, f, a, b) {
  const out = []
  let k = 0
  for (let j = 0; j < f.h; j += STRIDE)
    for (let i = 0; i < f.w; i += STRIDE) {
      const p = (j * f.w + i) * 4
      if (cls[k++] === 1) out.push(Math.max(Math.abs(a[p] - b[p]), Math.abs(a[p + 1] - b[p + 1]), Math.abs(a[p + 2] - b[p + 2])))
    }
  return out
}
function quantiles(v) {
  if (!v.length) return 'n/a'
  const s = [...v].sort((x, y) => x - y)
  const q = (f) => s[Math.min(s.length - 1, Math.floor(s.length * f))]
  return `p50 ${q(0.5)} p95 ${q(0.95)} max ${s[s.length - 1]}`
}

const pct = (n, d) => (d ? ((n / d) * 100).toFixed(2) : '0.00')

export default async function ({ page, shot, log }) {
  const want = new URL(page.url()).searchParams.get('tier') === 'full' ? 'full' : 'low'
  if (want === 'full') {
    await page.evaluate((k) => localStorage.setItem(k, '1'), HIGH_QUALITY_KEY)
    await page.reload()
  }
  await page.waitForFunction(() => window.__game && window.__world && window.__world.litTerrain()?.drawn, null, { timeout: 120_000 })
  const info = await page.evaluate(() => window.__world.info())
  log(`tier ${info?.tier}, buffer ${JSON.stringify(info?.buffer)}`)
  const problems = []
  if (info?.tier !== want) problems.push(`want the ${want} tier, the page drew ${info?.tier}`)
  // The report's setting: cave wall off (the game's default since T23.09A). A generated cave is then air that shows
  // sky, which is right; the deep-rock classification keeps every such px out of the rock half.
  await page.evaluate(() => window.__game.setCaveWall(false))
  let rockAll = 0
  let rockMovedAll = 0
  let shots = 0
  const leaks = []
  for (const seed of SEEDS) {
    await page.evaluate((s) => window.__game.regenerate(s), seed)
    await page.waitForFunction(() => window.__world.litTerrain()?.drawn, null, { timeout: 120_000 })
    const d = await page.evaluate(() => window.__game.debug())
    for (const t of [NIGHT_T]) {
      await page.evaluate((t) => window.__game.setTime(t), t)
      for (const [fx, fy] of POINTS) {
        await page.evaluate(([x, y]) => window.__game.watch(x, y), [d.mapW * fx, d.mapH * fy])
        await page.waitForTimeout(400)
        const dark = (await page.evaluate(() => window.__game.debug())).darkness
        if (!(dark > 0.5)) problems.push(`setTime(${t}) gave darkness ${dark}`)
        await page.evaluate(() => window.__game.freeze(true))
        await page.waitForTimeout(200)
        // Bloom on: logged only (its glow over the rock is the sky's by design).
        const g1 = await frame(page)
        await page.evaluate(() => window.__world.skyFlat([0, 0, 0]))
        const gBlack = await frame(page)
        await page.evaluate((m) => window.__world.skyFlat(m), MAGENTA)
        const g2 = await frame(page)
        await page.evaluate(() => {
          window.__world.skyFlat(null)
          window.__world.hideLayers(['bloom'])
        })
        const a1 = await frame(page)
        const a2 = await frame(page)
        await page.evaluate((m) => window.__world.skyFlat(m), MAGENTA)
        const b = await frame(page)
        await page.evaluate(() => {
          window.__world.skyFlat(null)
          window.__world.hideLayers([])
          window.__game.freeze(false)
        })
        const cls = await classify(page, a1)
        const A1 = bytes(a1)
        const noise = tally(cls, a1, A1, bytes(a2))
        const r = tally(cls, a1, A1, bytes(b))
        const glow = tally(cls, g1, bytes(g1), bytes(g2))
        const leak = rockDeltas(cls, g1, bytes(g1), bytes(gBlack))
        for (const v of leak) leaks.push(v)
        const tag = `seed ${seed} night (darkness ${Number(dark).toFixed(2)}) view ${Math.round(a1.view.x)},${Math.round(a1.view.y)}`
        const rs = r.rock ? r.rockMoved / r.rock : 0
        const as = r.air ? r.airMoved / r.air : 1
        log(
          `${tag}: deep rock ${r.rock} px, ${r.rockMoved} moved with the sky magenta (${pct(r.rockMoved, r.rock)} %, mean |Δ| ${(r.rock ? r.rockSum / r.rock : 0).toFixed(2)}), ` +
            `frame noise ${noise.rockMoved}; air ${r.air} px, ${pct(r.airMoved, r.air)} % moved; ` +
            `bloom on (logged): magenta moves rock ${pct(glow.rockMoved, glow.rock)} %, mean |Δ| ${(glow.rock ? glow.rockSum / glow.rock : 0).toFixed(2)}; ` +
            `the real sky vs black: rock |Δ| ${quantiles(leak)}`,
        )
        rockAll += r.rock
        rockMovedAll += r.rockMoved
        if (noise.rockMoved > 0) problems.push(`${tag}: the frozen frame is not still (${noise.rockMoved} rock px moved between two reads)`)
        if (rs > MAX_ROCK_CHANGED) {
          problems.push(`${tag}: ${pct(r.rockMoved, r.rock)} % of deep rock shows the sky (max ${MAX_ROCK_CHANGED * 100} %)`)
          if (shots++ < 2) {
            await page.evaluate((m) => {
              window.__world.hideLayers(['bloom'])
              window.__world.skyFlat(m)
            }, MAGENTA)
            await shot(`rock-opaque-${want}-${seed}-${t}-magenta`)
            await page.evaluate(() => {
              window.__world.skyFlat(null)
              window.__world.hideLayers([])
            })
          }
        }
        if (r.air > 200 && as < MIN_AIR_CHANGED) problems.push(`${tag}: control — only ${pct(r.airMoved, r.air)} % of open air moved with the sky swapped`)
      }
    }
  }
  await page.evaluate(() => {
    window.__game.setTime(null)
    window.__game.watch(null)
  })
  if (rockAll < MIN_ROCK_TOTAL) problems.push(`only ${rockAll} deep-rock px sampled over every view — the rock half measured too little`)
  log(`all views: deep rock ${rockAll} px, ${rockMovedAll} moved with the sky swapped (bloom off); the real sky's bloom into rock (bloom on, real vs black sky): ${quantiles(leaks)}`)
  await page.evaluate((m) => {
    window.__world.hideLayers(['bloom'])
    window.__world.skyFlat(m)
  }, MAGENTA)
  await page.waitForTimeout(300)
  await shot(`rock-opaque-${want}-magenta`)
  await page.evaluate(() => {
    window.__world.skyFlat(null)
    window.__world.hideLayers([])
  })
  if (problems.length) throw new Error(problems.join('\n'))
}
