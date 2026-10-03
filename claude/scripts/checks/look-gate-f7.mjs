/**
 * `look-gate-f7` — T23.22: **F7, the pose sheet, at Level A.** The look-lab's F7 (idle, the run cycle, jump, jet, space
 * thrust with the helmet, fall, land, melee, throw, hit, dead, five aims) against the mockup's poses with only what the
 * lab does not draw taken out (`controls/F7-poses.png`, `posesonly.js`), `deltaE_actors` over F7's 24 boxes within this
 * back end's actor threshold, in the reference harness's browser — `look-gate.mjs::actorGate`. `stick-figure` holds
 * the live figure (running moves the feet; two seats' scarves).
 *
 * **Must fail:** `actor-rim-off`, `actor-jet-off` (the jet and thrust plumes out), `exposure-up`, `bloom-off`.
 */
import { actorGate } from '../lib/look-gate.mjs'

/** F7's cast: 23 figures and the landing's dust (`stick-figure.mjs::F7_ACTORS`). */
const F7_ACTORS = 24

export default async function ({ page, shot, log }) {
  const { problems } = await actorGate({
    origin: new URL(page.url()).origin,
    scene: 'F7',
    reference: 'controls/F7-poses.png',
    knobs: ['&knob=actor-rim-off', '&knob=actor-jet-off', '&knob=exposure-up', '&knob=bloom-off'],
    count: F7_ACTORS,
    log,
    shotName: 'look-gate-f7',
  })
  await shot('look-gate-f7')
  if (problems.length) throw new Error(problems.join('\n'))
}
