import { spawn } from 'node:child_process'

/**
 * Spawn a child that forks the process actually holding the port, and kill the
 * whole group on the way out.
 *
 * `npx vite`, `npm run dev` and `cargo run` all exec or fork the real server as
 * a GRANDCHILD, so `child.kill()` reaps the wrapper and orphans the thing you
 * meant to stop. Five scripts each wrote the naive version and all five leaked:
 * a single suite run left 1 vite, 2 chromium and 2 game-server processes alive,
 * and they accumulate. That accumulated load is what three sessions recorded as
 * "two-clients is flaky under contention" — the load was self-inflicted.
 */
export function spawnGroup(cmd, args, opts = {}) {
  const child = spawn(cmd, args, { ...opts, detached: true })
  return child
}

/** Kill a `spawnGroup` child and everything it forked. Safe to call twice. */
export function killGroup(child) {
  if (!child || child.killed === undefined) return
  try {
    process.kill(-child.pid, 'SIGKILL')
  } catch {
    try {
      child.kill('SIGKILL')
    } catch {
      /* already gone */
    }
  }
}
