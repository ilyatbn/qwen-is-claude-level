#!/usr/bin/env bash
# The gate. Nothing is "done" until this is green.  docs/60-testing.md §2
#
#   ./scripts/check.sh                  everything
#   ./scripts/check.sh --fast           skip clippy and the asset check, for the edit loop
#   ./scripts/check.sh --changed [REV]  only what the change touches: fmt/clippy/tests for the
#                                       affected crates, the client if affected, and the affected
#                                       browser checks. REV defaults to HEAD~1 against the working
#                                       tree — see scripts/affected.mjs. Not a substitute for the
#                                       full gate before a milestone closes.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

FAST=0
CHANGED=0
REV=""
while [ $# -gt 0 ]; do
  case "$1" in
    --fast) FAST=1 ;;
    --changed)
      CHANGED=1
      # An optional rev: the next word, unless it is another option.
      if [ $# -gt 1 ] && [ "${2#-}" = "$2" ]; then REV="$2"; shift; fi
      ;;
    -h|--help) sed -n '2,10p' "$0"; exit 0 ;;
    *) echo "unknown option: $1" >&2; exit 2 ;;
  esac
  shift
done

banner() {
  printf '\n\033[1;34m=== %s ===\033[0m\n' "$1"
}

# What to run. The full gate is "all of it"; `--changed` asks scripts/affected.mjs,
# which derives the answer from the tree and falls back to everything when unsure.
if [ "$CHANGED" -eq 1 ]; then
  banner "affected since ${REV:-HEAD~1}"
  node scripts/affected.mjs ${REV:+"$REV"}
  eval "$(node scripts/affected.mjs ${REV:+"$REV"} --shell)"
else
  AFFECTED_CRATES=ALL
  AFFECTED_CLIENT=1
  AFFECTED_E2E=ALL
  AFFECTED_NET_SMOKE=1
  AFFECTED_ASSETS=1
fi

# `-p a -p b`, or nothing for the whole workspace.
PKGS=()
if [ "$AFFECTED_CRATES" != ALL ]; then
  for c in $AFFECTED_CRATES; do PKGS+=(-p "$c"); done
fi

if [ "$AFFECTED_CRATES" = ALL ]; then
  banner "cargo fmt --check"
  cargo fmt --all -- --check
elif [ ${#PKGS[@]} -gt 0 ]; then
  banner "cargo fmt --check ($AFFECTED_CRATES)"
  cargo fmt "${PKGS[@]}" -- --check
else
  banner "cargo fmt, clippy, test (skipped: no crate affected)"
fi

if [ "$AFFECTED_CRATES" = ALL ] || [ ${#PKGS[@]} -gt 0 ]; then
  if [ "$FAST" -eq 0 ]; then
    banner "cargo clippy -D warnings"
    cargo clippy "${PKGS[@]}" --all-targets --all-features -- -D warnings
  else
    banner "cargo clippy (skipped: --fast)"
  fi

  if [ "$AFFECTED_CRATES" = ALL ]; then
    banner "cargo test --workspace"
    cargo test --workspace
  else
    banner "cargo test ($AFFECTED_CRATES)"
    cargo test "${PKGS[@]}"
  fi
fi

if [ "$AFFECTED_CLIENT" -eq 1 ]; then
  banner "client typecheck"
  npm --prefix client run typecheck

  banner "client tests"
  npm --prefix client test -- --run
else
  banner "client typecheck and tests (skipped: client not affected)"
fi

banner "repo guards"
# Milliseconds, and deliberately outside the `--fast` block below: these are the
# two claims nothing else re-validates — that `TASKS.md`'s links resolve, and
# that every `#[ignore]`d test is named in `scripts/ignored.sh` (T20.17).
node scripts/verify-repo.mjs
# The file → check mapping `--changed` trusts. Run in every mode, because a
# mapping that silently drops a check is the one failure `--changed` cannot see.
node --test scripts/lib/affected.test.mjs

# Everything below needs a browser or the network. `--fast` skips the lot.
#
# (This was two nested `if [ "$FAST" -eq 0 ]` blocks with mismatched indentation
# — balanced, but the next person to add a check here would have got it wrong.)
if [ "$FAST" -eq 0 ]; then
  # The whole browser suite, in the gate on purpose (T8.07). Night visibility is
  # a pillar of the game and it broke while every unit test and every counter
  # stayed green — only sampled pixels caught it (docs/70 §A15, §A16). The same
  # is true of the two-client mask agreement and of WASD.
  #
  # One vite and one Chromium for the in-page checks; `--jobs` (default in
  # e2e.mjs) runs several checks at once.
  if [ "$AFFECTED_E2E" = ALL ]; then
    banner "e2e suite"
    node scripts/e2e.mjs
  elif [ -n "$AFFECTED_E2E" ]; then
    banner "e2e suite (affected: $AFFECTED_E2E)"
    node scripts/e2e.mjs --only "$AFFECTED_E2E"
  else
    banner "e2e suite (skipped: no check affected)"
  fi

  if [ "$AFFECTED_NET_SMOKE" -eq 1 ]; then
    banner "net smoke (shipping client)"
    # The control for the join flake (docs/70 §A28): the Rust integration tests use
    # `rust_socketio`, which is not the client that ships. When they go red, this
    # says whether the server is at fault or the harness is.
    node scripts/net-smoke.mjs 25
  fi

  if [ "$AFFECTED_ASSETS" -eq 1 ]; then
    banner "assets"
    node scripts/verify-assets.mjs
  fi
else
  banner "e2e suite, net smoke, assets (skipped: --fast)"
fi

if [ "$CHANGED" -eq 1 ]; then
  printf '\n\033[1;32mall affected checks passed\033[0m (--changed: not the full gate)\n'
else
  printf '\n\033[1;32mall checks passed\033[0m\n'
fi
