#!/usr/bin/env node
/**
 * Turn the coordinator's gate art into the teleport pad's sprite (T21.12).
 *
 *   tasks/M21/assets/gate.png   the source, committed, 545x602, fully opaque
 *          |                    background removal + downscale
 *          v
 *   assets/images/gate.png      committed, registered in assets/manifest.json
 *
 * **A script, not a hand-edited PNG.** Every other derived asset here is
 * generated from a committed source by a committed script — `build-atlas.mjs`,
 * `build-object-masks.mjs` — and a hand-edited binary
 * is the one thing nobody can review or redo.
 *
 *   node scripts/build-gate-sprite.mjs           write
 *   node scripts/build-gate-sprite.mjs --check   rebuild and diff, write nothing
 *
 * The size comes from `PAD_W`, so the gate tracks the pad it stands on rather
 * than a literal somebody has to remember to change.
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'
import { constants } from './lib/rust-constants.mjs'
import {
  alphaStats,
  cutBackdrop,
  downscaleRgba,
  portalLooksLikeARing,
} from './lib/gate-sprite.mjs'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
// `pngjs` is a client devDependency and ESM resolves from the importing file —
// the same anchoring `build-atlas.mjs` and `build-object-masks.mjs` both need.
const { PNG } = createRequire(join(root, 'client/package.json'))('pngjs')

const SOURCE = join(root, 'tasks/M21/assets/gate.png')
const OUT_DIR = join(root, 'assets/images')
const OUT = join(OUT_DIR, 'gate.png')
const MANIFEST = join(root, 'assets/manifest.json')
export const IMAGE_KEY = 'gate'
export const IMAGE_PATH = 'images/gate.png'

/**
 * How wide the gate is built: `PAD_ART_W` (T21.28), from `constants.rs`.
 *
 * It was `PAD_W × 1.6` here — 64, a number only this script knew, while the map
 * generator knew only the 40 px pad and so seated gates whose stone base hung in
 * the air. The arch still has to be something a 16 px player walks *into*: at 64
 * the hole is about 40x44 world px against a 16x28 body. Now the generator, this
 * build and `pads.ts` read the one constant.
 */

export function targetSize(srcW, srcH, table = constants()) {
  // Through the parsed `constants.rs`, never a literal — `rust-constants.mjs`
  // exists precisely so a build step cannot carry its own copy of a tunable.
  // `constants()` returns a table with `.get`, which **throws** on an unknown
  // name — deliberately, per its own docs: a reader that answered `undefined`
  // would turn every assertion pinned to it into `undefined <= undefined`,
  // false forever and green forever.
  const w = Math.max(8, Math.round(table.get('PAD_ART_W')))
  const h = Math.max(8, Math.round((w * srcH) / srcW))
  return { w, h }
}

export function buildGateSprite(sourceBytes) {
  const src = PNG.sync.read(sourceBytes)
  const rgba = Uint8Array.from(src.data)
  const cut = cutBackdrop(rgba, src.width, src.height)
  const { w, h } = targetSize(src.width, src.height)
  const small = downscaleRgba(rgba, src.width, src.height, w, h)
  const png = new PNG({ width: w, height: h })
  png.data = Buffer.from(small)
  return { png, bytes: PNG.sync.write(png), cut, w, h, stats: alphaStats(small) }
}

function main() {
  const check = process.argv.includes('--check')
  if (!existsSync(SOURCE)) {
    console.error(`gate: no source at ${SOURCE}`)
    process.exit(1)
  }
  const built = buildGateSprite(readFileSync(SOURCE))

  // **Report the counts, and fail on a fill that did nothing.** A flood fill
  // that matched no pixels and one that worked are otherwise the same silent
  // success, and the failure would ship as a white box standing on the ground.
  console.log(
    `gate: ${built.w}x${built.h}  background ${built.cut.outside} px, ` +
      `portal ${built.cut.interior} px ${JSON.stringify(built.cut.portal)}  ->  clear ${built.stats.clear}, ` +
      `opaque ${built.stats.opaque}, partial ${built.stats.partial}`,
  )
  if (built.cut.outside === 0) {
    console.error('gate: the background fill cleared nothing — the source changed shape')
    process.exit(1)
  }
  if (built.cut.interior === 0) {
    console.error('gate: the portal fill cleared nothing — the ring is not where it was')
    process.exit(1)
  }
  // **The interior seed is the image centre, which is an assumption about this
  // art.** If a future source put stone there, the fill would find some other
  // enclosed white and `interior > 0` above would still pass while `portal`
  // became that region's bbox. The staleness test cannot notice — it re-derives
  // with this same code against a file this same code wrote — so the shape is
  // checked here, at the source. `portalLooksLikeARing` is a pure function in
  // the lib precisely so it can be exercised by a test; inline, it was
  // unreachable on the shipped art.
  const shape = portalLooksLikeARing(built.cut.portal)
  if (!shape.ok) {
    console.error(`gate: the portal fill found a region that is ${shape.why}`)
    process.exit(1)
  }

  if (check) {
    const current = existsSync(OUT) ? readFileSync(OUT) : Buffer.alloc(0)
    if (!current.equals(built.bytes)) {
      console.error('gate: assets/images/gate.png is stale — rerun without --check')
      process.exit(1)
    }
    console.log('gate: up to date')
    return
  }

  mkdirSync(OUT_DIR, { recursive: true })
  writeFileSync(OUT, built.bytes)

  // **Merge, do not replace** — the same rule `build-atlas.mjs` learnt when it
  // emptied the audio list: this script owns one `images` entry and nothing else
  // in the manifest.
  const manifest = existsSync(MANIFEST) ? JSON.parse(readFileSync(MANIFEST, 'utf8')) : {}
  const images = (manifest.images ?? []).filter((i) => i.key !== IMAGE_KEY)
  // The portal's geometry rides with the image, derived from the flood fill
  // rather than measured by eye — see `cutBackdrop`. `verify-assets.mjs` reads
  // only `path`, so the extra field is inert to it.
  images.push({ key: IMAGE_KEY, path: IMAGE_PATH, portal: built.cut.portal })
  manifest.images = images
  writeFileSync(MANIFEST, `${JSON.stringify(manifest, null, 2)}\n`)
  console.log(`gate: wrote ${OUT} and registered "${IMAGE_KEY}" in the manifest`)
}

if (import.meta.url === `file://${process.argv[1]}`) main()
