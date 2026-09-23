#!/usr/bin/env node
/**
 * T21.19 — a dropped crate blinks on the minimap, in a real round.
 *
 *   node scripts/checks/minimap-crates.mjs
 *
 * Asked for: *"Dropped crates have a beacon. They appear as a small red dot on the
 * minimap for half a second, every 3 seconds."* The minimap is a DOM 2D canvas
 * (§A35), so this reads **its own pixels** — not a count of `fillRect` calls, which
 * would pass for a dot drawn off the canvas.
 *
 * ## The controls
 *
 * - **No crate, no dot.** Before the first crate lands, no pixel on the minimap is
 *   the beacon's colour.
 * - **A control frame.** The duty cycle is sampled across more than one whole
 *   period, so the off-window is photographed too: a dot that never blinks passes
 *   "the dot is there" and fails this.
 * - **A control region.** A patch of the minimap far from the crate never shows
 *   the colour, so "the colour is on the canvas" cannot be the whole canvas.
 *
 * Networked, not `?sandbox=1` (the coordinator's ruling): crates are a server
 * event, and the minimap only ever drew players and terrain before this.
 */
import { startStack, enterBattle, tally, sleep, freePort } from './harness.mjs'

const PORT = await freePort()
const ROUND_SECONDS = 160
const { fail, ok, finish } = tally('minimap-crates')

const stack = await startStack({
  port: PORT,
  label: 'minimap-crates',
  env: {
    ROUND_SECONDS: String(ROUND_SECONDS),
    // `crates.mjs`'s map and its reasons: a crate lands in the same place every run.
    FIXED_SEED: '31337',
    // Nobody else to pick the crate up, and no remote-player dots on the minimap.
    BOT_COUNT: '0',
    // No fog veil or rain between the camera and anything — not that the minimap
    // sits under either, but a check should not depend on that.
    WEATHER: 'off',
    LOBBY_BOT_TIMEOUT: '3',
  },
})
const { page, pageErrors } = await stack.openClient({ name: 'ana' })
await enterBattle(page, { waitPlaying: true, label: 'minimap-crates' })

const k = await page.evaluate(() => window.__game.constants())
const beacon = {
  r: (k.MINIMAP_CRATE_COLOUR >> 16) & 0xff,
  g: (k.MINIMAP_CRATE_COLOUR >> 8) & 0xff,
  b: k.MINIMAP_CRATE_COLOUR & 0xff,
}

/**
 * One evaluate, so the round clock, the crate list and the pixels are the same
 * instant: the canvas's beacon-coloured pixels, where they are, and the stats.
 */
const sample = () =>
  page.evaluate(
    ([br, bg, bb]) => {
      const g = window.__game
      const d = g.debug()
      const cv = document.querySelector('[data-minimap="root"] canvas')
      const ctx = cv?.getContext('2d')
      const px = ctx ? ctx.getImageData(0, 0, cv.width, cv.height).data : null
      const hits = []
      if (px) {
        for (let i = 0; i < px.length; i += 4) {
          if (Math.abs(px[i] - br) <= 8 && Math.abs(px[i + 1] - bg) <= 8 && Math.abs(px[i + 2] - bb) <= 8) {
            const n = i / 4
            hits.push([n % cv.width, Math.floor(n / cv.width)])
          }
        }
      }
      const crates = (d.mirrorItems ?? []).filter((i) => i.source === 'Crate')
      return {
        t: d.roundTime ?? 0,
        canvas: cv ? { w: cv.width, h: cv.height } : null,
        map: { w: d.mapW, h: d.mapH },
        stats: g.minimap(),
        crates: crates.map((c) => ({ id: c.id, x: c.x, y: c.y, grounded: c.grounded })),
        hits,
      }
    },
    [beacon.r, beacon.g, beacon.b],
  )

// --- no crate, no dot ------------------------------------------------------------
const dry = await sample()
if (!dry.canvas) fail('there is no minimap canvas to read')
else if (dry.crates.length > 0) fail(`a crate was already on the map at the start: ${JSON.stringify(dry.crates)}`)
else if (dry.hits.length > 0) fail(`${dry.hits.length} beacon-coloured pixels with no crate on the map`)
else ok(`control: no crate, no beacon pixel on the ${dry.canvas.w}x${dry.canvas.h} minimap`)

// --- a crate lands ---------------------------------------------------------------
const landed = await page
  .waitForFunction(
    "(window.__game.debug().mirrorItems ?? []).some((i) => i.source === 'Crate' && i.grounded)",
    null,
    { timeout: (ROUND_SECONDS - 10) * 1000 },
  )
  .then(() => true)
  .catch(() => false)

if (!landed) {
  // No constant read here: `CRATE_INTERVAL` is not in `constants_json`, and a check
  // reading a constant that does not exist is what constants-parity forbids (T20.15).
  fail(`no crate landed in a ${ROUND_SECONDS} s round — nothing to beacon`)
} else {
  // --- the duty cycle, from the canvas's own pixels ------------------------------
  // Sampled across a period and a half, so the off-window is in the sample too.
  const first = await sample()
  const crate = first.crates.find((c) => c.grounded)
  const cellX = (crate.x / first.map.w) * first.canvas.w
  const cellY = (crate.y / first.map.h) * first.canvas.h
  const near = (h) => Math.abs(h[0] - cellX) <= 3 && Math.abs(h[1] - cellY) <= 3
  // The control region: the minimap's diagonally opposite quarter from the crate.
  const farX = cellX < first.canvas.w / 2 ? [first.canvas.w * 0.75, first.canvas.w] : [0, first.canvas.w * 0.25]
  const farY = cellY < first.canvas.h / 2 ? [first.canvas.h * 0.75, first.canvas.h] : [0, first.canvas.h * 0.25]
  const far = (h) => h[0] >= farX[0] && h[0] < farX[1] && h[1] >= farY[0] && h[1] < farY[1]

  const samples = []
  const until = first.t + k.MINIMAP_CRATE_PERIOD * 1.5
  let s = first
  while (s.t < until) {
    samples.push({
      t: s.t,
      lit: s.hits.some(near),
      stray: s.hits.filter((h) => !near(h)).length,
      far: s.hits.some(far),
      stats: s.stats,
      stillThere: s.crates.some((c) => c.id === crate.id),
    })
    await sleep(40)
    s = await sample()
  }
  const lit = samples.filter((x) => x.lit)
  const share = lit.length / samples.length
  const want = k.MINIMAP_CRATE_ON / k.MINIMAP_CRATE_PERIOD
  console.log(
    `  crate ${crate.id} at world (${crate.x.toFixed(0)}, ${crate.y.toFixed(0)}) -> minimap (${cellX.toFixed(1)}, ${cellY.toFixed(1)}); ` +
      `${samples.length} samples over ${(s.t - first.t).toFixed(2)} s, lit in ${lit.length} (share ${share.toFixed(3)}, want ${want.toFixed(3)})`,
  )

  if (!samples.every((x) => x.stillThere)) {
    fail('the crate left the map during the sample — nobody was meant to pick it up')
  }
  if (lit.length === 0) fail('the crate never showed on the minimap across a whole period')
  else ok(`the beacon was drawn at the crate's minimap position (${lit.length} lit samples)`)
  // The control frame: a dot that never blinks passes the line above and fails this.
  if (lit.length === samples.length) fail('the beacon was lit in every sample — it is a marker, not a blink')
  else ok(`control: the beacon was off in ${samples.length - lit.length} samples`)
  // The duty cycle. Sampling is coarse (a page round trip per sample), so the band
  // is wide; what it rules out is "on half the time" and "on for an instant".
  if (!(share > want * 0.4 && share < want * 2.5)) {
    fail(`the beacon was lit ${(share * 100).toFixed(0)}% of the time, want about ${(want * 100).toFixed(0)}% (MINIMAP_CRATE_ON / MINIMAP_CRATE_PERIOD)`)
  } else ok(`duty cycle ${(share * 100).toFixed(0)}% against ${(want * 100).toFixed(0)}% from the constants`)
  // Both ends: the pixels agree with what the minimap says it drew.
  const disagree = samples.filter((x) => x.lit !== (x.stats?.crateDrawn > 0)).length
  if (disagree > samples.length * 0.1) {
    fail(`the canvas and minimap.stats() disagreed about the beacon in ${disagree} of ${samples.length} samples`)
  } else ok(`pixels and minimap.stats() agree (${disagree} of ${samples.length} samples differ)`)
  // The control region.
  if (samples.some((x) => x.far)) fail('beacon-coloured pixels appeared far from the only crate on the map')
  else ok('control: nothing beacon-coloured in the far quarter of the minimap')
  const strays = Math.max(...samples.map((x) => x.stray))
  if (strays > 0) fail(`up to ${strays} beacon-coloured pixels away from the crate`)
}

if (pageErrors.length) fail(`page errors: ${pageErrors.slice(0, 3).join(' | ')}`)
else ok('no page errors')

await finish(() => stack.close())
