/**
 * T22.08B — **a solar flare is drawn where it burns, on every render path, and only in space.**
 *
 * The owner: *"solar flares (make it a cool shader) burns players touching it … should look
 * like a magnetic solar prominence loop or fiery ribbon strand moving at random on the map."*
 * Claims about the picture, so they are asserted on the rendered frame (`docs/72` §C2):
 *
 *  - **coverage** — every one of the `SOLAR_FLARE_SAMPLES` points the server's contact test
 *    runs on (`flare_points` on the sandbox's own flare query, asked of the core — never the
 *    layer's report of what it drew) is a pixel that changes
 *    between the frozen frame and the same instant with the flare hidden (`showFlare`), in
 *    **both** render paths. T21.36 found flat fire covering 85 of 192 burn points; a flare you
 *    can be burned by and cannot see is the same bug.
 *  - **control region** — a point well clear of the ribbon and its glow, which must not change.
 *  - **telegraph** — the loop is a ghost before it burns, never the real thing.
 *  - **it wanders, counted in drawn frames** (`R69`): the ribbon moves across frames the page
 *    actually drew, and a page that stopped drawing is its own red, not "it does not move".
 *  - **burning** — a player the ribbon touched is shown on fire (flames on the body, against the
 *    hidden frame) after it has moved clear of the ribbon, which is the control that the change
 *    is the flames and not the ribbon.
 *
 * `solar-flare-standard` runs this file at `?gravity=standard` and takes `standardArm`: the
 * force is refused, nothing is drawn on `debug()` or on the frame, and there is no Flare button.
 * The two space entries are its presence control.
 */
import { deadlineMs } from '../lib/deadline.mjs'
import { comparePhotos, photo, toScreen } from './pixels.mjs'

/** Drawn frames the wander is measured over. Half a second at 60 fps. */
const WANDER_FRAMES = 30
/** Wall-clock cap on those frames: a cap on a dead page, never the measurement. */
const WANDER_BUDGET_MS = 20_000

export default async function ({ page, shot, log }) {
  const dbg = () => page.evaluate(() => window.__game.debug())
  const waitFor = async (fn, arg, why, seconds = 30) => {
    try {
      await page.waitForFunction(fn, arg, { timeout: deadlineMs(seconds, why) })
    } catch (e) {
      if (String(e).includes('Timeout')) throw new Error(`${why} (waited ${seconds}s)`)
      throw e
    }
  }
  /** `n` frames the page drew, or fewer if it stopped — the caller decides what that means. */
  const advanceFrames = (n, budget) =>
    page.evaluate(
      ([want, cap]) =>
        new Promise((resolve) => {
          const t0 = performance.now()
          let drawn = 0
          let done = false
          const end = () => {
            if (done) return
            done = true
            resolve({ frames: drawn, ms: performance.now() - t0 })
          }
          const timer = setTimeout(end, cap)
          const tick = () => {
            drawn++
            if (drawn >= want) {
              clearTimeout(timer)
              end()
            } else requestAnimationFrame(tick)
          }
          requestAnimationFrame(tick)
        }),
      [n, budget],
    )
  const frames = async (n) => {
    const r = await advanceFrames(n, 10_000)
    if (r.frames < n) throw new Error(`the page drew ${r.frames} of ${n} frames in ${r.ms.toFixed(0)} ms — it stopped rendering`)
  }

  const k = await page.evaluate(() => window.__game.constants())
  await waitFor(() => !!window.__game.debug().player, null, 'the sandbox never produced a local player')

  const wantCanvas = new URL(page.url()).searchParams.get('renderer') === 'canvas'
  const isCanvas = await page.evaluate(() => !!document.querySelector('canvas')?.getContext('2d'))
  if (isCanvas !== wantCanvas) throw new Error(`asked for ${wantCanvas ? 'Canvas' : 'WebGL'}, got the other`)
  log(`renderer: ${isCanvas ? 'Canvas' : 'WebGL'}`)

  const gravity = new URL(page.url()).searchParams.get('gravity')
  const rocks = await page.evaluate(() => window.__game.core.meta.asteroids.length)
  const flareButton = await page.evaluate(() => [...document.querySelectorAll('button')].some((b) => b.textContent === 'Flare'))
  if (gravity === 'standard') {
    if (rocks !== 0) throw new Error(`?gravity=standard generated ${rocks} asteroids — this is a space map`)
    return standardArm({ page, shot, log, dbg, frames, isCanvas, flareButton })
  }
  if (rocks === 0) throw new Error('no asteroids — `?gravity=space` did not reach the scene')
  if (!flareButton) throw new Error('a space sandbox has no Flare button')

  await page.evaluate(() => {
    window.__game.setTime(0)
    window.__game.setParallaxClock(0)
  })
  // The whole loop on screen at once: it is up to SPAN wide and HEIGHT tall at any angle.
  await page.evaluate(() => window.__game.setZoom(1))

  await page.evaluate(() => window.__game.forceWeather(4))
  await waitFor(() => window.__game.weatherProbe().active.some((a) => a.kind === 'flare'), null, 'forcing a flare in space started nothing')

  // --- the telegraph: a ghost, never the thing that burns ------------------------------
  await frames(2)
  const tele = (await dbg()).flare
  if (!tele) throw new Error('debug() has no flare state — the layer is not wired')
  if (tele.lit || !tele.drawn || !(tele.strength > 0 && tele.strength < 0.5)) {
    throw new Error(`the telegraph should draw a faint unlit ghost: ${JSON.stringify({ ...tele, points: tele.points.length })}`)
  }
  log(`telegraph: ghost at strength ${tele.strength.toFixed(2)} (${tele.elapsed.toFixed(2)} s in)`)

  await waitFor(() => window.__game.debug().flare?.lit === true, null, 'the flare never lit', 30)

  /**
   * A point on the map clear of every ribbon sample by `gap`, with open space around it,
   * and half a viewport from every map edge — so the camera can centre on it and the body
   * is not photographed under the sandbox's panel in a corner.
   */
  const clearOf = (pts, gap) =>
    page.evaluate(
      ([p, g, h, mx, my]) => {
        const core = window.__game.core
        for (let y = Math.max(h * 3, my); y < core.height - Math.max(h * 3, my); y += 23) {
          for (let x = Math.max(h * 3, mx); x < core.width - Math.max(h * 3, mx); x += 23) {
            let ok = true
            for (let i = 0; ok && i + 1 < p.length; i += 2) if (Math.hypot(p[i] - x, p[i + 1] - y) < g) ok = false
            for (let dy = -h * 1.5; ok && dy <= h * 1.5; dy += 4) {
              for (let dx = -h; ok && dx <= h; dx += 4) if (core.solidAt(Math.round(x + dx), Math.round(y + dy))) ok = false
            }
            if (ok) return { x, y }
          }
        }
        return null
      },
      [pts, gap, k.PLAYER_H, k.VIEWPORT_W / 2, k.VIEWPORT_H / 2],
    )
  const reach = k.SOLAR_FLARE_RIBBON_R + k.SOLAR_FLARE_GLOW

  // The player well away, so nothing but the ribbon differs between the two photographs.
  {
    const far = await clearOf((await dbg()).flare.points, reach + k.SOLAR_FLARE_SPAN)
    if (!far) throw new Error('no open space clear of the ribbon for the player')
    await page.evaluate(([x, y]) => window.__game.place(x, y), [far.x, far.y])
  }

  // --- coverage, both paths --------------------------------------------------------------
  for (const hq of [false, true]) {
    const label = `High Quality ${hq ? 'on' : 'off'}`
    const q = await page.evaluate((v) => window.__game.setHighQuality(v), hq)
    if (q.setting !== hq) throw new Error(`${label}: High Quality would not change: ${JSON.stringify(q)}`)
    // Centre the camera on the ribbon, then freeze the simulation (rendering goes on).
    const aim = (await dbg()).flare.points
    let cx = 0
    let cy = 0
    for (let i = 0; i + 1 < aim.length; i += 2) {
      cx += aim[i]
      cy += aim[i + 1]
    }
    const n2 = aim.length / 2
    await page.evaluate(([x, y]) => window.__game.watch(x, y), [cx / n2, cy / n2])
    await frames(3)
    await page.evaluate(() => window.__game.freeze(true))
    try {
      await frames(2)
      const f = (await dbg()).flare
      // **The points that burn, asked of the core, not of the layer** — the sandbox's
      // flare query through `flare_points`, which the wasm test pins to the points its
      // own flare touches with. A layer that drew another instant and reported what it
      // drew would pass a check that read its report.
      const burns = await page.evaluate(() => {
        const q = window.__game.weatherProbe().flare
        return q ? Array.from(window.__game.core.flarePoints(q)) : []
      })
      const wantShader = hq && !isCanvas
      if (!f.drawn || !f.lit) throw new Error(`${label}: the lit flare was not drawn: ${JSON.stringify({ ...f, points: f.points.length })}`)
      if (f.shader !== wantShader) throw new Error(`${label}: drawn ${f.shader ? 'by the shader' : 'flat'}, expected ${wantShader ? 'the shader' : 'flat'}`)
      if (burns.length !== 2 * k.SOLAR_FLARE_SAMPLES) {
        throw new Error(`${label}: the core gave ${burns.length / 2} damage points, the server samples ${k.SOLAR_FLARE_SAMPLES}`)
      }
      // Each sample, and the same sample pushed across the ribbon to `EDGE` of the contact
      // radius on both sides: a body burns anywhere inside that radius, so a hairline
      // painted down the centre line would cover the samples and hide most of what burns.
      const EDGE = 0.8
      const probes = []
      const n = burns.length / 2
      for (let i = 0; i < n; i++) {
        const a = Math.max(0, i - 1)
        const b = Math.min(n - 1, i + 1)
        const tx = burns[2 * b] - burns[2 * a]
        const ty = burns[2 * b + 1] - burns[2 * a + 1]
        const l = Math.hypot(tx, ty) || 1
        const off = k.SOLAR_FLARE_RIBBON_R * EDGE
        for (const side of [0, 1, -1]) {
          probes.push({ i, side, x: burns[2 * i] - (ty / l) * off * side, y: burns[2 * i + 1] + (tx / l) * off * side })
        }
      }
      const onScreen = []
      for (const p of probes) {
        const s = await toScreen(page, p.x, p.y)
        if (!s.onScreen) throw new Error(`${label}: damage point ${p.i} (side ${p.side}) at (${p.x.toFixed(0)}, ${p.y.toFixed(0)}) is off screen`)
        onScreen.push({ x: s.x, y: s.y })
      }
      // Control: a point clear of the ribbon and its glow, on screen.
      const ctrlWorld = await page.evaluate(
        ([p, gap]) => {
          const v = window.__game.debug().worldView
          const w = v.width ?? v.w
          const h = v.height ?? v.h
          for (let y = v.y + 20; y < v.y + h - 20; y += 17) {
            for (let x = v.x + 20; x < v.x + w - 20; x += 17) {
              let ok = true
              for (let i = 0; ok && i + 1 < p.length; i += 2) if (Math.hypot(p[i] - x, p[i + 1] - y) < gap) ok = false
              if (ok) return { x, y }
            }
          }
          return null
        },
        [burns, reach + 40],
      )
      if (!ctrlWorld) throw new Error(`${label}: no on-screen point clear of the flare for the control`)
      const ctrl = await toScreen(page, ctrlWorld.x, ctrlWorld.y)

      const on = await photo(page)
      await shot(`solar-flare-${isCanvas ? 'canvas' : 'webgl'}-hq-${hq ? 'on' : 'off'}`)
      await page.evaluate(() => window.__game.showFlare(false))
      await frames(2)
      const off = await photo(page)
      await page.evaluate(() => window.__game.showFlare(true))
      const cmp = await comparePhotos(page, on, off, { points: [...onScreen, { x: ctrl.x, y: ctrl.y }] })
      const covered = cmp.points.slice(0, onScreen.length).filter(Boolean).length
      const ctrlMoved = cmp.points[onScreen.length]
      if (covered < onScreen.length) {
        const bad = cmp.detail.slice(0, onScreen.length).filter((_, i) => !cmp.points[i])
        throw new Error(`${label}: only ${covered} of ${onScreen.length} damage points (${n} samples, centre and ±${EDGE} of the contact radius) are under painted flare — unpainted: ${JSON.stringify(bad.slice(0, 6))}`)
      }
      if (ctrlMoved) throw new Error(`${label}: the control point clear of the flare changed too: ${JSON.stringify(cmp.detail[onScreen.length])}`)
      log(`${label}: ${covered}/${onScreen.length} damage points (${n} samples × centre and both edges) painted (${f.shader ? 'shader' : 'flat'}), control unchanged, ${(cmp.fraction * 100).toFixed(1)}% of the frame is flare`)
    } finally {
      await page.evaluate(() => window.__game.freeze(false))
    }
  }

  // --- how it looks at the game's own zoom: photographs to look at, not assertions -----
  await page.evaluate((z) => window.__game.setZoom(z), k.CAMERA_ZOOM)
  for (const hq of [false, true]) {
    await page.evaluate((v) => window.__game.setHighQuality(v), hq)
    const aim = (await dbg()).flare.points
    const mid = Math.floor(aim.length / 4) * 2
    await page.evaluate(([x, y]) => window.__game.watch(x, y), [aim[mid], aim[mid + 1]])
    await frames(3)
    await shot(`solar-flare-${isCanvas ? 'canvas' : 'webgl'}-look-hq-${hq ? 'on' : 'off'}`)
  }
  await page.evaluate(() => window.__game.setZoom(1))

  // --- it wanders, over frames the page drew (R69) ---------------------------------------
  {
    const a = (await dbg()).flare
    const r = await advanceFrames(WANDER_FRAMES, WANDER_BUDGET_MS)
    const b = (await dbg()).flare
    if (r.frames < WANDER_FRAMES) {
      throw new Error(`the page drew ${r.frames} of ${WANDER_FRAMES} frames in ${(r.ms / 1000).toFixed(1)} s — it stopped rendering, so this says nothing about the flare`)
    }
    if (b.frames - a.frames < WANDER_FRAMES) {
      throw new Error(`the page drew ${r.frames} frames and the flare layer drew ${b.frames - a.frames} of them`)
    }
    let moved = 0
    for (let i = 0; i < a.points.length; i++) moved = Math.max(moved, Math.abs(a.points[i] - b.points[i]))
    if (!(moved > 1)) throw new Error(`the ribbon moved ${moved.toFixed(2)} px over ${r.frames} drawn frames — it does not wander`)
    log(`wanders: ${moved.toFixed(1)} px over ${r.frames} drawn frames (${b.frames - a.frames} drawn by the layer)`)
  }

  // --- burning: touched, then clear of the ribbon, still on fire ------------------------
  {
    await page.evaluate(() => window.__game.setHighQuality(false))
    const pts = (await dbg()).flare.points
    const mid = Math.floor(pts.length / 4) * 2
    await page.evaluate(([x, y]) => window.__game.place(x, y), [pts[mid], pts[mid + 1]])
    await waitFor(() => (window.__game.debug().flare?.burning ?? []).includes(0), null, 'a player placed on the ribbon was never shown burning', 10)
    const now = (await dbg()).flare.points
    const far = await clearOf(now, reach + k.SOLAR_FLARE_SPAN * 0.5)
    if (!far) throw new Error('no open space clear of the ribbon to watch the burn')
    await page.evaluate(([x, y]) => {
      window.__game.place(x, y)
      window.__game.watch(x, y)
    }, [far.x, far.y])
    await frames(3)
    await page.evaluate(() => window.__game.freeze(true))
    try {
      const d = await dbg()
      if (!d.flare.burning.includes(0)) throw new Error(`the burn ended within 3 frames of leaving the ribbon: ${JSON.stringify(d.flare.burning)}`)
      let nearest = Infinity
      for (let i = 0; i + 1 < d.flare.points.length; i += 2) {
        nearest = Math.min(nearest, Math.hypot(d.flare.points[i] - d.player.x, d.flare.points[i + 1] - d.player.y))
      }
      // The drawn body is half a body above the physics centre in this scene.
      const bodyY = d.player.y - k.PLAYER_H / 2
      const a = await toScreen(page, d.player.x - k.PLAYER_W, bodyY - k.PLAYER_H)
      const b = await toScreen(page, d.player.x + k.PLAYER_W, bodyY + k.PLAYER_H)
      const rect = { x: Math.round(a.x), y: Math.round(a.y), w: Math.round(b.x - a.x), h: Math.round(b.y - a.y) }
      const ctrl = await toScreen(page, d.player.x + k.PLAYER_W * 6, bodyY)
      const on = await photo(page)
      await shot(`solar-flare-${isCanvas ? 'canvas' : 'webgl'}-burning`)
      await page.evaluate(() => window.__game.showFlare(false))
      await frames(2)
      const off = await photo(page)
      await page.evaluate(() => window.__game.showFlare(true))
      const cmp = await comparePhotos(page, on, off, { rect, points: [{ x: ctrl.x, y: ctrl.y }] })
      if (!(cmp.fraction > 0.04)) {
        throw new Error(`a burning player ${nearest.toFixed(0)} px from the ribbon: only ${(cmp.fraction * 100).toFixed(1)}% of the body's box changed with the flames hidden`)
      }
      if (cmp.points[0]) throw new Error(`the control beside the burning body changed too: ${JSON.stringify(cmp.detail[0])}`)
      log(`burning: ${(cmp.fraction * 100).toFixed(1)}% of the body's box is flame, ${nearest.toFixed(0)} px from the ribbon; control unchanged`)
    } finally {
      await page.evaluate(() => window.__game.freeze(false))
    }
  }
  await page.evaluate((z) => window.__game.setZoom(z), k.CAMERA_ZOOM)
}

/**
 * **Off a space map there is no flare** — refused by the core (`R83`), so nothing is drawn,
 * on `debug()` or on the frame, and the sandbox offers no button for it. The presence control
 * is `solar-flare` and `solar-flare-canvas`, which run the same force and require the picture.
 */
async function standardArm({ page, shot, log, dbg, frames, isCanvas, flareButton }) {
  const bad = []
  if (flareButton) bad.push('a standard sandbox offers a Flare button')
  await page.evaluate(() => window.__game.forceWeather(4))
  await frames(30)
  const probe = await page.evaluate(() => window.__game.weatherProbe())
  if (probe.active.some((a) => a.kind === 'flare')) bad.push(`the force started a flare: ${JSON.stringify(probe.active)}`)
  const d = await dbg()
  if (!d.flare) bad.push('debug() has no flare state — the layer is not wired, so "nothing drawn" means nothing')
  else if (d.flare.drawn || d.flare.frames !== 0) bad.push(`the layer drew a flare: ${JSON.stringify({ ...d.flare, points: d.flare.points.length })}`)
  await page.evaluate(() => window.__game.freeze(true))
  try {
    await frames(2)
    const on = await photo(page)
    await shot(`solar-flare-${isCanvas ? 'canvas' : 'webgl'}-standard`)
    await page.evaluate(() => window.__game.showFlare(false))
    await frames(2)
    const off = await photo(page)
    await page.evaluate(() => window.__game.showFlare(true))
    const cmp = await comparePhotos(page, on, off)
    if (cmp.fraction > 0.001) bad.push(`hiding the flare changed ${(cmp.fraction * 100).toFixed(2)}% of the frame`)
    log(`standard: no flare rolled, none drawn, ${(cmp.fraction * 100).toFixed(3)}% of the frame moved with it hidden`)
  } finally {
    await page.evaluate(() => window.__game.freeze(false))
  }
  if (bad.length) throw new Error(`standard gravity: ${bad.join('; ')}`)
}
