/**
 * T23.10C F6: **night on the Phaser fallback** — the picture when there is no world renderer (no WebGL2, or the dev
 * `?world=off`). Phaser-free (§A8).
 *
 * The night view (`look/post.ts`, `worldRenderer-math.ts::nightUniforms`) is the world renderer's: with none,
 * `setNightView` went nowhere and a fallback round stayed at noon all night — while the seeing rule still hid remotes
 * beyond the sight (`GameScene.renderRemotes`), so players vanished in what looked like daylight. The fallback has no
 * circles to open, so it dims the whole view, by night's share, to **half** of what the night view takes from outside
 * the sight (`1 − NIGHT_VIEW_KEEP`): dark enough to read as night, light enough to play by without the sight's pool.
 */
import { NIGHT_VIEW_KEEP } from '../look/worldRenderer-math'

/** The retired lightmap's night colour (`0x000818`, `worldRenderer-math.ts::NIGHT_VIEW_KEEP`'s basis). */
export const FALLBACK_NIGHT_COLOUR = 0x000818
/** The share of the night view's dimming the fallback applies everywhere (it has no sight pool to keep clear). */
export const FALLBACK_NIGHT_SHARE = 0.5

/** The fallback's dimming alpha (0 by day … `FALLBACK_NIGHT_SHARE × (1 − NIGHT_VIEW_KEEP)` at full night). */
export function fallbackNightAlpha(darkness: number, nightDarkness: number): number {
  const share = nightDarkness > 0 ? Math.min(1, Math.max(0, darkness / nightDarkness)) : 0
  return share * FALLBACK_NIGHT_SHARE * (1 - NIGHT_VIEW_KEEP)
}
