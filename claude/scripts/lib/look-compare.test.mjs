// T23.02: look-compare separates what must pass from what must fail, before any renderer
// exists to flatter it. Every number in look-thresholds.json is re-measured here from the
// committed PNGs, so the file cannot drift from the instrument or the instrument from it.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { ACTOR_MUST_FAIL, DEFERRED, MUST_FAIL, actorBoxes, actorSet, areaDelta, backEnd, boxesDeltaE, compare, deltaE2000, deriveThresholds, failures, labFloor, loadPng, thresholdsFor, withActors } from './look-compare.mjs'

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
// R25: one threshold set per back end, each re-measured from its own two PNGs.
const SETS = Object.keys(th.sets)
const sets = Object.fromEntries(SETS.map(n => [n, thresholdsFor(th, n === 'gpu' ? 'ANGLE (Microsoft Corporation, D3D12 (Intel(R) Arc(TM) B390 GPU), OpenGL 4.6)' : 'ANGLE (Google, Vulkan 1.3.0 (SwiftShader Device (Subzero) (0x0000C0DE)), SwiftShader driver)')]))
const lab = Object.fromEntries(SETS.map(n => [n, labFloor(th, n, regions, p => loadPng(ref(p)))]))
// R19: the controls that place a threshold, and the ones only reported.
const gating = single.filter(c => MUST_FAIL.includes(c))
const sensitivity = single.filter(c => !MUST_FAIL.includes(c))

test('the table', () => {
  const cols = ['F0', ...gating, ...sensitivity]
  const head = ['metric', ...SETS.flatMap(n => [`${n} floor`, `${n} max`]), ...cols.map(c => (MUST_FAIL.includes(c) ? c : `(${c})`))]
  const lines = [head.map(s => s.padStart(13)).join('')]
  const all = [...new Set(SETS.flatMap(n => [...Object.keys(sets[n].metrics), ...Object.keys(sets[n].dropped)])), ...Object.keys(DEFERRED)]
  for (const m of all) {
    const perSet = SETS.flatMap(n => [(lab[n].floor[m] ?? 0).toPrecision(3), sets[n].metrics[m] ? String(sets[n].metrics[m].threshold) : m in DEFERRED ? 'DEFERRED' : 'DROPPED'])
    lines.push([m, ...perSet, ...cols.map(c => rows[c][m].toPrecision(3))].map(s => s.padStart(13)).join(''))
  }
  for (const n of SETS) lines.push(`(${n}: sensitivity, not gating — R19) ` + sensitivity.map(c => `${c} fails ${failures(rows[c], sets[n]).length}/${Object.keys(sets[n].metrics).length}`).join('; ') + '; boxes ' + Object.entries(sets[n].box).map(([k, b]) => `${k} floor ${b.floor.toPrecision(3)} max ${b.threshold} control ${b.smallest.toPrecision(3)}`).join(', '))
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
  for (const n of SETS) assert.deepEqual(failures(m, sets[n]), [])
})

test('F0 against F1 fails every retained metric, in every set', () => {
  for (const n of SETS) assert.deepEqual(failures(rows.F0, sets[n]), Object.keys(sets[n].metrics), n)
})

test('every must-fail single-knob control fails at least one retained metric, in every set', () => {
  assert.deepEqual(gating, ['exposure+10', 'exposure-10', 'bloom-off', 'fog-off'], 'R19 names these four')
  for (const n of SETS) {
    for (const c of gating) assert.ok(failures(rows[c], sets[n]).length > 0, `${n}: ${c} passed every metric`)
  }
})

test('each set is R19\'s rule applied to its own floor, as the instrument measures it now (R25)', () => {
  // Re-derived from the PNGs: a hand-edited threshold, a control moved in or out of the must-fail
  // set, a frame swapped between sets, or an instrument change all show up here as a difference.
  assert.deepEqual(th.mustFail, MUST_FAIL)
  assert.deepEqual(th.deferred, DEFERRED)
  for (const n of SETS) {
    const set = th.sets[n]
    const d = deriveThresholds(rows, lab[n].floor)
    assert.deepEqual(set.floor, lab[n].floor, `${n}: floor`)
    assert.deepEqual(set.box, lab[n].box, `${n}: box`)
    assert.deepEqual(set.metrics, d.metrics, `${n}: metrics`)
    assert.deepEqual(set.dropped, d.dropped, `${n}: dropped`)
    assert.deepEqual(set.sensitivity, d.sensitivity, `${n}: sensitivity`)
    for (const [m, t] of Object.entries(set.metrics)) {
      assert.ok(t.floor < t.threshold && t.threshold < t.smallest, `${n} ${m}: threshold not between floor and control`)
      assert.ok(MUST_FAIL.includes(t.smallestControl), `${n} ${m}: placed against ${t.smallestControl}, not a must-fail control`)
    }
    // A dropped metric really could not separate: some must-fail control leaves it on the floor.
    for (const [m, dd] of Object.entries(set.dropped)) assert.ok(Math.min(...MUST_FAIL.map(c => rows[c][m])) <= dd.floor, `${n} ${m} was dropped but separates`)
    for (const [k, b] of Object.entries(set.box)) assert.ok(b.floor < b.threshold && b.threshold < b.smallest, `${n} box ${k}: threshold not between floor and control`)
    for (const m of Object.keys(DEFERRED)) assert.ok(!(m in set.metrics) && !(m in set.dropped), `${n}: ${m} is deferred (R25), not placed or dropped`)
  }
})

test('R25: the swiftshader floor is one back end twice, the gpu floor is two, and only the gpu set is loosened by it', () => {
  // SwiftShader's two frames are separate launches and byte-identical: its floor is 0 on every metric.
  const [a, b] = th.sets.swiftshader.frames.map(f => f.split(' ')[0])
  assert.notEqual(a, b, 'the swiftshader floor names one file twice')
  for (const [m, v] of Object.entries(lab.swiftshader.floor)) assert.equal(v, 0, `swiftshader floor ${m}`)
  // The gpu floor is two real back ends — all zeros would mean the two frames were one.
  assert.ok(lab.gpu.floor.dssim > 0 && lab.gpu.floor.deltaE_sky > 0, 'the gpu floor frames are identical — one back end twice')
  // So the swiftshader set is R19's rule from zero, and the gpu set is at least as loose on every metric and looser on some.
  assert.deepEqual(th.sets.swiftshader.metrics, deriveThresholds(rows, 0).metrics)
  const looser = []
  for (const [m, t] of Object.entries(th.sets.swiftshader.metrics)) {
    const g = th.sets.gpu.metrics[m]
    if (!g) continue
    assert.ok(g.threshold >= t.threshold, `${m}: the gpu set is tighter than swiftshader`)
    if (g.threshold > t.threshold) looser.push(m)
  }
  assert.ok(looser.length > 0, 'the gpu floor loosened nothing — the split changes nothing')
})

test('R25: the renderer string picks the set, and an unknown one fails loudly', () => {
  assert.equal(backEnd('ANGLE (Google, Vulkan 1.3.0 (SwiftShader Device (Subzero) (0x0000C0DE)), SwiftShader driver)'), 'swiftshader')
  assert.equal(backEnd('ANGLE (Microsoft Corporation, D3D12 (Intel(R) Arc(TM) B390 GPU), OpenGL 4.6)'), 'gpu')
  assert.equal(backEnd('ANGLE (NVIDIA, NVIDIA GeForce RTX 3060 Direct3D11 vs_5_0 ps_5_0, D3D11)'), 'gpu')
  assert.throws(() => backEnd('llvmpipe (LLVM 15.0.7, 256 bits)'), /software renderer/)
  assert.throws(() => backEnd('ANGLE (Microsoft Corporation, D3D12 (Microsoft Basic Render Driver), OpenGL 4.6)'), /software renderer/)
  assert.throws(() => backEnd('Mystery GPU 9000'), /no known back end/)
  assert.throws(() => backEnd(undefined), /no known back end/)
  assert.equal(sets.swiftshader.backEnd, 'swiftshader')
  assert.equal(sets.gpu.backEnd, 'gpu')
})

test('R25: the halo ring sees bloom radius 0 on SwiftShader, where the moon box could not', () => {
  const reference = loadPng(ref('reference/controls/F1-world.png'))
  const r0 = loadPng(ref('reference/controls/F1-world-bloom-radius-0.png'))
  const halo = sets.swiftshader.box.bloomHalo
  const box = sets.swiftshader.box.bloomBox
  assert.ok(areaDelta(r0, reference, halo) > halo.threshold, `radius 0: halo ${areaDelta(r0, reference, halo)} ≤ ${halo.threshold}`)
  // Control: the moon box (the strength's area) does not see it — why the ring exists.
  assert.ok(areaDelta(r0, reference, box) <= box.threshold, 'the moon box already sees radius 0 — the ring adds nothing')
  // Control: the lab's own frame is inside the ring's threshold on both sets.
  for (const n of SETS) {
    const f = loadPng(ref(th.sets[n].frames[1].split(' ')[0]))
    assert.ok(areaDelta(f, reference, sets[n].box.bloomHalo) <= sets[n].box.bloomHalo.threshold, `${n}: the lab's frame fails the halo ring`)
  }
})

test('control: with rim-off gating, the rule would place tighter thresholds (R19 is what moved them)', () => {
  // The sensitivity line is not decoration: rim-off is the smallest control on metrics R19 now
  // places elsewhere, so a derivation that silently included it would differ.
  for (const n of SETS) {
    const moved = Object.keys(th.sets[n].metrics).filter(m => rows['rim-off'][m] < th.sets[n].metrics[m].smallest)
    assert.ok(moved.length > 0, `${n}: rim-off is smaller than no must-fail control — R19 changed nothing`)
  }
})

test('T23.08C F1: worldonly.js is f_kit.js::frame with only the actor canvas and the fx group taken out', () => {
  // The reference F1-world.png is only a fair "F1 without its cast" if worldonly.js draws what frame()
  // draws, less the cast. Compared as statements: frame()'s body minus its draw2d/fx lines, and
  // worldonly's body after its marker with its knob plumbing normalised (P.x → x, the fg-off guard).
  const body = (src, from) => {
    const i = src.indexOf(from)
    assert.ok(i >= 0, `no ${from}`)
    const lines = []
    let depth = 0
    for (const line of src.slice(src.indexOf('\n', i) + 1).split('\n')) {
      depth += (line.match(/{/g) ?? []).length - (line.match(/}/g) ?? []).length
      if (depth < 0) break
      lines.push(line.trim())
    }
    return lines.filter(Boolean)
  }
  const kit = readFileSync(ref('reference/mockup-src/f_kit.js'), 'utf8')
  const only = readFileSync(ref('reference/controls/worldonly.js'), 'utf8')
  const cast = /\bcv\b|getContext|draw2d|CanvasTexture|\baq\b|\bfx\b|fx3d/
  const frame = body(kit, 'export function frame(')
  const taken = frame.filter(l => cast.test(l))
  const want = frame.filter(l => !cast.test(l))
  const got = body(only, '// --- f_kit.js::frame, less the actor canvas and fx ---')
    .map(l => l.replace(/\bP\.(bg|terrain|fg)\b/g, '$1').replace(" && knob !== 'fg-off'", ''))
  assert.equal(taken.length, 6, `frame()'s cast lines: ${JSON.stringify(taken)}`)
  // frame()'s page setup sits at the top of worldOnly, before the marker (it sets up the lights after it).
  const setup = want.shift()
  assert.match(setup, /^document\.body\.style\.cssText = /)
  assert.ok(body(only, 'export function worldOnly(').includes(setup), 'worldOnly does not set the page up as frame() does')
  assert.deepEqual(got, want)
  // Control: frame() itself, cast included, is not what worldonly draws.
  assert.notDeepEqual(got, frame)
})

test('FLIP is never reported uncomputed', () => {
  assert.equal(rows.F0.flip, null)
  assert.match(rows.F0.flipNote, /not computed/)
})

test('the actor boxes are where the actors are: rim-off lands inside them', () => {
  // (deltaE_actors is computed for every F1 compare and gates nothing there — R25 places it on F4's cast: `actorSet`.)
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

test('R25 (T23.12): each set\'s actor threshold is R19\'s rule on F4\'s cast, re-derived from the PNGs', () => {
  const load = p => loadPng(ref(p))
  assert.deepEqual(th.actors.mustFail, ACTOR_MUST_FAIL)
  assert.ok(ACTOR_MUST_FAIL.includes('rim-off'), 'R25: rim-off is in the actor set\'s must-fail set')
  assert.deepEqual(Object.keys(th.actors.controls).sort(), [...ACTOR_MUST_FAIL].sort(), 'every must-fail control has a picture')
  const lines = []
  for (const n of SETS) {
    const got = actorSet(th, n, load)
    const { frames, ...placed } = th.sets[n].actors
    assert.equal(frames.length, 2, `${n}: two floor frames`)
    assert.deepEqual(placed, got, `${n}: actors`)
    assert.ok(got.floor < got.threshold && got.threshold < got.smallest, `${n}: the actor threshold is not between floor and control`)
    assert.ok(ACTOR_MUST_FAIL.includes(got.smallestControl))
    // Every must-fail control fails it — rim-off by the widest margin of the lot.
    for (const c of ACTOR_MUST_FAIL) assert.ok(got.controls[c] > got.threshold, `${n}: ${c} passes the actor threshold`)
    lines.push(`${n}: deltaE_actors floor ${got.floor.toPrecision(3)} max ${got.threshold}; controls ` + Object.entries(got.controls).map(([c, v]) => `${c} ${v.toPrecision(3)}`).join(', '))
  }
  // The swiftshader floor is one back end twice (0); the gpu floor is two (> 0).
  assert.equal(th.sets.swiftshader.actors.floor, 0)
  assert.ok(th.sets.gpu.actors.floor > 0, 'the gpu floor frames are identical — one back end twice')
  // The lab's own frames against the reference the lab draws today (T23.12: no rim passes), on each set.
  const rimOff = load('reference/controls/F4-cast-rim-off.png')
  const boxes = actorBoxes('F4')
  for (const n of SETS) {
    const f = load(th.sets[n].actors.frames[1].split(' ')[0])
    lines.push(`${n}: the lab (${th.sets[n].actors.frames[1].split(' ')[0].split('/').pop()}) vs F4-cast-rim-off ${boxesDeltaE(f, rimOff, boxes).toFixed(4)}`)
  }
  const swift = load(th.sets.swiftshader.actors.frames[0].split(' ')[0])
  assert.ok(boxesDeltaE(swift, rimOff, boxes) <= th.sets.swiftshader.actors.threshold, 'the committed SwiftShader lab frame fails its own set')
  // Control: the same frame against the world without its cast (castonly 'world') fails — the boxes see the cast.
  assert.ok(boxesDeltaE(swift, load('reference/controls/F4-world.png'), boxes) > th.sets.swiftshader.actors.threshold)
  console.log(lines.join('\n'))
})

test('boxesDeltaE is compare()\'s deltaE_actors, alone', () => {
  const a = loadPng(ref('reference/controls/F4-cast.png'))
  const b = loadPng(ref('reference/controls/F4-cast-rim-off.png'))
  const boxes = actorBoxes('F4')
  const blank = { width: a.width, height: a.height, data: new Uint8Array(a.width * a.height * 4) }
  assert.equal(boxesDeltaE(a, b, boxes), compare(a, b, { regions: withActors(blank, boxes) }).deltaE_actors)
  assert.equal(boxesDeltaE(a, a, boxes), 0)
})

test('T23.12: castonly.js draws variant_F4.js\'s cast call for call, less the text', () => {
  // The actor references are only F4 "without what the lab does not draw" if castonly's draw2d is F4's, less
  // label() and the caption. Compared as trimmed lines: F4's draw2d body minus its text lines, against castonly's
  // body between its marker and the end of its `if (knob !== 'world')` block.
  const f4 = readFileSync(ref('reference/mockup-src/variant_F4.js'), 'utf8').split('\n').map(l => l.trim())
  const co = readFileSync(ref('reference/controls/castonly.js'), 'utf8').split('\n').map(l => l.trim())
  const from = (ls, a, b) => ls.slice(ls.findIndex(l => l.startsWith(a)) + 1, ls.findIndex(l => l.startsWith(b)))
  const text = /label|fillText|g\.font|textAlign|g\.fillStyle = 'rgba\(225,218,230/
  const want = from(f4, 'draw2d: g => {', 'fx3d: fx => {').slice(0, -1).filter(l => l && !text.test(l))
  const got = from(co, "if (knob !== 'world') {", "S.setInk('#16110d')").slice(0, -1).filter(Boolean)
  assert.equal(from(f4, 'draw2d: g => {', 'fx3d: fx => {').filter(l => text.test(l)).length, 6, 'F4\'s text lines')
  assert.equal(want.length, 17, 'F4\'s cast calls')
  assert.deepEqual(got, want)
})
