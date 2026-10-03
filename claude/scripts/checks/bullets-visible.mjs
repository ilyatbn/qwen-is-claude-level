#!/usr/bin/env node
/**
 * `bullets-visible` — §F2: you can see a bullet, **without stopping time**.
 *
 *   node scripts/checks/bullets-visible.mjs
 *   node scripts/e2e.mjs bullets-visible
 *
 * ## Why this check exists, and why the old one could not do its job
 *
 * `ordnance-visible` photographs a gunshot by calling `window.__game.freeze(true)`
 * first, and it has to: a hitscan tracer lived `TRACER_LIFETIME` 0.09 s — five
 * frames — which is shorter than a screenshot round-trip, so the shot reliably
 * caught an empty hillside. **That freeze is the measurement.** A check that must
 * stop time to see a thing is telling you, in writing, that the player cannot see
 * it. It passed for three milestones while the report never stopped being "I
 * still cannot see gun projectiles".
 *
 * So the assertion here is not "something bright appeared". It is:
 *
 *   > the bright thing is at one place, and **later it is somewhere else**,
 *   > with the game running the whole time.
 *
 * **That is the one assertion a hitscan implementation cannot pass.** A hitscan
 * shot resolves in the tick it is fired; it is never in flight, so it is never
 * *somewhere else* a moment later. It is the difference between §F1's design and
 * the one it replaced, stated as a measurement.
 *
 * ## How
 *
 * One horizontal strip of screen, well clear of the muzzle, along the line the
 * round travels. Each sample finds the **brightest column** in that strip. A
 * round crossing it is a bright column that moves right; nothing else on screen
 * does that.
 *
 * Sampled as a time series rather than at two chosen instants: a single round
 * crosses the strip in a couple of hundred milliseconds and a screenshot costs a
 * good part of that, so betting on two exact moments would be a coin flip, and a
 * gate that fails on a coin flip gates nothing (§A28).
 */
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import {
  startStack,
  enterBattle,
  standStill,
  selectWeapon,
  tally,
  sleep,
  freePort,
  drawnFrames,
} from './harness.mjs'

const PORT = await freePort()
const { fail, ok, failures } = tally('bullets-visible')
// T23.25B F1: **night and day.** Every round opens by day (T23.11), so the picture players see first is gated too: run
// alone, this check runs itself once more at noon (`CHECK_HOUR=0` → `&hour=0`, still: the moons stay at the picture's
// places with `u` absent) against the **same** floors, and fails if that leg does. Shots of the day leg end `-day`.
const HOUR = process.env.CHECK_HOUR ?? '1'
const DAY = HOUR === '0'
/** The day leg: this same script at `&hour=0`, run after the night leg's stack is closed. */
function runDayLeg(fail) {
  if (process.env.CHECK_HOUR) return
  console.log(`\n  --- the same at noon (&hour=0) ---`)
  const r = spawnSync(process.execPath, [fileURLToPath(import.meta.url)], { env: { ...process.env, CHECK_HOUR: '0' }, stdio: 'inherit' })
  if (r.status !== 0) fail(`the day leg (&hour=0) failed (exit ${r.status}) — its lines are above`)
}

// No bots: a bot's gunfire crossing the strip would be indistinguishable from
// ours, and this check is about a round *we* fired.
const stack = await startStack({
  port: PORT,
  label: 'bullets-visible',
  env: { ROUND_SECONDS: '180', BOT_COUNT: '0', DEV_LOADOUT: '1', FIXED_SEED: '4242' },
})
// T23.25: `&hour=1` holds F1's still night sky. Since T23.11 a round opens in moonlit day with the moons moving on their
// arcs, and a moon crossing the lane's strip was a bright column creeping 276 → 360 px over two seconds — "a round
// lit the lane" and "no bright column travelled" at once, red 3 runs in 3 alone and under load; pinned, the fired-away
// control reads 0.0–1.9 where it read 73–77.
// T23.25B F1: and the still day (`&hour=0`, `runDayLeg`) at the same floors.
const { page, dbg, shot: shotRaw, pageErrors } = await stack.openClient({ name: 'ana', query: `&hour=${HOUR}` })
const shot = (name) => shotRaw(DAY ? `${name}-day` : name)
console.log(`  hour ${HOUR} (${DAY ? 'day' : 'night'})`)
await enterBattle(page, { waitPlaying: true, label: 'bullets-visible' })
// **The DOM HUD is taken off the photograph** (T23.19F). The round timer (`ui/hud.ts`, `#hud-timer`,
// top-centre) sits over the lane whenever the lane climbs to the top of the screen, as it does here
// (-150 deg): its digits change every second, at one place — a bright column that never moves, which
// against the control frame read as a round stuck in flight (measured: the "2:54" → "2:51" 4 → 1
// changed 255 luminance at screen x 649–658, strip column 517). The round is drawn by the world
// renderer; the timer and the effect banner are not what this check is about.
await page.addStyleTag({ content: '#hud-timer, #hud-banner { visibility: hidden !important; }' })
// T23.24: **the fireflies are hidden too.** At `&hour=1` they fly (`look/fireflies.ts`), and one drifting by the lane
// is a glint brighter than the fresh control frame that creeps a few px a sample — measured alone at HEAD 1efb357:
// x 166–176 from 0.7 s to 2.1 s at +70–77 after a round lit x 486, so the samples read "drawn, then a static column"
// and the attempt loop stopped on that pair. They are cosmetic and nothing a round is drawn with; hidden by the
// renderer's own switch (`hideLayers`), and the count under the hide is asserted 0 below so the hide is known to hold.
await page.waitForFunction(() => !!window.__world, null, { timeout: 60_000 })
await page.evaluate(() => window.__world.hideLayers(['fireflies']))
await drawnFrames(page, 2)
{
  const f = await page.evaluate(() => window.__world.fireflies())
  console.log(`  fireflies hidden: ${f?.seeded} seeded, ${f?.drawn} drawn under the hide (fade ${f?.fade})`)
  if (f?.drawn !== 0) fail(`the fireflies are drawn under the hide (${f?.drawn}) — the lane is not held still`)
}

const K = await page.evaluate(() => window.__game.constants())
for (const [name, v] of Object.entries({
  SMG_MUZZLE_SPEED: K.SMG_MUZZLE_SPEED,
  SMG_RANGE: K.SMG_RANGE,
  BULLET_LENGTH: K.BULLET_LENGTH,
  PICKUP_RADIUS: K.PICKUP_RADIUS,
})) {
  // §B15: a threshold compared against `undefined` is false forever, and every
  // wait built on one can only time out. Check the instrument first.
  if (!Number.isFinite(v)) fail(`${name} is not exposed to the client — nothing below can hold`)
}

/**
 * The brightest column in a screen strip, and how bright.
 *
 * A column rather than a mean: a mean over a 300 px strip is dominated by the
 * terrain in it and a 2 px streak barely moves it, which is how a "the patch
 * changed" assertion ends up measuring the sky. The argmax is *where* the bright
 * thing is, which is the quantity this check is actually about.
 */
async function columnProfile(clip) {
  const b64 = (await page.screenshot({ clip })).toString('base64')
  return page.evaluate(async ([src, clip, pickupRadius]) => {
    // The live count rides along in this call. It used to be a second
    // `page.evaluate`, and a second round-trip per sample is a third of the
    // sampling budget spent on a diagnostic — which directly cost catches of the
    // thing under test.
    const dbg = window.__game.debug()
    const live = dbg.projectilesLive ?? 0
    // T23.19F: where the pickups are on screen; `stripItems` (below, in node) keeps the ones in this strip.
    const items = (dbg.itemPositions ?? []).map((i) => ({ sx: (i.x - dbg.worldView.x) * dbg.zoom, sy: (i.y - dbg.worldView.y) * dbg.zoom }))
    const img = new Image()
    img.src = `data:image/png;base64,${src}`
    await img.decode()
    const cv = document.createElement('canvas')
    cv.width = img.width
    cv.height = img.height
    const ctx = cv.getContext('2d')
    ctx.drawImage(img, 0, 0)
    const d = ctx.getImageData(0, 0, img.width, img.height).data
    const cols = new Array(img.width)
    for (let x = 0; x < img.width; x++) {
      let peak = 0
      for (let y = 0; y < img.height; y++) {
        const i = (y * img.width + x) * 4
        // The brightest pixel in the column: a streak is 2 px thin, so averaging
        // down a 200 px column would divide it away to nothing.
        const l = 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2]
        if (l > peak) peak = l
      }
      cols[x] = peak
    }
    return { cols, live, items }
  }, [b64, clip, K.PICKUP_RADIUS]).then((r) => ({ ...r, items: stripItems(r.items, clip, ITEM_MASK) }))
}

/**
 * The pickups in a screen strip, as strip columns (see `mostChanged`). T23.25 (T23.19G F3): only pickups **in** the
 * strip — `itemPositions` is every item on the map, and one above or below the lane at a lane x used to blank its
 * columns in both the lane and the control. T23.25B F6: pulled out of the page so it is self-tested below (a pickup in
 * the strip is kept, one at the same x above it is not) — unplanted, a broken filter went back to x-only silently.
 */
function stripItems(items, clip, reach) {
  return items.filter((i) => i.sy >= clip.y - reach && i.sy <= clip.y + clip.height + reach).map((i) => i.sx - clip.x)
}

/**
 * The column that brightened **most against the control frame**, and by how much.
 *
 * Not the brightest column: the first version took the absolute maximum and the
 * region's idle peak measured **255.0** — the lane runs up into open sky, and a
 * saturated background cannot be made brighter. Every sample read 255 and the
 * threshold could never be crossed. A difference against a baseline is what a
 * control frame is *for* (§C2), and it is immune to a bright static background
 * in a way an absolute reading is not.
 */
/**
 * **Pickups are masked** (T23.19F). The server's item schedule drops a pickup where it likes, and on
 * FIXED_SEED 4242 one lands in this strip a few seconds into the check: a lit, static icon that the
 * control frame (taken before it existed) does not hold, so it read as a bright column "stuck" at one
 * x — the parked red of T23.18/T23.19E (x 623 at zoom 2, x 107 at zoom 1; `debug().itemPositions`
 * put item 9 at strip column 104, the changed columns were 97–108). A pickup never moves, so masking
 * its columns cannot hide a round's *travel*; half-width `PICKUP_RADIUS` × zoom (20 px at zoom 1)
 * covers the measured ±7.
 */
function mostChanged(profile, baseline, items = []) {
  let masked = 0
  let bestX = -1
  let best = 0
  for (let x = 0; x < profile.length; x++) {
    if (items.some((ix) => Math.abs(x - ix) <= ITEM_MASK)) {
      masked++
      continue
    }
    const d = profile[x] - (baseline[x] ?? 0)
    if (d > best) {
      best = d
      bestX = x
    }
  }
  return { x: bestX, peak: best, masked }
}

const ITEM_MASK = K.PICKUP_RADIUS * (await dbg()).zoom

// T23.25B F6: the pickup mask's instruments. (1) `stripItems` keeps a pickup in a strip and drops one at the same x
// outside it, both ways — the plant and its control in one. (2) Its screen y is the canvas's, and the strip is a page
// clip: the two agree only while the game's canvas sits at the page's origin at 1:1, so that is asserted, not assumed.
{
  const clip = { x: 100, y: 200, width: 300, height: 40 }
  const inside = stripItems([{ sx: 250, sy: 220 }], clip, ITEM_MASK)
  const above = stripItems([{ sx: 250, sy: clip.y - ITEM_MASK - 1 }], clip, ITEM_MASK)
  const below = stripItems([{ sx: 250, sy: clip.y + clip.height + ITEM_MASK + 1 }], clip, ITEM_MASK)
  if (!(inside.length === 1 && inside[0] === 150 && above.length === 0 && below.length === 0)) {
    fail(`the pickup mask's strip filter: in ${JSON.stringify(inside)}, above ${JSON.stringify(above)}, below ${JSON.stringify(below)} — want [150], [], []`)
  }
  const cv = await page.evaluate(() => {
    const c = document.querySelector('canvas')
    const r = c.getBoundingClientRect()
    return { x: r.x, y: r.y, w: r.width, h: r.height, iw: window.innerWidth, ih: window.innerHeight }
  })
  if (!(cv.x === 0 && cv.y === 0 && cv.w === cv.iw && cv.h === cv.ih)) fail(`the canvas is not the page at 1:1 (${JSON.stringify(cv)}) — the pickup mask's screen y would miss`)
  else ok(`pickup mask: strip filter in/above/below ${inside.length}/${above.length}/${below.length}; canvas at the page origin ${cv.w}x${cv.h}`)
}

/** World point to screen, the §A35-correct way: `worldView` and zoom. */
const toScreen = (d, wx, wy) => ({
  sx: (wx - d.worldView.x) * d.zoom,
  sy: (wy - d.worldView.y) * d.zoom,
})

await standStill(page)
await selectWeapon(page, 'smg')
await standStill(page)

const start = await dbg()
const me = start.player
const view = start.worldView
const viewW = view.width ?? view.w
const viewH = view.height ?? view.h

// **Find real open air; do not make some.**
//
// The first version carved a lane with `core.carveCapsule` and fired down it.
// That carves the **client's** mask — the server's map is untouched — so every
// round hit terrain the client had been told was gone. Measured: the round was
// drawn correctly and lived **120 ms**, covering ~96 world px before exploding
// against ground that only the server could see. A check that edits its own
// evidence is not measuring the game.
//
// So the lane is chosen, not created: scan angles for the longest clear run in
// the mask the server sent, and fire along that.
const LANE = await page.evaluate(
  ([x, y, range]) => {
    const core = window.__game.core
    let best = { angle: 0, len: 0 }
    for (let deg = -170; deg <= 170; deg += 5) {
      const a = (deg * Math.PI) / 180
      const dx = Math.cos(a)
      const dy = Math.sin(a)
      let len = 0
      for (let d = 24; d <= range; d += 4) {
        if (core.solidAt(Math.round(x + dx * d), Math.round(y + dy * d))) break
        len = d
      }
      if (len > best.len) best = { angle: a, len }
    }
    return best
  },
  [Math.round(me.x), Math.round(me.y), Math.round(K.SMG_RANGE)],
)
console.log(`  clear lane: ${((LANE.angle * 180) / Math.PI).toFixed(0)}deg, ${LANE.len} px of open air`)
if (LANE.len < 200) {
  fail(`no lane longer than ${LANE.len} px — this seed gives a round nowhere to fly`)
}

const dirX = Math.cos(LANE.angle)
const dirY = Math.sin(LANE.angle)

/**
 * Point the mouse along the lane, at a distance that is **on screen**.
 *
 * Aim is an angle, not a target: `aimAngle` takes the direction from the player
 * to the cursor and ignores how far away it is (`localInput-math.ts`). So the
 * cursor only has to be somewhere along the lane — and it has to be somewhere
 * *visible*, because clamping an off-screen point to the viewport edge silently
 * changes the angle. At zoom 2 a point 700 px down the lane is 1400 screen px
 * away and always off screen; clamping it turned every shot into a different
 * shot, and the round hit a wall before the first sample. Measured: `live` 0 in
 * every sample of every attempt while the probe, aiming near, saw the round fly.
 */
async function aimAlongLane(sign = 1) {
  const d = await dbg()
  // Well beyond `AIM_DEADZONE`, well inside the viewport.
  const at = toScreen(d, me.x + sign * dirX * 120, me.y + sign * dirY * 120)
  await page.mouse.move(
    Math.max(4, Math.min(1276, at.sx)),
    Math.max(4, Math.min(716, at.sy)),
  )
  await sleep(160)
  return at
}
const aimAt = await aimAlongLane(1)
console.log(`  aiming at screen (${aimAt.sx.toFixed(0)}, ${aimAt.sy.toFixed(0)})`)

// The region: the part of the lane that is on screen, starting clear of the
// muzzle so the **flash cannot supply the signal** and stopping short of the far
// end so an impact flash cannot either.
const NEAR = 90
const FAR = Math.min(LANE.len - 30, K.SMG_RANGE)
const pNear = toScreen(start, me.x + dirX * NEAR, me.y + dirY * NEAR)
const pFar = toScreen(start, me.x + dirX * FAR, me.y + dirY * FAR)
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v))
const REGION = {
  x: Math.round(clamp(Math.min(pNear.sx, pFar.sx) - 20, 0, 1279)),
  y: Math.round(clamp(Math.min(pNear.sy, pFar.sy) - 20, 0, 719)),
}
REGION.width = Math.round(clamp(Math.abs(pFar.sx - pNear.sx) + 40, 40, 1280 - REGION.x))
REGION.height = Math.round(clamp(Math.abs(pFar.sy - pNear.sy) + 40, 24, 720 - REGION.y))
/** Screen px of lane the region actually covers, and which way x runs. */
const RUN_RIGHT = pFar.sx >= pNear.sx
const STRIP = REGION
// A control region the round **provably** never enters: the lane mirrored through
// the player. The round goes one way; this is the other way.
//
// The first version offset the box 180 px upward, which is only safe for a
// horizontal lane. This one runs at -150 deg, so the offset box still sat on the
// flight path and a streak duly travelled 219 px across the "control" — a true
// reading of a badly placed region. Mirroring adapts to whatever lane the map
// offers instead of assuming one.
const mNear = toScreen(start, me.x - dirX * NEAR, me.y - dirY * NEAR)
const mFar = toScreen(start, me.x - dirX * FAR, me.y - dirY * FAR)
const CONTROL = {
  x: Math.round(clamp(Math.min(mNear.sx, mFar.sx) - 20, 0, 1279)),
  y: Math.round(clamp(Math.min(mNear.sy, mFar.sy) - 20, 0, 719)),
}
CONTROL.width = Math.round(clamp(Math.abs(mFar.sx - mNear.sx) + 40, 40, 1280 - CONTROL.x))
CONTROL.height = Math.round(clamp(Math.abs(mFar.sy - mNear.sy) + 40, 24, 720 - CONTROL.y))
const STRIP_SPAN = (FAR - NEAR)

// The control **frame**: the region with nothing fired. Every later reading is a
// difference against this, so a bright but static sky contributes zero.
const baseProfile = (await columnProfile(STRIP)).cols
const baseControlProfile = (await columnProfile(CONTROL)).cols
const base = { peak: 0 }
ok(
  `control frame: ${baseProfile.length} columns captured, ` +
    `idle range ${Math.min(...baseProfile).toFixed(0)}..${Math.max(...baseProfile).toFixed(0)}`,
)

/** Fire once and follow the bright column across the strip. */
async function trackOneShot(label, baseline) {
  await standStill(page)
  await page.evaluate(() => window.__game.fire())
  const t0 = Date.now()
  const seen = []
  // Both ends (§A39): if the layer never holds a round, the failure is upstream
  // of the pixels and this says so instead of leaving "no bright column" to mean
  // either "not drawn" or "not fired".
  let liveSeen = 0
  let peakSeen = 0
  let maskedMost = 0
  const gaps = []
  // The time a round needs to cross the strip, with slack — so a round that
  // never arrives ends the loop rather than hanging it.
  const budget = (STRIP_SPAN / K.SMG_MUZZLE_SPEED) * 1000 * 2 + 500
  while (Date.now() - t0 < budget) {
    const before = Date.now()
    const raw = await columnProfile(STRIP)
    const s = { ...mostChanged(raw.cols, baseline, raw.items), live: raw.live }
    gaps.push(Date.now() - before)
    maskedMost = Math.max(maskedMost, s.masked)
    // Comfortably above the control frame's own peak, so terrain and sky cannot
    // supply it.
    if (s.peak > peakSeen) peakSeen = s.peak
    // 40 luminance above the control frame: a white streak on ADD blend lands
    // near +70 even over bright ground, and frame-to-frame noise measured under 5.
    if (s.peak > 40) seen.push({ t: Date.now() - t0, x: s.x, peak: s.peak })
    if (s.live > 0) liveSeen++
  }
  console.log(
    `  ${label}: ${seen.length} bright sample(s), layer held a round in ${liveSeen} ` +
      `sample(s), ${gaps.length} samples at ~${Math.round(gaps.reduce((a, b) => a + b, 0) / Math.max(1, gaps.length))} ms each, ` +
      `biggest column delta ${peakSeen.toFixed(1)} (threshold 40), at most ${maskedMost} column(s) masked for pickups ` +
      JSON.stringify(seen.slice(0, 8)),
  )
  return { seen, liveSeen, peakSeen }
}

// Several attempts: one round crosses the strip in a few hundred ms and a
// screenshot costs a good part of that, so a single pass can legitimately miss.
// Retrying is not weakening the assertion — the assertion below is unchanged.
let seen = []
let liveSeen = 0
for (let attempt = 0; attempt < 6 && seen.length < 2; attempt++) {
  // A fresh control frame per attempt (T23.19F), the "fired away" leg's rule: the scene as it is
  // now, not as it was before the first shot — the sky's night blend and moons move (T23.11).
  const fresh = (await columnProfile(STRIP)).cols
  const r = await trackOneShot(`attempt ${attempt + 1}`, fresh)
  seen = r.seen
  liveSeen = Math.max(liveSeen, r.liveSeen)
}

if (seen.length === 0) {
  fail(
    'no bright column ever crossed the strip — a fired round is not being drawn' +
      (liveSeen > 0
        ? ` (the layer DID hold a round in ${liveSeen} sample(s), so it is tracked and not drawn)`
        : ' (and the layer never held one either, so the shot never happened)'),
  )
} else {
  ok(
    `a round lit the lane: +${Math.max(...seen.map((s) => s.peak)).toFixed(1)} luminance ` +
      'over the control frame',
  )
}

/**
 * Did a bright column **travel along the lane**? This is the check's pass
 * condition, written once so the control below is judged by the same rule.
 *
 * A hitscan implementation cannot satisfy it: an instant shot is drawn in one
 * place, in one frame, and is never anywhere else afterwards.
 */
function travelled(samples) {
  if (samples.length < 2) return null
  // **Allow exactly one stationary sample at the end: that is the round
  // arriving, not stalling** (T19.23).
  //
  // The every-step-forward rule below is what catches a frozen build, and it is
  // kept. But applied to the raw samples it also fails a round that *completed*
  // its flight: the round stops at the terrain it hit and is still drawn there
  // for the frame or two before it despawns, so whether this check passed
  // depended on the sampler happening to stop before that. That is the flake.
  //
  // **One, and not more.** The bound is what makes this safe, and it is
  // measured, not guessed — trailing stationary samples, this box, seed 4242:
  //
  // | | trailing stationary samples |
  // |---|---|
  // | 26 consecutive live runs | **0** in every one |
  // | the recorded gate failure | 1 |
  // | `projectile_move` frozen after the 4th update | **3 and 4** |
  //
  // A round that lands despawns, so it cannot be drawn stationary for sample
  // after sample; a frozen one is drawn there until the round times out. Two
  // stationary samples in a row is therefore not an arrival, and still fails.
  //
  // **Distance cannot do this job** — that was tried first and it does not
  // separate the two populations. A build frozen after four `projectile_move`
  // messages still covers **251 px** before it stops, against **274-424 px** for
  // a live round, because those messages arrive at the network rate rather than
  // at `SIM_HZ`. Any floor that fails the frozen build also fails a real one.
  const run = samples.slice()
  const stepOf = (a, b) => (RUN_RIGHT ? b.x - a.x : a.x - b.x)
  if (stepOf(run[run.length - 2], run[run.length - 1]) <= 0) run.pop()
  if (run.length < 2) return null
  const first = run[0]
  const last = run[run.length - 1]
  const dx = RUN_RIGHT ? last.x - first.x : first.x - last.x
  const dt = last.t - first.t
  // 40 px of screen travel: a round covers that in well under one sample
  // interval, and it is far more than the couple of pixels a static bright thing
  // wanders under compression noise. This is a *noise* floor and nothing more —
  // see above for why it is not the thing that catches a stall.
  if (!(dx > 40 && dt > 0)) return null
  // **Every step, not just the endpoints.** First-to-last alone proves the round
  // was drawn in two places, which is a weaker claim than "it flew" and one a
  // broken build can satisfy. A round whose `projectile_move` stops arriving is
  // exactly the regression this check is here to catch, and after the single
  // arrival sample is allowed for, a stall anywhere in the run still fails here.
  for (let i = 1; i < run.length; i++) {
    // Zero is a stall; backwards is a different round entering the lane behind
    // this one. Both mean this sample sequence is not one round in flight.
    if (stepOf(run[i - 1], run[i]) <= 0) return null
  }
  // **The cost, stated:** this rule also judges the two control regions below,
  // and a stricter rule makes a control *easier* to satisfy. What it can now
  // miss there is an artefact that drifts and then stalls — which is noise, not
  // the failure the controls exist for. A screen that is genuinely scrolling
  // moves on every step and is still caught. The alternative, a loose rule for
  // the controls and a strict one for the lane, would let the lane pass under a
  // rule the controls were never tested against; one rule for both is the point.
  return { first, last, dx, dt }
}

// **The assertion this check exists for.**
const moved = travelled(seen)
if (moved) {
  ok(
    `the streak MOVED: column ${moved.first.x} at ${moved.first.t} ms -> ${moved.last.x} ` +
      `at ${moved.last.t} ms (${moved.dx} px in ${moved.dt} ms), with the game running`,
  )
} else {
  fail(
    `no bright column travelled along the lane: ${JSON.stringify(seen.slice(0, 6))} — a shot ` +
      'that is drawn in one place and then gone is a hitscan tracer, not a round in flight',
  )
}

// The control region, over the same run.
// The control **region**, judged by the same rule as the lane: does a bright
// column *travel* across it while we shoot?
//
// An absolute threshold here read 37.6 against a limit of 40 — a 6 % margin, and
// a gate that fails on a coin flip gates nothing (§A28). The number was a
// **crater** in the frame, a static difference that says nothing about whether
// the screen is flickering. Movement is the property that matters, and it is the
// one the lane is judged on, so the control is judged on it too.
const controlBase = (await columnProfile(CONTROL)).cols
const controlSeen = []
{
  const t0 = Date.now()
  await page.evaluate(() => window.__game.fire())
  while (Date.now() - t0 < 1200) {
    const raw = await columnProfile(CONTROL)
    const c = mostChanged(raw.cols, controlBase, raw.items)
    if (c.peak > 40) controlSeen.push({ t: Date.now() - t0, x: c.x, peak: c.peak })
  }
}
const controlMoved = travelled(controlSeen)
if (!controlMoved) {
  ok(
    `control region: no travelling streak while firing ` +
      `(${controlSeen.length} bright sample(s), none of them moving)`,
  )
} else {
  fail(
    `a streak travelled ${controlMoved.dx} px across the CONTROL region too — the whole ` +
      'screen is moving and the lane measurement proves nothing',
  )
}

await shot('bullets-visible')

// --- the control that stops a muzzle flash passing ------------------------
//
// Fire the OTHER way. Nothing crosses the strip, so a check that would pass on
// the flash at the player — or on any once-per-shot brightening anywhere — fails
// here. Without this, "the patch lit up when I pulled the trigger" is the whole
// measurement, and that is true of a hitscan build too.
await standStill(page)
await aimAlongLane(-1)

// **A fresh baseline**, taken now rather than reused.
//
// The first version compared against the frame captured before any shooting, and
// failed: it reported +110 at a *fixed* column for thirteen consecutive samples
// over 1.3 s. That is not a round — a round moves and is gone inside a second.
// It was the **crater** the earlier shots left, a permanent difference from a
// stale baseline. A control has to be measured against the scene as it is, not
// as it was.
const awayBase = (await columnProfile(STRIP)).cols
const wrongWay = (await trackOneShot('fired away', awayBase)).seen
const wrongWayMoved = travelled(wrongWay)
if (!wrongWayMoved) {
  ok(
    `control: firing away puts no travelling streak in the lane ` +
      `(${wrongWay.length} static bright sample(s), none of them moving)`,
  )
} else {
  fail(
    `firing AWAY still produced a travelling streak in the lane ` +
      `(${wrongWayMoved.dx} px in ${wrongWayMoved.dt} ms) — the signal is not the round, ` +
      'and a muzzle flash or a passing bot would pass this check',
  )
}

if (pageErrors.length) fail(`page errors: ${pageErrors.slice(0, 3).join(' | ')}`)
else ok('no page errors')

await stack.close()
runDayLeg(fail)
console.log(failures.length ? `\nbullets-visible: ${failures.length} FAILED` : '\nbullets-visible: ok')
process.exit(failures.length ? 1 : 0)
