/**
 * The skin registry, resolved (`docs/50-sprites-skins.md` §2, §8).
 *
 * Phaser-free (§A8). **T23.14 (R15): only the registry's validation is left.** The frame, tint, scale and
 * accessory-placement rules retired with the sprite body, their last reader (`PlayerView`, now M23's stick figure);
 * the registry itself is read by the skins screen until T23.15 removes it (R8).
 *
 * **Every lookup falls back.** The game must start with no art at all (§8): an
 * unknown skin id resolves to skin 0, an unknown animation state to `idle`, and
 * a skin whose atlas never loaded to the procedural placeholder. That rule is
 * not defensive padding — it is what let M3 through M6 run for the entire
 * project before a single PNG existed.
 */

import type { AnimState } from './playerView-math'

export interface SkinDef {
  id: number
  name: string
  atlas: string
  prefix: string
  frames: Partial<Record<AnimState, string[]>>
  anchor: { x: number; y: number }
  tint: string | null
}

export interface WeaponSkinDef {
  id: number
  weaponKey: string
  /** `null` means procedural — drawn at runtime rather than packed. */
  atlas: string | null
  frame: string
  // T23.16: `muzzle`/`pivot` removed — read by nothing; a weapon's muzzle and grips live in `look/actors/weapons.ts`.
}

export interface SkinRegistry {
  version: number
  players: SkinDef[]
  weapons: WeaponSkinDef[]
}

/** The skin used when an id is unknown — always id 0 (`docs/50` §8). */
export const FALLBACK_SKIN_ID = 0

/**
 * Validate a parsed `skins.json`, returning the problems rather than throwing.
 *
 * A malformed registry must not stop the game booting; it degrades to
 * placeholders. Returning the list means the caller can log every problem at
 * once instead of one per reload.
 */
export function validateRegistry(reg: unknown): string[] {
  const errs: string[] = []
  if (typeof reg !== 'object' || reg === null) return ['registry is not an object']
  const r = reg as Partial<SkinRegistry>
  if (!Array.isArray(r.players) || r.players.length === 0) {
    errs.push('players is missing or empty')
    return errs
  }
  const seen = new Set<number>()
  for (const p of r.players) {
    if (typeof p.id !== 'number') {
      errs.push(`a player skin has no numeric id`)
      continue
    }
    if (seen.has(p.id)) errs.push(`duplicate player skin id ${p.id}`)
    seen.add(p.id)
    if (!p.atlas) errs.push(`skin ${p.id} has no atlas`)
    if (typeof p.prefix !== 'string') errs.push(`skin ${p.id} has no prefix`)
    if (!p.frames || !p.frames.idle?.length) errs.push(`skin ${p.id} has no idle frames`)
    if (!p.anchor || typeof p.anchor.y !== 'number') errs.push(`skin ${p.id} has no anchor`)
  }
  if (!seen.has(FALLBACK_SKIN_ID)) {
    // Everything falls back to skin 0, so its absence is the one fatal case —
    // fatal to the registry, not to the game, which then uses placeholders.
    errs.push(`no skin with id ${FALLBACK_SKIN_ID}, which every fallback needs`)
  }
  for (const w of r.weapons ?? []) {
    if (!w.weaponKey) errs.push(`a weapon skin has no weaponKey`)
  }
  return errs
}
