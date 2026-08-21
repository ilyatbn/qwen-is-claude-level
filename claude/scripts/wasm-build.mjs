#!/usr/bin/env node
/**
 * Build `game-wasm` into `client/src/core/pkg` — **one** implementation of a
 * command four npm hooks had each written for themselves.
 *
 * `predev`, `prebuild`, `pretest` and `pretypecheck` all existed so the client
 * can never run against a stale wasm build. That rule was learned the hard way:
 * `typecheck` had no hook for a while and read an old `pkg`, and before that the
 * client test suite silently tested stale wasm for two milestones, invalidating
 * two rounds of threshold tuning (docs/70-amendments-v2.md §A22).
 *
 * Four copies of the same command is four places to forget one — the same shape
 * as the five hand-written vite-port parses in §B22. Hence this file.
 *
 * `SKIP_WASM_BUILD=1` exists for exactly one caller: `docker/Dockerfile.client`,
 * where a dedicated `wasm` stage has already built the package from the same
 * source tree in the same build and copied it in, and the node image has no Rust
 * toolchain by design. It **verifies the package is really there** rather than
 * trusting the flag, because a skip that silently produces nothing is how §A22
 * happened in the first place.
 */
import { existsSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const pkgDir = join(root, 'client', 'src', 'core', 'pkg')
const release = process.argv.includes('--release')

// The files the client actually imports. Checking the directory exists is not
// enough — an empty or half-copied pkg fails much later and much less clearly.
const required = ['game_wasm.js', 'game_wasm_bg.wasm']

if (process.env.SKIP_WASM_BUILD === '1') {
  const missing = required.filter((f) => !existsSync(join(pkgDir, f)))
  if (missing.length) {
    console.error(
      `SKIP_WASM_BUILD=1 but ${pkgDir} is missing: ${missing.join(', ')}.\n` +
        'That flag is only for a build that has already produced the package ' +
        'another way (see docker/Dockerfile.client). Unset it to build here.',
    )
    process.exit(1)
  }
  console.log('SKIP_WASM_BUILD=1 — using the wasm package already in client/src/core/pkg')
  process.exit(0)
}

const args = [
  'build',
  'crates/game-wasm',
  '--target',
  'web',
  '--out-dir',
  'client/src/core/pkg',
  ...(release ? ['--release'] : []),
]

const r = spawnSync('wasm-pack', args, { cwd: root, stdio: 'inherit' })

if (r.error?.code === 'ENOENT') {
  console.error('wasm-pack is required: cargo install wasm-pack')
  process.exit(1)
}
process.exit(r.status ?? 1)
