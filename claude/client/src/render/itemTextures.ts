/**
 * Ground and inventory icons (§B20).
 *
 * **T23.16/T23.17 (R12): every weapon's icon is its held model** — `look/actors/icons.ts` draws it, lit by F6's
 * moon; one design per weapon for the hand, the ground and the bag. **T23.19B: every non-weapon item's too** — the
 * world draws medkit, shield, flashlight, battery, fangs, boots and wings as `draw.ts::item` (T23.19), and their tiles
 * are that drawing now (`DRAWN_ITEMS`), where they were 16-px painted icons and packed atlas frames: silhouettes
 * distinct by outline, as the painted ones were (`draw.ts::item`'s comment).
 */

import Phaser from 'phaser'
import { DRAWN_ITEMS, ICON_CENTRE_UNITS, ICON_RES, ICON_SPRITES, ICON_UNIT_PX, PICKUP_S, litItem, litWeapon, pickupScale } from '../look/actors/icons'
import { ITEM_S } from '../look/actors/furniture'

/**
 * T23.19B: a drawn item's icon — `draw.ts::item` at `ITEM_S` world scale (~16 units), `ICON_RES` texture px per world
 * px, lit by the icon moon (`icons.ts::litItem`); `ITEM_ICON_PAD` world px of room for the rim passes' offsets.
 */
const ITEM_ICON_UNITS = 16
const ITEM_ICON_PAD = 3

/** Sprite keys this module can draw — the painters and the remodelled weapons' icons. The check asserts against the registry. */
export function proceduralItemKeys(): string[] {
  return [...DRAWN_ITEMS, ...Object.keys(ICON_SPRITES)]
}

/** A drawn item's icon texture (`DRAWN_ITEMS`), `sprite` its registry key. */
function itemIcon(textures: Phaser.Textures.TextureManager, sprite: string): void {
  const R = ICON_RES
  const side = Math.ceil((ITEM_ICON_UNITS * ITEM_S + 2 * ITEM_ICON_PAD) * R)
  const tex = textures.createCanvas(sprite, side, side)
  const ctx = tex?.getContext()
  if (!ctx) return
  ctx.clearRect(0, 0, side, side)
  litItem(ctx, sprite, side / 2, side / 2, ITEM_S * R, R)
  tex?.refresh()
}

/**
 * T23.16 (R12): a remodelled weapon's icon — its held drawing, lit by F6's moon (`icons.ts::litWeapon`), at the
 * pickup's world size × `ICON_RES`. Measured, then drawn: the drawing is laid down once at `PICKUP_S` on a scratch
 * canvas to find its extent (every weapon's differs — the whip is 36 units, a pistol 6), then fitted to the box.
 */
function weaponIcon(textures: Phaser.Textures.TextureManager, sprite: string, key: string): void {
  const R = ICON_RES
  const size = R
  const scratch = document.createElement('canvas')
  const SW = 256
  const SH = 160
  scratch.width = SW
  scratch.height = SH
  const sg = scratch.getContext('2d')
  if (!sg) return
  const s0 = PICKUP_S * R
  const ox = SW / 4
  const oy = SH / 2
  litWeapon(sg, key, ox, oy, s0, size)
  const d = sg.getImageData(0, 0, SW, SH).data
  let x0 = SW
  let y0 = SH
  let x1 = -1
  let y1 = -1
  for (let y = 0; y < SH; y++) {
    for (let x = 0; x < SW; x++) {
      if (!d[(y * SW + x) * 4 + 3]) continue
      if (x < x0) x0 = x
      if (x > x1) x1 = x
      if (y < y0) y0 = y
      if (y > y1) y1 = y
    }
  }
  if (x1 < 0) return
  // The extent at PICKUP_S, in world px (÷ R), gives the fitted scale; the texture holds it at R px per world px.
  const k = pickupScale((x1 + 1 - x0) / R, (y1 + 1 - y0) / R) / PICKUP_S
  const PAD = 2
  const w = Math.ceil((x1 + 1 - x0) * k) + 2 * PAD
  const h = Math.ceil((y1 + 1 - y0) * k) + 2 * PAD
  const tex = textures.createCanvas(sprite, w, h)
  const ctx = tex?.getContext()
  if (!ctx) return
  ctx.clearRect(0, 0, w, h)
  litWeapon(ctx, key, PAD + (ox - x0) * k, PAD + (oy - y0) * k, s0 * k, size * k)
  tex?.refresh()
  ICON_UNIT_PX.set(sprite, s0 * k)
  ICON_CENTRE_UNITS.set(sprite, [((x0 + x1 + 1) / 2 - ox) / s0, ((y0 + y1 + 1) / 2 - oy) / s0])
}

/**
 * Create every missing item texture once. Idempotent, and it never overwrites a
 * real atlas frame — packed art wins, and this is the fallback `docs/51` §5
 * describes.
 */
export function ensureItemTextures(textures: Phaser.Textures.TextureManager): void {
  for (const [sprite, key] of Object.entries(ICON_SPRITES)) {
    if (!textures.exists(sprite)) weaponIcon(textures, sprite, key)
  }
  for (const sprite of DRAWN_ITEMS) if (!textures.exists(sprite)) itemIcon(textures, sprite)
}
