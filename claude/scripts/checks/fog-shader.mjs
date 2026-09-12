/**
 * T21.17 — heavy fog, painted by a shader under High Quality.
 *
 * Fog was **one flat grey rectangle at 80 % opacity over the whole screen**: it
 * did not move, had no depth, and looked identical everywhere. This asserts the
 * replacement, and — just as importantly — that the old one still works when the
 * toggle is off, because a shader path that quietly becomes the only path is a
 * regression for every machine that cannot run it.
 *
 * ## The instruments, which took four attempts to get right
 *
 * Each of these was a wrong answer this check actually gave:
 *
 * - **Averaging a wide patch cannot see motion.** A drifting noise field has a
 *   nearly constant mean over 220×150, because what leaves one side arrives at
 *   the other. The first version reported the shader drifting by 0.5 — the same
 *   as a static rectangle. Motion needs a *small* patch, where a local value
 *   swings. Hence `spot`.
 * - **"The mean changed" contradicts claim 4.** Depth cannot be a shift in mean
 *   brightness, because the whole point of claim 4 is that the mean must *not*
 *   move. Depth is structure, not brightness.
 * - **Variation within one frame is mostly the terrain, not the fog.** The flat
 *   veil already varies by ~9 across the field, because it is 80 % opaque and
 *   the ground shows through. Comparing that number to the shader's own is
 *   comparing two mixtures.
 *
 * - **Subtracting the un-fogged frame does not cancel the terrain either.** A
 *   veil composites as `a·fog + (1-a)·ground`, so even at a *constant* `a` the
 *   shift is `a·(fog − ground)` and still varies wherever the ground does. The
 *   flat veil's spots spread by 14 that way, and its alpha is one number.
 *
 * So depth is measured by **solving for the thickness at each spot**. With the
 * fogged and un-fogged brightness of the same pixels, and the fog's own colour
 * from `constants()`, `a = (fogged − ground) / (fog − ground)` inverts the
 * compositing exactly. Terrain cancels because it appears on both sides of the
 * division. What comes out is the alpha the shader actually painted there — so
 * the flat veil answers one number everywhere, and a cloudy fog does not.
 *
 * ## The claims
 *
 *  1. with High Quality **off**, the fog is the flat veil it always was;
 *  2. with it **on**, the fog is *cloudy* — its thickness varies from place to
 *     place, where the flat veil's does not (that is the control);
 *  3. it **moves**, where the flat veil does not;
 *  4. it conceals **the same amount**. Heavy fog is what stops a player being
 *     seen (§F9), so if the shader averaged out thinner, High Quality would be a
 *     competitive advantage rather than a visual preference. Asserted on
 *     `fogVeilAlpha`, the number the simulation uses, *and* on the mean
 *     brightness of the screen, which is what a player experiences;
 *  5. turning it off restores the original picture.
 */
import { samplePatch, colourDelta } from './pixels.mjs'

/** Mean brightness of the two modes may differ by no more than this (0-255). */
const CONCEALMENT_TOLERANCE = 12

/**
 * Painted thickness must vary by at least this much across the field (alpha).
 *
 * The shader swings density either side of 1.0 by `CONTRAST`, against a base of
 * 0.8 — so a working one paints somewhere near 0.5 in its thin patches and 1.0
 * in its thick ones. A floor of 0.12 is comfortably under that and comfortably
 * over the flat veil, which paints one number everywhere.
 */
const CLOUDINESS = 0.12

/** The flat veil's own spread, which must be ~0 or claim 2 proves nothing. */
const FLAT_SPREAD_CEILING = 0.04

/**
 * A spot whose ground is this close to the fog's own colour is dropped.
 *
 * `a = (fogged − ground) / (fog − ground)` divides by that difference, so where
 * the ground already looks like fog the answer is noise over noise. Better to
 * measure four spots honestly than five with one of them meaningless.
 */
const CONTRAST_FLOOR = 20

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
  // Wide, across the middle of the view: fog is full-screen, so anywhere works,
  // but the middle avoids the panel and the HUD.
  const field = {
    x: Math.round(frame.x + frame.w * 0.42),
    y: Math.round(frame.y + frame.h * 0.3),
    w: 220,
    h: 150,
  }
  // Small, spread across it. Small because a wide patch averages the fog flat
  // again; spread because claim 2 is about how thickness differs *by place*.
  const spots = [
    [0.1, 0.15],
    [0.6, 0.2],
    [0.25, 0.55],
    [0.8, 0.6],
    [0.45, 0.85],
  ].map(([fx, fy]) => ({
    x: Math.round(field.x + field.w * fx),
    y: Math.round(field.y + field.h * fy),
    w: 24,
    h: 24,
  }))
  const sampleSpots = async () => Promise.all(spots.map((s) => samplePatch(page, s)))
  const spread = (xs) => Math.max(...xs) - Math.min(...xs)

  // The fog's own colour, from the constant the renderer paints with — not a
  // literal here, which would pass against a drifted implementation.
  const fogHex = await page.evaluate(() => window.__game.constants().FOG_SCREEN_COLOUR)
  if (typeof fogHex !== 'number') {
    throw new Error(
      `FOG_SCREEN_COLOUR came back as ${fogHex} — an assertion against a constant that is not ` +
        `exposed cannot fail, so this check would be hollow`,
    )
  }
  const fogLum =
    0.2126 * ((fogHex >> 16) & 0xff) + 0.7152 * ((fogHex >> 8) & 0xff) + 0.0722 * (fogHex & 0xff)

  /**
   * Invert the alpha compositing to recover the thickness painted at each spot.
   *
   * `fogged = a·fog + (1-a)·ground`, so `a = (fogged − ground) / (fog − ground)`.
   * The ground cancels, which is the entire reason for doing it this way.
   */
  const paintedAlpha = (fogged, ground) =>
    fogged
      .map((f, i) => ({ denom: fogLum - ground[i].lum, num: f.lum - ground[i].lum }))
      .filter((d) => Math.abs(d.denom) >= CONTRAST_FLOOR)
      .map((d) => d.num / d.denom)

  const start = await page.evaluate(() => window.__game.setHighQuality(false))
  log(`starting with High Quality ${start.setting ? 'on' : 'off'}`)

  const clear = await samplePatch(page, field)
  const clearSpots = await sampleSpots()

  // --- 1. the flat veil, which is what the toggle-off path must keep ---------
  await page.evaluate(() => window.__game.setFog(true))
  await page.waitForTimeout(700)
  const flat = await samplePatch(page, field)
  const flatSpots = await sampleSpots()
  await page.waitForTimeout(600)
  const flatSpotsLater = await sampleSpots()
  const flatAlpha = await page.evaluate(() => window.__game.debug().fogAlpha ?? 0)
  await shot('fog-flat')

  if (colourDelta(clear, flat) < 8) {
    throw new Error('the flat veil did not darken the field, so nothing here is measuring fog')
  }

  // The control for claim 2: the flat veil paints one thickness everywhere,
  // because it is a single fillRect. If this spread is not ~0, the inversion is
  // not cancelling the terrain and claim 2 would be measuring the ground.
  const flatPainted = paintedAlpha(flatSpots, clearSpots)
  if (flatPainted.length < 3) {
    throw new Error(
      `only ${flatPainted.length} of ${spots.length} spots had ground distinguishable from the ` +
        `fog colour — too few to claim anything about how thickness varies`,
    )
  }
  const flatSpread = spread(flatPainted)
  log(
    `flat veil: alpha ${flatAlpha.toFixed(3)}, brightness ${flat.lum.toFixed(1)}, ` +
      `paints ${flatPainted.map((a) => a.toFixed(2)).join('/')} — spread ${flatSpread.toFixed(3)}`,
  )
  if (flatSpread > FLAT_SPREAD_CEILING) {
    throw new Error(
      `the flat veil paints thicknesses spread by ${flatSpread.toFixed(3)} across the field, ` +
        `but it is a single fillRect at one alpha — so the inversion is not cancelling the ` +
        `terrain and claim 2 below would be measuring the ground instead of the fog`,
    )
  }

  // The control for claim 3: the flat veil does not move.
  const flatDrift = spread(flatSpots.map((s, i) => s.lum - flatSpotsLater[i].lum))
  if (flatDrift > 2) {
    throw new Error(
      `the flat veil moved by ${flatDrift.toFixed(2)} between frames — it is a static fillRect, ` +
        `so something else in the sampled spots is animating and claim 3 would measure that`,
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
  await shot('fog-shader')

  // 2. it is cloudy: it paints different thicknesses in different places.
  const shaderPainted = paintedAlpha(shadedSpots, clearSpots)
  const shaderSpread = spread(shaderPainted)
  log(
    `shader fog: brightness ${shaded.lum.toFixed(1)}, paints ` +
      `${shaderPainted.map((a) => a.toFixed(2)).join('/')} — spread ${shaderSpread.toFixed(3)} ` +
      `(flat ${flatSpread.toFixed(3)})`,
  )
  if (shaderSpread < CLOUDINESS) {
    throw new Error(
      `the shader paints the same thickness everywhere — spread ${shaderSpread.toFixed(3)} ` +
        `against a floor of ${CLOUDINESS}. That is a flat wash with extra steps, which is the ` +
        `thing it was built to stop being`,
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

  // 4. it conceals the same amount, in both the number and the picture.
  if (Math.abs(shaderAlpha - flatAlpha) > 0.001) {
    throw new Error(
      `fog strength changed with the toggle: ${flatAlpha} flat vs ${shaderAlpha} shader. ` +
        `Only the painting may differ — this number feeds how far a player can see`,
    )
  }
  const concealment = Math.abs(shaded.lum - flat.lum)
  if (concealment > CONCEALMENT_TOLERANCE) {
    throw new Error(
      `the shader fog conceals a different amount: mean brightness ${shaded.lum.toFixed(1)} ` +
        `versus ${flat.lum.toFixed(1)} flat, a gap of ${concealment.toFixed(1)}. Heavy fog is ` +
        `what stops a player being seen, so a thinner High Quality is a competitive advantage, ` +
        `not a visual preference`,
    )
  }
  log(
    `conceals the same: strength ${shaderAlpha.toFixed(3)} both ways, ` +
      `brightness within ${concealment.toFixed(1)}`,
  )

  // --- 5. and back off, which must restore the old picture -------------------
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
