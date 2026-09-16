/**
 * A port nobody else is using, **asked of the OS** — for a check's game-server,
 * or the suite's socket.io router.
 *
 * Moved here from `harness.mjs` (which re-exports it, so checks import it from
 * the same place as before) so `e2e.mjs` can take a port without loading the
 * check harness.
 *
 * Every standalone check used to hardcode one (`3112`, `3123`, …) and that was
 * only safe because the suite ran them one at a time: three pairs already shared
 * a number (`teleport`/`bullets-visible` 3131, `hud-timer`/`ordnance-visible`
 * 3123, `lobby`/`escape-menu` 3126). Under `e2e.mjs --jobs N` two of those
 * running together would have had one check's health poll answered by the
 * *other* check's server — a silent wrong-server run, not a loud failure.
 *
 * Asking the OS (`listen(0)`) rules out anything already listening. It does not
 * by itself rule out two concurrent checks being handed the same number in the
 * seconds between this call and their server's `bind`, so each port is also
 * **claimed** with an exclusive-create file under `target/e2e-ports/` and
 * released when this process exits. A port another live check has claimed is
 * skipped; a claim file older than an hour is a crashed run's and is reused.
 */
import { closeSync, mkdirSync, openSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const claims = new Set()

/** @returns {Promise<number>} */
export async function freePort() {
  const dir = join(root, 'target', 'e2e-ports')
  mkdirSync(dir, { recursive: true })
  for (let attempt = 0; attempt < 50; attempt++) {
    const port = await new Promise((res, rej) => {
      const srv = createServer()
      srv.unref()
      srv.on('error', rej)
      // `::` is dual-stack here, so the port is free on 127.0.0.1 *and* ::1 —
      // the server binds the first, and `localhost` may resolve to either.
      srv.listen(0, '::', () => {
        const p = srv.address().port
        srv.close(() => res(p))
      })
    })
    const claim = join(dir, String(port))
    try {
      closeSync(openSync(claim, 'wx'))
    } catch {
      try {
        if (Date.now() - statSync(claim).mtimeMs < 3_600_000) continue
        writeFileSync(claim, '')
      } catch {
        continue
      }
    }
    // One exit handler for every claim: a listener per port trips Node's
    // leak warning past ten, and `fog-visible` alone claims three.
    if (!claims.size) {
      process.on('exit', () => {
        for (const c of claims) {
          try {
            unlinkSync(c)
          } catch {
            /* already gone */
          }
        }
      })
    }
    claims.add(claim)
    return port
  }
  throw new Error('freePort: 50 OS-assigned ports were all claimed by other checks')
}
