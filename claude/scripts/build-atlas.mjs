#!/usr/bin/env node
/**
 * Pack vendor PNGs into Phaser JSON-Hash atlases.
 *
 * Reads `assets/atlas-map.json` (which vendor file becomes which frame name) and
 * writes `assets/atlas/<name>.png` + `<name>.json`, plus `assets/manifest.json`.
 *
 * `docs/51-assets.md` §4 nominates `free-tex-packer-core`. This uses `pngjs` and
 * a ~40-line shelf packer instead — one smaller dependency, and it lets the frame
 * names be exactly what `atlas-map.json` says rather than whatever the packer
 * derives from a path. The output format is the same Phaser JSON Hash either way.
 *
 * Atlases are committed; `assets/vendor/` is not (§A29). So this runs when the
 * art changes, not on every build, and a fresh clone needs neither Node tooling
 * nor the network.
 *
 * A missing source is reported and skipped. The atlas still builds and the frame
 * falls back to a procedural placeholder at runtime (`docs/50` §8) — the game
 * must start with no art at all, and that rule has carried this project since M3.
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')

// `pngjs` is a client devDependency, and ESM resolves from the importing file's
// location — `scripts/` has no node_modules of its own. Anchor the lookup at
// the client package rather than adding a second package.json at the repo root.
const { PNG } = createRequire(join(root, 'client/package.json'))('pngjs')
const vendor = join(root, 'assets/vendor/kenney')
const outDir = join(root, 'assets/atlas')
const PAD = 2 // transparent gutter, so bilinear filtering cannot bleed neighbours

/**
 * Per-atlas maximum source edge, in pixels.
 *
 * Kenney's particles ship at 512x512. A 20-frame fx atlas at that size is
 * 2048x4096 — over `docs/51` §7's 2048x2048 per-atlas cap, and absurd for a
 * spark drawn at 16 px on screen. Downscaling to 128 keeps them soft-edged and
 * brings the atlas to a quarter of one page.
 *
 * Characters are 80x110 and are drawn near their native size, so they are left
 * alone.
 */
const MAX_EDGE = { fx: 128 }

/** Box-filter downscale. Particles are soft blobs; nothing here needs better. */
function downscale(png, maxEdge) {
  const scale = Math.min(1, maxEdge / Math.max(png.width, png.height))
  if (scale >= 1) return png
  const w = Math.max(1, Math.round(png.width * scale))
  const h = Math.max(1, Math.round(png.height * scale))
  const out = new PNG({ width: w, height: h })
  const sx = png.width / w
  const sy = png.height / h
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let r = 0, g = 0, b = 0, a = 0, n = 0
      const x0 = Math.floor(x * sx)
      const x1 = Math.min(png.width, Math.ceil((x + 1) * sx))
      const y0 = Math.floor(y * sy)
      const y1 = Math.min(png.height, Math.ceil((y + 1) * sy))
      for (let yy = y0; yy < y1; yy++) {
        for (let xx = x0; xx < x1; xx++) {
          const i = (png.width * yy + xx) << 2
          // Premultiply, or transparent black pixels drag the colour toward
          // black at every soft edge.
          const av = png.data[i + 3] / 255
          r += png.data[i] * av
          g += png.data[i + 1] * av
          b += png.data[i + 2] * av
          a += png.data[i + 3]
          n++
        }
      }
      const o = (w * y + x) << 2
      const aa = a / n
      const un = aa > 0 ? n / (a / 255) : 0
      out.data[o] = Math.round(r * un)
      out.data[o + 1] = Math.round(g * un)
      out.data[o + 2] = Math.round(b * un)
      out.data[o + 3] = Math.round(aa)
    }
  }
  return out
}

/** Expand the `chars` shorthand (variants × poses) into flat frame → path. */
function expandChars(spec) {
  const out = {}
  for (const [variant, prefix] of Object.entries(spec._variants)) {
    for (const [pose, file] of Object.entries(spec._poses)) {
      out[`character_${variant}_${pose}`] = prefix + file
    }
  }
  return out
}

function framesOf(name, spec) {
  if (name === 'chars') return expandChars(spec)
  const out = {}
  for (const [frame, path] of Object.entries(spec)) {
    if (frame.startsWith('_')) continue
    out[frame] = path
  }
  return out
}

/**
 * Shelf packer: sort by descending height, lay rows left to right.
 *
 * Not optimal, but these are tens of sprites of similar size, where the
 * difference between shelf and a maximal-rectangles packer is a few percent of
 * a texture that is already well inside the 2048 budget (`docs/51` §7).
 */
function pack(images, maxW = 2048) {
  const sorted = [...images].sort((a, b) => b.h - a.h || b.w - a.w)
  let x = 0
  let y = 0
  let rowH = 0
  let usedW = 0
  for (const im of sorted) {
    if (x + im.w + PAD > maxW) {
      x = 0
      y += rowH + PAD
      rowH = 0
    }
    im.x = x
    im.y = y
    x += im.w + PAD
    rowH = Math.max(rowH, im.h)
    usedW = Math.max(usedW, x)
  }
  const pow2 = (n) => Math.max(2, 2 ** Math.ceil(Math.log2(Math.max(1, n))))
  return { w: pow2(usedW), h: pow2(y + rowH), images: sorted }
}

function buildAtlas(name, spec) {
  const frames = framesOf(name, spec)
  const images = []
  const missing = []
  for (const [frame, rel] of Object.entries(frames)) {
    const abs = join(vendor, rel)
    if (!existsSync(abs)) {
      missing.push(`${frame} -> ${rel}`)
      continue
    }
    let png = PNG.sync.read(readFileSync(abs))
    if (MAX_EDGE[name]) png = downscale(png, MAX_EDGE[name])
    images.push({ frame, png, w: png.width, h: png.height })
  }
  if (images.length === 0) {
    console.warn(`  ${name}: no sources found, skipping atlas`)
    return { name, frames: 0, missing }
  }

  const sheet = pack(images)
  const out = new PNG({ width: sheet.w, height: sheet.h })
  out.data.fill(0)
  for (const im of sheet.images) {
    PNG.bitblt(im.png, out, 0, 0, im.w, im.h, im.x, im.y)
  }
  mkdirSync(outDir, { recursive: true })
  writeFileSync(join(outDir, `${name}.png`), PNG.sync.write(out))

  // Phaser JSON Hash.
  const json = {
    frames: Object.fromEntries(
      sheet.images.map((im) => [
        im.frame,
        {
          frame: { x: im.x, y: im.y, w: im.w, h: im.h },
          rotated: false,
          trimmed: false,
          spriteSourceSize: { x: 0, y: 0, w: im.w, h: im.h },
          sourceSize: { w: im.w, h: im.h },
        },
      ]),
    ),
    meta: {
      app: 'scripts/build-atlas.mjs',
      version: '1.0',
      image: `${name}.png`,
      format: 'RGBA8888',
      size: { w: sheet.w, h: sheet.h },
      scale: '1',
    },
  }
  writeFileSync(join(outDir, `${name}.json`), `${JSON.stringify(json, null, 2)}\n`)
  console.log(
    `  ${name}: ${sheet.images.length} frames, ${sheet.w}x${sheet.h}` +
      (missing.length ? `, ${missing.length} missing` : ''),
  )
  return { name, frames: sheet.images.length, missing, size: [sheet.w, sheet.h] }
}

// ---------------------------------------------------------------------------

const map = JSON.parse(readFileSync(join(root, 'assets/atlas-map.json'), 'utf8'))
console.log('Building atlases from assets/vendor/kenney')

const results = []
for (const [name, spec] of Object.entries(map)) {
  if (name.startsWith('_')) continue
  results.push(buildAtlas(name, spec))
}

const allMissing = results.flatMap((r) => r.missing ?? [])
if (allMissing.length) {
  console.warn(`\n${allMissing.length} source(s) missing — those frames fall back at runtime:`)
  for (const m of allMissing.slice(0, 20)) console.warn(`  ${m}`)
}

// The manifest lists what to load (`docs/51` §6). Generated from what was
// actually written, so it cannot promise an atlas that is not on disk.
const themes = existsSync(join(root, 'assets/terrain'))
  ? readdirSync(join(root, 'assets/terrain')).filter((d) =>
      existsSync(join(root, 'assets/terrain', d, 'theme.json')),
    )
  : []
//
// **Merge, do not replace.** `build-audio.mjs` owns `manifest.audio` and this
// script owns `manifest.atlases`; the first version of this wrote the whole
// object and silently emptied the audio list every time an atlas was rebuilt.
// Two writers to one file, each assuming it owned all of it (§A24).
const manifestPath = join(root, 'assets/manifest.json')
const existing = existsSync(manifestPath)
  ? JSON.parse(readFileSync(manifestPath, 'utf8'))
  : {}
const manifest = {
  ...existing,
  atlases: results
    .filter((r) => r.frames > 0)
    .map((r) => ({ key: r.name, png: `atlas/${r.name}.png`, json: `atlas/${r.name}.json` })),
  images: existing.images ?? [],
  themes,
  audio: existing.audio ?? [],
}
writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`)
console.log(
  `\nmanifest: ${manifest.atlases.length} atlas(es), ${themes.length} theme(s), ` +
    `${manifest.audio.length} audio file(s)`,
)
