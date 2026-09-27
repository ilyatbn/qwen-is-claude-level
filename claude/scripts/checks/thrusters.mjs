/**
 * T22.04 — **the thruster burst is drawn on the side opposite the way you push.** Rewritten by T23.14B (R13): the
 * burst is the stick figure's own jet flame (`look/actors/figure.ts`, its glow `actors/glow.ts`, in space drawn by
 * `PlayerView` in Phaser until T23.20); T22.04's Phaser plume and its shader retired with it.
 *
 * The owner: *"if i move down, you can see a burst of energy coming from above the player."* That is a claim about
 * the picture, so it is asserted on the rendered frame (`docs/72` §C2), never on `debug()` alone:
 *
 *  - **subject region** — the strip from the body's middle out along the side the exhaust must be: *above* for DOWN
 *    held, *below* for UP held, *right* while braking from a rightward drift (LEFT held);
 *  - **control region** — the mirror strip on the other side, which must not change;
 *  - **control frame** — the same frozen instant with the flame hidden (`showThrusters(false)`: flame, glow and its
 *    light), so the only difference between the two photographs is the flame. The subject must **brighten**
 *    (`FLAME_LUM_MIN`), not merely change.
 *
 * The strips are aimed off the body and the key held, never off the flame's own reported direction, which would
 * agree with itself whatever it drew. Their length is the flame's (`FLAME_PER_JET` × F7's space flame × the figure's
 * scale, read from the client's modules).
 *
 * **The push is the control on the rule itself.** DOWN, UP and braking are all run, so a flame drawn on a fixed side,
 * or along the travel (the backwards version, which *"looks fine in a still"*), fails one of them. Braking is the arm
 * the travel cannot pass: the body still moves right while the exhaust must be on the right.
 *
 * ## Standard gravity too (T23.14B)
 *
 * `thrusters-standard` runs this file at `?gravity=standard`: a firing jetpack draws its flame **below** the body
 * (F1's jet sticks, F7's `jet`) — the reverse of T22.04B's arm, which asserted no plume there because a plume aimed
 * off velocity would have pointed the wrong way. The flame is the pack's, so it points down the body. Control region:
 * the strip above the head; control frame: the flame hidden.
 *
 * ## The fuel, at both ends
 *
 * Thrusting drains the core's tank and draws a flame; letting go stops both. Each is asserted beside the other
 * (§A39), and the idle arm is timed in rendered frames so a loaded box gives it more simulation, not less.
 */
import { deadlineMs } from '../lib/deadline.mjs'
import { samplePatch, assertChanged, assertUnchanged, toScreen } from './pixels.mjs'
import { drawnFrames } from './harness.mjs'

/** Frames of letting go in which the tank must not fall. Half a second at 60 fps. */
const IDLE_FRAMES = 30
/** The flame strip must gain at least this much mean luminance (0–255) over the flame-hidden frame. */
const FLAME_LUM_MIN = 4
/** The strips start this fraction of a flame length out from the body's middle: past the nozzle, which sits ~3 px up the back from the middle (`figure.ts::flameAxis`), so the flame's root is in neither strip. */
const NEAR = 0.25
/** …and are this many flame lengths long, and half as wide as this fraction of one. */
const FAR = 1
const HALF_W = 0.3

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
  const frames = (n) => drawnFrames(page, n)

  const k = await page.evaluate(() => window.__game.constants())
  await waitFor(() => !!window.__game.debug().player, null, 'the sandbox never produced a local player')
  // The flame's length, px, from the modules that draw it (F7's space flame, the longest; the standard one is 3/4).
  const F = await page.evaluate(async () => {
    const P = await import('/src/look/actors/pose.ts')
    const G = await import('/src/look/actors/figure.ts')
    return { space: G.FLAME_PER_JET * P.SPACE_JET_LEN * P.FIGURE_SCALE, standard: G.FLAME_PER_JET * P.JET_LEN * P.FIGURE_SCALE }
  })

  // **Which renderer this entry is, asked of the canvas** (`canvas-renderer`'s rule).
  const wantCanvas = new URL(page.url()).searchParams.get('renderer') === 'canvas'
  const isCanvas = await page.evaluate(() => !!document.querySelector('canvas')?.getContext('2d'))
  if (isCanvas !== wantCanvas) throw new Error(`asked for ${wantCanvas ? 'Canvas' : 'WebGL'}, got the other`)
  log(`renderer: ${isCanvas ? 'Canvas' : 'WebGL'}; flame ${F.space.toFixed(1)} px in space, ${F.standard.toFixed(1)} px standard`)

  const gravity = new URL(page.url()).searchParams.get('gravity')
  const rocks = await page.evaluate(() => window.__game.core.meta.asteroids.length)
  const space = gravity !== 'standard'
  if (!space && rocks !== 0) throw new Error(`?gravity=standard generated ${rocks} asteroids — this is a space map`)
  if (space && rocks === 0) throw new Error('no asteroids — `?gravity=space` did not reach the scene')

  /**
   * Open space (or air), clear for three bodies in every direction — as far from any well as the map allows, in space.
   * Searched in the page for `asteroid-gravity`'s reason: thousands of `solidAt` calls.
   */
  const spot = await page.evaluate(
    ([bodyH, halfW, halfH, space]) => {
      const core = window.__game.core
      const pad = bodyH * 3
      const clear = (x, y) => {
        for (let dy = -pad; dy <= pad; dy += 4) for (let dx = -pad; dx <= pad; dx += 4) if (core.solidAt(Math.round(x + dx), Math.round(y + dy))) return false
        return true
      }
      let best = null
      for (let y = halfH + pad; y < core.height - halfH - pad; y += bodyH) {
        for (let x = space ? halfW + pad : core.width / 2; x < core.width - halfW - pad; x += bodyH) {
          const f = space ? core.fieldAccelAt(x, y) : [0, 0]
          const mag = Math.hypot(f[0], f[1])
          if (best && mag >= best.mag) continue
          if (!clear(x, y)) continue
          best = { x, y, mag }
          if (!space) return best
        }
      }
      return best
    },
    [k.PLAYER_H, k.VIEWPORT_W / 2 / k.CAMERA_ZOOM, k.VIEWPORT_H / 2 / k.CAMERA_ZOOM, space],
  )
  if (!spot) throw new Error('no open space three bodies clear anywhere on this map')
  log(`open ${space ? 'space' : 'air'} at (${spot.x}, ${spot.y})`)
  // The same light in every photograph: the day clock pinned.
  await page.evaluate(() => window.__game.setTime(0))

  /** The strip from the body's middle along unit `d` (world), `len` = one flame length — in screen space. */
  const strip = async (px, py, d, len) => {
    const a0 = [px + d[0] * NEAR * len, py + d[1] * NEAR * len]
    const a1 = [px + d[0] * FAR * len, py + d[1] * FAR * len]
    const w = HALF_W * len
    const pts = [
      [a0[0] - d[1] * w, a0[1] + d[0] * w],
      [a0[0] + d[1] * w, a0[1] - d[0] * w],
      [a1[0] - d[1] * w, a1[1] + d[0] * w],
      [a1[0] + d[1] * w, a1[1] - d[0] * w],
    ]
    const s = await Promise.all(pts.map(([x, y]) => toScreen(page, x, y)))
    if (!s.every((p) => p.onScreen)) {
      // T23.14C: say where — the body, the camera's view and the strip's corners — not only that.
      const v = await page.evaluate(() => {
        const d = window.__game.debug()
        const w = d.worldView
        return { player: [Math.round(d.player.x), Math.round(d.player.y)], view: [Math.round(w.x), Math.round(w.y), Math.round(w.width ?? w.w), Math.round(w.height ?? w.h)] }
      })
      throw new Error(`the body is not on screen: body ${JSON.stringify(v.player)}, view ${JSON.stringify(v.view)} (x, y, w, h), strip corners ${JSON.stringify(pts.map((q) => q.map(Math.round)))}`)
    }
    const x = Math.round(Math.min(...s.map((p) => p.x)))
    const y = Math.round(Math.min(...s.map((p) => p.y)))
    return { x, y, w: Math.max(2, Math.round(Math.max(...s.map((p) => p.x)) - x)), h: Math.max(2, Math.round(Math.max(...s.map((p) => p.y)) - y)) }
  }

  /** The frozen burn photographed with and without the flame: the exhaust side brightens, the other does not move. */
  const photograph = async (label, p, d, len, name) => {
    // T23.14C: frame the frozen body, not the spot. `placeAt` pinned the camera at the spot, and the body keeps
    // moving while the check waits wall-clock for the pack — measured under load: frozen 338 px below the spot, off
    // the bottom of a 360-px view ("the body is not on screen", the gate's red at 28 fps).
    await page.evaluate(([x, y]) => window.__game.watch(x, y), [p.x, p.y])
    await frames(2)
    const subjectRect = await strip(p.x, p.y, d, len)
    const controlRect = await strip(p.x, p.y, [-d[0], -d[1]], len)
    const sOn = await samplePatch(page, subjectRect)
    const cOn = await samplePatch(page, controlRect)
    await shot(name)
    const hidden = await page.evaluate(() => window.__game.showThrusters(false))
    if (hidden.drawn) throw new Error(`${label}: the flame would not hide for the control frame`)
    await frames(2)
    const sOff = await samplePatch(page, subjectRect)
    const cOff = await samplePatch(page, controlRect)
    await shot(`${name}-hidden`)
    const shown = await page.evaluate(() => window.__game.showThrusters(true))
    if (!shown.drawn) throw new Error(`${label}: the flame did not come back after the control frame`)
    const r = assertChanged(sOff, sOn, { label: `${label}: the exhaust-side strip, flame against no flame`, control: { before: cOff, after: cOn } })
    assertUnchanged(cOff, cOn, { label: `${label}: the strip on the other side` })
    const gain = sOn.lum - sOff.lum
    log(`${label}: exhaust side moved ${r.delta.toFixed(1)} (luminance +${gain.toFixed(1)}, min ${FLAME_LUM_MIN}), the other side ${r.controlDelta.toFixed(1)}`)
    if (!(gain >= FLAME_LUM_MIN)) throw new Error(`${label}: the exhaust-side strip changed but gained only ${gain.toFixed(1)} luminance (min ${FLAME_LUM_MIN}) — not a flame`)
  }

  const placeAt = async (x, y) => {
    await page.evaluate(([x, y]) => {
      window.__game.place(x, y)
      window.__game.watch(x, y)
    }, [x, y])
    await frames(3)
  }

  /** Letting go costs nothing and draws nothing; the burn just before is the presence control. */
  const letGo = async (label) => {
    await frames(2)
    const idle0 = await dbg()
    await frames(IDLE_FRAMES)
    const idle1 = await dbg()
    if (idle1.player.moveState === 2) throw new Error(`${label}: the pack still fires with nothing held`)
    if (idle1.flame?.drawn) throw new Error(`${label}: the flame is still drawn with nothing held`)
    if (idle1.player.fuel < idle0.player.fuel) throw new Error(`${label}: the tank fell while idle (${idle0.player.fuel} -> ${idle1.player.fuel})`)
  }

  const tag = isCanvas ? 'canvas' : 'webgl'
  if (!space) {
    // Space, not W: under gravity the pack is the jump key held (`hud-bars`).
    const label = 'standard gravity, jetpack held'
    await placeAt(spot.x, spot.y)
    const fuel0 = (await dbg()).player.fuel
    await page.keyboard.down('Space')
    try {
      await waitFor(() => window.__game.debug().player.moveState === 2, null, `${label}: the jetpack never fired`)
      await frames(3)
      await page.evaluate(() => window.__game.freeze(true))
    } finally {
      await page.keyboard.up('Space')
    }
    try {
      const d = await dbg()
      if (d.player.moveState !== 2) throw new Error(`${label}: frozen after the pack stopped (moveState ${d.player.moveState})`)
      if (!(d.player.fuel < fuel0)) throw new Error(`${label}: the tank did not fall while burning (${fuel0} -> ${d.player.fuel})`)
      if (!d.flame?.drawn) throw new Error(`${label}: the pack is firing and the view drew no flame: ${JSON.stringify(d.flame)}`)
      log(`${label}: frozen at (${d.player.x.toFixed(0)}, ${d.player.y.toFixed(0)}), ${(spot.y - d.player.y).toFixed(0)} px above the spot, vy ${d.player.vy.toFixed(0)}`)
      await photograph(label, d.player, [0, 1], F.standard, `thrusters-${tag}-standard`)
    } finally {
      await page.evaluate(() => window.__game.freeze(false))
    }
    await letGo(label)
    return
  }

  /** One space arm: hold `key` until the pack fires and the body moves the way it was pushed, freeze, photograph. */
  const arm = async ({ key, exhaust }) => {
    const label = `${key === 's' ? 'DOWN' : 'UP'} held`
    await placeAt(spot.x, spot.y)
    const fuel0 = (await dbg()).player.fuel
    await page.keyboard.down(key)
    try {
      await waitFor(
        ([down, min]) => {
          const p = window.__game.debug().player
          return p.moveState === 2 && (down ? p.vy > min * 4 : p.vy < -min * 4)
        },
        [key === 's', k.THRUSTER_PLUME_MIN_SPEED],
        `${label}: the thrusters never fired`,
      )
      // The body turns to put its pack behind the push over a few frames (`pose.ts::SPACE_TURN_S`).
      await frames(20)
      await page.evaluate(() => window.__game.freeze(true))
    } finally {
      await page.keyboard.up(key)
    }
    try {
      const d = await dbg()
      if (!(d.player.fuel < fuel0)) throw new Error(`${label}: the tank did not fall while thrusting (${fuel0} -> ${d.player.fuel})`)
      if (!d.flame?.drawn) throw new Error(`${label}: the pack is firing and the view drew no flame: ${JSON.stringify(d.flame)}`)
      await photograph(label, d.player, exhaust, F.space, `thrusters-${tag}-${key === 's' ? 'down' : 'up'}`)
    } finally {
      await page.evaluate(() => window.__game.freeze(false))
    }
    await letGo(label)
  }

  /**
   * T22.04C — **braking: the exhaust is on the side the push comes from, not opposite the travel.** Drift right (hold
   * D), then thrust left (hold A) and freeze while the body is **still moving right** and slowing: the exhaust of a
   * leftward push is on the **right** — the velocity side.
   */
  const brakingArm = async () => {
    const label = 'braking (drifting right, LEFT held)'
    await placeAt(spot.x - F.space * 6, spot.y)
    await page.keyboard.down('d')
    let peak = 0
    try {
      await waitFor((v) => window.__game.debug().player.vx > v, k.JETPACK_MAX_SPEED * 0.5, `${label}: never drifted right`)
      peak = (await dbg()).player.vx
    } finally {
      await page.keyboard.up('d')
    }
    const t0 = Date.now()
    await page.keyboard.down('a')
    try {
      // Firing, slowing and still going right, the body turned round to the push (`frames` of it) — and **frozen in
      // the same evaluation that saw it** (T22.14C: a round trip later a loaded page had braked past it).
      await waitFor(
        ([peakVx, min]) => {
          const p = window.__game.debug().player
          const f = window.__game.debug().flame
          const braking = p.moveState === 2 && p.vx < peakVx - 10 * min && p.vx > min * 20 && !!f?.drawn && f.dir.x > 0.9
          if (braking) window.__game.freeze(true)
          return braking
        },
        [peak, k.THRUSTER_PLUME_MIN_SPEED],
        `${label}: never caught braking, turned to the push, while still moving right`,
      )
    } finally {
      await page.keyboard.up('a')
    }
    try {
      const d = await dbg()
      log(`${label}: caught ${Date.now() - t0} ms after LEFT went down (wall clock), vx ${d.player.vx.toFixed(0)} from ${peak.toFixed(0)}, flame ${JSON.stringify(d.flame.dir)}`)
      if (!(d.player.vx > k.THRUSTER_PLUME_MIN_SPEED)) throw new Error(`${label}: frozen with vx ${d.player.vx}, not still moving right`)
      await photograph(`${label} (vx ${d.player.vx.toFixed(0)} from ${peak.toFixed(0)})`, d.player, [1, 0], F.space, `thrusters-${tag}-braking`)
    } finally {
      await page.evaluate(() => window.__game.freeze(false))
    }
    await frames(IDLE_FRAMES)
  }

  await arm({ key: 's', exhaust: [0, -1] })
  await arm({ key: 'w', exhaust: [0, 1] })
  await brakingArm()
}
