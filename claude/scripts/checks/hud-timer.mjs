#!/usr/bin/env node
/**
 * T14.01 / §C8 — the round timer and the event banner are on the screen.
 *
 *   node scripts/checks/hud-timer.mjs
 *   node scripts/e2e.mjs hud-timer
 *
 * ## What this asserts, and why it is a browser check
 *
 * §C2: for anything visible, assert on rendered pixels, with a control region
 * and a control frame. A timer whose `style.color` is set to red is not a red
 * timer — four "I cannot see it" bugs shipped past this project's unit tests
 * because every assertion checked state. So every claim here is made twice: the
 * DOM's own account of itself (`debug().hudTimer` / `.hudBanner`) **and** the
 * pixels in the rect the element actually occupies.
 *
 * ## The fixture
 *
 * A 90 s round, so the timer crosses `TIMER_WARN_SECONDS` (60) about 30 s in and
 * the weather scheduler's first roll — `EFFECT_INTERVAL_MIN..MAX`, 30–45 s —
 * lands inside the same wait. One wait, both assertions. `FIXED_SEED` so the
 * roll is the same roll every run.
 *
 * The timer is **server-driven** (§B4's rule, applied to the round clock), so
 * this also proves the deadline plumbing: a client-side stopwatch would still
 * count down here, but it would not agree with `serverRoundTime`, and the last
 * assertion compares them.
 */
import { samplePatch } from './pixels.mjs'
import { startStack, enterBattle, tally, sleep } from './harness.mjs'

const PORT = 3123
const { fail, ok, finish } = tally('hud-timer')

const ROUND_SECONDS = 90

const stack = await startStack({
  port: PORT,
  label: 'hud-timer',
  // No bots: nothing here needs an opponent, and a bot's kill feed would move
  // pixels in a rect this check attributes to the banner.
  env: { ROUND_SECONDS: String(ROUND_SECONDS), BOT_COUNT: '0', FIXED_SEED: '4242' },
})
const { page, dbg, shot, pageErrors } = await stack.openClient({ name: 'ana' })
await enterBattle(page, { waitPlaying: true, label: 'hud-timer' })

const warnAt = await page.evaluate(() => window.__game.constants().TIMER_WARN_SECONDS)
console.log(`  round ${ROUND_SECONDS}s, warn below ${warnAt}s`)

/** The screen rect an element occupies, or null when it is not laid out. */
const rectOf = (id) =>
  page.evaluate((elId) => {
    const el = document.getElementById(elId)
    if (!el) return null
    const r = el.getBoundingClientRect()
    if (r.width < 1 || r.height < 1) return null
    return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) }
  }, id)

/** How red a patch is, relative to its other channels. Negative when it is not. */
const redness = (p) => p.r - (p.g + p.b) / 2

/**
 * A pixel is "warn red" above this redness.
 *
 * Derived, not chosen: the warning colour is `#ff3b30`, whose redness is
 * `255 - (59 + 48) / 2 = 201`. Everything else that can be in this rect is far
 * below — white digits are 0 by construction, and the sky behind them measures
 * about -80. 100 is the middle of a gap 200 wide, so no anti-aliased edge and no
 * weather decides the answer.
 */
const RED_MIN = 100

/**
 * The **fraction of pixels that are warn-red**, which is what this check asserts
 * on now. `samplePatch`'s mean is still logged, and it is no longer trusted.
 *
 * ## Why the mean had to go, measured rather than guessed
 *
 * The old assertion was `mean redness rose by more than 40` between a frame taken
 * at the start of the round and the frame the timer went red in. It has two
 * confounds and both are large enough to decide it:
 *
 * 1. **It is not the same rectangle.** `#hud-timer` is `right:14px`, so it is
 *    right-anchored and its width follows its text: "1:29" measures 111 px and
 *    "0:59" measures 121, because `1` is a narrow glyph. The before-frame rect
 *    and the after-frame rect differ by 10 px of background. Forcing the two
 *    samples onto the narrow rect reproduced the failure **8 times out of 8**
 *    (39.3-39.9 against a floor of 40), and it is exactly the "after sample is
 *    occasionally ~5 low" that `HANDOFF-M19.md` records as unexplained.
 * 2. **The background moves under it.** The two frames are ~30 s apart and the
 *    timer sits over the sky, which animates (§A4) and darkens on the day/night
 *    curve. Measured on a same-sized patch of pure sky beside the timer: it
 *    drifts -14.7 to -16.9 over that gap, and where it starts depends on how long
 *    the lobby lasted, so the drift is not even constant between runs.
 *
 * A mean over a moving rectangle against a moving background is an instrument
 * with two variables in it, and `dr` measured 39.3-48.0 across runs on one idle
 * box. The red-pixel fraction has neither variable: 8 consecutive runs read
 * **0.00% before and 27.21-27.23% after**, and the background control read 0.00%
 * in both frames. That is a gap of 27 points with a spread of 0.02.
 */
async function redFraction(page, { x, y, w, h }) {
  const b64 = (await page.screenshot({ clip: { x, y, width: w, height: h } })).toString('base64')
  return page.evaluate(
    async ({ src, min }) => {
      const img = new Image()
      img.src = `data:image/png;base64,${src}`
      await img.decode()
      const cv = document.createElement('canvas')
      cv.width = img.width
      cv.height = img.height
      const ctx = cv.getContext('2d')
      ctx.drawImage(img, 0, 0)
      const d = ctx.getImageData(0, 0, img.width, img.height).data
      let n = 0
      for (let i = 0; i < d.length; i += 4) if (d[i] - (d[i + 1] + d[i + 2]) / 2 > min) n++
      return n / (d.length / 4)
    },
    { src: b64, min: RED_MIN },
  )
}

/**
 * The floor the assertion uses, as a fraction.
 *
 * Measured 27.2% for a red timer and 0.00% for a white one, eight runs each. 5%
 * is a fifth of the signal and infinitely above the noise, which is what a
 * threshold on a **bimodal** measurement should look like — the number that
 * merely passes would be 27, and this is deliberately not that.
 */
const RED_FLOOR = 0.05

/** A same-sized patch of background beside the timer: §C2's control region. */
const besideThe = (r) => ({ x: r.x - r.w - 24, y: r.y, w: r.w, h: r.h })

// --- the timer is there, and it says what the server says -------------------
const white = await rectOf('hud-timer')
if (!white) {
  fail('#hud-timer is not laid out — there is no timer on the screen')
} else {
  const d0 = await dbg()
  const before = await samplePatch(page, white)
  const redBefore = await redFraction(page, white)
  const bgBefore = await redFraction(page, besideThe(white))
  ok(`timer rect ${white.w}x${white.h} at (${white.x}, ${white.y}), reading "${d0.hudTimer.text}"`)

  // Both ends (§A39): the digits on screen against **the server's own
  // broadcast**, `round_state.time_left`, not against another local derivation.
  //
  // Not `ROUND_SECONDS - serverRoundTime`: `serverRoundTime` is the world clock
  // and it has been running since the lobby, so that subtraction is short by the
  // whole warmup. It reported the timer 9 s fast when the timer was right — the
  // instrument was the bug, which is §A25 exactly.
  const left = d0.timeLeft
  const shown = d0.hudTimer.text
  const asClock = (n) => {
    const v = Math.max(0, Math.floor(n))
    return `${Math.floor(v / 60)}:${String(v % 60).padStart(2, '0')}`
  }
  // Two seconds of slack: `round_state` arrives once a second and the two reads
  // are not the same instant.
  const near = [left - 2, left - 1, left, left + 1, left + 2].some((n) => asClock(n) === shown)
  if (near) ok(`timer matches round_state.time_left within 2 s — "${shown}" vs ${left.toFixed(1)}s`)
  else fail(`the timer reads "${shown}" while round_state says ${left.toFixed(1)}s left ("${asClock(left)}")`)

  // Control: it is NOT red yet. Without this, "it turned red" passes for a
  // timer that was red for the whole round (§A26).
  if (d0.hudTimer.warn) {
    fail(`the timer is already in its warning state with ${left.toFixed(0)}s left`)
  } else if (redBefore > RED_FLOOR) {
    fail(
      `the timer patch is already ${(redBefore * 100).toFixed(2)}% warn-red before the ` +
        'boundary — "it turned red" would pass for a timer that was red all round',
    )
  } else {
    ok(
      `control: not red above the boundary — ${(redBefore * 100).toFixed(2)}% warn-red ` +
        `(mean redness ${redness(before).toFixed(1)})`,
    )
  }
  await shot('hud-timer-white')

  // --- and the banner is down, with nothing running -----------------------
  const b0 = await dbg()
  if (b0.hudBanner.shown) {
    fail(`the event banner is up with no effect running: "${b0.hudBanner.text}"`)
  } else {
    ok('control: the event banner is down while no effect is running')
  }

  // --- wait for the boundary and for the first effect ----------------------
  //
  // One wait for both: the round is 90 s, the timer crosses 60 at ~30 s, and the
  // scheduler's first roll is EFFECT_INTERVAL_MIN..MAX (30-45 s).
  let sawWarn = null
  let sawBanner = null
  const deadline = Date.now() + 70_000
  while (Date.now() < deadline && (!sawWarn || !sawBanner)) {
    const d = await dbg()
    if (!sawWarn && d.hudTimer.warn) {
      // The rect **as it is now**: the element is right-anchored and its width
      // follows its text, so the before-frame rect is not this rect. That is why
      // the assertion below counts red pixels instead of differencing two means
      // over two different rectangles — see `redFraction`.
      const wr = (await rectOf('hud-timer')) ?? white
      sawWarn = {
        d,
        rect: wr,
        patch: await samplePatch(page, wr),
        red: await redFraction(page, wr),
        bg: await redFraction(page, besideThe(wr)),
      }
      await shot('hud-timer-red')
    }
    if (!sawBanner && d.hudBanner.shown) {
      const r = await rectOf('hud-banner')
      sawBanner = r ? { d, rect: r, patch: await samplePatch(page, r) } : null
      if (sawBanner) await shot('hud-banner')
    }
    if (!sawWarn || !sawBanner) await sleep(250)
  }

  if (!sawWarn) {
    fail(`the timer never entered its warning state in ${ROUND_SECONDS - 20}s of a ${ROUND_SECONDS}s round`)
  } else {
    const left2 = sawWarn.d.timeLeft
    if (left2 > warnAt + 2) {
      fail(`the timer went red with ${left2.toFixed(1)}s left, above the ${warnAt}s threshold`)
    } else {
      ok(`the timer went red at ${left2.toFixed(1)}s left (threshold ${warnAt}s)`)
    }
    // The pixels, against the control frame: the same rect earlier had none.
    console.log(
      `  timer rect ${white.w}px → ${sawWarn.rect.w}px, mean redness ` +
        `${redness(before).toFixed(1)} → ${redness(sawWarn.patch).toFixed(1)} (logged, not asserted)`,
    )
    if (sawWarn.red > RED_FLOOR) {
      ok(
        `the timer's own rect turned red — ${(redBefore * 100).toFixed(2)}% → ` +
          `${(sawWarn.red * 100).toFixed(2)}% warn-red pixels`,
      )
    } else {
      fail(
        `the timer says it is warning but its pixels did not turn red: ` +
          `${(redBefore * 100).toFixed(2)}% → ${(sawWarn.red * 100).toFixed(2)}% warn-red ` +
          `(needs ${(RED_FLOOR * 100).toFixed(0)}%)`,
      )
    }
    // §C2's control **region**, which this check has never had: the same-sized
    // patch of sky beside the timer, in the same two frames. Without it, "red
    // pixels appeared" also passes for a frame that went red everywhere — a
    // fullscreen damage flash would do it.
    if (sawWarn.bg > RED_FLOOR) {
      fail(
        `the control patch beside the timer also went ${(sawWarn.bg * 100).toFixed(2)}% ` +
          'warn-red — the frame turned red everywhere, so the timer proves nothing',
      )
    } else {
      ok(
        `control region: the sky beside the timer stayed ${(bgBefore * 100).toFixed(2)}% → ` +
          `${(sawWarn.bg * 100).toFixed(2)}% warn-red`,
      )
    }
  }

  if (!sawBanner) {
    fail(
      'no effect was announced in 70 s, so the banner assertion did not run — ' +
        `EFFECT_INTERVAL is 30-45 s, so this is a real failure`,
    )
  } else {
    const { d, patch, rect } = sawBanner
    ok(`the banner appeared: "${d.hudBanner.text}" (${d.hudBanner.effects.length} effect(s) tracked)`)
    // It names something the server actually announced, rather than any string.
    const kinds = d.hudBanner.effects.map((e) => e.kind)
    const named = kinds.some((k) =>
      d.hudBanner.text.toLowerCase().includes(k.replace(/([a-z0-9])([A-Z])/g, '$1 $2').toLowerCase()),
    )
    if (named) ok(`it names an effect the server announced — ${kinds.join(', ')}`)
    else fail(`the banner reads "${d.hudBanner.text}" but the tracked effects are ${kinds.join(', ') || '(none)'}`)

    // The pixels, **against the control frame and nothing else**.
    //
    // Absolute redness was tried and is not a measurement: what is behind the
    // banner is the game, and the game is sometimes blue sky and sometimes brown
    // rock. Red text on sky reads -26.7 on this metric and red text on rock reads
    // +53, and neither number says whether anything was drawn. The *same rect
    // once the banner has gone* is the only comparison that does — which is §C2's
    // control frame, and is what the assertion below uses.

    // Wait for it to clear, then sample the same rect again.
    const gone = await (async () => {
      const dl = Date.now() + 40_000
      while (Date.now() < dl) {
        if (!(await dbg()).hudBanner.shown) return true
        await sleep(400)
      }
      return false
    })()
    if (!gone) {
      fail('the banner never cleared — an effect that has ended is still being announced')
    } else {
      const after = await samplePatch(page, rect)
      const delta = redness(patch) - redness(after)
      if (delta > 25) {
        ok(
          `the banner's rect was ${delta.toFixed(1)} redder while it was up ` +
            `(${redness(patch).toFixed(1)} → ${redness(after).toFixed(1)} when it cleared)`,
        )
      } else {
        fail(
          `the banner's rect is the same with it up and with it down: redness ` +
            `${redness(patch).toFixed(1)} → ${redness(after).toFixed(1)} — either it was ` +
            'never drawn, or it is still there',
        )
      }
    }
  }
}

if (pageErrors.length) fail(`page errors: ${pageErrors.join(' | ')}`)
else ok('no page errors')

await finish(() => stack.close())
