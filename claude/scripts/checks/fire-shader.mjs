#!/usr/bin/env node
/**
 * T21.18 item 4 — fire, painted by a shader under High Quality.
 *
 *   node scripts/checks/fire-shader.mjs
 *
 * A molotov's flames are three flat circles each. With High Quality **off** that
 * picture must be exactly what it was (`fire-visible` owns it); with it **on** one
 * shader quad per flame replaces the circles.
 *
 * ## The simulation half: the fire you see covers the fire that burns you
 *
 * A flame hurts anyone within `FLAME_RADIUS` of its centre. So the assertion that
 * matters is not "something orange is there" but **every point just inside every
 * flame's damage circle is painted** — sampled at eight points on the ring, against
 * the same frozen frame with the ordnance layer hidden. **The same ring is asserted with
 * High Quality off** (T21.36): it was only reported, and read 85–108/192, because the flat
 * discs were sized from a separate `r: 7` and reached ~8 px against a damage radius of 10.
 *
 * ## The rest, as `beams-shader` and `smoke-shader`
 *
 * One frozen field both ways, with a control patch that must not move and an exact
 * restore; drawn against the layer hidden; animates while frozen — sampled over **rendered
 * frames** rather than wall clock (T22.00F; see `animation` below), where the flat flames
 * are still because their flicker runs on `render`, which a frozen scene does not call;
 * both ends — flames the layer holds against quads painted.
 *
 * `freeze` holds the field: `worldView.syncProjectiles` runs from `update`, so a frozen
 * scene neither moves nor removes a flame.
 */
import { startStack, enterBattle, standStill, selectWeapon, tally, sleep, freePort, advanceFrames, drawnFrames } from './harness.mjs'
import { samplePatch, colourDelta, photo, comparePhotos } from './pixels.mjs'

const PORT = await freePort()
const { fail, ok, finish } = tally('fire-shader')

/** A ring point counts as painted when some channel moved by more than this. */
const VISIBLE = 24
const RING_POINTS = 8

const stack = await startStack({
  port: PORT,
  label: 'fire-shader',
  env: { ROUND_SECONDS: '180', BOT_COUNT: '0', DEV_LOADOUT: '1', DEV_START_HEALTH: '150', FIXED_SEED: '4242', WEATHER: 'off' },
})
const { page, dbg, shot, pageErrors } = await stack.openClient({ name: 'ana' })
await enterBattle(page, { waitPlaying: true, label: 'fire-shader' })
const k = await page.evaluate(() => window.__game.constants())

const setHQ = (on) => page.evaluate((v) => window.__game.setHighQuality(v), on)
const freeze = (on) => page.evaluate((v) => window.__game.freeze(v), on)
const show = (on) => page.evaluate((v) => window.__game.showOrdnance(v), on)
/** Two drawn frames, or a throw naming a page that stopped rendering (T22.00C) — not the `rAF(rAF)` that hung. */
const frame = () => drawnFrames(page, 2)
const full = () => photo(page)
const grab = (r) => photo(page, r)
/** `pixels.mjs::comparePhotos` — moved there so `smoke-shader` shares it rather than copying it. */
const compare = (a, b, points = [], thr = VISIBLE, rect = null) => comparePhotos(page, a, b, { points, thr, rect })

await selectWeapon(page, 'molotov')
await standStill(page)
// Up and to the right, as `fire-visible` throws: aimed low, a molotov lands at the thrower's feet.
await page.mouse.move(1060, 200)
await sleep(400)
const off0 = await setHQ(false)
if (off0.setting !== false || off0.shaderFlames !== false) fail(`High Quality would not turn off: ${JSON.stringify(off0)}`)

const lit0 = (await dbg()).flamesSpawned ?? 0
await page.evaluate(() => window.__game.fire())
let lit = 0
for (let i = 0; i < 60 && lit < k.MOLOTOV_FLAMES; i++) {
  await sleep(200)
  lit = ((await dbg()).flamesSpawned ?? 0) - lit0
}
if (lit < k.MOLOTOV_FLAMES) fail(`the molotov lit ${lit} flame(s), expected MOLOTOV_FLAMES (${k.MOLOTOV_FLAMES})`)
else ok(`the server lit ${lit} flames`)
// Settled, on the layer's own positions: a flame still in the air is not where the fire will be.
let prev = ''
for (let i = 0; i < 25; i++) {
  await sleep(200)
  const now = JSON.stringify((await dbg()).flamesDrawnAt ?? [])
  if (now !== '[]' && now === prev) break
  prev = now
}

await freeze(true)
await frame()
const d = await dbg()
const R = k.FLAME_RADIUS * d.zoom
const onScreen = (d.flamesDrawnAt ?? [])
  .map((f) => ({ x: (f.x - d.worldView.x) * d.zoom, y: (f.y - d.worldView.y) * d.zoom }))
  .filter((p) => p.x > R + 2 && p.x < 1280 - R - 2 && p.y > R + 2 && p.y < 600 - R)
console.log(`  ${(d.flamesDrawnAt ?? []).length} flame(s) held by the layer, ${onScreen.length} on camera; damage radius ${R.toFixed(1)} screen px`)
if (onScreen.length < 2) {
  fail(`only ${onScreen.length} flame(s) on camera — nothing below would be a claim about fire`)
} else {
  const xs = onScreen.map((p) => p.x)
  const ys = onScreen.map((p) => p.y)
  const pad = Math.ceil(R * 2)
  const bx = Math.max(0, Math.floor(Math.min(...xs) - pad))
  const by = Math.max(0, Math.floor(Math.min(...ys) - pad * 2))
  const band = { x: bx, y: by, w: Math.min(1280, Math.ceil(Math.max(...xs) + pad)) - bx, h: Math.min(600, Math.ceil(Math.max(...ys) + pad)) - by }
  const P = 60
  const corners = [
    { x: 8, y: 40 },
    { x: 1280 - 8 - P, y: 40 },
    { x: 8, y: 520 },
    { x: 1280 - 8 - P, y: 520 },
  ].filter((c) => c.x + P < band.x || c.x > band.x + band.w || c.y + P < band.y || c.y > band.y + band.h)
  const ctrl = corners.length ? { ...corners[0], w: P, h: P } : null
  if (!ctrl) fail(`no control corner clears the fire (band ${JSON.stringify(band)})`)
  // Just inside each damage circle: one screen px in from the ring, eight directions.
  const ring = onScreen.flatMap((p) =>
    Array.from({ length: RING_POINTS }, (_, i) => {
      const a = (i / RING_POINTS) * Math.PI * 2
      return { x: p.x + Math.cos(a) * (R - 1), y: p.y + Math.sin(a) * (R - 1) }
    }),
  )

  // --- one field, both ways, same instant -------------------------------------------
  const offFrame = await full()
  const offBand = await samplePatch(page, band)
  const offCtrl = ctrl ? await samplePatch(page, ctrl) : null
  const offDrawn = (await dbg()).flameShadersDrawn
  await shot('fire-shader-off')
  const on = await setHQ(true)
  await frame()
  const onFrame = await full()
  const onDrawn = (await dbg()).flameShadersDrawn
  const onBand = await samplePatch(page, band)
  const onCtrl = ctrl ? await samplePatch(page, ctrl) : null
  await shot('fire-shader-on')
  await show(false)
  await frame()
  const hiddenFrame = await full()
  const noneBand = await samplePatch(page, band)
  const noneCtrl = ctrl ? await samplePatch(page, ctrl) : null
  await show(true)
  const back = await setHQ(false)
  await frame()
  const backFrame = await full()
  const backBand = await samplePatch(page, band)
  const backCtrl = ctrl ? await samplePatch(page, ctrl) : null

  const moved = colourDelta(offBand, onBand)
  const ctrlMoved = ctrl ? Math.max(colourDelta(offCtrl, onCtrl), colourDelta(offCtrl, backCtrl)) : 0
  const restored = colourDelta(offBand, backBand)
  const drawn = colourDelta(onBand, noneBand)
  const drift = ctrl ? colourDelta(onCtrl, noneCtrl) : 0
  const floor = Math.max(4, drift * 3)
  console.log(
    `  frozen field: flat->painted ${moved.toFixed(1)}, painted->flat ${restored.toFixed(1)}, control ${ctrlMoved.toFixed(1)}; ` +
      `painted vs hidden ${drawn.toFixed(1)} (floor ${floor.toFixed(1)}); quads off ${offDrawn}, on ${onDrawn}, back ${(await dbg()).flameShadersDrawn}`,
  )
  if (!on.shaderFlames) fail(`High Quality on did not select the flame shader: ${JSON.stringify(on)} — no WebGL?`)
  if (offDrawn !== 0) fail(`${offDrawn} flame quads painted with High Quality off`)
  const want = Math.min((d.flamesDrawnAt ?? []).length, k.FLAME_SHADER_POOL)
  if (onDrawn !== want) fail(`High Quality on painted ${onDrawn} flame quads for ${(d.flamesDrawnAt ?? []).length} flames (pool ${k.FLAME_SHADER_POOL})`)
  else ok(`both ends: ${(d.flamesDrawnAt ?? []).length} flames held, ${onDrawn} quads painted; 0 with it off`)
  if (ctrlMoved > 1) fail(`the control patch moved ${ctrlMoved.toFixed(1)} while only the setting changed`)
  else ok(`control: the patch away from the fire did not move (${ctrlMoved.toFixed(1)})`)
  // **Pixels rearranged inside the fire band, not the band's mean colour** (T21.36). The
  // mean read 26.7 while the flat fire was ~8 px discs; once they were sized to cover
  // `FLAME_RADIUS` — the same ground the shader covers — it read 4.0–4.7 against a floor
  // of 4: two orange areas of one size average alike however differently they are drawn.
  // The control is the same metric between the flat frame and the flat frame restored,
  // which is exact now that the flicker clock stops with the scene.
  const rearranged = (await compare(offFrame, onFrame, [], VISIBLE, band)).fraction
  const restoreNoise = (await compare(offFrame, backFrame, [], VISIBLE, band)).fraction
  const minRearranged = Math.max(0.05, restoreNoise * 3)
  console.log(
    `  fire band: ${(rearranged * 100).toFixed(1)}% of pixels differ flat vs painted, ` +
      `${(restoreNoise * 100).toFixed(1)}% flat vs flat restored (floor ${(minRearranged * 100).toFixed(1)}%); band mean moved ${moved.toFixed(1)}`,
  )
  if (!(rearranged > minRearranged)) fail(`flipping High Quality changed only ${(rearranged * 100).toFixed(1)}% of the fire band — the shader is not what is drawn`)
  else ok(`the same fire is painted differently with High Quality on (${(rearranged * 100).toFixed(1)}% of the band)`)
  if (back.shaderFlames !== false || restored > 1) fail(`turning High Quality off did not restore the flat fire: ${restored.toFixed(1)} from the original`)
  else ok(`off again restores the flat fire exactly (${restored.toFixed(1)})`)
  if (!(drawn > floor)) fail(`the painted fire is ${drawn.toFixed(1)} from the same frame without it, against ${floor.toFixed(1)} — nothing is drawn`)
  else ok(`the painted fire is on the screen (${drawn.toFixed(1)} against ${floor.toFixed(1)})`)

  // --- the damage circle is covered --------------------------------------------------
  const painted = await compare(onFrame, hiddenFrame, ring, VISIBLE)
  const flat = await compare(offFrame, hiddenFrame, ring, VISIBLE)
  const cover = (r) => r.points.filter(Boolean).length
  console.log(`  damage-circle points painted: High Quality on ${cover(painted)}/${ring.length}, off ${cover(flat)}/${ring.length}`)
  if (cover(painted) !== ring.length) {
    fail(`${ring.length - cover(painted)} of ${ring.length} points just inside a flame's damage circle are unpainted under High Quality — burned by fire you cannot see`)
  } else ok(`every point just inside every on-camera damage circle is painted with High Quality on (${ring.length})`)
  // T21.36: **and with it off.** This was reported, not asserted, and read 85–108/192:
  // the flat discs reached ~8 px against a burn radius of 10. The flat body is sized from
  // `FLAME_RADIUS` now (`ordnance-state.ts::flameDiscs`) — the default setting is Off, so
  // this is the picture most players see, and the one past `FLAME_SHADER_POOL` for everyone.
  if (cover(flat) !== ring.length) {
    fail(`${ring.length - cover(flat)} of ${ring.length} points just inside a flame's damage circle are unpainted with High Quality off — burned by fire you cannot see`)
  } else ok(`every point just inside every on-camera damage circle is painted with High Quality off (${ring.length})`)

  // --- it animates: frozen, over drawn frames rather than a wall clock ----------------
  //
  // **The subject is the band that covers every on-camera flame of one molotov**, in a
  // frozen scene, so the fire neither moves nor burns out between photographs. The still
  // control is that same band with High Quality off, where the flat discs do not move.
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
    `  frozen fire, most changed of ${STEPS} steps of ${STEP_FRAMES} drawn frames: ` +
      `flat ${(still.most * 100).toFixed(1)}% (${still.frames}/${still.wanted} frames in ${seconds(still)} s), ` +
      `painted ${(living.most * 100).toFixed(1)}% (${living.frames}/${living.wanted} frames in ${seconds(living)} s)`,
  )
  if (living.frames < living.wanted || still.frames < still.wanted) {
    // **Not "it does not animate"** — the distinction the wall-clock form could not make,
    // and the reason it produced two false sightings on its twin. Nothing was drawn, so
    // nothing here is evidence either way about the flame shader.
    fail(
      `the page drew ${living.frames} of ${living.wanted} frames in ${seconds(living)} s painted and ` +
        `${still.frames} of ${still.wanted} in ${seconds(still)} s flat — the box stopped rendering, ` +
        `so this says nothing about whether the flame shader animates`,
    )
  } else if (!(living.most > Math.max(0.01, still.most * 3))) {
    fail(
      `the painted fire changed ${(living.most * 100).toFixed(1)}% of its pixels at most over ` +
        `${living.frames} drawn frames (${seconds(living)} s) against ${(still.most * 100).toFixed(1)}% flat — ` +
        `the flame shader does not animate`,
    )
  } else {
    ok(
      `the painted fire animates (${(living.most * 100).toFixed(1)}% against the flat fire's ` +
        `${(still.most * 100).toFixed(1)}%, over ${living.frames} drawn frames in ${seconds(living)} s)`,
    )
  }
}

await setHQ(false)
await freeze(false)
if (pageErrors.length) fail(`page errors: ${pageErrors.slice(0, 3).join(' | ')}`)
else ok('no page errors')

await finish(() => stack.close())
