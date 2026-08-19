# 51 — Assets

All art is CC0, fetched from Kenney, and lives under `assets/`. Nothing is copied
from outside this project folder.

---

## 1. Layout

```
assets/
├── manifest.json          what to load, and from where
├── skins.json             the skin registry (50-sprites-skins.md)
├── vendor/
│   └── kenney/
│       ├── platformer-characters/   { LICENSE.txt, Preview.png, PNG/… }
│       ├── particle-pack/
│       ├── pixel-platformer/
│       └── ui-pack/
├── atlas/                 packed atlases built from vendor art
│   ├── chars.png / chars.json
│   ├── weapons.png / weapons.json
│   ├── items.png / items.json
│   ├── fx.png / fx.json
│   └── ui.png / ui.json
└── terrain/
    ├── grassland/  { fill.png, edge.png, back.png, theme.json }
    ├── desert/
    └── frost/
```

`vendor/` keeps each pack **exactly as downloaded**, including its `LICENSE.txt`.
Anything derived goes in `atlas/` or `terrain/`. That separation makes the licence
story obvious and makes re-fetching safe.

## 2. Packs used

| Pack | Used for | Licence |
|---|---|---|
| [Platformer Characters](https://kenney.nl/assets/platformer-characters) | Player skins — the pack ships several colour variants of the same rig, which maps directly onto the skin registry's `prefix` scheme | CC0 |
| [Particle Pack](https://kenney.nl/assets/particle-pack) | Explosions, smoke, embers, rain, muzzle flashes, item glints | CC0 |
| [Pixel Platformer](https://kenney.nl/assets/pixel-platformer) | Items, crates, props, decorations, weapon silhouettes | CC0 |
| [UI Pack](https://kenney.nl/assets/ui-pack) | Inventory panel, HUD frames, buttons, scoreboard | CC0 |

CC0 means no attribution is required. We keep each pack's `LICENSE.txt` anyway, and
credit Kenney in the README, because it is the decent thing to do.

## 3. The fetch script

`scripts/fetch-assets.sh` — run once, then the results are committed.

Kenney's download URLs contain a content hash that changes when a pack is updated,
so the script must **not** hard-code them. It:

1. fetches the pack page `https://kenney.nl/assets/<slug>`;
2. extracts the first `.zip` href from the HTML;
3. downloads it to `assets/vendor/kenney/<slug>.zip`;
4. unzips into `assets/vendor/kenney/<slug>/`;
5. removes the zip;
6. verifies `LICENSE.txt` is present and fails loudly if it is not.

It is idempotent — a pack directory that already exists is skipped unless `--force`
is passed.

**If the script fails** (no network, site restructured), the failure must be clear
and the game must still run. Print the pack page URLs and tell the user to download
manually into the same paths, then continue. See §5.

## 4. Atlas building

Kenney packs ship loose PNGs. Phaser is much happier with atlases.

`scripts/build-atlas.mjs` (Node, one dev dependency: `free-tex-packer-core`) reads a
small mapping file that says which vendor PNGs go into which atlas under which
frame name, and writes `assets/atlas/*.png` + `*.json` in Phaser's JSON Hash format.

Frame names are **ours**, not Kenney's — `character_green_walk_a`, not
`PNG/Characters/character_green_walk1.png`. That indirection is what lets a pack be
swapped without touching `skins.json`.

The mapping file is hand-written and checked in. Atlases are also checked in, so a
fresh clone runs without Node asset tooling.

## 5. Procedural fallback

The game must start with **zero** downloaded assets. This is not hypothetical:
milestone 3 builds the renderer long before anyone runs the fetch script.

At boot, for anything missing:

- **Terrain textures** are generated into canvases with seeded value noise — the
  same `noise` implementation the map generator uses, exposed through WASM. A
  brown/green mottle for `grassland`, tan for `desert`, pale blue for `frost`. They
  look flat but tile correctly and are entirely adequate for development.
- **Sprites** fall back to coloured rectangles at the right dimensions: the player
  is a 16×28 box, items are 16×16 boxes tinted by kind.
- **Particles** fall back to a generated 8×8 soft dot.
- **UI** falls back to plain rectangles and the default bitmap font.

Every fallback logs once, at `warn`, naming the missing key — so it is obvious in
the console that art is missing rather than broken.

## 6. The manifest

`assets/manifest.json` lists everything to load, with type and path:

```json
{
  "atlases": [ { "key": "chars", "png": "atlas/chars.png", "json": "atlas/chars.json" } ],
  "images":  [ { "key": "crosshair", "path": "atlas/ui.png#crosshair" } ],
  "themes":  [ "grassland", "desert", "frost" ],
  "audio":   []
}
```

The `Boot` scene reads the manifest and loads what it names. Adding art is a
manifest entry, never a code change. `audio` is empty in v1 and exists so the shape
is settled.

## 7. Budget

| | Target |
|---|---|
| Total committed assets | < 12 MB |
| Per-atlas PNG | ≤ 2048×2048 |
| Terrain textures | 256×256 (`fill`, `edge`), 512×512 (`back`) |
| Initial load | < 3 MB (only the active theme's textures) |

Kenney's packs are small and the raw vendor art dominates. If the repo gets
uncomfortable, `vendor/` can move behind the fetch script and be gitignored — the
atlases are what the game actually loads.

## 8. Licensing hygiene

- Only CC0 or explicitly-public-domain art enters this repo.
- Every vendored pack keeps its `LICENSE.txt` alongside its files.
- `assets/vendor/README.md` lists each pack, its source URL, its licence and the
  date fetched.
- The project README credits Kenney.
- No asset is taken from any folder outside this project, including sibling
  directories on this machine.

## 9. Testing

- `manifest.json` and `skins.json` parse and validate against their schemas.
- Every path in the manifest exists on disk (a script, run in `check.sh`).
- Every atlas frame referenced by `skins.json` exists in that atlas's JSON.
- With `assets/atlas/` emptied, the game still boots and every fallback fires with
  exactly one warning per key.
- Every vendored pack directory contains a `LICENSE.txt`.

## 10. Future work

- Sound: Kenney's audio packs are CC0 too, and `manifest.audio` is ready.
- A sprite sheet for animated terrain edges.
- Optional high-resolution terrain textures for large displays.
- Automated pack updates in CI, with an atlas diff for review.
