#!/usr/bin/env node
/**
 * T22.06 — the space backdrop in a **real** match, where `space-sky` (the sandbox)
 * cannot reach:
 *
 * - **The seed off the wire.** A networked client's `core.meta.seed` is the startup
 *   map's (measured as 1 across four rounds, 2026-09-16); `terrain-seed` runs in the
 *   sandbox, where `meta.seed` is real, so it could never catch a sky seeded from it.
 *   Here the sky's seed is compared with `welcome`'s — `debug().roundSeed`, the wire
 *   string — and with the server's `FIXED_SEED`, which is not 1.
 * - **No night in orbit, end to end.** Both stacks start their clock at the ground's
 *   night (`DEV_ROUND_CLOCK`). In space the server's darkness byte is 0
 *   (`World::darkness`) **and** the frame is drawn at 0 (`sceneDarkness`) — the byte
 *   alone would not do, because the client reads a 0 byte as "none yet" and falls back
 *   to its own clock. The standard stack at the same moment is the presence control:
 *   byte and frame both dark.
 * - **The ground sky is off and the space sky is up**, in `GameScene`; the bodies move
 *   as the round's clock advances, which is waited on as the clock itself.
 *
 * The pixels of the backdrop are `space-sky`'s: `GameScene` has no hide-a-body seam, and
 * the same `SkyLayer` draws both scenes. This check photographs both matches for a
 * person to look at; it does not compare their brightness, because the two maps are
 * different rock under different skies and that comparison would be a coin flip.
 */
import { startStack, freePort, tally, shotsDir, drawnFrames, soloMatch } from './harness.mjs'
import { deadlineMs } from '../lib/deadline.mjs'
import { join } from 'node:path'

const { fail, ok, finish } = tally('space-sky-match')
const SEED = '4242'
/** The ground's night: u 0.75 of the 120 s cycle (`sky-math.ts::darknessAt`). */
const NIGHT_CLOCK_S = 90
/** Round seconds the space sky is watched across, as the clock advances. */
const WATCH_S = 2
const SETTLE_FRAMES = 6

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

/** `harness.mjs::soloMatch`, then settled a few drawn frames. */
async function solo(stack, name, gravity) {
  const r = await soloMatch(stack, name, gravity)
  await frames(r.page, SETTLE_FRAMES)
  return r
}

const env = { BOT_COUNT: '0', FIXED_SEED: SEED, WEATHER: 'off', DEV_ROUND_CLOCK: String(NIGHT_CLOCK_S) }
const stackA = await startStack({ port: await freePort(), label: 'space-sky-match-space', env })
try {
  const { page, errors } = await solo(stackA, 'ana', 'Space')
  const d = await dbg(page)
  const sky = d.sky?.space
  if (!sky) fail(`the space sky is not up in a space match: ${JSON.stringify(d.sky)}`)
  else {
    const wire = Number(BigInt(d.roundSeed) & 0xffffffffn) | 0
    if (d.roundSeed !== SEED) fail(`welcome carried seed "${d.roundSeed}", the server was set to ${SEED}`)
    else if (sky.seed !== wire) fail(`the space sky is seeded ${sky.seed}, the wire seed is ${d.roundSeed}`)
    else ok(`the space sky is seeded off the wire: ${sky.seed} = welcome's ${d.roundSeed}`)
    if (!(sky.starsDrawn > 0) || !sky.earth.visible || !sky.sun.visible || !sky.moon.visible) {
      fail(`the space sky drew nothing: ${JSON.stringify({ stars: sky.starsDrawn, earth: sky.earth.visible, sun: sky.sun.visible, moon: sky.moon.visible })}`)
    } else ok(`stars ${sky.starsDrawn}, sun, earth and moon up`)
  }
  if (d.darkness !== 0) fail(`the server sent darkness ${d.darkness} in space at round time ${d.roundTime}`)
  else if (d.drawnDarkness !== 0) fail(`the frame was drawn at darkness ${d.drawnDarkness} in space`)
  else ok(`at round time ${d.roundTime.toFixed(1)} (the ground's night): darkness byte 0, drawn 0`)
  const par = d.sky?.parallax
  if (!par?.suppressed || par.ridgeVisible || par.cloudsDrawn !== 0) {
    fail(`the ground's sky band is up in a space match: ${JSON.stringify({ s: par?.suppressed, ridge: par?.ridgeVisible, clouds: par?.cloudsDrawn })}`)
  } else ok('no ridge and no clouds in the space match')

  // The bodies move as the round's clock does — waited on as the clock, not a sleep.
  if (sky) {
    const c0 = sky.clock
    const moved = await page
      .waitForFunction((c) => (window.__game.debug().sky?.space?.clock ?? 0) >= c, c0 + WATCH_S, {
        timeout: deadlineMs(WATCH_S + 20, 'the round clock advancing'),
        polling: 'raf',
      })
      .then(() => true)
      .catch(() => false)
    const s1 = (await dbg(page)).sky?.space
    if (!moved || !s1) fail(`the round clock never advanced ${WATCH_S} s from ${c0}`)
    else {
      const dist = (p, q) => Math.hypot(q.x - p.x, q.y - p.y)
      const de = dist(sky.earth, s1.earth)
      const dm = dist(sky.moon, s1.moon)
      if (!(de > 0) || !(dm > 0)) fail(`over ${(s1.clock - c0).toFixed(1)} s the earth moved ${de} and the moon ${dm} camera px`)
      else ok(`over ${(s1.clock - c0).toFixed(1)} round s: earth ${de.toFixed(2)}, moon ${dm.toFixed(2)} camera px`)
    }
  }
  await page.screenshot({ path: join(shotsDir, 'space-sky-match.png') })
  if (errors.length) fail(`page errors: ${errors.join(' | ')}`)
} catch (e) {
  fail(`space stack: ${e?.stack ?? e}`)
} finally {
  await stackA.close()
}

// The presence control: standard gravity, the same seed, the same clock.
const stackB = await startStack({ port: await freePort(), label: 'space-sky-match-standard', env })
try {
  const { page, errors } = await solo(stackB, 'ana', 'Standard')
  const d = await dbg(page)
  if (d.sky?.space !== null) fail('the space sky is up in a standard match')
  if (!(d.darkness > 0) || !(d.drawnDarkness > 0)) {
    fail(`control: the standard match at round time ${d.roundTime} is not dark: byte ${d.darkness}, drawn ${d.drawnDarkness}`)
  } else ok(`control: standard at ${d.roundTime.toFixed(1)} s — darkness byte ${d.darkness.toFixed(2)}, drawn ${d.drawnDarkness.toFixed(2)}`)
  if (d.sky?.parallax?.suppressed !== false) fail('control: the standard match has its sky band suppressed')
  await page.screenshot({ path: join(shotsDir, 'space-sky-match-standard-night.png') })
  if (errors.length) fail(`page errors: ${errors.join(' | ')}`)
} catch (e) {
  fail(`standard stack: ${e?.stack ?? e}`)
} finally {
  await stackB.close()
}

await finish()
