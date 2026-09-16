#!/usr/bin/env node
/**
 * T19.28 — the runner's own self-test: a **killed** check must not read as a
 * **failed** one, and must not read as a passing one either.
 *
 * Sibling of `pixels`, which proves the pixel harness can detect a change and,
 * more importantly, can fail to detect one. This proves the same about the
 * suite's exit-code reader: it spawns three real children — one that prints its
 * `ok` line and is then SIGKILLed, one that genuinely exits 1, one that exits 0
 * — and asserts the runner tells all three apart.
 *
 * The two controls are the point. Without the exit-1 child, a change that
 * reported *everything* as signalled would pass. Without the exit-0 child, a
 * change that reported everything as a failure would pass.
 *
 * Run standalone:  node scripts/checks/runner-outcome.mjs
 */
import { spawn } from 'node:child_process'
import { childOutcome } from '../lib/child-outcome.mjs'

const failures = []
const assert = (cond, msg) => {
  if (!cond) failures.push(msg)
}

/**
 * Spawn a child and read its outcome **through the same call the suite makes**
 * — `(c, sig)` into `childOutcome` — so this tests the live binding site rather
 * than a copy of the mapping.
 *
 * @param {string} body JS for `node -e`
 * @returns {Promise<{ outcome: ReturnType<typeof childOutcome>, raw: {code: number|null, signal: string|null}, out: string }>}
 */
function run(body) {
  return new Promise((res) => {
    const p = spawn(process.execPath, ['-e', body], { stdio: ['ignore', 'pipe', 'pipe'] })
    let out = ''
    p.stdout.on('data', (b) => (out += b))
    p.stderr.on('data', (b) => (out += b))
    p.on('exit', (code, signal) => {
      res({ outcome: childOutcome(code, signal), raw: { code, signal }, out })
    })
  })
}

// --- the defect: a check that printed its ok line and was then killed ---------
// This is `fog-visible`'s reported shape exactly: the check reaches its own
// success print, then the process dies to a signal mid-teardown.
const killed = await run("console.log('self-test ok'); process.kill(process.pid, 'SIGKILL')")
console.log(`  killed child: code=${killed.raw.code} signal=${killed.raw.signal} kind=${killed.outcome.kind}`)
assert(
  killed.raw.code === null && killed.raw.signal === 'SIGKILL',
  `the premise failed: expected code=null signal=SIGKILL, got code=${killed.raw.code} signal=${killed.raw.signal}`,
)
assert(
  killed.out.includes('self-test ok'),
  'the premise failed: the killed child never printed its ok line, so it is not the case under test',
)
assert(
  killed.outcome.kind === 'signalled',
  `a SIGKILLed child reads as "${killed.outcome.kind}", not "signalled"`,
)
assert(
  String(killed.outcome.err).includes('SIGKILL'),
  `the signal must be named in the output; got ${JSON.stringify(killed.outcome.err)}`,
)
// A signalled check made no claim, so it must not go green.
assert(killed.outcome.ok === false, 'a SIGKILLed child reported ok — a killed suite would read as green')

// --- control 1: a genuine failure is still a failure --------------------------
const failedChild = await run('process.exit(1)')
console.log(`  failing child: code=${failedChild.raw.code} signal=${failedChild.raw.signal} kind=${failedChild.outcome.kind}`)
assert(
  failedChild.outcome.kind === 'failed',
  `a child exiting 1 reads as "${failedChild.outcome.kind}", not "failed"`,
)
assert(failedChild.outcome.ok === false, 'a child exiting 1 reported ok')

// --- control 2: a pass is still a pass ----------------------------------------
const passingChild = await run('process.exit(0)')
console.log(`  passing child: code=${passingChild.raw.code} signal=${passingChild.raw.signal} kind=${passingChild.outcome.kind}`)
assert(
  passingChild.outcome.kind === 'passed' && passingChild.outcome.ok === true,
  `a child exiting 0 reads as "${passingChild.outcome.kind}" / ok=${passingChild.outcome.ok}`,
)

// --- the claim itself: the two not-passing outcomes are DISTINGUISHABLE -------
// Before T19.28 both of these produced the identical string `exited 1`, which is
// the whole defect. Asserting the kinds differ is not enough on its own — the
// value of the fix is that the *reported text* tells the reader which happened.
assert(
  killed.outcome.kind !== failedChild.outcome.kind,
  'a killed child and a failed child report the same kind',
)
assert(
  killed.outcome.err !== failedChild.outcome.err,
  `a killed child and a failed child report the same text: ${JSON.stringify(killed.outcome.err)}`,
)

// --- and the gate stays red for both -------------------------------------------
assert(
  !killed.outcome.ok && !failedChild.outcome.ok,
  'the suite would exit 0 with a not-passing check in it',
)

if (failures.length) {
  console.error('FAIL: runner-outcome')
  for (const f of failures) console.error(`  - ${f}`)
  process.exit(1)
}
console.log('runner-outcome ok')
