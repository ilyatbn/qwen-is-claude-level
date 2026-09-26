/**
 * T23.03B / R20: every browser check **names its tier** — low — instead of inheriting one.
 *
 * With R20 a player who has never chosen gets the tier detected from the GPU, and the checks'
 * SwiftShader would be detected as low anyway. That is a coincidence of this box, not a
 * statement: a check run on a GPU runner would silently switch to the full tier and measure a
 * different picture. So every context the checks open stores the explicit choice `'0'` (High
 * Quality off → low, R14) before the page's first script runs — **only where nothing is stored**,
 * so a check that turns High Quality on and reloads (`escape-menu`'s persistence) still reads its
 * own choice back. `'0'` and "never chosen" are the same for today's Phaser shader layers
 * (`isHighQuality()` is false for both), so no existing check changes what it photographs.
 *
 * The key is read from `client/src/ui/settings.ts`, not spelled here (`client-keys.mjs`'s reason).
 */
import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseKeys } from './client-keys.mjs'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
export const SETTINGS_TS = join(root, 'client/src/ui/settings.ts')

export const HIGH_QUALITY_KEY = parseKeys(readFileSync(SETTINGS_TS, 'utf8')).get('HIGH_QUALITY_KEY')
if (!HIGH_QUALITY_KEY) throw new Error('HIGH_QUALITY_KEY is not an exported `*_KEY` in client/src/ui/settings.ts')

/** Store the low tier as an explicit choice in `target` (a page or a context), where none is stored. */
export async function nameTheTier(target) {
  await target.addInitScript((k) => {
    try {
      if (localStorage.getItem(k) === null) localStorage.setItem(k, '0')
    } catch {
      /* storage disabled: the page gets the detected tier, and says which in __world.info() */
    }
  }, HIGH_QUALITY_KEY)
}
