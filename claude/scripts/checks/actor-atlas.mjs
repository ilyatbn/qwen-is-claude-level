/**
 * `actor-atlas` — T23.12: the cast drawn by code into atlas cells and laid out as quads by the world renderer
 * (`client/src/look/actors/`), at Level A on the actor boxes.
 *
 * ## 1. Level A on F4's actor boxes (gating)
 *
 * The look-lab's F4 (the cast sheet) at the full tier against the mockup's F4 **with its rim passes off**
 * (`reference/controls/castonly.js` 'rim-off' → `F4-cast-rim-off.png`: halo, shadow, the cool fill and the ink
 * pass — what T23.12 draws; the rim passes are T23.13's), with the fx and the text taken out as the lab has them.
 * Metric: `deltaE_actors`, mean CIEDE2000 over the union of F4's 16 actor boxes, against the threshold of this
 * page's back end (R25: `look-thresholds.json` `sets.<set>.actors`, placed by `look-compare.mjs::actorSet` between
 * two lab renders and the smallest of R19's controls + rim-off).
 *
 * **The browser.** This leg opens its own Chromium with the reference harness's flags (`render.mjs`:
 * `--use-gl=angle --use-angle=swiftshader`) rather than the suite's `--use-gl=swiftshader`: under the suite's,
 * Chrome rasterises every 2D canvas on the CPU, which dithers gradients (halos, shadows, glows), and the mockup's
 * canvas was rasterised on the GPU — measured on these boxes, 0.50 against 0.12. That number is still printed
 * (§4) and gates nothing: it is a property of the checks' browser, not of the port.
 *
 * ## 2. Counted at both ends; the cache
 *
 * The page described 16 actors and the renderer laid out 16 quads (`__world.actors().quads`). Over 20 more drawn
 * frames of the unchanged scene the atlas redraws **nothing** (`redraws` unchanged — a cell is drawn once), while
 * the quads are laid out every frame (the frame counter moves). The vitest counts it over 100 frames.
 *
 * ## 3. Must-fail controls through the lab
 *
 * `&knob=actor-rim-off,` + `exposure-up`, `bloom-off`, `fog-off` (R19's, lab side) must each fail `deltaE_actors` — `bloom-off` is the
 * smallest control, so this is the tight one. And `&only=world` (no cast described) must fail: a metric that passed
 * it could not see the cast at all.
 *
 * ## 4. Reported, not gating
 *
 * The same F4 on the suite's page (CPU-rastered canvas), and the lab against the rim-on reference `F4-cast.png`
 * (T23.13's, which this task does not draw).
 */
import { writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { actorBoxes, boxesDeltaE, loadPng, thresholdsFor } from '../lib/look-compare.mjs'
import { HIGH_QUALITY_KEY } from '../lib/check-tier.mjs'
import { chromePath, libDir } from '../lib/browser-args.mjs'

const root = join(dirname(fileURLToPath(import.meta.url)), '../..')
const require = createRequire(join(root, 'client/package.json'))
const { PNG } = require('pngjs')
const { chromium } = require('playwright-core')
const ref = (p) => join(root, 'tasks/M23/reference', p)
const RAW = JSON.parse((await import('node:fs')).readFileSync(join(root, 'scripts/lib/look-thresholds.json'), 'utf8'))

/** `tasks/M23/reference/mockup-src/render.mjs`'s flags: the browser the references were made in. */
export const REFERENCE_ARGS = ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist']
/** F4's cast: 16 actors (`scenes/F4.ts`, measured against `variant_F4.js` by `scenes.test.ts`). */
const F4_ACTORS = 16
/** Drawn frames the cache must survive without a redraw. */
const CACHE_FRAMES = 20

const decode = (f) => ({ width: f.w, height: f.h, data: Uint8Array.from(Buffer.from(f.rgba, 'base64')) })

async function lab(page, origin, extra) {
  await page.goto(`${origin}/?look=F4&e2e=1${extra}`, { waitUntil: 'load' })
  await page.waitForFunction(() => window.__look && (window.__look.ready || window.__look.error) && !!window.__world, null, { timeout: 120_000 })
  const look = await page.evaluate(() => JSON.parse(JSON.stringify(window.__look)))
  if (look.error) throw new Error(`look-lab F4${extra}: ${look.error}`)
  const frame = decode(await page.evaluate(() => window.__world.readFrame()))
  const info = await page.evaluate(() => ({ info: window.__world.info(), actors: window.__world.actors() }))
  return { look, frame, ...info }
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

export default async function ({ page, shot, log }) {
  const origin = new URL(page.url()).origin
  const boxes = actorBoxes('F4')
  let rimOff = loadPng(ref('controls/F4-cast-rim-off.png'))
  const problems = []
  const browser = await chromium.launch({ executablePath: chromePath, env: { ...process.env, LD_LIBRARY_PATH: libDir }, headless: true, args: REFERENCE_ARGS })
  try {
    const own = await browser.newPage({ viewport: { width: 1280, height: 720 }, deviceScaleFactor: 1 })
    await own.goto(`${origin}/?e2e=1`, { waitUntil: 'load' })
    await own.evaluate((k) => localStorage.setItem(k, '1'), HIGH_QUALITY_KEY)

    // ------------------------------------------------------------ 1. Level A, full tier
    // T23.13 draws the rim passes by default: this leg is T23.12's picture, the rim switched off.
    const full = await lab(own, origin, '&knob=actor-rim-off')
    const TH = thresholdsFor(RAW, full.info.gpu)
    const T = TH.actors
    if (!(T?.threshold > 0)) throw new Error(`look-thresholds.json's ${TH.backEnd} set places no actor threshold: ${JSON.stringify(T)}`)
    // Like for like (T23.13): a set with its own references (gpu: the mockup on D3D12) is compared with its own.
    const own_ = { ...RAW.actors.controls, ...(RAW.sets[TH.backEnd].actors.controls ?? {}) }['rim-off'].split(' ')[0]
    rimOff = loadPng(join(root, 'tasks/M23', own_))
    log(`renderer ${JSON.stringify(full.info.gpu)} → the ${TH.backEnd} set: deltaE_actors max ${T.threshold} (floor ${T.floor.toPrecision(3)}, ${T.smallestControl} ${T.smallest.toPrecision(3)})`)
    const i = full.info
    if (i.tier !== 'full' || i.buffer[0] !== 1280 || i.buffer[1] !== 720 || i.samples !== 4) throw new Error(`want the full tier (1280x720, MSAA 4), got ${JSON.stringify(i)}`)
    const d = boxesDeltaE(full.frame, rimOff, boxes)
    log(`1. look-lab F4 vs F4-cast-rim-off.png on ${boxes.length} actor boxes: deltaE_actors ${d.toFixed(4)} (max ${T.threshold}) ${d <= T.threshold ? 'ok' : 'FAIL'}`)
    for (const [k, b] of boxes.entries()) log(`   box ${String(k).padStart(2)} ${JSON.stringify(b).padEnd(22)} ${boxesDeltaE(full.frame, rimOff, [b]).toFixed(3)}`)
    if (d > T.threshold) problems.push(`Level A: deltaE_actors ${d.toFixed(4)} > ${T.threshold}`)
    sideBySide(full.frame, rimOff, 'actor-atlas-F4-lab-vs-mockup.png')
    writeFileSync(join(root, 'shots/actor-atlas-F4-lab.png'), PNG.sync.write(Object.assign(new PNG({ width: 1280, height: 720 }), { data: Buffer.from(full.frame.data) })))

    // ------------------------------------------------------------ 2. both ends, and the cache
    const a0 = full.actors
    log(`2. described ${full.look.described.actors} actors, laid out ${a0.quads} quads; atlas ${a0.cells} cells, ${a0.redraws} redraws, ${a0.uploads} uploads, ${a0.resets} resets`)
    if (full.look.described.actors !== F4_ACTORS || a0.quads !== F4_ACTORS) problems.push(`counted: described ${full.look.described.actors}, quads ${a0.quads}, want ${F4_ACTORS}`)
    if (a0.redraws !== F4_ACTORS || a0.resets !== 0) problems.push(`first frame: ${a0.redraws} redraws, ${a0.resets} resets — want one per actor, none`)
    const f0 = await own.evaluate(() => window.__world.frames())
    for (let k = 0; k < CACHE_FRAMES; k++) await own.evaluate(() => window.__world.readFrame())
    const f1 = await own.evaluate(() => window.__world.frames())
    const a1 = await own.evaluate(() => window.__world.actors())
    log(`   ${f1 - f0} more drawn frames: redraws ${a0.redraws} → ${a1.redraws}, quads ${a1.quads}`)
    if (f1 - f0 < CACHE_FRAMES) problems.push(`cache: only ${f1 - f0} frames drawn`)
    if (a1.redraws !== a0.redraws || a1.quads !== F4_ACTORS) problems.push(`cache: redraws ${a0.redraws} → ${a1.redraws} over ${f1 - f0} unchanged frames`)

    // ------------------------------------------------------------ 3. must-fail controls
    for (const knob of ['exposure-up', 'bloom-off', 'fog-off']) {
      const c = await lab(own, origin, `&knob=actor-rim-off,${knob}`)
      const dc = boxesDeltaE(c.frame, rimOff, boxes)
      log(`3. control knob=${knob}: deltaE_actors ${dc.toFixed(4)} ${dc > T.threshold ? 'fails, as it must' : 'PASSES — the metric cannot see it'}`)
      if (!(dc > T.threshold)) problems.push(`control ${knob} passed (${dc.toFixed(4)} ≤ ${T.threshold})`)
    }
    const w = await lab(own, origin, '&only=world')
    if (w.look.described.actors !== 0) problems.push(`only=world still describes ${w.look.described.actors} actors`)
    const dw = boxesDeltaE(w.frame, rimOff, boxes)
    log(`3. control only=world (no cast): deltaE_actors ${dw.toFixed(4)} ${dw > T.threshold ? 'fails, as it must' : 'PASSES — the metric cannot see the cast'}`)
    if (!(dw > T.threshold)) problems.push(`control only=world passed (${dw.toFixed(4)})`)
    const rimOn = boxesDeltaE(full.frame, loadPng(ref('controls/F4-cast.png')), boxes)
    log(`4. the rim-off lab vs the rim-on F4-cast.png: ${rimOn.toFixed(4)} (rim-light gates the rim)`)
  } finally {
    await browser.close()
  }

  // ------------------------------------------------------------ 4. the suite's browser (not gating)
  await page.evaluate((k) => localStorage.setItem(k, '1'), HIGH_QUALITY_KEY)
  const suite = await lab(page, origin, '&knob=actor-rim-off')
  await shot('actor-atlas')
  const ds = boxesDeltaE(suite.frame, loadPng(ref('controls/F4-cast-rim-off.png')), boxes)
  log(`4. the suite's browser (${suite.info.tier}, CPU-rastered canvas): deltaE_actors ${ds.toFixed(4)}, ${suite.actors.quads} quads — reported, not gating`)
  if (suite.actors.quads !== F4_ACTORS) problems.push(`the suite's page laid out ${suite.actors.quads} quads`)
  if (problems.length) throw new Error(`actor-atlas: ${problems.join('; ')}`)
}
