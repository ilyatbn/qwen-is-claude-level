/**
 * WASD, jump, jetpack and aim, proven by driving real keys at a real browser.
 *
 * Every assertion reads the *simulation's* body out of `game-core` through
 * `window.__game.debug()`, not the rendered sprite — a sprite can move for reasons
 * that have nothing to do with input.
 *
 * **And every wait for the body to do something is paced by the simulation's own
 * clock** (T21.23). Every question this file asks — did holding D move me, did I
 * land, did the jetpack lift me — is answered by physics the sandbox integrates
 * once per frame, so it is counted in `roundTime`, not in milliseconds of wall.
 * Measured: with twenty busy loops this check failed at `player never landed`,
 * because 1500 ms of wall had bought a fraction of the fall. See
 * `sim-clock.mjs`. The waits that are still `waitForTimeout` are the ones for a
 * *render* or an input round trip, which really are the browser's work.
 */
import { simClock } from './sim-clock.mjs'

export default async function ({ page, shot, log }) {
  const sim = simClock(page)
  const body = async () => (await page.evaluate(() => window.__game.debug())).player
  const dbg = () => page.evaluate(() => window.__game.debug())

  /** Drop the player onto solid ground and let them settle. */
  const settle = async () => {
    const spawn = await page.evaluate(() => window.__game.core.meta.spawn_points[0])
    await page.evaluate(
      ([s, h]) => window.__game.place(s.x, s.y - h / 2),
      [spawn, await page.evaluate(() => window.__game.core.meta && 28)],
    )
    // Settled is a *state*, not a duration: wait for the body to be on the
    // ground and still, rather than for a number of milliseconds in which it
    // might be either.
    await sim.until(
      async () => {
        const b = await body()
        return b.grounded && Math.abs(b.vy) < 1
      },
      1.0,
      'the player settling after being placed',
    )
    return body()
  }

  /** Hold `key` for `seconds` of **simulated** time. */
  const hold = async (key, seconds) => {
    await page.keyboard.down(key)
    await sim.elapse(seconds, `holding ${key}`)
    await page.keyboard.up(key)
    await sim.elapse(0.12, `the release of ${key} reaching the body`)
  }

  await page.evaluate(() => window.__game.regenerate('12345', 'medium'))
  await page.waitForTimeout(300)

  // --- D moves right -------------------------------------------------------
  let before = await settle()
  await hold('d', 0.9)
  let after = await body()
  log(`D: x ${before.x.toFixed(1)} -> ${after.x.toFixed(1)}`)
  if (!(after.x > before.x + 20)) throw new Error(`holding D did not move the player right`)
  await shot('wasd-right')

  // --- A moves left --------------------------------------------------------
  before = await body()
  await hold('a', 0.9)
  after = await body()
  log(`A: x ${before.x.toFixed(1)} -> ${after.x.toFixed(1)}`)
  if (!(after.x < before.x - 20)) throw new Error(`holding A did not move the player left`)
  await shot('wasd-left')

  // --- Space jumps: leaves the ground, then lands ---------------------------
  before = await settle()
  await page.keyboard.down(' ')
  await sim.elapse(0.09, 'the jump leaving the ground')
  const rising = await body()
  await page.keyboard.up(' ')
  log(`Space: grounded ${before.grounded} -> ${rising.grounded}, vy ${rising.vy.toFixed(0)}`)
  if (rising.grounded) throw new Error('Space did not leave the ground')
  if (!(rising.vy < 0)) throw new Error(`expected upward velocity, got vy ${rising.vy}`)
  await shot('wasd-jump')

  // **On the effect, and on the sandbox's clock.** As `waitForTimeout(1500)`
  // this is the wait that was measured failing under twenty busy loops: the
  // wall spent its 1500 ms and the fall had barely started, so "player never
  // landed" was a true sentence about a jump that was still in the air.
  const landed = await sim.until(
    async () => {
      const b = await body()
      return b.grounded ? b : null
    },
    1.5,
    'the player landing',
  )
  if (!landed) throw new Error('player never landed within 1.5s of simulated time')
  log(`  landed: grounded ${landed.grounded} at y ${landed.y.toFixed(1)}`)

  // --- Jetpack: hold Space past JETPACK_HOLD_DELAY, then W ------------------
  before = await settle()
  await page.keyboard.down(' ')
  // Past `JETPACK_HOLD_DELAY` — 0.18 s, and the simulation is what counts it.
  await sim.elapse(0.4, 'the jetpack hold delay')
  await page.keyboard.down('w')
  await sim.elapse(0.7, 'the climb')
  const flying = await body()
  await page.keyboard.up('w')
  await page.keyboard.up(' ')
  log(
    `Jetpack: y ${before.y.toFixed(1)} -> ${flying.y.toFixed(1)}, ` +
      `fuel ${flying.fuel.toFixed(2)}, moveState ${flying.moveState}`,
  )
  if (!(flying.y < before.y - 30)) throw new Error('W on the jetpack did not gain height')
  if (!(flying.fuel < 5)) throw new Error('jetpack burned no fuel')
  if (flying.moveState !== 2) throw new Error(`expected moveState 2 (jetpack), got ${flying.moveState}`)
  await shot('wasd-jetpack')

  // --- S descends while thrusting -----------------------------------------
  // Climb first: pressing S while standing on the ground pushes into the floor and
  // proves nothing. The player has to actually be in the air.
  await settle()
  await page.keyboard.down(' ')
  await sim.elapse(0.3, 'the jetpack hold delay, again')
  await page.keyboard.down('w')
  await sim.elapse(0.6, 'the climb before testing S')
  await page.keyboard.up('w')
  const beforeS = await body()
  if (beforeS.grounded) throw new Error('expected to be airborne before testing S')
  // Held long enough for the answer to be unambiguous.
  //
  // 350 ms and a 5 px bound was a coin flip: `S` while the jetpack is still
  // thrusting nearly cancels gravity, so the descent came out at 5.3 px against a
  // threshold of 5 — a gate decided by a rounding error. 800 ms and 30 px is the
  // same property with the noise outside it.
  await page.keyboard.down('s')
  await sim.elapse(0.8, 'the descent under S')
  const descended = await body()
  await page.keyboard.up('s')
  await page.keyboard.up(' ')
  const fell = descended.y - beforeS.y
  log(`S: airborne y ${beforeS.y.toFixed(1)} -> ${descended.y.toFixed(1)} (${fell.toFixed(1)} px)`)
  if (!(fell > 30)) throw new Error(`S descended only ${fell.toFixed(1)} px in 0.8s of simulated time`)

  // --- Aim tracks the mouse in WORLD space, after the camera has scrolled ---
  //
  // The mouse goes to the screen point that corresponds to a chosen **world**
  // point beside the player, via the camera's `worldView`. Placing it 200 px from
  // the screen centre instead assumes the player is centred, and the player is
  // only centred while the camera is free — at a map edge it clamps. When the map
  // generator's ground line moved down the frame the camera clamped at the
  // bottom, the screen centre landed well above the player, and the aim this
  // reported was -71 degrees: correct for where the mouse was, and nothing to do
  // with what the test meant to ask.
  await settle()
  const d0 = await dbg()

  /**
   * Put the mouse level with the player and `dx` world px to its side, and return
   * the world point it actually landed on.
   *
   * The point is **clamped into the camera's `worldView`**. The viewport is
   * 640x360 world px at this zoom, so a naive player.x + 300 is off the right of
   * the window: the mouse move is clamped by the browser, the game sees a pointer
   * somewhere else entirely, and the aim it reports has nothing to do with the
   * question. That is what -2.674 rad was.
   */
  const aimAt = (dx) =>
    page.evaluate(
      (d) => {
        const g = window.__game.debug()
        const v = g.worldView
        const m = 40
        const wx = Math.min(Math.max(g.player.x + d, v.x + m), v.x + v.w - m)
        const wy = Math.min(Math.max(g.player.y, v.y + m), v.y + v.h - m)
        const c = document.querySelector('canvas')
        const r = c.getBoundingClientRect()
        return {
          world: { x: wx, y: wy },
          screen: {
            x: r.left + ((wx - v.x) / v.w) * r.width,
            y: r.top + ((wy - v.y) / v.h) * r.height,
          },
          player: { x: g.player.x, y: g.player.y },
        }
      },
      dx,
    )

  const r = await aimAt(200)
  await page.mouse.move(r.screen.x, r.screen.y)
  await page.waitForTimeout(120)
  const aimRight = (await dbg()).aim
  // Control: the mouse really is to the player's right in the world, so a failing
  // assertion below is the game's aim and not the harness's arithmetic.
  if (!(r.world.x > r.player.x + 50)) {
    throw new Error(`harness put the "right" point at ${r.world.x} for a player at ${r.player.x}`)
  }
  const l = await aimAt(-200)
  await page.mouse.move(l.screen.x, l.screen.y)
  await page.waitForTimeout(120)
  const aimLeft = (await dbg()).aim
  if (!(l.world.x < l.player.x - 50)) {
    throw new Error(`harness put the "left" point at ${l.world.x} for a player at ${l.player.x}`)
  }
  log(`Aim: right ${aimRight.toFixed(3)} rad, left ${aimLeft.toFixed(3)} rad`)
  if (!(Math.cos(aimRight) > 0.5)) throw new Error('aim did not point right')
  if (!(Math.cos(aimLeft) < -0.5)) throw new Error('aim did not point left')

  // The camera has scrolled a long way from the origin by now, so this also
  // demonstrates the world-vs-screen conversion is right — a screen-space
  // implementation would be wrong here and correct only near (0,0).
  log(`  camera at (${d0.camera.x.toFixed(0)}, ${d0.camera.y.toFixed(0)}), aim still correct`)
  await shot('wasd-aim')
}
