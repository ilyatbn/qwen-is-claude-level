#!/usr/bin/env node
/**
 * T21.18 item 2 — smoke clouds, painted by a shader under High Quality.
 *
 *   node scripts/checks/smoke-shader.mjs
 *
 * A smoke grenade's cloud is three flat offset circles. With High Quality **off**
 * that picture must be exactly what it was; with it **on** one shader quad per
 * cloud replaces it. And smoke blocks vision — **that is simulation and must not
 * move**: the snapshot's `vision` for a player standing in the cloud is the same
 * number in both modes.
 *
 * ## One cloud, both ways
 *
 * A real smoke grenade (`DEV_SMOKE=1`), thrown at the thrower's feet. The scene is
 * frozen with the cloud on screen and High Quality is flipped: `OrdnanceFxLayer`
 * repaints on the change, so the photographs differ only in how the cloud is
 * painted. A control patch outside the cloud must not move, and flipping back must
 * restore the flat picture pixel for pixel.
 *
 * ## The rest
 *
 * - **Drawn, not blank**: the painted cloud against the same frozen frame with the
 *   layer hidden, the control's drift as the floor.
 * - **Animates**: frozen, two frames 300 ms apart. The flat lobes move only on
 *   `update`, which a frozen scene does not run, so they are the still control; the
 *   shader reads Phaser's own clock and must change.
 * - **Both ends**: the server narrated the hazard, and `smokeShadersDrawn` counts
 *   painted quads only while High Quality is on.
 */
import { startStack, enterBattle, standStill, selectWeapon, tally, sleep, freePort } from './harness.mjs'
import { samplePatch, colourDelta } from './pixels.mjs'

const PORT = await freePort()
const { fail, ok, finish } = tally('smoke-shader')

const stack = await startStack({
  port: PORT,
  label: 'smoke-shader',
  env: { ROUND_SECONDS: '180', BOT_COUNT: '0', DEV_SMOKE: '1', FIXED_SEED: '4242', WEATHER: 'off' },
})
const { page, dbg, shot, pageErrors } = await stack.openClient({ name: 'ana' })
await enterBattle(page, { waitPlaying: true, label: 'smoke-shader' })
const k = await page.evaluate(() => window.__game.constants())

const setHQ = (on) => page.evaluate((v) => window.__game.setHighQuality(v), on)
const freeze = (on) => page.evaluate((v) => window.__game.freeze(v), on)
const frame = () => page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))))
const grab = async (r) => (await page.screenshot({ clip: { x: r.x, y: r.y, width: r.w, height: r.h } })).toString('base64')
/** Fraction of pixels differing by more than 6 in any channel — `beams-shader`'s instrument. */
const changedFraction = (a, b) =>
  page.evaluate(
    async ([sa, sb]) => {
      const load = async (src) => {
        const img = new Image()
        img.src = `data:image/png;base64,${src}`
        await img.decode()
        const cv = document.createElement('canvas')
        cv.width = img.width
        cv.height = img.height
        const ctx = cv.getContext('2d')
        ctx.drawImage(img, 0, 0)
        return ctx.getImageData(0, 0, img.width, img.height).data
      }
      const A = await load(sa)
      const B = await load(sb)
      let n = 0
      for (let i = 0; i < A.length; i += 4) {
        if (Math.abs(A[i] - B[i]) > 6 || Math.abs(A[i + 1] - B[i + 1]) > 6 || Math.abs(A[i + 2] - B[i + 2]) > 6) n++
      }
      return n / (A.length / 4)
    },
    [a, b],
  )

await selectWeapon(page, 'smoke')
await standStill(page)
const off0 = await setHQ(false)
if (off0.setting !== false || off0.shaderSmoke !== false) fail(`High Quality would not turn off: ${JSON.stringify(off0)}`)

const clearVision = (await dbg()).vision
if (typeof clearVision !== 'number') fail(`debug().vision is ${clearVision} — the simulation half cannot be read`)

/** Throw at the thrower's feet and wait for the cloud. Returns its screen geometry. */
async function throwSmoke() {
  const aim = await page.evaluate(() => {
    const d = window.__game.debug()
    const v = d.worldView
    const cv = document.querySelector('canvas').getBoundingClientRect()
    const wx = d.player.x + 30
    const wy = d.player.y + 120
    return { x: cv.left + ((wx - v.x) / v.width) * cv.width, y: cv.top + ((wy - v.y) / v.height) * cv.height }
  })
  await page.mouse.move(aim.x, aim.y)
  await sleep(150)
  const before = (await dbg()).observed?.hazards ?? 0
  await page.evaluate(() => window.__game.fire())
  await page.waitForFunction((n) => (window.__game.debug().observed?.hazards ?? 0) > n && window.__game.debug().hazardsDrawn > 0, before, {
    timeout: 10_000,
  })
}

let narrated = 0
try {
  await throwSmoke()
  narrated = (await dbg()).observed?.hazards ?? 0
} catch (e) {
  fail(`no smoke cloud was announced and drawn after a throw: ${e.message}`)
}

if (narrated > 0) {
  // --- simulation half: what the player can see, both modes -------------------------
  // Polled, not slept: the multiplier arrives with the next snapshot.
  await page.waitForFunction('window.__game.debug().vision < 1', null, { timeout: 5_000 }).catch(() => null)
  await sleep(250)
  const visionOff = (await dbg()).vision
  await setHQ(true)
  await sleep(400)
  const visionOn = (await dbg()).vision
  await setHQ(false)
  console.log(`  vision: clear ${clearVision}, in smoke off ${visionOff}, on ${visionOn} (FOV_SMOKE_MULT ${k.FOV_SMOKE_MULT})`)
  if (!(visionOff < clearVision)) {
    fail(`standing in the thrown cloud did not reduce vision (${clearVision} -> ${visionOff}) — the comparison below would be of nothing`)
  } else ok(`control: the cloud blinds its thrower (${clearVision} -> ${visionOff})`)
  if (visionOn !== visionOff) fail(`vision moved with High Quality: ${visionOff} off, ${visionOn} on — a graphics setting changed what a player can see`)
  else ok(`vision is identical in both modes (${visionOn})`)

  // --- one cloud, both ways, same instant ---------------------------------------------
  await freeze(true)
  await frame()
  const d = await dbg()
  const h = d.observed?.lastHazard
  const sx = (h.x - d.worldView.x) * d.zoom
  const sy = (h.y - d.worldView.y) * d.zoom
  const reach = k.SMOKE_RADIUS * k.SMOKE_SHADER_SCALE * d.zoom
  const P = 60
  const band = { x: Math.round(sx - P / 2), y: Math.round(sy - P / 2), w: P, h: P }
  // The corner farthest from the cloud, clear of the quick bar at the bottom.
  const corners = [
    { x: 8, y: 40 },
    { x: 1280 - 8 - P, y: 40 },
    { x: 8, y: 520 },
    { x: 1280 - 8 - P, y: 520 },
  ]
  const far = corners.map((c) => ({ ...c, dist: Math.hypot(c.x + P / 2 - sx, c.y + P / 2 - sy) })).sort((a, b) => b.dist - a.dist)[0]
  const ctrl = { x: far.x, y: far.y, w: P, h: P }
  console.log(`  cloud at screen ${sx.toFixed(0)},${sy.toFixed(0)}, quad reach ${reach.toFixed(0)} px, control ${far.dist.toFixed(0)} px away`)
  if (sx < P || sx > 1280 - P || sy < P || sy > 720 - P) fail(`the cloud is off camera at ${sx.toFixed(0)},${sy.toFixed(0)}`)
  if (far.dist < reach + P) fail(`no control patch clears the cloud (${far.dist.toFixed(0)} px against ${reach.toFixed(0)})`)

  const offBand = await samplePatch(page, band)
  const offCtrl = await samplePatch(page, ctrl)
  const offDrawn = (await dbg()).smokeShadersDrawn
  await shot('smoke-shader-off')

  const on = await setHQ(true)
  await frame()
  const onDrawn = (await dbg()).smokeShadersDrawn
  const onBand = await samplePatch(page, band)
  const onCtrl = await samplePatch(page, ctrl)
  await shot('smoke-shader-on')

  const back = await setHQ(false)
  await frame()
  const backBand = await samplePatch(page, band)
  const backCtrl = await samplePatch(page, ctrl)

  const moved = colourDelta(offBand, onBand)
  const ctrlMoved = Math.max(colourDelta(offCtrl, onCtrl), colourDelta(offCtrl, backCtrl))
  const restored = colourDelta(offBand, backBand)
  console.log(
    `  frozen cloud: flat->painted ${moved.toFixed(1)}, painted->flat ${restored.toFixed(1)} from the original, ` +
      `control ${ctrlMoved.toFixed(1)}; quads off ${offDrawn}, on ${onDrawn}, back ${(await dbg()).smokeShadersDrawn}`,
  )
  if (!on.shaderSmoke) fail(`High Quality on did not select the smoke shader: ${JSON.stringify(on)} — no WebGL?`)
  if (offDrawn !== 0) fail(`${offDrawn} smoke quads painted with High Quality off`)
  if (!(onDrawn >= 1)) fail(`High Quality on painted ${onDrawn} smoke quads over a live cloud`)
  else ok(`both ends: 0 quads with it off, ${onDrawn} with it on, over the same cloud`)
  if (ctrlMoved > 1) fail(`the control patch moved ${ctrlMoved.toFixed(1)} while only the setting changed`)
  else ok(`control: the patch outside the cloud did not move (${ctrlMoved.toFixed(1)})`)
  if (!(moved > Math.max(4, ctrlMoved * 3))) {
    fail(`flipping High Quality moved the cloud patch by only ${moved.toFixed(1)} — the shader is not what is drawn`)
  } else ok(`the same cloud is painted differently with High Quality on (${moved.toFixed(1)})`)
  if (back.shaderSmoke !== false || restored > 1) {
    fail(`turning High Quality off did not restore the flat cloud: ${restored.toFixed(1)} from the original`)
  } else ok(`off again restores the flat cloud exactly (${restored.toFixed(1)})`)

  // --- drawn, not blank: painted cloud against no cloud, same instant ---------------
  await setHQ(true)
  await frame()
  const paintedBand = await samplePatch(page, band)
  const paintedCtrl = await samplePatch(page, ctrl)
  const hidden = await page.evaluate(() => window.__game.showFx(false))
  await frame()
  const noneBand = await samplePatch(page, band)
  const noneCtrl = await samplePatch(page, ctrl)
  const shown = await page.evaluate(() => window.__game.showFx(true))
  const drawn = colourDelta(paintedBand, noneBand)
  const drift = colourDelta(paintedCtrl, noneCtrl)
  const floor = Math.max(4, drift * 3)
  console.log(`  painted cloud against no cloud: ${drawn.toFixed(1)}, control ${drift.toFixed(1)}`)
  if (hidden.visible !== false || shown.visible !== true) fail(`showFx did not read back: ${JSON.stringify({ hidden, shown })}`)
  if (!(drawn > floor)) fail(`the painted cloud is ${drawn.toFixed(1)} from the same frame without it, against a floor of ${floor.toFixed(1)} — nothing is drawn`)
  else ok(`the painted cloud is on the screen (${drawn.toFixed(1)} against ${floor.toFixed(1)})`)

  // --- it animates: frozen, 300 ms apart, flat as the still control --------------------
  const pair = async (hq) => {
    await setHQ(hq)
    await frame()
    const a = await grab(band)
    await sleep(300)
    const b = await grab(band)
    return changedFraction(a, b)
  }
  const still = await pair(false)
  const living = await pair(true)
  console.log(`  frozen cloud, 300 ms apart: flat ${(still * 100).toFixed(1)}% of pixels changed, painted ${(living * 100).toFixed(1)}%`)
  if (!(living > Math.max(0.01, still * 3))) {
    fail(`the painted cloud changed ${(living * 100).toFixed(1)}% of its pixels in 300 ms against ${(still * 100).toFixed(1)}% flat — it does not animate`)
  } else ok(`the painted cloud animates (${(living * 100).toFixed(1)}% against the flat cloud's ${(still * 100).toFixed(1)}%)`)
  if ((await dbg()).hazardsDrawn < 1) fail('the cloud ended during the photographs — every reading above may describe an empty patch')

  await setHQ(false)
  await freeze(false)
}

if (pageErrors.length) fail(`page errors: ${pageErrors.slice(0, 3).join(' | ')}`)
else ok('no page errors')

await finish(() => stack.close())
