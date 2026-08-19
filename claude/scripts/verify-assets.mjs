#!/usr/bin/env node
/**
 * Validates that every path referenced by assets/manifest.json exists, and that
 * every atlas frame referenced by assets/skins.json exists in that atlas's JSON.
 *
 * Written now, before there are any assets, so that M7 finds it already in the
 * gate rather than having to remember it. Until then a missing file is a SKIP,
 * not a failure.
 */
import { readFileSync, existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const assets = join(root, 'assets')
const manifestPath = join(assets, 'manifest.json')
const skinsPath = join(assets, 'skins.json')

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
  for (const theme of manifest.themes ?? []) {
    for (const f of ['fill.png', 'edge.png', 'back.png', 'theme.json']) {
      const p = join('terrain', theme, f)
      if (!existsSync(join(assets, p))) problems.push(`theme ${theme}: ${p} not on disk`)
    }
  }
}

if (existsSync(skinsPath) && manifest) {
  const skins = readJson(skinsPath)
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

  const seenIds = new Set()
  for (const skin of skins?.players ?? []) {
    if (seenIds.has(skin.id)) problems.push(`skin id ${skin.id} is duplicated`)
    seenIds.add(skin.id)
    const frames = atlasFrames.get(skin.atlas)
    if (!frames) { problems.push(`skin ${skin.id}: unknown atlas "${skin.atlas}"`); continue }
    for (const [state, list] of Object.entries(skin.frames ?? {})) {
      for (const frame of list) {
        const full = `${skin.prefix ?? ''}${frame}`
        if (!frames.has(full)) problems.push(`skin ${skin.id} ${state}: frame "${full}" not in atlas ${skin.atlas}`)
      }
    }
  }

  const seenWeaponIds = new Set()
  for (const w of skins?.weapons ?? []) {
    if (seenWeaponIds.has(w.id)) problems.push(`weapon skin id ${w.id} is duplicated`)
    seenWeaponIds.add(w.id)
    const frames = atlasFrames.get(w.atlas)
    if (!frames) { problems.push(`weapon skin ${w.id}: unknown atlas "${w.atlas}"`); continue }
    if (!frames.has(w.frame)) problems.push(`weapon skin ${w.id}: frame "${w.frame}" not in atlas ${w.atlas}`)
  }
}

if (problems.length > 0) {
  console.error('assets: FAILED')
  for (const p of problems) console.error('  - ' + p)
  process.exit(1)
}
console.log('assets: ok')
