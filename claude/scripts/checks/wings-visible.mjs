/**
 * T21.34 — the unicorn wings are **visible on the player**, asserted on rendered pixels. **Rewritten by T23.14**
 * (R13): the player is M23's stick figure in the world renderer, and the wings are two ink feathers swept up from
 * its shoulder blades (`look/actors/figure.ts::wings`) — the sprite art and its accent colours, which this check
 * matched, retired with the sprite body.
 *
 * ## 1. Counted at both ends
 *
 * Before `giveWings()` neither the sim nor the figure handed to the renderer (`debug().figure`) has wings; after
 * it, both do (the move-mods byte → `PlayerFlags.wings` → the pose's `wings`).
 *
 * ## 2. On the canvas (a control region and a control frame)
 *
 * The scene frozen, the renderer is handed the live figure with its wings and with them off, and the world canvas
 * is read each time. **Subject: behind and above the shoulders** (the side the figure faces away from) must change
 * by `WING_MIN`. **Control region: the torso** — the wings are drawn behind the body, so it must not change.
 * **Control frame:** the wingless figure drawn twice is identical there.
 */
import { freezeStill, frameWith, rectDelta, withPose } from './figure-frames.mjs'

/** Mean |Δ| per channel the wings must make behind the shoulders (levels; measured 2026-09-27, seed 4242: 16.2). */
const WING_MIN = 6
/** The torso may change by no more than this. */
const TORSO_MAX = 0.5

export default async function ({ shot, page, log }) {
  const dbg = () => page.evaluate(() => window.__game.debug())
  const before = await dbg()
  if ((before.player.moveMods ?? 0) !== 0) throw new Error(`the sandbox player already carries passives (${before.player.moveMods})`)
  if (!before.figure || before.figure.opts.J.wings) throw new Error(`before pickup the figure draws wings: ${JSON.stringify(before.figure?.opts.J)}`)
  if (!(await page.evaluate(() => window.__game.giveWings()))) throw new Error('giveWings() reported the wings were not picked up')
  const d = await freezeStill(page)
  if ((d.player.moveMods ?? 0) === 0) throw new Error('the mirror does not report the wings after granting them')
  if (d.figure.opts.J.wings === false || d.figure.opts.J.wings === undefined) throw new Error('the sim has wings and the figure handed to the renderer does not draw them')
  log(`both ends: moveMods ${d.player.moveMods}, figure.J.wings ${d.figure.opts.J.wings}`)

  const a = d.figure
  const s = a.opts.s
  const face = a.opts.face
  const back = [a.x - face * 15 * s, a.x - face * 2 * s].sort((p, q) => p - q)
  const hipY = a.opts.J.hipY ?? -13
  const wingRect = [back[0], a.y + (hipY - 22) * s, back[1], a.y + (hipY - 9) * s]
  const torso = [a.x - 0.5 * s, a.y + (hipY - 7) * s, a.x + 1.5 * s, a.y + (hipY - 2) * s]
  const bare = withPose(a, (J) => ({ ...J, wings: false }))
  const winged = await frameWith(page, [a])
  await shot('wings-after')
  const plain = await frameWith(page, [bare])
  await shot('wings-before')
  const plain2 = await frameWith(page, [bare])
  const w = rectDelta(winged, plain, wingRect)
  const t = rectDelta(winged, plain, torso)
  const c = rectDelta(plain, plain2, wingRect)
  log(`behind the shoulders ${JSON.stringify(wingRect.map(Math.round))}: winged vs bare ${w.mean.toFixed(2)} (${w.px} px, min ${WING_MIN}); torso ${t.mean.toFixed(2)} (max ${TORSO_MAX}); control bare vs bare ${c.mean.toFixed(3)}`)
  const problems = []
  if (!(w.px > 0 && w.mean >= WING_MIN)) problems.push(`the wings change the shoulders' back by only ${w.mean.toFixed(2)} (min ${WING_MIN})`)
  if (!(t.mean <= TORSO_MAX)) problems.push(`the torso changed by ${t.mean.toFixed(2)}: the wings are not behind the body, or the frame moved`)
  if (c.mean !== 0) problems.push(`control: the same figure drawn twice differs by ${c.mean.toFixed(3)}`)
  await page.evaluate(() => {
    window.__world.setActors(null)
    window.__game.freeze(false)
  })
  if (problems.length) throw new Error(`wings-visible: ${problems.join('; ')}`)
}
