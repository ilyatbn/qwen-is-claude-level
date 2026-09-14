// node --test scripts/lib/affected.test.mjs
//
// The mapping behind `check.sh --changed`. A rule that drops a check is the
// failure that matters, so the fallback is tested as hard as the narrowing.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { affected, loadContext, root } from './affected.mjs'
import { CHECKS } from './e2e-checks.mjs'

/** A small invented tree, so each rule is tested on edges this file states. */
const fixture = () => ({
  checks: [
    { name: 'sky', file: 'scripts/checks/sky.mjs' },
    { name: 'wasd', file: 'scripts/checks/wasd.mjs' },
    { name: 'crates', file: 'scripts/checks/crates.mjs', standalone: true },
    { name: 'shaky', file: 'scripts/checks/shaky.mjs', standalone: true, flaky: true },
    { name: 'long', file: 'scripts/checks/long.mjs', standalone: true, optIn: true },
  ],
  imports: new Map([
    ['scripts/checks/wasd.mjs', new Set(['scripts/checks/sim-clock.mjs'])],
    ['scripts/checks/crates.mjs', new Set(['scripts/checks/harness.mjs'])],
    ['scripts/checks/shaky.mjs', new Set(['scripts/checks/harness.mjs'])],
    ['scripts/checks/harness.mjs', new Set(['scripts/vite-url.mjs'])],
    ['scripts/e2e.mjs', new Set(['scripts/lib/e2e-checks.mjs'])],
    ['client/src/core/parity.test.ts', new Set(['scripts/lib/rust-constants.mjs'])],
  ]),
  members: ['game-core', 'game-server', 'game-wasm'],
  // The real shape: game-wasm dev-depends on game-server (a codec test).
  dependents: new Map([
    ['game-core', new Set(['game-server', 'game-wasm'])],
    ['game-server', new Set(['game-wasm'])],
    ['game-wasm', new Set()],
  ]),
  linkDependents: new Map([
    ['game-core', new Set(['game-server', 'game-wasm'])],
    ['game-server', new Set()],
    ['game-wasm', new Set()],
  ]),
  namedByClientTests: new Set(['game-core']),
})
const DEFAULT = ['sky', 'wasd', 'crates']

test('an unknown file runs everything', () => {
  for (const f of ['foo/bar.xyz', 'scripts/brand-new-tool.mjs', 'docs/diagram.png', 'crates/nope/src/lib.rs']) {
    const r = affected([f], fixture())
    assert.equal(r.everything, true, f)
    assert.deepEqual(r.e2e, DEFAULT, f)
    assert.deepEqual(r.crates, ['game-core', 'game-server', 'game-wasm'], f)
    assert.equal(r.client && r.netSmoke && r.assets, true, f)
  }
})

test('everything wins over a narrower file in the same change', () => {
  const r = affected(['docs/70.md', 'Cargo.lock'], fixture())
  assert.equal(r.everything, true)
  assert.deepEqual(r.e2e, DEFAULT)
})

test('prose runs nothing', () => {
  const r = affected(['docs/70-amendments.md', 'tasks/JOURNAL.md', 'README.md'], fixture())
  assert.deepEqual([r.everything, r.crates, r.client, r.e2e], [false, [], false, []])
})

test('a check file selects that check and nothing else', () => {
  const r = affected(['scripts/checks/sky.mjs'], fixture())
  assert.deepEqual([r.crates, r.client, r.e2e], [[], false, ['sky']])
})

test('a helper selects its importers, transitively', () => {
  assert.deepEqual(affected(['scripts/checks/sim-clock.mjs'], fixture()).e2e, ['wasd'])
  // vite-url ← harness ← crates (and ← shaky, which is parked)
  assert.deepEqual(affected(['scripts/vite-url.mjs'], fixture()).e2e, ['crates'])
})

test('a parked check runs when its own file changes, not when a helper does', () => {
  assert.deepEqual(affected(['scripts/checks/shaky.mjs'], fixture()).e2e, ['shaky'])
  assert.deepEqual(affected(['scripts/checks/long.mjs'], fixture()).e2e, ['long'])
  assert.ok(!affected(['scripts/checks/harness.mjs'], fixture()).e2e.includes('shaky'))
})

test('the runner and its table select every default check', () => {
  assert.deepEqual(affected(['scripts/e2e.mjs'], fixture()).e2e, DEFAULT)
  assert.deepEqual(affected(['scripts/lib/e2e-checks.mjs'], fixture()).e2e, DEFAULT)
})

test('a scripts module a client test imports selects client tests', () => {
  const r = affected(['scripts/lib/rust-constants.mjs'], fixture())
  assert.deepEqual([r.client, r.e2e, r.everything], [true, [], false])
})

test('game-core is all rust, all e2e and the client', () => {
  const r = affected(['crates/game-core/src/constants.rs'], fixture())
  assert.deepEqual(r.crates, ['game-core', 'game-server', 'game-wasm'])
  assert.deepEqual(r.e2e, DEFAULT)
  assert.equal(r.client, true)
  assert.equal(r.everything, false)
})

test('game-server is its crate and dev-dependents, the standalone checks and the net smoke', () => {
  const r = affected(['crates/game-server/src/room.rs'], fixture())
  // game-wasm's tests use it, so they run; the wasm does not contain it, so
  // the in-page checks do not.
  assert.deepEqual(r.crates, ['game-server', 'game-wasm'])
  assert.deepEqual(r.e2e, ['crates'])
  assert.deepEqual([r.netSmoke, r.client], [true, false])
})

test('client source is client plus every check; a client test is client only', () => {
  const src = affected(['client/src/ui/hud.ts'], fixture())
  assert.deepEqual([src.client, src.e2e, src.crates], [true, DEFAULT, []])
  const t = affected(['client/src/ui/hud.test.ts'], fixture())
  assert.deepEqual([t.client, t.e2e], [true, []])
})

// --- against the real tree ----------------------------------------------------

const real = loadContext(CHECKS)

test('the real table: every check file exists', () => {
  for (const c of CHECKS) assert.ok(existsSync(join(root, c.file)), c.file)
})

test('the real tree: every scripts/checks module maps to at least one check', () => {
  // A helper nothing registered imports would fall through to "everything";
  // this says so here instead of making every run a full one.
  const dir = join(root, 'scripts/checks')
  const mods = readdirSync(dir).filter((f) => f.endsWith('.mjs'))
  assert.ok(mods.length > 40, `found ${mods.length}`)
  for (const m of mods) {
    const r = affected([`scripts/checks/${m}`], real)
    assert.equal(r.everything, false, `${m}: ${JSON.stringify(r.reasons)}`)
  }
})

test('the real crate graph: game-core has both dependents, and the wasm does not link the server', () => {
  assert.deepEqual(real.members, ['game-core', 'game-server', 'game-wasm'])
  assert.deepEqual([...real.linkDependents.get('game-core')].sort(), ['game-server', 'game-wasm'])
  assert.deepEqual([...real.linkDependents.get('game-server')], [])
  assert.ok(real.namedByClientTests.has('game-core'))
})

test('the real game-server selects standalone checks, not in-page ones', () => {
  const r = affected(['crates/game-server/src/app.rs'], real)
  // `quick-throw`, not `escape-menu`: escape-menu is parked (tasks/flaky-test.md), and a
  // parked check is rightly not selected by a helper or crate change.
  assert.ok(r.e2e.includes('quick-throw'))
  assert.ok(!r.e2e.includes('sky'), 'sky runs on the sandbox, with no server')
  assert.equal(r.netSmoke, true)
})

test('the real harness selects the standalone checks that import it', () => {
  const r = affected(['scripts/checks/harness.mjs'], real)
  for (const n of ['beams-shader', 'quick-throw', 'lobby-start']) assert.ok(r.e2e.includes(n), n)
  assert.ok(!r.e2e.includes('sky'), 'sky does not import the harness')
  assert.ok(!r.e2e.includes('two-clients'), 'two-clients is parked')
})

test('the real sandbox helper selects exactly its two importers', () => {
  assert.deepEqual(affected(['scripts/checks/sim-clock.mjs'], real).e2e, ['wasd', 'm4-checkpoint'])
})
