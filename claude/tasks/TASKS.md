# Master task list

203 tasks across 20 milestones.
(The header read 102 while only 101 rows ever existed — an off-by-one introduced
when the v2 tasks were added; it then read 169 against 183 rows. Counted with
`grep -c '^- \[[ x]\]'`, not assumed — 202 after T19.07 booked T19.19, and 203
after T19.13's review booked T19.20.) Work
them **in order**. See `README.md` for the
loop and `../CLAUDE.md` for the rules.

Tasks marked **(v2)** come from `docs/70-amendments-v2.md`, **(v3)** from
`docs/71-amendments-v3.md`, **(v4)** from `docs/72-amendments-v4.md`, **(v5)**
from `docs/73-amendments-v5.md`, **(v6)** from `docs/74-amendments-v6.md` and
**(v7)** from `docs/75-amendments-v7.md`. Each overrides the earlier docs where they
disagree. Read v2 before M1 and v3 before M10.

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

---

## M10 — Menus, rooms and matchmaking (7)

The front end the game never had, and the multi-room server `docs/41` §9 always
described but never built.

- [x] [T10.01](M10/T10.01-room-registry.md) — `RoomRegistry`: many rooms in one process **(v3)**
- [x] [T10.02](M10/T10.02-lobby-protocol.md) — Create, join by code, quick match **(v3)**
- [x] [T10.03](M10/T10.03-title-attract.md) — Title screen with a live attract mode **(v3)**
- [x] [T10.04](M10/T10.04-start-menu.md) — Start Game menu and lobby **(v3)**
- [x] [T10.05](M10/T10.05-skins-menu.md) — Skins menu (weapons greyed out) **(v3)**
- [x] [T10.06](M10/T10.06-death-overlay.md) — Death overlay and respawn countdown **(v3)**
- [x] [T10.07](M10/T10.07-room-capacity.md) — Measure what a room costs **(v3)**

**Checkpoint:** two browsers, one creates a private game and reads the code aloud,
the other joins it. A third runs quick match. All three rounds run at once.
`node scripts/checks/m10-checkpoint.mjs` — **done**, and it found two real bugs
on its first run.

---

## M11 — The arsenal (9)

Three weapons becomes twenty-two. Deathmatch is the point; variety is the game.

- [x] [T11.01](M11/T11.01-delivery-kinds.md) — Melee, cone and placed delivery **(v3)**
- [x] [T11.02](M11/T11.02-battery.md) — The battery, shields and shield-piercing **(v3)**
- [x] [T11.03](M11/T11.03-ballistics.md) — Pistol, revolver, deagle, machinegun **(v3)**
- [x] [T11.04](M11/T11.04-energy.md) — Laser pistol and laser SMG **(v3)**
- [x] [T11.05](M11/T11.05-melee.md) — Knife, bat, whip, axe, hammer **(v3)**
- [x] [T11.06](M11/T11.06-flamethrower.md) — Flamethrower **(v3)**
- [x] [T11.07](M11/T11.07-mines.md) — Proximity mines **(v3)**
- [x] [T11.08](M11/T11.08-grenades.md) — Airburst, smoke, molotov, toxic **(v3)**
- [x] [T11.09](M11/T11.09-balance.md) — Balance the arsenal by measurement **(v3)**
- [x] [T11.12](M11/T11.12-suite-isolation.md) — One spec breaks the next one **(v3)**
- [x] [T11.13](M11/T11.13-item-density.md) — Make "tons of weapons" true of a round **(v3)**
- [x] [T11.14](M11/T11.14-bot-hazard-guard.md) — Bots walk into their own fire **(v3)**
- [x] [T11.15](M11/T11.15-impact-prediction.md) — Bots aim thrown weapons at where they land **(v3)**
- [x] [T11.16](M11/T11.16-encounter-rate.md) — Make players meet **(v3)**
- [x] [T11.10](M11/T11.10-ordnance-render.md) — Draw the ordnance the server already sends **(v3)**
- [x] [T11.11](M11/T11.11-arsenal-art.md) — Art for the arsenal **(v3)**

**Checkpoint:** a full round where every weapon class gets used, and the balance
report has no weapon nobody picks up.

---

## M12 — Tombstones (1)

- [x] [T12.01](M12/T12.01-tombstones.md) — Tombstones, with an effect seam **(v3)**

**Checkpoint:** die three times in a round; three graves stand where you fell, and
a player joining late sees all of them.

---

## M13 — What the player cannot see (6)

Playtest bugs. Four of them are **one defect**: `GameScene` never calls
`TerrainLayer.markDirty()`, because there are two render paths and the game scene is
the one nobody develops in. See `docs/72-amendments-v4.md` §C0 — including why 905
tests and 20 e2e specs missed all four.

- [x] [T13.01](M13/T13.01-one-render-path.md) — One render path, and the rebake nobody wired **(v4)**
- [x] [T13.02](M13/T13.02-pixel-acceptance.md) — Assert on rendered pixels **(v4)**
- [x] [T13.03](M13/T13.03-ordnance-visible.md) — Missiles, grenades and bullets you can see **(v4)**
- [x] [T13.04](M13/T13.04-weather-visible.md) — Weather you can see **(v4)**
- [x] [T13.05](M13/T13.05-crates.md) — Crates fall, land, and can be picked up **(v4)**
- [x] [T13.06](M13/T13.06-round-end.md) — The round ends **(v4)**
- [x] [T13.06.1](M13/T13.06.1-rooms-on-demand.md) — No battle exists until players ask for one **(v4)**
- [x] [T13.06.2](M13/T13.06.2-melee-reach.md) — Melee hits what is in front of you **(v4)**
- [x] [T13.06.3](M13/T13.06.3-no-fire-while-moving.md) — You cannot fire while moving **(v4)**
- [x] [T13.06.4](M13/T13.06.4-toxic-rain-falls.md) — Toxic rain falls from the sky **(v4)**
- [x] [T13.06.5](M13/T13.06.5-meteors-visible.md) — Meteors you can see and dodge **(v4)**
- [x] [T13.06.6](M13/T13.06.6-gun-projectiles.md) — Gun projectiles are still invisible **(v4)**
- [x] [T13.06.7](M13/T13.06.7-one-slot-per-weapon.md) — A weapon occupies one slot, ever **(v4)**
- [x] [T13.06.8](M13/T13.06.8-results-countdown.md) — The results countdown counts down **(v4)**
- [x] [T13.06.9](M13/T13.06.9-jetpack-readout.md) — Show the jetpack number **(v4)**
- [x] [T13.06.10](M13/T13.06.10-gate-selfload.md) — The gate breaks its own wall-clock assertions **(v4)**
- [x] [T13.06.11](M13/T13.06.11-reaper-has-no-caller.md) — The room reaper has no caller **(v4)**

**Checkpoint:** connect and land in a *lobby*, not a battle. Then fire a rocket and
watch the hole appear, stand in toxic rain and see it, and play a round to the end.

**M14 does not start until every T13.06.x box is ticked.**

---

## M14 — HUD and UI (7)

- [x] [T14.01](M14/T14.01-timer-and-banner.md) — Round timer and event banner **(v4)**
- [x] [T14.02](M14/T14.02-bars.md) — Health, energy and jetpack bars **(v4)**
- [x] [T14.03](M14/T14.03-consumables.md) — Heals and batteries leave the inventory **(v4)**
- [x] [T14.04](M14/T14.04-quick-throw.md) — Quick-throw a grenade with E **(v4)**
- [x] [T14.05](M14/T14.05-inventory-ui.md) — Quick bar and backpack **(v4)**
- [x] [T14.06](M14/T14.06-escape-menu.md) — The escape menu **(v4)**
- [x] [T14.07](M14/T14.07-debug-mode.md) — Debug mode, and the aim line leaves production **(v4)**
- [x] [T14.08](M14/T14.08-no-dev-surface-in-production.md) — The dev surface is compiled out **(v4)**

**Checkpoint:** play a round using only the HUD — no debug overlays — and never lose
a fight to a menu.

---

## M15 — The world (4)

- [x] [T15.01](M15/T15.01-teleport-pads.md) — Teleport pads **(v4)**
- [x] [T15.02](M15/T15.02-void.md) — The floor can be dug through, and below it is death **(v4)**
- [x] [T15.03](M15/T15.03-living-sky.md) — Mountains and clouds **(v4)**
- [x] [T15.04](M15/T15.04-birds.md) — Birds **(v4)**

**Checkpoint:** dig a hole through the floor, fall in and die; shoot a bird and heal
with what it drops.

---

## M16 — Destructible scenery (5)

Turn any PNG into terrain. `docs/73-amendments-v5.md` §D1 is the whole idea: threshold
the sprite's alpha into the 1-bit mask and it *is* terrain — destructible, collidable
and carved by the same `carve_circle` as rock, with no new entity and nothing on the
wire. Then bake the art clipped by that same mask, so blowing half a tree away removes
half the tree.

- [x] [T16.01](M16/T16.01-object-mask-pipeline.md) — PNG to terrain mask: the build pipeline **(v5)**
- [x] [T16.02](M16/T16.02-stamp-objects.md) — Stamp objects into the map **(v5)**
- [x] [T16.03](M16/T16.03-render-objects.md) — Draw objects, clipped by the mask **(v5)**
- [x] [T16.04](M16/T16.04-clouds-to-sky.md) — The clouds pack belongs in the sky **(v5)**
- [x] [T16.05](M16/T16.05-provenance.md) — Record where the art came from **(v5)**

**Checkpoint:** generate a map with trees and boulders on it, fire a rocket into one,
and watch the half you hit disappear — art and collision together.

---

## M17 — Lobbies and queues (8)

A lobby becomes a place you sit in rather than a five-second overlay on a match that has
already started. `docs/74-amendments-v6.md` §E1 is the enabling idea: **a room in `Lobby`
has no `World`** — the map, the round clock and the weather come into existence when the
match starts, which is why a private lobby can change its map size at all.

- [x] [T17.01](M17/T17.01-lobby-without-a-world.md) — A lobby is a room without a world **(v6)**
- [x] [T17.02](M17/T17.02-lobby-state-wire.md) — The lobby on the wire **(v6)**
- [x] [T17.03](M17/T17.03-public-lobbies.md) — Public lobbies: fill to five, or bots after ten seconds **(v6)**
- [x] [T17.04](M17/T17.04-private-lobbies.md) — Private lobbies: a code, settings and ready **(v6)**
- [x] [T17.05](M17/T17.05-closed-match.md) — A live match is closed **(v6)**
- [x] [T17.06](M17/T17.06-reaper-counts-humans.md) — Lobbies and matches die when their humans leave **(v6)**
- [x] [T17.07](M17/T17.07-lobby-screen.md) — The lobby screen holds the socket **(v6)**
- [x] [T17.08](M17/T17.08-main-menu.md) — SHRED, and a menu that steps **(v6)**

**Checkpoint:** two browsers click Quick Game, see each other in a roster, wait ten
seconds, and land in the same match with three bots. A third browser hosting a private
game gets a code, a friend joins it, they both ready, and they play on a Large map.

---

## M18 — UI and defects (6)

Six independent items. The one that matters most is the first: the title screen runs a
real simulation at a third of real time, and thirty seconds in it takes the menu with it.

- [x] [T18.01](M18/T18.01-title-screen-stops.md) — The title screen stops after thirty seconds **(v6)**
- [x] [T18.02](M18/T18.02-smarter-bots.md) — Bots that explore, arm themselves and run **(v6)**
- [x] [T18.03](M18/T18.03-clouds-bigger.md) — Clouds are bigger and vary in brightness **(v6)**
- [x] [T18.04](M18/T18.04-objects-sit-on-ground.md) — Rocks and bushes are bigger, and sit on the ground **(v6)**
- [x] [T18.05](M18/T18.05-toxic-rain-poisons.md) — Toxic rain poisons on hit **(v6)**
- [x] [T18.06](M18/T18.06-inventory-icons.md) — Inventory tiles show the item **(v6)**

**Checkpoint:** leave the menu open for two minutes and it still works; stand in toxic
rain and watch a green health bar drain; look at a boulder and see it touching the ground.

---

## M19 — Guns you can see, and a game you can debug (15)

Ten reports, fifteen tasks, and seven of them are one complaint said seven ways: **the
simulation is right and the player cannot tell.** A tracer that lives 0.09 s, a fog that
only shrinks a lightmap radius, rain that lands on nobody, fire that is an arc being
checked rather than a thing on the ground, a firing gate that turns most clicks into
silence. T19.01–03 are the shooting and T19.11–13 are the fire; the rest are
independent.

- [x] [T19.01](M19/T19.01-bullets-fly.md) — Bullets fly: guns stop being hitscan **(v7)**
- [x] [T19.02](M19/T19.02-you-can-see-a-bullet.md) — You can see a bullet, without freezing the game **(v7)**
- [x] [T19.03](M19/T19.03-fire-button.md) — Hold to empty the clip **(v7)**
- [x] [T19.04](M19/T19.04-fire-while-moving.md) — §C20 repealed: you fire while moving **(v7)**
- [x] [T19.15](M19/T19.15-the-client-run-is-a-coin-flip.md) — The client test run is a coin flip **(v7)** — all three. The wasm-build race and `backdrop-real`'s attribution landed earlier; `hud-timer`'s open question is now **answered**: the check differenced the mean redness of **two different rectangles** (the timer is right-anchored, so its width follows its text) against a sky that drifts over the 30 s between the frames. Reproduced 8 of 8 by forcing the narrow rect. Replaced by a red-pixel **fraction** — 0.00% → 27.2%, spread 0.02 over 8 runs — with the control region §C2 asks for. Done-when green (20/20 wasm builds, 5×800 client tests), plus the two proofs it cannot give: 12 concurrent builds and 800/800 under load 11.6. `./scripts/check.sh` EXIT=0, 43/43 e2e, net smoke 25/25, assets ok.
- [x] [T19.14](M19/T19.14-the-join-race.md) — The join race, and a gate that fails on a coin flip **(v7)** — **roster half; there was no race. Vite half booked as T19.16**
- [x] [T19.16](M19/T19.16-vite-port-under-load.md) — `vite did not report a port within 90 s` under sustained load **(v7)** — **reproduced, and it was never about vite.** `e2e.mjs` started vite through `npm run dev`, whose `predev` hook is the wasm build, so the 90 s window covered a release Rust build plus T19.15's lock wait: measured 11.7 s to the port line on an idle box, **11.6 of it `predev` and 0.1 s vite**. Reproduced through the real path with 24 queued builds. The build now runs before the clock and vite starts with hook-free `npx vite`; **no deadline was raised**. `./scripts/check.sh` EXIT=0, 43/43 e2e, net smoke 25/25, assets ok.
- [x] [T19.05](M19/T19.05-the-shovel.md) — The shovel, and the end of the melee cabinet **(v7)** — every deliverable except the retired weapons' procedural art, which **must stay** (`itemSprites-math.test.ts` reads the live registry; see `HANDOFF-M19.md`). Done-when green, `./scripts/check.sh` EXIT=0, 41/41 e2e.
- [x] [T19.06](M19/T19.06-rain-that-hurts.md) — Rain that falls on you hurts **(v7)** — every deliverable; the splash does **not** reuse the blast helper (it carves — see `HANDOFF-M19.md`) and the roof is asked per victim. Done-when green, `./scripts/check.sh` EXIT=0, 41/41 e2e, net smoke 25/25, assets ok.
- [x] [T19.07](M19/T19.07-private-settings-server.md) — Private-game settings: the wire, and the match that honours them **(v7)** — every deliverable. Wire keys `bots`/`start_kit`/`round_seconds`; replay tags 19-21 appended. **The header did not stay untouched:** the follow-up (`718cddc`) took `REPLAY_VERSION` 3 → 4 and `HEADER_BYTES` 43 → 45, appending `bots_enabled` and `start_kit`, because a `Room`-field setting is lost across a restart — check the format before assuming otherwise. Done-when green; `./scripts/check.sh` EXIT=0, 41/41 e2e, net smoke 25/25, assets ok (`f474f2d`), and again EXIT=0, 41/41, net smoke 25/25, assets ok for the follow-up (`718cddc`).
- [x] [T19.08](M19/T19.08-private-settings-screen.md) — The private lobby's settings panel **(v7)** — every deliverable. The host gate and the arrow-disabling are one function, asserted as an equivalence over the whole matrix. **Task defect: `canChangeSettings` does not exist** — it is `ownsSettings`. Done-when green, `./scripts/check.sh` EXIT=0, 41/41 e2e, net smoke 25/25, assets ok.
- [x] [T19.09](M19/T19.09-teleport-charge.md) — The teleport charge is 1.5 seconds **(v7)** — every deliverable. The hazard the sweep predicted (accidental teleports suite-wide) **did not appear**: 41/41 e2e. Done-when green, `./scripts/check.sh` EXIT=0, net smoke 25/25, assets ok.
- [x] [T19.10](M19/T19.10-fog-fills-the-screen.md) — Fog fills the screen **(v7)** — every deliverable, plus a **new `fog-visible` check** proving the veil in a real match (the sandbox acceptance stayed green with the game wiring falsified). The veil broke `crates`, measured 3/3; the fix is a new `WEATHER=auto|off|fog|…` dev switch. Done-when green, `./scripts/check.sh` EXIT=0, 42/42 e2e, net smoke 25/25, assets ok.
- [x] [T19.11](M19/T19.11-fire-is-an-object.md) — Fire is an object **(v7)** — every deliverable. Two defects found on landing that no task file names: a flame died on contact with a body, and the shared overlap test ignores `h` so a flame at your feet burned nobody. **Nothing emits a flame yet, by design** — the production-caller grep is T19.12's. Done-when green, `./scripts/check.sh` EXIT=0, 42/42 e2e, net smoke 25/25, assets ok.
- [x] [T19.12](M19/T19.12-what-lights-a-fire.md) — What lights a fire: the flamethrower, the molotov, the vent **(v7)** — every deliverable. **Task-file contradiction resolved in favour of a green gate:** it says to leave the client broken for T19.13, but its own Done-when runs `check.sh`, so `ordnance.mjs`'s two dead assertions are repaired here (`GameEvent::Cone` is left standing, unemitted, for T19.13). Balance re-measured: flamethrower and molotov roughly **3x** their damage with self-harm at **0.00**. Done-when green, `./scripts/check.sh` EXIT=0, 42/42 e2e, net smoke 25/25, assets ok.
- [x] [T19.13](M19/T19.13-flames-on-screen.md) — Flames on screen **(v7)** — every deliverable, plus a **new `fire-visible` check** that photographs a molotov's crowd in a real match and is falsified by drawing the disc §F10 replaced. **Task defect: its ≥ half `MOLOTOV_FLAMES` cluster floor is arithmetically impossible** (24 flames settle across ~100 px and `FLAME_RADIUS` is 10, so they touch) — three both-ends assertions replace it, and they found a real bug: `enforce_cap` removed flames **without telling the clients**, so 176 burned on screen against a cap of 160. Flames are now painted rather than summed (they read as steam under `ADD`). Done-when green, `./scripts/check.sh` EXIT=0, 43/43 e2e, net smoke 25/25, assets ok.
- [x] [T19.17](M19/T19.17-a-crate-you-cannot-pick-up.md) — A crate you cannot pick up — **explained: the refusal is correct.** Reproduced on seed 555 and measured from inside `resolve_pickups` — 3863 samples, closest **0.17 px** — the crate holds `item 22 x2` (two molotovs) and the player is already at `MOLOTOV_AMMO`, so §C24's one-slot-per-weapon rule returns `Full`. **The "MEDKIT, heals=0" was the instrument**: `crate_spawn` carries no `item_id` and the mirror coerced the absent field to `0` = `MEDKIT`, which also labelled every crate "Medkit" on screen. Fixed and falsified both ends. `./scripts/check.sh` EXIT=0, 43/43 e2e, net smoke 25/25, assets ok.
- [x] [T19.18](M19/T19.18-the-lobby-client-never-learns-its-inventory.md) — The lobby client never learns its inventory — **found and fixed.** The server sends `inventory` once at match start, immediately after `map_init` — and `map_init` is what moves the client out of `MenuScene`, so `GameScene` subscribed a frame *after* its own inventory had been delivered and dropped. `Connection` now **latches** current-value events and replays the last one to a late subscriber, on a microtask so a scene's `create()` is not re-entered. `m10-checkpoint` selects the bazooka **by name** and prints both clients' slots; the crater is the second end (§A39). Falsified at the live binding site. `./scripts/check.sh` EXIT=0, 43/43 e2e, net smoke 25/25, assets ok.
- [x] [T19.19](M19/T19.19-the-wasm-tests-have-never-run.md) — Fourteen `wasm_bindgen_test`s have never run in any gate — **thirteen, and now they do.** The fourteenth grep hit is a doc comment. None needs a browser (the crate mentions neither `js_sys` nor `web_sys`), so all thirteen became plain `#[test]`s and `wasm-bindgen-test` left `Cargo.toml`, which makes the attribute fail to compile; `no_test_in_this_crate_is_invisible_to_the_gate` is the second half of that guard. **3 passed -> 17 passed.** Nine were duplicated by `client/src/core/index.test.ts` (which drives the real `pkg`); the genuinely dark ones are named in the journal. Falsified both ways. `./scripts/check.sh` EXIT=0, 43/43 e2e, net smoke 25/25, assets ok.
- [ ] [T19.20](M19/T19.20-the-lightmap-hazard-path-has-no-caller.md) — `collectLightSources` has no production caller — **found by T19.13's review**, confirmed by grep; it is the only producer of `kind: 'cone'`, so flashlight cones light nothing
- [ ] [T19.21](M19/T19.21-the-join-catch-up-leaks-crate-contents.md) — The join catch-up tells a late joiner what every crate holds — **found by T19.17's review**, verified; `docs/40` has no catch-up rule at all
- [ ] [T19.22](M19/T19.22-night-combat-sleeps-against-nothing.md) — `night-combat` waits against nothing, seven times — **split from the retired suite-context hypothesis**
- [ ] [T19.23](M19/T19.23-bullets-visible-window-is-the-screenshot.md) — `bullets-visible`'s window is the screenshot itself — **split from the same**; not the same problem as T19.22

**Order note.** T19.15 and T19.14 were written mid-milestone and are **promoted ahead of
the remaining feature work**: three of the four gate runs after T19.02 carried a
non-deterministic red, and every one of those costs a human judgement about whether it is
real. D-65 is what that judgement looks like when it is made from a confounded
measurement.

**Checkpoint:** host a private game with bots off, All weapons and a 4-minute timer; run
sideways while holding fire and watch a stream of bullets cross the screen; dig into a
hill with the shovel; throw a molotov and watch a crowd of flames scatter along the
ground, burn it and go out five seconds later; stand in toxic rain and lose health; wait
for fog and lose the far side of the map.

## M20 — What a player noticed, and what the milestone found under it (14)

Ilya played the game and reported six defects and seven wanted features; the investigation
found more than the brief did. **Four tasks turned out to be about something other than what
was reported**: the host is not losing permission, it is being *swept out of its own lobby*
(T20.01); the flashlight does not need rebalancing, it is **wired to nothing** in four places
(T20.07); the shield already drains battery, so the wanted rule is a *generalisation of code
already there* (T20.08); and battery packs are already 5th of 19 by spawn share, so the
complaint is likely the **HUD**, not the table (T20.06).

**Three tasks conflict with a live doc clause and cannot be started on a builder's say-so.**
T20.11 (fall damage) is refused outright by `docs/20` §9 — *"deliberately absent in v1 so the
jetpack stays forgiving"* — with no override in `docs/70`–`75`. T20.05 sits between two
clauses of `docs/72` that contradict each other (§C6 says the rain is a particle emitter,
§C21 makes drops projectiles *for the same visual reason*), and neither retires the other.
T20.07 reverses §C13's flashlight trade, and T20.09 must be written against §F4.1's
right-button decision rather than around it. **Amendments are the coordinator's.**

- [x] [T20.01](M20/T20.01-the-host-is-swept-out-of-its-own-lobby.md) — The host is swept out of its own lobby **(v8)**
- [ ] [T20.02](M20/T20.02-a-nickname-you-choose-once.md) — A nickname you choose once **(v8)**
- [ ] [T20.03](M20/T20.03-host-promotion-is-invisible.md) — Host promotion works and nobody is told **(v8)** — depends on T20.01
- [ ] [T20.04](M20/T20.04-skins-never-reach-the-game.md) — Skins never reach the game **(v8)**
- [ ] [T20.05](M20/T20.05-two-toxic-rains.md) — Two toxic rains that do not know about each other **(v8)** — **needs a spec ruling**
- [ ] [T20.06](M20/T20.06-battery-packs-you-never-see.md) — Battery packs you never see **(v8)**
- [ ] [T20.07](M20/T20.07-the-flashlight-is-wired-to-nothing.md) — The flashlight is wired to nothing, and the new one is passive **(v8)**
- [ ] [T20.08](M20/T20.08-the-shield-becomes-a-carried-thing.md) — The shield generator becomes a carried thing **(v8)**
- [ ] [T20.09](M20/T20.09-drop-an-item.md) — Right-click an inventory tile to drop it **(v8)**
- [ ] [T20.10](M20/T20.10-animals-on-the-ground.md) — Animals on the ground **(v8)**
- [ ] [T20.11](M20/T20.11-fall-damage.md) — Fall damage **(v8)** — **BLOCKED on overriding `docs/20` §9**
- [ ] [T20.12](M20/T20.12-hats-and-sunglasses.md) — Hats and sunglasses **(v8)** — depends on T20.04
- [ ] [T20.13](M20/T20.13-two-rooms-one-of-them-dead.md) — Two rooms, and one of them never starts **(v8)**
- [ ] [T20.14](M20/T20.14-the-whole-thing-at-once.md) — The whole thing at once: an exploratory load test **(v8)**
- [ ] [T20.15](M20/T20.15-a-check-that-waits-without-a-deadline.md) — A browser check that waits without a deadline **(v8)** — **found by T20.01**, pre-existing

**Order note.** T20.04 before T20.12 (accessories are invisible until skins reach the
renderer at all) and T20.01 before T20.03 (they share a cause). T20.14 is deliberately early
if you want its findings to shape T20.13 rather than the other way round. Everything else is
independent.

**Checkpoint:** host a private game and still be able to change its settings two minutes
later; join under a name you chose once and see it on the roster; look different from the
player beside you; pick up a flashlight and watch the fog thin; carry a shield generator and
watch a hit cost you a quarter less health and one energy; right-click a rocket out of your
pack and pick it back up; shoot a spider and take the medkit it drops.
