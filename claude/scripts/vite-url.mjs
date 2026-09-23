/**
 * Start the dev server and resolve its URL — **one** implementation of a parse
 * that four scripts had each written for themselves.
 *
 * Every copy matched vite's banner with a bare regex, and every copy broke the
 * same way. vite prints the port as
 *
 *   \x1b[36mhttp://localhost:\x1b[1m5174\x1b[22m/\x1b[39m
 *
 * — the bold escape sits **between** the colon and the digits — so
 * `/localhost:(\d+)/` cannot match, and `/Local:\s+(http:\/\/[^\s/]+)/` captures
 * `\x1b[36mhttp:` instead of a host. Whether the banner is coloured at all depends
 * on the *inherited* environment: a shell exporting `FORCE_COLOR` makes vite
 * colourise even though its stdout is a pipe. So the suite passed in one session
 * and hung for 90 s in the next with no code change between them, and the two
 * standalone checks failed while the thirteen in-process ones passed.
 *
 * This is §A24 in its second costume: a guard that four call sites reimplemented
 * is a guard four call sites can drop. Share the function.
 */
import { spawn } from 'node:child_process'

/** Strip SGR escapes. Built from a char code so no control byte lives in source. */
const ANSI = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, 'g')

/**
 * The port from a chunk of vite output, or `null`.
 *
 * This is the part every copy got wrong, so it is the part worth sharing even
 * with callers that spawn vite differently (`npx vite` with its own env, versus
 * `npm run dev`).
 */
export function matchVitePort(chunk) {
  const m = String(chunk).replace(ANSI, '').match(/localhost:(\d+)/)
  return m ? Number(m[1]) : null
}

/**
 * Spawn `npm --prefix client run dev` and resolve once it reports a port.
 *
 * @param {object} opts
 * @param {string} opts.cwd repo root
 * @param {Record<string,string>} [opts.env] extra environment for the child
 * @param {number} [opts.timeoutMs]
 * @param {(line: string) => void} [opts.onLine] raw output, for callers that log it
 * @returns {Promise<{ proc: import('node:child_process').ChildProcess, url: string, port: number }>}
 */
export function startVite({ cwd, env = {}, timeoutMs = 90_000, onLine } = {}) {
  const proc = spawn('npm', ['--prefix', 'client', 'run', 'dev'], {
    cwd,
    env: { ...process.env, ...env },
  })
  return new Promise((resolve, reject) => {
    let settled = false
    const onData = (b) => {
      const text = b.toString()
      if (onLine) onLine(text)
      const m = text.replace(ANSI, '').match(/localhost:(\d+)/)
      if (m && !settled) {
        settled = true
        clearTimeout(timer)
        const port = Number(m[1])
        resolve({ proc, url: `http://localhost:${port}`, port })
      }
    }
    proc.stdout.on('data', onData)
    proc.stderr.on('data', onData)
    proc.on('error', (e) => {
      if (!settled) {
        settled = true
        clearTimeout(timer)
        reject(e)
      }
    })
    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      try {
        proc.kill('SIGTERM')
      } catch {
        /* already gone */
      }
      reject(new Error(`vite did not report a port within ${Math.round(timeoutMs / 1000)} s`))
    }, timeoutMs)
  })
}
