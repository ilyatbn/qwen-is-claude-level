# 07 — Sprites & assets

Placeholder-first: all code renders colored shapes until T5.1. After that,
assets swap in via a manifest — no rendering code changes.

## 1. Asset folder structure

```
assets/
  kenney/                  # raw downloads (never edited)
    tiny-dungeon/          # terrain textures (3 variants)
    pixel-adventure-1/     # player skins, items
    input-control-pack/    # UI (buttons, panels) — optional
  processed/               # what the game actually loads
    tiles/                 # grass_1.png dirt_1.png stone_1.png rock_1.png ...
                           #   (variants: _1 _2 _3, 16x16)
    players/               # player_1.png ... player_6.png (32x32)
    weapons/               # pistol.png shotgun.png rocket.png grenade.png
    items/                 # medkit.png overcharge.png shield.png flashlight.png
    decor/                 # bush.png rock.png flower.png
    ui/                    # hud_bar.png panel.png button.png
  manifest.json            # THE registry (below)
```

## 2. manifest.json format

```json
{
  "version": 1,
  "tiles": {
    "GRASS":  ["processed/tiles/grass_1.png", "processed/tiles/grass_2.png", "processed/tiles/grass_3.png"],
    "DIRT":   ["processed/tiles/dirt_1.png",  "processed/tiles/dirt_2.png",  "processed/tiles/dirt_3.png"],
    "STONE":  ["processed/tiles/stone_1.png", "processed/tiles/stone_2.png", "processed/tiles/stone_3.png"],
    "ROCK":   ["processed/tiles/rock_1.png",  "processed/tiles/rock_2.png",  "processed/tiles/rock_3.png"]
  },
  "players":  ["processed/players/player_1.png", "..."],
  "weapons":  { "pistol": "processed/weapons/pistol.png", "...": "..." },
  "items":    { "medkit": "processed/items/medkit.png", "...": "..." },
  "decor":    { "bush": "processed/decor/bush.png", "rock": "...", "flower": "..." },
  "ui":       { "panel": "processed/ui/panel.png", "button": "..." }
}
```

Rules:
- BootScene loads manifest.json, then every referenced file.
- **Variant selection**: tile texture index = `(seed + tile_x + tile_y) % 3`
  → looks different per round, deterministic, no extra protocol data.
- If a manifest entry is missing, BootScene falls back to the placeholder
  shape (so the game never breaks on a missing asset).
- Placeholder mode: manifest lists `"placeholder": true` per section;
  BootScene registers canvas-generated textures (colored 16×16 rects etc.)
  under the same keys. Rendering code always uses texture keys, never
  raw file paths.

## 3. Kenney packs to fetch (T5.1)

All CC0, from kenney.nl (direct .zip URLs, no login):

| Pack | URL | Used for |
|---|---|---|
| Tiny Dungeon | https://kenney.nl/media/pages/packs/tiny-dungeon.zip | tile textures (3 variants each) |
| Pixel Adventure 1 | https://kenney.nl/media/pages/packs/pixel-adventure-1.zip | player skins, item icons |
| Input Pack (optional) | https://kenney.nl/media/pages/packs/input-pack.zip | UI panels/buttons |

- Download with `curl -L -o assets/kenney/<name>.zip <url>`, unzip into
  `assets/kenney/<name>/`, then copy/trim needed sprites into
  `assets/processed/` (trim with a small Node script or `magick` if
  available; otherwise copy whole sheets and record frame rects in
  manifest as `{ "file": "...", "frame": [x, y, w, h] }` — the loader
  supports both plain paths and frame objects).
- LICENSE.txt from each pack copied to `assets/kenney/<name>/LICENSE.txt`.

## 4. Skin system (player + weapon skins)

- **Player skins**: 6 skins (player_1..6). Lobby: click to cycle, or pick
  from a 6-slot picker. Chosen skin stored in `localStorage["skin"]` and
  sent via `select_skin`. Server stores skin per player id (in-memory).
- **Weapon skins** (v1 minimal): 1 alternate texture per weapon
  (e.g. `pistol.png` vs `pistol_alt.png`); selection in lobby, same
  localStorage pattern. Weapon skin is cosmetic only (no protocol change
  beyond the existing `skin` for players; weapon skin id sent in lobby
  state as `weapon_skin: u8`).
- **Map texture variants**: the 3 variants per tile kind (§2) — different
  look each round via seed, zero protocol cost.
- Adding a new skin later = add file + manifest entry + (for players) one
  more entry in the `players` array. No code change.

## 5. Rendering notes (placeholder shapes, pre-T5.1)

| Thing | Placeholder |
|---|---|
| Tiles | colored 16×16 rects: GRASS #4a8f3c, DIRT #7a5230, STONE #6b6b6b, ROCK #8a7f6a |
| Player | 24×28 rect, color per player id (6 fixed colors) |
| Weapon | 10×4 rect at aim angle from player center |
| Projectile | 6×6 circle (rocket: 8×8) |
| Items | 12×12 circle, color per item kind |
| Crosshair | circle r=60 (faint) + cross at aim point |
| Night/fog | black overlay alpha up to 0.85, circular hole = FOV |
| Toxic spot | green circle alpha 0.3 |
| Lava fire | orange rect flicker |
