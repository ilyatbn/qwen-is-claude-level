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

// --- the timer is there, and it says what the server says -------------------
const white = await rectOf('hud-timer')
if (!white) {
  fail('#hud-timer is not laid out — there is no timer on the screen')
} else {
  const d0 = await dbg()
  const before = await samplePatch(page, white)
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
  } else if (redness(before) > 20) {
    fail(`the timer patch is already red (redness ${redness(before).toFixed(1)}) before the boundary`)
  } else {
    ok(`control: not red above the boundary — redness ${redness(before).toFixed(1)}`)
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
      sawWarn = { d, patch: await samplePatch(page, (await rectOf('hud-timer')) ?? white) }
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
    // The pixels, against the control frame: the SAME rect, earlier, not red.
    const dr = redness(sawWarn.patch) - redness(before)
    if (dr > 40) {
      ok(`the timer's own rect turned red — redness ${redness(before).toFixed(1)} → ${redness(sawWarn.patch).toFixed(1)}`)
    } else {
      fail(
        `the timer says it is warning but its pixels did not turn red: redness ` +
          `${redness(before).toFixed(1)} → ${redness(sawWarn.patch).toFixed(1)} (needs +40)`,
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

    // The pixels: red text in the banner's own rect, against the same rect once
    // the banner has gone. The control frame is the one that matters — a red
    // patch could be a red sky.
    if (redness(patch) > 25) {
      ok(`the banner's rect is red text on the frame — redness ${redness(patch).toFixed(1)}`)
    } else {
      fail(`the banner is "shown" but its rect is not red — redness ${redness(patch).toFixed(1)}`)
    }

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
      if (redness(patch) - redness(after) > 25) {
        ok(
          `and it cleared: the same rect went ${redness(patch).toFixed(1)} → ` +
            `${redness(after).toFixed(1)} redness`,
        )
      } else {
        fail(
          `the banner reports itself down but its rect is unchanged: redness ` +
            `${redness(patch).toFixed(1)} → ${redness(after).toFixed(1)}`,
        )
      }
    }
  }
}

if (pageErrors.length) fail(`page errors: ${pageErrors.join(' | ')}`)
else ok('no page errors')

await finish(() => stack.close())
