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

### D3 — T1.3's smoothness bound may be mathematically unsafe

**Spec** (`tasks/01-map.md` T1.3 step 3): "adjacent columns differ by ≤ 8 tiles".

**Problem**: with `h = H*0.35 + H*0.22*(0.7*n8 + 0.3*n3)` and cosine interpolation, the
worst-case single-column delta is ≈ `0.126*H` → ~8.1 tiles (Small, H=64), ~12.1
(Medium, H=96), ~16.1 (Large, H=128). A fixed bound of 8 is only plausible at the
smallest scale, and only just.

**Implemented**: to be measured empirically over the 100-seed × 3-scale suite. If the
fixed bound fails, it is relaxed to a scale-relative bound and the measured maximum is
recorded here. *(Resolution pending — Phase 1.)*

### D4 — Toxic rain spot window is inconsistent

**Spec**: `docs/02-map-effects.md` §3 says 5 spots, spot `i` starting at `i*1.2 s`,
each lasting 4 s, within an 8 s effect. `tasks/04-rounds.md` T4.4 asserts "spot 4 ends
at 8 s".

**Problem**: spot 4 starts at `4*1.2 = 4.8 s` and would run to `8.8 s` — past the end
of the 8 s effect, contradicting the assertion.

**Implemented**: every spot's life is clamped to the 8 s effect window. Spot 4 lives
3.2 s (4.8 → 8.0). The doc's "so the 8 s window covers all" is read as intent that the
window is the authority.

### D5 — Pocket size assertion can fail from pocket merging

**Spec** (`tasks/01-map.md` T1.4 step 4): "each connected ROCK component ≤ 15 tiles".

**Problem**: a random walk of up to 12 steps marks up to 13 tiles for a single pocket,
which is within 15 — but nothing stops two of the 20 pockets on a Large map from
landing adjacent and merging into one connected component larger than 15.

**Implemented**: per-pocket size is asserted at generation time (the property the walk
actually guarantees). The connected-component bound is recorded as measured rather than
asserted at 15. *(Exact resolution recorded in Phase 1.)*

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

**Implemented**: `GameRng` spells out Fisher–Yates (exactly `n-1` draws for length
`n`) and derives `random_unit` from the top 24 bits of one `u32`. Map output now
depends only on ChaCha8 — a stable, specified stream — plus code in `rng.rs`. A test
(`shuffle_consumes_one_draw_per_element_after_the_first`) pins the draw count.
