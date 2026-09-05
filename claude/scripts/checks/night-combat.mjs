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
  // **Polled, not slept for**, and the threshold is untouched (T19.22's shape,
  // repaired here because it went red in three of this shift's gates and green
  // 3/3 standalone). The smg is firing every 40 ms for this whole window, so
  // how many rounds are alive *at one instant* is a lottery the sample used to
  // enter after two bare `waitForTimeout`s: it reads 3 on an idle box and 2
  // under gate load. Giving the condition a bounded window to be observed in
  // does not lower the bar — a client that genuinely emits fewer than 3 never
  // satisfies the poll, and fails below with the same message and the same
  // number.
  const NEEDED = 3
  await page
    .waitForFunction((n) => window.__game.ordnance().lights >= n, NEEDED, { timeout: 10_000 })
    .catch(() => {})
  const lit = await page.evaluate(() => window.__game.ordnance().lights)
  if (lit < NEEDED) {
    throw new Error(`gunfire emits only ${lit} lights — it will be lost in the dark`)
  }
  await shot('night-tracers')
  const during = await page.evaluate(() => window.__game.ordnance())
  await page.evaluate(() => clearInterval(window.__smg))
  log(`during sustained fire: ${JSON.stringify(during)}`)
  if (during.projectiles < 1) throw new Error('sustained fire puts no rounds in the air')

  // --- a carried flashlight widens the night radius (T20.07) -----------------
  //
  // **This scene, deliberately.** Six production sites hardcoded
  // `flashlightOn: false` and **four of them are in `SandboxScene`** — this check
  // drives the sandbox, `fog-visible` drives `GameScene`, and a fix applied to
  // only one pair leaves the other check looking at unchanged literals. So this
  // is the sandbox half of the falsification, and `fog-visible` is the other.
  //
  // The design here **reverses `docs/72` §C13**, which specifies the opposite
  // trade; the coordinator asked for it explicitly and `tasks/M20/T20.07` records
  // the override. Carrying one is enough — not toggled, not the active slot.
  //
  // `debug().fov` is the radius the **lightmap last rendered with** — the same
  // number it hands the minimap. It used to be recomputed inside the debug handle,
  // a third copy of the formula that would have reported a widened radius from a
  // scene still drawing the old one; T20.07 made it report the drawn value.
  {
    const k = await page.evaluate(() => window.__game.constants())
    const fovNow = () => page.evaluate(() => window.__game.debug().fov)

    // Night, from the same `setTime` the tracer half above used.
    await page.evaluate(() => window.__game.setTime(90))
    await page.waitForTimeout(200)
    const darkBefore = await page.evaluate(() => window.__game.debug().darkness)
    const nightOff = await fovNow()

    const held = await page.evaluate(() => window.__game.giveFlashlight())
    if (!held) throw new Error('giveFlashlight() did not put one in the bag')
    await page.waitForTimeout(200)
    const nightOn = await fovNow()
    const darkAfter = await page.evaluate(() => window.__game.debug().darkness)

    // The control on the *instrument*: the two reads must be at the same time of
    // day, or the darkness lerp explains the difference and the flashlight is
    // credited with the clock.
    if (Math.abs(darkAfter - darkBefore) > 1e-6) {
      throw new Error(
        `darkness moved between the two samples (${darkBefore} -> ${darkAfter}), so the ` +
          'radius difference is not attributable to the flashlight',
      )
    }
    const want = nightOff * k.FLASHLIGHT_FOV_MULT
    if (Math.abs(nightOn - want) > 0.5) {
      throw new Error(
        `a carried flashlight took the night radius ${nightOff.toFixed(1)} -> ` +
          `${nightOn.toFixed(1)}, not ${want.toFixed(1)} (x${k.FLASHLIGHT_FOV_MULT})`,
      )
    }
    log(`night radius ${nightOff.toFixed(1)} -> ${nightOn.toFixed(1)} with a flashlight`)

    // **And nothing by day** — the control that stops "it widens the view" being
    // satisfied by a torch that widens it always. Same bag, same map, only the
    // clock moves.
    await page.evaluate(() => window.__game.setTime(30))
    await page.waitForTimeout(200)
    const dayDark = await page.evaluate(() => window.__game.debug().darkness)
    if (dayDark > 0.001) {
      throw new Error(`setTime(30) is not daylight (darkness ${dayDark}) — the control is void`)
    }
    const dayOn = await fovNow()
    if (Math.abs(dayOn - k.FOV_DAY) > 0.5) {
      throw new Error(
        `a flashlight changed the daytime radius: ${dayOn.toFixed(1)} against ` +
          `FOV_DAY ${k.FOV_DAY} — it is meant to do nothing at noon`,
      )
    }
    log(`day radius ${dayOn.toFixed(1)} with the same flashlight — unchanged (control)`)
    await page.evaluate(() => window.__game.setTime(null))
  }
}
