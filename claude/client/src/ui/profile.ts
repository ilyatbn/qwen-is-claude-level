/**
 * The player's name — what survives of the skins menu's pure half (T23.15, R8).
 *
 * Wearables are gone (skin, hat, glasses, tombstone: `M23-art.md` R8); **the name stays**, and it lives here. Phaser-free.
 * The join JSON still carries the old appearance fields for an old server's sake — `net/lobby.ts::identityPayload`
 * sends their defaults, and nothing on this client reads them back.
 */

/** `localStorage` key of the stored name. `scripts/lib/client-keys.mjs` reads the `*_KEY` exports of this file. */
export const NAME_KEY = 'deepcut.name'

/** Longest name the server accepts (`docs/40` §2: 1–16 chars). */
export const MAX_NAME = 16

/** The name a player who never chose one is sent as. */
export const DEFAULT_NAME = 'Player'

/**
 * The name in `raw`, or `null` when there is none in it.
 *
 * **One predicate, three questions**, and they must not be allowed to disagree:
 * *is a name stored* (the first-run prompt's trigger), *is what the player just
 * typed a name* (the prompt's own validation), and *what do we send*.
 */
export function nameOrNull(raw: string): string | null {
  const s = raw.replace(/[<>]/g, '').trim().slice(0, MAX_NAME)
  return s.length > 0 ? s : null
}

/**
 * A name that is safe to send and to render: trimmed, clamped to `MAX_NAME`, never empty (the server rejects an
 * empty name). Angle brackets go because the menu and the scoreboard build HTML — a second layer at the storage
 * boundary, not the injection guard: every sink escapes with `escapeHtml`.
 */
export function cleanName(raw: string): string {
  return nameOrNull(raw) ?? DEFAULT_NAME
}

/** The name this browser has stored, or `null` when it has never been told one (the first-run prompt's question). */
export function storedName(store: Pick<Storage, 'getItem'>): string | null {
  const raw = store.getItem(NAME_KEY)
  return raw === null ? null : nameOrNull(raw)
}

/** The name to join as: the stored one, else the default. */
export function loadName(store: Pick<Storage, 'getItem'>): string {
  return storedName(store) ?? DEFAULT_NAME
}

/** Store a name — cleaned, so what is stored is what every later read produces. */
export function saveName(store: Pick<Storage, 'setItem'>, raw: string): void {
  store.setItem(NAME_KEY, cleanName(raw))
}
