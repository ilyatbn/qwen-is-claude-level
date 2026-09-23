# M23 research — how to rebuild look F faithfully (2026-09-23)

Read-only research agent, web sources below. Numbers marked *estimated* were not measured — measure
before relying on them. The rulings that adopt or overrule this live in `M23-art.md` § Rulings.

## Recommendation: three.js draws the world, Phaser keeps everything else
- The world renders on a **three.js 0.170.x canvas (the version `reference/mockup-src/package.json` used) under a
  transparent Phaser canvas**. Phaser keeps scenes, input, camera math, audio, UI; the HUD is DOM on top.
- The three.js ortho camera **copies `cameras.main.worldView` every frame** — Phaser's camera stays the one source of
  truth, so every reader of `debug().zoom` / `worldView` keeps working.
- Renderer input is **plain data shaped like the mockup's scene description**: mask + back mask, actors, lights, palette
  `P`, camera. `GameScene` feeds it from the sim; a **look-lab page feeds it the mockup scenes verbatim**, which is
  what makes an exact comparison possible.
- **Why three.js:** the four pictures are the output of exactly this stack — half-float render target (4× MSAA) →
  UnrealBloom → OutputPass (ACES tonemap + sRGB) → grade. `kit.js`, `f_kit.js`, `e_style.js` port almost verbatim.
- **Why not Phaser 3.90:** every texture it allocates is 8-bit (`gl.UNSIGNED_BYTE`, `WebGLTextureWrapper.js`) and it
  creates a WebGL1 context (`WebGLRenderer.js`): no HDR target without raw-GL hacks, so dark scenes band, bloom
  inputs above 1.0 clip (the mockup's explosion is 2.0, soft sprites 2.5) and ACES has nothing to roll off. Its
  `BloomFXPipeline` is one LDR blur, not UnrealBloom's multi-resolution chain.
- **Why not Phaser 4** (4.0.0 2026-04-10, 4.2.1 2026-07-09; WebGL2; "filters"): a whole-renderer migration (custom
  pipelines → render nodes, `setTintFill` change, no Mesh, Canvas deprecated) and its docs say nothing about float
  targets — we would still hand-write UnrealBloom and ACES. Revisit after M23.
- **Risks:** (1) two renderers — every Phaser object drawn in the world moves to three.js or is dropped (terrain,
  sky, parallax, weather, lightmap, ordnance shaders, birds, animals, pads); the look replaces them anyway.
  (2) **No Canvas fallback**: three 0.170 requires WebGL2 (WebGL1 removed in r163) and has no Canvas renderer.
  (3) Browser checks run on swiftshader (`scripts/lib/browser-args.mjs`) — a full-screen lit terrain + bloom is slow
  there; needs a low quality tier for `perf.mjs` and timing checks. (4) `pixelArt: true` / `antialias: false` must
  go for world art; the mockups use smooth filtering and 4× MSAA.
  Sharing one GL context via Phaser `Extern` + three's `resetState` was considered and rejected (GL state leaks).

## 1. Frame stack (from `mockup-src/f_kit.js::frame`)
1 background quad (`bgMaterial`, ≤6 stepped layers) → 2 back fog → 3 lit terrain (`kit.js::terrainMaterial`) →
4 front fog → 5 2D actor layer (tonemapped too: OutputPass tonemaps the whole buffer) → 6 3D fx (additive
`ribbon`, soft `sprite`, `explosion`) → 7 foreground depth-of-field → 8 post: half-float + 4× MSAA → UnrealBloom
`P.bloom` (F1 `[0.6, 0.45, 0.7]`) → OutputPass (ACES, exposure 1.1) → grade (saturation, warm/cool split,
vignette, grain) after the sRGB conversion. Port as-is.
**Point lights:** mockup has 10 uniform slots (`pl[10]`, `plc[10]`). Raise to 16–24; cull to view + radius, sort by
intensity × on-screen coverage, keep top N. Screen pixel count is zoom-independent, so per-pixel cost is too.
**Quality tier:** the terrain shader does ~40–65 texture reads/px (10-step sun-shadow march, 4 height + 4 brightness
taps, 5×5 object-shadow loop). `occl` is a blank 4×4 texture in every F scene — dropping it changes nothing. Bake what
changes only with terrain (normals, height, sun shadow, interior depth) per dirty rectangle; per frame the shader is
albedo × (baked sun + ambient + Σ point lights). Keep a low tier for swiftshader checks.

## 2. Terrain fields
`world.js::derive` produces exact Felzenszwalb distance transforms `dIn` (depth into rock) and `dOut` (distance
from rock), **stored ×4 in 8 bits, so both saturate at 64 px**; `back` (cave wall); `relief` (boulders, strata);
painted albedo (strata, grain, Worley boulders, pebbles, cracks, soil + grass on up-facing edges, scorch, grass
fringe into the air). Maps: Small 2048×1024, Medium 3072×1536 (default), Large 4096×2048; `CHUNK_SIZE` 256.
`render/chunkBake.ts::BackdropMask` already equals `back[]`.
**Update scheme:** a crater only changes the field inside its bounding box + 64 px. Recompute that rectangle reading
a +128 px margin; write into **one world-sized RGBA8 field texture** with `texSubImage2D` (Medium ≈ 19 MB; Large fits
4096). One world texture avoids seams (the shader reads ~50 px away). *Estimated:* full transform at load ~0.1 s
(Medium); crater r=60 → ~61k px rect, ~1–3 ms. Measure before adopting GPU jump-flood (~7 passes to 64 px, ping-pong
targets); it only wins if CPU misses `CHUNK_REBAKE_MS`.
**Albedo:** a CPU port of `derive` is ~15 noise calls/px — seconds for 4.7 M px. Generate albedo + relief on the GPU
per dirty rect into RGBA8 (WebGL2 has uints, so `world.js::hash`'s `Math.imul` ports bit-exact). Scorch becomes an
accumulated scorch-mask texture fed by explosion events. All render-only; nothing reads back into `game-core`.

## 3. Lights and rim-lit silhouettes
One list per frame, entries `L(x, y, z, r, rgb, i)`, falloff `(1 − d/r)²` as in the shader. From `f_scene.js`:
explosion z70 r460 i3.2 (decays); laser impact z30 r170 i2.4; muzzle z30 r120 i1.8 (1–2 frames); jet plume z20 r100
i1.3; rocket z20 r120 i1.5; flamethrower z20 r150 i2.0; gate z30 r150 i1.6; crystal z20 r100–110 i1.0–1.2. Colours
`P.fire`, `P.laser`, `P.muzzle`, `P.gate`, `P.crystal`. Static lights (crystals, gates) in a spatial list; dynamic ones
from events the client already renders.
**`lit()` → one sprite shader.** `f_kit.js::lit` draws far rim at `L·o·1.7` (alpha .35a/.3a), rim at `L·o`, sky fill at
`−0.7·L`, then ink. A 3-channel sprite (R ink incl. scarf, G accent/scarf, B glow parts) reproduces those passes in one
shader; rim passes turn the accent into rim colour and drop marker and flame, as in the mockup. `dominant(lights, x, y,
moon)` ports verbatim, per actor per frame on the CPU. Contact shadow = one ellipse sprite.

## 4. Figures, animals, weapons — all code
Port `e_style.js` `stick`, `beetle`, `spider`, `bird`, `turret`, `gate`, `crystals`, `rocket`, `smoke`, `explosion`
to TS Canvas2D; draw each visible actor per frame into a 64×64 cell of one shared atlas canvas, one texture upload per
frame, cache unchanged cells (~30 actors is cheap; aim/pose stay continuous — pre-baked frames would quantise aim).
Figure ≈ 35 px tall at zoom 1 (30 × 1.15); `PLAYER_H` 28 → draw at ~1.2× the hitbox (render constant, not physics).
Animation: hip/neck/head as `stick()`; legs two-bone IK to foot targets on a speed-driven walk phase (~8 key phases);
blend stand/run/jet/fall/dead; arms + weapon rotate about shoulder `[1.2, −21.5]` by aim; scarf lags velocity.
Weapons: 23 holdable need a model; 4 internal (meteor_fragment, airburst_pellet, toxic_drop, flame) do not.
**External tools: none needed.** All four pictures are 100 % code. Blender (blender-mcp) no — no 3D assets, the 3D is
distance-field lighting. Aseprite/Spine/TexturePacker no. Inkscape (inkmcp) only for hand-sketching, little gain.
**Worth installing for verification:** `pip install flip-evaluator scikit-image` (NVIDIA FLIP).

## 5. Zoom
Mockups are **zoom 1.0** (a 1280 px map strip spans 1280 screen px); today `CAMERA_ZOOM` 2.0 shows 640×360. Matching
the pictures is `CAMERA_ZOOM` 1.0 — 4× the visible area. Full-screen shader cost unchanged; actors, particles, lights,
atlas cells ×4; visible chunks ~12 → ~24. Readers: `cameraRig.ts::CameraRig`, `cameraRig-math.ts::visibleSize`,
`lightmap.ts`, `parallax-math.ts`, `sky.ts`, `ui/feelLayer.ts`, `ui/minimap.ts`, `ui/results.ts`, Sandbox/Preview
scenes, `audio/mixer.ts` (pan width; falloff = `FOV_DAY`), `game-wasm` (test asserts 2.0); constants whose basis is
zoom 2: `FOV_DAY` 320 / `FOV_NIGHT` 110 (§A16), sky sizes "in camera px", `MOUNTAIN_HEIGHT_FRAC`, cloud and bird
comments. **`bots/mod.rs` uses `FOV_DAY` as engagement range.** Server reads neither zoom nor viewport.

## 6. Sky: night and moonlit day
Extend `bgMaterial`'s one sun into ≤3 moons (position, radius, colour, own ray strength; rays occluded by layers).
A look is one palette object `P` (bg, terrain, fog, fg, moon rim, bloom, grade, exposure). Night = F1's `P`; moonlit
day = a second `P` (brighter sky/haze, stars faded, terrain light/ambient up, lighter fog, 2–3 moons, exposure ~1.3).
Blend `t = darkness_at(cycle_u) / NIGHT_DARKNESS` in linear space; shapes fixed; moons on arcs; stars follow t.

## 7. Verifying "exactly the same"
**Level A (exact):** the look-lab feeds the renderer the mockup scenes verbatim (`buildMask(ARENA_E)`/space, same
actors, lights, `P`), screenshot 1280×720 in the same headless swiftshader Chrome as `render.mjs`, compare with F1–F4:
FLIP mean + p95, SSIM on luminance at ½ scale, ΔE2000 per region (sky, terrain, actor boxes).
Thresholds: measure the noise floor (render the mockup twice; the lab on two back-ends), build must-fail controls (F0
vs F1; exposure ±10 %, bloom off, rim off, fog off, F2's palette swapped in), set each threshold between floor and
smallest failing control, record both numbers in the check.
**Level B (live, statistical):** sandbox staged frame (fixed seed, frozen sim time, scripted actors, zoom 1) over
several seeds vs the references: luminance histogram (Wasserstein), p5/p50/p95 luminance, 8-colour k-means palette
mean ΔE, saturation histogram, edge density, fraction above bloom threshold; bounds from the F1/F2/F3 spread, F0 the
must-fail control. SSIM/histograms/palette/edges in JS with `pngjs`; FLIP via pip.

## Sources
- Phaser releases / 3 vs 4 / filters / shader guide: https://github.com/phaserjs/phaser/releases ,
  https://phaser.io/news/2026/05/phaser-3-vs-phaser-4 , https://phaser.io/news/2026/05/phaser-4-filter-system ,
  https://github.com/phaserjs/phaser/blob/master/docs/Phaser%204%20Shader%20Guide/Phaser%204%20Shader%20Guide.md
- Phaser PostFXPipeline: https://docs.phaser.io/api-documentation/class/renderer-webgl-pipelines-postfxpipeline
- Phaser + three.js Extern: https://phaser.io/examples/v3.85.0/game-objects/extern/view/threejs-cube
- UnrealBloomPass: https://github.com/mrdoob/three.js/blob/dev/examples/jsm/postprocessing/UnrealBloomPass.js
- Jump flooding: https://blog.demofox.org/2016/02/29/fast-voronoi-diagrams-and-distance-dield-textures-on-the-gpu-with-the-jump-flooding-algorithm/ ,
  https://en.wikipedia.org/wiki/Jump_flooding_algorithm
- Tools: https://github.com/ahujasid/blender-mcp , https://github.com/diivi/aseprite-mcp , https://github.com/Shriinivas/inkmcp
- FLIP: https://github.com/NVlabs/flip , https://pypi.org/project/flip-evaluator/
