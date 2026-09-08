#!/usr/bin/env node
/**
 * Pack the clouds pack into a sky atlas.
 *
 *   node scripts/build-cloud-atlas.mjs           write
 *   node scripts/build-cloud-atlas.mjs --check   rebuild and diff, write nothing
 *
 * **A separate script from `build-object-masks.mjs`, on purpose.** That one
 * turns alpha into 1-bit *terrain* — thresholded, trimmed hard, stamped into the
 * mask and destructible. §D0 is explicit that clouds are not that: fill 0.40,
 * wispy at 124x58, and nothing is gained by stamping one into the ground. They
 * are sprites in the sky (§C14), so they keep their soft alpha, produce no mask,
 * and never touch `masks.bin`. Merging the two pipelines would mean one script
 * with a boolean that changes what it means.
 *
 * **Eight shape families, not three.** T16.04 says *"Three shape families exist
 * per colour (`Shape1`, `Shape2`, …)"* and that is wrong: each of
 * `Clouds_black`, `Clouds_gray` and `Clouds_white` holds `Shape1`–`Shape8` with
 * five sizes each. 3 x 8 x 5 = 120, plus 5 `Lightning`, is exactly the 125 files
 * §D0 counts — and §D0's "120 distinct objects" is the same variant-collapse it
 * caught in ruins and missed here: there are 40 distinct shapes in three
 * colours. Reading it as three would silently discard five-eighths of the
 * variety, which is the whole reason for using real sprites over the procedural
 * blobs.
 *
 * **`Lightning` is excluded.** §D0 and T16.04 both say so — it belongs with a
 * future storm effect and the weather scheduler, not the cloud layer.
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'
import { cropRgba, opaqueBounds, thresholdAlpha } from './lib/object-masks.mjs'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const { PNG } = createRequire(join(root, 'client/package.json'))('pngjs')

export const PACK_ROOT = resolve(root, '../sprite_packs/clouds')
const atlasDir = join(root, 'assets/atlas')
const PAD = 2

/** Directory name → the colour token the renderer asks for. */
export const COLOURS = { Clouds_white: 'white', Clouds_gray: 'gray', Clouds_black: 'black' }

/**
 * Trimmed at **alpha > 0**, not at `OBJECT_ALPHA_THRESHOLD`.
 *
 * A cloud is mostly soft edge — §D0 measures the pack at fill 0.40. Trimming at
 * 128 would cut the falloff off and leave every sprite with a hard rectangular
 * rim, which is the one thing a cloud must not have.
 */
const ALPHA_FLOOR = 0

/** Every cloud sprite, in a stable order. */
export function selectClouds(packRoot = PACK_ROOT) {
  const out = []
  for (const [dir, colour] of Object.entries(COLOURS)) {
    const base = join(packRoot, dir)
    if (!existsSync(base)) continue
    for (const shapeDir of readdirSync(base).sort()) {
      const m = /^Shape(\d+)$/.exec(shapeDir)
      if (!m) continue
      const shape = Number(m[1])
      for (const file of readdirSync(join(base, shapeDir)).sort()) {
        const s = /_(\d+)\.png$/.exec(file)
        if (!s) continue
        out.push({
          colour,
          shape,
          size: Number(s[1]),
          frame: `cloud_${colour}_s${shape}_${s[1]}`,
          file: join(base, shapeDir, file),
        })
      }
    }
  }
  out.sort((a, b) => (a.frame < b.frame ? -1 : a.frame > b.frame ? 1 : 0))
  return out
}

/** Shelf packer, same shape as `build-atlas.mjs`. */
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

export function build(packRoot = PACK_ROOT) {
  const sources = selectClouds(packRoot)
  const images = []
  const empty = []
  for (const s of sources) {
    const png = PNG.sync.read(readFileSync(s.file))
    const bits = thresholdAlpha(png.data, png.width, png.height, ALPHA_FLOOR)
    const box = opaqueBounds(bits, png.width, png.height)
    if (box.w === 0) {
      empty.push(s.frame)
      continue
    }
    images.push({
      frame: s.frame,
      art: cropRgba(png.data, png.width, png.height, box),
      w: box.w,
      h: box.h,
    })
  }

  const sheet = pack(images)
  const out = new PNG({ width: sheet.w, height: sheet.h })
  out.data.fill(0)
  for (const im of sheet.images) {
    const src = new PNG({ width: im.w, height: im.h })
    src.data.set(im.art)
    PNG.bitblt(src, out, 0, 0, im.w, im.h, im.x, im.y)
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
      app: 'scripts/build-cloud-atlas.mjs',
      version: '1.0',
      image: 'clouds.png',
      format: 'RGBA8888',
      size: { w: sheet.w, h: sheet.h },
      scale: '1',
    },
  }
  return { sources, empty, atlas, png: PNG.sync.write(out) }
}

/**
 * Merge by key, so this and `build-atlas.mjs` cannot delete each other (§A24).
 *
 * **`vendorPacks` is the provenance handshake.** `verify-assets.mjs` derives the
 * packs that must appear in `assets/vendor/README.md` from
 * `assets/objects/manifest.json` — which excludes clouds by design, because
 * clouds are not terrain. Without this declaration `assets/atlas/clouds.png`
 * would be committed art whose provenance nothing enforces: delete the README
 * row and no check notices. Any future script that eats a sprite pack declares
 * it here too.
 *
 * Merged **by value** and sorted, for the same reason `atlases` is merged by
 * key: another build script writing this file must not drop the entry, and a
 * re-run of this one must not duplicate it.
 */
function mergeManifest(existing) {
  const atlases = (existing.atlases ?? []).filter((a) => a.key !== 'clouds')
  atlases.push({ key: 'clouds', png: 'atlas/clouds.png', json: 'atlas/clouds.json' })
  const vendorPacks = [...new Set([...(existing.vendorPacks ?? []), 'clouds'])].sort()
  return { ...existing, atlases, vendorPacks }
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)
if (isMain) {
  const check = process.argv.includes('--check')
  if (!existsSync(PACK_ROOT)) {
    console.warn(`sources missing at ${PACK_ROOT} — nothing to build`)
    process.exit(0)
  }
  const built = build()
  const byColour = new Map()
  for (const s of built.sources) byColour.set(s.colour, (byColour.get(s.colour) ?? 0) + 1)
  const shapes = new Set(built.sources.map((s) => s.shape))

  console.log(`${built.sources.length} cloud sprites, ${shapes.size} shape families`)
  for (const [colour, n] of [...byColour].sort()) console.log(`  ${colour.padEnd(6)} ${n}`)
  console.log(`  atlas  ${built.atlas.meta.size.w}x${built.atlas.meta.size.h}`)
  if (built.empty.length) {
    console.error(`${built.empty.length} sprite(s) are fully transparent:`)
    for (const f of built.empty) console.error(`  ${f}`)
    process.exit(1)
  }

  const json = `${JSON.stringify(built.atlas, null, 2)}\n`
  const targets = [
    [join(atlasDir, 'clouds.png'), built.png],
    [join(atlasDir, 'clouds.json'), Buffer.from(json)],
  ]
  if (check) {
    const stale = targets.filter(
      ([p, bytes]) => !existsSync(p) || !Buffer.from(bytes).equals(readFileSync(p)),
    )
    if (stale.length) {
      console.error(`\n${stale.length} output(s) do not match the sources — run without --check`)
      process.exit(1)
    }
    console.log('\noutputs match the sources')
  } else {
    mkdirSync(atlasDir, { recursive: true })
    for (const [p, bytes] of targets) writeFileSync(p, bytes)
    const manifestPath = join(root, 'assets/manifest.json')
    const existing = existsSync(manifestPath) ? JSON.parse(readFileSync(manifestPath, 'utf8')) : {}
    writeFileSync(manifestPath, `${JSON.stringify(mergeManifest(existing), null, 2)}\n`)
    console.log(`\nwrote ${targets.length} file(s)`)
  }
}
