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

if [ "$FAST" -eq 0 ]; then
  banner "assets"
  node scripts/verify-assets.mjs
else
  banner "assets (skipped: --fast)"
fi

printf '\n\033[1;32mall checks passed\033[0m\n'
