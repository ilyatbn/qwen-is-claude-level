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
