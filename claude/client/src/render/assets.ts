/**
 * Loading art, and surviving its absence (`docs/51-assets.md` §6, `docs/50` §8).
 *
 * The manifest names what to load; nothing else does. Adding art is a manifest
 * entry, never a code change.
 *
 * **The game must start with no art at all.** Every load here is best-effort: a
 * missing manifest, a 404 atlas, a malformed `skins.json` — each degrades to the
 * procedural placeholders that carried this project from M3 to M6, and each logs
 * exactly once so it is obvious in the console without being noisy.
 */

import Phaser from 'phaser'
import {
  validateRegistry,
  type SkinRegistry,
} from './skins-math'

interface Manifest {
  atlases: { key: string; png: string; json: string }[]
  images: { key: string; path: string }[]
  themes: string[]
  audio: string[]
}

let registry: SkinRegistry | null = null
let manifest: Manifest | null = null
let loadAttempted = false

/** The skin registry, or null if it never loaded. Callers must handle null. */
export function skins(): SkinRegistry | null {
  return registry
}

/** Theme names the manifest declared, for the terrain renderer. */
export function themeNames(): string[] {
  return manifest?.themes ?? []
}

/**
 * Fetch the manifest and skin registry, then queue every atlas onto the scene's
 * loader. Await this in `preload`/`create` before `load.start()`.
 *
 * Returns the number of atlases queued, so a caller can log "running on
 * placeholders" honestly rather than guessing.
 */
export async function loadAssetManifest(scene: Phaser.Scene): Promise<number> {
  if (!loadAttempted) {
    loadAttempted = true
    manifest = await fetchJson<Manifest>('/manifest.json', 'manifest')
    const raw = await fetchJson<unknown>('/skins.json', 'skins')
    if (raw) {
      const errs = validateRegistry(raw)
      if (errs.length) {
        // Not fatal: a broken registry means placeholders, not a broken game.
        console.warn(`[assets] skins.json has ${errs.length} problem(s):`, errs.slice(0, 5))
      } else {
        registry = raw as SkinRegistry
      }
    }
  }

  let queued = 0
  for (const a of manifest?.atlases ?? []) {
    if (scene.textures.exists(a.key)) continue
    scene.load.atlas(a.key, `/${a.png}`, `/${a.json}`)
    queued++
  }
  for (const im of manifest?.images ?? []) {
    if (!scene.textures.exists(im.key)) scene.load.image(im.key, `/${im.path}`)
  }

  if (queued === 0 && !manifest) {
    console.info('[assets] no manifest — running on procedural placeholders')
  }
  return queued
}

/**
 * Run the scene's loader to completion.
 *
 * A load error is logged and swallowed: `docs/50` §8 requires the game to start
 * regardless, and a rejected promise here would take the scene down with it.
 */
export function runLoader(scene: Phaser.Scene): Promise<void> {
  return new Promise((resolve) => {
    if (scene.load.list.size === 0 && !scene.load.isLoading()) {
      resolve()
      return
    }
    scene.load.once(Phaser.Loader.Events.COMPLETE, () => resolve())
    scene.load.on(Phaser.Loader.Events.FILE_LOAD_ERROR, (file: Phaser.Loader.File) => {
      console.warn(`[assets] failed to load "${file.key}" — falling back`)
    })
    scene.load.start()
  })
}

async function fetchJson<T>(url: string, what: string): Promise<T | null> {
  try {
    const res = await fetch(url)
    if (!res.ok) {
      console.info(`[assets] no ${what} (${res.status}) — using placeholders`)
      return null
    }
    return (await res.json()) as T
  } catch (e) {
    console.info(`[assets] could not fetch ${what} — using placeholders`, e)
    return null
  }
}

/** Test seam: forget what was loaded, so a suite can exercise the empty path. */
export function resetAssetsForTest(): void {
  registry = null
  manifest = null
  loadAttempted = false
}
