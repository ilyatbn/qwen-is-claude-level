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

  await page.evaluate(() => window.__game.regenerate('4242', 'medium'))
  await page.waitForTimeout(900)

  const c = await page.evaluate(() => window.__game.constants())
  const want = c.GUN_PLATFORMS
  if (!(want > 0)) throw new Error(`GUN_PLATFORMS is ${want} — nothing to assert`)

  const p = await plats()
  log(`declared ${p.total}, drawn ${p.count} (GUN_PLATFORMS ${want})`)
  if (p.total !== want) throw new Error(`the map generated ${p.total} platforms, expected ${want}`)
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

  const rode = await page.evaluate(() => window.__game.mountNearestPlatform(true))
  if (rode.mounted !== true) {
    throw new Error(`mountNearestPlatform reported ${JSON.stringify(rode)} — not mounted`)
  }
  log(`mounted on platform ${rode.id} at ${rode.at.x},${rode.at.y}`)
  await page.waitForTimeout(300)

  const mountedPatch = await samplePatch(page, shownAt)
  const controlMounted = await samplePatch(page, controlAt)
  await shot('platforms-mounted')

  const m = assertChanged(unmounted, mountedPatch, {
    label: 'the platform, with and without a rider',
    control: { before: controlUnmounted, after: controlMounted },
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
