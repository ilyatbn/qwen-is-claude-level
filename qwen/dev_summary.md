# Deviations — one-paragraph summary each

Condensed index of `DEVIATIONS.md` (39 entries, D1–D40, D24 unused). Each entry:
what qwen's design says, and what had to be done instead.

Categories: **[arith]** the spec's own numbers are wrong · **[contra]** two parts of
the spec contradict each other · **[missing]** the spec omits something required ·
**[api]** the spec names something that does not exist · **[process]** the spec's
own task/test contract fails · **[impl]** an implementation decision the spec left open.

---

### Spec arithmetic that does not survive checking

**D1 — Meteor damage [arith].** T4.5 says a player 20 px from a 48 px / 60 dmg blast takes "~45 (60*(1-20/48))". That expression is **35**. Implemented the formula; the test asserts 35.

**D3 — Terrain smoothness bound [arith, MEASURED].** T1.3 asserts adjacent columns differ by ≤8 tiles. Measured over 100 seeds × 3 scales: max **7 / 10 / 14** (Small/Medium/Large), with 296 violations on Large. Replaced with a scale-relative `ceil(0.13·H)`.

**D5 — Rock pocket size [arith, MEASURED].** T1.4 asserts each connected ROCK component is ≤15 tiles. Pockets merge at **every** scale, not just Large: measured max components of **27 / 28 / 30**. Now asserts the per-pocket ≤13 the walk actually guarantees.

**D37 — Item spawn weights [arith].** docs/04 §3 presents weights as percentages, but row A sums to **130** and row B to **140**, while the same sentence claims "weapons 50%" against an itemised 80. Implemented as relative weights — so flashlight in rock is **1.86× more likely, not 2×**.

**D40 — Grenade range vs fuse [arith].** 400 px range at 400 px/s exhausts at **1.00 s**, but the documented fuse is 1.5 s — so the fuse can never fire. Range governs; the fuse is unreachable as specified.

### Parts of the spec that contradict other parts

**D4 — Toxic rain window [contra].** 5 spots staggered `i*1.2 s`, 4 s each, inside an 8 s effect means spot 4 runs to 8.8 s — but T4.4 asserts it ends at 8 s. Every spot is clamped to the 8 s window; spot 4 lives 3.2 s.

**D6 — Player body size [contra].** T2.6 says 12×14 px, docs/07 §5 says 24×28, docs/04 §2 says a 12 px hit radius. Read 12×14 as **half-extents**, which reconciles all three at once.

**D9 — Spawn coordinate units [contra].** docs/01 §4 declares spawns as tile coords; §3.5 gives a pixel formula. Stored as tile coords (what T2.1's own arithmetic requires), converted at spawn time.

**D16 — `protocol_version` [contra].** docs/06 §7 says the server sends it in `joined`; §2's `joined` payload table omits the field. Added to the message; the doc contradicts itself.

**D23 — Cosine interpolation vs determinism [contra].** docs/01 §3 *mandates* cosine interpolation while docs/00 §2 promises unconditional determinism — but `f32::cos` routes to platform libm and can differ by 1 ULP. Measured: **1.31% of samples differ, max 1 ULP**. Shipped platform `cos`; `libm::cosf` is the cheap fix if cross-platform equality is ever needed.

**D28 — Jump apex [contra].** T2.4 asserts an apex of 58–63 px while specifying only `vel.y += 900*dt` and quoting the *continuous* `v²/2g`. Of three integrators only **velocity Verlet (60.375 px)** lands in the window; semi-implicit gives 52.5, explicit 69.0. Verlet chosen — it is exact for constant acceleration, which is why it reproduces the doc's own formula.

**D29 — Anti-tunneling bound [contra].** T2.6 asserts terminal velocity 900 px/s *and* ≤45 px per tick — but 900 × 0.05 = **exactly 45**, and under D28's required Verlet it is 46.125. The two acceptances are mutually unsatisfiable, and 45 px spans 2.81 tiles so the bound would not prevent tunneling anyway. Provided the property (swept shape-casts) instead of the number.

**D39 — Projectile collision [contra].** docs/04 §2 specifies a point lookup ("tile under new pos solid"), but at 20 Hz every weapon moves further than one 16 px tile: pistol 35 px, shotgun 30, rocket 25, grenade 20. Measured over 64 sub-tile offsets, the **pistol passes through a solid 1-tile wall 62% of the time** and through a player in its path 23%. Faithful to the spec, but a Phase 4 prerequisite to fix.

### Things the spec requires but never provides

**D7 — `base64` [missing].** `MapData.tiles` is base64 per docs/06 §6, but T0.1's dependency list omits any base64 crate. Added `base64` — pure computation, so it does not violate the "no async/IO crates" rule.

**D8 — `Vec2` [missing].** Used for `spawns`, `pos` and `vel` across two docs, but no math module appears in T0.1's file list. Defined minimally in `lib.rs`.

**D15 — Effect-kind wire casing [missing].** docs/06 §5 keys EffectData by `ToxicRain`/`MeteorShower`, docs/02 §7 uses the same for the Rust enum, and the wire casing for `kind: string` is **stated nowhere**. Chose snake_case — a wire-format decision made without spec authority.

**D32 — The collision→velocity rule [missing].** Zeroing velocity on a blocked axis is load-bearing physics — without it a resting player accumulates `vel.y` = 900 while standing still, invisible until the ground is destroyed — and no document mentions it. Now stated once, in production code.

**D33 — Tick step order [missing].** Nothing specifies the order of jump/jetpack/horizontal within a tick, but it matters: with jump first, `step_horizontal` overwrites the ±70 bias with ±140 and `JUMP_DIR_BIAS` silently dies. Horizontal must run before jump.

**D36 — Step climbing [missing].** With `autostep: None` a player **cannot walk up a single 16 px rise** — blocked flush against it indefinitely. Given D3's measured column deltas of 7/10/14 tiles, essentially all upward terrain is jump-only. An open Phase 4 decision.

### APIs and versions the spec names that do not exist

**D2 — rapier stepping [api].** T2.6 says to call `world.integrate_forces`, which is not how rapier2d steps. Resolved by keeping the pure step functions authoritative for all documented movement numbers and confining rapier to collision resolution.

**D17 — `rand` API [api].** T1.1 specifies `gen_range` and a `UniformRange` trait; `rand` 0.9 renamed the former and never had the latter.

**D18 — Dependency pairing [api].** `rand_chacha` 0.10 pulls `rand_core` 0.10 while `rand` 0.9 uses 0.9, putting two incompatible `RngCore` traits in one tree. Pinned `rand_chacha` to 0.9.

**D11 — Kenney asset URLs [api].** The three download URLs do not match Kenney's real URL shape, and "Pixel Adventure 1" is not a Kenney pack. Expect 404s; the manifest placeholder fallback is the designed escape hatch. *(Phase 5, unverified.)*

### Where qwen's own task/test contract failed

**D14 — T0.3's Test command [process].** It is a manual browser procedure, not a command — directly contradicting docs/08 §5's rule that every task ends with an exact command that must pass. Replaced with a headless socket.io round-trip script.

**D20 — A green gate proving nothing [process].** Phase 0 shipped the broken `rand`/`rand_chacha` pairing of D18 and passed `cargo build && cargo test` with **zero warnings**, purely because the modules were stubs importing neither crate. It broke the moment T1.1 used them. The contract verifies compilation, not correctness.

**D27 — Test commands that select no tests [process].** T2.1's and T2.2's Test commands match **zero** of the tests those tasks create, and exit 0. Four instances of this class were found across the build.

**D12 / D21 — Wall-clock assertions [process].** T4.9's "10 Hz ±1 over 10 s" is flaky by construction and was replaced with the deterministic `tick % 2 == 0` invariant. T1.6's generation-time bound was *kept* — a 200× margin (1.0 ms measured against a 200 ms bound) is a different risk class from a 10% one.

**D38 — Anchor coverage vs apparent scope [process].** Adding `Tile.item` to the map's golden hash looked like it extended the anchor to hidden items, but `Map::generate` always leaves that field `None` — so it anchored nothing, and item placement was determinism-critical and completely unpinned. A test that *can* fail, but never for the thing everyone assumed it covered.

### Implementation decisions the spec left open

**D10 — Terrain test without Phaser [impl].** docs/08 §3 restricts client tests to pure logic, but T1.9 wants a `Terrain.applyDestroyed()` unit test. Split into a pure grid model (tested) and a thin Phaser render layer, so Vitest never imports Phaser.

**D19 — Hand-rolled `shuffle` and `random_unit` [impl].** Implemented locally rather than delegated, so map output is not hostage to a `rand` patch bump. Draw counts are pinned by test.

**D22 — Surface conversion is per-batch [impl].** T1.7 says "after destroy", but converting per-destruction inside a blast resets a damaged DIRT tile from 30 hp to GRASS's 20 mid-batch, so later damage over-kills — a 45-damage blast destroys 2 tiles instead of 1. `destroy_tile` converts; `destroy_tile_deferred` is the batch path.

**D25 — Spawn y formula [impl].** T2.1's formula buries the player one full tile (measured 600/600 spawns). Corrected to rest the feet on the tile top.

**D26 — Spawn candidate width [impl].** The candidate rule checks a single column while the body is 1.5 tiles wide, so most spawns overlap neighbouring terrain by up to 175 px. A Phase 4 prerequisite; fix is to require columns `x-1..=x+1` clear.

**D30 — Cross-platform determinism [impl].** Decided: **same-platform guaranteed, cross-platform not.** rapier's exposure is small precisely because D2 confines it to collision — a platform difference must flip a blocked/not-blocked boolean, not merely perturb a float.

**D31 — FOV implemented twice [impl].** docs/08 §3 mandates the formula in both Rust and TS with no "update both" rule. Both are pinned to a fixture generated from Rust, while Rust separately asserts doc literals — so the generator can never validate itself.

**D34 — Combined-axis collision [impl].** Passing both axes to the character controller in one shape-cast intermittently consumed the whole budget resolving gravity, costing **20% of walking speed** (56 px per 10 ticks instead of 70). Split into two casts.

**D35 — Slope-dependent ground speed [impl].** Measured 7.525 px/tick downhill against 7.0 flat. Not a violation — velocity never exceeds 140; the excess is Verlet's `½at²` on airborne ticks. But T2.3's "exactly 140 px/s" is a **flat-ground property** that passes only because the test map is flat.

**D13 — Docker [impl].** Not installed when the toolchain was surveyed; T5.5 verification pending. *(Phase 5.)*

---

### Found by end-to-end testing, after all 375 unit tests passed

**D41 — Ground items are unreachable [contra].** Tile-centre placement, feet-on-tile-top spawning, a 16 px pickup radius and a 24×28 body are jointly unsatisfiable: separation is always **22 px** against a 16 px radius. Measured: **0 of 500 items reachable across 50 maps**. Crates escape only by landing on the tile top instead of its centre.

**D42 — rocket damage exactly equals STONE's hp [measured, CORRECTED].** This entry originally claimed ROCK was indestructible and that source-B's 4 hidden items were permanently unreachable. **That was wrong** — it assumed single-shot destruction, but tile hp persists between blasts (T1.8's own acceptance), so ROCK falls to a second hit: 2 rockets (80→20→gone) or 2 grenades. Hidden items are reachable. What remains is a balance note: the rocket's 60 damage equals STONE's 60 hp exactly, so a single rocket underground destroys **1 tile in uniform stone, or 0** when no tile centre lands close enough — against 8 in the softer near-surface DIRT band.
