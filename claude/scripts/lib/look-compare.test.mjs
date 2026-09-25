// T23.02: look-compare separates what must pass from what must fail, before any renderer
// exists to flatter it. Every number in look-thresholds.json is re-measured here from the
// committed PNGs, so the file cannot drift from the instrument or the instrument from it.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { compare, deltaE2000, failures, loadPng } from './look-compare.mjs'

const root = join(dirname(fileURLToPath(import.meta.url)), '../..')
const ref = p => join(root, 'tasks/M23', p)
const th = JSON.parse(readFileSync(join(root, 'scripts/lib/look-thresholds.json'), 'utf8'))
const regions = loadPng(ref('reference/controls/regions-F1.png'))
const f1 = loadPng(ref(th.reference))
const file = c => th.controls[c].split(' ')[0]
const rows = Object.fromEntries(Object.keys(th.controls).map(c => [c, compare(f1, loadPng(ref(file(c))), { regions })]))
const single = Object.keys(th.controls).filter(c => c !== 'F0')
const retained = Object.keys(th.metrics)

test('the table', () => {
  const cols = ['F0', ...single]
  const lines = [['metric', 'floor', ...cols, 'threshold'].map(s => s.padStart(12)).join('')]
  for (const m of [...retained, ...Object.keys(th.dropped)]) {
    const t = th.metrics[m]
    lines.push([m.padStart(12), '0'.padStart(12), ...cols.map(c => rows[c][m].toPrecision(3).padStart(12)), (t ? String(t.threshold) : 'DROPPED').padStart(12)].join(''))
  }
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

test('every single-knob control fails at least one retained metric', () => {
  for (const c of single) {
    const bad = failures(rows[c], th)
    assert.ok(bad.length > 0, `${c} passed every metric`)
  }
})

test('the recorded floors and smallest controls are what the instrument measures now', () => {
  for (const [m, t] of Object.entries(th.metrics)) {
    const per = single.map(c => [c, rows[c][m]]).sort((a, b) => a[1] - b[1])
    assert.equal(per[0][0], t.smallestControl, `${m}: smallest control`)
    assert.ok(Math.abs(per[0][1] - t.smallest) <= 1e-9 * Math.max(1, t.smallest), `${m}: ${per[0][1]} vs recorded ${t.smallest}`)
    assert.ok(t.floor < t.threshold && t.threshold < t.smallest, `${m}: threshold not between floor and control`)
  }
  // A dropped metric really could not separate: some control leaves it on the floor.
  for (const [m, d] of Object.entries(th.dropped)) assert.ok(Math.min(...single.map(c => rows[c][m])) <= d.floor, `${m} was dropped but separates`)
})

test('FLIP is never reported uncomputed', () => {
  assert.equal(rows.F0.flip, null)
  assert.match(rows.F0.flipNote, /not computed/)
})
