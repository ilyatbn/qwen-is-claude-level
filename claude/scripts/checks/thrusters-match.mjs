#!/usr/bin/env node
/**
 * T22.04B F2/F3 — the thruster plume in a **real** match, and never outside space.
 *
 *   node scripts/checks/thrusters-match.mjs
 *
 * `thrusters` proves the picture in the sandbox, which builds its `PlayerView`s
 * with its own flags. `GameScene` builds them with four bindings no sandbox run
 * reaches, and the T22.04 review found every one unguarded:
 *
 *  - `this.gravity`, off `lobby_state` — the only way a networked client knows
 *    the round is zero-g;
 *  - `space:` at the **local** `setState`, and `space:` at the **remote** one;
 *  - `jetpack: moveState === 2 && this.meAlive` — the local view's `alive` is a
 *    literal `true`, and the mirror stops stepping a dead body, so without the
 *    `&& meAlive` a player killed mid-burn goes on firing until the respawn.
 *
 * Read through `debug().plumes`, which is read off the views themselves.
 *
 * ## The arms, and the control for each
 *
 * 1. **Space, a remote** (stack A, room 1): bo holds DOWN; **ana's** scene draws
 *    bo's plume, pointing up. bo's own view draws his, the same way. The control
 *    is the frame before, with nothing held: the entry exists and is not drawn.
 * 2. **Letting go** stops it on both clients. Arm 1 is its presence control.
 * 3. **The round-over bell** (F3): bo burns across it. The last frame before the
 *    bell draws his plume; the frames after it do not, with DOWN still held and
 *    fuel still in the tank — so it is the bell and not an empty tank.
 * 4. **Standard gravity** (stack A, room 2): dee holds the jetpack; neither
 *    client draws a plume. Arm 1 is its presence control — the same scene code,
 *    one lobby setting apart.
 * 5. **Death mid-burn** (stack B, `DEV_POISONED`): fay burns away from her rock
 *    until the poison kills her; the last live frame draws her plume, the dead
 *    ones do not.
 *    Poison because it kills wherever you are — a space map has a closed rim, so
 *    there is no void, and a self-rocket needs ground under the feet.
 */
import { startStack, freePort, tally, shotsDir } from './harness.mjs'
import { constants as rustConstants } from '../lib/rust-constants.mjs'
import { key as clientKey } from '../lib/client-keys.mjs'
import { deadlineMs } from '../lib/deadline.mjs'
import { join } from 'node:path'

const { fail, ok, finish } = tally('thrusters-match')
const K = rustConstants()
const NAME_KEY = clientKey('NAME_KEY')

/**
 * How long before the bell bo starts to burn (T22.10E review, (b)). It was 3 s,
 * long enough for UP to carry him into the first rock overhead and park him
 * there — measured `v 0.0, 0.0` at the bell in a green run — and a parked body
 * cannot show a rubber-band. A second is a burn still accelerating in open air
 * when the bell rings (half a second, the review's suggestion, left too little to
 * turn round in under load — below); the arm now *requires* that (a speed floor
 * at the last pre-bell frame) instead of hoping. The tank cannot run dry in it —
 * asserted against the fuel and `JETPACK_DRAIN`, not assumed.
 */
const BELL_LEAD_S = 1
/** Rendered frames after an edge (release, bell, death) before reading the views. */
const SETTLE_FRAMES = 6
/**
 * Room 1's round. Long enough for arms 1–2 after the clients load; the bell arm
 * waits for it, so a longer round only costs time.
 */
const ROUND_S = 25
/**
 * The bell arm's vertical thrust. Grounded, UP — the only push a grounded
 * player's thrusters engage for (T22.10E F-5, R42). Airborne, **toward the map's
 * vertical middle**, as the side key is toward its horizontal middle: UP alone
 * parked him under the first rock above, and DOWN alone parked him once too
 * (measured `v 0.0, 0.0` at the bell, 2 runs of 5 across both); the open sky is
 * the middle, and the rim closes the edges. The arm then *requires* him moving at
 * the bell (below) rather than leaning on the chance.
 */
const bellThrust = (p, mapH) => (p.grounded === true || p.y > mapH / 2 ? 'w' : 's')
/** How long after the bell the bell arm watches bo's own prediction (F-3). */
const AFTER_BELL_S = 3
/** Seconds of thrust before the poison kills fay — see the death arm. */
const DEATH_BURN_S = 1.5

const dbg = (c) =>
  c.page.evaluate(() => {
    try {
      return window.__game ? window.__game.debug() : null
    } catch {
      return null
    }
  })
const frames = (c, n) =>
  c.page.evaluate(
    (count) =>
      new Promise((resolve) => {
        let left = count
        const tick = () => (--left <= 0 ? resolve() : requestAnimationFrame(tick))
        requestAnimationFrame(tick)
      }),
    n,
  )
/**
 * Every rendered frame on `c` until `afterS` past the bell (T22.10E F-3/F-5): the
 * last frame before it (`pre`) and the correction jump of each snapshot that
 * corrected after it (`post`, in order), with the most inputs pending. `null` if
 * the bell never rings within `limitS`.
 */
const watchBell = (c, afterS, limitS) =>
  c.page.evaluate(
    ([after, limit]) =>
      new Promise((resolve) => {
        const out = { pre: null, post: [], hitches: 0, pendingMax: 0, pendingPre: 0, frames: 0, travelled: 0 }
        let from = null
        let corr = null
        let settled = 0
        let rang = null
        const t0 = performance.now()
        const tick = (t) => {
          let d = null
          try {
            d = window.__game?.debug() ?? null
          } catch {
            d = null
          }
          const v = d?.vortex
          if (d && v) {
            if (d.phase === 'playing') {
              out.pendingPre = Math.max(out.pendingPre, d.pendingInputs ?? 0)
              out.pre = {
                moveState: d.player?.moveState,
                grounded: d.player?.grounded,
                vx: d.player?.vx,
                vy: d.player?.vy,
                drawn: !!d.plumes?.[d.me]?.drawn,
              }
            } else if (d.phase === 'ended') {
              rang ??= t
              out.frames++
              if (d.player) {
                from ??= { x: d.player.x, y: d.player.y }
                out.travelled = Math.hypot(d.player.x - from.x, d.player.y - from.y)
              }
              // A correction the predictor counted as an event (`settled`: lost
              // time, a relocation) is the hitch's, not a misprediction (T22.10F).
              if (corr !== null && v.corrections > corr) {
                if ((v.settled ?? 0) > settled) out.hitches++
                else out.post.push(v.lastJumpPx)
              }
              out.pendingMax = Math.max(out.pendingMax, d.pendingInputs ?? 0)
            }
            corr = v.corrections
            settled = v.settled ?? 0
          }
          if (rang !== null && t - rang > after * 1000) resolve(out)
          else if (t - t0 > limit * 1000) resolve(null)
          else requestAnimationFrame(tick)
        }
        requestAnimationFrame(tick)
      }),
    [afterS, limitS],
  )
/** Wait on a page predicate; `false` on timeout, never a throw. */
const waitOn = (c, fn, arg, seconds, why) =>
  c.page
    .waitForFunction(fn, arg, { timeout: deadlineMs(seconds, why), polling: 'raf' })
    .then(() => true)
    .catch(() => false)

async function openAtMenu(stack, name) {
  const ctx = await stack.browser.newContext({ viewport: { width: 1280, height: 720 } })
  const page = await ctx.newPage()
  const errors = []
  page.on('pageerror', (e) => errors.push(String(e)))
  await page.goto(`${stack.viteUrl}/?e2e=1&menu=1&name=${name}`)
  await page.waitForFunction('!!window.__menu', null, { timeout: 60_000 })
  await page.evaluate((k) => localStorage.setItem(k[0], k[1]), [NAME_KEY, name])
  return { page, errors, name, id: -1 }
}

/**
 * Two humans in a private room at `gravity` (the lobby's label), in the game.
 * Stepped through `__menu.step`, the route a player's arrow takes (`lobby.mjs`).
 */
async function privateMatch(stack, [hostName, guestName], gravity) {
  const host = await openAtMenu(stack, hostName)
  await host.page.evaluate(() => document.querySelector('#private')?.click())
  await host.page.evaluate(() => document.querySelector('#host')?.click())
  await host.page.waitForFunction('window.__menu.visibleCode().length === 6', null, { timeout: 30_000 })
  const code = await host.page.evaluate('window.__menu.visibleCode()')
  const guest = await openAtMenu(stack, guestName)
  await guest.page.evaluate(() => document.querySelector('#private')?.click())
  await guest.page.evaluate(() => document.querySelector('#join')?.click())
  await guest.page.evaluate((c) => {
    const input = document.querySelector('#code')
    input.value = c
    input.dispatchEvent(new Event('input', { bubbles: true }))
    document.querySelector('#go')?.click()
  }, code)
  await guest.page.waitForFunction('window.__menu.roster().length > 0', null, { timeout: 30_000 })
  const seen = (c) => c.page.evaluate(() => window.__menu.settings().gravity.value)
  for (let i = 0; i < 3 && (await seen(host)) !== gravity; i++) {
    const was = await seen(host)
    await host.page.evaluate(() => window.__menu.step('gravity', 1))
    await host.page
      .waitForFunction((v) => window.__menu.settings().gravity.value !== v, was, { timeout: 10_000 })
      .catch(() => {})
  }
  // The guest's panel is fed by `lobby_state` alone, so this is the wire's word.
  const guestOk = await guest.page
    .waitForFunction((v) => window.__menu.settings().gravity.value === v, gravity, { timeout: 20_000 })
    .then(() => true)
    .catch(() => false)
  if (!guestOk) throw new Error(`gravity never reached "${gravity}" on the guest: host "${await seen(host)}", guest "${await seen(guest)}"`)
  await host.page.evaluate(() => window.__menu.ready(true))
  await guest.page.evaluate(() => window.__menu.ready(true))
  for (const c of [host, guest]) {
    await c.page.waitForFunction('window.__game && window.__game.debug().ready === true', null, { timeout: 60_000 })
    c.id = (await dbg(c)).me
  }
  // Each sees the other drawn, so `plumes[other]` below is a view, not a gap.
  for (const [a, b] of [[host, guest], [guest, host]]) {
    const saw = await waitOn(a, (id) => (window.__game.debug().plumes ?? {})[id] !== undefined, b.id, 30, 'remote view')
    if (!saw) throw new Error(`${a.name} never drew ${b.name}: plumes ${JSON.stringify((await dbg(a))?.plumes)}`)
  }
  ok(`${hostName} and ${guestName} are in a ${gravity} match (seats ${host.id}, ${guest.id})`)
  return [host, guest]
}

const plumeOf = async (viewer, subject) => (await dbg(viewer))?.plumes?.[subject.id]
const brief = (d, c) => ({
  phase: d?.phase,
  moveState: d?.player?.moveState,
  vy: d?.player?.vy?.toFixed(1),
  fuel: d?.player?.fuel?.toFixed(2),
  meAlive: d?.death?.meAlive,
  health: d?.health,
  mine: d?.plumes?.[c.id],
})

// ============================================================================
// Stack A — a space room, then a standard room.
// ============================================================================
const stackA = await startStack({
  port: await freePort(),
  label: 'thrusters-match',
  env: {
    BOT_COUNT: '0',
    FIXED_SEED: '4242',
    WEATHER: 'off',
    DEV_WARMUP_SECONDS: '2',
    ROUND_SECONDS: String(ROUND_S),
  },
})

try {
  const [ana, bo] = await privateMatch(stackA, ['ana', 'bo'], 'Space')

  // --- arm 1: a remote's plume, pointing up, on the other client ----------
  const idle = await plumeOf(ana, bo)
  if (!idle || idle.drawn !== false) fail(`control: before anything is held, ana's view of bo reads ${JSON.stringify(idle)}`)
  else ok('control: nothing held, and ana draws no plume on bo')

  // Both ends waited on at once, each on its own page, so a plant that breaks
  // one of them cannot make the other read late and fail with it.
  const upOn = (id) => {
    const p = window.__game.debug().plumes?.[id]
    return !!p && p.drawn && p.dir.y < -0.5
  }
  await bo.page.keyboard.down('s')
  const [sawRemote, sawLocal] = await Promise.all([
    waitOn(ana, upOn, bo.id, 15, 'remote plume'),
    waitOn(bo, upOn, bo.id, 15, 'local plume'),
  ])
  const boNow = await dbg(bo)
  const anaView = await plumeOf(ana, bo)
  await ana.page.screenshot({ path: join(shotsDir, 'thrusters-match-remote.png') })
  await bo.page.keyboard.up('s')
  if (!sawRemote) {
    fail(`bo held DOWN in space and ana's scene never drew his plume pointing up: ana sees ${JSON.stringify(anaView)}, bo ${JSON.stringify(brief(boNow, bo))}`)
  } else ok(`bo holds DOWN: ana's scene drew bo's plume pointing up`)
  if (!sawLocal) fail(`bo held DOWN in space and his own view never drew his plume pointing up: ${JSON.stringify(brief(boNow, bo))}`)
  else ok(`bo's own view drew it too, pointing up`)

  // --- arm 2: letting go ---------------------------------------------------
  const boOff = await waitOn(bo, (id) => window.__game.debug().plumes?.[id]?.drawn === false, bo.id, 5, 'local off')
  const anaOff = await waitOn(ana, (id) => window.__game.debug().plumes?.[id]?.drawn === false, bo.id, 5, 'remote off')
  if (!boOff || !anaOff) {
    fail(`bo let go and a plume stayed: bo ${JSON.stringify(brief(await dbg(bo), bo))}, ana sees ${JSON.stringify(await plumeOf(ana, bo))}`)
  } else ok('bo lets go: neither client draws his plume')

  // --- arm 3: the round-over bell (F3) -------------------------------------
  const lead = await waitOn(
    bo,
    (s) => {
      const d = window.__game.debug()
      return d.phase === 'ended' || (d.phase === 'playing' && d.results.secondsLeft <= s)
    },
    BELL_LEAD_S,
    ROUND_S + 30,
    'bell lead',
  )
  const pre = await dbg(bo)
  if (!lead || pre.phase !== 'playing') {
    fail(`the bell arm could not start before the bell: ${JSON.stringify({ phase: pre?.phase, left: pre?.results?.secondsLeft })}`)
  } else if (!((pre.player?.fuel ?? 0) >= BELL_LEAD_S * K.get('JETPACK_DRAIN') + K.get('JETPACK_MIN_FUEL_TO_ENGAGE'))) {
    // Read before the burn: a tank that cannot outlast the lead could go out on
    // its own, and an unlit plume after the bell would then be the tank, not the bell.
    fail(`control: bo starts the bell burn with ${pre.player?.fuel} fuel, which cannot last ${BELL_LEAD_S} s at ${K.get('JETPACK_DRAIN')}/s`)
  } else {
    ok(`control: bo starts the bell burn with ${pre.player.fuel.toFixed(2)} fuel, enough for ${BELL_LEAD_S} s and the engage floor`)
    // Watched every frame from here to `AFTER_BELL_S` past the bell, in the page:
    // the last pre-bell frame is the precondition (T22.10E F-5) and the frames
    // after it are the rubber-band measure (F-3). Started before the key goes down
    // so no pre-bell frame can be missed.
    const watch = watchBell(bo, AFTER_BELL_S, BELL_LEAD_S + 25)
    // **UP when grounded** (T22.10E F-5; DOWN in the air since T22.10F, see
    // `bellThrust`). This arm held DOWN and failed ~1 run in 6:
    // bo can be standing on a rock or the rim floor when the lead starts, and a
    // grounded player's thrusters engage only for a net *upward* push (`space.rs::
    // engaging`, `M22-RULINGS` R42), so DOWN never lit and the "last burning frame
    // before the bell" control went red. UP engages from the ground and in the air
    // alike, and the claim — the bell puts out a plume whose thrust is still held —
    // does not depend on the direction. The precondition is asserted, not assumed:
    // the last frame before the bell must show bo airborne and burning.
    let side = pre.player.x < pre.mapW / 2 ? 'd' : 'a'
    let vert = bellThrust(pre.player, pre.mapH)
    await bo.page.keyboard.down(vert)
    await bo.page.keyboard.down(side)
    try {
      const burning = await waitOn(
        bo,
        (id) => {
          const d = window.__game.debug()
          return d.phase === 'ended' || !!d.plumes?.[id]?.drawn
        },
        bo.id,
        BELL_LEAD_S + 10,
        'pre-bell burn',
      )
      const before = await dbg(bo)
      if (!burning || before.phase !== 'playing' || !before.plumes?.[bo.id]?.drawn) {
        fail(`control: no burning frame before the bell, so "none after" proves nothing: ${JSON.stringify(brief(before, bo))}`)
      } else {
        ok(`control: bo's plume is lit before the bell (${before.results.secondsLeft.toFixed(2)} s left)`)
        // **Pinned? Burn the other way** (T22.10F). Under the ten-check load the
        // chosen thrust still parked bo against rock in 3 runs of 3 (`v 0.0, 0.0`
        // at the bell) while it never did alone. Every tenth of a second until the
        // bell, a body under the speed floor is against something, and the
        // opposite diagonal is away from it; thrust makes the floor within a few
        // ticks (~500 px/s in a third of a second, measured at the bell).
        const minEarly = K.get('RECONCILE_EPSILON_PX') * K.get('SNAPSHOT_HZ')
        for (let flips = 0; flips < 4; ) {
          await new Promise((r) => setTimeout(r, 100))
          const now = await dbg(bo)
          if (now?.phase !== 'playing') break
          if (Math.hypot(now.player?.vx ?? 0, now.player?.vy ?? 0) >= minEarly) continue
          await bo.page.keyboard.up(vert)
          await bo.page.keyboard.up(side)
          vert = vert === 'w' ? 's' : 'w'
          side = side === 'd' ? 'a' : 'd'
          await bo.page.keyboard.down(vert)
          await bo.page.keyboard.down(side)
          flips++
          ok(`pinned ${now.results.secondsLeft.toFixed(2)} s before the bell (v ${now.player?.vx?.toFixed(1)}, ${now.player?.vy?.toFixed(1)}): burning the other way`)
        }
        const rang = await waitOn(bo, () => window.__game.debug().phase === 'ended', null, BELL_LEAD_S + 15, 'bell')
        await frames(bo, SETTLE_FRAMES)
        const after = await dbg(bo)
        // **Waited on, on ana's own page, not read once.** A remote is drawn off
        // the interpolation buffer, which renders a moment behind the newest
        // snapshot — so a single read taken off *bo's* frame count raced it:
        // measured, one run green and the next red with the plume still lit.
        // Arm 2's release is waited on the same way and for the same reason.
        const anaOut = await waitOn(ana, (id) => window.__game.debug().plumes?.[id]?.drawn === false, bo.id, 5, 'remote off after bell')
        const anaAfter = await plumeOf(ana, bo)
        await bo.page.screenshot({ path: join(shotsDir, 'thrusters-match-bell.png') })
        const seen = await watch
        const last = seen?.pre
        const minSpeed = K.get('RECONCILE_EPSILON_PX') * K.get('SNAPSHOT_HZ')
        if (!rang) fail(`the round never ended: ${JSON.stringify(brief(after, bo))}`)
        else if (
          !last ||
          last.moveState !== 2 ||
          last.grounded !== false ||
          !last.drawn ||
          !(Math.hypot(last.vx, last.vy) >= minSpeed)
        ) {
          // F-5: the frame the bell interrupted must be a burn in the air, or the
          // plume going out after it is the landing, not the bell. And **moving**
          // (T22.10E review (b)): a body pinned against rock drifts nowhere after
          // the bell, so a stale prediction there reads right — at least the speed
          // that carries it past the reconcile epsilon within one snapshot.
          fail(
            `control: the last frame before the bell was not a moving airborne burn ` +
              `(speed floor ${minSpeed} px/s), so the bell arm proves nothing: ${JSON.stringify(last)}`,
          )
        } else {
          ok(
            `control: the last frame before the bell is an airborne burn (moveState 2, v ${last.vx.toFixed(1)}, ` +
              `${last.vy.toFixed(1)}; floor ${minSpeed} px/s)`,
          )
          if (after.plumes?.[bo.id]?.drawn !== false) {
            fail(`the round is over and bo's plume still fires, thrust held: ${JSON.stringify(brief(after, bo))}`)
          } else ok(`the bell rang with thrust held: bo's own plume is out`)
          if (!anaOut) fail(`the round is over and ana still draws bo's plume: ${JSON.stringify(anaAfter)}`)
          else ok("and ana's view of it is out too")
          // **F-3: after the bell the prediction must stop rubber-banding.** The
          // server stops taking input in `Ended` and steps every body a neutral
          // tick; a client that went on predicting from its own inputs grew
          // `pending` without bound and corrected every snapshot. The first
          // correction after the bell is the inputs in flight at the bell, which the
          // server drops (T21.30) — reported, not bounded; every later one must be
          // a right prediction's.
          const [first, ...rest] = seen.post
          const worst = Math.max(0, ...rest)
          const summary =
            `${seen.post.length} corrections in ${AFTER_BELL_S} s after the bell (the first ${first?.toFixed(2) ?? '-'} px), ` +
            `worst later jump ${worst.toFixed(2)} px, pending up to ${seen.pendingMax}` +
            (seen.hitches ? `; ${seen.hitches} lost-time re-anchors not counted` : '')
          // **The gate's epsilon plus the wire's rounding over the watch** (T22.10H).
          // Once bo really moves after the bell (~480 px/s measured) a re-anchored
          // free-flying body drifts from the server's by the velocity's rounding —
          // ≤ √2 · SNAPSHOT_QUANTUM / 2 px/s — for AFTER_BELL_S, on top of the
          // position's own ≤ √2 · SNAPSHOT_QUANTUM / 2. **History:** this was 2 × ε
          // (T22.10F) while the wire truncated to whole px/s, which drifted up to
          // √2 px/s: corrections of 2.11 and 2.58 px were the gate working, and one
          // run at T22.10H's base measured 4.34 px against that 4. At an eighth the
          // drift is a third of a pixel over the watch, and two runs measured 0
          // corrections. F-3's failure this guards was 11–41 px.
          const q = K.get('SNAPSHOT_QUANTUM')
          const eps = K.get('RECONCILE_EPSILON_PX') + (Math.SQRT2 * q * (1 + AFTER_BELL_S)) / 2
          if (seen.frames < 10) fail(`control: only ${seen.frames} frames watched after the bell: ${summary}`)
          else if (!(seen.pendingPre > 0)) {
            // The pending half needs a predictor that was keeping inputs: one
            // that never did reads 0 after the bell with the fix deleted.
            fail(`control: bo's predictor kept no inputs before the bell, so none after proves nothing: ${summary}`)
          }
          else if (worst > eps || seen.pendingMax > Math.ceil(K.get('MAX_FRAME_DT') * K.get('SIM_HZ'))) {
            fail(`the results screen rubber-bands bo's own body: ${summary} (bound ${eps.toFixed(2)} px = RECONCILE_EPSILON_PX + the wire's rounding over ${AFTER_BELL_S} s)`)
          } else ok(`no rubber-band after the bell (bo drifted ${seen.travelled.toFixed(1)} px; ${seen.pendingPre} pending before it): ${summary}`)
        }
      }
    } finally {
      await bo.page.keyboard.up(side)
      await bo.page.keyboard.up(vert)
    }
  }

  // --- arm 4: standard gravity, no plume anywhere ---------------------------
  const [cal, dee] = await privateMatch(stackA, ['cal', 'dee'], 'Standard')
  // Space, not S: under gravity the pack is the jump key held (`hud-bars`).
  await dee.page.keyboard.down('Space')
  try {
    const firing = await waitOn(dee, () => window.__game.debug().player?.moveState === 2, null, 15, 'jetpack')
    if (!firing) fail(`control: dee held the jetpack and it never fired: ${JSON.stringify(brief(await dbg(dee), dee))}`)
    else {
      // Sampled across frames of burning rather than once: a plume is a
      // per-frame toggle, and one sample could land between two draws.
      const seen = { local: [], remote: [], burning: 0 }
      for (let i = 0; i < 10; i++) {
        await frames(dee, 2)
        const d = await dbg(dee)
        if (d.player?.moveState === 2) seen.burning++
        seen.local.push(d.plumes?.[dee.id]?.drawn)
        seen.remote.push((await plumeOf(cal, dee))?.drawn)
      }
      if (seen.burning === 0) fail('control: the jetpack stopped before any sample')
      else if (seen.local.some((v) => v !== false) || seen.remote.some((v) => v !== false)) {
        fail(`standard gravity, jetpack firing, and a plume is drawn: dee ${JSON.stringify(seen.local)}, cal sees ${JSON.stringify(seen.remote)}`)
      } else ok(`standard gravity: dee burns (${seen.burning}/10 samples) and neither client draws a plume`)
    }
  } finally {
    await dee.page.keyboard.up('Space')
  }

  for (const c of [ana, bo, cal, dee]) if (c.errors.length) fail(`${c.name} page errors: ${c.errors.join(' | ')}`)
} catch (e) {
  fail(`stack A: ${e?.stack ?? e}`)
} finally {
  await stackA.close()
}

// ============================================================================
// Stack B — a space room where the poison kills, for the `&& meAlive` half.
// ============================================================================
const stackB = await startStack({
  port: await freePort(),
  label: 'thrusters-match-death',
  env: {
    BOT_COUNT: '0',
    FIXED_SEED: '4242',
    WEATHER: 'off',
    DEV_WARMUP_SECONDS: '2',
    DEV_POISONED: '1',
    // A short first life, so the burn below is not waiting on a full tank of health.
    DEV_START_HEALTH: '20',
  },
})

try {
  const [eve, fay] = await privateMatch(stackB, ['eve', 'fay'], 'Space')
  // Burn for the last `DEATH_BURN_S` of her life only: long enough that the mirror
  // has lit the pack before the poison lands, short enough that she is still in
  // open space when it does (a long burn at full thrust risks the next rock). Inside
  // the tank either way — `burnable` is what a full one gives, less a second.
  const burnable = K.get('JETPACK_MAX_FUEL') / K.get('JETPACK_DRAIN') - 1
  if (!(DEATH_BURN_S < burnable)) throw new Error(`a ${DEATH_BURN_S} s burn does not fit a ${burnable} s tank`)
  const threshold = K.get('TOXIC_POISON_DPS') * DEATH_BURN_S
  const life = K.get('BASE_HEALTH') / K.get('TOXIC_POISON_DPS') + K.get('RESPAWN_DELAY')
  const close = await waitOn(
    fay,
    (t) => {
      const d = window.__game.debug()
      return d.death.meAlive && d.health > 0 && d.health <= t
    },
    threshold,
    2 * life + 10,
    'close to death',
  )
  // **Away from the nearest rock, not DOWN.** Measured: a body spawned on a rock
  // and thrusting into it flaps between burning and standing, and the mirror took
  // her last live tick standing — so she died with the pack already off and the
  // `&& meAlive` plant went green. Out in open space the pack stays lit to the
  // end, which is the case the guard exists for. The field points at the rock
  // (`R67`'s accessor, the server's own sum), so push the other way.
  const key = await fay.page.evaluate(() => {
    const g = window.__game
    const p = g.debug().player
    const [fx, fy] = g.core.fieldAccelAt(p.x, p.y)
    if (Math.abs(fy) >= Math.abs(fx)) return fy > 0 ? 'w' : 's'
    return fx > 0 ? 'a' : 'd'
  })
  if (!close) fail(`fay never came within ${threshold} health of the poison: ${JSON.stringify(brief(await dbg(fay), fay))}`)
  else {
    await fay.page.keyboard.down(key)
    try {
      const lit = await waitOn(
        fay,
        (id) => {
          const d = window.__game.debug()
          return !d.death.meAlive || !!d.plumes?.[id]?.drawn
        },
        fay.id,
        10,
        'burn before death',
      )
      const before = await dbg(fay)
      if (!lit || !before.death.meAlive || !before.plumes?.[fay.id]?.drawn) {
        fail(`control: no live burning frame before fay died: ${JSON.stringify(brief(before, fay))}`)
      } else {
        ok(`control: fay burns alive at ${before.health.toFixed(1)} health, plume drawn`)
        // **Eve's view lit, the control for eve's view out** (T22.09A review, F5):
        // without it "eve draws no plume after the death" holds for an eve who never
        // drew one. Only a live burn draws a remote plume, so a true here was taken
        // before the death whenever the wait happens to return.
        const eveLit = await waitOn(eve, (id) => !!window.__game.debug().plumes?.[id]?.drawn, fay.id, 5, 'eve sees the burn')
        if (!eveLit) fail(`control: eve never drew fay's burning plume: ${JSON.stringify(await plumeOf(eve, fay))}`)
        else ok("control: eve draws fay's plume while she burns")
        const died = await waitOn(fay, () => !window.__game.debug().death.meAlive, null, burnable + 5, 'death')
        await frames(fay, SETTLE_FRAMES)
        const after = await dbg(fay)
        // **Waited on, on eve's own page, not read once** — the remote is drawn off
        // the interpolation buffer, and the bell arm measured a single read racing it.
        const eveOut = await waitOn(eve, (id) => window.__game.debug().plumes?.[id]?.drawn === false, fay.id, 5, 'remote off after death')
        const eveSees = await plumeOf(eve, fay)
        await fay.page.screenshot({ path: join(shotsDir, 'thrusters-match-dead.png') })
        if (!died) fail(`the poison never killed fay: ${JSON.stringify(brief(after, fay))}`)
        else if (after.player?.moveState !== 2) {
          // The mirror stops stepping a dead body, so her last live moveState is what
          // it keeps. Anything but 2 and the view is dark without `&& meAlive` —
          // the absence below would then say nothing about that guard.
          fail(`control: fay died with moveState ${after.player?.moveState}, not 2, so the \`&& meAlive\` guard is untested: ${JSON.stringify(brief(after, fay))}`)
        } else if (after.death.meAlive) fail(`fay respawned before the dead frames were read: ${JSON.stringify(brief(after, fay))}`)
        else if (after.plumes?.[fay.id]?.drawn !== false) {
          fail(`fay is dead with thrust held and her own view still fires her plume: ${JSON.stringify(brief(after, fay))}`)
        } else ok(`fay died mid-burn, thrust held: her plume is out (moveState ${after.player?.moveState})`)
        if (died && (!eveOut || eveSees?.drawn !== false)) fail(`eve still draws dead fay's plume: ${JSON.stringify(eveSees)}`)
        else if (died) ok("and eve's view of her is out too")
      }
    } finally {
      await fay.page.keyboard.up(key)
    }
  }
  for (const c of [eve, fay]) if (c.errors.length) fail(`${c.name} page errors: ${c.errors.join(' | ')}`)
} catch (e) {
  fail(`stack B: ${e?.stack ?? e}`)
} finally {
  await stackB.close()
}

await finish()
