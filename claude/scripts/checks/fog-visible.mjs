#!/usr/bin/env node
/**
 * `fog-visible` — §F9's veil, **in a real match**.
 *
 * `weather-visible` proves the same drawing in the sandbox, and that is not
 * enough on its own. `docs/72` §C0 is this project's most expensive lesson:
 * there are two render paths, the game scene is the one nobody develops in, and
 * four separate "I cannot see it" bugs shipped because every assertion about the
 * world was made against the scene that did not have the bug. Heavy fog reaches
 * the game by a **different route** from the sandbox — the sandbox owns a
 * `HeavyFog` and reads its strength off its own world, while a networked client
 * has no weather at all and walks the ramp from an `effect_start` event — so the
 * sandbox acceptance says nothing whatever about this half.
 *
 * The switch that makes it testable is `WEATHER=fog` (T19.10), the same `Config`
 * family as `DEV_POISONED`: without it this check would wait out
 * `EFFECT_INTERVAL_MIN` and then hope the scheduler rolled fog rather than rain,
 * a one-in-four coin flip inside a gate.
 *
 * **Two servers, and the second one is aligned on `roundTime`.** That is the
 * expensive-looking part and it is load-bearing. The day/night cycle is a
 * function of round time (§A4) and it moves *fast* around dawn: measured, the
 * sky at `roundTime` 2.5 is (109,116,141) and at 15.0 it is (119,162,206). A
 * one-server version that took its control frame during the warmup — the only
 * fog-free window `WEATHER=fog` leaves — was therefore comparing two different
 * skies, and its composite error was **16.8** against the 0.7 the aligned pair
 * measures. So the fog arm runs first and reports the round time it sampled at,
 * and the clear arm waits for the same round time before sampling. Same seed,
 * same spawn, same point in the day; the only difference is the weather.
 *
 * The assertion is the composite, not a delta. "The frame changed" passes for
 * any full-screen cast — the toxic rain's green vignette would pass it — so what
 * is asserted is that every sampled patch lands where an alpha composite of
 * `FOG_SCREEN_COLOUR` at `FOG_SCREEN_ALPHA x strength` puts it.
 */
import { startStack, enterBattle, tally, sleep } from './harness.mjs'
import { samplePatch, colourDelta } from './pixels.mjs'

const PORT = 3141
const { fail, ok, failures } = tally('fog-visible')

const ROUND_SECONDS = 240

/** A sky patch and a ground patch. */
const SKY = { x: 900, y: 80, w: 180, h: 120 }
/**
 * §F9 says the veil reduces the visibility of *everything*. A sky-only sample
 * would pass for a veil drawn behind the terrain, which is the half of the
 * ordering a depth number alone cannot rule out.
 */
const GROUND = { x: 260, y: 560, w: 200, h: 120 }
/**
 * **No HUD patch here, deliberately.** The game's bars, quick bar, timer and
 * minimap are all DOM — `DEPTH.hud` has exactly one in-canvas occupant in either
 * scene, the crosshair (`GameScene.ts:413`), which is a few thin white lines
 * whose patch mean is dominated by the world behind them. So "the HUD is above
 * the veil" is `weather-visible`'s claim to make, where it is asserted twice: as
 * a pixel bound derived from the panel's own measured opacity, and as
 * `DEPTH.lightmap < DEPTH.fog < DEPTH.hud` read off the layer stack. A patch
 * here would restate it more weakly and read as a second, stronger proof.
 *
 * A first draft did sample the bars strip and measured 14.9 against a world that
 * moved 48.2 — the strip is 31 % world by area, not a veil leaking through it.
 * Recorded so the number is not rediscovered as a bug.
 */

/** Sample the two patches, and say when. */
async function frames(page) {
  return {
    sky: await samplePatch(page, SKY),
    ground: await samplePatch(page, GROUND),
    at: await page.evaluate(() => window.__game.debug().roundTime ?? 0),
  }
}

function fogState(page) {
  return page.evaluate(() => {
    const d = window.__game.debug()
    return {
      s: d.fogStrength ?? 0,
      a: d.fogAlpha ?? 0,
      phase: d.phase ?? '',
      t: d.roundTime ?? 0,
      torch: d.hasFlashlight ?? false,
    }
  })
}

const common = {
  ROUND_SECONDS: String(ROUND_SECONDS),
  FIXED_SEED: '4242',
  // No bots: a bot walking through a sampled patch is a colour change this
  // check would attribute to the weather.
  BOT_COUNT: '0',
}

// --- the fog arm, first, because it sets the round time the other must match --
let k = null
let s = null
let wet = null
/** The clear frames and the measured noise floor, for the flashlight arm below. */
let clear0 = null
let noiseFloor = 0

const fogStack = await startStack({ port: PORT, label: 'fog-visible/fog', env: { ...common, WEATHER: 'fog' } })
try {
  const { page, shot, pageErrors } = await fogStack.openClient({ name: 'ana' })
  await enterBattle(page, { waitPlaying: true, label: 'fog-visible/fog' })
  k = await page.evaluate(() => window.__game.constants())

  // Poll for full strength rather than sleeping a fixed time: the round has a
  // warmup, the effect has a telegraph and the veil has a `FOG_RAMP`, and a flat
  // wait against any of them is a test that expires the day one of them moves.
  s = { s: 0, a: 0, phase: '', t: 0 }
  for (let i = 0; i < 90; i++) {
    s = await fogState(page)
    if (s.s >= 0.99) break
    await sleep(500)
  }
  console.log(`  in-match fog strength ${s.s.toFixed(3)}, veil alpha ${s.a.toFixed(3)} at round time ${s.t.toFixed(1)}`)
  if (s.s < 0.99) {
    fail(
      `WEATHER=fog never reached full strength in the game client (peaked ${s.s.toFixed(3)}, ` +
        `phase "${s.phase}") — either no effect_start arrived or the client never walked the ramp`,
    )
  } else if (Math.abs(s.a - k.FOG_SCREEN_ALPHA * s.s) > 0.01) {
    fail(
      `the layer filled at ${s.a.toFixed(3)} where FOG_SCREEN_ALPHA x strength is ` +
        `${(k.FOG_SCREEN_ALPHA * s.s).toFixed(3)}`,
    )
  } else {
    ok(`the game client walked the ramp to full fog and filled at ${s.a.toFixed(3)}`)
  }
  wet = await frames(page)
  await shot('fog-game-veil')
  if (pageErrors.length) fail(`page errors under fog: ${pageErrors.join(' | ')}`)
} finally {
  await fogStack.close()
}

// --- the clear arm, at the same point in the same round -----------------------
const clearStack = await startStack({
  port: PORT + 1,
  label: 'fog-visible/clear',
  env: { ...common, WEATHER: 'off' },
})
try {
  const { page, shot, pageErrors } = await clearStack.openClient({ name: 'ana' })
  await enterBattle(page, { waitPlaying: true, label: 'fog-visible/clear' })

  const target = wet?.at ?? 0
  for (let i = 0; i < 120; i++) {
    const now = await fogState(page)
    if (now.t >= target) break
    await sleep(200)
  }
  const before = await fogState(page)
  // The control that makes the whole comparison mean something: same build, same
  // scene, no veil. Without it "the frame is grey" is satisfied by a client that
  // draws a grey rectangle unconditionally.
  if (before.a !== 0) fail(`WEATHER=off still raised a veil: alpha ${before.a}`)
  else ok(`no veil with WEATHER=off, at round time ${before.t.toFixed(1)} (the control)`)

  const clear = await frames(page)
  await sleep(700)
  const clear2 = await frames(page)
  // The noise floor: two frames of the same view with no weather. The sky
  // animates (§A4), so it is not zero, and a threshold set without measuring it
  // is a guess.
  const noise = Math.max(
    colourDelta(clear.sky, clear2.sky),
    colourDelta(clear.ground, clear2.ground),
  )
  console.log(
    `  clear frame at round time ${clear.at.toFixed(1)} against the foggy one at ` +
      `${(wet?.at ?? 0).toFixed(1)}; noise floor ${noise.toFixed(1)}`,
  )
  await shot('fog-game-clear')

  const grey = {
    r: (k.FOG_SCREEN_COLOUR >> 16) & 0xff,
    g: (k.FOG_SCREEN_COLOUR >> 8) & 0xff,
    b: k.FOG_SCREEN_COLOUR & 0xff,
  }
  for (const label of ['sky', 'ground']) {
    const a = s.a
    const c = clear[label]
    const want = {
      r: c.r + a * (grey.r - c.r),
      g: c.g + a * (grey.g - c.g),
      b: c.b + a * (grey.b - c.b),
    }
    const err = colourDelta(wet[label], want)
    const moved = colourDelta(c, wet[label])
    // How far the constants *say* the frame should travel. Derived, so it is the
    // veil's own claim rather than a threshold chosen to fit a run.
    const predicted = colourDelta(c, want)
    console.log(
      `  ${label}: (${c.r.toFixed(0)},${c.g.toFixed(0)},${c.b.toFixed(0)}) -> ` +
        `(${wet[label].r.toFixed(0)},${wet[label].g.toFixed(0)},${wet[label].b.toFixed(0)}), ` +
        `predicted a move of ${predicted.toFixed(1)}, measured ${moved.toFixed(1)}, ` +
        `error ${err.toFixed(1)}, noise ${noise.toFixed(1)}`,
    )
    if (predicted < 25) {
      // The constants have to describe a veil you can see at all. §F9 calls 0.8
      // "a heavy veil by design"; `FOG_SCREEN_ALPHA = 0` fails here by the whole
      // distance, and the message names the constant that went wrong. A fixed
      // floor rather than a multiple of the noise, because the noise here is two
      // frames from one client and the predicted move is the claim being tested.
      fail(
        `${label}: a veil at alpha ${a.toFixed(3)} predicts a move of only ` +
          `${predicted.toFixed(1)} — either FOG_SCREEN_ALPHA describes a fog nobody could ` +
          'see, or nothing fed the layer a strength (the alpha check above says which)',
      )
    } else if (moved < noise * 3) {
      fail(
        `${label}: the veil moved the game's frame by only ${moved.toFixed(1)} against a ` +
          `${noise.toFixed(1)} noise floor — heavy fog is not on the screen in a real match`,
      )
    } else if (err > 16) {
      // 16 rather than `weather-visible`'s 12: these two frames come from two
      // server processes, so the round clocks agree to a fraction of a second
      // rather than exactly. Measured error is 0.7 (sky) and 2.5 (ground).
      fail(
        `${label}: the veil landed ${err.toFixed(1)} from the composite of ` +
          `FOG_SCREEN_COLOUR at ${a.toFixed(3)} — that is not the fill §F9 specifies`,
      )
    } else {
      ok(`${label}: moved ${moved.toFixed(1)} onto the composite (error ${err.toFixed(1)})`)
    }
  }

  if (pageErrors.length) fail(`page errors on the clear client: ${pageErrors.join(' | ')}`)
  else ok('no page errors')
  clear0 = clear
  noiseFloor = noise
} finally {
  await clearStack.close()
}

// --- the flashlight arm: same fog, one item, a lighter veil (T20.07) ---------
//
// **`GameScene`, deliberately.** Six production sites hardcoded
// `flashlightOn: false`; two are here and four are in `SandboxScene`, which is
// what `night-combat` drives. Fixing one pair leaves the other check looking at
// unchanged literals, so the falsification is split: `night-combat` breaks the
// sandbox's lightmap site, and this breaks `GameScene`'s.
//
// This is also §C13 reversed on the coordinator's instruction — the flashlight
// used to be a trade and is now passive and free — and `tasks/M20/T20.07` records
// the override.
//
// Three frames of the same patch, at the same point in the same seeded round:
// clear (no veil), foggy (full veil), and foggy-with-a-torch. The middle one is
// the control that stops "lighter than nothing" passing, and the first is the
// control that stops "the layer draws nothing" passing.
const litStack = await startStack({
  port: PORT + 2,
  label: 'fog-visible/flashlight',
  env: { ...common, WEATHER: 'fog', DEV_FLASHLIGHT: '1' },
})
try {
  const { page, shot, pageErrors } = await litStack.openClient({ name: 'ana' })
  await enterBattle(page, { waitPlaying: true, label: 'fog-visible/flashlight' })

  let lit = { s: 0, a: 0, phase: '', t: 0, torch: false }
  for (let i = 0; i < 90; i++) {
    lit = await fogState(page)
    if (lit.s >= 0.99 && lit.t >= (wet?.at ?? 0)) break
    await sleep(500)
  }

  // **Both ends, and this end first.** If the server never put a torch in the
  // bag, every pixel below is a measurement of nothing — and `DEV_FLASHLIGHT` is
  // exactly the kind of switch that fails silently.
  if (!lit.torch) {
    fail('DEV_FLASHLIGHT=1 did not put a flashlight in the bag — bit 4 never reached the client')
  } else ok('the server put a flashlight in the bag and bit 4 reached the client')

  const want = k.FOG_SCREEN_ALPHA * lit.s * k.FLASHLIGHT_FOG_VEIL_MULT
  if (lit.s < 0.99) {
    fail(`the flashlight arm never reached full fog (peaked ${lit.s.toFixed(3)})`)
  } else if (Math.abs(lit.a - want) > 0.01) {
    fail(
      `the veil filled at ${lit.a.toFixed(3)} with a flashlight held, not ` +
        `${want.toFixed(3)} (FOG_SCREEN_ALPHA x strength x FLASHLIGHT_FOG_VEIL_MULT)`,
    )
  } else {
    ok(`a carried flashlight thinned the veil to ${lit.a.toFixed(3)} from ${s.a.toFixed(3)}`)
  }

  const litFrames = await frames(page)
  await shot('fog-game-flashlight')

  // **The pixels.** The lit frame must sit between the clear one and the foggy
  // one — closer to clear than the full veil is, by more than the noise floor,
  // in both patches. A layer that ignored the flashlight lands on top of the
  // foggy frame; one that switched the veil off entirely lands on the clear one,
  // and the lower bound catches that.
  for (const label of ['sky', 'ground']) {
    const toClearFog = colourDelta(clear0[label], wet[label])
    const toClearLit = colourDelta(clear0[label], litFrames[label])
    const gap = toClearFog - toClearLit
    // What the constants say the gap should be: the veil moved the frame
    // `toClearFog` at alpha `s.a`, and alpha is linear in the composite, so a
    // multiplier of `FLASHLIGHT_FOG_VEIL_MULT` predicts this much less travel.
    const predictedGap = toClearFog * (1 - k.FLASHLIGHT_FOG_VEIL_MULT)
    console.log(
      `  ${label}: veil moved the frame ${toClearFog.toFixed(1)} without a torch and ` +
        `${toClearLit.toFixed(1)} with one — a gap of ${gap.toFixed(1)}, predicted ` +
        `${predictedGap.toFixed(1)}, noise ${noiseFloor.toFixed(1)}`,
    )
    // **The prediction is the assertion, not `gap > noise`.** A bare
    // "it moved more than the noise" branch is a coin flip here: the measured gap
    // on the ground patch is 7.4 against a noise floor that runs 4.9-5.4, and a
    // gate that fails on a draw gates nothing. The two-sided comparison below is
    // both stronger and stable — a flashlight that did nothing gives a gap of 0
    // and fails by the whole predicted distance, with the number in the message.
    if (toClearLit < noiseFloor) {
      fail(
        `${label}: the lit frame is indistinguishable from the clear one — the flashlight ` +
          'removed the veil rather than thinning it',
      )
    } else if (Math.abs(gap - predictedGap) > Math.max(6, noiseFloor)) {
      fail(
        `${label}: the gap is ${gap.toFixed(1)} where FLASHLIGHT_FOG_VEIL_MULT predicts ` +
          `${predictedGap.toFixed(1)}`,
      )
    } else {
      ok(`${label}: the veil is thinner with a flashlight (${gap.toFixed(1)} of travel removed)`)
    }
  }

  if (pageErrors.length) fail(`page errors on the flashlight client: ${pageErrors.join(' | ')}`)
  else ok('no page errors (flashlight arm)')
} finally {
  await litStack.close()
}

if (failures.length) {
  console.error(`\nfog-visible: ${failures.length} failure(s)`)
  for (const f of failures) console.error(`  - ${f}`)
  process.exit(1)
}
console.log('fog-visible ok')
