/**
 * `look-volcanic` — T23.31 (docs/78 §A7): the volcanic world look, through the game's renderer.
 *
 * ## 1. Level A: F2's world against the mockup's (gating)
 *
 * `?look=F2&only=world` — F2 without its cast — against `reference/controls/F2-world.png`, the mockup's own F2 world
 * (`controls/worldonly.js` with `variant_F2.js`'s P: `controls/variant_W2.js`, rendered twice byte-identical; the
 * mockup's whole F2 render is byte-identical to `F2-volcanic-night.png`). Every `look-thresholds.json` metric of this
 * page's back end (R25) must sit within its threshold — F1's thresholds: the same method, the same arena, a palette the
 * set was never fitted to. Printed beside each.
 *
 * ## 2. Must-fail controls
 *
 * - `knob=lava-off` (the seams' term out): must fail — the comparison sees the lava.
 * - The classic world (`?look=F1&only=world`) against F2's reference: must fail — the comparison sees the palette.
 *
 * ## 3. Against the F2 picture (reported)
 *
 * `?look=F2` whole (cast, effects, the mockup's still embers) against `F2-volcanic-night.png`, printed — the cast's
 * share of the miss is look-gate-f1's §3 question, asked of F1. Side by side in `shots/look-volcanic-vs-F2.png`.
 *
 * ## 4. The volcanic world in the lab: its backdrop and its embers are drawn
 *
 * `?look=volcanic` (the world look on F2's scene, with the volcano backdrop): the backdrop's band differs from the same
 * frame with the layer hidden (`hideLayers(['backdrop'])`) by at least `BACKDROP_MIN` — and the hidden frame equals F2's
 * own lab frame there (the control: nothing else differs). The embers likewise (`hideLayers(['embers'])`).
 *
 * ## 5. The creatures are drawn, and are told apart from the classic animals by silhouette
 *
 * The four animals at 4× on a dark patch (`__world.setActors`): each one's ink mask (pixels darker than the patch's
 * own) is non-empty, and the tripod against the beetle and the crawler against the spider have IoU ≤ `IOU_MAX`
 * (R26's readability bar). Control: an animal against itself drawn twice is IoU 1. The sheet is
 * `shots/t2331-creatures.png`.
 */
import { writeFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'
import { compare, failures, loadPng, thresholdsFor, withActors, actorBoxes } from '../lib/look-compare.mjs'
import { HIGH_QUALITY_KEY } from '../lib/check-tier.mjs'

const root = join(dirname(fileURLToPath(import.meta.url)), '../..')
const { PNG } = createRequire(join(root, 'client/package.json'))('pngjs')
const ref = (p) => join(root, 'tasks/M23/reference', p)
const RAW = JSON.parse((await import('node:fs')).readFileSync(join(root, 'scripts/lib/look-thresholds.json'), 'utf8'))

/** §4: mean |Δ| per channel (0–255) over the volcano's band the backdrop must make, at least. */
const BACKDROP_MIN = 2
/** §4: the hidden frame against F2's own over the same band — no more than this (the control). */
const SAME_MAX = 0.5
/** §5: R26's bar for two silhouettes that must read apart. */
const IOU_MAX = 0.72

const decode = (f) => ({ width: f.w, height: f.h, data: Uint8Array.from(Buffer.from(f.rgba, 'base64')) })

async function lab(page, q) {
  const base = new URL(page.url())
  base.search = q
  await page.goto(base.href, { waitUntil: 'load' })
  await page.waitForFunction(() => window.__look && (window.__look.ready || window.__look.error) && !!window.__world, null, { timeout: 120_000 })
  const look = await page.evaluate(() => window.__look)
  if (look.error) throw new Error(`look-lab ${q}: ${look.error}`)
  return { look, frame: decode(await page.evaluate(() => window.__world.readFrame())), info: await page.evaluate(() => window.__world.info()) }
}

async function frameNow(page) {
  await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))))
  return decode(await page.evaluate(() => window.__world.readFrame()))
}

/** Mean |Δ| per channel over a rect. */
function meanDelta(a, b, [x0, y0, x1, y1]) {
  let s = 0
  let n = 0
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      const i = (y * a.width + x) * 4
      s += Math.abs(a.data[i] - b.data[i]) + Math.abs(a.data[i + 1] - b.data[i + 1]) + Math.abs(a.data[i + 2] - b.data[i + 2])
      n += 3
    }
  }
  return s / n
}

function save(img, name) {
  const out = new PNG({ width: img.width, height: img.height })
  out.data = Buffer.from(img.data)
  writeFileSync(join(root, 'shots', name), PNG.sync.write(out))
}

function sideBySide(a, b, name) {
  const out = new PNG({ width: a.width * 2 + 8, height: a.height })
  out.data.fill(255)
  for (let y = 0; y < a.height; y++) {
    for (const [img, x0] of [[a, 0], [b, a.width + 8]]) {
      Buffer.from(img.data.buffer, img.data.byteOffset + y * img.width * 4, img.width * 4).copy(out.data, (y * out.width + x0) * 4)
    }
  }
  writeFileSync(join(root, 'shots', name), PNG.sync.write(out))
}

export default async function ({ page, log }) {
  const problems = []
  await page.evaluate((k) => localStorage.setItem(k, '1'), HIGH_QUALITY_KEY)
  const regions = withActors(loadPng(ref('controls/regions-F1.png')), actorBoxes('F2'))
  const world = loadPng(ref('controls/F2-world.png'))

  // ------------------------------------------------------------------ 1. Level A
  const f2 = await lab(page, '?look=F2&only=world')
  const TH = thresholdsFor(RAW, f2.info.gpu)
  log(`renderer ${JSON.stringify(f2.info.gpu)} → the ${TH.backEnd} threshold set (R25); tier ${f2.info.tier}`)
  if (f2.info.tier !== 'full') throw new Error(`want the full tier, got ${f2.info.tier}`)
  save(f2.frame, 'look-volcanic-lab.png')
  const m = compare(f2.frame, world, { regions })
  const bad = failures(m, TH)
  log('1. Level A — look-lab F2 world vs reference/controls/F2-world.png:')
  for (const [k, t] of Object.entries(TH.metrics)) log(`  F2 ${k.padEnd(15)} ${m[k].toFixed(5).padStart(10)}  max ${String(t.threshold).padEnd(9)} ${bad.includes(k) ? 'FAIL' : 'ok'}`)
  if (bad.length) problems.push(`F2 world outside its thresholds: ${bad.join(', ')}`)
  sideBySide(f2.frame, world, 'look-volcanic-vs-reference.png')

  // ------------------------------------------------------------------ 2. must-fail
  for (const q of ['?look=F2&only=world&knob=lava-off', '?look=F1&only=world']) {
    const c = await lab(page, q)
    const cbad = failures(compare(c.frame, world, { regions }), TH)
    log(`2. control ${q}: fails ${cbad.length}/${Object.keys(TH.metrics).length} (${cbad.join(', ') || 'none'})`)
    if (!cbad.length) problems.push(`control ${q} passes every threshold — the comparison cannot see it`)
  }

  // ------------------------------------------------------------------ 3. the F2 picture (reported)
  const whole = await lab(page, '?look=F2')
  const pic = loadPng(ref('F2-volcanic-night.png'))
  const pm = compare(whole.frame, pic, { regions })
  const pbad = failures(pm, TH)
  log(`3. look-lab F2 (whole) vs F2-volcanic-night.png — reported: ${Object.keys(TH.metrics).map((k) => `${k} ${pm[k].toFixed(4)}${pbad.includes(k) ? '*' : ''}`).join(', ')} (* over F1's world threshold)`)
  sideBySide(whole.frame, pic, 'look-volcanic-vs-F2.png')

  // ------------------------------------------------------------------ 4. the world look's backdrop and embers
  const v = await lab(page, '?look=volcanic&only=world')
  save(v.frame, 't2331-lab-volcanic.png')
  const band = [0, 120, 1280, 470]
  await page.evaluate(() => window.__world.hideLayers(['backdrop']))
  const noBackdrop = await frameNow(page)
  const dBack = meanDelta(v.frame, noBackdrop, band)
  const dSame = meanDelta(noBackdrop, f2.frame, band)
  log(`4. backdrop: band ${band.join(',')} drawn vs hidden ${dBack.toFixed(2)} (min ${BACKDROP_MIN}); hidden vs F2's own frame ${dSame.toFixed(3)} (max ${SAME_MAX}, the control)`)
  if (!(dBack >= BACKDROP_MIN)) problems.push(`the volcano backdrop changes its band by ${dBack.toFixed(2)} < ${BACKDROP_MIN}: not drawn`)
  if (!(dSame <= SAME_MAX)) problems.push(`with the backdrop hidden the volcanic lab differs from F2 by ${dSame.toFixed(3)} > ${SAME_MAX}: something else moved`)
  const ve = await lab(page, '?look=F2')
  await page.evaluate(() => window.__world.hideLayers(['embers']))
  const noEmbers = await frameNow(page)
  const dEmb = meanDelta(ve.frame, noEmbers, [0, 200, 1280, 720])
  log(`   embers: drawn vs hidden ${dEmb.toFixed(3)} over F2's band (must be > 0)`)
  if (!(dEmb > 0)) problems.push('the embers change nothing: not drawn')

  // ------------------------------------------------------------------ 5. the creatures
  await lab(page, '?look=F2&only=sky')
  const S = 4
  const kinds = ['beetle', 'tripod', 'spider', 'crawler']
  const cell = (k, i, gait) => ({ kind: k, x: 160 + i * 240, y: 330 + Math.round(gait * 3) * 0, opts: { s: S * (k === 'beetle' ? 1 : k === 'tripod' ? 16 / 12 : k === 'spider' ? 12 / 12.5 : 12 / 11), face: 1, gait }, lit: { size: S * 0.66, halo: null, shadow: false }, box: null })
  const sheet = []
  for (let row = 0; row < 3; row++) kinds.forEach((k, i) => sheet.push({ ...cell(k, i, row / 3), y: 220 + row * 170 }))
  await page.evaluate((a) => window.__world.setActors(a), sheet)
  const withCast = await frameNow(page)
  await page.evaluate(() => window.__world.setActors([]))
  const bare = await frameNow(page)
  save(withCast, 't2331-creatures.png')
  /** Ink mask of the actor in a 200×150 box around (x, y): pixels darker than the bare sky there. */
  const mask = (img, x, y) => {
    const out = new Uint8Array(200 * 150)
    for (let j = 0; j < 150; j++) {
      for (let i = 0; i < 200; i++) {
        const px = x - 100 + i
        const py = y - 120 + j
        const o = (py * img.width + px) * 4
        const l = img.data[o] + img.data[o + 1] + img.data[o + 2]
        const b = bare.data[o] + bare.data[o + 1] + bare.data[o + 2]
        out[j * 200 + i] = Math.abs(l - b) > 24 ? 1 : 0
      }
    }
    return out
  }
  const iou = (a, b) => {
    let i = 0
    let u = 0
    for (let k = 0; k < a.length; k++) {
      i += a[k] & b[k]
      u += a[k] | b[k]
    }
    return u ? i / u : 0
  }
  const masks = Object.fromEntries(kinds.map((k, i) => [k, mask(withCast, 160 + i * 240, 220)]))
  for (const k of kinds) {
    const n = masks[k].reduce((s, v) => s + v, 0)
    log(`5. ${k}: ${n} ink px`)
    if (n < 40) problems.push(`${k} draws ${n} px: not drawn`)
  }
  // Each pair aligned on the feet line and the body's centre (same anchor): the silhouettes overlap as drawn.
  const tb = iou(masks.tripod, masks.beetle)
  const cs = iou(masks.crawler, masks.spider)
  const self = iou(masks.tripod, mask(withCast, 160 + 240, 220))
  log(`   IoU tripod/beetle ${tb.toFixed(3)}, crawler/spider ${cs.toFixed(3)} (max ${IOU_MAX}); control tripod/itself ${self.toFixed(3)}`)
  if (tb > IOU_MAX || cs > IOU_MAX) problems.push(`a volcanic creature reads as the classic animal (IoU ${tb.toFixed(3)}, ${cs.toFixed(3)} > ${IOU_MAX})`)
  if (self < 0.999) problems.push(`the IoU control is ${self.toFixed(3)}, not 1: the mask is not the drawing`)

  if (problems.length) throw new Error(problems.join('\n'))
}
