/**
 * `rim-light` — T23.13: `lit()` as one sprite shader — the rim passes on the actors, the rim-off control, and the
 * two live properties: a rim on the side of the light that makes it, and the halo that keeps a figure off ink in
 * the dark.
 *
 * ## 1. Level A on F4's actor boxes, rim passes on (gating)
 *
 * The look-lab's F4 at the full tier against the mockup's F4 cast (`reference/controls/F4-cast.png`,
 * `castonly.js`), `deltaE_actors` within this back end's actor threshold (R25, `look-thresholds.json`
 * `sets.<set>.actors` — created by T23.12, floor re-measured on T23.13's frames). In the reference harness's
 * browser, as `actor-atlas` (its §1 says why). **Control (R25's must-fail set holds rim-off):**
 * `&knob=actor-rim-off` against the same reference must fail it.
 *
 * ## 2. Live: the rim is on the light's side (sandbox, the game's renderer)
 *
 * A stick figure is placed on the ground (`__world.setActors`, the frame frozen) with a laser-impact light
 * (`f_scene.js`'s `L(l1…, 170, P.laser, 2.4)`) to its right. Four frames: figure with / without the light, and no
 * figure with / without it; the rim's own change is `(figure lit − figure moonlit) − (none lit − none moonlit)` —
 * the light's terrain lighting cancels. Teal (G − R) gained right of the figure's spine must pass `TEAL_MIN`;
 * the left side is the control and must gain less than a quarter of the right's.
 *
 * ## 3. Live: the halo in the dark (F's `halo`, keyed on the `back` field)
 *
 * A figure given `lit.darkHalo` on a cave-wall pixel (`__world.backAt`) against the same figure without it: the
 * ring round its halo centre must brighten by `HALO_MIN`. Control: on open ground (no `back`), `darkHalo` changes
 * nothing.
 */
import { writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { actorBoxes, boxesDeltaE, loadPng, thresholdsFor } from '../lib/look-compare.mjs'
import { HIGH_QUALITY_KEY } from '../lib/check-tier.mjs'
import { chromePath, libDir } from '../lib/browser-args.mjs'
import { REFERENCE_ARGS } from './actor-atlas.mjs'

const root = join(dirname(fileURLToPath(import.meta.url)), '../..')
const require = createRequire(join(root, 'client/package.json'))
const { PNG } = require('pngjs')
const { chromium } = require('playwright-core')
const ref = (p) => join(root, 'tasks/M23/reference', p)
const RAW = JSON.parse((await import('node:fs')).readFileSync(join(root, 'scripts/lib/look-thresholds.json'), 'utf8'))

/** The live figure: F4's 3× stick (`variant_F4.js`: s = 1.15·3, lit size 3), big enough to measure a 1-px rim. */
const K = 3
const LIVE_STICK = { kind: 'stick', opts: { s: 1.15 * K, aim: 0.05, weapon: 'laser', accent: '#e8482c' }, lit: { size: K, halo: null, shadow: true }, box: null }
/** `f_scene.js::combatF`'s laser-impact light: P.laser (F1), r 170, i 2.4 — placed right of the figure's chest. */
const LASER = { dx: 45, dy: -20 * K, z: 30, r: 170, rgb: '40,225,210', i: 2.4 }
/** F1's `P.halo` — the spider's halo in a tunnel (`f_scene.js`). */
const DARK_HALO = '120,120,170'
/** Mean teal gain (G − R, levels) just outside the lit edge the light must add (measured 2026-09-27, seed 4242: 90). */
const TEAL_MIN = 30
/** A px is the figure's ink where the figure darkens it by more than this (luminance levels). */
const INK_DROP = 20
/** …or this share of the luma behind it, over a sky darker than `INK_DROP / INK_SHARE`. */
const INK_SHARE = 0.6
/** Width of each side's patch, buffer px (the rim sits 1.15·size mask px off the ink: 3.45 at size 3). */
const EDGE_PX = 3
/** Mean luminance gain the dark halo must add to its ring (levels; measured 2026-09-27, seed 4242: 4.7). */
const HALO_MIN = 2

const decode = (f) => ({ width: f.w, height: f.h, data: Uint8Array.from(Buffer.from(f.rgba, 'base64')), view: f.view })
const luma = (d, o) => 0.2126 * d[o] + 0.7152 * d[o + 1] + 0.0722 * d[o + 2]

async function lab(page, origin, extra) {
  // T23.18: the lab draws F4's effects now; its reference (`castonly.js`) has none — so neither does this lab.
  await page.goto(`${origin}/?look=F4&e2e=1&knob=fx-off${extra}`, { waitUntil: 'load' })
  await page.waitForFunction(() => window.__look && (window.__look.ready || window.__look.error) && !!window.__world, null, { timeout: 120_000 })
  const look = await page.evaluate(() => window.__look.error)
  if (look) throw new Error(`look-lab F4${extra}: ${look}`)
  return { frame: decode(await page.evaluate(() => window.__world.readFrame())), info: await page.evaluate(() => window.__world.info()) }
}

/** A frame with `actors` and `lights` set on the frozen scene. */
async function frameWith(page, actors, lights) {
  await page.evaluate(([a, l]) => {
    window.__world.setActors(a)
    window.__world.setLights(l)
  }, [actors, lights])
  return decode(await page.evaluate(() => window.__world.readFrame()))
}

/** Mean over the buffer px whose mask position satisfies `inside` of `f(o)` (o: byte offset). */
function mean(img, inside, f) {
  const k = img.width / img.view.w
  let s = 0
  let n = 0
  for (let y = 0; y < img.height; y++) {
    for (let x = 0; x < img.width; x++) {
      if (!inside(img.view.x + (x + 0.5) / k, img.view.y + (y + 0.5) / k)) continue
      s += f((y * img.width + x) * 4)
      n++
    }
  }
  return { mean: n ? s / n : 0, n }
}

export default async function ({ page, shot, log }) {
  const origin = new URL(page.url()).origin
  const boxes = actorBoxes('F4')
  const problems = []

  // ------------------------------------------------------------ 1. Level A + the rim-off control
  const browser = await chromium.launch({ executablePath: chromePath, env: { ...process.env, LD_LIBRARY_PATH: libDir }, headless: true, args: REFERENCE_ARGS })
  try {
    const own = await browser.newPage({ viewport: { width: 1280, height: 720 }, deviceScaleFactor: 1 })
    await own.goto(`${origin}/?e2e=1`, { waitUntil: 'load' })
    await own.evaluate((k) => localStorage.setItem(k, '1'), HIGH_QUALITY_KEY)
    const on = await lab(own, origin, '')
    const TH = thresholdsFor(RAW, on.info.gpu)
    const T = TH.actors
    const set = { ...RAW.actors, ...RAW.sets[TH.backEnd].actors }
    const reference = loadPng(join(root, 'tasks/M23', set.reference.split(' ')[0]))
    const d = boxesDeltaE(on.frame, reference, boxes)
    log(`renderer → the ${TH.backEnd} set, reference ${set.reference.split(' ')[0]}: deltaE_actors max ${T.threshold} (floor ${T.floor.toPrecision(3)}, ${T.smallestControl} ${T.smallest.toPrecision(3)})`)
    log(`1. look-lab F4, rim on: deltaE_actors ${d.toFixed(4)} ${d <= T.threshold ? 'ok' : 'FAIL'}`)
    if (d > T.threshold) problems.push(`Level A: deltaE_actors ${d.toFixed(4)} > ${T.threshold}`)
    const off = await lab(own, origin, '&knob=actor-rim-off')
    const dOff = boxesDeltaE(off.frame, reference, boxes)
    log(`1. control knob=actor-rim-off: deltaE_actors ${dOff.toFixed(4)} ${dOff > T.threshold ? 'fails, as it must' : 'PASSES — the rim is not what the check sees'}`)
    if (!(dOff > T.threshold)) problems.push(`control actor-rim-off passed (${dOff.toFixed(4)})`)
    const out = new PNG({ width: 1280 * 2 + 8, height: 720 })
    out.data.fill(255)
    for (let y = 0; y < 720; y++) for (const [img, x0] of [[on.frame, 0], [reference, 1288]]) Buffer.from(img.data.buffer, img.data.byteOffset + y * 5120, 5120).copy(out.data, (y * out.width + x0) * 4)
    writeFileSync(join(root, 'shots/rim-light-F4-lab-vs-mockup.png'), PNG.sync.write(out))
  } finally {
    await browser.close()
  }

  // ------------------------------------------------------------ 2. live: the rim on the light's side
  await page.waitForFunction(() => window.__game && window.__world && window.__world.litTerrain()?.drawn, null, { timeout: 120_000 })
  // T23.10: on the full tier — one buffer px per world px at zoom 1, as the low tier gave at zoom 2, which is what
  // `EDGE_PX` and `TEAL_MIN` were measured at (the low tier's half-resolution buffer at zoom 1 read −6.6, 12 px).
  await page.evaluate(() => window.__game.setHighQuality(true))
  await page.waitForFunction(() => window.__world.info().tier === 'full' && window.__world.litTerrain()?.drawn && !window.__game.debug().terrainSwapPending, null, { timeout: 60_000 })
  // A ground spot in view with a figure's height of air above it and no cave wall under its halo centre (so it is
  // also §3's open-ground control).
  const found = await page.evaluate((h) => {
    const c = window.__game.core
    for (let x = 200; x < c.width - 200; x += 16) {
      for (let y = h + 60; y < c.height - 10; y++) {
        if (!c.solidAt(x, y) || c.solidAt(x, y - 1) || window.__world.backAt(x, y - 14 * 3)) continue
        let clear = true
        for (let k = 1; k <= h && clear; k++) clear = !c.solidAt(x, y - k) && !c.solidAt(x + 20, y - k) && !c.solidAt(x - 20, y - k)
        if (clear) return { x, y }
        break
      }
    }
    return null
  }, Math.ceil(36 * LIVE_STICK.opts.s))
  if (!found) throw new Error("no ground with a figure's height of air above it on the map")
  const cx = found.x
  const ground = found.y
  // Look at it (the sandbox's watch point), and let the camera arrive before the scene is frozen.
  await page.evaluate(([x, y]) => window.__game.watch(x, y), [cx, ground - 40])
  await page.evaluate(() => new Promise((r) => { let i = 0; const f = () => (++i >= 30 ? r() : requestAnimationFrame(f)); requestAnimationFrame(f) }))
  const view = await page.evaluate(() => window.__world.view())
  await page.evaluate(() => window.__game.freeze(true))
  // The scene's lights, less any that reach the figure (T23.10: at zoom 1 the view holds four times the map's standing
  // lights, and a gate or crystal within its radius of the figure was the dominant key in every frame — the laser then
  // changed no rim, teal exactly 0).
  const held = (await page.evaluate(() => window.__world.lights())).filter((l) => Math.hypot(l.x - found.x, l.y - (found.y - 14 * K)) > l.r)
  const stick = { ...LIVE_STICK, x: cx, y: ground }
  const laser = { x: cx + LASER.dx, y: ground + LASER.dy, z: LASER.z, r: LASER.r, rgb: LASER.rgb, i: LASER.i }
  const aL = await frameWith(page, [stick], [...held, laser])
  const aM = await frameWith(page, [stick], held)
  const nL = await frameWith(page, [], [...held, laser])
  const nM = await frameWith(page, [], held)
  const teal = (o) => (aL.data[o + 1] - aL.data[o]) - (aM.data[o + 1] - aM.data[o]) - ((nL.data[o + 1] - nL.data[o]) - (nM.data[o + 1] - nM.data[o]))
  // Patches on each side of the silhouette, row by row: the ink (figure moonlit vs none, luminance down by
  // INK_DROP) gives each row's outermost px, and a patch `EDGE_PX` buffer px wide sits just outside it — right
  // (facing the light) and left (facing away). The rim is drawn L·1.15·size off the ink, so it lands there.
  const W = aM.width
  const right = { mean: 0, n: 0 }
  const left = { mean: 0, n: 0 }
  for (let y = 0; y < aM.height; y++) {
    let xl = -1
    let xr = -1
    for (let x = 0; x < W; x++) {
      const o = (y * W + x) * 4
      // T23.10: ink is a drop of `INK_DROP`, or of most of what is behind it over a dark sky (at zoom 1 the figure
      // stood against the near-black top of the sky, luma 13: the ink's drop was 13, and its edge was never found).
      const behind = luma(nM.data, o)
      if (behind - luma(aM.data, o) > Math.min(INK_DROP, behind * INK_SHARE)) {
        if (xl < 0) xl = x
        xr = x
      }
    }
    if (xl < 0 || xr - xl < 2) continue
    for (let k = 1; k <= EDGE_PX; k++) {
      if (xr + k < W) { right.mean += teal((y * W + xr + k) * 4); right.n++ }
      if (xl - k >= 0) { left.mean += teal((y * W + xl - k) * 4); left.n++ }
    }
  }
  right.mean /= right.n || 1
  left.mean /= left.n || 1
  log(`2. laser light right of a figure at (${cx}, ${ground}): teal gain just outside the right edge ${right.mean.toFixed(2)} (${right.n} px, min ${TEAL_MIN}), outside the left ${left.mean.toFixed(2)} (${left.n} px; control < right / 4)`)
  if (!(right.n > 0 && right.mean >= TEAL_MIN)) problems.push(`rim: the lit side gains only ${right.mean.toFixed(2)} teal (min ${TEAL_MIN})`)
  if (!(left.mean < right.mean / 4)) problems.push(`rim control: the far side gains ${left.mean.toFixed(2)} teal — not less than a quarter of the lit side's ${right.mean.toFixed(2)}`)

  await frameWith(page, [stick], [...held, laser])
  await shot('rim-light-rim')
  // §3's control, here in §2's view: on open ground (no `back` under the halo centre — the spot search ensured it),
  // `darkHalo` changes nothing.
  {
    const dark = { ...stick, lit: { ...stick.lit, darkHalo: DARK_HALO } }
    const oWith = await frameWith(page, [dark], held)
    const oWithout = await frameWith(page, [stick], held)
    const ring = (x, y) => { const r = Math.hypot(x - cx, y - (ground - 14 * K)); return r > 16 * K && r < 28 * K }
    const ctrl = mean(oWith, ring, (o) => Math.abs(luma(oWith.data, o) - luma(oWithout.data, o)))
    log(`3. control: darkHalo on open ground (${cx}, ${ground}): ring |Δ| ${ctrl.mean.toFixed(5)} over ${ctrl.n} px (max 0.01)`)
    // Not exactly 0: the two frames are separate draws and a handful of px may round apart (measured 0.000x).
    if (!(ctrl.n > 0) || ctrl.mean > 0.01) problems.push(`halo control: darkHalo changed open ground by ${ctrl.mean.toFixed(3)} (${ctrl.n} px)`)
  }

  // ------------------------------------------------------------ 3. live: the halo in the dark
  // A cave-wall spot on the map: ground under air whose halo centre is on the `back` field. Looked at like §2's.
  const spot = await page.evaluate(() => {
    const c = window.__game.core
    for (let x = 100; x < c.width - 100; x += 8) {
      for (let y = 100; y < c.height - 10; y += 2) {
        if (!c.solidAt(x, y) || c.solidAt(x, y - 2) || c.solidAt(x, y - 42) || !window.__world.backAt(x, y - 42)) continue
        return { x, y }
      }
    }
    return null
  })
  if (!spot) {
    problems.push('halo: no cave-wall spot on the map to stand a figure on (seed 4242)')
  } else {
    await page.evaluate(([x, y]) => { window.__game.freeze(false); window.__game.watch(x, y) }, [spot.x, spot.y - 40])
    await page.evaluate(() => new Promise((r) => { let i = 0; const f = () => (++i >= 30 ? r() : requestAnimationFrame(f)); requestAnimationFrame(f) }))
    await page.evaluate(() => window.__game.freeze(true))
    const dark = { ...stick, ...spot, lit: { ...stick.lit, darkHalo: DARK_HALO } }
    const plain = { ...stick, ...spot }
    const hc = { x: spot.x, y: spot.y - 14 * K }
    const ring = (x, y) => { const r = Math.hypot(x - hc.x, y - hc.y); return r > 16 * K && r < 28 * K }
    const withH = await frameWith(page, [dark], held)
    const without = await frameWith(page, [plain], held)
    const gain = mean(withH, ring, (o) => luma(withH.data, o) - luma(without.data, o))
    log(`3. dark halo at the cave-wall spot (${spot.x}, ${spot.y}): ring luminance +${gain.mean.toFixed(2)} (${gain.n} px, min ${HALO_MIN})`)
    if (!(gain.mean >= HALO_MIN)) problems.push(`halo: the ring gains only ${gain.mean.toFixed(2)} (min ${HALO_MIN})`)
    await frameWith(page, [dark], held)
    await shot('rim-light-halo')
  }
  await page.evaluate(() => {
    window.__world.setActors(null)
    window.__game.freeze(false)
  })
  await page.evaluate(() => window.__game.setHighQuality(false))
  if (problems.length) throw new Error(`rim-light: ${problems.join('; ')}`)
}
