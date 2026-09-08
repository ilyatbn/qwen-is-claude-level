#!/usr/bin/env node
/**
 * `lava-lights` — T19.24: **a lava vent lights the ground at night, in a real
 * match.**
 *
 * `docs/14` §A3 says fire is a light source at night. It was true only in the
 * sandbox, which owns a local `LavaBurst` and pushes its own per-vent lights. A
 * networked client passed `vents: []` as a hardcoded literal, so it drew no
 * vent, no mouth and no ember, and its light list had nothing to add — while the
 * jet, the only phase that deals `LAVA_JET_DPS`, was damaging the player. This
 * check is against the **networked** scene for that reason: proving the sandbox
 * proves the half that already worked.
 *
 * ## The patch is **ground near the vent**, not the vent
 *
 * The first cut sampled the vent itself and passed — and its falsification
 * passed too, *harder*: deleting `ventLights` moved the number from 9.5 to
 * **28.1**. It was measuring the mouth and embers `WeatherLayer.drawFire` paints
 * regardless of any light, and unlit they contrast *more* against dark ground.
 * A check that scores higher with the feature removed is measuring the wrong
 * thing, and this one would have passed on a build with the lighting deleted.
 *
 * So the patch sits `SAMPLE_DX` px to the side and level with the jet light's
 * centre: inside `JET_LIGHT_R` of it, clear of the drawn mouth, and made of
 * terrain — which is what "fire is a light source" is a claim about. The vent's
 * own patch is still sampled and printed, as the contrast against it is the
 * evidence that the two are different measurements.
 *
 * ## Why the control frame is the assertion that matters
 *
 * "Bright at the vent" is satisfied by a frame that is bright everywhere, and a
 * night scene containing a burst is exactly the frame most likely to be bright
 * everywhere. So the lit patch is compared against **the same patch, in the same
 * place, between bursts** — `WEATHER=lava` re-forces a burst as soon as the last
 * ends, and each new one telegraphs for `EFFECT_TELEGRAPH` before its vents
 * open, which is the dark window this samples. A `CONTROL` region away from the
 * vent is sampled in both frames and must not move: without it, the whole screen
 * getting brighter would read as the vent lighting up.
 *
 * ## Why it waits so long
 *
 * There is no time-of-day override on the server (`config.rs` has none) and
 * `setTime` exists only on `SandboxScene`. Darkness comes from `round_time`
 * through `cycle.rs`, so full night begins at `NIGHT_START` x `CYCLE_LENGTH`
 * and the check has to wait for it. That is the price of testing the scene a
 * player is actually in.
 */
import { startStack, enterBattle, tally, sleep, standStill } from './harness.mjs'
import { toScreen, samplePatch, colourDelta } from './pixels.mjs'
import { constants as rustConstants } from '../lib/rust-constants.mjs'

const PORT = 3151
const { fail, ok, finish } = tally('lava-lights')

const C = rustConstants()
const NIGHT_DARKNESS = C.get('NIGHT_DARKNESS')
const CYCLE_LENGTH = C.get('DAY_DURATION') + C.get('NIGHT_DURATION')
/** From the shipped cycle, never a literal: night begins here. */
const NIGHT_AT = 0.62 * CYCLE_LENGTH

/** The patch sampled. Small, so terrain either side does not dilute it. */
const PATCH = { w: 48, h: 48 }
/**
 * How far to the side of the vent the measured ground sits, and how far up.
 *
 * Level with the jet light's centre (`JET_LIGHT_RISE` above the mouth) and well
 * inside its `JET_LIGHT_R`, so the patch is lit; far enough out that the drawn
 * mouth and the ember spray are not in it. Both numbers are read from the
 * shipped light geometry rather than typed here, so a retune moves the sample
 * with the light instead of leaving it outside.
 */
const JET_LIGHT_RISE = 60
const JET_LIGHT_R = 150
const SAMPLE_DX = Math.round(JET_LIGHT_R * 0.66)
const SAMPLE_DY = -JET_LIGHT_RISE
/** Top-left, far from any vent that is centred in frame. */
const CONTROL = { x: 8, y: 8, w: 120, h: 90 }
/**
 * The lit ground must beat the same ground between bursts by this much.
 *
 * **Measured, with both arms** — this box, networked, seed 4242:
 *
 * | | ground (asserted) | mouth (printed) | control |
 * |---|---|---|---|
 * | lights on  | **22.4** | 32.1 | 0.4 |
 * | lights off | **1.1**  | 45.0 | ~0  |
 *
 * So the floor sits 2.8x under the signal and 7x over the null. The mouth moving
 * the *other* way when the light is removed is the evidence that the two patches
 * measure different things — an unlit sprite contrasts harder against dark
 * ground, which is exactly how the first cut of this check passed its own
 * falsification.
 */
const MIN_DELTA = 8

const stack = await startStack({
  port: PORT,
  label: 'lava-lights',
  env: {
    FIXED_SEED: '4242',
    // Long enough to reach night at NIGHT_AT and then run a few bursts.
    ROUND_SECONDS: '200',
    BOT_COUNT: '0',
    WEATHER: 'lava',
  },
})

try {
  const { page, dbg, shot, pageErrors } = await stack.openClient({ name: 'ana' })
  await enterBattle(page, { waitPlaying: true, label: 'lava-lights' })
  await standStill(page)

  // --- wait for night ------------------------------------------------------
  const nightBy = Date.now() + (NIGHT_AT + 45) * 1000
  let dark = 0
  while (Date.now() < nightBy) {
    dark = (await dbg())?.darkness ?? 0
    if (dark >= NIGHT_DARKNESS * 0.95) break
    await sleep(1000)
  }
  if (dark < NIGHT_DARKNESS * 0.95) {
    fail(`never reached night: darkness ${dark.toFixed(2)} of ${NIGHT_DARKNESS}`)
  } else {
    ok(`night: darkness ${dark.toFixed(2)} of ${NIGHT_DARKNESS}`)
  }

  // --- find a vent that is actually on screen -------------------------------
  //
  // The camera follows the player and vents land anywhere on the map, so this
  // waits for a burst whose vent is in frame rather than sampling a patch that
  // might be empty ground. A check that cannot locate what it is photographing
  // asserts on the wrong pixels and passes for the wrong reason.
  const findVent = async (deadline) => {
    while (Date.now() < deadline) {
      const d = await dbg()
      for (const v of d?.vents ?? []) {
        // Jetting only: the sample sits at the *jet* light's radius, and the
        // afterburn's is smaller and lower. Mixing the two would measure a patch
        // that is inside the light for half the burst and outside it for the
        // rest.
        if (!v.jetting) continue
        const at = await toScreen(page, v.x + SAMPLE_DX, v.y + SAMPLE_DY)
        const mouth = await toScreen(page, v.x, v.y)
        if (at?.onScreen && mouth?.onScreen) return { world: v, screen: at, mouth }
      }
      await sleep(250)
    }
    return null
  }

  const found = await findVent(Date.now() + 90_000)
  if (!found) {
    fail('no lava vent came on screen in 90 s of night — nothing to photograph')
  } else {
    ok(`a vent is in frame at world (${found.world.x.toFixed(0)}, ${found.world.y.toFixed(0)})`)

    const rect = {
      x: Math.round(found.screen.x - PATCH.w / 2),
      y: Math.round(found.screen.y - PATCH.h / 2),
      w: PATCH.w,
      h: PATCH.h,
    }
    const mouthRect = {
      x: Math.round(found.mouth.x - PATCH.w / 2),
      y: Math.round(found.mouth.y - PATCH.h / 2),
      w: PATCH.w,
      h: PATCH.h,
    }
    const lit = await samplePatch(page, rect)
    const litMouth = await samplePatch(page, mouthRect)
    const litControl = await samplePatch(page, CONTROL)
    await shot('lava-lights-lit')

    // --- the control frame: the same patch between bursts -------------------
    const darkBy = Date.now() + 40_000
    let quiet = false
    while (Date.now() < darkBy) {
      const d = await dbg()
      const active = (d?.vents ?? []).some((v) => v.jetting || v.burning)
      if (!active) {
        quiet = true
        break
      }
      await sleep(200)
    }
    if (!quiet) {
      fail('no gap between bursts in 40 s — there is no control frame to compare against')
    } else {
      const unlit = await samplePatch(page, rect)
      const unlitMouth = await samplePatch(page, mouthRect)
      const unlitControl = await samplePatch(page, CONTROL)
      await shot('lava-lights-unlit')

      const d = colourDelta(unlit, lit)
      const dMouth = colourDelta(unlitMouth, litMouth)
      const dControl = colourDelta(unlitControl, litControl)
      // Printed, never asserted on: the mouth moves whether or not anything is
      // lit, because `drawFire` paints it either way. It is here so the two
      // numbers can be read side by side — if they ever converge, this check has
      // drifted back onto the sprite.
      console.log(`  ground ${d.toFixed(1)}  |  mouth ${dMouth.toFixed(1)} (not asserted)`)
      if (d < MIN_DELTA) {
        fail(
          `the vent's ground changed by only ${d.toFixed(1)} between burst and gap ` +
            `(needs ${MIN_DELTA}) — it is not lighting anything`,
        )
      } else if (dControl >= d) {
        fail(
          `the control region moved ${dControl.toFixed(1)} against the vent's ${d.toFixed(1)} — ` +
            'the whole frame changed, so this says nothing about the vent',
        )
      } else {
        ok(
          `the vent lights its ground: patch moved ${d.toFixed(1)}, control ${dControl.toFixed(1)}`,
        )
      }
    }
  }

  if (pageErrors.length) fail(`page errors: ${pageErrors.join(' | ')}`)
} finally {
  await stack.close()
}

await finish()
