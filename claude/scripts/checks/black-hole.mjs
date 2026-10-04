#!/usr/bin/env node
/**
 * T22.12B — the black hole in a **real** match, on the wire and on screen.
 *
 *   node scripts/checks/black-hole.mjs
 *
 * One human alone in a private Space room on a `DEV_PROBE=1` server (`breach-vortex`'s
 * route). `debug_black_hole` brings the hole through the same arrival the round's roll
 * uses (`World::summon_black_hole_near` / `warn_black_hole_near` — the telegraph, the
 * carve, the event, the list), and with `dist` puts the player at rest that far from it
 * on a clear side. Then:
 *
 * 0. **the telegraph** (T22.12C, R93): asked with `warn`, the spot is announced first —
 *    a solid ring in the telegraph's own colour at the horizon where it will open, on
 *    the rendered frame against the same instant hidden, plus a control point — and the
 *    hole then opens exactly there;
 * 1. **both ends agree**: the client's hole is where the server put it; the rock it ate
 *    is gone from the client core's asteroid list (the list the prediction sums) and
 *    the count matches the server's; a mask checksum taken after the arrival agrees;
 *    and it is **on the minimap** (R93): the marker in the ring's colour, which goes
 *    when the layer is hidden;
 * 2. **no rubber-band while pulled**: placed idle at `0.9 × BLACK_HOLE_REACH`, from
 *    the placement until the horizon takes the player — the prediction's error at each
 *    acked input (`lastAckErrorPx`) within `RECONCILE_EPSILON_PX` + the wire's rounding,
 *    and corrections at no more than a third of the acks. A client not told the hole
 *    predicts no pull while the server pulls (F7: planted, red). Controls: the body
 *    travelled, and snapshots were acked while it did;
 * 3. **the death is named at both ends**: cause `black_hole`, nobody credited; the
 *    overlay reads the black-hole sentence and the kill feed line has no `?` (R20),
 *    and the overlay's patch changed on the rendered frame against idle frames; the
 *    respawn is outside `BLACK_HOLE_REACH`. (T22.12B's "cannot escape from inside the
 *    capture radius" arm is gone with the capture radius, R90: the horizon is the rule,
 *    and escape from just outside it is Rust's, over 208 flights);
 * 5. **coverage in both of GameScene's render paths**: the accretion ring painted in
 *    its own colour and the disc black, against the same frozen instant with the layer
 *    hidden, plus a control point clear of the glow (§C2). Screenshots in the shots dir;
 * 5a. **the reach ring** (T22.18B F4), both paths: the camera on the ring's arc, probes
 *    on it are the frame hidden mixed with the ring's colour at the ring's alpha (a faint
 *    ring, and exactly that one), and probes a ring-width-and-more inside and outside it
 *    did not change (the control). On the minimap (arm 1) the marker carries a circle of
 *    the reach's radius, gone with the layer hidden (control: 3 px outside it unchanged);
 * 5b. **the bell for a body in the pull** (T22.12D F1): placed at `BELL_PLACE × REACH`
 *    `BELL_LEAD_S` before the round's `ends_tick`, what the page had predicted for its
 *    body when it heard the bell, against the server's state at that tick
 *    (`bellErrorPx`, keyed by tick — the anchoring correction's jump is not a
 *    like-for-like number), is within the ack bound: `Core.setBell` stopped the pull on
 *    the server's `Ended` tick. Deleting the `setBell` call in
 *    `GameScene.onSnapshot` is red here (planted). Controls: alive at the bell, and pulled;
 * 6. **frozen at the bell** (R8.4, F9): after `Ended` it is still drawn, a player put at
 *    rest in its reach is **not pulled** (against arm 2's travel as the control), and a
 *    player put inside the horizon is not killed.
 *
 * Arrival *timing* across seeds is Rust's (`black_hole::tests`): a browser round long
 * enough to see a natural arrival costs a minute per run for no new claim.
 */
import { startStack, freePort, tally, shotsDir, drawnFrames, soloSpace } from './harness.mjs'
import { deadlineMs } from '../lib/deadline.mjs'
import { comparePhotos, photo, toScreen, samplePatch, colourDelta } from './pixels.mjs'
import { join } from 'node:path'

/** `n` drawn frames, or a throw naming a page that stopped rendering — the harness's one copy (T22.00C). */
const frames = (page, n) => drawnFrames(page, n)
const { fail, ok, finish } = tally('black-hole')
const WARMUP_S = 3
/**
 * Long enough for every arm before the bell; the natural arrival is replaced by the probe's. *T23.20 part C: 70 → 90* —
 * with the swirl legs (2 × 700 ms + photos) the arms ran past the bell's lead by ~1.5 s on one run of three at 70
 * (server tick 4905 against the bell's 4817), green on the others: a margin, not a cause.
 */
const ROUND_S = 90
const SETTLE_FRAMES = 6
const RING_PROBES = 24
/** Per channel, how far a ring probe may be from the ring's colour (antialiasing). */
const RING_TOLERANCE = 12
const RING_COLOUR_SHARE = 0.8
/**
 * T23.20 part C: the world renderer's hole (the owner's look) goes through the HDR post — tone map, bloom, grade — so
 * its ring band is not `ringRgb` to 12 any more; it is the lensed disc's light, white-gold. A ring probe is then
 * **lit and warm**: mean channel ≥ `RING_LIT_MIN`, red over blue by `RING_WARM_MIN`, and changed against the hidden
 * frame. Measured on the owner's GPU: mean 132–247, red − blue 44–134; the space sky it replaces reads ~20–40.
 */
const RING_LIT_MIN = 100
const RING_WARM_MIN = 25
/** The disc animates: of `SWIRL_PROBES` points on the disc, at least `SWIRL_MIN_SHARE` change across `SWIRL_MS`. */
const SWIRL_PROBES = 16
const SWIRL_MIN_SHARE = 0.25
const SWIRL_MS = 700
const MIN_ON_SCREEN = 0.5
/** A disc probe is black if no channel exceeds this. */
const DISC_MAX = 10
/** How long the pull may take to deliver the placed player to the horizon, s. */
const PULL_BUDGET_S = 10
/**
 * Arm 5b: where, as a fraction of the reach, and how long before the bell the body is
 * placed. **Not the review's ~0.5 s** — computed (a stepped fall from 0.97 × reach,
 * the hole's linear pull): 0.5 s in, the pull is 52 px/s², so a prediction that kept
 * pulling for the few ticks until the page hears `ended` would be ~0.2 px off, under the
 * bound, and the arm could not fail. At 1.6 s it is ~430 px/s², and the body reaches
 * the horizon at 1.9 s — 0.3 s after the bell (the probe's latency only shortens the
 * lead). The placement `game-wasm`'s `the_bell_seq_stops_the_pull_on_the_servers_ended_tick`
 * uses (2.22 px off there without the bell seq, 0.000 with it).
 *
 * **T22.18 (R106): 0.865, re-derived for the doubled reach.** Under the linear law the
 * distance inside the reach grows as `x0 · cosh(t · √(ACCEL_MAX / REACH))`; at 256 /
 * 1080 that rate is 2.05 /s and 0.97 did the above, but at 512 / 925.7 it is 1.35 /s and
 * a body from 0.97 × reach had moved 52 px at the bell (red: the control wants a quarter
 * of the way in). From 0.865 × reach (443 px) the body reaches the horizon at 1.9 s
 * again, has moved ~230 px by 1.6 s, and is pulled ~540 px/s² there.
 *
 * **T22.20 (R109): 0.73, re-derived for the halved pull.** The space thrust was halved and
 * the hole's pull with it (R90 is stated against the space thrust), so the rate is
 * √(462.9 / 512) = 0.95 /s: from 0.865 the law gives ~97 px moved by 1.6 s, on the
 * control's quarter-of-the-way line, and the Rust twin's control measured 0.83 px. From
 * 0.73 × reach (374 px) the law gives the horizon at ~1.95 s and ~190 px moved by 1.6 s —
 * the pull at the start is what 0.865 had at T22.18 (computed, not measured here).
 */
const BELL_PLACE = 0.73
const BELL_LEAD_S = 1.6
/**
 * Arm 5b hears the server this late (`__game.netDelay`): on localhost the page hears the
 * bell within a tick or two, and a prediction that kept pulling for that long is ~0.3 px
 * off — measured with `setBell` deleted, under the bound, so the arm could not fail. At
 * 100 ms (`game-wasm`'s bell test's `HEARD_AFTER`, 6 ticks) the plant read 2.50 px against
 * the 2.18 px bound — too thin a margin to gate on; 150 ms, a common real latency, is
 * the value used.
 */
const BELL_HEAR_LATE_MS = 150
/** The overlay's patch (`void.mjs`'s): it dims the whole centre when up. */
const OVERLAY = { x: 440, y: 250, w: 400, h: 220 }

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/**
 * 4. **The hole swallows everything** (T23.38, the owner: *"there shouldn't be anything on top of it"*). `litter` has the
 * server put an item, a crate, a grave and a mine at rest `LITTER_AT` × reach from the hole on a clear bearing. Then, on
 * every drawn frame until they are gone: the loose things the page draws inside the horizon — **none, on any frame** —
 * and the four themselves, which must be seen (the presence: drawn inside the reach, then nearer the hole) and then gone,
 * with a `swallowed` heard for each — counted at both ends: `LITTER_N` placed by the server, as many drawn, gone and
 * heard swallowed. Then the streak on pixels: one swallow pinned `SWALLOW_K` of the way in on a frozen frame, against
 * the same instant without it — its centre changed and lit; a point across the shadow did not change (the control).
 */
const LITTER_AT = 0.5
const LITTER_N = 4
const SWALLOW_K = 0.3
/** A pinned streak's centre reads lit if its mean channel is over this (the shadow under it is ≤ `DISC_MAX`). */
const STREAK_LIT_MIN = 3 * DISC_MAX

async function swallowArm(page, hole, k) {
  await page.evaluate(([x, y]) => window.__game.watch(x, y), [hole.x, hole.y])
  await frames(page, SETTLE_FRAMES)
  const seen0 = (await page.evaluate(() => window.__game.debug())).blackHole.swallowedSeen
  const run = page.evaluate(
    ([h, R, reach, n, budget]) =>
      new Promise((resolve) => {
        const t0 = performance.now()
        const things = new Map()
        let worstInside = 0
        let insideAt = null
        let frames = 0
        let streaks = 0
        const tick = () => {
          const d = window.__game.debug().blackHole
          frames++
          const inside = d.loose.filter((o) => Math.hypot(o.x - h.x, o.y - h.y) < R)
          if (inside.length > worstInside) {
            worstInside = inside.length
            insideAt = inside
          }
          const present = new Set()
          for (const o of d.loose) {
            const key = `${o.kind}:${o.id}`
            present.add(key)
            const dist = Math.hypot(o.x - h.x, o.y - h.y)
            const v = things.get(key)
            if (v) v.last = dist
            else if (d.lastProbe?.littered && dist < reach) things.set(key, { kind: o.kind, first: dist, last: dist, gone: false })
          }
          for (const [key, v] of things) v.gone = !present.has(key)
          streaks = Math.max(streaks, window.__world?.blackHole()?.swallowing ?? 0)
          const done = things.size >= n && [...things.values()].every((v) => v.gone)
          if (done || performance.now() - t0 > budget) resolve({ things: [...things.values()], worstInside, insideAt, frames, streaks, world: !!window.__world?.blackHole() })
          else requestAnimationFrame(tick)
        }
        requestAnimationFrame(tick)
      }),
    [hole, k.BLACK_HOLE_HORIZON_R, k.BLACK_HOLE_REACH, LITTER_N, deadlineMs(10, 'the litter to go in')],
  )
  const lp = await probe(page, undefined, false, LITTER_AT * k.BLACK_HOLE_REACH)
  const r = await run
  const seen = (await page.evaluate(() => window.__game.debug())).blackHole.swallowedSeen - seen0
  const kinds = r.things.map((v) => v.kind).sort().join(', ')
  const runIn = LITTER_AT * k.BLACK_HOLE_REACH - k.BLACK_HOLE_HORIZON_R
  if (!lp.littered) fail(`swallow: the server found no clear bearing for the litter: ${JSON.stringify(lp)}`)
  else if (r.things.length < LITTER_N) fail(`swallow: the page drew ${r.things.length} of the ${LITTER_N} littered things inside the reach (${kinds})`)
  else if (!r.things.every((v) => v.gone)) fail(`swallow: not all went in: ${JSON.stringify(r.things)}`)
  else if (!r.things.every((v) => v.first - v.last >= runIn / 2)) fail(`swallow: control — something vanished without being drawn moving in: ${JSON.stringify(r.things)}`)
  else ok(`swallow: all ${LITTER_N} littered things (${kinds}) drawn inside the reach, drawn moving in, then gone`)
  if (seen < LITTER_N) fail(`swallow: ${seen} \`swallowed\` heard for ${LITTER_N} things the server placed and the page saw go`)
  else ok(`swallow: ${seen} \`swallowed\` heard for the ${LITTER_N} placed (both ends)`)
  if (r.worstInside > 0) fail(`swallow: ${r.worstInside} loose thing(s) drawn inside the horizon: ${JSON.stringify(r.insideAt)}`)
  else ok(`swallow: nothing drawn inside the horizon on any of ${r.frames} frames`)
  if (r.world && r.streaks < 1) fail('swallow: the world renderer never drew a swallow going in')
  else if (r.world) ok(`swallow: the world renderer drew up to ${r.streaks} swallow(s) going in`)

  // The streak on pixels, on a frozen frame (§C2).
  await page.evaluate(() => window.__game.freeze(true))
  try {
    const none = await page.evaluate(() => window.__game.drawSwallow(null))
    await frames(page, 2)
    const off = await photo(page)
    const one = await page.evaluate((kk) => window.__game.drawSwallow(kk, -Math.PI / 2), SWALLOW_K)
    await frames(page, 2)
    const on = await photo(page)
    await page.screenshot({ path: join(shotsDir, 'black-hole-swallow.png') })
    await page.evaluate(() => window.__game.drawSwallow(null))
    if (!none || !one?.centre) {
      fail(`swallow: the pinned streak could not be drawn: ${JSON.stringify(one)}`)
      return
    }
    const c = one.centre
    // The control: 0.4 horizons across the centre from the streak — where `coverage` probes the shadow black.
    const away = Math.hypot(c.x - hole.x, c.y - hole.y)
    const across = { x: hole.x - ((c.x - hole.x) / away) * 0.4 * k.BLACK_HOLE_HORIZON_R, y: hole.y - ((c.y - hole.y) / away) * 0.4 * k.BLACK_HOLE_HORIZON_R }
    const cs = await toScreen(page, c.x, c.y)
    const xs = await toScreen(page, across.x, across.y)
    const cmp = await comparePhotos(page, on, off, { points: [cs, xs] })
    const [at, ctrl] = cmp.detail
    const lit = (at.a[0] + at.a[1] + at.a[2]) / 3
    if (!cs.onScreen || !xs.onScreen) fail(`swallow: the streak's centre or its control is off screen: ${JSON.stringify([cs, xs])}`)
    else if (!cmp.points[0] || lit < STREAK_LIT_MIN) fail(`swallow: the pinned streak did not paint at its centre: ${JSON.stringify(at)}`)
    else if (cmp.points[1]) fail(`swallow: control — a point across the shadow changed too: ${JSON.stringify(ctrl)}`)
    else ok(`swallow: the streak paints the shadow at its centre (mean ${lit.toFixed(0)} > ${STREAK_LIT_MIN}, changed ${at.peak}); across the shadow unchanged`)
  } finally {
    await page.evaluate(() => window.__game.freeze(false))
  }
}

/** Ask for the hole (and a placement, or the telegraph, or litter); resolves with the server's answer. */
async function probe(page, dist, warn = false, litter = undefined) {
  await page.evaluate(([d, w, l]) => window.__game.debugBlackHole(d ?? undefined, w, undefined, l ?? undefined), [dist ?? null, warn, litter ?? null])
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
  await swirl(page, h, label)
  await page.evaluate(() => window.__game.freeze(true))
  try {
    await frames(page, 2)
    const fx = (await page.evaluate(() => window.__game.debug())).blackHole.fx
    if (!fx || !fx.drawn) {
      fail(`${label}: the black hole is not drawn: ${JSON.stringify(fx)}`)
      return
    }
    // T23.20 part C: with the world renderer drawing the scene the hole is its (both tiers); Phaser's two paths are the
    // fallback without WebGL2 and are asked for only then.
    if (fx.world) {
      if (fx.shader) fail(`${label}: the world renderer draws the hole and Phaser's shader quad is up too`)
    } else if (fx.shader !== wantShader) fail(`${label}: drawn by the ${fx.shader ? 'shader' : 'flat'} path, asked for ${wantShader ? 'shader' : 'flat'}`)
    const ringOk = (q) =>
      fx.world
        ? (q.a[0] + q.a[1] + q.a[2]) / 3 >= RING_LIT_MIN && q.a[0] - q.a[2] >= RING_WARM_MIN && q.peak > 6
        : q.a.every((c, i) => Math.abs(c - fx.ringRgb[i]) <= RING_TOLERANCE)
    const ringWant = fx.world ? `lit and warm (mean ≥ ${RING_LIT_MIN}, r − b ≥ ${RING_WARM_MIN}, changed)` : `the ring's colour ${JSON.stringify(fx.ringRgb)}`
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
      const r = fx.radii.glow + 60
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
    const inRing = ringDetail.filter(ringOk).length
    if (ringPts.length < RING_PROBES * MIN_ON_SCREEN) fail(`${label}: only ${ringPts.length} of ${RING_PROBES} ring points in view — coverage would mean nothing`)
    else if (inRing < ringPts.length * RING_COLOUR_SHARE) fail(`${label}: only ${inRing} of ${ringPts.length} accretion-ring points are ${ringWant}: ${JSON.stringify(ringDetail.slice(0, 4))}`)
    else ok(`${label}: ${inRing}/${ringPts.length} accretion-ring points ${ringWant} where the hole is (${fx.world ? 'world renderer' : fx.shader ? 'shader' : 'flat'})`)
    const discDetail = cmp.detail.slice(ringPts.length, ringPts.length + discPts.length)
    const black = discDetail.filter((q) => q.a.every((c) => c <= DISC_MAX)).length
    if (discPts.length < 3) fail(`${label}: only ${discPts.length} disc points in view`)
    else if (black < discPts.length) fail(`${label}: only ${black} of ${discPts.length} disc points are black: ${JSON.stringify(discDetail.map((q) => q.a))}`)
    else ok(`${label}: the horizon is a black disc (${black}/${discPts.length} probes ≤ ${DISC_MAX} per channel)`)
    if (!ctrl) fail(`${label}: no point in view clear of the hole for the control`)
    else if (cmp.points[pts.length - 1]) fail(`${label}: control — a point clear of the hole changed too: ${JSON.stringify(cmp.detail[pts.length - 1])}`)
    else ok(`${label}: control — a point clear of the hole did not change`)
    // T22.14A L: **the arrival frame** — the server kills at the full horizon on the
    // tick the hole opens, so the ring (the rule, R90) and the disc must be full size
    // from that frame, not swelling in over BLACK_HOLE_GROW_MS. The same probes, the
    // layer repainted as it looks 0 ms after arrival (growth 0), against the same
    // hidden frame. The ring's colour is the discriminator (the space backdrop is dark
    // enough to pass for the disc).
    const fx0 = await page.evaluate(() => window.__game.drawBlackHoleAt(0))
    await frames(page, 2)
    const born = await photo(page)
    await page.screenshot({ path: join(shotsDir, `black-hole-${label}-arrival.png`) })
    const cmp0 = await comparePhotos(page, born, off, { points: [...ringPts, ...discPts] })
    const ring0 = cmp0.detail.slice(0, ringPts.length).filter(ringOk).length
    const black0 = cmp0.detail.slice(ringPts.length).filter((q) => q.a.every((c) => c <= DISC_MAX)).length
    if (!fx0 || !fx0.drawn || fx0.growth !== 0) fail(`${label}: the arrival frame was not drawn at growth 0: ${JSON.stringify(fx0)}`)
    else if (ring0 < ringPts.length * RING_COLOUR_SHARE || black0 < discPts.length)
      fail(`${label}: at the arrival frame only ${ring0} of ${ringPts.length} ring points are the ring's colour and ${black0} of ${discPts.length} disc points black — the rule is drawn smaller than it kills`)
    else ok(`${label}: at the arrival frame (growth 0) the ring (${ring0}/${ringPts.length}) and the disc (${black0}/${discPts.length}) are already full size`)
  } finally {
    await page.evaluate(() => window.__game.freeze(false))
  }
}

/**
 * T23.20 part C (owner: *"like the image but animated"*): **the disc swirls** — two photographs `SWIRL_MS` apart, the
 * scene running, differ at points on the disc (1.8–3 horizons out along its tilt, clear of the ring band) and not at a
 * control point clear of the glow. Only for the world renderer's hole (Phaser's flat path turns streaks, not this).
 */
async function swirl(page, h, label) {
  const fx = (await page.evaluate(() => window.__game.debug())).blackHole.fx
  if (!fx?.world) return
  const drawn = await page.evaluate(() => window.__world?.blackHole?.() ?? null)
  if (!drawn?.drawn) {
    fail(`${label} swirl: the hole is the world renderer's and it reports nothing drawn: ${JSON.stringify(drawn)}`)
    return
  }
  const tilt = drawn.tilt
  const pts = []
  for (let i = 0; i < SWIRL_PROBES; i++) {
    const side = i % 2 ? 1 : -1
    const d = (1.8 + (1.2 * Math.floor(i / 2)) / (SWIRL_PROBES / 2)) * fx.radii.horizon * side
    // Along the disc's tilt (rising to the right on screen: mask y goes up as x grows).
    const s = await toScreen(page, h.x + d * Math.cos(tilt), h.y - d * Math.sin(tilt))
    if (s.onScreen) pts.push({ x: s.x, y: s.y })
  }
  let ctrl = null
  for (const a of [Math.PI / 2, -Math.PI / 2, 0, Math.PI]) {
    const s = await toScreen(page, h.x + Math.cos(a) * (fx.radii.glow * 1.6 + 60), h.y + Math.sin(a) * (fx.radii.glow * 1.6 + 60))
    if (s.onScreen) {
      ctrl = s
      break
    }
  }
  const a = await photo(page)
  await page.waitForTimeout(SWIRL_MS)
  const b = await photo(page)
  await page.screenshot({ path: join(shotsDir, `black-hole-${label}-swirl.png`) })
  const cmp = await comparePhotos(page, a, b, { points: [...pts, ...(ctrl ? [{ x: ctrl.x, y: ctrl.y }] : [])] })
  const moved = cmp.points.slice(0, pts.length).filter(Boolean).length
  if (pts.length < SWIRL_PROBES / 2) fail(`${label} swirl: only ${pts.length} disc points on screen`)
  else if (moved < pts.length * SWIRL_MIN_SHARE) fail(`${label} swirl: the disc did not move — ${moved} of ${pts.length} points changed in ${SWIRL_MS} ms`)
  else ok(`${label} swirl: ${moved}/${pts.length} disc points changed in ${SWIRL_MS} ms`)
  if (!ctrl) fail(`${label} swirl: no control point on screen`)
  else if (cmp.points[pts.length]) fail(`${label} swirl: control — a point clear of the glow changed too: ${JSON.stringify(cmp.detail[pts.length])}`)
  else ok(`${label} swirl: control — a point clear of the glow did not change`)
}

/**
 * R93: the telegraph on the rendered frame — ring probes at the horizon in the
 * telegraph's own colour where the hole will open, against the same frozen instant
 * with the layer hidden, plus a control point clear of it.
 */
async function telegraph(page, w) {
  await page.evaluate(([x, y]) => window.__game.watch(x, y), [w.x, w.y])
  await frames(page, SETTLE_FRAMES)
  await page.evaluate(() => window.__game.freeze(true))
  try {
    await frames(page, 2)
    const fx = (await page.evaluate(() => window.__game.debug())).blackHole.fx
    if (!fx || !fx.warned) {
      fail(`telegraph: not drawn before the hole opened: ${JSON.stringify(fx)}`)
      return
    }
    const bounds = await page.evaluate(() => {
      const r = document.querySelector('canvas').getBoundingClientRect()
      return { left: r.left, top: r.top, w: r.width, h: r.height }
    })
    const inView = (s) => s.onScreen && s.y > bounds.top + bounds.h / 6 && s.y < bounds.top + (bounds.h * 5) / 6
    const underDom = (s) => page.evaluate(([x, y]) => document.elementFromPoint(x, y)?.tagName !== 'CANVAS', [s.x, s.y])
    const pts = []
    for (let i = 0; i < RING_PROBES; i++) {
      const a = (i / RING_PROBES) * Math.PI * 2
      const s = await toScreen(page, w.x + Math.cos(a) * fx.radii.horizon, w.y + Math.sin(a) * fx.radii.horizon)
      if (inView(s) && !(await underDom(s))) pts.push({ x: s.x, y: s.y })
    }
    let ctrl = null
    for (const a of [0, Math.PI, Math.PI / 2, -Math.PI / 2, Math.PI / 4, (3 * Math.PI) / 4]) {
      const r = fx.radii.glow + 60
      const s = await toScreen(page, w.x + Math.cos(a) * r, w.y + Math.sin(a) * r)
      if (inView(s) && !(await underDom(s))) {
        ctrl = s
        break
      }
    }
    const on = await photo(page)
    await page.screenshot({ path: join(shotsDir, 'black-hole-telegraph.png') })
    await page.evaluate(() => window.__game.showBlackHole(false))
    await frames(page, 2)
    const off = await photo(page)
    await page.screenshot({ path: join(shotsDir, 'black-hole-telegraph-hidden.png') })
    await page.evaluate(() => window.__game.showBlackHole(true))
    const all = [...pts, ...(ctrl ? [{ x: ctrl.x, y: ctrl.y }] : [])]
    const cmp = await comparePhotos(page, on, off, { points: all })
    const inColour = cmp.detail.slice(0, pts.length).filter((q) => q.a.every((c, i) => Math.abs(c - fx.warnRgb[i]) <= RING_TOLERANCE)).length
    if (pts.length < RING_PROBES * MIN_ON_SCREEN) fail(`telegraph: only ${pts.length} of ${RING_PROBES} ring points in view`)
    else if (inColour < pts.length * RING_COLOUR_SHARE) fail(`telegraph: only ${inColour} of ${pts.length} ring points in its colour ${JSON.stringify(fx.warnRgb)}: ${JSON.stringify(cmp.detail.slice(0, 4))}`)
    else ok(`telegraph: ${inColour}/${pts.length} ring points in its own colour at the horizon where it will open (${(fx.warnProgress * 100).toFixed(0)} % through)`)
    if (!ctrl) fail('telegraph: no point in view clear of it for the control')
    else if (cmp.points[all.length - 1]) fail(`telegraph: control — a point clear of it changed too: ${JSON.stringify(cmp.detail[all.length - 1])}`)
    else ok('telegraph: control — a point clear of it did not change')
  } finally {
    await page.evaluate(() => window.__game.freeze(false))
  }
}

/**
 * How far off the expected mix a reach-ring probe may be, per channel: antialiasing at
 * the stroke's centre line, and the PNG round trip.
 */
const REACH_TOLERANCE = 16
/** Reach-ring probes along the arc in view, and their spread either side, rad. */
const REACH_PROBES = 9
const REACH_SPREAD = 0.2
/** The controls sit this far inside and outside the reach, world px — clear of the stroke. */
const REACH_CTRL_OFF = 24

/**
 * T22.18B F4: the faint ring at `BLACK_HOLE_REACH` on the rendered frame. The camera is
 * put on the ring's arc (the reach is ~2 screens wide at the match zoom); every probe on
 * the arc must be `mix(hidden, ringRgb, reachAlpha)` — the ring, and that faint — and
 * the controls either side of it unchanged.
 */
async function reachRing(page, h, label) {
  const fx0 = (await page.evaluate(() => window.__game.debug())).blackHole.fx
  const reach = fx0?.radii?.reach
  if (!fx0 || !(reach > 0)) {
    fail(`${label} reach ring: no radii to probe: ${JSON.stringify(fx0)}`)
    return
  }
  // The arc toward the arena's middle from the hole, so the camera is not clamped
  // against the map's edge with the arc off screen.
  const mid = await page.evaluate(() => ({ x: window.__game.core.width / 2, y: window.__game.core.height / 2 }))
  const base = Math.atan2(mid.y - h.y, mid.x - h.x)
  const at = (a, r) => ({ x: h.x + Math.cos(a) * r, y: h.y + Math.sin(a) * r })
  const c0 = at(base, reach)
  await page.evaluate(([x, y]) => window.__game.watch(x, y), [c0.x, c0.y])
  await frames(page, SETTLE_FRAMES)
  await page.evaluate(() => window.__game.freeze(true))
  try {
    await frames(page, 2)
    const fx = (await page.evaluate(() => window.__game.debug())).blackHole.fx
    if (!fx.reachRing) fail(`${label} reach ring: the state says it was not painted: ${JSON.stringify(fx)}`)
    const ring = []
    const ctrl = []
    for (let i = 0; i < REACH_PROBES; i++) {
      const a = base + REACH_SPREAD * ((2 * i) / (REACH_PROBES - 1) - 1)
      const s = await toScreen(page, at(a, reach).x, at(a, reach).y)
      if (s.onScreen) ring.push({ x: s.x, y: s.y })
      for (const off of [-REACH_CTRL_OFF, REACH_CTRL_OFF]) {
        const q = await toScreen(page, at(a, reach + off).x, at(a, reach + off).y)
        if (q.onScreen && i % 2 === 0) ctrl.push({ x: q.x, y: q.y })
      }
    }
    const on = await photo(page)
    await page.screenshot({ path: join(shotsDir, `black-hole-${label}-reach.png`) })
    await page.evaluate(() => window.__game.showBlackHole(false))
    await frames(page, 2)
    const off = await photo(page)
    await page.evaluate(() => window.__game.showBlackHole(true))
    const cmp = await comparePhotos(page, on, off, { points: [...ring, ...ctrl] })
    const want = (b) => b.map((v, i) => v * (1 - fx.reachAlpha) + fx.ringRgb[i] * fx.reachAlpha)
    const rd = cmp.detail.slice(0, ring.length)
    const good = rd.filter((q) => want(q.b).every((v, i) => Math.abs(q.a[i] - v) <= REACH_TOLERANCE) && q.peak > REACH_TOLERANCE)
    const moved = cmp.points.slice(ring.length).filter(Boolean).length
    if (ring.length < REACH_PROBES * MIN_ON_SCREEN) fail(`${label} reach ring: only ${ring.length} of ${REACH_PROBES} probes on screen`)
    else if (good.length < ring.length * RING_COLOUR_SHARE)
      fail(`${label} reach ring: only ${good.length} of ${ring.length} probes are the hidden frame mixed ${fx.reachAlpha} with ${JSON.stringify(fx.ringRgb)}: ${JSON.stringify(rd.slice(0, 4))}`)
    else ok(`${label} reach ring: ${good.length}/${ring.length} probes at ${reach} px are the frame beneath mixed ${fx.reachAlpha} with the ring's colour`)
    if (ctrl.length < 2) fail(`${label} reach ring: only ${ctrl.length} control points on screen`)
    else if (moved > 0) fail(`${label} reach ring: control — ${moved} of ${ctrl.length} points ${REACH_CTRL_OFF} px either side of the reach changed: ${JSON.stringify(cmp.detail.slice(ring.length))}`)
    else ok(`${label} reach ring: control — ${ctrl.length} points ${REACH_CTRL_OFF} px either side of it did not change`)
  } finally {
    await page.evaluate(() => window.__game.freeze(false))
  }
}

/** R93: the minimap marker — its ring pixel in the hole's colour, gone with the layer hidden. */
async function minimapMark(page, ringRgb) {
  const read = () =>
    page.evaluate(() => {
      const el = document.querySelector('[data-minimap="root"] canvas')
      const st = window.__game.minimap()
      if (!el || !st || !st.holeAt) return { st, px: null }
      const ctx = el.getContext('2d')
      const half = Math.floor(st.holeMarkPx / 2)
      const at = (x, y) => Array.from(ctx.getImageData(x, y, 1, 1).data.slice(0, 3))
      return { st, px: { ring: at(st.holeAt.x - half, st.holeAt.y), core: at(st.holeAt.x, st.holeAt.y) } }
    })
  const mmState = await page.evaluate(() => window.__game.minimap())
  if (mmState && mmState.visible === false) await page.keyboard.press('m')
  await frames(page, 3)
  const shown = await read()
  const where = shown.st?.holeAt
  // T22.18B F4: the reach circle — pixels on it (8 bearings, inside the canvas) and, as
  // the control, 3 px **outside** it on the same bearings; read shown, then hidden.
  // Outside, not inside: arm 2's player is placed at 0.9 × reach and pulled in, so her
  // 3 px dot crosses every radius inside the circle — a control 3 px inside it once
  // caught the dot moving (T22.19's run of this check).
  const reachPx = (hidden) =>
    page.evaluate(([w, hid]) => {
      const el = document.querySelector('[data-minimap="root"] canvas')
      const st = window.__game.minimap()
      if (!el || !w || !(st.holeReachPx > 0 || hid)) return null
      const ctx = el.getContext('2d')
      const r = hid ? window.__minimapReach : st.holeReachPx
      if (!hid) window.__minimapReach = r
      const out = []
      for (let i = 0; i < 8; i++) {
        const a = (i / 8) * Math.PI * 2 + 0.2
        const p = (d) => [Math.round(w.x + 0.5 + Math.cos(a) * d - 0.5), Math.round(w.y + 0.5 + Math.sin(a) * d - 0.5)]
        const [x, y] = p(r)
        const [cx, cy] = p(r + 3)
        if (x < 0 || y < 0 || x >= el.width || y >= el.height) continue
        out.push({ on: Array.from(ctx.getImageData(x, y, 1, 1).data.slice(0, 3)), ctrl: Array.from(ctx.getImageData(cx, cy, 1, 1).data.slice(0, 3)) })
      }
      return { r, alpha: st.holeReachAlpha, out }
    }, [where, hidden])
  const reachShown = await reachPx(false)
  await page.evaluate(() => window.__game.showBlackHole(false))
  await frames(page, 3)
  const reachHidden = await reachPx(true)
  const hidden = await page.evaluate((w) => {
    const el = document.querySelector('[data-minimap="root"] canvas')
    const st = window.__game.minimap()
    if (!el || !w) return { st, ring: null }
    const half = Math.floor(st.holeMarkPx / 2)
    return { st, ring: Array.from(el.getContext('2d').getImageData(w.x - half, w.y, 1, 1).data.slice(0, 3)) }
  }, where)
  await page.evaluate(() => window.__game.showBlackHole(true))
  const near = (a, b) => a && a.every((c, i) => Math.abs(c - b[i]) <= RING_TOLERANCE)
  if (!shown.px) fail(`minimap: the hole is not on it: ${JSON.stringify(shown.st)}`)
  else if (!near(shown.px.ring, ringRgb) || !shown.px.core.every((c) => c <= DISC_MAX)) fail(`minimap: the marker is not the hole's ring round a black core: ${JSON.stringify(shown.px)}`)
  else if (hidden.st?.holeDrawn || near(hidden.ring, ringRgb)) fail(`minimap: control — the marker stayed with the layer hidden: ${JSON.stringify(hidden)}`)
  else ok(`minimap: the hole is marked at (${where.x}, ${where.y}) in its ring's colour round a black core, and goes with the layer hidden`)
  const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2])
  if (!reachShown || !reachHidden || reachShown.out.length < 4) fail(`minimap: the reach circle has too few pixels to read: ${JSON.stringify({ reachShown, reachHidden })}`)
  else {
    const pairs = reachShown.out.map((s, i) => ({ s, h: reachHidden.out[i] }))
    // On the circle the pixel moved toward the ring's colour; 3 px inside it, nothing.
    const toward = pairs.filter((p) => dist(p.h.on, ringRgb) - dist(p.s.on, ringRgb) >= MINIMAP_REACH_MIN).length
    const ctrlMoved = pairs.filter((p) => dist(p.s.ctrl, p.h.ctrl) > 3).length
    if (toward < pairs.length * RING_COLOUR_SHARE) fail(`minimap: only ${toward} of ${pairs.length} pixels on the reach circle (r ${reachShown.r.toFixed(1)} px) turned toward the ring's colour: ${JSON.stringify(pairs.slice(0, 3))}`)
    else ok(`minimap: the hole's reach is drawn round it (r ${reachShown.r.toFixed(1)} px): ${toward}/${pairs.length} circle pixels toward the ring's colour`)
    if (ctrlMoved > 0) fail(`minimap: control — ${ctrlMoved} of ${pairs.length} pixels 3 px outside the reach circle changed with the layer: ${JSON.stringify(pairs.filter((p) => dist(p.s.ctrl, p.h.ctrl) > 3))}`)
    else ok(`minimap: control — ${pairs.length} pixels 3 px outside the reach circle did not change`)
  }
}

/** How much closer to the ring's colour a minimap reach-circle pixel must get (RGB distance). */
const MINIMAP_REACH_MIN = 20

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
  // --- 0. the telegraph (R93) ---------------------------------------------------------
  const warned = await probe(page, undefined, true)
  if (!warned.warned) fail(`asked for a telegraph, the server answered ${JSON.stringify(warned)}`)
  await page.waitForFunction(() => window.__game.debug().blackHole.warn !== null, null, { timeout: deadlineMs(10, 'black_hole_warn'), polling: 'raf' })
  const warnAt = (await dbg()).blackHole.warn
  await telegraph(page, warnAt)
  await page.waitForFunction(() => window.__game.debug().blackHole.hole !== null, null, { timeout: deadlineMs(k.BLACK_HOLE_TELEGRAPH + 10, 'black_hole after its telegraph'), polling: 'raf' })
  const opened = (await dbg()).blackHole.hole
  const late = (opened.arrivedAt - warnAt.since) / 1000
  if (Math.hypot(opened.x - warnAt.x, opened.y - warnAt.y) > 0.5) fail(`the hole opened at (${opened.x}, ${opened.y}), not where it was telegraphed (${warnAt.x}, ${warnAt.y})`)
  else ok(`the hole opened where it was telegraphed, ${late.toFixed(2)} s after the warning reached the page (BLACK_HOLE_TELEGRAPH ${k.BLACK_HOLE_TELEGRAPH} s; the exact lead is Rust's)`)

  // --- 1. arrival, both ends; the placement ------------------------------------------
  // Started before the placement probe: it reads the placement in-page (T22.10H).
  const pulled = pullSeries(page, k.BLACK_HOLE_HORIZON_R / 2, PULL_BUDGET_S * 1000)
  const first = await probe(page, placeAt)
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
  await minimapMark(page, d1.blackHole.fx?.ringRgb ?? [0, 0, 0])

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
  else if (travelled < (placeAt - k.BLACK_HOLE_HORIZON_R) / 2) fail(`control: the player moved only ${travelled.toFixed(0)} px before dying — nothing was pulled`)
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

  // --- 3b. the respawn is clear -------------------------------------------------------
  const respawns0 = dd.observed.respawns
  await page.waitForFunction((n) => window.__game.debug().observed.respawns > n && window.__game.debug().death.meAlive, respawns0, { timeout: deadlineMs(k.RESPAWN_DELAY + 10, 'the respawn') })
  await frames(page, 3)
  const back = (await dbg()).player
  const clear = Math.hypot(back.x - hole.x, back.y - hole.y)
  if (clear < k.BLACK_HOLE_REACH - 4) fail(`respawned ${clear.toFixed(0)} px from the hole, inside its reach ${k.BLACK_HOLE_REACH}`)
  else ok(`respawned ${clear.toFixed(0)} px from the hole, outside its reach (${k.BLACK_HOLE_REACH})`)

  // --- 4. the hole swallows everything (T23.38) ----------------------------------------
  await swallowArm(page, hole, k)

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
    await reachRing(page, hole, `match-${path}`)
  }
  await page.evaluate(() => window.__game.setHighQuality(false))

  // --- 5b. the bell for a body in the pull (T22.12D F1) --------------------------------
  {
    const endsTick = (await dbg()).blackHole.bellEndsTick
    const placeTick = endsTick - Math.round(BELL_LEAD_S * k.SIM_HZ)
    if (typeof endsTick !== 'number') fail(`bell: the page holds no ends_tick from a playing round_state: ${endsTick}`)
    else if ((await dbg()).lastServerTick > placeTick) fail(`bell: the arms before ran past ${BELL_LEAD_S} s before the bell (server tick ${(await dbg()).lastServerTick}, bell ${endsTick}) — lengthen ROUND_S`)
    else {
      await page.waitForFunction((t) => window.__game.debug().lastServerTick >= t, placeTick, { timeout: deadlineMs(ROUND_S + 10, 'the bell lead'), polling: 'raf' })
      const deaths3 = (await dbg()).observed.deaths.length
      await page.evaluate((ms) => window.__game.netDelay(ms), BELL_HEAR_LATE_MS)
      const at = await probe(page, BELL_PLACE * k.BLACK_HOLE_REACH)
      await page.waitForFunction(() => window.__game.debug().phase === 'ended', null, { timeout: deadlineMs(BELL_LEAD_S + 10, 'the bell'), polling: 'raf' })
      const atBell = (await dbg()).player
      await page.waitForFunction(() => window.__game.debug().vortex.bellErrorPx !== null, null, { timeout: deadlineMs(5, 'the first snapshot after the bell') }).catch(() => {})
      // The record runs to the page's lead; later snapshots in it overwrite the number.
      await frames(page, 30)
      await page.evaluate(() => window.__game.netDelay(0))
      await frames(page, 10)
      const db = await dbg()
      const err = db.vortex.bellErrorPx
      const pulled = at.placed && atBell ? Math.hypot(atBell.x - at.placed.x, atBell.y - at.placed.y) : 0
      const died = db.observed.deaths.length > deaths3
      if (!at.placed) fail('bell: no clear side to place the player in the pull')
      else if (died) fail(`bell: control — the hole took the player before the bell (placed ${BELL_LEAD_S} s ahead at ${BELL_PLACE} × reach)`)
      else if (pulled < (BELL_PLACE * k.BLACK_HOLE_REACH - k.BLACK_HOLE_HORIZON_R) / 4) fail(`bell: control — the body moved only ${pulled.toFixed(1)} px before the bell, so nothing pulled it`)
      else if (typeof err !== 'number') fail('bell: no prediction for the first snapshot after the bell was measured (bellErrorPx null)')
      else if (err > bound) fail(`bell: when the page heard the bell its prediction was ${err.toFixed(2)} px off the server's (> ${bound.toFixed(2)} px) — it kept pulling past the server's Ended tick (is Core.setBell told?)`)
      else ok(`bell: when the page heard the bell its prediction agreed with the server's to ${err.toFixed(2)} px (≤ ${bound.toFixed(2)} px) for a body pulled ${pulled.toFixed(0)} px toward the hole`)
    }
  }

  // --- 6. frozen at the bell ----------------------------------------------------------
  await page.waitForFunction(() => window.__game.debug().phase === 'ended', null, { timeout: deadlineMs(ROUND_S + 10, 'the bell') })
  // T22.12E F2: **the wire's `ends_tick` is the tick the server rang the bell on**, in
  // integers. `World::step` sets `Ended` last, so the `ended` `round_state` carries the
  // last `Playing` tick and the first tick stepped in `Ended` is one past it — what
  // `bell_seq` assumes of `ends_tick`. A `+2` in `events.rs::round_state_payload` is red here.
  {
    const bh = (await dbg()).blackHole
    if (typeof bh.bellEndsTick !== 'number' || typeof bh.endedAtTick !== 'number') fail(`bell tick: not both heard (ends_tick ${bh.bellEndsTick}, ended at ${bh.endedAtTick})`)
    else if (bh.endedAtTick !== bh.bellEndsTick) fail(`bell tick: the playing round_state said ends_tick ${bh.bellEndsTick}, the server rang the bell on tick ${bh.endedAtTick} (first Ended tick ${bh.endedAtTick + 1}) — off by ${bh.bellEndsTick - bh.endedAtTick}`)
    else ok(`bell tick: ends_tick ${bh.bellEndsTick} is the tick the server rang the bell on; the first tick stepped in Ended is ${bh.endedAtTick + 1}`)
  }
  await frames(page, 10)
  // F3: every placement so far (arm 2's, arm 5b's) reached the page as a relocation.
  const relocs = (await dbg()).blackHole.relocations
  if (relocs < 2) fail(`F3: ${relocs} dev placements heard as relocations, 2 made`)
  else ok(`F3: the dev placements reached the page as relocations (${relocs})`)
  // F9: **not pulled** after the bell. Put at rest well inside the reach — where arm 2's
  // pull carried the body toward the horizon — and watched for a second: nothing may move
  // it (the hole is frozen, and R91 keeps the wells muted inside its reach).
  const still = await probe(page, 0.6 * k.BLACK_HOLE_REACH)
  if (!still.placed) fail('after the bell: no clear side to place the player in the reach')
  else {
    await page.waitForFunction((at) => {
      const p = window.__game.debug().player
      return p && Math.hypot(p.x - at.x, p.y - at.y) < 1
    }, still.placed, { timeout: deadlineMs(5, 'the placement after the bell'), polling: 'raf' }).catch(() => {})
    const a = (await dbg()).player
    await frames(page, k.SIM_HZ)
    const b = (await dbg()).player
    const moved = a && b ? Math.hypot(b.x - a.x, b.y - a.y) : NaN
    if (!(moved <= k.RECONCILE_EPSILON_PX)) fail(`after the bell a player at rest ${(0.6 * k.BLACK_HOLE_REACH).toFixed(0)} px from the hole moved ${moved.toFixed(2)} px in ${k.SIM_HZ} frames — it still pulls (arm 2: ${travelled.toFixed(0)} px while it did)`)
    else ok(`after the bell a player at rest in its reach moved ${moved.toFixed(2)} px in ${k.SIM_HZ} frames — not pulled (while playing: ${travelled.toFixed(0)} px)`)
  }
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
