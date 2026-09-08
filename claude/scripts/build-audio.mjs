#!/usr/bin/env node
/**
 * Build the shipped audio set from the vendored Kenney packs.
 *
 *   node scripts/build-audio.mjs
 *
 * Reads `assets/audio-map.json`, copies the named .ogg files into
 * `assets/audio/` under **our** cue names, and writes `assets/audio.json` — the
 * cue → files map the client fetches at boot.
 *
 * Same shape as `build-atlas.mjs` and the same reason (`docs/51` §4): the client
 * never learns which pack a sound came from, so swapping packs is an edit to the
 * map file, not to code.
 *
 * `assets/vendor/` is gitignored (§A29); `assets/audio/` is committed, which is
 * why only the ~25 files the game actually plays are copied out of the 366 the
 * packs contain.
 *
 * A missing source is reported and skipped. The build still succeeds, the cue is
 * simply absent from `audio.json`, and the game is silent for it — `docs/50` §8
 * requires the game to start with no art and no audio at all.
 */
import { mkdirSync, copyFileSync, existsSync, writeFileSync, readFileSync, rmSync, readdirSync, statSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const vendor = join(root, 'assets/vendor/kenney')
const outDir = join(root, 'assets/audio')

const map = JSON.parse(readFileSync(join(root, 'assets/audio-map.json'), 'utf8'))
const sustained = new Set(Object.keys(map._sustained ?? {}).filter((k) => !k.startsWith('_')))

// Rebuild from scratch: a cue removed from the map should stop shipping its
// files, and a stale .ogg in assets/audio would otherwise linger forever.
rmSync(outDir, { recursive: true, force: true })
mkdirSync(outDir, { recursive: true })

/** cue -> ["audio/<file>.ogg", ...] */
const out = {}
const missing = []
let bytes = 0

for (const [cue, sources] of Object.entries(map.cues)) {
  const files = []
  sources.forEach((rel, i) => {
    const src = join(vendor, rel)
    if (!existsSync(src)) {
      missing.push(`${cue}[${i}] -> ${rel}`)
      return
    }
    const name = sources.length > 1 ? `${cue}_${i}.ogg` : `${cue}.ogg`
    copyFileSync(src, join(outDir, name))
    bytes += statSync(src).size
    files.push(`audio/${name}`)
  })
  if (files.length) out[cue] = files
}

writeFileSync(
  join(root, 'assets/audio.json'),
  JSON.stringify({ sustained: [...sustained], cues: out }, null, 2) + '\n',
)

// The manifest lists every file so `verify-assets.mjs` can check they exist on
// disk (`docs/51` §9) — the same guarantee the atlases get.
const manifestPath = join(root, 'assets/manifest.json')
const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
manifest.audio = Object.values(out).flat().sort()
writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n')

const cueCount = Object.keys(out).length
const fileCount = readdirSync(outDir).length
console.log(`audio: ${cueCount} cues, ${fileCount} files, ${(bytes / 1024).toFixed(0)} kB`)
if (missing.length) {
  console.warn(`  ${missing.length} missing source(s) — those cues are silent:`)
  for (const m of missing) console.warn(`    ${m}`)
  console.warn('  run scripts/fetch-assets.sh, or accept the silence (docs/50 §8)')
}
