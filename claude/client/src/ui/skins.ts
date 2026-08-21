/**
 * The skins menu's pure half (`docs/71-amendments-v3.md` §B3).
 *
 * Phaser-free (§A8). What lives here is the selection and its persistence —
 * the part that can be wrong without looking wrong, because a picker that
 * silently fails to save reads exactly like one that saved.
 *
 * The server never validates a skin id and never sends a texture name
 * (`docs/50` §1), so everything here resolves client-side and every lookup
 * falls back (§8).
 */

export const SKIN_KEY = 'deepcut.skin'
export const STONE_KEY = 'deepcut.stone'
export const NAME_KEY = 'deepcut.name'

/** Longest name the server accepts (`docs/40` §2: 1–16 chars). */
export const MAX_NAME = 16

export interface Choice {
  name: string
  skinId: number
  tombstoneSkinId: number
}

export const DEFAULT_CHOICE: Choice = { name: 'Player', skinId: 0, tombstoneSkinId: 0 }

/**
 * Read a stored id, falling back to 0.
 *
 * `localStorage` holds strings a user can edit, so `"banana"`, `"-3"` and
 * `"1e9"` all have to resolve to something drawable rather than to `NaN`
 * arriving at the atlas. `count` bounds it, because an id past the end of the
 * registry is the same problem as a non-numeric one.
 */
export function readId(store: Pick<Storage, 'getItem'>, key: string, count: number): number {
  const raw = store.getItem(key)
  if (raw === null) return 0
  const n = Number(raw)
  if (!Number.isInteger(n) || n < 0 || n >= count) return 0
  // `Number` accepts spellings `String` never produces — "0x2" is 2, " 2 " is 2,
  // "+2" is 2. Requiring the round-trip makes what was written the definition of
  // what can be read, rather than letting a hand-edited value resolve to a skin
  // that nothing in this client would ever have stored.
  return String(n) === raw ? n : 0
}

/**
 * A name that is safe to send and to render.
 *
 * Trimmed, clamped to `MAX_NAME`, and never empty — an empty name is rejected
 * by the server (`docs/40` §2) and would strand the player on a join error they
 * cannot diagnose. Angle brackets go because the menu and the scoreboard build
 * HTML.
 */
export function cleanName(raw: string): string {
  const s = raw.replace(/[<>]/g, '').trim().slice(0, MAX_NAME)
  return s.length > 0 ? s : DEFAULT_CHOICE.name
}

export function loadChoice(
  store: Pick<Storage, 'getItem'>,
  skinCount: number,
  stoneCount: number,
): Choice {
  return {
    name: cleanName(store.getItem(NAME_KEY) ?? DEFAULT_CHOICE.name),
    skinId: readId(store, SKIN_KEY, skinCount),
    tombstoneSkinId: readId(store, STONE_KEY, stoneCount),
  }
}

export function saveChoice(store: Pick<Storage, 'setItem'>, c: Choice): void {
  store.setItem(NAME_KEY, cleanName(c.name))
  store.setItem(SKIN_KEY, String(c.skinId))
  store.setItem(STONE_KEY, String(c.tombstoneSkinId))
}

/** Step through a list of ids, wrapping — the arrow buttons and the arrow keys. */
export function cycle(current: number, delta: number, count: number): number {
  if (count <= 0) return 0
  return (((current + delta) % count) + count) % count
}

export interface TombstoneSkinDef {
  id: number
  name: string
}

/**
 * Weapon skins, shown greyed out (§B3).
 *
 * They are listed here rather than hard-coded in the scene so the "Coming soon"
 * section shows the **real** arsenal and cannot drift from it: a weapon added to
 * the registry and not to this list is a visible gap, which is the point of
 * showing it at all.
 */
export interface WeaponSlot {
  weaponKey: string
  label: string
}

export function weaponSlots(keys: readonly string[]): WeaponSlot[] {
  return keys.map((k) => ({ weaponKey: k, label: titleCase(k) }))
}

function titleCase(key: string): string {
  return key
    .split('_')
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ')
}

/**
 * Which frames a skins preview needs from the atlas, so a missing one is named
 * rather than silently drawn as a placeholder.
 *
 * The preview runs the **walk** cycle (§B3): a still frame hides the difference
 * between skins that differ only by palette, which is exactly how Kenney's pack
 * is organised and therefore exactly the case this menu exists to show.
 */
export const PREVIEW_STATE = 'walk' as const
