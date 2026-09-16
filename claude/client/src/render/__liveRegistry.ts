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

/**
 * Every weapon's firing cadence, read from `defs.rs` and `constants.rs`.
 *
 * §F3 put `auto` and `cooldown` on the wire so the client would not carry a copy
 * of five cooldowns. A *test* carrying that copy would be the same defect with a
 * smaller blast radius — it would stay green against a drifted table — so this
 * resolves both from the declared source: the flag out of the weapon's delivery,
 * the cadence out of the constant its `cooldown` field names.
 */
function weaponFireByKey(): Map<string, { auto: boolean; cooldown: number }> {
  const defs = readFileSync(join(root, 'crates/game-core/src/weapons/defs.rs'), 'utf8')
  const consts = readFileSync(join(root, 'crates/game-core/src/constants.rs'), 'utf8')
  const values = new Map<string, number>()
  for (const m of consts.matchAll(/pub const ([A-Z0-9_]+):\s*f32\s*=\s*([0-9.]+)/g)) {
    values.set(m[1]!, Number(m[2]))
  }
  const out = new Map<string, { auto: boolean; cooldown: number }>()
  // One block per weapon. Split rather than a single greedy regex: `auto` lives
  // inside the delivery and `cooldown` outside it, so they must be read from the
  // same block or a weapon inherits its neighbour's cadence.
  for (const block of defs.split('WeaponDef {').slice(1)) {
    const key = /key:\s*"([^"]+)"/.exec(block)?.[1]
    const cooldownName = /\n\s*cooldown:\s*([A-Z0-9_]+)/.exec(block)?.[1]
    if (!key || !cooldownName) continue
    const cooldown = values.get(cooldownName)
    if (cooldown === undefined) continue
    out.set(key, { auto: /\bauto:\s*true\b/.test(block), cooldown })
  }
  return out
}

/**
 * `[{id, key, name, sprite, max_stack, auto?, cooldown?}]`, in
 * `item_registry_json()`'s shape — including §F3's cadence, which the real one
 * emits for weapons and omits for everything else.
 */
export function itemRegistryJson(): string {
  const src = readFileSync(join(root, 'crates/game-core/src/items/registry.rs'), 'utf8')
  const keys = [...src.matchAll(/key:\s*"([^"]+)"/g)].map((m) => m[1])
  const sprites = [...src.matchAll(/sprite:\s*"([^"]+)"/g)].map((m) => m[1])
  if (keys.length !== sprites.length) {
    throw new Error(`registry.rs: ${keys.length} keys but ${sprites.length} sprites`)
  }
  const fire = weaponFireByKey()
  return JSON.stringify(
    keys.map((key, i) => {
      const base: Record<string, unknown> = {
        id: i,
        key,
        name: key,
        sprite: sprites[i],
        max_stack: 1,
      }
      const f = key === undefined ? undefined : fire.get(key)
      if (f) {
        base['auto'] = f.auto
        base['cooldown'] = f.cooldown
      }
      return base
    }),
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
