#!/usr/bin/env node
/**
 * T22.10B — the breach vortex on screen, and in a **real** match.
 *
 *   node scripts/checks/breach-vortex.mjs
 *
 * **The sandbox arm** opens a vortex by hand (`__game.openVortex`, the sandbox has no
 * `World` to breach) and photographs it, flat and shader.
 *
 * **The match arm** is the one the task exists for: one human alone in a private Space
 * room on a `DEV_PROBE=1` server, which breaches the rim on the ray through the player
 * (`debug_breach` → `World::dev_breach_toward`, a meteor's blast through the carve
 * chokepoint). Then:
 *
 * 1. the client's vortex list holds the vortex **where the server put it**;
 * 2. **no rubber-band while it pulls** — from the placed start until the trip, no
 *    correction moves the predicted body more than `RECONCILE_EPSILON_PX`
 *    (`PredictorStats.lastJumpPx`: before the reset against after the replay — what the
 *    player sees snap). A client not told the list predicts no pull while the server
 *    pulls, and every correction is the pull it missed. Plant: skip `Core.setVortices`
 *    → red. **Not the correction count**, and not `lastCorrectionPx`: those compare the
 *    current prediction with the acknowledged state (measured at T22.10B: 11 of 12
 *    snapshots, 3–16 px, with the list told). Since T22.10D F8 a right prediction is
 *    not corrected at all, so the error **at each acknowledged input**
 *    (`lastAckErrorPx`) is measured beside the jump and bounded the same, and a red
 *    names which half moved: the prediction, or the ack skipping inputs (F9);
 * 3. **the trip**: the player is taken, snapped to where the server put them, and that
 *    is inside the rim (the rim predicate itself, `core.spaceInside` — T22.17) and clear of the
 *    vortex's pull (R86);
 * 4. **coverage in both of GameScene's render paths** — the capture ring (`VORTEX_CAPTURE_R`,
 *    what takes you) is painted where `vortex_open` put it, against the same frozen
 *    instant with the layer hidden, and a control point clear of the drawing does not
 *    change (§C2). The path is read off `vortex.fx.shader`, what drew the frame.
 *    **And no line where the swirl ends** (`R98`, T22.10I; T22.14A L sizes its outer
 *    radius off the capture ring, not `VORTEX_REACH / 2`, which marks nothing since
 *    `R97`) — the layer's contribution just inside and at that radius stays under `EDGE_MAX`, while
 *    the swirl is still drawn half-way out (the presence control, so a vortex drawing
 *    nothing cannot pass);
 * 5. **not on the minimap** (R9, point 5) — the minimap's own DOM canvas, photographed
 *    in the same shown/hidden pair, does not change while the world canvas does.
 */
import { startStack, freePort, tally, shotsDir, drawnFrames, soloSpace } from './harness.mjs'
import { deadlineMs } from '../lib/deadline.mjs'
import { comparePhotos, photo, toScreen } from './pixels.mjs'
import { join } from 'node:path'

/** `n` drawn frames, or a throw naming a page that stopped rendering — the harness's one copy (T22.00C). */
const frames = (page, n) => drawnFrames(page, n)
const { fail, ok, finish } = tally('breach-vortex')
const WARMUP_S = 3
const ROUND_S = 120
/** Frames drawn after moving the camera, before photographing. */
const SETTLE_FRAMES = 6
/** Probes round the capture ring. */
const RING_PROBES = 24
/**
 * Per channel, how far a ring probe may be from the ring's colour — antialiasing on
 * the shader's edge. Measured: 0–1 on both paths where nothing is drawn over the ring.
 */
const RING_TOLERANCE = 12
/**
 * Of the painted ring probes, the share that must be the ring's own colour. Not all:
 * something drawn over the ring (measured once: a sandbox probe at 0.4 of it) is not
 * a missing ring. With the ring deleted the flat path measured 0 of 17.
 */
const RING_COLOUR_SHARE = 0.8
/**
 * R98: the largest per-channel change the layer may make at, and `EDGE_IN` world px
 * inside, the swirl's outer radius — read off `vortex.fx.radii.outer`, what drew the
 * frame (T22.14A L sized it off the capture ring; it was `VORTEX_REACH / 2`) — no edge
 * there reads as a line.
 * The old hard-edged halo alone made ~25 in blue (0.16 × 0x a0, additive).
 */
const EDGE_MAX = 12
/** World px inside the swirl's outer radius of the second edge probe. */
const EDGE_IN = 6
/**
 * Of the edge probes, the share that must be in view. Lower than the ring's: at 1280×720
 * the outer radius runs off the top and bottom sixths (measured 12 and 16 of 48 in view,
 * sandbox and match) — still a dozen points across both sides of the swirl.
 */
const EDGE_MIN_ON_SCREEN = 0.2
/** Of the ring probes, at least this share must be in view for the coverage to mean anything. */
const MIN_ON_SCREEN = 0.5
/** How long the pull may take to deliver the placed player to the vortex, s. */
const TRIP_BUDGET_S = 10
/** Frames the correction floor is measured over, with nothing pulling. */
const BASELINE_FRAMES = 180

/**
 * Photograph the capture ring of the vortex at `v` with the layer shown and hidden, at
 * one frozen instant, and a control point clear of the drawing. Returns the pair of
 * photos' comparison for the caller's minimap assertion, or null.
 */
async function coverage(page, k, v, label, wantShader) {
  const dbg = () => page.evaluate(() => window.__game.debug())
  await page.evaluate(([x, y]) => window.__game.watch(x, y), [v.x, v.y])
  await frames(page, SETTLE_FRAMES)
  await page.evaluate(() => window.__game.freeze(true))
  try {
    await frames(page, 2)
    const d = await dbg(page)
    const fx = d.vortex?.fx
    if (!fx || !fx.drawn.includes(v.id)) {
      fail(`${label}: vortex ${v.id} is not drawn: ${JSON.stringify(fx)}`)
      return null
    }
    if (fx.shader !== wantShader) fail(`${label}: drawn by the ${fx.shader ? 'shader' : 'flat'} path, asked for ${wantShader ? 'shader' : 'flat'}`)
    const bounds = await page.evaluate(() => {
      const r = document.querySelector('canvas').getBoundingClientRect()
      return { left: r.left, top: r.top, w: r.width, h: r.height }
    })
    const inView = (s) => s.onScreen && s.y > bounds.top + bounds.h / 6 && s.y < bounds.top + (bounds.h * 5) / 6
    const underDom = (s) => page.evaluate(([x, y]) => document.elementFromPoint(x, y)?.tagName !== 'CANVAS', [s.x, s.y])
    const shown = []
    let hidden = 0
    for (let i = 0; i < RING_PROBES; i++) {
      const a = (i / RING_PROBES) * Math.PI * 2
      const s = await toScreen(page, v.x + Math.cos(a) * k.VORTEX_CAPTURE_R, v.y + Math.sin(a) * k.VORTEX_CAPTURE_R)
      if (!inView(s)) continue
      if (await underDom(s)) hidden++
      else shown.push({ x: s.x, y: s.y })
    }
    // R98: probes at, and just inside, the swirl's outer radius — as drawn (T22.14A L)
    // — and half-way out between the ring and it, where the swirl must still be drawn.
    const outer = fx.radii.outer
    if (!(outer > k.VORTEX_CAPTURE_R)) fail(`${label}: the drawing reports no swirl radius: ${JSON.stringify(fx.radii)}`)
    const edge = []
    const mid = []
    for (let i = 0; i < RING_PROBES; i++) {
      const a = ((i + 0.5) / RING_PROBES) * Math.PI * 2
      for (const [list, r] of [
        [edge, outer],
        [edge, outer - EDGE_IN],
        [mid, (outer + k.VORTEX_CAPTURE_R) / 2],
      ]) {
        const s = await toScreen(page, v.x + Math.cos(a) * r, v.y + Math.sin(a) * r)
        if (inView(s) && !(await underDom(s))) list.push({ x: s.x, y: s.y })
      }
    }
    // The control: clear of the swirl's outer edge, in view.
    let ctrl = null
    for (const a of [0, Math.PI, Math.PI / 2, -Math.PI / 2, Math.PI / 4, (3 * Math.PI) / 4]) {
      const r = outer + 60
      const s = await toScreen(page, v.x + Math.cos(a) * r, v.y + Math.sin(a) * r)
      if (inView(s) && !(await underDom(s))) {
        ctrl = s
        break
      }
    }
    const mm = await page.evaluate(() => {
      const el = document.querySelector('[data-minimap="root"] canvas')
      const r = el?.getBoundingClientRect()
      return r && r.width > 0 && r.height > 0 ? { x: Math.floor(r.left), y: Math.floor(r.top), w: Math.ceil(r.width), h: Math.ceil(r.height) } : null
    })
    const on = await photo(page)
    const mmOn = mm ? await photo(page, mm) : null
    await page.screenshot({ path: join(shotsDir, `breach-vortex-${label}.png`) })
    await page.evaluate(() => window.__game.showVortices(false))
    await frames(page, 2)
    const off = await photo(page)
    const mmOff = mm ? await photo(page, mm) : null
    await page.screenshot({ path: join(shotsDir, `breach-vortex-${label}-hidden.png`) })
    await page.evaluate(() => window.__game.showVortices(true))
    const cmp = await comparePhotos(page, on, off, { points: ctrl ? [...shown, { x: ctrl.x, y: ctrl.y }] : shown })
    const rim = await comparePhotos(page, on, off, { points: [...edge, ...mid] })
    const edgeD = rim.detail.slice(0, edge.length)
    const midMoved = rim.points.slice(edge.length).filter(Boolean).length
    const edgeWorst = edgeD.reduce((m, q) => Math.max(m, q.peak), 0)
    if (edge.length < RING_PROBES * 2 * EDGE_MIN_ON_SCREEN) fail(`${label}: only ${edge.length} of ${RING_PROBES * 2} swirl-edge points in view — its absence claim would mean nothing`)
    else if (midMoved === 0) fail(`${label}: control — the swirl is not drawn half-way out (0 of ${mid.length} points changed), so no edge proves nothing`)
    else if (edgeWorst > EDGE_MAX)
      fail(`${label}: the swirl draws a line at its outer radius ${outer} (R98) — ${edgeD.filter((q) => q.peak > EDGE_MAX).length} of ${edge.length} edge points changed by more than ${EDGE_MAX}: ${JSON.stringify(edgeD.filter((q) => q.peak > EDGE_MAX).slice(0, 3))}`)
    else ok(`${label}: no line at the swirl's outer radius ${outer} — worst edge change ${edgeWorst} ≤ ${EDGE_MAX} over ${edge.length} points; the swirl drawn at ${midMoved}/${mid.length} half-way points`)
    const painted = cmp.points.slice(0, shown.length).filter(Boolean).length
    // **The ring's own colour, not merely a change**: the halo and the arms move
    // these pixels too (measured: every ring probe changed on the flat path with the
    // ring deleted), so "changed" alone would pass a vortex that draws no ring.
    const ring = fx.ringRgb
    const inRingColour = cmp.detail
      .slice(0, shown.length)
      .filter((q) => q.a.every((c, i) => Math.abs(c - ring[i]) <= RING_TOLERANCE)).length
    if (shown.length < RING_PROBES * MIN_ON_SCREEN) fail(`${label}: only ${shown.length} of ${RING_PROBES} ring points in view — coverage would mean nothing`)
    else if (painted < shown.length) {
      const bad = cmp.detail.slice(0, shown.length).filter((_, i) => !cmp.points[i])
      fail(`${label}: only ${painted} of ${shown.length} capture-ring points in view are painted: ${JSON.stringify(bad.slice(0, 4))}`)
    } else if (inRingColour < shown.length * RING_COLOUR_SHARE) {
      fail(`${label}: only ${inRingColour} of ${shown.length} capture-ring points are the ring's colour ${JSON.stringify(ring)}: ${JSON.stringify(cmp.detail.slice(0, 4).map((q) => q.a))}`)
    } else ok(`${label}: ${painted}/${shown.length} capture-ring points painted where the vortex is, ${inRingColour} in the ring's own colour (${fx.shader ? 'shader' : 'flat'}; ${hidden} under the HUD, not counted)`)
    if (!ctrl) fail(`${label}: no point in view clear of the vortex for the control`)
    else if (cmp.points[shown.length]) fail(`${label}: control — a point clear of the vortex changed too: ${JSON.stringify(cmp.detail[shown.length])}`)
    else ok(`${label}: control — a point clear of the vortex did not change`)
    return mmOn && mmOff ? { mmOn, mmOff, mm } : null
  } finally {
    await page.evaluate(() => window.__game.freeze(false))
  }
}

const stack = await startStack({
  port: await freePort(),
  label: 'breach-vortex',
  env: { BOT_COUNT: '0', FIXED_SEED: '4242', WEATHER: 'off', DEV_PROBE: '1', DEV_WARMUP_SECONDS: String(WARMUP_S), ROUND_SECONDS: String(ROUND_S) },
})
try {
  // ------------------------------------------------------------ the sandbox arm
  {
    const ctx = await stack.browser.newContext({ viewport: { width: 1280, height: 720 } })
    const page = await ctx.newPage()
    const errors = []
    page.on('pageerror', (e) => errors.push(String(e)))
    await page.goto(`${stack.viteUrl}/?sandbox=1&seed=4242&gravity=space`)
    await page.waitForFunction('window.__game && !!window.__game.debug().player', null, { timeout: deadlineMs(60, 'the sandbox player') })
    const k = await page.evaluate(() => window.__game.constants())
    const me = (await page.evaluate(() => window.__game.debug())).player
    // Clear of the body's pull range, so the sandbox body is not drawn into the shot.
    const at = { x: me.x + k.VORTEX_REACH + 80, y: me.y }
    const id = await page.evaluate(([x, y]) => window.__game.openVortex(x, y), [at.x, at.y])
    for (const hq of [false, true]) {
      await page.evaluate((v) => window.__game.setHighQuality(v), hq)
      await frames(page, 2)
      await coverage(page, k, { id, ...at }, `sandbox-${hq ? 'shader' : 'flat'}`, hq)
    }
    await page.evaluate(() => window.__game.setHighQuality(false))
    if (errors.length) fail(`sandbox page errors: ${errors.join(' | ')}`)
    await ctx.close()
  }

  // -------------------------------------------------------------- the match arm
  const { page, errors } = await soloSpace(stack, 'ana')
  const k = await page.evaluate(() => window.__game.constants())
  const dbg = () => page.evaluate(() => window.__game.debug())
  await page.waitForFunction(() => window.__game.debug().phase === 'playing', null, { timeout: deadlineMs(WARMUP_S + 30, 'the round to start') })
  // The noise floor, measured: corrections while nothing pulls — the baseline the
  // pull arm is read against. (Its first reason, the snapshot's `i16` whole-pixel
  // positions putting a resting body up to ~1.4 px off, is gone since T22.10H: the
  // wire rounds to SNAPSHOT_QUANTUM, 1/8 px — T22.12D F6. The floor is still measured,
  // not assumed zero.)
  const sampleWindow = (frameCount) =>
    page.evaluate(
      (n) =>
        new Promise((resolve) => {
          const a = window.__game.debug()
          let left = n
          let c = a.vortex.corrections
          let worst = 0
          const t0 = performance.now()
          const tick = () => {
            const d = window.__game.debug()
            if (d.vortex.corrections !== c) worst = Math.max(worst, d.vortex.lastJumpPx)
            c = d.vortex.corrections
            if (--left > 0 && performance.now() - t0 < 20_000) return requestAnimationFrame(tick)
            resolve({ corrections: d.vortex.corrections - a.vortex.corrections, snapshots: d.lastServerTick - a.lastServerTick, worst })
          }
          requestAnimationFrame(tick)
        }),
      frameCount,
    )
  await frames(page, 30)
  const floor = await sampleWindow(BASELINE_FRAMES)
  // --- 2. no rubber-band while it pulls; 3. the trip: the recording ---------------------
  // T22.03E F8: **the series starts before the breach is asked for**, every drawn frame
  // until the trip, so the snapshot the placement arrives in is always *inside* it —
  // never its unmeasured first sample (T22.03D's recording began at the placed body,
  // and in 4 runs of 6 that was already the placement's snapshot: nothing to leave
  // out, so a "leave nothing out" plant could not go red).
  await page.evaluate(
    ([budgetMs]) => {
      const rec = { out: [], done: false }
      window.__bvRec = rec
      const t0 = performance.now()
      // A page that stops drawing ends the recording with what it has, and fails below.
      setTimeout(() => (rec.done = true), budgetMs + 5000)
      const tick = () => {
        if (rec.done) return
        const d = window.__game.debug()
        const p = d.player && { x: d.player.x, y: d.player.y }
        rec.out.push({ c: d.vortex.corrections, jump: d.vortex.lastJumpPx, ack: d.vortex.lastAckErrorPx, seq: d.vortex.lastAck, tick: d.lastServerTick, trips: d.vortex.myTrips.length, settled: d.vortex.settled, p })
        if (d.vortex.myTrips.length > 0 || performance.now() - t0 > budgetMs) rec.done = true
        else requestAnimationFrame(tick)
      }
      requestAnimationFrame(tick)
    },
    [TRIP_BUDGET_S * 1000 + deadlineMs(10, 'the breach')],
  )
  // T22.17 (R104): **aimed at the top side, above the player**, not along the ray
  // through them. On the square rim that ray reaches a side or a corner (it put the
  // hole at (112, 836), a side one corner away), where the map's edge cuts the
  // swirl and only 8 of its 48 edge probes are in view. Straight up from the player's
  // x is always the top side on a 2:1 map, the breach the ellipse gave this check.
  await page.evaluate(() => {
    const p = window.__game.debug().player
    window.__game.debugBreach({ x: p.x, y: 0 })
  })
  const opened = await page
    .waitForFunction(() => window.__game.debug().vortex.list.length > 0 && window.__game.debug().vortex.lastBreach, null, { timeout: deadlineMs(10, 'the breach'), polling: 'raf' })
    .then(() => true)
    .catch(() => false)
  const d1 = await dbg()
  const breach = d1.vortex.lastBreach
  if (!opened || !breach) throw new Error(`the breach opened no vortex on the client: ${JSON.stringify(d1.vortex)}`)
  const v = d1.vortex.list[0]
  const off = Math.hypot(v.x - breach.x, v.y - breach.y)
  if (off > 1.5) fail(`the client's vortex is ${off.toFixed(1)} px from where the server breached: ${JSON.stringify({ v, breach })}`)
  else ok(`vortex_open put the vortex where the server breached the rim (${v.x}, ${v.y})`)
  if (!breach.placed) throw new Error(`the server found nowhere inward of the hole to put the player: ${JSON.stringify(breach)}`)

  // --- 2. no rubber-band while it pulls; 3. the trip: the measurement -----------------
  // From the last sample before the placement's snapshot (`relocate`'s tick, T22.12E)
  // until the trip; that snapshot is then always the series' second sample, and is the
  // one left out below.
  await page.waitForFunction(() => window.__bvRec.done, null, { timeout: TRIP_BUDGET_S * 1000 + deadlineMs(20, 'the recording'), polling: 500 })
  const recorded = await page.evaluate(() => window.__bvRec.out)
  const d2 = await dbg()
  const relocTick = d2.vortex.myRelocateTick
  let start = -1
  if (relocTick !== null) for (let i = 0; i < recorded.length && recorded[i].tick < relocTick; i++) start = i
  const series = start >= 0 ? recorded.slice(start) : []
  const pull = series.filter((s) => s.trips === 0)
  const near = k.VORTEX_CAPTURE_R / 4
  const reached = pull.some((s) => s.p && Math.hypot(s.p.x - breach.placed.x, s.p.y - breach.placed.y) < near)
  // `first` is where the pull is measured from: the first sample holding the placement.
  const first = reached ? pull.find((s) => relocTick !== null && s.tick >= relocTick) : undefined
  const lastBefore = pull[pull.length - 1]
  const travelled = first && lastBefore ? Math.hypot(lastBefore.p.x - first.p.x, lastBefore.p.y - first.p.y) : 0
  // The worst jump among the corrections made while it pulled — each sample whose
  // count moved carries that correction's jump (≤ one snapshot per drawn frame).
  let worst = 0
  let corrections = 0
  let worstAck = 0
  let acked = 0
  // T22.10D F9: the ack's own step per snapshot, against the ticks between them. A
  // step past the ticks is inputs the server skipped — a rubber-band from the
  // transport, not from the pull, and the report has to be able to say so.
  let ackStep = null
  // T22.12E: the placement is announced (`relocate`, `World::dev_relocate`), so the page
  // has the placed body **before** the snapshot that carries it — and that snapshot acks
  // an input from before the move (385 px at the ack, measured).
  // T22.03D F4: **exactly that snapshot is left out** — the first at/after the relocate
  // event's tick (`debug().vortex.myRelocateTick`) — and nothing else on the predictor's
  // say-so. Any other snapshot the predictor marked `settled` is left out only when its
  // ack step shows a hitch in this very series: a repeated ack while the tick moved
  // (time this client lost), the first new ack after one, or more seqs acked than ticks
  // run (a server trim) — `Predictor.reconcile`'s own three reasons, re-derived here
  // from the wire rather than believed. An unexplained `settled` is measured like any
  // other snapshot, so a predictor that marks everything settled hides nothing.
  let placement = 0
  let placementAt = null
  let placementAck = null
  let hitches = 0
  let unexplained = 0
  let afterRepeat = false
  for (let i = 1; i < pull.length; i++) {
    const newSnap = pull[i].tick !== pull[i - 1].tick
    const seqs = pull[i].seq - pull[i - 1].seq
    const ticks = pull[i].tick - pull[i - 1].tick
    if (newSnap && placementAt === null && relocTick !== null && pull[i].tick >= relocTick) {
      placementAt = pull[i].tick
      placementAck = pull[i].ack
      placement++
      continue
    }
    if (pull[i].settled !== pull[i - 1].settled) {
      const hitch = newSnap && (seqs === 0 || afterRepeat || seqs > ticks)
      afterRepeat = newSnap && seqs === 0
      if (hitch) {
        hitches++
        continue
      }
      unexplained++
    } else if (newSnap) afterRepeat = seqs === 0
    if (pull[i].c !== pull[i - 1].c) {
      corrections++
      worst = Math.max(worst, pull[i].jump)
    }
    // The prediction's own error at each acknowledged input (`lastAckErrorPx`) —
    // since T22.10D F8 **the** measure: a right prediction is no longer corrected at
    // all, so the jump is only sampled when something was wrong.
    if (pull[i].tick !== pull[i - 1].tick && Number.isFinite(pull[i].ack)) {
      acked++
      worstAck = Math.max(worstAck, pull[i].ack)
      const step = { seqs: pull[i].seq - pull[i - 1].seq, ticks: pull[i].tick - pull[i - 1].tick }
      if (!ackStep || step.seqs - step.ticks > ackStep.seqs - ackStep.ticks) ackStep = step
    }
  }
  const secs = first ? (lastBefore.tick - first.tick) / k.SIM_HZ : 0
  const rubber = Math.max(worst, worstAck)
  const summary = `worst error at an acked input (lastAckErrorPx) ${worstAck.toFixed(2)} px over ${acked} snapshots, worst correction jump ${worst.toFixed(2)} px over ${corrections} corrections, in ${secs.toFixed(2)} s of pull (series from tick ${first ? first.tick : '-'}; left out: ${placement} as the placement's${placementAt !== null ? ` at tick ${placementAt}, relocated at ${relocTick}${placementAck !== null ? `, its ack error ${Number(placementAck).toFixed(2)} px` : ''}` : ''}, ${hitches} as a hitch's; ${unexplained} marked settled with no hitch on the wire, measured); largest ack step ${ackStep ? `${ackStep.seqs} seqs in ${ackStep.ticks} ticks` : 'none measured'}; with nothing pulling ${floor.worst.toFixed(2)} px over ${floor.corrections} corrections in ${(floor.snapshots / k.SIM_HZ).toFixed(2)} s`
  // Which half moved, so a red names its cause rather than always the vortex list.
  // **The ack's step first**: a skipped input also makes the prediction at the ack
  // wrong (the server's state lacks it), so an ack error alone cannot tell the two
  // apart — measured with the async input handler planted back: 9–11 px at the
  // ack, and the step 5 seqs in 3 ticks. With the list untold the step is 3 in 3;
  // green, 4 in 3 (the backlog catch-up consuming a second input in one tick).
  const blame =
    ackStep && ackStep.seqs > ackStep.ticks
      ? `the ack ran ${ackStep.seqs - ackStep.ticks} inputs ahead of the ticks in one snapshot — skipped inputs the server never ran (the transport, not the pull); a backlog catch-up (T22.10D) also runs ahead, by one per tick, and is not a rubber-band by itself`
      : worstAck > k.RECONCILE_EPSILON_PX
        ? 'the prediction at an acknowledged input disagreed with the server — the client predicts a different pull (is it told the vortex list?)'
        : 'a correction moved the body although the prediction at the ack agreed — the replay of pending inputs diverged'
  if (start < 0) fail(`control: the recording holds no sample before the placement's snapshot (relocated at ${relocTick}, first recorded tick ${recorded[0]?.tick ?? '-'}), so that snapshot cannot be left out by tick`)
  else if (!first) fail(`the prediction never reached the placed body: ${JSON.stringify({ placed: breach.placed, last: series[series.length - 1] ?? null, player: d2.player })}`)
  else if (placementAt === null) fail(`control: no snapshot at/after the relocate tick ${relocTick} in the series, so the placement's was never the one left out`)
  else if (d2.vortex.myTrips.length === 0) fail(`the vortex never took the player in ${TRIP_BUDGET_S} s (moved ${travelled.toFixed(0)} px): ${JSON.stringify({ first, last: lastBefore })}`)
  else if (travelled < k.VORTEX_CAPTURE_R / 4) fail(`control: the player moved only ${travelled.toFixed(0)} px before the trip — nothing was pulled, so no correction proves nothing`)
  else if (acked === 0) fail(`control: no snapshot acknowledged a predicted input during ${secs.toFixed(2)} s of pull, so the error was never measured`)
  // T22.03D F4: the page must have heard its own placement, or nothing identifies the one snapshot to leave out.
  else if (relocTick === null) fail(`control: the page never heard the placement's relocate event, so no snapshot can be told apart as the placement's: ${JSON.stringify(d2.vortex)}`)
  else if (rubber > k.RECONCILE_EPSILON_PX) fail(`rubber-band: ${summary} — over RECONCILE_EPSILON_PX ${k.RECONCILE_EPSILON_PX}: ${blame}`)
  else ok(`no rubber-band while the vortex pulled the player ${travelled.toFixed(0)} px: ${summary} (bound RECONCILE_EPSILON_PX ${k.RECONCILE_EPSILON_PX})`)

  if (d2.vortex.myTrips.length > 0) {
    // T22.00H: **the predicted body is read at the first drawn frame that heard the trip** —
    // the recording's last sample, which ends on exactly that frame. Until then it was read
    // ten frames *after* the recording's 500 ms-polled end, and the body goes on moving
    // after a trip: 10.9–12.1 px alone (4/4), **101 px** in a `--jobs 4` gate
    // (`gate-t2200h-changed2.txt`), where those frames and that poll take longer — so it
    // measured the box, not the snap. A glide or a missed snap leaves the body back by
    // the pull (~975 px here) at this frame, so the bound is unchanged.
    const atTrip = recorded[recorded.length - 1]
    await frames(page, 10)
    const d3 = await dbg()
    const trip = d3.vortex.myTrips[0]
    // T22.17 (R104): the rim predicate itself, through the page's core — this held the
    // ellipse's formula until the rim became a rectangle, and a copy here would have
    // passed a trip into a corner the ellipse excluded.
    const inside = await page.evaluate(([x, y]) => window.__game.core.spaceInside(x, y), [trip.x, trip.y])
    const clear = Math.hypot(trip.x - v.x, trip.y - v.y)
    const at = atTrip && atTrip.trips > 0 ? atTrip.p : null
    const drift = at ? Math.hypot(at.x - trip.x, at.y - trip.y) : Infinity
    const later = d3.player ? Math.hypot(d3.player.x - trip.x, d3.player.y - trip.y) : Infinity
    if (inside !== true) fail(`the trip put the player outside the rim: ${JSON.stringify({ trip, inside, breach })}`)
    else if (clear < k.VORTEX_REACH / 2) fail(`the trip put the player ${clear.toFixed(0)} px from the vortex, inside its pull (R86)`)
    else if (!at) fail(`control: the recording holds no drawn frame after the trip, so the snap was never seen: ${JSON.stringify(atTrip ?? null)}`)
    else if (drift > k.VORTEX_CAPTURE_R / 2) fail(`the predicted body is ${drift.toFixed(0)} px from where the server put it at the first frame after the trip — it glided or never snapped`)
    else ok(`the trip put the player inside the rim (core.spaceInside), ${clear.toFixed(0)} px from the vortex, and the prediction is there at the first frame after it (${drift.toFixed(1)} px; ${later.toFixed(1)} px ten frames on, reported; snapped by the event: ${trip.snapped})`)
  }

  // --- 4. coverage, flat and shader; 5. not on the minimap -----------------------------
  const mmState = await page.evaluate(() => window.__game.minimap())
  if (mmState && mmState.visible === false) await page.keyboard.press('m')
  for (const hq of [false, true]) {
    const path = hq ? 'shader' : 'flat'
    const q = await page.evaluate((x) => window.__game.setHighQuality(x), hq)
    if (q.setting !== hq) {
      fail(`${path}: High Quality would not change: ${JSON.stringify(q)}`)
      continue
    }
    await frames(page, 2)
    const mm = await coverage(page, k, v, `match-${path}`, hq)
    if (!mm) fail(`${path}: the minimap canvas is not on the page, so its absence claim cannot be made`)
    else {
      const c = await comparePhotos(page, mm.mmOn, mm.mmOff, { rect: { x: 0, y: 0, w: mm.mm.w, h: mm.mm.h } })
      if (c.fraction > 0) fail(`${path}: the minimap changed when the vortex layer was hidden (${(c.fraction * 100).toFixed(2)} % of its pixels) — a vortex on the minimap is not a secret`)
      else ok(`${path}: the minimap did not change with the vortex hidden (the world canvas did, above) — it is not on the minimap`)
    }
  }
  await page.evaluate(() => window.__game.setHighQuality(false))
  if (errors.length) fail(`page errors: ${errors.join(' | ')}`)
} catch (e) {
  fail(`${e?.stack ?? e}`)
} finally {
  await stack.close()
}

await finish()
