#!/usr/bin/env node
/**
 * `thrusters-match-remote` — T23.10C F11 (T22.00C): `thrusters-match` without its parked bell arm. Every other arm — a
 * remote's flame in a real space match and its release, braking, standard gravity, death mid-burn — gates again; the
 * bell arm stays in `thrusters-match`, parked (tasks/flaky-test.md). One file, one set of arms: this only names which.
 *
 *   node scripts/checks/thrusters-match-remote.mjs
 */
process.env.THRUSTERS_ARMS = 'gating'
await import('./thrusters-match.mjs')
