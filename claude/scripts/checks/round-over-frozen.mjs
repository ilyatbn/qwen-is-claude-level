#!/usr/bin/env node
/**
 * T21.30 — nobody moves once the round is over.
 *
 *   node scripts/e2e.mjs --jobs 1 --only round-over-frozen
 *
 * Reported from play, 2026-09-15: *"i can still move my character after the
 * 'round over' is displayed."* The server stopped hearing the input when the
 * results screen came up, but the client went on **predicting** it: the local
 * body walked across the screen under the scoreboard and snapped back.
 *
 * ## What is asserted
 *
 * The **rendered** position — `renderPos`, the point `localView.setState` draws
 * the local player at — not the simulation's body, because the bug was a
 * picture: the server's copy of the player never moved.
 *
 * **The control is the same hold during `Playing`**, on the same stack and the
 * same key, and it must move the player. Without it a player who cannot walk at
 * all would pass the subject.
 *
 * A real server on a shortened `ROUND_SECONDS`, for `round-end.mjs`'s reason:
 * there is no sandbox path to `Ended`, and the phase machine is the subject.
 */
import { startStack, enterBattle, tally, sleep, freePort } from './harness.mjs'

const PORT = await freePort()
/** Playing half only; warmup is not shortened. Long enough for the control. */
const ROUND_SECONDS = 20
/** How far a one-second hold must carry the rendered player in `Playing`. */
const MOVED_PX = 20
/** Rendering eases toward the body; this much drift is not walking. */
const STILL_PX = 2

const t = tally('round-over-frozen')
let failed = false
const fail = (m) => {
  t.fail(m)
  failed = true
}

const stack = await startStack({
  port: PORT,
  label: 'round-over-frozen',
  env: { ROUND_SECONDS: String(ROUND_SECONDS), BOT_COUNT: '2' },
})
const { page, dbg, shot, pageErrors } = await stack.openClient({ name: 'ana' })
await enterBattle(page, { label: 'round-over-frozen', waitPlaying: true })

const rendered = async () => {
  const d = await dbg()
  return { phase: d.phase, x: d.renderPos?.x ?? NaN, y: d.renderPos?.y ?? NaN }
}

/** Wait until the rendered body stops moving, so a hold is measured from rest. */
const settle = async () => {
  let last = await rendered()
  for (let i = 0; i < 40; i++) {
    await sleep(150)
    const now = await rendered()
    if (Math.hypot(now.x - last.x, now.y - last.y) < 0.5) return now
    last = now
  }
  return last
}

/** Hold `key` for `ms` of wall and report how far the rendered player went. */
const holdAndMeasure = async (key, ms) => {
  const before = await settle()
  await page.keyboard.down(key)
  await sleep(ms)
  await page.keyboard.up(key)
  await sleep(400)
  const after = await rendered()
  return { before, after, dx: after.x - before.x, dy: after.y - before.y }
}

// --- the control: the hold moves you in `Playing` -----------------------------
let control = await holdAndMeasure('d', 1000)
if (control.before.phase !== 'playing' || control.after.phase !== 'playing') {
  fail(`the control did not run inside \`playing\` (${control.before.phase} -> ${control.after.phase})`)
} else {
  // A wall to the right is a spawn property, not a bug: try the other way once.
  if (Math.abs(control.dx) < MOVED_PX) control = await holdAndMeasure('a', 1000)
  if (Math.abs(control.dx) < MOVED_PX) {
    fail(`holding a direction in \`playing\` moved the player ${control.dx.toFixed(1)} px — the control is dead`)
  } else {
    t.ok(`the control: a one-second hold in \`playing\` moved the player ${control.dx.toFixed(1)} px`)
  }
}
await shot('round-over-frozen-playing')

// --- the subject: the same hold after "Round over" ----------------------------
let sawEnded = false
for (let i = 0; i < 400 && !sawEnded; i++) {
  if ((await dbg()).phase === 'ended') sawEnded = true
  else await sleep(250)
}
if (!sawEnded) {
  fail(`the round never reached \`ended\` in ${ROUND_SECONDS}s`)
} else {
  const screenUp = await page.evaluate(() => !!document.querySelector('.results-screen'))
  if (!screenUp) fail('no results screen at `ended` — this is not the moment the owner reported')
  for (const key of ['d', 'a']) {
    const r = await holdAndMeasure(key, 1000)
    if (r.after.phase !== 'ended') {
      fail(`the round left \`ended\` during the ${key} hold — nothing measured`)
      continue
    }
    if (Math.abs(r.dx) > STILL_PX) {
      fail(
        `holding ${key} after "Round over" moved the rendered player ${r.dx.toFixed(1)} px ` +
          `(${r.before.x.toFixed(1)} -> ${r.after.x.toFixed(1)}) — this is the bug`,
      )
    } else {
      t.ok(`holding ${key} after "Round over" moved the rendered player ${r.dx.toFixed(2)} px`)
    }
  }
  await shot('round-over-frozen-ended')
}

if (pageErrors.length) fail(`page errors: ${pageErrors.slice(0, 3).join(' | ')}`)
await stack.close()
console.log(failed ? '\nround-over-frozen: FAILED' : '\nround-over-frozen: ok')
process.exit(failed ? 1 : 0)
