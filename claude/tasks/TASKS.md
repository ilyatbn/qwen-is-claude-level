# Master task list

111 tasks across 10 milestones.
(The header read 102 while only 101 rows ever existed — an off-by-one introduced
when the v2 tasks were added. Counted, not assumed.) Work them **in order**. See `README.md` for the
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
- [x] [T0.03](M0/T0.03-rng.md) — Seeded RNG and sub-stream derivation
- [x] [T0.04](M0/T0.04-math.md) — `Vec2`, `Aabb`, and small maths helpers
- [x] [T0.05](M0/T0.05-server-skeleton.md) — axum + socketioxide + tracing, `/healthz`, echo
- [x] [T0.06](M0/T0.06-client-skeleton.md) — Vite + TS + Phaser 3.90 + socket.io connect
- [x] [T0.07](M0/T0.07-docker.md) — Dockerfiles, compose, nginx, `.env.example`
- [x] [T0.08](M0/T0.08-check-script.md) — `scripts/check.sh`, the gate

**Checkpoint:** `cargo run -p game-server` and `npm --prefix client run dev` — the
browser console logs an echo round-trip. `./scripts/check.sh` is green.

---

## M1 — Map generation and destruction (16)

The most important milestone. Ends with maps that are provably traversable and can
be eyeballed as PNGs.

- [x] [T1.01](M1/T1.01-mask.md) — `Mask`: the 1-bit-per-pixel bitset
- [x] [T1.02](M1/T1.02-coarse-grid.md) — `CoarseGrid`: 8×8 occupancy counts
- [x] [T1.03](M1/T1.03-noise.md) — Value noise, fBm, domain warp
- [x] [T1.04](M1/T1.04-silhouette.md) — Pass 1–2: preset and silhouette
- [x] [T1.05](M1/T1.05-blobs.md) — Pass 3: floating islands
- [x] [T1.05b](M1/T1.05b-bridges.md) — Pass 3b: bridges between islands **(v2)**
- [x] [T1.06](M1/T1.06-caves.md) — Pass 4: random-walk tunnels
- [x] [T1.06b](M1/T1.06b-cave-network.md) — Pass 4: chambers, loops, entrances **(v2)**
- [x] [T1.06c](M1/T1.06c-crevices-voids.md) — Pass 4b/4c: crevices and voids **(v2)**
- [x] [T1.07](M1/T1.07-smoothing.md) — Pass 5: cellular-automata smoothing
- [x] [T1.08](M1/T1.08-cleanup.md) — Pass 6: connected components and cleanup
- [x] [T1.09](M1/T1.09-surface.md) — Pass 7a: walkable surface extraction
- [x] [T1.10](M1/T1.10-traversal.md) — Pass 7b–c: traversal graph and validation
- [x] [T1.11](M1/T1.11-generate.md) — The retry loop, safe preset, and `generate()`
- [x] [T1.12](M1/T1.12-spawns.md) — Pass 8: spawn point selection
- [x] [T1.13](M1/T1.13-metadata.md) — Pass 8: buried slots, decorations, `MapMeta`
- [x] [T1.14](M1/T1.14-carve.md) — `carve_circle`, dirty chunks, coarse maintenance
- [x] [T1.15](M1/T1.15-rle.md) — RLE encode and decode
- [x] [T1.16](M1/T1.16-map-tests.md) — PNG dump, golden hashes, 1000-seed sweep

**Checkpoint:** `cargo test -p game-core --features dump-png` — open
`target/mapdump/` and look at the maps. Do they look like Worms levels?

---

## M2 — Player physics (11)

Headless movement in `game-core`. No rendering, no server.

- [x] [T2.01](M2/T2.01-body.md) — `Body` and the physics state
- [x] [T2.02](M2/T2.02-collide-queries.md) — `solid_at`, `aabb_overlaps_solid`
- [x] [T2.03](M2/T2.03-ground-probe.md) — `ground_probe` and `approach`
- [x] [T2.04](M2/T2.04-resolve-x.md) — Sub-stepped X movement and step-up
- [x] [T2.05](M2/T2.05-resolve-y.md) — Y movement, grounding, ground snap
- [x] [T2.06](M2/T2.06-input.md) — `Input`, edge derivation
- [x] [T2.07](M2/T2.07-walk.md) — Walking, friction, air control
- [x] [T2.08](M2/T2.08-jump.md) — Jump, coyote time, jump buffer
- [x] [T2.09](M2/T2.09-jetpack-fuel.md) — Jetpack engagement rules and fuel
- [x] [T2.10](M2/T2.10-jetpack-thrust.md) — Jetpack thrust and clamps
- [x] [T2.11](M2/T2.11-apply-input.md) — `apply_input`, determinism, no-tunnelling

**Checkpoint:** `cargo test -p game-core physics` — every scenario test passes,
including the 10× terminal velocity tunnelling test.

---

## M3 — Client rendering and sandbox (11)

Make M1 and M2 visible. Ends with a playable single-player browser sandbox and no
server involved.

- [x] [T3.01](M3/T3.01-wasm-bindings.md) — `game-wasm`: generate, carve, step, mask pointer
- [x] [T3.02](M3/T3.02-wasm-ts-wrapper.md) — Typed TS wrapper and the build hook
- [x] [T3.03](M3/T3.03-chunk-bake.md) — Mask → stencil → textured chunk
- [x] [T3.04](M3/T3.04-edge-band.md) — The grass/edge band
- [x] [T3.05](M3/T3.05-chunk-manager.md) — Chunk placement and the rebake budget
- [x] [T3.06](M3/T3.06-camera.md) — Camera, sky gradient, parallax
- [x] [T3.07](M3/T3.07-sandbox-scene.md) — Sandbox scene: seed, regenerate, click-to-carve
- [x] [T3.08](M3/T3.08-player-sprite.md) — Player sprite, animation states, placeholders
- [x] [T3.09](M3/T3.09-input-crosshair.md) — Keyboard/mouse input, aim ring, crosshair
- [x] [T3.10](M3/T3.10-lightmap.md) — Lightmap, day/night, fog
- [x] [T3.11](M3/T3.11-debug-overlays.md) — F4 overlays and perf counters
- [x] [T3.12](M3/T3.12-sky.md) — Five-phase sky, sun, moon, stars **(v2)**

**Checkpoint:** `npm --prefix client run dev` → run around a generated map, blow
holes in it, watch the day/night slider change visibility.

---

## M4 — Items, weapons and stats (14)

- [x] [T4.01](M4/T4.01-item-registry.md) — The item registry
- [x] [T4.02](M4/T4.02-inventory.md) — 8-slot stacking inventory
- [x] [T4.03](M4/T4.03-world-items.md) — World items, physics, pickup
- [x] [T4.04](M4/T4.04-initial-spawn.md) — Initial item placement
- [x] [T4.05](M4/T4.05-periodic-spawn.md) — Periodic spawns with surface re-validation
- [x] [T4.06](M4/T4.06-crates.md) — Supply crates
- [x] [T4.07](M4/T4.07-buried.md) — Buried slot reveal wiring
- [x] [T4.08](M4/T4.08-weapon-defs.md) — Weapon definitions
- [x] [T4.09](M4/T4.09-projectiles.md) — Projectile simulation and bouncing
- [x] [T4.10](M4/T4.10-explode.md) — `explode`: carve, falloff damage, knockback
- [x] [T4.11](M4/T4.11-hitscan.md) — Hitscan resolution
- [x] [T4.12](M4/T4.12-player-stats.md) — Health, overheal, shield, speed multiplier
- [x] [T4.13](M4/T4.13-damage-death.md) — Damage, death, respawn, scoring
- [x] [T4.14](M4/T4.14-inventory-ui.md) — Client inventory panel and HUD
- [x] [T4.15](M4/T4.15-visible-ordnance.md) — Tracers, trails, impact FX **(v2)**

**Checkpoint:** In the sandbox, pick up a bazooka, fire it, watch the crater form,
take self-damage, and see the inventory panel open on right-click.

---

## M5 — Weather and the day/night cycle (7)

- [x] [T5.01](M5/T5.01-scheduler.md) — The effect scheduler
- [x] [T5.02](M5/T5.02-toxic-rain.md) — Toxic rain
- [x] [T5.03](M5/T5.03-meteor-shower.md) — Meteor shower
- [x] [T5.04](M5/T5.04-lava-burst.md) — Lava bursts and `carve_capsule`
- [x] [T5.05](M5/T5.05-heavy-fog.md) — Heavy fog
- [x] [T5.06](M5/T5.06-day-night.md) — Cycle state and the FoV formula
- [x] [T5.07](M5/T5.07-flashlight.md) — Flashlight and lightmap wiring

**Checkpoint:** In the sandbox, force each effect and watch it run start to finish.

---

## M6 — Server and multiplayer (13)

Wire the finished core into the server. Nothing built so far gets rewritten.

- [x] [T6.01](M6/T6.01-world-step.md) — `World::step` and the ordered tick
- [x] [T6.02](M6/T6.02-room-actor.md) — Room task, command channel, tick loop
- [x] [T6.03](M6/T6.03-join-flow.md) — join / ready / welcome
- [x] [T6.04](M6/T6.04-map-init.md) — `map_init` encode and client decode
- [x] [T6.05](M6/T6.05-snapshot.md) — Snapshot encode and decode
- [x] [T6.06](M6/T6.06-input-codec.md) — Input encode, decode, sequence handling
- [x] [T6.07](M6/T6.07-events.md) — Event emission and delivery scoping
- [x] [T6.08](M6/T6.08-client-net.md) — Client socket layer and event application
- [x] [T6.09](M6/T6.09-prediction.md) — Prediction and reconciliation
- [x] [T6.10](M6/T6.10-interpolation.md) — Remote player interpolation
- [x] [T6.11](M6/T6.11-checksum.md) — Mask checksum and resync
- [x] [T6.12](M6/T6.12-round-state.md) — Round phases, scoring, restart vote
- [x] [T6.13](M6/T6.13-integration-tests.md) — Multi-client integration tests
- [x] [T6.14](M6/T6.14-bot-controller.md) — Bot controller in `game-core` **(v2)**
- [x] [T6.15](M6/T6.15-bot-seating.md) — Seating bots in the room **(v2)**
- [x] [T6.16](M6/T6.16-game-scene.md) — The Game scene: the thing that runs it all **(v2)**

**Checkpoint:** `docker compose -f docker/docker-compose.yml up` — two browsers,
one round, terrain destruction visible in both, scores tracking.

---

## M7 — Sprites, skins and assets (5)

- [x] [T7.01](M7/T7.01-fetch-assets.md) — `fetch-assets.sh`
- [x] [T7.02](M7/T7.02-atlas-build.md) — Atlas builder and `manifest.json`
- [x] [T7.03](M7/T7.03-skin-registry.md) — `skins.json`, resolution, fallbacks
- [x] [T7.04](M7/T7.04-weapon-sprites.md) — Weapon rendering, pivot and muzzle
- [x] [T7.05](M7/T7.05-terrain-themes.md) — Three themes and the procedural fallback

**Checkpoint:** Three rounds in a row look visibly different; switching skin id
changes the character.

---

## M8 — Polish and operations (5)

- [x] [T8.01](M8/T8.01-replay-record.md) — Replay recorder
- [x] [T8.02](M8/T8.02-replay-binary.md) — Headless replay binary
- [x] [T8.03](M8/T8.03-debug-hud.md) — F3 debug HUD
- [x] [T8.04](M8/T8.04-metrics.md) — `/metrics`, `DEBUG_DUMP`, log audit
- [x] [T8.05](M8/T8.05-perf-and-docs.md) — Performance pass and run documentation
- [x] [T8.06](M8/T8.06-minimap.md) — Explored-terrain minimap **(v2)**
- [x] [T8.07](M8/T8.07-e2e-playwright.md) — Playwright end-to-end suite **(v2)**
- [x] [T8.08](M8/T8.08-game-feel.md) — Screen shake, kill feed, polish pass **(v2)**

**Checkpoint:** Record a round, replay it headlessly, and confirm the final world
hash matches. A bug can now be reproduced from a seed and a tick.

---

## M9 — The polish that makes it a game (4)

Everything here was named by the people who built and played it, not by the
original plan. Three are features whose **data already exists and was never
drawn**; the fourth is two carried defects with their consequences attached.

- [x] [T9.01](M9/T9.01-audio.md) — Audio: cues, spatial attenuation, CC0 packs **(v2)**
- [x] [T9.02](M9/T9.02-decorations.md) — Draw `MapMeta.decorations`, generated since M1 **(v2)**
- [x] [T9.03](M9/T9.03-item-sprites.md) — Item, crate and pickup sprites **(v2)**
- [x] [T9.04](M9/T9.04-palette-and-rasteriser.md) — Theme contrast, and one capsule rasteriser **(v2)**
- [x] [T9.05](M9/T9.05-backdrop-distance.md) — Bound the backdrop by distance to rock **(v2)**
- [x] [T9.06](M9/T9.06-full-round.md) — Play a full round, end to end **(v2)**
- [x] [T9.07](M9/T9.07-bake-regression.md) — The bake got slower and nobody knows why **(v2)**
- [x] [T9.08](M9/T9.08-join-state.md) — Announce the state that existed before the client **(v2)**
- [x] [T9.09](M9/T9.09-bot-lethality.md) — Bots that carry a round **(v2)**
- [x] [T9.10](M9/T9.10-join-carve-gap.md) — Close the join-window carve gap **(v2)**

**Checkpoint:** play a full round against bots with sound on, at night, on each of
the three themes. It should be a game you want to keep playing.
