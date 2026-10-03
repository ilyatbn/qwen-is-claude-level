/**
 * T23.21 — the HUD's type and palette, F's (`mockup-src/e_style.js::hudE`, the dark variant F1–F3 call): a serif in
 * warm off-white ink at reduced opacity, letter-spaced small caps-like labels, hairline tracks. Strong colour stays
 * for danger and identity (R10): the warning red, the bars' state colours, the player's own colour on the selected slot.
 *
 * **The face is bundled** (`assets/fonts/dejavu-serif.ttf`, served at `/fonts/`; `docs/51` §5: no network). The
 * mockup asks for Georgia; the reference pictures were rendered on this box, where fontconfig answers Georgia with
 * DejaVu Serif — so DejaVu Serif *is* the face in F1–F3, and shipping it makes every machine draw the pictures' face
 * (Georgia stays first in the stack only as a name; the bundled family is tried before it).
 */

export const HUD_FONT_FAMILY = 'HudSerif'
export const HUD_FONT_URL = '/fonts/dejavu-serif.ttf'
const STYLE_ID = 'hud-serif-font'

/** The serif stack every restyled HUD element uses. */
export const HUD_SERIF = `'${HUD_FONT_FAMILY}',Georgia,'Times New Roman',serif`
/** `hudE`'s dark ink (`rgba(236,230,220,.85)`) and its track/dim tints. */
export const HUD_INK = 'rgba(236,230,220,.85)'
export const HUD_INK_DIM = 'rgba(236,230,220,.35)'
export const HUD_TRACK = 'rgba(236,230,220,.2)'
/** A soft shadow so the light ink reads over moonlit day's brighter sky too (F5); the pictures are night. */
export const HUD_SHADOW = '0 1px 2px rgba(0,0,0,.85)'
/** `hudE`'s accent when no seat colour is known (F1–F3's team A, the first seat's scarf). */
export const HUD_ACCENT = '#e8482c'

/** Install the `@font-face` once per document (a `<style>`, as `hud.ts::installFont`). */
export function installHudFont(doc: Document): void {
  if (doc.getElementById(STYLE_ID)) return
  const style = doc.createElement('style')
  style.id = STYLE_ID
  style.textContent = `@font-face{font-family:'${HUD_FONT_FAMILY}';src:url('${HUD_FONT_URL}') format('truetype');font-display:swap;}`
  doc.head.appendChild(style)
}
