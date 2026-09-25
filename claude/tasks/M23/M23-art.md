# M23 — The art refactor: darker, more 3D, stick figures

**Specified 2026-09-23 at the owner's request, not started.** Builders read this file, `CLAUDE.md`,
`M23-INVENTORY.md` (what exists today) and their own task file. `M23-RESEARCH.md` is the evidence behind the
rulings and is worth reading for any task in the renderer.

## The ask, verbatim

> *"i really liked art direction F.. lets go for it. m23 will be art refactor options. darker, more 3d, stick
> figures. remove the whole themes and wearables for now. all the guns should be remodeled. the dark, almost alien
> worlds are amazing, so the day/night cycles should also be changed, there will be night and, sort of a moonlit
> day where the view is fuller and the moon(or moons) shine in the background. make the 4 pictures your goal. it
> should look exactly the same. i also like that its a bit more zoomed out and more of the map is visible at all
> times."*
>
> *"keep the photos as assets in the m23 folder as reference to always be used and compared to. generate all the
> assets yourself. you can obviously reference what we use now but design and create new ones."*

## The goal is a set of pictures, and they are binding

`reference/` holds them. **Every task in this milestone is judged against them, by measurement (§ Verification),
not by eye alone.**

| file | what it is | status |
|---|---|---|
| `F1-night-combat.png` | the standard map at **night**, the milestone's primary target | owner-approved |
| `F2-volcanic-night.png` | the same scene in a volcanic palette | owner-approved — **see R5: themes are out, so this is a reference for how effects light a scene and for a future theme, not a shipping look** |
| `F3-space.png` | space mode (M22) in the new look | owner-approved |
| `F4-cast-sheet.png` | the cast at 3×: figures, animals, weapons, props, effects | owner-approved |
| `F5-moonlit-day.png` | the **moonlit day** phase of F1's scene | coordinator-made from the owner's words; owner to confirm |
| `F6-weapon-sheet.png` | every holdable weapon remodelled, with its effect | coordinator-made; owner to confirm |
| `F7-pose-sheet.png` | the stick figure's poses, run cycle, aim angles, space helmet | coordinator-made; owner to confirm |
| `F0-today-same-scene.png` | today's look, same composition — the **must-fail control** for every comparison | — |

**`reference/mockup-src/` is the code that rendered F1–F7** (three.js 0.170, headless Chromium, swiftshader). It is
not a sketch: **it is the reference implementation.** Every colour, falloff, layer order and pose in the pictures is a
number in those files (`f_kit.js`, `kit.js`, `e_style.js`, `world.js`, `f_scene.js`, `variant_F*.js`). A builder who
needs a value reads it there, and a port that disagrees with it is wrong until the picture says otherwise.
To re-render: copy the folder to a scratch dir, `npm i`, then
`LD_LIBRARY_PATH=$HOME/.cache/pwlibs/root/usr/lib/x86_64-linux-gnu nice -n 19 node render.mjs F1` (see `render.mjs`).

## Rulings (coordinator, 2026-09-23 — each reversible; "Reverse it by" says how)

- **R1 — three.js draws the world; Phaser keeps scenes, input, camera, audio and UI.** A three.js 0.170.x canvas sits
  under a transparent Phaser canvas; its ortho camera copies `cameras.main.worldView` each frame, so Phaser's camera
  stays the single source of truth. Evidence: Phaser 3.90 allocates only 8-bit textures on a WebGL1 context, so the
  pictures' HDR bloom and ACES tonemap cannot be reproduced there (`M23-RESEARCH.md` § Recommendation).
  *Reverse it by:* porting the same shaders to Phaser 4 render nodes — the renderer input (R11) does not change.
- **R2 — the Canvas fallback for the world is retired.** three 0.170 needs WebGL2 and has no Canvas renderer. A
  machine without WebGL2 gets a clear full-screen message, not a broken game. **`T23.00` proves the owner's own WSLg
  Chrome gets WebGL2 first** (today it falls back to Canvas) — if it cannot, M23 stops and this ruling is revisited
  before anything else is built. The Canvas checks (`canvas-renderer`, `*-canvas` variants) retire with the layers
  they photograph. *Reverse it by:* freezing today's Phaser look as a fallback path.
- **R3 — the simulation does not change.** Not the mask, not collision, not physics, not the wire, not the replay
  format. Every M23 commit leaves `tests/golden.rs` and `a_resting_body_is_bit_identical_after_600_ticks` untouched.
  The **only** simulation-adjacent constants that move are the view ones in R6, and none of them is hashed.
- **R4 — terrain fields are computed in Rust, not TypeScript.** The distance fields (`dIn`, `dOut`), cave-back mask and
  relief the terrain shader reads are derived from the mask by a **render-only module in `game-wasm`** (not
  `game-core`: it is not simulation), per dirty rectangle, exact Felzenszwalb EDT saturating at 64 px as the mockup
  does. CLAUDE.md forbids map logic in TS; this keeps that true. Albedo/relief *painting* is a GPU shader (the
  mockup's hash is integer and ports bit-exact to WebGL2).
- **R5 — themes are removed on the client only.** `map/meta.rs::theme_for` feeds `map/gen/objects.rs::theme_weights`,
  which stamps object silhouettes **into the collision mask** — the theme is simulation. So the Rust theme, the
  `map_init` theme byte and `assets/objects/masks.bin` stay byte-identical; the client stops reading the theme and
  draws one world (F1/F5's palette pair). Stamped objects render as lit terrain, except crystals, which keep F's glow
  and light. The `decor` atlas (non-colliding decorations) retires. *Reverse it by:* a palette table keyed by theme.
- **R6 — `CAMERA_ZOOM` 2.0 → 1.0**, which is what the pictures are drawn at (four times the visible area). The view
  constants whose stated basis is zoom 2 are restated so the **on-screen** fraction is unchanged: `FOV_DAY` 320 → 640,
  `FOV_NIGHT` 110 → 220 (world px). **Bots do not change behaviour:** `bots/mod.rs` reads `FOV_DAY` as an engagement
  range today, so that read moves to a new `BOT_ENGAGE_RANGE` = 320 first, in its own commit, with every bot test
  green before the zoom moves. *Reverse it by:* the two constants. **Owner question, answered by default:** whether
  bots should see further now that players do — default no.
- **R7 — night and moonlit day replace the day/night look; the cycle's timing does not change.** `world/cycle.rs`
  (durations, `darkness_at`, `DayPhase`, `last_day_phase` in the hash) stays. The client blends two palettes, night
  (F1's `P`) and moonlit day (F5's `P`), by `t = darkness / NIGHT_DARKNESS` in linear space; 2–3 moons move on arcs
  with the cycle; stars follow `t`. **The night seeing rule stays** (`renderRemotes`: hidden beyond `fov` at night)
  but is *drawn* as F1's darkness — a soft falloff into the night palette — never the old black MULTIPLY lightmap.
- **R8 — wearables are removed on the client only.** Skin, hat, glasses and tombstone choice stay on the wire and in
  replays (JSON join fields, `Join{skin_id}`), and the client ignores them. The skins screen, its menu entry and the
  accessory art go; **the player name stays** (`ui/skins.ts::NAME_KEY` moves somewhere that survives). Boots and wings
  are **items, not wearables** — they are redrawn on the stick figure, not removed. Tombstones become one ink stone.
- **R9 — `T22.07` (spacesuit skin + visor picker) is superseded.** In space every figure wears F7's helmet
  silhouette with a visor in the player's own colour; there is no picker (its own "silhouette, not palette" rule argues
  against one). The M22 row is annotated, not deleted.
- **R10 — player colour is a scarf.** Six colours, one per seat (`MAX_PLAYERS`), chosen for contrast in **both**
  night and moonlit day and against every effect colour; the local player also gets the marker. Rim light tints a
  figure's outline, never its scarf (F4's caption). Strong colour is reserved for danger (shots, fire, lasers,
  explosions) and identity (scarf, marker); a new effect may not add saturated colour anywhere else.
- **R11 — the renderer takes plain data.** A scene description shaped like the mockup's (mask + back mask, actors,
  lights, palette `P`, camera). `GameScene` and `SandboxScene` fill it from the sim; the **look-lab page fills it from
  the mockup scenes verbatim**. That page is what makes "exactly the same" measurable, so it is built first.
- **R12 — every visual is generated by code in this repo.** No external art tools (research § 4: the pictures are
  100 % code). Figures, animals, weapons and props are drawn procedurally per frame into atlas cells (aim and pose
  stay continuous); icons for the inventory and pickups are drawn by the same functions.
- **R13 — no orphaned checks.** 51 browser checks assert on today's pixels (list in `M23-INVENTORY.md` § 7). A task
  that replaces a layer **rewrites or retires every check that photographs that layer in the same commit**, and says
  which in its journal line. `T23.23` counts both ends: 51 in, each either rewritten or retired with a reason.
- **R14 — High Quality now picks a tier, not whether shaders exist.** Full = the pictures. Low = the same look with
  the costly passes baked or dropped (sun-shadow march baked, half-resolution bloom), for weak GPUs and for the
  swiftshader browser checks. Default: full. Every check that photographs the look runs the tier it names.
- **R15 — the old art retires with its last reader**: the `chars`, `decor`, `fx` (already unread) atlases,
  `procTextures.ts`, `sky.ts`, `parallax.ts`, clouds, `lightmap.ts`, `accessoryTextures.ts`, `weaponTextures.ts`,
  `canvasTint.ts`. Deleting a reader and leaving its tests green is the thing CLAUDE.md calls green tests guarding a
  picture nobody draws (T21.27).
- **R16 — M22 finishes first.** M22's remaining visual work (solar flare, vortex, black hole) is built in today's
  renderer and ported by `T23.18`. `T23.00`–`T23.02` and `T23.05` touch nothing M22 does and may run alongside it if
  the coordinator hands out the box.
- **R17 — the cave wall is air that was rock in the generator's landform OR rock at round start** (coordinator,
  2026-09-25, answering T23.05's report). So both generated caves and craters carved in play show the wall, as the
  mockup does (`world.js::buildMask`: `back` = landform ∧ carved). `render_fields.rs` takes that "was rock" mask as an
  input (`RenderFields::full_with_wall`); today only the round-start half is fed, and **`T23.05B`** supplies the
  generator half to the client. `chunkBake-math.ts::BackdropMask`'s enclosure heuristic is not used.
  *Reverse it by:* feeding only the round-start snapshot (`RenderFields::full`).

## Verification — what "exactly the same" means here

Two levels (`M23-RESEARCH.md` § 7):

- **Level A, exact.** The look-lab renders the mockup scenes through the game's renderer at 1280×720 in the same
  headless swiftshader Chrome as `render.mjs`, and `scripts/lib/look-compare.mjs` compares with the reference PNG:
  FLIP mean and p95, SSIM on luminance at ½ scale, ΔE2000 per region (sky, terrain, actor boxes).
- **Level B, live.** A staged sandbox frame (fixed seed, frozen sim time, scripted actors firing, zoom 1) over several
  seeds, compared by distribution: luminance histogram, p5/p50/p95 luminance, an 8-colour palette's mean ΔE to the
  reference, saturation histogram, edge density, fraction of pixels above the bloom threshold.
- **Thresholds are measured, never picked.** Floor = the mockup rendered twice. Must-fail controls = F0 vs F1, and
  single-knob changes (exposure ±10 %, bloom off, rim off, fog off, F2's palette swapped in). Each threshold sits
  between the floor and the smallest failing control, **and both numbers are written in the check** — CLAUDE.md's
  "a metric with no control is a number, not evidence".
- **And look at it.** Every task that changes a picture screenshots it next to the reference and a person-readable
  side-by-side goes in `shots/`. CLAUDE.md: a fix that changes the code without changing the picture looks exactly
  like a fix that worked.

## Build order

    T23.00 ─ T23.01 ─ T23.02                          (measure before building)
               └─ T23.03 ─┬─ T23.04 ─────────────┐
    T23.05 ─ T23.06 ─ T23.07 ─ T23.08 ────────────┼─ T23.10 ─ T23.11
                         └─ T23.09 ──────────────┘
               T23.03 ─ T23.12 ─ T23.13 ─ T23.14 ─┬─ T23.15
                                                  ├─ T23.16 ─ T23.17
                                                  └─ T23.19
                         T23.08 + T23.09 ─ T23.18 ─┘
                         T23.08 + T23.13 ─ T23.20
               T23.03 ─ T23.21
    everything ─ T23.22 ─ T23.23

- **T23.00 first and alone**: if the owner's Chrome cannot get WebGL2, R1/R2 are revisited before any code.
- **T23.05 is pure Rust** and can start the same day.
- **The first picture gate is after T23.08**: the look-lab's F1 background + terrain + fog + post, compared at
  Level A with actors masked out. Nothing past it starts until that gate's numbers are in the journal.
- Owner sign-off on F5–F7 is **not** a blocker (R-default: build to them; a changed picture is a changed number).

## Checkpoint

Host a match. It looks like F1 at night and F5 by moonlit day, the camera shows four times as much map, figures are
rim-lit ink stick figures with a scarf in your colour, every gun has its own silhouette from F6, and explosions,
lasers, muzzle flashes and thruster plumes light the rock and the figures around them. Space looks like F3. The
look-lab reproduces F1–F4 within the measured thresholds, and the simulation's golden tables have not moved.

## Owed

`docs/78-amendments-v10.md` (the art direction, zoom, FOV restatement, skins/themes removal) is written by the
coordinator **when the work lands**, as with `docs/77` for M22.
