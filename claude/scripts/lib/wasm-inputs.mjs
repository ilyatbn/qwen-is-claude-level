/**
 * T23.27B item 1: **what the wasm package is built from, by content** — so a source change always reaches the
 * browser, whatever its mtime says.
 *
 * T23.19G found the browser running `SPACE_MOON_ORBIT` 118 after T23.10B made it 236, until a `cargo clean` of the
 * wasm target. Reproduced: put a changed `constants.rs` on disk with an mtime older than the last build (a file copied
 * in with its times kept — `cp -p`, an rsync, a merge tool — from a worktree that edited it earlier) and
 * `wasm-build.mjs` prints "Your wasm pkg is ready" over a package with the old value. Cargo decides freshness by
 * mtime alone; an edit that does not move the mtime past the last build is invisible to it, for ever.
 *
 * So `wasm-build.mjs` keeps a content manifest of these inputs from its last successful build, and before building
 * bumps the mtime of every input whose content differs — cargo then rebuilds exactly what changed. No manifest (a
 * first build) bumps them all once.
 */
import { createHash } from 'node:crypto'
import { existsSync, readdirSync, readFileSync, statSync, utimesSync, writeFileSync } from 'node:fs'
import { join, relative } from 'node:path'

/** The crates the package is compiled from, and the workspace files that pick their versions. */
const CRATES = ['crates/game-core', 'crates/game-wasm']
const WORKSPACE_FILES = ['Cargo.toml', 'Cargo.lock']

/** Every input file, relative to `root`: the two crates' files (no `target`, no dot dirs) and the workspace files. */
export function wasmInputs(root) {
  const out = []
  const walk = (dir) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      if (e.name.startsWith('.') || e.name === 'target' || e.name === 'node_modules') continue
      const p = join(dir, e.name)
      if (e.isDirectory()) walk(p)
      else if (e.isFile()) out.push(relative(root, p))
    }
  }
  for (const c of CRATES) if (existsSync(join(root, c))) walk(join(root, c))
  for (const f of WORKSPACE_FILES) if (existsSync(join(root, f))) out.push(f)
  return out.sort()
}

/** `{ path: sha256 }` of each input's content. */
export function fingerprint(root, files) {
  const fp = {}
  for (const f of files) fp[f] = createHash('sha256').update(readFileSync(join(root, f))).digest('hex')
  return fp
}

/** The inputs whose content is not what the last build saw: changed or new. All of them when there is no record. */
export function changedInputs(prev, now) {
  return Object.keys(now).filter((f) => !prev || prev[f] !== now[f])
}

/** Set each file's mtime to `at` (ms) — after the last build, so cargo's mtime comparison sees the change. */
export function freshen(root, files, at = Date.now()) {
  const t = new Date(at)
  for (const f of files) utimesSync(join(root, f), statSync(join(root, f)).atime, t)
}

export function readManifest(path) {
  try {
    const v = JSON.parse(readFileSync(path, 'utf8'))
    return v && typeof v === 'object' ? v : null
  } catch {
    return null
  }
}

export function writeManifest(path, fp) {
  writeFileSync(path, JSON.stringify(fp))
}
