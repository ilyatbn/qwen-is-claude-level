#!/usr/bin/env node
/**
 * `look-day-night-match` — T23.11 (R7; T23.04C F5 owed the retired `sky.mjs`'s claim here): **a live match's day and
 * night skies differ.** One human on a match whose clock starts at mid-day (`DEV_ROUND_CLOCK`, `DAY_CLOCK`),
 * standing still. The world canvas is read back (`__world.readFrame`) twice by day, a second apart — the control:
 * the same hour, so whatever differs between them is the frame, not the hour (the moons drift a few px) — and once
 * the server's darkness byte has reached full night. Over the pixels that show sky (air in the mirror's mask), day
 * against night must differ many times more than day against day.
 *
 * **The night view is hidden for every reading** (`__world.hideLayers(['night'])`, T23.10's darkening outside your
 * sight): with it, day and night already differed before this task — F1's sky at every hour, darkened outside the
 * sight circle — so the claim would hold with the palettes' blend deleted. Without it, only the hour's palette and
 * moons can move the sky.
 *
 *   node scripts/checks/look-day-night-match.mjs
 */
import { startStack, enterBattle, freePort, tally, sleep } from './harness.mjs'
import { constants as rustConstants } from '../lib/rust-constants.mjs'

const { fail, ok, finish } = tally('look-day-night-match')
const RC = rustConstants()
const CYCLE = RC.get('DAY_DURATION') + RC.get('NIGHT_DURATION')
/**
 * Mid-day (u 0.25): the clock runs while the terrain loads (measured: a start 10 s before dusk was already dusk by the
 * first day frame), and dusk begins at `cycle.rs::DUSK_START` 0.50 of the cycle (60 s).
 */
const DAY_CLOCK = Math.round(CYCLE * 0.25)
/** Night is whole at `NIGHT_START` 0.62 (74.4 s), ≤ 45 s after the day frames: wait for it, with room. */
const NIGHT_WAIT_MS = 90_000
/**
 * Day against night differs at least this many times day against day, and by at least `ABS_MIN` (0–255 per channel).
 * Measured (seed 4242, low tier): 62.2 and 51.2 on two runs, control 1.6; with the blend planted out (the scene handing
 * `t = 1` at every hour) 7.84 — the moons' motion alone — against a control of 0.08. `ABS_MIN` sits between.
 */
const RATIO_MIN = 10
const ABS_MIN = 20

const stack = await startStack({
  port: await freePort(),
  label: 'look-day-night-match',
  env: { BOT_COUNT: '0', FIXED_SEED: '4242', WEATHER: 'off', ROUND_SECONDS: '600', DEV_ROUND_CLOCK: String(DAY_CLOCK) },
})
try {
  const { page, shot } = await stack.openClient({ name: 'ana' })
  await enterBattle(page, { waitPlaying: true, label: 'look-day-night-match' })
  await page.waitForFunction(() => window.__game.debug().terrainReady === true && !!window.__world?.sky()?.drawn, null, { timeout: 120_000 })
  const K = await page.evaluate(() => window.__game.constants())
  await page.evaluate(() => window.__world.hideLayers(['night']))

  /** The world canvas now, and which of its pixels (every 4th) show sky: air in the mask at their world point. */
  const read = () =>
    page.evaluate(async () => {
      const f = await window.__world.readFrame()
      const c = window.__game.core
      const bin = atob(f.rgba)
      const px = []
      for (let y = 2; y < f.h; y += 4) {
        for (let x = 2; x < f.w; x += 4) {
          const wx = f.view.x + ((x + 0.5) / f.w) * f.view.w
          const wy = f.view.y + ((y + 0.5) / f.h) * f.view.h
          const air = wy < 0 || !c.solidAt(Math.round(wx), Math.round(wy))
          const o = (y * f.w + x) * 4
          px.push([air ? 1 : 0, bin.charCodeAt(o), bin.charCodeAt(o + 1), bin.charCodeAt(o + 2)])
        }
      }
      const d = window.__game.debug()
      return { px, darkness: d.drawnDarkness, hour: window.__world.sky().hour, view: f.view }
    })
  const delta = (a, b) => {
    let s = 0
    let n = 0
    for (let i = 0; i < a.px.length; i++) {
      if (!a.px[i][0] || !b.px[i][0]) continue
      s += (Math.abs(a.px[i][1] - b.px[i][1]) + Math.abs(a.px[i][2] - b.px[i][2]) + Math.abs(a.px[i][3] - b.px[i][3])) / 3
      n++
    }
    return { mean: n ? s / n : NaN, n }
  }

  const day1 = await read()
  await sleep(1000)
  const day2 = await read()
  await shot('look-day-night-match-day')
  if (!(day1.darkness === 0 && day2.darkness === 0)) fail(`the day frames are not day: darkness ${day1.darkness}, ${day2.darkness}`)
  else ok(`day: darkness 0, hour ${JSON.stringify(day1.hour)} then ${JSON.stringify(day2.hour)}`)
  if (JSON.stringify(day1.view) !== JSON.stringify(day2.view)) fail(`the camera moved between the day frames: ${JSON.stringify(day1.view)} → ${JSON.stringify(day2.view)}`)

  // The byte is darkness × 255 truncated (`codec.rs`): full night reads one step under `NIGHT_DARKNESS`.
  await page.waitForFunction((nd) => window.__game.debug().drawnDarkness >= nd, K.NIGHT_DARKNESS - 1 / 255, { timeout: NIGHT_WAIT_MS })
  // A few frames at night so the hour is drawn.
  await sleep(300)
  const night = await read()
  await shot('look-day-night-match-night')
  if (night.hour.t !== 1) fail(`the renderer did not draw night: hour ${JSON.stringify(night.hour)}`)
  else ok(`night: darkness ${night.darkness.toFixed(2)}, hour ${JSON.stringify(night.hour)}`)

  const same = delta(day1, day2)
  const dn = delta(day1, night)
  const needed = Math.max(ABS_MIN, RATIO_MIN * same.mean)
  const line = `sky pixels (${dn.n} sampled): day vs night ${dn.mean.toFixed(2)}, day vs day (same hour, the control) ${same.mean.toFixed(3)} — want ≥ ${needed.toFixed(2)}`
  if (!(dn.n > 100)) fail(`only ${dn.n} sky pixels in the frame — the camera sees no sky`)
  else if (!(dn.mean >= needed)) fail(line)
  else ok(line)
} finally {
  await stack.close()
}
finish()
