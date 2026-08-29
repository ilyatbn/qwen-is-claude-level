# Coordinator decisions log

Ilya is not available during this run. Where a task, the spec or a builder hit an
ambiguity, I picked the option below and kept going. **Every entry is reversible and
none is written into `docs/`.** Read the "Reverse it by" line to change one.

Entries are newest last.

---

## D-01 — Object scale is pack-mean, not per-sprite  ·  T16.01
**Decided by:** Ilya, before he went dark.
**The ambiguity:** `docs/73` §D4's *table* (0.50 / 0.63 / 0.74 / 1.24) is arithmetically
one factor per category derived from the pack mean. §D4's *prose* and T16.01's
Deliverable both say the factor derives from each sprite's own bounds. Those are
different features: per-sprite makes all 40 crystals exactly 42 px tall, which is the
outcome T16.01's own note says to avoid.
**Chosen:** pack-mean. Relative size survives — a small crystal stays small.
Ilya: *"I absolutely want them to be different sizes... just a variety of objects to
make the map more lively."*
**Consequence:** `docs/73` §D4's prose and T16.01's Deliverable are now the wrong half
of a contradiction the code does not follow. **An amendment is owed.**
**Reverse it by:** editing `scaleFor` in `scripts/lib/object-masks.mjs` — one function,
one call site, `scripts/build-object-masks.mjs:120`.

## D-02 — Sizes are tuned from four constants, nothing else  ·  T16.01
**Decided by:** me, implementing D-01.
**Why:** Ilya said he would look at the map and adjust. The category factors are
*derived* at build time from the selected sprites' measured mean, so no factor is
stored anywhere.
**Chosen:** the only size knobs are `OBJECT_TARGET_PLAYER_H_BUSH` / `_ROCK` /
`_CRYSTAL` / `_RUIN` in `crates/game-core/src/constants.rs`, in player-heights
(1.0 / 1.5 / 1.5 / 3.0 per §D4).
**Reverse it by:** change a constant, re-run `node scripts/build-object-masks.mjs`.

## D-03 — Rational nearest-neighbour, because integer is impossible  ·  T16.01
**Decided by:** me. Forced — there was no valid alternative.
**The spec defect:** `docs/73` §D2 step 4 says "scale by the category's **integer**
factor". §D4's factors are 0.50 / 0.63 / 0.74 / 1.24 — none is an integer. Truncating
to one zeroes most of every pack (bush 34/40, rock 26/40, crystal 22/40, ruin 7/40).
**Chosen:** exact `n/d` rational nearest-neighbour, `src = floor(dst * sw / dw)` in
integer arithmetic only, no float in the sampling loop. Deterministic and bit-exact,
which is what §A24 actually wants; "integer" was the wrong way to spell it.
**Consequence:** **an amendment to §D2 step 4 is owed.**

## D-04 — Ruins ship from `Assets/`  ·  T16.01
**Decided by:** me. §D0 says "ship one variant set" without saying which.
**Chosen:** `ruins/Assets/` — 40 files, soft-edge ratio 0.00.
**Why:** `Assets_shadow/` measures soft 0.24, and its own catalogue legend calls that
"a wispy edge that thresholds badly" — the worst of the four for an alpha threshold.
The other two texture variants are equivalent; `Assets/` is the plain one.
**Also:** the four top-level `Assets*_source.png` spritesheets (488×431) are excluded.
Dedup-by-basename alone leaves **44**, not 40, and sails those through as "objects".

## D-05 — §D0's ruins bounds are wrong; the code measures instead of trusting  ·  T16.01
**Spec defect, confirmed independently.** §D0 gives ruins mean bounds 68×68. That is
the mean over all **164** files — the four variant dirs §D0 itself says to discard,
plus the four 488×431 source sheets. The 40 that actually ship measure **54×57**
(`ruins/CATALOGUE.md` says so in its own `## Assets` section).
**Knock-on:** §D4's "ruin ≈ 1.24" is 84/67.8. Against the real shipping set it is
84/57.5 ≈ **1.46**.
**Chosen:** the build derives the pack mean from the sprites it actually selected, so
the right number falls out without a hardcoded correction.
**Consequence:** **an amendment to §D0's ruins row and §D4's ruin factor is owed.**

## D-06 — Clouds are eight shape families, not three  ·  T16.04
**Spec defect, confirmed independently.** T16.04 says *"Three shape families exist per
colour (`Shape1`, `Shape2`, …)"*. There are **eight** — `Clouds_black|gray|white` each
hold `Shape1`–`Shape8`, 5 sizes each: 40 shapes × 3 colours + 5 `Lightning` = the 125
files §D0 counts. §D0's "120 distinct objects" is the same variant-collapse it caught
in ruins and missed here; there are 40 distinct shapes.
**Chosen (advance ruling for T16.04):** seed the cloud pick over all **eight**
families. Reading it as three silently discards five-eighths of the variety Ilya is
paying for, and §D0's own colour-tinting rule already covers the three colours.
**Consequence:** **an amendment to T16.04 and §D0's clouds row is owed.**

## D-07 — No e2e until every task is done  ·  whole run
**Decided by:** Ilya. *"Let's stop running full blown e2e tests until you finish them
all (run only basic unit tests). After everything is finished, run e2e and fix what
broke."*
**Chosen:** `./scripts/check.sh --fast` only during the run. T16.03's
`node scripts/e2e.mjs objects` and T16.04's `node scripts/e2e.mjs living-sky` are
**deferred**, not skipped — the full gate runs once at the end and breakage gets fixed
there. Each task's journal entry records its Done-when as half-run.

## D-08 — The generated art DOES get committed  ·  T16.01, T16.05
**Decided by:** Ilya. *"All the sprite packs I've added were royalty free and unlimited
use."* That is the owner of the packs stating the terms he acquired them under, and
unlimited use covers the redistribution `docs/51` §8 cares about.
**Superseded:** I had held the art back — `../sprite_packs/` carries no licence, readme
or credit file of any kind, and it is not Kenney (`.psd` sources, folders like
`canyon_rocks`, `middle_lane_rocks1`). §D7 says the same: *"sprite_packs/ contains no
licence, readme, or credit file of any kind — I looked."*
**Chosen:** `assets/objects/masks.bin`, `assets/objects/manifest.json` and
`assets/atlas/objects.png`/`.json` are committed build outputs, like the Kenney
atlases. T16.05 records the terms below in `assets/vendor/README.md`.
**What goes in the table** — honest about what is and is not known:

| pack | source | licence | fetched |
|---|---|---|---|
| `bushes` / `clouds` / `crystals` / `rocks` / `ruins` | not recorded — supplied by the repository owner | royalty-free, unlimited use (per the owner, 2026-08-27) | 2026-08-21 (`rocks` 2026-08-23) |

**Fetch dates** are when the packs landed on this box. The **source URL is genuinely
unknown** and I will not invent one; the entry says so rather than pretending.
**Still owed by Ilya, whenever:** the origin URL of those five packs, and their
`LICENSE.txt` dropped alongside them — `docs/51` §8 asks for the file, not just the
claim, and §D7 asks for the URL. The check passes without them; the paperwork is
still short.
**Reverse it by:** editing the rows in `assets/vendor/README.md`.

## D-09 — `docs/51` §8's sibling-directory ban does not apply to `sprite_packs`  ·  T16.01, T16.05
**Decided by:** me, on the review's challenge.
**The conflict:** `docs/51` §8 last bullet: *"No asset is taken from any folder outside
this project, including sibling directories on this machine."* The whole of M16 reads
`../sprite_packs`, a sibling directory.
**Chosen:** it is superseded, twice over. `CLAUDE.md:37` names `../sprite_packs`
explicitly as *"an input the coordinator has approved"*, and `docs/73` is a v5
amendment — which per `CLAUDE.md` overrides the originals — built entirely on it.
Combined with Ilya's licence statement (D-08), the generated art commits.
`include_bytes!("../../../../assets/objects/masks.bin")` stays; holding the blob back
would break the build for everyone.
**Consequence:** `docs/51` §8's last bullet is stale. **An amendment is owed** — a
sentence exempting coordinator-approved inputs.

## D-10 — `flip` comes off the manifest  ·  T16.01, T16.02
**Decided by:** me.
**Why:** it was `true` on all 160 rows. A column that never varies carries no
information, and "flip" on a *table* row is ambiguous between capability ("may be
mirrored") and state ("is mirrored") — the two-meanings bug `CLAUDE.md` warns about.
§D4's *"store it as a flag, do not bake two masks"* is about not baking a second
bitmask; the flag belongs on the **placement**, which is T16.02's.
**Chosen:** dropped from `assets/objects/manifest.json`. `ObjectMask::solid_flipped`
stays — that is the API T16.02 calls.

## D-11 — Builders run clippy before claiming the gate is green  ·  whole run
**Decided by:** me, after it bit.
**What happened:** the coder reported T16.01 green under `./scripts/check.sh --fast`.
It was red — `--fast` **skips clippy**, and `objects.rs:135` had a
`clippy::manual-div-ceil` that `-D warnings` turns into a build failure. A typecheck
error (TS6133) was in the same tree.
**Chosen:** D-07 defers the *browser* steps, not the static ones. Builders run the
full gate minus its browser steps and paste it:
```sh
cargo fmt --all -- --check && cargo clippy --all-targets --all-features -- -D warnings \
  && cargo test --workspace && npm --prefix client run typecheck \
  && npm --prefix client test -- --run
```
`--fast` is for the edit loop only, never for a done-report.

## D-12 — Small maps are over-subscribed at `OBJECT_COUNT` 18  ·  T16.02
**Spec defect, measured.** §D5's table gives Small 18 objects. With
`OBJECT_CLEAR_OF_SPAWN` at 96 px on a 2048×1024 map that blankets the surface:
**112 of 333 Small seeds fail the 999-seed sweep**, 5 reach the safe preset, and one
finishes with 5 spawns. Measured cause — spawn candidates surviving the clearance
filter, 200 seeds per scale:

| scale | seeds that cannot seat 6 spawns after the filter | before the filter |
|---|---|---|
| Small | 64/200 | 0/200 |
| Medium | 5/200 | 0/200 |
| Large | 4/200 | 0/200 |

A Small map yields ~50–70 standable candidates at `SURFACE_SAMPLE_STEP` 16; 6 spawns
at `SPAWN_MIN_SEPARATION` 256 do not come out of the 6–7 that survive. Medium and
Large have 2–3× the candidates for 1.7–2.7× the objects and absorb it.
**Chosen:** lower Small's `object_count`, to a value **measured** — sweep Small at
18/15/12/10/8 and take the largest that sits alongside Medium and Large on attempts
and safe-preset rate. Liveliness is the point of the feature; do not over-correct into
an empty map.
**Rejected:** lowering `OBJECT_CLEAR_OF_SPAWN` (96 px is the guarantee that you do not
spawn against a rock — not tradeable for scenery), and lowering
`SURFACE_SAMPLE_STEP` (it feeds decorations, items and spawns; not this task's to
move).
**Consequence:** **an amendment to §D5's `OBJECT_COUNT` row is owed**, with the
measured number.
**Reverse it by:** `object_count` in the `ScaleParams` table, `constants.rs`.

## D-13 — Clearance is enforced at validation, not at stamp time  ·  T16.02
**Decided by:** the coder, ratified by me.
**Why:** §D3 puts 6b before pass 8, so when objects are placed **no spawn or pad
exists yet to avoid**. The clearance moved into `traversal.rs:272`, which already
counts separated spawn candidates, so a map whose objects blanket its surface now
**fails validation and retries** through the existing loop.
**What it replaced:** pass 8 quietly returning five spawns. That is why D-12's numbers
read as "attempts spent" rather than "shipped broken".
**Side effect on tests:** T16.02's named test *"no object overlaps a spawn point or
pad within `OBJECT_CLEAR_OF_SPAWN`"* now exercises the **spawn chooser**, not the
object placer, and would pass trivially if the chooser merely had fewer candidates —
so it carries a control asserting the filter is not the identity and that 6 spawns +
6 pads still seat.

## D-14 — WITHDRAWN: the molotov predictor gap was a stale measurement  ·  T16.02
**Reported, then disproved.** The coder measured `thrown.rs:515` failing by 20.0 px
against a 15.8 px tolerance and — correctly — refused to widen the tolerance. The
review then ran that test alone in release and debug and the whole file: **green,
15/15.** The measurement predated the `masks.bin` v1→v2 bump (D-16), which moved every
object and therefore moved where the throw lands.
**Chosen:** no investigation, no code change, no tolerance movement. The finding is
kept here because "revert what you cannot explain" cuts both ways — a defect reported
against a tree that no longer exists is not a defect, and the record should say so
rather than leaving a phantom for the next reader.
**The real red was elsewhere:** `world::fire_gate::firing_one_tick_after_releasing_the_key_is_still_refused`
— a **third** map-pinned fixture, caught by its own vacuity guard. `world/mod.rs:3426`
counts `walk_for(20)` then asserts the player is above `FIRE_MOVE_MAX_SPEED`; spawn 0
moved and twenty ticks no longer reach walk speed there. Fixed by waiting on the
velocity with a cap instead of counting ticks — the pattern already written thirty
lines below in the same test. `cargo test` fail-fasts on `game-core --lib`, which is
why the coder's "866 passed, 1 failed" was not the whole picture either.
**Lesson worth keeping:** three fixtures in this task expired because they were pinned
to a map that moved. A wait hardcoded against a tunable is a test that expires — and
so is a fixture hardcoded against a generated world.

## D-15 — T16.02 should have been two tasks  ·  process
**Noted, not acted on.** ~700 lines against the task file's ~220 guide. The overrun is
real and is the clearance work: it turned out to touch validation, pass 8 and the
spawn chooser, not just the stamp, plus a `masks.bin` format bump.
**Chosen:** landed as one. The work is done and coherent; re-cutting it would cost more
than it buys. The split line, for whoever plans the next milestone:
**6b + placement + budget** | **clearance + validation + the sweep**.

## D-16 — `masks.bin` is version 2  ·  T16.01, T16.02
**Decided by:** me, ratifying the coder.
**Why:** §D5 weights categories by theme, so the placer needs each object's category
**server-side**, and `game-core` has no JSON parser — the manifest is client-side art.
**Chosen:** a category byte per record, 24-byte records. Guarded by a vitest test that
reads the discriminants out of `ObjectCategory` and asserts JS `CATEGORY_ORDER` matches
position for position — §B16 in a new place.
**Note:** T16.01 shipped v1 in `dd3820a`. Anyone holding a v1 blob must rebuild.

## D-17 — `clear_of_objects` becomes one shared function  ·  T16.02
**Decided by:** me, on the review's finding.
**The problem:** the clearance guard was written three times — `traversal.rs:286-296`
with no fallback, `meta.rs:360-378` with a fallback to the unfiltered component when
`kept.len() < SPAWN_COUNT_MIN`, and a third hand-rolled squared-distance copy inside
the test at `meta.rs:546`. The two production copies **disagree on the fallback**.
**Why it is benign today:** if validation passed then `count_separated(clear, 256) >= 6`,
which implies `kept.len() >= 6`, so meta's fallback is unreachable on the happy path.
It fires only on the safe-preset path, where accepting a spawn beside a bush genuinely
beats shipping a map with five spawns.
**Why it still gets fixed:** the *next* edit — someone changing clearance to measure
edge-to-edge — lands in one copy, and the disagreement surfaces as spawns-inside-rocks
on the rarest path and the hardest to notice. `CLAUDE.md`: *share the guard, or share
the function.*
**Chosen:** one function, called from both, with the fallback as an explicit parameter,
plus a direct test of `analyse`'s clearance branch — all eleven of its current call
sites pass `&[]` and short-circuit, so the copy that decides whether a map is
**rejected** is exercised only indirectly.

## D-18 — What the golden table actually proves  ·  T16.02
**Noted, no code change.** All 24 golden rows moved on both hashes, v1 12/12 and
v2 12/12 — so 6b runs in both generators and the silent-no-op did not happen.
**But:** `meta_digest` now hashes `objects.len()` unconditionally, so **all 24 meta
digests would have moved even if 6b had placed nothing.** The 24 changed **mask
hashes** are the evidence that objects exist; the meta digests are not.
**Why it is recorded:** a future reader seeing "48/48 changed" will over-read it. Half
that number is a tautology.

## D-19 — Small `OBJECT_COUNT` is 12, measured  ·  T16.02
**Resolves D-12.** 333 Small seeds swept at each candidate:

| count | failed | attempts[1..5] | safe preset | smallest pool | mean placed |
|---|---|---|---|---|---|
| 18 (§D5) | 103 | 103, 69, 58, 35, 26 | 5 | 6 | 17.3 |
| 15 | 26 | 209, 72, 26, 16, 6 | 0 | 9 | 14.9 |
| **12** | **0** | **283, 46, 4, 0, 0** | **0** | **13** | **12.0** |
| 10 | 0 | 320, 13, 0, 0, 0 | 0 | 14 | 10.0 |
| 8 | 0 | 330, 3, 0, 0, 0 | 0 | 14 | 8.0 |

Medium `[301, 29, 3, 0]` and Large `[297, 28, 5, 3]` — Large itself has 3 failing seeds.
**Chosen: 12.** Largest count that sits alongside Medium and Large, and cleaner than
Large. Going lower buys attempts nobody was short of and costs the liveliness the
feature exists for. `OBJECT_CLEAR_OF_SPAWN` and `SURFACE_SAMPLE_STEP` untouched, as
D-12 required. The table is written into the `object_count` doc comment so the next
reader sees the measurement and not just the number.
**Consequence:** **an amendment to §D5 is owed** — Small is 12, not 18. Medium 30 and
Large 48 are §D5's own numbers and measure clean.
**Reverse it by:** `object_count` in the `ScaleParams` table, `constants.rs`.

## D-20 — The replay verifier localises divergence; it does not catch every perturbation  ·  T16.02
**Spec gap, and a fixture that was green by luck.**
`crates/game-server/tests/replay_run.rs:401`
`a_perturbed_command_is_localised_to_a_nearby_tick` flips one recorded input byte and
requires the replay to exit non-zero. On the new map it does not: measured, the same
unique offset, a genuine full LEFT→RIGHT reversal, **no longer diverges the tick-1200
checkpoint**, and moving it 600 ticks earlier to compound still verifies clean.
**Why that is correct behaviour:** a bot corrects its own course, so a one-tick input
reversal washes out. Whether it survives to the next checkpoint is a property of the
terrain the bot is standing on. The old fixture conflated *"divergence is detectable"*
with *"this particular byte diverges"*, and only the first is a real guarantee.
**Chosen:** assert the guarantee that exists. Perturb a **spread** of commands, assert
**at least one diverges** as the control, assert localisation for each that does, and
record the washed-out ones as a number rather than a failure. Making it bite the old
way would need a run of consecutive inputs, which contradicts the test's own name.
**Two hardenings folded in, neither biting today, both one map away:**
- `^= LEFT | RIGHT` is a **silent no-op** on an input holding neither direction — a
  corruption that corrupts nothing is the same vacuity trap as the rest of this task.
  The byte is now asserted to have changed before the replay runs.
- The offset came from an **unanchored byte search** that would have corrupted an
  identical earlier input if one existed. Anchored to the intended command index.
**Consequence:** **an amendment is owed** — `docs` nowhere says whether the verifier is
meant to catch every perturbation or only to localise the ones that diverge. We ship
the second; the first is not achievable against a self-correcting AI and never was.

## D-21 — Six fixtures in one task were pinned to a map that moved  ·  process
**Pattern, worth its own entry.** T16.02 changed generated terrain, and six tests broke
that had nothing to do with objects:
`spawning.rs:494` (hardcoded `800 < x < 2000` window) · `world/mod.rs a_bullet_kills_a_bird`
(bird planted at `me.x + 200`, outside a 2048-wide world once spawn 0 moved to x=1968)
· `fire_gate` (counted `walk_for(20)` instead of waiting on velocity) ·
`a_drop_is_refused_at_max_and_stays_on_the_ground` (read a counter that only says *an*
item was taken) · `a_bot_stuck_on_a_flat_laser_still_fights` (one seed) ·
`replay_run.rs:401` (D-20).
**The shared cause:** each hardcoded a fact about a *generated* world — a coordinate, a
tick count, a single seed — rather than waiting on the condition it actually meant.
`CLAUDE.md` already says *"a wait hardcoded against a tunable is a test that expires."*
**So does a fixture hardcoded against a generated map**, and that is the sentence this
project paid for here. Four of the six were caught only by their own vacuity guards;
without those they would have passed while testing nothing.

## D-22 — Large `OBJECT_COUNT` is 36, and §D5 is wrong for two scales of three  ·  T16.02
**Extends D-19.** The Large failures were **new**, not pre-existing — baseline measured
at `dd3820a`, stashed and restored: `Small [0,333,0,0,0] Medium [0,333,0,0,0]
Large [0,323,10,0,0]`, exit 0, `safe_preset` 0 everywhere.

| count | failed | attempts[1..5] | safe preset | smallest pool | fraction min |
|---|---|---|---|---|---|
| 48 (§D5) | 3 | 297, 28, 5, 3, 0 | 0 | 8 | 0.761 |
| 40 | 1 | 323, 9, 0, 1, 0 | 0 | 12 | 0.754 |
| **36** | **0** | **325, 8, 0, 0, 0** | **0** | **14** | **0.751** |
| 32 | 0 | 323, 10, 0, 0, 0 | 0 | 26 | 0.773 |

**Chosen: 36** — largest clean, and it lands back on the baseline's own distribution.
No threshold moved. Verified independently by the reviewer at exit 0.
**Consequence:** §D5's `OBJECT_COUNT` row is wrong for **two of three scales** —
Small 18 → 12, Large 48 → 36. Medium's 30 measures clean. **An amendment is owed**;
the measurement tables live inline in `constants.rs` beside each number.

## D-23 — The safe preset ships without re-validating  ·  pre-existing, not introduced here
**Found while checking whether `fraction min = 0.751` is a margin or a bug.** It is a
margin, but not for the reason first given. The claim was *"validation rejects anything
under `MIN_TRAVERSABLE_FRACTION` and retries, so `fraction >= 0.75` holds by
construction for any map that ships."* That is **false in general**:
`v2/mod.rs:146-151` (and `gen/mod.rs:146-150`, identical) returns the safe-preset
outcome **unconditionally** — `passed` is never consulted on that path.
**Why 0.751 is still fine:** `safe_preset = 0` across all 999 seeds, so no map in the
sweep took that path, and the sweep independently fails any seed under the fraction
floor *and* any seed that used the safe preset. Two assertions, both green.
**So:** the floor is held by the sweep's assertions, not by the generator's control
flow. This is `docs/10` §7d as designed — *"a duller but reliably connected map"*,
reliably rather than verifiably — and predates M16.
**Recorded so nobody later reads 0.751 as structurally safe.** Objects did push the
accepted tail down: Large 0.783 → 0.751, Small 0.807 → 0.772.

## D-24 — The replay divergence floor will need moving again  ·  T16.02, prediction
**Not a defect; a prediction, so the next person is not surprised.**
`a_perturbed_command_is_localised_to_a_nearby_tick` now asserts `diverged >= 3` against
a measured **4 of 12**, margin **1**.
**It is not a coin flip.** Everything feeding that number is deterministic: the round
is driven synchronously with a button pattern that is a pure function of the tick,
candidate selection is `step_by(stride).take(12)`, `perturb_buttons` is pure, and the
verifier re-simulates from the same seed. Three consecutive runs, identical. The split
is **structural, not random** — the eight wash-outs are the eight *consecutive
earliest* candidates and the four that diverge are the four latest, an ordered boundary
whose position is how long a bot takes to re-converge before the next checkpoint.
**The catch:** that boundary's position is a property of the terrain — which is exactly
what moved this fixture in the first place (D-21). T16.03 renders without touching the
mask so it should be safe, but the next change that moves the map moves this boundary,
and at 3/12 it sits exactly on the floor with the next step red.
**Cheap hardening when it next bites:** sample more than 12, or bias the sample toward
the late candidates — the property asserted is *localisation*, and the early ticks
contribute nothing but wash-outs.

## D-25 — CORRECTED: the spec was right, the code had drifted  ·  T16.03
**First reading, wrong:** I recorded that `docs/12` §2 and §D6 describe a
`destination-in` the shipped bake did not have, and told the coder to aim the
falsification at the `source-in` at `chunkBake.ts:150` instead. **That was backwards.**
**What is actually true:** the spec was right and the *implementation* had drifted from
it. The old `stencil` → `source-in` → `fill` clips **one** layer correctly and **cannot
clip two** — `source-in` keeps only where the *new* drawing lands, so objects composited
that way would have erased the rock everywhere they are not. My instruction to draw
objects "inside the `body` scratch while `source-in` is still in effect" was that exact
bug.
**What shipped:** `chunkBake.ts:165-175` now reads fill → objects → `destination-in`
with the stencil, which is what `docs/12` §2 and §D6 say. The falsification target is
the `destination-in` at `chunkBake.ts:173`.
**No amendment owed** — the reverse of what I first wrote. And the step-0 concern does
not apply: objects go into the `body` scratch while the cave backdrop is composited
onto `ctx`, so an object over a cave mouth cannot show art where the mask is air.
**Kept as a correction rather than deleted:** a coordinator ruling that would have
produced a wrong composite is worth more on the record than off it.

## D-26 — T16.03's payoff is asserted in e2e, and its unit half does not prove it  ·  T16.03
**Decided by:** me, and it is a cost, not a win.
**The constraint:** `client/vite.config.ts:46` is `environment: 'node'`.
`chunkBake.test.ts` covers only the pure bit functions in `chunkBake-math.ts`;
`bakeChunk` cannot run there at all, because `BakeScratch` calls
`document.createElement('canvas')`. No client test uses a canvas today. So T16.03's
headline assertion — *carve half an object, its art vanishes in the carved half and
survives in the other* — **cannot be written under vitest as it stands.**
**Rejected:** adding a canvas implementation to vitest. A node rasterizer would prove
something about node-canvas, not about Chrome, and `docs/72` §C2 requires rendered
pixels in the real thing for anything visible. This is the most visible claim in M16.
**Chosen:** the carve-half assertion lives in `node scripts/e2e.mjs objects`, **written
now and unrun**, with a control region, a control frame, both halves asserted in the
same test, and the falsification aimed at `source-in` (D-25). It runs in the
end-of-M16 sweep per D-07.
**What this costs, stated plainly:** a green
`npm --prefix client test -- --run chunkBake` **does not prove T16.03's central
claim.** It proves the chunk→object index and the bit math. The claim that destruction
takes the art with it is unverified until the sweep. Anyone reading that green as proof
of the payoff is reading it wrong.
**Related trap:** `terrain.ts:135-152` injects `deps?.createCanvas` and `deps?.bake`.
A test that injects a fake `bake` proves **scheduling**, never drawing.

## D-27 — §D8 is wrong: objects do go on the wire  ·  T16.03
**Spec defect.** §D8: *"No new entity type on the wire… The only new data is the
manifest, which is client-side art."* An object section in `map_init` is new wire data.
**Why there was no alternative:** §D6 requires a chunk→object index; the client cannot
build one without knowing which sprite is where; and deriving it client-side would
break §D2's *"only the server stamps"* — the one rule that stops server and client
disagreeing about the map.
**Chosen:** an object section in `map_init`, `OBJECT_WIRE_BYTES = 11` named once and
used by **both** the writer's size hint and the reader's skip — which also fixes the
decoration section that spelled `7` twice.
**Consequence:** **an amendment to §D8 is owed**, before someone reads it and deletes
the section.

## D-28 — `lastBakeMs` timed four chunks while its name said one  ·  T16.03
**Instrument bug, found before its first use.** `terrain.ts:352-363` started a clock,
baked up to `CHUNK_REBAKE_BUDGET` (4) chunks in a loop, and stored the **total** as
`lastBakeMs`. The new e2e check compared that total against `CHUNK_REBAKE_MS` — a
**one-chunk** ceiling from `docs/60` §6 — and printed it as *"worst single rebake"*.
Up to 4× stricter than the spec states, reporting a different quantity from the one it
names. `CLAUDE.md`: *the instrument is often the bug.*
**Chosen:** each `deps.bake` call is timed individually and `lastBakeMs` keeps the max
single bake. The old quantity survives as `frameBakeMs` — it is the honest per-frame
cost and the debug HUD may want it. **A field that meant two things became two fields.**
**And the gate moved off the max.** `docs/60` §6's ceilings are explicitly generous
*"so a 50× regression is caught and normal variance is not"*; a max-of-40 wall-clock in
a browser on a loaded box is decided by one GC pause. Gates on the **median** of 40,
reports the max. The instrument guard stays and now fires on an empty sample set rather
than a zero max — a zero that reads as "fast" is the worse failure.
**Also:** `CHUNK_REBAKE_BUDGET`'s doc now points at `CHUNK_REBAKE_MS`. Both are 4 and
they mean nothing alike.

## D-29 — A seam check that reported `ok` without asserting anything  ·  T16.03
**Caught before its first run.** `scripts/checks/objects.mjs:190` called
`ok('no object spans a chunk boundary on this seed — seam case not exercised')` —
**green output for an assertion that did not run.** On a pinned seed that is
deterministic: it either always runs or never does, and nobody knew which, because the
check has never executed.
**Measured off the placement pass, no browser needed:**

| seed / scale | objects | span a vertical seam | horizontal |
|---|---|---|---|
| 4242 / Small | 12 | 5 | 3 |
| 31337 / Small | 12 | **0** | 2 |
| 1 / Small | 12 | 2 | 0 |

So on the pinned seed the branch would **always** have run and the skip was dead code —
but `31337/Small` is exactly the silent-skip case, one seed change away.
**Chosen:** the skip is now `fail`, and the precondition is guarded where the *fast*
gate can see it — `seed_4242_small_has_an_object_across_a_chunk_seam` in
`map/gen/objects.rs`. A drift in generation now breaks `cargo test` instead of quietly
stripping §D6's seam coverage from a browser check nobody has run.

## D-30 — What T16.03's green gate does and does not prove  ·  T16.03
**Stated here because it is the most misreadable green in this project.**
`chunkBake.test.ts` imports from `./chunkBake-math` and `./objects`. **It never imports
`./chunkBake`.** The only importer of `bakeChunk` in the whole client is `terrain.ts`,
production. Those tests would pass identically with `bakeChunk` deleted.
So the bake was rewritten — `copy`/`source-in` → `source-over`/`clearRect`/
`destination-in`, plus a new object draw inserted mid-sequence — and **not one line of
that composite path has been executed by anything that has run.**
**What the green gate proves:** the chunk→object index, the wire encoding on both sides,
and the geometry of the draw calls — the arguments, never the picture.
**What it does not prove:** that a single object pixel reaches the screen, or disappears
with a carve. That is `scripts/checks/objects.mjs`, written and never executed. Its
first run is the M16 e2e sweep.
**The artifact was honest and the summary was not** — `chunkBake.test.ts:396-403` says
this in the file itself, unprompted, and the report upgraded it. Recorded because that
is the direction that misleads.

## D-31 — The provenance record was never in the repository  ·  T16.05
**Found while writing T16.05.** `docs/73` §D7 and T16.05 both say to record provenance
in `assets/vendor/README.md`. That directory is gitignored (§A29), and
`git ls-files claude/assets/vendor/` returned **nothing** — the README was untracked.
A licensing record that exists on one machine and nowhere else records nothing, and
`docs/51` §8 is about what is *in the repository*.
**Chosen:** ignore the **contents**, not the directory —
```
assets/vendor/*
!assets/vendor/README.md
```
`assets/vendor/` would have made the negation unreachable: git does not descend into an
excluded directory, so the README would have stayed untracked while the change looked
like a fix. Verified both ways — `git add --dry-run` accepts the README,
`assets/vendor/kenney` is still ignored.
**Consequence:** **an amendment is owed** — §A29 and §D7 disagree, and §D7 loses.

## D-32 — The missing `LICENSE.txt` is recorded, not gated on  ·  T16.05
**Decided by:** me, and it is a judgement call rather than a forced move.
`docs/51` §8 wants each vendored pack's `LICENSE.txt` alongside its files. **No sprite
pack has one** — §D7 says so itself: *"`sprite_packs/` contains no licence, readme, or
credit file of any kind — I looked."* Ilya's statement (D-08) is what stands in for it.
**Chosen:** `verify-assets.mjs` fails on a missing **README entry** — T16.05's stated
requirement — and the README records the two gaps explicitly: no `LICENSE.txt`, and the
source URL unknown and written as unknown rather than guessed.
**Rejected:** failing the gate on the missing licence files. No builder can produce
them, so that gate could never go green, and a gate that can never pass gets deleted or
bypassed by the next person — worse than a gap somebody can read.
**What Ilya can close in one edit:** the origin URL of the five packs, and their licence
files dropped in beside them.

## D-33 — §8's "CC0 only" bullet does not cover these packs, and that is named  ·  T16.05
**Raised by the review, and it is right.** `docs/51` §8 opens with *"Only CC0 or
explicitly-public-domain art enters this repo."* Ilya's **royalty-free / unlimited use**
(D-08) is neither. D-09 ruled §8's *sibling-directory* bullet stale; the CC0 bullet is a
separate sentence and was still standing over a green gate.
**Chosen:** the art stays. It is the owner of the packs stating the terms he acquired
them under, for art he supplied himself, and unlimited use covers the redistribution §8
exists to protect against. **An amendment is owed** — §8 needs to admit a
coordinator-supplied licence class, or say plainly that it does not.
**Recorded in `assets/vendor/README.md` as well as here**, because the README is the
artefact an auditor actually reads, and a conflict that needs a second file to explain
it will be found the hard way.

## D-34 — A row is not a record  ·  T16.05
**Review finding on my own work, and a fair one.** The first version of the check
matched `` | `rocks` | `` and stopped. A row reading `` | `rocks` | | | | `` — name
present, every other cell blank — **passed**, while the message the check would
otherwise print says *"record its source, licence and fetch date"*. It tested the
intention and not the effect.
**Chosen:** `incompleteProvenance` requires source, licence and fetch date to be
non-empty, with its own falsification: gut a row's cells and the missing-entry check
still passes it while the completeness check names it. **"not recorded" stays a
legitimate source** — a known gap is a record; an empty cell is indistinguishable from
nobody having looked.
**Also closed:** the provenance block was guarded by *"is there an object manifest"*,
which could not tell "no vendored objects" from "someone deleted the manifest" — and
`verify-assets.mjs` is the only thing in front of the art commit. It now cross-checks:
`assets/manifest.json` shipping the `objects` atlas with no `assets/objects/manifest.json`
beside it is a problem, not a silence.

## D-35 — Three more holes in my own provenance check  ·  T16.05
All three raised by the review, all three real, all three fixed.

**1. A Kenney row could vouch for a same-named sprite pack.** `packsInReadme` scanned
every table in the file, and the README holds **two provenance domains in one
namespace** — CC0 Kenney packs fetched by script, and owner-supplied `sprite_packs`.
Nothing collides today, but Kenney ships rock packs: a `rocks` row in the Kenney table
would have recorded *"CC0 by Kenney"* as the licence for art that is neither.
**Fixed:** row scanning is scoped to the `## Sprite packs` heading, with a test that the
Kenney half of the README yields **zero** packs.

**2. `clouds` was committed art the check had nothing to say about.** The required list
came from `assets/objects/manifest.json`, which excludes clouds by design (§D0 routes
them to the sky). T16.04 commits `assets/atlas/clouds.png` from `../sprite_packs/clouds`
through a **second pipeline**, and deleting its README row would have gone unnoticed.
The gate would have covered the art it was written for and stayed silent about the art
the next task was committing.
**Fixed:** `packsInManifest` takes the union of the object manifest's packs and a
`vendorPacks` array on `assets/manifest.json`. Any build script that consumes a sprite
pack declares it there; `build-cloud-atlas.mjs` declares `clouds`.

**3. Nothing tested `verify-assets.mjs` itself.** Eleven tests exercised the predicate;
the script's `existsSync` branches, its missing-README branch, the loop that pushes one
problem line per pack, and its exit code were covered by nothing. Change the loop to
compute the list and forget to push it and every test still passed while the gate went
permanently green — *a test calling the function is not a caller*, one layer up. I had
verified it by hand, which is evidence that exists only in a message.
**Fixed:** a test that copies `assets/` and `scripts/` to a temp dir, symlinks `client`
beside them (the script resolves `pngjs` through `client/package.json` and would
otherwise die on an import, and an exit code from the wrong failure proves nothing),
strips one row, and asserts the script exits non-zero **naming that pack** — with a
**control run on the unedited copy asserting exit 0**.

## D-36 — The e2e sweep: ten regressions, every one a fixture  ·  M16
**The result of the run Ilya asked for.** 39 checks; ten failed. Baselined at `f1d2d2a`
with the six pre-existing `scripts/checks/` edits applied on top, so **M16 was the only
variable** — all ten passed there. Every one was repaired **in the checks**:
**not one line of product code changed.** That is the strongest possible evidence that
M16's product changes were sound and the failures were the fixtures' assumptions.

| check | what it assumed | repair |
|---|---|---|
| `terrain-render` | the *first* legal target, not the rockiest | score every candidate on the quantity the assertion judges |
| `sky` | the band sits in one fixed strip | search y as well as x |
| `living-sky` | the ridge band is unoccluded | carve a window through the foreground |
| `night-combat` | a fixed aim offset is clear | probe the mask for the longest clear lane |
| `crates` | a pinned crate is reachable | probe the lane, name the obstruction |
| `quick-throw` | the inventory premise, then raced it | drain until empty; the drain's last press *is* the control |
| `objects` | world coords could be sampled as screen coords | `toScreen`, promoted into `pixels.mjs` |
| `void` | the spawn sits on the diggable crust | dig *beside*, wait out `ASSIST_WINDOW`, walk in |
| `ordnance` | (looked like an obstructed lane) | it was not — see D-38 |
| `birds` | a bird's *centre* on screen means its *patch* is on screen | select a bird whose whole patch fits |
| `no-dev-surface` | — | not a defect: a starved build during a killed sweep |

**`objects` proved §D1 for the first time** — carved half moved 11.6, untouched half 0.2,
ground-noise control **0.00**, a 55× ratio. Rebake median 0.90 ms, max 1.50 ms over 40
samples against `docs/60` §6's 4 ms. The claim this milestone rests on, written three
commits earlier and never executed until the sweep.

## D-37 — Vertical self-excavation is bounded by self-damage  ·  finding, `docs/21` §5
**A statement about the game, not the harness.** Measured while repairing `void`:
- A rocket at your own feet costs **~25 health** (100 → 75 → 50 → 25) and carves ~42 px,
  so a solo player can dig **about four rockets — ~169 px — before the fifth kills them.**
- `DEV_LOADOUT` grants exactly four and is a **boolean** at `config.rs:254`, not a count.
- **Mines cannot close the gap.** `weapons/placed.rs:3` detonates for a player *other than
  the owner*, so a mine at your own feet is inert — placed two on seed 7, neither health
  nor rock moved. (I had ruled the opposite; the coder tested rather than took my word.)
- **Any death from a self-dug shaft is credited to the rocket, not the void**, because
  the hole opens underneath you and you fall inside `ASSIST_WINDOW`. That is the clause a
  designer would actually want, and it is why `void` digs *beside* and walks in.
**An amendment to `docs/21` §5 is owed.** Nothing in `docs/` was edited.

## D-38 — Twice this sweep the obvious diagnosis was wrong  ·  method
Recorded because the pattern is the lesson, not either instance.
- **`ordnance`** looked exactly like `night-combat`'s obstructed lane — a bazooka that
  never reaches the mine, four rockets spent, *"the stack is empty"*. The lane probe read
  `blocked: false` **every shot**. The real cause: `approachMine` had a *maximum* distance
  and no *minimum*, so it walked the player **onto** the mine, and a rocket fired one
  pixel away detonates on the muzzle instead of travelling. Fixed with a `STANDOFF` of
  `PLAYER_W * 2` — room to leave, still inside `BAZOOKA_BLAST_RADIUS`.
- **`terrain-render`** looked like the composite rewrite D-30 warned had never executed.
  Reverting `chunkBake.ts` to the old `source-in` block still failed. It was the target
  selection.
**Both were settled by measuring the thing itself rather than reasoning from the symptom.**

## D-39 — Three harness traps that cost real time  ·  method
- **`pgrep -f "node scripts/e2e.mjs"` matches its own waiter.** A poll loop that always
  sees itself never fires — the `undefined <= undefined` shape, a condition that can never
  be false. Cost 53 minutes, twice in one session. Match the binary, or the log's mtime.
- **Replaying a whole working tree onto a commit that predates half of it always
  conflicts.** Check out the pristine baseline and restore *only* the protected files'
  edits. That is what keeps "M16 is the only variable" true.
- **Probe deterministic things in Rust, not the browser.** 30 seeds of map generation in
  seconds instead of 30 browser runs. The next person will reach for the browser.

## D-40 — The frame moves now  ·  T16.04, consequence
T16.04's cloud **sprites drift** where T15.03's procedural blob was flatter, so a
screenshot's "static background" is no longer static. This is what made `birds`' control
region legitimately read 8.0 while its clipped subject read 6.5 — the control was working
and the subject was broken. **Any check comparing a subject against a background it
assumes is still must account for cloud drift**, or it will read its own weather as signal.

## D-41 — The six pre-existing `FIXED_SEED` edits are committed  ·  housekeeping
**Decided by:** me. They were uncommitted and unjournaled when this session began,
predating `dd3820a` — a previous session pinning `FIXED_SEED` in `death`, `debug-mode`,
`hud-bars`, `ordnance`, `quick-throw` and `teleport` so those checks stop drawing a new
map every run. I left them untouched and unstaged through all five tasks, on the
principle that work I did not do is not mine to land.
**Why they land now:** the sweep validated them. `ordnance`'s baseline run proved the
edits are **not load-bearing on their own** (D-36's method: with them applied and M16
absent, the check passes), and the final gate is green with them in. Two of the six —
`ordnance` and `quick-throw` — carry this round's repairs as well and cannot be
separated. Leaving finished, now-verified work dangling in a dirty tree indefinitely is
the worse outcome; a reader can see them in this commit rather than wondering why
`git status` was never clean.
**If Ilya wanted them held back**, they are one `git revert` of the four purely
pre-existing files away.

## D-42 — `include_bytes!` made an art file a build input, and only Docker noticed  ·  T16.01
**`make docker-up` failed on `2ab583a`.**
```
error: couldn't read `crates/game-core/src/map/../../../../assets/objects/masks.bin`
  --> crates/game-core/src/map/objects.rs:20:22
```
`docker/Dockerfile.server` copies `crates` and not `assets`, which was correct until
T16.01 embedded the object masks with `include_bytes!` (§D2, so the pure crate reads its
own art with no `std::fs`). From that commit the blob is a **build input for the server**
even though it is art, and `Dockerfile.client` has the same problem via `game-wasm`'s
dependency on `game-core`.
**Why nothing caught it:** every other build in this project runs from a checkout that
already has `assets/`. `./scripts/check.sh` never builds an image, so the gate was green
across five commits while the container build was broken.
**Fixed:** both Dockerfiles copy `assets/objects/masks.bin` before their cargo/wasm step.

**A second, separate break behind it.** With the server building, the client image then
failed `tsc --noEmit` with ~40 `TS7006 implicit any` and `TS2307 cannot find module` —
because the build stage copied `scripts/wasm-build.mjs` alone, while several client tests
import a build script across the boundary for its `.d.mts` types (the mask pipeline, the
cloud atlas, T16.05's provenance check). The imports resolved to `any` and `strict` did
exactly its job. **Fixed by copying the whole `scripts` tree** rather than cherry-picking:
the file-by-file version broke every time a test reached for a new script, and the
breakage presented as `strict` rejecting `any` rather than as a missing `COPY`. It is a
discarded build stage, so the cost is nothing.
**Verified:** `make docker-up` builds both images, server healthy, client serving 200 on
`:8080`.
**Worth an amendment:** the gate does not build the Docker images, so this class of break
is invisible to it. Whether that is worth a slow step in `check.sh` is the coordinator's
call.

## D-43 — `docs/` is coordinator-authorized for v6  ·  M17, M18
**`CLAUDE.md` forbids a builder editing `docs/`.** Ilya authorized it explicitly —
*"build new docs if needed"* — so `docs/74-amendments-v6.md` is written by me and every
M17/M18 task cites it, which keeps those task files the same shape as the 169 before
them. Recorded because the rule it suspends is one of the load-bearing ones, and the
authorization was a sentence in chat rather than a change to `CLAUDE.md`.

## D-44 — No Redis, and what would change that  ·  M17
**Asked for explicitly** — *"if you need some backend databases like redis or something
to better achieve this queue system, do that."*
**Chosen: no.** `registry.rs:161` already **is** the lobby directory — rooms keyed by id,
join codes, insertion order for deterministic tie-breaks, and a TTL reaper. Redis buys
exactly one thing: a directory shared **across processes**. There is no second process
and no sticky routing, and `docs/62` §7 lists both of those *before* Redis in its own
scale-out order. Adding a store with no second reader is a mechanism wired to nothing —
the failure this project has recorded twelve times.
**What flips it:** wanting lobbies to survive a server restart, or wanting a second
server. Neither was asked for. The compose block is already there, commented, with the
path written down.
**Also rejected: a separate lobby service.** Same reasoning one level up — it would need
its own directory, its own protocol and a handoff, to replace a `HashMap` that works.

## D-45 — Five is the fill target, six is the seat cap  ·  M17
**Reconciles two things Ilya said.** *"Up to 5 random people"*, and later *"during
debugging there can be 5 bots playing... we want to test full games too."*
**Chosen:** `LOBBY_CAPACITY` 5 is what a lobby fills to and shows; `MAX_PLAYERS` 6 stays
the hard seat cap. `BOT_COUNT=5` alongside one human is therefore a legal six-seat game
and needs no spectator concept and no second capacity number.
**And the reaper rule is the same rule as the testing requirement, not a conflict with
it:** bots are not occupants, so a room with no humans reaps — but an e2e check drives a
real client, and that client is the human holding the room open. Five bots fight for
exactly as long as the tester is connected.

## D-46 — The map is generated at match start  ·  M17
**Forced by the feature.** A private lobby can only offer map size as a setting if no map
exists yet to contradict it. Ilya confirmed: *"no problem with map generating when match
starts. we're still in the menu anyway."*
**Consequences:** room creation stops paying `docs/71` §B2's 0.6–1.1 s generation cost —
that moves to match start, where a loading beat is expected. `map_init` is no longer sent
at join. And `docs/72` §C18's "a Lobby room holds a map, a roster and a code" is
**overridden** — it holds a roster, a code and its settings.

## D-47 — The title screen stops simulating  ·  M18
**Diagnosed before it was specified.** `TitleScene.ts:155` steps 20×/s while each step
advances `SIM_DT` (1/60), so the attract world runs at **one third of real time**.
`WARMUP_SECONDS` (10 simulated) therefore lands at **~30 s of wall clock** — the reported
window — and at that instant damage un-gates, the weather scheduler starts, item spawns
start and teleports start together. At 45 s the scene tears the world down and rebuilds
it from inside `update()`; a throw there leaves the DOM removed **and** stops Phaser's
frame loop, which is why the button dies too.
**Chosen: the title screen does not run the simulation at all.** Ilya: *"i really care
just generate something random that doesnt require the backend. just make sure the menu
works."* Fixing the timestep would fix this instance; a background that runs the game can
always break the menu.
**Consequence:** `AttractCore` and `Core.attract()` lose their only caller. Recorded, not
deleted silently.

## D-48 — Toxic rain: puddles out, poison in  ·  M18
**Not a bug fix — a redesign, on Ilya's instruction.** Toxic rain *does* damage today
(`TOXIC_DPS` 6 while standing in a puddle for `TOXIC_PUDDLE_LIFE` 3 s), but Ilya: *"never
seen a puddle of toxic rain so just remove puddles and change them to projectiles that
hit you and poison you instead."*
**Chosen:** the drop is a projectile; a hit poisons for `TOXIC_POISON_DURATION` at
`TOXIC_POISON_DPS`, re-hit resets rather than stacks, a roof protects you, terrain takes
a bullet-sized carve, and the health bar goes green.
**Two things this exposes.** There is **no per-player status field** on `PlayerState` —
shield and overheal are the only timed states — so one has to exist. And **the meteor
shower has no roof check either**, despite `docs/74` §E13 describing it as "the same
reasoning the meteor needs"; the occlusion test is one function used twice.

## D-49 — `wait_for` is two contracts under one name  ·  test harness, pre-existing
**Found while auditing T17.05's eighth copy of the test harness.** Seven test files each
carry their own `spawn_server`/`connect`/`wait_for` and there is no `tests/common/`. The
duplication has **already drifted, further than `to_command` did** — `wait_for` is now two
incompatible functions sharing one name:

| files | signature | semantics |
|---|---|---|
| `checksum`, `integration`, `join` | `(rx: &mpsc::Receiver<String>, want: &str, secs: u64)` | channel-based, **drains and discards** non-matching events, per-call timeout |
| `in_progress`, `lobby`, `rooms` | `(inbox: &Inbox, ev: &str, n: usize, label: &str)` | inbox-based, counts occurrences, shared `BUDGET_MS`, takes a label |

Different arguments, different semantics, different timeout sources. **Not variants of one
helper — two contracts.**
**And the destructive one has already caused a real bug:** in T17.02, `wait_for(lobby_state)`
ate `map_init`'s token in `join.rs`, precisely because that variant discards what it is not
waiting for. A reader moving between test files carries the wrong model of a function name
they have already read.
**Chosen:** not refactored inside T17.05 — seven files is not a small task's business, and
the new file chose the non-destructive variant, which is right. **Recorded so that when
someone builds `tests/common/`, the first decision is which `wait_for` survives — and it
must not be the one that discards.**

## D-50 — Refused joins were leaving phantom occupants  ·  T17.05, pre-existing
**Found by the count-at-both-ends rule, and nothing else would have.** The refusal was
correct on the wire while the registry still counted the refused player —
`left: Some(2), right: Some(1)`. **Every verb calls `ctx.attach` before the seat path runs,
and attach increments the human count**, so a refusal that returned without detaching left
a phantom that **consumed a capacity slot and held the room open against the reaper**.
`full` and `bad_name` had done this since long before M17. An `assert!(reason == "in_progress")`
would have passed.
**All three detach now**, and `in_progress` refuses **before** `room.join` — it never reaches
the allocator, which is the strongest form.
**One is untested and it is the structurally riskiest**: `full`'s detach sits in the `else`
of `room.join`, *after* the allocator, unlike the two that are proven before it. It rests on
the class argument alone. Folded into T17.06, where a phantom occupant holding a room against
the reaper is literally the subject.

## D-51 — The M17 boundary sweep, and why it happened here  ·  M17
**Ran at the milestone boundary rather than after all fourteen tasks**, because T17.07
discovered `lobby-start` had been red since T17.03 and nobody knew. **40 checks, four red.**

| check | baseline `85001e8` | verdict |
|---|---|---|
| `two-clients` | pass | **ours** |
| `full-round` | pass | **ours** |
| `death` | FAIL ×3 | pre-existing |
| `void` | FAIL ×3 | pre-existing |

**Both of ours were one bug, in the shared harness.** `openClient` waited on `ready`;
`ready` needs a world; §E1 builds the world at match start — so the wait could not return
until the client's lobby had already closed, and the second client found the first's room
started and was quick-matched elsewhere. Different seeds, one player each, terrain
diverging because they were never in the same world. **`enterBattle`'s guard was circular
in the same file** — it demanded `ready` before doing the thing that produces `ready`, a
precondition asserting its own post-condition, in the harness of eighteen checks.
**Lesson kept:** deferring the browser suite hid four failures for six tasks. The boundary
sweep is the right cadence.

## D-52 — A green run is evidence it passed once  ·  method, third instance
**`death` and `void` were red at `2ab583a`** — the M16 sweep's own commit — three runs
each, identical messages. **So M16's green was the tail.** `death`'s own comment already
said `latch + probed aim — 6 of 8`: the number was written down and nobody read it as
*this gate fails a quarter of the time*.
That is the **third** small-sample-reads-tail in this build:
- 9 clean checksum runs read the tail of a 1-in-3 (D-36)
- an N=16 baseline read 6% where N=40 read 12.5%
- an entire green sweep read the tail of two 25%-and-worse checks
**Three instances is a rule, not an accident:** a green run is not evidence a check passes,
it is evidence it passed once. Any check whose comments record a pass *rate* is a check
that fails, and should be treated as red until the rate is fixed.

## D-53 — `death` was never a product defect  ·  M16 fixture, fixed
*Zero death events reached the client while health fell 20 → 10* looked like the server
failing to narrate a death. It was not: `cargo test -p game-core --lib death` is 6/6, and
**the player never died** — a rocket detonated away from the feet and landed partial
damage, exactly the failure the check's own header describes. No death event was the
correct behaviour.
**Fixed by making the damage sufficient** (`DEV_START_HEALTH` 20 → 1) rather than by
chasing the aim: two earlier attempts to clean up the aim are recorded in that file as
having made it *worse* (6/8 → 5/8 → 4/8). 8/8.
**And the fix was nearly reported having changed nothing.** The first measurement came
back **2 of 3 — indistinguishable from the documented 6/8** — with `starting on 20 health`
in every log, because two `game-server` processes leaked from a worktree run **eighty
minutes earlier** still held the port. **A wrong number that resembles the expected number
is worse than one that does not.** D-39's third bite, and its most expensive.
`dev_start_health` is now printed in the config summary — the one dev knob that was not —
turning a six-run investigation into a one-run one.

## D-54 — `void`: three mechanisms, none of them the assertion  ·  M16 fixture, fixed
**0/8 deterministic → 8/8.** Every assertion *after* the failure already passed; the
player did fall, and the walk loop simply never got them there.
1. **The probe asked a different question from the physics.** `openColumn` scanned a single
   centre column while the physics supports you if solid meets your **body box** — so on
   the lip of a fresh crater it answered *"you are already over the hole"* while the player
   stood beside it, unmoved for 25 s. Scanning across `PLAYER_W`, the width `surface.rs`
   itself uses, made the two agree. **0/8 → 6/8.**
2. **`DIG_OFFSET` was `PLAYER_W * 1.5` = 24 against `BAZOOKA_BLAST_RADIUS` 42**, so the
   crater reached 18 px past the player's centre and undermined them **every time**;
   surviving the `ASSIST_WINDOW` wait was luck. Derived as `BLAST + PLAYER_W`, which is
   what "dig beside" always meant. **6/8 → 7/8.** An inlined literal smaller than the
   constant it must clear is precisely why this project forbids the literal.
3. **The fixture damaged the player it then asked the void to kill** — health hit 0 a few
   pixels above the line with the rocket still inside the window, so the server correctly
   said `SelfInflicted`. **Closed the confound rather than racing it**: heal between
   digging and walking in. **7/8 → 8/8.**
**No new dev surface.** `DEV_LOADOUT` grants six weapons and no heal, and the first attempt
— `give(world, id, MEDKIT, 3)` — did nothing, because **§C9 moved heals out of the
inventory into a counter**: it would have taken a quick-bar slot, shifting every index
other checks depend on, while leaving `Q` with nothing to spend. Setting `p.heals` beside
the existing `p.battery` is slotless and is the grant the loadout already makes. The check
heals with **`Q`, the shipped binding**, and **asserts the heal landed** (`95 → 148`) —
a heal that silently did nothing would put the confound straight back, which is exactly
what the first version did.

## D-55 — `replay_run`'s divergence floor: 5 of 20, from a measured 11

D-24 predicted this and prescribed the fix: *"sample more than 12, or bias toward the late
candidates"*, because the property is **localisation of the divergences that occur**, not
that any given byte diverges — the early ticks contribute nothing but wash-outs. T18.04
moved the map, and the prediction landed exactly: the old even stride gave **0 of 12** where
it had given 4, and widening the same stride to 24 gave **0 of 24**.

A contiguous late window (`candidates[n-28..]`, take 20) gives **11 of 20**, and the nine
wash-outs are the **final nine consecutive ticks** — an ordered boundary, not scatter. The
floor is set at **5**: six candidates of room, which is the whole distance from the boundary
to the start of the window, so terrain drift moves it without breaking it, while a fall
below 5 means the runner is missing three quarters of corrupted commands. The old floor's
defect was margin, not value — 3 measured against a floor of 3.

## D-56 — one seating gate had no test, and only the golden table knew

`seat` gates twice: `grounds.len() / w` on the fraction of columns finding ground **inside
the seat band** (gate A), and `contact_fraction` on the seat it then chose (gate B).
Measured, one at a time:

| variant | result |
|---|---|
| control | 30 passed |
| gate A relaxed | **30 passed — green** |
| gate B relaxed | 29 passed, 1 failed — *"object 145 is 98 px wide … only 59 % of its base has ground under it"* |
| both relaxed | 29 passed, 1 failed — the same test |

**One-at-a-time falsification worked.** It found that **gate A has no unit guard at all**:
relaxing it is invisible to every test, and its only signal is the golden table moving —
which happens on *any* generation change, so the next relaxation would be attributed to
whatever else was in the commit and ship in silence. My first reading of this was wrong and
is corrected here: I reported *"both had to go for the unit test to go red"*, which the
measurement contradicts, and wrote the same claim into the code comment where it would have
told a reader the gate was guarded when it was not.

The guard is now written — `a_footprint_that_mostly_finds_its_ground_outside_the_band_is_
refused`. Gate A's case is specific: when fewer than `want` columns find ground in the band,
the percentile index **clamps to the deepest one found**, seating the object at the bottom
of the band, and `contact_fraction` then passes it at **100 %** because the ground the search
missed lies within `SEAT_CONTACT` of that deeper seat. Building it took a correction of its
own — the first profile put the missed ground at `limit + SEAT_CONTACT`, one row past what
`contact_fraction` reaches from a seat on `limit`, so it was green under a relaxed gate and
proved nothing. Falsified at `objects.rs:446`: `seat = Some(314)`, contact 1.00, red.

**The method lesson is the opposite of the one I first recorded:** falsifying gates one at a
time is what distinguishes a guarded rule from an unguarded one, and a gate that only moves
a regeneratable table is untested.

## D-57 — §D5's `OBJECT_MIN_SEPARATION` value, not its name

`docs/73` §D5 says verbatim `OBJECT_MIN_SEPARATION | 64 | between object centres`, so the
spec is explicit and `too_close` is a generic name — **nothing lies**, and the earlier
framing of this as a naming defect is withdrawn.

The question is the **value**. 64 px between centres was calibrated when a median rock was
~50 px wide; §E12's scaling puts the median at ~75 and the maximum at **197**, so the
constant no longer produces any separation between the objects it governs. Measured across
nine maps: **27 of 3132 pairs overlap by bounding box, worst penetration 50 px** — 0.9 %.

Not a correctness defect: objects are stamped into the mask, so an overlap merges terrain
rather than corrupting it, and nothing downstream reads an object's box. It is a §D5 value
question — whether separation should be `64 + (w_a + w_b) / 2`, which would change the map,
or whether 64 centres is what §E12 wants at these sizes. A coordinator call, not a builder's.

## D-58 — The `game-server` integration suite is load-sensitive as a suite  ·  method
**Measured, and the rate is deliberately not claimed.** Pinned at `d453e76`, isolated
worktree, idle box: **1 failure in 8 serial runs.** At n=8 the 95% interval runs from
roughly 0.3% to 50%, so **"12.5%" is one observation, not a rate** — D-52's lesson applied
to the measurement itself.

**The robust finding is the shape.** Across ~11 full-suite runs, **four distinct tests have
failed and never the same one twice**:

```
a_room_whose_last_human_left_is_reaped_by_the_running_server   rooms.rs:751
sigterm_leaves_a_verifiable_file_and_sigkill_does_not          replay_run.rs:732
two_clients_in_one_room_do_hear_each_other                     rooms.rs:208/441
quick_match_makes_a_new_lobby_rather_than_being_refused        rooms.rs
```

If one test were broken it would recur; instead **the failure moves**. Every one of the
four spawns real sockets or processes and waits on them. One already has a diagnosed
mechanism — `rooms.rs:751` compares a registry read under the mutex against a lagging
`AtomicUsize` gauge across an HTTP round trip, a race by construction — and the others are
expected to be variants of the same shape: **two sources of truth for one fact, sampled
once.**

**Consequence for any sweep:** a single `game-server` failure is **unproven until re-run**,
and the cheap discipline is to re-run the failing target alone and baseline it at the
previous commit before attributing it to the task in hand. That is what separated ours from
pre-existing at the M17 boundary (D-51).

**What would earn a number: n ≥ 30 on an idle box**, about 90 minutes. Worth doing once,
deliberately — not worth inferring from the tail.
