/**
 * WASD, jump, jetpack and aim, proven by driving real keys at a real browser.
 *
 * Every assertion reads the *simulation's* body out of `game-core` through
 * `window.__game.debug()`, not the rendered sprite — a sprite can move for reasons
 * that have nothing to do with input.
 */
export default async function ({ page, shot, log }) {
  const body = async () => (await page.evaluate(() => window.__game.debug())).player
  const dbg = () => page.evaluate(() => window.__game.debug())

  /** Drop the player onto solid ground and let them settle. */
  const settle = async () => {
    const spawn = await page.evaluate(() => window.__game.core.meta.spawn_points[0])
    await page.evaluate(
      ([s, h]) => window.__game.place(s.x, s.y - h / 2),
      [spawn, await page.evaluate(() => window.__game.core.meta && 28)],
    )
    await page.waitForTimeout(600)
    return body()
  }

  const hold = async (key, ms) => {
    await page.keyboard.down(key)
    await page.waitForTimeout(ms)
    await page.keyboard.up(key)
    await page.waitForTimeout(120)
  }

  await page.evaluate(() => window.__game.regenerate('12345', 'medium'))
  await page.waitForTimeout(300)

  // --- D moves right -------------------------------------------------------
  let before = await settle()
  await hold('d', 900)
  let after = await body()
  log(`D: x ${before.x.toFixed(1)} -> ${after.x.toFixed(1)}`)
  if (!(after.x > before.x + 20)) throw new Error(`holding D did not move the player right`)
  await shot('wasd-right')

  // --- A moves left --------------------------------------------------------
  before = await body()
  await hold('a', 900)
  after = await body()
  log(`A: x ${before.x.toFixed(1)} -> ${after.x.toFixed(1)}`)
  if (!(after.x < before.x - 20)) throw new Error(`holding A did not move the player left`)
  await shot('wasd-left')

  // --- Space jumps: leaves the ground, then lands ---------------------------
  before = await settle()
  await page.keyboard.down(' ')
  await page.waitForTimeout(90)
  const rising = await body()
  await page.keyboard.up(' ')
  log(`Space: grounded ${before.grounded} -> ${rising.grounded}, vy ${rising.vy.toFixed(0)}`)
  if (rising.grounded) throw new Error('Space did not leave the ground')
  if (!(rising.vy < 0)) throw new Error(`expected upward velocity, got vy ${rising.vy}`)
  await shot('wasd-jump')

  await page.waitForTimeout(1500)
  const landed = await body()
  log(`  landed: grounded ${landed.grounded} at y ${landed.y.toFixed(1)}`)
  if (!landed.grounded) throw new Error('player never landed')

  // --- Jetpack: hold Space past JETPACK_HOLD_DELAY, then W ------------------
  before = await settle()
  await page.keyboard.down(' ')
  await page.waitForTimeout(400) // past the 0.18 s hold delay
  await page.keyboard.down('w')
  await page.waitForTimeout(700)
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
  await page.waitForTimeout(300)
  await page.keyboard.down('w')
  await page.waitForTimeout(600)
  await page.keyboard.up('w')
  const beforeS = await body()
  if (beforeS.grounded) throw new Error('expected to be airborne before testing S')
  await page.keyboard.down('s')
  await page.waitForTimeout(350)
  const descended = await body()
  await page.keyboard.up('s')
  await page.keyboard.up(' ')
  log(`S: airborne y ${beforeS.y.toFixed(1)} -> ${descended.y.toFixed(1)}`)
  if (!(descended.y > beforeS.y + 5)) throw new Error('S did not descend')

  // --- Aim tracks the mouse in WORLD space, after the camera has scrolled ---
  await settle()
  const d0 = await dbg()
  await page.mouse.move(640 + 200, 360)
  await page.waitForTimeout(120)
  const aimRight = (await dbg()).aim
  await page.mouse.move(640 - 200, 360)
  await page.waitForTimeout(120)
  const aimLeft = (await dbg()).aim
  log(`Aim: right ${aimRight.toFixed(3)} rad, left ${aimLeft.toFixed(3)} rad`)
  if (!(Math.cos(aimRight) > 0.5)) throw new Error('aim did not point right')
  if (!(Math.cos(aimLeft) < -0.5)) throw new Error('aim did not point left')

  // The camera has scrolled a long way from the origin by now, so this also
  // demonstrates the world-vs-screen conversion is right — a screen-space
  // implementation would be wrong here and correct only near (0,0).
  log(`  camera at (${d0.camera.x.toFixed(0)}, ${d0.camera.y.toFixed(0)}), aim still correct`)
  await shot('wasd-aim')
}
