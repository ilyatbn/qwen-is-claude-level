# 60 — Testing strategy

Every component is built and unit tested before the next one starts. That ordering
is a requirement of this project, not a preference: map generation is validated
headlessly before a single pixel is drawn, movement is validated headlessly before
it is networked, and the server is wired to components that already work.

---

## 1. Where tests live

| Layer | Tool | Location |
|---|---|---|
| `game-core` | `cargo test` | `#[cfg(test)] mod tests` in the same file |
| `game-core` sweeps | `proptest` | `crates/game-core/tests/` |
| `game-server` | `cargo test` | `crates/game-server/tests/` (integration, real sockets) |
| Client pure logic | `vitest` | `client/src/**/*.test.ts`, beside the source |
| Client rendering | eyes | the M3 sandbox scene |

In-file unit tests matter for the small-context workflow: a task opens one file and
finds its tests already there, with no second file to locate.

## 2. The gate

`scripts/check.sh`, and nothing is "done" until it is green:

```sh
cargo fmt --all -- --check
cargo clippy --all-targets --all-features -- -D warnings
cargo test --workspace
npm --prefix client run typecheck      # tsc --noEmit
npm --prefix client test -- --run      # vitest
```

`-D warnings` is deliberate. On a project built one small task at a time, warnings
accumulate invisibly until nobody reads them.

## 3. What gets tested where

### Map generation (M1) — the deepest coverage in the project

- **Determinism**: one seed → one mask hash, 100 repetitions.
- **Sub-stream isolation**: exhausting the `"items"` RNG does not change the terrain.
- **Border invariants**, asserted after *every* pass, not just at the end: bedrock
  rows solid, wall columns solid, sky rows empty.
- **Playability**, over a 1000-seed `proptest` sweep at all three scales:
  - the largest surface component covers ≥ `MIN_TRAVERSABLE_FRACTION`;
  - at least `SPAWN_COUNT_MIN` valid, separated spawn points exist;
  - `attempts <= 3` and `used_safe_preset == false`.
- **Golden hashes**: a committed table of `(seed, scale) → blake3(mask)`. Any
  unintended generator change breaks it loudly. Intentional changes regenerate the
  table, and the task must say so.
- **PNG dump**: `cargo test --features dump-png` writes maps to `target/mapdump/`.
  This is the honest test for "does it look like Worms" — it is a human judgement
  and pretending otherwise would be worse.

### Destruction (M1)

Idempotence, bedrock and wall exclusion, exact coarse-grid maintenance after 500
random carves, exact dirty-chunk sets, buried-slot reveal boundaries, no panic
out of bounds. Full list in `11-map-destruction.md` §8.

### Physics (M2)

Scenario tests against small hand-built masks — a flat floor, a 6-px step, a 20-px
wall, a 45° ramp, a 1-px spike. The critical one is **no tunnelling**: a body at
10× terminal velocity must be stopped by a 1-px wall, on every axis, in both
directions. Full list in `20-player-movement.md` §8.

### Items and combat (M4)

Stack merging, full-inventory refusal, verb/kind validation, cooldowns, tie
resolution when two players reach one item on the same tick, explosion falloff
endpoints, grenade rest (no jitter), self-damage attribution. Lists in
`30-items-inventory.md` §7, `31-weapons-combat.md` §7, `32-item-spawning.md` §8.

### Effects and cycle (M5)

Scheduler determinism, no effects during warmup or overrunning the round, exact
hazard counts and damage totals, FoV formula endpoints, cycle continuity. Lists in
`13-weather-effects.md` §8 and `14-daynight-visibility.md` §7.

### Protocol (M6)

Codec round-trips as property tests, exact snapshot sizes, RLE round-trip including
the pathological alternating-pixel mask, duplicate and out-of-order sequence
handling, and **decoder fuzzing**: random byte strings must be rejected without
panicking. A panic in a decoder is a remote crash.

### Server (M6)

Integration tests with a real server on an ephemeral port and real socket.io
clients: join flow, room capacity, snapshot cadence, phase transitions on a
shortened round, no damage during warmup, restart voting, and the important one —
**two clients' masks hash identically after 100 real carves**.

### Client (M3, M6)

Only pure logic is unit tested: RLE decode, snapshot decode, interpolation and its
bracketing, reconciliation replay, aim quantisation, inventory reducers, skin
resolution, animation-state derivation. Anything touching a Phaser scene is
validated in the sandbox instead — testing a renderer through a headless canvas
costs more than it catches.

## 4. Determinism as a test subject

Determinism is not an implementation detail here; it is the property everything
else leans on. Replays, golden hashes, reproducible bug reports and identical masks
across clients all fail together if it breaks. It is tested at three levels:

1. `apply_input` is pure — same state, same input, byte-identical result.
2. Map generation is stable per seed and isolated per sub-stream.
3. A recorded replay re-simulated headlessly reproduces the final world state hash
   (`61-logging-debug.md` §4).

If test 3 passes, the other two almost certainly do — which makes it the single
best regression test in the project.

## 5. The sandbox scene (M3)

Not a test suite, but the primary development tool from M3 onward. It runs
`game-core` in the browser with no server:

- seed input and regenerate button;
- map scale switcher;
- click to carve, with an adjustable radius;
- chunk-boundary and coarse-grid overlays;
- collision-box and surface-point overlays;
- a movement state readout (grounded, velocity, fuel, state);
- bakes/frame and ms/bake counters;
- day/night and fog sliders, so visibility can be checked without waiting.

It stays in the build after M6 as a debugging tool, behind a `?sandbox=1` flag.

## 6. Performance checks

Not benchmarks, just assertions with generous ceilings, so a 50× regression is
caught and normal variance is not:

| Check | Ceiling |
|---|---|
| Medium map generation | < 1000 ms in release |
| 500 random carves | < 100 ms |
| 6 players + 20 projectiles, one tick | < 2 ms |
| Full 72-chunk bake at round start | < 400 ms (measured in the sandbox) |
| Single chunk rebake | < 4 ms |

## 7. What is deliberately not tested

- Phaser rendering output — no pixel-diff tests. Too brittle, too slow.
- Visual quality of generated maps — human judgement via PNG dumps.
- Real network conditions — no packet-loss simulation harness in v1. The debug HUD
  exposes the numbers instead; a proper harness is future work.
- Load beyond 6 players — out of scope for v1.

Saying so explicitly is better than letting these look like oversights.

## 8. Per-task discipline

Every task in `tasks/` names:

- the tests to write, by name;
- the exact command that proves it (`cargo test -p game-core carve`);
- a **Done when** line that the task is not finished without.

A task that cannot state how it will be verified is mis-scoped, and should be
reported rather than implemented.

## 9. Future work

- CI on push: `check.sh` plus the 1000-seed sweep on a schedule (it is too slow for
  every commit).
- Mutation testing on `game-core`, where the tests claim the most confidence.
- A network-conditions harness (latency, jitter, loss) driving the integration tests.
- Criterion benchmarks for map generation and the tick loop.
