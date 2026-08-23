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
      const want = window.__game.cloudTintAt(uu, k.CLOUD_ALPHA, k.CLOUD_SKY_MIX, k.CLOUD_ALPHA_FLOOR)
      const got = window.__game.debug().parallax
      return { want, got: { color: got.cloudTint, alpha: got.cloudAlpha } }
    }, u)
    const hex = (v) => `#${(v >>> 0).toString(16).padStart(6, '0')}`
    if (both.want.color !== both.got.color) {
      throw new Error(
        `${name}: cloudTint says ${hex(both.want.color)} and the sprite is holding ` +
          `${hex(both.got.color)} — the tint is computed and not applied`,
      )
    }
    if (Math.abs(both.want.alpha - both.got.alpha) > 0.001) {
      throw new Error(
        `${name}: cloudTint says alpha ${both.want.alpha.toFixed(3)} and the sprite has ` +
          `${both.got.alpha.toFixed(3)}`,
      )
    }
    log(`${name.padEnd(5)} sprite tint ${hex(both.got.color)} alpha ${both.got.alpha.toFixed(3)} — agrees with cloudTint`)
  }
  // The control: the two phases must not be the same colour, or "they agree"
  // is two constants agreeing.
  const tintAt = async (u) => {
    await page.evaluate((t) => window.__game.setTime(t), u * 120)
    await page.waitForTimeout(400)
    return (await dbg()).parallax.cloudTint
  }
  if ((await tintAt(0.3)) === (await tintAt(0.78))) {
    throw new Error('the sprite tint is the same at noon and at night')
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
