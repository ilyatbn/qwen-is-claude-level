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
import {
  closeSync,
  existsSync,
  linkSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeSync,
} from 'node:fs'
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

/**
 * **One build at a time, because two racing builds corrupt each other.**
 *
 * Four npm hooks — `predev`, `prebuild`, `pretest`, `pretypecheck` — all run this
 * script into the **same** `--out-dir`. Two of them overlapping (a `make play`
 * vite server beside a test run, a lingering dev server whose `predev` fires
 * during the gate's `pretest`) is a genuine race with two faces, both reproduced
 * on demand by running two builds concurrently:
 *
 *  - `invalid type: sequence, expected a string at line 7 column 11`.
 *    `wasm-pack`'s `create_pkg_dir` deletes `pkg/package.json`, and its
 *    `step_create_json` later reads whatever is at that path back as a
 *    `HashMap<String, String>` to merge npm deps (`manifest/mod.rs:634`). Line 7
 *    of the file it generates is `"files": [` — an array where that map demands a
 *    string, so if the read ever happens it fails, and it fails *there*. The only
 *    way it happens is the other process re-creating the file in the window
 *    between one build's delete and its own read.
 *  - `Optimizing wasm binaries with wasm-opt... No such file or directory`, when
 *    the other build replaces the intermediate this one is holding.
 *
 * **Why the guard is here and not in the four hooks.** Serialising the callers is
 * a guard the fifth caller forgets; this is the shared function, so this is where
 * the invariant lives (`CLAUDE.md`). It also covers callers nobody has written.
 *
 * **Waiting, not skipping.** A caller that reaches this script needs a `pkg` that
 * matches current source — that is the whole point of the hooks (§A22). Returning
 * early because someone else is mid-build would hand it a half-written package,
 * which is the failure being fixed wearing a quieter shirt. So we block until the
 * other build is done and then do our own.
 *
 * **A killed build must not wedge the repository.** This project kills process
 * *groups* for a living, so a lock holder dying mid-build is routine rather than
 * exotic. The lock records the holder's pid and any waiter that finds it dead
 * removes it and takes over; `process.kill(pid, 0)` is the liveness test, with
 * `EPERM` counting as alive because it means the pid exists and is not ours.
 */
const lockPath = join(root, 'target', '.wasm-build.lock')
const LOCK_TIMEOUT_MS = 10 * 60_000
const LOCK_POLL_MS = 100

const sleepSync = (ms) => {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
}

const holderIsAlive = (pid) => {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    // EPERM: the pid exists, it just is not ours to signal. Alive.
    return err.code === 'EPERM'
  }
}

let lockHeld = false

const releaseLock = () => {
  if (!lockHeld) return
  lockHeld = false
  try {
    // Only remove a lock we still own: if a waiter judged us dead and took over,
    // the file is theirs now and deleting it would free a build still running.
    if (Number(readFileSync(lockPath, 'utf8').trim()) === process.pid) unlinkSync(lockPath)
  } catch {
    /* already gone */
  }
}

const acquireLock = () => {
  mkdirSync(dirname(lockPath), { recursive: true })
  const deadline = Date.now() + LOCK_TIMEOUT_MS
  for (;;) {
    try {
      // **Created atomically *with* its pid already in it.** `openSync(wx)` then
      // `writeSync` is two syscalls, and a waiter arriving between them read an
      // empty file — which used to be judged "stale" and stolen, and now waits.
      // Writing to a private temp file and `linkSync`-ing it into place closes
      // that window instead of handling it: `link` fails if the target exists,
      // so it is exactly as exclusive as `wx`, and the content is there the
      // instant the name is.
      const tmp = `${lockPath}.${process.pid}.tmp`
      const fd = openSync(tmp, 'w')
      writeSync(fd, String(process.pid))
      closeSync(fd)
      try {
        linkSync(tmp, lockPath)
      } finally {
        try {
          unlinkSync(tmp)
        } catch {
          /* nothing to clean */
        }
      }
      lockHeld = true
      return
    } catch (err) {
      if (err.code !== 'EEXIST') throw err
      let raw
      try {
        raw = readFileSync(lockPath, 'utf8').trim()
      } catch {
        // The holder released between our create and our read. Retry.
        continue
      }
      // **Empty or unparseable means "a holder is still starting up", never
      // "stale".** The holder creates the file and writes its pid in two steps
      // (`openSync(wx)` then `writeSync`), so a waiter arriving between them
      // reads `''`. Treating that as a pid gave `Number('') === 0`, which
      // `holderIsAlive` rejects on its `pid <= 0` guard — so the waiter judged a
      // **live** lock stale, unlinked it and built concurrently. That is the
      // corruption this lock exists to prevent, and the window is entered on
      // every contended acquire, no crash required. Only a positive integer pid
      // that is provably dead may authorise a steal.
      const holder = Number(raw)
      if (!raw || !Number.isInteger(holder) || holder <= 0) {
        // Bounded by the same deadline as a live holder, or a lock file left
        // empty forever — a holder killed between its create and its write —
        // would spin here until the heat death of the repository.
        if (Date.now() > deadline) {
          console.error(
            `wasm-build: ${lockPath} has been unreadable for ` +
              `${LOCK_TIMEOUT_MS / 60_000} minutes (content ${JSON.stringify(raw)}). ` +
              'A build was probably killed between creating the lock and writing ' +
              'its pid. Delete that file and re-run.',
          )
          process.exit(1)
        }
        sleepSync(LOCK_POLL_MS)
        continue
      }
      if (!holderIsAlive(holder)) {
        // **Steal atomically.** Checking liveness and then unlinking is a
        // TOCTOU: with a dead holder and two waiters, B can unlink, win its
        // `openSync(wx)` and start building while C — still between its own
        // check and its unlink — deletes *B's live lock* and creates its own.
        // Two concurrent builds again. `renameSync` is atomic, so exactly one
        // waiter wins the steal and the losers get ENOENT and re-loop. The
        // `console.log` that used to sit between the check and the unlink
        // widened the window, and a log to a pipe can block.
        const claimed = `${lockPath}.steal.${process.pid}`
        try {
          renameSync(lockPath, claimed)
        } catch {
          continue
        }
        console.log(`wasm-build: cleared a stale lock left by pid ${holder}`)
        try {
          unlinkSync(claimed)
        } catch {
          /* already gone */
        }
        continue
      }
      if (Date.now() > deadline) {
        console.error(
          `wasm-build: pid ${holder} has held ${lockPath} for ` +
            `${LOCK_TIMEOUT_MS / 60_000} minutes and is still alive. Refusing to ` +
            'build against a package another build is writing. If that pid is ' +
            'wedged, kill its process group (scripts/proc-group.mjs) and re-run.',
        )
        process.exit(1)
      }
      sleepSync(LOCK_POLL_MS)
    }
  }
}

// `exit` covers `process.exit()` too, which this script uses on every error path.
process.on('exit', releaseLock)

// **No SIGINT/SIGTERM handlers, deliberately.**
//
// They used to be here to release the lock on a kill, and they made a *waiting*
// build unkillable: the wait loop is `sleepSync` in a `for(;;)`, which never
// yields to the event loop, so a queued JS signal handler cannot run. Measured:
// `timeout 25 node scripts/wasm-build.mjs` against a held lock ignored SIGTERM
// and sat for the full LOCK_TIMEOUT_MS of ten minutes. Four npm hooks invoke
// this script, so that reads as a hang, the natural answer is `kill -9`, and
// that used to leave the empty lock file the next build then waited ten minutes
// on. The two behaviours compounded.
//
// Registering nothing restores the default: the process dies at once on Ctrl-C.
// The lock it abandons is safe because the pid in it is now dead, and a dead
// holder's lock is stolen atomically by the next build — which is the same path
// that already covers a crash, a `kill -9`, or a killed process group.

acquireLock()

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
