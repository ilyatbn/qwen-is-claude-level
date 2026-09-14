#!/usr/bin/env node
/**
 * T8.07 — the end-to-end suite.
 *
 *   node scripts/e2e.mjs            # everything
 *   node scripts/e2e.mjs wasd sky   # only checks whose name matches
 *
 * Every check drives a **real browser against the real client** and reads the
 * simulation's own state through `window.__game`, never the rendered sprite: a
 * sprite can move for reasons that have nothing to do with input.
 *
 * Every check writes at least one screenshot to `shots/`. On this box there is no
 * display, so a screenshot is the only way a failure is ever *seen* — the numbers
 * say what broke and the picture says what it looked like.
 *
 * ## Why this is not `@playwright/test`
 *
 * `docs/70` T8.07 names `playwright.config.ts` and `e2e/*.spec.ts`. The checks
 * already existed as `scripts/checks/*.mjs` driven by `drive.mjs`, and that
 * harness already solves the two things that are actually hard here: reading
 * vite's port from its own output (it falls back to 5174+ when 5173 is taken),
 * and pointing Chromium at the libraries unpacked under `~/.cache/pwlibs`, which
 * this box does not have installed system-wide. Adding a second runner would mean
 * a second way to launch a browser and a second place for those two workarounds
 * to drift.
 *
 * What the task actually asked for was a suite that runs in the gate rather than
 * a pile of scripts nobody runs. That is what this is — and booting vite and
 * Chromium **once** for all of them, instead of once per check, is what makes
 * putting it in the gate affordable.
 */
import { spawn, spawnSync, execSync } from 'node:child_process'
import { AsyncLocalStorage } from 'node:async_hooks'
import { format } from 'node:util'
import { mkdirSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { createRequire } from 'node:module'
import { matchVitePort } from './vite-url.mjs'
import { childOutcome, outcomeBanner, outcomeLabel } from './lib/child-outcome.mjs'
import { CHECKS } from './lib/e2e-checks.mjs'
import { startRouter } from './lib/stack-router.mjs'
import { freePort } from './lib/free-port.mjs'
import { BROWSER_ARGS } from './lib/browser-args.mjs'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
/**
 * Ownership, for the leak guard. Every process this run starts — vite, each
 * check, its cargo/game-server, every Chromium and its helpers — inherits this
 * environment, so `/proc/<pid>/environ` says whose it is. "New since the suite
 * started" said nothing of the kind once agents shared the box: a `--jobs 4` run
 * reported and SIGKILLed 19 chromium that another builder's `e2e.mjs fire-visible`
 * was using at the time.
 */
const RUN_ID = `${process.pid}-${Date.now()}`
process.env.E2E_RUN_ID = RUN_ID
const shotsDir = join(root, 'shots')
mkdirSync(shotsDir, { recursive: true })

const libDir = join(process.env.HOME ?? '', '.cache/pwlibs/root/usr/lib/x86_64-linux-gnu')
const chromePath = join(
  process.env.HOME ?? '',
  '.cache/ms-playwright/chromium-1234/chrome-linux64/chrome',
)

// The table lives in lib/e2e-checks.mjs so scripts/affected.mjs maps changed
// files onto the same list this file runs.

/**
 * `--jobs N`: how many checks run at once. `--jobs 1` is the old strictly
 * sequential suite, output streamed live. Above 1 each check's output is
 * buffered and printed whole when it finishes, so interleaving never happens;
 * checks marked `serial: true` run alone after the rest.
 *
 * The default is measured, not guessed — see DEFAULT_JOBS.
 */
// DEFAULT_JOBS, measured on this 16-core box on 2026-09-14, full default suite at
// 00133b7, build warmed first, another builder's tests loading the box throughout:
//   --jobs 1  1957.8 s  (load median 9.3)   --jobs 4  696.8 s  (load 8 -> 30)
// 4 is the only parallel value timed end to end. Not yet re-timed with the seven
// `serial` checks that run then added, which move ~8 min of checks to the end.
const DEFAULT_JOBS = 4
const argv = process.argv.slice(2)
let jobs = DEFAULT_JOBS
const filters = []
for (let i = 0; i < argv.length; i++) {
  const a = argv[i]
  const m = a.match(/^--jobs(?:=(.*))?$/)
  if (m) {
    const v = m[1] ?? argv[++i]
    jobs = Number(v)
    if (!Number.isInteger(jobs) || jobs < 1) {
      console.error(`--jobs wants a positive integer, got ${v}`)
      process.exit(2)
    }
  } else if (a === '--only') {
    // `--only a,b,c`: exact names, as `affected.mjs` prints them. A fragment
    // filter would let `lobby` also select `lobby-start`, which is harmless,
    // but `--only` with an empty list must select nothing rather than all.
    const v = argv[++i] ?? ''
    for (const n of v.split(',').filter(Boolean)) filters.push(`=${n}`)
    if (!v) filters.push('=')
  } else {
    filters.push(a)
  }
}
const matches = (c, f) => (f.startsWith('=') ? c.name === f.slice(1) : c.name.includes(f))
// `--help` before anything else: it is the one invocation that must not build
// wasm, launch vite or open a browser, and it is what a smoke test can afford
// to run. Without it `--help` fell through to the name filter, matched nothing
// and exited 2 — a usage request reported as "no checks match --help".
if (filters.some((f) => f === '--help' || f === '-h')) {
  console.log('usage: node scripts/e2e.mjs [--jobs N] [--only a,b] [name-fragment ...]')
  console.log('  no arguments runs every check except the opt-in ones')
  console.log(`  --jobs N   checks at once (default ${DEFAULT_JOBS}; 1 = sequential, live output)`)
  console.log('  --only     exact check names, comma-separated')
  console.log(`serial:    ${CHECKS.filter((c) => c.serial).map((c) => c.name).join(', ')}`)
  console.log(`available: ${CHECKS.map((c) => c.name).join(', ')}`)
  console.log(`opt-in:    ${CHECKS.filter((c) => c.optIn).map((c) => c.name).join(', ')}`)
  console.log(`flaky:     ${CHECKS.filter((c) => c.flaky).map((c) => c.name).join(', ')} (see tasks/flaky-test.md)`)
  process.exit(0)
}
const selected = filters.length
  ? CHECKS.filter((c) => filters.some((f) => matches(c, f)))
  : // An opt-in or flaky check is only skipped when nothing was asked for by
    // name, so `e2e.mjs full-round` or `e2e.mjs two-clients` still runs it.
    // Flaky checks are parked out of the gate pending a decision — the list and
    // the evidence for each is tasks/flaky-test.md.
    CHECKS.filter((c) => !c.optIn && !c.flaky)
if (!selected.length) {
  console.error(`no checks match ${filters.join(', ')}`)
  console.error(`available: ${CHECKS.map((c) => c.name).join(', ')}`)
  process.exit(2)
}

const require = createRequire(join(root, 'client/package.json'))
const { chromium } = require('playwright-core')

/**
 * **Build the wasm before the clock starts, not inside it** (T19.16).
 *
 * This used to be `npm --prefix client run dev`, whose `predev` hook runs
 * `scripts/wasm-build.mjs` — so the 90 s budget below, whose failure message
 * says *"vite did not report a port"*, was in fact a budget for **a release
 * Rust build plus a lock wait plus vite**. Measured on an idle box: 11.7 s to
 * the port line, of which **11.6 s was `predev` and 0.1 s was vite**. The
 * deadline was 99 % a build timer wearing vite's name.
 *
 * That is not academic. `wasm-build.mjs` takes a lock (T19.15) whose wait is
 * bounded at ten minutes, and every concurrent build adds one build to the
 * queue. Reproduced, exactly: 24 queued `wasm-build.mjs` processes, then
 * `node scripts/e2e.mjs title` →
 * `(startup): vite did not report a port within 90 s`, with vite never asked to
 * do anything. A single blocking build put a straight run at 19.9 s and a
 * twelve-deep queue at 93.3 s.
 *
 * So the build happens here, synchronously and **outside** the deadline, and
 * vite is then started the way every standalone check starts it — `npx vite`,
 * which runs no npm hooks. The 90 s is untouched and now measures what it
 * names: a step that takes 0.1 s. Nothing was widened; the wrong work was
 * moved out.
 */
console.log('building wasm before starting the clock (T19.16)')
const built = spawnSync('node', [join(root, 'scripts/wasm-build.mjs')], {
  cwd: root,
  stdio: 'inherit',
  env: process.env,
})
if (built.status !== 0) {
  console.error(`wasm-build failed (${built.status}) — vite would serve a stale or missing pkg`)
  process.exit(1)
}
// The same move for the game-server every standalone check `cargo run`s. Built
// inside the first check, its compile counted against that check's health
// budget; and under `--jobs` N checks would queue on cargo's build lock at once.
// Same profile and package as `harness.mjs::startStack`, so their `cargo run`
// finds it fresh.
if (selected.some((c) => c.standalone)) {
  console.log('building game-server before starting the clock')
  const server = spawnSync('cargo', ['build', '--quiet', '--release', '-p', 'game-server'], {
    cwd: root,
    stdio: 'inherit',
    env: process.env,
  })
  if (server.status !== 0) {
    console.error(`game-server build failed (${server.status})`)
    process.exit(1)
  }
}

// `detached` so this gets its own process group. `npx vite` forks the real vite
// as a grandchild, and killing npx leaves that grandchild running — ten orphaned
// vite servers were found accumulating on this box, which is itself the "loaded
// machine" that has been blamed for three separate flakes. Killing the group
// kills the grandchild too.
// **One vite for every check, including the standalone ones**, whose own
// game-servers are each on an OS port. vite proxies `/socket.io` to one port,
// so that port is `lib/stack-router.mjs`, which forwards each request to the
// server its context's `e2e_server` cookie names. In-page checks never open a
// socket, so for them this changes nothing.
const router = await startRouter(await freePort())
const vite = spawn('npx', ['vite', '--strictPort=false'], {
  detached: true,
  cwd: join(root, 'client'),
  env: { ...process.env, LD_LIBRARY_PATH: libDir, VITE_SERVER_PORT: String(router.port) },
})

let port = null
const portReady = new Promise((res, rej) => {
  // Shared parse (scripts/vite-url.mjs): vite puts an ANSI bold escape between
  // `localhost:` and the port, and whether it colourises at all depends on the
  // inherited environment — a shell exporting FORCE_COLOR makes it do so even
  // through a pipe. Four scripts each wrote this by hand and all four broke.
  const onData = (b) => {
    const found = matchVitePort(b)
    const m = found ? [null, String(found)] : null
    if (m && !port) {
      port = Number(m[1])
      res(port)
    }
  }
  vite.stdout.on('data', onData)
  vite.stderr.on('data', onData)
  // 90 s for a step measured at 0.1 s. It is generous because it is now only
  // about vite: see the comment above the build for why it used to be a
  // coin flip and what it was really timing.
  setTimeout(() => rej(new Error('vite did not report a port within 90 s')), 90_000)
})

const shutdown = () => {
  try {
    // Negative pid = the whole group, which is where the real vite lives.
    process.kill(-vite.pid, 'SIGTERM')
  } catch {
    try {
      vite.kill('SIGTERM')
    } catch {
      /* already gone */
    }
  }
}
process.on('exit', shutdown)

/**
 * Processes the suite is responsible for, sampled before and after.
 *
 * `npx vite`, `npm run dev` and `cargo run` each fork the process that actually
 * holds the port, so a naive `child.kill()` reaps the wrapper and orphans the
 * server. Five scripts wrote that naive version and all five leaked. The load
 * accumulated silently and three sessions recorded the result as "two-clients is
 * flaky under contention" — the contention was self-inflicted, and the box got
 * slower every time the suite ran.
 *
 * Counting at both ends turns that from an invisible drift into a loud failure
 * (§A39). Only pids that are NEW since the suite started are reported, so a dev
 * server someone already had running is not blamed on the suite.
 */
const STRAY_PATTERNS = [
  ['vite', /node .*\.bin\/vite/],
  ['chromium', /chrome-linux64\/chrome/],
  ['game-server', /target\/(debug|release)\/game-server/],
]
const strayPids = () => {
  const out = new Map()
  let ps = ''
  try {
    ps = execSync('ps -eo pid=,args=', { encoding: 'utf8' })
  } catch {
    return out // ps unavailable: the guard simply does not run
  }
  for (const line of ps.split('\n')) {
    const m = line.trim().match(/^(\d+)\s+(.*)$/)
    if (!m) continue
    for (const [name, re] of STRAY_PATTERNS) {
      if (re.test(m[2]) && ownedByThisRun(Number(m[1]))) out.set(Number(m[1]), name)
    }
  }
  return out
}
/**
 * Only processes carrying this run's `E2E_RUN_ID` count. A process whose
 * environment cannot be read (gone, or another user's) is not ours to kill —
 * an unattributable process gets reported by whoever owns it, not swept here.
 */
function ownedByThisRun(pid) {
  try {
    return readFileSync(`/proc/${pid}/environ`, 'latin1')
      .split('\0')
      .includes(`E2E_RUN_ID=${RUN_ID}`)
  } catch {
    return false
  }
}
const straysBefore = strayPids()

/**
 * Which check a `console.log` belongs to. In-process checks share this process,
 * so under `--jobs` their lines would interleave; while a check runs inside
 * `checkOutput.run(sink, …)` its console calls go to its own sink instead.
 * Outside any check (startup, the summary) they print as usual.
 */
const checkOutput = new AsyncLocalStorage()
for (const k of ['log', 'error', 'warn', 'info']) {
  const original = console[k].bind(console)
  console[k] = (...args) => {
    const sink = checkOutput.getStore()
    if (sink) sink.write(`${format(...args)}\n`)
    else original(...args)
  }
}

const results = []
let browser
let browserServer

try {
  await portReady
  // A browser **server**, so standalone checks connect to it instead of each
  // launching one (`harness.mjs::startStack`), and one connection to it for the
  // in-page checks. Same flags as a hand-run check: lib/browser-args.mjs.
  browserServer = await chromium.launchServer({
    executablePath: chromePath,
    env: { ...process.env, LD_LIBRARY_PATH: libDir },
    args: BROWSER_ARGS,
  })
  browser = await chromium.connect(browserServer.wsEndpoint())

  /**
   * One check, start to finish, with its output going to `sink`. Returns its
   * result row; never throws.
   */
  const runStandalone = async (check, sink) => {
    const started = Date.now()
    // `(c, sig)`, not `(c)`. A child killed by a signal delivers `code ===
    // null`, and the old `c ?? 1` reported that as exit 1 — indistinguishable
    // from a check whose assertions failed. See lib/child-outcome.mjs.
    const outcome = await new Promise((res) => {
      // Piped, not inherited, so concurrent checks cannot interleave. Its
      // game-server inherits these pipes too, so `close` can lag `exit` by a
      // leaked grandchild's lifetime: wait for it, but only briefly — the leak
      // guard below is what reports a grandchild that outlived its check.
      // The shared vite and browser, unless the check keeps its own stack
      // (`ownStack` in lib/e2e-checks.mjs says why at each entry).
      const env = check.ownStack
        ? process.env
        : {
            ...process.env,
            E2E_SHARED_VITE_URL: `http://localhost:${port}`,
            E2E_SHARED_BROWSER_WS: browserServer.wsEndpoint(),
          }
      const p = spawn('node', [check.file], {
        cwd: root,
        stdio: ['ignore', 'pipe', 'pipe'],
        env,
      })
      p.stdout.on('data', (b) => sink.write(b))
      p.stderr.on('data', (b) => sink.write(b))
      let closed = false
      p.on('close', () => {
        closed = true
      })
      p.on('exit', (c, sig) => {
        const done = () => res(childOutcome(c, sig))
        if (closed) return done()
        p.on('close', done)
        setTimeout(done, 2000)
      })
    })
    sink.write(`  ${outcomeBanner(outcome.kind)} (${((Date.now() - started) / 1000).toFixed(1)}s)\n`)
    return {
      name: check.name,
      ok: outcome.ok,
      kind: outcome.kind,
      ms: Date.now() - started,
      err: outcome.err,
    }
  }

  const runInPage = async (check) => {
    const started = Date.now()
    // A fresh page per check: shared page state is how one check's leftover
    // keyboard or paused clock silently changes the next one's result.
    const page = await browser.newPage({ viewport: { width: 1280, height: 720 } })
    const errors = []
    page.on('pageerror', (e) => errors.push(String(e)))
    let shots = 0
    try {
      await page.goto(`http://localhost:${port}/${check.url}`, { waitUntil: 'load' })
      // What "loaded" means is per check. It defaults to the game handle,
      // because thirteen checks drive the sandbox — but the title screen has no
      // `__game` and never will, and hardcoding one scene's handle here made
      // the harness silently un-runnable for any other screen.
      await page.waitForFunction(check.ready ?? (() => !!window.__game), null, {
        timeout: 60_000,
      })

      const shot = async (name) => {
        await page.screenshot({ path: join(shotsDir, `${name}.png`) })
        shots += 1
        console.log(`  shot: shots/${name}.png`)
      }
      const log = (...a) => console.log(' ', ...a)

      const mod = await import(pathToFileURL(resolve(root, check.file)).href)
      // A check that is not a module would otherwise run its body on import and
      // take the suite with it. Say so, rather than failing three frames deeper.
      if (typeof mod.default !== 'function') {
        throw new Error(
          `${check.file} does not export a default function — mark it \`standalone: true\``,
        )
      }
      await mod.default({ page, shot, log })

      // A page error is a failure even when every assertion passed: an exception
      // in a render path leaves the numbers intact and the picture broken.
      if (errors.length) throw new Error(`page errors:\n${errors.join('\n')}`)
      if (shots === 0) throw new Error('the check wrote no screenshot')

      console.log(`  \x1b[1;32mok\x1b[0m (${((Date.now() - started) / 1000).toFixed(1)}s)`)
      return { name: check.name, ok: true, kind: 'passed', ms: Date.now() - started }
    } catch (e) {
      // Capture the frame at the moment of failure — on a headless box this is
      // usually the only evidence of what it looked like.
      try {
        await page.screenshot({ path: join(shotsDir, `FAILED-${check.name}.png`) })
        console.log(`  shot: shots/FAILED-${check.name}.png`)
      } catch {
        /* the page may be gone */
      }
      console.log(`  \x1b[1;31mFAILED\x1b[0m ${e.message}`)
      return { name: check.name, ok: false, kind: 'failed', ms: Date.now() - started, err: e.message }
    } finally {
      await page.close()
    }
  }

  // At `--jobs 1` a check's output streams as it happens, header first — the
  // old behaviour. Above that it is held and printed whole at the end, so a
  // reader sees one check at a time however they overlapped.
  const runCheck = async (check) => {
    const header = `\n\x1b[1;34m=== ${check.name} ===\x1b[0m\n`
    const live = jobs === 1
    const chunks = []
    const sink = {
      write: (b) => (live ? process.stdout.write(b) : chunks.push(Buffer.from(b))),
    }
    if (live) process.stdout.write(header)
    const result = check.standalone
      ? await runStandalone(check, sink)
      : // In-process checks log through `console` (their `log` and `shot`
        // helpers do), so their output is routed per check by async context.
        await checkOutput.run(sink, () => runInPage(check))
    if (!live) process.stdout.write(Buffer.concat([Buffer.from(header), ...chunks]))
    return result
  }

  // Serial checks run alone, after the pool drains; at `--jobs 1` everything
  // keeps the table's order.
  const pooled = jobs === 1 ? [...selected] : selected.filter((c) => !c.serial)
  const serial = jobs === 1 ? [] : selected.filter((c) => c.serial)
  const byName = new Map()
  const worker = async () => {
    for (let c = pooled.shift(); c; c = pooled.shift()) byName.set(c.name, await runCheck(c))
  }
  if (jobs > 1) {
    console.log(`\nrunning ${pooled.length} check(s) ${jobs} at a time, then ${serial.length} serial`)
  }
  await Promise.all(Array.from({ length: Math.min(jobs, pooled.length) }, worker))
  for (const c of serial) byName.set(c.name, await runCheck(c))
  // The summary keeps the table's order, whatever order they finished in.
  for (const c of selected) if (byName.has(c.name)) results.push(byName.get(c.name))
} catch (e) {
  console.error(`\nsuite could not start: ${e.message}`)
  results.push({ name: '(startup)', ok: false, kind: 'failed', ms: 0, err: e.message })
} finally {
  // The connection, then the browser server, then the router — all the suite's
  // own, closed before the leak guard samples, as vite is.
  await browser?.close().catch(() => {})
  await browserServer?.close().catch(() => {})
  await router.close()
  shutdown()
}

const failed = results.filter((r) => !r.ok)
console.log('\n\x1b[1;34m=== e2e summary ===\x1b[0m')
for (const r of results) {
  console.log(`  ${outcomeLabel(r.kind ?? (r.ok ? 'passed' : 'failed'))} ${r.name.padEnd(28)} ${(r.ms / 1000).toFixed(1)}s`)
}
const signalled = results.filter((r) => r.kind === 'signalled')
console.log(`  ${results.length - failed.length}/${results.length} passed`)
if (signalled.length) {
  // Named separately because the response differs: a failure is a defect to
  // fix, a kill is a run to repeat. Both keep the exit code non-zero.
  console.log(
    `  ${signalled.length} of the ${failed.length} not-passing were KILLED, not failed: ` +
      signalled.map((r) => `${r.name} (${r.err})`).join(', '),
  )
}
for (const f of failed) console.log(`\n  ${f.name}: ${f.err}`)

// Did the suite leave anything running? See STRAY_PATTERNS above.
// Stop our own vite FIRST: it is still alive at this point and the `exit`
// handler only reaps it after this code runs, so sampling before shutting down
// counts the suite's own server as a leak. That false positive is the same
// shape as the bugs this guard exists to catch — an assertion that includes
// something it did not mean to.
shutdown()
// Sample twice with a grace window between. A process still winding down from
// `browser.close()` has not leaked — it is exiting — and reporting it would make
// this guard fail on teardown timing rather than on the thing it exists to catch.
// Only pids that survive the grace period count.
let leaked = []
for (let attempt = 0; attempt < 2; attempt++) {
  await new Promise((r) => setTimeout(r, 2000))
  leaked = [...strayPids()].filter(([pid]) => !straysBefore.has(pid))
  if (!leaked.length) break
}
if (leaked.length) {
  const byKind = {}
  for (const [, kind] of leaked) byKind[kind] = (byKind[kind] ?? 0) + 1
  console.log(
    `\n  \x1b[1;31mLEAKED\x1b[0m ${leaked.length} process(es): ` +
      Object.entries(byKind).map(([k, n]) => `${n} ${k}`).join(', '),
  )
  console.log('  These accumulate across runs and slow every later run. See scripts/proc-group.mjs.')
  for (const [pid, kind] of leaked) {
    try {
      process.kill(-pid, 'SIGKILL')
    } catch {
      try {
        process.kill(pid, 'SIGKILL')
      } catch {
        /* already gone */
      }
    }
    console.log(`    killed ${kind} ${pid}`)
  }
}

process.exit(failed.length || leaked.length ? 1 : 0)
