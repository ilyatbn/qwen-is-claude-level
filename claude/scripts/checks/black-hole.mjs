#!/usr/bin/env node
/**
 * T22.12B — the black hole in a **real** match, on the wire and on screen.
 *
 *   node scripts/checks/black-hole.mjs
 *
 * One human alone in a private Space room on a `DEV_PROBE=1` server (`breach-vortex`'s
 * route). `debug_black_hole` brings the hole now through the same arrival the round's
 * roll uses (`World::summon_black_hole_near` — the carve, the event, the list), and
 * with `dist` puts the player at rest that far from it on a clear side. Then:
 *
 * 1. **both ends agree**: the client's hole is where the server put it; the rock it ate
 *    is gone from the client core's asteroid list (the list the prediction sums) and
 *    the count matches the server's; a mask checksum taken after the arrival agrees;
 * 2. **no rubber-band while pulled**: placed idle at `0.9 × BLACK_HOLE_REACH`, from
 *    the placement until the horizon takes the player — the prediction's error at each
 *    acked input (`lastAckErrorPx`) and every correction's jump (`lastJumpPx`) stay
 *    within `RECONCILE_EPSILON_PX`. A client not told the hole predicts no pull while
 *    the server pulls, and every correction is the pull it missed. Controls: the
 *    body travelled, and snapshots were acked while it did;
 * 3. **the death is named at both ends**: cause `black_hole`, nobody credited; the
 *    overlay reads the black-hole sentence and the kill feed line has no `?` (R20),
 *    and the overlay's patch changed on the rendered frame against idle frames;
 * 4. **you cannot escape** (the inverse of T22.11's guard, on the wire): after the
 *    respawn — which is outside `BLACK_HOLE_REACH` — placed at `0.9 × CAPTURE_R`
 *    holding the thrust that points away, the player dies of it anyway;
 * 5. **coverage in both of GameScene's render paths**: the accretion ring painted in
 *    its own colour and the disc black, against the same frozen instant with the layer
 *    hidden, plus a control point clear of the glow (§C2). Screenshots in the shots dir;
 * 6. **frozen at the bell** (R8.4): after `Ended` it is still drawn, and a player put
 *    inside the horizon is not killed.
 *
 * Arrival *timing* across seeds is Rust's (`black_hole::tests`): a browser round long
 * enough to see a natural arrival costs a minute per run for no new claim.
 */
import { startStack, freePort, tally, shotsDir } from './harness.mjs'
import { key as clientKey } from '../lib/client-keys.mjs'
import { deadlineMs } from '../lib/deadline.mjs'
import { comparePhotos, photo, toScreen, samplePatch, colourDelta } from './pixels.mjs'
import { join } from 'node:path'

const { fail, ok, finish } = tally('black-hole')
const NAME_KEY = clientKey('NAME_KEY')
const WARMUP_S = 3
/** Long enough for every arm before the bell; the natural arrival is replaced by the probe's. */
const ROUND_S = 70
const SETTLE_FRAMES = 6
const RING_PROBES = 24
/** Per channel, how far a ring probe may be from the ring's colour (antialiasing). */
const RING_TOLERANCE = 12
const RING_COLOUR_SHARE = 0.8
const MIN_ON_SCREEN = 0.5
/** A disc probe is black if no channel exceeds this. */
const DISC_MAX = 10
/** How long the pull may take to deliver the placed player to the horizon, s. */
const PULL_BUDGET_S = 10
const FRAME_BUDGET_MS = 20_000
/** The overlay's patch (`void.mjs`'s): it dims the whole centre when up. */
const OVERLAY = { x: 440, y: 250, w: 400, h: 220 }

async function frames(page, n) {
  const drawn = await page.evaluate(
    ([count, cap]) =>
      new Promise((resolve) => {
        let left = count
        const timer = setTimeout(() => resolve(count - left), cap)
        const tick = () => {
          if (--left <= 0) {
            clearTimeout(timer)
            resolve(count)
          } else requestAnimationFrame(tick)
        }
        requestAnimationFrame(tick)
      }),
    [n, FRAME_BUDGET_MS],
  )
  if (drawn < n) throw new Error(`the page drew ${drawn} of ${n} frames in ${FRAME_BUDGET_MS} ms — it stopped rendering`)
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/** One human alone in a private room set to Space — `breach-vortex`'s route. */
async function soloSpace(stack, name) {
  const ctx = await stack.browser.newContext({ viewport: { width: 1280, height: 720 } })
  const page = await ctx.newPage()
  const errors = []
  page.on('pageerror', (e) => errors.push(String(e)))
  await page.goto(`${stack.viteUrl}/?e2e=1&menu=1&name=${name}`)
  await page.waitForFunction('!!window.__menu', null, { timeout: 60_000 })
  await page.evaluate((k) => localStorage.setItem(k[0], k[1]), [NAME_KEY, name])
  await page.evaluate(() => document.querySelector('#private')?.click())
  await page.evaluate(() => document.querySelector('#host')?.click())
  await page.waitForFunction('window.__menu.visibleCode().length === 6', null, { timeout: 30_000 })
  const seen = () => page.evaluate(() => window.__menu.settings().gravity.value)
  for (let i = 0; i < 3 && (await seen()) !== 'Space'; i++) {
    const was = await seen()
    await page.evaluate(() => window.__menu.step('gravity', 1))
    await page.waitForFunction((v) => window.__menu.settings().gravity.value !== v, was, { timeout: 10_000 }).catch(() => {})
  }
  if ((await seen()) !== 'Space') throw new Error(`gravity never reached Space: "${await seen()}"`)
  await page.evaluate(() => window.__menu.ready(true))
  await page.waitForFunction('window.__game && window.__game.debug().ready === true', null, { timeout: 60_000 })
  return { page, errors }
}

/** Ask for the hole (and a placement); resolves with the server's answer. */
async function probe(page, dist) {
  await page.evaluate((d) => window.__game.debugBlackHole(d), dist)
  await page.waitForFunction(() => window.__game.debug().blackHole.lastProbe !== null, null, { timeout: deadlineMs(10, 'debug_black_hole'), polling: 'raf' })
  const p = (await page.evaluate(() => window.__game.debug())).blackHole.lastProbe
  if (!p) throw new Error('debug_black_hole answered null — no space map, no rock, or no clear side')
  return p
}

/**
 * Sample every drawn frame from the moment the prediction has the placed body until the
 * local player dies (or the budget runs out). Each sample carries the predictor's
 * counters, so the caller can read the corrections made while it was pulled.
 *
 * **Started before the probe is sent, and it reads the placement in-page** (T22.10H):
 * it used to start after three Playwright round-trips (the probe's reply, the hole's
 * arrival, a debug read), by which time the pull had already carried the body past
 * `near` on a loaded box — "the prediction never reached the placed body", red 1 of 2
 * at T22.10H's base and 3 of 3 after it in parallel runs (two 4-way, one `--changed` gate), 0 of 1 alone.
 */
function pullSeries(page, near, budgetMs) {
  return page.evaluate(
    ([budget, r]) =>
      new Promise((resolve) => {
        const out = []
        const t0 = performance.now()
        // A page that stops drawing resolves with what it has, and fails below.
        setTimeout(() => resolve({ out, dead: false }), budget + 5000)
        const deaths0 = window.__game.debug().observed.deaths.length
        const tick = () => {
          const d = window.__game.debug()
          const at = d.blackHole.lastProbe?.placed ?? null
          const p = d.player && { x: d.player.x, y: d.player.y }
          const dead = at !== null && d.observed.deaths.length > deaths0
          const atPlace = p && at && Math.hypot(p.x - at.x, p.y - at.y) < r
          if (!dead && (out.length || atPlace)) {
            out.push({ c: d.vortex.corrections, jump: d.vortex.lastJumpPx, ack: d.vortex.lastAckErrorPx, seq: d.vortex.lastAck, tick: d.lastServerTick, p })
          }
          if (dead || performance.now() - t0 > budget) resolve({ out, dead })
          else requestAnimationFrame(tick)
        }
        requestAnimationFrame(tick)
      }),
    [budgetMs, near],
  )
}

/** The ring and disc on the rendered frame, shown against hidden, at one frozen instant. */
async function coverage(page, h, label, wantShader) {
  await page.evaluate(([x, y]) => window.__game.watch(x, y), [h.x, h.y])
  await frames(page, SETTLE_FRAMES)
  await page.evaluate(() => window.__game.freeze(true))
  try {
    await frames(page, 2)
    const fx = (await page.evaluate(() => window.__game.debug())).blackHole.fx
    if (!fx || !fx.drawn) {
      fail(`${label}: the black hole is not drawn: ${JSON.stringify(fx)}`)
      return
    }
    if (fx.shader !== wantShader) fail(`${label}: drawn by the ${fx.shader ? 'shader' : 'flat'} path, asked for ${wantShader ? 'shader' : 'flat'}`)
    if (fx.growth < 1) fail(`${label}: photographed while still swelling in (growth ${fx.growth})`)
    const bounds = await page.evaluate(() => {
      const r = document.querySelector('canvas').getBoundingClientRect()
      return { left: r.left, top: r.top, w: r.width, h: r.height }
    })
    const inView = (s) => s.onScreen && s.y > bounds.top + bounds.h / 6 && s.y < bounds.top + (bounds.h * 5) / 6
    const underDom = (s) => page.evaluate(([x, y]) => document.elementFromPoint(x, y)?.tagName !== 'CANVAS', [s.x, s.y])
    const ringPts = []
    for (let i = 0; i < RING_PROBES; i++) {
      const a = (i / RING_PROBES) * Math.PI * 2
      const s = await toScreen(page, h.x + Math.cos(a) * fx.radii.ring, h.y + Math.sin(a) * fx.radii.ring)
      if (inView(s) && !(await underDom(s))) ringPts.push({ x: s.x, y: s.y })
    }
    const discPts = []
    for (const [dx, dy] of [[0, 0], [0.4, 0], [-0.4, 0], [0, 0.4], [0, -0.4]]) {
      const s = await toScreen(page, h.x + dx * fx.radii.horizon, h.y + dy * fx.radii.horizon)
      if (inView(s) && !(await underDom(s))) discPts.push({ x: s.x, y: s.y })
    }
    let ctrl = null
    for (const a of [0, Math.PI, Math.PI / 2, -Math.PI / 2, Math.PI / 4, (3 * Math.PI) / 4]) {
      const r = fx.radii.reach + 60
      const s = await toScreen(page, h.x + Math.cos(a) * r, h.y + Math.sin(a) * r)
      if (inView(s) && !(await underDom(s))) {
        ctrl = s
        break
      }
    }
    const on = await photo(page)
    await page.screenshot({ path: join(shotsDir, `black-hole-${label}.png`) })
    await page.evaluate(() => window.__game.showBlackHole(false))
    await frames(page, 2)
    const off = await photo(page)
    await page.screenshot({ path: join(shotsDir, `black-hole-${label}-hidden.png`) })
    await page.evaluate(() => window.__game.showBlackHole(true))
    const pts = [...ringPts, ...discPts, ...(ctrl ? [{ x: ctrl.x, y: ctrl.y }] : [])]
    const cmp = await comparePhotos(page, on, off, { points: pts })
    const ringDetail = cmp.detail.slice(0, ringPts.length)
    const inRing = ringDetail.filter((q) => q.a.every((c, i) => Math.abs(c - fx.ringRgb[i]) <= RING_TOLERANCE)).length
    if (ringPts.length < RING_PROBES * MIN_ON_SCREEN) fail(`${label}: only ${ringPts.length} of ${RING_PROBES} ring points in view — coverage would mean nothing`)
    else if (inRing < ringPts.length * RING_COLOUR_SHARE) fail(`${label}: only ${inRing} of ${ringPts.length} accretion-ring points are the ring's colour ${JSON.stringify(fx.ringRgb)}: ${JSON.stringify(ringDetail.slice(0, 4))}`)
    else ok(`${label}: ${inRing}/${ringPts.length} accretion-ring points in the ring's own colour where the hole is (${fx.shader ? 'shader' : 'flat'})`)
    const discDetail = cmp.detail.slice(ringPts.length, ringPts.length + discPts.length)
    const black = discDetail.filter((q) => q.a.every((c) => c <= DISC_MAX)).length
    if (discPts.length < 3) fail(`${label}: only ${discPts.length} disc points in view`)
    else if (black < discPts.length) fail(`${label}: only ${black} of ${discPts.length} disc points are black: ${JSON.stringify(discDetail.map((q) => q.a))}`)
    else ok(`${label}: the horizon is a black disc (${black}/${discPts.length} probes ≤ ${DISC_MAX} per channel)`)
    if (!ctrl) fail(`${label}: no point in view clear of the hole for the control`)
    else if (cmp.points[pts.length - 1]) fail(`${label}: control — a point clear of the hole changed too: ${JSON.stringify(cmp.detail[pts.length - 1])}`)
    else ok(`${label}: control — a point clear of the hole did not change`)
  } finally {
    await page.evaluate(() => window.__game.freeze(false))
  }
}

const stack = await startStack({
  port: await freePort(),
  label: 'black-hole',
  env: { BOT_COUNT: '0', FIXED_SEED: '4242', WEATHER: 'off', DEV_PROBE: '1', DEV_WARMUP_SECONDS: String(WARMUP_S), ROUND_SECONDS: String(ROUND_S) },
})
try {
  const { page, errors } = await soloSpace(stack, 'ana')
  const k = await page.evaluate(() => window.__game.constants())
  const dbg = () => page.evaluate(() => window.__game.debug())
  await page.waitForFunction(() => window.__game.debug().phase === 'playing', null, { timeout: deadlineMs(WARMUP_S + 30, 'the round to start') })
  await frames(page, 30)
  const rocksBefore = (await dbg()).blackHole.asteroids.length
  const overlayIdleA = await samplePatch(page, OVERLAY)
  await frames(page, 10)
  const overlayIdleB = await samplePatch(page, OVERLAY)

  // --- 1. arrival, both ends ----------------------------------------------------------
  // Near the edge of the reach, where the pull starts weak, so the drift in lasts long
  // enough for several snapshots to ack predicted inputs (at 1.6 × capture it measured
  // 5 snapshots in 0.25 s).
  const placeAt = 0.9 * k.BLACK_HOLE_REACH
  const deaths0 = (await dbg()).observed.deaths.length
  // The first probe of the page: `lastProbe` is still null, so the sampler waits for it.
  const pulled = pullSeries(page, k.BLACK_HOLE_CAPTURE_R / 4, PULL_BUDGET_S * 1000)
  const first = await probe(page, placeAt)
  await page.waitForFunction(() => window.__game.debug().blackHole.hole !== null, null, { timeout: deadlineMs(10, 'black_hole'), polling: 'raf' })
  const d1 = await dbg()
  const hole = d1.blackHole.hole
  const checked0 = d1.blackHole.checksums.checksumsChecked
  const off = Math.hypot(hole.x - first.x, hole.y - first.y)
  if (off > 0.5) fail(`the client's hole is ${off.toFixed(1)} px from the server's: ${JSON.stringify({ hole, first })}`)
  else ok(`black_hole put the hole where the server did (${hole.x}, ${hole.y})`)
  const rocks = d1.blackHole.asteroids
  if (rocks.length !== rocksBefore - 1 || rocks.length !== first.asteroids) fail(`asteroid lists disagree: client ${rocksBefore} → ${rocks.length}, server now ${first.asteroids}`)
  else if (rocks.some((a) => a.x === hole.x && a.y === hole.y)) fail('the client core still sums the rock the hole ate')
  else ok(`exactly one rock gone on both sides (${rocksBefore} → ${rocks.length}), and not the client's the hole ate`)
  if (!first.placed) throw new Error(`the server found no clear side ${placeAt} px from the hole: ${JSON.stringify(first)}`)

  // --- 2. no rubber-band while pulled; 3. the named death -----------------------------
  // **The bound is RECONCILE_EPSILON_PX plus the wire's rounding, and why.**
  // A prediction that re-anchored on one snapshot's state is compared at the next ack
  // against another, and each is within half a `SNAPSHOT_QUANTUM` per axis of the
  // server's float (T22.10H: rounded `i32` eighths) — so the two roundings are worth up
  // to √2 · SNAPSHOT_QUANTUM between them. That slack is derived from the constant, never
  // a literal. **History:** before T22.10H positions were `as i16` whole px, truncated,
  // and this slack was a whole √2 px — the truncated re-anchor, stepped beside the exact
  // body in the hole's steep field, drifted 0.43 → 0.81 and 1.07 → 1.64 px before the
  // horizon (Rust, 4 trials); told: 1.45 / 2.31 px at the ack; **untold**
  // (`Core.setBlackHole` planted to null): 5.36 px, 9 corrections up to 14.01 px.
  // **The jump is reported, not bounded**: a correction's jump is the ack error carried
  // through the pending replay at speed, so it has no basis of its own. What separates a
  // told client from an untold one is also **how often** it is corrected: told 0/5, 1/8,
  // 1/9 of the acked snapshots; untold 9/9 — so the arm gates the ack error (basis above)
  // and the correction rate (a third). This is not weakening ε; it is not charging the
  // prediction for the wire's rounding.
  const bound = k.RECONCILE_EPSILON_PX + Math.SQRT2 * k.SNAPSHOT_QUANTUM
  const { out: series, dead } = await pulled
  let worst = 0
  let corrections = 0
  let worstAck = 0
  let acked = 0
  for (let i = 1; i < series.length; i++) {
    if (series[i].c !== series[i - 1].c) {
      corrections++
      worst = Math.max(worst, series[i].jump)
    }
    if (series[i].tick !== series[i - 1].tick && Number.isFinite(series[i].ack)) {
      acked++
      worstAck = Math.max(worstAck, series[i].ack)
    }
  }
  const travelled = series.length > 1 ? Math.hypot(series.at(-1).p.x - series[0].p.x, series.at(-1).p.y - series[0].p.y) : 0
  const secs = series.length > 1 ? (series.at(-1).tick - series[0].tick) / k.SIM_HZ : 0
  const summary = `worst ack error ${worstAck.toFixed(2)} px over ${acked} snapshots, worst correction jump ${worst.toFixed(2)} px over ${corrections} corrections, ${travelled.toFixed(0)} px in ${secs.toFixed(2)} s`
  if (!series.length) fail(`the prediction never reached the placed body ${JSON.stringify(first.placed)}`)
  else if (!dead) fail(`the hole never took the idle player in ${PULL_BUDGET_S} s: ${summary}`)
  else if (travelled < k.BLACK_HOLE_CAPTURE_R / 2) fail(`control: the player moved only ${travelled.toFixed(0)} px before dying — nothing was pulled`)
  else if (acked === 0) fail(`control: no snapshot acked a predicted input during the pull, so the error was never measured`)
  else if (worstAck > bound) fail(`rubber-band while the hole pulled: ${summary} — the ack error is over ${bound.toFixed(2)} px (RECONCILE_EPSILON_PX + √2 · SNAPSHOT_QUANTUM; is the client told the hole?)`)
  else if (corrections * 3 > acked) fail(`rubber-band while the hole pulled: ${summary} — corrected at more than a third of the acked snapshots (is the client told the hole?)`)
  else ok(`no rubber-band while the hole pulled the player in: ${summary} (ack error ≤ ${bound.toFixed(2)} px = RECONCILE_EPSILON_PX + √2 · SNAPSHOT_QUANTUM; corrections ≤ a third of the acks)`)

  await page.waitForFunction(() => window.__game.debug().death.visible, null, { timeout: deadlineMs(6, 'the death overlay') }).catch(() => {})
  const dd = await dbg()
  await page.screenshot({ path: join(shotsDir, 'black-hole-death.png') })
  const mine = dd.observed.deaths.slice(deaths0)
  const e = mine[0]
  if (mine.length === 1 && e.cause === 'black_hole' && e.attacker === null) ok('the server narrated one death, cause "black_hole", nobody credited')
  else fail(`deaths after the arrival: ${JSON.stringify(mine)}`)
  if (!dd.death.visible) fail('no death overlay after the hole took the player')
  else if (/fell into the black hole/i.test(dd.death.cause) && !/killed by/i.test(dd.death.cause)) ok(`the overlay reads "${dd.death.cause}"`)
  else fail(`the overlay reads "${dd.death.cause}", expected the black-hole wording`)
  const feed = await page.evaluate(() => document.querySelector('[data-feel="killfeed"]')?.textContent ?? '')
  if (/fell into the black hole/.test(feed) && !feed.includes('?')) ok(`the kill feed reads "${feed.trim()}"`)
  else fail(`the kill feed reads "${feed.trim()}" — expected the black-hole line with no unknown murderer`)
  const overlayAfter = await samplePatch(page, OVERLAY)
  const idleDelta = colourDelta(overlayIdleA, overlayIdleB)
  const deathDelta = colourDelta(overlayIdleB, overlayAfter)
  if (deathDelta < 8 || deathDelta < idleDelta * 3) fail(`the overlay's patch moved ${deathDelta.toFixed(1)} at death against ${idleDelta.toFixed(1)} idle`)
  else ok(`the rendered frame changed where the overlay is: ${deathDelta.toFixed(1)} at death against ${idleDelta.toFixed(1)} idle`)

  // --- 4. the respawn is clear, and from inside the capture radius you cannot escape ----
  const respawns0 = dd.observed.respawns
  await page.waitForFunction((n) => window.__game.debug().observed.respawns > n && window.__game.debug().death.meAlive, respawns0, { timeout: deadlineMs(k.RESPAWN_DELAY + 10, 'the respawn') })
  await frames(page, 3)
  const back = (await dbg()).player
  const clear = Math.hypot(back.x - hole.x, back.y - hole.y)
  if (clear < k.BLACK_HOLE_REACH - 4) fail(`respawned ${clear.toFixed(0)} px from the hole, inside its reach ${k.BLACK_HOLE_REACH}`)
  else ok(`respawned ${clear.toFixed(0)} px from the hole, outside its reach (${k.BLACK_HOLE_REACH})`)
  const deaths1 = (await dbg()).observed.deaths.length
  const second = await probe(page, 0.9 * k.BLACK_HOLE_CAPTURE_R)
  if (!second.placed) fail(`no clear side ${0.9 * k.BLACK_HOLE_CAPTURE_R} px from the hole`)
  else {
    const dx = second.placed.x - hole.x
    const dy = second.placed.y - hole.y
    const keys = []
    if (Math.abs(dx) > Math.abs(dy) * 0.3) keys.push(dx > 0 ? 'd' : 'a')
    if (Math.abs(dy) > Math.abs(dx) * 0.3) keys.push(dy < 0 ? 'w' : 's')
    for (const key of keys) await page.keyboard.down(key)
    let furthest = 0
    let died = false
    const until = Date.now() + PULL_BUDGET_S * 1000
    try {
      while (Date.now() < until) {
        const d = await dbg()
        if (d.observed.deaths.length > deaths1) {
          died = d.observed.deaths.slice(deaths1).some((x) => x.cause === 'black_hole')
          break
        }
        if (d.player) furthest = Math.max(furthest, Math.hypot(d.player.x - hole.x, d.player.y - hole.y))
        await sleep(50)
      }
    } finally {
      for (const key of keys) await page.keyboard.up(key)
    }
    if (!died) fail(`holding ${keys.join('+')} away from the hole from ${(0.9 * k.BLACK_HOLE_CAPTURE_R).toFixed(0)} px escaped (furthest ${furthest.toFixed(0)} px)`)
    else if (furthest > k.BLACK_HOLE_CAPTURE_R + 4) fail(`died of the hole, but got ${furthest.toFixed(0)} px out alive — past the capture radius ${k.BLACK_HOLE_CAPTURE_R}`)
    else ok(`holding ${keys.join('+')} away from ${(0.9 * k.BLACK_HOLE_CAPTURE_R).toFixed(0)} px did not escape: died of the hole, never past ${furthest.toFixed(0)} px`)
  }
  await page.waitForFunction((n) => window.__game.debug().observed.respawns > n && window.__game.debug().death.meAlive, respawns0 + 1, { timeout: deadlineMs(k.RESPAWN_DELAY + 10, 'the second respawn') }).catch(() => {})

  // --- 5. coverage, flat and shader ---------------------------------------------------
  for (const hq of [false, true]) {
    const path = hq ? 'shader' : 'flat'
    const q = await page.evaluate((x) => window.__game.setHighQuality(x), hq)
    if (q.setting !== hq) {
      fail(`${path}: High Quality would not change: ${JSON.stringify(q)}`)
      continue
    }
    await frames(page, 2)
    await coverage(page, hole, `match-${path}`, hq)
  }
  await page.evaluate(() => window.__game.setHighQuality(false))

  // --- 6. frozen at the bell ----------------------------------------------------------
  await page.waitForFunction(() => window.__game.debug().phase === 'ended', null, { timeout: deadlineMs(ROUND_S + 10, 'the bell') })
  await frames(page, 10)
  const deaths2 = (await dbg()).observed.deaths.length
  const inside = await probe(page, 0.5 * k.BLACK_HOLE_HORIZON_R)
  await frames(page, 60)
  const de = await dbg()
  if (!inside.placed) fail('after the bell: no placement inside the horizon')
  else if (de.observed.deaths.length > deaths2) fail(`after the bell the hole still killed: ${JSON.stringify(de.observed.deaths.slice(deaths2))}`)
  else ok('after the bell a player put inside the horizon is not killed — it is frozen')
  if (!de.blackHole.fx?.drawn || !de.blackHole.hole) fail(`after the bell the hole is not drawn: ${JSON.stringify(de.blackHole.fx)}`)
  else ok('after the bell the hole is still drawn')
  await page.evaluate(([x, y]) => window.__game.watch(x, y), [hole.x, hole.y])
  await frames(page, SETTLE_FRAMES)
  await page.screenshot({ path: join(shotsDir, 'black-hole-ended.png') })
  // The checksum at both ends, taken at some point after the arrival.
  const cs = de.blackHole.checksums
  if (cs.checksumMismatches > 0 || cs.resyncs > 0) fail(`the mask diverged after the carve: ${JSON.stringify(cs)}`)
  else if (cs.checksumsChecked <= checked0) fail(`control: no mask checksum was compared after the arrival (${checked0} → ${cs.checksumsChecked})`)
  else ok(`the mask checksum agreed ${cs.checksumsChecked - checked0} times after the eaten rock was carved, none disagreeing`)
  if (errors.length) fail(`page errors: ${errors.join(' | ')}`)
} catch (e) {
  fail(`${e?.stack ?? e}`)
} finally {
  await stack.close()
}

await finish()
