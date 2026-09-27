/**
 * `look-sky` — T23.04: the sky, at Level A against the pictures and live in the sandbox.
 *
 * ## 1. Level A: the look-lab's sky against the mockup's sky, metric by metric
 *
 * `?look=F1&only=sky` describes F1 with its terrain, actors, fx and labels taken out of the data
 * (`LookScene`), so what the world renderer draws is its sky alone. The reference is the mockup's
 * own sky alone — `e_style.js::bgQuad(P.bg)` through the post chain the renderer has today
 * (half-float 4× MSAA → RenderPass → OutputPass, ACES at `P.exposure`; `kit.js::post` minus the
 * bloom and grade T23.08 adds): `reference/controls/F1-sky.png`, made by
 * `reference/controls/skyonly.js` in the T23.02 recipe, and rendered twice byte-identical (floor 0).
 * Every metric in `look-thresholds.json` is computed (region map = F1's, with its actor boxes) and
 * must sit within its threshold; every value is printed beside it.
 *
 * **Full tier, not the checks' low tier (R20).** The references were rendered at 1280×720 with 4×
 * MSAA (`kit.js::makeRenderer` scale 1); the low tier draws 640×360 and CSS-scales it, which
 * resamples the per-pixel grain and stars and is not the same picture by construction. The lab is
 * a still page, so the full tier costs nothing here. The check stores the choice explicitly
 * (`'1'`) and asserts the tier, buffer and MSAA it got; the live half below goes back to low.
 *
 * Controls: the same lab frame against **F5's** sky (another palette, three moons) must fail —
 * a comparison that passes against the wrong picture measures nothing. F5 is also run the same
 * way against `F5-sky.png` (its moons are this task's). Reported, not gating: the lab's sky
 * against the full F1 picture's sky region (fog, bloom and grade are T23.08's).
 *
 * ## 2. Live: panning moves the far band less than the near one, a moon holds still
 *
 * In the sandbox (seed 4242), each band is isolated in turn (`__world.hideSkyLayers`) and read
 * back from the world canvas **in a frame it drew, with the view that frame was drawn from**
 * (`__world.readFrame`), at two camera positions `PAN` world px apart (held with `__game.watch`).
 * A band's pixels are those that differ from the same camera's frame with every band hidden; its
 * top silhouette is matched between the two positions to measure its screen shift. Each shift
 * must equal `pan × zoom × parallax` from the drawn views (`__world.sky()`'s factors) within
 * `TOL_PX`, and they must increase far → near. **Control: the moon** (F1's `sun` disc, parallax 0)
 * is located in the all-hidden frames at both positions and must not move.
 *
 * ## 3. Seeded, and none in space
 *
 * Another sky seed changes the frame and the first seed gives it back byte for byte (every client
 * of a round lays out one sky). Regenerated as a space map, the world renderer draws no sky
 * (`info().sky` false, and its canvas reads back black) — the presence control is the standard
 * map just measured.
 */
import { writeFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'
import { actorBoxes, compare, failures, loadPng, thresholdsFor, withActors } from '../lib/look-compare.mjs'
import { HIGH_QUALITY_KEY } from '../lib/check-tier.mjs'

const root = join(dirname(fileURLToPath(import.meta.url)), '../..')
const { PNG } = createRequire(join(root, 'client/package.json'))('pngjs')
const ref = (p) => join(root, 'tasks/M23/reference', p)
const RAW = JSON.parse((await import('node:fs')).readFileSync(join(root, 'scripts/lib/look-thresholds.json'), 'utf8'))
/** R25 (T23.08C): the threshold set for this page's renderer, from the first lab frame (`look-compare.mjs::thresholdsFor`). */
let TH = null

/** World px the camera is moved between the two readings. */
const PAN = 200
/** A measured shift may differ from pan × zoom × factor by this much, frame px: one low-tier buffer px each side (×2) plus the silhouette's step jitter. */
const TOL_PX = 3
/** A band pixel differs from the all-hidden frame by more than this (max channel). */
const BAND_DIFF = 6
/** T23.04C F6: steps of the slow pan, one world px each. */
const SLOW_STEPS = 16

const decode = (f) => ({ ...f, data: Buffer.from(f.rgba, 'base64') })

/** Metric table, printed: every value against its threshold. */
function table(log, name, m) {
  const bad = failures(m, TH)
  for (const [k, t] of Object.entries(TH.metrics)) {
    log(`  ${name} ${k.padEnd(15)} ${m[k].toFixed(5).padStart(10)}  max ${String(t.threshold).padEnd(9)} ${bad.includes(k) ? 'FAIL' : 'ok'}`)
  }
  return bad
}

async function levelA(page, shot, log, id) {
  const base = new URL(page.url())
  base.search = `?look=${id}&only=sky`
  await page.goto(base.href, { waitUntil: 'load' })
  await page.waitForFunction(() => window.__look && (window.__look.ready || window.__look.error) && !!window.__world, null, { timeout: 60_000 })
  const h = await page.evaluate(() => ({ look: window.__look, info: window.__world.info() }))
  if (h.look.error) throw new Error(`look-lab ${id}: ${h.look.error}`)
  TH = thresholdsFor(RAW, h.info.gpu)
  const i = h.info
  if (i.tier !== 'full' || i.buffer[0] !== 1280 || i.buffer[1] !== 720 || i.samples !== 4 || !i.sky) {
    throw new Error(`${id}: want the full tier (1280x720, MSAA 4) with the sky drawn, got ${JSON.stringify(i)}`)
  }
  if (h.look.described.actors !== 0 || h.look.described.solidPx !== null) throw new Error(`${id}&only=sky still describes actors or rock: ${JSON.stringify(h.look.described)}`)
  await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))))
  const name = `look-sky-${id}`
  await shot(name)
  return loadPng(join(root, 'shots', `${name}.png`))
}

/** Top silhouette row per column of the pixels where `a` differs from `b`, or -1. */
function silhouette(a, b) {
  const top = new Int32Array(a.w).fill(-1)
  for (let x = 0; x < a.w; x++) {
    for (let y = 0; y < a.h; y++) {
      const o = (y * a.w + x) * 4
      if (Math.max(Math.abs(a.data[o] - b.data[o]), Math.abs(a.data[o + 1] - b.data[o + 1]), Math.abs(a.data[o + 2] - b.data[o + 2])) > BAND_DIFF) {
        top[x] = y
        break
      }
    }
  }
  return top
}

/** The shift s (buffer px) minimising |topA[x] − topB[x + s]| over columns both define (at least `minN` of them). */
function bestShift(ta, tb, maxS, minN) {
  let best = { s: 0, cost: Infinity, n: 0 }
  for (let s = -maxS; s <= maxS; s++) {
    let c = 0
    let n = 0
    for (let x = 0; x < ta.length; x++) {
      const xb = x + s
      if (xb < 0 || xb >= tb.length || ta[x] < 0 || tb[xb] < 0) continue
      c += Math.abs(ta[x] - tb[xb])
      n++
    }
    if (n >= minN && c / n < best.cost) best = { s, cost: c / n, n }
  }
  return best
}

/** Centroid of the brightest disc near (cx, cy) buffer px: pixels with luma above `thr`. */
function discCentroid(f, cx, cy, r, thr) {
  let sx = 0
  let sy = 0
  let n = 0
  for (let y = Math.max(0, cy - r); y < Math.min(f.h, cy + r); y++) {
    for (let x = Math.max(0, cx - r); x < Math.min(f.w, cx + r); x++) {
      const o = (y * f.w + x) * 4
      if (0.2126 * f.data[o] + 0.7152 * f.data[o + 1] + 0.0722 * f.data[o + 2] > thr) {
        sx += x
        sy += y
        n++
      }
    }
  }
  return n ? { x: sx / n, y: sy / n, n } : null
}

export default async function ({ page, shot, log }) {
  // ---------------------------------------------------------------- 1. Level A
  await page.evaluate((k) => localStorage.setItem(k, '1'), HIGH_QUALITY_KEY)
  const regions = withActors(loadPng(ref('controls/regions-F1.png')), actorBoxes('F1'))
  const f1Sky = loadPng(ref('controls/F1-sky.png'))
  const f5Sky = loadPng(ref('controls/F5-sky.png'))
  const problems = []

  const labF1 = await levelA(page, shot, log, 'F1')
  const m1 = compare(labF1, f1Sky, { regions })
  log(`Level A — look-lab F1 sky vs reference/controls/F1-sky.png (full tier, ${Object.keys(TH.metrics).length} metrics):`)
  const bad1 = table(log, 'F1', m1)
  if (bad1.length) problems.push(`F1 sky outside its thresholds: ${bad1.join(', ')}`)

  // Control: the same frame against the wrong sky must fail.
  const wrong = compare(labF1, f5Sky, { regions })
  const wrongBad = failures(wrong, TH)
  log(`control: lab F1 vs F5's sky fails ${wrongBad.length}/${Object.keys(TH.metrics).length} metrics (deltaE_sky ${wrong.deltaE_sky.toFixed(3)})`)
  if (!wrongBad.includes('deltaE_sky') || wrongBad.length < Object.keys(TH.metrics).length / 2) {
    problems.push(`control: the lab's F1 sky passes against F5's sky on ${Object.keys(TH.metrics).length - wrongBad.length} metrics — the comparison cannot tell skies apart`)
  }
  // Reported: against the whole F1 picture, whose sky region carries fog, bloom and grade (T23.08).
  const full = compare(labF1, loadPng(ref('F1-night-combat.png')), { regions })
  log(`reported, not gating: lab F1 sky vs the F1 picture's sky region deltaE_sky ${full.deltaE_sky.toFixed(3)} (max ${TH.metrics.deltaE_sky.threshold}; fog, bloom, grade are T23.08's)`)

  const labF5 = await levelA(page, shot, log, 'F5')
  const m5 = compare(labF5, f5Sky, { regions })
  log('Level A — look-lab F5 sky (three moons) vs reference/controls/F5-sky.png:')
  const bad5 = table(log, 'F5', m5)
  if (bad5.length) problems.push(`F5 sky outside its thresholds: ${bad5.join(', ')}`)

  // Side by side for a person: lab | reference, both skies.
  for (const [id, lab, refPng] of [['F1', labF1, f1Sky], ['F5', labF5, f5Sky]]) {
    const out = new PNG({ width: lab.width * 2 + 8, height: lab.height })
    out.data.fill(255)
    for (let y = 0; y < lab.height; y++) {
      for (const [img, x0] of [[lab, 0], [refPng, lab.width + 8]]) {
        Buffer.from(img.data.buffer, img.data.byteOffset + y * img.width * 4, img.width * 4).copy(out.data, (y * out.width + x0) * 4)
      }
    }
    const p = join(root, 'shots', `look-sky-${id}-vs-reference.png`)
    writeFileSync(p, PNG.sync.write(out))
    log(`side by side (lab | mockup): shots/look-sky-${id}-vs-reference.png`)
  }

  // ---------------------------------------------------------------- 2. live parallax
  await page.evaluate((k) => localStorage.setItem(k, '0'), HIGH_QUALITY_KEY)
  const base = new URL(page.url())
  base.search = '?sandbox=1&seed=4242'
  await page.goto(base.href, { waitUntil: 'load' })
  await page.waitForFunction(() => !!window.__game && !!window.__world && window.__world.frames() > 2 && !!window.__world.sky()?.drawn, null, { timeout: 60_000 })
  const sky = await page.evaluate(() => window.__world.sky())
  const tier = await page.evaluate(() => window.__world.info())
  if (tier.tier !== 'low') problems.push(`the live half runs ${tier.tier}, want low (R20: the checks' tier)`)
  const n = sky.layers.length
  if (n < 2) throw new Error(`the game sky has ${n} layers — nothing to compare`)
  const cssPerBuf = 1280 / tier.buffer[0]
  const all = [...Array(n).keys()]

  const at = async (cx, cy) => {
    await page.evaluate(([x, y]) => window.__game.watch(x, y), [cx, cy])
    await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))))
  }
  const frame = async (hide) => {
    await page.evaluate((h) => window.__world.hideSkyLayers(h), hide)
    return decode(await page.evaluate(() => window.__world.readFrame()))
  }
  const d0 = await page.evaluate(() => window.__game.debug())
  const cy = d0.mapH / 2
  /** Read every band, and the all-hidden control, at camera centre (x, cy). */
  const readAt = async (x) => {
    await at(x, cy)
    const bare = await frame(all)
    const bands = []
    for (let i = 0; i < n; i++) bands.push(await frame(all.filter((j) => j !== i)))
    return { bare, bands, info: await page.evaluate(() => window.__world.sky()) }
  }
  // A band is a repeating row of shapes with gaps, so a given camera may have none of one band on
  // screen: pan pairs are tried from the map's centre outward until every band has been seen in
  // both frames of one pair (`MIN_COLS` columns of silhouette each).
  const MIN_COLS = 60
  // T23.04B (R21): the sky is baked once per sky and tier — the pans and band isolations below
  // must not rebake it.
  const bakesBefore = await page.evaluate(() => window.__world.info().skyBakes)
  const shifts = new Array(n).fill(null)
  /** The camera x each band was measured at — somewhere it is on screen. */
  const seenAt = new Array(n).fill(null)
  const seen = []
  let firstPair = null
  for (let k = 0; k < 8 && shifts.some((v) => v === null); k++) {
    const x0 = d0.mapW / 2 + (k % 2 ? -1 : 1) * Math.ceil(k / 2) * 450
    const A = await readAt(x0 - PAN / 2)
    const B = await readAt(x0 + PAN / 2)
    firstPair ??= [A, B]
    const pan = B.bare.view.x - A.bare.view.x
    const zoom = 1280 / A.bare.view.w
    if (!(Math.abs(pan) > PAN / 2) || B.bare.view.y !== A.bare.view.y) {
      problems.push(`the camera did not pan as asked at x ${x0}: views ${JSON.stringify([A.bare.view, B.bare.view])}`)
      continue
    }
    for (let i = 0; i < n; i++) {
      if (shifts[i] !== null) continue
      for (const r of [A, B]) {
        if (JSON.stringify(r.bands[i].view) !== JSON.stringify(r.bare.view)) problems.push(`band ${i}: read at a different view than its control`)
      }
      const ta = silhouette(A.bands[i], A.bare)
      const tb = silhouette(B.bands[i], B.bare)
      const cols = Math.min(ta.filter((v) => v >= 0).length, tb.filter((v) => v >= 0).length)
      if (cols < MIN_COLS) continue
      const want = -pan * zoom * sky.layers[i].parallax
      const got = bestShift(ta, tb, Math.ceil((Math.abs(want) + 40) / cssPerBuf), Math.floor(cols / 2))
      const measured = got.s * cssPerBuf
      // What the renderer says it applied, from the two frames' own offsets.
      const applied = B.info.offsets[i][0] - A.info.offsets[i][0]
      shifts[i] = measured
      seenAt[i] = x0
      seen.push(i)
      log(`band ${i} (parallax ${sky.layers[i].parallax}, camera x ${x0}): measured ${measured.toFixed(1)} px, want ${want.toFixed(1)} (pan ${pan} x zoom ${zoom} x factor), renderer applied ${applied.toFixed(1)}; ${got.n} columns, residual ${got.cost.toFixed(2)}`)
      if (Math.abs(measured - want) > TOL_PX) problems.push(`band ${i} moved ${measured.toFixed(1)} px, want ${want.toFixed(1)} ± ${TOL_PX}`)
      // T23.04C F6: the bands are drawn unsnapped (linear bakes), so applied is the layout's offset;
      // the tolerance stays one texel (`cssPerBuf` frame px), which a snapped offset would also meet.
      if (Math.abs(applied - want) > cssPerBuf) problems.push(`band ${i}: the renderer applied ${applied}, the layout says ${want} (± one texel, ${cssPerBuf})`)
    }
  }
  // T23.04C F6: a slow pan slides every band — no still frames between jumps. One world px a frame
  // (the slowest pan a camera makes), the nearest band alone: each step its drawn offset must move
  // by the same non-zero amount (monotone, even), and its pixels must change on **every** step. With
  // R21's snapped offsets it moved one texel (2 px low, 1 px full) every few steps and not at all
  // between — measured with the snap planted back: offsets [0,0,-2,0,0,0,0,0,-2,…], pixels unchanged
  // on 12 of 16 steps.
  const near = n - 1
  if (seenAt[near] !== null) {
    const hideAllBut = all.filter((j) => j !== near)
    const steps = []
    for (let k = 0; k <= SLOW_STEPS; k++) {
      await at(seenAt[near] + k, cy)
      const f = await frame(hideAllBut)
      steps.push({ f, off: (await page.evaluate(() => window.__world.sky())).offsets[near][0] })
    }
    const moves = []
    const changed = []
    const camera = []
    for (let k = 1; k < steps.length; k++) {
      moves.push(+(steps[k].off - steps[k - 1].off).toFixed(3))
      camera.push(steps[k].f.view.x - steps[k - 1].f.view.x)
      const a = steps[k - 1].f.data
      const b = steps[k].f.data
      let c = 0
      for (let i = 0; i < a.length; i += 4) if (a[i] !== b[i] || a[i + 1] !== b[i + 1] || a[i + 2] !== b[i + 2]) c++
      changed.push(c)
    }
    log(`slow pan, band ${near}, 1 world px a step: camera moved ${JSON.stringify(camera)}; offset moved ${JSON.stringify(moves)} px; pixels changed ${JSON.stringify(changed)}`)
    const nonUnit = camera.filter((d) => Math.abs(d) !== 1).length
    const still = changed.filter((c) => c === 0).length
    const sign = Math.sign(moves[0])
    const uneven = moves.filter((m) => Math.sign(m) !== sign || m === 0 || Math.abs(m) > 1.5 * Math.abs(moves[0]) || Math.abs(m) < Math.abs(moves[0]) / 1.5).length
    if (nonUnit > SLOW_STEPS / 4) problems.push(`slow pan: the camera did not step one world px a frame (${JSON.stringify(camera)})`)
    if (uneven) problems.push(`slow pan: band ${near}'s offset moved unevenly on ${uneven} of ${moves.length} steps: ${JSON.stringify(moves)}`)
    if (still) problems.push(`slow pan: band ${near}'s pixels did not move on ${still} of ${changed.length} steps — it steps, not slides`)
  } else problems.push(`slow pan: band ${near} was never measured on screen — no place to pan it slowly`)
  await page.evaluate(() => window.__world.hideSkyLayers([]))
  await shot('look-sky-sandbox')
  const bakesAfter = await page.evaluate(() => window.__world.info())
  log(`bakes: ${bakesBefore} before the pans, ${bakesAfter.skyBakes} after ${seen.length} bands measured over pans and isolations; ${(bakesAfter.skyBakeBytes / 1e6).toFixed(1)} MB baked at the ${bakesAfter.tier} tier`)
  if (!(bakesBefore >= 1)) problems.push(`the sky was drawn from ${bakesBefore} bakes — the bake counter is not counting`)
  if (bakesAfter.skyBakes !== bakesBefore) problems.push(`panning and hiding bands rebaked the sky ${bakesAfter.skyBakes - bakesBefore} time(s)`)
  const unseen = shifts.map((v, i) => (v === null ? i : -1)).filter((i) => i >= 0)
  if (unseen.length) problems.push(`band(s) ${unseen.join(', ')} never on screen in both frames of any pan pair — not measured`)
  const [A, B] = firstPair
  for (let i = 1; i < n; i++) if (shifts[i] !== null && shifts[i - 1] !== null && !(Math.abs(shifts[i]) > Math.abs(shifts[i - 1]))) problems.push(`band ${i} (nearer) moved ${shifts[i]} px, band ${i - 1} ${shifts[i - 1]} — the far band must move less`)
  // The control: the moon (F1's sun disc, parallax 0), in the all-hidden frames at both positions.
  const sun = { x: 1000 / cssPerBuf, y: 110 / cssPerBuf, r: 40 / cssPerBuf }
  const ma = discCentroid(A.bare, Math.round(sun.x), Math.round(sun.y), Math.round(sun.r), 150)
  const mb = discCentroid(B.bare, Math.round(sun.x), Math.round(sun.y), Math.round(sun.r), 150)
  if (!ma || !mb) problems.push(`control: no moon disc near (${sun.x}, ${sun.y}) buffer px: ${JSON.stringify([ma, mb])}`)
  else {
    const dm = Math.hypot(mb.x - ma.x, mb.y - ma.y) * cssPerBuf
    log(`control: the moon (parallax 0) moved ${dm.toFixed(2)} px over the first pan (${ma.n} px disc); the bands ${JSON.stringify(shifts)}`)
    if (dm > 1) problems.push(`control: the moon moved ${dm.toFixed(2)} px — it is not fixed`)
  }

  // ---------------------------------------------------------------- 3. seeded; none in space
  const seedA = d0.seed ?? 4242
  const same = await frame([])
  await page.evaluate((s) => window.__game.setSkySeed(s), Number(seedA) + 1)
  const other = await frame([])
  await page.evaluate((s) => window.__game.setSkySeed(s), Number(seedA))
  const back = await frame([])
  const differ = (a, b) => {
    let c = 0
    for (let i = 0; i < a.data.length; i += 4) if (a.data[i] !== b.data[i] || a.data[i + 1] !== b.data[i + 1] || a.data[i + 2] !== b.data[i + 2]) c++
    return c
  }
  const dOther = differ(same, other)
  const dBack = differ(same, back)
  log(`seeded: another sky seed changes ${dOther} px of ${same.w * same.h}, the first again ${dBack}`)
  // A new seed is a new sky: each change rebakes it (the frames above could not differ otherwise).
  const bakesSeeded = await page.evaluate(() => window.__world.info().skyBakes)
  if (bakesSeeded - bakesAfter.skyBakes !== 2) problems.push(`two seed changes made ${bakesSeeded - bakesAfter.skyBakes} bakes, want 2`)
  // And a tier change: the texel halves, so the bake is rebuilt at four times the texels.
  await page.evaluate(() => window.__game.setHighQuality(true))
  const fullTier = await frame([])
  const fullInfo = await page.evaluate(() => window.__world.info())
  await page.evaluate(() => window.__game.setHighQuality(false))
  await frame([])
  const lowInfo = await page.evaluate(() => window.__world.info())
  log(`tier: full ${fullInfo.skyBakeBytes / 1e6} MB (${fullTier.w}x${fullTier.h} buffer), low again ${lowInfo.skyBakeBytes / 1e6} MB; bakes ${bakesSeeded} → ${fullInfo.skyBakes} → ${lowInfo.skyBakes}`)
  if (fullInfo.tier !== 'full' || fullInfo.skyBakes !== bakesSeeded + 1 || lowInfo.skyBakes !== bakesSeeded + 2) problems.push(`a tier change did not rebake exactly once each way: ${JSON.stringify([bakesSeeded, fullInfo.tier, fullInfo.skyBakes, lowInfo.skyBakes])}`)
  if (!(fullInfo.skyBakeBytes > 3.5 * lowInfo.skyBakeBytes)) problems.push(`the full tier's bake (${fullInfo.skyBakeBytes} B) is not ~4x the low tier's (${lowInfo.skyBakeBytes} B)`)
  if (dOther < same.w * same.h * 0.05) problems.push(`another seed changed only ${dOther} px`)
  if (dBack !== 0) problems.push(`the first seed again differs in ${dBack} px`)

  const maxLuma = (f) => {
    let m = 0
    for (let i = 0; i < f.data.length; i += 4) m = Math.max(m, f.data[i], f.data[i + 1], f.data[i + 2])
    return m
  }
  const groundMax = maxLuma(same)
  await page.evaluate(() => window.__game.regenerate(undefined, undefined, 'space'))
  await page.waitForFunction(() => window.__game.core.meta.generator === 'Space' && window.__world.sky()?.drawn === false, null, { timeout: 60_000 }).catch(() => {})
  const spaceInfo = await page.evaluate(() => window.__world.info())
  const spaceFrame = await frame([])
  const spaceMax = maxLuma(spaceFrame)
  await shot('look-sky-space')
  log(`space map: sky drawn ${spaceInfo.sky}, world canvas brightest channel ${spaceMax} (standard map: ${groundMax})`)
  if (spaceInfo.sky !== false || spaceMax > 2) problems.push(`the ground sky draws on a space map (sky ${spaceInfo.sky}, brightest ${spaceMax})`)
  if (!(groundMax > 40)) problems.push(`control: the standard map's sky read back only as bright as ${groundMax}`)

  if (problems.length) throw new Error(`look-sky:\n  - ${problems.join('\n  - ')}`)
}
