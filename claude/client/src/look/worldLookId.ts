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
