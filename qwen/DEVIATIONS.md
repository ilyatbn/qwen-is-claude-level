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

**Scheduled: fix before T4.1.** Not open-ended, and two parts of the original
rationale were weaker than they read:

- *"Invalidates the golden anchors"* is not a cost. That is the anchor system working
  as designed, and there is an established protocol for a deliberate re-pin (the same
  one already scheduled for T3.3's hidden items).
- *"A visual defect, not a correctness one"* rested on rapier ejecting the body — but
  at the time nothing in production drove `move_player` at all (see D32). Ejection
  direction out of a **175 px** overlap is undefined: a body embedded 11 tiles inside a
  spire can be pushed anywhere, including through it.

Phase 3 is unaffected: items are placed on surface tiles independently of spawns, and
pickup (16 px) and hit (12 px) geometry is relative to actual player position. Phase 4
is not — T4.1 wires physics into the round loop, and T4.3 makes "the spawn farthest
from living players" a scoring input, at which point spawn position stops being
cosmetic and starts deciding respawn fairness.

**The fix**: in `find_spawns`, require the body's full width to clear — check columns
`x-1 ..= x+1` for the two-tile headroom rather than just `x` — then re-pin the golden
anchors in the same commit.

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

**T2.1 had the same defect and was missed when this entry was first written.**
`cargo test -p game-core player::spawn` reported `0 passed; 144 filtered out` and
**exited 0** — there is no module named `spawn`, so a task gated on that command was
green while running none of its own tests. It kept the generic `mod tests` while
T2.2–T2.10 were given `input_tests` / `movement_tests` / `jump_tests` /
`jetpack_tests` / `fov_tests` precisely to fix this; the lesson was applied forward
and not backward. Renamed to `mod spawn_tests`.

Every Phase 0–2 Test command has now been run and its selection count recorded:
rng 10, `map::` 42, tiles 10, spawns 5, blast 9, `player::spawn` 9, input 10,
movement 9, jump 11, jetpack 8, physics 22, rebuild 8, fov 5. None select zero.

*(Found by running the command and reading its output rather than assuming a passing
suite implied the right tests ran — the same discipline the Phase 1 handoff records.
The T2.1 instance shows that discipline has to be applied as a sweep, not per task.)*

### D28 — T2.4's jump apex is only satisfiable with an integrator the design never names

**Spec** (`tasks/02-player.md` T2.4 step 4 / Acceptance): "`jump_arc` (from rest: apex
≈ 330²/(2*900) ≈ 60.5 px above start, within 2 px)"; "standing jump height ≈ 60 px
(assert 58–63)". T2.4 step 3 specifies only the velocity update: "Gravity:
`vel.y += 900*dt` always". Nothing states how position is integrated.

**Problem**: `v²/2g = 60.5 px` is the **continuous** apex. The simulation is a fixed
20 Hz tick (docs/00 §2), and at `dt = 0.05` the apex depends entirely on the
integration scheme — which the design leaves unspecified while asserting a value that
pins it. Measured:

| Integrator | Position update | Apex | T2.4's 58–63 |
|---|---|---|---|
| Semi-implicit (symplectic) Euler | `v += a·dt; x += v·dt` | **52.5 px** | FAIL |
| Explicit Euler | `x += v·dt; v += a·dt` | **69.0 px** | FAIL |
| **Velocity Verlet** | `x += v·dt + ½·a·dt²; v += a·dt` | **60.375 px** | **PASS** |

Semi-implicit Euler is the most common choice in game physics and the most natural
reading of "vel.y += 900*dt" followed by a position update — and it misses the
documented range by 5.5 px. Explicit Euler overshoots by 6 px.

**Implemented**: velocity Verlet, in `Player::integrate`. It is the only one of the
three that satisfies the documented assertion, and it is also the correct choice on
its own merits: for constant acceleration over a step it is exact, which is precisely
why it reproduces the continuous `v²/2g` the doc quotes. Gravity is constant here, so
Verlet costs one extra multiply-add per axis per tick and introduces no error.

The reasoning is recorded at `Player::integrate` so a future change to "simplify" the
integrator fails `jump_arc` with an explanation rather than a bare number. Verified:
switching to semi-implicit Euler fails with "jump apex 52.5 px is outside the
documented 58–63 range".

**Note for T2.6**: this is a further reason rapier cannot own player movement (D2).
Its solver uses its own integration, so routing movement through it would reintroduce
exactly this discrepancy — and would not be tunable back into the documented range.

### D29 — T2.6's anti-tunneling assertion is unsatisfiable, and would not prevent tunneling

**Spec** (`tasks/02-player.md` T2.6 Acceptance): "no tunneling at max fall speed
(terminal velocity cap 900 px/s — assert body never moves > 45 px in one tick)".

**Two independent problems.**

*It is at the boundary, then over it.* `900 px/s × 0.05 s = 45 px` exactly, so even
under the most favourable integrator the assertion sits on its own limit with no
margin. Under velocity Verlet — which D28 shows is the **only** integrator satisfying
T2.4's jump apex — one tick at terminal velocity is `900×0.05 + ½×900×0.05² =
46.125 px`. The two acceptances are mutually unsatisfiable: T2.4 forces Verlet, and
Verlet breaks T2.6's 45 px bound.

*It would not prevent tunneling even if met.* Tiles are 16 px (docs/01 §1). A 45 px
step crosses **2.9 tiles**. A displacement bound of 45 px permits jumping clean over a
two-tile floor; the only bound that would prevent tunneling by displacement alone is
one below the tile size, i.e. ≤16 px, which at 20 Hz would cap fall speed at 320 px/s —
a third of the documented terminal velocity.

**Implemented**: the property the acceptance was reaching for, by a mechanism that
actually provides it. Movement is resolved through rapier's
`KinematicCharacterController::move_shape`, which **shape-casts** the desired
translation rather than teleporting and testing afterwards. Tunneling is then
impossible at any speed, independent of per-tick displacement, so the displacement
bound stops being load-bearing.

`no_tunneling_at_terminal_velocity` asserts:
1. a body falling at terminal velocity never ends up below a one-tile floor — the real
   requirement;
2. fall speed stays at or under the documented 900 px/s cap;
3. per-tick displacement stays within 46.125 px, the true Verlet bound, recorded so a
   future integrator change is visible.

The doc's literal "> 45 px" is not asserted, because it is false under the integrator
the design's own jump assertion requires.

### D30 — Cross-platform bit-determinism: decided, deferred from D19/D23

**The question**, raised by D19 (hand-rolled RNG primitives), D23 (`f32::cos` via
platform libm) and now T2.6 (rapier): should `game-core` produce bit-identical results
across operating systems and CPU architectures?

docs/00 §2 states the determinism rule without qualification: "`game-core` must produce
identical state for the same (seed, tick count, input sequence)". The design never says
whether that means *on one machine* or *on all machines*, and the two have very
different costs.

**Decision: same-platform determinism is guaranteed; cross-platform is not.**

What that buys, and what it costs:

| Source | Cross-platform? | Cost to fix | Status |
|---|---|---|---|
| `GameRng` (ChaCha8 + hand-rolled shuffle/range) | **Yes, already** | — | D19, done |
| `libm::cosf` instead of `f32::cos` | No | ~1 line; crate already in tree; invalidates golden anchors | D23, **not taken** |
| rapier `enhanced-determinism` feature | No | Feature flag + perf cost; only covers rapier's own maths | **not taken** |

**Why this is the right call for v1.** docs/05 §1 makes the server the sole authority:
all simulation runs in one process on one machine, and clients receive `MapData` and
snapshots rather than re-simulating. Nothing in v1 compares results computed on two
different machines, so cross-platform bit-equality buys no correctness — only the
ability to replay a seed elsewhere, which is a developer convenience.

Note that rapier's exposure here is **much smaller than it looks**, because D2 already
confines it to collision resolution: it never integrates player motion, so it cannot
drift the documented movement numbers. Enabling `enhanced-determinism` would constrain
only the collision-resolution path while costing performance on every query.

**D32 narrows this further, and was written after this entry.** Rapier's output
re-enters simulation state at exactly one place — `Player::apply_collision` — through a
per-axis comparison of achieved translation against desired. So the determinism surface
is not "rapier computes positions" but "a float comparison decides whether an axis was
blocked". A platform difference must flip that comparison's outcome, not merely perturb
a float, before it can change the simulation. That is a materially smaller and more
robust surface than it appeared when this decision was taken, and it makes the
"not worth it yet" call safer, not more precarious.

**What would force a revisit** — any one of these makes the decision wrong:
1. a second server platform (a musl container image alongside a glibc dev box, or an
   ARM host) running rounds whose results are compared;
2. cross-machine replay becoming a real workflow — e.g. reproducing a player's bug
   report locally from a seed and input log;
3. client-side prediction that re-simulates `game-core` in WASM, where the client's
   maths must match the server's exactly.

**The cost of deferring is not flat.** Both fixes invalidate the golden anchors in
`tests/determinism.rs` and any seed recorded from a bug report; the `cos` swap changes
1.3% of noise samples and therefore generated maps. Migrating is cheap today and
strictly more expensive after Phase 3 adds item placement and Phase 4 adds effect
schedules to the seeded stream.

### D31 — The FOV formula is implemented twice; the copies are pinned to a shared fixture

**Spec**: `docs/03-player.md` §7 defines the FOV formula. `docs/08-testing.md` §3 then
requires the client implement it independently: "`fov.ts`: same formula as server (copy
of the math) — assert night/fog/health/flashlight cases match docs/03 §7 values."

**Problem**: the design *mandates* duplicating a formula across two languages. That is
the same drift hazard docs/06 explicitly guards against for the protocol ("when a task
changes a message, it updates BOTH files"), except here there is no corresponding
instruction — nothing says to update both copies of the FOV maths, and nothing detects
it if you don't.

Two hand-written test tables do not solve it. Each side's table would be written from
the same doc, and a wrong change on one side gets a matching wrong table, so both
suites stay green while server and client disagree about what a player can see. The
symptom in play would be a remote player rendered inside your darkness mask, or
invisible when they should be lit — hard to attribute and impossible to reproduce from
a unit test.

**Implemented**: one source of truth, generated. `game-core/examples/fov_vectors.rs`
evaluates `Player::compute_fov` over 12 cases spanning every branch (day, night,
half-phase, fog, low health, the exact 50 hp boundary, flashlight with and without fog
and low health) and writes `client/src/logic/fov-vectors.json`. The Rust test table and
the client's `fov.test.ts` both assert against those vectors. The client fixture is
committed, so CI needs no Rust step.

Verified in **both** directions:

| Injection | Result |
|---|---|
| TS-only change (`FOV_NIGHT_MIN` 0.45 → 0.50) | **6 TS tests fail** |
| Rust-only change (`FOV_LOW_HEALTH_FACTOR` 0.7 → 0.8) | Rust test fails; and after regenerating the fixture from the changed Rust, **4 TS tests still fail** |

The second row is the one that matters: regenerating the fixture does **not** launder a
one-sided change, because the client's implementation still disagrees with the new
vectors. Both copies must be changed for the suite to go green — which is exactly the
"update BOTH files" discipline docs/06 states for the protocol and omits here.

Regenerate deliberately, when the formula changes on purpose:
`cargo run -p game-core --example fov_vectors`.

### D32 — The collision→velocity rule is load-bearing and undocumented

**Spec**: `docs/03-player.md` describes movement, jump, jetpack and gravity, and
docs/00 §5 says players are rigid bodies whose collisions rapier resolves. **Neither
says what happens to a player's velocity when terrain stops its motion.**

**Problem**: without an explicit rule, a player resting on the ground gains
`GRAVITY * dt` every tick, forever. Position never changes — collision keeps stopping
it — so nothing looks wrong from the outside while `vel.y` grows without bound. The
first time the ground underneath is destroyed, the player is launched through the map
at whatever `clamp_fall_speed` permits. Measured with the rule removed: **`vel.y` = 900
(pinned at the terminal-velocity cap) after 200 ticks of standing still.**

This is not an implementation detail. It is the physics of landing, and any
reimplementation that follows docs/03 faithfully will still get it wrong.

**Implemented**: `Player::apply_collision` zeroes the velocity component along any axis
where terrain stopped the move — comparing the achieved translation against the desired
one per axis, with an epsilon so that *sliding* along a wall (which still travels, just
less far) is treated as blocked while an unobstructed move is not.

**Where it sits matters.** This is the **single point** at which rapier's output
re-enters pure simulation state: one comparison per axis, on a value rapier already
computed. Nothing else rapier produces is stored — not its `grounded` flag (advisory;
the tile probe is authoritative per T2.6 step 3), not any dynamics, because none run.

That materially strengthens D30's argument rather than weakening it. The
cross-platform determinism surface for collision is not "rapier computes player
positions"; it is "rapier's translation is compared against the desired one, per axis".
A platform difference would have to change that comparison's *outcome* — flip a
blocked axis to unblocked — not merely perturb a float, before it could alter
simulation state.

**Also fixed by this entry**: the whole per-tick sequence previously existed **only in
a test helper**. `Player::integrate` and `PhysicsWorld::move_player` were never joined
in production code, so the shipped binary could not land a player, and
`player_falls_and_lands` / `player_falls_into_hole` /
`no_tunneling_at_terminal_velocity` were validating a test-only implementation.
`Player::step_tick` is now the production sequence — probe → jump → jetpack →
horizontal → integrate → clamp → resolve — and the tests call it, so they exercise
shipped code and T4.1 inherits the semantics instead of re-deriving them.

### D33 — Step order in the tick is load-bearing: jump must follow horizontal

**Spec** (`docs/03-player.md` §4): "On ground ... A/D set horizontal velocity to
±MOVE_SPEED directly" and "Jump (rising edge of space, on ground): apply JUMP_VY
impulse; **if A or D held, also set horizontal vel to ±(MOVE_SPEED × JUMP_DIR_BIAS)**".

**Problem**: both rules *set* `vel.x` on a grounded player, so whichever runs second
wins. The doc describes the jump as overriding ("also set"), which only holds if the
jump is applied after the ground rule. Nothing in docs/03 states the ordering.

**How it was found — and why this entry exists**: promoting the per-tick sequence out
of a test helper (D32) reordered these steps, and a directional jump began launching at
**140 px/s instead of the documented 70**. All 146 tests passed before and after. The
old helper never passed `jump_pressed: true` — it only exercised jetpack and horizontal
— and every jump test called `step_jump` directly, so no test jumped through the
production tick. The regression lived in the one dimension nothing observed.

**Implemented**: `step_tick` runs **horizontal → jetpack → jump**, with the reason
stated at the call site. `directional_jump_through_step_tick_uses_the_documented_bias`
asserts the literal 70.0 through the production path; restoring the old order fails it
with "gave vel.x 140, expected 70 (the ground rule overwrote the bias)".

`mod step_tick_tests` now exercises **every** input field through `step_tick` rather
than through the individual step functions: jump edges (with and without), directional
jump both ways, walking distance, jetpack on the jump tick, held-space jetpack in the
air, W/S assist, aim (including NaN rejection), ceiling collision, and ground-state
reporting.

### D34 — Combined-axis collision silently cost 20% of walking speed

**Spec**: docs/03 §4 sets ground speed at `MOVE_SPEED = 140 px/s`; T2.3's Acceptance
pins it as "Δx over 10 ticks = 70 px".

**Problem**: that assertion was only ever checked on the **pure** path. Through the
production tick it was false. `apply_collision` passed the full desired translation to
rapier's character controller in one call, and when a resting player's downward gravity
component was being resolved, the controller intermittently consumed its entire budget
on the vertical contact and returned **zero** horizontal movement.

Measured on flat ground: **56 px per 10 ticks instead of 70** — whole ticks dropped
(ticks 1 and 7 of 10 moved 0 px), a silent 20% speed loss. Probing `move_player`
directly showed it is not position-dependent: `desired = (7.0, 0.0)` passes through
intact, while `(7.0, anything > 0)` from a body resting 0.005 px above the surface
returns `(0.0, -0.0001)`. Adjusting the controller `offset` — absolute 0.01/0.1/0.5 and
relative 0.01 — changed nothing.

**Implemented**: the two axes are resolved in **separate shape-casts** — horizontal
first, then vertical from the updated position. This is the standard resolution order
for tile platformers, and it has three benefits here:

1. horizontal motion no longer depends on how the vertical contact resolves — walking
   is exactly 7.0 px per tick, 30 ticks running;
2. "which axis was blocked" becomes exact rather than inferred from a combined
   translation, which is precisely what D32's per-axis velocity rule needs;
3. anti-tunneling (D29) is unaffected — each call is still a swept cast.

Re-verified against the changed path: no tunneling through a 1-tile floor at 45,
46.125, 100, 500, 2000 or **10,000 px/tick**, nor through a 1×1 ledge at 5,000;
resting drift −0.009 px over 200 ticks with `vel.y` exactly 0; and a player whose floor
is destroyed falls 80 px and is caught by the floor below. Guarded by
`walking_on_flat_ground_loses_no_distance` (per-tick, not just the total, so a dropped
tick cannot be averaged away) and `walking_into_a_wall_still_falls` (axis independence).

### D35 — Ground speed is slope-dependent; T2.3's "exactly 140 px/s" is a flat-ground property

**Spec** (`tasks/02-player.md` T2.3 Acceptance): "movement speed is exactly 140 px/s
(assert Δx over 10 ticks = 70 px)". docs/03 §4: "On ground ... A/D set horizontal
velocity to ±MOVE_SPEED directly".

**Observation**: horizontal distance per tick varies with terrain slope. Measured on
synthetic staircase terrain with a settled body (`examples/probe_slope.rs`, 10 ticks,
flat expectation 70.000 px):

| terrain | Δx / 10 ticks | px/tick | airborne ticks | max &#124;vel.x&#124; |
|---|---|---|---|---|
| flat | 70.000 | 7.000 | 0/10 | 140.0 |
| downhill 1 tile / 4 cols | 70.000 | 7.000 | 0/10 | 140.0 |
| downhill 1 tile / 2 cols | **73.000** | 7.300 | 4/10 | 140.0 |
| downhill 1 tile / 1 col | **74.500** | 7.450 | 6/10 | 140.0 |
| uphill 1 tile / 4 cols | **51.990** | 5.199 | 0/10 | 140.0 |
| uphill 1 tile / 2 cols | **19.990** | 1.999 | 0/10 | 140.0 |
| uphill 1 tile / 1 col | **3.990** | 0.399 | 0/10 | 0.0 |

**Mechanism — it is not slope-sliding.** `max|vel.x|` is exactly 140.0 in every row, and
`apply_collision` discards the vertical cast's horizontal component by construction
(D34). The cause is Verlet's acceleration term on **airborne** ticks: stepping off each
stair edge reads airborne, so `step_horizontal` *returns* `AIR_ACCEL = 600` instead of
*setting* velocity, and `integrate` adds `½·a·dt² = ½·600·0.05² = 0.75 px` that tick.

- grounded tick: 7.00 px
- airborne tick: 7.75 px

The arithmetic closes exactly: 4 airborne → `6×7.00 + 4×7.75 = 73.000`; 6 airborne →
`4×7.00 + 6×7.75 = 74.500`. Both match measurement to three decimals.

Over a long traverse it compounds and then stabilises — 200 ticks on 1-tile-per-2-column
downhill gave 1418.59 px against a flat expectation of 1400.00, a ratio of **1.013**.

The uphill rows are a different effect entirely: the body is blocked by each riser and
loses horizontal distance to the collision, down to a standstill at 1 tile per column
(D36).

**Verdict: not a violation, but an unrecorded qualification.** docs/03 §4 is honoured
literally in both branches — grounded sets exactly ±140, airborne accelerates toward
`AIR_MAX = 140` and never exceeds it. The excess *displacement* is correct velocity
Verlet integration, which D28 established as mandatory for T2.4's jump apex. What is
undocumented is that **T2.3's acceptance is a flat-ground property**. It passes because
`walking_on_flat_ground_loses_no_distance` and `player_walks_on_ground` both use a flat
map; on any real generated map, "exactly 140 px/s" is not the observed speed.

No code change. Recorded so nobody later "fixes" a 7.45 px tick as a bug, and so the
T2.3 assertion is not mistaken for a global invariant.

### D36 — A player cannot walk up a single 16 px step

**Spec**: nothing in docs/01 or docs/03 states whether terrain steps are walkable. The
design assumes Worms-style traversal without describing how vertical terrain is
negotiated.

**Observation** (`examples/probe_slope.rs`): walking right into a step of any height,
80 ticks, body half-width 12:

| step rise | result |
|---|---|
| 1 tile (16 px) | reached x = 388.0, edge at 400.0 → **BLOCKED** |
| 2 tiles (32 px) | reached x = 388.0 → **BLOCKED** |
| 3 tiles (48 px) | reached x = 388.0 → **BLOCKED** |
| 1 tile, jumping periodically | reached x = 883.2 → **CLEARED** |

`388.0 + BODY_HALF_WIDTH 12 = 400.0` exactly: the body comes to rest flush against the
riser and stays there indefinitely.

**Cause**: `autostep: None` in `PhysicsWorld::new`. That was a deliberate choice, argued
at the time as "either would silently move the player in ways the documented numbers do
not describe" — sound in isolation, since autostep teleports the body upward outside the
documented movement rules.

**Consequence**: docs/01 §3's heightmap produces per-column steps continuously, and D3
measured adjacent-column deltas up to **7 / 10 / 14 tiles** on Small / Medium / Large.
So in practice *every* upward terrain feature requires a jump. That is a legitimate
movement model — Worms itself is jump-heavy — but no document states it and nobody has
chosen it.

**No code change now. This is a Phase 4 decision**, to be taken at T4.1:

1. **Enable a small autostep** (one tile, 16 px), accepting that the body moves
   vertically outside the documented rules; or
2. **Accept jump-to-climb** as the movement model, and record it as intended.

It shares the ejection path with D26 (spawn overlap) and the tick sequence with D35, so
all three should be decided together rather than piecemeal.

---

## Phase 3 defects

### D37 — Spawn weights are stated as percentages but sum to 130

**Spec** (`docs/04-items.md` §3 row A): "Weighted pick: **weapons 50%** (pistol 30 /
shotgun 20 / rocket 15 / grenade 15), medkit 20%, shield 10%, overcharge 10%,
flashlight 10%." Row B: "same as A but flashlight 20%".

**Two problems.**

*The itemised numbers contradict the stated total.* Pistol 30 + shotgun 20 + rocket 15
+ grenade 15 = **80**, not the "weapons 50%" the same sentence claims.

*Nothing sums to 100.* The full row A list totals **130** (80 weapons + 20 medkit + 10
shield + 10 overcharge + 10 flashlight), so they cannot be percentages. Row B totals
**140**.

**Implemented**: treated as relative **weights**, which is the only reading under which
the numbers are self-consistent. A pistol is drawn 30/130 ≈ 23% of the time, not 30%.
The "weapons 50%" clause is ignored as unimplementable — honouring it would require
rescaling every itemised weight, and the doc gives no basis for choosing which.

One visible consequence: because row B raises the total to 140 rather than
redistributing, doubling the flashlight's weight from 10 to 20 makes it **1.86×** more
likely in rock pockets, not 2×. Measured over 60,000 draws per table. Asserted as a
band rather than an exact ratio, with the reason recorded in the test.

### D38 — An anchor's coverage boundary can silently differ from its apparent scope

**Not a spec defect — a testing-method finding, recorded because Phase 4 will walk into
it again.**

At the end of Phase 2, `Tile.item` was added to `golden_hash` with the stated intent
that "T3.3's hidden-item placement is anchored the moment it writes one", and the
handoff predicted `generation_matches_golden_hashes` would fail at T3.3 and need a
deliberate re-pin.

It did not fail. `Map::generate` never writes `Tile.item` — `place_hidden` is a
**separate round-start step** (docs/04 §6 step 5), run after generation. So the field
was hashed, but always as `None`. The anchor was extended in form and not in substance,
and hidden-item placement went in completely unpinned.

**This is a distinct variant of the recurring class.** The others were tests that
*could not fail*:

- self-referential assertions (jetpack assist, air control),
- assertions on an output invariant under the bug (rebuild scope, the D22 blast test),
- a deleted test.

This one *could* fail — it just could never fail **for the thing everyone assumed it
covered**. The gap is between an anchor's real coverage boundary and its apparent one,
and a passing suite looks identical either way. The prediction that it would break was
itself the tell: when an anchor is expected to fail and doesn't, that is evidence about
coverage, not luck.

**Closed** by `item_placement_matches_golden_hashes`, a literal anchor over sources A
and B. Verified to discriminate: a wasted `next_u32()` in `place_hidden` fails it and
the second, independent draw-order test, while both *map* anchors correctly stay green
because map generation genuinely did not change.

**The trap is still open for Phase 4.** Round start gains more steps outside
`Map::generate` — spawn shuffling (T4.1) and the effect schedule (T4.8), both
determinism-critical per docs/04 §6. Each needs its own anchor; neither will be covered
by the map hash, and neither will announce that.

**Rule**: when adding a field to an existing anchor to cover a new subsystem, assert
that the anchor *changes* when that subsystem runs. If it does not, the subsystem is
outside the anchor's boundary and needs its own.

### D39 — Projectiles use tile lookup, not the player's shape-cast collision

**Spec** (`docs/04-items.md` §2): "Stepped per tick: move, check tile collision (**tile
under new pos solid** → impact), check player hit (circle vs player body 12 px radius →
damage)."

**The choice**: the player's collision path resolves two swept shape-casts per tick
(D34) and treats the body as a 24×28 AABB. Projectiles could reuse it. They do not.

**Implemented**: a point-sample tile lookup at the projectile's new position, exactly as
docs/04 §2 specifies, plus a circle test against each player. Reasons, in order:

1. **The doc says so.** "Tile under new pos solid" is a point lookup; a shape cast is a
   different test that would stop projectiles at different places.
2. **Projectiles are points, not bodies.** They have no width in the catalog — only
   `impact_radius`, which is the *blast* on detonation, not a collision hull.
3. **Cost.** Up to 24 live projectiles (docs/04 §2) × 20 Hz, against one player body per
   tick. A shape cast each would be ~24× the collision work for no documented gain.

**What it costs — measured, not estimated.** Projectiles tunnel. Swept across 64
sub-tile starting offsets (`examples/probe_tunnel_proj.rs`) so the result is not an
alignment artefact, firing at a **single-tile wall** 80 px away:

| weapon | px/tick | hits the wall | passes through |
|---|---|---|---|
| pistol | 35.0 | **24 / 64** | **62.5%** |
| shotgun | 30.0 | 24 / 64 | 62.5% |
| rocket | 25.0 | 44 / 64 | 31.3% |
| grenade | 20.0 | 0 / 64 | — gravity carries it under the sample line; discount |

The pistol — the starting weapon — passes through a solid single-tile wall in **five of
every eight shots**, and a 12 px player standing on the line is missed at a comparable
rate depending on range. This is the same failure D29 fixed for players, and it is
against the game's central mechanic (destructible terrain), not an edge case at extreme
speed.

*(The wall figures above reproduce an independent measurement exactly. The
player-on-the-line figure is sensitive to the target's distance, since it depends on
where the per-tick samples happen to land, so it is described qualitatively rather than
as a single number.)*

**DECISION: fix at T4.1.** This entry stays as the record that **qwen's spec specified a
point lookup** — that is the experiment's finding and must not be erased — but the
behaviour will not ship. Three reasons:

1. **Precedent inside this build.** D29 was the identical situation for players: a
   documented rule ("never moves > 45 px in one tick") expressing an intent the
   mechanism could not deliver, resolved by providing the property the acceptance was
   reaching for. docs/04 §2's "tile under new pos solid → impact" is plainly *trying*
   to say "the projectile hits terrain"; a point sample fails to express that exactly
   as a 45 px bound failed to express "no tunneling".
2. **The cost is near zero.** `PhysicsWorld` and swept casts already exist and are
   already trusted on the player path. Sub-stepping the tile lookup along the segment
   is even cheaper and is arguably still "tile under new pos".
3. **It will bite T4.10.** That integration test asserts P1's rocket kills P2. At
   25 px/tick the rocket carries a ~5% miss rate depending on spawn alignment — a flaky
   headline test that would be misdiagnosed as a networking fault.

Grouped with D26, D35 and D36 as a **Phase 4 prerequisite**: all four are
collision-geometry decisions on one code path and should be taken together.

Gravity for thrown weapons uses the same velocity Verlet as the player (D28), so
acceleration is integrated identically everywhere in the crate.

### D40 — The grenade's range and fuse conflict; the fuse governs

**Spec**: `docs/04-items.md` §1 lists the grenade's Range as "**400 (throw)**", and the
`ItemDef` comment defines `range` as "px, projectile lifetime distance". But §4 says the
grenade "explodes after **1.5 s** or on second touch" and never mentions range.

**Problem**: applying both terminates the grenade on whichever comes first, and range
wins. Measured: a grenade thrown at its documented 400 px/s expires on range at **tick
26**, before the 1.5 s fuse at tick 30 — so the documented fuse would never fire in open
air, and "explodes after 1.5 s" would be dead text.

**Implemented**: for thrown weapons the **fuse governs** and range is not applied as a
lifetime. The "(throw)" annotation is read as a throw *distance* — how far the arc
carries — rather than a hard cutoff, which is the only reading under which §1 and §4 are
both satisfiable. Non-thrown weapons still expire on range exactly as documented.

*(Found because the fuse test measured 26 ticks instead of 30. Both of my first two
attempts at that test then passed for the wrong reason — thrown upward the grenade left
the map, and parked on a Small map it fell out of the bottom at tick 29 — so injecting
the fuse 1.5 → 3.0 s failed zero tests twice. It now runs on a Large empty map and
asserts `fuse_s <= 0` at termination, proving the fuse is what ended it.)*

### D41 — A player standing on a tile cannot pick up the item on that tile

**Spec**: docs/04 §3 places ground items at the **tile centre**; docs/01 §3.5 and T2.1
rest the player's **feet on the tile top**; docs/04 §5 sets the pickup radius to
**16 px**; D6 fixes the body at 24×28.

**Problem**: those four numbers are jointly unsatisfiable. Item centre sits at
`(ty+0.5)*16`, player centre at `ty*16 - 14`, so the separation is always
`BODY_HALF_HEIGHT + TILE_SIZE/2` = `14 + 8` = **22 px**, against a 16 px radius —
short by 6 px, at every tile, on every map. Measured end to end: **0 of 500 source-A
items reachable across 50 maps**. Supply crates escape only by accident, landing on the
tile *top* (14 px separation) rather than its centre.

Any *two* of {tile-centre placement, 16 px radius, 28 px body} are consistent. All
three are not.

**Why no unit test caught it**: every pickup test positioned the player *at* the item
or within 16 px directly, rather than deriving the player's position from where a
player actually stands. The subsystems are each individually correct; the defect lives
in the seam between them.

**Status**: **not fixed** — recorded for Phase 4. The minimal fix is to place ground
items at the tile top like crates, or widen the pickup radius to ≥22 px. Both change a
documented number, so it is a decision, not a patch.

### D42 — Rocket damage exactly equals STONE's hp, and no weapon can break ROCK

**Spec**: docs/01 §2 gives tile hp GRASS 20 / DIRT 30 / STONE 60 / ROCK 80. docs/04 §1
gives the rocket 60 damage at 48 px and the grenade 45 at 40 px, with falloff
`dmg = max_damage * (1 - dist/radius)` (docs/01 §5).

**Problem**: the rocket's maximum damage is **exactly** STONE's hp, so stone is
destroyed only by a tile whose centre is at distance 0 — a measured crater of **5 tiles**
underground. More seriously, **no weapon in the game can destroy ROCK (80 hp)**: the
strongest is the rocket at 60. The meteor (docs/02 §4) also uses 60.

**Consequence**: source-B hidden items are placed inside ROCK tiles (docs/04 §3 row B)
and are uncovered only by destroying that tile. If nothing reaches 80 damage, **4 items
per round are permanently unreachable** and a documented item source is dead content.

**Status**: **not fixed** — recorded for Phase 4, and it needs verifying against the
weather effects once T4.5/T4.6 exist. This is a design-level consequence of qwen's own
numbers, not an implementation choice.
