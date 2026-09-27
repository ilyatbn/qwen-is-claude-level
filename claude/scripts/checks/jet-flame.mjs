/**
 * `jet-flame` — T23.14B: the jetpack's flame matches the reference pictures, and it is a light.
 *
 * ## 1. Level A on the flame boxes (gating)
 *
 * The look-lab draws the reference scenes' flames through the game's own code: F4's jet stick (`draw.ts::stick`,
 * `jet: true`) and F7's `jet` and `space` figures (`figure.ts`, `J.jet`). Over the actor boxes of exactly those
 * actors, `deltaE_actors` of the lab against the mockup's cast-only reference (`F4-cast.png`, `F7-poses.png`) is
 * within this back end's actor threshold (R25, T23.12), in the reference harness's browser (`actor-atlas` §1 says
 * why). **Must fail:** `&knob=actor-jet-off` (every flame out) against the same reference, on the same boxes — so the
 * boxes are ones the flame decides. The glow (`actors/glow.ts`, F1's fx sprite) is not in these references (their
 * `castonly.js`/`posesonly.js` draw no fx) and is looked at in the shots instead.
 *
 * ## 2. The flame lights the rock near it (the sandbox, standard gravity)
 *
 * A real burn low over rock, frozen once the jet light is in the list the scene handed the renderer. **Both ends:**
 * that light sits where the view says its flame is (`debug().flame.at`). The frozen frame is read as drawn and with
 * the flame planted off — `showThrusters(false)` (flame and glow) and its light taken out of the renderer's list,
 * nothing else — on the world canvas: rock within `NEAR_FRAC` of the light's radius, outside the figure's own box,
 * gains `NEAR_MIN` mean luminance; rock beyond the radius (+ `FAR_MARGIN`, the control region) does not move.
 */
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { readFileSync } from 'node:fs'
import { boxesDeltaE, loadPng, thresholdsFor } from '../lib/look-compare.mjs'
import { HIGH_QUALITY_KEY } from '../lib/check-tier.mjs'
import { chromePath, libDir } from '../lib/browser-args.mjs'
import { REFERENCE_ARGS } from './actor-atlas.mjs'
import { decode } from './figure-frames.mjs'

const root = join(dirname(fileURLToPath(import.meta.url)), '../..')
const require = createRequire(join(root, 'client/package.json'))
const { chromium } = require('playwright-core')
const RAW = JSON.parse(readFileSync(join(root, 'scripts/lib/look-thresholds.json'), 'utf8'))

/** The scenes whose flames have a cast-only reference, and that reference. */
const LEVEL_A = [
  ['F4', 'tasks/M23/reference/controls/F4-cast.png'],
  ['F7', 'tasks/M23/reference/controls/F7-poses.png'],
]
/** F4 has one jet stick; F7 its `jet` and `space` figures (counted against the scene data, `scenes/F4.ts`/`F7.ts`). */
const FLAME_ACTORS = { F4: 1, F7: 2 }
/** Rock within this fraction of the jet light's radius is "near" (falloff (1 − d/r)², `effect-lights`'s value). */
const NEAR_FRAC = 0.6
/** The near rock must gain this much mean luminance (0–255): `effect-lights`'s floor for every effect. */
const NEAR_MIN = 4
/** Control region: rock this far beyond the light's radius (world px); its largest channel change allowed. */
const FAR_MARGIN = 120
const FAR_MAX = 3
/** Rock pixels a region needs before its number means anything. */
const MIN_ROCK = 150
/** The burn: placed this far above the ground, and the light's near disc searched this far above it for rock. */
const HOVER = 20
const RISE = 60

const luma = (d, o) => 0.2126 * d[o] + 0.7152 * d[o + 1] + 0.0722 * d[o + 2]

async function lab(page, origin, id, knob) {
  await page.goto(`${origin}/?look=${id}&e2e=1${knob ? `&knob=${knob}` : ''}`, { waitUntil: 'load' })
  await page.waitForFunction(() => window.__look && (window.__look.ready || window.__look.error) && !!window.__world, null, { timeout: 120_000 })
  const err = await page.evaluate(() => window.__look.error)
  if (err) throw new Error(`look-lab ${id}: ${err}`)
  return { frame: decode(await page.evaluate(() => window.__world.readFrame())), info: await page.evaluate(() => window.__world.info()) }
}

export default async function ({ page, shot, log }) {
  const origin = new URL(page.url()).origin
  const problems = []

  // ------------------------------------------------------------ 1. Level A on the flame boxes
  const browser = await chromium.launch({ executablePath: chromePath, env: { ...process.env, LD_LIBRARY_PATH: libDir }, headless: true, args: REFERENCE_ARGS })
  try {
    const own = await browser.newPage({ viewport: { width: 1280, height: 720 }, deviceScaleFactor: 1 })
    await own.goto(`${origin}/?e2e=1`, { waitUntil: 'load' })
    await own.evaluate((k) => localStorage.setItem(k, '1'), HIGH_QUALITY_KEY)
    for (const [id, refPath] of LEVEL_A) {
      const boxes = await own.evaluate(async (id) => {
        const { SCENES } = await import('/src/look/scenes/index.ts')
        return SCENES[id].actors.filter((a) => a.box && ((a.kind === 'figure' && a.opts.J?.jet) || (a.kind === 'stick' && a.opts.jet))).map((a) => a.box)
      }, id)
      if (boxes.length !== FLAME_ACTORS[id]) problems.push(`${id}: ${boxes.length} flame actors in the scene data, want ${FLAME_ACTORS[id]}`)
      const ref = loadPng(join(root, refPath))
      const on = await lab(own, origin, id, '')
      const T = thresholdsFor(RAW, on.info.gpu)
      if (T.backEnd !== 'swiftshader') throw new Error(`the flame references are SwiftShader's; this is ${T.backEnd}`)
      const d = boxesDeltaE(on.frame, ref, boxes)
      const off = await lab(own, origin, id, 'actor-jet-off')
      const dOff = boxesDeltaE(off.frame, ref, boxes)
      log(`1. ${id} flame boxes ${JSON.stringify(boxes)}: deltaE_actors ${d.toFixed(4)} (max ${T.actors.threshold}) ${d <= T.actors.threshold ? 'ok' : 'FAIL'}; control actor-jet-off ${dOff.toFixed(4)} ${dOff > T.actors.threshold ? 'fails, as it must' : 'PASSES — the boxes cannot see the flame'}`)
      for (const b of boxes) log(`   box ${JSON.stringify(b)}: ${boxesDeltaE(on.frame, ref, [b]).toFixed(4)} (jet off ${boxesDeltaE(off.frame, ref, [b]).toFixed(4)})`)
      if (!(d <= T.actors.threshold)) problems.push(`${id}: Level A on the flame boxes ${d.toFixed(4)} > ${T.actors.threshold}`)
      if (!(dOff > T.actors.threshold)) problems.push(`${id}: control actor-jet-off passed (${dOff.toFixed(4)})`)
    }
  } finally {
    await browser.close()
  }

  // ------------------------------------------------------------ 2. the flame lights the rock near it
  await page.waitForFunction(() => window.__game && window.__world && window.__world.litTerrain()?.drawn, null, { timeout: 120_000 })
  await page.evaluate(() => window.__game.setZoom(1))
  const me = await page.evaluate(() => window.__game.debug().player)
  const r = await page.evaluate(async () => (await import('/src/look/effectLights.ts')).JET_PLUME_LIGHT.r)
  const pick = await page.evaluate(([x0, rise, rr]) => {
    const c = window.__game.core
    let best = null
    for (let x = Math.round(x0) - 400; x <= x0 + 400; x += 16) {
      let gy = null
      for (let y = 40; y < c.height - 2; y++) {
        if (!c.solidAt(x, y) || c.solidAt(x, y - 1)) continue
        let air = true
        for (let k = 2; k < 90 && air; k += 4) air = !c.solidAt(x, y - k)
        if (air) {
          gy = y
          break
        }
      }
      if (gy === null) continue
      let n = 0
      for (let dy = -rr; dy <= rr; dy += 2) for (let dx = -rr; dx <= rr; dx += 2) if (dx * dx + dy * dy <= rr * rr && c.solidAt(x + dx, gy - rise + dy)) n++
      if (!best || n > best.n) best = { x, gy, n }
    }
    return best
  }, [me.x, RISE, Math.round(r * NEAR_FRAC)])
  if (!pick) throw new Error('no rock to burn over')
  await page.evaluate(([x, y]) => {
    window.__game.place(x, y)
    window.__game.watch(x, y)
  }, [pick.x, pick.gy - HOVER])
  await page.keyboard.down('Space')
  const light = await page.evaluate(async () => {
    const raf = () => new Promise((res) => requestAnimationFrame(res))
    const t0 = performance.now()
    while (performance.now() - t0 < 6000) {
      await raf()
      if (window.__game.effectLights().some((l) => l.kind === 'jet')) {
        await raf()
        window.__game.freeze(true)
        await raf()
        return window.__game.effectLights().find((l) => l.kind === 'jet') ?? null
      }
    }
    return null
  })
  await page.keyboard.up('Space')
  try {
    if (!light) throw new Error('no jet light reached the list while burning')
    const d = await page.evaluate(() => window.__game.debug())
    const at = d.flame?.at
    log(`2. burn over rock at x ${pick.x} (ground ${pick.gy}); jet light (${light.x.toFixed(1)}, ${light.y.toFixed(1)}) r ${light.r}; the view's flame ${JSON.stringify(at)}`)
    if (!at || Math.hypot(at.x - light.x, at.y - light.y) > 0.01) problems.push(`the jet light is not at the flame: light (${light.x}, ${light.y}), flame ${JSON.stringify(at)}`)
    const fig = d.figure
    const held = await page.evaluate(() => window.__world.lights())
    const rest = held.filter((l) => !(l.x === light.x && l.y === light.y && l.r === light.r))
    if (rest.length !== held.length - 1) throw new Error(`the jet light is not in the renderer's list once: ${JSON.stringify(held)}`)
    const on = decode(await page.evaluate(() => window.__world.readFrame()))
    await shot('jet-flame-rock-on')
    await page.evaluate((l) => {
      window.__game.showThrusters(false)
      window.__world.setLights(l)
    }, rest)
    const off = decode(await page.evaluate(() => window.__world.readFrame()))
    await shot('jet-flame-rock-off')
    await page.evaluate((l) => {
      window.__game.showThrusters(true)
      window.__world.setLights(l)
    }, held)
    if (JSON.stringify(on.view) !== JSON.stringify(off.view)) throw new Error('the camera moved between the two reads')
    const rock = await page.evaluate(([v, w, h]) => {
      const c = window.__game.core
      const k = w / v.w
      let s = ''
      for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) s += c.solidAt(Math.floor(v.x + (x + 0.5) / k), Math.floor(v.y + (y + 0.5) / k)) ? '1' : '0'
      return s
    }, [on.view, on.width, on.height])
    // The figure's own cell (and its glow, `JET_GLOW.size` wide at most twice over) is not rock light: left out.
    const s = fig.opts.s
    const self = [fig.x - 30 * s, fig.y - 40 * s, fig.x + 30 * s, fig.y + 25 * s]
    const k = on.width / on.view.w
    const near = { n: 0, gain: 0 }
    const far = { n: 0, max: 0 }
    for (let y = 0; y < on.height; y++) {
      for (let x = 0; x < on.width; x++) {
        if (rock[y * on.width + x] !== '1') continue
        const wx = on.view.x + (x + 0.5) / k
        const wy = on.view.y + (y + 0.5) / k
        if (wx >= self[0] && wx < self[2] && wy >= self[1] && wy < self[3]) continue
        const dd = Math.hypot(wx - light.x, wy - light.y)
        const o = (y * on.width + x) * 4
        if (dd < light.r * NEAR_FRAC) {
          near.n++
          near.gain += luma(on.data, o) - luma(off.data, o)
        } else if (dd > light.r + FAR_MARGIN) {
          far.n++
          for (let c = 0; c < 3; c++) far.max = Math.max(far.max, Math.abs(on.data[o + c] - off.data[o + c]))
        }
      }
    }
    near.gain = near.n ? near.gain / near.n : 0
    log(`2. rock near the flame: ${near.n} px, mean luminance +${near.gain.toFixed(2)} with the flame (min ${NEAR_MIN}); control, rock beyond its reach: ${far.n} px, max channel change ${far.max} (max ${FAR_MAX})`)
    if (near.n < MIN_ROCK) problems.push(`only ${near.n} rock px near the flame (min ${MIN_ROCK})`)
    else if (!(near.gain >= NEAR_MIN)) problems.push(`the rock near the flame gains only ${near.gain.toFixed(2)} (min ${NEAR_MIN}): the flame does not light it`)
    if (far.n < MIN_ROCK) problems.push(`control: only ${far.n} rock px beyond the flame's light (min ${MIN_ROCK})`)
    else if (far.max > FAR_MAX) problems.push(`control: rock beyond the flame's light changed by ${far.max} (max ${FAR_MAX})`)
  } finally {
    await page.evaluate(() => {
      window.__game.freeze(false)
      window.__game.watch(null)
    })
  }
  if (problems.length) throw new Error(`jet-flame:\n  - ${problems.join('\n  - ')}`)
}
