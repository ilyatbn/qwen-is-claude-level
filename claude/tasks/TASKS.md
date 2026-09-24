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
- [x] [T21.36](M21/T21.36-fire-you-can-see-and-a-true-escape-menu.md) — **Fire you can see, and a true escape menu** **(v9)** — with High Quality off flames covered **85–108** of 192 burn-circle points (a range, not the single reading the row used to give); `flameDiscs(FLAME_RADIUS, …)` now covers 192/192 in both modes, asserted. `escape-menu` asserted a High Quality claim the shaders had made false; rewritten and un-parked.
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

## M22 — Space: a match played in orbit (19)

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
establish is **`docs/75` §F7's**, which landed — **not T20.07's, which is the flashlight task
and adds no lobby setting** (corrected 2026-09-20) — so nothing in M22 waits on the parking
lot. The same misattribution sits in two M21 rows above and is left there, since M21 is
closed.

**The two findings that change the size of this milestone.** *Zero-g movement is most of the
way built*: `jetpack::gravity_scale(state, flying)` already returns `0.0` for a flying player
and its own comment calls that "the third regime", and `MoveMods.flying` is already derived,
on the wire and predicted — so the owner's *"reuse the wings mechanic"* describes a seam that
exists rather than proposing one. And *the hazard table is already per-instance*: the
`toxic_enabled` bool became `enabled: [bool; N]` on 2026-09-16, already hashed and already
injected, so a per-mode hazard set is a constructor argument rather than a redesign.

- [x] [T22.00](M22/T22.00-the-title-check-lost-its-stepper.md) — The `title` check asserts a control that was deleted five days ago — depends on nothing — **not M22 work, and it blocks M22's batch gate.** `4f28b2e` took map size off the pre-host/join screen on the owner's instruction and did not touch `title.mjs`, which still clicks `#scale-next`; it has been red since 2026-09-16 and nothing reported it, because `title` is only selected when a **client source file** changes and the four commits since were server-side or documentation. **Do not delete the block** — the row and the seat gate moved to `lobby.mjs`'s `IDS`. **But my claim that the coverage was strictly larger there was wrong**, and the builder checked instead of believing it: `lobby.mjs` has two lists, and `scale` was in `IDS` (displayed) and not in `MOVED` (stepped), so **nothing anywhere tested map size crossing the wire**. Closed by adding `'scale'` to `MOVED`, falsified at the guest's parse
- [x] [T22.00B](M22/T22.00B-the-smoke-shader-waits-on-a-clock.md) — `smoke-shader` waits on a wall clock, so load decides whether it passes — depends on nothing — **not M22 work, and it blocks M22's batch gates.** Two sightings, both in-suite, both passing **alone on the same tree** at ten to twenty times the margin; every other assertion in the check passed both times, including that the cloud was drawn. The cause is `await sleep(300)`: under load the browser renders fewer frames in that window and the pixel delta collapses toward the control. **Neither `flaky` nor `serial`** — the first deletes the only assertion that says the shader *moves*, the second is unfalsified and the `teleport` row above it went red *in the serial tail*. Count rendered frames instead of waiting on a clock
- [ ] [T22.00C](M22/T22.00C-three-more-unfired-coin-flips.md) — Three more unfired coin flips, and one shared helper — depends on T22.00B — **does not currently fail the gate, and that is the point.** `fire-shader`, `explosion-shader` and `beams-shader` carry the identical instrument T22.00B proved marginal (**4 of 15 idle trials at or under its floor**), and `beams-shader`'s window is **shorter** than the one that already failed twice. `fog-shader` is a fourth, reachable only through `waitForTimeout` — **the `sleep(` grep prescribed in T22.00B misses 141 call sites including that one**. Lift T22.00B's frames-plus-steps instrument into `harness.mjs` and share it, rather than making the same four mistakes a fifth time
- [ ] [T22.00D](M22/T22.00D-airborne-ticks-is-not-derived.md) — `body.airborne_ticks` is unhashed and is **not** a derived value — **not M22 work; do it after M22 closes.** A running counter that gates coyote time and the jetpack hold delay, absent from `World::state_hash`'s fold (`grep -c` → 0), so two worlds can agree on every hashed field at a checkpoint and disagree on whether a player can jump. **Prove it before fixing it** — and check whether deriving it is smaller than hashing it, because hashing moves every historical checkpoint
- [ ] [T22.00E](M22/T22.00E-four-parked-socket-flakes-share-a-harness.md) — Four parked socket flakes share one harness — **not M22 work; do it after M22 closes.** Three in `lobby.rs`, one in `integration.rs`, all failing at a websocket handshake, all green standalone, **a different member each time**. That is the pattern `CLAUDE.md` says not to read as load without instrumenting — and the last time that reasoning ran here the plausible shared cause was inert. **Do not park a fifth**: one of the four is the only test that a seventh client is refused *over the wire*
- [x] [T22.00F](M22/T22.00F-four-checks-still-sample-a-wall-clock.md) — The four checks T22.00B left carrying its bug — depends on T22.00B — **a prediction coming true, not a new flake**: T22.00B fixed `smoke-shader`'s two-frames-across-a-wall-clock sampling and named the four still doing it; `beams-shader` went red on an **idle** box needing 1.0% and getting **0.9%**, a 10% margin on a hardcoded threshold over a fixed 200 ms window, while five of its other assertions passed. **Do not tune the number** — T22.00B measured that the window is marginal regardless of load. Count drawn frames and take the max, and carry over the second assertion that tells *“the shader is frozen”* from *“the page stopped drawing”*, which is the distinction whose absence produced two false sightings
- [ ] [T22.00G](M22/T22.00G-fog-visible-reads-two-clocks.md) — `fog-visible` compares two values sampled from different clocks — **my mis-attribution, corrected**: I told T22.00F the 0.783-vs-0.794 red was `fog-shader`'s and the same wall-clock defect; it is `fog-visible`'s and a different one. `fogStrength` is computed live at the `debug()` call while `fogAlpha` returns a field written at the **last drawn frame**, compared at 0.01, and the poll breaks at `>= 0.99` **while the ramp is still climbing**. I also called that gate's failure “load” because it re-ran green — true, and not the whole story. **Counting frames does not fix this one**; sampling both ends from one drawn frame does. Do not widen the tolerance: it is what would catch `FOG_SCREEN_ALPHA` drifting from the screen
- [x] [T22.01](M22/T22.01-the-gravity-match-setting.md) — The gravity match setting — depends on nothing — `standard | low | space` on §F7's path, in the replay header because it is simulation state. **Deliberately behaviourless**: its control test is that every existing test still passes unchanged. Named `space` and not `none` because the mode is a map, a backdrop, two hazards and a suit, and hanging all of that off a word that means gravity is how it ends up misfiled
- [x] [T22.02](M22/T22.02-low-gravity.md) — Low gravity — depends on T22.01 — **may not be wanted**: the owner moved the gravity chain here but described only space (open question 3). A gravity *scale*, never the constant — `JUMP_HEIGHT`/`JUMP_REACH` are compile-time consts that drive the generator's verdict, so the constant moves the golden table and a scale does not. **Two copies of the projectile gravity term** — corrected 2026-09-20: the hot loop does *not* bypass the extracted function, the second copy is in `projectile.rs::predict_impact`, the bots' throw-safety arc walker, so scaling one leaves every shot in flight correct and every bot throw wrong. Plus a fourth `GRAVITY` reader nobody had found, `bots/mod.rs::zone_reach`
- [x] [T22.03](M22/T22.03-zero-g-movement-on-the-wings-regime.md) — Zero-g movement, on the wings regime **(large)** — depends on T22.01 — **not** on T22.05; the originals once declared each other and deadlocked. What wings do not do is the work: momentum that never damps, a collision rule (**stop or bounce — open question 1**), and a fuel cost on movement. `grounded` is the design decision the model turns on, and today *a body that ever leaves the ground can never land again* — most of "movement just doesn't stop" already arrives by accident
- [x] [T22.03B](M22/T22.03B-bots-in-space.md) — Bots in space **(R5's split, taken)** — depends on T22.03 — `bots/mod.rs` is **2844 lines** and its movement step is a different model from anything else in M22; finishing it inside T22.03 was the 800-line ending the scope rule names. **It already has a number waiting for it**: `zone_reach` in space returns **≈1100 px** against ≈99 standard, because the ballistic term goes to infinity and the `FLAME_LIFE` bound takes over — over half a Small map, so a bot with a molotov keeps a stand-off it can never satisfy and **never throws**. Physically right, behaviourally wrong
- [x] [T22.03D](M22/T22.03D-bots-pinned-against-rock.md) — Bots pinned against rock (T22.03B's review, F1–F4) — space bots spent 53–59 % of alive time pinned motionless against rock at the fuel reserve (runs to 196 s); hysteresis from rock, a rock detour, and the stand-off/flee/wander seams the traces found: 3.5–3.7 % on its draws (**4.0–4.7 %** over four disjoint 32-seed draws — T22.03E F3), no 10 s run, kills 1.52–1.82 → 4.02–4.35 a bot a round
- [x] [T22.03C](M22/T22.03C-bots-throw-what-burns.md) — Bots throw what burns (T22.03B part B, combat) — **ruled R95; built** (zone weapons scored by area damage over time, one throw guard, space reach 100 px measured, standard flame stand-off 2×; space kills −14 %, standard self-damage within noise, not strictly under — put to the coordinator) — was: **needs a ruling**: bots never throw a molotov or a toxic grenade in *any* mode (`choose_weapon` scores `damage / cooldown`, and both do 0 damage themselves), so the 1110 px space reach never binds; selecting them is a selection change R5 kept out of T22.03B and it moves standard balance too
- [x] [T22.03E](M22/T22.03E-what-the-bot-review-found.md) — What the bot review found (review of `cb63610`/`95acb77`, F1–F9) — the zero-g "reaches" guard and `choose_weapon`'s refusal get units that fail (plants red); `Flight` resets per life, an escape outranks a detour, a body inside rock takes the way out; pinned-at-reserve bound 6 % = worst draw 4.7 % + 1.3; `breach-vortex` records from before the breach (no-skip plant red); ZDBG gone. F7 traced: the any-fuel tail is mostly **pockets where the summed wells out-pull the thrust** (T22.03G)
- [x] [T22.03F](M22/T22.03F-winged-bots-pinned-in-space.md) — Winged bots pinned in space — depends on T22.03D — `space::flies` excludes wings, so a winged bot uses the walking buttons in space: against rock 0–1.4 %, runs to 51 s; rule whether the detour applies, then bound it — **built (builder's call, for confirmation): not the space detour — winged pinning is as common in standard; a stuck winged bot sweeps UP/DOWN (the jump wings refuse); winged runs 39 → 4 over four draws, bound 0.015 red at the parent; any-fuel runs beside a vortex counted apart, the rest bounded at 0**
- [x] [T22.03G](M22/T22.03G-wells-that-outpull-the-thrust.md) — Pockets where the summed wells out-pull the thrust (and a vortex against rock) — **ruled R96: the wells' sum capped at `SPACE_WELL_ACCEL_MAX`, vortex/hole uncapped; built; items a bot cannot take are no longer its goal; any-fuel runs 0.005–0.089 → 0–0.021, bound 0.06; the vortex-against-rock runs remain (filed in the task)** — each well is under the weakest thrust, their **sum** is not: (18, −919) px/s² vs 900 under a rock ceiling holds a body in place in every direction, **humans too**; plus a bot pinned by a vortex against rock, and a bot sitting 12 px from an item it never picks up
- [x] [T22.03H](M22/T22.03H-the-walking-shovel-stand-off.md) — The walking model's shovel stand-off — depends on T22.03D — 40 px floor vs the shovel's 28 px reach, fixed in flight only; measure on flat ground first — **built: `Bot::hold_off` shared by both models; shovel swings 73 → 143 over 16 standard rounds; standard kills 1.96 → 2.37 pooled; the vertical melee miss filed in the task**
- [x] [T22.04](M22/T22.04-thrusters-and-the-burst.md) — Thrusters: the energy cost and the burst you can see — depends on T22.03 — **the plume fires opposite the direction you travel**; move down and it is above you. Asserted on rendered pixels with velocity as the control, in **both** render paths — T21.36's flames covered **85–108** of 192 burn points with High Quality off. **The four render combinations collapse to three** — every shader predicate is `webgl && isHighQuality()`, so on Canvas the HQ toggle changes nothing
- [x] [T22.04B](M22/T22.04B-the-plume-in-a-real-match.md) — The plume in a real match, and never outside space — depends on T22.04 — the review **saw** the plume on all three render paths and three plants went red, but **a plume drawn under normal gravity leaves vitest and three e2e checks green**, and GameScene's space wiring (`lobby_state` → `gravity`, `space:` at both `setState` calls) is reached by no check at all. Also files **T22.04C**: the local plume follows thrust input, not velocity — braking, and thrusting out of a well while still falling, both show it on the wrong side
- [x] [T22.04C](M22/T22.04C-the-plume-follows-the-thrust-input.md) — The local player's plume follows the thrust input, not velocity — **built**: `GameCore::thrust_at` (the stepped input's `thrust_delta`), braking pixel-asserted in both render paths, `GameScene` wiring asserted in `thrusters-match`; remotes stay on velocity (re-checked: no direction on the wire) — depends on T22.04B — filed by T22.04B from the review's F5. Every plume points off velocity, so **braking** (drift right, thrust left) draws it on the side you push toward, and a player **thrusting out of a well while still falling** toward the rock draws it on the wrong side — `T22.11`'s core situation, exactly when the plume is being read. Bots brake on purpose (`R5`). Local player only, off the input the mirror stepped with; **remotes stay on velocity**, since the input is not on the wire
- [x] [T22.05A](M22/T22.05A-the-space-map-boundary-and-asteroids.md) — The space map: the boundary and the asteroids **(large)** — depends on T22.01 — **the shape is decided: an ellipse**, revised 2026-09-20 — every map is 2:1, so a true circle leaves half the arena dead, and the minimap is 2:1 too, so an inscribed ellipse draws as the owner's circle in the one place the shape is ever visible. This is the split the original asked for. Golden hashes move through the **retry loop**, not through shared RNG (which is isolated and pinned by two tests): `report.passed` reads `JUMP_REACH`/`JUMP_HEIGHT`, so a flipped verdict re-derives every substream. 24 data rows become 36. **Walk-traversability is meaningless here**, so the acceptance predicate is a deliverable
- [x] [T22.05B](M22/T22.05B-the-space-map-spawns-objects-and-up.md) — The space map: spawns, objects, and everything that assumes "up" **(large)** — depends on T22.05A — **spawns are the blocking problem**: the generator derives them from a surface and there is none. `surface_points` is also the only input `LavaBurst::new` reads, and birds take their altitude from the median column top. Eight subsystems assume up and each needs a ruling — the owner has already reported floating scenery twice and perched gates once, each one of these surfacing late
- [x] [T22.05C](M22/T22.05C-the-followups-the-review-found.md) — The follow-ups T22.05B's review found — depends on T22.05B — the review returned **ship with follow-ups**, and every item is this project's signature defect rather than a crash. The two that matter: the *“space ships no pads, platforms or decorations”* test is probably satisfied by a build with **three of its five guards deleted**, because the same commit removed the ground those samplers were finding; and two comments say a crate in space **“floats there”** in the present tense while `WorldItems::step` passes a literal `1.0` — so today all loot falls to the bottom of the ellipse, which is the first thing a player would see. `minimap.mjs`'s **8** `waitForTimeout` calls are the `smoke-shader` shape in a brand-new check
- [x] [T22.05D](M22/T22.05D-two-remedies-that-do-not-hold.md) — Two of T22.05C's remedies do not do what their comments say — depends on T22.05C — `R57`, from the second review. The biconditional `assert_eq!(space_moved == 0, Space.scale() == 0.0)` **passes** when you plant the scale 0.0 → 0.5, because every term moves with the constant — CLAUDE.md's `ITEM_SPAWN_INTERVAL` shape, in the commit written to close that class. And `periodic_items_…`'s new assertion sits **behind a guard that fires first**, so under the one plant it was added for the loop never runs and the test still dies on “nothing spawned”. Nothing is broken — the sentences are wrong. Filed as its own row because folding it into a bigger task is how `R14`'s animals row got lost for a milestone (`R58`)
- [x] [T22.06](M22/T22.06-the-space-backdrop.md) — The space backdrop: sun, moon, earth, stars, and they move — depends on T22.01 — **switching the sky stack off is most of this task**: the day/night cycle, clouds, fog, ambient rain and the parallax ridge, each with a live check behind it. Inherits the `living-sky` trap (`worldView.y` refreshes in `preRender`, so a layer laid out in `update` trails the camera by a frame — probed at 9, 8, 6, 5, 5, 3 px). **Read the seed from the wire**: a networked client's `core.meta.seed` was measured at 1 across four rounds
- [x] [T22.06B](M22/T22.06B-what-the-backdrop-review-found.md) — What the backdrop review found — depends on T22.06 — **two guards that cannot fail** (a never-drawn moon passes `space-sky`; the asteroid control compares zero pixels) and **one thing a player hears**: the day/night audio cue plays every half-cycle in space. **T22.08's rulings R78–R85 and its forward sweep are in [T22.08-RULINGS-AND-SWEEP.md](M22/T22.08-RULINGS-AND-SWEEP.md)** — the next builder starts there
- [ ] [T22.07](M22/T22.07-spacesuits-and-the-visor.md) — **Superseded by M23 `R9` (2026-09-23): wearables are removed, every figure in space wears a helmet with a visor in the player's own colour, no picker — do not build this row.** Spacesuits, with a visor colour you choose — depends on T22.05B, T20.04, T20.12 — a forced body with a chosen accent, and **the chosen skin must come back when the mode ends**. Procedural, and **silhouette not palette** — a picker whose options differ only by colour is a picker with one option, which is what this brief asks for. `skins.json`'s skin 5 is skin 0 tinted, so any comparison must pick different atlas prefixes and say why
- [ ] [T22.08](M22/T22.08-solar-flares.md) — Solar flares — depends on T22.01 — **`BurnField` is the wrong home and its own first line says so** ("Damaging ground zones"); a ribbon moving through open space is the thing §F12 ruled out. New shape, or a deliberate widening with the comment rewritten. Burns for `N` seconds, default 4. **`R27`: `BurnField` no longer holds the burn-duration model and has not since §F10.2 — all three fires left that file; the model the owner described is `poisoned_until`.** The decisive obstacle to widening is not the doc comment but the wire: the hazard channel has **no move event** at all, so a flare's position must be a pure function of (seed, elapsed) re-derived client-side, the `LavaClock` precedent. The T21.25 citation was backwards too — that check **does** read health bars, because T21.25 is the task that added them
- [x] [T22.08A](M22/T22.08A-solar-flares-the-rust-end.md) — Solar flares, the Rust end — depends on T22.08's rulings R78–R85 — the ribbon as a pure function of (seed, elapsed), contact, `burning_until` and its per-second burn, the space weather table keyed on the map at roll time, forcing refused off a space map, the meteor-in-space load guard, `REPLAY_VERSION` 17
- [x] [T22.08B](M22/T22.08B-solar-flares-the-client-end.md) — Solar flares, the client end — depends on T22.08A — the prominence-loop shader and its Canvas twin drawn off `GameCore::flare_points`, `solar-flare` / `-canvas` / `-standard` checks, coverage of every damage point in both render modes
- [x] [T22.08C](M22/T22.08C-what-the-flare-review-found.md) — What the flare review found — depends on T22.08A — **a flare burned on the results screen** (8a2 ungated; now the lava-way window + a `Playing` belt), **a schedule guard that could not fail** (now a golden recorded before the flare), **the damage number showed the roll, not what landed**, two hardcoded test numbers, a silent `WEATHER=flare` refusal
- [x] [T22.08D](M22/T22.08D-where-the-flare-is-drawn.md) — Where the flare is drawn — depends on T22.08B, T22.08C — **the match check probed with the scene's own clock** (a +0.5 s origin stayed green), the ribbon's clock ran backwards off a 0.1 s snapshot time, burning shown off a client-only contact test, no running-effect catch-up for a joiner, a 16 s banner over a 12 s ribbon, `terrain-render` stale since T22.06
- [x] [T22.08E](M22/T22.08E-what-the-second-flare-review-found.md) — What the second flare review found — depends on T22.08D — **the flare clock stepped back 213 ms after a 300 ms stall** (now slewed, least-delayed samples), **a real burn at 500 ms rtt showed 1.1 s** (window + rtt, late words restore, quiet until contact ends), meteor damage confirmed flare flames, an untested probe guard and catch-up call, a probe bracket that could be any width
- [ ] [T22.08F](M22/T22.08F-the-flare-clock-check-measures-the-box.md) — `solar-flare-match`'s clock assertion measures a wall-clock round trip, so under the gate's load it fails on a coin flip (3 of 12 brackets narrow; green alone) — parked 2026-09-24; measure the client clock against the server's tick without a round trip, then un-park
- [x] [T22.09](M22/T22.09-radiation-and-the-shield-economy.md) — Radiation, and what a shield means now — depends on T22.01 — 1 damage a second unshielded — and **at the shipped numbers the mode is unsurvivable by ~17x**: nobody spawns with a battery (`PlayerState::new` sets `battery: 0.0`), the per-second shield drain was **deleted** by T20.08 and must not come back, and `BATTERY_PACK`'s 5.81 % weight yields **2.69 packs a round for the whole lobby**. `R24` rules the design: **the suit battery is a second health bar radiation eats first** — 1 energy per second buys 1 damage avoided, `BATTERY_MAX` equals `BASE_HEALTH`, full suit at spawn and on respawn, double weight in space. Also **the blocking question of whether the suit's shield is the one that already exists** (`shield_active`, the generator item, `SHIELD_DAMAGE_MULT`): one predicate with two sources, or a second thing that makes `shield_active` answer two questions. Battery packs already exist as item 6 — what is missing is a reason to want one — **R24's numbers kept (coordinator, 2026-09-23): measured 0.69 radiation deaths/player/round over 8 seeds, survivable; R24's own arithmetic (~1.1 for a player ignoring batteries) corrected in the journal**
- [x] [T22.09A](M22/T22.09A-radiation-the-rust-end.md) — Radiation, the Rust end — depends on T22.01 — `R73`'s split: the damage (1/s unsealed, one log a second), the suit's drain (1 energy/s sealed), `DamageSource`/`DeathCause::Radiation`, the suit battery full at spawn and respawn, the pack's space spawn weight doubled, snapshot bit 7 = irradiated, `REPLAY_VERSION` 16, and the 8-seed space balance report `R24` owes
- [x] [T22.09B](M22/T22.09B-radiation-the-client-end.md) — Radiation, the client end: a player can tell it is happening — depends on T22.09A — the edge vignette and HUD line off bit 7, `R20`'s silent client end (`GameScene`'s allowlist turns `"radiation"` into `'player'`), and the `radiation` browser check this row's parent's Done-when names
- [x] [T22.09C](M22/T22.09C-what-the-radiation-review-found.md) — What the radiation review found — depends on T22.09B — `GameScene`'s bit-7 reader **could not fail**: the review planted it `&& false` and moved `FLAG.irradiated` onto poisoned's bit, and every check stayed green. A wire-byte codec row, a `DEV_START_BATTERY` knob and a networked `radiation-match` check; `affected.mjs` selecting only the last entry of a shared check file (F4); the HUD line clipping below ~550 px and the sealed line up outside `Playing` (F8); F5 refuted by measurement
- [x] [T22.10](M22/T22.10-the-breach-vortex.md) — The breach vortex — depends on T22.05A, shares T22.05B's destination picker — *"a fun secret"*: a hole in the rim is a vortex that recycles you, so **it is containment dressed as a reward** rather than decoration. **Detection goes in `Map::circle`**, the one chokepoint all five production carve sites funnel through — a check at the explosion path misses four, and the fifth is a tombstone. `T22.05A`'s closure test is a claim about *generation*; this makes holes at *runtime*; both are true and the distinction is written into both files
  - [x] [T22.10A](M22/T22.10-the-breach-vortex.md) — the Rust half — breach detection in the two public carves (once per call, R19), `world/vortex.rs` (≤3, same-hole merge, wings taken, fuel kept, T22.05B's picker), the pull through the one `env_at` sum, R16's void arm, events + `set_vortices`
  - [x] [T22.10C](M22/T22.10C-what-the-vortex-review-found.md) — what the vortex review found — R86 the caught player is put down clear of every hole's pull and the cooldown no longer lets a vortex decline (2–5 of 12 seeds died in the void), R87 a breach is closed → open (a phantom vortex over solid rim), R88 an evicted vortex keeps catching; prediction's real call site tested; bots seed pinned
  - [x] [T22.10D](M22/T22.10D-the-input-path-follow-ups.md) — the input path's follow-ups from the review of T22.10B — one burst policy (the room takes a whole long frame, the world catches a backlog up one extra input per owed tick: no drop, no snap, no speed-up), every in-match verb in arrival order (`select_slot` then `fire` fired the old weapon), the reconcile gate compares the prediction at the ack, `teleport` was a check bug, one spent entry per hole
  - [x] [T22.10E](M22/T22.10E-credit-and-the-results-screen.md) — catch-up credit can no longer be banked (dead, warmup or silent, then cashed as a 2× dash); after the bell your own body stops rubber-banding (the client ran on predicting from inputs the server was ignoring); the bell check proves bo is airborne and burning first; rubber-band maxima skip the snapshot after a trip or a rematch
  - [x] [T22.10F](M22/T22.10F-a-silent-player-hangs-in-the-air.md) — the server now moves every player every tick, repeating what they last held when their input is late, so nobody hangs in mid-air and nobody can dash on saved-up input; your own game keeps real time and mirrors those repeats, so a slow frame costs one small correction instead of a freeze
  - [x] [T22.10G](M22/T22.10G-the-buffer-R89-asked-for.md) — the server now holds each player's inputs two ticks before running them, so a slightly late input no longer counts as a missed one, and nobody is moved before their game has started sending; the big snaps at the start of a space match (up to 60 px) are gone
  - [x] [T22.10H](M22/T22.10H-positions-to-an-eighth-of-a-pixel.md) — positions and speeds now reach your game to an eighth of a pixel, rounded instead of cut off, so your own body stops being nudged back toward where the server rounded it; the black-hole and thruster checks tightened to match
  - [x] [T22.10B](M22/T22.10B-the-vortex-on-screen.md) — the client half — mirror the list into `setVortices` (else a rubber-band), draw the swirl on both paths, off the minimap, `breach-vortex` pixel check — **and three pre-existing netcode defects its rubber-band arm found**: input packets reordered by the async handler (137 seq gaps in one match), only the last three of a frame's inputs sent, the ack on receipt not consumption
- [ ] [T22.11](M22/T22.11-asteroid-gravity-wells.md) — Asteroid gravity wells **(large)** — depends on T22.05A, measured against T22.04 — **this retires "zero gravity" as a description of the mode**: no *global* gravity, but many local wells at levels 1–5. **The seam does not exist** — `apply_gravity` is `body.vel.y += GRAVITY * gravity_scale * dt`, a scalar on one axis, and "towards that point" is a vector; choosing between a new argument and a new function is the largest design call in M22. `MAX_FALL_SPEED` clamps `vel.y` only, so **there is no terminal velocity here until this task writes one**. **SPLIT 2026-09-21 into T22.11A/B/C (`R45`) — 15 files and 12 production call sites.** The five levels are derived from `JETPACK_CLIMB_BUDGET`, **not** a delta-v the thruster does not have (`R18`), and the escape ceiling is against `JETPACK_THRUST_DOWN` not `JETPACK_THRUST_UP` (`R46`, overturning `R18`) — otherwise **a well nobody can escape kills with no cause on screen**
- [x] [T22.11A](M22/T22.11A-the-force-seam.md) — The force seam, and no behaviour **(large)** — depends on T22.03, T22.05B — `R45`'s split of T22.11. Two structs replace three argument lists so `T22.11B` has somewhere to put a vector field: `integrate` **5 → 4** and `apply_input` **9 → 8**, both of which carry the words *“that is a finding”* in R10, R44 and at the code. Changes no pixel — except `R48`, which is a **bug in a shipped mode**: four steppers pass a literal `1.0`, so in low gravity **a dropped weapon falls at twice the speed of the player who dropped it**. **No `Default` on `Forces`**, for the reason `MoveMods::NONE` already gives: it would make the whole space suite pass while testing a space with no wells in it
- [x] [T22.11B](M22/T22.11B-the-field.md) — The field **(large)** — depends on T22.11A, T22.05A — `T22.11A` left `accel` at `Vec2::ZERO` and **nothing in the tree can report a field that never fires**: deleting its application left 1062/1062 passing, and all 20 `player/space.rs` tests run on an asteroid-free fixture. The first test closes that hole or nothing does. Falloff is **linear to a cutoff**, not inverse-square (`R47` — pinned to an escapable ceiling, inverse-square gives 4.4 px/s² at one climb budget against an 1100 px/s² thruster). The escape ceiling is against **`JETPACK_THRUST_DOWN`**, not UP (`R46`, overturning `R18`) — the binding case is a player on a rock's underside with 900 px/s², not 2200. **May not borrow `no_tunnelling_…` as its speed guard** (`R50`: four documents said it would work and it does not). R36's cross-side hash test is red-first
- [x] [T22.11C](M22/T22.11C-the-client-sees-the-field.md) — The client sees the field — depends on T22.11B — the wells are proven **nine ways in Rust and zero ways on screen**, which is the exact shape CLAUDE.md's rendered-pixel rule was written for (`R63`: `scripts/e2e.mjs asteroid-gravity` was in a Done-when and **does not exist** — `grep asteroid scripts/` returns 0). And the client has **no rocks at all**, not stale ones (`R49`): `GameCore::new()` generates on the standard generator, so a networked client predicts against a field of exactly zero. Three layers remain — `set_asteroids`, the wrapper, and **one line** in `applyMapInit` next to its own precedent. `env_at` is already shared by both sides, so do not compose an `Env` on the client
- [x] [T22.12](M22/T22.12-the-black-hole.md) — The black hole **(large)** — depends on T22.05A, T22.11 — arrives at a random time in the **last minute**, permanent, eats one asteroid, and inside the horizon **you cannot escape**. That is the deliberate exception to T22.11's escape guarantee: scope that guard to asteroids and give this one the inverse assertion, or "you cannot escape" is a claim nothing tests. **The scheduler does neither "permanent" nor "at T-minus"** — every effect today is interval-scheduled with a duration — so decide whether it belongs there or in the round controller. The horizon is a **state change**, not a very strong pull
  - [x] [T22.12A](M22/T22.12-the-black-hole.md) — the Rust half, the wire and the prediction mirror — arrives in the last minute every space round, eats one rock (list, mask, well), pulls through the one `env_at`, kills inside the horizon (`black_hole` cause, both ends), frozen after the bell on both sides, respawns kept out of its reach, client core told the hole and the rock it ate
  - [x] [T22.12B](M22/T22.12B-the-black-hole-on-screen.md) — the black hole on screen (both render paths) and the `black-hole` networked check: no rubber-band while pulled, cannot escape, both-ends agreement, frozen at the bell
  - [x] [T22.12C](M22/T22.12C-what-the-black-hole-review-found.md) — what the black-hole review found — the ring you see is now the whole rule: just outside it every thruster gets you out, inside it you die; nearby rocks stop pulling near the hole, a death in it drops nothing, it flashes a two-second warning where it will open and shows on the minimap; the results screen no longer tugs you toward it; bots stop shopping in it
  - [x] [T22.12D](M22/T22.12D-rounds-counted-in-ticks.md) — rounds counted in ticks — a round lasts exactly as long as it says (a ten-minute round ran a tenth of a second over), so the game always knows the exact moment the round ends and stops the black hole's tug on you right on it, even when your connection is slow; the dev placement no longer counts as a rubber-band
  - [x] [T22.12E](M22/T22.12E-what-the-tick-review-found.md) — what the tick review found — a real mistake in your prediction right after a teleport is counted again instead of being hidden; the round's end tick on the wire is checked against the server's; the results countdown reads the same end tick
- [x] [T22.13](M22/T22.13-nothing-lives-in-space.md) — Nothing lives in space — depends on T22.01, T22.05B — **`R14` said “no animals at all in space” and nothing ever implemented it** (`R58`, found by the second review): `step_animals` passes `playing` with no mode test, and neither `animals.rs` nor `birds.rs` knows the mode. So a space round spawns **beetles and spiders standing on the rim in a vacuum** — the only remaining M22 bug a player would see immediately. Fell between three tasks because T22.11A correctly read the ruling down to “a spawning rule, not this stepper’s” and R45 gave it only the signature changes. **Gate on the generator, which R15 derives from the mode, not on `self.gravity`** — two answers to one question is what R15 exists to prevent. The control is the whole test: a standard round on the same seeds must still spawn them

**Order note.** T22.01 first and alone; everything reads the setting. Then the branches.
**T22.05A's generator is `MapGenerator::Space`, derived from the mode** (`R15`) — a third
variant is what grows the golden table 24 -> 36 for free; a `GravityMode` branch would ship the
map with no golden coverage at all.
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
never heals, takes players only, and stays off the minimap. **Twenty-three rulings** now, after four
forward sweeps: `Forces`/`MoveStep` for gravity, **one** attractor list, a new type for the
flare, an inset **ellipse** rim with void outside it, the levels derived from
`JETPACK_CLIMB_BUDGET`, breach detection de-duplicated at the carve call, the black hole in
the round controller rather than the scheduler, and a `?gravity=` parameter on the sandbox
without which five browser checks cannot reach the mode at all.

**An amendment is owed and is not written.** `docs/13`, `docs/14` and `docs/10` all describe
behaviour this milestone overrides in one mode, and `docs/20-player-movement.md:235` still
refuses fall damage outright. Per `CLAUDE.md` the coordinator writes `docs/77-amendments-v9.md`
**when the work lands**, not now.

**Checkpoint:** host a match in space and float between asteroids on your thrusters, watching
the plume fire from the opposite side; run your energy down and drift; take a battery pack and
watch the radiation stop eating you; see a solar flare cross the arena and get out of its way;
look up and see the earth, moved since the round began.

## M23 — The art refactor: darker, more 3D, stick figures (24)

**Specified 2026-09-23, not started; M22 finishes first (`R16`).** The owner chose mockup direction F. **The goal is a set of pictures** in [M23/reference/](M23/reference/README.md) — *"make the 4 pictures your goal. it should look exactly the same"* — and the code that rendered them is the reference implementation. Read **[M23-art.md](M23/M23-art.md)** (the ask, rulings R1–R16, verification, build order), then `M23-INVENTORY.md` (what exists today) and your task file. `M23-RESEARCH.md` is the evidence behind the rulings.

**Three findings that shape it:** the map theme is **simulation** (it stamps object silhouettes into the collision mask), so themes are removed on the client only; Phaser 3.90 has **no HDR render targets**, so three.js draws the world under Phaser (R1) and the Canvas fallback retires (R2); and the pictures are drawn at **zoom 1**, four times today's view, so the view constants are restated and bots get their own engagement range first (R6).

- [ ] [T23.00](M23/T23.00-webgl2-on-the-owners-machine.md) — WebGL2 on the owner's machine — **gates the milestone**: today the owner's WSLg Chrome falls back to Canvas and three.js needs WebGL2 with half-float targets
- [ ] [T23.01](M23/T23.01-the-look-lab.md) — The look-lab — the renderer's input as types, and F1–F5 ported as data so the pictures can be reproduced, not approximated
- [ ] [T23.02](M23/T23.02-look-compare.md) — `look-compare` — the instrument and its must-fail controls, thresholds measured between the noise floor and the smallest failing control
- [ ] [T23.03](M23/T23.03-three-under-phaser.md) — three.js under Phaser — one world canvas, Phaser's camera the single source of truth, laid out in `preRender`
- [ ] [T23.04](M23/T23.04-the-hazy-stepped-sky.md) — The sky — stepped haze layers, stars, moons, god rays; the old sky, ridge and clouds retire with their checks
- [ ] [T23.05](M23/T23.05-terrain-fields-in-rust.md) — Terrain fields in Rust — exact EDT, cave-back and relief per dirty rectangle, render-only in `game-wasm`, incremental == full
- [ ] [T23.06](M23/T23.06-albedo-and-scorch.md) — Painting the rock — albedo on the GPU with the mockup's hash bit-exact, one palette, scorch from explosions
- [ ] [T23.07](M23/T23.07-the-lit-terrain.md) — The lit terrain — bevel, rim, lip, cave interiors, 16–24 lights, two tiers; `masks.bin` byte-identical
- [ ] [T23.08](M23/T23.08-fog-depth-and-post.md) — Fog, foreground depth and the post chain — **the first picture gate**: nothing after it starts until F1's numbers are in
- [ ] [T23.09](M23/T23.09-effects-are-the-lights.md) — Effects are the lights — one light list per frame from game events, every source with a production caller
- [ ] [T23.10](M23/T23.10-zoom-out-and-the-night-view.md) — Zoom out (`CAMERA_ZOOM` 2 → 1) and the night view drawn F's way — `BOT_ENGAGE_RANGE` lands first so bots do not change
- [ ] [T23.11](M23/T23.11-night-and-moonlit-day.md) — Night and moonlit day — two palettes blended by darkness, moons on arcs; the cycle's timing does not move
- [ ] [T23.12](M23/T23.12-the-actor-atlas.md) — The actor atlas — everything alive drawn by code per frame into three-channel cells
- [ ] [T23.13](M23/T23.13-rim-lit-silhouettes.md) — Rim-lit silhouettes — `lit()` as one sprite shader; the rim never tints the scarf; the halo in tunnels
- [ ] [T23.14](M23/T23.14-the-stick-figure.md) — The stick figure — poses, run cycle, continuous aim, scarf, space helmet; boots and wings redrawn, not removed
- [ ] [T23.15](M23/T23.15-no-themes-no-wearables.md) — No themes, no wearables — client only: the theme stamps collision and the join JSON still carries skins
- [ ] [T23.16](M23/T23.16-firearms-remodelled.md) — The firearms remodelled — **21 of 24 holdable weapons draw nothing in the hand today**; one design per weapon for hand, ground and inventory
- [ ] [T23.17](M23/T23.17-melee-and-thrown-remodelled.md) — Melee and thrown weapons remodelled — all 23 holdables, silhouettes measured apart
- [ ] [T23.18](M23/T23.18-effects-in-the-new-renderer.md) — Effects in the new renderer — HDR tracers, beams, blasts, fire, smoke, plumes; the simulation halves keep their coverage assertions
- [ ] [T23.19](M23/T23.19-the-world-furniture.md) — The world's furniture — gates, platforms, crystals, crates, animals, birds, hazards; every gameplay signal re-asserted on pixels
- [ ] [T23.20](M23/T23.20-space-in-the-new-look.md) — Space in the new look (F3) — T22.06's behaviour, F3's picture
- [ ] [T23.21](M23/T23.21-the-hud.md) — The HUD restyled — no number the HUD shows today is lost
- [ ] [T23.22](M23/T23.22-the-picture-gates.md) — The picture gates — F1–F7 reproduced at Level A, the live game compared at Level B
- [ ] [T23.23](M23/T23.23-count-both-ends.md) — Count both ends — all 51 old pixel checks accounted for, the old art gone, perf on both tiers, the golden tables untouched

**Checkpoint:** host a match. It looks like F1 at night and F5 by moonlit day, the camera shows four times as much map, figures are rim-lit ink stick figures with a scarf in your colour, every gun has its own silhouette, and explosions, lasers and plumes light the rock and figures around them. Space looks like F3. The golden tables have not moved.
