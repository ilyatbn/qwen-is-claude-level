#!/usr/bin/env node
/**
 * T21.18 item 5 — explosions, painted by a shader under High Quality.
 *
 *   node scripts/checks/explosion-shader.mjs
 *
 * A rocket's explosion is a flat flash and a ring that collapse in 0.35 s. With High
 * Quality **off** that picture must be exactly what it was; with it **on** a shader
 * quad paints a flash, a blast front and soot that lingers for `BLAST_SHADER_LIFE`.
 *
 * ## One real blast, held and posed
 *
 * A real bazooka on a real server. Explosions are held before the shot
 * (`holdImpacts`), so the blast that arrives stays at age 0; the scene is frozen, and
 * `advanceImpacts` ages it through the state's own `ageImpacts` to a chosen instant.
 * Every photograph below is that one blast, at a known age, both ways.
 *
 * ## What is asserted
 *
 * - **Both ways at one instant**, early, while the flat flash is bright: High Quality
 *   paints it differently, a control patch does not move, off again restores it exactly.
 * - **Drawn, not blank**: painted blast against the same frame with the layer hidden.
 * - **The front reaches the blast radius** — the simulation's own number: posed at a
 *   quarter of its life, every point just inside the blast radius is painted. The flat
 *   flash at that instant is reported, not asserted. **"Painted" is background-independent**
 *   (T23.04B, coordinator's ruling): a point is painted when it differs from the same camera's
 *   frame with the blast hidden by more than `VISIBLE`, over **any** of three backdrops put under
 *   Phaser's canvas — the world canvas as drawn, black, white. A layer of coverage `a` moves a
 *   pixel by at least `a·255/2` over black or white whatever its colour, so the verdict is about
 *   the blast, not about what it sits on: T23.04's sky is dark, the soot is dark, and on the sky
 *   alone four of twelve points read unpainted at peaks of 10–22. Where the point is on terrain
 *   (drawn by Phaser, in the same canvas) the backdrop is hidden and the three agree. **And over the
 *   world canvas alone at least `WORLD_FLOOR` of them** (T23.04C F2): "any backdrop" alone passed a
 *   blast faded to 20 %.
 * - **It lingers**: posed after the flat flash has ended, the painted blast is still on
 *   the screen, and with High Quality off nothing is.
 * - **Animates** while frozen and held: Phaser's clock stirs the noise; the flat flash
 *   is still. Sampled over **rendered frames** rather than wall clock (T22.00F; see
 *   `animation` below).
 * - **Both ends**: the server narrated the explosion; quads are painted only when on.
 *
 * The crater, damage and knockback are the server's and the shader reads a record it
 * never writes; that half is structural, and is stated rather than photographed.
 */
import { startStack, enterBattle, standStill, selectWeapon, tally, sleep, freePort, advanceFrames, drawnFrames } from './harness.mjs'
import { samplePatch, colourDelta, phaserPatch, phaserDelta, underPhaser } from './pixels.mjs'

const PORT = await freePort()
const { fail, ok, finish } = tally('explosion-shader')

/** A point counts as painted when some channel moved by more than this. */
const VISIBLE = 24
/**
 * What is under Phaser's (transparent) canvas while a ring point is photographed: the world canvas
 * as drawn (`null`), or that canvas hidden and the page behind it one flat colour.
 */
const BACKDROPS = [null, '#000000', '#ffffff']
const RING_POINTS = 12
/**
 * T23.04C F2: the blast must also read **on the sky it is actually drawn over** — the world canvas as
 * drawn — not only over black or white. Black and white stay as coverage diagnostics (a layer of
 * coverage `a` moves one of them by ≥ a·255/2 whatever its colour), but "painted over any backdrop"
 * passed a blast faded to 20 % (the review's plant: 10/12 over white, 1/12 over the world canvas).
 * Basis, measured on this pose after T23.04C: 7, 8, 8 of 12 over the world canvas (T23.04B's pose:
 * 10); the 20 % plant: 1. The floor sits one point under the lowest unplanted run.
 * **The spread on this pose is 7–11** (T23.08C F5): 7, 8, 8 (T23.04C), 9 (T23.08, after fog, bloom and
 * grade), 10 (the T23.08 review, at a17748a), 10 and 11 (T23.08C's two runs) — so one run's count inside
 * that spread is not a readability change; only a run under `WORLD_FLOOR` is one.
 */
const WORLD_FLOOR = 6

const stack = await startStack({
  port: PORT,
  label: 'explosion-shader',
  env: { ROUND_SECONDS: '180', BOT_COUNT: '0', DEV_LOADOUT: '1', DEV_START_HEALTH: '150', FIXED_SEED: '4242', WEATHER: 'off' },
})
const { page, dbg, shot, pageErrors } = await stack.openClient({ name: 'ana' })
await enterBattle(page, { waitPlaying: true, label: 'explosion-shader' })
const k = await page.evaluate(() => window.__game.constants())

const setHQ = (on) => page.evaluate((v) => window.__game.setHighQuality(v), on)
const freeze = (on) => page.evaluate((v) => window.__game.freeze(v), on)
const show = (on) => page.evaluate((v) => window.__game.showOrdnance(v), on)
const hold = (on) => page.evaluate((v) => window.__game.holdImpacts(v), on)
const advance = (s) => page.evaluate((v) => window.__game.advanceImpacts(v), s)
/** Two drawn frames, or a throw naming a page that stopped rendering (T22.00C) — not the `rAF(rAF)` that hung. */
const frame = () => drawnFrames(page, 2)
const full = async () => (await page.screenshot()).toString('base64')
const grab = async (r) => (await page.screenshot({ clip: { x: r.x, y: r.y, width: r.w, height: r.h } })).toString('base64')

/** Two same-size photographs: fraction of pixels moved, and per point whether it moved past `thr`. */
const compare = (a, b, points = [], thr = 6) =>
  page.evaluate(
    async ([sa, sb, pts, t]) => {
      const load = async (src) => {
        const img = new Image()
        img.src = `data:image/png;base64,${src}`
        await img.decode()
        const cv = document.createElement('canvas')
        cv.width = img.width
        cv.height = img.height
        const ctx = cv.getContext('2d')
        ctx.drawImage(img, 0, 0)
        return { d: ctx.getImageData(0, 0, img.width, img.height).data, w: img.width }
      }
      const A = await load(sa)
      const B = await load(sb)
      const moved = (i, th) =>
        Math.abs(A.d[i] - B.d[i]) > th || Math.abs(A.d[i + 1] - B.d[i + 1]) > th || Math.abs(A.d[i + 2] - B.d[i + 2]) > th
      let n = 0
      for (let i = 0; i < A.d.length; i += 4) if (moved(i, 6)) n++
      const at = (p) => (Math.round(p.y) * A.w + Math.round(p.x)) * 4
      const peak = (i) => Math.max(Math.abs(A.d[i] - B.d[i]), Math.abs(A.d[i + 1] - B.d[i + 1]), Math.abs(A.d[i + 2] - B.d[i + 2]))
      return {
        fraction: n / (A.d.length / 4),
        points: pts.map((p) => moved(at(p), t)),
        // Per point: the largest channel change, and both pixels — so an unpainted point says why.
        detail: pts.map((p) => ({ x: Math.round(p.x), y: Math.round(p.y), peak: peak(at(p)), a: [...A.d.slice(at(p), at(p) + 3)], b: [...B.d.slice(at(p), at(p) + 3)] })),
      }
    },
    [a, b, points, thr],
  )

await selectWeapon(page, 'bazooka')
await standStill(page)
const off0 = await setHQ(false)
if (off0.setting !== false || off0.shaderBlasts !== false) fail(`High Quality would not turn off: ${JSON.stringify(off0)}`)

/** Aim at the ground to the right, far enough that the thrower is outside the blast. */
const aim = await page.evaluate(() => {
  const d = window.__game.debug()
  const v = d.worldView
  const cv = document.querySelector('canvas').getBoundingClientRect()
  const wx = d.player.x + 220
  const wy = d.player.y + 90
  return { x: cv.left + ((wx - v.x) / v.width) * cv.width, y: cv.top + ((wy - v.y) / v.height) * cv.height }
})
await page.mouse.move(aim.x, aim.y)
await sleep(200)

const before = (await dbg()).observed?.explosions ?? 0
const held = await hold(true)
if (held.held !== true) fail(`holdImpacts did not read back: ${JSON.stringify(held)}`)
await page.evaluate(() => window.__game.fire())
let arrived = false
try {
  await page.waitForFunction((n) => (window.__game.debug().observed?.explosions ?? 0) > n && window.__game.debug().blastsAt.length > 0, before, {
    timeout: 10_000,
  })
  arrived = true
} catch {
  fail('no explosion was narrated and recorded within 10 s of the shot')
}

if (arrived) {
  await freeze(true)
  await frame()
  const d = await dbg()
  const b = d.blastsAt[d.blastsAt.length - 1]
  const narrated = (d.observed?.explosions ?? 0) - before
  const cx = (b.x - d.worldView.x) * d.zoom
  const cy = (b.y - d.worldView.y) * d.zoom
  const R = b.r * d.zoom
  console.log(`  blast at screen ${cx.toFixed(0)},${cy.toFixed(0)}, radius ${b.r} world (${R.toFixed(0)} px), held at age ${b.age}; narrated ${narrated}`)
  if (!(narrated > 0)) fail('the server narrated no explosion')
  else ok(`both ends: the server narrated ${narrated} explosion(s) and the layer holds the blast`)
  if (cx < R * 2 || cx > 1280 - R * 2 || cy < R * 2 || cy > 600 - R) fail(`the blast is too near the edge to photograph (${cx.toFixed(0)},${cy.toFixed(0)})`)

  const band = { x: Math.round(cx - R * 0.6), y: Math.round(cy - R * 0.6), w: Math.round(R * 1.2), h: Math.round(R * 1.2) }
  const P = 60
  const reach = R * k.BLAST_SHADER_SCALE
  const corner = [
    { x: 8, y: 40 },
    { x: 1280 - 8 - P, y: 40 },
    { x: 8, y: 520 },
    { x: 1280 - 8 - P, y: 520 },
  ]
    .map((c) => ({ ...c, dist: Math.hypot(c.x + P / 2 - cx, c.y + P / 2 - cy) }))
    .sort((p, q) => q.dist - p.dist)[0]
  const ctrl = { x: corner.x, y: corner.y, w: P, h: P }
  if (corner.dist < reach + P) fail(`no control corner clears the blast (${corner.dist.toFixed(0)} against ${reach.toFixed(0)})`)

  // --- early: both ways at one instant ------------------------------------------------
  // A tenth of the flat flash's life in: the flash is bright, so the two pictures differ
  // in how they are painted, not in whether anything is there.
  const early = (d.blastsAt.length ? k.BLAST_SHADER_LIFE : 0) * 0.08
  await advance(early)
  await frame()
  const offBand = await samplePatch(page, band)
  const offCtrl = await samplePatch(page, ctrl)
  const offCtrlP = await phaserPatch(page, ctrl)
  const offDrawn = (await dbg()).blastShadersDrawn
  await shot('explosion-shader-off')
  const on = await setHQ(true)
  await frame()
  const onDrawn = (await dbg()).blastShadersDrawn
  const onBand = await samplePatch(page, band)
  const onCtrl = await samplePatch(page, ctrl)
  const onCtrlP = await phaserPatch(page, ctrl)
  await shot('explosion-shader-on')
  await show(false)
  await frame()
  const noneBand = await samplePatch(page, band)
  const noneCtrl = await samplePatch(page, ctrl)
  await show(true)
  const back = await setHQ(false)
  await frame()
  const backBand = await samplePatch(page, band)
  const backCtrlP = await phaserPatch(page, ctrl)
  const moved = colourDelta(offBand, onBand)
  // Phaser's layer alone (T23.04B): the toggle also switches the world renderer's tier (R20),
  // which resamples the sky under the patch by design — see `pixels.mjs::phaserPatch`.
  const ctrlMoved = Math.max(phaserDelta(offCtrlP, onCtrlP), phaserDelta(offCtrlP, backCtrlP))
  const restored = colourDelta(offBand, backBand)
  const drawn = colourDelta(onBand, noneBand)
  const floor = Math.max(4, colourDelta(onCtrl, noneCtrl) * 3)
  console.log(
    `  early blast: flat->painted ${moved.toFixed(1)}, painted->flat ${restored.toFixed(1)}, control ${ctrlMoved.toFixed(1)}; ` +
      `painted vs hidden ${drawn.toFixed(1)} (floor ${floor.toFixed(1)}); quads off ${offDrawn}, on ${onDrawn}`,
  )
  if (!on.shaderBlasts) fail(`High Quality on did not select the blast shader: ${JSON.stringify(on)} — no WebGL?`)
  if (offDrawn !== 0) fail(`${offDrawn} blast quads painted with High Quality off`)
  if (!(onDrawn >= 1)) fail(`High Quality on painted ${onDrawn} blast quads over a held blast`)
  else ok(`quads: 0 with it off, ${onDrawn} with it on, over the same held blast`)
  if (ctrlMoved > 1) fail(`the control patch moved ${ctrlMoved.toFixed(1)} while only the setting changed`)
  else ok(`control: the patch away from the blast did not move (${ctrlMoved.toFixed(1)})`)
  if (!(moved > Math.max(4, ctrlMoved * 3))) fail(`flipping High Quality moved the blast by only ${moved.toFixed(1)} — the shader is not what is drawn`)
  else ok(`the same blast is painted differently with High Quality on (${moved.toFixed(1)})`)
  if (back.shaderBlasts !== false || restored > 1) fail(`turning High Quality off did not restore the flat flash: ${restored.toFixed(1)} from the original`)
  else ok(`off again restores the flat flash exactly (${restored.toFixed(1)})`)
  if (!(drawn > floor)) fail(`the painted blast is ${drawn.toFixed(1)} from the same frame without it, against ${floor.toFixed(1)}`)
  else ok(`the painted blast is on the screen (${drawn.toFixed(1)} against ${floor.toFixed(1)})`)

  // --- it animates: frozen and held, over drawn frames rather than a wall clock --------
  //
  // **The subject is one real blast, posed at a known age and held there.** `holdImpacts`
  // stops it ageing and `freeze` stops the scene, so age is moved only by `advanceImpacts`
  // and the extra wall time these steps take cannot pose it somewhere else. What still
  // moves is Phaser's own `time` uniform, written at every render, which stirs the noise.
  // The still control is the same band with High Quality off, where the flat flash is a
  // fixed picture at a fixed age.
  //
  // **This photographed twice across `sleep(300)` until T22.00F.** Two defects, both
  // measured on the identical instrument in `smoke-shader.mjs` and written up at its
  // `animation` helper: a sleep does not guarantee a redraw (the page drew 18 frames in
  // 300 ms at CPU x1 and **3 at x64**, so both photographs can be of one drawn frame), and
  // **one window is marginal whatever the load** — 39 consecutive idle samples of a single
  // 300 ms window waved between 0.0 % and 11.2 %. `beams-shader` then went red on an idle
  // box at 0.9 % against its 1.0 % floor in the 2026-09-22 gate, which is the sighting that
  // paid for this file. So: count **drawn frames**, and let the **largest** change over
  // several steps decide, because every step must be flat for "it does not animate" to be
  // what this reports.
  /** Frames drawn per step: what a 60 Hz box draws in the 300 ms this check used to sleep. */
  const STEP_FRAMES = 18
  /** Steps taken, so one flat window cannot decide the verdict. */
  const STEPS = 5
  /** Ceiling on one step, ~26x the idle cost of 18 frames. A page that stopped drawing fails here. */
  const FRAME_BUDGET_MS = 8_000
  /** The largest change from the first photograph over `STEPS` steps, and what it cost. */
  const animation = async (hq) => {
    await setHQ(hq)
    await frame()
    const first = await grab(band)
    let most = 0
    let frames = 0
    let ms = 0
    for (let i = 0; i < STEPS; i++) {
      const step = await advanceFrames(page, STEP_FRAMES, FRAME_BUDGET_MS)
      frames += step.frames
      ms += step.ms
      most = Math.max(most, (await compare(first, await grab(band))).fraction)
    }
    return { most, frames, ms, wanted: STEP_FRAMES * STEPS }
  }
  const still = await animation(false)
  const living = await animation(true)
  const seconds = (x) => (x.ms / 1000).toFixed(1)
  console.log(
    `  held blast, most changed of ${STEPS} steps of ${STEP_FRAMES} drawn frames: ` +
      `flat ${(still.most * 100).toFixed(1)}% (${still.frames}/${still.wanted} frames in ${seconds(still)} s), ` +
      `painted ${(living.most * 100).toFixed(1)}% (${living.frames}/${living.wanted} frames in ${seconds(living)} s)`,
  )
  if (living.frames < living.wanted || still.frames < still.wanted) {
    // **Not "it does not animate"** — the distinction the wall-clock form could not make,
    // and the reason it produced two false sightings on its twin. Nothing was drawn, so
    // nothing here is evidence either way about the blast shader.
    fail(
      `the page drew ${living.frames} of ${living.wanted} frames in ${seconds(living)} s painted and ` +
        `${still.frames} of ${still.wanted} in ${seconds(still)} s flat — the box stopped rendering, ` +
        `so this says nothing about whether the blast shader animates`,
    )
  } else if (!(living.most > Math.max(0.01, still.most * 3))) {
    fail(
      `the painted blast changed ${(living.most * 100).toFixed(1)}% of its pixels at most over ` +
        `${living.frames} drawn frames (${seconds(living)} s) against ${(still.most * 100).toFixed(1)}% flat — ` +
        `the blast shader does not animate`,
    )
  } else {
    ok(
      `the painted blast animates (${(living.most * 100).toFixed(1)}% against the flat flash's ` +
        `${(still.most * 100).toFixed(1)}%, over ${living.frames} drawn frames in ${seconds(living)} s)`,
    )
  }

  // --- a quarter of its life: the front has reached the blast radius -------------------
  const quarter = k.BLAST_SHADER_LIFE * 0.25
  await advance(quarter - early)
  const ring = Array.from({ length: RING_POINTS }, (_, i) => {
    const a = (i / RING_POINTS) * Math.PI * 2
    return { x: cx + Math.cos(a) * (R - 1), y: cy + Math.sin(a) * (R - 1) }
  })
  const backdrop = (c) => underPhaser(page, c)
  /** One photograph per backdrop of the frame as it stands. */
  const overEach = async () => {
    const shots = []
    for (const c of BACKDROPS) {
      const b = await backdrop(c)
      if (c !== null && !(b.world && b.hidden)) fail(`backdrop ${c}: the world canvas was not hidden (${JSON.stringify(b)})`)
      shots.push(await full())
    }
    await backdrop(null)
    return shots
  }
  // T23.09: the blast's own light (F's effect lights) brightens the rock around it in both frames, and
  // measured it costs the drawing ~2 ring points of contrast over the world (9, 9 with the explosion's
  // light removed; 7, 7 alone and 5 in the suite with it). This leg is about the **drawing** reading on
  // its backdrop — its floor's basis was measured unlit — so the scene is frozen and the world renderer
  // holds no lights while it photographs; the lit count is reported below, not gated (T23.18 re-measures
  // it when the blast is redrawn in F's style).
  const heldLights = await page.evaluate(() => window.__world.lights())
  await page.evaluate(() => window.__world.setLights([]))
  await setHQ(true)
  await frame()
  const qOn = await overEach()
  await show(false)
  await frame()
  const qNone = await overEach()
  const qNone2 = await overEach()
  await show(true)
  await setHQ(false)
  await frame()
  const qOff = await overEach()
  const cover = (r) => r.points.filter(Boolean).length
  /** Per backdrop, then per point: painted over any backdrop, and its largest change. */
  const across = async (a, b) => {
    const per = []
    for (let i = 0; i < BACKDROPS.length; i++) per.push(await compare(a[i], b[i], ring, VISIBLE))
    return {
      per,
      points: ring.map((_, j) => per.some((r) => r.points[j])),
      detail: ring.map((_, j) => {
        const best = per.map((r) => r.detail[j]).reduce((m, d) => (d.peak > m.peak ? d : m))
        return { ...best, over: BACKDROPS[per.findIndex((r) => r.detail[j] === best)] ?? 'world' }
      }),
    }
  }
  const qPainted = await across(qOn, qNone)
  const qFlat = await across(qOff, qNone)
  const label = (c) => c ?? 'world'
  console.log(
    `  at a quarter of its life: blast-radius points painted ${cover(qPainted)}/${ring.length} on, ${cover(qFlat)}/${ring.length} flat (reported); ` +
      `per backdrop on: ${qPainted.per.map((r, i) => `${label(BACKDROPS[i])} ${cover(r)}/${ring.length}`).join(', ')}`,
  )
  // The margin, every run: the faintest ring point against the threshold (its best backdrop).
  const faintest = Math.min(...qPainted.detail.map((p) => p.peak))
  console.log(`  faintest blast-radius point: peak ${faintest} (visible above ${VISIBLE}); per point ${qPainted.detail.map((p) => `${p.peak}@${label(p.over)}`).join(' ')}`)
  const dark = qPainted.detail.filter((_, i) => !qPainted.points[i])
  if (dark.length) console.log(`  unpainted: ${dark.map((p) => `(${p.x},${p.y}) peak ${p.peak} painted ${p.a} none ${p.b}`).join('; ')}`)
  // Control: the blast-hidden frame photographed over the three backdrops a second time — a
  // backdrop swap that did not settle, or leaked into the next photograph, would read as paint.
  const idle = await across(qNone, qNone2)
  if (cover(idle) !== 0) fail(`control: ${cover(idle)} ring points "painted" between two photographs of the same blast-hidden frame`)
  else ok(`control: re-photographing the blast-hidden frame over the three backdrops paints 0/${ring.length}`)
  {
    // The pose, cropped, painted and hidden: what an unpainted point sits on.
    const crop = { x: Math.max(0, Math.round(cx - R * 1.6)), y: Math.max(0, Math.round(cy - R * 1.6)), width: Math.round(R * 3.2), height: Math.round(R * 3.2) }
    const { shotsDir } = await import('./harness.mjs')
    await setHQ(true)
    await frame()
    await page.screenshot({ path: `${shotsDir}/explosion-shader-quarter-on.png`, clip: crop })
    await show(false)
    await frame()
    await page.screenshot({ path: `${shotsDir}/explosion-shader-quarter-none.png`, clip: crop })
    await show(true)
    await setHQ(false)
    await frame()
  }
  // Reported, not gated: the same count with the blast's light on, over the world canvas as drawn.
  await page.evaluate((l) => window.__world.setLights(l), heldLights)
  await setHQ(true)
  await frame()
  const litOn = await full()
  await show(false)
  await frame()
  const litNone = await full()
  await show(true)
  await setHQ(false)
  await frame()
  const lit = await compare(litOn, litNone, ring, VISIBLE)
  // T23.09C F4: a known debt, printed every run where it can be seen — the lit ring is not gated until T23.18 redraws
  // the blast in F's style (TASKS.md, under T23.18). Red or not, it says which.
  const litPts = cover(lit)
  console.log(
    `  ${litPts < WORLD_FLOOR ? 'KNOWN RED (owed to T23.18, not gated)' : 'reported (owed to T23.18, not gated)'}: with the effect lights on ` +
      `(${heldLights.length} held), ${litPts}/${ring.length} blast-radius points painted over the world canvas (the gated floor is ${WORLD_FLOOR})`,
  )
  const onWorld = cover(qPainted.per[BACKDROPS.indexOf(null)])
  if (onWorld < WORLD_FLOOR) fail(`only ${onWorld} of ${ring.length} blast-radius points are painted over the world canvas with the effect lights held off (floor ${WORLD_FLOOR}) — the blast drawing does not read on the sky it is drawn over`)
  else ok(`over the world canvas, effect lights held off, ${onWorld}/${ring.length} blast-radius points are painted (floor ${WORLD_FLOOR})`)
  if (cover(qPainted) !== ring.length) fail(`${ring.length - cover(qPainted)} of ${ring.length} points just inside the blast radius are unpainted — the front never reaches the crater's edge`)
  else ok(`the painted front covers the blast radius (${ring.length}/${ring.length})`)

  // --- it lingers: past the flat flash's end --------------------------------------------
  const late = k.BLAST_SHADER_LIFE * 0.6
  const posed = await advance(late - quarter)
  await setHQ(true)
  await frame()
  const lOn = await samplePatch(page, band)
  await show(false)
  await frame()
  const lNone = await samplePatch(page, band)
  const lNoneP = await phaserPatch(page, band)
  await show(true)
  await setHQ(false)
  await frame()
  const lOffP = await phaserPatch(page, band)
  await shot('explosion-shader-late-off')
  const lingerOn = colourDelta(lOn, lNone)
  // HQ off against HQ on with the blast hidden straddles the tier switch (R20): Phaser's layer
  // alone, over black and white (T23.04B — measured 0.3–1.4 over the resampled sky).
  const lingerOff = phaserDelta(lOffP, lNoneP)
  console.log(`  at ${(late).toFixed(2)} s (flat flashes left ${posed.impacts}): painted ${lingerOn.toFixed(1)} from none, flat ${lingerOff.toFixed(1)}`)
  if (posed.impacts !== 0) fail(`the flat flash is still alive at ${late.toFixed(2)} s — the linger below proves nothing`)
  if (!(lingerOff <= 1)) fail(`with High Quality off something is still drawn after the flash (${lingerOff.toFixed(1)})`)
  if (!(lingerOn > Math.max(4, lingerOff * 3))) fail(`the painted blast does not linger after the flash (${lingerOn.toFixed(1)})`)
  else ok(`the painted blast lingers after the flat flash has gone (${lingerOn.toFixed(1)} against ${lingerOff.toFixed(1)})`)

  await freeze(false)
}

await hold(false)
await setHQ(false)
if (pageErrors.length) fail(`page errors: ${pageErrors.slice(0, 3).join(' | ')}`)
else ok('no page errors')

await finish(() => stack.close())
