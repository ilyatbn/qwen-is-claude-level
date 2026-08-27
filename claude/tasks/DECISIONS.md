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
