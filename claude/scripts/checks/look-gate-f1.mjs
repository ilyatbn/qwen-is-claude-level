/**
 * `look-gate-f1` — T23.08, **the first picture gate** (M23-art.md § Build order): the look-lab's F1
 * world — sky, back fog, lit terrain, front fog, the foreground's out-of-focus leaves, bloom, grade — at
 * Level A, full tier, and the fade that keeps a leaf from hiding a player.
 *
 * ## 1. Level A against the mockup's world (gating)
 *
 * `?look=F1&only=world` draws F1 without its cast (actors, fx, labels, HUD are T23.12+ / T23.18). The
 * reference is the mockup drawing the same thing: `reference/controls/worldonly.js` — `f_kit.js::frame`
 * with only the 2D actor canvas and the fx group taken out — → `controls/F1-world.png`, rendered twice
 * byte-identical (floor 0). Every `look-thresholds.json` metric must sit within its threshold, printed
 * beside it, plus the **moon's bloom** (`bloomBox`): in a frame with no cast the only thing above
 * `P.bloom`'s threshold is the moon, and whole-frame metrics cannot see its halo (the mockup's own
 * bloom-off passes every one of them against F1-world — measured), so its box is compared on its own.
 *
 * ## 2. Must-fail controls through the game's renderer (R19's set, lab side)
 *
 * The lab with one knob turned against the same reference: `fog-off`, `exposure-up`/`-down` (±10 %),
 * `bloom-off` (the moon box), and T23.08's other two layers, `fg-off` and `grade-off`. Each must fail —
 * a comparison that passes one cannot see that layer.
 *
 * ## 3. Against the F1 picture, actor boxes excluded (the gate's number, and where the miss is)
 *
 * The lab's frame against `F1-night-combat.png` with every F1 actor box filled from the reference in both
 * (so every whole-frame metric, not only the regions, excludes them). It cannot pass yet: the fx — the
 * explosions' sprites, the laser and rocket ribbons, the muzzle flashes — draw outside the actor boxes
 * and are T23.18's, and the bloom they feed spreads further. So the gate asserts **where** the miss is:
 * the mockup's own F1-world is compared with F1 the same way, and the lab's distance must equal the
 * mockup's within each metric's threshold — every point of the miss is the cast's, none the lab's.
 *
 * ## 4. A leaf never hides a player
 *
 * A player box is placed behind F1's right-hand leaf clump (`__world.setOccluders`): the leaves' own
 * alpha over it (`foregroundAlpha`: the layer drawn alone, unblended) must be ≤ `FG_MAX_ALPHA`; the
 * control is the same box with no occluder, where the clump must be there (alpha ≥ `FG_PRESENT`). In
 * pixels: over the box, the frame with the leaves differs from the frame without them by less with the
 * player there than with no player (the leaves' darkening is faded, not merely re-reported).
 */
import { writeFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'
import { actorBoxes, boxDelta, compare, failures, loadPng, withActors } from '../lib/look-compare.mjs'
import { HIGH_QUALITY_KEY } from '../lib/check-tier.mjs'

const root = join(dirname(fileURLToPath(import.meta.url)), '../..')
const { PNG } = createRequire(join(root, 'client/package.json'))('pngjs')
const ref = (p) => join(root, 'tasks/M23/reference', p)
const TH = JSON.parse((await import('node:fs')).readFileSync(join(root, 'scripts/lib/look-thresholds.json'), 'utf8'))

/**
 * The moon's bloom box and its threshold: `look-thresholds.json` `box.bloomBox` — the box (where the
 * mockup's F1-world and its bloom-off differ, grown to the disc and halo), the metric (mean |Δ| per
 * channel, `look-compare.mjs::boxDelta`), and its threshold between the look-lab's two-back-end floor
 * and the mockup's bloom-off control, both written there (`look-compare.mjs --derive`).
 */
const BLOOM_KEY = 'bloomBox'

/** The foreground leg: a player-sized box (the F1 stick's is 51×56) behind the right-hand clump (`fg.spots[1]`, 1300, 700, r 110). */
const FG_BOX = [1180, 610, 1231, 666]
/** The task's bound on a leaf's alpha over a player. */
const FG_MAX_ALPHA = 0.25
/** Control: with no player, the clump covers the box — its alpha there reaches at least this. */
const FG_PRESENT = 0.8

const decode = (f) => ({ width: f.w, height: f.h, data: Uint8Array.from(Buffer.from(f.rgba, 'base64')), view: f.view })

async function lab(page, extra) {
  const base = new URL(page.url())
  base.search = `?look=F1${extra}`
  await page.goto(base.href, { waitUntil: 'load' })
  await page.waitForFunction(() => window.__look && (window.__look.ready || window.__look.error) && !!window.__world, null, { timeout: 120_000 })
  const look = await page.evaluate(() => window.__look)
  if (look.error) throw new Error(`look-lab F1${extra}: ${look.error}`)
  const frame = decode(await page.evaluate(() => window.__world.readFrame()))
  const info = await page.evaluate(() => ({ info: window.__world.info(), lit: window.__world.litTerrain(), atmos: window.__world.atmosphere() }))
  return { look, frame, ...info }
}

/** A copy of `img` with every px inside `boxes` taken from `from`: the boxes then agree in both images. */
export function pasteBoxes(img, from, boxes) {
  const out = { width: img.width, height: img.height, data: Uint8Array.from(img.data) }
  for (const [x0, y0, x1, y1] of boxes) {
    for (let y = Math.max(0, y0); y < Math.min(img.height, y1); y++) {
      for (let x = Math.max(0, x0); x < Math.min(img.width, x1); x++) {
        const i = (y * img.width + x) * 4
        for (let c = 0; c < 4; c++) out.data[i + c] = from.data[i + c]
      }
    }
  }
  return out
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
  const reference = loadPng(ref('controls/F1-world.png'))
  const bloomMax = TH.box?.[BLOOM_KEY]?.threshold
  const BLOOM_BOX = TH.box?.[BLOOM_KEY]?.box
  if (!(bloomMax > 0) || BLOOM_BOX?.length !== 4) throw new Error(`look-thresholds.json has no box.${BLOOM_KEY}`)
  const table = (name, m, bloom) => {
    const bad = failures(m, TH)
    for (const [k, t] of Object.entries(TH.metrics)) {
      log(`  ${name} ${k.padEnd(15)} ${m[k].toFixed(5).padStart(10)}  max ${String(t.threshold).padEnd(9)} ${bad.includes(k) ? 'FAIL' : 'ok'}`)
    }
    const bb = bloom > bloomMax
    log(`  ${name} ${BLOOM_KEY.padEnd(15)} ${bloom.toFixed(5).padStart(10)}  max ${String(bloomMax).padEnd(9)} ${bb ? 'FAIL' : 'ok'}`)
    return bb ? [...bad, BLOOM_KEY] : bad
  }

  // ---------------------------------------------------------------- 1. Level A, full tier
  await page.evaluate((k) => localStorage.setItem(k, '1'), HIGH_QUALITY_KEY)
  const full = await lab(page, '&only=world')
  const i = full.info
  if (i.tier !== 'full' || i.buffer[0] !== 1280 || i.buffer[1] !== 720 || i.samples !== 4) {
    throw new Error(`want the full tier (1280x720, MSAA 4), got ${JSON.stringify(i)}`)
  }
  if (!full.lit?.drawn || full.lit.material !== 'full' || full.lit.lights !== 10) throw new Error(`want the lit terrain with F1's 10 lights, got ${JSON.stringify(full.lit)}`)
  const a = full.atmos
  if (!a || !a.fogBack || !a.fogFront || !a.fg || !a.bloom || !a.grade) throw new Error(`want every T23.08 layer drawn, got ${JSON.stringify(a)}`)
  if (full.look.described.actors !== 0) throw new Error(`only=world still describes ${full.look.described.actors} actors`)
  await shot('look-gate-f1')
  writeFileSync(join(root, 'shots/look-gate-f1-lab.png'), PNG.sync.write(Object.assign(new PNG({ width: 1280, height: 720 }), { data: Buffer.from(full.frame.data) })))
  const m = compare(full.frame, reference, { regions })
  log(`1. Level A — look-lab F1 world vs reference/controls/F1-world.png (full tier, ${Object.keys(TH.metrics).length} metrics + ${BLOOM_KEY}):`)
  const bad = table('F1', m, boxDelta(full.frame, reference, BLOOM_BOX))
  if (bad.length) problems.push(`F1 world outside its thresholds: ${bad.join(', ')}`)
  sideBySide(full.frame, reference, 'look-gate-f1-vs-reference.png')
  log('side by side (lab | mockup): shots/look-gate-f1-vs-reference.png')

  // ---------------------------------------------------------------- 2. must-fail, lab side
  for (const knob of ['fog-off', 'exposure-up', 'exposure-down', 'bloom-off', 'fg-off', 'grade-off']) {
    const c = await lab(page, `&only=world&knob=${knob}`)
    const cm = compare(c.frame, reference, { regions })
    const cbad = failures(cm, TH)
    const bloom = boxDelta(c.frame, reference, BLOOM_BOX)
    if (bloom > bloomMax) cbad.push(BLOOM_KEY)
    log(`2. control ${knob}: fails ${cbad.length}/${Object.keys(TH.metrics).length + 1} (${cbad.join(', ') || 'none'}); ${BLOOM_KEY} ${bloom.toFixed(3)}, dssim ${cm.dssim.toFixed(4)}`)
    if (!cbad.length) problems.push(`control ${knob} passes every threshold — the gate cannot see it`)
  }

  // ---------------------------------------------------------------- 3. vs the F1 picture, actor boxes excluded
  const f1 = loadPng(ref('F1-night-combat.png'))
  const boxes = actorBoxes('F1')
  const labEx = pasteBoxes(full.frame, f1, boxes)
  const mockEx = pasteBoxes(reference, f1, boxes)
  const gl = compare(labEx, f1, { regions })
  const gm = compare(mockEx, f1, { regions })
  const gbad = failures(gl, TH)
  log(`3. the gate — lab F1 world vs F1-night-combat.png, the ${boxes.length} actor boxes excluded (filled from F1 in both):`)
  log(`   metric            lab        max        mockup F1-world (the same comparison)   |lab − mockup|`)
  const notCast = []
  for (const [k, t] of Object.entries(TH.metrics)) {
    const d = Math.abs(gl[k] - gm[k])
    const own = d > t.threshold
    if (own) notCast.push(k)
    log(`   ${k.padEnd(15)} ${gl[k].toFixed(5).padStart(10)}  ${String(t.threshold).padEnd(9)} ${gbad.includes(k) ? 'MISS' : 'ok  '}  ${gm[k].toFixed(5).padStart(10)}   ${d.toFixed(5)} ${own ? '> max: the lab\'s own' : '≤ max: the cast\'s'}`)
  }
  log(`   misses ${gbad.length}/${Object.keys(TH.metrics).length} (${gbad.join(', ') || 'none'}) — layer: the cast (actors outside their boxes' reach, fx, their bloom), T23.12+ / T23.18`)
  if (notCast.length) problems.push(`against F1 the lab differs from the mockup's own world by more than a threshold on ${notCast.join(', ')} — a miss that is not the cast's`)
  sideBySide(labEx, f1, 'look-gate-f1-vs-F1.png')

  // ---------------------------------------------------------------- 4. a leaf never hides a player
  const fgNone = await page.evaluate((b) => window.__world.foregroundAlpha(b), FG_BOX)
  const px = async (hide) => {
    await page.evaluate((h) => window.__world.hideLayers(h), hide)
    return decode(await page.evaluate(() => window.__world.readFrame()))
  }
  const withLeaves = await px([])
  const noLeaves = await px(['fg'])
  await page.evaluate((b) => window.__world.setOccluders([b]), FG_BOX)
  const withLeavesOcc = await px([])
  const fgOcc = await page.evaluate((b) => window.__world.foregroundAlpha(b), FG_BOX)
  const drawn = await page.evaluate(() => window.__world.atmosphere())
  await page.evaluate(() => window.__world.setOccluders([]))
  const darkNone = boxDelta(withLeaves, noLeaves, FG_BOX)
  const darkOcc = boxDelta(withLeavesOcc, noLeaves, FG_BOX)
  log(`4. leaf over a player box ${JSON.stringify(FG_BOX)}: alpha max ${fgOcc?.max.toFixed(3)} (≤ ${FG_MAX_ALPHA}), mean ${fgOcc?.mean.toFixed(3)} over ${fgOcc?.px} px; no player (control): max ${fgNone?.max.toFixed(3)} (≥ ${FG_PRESENT}), mean ${fgNone?.mean.toFixed(3)}`)
  log(`   in pixels: the leaves change the box by mean |Δ| ${darkNone.toFixed(2)} with no player, ${darkOcc.toFixed(2)} with one; faded over ${JSON.stringify(drawn?.occluders)}`)
  if (!fgNone || !(fgNone.max >= FG_PRESENT)) problems.push(`control: no leaf over the box without a player (alpha ${fgNone?.max}) — the fade leg photographs nothing`)
  if (!fgOcc || !(fgOcc.max <= FG_MAX_ALPHA)) problems.push(`a leaf over a player reaches alpha ${fgOcc?.max} (max ${FG_MAX_ALPHA})`)
  if (!(darkOcc < darkNone / 2)) problems.push(`in pixels the faded leaves still change the player box by ${darkOcc.toFixed(2)} of ${darkNone.toFixed(2)}`)
  if (JSON.stringify(drawn?.occluders) !== JSON.stringify([FG_BOX])) problems.push(`the leaves faded over ${JSON.stringify(drawn?.occluders)}, want ${JSON.stringify([FG_BOX])}`)

  // ---------------------------------------------------------------- 5. the low tier: half-resolution bloom (R14)
  await page.evaluate((k) => localStorage.setItem(k, '0'), HIGH_QUALITY_KEY)
  const low = await lab(page, '&only=world')
  const lb = low.info.buffer
  // UnrealBloomPass's first target is half the size it is given; the low tier gives it half its buffer.
  const want = [Math.round(Math.round(lb[0] * 0.5) / 2), Math.round(Math.round(lb[1] * 0.5) / 2)]
  const scaled = { width: 1280, height: 720, data: new Uint8Array(1280 * 720 * 4) }
  for (let y = 0; y < 720; y++) for (let x = 0; x < 1280; x++) scaled.data.set(low.frame.data.subarray(((y >> 1) * low.frame.width + (x >> 1)) * 4, ((y >> 1) * low.frame.width + (x >> 1)) * 4 + 4), (y * 1280 + x) * 4)
  const lm = compare(scaled, reference, { regions })
  log(`5. low tier ${lb.join('x')}: bloom's first target ${low.atmos?.bloomTarget?.join('x')} (want ${want.join('x')}, full tier's ${a.bloomTarget?.join('x')}); every layer drawn ${JSON.stringify({ ...low.atmos, occluders: undefined, bloomTarget: undefined })}`)
  log(`   reported, not gating: low (doubled) vs F1-world — fails ${failures(lm, TH).length}/${Object.keys(TH.metrics).length}, dssim ${lm.dssim.toFixed(4)}, deltaE ${lm.deltaE.toFixed(3)}, ${BLOOM_KEY} ${boxDelta(scaled, reference, BLOOM_BOX).toFixed(3)}`)
  sideBySide(scaled, reference, 'look-gate-f1-low-vs-reference.png')
  if (low.info.tier !== 'low') problems.push(`the low leg ran ${low.info.tier}`)
  if (JSON.stringify(low.atmos?.bloomTarget) !== JSON.stringify(want)) problems.push(`low tier bloom target ${low.atmos?.bloomTarget}, want ${want} (half resolution)`)
  const la = low.atmos
  if (!la?.fogBack || !la.fogFront || !la.fg || !la.bloom || !la.grade) problems.push(`the low tier dropped a layer: ${JSON.stringify(la)}`)

  if (problems.length) throw new Error(problems.join('\n'))
}
