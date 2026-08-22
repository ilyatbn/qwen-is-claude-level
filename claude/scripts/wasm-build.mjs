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
import { existsSync, statSync } from 'node:fs'
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

// **Absolute.** `wasm-pack` resolves a relative `--out-dir` against the CRATE
// directory, not against `cwd` — so `client/src/core/pkg` here meant
// `crates/game-wasm/client/src/core/pkg`, and every build since silently wrote
// there while the client kept importing a package that had stopped changing.
//
// It fails in the worst available way: the build prints a cheerful "Your wasm
// pkg is ready", `pkgDir` still holds a valid older package so nothing errors,
// and the only symptom is that constants added to `constants_json()` read
// `undefined` in the browser and freshly changed `game-core` behaviour is simply
// absent from the client. That is §A22 for the third time — the two earlier
// rounds cost two milestones of stale test runs and a round of threshold tuning
// — which is what the verification below is for.
const args = [
  'build',
  'crates/game-wasm',
  '--target',
  'web',
  '--out-dir',
  pkgDir,
  ...(release ? ['--release'] : []),
]

const startedAt = Date.now()
const r = spawnSync('wasm-pack', args, { cwd: root, stdio: 'inherit' })

if (r.error?.code === 'ENOENT') {
  console.error('wasm-pack is required: cargo install wasm-pack')
  process.exit(1)
}
if (r.status !== 0) process.exit(r.status ?? 1)

// Did the build land where the client imports from? A wasm-pack that reports
// success while writing somewhere else is exactly the failure above, and it is
// invisible without this. Checked by **mtime**, not by existence: a stale
// package from a previous run exists too, which is the whole problem.
const stale = required.filter((f) => {
  const path = join(pkgDir, f)
  if (!existsSync(path)) return true
  // A second of slack for clock granularity on the filesystem.
  return statSync(path).mtimeMs < startedAt - 1000
})
if (stale.length) {
  console.error(
    `wasm-pack reported success but ${pkgDir} was not updated: ${stale.join(', ')}.\n` +
      'The client imports from there, so it would silently keep running the old ' +
      'package. Check --out-dir: wasm-pack resolves a relative one against the ' +
      'crate directory, not the working directory.',
  )
  process.exit(1)
}
