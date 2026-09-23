# UI_Refactor_Handoff.md

**Audience:** a model doing an art/visual pass on this game.
**Goal:** change how everything *looks* without touching the Rust server or the
simulation core.

Read this before opening any file. It is written to answer one question at every
turn: *if I want to change how X looks, which file do I edit, and what will break?*

---

## 0. The thirty-second version

* The game is **Phaser 3 + TypeScript** in `client/`, with the simulation in
  **Rust** (`crates/game-core`) compiled to WASM and also run server-side.
* **Nothing about appearance is on the network.** The server sends integers
  (`skin_id`, `hat_id`, `item_id`, `theme`) and never a texture name. So an art
  overhaul is a `client/` + `assets/` change, full stop.
* There are **two art paths**, and you need to know which one a thing is on:
  1. **Packed atlases** — real PNGs in `assets/atlas/*.png`, built from vendor
     art by a script, referenced by frame name.
  2. **Procedural canvas painters** — TypeScript functions that draw the sprite
     with `CanvasRenderingContext2D` calls at boot and register it as a Phaser
     texture. **Most of the game's art is currently on this path**, including
     every weapon, every hat, 22 of 28 item icons, all tombstones, all terrain
     textures, birds, and ground animals.
* Every lookup **falls back** rather than throwing. `docs/50` §8 is a hard rule:
  *the game must boot with zero art on disk.* Do not remove a fallback.
* **The one place art and physics are coupled** is scenery objects (rocks,
  bushes, ruins, crystals): their silhouettes are converted to 1-bit collision
  masks at build time and embedded into the Rust crate. Changing that art
  changes the map. Section 6 covers it.

---

## 1. Where things live

```
claude/
├── assets/                     ← art on disk, served at the web root
│   ├── manifest.json           ← THE load list. Nothing else names a file.
│   ├── atlas-map.json          ← which vendor PNG becomes which atlas frame
│   ├── skins.json              ← the player/weapon skin registry
│   ├── atlas/                  ← BUILT, committed: chars, decor, items, fx,
│   │                             clouds, objects  (.png + .json per atlas)
│   ├── objects/                ← BUILT: masks.bin + manifest.json (collision)
│   ├── audio/  audio-map.json  ← sounds
│   ├── fonts/kenney-future-narrow.ttf
│   └── vendor/kenney/          ← raw downloaded packs, GITIGNORED
├── client/src/
│   ├── scenes/                 ← Phaser scenes (Title, Menu, Game, Sandbox, …)
│   ├── render/                 ← everything drawn in world space
│   ├── ui/                     ← everything drawn in screen space (DOM)
│   ├── core/                   ← the WASM bridge; C() = simulation constants
│   └── net/                    ← wire codec + world mirror
├── scripts/
│   ├── build-atlas.mjs         ← atlas-map.json → assets/atlas/*
│   ├── build-object-masks.mjs  ← ../sprite_packs → masks.bin + objects atlas
│   ├── build-cloud-atlas.mjs   ← ../sprite_packs/clouds → clouds atlas
│   ├── verify-assets.mjs       ← the asset gate (see §9)
│   └── checks/*.mjs            ← the headless-browser checks, many pixel-based
└── ../sprite_packs/            ← raw scenery art (bushes, rocks, ruins,
                                  crystals, clouds). Outside the repo, read-only.
```

**Convention you will see everywhere:** a module `foo.ts` that touches Phaser has
a sibling `foo-math.ts` that does not. All the arithmetic and all the decisions
live in `-math.ts` so they can be unit-tested in node. **Put logic in the
`-math` file; put draw calls in the other one.**

---

## 2. The load path

`client/src/render/assets.ts` is the whole of it.

1. `fetch('/manifest.json')` → the list of atlases, loose images, terrain themes
   and audio.
2. `fetch('/skins.json')` → the player + weapon skin registry, validated by
   `skins-math.ts::validateRegistry`, which returns a list of problems instead of
   throwing.
3. Each atlas is queued with `scene.load.atlas(key, png, json)`.
4. Every failure is caught, logged once, and degrades to placeholders.

**Adding a new PNG-backed asset is a `manifest.json` edit, never a code change.**
That is `docs/51` §6 and it is enforced by `verify-assets.mjs`.

`assets/` is served at the web root, so `assets/atlas/items.png` is `/atlas/items.png`.

---

## 3. Map textures (terrain)

**This is procedural and there is no PNG to replace.** It is also the single
biggest visual lever in the game.

| Concern | File |
|---|---|
| Palette per theme | `client/src/render/themes-math.ts` |
| Tile generation | `client/src/render/procTextures.ts` |
| Mask → textured chunk | `client/src/render/chunkBake.ts` (+ `-math`) |
| Chunk placement, rebake budget | `client/src/render/terrain.ts` |
| Cave backdrop classifier | `chunkBake-math.ts::BackdropMask` |

### How it works

The map is a 1-bit solidity mask owned by Rust. The client bakes it into
256×256 px canvas chunks. For each pixel the baker picks one of **three
layers**:

* **`fill`** — the body of the terrain,
* **`edge`** — the upward-facing rim, a few px thick. This is what makes ground
  read as ground rather than as a blob,
* **`back`** — rock seen *through* craters and cave mouths.

Each layer is a seamless mottled noise tile generated by
`procTextures.ts::makeNoiseTile(size, baseRgb, spread, seed)`, which samples value
noise on a torus so the tile repeats without a seam.

`themes-math.ts::THEMES` is a table of three themes (`grassland`, `desert`,
`frost`), each with `fill`/`edge`/`back` RGB, a per-layer `spread` (mottling
strength), and three tints (`skyTint`, `fogTint`, `lightTint`) that are
multiplied into the sky, the fog and the light sources so the whole frame agrees.

### To change the look of terrain

* **Cheapest and highest impact:** edit the RGB and `spread` values in
  `THEMES`. Nothing else needs to move.
* **Next:** rewrite `makeNoiseTile` to paint something other than two octaves of
  value noise — strata, gravel, crystalline facets. It must stay **seamless**
  (sample on a wrapping lattice) or every 256 px boundary shows a line.
* **To use real PNGs instead:** the pipeline already supports it. `manifest.json`
  has a `themes: []` array; adding a name there makes `verify-assets` require
  `assets/terrain/<name>/{fill.png,edge.png,back.png,theme.json}`, and a theme
  with PNGs on disk overrides the procedural palette. This path is *declared but
  currently unused* — `themes: []` is empty. Expect to write the small amount of
  loader code that consumes it.
* **The cave backdrop is not optional.** Without it a crater punched through a
  hillside shows sky, and the map reads as paper instead of rock. See the
  comment at the top of `backdrop.ts`.

### Constraints

* `chunkBake.ts` is **the only per-pixel loop in the renderer**. It must allocate
  nothing per bake and must never call `getImageData`. Read its header comment
  before editing.
* Texture keys carry a map generation counter. Reusing a key across a regenerate
  leaves the old pixels on screen.

---

## 4. Random map objects (scenery) — ⚠ the one art/physics coupling

Rocks, bushes, ruins and crystals. **160 objects, 40 per category.**

```
../sprite_packs/{bushes,rocks,ruins,crystals}/**.png
        │
        │  scripts/build-object-masks.mjs
        ▼
assets/objects/masks.bin       1-bit alpha masks, packed  → include_bytes! in Rust
assets/objects/manifest.json   id, key, pack, category, w, h, anchor, offset
assets/atlas/objects.png/.json the art the client draws   → 160 frames obj_0…obj_159
```

**The mask is the collision.** Map generation stamps an object's mask into the
terrain, so a rock *is* terrain: it blocks movement and a rocket blows a hole in
it, for free. `client/src/render/objects.ts` draws the art into the chunk bake
*before* the bake clips the chunk to the live mask, which is why blowing away
half a rock removes half its pixels.

### What this means for you

* Changing an object's **silhouette changes the map's collision.** That is a
  simulation change, not a cosmetic one. It is allowed, but it is the one place
  in this document where "art only" is false.
* Sizes are set by four constants in `crates/game-core/src/constants.rs`:
  `OBJECT_TARGET_PLAYER_H_{BUSH,ROCK,CRYSTAL,RUIN}` (in units of player height,
  currently 1.5 / 2.25 / 1.5 / 3.0). These are *the only place* an object size
  lives — the scale factors, the mask extents and the atlas are all derived from
  them at build time. Change one and rerun the builder.
* After changing anything under `../sprite_packs/` you **must** rerun
  `node scripts/build-object-masks.mjs`, and `--check` mode rebuilds and diffs
  without writing (the gate uses it).
* Ids are positional and go into `masks.bin` by offset. Do not reorder.

---

## 5. Player skins and accessories

### The wire

The server knows **one `u16` per player: `skin_id`**. It never validates it
against a list and never sends a texture name. `hat_id`, `glasses_id` and
`tombstone_skin_id` ride the same way. Adding a skin is a client-side change with
no server deploy. (`docs/50` §1.)

### Body — atlas-backed

`assets/skins.json` → `players[]`, six entries today:

```json
{ "id": 0, "name": "Recruit", "atlas": "chars",
  "prefix": "character_player_",
  "frames": { "idle": ["idle"], "walk": ["walk_a","stand","walk_b","stand"],
              "jump": ["jump"], "fall": ["fall"],
              "jetpack": ["jetpack_a","jetpack_b"],
              "hurt": ["hurt"], "dead": ["dead"] },
  "anchor": { "x": 0.5, "y": 0.86 }, "tint": null }
```

Resolution is `atlas + prefix + frame name`. That indirection is the point:
five characters cost five registry entries and no new art, because the vendor
pack ships one rig in five variants.

* `assets/atlas/chars.png` — **50 frames, 5 characters × 10 poses**, on a
  2048×512 sheet. Poses: `idle walk_a walk_b jump fall jetpack_a jetpack_b hurt
  dead stand`.
* **`anchor.y: 0.86` is load-bearing.** The art is ~110 px tall for a 28 px
  hitbox (`PLAYER_W` 16, `PLAYER_H` 28); the anchor is where that is reconciled
  so the sprite's feet sit at the bottom of the collision box. It is *per skin*
  because different art has different proportions. **If you redraw characters at
  different proportions, this is the number you must retune**, and getting it
  wrong makes players float or sink.
* Animation state is derived in `playerView-math.ts::deriveAnimState`; the frame
  list is cycled at `walkFrameMs`. Facing is a horizontal flip.

### Accessories — procedural

`client/src/render/accessoryTextures.ts`. Drawn in code because **no vendor pack
has hats**. Two rules the file states and you should keep:

* **Differ in silhouette, not in palette.** At 16 px wide a hat is ~10 px across;
  the outline is all a player can read. A picker whose options differ only by
  colour is a picker with one option.
* **Do not borrow an atlas frame that "reads as a hat".** That mistake has been
  made here and `verify-assets` now rejects it (see §9).

Current roster — **ids are wire values, so the order is not cosmetic, and id 0
must stay a legal appearance ("None"), because a junk id falls back to 0**:

* Hats: `0 None, 1 Cap, 2 Top hat, 3 Helmet, 4 Crown, 5 Cowboy` (14×9 px)
* Glasses: `0 None, 1 Shades, 2 Round, 3 Visor` (12×4 px)
* Boots: one, `Ironman Boots`, toggled per frame from a snapshot bit rather than
  set at construction (they are picked up and dropped mid-round).

Everything is drawn at **native size** — the game renders `pixelArt: true` with
NEAREST filtering, so drawing larger only blurs.

### Tombstones — procedural

`client/src/render/tombstoneTextures.ts`. Five markers at 14×18 world px
(`TOMBSTONE_W/H`): `Headstone, Cross, Obelisk, Cracked slab, Cairn`. Same
silhouette rule. Falls back to id 0, because a grave always has a marker.

### Composition

`client/src/render/playerView.ts` assembles body + weapon + hat + glasses +
boots + shield bubble + i-frame flash into one Phaser container per player.
`skins-math.ts` holds the resolution and the placement fractions
(`HAT_WIDTH_FRACTION`, `GLASSES_WIDTH_FRACTION`, `BOOT_WIDTH_FRACTION`,
`accessoryY`, `spriteScale`).

---

## 6. Weapons

Two separate things, and they look nothing alike.

### 6a. The weapon **held in the hand**

`client/src/render/weaponTextures.ts` — **procedural, three weapons only**
(`bazooka`, `grenade`, `smg`). Every other weapon renders as fists.

Each entry carries a `muzzle` point (where the flash and the trajectory preview
start, in texture px) and a `pivot` (rotation origin as a fraction of the
texture). **These are drawn pointing right at native scale.** The renderer
rotates to the aim angle and **flips vertically** when aiming left — that is the
side-view convention; a horizontal flip would point the barrel backwards.

`assets/skins.json` → `weapons[]` mirrors the same three with `"atlas": null`,
which is a deliberate declaration meaning *drawn at runtime, not packed*, and
`verify-assets` skips frame validation for those. Weapon skins are **not on the
wire at all**: everyone sees the default; your own weapon skin is personal.

### 6b. The weapon **icon on the ground and in the inventory**

`client/src/render/itemTextures.ts` — procedural, **22 painters at 16×16 px**,
covering every weapon and item the packed atlas does not. Keys are exactly
`ItemDef.sprite` from `crates/game-core/src/items/registry.rs`.

Split today:

* **In `assets/atlas/items.png` (8 frames):** `item_medkit item_shield
  item_flashlight weapon_bazooka weapon_grenade weapon_smg crate crate_open`
* **Procedural (22):** `item_battery item_vampire_fangs item_ironman_boots
  item_unicorn_wings weapon_pistol weapon_revolver weapon_deagle
  weapon_machinegun weapon_laser_pistol weapon_laser_smg weapon_shovel
  weapon_knife weapon_bat weapon_whip weapon_axe weapon_hammer
  weapon_flamethrower weapon_mine weapon_airburst weapon_smoke weapon_molotov
  weapon_toxic`

Resolution order is `itemSprites-math.ts::artFor` — **atlas frame first, then a
registered texture key, then null → tinted fallback box.** That order is why
adding a real PNG frame named `weapon_knife` to the items atlas silently
*replaces* the procedural knife with no code change. **That is the cleanest
migration path for this whole document: draw a PNG, name the frame after the
registry's `sprite` string, add it to `atlas-map.json`, rebuild the atlas.**

`itemTextures.ts` states the reason there are 22 of these: eighteen registry
entries once pointed at sprite keys that existed nowhere and correctly fell back
to placeholders, so **every new weapon looked identical on the ground.** Keep
them distinct by silhouette.

---

## 7. Projectiles, muzzle flashes and impacts

`client/src/render/ordnance.ts` draws; `ordnance-state.ts` decides.

* **`ordnance-state.ts::LOOK` is the single table** mapping a projectile kind to
  `{ r, colour, trail }`. There used to be a second copy in the draw file; there
  is one now, deliberately. Twelve kinds: `bullet bazooka grenade airburst pellet
  smoke molotov toxic drop meteor fragment flame`.
* `WEAPON_KEYS` is the weapon-id → key table, mirrored from the Rust registry in
  **registry order**, and pinned to the Rust source by a test. If you touch it,
  the test tells you.
* Projectiles are **drawn primitives, not sprites** — a disc plus a streak. The
  particle art (`assets/atlas/fx.png`, 20 frames: `explosion_a/b/c fire_a/b
  smoke_a/b/c spark_a/b muzzle_a/b star_a circle_soft dirt_a/b trace_a light_a
  flare_a scorch_a`) is used for explosions, muzzle flashes, smoke and scorch
  decals, all downscaled to a 128 px max edge at build time.
* `ordnance.ts` feeds `lights()` straight into the lightmap, which is what makes
  night combat readable. If you change projectile colours, check them at night.

---

## 8. Everything else on screen

| Thing | File | Art path |
|---|---|---|
| Sky gradient, sun, moon, stars | `render/sky.ts` + `sky-math.ts` | procedural, five phases |
| Mountain ridge + drifting clouds | `render/parallax.ts` | ridge procedural; clouds from `assets/atlas/clouds.png` (**120 frames**) |
| Darkness overlay + light holes | `render/lightmap.ts` | 2D canvas, `destination-out` |
| Weather: rain, embers, fog veil, toxic | `render/weather.ts` + `weather-math.ts` | procedural |
| Decorations (props on the ground) | `render/decorations.ts` | `assets/atlas/decor.png`, **18 frames**, `decor_0`…`decor_17` |
| World items and crates | `render/itemSprites.ts` | items atlas + procedural (§6b) |
| Birds | `render/birds.ts` | drawn primitives: body ellipse + two wing triangles |
| Ground animals | `render/animals.ts` | drawn primitives: body ellipse + leg rectangles |
| Teleport pads | `render/pads.ts` | drawn: a ring plus a charge arc |
| Tombstones | `render/tombstones.ts` | procedural (§5) |

**Decoration frame names are positional**: kind = `theme * 6 + 0..5`, so
grassland is `decor_0`–`decor_5`, desert `decor_6`–`decor_11`, frost
`decor_12`–`decor_17`. A theme with no art for a kind simply skips it.

**Teleport pads have no sprite at all** — the ring geometry comes from `PAD_W`/
`PAD_H` through the WASM constants and the charge fill comes from a snapshot
byte, deliberately, so the indicator cannot drift from the three server-side
rules that decide whether a pad will fire. If you give pads real art, keep the
fill driven by that byte.

### Draw order

`render/backdrop.ts::DEPTH` is the one depth table. Do not invent depths:

```
sky -30 · parallaxFar -22 · parallaxClouds -21 · parallax -20 · birds -19
caveBack -10 · terrain 0 · decorations 10 · worldItems 20 · actors 30
particles 40 · lightmap 50
```

Birds are behind terrain (that is what "no collision" looks like); animals are at
`actors` because they stand on the ground.

---

## 9. The HUD and menus — screen space

**All screen-space UI is DOM, not Phaser** (`docs/70` §A35), and **there is no
stylesheet.** Every element sets `element.style.cssText` inline in its own
module. Files: `client/src/ui/{hud, bars, inventory, minimap, scoreboard,
escapeMenu, deathOverlay, results, feelLayer, debugHud}.ts`.

The display font is `assets/fonts/kenney-future-narrow.ttf`, installed as a
single `@font-face` from `ui/hud.ts` with an explicit fallback stack. Body text
is a monospace stack set in `client/index.html`.

### The inventory panel

`ui/inventory.ts` + `inventory-math.ts`. An always-visible **quick bar of 8**,
plus a **backpack of 16** in two rows behind right-click. Grid geometry is
derived from the constants (`backpackGrid`), not written down, so growing the
backpack does not lose tiles.

* **The server is the authority.** A drag emits `move_item` and then waits — the
  panel never moves its own tiles. Same for `dropItem`. Do not "fix" this.
* Tiles get their art through `deps.artUrl(sprite)`, which `GameScene` implements
  as `textures.getBase64(...)` over **the same `artFor` order the world uses**.
  So a DOM tile and the ground sprite are guaranteed to be the same picture, and
  you never need to register art twice.
* Labels: `tileLabel` / `tileCount` hide the count when it is 1.

---

## 10. How to actually change art

### Replace a procedural sprite with a real PNG (the recommended path)

1. Put the source PNG under `assets/vendor/<pack>/…`.
2. Add an entry to `assets/atlas-map.json` under the target atlas. **Frame names
   are ours, not the vendor's** — that indirection is the whole point, and it is
   what lets you swap packs with a JSON edit. For an item, the frame name must be
   the registry's `ItemDef.sprite` string exactly.
3. `node scripts/build-atlas.mjs` — rewrites `assets/atlas/*` and
   `assets/manifest.json`.
4. Nothing else. `artFor` prefers the atlas frame, so the procedural painter
   stops being reached. You may then delete the painter, or leave it as the
   offline fallback.

Atlases are **committed**; `assets/vendor/` is **gitignored**. A fresh clone
needs neither Node tooling nor the network. That also means: if you delete a
vendor file, the atlas keeps working until someone rebuilds.

### Add a player skin

Append to `assets/skins.json` → `players[]` with the next free id, an atlas name,
a prefix and a frame map. Add the frames to `atlas-map.json` and rebuild. No
server change.

### Change the whole palette

`themes-math.ts::THEMES` for terrain; `sky-math.ts` for the sky phases;
`ordnance-state.ts::LOOK` for projectiles; `backdrop.ts::DEFAULT_THEME` for the
fallback. Those four cover most of the frame.

### Rules to keep

* **Never remove a fallback.** `docs/50` §8: the game boots with zero art.
* **Silhouette over palette** for anything small.
* **Ids in `skins.json`, `HAT_ART`, `GLASSES_ART`, `TOMBSTONE_ART` and the item
  registry are wire/persistence values.** Append; never reorder, never renumber.
* **`pixelArt: true`** — draw at native size and let the engine scale.
* Keep logic in `-math.ts` files. Anything in a Phaser file cannot be unit-tested.
* Do not put physics or map logic in TypeScript. That is `game-core`, via WASM.
* TypeScript is `strict` with `no any`.

---

## 11. What will tell you if you broke something

Run `./scripts/check.sh` (the full gate, ~40 min) or `make test-fast` (no
browser). Individual browser checks are `node scripts/checks/<name>.mjs`.

Relevant gates, and what each actually asserts:

* **`scripts/verify-assets.mjs`** — every manifest path exists; every
  `skins.json` frame exists in its atlas; skin ids are unique; **and every
  `decor` frame is under 90 % opaque.** That last one exists because two
  "decorations" turned out to be 98 %-opaque terrain tiles that rendered as flat
  squares standing on the ground. If you add a decoration and the gate calls it a
  terrain tile, it is right.
* **`node scripts/build-object-masks.mjs --check`** — rebuilds the scenery masks
  and diffs. Red means the committed `masks.bin` no longer matches
  `../sprite_packs`.
* **The headless-browser checks in `scripts/checks/`** (49 sections ran in the
  last full gate). Many assert on **rendered
  pixels** with a control region and a control frame, because this project has
  shipped four "I cannot see it" bugs past a green simulation suite. The ones you
  will meet doing art work: `terrain-render`, `objects`, `decorations`, `sky`,
  `living-sky`, `lightmap`, `night_darkens_the_world`, `night-combat`,
  `fog-visible`, `fire-visible`, `bullets-visible`, `ordnance-visible`,
  `weather-visible`, `boots-visible`, `skins`, `skins-ingame`, `inventory-ui`,
  `hud-bars`, `hud-timer`, `minimap`, `crates`, `birds`, `animals`, `teleport`,
  `title`, `pixels`.
* **`client` unit suite**: `npm --prefix client test -- --run` (887 tests). The
  `-math` modules are covered here.

**A pixel check that fails after an art change is usually correct.** Several of
them sample a specific colour or a solid-pixel count. Expect to retune
thresholds, and when you do, change the *threshold*, not the assertion — a gate
that fails on a coin flip gates nothing.

### Running the game to look at it

```
make start          # server :3000 + vite; kills whole process groups on stop
make play           # headed Chrome with CDP (this box has WSLg)
make probe          # read that window's state + screenshot, without closing it
```

`?sandbox=1` opens a single-player sandbox with a loadout, a seed box and a
Regenerate button — the fastest way to look at terrain, objects and weather.
`window.__game` exposes debug hooks there (and is stripped from production
builds).

---

## 12. Things that are deliberately the way they are

Do not "fix" these without reading the linked reasoning:

* The lightmap is a **2D canvas**, not a `RenderTexture.erase`. The RenderTexture
  version did not match the radius it was asked for and did not track it —
  measured, in the header of `lightmap.ts`.
* Weapons are drawn pointing right and **flipped vertically** when aiming left.
* The sky is owned by `SkyLayer` alone. A second thing drawing sky at the same
  depth silently painted over the gradient once already.
* `parallax.ts` builds its ridge canvas and its cloud sprites **once** and only
  repositions and re-tints. Rebuilding per frame is a megapixel canvas per frame.
* `chunkBake.ts` allocates nothing per bake and never reads back from the GPU.
* Items and crates: a crate is labelled by *what it is*, not by what is inside —
  the wire does not carry the contents.
* `DEPTH.birds` is behind terrain on purpose.

---

## 13. Quick index: "I want to change…"

| …this | edit |
|---|---|
| terrain colours | `render/themes-math.ts` |
| terrain surface texture | `render/procTextures.ts` |
| the rim that makes ground read as ground | `themes-math.ts` `edge`, `chunkBake-math.ts::edgeBits` |
| what you see through a crater | `themes-math.ts` `back`, `backdrop.ts` `caveBack` |
| rocks / bushes / ruins / crystals | `../sprite_packs` + `scripts/build-object-masks.mjs` ⚠ collision |
| their size | `constants.rs::OBJECT_TARGET_PLAYER_H_*` ⚠ Rust |
| props/decorations | `assets/atlas-map.json` → `decor`, rebuild atlas |
| player bodies | `assets/skins.json` + `chars` atlas |
| where a body sits in its hitbox | `skins.json` per-skin `anchor.y` |
| hats / glasses | `render/accessoryTextures.ts` |
| tombstones | `render/tombstoneTextures.ts` |
| held weapons | `render/weaponTextures.ts` + `skins.json` `weapons[]` |
| item & weapon icons | `render/itemTextures.ts`, or add an atlas frame named after `ItemDef.sprite` |
| projectile colour / size / trail | `render/ordnance-state.ts::LOOK` |
| explosions, muzzle flash, smoke | `fx` atlas via `atlas-map.json` |
| sky, sun, moon, stars | `render/sky-math.ts` |
| clouds | `assets/atlas/clouds.png` + `render/parallax.ts` |
| rain / fog / lava / toxic | `render/weather.ts` + `weather-math.ts` |
| birds / animals | `render/birds.ts`, `render/animals.ts` (primitives) |
| teleport pads | `render/pads.ts` |
| HUD, bars, timer, banner | `ui/hud.ts`, `ui/bars.ts` |
| inventory panel | `ui/inventory.ts` + `inventory-math.ts` |
| minimap | `ui/minimap.ts` |
| menus, death screen, results | `ui/escapeMenu.ts`, `ui/deathOverlay.ts`, `ui/results.ts` |
| draw order | `render/backdrop.ts::DEPTH` |
| what loads at boot | `assets/manifest.json` |

---

## 14. Out of bounds

Do not change, unless the task genuinely cannot be done otherwise — and say so
explicitly if it cannot:

* `crates/game-server/**` — the server.
* `crates/game-core/**` — the simulation. It is pure and deterministic: no
  filesystem, no networking, no ambient randomness, seeded RNG only.
  The **only** art-adjacent things in it are the four
  `OBJECT_TARGET_PLAYER_H_*` constants and `items/registry.rs`'s `sprite` field.
* `docs/**` — the specification. If a doc is wrong, **report it**; that is a
  valued outcome here. Do not edit it.
* The network protocol. Appearance is integers; keep it that way.
* Any `-math.ts` unit test's *assertion*. Retune a pixel threshold if art moved;
  do not delete a check.
