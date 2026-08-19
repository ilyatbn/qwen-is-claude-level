#!/usr/bin/env bash
#
# Injection sweep harness — the standing pre-gate check (HANDOFF-phase2.md).
#
# Reads `label|old|new` triples on stdin, applies each to a source file, runs
# the suite, reports, and reverts. Use it to answer "is this documented value
# actually guarded?" for every constant a phase touches, rather than checking
# the one a reviewer happened to name.
#
#   ./scripts/injection-sweep.sh server/game-core/src/items.rs <<'EOF'
#   pistol ammo 30->25|ammo: Some(30),|ammo: Some(25),
#   EOF
#
# Run from qwen/server (cargo needs the workspace).
#
# Output legend:
#   COMPILE  - injection does not compile => the type system is the guard
#   n        - n tests fail => guarded
#   0        - compiles, all tests pass => UNGUARDED, fix before the gate
#
# The COMPILE case matters: an earlier version keyed on /^error/, which
# `cargo test` also prints for ordinary test FAILURES ("error: test failed"),
# so every guarded injection was misreported as a compile error. Keying on
# "could not compile" is what separates the two. A harness that cannot fail
# correctly is as useless as a test that cannot fail.
file="$1"
cp "$file" /tmp/sweep.bak
while IFS='|' read -r label old new; do
  [ -z "$label" ] && continue
  python3 -c "
import sys
p='$file'; s=open(p).read()
old='''$old'''; new='''$new'''
if old not in s: print('  %-40s ANCHOR MISS' % '$label'); sys.exit(1)
open(p,'w').write(s.replace(old,new,1))" || { cp /tmp/sweep.bak "$file"; continue; }
  # WORKSPACE, not -p game-core. An earlier version tested only game-core,
  # so every injection into server/ came back UNGUARDED — the tests existed,
  # the sweep just never ran them. Third harness defect of this shape; a
  # sweep is only worth running if its negative results can be trusted.
  out=$(cargo test --workspace 2>&1)
  if echo "$out" | grep -q "could not compile"; then
    printf "  %-40s COMPILE (type system guards it)\n" "$label"
  else
    n=$(echo "$out" | grep -E "^failures:" -A60 | grep -c "^    [a-z]")
    flag=""; [ "$n" -eq 0 ] && flag="   <<< UNGUARDED"
    printf "  %-40s %s%s\n" "$label" "$n" "$flag"
  fi
  cp /tmp/sweep.bak "$file"
done
rm -f /tmp/sweep.bak
