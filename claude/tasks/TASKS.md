# Master task list

101 tasks across 9 milestones. Work them **in order**. See `README.md` for the
loop and `../CLAUDE.md` for the rules.

Tasks marked **(v2)** come from `docs/70-amendments-v2.md`, which overrides the
earlier docs where they disagree. Read it before starting M1.

Tick a box only when the task's **Done when** command passes.

---

## M0 — Foundation (8)

Stand up the workspace, the shared constants, the server skeleton and the client
skeleton. Nothing is a game yet; everything has a home.

- [x] [T0.01](M0/T0.01-workspace.md) — Cargo workspace and three crate skeletons
- [x] [T0.02](M0/T0.02-constants.md) — `constants.rs` mirroring `docs/02-constants.md`
- [ ] [T0.03](M0/T0.03-rng.md) — Seeded RNG and sub-stream derivation
- [ ] [T0.04](M0/T0.04-math.md) — `Vec2`, `Aabb`, and small maths helpers
- [ ] [T0.05](M0/T0.05-server-skeleton.md) — axum + socketioxide + tracing, `/healthz`, echo
- [ ] [T0.06](M0/T0.06-client-skeleton.md) — Vite + TS + Phaser 3.90 + socket.io connect
- [ ] [T0.07](M0/T0.07-docker.md) — Dockerfiles, compose, nginx, `.env.example`
- [ ] [T0.08](M0/T0.08-check-script.md) — `scripts/check.sh`, the gate

**Checkpoint:** `cargo run -p game-server` and `npm --prefix client run dev` — the
browser console logs an echo round-trip. `./scripts/check.sh` is green.

---

## M1 — Map generation and destruction (16)

The most important milestone. Ends with maps that are provably traversable and can
be eyeballed as PNGs.

- [ ] [T1.01](M1/T1.01-mask.md) — `Mask`: the 1-bit-per-pixel bitset
- [ ] [T1.02](M1/T1.02-coarse-grid.md) — `CoarseGrid`: 8×8 occupancy counts
- [ ] [T1.03](M1/T1.03-noise.md) — Value noise, fBm, domain warp
- [ ] [T1.04](M1/T1.04-silhouette.md) — Pass 1–2: preset and silhouette
- [ ] [T1.05](M1/T1.05-blobs.md) — Pass 3: floating islands
- [ ] [T1.05b](M1/T1.05b-bridges.md) — Pass 3b: bridges between islands **(v2)**
- [ ] [T1.06](M1/T1.06-caves.md) — Pass 4: random-walk tunnels
- [ ] [T1.06b](M1/T1.06b-cave-network.md) — Pass 4: chambers, loops, entrances **(v2)**
- [ ] [T1.06c](M1/T1.06c-crevices-voids.md) — Pass 4b/4c: crevices and voids **(v2)**
- [ ] [T1.07](M1/T1.07-smoothing.md) — Pass 5: cellular-automata smoothing
- [ ] [T1.08](M1/T1.08-cleanup.md) — Pass 6: connected components and cleanup
- [ ] [T1.09](M1/T1.09-surface.md) — Pass 7a: walkable surface extraction
- [ ] [T1.10](M1/T1.10-traversal.md) — Pass 7b–c: traversal graph and validation
- [ ] [T1.11](M1/T1.11-generate.md) — The retry loop, safe preset, and `generate()`
- [ ] [T1.12](M1/T1.12-spawns.md) — Pass 8: spawn point selection
- [ ] [T1.13](M1/T1.13-metadata.md) — Pass 8: buried slots, decorations, `MapMeta`
- [ ] [T1.14](M1/T1.14-carve.md) — `carve_circle`, dirty chunks, coarse maintenance
- [ ] [T1.15](M1/T1.15-rle.md) — RLE encode and decode
- [ ] [T1.16](M1/T1.16-map-tests.md) — PNG dump, golden hashes, 1000-seed sweep

**Checkpoint:** `cargo test -p game-core --features dump-png` — open
`target/mapdump/` and look at the maps. Do they look like Worms levels?

---

## M2 — Player physics (11)

Headless movement in `game-core`. No rendering, no server.

- [ ] [T2.01](M2/T2.01-body.md) — `Body` and the physics state
- [ ] [T2.02](M2/T2.02-collide-queries.md) — `solid_at`, `aabb_overlaps_solid`
- [ ] [T2.03](M2/T2.03-ground-probe.md) — `ground_probe` and `approach`
- [ ] [T2.04](M2/T2.04-resolve-x.md) — Sub-stepped X movement and step-up
- [ ] [T2.05](M2/T2.05-resolve-y.md) — Y movement, grounding, ground snap
- [ ] [T2.06](M2/T2.06-input.md) — `Input`, edge derivation
- [ ] [T2.07](M2/T2.07-walk.md) — Walking, friction, air control
- [ ] [T2.08](M2/T2.08-jump.md) — Jump, coyote time, jump buffer
- [ ] [T2.09](M2/T2.09-jetpack-fuel.md) — Jetpack engagement rules and fuel
- [ ] [T2.10](M2/T2.10-jetpack-thrust.md) — Jetpack thrust and clamps
- [ ] [T2.11](M2/T2.11-apply-input.md) — `apply_input`, determinism, no-tunnelling

**Checkpoint:** `cargo test -p game-core physics` — every scenario test passes,
including the 10× terminal velocity tunnelling test.

---

## M3 — Client rendering and sandbox (11)

Make M1 and M2 visible. Ends with a playable single-player browser sandbox and no
server involved.

- [ ] [T3.01](M3/T3.01-wasm-bindings.md) — `game-wasm`: generate, carve, step, mask pointer
- [ ] [T3.02](M3/T3.02-wasm-ts-wrapper.md) — Typed TS wrapper and the build hook
- [ ] [T3.03](M3/T3.03-chunk-bake.md) — Mask → stencil → textured chunk
- [ ] [T3.04](M3/T3.04-edge-band.md) — The grass/edge band
- [ ] [T3.05](M3/T3.05-chunk-manager.md) — Chunk placement and the rebake budget
- [ ] [T3.06](M3/T3.06-camera.md) — Camera, sky gradient, parallax
- [ ] [T3.07](M3/T3.07-sandbox-scene.md) — Sandbox scene: seed, regenerate, click-to-carve
- [ ] [T3.08](M3/T3.08-player-sprite.md) — Player sprite, animation states, placeholders
- [ ] [T3.09](M3/T3.09-input-crosshair.md) — Keyboard/mouse input, aim ring, crosshair
- [ ] [T3.10](M3/T3.10-lightmap.md) — Lightmap, day/night, fog
- [ ] [T3.11](M3/T3.11-debug-overlays.md) — F4 overlays and perf counters
- [ ] [T3.12](M3/T3.12-sky.md) — Five-phase sky, sun, moon, stars **(v2)**

**Checkpoint:** `npm --prefix client run dev` → run around a generated map, blow
holes in it, watch the day/night slider change visibility.

---

## M4 — Items, weapons and stats (14)

- [ ] [T4.01](M4/T4.01-item-registry.md) — The item registry
- [ ] [T4.02](M4/T4.02-inventory.md) — 8-slot stacking inventory
- [ ] [T4.03](M4/T4.03-world-items.md) — World items, physics, pickup
- [ ] [T4.04](M4/T4.04-initial-spawn.md) — Initial item placement
- [ ] [T4.05](M4/T4.05-periodic-spawn.md) — Periodic spawns with surface re-validation
- [ ] [T4.06](M4/T4.06-crates.md) — Supply crates
- [ ] [T4.07](M4/T4.07-buried.md) — Buried slot reveal wiring
- [ ] [T4.08](M4/T4.08-weapon-defs.md) — Weapon definitions
- [ ] [T4.09](M4/T4.09-projectiles.md) — Projectile simulation and bouncing
- [ ] [T4.10](M4/T4.10-explode.md) — `explode`: carve, falloff damage, knockback
- [ ] [T4.11](M4/T4.11-hitscan.md) — Hitscan resolution
- [ ] [T4.12](M4/T4.12-player-stats.md) — Health, overheal, shield, speed multiplier
- [ ] [T4.13](M4/T4.13-damage-death.md) — Damage, death, respawn, scoring
- [ ] [T4.14](M4/T4.14-inventory-ui.md) — Client inventory panel and HUD
- [ ] [T4.15](M4/T4.15-visible-ordnance.md) — Tracers, trails, impact FX **(v2)**

**Checkpoint:** In the sandbox, pick up a bazooka, fire it, watch the crater form,
take self-damage, and see the inventory panel open on right-click.

---

## M5 — Weather and the day/night cycle (7)

- [ ] [T5.01](M5/T5.01-scheduler.md) — The effect scheduler
- [ ] [T5.02](M5/T5.02-toxic-rain.md) — Toxic rain
- [ ] [T5.03](M5/T5.03-meteor-shower.md) — Meteor shower
- [ ] [T5.04](M5/T5.04-lava-burst.md) — Lava bursts and `carve_capsule`
- [ ] [T5.05](M5/T5.05-heavy-fog.md) — Heavy fog
- [ ] [T5.06](M5/T5.06-day-night.md) — Cycle state and the FoV formula
- [ ] [T5.07](M5/T5.07-flashlight.md) — Flashlight and lightmap wiring

**Checkpoint:** In the sandbox, force each effect and watch it run start to finish.

---

## M6 — Server and multiplayer (13)

Wire the finished core into the server. Nothing built so far gets rewritten.

- [ ] [T6.01](M6/T6.01-world-step.md) — `World::step` and the ordered tick
- [ ] [T6.02](M6/T6.02-room-actor.md) — Room task, command channel, tick loop
- [ ] [T6.03](M6/T6.03-join-flow.md) — join / ready / welcome
- [ ] [T6.04](M6/T6.04-map-init.md) — `map_init` encode and client decode
- [ ] [T6.05](M6/T6.05-snapshot.md) — Snapshot encode and decode
- [ ] [T6.06](M6/T6.06-input-codec.md) — Input encode, decode, sequence handling
- [ ] [T6.07](M6/T6.07-events.md) — Event emission and delivery scoping
- [ ] [T6.08](M6/T6.08-client-net.md) — Client socket layer and event application
- [ ] [T6.09](M6/T6.09-prediction.md) — Prediction and reconciliation
- [ ] [T6.10](M6/T6.10-interpolation.md) — Remote player interpolation
- [ ] [T6.11](M6/T6.11-checksum.md) — Mask checksum and resync
- [ ] [T6.12](M6/T6.12-round-state.md) — Round phases, scoring, restart vote
- [ ] [T6.13](M6/T6.13-integration-tests.md) — Multi-client integration tests
- [ ] [T6.14](M6/T6.14-bot-controller.md) — Bot controller in `game-core` **(v2)**
- [ ] [T6.15](M6/T6.15-bot-seating.md) — Seating bots in the room **(v2)**

**Checkpoint:** `docker compose -f docker/docker-compose.yml up` — two browsers,
one round, terrain destruction visible in both, scores tracking.

---

## M7 — Sprites, skins and assets (5)

- [ ] [T7.01](M7/T7.01-fetch-assets.md) — `fetch-assets.sh`
- [ ] [T7.02](M7/T7.02-atlas-build.md) — Atlas builder and `manifest.json`
- [ ] [T7.03](M7/T7.03-skin-registry.md) — `skins.json`, resolution, fallbacks
- [ ] [T7.04](M7/T7.04-weapon-sprites.md) — Weapon rendering, pivot and muzzle
- [ ] [T7.05](M7/T7.05-terrain-themes.md) — Three themes and the procedural fallback

**Checkpoint:** Three rounds in a row look visibly different; switching skin id
changes the character.

---

## M8 — Polish and operations (5)

- [ ] [T8.01](M8/T8.01-replay-record.md) — Replay recorder
- [ ] [T8.02](M8/T8.02-replay-binary.md) — Headless replay binary
- [ ] [T8.03](M8/T8.03-debug-hud.md) — F3 debug HUD
- [ ] [T8.04](M8/T8.04-metrics.md) — `/metrics`, `DEBUG_DUMP`, log audit
- [ ] [T8.05](M8/T8.05-perf-and-docs.md) — Performance pass and run documentation
- [ ] [T8.06](M8/T8.06-minimap.md) — Explored-terrain minimap **(v2)**
- [ ] [T8.07](M8/T8.07-e2e-playwright.md) — Playwright end-to-end suite **(v2)**
- [ ] [T8.08](M8/T8.08-game-feel.md) — Screen shake, kill feed, polish pass **(v2)**

**Checkpoint:** Record a round, replay it headlessly, and confirm the final world
hash matches. A bug can now be reproduced from a seed and a tick.
