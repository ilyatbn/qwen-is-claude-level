// T23.27B item 1: the content manifest that makes a source change reach the wasm build whatever its mtime.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { changedInputs, fingerprint, freshen, wasmInputs } from './wasm-inputs.mjs'

const tree = () => {
  const root = mkdtempSync(join(tmpdir(), 'wasm-inputs-'))
  mkdirSync(join(root, 'crates/game-core/src'), { recursive: true })
  mkdirSync(join(root, 'crates/game-core/target'), { recursive: true })
  mkdirSync(join(root, 'crates/game-wasm/src'), { recursive: true })
  writeFileSync(join(root, 'crates/game-core/src/constants.rs'), 'pub const ORBIT: f32 = 236.0;\n')
  writeFileSync(join(root, 'crates/game-core/target/junk'), 'not an input')
  writeFileSync(join(root, 'crates/game-wasm/src/lib.rs'), 'fn main() {}\n')
  writeFileSync(join(root, 'Cargo.toml'), '[workspace]\n')
  return root
}

test('an edit with an old mtime is still a change, and freshen moves its mtime past the build', () => {
  const root = tree()
  try {
    const files = wasmInputs(root)
    assert.deepEqual(files, ['Cargo.toml', 'crates/game-core/src/constants.rs', 'crates/game-wasm/src/lib.rs'])
    const built = fingerprint(root, files)
    // The control: nothing changed, nothing to freshen.
    assert.deepEqual(changedInputs(built, fingerprint(root, files)), [])
    // The planted change, written with an mtime two days old — older than the build it must reach.
    const p = join(root, 'crates/game-core/src/constants.rs')
    writeFileSync(p, 'pub const ORBIT: f32 = 237.0;\n')
    const old = new Date(Date.now() - 2 * 86_400_000)
    utimesSync(p, old, old)
    const stale = changedInputs(built, fingerprint(root, files))
    assert.deepEqual(stale, ['crates/game-core/src/constants.rs'])
    const at = Date.now()
    freshen(root, stale, at)
    assert.ok(statSync(p).mtimeMs >= at - 1000, 'freshen left the mtime in the past')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('no manifest means every input is changed (a first build rebuilds once)', () => {
  const root = tree()
  try {
    const now = fingerprint(root, wasmInputs(root))
    assert.equal(changedInputs(null, now).length, Object.keys(now).length)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
