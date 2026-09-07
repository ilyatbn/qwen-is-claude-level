#!/usr/bin/env bash
# The tests the gate never runs.  T20.17
#
#   ./scripts/ignored.sh            run all thirteen, in release
#   ./scripts/ignored.sh --list     print the manifest and exit
#
# `scripts/check.sh` is `cargo test --workspace` with no `--release` and no
# `-- --ignored`, and there is no CI, so **nothing in this repository has ever
# run these**. `balance.rs`'s control eroded from 1/8 of margin to 0 across nine
# milestones in exactly that silence: the comment claiming the margin was the
# only record of it, and a comment is not re-validated by anything.
#
# **What it costs, measured rather than assumed: 352 s** for all thirteen on an
# idle box with the release build already warm, twice, identically. The
# `#[ignore]` reasons say "minutes in release" and "measurement: minutes"; only
# `thousand_seed_playability_sweep` is still minutes (244 s of the 352). All
# five `balance.rs` measurements together are 39 s and the two `capacity.rs` ones
# 52 s. **The cost that justified excluding them is largely no longer real** —
# what keeps this out of `check.sh` is not the six minutes, it is that these need
# `--release` and the gate builds debug, so wiring it in would add a second full
# build of the workspace to every run. A gate people avoid running gates nothing.
#
# **So this relies on somebody running it**, and that is stated plainly rather
# than dressed up: it is a milestone-boundary ritual, not a mechanism. What it
# does buy over the status quo is that it is one command with a **verdict**
# instead of five `--ignored` invocations copy-pasted out of doc comments and
# read by eye — and that `scripts/verify-repo.mjs` is in the gate and fails if a
# new `#[ignore]` is ever added without being named here.
#
# **What turns it green** is the measurements passing. There is no other way —
# unlike a companion test that pins the numbers a doc comment claims, which goes
# green again the moment somebody edits the comment. That is not hypothetical
# here: the erosion this task exists for was a *doc comment* drifting away from
# the truth while the code stayed put, and a companion pinned to the comment
# would have stayed green through all nine milestones.
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

# The manifest: NAME|WHERE|CLASS.
#
# **Names, not counts.** The survey that booked this task recorded
# `map_sweep.rs — 1` instead of the test's name, and the strongest guard in the
# set — 1000 seeds over three scales — sat unclassified for a round because a
# digit cannot be greped for, classified, or noticed as miscategorised.
#
# CLASS is `guard` if the test **can fail** and `report` if it cannot. Measured
# per body, not by counting `assert`s: `thousand_seed_playability_sweep` fails
# through `panic!` and contains no `assert` at all, while `density_report` and
# `item_population_report` are named "report" and carry four failable assertions
# and one. Ten of the thirteen are guards.
MANIFEST=(
  "thousand_seed_playability_sweep|game-core tests/map_sweep.rs|guard"
  "fifty_medium_seeds_pass_without_the_safe_preset|game-core src/map/gen/mod.rs|guard"
  "medium_generation_is_under_a_second|game-core src/map/gen/mod.rs|guard"
  "solid_fraction_sweep_medium|game-core src/map/gen/silhouette.rs|guard"
  "large_scale_generation_cost|game-core src/map/gen/silhouette.rs|guard"
  "kill_chain|game-core src/bots/mod.rs|report"
  "balance_report|game-core tests/balance.rs|report"
  "density_report|game-core tests/balance.rs|guard"
  "encounter_report|game-core tests/balance.rs|report"
  "item_population_report|game-core tests/balance.rs|guard"
  "the_shipping_configuration_produces_a_fight|game-core tests/balance.rs|guard"
  "how_many_rooms_fit|game-server tests/capacity.rs|guard"
  "rooms_do_not_get_more_expensive_as_more_are_added|game-server tests/capacity.rs|guard"
)

# Tests whose recorded verdict is not `ok`. **Empty, and that is the finding.**
#
# `the_shipping_configuration_produces_a_fight` is documented in `balance.rs` as
# knowingly red — T20.16 owns it — and **it passes at HEAD**. Measured twice,
# identically, `--release`, idle box, no assertion touched: shipping **7/8**
# against a control of **6/8**, first contact 1.3 s against a 45 s floor. The
# comment at the assertion records the control at 7/8 after T20.10's animals took
# the last seed of margin; somewhere in M20 it went back to 6/8, so the margin is
# one seed again — the same single seed the comment calls nearly-gone.
#
# **Recorded as measured, not as remembered.** Nothing here loosens
# `before_fought < fought`; that would delete the only thing stopping those
# floors passing for any configuration at all, and picking a new control is a
# balance decision. Recording `ok` means this script fires the day it goes red
# again, which is the mechanism the task exists for. Recording a stale `FAILED`
# would have shipped a runner that is red on day one and therefore ignored.
EXPECTED_RED=()

if [ "${1:-}" = "--list" ]; then
  printf '%-52s %-34s %s\n' NAME WHERE CLASS
  for row in "${MANIFEST[@]}"; do
    IFS='|' read -r name where class <<<"$row"
    printf '%-52s %-34s %s\n' "$name" "$where" "$class"
  done
  printf '\n%d tests, %d expected red\n' "${#MANIFEST[@]}" "${#EXPECTED_RED[@]}"
  exit 0
fi

LOG="${IGNORED_LOG:-$ROOT/target/ignored-run.log}"
mkdir -p "$(dirname "$LOG")"

echo "running ${#MANIFEST[@]} ignored tests in release; ~6 min once the build is warm"
echo "full output: $LOG"
# `--no-fail-fast`, paid for by this script's own falsification: without it cargo
# stops after the first failing binary, and a planted density regression left
# three manifest entries reporting DID-NOT-RUN. One red measurement must not hide
# the state of the other twelve — that is the whole complaint against the silence
# this script exists to end.
cargo test --release --workspace --no-fail-fast -- --ignored --nocapture >"$LOG" 2>&1
echo "cargo exited $?"

# Verdicts come from the harness's own lines, not from cargo's exit code: one
# expected failure would otherwise hide twelve real ones behind a single 101.
declare -A VERDICT=()
while read -r name result; do
  VERDICT["${name##*::}"]="$result"
done < <(grep -aoE '^test [A-Za-z0-9_:]+ \.\.\. (ok|FAILED)' "$LOG" \
         | sed -E 's/^test ([A-Za-z0-9_:]+) \.\.\. (ok|FAILED)$/\1 \2/')

fail=0
printf '\n%-52s %-7s %s\n' NAME CLASS VERDICT
for row in "${MANIFEST[@]}"; do
  IFS='|' read -r name where class <<<"$row"
  got="${VERDICT[$name]:-DID-NOT-RUN}"
  want=ok
  for r in "${EXPECTED_RED[@]}"; do [ "$r" = "$name" ] && want=FAILED; done
  note=""
  if [ "$got" != "$want" ]; then
    fail=1
    if [ "$got" = DID-NOT-RUN ]; then
      note="  <-- the manifest names it and the run did not reach it"
    elif [ "$want" = FAILED ]; then
      note="  <-- recorded as red and it PASSED; the recorded verdict is stale"
    else
      note="  <-- REGRESSION"
    fi
  fi
  printf '%-52s %-7s %s%s\n' "$name" "$class" "$got" "$note"
done

# Count at both ends: a run that executed tests this manifest does not name is
# as wrong as a manifest naming tests the run never reached.
for name in "${!VERDICT[@]}"; do
  known=0
  for row in "${MANIFEST[@]}"; do
    IFS='|' read -r n _ _ <<<"$row"
    [ "$n" = "$name" ] && known=1
  done
  if [ "$known" = 0 ]; then
    echo "unlisted ignored test ran: $name -- add it to the manifest and classify it"
    fail=1
  fi
done

echo
if [ "$fail" = 0 ]; then
  echo "ignored suite: as recorded (${#MANIFEST[@]} tests, ${#EXPECTED_RED[@]} recorded red)"
else
  echo "ignored suite: NOT as expected -- see the marked rows above and $LOG"
fi
exit "$fail"
