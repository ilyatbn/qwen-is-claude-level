/** §A3 at night: tracers and a rocket lighting the map. */
export default async function ({ page, shot, log }) {
  await page.evaluate(() => window.__game.regenerate('12345', 'medium'))
  await page.waitForTimeout(500)
  await page.evaluate(() => window.__game.setTime(90))
  await page.waitForTimeout(400)

  // A rocket in flight, aimed along whichever lane is actually open.
  //
  // This aimed at a fixed screen offset — `(640 + 160, 360 - 260)`, steeply up
  // and to the right — on the reasoning that up is where the air is. Pass 6b
  // stamps scenery into the terrain, and on this seed there is now something in
  // that lane: the rocket detonated on it inside the 60 ms sample window and the
  // check reported `projectiles: 0` as "no projectile in flight". The rocket was
  // fine; the direction was a guess that stopped being true.
  //
  // So probe the client's own mask for the longest clear run and fire down that.
  const lane = await page.evaluate(() => {
    const g = window.__game
    const me = g.core.playerState(g.debug().me ?? 0)
    if (!me) return null
    let best = null
    // The upward arc only: a rocket fired downward buries itself in the slope
    // the player is standing on, which is the original comment's point and
    // still right.
    for (let deg = -170; deg <= -10; deg += 5) {
      const a = (deg * Math.PI) / 180
      const dx = Math.cos(a)
      const dy = Math.sin(a)
      let d = 16
      for (; d < 600; d += 8) {
        if (g.core.solidAt(Math.round(me.x + dx * d), Math.round(me.y + dy * d))) break
      }
      if (!best || d > best.clear) best = { deg, clear: d }
    }
    return best
  })
  if (!lane) throw new Error('no player to fire from')
  // Fail rather than fire into a wall and report it as a renderer fault.
  if (lane.clear < 300) {
    throw new Error(
      `the clearest upward lane is only ${lane.clear} px before it hits terrain — ` +
        'a rocket cannot get airborne here, so this fixture has nowhere to shoot',
    )
  }
  log(`firing along ${lane.deg} deg, ${lane.clear} px of clear air`)
  const a = (lane.deg * Math.PI) / 180
  await page.mouse.move(640 + Math.cos(a) * 240, 360 + Math.sin(a) * 240)
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
  // Freeze tracer decay before the shot: 0.09 s is shorter than a screenshot
  // round-trip, and the first version of this check photographed an empty
  // hillside while asserting a tracer existed.
  await page.evaluate('window.__game.holdTracers(true)')
  await page.waitForFunction('window.__game.ordnance().tracers > 0', null, { timeout: 10000 })
  // Let the frozen tracer survive at least one render + lightmap pass before the
  // capture. Without this the shot lands between frames and photographs the
  // hillside the tracer is about to cross.
  await page.waitForTimeout(400)
  const lit = await page.evaluate(() => window.__game.ordnance().lights)
  if (lit < 3) throw new Error(`tracer emits only ${lit} lights — it will be lost in the dark`)
  await shot('night-tracers')
  await page.evaluate('window.__game.holdTracers(false)')
  const during = await page.evaluate(() => window.__game.ordnance())
  await page.evaluate(() => clearInterval(window.__smg))
  log(`during sustained fire: ${JSON.stringify(during)}`)
  if (during.tracers < 1) throw new Error('sustained fire shows no tracers')
}
