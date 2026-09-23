# M23 inventory — what the art refactor replaces, restyles, keeps (read-only survey, 2026-09-23)

Symbols, not line numbers. Taken on `HEAD` at the time of writing; **re-verify before relying on a
count** — T22.06 (space backdrop) was landing in parallel.

## The finding that constrains everything: themes are simulation
`map/meta.rs::theme_for` (RNG sub-stream "theme") → `MapMeta.theme` → `map/gen/objects.rs::theme_weights`
→ `stamp_objects(mask, seed, scale, theme)` **ORs object silhouettes into the collision mask**.
`tests/golden.rs::meta_digest` hashes `m.theme`. **Removing themes is client-only.** The Rust theme,
its weights, the `map_init` `u8 theme` wire byte and `assets/objects/masks.bin` (`include_bytes!` in
`game-core/src/map/objects.rs`) stay byte-identical. Object *art* may be repainted; object *masks* may not.

## 1. Render stack
- Layer order: `backdrop.ts::DEPTH` (sky -30, parallaxFar -22, parallaxClouds -21, parallax -20, birds -19,
  caveBack -10, terrain 0, decorations 10, worldItems 20, actors 30, particles 40, lightmap 50). Keep and extend.
- Terrain (REPLACE): `worldView.ts::WorldView` (fill/edge/back from `procTextures.ts` makeFill/Edge/BackTexture);
  `chunkBake.ts`/`chunkBake-math.ts` (mask→stencil→textured chunks; `EDGE_BAND_PX` grass `edgeBits`;
  `BackdropMask`/`backdropBits`; `MaskSnapshot`); `terrain.ts::TerrainRenderer` (placement, rebake budget,
  `setCaveBackdropDefault`); `noise-math.ts`; `objects.ts` (drawObjects/atlasArt/ObjectIndex). Mask plumbing and
  `BackdropMask` stay.
- Sky/day-night (REPLACE): `sky.ts::SkyLayer`; `sky-math.ts` (KEYFRAMES, cycleU, skyPhase, skyColors,
  darknessAt, sceneDarkness, bodyPositions, starField, starAlpha, mountainProfile, cloudTint);
  `themes-math.ts::daySkyBottom`, `worstSkyContrast`.
- Parallax/clouds (REPLACE with stepped haze layers): `parallax.ts::ParallaxLayer` (713 lines),
  `parallax-math.ts` (uses `cam.zoom`), `clouds-math.ts`.
- Space backdrop: `spaceSky.ts`, `spaceSky-math.ts` (T22.06) — restyle to F3.
- Weather (RESTYLE): `weather.ts::WeatherLayer` (rain, toxic rain, meteors, fog shader under WebGL+HQ);
  `weather-math.ts::fogVeilAlpha`, `ventLights`.
- Lighting (REPLACE core): `lightmap.ts::Lightmap` (MULTIPLY darkness RT with radial holes), `lightmap-math.ts`
  (`fovRadius`, `lightmapNeeded`). The per-frame `LightSource` lists in `GameScene` (player FoV,
  `ordnance.lights()`, `fx.lights()`, `ventLights`) are the seed of F's effect lights.
- Players (REPLACE with stick figures): `playerView.ts::PlayerView(scene, skinId, hatId, glassesId)`; `playerView-math.ts`
  (deriveAnimState, facingLeft, walkFrameMs); `skins-math.ts`; `accessoryTextures.ts` (hats, glasses, bootArt,
  wingArt); `canvasTint.ts::bakeTintedAtlas`. **Boots and wings are gameplay items — keep, redraw.**
- Projectiles/beams/explosions (RESTYLE, already procedural): `ordnance.ts`, `ordnance-state.ts` (`lights()`),
  `ordnanceFx.ts`/`-math`, `shaders.ts` (hasWebGL, FOG/BEAM/SMOKE/FLAME/BLAST/THRUST_FRAGMENT, FBM) —
  **no bloom or grade pass exists**. `thrusterPlume.ts`, `radiationFx.ts`.
- Creatures (REPLACE, procedural): `animals.ts` (spider, beetle), `birds.ts` (normal, metal).
- Pickups (REMODEL): `itemSprites.ts` (`items` atlas or procedural), `itemTextures.ts::ensureItemTextures`.
- World objects: `pads.ts` (gate, `images/gate.png`), `platforms.ts`, `tombstones.ts`/`tombstoneTextures.ts`
  (stone choice is a skin), `decorations.ts`/`-math` (`decor` atlas, kind = theme*6+i), `debugOverlay.ts` (keep).
- Camera: `cameraRig.ts`, `cameraRig-math.ts::visibleSize` — keep, change zoom.
- HUD (DOM, restyle): `ui/hud.ts`, `bars.ts`, `inventory.ts`, killfeed, `scoreboard.ts`, `results.ts`,
  `deathOverlay.ts`, `debugHud.ts`, `feelLayer.ts`, `escapeMenu.ts`, `optionsPanel.ts`, `ui/minimap.ts`.
- Scenes: `GameScene.ts` (~3458 lines), `SandboxScene.ts` (~1648, a parallel copy — setZoom, darkness()),
  `PreviewScene.ts`, `SkinsScene.ts`, `TitleScene.ts` (live-scene background), `MenuScene.ts`.

## 2. Themes (client readers to remove)
`themes-math.ts` (THEMES, resolveTheme), `procTextures.ts`, `worldView.ts`, `parallax.ts`, `sky.ts`, `GameScene.ts`,
`SandboxScene.ts` ("theme N" readout), `decorations-math.ts` (kind→frame), `assets.ts::themeNames` (dead: manifest
`themes: []`), `build-atlas.mjs` / `verify-assets.mjs` theme loops. Tests: vitest themes-math, procTextures-math,
decorations-math, codec, worldMirror; checks `m9-checkpoint` (asserts 3 themes by seed), `terrain-seed`,
`gate-ground`, `decorations`.

## 3. Wearables / skins (client-only removal; wire untouched)
Registry `assets/skins.json` (players 0–5; `weapons[]`; `tombstones[]`), `render/assets.ts::skins()`,
`skins-math.ts::validateRegistry`, `accessoryTextures.ts::HAT_ART`/`GLASSES_ART`, `SkinsScene.ts` (menu `#skins`,
`?skins=1`), `ui/skins.ts` (SKIN_KEY, STONE_KEY, HAT_KEY, GLASSES_KEY, **NAME_KEY — keep the name**, Appearance,
sameAppearance, loadChoice, saveChoice, weaponSlots). **Never in snapshot bytes**: JSON only (`session.rs` join
skin_id/tombstone_skin_id/hat_id/glasses_id → `room.rs::Look`; `LobbySeat`; `events.rs` player_join, scores,
tombstone_spawn.skin_id); game-core `PlayerState` fields excluded from the hash; **replay stores `Join{skin_id}`**.
Leave the wire; ignore it client-side. Checks: `skins`, `skins-ingame`, `canvas-tinted-skin`, `lobby`, `rematch`,
`harness.mjs::openClient({skin})`, `lib/client-keys.mjs` (fails if `skins.ts` *_KEY exports vanish),
`no-dev-surface`. 12 vitest files. **T22.07 (spacesuits + visor) depends on skins — re-scoped by M23.**

## 4. Weapons (ids from `items/registry.rs`, defs `weapons/defs.rs::WEAPONS`)
0 bazooka, 1 grenade, 2 smg, 3 meteor*, 4 meteor_fragment*, 5 laser_pistol, 6 laser_smg, 7 pistol, 8 revolver,
9 deagle, 10 machinegun, 11 knife, 12 bat, 13 whip, 14 axe, 15 hammer, 16 flamethrower, 17 mine, 18 airburst,
19 smoke, 20 molotov, 21 toxic_grenade, 22 airburst_pellet*, 23 toxic_drop*, 24 shovel, 25 flame*, 26 platform_gun
(* sub-munition, no held art). **Held art exists for 3 of 24 holdable weapons** (`weaponTextures.ts::WEAPON_ART`:
bazooka, grenade, smg); every other `PlayerView.setWeapon` draws a 0×0 rectangle. Key via `worldView.ts`
`WEAPON_KEYS`; `skins.json weapons[]` duplicates muzzle/pivot. Ground/inventory icons: atlas for 3, procedural
`itemTextures.ts` for the rest. Projectile look: `ordnance.ts::render` by `p.kind`; `ordnanceFx.ts`.

## 5. Day/night — the gameplay that must survive
`constants.rs`: DAY_DURATION 60, NIGHT_DURATION 60, CYCLE_TRANSITION 8, NIGHT_DARKNESS 0.82, DAY_DARKNESS 0,
SUN_RADIUS, MOON_RADIUS, CYCLE_LENGTH. `world/cycle.rs` (DUSK_START .50, NIGHT_START .62, DAWN_START .90, cycle_u,
darkness_at, DayPhase, fov_radius, `cycle_matches_the_client` parity test). `World::darkness()` (0 in space) → snapshot
darkness byte; `PhaseChange` → `phase_change` event; **`last_day_phase` is hashed**. Vision: `fov_radius` lerps
FOV_DAY 320 → FOV_NIGHT 110 by darkness × fog (`FOV_FOG_MULT`, `FOV_SMOKE_MULT`) × health; flashlight is carry-only
`FLASHLIGHT_FOV_MULT` 1.5 at night (no cone any more), flag bit 4; seeing rule `GameScene::renderRemotes`
`visible = darkness <= 0.01 || d <= fov`; minimap `visibleRemotes(fov)`. Vision is client-side only.
Divergence: GameScene's `lightmap.render` omits `fogActive`; Sandbox passes it.
Checks: sky, living-sky, night_darkens_the_world, lightmap, night-combat, m9-checkpoint, m4-checkpoint,
lava-lights, fog-visible, fog-shader, clouds, cloud-rain, space-sky, sim-clock.

## 6. Camera zoom
`constants.rs::CAMERA_ZOOM = 2.0` (VIEWPORT 1280×720), exported via `game-wasm` (test asserts 2.0),
`client/src/core/index.test.ts` expects 2. Readers: `cameraRig.ts`; audio pan half-width in Game/SandboxScene;
live `cam.zoom` in parallax, spaceSky, lightmap. **No server interest management/culling exists.**
`FOV_DAY`/`FOV_NIGHT` were restated for zoom 2 (§A16) — re-tune. `lightmap-math.test.ts` (FOV×zoom 90–110),
`night_darkens_the_world.mjs` fixed screen px. 25 checks read `debug().zoom` dynamically.

## 7. Checks a restyle breaks
79 check files; **51 assert on rendered pixels** (ambient-rain, animals, asteroid-gravity, beams-shader, birds,
boots-visible, bullets-visible, canvas-renderer, canvas-tinted-skin, cloud-rain, clouds, crates, debug-mode,
explosion-shader, fire-shader, fire-visible, fog-shader, fog-visible, fps-counter, gate-ground, hud-bars, hud-timer,
inventory-ui, lava-lights, lightmap, living-sky, lobby, m4-checkpoint, m9-checkpoint, minimap, minimap-crates,
night_darkens_the_world, objects, ordnance-visible, platform-autofire, platforms, radiation, radiation-match,
rematch, skins, skins-ingame, sky, smoke-shader, space-sky, teleport, terrain-render, terrain-seed, title, void,
weather-visible, wings-visible). Hex literals: hud-timer, hud-bars, space-sky, space-sky-match, pixels.
Vitest: 19 of 75 files depend on colours/themes/atlas/skins, plus 7 `backdrop-real-*` suites.

## 8. Assets and guards
`assets/manifest.json`: atlases chars (50), decor (18), items (8), fx (20 — **referenced by no client code**),
objects (160); image gate; `themes: []`. `build-atlas.mjs` (atlas-map.json), `build-object-masks.mjs` (reads
../sprite_packs → objects/manifest.json + **masks.bin, collision, keep byte-identical**). `verify-assets.mjs`
(in check.sh) fails on missing atlas/png, missing skin frame, unknown weapon-skin atlas, opaque decor frame, missing
objects manifest or vendor provenance; it does not check for unused assets. `gateSprite.test.ts`.

## 9. High Quality / Canvas
`ui/settings.ts` (HIGH_QUALITY_KEY default off, isHighQuality, onHighQualityChange, FPS_COUNTER_KEY);
`ui/optionsPanel.ts` (built only in GameScene; disabled without WebGL). Shader users gate on `webgl && isHighQuality()`.
`main.ts::rendererType` (`?renderer=canvas` dev-only, else AUTO). **The owner's WSLg Chrome falls back to Canvas.**
