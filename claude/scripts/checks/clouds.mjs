/**
 * T21.31 — real clouds, on whichever renderer the page was given.
 *
 * Reported from play: *"the clouds you created are bad and buggy. they do not move
 * and are honestly too large. should have smaller clouds in different shapes and
 * sizes and colors."* His browser runs Phaser's **Canvas** renderer with High
 * Quality off, where T21.18's shader clouds could not exist — and `clouds-shader`,
 * the check this replaces, only ever ran on WebGL, so nothing noticed. This file is
 * registered twice in `e2e-checks.mjs`, once per renderer, and it refuses to pass on
 * the wrong one.
 *
 * What it asserts, each with its control:
 *
 * 1. **Renderer**: the page is drawing with the renderer its URL asked for.
 * 2. **Variety**, at the layer: widths, silhouettes, tints and speeds span a range.
 * 3. **Never in rock**: every cloud box across ten minutes of drift is open air —
 *    against the same sampler finding rock under the player's feet.
 * 4. **Drawn**: a framed cloud's box changes when the clouds alone are hidden, in
 *    one frozen instant; a patch of empty sky beside it does not.
 * 5. **High Quality only softens**: on, the cloud is still there and painted
 *    differently; off again restores the frame exactly. The sky's state is untouched.
 * 6. **It drifts**: with the camera still, the cloud's own contribution lines up at
 *    the shift its speed predicts between two clock values — and at zero between two
 *    readings of one clock.
 */

/** Fraction of a cloud's box that hiding the clouds must change. */
const DRAWN_FLOOR = 0.15
/** ...and of an empty patch, or between two photographs of one frame. Headroom for PNG, not a budget. */
const STILL_CEILING = 0.004
/** Screen px the recovered drift may miss the prediction by, beside a 15 % proportional allowance. */
const SHIFT_TOL_PX = 3
/** The drift this check aims to photograph, screen px: big enough to measure, small enough to stay framed. */
const SHIFT_AIM_PX = 40
/** Per-channel change that counts a pixel as changed. */
const THRESH = 6

/** Per-rect comparison of two screenshots: changed fraction, and the per-column change sum. */
function compare(page, a, b, rect) {
  return page.evaluate(
    async ([a64, b64, r, thr]) => {
      const load = async (src) => {
        const img = new Image()
        img.src = `data:image/png;base64,${src}`
        await img.decode()
        const cv = document.createElement('canvas')
        cv.width = img.width
        cv.height = img.height
        const c = cv.getContext('2d')
        c.drawImage(img, 0, 0)
        return c.getImageData(r.x, r.y, r.w, r.h).data
      }
      const A = await load(a64)
      const B = await load(b64)
      let n = 0
      const cols = new Array(r.w).fill(0)
      for (let y = 0; y < r.h; y++) {
        for (let x = 0; x < r.w; x++) {
          const i = (y * r.w + x) * 4
          const d = Math.max(Math.abs(A[i] - B[i]), Math.abs(A[i + 1] - B[i + 1]), Math.abs(A[i + 2] - B[i + 2]))
          if (d > thr) n++
          cols[x] += d
        }
      }
      return { frac: n / (r.w * r.h), cols }
    },
    [a, b, rect, THRESH],
  )
}

/** The shift that best lines up profile `b` with `a`: positive means the picture moved right. */
function bestShift(a, b, max) {
  let best = { shift: 0, err: Infinity }
  let zero = Infinity
  for (let s = -max; s <= max; s++) {
    let sum = 0
    let n = 0
    for (let i = Math.max(0, -s); i < Math.min(a.length, b.length - s); i++) {
      sum += Math.abs(a[i] - b[i + s])
      n++
    }
    if (n < a.length / 2) continue
    const err = sum / n
    if (s === 0) zero = err
    if (err < best.err) best = { shift: s, err }
  }
  return { ...best, zero }
}

export default async function ({ page, shot, log }) {
  const want = new URL(page.url()).searchParams.get('renderer') === 'canvas' ? 'canvas' : 'webgl'
  const dbg = () => page.evaluate(() => window.__game.debug())
  const grab = async () => (await page.screenshot()).toString('base64')

  await page.evaluate(() => window.__game.regenerate('4242', 'medium'))
  await page.waitForTimeout(700)
  // Noon, and both clocks pinned: the gradient and the drift are each a reason a
  // patch could change between two photographs.
  await page.evaluate(() => {
    window.__game.setTime(0.3 * 120)
    window.__game.setParallaxClock(0)
    window.__game.setHighQuality(false)
  })
  await page.waitForTimeout(400)
  const k = await page.evaluate(() => window.__game.constants())

  // --- 1. the renderer ----------------------------------------------------------
  const p0 = (await dbg()).parallax
  if (!p0) throw new Error('debug().parallax is missing — nothing below could fail')
  if (p0.renderer !== want) {
    throw new Error(`the URL asked for ${want} and Phaser is drawing with ${p0.renderer} — this run says nothing about ${want}`)
  }
  log(`renderer ${p0.renderer}: ${p0.clouds} clouds in the round`)

  // --- 2. variety, at the layer ---------------------------------------------------
  {
    const f = p0.cloudField
    if (f.length < 2) throw new Error(`${f.length} clouds — "many" is not one`)
    const span = (xs) => Math.max(...xs) - Math.min(...xs)
    const lum = (c) => 0.2126 * ((c >> 16) & 255) + 0.7152 * ((c >> 8) & 255) + 0.0722 * (c & 255)
    const widths = span(f.map((c) => c.w))
    const silhouettes = new Set(f.map((c) => c.lobes)).size
    const tints = span(f.map((c) => lum(c.tint)))
    const speeds = new Set(f.map((c) => c.vx.toFixed(4))).size
    log(`widths span ${widths.toFixed(0)} px, ${silhouettes} lobe counts, tint luminance span ${tints.toFixed(1)}, ${speeds} distinct speeds`)
    if (widths < 0.5 * (k.CLOUD_W_MAX - k.CLOUD_W_MIN)) throw new Error(`cloud widths span only ${widths.toFixed(0)} px`)
    if (silhouettes < 3) throw new Error(`only ${silhouettes} silhouettes across ${f.length} clouds`)
    if (!(tints > 0)) throw new Error('every cloud has the same tint')
    if (speeds !== f.length) throw new Error(`${speeds} distinct speeds across ${f.length} clouds — some keep station`)
    if (f.some((c) => c.w > k.CLOUD_W_MAX)) throw new Error('a cloud is wider than CLOUD_W_MAX')
  }

  // --- 3. never inside rock --------------------------------------------------------
  {
    const r = await page.evaluate(() => {
      const g = window.__game
      let boxes = 0
      let hits = 0
      let first = null
      const sample = (b) => {
        let n = 0
        for (let x = Math.ceil(b.left); x <= b.left + b.w; x += 3) {
          for (let y = Math.ceil(b.top); y <= b.top + b.h; y += 3) if (g.core.solidAt(x, y)) n++
        }
        return n
      }
      // Ten minutes of drift in 20 s steps: every cloud crosses a good part of the map.
      for (let t = 0; t <= 600; t += 20) {
        for (const b of g.cloudsAt(t)) {
          if (!b.visible) continue
          boxes++
          first ??= b
          hits += sample(b)
        }
      }
      // The control: the same sampler, on a cloud-sized box just under the player's feet.
      const me = g.debug().player
      const control = first && me ? sample({ left: me.x - first.w / 2, top: me.y + 4, w: first.w, h: first.h }) : 0
      return { boxes, hits, control }
    })
    log(`rock sweep: ${r.boxes} cloud boxes over 600 s, ${r.hits} rock samples; control box under the player: ${r.control}`)
    if (r.control === 0) throw new Error('the rock sampler found no rock under the player — "no rock in a cloud" below would mean nothing')
    if (r.boxes === 0) throw new Error('no cloud was placed in 600 s of drift')
    if (r.hits > 0) throw new Error(`${r.hits} rock samples inside cloud boxes — a cloud is in the terrain`)
  }

  // --- frame one cloud -------------------------------------------------------------
  // The widest visible cloud at clock 0, with the camera held upwind of it so its
  // drift carries it across the frame rather than out of it.
  const pick = await page.evaluate(() => {
    const g = window.__game
    const field = g.debug().parallax.cloudField
    const boxes = g.cloudsAt(0).filter((b) => b.visible)
    boxes.sort((a, b) => b.w - a.w)
    const b = boxes[0]
    return b ? { ...b, vx: field[b.index].vx } : null
  })
  if (!pick) throw new Error('no cloud is placed at clock 0')
  const camX = pick.left + pick.w / 2 + Math.sign(pick.vx) * 0.25 * p0.span
  const camY = pick.top + pick.h + 60
  await page.evaluate(([x, y]) => window.__game.watch(x, y), [camX, camY])
  // **Wait for the camera to stop, measured rather than slept.** The rig eases its
  // lookahead out over many frames, and on the Canvas renderer's lower frame rate a
  // 900 ms sleep left it creeping: two photographs of one frame differed by 14 %.
  {
    let last = null
    let still = 0
    const deadline = Date.now() + 15_000
    while (still < 3) {
      if (Date.now() > deadline) throw new Error(`the camera never settled on the watched cloud (last view ${JSON.stringify(last)})`)
      await page.waitForTimeout(200)
      const v = await page.evaluate(() => window.__game.debug().worldView)
      still = last && v.x === last.x && v.y === last.y ? still + 1 : 0
      last = v
    }
  }

  const rects = await page.evaluate((b) => {
    const g = window.__game
    const v = g.debug().worldView
    const r = document.querySelector('canvas').getBoundingClientRect()
    const sx = r.width / v.w
    const sy = r.height / v.h
    const toClient = (w) => ({
      x: Math.round(r.left + (w.left - v.x) * sx),
      y: Math.round(r.top + (w.top - v.y) * sy),
      w: Math.round(w.w * sx),
      h: Math.round(w.h * sy),
    })
    const drawn = g.debug().parallax.cloudBoxes
    // Empty sky for the control: the cloud's own size, slid sideways until it
    // touches no drawn cloud and no rock, and stays on the canvas.
    const clear = (w) =>
      w.left >= v.x && w.left + w.w <= v.x + v.w && w.top >= v.y &&
      !drawn.some((d) => d.left < w.left + w.w && d.left + d.w > w.left && d.top < w.top + w.h && d.top + d.h > w.top) &&
      (() => {
        for (let x = w.left; x <= w.left + w.w; x += 3) for (let y = w.top; y <= w.top + w.h; y += 3) if (g.core.solidAt(Math.round(x), Math.round(y))) return false
        return true
      })()
    let control = null
    for (let step = 1; step < 12 && !control; step++) {
      for (const dir of [-1, 1]) {
        const w = { left: b.left + dir * step * (b.w * 0.6), top: b.top, w: b.w, h: b.h }
        if (clear(w)) {
          control = w
          break
        }
      }
    }
    return {
      view: { x: v.x, y: v.y },
      sx,
      drawnHere: drawn.some((d) => d.index === b.index),
      cloud: toClient(b),
      control: control ? toClient(control) : null,
    }
  }, pick)
  if (!rects.drawnHere) throw new Error(`cloud ${pick.index} is framed and the layer did not draw it`)
  if (!rects.control) throw new Error('no patch of empty sky beside the framed cloud — the control cannot be taken')
  log(`cloud ${pick.index} (${pick.w.toFixed(0)} px, vx ${pick.vx.toFixed(1)} px/s) at client ${JSON.stringify(rects.cloud)}; control ${JSON.stringify(rects.control)}`)

  // --- 4. drawn ----------------------------------------------------------------------
  const on = await grab()
  await shot(`clouds-${want}`)
  const again = await grab()
  const hid = await page.evaluate(() => window.__game.setCloudsVisible(false))
  const off = await grab()
  const shown = await page.evaluate(() => window.__game.setCloudsVisible(true))
  if (hid.visible !== false || shown.visible !== true) throw new Error('setCloudsVisible did not read back what it was asked')
  const inBox = (await compare(page, on, off, rects.cloud)).frac
  const inControl = (await compare(page, on, off, rects.control)).frac
  const noise = (await compare(page, on, again, rects.cloud)).frac
  log(`hiding the clouds changed ${(inBox * 100).toFixed(1)}% of the cloud box, ${(inControl * 100).toFixed(2)}% of empty sky; noise ${(noise * 100).toFixed(2)}%`)
  if (noise > STILL_CEILING) throw new Error(`two photographs of one frozen frame differ by ${(noise * 100).toFixed(2)}% — nothing below is a control`)
  if (inControl > STILL_CEILING) throw new Error(`hiding the clouds changed ${(inControl * 100).toFixed(2)}% of empty sky — the toggle is moving more than clouds`)
  if (inBox < DRAWN_FLOOR) throw new Error(`the framed cloud is ${(inBox * 100).toFixed(1)}% of its box on screen — not a cloud anyone can see`)

  // --- 5. High Quality only softens ------------------------------------------------
  {
    const before = await dbg()
    const hq = await page.evaluate(() => window.__game.setHighQuality(true))
    if (hq.cloudRings !== k.CLOUD_RINGS_HQ) throw new Error(`High Quality on paints ${hq.cloudRings} rings, CLOUD_RINGS_HQ is ${k.CLOUD_RINGS_HQ}`)
    await page.waitForTimeout(300)
    const soft = await grab()
    const after = await dbg()
    for (const key of ['skyPhase', 'darkness', 'fov', 'fogAlpha', 'fogStrength']) {
      const a = before[key]
      const b = after[key]
      if (!(typeof a === 'number' ? Math.abs(a - b) < 1e-6 : a === b)) throw new Error(`High Quality moved ${key}: ${a} -> ${b}`)
    }
    const stillThere = (await compare(page, soft, off, rects.cloud)).frac
    const repainted = (await compare(page, soft, on, rects.cloud)).frac
    const plain = await page.evaluate(() => window.__game.setHighQuality(false))
    if (plain.cloudRings !== k.CLOUD_RINGS) throw new Error(`High Quality off paints ${plain.cloudRings} rings, CLOUD_RINGS is ${k.CLOUD_RINGS}`)
    await page.waitForTimeout(300)
    const restored = (await compare(page, await grab(), on, rects.cloud)).frac
    log(`High Quality: cloud ${(stillThere * 100).toFixed(1)}% of its box, repainted ${(repainted * 100).toFixed(1)}%, off again ${(restored * 100).toFixed(2)}% from the original`)
    if (stillThere < DRAWN_FLOOR) throw new Error('with High Quality on the cloud is gone')
    if (!(repainted > STILL_CEILING)) throw new Error('High Quality paints the cloud exactly as it was — the setting reaches nothing')
    if (restored > STILL_CEILING) throw new Error(`turning High Quality off left the cloud ${(restored * 100).toFixed(2)}% different`)
  }

  // --- 6. it drifts, with the camera still ------------------------------------------
  {
    const T = Math.min(20, Math.max(1, SHIFT_AIM_PX / (Math.abs(pick.vx) * rects.sx)))
    const predicted = pick.vx * T * rects.sx
    const strip = {
      x: Math.round(Math.min(rects.cloud.x, rects.cloud.x + predicted) - 12),
      y: rects.cloud.y,
      w: Math.round(rects.cloud.w + Math.abs(predicted) + 24),
      h: rects.cloud.h,
    }
    const same = await compare(page, on, await grab(), strip)
    await page.evaluate((t) => window.__game.setParallaxClock(t), T)
    await page.waitForTimeout(300)
    const moved = await grab()
    const view = await page.evaluate(() => window.__game.debug().worldView)
    if (view.x !== rects.view.x || view.y !== rects.view.y) {
      throw new Error(`the camera moved (${rects.view.x},${rects.view.y} -> ${view.x},${view.y}) — this is not "moving with the camera still"`)
    }
    const p0c = (await compare(page, on, off, strip)).cols
    const p1c = (await compare(page, moved, off, strip)).cols
    const got = bestShift(p0c, p1c, Math.ceil(Math.abs(predicted) * 2 + 10))
    log(`over ${T.toFixed(2)} s the cloud lines up best at ${got.shift} px (predicted ${predicted.toFixed(1)}); unshifted error ${got.zero.toFixed(1)}, best ${got.err.toFixed(1)}; same clock twice: ${(same.frac * 100).toFixed(2)}% changed`)
    if (same.frac > STILL_CEILING) throw new Error(`the strip changed ${(same.frac * 100).toFixed(2)}% with the clock pinned — something else moves there`)
    if (Math.abs(got.shift - predicted) > Math.max(SHIFT_TOL_PX, 0.15 * Math.abs(predicted))) {
      throw new Error(`the cloud moved ${got.shift} px where its speed predicts ${predicted.toFixed(1)} — it is not drifting at its own speed`)
    }
    if (!(got.err < got.zero)) throw new Error('shifting the profile matched no better than not shifting it — nothing drifted')
  }

  await page.evaluate(() => {
    window.__game.setParallaxClock(null)
    window.__game.setTime(null)
    window.__game.watch(null)
  })
}
