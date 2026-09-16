/**
 * T21.17 — heavy fog, painted by a shader under High Quality.
 *
 * Fog was **one flat grey rectangle at 80 % opacity over the whole screen**: it
 * did not move, had no depth, and looked identical everywhere. This asserts the
 * replacement, and — just as importantly — that the old one still works when the
 * toggle is off, because a shader path that quietly becomes the only path is a
 * regression for every machine that cannot run it.
 *
 * ## Measuring concealment when the fog has more than one colour
 *
 * Heavy fog is what stops a player being seen (§F9). So the one thing High
 * Quality may not do is let you see further — a graphics setting that also wins
 * fights is not a preference. That makes "does it conceal the same amount" the
 * load-bearing claim here, and it is the hard one to measure. Four attempts:
 *
 * - **Mean brightness** moves when the fog's *colour* changes, not only when its
 *   opacity does. The fog now has pale banks and dark ones, so this reads a
 *   change that conceals nothing.
 * - **Subtracting the un-fogged frame** does not cancel the ground: a veil
 *   composites as `a·fog + (1-a)·ground`, so even at constant `a` the shift is
 *   `a·(fog − ground)` and still varies wherever the ground does.
 * - **Inverting for `a` per spot** worked while the fog was one colour, and
 *   broke the moment it was not — it returned "thicknesses" of 1.43, which no
 *   alpha can be. It was reading pale as thick.
 * - **Regressing across the spots** gets the idea right and the statistics
 *   wrong. `P = (1-a)·T + a·F`, so a line fitted through fogged against un-fogged
 *   brightness has slope `1-a` — the fraction of ground contrast surviving,
 *   which *is* concealment. But once the fog has real structure, `F` varies from
 *   spot to spot far more than the ground does, and eight points cannot separate
 *   them: it returned a slope of **−0.023**, which no fog can have.
 * - **Regressing *inside* each patch** is the one that holds. Across 24 px the
 *   fog is essentially one colour and one thickness, so `F` is constant and the
 *   only thing varying is the ground. The fit is over ~576 pixels instead of 8
 *   points, and the fog's between-place variation — the thing that broke the
 *   previous attempt — cancels completely. Averaging the per-patch slopes gives
 *   mean concealment.
 *
 * It self-validates: the flat veil's alpha is known, so the slope must come back
 * as `1 − fogVeilAlpha`. If it does not, the instrument is broken and nothing it
 * says about the shader can be believed.
 *
 * ## The other instruments
 *
 * - **Motion needs small patches.** A drifting noise field has a nearly constant
 *   mean over a wide one, because what leaves one side arrives at the other. An
 *   early version reported a working shader drifting by 0.5 — the same as a
 *   static rectangle.
 * - **"Varied" comes out of the same per-patch fit, as its intercept.** The
 *   obvious version — how much the painted result differs from place to place —
 *   reports **87.9 for the flat veil**, because it is reading the ground rather
 *   than the fog. But `P = (1-a)·T + a·F` means the intercept is `a·F`: the fog's
 *   own contribution at that patch, ground removed. One fillRect has the same
 *   `a` and the same `F` everywhere, so its intercepts barely move; thickness
 *   and shade both land here, which is right, because a player sees both.
 */
import { samplePatch, patchLuminance, colourDelta } from './pixels.mjs'

/**
 * How far the recovered slope may sit from `1 − fogVeilAlpha`.
 *
 * This is the instrument's own accuracy, measured against a veil whose alpha is
 * known. If a change here needs this widened, the measurement got worse.
 */
const SLOPE_ACCURACY = 0.06

/** How far the shader's concealment may sit from the flat veil's. */
const CONCEALMENT_TOLERANCE = 0.1

/**
 * How much more structure the shader must have than the flat veil.
 *
 * **The flat veil's number is the instrument's noise floor, not a rival.** One
 * `fillRect` has exactly one alpha and one colour, so its true structure is
 * zero; whatever this measures for it — around 9 — is the per-patch fit's own
 * error. So this is a signal-to-noise bar rather than a comparison, and 4x noise
 * is a conventional place to put one.
 */
const VARIETY_RATIO = 4

/*
 * There was an `FPS_FLOOR = 15` here and the shader was failed against it.
 * **Removed in T21.24, and nothing may fail on a frame rate in this file again.**
 *
 * Not because the number stopped mattering, but because it is not measurable
 * where it is taken: headless Chrome on swiftshader, under WSL, on a box that
 * may be running the gate at the same time. A gate that fails on a coin flip
 * gates nothing — and this one was worse than a coin flip, because the figure
 * had already been checked against a real browser and found wrong. The
 * coordinator opened a real Chrome on the High Quality fog and the frame rate
 * did not drop the way this check claimed it did.
 *
 * The readings are still logged below, because seeing them is useful. Deciding
 * on them is what is forbidden. What replaces the assertion is T21.24's optional
 * FPS counter: the person on the machine that matters reads it themselves.
 */

/**
 * A patch whose un-fogged pixels vary less than this is skipped.
 *
 * Concealment is measured as how much ground contrast the fog destroys, so a
 * patch of open sky — which has no contrast to destroy — cannot answer the
 * question, and dividing by its variance would return noise.
 */
const GROUND_CONTRAST_FLOOR = 4

export default async function ({ page, shot, log }) {
  await page.evaluate(() => window.__game.regenerate('4242', 'medium'))
  await page.waitForTimeout(900)
  // Freeze the cycle so the sky cannot move between two samples and be mistaken
  // for fog moving.
  await page.evaluate(() => {
    window.__game.setTime(0)
    window.__game.setParallaxClock(0)
  })
  await page.waitForTimeout(250)

  const frame = await page.evaluate(() => {
    const r = document.querySelector('canvas').getBoundingClientRect()
    return { x: r.left, y: r.top, w: r.width, h: r.height }
  })
  const field = {
    x: Math.round(frame.x + frame.w * 0.42),
    y: Math.round(frame.y + frame.h * 0.3),
    w: 220,
    h: 150,
  }
  // Eight, because the concealment claim is a line fitted through them and five
  // points make a noisy fit. Small, because a wide patch averages the fog flat.
  const spots = [
    [0.08, 0.12],
    [0.55, 0.18],
    [0.82, 0.32],
    [0.2, 0.45],
    [0.65, 0.52],
    [0.35, 0.68],
    [0.88, 0.75],
    [0.12, 0.88],
  ].map(([fx, fy]) => ({
    x: Math.round(field.x + field.w * fx),
    y: Math.round(field.y + field.h * fy),
    w: 24,
    h: 24,
  }))
  const sampleSpots = async () => Promise.all(spots.map((s) => samplePatch(page, s)))
  const spread = (xs) => Math.max(...xs) - Math.min(...xs)
  const fps = () => page.evaluate(() => window.__game.debug().fps ?? 0)

  /**
   * The fraction of ground contrast surviving the fog, fitted **within** one
   * patch — see the header for why not across them.
   *
   * Returns null where the ground inside the patch is too flat to fit a line
   * through: open sky has no contrast to attenuate, so it can say nothing about
   * concealment, and a slope divided out of near-zero variance is noise.
   */
  const patchSlope = (fogPix, groundPix) => {
    const n = groundPix.length
    let mt = 0
    let mp = 0
    for (let i = 0; i < n; i++) {
      mt += groundPix[i]
      mp += fogPix[i]
    }
    mt /= n
    mp /= n
    let cov = 0
    let varT = 0
    for (let i = 0; i < n; i++) {
      const dt = groundPix[i] - mt
      cov += dt * (fogPix[i] - mp)
      varT += dt * dt
    }
    return varT / n < GROUND_CONTRAST_FLOOR ? null : cov / varT
  }

  /**
   * Fit every patch and report both things the fit knows.
   *
   * `surviving` is the mean slope: how much ground contrast lives through the
   * fog, which is concealment. `structure` is the spread of the intercepts —
   * each one the fog's own contribution at that patch with the ground taken
   * out, so it moves when the fog is thicker *or* paler in one place than
   * another, and barely moves for a single flat rectangle.
   */
  const fitPatches = async (label) => {
    const slopes = []
    const intercepts = []
    for (let i = 0; i < spots.length; i++) {
      const fogPix = await patchLuminance(page, spots[i])
      const sl = patchSlope(fogPix, clearPixels[i])
      if (sl === null) continue
      const n = fogPix.length
      const mt = clearPixels[i].reduce((a, v) => a + v, 0) / n
      const mp = fogPix.reduce((a, v) => a + v, 0) / n
      slopes.push(sl)
      intercepts.push(mp - sl * mt)
    }
    if (slopes.length < 3) {
      throw new Error(
        `only ${slopes.length} of ${spots.length} patches had enough ground contrast to measure ` +
          `${label} — too few to claim anything about concealment`,
      )
    }
    return {
      surviving: slopes.reduce((a, b) => a + b, 0) / slopes.length,
      structure: spread(intercepts),
    }
  }

  const start = await page.evaluate(() => window.__game.setHighQuality(false))
  log(`starting with High Quality ${start.setting ? 'on' : 'off'}`)

  const clear = await samplePatch(page, field)
  const clearSpots = await sampleSpots()
  const clearPixels = []
  for (const sp of spots) clearPixels.push(await patchLuminance(page, sp))

  // --- 1. the flat veil, which the toggle-off path must keep ---------------
  await page.evaluate(() => window.__game.setFog(true))
  await page.waitForTimeout(700)
  const flat = await samplePatch(page, field)
  const flatSpots = await sampleSpots()
  await page.waitForTimeout(600)
  const flatSpotsLater = await sampleSpots()
  const flatAlpha = await page.evaluate(() => window.__game.debug().fogAlpha ?? 0)
  const flatFps = await fps()
  await shot('fog-flat')

  if (colourDelta(clear, flat) < 8) {
    throw new Error('the flat veil did not darken the field, so nothing here is measuring fog')
  }

  // **The instrument validates itself here.** The flat veil's alpha is known, so
  // the slope must come back as 1 - it. Everything below rests on this line.
  const flatFit = await fitPatches('the flat veil')
  const flatSurviving = flatFit.surviving
  const expected = 1 - flatAlpha
  log(
    `flat veil: alpha ${flatAlpha.toFixed(3)}, ground contrast surviving ` +
      `${flatSurviving.toFixed(3)} (expected ${expected.toFixed(3)}), ${flatFps.toFixed(0)} fps`,
  )
  if (Math.abs(flatSurviving - expected) > SLOPE_ACCURACY) {
    throw new Error(
      `measured ${flatSurviving.toFixed(3)} of the ground's contrast surviving a veil whose ` +
        `alpha is ${flatAlpha.toFixed(3)}, so it should be ${expected.toFixed(3)}. The ` +
        `instrument is wrong, and nothing it says about the shader can be believed`,
    )
  }

  // The control the shader's structure is read against: one alpha and one colour
  // everywhere means the intercepts barely move.
  const flatVariety = flatFit.structure
  const flatDrift = spread(flatSpots.map((s, i) => s.lum - flatSpotsLater[i].lum))
  if (flatDrift > 2) {
    throw new Error(
      `the flat veil moved by ${flatDrift.toFixed(2)} between frames — it is a static fillRect, ` +
        `so something else in the sampled spots is animating and the drift claim would measure ` +
        `that instead`,
    )
  }

  // --- now with High Quality on --------------------------------------------
  const on = await page.evaluate(() => window.__game.setHighQuality(true))
  if (!on.setting) throw new Error('the setting would not turn on')
  if (!on.shaderFog) {
    throw new Error(
      'High Quality is on but the fog is still the flat veil — either this machine has no ' +
        'WebGL, or the shader is not wired',
    )
  }
  await page.waitForTimeout(500)
  const shaded = await samplePatch(page, field)
  const shadedSpots = await sampleSpots()
  await page.waitForTimeout(600)
  const shadedSpotsLater = await sampleSpots()
  const shaderAlpha = await page.evaluate(() => window.__game.debug().fogAlpha ?? 0)
  const shaderFps = await fps()
  await shot('fog-shader')

  // 2. it is varied: structure the ground does not account for.
  const shaderFit = await fitPatches('the shader')
  const shaderVariety = shaderFit.structure
  log(
    `shader fog: structure of its own ${shaderVariety.toFixed(1)} ` +
      `(flat veil ${flatVariety.toFixed(1)}), ${shaderFps.toFixed(0)} fps`,
  )
  if (shaderVariety < flatVariety * VARIETY_RATIO) {
    throw new Error(
      `the shader fog has ${shaderVariety.toFixed(1)} of structure the ground does not explain, ` +
        `where the flat veil has ${flatVariety.toFixed(1)} — under ${VARIETY_RATIO}x, so it is ` +
        `not visibly more interesting than the rectangle it replaces`,
    )
  }

  // 3. and it moves, where the flat one did not.
  const drift = spread(shadedSpots.map((s, i) => s.lum - shadedSpotsLater[i].lum))
  log(`shader drift between two frames ${drift.toFixed(2)} (flat was ${flatDrift.toFixed(2)})`)
  if (drift < 3) {
    throw new Error(
      `the shader fog moved only ${drift.toFixed(2)} between frames — a still shader is a ` +
        `wasted one, and this is the whole difference from the rectangle it replaces`,
    )
  }

  // 4. it conceals the same amount — the claim that keeps this fair.
  if (Math.abs(shaderAlpha - flatAlpha) > 0.001) {
    throw new Error(
      `fog strength changed with the toggle: ${flatAlpha} flat vs ${shaderAlpha} shader. ` +
        `Only the painting may differ — this number feeds how far a player can see`,
    )
  }
  const shaderSurviving = shaderFit.surviving
  const gap = Math.abs(shaderSurviving - flatSurviving)
  log(
    `conceals the same: ${shaderSurviving.toFixed(3)} of the ground's contrast survives the ` +
      `shader against ${flatSurviving.toFixed(3)} for the veil`,
  )
  if (gap > CONCEALMENT_TOLERANCE) {
    throw new Error(
      `the shader lets ${shaderSurviving.toFixed(3)} of the ground's contrast through where the ` +
        `flat veil lets ${flatSurviving.toFixed(3)} — a gap of ${gap.toFixed(3)}. Heavy fog is ` +
        `what stops a player being seen, so this would make High Quality a competitive ` +
        `advantage rather than a visual preference`,
    )
  }

  // 5. what it costs — **logged, never asserted on** (T21.24, see the note where
  //    `FPS_FLOOR` used to be).
  log(
    `cost, for reading and not for failing: ${shaderFps.toFixed(0)} fps with the shader against ` +
      `${flatFps.toFixed(0)} for the flat veil. This is headless swiftshader under WSL and the ` +
      `figure has already been contradicted by a real browser — turn the FPS counter on in ` +
      `Options (T21.24) and read it on the machine you care about`,
  )

  // --- 6. and back off, which must restore the old picture -------------------
  const off = await page.evaluate(() => window.__game.setHighQuality(false))
  if (off.shaderFog) throw new Error('the shader fog is still drawing with the toggle off')
  await page.waitForTimeout(500)
  const backToFlat = await samplePatch(page, field)
  const returned = colourDelta(flat, backToFlat)
  if (returned > 8) {
    throw new Error(
      `turning High Quality off did not restore the flat veil (moved ${returned.toFixed(1)})`,
    )
  }
  log(`turning it off restores the original veil (${returned.toFixed(1)})`)

  await page.evaluate(() => window.__game.setFog(false))
}
