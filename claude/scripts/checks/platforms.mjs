/**
 * T21.11A — the gun platforms are actually on screen.
 *
 * The failure this exists to catch is the one this project has shipped four
 * times: a mechanism that is generated, wired, unit-tested and drawn by nothing.
 * `docs/72` §C2 is the answer — for anything visible, assert on rendered pixels,
 * with a control region and a control frame.
 *
 * Both are here and neither is optional:
 *
 * - **the control region** is a patch the same size, offset well clear of the
 *   platform. It must *not* change when the layer is hidden, or the check is
 *   measuring the whole screen redrawing rather than the turret;
 * - **the control frame** is the same camera, the same map and the same light
 *   with the layer hidden. Two *locations* cannot be that control, and neither
 *   can two maps — which is why `showPlatforms(false)` exists.
 *
 * It also counts the thing at both ends: what generation produced against what
 * the layer drew. Either number alone passes against a layer wired to nothing.
 */
import { samplePatch, assertChanged, toScreen } from './pixels.mjs'

export default async function ({ page, shot, log }) {
  const plats = () => page.evaluate(() => window.__game.platforms())

  // 31337, not 4242 (T21.40): platforms are seated or not placed, and 4242 medium
  // has no seated spot, so it carries none.
  await page.evaluate(() => window.__game.regenerate('31337', 'medium'))
  await page.waitForTimeout(900)

  const c = await page.evaluate(() => window.__game.constants())
  const want = c.GUN_PLATFORMS
  if (!(want > 0)) throw new Error(`GUN_PLATFORMS is ${want} — nothing to assert`)

  const p = await plats()
  log(`declared ${p.total}, drawn ${p.count} (GUN_PLATFORMS ${want})`)
  // **"Up to 3"** (T21.14): clearing the candidates of pads and spawns can leave
  // a cramped map seating fewer. Measured over 90 maps: 88 get three, one gets
  // two, one gets one — and none gets a platform on a spawn point, which is the
  // defect that clearance prevents.
  if (p.total < 1 || p.total > want) {
    throw new Error(`the map generated ${p.total} platforms, expected 1..=${want}`)
  }
  if (p.count !== p.total) {
    throw new Error(`${p.total} platforms declared and ${p.count} drawn — the layer is not running`)
  }

  // Frame one. §A22: a screenshot that does not contain its subject is not
  // evidence, and this project has taken one of an empty snowfield before.
  const target = p.at[0]
  // **Stand to the side, not on it.** `place` moves the player *and* the camera,
  // and a player standing on the platform is a player occluding the thing being
  // photographed — which is what the first version of this check did, and why
  // it measured 2.8: most of the patch was a character sprite that does not
  // move when the turret layer is hidden.
  const standOff = c.GUN_PLATFORM_W * 2.5
  await page.evaluate(
    ([x, y]) => window.__game.place(x, y - 40),
    [target.x - standOff, target.y],
  )
  await page.waitForTimeout(700)

  // **Freeze the clock before sampling anything.**
  //
  // Measured, not assumed: with it running, the control region moved 7.4 against
  // a threshold of 8 while the subject moved 8.2 — both within 0.8 of the line,
  // in opposite directions, which is a check that passes on a coin flip. The
  // cause is the whole frame: the day/night cycle re-darkens every pixel through
  // the lightmap and the clouds drift, so *everything* changes between two
  // shots 300 ms apart and the turret's own contribution is buried in it.
  //
  // `t = 0` is full daylight (`cycle.rs::a_round_starts_in_full_daylight`), so
  // the lightmap is at its most transparent and the turret is at its most
  // legible. Both borrowings are reversed at the end — `setTime`'s own comment
  // records that freezing the clock and not giving it back moved a neighbour's
  // delta from 63 to 23.
  await page.evaluate(() => {
    window.__game.setTime(0)
    window.__game.setParallaxClock(0)
  })
  await page.waitForTimeout(250)

  // **Sample where the change is** (§A15), not over the whole art box.
  //
  // The art stands `GUN_PLATFORM_W * ART_H_FRACTION` above the feet line, and
  // its top half is the hub and the three barrels — dark steel and a hazard
  // stripe against pale terrain. The bottom half is the plinth, which sits
  // against ground of a similar value. Sampling the whole box averaged the
  // second into the first and reported 7.2 against a threshold of 8, on a frame
  // where the turret is plainly visible.
  const artH = c.GUN_PLATFORM_W * 0.95
  const bandH = artH * 0.55
  const sampleY = target.y - (artH - bandH / 2)
  const onPlatform = await toScreen(page, target.x, sampleY)
  if (!onPlatform.onScreen) throw new Error('the framed platform is off camera')

  // **The control offset is chosen, not assumed.** A fixed ±4 footprints put it
  // off camera: `place` centres the camera but the rig clamps at the map edges,
  // so a platform near one is not in the middle of the frame. Walk outward from
  // the smallest usable offset and take the first that is both on screen and
  // clear of *every* platform — clear of one is not clear of the layer.
  // **Clear of the player as well as of every platform.** The first version
  // checked only the platforms and picked a band the character was standing in,
  // so the "unchanged" control drifted 4.0 on the walk animation alone — a
  // control that moves is a control that is measuring something.
  const playerX = target.x - standOff
  const clearOf = (x) =>
    p.at.every((g) => Math.abs(g.x - x) >= c.GUN_PLATFORM_W * 2) &&
    Math.abs(x - playerX) >= c.PLAYER_W * 4
  let control = null
  let controlX = null
  for (const mult of [2, 2.5, 3, 4, 5]) {
    for (const dir of [1, -1]) {
      const x = target.x + dir * c.GUN_PLATFORM_W * mult
      if (!clearOf(x)) continue
      const s = await toScreen(page, x, sampleY)
      if (s.onScreen) {
        control = s
        controlX = x
        break
      }
    }
    if (control) break
  }
  if (!control) throw new Error('no on-camera control region clear of every platform')
  log(`control region at x=${Math.round(controlX)}, platform at x=${target.x}`)

  // **Sized in screen pixels, via the reported scale.** The patch is a
  // screenshot clip, and the camera runs at `CAMERA_ZOOM`, so passing a
  // world-space width straight to `page.screenshot` samples about half the
  // turret and fills the rest with terrain — which is signal thrown away.
  const scale = onPlatform.scale
  const w = Math.round(c.GUN_PLATFORM_W * 1.05 * scale)
  const h = Math.round(bandH * scale)
  const box = (s) => ({ x: Math.round(s.x - w / 2), y: Math.round(s.y - h / 2), w, h })

  /** A rect of a given **world** half-size around a world point. */
  const rectAround = async (wx, wy, halfW, halfH) => {
    const s = await toScreen(page, wx, wy)
    if (!s.onScreen) throw new Error(`(${Math.round(wx)},${Math.round(wy)}) is off camera`)
    const rw = Math.max(8, Math.round(halfW * 2 * s.scale))
    const rh = Math.max(8, Math.round(halfH * 2 * s.scale))
    return { x: Math.round(s.x - rw / 2), y: Math.round(s.y - rh / 2), w: rw, h: rh }
  }

  const shownAt = box(onPlatform)
  const controlAt = box(control)
  const shownBefore = await samplePatch(page, shownAt)
  const controlBefore = await samplePatch(page, controlAt)
  await shot('platforms-visible')

  // --- the control frame ----------------------------------------------------
  const hidden = await page.evaluate(() => window.__game.showPlatforms(false))
  if (hidden.visible !== false) throw new Error('showPlatforms(false) did not hide the layer')
  await page.waitForTimeout(300)

  const shownAfter = await samplePatch(page, shownAt)
  const controlAfter = await samplePatch(page, controlAt)
  await shot('platforms-hidden')

  const r = assertChanged(shownBefore, shownAfter, {
    label: 'the platform region, with and without the turret layer',
    control: { before: controlBefore, after: controlAfter },
  })
  log(`platform region moved ${r.delta.toFixed(1)}, control ${r.controlDelta.toFixed(1)}`)

  // --- T21.11B: the mounted state has to be visible ------------------------
  //
  // *A player who cannot tell they are mounted will think the game has frozen*
  // — they cannot move, cannot open the bag and cannot heal, so the indicator
  // is the only thing separating "mounted" from "broken". Same control shape as
  // above: the same platform, the same camera, the same frozen clock, with and
  // without a rider.
  const back0 = await page.evaluate(() => window.__game.showPlatforms(true))
  if (back0.visible !== true) throw new Error('the layer did not come back')
  await page.waitForTimeout(200)

  const unmounted = await samplePatch(page, shownAt)
  const controlUnmounted = await samplePatch(page, controlAt)

  // **Stand the rider ON the platform.** (T21.14)
  //
  // The check frames the turret from `standOff` to the side so the body does not
  // occlude the arch — correct for the visibility half above, and wrong for this
  // one: you cannot be mounted on a platform you are not standing on. It passed
  // before only because the sandbox hook lit the lamp by fiat with a hand-picked
  // id; routing that hook through the game's own derivation made the check tell
  // the truth. The lamp sits clear of a standing body's head, so nothing is
  // occluded by putting them where a rider really is.
  await page.evaluate(([x, y]) => window.__game.place(x, y - 30), [target.x, target.y])
  await page.waitForTimeout(500)
  // **Recompute the rects: `place` moved the camera.**
  //
  // `shownAt` and `controlAt` are *screen-space* clips derived from a world
  // point through the camera transform. Moving the player moves the camera with
  // them, so reusing the old rects samples a different part of the world — which
  // read as a delta of 0.0 with the lamp plainly lit, and would have been
  // diagnosed as a dead lamp if the hook had not reported `lamps lit [0]`.
  const onPlatform2 = await toScreen(page, target.x, sampleY)
  if (!onPlatform2.onScreen) throw new Error('the platform left the frame when the rider moved')
  const control2 = await toScreen(page, controlX, sampleY)
  if (!control2.onScreen) throw new Error('the control region left the frame when the rider moved')
  const shownAt2 = box(onPlatform2)
  const controlAt2 = box(control2)
  // **Sample the lamp, not the whole turret** (§A15). Geometry from the layer
  // itself, so the check cannot drift from the art.
  const lamp = await page.evaluate(() => window.__game.platforms().lamp)
  if (!lamp) throw new Error('the platform layer reports no lamp geometry')
  // One **bar**, offset clear of the rider standing in the middle of their own
  // machine — `dx` is where the layer actually put it.
  const lampAt = await rectAround(
    target.x + lamp.dx,
    target.y + lamp.dy,
    lamp.w * 0.55,
    lamp.h * 1.4,
  )
  const lampCtrlAt = await rectAround(
    controlX + lamp.dx,
    target.y + lamp.dy,
    lamp.w * 0.55,
    lamp.h * 1.4,
  )
  const unmountedOnPad = await samplePatch(page, lampAt)
  const controlOnPad = await samplePatch(page, lampCtrlAt)

  const rode = await page.evaluate(() => window.__game.mountNearestPlatform(true))
  if (rode.mounted !== true) {
    throw new Error(`mountNearestPlatform reported ${JSON.stringify(rode)} — not mounted`)
  }
  log(
    `mounted on platform ${rode.id} at ${rode.at.x},${rode.at.y}; ` +
      `rider ${JSON.stringify(rode.rider)} feet ${rode.feet}; ` +
      `derived ${JSON.stringify(rode.lit)}, lamps lit ${JSON.stringify(rode.lamps)}`,
  )
  // **Counted at both ends**: what the derivation decided, and what the layer
  // actually lit. Either alone passes against the other being broken.
  if (rode.lit.length === 0) {
    throw new Error(
      `mounted, but no platform was derived as occupied — rider feet ${rode.feet} ` +
        `vs platform y ${rode.at.y}`,
    )
  }
  if (rode.lamps.length !== rode.lit.length) {
    throw new Error(`derived ${rode.lit} occupied but ${rode.lamps} lamps are lit`)
  }
  await page.waitForTimeout(300)

  const mountedPatch = await samplePatch(page, lampAt)
  const controlMounted = await samplePatch(page, lampCtrlAt)
  await shot('platforms-mounted')

  const m = assertChanged(unmountedOnPad, mountedPatch, {
    label: 'the platform, with and without a rider',
    control: { before: controlOnPad, after: controlMounted },
  })
  log(`mounted indicator moved ${m.delta.toFixed(1)}, control ${m.controlDelta.toFixed(1)}`)

  // And put the rider back off, so the page is left as it was found.
  const off = await page.evaluate(() => window.__game.mountNearestPlatform(false))
  if (off.mounted !== false) throw new Error('the player would not dismount')

  // Put it back, so a later check in the same page is not looking at a hidden
  // layer — and assert the restore, rather than assuming it.
  const back = await page.evaluate(() => window.__game.showPlatforms(true))
  if (back.visible !== true) throw new Error('the layer did not come back')
  // And give the clock back, for the same reason `setTime` documents.
  await page.evaluate(() => {
    window.__game.setTime(null)
    window.__game.setParallaxClock(null)
  })

  log(`${p.count} platforms generated, drawn and visible in the frame`)
}
