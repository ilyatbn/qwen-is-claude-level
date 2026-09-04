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
 * The name in `raw`, or `null` when there is none in it.
 *
 * **One predicate, three questions**, and they must not be allowed to disagree:
 * *is a name stored* (the first-run prompt's trigger), *is what the player just
 * typed a name* (the prompt's own validation), and *what do we send* — because a
 * prompt that appears for a name the game would have accepted, or a box that
 * accepts one the game then replaces with `Player`, is worse than no prompt.
 * `cleanName` and `storedName` are this function with two different endings.
 */
export function nameOrNull(raw: string): string | null {
  const s = raw.replace(/[<>]/g, '').trim().slice(0, MAX_NAME)
  return s.length > 0 ? s : null
}

/**
 * A name that is safe to send and to render.
 *
 * Trimmed, clamped to `MAX_NAME`, and never empty — an empty name is rejected
 * by the server (`docs/40` §2) and would strand the player on a join error they
 * cannot diagnose. Angle brackets go because the menu and the scoreboard build
 * HTML.
 *
 * **This is not the injection guard**, and reading it as one would be a mistake:
 * `"` and `'` pass straight through, and `SkinsScene` interpolates the name into
 * an HTML *attribute*. Every sink escapes with `escapeHtml` (`results.ts`,
 * `deathOverlay.ts`, `MenuScene`, `SkinsScene`); this is a second layer at the
 * storage boundary, not the only one. `sanitise_name` on the server strips
 * control characters and neither brackets nor quotes, so the client owns both.
 */
export function cleanName(raw: string): string {
  return nameOrNull(raw) ?? DEFAULT_CHOICE.name
}

/**
 * The name this browser has stored, or `null` when it has never been told one.
 *
 * The question the first-run prompt asks (T20.02), and it has to be *this*
 * question rather than "is the key present": a key holding `"   "` or `"<>"` is
 * a key holding nothing, and `cleanName` would silently turn it into `Player`.
 * Sharing `tidyName` is what keeps "we have a name" and "this is the name we
 * send" from disagreeing.
 *
 * A player who genuinely types `Player` is stored and never asked again — the
 * key is present and non-blank, which is the whole test.
 */
export function storedName(store: Pick<Storage, 'getItem'>): string | null {
  const raw = store.getItem(NAME_KEY)
  return raw === null ? null : nameOrNull(raw)
}

export function loadChoice(
  store: Pick<Storage, 'getItem'>,
  skinCount: number,
  stoneCount: number,
): Choice {
  return {
    name: storedName(store) ?? DEFAULT_CHOICE.name,
    skinId: readId(store, SKIN_KEY, skinCount),
    tombstoneSkinId: readId(store, STONE_KEY, stoneCount),
  }
}

/**
 * The stored choice, for a caller that has no skin registry to bound it with.
 *
 * **The menu is that caller and it cannot become one.** `loadChoice` needs a
 * skin count, `SkinsScene` gets it from `skins()?.players.length` *after the
 * atlas loads*, and `MenuScene` imports no registry at all — so "give the menu
 * the atlas lookup" would make the menu wait on an image to know its own name.
 * The other way out is this: the same function, with the bound removed, because
 * the bound is the only part the atlas is needed for.
 *
 * Unbounded is safe at both ends and neither is an accident. The server clamps
 * to `u16::MAX` (`session.rs`) and never validates an id against a list because
 * it does not know what skins exist (`docs/50` §1); every client-side lookup
 * falls back for an id past the end of the registry (§8). What is *not* safe is
 * `NaN`, which `JSON.stringify` puts on the wire as `null` and which the client
 * then hands to its own atlas — and `readId` is what stops that, count or no
 * count. `Infinity` disables only the range test.
 */
export function loadIdentity(store: Pick<Storage, 'getItem'>): Choice {
  return loadChoice(store, Number.POSITIVE_INFINITY, Number.POSITIVE_INFINITY)
}

/**
 * Store a name, leaving the ids alone — through the one writer.
 *
 * Reading the ids back and writing them again looks redundant and is not: it is
 * how this shares `saveChoice` instead of becoming a second `setItem` on
 * `NAME_KEY`. A junk id in storage is normalised on the way through, which is a
 * repair rather than damage.
 */
export function saveName(store: Pick<Storage, 'getItem' | 'setItem'>, raw: string): void {
  saveChoice(store, { ...loadIdentity(store), name: cleanName(raw) })
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
