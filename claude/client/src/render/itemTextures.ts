/**
 * Ground and inventory icons (§B20).
 *
 * **T23.16/T23.17 (R12): every weapon's icon is its held model** — `look/actors/icons.ts` draws it, lit by F6's
 * moon; one design per weapon for the hand, the ground and the bag. What is still painted here is the non-weapon
 * items that have no model yet (battery, fangs, boots, wings — T23.19's furniture), at 16 px, **distinct by
 * silhouette, not by palette**: at 16 px on the ground the outline is all a player can read.
 */

import Phaser from 'phaser'
import { ICON_CENTRE_UNITS, ICON_RES, ICON_SPRITES, ICON_UNIT_PX, PICKUP_S, litWeapon, pickupScale } from '../look/actors/icons'

type Ctx = CanvasRenderingContext2D
const S = 16

/** Sprite key → painter. Keys are the registry's `ItemDef.sprite`, verbatim. */
const ART: Record<string, (c: Ctx) => void> = {
  // --- consumables ---------------------------------------------------------
  item_battery: (c) => {
    c.fillStyle = '#2d3540'
    c.fillRect(3, 4, 10, 9)
    c.fillStyle = '#8a939e'
    c.fillRect(6, 2, 4, 2) // terminal
    c.fillStyle = '#5ce06a'
    c.fillRect(4, 9, 8, 3) // charge bar
  },

  // T23.16/T23.17: every weapon's icon is its held drawing (`look/actors/icons.ts`), drawn below — not painted here
  // (the retired melee weapons too: the registry keeps them, so they keep art).

  // --- M21's effect items: silhouette first, colour second -----------------
  //
  // A pair of fangs, drawn as two downward tapers under a dark upper lip. No
  // other icon here is two thin vertical spikes, which is the property that
  // makes it readable at 16 px on the ground — the same rule `tombstoneTextures`
  // states.
  item_vampire_fangs: (c) => {
    c.fillStyle = '#2a1016'
    c.fillRect(3, 3, 10, 4) // the gum line
    c.fillStyle = '#f2eee6'
    for (const x of [5, 9]) {
      c.beginPath()
      c.moveTo(x - 1.5, 6)
      c.lineTo(x + 1.5, 6)
      c.lineTo(x, 13)
      c.closePath()
      c.fill()
    }
    c.fillStyle = '#b0202a'
    c.fillRect(4, 14, 2, 1) // a drop under each point
    c.fillRect(10, 14, 2, 1)
  },
  item_ironman_boots: (c) => {
    // The pair seen from the side: a chunky sole is the whole silhouette, and
    // nothing else in this table is a wide flat slab under a block.
    c.fillStyle = '#c8322a'
    c.fillRect(3, 4, 9, 6) // upper
    c.fillRect(4, 2, 5, 2) // cuff
    c.fillStyle = '#f0c020'
    c.fillRect(2, 10, 12, 3) // sole, overhanging both ends
    c.fillStyle = '#8a1f18'
    c.fillRect(3, 7, 9, 1) // lace band
  },
  item_unicorn_wings: (c) => {
    // Two swept wings meeting at a stem — the only outline here that is wider
    // than it is tall and split down the middle, which is what makes it
    // readable beside the boots' slab at 16 px.
    c.fillStyle = '#f2eef8'
    for (const dir of [-1, 1]) {
      c.beginPath()
      c.moveTo(8, 12)
      c.lineTo(8 + dir * 7, 4)
      c.lineTo(8 + dir * 6, 11)
      c.closePath()
      c.fill()
    }
    c.fillStyle = '#c48ce0'
    c.fillRect(7, 6, 2, 7) // the stem between them
    c.fillStyle = '#7ad0f0'
    c.fillRect(6, 3, 4, 2) // a bright crest, so it is not a white blob
  },
}

/** Sprite keys this module can draw — the painters and the remodelled weapons' icons. The check asserts against the registry. */
export function proceduralItemKeys(): string[] {
  return [...Object.keys(ART), ...Object.keys(ICON_SPRITES)]
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
  for (const [key, paint] of Object.entries(ART)) {
    if (textures.exists(key)) continue
    const tex = textures.createCanvas(key, S, S)
    const ctx = tex?.getContext()
    if (!ctx) continue
    ctx.clearRect(0, 0, S, S)
    paint(ctx)
    tex?.refresh()
  }
}
