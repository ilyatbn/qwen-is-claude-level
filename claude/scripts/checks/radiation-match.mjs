#!/usr/bin/env node
/**
 * T22.09C F1 — radiation in a **real** match: `GameScene`'s bit-7 reader.
 *
 *   node scripts/checks/radiation-match.mjs
 *
 * `radiation` proves the picture in the sandbox, which asks `Core.irradiated`
 * directly. A networked client has only snapshot bit 7, read in `GameScene` into
 * `this.irradiated` — and the review planted `this.irradiated = flag(…) && false`
 * and `FLAG.irradiated: 1 << 6` (poisoned's bit) and left every check green.
 *
 * Two servers, one human each in a private space room, read through
 * `debug().hudBars.irradiated` (the scene's copy of the bit) and `debug().hudBars.radiation` (what
 * `RadiationFx` has mounted):
 *
 * 1. **Stack A, the control** — the suit as shipped, issued full. Sealed in
 *    `Playing`, never irradiated; and in warmup the sealed line is not up (F8).
 * 2. **Stack B, the subject** — `DEV_START_BATTERY=0`, a flat suit at join. Bit 7
 *    reaches the scene in warmup already (the flag is not phase-gated, only the
 *    picture is), and in `Playing` the glow and the RADIATION line go up.
 *
 * Pixels (`docs/72` §C2): the right-edge strip in stack B's frame against the same
 * strip in stack A's, each taken `PHOTO_AT_S` into `Playing`. Same seed, same seat,
 * no input, so the same spawn, camera and sky — the one difference is the suit.
 * (Warmup against `Playing` on one page was tried first and is not a control: the
 * camera has not settled and the sky shade moves with the phase — the centre moved
 * 89.) The glow is yellow-green and a radiation tick's hit vignette is red, so the
 * edge is asserted on its **green** gain, which the red flash cannot supply; the
 * control region is the patch above centre `radiation` uses.
 */
import { startStack, freePort, tally, shotsDir, drawnFrames, soloSpace } from './harness.mjs'
import { deadlineMs } from '../lib/deadline.mjs'
import { samplePatch, assertUnchanged } from './pixels.mjs'
import { join } from 'node:path'

const { fail, ok, finish } = tally('radiation-match')
/** Long enough to read the warmup frames after the client loads. */
const WARMUP_S = 8
/** Frames drawn after a state change before reading or photographing it. */
const SETTLE_FRAMES = 6
/**
 * The edge strip's green gain over the sealed frame that the glow must supply. Measured
 * 45.6 at an opacity of 0.72, so ~32 at the pulse's `RADIATION_EDGE_MIN` trough; the
 * centre control moved 1.4 in the same pair. The hit vignette is red and lowers green.
 */
const MIN_GREEN_GAIN = 20
/** The round, set so that "seconds left" names one moment on both stacks. */
const ROUND_S = 60
/** How far into `Playing` both photographs are taken. */
const PHOTO_AT_S = 3

const dbg = (page) =>
  page.evaluate(() => {
    try {
      return window.__game ? window.__game.debug() : null
    } catch {
      return null
    }
  })
/** `n` drawn frames, or a throw naming a page that stopped rendering — the harness's one copy (T22.00C). */
const frames = (page, n) => drawnFrames(page, n)
const waitOn = (page, fn, arg, seconds, why) =>
  page
    .waitForFunction(fn, arg, { timeout: deadlineMs(seconds, why), polling: 'raf' })
    .then(() => true)
    .catch(() => false)
const brief = (d) => ({ phase: d?.phase, irradiated: d?.hudBars?.irradiated, radiation: d?.hudBars?.radiation, battery: d?.hudBars?.battery })

const stackEnv = (extra) => ({
  BOT_COUNT: '0',
  FIXED_SEED: '4242',
  WEATHER: 'off',
  DEV_WARMUP_SECONDS: String(WARMUP_S),
  ROUND_SECONDS: String(ROUND_S),
  ...extra,
})

/** Both stacks' regions: `radiation`'s edge strip and the patch above centre. */
const regions = (vw) => ({
  edge: { x: vw.w - 24, y: Math.round(vw.h * 0.4), w: 20, h: Math.round(vw.h * 0.2) },
  centre: { x: Math.round(vw.w / 2 - 40), y: Math.round(vw.h * 0.3), w: 80, h: 40 },
})

/** The edge and centre `PHOTO_AT_S` into `Playing`, and a shot named `name`. */
async function photoInPlay(page, name) {
  const at = await waitOn(
    page,
    (left) => {
      const d = window.__game.debug()
      return d.phase === 'playing' && d.results.secondsLeft <= left
    },
    ROUND_S - PHOTO_AT_S,
    WARMUP_S + PHOTO_AT_S + 20,
    'photo moment',
  )
  if (!at) throw new Error(`never reached ${PHOTO_AT_S} s into Playing: ${JSON.stringify(brief(await dbg(page)))}`)
  await frames(page, SETTLE_FRAMES)
  const vw = await page.evaluate(() => ({ w: window.innerWidth, h: window.innerHeight }))
  const r = regions(vw)
  const out = { edge: await samplePatch(page, r.edge), centre: await samplePatch(page, r.centre), d: await dbg(page) }
  await page.screenshot({ path: join(shotsDir, `${name}.png`) })
  return out
}

// ============================================================================
// Stack A — the control: the suit as issued.
// ============================================================================
/** Stack A's photograph: stack B's control frame. */
let sealedShot = null
const stackA = await startStack({ port: await freePort(), label: 'radiation-match-sealed', env: stackEnv({}) })
try {
  const { page, errors } = await soloSpace(stackA, 'ana')
  const warm = await dbg(page)
  if (warm?.phase !== 'warmup') fail(`control: ana reached the game after warmup, so the F8 arm cannot read it: ${JSON.stringify(brief(warm))}`)
  else if (warm.hudBars.irradiated !== false) fail(`a full suit in warmup reads irradiated: ${JSON.stringify(brief(warm))}`)
  else if (warm.hudBars.radiation?.state !== 'none' || warm.hudBars.radiation.line !== null) {
    fail(`F8: in warmup, with nothing draining, the sealed line is up: ${JSON.stringify(brief(warm))}`)
  } else ok('warmup, full suit: not irradiated, and no suit line while nothing drains (F8)')

  sealedShot = await photoInPlay(page, 'radiation-match-sealed')
  const play = sealedShot.d
  const sealed = play.hudBars?.radiation?.state === 'sealed'
  if (!sealed) fail(`control: a full suit in Playing never read sealed: ${JSON.stringify(brief(play))}`)
  else if (play.hudBars.irradiated !== false || play.hudBars.radiation.edgeOpacity !== 0) {
    fail(`control: a full suit in Playing is irradiated or glowing: ${JSON.stringify(brief(play))}`)
  } else ok(`control: a full suit in Playing is sealed, no glow — "${play.hudBars.radiation.line}"`)
  if (errors.length) fail(`ana page errors: ${errors.join(' | ')}`)
} catch (e) {
  fail(`stack A: ${e?.stack ?? e}`)
} finally {
  await stackA.close()
}

// ============================================================================
// Stack B — the subject: a flat suit at join (`DEV_START_BATTERY=0`).
// ============================================================================
const stackB = await startStack({
  port: await freePort(),
  label: 'radiation-match-flat',
  env: stackEnv({ DEV_START_BATTERY: '0' }),
})
try {
  const { page, errors } = await soloSpace(stackB, 'ana')
  // --- warmup: bit 7 is in the scene, and the picture is held back (F8) ---------
  const bit = await waitOn(page, () => window.__game.debug().hudBars?.irradiated === true, null, WARMUP_S, 'bit 7 in warmup')
  await frames(page, SETTLE_FRAMES)
  const warm = await dbg(page)
  if (!bit || warm.phase !== 'warmup') {
    fail(`a flat suit in warmup never read irradiated off bit 7: ${JSON.stringify(brief(warm))}`)
  } else if (warm.hudBars.radiation?.state !== 'none' || warm.hudBars.radiation.edgeOpacity !== 0) {
    fail(`F8: warmup, nothing hurts, and the radiation feedback is up: ${JSON.stringify(brief(warm))}`)
  } else ok('warmup, flat suit: GameScene reads bit 7 as irradiated, and draws nothing yet (F8)')

  // --- playing: the glow and the line -------------------------------------------
  const hot = await photoInPlay(page, 'radiation-match-irradiated')
  const play = hot.d
  if (play.hudBars?.radiation?.state !== 'irradiated' || !(play.hudBars.radiation.edgeOpacity > 0)) {
    fail(`a flat suit in space in Playing never put the radiation feedback up in GameScene: ${JSON.stringify(brief(play))}`)
  } else if (play.hudBars.irradiated !== true || !/RADIATION/.test(play.hudBars.radiation.line ?? '')) {
    fail(`irradiated in Playing without bit 7 or the RADIATION line: ${JSON.stringify(brief(play))}`)
  } else ok(`Playing, flat suit: irradiated off bit 7, glow ${play.hudBars.radiation.edgeOpacity.toFixed(2)}, "${play.hudBars.radiation.line}"`)

  if (!sealedShot) fail('no sealed frame from stack A, so the edge has nothing to be compared with')
  else {
    const [a, b] = [sealedShot, hot]
    const gain = { r: b.edge.r - a.edge.r, g: b.edge.g - a.edge.g, b: b.edge.b - a.edge.b }
    const fmt = (o) => `r ${o.r.toFixed(1)} g ${o.g.toFixed(1)} b ${o.b.toFixed(1)}`
    if (!(gain.g >= MIN_GREEN_GAIN)) {
      fail(`the edge strip's green is only ${gain.g.toFixed(1)} above the sealed frame's (want ≥ ${MIN_GREEN_GAIN}): ${fmt(gain)}`)
    } else ok(`edge strip, sealed frame → flat frame: ${fmt(gain)}`)
    try {
      const c = assertUnchanged(a.centre, b.centre, { label: 'control: the centre, sealed frame → flat frame', maxDelta: 6 })
      ok(`control: the centre moved ${c.delta.toFixed(1)}`)
    } catch (e) {
      fail(String(e.message ?? e))
    }
  }
  if (errors.length) fail(`ana page errors: ${errors.join(' | ')}`)
} catch (e) {
  fail(`stack B: ${e?.stack ?? e}`)
} finally {
  await stackB.close()
}

await finish()
