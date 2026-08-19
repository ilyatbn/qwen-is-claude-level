#!/usr/bin/env bash
# The mirror of wire-coverage.sh, for the other direction: every event named in
# the client's `C2S` map must have an emit site in the client.
#
# wire-coverage.sh only ever checked s2c, so a CLIENT->SERVER message the client
# never sends was invisible to every gate. That is exactly how `input` shipped:
# GameScene emitted an 'input-frame' scene event, nothing forwarded it to the
# socket, and the game was unplayable -- WASD, jump, aim and fire all reached
# the server never. No unit test, no build and no headless check caught it,
# because each headless check emits on the socket itself and so bypasses the
# client's own UI path entirely.
#
# Constants are read from protocol.ts, not hardcoded.
set -uo pipefail
cd "$(dirname "$0")/.."

PROTOCOL=client/src/protocol.ts
SRC=client/src

# name:reason — a gap that is disclosed, not a gap that is hidden.
declare -A ALLOW=(
  # docs/06 §1 carries the slot press inside InputFrame.use_slot, which the
  # client does send; the standalone message is the alternative UI path.
  [USE_SLOT]="carried inside InputFrame.use_slot instead"
  # An ops/debug message (docs/05 §5), driven by tooling, not by the game UI.
  [SET_LOG_LEVEL]="ops-only, sent by scripts/log-check.mjs"
)

consts=$(sed -n '/^export const C2S = {/,/^} as const;/p' "$PROTOCOL" \
  | sed -n 's/^ *\([A-Z_]*\):.*/\1/p')
[ -n "$consts" ] || { echo "FAIL: no C2S constants parsed from $PROTOCOL"; exit 1; }

fail=0
for c in $consts; do
  # Emit sites only: exclude the protocol definition itself and the tests.
  n=$(grep -rn "C2S\.$c" "$SRC" --include=*.ts \
      | grep -v '\.test\.ts' | grep -v 'protocol\.ts' \
      | grep -vc '^[^:]*:[0-9]*: *//')
  if [ "$n" -eq 0 ]; then
    if [ -n "${ALLOW[$c]:-}" ]; then
      echo "  KNOWN GAP  $c — ${ALLOW[$c]}"
    else
      echo "  NEVER SENT $c — declared in $PROTOCOL, no emit site in $SRC"
      fail=1
    fi
  fi
done

if [ "$fail" -eq 0 ]; then
  echo "c2s coverage OK ($(echo "$consts" | wc -w) c2s events, ${#ALLOW[@]} disclosed gaps)"
else
  echo "FAIL: a c2s event has no emit site and is not a disclosed gap."
fi
exit $fail
