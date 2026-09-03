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
import { samplePatch, assertChanged, assertUnchanged, colourDelta } from './pixels.mjs'

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

  // --- heavy fog: the veil (§F9) --------------------------------------------
  //
  // §B21's shape a *third* time, and this is the one it was named for: fog's
  // `strength()` has been correct since M5, `FOV_FOG_MULT` has shrunk the
  // lightmap radius since M5, and in **daylight** — which is when fog is
  // supposed to matter — the lightmap is skipped entirely, so a heavy fog looked
  // exactly like clear weather. The fix is a screen-space veil, so the acceptance
  // is pixels or it is nothing.
  //
  // This runs **first**, before any other effect is forced, so the control frame
  // really is "before it starts" rather than "between two other effects".
  {
    const k = await page.evaluate(() => window.__game.constants())

    // **Freeze the day/night clock first.** The control frame and the foggy
    // frame are ~10 s apart — a telegraph plus `FOG_RAMP` plus the poll — and
    // §A4's cycle moves the sky and the terrain tint over that gap. The
    // assertion below is an exact alpha composite, so a phase boundary landing
    // in the window would turn a pinned prediction into a coin flip. `setTime`
    // to *the current* time, so the picture does not jump, and it stays frozen
    // for the rest of the check: the toxic and lava sections run off
    // `weatherTime`, which is a separate clock.
    //
    // The noise floor above was measured with the clock **live**, and it is used
    // as the threshold here, which makes the comparison stricter rather than
    // looser: a frozen frame moves less than the number it is judged against.
    await page.evaluate(() => window.__game.setTime(window.__game.debug().roundTime))
    await page.waitForTimeout(200)
    const grey = {
      r: (k.FOG_SCREEN_COLOUR >> 16) & 0xff,
      g: (k.FOG_SCREEN_COLOUR >> 8) & 0xff,
      b: k.FOG_SCREEN_COLOUR & 0xff,
    }

    // A terrain patch as well as a sky one. §F9 says the veil reduces the
    // visibility of *everything*; sampling only the sky would pass for a veil
    // drawn behind the terrain, which is the mistake worth guarding against here.
    const ground = { x: 260, y: 560, w: 200, h: 120 }

    // The HUD control, and the thing about it that had to be measured rather
    // than assumed: **the sandbox's HUD strip is a translucent DOM panel**, not
    // an in-canvas layer (`sceneDepths` says the sandbox's furniture is DOM).
    // Its background is `rgba(12,16,22,.82)`, so 18 % of whatever the canvas
    // draws underneath it reaches the camera — and a first draft of this check
    // asserted the patch was *unchanged* and failed at 9.5, which is exactly
    // that bleed and not a veil over the HUD.
    //
    // So the claim is the one the bleed cannot fake: a veil drawn **above** the
    // HUD would move this patch by the full world delta, and translucency alone
    // can move it by at most `(1 - opacity)` of it. The opacity is read off the
    // live element rather than copied here, so restyling the panel cannot
    // silently loosen the bound.
    const hud = await page.evaluate(() => {
      const el = [...document.querySelectorAll('div')].find(
        (d) => d.style.position === 'fixed' && d.style.bottom === '10px',
      )
      if (!el) return null
      const r = el.getBoundingClientRect()
      const bg = getComputedStyle(el).backgroundColor
      const m = /rgba?\([^)]*?,\s*([0-9.]+)\s*\)/.exec(bg)
      return {
        rect: {
          x: Math.round(r.x),
          y: Math.round(r.y),
          w: Math.round(r.width),
          h: Math.round(r.height),
        },
        opacity: m ? Number(m[1]) : 1,
      }
    })
    if (!hud || hud.rect.w < 20 || hud.rect.h < 10) {
      throw new Error('could not locate the sandbox HUD strip — the veil has no control patch')
    }
    const hudRect = hud.rect
    const bleed = 1 - hud.opacity
    log(`HUD strip ${hudRect.w}x${hudRect.h} at opacity ${hud.opacity} — ${(bleed * 100).toFixed(0)}% bleeds through`)

    const clearSky = await samplePatch(page, sky)
    const clearGround = await samplePatch(page, ground)
    const clearHud = await samplePatch(page, hudRect)
    await shot('weather-fog-clear')

    // The ordering §F9 specifies, read off the layer stack rather than inferred
    // from a picture: over the world (and over the lightmap, so the measured
    // delta is the alpha rather than the alpha times the night curve), under
    // the HUD.
    const depths = await page.evaluate(() => {
      const d = window.__game.debug()
      return { fog: d.fogDepth, hud: d.hudDepth, lightmap: d.lightmapDepth }
    })
    if (!(depths.lightmap < depths.fog && depths.fog < depths.hud)) {
      throw new Error(
        `the veil is at depth ${depths.fog}; §F9 puts it above the lightmap ` +
          `(${depths.lightmap}) and below the HUD (${depths.hud})`,
      )
    }
    log(`veil depth ${depths.fog}, between lightmap ${depths.lightmap} and HUD ${depths.hud}`)

    await page.evaluate(() => window.__game.forceWeather(3))
    // Poll for the strength rather than sleeping a fixed time: the effect has a
    // telegraph before it activates and a `FOG_RAMP` after that, and a flat wait
    // against either is a test that expires the day one of them moves.
    let strength = 0
    let alpha = 0
    for (let i = 0; i < 60; i++) {
      await page.waitForTimeout(500)
      const d = await page.evaluate(() => {
        const g = window.__game
        return { s: g.debug().fogStrength, a: g.debug().fogAlpha }
      })
      strength = d.s
      alpha = d.a
      if (strength >= 0.99) break
    }
    log(`fog strength ${strength.toFixed(3)}, veil alpha ${alpha.toFixed(3)}`)
    if (strength < 0.99) {
      throw new Error(`the fog never reached full strength (peaked at ${strength.toFixed(3)})`)
    }
    // Both ends (§A39). A strength that climbs while the layer draws nothing is
    // precisely the failure this task exists to end, and it reads as a pixel
    // problem unless the two numbers are printed side by side.
    if (Math.abs(alpha - k.FOG_SCREEN_ALPHA * strength) > 0.01) {
      throw new Error(
        `the layer filled at ${alpha.toFixed(3)} where FOG_SCREEN_ALPHA x strength ` +
          `is ${(k.FOG_SCREEN_ALPHA * strength).toFixed(3)}`,
      )
    }

    const foggySky = await samplePatch(page, sky)
    const foggyGround = await samplePatch(page, ground)
    const foggyHud = await samplePatch(page, hudRect)
    await shot('weather-fog-veil')

    // The prediction, per channel: an alpha composite over the clear frame.
    // `assertChanged` alone would pass for a veil of any colour at any opacity;
    // §F9's acceptance is that the frame moves toward the grey **by the alpha
    // the constant names**, so that is what is asserted.
    const predict = (clear) => ({
      r: clear.r + alpha * (grey.r - clear.r),
      g: clear.g + alpha * (grey.g - clear.g),
      b: clear.b + alpha * (grey.b - clear.b),
    })
    for (const [label, clear, foggy] of [
      ['sky', clearSky, foggySky],
      ['ground', clearGround, foggyGround],
    ]) {
      const want = predict(clear)
      const err = colourDelta(foggy, want)
      const moved = colourDelta(clear, foggy)
      // How far the constants *say* the frame should travel. Derived, so it is
      // the veil's own claim rather than a threshold chosen to fit a run.
      const predicted = colourDelta(clear, want)
      log(
        `${label}: (${clear.r.toFixed(0)},${clear.g.toFixed(0)},${clear.b.toFixed(0)}) -> ` +
          `(${foggy.r.toFixed(0)},${foggy.g.toFixed(0)},${foggy.b.toFixed(0)}), ` +
          `predicted (${want.r.toFixed(0)},${want.g.toFixed(0)},${want.b.toFixed(0)}) ` +
          `= a move of ${predicted.toFixed(1)}; measured ${moved.toFixed(1)}, ` +
          `error ${err.toFixed(1)}, noise ${noise.toFixed(1)}`,
      )
      // 1. The constants have to describe a veil you can see at all. §F9 calls
      //    0.8 "a heavy veil by design"; a `FOG_SCREEN_ALPHA` of 0 fails here,
      //    by the whole distance rather than by a few units of a tuned floor,
      //    and the message names the constant that went wrong.
      if (predicted < noise * 5) {
        throw new Error(
          `${label}: FOG_SCREEN_COLOUR at ${alpha.toFixed(3)} predicts a move of only ` +
            `${predicted.toFixed(1)} against a ${noise.toFixed(1)} noise floor — the ` +
            `constants do not describe a fog anyone could see`,
        )
      }
      // 2. And the frame really did move. Reads no constant: a floor at three
      //    times the noise measured in this same run with no weather at all.
      if (moved < noise * 3) {
        throw new Error(
          `${label}: the veil moved the frame by only ${moved.toFixed(1)} against a ` +
            `${noise.toFixed(1)} noise floor — heavy fog is not on the screen`,
        )
      }
      // 3. And it moved to exactly where an alpha composite of
      //    FOG_SCREEN_COLOUR at this alpha puts it. This is the assertion that
      //    separates §F9's veil from any other full-screen cast — a green toxic
      //    tint passes 1 and 2 and fails this. 12 is one frame of sky animation
      //    plus PNG rounding over a 0..255 channel; the prediction itself is
      //    exact arithmetic. Measured: 4.0 (sky) and 2.0 (ground).
      if (err > 12) {
        throw new Error(
          `${label}: the veil landed ${err.toFixed(1)} from the composite of ` +
            `FOG_SCREEN_COLOUR at ${alpha.toFixed(3)} — that is not the fill §F9 specifies`,
        )
      }
    }

    const worldMoved = Math.max(
      colourDelta(clearSky, foggySky),
      colourDelta(clearGround, foggyGround),
    )
    const hudMoved = colourDelta(clearHud, foggyHud)
    // `+ 4` is `assertUnchanged`'s own no-change tolerance, kept for the
    // antialiased rounded corners and text inside the sampled rect.
    const hudCeiling = bleed * worldMoved + 4
    log(
      `the HUD moved ${hudMoved.toFixed(1)} where the world moved ${worldMoved.toFixed(1)} ` +
        `— a veil over it would move it the full amount; ${bleed.toFixed(2)} of bleed allows ` +
        `${hudCeiling.toFixed(1)}`,
    )
    if (hudMoved > hudCeiling) {
      throw new Error(
        `the HUD moved ${hudMoved.toFixed(1)}, past the ${hudCeiling.toFixed(1)} its own ` +
          `translucency can account for — §F9 puts the veil under the HUD`,
      )
    }

    // And it lifts. A veil that never clears looks identical to one that is
    // always on, so "fog arrived" would pass forever without this.
    for (let i = 0; i < 60; i++) {
      await page.waitForTimeout(500)
      const s = await page.evaluate(() => window.__game.debug().fogStrength)
      if (s <= 0.01) break
    }
    const after = await page.evaluate(() => window.__game.debug().fogAlpha)
    if (after > 0.01) throw new Error(`the veil did not lift: alpha still ${after}`)
    const cleared = await samplePatch(page, sky)
    const back = colourDelta(cleared, clearSky)
    // With the clock frozen this is a real assertion rather than a log line: the
    // frame has to come back to where it started. A veil that faded to a thin
    // haze instead of clearing, or one whose graphics were never cleared, leaves
    // a residue here — and neither shows up in `fogAlpha`, which is the layer's
    // own opinion of itself.
    log(`fog lifted; the sky returned to within ${back.toFixed(1)} (noise ${noise.toFixed(1)})`)
    if (back > Math.max(8, noise * 2)) {
      throw new Error(
        `the fog lifted but the sky is still ${back.toFixed(1)} from where it started — ` +
          `something of the veil is left on the screen`,
      )
    }
    await shot('weather-fog-cleared')

    // Hand the clock back. Freezing it here dropped the toxic cast's measured
    // delta below from 63 to 23 against a threshold of 16 — a borrowed clock
    // that is not returned weakens the assertions that come after it.
    await page.evaluate(() => window.__game.setTime(null))
  }

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
