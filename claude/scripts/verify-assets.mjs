#!/usr/bin/env node
/**
 * Validates that every path referenced by assets/manifest.json exists, and that no atlas packs a `weapon_*` frame.
 * (T23.15, R8: `assets/skins.json` — skins, weapon skins, tombstones — retired with the wearables, and its checks.)
 *
 * Written now, before there are any assets, so that M7 finds it already in the
 * gate rather than having to remember it. Until then a missing file is a SKIP,
 * not a failure.
 */
import { readFileSync, existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { incompleteProvenance, missingProvenance, packSources } from './lib/vendor-provenance.mjs'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const assets = join(root, 'assets')
const manifestPath = join(assets, 'manifest.json')

const problems = []

function readJson(path) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'))
  } catch (e) {
    problems.push(`${path}: ${e.message}`)
    return null
  }
}

if (!existsSync(manifestPath)) {
  console.log('assets: skipped (no manifest yet)')
  process.exit(0)
}

const manifest = readJson(manifestPath)
if (manifest) {
  for (const atlas of manifest.atlases ?? []) {
    for (const key of ['png', 'json']) {
      const p = atlas[key]
      if (!p) { problems.push(`atlas ${atlas.key}: missing "${key}"`); continue }
      if (!existsSync(join(assets, p))) problems.push(`atlas ${atlas.key}: ${p} not on disk`)
    }
  }
  for (const img of manifest.images ?? []) {
    // A path may carry a "#frame" suffix naming a frame inside an atlas.
    const p = String(img.path ?? '').split('#')[0]
    if (p && !existsSync(join(assets, p))) problems.push(`image ${img.key}: ${p} not on disk`)
  }
  // T23.15 (R5): the manifest names no themes — the client draws one world. A `themes` key is a stale writer.
  if ('themes' in manifest) problems.push('assets/manifest.json still has a "themes" key (retired, T23.15)')
}

// T23.15 (R8): the skin registry is gone; nothing may bring it back unread.
if (existsSync(join(assets, 'skins.json'))) problems.push('assets/skins.json is back — the skin registry retired with the wearables (T23.15)')

if (manifest) {
  const atlasFrames = new Map()
  for (const atlas of manifest.atlases ?? []) {
    const jsonPath = join(assets, atlas.json ?? '')
    if (!existsSync(jsonPath)) continue
    const data = readJson(jsonPath)
    if (!data) continue
    // Phaser JSON Hash format: { frames: { name: {...} } }
    const names = new Set(Object.keys(data.frames ?? {}))
    atlasFrames.set(atlas.key, names)
  }

  // (T23.07: the `decor` atlas retired with its reader, and its "a prop, not a tile" check with it.)

  // T23.16/T23.17 (R12, R15): every weapon's pickup and inventory icon is its held drawing
  // (client/src/look/actors/icons.ts). A packed frame under a weapon's sprite key would win over it
  // (`itemSprites-math.ts::artFor` tries the atlas first) and the ground would show the old art: no atlas may pack a
  // `weapon_*` frame. The registry's weapon sprites are all `weapon_*` (`weapons.test.ts` reads them).
  for (const [atlas, names] of atlasFrames) {
    for (const n of names) if (n.startsWith('weapon_')) problems.push(`atlas "${atlas}" still packs ${n}, which would hide its remodelled icon (T23.16/T23.17)`)
  }
}

// Provenance: docs/51 §8 and docs/73 §D7.
//
// §8 wants every vendored pack listed in assets/vendor/README.md with its
// source, licence and fetch date. The manifest is the side that decides what
// must be accounted for, because it is the list of packs the shipped art
// actually derives from — assets/vendor/ is gitignored (§A29), so on a clone
// the raw art is absent while the atlas and the manifest are still there.
//
// This gates the art commit and nothing else: with no manifest there are no
// vendored objects to account for, and the check has nothing to say.
// `vendorPacks` in assets/manifest.json is how a build script that consumed a
// sprite pack declares it, so a pipeline with no object manifest behind it —
// the cloud atlas was one until T21.27 retired it — is still accounted for. Without it this check would gate
// the art it was written for and stay silent about the art the next task
// commits through a second pipeline.
const objectManifestPath = join(assets, 'objects', 'manifest.json')
const shipsObjectArt = (manifest?.atlases ?? []).some((a) => a.key === 'objects')
if (shipsObjectArt && !existsSync(objectManifestPath)) {
  // Otherwise the guard below cannot tell "no vendored objects" from "someone
  // deleted the manifest", and this script is the only thing standing in front
  // of the art commit.
  problems.push(
    `assets/manifest.json ships the "objects" atlas but assets/objects/manifest.json ` +
      `is missing, so no pack behind that art can be accounted for (docs/51 §8)`,
  )
}
if (existsSync(objectManifestPath) || (manifest?.vendorPacks ?? []).length > 0) {
  const objectManifest = existsSync(objectManifestPath) ? readJson(objectManifestPath) : { objects: [] }
  const readmePath = join(assets, 'vendor', 'README.md')
  if (!existsSync(readmePath)) {
    problems.push(
      `assets/vendor/README.md is missing, so no pack the object art derives from has ` +
        `its source or licence recorded (docs/51 §8)`,
    )
  } else if (objectManifest) {
    const readme = readFileSync(readmePath, 'utf8')
    // Named, not counted. "3 packs unrecorded" sends the next person reading
    // every row by hand; the names send them to the three that are wrong.
    const sources = packSources(objectManifest, manifest)
    for (const pack of missingProvenance(objectManifest, readme, manifest)) {
      problems.push(
        `pack "${pack}" is required by ${sources.get(pack)} but has no entry in ` +
          `assets/vendor/README.md — record its source, licence and fetch date (docs/51 §8)`,
      )
    }
    // A row is not a record. Naming the pack and leaving the cells blank would
    // otherwise satisfy the check above while the message it prints asks for
    // three things it never looked at. "not recorded" is a legitimate source
    // for these packs (§D7: nobody knows the URL); an empty cell is not.
    for (const pack of incompleteProvenance(objectManifest, readme, manifest)) {
      problems.push(
        `pack "${pack}" has a row in assets/vendor/README.md but leaves its source, ` +
          `licence or fetch date blank — an empty cell is not a record (docs/51 §8)`,
      )
    }
  }
}

if (problems.length > 0) {
  console.error('assets: FAILED')
  for (const p of problems) console.error('  - ' + p)
  process.exit(1)
}
console.log('assets: ok')
