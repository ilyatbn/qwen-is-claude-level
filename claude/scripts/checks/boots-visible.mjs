/**
 * T21.02 — the ironman boots are **visible on the player**, asserted on rendered pixels. **Rewritten by T23.14**
 * (R13): the player is M23's stick figure, drawn in the world renderer, and the boots are ink blocks round its
 * feet (`look/actors/figure.ts::boot`) — the sprite art this check photographed retired with the sprite body.
 *
 * ## 1. Counted at both ends
 *
 * Before `giveBoots()` the sim reports no boots and the figure handed to the renderer (`debug().figure`) draws
 * none; after it, both say boots. The move-mods byte → `PlayerFlags.boots` → the pose's `boots` is the chain.
 *
 * ## 2. On the canvas (a control region and a control frame, `docs/72` §C2)
 *
 * The scene frozen, the renderer is handed the live figure twice — as it is (booted) and with `boots` off — and
 * the world canvas is read each time. **Subject: the feet** must change by `FEET_MIN`. **Control region: the
 * head**, which no boot touches, must not change (≤ `HEAD_MAX`) — else the frame moved and the feet prove nothing.
 * **Control frame:** the unbooted figure drawn twice is identical at the feet.
 */
import { freezeStill, frameWith, rectDelta, withPose } from './figure-frames.mjs'

/** Mean |Δ| per channel the boots must make at the feet (levels; measured 2026-09-27, seed 4242: 20.7). */
const FEET_MIN = 6
/** The head may change by no more than this. */
const HEAD_MAX = 0.5

export default async function ({ shot, page, log }) {
  const dbg = () => page.evaluate(() => window.__game.debug())
  const before = await dbg()
  if ((before.player.moveMods ?? 0) !== 0) throw new Error(`the sandbox player already carries passives (${before.player.moveMods})`)
  if (!before.figure || before.figure.opts.J.boots) throw new Error(`before pickup the figure draws boots: ${JSON.stringify(before.figure?.opts.J)}`)
  if (!(await page.evaluate(() => window.__game.giveBoots()))) throw new Error('giveBoots() reported the boots were not picked up')
  const d = await freezeStill(page)
  if ((d.player.moveMods ?? 0) === 0) throw new Error('the mirror does not report the boots after granting them')
  if (!d.figure.opts.J.boots) throw new Error('the sim has boots and the figure handed to the renderer does not draw them')
  log(`both ends: moveMods ${d.player.moveMods}, figure.J.boots ${d.figure.opts.J.boots}`)

  const a = d.figure
  const s = a.opts.s
  const feet = [a.x - 9 * s, a.y - 4 * s, a.x + 9 * s, a.y + 2 * s]
  const head = [a.x - 3 * s, a.y - 33 * s, a.x + 6 * s, a.y - 25 * s]
  const bare = withPose(a, (J) => ({ ...J, boots: false }))
  const booted = await frameWith(page, [a])
  await shot('boots-after')
  const plain = await frameWith(page, [bare])
  await shot('boots-before')
  const plain2 = await frameWith(page, [bare])
  const f = rectDelta(booted, plain, feet)
  const h = rectDelta(booted, plain, head)
  const c = rectDelta(plain, plain2, feet)
  log(`feet ${JSON.stringify(feet.map(Math.round))}: booted vs bare ${f.mean.toFixed(2)} (${f.px} px, min ${FEET_MIN}); head ${h.mean.toFixed(2)} (max ${HEAD_MAX}); control bare vs bare ${c.mean.toFixed(3)}`)
  const problems = []
  if (!(f.px > 0 && f.mean >= FEET_MIN)) problems.push(`the boots change the feet by only ${f.mean.toFixed(2)} (min ${FEET_MIN})`)
  if (!(h.mean <= HEAD_MAX)) problems.push(`the head changed by ${h.mean.toFixed(2)}: the frame moved`)
  if (c.mean !== 0) problems.push(`control: the same figure drawn twice differs at the feet by ${c.mean.toFixed(3)}`)
  await page.evaluate(() => {
    window.__world.setActors(null)
    window.__game.freeze(false)
  })
  if (problems.length) throw new Error(`boots-visible: ${problems.join('; ')}`)
}
