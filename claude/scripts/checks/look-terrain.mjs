/**
 * `look-terrain` — T23.07: the lit terrain (`client/src/look/terrainMaterial.ts`, the port of
 * `mockup-src/kit.js::terrainMaterial`), at Level A against the mockup and live.
 *
 * ## 1. Level A, full tier: the look-lab's F1 sky + terrain against the mockup's sky + terrain
 *
 * `?look=F1&only=world` describes F1 with its actors, fx, labels and HUD taken out of the data, so the
 * world renderer draws its sky and its lit terrain — F1's masks through the Rust fields, the GPU albedo,
 * F1's terrain look and its ten point lights — alone. The reference is the mockup drawing the same
 * thing: `reference/controls/terrainonly.js` (`f_kit.js::frame` less fog, actors, fx, foreground,
 * bloom and grade; the lights computed by `f_scene.js`'s own lines) → `controls/F1-terrain.png`,
 * rendered twice byte-identical (floor 0). **Full tier** (the pictures' 1280×720, 4× MSAA): the check
 * stores it (`'1'`) and asserts the tier, buffer, MSAA, the full material and the ten lights it got.
 * Every `look-thresholds.json` metric must sit within its threshold; every value is printed beside it.
 *
 * **Must-fail controls** (the lab with one knob turned, `&knob=`): the terrain's rim off (`rimK` 0) and
 * its bevel off (`bevel` 0.001: flat) must each fail — a comparison that passes them cannot see the two
 * things that make the rock 3D. The same knobs rendered by the mockup fail 6 metrics each against the
 * reference (measured when the reference was made: T23.07's journal). Presence: the sky alone
 * (`only=sky`, no terrain) must fail too.
 *
 * ## 2. The low tier: the bake draws the full tier's picture
 *
 * R14's low tier bakes the normal and both shadows (`BAKE_FS`) and shades per frame from the bake
 * (`LOW_FS`). At the low tier (640×360, no MSAA — the checks' tier) the lab frame drawn with the low
 * material is compared with the same frame drawn with the full material (`__world.forceTerrainMaterial`)
 * on the same buffer: they may differ only by the bake's 8-bit quantisation (`LOW_MAX_MEAN`,
 * `LOW_MAX_P999`). Control: the low material must really have drawn (`litTerrain().material`), and the
 * low frame is also compared at Level A with the reference (reported, not gating: 640×360 CSS-scaled is
 * not the pictures' resolution — look-sky's reason).
 *
 * ## 3. Live, in the sandbox (low tier): Phaser's rock hidden only when ready; a crater lit at once
 *
 * **Never absent.** From the page load, every frame until the terrain is ready and a few after:
 * `debug().rockVisible` (Phaser's flat rock) and `terrainReady` (the lit terrain draws the rock). No
 * frame may have neither; the control is presence — frames before ready must exist and show Phaser's
 * rock (Medium at the low tier takes seconds), and after ready Phaser's rock must be hidden.
 *
 * **A crater, lit in the frame it is carved.** The camera is pinned (`watch`) on a surface; the frame
 * before, then `carve` between two frames, then the **next drawn frame** (`readNextFrame`, nothing
 * forced) with Phaser's frame counter: it must be the very next frame (`CARVE_FRAMES`), the terrain
 * must have repainted in it, and it must equal — `CRATER_MAX_DIFF` — a from-scratch repaint
 * of every field, albedo tile and bake tile at the same view (`repaintAlbedo`) — i.e. the carve's
 * incremental update is the whole lit, bevelled picture of the new mask, not a later frame's — over the
 * whole frame, not only the crater's box (the shadow march reads 53 px away). Control
 * (presence): the crater box differs from the frame before the carve.
 */
import { writeFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'
import { actorBoxes, compare, failures, loadPng, withActors } from '../lib/look-compare.mjs'
import { HIGH_QUALITY_KEY } from '../lib/check-tier.mjs'

const root = join(dirname(fileURLToPath(import.meta.url)), '../..')
const { PNG } = createRequire(join(root, 'client/package.json'))('pngjs')
const ref = (p) => join(root, 'tasks/M23/reference', p)
const TH = JSON.parse((await import('node:fs')).readFileSync(join(root, 'scripts/lib/look-thresholds.json'), 'utf8'))

/**
 * The low material against the full one on the same buffer, per channel byte: the mean |Δ| over the
 * terrain's pixels and the 99.9th percentile. The bake stores the normal's x, y and both shadows in
 * 8 bits (steps of 1/127 in the normal); measured on first build: see T23.07's journal.
 */
const LOW_MAX_MEAN = 0.5
const LOW_MAX_P999 = 12

/** Phaser frames from the carve to the first world frame that shows it: the very next one. */
const CARVE_FRAMES = 1
/** Max channel difference, crater box, incremental vs a from-scratch repaint (the same shader on the same inputs). */
const CRATER_MAX_DIFF = 2
/** The crater's radius, world px, and how far under the surface its centre is. */
const CRATER_R = 40
const CRATER_DEPTH = 20

const decode = (f) => ({ width: f.w, height: f.h, data: Uint8Array.from(Buffer.from(f.rgba, 'base64')), view: f.view })

async function lab(page, extra) {
  const base = new URL(page.url())
  base.search = `?look=F1${extra}`
  await page.goto(base.href, { waitUntil: 'load' })
  await page.waitForFunction(() => window.__look && (window.__look.ready || window.__look.error) && !!window.__world, null, { timeout: 120_000 })
  const look = await page.evaluate(() => window.__look)
  if (look.error) throw new Error(`look-lab F1${extra}: ${look.error}`)
  const frame = decode(await page.evaluate(() => window.__world.readFrame()))
  const info = await page.evaluate(() => ({ info: window.__world.info(), lit: window.__world.litTerrain(), terrain: window.__world.terrain() }))
  return { look, frame, ...info }
}

/** Metric table, printed: every value against its threshold; returns the failing metrics. */
function table(log, name, m) {
  const bad = failures(m, TH)
  for (const [k, t] of Object.entries(TH.metrics)) {
    log(`  ${name} ${k.padEnd(15)} ${m[k].toFixed(5).padStart(10)}  max ${String(t.threshold).padEnd(9)} ${bad.includes(k) ? 'FAIL' : 'ok'}`)
  }
  return bad
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
  const problems = []
  const regions = withActors(loadPng(ref('controls/regions-F1.png')), actorBoxes('F1'))
  const reference = loadPng(ref('controls/F1-terrain.png'))

  // ---------------------------------------------------------------- 1. Level A, full tier
  await page.evaluate((k) => localStorage.setItem(k, '1'), HIGH_QUALITY_KEY)
  const full = await lab(page, '&only=world')
  const i = full.info
  if (i.tier !== 'full' || i.buffer[0] !== 1280 || i.buffer[1] !== 720 || i.samples !== 4) {
    throw new Error(`want the full tier (1280x720, MSAA 4), got ${JSON.stringify(i)}`)
  }
  if (!full.lit?.drawn || full.lit.material !== 'full' || full.lit.lights !== 10) {
    throw new Error(`want the lit terrain drawn with the full material and F1's 10 lights, got ${JSON.stringify(full.lit)} (terrain ${JSON.stringify(full.terrain)})`)
  }
  if (full.look.described.actors !== 0) throw new Error(`only=world still describes ${full.look.described.actors} actors`)
  await shot('look-terrain-F1')
  const m = compare(full.frame, reference, { regions })
  log(`Level A — look-lab F1 sky + lit terrain vs reference/controls/F1-terrain.png (full tier, ${Object.keys(TH.metrics).length} metrics):`)
  const bad = table(log, 'F1', m)
  if (bad.length) problems.push(`F1 terrain outside its thresholds: ${bad.join(', ')}`)
  sideBySide(full.frame, reference, 'look-terrain-F1-vs-reference.png')
  log('side by side (lab | mockup): shots/look-terrain-F1-vs-reference.png')
  // Reported: against the whole F1 picture (its fog, bloom, grade are T23.08's; actors T23.12+).
  const whole = compare(full.frame, loadPng(ref('F1-night-combat.png')), { regions })
  log(`reported, not gating: vs the F1 picture deltaE_terrain ${whole.deltaE_terrain.toFixed(3)}, deltaE_cave ${whole.deltaE_cave.toFixed(3)} (fog, bloom, grade: T23.08)`)

  // Must-fail: the rim off, the bevel off; presence: no terrain at all.
  for (const [knob, extra] of [['rim-off', '&only=world&knob=rim-off'], ['bevel-off', '&only=world&knob=bevel-off'], ['no terrain', '&only=sky']]) {
    const c = await lab(page, extra)
    const cm = compare(c.frame, reference, { regions })
    const cbad = failures(cm, TH)
    log(`control ${knob}: fails ${cbad.length}/${Object.keys(TH.metrics).length} (${cbad.join(', ') || 'none'}); deltaE_terrain ${cm.deltaE_terrain.toFixed(3)}, dssim ${cm.dssim.toFixed(4)}`)
    if (!cbad.length) problems.push(`control ${knob} passes every threshold — the comparison cannot see it`)
  }

  // ---------------------------------------------------------------- 2. the low tier's bake
  await page.evaluate((k) => localStorage.setItem(k, '0'), HIGH_QUALITY_KEY)
  const low = await lab(page, '&only=world')
  if (low.info.tier !== 'low') problems.push(`the low half runs ${low.info.tier}`)
  if (low.lit?.material !== 'low' || !(low.terrain?.bakes > 0)) problems.push(`the low tier drew with ${JSON.stringify(low.lit)}, bakes ${low.terrain?.bakes} — want the baked material`)
  await shot('look-terrain-F1-low')
  await page.evaluate(() => window.__world.forceTerrainMaterial('full'))
  const lowFull = decode(await page.evaluate(() => window.__world.readFrame()))
  const forced = await page.evaluate(() => window.__world.litTerrain())
  await page.evaluate(() => window.__world.forceTerrainMaterial(null))
  if (forced?.material !== 'full') problems.push(`forcing the full material drew ${JSON.stringify(forced)}`)
  const diffs = []
  let changed = 0
  for (let k = 0; k < low.frame.data.length; k += 4) {
    const d = Math.max(Math.abs(low.frame.data[k] - lowFull.data[k]), Math.abs(low.frame.data[k + 1] - lowFull.data[k + 1]), Math.abs(low.frame.data[k + 2] - lowFull.data[k + 2]))
    diffs.push(d)
    if (d) changed++
  }
  diffs.sort((a, b) => a - b)
  const mean = diffs.reduce((a, b) => a + b, 0) / diffs.length
  const p999 = diffs[Math.floor(diffs.length * 0.999)]
  log(`low tier: baked vs unbaked on one ${low.frame.width}x${low.frame.height} buffer — mean |Δ| ${mean.toFixed(3)} (max ${LOW_MAX_MEAN}), p99.9 ${p999} (max ${LOW_MAX_P999}), max ${diffs[diffs.length - 1]}, ${changed} px differ`)
  if (!(mean <= LOW_MAX_MEAN) || !(p999 <= LOW_MAX_P999)) problems.push(`the low tier's bake differs from the full shader: mean ${mean.toFixed(3)}, p99.9 ${p999}`)
  const scaled = new PNG({ width: 1280, height: 720 })
  for (let y = 0; y < 720; y++) {
    for (let x = 0; x < 1280; x++) {
      const s = ((y >> 1) * low.frame.width + (x >> 1)) * 4
      const o = (y * 1280 + x) * 4
      for (let c = 0; c < 4; c++) scaled.data[o + c] = low.frame.data[s + c]
    }
  }
  const lm = compare(scaled, reference, { regions })
  log(`reported, not gating: the low tier (640x360, doubled) vs the reference — deltaE_terrain ${lm.deltaE_terrain.toFixed(3)}, dssim ${lm.dssim.toFixed(4)}, fails ${failures(lm, TH).length}`)
  sideBySide(scaled, reference, 'look-terrain-F1-low-vs-reference.png')

  // ---------------------------------------------------------------- 3. live
  const base = new URL(page.url())
  base.search = '?sandbox=1&seed=4242'
  await page.goto(base.href, { waitUntil: 'load' })
  await page.waitForFunction(() => !!window.__game && !!window.__world, null, { timeout: 60_000 })
  // Every frame from here until ready + 10: (ready, rock visible).
  const swap = await page.evaluate(
    () =>
      new Promise((resolve) => {
        const s = []
        let after = 0
        const t0 = performance.now()
        const tick = () => {
          const d = window.__game.debug()
          s.push([d.terrainReady ? 1 : 0, d.rockVisible ? 1 : 0])
          if (d.terrainReady) after++
          if (after > 10 || performance.now() - t0 > 90_000) resolve(s)
          else requestAnimationFrame(tick)
        }
        tick()
      }),
  )
  const absent = swap.filter(([r, v]) => !r && !v).length
  const before = swap.filter(([r]) => !r).length
  const beforeShown = swap.filter(([r, v]) => !r && v).length
  const lastHidden = swap.slice(-5).every(([r, v]) => r && !v)
  log(`swap: ${swap.length} frames sampled, ${before} before ready (Phaser's rock shown on ${beforeShown}), frames with no rock drawn ${absent}; hidden after ready ${lastHidden}`)
  if (absent) problems.push(`${absent} frame(s) had neither Phaser's rock nor the lit terrain`)
  if (!(before > 0 && beforeShown === before)) problems.push(`control: want frames before ready, each showing Phaser's rock (${beforeShown}/${before})`)
  if (!lastHidden) problems.push(`Phaser's rock is not hidden once the lit terrain is ready: ${JSON.stringify(swap.slice(-5))}`)
  const lit = await page.evaluate(() => window.__world.litTerrain())
  if (!lit?.drawn) problems.push(`the lit terrain is not drawn once ready: ${JSON.stringify(lit)}`)
  await shot('look-terrain-sandbox')

  // A surface near the map's middle, the camera pinned on it.
  const site = await page.evaluate(([depth]) => {
    const g = window.__game
    const d = g.debug()
    for (let k = 0; k < 40; k++) {
      const x = Math.round(d.mapW / 2 + (k % 2 ? -1 : 1) * Math.ceil(k / 2) * 97)
      for (let y = 40; y < d.mapH - 80; y++) {
        if (g.core.solidAt(x, y)) {
          let deep = true
          for (let yy = y; yy < y + 3 * depth; yy++) if (!g.core.solidAt(x, yy)) deep = false
          if (deep) return { x, y }
          break
        }
      }
    }
    return null
  }, [CRATER_DEPTH])
  if (!site) throw new Error('no surface with solid rock under it found to carve')
  const cx = site.x
  const cy = site.y + CRATER_DEPTH
  await page.evaluate(([x, y]) => window.__game.watch(x, y), [cx, cy - 60])
  await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => requestAnimationFrame(r)))))
  const pre = decode(await page.evaluate(() => window.__world.readFrame()))
  const t0 = await page.evaluate(() => window.__world.terrain())
  const carved = await page.evaluate(
    ([x, y, r]) => {
      const next = window.__world.readNextFrame()
      const at = window.__world.loopFrame()
      window.__game.carve(x, y, r)
      // A frame that never draws (the carve did not mark the picture changed) is the failure, not a hang.
      const timeout = new Promise((r) => setTimeout(() => r(null), 5000))
      return Promise.race([next, timeout]).then((f) => ({ f, at }))
    },
    [cx, cy, CRATER_R],
  )
  const t1 = await page.evaluate(() => window.__world.terrain())
  if (!carved.f) throw new Error(`look-terrain:\n  - ${[...problems, 'the world canvas drew no frame within 5 s of the carve (the carve did not reach the picture)'].join('\n  - ')}`)
  const inc = decode(carved.f)
  await page.evaluate(() => window.__world.repaintAlbedo())
  const scratch = decode(await page.evaluate(() => window.__world.readFrame()))
  const views = [pre.view, inc.view, scratch.view].map((v) => JSON.stringify(v))
  if (new Set(views).size !== 1) problems.push(`the camera moved between the crater's frames: ${views.join(' ')}`)
  // The crater's box in buffer px (grown by the bevel), from the view it was drawn with.
  const k = inc.width / inc.view.w
  const box = {
    x0: Math.max(0, Math.floor((cx - CRATER_R - 16 - inc.view.x) * k)),
    y0: Math.max(0, Math.floor((cy - CRATER_R - 16 - inc.view.y) * k)),
    x1: Math.min(inc.width, Math.ceil((cx + CRATER_R + 16 - inc.view.x) * k)),
    y1: Math.min(inc.height, Math.ceil((cy + CRATER_R + 16 - inc.view.y) * k)),
  }
  // The incremental picture against the from-scratch one over the **whole** frame: a carve changes the
  // fields `render_fields.rs`'s margin away, and the shading reads them `BAKE_REACH` further (the
  // shadow march) — a rect that stopped short would leave stale texels outside the crater's own box.
  let worst = 0
  let stale = 0
  for (let o = 0; o < inc.data.length; o += 4) {
    let d = 0
    for (let c = 0; c < 3; c++) d = Math.max(d, Math.abs(inc.data[o + c] - scratch.data[o + c]))
    worst = Math.max(worst, d)
    if (d > CRATER_MAX_DIFF) stale++
  }
  let moved = 0
  let n = 0
  for (let y = box.y0; y < box.y1; y++) {
    for (let x = box.x0; x < box.x1; x++) {
      const o = (y * inc.width + x) * 4
      n++
      let dp = 0
      for (let c = 0; c < 3; c++) dp = Math.max(dp, Math.abs(inc.data[o + c] - pre.data[o + c]))
      if (dp > 8) moved++
    }
  }
  // Phaser's TimeStep counts a frame **after** its step (update, render, postrender): read in the step
  // that drew it, the counter still says the frame before — so the step the crater first shows in is
  // `readback − carve + 1`, and 1 is the very next step after the carve.
  const framesToShow = carved.f.loopFrame - (carved.at ?? NaN) + 1
  log(`crater r ${CRATER_R} at (${cx}, ${cy}): shown ${framesToShow} Phaser frame(s) after the carve (want ${CARVE_FRAMES}); terrain repaints ${t0.dirtyPaints} → ${t1.dirtyPaints}, bakes ${t0.bakes} → ${t1.bakes}; crater box ${box.x1 - box.x0}x${box.y1 - box.y0} buffer px: the whole frame vs a from-scratch repaint max |Δ| ${worst} (max ${CRATER_MAX_DIFF}), ${stale} px over; the box vs the frame before ${moved}/${n} px moved`)
  if (framesToShow !== CARVE_FRAMES) problems.push(`the crater was first drawn ${framesToShow} frames after the carve, want ${CARVE_FRAMES}`)
  if (!(t1.dirtyPaints > t0.dirtyPaints) || !(t1.bakes > t0.bakes)) problems.push(`the carve's frame repainted nothing (repaints ${t0.dirtyPaints} → ${t1.dirtyPaints}, bakes ${t0.bakes} → ${t1.bakes})`)
  if (worst > CRATER_MAX_DIFF) problems.push(`the crater's first frame differs from a from-scratch repaint by ${worst} on ${stale} px`)
  if (moved < n * 0.2) problems.push(`control: the crater moved only ${moved}/${n} px of its box against the frame before`)
  const png = new PNG({ width: (box.x1 - box.x0) * 3 + 16, height: box.y1 - box.y0 })
  png.data.fill(255)
  for (let y = box.y0; y < box.y1; y++) {
    for (const [img, x0] of [[pre, 0], [inc, box.x1 - box.x0 + 8], [scratch, 2 * (box.x1 - box.x0) + 16]]) {
      for (let x = box.x0; x < box.x1; x++) {
        const o = (y * img.width + x) * 4
        const q = ((y - box.y0) * png.width + x0 + x - box.x0) * 4
        for (let c = 0; c < 3; c++) png.data[q + c] = img.data[o + c]
        png.data[q + 3] = 255
      }
    }
  }
  writeFileSync(join(root, 'shots', 'look-terrain-crater.png'), PNG.sync.write(png))
  log('crater (before | its first frame | from-scratch repaint): shots/look-terrain-crater.png')
  await shot('look-terrain-sandbox-crater')

  if (problems.length) throw new Error(`look-terrain:\n  - ${problems.join('\n  - ')}`)
}
