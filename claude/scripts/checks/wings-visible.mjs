/**
 * T21.34 — the unicorn wings are **visible on the player**, asserted on
 * rendered pixels. `boots-visible`'s sibling, and built the same way for the
 * same reason: the sandbox is the one scene that can photograph the same body
 * before and after pickup, at the same position, camera and moment of the day
 * cycle, which is what a control frame means (`docs/72` §C2).
 *
 * ## What the regions are
 *
 * - **Subjects: beside each shoulder.** One patch either side of the body, where
 *   the wings stick out past the torso (`WING_WIDTH_FRACTION`). Both must change,
 *   so a wing drawn on one side only fails.
 * - **Control: the torso.** The wings are drawn *behind* the body, so the torso
 *   must not change. If it moved as much as the shoulders, the whole frame
 *   changed and the shoulders prove nothing, so `assertChanged` refuses that case.
 *
 * ## Why the body holds still
 *
 * Since T21.34 a winged player with no input **hovers**. Under T21.03's rule
 * the body rose the instant the wings were granted, so this check could not
 * have been written: "the shoulders changed" would have meant "the player
 * flew away". The world-space position is asserted unchanged below.
 *
 * ## Not covered here
 *
 * The networked path (the move-mods byte to `PlayerFlags.wings` on a remote) is
 * the same byte `boots-visible` documents, read at `GameScene`'s remote loop by
 * `flag(p.moveMods, MOVE_MOD.wings)`. `PlayerFlags.wings` is a required field,
 * so the compiler names every scene that would have forgotten to pass it.
 */
import { samplePatch, assertChanged, toScreen } from './pixels.mjs'

/**
 * The wings' two **accent** colours, mirroring `WING_EDGE` and `WING_TINT` in
 * `client/src/render/accessoryTextures.ts`. The white is left out on purpose:
 * snow and lit rock come within a few steps of it, and pink and lavender are
 * nowhere in the terrain palette. If the art's colours change, this check fails
 * loudly ("no wing drawn") — it cannot pass silently against drifted art.
 */
const WING_ACCENTS = [
  [0xff, 0x8f, 0xd0],
  [0xb9, 0xa6, 0xff],
]
/** RGB distance that still counts as the accent (NEAREST scaling keeps it exact; this allows for the lightmap). */
const WING_ACCENT_TOLERANCE = 48
/** At most this share of a tip patch may match before pickup. */
const WING_SHARE_BEFORE_MAX = 0.01
/** At least this share must match after. */
const WING_SHARE_AFTER_MIN = 0.05

/** Share of a region's pixels within `WING_ACCENT_TOLERANCE` of either accent. */
async function wingPixels(page, { x, y, w, h }) {
  const b64 = (await page.screenshot({ clip: { x, y, width: w, height: h } })).toString('base64')
  return page.evaluate(
    async ([src, accents, tol]) => {
      const img = new Image()
      img.src = `data:image/png;base64,${src}`
      await img.decode()
      const cv = document.createElement('canvas')
      cv.width = img.width
      cv.height = img.height
      const ctx = cv.getContext('2d')
      ctx.drawImage(img, 0, 0)
      const d = ctx.getImageData(0, 0, img.width, img.height).data
      let hits = 0
      for (let i = 0; i < d.length; i += 4) {
        for (const [r, g, b] of accents) {
          if (Math.hypot(d[i] - r, d[i + 1] - g, d[i + 2] - b) <= tol) {
            hits++
            break
          }
        }
      }
      return hits / (d.length / 4)
    },
    [b64, WING_ACCENTS, WING_ACCENT_TOLERANCE],
  )
}

export default async function ({ page, shot, log }) {
  const dbg = () => page.evaluate(() => window.__game.debug())

  const c = await page.evaluate(() => window.__game.constants())
  const bodyH = c.PLAYER_H
  const bodyW = c.PLAYER_W
  if (!(bodyH > 0 && bodyW > 0)) throw new Error(`bad constants: ${bodyW}x${bodyH}`)

  // **Two patches beside the shoulders, not one band across them.** The wings
  // are behind the torso and only their tips show past it, so a band spanning
  // the body averages the wing into the torso and the weapon: the first run
  // measured a mean change of 0.2 over a band whose screenshot plainly showed
  // wings.
  //
  // Pinned to `PLAYER_W`/`PLAYER_H`, never pixels; `toScreen` carries the zoom.
  const at = async () => {
    const s = await dbg()
    const px = s.player.x
    const py = s.player.y
    // Measured off `shots/wings-after.png` (seed 4242): **the wing tips**, up and
    // out, because they are the part nothing is drawn over. 0.2 up caught the
    // scalloped lower edge; 0.6 up and one body-width out moved only 4.9 on the
    // left, because the weapon aims at the crosshair and is drawn *in front of*
    // that wing — half the patch was bazooka, which the wings cannot change.
    const left = await toScreen(page, px - bodyW * 1.3, py - bodyH * 0.85)
    const right = await toScreen(page, px + bodyW * 1.3, py - bodyH * 0.85)
    // **The control is the torso, not the feet.** The feet patch sat on the
    // shoe/ground edge, where the camera's sub-pixel ease between the two frames
    // read as a change of 9.0 while the wings were plainly the only difference.
    const torso = await toScreen(page, px, py)
    if (!left.onScreen || !right.onScreen || !torso.onScreen) throw new Error('the player is off camera')
    // Screen-space size from a world-space span, so zoom cannot shrink it.
    const edge = await toScreen(page, px + bodyW * 0.5, py)
    const unit = Math.max(2, Math.abs(edge.x - torso.x)) // half a body width, in px
    const side = Math.round(unit * 0.9)
    const rect = (p, w, h) => ({ x: Math.round(p.x - w / 2), y: Math.round(p.y - h / 2), w, h })
    // The palette patches are **larger** than the change patches: the accents
    // are one-canvas-pixel rows, and a 14 px square beside them lost the pink
    // entirely to a few pixels of camera ease (right tip: 0 % after pickup).
    const tip = Math.round(unit * 2)
    return {
      left: rect(left, side, side),
      right: rect(right, side, side),
      tipLeft: rect(left, tip, tip),
      tipRight: rect(right, tip, tip),
      torso: rect(torso, Math.round(unit * 0.8), Math.round(unit * 0.8)),
    }
  }

  // Wait for the body to come to rest in world space (see boots-visible, T21.23).
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
  if ((d.player.moveMods ?? 0) !== 0) {
    throw new Error(`the sandbox player already carries passives (${d.player.moveMods})`)
  }

  const bands = await at()
  log(`patches ${JSON.stringify(bands)}`)
  const leftBefore = await samplePatch(page, bands.left)
  const rightBefore = await samplePatch(page, bands.right)
  const torsoBefore = await samplePatch(page, bands.torso)
  // Sampled **here, before the grant** — the first version read these after
  // pickup and so counted the wings themselves as scenery.
  const beforeHits = {
    left: await wingPixels(page, bands.tipLeft),
    right: await wingPixels(page, bands.tipRight),
  }
  await shot('wings-before')

  const on = await page.evaluate(() => window.__game.giveWings())
  if (!on) throw new Error('giveWings() reported the wings were not picked up')
  await page.waitForTimeout(250)

  const dAfter = await dbg()
  if ((dAfter.player.moveMods ?? 0) === 0) {
    throw new Error('the mirror does not report the wings after granting them')
  }
  // The hover is the fixture: the body must not have moved, or the change would
  // be flight, not wings. A >1 px move here is T21.03's rise-forever coming back.
  const moved = Math.max(Math.abs(dAfter.player.x - d.player.x), Math.abs(dAfter.player.y - d.player.y))
  if (moved > 1) {
    throw new Error(
      `the body moved ${moved.toFixed(2)} px between frames ` +
        `(${d.player.x.toFixed(2)},${d.player.y.toFixed(2)} -> ` +
        `${dAfter.player.x.toFixed(2)},${dAfter.player.y.toFixed(2)}) — ` +
        'a winged player with no input should hover',
    )
  }
  const bandsAfter = await at()
  const leftAfter = await samplePatch(page, bandsAfter.left)
  const rightAfter = await samplePatch(page, bandsAfter.right)
  const torsoAfter = await samplePatch(page, bandsAfter.torso)
  await shot('wings-after')

  // **The wing's own colours, not merely "something changed".** Falsified by
  // forcing `this.wings?.setVisible(false)` in `PlayerView.setState`, the
  // change-only assertion below still **passed** (right tip moved 14.1, torso
  // 0.0): the camera eased ~4 px between frames and dragged the portal's stone
  // edge through the right patch, while the torso patch rode along with the
  // body. So each tip patch must also go from (almost) no wing-palette pixels to
  // a real share of them. The "before" half is the control that the palette
  // does not match the scenery.
  log(`patches after ${JSON.stringify(bandsAfter)}`)
  const afterHits = {
    left: await wingPixels(page, bandsAfter.tipLeft),
    right: await wingPixels(page, bandsAfter.tipRight),
  }
  log(`wing-palette share before ${JSON.stringify(beforeHits)} after ${JSON.stringify(afterHits)}`)
  for (const name of ['left', 'right']) {
    if (beforeHits[name] > WING_SHARE_BEFORE_MAX) {
      throw new Error(
        `the ${name} tip patch already matched the wing palette before pickup ` +
          `(${(beforeHits[name] * 100).toFixed(1)} %) — the palette test cannot tell wings from scenery here`,
      )
    }
    if (afterHits[name] < WING_SHARE_AFTER_MIN) {
      throw new Error(
        `no wing drawn at the ${name} shoulder: ${(afterHits[name] * 100).toFixed(1)} % ` +
          `wing-palette pixels after pickup (need ${WING_SHARE_AFTER_MIN * 100} %)`,
      )
    }
  }

  // **Both sides**, so a wing drawn on one side only (a flip bug, a half canvas)
  // fails rather than passing on the other.
  for (const [name, before, after] of [
    ['left', leftBefore, leftAfter],
    ['right', rightBefore, rightAfter],
  ]) {
    const r = assertChanged(before, after, {
      label: `the ${name} shoulder, with and without unicorn wings`,
      control: { before: torsoBefore, after: torsoAfter },
    })
    log(
      `${name} shoulder moved ${r.delta.toFixed(1)} against a torso control of ` +
        `${r.controlDelta.toFixed(1)} (same body, same place, same frame otherwise)`,
    )
  }
}
