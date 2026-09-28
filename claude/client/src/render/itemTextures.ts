/**
 * Ground icons for the v3 arsenal (§B20).
 *
 * Eighteen registry entries referenced sprite keys that existed nowhere, fell
 * back to placeholders per `docs/50` §8 — correct behaviour, and exactly why
 * nobody noticed — and so **every new weapon looked identical on the ground**.
 * In a game whose pitch is "tons of weapons", a pickup you cannot identify is
 * the feature not working.
 *
 * Drawn procedurally, following the precedent `weaponTextures.ts` set: Kenney's
 * packs have no side-view laser SMG or whip at 16 px, and `docs/51` §5 makes the
 * procedural path the shipping one for anything the packs do not cover.
 *
 * **Distinct by silhouette, not by palette.** At 16 px on the ground the outline
 * is all a player can read — the same conclusion T10.05 reached for tombstones.
 * Two icons that differ only in hue are two icons nobody can tell apart.
 */

import Phaser from 'phaser'
import { ICON_RES, ICON_SPRITES, PICKUP_S, litWeapon, pickupScale } from '../look/actors/icons'

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

  // T23.16: the firearms' icons are their held drawings (`look/actors/icons.ts`), drawn below — not painted here.


  // --- melee ----------------------------------------------------------------
  //
  // §F5 retired knife, bat, whip, axe and hammer, and their painters **stay**:
  // the registry keeps them as placeholders (removing an `ItemDef` renumbers
  // every id above it, which is §B16), and `itemSprites-math.test.ts`'s "the
  // live registry has art for everything" reads that registry, so deleting the
  // art here fails on five entries that still resolve. They are unobtainable,
  // not absent.
  //
  // The shovel is the one anybody sees: everyone spawns holding it.
  weapon_shovel: (c) => {
    c.fillStyle = '#6b4a2c'
    c.fillRect(7, 2, 2, 8) // haft
    c.fillRect(5, 1, 6, 2) // T-grip — no other melee icon has one
    c.fillStyle = '#b9c2cc'
    c.beginPath() // a wide scoop, where the axe has a bit off one side
    c.moveTo(4, 9)
    c.lineTo(12, 9)
    c.lineTo(10, 15)
    c.lineTo(6, 15)
    c.closePath()
    c.fill()
  },
  weapon_knife: (c) => {
    c.fillStyle = '#d6dde6'
    c.beginPath()
    c.moveTo(3, 12)
    c.lineTo(11, 4)
    c.lineTo(13, 6)
    c.lineTo(5, 13)
    c.closePath()
    c.fill()
    c.fillStyle = '#5a4632'
    c.fillRect(2, 11, 4, 3)
  },
  weapon_bat: (c) => {
    c.fillStyle = '#c79a5c'
    c.beginPath() // tapered club
    c.moveTo(3, 13)
    c.lineTo(10, 3)
    c.lineTo(13, 5)
    c.lineTo(5, 14)
    c.closePath()
    c.fill()
  },
  weapon_whip: (c) => {
    c.strokeStyle = '#6b4a2c' // a curve, which nothing else here is
    c.lineWidth = 2
    c.beginPath()
    c.moveTo(2, 12)
    c.quadraticCurveTo(9, 12, 8, 6)
    c.quadraticCurveTo(7, 2, 13, 3)
    c.stroke()
  },
  weapon_axe: (c) => {
    c.fillStyle = '#6b4a2c'
    c.fillRect(7, 3, 2, 11) // haft
    c.fillStyle = '#b9c2cc'
    c.beginPath() // single bit
    c.moveTo(9, 3)
    c.lineTo(14, 5)
    c.lineTo(9, 9)
    c.closePath()
    c.fill()
  },
  weapon_hammer: (c) => {
    c.fillStyle = '#6b4a2c'
    c.fillRect(7, 5, 2, 10)
    c.fillStyle = '#8f98a4'
    c.fillRect(3, 2, 10, 4) // wide flat head
  },

  // --- the rest -------------------------------------------------------------
  weapon_mine: (c) => {
    c.fillStyle = '#333a44'
    c.beginPath() // squat dome, unlike any grenade
    c.arc(8, 11, 5.5, Math.PI, 0)
    c.fill()
    c.fillRect(2, 11, 12, 2)
    c.fillStyle = '#ff4040'
    c.fillRect(7, 4, 2, 2) // sensor
  },
  weapon_airburst: (c) => {
    c.fillStyle = '#3a4a3a'
    c.beginPath()
    c.arc(8, 9, 4.5, 0, Math.PI * 2)
    c.fill()
    c.strokeStyle = '#57d6ff' // downward fan, its whole behaviour
    c.lineWidth = 1
    for (const dx of [-3, 0, 3]) {
      c.beginPath()
      c.moveTo(8, 13)
      c.lineTo(8 + dx, 15)
      c.stroke()
    }
  },
  weapon_smoke: (c) => {
    c.fillStyle = '#4a5058'
    c.fillRect(6, 8, 4, 6) // canister
    c.fillStyle = '#b9c0c8'
    for (const [x, y, r] of [
      [6, 5, 2.4],
      [10, 4, 2],
      [8, 3, 1.8],
    ] as const) {
      c.beginPath()
      c.arc(x, y, r, 0, Math.PI * 2)
      c.fill()
    }
  },
  weapon_molotov: (c) => {
    c.fillStyle = '#7a5a2a' // bottle: a neck, which no other icon has
    c.fillRect(6, 6, 5, 8)
    c.fillRect(7, 3, 3, 3)
    c.fillStyle = '#ff9a3a'
    c.fillRect(7, 1, 3, 2) // rag alight
  },
  weapon_toxic: (c) => {
    c.fillStyle = '#3a4a2a'
    c.beginPath()
    c.arc(8, 9, 4.5, 0, Math.PI * 2)
    c.fill()
    c.fillStyle = '#7fe04a'
    for (const a of [0, 2.1, 4.2]) {
      c.beginPath() // trefoil
      c.moveTo(8, 9)
      c.arc(8, 9, 4, a, a + 0.9)
      c.closePath()
      c.fill()
    }
  },

  // --- M21's effect items: silhouette first, colour second -----------------
  //
  // A pair of fangs, drawn as two downward tapers under a dark upper lip. No
  // other icon here is two thin vertical spikes, which is the property that
  // makes it readable at 16 px on the ground — the same rule `tombstoneTextures`
  // states and `weapon_molotov`'s neck follows.
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
