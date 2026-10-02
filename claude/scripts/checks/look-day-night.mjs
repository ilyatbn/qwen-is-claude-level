/**
 * `look-day-night` — T23.11 (R7): **night and moonlit day, one blend, moons that move.**
 *
 * ## 1. Level A: the game's blend at its two ends is the two pictures
 *
 * The look-lab's `&t=` draws a scene at an hour of the game's blend (`look/daylight.ts`: F5's palette at 0, F1's at 1,
 * every field mixed in linear space; the moons at the pictures' places). Full tier, as `look-sky` (R20):
 * - `?look=F1&only=sky&t=1` against `reference/controls/F1-sky.png` and `&t=0` against `F5-sky.png` — every
 *   `look-thresholds.json` metric within its threshold (the set for this renderer, R25);
 * - `?look=F1&only=world&t=1` against `controls/F1-world.png` (sky, fog, lit terrain, bloom, grade — `look-gate-f1`'s);
 * - the whole lab frame at `t=1` against the lab's F1 and at `t=0` against the lab's F5 (with their casts): the same
 *   metrics, so nothing outside the sky and world moved either.
 * - **Controls:** the blend's middle (`t=0.5`) fails against **both** skies — it is neither end — and `t=1` fails
 *   against F5's sky (the comparison can tell the two apart).
 * - Reported: what the low tier's terrain bake costs by day — it is shaded for the night's `sunDir` at every hour
 *   (`worldRenderer.ts::syncBake`) — the lab at `t=0` against the lab's F5, both low tier.
 *
 * ## 2. Live: advancing the cycle moves a moon across the sky
 *
 * Sandbox (seed 4242, low tier), camera held at the top of the map. At `DAY_T` (the day moons at their places,
 * `DAY_MOON_U`) and `DAY_T + MOVE_S`: the renderer says the big moon moved (`__world.sky().moons`), and in the world
 * canvas the patch where it was changes (it left); the control patch — sky with no moon in either frame, bands and
 * gradient only — does not, and the same patch in two frames at one hour does not.
 */
import { writeFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'
import { actorBoxes, compare, failures, loadPng, thresholdsFor, withActors } from '../lib/look-compare.mjs'
import { HIGH_QUALITY_KEY } from '../lib/check-tier.mjs'
import { constants as rustConstants } from '../lib/rust-constants.mjs'

const root = join(dirname(fileURLToPath(import.meta.url)), '../..')
const { PNG } = createRequire(join(root, 'client/package.json'))('pngjs')
const ref = (p) => join(root, 'tasks/M23/reference', p)
const RAW = JSON.parse((await import('node:fs')).readFileSync(join(root, 'scripts/lib/look-thresholds.json'), 'utf8'))

/**
 * Sandbox seconds: how far the clock is moved from the middle of the day — `DAY_T`, `daylight.ts::DAY_MOON_U` of the
 * cycle. T23.19G F8: both read, not typed in (the cycle from `constants.rs`, the anchor from the page).
 */
const CYCLE = rustConstants().get('DAY_DURATION') + rustConstants().get('NIGHT_DURATION')
const MOVE_S = 6
/** A patch "changed" when its mean per-channel change exceeds this (0–255); "held" when under `HELD_MAX`. */
const CHANGED_MIN = 6
const HELD_MAX = 1
/** The blend's end against the scene drawn directly: at most float rounding, one level (0–255). */
const SAME_MAX = 1

async function lab(page, shot, search, name) {
  const base = new URL(page.url())
  base.search = search
  await page.goto(base.href, { waitUntil: 'load' })
  await page.waitForFunction(() => window.__look && (window.__look.ready || window.__look.error) && !!window.__world, null, { timeout: 90_000 })
  const h = await page.evaluate(() => ({ look: window.__look, info: window.__world.info(), sky: window.__world.sky() }))
  if (h.look.error) throw new Error(`look-lab ${search}: ${h.look.error}`)
  await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))))
  await shot(name)
  return { png: loadPng(join(root, 'shots', `${name}.png`)), info: h.info, sky: h.sky }
}

export default async function ({ page, shot, log }) {
  const problems = []
  // ------------------------------------------------------------------------------------- 1. Level A
  await page.evaluate((k) => localStorage.setItem(k, '1'), HIGH_QUALITY_KEY)
  const regions = withActors(loadPng(ref('controls/regions-F1.png')), actorBoxes('F1'))
  const refs = { F1sky: loadPng(ref('controls/F1-sky.png')), F5sky: loadPng(ref('controls/F5-sky.png')), F1world: loadPng(ref('controls/F1-world.png')) }
  let TH = null
  const within = (label, a, b) => {
    const m = compare(a, b, { regions })
    const bad = failures(m, TH)
    const n = Object.keys(TH.metrics).length
    log(`${label}: ${n - bad.length}/${n} within — deltaE ${m.deltaE.toFixed(5)} (max ${TH.metrics.deltaE.threshold}), deltaE_sky ${m.deltaE_sky.toFixed(5)} (max ${TH.metrics.deltaE_sky.threshold}), dssim ${m.dssim.toFixed(5)}`)
    return { m, bad, n }
  }

  const sky1 = await lab(page, shot, '?look=F1&only=sky&t=1', 'look-day-night-sky-t1')
  TH = thresholdsFor(RAW, sky1.info.gpu)
  if (sky1.info.tier !== 'full' || sky1.info.buffer[0] !== 1280) problems.push(`want the full tier at 1280x720, got ${JSON.stringify(sky1.info)}`)
  if (sky1.sky.hour.t !== 1 || sky1.sky.hour.u !== null) problems.push(`&t=1 drew hour ${JSON.stringify(sky1.sky.hour)}`)
  const sky0 = await lab(page, shot, '?look=F1&only=sky&t=0', 'look-day-night-sky-t0')
  if (sky0.sky.hour.t !== 0) problems.push(`&t=0 drew hour ${JSON.stringify(sky0.sky.hour)}`)
  const skyMid = await lab(page, shot, '?look=F1&only=sky&t=0.5', 'look-day-night-sky-t05')

  const a1 = within('Level A — lab sky at t=1 vs controls/F1-sky.png', sky1.png, refs.F1sky)
  if (a1.bad.length) problems.push(`t=1 sky outside its thresholds vs F1: ${a1.bad.join(', ')}`)
  const a0 = within('Level A — lab sky at t=0 vs controls/F5-sky.png', sky0.png, refs.F5sky)
  if (a0.bad.length) problems.push(`t=0 sky outside its thresholds vs F5: ${a0.bad.join(', ')}`)
  // Controls: the middle is neither end; night is not the moonlit day.
  const c1 = within('control — t=0.5 vs F1-sky (must fail)', skyMid.png, refs.F1sky)
  const c2 = within('control — t=0.5 vs F5-sky (must fail)', skyMid.png, refs.F5sky)
  const c3 = within('control — t=1 vs F5-sky (must fail)', sky1.png, refs.F5sky)
  for (const [name, c] of [['t=0.5 vs F1', c1], ['t=0.5 vs F5', c2], ['t=1 vs F5', c3]]) {
    if (!c.bad.includes('deltaE_sky')) problems.push(`control ${name} passes deltaE_sky — the comparison cannot see the hour`)
  }

  const world1 = await lab(page, shot, '?look=F1&only=world&t=1', 'look-day-night-world-t1')
  const w1 = within('Level A — lab world at t=1 vs controls/F1-world.png', world1.png, refs.F1world)
  if (w1.bad.length) problems.push(`t=1 world outside its thresholds vs F1-world: ${w1.bad.join(', ')}`)

  // The whole frame, cast and effects in: the blend's ends against the lab's own scenes.
  const fullF1 = await lab(page, shot, '?look=F1', 'look-day-night-lab-F1')
  const fullF5 = await lab(page, shot, '?look=F5', 'look-day-night-lab-F5')
  const full1 = await lab(page, shot, '?look=F1&t=1', 'look-day-night-full-t1')
  const full0 = await lab(page, shot, '?look=F1&t=0', 'look-day-night-full-t0')
  // Pixel for pixel, not by the metrics: the same scene drawn two ways may differ by float rounding (a level), and
  // paletteDE's k-means flips a cluster on that much (measured: 623 px at 1 level, paletteDE past its threshold).
  const same = (label, a, b) => {
    let n = 0
    let max = 0
    for (let i = 0; i < a.data.length; i += 4) {
      const d = Math.max(Math.abs(a.data[i] - b.data[i]), Math.abs(a.data[i + 1] - b.data[i + 1]), Math.abs(a.data[i + 2] - b.data[i + 2]))
      if (d > 0) n++
      if (d > max) max = d
    }
    log(`${label}: ${n} px differ, by at most ${max} (max ${SAME_MAX})`)
    return max <= SAME_MAX
  }
  if (!same('whole frame at t=1 vs the lab F1', full1.png, fullF1.png)) problems.push(`t=1 whole frame differs from F1's`)
  if (!same('whole frame at t=0 vs the lab F5', full0.png, fullF5.png)) problems.push(`t=0 whole frame differs from F5's`)

  // Side by side for a person: t=0 | F5 picture | t=1 | F1 picture, and the blend strip.
  const strip = (name, imgs) => {
    const w = imgs[0].width
    const out = new PNG({ width: (w + 8) * imgs.length - 8, height: imgs[0].height })
    out.data.fill(255)
    imgs.forEach((img, k) => {
      for (let y = 0; y < img.height; y++) Buffer.from(img.data.buffer, img.data.byteOffset + y * img.width * 4, img.width * 4).copy(out.data, (y * out.width + k * (w + 8)) * 4)
    })
    writeFileSync(join(root, 'shots', `${name}.png`), PNG.sync.write(out))
    log(`side by side: shots/${name}.png`)
  }
  strip('look-day-night-ends-vs-pictures', [full0.png, loadPng(ref('F5-moonlit-day.png')), full1.png, loadPng(ref('F1-night-combat.png'))])
  strip('look-day-night-sky-strip', [sky0.png, skyMid.png, sky1.png])

  // Reported: the low tier's terrain by day, baked for night's sunDir, against its own F5 bake.
  await page.evaluate((k) => localStorage.setItem(k, '0'), HIGH_QUALITY_KEY)
  const low0 = await lab(page, shot, '?look=F1&only=world&t=0', 'look-day-night-low-world-t0')
  const low5 = await lab(page, shot, '?look=F5&only=world', 'look-day-night-low-world-F5')
  if (low0.info.tier !== 'low') problems.push(`the low-tier leg runs ${low0.info.tier}`)
  const lowCost = compare(low0.png, low5.png, { regions })
  log(`reported: low tier by day, terrain baked at night's sunDir vs its own (F5) bake — deltaE_terrain ${lowCost.deltaE_terrain.toFixed(4)}, deltaE ${lowCost.deltaE.toFixed(4)}, p95 ${lowCost.p95.toFixed(2)}`)

  // ------------------------------------------------------------------------------------- 2. live: a moon moves
  const base = new URL(page.url())
  // T23.31: the classic world — seed 4242 draws volcanic by the server's rule; this check was calibrated on classic.
  base.search = '?sandbox=1&seed=4242&worldlook=classic'
  await page.goto(base.href, { waitUntil: 'load' })
  await page.waitForFunction(() => !!window.__game && !!window.__world && window.__world.frames() > 2 && !!window.__world.sky()?.drawn, null, { timeout: 60_000 })
  await page.waitForFunction(() => window.__world.litTerrain()?.drawn, null, { timeout: 120_000 })
  await page.evaluate(() => window.__game.watch(window.__game.core.width / 2, 200))
  const at = async (t) => {
    await page.evaluate((x) => window.__game.setTime(x), t)
    for (let i = 0; i < 6; i++) await page.evaluate(() => new Promise((r) => requestAnimationFrame(r)))
    const f = await page.evaluate(() => window.__world.readFrame())
    const s = await page.evaluate(() => window.__world.sky())
    return { f: { ...f, data: Buffer.from(f.rgba, 'base64') }, s }
  }
  const U = await page.evaluate(async () => {
    const d = await import('/src/look/daylight.ts')
    return { day: d.DAY_MOON_U, night: d.NIGHT_MOON_U }
  })
  const DAY_T = U.day * CYCLE
  const A = await at(DAY_T)
  const A2 = await at(DAY_T)
  const B = await at(DAY_T + MOVE_S)
  await shot('look-day-night-moon-moved')
  const m0 = A.s.moons[0]
  const m1 = B.s.moons[0]
  if (!m0 || !m1) {
    problems.push(`no day moon drawn at ${DAY_T} s: ${JSON.stringify(A.s)}`)
  } else {
    const moved = Math.hypot(m1.x - m0.x, m1.y - m0.y)
    log(`the big moon at ${DAY_T} s: (${m0.x.toFixed(0)}, ${m0.y.toFixed(0)}) r ${m0.r}; at ${DAY_T + MOVE_S} s: (${m1.x.toFixed(0)}, ${m1.y.toFixed(0)}) — ${moved.toFixed(1)} frame px (hour ${JSON.stringify(A.s.hour)} → ${JSON.stringify(B.s.hour)})`)
    if (!(moved > m0.r)) problems.push(`the moon moved ${moved.toFixed(1)} px in ${MOVE_S} s — less than its radius`)
    // Patches in buffer px (the world canvas: frame px × buffer/frame). The moon's: a box inside its disc where it was.
    const k = A.f.w / 1280
    const box = (cx, cy, half) => ({ x0: Math.round((cx - half) * k), y0: Math.round((cy - half) * k), x1: Math.round((cx + half) * k), y1: Math.round((cy + half) * k) })
    const moonBox = box(m0.x - (m1.x - m0.x) / 2, m0.y, m0.r * 0.5)
    // The control: sky between the moons' paths, well below the big moon's disc and halo — bands and gradient only.
    const ctrlBox = box(160, 300, 30)
    const delta = (a, b, r) => {
      let s = 0
      let n = 0
      for (let y = r.y0; y < r.y1; y++) for (let x = r.x0; x < r.x1; x++) {
        const o = (y * a.w + x) * 4 // readFrame: rows top-down
        s += (Math.abs(a.data[o] - b.data[o]) + Math.abs(a.data[o + 1] - b.data[o + 1]) + Math.abs(a.data[o + 2] - b.data[o + 2])) / 3
        n++
      }
      return n ? s / n : NaN
    }
    const moonMoved = delta(A.f, B.f, moonBox)
    const moonHeld = delta(A.f, A2.f, moonBox)
    const ctrl = delta(A.f, B.f, ctrlBox)
    log(`world canvas: the moon's old place changed ${moonMoved.toFixed(2)} (min ${CHANGED_MIN}); same hour twice ${moonHeld.toFixed(2)} (max ${HELD_MAX}); control sky patch ${ctrl.toFixed(2)} (max ${HELD_MAX})`)
    if (!(moonMoved > CHANGED_MIN)) problems.push(`the moon's old place changed only ${moonMoved.toFixed(2)} when the clock moved`)
    if (!(moonHeld <= HELD_MAX)) problems.push(`the moon's place changed ${moonHeld.toFixed(2)} with the clock held — the frame moves by itself`)
    if (!(ctrl <= HELD_MAX)) problems.push(`the control sky patch changed ${ctrl.toFixed(2)} — something besides the moon moved`)
  }

  // ------------------------------------------------------------------------------------- 3. no compile at dusk
  // T23.19G F6: the sky's moon-set variants are built at the map change (`SkyQuad.warm`), so pushing the clock through
  // dusk (both sets), full night (night's only) and back to day builds no program. Planted out (no warm) the count rose
  // at dusk. The sandbox's clock is the match's `WorldRenderer.setDaylight` path; only the clock's source differs.
  const P = await page.evaluate(async () => {
    const m = await import('/src/render/sky-math.ts')
    return { dusk: (m.DUSK_START + m.NIGHT_START) / 2 }
  })
  const programs = async (t) => {
    await page.evaluate((x) => window.__game.setTime(x), t)
    for (let i = 0; i < 6; i++) await page.evaluate(() => new Promise((r) => requestAnimationFrame(r)))
    return page.evaluate(() => ({ n: window.__world.info().memory.programs, names: window.__world.info().programNames, hour: window.__world.sky()?.hour }))
  }
  const legs = [['day', U.day * CYCLE], ['dusk', P.dusk * CYCLE], ['night', U.night * CYCLE], ['day again', U.day * CYCLE]]
  const seen = []
  for (const [name, t] of legs) seen.push({ name, t, ...(await programs(t)) })
  log(`programs through the day: ${seen.map((s) => `${s.name} (${s.t.toFixed(1)} s, hour ${JSON.stringify(s.hour)}) ${s.n}`).join(', ')}`)
  const hours = new Set(seen.map((s) => JSON.stringify(s.hour?.t)))
  if (hours.size < 3) problems.push(`the clock did not move the sky through three hours: ${[...hours].join(' ')} — nothing here is evidence`)
  const grew = seen.filter((s) => s.n !== seen[0].n)
  if (grew.length) {
    const count = (a) => (a ?? []).reduce((m, n) => m.set(n, (m.get(n) ?? 0) + 1), new Map())
    const before = count(seen[0].names)
    const added = [...count(grew[0].names)].filter(([n, k]) => k > (before.get(n) ?? 0)).map(([n]) => n)
    problems.push(`a program was built mid-round: ${seen[0].n} at day → ${grew.map((s) => `${s.n} at ${s.name}`).join(', ')} (${added.join(', ') || 'names unknown'})`)
  }

  if (problems.length) throw new Error(`look-day-night:\n  - ${problems.join('\n  - ')}`)
}
