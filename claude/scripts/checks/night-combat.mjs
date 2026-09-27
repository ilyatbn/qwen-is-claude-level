/**
 * §A3 at night: gunfire and a rocket lighting the map (§F1 — bullets, not tracers).
 *
 * T23.09C F1 — rewritten on the effect lights (T23.09: the effects are the lights). It counted `ordnance().lights`
 * against 3 during SMG fire, which the effect-light rule can never give (a round is a light only as its muzzle flash,
 * `MUZZLE_FRAMES` lists); it was parked, so nobody saw. Now: the rocket carries its motor light **in the renderer's
 * list** (`__world.lights()`, both ends) at the round; sustained SMG fire flashes muzzles **at the gun** frame after
 * frame (control: none before the trigger); the rock lit by them is `effect-lights`' and `jet-flame`'s to measure.
 */
/** Frames the sustained-fire leg watches, and the least of them that must carry a muzzle light: the smg's cooldown
 * lets ~10 rounds a second through, `MUZZLE_FRAMES` (2) lists each — 20 of 60 frames measured; half, for a slow box. */
const FRAMES = 60
const FLASH_MIN = 10
/**
 * A flash is at the gun within this many px of the body's centre. Measured (T23.09C): 18.0 in every run with the flash at
 * the round's spawn point (`Core.fire`'s, the sandbox's `origin`); 34–49 run to run where it was first drawn (a combat
 * step can carry the round on before the frame's sync — F2's defect, the sandbox's shape); 50 planted on the round's
 * current place. The bound sits between the first two.
 */
const MUZZLE_REACH = 28

export default async function ({ page, shot, log }) {
  // **Every wait here polls the thing it is waiting for** (T19.22). This file had
  // ten bare `waitForTimeout` against three condition polls — a wall-clock window
  // a busy machine can miss, which is the whole of why it went red inside a full
  // suite and green standalone.
  //
  // The deadline is swallowed rather than thrown on, deliberately: each poll is
  // immediately followed by the assertion it was waiting for, so a genuine
  // failure still fails *there*, with its own message and its own number, rather
  // than being reported as "timed out". A wait must not be able to mask the
  // thing it is waiting for.
  const settle = (expr, ms = 10_000) =>
    page.waitForFunction(expr, null, { timeout: ms }).catch(() => {})

  const k = await page.evaluate(() => window.__game.constants())

  await page.evaluate(() => window.__game.regenerate('12345', 'medium'))
  // `regenerate` is synchronous through `core.generate` and the `WorldView`
  // build; what can still be outstanding is chunk baking, and that is what a
  // screenshot needs finished.
  await settle('window.__game.debug().pending === 0')
  await page.evaluate(() => window.__game.setTime(90))
  // Night, from the shipped constant rather than a guess at how long the lerp
  // takes.
  await settle(`window.__game.debug().darkness >= ${k.NIGHT_DARKNESS * 0.99}`)

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
  // The aim the scene actually adopted, not a guess at how long the pointer takes
  // to be read. Compared as an angle so the wrap at +/-pi is not a failure.
  await settle(
    `Math.abs(Math.atan2(Math.sin(window.__game.debug().aim - (${a})), ` +
      `Math.cos(window.__game.debug().aim - (${a})))) < 0.25`,
  )
  await page.evaluate(() => window.__game.fire())
  // The 60 ms here was a bet that a projectile would exist by now. This is the
  // same claim the next two lines assert, so it is polled instead.
  await settle('window.__game.ordnance().projectiles > 0')
  let o = await page.evaluate(() => window.__game.ordnance())
  log(`rocket in flight: ${JSON.stringify(o)}`)
  if (o.projectiles < 1) throw new Error('no projectile in flight')
  // The motor's light, both ends: in the scene's list and in the list the renderer holds, a few px behind the round.
  await settle(`window.__game.effectLights().some((l) => l.kind === 'rocket')`, 5000)
  const motor = await page.evaluate(() => {
    const l = window.__game.effectLights().find((e) => e.kind === 'rocket') ?? null
    const held = l ? window.__world.lights().filter((h) => h.x === l.x && h.y === l.y && h.r === l.r).length : 0
    return { l, held }
  })
  log(`rocket motor light ${JSON.stringify(motor)}`)
  if (!motor.l) throw new Error('a rocket in the dark emits no light')
  if (motor.held !== 1) throw new Error(`the rocket's light is in the scene's list but the renderer holds it ${motor.held} times`)
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
  // **The 1 s that used to sit above this was the bazooka's cooldown**, which is
  // per player and gates the switch on purpose. Nothing exposes `fire_ready_at`,
  // so this waits on the effect the assertion below names: the smg producing a
  // round. Retrying costs nothing — a shot refused by a cooldown consumes no
  // ammunition and spawns nothing — and a weapon that never fires still fails
  // below, with the refusal it actually got.
  const first = await page.evaluate(async () => {
    const deadline = Date.now() + 10_000
    let r = null
    while (Date.now() < deadline) {
      r = window.__game.fire()
      if (r && r.projectile) return r
      await new Promise((res) => requestAnimationFrame(res))
    }
    return r
  })
  if (!first || !first.projectile) {
    throw new Error(`the smg did not fire: ${JSON.stringify(first)}`)
  }
  await page.waitForFunction('window.__game.ordnance().projectiles > 0', null, { timeout: 5000 })
  o = await page.evaluate(() => window.__game.ordnance())
  log(`immediately after one shot: ${JSON.stringify(o)}`)
  if (o.projectiles < 1) throw new Error('no bullet in the air from an smg shot')

  // Control first: nothing fired for a stretch of frames, no muzzle light (the sandbox's first rounds have landed).
  const quiet = await page.evaluate(() => new Promise((res) => {
    let n = 0
    let seen = 0
    const f = () => {
      if (window.__game.effectLights().some((l) => l.kind === 'muzzle')) seen++
      if (++n < 30) requestAnimationFrame(f)
      else res(seen)
    }
    setTimeout(() => requestAnimationFrame(f), 600)
  }))
  await page.evaluate(() => {
    window.__smg = setInterval(() => window.__game.fire(), 40)
  })
  // Sustained fire (one round every 40 ms, `MUZZLE_FRAMES` lists of flash each): the frames that carry a muzzle light,
  // and how far each flash is from the body — at the gun, not wherever a round was first drawn (T23.09C F2).
  const flashes = await page.evaluate((N) => new Promise((res) => {
    let n = 0
    let seen = 0
    let far = 0
    const f = () => {
      const me = window.__game.debug().player
      const m = window.__game.effectLights().filter((l) => l.kind === 'muzzle')
      if (m.length) seen++
      for (const l of m) far = Math.max(far, Math.hypot(l.x - me.x, l.y - me.y))
      if (++n < N) requestAnimationFrame(f)
      else res({ frames: n, seen, far })
    }
    requestAnimationFrame(f)
  }), FRAMES)
  log(`muzzle flashes: control (no fire) ${quiet}/30 frames; firing ${flashes.seen}/${flashes.frames} frames, farthest ${flashes.far.toFixed(1)} px from the body (max ${MUZZLE_REACH})`)
  if (quiet !== 0) throw new Error(`control: ${quiet} frames carried a muzzle light with nothing fired`)
  if (flashes.seen < FLASH_MIN) throw new Error(`gunfire flashed in only ${flashes.seen} of ${flashes.frames} frames (min ${FLASH_MIN}) — it will be lost in the dark`)
  if (flashes.far > MUZZLE_REACH) throw new Error(`a muzzle flash ${flashes.far.toFixed(1)} px from the shooter — flashed mid-air, not at the gun`)
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

    // Night, from the same `setTime` the tracer half above used — and waited for
    // by the number the control below compares, not by a fixed 200 ms.
    await page.evaluate(() => window.__game.setTime(90))
    await settle(`window.__game.debug().darkness >= ${k.NIGHT_DARKNESS * 0.99}`)
    const darkBefore = await page.evaluate(() => window.__game.debug().darkness)
    const nightOff = await fovNow()

    const held = await page.evaluate(() => window.__game.giveFlashlight())
    if (!held) throw new Error('giveFlashlight() did not put one in the bag')
    // Wait for the radius the lightmap *rendered with* to move, which is the
    // number asserted on below. If it never moves this falls through and the
    // assertion reports the two radii it actually saw — the 200 ms could only
    // ever have hidden that.
    await settle(`window.__game.debug().fov !== ${nightOff}`)
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
    // A float tolerance on a pixel radius, shared by every comparison in this
    // block. Not a tunable — the radii are whole-ish numbers either side of it.
    const EPS_PX = 0.5

    // **Assertion one: the implementation against the constant.** This is the
    // one that reds when the scene stops applying the multiplier — T19.22's
    // falsification reported `110.0 -> 110.0, not 165.0` here — so it goes first
    // and keeps both numbers in its message.
    const want = nightOff * k.FLASHLIGHT_FOV_MULT
    if (Math.abs(nightOn - want) > EPS_PX) {
      throw new Error(
        `a carried flashlight took the night radius ${nightOff.toFixed(1)} -> ` +
          `${nightOn.toFixed(1)}, not ${want.toFixed(1)} (x${k.FLASHLIGHT_FOV_MULT})`,
      )
    }

    // **Assertion two: the constant against the feature — T19.27.**
    //
    // The line above computes `want` from `FLASHLIGHT_FOV_MULT` and compares it
    // to a radius the client also computed from `FLASHLIGHT_FOV_MULT`. Both
    // sides read the same constant, so setting it to 1.0 — switching the
    // flashlight off — makes the check agree with itself. Measured, exactly
    // that: it passed, reporting `110.0 -> 110.0`.
    //
    // That is `docs/76` §G6 inside a browser check. Pinning is still right, and
    // it is what assertion one does; what pinning cannot do is notice the
    // *constant's value* changing, because every side of the comparison moves
    // with it.
    //
    // So: the sentence the feature actually promises a player, which needs no
    // number and reds the moment the multiplier reaches 1.0. Chosen over a basis
    // pin on the constant's doc comment because it is the case that was missed,
    // it is cheaper, and it also covers an implementation that quietly stopped
    // widening anything — a basis pin would still agree with a scene drawing
    // `FOV_NIGHT` twice.
    if (!(nightOn > nightOff + EPS_PX)) {
      throw new Error(
        `a carried flashlight did not widen the night radius at all: ` +
          `${nightOff.toFixed(1)} -> ${nightOn.toFixed(1)} with FLASHLIGHT_FOV_MULT ` +
          `${k.FLASHLIGHT_FOV_MULT} — a torch that lights no further than no torch is ` +
          'the feature switched off, and assertion one cannot see it because both ' +
          'sides of it read the same constant',
      )
    }
    log(
      `night radius ${nightOff.toFixed(1)} -> ${nightOn.toFixed(1)} with a flashlight ` +
        `(pinned to x${k.FLASHLIGHT_FOV_MULT}, and strictly wider than without)`,
    )

    // **And nothing by day** — the control that stops "it widens the view" being
    // satisfied by a torch that widens it always. Same bag, same map, only the
    // clock moves.
    await page.evaluate(() => window.__game.setTime(30))
    // Daylight, waited for by the very condition the next line asserts.
    await settle('window.__game.debug().darkness <= 0.001')
    const dayDark = await page.evaluate(() => window.__game.debug().darkness)
    if (dayDark > 0.001) {
      throw new Error(`setTime(30) is not daylight (darkness ${dayDark}) — the control is void`)
    }
    // T23.09C: `debug().darkness` is computed at the call and `debug().fov` is the radius the last *drawn* frame used,
    // so the read straight after the clock moved got the night's (165 at noon — seen once this leg ran again). Waited
    // for by the value the assertion reads; a torch that widens the day still fails below with its number.
    await settle(`Math.abs(window.__game.debug().fov - ${k.FOV_DAY}) <= ${EPS_PX}`, 3000)
    const dayOn = await fovNow()
    if (Math.abs(dayOn - k.FOV_DAY) > EPS_PX) {
      throw new Error(
        `a flashlight changed the daytime radius: ${dayOn.toFixed(1)} against ` +
          `FOV_DAY ${k.FOV_DAY} — it is meant to do nothing at noon`,
      )
    }
    log(`day radius ${dayOn.toFixed(1)} with the same flashlight — unchanged (control)`)
    await page.evaluate(() => window.__game.setTime(null))
  }
}
