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
 * the same frozen frame with the ordnance layer hidden. The same ring is measured with
 * High Quality off and **reported, not asserted**: that is the old picture, whose outer
 * circle is `7 × 1.15` px at most against a damage radius of 10.
 *
 * ## The rest, as `beams-shader` and `smoke-shader`
 *
 * One frozen field both ways, with a control patch that must not move and an exact
 * restore; drawn against the layer hidden; animates while frozen, where the flat flames
 * are still because their flicker runs on `render`, which a frozen scene does not call;
 * both ends — flames the layer holds against quads painted.
 *
 * `freeze` holds the field: `worldView.syncProjectiles` runs from `update`, so a frozen
 * scene neither moves nor removes a flame.
 */
import { startStack, enterBattle, standStill, selectWeapon, tally, sleep, freePort } from './harness.mjs'
import { samplePatch, colourDelta } from './pixels.mjs'

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
const frame = () => page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))))
const full = async () => (await page.screenshot()).toString('base64')
const grab = async (r) => (await page.screenshot({ clip: { x: r.x, y: r.y, width: r.w, height: r.h } })).toString('base64')

/**
 * Compare two same-size photographs: the fraction of pixels that moved, and for each
 * point whether it moved by more than `thr` in some channel.
 */
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
      return {
        fraction: n / (A.d.length / 4),
        points: pts.map((p) => moved((Math.round(p.y) * A.w + Math.round(p.x)) * 4, t)),
      }
    },
    [a, b, points, thr],
  )

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
  if (!(moved > Math.max(4, ctrlMoved * 3))) fail(`flipping High Quality moved the fire by only ${moved.toFixed(1)} — the shader is not what is drawn`)
  else ok(`the same fire is painted differently with High Quality on (${moved.toFixed(1)})`)
  if (back.shaderFlames !== false || restored > 1) fail(`turning High Quality off did not restore the flat fire: ${restored.toFixed(1)} from the original`)
  else ok(`off again restores the flat fire exactly (${restored.toFixed(1)})`)
  if (!(drawn > floor)) fail(`the painted fire is ${drawn.toFixed(1)} from the same frame without it, against ${floor.toFixed(1)} — nothing is drawn`)
  else ok(`the painted fire is on the screen (${drawn.toFixed(1)} against ${floor.toFixed(1)})`)

  // --- the damage circle is covered --------------------------------------------------
  const painted = await compare(onFrame, hiddenFrame, ring, VISIBLE)
  const flat = await compare(offFrame, hiddenFrame, ring, VISIBLE)
  const cover = (r) => r.points.filter(Boolean).length
  console.log(
    `  damage-circle points painted: High Quality on ${cover(painted)}/${ring.length}, ` +
      `off ${cover(flat)}/${ring.length} (the old picture — reported, not asserted)`,
  )
  if (cover(painted) !== ring.length) {
    fail(`${ring.length - cover(painted)} of ${ring.length} points just inside a flame's damage circle are unpainted under High Quality — burned by fire you cannot see`)
  } else ok(`every point just inside every on-camera damage circle is painted (${ring.length})`)

  // --- it animates: frozen, 300 ms apart ---------------------------------------------
  const pair = async (hq) => {
    await setHQ(hq)
    await frame()
    const a = await grab(band)
    await sleep(300)
    return (await compare(a, await grab(band))).fraction
  }
  const still = await pair(false)
  const living = await pair(true)
  console.log(`  frozen fire, 300 ms apart: flat ${(still * 100).toFixed(1)}%, painted ${(living * 100).toFixed(1)}%`)
  if (!(living > Math.max(0.01, still * 3))) fail(`the painted fire changed ${(living * 100).toFixed(1)}% in 300 ms against ${(still * 100).toFixed(1)}% flat — it does not animate`)
  else ok(`the painted fire animates (${(living * 100).toFixed(1)}% against ${(still * 100).toFixed(1)}%)`)
}

await setHQ(false)
await freeze(false)
if (pageErrors.length) fail(`page errors: ${pageErrors.slice(0, 3).join(' | ')}`)
else ok('no page errors')

await finish(() => stack.close())
