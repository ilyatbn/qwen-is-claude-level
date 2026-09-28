/**
 * T23.16 (R12): a weapon's pickup and inventory icon — **the held weapon's own drawing** (`weapons.ts`), lit the way
 * F6 lights it (`f_kit.js::lit`: far rim, rim, cool fill, ink), by F6's moon alone: an icon has no scene, so no key
 * light but the moon. One design per weapon: the hand, the ground and the bag draw the same function.
 *
 * Pure (no DOM): `itemTextures.ts` draws these into Phaser canvas textures, which the item layer (the ground) and the
 * inventory tiles (`getBase64`) both read.
 */
import { DARK_INK } from './cell'
import { INK, setInk, type G } from './draw'
import { LIT, rimAlpha } from './lit'
import { FIREARMS, MELEE_THROWN, WEAPONS, drawWeapon } from './weapons'

/** `variant_F6.js`'s moon — the icons' only light. */
export const ICON_MOON = { dx: 0.6, dy: -0.8, rgb: '185,195,245', w: 0.75, fill: '90,80,110' } as const
/** F6 draws every weapon's accents (a laser's cells, a molotov's rag) in this red: `Wd.draw(gg, rc ?? '#e8482c')`. */
export const ICON_ACCENT = '#e8482c'

/**
 * A pickup's size in the world. A weapon lies on the ground at up to `PICKUP_S` (figure units → world px; the figure
 * itself is drawn at 1.15, so a pickup reads at twice the size it has in a hand), shrunk to fit `PICKUP_BOX` (world px,
 * w × h) — the bazooka and the machine gun fit by length, a pistol keeps the full scale. The old ground icons were
 * 16 px squares; a long gun now reads long.
 */
export const PICKUP_S = 2
export const PICKUP_BOX: readonly [number, number] = [30, 16]
/** Texture px per world px: drawn at 2× and shown at ½ in the world (the camera zooms 2×), full size in a 40-px tile. */
export const ICON_RES = 2

/**
 * The registry's sprite key (`ItemDef.sprite`, what the item layer and the inventory look art up by) for each
 * weapon: `weapon_<key>`, except the toxic grenade's, which the registry names `weapon_toxic`
 * (`weapons.test.ts` reads both off `items/registry.rs`). T23.16 drew the firearms' icons, T23.17 the rest.
 */
const SPRITE_NAMES: Readonly<Record<string, string>> = { toxic_grenade: 'weapon_toxic' }
export function spriteOf(key: string): string {
  return SPRITE_NAMES[key] ?? `weapon_${key}`
}
export const ICON_SPRITES: Readonly<Record<string, string>> = Object.fromEntries(
  [...FIREARMS, ...MELEE_THROWN].map((k) => [spriteOf(k), k]),
)

/**
 * T23.17: texture px per figure unit each icon was drawn at (`itemTextures.ts` fills it as it draws them) — what a
 * thrown weapon in flight is scaled by to be the size it is in the hand (`ordnance.ts`).
 */
export const ICON_UNIT_PX = new Map<string, number>()

/** The weapon key a registry sprite draws, or null for art that is not a remodelled weapon. */
export function iconWeapon(sprite: string): string | null {
  return ICON_SPRITES[sprite] ?? null
}

/**
 * `f_kit.js::lit` with the moon as its key light (`dominant` finds no light, so the moon): weapon `key` with its
 * shoulder-frame origin at (x, y), scaled by `s`; `size` is lit()'s (the passes' offsets, px). The ink is restored.
 */
export function litWeapon(g: G, key: string, x: number, y: number, s: number, size = 1): void {
  if (!WEAPONS[key]) return
  const L = ICON_MOON
  const a = rimAlpha(L.w)
  const o = LIT.rimOffset * size
  const far = o * LIT.farOffset
  const was = INK
  const pass = (ink: string, accent: string, dx: number, dy: number): void => {
    setInk(ink)
    drawWeapon(g, key, x + dx, y + dy, s, accent)
  }
  g.save()
  g.lineCap = 'round'
  g.lineJoin = 'round'
  pass(`rgba(${L.rgb},${a * LIT.farInk})`, `rgba(${L.rgb},${a * LIT.farAccent})`, L.dx * far, L.dy * far)
  pass(`rgba(${L.rgb},${a})`, `rgba(${L.rgb},${a})`, L.dx * o, L.dy * o)
  pass(`rgba(${L.fill},${LIT.fillAlpha})`, `rgba(${L.fill},${LIT.fillAlpha})`, -L.dx * LIT.fillOffset * size, -L.dy * LIT.fillOffset * size)
  setInk(DARK_INK)
  drawWeapon(g, key, x, y, s, ICON_ACCENT)
  g.restore()
  setInk(was)
}

/** The scale a weapon whose drawing at `PICKUP_S` measures `w` × `h` world px is shown at, fitted to `PICKUP_BOX`. */
export function pickupScale(w: number, h: number): number {
  const k = Math.min(1, PICKUP_BOX[0] / Math.max(w, 1e-6), PICKUP_BOX[1] / Math.max(h, 1e-6))
  return PICKUP_S * k
}
