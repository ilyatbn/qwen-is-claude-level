/**
 * `look-gate-f3` — T23.20: **space in the new look, at Level A.** The look-lab's F3 through the game's renderer
 * against the mockup's F3, the way `look-gate-f1` holds F1.
 *
 * ## 1. Level A against the mockup's space world (gating)
 *
 * `?look=F3&only=world` draws F3 without its cast: the space sky (gradient, the distant star and its god rays,
 * the stepped planet arcs, stars, grain), the back fog, the asteroids lit by F3's nine lights — through the
 * Rust fields (`labFields.ts`, padded by mirroring: F3's bottom row is open) and the **asteroid** albedo
 * (`albedo.ts::ASTEROID_PALETTE`, `world.js::THEMES.asteroid`) — bloom and grade at F3's exposure. The reference is
 * the mockup drawing the same thing: `reference/controls/spaceworld.js` (`variant_F3.js`'s `frame` call less the 2D
 * actor canvas, the fx group and the HUD) → `controls/F3-world.png`. Every `look-thresholds.json` metric of this
 * page's renderer set (R25) must hold, regions from `controls/regions-F3.png` (`variant_R3.js`: sky / rock / cave
 * wall from `buildMask(SPACE)`). The thresholds are F1's (R19's rule, placed on F1's rows): no F3-specific set is
 * derived — an assumption recorded in T23.20's task file.
 *
 * ## 2. Must-fail controls through the game's renderer
 *
 * The lab with one knob turned against the same reference — R19's set (`fog-off`, `exposure-up`/`-down`,
 * `bloom-off`), `grade-off`, and T23.20's own: **`albedo-dusk`** (F3's rock painted with the ground's palette —
 * a comparison that passes it cannot see that space has its own rock). Each must fail.
 *
 * ## 3. The whole F3 picture: the lab's F3 with its cast and effects against `F3-space.png`
 *
 * With F3's 11 actor boxes pasted from the reference into both (the cast is held at Level A by `actor-atlas` /
 * `look-fx` on the scenes that measure it), reported against the thresholds beside the miss of the mockup's own
 * F3-world against F3 the same way; gated: the cast and effects bring the lab nearer F3 on every metric over its
 * threshold (F3's effect boxes are not measured yet — T23.18's owed line).
 */
import { writeFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'
import { actorBoxes, compare, failures, loadPng, thresholdsFor, withActors } from '../lib/look-compare.mjs'
import { HIGH_QUALITY_KEY } from '../lib/check-tier.mjs'
import { pasteBoxes } from './look-gate-f1.mjs'

const root = join(dirname(fileURLToPath(import.meta.url)), '../..')
const { PNG } = createRequire(join(root, 'client/package.json'))('pngjs')
const ref = (p) => join(root, 'tasks/M23/reference', p)
const RAW = JSON.parse((await import('node:fs')).readFileSync(join(root, 'scripts/lib/look-thresholds.json'), 'utf8'))
/** F3's lights (`variant_F3.js`): the lit terrain must draw every one. */
const F3_LIGHTS = 9
/**
 * **R24's ruled difference, pasted out** (the coordinator's rule for the cave wall, 2026-09-27, final form): a crater
 * open to the sky draws its wall only inside `closing(round-start rock, 48)` and fades the rest from the sky, where the
 * mockup draws a slab with a hard edge (`world.js::buildMask`: `back` = landform ∧ carved). F3's two blast craters on
 * its right-hand rock (`maps.js::SPACE.carve`: (900, 205) r 46, (1030, 330) r 40) both break that rock's rim, so their
 * walls differ by the rule, not by this port — measured: they are every cave px over 6 levels (deltaE_cave 0.245
 * against 0.0125 with them in). Each box is the crater's circle and a 6 px margin, filled from the reference in the
 * lab's frame before every comparison; the miss with them in is printed beside it. The enclosed tunnel in the big rock
 * (a cave wall the rule draws whole) is still measured.
 */
const R24_BOXES = [
  [848, 153, 952, 257],
  [984, 284, 1076, 376],
]
/**
 * Reported in §1, not gated: an 8-colour k-means of each frame (T23.08C F1, `look-gate-f1`'s ATTRIBUTION_SKIPS). F3 is
 * a dark frame whose few bright colours sit near cluster boundaries — measured, two runs of the same lab against the
 * same reference gave 1.083 and 1.344 while dssim stayed 0.0001 and deltaE ≤ 0.016. A metric that moves by a third
 * between identical runs gates nothing (CLAUDE.md: a gate that fails on a coin flip); the must-fail knobs below still
 * fail on the others.
 */
const SKIPS = ['paletteDE']
/** The lab-side must-fail knobs (§2). */
const KNOBS = ['fog-off', 'exposure-up', 'exposure-down', 'bloom-off', 'grade-off', 'albedo-dusk']

const decode = (f) => ({ width: f.w, height: f.h, data: Uint8Array.from(Buffer.from(f.rgba, 'base64')), view: f.view })

async function lab(page, extra) {
  const base = new URL(page.url())
  base.search = `?look=F3${extra}`
  await page.goto(base.href, { waitUntil: 'load' })
  await page.waitForFunction(() => window.__look && (window.__look.ready || window.__look.error) && !!window.__world, null, { timeout: 120_000 })
  const look = await page.evaluate(() => window.__look)
  if (look.error) throw new Error(`look-lab F3${extra}: ${look.error}`)
  if (look.terrain !== true) throw new Error(`look-lab F3${extra}: no lit terrain (${look.terrain})`)
  const frame = decode(await page.evaluate(() => window.__world.readFrame()))
  const info = await page.evaluate(() => ({ info: window.__world.info(), lit: window.__world.litTerrain(), atmos: window.__world.atmosphere() }))
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
  const problems = []
  const boxes = actorBoxes('F3')
  const regions = withActors(loadPng(ref('controls/regions-F3.png')), boxes)
  const reference = loadPng(ref('controls/F3-world.png'))
  let TH = null
  const table = (name, m) => {
    const bad = failures(m, TH).filter((k) => !SKIPS.includes(k))
    for (const [k, t] of Object.entries(TH.metrics)) log(`  ${name} ${k.padEnd(15)} ${m[k].toFixed(5).padStart(10)}  max ${String(t.threshold).padEnd(9)} ${SKIPS.includes(k) ? 'reported' : bad.includes(k) ? 'FAIL' : 'ok'}`)
    return bad
  }

  // ---------------------------------------------------------------- 1. Level A, full tier
  await page.evaluate((k) => localStorage.setItem(k, '1'), HIGH_QUALITY_KEY)
  const full = await lab(page, '&only=world')
  TH = thresholdsFor(RAW, full.info.gpu)
  log(`renderer ${JSON.stringify(full.info.gpu)} → the ${TH.backEnd} threshold set (R25)`)
  const i = full.info
  if (i.tier !== 'full' || i.buffer[0] !== 1280 || i.buffer[1] !== 720) throw new Error(`want the full tier at 1280x720, got ${JSON.stringify(i)}`)
  if (!full.lit?.drawn || full.lit.material !== 'full' || full.lit.lights !== F3_LIGHTS) throw new Error(`want the lit terrain with F3's ${F3_LIGHTS} lights, got ${JSON.stringify(full.lit)}`)
  const a = full.atmos
  if (!a?.fogBack || !a.bloom || !a.grade) throw new Error(`want F3's back fog, bloom and grade drawn, got ${JSON.stringify(a)}`)
  if (full.look.described.actors !== 0) throw new Error(`only=world still describes ${full.look.described.actors} actors`)
  await shot('look-gate-f3')
  writeFileSync(join(root, 'shots/look-gate-f3-lab.png'), PNG.sync.write(Object.assign(new PNG({ width: 1280, height: 720 }), { data: Buffer.from(full.frame.data) })))
  const raw = compare(full.frame, reference, { regions })
  log(`   (R24 craters in: deltaE_cave ${raw.deltaE_cave.toFixed(5)}, paletteDE ${raw.paletteDE.toFixed(3)} — reported, not gating)`)
  const m = compare(pasteBoxes(full.frame, reference, R24_BOXES), reference, { regions })
  log(`1. Level A — look-lab F3 world vs reference/controls/F3-world.png (full tier, ${Object.keys(TH.metrics).length} metrics):`)
  const bad = table('F3', m)
  if (bad.length) problems.push(`F3 world outside its thresholds: ${bad.join(', ')}`)
  sideBySide(full.frame, reference, 'look-gate-f3-vs-reference.png')
  log('side by side (lab | mockup): shots/look-gate-f3-vs-reference.png')

  // ---------------------------------------------------------------- 2. must-fail, lab side
  for (const knob of KNOBS) {
    const c = await lab(page, `&only=world&knob=${knob}`)
    const cm = compare(pasteBoxes(c.frame, reference, R24_BOXES), reference, { regions })
    const cbad = failures(cm, TH).filter((k) => !SKIPS.includes(k))
    log(`2. control ${knob}: fails ${cbad.length}/${Object.keys(TH.metrics).length} (${cbad.join(', ') || 'none'}), dssim ${cm.dssim.toFixed(4)}, deltaE_terrain ${cm.deltaE_terrain?.toFixed(3)}`)
    if (!cbad.length) problems.push(`control ${knob} passes every threshold — the gate cannot see it`)
  }

  // ---------------------------------------------------------------- 3. the whole F3, actor boxes pasted
  const f3 = loadPng(ref('F3-space.png'))
  const whole = await lab(page, '')
  sideBySide(whole.frame, f3, 'look-gate-f3-vs-F3.png')
  const labEx = pasteBoxes(pasteBoxes(whole.frame, f3, R24_BOXES), f3, boxes)
  const gl = compare(labEx, f3, { regions })
  const gm = compare(pasteBoxes(reference, f3, boxes), f3, { regions })
  log(`3. the whole lab F3 (cast + fx) vs F3-space.png, the ${boxes.length} actor boxes pasted in both; beside it the mockup's own F3-world the same way:`)
  // Reported against the thresholds, not gated by them: F3's effects (the blast's sparks and rays, the beams, the
  // muzzle flashes) draw outside the actor boxes, and no effect box is measured for F3 yet (T23.18's `look-fx` holds
  // F1's). Gated: the cast and effects **close** the distance — on every metric the whole lab F3 is nearer the picture
  // than the mockup's own world without them (so they are drawn, and drawn as F3 draws them, not anywhere).
  const wbad = failures(gl, TH)
  const farther = []
  for (const [k, t] of Object.entries(TH.metrics)) {
    if (gl[k] > gm[k] && gl[k] > t.threshold) farther.push(k)
    log(`   ${k.padEnd(15)} ${gl[k].toFixed(5).padStart(10)}  max ${String(t.threshold).padEnd(9)} ${wbad.includes(k) ? 'over' : 'ok  '}  world-only ${gm[k].toFixed(5)}`)
  }
  if (farther.length) problems.push(`the whole lab F3 is farther from F3 than the world without its cast on ${farther.join(', ')}`)
  log('side by side (lab | F3): shots/look-gate-f3-vs-F3.png')

  if (problems.length) throw new Error(problems.join('\n'))
}
