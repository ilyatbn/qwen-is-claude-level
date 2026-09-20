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
- [x] [T19.20](M19/T19.20-the-lightmap-hazard-path-has-no-caller.md) — `collectLightSources` has no production caller — **found by T19.13's review**, confirmed by grep; it is the only producer of `kind: 'cone'`, so flashlight cones light nothing — **deleted with its nine tests and `eraseCone`**, sanctioned by `docs/76` §G2; the removed branch was never taken, so the lightmap renders identically
- [x] [T19.21](M19/T19.21-the-join-catch-up-leaks-crate-contents.md) — The join catch-up tells a late joiner what every crate holds — **found by T19.17's review**, verified; `docs/40` has no catch-up rule at all — **`SpawnSource::Crate` is not overloaded** (five live `ItemSpawn` emitters, none `Crate`), so the catch-up filters on `is_crate()` and emits `crate_spawn`; the `install_world` comment that said the fix was unnecessary is corrected. **The load driver cannot see this bug** — its rounds are shorter than `CRATE_INTERVAL`, and its counter reads 5 before and 5 after
- [x] [T19.24](M19/T19.24-embers-light-nothing.md) — a lava vent lights the ground at night **in a real match** **(v7)** — scoped to option 2 after options 1 and 3 were each shown to be no-ops; the seed was already on the wire and the **surface it indexes was not** (`load_mask` cleared `meta.surface_points`, so a client derived zero vents from any seed). Determinism proved by cross-check at two levels, the pixel proof by a falsification its first version failed
- [x] [T19.31](M19/T19.31-fog-visible-cannot-see-its-own-constant.md) — `fog-visible` computes its expectation from `FLASHLIGHT_FOG_VEIL_MULT` in **two** places, so setting it to 1.0 passes the whole check **(v7)** — T19.27's twin, and the **only** live instance its sweep found.
- [x] [T19.30](M19/T19.30-death-races-the-weather.md) — `death` sets health to 1 then kills the player, and a **weather tick can land the blow first** — the overlay then reads "Killed by weather" **(v7)**. Sixth in the family and a different sub-shape: the race is in the *arrangement*, not the observation, so there is nothing to wait for.
- [x] [T19.29](M19/T19.29-teleport-samples-pixels-on-a-schedule.md) — `teleport`'s pixel sample lands before the pad redraws: simulation entirely correct, pixels short by 4.2 **(v7)** — **fifth member** of the races-its-own-state family; decide first whether the redraw is waitable or inherent like T19.23.
- [x] [T19.28](M19/T19.28-a-killed-check-reads-as-a-failing-one.md) — `e2e.mjs` turns a signalled child's `null` exit into `1`, so **a killed check is reported identically to a failed one** **(v7)** — one line, and it cost a real diagnosis to establish.
- [x] [T19.27](M19/T19.27-night-combat-cannot-see-its-own-constant.md) — `night-combat` computes its expectation from the constant it is testing, so `FLASHLIGHT_FOV_MULT = 1.0` **passes** **(v7)** — `docs/76` §G6's blind spot, found live in a gate check by a falsification that did not fail.
- [x] [T19.26](M19/T19.26-the-control-arm-races-the-socket.md) — `reap.rs`'s control arm races its own socket **(v7)** — `emit_until` cannot serve it (`create_room` must not be re-sent), so `common::connect_and_emit` retries **only a refused** send, on a fresh socket. **Six** such sites found, not the one that failed; green in 5/5 gates, falsified by breaking `seat`'s cleanup
- [x] [T19.25](M19/T19.25-rematch-closing-window.md) — `rematch`'s closing window **(v7)** — measured first: **25 frames/600 ms idle, 6 under 16 CPU hogs**, so the cadence is *not* unattainable and inconclusive-with-retry was ruled out on the numbers. `sleep(600)` is now a wait on `renderPos` advancing a tenth of the sampled rect; green in 5/5 gates
- [x] [T19.22](M19/T19.22-night-combat-sleeps-against-nothing.md) — `night-combat` waits against nothing **(v7)** — recounted at HEAD as **10 bare sleeps against 3 polls**, not the 7/2 booked; now **0 and 11**, each waiting on the effect the next line asserts. Green in **5/5** gates; falsified by breaking the radius path, which reds the assertion and not the wait
- [x] [T19.23](M19/T19.23-bullets-visible-window-is-the-screenshot.md) — `bullets-visible`'s window is the screenshot itself — **split from the same**; not the same problem as T19.22

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
- [x] [T20.02](M20/T20.02-a-nickname-you-choose-once.md) — A nickname you choose once **(v8)**
- [x] [T20.03](M20/T20.03-host-promotion-is-invisible.md) — Host promotion works and nobody is told **(v8)** — depends on T20.01
- [x] [T20.04](M20/T20.04-skins-never-reach-the-game.md) — Skins never reach the game **(v8)**
- [x] [T20.05](M20/T20.05-two-toxic-rains.md) — Two toxic rains that do not know about each other **(v8)** — ruling of 2026-09-04 applied: the emitter is driven by the real drops
- [x] [T20.06](M20/T20.06-battery-packs-you-never-see.md) — Battery packs you never see **(v8)**
- [x] [T20.07](M20/T20.07-the-flashlight-is-wired-to-nothing.md) — The flashlight is wired to nothing, and the new one is passive **(v8)** — **reverses `docs/72` §C13**, on the coordinator's instruction; `REPLAY_VERSION` 4 → 5, **shared with T20.08 — do not bump again**
- [x] [T20.08](M20/T20.08-the-shield-becomes-a-carried-thing.md) — The shield generator becomes a carried thing **(v8)** — **reverses `docs/21` §2/§4**, on the coordinator's instruction; rode T20.07's `REPLAY_VERSION` 5, **no second bump**
- [x] [T20.09](M20/T20.09-drop-an-item.md) — Right-click an inventory tile to drop it **(v8)**
- [x] [T20.10](M20/T20.10-animals-on-the-ground.md) — Animals on the ground **(v8)** — **no doc governs ground animals**; an amendment is the durable home for `animals.rs` and its constants block
- [x] [T20.11](M20/T20.11-fall-damage.md) — Fall damage **(v8)** — **unblocked by ruling**; `docs/20` §9 still refuses it and is the coordinator's to amend — **built, and the amendment is outstanding**
- [x] [T20.12](M20/T20.12-hats-and-sunglasses.md) — Hats and sunglasses **(v8)** — depends on T20.04
- [x] [T20.13](M20/T20.13-two-rooms-one-of-them-dead.md) — Two rooms, and one of them never starts **(v8)**
- [x] [T20.14](M20/T20.14-the-whole-thing-at-once.md) — The whole thing at once: an exploratory load test **(v8)** — `crates/game-server/examples/loadgen/`, four scenarios and three planted-fault controls; **reached T19.21 live at both of its observables** and booked T20.22/T20.23/T20.24/T20.25
- [x] [T20.16](M20/T20.16-the-balance-control-was-never-sound.md) — Replace the balance control's shape **(v8)** — control is now **one axis** (seats, map held): 6 seats is 15 pairs against 2 seats' 1, and the control reads **0 encounters on all eight seeds** against the shipping 447; floors are aggregate with their margins printed; booked T20.26
- [x] [T20.17](M20/T20.17-the-tests-that-never-run.md) — The tests that never run **(v8)** — nine milestones of invisible erosion; **all thirteen now run and all thirteen pass**, including the one recorded as knowingly red (D-68)
- [x] [T20.18](M20/T20.18-seven-copies-of-connect.md) — Seven copies of `connect` **(v8)** — from T20.10's handoff — **its own Done-when grep cannot survive the consolidation it asks for**; replaced by a guard that reads the value
- [x] [T20.19](M20/T20.19-a-hurt-player-rubber-bands.md) — A hurt player rubber-bands, permanently **(v8)** — **live at HEAD**, found by T21.02's sweep
- [x] [T20.21](M20/T20.21-two-things-apply-input-still-reads.md) — Two things `apply_input` still reads that the mirror does not have **(v8)** — booked by T20.19's review: health truncates to `u8` on the wire (a correction every 5.33 s, forever), and the mirror has no `alive` while `apply_inputs` gates on it (a dead player is predicted walking). Plus two live test defects in T20.19. — **its Done-when cannot go green while `checksum.rs::two_clients_agree_on_the_mask_after_a_hundred_carves` is red at `f874cec`**, which is not this task's and is reproduced with these changes removed — **resolved**: the checksum red was the shovel commit's, and `replay_run::a_perturbed_command…` was this fixture perturbing a corpse; both fixed, 279/279
- [x] [T20.20](M20/T20.20-a-flake-that-is-a-fixture.md) — A "flake" that is a fixture defect **(v8)** — **found by T20.11**; D-58 entry with a deterministic cause — **three of the four had one**, and the budget coincidence did not
- [x] [T20.15](M20/T20.15-a-check-that-waits-without-a-deadline.md) — A browser check that waits without a deadline **(v8)** — **found by T20.01**, pre-existing
- [x] [T20.22](M20/T20.22-a-room-hop-orphans-the-seat-behind-you.md) — A room hop orphans the seat you left behind **(v8)** — **found by T20.14**, live at HEAD; `registry.rs::detach_from` is the only leave path that never sends `Command::Leave` — fixed there rather than in a fourth caller; the capacity probe now seats 6 of 6 where it refused one as `full`
- [x] [T20.23](M20/T20.23-a-refresh-mid-join-burns-a-room-forever.md) — A refresh mid-join burns a room forever **(v8)** — **found by T20.14**, live at HEAD, 4/4 against a control of 0/4; `on_disconnect` detaches only inside its `if let` — **and the unconditional detach the task proposes does not fix it**: measured still 4/4, because `seat` re-attaches after the handler has run. Fixed in `seat`, ghost now clean
- [x] [T20.24](M20/T20.24-the-server-runs-out-of-rooms-at-48-players.md) — The server runs out of rooms at 48 players **(v8)** — **found by T20.14**: 32/32 rooms and 8367 `server_full` refusals out of 10634 while no room's worst tick ever reached 9 ms of a 16.67 ms budget — depends on T20.22 and T20.23 — **re-measured (D-69): not the leaks and not CPU.** 32 rooms / 192 seats / **0 humans** at both samples while 8542 joins are refused `server_full`; `MAX_ROOMS` stays, the binding thing is room *lifetime*, and the two levers are §E-level calls
- [x] [T20.25](M20/T20.25-the-room-health-metric-never-decays.md) — The room-health metric never decays **(v8)** — **found by T20.14** using it: `record_room_tick` is a lifetime running max and its doc comment promises a decay, so `rooms_over_budget` only ever climbs — a trailing window of `RING` ticks, two windows deep; falsified against both a lifetime max and a bare tumbling window
- [x] [T20.26](M20/T20.26-density-report-floors-variety-not-rate.md) — `density_report` floors variety and the thing that moves is rate **(v8)** — **found by T20.16** checking its own premise; the rate floor is its own guard, and its number is **quoted from `ITEM_SPAWN_INTERVAL`'s own doc table** (the 18/20/23 s the tuning was recorded as moving away from) rather than fitted — planting 14 → 42 now reds all three scales, naming each

**Order note.** T20.04 before T20.12 (accessories are invisible until skins reach the
renderer at all) and T20.01 before T20.03 (they share a cause). T20.14 is deliberately early
if you want its findings to shape T20.13 rather than the other way round. Everything else is
independent.

**Checkpoint:** host a private game and still be able to change its settings two minutes
later; join under a name you chose once and see it on the roster; look different from the
player beside you; pick up a flashlight and watch the fog thin; carry a shield generator and
watch a hit cost you a quarter less health and one energy; right-click a rocket out of your
pack and pick it back up; shoot a spider and take the medkit it drops.

## M21 — Special items, and a match you can reshape (8)

Two headline asks, **split into eight tasks** because each half needs its own gate and
`CLAUDE.md` caps a task at roughly one file and 250 lines. The split, and why:

**"Special items" → T21.01–03.** Vampire fangs is a *damage-path* change; ironman boots and
unicorn wings are *movement* changes that must survive client-side prediction. Different code,
different risks, different tests — one task would have hidden the movement problem behind the
easy one.

**"New match settings" → T21.04–08.** The day/night toggle is a fourth setting on T20.07's
established path and is genuinely small. Gravity is not one setting with three values: `low`
is a constant multiplier, while `none` is **a different movement model plus a second map
generator plus a forced skin** — three tasks wearing one word. Building them as one value of
one enum is how it lands half-finished.

**The recurring hazard across T21.01–03, T21.05 and T21.06** is that `apply_input` runs on the
server *and* in `prediction.ts` dozens of times per frame, and its purity is what makes
prediction correct. **Any movement modifier the client does not know about ships as
rubber-banding, not as a wrong speed.** T20.07's conclusion — derive a bit at the encode site
rather than storing a hashed field — is the cheap answer, and it is written into each file.

> **Read the rest of this section as history.** `T21.04`–`T21.08` are **not in M21 any more**:
> `T21.05`–`T21.08` became **M22** on 2026-09-18 at the owner's request and `T21.04` is in
> `tasks/parking-lot/`. The build order, the dependency chain and the "(8)" in the heading all
> describe the milestone as it was planned, and are left standing because the reasoning in them
> — the `apply_input` purity hazard, the acyclic-graph correction — is still the reasoning M22
> inherits. **Nothing below is startable here.** The live plan is the M22 section at the end of
> this file.

**M21 build order, computed from the eight `Depends on:` headers 2026-09-06** (after
`0eb0355` broke the T21.06 ↔ T21.07 cycle — the graph is acyclic, verified by walking it):

- **Startable now, in any order:** T21.01, T21.02, T21.03, T21.04. All four depend only on
  landed M20/M19 work (T19.07, T20.04, T20.08, T20.09, T20.11, T20.12 — all ticked).
- **Then:** T21.05 (needs T21.04) → T21.06 and T21.07 (both need only T21.05, and are
  independent of *each other*; take T21.07 first if both are open) → **T21.08 last**.
- **T21.08 is three hops deep** — `T21.08 ← T21.07 ← T21.05 ← T21.04` — and is the only task
  at that depth. Nothing else in M21 is more than two. If M21 is ever cut short, T21.08 is the
  piece that will not have a foundation.
- **Wide fan-out, narrow chain.** Four of eight start immediately and only one path exceeds two
  hops, so M21 parallelises well and no single blocked task can stall more than T21.08.
- **But do not read that as "M21 is more coupled than M20" — the comparison runs the other
  way, and an earlier version of this entry had it backwards.** Measured over all eighteen M20
  headers, M20 had **two** intra-milestone edges in total (`T20.03 ← T20.01`,
  `T20.12 ← T20.04`) and **no chain longer than one hop**. Its graph was flatter than M21's.
  Yet M20's real coupling was the thing that hurt, and **none of it was in a header**: three
  task files name `REPLAY_VERSION` (T20.07, T20.08, T20.09), and `PlayerView`'s rebuild and the
  sandbox-versus-shared-path seam each recur across several — see `HANDOFF-M20.md`, which
  mentions `REPLAY_VERSION` nine times and `PlayerView` eleven.
  **Depth in the headers is not independence in the code.** M21's declared chain is the part
  you can schedule around; M20's undeclared collisions are the part that cost time. When
  sequencing M21, grep for the shared symbol as well as reading the `Depends on:` line.

**Two claims here, with different shelf lives — do not trust them equally.** The wave structure
is a property of the eight `Depends on:` headers and cannot change unless a header does; re-derive
it by walking them. **"Startable now" is a claim about tick state** and goes stale silently the
moment a prerequisite is unticked or a new dependency is added. Re-check the six ticks before
relying on it, not the waves.

**Six M21 tasks are parked** in `tasks/parking-lot/` — the day/night setting, the whole
gravity chain (low gravity, zero-g movement, zero-g map, and the spacesuits that depend on it)
and the match viewer. They are specified and intact, just not being built; see that folder's
README. **They are deliberately absent from the list below**, so the link guard's count reflects
what is actually in flight.

- [x] [T21.01](M21/T21.01-vampire-fangs.md) — Vampire fangs **(v9)** — depends on T20.08 — **no doc governs it**; an amendment is the durable home for `LIFESTEAL_DAMAGE_PER_HP` and the "Special items (M21)" block. **The task's "key on the delivery" rule alone would have shipped the flamethrower feeding the fangs**: §F10 made `WEAPON_FLAME` a `Delivery::Projectile` and `flame.rs` logs *that* id, not the emitter's — `is_flying_ordnance` excludes it by `Burst::BurnsOut`, and dropping that clause reds the boundary test
- [x] [T21.02](M21/T21.02-ironman-boots.md) — Ironman boots **(v9)** — depends on T20.08, T20.04, T20.12 — `apply_input`'s bare `speed_multiplier: f32` became **`MoveMods`**, derived only by `PlayerState::move_mods` and called by both sides, so there is no literal left for either to pass. **`SNAPSHOT_PLAYER_BYTES` 19 → 20**: a passive byte carrying exactly what `apply_input` reads, derived at the encode site, **no `REPLAY_VERSION` move**. Fall damage: **three rulings, two reversed** — the record is at `constants.rs::boots_fall_safe_speed`. **Its Done-when's `e2e.mjs skins` does not select the pixel check**; that is `boots-visible`, run beside it
- [x] [T21.03](M21/T21.03-unicorn-wings.md) — Unicorn wings **(v9)** — **hard-depends on T20.09**: dropping is the only off switch, and `dropping_the_wings_ends_the_flight` goes through `World::drop_item` rather than emptying a bag by hand. Third gravity regime named in `jetpack::gravity_scale` beside the other two — **no fourth flag**. Jump and jetpack are **refused**, buffer cleared so nothing fires late; `jetpack::refuse` keeps the fuel machine's owner the only author of it. **Unlimited flight and blanket fall immunity are both stated**: `WINGS_FLY_SPEED < FALL_SAFE_SPEED` is asserted, so the immunity is by construction and not by an exemption. Boots+wings settled: the jump is never asked for, the speed still applies. **T21.07 zero-g will make constant flight meaningless — noted, not solved**
- [x] [T21.11](M21/T21.11-the-gun-platform.md) — The gun platform **(v9)** — **split into A/B/C below, as its own file requires; this file stays as the brief and the rulings.** Up to 3 static seed-placed emplacements. **Dismount is holding jump, not right-click** — the task file supersedes the original ask, because `main.ts` and `ui/inventory.ts` already bind `contextmenu` in three places and a mounted player cannot jump anyway.
  - [x] [T21.11A](M21/T21.11A-gun-platform-placement.md) — Placement, indestructibility, the wire and the art **(v9)** — `choose_pads`' sibling on its own `"gun_platforms"` RNG sub-stream, so adding platforms cannot move a pad or a spawn. Extracts `rect`/`covers`/`underfoot` out of `TeleportPad` and shares them rather than copying. `carve.rs`' per-row span array grows to `TELEPORT_PADS + GUN_PLATFORMS + 1` and **stays a fixed array** — the comment there records the 4 ms rebake budget that killed the `Vec`.
  - [x] [T21.11B](M21/T21.11B-gun-platform-mounting.md) — Mounting and the input lockout **(v9)** — depends on A. **The inventory being unreachable is the one rule**; `Q`, `R`, item use and slot select refuse through it rather than each growing a check. **The prediction seam is the risk**: mounted must be a bit in T21.02's `MoveMods` byte or an immobile player ships as rubber-banding.
  - [x] [T21.11C](M21/T21.11C-gun-platform-weapon.md) — The barrage and the magazine **(v9)** — depends on B. **Decided: 4 simultaneous bullets across a fan, not a sequence** — "at a time" is simultaneous, the art has three barrels, and a volley is four ordinary calls to the existing `Delivery::Bullet` path where a sequence would need cross-tick state the hash has to learn.
- [x] [T21.14](M21/T21.14-gun-platform-review-findings.md) — The gun platform: what the review found **(v9)** — a harsh review of the three landed T21.11 commits. **Two player-visible bugs**: the occupied lamp has no production caller so it never lights in a real match (and `platforms.mjs` drives it through the sandbox hook, so the check cannot see it), and a mounted player knocked clear of a platform stays mounted and keeps firing it from cover. **Five guards that cannot fail**, including a sub-stream test proved unfalsifiable by mutation and a citation with no referent.
- [x] [T21.15](M21/T21.15-the-terrain-texture-never-varies.md) — The terrain texture never varies **(v9)** — reported from play. `procTextures.ts` passes `makeNoiseTile` the **literals 7, 23 and 41**, so the rock, rim and cave-back are byte-identical on every seed in every round; only the 3-entry theme palette varies. `makeNoiseTile` already takes a seed and uses it, and **the map seed is in scope at the call site** in `worldView.ts`. Small change, wide blast radius: the golden mask table must **not** move.
- [x] [T21.13](M21/T21.13-the-round-does-not-end-at-zero.md) — The restarted round never announces itself **(v9)** — reported from play. **`World::set_phase` early-returns when the phase already matches and the `RoundState` push is after that return**, and a world is born in `Warmup` — so `room.rs::restart`'s `set_phase(Warmup)` is a no-op and round two announces nothing for `WARMUP_SECONDS`. Second defect: `RoundController::last_state_at` is never reset, so the once-a-second re-broadcast `docs/41` §3 promises dies permanently at the first restart. **`RoundState` has 14 references in the repo and none in a test** — nothing has ever asserted this message is sent. Symptom (a) "doesn't end at 0" was **not** reproduced; the file says so.
- [x] [T21.12](M21/T21.12-teleport-gate-sprite.md) — The teleport pad gets a gate, not a ring on the floor **(v9)** — reported from play. Client and assets only. **The indestructible ground already exists** — `TeleportPad::rect` is `PAD_H` rows that `carve_circle` refuses to clear — so this is the picture, not the rock. The source art is fully opaque with a white background (measured), so background removal is a **flood fill from the borders and a second from the ring's interior**, not a whiteness threshold. The charge effect stays driven by the snapshot byte.
- [x] [T21.16](M21/T21.16-options-menu-and-high-quality-toggle.md) — An options menu and the **High Quality** toggle **(v9)** — the foundation every shader task hangs off, and it ships **no visual change**: the escape menu already has a disabled "Options — coming soon" button to fill in. Default **off**, because shaders need the better graphics mode and the toggle exists for machines that lack it.
- [x] [T21.23](M21/T21.23-waits-in-the-wrong-clock.md) — Audit the browser checks for waits in the **wrong clock** **(v9)** — found by T21.22b: a gap advanced the wall clock 1113 ms while `serverRoundTime` advanced 400 ms, so a shot paced against `BAZOOKA_COOLDOWN` with 120 ms of headroom was refused. Distinct from *a wait hardcoded against a tunable expires* — there the number drifts; here the number is right and the **clock** is wrong. Bites only under load, so it reds in the gate and passes when run alone.
- [x] [T21.24](M21/T21.24-fps-counter-option.md) — An optional **FPS counter** in the options menu **(v9)** — asked for after the coordinator checked the fog in a real browser and found the frame rate did not drop the way the headless measurement claimed. An instrument for a person, not a test. **Also retires `FPS_FLOOR`** from the fog check: a number measured in headless Chrome under WSL on a box that may be gating is worse than a coin flip, because it would be believed.
- [x] [T21.25](M21/T21.25-does-toxic-rain-damage-anyone.md) — **Does toxic rain damage anyone?** **(v9)** — reported from play: *"ive never seen any actual damage from toxic rains"*. The arithmetic says ~**47 damage a shower** (`TOXIC_SPLASH_R` records 2.6 expected hits, measured). **Nothing here would notice if it stopped**: `toxic-rain-game.mjs` asserts drops exist and are drawn and never reads a health bar, and `toxic.rs`'s tests are `poison_lands` geometry. **Measure before changing** — if the damage is fine, the bug is that a player cannot tell they are being poisoned.
- [x] [T21.26](M21/T21.26-ambient-rain-on-its-own-cycle.md) — **Ambient rain**, not green and not an event **(v9)** — asked for as *"move the effects-only rain into a different set of cycles"*, but **there is no second rain to move**: T20.05 deliberately welded the sheet to the live drop count because *"a player saw a downpour and was hit by a drizzle"*. So this **adds** a harmless ambient rain on its own schedule and leaves the toxic sheet alone. Seeded, so `REPLAY_VERSION` moves.
- [x] [T21.27](M21/T21.27-bury-the-sprite-clouds.md) — **Bury the sprite clouds** **(v9)** — T21.18's cloud commit left `clouds-math.ts`, four `sky-math.ts` functions and the `clouds` atlas standing, **with passing tests and no production caller**. Green tests guarding a picture that is no longer drawn are worse than untested dead code, because they read as a guarded invariant.
- [x] [T21.21](M21/T21.21-scenery-must-sit-in-the-ground.md) — Rocks and trees float; seat them **(v9)** — reported from play. `objects.rs::seat` puts an object at the **median** ground height and `OBJECT_FOOTPRINT_SUPPORT` tolerates 40 % of the base hanging — the constant's own comment calls the burial "correct and wanted", and the report says otherwise. **An object's silhouette is collision**, so this moves the golden table: regenerate it *with* the 999-seed sweep, never nudge it. Split — extend the ground first (mask only, no wire), tilt to the slope only if that is not enough.
- [x] [T21.19](M21/T21.19-crate-beacon-on-the-minimap.md) — Dropped crates blink on the minimap **(v9)** — reported from play. `beaconPulse` already drives the in-world glow and a crate is already `source === 'Crate'`; **the minimap has never drawn items at all**, which is the new part. The brief's 0.5 s in 3 s means a glance misses it five times in six — deliberate, and the tunables go in `constants.rs` so the other reading is one number away.
- [x] [T21.20](M21/T21.20-the-mountains-float.md) — The background mountains are tiny and float **(v9)** — reported from play, **one cause for both symptoms**: `parallax.ts` positions and sizes the ridge against the *camera's visible rect*, so it rides with the camera while terrain stays put, and `CAMERA_ZOOM` 2 halves its apparent size. `MOUNTAIN_BASE_FRAC`'s own comment states the intent the code does not keep.
- [x] [T21.17](M21/T21.17-shader-plumbing-and-fog.md) — Shader plumbing, and fog first **(v9)** — depends on T21.16. **There are no shaders in this project at all**, so the first effect pays for the road. Fog is worst-looking: one flat grey rectangle at 80 %. **`fogVeilAlpha` feeds what a player can see** — the shader replaces the veil, not the seeing rule — and three browser checks sample fog brightness today.
- [x] [T21.18](M21/T21.18-the-shader-effect-queue.md) — The rest of the effects **(v9)** — depends on T21.17, **one commit per effect**. Clouds (off by default, disliked), smoke, laser beams, fire, explosions. **Lasers are the easiest, not the hardest**: `Delivery::Hitscan` means there is no projectile to hide, only a line to replace. **5/5 done — clouds, laser beams (`beams-shader`), smoke (`smoke-shader`), fire (`fire-shader`) and explosions (`explosion-shader`).** Un-parked 2026-09-14, finished 2026-09-15. Every effect keeps its simulation half: smoke vision is identical in both modes, painted fire covers every damage circle, and a painted blast covers its blast radius. The sprite clouds are *retired*, not hidden, and T21.27 buried what they left behind.
- [x] [T21.29](M21/T21.29-fall-damage-a-third.md) — **Fall damage cut to a third** **(v9)** — reported from play 2026-09-15: *"fall damage is still way to high … reduce it by 300%. its not fun."* Read as **one third of today's damage**, since a 300 % reduction is not a number: `FALL_DAMAGE_PER_SPEED` 0.075 → 0.025, `FALL_SAFE_SPEED` unchanged. A value whose *value* matters, so a pinned-to-the-constant suite cannot see it move — the task asks for an assertion against the owner's words.
- [x] [T21.30](M21/T21.30-no-moving-after-round-over.md) — **Nobody moves once the round is over** **(v9)** — reported from play 2026-09-15: *"i can still move my character after the 'round over' is displayed."* `World::step` calls `apply_inputs` in every phase and the client predicts in every phase; only pads, hazards and items check `playing`. Freeze input in `Ended` on both sides, one derived rule, not a flag each side keeps.
- [x] [T21.28](M21/T21.28-everything-placed-stands-on-ground.md) — **Everything placed on the map stands on ground** **(v9)** — reported from play 2026-09-15 with a screenshot: a teleport gate on a slope, *"a couple pixels are touching it in the center but the rest are in the air"*, and *"same for all other objects you place on the map"*. Pads and gun platforms get no ground at all (`TeleportPad::rect` only refuses carving), and the gate art is 64 px wide on a 40 px pad. Moves the golden table: sweep before and after.
- [x] [T21.31](M21/T21.31-real-clouds-and-rain-that-falls-from-them.md) — **Real clouds, and rain that falls from them** **(v9)** — reported from play 2026-09-15: *"the clouds … do not move and are honestly too large"*, *"it literally rains from the whole screen"*. There were no clouds in a Canvas or High-Quality-off game; the pale shape was the far ridge. **A** (`657211a`): seeded world-space clouds, varied, drifting on the wind, above a sky floor, Canvas and WebGL. **B** (`95d7b11`): ambient rain from cloud undersides that stops at rock; toxic rain drawn per real server drop, position-checked against damage.
- [x] [T21.32](M21/T21.32-the-round-after-the-round.md) — **The round after the round** **(v9)** — reported from play: *"Play again"* did nothing and every round was the same map. `return_to_lobby` told clients nothing (now `round_state{lobby}` → title, `vote_counted`, a countdown in words); the room seed never advanced on the lobby path (now `advance_seed`, shared with `restart`); warmup's `round_state` was lost at the menu→game handover (0:00 for the whole warmup). The unreaped room did **not** reproduce — a log line was added.
- [x] [T21.33](M21/T21.33-the-canvas-renderer.md) — **The Canvas renderer** **(v9)** — the owner's browser runs Phaser CANVAS and no check ever had. The navy bar was the mountain foot's WebGL-only `fillGradientStyle` (now a baked strip); the ridges drew white (no tint on Canvas); the sky line was a transparent wrap seam. `?renderer=canvas` and `canvas-renderer` added; High Quality is disabled with a note without WebGL.
- [x] [T21.34](M21/T21.34-wings-that-hover.md) — **Wings that hover** **(v9)** — reported from play: *"the player keeps flying up"*. Hover with no input, UP climbs, DOWN descends; wings drawn on the body off the snapshot bit (`wings-visible`); the jet readout shows unavailable while wings are held.
- [x] [T21.35](M21/T21.35-void-replay-dir-mine-size.md) — **`void`, Docker recordings, mine size** **(v9)** — `void` was never flaky: it fired before the new aim reached the server (un-parked). Docker's bind-mounted `recordings` was root-owned for a uid-10001 server (`recordings-init` one-shot, a startup writability probe). `MINE_W`/`MINE_H` moved to `constants.rs`.
- [x] [T21.36](M21/T21.36-fire-you-can-see-and-a-true-escape-menu.md) — **Fire you can see, and a true escape menu** **(v9)** — with High Quality off flames covered 108 of 192 burn-circle points; `flameDiscs(FLAME_RADIUS, …)` now covers 192/192 in both modes, asserted. `escape-menu` asserted a High Quality claim the shaders had made false; rewritten and un-parked.
- [x] [T21.37](M21/T21.37-tinted-skins-on-canvas.md) — **Tinted skins on Canvas** **(v9)** — the red Recruit drew untinted on Canvas; a tint-multiplied atlas copy is baked once per tint (`canvas-tinted-skin`). `skins-ingame` had been red on the base because its bar moved with the sky; it now compares each body's own pixels.
- [x] [T21.39](M21/T21.39-toxic-rain-switched-off.md) — **Toxic rain switched off** **(v9)** — owner 2026-09-15: *"Disable toxic rain completely for now its not working properly."* One switch, `TOXIC_RAIN_ENABLED = false`: the scheduler zeroes toxic's weight (meteor .375 / lava .3125 / fog .3125), `WEATHER=toxic` is refused at parse, the sandbox button is hidden; all toxic code kept for the rewrite (parked as `T21.41`). `toxic-rain-game` carries `disabled: 'T21.41'`; four checks skip only their toxic part. `REPLAY_VERSION` 8 → 9.
- [x] [T21.38](M21/T21.38-a-new-round-needs-every-human.md) — **A new round needs every human** **(v9)** — owner 2026-09-15: *"as long as all human players vote yes, restart. If not, title screen."* `restart_wins` = at least one human and every human still in the room voted yes; bots never count; a leaver no longer blocks; unanimous yes restarts at once. The tally rides `round_state` (`votes: {yes, humans}`), shown as "N of M players want a rematch". `REPLAY_VERSION` 9 → 10.
- [x] [T21.43](M21/T21.43-the-gun-platform-fires-while-held.md) — **The gun platform fires while held** **(v9)** — owner 2026-09-15: *"click and hold to auto fire like a machine gun."* One bullet per `GUN_PLATFORM_FIRE_INTERVAL` (2 ticks) from the three barrels in turn, replacing a 4-bullet volley per pull; one click fires one. Held damage per second 180.6 against the measured 180 of spam-clicked volleys (ratio 1.003, asserted ±20 %). Mounted bots judge the platform, not their bag. `platform_barrel` hashed; `REPLAY_VERSION` 10 → 11. New check `platform-autofire`.
- [x] [T21.40](M21/T21.40-smaller-gates-on-proper-ground.md) — **Smaller gates, only on proper ground** **(v9)** — owner 2026-09-15: *"just place them somewhere else then like a floating island or just dont place any more if there's no proper space.. also reduce its size by 20%"*. `PAD_ART_W` 64 → 51, `PAD_W` 40 → 32; pads and platforms are seated or not placed (main ground first, then any surface, islands included); fewer than 2 pads → none. Sweep: perched 544/8916 → 0/8717, 27 of 999 maps have fewer than six pads. Golden regenerated; `REPLAY_VERSION` 11 → 12. **Open:** "seated" ignores rock poking up through the base — 15 of 26 placements on three maps sit partly sunk into slopes.
- [x] [T21.09](M21/T21.09-the-backpack-holds-the-effect-items.md) — The backpack rows hold the effect items **(v9)** — reported from play: the two right-click rows do not take new pickups. Passive items belong there because they never need selecting; weapons belong on the bar because only the bar can fire. **After T21.01–T21.03.**
- [x] [T21.22](M21/T21.22-the-muzzle-was-a-gun-platform.md) — *"10 rockets left the muzzle"* was a gun platform **(v9)** — booked from T21.16's gate. `two-clients` fires 4 times and counted 10: a mounted player's trigger pull fires `GUN_PLATFORM_BARRAGE` rounds **owned by them**, so 2 + 4 + 4 = 10. The loop's 1020 ms gap exceeds `GUN_PLATFORM_MOUNT_TIME`, so anyone standing on a platform re-mounts between every shot at any cadence. **Observability, not gameplay**: `debug().mount` exposes `mounted` (the wire's) and `platformUnderfoot` (geometry) as two fields, the check walks her clear and proves it, and asserts the mount either side of the loop. The rocket count stays exactly as strict. Measured: **0 of 10 runs had a platform underfoot at spawn**, so the residual route is displacement mid-loop.

**Order note.** T21.04 first — it is small and it re-walks T20.07's path, which is the pattern
the rest copy. Then T21.01–03 as T20.08/T20.09 land. T21.05 before T21.06. **T21.06 and T21.07
are unplayable apart** — zero-g movement without its map has nothing to float between, and the
map without the movement is a level nobody can traverse; sequence them together or build both
behind one flag.

**Two things the coordinator owes a ruling on before T21.05 and T21.06 start.** *"Everything a
bit slower, including projectiles"* — less gravity makes a lobbed weapon travel **further**,
not slower, and bullets have `gravity_scale = 0.0` so gravity does not touch them at all. Is
this a gravity change or a time-scale change? And in zero-g, what happens on **contact** —
stop, or bounce? *"Constant until they hit something"* does not say, and the two feel entirely
different to play.

**Checkpoint:** host a private match in low gravity and watch a grenade hang; pick up ironman
boots and see them on your legs; hold unicorn wings and be unable to stop flying until you
drop them; land a rocket on someone holding a shield generator and watch your battery rise
instead of your health.

## M22 — Space: a match played in orbit (13)

**Specified 2026-09-18 and not started** — the owner asked for the milestone, not the work:
*"dont work on it yet just make it a separate milestone since its probably larger than you
think."* The brief, the re-check of the four parked originals, the build order and the six
questions the owner still owes a ruling on are in **[M22-space.md](M22/M22-space.md)**. Read
that first; the files below are the tasks it splits into.

**The nine open rulings are closed.** The owner said *"make your own decisions"* on
2026-09-20, so the coordinator ruled on all nine, plus the four design calls the task files
left open — in **[M22-RULINGS.md](M22/M22-RULINGS.md)**, indexed as `D-70`. **Builders read
their task file, then that one**; where a task says *"owner question N"* or *"decide before
writing"*, the ruling is binding.

Built from `T21.05`–`T21.08`, which were parked in M21 and are superseded by these — the
originals were removed from `tasks/parking-lot/` in the same commit, and
`git log --diff-filter=D -- tasks/parking-lot` finds them. **`T21.04` (day/night) stays
parked**: the owner has ruled day/night out of space, and the settings pattern it was going to
establish is T20.07's, which landed — so nothing in M22 waits on the parking lot.

**The two findings that change the size of this milestone.** *Zero-g movement is most of the
way built*: `jetpack::gravity_scale(state, flying)` already returns `0.0` for a flying player
and its own comment calls that "the third regime", and `MoveMods.flying` is already derived,
on the wire and predicted — so the owner's *"reuse the wings mechanic"* describes a seam that
exists rather than proposing one. And *the hazard table is already per-instance*: the
`toxic_enabled` bool became `enabled: [bool; N]` on 2026-09-16, already hashed and already
injected, so a per-mode hazard set is a constructor argument rather than a redesign.

- [ ] [T22.01](M22/T22.01-the-gravity-match-setting.md) — The gravity match setting — depends on nothing — `standard | low | space` on T20.07's path, in the replay header because it is simulation state. **Deliberately behaviourless**: its control test is that every existing test still passes unchanged. Named `space` and not `none` because the mode is a map, a backdrop, two hazards and a suit, and hanging all of that off a word that means gravity is how it ends up misfiled
- [ ] [T22.02](M22/T22.02-low-gravity.md) — Low gravity — depends on T22.01 — **may not be wanted**: the owner moved the gravity chain here but described only space (open question 3). A gravity *scale*, never the constant — `JUMP_HEIGHT`/`JUMP_REACH` are compile-time consts that drive the generator's verdict, so the constant moves the golden table and a scale does not. **Two copies of the projectile gravity term**: the hot loop inlines it and bypasses the extracted function, so a scale applied to one misses every shot in flight
- [ ] [T22.03](M22/T22.03-zero-g-movement-on-the-wings-regime.md) — Zero-g movement, on the wings regime **(large)** — depends on T22.01 — **not** on T22.05; the originals once declared each other and deadlocked. What wings do not do is the work: momentum that never damps, a collision rule (**stop or bounce — open question 1**), and a fuel cost on movement. `grounded` is the design decision the model turns on, and today *a body that ever leaves the ground can never land again* — most of "movement just doesn't stop" already arrives by accident
- [ ] [T22.04](M22/T22.04-thrusters-and-the-burst.md) — Thrusters: the energy cost and the burst you can see — depends on T22.03 — **the plume fires opposite the direction you travel**; move down and it is above you. Asserted on rendered pixels with velocity as the control, in **both** render paths — T21.36's flames covered 108 of 192 burn points with High Quality off
- [ ] [T22.05A](M22/T22.05A-the-space-map-boundary-and-asteroids.md) — The space map: the boundary and the asteroids **(large)** — depends on T22.01 — **the shape is decided: a circle**, from the owner's reference image. This is the split the original asked for. Golden hashes move through the **retry loop**, not through shared RNG (which is isolated and pinned by two tests): `report.passed` reads `JUMP_REACH`/`JUMP_HEIGHT`, so a flipped verdict re-derives every substream. 24 data rows become 36. **Walk-traversability is meaningless here**, so the acceptance predicate is a deliverable
- [ ] [T22.05B](M22/T22.05B-the-space-map-spawns-objects-and-up.md) — The space map: spawns, objects, and everything that assumes "up" **(large)** — depends on T22.05A — **spawns are the blocking problem**: the generator derives them from a surface and there is none. `surface_points` is also the only input `LavaBurst::new` reads, and birds take their altitude from the median column top. Eight subsystems assume up and each needs a ruling — the owner has already reported floating scenery twice and perched gates once, each one of these surfacing late
- [ ] [T22.06](M22/T22.06-the-space-backdrop.md) — The space backdrop: sun, moon, earth, stars, and they move — depends on T22.01 — **switching the sky stack off is most of this task**: the day/night cycle, clouds, fog, ambient rain and the parallax ridge, each with a live check behind it. Inherits the `living-sky` trap (`worldView.y` refreshes in `preRender`, so a layer laid out in `update` trails the camera by a frame — probed at 9, 8, 6, 5, 5, 3 px). **Read the seed from the wire**: a networked client's `core.meta.seed` was measured at 1 across four rounds
- [ ] [T22.07](M22/T22.07-spacesuits-and-the-visor.md) — Spacesuits, with a visor colour you choose — depends on T22.05B, T20.04, T20.12 — a forced body with a chosen accent, and **the chosen skin must come back when the mode ends**. Procedural, and **silhouette not palette** — a picker whose options differ only by colour is a picker with one option, which is what this brief asks for. `skins.json`'s skin 5 is skin 0 tinted, so any comparison must pick different atlas prefixes and say why
- [ ] [T22.08](M22/T22.08-solar-flares.md) — Solar flares — depends on T22.01 — **`BurnField` is the wrong home and its own first line says so** ("Damaging ground zones"); a ribbon moving through open space is the thing §F12 ruled out. New shape, or a deliberate widening with the comment rewritten. Burns for `N` seconds, default 4. T21.25 is the precedent for the test: toxic rain's check asserted drops exist and are drawn and **never read a health bar**
- [ ] [T22.09](M22/T22.09-radiation-and-the-shield-economy.md) — Radiation, and what a shield means now — depends on T22.01 — 1 damage a second unshielded, and **the blocking question is whether the suit's shield is the one that already exists** (`shield_active`, the generator item, `SHIELD_DAMAGE_MULT`): one predicate with two sources, or a second thing that makes `shield_active` answer two questions. Battery packs already exist as item 6 — what is missing is a reason to want one
- [ ] [T22.10](M22/T22.10-the-breach-vortex.md) — The breach vortex — depends on T22.05A, shares T22.05B's destination picker — *"a fun secret"*: a hole in the rim is a vortex that recycles you, so **it is containment dressed as a reward** rather than decoration. **Detection goes in `Map::circle`**, the one chokepoint all five production carve sites funnel through — a check at the explosion path misses four, and the fifth is a tombstone. `T22.05A`'s closure test is a claim about *generation*; this makes holes at *runtime*; both are true and the distinction is written into both files
- [ ] [T22.11](M22/T22.11-asteroid-gravity-wells.md) — Asteroid gravity wells **(large)** — depends on T22.05A, measured against T22.04 — **this retires "zero gravity" as a description of the mode**: no *global* gravity, but many local wells at levels 1–5. **The seam does not exist** — `apply_gravity` is `body.vel.y += GRAVITY * gravity_scale * dt`, a scalar on one axis, and "towards that point" is a vector; choosing between a new argument and a new function is the largest design call in M22. `MAX_FALL_SPEED` clamps `vel.y` only, so **there is no terminal velocity here until this task writes one**. The five levels are derived from the thruster's delta-v, and **a well nobody can escape kills with no cause on screen**
- [ ] [T22.12](M22/T22.12-the-black-hole.md) — The black hole **(large)** — depends on T22.05A, T22.11 — arrives at a random time in the **last minute**, permanent, eats one asteroid, and inside the horizon **you cannot escape**. That is the deliberate exception to T22.11's escape guarantee: scope that guard to asteroids and give this one the inverse assertion, or "you cannot escape" is a claim nothing tests. **The scheduler does neither "permanent" nor "at T-minus"** — every effect today is interval-scheduled with a duration — so decide whether it belongs there or in the round controller. The horizon is a **state change**, not a very strong pull

**Order note.** T22.01 first and alone; everything reads the setting. Then the branches.
**T22.11 runs before T22.10** (`R11`): the three attractors share one summation and the task
that writes it has to land first. The build order above permits either and did not say which.
**T22.03, T22.05A, T22.05B, T22.11 and T22.12 are the five large ones**; T22.03 and T22.05A are
independent of each other — the movement model is observable on an ordinary map, the generator
is asserted on map properties. The mode is not *playable* until T22.03 and T22.05B are both in.
**Three attractors share one summation** — asteroid wells, the breach vortex and the black hole.
Whichever lands first writes it; three loops means the float-order fix, the prediction fix and
the cutoff each have to be right three times.

**All nine rulings are made** (2026-09-20, coordinator, `D-70`) and live in
**[M22-RULINGS.md](M22/M22-RULINGS.md)** with a "Reverse it by" line each. The short form:
contact **stops**; the suit shield **is** `shield_active`; low gravity **stays**; `grounded`
is real and earned by contact from below; bots fly and it is in scope; radiation is ambient;
players do **not** orient to a surface (the expensive one, ruled the cheap way the reference
image supports); the black hole arrives every round at a random moment, fixed size, eats one
asteroid, freezes at `Ended`; the vortex catches everyone including wings, caps at three,
never heals, takes players only, and stays off the minimap. Four further design calls are
ruled there too — `Forces` for gravity, **one** attractor list, a new type for the flare,
and void outside the rim.

**An amendment is owed and is not written.** `docs/13`, `docs/14` and `docs/10` all describe
behaviour this milestone overrides in one mode, and `docs/20-player-movement.md:235` still
refuses fall damage outright. Per `CLAUDE.md` the coordinator writes `docs/77-amendments-v9.md`
**when the work lands**, not now.

**Checkpoint:** host a match in space and float between asteroids on your thrusters, watching
the plume fire from the opposite side; run your energy down and drift; take a battery pack and
watch the radiation stop eating you; see a solar flare cross the arena and get out of its way;
look up and see the earth, moved since the round began.
