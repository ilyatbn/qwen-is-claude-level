#!/usr/bin/env bash
# The gate. Nothing is "done" until this is green.  docs/60-testing.md §2
#
#   ./scripts/check.sh          everything
#   ./scripts/check.sh --fast   skip clippy and the asset check, for the edit loop
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

FAST=0
for arg in "$@"; do
  case "$arg" in
    --fast) FAST=1 ;;
    -h|--help) sed -n '2,6p' "$0"; exit 0 ;;
    *) echo "unknown option: $arg" >&2; exit 2 ;;
  esac
done

banner() {
  printf '\n\033[1;34m=== %s ===\033[0m\n' "$1"
}

banner "cargo fmt --check"
cargo fmt --all -- --check

if [ "$FAST" -eq 0 ]; then
  banner "cargo clippy -D warnings"
  cargo clippy --all-targets --all-features -- -D warnings
else
  banner "cargo clippy (skipped: --fast)"
fi

banner "cargo test --workspace"
cargo test --workspace

banner "client typecheck"
npm --prefix client run typecheck

banner "client tests"
npm --prefix client test -- --run

banner "repo guards"
# Milliseconds, and deliberately outside the `--fast` block below: these are the
# two claims nothing else re-validates — that `TASKS.md`'s links resolve, and
# that every `#[ignore]`d test is named in `scripts/ignored.sh` (T20.17).
node scripts/verify-repo.mjs

# Everything below needs a browser or the network. `--fast` skips the lot.
#
# (This was two nested `if [ "$FAST" -eq 0 ]` blocks with mismatched indentation
# — balanced, but the next person to add a check here would have got it wrong.)
if [ "$FAST" -eq 0 ]; then
  banner "e2e suite"
  # The whole browser suite, in the gate on purpose (T8.07). Night visibility is
  # a pillar of the game and it broke while every unit test and every counter
  # stayed green — only sampled pixels caught it (docs/70 §A15, §A16). The same
  # is true of the two-client mask agreement and of WASD.
  #
  # One vite and one Chromium for all of them, so running the lot costs about as
  # much as running one used to.
  node scripts/e2e.mjs

  banner "net smoke (shipping client)"
  # The control for the join flake (docs/70 §A28): the Rust integration tests use
  # `rust_socketio`, which is not the client that ships. When they go red, this
  # says whether the server is at fault or the harness is.
  node scripts/net-smoke.mjs 25

  banner "assets"
  node scripts/verify-assets.mjs
else
  banner "e2e suite, net smoke, assets (skipped: --fast)"
fi

printf '\n\033[1;32mall checks passed\033[0m\n'
