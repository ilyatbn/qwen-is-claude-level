#!/usr/bin/env node
/**
 * `world-canvas` — T23.03 (R1): three.js draws the world on its own canvas **under** Phaser's,
 * and Phaser's camera is the only source of truth.
 *
 *   node scripts/e2e.mjs --only world-canvas
 *
 * In the sandbox **and** in a networked match:
 *
 * 1. **Order.** `#game` holds the three.js canvas first and Phaser's second, on the same box,
 *    and the top element at the centre is Phaser's (input still goes to Phaser).
 * 2. **The test layer is visible where Phaser draws nothing** (sandbox; the look-lab too, where
 *    Phaser draws nothing at all). Phaser's own alpha is read back per point; at every point it
 *    left transparent the screenshot must show `skyBottom` through ACES at the scene's exposure
 *    (`worldRenderer-math.ts::acesSrgb`, a CPU copy of three's shader) — which also proves the
 *    `OutputPass` and the exposure are in the chain (without them the pixel is `0x3a3040`-ish).
 *    **Control frame:** with the Phaser sky shown again those points are covered and the
 *    screenshot there must *not* match — a comparison that cannot fail proves nothing.
 * 3. **One camera.** A world-anchored marker is drawn in both canvases; while the camera pans,
 *    each drawn frame reads the marker's screen x back from **both** canvases in the same
 *    frame (`__world.probe`, in Phaser's `postrender`, after both have drawn). They must agree
 *    to `MAX_DX` px on every frame, frames must be consecutive (counted, not timed), and the
 *    marker must actually move (a pan that did not happen would pass the agreement trivially).
 *    Laying the ortho camera out one event too early (`prerender`, last frame's `worldView`)
 *    is the `living-sky` trap and shows up here as a gap of one frame's pan.
 * 4. **R14's tier plumbing:** low halves the target and drops MSAA, full is the buffer with 4×.
 * 5. **Control: `&world=off`** (the draw-nothing stub) must fail the marker measurement **by
 *    name** — "no marker in the three.js canvas".
 */
import { join } from 'node:path'
import { startStack, enterBattle, tally, freePort, drawnFrames, shotsDir } from './harness.mjs'

/** Agreement between the two canvases, CSS px: sub-pixel placement differs (MSAA vs roundPixels). */
const MAX_DX = 1.5
/** The pan has to move the marker this far on screen, and on this many frames. */
const MIN_TRAVEL_PX = 40
const MIN_MOVING_FRAMES = 5
/** Channel tolerance for the test layer against the CPU ACES: 8-bit quantisation of a half-float target. */
const TOL = 3

const t = tally('world-canvas')
const stack = await startStack({ port: await freePort(), label: 'world-canvas', env: { BOT_COUNT: '0' } })

/**
 * The canvas order and boxes, from the page. Paint order is read with `elementsFromPoint`
 * (top-most first) — which skips `pointer-events: none`, so the world canvas is made hittable
 * for the one read and restored.
 */
async function assertOrder(page, where) {
  const o = await page.evaluate(() => {
    const cs = [...document.querySelectorAll('#game canvas')]
    const three = cs.find((c) => c.dataset.world === 'three') ?? null
    const phaser = cs.find((c) => c.dataset.world === undefined) ?? null
    const r = (c) => {
      const b = c.getBoundingClientRect()
      return [b.left, b.top, b.width, b.height].map(Math.round)
    }
    let stack = []
    if (three && phaser) {
      const pe = three.style.pointerEvents
      three.style.pointerEvents = 'auto'
      stack = document.elementsFromPoint(innerWidth / 2, innerHeight / 2).filter((e) => e === three || e === phaser)
      three.style.pointerEvents = pe
    }
    return {
      n: cs.length,
      found: !!three && !!phaser,
      // What 32 checks read as "the game canvas": it must still be Phaser's.
      firstIsPhaser: document.querySelector('canvas') === phaser,
      boxes: three && phaser ? [r(three), r(phaser)] : [],
      paint: stack.map((e) => (e === phaser ? 'phaser' : 'three')),
      topIsPhaser: document.elementFromPoint(innerWidth / 2, innerHeight / 2) === phaser,
    }
  })
  if (o.n !== 2 || !o.found) {
    t.fail(`${where}: #game canvases ${JSON.stringify(o)} — want a three.js canvas and Phaser's`)
  } else if (JSON.stringify(o.paint) !== JSON.stringify(['phaser', 'three'])) {
    t.fail(`${where}: paint order top-down is ${JSON.stringify(o.paint)}, want Phaser over three.js`)
  } else if (JSON.stringify(o.boxes[0]) !== JSON.stringify(o.boxes[1])) {
    t.fail(`${where}: the canvases do not share a box: ${JSON.stringify(o.boxes)}`)
  } else if (!o.topIsPhaser || !o.firstIsPhaser) {
    t.fail(`${where}: Phaser's canvas is not the one input and \`querySelector('canvas')\` reach (${JSON.stringify(o)})`)
  } else {
    t.ok(`${where}: three.js canvas painted under Phaser's, same box ${JSON.stringify(o.boxes[0])}; Phaser takes input and is the first canvas`)
  }
}

/**
 * Pan while probing; returns `{ ok, reason, stats }`. `startPan` runs in the page right after
 * the probe is armed, so the first sample is the first frame of the pan.
 */
async function measurePan(page, where, startPan, frames = 40) {
  // A plus sign centred at (cx, cy), world px: a thin tall bar and a thin wide bar. Any row
  // within `ARM` of cy crosses it with a run centred on cx, and any column within `ARM` of cx
  // with a run centred on cy — so a pan of up to `ARM` in any direction stays measurable on
  // every frame (a small square left the probe lines on a fast jetpack pan: 45/60 frames).
  const setup = await page.evaluate(() => {
    const v = window.__world.view()
    const ARM = 400
    const BAR = 12
    const cx = Math.round(v.x + v.w / 2)
    const cy = Math.round(v.y + v.h / 2 - 50)
    window.__world.addMarker(cx - BAR / 2, cy - ARM, BAR, 2 * ARM)
    window.__world.addMarker(cx - ARM, cy - BAR / 2, 2 * ARM, BAR)
    const c = document.querySelector('#game canvas:not([data-world])')
    return { v, cx, cy, cssW: c.clientWidth, cssH: c.clientHeight }
  })
  await drawnFrames(page, 2)
  // Probe off the centre by a quarter view, so the row meets the tall bar and the column the wide one.
  const row = Math.round(((setup.cy + setup.v.h / 4 - setup.v.y) * setup.cssH) / setup.v.h)
  const col = Math.round(((setup.cx + setup.v.w / 4 - setup.v.x) * setup.cssW) / setup.v.w)
  const samples = await page.evaluate(
    async ([n, r, c, pan]) => {
      const p = window.__world.probe(n, r, c)
      // eslint-disable-next-line no-new-func
      new Function(pan)()
      return p
    },
    [frames, row, col, startPan],
  )
  const stats = { samples: samples.length, row, col }
  if (samples.every((s) => s.phaserX === null && s.phaserY === null)) return { ok: false, reason: 'no marker in the Phaser canvas', stats, samples }
  if (samples.every((s) => s.threeX === null && s.threeY === null)) return { ok: false, reason: 'no marker in the three.js canvas', stats, samples }
  for (let i = 1; i < samples.length; i++) {
    if (samples[i].frame !== samples[i - 1].frame + 1) {
      return { ok: false, reason: `frames not consecutive: ${samples[i - 1].frame} -> ${samples[i].frame}`, stats, samples }
    }
  }
  // Per axis, per frame: found in both canvases or in neither — one without the other is a
  // disagreement too (the other canvas drew it somewhere else).
  let worst = 0
  let worstAt = null
  let paired = 0
  let oneSided = null
  for (const s of samples) {
    for (const [a, b] of [[s.phaserX, s.threeX], [s.phaserY, s.threeY]]) {
      if ((a === null) !== (b === null)) oneSided ??= `frame ${s.frame}: the marker is on the probe line in one canvas only (${a} vs ${b})`
      if (a !== null && b !== null) {
        paired++
        if (Math.abs(a - b) > worst) {
          worst = Math.abs(a - b)
          worstAt = s.frame
        }
      }
    }
  }
  if (worst > MAX_DX) {
    return { ok: false, reason: `the canvases disagree by ${worst.toFixed(2)} px on frame ${worstAt} (max ${MAX_DX})`, stats, samples }
  }
  if (oneSided) return { ok: false, reason: oneSided, stats, samples }
  const span = (k) => {
    const v = samples.map((s) => s[k]).filter((x) => x !== null)
    return v.length ? Math.max(...v) - Math.min(...v) : 0
  }
  const travel = Math.max(span('phaserX'), span('phaserY'))
  let moving = 0
  for (let i = 1; i < samples.length; i++) {
    const d = (k) => (samples[i][k] !== null && samples[i - 1][k] !== null ? Math.abs(samples[i][k] - samples[i - 1][k]) : 0)
    if (d('phaserX') >= 1 || d('phaserY') >= 1) moving++
  }
  Object.assign(stats, { paired, worst: +worst.toFixed(2), travel: +travel.toFixed(1), moving })
  // Every frame measured on at least one axis: a fast flight can carry one bar off the screen
  // (measured: 87/120 axis readings on a 366 px jetpack pan), never both while the pan stays
  // under the arm length.
  const blind = samples.find((x) => !((x.phaserX !== null && x.threeX !== null) || (x.phaserY !== null && x.threeY !== null)))
  if (blind) return { ok: false, reason: `frame ${blind.frame}: the marker is on neither probe line in both canvases`, stats, samples }
  if (travel < MIN_TRAVEL_PX || moving < MIN_MOVING_FRAMES) {
    return { ok: false, reason: `the pan did not move the marker (travel ${travel.toFixed(1)} px, ${moving} moving frames)`, stats, samples }
  }
  return { ok: true, reason: null, stats, samples }
}

/** The screenshot's pixel at CSS points (the page composites both canvases). */
async function screenPixels(page, points) {
  const b64 = (await page.screenshot()).toString('base64')
  return page.evaluate(
    async ([b, pts]) => {
      const img = new Image()
      img.src = `data:image/png;base64,${b}`
      await img.decode()
      const cv = document.createElement('canvas')
      cv.width = img.width
      cv.height = img.height
      const c = cv.getContext('2d')
      c.drawImage(img, 0, 0)
      return pts.map(([x, y]) => [...c.getImageData(x, y, 1, 1).data.slice(0, 3)])
    },
    [b64, points],
  )
}

const near = (a, b) => a.every((v, i) => Math.abs(v - b[i]) <= TOL)

try {
  // ---------------------------------------------------------------- sandbox
  const ctx = await stack.browser.newContext({ viewport: { width: 1280, height: 720 } })
  const page = await ctx.newPage()
  const errors = []
  page.on('pageerror', (e) => errors.push(String(e)))
  const openSandbox = async (extra = '') => {
    await page.goto(`${stack.viteUrl}/?e2e=1&sandbox=1&seed=4242${extra}`)
    await page.waitForFunction('!!window.__game && !!window.__world && window.__world.frames() > 2', null, { timeout: 60_000 })
  }
  await openSandbox()
  const backend = await page.evaluate(() => window.__world.backend)
  if (backend !== 'three') t.fail(`sandbox: the world renderer is "${backend}", not three.js`)
  await assertOrder(page, 'sandbox')

  // The test layer where Phaser draws nothing: hide Phaser's sky, find transparent points.
  const want = await page.evaluate(() => window.__world.expectedTestColor())
  const grid = []
  for (let y = 20; y < 720; y += 70) for (let x = 20; x < 1280; x += 90) grid.push([x, y])
  await page.evaluate(() => window.__game.skyVisible(false))
  await drawnFrames(page, 3)
  const alpha = await page.evaluate((pts) => window.__world.phaserAlpha(pts), grid)
  // Only points where nothing sits over the canvases (the sandbox's DOM panel and readout do).
  const onCanvas = await page.evaluate(
    (pts) => pts.map(([x, y]) => document.elementFromPoint(x, y) === document.querySelector('#game canvas:not([data-world])')),
    grid,
  )
  const clear = grid.filter((_, i) => alpha[i] === 0 && onCanvas[i])
  const shown = await screenPixels(page, clear)
  const bad = clear.filter((_, i) => !near(shown[i], want))
  if (clear.length < 5) {
    t.fail(`sandbox: with the sky hidden Phaser still covers ${grid.length - clear.length}/${grid.length} points — nowhere to see the world canvas`)
  } else if (bad.length) {
    t.fail(`sandbox: ${bad.length}/${clear.length} Phaser-transparent points do not show the test layer ${JSON.stringify(want)}: e.g. ${JSON.stringify(shown[clear.indexOf(bad[0])])} at ${bad[0]}`)
  } else {
    t.ok(`sandbox: the test layer ${JSON.stringify(want)} shows at all ${clear.length}/${grid.length} points Phaser leaves transparent`)
  }
  await page.screenshot({ path: join(shotsDir, 'world-canvas-sandbox-nosky.png') })
  console.log('  shot: shots/world-canvas-sandbox-nosky.png')
  // Control frame: the sky back on covers them, and the same comparison must fail there.
  await page.evaluate(() => window.__game.skyVisible(true))
  await drawnFrames(page, 3)
  const covered = await screenPixels(page, clear)
  const stillMatch = clear.filter((_, i) => near(covered[i], want)).length
  if (clear.length && stillMatch > clear.length / 2) {
    t.fail(`control: with the sky shown, ${stillMatch}/${clear.length} of those points still match the test layer — the comparison cannot fail`)
  } else {
    t.ok(`control: with Phaser's sky shown, ${stillMatch}/${clear.length} of those points match (the sky covers the layer)`)
  }
  await page.screenshot({ path: join(shotsDir, 'world-canvas-sandbox.png') })
  console.log('  shot: shots/world-canvas-sandbox.png')

  // R14: low halves the target and drops MSAA; full is the buffer with 4×.
  const tiers = await page.evaluate(async () => {
    const out = {}
    for (const on of [false, true]) {
      window.__game.setHighQuality(on)
      await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))
      out[on ? 'full' : 'low'] = window.__world.info()
    }
    window.__game.setHighQuality(false)
    return out
  })
  const { low, full } = tiers
  if (
    low?.tier === 'low' && full?.tier === 'full' &&
    low.target[0] === Math.round(low.buffer[0] / 2) && low.target[1] === Math.round(low.buffer[1] / 2) && low.samples === 0 &&
    full.target[0] === full.buffer[0] && full.target[1] === full.buffer[1] && full.samples === 4
  ) {
    t.ok(`tiers: low target ${low.target} of buffer ${low.buffer} (MSAA ${low.samples}), full ${full.target} (MSAA ${full.samples})`)
  } else {
    t.fail(`tiers: ${JSON.stringify(tiers)}`)
  }

  // One camera: pan by teleporting the player sideways; the rig eases the camera over frames.
  const sandPan = await measurePan(
    page,
    'sandbox',
    `const c = window.__game.debug().camera; window.__game.place(c.x + 260, c.y)`,
  )
  if (sandPan.ok) t.ok(`sandbox pan: both canvases agree on every frame ${JSON.stringify(sandPan.stats)}`)
  else t.fail(`sandbox pan: ${sandPan.reason} ${JSON.stringify(sandPan.stats)} ${JSON.stringify(sandPan.samples.slice(0, 6))}`)

  // Control: the stub renderer must fail the marker measurement by name.
  await openSandbox('&world=off')
  const off = await measurePan(
    page,
    'sandbox world=off',
    `const c = window.__game.debug().camera; window.__game.place(c.x + 260, c.y)`,
  )
  if (!off.ok && off.reason === 'no marker in the three.js canvas') {
    t.ok(`control: with the renderer off the marker check fails by name — "${off.reason}"`)
  } else {
    t.fail(`control: with the renderer off the marker check reported ${JSON.stringify({ ok: off.ok, reason: off.reason })}`)
  }
  if (errors.length) t.fail(`sandbox page errors: ${errors.slice(0, 3).join(' | ')}`)
  await ctx.close()

  // ---------------------------------------------------------------- networked match
  const { page: gp, shot, pageErrors } = await stack.openClient({ name: 'ana' })
  await enterBattle(gp, { label: 'world-canvas', waitPlaying: true })
  await gp.waitForFunction('!!window.__world && window.__world.frames() > 2', null, { timeout: 30_000 })
  await assertOrder(gp, 'match')
  // Pan through the match's own camera path: `__game.watch` points the rig (the §C2 e2e
  // affordance), stepped 6 world px a frame toward the map's middle for 45 frames. Walking and
  // flying were tried first and are coin flips here — a walled-in spawn moved 5 px in 1.5 s,
  // and a jetpack pan went anywhere from 0 to 366 px across three runs.
  const matchPan = await measurePan(
    gp,
    'match',
    `const v = window.__world.view(); const W = window.__game.debug().mapW
     const cx = v.x + v.w / 2, cy = v.y + v.h / 2, dir = cx < W / 2 ? 1 : -1
     let k = 0
     const step = () => { window.__game.watch(cx + dir * 6 * ++k, cy); if (k < 45) requestAnimationFrame(step) }
     requestAnimationFrame(step)`,
    40,
  )
  await gp.evaluate(() => window.__game.watch(null))
  if (matchPan.ok) t.ok(`match pan (camera via watch): both canvases agree on every frame ${JSON.stringify(matchPan.stats)}`)
  else t.fail(`match pan: ${matchPan.reason} ${JSON.stringify(matchPan.stats)} ${JSON.stringify(matchPan.samples.slice(0, 6))}`)
  await shot('world-canvas-match')
  if (pageErrors.length) t.fail(`match page errors: ${pageErrors.slice(0, 3).join(' | ')}`)
} catch (e) {
  t.fail(`threw: ${e.stack ?? e}`)
}
await t.finish(() => stack.close())
