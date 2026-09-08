/**
 * The skin registry, resolved (`docs/50-sprites-skins.md` §2, §8).
 *
 * Phaser-free (§A8) so the resolution rules — which are all of the interesting
 * part — are testable. The Phaser side only turns a resolved frame name into a
 * texture.
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
  muzzle: { x: number; y: number }
  pivot: { x: number; y: number }
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

/** Resolve a skin id, falling back to skin 0 and never throwing. */
export function resolveSkin(reg: SkinRegistry | null, skinId: number): SkinDef | null {
  if (!reg?.players?.length) return null
  return (
    reg.players.find((p) => p.id === skinId) ??
    reg.players.find((p) => p.id === FALLBACK_SKIN_ID) ??
    reg.players[0] ??
    null
  )
}

/**
 * The atlas frame names for one animation state, in order.
 *
 * Falls back to `idle`, then to the first state the skin defines, so a registry
 * missing `jetpack` renders *something* rather than nothing.
 */
export function framesFor(skin: SkinDef, state: AnimState): string[] {
  const names = skin.frames[state] ?? skin.frames.idle ?? Object.values(skin.frames)[0] ?? []
  return names.map((n) => skin.prefix + n)
}

/** Phaser animation key for a (skin, state) pair. Stable, so it is created once. */
export function animKey(skin: SkinDef, state: AnimState): string {
  return `anim_${skin.id}_${state}`
}

/** `"0xff8a7a"` → `0xff8a7a`; null/garbage → undefined (meaning "no tint"). */
export function parseTint(tint: string | null | undefined): number | undefined {
  if (!tint) return undefined
  const n = Number(tint)
  return Number.isFinite(n) ? n : undefined
}

/** Resolve a weapon skin by the weapon's key, or null if the registry lacks it. */
export function resolveWeaponSkin(
  reg: SkinRegistry | null,
  weaponKey: string,
): WeaponSkinDef | null {
  return reg?.weapons?.find((w) => w.weaponKey === weaponKey) ?? null
}

/**
 * Sprite scale so art of `artHeight` px covers a body of `bodyHeight` px.
 *
 * Kenney's characters are 110 px tall against a 28 px hitbox. Drawing them at
 * native size makes a player four times their own collision box, which reads as
 * a bug; drawing them *at* hitbox size makes a stumpy 28 px figure. The
 * convention here is that art is deliberately a little larger than the box —
 * `overshoot` — which is what platformers do and what `anchor.y` exists to
 * reconcile.
 */
export function spriteScale(artHeight: number, bodyHeight: number, overshoot = 1.55): number {
  if (artHeight <= 0) return 1
  return (bodyHeight * overshoot) / artHeight
}

/**
 * Where an accessory sits, and how big it is drawn (T20.12).
 *
 * **Here rather than in a `playerView-math.ts`, and that is deliberate.** These
 * and `spriteScale` above answer the same question — how big is the drawn figure
 * against its 28 px hitbox — and putting the two halves in different files is how
 * they drift. A hat placed against a scale computed elsewhere ends up on a
 * forehead the day `overshoot` moves.
 *
 * `PlayerView` draws the body with origin `(0.5, anchorY)` at container `(0, 0)`,
 * so the sprite's top edge is `-drawnHeight * anchorY`. Both offsets are
 * fractions of the **drawn** height, not of `PLAYER_H`: the art overshoots the
 * hitbox by `overshoot`, and an accessory pinned to the hitbox would sit in the
 * middle of the character's face.
 *
 * **The two must not overlap**, and the origins are what buys that. A hat is
 * anchored by its *bottom* just below the sprite's top edge, so it perches above
 * the head; the glasses are centred a little further down, across the face. Two
 * accessories that shared a band would be one region on screen, and no check
 * could attribute a change to either.
 */

/**
 * Fraction of the drawn height, from the sprite's top edge, where the hat's
 * **bottom** sits — and the glasses' **centre**.
 *
 * **Bigger than the geometry alone suggests, and measured rather than derived.**
 * The sprite's top edge is not the top of the character's head: Kenney's frames
 * carry transparent padding, and a hat placed at the frame's edge floats a
 * visible gap above the hair. A first draft used 0.10/0.16 and the screenshot
 * showed a red block hovering over an untouched head — *"a fix that changes the
 * code without changing the picture looks exactly like a fix that worked"*, which
 * is why this was screenshotted rather than reasoned about.
 */
export const HAT_LIFT = 0.23
export const GLASSES_DROP = 0.38

export function accessoryY(
  drawnHeight: number,
  anchorY: number,
  kind: 'hat' | 'glasses',
): number {
  const top = -drawnHeight * anchorY
  return top + drawnHeight * (kind === 'hat' ? HAT_LIFT : GLASSES_DROP)
}

/**
 * Scale for an accessory `artWidth` px wide on a body `bodyWidth` px wide.
 *
 * **Width, not height**, and that is the point: a hat has to match the head it
 * sits on, and the five hats differ in *height* by design — matching heights
 * would make the top hat as squat as the cap and delete the silhouette the picker
 * exists to show. `fraction` is how much of the body's width the accessory
 * spans; a hat is a little wider than the head, glasses a little narrower.
 */
export function accessoryScale(artWidth: number, bodyWidth: number, fraction: number): number {
  if (artWidth <= 0) return 1
  return (bodyWidth * fraction) / artWidth
}

/** A hat is slightly wider than the body; sunglasses slightly narrower. */
export const HAT_WIDTH_FRACTION = 1.15
export const GLASSES_WIDTH_FRACTION = 0.85
