/**
 * `look-gate-f6` — T23.22: **F6, the weapon sheet, at Level A.** The look-lab's F6 against the mockup's arsenal with
 * only what the lab does not draw taken out (`controls/F6-weapons.png`, `weaponsonly.js`; regenerated under R26 so
 * lab = mockup), `deltaE_actors` over the 22 grid boxes (21 weapons + the turret) within this back end's actor
 * threshold, in the reference harness's browser — `look-gate.mjs::actorGate`. The 1× row of figures holding each is
 * `weapons-held`'s to report (its §1 says why it is not gated), with the per-box bar and the live hand.
 *
 * **Must fail:** `actor-rim-off`, `exposure-up`, `bloom-off`.
 */
import { actorGate } from '../lib/look-gate.mjs'

/** F6's cast: 22 grid boxes then the 1× row (`weapons-held.mjs::GRID`, `::F6_ACTORS`). */
const GRID = 22
const F6_ACTORS = 44

export default async function ({ page, shot, log }) {
  const { problems } = await actorGate({
    origin: new URL(page.url()).origin,
    scene: 'F6',
    reference: 'controls/F6-weapons.png',
    knobs: ['&knob=actor-rim-off', '&knob=exposure-up', '&knob=bloom-off'],
    count: F6_ACTORS,
    take: GRID,
    log,
    shotName: 'look-gate-f6',
  })
  await shot('look-gate-f6')
  if (problems.length) throw new Error(problems.join('\n'))
}
