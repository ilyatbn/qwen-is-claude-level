/**
 * What a finished child process actually did — T19.28.
 *
 * `scripts/e2e.mjs` used to read a standalone check's result as
 *
 *     p.on('exit', (c) => res(c ?? 1))
 *
 * and a child **killed by a signal** delivers `code === null`, so `?? 1` turned
 * it into exit 1 — byte for byte the same report as a check whose assertions
 * failed. The two want opposite responses: a failure is a bug to fix, a kill is
 * a run to repeat. Twenty minutes went into diagnosing one `FAILED (151.5s)` on
 * `fog-visible` that had printed its own `fog-visible ok` line first.
 *
 * This is the runner committing the shape the runner exists to catch: a claim
 * reported through something other than the thing it claims. So the mapping
 * lives in one function, with a test that spawns a real child and kills it.
 *
 * A signalled child is **not** a pass. It made no claim, so the suite's exit
 * code stays non-zero — a killed suite reading as a green one is worse than
 * what the bug did.
 */

/**
 * @typedef {'passed' | 'failed' | 'signalled'} OutcomeKind
 * @typedef {{ ok: boolean, kind: OutcomeKind, err?: string }} Outcome
 */

/**
 * Classify the `(code, signal)` pair Node hands an `'exit'` listener.
 *
 * @param {number | null} code
 * @param {NodeJS.Signals | string | null} signal
 * @returns {Outcome}
 */
export function childOutcome(code, signal) {
  // `code === null` with no signal name should not happen, but if it does the
  // one thing we know is that the child did not exit normally — reporting it as
  // `exited null` would be the same lie in a new costume.
  if (signal || code === null) {
    return { ok: false, kind: 'signalled', err: `killed by ${signal ?? 'an unreported signal'}` }
  }
  if (code === 0) return { ok: true, kind: 'passed' }
  return { ok: false, kind: 'failed', err: `exited ${code}` }
}

/** The four-cell label for the summary table. Distinct per kind, on purpose. */
export function outcomeLabel(kind) {
  if (kind === 'signalled') return '\x1b[1;33mKILL\x1b[0m'
  return kind === 'passed' ? '\x1b[1;32mok  \x1b[0m' : '\x1b[1;31mFAIL\x1b[0m'
}

/** The inline banner a check prints as it finishes. */
export function outcomeBanner(kind) {
  if (kind === 'signalled') return '\x1b[1;33mKILLED\x1b[0m'
  return kind === 'passed' ? '\x1b[1;32mok\x1b[0m' : '\x1b[1;31mFAILED\x1b[0m'
}
