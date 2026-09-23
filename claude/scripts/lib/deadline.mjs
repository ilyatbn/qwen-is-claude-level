/**
 * Build a `waitForFunction` timeout from a number of seconds, and **refuse** a
 * number that is not one (T20.15).
 *
 * `scripts/checks/lobby-start.mjs` read `constants().LOBBY_BOT_TIMEOUT`, which is
 * not in `constants_json`. The read was `undefined`, `(undefined + 8) * 1000` is
 * `NaN`, and **Playwright treats a `NaN` timeout as no deadline** — so the wait
 * did not fail when the thing it waited for never happened. It hung until
 * something further up killed it, and the failure was then reported as whatever
 * that was. `CLAUDE.md`'s *"an assertion on a field that does not exist cannot
 * fail"*, in its other form: a **wait** built on a missing field cannot time out.
 *
 * `strictConstants` in `client/src/core/index.ts` closes the hole at the read.
 * This closes it at the arithmetic, which is the half that survives a deadline
 * computed from anything else — an env override, a response body, a parsed log
 * line. Two guards because they fail at different times: one when a constant is
 * renamed, one when a value arrives in the wrong shape.
 */

/**
 * Seconds → milliseconds, or throw.
 *
 * `label` names the wait in the message, because the whole point is that the
 * failure says which wait is broken instead of surfacing as a timeout somewhere
 * else entirely.
 */
export function deadlineMs(seconds, label) {
  if (typeof seconds !== 'number' || !Number.isFinite(seconds) || seconds <= 0) {
    throw new Error(
      `${label}: a deadline of ${String(seconds)} is not a positive number of ` +
        `seconds. A wait built from it would have no deadline at all and could never ` +
        `fail — see scripts/lib/deadline.mjs.`,
    )
  }
  return seconds * 1000
}
