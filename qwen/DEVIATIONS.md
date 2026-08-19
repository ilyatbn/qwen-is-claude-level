# Deviations from qwen's design

This file records every place where the design in `docs/` and `tasks/` could not be
implemented exactly as written, and what was done instead.

**Rule**: the design is implemented verbatim wherever it compiles and runs. A entry
only appears here when the spec is internally inconsistent, mathematically wrong,
references a non-existent API, or omits something required to build. Nothing is
silently "improved".

Format: what the spec says → why it fails → what was implemented.

---

## Pre-implementation defects (found while reading the design)

These were identified before any code was written.

### D1 — T4.5 meteor damage arithmetic is wrong

**Spec** (`tasks/04-rounds.md` T4.5 step 3): "a player at 20 px takes ~45
(60*(1-20/48))".

**Problem**: `60 * (1 - 20/48)` = `60 * 0.58333` = **35**, not 45. The parenthesised
formula and the stated result disagree.

**Implemented**: the formula, which matches `docs/01-map.md` §5 and is used everywhere
else for blast falloff. The test asserts **35**.

### D2 — T2.6 cites a rapier API that does not exist

**Spec** (`tasks/02-player.md` T2.6 step 2): "set body velocity from the pure step's
intended velocity, `world.integrate_forces`, read back positions".

**Problem**: `integrate_forces` is not how rapier2d is stepped. Stepping goes through
`PhysicsPipeline::step(...)` with the island manager, broad phase, narrow phase, island
manager, impulse/multibody joint sets and CCD solver. Additionally, rapier's constraint
solver will not reproduce the exact-value assertions the earlier tasks demand
(T2.3: `Δx == 70 px` over 10 ticks; T2.4: apex 58–63 px; T2.5: fuel exact to 0.01).

**Implemented**: the pure step functions from T2.3–T2.5 remain authoritative for
movement and own those tests. Rapier is used for collision resolution against terrain
colliders only. Ground detection uses the 2 px tile probe, which T2.6 step 3 already
mandates over a rapier raycast ("deterministic, doc §4").

### D3 — T1.3's smoothness bound is unsatisfiable above Small (MEASURED)

**Spec** (`tasks/01-map.md` T1.3 step 3): "adjacent columns differ by ≤ 8 tiles".

**Problem**: with `h = H*0.35 + H*0.22*(0.7*n8 + 0.3*n3)` and cosine interpolation,
the worst-case single-column delta is ≈ `0.126*H` → ~8.1 tiles (Small, H=64), ~12.1
(Medium, H=96), ~16.1 (Large, H=128). A fixed bound of 8 can only hold at the smallest
scale.

**Measured** — 100 seeds × 3 scales, via `game-core/examples/measure_d3.rs`:

| Scale | H | max adjacent Δ | worst seed | violations of ≤8 | theoretical 0.126·H |
|---|---|---|---|---|---|
| Small | 64 | **7** | 16 | 0 | 8.1 |
| Medium | 96 | **10** | 8 | 13 | 12.1 |
| Large | 128 | **14** | 74 | 296 | 16.1 |

So the doc's bound holds at Small (with one tile to spare) and fails at both larger
scales — 296 violating column pairs on Large. Measured maxima sit below the
theoretical worst case, as expected: the worst case needs two adjacent control points
at opposite extremes, which is rare.

Surface rows themselves are always inside the documented clamp
`[H-1-round(H*0.6), H-1-round(H*0.15)]` at every scale — that half of the assertion
is sound.

**Implemented**: the smoothness assertion uses a scale-relative bound,
`ceil(0.13 * H)` → 9 / 13 / 17 tiles, which is above every measured maximum with
headroom and tracks the actual mathematics of the formula. The fixed 8 is not used.
The bounds half of `surface_within_bounds` is asserted exactly as documented.

### D4 — Toxic rain spot window is inconsistent

**Spec**: `docs/02-map-effects.md` §3 says 5 spots, spot `i` starting at `i*1.2 s`,
each lasting 4 s, within an 8 s effect. `tasks/04-rounds.md` T4.4 asserts "spot 4 ends
at 8 s".

**Problem**: spot 4 starts at `4*1.2 = 4.8 s` and would run to `8.8 s` — past the end
of the 8 s effect, contradicting the assertion.

**Implemented**: every spot's life is clamped to the 8 s effect window. Spot 4 lives
3.2 s (4.8 → 8.0). The doc's "so the 8 s window covers all" is read as intent that the
window is the authority.

### D5 — Pocket size assertion fails at every scale, not just Large (MEASURED)

**Spec** (`tasks/01-map.md` T1.4 step 4, and `docs/08-testing.md` §1 map row):
"each connected ROCK component ≤ 15 tiles, all rows > surface".

**Problem**: a random walk of up to 12 steps marks at most 13 tiles — within 15 — but
nothing prevents independently-placed pockets from landing adjacent and merging into
one larger connected component. The ≤15 bound describes a per-pocket property and is
then asserted against connected components, which is a different thing.

**Measured** — 100 seeds × 3 scales, 4-connected flood fill, via
`game-core/examples/measure_d5.rs`:

| Scale | pockets/map | max connected component | worst seed | components > 15 | total components |
|---|---|---|---|---|---|
| Small | 8 | **27** | 14 | 36 | 1518 |
| Medium | 14 | **28** | 49 | 59 | 2596 |
| Large | 20 | **30** | 34 | 58 | 3811 |

Merging happens at **every** scale, including Small — the original prediction (that
only Medium/Large would be affected) understated it. Roughly 1.5–2.4% of components
exceed the documented bound, and the largest observed is double it.

**Implemented**: `pockets_below_surface_and_sized` asserts the properties the
algorithm actually guarantees:

1. every ROCK tile is strictly below its column's surface (`y > s(x)+1`) — this half
   of the doc's assertion is real and holds at every scale;
2. per-pocket size ≤ 13 tiles (1 start + ≤12 steps), asserted at generation time via
   `debug_assert!` and directly in `a_single_pocket_marks_at_most_13_tiles`;
3. a regression ceiling of 40 tiles on merged components, well above the measured
   maximum of 30, to catch a future change that makes pockets grow without pinning
   them to an arbitrary number the design never justified.

The doc's ≤15 connected-component bound is not asserted, because it is false.

### D6 — Player body dimensions conflict across three docs

**Spec**: `tasks/02-player.md` T2.6 says a "12×14 px rectangle"; `docs/07-sprites.md`
§5 says the player placeholder is a "24×28 rect"; `docs/04-items.md` §2 says the player
hit circle is 12 px radius.

**Problem**: a 12×14 px body with a 12 px hit radius is incoherent (the hit circle
would be twice the body), and the renderer would draw a box twice the collider.

**Implemented**: "12×14" is read as **half-extents**, giving a 24×28 full body — which
reconciles all three numbers at once (24×28 placeholder, ~12 px half-width hit radius).

### D7 — `base64` is required but absent from the dependency list

**Spec**: `docs/06-protocol.md` §6 defines `MapData.tiles` as "base64 of u8 array".
`tasks/00-setup.md` T0.1 lists `game-core` deps as rand, rand_chacha, rapier2d, serde,
thiserror.

**Problem**: no base64 implementation is available.

**Implemented**: the `base64` crate is added to `game-core`. It is pure computation with
no IO or async, so it does not violate the "NO async/IO crates" constraint in T0.1.

### D8 — `Vec2` is used throughout but never defined

**Spec**: `docs/01-map.md` §4 declares `spawns: Vec<Vec2>` and `docs/03-player.md` §1
declares `pos`/`vel` as `Vec2`, but T0.1's module list (rng, map, tiles, physics,
player, items, effects, round, protocol) contains no math module.

**Implemented**: a minimal `Vec2 { x: f32, y: f32 }` is defined in `lib.rs`, alongside
the module declarations.

### D9 — Spawn coordinate units are ambiguous

**Spec**: `docs/01-map.md` §4 declares `spawns: Vec<Vec2>` as "tile coords", but §3.5
gives a pixel formula `((x+0.5)*16, (y+0.5)*16)`.

**Problem**: the two readings differ by a factor of 16. `tasks/02-player.md` T2.1
computes `y = (tile_y+1)*16 - body_half_height`, which only type-checks if spawns are
tile coordinates.

**Implemented**: spawns are stored as **tile coordinates** (matching §4, the struct
definition, and T2.1) and converted to pixels at spawn time.

### D10 — T1.9's Terrain unit test would require Phaser in Vitest

**Spec**: `docs/08-testing.md` §3 restricts client tests to pure logic
(`interpolation.ts`, `fov.ts`, `protocol.ts`). `tasks/01-map.md` T1.9 Acceptance
requires "a unit test of Terrain's `applyDestroyed(tiles)`".

**Problem**: `Terrain.ts` is a Phaser rendering class; unit-testing it pulls Phaser
(and a WebGL/canvas context) into Vitest.

**Implemented**: Terrain is split into a pure grid model (holding tile state, unit
tested) and a thin Phaser rendering layer that observes it. Vitest never imports Phaser.

### D11 — T5.1's Kenney URLs are not valid

**Spec** (`docs/07-sprites.md` §3): three download URLs of the shape
`https://kenney.nl/media/pages/packs/<pack>.zip`.

**Problem**: that is not Kenney's URL shape — their downloads live under hashed
`/media/pages/assets/<pack>/<hash>/kenney_<pack>.zip` paths. "Pixel Adventure 1" is
also not a Kenney pack (it is by Pixel Frog, on itch.io). Expect 404s.

**Implemented**: the download is attempted as specified; on failure the manifest's
placeholder-fallback path (`docs/07-sprites.md` §2, "If a manifest entry is missing,
BootScene falls back to the placeholder shape") carries the game. The hard requirement
is that the game boots and plays with zero assets present. *(Outcome recorded in
Phase 5.)*

### D12 — T4.9's snapshot-rate assertion is wall-clock and flaky

**Spec** (`tasks/04-rounds.md` T4.9 Acceptance): "snapshot rate is 10 Hz (±1) over a
10 s window (assert in a server integration test with a timer)".

**Problem**: a wall-clock rate assertion in a test suite is flaky under load, in CI, and
in containers — exactly the environments it will run in.

**Implemented**: the deterministic invariant is asserted instead — a snapshot is emitted
iff `tick % 2 == 0`, which is what "10 Hz" means given the fixed 20 Hz tick. The
wall-clock timing check is kept as a non-gating manual observation.

### D13 — T5.5 Docker availability

**Status**: docker was absent from the host when the toolchain was surveyed
(2026-08-19). The user is installing it before Phase 5, so T5.5 is expected to be
verified normally. Re-checked at Phase 5 start; if still absent, the Dockerfile and
compose file are written per `docs/05-server.md` §6 and the build/run verification is
recorded here as not performed.

---

## Defects found during implementation

*(Appended as they are found, same format.)*

### D14 — T0.3's Test command cannot be executed as written (browser check)

**Spec** (`tasks/00-setup.md` T0.3 Test): "`cd server && cargo test && cargo run -- dev`
(then in another terminal `cd client && npm run dev`, open localhost:5173, confirm
pongs in both consoles; then `cargo test` again for suite health)".

**Problem**: the executing agent has no browser and no second interactive terminal, so
"open localhost:5173, confirm pongs in both consoles" is not runnable. This is the
first of several tasks whose Test line is a manual human procedure rather than a
command — `docs/08-testing.md` §5 states "Every task file entry ends with a **Test**
line = the exact command that must pass", which these lines are not.

**Implemented**: the round-trip is proven headlessly and reproducibly instead. The
client's `connect()` in `src/main.ts` is exactly what the browser would run; a
companion script `client/scripts/ping-check.mjs` drives the same `socket.io-client`
library against the same `/game` namespace, emits `ping`, and asserts `pong` returns
(exit 0/1). Verified:

- server listens on `0.0.0.0:3001`, namespace `/game`
- `ping` → `pong` round-trip passes over websocket, and the polling handshake
  (`/socket.io/?EIO=4&transport=polling`) returns the expected `sid` JSON
- `WIPGAME_PORT=3999` override honoured (round-trip re-verified on 3999)
- `RUST_LOG=info` → `[net] client connected` / `disconnected`, zero `[tick]` lines;
  `RUST_LOG=debug` → adds `[tick] n` and `[net] ping from id=...`
- tick cadence measured at **20.00 Hz** over an 11 s window (docs/00 §2 target: 20)

The browser check itself remains unperformed.

### D15 — Effect-kind wire casing is invented; the spec never states it

**Spec**: `docs/06-protocol.md` §5 keys `EffectData` by `ToxicRain` / `MeteorShower` /
`LavaBurst` / `HeavyFog`, and `docs/02-map-effects.md` §7 uses the same PascalCase for
the Rust `EffectKind` enum. But the values that actually travel on the wire are
`kind: string` fields on `effect_started`, `effect_ended` and `Snapshot.effect`
(docs/06 §2, §4), and **no doc states their casing**.

**Problem**: PascalCase enum names and the wire strings are different things, and only
the former are specified. Client and server must agree on the latter or every effect
silently fails to render.

**Implemented**: snake_case — `"toxic_rain"`, `"meteor_shower"`, `"lava_burst"`,
`"heavy_fog"` — consistent with every other string constant on the wire (event names
in docs/06 §1–§2 are all snake_case). Declared once in `client/src/protocol.ts`
(`EFFECT_KINDS`). This is a wire-format decision made without spec authority; Phase 4
is built on it, and `game-core`'s `EffectKind` serde names must match when T4.4–T4.8
create them.

### D16 — `protocol_version` is required by docs/06 §7 but absent from §2's `joined`

**Spec**: `docs/06-protocol.md` §7 says "Protocol version constant
`PROTOCOL_VERSION = 1` in both protocol files. **Server sends it in `joined`**; client
warns (console + toast) on mismatch." But §2's `joined` payload is
`{ id, room, seed, scale, map, players }` — no version field.

**Problem**: the document contradicts itself. §7 mandates a field §2 omits.

**Implemented**: a `protocol_version: u8` field added to `Joined` in both
`protocol.rs` and `protocol.ts`, following §7 (the normative statement) over §2's
table. The client-side mismatch **warning** is not yet implemented — no `joined`
handler exists until the lobby is built; assigned to T4.10.

---

## Phase 1 defects

### D17 — T1.1 names a `rand` API that does not exist, in a version that renamed it

**Spec** (`tasks/01-map.md` T1.1 step 2): "Expose: `next_u64`,
`gen_range<R: UniformRange>`, `shuffle<T>`, `random_unit() -> f32` (0..1)".

**Problem**: there is no `UniformRange` trait in `rand` — the real traits are
`SampleUniform` and `SampleRange`. Separately, `rand` 0.9 renamed the method
`gen_range` → `random_range`, so the doc's name no longer exists on `Rng` either.

**Implemented**: the doc's *method name* `gen_range` is kept on `GameRng` (task files
refer to it by name), with concrete `u32` bounds rather than a generic range trait,
plus `gen_range_inclusive` and `gen_range_f32` for the inclusive and float cases the
map/effects specs need. The generic-over-`UniformRange` signature is not reproduced.

### D18 — `rand_chacha` 0.10 and `rand` 0.9 cannot coexist

**Spec**: `tasks/00-setup.md` T0.1 lists both `rand` and `rand_chacha` as `game-core`
dependencies without versions.

**Problem**: the current releases are incompatible. `rand` 0.9.5 depends on
`rand_core` 0.9, while `rand_chacha` 0.10 depends on `rand_core` 0.10. Both end up in
the tree, so `ChaCha8Rng` implements *a* `RngCore` trait but not the one `rand` 0.9
exports, and `next_u32`/`next_u64` fail to resolve with a misleading
"trait bounds were not satisfied" error.

**Implemented**: `rand_chacha` pinned to `0.9`, which shares `rand_core` 0.9 with
`rand` 0.9. Recorded because a future dependency bump will hit this again.

### D19 — `shuffle` and `random_unit` are implemented here, not delegated to `rand`

**Spec**: T1.1 says to expose `shuffle<T>` and `random_unit()` from a wrapper around
`rand_chacha::ChaCha8Rng`, implying `rand`'s own helpers.

**Problem**: `SliceRandom::shuffle` and `Rng::random::<f32>()` are not
contractually stable across `rand` releases. Their sampling strategy — and the number
of words they consume — may change in any version. docs/01 §3 warns that generation
order is load-bearing ("follow it exactly or determinism tests break"); the number of
draws is equally load-bearing, because one extra draw shifts every value downstream.
Delegating would make every map for a given seed hostage to a patch bump.

**Implemented**: `GameRng` spells out Fisher–Yates — `n-1` calls to `below()` for a
slice of length `n` — and derives `random_unit` from the top 24 bits of one `u32`.
Map output now depends only on ChaCha8 — a stable, specified stream — plus code in
`rng.rs`.

**Correction**: an earlier version of this entry claimed the shuffle consumes
"exactly `n-1` draws". That is wrong. It makes `n-1` *calls to `below()`*, but each
call consumes **one or more** `u32` draws, because Lemire's rejection loop redraws
when the sample lands in the biased window. The word count is therefore data
dependent, not fixed. The test
(`shuffle_consumes_one_draw_per_element_after_the_first`) is stronger than the claim
was: it replays the exact `below()` call sequence and compares the RNG's subsequent
output, so it pins the real consumption whatever the rejection loop did. The
guarantee that matters — *reproducibility* for a given seed — is unaffected; only
the prose was inaccurate.

### D20 — Phase 0's gate passed an incompatible dependency pairing

**Spec**: `tasks/00-setup.md` T0.1 lists `rand` and `rand_chacha` as `game-core`
dependencies, unversioned, and gates the task on `cargo build && cargo test`.

**Problem**: the current releases of those two crates are mutually incompatible.
`rand` 0.9.5 depends on `rand_core` 0.9; `rand_chacha` 0.10 depends on `rand_core`
0.10. Both land in the tree, so `ChaCha8Rng` implements a `RngCore` trait that is not
the one `rand` 0.9 re-exports, and `next_u32`/`next_u64` fail to resolve behind a
misleading "the following trait bounds were not satisfied" error.

**What makes this worth recording is how it was found.** T0.1 declared both crates and
its gate — `cargo build && cargo test` — passed with **zero warnings**. It passed only
because nothing in `game-core` imported either crate yet: the modules were stubs. The
breakage surfaced the moment T1.1 wrote the first line of code that actually used
them, two tasks and one phase gate later.

That is direct evidence that qwen's task/test contract (`docs/08-testing.md` §5, "a
task is done when its Test command passes") verifies *compilation*, not *correctness*.
A scaffold phase whose modules are empty stubs cannot validate its own dependency
choices, yet T0.1 is marked done and gated on exactly that. The design has no notion
of a dependency being declared-but-unexercised.

**Implemented**: `rand_chacha` pinned to `0.9`, sharing `rand_core` 0.9.5 with `rand`
0.9.5. Note that `rand` 0.10.2 is *also* in the workspace tree via `rapier2d`;
`GameRng` binds unambiguously to the 0.9 pairing because `game-core` declares `rand`
0.9 directly and never names the transitive one. Verified by the `rng` test suite,
which exercises every draw kind.

*(This supersedes the narrower D18, which recorded the same version conflict without
the framing above. D18 is kept for numbering stability.)*

### D21 — T1.6's performance assertion is wall-clock, and is kept anyway

**Spec** (`tasks/01-map.md` T1.6 Acceptance): "generation of Large map < 50 ms (assert
in test with an upper bound of 200 ms to be safe)".

**Problem**: wall-clock assertions in a test suite are load-sensitive and can fail for
reasons unrelated to the code — a busy CI box, a container under contention, a
debug-profile build. This is the same class of defect as D12 (T4.9's 10 Hz timing
assertion).

**Implemented**: **kept as written**, unlike D12, because the design already specifies
its own 4× headroom and the measured margin is far larger than that. Measured Large
map generation:

| Profile | Time | vs 50 ms target | vs 200 ms bound |
|---|---|---|---|
| debug | **1.0 ms** | 50× under | 200× under |
| release | **188 µs** | 266× under | 1064× under |

A 200× margin in the slowest profile makes a spurious failure implausible, so the
assertion carries real regression value (it would catch an accidentally quadratic
generation step) at negligible flake risk. Recorded because the *category* is one this
project otherwise rejects, and the decision to keep this instance is a judgement call
rather than an oversight.

### D22 — Surface conversion is per-batch, not per-destruction

**Spec**: `tasks/01-map.md` T1.7 step 3 says "Surface conversion pass (DIRT under AIR →
GRASS, hp=20) after destroy", and its Acceptance is "destroying a surface DIRT column
converts the new surface tile to GRASS". docs/01 §5 likewise: "after any destruction,
for every DIRT tile whose tile directly above is AIR → convert to GRASS (recompute hp
to 20)".

**Problem**: read literally — convert after *every* destruction — the pass is wrong
inside a blast. `apply_blast` damages many tiles in one call. If conversion ran per
tile, a DIRT tile that had already absorbed partial blast damage could be converted
mid-batch, which **resets its hp to 20** (the doc says "recompute hp to 20"). Whether
that happens depends on the order tiles are visited, so identical blasts would produce
different terrain depending on iteration order. That breaks determinism (docs/00 §2),
which outranks a literal reading of §5.

**Implemented**: two entry points, so the correct behaviour is the default and the
batch case is explicit rather than remembered:

- `Map::destroy_tile(x, y)` — destroys **and converts**. This is T1.7's contract
  verbatim, and is what any caller gets by default. T3.3 (hidden-item uncovery) and
  T4.6 (lava `clear_area`) can call it without knowing conversion exists.
- `Map::destroy_tile_deferred(x, y)` — destroys without converting, for callers that
  run `Map::apply_surface_conversion()` once at the end. Used by `apply_blast`.

The observable result for a single destruction is exactly what the doc specifies; the
result for a batch is order-independent. `surface_conversion_grass_on_air_above` now
asserts T1.7's Acceptance using only `destroy_tile` — an earlier version called
`apply_surface_conversion()` explicitly, which asserted this implementation's contract
instead of the documented behaviour.

*(Structure changed on review: conversion was originally omitted from `destroy_tile`
entirely, leaving every future caller responsible for remembering the second call.
That was a latent bug factory, and undocumented.)*

### D23 — Cosine interpolation uses platform `libm`, which is not bit-identical

**Spec**: `docs/01-map.md` §3 step 1 mandates "cosine interpolation between `v[i]` and
`v[i+1]`". `docs/00-architecture.md` §2 states the determinism rule unconditionally:
"`game-core` must produce identical state for the same (seed, tick count, input
sequence)".

**Problem**: `cosine_interpolate` calls `f32::cos`, which dispatches to the platform's
`libm`. Results may differ by 1 ULP between glibc, musl and macOS. A 1-ULP difference
in the interpolated noise can survive the `.round()` in `surface_rows` when a column's
height sits exactly on a `.5` boundary, changing that column's surface row by one tile
— and from there, every downstream RNG-consuming step diverges. So the map is
deterministic *on a given platform* but not necessarily *across* platforms.

**A compliant fix exists, and is cheap.** The [`libm`](https://crates.io/crates/libm)
crate is a pure-Rust port of MUSL's libm: it computes `cosf` in Rust, dispatching to no
platform libm at all, so it is bit-identical everywhere. Substituting `libm::cosf` for
`f32::cos` is **still exactly cosine interpolation** — the same function and the same
curve, nothing approximated or tabulated — so it does not conflict with docs/01 §3.

Verified rather than assumed:

- `libm v0.2.16` is **already compiled into `game-core`'s dependency tree**, via
  rapier2d → num-traits. Adopting it costs a direct dependency declaration on a crate
  already being built, and one changed identifier.
- The two implementations genuinely differ on this host: over 200,000 samples across
  `[0, π]`, `libm::cosf` and glibc's `f32::cos` disagree bitwise on **2,625 samples
  (1.3%)**, max delta **1 ULP**. So this is a real difference, not a theoretical one.

**Implemented**: the platform `f32::cos`, i.e. the status quo — but on the honest
ground, which is *not worth it yet*, **not** *impossible*. v1 runs one authoritative
server (docs/05 §1): all simulation happens in one process on one machine, and clients
receive `MapData` rather than regenerating maps, so cross-platform bit-equality buys
nothing for correctness today. It matters only for replaying a seed on a different
machine — a developer convenience.

**Note the cost is not static.** The golden hashes in `tests/determinism.rs` are
computed with the current `cos`; switching later invalidates them and any seed
recorded from a bug report. Since 1.3% of samples differ, the switch *will* change
generated maps. Migrating is one line plus a golden regeneration today, and strictly
more later.

**Pairs with the rapier `enhanced-determinism` decision due in T2.6.** Both are the
same question — how much cross-platform bit-equality the project wants — and should be
answered together. Whoever answers should know that **this half is attainable cheaply**;
the rapier half is the expensive one.

*(Correction: an earlier version of this entry claimed "there is no compliant way to
satisfy both, since any lookup-table or polynomial substitute would no longer be
'cosine interpolation'". That was wrong — `libm::cosf` is neither a lookup table nor a
polynomial substitute, it is the same function computed portably. The error mattered
because this entry explicitly defers a decision to T2.6, and would have told that
reader cross-platform determinism was unattainable when it is not.)*

---

## Phase 2 defects

### D25 — T2.1's spawn y formula buries the player one full tile

**Spec** (`tasks/02-player.md` T2.1 step 2): "place feet on tile top:
`y = (tile_y+1)*16 - body_half_height`".

**Problem**: the formula and its stated intent disagree. A tile at row `tile_y` spans
pixels `tile_y*16 ..= (tile_y+1)*16`, so `(tile_y+1)*16` is the tile's **bottom** edge,
not its top. `spawns` holds the GRASS tile itself (docs/01 §3 step 5: "candidates:
GRASS tiles with the 2 tiles above AIR"), and that tile is solid — so putting the feet
on its bottom edge sinks the body one full tile into solid ground, leaving only 12 px
of a 28 px body above the surface.

**Measured** (`game-core/examples/measure_spawn_formula.rs`, 100 seeds × 6 spawns,
Small):

| Formula | Body inside its own spawn tile |
|---|---|
| T2.1 literal, `y = (tile_y+1)*16 - half_h` | **600 / 600** |
| corrected, `y = tile_y*16 - half_h` | **0 / 600** |

**Implemented**: `y = tile_y*16 - BODY_HALF_HEIGHT`, which puts the feet on the tile's
top edge — matching docs/01 §3 step 5's "player placed so its feet rest on the tile
top" and T2.1's own Acceptance ("feet on tile top"). The prose is right; only the
formula is wrong. Guarded by `spawn_formula_does_not_bury_the_player`, verified to fail
if the literal formula is restored (3 tests fail).

### D26 — The spawn candidate rule checks one column; the body is 1.5 tiles wide

**Spec**: docs/01 §3 step 5 selects spawns as "GRASS tiles with the 2 tiles above AIR"
— a test on a **single column**. docs/07 §5 makes the player a **24×28** rect (D6),
i.e. 1.5 tiles wide.

**Problem**: a 24 px body centred on a 16 px tile always spans into both neighbouring
columns (from `centre-12` to `centre+12`, where the tile is only 16 px wide). Nothing in
the candidate rule examines those columns, so a spawn on a ledge or spire places the
body inside the adjacent terrain. The two-tile headroom check guarantees clearance
only in the column it inspects.

**Measured** (`game-core/examples/measure_spawn_fit.rs`, 100 seeds × 6 spawns):

| Scale | spawns | own-column overlap | **neighbour overlap** | max depth |
|---|---|---|---|---|
| Small | 600 | 0 | **421 (70.2%)** | 95.5 px |
| Medium | 600 | 0 | **462 (77.0%)** | 111.5 px |
| Large | 600 | 0 | **481 (80.2%)** | 175.5 px |

The own-column figure being exactly 0 confirms the doc's rule does what it says — it
is simply the wrong test for a body wider than one tile. Depths reach 11 tiles, i.e.
the spawn sits beside a tall spire the body is embedded in.

**Implemented**: the documented behaviour, unchanged. Fixing it means widening the
candidate rule in `find_spawns`, which is T1.5's code — outside T2.1's Files list
(docs/00 §8: "Do not refactor files outside the task's Files list") — and would
invalidate the golden map anchors. So it is recorded, not silently repaired.

**Consequence for T2.6**: rapier resolves the overlap by ejecting the body, so players
will visibly pop out of terrain on spawn rather than remaining stuck. That is a visual
defect, not a correctness one. The real fix belongs in `find_spawns`: require the body's
full width to clear, i.e. check columns `x-1 ..= x+1` for the two-tile headroom instead
of just `x`. Deferred, and noted in the handoff.

### D27 — T2.2's Test command selects none of the tests T2.2 creates

**Spec** (`tasks/02-player.md` T2.2 Test): `cd server && cargo test -p game-core input`.

**Problem**: `cargo test <filter>` matches on the full test path. T2.2's work lands in
`player.rs` (the task's own Files list says "player.rs (or `input.rs` if cleaner)"), so
its tests are `player::tests::*` — none of which contain the substring `input`. The
documented command ran exactly one test, `protocol::tests::input_frame_field_names_
match_doc`, which belongs to T0.2 and would pass whether or not T2.2 was implemented
at all.

This is the same class as D14 and the `spawn_spacing` filter noted in T1.5: the task
files specify Test commands that were never executed against the code they gate.
`docs/08-testing.md` §5 makes the Test command the definition of done, so a
non-selecting filter means a task can be marked complete on evidence unrelated to it.

**Implemented**: T2.2's tests live in `mod input_tests` inside `player.rs`, giving
paths `player::input_tests::*`. The documented command now selects all 8 of them
without changing the command, the file layout, or the task file.

*(Found by running the command and reading its output rather than assuming a passing
suite implied the right tests ran — the same discipline the Phase 1 handoff records.)*
