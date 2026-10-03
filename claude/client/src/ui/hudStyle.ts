/**
 * T23.21 — the HUD's type and palette, F's (`mockup-src/e_style.js::hudE`, the dark variant F1–F3 call): a serif in
 * warm off-white ink at reduced opacity, letter-spaced small caps-like labels, hairline tracks. Strong colour stays
 * for danger and identity (R10): the warning red, the bars' state colours, the player's own colour on the selected slot.
 *
 * **The face is bundled** (`assets/fonts/liberation-serif.ttf`, served at `/fonts/`; `docs/51` §5: no network; SIL OFL,
 * licence beside it). The mockup asks for `Georgia, serif`; the Chromium that rendered F1–F3 has no Georgia and draws
 * its default serif, **Liberation Serif** — measured (T23.21B): `Georgia,serif`, `serif` and `'Liberation Serif'` set
 * one string 306.36 px wide at 22 px, DejaVu Serif (what part A bundled, fontconfig's answer to `fc-match Georgia`)
 * 380.42. So Liberation Serif *is* the face in the pictures, and `look-hud` holds the HUD to it at Level A.
 */

export const HUD_FONT_FAMILY = 'HudSerif'
export const HUD_FONT_URL = '/fonts/liberation-serif.ttf'
const STYLE_ID = 'hud-serif-font'

/** The serif stack every restyled HUD element uses. */
export const HUD_SERIF = `'${HUD_FONT_FAMILY}',Georgia,'Times New Roman',serif`
/** `hudE`'s dark ink (`rgba(236,230,220,.85)`) and its track/dim tints. */
export const HUD_INK = 'rgba(236,230,220,.85)'
export const HUD_INK_DIM = 'rgba(236,230,220,.35)'
/** `hudE`'s `bottomLight` ink — the bars' captions (`cb`, a touch warmer than the timer's). */
export const HUD_INK_BOTTOM = 'rgba(240,232,220,.85)'
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

/**
 * T23.21B (R10): the player's colour as a CSS custom property on `<html>`, so every overlay styled in CSS (the results
 * screen's own row, the kill feed's lines that involve you, a hovered button) reads the one value. **One writer**:
 * `InventoryPanel.setAccent`, which the scene already calls with the seat's scarf; the fallback is `HUD_ACCENT`.
 */
export const HUD_ACCENT_VAR = '--hud-accent'
/** `var(--hud-accent, …)`, for a `cssText`. */
export const HUD_ACCENT_CSS = `var(${HUD_ACCENT_VAR},${HUD_ACCENT})`

export function setHudAccent(doc: Document, colour: string): void {
  doc.documentElement.style.setProperty(HUD_ACCENT_VAR, colour)
}

/**
 * T23.21B: an overlay panel (escape menu, options) in F's palette — night ink under the HUD's warm off-white, one
 * hairline, square corners: the pictures draw nothing rounded and nothing glossy.
 */
export const HUD_PANEL_BG = 'rgba(14,12,12,.86)'
export const HUD_HAIRLINE = `1px solid ${HUD_INK_DIM}`
/** A button: no fill, a hairline, the serif letter-spaced like `hudE`'s captions (hover/focus: `index.html`'s `.hud-btn`). */
export const HUD_BUTTON =
  `background:transparent;border:${HUD_HAIRLINE};border-radius:0;color:${HUD_INK};` +
  `font:14px/1 ${HUD_SERIF};letter-spacing:.14em;text-shadow:${HUD_SHADOW};cursor:pointer;pointer-events:auto;`
