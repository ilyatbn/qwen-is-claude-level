/** §A3 at night: gunfire and a rocket lighting the map (§F1 — bullets, not tracers). */
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

  // Then the smg. `fire_ready_at` is per PLAYER, so the bazooka's 0.9 s cooldown
  // gates the switch (deliberate — swapping weapons must not bypass a cooldown).
  //
  // **This half used to be about tracers, and since §F1 it is about bullets.**
  // The smg was `Delivery::Hitscan`: it returned `{hitscan: [...]}` and drew a
  // 90 ms tracer, which was shorter than a screenshot round-trip and needed
  // `holdTracers` to be photographed at all. It fires a projectile now, and the
  // claim under test is unchanged — sustained fire has to light the dark — but
  // the thing that carries the light is a round in flight rather than a decaying
  // line. That it no longer needs freezing to be seen is the point of §F1.
  await page.waitForTimeout(1000)
  // **By key, not by index.** §F5 puts a shovel in slot 0 of every player, which
  // moved the sandbox loadout one slot along: `selectSlot(2)` was the smg and is
  // now the grenade — which is also a projectile, so the assertion below would
  // have gone on passing while measuring the wrong weapon.
  await page.evaluate(() => {
    const inv = window.__game.inventory()
    const i = inv.slots.findIndex((s) => s && s.key === 'smg')
    if (i < 0) throw new Error(`no smg in the sandbox loadout: ${JSON.stringify(inv.slots)}`)
    window.__game.selectSlot(i)
  })
  const first = await page.evaluate(() => window.__game.fire())
  if (!first.projectile) throw new Error(`the smg did not fire: ${JSON.stringify(first)}`)
  await page.waitForFunction('window.__game.ordnance().projectiles > 0', null, { timeout: 5000 })
  o = await page.evaluate(() => window.__game.ordnance())
  log(`immediately after one shot: ${JSON.stringify(o)}`)
  if (o.projectiles < 1) throw new Error('no bullet in the air from an smg shot')

  await page.evaluate(() => {
    window.__smg = setInterval(() => window.__game.fire(), 40)
  })
  await page.waitForTimeout(400)
  // No freeze: a round crosses the map over most of a second, so it is on screen
  // for the whole capture. The assertion is the same one the tracer half made —
  // ordnance emits light — read off a body that is genuinely there.
  await page.waitForFunction('window.__game.ordnance().projectiles > 0', null, { timeout: 10000 })
  await page.waitForTimeout(400)
  const lit = await page.evaluate(() => window.__game.ordnance().lights)
  if (lit < 3) throw new Error(`gunfire emits only ${lit} lights — it will be lost in the dark`)
  await shot('night-tracers')
  const during = await page.evaluate(() => window.__game.ordnance())
  await page.evaluate(() => clearInterval(window.__smg))
  log(`during sustained fire: ${JSON.stringify(during)}`)
  if (during.projectiles < 1) throw new Error('sustained fire puts no rounds in the air')
}
