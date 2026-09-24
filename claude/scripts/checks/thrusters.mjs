/**
 * T22.04 — **the thruster burst is drawn on the side opposite the way you go.**
 *
 * The owner: *"if i move down, you can see a burst of energy coming from above the
 * player."* That is a claim about the picture, so it is asserted on the rendered
 * canvas (`docs/72` §C2), never on `debug()`:
 *
 *  - **subject region** — the strip just past the body on the side the plume must
 *    be: *above* for DOWN held, *below* for UP held;
 *  - **control region** — the mirror-image strip on the other side, which must not
 *    change;
 *  - **control frame** — the same frozen instant with the plume hidden
 *    (`showThrusters(false)`), so the only difference between the two photographs is
 *    the plume.
 *
 * **The velocity is the control on the rule itself.** DOWN and UP are both run, so a
 * plume drawn on a fixed side — or drawn *along* the velocity, the backwards version
 * the task file warns *"looks fine in a still"* — fails one of the two arms. The
 * patches are aimed off the body and `PLAYER_H`, never off the plume's own reported
 * direction, which would agree with itself whatever it drew.
 *
 * ## Every render path, because the two are different code
 *
 * `webgl && isHighQuality()` picks the shader, so there are three paths, not four:
 * (WebGL, HQ on) = shader, (WebGL, HQ off) = flat, (Canvas, either) = flat. The
 * WebGL entry runs both settings and asserts the shader was used exactly when asked;
 * the `thrusters-canvas` entry runs both too and asserts it never was — Canvas with
 * High Quality **on** is the combination a missing `webgl &&` would break.
 *
 * ## And never outside space (T22.04B)
 *
 * `thrusters-standard` runs this file at `?gravity=standard` and takes
 * `standardArm` instead: a firing jetpack, no plume on `debug()` and none on the
 * pixels. The two entries above are its presence control.
 *
 * ## The fuel, at both ends
 *
 * Thrusting drains the core's tank and draws a plume; letting go stops both. Each is
 * asserted beside the other (§A39), and the idle arm is timed in rendered frames so
 * a loaded box gives it more simulation, not less.
 */
import { deadlineMs } from '../lib/deadline.mjs'
import { samplePatch, assertChanged, assertUnchanged, toScreen } from './pixels.mjs'
import { drawnFrames } from './harness.mjs'

/** Frames of letting go in which the tank must not fall. Half a second at 60 fps. */
const IDLE_FRAMES = 30

export default async function ({ page, shot, log }) {
  const dbg = () => page.evaluate(() => window.__game.debug())
  const waitFor = async (fn, arg, why, seconds = 20) => {
    try {
      await page.waitForFunction(fn, arg, { timeout: deadlineMs(seconds, why) })
    } catch (e) {
      if (String(e).includes('Timeout')) throw new Error(`${why} (waited ${seconds}s)`)
      throw e
    }
  }
  /** `n` drawn frames, or a throw naming a page that stopped rendering — the harness's one copy (T22.00C). */
  const frames = (n) => drawnFrames(page, n)

  const k = await page.evaluate(() => window.__game.constants())
  await waitFor(() => !!window.__game.debug().player, null, 'the sandbox never produced a local player')

  // **Which renderer this entry is, asked of the canvas** (`canvas-renderer`'s rule):
  // a WebGL canvas has no 2d context, so a check that silently ran WebGL under the
  // Canvas entry would say so here instead of passing against the bug.
  const wantCanvas = new URL(page.url()).searchParams.get('renderer') === 'canvas'
  const isCanvas = await page.evaluate(() => !!document.querySelector('canvas')?.getContext('2d'))
  if (isCanvas !== wantCanvas) throw new Error(`asked for ${wantCanvas ? 'Canvas' : 'WebGL'}, got the other`)
  log(`renderer: ${isCanvas ? 'Canvas' : 'WebGL'}`)

  // R22: only a space map has rocks, and only a space match draws a plume.
  const gravity = new URL(page.url()).searchParams.get('gravity')
  const rocks = await page.evaluate(() => window.__game.core.meta.asteroids.length)
  if (gravity === 'standard') {
    // T22.04B F1: the entry that asks for normal gravity gets the absence arm and
    // nothing else. The rocks are its proof it is not a space map in disguise.
    if (rocks !== 0) throw new Error(`?gravity=standard generated ${rocks} asteroids — this is a space map`)
    return standardArm({ page, shot, log, k, dbg, waitFor, frames, isCanvas })
  }
  if (rocks === 0) throw new Error('no asteroids — `?gravity=space` did not reach the scene')

  /**
   * Open space, clear for three bodies in every direction, as far from any well as
   * this map allows, and where the camera can centre. Searched in the page for
   * `asteroid-gravity`'s reason: thousands of `solidAt` calls.
   */
  const spot = await page.evaluate(
    ([bodyW, bodyH, halfW, halfH]) => {
      const core = window.__game.core
      const pad = bodyH * 3
      const clear = (x, y) => {
        for (let dy = -pad; dy <= pad; dy += 4) {
          for (let dx = -pad; dx <= pad; dx += 4) {
            if (core.solidAt(Math.round(x + dx), Math.round(y + dy))) return false
          }
        }
        return true
      }
      let best = null
      for (let y = halfH + pad; y < core.height - halfH - pad; y += bodyH) {
        for (let x = halfW + pad; x < core.width - halfW - pad; x += bodyH) {
          const f = core.fieldAccelAt(x, y)
          const mag = Math.hypot(f[0], f[1])
          if (best && mag >= best.mag) continue
          if (!clear(x, y)) continue
          best = { x, y, mag }
        }
      }
      return best
    },
    [k.PLAYER_W, k.PLAYER_H, k.VIEWPORT_W / 2 / k.CAMERA_ZOOM, k.VIEWPORT_H / 2 / k.CAMERA_ZOOM],
  )
  if (!spot) throw new Error('no open space three bodies clear anywhere on this map')
  log(`open space at (${spot.x}, ${spot.y}), field ${spot.mag.toFixed(0)} px/s²`)

  // The same light in every photograph: the day clock and the ridges pinned.
  await page.evaluate(() => {
    window.__game.setTime(0)
    window.__game.setParallaxClock(0)
  })

  /**
   * The strip just past the drawn body on one side, in screen space.
   *
   * Centred on the **drawn** body — `PlayerView` hangs the sprite at
   * `y - PLAYER_H / 2` in this scene (`asteroid-gravity` records it) — and running
   * from a tenth to three fifths of a plume length past the body's edge, which is
   * where the plume is brightest and the body never reaches.
   */
  const strip = async (px, py, side) => {
    const cy = py - k.PLAYER_H / 2
    const near = k.PLAYER_H / 2 + k.THRUSTER_PLUME_LENGTH * 0.1
    const far = k.PLAYER_H / 2 + k.THRUSTER_PLUME_LENGTH * 0.6
    const a = await toScreen(page, px - k.THRUSTER_PLUME_WIDTH * 0.3, cy + side * near)
    const b = await toScreen(page, px + k.THRUSTER_PLUME_WIDTH * 0.3, cy + side * far)
    if (!a.onScreen || !b.onScreen) throw new Error('the body is not on screen')
    const x = Math.round(Math.min(a.x, b.x))
    const y = Math.round(Math.min(a.y, b.y))
    return { x, y, w: Math.max(2, Math.round(Math.abs(b.x - a.x))), h: Math.max(2, Math.round(Math.abs(b.y - a.y))) }
  }

  /** One arm: hold `key`, freeze, photograph with and without the plume. */
  const arm = async ({ key, plumeSide, hq }) => {
    const label = `${key === 's' ? 'DOWN' : 'UP'} held, High Quality ${hq ? 'on' : 'off'}`
    const q = await page.evaluate((v) => window.__game.setHighQuality(v), hq)
    if (q.setting !== hq) throw new Error(`${label}: High Quality would not change: ${JSON.stringify(q)}`)
    await page.evaluate(([x, y]) => {
      window.__game.place(x, y)
      window.__game.watch(x, y)
    }, [spot.x, spot.y])
    await frames(3)
    const fuel0 = (await dbg()).player.fuel

    await page.keyboard.down(key)
    try {
      // Until the pack is firing **and** the body has speed the way it was pushed,
      // so the plume has a velocity to point off.
      await waitFor(
        ([down, min]) => {
          const p = window.__game.debug().player
          return p.moveState === 2 && (down ? p.vy > min * 4 : p.vy < -min * 4)
        },
        [key === 's', k.THRUSTER_PLUME_MIN_SPEED],
        `${label}: the thrusters never fired`,
      )
      await page.evaluate(() => window.__game.freeze(true))
    } finally {
      await page.keyboard.up(key)
    }
    try {
      const d = await dbg()
      const p = d.player
      // Both ends (§A39): the core says it is burning, and paying for it; the view
      // says it drew, and with the path this renderer and setting must use.
      if (!(p.fuel < fuel0)) throw new Error(`${label}: the tank did not fall while thrusting (${fuel0} -> ${p.fuel})`)
      if (!d.plume?.drawn) throw new Error(`${label}: the pack is firing and the view drew no plume: ${JSON.stringify(d.plume)}`)
      const wantShader = hq && !isCanvas
      if (d.plume.shader !== wantShader) {
        throw new Error(`${label}: plume drawn ${d.plume.shader ? 'by the shader' : 'flat'}, expected ${wantShader ? 'the shader' : 'flat'}`)
      }

      const subjectRect = await strip(p.x, p.y, plumeSide)
      const controlRect = await strip(p.x, p.y, -plumeSide)
      const sOn = await samplePatch(page, subjectRect)
      const cOn = await samplePatch(page, controlRect)
      await shot(`thrusters-${isCanvas ? 'canvas' : 'webgl'}-${key === 's' ? 'down' : 'up'}-hq-${hq ? 'on' : 'off'}`)
      const hidden = await page.evaluate(() => window.__game.showThrusters(false))
      if (hidden.drawn) throw new Error(`${label}: the plume would not hide for the control frame`)
      await frames(2)
      const sOff = await samplePatch(page, subjectRect)
      const cOff = await samplePatch(page, controlRect)
      await page.evaluate(() => window.__game.showThrusters(true))

      const where = plumeSide < 0 ? 'above' : 'below'
      const r = assertChanged(sOff, sOn, {
        label: `${label}: the strip ${where} the body, plume against no plume`,
        control: { before: cOff, after: cOn },
      })
      assertUnchanged(cOff, cOn, { label: `${label}: the strip on the travelling side` })
      log(`${label}: ${where} moved ${r.delta.toFixed(1)}, the other side ${r.controlDelta.toFixed(1)}`)
    } finally {
      await page.evaluate(() => window.__game.freeze(false))
    }

    // **Letting go costs nothing and draws nothing.** The presence arm above is the
    // control: the same body, one moment earlier, was burning and drawn.
    await frames(2)
    const idle0 = await dbg()
    await frames(IDLE_FRAMES)
    const idle1 = await dbg()
    if (idle1.player.moveState === 2) throw new Error(`${label}: the pack still fires with nothing held`)
    if (idle1.plume?.drawn) throw new Error(`${label}: the plume is still drawn with nothing held`)
    if (idle1.player.fuel < idle0.player.fuel) {
      throw new Error(`${label}: the tank fell while idle (${idle0.player.fuel} -> ${idle1.player.fuel})`)
    }
  }

  /**
   * T22.04C: the strip just past the drawn body on its left (`side` −1) or right
   * (+1), in screen space — `strip`'s twin across the other axis, from a tenth to
   * three fifths of a plume length past the body's side.
   */
  const hstrip = async (px, py, side) => {
    const cy = py - k.PLAYER_H / 2
    const near = k.PLAYER_W / 2 + k.THRUSTER_PLUME_LENGTH * 0.1
    const far = k.PLAYER_W / 2 + k.THRUSTER_PLUME_LENGTH * 0.6
    const a = await toScreen(page, px + side * near, cy - k.THRUSTER_PLUME_WIDTH * 0.3)
    const b = await toScreen(page, px + side * far, cy + k.THRUSTER_PLUME_WIDTH * 0.3)
    if (!a.onScreen || !b.onScreen) throw new Error('the body is not on screen')
    const x = Math.round(Math.min(a.x, b.x))
    const y = Math.round(Math.min(a.y, b.y))
    return { x, y, w: Math.max(2, Math.round(Math.abs(b.x - a.x))), h: Math.max(2, Math.round(Math.abs(b.y - a.y))) }
  }

  /**
   * T22.04C — **braking: the plume is on the side the push comes from, not opposite
   * the travel.** Drift right (hold D), then thrust left (hold A) and freeze while the
   * body is **still moving right** and slowing: the exhaust of a leftward push is on
   * the **right** — the velocity side, where T22.04's velocity rule drew nothing.
   * Subject: the strip right of the body; control region: the strip left of it (where
   * the velocity rule would draw); control frame: the same instant, plume hidden.
   * Both velocity-agreeing arms above stay the control on the rule.
   */
  const brakingArm = async ({ hq }) => {
    const label = `braking (drifting right, LEFT held), High Quality ${hq ? 'on' : 'off'}`
    const q = await page.evaluate((v) => window.__game.setHighQuality(v), hq)
    if (q.setting !== hq) throw new Error(`${label}: High Quality would not change: ${JSON.stringify(q)}`)
    await page.evaluate(([x, y]) => {
      window.__game.place(x, y)
      window.__game.watch(x, y)
    }, [spot.x - k.THRUSTER_PLUME_LENGTH * 2, spot.y])
    await frames(3)
    await page.keyboard.down('d')
    let peak = 0
    try {
      await waitFor((v) => window.__game.debug().player.vx > v, k.JETPACK_MAX_SPEED * 0.5, `${label}: never drifted right`)
      peak = (await dbg()).player.vx
    } finally {
      await page.keyboard.up('d')
    }
    await page.keyboard.down('a')
    try {
      // Firing, slowing (the push is leftward) and still going right.
      await waitFor(
        ([peakVx, min]) => {
          const p = window.__game.debug().player
          return p.moveState === 2 && p.vx < peakVx - 10 * min && p.vx > min * 20
        },
        [peak, k.THRUSTER_PLUME_MIN_SPEED],
        `${label}: never caught braking while still moving right`,
      )
      await page.evaluate(() => window.__game.freeze(true))
    } finally {
      await page.keyboard.up('a')
    }
    try {
      const d = await dbg()
      const p = d.player
      if (!(p.vx > k.THRUSTER_PLUME_MIN_SPEED)) throw new Error(`${label}: frozen with vx ${p.vx}, not still moving right`)
      if (!d.plume?.drawn) throw new Error(`${label}: the pack is firing and the view drew no plume: ${JSON.stringify(d.plume)}`)
      const subjectRect = await hstrip(p.x, p.y, 1)
      const controlRect = await hstrip(p.x, p.y, -1)
      const sOn = await samplePatch(page, subjectRect)
      const cOn = await samplePatch(page, controlRect)
      await shot(`thrusters-${isCanvas ? 'canvas' : 'webgl'}-braking-hq-${hq ? 'on' : 'off'}`)
      const hidden = await page.evaluate(() => window.__game.showThrusters(false))
      if (hidden.drawn) throw new Error(`${label}: the plume would not hide for the control frame`)
      await frames(2)
      const sOff = await samplePatch(page, subjectRect)
      const cOff = await samplePatch(page, controlRect)
      await page.evaluate(() => window.__game.showThrusters(true))
      const r = assertChanged(sOff, sOn, {
        label: `${label}: the strip right of the body (the push's side), plume against no plume (vx ${p.vx.toFixed(0)})`,
        control: { before: cOff, after: cOn },
      })
      assertUnchanged(cOff, cOn, { label: `${label}: the strip left of the body (the way the push goes)` })
      log(`${label}: right moved ${r.delta.toFixed(1)}, left ${r.controlDelta.toFixed(1)} (vx ${p.vx.toFixed(0)} from ${peak.toFixed(0)})`)
    } finally {
      await page.evaluate(() => window.__game.freeze(false))
    }
    await frames(IDLE_FRAMES)
  }

  for (const hq of [false, true]) {
    await arm({ key: 's', plumeSide: -1, hq })
    await arm({ key: 'w', plumeSide: 1, hq })
    await brakingArm({ hq })
  }
  await page.evaluate(() => window.__game.setHighQuality(false))
}

/**
 * T22.04B F1 — **under normal gravity a firing pack draws no plume.**
 *
 * The shipped jetpack pushes *up* whichever way the body moves, so a plume
 * pointed off velocity would be backwards there; `plumeOn` keeps it to space.
 * `plumeOn`'s unit test covers the pure function and nothing that calls it, and
 * planting `plumeOn(alive, jetpack, true)` at `PlayerView.setState` left vitest
 * and three e2e checks green (the T22.04 review).
 *
 * Both ends (§A39), and neither alone: the view says it drew nothing, **and** the
 * strips above and below the body are unchanged between the frame as drawn and
 * the same frozen instant with the plume hidden — a plume drawn with `drawn`
 * misreported would still move a strip. The presence control is the space
 * entries, `thrusters` and `thrusters-canvas`, which run this same photograph and
 * require it to change.
 */
async function standardArm({ page, shot, log, k, dbg, waitFor, frames, isCanvas }) {
  // Open air near the top of the map: the jetpack climbs, and a body on the
  // ground under a standard map's sky is the one place the pack does not fire.
  const spot = await page.evaluate(
    ([bodyH, halfW, halfH]) => {
      const core = window.__game.core
      const pad = bodyH * 3
      const clear = (x, y) => {
        for (let dy = -pad; dy <= pad; dy += 4) {
          for (let dx = -pad; dx <= pad; dx += 4) {
            if (core.solidAt(Math.round(x + dx), Math.round(y + dy))) return false
          }
        }
        return true
      }
      for (let y = halfH + pad; y < core.height - halfH - pad; y += bodyH) {
        for (let x = core.width / 2; x < core.width - halfW - pad; x += bodyH) {
          if (clear(x, y)) return { x, y }
        }
      }
      return null
    },
    [k.PLAYER_H, k.VIEWPORT_W / 2 / k.CAMERA_ZOOM, k.VIEWPORT_H / 2 / k.CAMERA_ZOOM],
  )
  if (!spot) throw new Error('no open air three bodies clear on this map')
  await page.evaluate(() => {
    window.__game.setTime(0)
    window.__game.setParallaxClock(0)
  })
  const strip = async (px, py, side) => {
    const cy = py - k.PLAYER_H / 2
    const near = k.PLAYER_H / 2 + k.THRUSTER_PLUME_LENGTH * 0.1
    const far = k.PLAYER_H / 2 + k.THRUSTER_PLUME_LENGTH * 0.6
    const a = await toScreen(page, px - k.THRUSTER_PLUME_WIDTH * 0.3, cy + side * near)
    const b = await toScreen(page, px + k.THRUSTER_PLUME_WIDTH * 0.3, cy + side * far)
    if (!a.onScreen || !b.onScreen) throw new Error('the body is not on screen')
    const x = Math.round(Math.min(a.x, b.x))
    const y = Math.round(Math.min(a.y, b.y))
    return { x, y, w: Math.max(2, Math.round(Math.abs(b.x - a.x))), h: Math.max(2, Math.round(Math.abs(b.y - a.y))) }
  }

  for (const hq of [false, true]) {
    const label = `standard gravity, jetpack held, High Quality ${hq ? 'on' : 'off'}`
    const q = await page.evaluate((v) => window.__game.setHighQuality(v), hq)
    if (q.setting !== hq) throw new Error(`${label}: High Quality would not change: ${JSON.stringify(q)}`)
    await page.evaluate(([x, y]) => {
      window.__game.place(x, y)
      window.__game.watch(x, y)
    }, [spot.x, spot.y])
    await frames(3)
    // Space, not W: under gravity the pack is the jump key held (`hud-bars`).
    await page.keyboard.down('Space')
    try {
      await waitFor(() => window.__game.debug().player.moveState === 2, null, `${label}: the jetpack never fired`)
      // A few frames of burning, so a plume that took a frame to appear has had it.
      await frames(3)
      await page.evaluate(() => window.__game.freeze(true))
    } finally {
      await page.keyboard.up('Space')
    }
    try {
      const d = await dbg()
      const p = d.player
      // The presence half of the pair: the pack **is** firing in the frozen frame.
      if (p.moveState !== 2) throw new Error(`${label}: frozen after the pack stopped (moveState ${p.moveState})`)
      const above = await strip(p.x, p.y, -1)
      const below = await strip(p.x, p.y, 1)
      const aOn = await samplePatch(page, above)
      const bOn = await samplePatch(page, below)
      await shot(`thrusters-${isCanvas ? 'canvas' : 'webgl'}-standard-hq-${hq ? 'on' : 'off'}`)
      await page.evaluate(() => window.__game.showThrusters(false))
      await frames(2)
      const aOff = await samplePatch(page, above)
      const bOff = await samplePatch(page, below)
      await page.evaluate(() => window.__game.showThrusters(true))
      await frames(2)
      const after = (await dbg()).plume
      // Every failure at once: a plant should say which ends it reached.
      const bad = []
      if (d.plume?.drawn !== false) bad.push(`the view reports a plume drawn: ${JSON.stringify(d.plume)}`)
      if (after?.drawn !== false) bad.push(`re-shown, the view reports a plume drawn: ${JSON.stringify(after)}`)
      for (const [where, off, on] of [['above', aOff, aOn], ['below', bOff, bOn]]) {
        try {
          assertUnchanged(off, on, { label: `the strip ${where} the body, as drawn against plume hidden` })
        } catch (e) {
          bad.push(e.message)
        }
      }
      if (bad.length) throw new Error(`${label}: a plume under normal gravity —\n  ${bad.join('\n  ')}`)
      log(`${label}: no plume drawn, both strips unchanged against the hidden-plume frame`)
    } finally {
      await page.evaluate(() => window.__game.freeze(false))
    }
  }
  await page.evaluate(() => window.__game.setHighQuality(false))
}
