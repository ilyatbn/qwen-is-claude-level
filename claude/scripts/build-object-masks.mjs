#!/usr/bin/env node
/**
 * Turn the sprite packs into destructible terrain.
 *
 * Reads the selected PNGs, thresholds their alpha into 1-bit masks, trims each to
 * its opaque bounding box, and writes:
 *
 *   assets/objects/masks.bin      packed 1-bit masks, row-major, one blob
 *   assets/objects/manifest.json  id, key, pack, category, w, h, anchor, offset
 *   assets/atlas/objects.png      the art, packed
 *   assets/atlas/objects.json     Phaser JSON Hash for it
 *
 * `game-core` embeds `masks.bin` with `include_bytes!`, so the crate stays pure —
 * no `std::fs` (`CLAUDE.md`). The client loads the atlas normally and falls back
 * to a placeholder if it is missing (`docs/50` §8).
 *
 * `docs/73-amendments-v5.md` §D0/§D2/§D4.
 *
 *   node scripts/build-object-masks.mjs           write
 *   node scripts/build-object-masks.mjs --check   rebuild and diff, write nothing
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync, statSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'
import { constants } from './lib/rust-constants.mjs'
import {
  assertIdsMatchPosition,
  crop,
  packFactor,
  cropRgba,
  decodeMasksBin,
  encodeMasksBin,
  opaqueBounds,
  packBits,
  popcount,
  scaleFor,
  scaleNearest,
  scaleRgbaNearest,
  thresholdAlpha,
} from './lib/object-masks.mjs'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')

// `pngjs` is a client devDependency and ESM resolves from the importing file, so
// anchor the lookup at the client package — the same reason `build-atlas.mjs`
// does it, and the same fix.
const { PNG } = createRequire(join(root, 'client/package.json'))('pngjs')

export const PACK_ROOT = resolve(root, '../sprite_packs')
const objectsDir = join(root, 'assets/objects')
const atlasDir = join(root, 'assets/atlas')
const PAD = 2 // transparent gutter, so filtering cannot bleed a neighbour in

/**
 * Which files become objects, and what category each is.
 *
 * **`clouds` is not here.** Fill 0.40 and wispy at 124x58 — they are clouds, and
 * nothing is gained by stamping one into the terrain. They route to the sky layer
 * (§D0, T16.04).
 *
 * **`ruins` is 40 objects, not 164.** `Assets`, `Assets_shadow`,
 * `Assets_texture_shadow` and `Assets_texture_shadow_dark` hold identical
 * basenames — four render variants of the same 40 assets — and four
 * `Assets*_source.png` contact sheets sit at the top level at 488x431. So: one
 * variant directory, named explicitly. Deduplicating by basename instead would
 * keep 44, because the contact sheets have no duplicate to lose to. `Assets` is
 * the variant with soft 0.00; `Assets_shadow` measures soft 0.24 and thresholds
 * badly.
 */
export const PACKS = [
  { pack: 'bushes', category: 'bush', include: () => true },
  { pack: 'crystals', category: 'crystal', include: () => true },
  { pack: 'rocks', category: 'rock', include: () => true },
  { pack: 'ruins', category: 'ruin', include: (rel) => rel.startsWith('Assets/') },
]

const walk = (dir) =>
  readdirSync(dir).flatMap((name) => {
    const path = join(dir, name)
    if (statSync(path).isDirectory()) return walk(path)
    return path.endsWith('.png') ? [path] : []
  })

/** Every selected source, in a stable order — array position becomes the id. */
export function selectSources(packRoot = PACK_ROOT) {
  const out = []
  for (const { pack, category, include } of PACKS) {
    const dir = join(packRoot, pack)
    if (!existsSync(dir)) continue
    for (const file of walk(dir)) {
      const rel = relative(dir, file).split('\\').join('/')
      if (!include(rel)) continue
      out.push({
        key: `${pack}_${rel.replace(/\.png$/, '').split('/').join('_')}`,
        pack,
        category,
        rel,
        file,
      })
    }
  }
  out.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0))
  return out
}

/**
 * Where a category's target height comes from.
 *
 * The four multipliers in `constants.rs` are the **only** place a size lives
 * (§D4). Everything else — the factor, every mask extent, the atlas — is derived
 * from them at build time, so adjusting one and rerunning is the whole edit.
 */
export const TARGET_CONSTANT = {
  bush: 'OBJECT_TARGET_PLAYER_H_BUSH',
  rock: 'OBJECT_TARGET_PLAYER_H_ROCK',
  crystal: 'OBJECT_TARGET_PLAYER_H_CRYSTAL',
  ruin: 'OBJECT_TARGET_PLAYER_H_RUIN',
}

/** A category's target height in pixels, read from `constants.rs`. */
export function targetHeightPx(category, table = constants()) {
  const name = TARGET_CONSTANT[category]
  if (!name) throw new Error(`no target height is defined for category \`${category}\``)
  return table.get('PLAYER_H') * table.get(name)
}

/** Threshold and measure, without building anything. Pass one of two. */
export function measureBounds(rgba, w, h, threshold) {
  return opaqueBounds(thresholdAlpha(rgba, w, h, threshold), w, h)
}

/**
 * One factor per category, from the heights of the sprites actually selected.
 *
 * Empty sprites are left out of the mean — they contribute no object, and
 * averaging a zero in would drag every factor in the category up.
 */
export function packFactors(measured, table = constants()) {
  const heights = new Map()
  for (const m of measured) {
    if (m.bounds.h === 0) continue
    if (!heights.has(m.category)) heights.set(m.category, [])
    heights.get(m.category).push(m.bounds.h)
  }
  const factors = new Map()
  for (const [category, hs] of heights) {
    factors.set(category, packFactor(targetHeightPx(category, table), hs))
  }
  return factors
}

/**
 * One source PNG to one mask entry.
 *
 * Threshold, trim, scale by the **category's** factor applied to this sprite's
 * own bounds, pack.
 */
export function buildEntry(source, rgba, w, h, threshold, factor) {
  const bits = thresholdAlpha(rgba, w, h, threshold)
  const bounds = opaqueBounds(bits, w, h)
  if (bounds.w === 0) {
    return { ...source, empty: true, w: 0, h: 0, anchorX: 0, anchorY: 0, packed: new Uint8Array(0) }
  }
  const trimmed = crop(bits, w, h, bounds)
  const trimmedRgba = cropRgba(rgba, w, h, bounds)
  const size = scaleFor(factor, bounds)
  const scaled =
    size.w === bounds.w && size.h === bounds.h
      ? trimmed
      : scaleNearest(trimmed, bounds.w, bounds.h, size.w, size.h)
  const art =
    size.w === bounds.w && size.h === bounds.h
      ? trimmedRgba
      : scaleRgbaNearest(trimmedRgba, bounds.w, bounds.h, size.w, size.h)
  return {
    ...source,
    empty: false,
    bounds,
    w: size.w,
    h: size.h,
    // Bottom centre: the anchor is the ground line the object sits *on*, which is
    // how `docs/50` §6 already places decorations.
    anchorX: size.w >> 1,
    anchorY: size.h,
    packed: packBits(scaled, size.w, size.h),
    art,
  }
}

/** Shelf packer, sorted by descending height. Same shape as `build-atlas.mjs`. */
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

/** The whole pipeline, in memory. Callers write it or diff it. */
export function build(packRoot = PACK_ROOT) {
  const table = constants()
  const threshold = table.get('OBJECT_ALPHA_THRESHOLD')
  const sources = selectSources(packRoot)

  // Pass one: measure. The factor is a property of the whole category, so no
  // sprite can be scaled until every sprite in its pack has been looked at.
  // Bounds only — holding 160 decoded canvases to save a re-read would cost
  // more memory than the second read costs time.
  const measured = sources.map((source) => {
    const png = PNG.sync.read(readFileSync(source.file))
    return { ...source, bounds: measureBounds(png.data, png.width, png.height, threshold) }
  })
  const factors = packFactors(measured, table)

  // Pass two: scale and pack.
  const entries = []
  const empty = []
  for (const source of sources) {
    const factor = factors.get(source.category)
    if (!factor) throw new Error(`no factor for category \`${source.category}\``)
    const png = PNG.sync.read(readFileSync(source.file))
    const entry = buildEntry(source, png.data, png.width, png.height, threshold, factor)
    if (entry.empty) {
      empty.push(source.rel)
      continue
    }
    entry.id = entries.length
    entries.push(entry)
  }
  assertIdsMatchPosition(entries)

  const masks = encodeMasksBin(entries)
  const records = decodeMasksBin(masks)
  const manifest = {
    // The client reads this; `game-core` reads `masks.bin`. Both must agree, and
    // the suite asserts that rather than assuming it.
    meta: {
      app: 'scripts/build-object-masks.mjs',
      version: 1,
      masks: 'objects/masks.bin',
      // Derived, never authored: `OBJECT_TARGET_PLAYER_H_*` in `constants.rs` is
      // the only place a size lives. Recorded so a human can see what the
      // multipliers came out as without rerunning the build.
      factors: Object.fromEntries(
        [...factors].sort().map(([category, f]) => [category, { num: f.num, den: f.den }]),
      ),
    },
    objects: entries.map((e, i) => ({
      id: e.id,
      key: e.key,
      pack: e.pack,
      category: e.category,
      source: e.rel,
      w: e.w,
      h: e.h,
      anchor: { x: e.anchorX, y: e.anchorY },
      offset: records[i].offset,
      bytes: records[i].len,
      // No `flip` column. §D4's "store it as a flag, do not bake two masks" is
      // about the *placement* — which of two silhouettes this instance uses — and
      // that is T16.02's to record. A column that reads `true` on all 160 rows
      // carries no information and would not say whether it meant "may be
      // flipped" or "is flipped".
    })),
  }

  // **Frames are named by id, not by key.** `map_init` carries the id and
  // nothing else — a renderer holding an id and a key-named atlas would need
  // `objects/manifest.json` fetched and parsed before it could draw anything,
  // which is a second failure path in front of the art. The key stays in the
  // manifest for humans; §B16's position-is-the-id rule is what makes this safe.
  const sheet = pack(
    entries.map((e) => ({ frame: `obj_${e.id}`, art: e.art, w: e.w, h: e.h })),
  )
  const png = new PNG({ width: sheet.w, height: sheet.h })
  png.data.fill(0)
  for (const im of sheet.images) {
    const src = new PNG({ width: im.w, height: im.h })
    src.data.set(im.art)
    PNG.bitblt(src, png, 0, 0, im.w, im.h, im.x, im.y)
  }
  const atlas = {
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
      app: 'scripts/build-object-masks.mjs',
      version: '1.0',
      image: 'objects.png',
      format: 'RGBA8888',
      size: { w: sheet.w, h: sheet.h },
      scale: '1',
    },
  }

  return { sources, measured, factors, entries, empty, masks, manifest, atlas, atlasPng: PNG.sync.write(png) }
}

/**
 * Add `objects` to the atlas list without dropping anyone else's.
 *
 * `build-atlas.mjs` learned this the hard way (§A24): two writers to one file,
 * each assuming it owned all of it, and the audio list vanished on every atlas
 * rebuild. Merge by key.
 */
function mergeManifest(existing) {
  const atlases = (existing.atlases ?? []).filter((a) => a.key !== 'objects')
  atlases.push({ key: 'objects', png: 'atlas/objects.png', json: 'atlas/objects.json' })
  return { ...existing, atlases }
}

// ---------------------------------------------------------------------------

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)
if (isMain) {
  const check = process.argv.includes('--check')

  if (!existsSync(PACK_ROOT)) {
    // The packs are an input, not a checkout. Without them there is nothing to
    // rebuild — so verify what is committed instead of passing on an empty run.
    console.warn(`sources missing at ${PACK_ROOT} — verifying the committed table instead`)
    const masks = new Uint8Array(readFileSync(join(objectsDir, 'masks.bin')))
    const manifest = JSON.parse(readFileSync(join(objectsDir, 'manifest.json'), 'utf8'))
    const records = decodeMasksBin(masks)
    assertIdsMatchPosition(manifest.objects)
    if (records.length !== manifest.objects.length) {
      console.error(`masks.bin has ${records.length} masks, manifest.json has ${manifest.objects.length}`)
      process.exit(1)
    }
    console.log(`${records.length} objects, table self-consistent`)
    process.exit(0)
  }

  const built = build()
  const counts = new Map()
  for (const e of built.entries) counts.set(e.category, (counts.get(e.category) ?? 0) + 1)

  console.log(`${built.sources.length} sources selected, ${built.entries.length} masks`)
  for (const [category, n] of [...counts].sort()) {
    const f = built.factors.get(category)
    const mean = built.measured.filter((m) => m.category === category && m.bounds.h > 0)
    const meanH = mean.reduce((s, m) => s + m.bounds.h, 0) / mean.length
    console.log(
      `  ${category.padEnd(8)} ${String(n).padStart(3)}  mean h ${meanH.toFixed(1)}px  ` +
        `x${(f.num / f.den).toFixed(3)} (${f.num}/${f.den})`,
    )
  }
  console.log(`  atlas    ${built.atlas.meta.size.w}x${built.atlas.meta.size.h}`)
  if (built.empty.length) {
    console.error(`${built.empty.length} source(s) thresholded to nothing:`)
    for (const rel of built.empty) console.error(`  ${rel}`)
    process.exit(1)
  }

  const manifestJson = `${JSON.stringify(built.manifest, null, 2)}\n`
  const atlasJson = `${JSON.stringify(built.atlas, null, 2)}\n`
  const targets = [
    [join(objectsDir, 'masks.bin'), built.masks],
    [join(objectsDir, 'manifest.json'), Buffer.from(manifestJson)],
    [join(atlasDir, 'objects.png'), built.atlasPng],
    [join(atlasDir, 'objects.json'), Buffer.from(atlasJson)],
  ]

  if (check) {
    const stale = targets.filter(([path, bytes]) => {
      if (!existsSync(path)) return true
      return !Buffer.from(bytes).equals(readFileSync(path))
    })
    if (stale.length) {
      console.error(`\n${stale.length} output(s) do not match the sources — run without --check:`)
      for (const [path] of stale) console.error(`  ${relative(root, path)}`)
      process.exit(1)
    }
    console.log('\noutputs match the sources')
  } else {
    mkdirSync(objectsDir, { recursive: true })
    mkdirSync(atlasDir, { recursive: true })
    for (const [path, bytes] of targets) writeFileSync(path, bytes)
    const manifestPath = join(root, 'assets/manifest.json')
    const existing = existsSync(manifestPath) ? JSON.parse(readFileSync(manifestPath, 'utf8')) : {}
    writeFileSync(manifestPath, `${JSON.stringify(mergeManifest(existing), null, 2)}\n`)
    console.log(`\nwrote ${targets.length} file(s), ${built.masks.length} bytes of mask`)
    console.log(`total set bits: ${built.entries.reduce((n, e) => n + popcount(e.packed), 0)}`)
  }
}
