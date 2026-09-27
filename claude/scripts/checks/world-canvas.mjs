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
 * 2. **The world canvas is visible where Phaser draws nothing** (sandbox). Phaser's own alpha
 *    is read back per point; at every point it left transparent the screenshot must show the
 *    world canvas's own pixel there, read back from it in a frame it drew (`__world.worldPixels`,
 *    the 2×2 buffer block the CSS pixel blends — the low tier is half size). T23.04: this was a
 *    flat test layer compared with `skyBottom` through a CPU ACES; the layer is the sky now (a
 *    gradient, bands, stars), so the comparison is with the canvas itself, and the post chain's
 *    colour is `look-sky`'s to measure against the mockup. **Control region:** at the points
 *    Phaser covers (terrain), the screenshot must mostly *not* match the world canvas — a
 *    comparison that cannot fail proves nothing. (Phaser's sky, which the old control showed
 *    covering the layer, is retired.)
 * 3. **One camera.** A world-anchored marker is drawn in both canvases; while the camera pans,
 *    each drawn frame reads the marker's screen x back from **both** canvases in the same
 *    frame (`__world.probe`, in Phaser's `postrender`, after both have drawn). They must agree
 *    to `MAX_DX` px on every frame, frames must be consecutive (counted, not timed), and the
 *    marker must actually move (a pan that did not happen would pass the agreement trivially).
 *    Laying the ortho camera out one event too early (`prerender`, last frame's `worldView`)
 *    is the `living-sky` trap and shows up here as a gap of one frame's pan.
 * 4. **R14's tier plumbing:** low renders the canvas and its target at half the display with no MSAA,
 *    full at the display with 4×.
 * 5. **Control: `&world=off`** (the draw-nothing stub) must fail the marker measurement **by
 *    name** — "no marker in the three.js canvas".
 *
 * T23.03B, from the review that planted bugs into the redraw skip and saw two stay green:
 * 6. **The view drawn is Phaser's, every frame (F1).** Each probed frame carries
 *    `cameras.main.worldView` and the view the world canvas last drew; they must be the same
 *    view (`worldRenderer-math.ts::sameView`, the skip's own comparison). Both pans get a
 *    **pure vertical leg** (x held, y stepped) — a skip that ignored `y` passed every
 *    horizontal pan.
 * 7. **Resize and tier switch with the camera still (F2).** Viewport 1280×720 → 1100×900: the
 *    canvases share the fractional FIT box exactly (F5), the buffer stays Phaser's resolution
 *    (R18: a resize never reallocates it), the test layer's pixels are read back and the marker
 *    still agrees. Then the tier is switched — which does reallocate — and the pixels are read
 *    again: a reallocated buffer is blank until redrawn, and nothing but the invalidation
 *    redraws it while the camera is still.
 * 8. **R18 on a DPR-2 screen:** the buffer is still 640×360 (low) / 1280×720 (full).
 * 9. **R20:** the checks store their tier explicitly (`lib/check-tier.mjs`): the page must read
 *    `'0'` and run low, whatever GPU string it detects (printed).
 */
import { join } from 'node:path'
import { startStack, enterBattle, tally, freePort, drawnFrames, shotsDir } from './harness.mjs'
import { HIGH_QUALITY_KEY } from '../lib/check-tier.mjs'

/** Agreement between the two canvases, CSS px: sub-pixel placement differs (MSAA vs roundPixels). */
const MAX_DX = 1.5
/** The pan has to move the marker this far on screen, and on this many frames. */
const MIN_TRAVEL_PX = 40
const MIN_MOVING_FRAMES = 5
/** Channel tolerance, screenshot vs the world canvas's own 2×2 block: 8-bit rounding in the page's scaler. */
const TOL = 3
/** Boxes are fractional under FIT (1100×618.75); the canvases must match to float noise. */
const BOX_EPS = 0.01
/** The low tier's buffer, R18: Phaser's 1280×720 game resolution × 0.5 — whatever the window or DPR. */
const GAME = [1280, 720]
const LOW = [640, 360]
const J = JSON.stringify

const t = tally('world-canvas')
// T23.09B: the match's map pinned (it was re-rolled every run, and the side of the map the spawn is on
// decides which way the watch pan goes — on 4242 it carries the tall bar across the probe column).
/**
 * The match's map, pinned (T23.09B: an unpinned map chose the pan direction). T23.09C F9 considered an unpinned second
 * leg and declined it: the probe's verdict depends on what the map puts on the probe line (T23.09B's ambiguous
 * crossings), so an unpinned leg is a coin flip by construction — a second pinned seed is the way to widen it.
 */
const MATCH_SEED = '4242'
const stack = await startStack({ port: await freePort(), label: 'world-canvas', env: { BOT_COUNT: '0', FIXED_SEED: MATCH_SEED } })

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
      return [b.left, b.top, b.width, b.height]
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
  } else if (o.boxes[0].some((v, i) => Math.abs(v - o.boxes[1][i]) > BOX_EPS)) {
    t.fail(`${where}: the canvases do not share a box (three, phaser): ${JSON.stringify(o.boxes)}`)
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
async function measurePan(page, where, startPan, frames = 40, { still = false, axis = null } = {}) {
  // A plus sign centred at (cx, cy), world px: a thin tall bar and a thin wide bar. Any row
  // within `ARM` of cy crosses it with a run centred on cx, and any column within `ARM` of cx
  // with a run centred on cy — so a pan of up to `ARM` in any direction stays measurable on
  // every frame (a small square left the probe lines on a fast jetpack pan: 45/60 frames).
  const setup = await page.evaluate(() => {
    window.__world.clearMarkers()
    const v = window.__world.view()
    const ARM = 400
    const BAR = 12
    const cx = Math.round(v.x + v.w / 2)
    const cy = Math.round(v.y + v.h / 2 - 50)
    window.__world.addMarker(cx - BAR / 2, cy - ARM, BAR, 2 * ARM)
    window.__world.addMarker(cx - ARM, cy - BAR / 2, 2 * ARM, BAR)
    const c = document.querySelector('#game canvas:not([data-world])')
    return { v, cx, cy, cssW: c.clientWidth, cssH: c.clientHeight, BAR }
  })
  // T23.09B: the bar's thickness on screen — the only run length the probe accepts as a crossing.
  const bar = (setup.BAR * setup.cssW) / setup.v.w
  await drawnFrames(page, 2)
  // Probe off the centre by a quarter view, so the row meets the tall bar and the column the wide one.
  const row = Math.round(((setup.cy + setup.v.h / 4 - setup.v.y) * setup.cssH) / setup.v.h)
  const col = Math.round(((setup.cx + setup.v.w / 4 - setup.v.x) * setup.cssW) / setup.v.w)
  const samples = await page.evaluate(
    async ([n, r, c, pan, b]) => {
      const p = window.__world.probe(n, r, c, b)
      // eslint-disable-next-line no-new-func
      new Function(pan)()
      return p
    },
    [frames, row, col, startPan, bar],
  )
  // Readings where a canvas had magenta on the line but no bar-thick crossing (the line along a bar, a feature).
  const rejected = samples.filter((x) => ['phaser', 'three'].some((k) => ['x', 'y'].some((a) => x.runs[k][a].length > 0 && x[`${k}${a.toUpperCase()}`] === null))).length
  const stats = { samples: samples.length, row, col, bar: +bar.toFixed(2), rejected }
  // T23.09B: a line crossing two bar-thick magenta runs cannot say which is the marker — fail by name
  // rather than pick one (the old search took the first run and read a map feature as the marker).
  const amb = samples.find((x) => x.ambiguous)
  if (amb) return { ok: false, reason: `frame ${amb.frame}: two marker-thick crossings on the ${amb.ambiguous} line ${J(amb.runs)}`, stats, samples }
  if (samples.every((s) => s.phaserX === null && s.phaserY === null)) return { ok: false, reason: 'no marker in the Phaser canvas', stats, samples }
  if (samples.every((s) => s.threeX === null && s.threeY === null)) return { ok: false, reason: 'no marker in the three.js canvas', stats, samples }
  for (let i = 1; i < samples.length; i++) {
    if (samples[i].frame !== samples[i - 1].frame + 1) {
      return { ok: false, reason: `frames not consecutive: ${samples[i - 1].frame} -> ${samples[i].frame}`, stats, samples }
    }
  }
  // F1: the view the world canvas shows is Phaser's, on every frame — drawn or skipped. Compared
  // here, field by field, **and** by the page's `sameView` (the skip's own function): a bug in
  // `sameView` would blind a check that only asked it.
  const eqView = (a, b) => !!a && !!b && a.x === b.x && a.y === b.y && a.w === b.w && a.h === b.h
  const stale = samples.find((x) => !eqView(x.worldView, x.drawnView))
  if (stale) {
    return { ok: false, reason: `frame ${stale.frame}: Phaser's worldView ${J(stale.worldView)} but the world canvas last drew ${J(stale.drawnView)} (drew this frame: ${stale.drew})`, stats, samples }
  }
  const split = samples.find((x) => x.same !== eqView(x.worldView, x.drawnView))
  if (split) return { ok: false, reason: `frame ${split.frame}: sameView says ${split.same} for ${J(split.worldView)} vs ${J(split.drawnView)}`, stats, samples }
  stats.views = samples.length
  stats.drawn = samples.filter((x) => x.drew).length
  // A leg meant to move one axis must hold the other, or it cannot tell a skip that ignores
  // one axis from one that works (the review's planted `y`).
  if (axis) {
    // Counted per frame: frames on which only `axis` moved are the ones that exercise it alone.
    // (The sandbox rig's snap can nudge x by a pixel on a frame or two; those frames just do
    // not count.)
    const other = axis === 'y' ? 'x' : 'y'
    let only = 0
    for (let i = 1; i < samples.length; i++) {
      const a = samples[i].worldView
      const b = samples[i - 1].worldView
      if (a[axis] !== b[axis] && a[other] === b[other]) only++
    }
    stats[`${axis}OnlyFrames`] = only
    if (only < MIN_MOVING_FRAMES) {
      return { ok: false, reason: `the ${axis} leg moved ${axis} alone on only ${only} frames (want ${MIN_MOVING_FRAMES})`, stats, samples }
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
    // T23.09B: the candidates on that frame — every magenta run on the probe row/column in each canvas.
    const at = samples.find((x) => x.frame === worstAt)
    console.log(`  ${where}: frame ${worstAt} candidates ${J(at?.runs)} picked phaser (${at?.phaserX}, ${at?.phaserY}) three (${at?.threeX}, ${at?.threeY}) view ${J(at?.worldView)}`)
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
  // T23.09C F9: a floor on what was compared at all — every frame read, and on average one axis a frame paired in both
  // canvases (logged across this check's runs: 80 of 80 on a 40-frame pan most often, 40 the least; 16 of 16 still).
  if (samples.length < frames) return { ok: false, reason: `only ${samples.length} of ${frames} frames were read`, stats, samples }
  if (paired < frames) return { ok: false, reason: `only ${paired} axis readings paired in both canvases over ${frames} frames (min ${frames})`, stats, samples }
  // Every frame measured on at least one axis: a fast flight can carry one bar off the screen
  // (measured: 87/120 axis readings on a 366 px jetpack pan), never both while the pan stays
  // under the arm length.
  const blind = samples.find((x) => !((x.phaserX !== null && x.threeX !== null) || (x.phaserY !== null && x.threeY !== null)))
  if (blind) return { ok: false, reason: `frame ${blind.frame}: the marker is on neither probe line in both canvases`, stats, samples }
  if (still) {
    if (moving > 0) return { ok: false, reason: `the camera was meant to be still but the marker moved on ${moving} frames`, stats, samples }
  } else if (travel < MIN_TRAVEL_PX || moving < MIN_MOVING_FRAMES) {
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


/** Inside the 2×2 block's range, per channel, give or take `TOL` (8-bit quantisation, the page's scaler). */
const within = (p, b) => p.every((v, i) => v >= b.min[i] - TOL && v <= b.max[i] + TOL)

/**
 * The world canvas where Phaser draws nothing: read Phaser's alpha back per point, and at every
 * transparent point on the canvas the screenshot must show the world canvas's own pixel. Returns
 * the points Phaser covers, for the control.
 */
async function worldShows(page, where) {
  // Markers left by a measurement would sit on some points (and CSS-scaling blurs three's edges
  // past Phaser's): this step is about the layer, so take them out of both canvases.
  await page.evaluate(() => window.__world.clearMarkers())
  const { W, H } = await page.evaluate(() => ({ W: innerWidth, H: innerHeight }))
  const grid = []
  for (let y = 20; y < H; y += 70) for (let x = 20; x < W; x += 90) grid.push([x, y])
  await drawnFrames(page, 3)
  const alpha = await page.evaluate((pts) => window.__world.phaserAlpha(pts), grid)
  // Only points where nothing sits over the canvases (the sandbox's DOM panel and readout do).
  const onCanvas = await page.evaluate(
    (pts) => pts.map(([x, y]) => document.elementFromPoint(x, y) === document.querySelector('#game canvas:not([data-world])')),
    grid,
  )
  const clear = grid.filter((_, i) => alpha[i] === 0 && onCanvas[i])
  const covered = grid.filter((_, i) => alpha[i] === 255 && onCanvas[i])
  const world = await page.evaluate((pts) => window.__world.worldPixels(pts), [...clear, ...covered])
  const shown = await screenPixels(page, [...clear, ...covered])
  const bad = clear.filter((_, i) => !within(shown[i], world[i]))
  if (clear.length < 5) {
    t.fail(`${where}: Phaser covers ${grid.length - clear.length}/${grid.length} points — nowhere to see the world canvas`)
  } else if (bad.length) {
    const k = clear.indexOf(bad[0])
    t.fail(`${where}: ${bad.length}/${clear.length} Phaser-transparent points do not show the world canvas: e.g. ${J(shown[k])} at ${bad[0]}, world ${J(world[k])}`)
  } else {
    t.ok(`${where}: the world canvas shows at all ${clear.length}/${grid.length} points Phaser leaves transparent`)
  }
  // Control region: where Phaser is opaque the same comparison must mostly fail.
  const coveredMatch = covered.filter((_, i) => within(shown[clear.length + i], world[clear.length + i])).length
  if (covered.length < 5) {
    t.fail(`${where}: control: only ${covered.length} Phaser-opaque points to compare`)
  } else if (coveredMatch > covered.length / 2) {
    t.fail(`${where}: control: ${coveredMatch}/${covered.length} points Phaser covers still match the world canvas — the comparison cannot fail`)
  } else {
    t.ok(`${where}: control: ${coveredMatch}/${covered.length} Phaser-covered points match the world canvas (Phaser's terrain covers it)`)
  }
}

/** Hold the camera where it is (the e2e `watch` hook), so nothing but the step under test changes the picture. */
/**
 * T23.04C F3: the world renderer is up and has drawn. `__world.frames()` counts **drawn** frames, and
 * the redraw skip draws none while the camera is still — a match spawn with a still camera starved
 * the old `frames() > 2` wait for its whole 30 s (T23.04B's suite run). So force one drawn frame
 * (`readFrame`: invalidate, resolve on the frame the world canvas drew), then wait on Phaser's frames.
 */
async function worldReady(page, timeout) {
  await page.waitForFunction(() => !!window.__world && !!window.__world.backend, null, { timeout })
  await page.evaluate(() => window.__world.readFrame())
  await drawnFrames(page, 2)
}

const holdStill = (page) =>
  page.evaluate(() => {
    const v = window.__world.view()
    window.__game.watch(v.x + v.w / 2, v.y + v.h / 2)
  })

/**
 * A pure vertical leg (F1): the camera centre stepped `dy` world px a frame in y with x held,
 * via `__game.watch`, away from the nearer top edge.
 */
const verticalLeg = (dy) => `const v = window.__world.view()
  const cx = v.x + v.w / 2, cy = v.y + v.h / 2, dir = v.y > 200 ? -1 : 1
  let k = 0
  const step = () => { window.__game.watch(cx, cy + dir * ${dy} * ++k); if (k < 45) requestAnimationFrame(step) }
  requestAnimationFrame(step)`

try {
  // ---------------------------------------------------------------- sandbox
  const ctx = await stack.browser.newContext({ viewport: { width: 1280, height: 720 } })
  const page = await ctx.newPage()
  const errors = []
  page.on('pageerror', (e) => errors.push(String(e)))
  const openSandbox = async (extra = '') => {
    await page.goto(`${stack.viteUrl}/?e2e=1&sandbox=1&seed=4242${extra}`)
    await page.waitForFunction('!!window.__game', null, { timeout: 60_000 })
    await worldReady(page, 60_000)
  }
  await openSandbox()
  const backend = await page.evaluate(() => window.__world.backend)
  if (backend !== 'three') t.fail(`sandbox: the world renderer is "${backend}", not three.js`)
  await assertOrder(page, 'sandbox')

  // R20: the check named its tier (lib/check-tier.mjs) — stored '0', running low, whatever GPU.
  const named = await page.evaluate((k) => ({ stored: localStorage.getItem(k), info: window.__world.info() }), HIGH_QUALITY_KEY)
  if (named.stored === '0' && named.info?.tier === 'low') {
    t.ok(`tier named: ${HIGH_QUALITY_KEY}='0' -> low (detected renderer "${named.info.gpu}")`)
  } else {
    t.fail(`tier not named: ${HIGH_QUALITY_KEY}=${J(named.stored)}, tier ${named.info?.tier}`)
  }

  await worldShows(page, 'sandbox')
  await page.screenshot({ path: join(shotsDir, 'world-canvas-sandbox.png') })
  console.log('  shot: shots/world-canvas-sandbox.png')

  // R14 + R18: low renders the canvas and its target at half of Phaser's game resolution with no
  // MSAA, full at the game resolution with 4× — never the CSS box times devicePixelRatio.
  const readTiers = (pg) =>
    pg.evaluate(async () => {
      const out = { dpr: devicePixelRatio }
      for (const on of [false, true]) {
        window.__game.setHighQuality(on)
        await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))
        out[on ? 'full' : 'low'] = window.__world.info()
      }
      window.__game.setHighQuality(false)
      return out
    })
  const same = (a, b) => a[0] === b[0] && a[1] === b[1]
  const tiersOk = ({ low, full }) =>
    low?.tier === 'low' && full?.tier === 'full' &&
    same(low.display, GAME) && same(low.buffer, LOW) && same(low.target, low.buffer) && low.samples === 0 &&
    same(full.buffer, GAME) && same(full.target, full.buffer) && full.samples === 4
  const tiers = await readTiers(page)
  if (tiersOk(tiers)) {
    t.ok(`tiers: low canvas+target ${tiers.low.target} of game ${tiers.low.display} (MSAA ${tiers.low.samples}), full ${tiers.full.target} (MSAA ${tiers.full.samples})`)
  } else {
    t.fail(`tiers: ${J(tiers)}`)
  }

  // One camera: pan by teleporting the player sideways; the rig eases the camera over frames.
  const sandPan = await measurePan(
    page,
    'sandbox',
    `const c = window.__game.debug().camera; window.__game.place(c.x + 260, c.y)`,
  )
  if (sandPan.ok) t.ok(`sandbox pan: both canvases agree on every frame ${J(sandPan.stats)}`)
  else t.fail(`sandbox pan: ${sandPan.reason} ${J(sandPan.stats)} ${J(sandPan.samples.slice(0, 6))}`)
  // F1: and a pure vertical leg.
  const sandV = await measurePan(page, 'sandbox vertical', verticalLeg(3), 40, { axis: 'y' })
  await page.evaluate(() => window.__game.watch(null))
  if (sandV.ok) t.ok(`sandbox vertical leg: the drawn view is Phaser's on every frame, canvases agree ${J(sandV.stats)}`)
  else t.fail(`sandbox vertical leg: ${sandV.reason} ${J(sandV.stats)} ${J(sandV.samples.slice(0, 4))}`)

  // F2 + F5 + R18: resize with the camera still, then switch tier with it still.
  await holdStill(page)
  await drawnFrames(page, 5)
  await page.setViewportSize({ width: 1100, height: 900 })
  await drawnFrames(page, 5)
  await assertOrder(page, 'resized 1100x900')
  const rinfo = await page.evaluate(() => window.__world.info())
  if (same(rinfo.buffer, LOW) && same(rinfo.display, GAME)) t.ok(`resized: buffer still ${rinfo.buffer} of game ${rinfo.display} (R18: a resize is CSS only)`)
  else t.fail(`resized: buffer ${rinfo.buffer}, game ${rinfo.display} — want ${LOW} of ${GAME}`)
  await worldShows(page, 'resized, camera still')
  const rStill = await measurePan(page, 'resized still', '', 8, { still: true })
  if (rStill.ok) t.ok(`resized, camera still: canvases agree ${J(rStill.stats)}`)
  else t.fail(`resized, camera still: ${rStill.reason} ${J(rStill.stats)} ${J(rStill.samples.slice(0, 3))}`)
  // Markers off first and the frame settled, so the tier switch is the only thing that can
  // cause a redraw (clearing markers is itself an invalidation).
  await page.evaluate(() => window.__world.clearMarkers())
  await drawnFrames(page, 3)
  for (const on of [true, false]) {
    const before = await page.evaluate(() => window.__world.frames())
    await page.evaluate((v) => window.__game.setHighQuality(v), on)
    await drawnFrames(page, 3)
    const drew = (await page.evaluate(() => window.__world.frames())) - before
    await worldShows(page, `tier switched to ${on ? 'full' : 'low'}, camera still (${drew} frame(s) redrawn)`)
  }
  await page.screenshot({ path: join(shotsDir, 'world-canvas-resized.png') })
  console.log('  shot: shots/world-canvas-resized.png')
  await page.evaluate(() => window.__game.watch(null))
  await page.setViewportSize({ width: 1280, height: 720 })

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
    t.fail(`control: with the renderer off the marker check reported ${J({ ok: off.ok, reason: off.reason })}`)
  }
  if (errors.length) t.fail(`sandbox page errors: ${errors.slice(0, 3).join(' | ')}`)
  await ctx.close()

  // ---------------------------------------------------------------- R18 on a DPR-2 screen
  const hi = await stack.browser.newContext({ viewport: { width: 1100, height: 900 }, deviceScaleFactor: 2 })
  const hp = await hi.newPage()
  await hp.goto(`${stack.viteUrl}/?e2e=1&sandbox=1&seed=4242`)
  await hp.waitForFunction('!!window.__game', null, { timeout: 60_000 })
  await worldReady(hp, 60_000)
  await assertOrder(hp, 'DPR 2, 1100x900')
  const hiTiers = await readTiers(hp)
  if (hiTiers.dpr === 2 && tiersOk(hiTiers)) {
    t.ok(`DPR ${hiTiers.dpr}: buffers low ${hiTiers.low.buffer} / full ${hiTiers.full.buffer} — Phaser's resolution, not the 2200-px-wide device box (R18)`)
  } else {
    t.fail(`DPR 2: ${J(hiTiers)}`)
  }
  await hi.close()

  // ---------------------------------------------------------------- networked match
  const { page: gp, shot, pageErrors } = await stack.openClient({ name: 'ana' })
  await enterBattle(gp, { label: 'world-canvas', waitPlaying: true })
  await worldReady(gp, 30_000)
  await assertOrder(gp, 'match')
  // T23.09C F9: the server's map seed (`welcome`'s, `debug().roundSeed`) — `debug().seed` is the mirror core's meta, which
  // read 1 in every logged run. Pinned by this stack's FIXED_SEED, and checked so.
  const seeds = await gp.evaluate(() => ({ round: String(window.__game.debug().roundSeed), core: String(window.__game.debug().seed) }))
  console.log(`  match map seed ${seeds.round} (server's; the mirror core's meta says ${seeds.core})`)
  if (seeds.round !== MATCH_SEED) t.fail(`the match's map seed is ${seeds.round}, not the pinned ${MATCH_SEED}`)
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
  if (matchPan.ok) t.ok(`match pan (camera via watch): both canvases agree on every frame ${JSON.stringify(matchPan.stats)}`)
  else t.fail(`match pan: ${matchPan.reason} ${JSON.stringify(matchPan.stats)} ${JSON.stringify(matchPan.samples.slice(0, 6))}`)
  // F1: and a pure vertical leg, through the same hook.
  const matchV = await measurePan(gp, 'match vertical', verticalLeg(3), 40, { axis: 'y' })
  await gp.evaluate(() => window.__game.watch(null))
  if (matchV.ok) t.ok(`match vertical leg: the drawn view is Phaser's on every frame, canvases agree ${J(matchV.stats)}`)
  else t.fail(`match vertical leg: ${matchV.reason} ${J(matchV.stats)} ${J(matchV.samples.slice(0, 4))}`)
  await shot('world-canvas-match')
  if (pageErrors.length) t.fail(`match page errors: ${pageErrors.slice(0, 3).join(' | ')}`)
} catch (e) {
  t.fail(`threw: ${e.stack ?? e}`)
}
await t.finish(() => stack.close())
