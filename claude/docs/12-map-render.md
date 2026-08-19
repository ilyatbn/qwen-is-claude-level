# 12 — Terrain rendering

The mask is one bit per pixel and carries no colour. This document is how those
bits become a map that looks like the Worms screenshots: a textured rock body with
a bright grassy rim, sitting against a parallax sky.

Client-only. Nothing here runs on the server.

---

## 1. Approach: bake chunks to canvas textures

Each 256×256 chunk gets a `Phaser.Textures.CanvasTexture` and one `Image` placed at
its world position, all inside a single container. Baking a chunk is four canvas
operations and is entirely CPU-side — no shaders, no custom pipelines, which keeps
it working identically on Canvas and WebGL renderers and keeps it debuggable.

Why chunks rather than one big texture: a 4096×2048 canvas is legal but re-drawing
it after every rocket is not. With chunks, a 42-px crater dirties one or two
chunks, and only those are re-baked.

## 2. Baking one chunk

Given the chunk's 256×256 slice of the mask:

1. **Build the alpha stencil.** Write the mask slice into a scratch `ImageData`:
   solid → `rgba(255,255,255,255)`, air → `rgba(0,0,0,0)`. `putImageData` it into a
   256×256 scratch canvas. This is the only per-pixel loop, ~65 k iterations,
   which is fast enough at the rebake budget below.
2. **Draw the fill.** On the chunk canvas, `drawImage` the theme's tiling rock
   texture, offset by the chunk's world position modulo the texture size so the
   pattern is continuous across chunk seams.
3. **Punch it out.** `globalCompositeOperation = 'destination-in'`, then draw the
   stencil. What remains is rock-textured terrain in exactly the mask's shape.
4. **Add the edge band.** See §3.

Then `texture.refresh()`.

**Seams.** Read the mask with a 1-chunk-wide margin (`-EDGE_BAND_PX` on each side,
clamped at the map border) so the edge band is computed correctly at chunk
boundaries. The margin is used for computation only; the drawn output is still
exactly 256×256.

## 3. The edge band

This is what makes terrain read as *ground* rather than as a silhouette. Worms
maps have a bright rim on every surface facing the sky.

Compute an edge stencil: a solid pixel is "edge" if any pixel within
`EDGE_BAND_PX` (5) **above or diagonally above** it is air. Only upward-facing
surfaces get the band — undersides of overhangs stay dark, which is what sells the
depth.

Cheap implementation, no distance transform needed: for each column in the chunk,
walk down and mark the first `EDGE_BAND_PX` solid pixels after each air→solid
transition. One pass, no allocation.

Draw the band by repeating steps 2–3 with the theme's `edge.png` texture and the
edge stencil, composited over the fill with `source-atop`.

## 4. Themes

A theme is three tiling textures plus a palette:

```
assets/terrain/<theme>/
    fill.png       256×256 seamless rock/soil
    edge.png       256×256 seamless grass/sand/ice crust
    back.png       512×512 seamless dark background fill for cave interiors
    theme.json     { skyTop, skyBottom, fogTint, lightTint, decorSet }
```

v1 ships three: `grassland`, `desert`, `frost`. The theme id comes from
`MapMeta.theme`, so it is seeded — the same seed always looks the same.

If a theme's textures are missing, `51-assets.md` defines a procedural fallback
(seeded value-noise tiles generated into a canvas at boot). The game must never
fail to start because art is absent.

## 5. Layer order

```
  depth  layer
  ────────────────────────────────────────────────────────────
   -30   sky gradient          fixed to camera, from theme.json
   -20   parallax backdrop     scrollFactor = PARALLAX_FACTOR
   -10   cave backdrop         back.png, scrollFactor 1, drawn where terrain is thin
     0   terrain chunks        the baked canvases
    10   decorations           props from MapMeta.decorations
    20   world items           pickups, crates
    30   players, projectiles
    40   particles             explosions, smoke, rain, embers
    50   lightmap              see 14-daynight-visibility.md
    60   HUD / UI              fixed to camera
```

## 6. Rebaking after destruction

`game-core` hands the client a list of dirty chunk ids after each applied carve.
The renderer keeps a `Set<ChunkId>` of pending rebakes and processes at most
`CHUNK_REBAKE_BUDGET` (4) per frame, nearest-to-camera first.

A meteor shower can dirty a dozen chunks in a tick; spreading the work over three
frames is invisible to the player, whereas doing it all at once is a visible hitch.

Off-screen chunks are still rebaked (they are cheap and it avoids a pop when the
camera pans), but they sort last.

## 7. Camera

Follows the local player with `CAMERA_LERP` smoothing, clamped to the map bounds.
Design resolution is `VIEWPORT_W × VIEWPORT_H` with Phaser's `Scale.FIT`, so the
same amount of world is visible on every display — important, because visible area
is a competitive advantage.

Small trauma-based screen shake on nearby explosions, scaled by distance.

## 8. Performance notes

- The per-pixel stencil loop is the only hot spot. Keep the scratch `ImageData` and
  scratch canvas allocated once and reuse them; do not allocate per bake.
- Do not use `getImageData` during a bake — it forces a readback. All mask data
  comes from WASM memory, not from the canvas.
- Read the mask from the WASM linear memory as a `Uint8Array` view. Do **not** copy
  the whole mask into JS on every frame; take a view once and re-read it.
- Target: a full 72-chunk bake at round start under 400 ms, a single-chunk rebake
  under 4 ms.

## 9. Testing

Rendering is validated by eye in the M3 sandbox scene, not by unit tests. The
sandbox provides:

- a seed input box and a regenerate button;
- a chunk-boundary overlay toggle (proves there are no seams);
- a click-to-carve tool (proves rebaking works and is fast);
- an on-screen counter for bakes/frame and ms/bake.

The pure helpers — mask-slice-to-stencil and the edge-band scan — are extracted so
they *can* be unit tested in `vitest` against small hand-written masks.

## 10. Future work

- Cached edge stencils, invalidated per chunk, if baking ever shows up in a profile.
- A WebGL shader path that samples the mask as a texture and does fill + edge in
  one draw, removing the CPU loop entirely.
- Scorch marks composited around craters, so the map records its own history.
