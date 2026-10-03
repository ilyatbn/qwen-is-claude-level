/**
 * `look-gate-f4` — T23.22: **F4, the cast sheet, at Level A.** The look-lab's F4 (figures, animals, props, rim passes
 * on) against the mockup's cast (`controls/F4-cast.png`, `castonly.js`), `deltaE_actors` over F4's 16 actor boxes
 * within this back end's actor threshold (R25), in the reference harness's browser — `look-gate.mjs::actorGate`.
 *
 * **Must fail:** `actor-rim-off` (R25's must-fail set holds rim-off), R19's lab knobs `exposure-up`, `bloom-off`,
 * `fog-off`, and `only=world` (no cast at all). `actor-atlas` (the atlas cache, rim-off reference) and `rim-light` (the
 * rim's side, the halo) hold the live halves.
 */
import { actorGate } from '../lib/look-gate.mjs'

/** F4's cast (`scenes/F4.ts`, counted against `variant_F4.js` by `scenes.test.ts`; `actor-atlas.mjs::F4_ACTORS`). */
const F4_ACTORS = 16

export default async function ({ page, shot, log }) {
  const { problems } = await actorGate({
    origin: new URL(page.url()).origin,
    scene: 'F4',
    reference: 'controls/F4-cast.png',
    knobs: ['&knob=actor-rim-off', '&knob=exposure-up', '&knob=bloom-off', '&knob=fog-off', '&only=world'],
    count: F4_ACTORS,
    // The reference is the cast with the fx and the text taken out (`castonly.js`), as `rim-light` §1 renders it.
    base: '&knob=fx-off',
    log,
    shotName: 'look-gate-f4',
  })
  await shot('look-gate-f4')
  if (problems.length) throw new Error(problems.join('\n'))
}
