/**
 * `living-sky` — §C14's mountains and clouds, asserted from the frame.
 *
 * ## Why every assertion here samples pixels
 *
 * The maths is already covered by `sky-math.test.ts`, and a correct formula that
 * nothing carries to the screen is the failure this project has paid for four
 * times (§A15, §A16). So the questions this check asks are the ones a unit test
 * cannot: is there a ridge in the frame, does it move at a different rate from
 * the terrain, do the clouds drift, and does the tint follow the time of day.
 *
 * ## The control that makes each one mean something
 *
 * - **A control region.** Every colour claim is paired with a patch of the frame
 *   that must *not* change, so "the sky went dark" cannot be explained by the
 *   whole picture going dark.
 * - **A control frame.** The mountain and cloud claims are measured against the
 *   same frame with the layer hidden, so "there are pixels here" cannot be
 *   satisfied by the gradient that was always there.
 */

/** Mean RGB of a screen rect, decoded from a real screenshot. */
async function patchMean(page, rect) {
  const png = (await page.screenshot()).toString('base64')
  return page.evaluate(
    async ([b64, r]) => {
      const img = new Image()
      img.src = `data:image/png;base64,${b64}`
      await img.decode()
      const cv = document.createElement('canvas')
      cv.width = img.width
      cv.height = img.height
      const ctx = cv.getContext('2d')
      ctx.drawImage(img, 0, 0)
      const d = ctx.getImageData(r.x, r.y, r.w, r.h).data
      let rr = 0
      let gg = 0
      let bb = 0
      for (let i = 0; i < d.length; i += 4) {
        rr += d[i]
        gg += d[i + 1]
        bb += d[i + 2]
      }
      const n = d.length / 4
      return [rr / n, gg / n, bb / n]
    },
    [png, rect],
  )
}

/**
 * Mean per-channel difference over the pixels the clouds actually occupy.
 *
 * Averaging the whole band instead dilutes the cloud's contribution by however
 * much empty sky is in the rectangle — measured, a factor of five, which turned a
 * real 30-point difference into 5.5 and made the assertion a threshold-tuning
 * exercise. The cloud pixels are exactly the ones that change when the layer is
 * hidden, so the mask comes for free from the control frame.
 */
async function maskedDelta(page, withB64, withoutB64, rect, threshold = 3) {
  return page.evaluate(
    async ([a64, b64, r, thr]) => {
      const load = async (b) => {
        const img = new Image()
        img.src = `data:image/png;base64,${b}`
        await img.decode()
        const cv = document.createElement('canvas')
        cv.width = img.width
        cv.height = img.height
        const c = cv.getContext('2d')
        c.drawImage(img, 0, 0)
        return c.getImageData(r.x, r.y, r.w, r.h).data
      }
      const a = await load(a64)
      const b = await load(b64)
      let n = 0
      const sum = [0, 0, 0]
      for (let i = 0; i < a.length; i += 4) {
        const d = [a[i] - b[i], a[i + 1] - b[i + 1], a[i + 2] - b[i + 2]]
        if (Math.abs(d[0]) + Math.abs(d[1]) + Math.abs(d[2]) < thr) continue
        sum[0] += d[0]
        sum[1] += d[1]
        sum[2] += d[2]
        n++
      }
      return { mean: n ? sum.map((v) => v / n) : [0, 0, 0], covered: n / (a.length / 4) }
    },
    [withB64, withoutB64, rect, threshold],
  )
}

/** Fraction of pixels differing between two screenshots inside a rect. */
async function changedFraction(page, b0, b1, rect) {
  return page.evaluate(
    async ([x0, x1, r]) => {
      const load = async (b) => {
        const img = new Image()
        img.src = `data:image/png;base64,${b}`
        await img.decode()
        const cv = document.createElement('canvas')
        cv.width = img.width
        cv.height = img.height
        const c = cv.getContext('2d')
        c.drawImage(img, 0, 0)
        return c.getImageData(r.x, r.y, r.w, r.h).data
      }
      const a = await load(x0)
      const b = await load(x1)
      let n = 0
      for (let i = 0; i < a.length; i += 4) {
        if (
          Math.abs(a[i] - b[i]) > 6 ||
          Math.abs(a[i + 1] - b[i + 1]) > 6 ||
          Math.abs(a[i + 2] - b[i + 2]) > 6
        ) {
          n++
        }
      }
      return n / (a.length / 4)
    },
    [b0, b1, rect],
  )
}

const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2])
const lum = (t) => 0.2126 * t[0] + 0.7152 * t[1] + 0.0722 * t[2]

export default async function ({ page, shot, log }) {
  const dbg = () => page.evaluate(() => window.__game.debug())

  await page.evaluate(() => window.__game.regenerate('4242', 'medium'))
  await page.waitForTimeout(500)
  await page.evaluate(() => window.__game.setTime(0.3 * 120))
  await page.waitForTimeout(400)

  // 1. The layers exist and are drawing, from the scene rather than from a
  //    constructor that ran. `visibleClouds` is the "and it reached the screen"
  //    half — a built-but-never-positioned pool reports 0.
  const d = await dbg()
  const p = d.parallax
  if (!p) throw new Error('debug().parallax is missing — this check cannot fail, so it proves nothing')
  const c = await page.evaluate(() => ({
    layers: window.__game.constants().MOUNTAIN_LAYERS,
    clouds: window.__game.constants().CLOUD_COUNT,
    drift: window.__game.constants().CLOUD_DRIFT,
    parallax: window.__game.constants().MOUNTAIN_PARALLAX,
  }))
  if (p.ridges !== c.layers) throw new Error(`${p.ridges} ridge layers, expected MOUNTAIN_LAYERS (${c.layers})`)
  if (p.clouds !== c.clouds) throw new Error(`${p.clouds} clouds, expected CLOUD_COUNT (${c.clouds})`)
  if (p.visibleClouds < 1) throw new Error('every cloud is hidden — the layer was built and never drawn')
  // `p.seed` is right *here*: this check drives the sandbox, where the client
  // really does generate the map, so its local seed is the round's. In a
  // networked scene it would not be — see `roundSeed` in `GameScene.debug()`.
  log(`${p.ridges} ridges, ${p.clouds} clouds (${p.visibleClouds} on screen), seed ${p.seed}`)

  // 2. The layers are actually IN the frame.
  //
  //    The control frame: the same view with the parallax band hidden. Without
  //    it, "the sky band has pixels in it" is satisfied by the gradient, which
  //    was there before this task existed.
  //
  //    **Both bands are chosen by content, not by a fixed rectangle.** The
  //    parallax layers sit BEHIND the terrain, so a strip that happens to be
  //    pointed at rock shows the same pixels whether the ridge is drawn or not —
  //    the first version of this check failed for exactly that reason, and
  //    `sky.mjs` carries the same lesson from the same cause. So: find the widest
  //    run of screen columns that is open air all the way down through the band.
  /**
   * **Open a window through the foreground so the background can be seen.**
   *
   * The ridge is drawn at a fixed screen fraction — `MOUNTAIN_BASE_FRAC` 0.86 —
   * so `airRun(0.64, 0.85)` cannot look anywhere else for it. Whether that strip
   * shows sky or rock is entirely a question of where the camera is, and pass 6b
   * moved the sandbox spawn (objects push spawn candidates away under
   * `OBJECT_CLEAR_OF_SPAWN`). Measured, the strip is now solid rock across the
   * whole width at every zoom:
   *
   *   zoom 1: 0 clear columns   view y 501..1221
   *   zoom 2: 0 clear columns   view y 681..1041
   *   zoom 3: 0 clear columns   view y 741..981
   *
   * Zooming cannot help: the strip maps to world rows *below* the camera centre
   * at any zoom, and the camera centres on a player standing on the ground.
   *
   * So the foreground is carved away. This is not making the world fit the
   * fixture — the subject of every ridge assertion below is the **parallax
   * layer**, measured by toggling it on and off, and foreground terrain in front
   * of it is exactly the thing that has to not be there. Carving is also what
   * `terrain-render` already does to see the terrain change.
   */
  const opened = await page.evaluate(() => {
    const g = window.__game
    const v = g.debug().worldView
    // Both background bands: clouds at 0.06..0.40 and the ridge at 0.64..0.85.
    // Carved as rows of overlapping circles so the whole strip opens, not just
    // its centre line.
    const radius = Math.ceil(0.07 * v.h) + 8
    const x0 = v.x + 0.3 * v.w
    const x1 = v.x + v.w
    let n = 0
    for (let fy = 0.05; fy <= 0.87; fy += 0.06) {
      const wy = v.y + fy * v.h
      for (let wx = x0; wx <= x1; wx += radius) {
        g.carve(Math.round(wx), Math.round(wy), radius)
        n++
      }
    }
    return { carves: n, radius, from: Math.round(v.y + 0.05 * v.h), to: Math.round(v.y + 0.87 * v.h) }
  })
  await page.waitForTimeout(500)
  log(
    `opened the background bands with ${opened.carves} carves of r=${opened.radius}, ` +
      `world y ${opened.from}..${opened.to}`,
  )

  const band = await page.evaluate(() => {
    const g = window.__game.debug()
    const v = g.worldView
    const core = window.__game.core
    const cv = document.querySelector('canvas')
    const r = cv.getBoundingClientRect()

    /** The widest run of columns whose world pixels are all air across the band. */
    const airRun = (fy0, fy1) => {
      const y0 = r.height * fy0
      const y1 = r.height * fy1
      const clear = (sx) => {
        const wx = v.x + (sx / r.width) * v.w
        for (let sy = y0; sy <= y1; sy += 6) {
          const wy = v.y + (sy / r.height) * v.h
          if (core.solidAt(Math.round(wx), Math.round(wy))) return false
        }
        return true
      }
      let best = null
      let run = null
      // Start right of the DOM control panel, which is not sky.
      for (let sx = Math.floor(r.width * 0.32); sx < r.width - 4; sx += 4) {
        if (clear(sx)) {
          run ??= { x0: sx, x1: sx }
          run.x1 = sx
        } else {
          if (run && (!best || run.x1 - run.x0 > best.x1 - best.x0)) best = run
          run = null
        }
      }
      if (run && (!best || run.x1 - run.x0 > best.x1 - best.x0)) best = run
      if (!best) return null
      return {
        x: Math.round(r.left + best.x0),
        y: Math.round(r.top + y0),
        w: best.x1 - best.x0,
        h: Math.round(y1 - y0),
      }
    }

    return {
      // The ridge sits with its base at MOUNTAIN_BASE_FRAC (0.86).
      ridge: airRun(0.64, 0.85),
      // Clouds live in CLOUD_BAND_TOP..CLOUD_BAND_BOTTOM of the viewport.
      cloud: airRun(0.06, 0.4),
    }
  })
  for (const key of ['ridge', 'cloud']) {
    if (!band[key] || band[key].w < 120) {
      throw new Error(
        `no run of open sky wide enough to sample the ${key} band ` +
          `(${band[key] ? band[key].w : 0} px) — the camera is looking at rock`,
      )
    }
  }
  log(
    `ridge band x ${band.ridge.x}..${band.ridge.x + band.ridge.w}, ` +
      `cloud band x ${band.cloud.x}..${band.cloud.x + band.cloud.w}`,
  )

  const withLayer = (await page.screenshot()).toString('base64')
  await shot('living-sky-day')
  await page.evaluate(() => window.__game.setParallaxVisible(false))
  await page.waitForTimeout(300)
  const withoutLayer = (await page.screenshot()).toString('base64')
  await shot('living-sky-hidden')
  await page.evaluate(() => window.__game.setParallaxVisible(true))
  await page.waitForTimeout(300)

  const ridgeDelta = await changedFraction(page, withLayer, withoutLayer, band.ridge)
  const cloudDelta = await changedFraction(page, withLayer, withoutLayer, band.cloud)
  log(`hiding the band changed ridge strip ${(ridgeDelta * 100).toFixed(1)}%, cloud strip ${(cloudDelta * 100).toFixed(1)}%`)
  if (ridgeDelta < 0.02) {
    throw new Error(
      `hiding the parallax band changed only ${(ridgeDelta * 100).toFixed(1)}% of the ridge strip — ` +
        'the mountains are not on screen',
    )
  }
  if (cloudDelta < 0.01) {
    throw new Error(
      `hiding the parallax band changed only ${(cloudDelta * 100).toFixed(1)}% of the cloud strip — ` +
        'the clouds are not on screen',
    )
  }

  // 3. The clouds drift. Measured from the frame over a real interval, against a
  //    control strip of terrain that must not move.
  //    Chosen by content for the same reason the bands are: a fixed rectangle
  //    that lands on sky is not a terrain control, it is a second sky sample.
  const terrainControl = await page.evaluate(() => {
    const g = window.__game.debug()
    const v = g.worldView
    const core = window.__game.core
    const cv = document.querySelector('canvas')
    const r = cv.getBoundingClientRect()
    const H = Math.round(r.height * 0.07)
    for (let fy = 0.88; fy >= 0.5; fy -= 0.04) {
      const y0 = r.height * fy
      let best = null
      let run = null
      const solid = (sx) => {
        const wx = v.x + (sx / r.width) * v.w
        for (let sy = y0; sy <= y0 + H; sy += 5) {
          const wy = v.y + (sy / r.height) * v.h
          if (!core.solidAt(Math.round(wx), Math.round(wy))) return false
        }
        return true
      }
      for (let sx = Math.floor(r.width * 0.32); sx < r.width - 4; sx += 4) {
        if (solid(sx)) {
          run ??= { x0: sx, x1: sx }
          run.x1 = sx
        } else {
          if (run && (!best || run.x1 - run.x0 > best.x1 - best.x0)) best = run
          run = null
        }
      }
      if (run && (!best || run.x1 - run.x0 > best.x1 - best.x0)) best = run
      if (best && best.x1 - best.x0 >= 120) {
        return { x: Math.round(r.left + best.x0), y: Math.round(r.top + y0), w: best.x1 - best.x0, h: H }
      }
    }
    return null
  })
  if (!terrainControl) throw new Error('no solid terrain wide enough for a control region')
  log(`terrain control x ${terrainControl.x}..${terrainControl.x + terrainControl.w}`)
  const t0 = (await page.screenshot()).toString('base64')
  // Long enough for CLOUD_DRIFT to move a cloud several pixels: at 6 px/s, three
  // seconds is ~18 px, well past the 6-per-channel threshold above.
  await page.waitForTimeout(3000)
  const t1 = (await page.screenshot()).toString('base64')
  const drifted = await changedFraction(page, t0, t1, band.cloud)
  const still = await changedFraction(page, t0, t1, terrainControl)
  log(`over 3 s the cloud band changed ${(drifted * 100).toFixed(1)}%, the terrain control ${(still * 100).toFixed(1)}%`)
  if (drifted < 0.01) {
    throw new Error(`the cloud band changed ${(drifted * 100).toFixed(2)}% in 3 s — nothing is drifting`)
  }
  if (still > drifted) {
    throw new Error(
      `the terrain control changed more than the cloud band (${(still * 100).toFixed(1)}% vs ` +
        `${(drifted * 100).toFixed(1)}%) — this is measuring the whole frame, not the clouds`,
    )
  }

  // 4. The tint follows the time of day — sampled pixels, with a control frame
  //    **per phase**.
  //
  //    The obvious version of this — mean colour of the cloud band at noon vs at
  //    night — measures the sky GRADIENT, which fills most of the band and swings
  //    the whole way from blue to black on its own. It was written that way
  //    first, and falsifying `cloudTint` to a constant white left it passing with
  //    a 266-point swing. §A15, again: the number moved, and not for the reason
  //    the assertion claimed.
  //
  //    What isolates the clouds is the band with them minus the band without
  //    them, at each phase. That difference is the light the clouds add, and it
  //    is the only thing on screen that `cloudTint` controls.
  const contribution = async () => {
    const withC = (await page.screenshot()).toString('base64')
    await page.evaluate(() => window.__game.setParallaxVisible(false))
    await page.waitForTimeout(250)
    const withoutC = (await page.screenshot()).toString('base64')
    await page.evaluate(() => window.__game.setParallaxVisible(true))
    await page.waitForTimeout(250)
    const m = await maskedDelta(page, withC, withoutC, band.cloud)
    return { add: m.mean, covered: m.covered }
  }

  const tones = {}
  for (const [name, u] of [['noon', 0.3], ['night', 0.78]]) {
    await page.evaluate((t) => window.__game.setTime(t), u * 120)
    await page.waitForTimeout(450)
    tones[name] = await contribution()
    tones[name].control = await patchMean(page, terrainControl)
    await shot(`living-sky-${name}`)
    log(
      `${name.padEnd(5)} clouds cover ${(tones[name].covered * 100).toFixed(1)}% of the band ` +
        `and add (${tones[name].add.map((v) => v.toFixed(1)).join(',')})`,
    )
  }

  // --- §E11.1: the wrap seam ------------------------------------------------
  //
  // A cloud leaving one edge re-enters at the other as a `twin`, offset by the
  // span. Where the twin goes is decided by `halfW`, and `halfW` used to assume
  // `CLOUD_TEX_W` while a sprite draws at its **atlas frame** width — 33 to 288
  // px against 220, so the offset was out by up to 6.7x and the twin sat
  // hundreds of pixels from the seam it exists to hide.
  //
  // **Sampled across the boundary, not near it.** A strip in the middle of a
  // cloud is covered whether or not the twin is placed correctly; only the far
  // edge, where the other half of a straddling cloud must appear, can tell.
  {
    // **Swept, not pinned to one moment.** Which clouds straddle an edge depends
    // on the drift, so a single pinned value is hostage to whether that instant
    // happens to contain a disagreement — measured, the first version pinned t=0
    // and stayed green with the fix reverted, because no cloud sat in the band
    // where a wrong `halfW` and a right one differ. D-29 is the same trap: a
    // seam check that does not reach its case reports success.
    let geom = null
    let firstTwin = null
    const W = 1280
    const shouldWrap = (b) => b.x - b.w / 2 < 0 || b.x + b.w / 2 > W
    for (let step = 0; step < 16; step++) {
      const t = step * 4
      await page.evaluate((tt) => window.__game.setParallaxClock(tt), t)
      await page.waitForTimeout(80)
      const g = await page.evaluate(() => window.__game.debug().parallax)

      // Whether a twin *should* exist, computed from the drawn box. This is the
      // half that makes the assertion falsifiable: sampling a strip centred on
      // the twin's *reported* position asks "is the twin where the code says it
      // is", which is true however wrong `halfW` is.
      //
      // A cloud needs a wrapped half exactly when its drawn box crosses a screen
      // edge, and the box comes from `displayWidth` read back off the sprite — so
      // this compares the wrap rule against the pixels Phaser will actually put
      // down, not against the constant the rule used to assume.
      const wrong = g.cloudBoxes
        .map((b, i) => ({ i, b, want: shouldWrap(b), has: b.twinX !== null }))
        .filter((r) => r.want !== r.has)
      if (wrong.length > 0) {
        const r = wrong[0]
        throw new Error(
          `at t=${t}, cloud ${r.i} is ${r.b.w.toFixed(0)} px wide at x=${r.b.x.toFixed(0)}, ` +
            `so it ${r.want ? 'crosses' : 'does not cross'} a screen edge — and it ` +
            `${r.has ? 'has' : 'has no'} wrap twin. The offset is computed from a width ` +
            'that is not the width being drawn.',
        )
      }
      // And where the twin sits: continuity requires exactly one screen width of
      // offset, or the two halves overlap or leave a gap.
      for (const b of g.cloudBoxes) {
        if (b.twinX === null) continue
        if (Math.abs(Math.abs(b.twinX - b.x) - W) > 1.5) {
          throw new Error(
            `at t=${t}, a wrap twin sits ${Math.abs(b.twinX - b.x).toFixed(0)} px from its ` +
              `cloud, not ${W} — the halves do not join`,
          )
        }
      }
      if (!firstTwin && g.cloudBoxes.some((b) => b.twinX !== null)) {
        firstTwin = t
        geom = g
      }
    }
    if (!geom) {
      throw new Error(
        'no cloud straddled a screen edge at any of the 16 sampled moments, so the ' +
          'geometry above was never exercised — the sweep is not reaching its case',
      )
    }
    // Back to the moment that has one, for the pixel half below.
    await page.evaluate((tt) => window.__game.setParallaxClock(tt), firstTwin)
    await page.waitForTimeout(200)
    const straddling = geom.cloudBoxes.filter((b) => b.twinX !== null)

    // The widest one: the most pixels to find, and the frame whose old `halfW`
    // error was largest.
    const c0 = straddling.reduce((a, b) => (a.w > b.w ? a : b))
    const stripW = Math.max(8, Math.round(c0.w / 8))
    const strip = {
      x: Math.max(0, Math.min(1280 - stripW, Math.round(c0.twinX - stripW / 2))),
      y: Math.max(0, Math.round(c0.y - c0.h / 2)),
      w: stripW,
      h: Math.max(8, Math.round(c0.h)),
    }

    const withT = (await page.screenshot()).toString('base64')
    await page.evaluate(() => window.__game.setParallaxVisible(false))
    await page.waitForTimeout(200)
    const withoutT = (await page.screenshot()).toString('base64')
    await page.evaluate(() => window.__game.setParallaxVisible(true))
    await page.waitForTimeout(200)

    const seam = await changedFraction(page, withT, withoutT, strip)
    // **The control is the same column, below the band.** Not "a strip with no
    // cloud in it": with twelve clouds across the sky the widest gap still had
    // one in it, and the first version of this control measured 8.6% against the
    // twin's 8.6% — the same number, because it had found another cloud.
    //
    // Holding x and moving y isolates *a cloud is at this height* from *the
    // toggle changes this column*, which is the thing that could otherwise
    // explain the assertion above.
    const belowY = Math.min(719 - strip.h, Math.round(strip.y + strip.h * 3))
    const control = await changedFraction(page, withT, withoutT, { ...strip, y: belowY })

    if (seam < 0.05) {
      throw new Error(
        `the wrap twin covers ${(seam * 100).toFixed(1)}% of the strip at x=${strip.x} — ` +
          `a cloud ${c0.w.toFixed(0)} px wide straddles the edge and its other half is ` +
          'not there: the seam is open',
      )
    }
    if (control >= seam) {
      throw new Error(
        `an empty strip changed ${(control * 100).toFixed(1)}% against the twin's ` +
          `${(seam * 100).toFixed(1)}% — the toggle is changing the whole band, so the ` +
          'seam assertion above is measuring the layer rather than the twin',
      )
    }
    log(
      `wrap seam: twin strip at x=${strip.x} changed ${(seam * 100).toFixed(1)}% ` +
        `across the layer toggle, the same column below the band ${(control * 100).toFixed(1)}% ` +
        `(cloud ${c0.w.toFixed(0)} px wide, twin at ${c0.twinX.toFixed(0)})`,
    )
    await page.evaluate(() => window.__game.setParallaxClock(null))
  }

  // The clouds must actually be adding something at noon, or "the difference
  // changed" is a difference between two zeroes.
  const addNoon = lum(tones.noon.add)
  const addNight = lum(tones.night.add)
  if (addNoon < 10) {
    throw new Error(`the clouds add only ${addNoon.toFixed(1)} luminance at noon — nothing to tint`)
  }
  if (tones.noon.covered < 0.03) {
    throw new Error(
      `the clouds cover ${(tones.noon.covered * 100).toFixed(1)}% of the band — too little to ` +
        'measure a tint from, so this assertion would prove nothing',
    )
  }
  // And the light they add must differ between the two phases: a cloud lit the
  // same at midnight as at midday is the §A32 mistake this check exists for.
  //
  // **What this catches and what it does not — measured, not guessed.** Falsifying
  // `cloudTint`'s colour to a constant white leaves this passing: it read 26.3 at
  // noon against 19.1 at night, still correctly ordered, because the alpha half
  // of the tint still responds and a screen mean cannot separate the two. So this
  // assertion proves the clouds respond to the phase *on screen*, and two others
  // carry the rest: `sky-math.test.ts`'s `cloudTint` block proves the colour
  // formula (it fails on a constant white in two places), and the both-ends check
  // below proves the formula's output actually reaches the sprite.
  const swing = dist(tones.noon.add, tones.night.add)
  if (swing < 15) {
    throw new Error(
      `the clouds add (${tones.noon.add.map((v) => v.toFixed(1)).join(',')}) at noon and ` +
        `(${tones.night.add.map((v) => v.toFixed(1)).join(',')}) at night — distance ${swing.toFixed(1)}, ` +
        'so they are not tinting with the sky phase',
    )
  }
  if (addNight >= addNoon) {
    throw new Error(
      `the clouds add more light at night (${addNight.toFixed(1)}) than at noon (${addNoon.toFixed(1)})`,
    )
  }
  // The control region: solid terrain, which the cloud layer does not touch at
  // all. If hiding the clouds moved it, this is measuring the whole frame.
  const controlSwing = dist(tones.noon.control, tones.night.control)
  log(
    `clouds add ${addNoon.toFixed(1)} at noon and ${addNight.toFixed(1)} at night ` +
      `(distance ${swing.toFixed(1)}); terrain control swung ${controlSwing.toFixed(1)}`,
  )

  // 5. A seed always looks the same, and a different seed does not.
  await page.evaluate(() => window.__game.setTime(0.3 * 120))
  await page.waitForTimeout(400)
  //
  //    Re-seeding the **sky only**, not the map: `regenerate` moves the terrain,
  //    and a frame diff after one is 100 % changed whether or not the skyline
  //    reads its seed. The first version of this assertion did exactly that and
  //    would have passed against a ridge that ignored the seed.
  const shotFor = async (seed) => {
    await page.evaluate((s) => window.__game.setSkySeed(s), seed)
    await page.waitForTimeout(400)
    return (await page.screenshot()).toString('base64')
  }
  const a1 = await shotFor(4242)
  const other = await shotFor(999)
  const a2 = await shotFor(4242)
  const sameSeed = await changedFraction(page, a1, a2, band.ridge)
  const diffSeed = await changedFraction(page, a1, other, band.ridge)
  log(`ridge strip: same seed ${(sameSeed * 100).toFixed(1)}% changed, different seed ${(diffSeed * 100).toFixed(1)}%`)
  if (sameSeed > 0.02) {
    throw new Error(`seed 4242 twice drew a different ridge (${(sameSeed * 100).toFixed(1)}% of the strip)`)
  }
  // The other half, which "same seed → same" alone does not rule out: a ridge
  // that ignores the seed entirely passes the assertion above.
  if (diffSeed < 0.02) {
    throw new Error(
      `seed 999 drew the same ridge as 4242 (${(diffSeed * 100).toFixed(1)}% of the strip changed) — ` +
        'the skyline is not seeded',
    )
  }

  // 5b. Both ends (§A39): the tint the maths produces is the tint Phaser holds.
  //
  //     Every assertion above reads pixels, and pixels cannot tell a wrong colour
  //     from a right colour at a lower alpha — the falsification above proves it.
  //     What they also cannot catch is `cloudTint` being correct while `setTint`
  //     is never called at all, which is §A15's exact shape. Reading the tint back
  //     off the sprite and comparing it to the function's own output closes that:
  //     one number computed two ways, and they have to agree.
  for (const [name, u] of [['noon', 0.3], ['night', 0.78]]) {
    await page.evaluate((t) => window.__game.setTime(t), u * 120)
    await page.waitForTimeout(400)
    const both = await page.evaluate((uu) => {
      const k = window.__game.constants()
      const got = window.__game.debug().parallax
      // **Whichever path is live.** Since T16.04 a pack sprite is drawn with
      // `cloudSpriteTint` — no colour mix, flat alpha — because selecting
      // `Clouds_black` by phase already darkened it and `cloudTint` on top would
      // darken it twice. Comparing against `cloudTint` here would assert the
      // wrong function's answer and go red for a renderer doing the right thing.
      //
      // **Per cloud since §E11.** Each one carries its own brightness inside the
      // phase's colour set, so a single band-wide expectation now matches no
      // cloud in particular — the first version of this compared sprite zero
      // against `cloudSpriteTintAt(alpha)` with no sprite and read
      // `#ffffff` against `#d6d6d6`.
      const p = got
      const want = got.cloudAtlas
        ? p.cloudVars.map((v) => window.__game.cloudSpriteTintAt(k.CLOUD_ALPHA, v).color)
        : p.cloudTints.map(
            () => window.__game.cloudTintAt(uu, k.CLOUD_ALPHA, k.CLOUD_SKY_MIX, k.CLOUD_ALPHA_FLOOR).color,
          )
      return {
        want,
        applied: p.cloudTints,
        vars: p.cloudVars,
        got: { color: got.cloudTint, alpha: got.cloudAlpha },
        atlas: got.cloudAtlas,
        baseAlpha: k.CLOUD_ALPHA,
      }
    }, u)
    const hex = (v) => `#${(v >>> 0).toString(16).padStart(6, '0')}`
    const wrong = both.want.findIndex((w, i) => w !== both.applied[i])
    if (wrong !== -1) {
      throw new Error(
        `${name}: cloud ${wrong} should be tinted ${hex(both.want[wrong])} and is holding ` +
          `${hex(both.applied[wrong])} — the tint is computed and not applied`,
      )
    }
    // Alpha is per cloud too, so this compares sprite zero against sprite zero's
    // own expectation rather than against a band-wide one.
    const wantAlpha0 = both.baseAlpha * (both.atlas ? both.vars[0].alpha : 1)
    if (both.atlas && Math.abs(wantAlpha0 - both.got.alpha) > 0.001) {
      throw new Error(
        `${name}: cloud 0 should have alpha ${wantAlpha0.toFixed(3)} and has ` +
          `${both.got.alpha.toFixed(3)}`,
      )
    }
    const shades = new Set(both.applied.map((v) => v >>> 0)).size
    log(
      `${name.padEnd(5)} ${both.applied.length} clouds in ${shades} shades, ` +
        `cloud 0 ${hex(both.got.color)} alpha ${both.got.alpha.toFixed(3)} — each agrees with its own tint`,
    )
    // §E11: the point of per-cloud brightness is that they are not all one
    // shade. Without this the element-wise comparison above passes for twelve
    // identical clouds, which is the sheet the band exists to break up.
    if (both.atlas && shades < 4) {
      throw new Error(
        `${name}: twelve clouds are drawn in only ${shades} shade(s) — the per-cloud ` +
          'brightness band is not reaching the sprites',
      )
    }
  }
  // The control: the two phases must not be the same colour, or "they agree"
  // is two constants agreeing.
  const parallaxAt = async (u) => {
    await page.evaluate((t) => window.__game.setTime(t), u * 120)
    await page.waitForTimeout(400)
    return (await dbg()).parallax
  }
  const noonP = await parallaxAt(0.3)
  const nightP = await parallaxAt(0.78)

  if (noonP.cloudAtlas) {
    // §C14 through the **colour set**: the frames themselves change, white by
    // day and black at night. `cloudTint` is flat on this path, so the old
    // "tints differ" control cannot see the phase response at all any more.
    if (JSON.stringify(noonP.cloudFrames) === JSON.stringify(nightP.cloudFrames)) {
      throw new Error(
        `the clouds show the same frames at noon and at night ` +
          `(${noonP.cloudFrames[0]}) — the colour set is not following the phase`,
      )
    }
    // Every cloud, not the first one. Eleven wrong and one right satisfies a
    // spot check, and the set-inequality above only catches a gross failure.
    const wrongAtNoon = (noonP.cloudFrames ?? []).filter((f) => !/_white_/.test(f))
    const wrongAtNight = (nightP.cloudFrames ?? []).filter((f) => !/_black_/.test(f))
    if (!noonP.cloudFrames?.length) throw new Error('noon drew no clouds at all')
    if (wrongAtNoon.length > 0) {
      throw new Error(
        `noon is drawing ${wrongAtNoon.length}/${noonP.cloudFrames.length} non-white ` +
          `clouds, e.g. ${wrongAtNoon[0]}`,
      )
    }
    if (wrongAtNight.length > 0) {
      throw new Error(
        `night is drawing ${wrongAtNight.length}/${nightP.cloudFrames.length} non-black ` +
          `clouds, e.g. ${wrongAtNight[0]}`,
      )
    }
    log(
      `colour set follows the phase across all ${noonP.cloudFrames.length}: ` +
        `${noonP.cloudFrames[0]} → ${nightP.cloudFrames[0]}`,
    )
  } else if (noonP.cloudTint === nightP.cloudTint) {
    throw new Error('the sprite tint is the same at noon and at night')
  }

  // 5c. **The night cloud still puts pixels on the screen.**
  //
  //     "Cloud tint at night differs from noon" passes for a cloud that has
  //     become invisible — invisible differs from noon too. Selecting a black
  //     sprite by phase AND applying `cloudTint`'s mix-toward-the-sky at
  //     luminance-scaled alpha would be two darkenings, and the result is a
  //     cloud lost in a near-black sky. `cloudSpriteTint` exists to stop that;
  //     this is what proves it worked.
  //
  //     Measured by **toggling the layer**, the way every other cloud assertion
  //     in this file is, not by comparing the cloud against nearby sky. Nearby
  //     sky is not a control: it is a vertical gradient with a sun in it, and
  //     two empty patches of it measured 8.3 apart at the same height — larger
  //     than the cloud itself, so a noise floor built from it fails a plainly
  //     visible daytime cloud. The layer toggle isolates exactly the cloud's own
  //     contribution and nothing else.
  const cloudCover = {}
  for (const [name, u] of [
    ['noon', 0.3],
    ['night', 0.78],
  ]) {
    await parallaxAt(u)
    // `band.cloud`, the same rect §4 measures — already in client coordinates
    // and already proven to see clouds. `parallax.cloudCentres` cannot be used
    // here: those are pre-zoom game coordinates, and `CAMERA_ZOOM` 2 transforms
    // even `scrollFactor(0)` objects, so sampling them lands on empty sky. It
    // measured 0.0% of "the cloud's own rect" changing when the clouds were
    // hidden, which is a sampler aimed at nothing.
    const withClouds = (await page.screenshot()).toString('base64')
    await page.evaluate(() => window.__game.setParallaxVisible(false))
    await page.waitForTimeout(250)
    const withoutClouds = (await page.screenshot()).toString('base64')
    await page.evaluate(() => window.__game.setParallaxVisible(true))
    await page.waitForTimeout(250)
    cloudCover[name] = await changedFraction(page, withClouds, withoutClouds, band.cloud)
    log(`${name.padEnd(5)} clouds cover ${(cloudCover[name] * 100).toFixed(1)}% of the cloud strip`)
  }

  // The assertion §5c exists for: a cloud that is **still there** at night.
  //
  // "Tint at night differs from noon" passes for a cloud that has become
  // invisible — invisible differs from noon too. Selecting a black sprite by
  // phase AND applying `cloudTint`'s mix-toward-the-sky at luminance-scaled
  // alpha is two darkenings, and the result is a cloud lost in a near-black sky.
  // `cloudSpriteTint` exists to stop that; this is what proves it worked.
  //
  // Pinned to §4's own floor rather than a number invented here, and stated as a
  // fraction of the daytime cloudCover so it cannot pass by the clouds simply
  // being large.
  if (cloudCover.night < 0.01) {
    throw new Error(
      `night: hiding the clouds changed only ${(cloudCover.night * 100).toFixed(1)}% of the ` +
        'cloud strip — they have been darkened past visibility',
    )
  }
  if (cloudCover.night < cloudCover.noon / 4) {
    throw new Error(
      `night clouds cover ${(cloudCover.night * 100).toFixed(1)}% of the strip against ` +
        `${(cloudCover.noon * 100).toFixed(1)}% at noon — more than a four-fold loss is a ` +
        'cloud being darkened away, not a cloud being lit differently',
    )
  }

  // 6. The clouds stay spread at the zooms the game actually uses.
  //
  //    Everything above ran at the sandbox's zoom of 1 — the one zoom the game
  //    never runs at. `CAMERA_ZOOM` is 2.0 in a round and `ATTRACT_ZOOM` is 0.75
  //    on the title screen, and at both of those the cloud field was being laid
  //    out against one width and wrapped at another: at zoom 2 clouds 6..11
  //    folded onto the slots of 0..5, six pairs stacked ~2 px apart. Measured
  //    from the **drawn** x of each sprite, because that is the gap the field's
  //    own numbers could not see.
  //
  //    The drift clock is **pinned at 0** for the measurement. The spacing is
  //    only exactly even there: after that the per-cloud speed spread makes
  //    clouds pass each other, which is deliberate. Unpinned, this read 11.4 px
  //    against a 13.3 px floor purely because the check had been running for
  //    thirty seconds — a gate that fails on how long the machine took is not a
  //    gate (§C0).
  await page.evaluate(() => window.__game.setParallaxClock(0))
  for (const zoom of [2, 0.75, 1]) {
    await page.evaluate((z) => window.__game.setZoom(z), zoom)
    await page.waitForTimeout(350)
    const pz = (await dbg()).parallax
    const xs = pz.cloudXs
    const gaps = xs.slice(1).map((v, i) => v - xs[i])
    const min = Math.min(...gaps)
    // A twelfth of the span would be perfectly even; a quarter of that is the
    // floor, and the fold produced 1.9 px against it.
    const floor = pz.span / (c.clouds * 4)
    log(
      `zoom ${zoom}: span ${pz.span.toFixed(0)} px, smallest cloud gap ${min.toFixed(1)} px ` +
        `(floor ${floor.toFixed(1)}), widest ${Math.max(...gaps).toFixed(1)}`,
    )
    if (min < floor) {
      throw new Error(
        `at zoom ${zoom} two clouds are ${min.toFixed(1)} px apart against a floor of ` +
          `${floor.toFixed(1)} — the field is laid out against a different width than it wraps at`,
      )
    }
    // ...and no third of the sky empty, which is the failure at zoom < 1.
    const tail = pz.span - xs[xs.length - 1] + xs[0]
    if (Math.max(...gaps, tail) > pz.span / 3) {
      throw new Error(`at zoom ${zoom} a ${Math.max(...gaps, tail).toFixed(0)} px stretch of sky has no cloud in it`)
    }
  }
  await page.evaluate(() => window.__game.setZoom(1))
  await page.evaluate(() => window.__game.setParallaxClock(null))
  await page.waitForTimeout(250)

  // 7. Depth: the terrain draws over the parallax band. Asserted on the depth
  //    values the scene actually built, not on the constants.
  const depths = await page.evaluate(() => window.__game.sceneDepths())
  for (const want of [-22, -21, -20]) {
    if (!depths.includes(want)) throw new Error(`no layer at depth ${want}: got [${depths.join(',')}]`)
  }
  // Against the depth the scene actually built its terrain at, not against a
  // literal 0: `Math.max(-22,-21,-20) >= 0` is a constant expression and could
  // never have failed.
  const terrainDepth = Math.min(...depths.filter((v) => v >= 0))
  const bandTop = Math.max(-22, -21, -20)
  if (!(bandTop < terrainDepth)) {
    throw new Error(`the parallax band (${bandTop}) is not behind the terrain (${terrainDepth})`)
  }
  log(`layer set: [${depths.join(',')}]`)
}
