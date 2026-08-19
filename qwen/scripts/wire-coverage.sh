#!/usr/bin/env bash
# Every event named in protocol.rs's `s2c` module must have an emit site in the
# server. A protocol constant with no emit site is an event the docs promise and
# the server never sends — which is how map delivery went missing for four
# phases (DEVIATIONS.md D46) and how lobby_state was found missing in Phase 4's
# live check.
#
# Constants are read from protocol.rs, not hardcoded: a new event added there is
# covered by this check the moment it exists.
#
# Known gaps are listed in ALLOW with the task that owns them, so this check
# passes today and fails the moment an UNKNOWN gap appears.
set -uo pipefail
cd "$(dirname "$0")/.."

PROTOCOL=server/game-core/src/protocol.rs
SRC=server/server/src

# name:owning-task — a gap that is disclosed, not a gap that is hidden.
declare -A ALLOW=(
  [PLAYER_JOINED]="T5.3 — lobby roster (docs/06 §2); no task before Phase 5 wires it"
  [PLAYER_LEFT]="T5.3 — lobby roster (docs/06 §2); no task before Phase 5 wires it"
  [LOBBY_STATE]="T5.3 step 2 — 'sent in joined/lobby_state'"
)

consts=$(sed -n '/^pub mod s2c {/,/^}/p' "$PROTOCOL" | sed -n 's/^ *pub const \([A-Z_]*\).*/\1/p')
[ -n "$consts" ] || { echo "FAIL: no s2c constants parsed from $PROTOCOL"; exit 1; }

fail=0
for c in $consts; do
  # Ignore matches inside line comments — a constant named in a comment is not
  # an emit site.
  n=$(grep -rn "s2c::$c" "$SRC" | grep -vc '^[^:]*:[0-9]*: *//')
  if [ "$n" -eq 0 ]; then
    if [ -n "${ALLOW[$c]:-}" ]; then
      echo "  KNOWN GAP  $c — ${ALLOW[$c]}"
    else
      echo "  NEVER SENT $c — declared in protocol.rs, no emit site in $SRC"
      fail=1
    fi
  fi
done

if [ "$fail" -eq 0 ]; then
  echo "wire coverage OK ($(echo "$consts" | wc -w) s2c events, ${#ALLOW[@]} disclosed gaps)"
else
  echo "FAIL: an s2c event has no emit site and is not a disclosed gap."
fi
exit $fail
