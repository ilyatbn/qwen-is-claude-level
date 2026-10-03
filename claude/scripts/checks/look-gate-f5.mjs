/**
 * `look-gate-f5` — T23.22: **F5, the moonlit day, at Level A.** The look-lab's F5 world (`&only=world`: sky, fog, lit
 * terrain, foreground, bloom, grade at F5's palette) against the mockup's (`controls/F5-world.png`), every
 * `look-thresholds.json` metric of this back end (R25; F1's thresholds — the same arena and method), regions from
 * `regions-F1.png` with F5's actor boxes, through `look-gate.mjs::worldGate`.
 *
 * **The gap it fills:** before T23.22 nothing compared `F5-world.png` — `look-day-night` holds F5's *sky*
 * (`F5-sky.png`) and the lab's F5 against the lab's own F5, so a day terrain or fog drifting from the mockup's passed.
 *
 * **Must fail:** R19's lab knobs (`fog-off`, `exposure-up`/`-down`, `bloom-off`), `grade-off`, and F1 — the night —
 * against F5's reference: the comparison tells night from day.
 */
import { loadPng, withActors, actorBoxes } from '../lib/look-compare.mjs'
import { ref, worldGate } from '../lib/look-gate.mjs'

/**
 * Reported, not gated: the 8-colour k-means (`look-gate-f3`'s SKIPS, T23.08C F1). Measured on F5 (T23.22): the lab's
 * frame at deltaE 0.022 / dssim 0.00013 from the reference — all but identical — reads paletteDE
 * **3.48**, while the reference against itself with ±1 level on a third of its channels reads 0.448 and the mockup on
 * the owner's GPU (`F5-world-d3d12.png`, deltaE 0.164) reads 1.05. A distance that grows as the pictures converge
 * measures where the cluster boundaries fall, not the look; every R19 knob still fails on the other ten.
 */
const SKIPS = ['paletteDE']

export default async function ({ page, shot, log }) {
  const { problems } = await worldGate({
    page,
    origin: new URL(page.url()).origin,
    scene: 'F5',
    reference: 'controls/F5-world.png',
    regions: withActors(loadPng(ref('controls/regions-F1.png')), actorBoxes('F5')),
    controls: [
      { name: 'fog-off', extra: '&knob=fog-off' },
      { name: 'exposure-up', extra: '&knob=exposure-up' },
      { name: 'exposure-down', extra: '&knob=exposure-down' },
      { name: 'bloom-off', extra: '&knob=bloom-off' },
      { name: 'grade-off', extra: '&knob=grade-off' },
      { name: 'F1 (the night)', scene: 'F1' },
    ],
    skips: SKIPS,
    log,
    shotName: 'look-gate-f5',
  })
  await shot('look-gate-f5')
  if (problems.length) throw new Error(problems.join('\n'))
}
