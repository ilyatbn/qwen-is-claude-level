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

  if (problems.length) throw new Error(`look-terrain:\n  - ${problems.join('\n  - ')}`)
}
