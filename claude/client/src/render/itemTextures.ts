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

  // --- ballistic: silhouettes differ by barrel length and grip --------------
  weapon_pistol: (c) => {
    c.fillStyle = '#3a424e'
    c.fillRect(3, 5, 8, 3) // short slide
    c.fillRect(4, 8, 3, 5) // grip
  },
  weapon_revolver: (c) => {
    c.fillStyle = '#4a525e'
    c.fillRect(3, 5, 9, 3)
    c.fillRect(4, 8, 3, 5)
    c.fillStyle = '#8a939e'
    c.beginPath() // the cylinder is the tell
    c.arc(7, 7, 2.6, 0, Math.PI * 2)
    c.fill()
  },
  weapon_deagle: (c) => {
    c.fillStyle = '#c8a24a' // heavier, and longer than a pistol
    c.fillRect(2, 4, 12, 4)
    c.fillStyle = '#5a4a24'
    c.fillRect(4, 8, 3, 6)
  },
  weapon_machinegun: (c) => {
    c.fillStyle = '#333a44'
    c.fillRect(1, 6, 13, 3) // long barrel
    c.fillRect(5, 9, 3, 4)
    c.fillStyle = '#6a7382'
    c.fillRect(8, 3, 4, 3) // box magazine on top
  },

  // --- energy: rounded, emissive, unmistakably not ballistic ----------------
  weapon_laser_pistol: (c) => {
    c.fillStyle = '#2a3a52'
    c.fillRect(3, 5, 8, 4)
    c.fillRect(4, 9, 3, 4)
    c.fillStyle = '#57d6ff'
    c.fillRect(10, 6, 4, 2) // emitter
  },
  weapon_laser_smg: (c) => {
    c.fillStyle = '#2a3a52'
    c.fillRect(2, 6, 11, 3)
    c.fillRect(5, 9, 3, 4)
    c.fillStyle = '#57d6ff'
    c.fillRect(12, 6, 3, 3)
    c.fillRect(4, 4, 5, 2) // coil
  },

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
  weapon_flamethrower: (c) => {
    c.fillStyle = '#4a3a2a'
    c.fillRect(2, 5, 9, 4)
    c.fillStyle = '#8a4a2a'
    c.fillRect(1, 3, 4, 8) // tank
    c.fillStyle = '#ff9a3a'
    c.fillRect(11, 6, 4, 2) // nozzle flame
  },
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
}

/** Sprite keys this module can draw. The check asserts against the registry. */
export function proceduralItemKeys(): string[] {
  return Object.keys(ART)
}

/**
 * Create every missing item texture once. Idempotent, and it never overwrites a
 * real atlas frame — packed art wins, and this is the fallback `docs/51` §5
 * describes.
 */
export function ensureItemTextures(textures: Phaser.Textures.TextureManager): void {
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
