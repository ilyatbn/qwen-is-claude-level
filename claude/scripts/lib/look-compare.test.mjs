// T23.02: look-compare separates what must pass from what must fail, before any renderer
// exists to flatter it. Every number in look-thresholds.json is re-measured here from the
// committed PNGs, so the file cannot drift from the instrument or the instrument from it.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { MUST_FAIL, actorBoxes, compare, deltaE2000, deriveThresholds, failures, labFloor, loadPng, withActors } from './look-compare.mjs'

const root = join(dirname(fileURLToPath(import.meta.url)), '../..')
const ref = p => join(root, 'tasks/M23', p)
const th = JSON.parse(readFileSync(join(root, 'scripts/lib/look-thresholds.json'), 'utf8'))
// Sky / terrain / cave from the mask, with F1's actor boxes (measured from the mockup's drawing,
// the numbers the scene description carries) painted over them as the fourth region.
const boxes = actorBoxes('F1')
const regions = withActors(loadPng(ref('reference/controls/regions-F1.png')), boxes)
const f1 = loadPng(ref(th.reference))
const file = c => th.controls[c].split(' ')[0]
const rows = Object.fromEntries(Object.keys(th.controls).map(c => [c, compare(f1, loadPng(ref(file(c))), { regions })]))
const single = Object.keys(th.controls).filter(c => c !== 'F0')
const retained = Object.keys(th.metrics)
// R19: the controls that place a threshold, and the ones only reported.
const gating = single.filter(c => MUST_FAIL.includes(c))
// T23.08: the look-lab's floor — its F1 world on SwiftShader and on the owner's GPU — re-measured from the PNGs.
const lab = labFloor(th, regions, p => loadPng(ref(p)))
const sensitivity = single.filter(c => !MUST_FAIL.includes(c))

test('the table', () => {
  const cols = ['F0', ...gating, ...sensitivity]
  const head = ['metric', 'floor', ...cols.map(c => (MUST_FAIL.includes(c) ? c : `(${c})`)), 'threshold']
  const lines = [head.map(s => s.padStart(13)).join('')]
  for (const m of [...retained, ...Object.keys(th.dropped)]) {
    const t = th.metrics[m]
    lines.push([m.padStart(13), (lab.floor[m] ?? 0).toPrecision(3).padStart(13), ...cols.map(c => rows[c][m].toPrecision(3).padStart(13)), (t ? String(t.threshold) : 'DROPPED').padStart(13)].join(''))
  }
  lines.push('(sensitivity, not gating — R19) ' + sensitivity.map(c => `${c} fails ${failures(rows[c], th).length}/${retained.length}`).join('; '))
  console.log(lines.join('\n'))
})

test('the ΔE2000 is the published one (Sharma, Wu & Dalal 2005 test pairs 1, 7, 17)', () => {
  assert.equal(deltaE2000([50, 2.6772, -79.7751], [50, 0, -82.7485]).toFixed(4), '2.0425')
  assert.equal(deltaE2000([50, 0, 0], [50, -1, 2]).toFixed(4), '2.3669')
  assert.equal(deltaE2000([50, 2.5, 0], [73, 25, -18]).toFixed(4), '27.1492')
})

test('the same image twice is identical on every metric', () => {
  const m = compare(f1, loadPng(ref(th.reference)), { regions })
  for (const [k, v] of Object.entries(m)) if (typeof v === 'number') assert.equal(v, 0, k)
  assert.deepEqual(failures(m, th), [])
})

test('F0 against F1 fails every retained metric', () => {
  assert.deepEqual(failures(rows.F0, th), retained)
})

test('every must-fail single-knob control fails at least one retained metric', () => {
  assert.deepEqual(gating, ['exposure+10', 'exposure-10', 'bloom-off', 'fog-off'], 'R19 names these four')
  for (const c of gating) {
    const bad = failures(rows[c], th)
    assert.ok(bad.length > 0, `${c} passed every metric`)
  }
})

test('the thresholds file is R19\'s rule applied to what the instrument measures now', () => {
  // Re-derived from the PNGs: a hand-edited threshold, a control moved in or out of the must-fail
  // set, or an instrument change all show up here as a difference.
  const d = deriveThresholds(rows, lab.floor)
  assert.deepEqual(th.labFloor.metrics, lab.floor)
  assert.deepEqual(th.box, lab.box)
  assert.deepEqual(th.mustFail, MUST_FAIL)
  assert.deepEqual(th.metrics, d.metrics)
  assert.deepEqual(th.dropped, d.dropped)
  assert.deepEqual(th.sensitivity, d.sensitivity)
  for (const [m, t] of Object.entries(th.metrics)) {
    assert.ok(t.floor < t.threshold && t.threshold < t.smallest, `${m}: threshold not between floor and control`)
    assert.ok(MUST_FAIL.includes(t.smallestControl), `${m}: placed against ${t.smallestControl}, not a must-fail control`)
  }
  // A dropped metric really could not separate: some must-fail control leaves it on the floor.
  for (const [m, d] of Object.entries(th.dropped)) assert.ok(Math.min(...MUST_FAIL.map(c => rows[c][m])) <= d.floor, `${m} was dropped but separates`)
  for (const [n, b] of Object.entries(th.box)) assert.ok(b.floor < b.threshold && b.threshold < b.smallest, `box ${n}: threshold not between floor and control`)
})

test('T23.08: the lab floor is two real back-ends, and it moved the thresholds', () => {
  // Two renders of one back-end are byte-identical (SwiftShader, twice: floor 0 on every metric) — a
  // floor of all zeros would mean the two frames were one. And the rule re-derived with a zero floor
  // differs from the file: the floor is what placed dssim / deltaE_sky and dropped deltaE_actors.
  assert.ok(lab.floor.dssim > 0 && lab.floor.deltaE_sky > 0, 'the two lab frames are identical — one back-end twice')
  const zero = deriveThresholds(rows, 0)
  assert.notDeepEqual(zero.metrics, th.metrics)
  assert.ok('deltaE_actors' in zero.metrics && 'deltaE_actors' in th.dropped, 'deltaE_actors: kept at a zero floor, dropped at the lab floor')
})

test('control: with rim-off gating, the rule would place tighter thresholds (R19 is what moved them)', () => {
  // The sensitivity line is not decoration: rim-off is the smallest control on metrics R19 now
  // places elsewhere, so a derivation that silently included it would differ.
  const moved = Object.keys(th.metrics).filter(m => rows['rim-off'][m] < th.metrics[m].smallest)
  assert.ok(moved.length > 0, 'rim-off is smaller than no must-fail control — R19 changed nothing')
})

test('FLIP is never reported uncomputed', () => {
  assert.equal(rows.F0.flip, null)
  assert.match(rows.F0.flipNote, /not computed/)
})

test('the actor boxes are where the actors are: rim-off lands inside them', () => {
  // rim-off changes only what lit() paints — the actors (plus the bloom they feed). Measured:
  // mean ΔE 1.70 inside the boxes against 0.127 in the sky. The same boxes shifted 200 px right
  // (the control) sit mostly on empty sky and terrain and must lose that contrast.
  const inside = m => m.deltaE_actors
  const outside = m => Math.max(m.deltaE_sky, m.deltaE_terrain)
  const rim = rows['rim-off']
  assert.equal(boxes.length, 15, 'F1 has 15 actors (scenes.test.ts counts them against f_scene.js)')
  assert.ok(inside(rim) > 5 * outside(rim), `rim-off: actors ${inside(rim)} vs outside ${outside(rim)}`)
  const shifted = withActors(loadPng(ref('reference/controls/regions-F1.png')), boxes.map(([a, b, c, d]) => [a + 200, b, c + 200, d]))
  const moved = compare(f1, loadPng(ref(file('rim-off'))), { regions: shifted })
  assert.ok(!(inside(moved) > 5 * outside(moved)), `control: shifted boxes still concentrate rim-off (${inside(moved)} vs ${outside(moved)})`)
})
