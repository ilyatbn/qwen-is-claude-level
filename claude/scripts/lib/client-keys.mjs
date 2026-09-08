/**
 * Read the client's `localStorage` key names from `client/src/ui/skins.ts`.
 *
 * The same argument `rust-constants.mjs` makes about tunables, one layer over:
 * `NAME_KEY` is owned by `skins.ts`, and three browser checks had spelled
 * `'deepcut.name'` by hand. A rename would move the client and every one of them
 * would keep setting a key nobody reads — and the checks would still pass,
 * because a player with no stored name is a supported state (they get the default
 * one). Silent, green, and wrong: T20.02's rename trap.
 *
 * `key` **throws** on a name that is not exported, for the reason
 * `rust-constants.mjs` gives: a reader that returned `undefined` would leave
 * `localStorage.setItem(undefined, …)` succeeding forever.
 */
import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..')

export const SKINS_TS = join(root, 'client/src/ui/skins.ts')

const DECL = /^export const ([A-Z][A-Z0-9_]*_KEY)\s*=\s*'([^']+)'/gm

export function parseKeys(source) {
  const found = new Map()
  for (const m of source.matchAll(DECL)) found.set(m[1], m[2])
  return found
}

let cached = null

/** `NAME_KEY` → `'deepcut.name'`, as the client spells it today. */
export function key(name) {
  cached ??= parseKeys(readFileSync(SKINS_TS, 'utf8'))
  const v = cached.get(name)
  if (v === undefined) {
    throw new Error(
      `${name} is not an exported \`*_KEY\` in client/src/ui/skins.ts — it was renamed or moved`,
    )
  }
  return v
}
