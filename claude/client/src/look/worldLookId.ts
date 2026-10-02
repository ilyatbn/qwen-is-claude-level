/**
 * T23.31 (docs/78 §A7): the world looks' ids and the dev override — split from `worlds.ts` so the game scenes can name
 * a look without pulling the reference scenes' data into their chunk (the world renderer is loaded on demand,
 * T23.03B F10; `worlds.ts` is its).
 */
import { devSurface } from '../dev'

export type WorldLookId = 'classic' | 'volcanic'
/** Every look, in the order the server's byte will number them (classic 0 — the default for a map that names none). */
export const WORLD_LOOK_IDS: readonly WorldLookId[] = ['classic', 'volcanic']

export function isWorldLookId(v: string | null | undefined): v is WorldLookId {
  return (WORLD_LOOK_IDS as readonly string[]).includes(v ?? '')
}

/**
 * Dev surface only (§A7's override, for checks and for the owner to compare): `?look=volcanic` in the sandbox and the
 * look-lab, `?worldlook=volcanic` anywhere (`?look=` alone opens the look-lab from the title — `main.ts`). Null: none
 * asked for — the map's own look stands.
 */
export function worldLookOverride(search: string): WorldLookId | null {
  return devSurface() ? worldLookInUrl(search) : null
}

/** The look a URL names (`worldlook=`, else `look=`), dev surface or not — `worldLookOverride`'s parse. */
export function worldLookInUrl(search: string): WorldLookId | null {
  const q = new URLSearchParams(search)
  const v = q.get('worldlook') ?? q.get('look')
  return isWorldLookId(v) ? v : null
}

/** T23.31: a look's wire byte (`WorldLook::to_u8`) — its index in `WORLD_LOOK_IDS`, the server's byte order. */
export function worldLookByte(id: WorldLookId): number {
  return WORLD_LOOK_IDS.indexOf(id)
}

/** T23.31: the look a map's meta names (`MapMeta::look`, serde's `'Classic'`/`'Volcanic'`); anything else: classic. */
export function worldLookOfMeta(look: string | undefined): WorldLookId {
  const id = (look ?? '').toLowerCase()
  return isWorldLookId(id) ? id : 'classic'
}

/** What `adoptWorldLook` needs of the core: its meta's look, and the setter `map_init` uses. */
export interface WorldLookCore {
  readonly meta: { look?: string }
  setWorldLook(look: number): boolean
}

/**
 * T23.31 (docs/78 §A7): **the look the map in the core is drawn in** — the server's (`map_init`, or the generator's
 * own pick in the sandbox), unless the dev override (`?worldlook=` / `?look=`) forces one. The override is written
 * into the core, so everything downstream (the Rust relief's boulder threshold, the fields key, the scene) reads one
 * answer. Call it after the map is installed and before anything is drawn from it.
 */
export function adoptWorldLook(core: WorldLookCore, search: string): WorldLookId {
  const forced = worldLookOverride(search)
  if (forced !== null) core.setWorldLook(worldLookByte(forced))
  return forced ?? worldLookOfMeta(core.meta.look)
}
