/** §A3 at night: tracers and a rocket lighting the map. */
export default async function ({ page, shot, log }) {
  await page.evaluate(() => window.__game.regenerate('12345', 'medium'))
  await page.waitForTimeout(500)
  await page.evaluate(() => window.__game.setTime(90))
  await page.waitForTimeout(400)

  // A rocket in flight, aimed shallowly so it travels across the dark.
  // Steeply up, so it flies through open air rather than burying itself in the
  // slope the player is standing on.
  await page.mouse.move(640 + 160, 360 - 260)
  await page.waitForTimeout(200)
  await page.evaluate(() => window.__game.fire())
  await page.waitForTimeout(60)
  let o = await page.evaluate(() => window.__game.ordnance())
  log(`rocket in flight: ${JSON.stringify(o)}`)
  if (o.projectiles < 1) throw new Error('no projectile in flight')
  if (o.lights < 1) throw new Error('a rocket in the dark emits no light')
  await shot('night-rocket')

  // Then the smg. Two things matter here: fire_ready_at is per PLAYER, so the
  // bazooka's 0.9 s cooldown gates the switch (deliberate — swapping weapons must
  // not bypass a cooldown), and a tracer lives 90 ms, which is shorter than a
  // screenshot round-trip. So sustained fire from inside the page keeps tracers on
  // screen while the shot is taken.
  await page.waitForTimeout(1000)
  await page.evaluate(() => window.__game.selectSlot(2))
  const first = await page.evaluate(() => window.__game.fire())
  if (!first.hitscan) throw new Error(`the smg did not fire: ${JSON.stringify(first)}`)
  o = await page.evaluate(() => window.__game.ordnance())
  log(`immediately after one shot: ${JSON.stringify(o)}`)
  if (o.tracers < 1) throw new Error('no tracer from an smg shot')

  await page.evaluate(() => {
    window.__smg = setInterval(() => window.__game.fire(), 40)
  })
  await page.waitForTimeout(400)
  await shot('night-tracers')
  const during = await page.evaluate(() => window.__game.ordnance())
  await page.evaluate(() => clearInterval(window.__smg))
  log(`during sustained fire: ${JSON.stringify(during)}`)
  if (during.tracers < 1) throw new Error('sustained fire shows no tracers')
}
