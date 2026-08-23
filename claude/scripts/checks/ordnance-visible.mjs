#!/usr/bin/env node
/**
 * `ordnance-visible` — §C4/§C23: you must be able to see what you fired, **in the
 * game**, for **both** delivery kinds.
 *
 *   node scripts/checks/ordnance-visible.mjs
 *   node scripts/e2e.mjs ordnance-visible
 *
 * ## Why this check was rewritten
 *
 * T13.03 shipped visible ordnance with this check **passing**, and guns and
 * rockets were still invisible in play. §C23 says what that means: the test was
 * sampling something the player is not looking at. It was doing so twice over.
 *
 * 1. **It ran on `?sandbox=1`.** `SandboxScene` calls
 *    `this.world.ordnance.update(dt)` itself; `GameScene` called
 *    `this.world.update(centre)` with `dt` defaulting to 0, and `WorldView.update`
 *    gates its ordnance work on `dt > 0`. So the layer holding every projectile
 *    was never redrawn in a real round — its `Graphics` is only ever filled inside
 *    `update()` — while the sandbox drew them perfectly. The check passed against
 *    the one scene that did not have the bug.
 * 2. **It only ever fired a bazooka.** A rocket is a projectile and a gun is a
 *    hitscan tracer, and they take different paths through different producers.
 *    "Ordnance is visible" was asserted for one of the two kinds, so the tracer
 *    path was never covered at all.
 *
 * So this runs against a **real server** through the shared harness, fires one
 * weapon of each kind, and asserts on rendered pixels for each — with a control
 * region and, for the projectile, a control *frame*.
 *
 * ## What each assertion rules out
 *
 * Both-ends counters first, because they name the failure precisely: the server's
 * narration against what the layer actually holds. Then pixels, because a counter
 * saying a projectile is tracked is exactly what was true for the whole period the
 * screen was empty (§A15).
 */
import { samplePatch, colourDelta } from './pixels.mjs'
import {
  startStack,
  enterBattle,
  standStill,
  selectWeapon,
  tally,
  sleep,
} from './harness.mjs'

const PORT = 3123
const { fail, ok, failures } = tally('ordnance-visible')

// No bots: this counts what *we* fired, and a bot's rockets would make both the
// counters and the patch ambiguous about whose ordnance is on screen.
const stack = await startStack({
  port: PORT,
  label: 'ordnance-visible',
  env: { ROUND_SECONDS: '180', BOT_COUNT: '0', DEV_LOADOUT: '1', FIXED_SEED: '4242' },
})
const { page, dbg, shot, pageErrors } = await stack.openClient({ name: 'ana' })
await enterBattle(page, { waitPlaying: true, label: 'ordnance-visible' })

const K = await page.evaluate(() => window.__game.constants())
for (const [name, v] of Object.entries({
  TRACER_LIFETIME: K.TRACER_LIFETIME,
  PLAYER_W: K.PLAYER_W,
})) {
  // §B15: a threshold compared against `undefined` is false forever, and a wait
  // built on one can never succeed. Check the instrument before using it.
  if (!Number.isFinite(v)) fail(`${name} is not exposed to the client — nothing below can hold`)
}

/** Where a world point is on screen, or null if it is off camera. */
const screenPos = async (w) => {
  const d = await dbg()
  const sx = (w.x - d.worldView.x) * d.zoom
  const sy = (w.y - d.worldView.y) * d.zoom
  return sx > 0 && sx < 1280 && sy > 0 && sy < 720 ? { sx, sy } : null
}

/**
 * A patch of frame that nothing we fire should touch, **picked by content**.
 *
 * The top-left corner used to be it, on the reasoning that it is sky above the
 * play area. Sky is the one thing on this screen that changes on its own: the
 * gradient and the sun move with the round clock, and once the camera sat over
 * open ground that corner drifted 18 points between two frames a second apart —
 * which lifts `floor = controlDelta * 3` to 55 and fails a rocket that moved its
 * own patch by a perfectly visible amount.
 *
 * Terrain does not animate. This finds a square of solid rock away from the
 * player and uses that, and says so if there is none.
 */
const findControl = async () => {
  const r = await page.evaluate(() => {
    const d = window.__game.debug()
    const raw = d.worldView
    const v = { x: raw.x, y: raw.y, w: raw.width ?? raw.w, h: raw.height ?? raw.h }
    const core = window.__game.core
    const cv = document.querySelector('canvas')
    const rect = cv.getBoundingClientRect()
    const size = 60
    const wpp = v.w / rect.width
    const step = 40
    for (let sy = 40; sy < rect.height - size - 40; sy += step) {
      for (let sx = 20; sx < rect.width - size - 20; sx += step) {
        const wx = v.x + sx * wpp
        const wy = v.y + sy * wpp
        // Away from the player, so nothing we fire passes through it.
        if (Math.hypot(wx - d.player.x, wy - d.player.y) < 320) continue
        let solid = true
        for (let dx = 0; dx <= size && solid; dx += 12) {
          for (let dy = 0; dy <= size && solid; dy += 12) {
            solid = core.solidAt(Math.round(wx + dx * wpp), Math.round(wy + dy * wpp))
          }
        }
        if (solid) return { x: Math.round(sx), y: Math.round(sy), w: size, h: size }
      }
    }
    return null
  })
  return r
}

// --- the control: nothing of ours is on screen yet --------------------------
//
// Without this, "a tracer is drawn after firing" also passes for a layer that
// draws one unconditionally, which is the §A26 half that makes the rest mean
// something.
const CONTROL = await findControl()
if (!CONTROL) {
  fail('no patch of solid rock on the frame to use as the noise control')
}
const idle = await dbg()
if ((idle.tracersDrawn ?? -1) === 0 && (idle.projectilesDrawn ?? -1) === 0) {
  ok('control: no tracer and no projectile drawn before anything is fired')
} else {
  fail(
    `something was already drawn: tracers ${idle.tracersDrawn}, projectiles ${idle.projectilesDrawn}`,
  )
}

// --- hitscan: the smg ------------------------------------------------------
//
// A tracer lives TRACER_LIFETIME (0.09 s), so it is sampled by *polling as fast
// as the page answers* rather than after a sleep — a 200 ms wait misses it
// entirely and would report "never drawn" for a tracer that was.
await selectWeapon(page, 'smg')
await standStill(page)
const beforeShots = (await dbg()).observed?.hitscans ?? 0
const controlBeforeTracer = await samplePatch(page, CONTROL)

// Aim flat and to the right of **the player**, not of the screen centre.
//
// The player is only at the screen centre while the camera is free; at a map
// edge it clamps, and then a fixed (1150, 360) points somewhere above or below
// them. The tracer then never crosses the patch this check samples beside the
// muzzle, and the reading comes out at 12.5 against a floor of 20.5 — a true
// measurement of a tracer that went the other way.
const aimRight = async (dy = 0) => {
  const at = await page.evaluate((up) => {
    const d = window.__game.debug()
    const raw = d.worldView
    const v = { x: raw.x, y: raw.y, w: raw.width ?? raw.w, h: raw.height ?? raw.h }
    const cv = document.querySelector('canvas')
    const r = cv.getBoundingClientRect()
    const m = 60
    const wx = Math.min(d.player.x + 300, v.x + v.w - m)
    const wy = Math.max(d.player.y + up, v.y + m)
    return {
      x: r.left + ((wx - v.x) / v.w) * r.width,
      y: r.top + ((wy - v.y) / v.h) * r.height,
    }
  }, dy)
  await page.mouse.move(at.x, at.y)
  await sleep(150)
}
await aimRight()

let tracerPeak = 0
let tracerFrame = null
let narrated = 0
for (let burst = 0; burst < 12 && !tracerFrame; burst++) {
  await standStill(page)
  await aimRight()
  await page.evaluate('window.__game.fire()')
  for (let i = 0; i < 14; i++) {
    const d = await dbg()
    narrated = Math.max(narrated, (d.observed?.hitscans ?? 0) - beforeShots)
    if ((d.tracersDrawn ?? 0) > 0) {
      tracerPeak = Math.max(tracerPeak, d.tracersDrawn)
      // **Freeze first, ask questions after.** A tracer's alpha decays as
      // `life / TRACER_LIFETIME`, so every round trip between spotting one and
      // photographing it costs brightness. The first version read the player's
      // position (a second `debug()` call) and then froze, and the reading
      // swung between 6.0 and 16.2 depending on how much of the 0.09 s had run
      // out — a floor of 4.0 against a signal that can read 6.0 is the coin
      // flip §A28 is about. Freezing stops the decay, so the position, the
      // tracer and the photograph are all the same instant.
      await page.evaluate(() => window.__game.freeze(true))
      const still = await dbg()
      const me = still.player
      if ((still.tracersDrawn ?? 0) > 0 && me) {
        const sx = (me.x - still.worldView.x) * still.zoom
        const sy = (me.y - still.worldView.y) * still.zoom
        if (sx > 0 && sx < 1280 && sy > 0 && sy < 720) {
          // A BAND ALONG THE BEAM, not a box around it. The shot runs
          // near-horizontally from the muzzle toward the aim point, so a
          // 130x90 box is mostly sky either side of a 2 px line. Thirty-four
          // pixels tall, centred on the muzzle's own row, is the beam and
          // little else. Sampled beside the muzzle rather than on it: the
          // player's own sprite is drawn there and would supply the difference
          // by itself.
          tracerFrame = {
            patch: {
              x: Math.round(Math.min(1280 - 140, sx + 40)),
              y: Math.round(Math.max(0, sy - 17)),
              w: 130,
              h: 34,
            },
          }
          tracerFrame.during = await samplePatch(page, tracerFrame.patch)
          await shot('ordnance-tracer')
        }
      }
      await page.evaluate(() => window.__game.freeze(false))
      if (tracerFrame) break
    }
    await sleep(20)
  }
  if (!tracerFrame) await sleep(150)
}

// Both ends, for the hitscan kind (§A39).
if (narrated > 0) ok(`hitscan: the server narrated ${narrated} shot(s)`)
else fail('the server narrated no hitscan at all — nothing about tracers has been tested')
if (tracerPeak > 0) {
  ok(`hitscan: the layer held ${tracerPeak} tracer(s) — both ends agree`)
} else {
  fail(
    `the server narrated ${narrated} hitscan shot(s) and the layer held 0 tracers — ` +
      'the tracer path does not reach a layer that draws',
  )
}

if (tracerFrame) {
  // The control frame: the same patch once the tracer has decayed. Same camera,
  // same light, a fraction of a second later — the only thing that left it is
  // the tracer.
  await sleep(400)
  await page.evaluate(() => window.__game.freeze(true))
  const after = await samplePatch(page, tracerFrame.patch)
  await page.evaluate(() => window.__game.freeze(false))
  const controlAfter = await samplePatch(page, CONTROL)
  const delta = colourDelta(tracerFrame.during, after)
  const controlDelta = colourDelta(controlBeforeTracer, controlAfter)
  const floor = Math.max(4, controlDelta * 3)
  if (delta > floor) {
    ok(`hitscan: the tracer moved its patch by ${delta.toFixed(1)} (floor ${floor.toFixed(1)}, control ${controlDelta.toFixed(1)})`)
  } else {
    fail(
      `the tracer moved its patch by only ${delta.toFixed(1)} against a floor of ` +
        `${floor.toFixed(1)} — it is counted but not visible`,
    )
  }
} else {
  fail('no frame was captured with a tracer in it, so the pixel assertion did not run')
}

// --- projectile: the bazooka -----------------------------------------------
await selectWeapon(page, 'bazooka')
await standStill(page)
// Up and to the right, not flat. A rocket fired level detonates on the first
// thing beside the player — measured at three frames of flight, which is short
// enough that the layer may never be told about it and short enough that the
// patch is a crater rather than a rocket. An arc through open sky gives the
// projectile a life to be photographed during.
await aimRight(-200)
await sleep(150)
const controlBeforeProj = await samplePatch(page, CONTROL)

let projFrame = null
let projLive = 0
let projDrawn = 0
// Both ends compared **within one sample**. `syncProjectiles` runs in the
// scene's update, so the mirror gains a projectile up to a frame before the
// layer is told — taking the max of each counter separately across a poll would
// compare a live count from one instant with a drawn count from another, and
// report a gap that is only the frame between them.
let agreedAt = 0
for (let burst = 0; burst < 6 && !projFrame; burst++) {
  await standStill(page)
  await page.evaluate('window.__game.fire()')
  for (let i = 0; i < 30; i++) {
    const d = await dbg()
    projLive = Math.max(projLive, d.projectilesLive ?? 0)
    projDrawn = Math.max(projDrawn, d.projectilesDrawn ?? 0)
    if ((d.projectilesLive ?? 0) > 0 && d.projectilesDrawn === d.projectilesLive) {
      agreedAt = Math.max(agreedAt, d.projectilesLive)
    }
    if ((d.projectilesLive ?? 0) > 0) {
      // Freeze first, for the same reason as the tracer above and one more: a
      // rocket travels. Reading its position and *then* pausing computes a
      // patch for where it was a round trip ago, and at BAZOOKA_SPEED that is
      // enough to put it outside a 70 px box — which read 6.7 on one run and
      // 26.5 on the next from identical code.
      await page.evaluate(() => window.__game.freeze(true))
      const still = await dbg()
      // The DRAWN position, not the mirror's — see `drawnProjectiles` in the
      // debug handle. Falling back to the mirror would reintroduce the bug this
      // line exists to avoid, so there is no fallback.
      const p = (still.drawnProjectiles ?? [])[0]
      // Photograph only once the LAYER has it, not merely the mirror.
      //
      // Freezing pauses the scene, so the frame on screen is whichever one was
      // last rendered. `syncProjectiles` runs inside that update, immediately
      // before `world.update` redraws — so if the freeze lands between the
      // socket delivering `projectile_spawn` and the next update, the mirror
      // knows about a rocket that the last rendered frame does not contain. The
      // patch is then computed for a position with nothing drawn at it, and the
      // reading collapses: one run in three came out at 1.2 against a floor of
      // 4.0, which looks exactly like the bug this check exists to catch.
      // `projectilesDrawn` counts the STATE MAP, which `syncProjectiles` fills
      // — it read 1 live / 1 drawn for the entire period in which no rocket had
      // ever been drawn (§A15), so it cannot answer "is it on the canvas". What
      // can is `projectilesLastFrame`: what the layer's most recent *redraw*
      // put there. If the last rendered frame predates the rocket, this is 0
      // and the patch would be computed for empty sky — which is the 1.2 this
      // check kept reading against a floor of 4.0.
      const caughtUp =
        (still.projectilesLastFrame ?? 0) > 0 &&
        (still.projectilesDrawn ?? 0) === (still.projectilesLive ?? 0)
      if ((still.projectilesLive ?? 0) > 0 && p && caughtUp) {
        const sx = (p.x - still.worldView.x) * still.zoom
        const sy = (p.y - still.worldView.y) * still.zoom
        if (sx > 0 && sx < 1280 && sy > 0 && sy < 720) {
          // Sized ONTO the subject. A bazooka round is `LOOK.bazooka.r` 6 world
          // px plus a 12-sample trail, which at zoom 2 covers a small fraction
          // of a 120x120 patch — the mean shift came out at 8.1 against a floor
          // of 4.0, and the falsified build once reached 3.7. Two numbers that
          // close is a coin flip, and a gate that fails on one gates nothing
          // (§A28). At 70x70 the rocket is a large enough share to separate the
          // two bands properly.
          projFrame = {
            patch: {
              x: Math.round(Math.max(0, Math.min(1280 - 70, sx - 35))),
              y: Math.round(Math.max(0, Math.min(720 - 70, sy - 35))),
              w: 70,
              h: 70,
            },
          }
          projFrame.during = await samplePatch(page, projFrame.patch)
          await shot('ordnance-projectile')
        }
      }
      await page.evaluate(() => window.__game.freeze(false))
      if (projFrame) break
    }
    await sleep(25)
  }
  if (!projFrame) await sleep(200)
}

if (projLive > 0) ok(`projectile: the server had ${projLive} in the air`)
else fail('nothing was fired, so nothing about projectile visibility has been tested')
if (agreedAt > 0) {
  ok(`projectile: the layer held all ${agreedAt} of them in one sample — both ends agree`)
} else {
  fail(
    `up to ${projLive} projectile(s) alive and at most ${projDrawn} drawn, and never ` +
      'equal in a single sample — exactly the gap that made rockets invisible',
  )
}

if (projFrame) {
  // Wait for it to detonate and clear, then take the same patch again.
  await sleep(2200)
  const after = await samplePatch(page, projFrame.patch)
  const controlAfter = await samplePatch(page, CONTROL)
  const delta = colourDelta(projFrame.during, after)
  const controlDelta = colourDelta(controlBeforeProj, controlAfter)
  const floor = Math.max(4, controlDelta * 3)
  if (delta > floor) {
    ok(`projectile: the rocket moved its patch by ${delta.toFixed(1)} (floor ${floor.toFixed(1)}, control ${controlDelta.toFixed(1)})`)
  } else {
    fail(
      `the rocket moved its patch by only ${delta.toFixed(1)} against a floor of ` +
        `${floor.toFixed(1)} — it is tracked but not drawn`,
    )
  }
} else {
  fail('no frame was captured with a projectile in it, so the pixel assertion did not run')
}

if (pageErrors.length) fail(`page errors: ${pageErrors.slice(0, 3).join(' | ')}`)
else ok('no page errors')

await stack.close()
console.log(failures.length ? `\nordnance-visible: ${failures.length} FAILED` : '\nordnance-visible: ok')
process.exit(failures.length ? 1 : 0)
