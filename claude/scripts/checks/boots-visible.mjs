/**
 * T21.02 — the ironman boots are **visible on the player**, asserted on
 * rendered pixels.
 *
 * `docs/72` §C2 asks for a control region *and* a control frame, and this check
 * exists because the alternative shapes cannot supply the second one. Two
 * players standing in different places share neither ground nor light, so a
 * difference between them is a difference in where they stand; and a booted
 * player photographed alone proves only that a player was drawn. The sandbox is
 * the one scene where the same body can be photographed **before and after**
 * picking the boots up, at the same position, the same camera, the same instant
 * of the day cycle — which is what a control frame means.
 *
 * ## What the two regions are
 *
 * - **Subject: the feet.** A band across the bottom of the drawn body, where a
 *   boot with an overhanging sole changes the outline (`BOOT_WIDTH_FRACTION` is
 *   1.35, deliberately wider than the leg — `tombstoneTextures` records why a
 *   recolour at `PLAYER_W` 16 is not a difference anyone can see).
 * - **Control: the head.** The same body, a band that no boot touches, in the
 *   same two frames. If the head moved as much as the feet, the frame changed
 *   everywhere and the feet prove nothing — `assertChanged` refuses that case.
 *
 * ## What this does not cover, stated rather than implied
 *
 * The **networked** path — snapshot byte to `PlayerFlags.boots` to
 * `PlayerView` — is proven separately and by different means: the wire is
 * asserted in `game-wasm`'s `the_client_predicts_a_booted_player_where_the_server_puts_them`
 * (falsified at both ends: mirror-ignores-byte and encoder-sends-zero both red
 * it), and `PlayerFlags.boots` is a required field, so the compiler names every
 * scene that would have forgotten to pass it. What is shared between the two
 * paths, and photographed here, is the last hop: `setState` actually drawing it.
 */
import { samplePatch, assertChanged, toScreen } from './pixels.mjs'

export default async function ({ page, shot, log }) {
  const dbg = () => page.evaluate(() => window.__game.debug())

  // Pinned to the engine's own constants, never to a pixel literal. Read before
  // the settle below, because the settle now has to know where the bands are.
  const c = await page.evaluate(() => window.__game.constants())
  const bodyH = c.PLAYER_H
  const bodyW = c.PLAYER_W
  if (!(bodyH > 0 && bodyW > 0)) throw new Error(`bad constants: ${bodyW}x${bodyH}`)

  // Bands in world space, converted once. The feet band starts at the body's
  // bottom and reaches a little below it, because the sole overhangs downward as
  // well as sideways; the head band is the top third and is never touched.
  const at = async () => {
    const s = await dbg()
    const px = s.player.x
    const py = s.player.y
    const feet = await toScreen(page, px, py + bodyH * 0.3)
    const head = await toScreen(page, px, py - bodyH * 0.35)
    if (!feet.onScreen || !head.onScreen) throw new Error('the player is off camera')
    const w = Math.round(bodyW * 2.2)
    const h = Math.round(bodyH * 0.5)
    return {
      feet: { x: Math.round(feet.x - w / 2), y: Math.round(feet.y - h / 2), w, h },
      head: { x: Math.round(head.x - w / 2), y: Math.round(head.y - h / 2), w, h },
    }
  }

  // **Wait for stillness, do not assume it.** A body that is still falling from
  // spawn, or sliding the last pixel down a slope, moves between the position
  // read and the screenshot — and then "the feet changed" means "the player
  // moved". A fixed sleep is the version of this that passes on a fast machine
  // and fails on a loaded one, so this waits on the property instead.
  //
  // **The body, in world space, and deliberately not the band** (T21.23). The
  // band is the body seen through a camera that is still easing long after the
  // body has stopped: measured on seed 4242, the body sat at `672.00, 866.78`
  // without moving a hundredth of a pixel for two seconds while the camera crept
  // from `672.00, 880.00` to `669.90, 879.47` and the feet band with it, 640 ->
  // 646 px. The ease is asymptotic, so waiting for the band to hold still is
  // waiting for a limit, and a longer wait only moves where it stops. The camera
  // is taken out of the comparison below instead.
  let d = null
  let still = false
  for (let i = 0; i < 40; i++) {
    const a = await dbg()
    await page.waitForTimeout(120)
    const b = await dbg()
    if (a.player && b.player && a.player.x === b.player.x && a.player.y === b.player.y) {
      d = b
      still = true
      break
    }
    d = b
  }
  if (!d || !d.player) throw new Error('the sandbox has no local player')
  if (!still) throw new Error(`the body never came to rest (${d.player.x},${d.player.y})`)

  // The control on the fixture itself: it must start with **no** boots, or the
  // "before" frame is not a control frame at all.
  if ((d.player.moveMods ?? 0) !== 0) {
    throw new Error(`the sandbox player already carries passives (${d.player.moveMods})`)
  }

  const bands = await at()
  const feetBefore = await samplePatch(page, bands.feet)
  const headBefore = await samplePatch(page, bands.head)
  await shot('boots-before')

  const on = await page.evaluate(() => window.__game.giveBoots())
  if (!on) throw new Error('giveBoots() reported the boots were not picked up')
  await page.waitForTimeout(250)

  const dAfter = await dbg()
  if ((dAfter.player.moveMods ?? 0) === 0) {
    throw new Error('the mirror does not report the boots after granting them')
  }
  // The body must not have moved, or "the feet changed" is "the player walked".
  //
  // **Asked of the body in world space** (T21.23). This compared the *bands*,
  // which are screen-space and therefore carry every pixel of camera ease along
  // with any real motion. It read `the body moved 2 px between frames (623,343
  // -> 625,343)` about a body that had not moved at all — a claim about the
  // player reported through a rectangle that also answers to the camera. The
  // world position answers to nothing but the physics, which is what the
  // sentence is about.
  const bandsAfter = await at()
  const moved = Math.max(Math.abs(dAfter.player.x - d.player.x), Math.abs(dAfter.player.y - d.player.y))
  if (moved > 1) {
    throw new Error(
      `the body moved ${moved.toFixed(2)} px between frames ` +
        `(${d.player.x.toFixed(2)},${d.player.y.toFixed(2)} -> ` +
        `${dAfter.player.x.toFixed(2)},${dAfter.player.y.toFixed(2)}) — ` +
        'the change would be motion, not boots',
    )
  }
  // **Each patch from its own frame's band.** The after-patches used to be taken
  // from the *before* rect, so a camera that had eased 2 px sampled the body 2 px
  // off — which is a change, and not the one being asserted. Recomputed here, the
  // camera cancels out of both the subject and the control: each rect is over the
  // feet and the head of the frame it is taken from, wherever the camera has put
  // them.
  const feetAfter = await samplePatch(page, bandsAfter.feet)
  const headAfter = await samplePatch(page, bandsAfter.head)
  await shot('boots-after')

  const r = assertChanged(feetBefore, feetAfter, {
    label: 'the feet, with and without ironman boots',
    control: { before: headBefore, after: headAfter },
  })
  log(
    `feet moved ${r.delta.toFixed(1)} against a head control of ` +
      `${r.controlDelta.toFixed(1)} (same body, same place, same frame otherwise)`,
  )
}
