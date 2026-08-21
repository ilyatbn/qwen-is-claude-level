/**
 * `ordnance-visible` — §C4: you must be able to see what you fired.
 *
 * The bug: `OrdnanceLayer.addProjectile` existed, `WorldMirror` had tracked
 * projectiles since T6.08, and nothing ever called one from the other. Rockets and
 * grenades were invisible in the game — the single most important thing a shooter
 * draws. §A39, thirteenth instance.
 *
 * Asserting on the frame is the whole point (§C2). "The server says three
 * projectiles are alive" was true the entire time it was broken.
 */
import { samplePatch, assertChanged } from './pixels.mjs'

export default async function ({ page, shot, log }) {
  await page.evaluate(() => window.__game.regenerate('12345', 'medium'))
  await page.waitForTimeout(600)

  // Somewhere with open air to fly through, and the camera on it.
  const origin = await page.evaluate(() => {
    const g = window.__game
    const pts = g.core.meta.spawn_points
    const p = pts[0]
    return { x: p.x, y: p.y - 60 }
  })
  await page.evaluate((o) => window.__game.place(o.x, o.y), origin)
  await page.waitForTimeout(400)

  // Fire, then find where the projectile actually is and photograph THAT.
  // Steering the aim would need a control the sandbox does not have; reading the
  // position needs nothing and frames the subject exactly (§A22 — a screenshot
  // that does not contain its subject is not evidence).
  const control = { x: 60, y: 560, w: 100, h: 100 }
  const controlBefore = await samplePatch(page, control)
  await shot('ordnance-before')

  await page.evaluate(() => window.__game.fire())
  await page.waitForTimeout(120)

  const shot1 = await page.evaluate(() => {
    const g = window.__game
    const live = g.core.liveProjectiles()
    if (live.length === 0) return null
    const d = g.debug()
    const p = live[0]
    return {
      sx: (p.x - d.worldView.x) * d.zoom,
      sy: (p.y - d.worldView.y) * d.zoom,
      live: d.projectilesLive,
      drawn: d.projectilesDrawn,
    }
  })
  if (!shot1) throw new Error('nothing was fired, so nothing about visibility has been tested')

  // Count at both ends (§A39).
  log(`core says ${shot1.live} alive, layer draws ${shot1.drawn}`)
  if (shot1.live !== shot1.drawn) {
    throw new Error(
      `${shot1.live} projectiles alive and ${shot1.drawn} drawn — exactly the gap ` +
        'that made rockets invisible',
    )
  }

  const R = 70
  const patch = {
    x: Math.max(0, Math.min(1280 - 2 * R, Math.round(shot1.sx - R))),
    y: Math.max(0, Math.min(720 - 2 * R, Math.round(shot1.sy - R))),
    w: 2 * R,
    h: 2 * R,
  }
  // The "before" for this patch is the same region with no projectile in it: take
  // it after the projectile has moved on, which is the honest control frame.
  const during = await samplePatch(page, patch)
  await shot('ordnance-inflight')

  await page.waitForTimeout(1800) // let it detonate and clear
  const afterGone = await samplePatch(page, patch)
  const controlAfter = await samplePatch(page, control)

  const r = assertChanged(afterGone, during, {
    label: 'a projectile in flight',
    control: { before: controlBefore, after: controlAfter },
    minDelta: 3,
  })
  log(`the projectile changed its patch by ${r.delta.toFixed(1)}; control held at ${r.controlDelta.toFixed(1)}`)
}
