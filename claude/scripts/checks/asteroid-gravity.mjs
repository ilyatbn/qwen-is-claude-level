/**
 * T22.11C / `M22-RULINGS` R63 — **an asteroid's gravity well is visible on
 * screen.**
 *
 * `T22.11B` proved the wells nine ways in `game-core` and **not once in a
 * frame**, which is the exact shape `CLAUDE.md`'s rule was written for: *"four 'I
 * cannot see it' bugs shipped past 905 tests because every assertion checked
 * simulation state."* Heavy fog's formula was right for five milestones while
 * nothing carried the number to the screen. So nothing below reads a position
 * out of `debug()` and calls that the claim — every claim is a pair of
 * photographs of the rendered canvas (`docs/72` §C2).
 *
 * ## What is asserted, and what the two controls are
 *
 * The body is placed at rest in open space inside a well, and the frame is
 * photographed in two patches, both pinned to `PLAYER_H` and both placed through
 * the live camera by `toScreen`:
 *
 *  - **subject** — the patch the field points *at*, one travel length down-field
 *    of the start. Empty space before, the drawn body after.
 *  - **control region** — the mirror-image patch the same distance *up*-field,
 *    which the body moves away from. `assertChanged` refuses the case where it
 *    moved too: a frame that changed everywhere says nothing about the subject,
 *    and "the pixels moved" is otherwise true of any canvas with a sky in it.
 *
 * And the **control frame** is the same map, seed, start, camera and moment with
 * the rock's influence taken away — `Core.setAsteroids([])`, which is the setter
 * this task adds, run in reverse. The body must be drawn *not* moving. Without
 * it, "the body drifted" is also true of a scene that drifts bodies for any
 * reason at all; with it, the only difference between the two arms is whether
 * the core has the rocks.
 *
 * ## Which way is down-field is asked of Rust, never computed here
 *
 * `Core.fieldAccelAt` goes through `world::attractors::env_at`, the one
 * composition both the server and the mirror call (R11). Summing the falloff in
 * JavaScript to pick the patches would be the second spelling that rule exists to
 * prevent, and it would agree with itself whatever the core did. It is also why
 * the field direction is read *before* the body moves: a direction derived from
 * the motion could not then be evidence about it.
 *
 * ## No wall-clock sleeps
 *
 * Every wait is `page.waitForFunction` on the thing it is waiting for
 * (`minimap.mjs` is the local model — `T22.05C` took eight `waitForTimeout`s out
 * of it after four checks went red in one gate from box load alone). The control
 * arm is the one place an *absence* has to be given a budget, and that budget is
 * counted in **rendered frames** (`CONTROL_FRAMES`), not in milliseconds: a busy
 * box then gives that arm more simulation rather than less, which is the safe
 * direction for an absence. Its adequacy is measured rather than assumed — the
 * pulled arm reports the frames it needed and fails if the control got fewer —
 * and the pulled arm's own wait is a positive proof the scene was live for both,
 * since a frozen page would satisfy every "unchanged" assertion and then time
 * out there.
 */
import { deadlineMs } from '../lib/deadline.mjs'
import { samplePatch, assertChanged, assertUnchanged, toScreen } from './pixels.mjs'

/**
 * How far down-field the body has to travel, in body heights.
 *
 * Pinned to `PLAYER_H` rather than to pixels so a change to the body's size
 * cannot leave the subject patch overlapping the start. Two is enough that the
 * body at rest (half a body from its centre in any direction) cannot reach the
 * patch, and short enough that the corridor stays clear of rock.
 */
const TRAVEL_BODIES = 2

/**
 * How much air, in body heights, the run needs around it on every side.
 *
 * See the search below: without this the fixture picked a point one body above
 * the arena floor and photographed a landing.
 */
const CLEAR_BODIES = 1

/**
 * The control arm's budget, in **rendered frames**.
 *
 * A frame count and not a duration, and the difference is the point: a loaded
 * box renders each frame later in wall-clock terms, and the sandbox steps its
 * fixed-step simulation by the frame's own delta — so waiting on frames gives
 * the control arm *at least* as much simulation on a busy box as on an idle
 * one. A `waitForTimeout` would give it less, which is the direction that turns
 * an absence assertion vacuous. The scene's `roundTime` cannot serve here
 * because pinning the sky (below) stops it.
 *
 * Ninety is a second and a half at 60 fps, and the check does not take it on
 * faith: the pulled arm counts the frames it actually needed and says so if this
 * was the smaller number.
 */
const CONTROL_FRAMES = 90

export default async function ({ page, shot, log }) {
  const dbg = () => page.evaluate(() => window.__game.debug())

  /** One wait, one reason it can fail — `minimap.mjs`'s helper. */
  const waitFor = async (fn, arg, why, seconds = 20) => {
    try {
      await page.waitForFunction(fn, arg, { timeout: deadlineMs(seconds, why) })
    } catch (e) {
      if (String(e).includes('Timeout')) throw new Error(`${why} (waited ${seconds}s)`)
      throw e
    }
  }

  const k = await page.evaluate(() => window.__game.constants())
  const travel = k.PLAYER_H * TRAVEL_BODIES

  await waitFor(
    () => !!window.__game.debug().player,
    null,
    'the sandbox never produced a local player',
  )

  // **The URL parameter took, asserted rather than assumed** (R22). A space map
  // is the only map with rocks on it, so an empty table here means `?gravity=`
  // was dropped and every patch below would be aimed at nothing.
  const rocks = await page.evaluate(() =>
    window.__game.core.meta.asteroids.map((a) => ({ x: a.x, y: a.y, r: a.r, level: a.level })),
  )
  if (rocks.length === 0) {
    throw new Error(
      'the sandbox map has no asteroids — `?gravity=space` did not reach the scene, ' +
        'so there is no field to photograph',
    )
  }
  log(`${rocks.length} rocks, levels ${[...new Set(rocks.map((a) => a.level))].sort().join('/')}`)

  /**
   * A start point in open space with a strong field, and a clear corridor
   * down-field of it.
   *
   * **Two phases, because the honest clearance test is expensive.** Phase one is
   * the body box and the field, over every rock at every radius and angle; phase
   * two takes the strongest candidates and demands a `CLEAR_BODIES`-deep margin
   * of air around the whole run, in *both* directions — the one down-field
   * because the body crosses it, the one up-field because the control patch is
   * photographed there.
   *
   * **The margin is the fix for a real failure, not caution.** The first version
   * checked the body box alone: it chose a point a body's height above the
   * arena's floor crust, the body accelerated to 206 px/s, **landed** at frame
   * 15 and slid the rest of the way at 19 px/s. The pixels still moved, so the
   * check would have gone green on a fixture that was measuring a slide down a
   * slope. `grounded` is asserted false at both ends below for the same reason.
   *
   * Searched in the page in one call: it needs `solidAt` and `fieldAccelAt` at
   * thousands of points, and a round trip each would be the slowest thing in the
   * suite.
   */
  const spot = await page.evaluate(
    ([bodyW, bodyH, run, margin, halfW, halfH]) => {
      const core = window.__game.core
      const boxClear = (x, y, pad) => {
        const half = Math.ceil(bodyW / 2) + pad
        for (let dy = -pad; dy <= bodyH + pad; dy += 2) {
          for (let dx = -half; dx <= half; dx += 2) {
            if (core.solidAt(Math.round(x + dx), Math.round(y - dy))) return false
          }
        }
        return true
      }
      // **Where the camera can actually centre.** `WorldRig` clamps its view to
      // the map, so a watch point nearer than half a viewport to an edge leaves
      // the camera somewhere else and the two patches land off-centre — the
      // first green run put the control patch on top of the sandbox's debug
      // panel, where the fps readout changes every frame. Inside this inset the
      // camera is exactly where it is put and the patches straddle the middle of
      // the frame.
      const inset = (x, y) =>
        x > halfW + run && x < core.width - halfW - run &&
        y > halfH + run && y < core.height - halfH - run
      const found = []
      for (const a of core.meta.asteroids) {
        for (let d = a.r + bodyH; d < a.r + bodyH * 14; d += 6) {
          for (let i = 0; i < 24; i++) {
            const th = (i / 24) * Math.PI * 2
            const x = a.x + Math.cos(th) * d
            const y = a.y + Math.sin(th) * d
            if (!inset(x, y)) continue
            if (!boxClear(x, y, 0)) continue
            const f = core.fieldAccelAt(x, y)
            const mag = Math.hypot(f[0], f[1])
            if (mag <= 0) continue
            found.push({ x, y, ux: f[0] / mag, uy: f[1] / mag, mag, level: a.level })
          }
        }
      }
      found.sort((p, q) => q.mag - p.mag)
      // **Spread the expensive phase out.** The strongest field on a map is a
      // single neighbourhood, and the first version spent all 160 of its
      // clearance tests on one 12 px patch of it — 43 979 candidates, the top
      // 160 of them within a body's height of each other, every one of them
      // failing for the same reason. Skipping anything near a point already
      // tried turns the budget into 160 *places*.
      const tried = []
      const spread = (run + bodyH) * 3
      for (const c of found) {
        if (tried.some((t) => Math.hypot(t.x - c.x, t.y - c.y) < spread)) continue
        tried.push(c)
        let ok = true
        for (let t = 0; t <= run + bodyH && ok; t += 8) {
          if (
            !boxClear(c.x + c.ux * t, c.y + c.uy * t, margin) ||
            !boxClear(c.x - c.ux * t, c.y - c.uy * t, margin)
          ) {
            ok = false
          }
        }
        if (ok) return c
        if (tried.length >= 160) break
      }
      return null
    },
    [
      k.PLAYER_W,
      k.PLAYER_H,
      travel,
      Math.round(k.PLAYER_H * CLEAR_BODIES),
      k.VIEWPORT_W / 2 / k.CAMERA_ZOOM,
      k.VIEWPORT_H / 2 / k.CAMERA_ZOOM,
    ],
  )
  if (!spot) {
    throw new Error(
      'no open-space start with a field and a clear corridor was found on this map — ' +
        'the fixture cannot see a well here, which is a map problem, not a render one',
    )
  }
  log(
    `start (${spot.x.toFixed(0)}, ${spot.y.toFixed(0)}) beside a level-${spot.level} rock, ` +
      `field ${spot.mag.toFixed(0)} px/s² toward (${spot.ux.toFixed(2)}, ${spot.uy.toFixed(2)})`,
  )

  // Hold the camera on the middle of the run. Without this the rig follows the
  // body, every pixel in the frame moves with it, and `assertChanged` correctly
  // refuses the whole measurement.
  await page.evaluate(
    ([x, y]) => window.__game.watch(x, y),
    [spot.x + (spot.ux * travel) / 2, spot.y - k.PLAYER_H / 2 + (spot.uy * travel) / 2],
  )

  // **Pin the sky, or the control frame is not one.** §C2 asks for the same
  // camera, the same light and the same moment of the day cycle; the first
  // version of this check let the clock run and the day moved the whole frame —
  // the control arm's subject patch changed by 32.5 over a second and a half,
  // with the body provably still. `setTime` freezes `roundTime` (and with it the
  // sky's gradient and the terrain's tint) and `setParallaxClock` freezes the
  // band behind it.
  await page.evaluate(() => {
    window.__game.setTime(0)
    window.__game.setParallaxClock(0)
  })

  // Rendered frames, which is the control arm's clock. Installed here rather
  // than read off the scene because nothing the scene exposes advances once the
  // day clock is pinned.
  await page.evaluate(() => {
    window.__e2eFrames = 0
    const tick = () => {
      window.__e2eFrames++
      requestAnimationFrame(tick)
    }
    requestAnimationFrame(tick)
  })

  /**
   * The two patches, in screen space, through the live camera.
   *
   * Centred on the **drawn** body rather than on the feet line: `PlayerView` puts
   * the sprite at `y - PLAYER_H / 2`, and a patch hung off the feet line is half
   * ground.
   */
  const patches = async () => {
    const mid = await toScreen(page, spot.x, spot.y - k.PLAYER_H / 2)
    const down = await toScreen(
      page,
      spot.x + spot.ux * travel,
      spot.y - k.PLAYER_H / 2 + spot.uy * travel,
    )
    const up = await toScreen(
      page,
      spot.x - spot.ux * travel,
      spot.y - k.PLAYER_H / 2 - spot.uy * travel,
    )
    if (!mid.onScreen || !down.onScreen || !up.onScreen) {
      throw new Error('the run does not fit in the frame — the camera is not where it was put')
    }
    // Screen-space size from a world-space span, so the zoom cannot shrink it.
    const edge = await toScreen(page, spot.x + k.PLAYER_H, spot.y - k.PLAYER_H / 2)
    const unit = Math.max(4, Math.hypot(edge.x - mid.x, edge.y - mid.y)) // one body height
    const side = Math.round(unit * 1.5)
    const rect = (p) => ({
      x: Math.round(p.x - side / 2),
      y: Math.round(p.y - side / 2),
      w: side,
      h: side,
    })
    return { subject: rect(down), control: rect(up), side }
  }
  const watchedAt = {
    x: spot.x + (spot.ux * travel) / 2,
    y: spot.y - k.PLAYER_H / 2 + (spot.uy * travel) / 2,
  }
  const cam = (await dbg()).camera
  if (Math.hypot(cam.x - watchedAt.x, cam.y - watchedAt.y) > 1) {
    throw new Error(
      `the camera settled at (${cam.x.toFixed(0)}, ${cam.y.toFixed(0)}) rather than the ` +
        `(${watchedAt.x.toFixed(0)}, ${watchedAt.y.toFixed(0)}) it was held at — the rig ` +
        'clamped to the map edge, so the patches are not where this check computed them',
    )
  }

  const at = await patches()
  log(`patches ${JSON.stringify(at)}`)

  // **Neither patch may sit under the sandbox's own furniture.** The panel, the
  // HUD strip and the minimap are DOM over the canvas, and one of them carries a
  // frame counter that changes every frame — a control region on top of it can
  // never be still, and a subject region on top of it changes for free.
  const overlays = await page.evaluate(() => {
    // Only the elements that actually put ink on the frame: the sandbox wraps
    // its canvas in full-viewport transparent containers, and treating those as
    // overlays would rule out every patch on the screen.
    const paints = (el) => {
      if (el.tagName === 'CANVAS') return false
      const st = getComputedStyle(el)
      if (st.visibility === 'hidden' || st.display === 'none' || Number(st.opacity) === 0) {
        return false
      }
      const bg = st.backgroundColor
      const opaque = !!bg && bg !== 'transparent' && !/^rgba\(.*,\s*0\)$/.test(bg)
      const ownText = [...el.childNodes].some(
        (n) => n.nodeType === 3 && n.textContent.trim().length > 0,
      )
      return opaque || ownText
    }
    return [...document.body.querySelectorAll('*')]
      .filter(paints)
      .map((el) => el.getBoundingClientRect())
      .filter((r) => r.width > 0 && r.height > 0)
      .map((r) => ({ x: r.left, y: r.top, w: r.width, h: r.height }))
  })
  const hits = (a, b) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h
  for (const [name, rect] of [
    ['subject', at.subject],
    ['control', at.control],
  ]) {
    const clash = overlays.find((o) => hits(rect, o))
    if (clash) {
      throw new Error(
        `the ${name} patch ${JSON.stringify(rect)} overlaps the DOM overlay ` +
          `${JSON.stringify(clash)} — it is photographing the sandbox's furniture, not the world`,
      )
    }
  }

  // **Point the aim across the run, because the crosshair rides the body.**
  // `Crosshair.update` puts the mark `AIM_RADIUS` from the body at the aim
  // angle, so it travels with it — and a crosshair that starts inside the
  // control patch and leaves it changes that patch for a reason that has
  // nothing to do with the well. Aimed perpendicular to the field, where
  // neither patch is.
  {
    const body = await toScreen(page, spot.x, spot.y - k.PLAYER_H / 2)
    await page.mouse.move(
      Math.max(1, Math.min(1279, Math.round(body.x - spot.uy * 200))),
      Math.max(1, Math.min(719, Math.round(body.y + spot.ux * 200))),
    )
  }

  /**
   * **The crosshair rides the body, so it must miss both patches.**
   *
   * `Crosshair.update` hangs the mark `AIM_RADIUS` from the body at the aim
   * angle; it therefore travels exactly as far as the body does. A mark that
   * started inside the control patch and left it would change that patch for a
   * reason that has nothing to do with the well — and `assertChanged` would
   * report the frame as "different everywhere" rather than naming this.
   */
  const crosshairClear = async (when) => {
    const p = await dbg()
    const mark = await toScreen(
      page,
      p.player.x + Math.cos(p.aim) * k.AIM_RADIUS,
      p.player.y + Math.sin(p.aim) * k.AIM_RADIUS,
    )
    for (const [name, rect] of [
      ['subject', at.subject],
      ['control', at.control],
    ]) {
      if (
        mark.onScreen &&
        mark.x >= rect.x &&
        mark.x <= rect.x + rect.w &&
        mark.y >= rect.y &&
        mark.y <= rect.y + rect.h
      ) {
        throw new Error(
          `${when}: the crosshair is at (${mark.x.toFixed(0)}, ${mark.y.toFixed(0)}), ` +
            `inside the ${name} patch — it moves with the body and would change that ` +
            'patch by itself',
        )
      }
    }
  }

  const placeAtStart = async () => {
    await page.evaluate(([x, y]) => window.__game.place(x, y), [spot.x, spot.y])
    await waitFor(
      ([x, y]) => {
        const p = window.__game.debug().player
        return !!p && Math.hypot(p.x - x, p.y - y) < 2
      },
      [spot.x, spot.y],
      'the body never appeared at the start point',
    )
  }

  // ---------------------------------------------------------- control frame
  //
  // The rocks taken away first, so the body never feels the field before its
  // photograph. Asserted on the **effect** — the table read back through
  // `meta.asteroids` and the field read back out of Rust — not on having made
  // the call.
  const cleared = await page.evaluate(() => {
    window.__game.core.setAsteroids([])
    return window.__game.core.meta.asteroids.length
  })
  if (cleared !== 0) throw new Error(`setAsteroids([]) left ${cleared} rocks installed`)
  const noField = await page.evaluate(
    ([x, y]) => Array.from(window.__game.core.fieldAccelAt(x, y)),
    [spot.x, spot.y],
  )
  if (Math.hypot(noField[0], noField[1]) !== 0) {
    throw new Error(`the field is still ${JSON.stringify(noField)} with no rocks installed`)
  }
  await placeAtStart()

  const beforeControl = {
    subject: await samplePatch(page, at.subject),
    control: await samplePatch(page, at.control),
  }
  await crosshairClear('at the start point')
  const framesAtStart = await page.evaluate(() => window.__e2eFrames)
  await shot('asteroid-gravity-nofield-before')

  // Polled, never slept on. See CONTROL_FRAMES.
  await waitFor(
    ([f0, n]) => window.__e2eFrames >= f0 + n,
    [framesAtStart, CONTROL_FRAMES],
    `the page never rendered ${CONTROL_FRAMES} frames`,
  )
  const drifted = await dbg()
  const afterControl = {
    subject: await samplePatch(page, at.subject),
    control: await samplePatch(page, at.control),
  }
  await shot('asteroid-gravity-nofield-after')
  if (drifted.player.grounded) {
    throw new Error(
      'the body is standing on something at the start point — the fixture is ' +
        'measuring a slide, not a free drift through a field',
    )
  }
  const wandered = Math.hypot(drifted.player.x - spot.x, drifted.player.y - spot.y)
  log(`control frame: body wandered ${wandered.toFixed(2)} px with no rocks installed`)
  if (wandered > 1) {
    throw new Error(
      `with no rocks installed the body still moved ${wandered.toFixed(2)} px — ` +
        'something other than the wells is pushing it, so the pulled arm below ' +
        'cannot be attributed to them',
    )
  }
  // **The control frame's own claim, and it is on pixels.** Simulation state
  // saying "it did not move" is not evidence that the screen agreed.
  assertUnchanged(beforeControl.subject, afterControl.subject, {
    label: 'control frame, subject patch (no rocks installed)',
  })
  assertUnchanged(beforeControl.control, afterControl.control, {
    label: 'control frame, control patch (no rocks installed)',
  })

  // ------------------------------------------------------------- the claim
  const installed = await page.evaluate((list) => {
    window.__game.core.setAsteroids(list)
    return window.__game.core.meta.asteroids.length
  }, rocks)
  if (installed !== rocks.length) {
    throw new Error(`setAsteroids installed ${installed} of ${rocks.length} rocks`)
  }
  const field = await page.evaluate(
    ([x, y]) => Array.from(window.__game.core.fieldAccelAt(x, y)),
    [spot.x, spot.y],
  )
  if (Math.hypot(field[0], field[1]) <= 0) {
    throw new Error('the rocks are installed and the field is still zero')
  }

  // **This wait is also the proof the scene was never frozen.** A page that had
  // stopped simulating would satisfy every "unchanged" assertion above and time
  // out here.
  const framesBeforePull = await page.evaluate(() => window.__e2eFrames)
  await waitFor(
    ([x, y, ux, uy, run]) => {
      const p = window.__game.debug().player
      return !!p && (p.x - x) * ux + (p.y - y) * uy >= run
    },
    [spot.x, spot.y, spot.ux, spot.uy, travel],
    `the body never travelled ${travel.toFixed(0)} px down-field, so the field reached ` +
      'the readback but not the simulation',
  )
  // Stop the clock before photographing, so the body is where the wait says it
  // is rather than wherever it drifted during the round trip. Rendering goes on.
  await page.evaluate(() => window.__game.freeze(true))
  const pulled = await dbg()
  const afterPull = {
    subject: await samplePatch(page, at.subject),
    control: await samplePatch(page, at.control),
  }
  await shot('asteroid-gravity-pulled')
  if (pulled.player.grounded) {
    throw new Error(
      'the body reached solid ground during the run — the corridor was not open ' +
        'space, so the move below is a slide and not the well',
    )
  }
  const along = (pulled.player.x - spot.x) * spot.ux + (pulled.player.y - spot.y) * spot.uy
  const framesPulling = (await page.evaluate(() => window.__e2eFrames)) - framesBeforePull
  log(
    `pulled ${along.toFixed(1)} px down-field in ${framesPulling} frames ` +
      `(travel target ${travel.toFixed(0)}, control arm got ${CONTROL_FRAMES})`,
  )
  // **The control arm has to have been long enough to have seen this**, or its
  // silence is a statement about a window too short for anything to happen in.
  if (framesPulling > CONTROL_FRAMES) {
    throw new Error(
      `the field needed ${framesPulling} frames to move the body ${travel.toFixed(0)} px ` +
        `while the control arm ran for only ${CONTROL_FRAMES} — the control is too short ` +
        'to rule the same motion out',
    )
  }

  // The body has to be *inside* the subject patch when the photograph is taken,
  // or a change there is something else. Named here so an overshoot reads as an
  // overshoot rather than as a missing sprite.
  const overshoot = along - travel
  if (overshoot > k.PLAYER_H * 0.75) {
    throw new Error(
      `the body was ${along.toFixed(1)} px down-field when photographed, ` +
        `${overshoot.toFixed(1)} px past the ${travel.toFixed(0)} px patch centre — ` +
        'it has left the patch it is meant to be in',
    )
  }
  log(`camera held at ${JSON.stringify(pulled.camera)} zoom ${pulled.zoom}`)

  await crosshairClear('after the pull')

  // **The claim, on rendered pixels, against the frame that had no field.** The
  // control region is the patch the body moved *away* from: if the whole frame
  // changed, `assertChanged` refuses rather than crediting the well.
  const verdict = assertChanged(afterControl.subject, afterPull.subject, {
    label: 'the drawn body is pulled down-field',
    control: { before: afterControl.control, after: afterPull.control },
  })
  log(`subject moved ${verdict.delta.toFixed(1)}, control ${verdict.controlDelta.toFixed(1)}`)

  // Hand the scene back what was borrowed — `weather-visible` records why a
  // borrowed clock has to be returned: a frozen sky moved the next check's
  // measurement by a factor of three.
  await page.evaluate(() => {
    window.__game.freeze(false)
    window.__game.watch(null)
    window.__game.setTime(null)
    window.__game.setParallaxClock(null)
  })
}
