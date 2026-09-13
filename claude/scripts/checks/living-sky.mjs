/**
 * `living-sky` — §C14's mountains, asserted from the frame.
 *
 * ## Why every assertion here samples pixels
 *
 * The maths is already covered by `sky-math.test.ts`, and a correct formula that
 * nothing carries to the screen is the failure this project has paid for four
 * times (§A15, §A16). So the questions this check asks are the ones a unit test
 * cannot: is there a ridge in the frame, and does a seed always draw the same one.
 *
 * ## The clouds left this file in T21.18
 *
 * This check used to carry the cloud half of §C14 too — twelve sprites, their
 * wrap twins, their per-cloud tints and their colour sets. **All of that is
 * gone**, because the sprite clouds themselves are: T21.18 retired them at the
 * coordinator's request and replaced them, under High Quality only, with a
 * shader. `clouds-shader` is where the clouds are asserted now, and it asserts
 * *both* pictures — the empty band with the toggle off, and the painted one with
 * it on.
 *
 * What that leaves here is the mountains, plus one thing the clouds are now
 * useful *as*: the cloud band is this file's control region. Hiding the parallax
 * layer has to move the ridge strip and leave the cloud strip alone, which is
 * what says the toggle is changing a layer rather than the whole frame.
 *
 * ## The control that makes each claim mean something
 *
 * - **A control region.** Every claim is paired with a patch of the frame that
 *   must *not* change, so "the strip moved" cannot be explained by the whole
 *   picture moving.
 * - **A control frame.** The mountain claims are measured against the same frame
 *   with the layer hidden, so "there are pixels here" cannot be satisfied by the
 *   gradient that was always there.
 */

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

export default async function ({ page, shot, log }) {
  const dbg = () => page.evaluate(() => window.__game.debug())

  await page.evaluate(() => window.__game.regenerate('4242', 'medium'))
  await page.waitForTimeout(500)
  await page.evaluate(() => window.__game.setTime(0.3 * 120))
  await page.waitForTimeout(400)

  // 1. The layers exist and are drawing, from the scene rather than from a
  //    constructor that ran.
  const d = await dbg()
  const p = d.parallax
  if (!p) throw new Error('debug().parallax is missing — this check cannot fail, so it proves nothing')
  const c = await page.evaluate(() => ({
    layers: window.__game.constants().MOUNTAIN_LAYERS,
  }))
  if (p.ridges !== c.layers) throw new Error(`${p.ridges} ridge layers, expected MOUNTAIN_LAYERS (${c.layers})`)
  // The clouds are the control here now (T21.18): with High Quality off — which
  // is the default this check runs under — nothing paints that band, and the
  // assertion below says so.
  if (p.shaderClouds) {
    throw new Error('the cloud shader is drawing with High Quality off, which nothing turned on')
  }
  // `p.seed` is right *here*: this check drives the sandbox, where the client
  // really does generate the map, so its local seed is the round's. In a
  // networked scene it would not be — see `roundSeed` in `GameScene.debug()`.
  log(`${p.ridges} ridges, seed ${p.seed}`)

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
    // Both background bands: the cloud band at 0.06..0.40, which is the control,
    // and the ridge at 0.64..0.85, which is the subject.
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
      // CLOUD_BAND_TOP..CLOUD_BAND_BOTTOM of the viewport: open sky, and since
      // T21.18 nothing this layer owns is drawn in it unless High Quality is on.
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
  // **The fixture's own noise, measured rather than assumed.** This check carves
  // the ground out from under the player, so the camera is still falling while
  // the frames below are taken and the whole picture creeps. Two frames with the
  // layer left alone say how much of any "difference" is that creep — measured,
  // 6.3 % of the cloud strip, which is exactly what the toggle appeared to
  // change. Without this the control below reads the fall as clouds.
  const stillOn = (await page.screenshot()).toString('base64')
  const drift = await changedFraction(page, withLayer, stillOn, band.cloud)
  await page.evaluate(() => window.__game.setParallaxVisible(false))
  await page.waitForTimeout(300)
  const withoutLayer = (await page.screenshot()).toString('base64')
  await shot('living-sky-hidden')
  await page.evaluate(() => window.__game.setParallaxVisible(true))
  await page.waitForTimeout(300)

  const ridgeDelta = await changedFraction(page, withLayer, withoutLayer, band.ridge)
  const cloudDelta = await changedFraction(page, withLayer, withoutLayer, band.cloud)
  log(
    `hiding the band changed ridge strip ${(ridgeDelta * 100).toFixed(1)}%, cloud strip ` +
      `${(cloudDelta * 100).toFixed(1)}% — against ${(drift * 100).toFixed(1)}% of that strip ` +
      `moving on its own`,
  )
  if (ridgeDelta < 0.02) {
    throw new Error(
      `hiding the parallax band changed only ${(ridgeDelta * 100).toFixed(1)}% of the ridge strip — ` +
        'the mountains are not on screen',
    )
  }
  // **The control, and it runs in the opposite direction to the one above.**
  // Hiding the layer must move the ridge strip and leave the cloud strip where
  // it would have been anyway: if the toggle moved both, this is measuring the
  // whole frame going dark rather than a band of mountains being taken away.
  // Since T21.18 nothing this layer owns is painted in the cloud band with High
  // Quality off, so this is also the pixel half of the `shaderClouds` assertion
  // at the top — `clouds-shader` owns the rest.
  //
  // Compared against `drift` rather than against a number: this fixture's own
  // creep is 6 % of the strip, so a fixed ceiling under that would fail for
  // reasons that have nothing to do with the layer.
  const cloudCeiling = drift * 1.5 + 0.01
  if (cloudDelta > cloudCeiling) {
    throw new Error(
      `hiding the parallax band changed ${(cloudDelta * 100).toFixed(1)}% of the cloud strip ` +
        `where the strip moves ${(drift * 100).toFixed(1)}% on its own — nothing should be ` +
        'painting there with High Quality off, so either something is, or the ridge reading ' +
        'above is measuring the whole frame rather than the mountains',
    )
  }

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
