/**
 * `look-gate-f2` — T23.22: **F2, the volcanic night, at Level A** (docs/78 §A7: F2 is the volcanic world look now,
 * built by T23.31). The look-lab's F2 world (`&only=world`) against the mockup's (`controls/F2-world.png`, byte-identical
 * twice), every `look-thresholds.json` metric of this back end (R25; F1's thresholds — the same arena), regions from
 * `regions-F1.png` with F2's actor boxes. `look-gate-f1`'s method, through `look-gate.mjs::worldGate`.
 *
 * **Must fail:** R19's lab knobs `fog-off`, `exposure-up`/`-down`, and `grade-off`; `lava-off` (the
 * seams' term out — the comparison sees the lava); and the classic world (F1's scene) against F2's reference — the
 * comparison sees the palette. `look-volcanic` holds the rest of the world look (the backdrop, the embers, the
 * creatures) and F2 whole against its picture.
 *
 * **Not a control here: `bloom-off`.** Measured (T23.22, `gates/builderH-gates-f2.txt`): it moves F2's world frame by
 * **0 levels, max 0** — F2 has no moon and nothing in its world crosses the bloom threshold, so there is no bloom to
 * see and a control that changes no pixel cannot fail. Bloom is held where it draws: F1's moon (`look-gate-f1`'s
 * `bloomBox`/`bloomHalo`) and the casts (`look-gate-f4`/`-f6`/`-f7`, where `bloom-off` fails).
 */
import { loadPng, withActors, actorBoxes } from '../lib/look-compare.mjs'
import { ref, worldGate } from '../lib/look-gate.mjs'

export default async function ({ page, shot, log }) {
  const { problems } = await worldGate({
    page,
    origin: new URL(page.url()).origin,
    scene: 'F2',
    reference: 'controls/F2-world.png',
    regions: withActors(loadPng(ref('controls/regions-F1.png')), actorBoxes('F2')),
    controls: [
      { name: 'fog-off', extra: '&knob=fog-off' },
      { name: 'exposure-up', extra: '&knob=exposure-up' },
      { name: 'exposure-down', extra: '&knob=exposure-down' },
      { name: 'grade-off', extra: '&knob=grade-off' },
      { name: 'lava-off', extra: '&knob=lava-off' },
      { name: 'F1 (the classic palette)', scene: 'F1' },
    ],
    log,
    shotName: 'look-gate-f2',
  })
  await shot('look-gate-f2')
  if (problems.length) throw new Error(problems.join('\n'))
}
