/**
 * Hats and sunglasses (T20.12), drawn procedurally.
 *
 * **There is no art and none is available.** `assets/atlas/chars.json` holds 50
 * frames — 5 characters x 10 poses — and no accessories. Kenney's
 * `platformer-characters` pack has no hats, glasses, helmets, caps or crowns, and
 * `../sprite_packs` is terrain, sky and scenery with no character art at all. So
 * this follows `tombstoneTextures.ts`, which exists for exactly the same reason,
 * and inherits its two rules:
 *
 *  - **Differ in silhouette, not in palette.** A picker whose options differ only
 *    by colour is a picker with one option, and at `PLAYER_W = 16` a hat is about
 *    ten pixels wide — the outline is the whole of what a player can read.
 *  - **Do not borrow an atlas frame that "reads as a hat".** `tombstoneTextures`
 *    records the mistake that preceded it: two decor frames turned out to be 98 %
 *    opaque terrain tiles, and `verify-assets` rejects that now. Procedural art
 *    sidesteps the guard; borrowed art meets it.
 *
 * Drawn at native size, because the game renders `pixelArt` and drawing larger
 * would only blur under NEAREST.
 */

import Phaser from 'phaser'

export interface AccessoryArt {
  id: number
  key: string
  name: string
  /** Canvas size, px. Hats and glasses have different natural shapes. */
  w: number
  h: number
}

const HAT_W = 14
const HAT_H = 9
const GLASSES_W = 12
const GLASSES_H = 4

/**
 * Ids are the wire values (`hat_id`), so this order is not cosmetic.
 *
 * **Id 0 is "none", and that is load-bearing**: `readId` falls back to 0 for a
 * junk or out-of-range value, so the fallback has to be a legal appearance rather
 * than an arbitrary hat. `tombstoneArt` falls back to a real headstone because a
 * grave always has a marker; a head does not always have a hat.
 */
export const HAT_ART: AccessoryArt[] = [
  { id: 0, key: '', name: 'None', w: 0, h: 0 },
  { id: 1, key: '__hat_1', name: 'Cap', w: HAT_W, h: HAT_H },
  { id: 2, key: '__hat_2', name: 'Top hat', w: HAT_W, h: HAT_H },
  { id: 3, key: '__hat_3', name: 'Helmet', w: HAT_W, h: HAT_H },
  { id: 4, key: '__hat_4', name: 'Crown', w: HAT_W, h: HAT_H },
  { id: 5, key: '__hat_5', name: 'Cowboy', w: HAT_W, h: HAT_H },
]

/** Ids are the wire values (`glasses_id`); id 0 is bare-faced. */
export const GLASSES_ART: AccessoryArt[] = [
  { id: 0, key: '', name: 'None', w: 0, h: 0 },
  { id: 1, key: '__glasses_1', name: 'Shades', w: GLASSES_W, h: GLASSES_H },
  { id: 2, key: '__glasses_2', name: 'Round', w: GLASSES_W, h: GLASSES_H },
  { id: 3, key: '__glasses_3', name: 'Visor', w: GLASSES_W, h: GLASSES_H },
]

const BOOT_W = 20
const BOOT_H = 4

/**
 * T21.02's ironman boots. **One pair, not a picker** — they are an item you find
 * rather than an appearance you choose, so there is no id and no "none" row.
 */
export function bootArt(): AccessoryArt {
  return { id: 0, key: '__boots_ironman', name: 'Ironman Boots', w: BOOT_W, h: BOOT_H }
}

/**
 * Red and yellow, as asked — **and wider than the leg, which is the half that
 * makes them visible.** `tombstoneTextures` states the rule these follow: at
 * `PLAYER_W` 16 a variant that differs only in palette differs in nothing a
 * player can read, so the sole overhangs and the outline of the body changes.
 */
export function ensureBootTexture(textures: Phaser.Textures.TextureManager): void {
  draw(textures, bootArt(), (c) => {
    // Two boots, a pixel apart, so the pair reads as feet rather than a block.
    // **The canvas is deliberately wide and shallow (20x4).** The scale is set
    // by width, so the art's aspect ratio *is* the drawn height — a squarer
    // canvas produced boots three times too tall that covered the shorts. Two
    // boots at x=2 and x=11 land on the legs rather than flanking them.
    for (const x of [2, 11]) {
      c.fillStyle = BOOT_RED
      c.fillRect(x + 1, 0, 5, 2) // upper, over the ankle
      c.fillStyle = BOOT_YELLOW
      c.fillRect(x, 2, 7, 2) // sole, overhanging the upper on both sides
    }
  })
}

/** Art for a hat id, falling back to "none" (`docs/50` §8). */
export function hatArt(id: number): AccessoryArt {
  return HAT_ART[id] ?? HAT_ART[0]!
}

/** Art for a glasses id, falling back to "none". */
export function glassesArt(id: number): AccessoryArt {
  return GLASSES_ART[id] ?? GLASSES_ART[0]!
}

type Ctx = CanvasRenderingContext2D

const BRIM = '#2a2f36'
const FELT = '#3b424b'
const RED = '#b4453a'
const STEEL = '#7d8892'
/** T21.02, and the brief names both: *"make them red and yellow"*. */
const BOOT_RED = '#c8322a'
const BOOT_YELLOW = '#f0c020'
const GOLD = '#d9a521'
const LENS = '#101418'
const GLASS = '#2f6fb0'

function draw(
  textures: Phaser.Textures.TextureManager,
  art: AccessoryArt,
  paint: (ctx: Ctx) => void,
): void {
  if (!art.key || textures.exists(art.key)) return
  const tex = textures.createCanvas(art.key, art.w, art.h)
  const ctx = tex?.getContext()
  if (!ctx) return
  ctx.clearRect(0, 0, art.w, art.h)
  paint(ctx)
  tex?.refresh()
}

/**
 * Generate every accessory texture once. Idempotent — `createCanvas` is skipped
 * when the key exists, so the menu, the picker and the game share one set rather
 * than leaking a parallel one per scene.
 */
export function ensureAccessoryTextures(textures: Phaser.Textures.TextureManager): void {
  // --- hats. Each one is a different outline at 14x9. -----------------------

  // 1 — Cap: a low crown and a brim that sticks out one side only. The
  // asymmetry is deliberate; it is what makes the flip visible.
  draw(textures, HAT_ART[1]!, (c) => {
    c.fillStyle = RED
    c.fillRect(3, 3, 8, 4)
    c.fillRect(4, 2, 6, 1)
    c.fillStyle = BRIM
    c.fillRect(9, 6, 5, 2)
  })

  // 2 — Top hat: tall and narrow on a wide flat brim. The silhouette nobody can
  // confuse with anything else here.
  draw(textures, HAT_ART[2]!, (c) => {
    c.fillStyle = FELT
    c.fillRect(4, 0, 6, 6)
    c.fillStyle = RED
    c.fillRect(4, 4, 6, 1)
    c.fillStyle = BRIM
    c.fillRect(1, 6, 12, 2)
  })

  // 3 — Helmet: a dome that wraps down past the ears, with no brim at all.
  draw(textures, HAT_ART[3]!, (c) => {
    c.fillStyle = STEEL
    c.fillRect(3, 3, 8, 5)
    c.fillRect(4, 2, 6, 1)
    c.fillRect(2, 5, 1, 3)
    c.fillRect(11, 5, 1, 3)
    c.fillStyle = '#aeb7c0'
    c.fillRect(6, 2, 2, 5)
  })

  // 4 — Crown: three points and a band. All negative space above the band, which
  // is the opposite of every other option here.
  draw(textures, HAT_ART[4]!, (c) => {
    c.fillStyle = GOLD
    c.fillRect(3, 5, 8, 3)
    c.fillRect(3, 2, 2, 3)
    c.fillRect(6, 1, 2, 4)
    c.fillRect(9, 2, 2, 3)
  })

  // 5 — Cowboy: the widest brim in the set, curled up at both ends.
  draw(textures, HAT_ART[5]!, (c) => {
    c.fillStyle = '#8a6a3d'
    c.fillRect(4, 2, 6, 4)
    c.fillStyle = '#6a5030'
    c.fillRect(0, 6, 14, 2)
    c.fillRect(0, 5, 2, 1)
    c.fillRect(12, 5, 2, 1)
  })

  // --- sunglasses, at 12x4. ------------------------------------------------

  // 1 — Shades: two solid rectangles and a bridge. The default "sunglasses".
  draw(textures, GLASSES_ART[1]!, (c) => {
    c.fillStyle = LENS
    c.fillRect(0, 0, 5, 3)
    c.fillRect(7, 0, 5, 3)
    c.fillRect(5, 1, 2, 1)
  })

  // 2 — Round: two circles, so the outline is not a rectangle.
  draw(textures, GLASSES_ART[2]!, (c) => {
    c.fillStyle = GLASS
    c.beginPath()
    c.arc(2.5, 2, 2.2, 0, Math.PI * 2)
    c.arc(9.5, 2, 2.2, 0, Math.PI * 2)
    c.fill()
    c.fillStyle = GOLD
    c.fillRect(4, 2, 4, 1)
  })

  // 3 — Visor: one unbroken band across the whole face, no bridge.
  draw(textures, GLASSES_ART[3]!, (c) => {
    c.fillStyle = '#1d2b3a'
    c.fillRect(0, 0, 12, 3)
    c.fillStyle = '#4da3e8'
    c.fillRect(1, 1, 10, 1)
  })
}
