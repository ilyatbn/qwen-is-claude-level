# 50 — Sprites and skins

Every visual identity in the game — the player, their weapon, the terrain, the
props — resolves through a registry rather than through hard-coded texture keys.
Changing how something looks is a JSON edit, not a code change.

Client-only, except for one `u16` on the wire.

---

## 1. What the server knows

Exactly one thing: `skin_id: u16` per player, sent in `join` and echoed in
`welcome`, `player_join` and the scoreboard.

The server does not validate it against a list, does not know what any id looks
like, and never sends texture names. Adding a skin is a client-side asset change
plus a registry entry — no server deploy.

Weapon skins are not on the wire at all. Everyone sees the weapon's *default* skin
on other players; your own weapon skin is a personal cosmetic. This keeps the
protocol from growing a cosmetics dependency, and it is how most games start.

## 2. The skin registry

`assets/skins.json`, loaded at boot and validated against a TypeScript type.

```json
{
  "version": 1,
  "players": [
    {
      "id": 0,
      "name": "Recruit",
      "atlas": "chars_kenney",
      "prefix": "character_green_",
      "frames": {
        "idle":    ["idle"],
        "walk":    ["walk_a", "walk_b", "walk_c", "walk_d"],
        "jump":    ["jump"],
        "fall":    ["fall"],
        "jetpack": ["jetpack_a", "jetpack_b"],
        "hurt":    ["hurt"],
        "dead":    ["dead"]
      },
      "anchor": { "x": 0.5, "y": 0.9 },
      "tint": null
    }
  ],
  "weapons": [
    { "id": 0, "weaponKey": "bazooka", "atlas": "weapons", "frame": "bazooka_default",
      "muzzle": { "x": 22, "y": -2 }, "pivot": { "x": 0.15, "y": 0.5 } }
  ]
}
```

Resolution is `atlas` + `prefix` + frame name, so one atlas can hold many skins that
differ only by a colour prefix — which is exactly how the Kenney character pack is
organised (`character_green_*`, `character_purple_*`, …). Five colour variants cost
five registry entries and zero new art.

`tint` allows a further cheap recolour on top, for team colours later.

## 3. Player rendering

A player is three sprites in a container:

```
  container (at body centre)
    ├── body     ← animation state, flipped by facing
    ├── weapon   ← rotated to the aim angle, drawn behind or in front by facing
    └── overlays ← shield bubble, flashlight glow, i-frame flash, name label
```

**Animation state** is derived from the snapshot flags and velocity, not sent:

| State | Condition |
|---|---|
| `dead` | `!alive` |
| `jetpack` | `jetpack_active` |
| `jump` | `!grounded && vy < 0` |
| `fall` | `!grounded && vy >= 0` |
| `walk` | `grounded && |vx| > 10` |
| `idle` | otherwise |

Walk animation speed scales with `|vx|`, so a slowed player visibly trudges.

**Facing** comes from the aim angle, not from velocity (`22-aiming-crosshair.md`
§4). Walking right while shooting left must look right — the body flips with aim
and the legs keep their walk cycle.

`anchor.y` of 0.9 places the sprite's feet at the bottom of the 16×28 AABB. Art is
usually taller than the hitbox; the anchor is where that gets reconciled, and it is
per-skin because different art has different proportions.

## 4. Weapon rendering

The weapon sprite is rotated to the aim angle around its `pivot` and positioned at a
fixed offset from the body centre. `muzzle` is where the client draws the flash and
where the trajectory preview starts — it is cosmetic, and does **not** have to match
the server's `MUZZLE_OFFSET` (`31-weapons-combat.md` §2). Keeping them independent
means art can be adjusted without touching gameplay.

When the aim angle points left, the weapon sprite is flipped vertically (not
horizontally) so it does not appear upside down — the standard trick for
side-view aimed weapons.

## 5. Terrain themes

Terrain is procedural, so it takes textures rather than sprites
(`12-map-render.md` §4):

```
assets/terrain/<theme>/
    fill.png   256×256 seamless    rock / soil body
    edge.png   256×256 seamless    grass / sand / ice crust
    back.png   512×512 seamless    dark cave backdrop
    theme.json { skyTop, skyBottom, fogTint, lightTint, decorSet }
```

v1 themes: `grassland`, `desert`, `frost`. The theme is chosen from the map seed, so
a seed always looks the same — which matters for bug reports with screenshots.

Adding a fourth theme is: drop in three PNGs, add a folder, add the id to the theme
list. No code.

## 6. Decorations

`MapMeta.decorations` places props on the surface at generation time (rocks, tufts,
bones, crystals). Each carries a `kind`, a position and flags (flip, scale tier).

The client maps `kind` → a frame in the theme's `decorSet`. A theme with no entry
for a kind simply skips it, so decoration kinds and themes can evolve
independently.

Decorations are purely cosmetic: no collision, no gameplay effect, and a client may
skip them entirely on a low-end device.

## 7. Atlases and loading

- All sprites go into texture atlases (`.png` + `.json`), loaded in a `Boot` scene
  before anything else runs.
- One atlas per category: `chars`, `weapons`, `items`, `fx`, `ui`.
- Terrain textures load separately, and only the active theme's three files are
  loaded for a round.
- A loading bar reports progress; the game does not start until the atlas for the
  local player's skin is resolved.

## 8. Missing-asset behaviour

The game **must** start with no art at all. Every lookup falls back:

- missing frame → a magenta 16×16 placeholder, logged once per key;
- missing skin id → skin 0;
- missing terrain theme → the procedural fallback in `51-assets.md` §5.

This is not defensive padding — during M3 the sandbox runs long before any art
exists, and a hard failure on a missing texture would block development.

## 9. Testing

`vitest`, on pure logic only:

- `skins.json` validates against the schema; every `id` is unique; every referenced
  atlas key is in the atlas manifest.
- Animation state derivation returns the right state for a table of
  `(alive, grounded, vy, vx, jetpack)` combinations.
- Facing flips at exactly ±π/2 of aim.
- An unknown skin id resolves to skin 0 without throwing.
- An unknown frame key returns the placeholder and logs exactly once.
- Weapon rotation and flip are correct in all four quadrants.

## 10. Future work

- Weapon skins on the wire, once there is a reason for others to see them.
- Per-player tint for team modes.
- Skin selection UI in the lobby, persisted in `localStorage`.
- Animated terrain edges (waving grass) as a shader on the edge band.
- Death ragdolls instead of a `dead` frame.
