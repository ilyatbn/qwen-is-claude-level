#!/usr/bin/env node
/**
 * T21.18 item 3 — laser beams, painted by a shader under High Quality.
 *
 *   node scripts/checks/beams-shader.mjs
 *
 * Lasers are hitscan: the beam is a fading line, three strokes deep. With High
 * Quality **off** that line must be exactly what it was; with it **on** a shader
 * quad replaces it. So this asserts two pictures of **one beam at one instant**.
 *
 * ## One beam, both ways
 *
 * The scene is frozen with a beam on screen and its decay held, then High Quality
 * is flipped. `OrdnanceLayer` repaints on the change (it does not wait for an update
 * a frozen scene never runs), so the photographs differ in exactly one thing: how
 * the beam is painted. A control patch on the other side of the player must not
 * move at all, and flipping back must restore the stroked picture pixel for pixel.
 *
 * ## The rest
 *
 * - **It is drawn, not blank**: the painted beam against the same patch once the
 *   beam is gone, with the control's drift as the floor.
 * - **It animates**: with the decay held and the scene running, two frames 200 ms
 *   apart differ along the beam under High Quality — against the same pair with it
 *   off, where the strokes are still and whatever differs is the background.
 * - **Both ends**: the server narrated the shots, the layer held tracers, and
 *   `beamShadersDrawn` counts painted quads only while High Quality is on.
 *
 * Networked, like `ordnance-visible` — the sandbox player has no laser and no
 * battery — and on its map and loadout.
 */
import { startStack, enterBattle, standStill, selectWeapon, tally, sleep } from './harness.mjs'
import { samplePatch, colourDelta } from './pixels.mjs'

const PORT = 3154
const { fail, ok, finish } = tally('beams-shader')

const stack = await startStack({
  port: PORT,
  label: 'beams-shader',
  env: { ROUND_SECONDS: '180', BOT_COUNT: '0', DEV_LOADOUT: '1', FIXED_SEED: '4242', WEATHER: 'off' },
})
const { page, dbg, shot, pageErrors } = await stack.openClient({ name: 'ana' })
await enterBattle(page, { waitPlaying: true, label: 'beams-shader' })

const setHQ = (on) => page.evaluate((v) => window.__game.setHighQuality(v), on)
const grab = async (r) => (await page.screenshot({ clip: { x: r.x, y: r.y, width: r.w, height: r.h } })).toString('base64')
/** Fraction of pixels differing by more than 6 in any channel between two photographs. */
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
const hold = (on) => page.evaluate((v) => window.__game.holdTracers(v), on)
const freeze = (on) => page.evaluate((v) => window.__game.freeze(v), on)

await selectWeapon(page, 'laser_pistol')
await standStill(page)

/** Aim flat and right of the player — `ordnance-visible`'s helper, same reasons. */
const aimRight = async () => {
  const at = await page.evaluate(() => {
    const d = window.__game.debug()
    const raw = d.worldView
    const v = { x: raw.x, y: raw.y, w: raw.width ?? raw.w, h: raw.height ?? raw.h }
    const cv = document.querySelector('canvas')
    const r = cv.getBoundingClientRect()
    const m = 60
    const wx = Math.min(d.player.x + 300, v.x + v.w - m)
    const wy = Math.max(d.player.y, v.y + m)
    return { x: r.left + ((wx - v.x) / v.w) * r.width, y: r.top + ((wy - v.y) / v.h) * r.height }
  })
  await page.mouse.move(at.x, at.y)
  await sleep(150)
}
await aimRight()

/** Fire until a beam is on screen, then freeze on it. Returns the two patches. */
async function fireAndFreeze(label) {
  for (let burst = 0; burst < 10; burst++) {
    await standStill(page)
    await page.evaluate(() => window.__game.fire())
    for (let i = 0; i < 25; i++) {
      const d = await dbg()
      if ((d.tracersDrawn ?? 0) > 0 && d.player) {
        await freeze(true)
        const s = await dbg()
        const sx = (s.player.x - s.worldView.x) * s.zoom
        const sy = (s.player.y - s.worldView.y) * s.zoom
        if (sx > 200 && sx < 1280 - 180 && sy > 20 && sy < 700) {
          // Along the shot but **clear of the muzzle flash**, and the mirror-image patch
          // behind the player, which the shot never crosses. Measured: a band starting
          // 40 px out still caught the flash's rim, so a shader planted to paint nothing
          // read as "drawn" at 7.9 against a floor of 4. The flash (7 world px) ends by
          // ~46 screen px; the beam on this map runs past 100.
          return {
            band: { x: Math.round(sx + 50), y: Math.round(sy - 17), w: 50, h: 34 },
            ctrl: { x: Math.round(sx - 100), y: Math.round(sy - 17), w: 50, h: 34 },
          }
        }
        await freeze(false)
        break
      }
      await sleep(20)
    }
    // Before the next shot, let this beam go — polled, not a sleep against a cooldown.
    await page.waitForFunction('window.__game.debug().tracersDrawn === 0', null, { timeout: 10_000 }).catch(() => null)
  }
  fail(`${label}: no beam could be framed on screen after ten shots`)
  return null
}

const narratedBefore = (await dbg()).observed?.hitscans ?? 0
const off0 = await setHQ(false)
if (off0.setting !== false || off0.shaderBeams !== false) fail(`High Quality would not turn off: ${JSON.stringify(off0)}`)
await hold(true)

// --- 1. one beam, both ways, same instant ------------------------------------------
const P = await fireAndFreeze('frozen pair')
if (P) {
  const offBand = await samplePatch(page, P.band)
  const offCtrl = await samplePatch(page, P.ctrl)
  const offDrawn = (await dbg()).beamShadersDrawn
  await shot('beams-shader-off')

  const on = await setHQ(true)
  const onDrawn = (await dbg()).beamShadersDrawn
  const onBand = await samplePatch(page, P.band)
  const onCtrl = await samplePatch(page, P.ctrl)
  await shot('beams-shader-on')

  const back = await setHQ(false)
  const backBand = await samplePatch(page, P.band)
  const backCtrl = await samplePatch(page, P.ctrl)

  const moved = colourDelta(offBand, onBand)
  const ctrlMoved = Math.max(colourDelta(offCtrl, onCtrl), colourDelta(offCtrl, backCtrl))
  const restored = colourDelta(offBand, backBand)
  console.log(
    `  frozen beam: stroked->painted ${moved.toFixed(1)}, painted->stroked ${restored.toFixed(1)} from the original, ` +
      `control ${ctrlMoved.toFixed(1)}; quads off ${offDrawn}, on ${onDrawn}, back ${(await dbg()).beamShadersDrawn}`,
  )

  if (!on.shaderBeams) fail(`High Quality on did not select the beam shader: ${JSON.stringify(on)} — no WebGL?`)
  if (offDrawn !== 0) fail(`${offDrawn} shader quads painted with High Quality off`)
  if (!(onDrawn >= 1)) fail(`High Quality on painted ${onDrawn} beam quads over a held beam`)
  else ok(`both ends: 0 quads with it off, ${onDrawn} with it on, over the same held beam`)
  if (ctrlMoved > 1) fail(`the control patch moved ${ctrlMoved.toFixed(1)} while only the setting changed`)
  else ok(`control: the patch behind the player did not move (${ctrlMoved.toFixed(1)})`)
  if (!(moved > Math.max(4, ctrlMoved * 3))) {
    fail(`flipping High Quality moved the beam patch by only ${moved.toFixed(1)} — the shader is not what is drawn`)
  } else ok(`the same beam is painted differently with High Quality on (${moved.toFixed(1)})`)
  if (back.shaderBeams !== false || restored > 1) {
    fail(`turning High Quality off did not restore the stroked beam: ${restored.toFixed(1)} from the original`)
  } else ok(`off again restores the stroked beam exactly (${restored.toFixed(1)})`)

  // --- 2. drawn, not blank: the painted beam against no beam, same instant ---------
  // Hiding the layer on the frozen frame rather than waiting for the beam to go:
  // measured, a later frame drifted the control by 16.8 and lifted the floor to 50.
  await setHQ(true)
  const paintedBand = await samplePatch(page, P.band)
  const paintedCtrl = await samplePatch(page, P.ctrl)
  const hidden = await page.evaluate(() => window.__game.showOrdnance(false))
  const noneBand = await samplePatch(page, P.band)
  const noneCtrl = await samplePatch(page, P.ctrl)
  const shown = await page.evaluate(() => window.__game.showOrdnance(true))
  const drawn = colourDelta(paintedBand, noneBand)
  const drift = colourDelta(paintedCtrl, noneCtrl)
  const floor = Math.max(4, drift * 3)
  console.log(`  painted beam against no beam: ${drawn.toFixed(1)}, control ${drift.toFixed(1)}`)
  if (hidden.visible !== false || shown.visible !== true) fail(`showOrdnance did not read back: ${JSON.stringify({ hidden, shown })}`)
  if (!(drawn > floor)) fail(`the painted beam is ${drawn.toFixed(1)} from the same frame without it, against a floor of ${floor.toFixed(1)} — nothing is drawn`)
  else ok(`the painted beam is on the screen (${drawn.toFixed(1)} against ${floor.toFixed(1)})`)
  await setHQ(false)
  await hold(false)
  await freeze(false)
  await page.waitForFunction('window.__game.debug().tracersDrawn === 0', null, { timeout: 10_000 }).catch(() => null)
}

// --- 3. it animates: held beam, running scene, two frames apart -----------------------
async function flicker(hq) {
  await setHQ(hq)
  await hold(true)
  const Q = await fireAndFreeze(`flicker (${hq ? 'on' : 'off'})`)
  if (!Q) return null
  await freeze(false)
  // **Per pixel, not a patch mean** — measured, the mean moved 2.2 for a rippling beam
  // and 1.0 for a still one: a ripple running along a 130 px patch averages out, as
  // the fog's drift did (\`fog-shader\`).
  const a = await grab(Q.band)
  await sleep(200)
  const b = await grab(Q.band)
  await hold(false)
  await page.waitForFunction('window.__game.debug().tracersDrawn === 0', null, { timeout: 10_000 }).catch(() => null)
  return changedFraction(a, b)
}
const still = await flicker(false)
const living = await flicker(true)
if (still !== null && living !== null) {
  console.log(`  held beam, 200 ms apart: stroked ${(still * 100).toFixed(1)}% of pixels changed, painted ${(living * 100).toFixed(1)}%`)
  if (!(living > Math.max(0.01, still * 3))) {
    fail(`the painted beam changed ${(living * 100).toFixed(1)}% of its pixels in 200 ms against ${(still * 100).toFixed(1)}% for the still strokes — it does not animate`)
  } else ok(`the painted beam animates (${(living * 100).toFixed(1)}% of pixels against the stroked beam's ${(still * 100).toFixed(1)}%)`)
}

// --- both ends on the wire ----------------------------------------------------------
const narrated = ((await dbg()).observed?.hitscans ?? 0) - narratedBefore
if (!(narrated > 0)) fail('the server narrated no hitscan — no beam in this check was a real shot')
else ok(`the server narrated ${narrated} laser shot(s)`)

await setHQ(false)
if (pageErrors.length) fail(`page errors: ${pageErrors.slice(0, 3).join(' | ')}`)
else ok('no page errors')

await finish(() => stack.close())
