/**
 * `look-terrain` — T23.07: the lit terrain (`client/src/look/terrainMaterial.ts`, the port of
 * `mockup-src/kit.js::terrainMaterial`), at Level A against the mockup and live.
 *
 * ## 1. Level A, full tier: the look-lab's F1 sky + terrain against the mockup's sky + terrain
 *
 * `?look=F1&only=terrain` describes F1 with its actors, fx, labels and HUD taken out of the data, so the
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
 * **And in pixels (T23.07B F5):** the camera is pinned on deep rock from the page's first moment, and
 * the page (both canvases composited — what a player sees) is screenshotted there over and over across
 * the swap; every screenshot must differ (`SWAP_ROCK` of its px by > `PIXEL_MOVED`) from the same patch
 * with the lit terrain hidden after ready — the sky behind the rock, i.e. the absent picture. Control:
 * screenshots on both sides of the swap.
 *
 * **A crater, lit in the frame it is carved** — on `CRATER_SEEDS` (F6: ≥ 3 maps). The camera is pinned
 * (`watch`) on a surface; the frame before, then `carve` between two frames, then the **next drawn
 * frame** (`readNextFrame`, nothing forced) with Phaser's frame counter: it must be the very next frame
 * (`CARVE_FRAMES`), the terrain must have repainted in it, and it must equal — `CRATER_MAX_DIFF` — the
 * control repaint at the same view (`repaintAlbedo`: every field strip **re-uploaded from the Rust
 * buffer as the carve left it**, then every albedo and bake tile repainted from it; T23.07B F5 — it is
 * not a recomputation of the fields, whose incremental == full is `render_fields.rs`'s own test). So it
 * proves the GPU side's incremental repaint (rects, `ALBEDO_REACH`, `BAKE_REACH`) is the whole lit,
 * bevelled picture of the uploaded fields in the very next frame — over the whole frame, not only the
 * crater's box (the shadow march reads 53 px away). Control (presence): the crater box differs from
 * the frame before the carve.
 *
 * ## 4. The cave wall against open sky — see `wallEdges`.
 */
import { writeFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'
import { actorBoxes, compare, failures, loadPng, thresholdsFor, withActors } from '../lib/look-compare.mjs'
import { HIGH_QUALITY_KEY } from '../lib/check-tier.mjs'
import { toScreen, PIXEL_MOVED } from './pixels.mjs'

const root = join(dirname(fileURLToPath(import.meta.url)), '../..')
const { PNG } = createRequire(join(root, 'client/package.json'))('pngjs')
const ref = (p) => join(root, 'tasks/M23/reference', p)
const RAW = JSON.parse((await import('node:fs')).readFileSync(join(root, 'scripts/lib/look-thresholds.json'), 'utf8'))
/** R25 (T23.08C): the threshold set for this page's renderer, from the first lab frame (`look-compare.mjs::thresholdsFor`). */
let TH = null

/**
 * The low material against the full one on the same buffer, per channel byte: the mean |Δ| over the
 * frame and the 99.9th percentile. The bake stores the normal's x, y and both shadows in 8 bits (steps
 * of 1/127 in the normal). **Measured (T23.07 and again T23.07B, F1 at 640×360, SwiftShader): mean
 * 0.088, p99.9 1, max 2, 20 139 px differ.** T23.07B F6: the bounds were 0.5 and 12 — picked, 6× and
 * 12× the measurement, loose enough to pass a bake that is wrong on a sizeable patch. Now ≈ 2× the mean
 * and the measured max as the p99.9: the quantisation's own size, with room for a GPU's rounding.
 */
const LOW_MAX_MEAN = 0.2
const LOW_MAX_P999 = 2

/** Phaser frames from the carve to the first world frame that shows it: the very next one. */
const CARVE_FRAMES = 1
/** Max channel difference, whole frame, incremental vs the control repaint (`repaintAlbedo`: the same shader on the same uploaded fields). */
const CRATER_MAX_DIFF = 2
/** The crater's radius, world px, and how far under the surface its centre is. */
const CRATER_R = 40
const CRATER_DEPTH = 20
/** F6 (T23.07B): the crater leg's seeds (V2 Medium) — the sandbox default and two of section 4's. */
const CRATER_SEEDS = [4242, 7, 11]
/** F5: the deep-rock patch photographed across the swap, CSS px, and the share of it that must differ from the sky behind it. */
const SWAP_PATCH = 16
const SWAP_ROCK = 0.9
/** …centred on a point with solid rock this many world px around it (the patch is ≤ 16 world px at any zoom ≥ 0.4). */
const SWAP_DEEP = 40

/** Section 4: V2 Medium seeds — the review's four, where the slabs were found (4242's longest boundary is 21 px: nothing to see). */
const WALL_EDGE_SEEDS = [4, 6, 9, 11]
/**
 * T23.07C: the slabs the review found — each seed's straight wall/sky boundaries as the fields drew them
 * **before the roof rule** (found by this check's own scan with `render_fields.rs::roofed` turned off, and
 * the review's 58 / 89 / 40 / 96). The rule makes them sky, so the fields' scan no longer finds them: they
 * are photographed here by position. Control: every px of each run and of its sky side is still air in the
 * mask — the geometry is there to be drawn; the rule is what does not draw it.
 */
/**
 * T23.07C (R24 final form): the hard runs over the bound that the rule keeps, by name — the site (a vertical
 * run at `x` overlapping rows `y0..y1`, or a horizontal one at `y` overlapping `x0..x1`) and the length measured there. Any run at that site may be at most
 * `measured + 2`; anywhere else the bound is `WALL_EDGE_MAX_RUN`, so the run growing or moving fails.
 * Seed 9's slab and the ledge above it lie inside the closing (their gaps to the rock are under 2R), so
 * they are hard wall with straight edges — 39 and 28 px, measured T23.07C; shown to the owner
 * (shots/t2307c-final-s9.png), not bounded away. T23.08C F7: the run photographed at a named site is the one
 * the fields' scan finds there now (the longest overlapping it), not these recorded coordinates — so a run
 * that grows past its recorded end is measured whole (planted: recorded 5 px short → red).
 */
const WALL_EDGE_EXCEPTIONS = [
  { seed: 9, dir: 'v', x: 861, y0: 638, y1: 678, measured: 39 },
  { seed: 9, dir: 'h', y: 336, x0: 695, x1: 723, measured: 28 },
]
/** R24 final form's closing radius, mirrored from `render_fields.rs::WALL_CLOSING_R` for the chamber guard. */
const WALL_CLOSING_R = 48
/**
 * The chamber guard's sites: where the closing alone drew sky circles underground (T23.07C) — a patch in each
 * of seeds 4 and 9, found as the first wall patch ≥ R + 4 px from rock under the final rule. Fixed, because
 * under the rule it guards against the patch is not wall and a search for wall would not find it.
 */
const CHAMBER_SITES = { 4: [88, 1344], 9: [720, 656] }
const CHAMBER_SEEDS = Object.keys(CHAMBER_SITES).map(Number)
/** The chamber patch, world px. */
const CHAMBER_PATCH = 8
const WALL_EDGE_KNOWN = {
  4: [{ dir: 'v', x: 2226, y0: 545, y1: 603, side: 1, len: 58 }],
  6: [{ dir: 'v', x: 2477, y0: 582, y1: 671, side: 1, len: 89 }, { dir: 'h', y: 405, x0: 2206, x1: 2221, side: -1, len: 15 }],
  9: [{ dir: 'v', x: 861, y0: 638, y1: 678, side: 1, len: 40 }, { dir: 'h', y: 336, x0: 695, x1: 723, side: -1, len: 28 }],
  11: [{ dir: 'v', x: 1294, y0: 763, y1: 859, side: 1, len: 96 }],
}
/** Boundary sites photographed per seed: the longest straight runs, at least this far apart (world px). */
const WALL_EDGE_SITES = 3
const WALL_EDGE_APART = 200
/** How far either side of the boundary a hard step is looked for, world px (past the ramp's width). */
const WALL_EDGE_WINDOW = 14
/**
 * A luminance step between adjacent non-solid px above this is a hard edge. Measured (T23.07B, both
 * tiers): the bit `back`'s wall/sky edges step 28–59 at the median along each run and over 12 on every
 * row of all four seeds' runs (drawn hard = the whole boundary); the ramp's steps have medians 6–12.
 */
const WALL_EDGE_STEP = 12
/**
 * A straight hard wall/sky edge must be shorter than this, world px. Measured (T23.07B): the bit `back`
 * draws 58 / 89 / 40 / 96 on seeds 4 / 6 / 9 / 11 (= the fields' boundary, and the review's numbers); the
 * T23.07B ramp 4 / 4 / 8 / 12 (low tier), 9 / 9 / 8 / 7 (full) — texture and the rock's own anti-aliased
 * corner at a run's end; R24's final form (T23.07C, low tier) 7 / 14 / 39·28 (named) / 12. 24 sits between:
 * 2× the worst fade, under the shortest slab.
 */
const WALL_EDGE_MAX_RUN = 24
/** Control: a seed must have a straight wall/sky boundary at least this long to photograph. */
const WALL_EDGE_MIN_GEOMETRIC = 24
/** Seed whose worst site is cropped into `shots/` (the reviewer's L-shaped slab). */
const WALL_EDGE_SHOT_SEED = 11

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
  const full = await lab(page, '&only=terrain')
  TH = thresholdsFor(RAW, full.info.gpu)
  log(`renderer ${JSON.stringify(full.info.gpu)} → the ${TH.backEnd} threshold set (R25)`)
  const i = full.info
  if (i.tier !== 'full' || i.buffer[0] !== 1280 || i.buffer[1] !== 720 || i.samples !== 4) {
    throw new Error(`want the full tier (1280x720, MSAA 4), got ${JSON.stringify(i)}`)
  }
  if (!full.lit?.drawn || full.lit.material !== 'full' || full.lit.lights !== 10) {
    throw new Error(`want the lit terrain drawn with the full material and F1's 10 lights, got ${JSON.stringify(full.lit)} (terrain ${JSON.stringify(full.terrain)})`)
  }
  if (full.look.described.actors !== 0) throw new Error(`only=terrain still describes ${full.look.described.actors} actors`)
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
  for (const [knob, extra] of [['rim-off', '&only=terrain&knob=rim-off'], ['bevel-off', '&only=terrain&knob=bevel-off'], ['no terrain', '&only=sky']]) {
    const c = await lab(page, extra)
    const cm = compare(c.frame, reference, { regions })
    const cbad = failures(cm, TH)
    log(`control ${knob}: fails ${cbad.length}/${Object.keys(TH.metrics).length} (${cbad.join(', ') || 'none'}); deltaE_terrain ${cm.deltaE_terrain.toFixed(3)}, dssim ${cm.dssim.toFixed(4)}`)
    if (!cbad.length) problems.push(`control ${knob} passes every threshold — the comparison cannot see it`)
  }

  // ---------------------------------------------------------------- 2. the low tier's bake
  await page.evaluate((k) => localStorage.setItem(k, '0'), HIGH_QUALITY_KEY)
  const low = await lab(page, '&only=terrain')
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
  // T23.09A: the game draws no cave wall by default now (owner, ruling pending); §4's straight-edge
  // bound, its named exceptions and the chamber guard photograph the wall, so this page turns it on.
  base.search = '?sandbox=1&seed=4242&cavewall=1'
  await page.goto(base.href, { waitUntil: 'load' })
  await page.waitForFunction(() => !!window.__game && !!window.__world, null, { timeout: 60_000 })
  // F5: the camera pinned on deep rock from the first moment, so every screenshot below is the same place.
  const deep = await page.evaluate((m) => {
    const c = window.__game.core
    for (let k = 0; k < 60; k++) {
      const x = Math.round(c.width / 2 + (k % 2 ? -1 : 1) * Math.ceil(k / 2) * 53)
      for (let y = 40; y < c.height - 3 * m; y++) {
        if (!c.solidAt(x, y)) continue
        let ok = true
        for (let yy = y + m; yy < y + 3 * m && ok; yy++) for (let xx = x - m; xx <= x + m && ok; xx++) ok = c.solidAt(xx, yy)
        if (ok) return { x, y: y + 2 * m }
        break
      }
    }
    return null
  }, SWAP_DEEP)
  if (!deep) throw new Error('no deep rock found to watch across the swap')
  await page.evaluate(([x, y]) => window.__game.watch(x, y), [deep.x, deep.y])
  // Every frame from here until ready + 10: (ready, rock visible) — and, alongside, screenshots of the page
  // (both canvases composited: what a player sees) of a patch of that rock, each tagged ready or not.
  const flags = page.evaluate(
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
  let flagsDone = false
  const settle = () => (flagsDone = true)
  flags.then(settle, settle) // a rejection is rethrown by the `await flags` below, not left unhandled
  const patches = []
  let offScreen = 0
  try {
    while (!flagsDone) {
      const pt = await toScreen(page, deep.x, deep.y)
      if (!pt.onScreen) {
        offScreen++
        continue
      }
      const png = PNG.sync.read(await page.screenshot({ clip: { x: pt.x - SWAP_PATCH / 2, y: pt.y - SWAP_PATCH / 2, width: SWAP_PATCH, height: SWAP_PATCH } }))
      const ready = await page.evaluate(() => window.__game.debug().terrainReady)
      patches.push({ ready, data: png.data })
    }
  } finally {
    await flags.catch(() => null) // never leave the page with the sampler pending
  }
  if (offScreen) log(`swap in pixels: the rock point was off screen for ${offScreen} sample(s) (the camera not yet on it)`)
  const swap = await flags
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
  // T23.09A: the legs below photograph the cave wall. T23.09C F3: `debug().caveWall` is the drawn frame's wall — so it
  // is read here, once the lit terrain draws (waiting for it before the swap waited the swap's control frames away).
  const wallOn = await page.evaluate(() => window.__game.debug().caveWall)
  if (wallOn !== true) problems.push(`T23.09A: the sandbox legs photograph the cave wall, but the drawn frame's wall (debug().caveWall) is ${JSON.stringify(wallOn)}`)
  // T23.08C F8: ready from the worker, not from a main-thread fallback (which is ready too, without the
  // generator's cave wall that §4 photographs).
  const warning = await page.evaluate(() => window.__game.debug().terrainWarning)
  if (warning !== '') problems.push(`seed 4242: the terrain fields warn — got ${JSON.stringify(warning)}, want ""`)
  // F5, in pixels: the same patch with the lit terrain hidden (Phaser's rock is hidden once ready) is the sky
  // behind it — the "absent" picture. Every screenshot, before ready and after, must differ from it.
  await page.evaluate(() => window.__world.hideTerrain(true))
  await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))))
  const ptS = await toScreen(page, deep.x, deep.y)
  const sky = PNG.sync.read(await page.screenshot({ clip: { x: ptS.x - SWAP_PATCH / 2, y: ptS.y - SWAP_PATCH / 2, width: SWAP_PATCH, height: SWAP_PATCH } })).data
  await page.evaluate(() => window.__world.hideTerrain(false))
  const rockShare = (d) => {
    let n = 0
    for (let o = 0; o < d.length; o += 4) if (Math.max(Math.abs(d[o] - sky[o]), Math.abs(d[o + 1] - sky[o + 1]), Math.abs(d[o + 2] - sky[o + 2])) > PIXEL_MOVED) n++
    return n / (d.length / 4)
  }
  const shares = patches.map((p) => ({ ready: p.ready, share: rockShare(p.data) }))
  const pre = shares.filter((p) => !p.ready)
  const post = shares.filter((p) => p.ready)
  const worstShare = Math.min(...shares.map((p) => p.share))
  log(`swap in pixels: ${shares.length} screenshots of a ${SWAP_PATCH}px patch of deep rock (${pre.length} before ready, ${post.length} after); least rock share ${worstShare.toFixed(2)} (min ${SWAP_ROCK}) against the patch with the terrain hidden`)
  if (!(pre.length > 0 && post.length > 0)) problems.push(`control: screenshots on both sides of the swap wanted (${pre.length} before, ${post.length} after)`)
  if (shares.some((p) => p.share < SWAP_ROCK)) problems.push(`a screenshot across the swap shows the sky where the rock is (rock share ${worstShare.toFixed(2)})`)
  await page.evaluate(() => window.__game.watch(null))
  await shot('look-terrain-sandbox')

  // F6: the crater on several seeds.
  for (const seed of CRATER_SEEDS) {
    await page.evaluate((s) => window.__game.regenerate(String(s)), seed)
    await crater(page, seed, log, problems)
  }
  await shot('look-terrain-sandbox-crater')

  // ---------------------------------------------------------------- 4. cave wall against open sky
  // T23.10: on the full tier — its bounds (R24's 24 px, the named runs) were measured at one buffer px per world px,
  // the low tier at zoom 2; at zoom 1 the low tier draws a world px as half a buffer px, and the 10 px fade's steps
  // doubled past `WALL_EDGE_STEP` (seed 11: 40–60 px "hard" where the fade is drawn).
  await page.evaluate(() => window.__game.setHighQuality(true))
  await page.waitForFunction(() => window.__world.info().tier === 'full' && window.__world.litTerrain()?.drawn && !window.__game.debug().terrainSwapPending, null, { timeout: 60_000 })
  const edges = await wallEdges(page, WALL_EDGE_SEEDS, log)
  await page.evaluate(() => window.__game.setHighQuality(false))
  for (const e of edges) for (const x of e.over) problems.push(`seed ${e.seed}: ${x}`)
  for (const e of edges) if (e.warning !== '') problems.push(`seed ${e.seed}: the terrain fields warn — got ${JSON.stringify(e.warning)}, want ""`)
  for (const e of edges) {
    if (!(e.geometric >= WALL_EDGE_MIN_GEOMETRIC)) problems.push(`seed ${e.seed}: control — the review's slab boundary is ${e.geometric} px of air (0: moved or filled), want ≥ ${WALL_EDGE_MIN_GEOMETRIC} (nothing to photograph)`)
  }
  // The sky-circle guard (T23.07C): an underground chamber wider than 2R draws wall, not sky.
  for (const c of await chambers(page, CHAMBER_SEEDS, log)) {
    if (!c.found) problems.push(`seed ${c.seed}: control — the chamber patch at (${c.x}, ${c.y}) is not air ${WALL_CLOSING_R + 4} px from rock any more (the map moved: re-find it)`)
    else if (!(c.wall >= SWAP_ROCK)) problems.push(`seed ${c.seed}: the chamber patch at (${c.x}, ${c.y}) shows sky — only ${(c.wall * 100).toFixed(0)} % of it is drawn wall`)
  }

  if (problems.length) throw new Error(`look-terrain:\n  - ${problems.join('\n  - ')}`)
}

/**
 * ## 4. No long straight hard wall-against-sky edge (T23.07B F1, R24 final form — T23.07C)
 *
 * V2's pre-carve landform becomes wall wherever a cave shaft cuts through a cliff, and drawn as a hard
 * on/off the wall ended on long straight lines against the sky (the reviewer's seeds 4/6/9/11: 58, 89,
 * 40, 96 px). Per seed: **the fields say where** — every straight run of wall px with non-wall air on one
 * side (`renderFieldsView`: B > 0 wall, R = 0 ∧ B = 0 sky), the longest `WALL_EDGE_SITES` far enough
 * apart — and **the pixels say how it is drawn**: the camera on each run's middle, one world-canvas frame,
 * and for each px along the run the largest luminance step between two horizontally (vertical run) or
 * vertically (horizontal run) adjacent **non-solid** px within `WALL_EDGE_WINDOW` world px of the boundary
 * — wherever the renderer puts its edge, and never the rock's own silhouette. A row is hard when that step
 * is > `WALL_EDGE_STEP`; the rendered run is the longest stretch of consecutive hard rows, in world px.
 * The geometric run is the control (≥ `WALL_EDGE_MIN_GEOMETRIC`: there is a straight boundary to draw).
 */
export async function wallEdges(page, seeds, log) {
  const out = []
  for (const seed of seeds) {
    await page.evaluate((s) => window.__game.regenerate(String(s)), seed)
    const warning = await page.evaluate(() => window.__game.debug().terrainWarning)
    const exceptions = WALL_EDGE_EXCEPTIONS.filter((e) => e.seed === seed)
    const sites = await page.evaluate(
      ([n, apart, minRun, exceptions]) => {
        const core = window.__game.core
        const w = core.width
        const h = core.height
        const f = core.renderFieldsView()
        const wall = (x, y) => f[(y * w + x) * 4 + 2] > 0
        const sky = (x, y) => x >= 0 && y >= 0 && x < w && y < h && f[(y * w + x) * 4] === 0 && f[(y * w + x) * 4 + 2] === 0
        const runs = []
        // Vertical runs: wall at (x, y), sky at (x + s, y), for consecutive y.
        for (const s of [-1, 1]) {
          for (let x = 0; x < w; x++) {
            let start = -1
            for (let y = 0; y <= h; y++) {
              const on = y < h && wall(x, y) && sky(x + s, y)
              if (on && start < 0) start = y
              if (!on && start >= 0) {
                if (y - start >= minRun) runs.push({ dir: 'v', x, y0: start, y1: y, side: s, len: y - start })
                start = -1
              }
            }
          }
          for (let y = 0; y < h; y++) {
            let start = -1
            for (let x = 0; x <= w; x++) {
              const on = x < w && wall(x, y) && sky(x, y + s)
              if (on && start < 0) start = x
              if (!on && start >= 0) {
                if (x - start >= minRun) runs.push({ dir: 'h', y, x0: start, x1: x, side: s, len: x - start })
                start = -1
              }
            }
          }
        }
        runs.sort((a, b) => b.len - a.len)
        const mid = (r) => (r.dir === 'v' ? [r.x, (r.y0 + r.y1) / 2] : [(r.x0 + r.x1) / 2, r.y])
        const picked = []
        for (const r of runs) {
          if (picked.length >= n) break
          const [mx, my] = mid(r)
          if (picked.every((p) => Math.hypot(mid(p)[0] - mx, mid(p)[1] - my) > apart)) picked.push(r)
        }
        // T23.08C F7: at each named exception's site, the run the fields draw *now* — the longest one there,
        // whatever its ends — so a run that grew past the recorded one is the one photographed.
        const at = (e, r) => r.dir === e.dir && (r.dir === 'v' ? Math.abs(e.x - r.x) <= 2 && r.y0 < e.y1 && e.y0 < r.y1 : Math.abs(e.y - r.y) <= 2 && r.x0 < e.x1 && e.x0 < r.x1)
        const named = exceptions.map((e) => runs.find((r) => at(e, r)) ?? null)
        return { w, h, sites: picked, named, longest: runs[0]?.len ?? 0 }
      },
      [WALL_EDGE_SITES, WALL_EDGE_APART, 8, exceptions],
    )
    const missing = exceptions.filter((_, i) => !sites.named[i])
    let rendered = 0
    const over = []
    const per = []
    const known = WALL_EDGE_KNOWN[seed] ?? []
    const knownAir = await page.evaluate(
      (runs) =>
        runs.every((r) => {
          const c = window.__game.core
          for (let i = 0; i < r.len; i++) {
            const [x, y] = r.dir === 'v' ? [r.x, r.y0 + i] : [r.x0 + i, r.y]
            const [sx, sy] = r.dir === 'v' ? [x + r.side, y] : [x, y + r.side]
            if (c.solidAt(x, y) || c.solidAt(sx, sy)) return false
          }
          return true
        }),
      known,
    )
    // T23.08C F7: the key holds both ends — a scanned run that starts where a known one does but ends
    // further on is a different run, and is photographed (it used to be deduped against the known one).
    const key = (r) => JSON.stringify([r.dir, r.x, r.y, r.x0, r.y0, r.x1, r.y1])
    const photographed = new Set()
    const todo = []
    for (const r of [...known, ...sites.named.filter(Boolean), ...sites.sites]) {
      if (photographed.has(key(r))) continue
      photographed.add(key(r))
      todo.push(r)
    }
    for (const e of missing) over.push(`the named exception ${e.dir}@(${e.x ?? e.x0}, ${e.y0 ?? e.y}) has no wall/sky run at its site in the fields (moved or gone: re-measure it)`)
    for (const r of todo) {
      const [mx, my] = r.dir === 'v' ? [r.x, (r.y0 + r.y1) / 2] : [(r.x0 + r.x1) / 2, r.y]
      await page.evaluate(([x, y]) => window.__game.watch(x, y), [mx, my])
      await page.evaluate(() => new Promise((res) => requestAnimationFrame(() => requestAnimationFrame(() => requestAnimationFrame(res)))))
      const fr = decode(await page.evaluate(() => window.__world.readFrame()))
      const solid = await page.evaluate(
        ([x0, y0, x1, y1]) => {
          const c = window.__game.core
          const out = []
          for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) out.push(c.solidAt(x, y) ? 1 : 0)
          return out
        },
        r.dir === 'v' ? [r.x - WALL_EDGE_WINDOW, r.y0, r.x + WALL_EDGE_WINDOW + 1, r.y1] : [r.x0, r.y - WALL_EDGE_WINDOW, r.x1, r.y + WALL_EDGE_WINDOW + 1],
      )
      const run = hardRun(fr, r, solid)
      const ex = WALL_EDGE_EXCEPTIONS.find(
        (e) =>
          e.seed === seed &&
          e.dir === r.dir &&
          (r.dir === 'v' ? Math.abs(e.x - r.x) <= 2 && r.y0 < e.y1 && e.y0 < r.y1 : Math.abs(e.y - r.y) <= 2 && r.x0 < e.x1 && e.x0 < r.x1),
      )
      const limit = ex ? ex.measured + 2 : WALL_EDGE_MAX_RUN
      if (!(run.len < limit + (ex ? 1 : 0))) over.push(`a straight hard wall-against-sky edge ${run.len.toFixed(0)} px long at ${r.dir}${r.len}@(${r.x ?? r.x0}, ${r.y0 ?? r.y}) (max ${ex ? `${limit}, the named exception measured ${ex.measured}` : limit})`)
      if (!ex) rendered = Math.max(rendered, run.len)
      per.push(`${r.dir}${r.len}@(${Math.round(mx)},${Math.round(my)}) → ${run.len.toFixed(0)} (step min ${run.min.toFixed(0)}, p50 ${run.p50.toFixed(0)}, max ${run.max.toFixed(0)}${run.clipped ? ', clipped' : ''})`)
      if (seed === WALL_EDGE_SHOT_SEED && r === known[0]) cropShot(fr, r, `look-terrain-wall-edge-s${seed}.png`)
    }
    log(`wall/sky seed ${seed}: the review's slab runs ${known.map((r) => r.len).join('/')} px (air in the mask: ${knownAir}); longest straight boundary in the fields now ${sites.longest} px; drawn hard ${rendered.toFixed(0)} px (max ${WALL_EDGE_MAX_RUN}) — ${per.join('; ') || 'no site'}`)
    out.push({ seed, geometric: knownAir ? Math.max(0, ...known.map((r) => r.len)) : 0, rendered, over, specs: sites.sites, warning })
  }
  await page.evaluate(() => window.__game.watch(null))
  return out
}

/** Along one boundary run: the longest stretch of consecutive rows (world px) whose step between adjacent non-solid px near it exceeds `WALL_EDGE_STEP`. */
function hardRun(fr, r, solid) {
  const k = fr.width / fr.view.w
  const L = (bx, by) => {
    const o = (by * fr.width + bx) * 4
    return 0.3 * fr.data[o] + 0.59 * fr.data[o + 1] + 0.11 * fr.data[o + 2]
  }
  const win = 2 * WALL_EDGE_WINDOW + 1
  const isSolid = (along, across) => solid[r.dir === 'v' ? along * win + across : across * (r.x1 - r.x0) + along] === 1
  const n = r.dir === 'v' ? r.y1 - r.y0 : r.x1 - r.x0
  const steps = []
  let clipped = false
  for (let i = 0; i < n; i++) {
    let best = 0
    // Buffer px of this row, across the window: consecutive world px (j - 1, j) both non-solid.
    for (let j = 1; j < win; j++) {
      if (isSolid(i, j) || isSolid(i, j - 1)) continue
      const wa = r.dir === 'v' ? [r.x - WALL_EDGE_WINDOW + j - 1, r.y0 + i] : [r.x0 + i, r.y - WALL_EDGE_WINDOW + j - 1]
      const wb = r.dir === 'v' ? [wa[0] + 1, wa[1]] : [wa[0], wa[1] + 1]
      const ba = [Math.floor((wa[0] + 0.5 - fr.view.x) * k), Math.floor((wa[1] + 0.5 - fr.view.y) * k)]
      const bb = [Math.floor((wb[0] + 0.5 - fr.view.x) * k), Math.floor((wb[1] + 0.5 - fr.view.y) * k)]
      if (ba[0] === bb[0] && ba[1] === bb[1]) continue
      if ([ba, bb].some(([x, y]) => x < 0 || y < 0 || x >= fr.width || y >= fr.height)) {
        clipped = true
        continue
      }
      best = Math.max(best, Math.abs(L(...ba) - L(...bb)))
    }
    steps.push(best)
  }
  let len = 0
  let cur = 0
  for (const s of steps) {
    cur = s > WALL_EDGE_STEP ? cur + 1 : 0
    len = Math.max(len, cur)
  }
  const sorted = [...steps].sort((a, b) => a - b)
  return { len, p50: sorted[Math.floor(sorted.length / 2)] ?? 0, min: sorted[0] ?? 0, max: sorted[sorted.length - 1] ?? 0, clipped }
}

/** A crop of the frame around a run, for a person to look at. */
function cropShot(fr, r, name) {
  const k = fr.width / fr.view.w
  const [cx, cy] = r.dir === 'v' ? [r.x, (r.y0 + r.y1) / 2] : [(r.x0 + r.x1) / 2, r.y]
  const half = Math.round(Math.max(r.len, 160) * k)
  const x0 = Math.max(0, Math.round((cx - fr.view.x) * k) - half)
  const y0 = Math.max(0, Math.round((cy - fr.view.y) * k) - half)
  const x1 = Math.min(fr.width, x0 + 2 * half)
  const y1 = Math.min(fr.height, y0 + 2 * half)
  const png = new PNG({ width: x1 - x0, height: y1 - y0 })
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      const o = (y * fr.width + x) * 4
      const q = ((y - y0) * png.width + x - x0) * 4
      for (let c = 0; c < 3; c++) png.data[q + c] = fr.data[o + c]
      png.data[q + 3] = 255
    }
  }
  writeFileSync(join(root, 'shots', name), PNG.sync.write(png))
}


/**
 * A crater, lit in the frame it is carved (section 3): the camera pinned on a surface; the frame before;
 * `carve` between two frames; the **next drawn frame** (`readNextFrame`, nothing forced) with Phaser's frame
 * counter. It must be the very next frame (`CARVE_FRAMES`), the terrain must have repainted in it, and it
 * must equal (`CRATER_MAX_DIFF`) the control repaint at the same view — `repaintAlbedo`: every field strip
 * **re-uploaded from the Rust buffer as the carve left it** (that buffer's incremental == full is
 * `render_fields.rs`'s test, not this one's) and every albedo and bake tile repainted from it — over the
 * whole frame (the shadow march reads 53 px away). Presence: the crater box differs from the frame before.
 */
async function crater(page, seed, log, problems) {
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
  if (!site) {
    problems.push(`seed ${seed}: no surface with solid rock under it found to carve`)
    return
  }
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
  if (!carved.f) {
    problems.push(`seed ${seed}: the world canvas drew no frame within 5 s of the carve (the carve did not reach the picture)`)
    return
  }
  const inc = decode(carved.f)
  await page.evaluate(() => window.__world.repaintAlbedo())
  const scratch = decode(await page.evaluate(() => window.__world.readFrame()))
  await page.evaluate(() => window.__game.watch(null))
  const views = [pre.view, inc.view, scratch.view].map((v) => JSON.stringify(v))
  if (new Set(views).size !== 1) problems.push(`seed ${seed}: the camera moved between the crater's frames: ${views.join(' ')}`)
  const k = inc.width / inc.view.w
  const box = {
    x0: Math.max(0, Math.floor((cx - CRATER_R - 16 - inc.view.x) * k)),
    y0: Math.max(0, Math.floor((cy - CRATER_R - 16 - inc.view.y) * k)),
    x1: Math.min(inc.width, Math.ceil((cx + CRATER_R + 16 - inc.view.x) * k)),
    y1: Math.min(inc.height, Math.ceil((cy + CRATER_R + 16 - inc.view.y) * k)),
  }
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
  log(`seed ${seed} crater r ${CRATER_R} at (${cx}, ${cy}): shown ${framesToShow} Phaser frame(s) after the carve (want ${CARVE_FRAMES}); terrain repaints ${t0.dirtyPaints} → ${t1.dirtyPaints}, bakes ${t0.bakes} → ${t1.bakes}; crater box ${box.x1 - box.x0}x${box.y1 - box.y0} buffer px: the whole frame vs the control repaint max |Δ| ${worst} (max ${CRATER_MAX_DIFF}), ${stale} px over; the box vs the frame before ${moved}/${n} px moved`)
  if (framesToShow !== CARVE_FRAMES) problems.push(`seed ${seed}: the crater was first drawn ${framesToShow} frames after the carve, want ${CARVE_FRAMES}`)
  if (!(t1.dirtyPaints > t0.dirtyPaints) || !(t1.bakes > t0.bakes)) problems.push(`seed ${seed}: the carve's frame repainted nothing (repaints ${t0.dirtyPaints} → ${t1.dirtyPaints}, bakes ${t0.bakes} → ${t1.bakes})`)
  if (worst > CRATER_MAX_DIFF) problems.push(`seed ${seed}: the crater's first frame differs from the control repaint by ${worst} on ${stale} px`)
  if (moved < n * 0.2) problems.push(`seed ${seed}: control: the crater moved only ${moved}/${n} px of its box against the frame before`)
  if (seed !== CRATER_SEEDS[0]) return
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
  log('crater (before | its first frame | control repaint): shots/look-terrain-crater.png')
}


/**
 * The sky-circle guard (T23.07C). With the closing alone, cave chambers wider than 2R lost their wall and the
 * sky showed through underground (seeds 4 and 9). Per seed: a `CHAMBER_PATCH`² patch at `CHAMBER_SITES`, air
 * farther than R from any rock (G, dOut ×4, ≥ 4·(R + 4) — outside the closing, so only the fade keeps
 * it), photographed with the wall shown and with only the wall hidden (`hideWall`): the share of its px that
 * change is the share drawn as wall. T23.07C falsified it with the closing-only rule *and no fade* (soft
 * wall dropped): red. R24's fourth amendment (T23.08C) deleted the enclosed-region term — the fade keeps a
 * chamber whole (no open-sky edge within `BACK_RAMP_PX`), which this guard now checks alone.
 */
async function chambers(page, seeds, log) {
  const out = []
  for (const seed of seeds) {
    await page.evaluate((s) => window.__game.regenerate(String(s)), seed)
    const [x, y] = CHAMBER_SITES[seed]
    const at = { x, y }
    // Control, from the fields' distances (not the wall): the patch is air, farther than R + 4 from rock.
    const air = await page.evaluate(
      ([x, y, n, g]) => {
        const c = window.__game.core
        const w = c.width
        const f = c.renderFieldsView()
        for (let yy = y; yy < y + n; yy++) for (let xx = x; xx < x + n; xx++) if (f[(yy * w + xx) * 4 + 1] < g) return false
        return true
      },
      [x, y, CHAMBER_PATCH, 4 * (WALL_CLOSING_R + 4)],
    )
    if (!air) {
      out.push({ seed, found: false, x, y })
      continue
    }
    await page.evaluate(([x, y]) => window.__game.watch(x, y), [at.x, at.y])
    await page.evaluate(() => new Promise((res) => requestAnimationFrame(() => requestAnimationFrame(() => requestAnimationFrame(res)))))
    const on = decode(await page.evaluate(() => window.__world.readFrame()))
    await page.evaluate(() => window.__world.hideWall(true))
    const off = decode(await page.evaluate(() => window.__world.readFrame()))
    await page.evaluate(() => window.__world.hideWall(false))
    const k = on.width / on.view.w
    let n = 0
    let moved = 0
    for (let wy = at.y; wy < at.y + CHAMBER_PATCH; wy++)
      for (let wx = at.x; wx < at.x + CHAMBER_PATCH; wx++) {
        const bx = Math.floor((wx + 0.5 - on.view.x) * k)
        const by = Math.floor((wy + 0.5 - on.view.y) * k)
        if (bx < 0 || by < 0 || bx >= on.width || by >= on.height) continue
        const o = (by * on.width + bx) * 4
        n++
        if (Math.max(Math.abs(on.data[o] - off.data[o]), Math.abs(on.data[o + 1] - off.data[o + 1]), Math.abs(on.data[o + 2] - off.data[o + 2])) > PIXEL_MOVED) moved++
      }
    const wall = n ? moved / n : 0
    log(`chamber seed ${seed}: patch (${at.x}, ${at.y}) ≥ ${WALL_CLOSING_R + 4} px from rock: ${moved}/${n} px drawn wall (change with the wall hidden; min ${SWAP_ROCK})`)
    out.push({ seed, found: true, x: at.x, y: at.y, wall })
  }
  await page.evaluate(() => window.__game.watch(null))
  return out
}
