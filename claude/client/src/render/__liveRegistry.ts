/**
 * The registry and the atlas as they actually ship — for tests only.
 *
 * §B20: the item-sprite check validated against a hand-written fixture, so it
 * could not see a registry entry with no art, which is how eighteen of them
 * shipped. This reads the same two files the game reads.
 *
 * Parsed from source rather than imported through WASM because the assertion is
 * about the *declared data*, and a test that boots the engine to read a table is
 * a test that fails for engine reasons.
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '../../..')

/** `[{id, key, name, sprite, max_stack}]`, in `item_registry_json()`'s shape. */
export function itemRegistryJson(): string {
  const src = readFileSync(join(root, 'crates/game-core/src/items/registry.rs'), 'utf8')
  const keys = [...src.matchAll(/key:\s*"([^"]+)"/g)].map((m) => m[1])
  const sprites = [...src.matchAll(/sprite:\s*"([^"]+)"/g)].map((m) => m[1])
  if (keys.length !== sprites.length) {
    throw new Error(`registry.rs: ${keys.length} keys but ${sprites.length} sprites`)
  }
  return JSON.stringify(
    keys.map((key, i) => ({ id: i, key, name: key, sprite: sprites[i], max_stack: 1 })),
  )
}

/** Every frame name `atlas-map.json` declares, at any nesting depth. */
export function packedFrameKeys(): Set<string> {
  const map = JSON.parse(readFileSync(join(root, 'assets/atlas-map.json'), 'utf8')) as unknown
  const out = new Set<string>()
  const walk = (node: unknown): void => {
    if (node === null || typeof node !== 'object') return
    for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
      if (k.startsWith('_')) continue
      out.add(k)
      walk(v)
    }
  }
  walk(map)
  return out
}
