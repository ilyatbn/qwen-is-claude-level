/**
 * `weather-visible` — §C6: the weather must reach the screen.
 *
 * This is §B21's shape a second time. Heavy fog ran correctly for five milestones
 * while `fogMult` was hardcoded to 1: the formula was right, the tests asserted the
 * formula, and nothing asserted that the number reached a pixel. Toxic rain was the
 * same — puddles were drawn as discs and the *rain* never was, so an 8-second
 * downpour looked like a few green circles appearing.
 *
 * The control here is a **frame with the effect off**, which is the honest control
 * for something that covers the whole view: a control *region* cannot work when the
 * subject is a full-screen cast.
 */
import { samplePatch, assertChanged, assertUnchanged } from './pixels.mjs'

export default async function ({ page, shot, log }) {
  await page.evaluate(() => window.__game.regenerate('4242', 'medium'))
  await page.waitForTimeout(600)

  // A patch of sky, where rain is unambiguous: over terrain a green cast competes
  // with the ground colour, and §A15's lesson is to sample where the change is.
  const sky = { x: 900, y: 120, w: 200, h: 140 }

  const dry = await samplePatch(page, sky)
  await shot('weather-dry')

  // Two frames with no weather: the drift between them is the noise floor, and a
  // threshold set without it is a guess. The sky animates (§A4), so it is not zero.
  await page.waitForTimeout(700)
  const dry2 = await samplePatch(page, sky)
  const noise = Math.hypot(dry.r - dry2.r, dry.g - dry2.g, dry.b - dry2.b)
  log(`noise floor with no weather: ${noise.toFixed(1)}`)

  await page.evaluate(() => window.__game.forceWeather(0)) // toxic
  // Telegraph is EFFECT_TELEGRAPH (3 s) before the active phase, and the rain
  // ramps in after that. Waiting less than that photographs a dry sky and blames
  // the renderer.
  await page.waitForTimeout(6500)

  const state = await page.evaluate(() => {
    const g = window.__game
    return { intensity: g.debug().toxicIntensity, drops: g.debug().rainDrops }
  })
  const wet = await samplePatch(page, sky)
  await shot('weather-toxic-rain')

  // Count at both ends before looking at a pixel (§A39): if the layer is drawing
  // nothing, say so plainly rather than reporting a colour delta.
  log(`toxic intensity ${state.intensity.toFixed(2)}, drops drawn ${state.drops}`)
  if (state.drops === 0) {
    throw new Error('the rain layer is drawing no drops — nothing about visibility has been tested')
  }

  const r = assertChanged(dry, wet, {
    label: 'toxic rain over the sky',
    // The control is the dry-to-dry pair: the same view, no weather.
    control: { before: dry, after: dry2 },
    minDelta: Math.max(8, noise * 3),
  })
  log(`rain changed the sky by ${r.delta.toFixed(1)} against a ${noise.toFixed(1)} noise floor`)

  // And it must stop — on its own, because effects end on their own timer and
  // there is no cancel. A layer that never clears looks identical to one that is
  // always on, and "the effect ran" would then pass forever.
  // TOXIC_DURATION is 8 s from the active phase, plus the ramp out.
  await page.waitForTimeout(9000)
  const cleared = await page.evaluate(() => window.__game.debug().toxicIntensity)
  if (cleared > 0.05) throw new Error(`the rain did not stop: intensity still ${cleared}`)
  log('rain cleared after the effect ended')
  await shot('weather-cleared')

  // --- lava: fire spewing UP from the vent (§C6) ---------------------------
  //
  // Asserted on the ember count rather than pixels: a vent may be anywhere on the
  // map, and a screenshot of a vent that is off-camera is not evidence (§A22).
  // The count is the both-ends signal — the sim has jetting vents, the layer has
  // embers — and the pixel half is covered by the rain above.
  await page.evaluate(() => window.__game.forceWeather(2))
  let peak = 0
  let jetting = 0
  for (let i = 0; i < 24; i++) {
    await page.waitForTimeout(500)
    const d = await page.evaluate(() => {
      const g = window.__game
      return { embers: g.debug().embers, vents: (g.debug().vents ?? 0) }
    })
    peak = Math.max(peak, d.embers)
    jetting = Math.max(jetting, d.vents)
  }
  log(`lava: peak ${peak} embers, ${jetting} jetting vents seen`)
  if (jetting === 0) throw new Error('no vent ever jetted — the fixture did not exercise lava')
  if (peak === 0) {
    throw new Error('vents jetted and the layer emitted no embers — the spew is invisible')
  }
  await shot('weather-lava')
}
