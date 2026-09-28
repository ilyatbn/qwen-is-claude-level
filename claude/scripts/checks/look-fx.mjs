/**
 * `look-fx` — T23.18: the look-lab's F1 **with its effects** (`look/fx/`: the turret's four tracers and muzzle glow,
 * the laser and its impact glow, the jet, rocket and flamethrower glows, the explosion) against the picture itself,
 * `F1-night-combat.png`, at Level A on the effect boxes. At T23.08's gate these were the only thing missing.
 *
 * ## The metric
 *
 * Per effect, its box (`fx/kit.ts::fxBox`, the whole of what it can paint), mean CIEDE2000 of the lab (full tier, the
 * reference harness's browser — `actor-atlas` §1 says why) against F1, **over the pixels of the box where the lab
 * without its effects already agrees with the mockup without its effects** (ΔE ≤ `AGREE`: the lab's `&knob=fx-off`
 * against `controls/F1-nofx.png`, which is `f_scene.js::combatF` with only its fx3d group taken out,
 * `controls/fxoff.js`). So the cast's own known distance (T23.12's 0.12, which sits under the jet and rocket glows)
 * is not charged to the effects — and a box where that leaves under `MIN_KEPT` of its pixels is reported, not gated.
 * The threshold is this back end's actor threshold (R25), the Level A number for a small region of the cast.
 *
 * **Must fail:** `&knob=fx-off` against F1 on the same pixels, every box — so every box is one its effect decides.
 * The floor: the mockup's F1 re-rendered through the same harness is byte-identical to F1-night-combat.png (T23.18).
 *
 * F3's effects (space) are not measured: the lab draws no terrain or sky for F3 until T23.20 (`labFields.ts`), so no
 * box of it can agree with the picture — owed to T23.20.
 */
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { readFileSync, writeFileSync } from 'node:fs'
import { lab as toLab, deltaE2000, loadPng, thresholdsFor } from '../lib/look-compare.mjs'
import { HIGH_QUALITY_KEY } from '../lib/check-tier.mjs'
import { chromePath, libDir } from '../lib/browser-args.mjs'
import { REFERENCE_ARGS } from './actor-atlas.mjs'
import { decode } from './figure-frames.mjs'

const root = join(dirname(fileURLToPath(import.meta.url)), '../..')
const require = createRequire(join(root, 'client/package.json'))
const { chromium } = require('playwright-core')
const { PNG } = require('pngjs')
const RAW = JSON.parse(readFileSync(join(root, 'scripts/lib/look-thresholds.json'), 'utf8'))

/** A pixel counts toward an effect's box when the lab and mockup without effects agree there within this ΔE2000. */
const AGREE = 1
/** A box keeping fewer of its pixels than this is the cast's more than the effect's: reported, not gated. */
const MIN_KEPT = 0.5
/** F1's effects (`scenes.test.ts`): 5 ribbons, 5 sprites, 1 explosion. */
const F1_FX = 11

const dE = (a, b, o) =>
  a.data[o] === b.data[o] && a.data[o + 1] === b.data[o + 1] && a.data[o + 2] === b.data[o + 2]
    ? 0
    : deltaE2000(toLab(a.data[o], a.data[o + 1], a.data[o + 2]), toLab(b.data[o], b.data[o + 1], b.data[o + 2]))

/**
 * Mean ΔE of `a` against `b` over `box`, on the pixels where `agreeA` and `agreeB` agree within `AGREE`. T23.19D F6:
 * also **which pixels the mask dropped** — their count, bounding box, and (with `dropMap`) each one marked there.
 */
function masked(a, b, agreeA, agreeB, [x0, y0, x1, y1], dropMap = null) {
  let s = 0
  let n = 0
  let all = 0
  const drop = { n: 0, box: [Infinity, Infinity, -Infinity, -Infinity] }
  for (let y = Math.max(0, y0); y < Math.min(a.height, y1); y++) {
    for (let x = Math.max(0, x0); x < Math.min(a.width, x1); x++) {
      const o = (y * a.width + x) * 4
      all++
      if (dE(agreeA, agreeB, o) > AGREE) {
        drop.n++
        drop.box = [Math.min(drop.box[0], x), Math.min(drop.box[1], y), Math.max(drop.box[2], x + 1), Math.max(drop.box[3], y + 1)]
        if (dropMap) dropMap[y * a.width + x] = 1
        continue
      }
      n++
      s += dE(a, b, o)
    }
  }
  return { d: n ? s / n : NaN, kept: all ? n / all : 0, drop }
}

/** A dropped-pixel summary for the log. */
const dropped = (m) => (m.drop.n ? `${m.drop.n} px dropped in [${m.drop.box.join(',')}]` : 'none dropped')

/**
 * T23.19D F6: the game path's blast (`&knob=game-blast`: a `Blast` record built by `fx/game.ts::blastFx` from the fx
 * feed, as a match draws one) at these shares of its life, on F1's explosion box, same mask and metric as the lab's.
 */
/**
 * T23.19D (R27): the game path's blast (`&knob=game-blast`: a `Blast` record built by `fx/game.ts::blastFx` from the
 * fx feed, as a match draws one, with the mockup's stream) against F1's explosion box, same mask and metric. **At its
 * peak (`BLAST_PEAK`, 12 %) it is gated at Level A**; the other ages are reported (the animation is not the still).
 * Before R27 the curves never passed through the still: best 2.68 at 6 % (no explosion: 23.04).
 */
/** Reported either side of the peak, as shares of the life from it. */
const AROUND_PEAK = [-0.06, 0.08]
/** The strip's ages (shares of the blast's life). */
const STRIP_KS = [0.02, 0.06, 0.12, 0.2, 0.3, 0.45, 0.6, 0.8]

async function lab(page, origin, knob) {
  await page.goto(`${origin}/?look=F1&e2e=1${knob ? `&knob=${knob}` : ''}`, { waitUntil: 'load' })
  // A staged game blast is drawn from the feed on the frames after the scene's first: wait a few.
  if (knob?.startsWith('game-blast')) await page.waitForFunction(() => window.__look && window.__look.frames > 5, null, { timeout: 120_000 })
  await page.waitForFunction(() => window.__look && (window.__look.ready || window.__look.error) && !!window.__world, null, { timeout: 120_000 })
  const err = await page.evaluate(() => window.__look.error)
  if (err) throw new Error(`look-lab F1: ${err}`)
  return { frame: decode(await page.evaluate(() => window.__world.readFrame())), info: await page.evaluate(() => window.__world.info()), fx: await page.evaluate(() => window.__world.fx()) }
}

export default async function ({ page, shot, log }) {
  const origin = new URL(page.url()).origin
  const problems = []
  const browser = await chromium.launch({ executablePath: chromePath, env: { ...process.env, LD_LIBRARY_PATH: libDir }, headless: true, args: REFERENCE_ARGS })
  try {
    const own = await browser.newPage({ viewport: { width: 1280, height: 720 }, deviceScaleFactor: 1 })
    await own.goto(`${origin}/?e2e=1`, { waitUntil: 'load' })
    await own.evaluate((k) => localStorage.setItem(k, '1'), HIGH_QUALITY_KEY)
    const boxes = await own.evaluate(async () => {
      const { SCENES } = await import('/src/look/scenes/index.ts')
      const { fxBox } = await import('/src/look/fx/kit.ts')
      return SCENES.F1.fx.map((f) => ({ kind: f.kind, box: fxBox(f) }))
    })
    if (boxes.length !== F1_FX) problems.push(`F1 describes ${boxes.length} effects, want ${F1_FX}`)
    const ref = loadPng(join(root, 'tasks/M23/reference/F1-night-combat.png'))
    const refOff = loadPng(join(root, 'tasks/M23/reference/controls/F1-nofx.png'))
    const on = await lab(own, origin, '')
    const off = await lab(own, origin, 'fx-off')
    const T = thresholdsFor(RAW, on.info.gpu)
    if (T.backEnd !== 'swiftshader') throw new Error(`the F1 references are SwiftShader's; this is ${T.backEnd}`)
    if (on.info.tier !== 'full') problems.push(`the lab drew the ${on.info.tier} tier, want full`)
    // Both ends: what the scene describes against what the effects layer laid out.
    const laid = on.fx.ribbons + on.fx.soft + on.fx.discs + on.fx.smoke
    log(`both ends: F1 describes ${boxes.length} effects; the layer laid out ${JSON.stringify(on.fx)} (the explosion is 22 smoke, 1 glow, 2 discs, 22 sparks); fx-off laid out ${off.fx.ribbons + off.fx.soft + off.fx.discs + off.fx.smoke}`)
    if (!(on.fx.ribbons === 5 + 22 && on.fx.soft === 5 + 1 && on.fx.discs === 2 && on.fx.smoke === 22)) problems.push(`the effects layer laid out ${laid} parts, ${JSON.stringify(on.fx)}`)
    if (off.fx.ribbons + off.fx.soft + off.fx.discs + off.fx.smoke !== 0) problems.push('fx-off still laid out effects')
    const thr = T.actors.threshold
    const dropMap = new Uint8Array(1280 * 720)
    for (const { kind, box } of boxes) {
      const m = masked(on.frame, ref, off.frame, refOff, box, dropMap)
      const c = masked(off.frame, ref, off.frame, refOff, box)
      const gated = m.kept >= MIN_KEPT
      log(`${kind} ${JSON.stringify(box)}: ${m.d.toFixed(4)} over ${(m.kept * 100).toFixed(1)}% of the box (max ${thr}) ${gated ? (m.d <= thr ? 'ok' : 'FAIL') : 'reported'}; fx-off ${c.d.toFixed(3)} ${c.d > thr ? 'fails, as it must' : 'PASSES'}; mask: ${dropped(m)}`)
      if (gated && !(m.d <= thr)) problems.push(`Level A on the ${kind} box ${JSON.stringify(box)}: ${m.d.toFixed(4)} > ${thr}`)
      if (!(c.d > thr)) problems.push(`control fx-off passes on the ${kind} box ${JSON.stringify(box)} (${c.d.toFixed(4)}) — the box cannot see its effect`)
    }
    // Looked at: lab | F1, side by side.
    const sb = new PNG({ width: 1280 * 2 + 8, height: 720 })
    sb.data.fill(255)
    for (let y = 0; y < 720; y++) for (const [img, x0] of [[on.frame, 0], [ref, 1288]]) Buffer.from(img.data.buffer, img.data.byteOffset + y * 1280 * 4, 1280 * 4).copy(sb.data, (y * sb.width + x0) * 4)
    writeFileSync(join(root, 'shots/look-fx-F1-lab-vs-ref.png'), PNG.sync.write(sb))
    log('looked at: shots/look-fx-F1-lab-vs-ref.png (lab | F1)')
    // T23.19D F6: which pixels the mask dropped, marked magenta over the lab frame.
    const mk = new PNG({ width: 1280, height: 720 })
    for (let i = 0; i < 1280 * 720; i++) {
      const o = i * 4
      const hit = dropMap[i] === 1
      mk.data[o] = hit ? 255 : on.frame.data[o]
      mk.data[o + 1] = hit ? 0 : on.frame.data[o + 1]
      mk.data[o + 2] = hit ? 255 : on.frame.data[o + 2]
      mk.data[o + 3] = 255
    }
    writeFileSync(join(root, 'shots/look-fx-F1-mask-dropped.png'), PNG.sync.write(mk))
    log('the mask: shots/look-fx-F1-mask-dropped.png (magenta = dropped: lab and mockup without effects disagree there)')

    // T23.19D F6: the game path's blast, Level A on F1's explosion box.
    const ex = boxes.find((b) => b.kind === 'explosion')
    if (!ex) problems.push('F1 describes no explosion — no game-path leg')
    else {
      // The peak, read from the code that draws it (pinned to the constant, not restated here).
      const BLAST_PEAK = await own.evaluate(async () => (await import('/src/look/fx/game.ts')).BLAST_PEAK)
      let peak = NaN
      for (const k of [BLAST_PEAK + AROUND_PEAK[0], BLAST_PEAK, BLAST_PEAK + AROUND_PEAK[1]]) {
        const g = await lab(own, origin, `game-blast&blastk=${k}`)
        const st = await own.evaluate(() => window.__look.gameBlast)
        if (!st || st.blasts !== 1) problems.push(`game-blast k ${k}: the lab staged ${JSON.stringify(st)}`)
        const m = masked(g.frame, ref, off.frame, refOff, ex.box)
        if (k === BLAST_PEAK) peak = m.d
        log(`game path, blast at ${k} of its life: ${m.d.toFixed(4)} on the explosion box over ${(m.kept * 100).toFixed(1)}% (${k === BLAST_PEAK ? `the peak: Level A max ${thr}` : 'reported'}); laid out ${JSON.stringify(g.fx)}`)
        // Both ends: the scene's still laid out, minus its explosion, plus the game's — the same parts as the still.
        if (!(g.fx.worldDraws === true && g.fx.smoke === on.fx.smoke && g.fx.discs === on.fx.discs && g.fx.soft === on.fx.soft && g.fx.ribbons === on.fx.ribbons)) problems.push(`game-blast k ${k}: laid out ${JSON.stringify(g.fx)}, the still ${JSON.stringify(on.fx)}`)
        if (k === BLAST_PEAK) await shot('look-fx-game-blast')
      }
      // Looked at: the game's blast through its life, one crop of the explosion's box per age (left to right).
      const [bx0, by0, bx1, by1] = ex.box
      const cw = bx1 - bx0
      const chh = by1 - by0
      const strip = new PNG({ width: STRIP_KS.length * (cw + 4), height: chh })
      strip.data.fill(255)
      for (const [i, k] of STRIP_KS.entries()) {
        const g = await lab(own, origin, `game-blast&blastk=${k}`)
        for (let y = 0; y < chh; y++) Buffer.from(g.frame.data.buffer, g.frame.data.byteOffset + ((by0 + y) * 1280 + bx0) * 4, cw * 4).copy(strip.data, (y * strip.width + i * (cw + 4)) * 4)
      }
      writeFileSync(join(root, 'shots/look-fx-game-blast-strip.png'), PNG.sync.write(strip))
      log(`looked at: shots/look-fx-game-blast-strip.png (the game's blast at ${STRIP_KS.join(', ')} of its life)`)
      const ctl = masked(off.frame, ref, off.frame, refOff, ex.box).d
      log(`game path at its peak: ${peak.toFixed(4)} (Level A max ${thr}); no explosion on the same box ${ctl.toFixed(3)} (must fail)`)
      if (!(peak <= thr)) problems.push(`Level A on the game path's blast at its peak: ${peak.toFixed(4)} > ${thr}`)
      if (!(ctl > thr)) problems.push(`no explosion passes Level A on the explosion box (${ctl.toFixed(3)}) — the box cannot see it`)
    }
  } finally {
    await browser.close()
  }
  await shot('look-fx')
  if (problems.length) throw new Error(problems.join('\n'))
}
