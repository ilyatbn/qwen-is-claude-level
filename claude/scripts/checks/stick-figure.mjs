/**
 * `stick-figure` — T23.14: the player is M23's stick figure, posed from the sim and drawn by code.
 *
 * ## 1. Level A on F7's pose boxes (gating)
 *
 * The look-lab's F7 (the pose sheet: idle, the 8-frame run, jump, jet, space thrust with the helmet, fall, land,
 * melee, throw, hit, dead, five aims) at the full tier against the mockup's F7 with only what the lab does not
 * draw taken out (`reference/controls/posesonly.js` → `F7-poses.png`: no text, no effect arcs or props).
 * `deltaE_actors` over F7's 24 actor boxes within this back end's actor threshold (R25, T23.12), in the reference
 * harness's browser (`actor-atlas` §1 says why). Must fail: `&knob=actor-rim-off` against the same reference.
 *
 * ## 2. Live: running moves the feet, standing does not (the sandbox, the game's renderer)
 *
 * (a) Held input: with D held the figure handed to the renderer changes frame after frame — the atlas redraws its
 * cell (`__world.actors().redraws`) and its legs differ; standing still, over as many frames, it redraws nothing
 * (the control). (b) Pixels: the scene frozen, the live figure is stepped through `pose.ts` at run speed on the
 * spot (a treadmill: the pose moves, the world does not) and the leg patch changes over 8 drawn frames; stepped at
 * speed 0 it does not change at all (the control).
 *
 * ## 3. Identity: two seats' scarves differ on screen (T23.14D F12)
 *
 * Seats 0 and 1 side by side, each figure's box counted for its own seat's scarf hue and the other's. Control: both
 * seat 0, and the right box reads seat 0 — the count is of the colour, not the place.
 */
import { writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { actorBoxes, boxesDeltaE, loadPng, thresholdsFor } from '../lib/look-compare.mjs'
import { HIGH_QUALITY_KEY } from '../lib/check-tier.mjs'
import { chromePath, libDir } from '../lib/browser-args.mjs'
import { REFERENCE_ARGS } from './actor-atlas.mjs'
import { decode, freezeStill, frameWith, rectDelta } from './figure-frames.mjs'

const root = join(dirname(fileURLToPath(import.meta.url)), '../..')
const require = createRequire(join(root, 'client/package.json'))
const { chromium } = require('playwright-core')
const { PNG } = require('pngjs')
const RAW = JSON.parse((await import('node:fs')).readFileSync(join(root, 'scripts/lib/look-thresholds.json'), 'utf8'))
/** F7's cast: 23 figures and the landing's dust (`scenes/F7.ts`, counted against `variant_F7.js` by `scenes.test.ts`). */
const F7_ACTORS = 24
/** A stretch of seed 4242 a body can run along to the right (its centre, mask px). */
const RUNWAY = [1000, 734]
/** Drawn frames each live leg watches. */
const FRAMES = 8
/** Mean |Δ| per channel between consecutive treadmill frames the leg patch must reach at least once (levels). */
const LEG_MIN = 2

async function lab(page, origin, extra) {
  await page.goto(`${origin}/?look=F7&e2e=1${extra}`, { waitUntil: 'load' })
  await page.waitForFunction(() => window.__look && (window.__look.ready || window.__look.error) && !!window.__world, null, { timeout: 120_000 })
  const look = await page.evaluate(() => JSON.parse(JSON.stringify(window.__look)))
  if (look.error) throw new Error(`look-lab F7${extra}: ${look.error}`)
  const f = decode(await page.evaluate(() => window.__world.readFrame()))
  return { look, frame: f, info: await page.evaluate(() => window.__world.info()), actors: await page.evaluate(() => window.__world.actors()) }
}

export default async function ({ page, shot, log }) {
  const origin = new URL(page.url()).origin
  const boxes = actorBoxes('F7')
  const reference = loadPng(join(root, 'tasks/M23/reference/controls/F7-poses.png'))
  const problems = []

  // ------------------------------------------------------------ 1. Level A on the pose sheet
  const browser = await chromium.launch({ executablePath: chromePath, env: { ...process.env, LD_LIBRARY_PATH: libDir }, headless: true, args: REFERENCE_ARGS })
  try {
    const own = await browser.newPage({ viewport: { width: 1280, height: 720 }, deviceScaleFactor: 1 })
    await own.goto(`${origin}/?e2e=1`, { waitUntil: 'load' })
    await own.evaluate((k) => localStorage.setItem(k, '1'), HIGH_QUALITY_KEY)
    const on = await lab(own, origin, '')
    const TH = thresholdsFor(RAW, on.info.gpu)
    const T = TH.actors
    if (TH.backEnd !== 'swiftshader') throw new Error(`F7's reference is SwiftShader's; the ${TH.backEnd} set has no F7 reference yet`)
    if (on.look.described.actors !== F7_ACTORS || on.actors.quads !== F7_ACTORS) problems.push(`counted: described ${on.look.described.actors}, quads ${on.actors.quads}, want ${F7_ACTORS}`)
    const d = boxesDeltaE(on.frame, reference, boxes)
    log(`1. look-lab F7 vs F7-poses.png on ${boxes.length} pose boxes: deltaE_actors ${d.toFixed(4)} (max ${T.threshold}) ${d <= T.threshold ? 'ok' : 'FAIL'}`)
    for (const [k, b] of boxes.entries()) log(`   box ${String(k).padStart(2)} ${JSON.stringify(b).padEnd(22)} ${boxesDeltaE(on.frame, reference, [b]).toFixed(3)}`)
    if (d > T.threshold) problems.push(`Level A: deltaE_actors ${d.toFixed(4)} > ${T.threshold}`)
    const off = await lab(own, origin, '&knob=actor-rim-off')
    const dOff = boxesDeltaE(off.frame, reference, boxes)
    log(`1. control knob=actor-rim-off: ${dOff.toFixed(4)} ${dOff > T.threshold ? 'fails, as it must' : 'PASSES — the check cannot see the rim'}`)
    if (!(dOff > T.threshold)) problems.push(`control actor-rim-off passed (${dOff.toFixed(4)})`)
    const out = new PNG({ width: 1280 * 2 + 8, height: 720 })
    out.data.fill(255)
    for (let y = 0; y < 720; y++) for (const [img, x0] of [[on.frame, 0], [reference, 1288]]) Buffer.from(img.data.buffer, img.data.byteOffset + y * 5120, 5120).copy(out.data, (y * out.width + x0) * 4)
    writeFileSync(join(root, 'shots/stick-figure-F7-lab-vs-mockup.png'), PNG.sync.write(out))
  } finally {
    await browser.close()
  }

  // ------------------------------------------------------------ 2a. live input: running redraws, standing does not
  await page.waitForFunction(() => window.__game && window.__world && window.__world.litTerrain()?.drawn, null, { timeout: 120_000 })
  const redrawsOver = async (n) => {
    const r0 = (await page.evaluate(() => window.__world.actors())).redraws
    const f0 = await page.evaluate(() => window.__world.loopFrame())
    await page.waitForFunction(([f, n]) => window.__world.loopFrame() >= f + n, [f0, n], { timeout: 30_000 })
    return (await page.evaluate(() => window.__world.actors())).redraws - r0
  }
  // Seed 4242's spawn runs into a wall within a few frames; this stretch carries a body ~250 px in 1.8 s (found by
  // trying the map's surfaces, T23.14) — running must mean moving for the whole leg.
  await page.evaluate(([x, y]) => window.__game.place(x, y), RUNWAY)
  await freezeStill(page)
  await page.evaluate(() => window.__game.freeze(false))
  // The body is still; let its figure settle too (the landing crouch, the scarf's lag): until a stretch of frames
  // passes with no redraw, or 3 s — under load a second of wall is too few frames (red once in the suite, 2 redraws).
  for (let i = 0; i < 15 && (await redrawsOver(FRAMES)) !== 0; i++);
  const still = await redrawsOver(3 * FRAMES)
  const x0 = (await page.evaluate(() => window.__game.debug())).player.x
  await page.keyboard.down('d')
  await page.waitForTimeout(150)
  const running = await redrawsOver(3 * FRAMES)
  await page.keyboard.up('d')
  const ran = (await page.evaluate(() => window.__game.debug())).player.x - x0
  log(`2a. the body ran ${ran.toFixed(1)} px`)
  if (!(ran > 20)) problems.push(`the running leg's body moved only ${ran.toFixed(1)} px`)
  log(`2a. over ${3 * FRAMES} frames: standing ${still} redraws (control: 0), running ${running} (min ${FRAMES})`)
  if (still !== 0) problems.push(`standing still the figure was redrawn ${still} times`)
  if (!(running >= FRAMES)) problems.push(`running the figure was redrawn only ${running} times in ${3 * FRAMES} frames`)

  // ------------------------------------------------------------ 2b. pixels: the leg patch on a treadmill
  const d0 = await freezeStill(page)
  const a = d0.figure
  const s = a.opts.s
  const legs = [a.x - 10 * s, a.y - 13 * s, a.x + 10 * s, a.y + 1 * s]
  const treadmill = async (vx) => {
    const Js = await page.evaluate(async ([vx, n, x]) => {
      const P = await import('/src/look/actors/pose.ts')
      const st = P.newFigureState()
      const out = []
      for (let i = 0; i < n * 3; i++) {
        const d = P.stepFigure(st, { dt: 1 / 60, vx, vy: 0, aim: 0, alive: true, grounded: true, jetpack: false, space: false, thrust: null, weapon: 'smg', boots: false, wings: false, walkSpeed: 150, s: 1.15, x: x + (vx * i) / 60, groundDy: () => 0 })
        if (i % 3 === 0) out.push(d.J)
      }
      return out
    }, [vx, FRAMES, a.x])
    const frames = []
    for (const J of Js) frames.push(await frameWith(page, [{ ...a, opts: { ...a.opts, J, face: 1 } }]))
    let most = 0
    let sum = 0
    for (let i = 1; i < frames.length; i++) {
      const m = rectDelta(frames[i], frames[i - 1], legs).mean
      most = Math.max(most, m)
      sum += m
    }
    return { most, sum }
  }
  const run = await treadmill(150)
  await shot('stick-figure-run')
  const stand = await treadmill(0)
  log(`2b. leg patch ${JSON.stringify(legs.map(Math.round))} over ${FRAMES} drawn frames: running most ${run.most.toFixed(2)} (min ${LEG_MIN}), standing total ${stand.sum.toFixed(3)} (control: 0)`)
  if (!(run.most >= LEG_MIN)) problems.push(`running moved the leg patch by only ${run.most.toFixed(2)}`)
  if (stand.sum !== 0) problems.push(`standing still the leg patch changed by ${stand.sum.toFixed(3)}`)
  await page.evaluate(() => {
    window.__world.setActors(null)
    window.__game.freeze(false)
  })

  // ------------------------------------------------------------ 3. identity: two seats' scarves differ on screen
  // T23.14D F12. Skins are drawn as nothing (R8), so a player is told apart by the seat's scarf (R10) — read off the
  // world canvas: seats 0 and 1 stood side by side (`showSeats` builds them through `PlayerView`, the path every scene
  // draws players with); in each figure's box, the pixels of its own seat's hue and of the other's are counted.
  // Control: both figures seat 0 — the right one's box then shows seat 0's hue, not seat 1's (the count reads the
  // colour, not the place).
  const scarves = await identity(page, [0, 1], 'shots/stick-figure-scarves.png')
  const same = await identity(page, [0, 0])
  log(`3. scarves, seats 0 | 1: left ${JSON.stringify(scarves[0])}, right ${JSON.stringify(scarves[1])}; control seats 0 | 0: right ${JSON.stringify(same[1])}`)
  if (!(scarves[0].own >= scarves[0].min && scarves[0].other <= SCARF_STRAY)) problems.push(`seat 0's figure does not show seat 0's scarf alone: ${JSON.stringify(scarves[0])}`)
  if (!(scarves[1].own >= scarves[1].min && scarves[1].other <= SCARF_STRAY)) problems.push(`seat 1's figure does not show seat 1's scarf alone: ${JSON.stringify(scarves[1])}`)
  if (!(same[1].other >= same[1].min && same[1].own <= SCARF_STRAY)) problems.push(`control: a seat-0 figure on the right did not read as seat 0: ${JSON.stringify(same[1])}`)
  if (problems.length) throw new Error(`stick-figure: ${problems.join('; ')}`)
}

/**
 * §3: a figure's box must hold this much of its seat's scarf hue, and at most this many px of the other seat's.
 * T23.10: in **world px²** — set as 6 buffer px when a world px was a buffer px (zoom 2, low tier); at zoom 1 the low
 * tier draws a world px as ½ × ½ buffer px, so the scarf is a quarter of the pixels it was (`scarfMin(k)`).
 */
const SCARF_MIN_WORLD = 6
const scarfMin = (k) => Math.max(2, Math.round(SCARF_MIN_WORLD * k * k))
const SCARF_STRAY = 1
/** §3: a pixel "is" a seat's colour within this many degrees of its hue, at saturation and value over these. */
const HUE_TOL = 20
const SAT_MIN = 0.35
const VAL_MIN = 0.25
/** §3: the two figures stand this far either side of the runway spot (world px). */
const APART = 60

function hsv(r, g, b) {
  const mx = Math.max(r, g, b)
  const mn = Math.min(r, g, b)
  const d = mx - mn
  let h = 0
  if (d > 0) h = mx === r ? ((g - b) / d) % 6 : mx === g ? (b - r) / d + 2 : (r - g) / d + 4
  return { h: (h * 60 + 360) % 360, s: mx ? d / mx : 0, v: mx / 255 }
}
const hueGap = (a, b) => Math.min(Math.abs(a - b), 360 - Math.abs(a - b))

/** Stand seats `pair` left and right of the runway, freeze, and count each box's seat-0 / seat-1 hue pixels. */
async function identity(page, pair, save = null) {
  const { colours, feetDy } = await page.evaluate(async () => {
    const V = await import('/src/render/playerView.ts')
    return { colours: [...V.SCARF_COLOURS], feetDy: window.__game.constants().PLAYER_H / 2 }
  })
  const hue = (hex) => hsv(parseInt(hex.slice(1, 3), 16), parseInt(hex.slice(3, 5), 16), parseInt(hex.slice(5, 7), 16)).h
  const hues = [hue(colours[0]), hue(colours[1])]
  const [cx, cy] = RUNWAY
  await page.evaluate(([pair, cx, cy, apart]) => {
    window.__game.place(cx, cy - 200)
    window.__game.showSeats([{ seat: pair[0], x: cx - apart, y: cy }, { seat: pair[1], x: cx + apart, y: cy }])
  }, [pair, cx, cy, APART])
  const raf = () => page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))))
  await raf()
  await page.evaluate(() => window.__game.freeze(true))
  await raf()
  const f = decode(await page.evaluate(() => window.__world.readFrame()))
  await page.evaluate(() => {
    window.__game.showSeats(null)
    window.__game.freeze(false)
  })
  const k = f.width / f.view.w
  if (save) {
    // The frame the counts read, cropped round the pair (both boxes), at 4×.
    const Z = 4
    const x0 = Math.max(0, Math.floor((cx - APART - 40 - f.view.x) * k))
    const x1 = Math.min(f.width, Math.ceil((cx + APART + 40 - f.view.x) * k))
    const y0 = Math.max(0, Math.floor((cy - 50 - f.view.y) * k))
    const y1 = Math.min(f.height, Math.ceil((cy + feetDy + 12 - f.view.y) * k))
    const out = new PNG({ width: (x1 - x0) * Z, height: (y1 - y0) * Z })
    for (let y = 0; y < out.height; y++) {
      for (let x = 0; x < out.width; x++) {
        const o = ((y0 + Math.floor(y / Z)) * f.width + x0 + Math.floor(x / Z)) * 4
        const q = (y * out.width + x) * 4
        for (let c = 0; c < 3; c++) out.data[q + c] = f.data[o + c]
        out.data[q + 3] = 255
      }
    }
    writeFileSync(join(root, save), PNG.sync.write(out))
  }
  return [-1, 1].map((side, i) => {
    const x = cx + side * APART
    const feet = cy + feetDy
    const box = [x - 28, feet - 48, x + 28, feet + 4]
    const n = { own: 0, other: 0 }
    const seat = pair[i]
    for (let y = 0; y < f.height; y++) {
      const my = f.view.y + (y + 0.5) / k
      if (my < box[1] || my >= box[3]) continue
      for (let px = 0; px < f.width; px++) {
        const mx = f.view.x + (px + 0.5) / k
        if (mx < box[0] || mx >= box[2]) continue
        const o = (y * f.width + px) * 4
        const c = hsv(f.data[o], f.data[o + 1], f.data[o + 2])
        if (c.s < SAT_MIN || c.v < VAL_MIN) continue
        // `own` is the hue of the seat this box's figure is meant to wear (seat 1 on the right of the real pair).
        const want = i === 1 ? 1 : 0
        if (hueGap(c.h, hues[want]) <= HUE_TOL) n.own++
        else if (hueGap(c.h, hues[1 - want]) <= HUE_TOL) n.other++
      }
    }
    return { seat, ...n, min: scarfMin(k) }
  })
}
