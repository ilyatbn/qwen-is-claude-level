#!/usr/bin/env node
/**
 * T13.06 — the round ends, and you are told.
 *
 *   node scripts/checks/round-end.mjs
 *   node scripts/e2e.mjs round-end
 *
 * ## What was wrong
 *
 * `ROUND_SECONDS` elapsed and nothing happened. The server's phase machine has
 * driven `Playing -> Ended` correctly since T6.12 and broadcast `round_state` on
 * every transition; the client stored the phase in a field and rendered a banner
 * with it. Nothing else read it. §A39 for the fourteenth time — a mechanism with
 * no consumer, and the consumer is the entire end of the game.
 *
 * ## Why a real server, and a real clock
 *
 * The phase machine is the subject. There is no sandbox path to `Ended`, and
 * faking one would test a code path no player reaches. `ROUND_SECONDS` is
 * shortened to keep this under a minute — that is the constant's documented
 * purpose (`docs/41` §5) and not a fixture cheating.
 *
 * The control is the half that makes it mean anything: the screen must be
 * **absent** during `Playing`. Asserting only that it appears at the end passes
 * for a screen that is up from the first frame, which would be a worse bug than
 * the one being fixed.
 *
 * The stack and the route into a battle are `harness.mjs` (§C18). This check
 * used to set `MIN_PLAYERS_TO_START=1` to skip the lobby; three checks did and
 * five did not, which is how one lobby change turned into five red checks.
 */
import { join } from 'node:path'
import { startStack, enterBattle, tally, sleep, shotsDir } from './harness.mjs'

const PORT = 3118

/** Warmup is 10 s and is not shortened, so this is the playing half only. */
const ROUND_SECONDS = 20

const t = tally('round-end')
const ok = t.ok
let failed = false
const fail = (m) => {
  t.fail(m)
  failed = true
}

const stack = await startStack({
  port: PORT,
  label: 'round-end',
  env: { ROUND_SECONDS: String(ROUND_SECONDS), BOT_COUNT: '2' },
})
const { page, dbg, shot, pageErrors } = await stack.openClient({ name: 'ana' })
await enterBattle(page, { label: 'round-end' })
console.log(`  round ${ROUND_SECONDS}s + warmup`)

/**
 * Is the results screen **visible**? Not "is it in the DOM".
 *
 * The first version of this check asked only whether the element existed. Every
 * assertion passed — element present, both buttons present, voting registering —
 * and the screenshot showed the field with no screen on it at all, because no
 * CSS for `.results-screen` existed yet. A hidden element is not a HUD (§C2),
 * and "a fix that changes the code without changing the picture looks exactly
 * like a fix that worked".
 *
 * So: laid out (non-zero box), not `display:none`/`visibility:hidden`, not
 * transparent, and covering a meaningful part of the viewport.
 */
const screenUp = () =>
  page.evaluate(() => {
    const el = document.querySelector('.results-screen')
    if (!el) return false
    const r = el.getBoundingClientRect()
    const st = getComputedStyle(el)
    return (
      r.width > 200 &&
      r.height > 200 &&
      st.display !== 'none' &&
      st.visibility !== 'hidden' &&
      Number(st.opacity) > 0.1
    )
  })
const rowsOnScreen = () =>
  page.evaluate(() =>
    [...document.querySelectorAll('.results-rows li')].map((li) => ({
      name: li.querySelector('.name')?.textContent ?? '',
      score: Number(li.querySelector('.score')?.textContent ?? 'NaN'),
    })),
  )

// --- the control: not up while playing ------------------------------------
//
// Waited for rather than sampled once: joining lands in `warmup`, and a check
// that looked immediately would be asserting about the wrong phase.
let sawPlaying = false
for (let i = 0; i < 240 && !sawPlaying; i++) {
  if ((await dbg()).phase === 'playing') sawPlaying = true
  else await sleep(250)
}
if (!sawPlaying) fail('the round never reached `playing` — nothing below is meaningful')
else if (await screenUp()) fail('the results screen is up during `playing`')
else ok('not shown during the round (the control)')

// §C25's control, on a **non-`Ended`** phase: the countdown element is not on
// screen at all. Asserted on the element's existence rather than by comparing
// its text to itself — `'' === ''` holds forever and would be an assertion that
// cannot fail (§B15).
if (await page.evaluate(() => !!document.querySelector('.results-count'))) {
  fail('the results countdown is in the DOM during `playing`')
} else {
  ok('no countdown on screen outside `ended` (the control)')
}

await shot('round-end-playing')

// --- the subject: up at `ended` -------------------------------------------
let sawEnded = false
for (let i = 0; i < 400 && !sawEnded; i++) {
  if ((await dbg()).phase === 'ended') sawEnded = true
  else await sleep(250)
}
if (!sawEnded) {
  fail(`the round never reached \`ended\` in ${ROUND_SECONDS}s + warmup`)
} else {
  // A frame for the DOM to render into.
  await sleep(300)
  if (!(await screenUp())) fail('the round ended and no results screen appeared')
  else ok('the results screen is up at `ended`')
}

// --- the scoreboard says what the server says -----------------------------
//
// Reconciled against the server's own table rather than against itself: the
// scoreboard read 0 for everyone for a whole milestone while the HUD refreshed
// faithfully to show it (T9.06), and a screen that renders its own stale copy
// would look exactly like this one.
if (sawEnded) {
  const rows = await rowsOnScreen()
  const d = await dbg()
  const serverNames = new Set((d.players ?? []).map((p) => String(p)))
  if (rows.length === 0) {
    fail('the results screen has no rows — an empty scoreboard is not a scoreboard')
  } else if (rows.length !== serverNames.size) {
    fail(`the screen lists ${rows.length} players, the server has ${serverNames.size}`)
  } else {
    ok(`scoreboard lists all ${rows.length} players`)
  }
  if (rows.some((r) => Number.isNaN(r.score))) fail('a score rendered as non-numeric')
  else ok(`scores render: ${rows.map((r) => `${r.name}:${r.score}`).join(' ')}`)
}

// --- §C25: the countdown counts down --------------------------------------
//
// The bug: `round_state` is broadcast on every transition and then once a second
// *while `Playing`* — `round.rs` has no periodic branch for `Ended`. So a client
// that stores `time_left` receives exactly one value for the whole twenty-second
// window and renders it, unmoving, until the phase changes.
//
// Read off the **DOM**, not off a field (§C2): the number the player sees is the
// thing that was wrong, and every internal value was already correct.
if (sawEnded) {
  const countdown = async () => {
    const d = await dbg()
    return {
      // `.results-count` reads "12s"; the digits are what is asserted.
      text: String(d.results?.text ?? ''),
      secs: Number(String(d.results?.text ?? '').replace(/[^0-9.]/g, '')),
      server: Number(d.serverRoundTime ?? NaN),
      phase: d.phase,
    }
  }

  const first = await countdown()
  if (!Number.isFinite(first.secs) || first.text === '') {
    fail(`the results countdown renders nothing: ${JSON.stringify(first.text)}`)
  } else {
    ok(`countdown renders "${first.text}"`)
  }

  // Several points, not two. A single pair a second apart is satisfied by a
  // number that moves once; the invariant below needs a series to be worth
  // anything.
  const samples = [first]
  for (let i = 0; i < 6; i++) {
    await sleep(1100)
    samples.push(await countdown())
  }
  const live = samples.filter((x) => x.phase === 'ended' && Number.isFinite(x.secs))

  // Rendered: two frames a second apart differ.
  const moved = live.some((x, i) => i > 0 && x.secs !== live[i - 1].secs)
  if (!moved) {
    fail(
      `the rendered countdown never changed across ${live.length} samples a second ` +
        `apart: ${live.map((x) => x.text).join(' ')} — this is the bug`,
    )
  } else {
    ok(`the rendered countdown fell: ${live.map((x) => x.text).join(' -> ')}`)
  }

  // Both ends (§A39): the number **on screen** against the **server's** clock.
  //
  // `rendered + serverRoundTime` is the deadline, so it is constant while the
  // countdown tracks the server — within 1 s, which is the width of the `ceil`
  // the display applies. A static countdown makes this sum climb by the whole
  // length of the window, so the two cases are nowhere near each other. Nothing
  // circular here: the digits come from the DOM and the clock from the snapshot
  // header.
  if (live.length >= 3) {
    const deadlines = live.map((x) => x.secs + x.server)
    const spread = Math.max(...deadlines) - Math.min(...deadlines)
    if (spread > 1.5) {
      fail(
        `rendered seconds + server round time drifted by ${spread.toFixed(2)} s over ` +
          `${live.length} samples (${deadlines.map((d) => d.toFixed(1)).join(', ')}) — the ` +
          'countdown is not tracking the server clock',
      )
    } else {
      ok(
        `countdown tracks the server clock (deadline steady within ${spread.toFixed(2)} s ` +
          `over ${live.length} samples)`,
      )
    }
  } else {
    fail(`only ${live.length} usable samples inside \`ended\` — the series did not run`)
  }

  // The control for "it moves": freeze the scene and the rendered number must
  // **stop**. §C25's named risk is "a local stopwatch" — a `setInterval` keeps
  // firing while the scene is paused, so a countdown that carries on ticking
  // here is running on a timer of its own rather than being recomputed in the
  // update loop from the server's clock. It does not discriminate against every
  // wrong implementation; it discriminates against that one.
  const beforeFreeze = await countdown()
  await page.evaluate(() => window.__game.freeze(true))
  await sleep(1400)
  const whileFrozen = await countdown()
  await page.evaluate(() => window.__game.freeze(false))
  if (whileFrozen.phase === 'ended' && beforeFreeze.phase === 'ended') {
    if (whileFrozen.secs !== beforeFreeze.secs) {
      fail(
        `the countdown moved ${beforeFreeze.text} -> ${whileFrozen.text} with the scene ` +
          'paused — it is running on an interval of its own rather than being ' +
          'recomputed against the server clock',
      )
    } else {
      ok(`paused, it holds at ${whileFrozen.text} (the control)`)
    }
  }
}

await shot('round-end-results')

// --- input stops ----------------------------------------------------------
//
// The server freezes the simulation in `Ended` but keeps accepting input, so a
// client that carries on sending queues a burst applied the instant the next
// round starts. Asserted on the *sent* count, which is the thing that would
// queue — a position that does not move would also pass for a frozen server.
if (sawEnded) {
  const before = (await dbg()).inputsSent ?? null
  if (before === null) {
    console.log('    (inputsSent not exposed — input-stop asserted via held keys only)')
  }
  await page.keyboard.down('d')
  await sleep(1200)
  await page.keyboard.up('d')
  const after = (await dbg()).inputsSent ?? null
  if (before !== null && after !== null) {
    if (after > before) fail(`still sending input at \`ended\`: ${before} -> ${after}`)
    else ok(`input stopped (${before} -> ${after} while holding a key)`)
  }
}

// --- the buttons exist and are reachable ----------------------------------
if (sawEnded) {
  const buttons = await page.evaluate(() => ({
    again: document.querySelector('.results-again')?.textContent ?? null,
    exit: document.querySelector('.results-exit')?.textContent ?? null,
  }))
  if (!buttons.again || !buttons.exit) {
    fail(`missing buttons: ${JSON.stringify(buttons)}`)
  } else {
    ok(`buttons: "${buttons.again}" / "${buttons.exit}"`)
  }

  // Voting must change the button, or a player cannot tell it registered.
  await page.click('.results-again')
  await sleep(200)
  const after = await page.evaluate(
    () => document.querySelector('.results-again')?.textContent ?? '',
  )
  if (after === buttons.again) fail('voting did not change the button')
  else ok(`voting registers ("${buttons.again}" -> "${after}")`)
}

if (pageErrors.length) fail(`page errors: ${pageErrors.slice(0, 3).join(' | ')}`)

await stack.close()
console.log(failed ? '\nround-end: FAILED' : '\nround-end: ok')
process.exit(failed ? 1 : 0)
