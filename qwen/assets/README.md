# assets/

`processed/` is what the game loads; `client/src/assets/manifest.json` is the registry
that maps texture keys to files in here (docs/07 §1, §2).

**This tree ships empty.** The three pack URLs in docs/07 §3 all return 404 —
see `DEVIATIONS.md` D11. The game boots and plays with zero assets present: BootScene
registers a canvas placeholder for every texture key before requesting a single file, so
a missing file leaves its placeholder standing (docs/07 §2).

To add real art, drop files in at the paths the manifest already names and reload — no
code change, which is the property docs/07 promises:

```
assets/processed/tiles/grass_1.png     -> texture key GRASS_1
assets/processed/players/player_1.png  -> texture key player_0   (0-based, matches `skin: u8`)
assets/processed/weapons/pistol.png    -> texture key weapon_pistol
assets/processed/items/medkit.png      -> texture key item_medkit
```

For a sprite sheet rather than individual files, use the frame form from docs/07 §3 —
`{ "file": "processed/players/sheet.png", "frame": [x, y, w, h] }` — and the loader cuts
the region out into its own texture.

Vite serves this directory (`publicDir: '../assets'` in `client/vite.config.ts`), so
`processed/tiles/grass_1.png` in the manifest resolves to `/processed/tiles/grass_1.png`
in the browser.
