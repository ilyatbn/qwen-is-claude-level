/**
 * Weapon sprites (`docs/50-sprites-skins.md` §4).
 *
 * Drawn procedurally rather than sourced. Kenney's packs have no side-view
 * bazooka, grenade or SMG at a usable size, and `docs/51` §5's procedural
 * fallback is the shipping path for anything the packs do not cover — a
 * generated silhouette that reads correctly beats a borrowed sprite that does
 * not, and it costs no download.
 *
 * These are drawn pointing **right** at their native scale. The renderer rotates
 * to the aim angle and flips **vertically** when aiming left, which is the
 * side-view convention: flipping horizontally would point the barrel backwards.
 */

import Phaser from 'phaser'

export interface WeaponArt {
  key: string
  /** Where the muzzle flash and trajectory preview start, in texture px. */
  muzzle: { x: number; y: number }
  /** Rotation origin, as a fraction of the texture. */
  pivot: { x: number; y: number }
}

const WEAPON_ART: Record<string, WeaponArt> = {
  bazooka: { key: '__weapon_bazooka', muzzle: { x: 30, y: 8 }, pivot: { x: 0.22, y: 0.5 } },
  grenade: { key: '__weapon_grenade', muzzle: { x: 14, y: 8 }, pivot: { x: 0.35, y: 0.5 } },
  smg: { key: '__weapon_smg', muzzle: { x: 26, y: 7 }, pivot: { x: 0.24, y: 0.5 } },
}

/** Art for a weapon key, or null when it has none (fists, or an unknown id). */
export function weaponArt(key: string): WeaponArt | null {
  return WEAPON_ART[key] ?? null
}

type Ctx = CanvasRenderingContext2D

function draw(
  textures: Phaser.Textures.TextureManager,
  key: string,
  w: number,
  h: number,
  paint: (ctx: Ctx) => void,
): void {
  if (textures.exists(key)) return
  const tex = textures.createCanvas(key, w, h)
  const ctx = tex?.getContext()
  if (!ctx) return
  ctx.clearRect(0, 0, w, h)
  paint(ctx)
  tex?.refresh()
}

/**
 * Generate every weapon texture once per scene.
 *
 * Cheap and idempotent — `createCanvas` is skipped when the key exists, so a
 * second scene reuses the first's textures rather than leaking a parallel set.
 */
export function ensureWeaponTextures(textures: Phaser.Textures.TextureManager): void {
  // Bazooka: a fat tube with a rear grip and a flared muzzle. Read at ~30 px
  // wide against a 28 px player, so the silhouette has to survive being small.
  draw(textures, WEAPON_ART.bazooka!.key, 34, 16, (ctx) => {
    ctx.fillStyle = '#3c4450'
    ctx.fillRect(4, 4, 26, 8)
    ctx.fillStyle = '#2a303a'
    ctx.fillRect(0, 6, 8, 5) // rear
    ctx.fillStyle = '#586372'
    ctx.fillRect(26, 2, 6, 12) // flared muzzle
    ctx.fillStyle = '#c2453a'
    ctx.fillRect(12, 5, 5, 2) // a warm stripe, so it is not a grey blob
    ctx.fillStyle = '#232830'
    ctx.fillRect(9, 11, 5, 4) // grip
  })

  // Grenade: a squat body with a lever, drawn round so it is obviously thrown
  // rather than fired.
  draw(textures, WEAPON_ART.grenade!.key, 16, 16, (ctx) => {
    ctx.fillStyle = '#3f5136'
    ctx.beginPath()
    ctx.arc(7, 9, 5.5, 0, Math.PI * 2)
    ctx.fill()
    ctx.fillStyle = '#2c3826'
    ctx.fillRect(5, 2, 4, 3) // neck
    ctx.fillStyle = '#8c8f95'
    ctx.fillRect(8, 1, 6, 2) // lever
  })

  // SMG: a short boxy frame with a magazine, visibly smaller than the bazooka.
  draw(textures, WEAPON_ART.smg!.key, 30, 16, (ctx) => {
    ctx.fillStyle = '#343a44'
    ctx.fillRect(2, 5, 20, 6)
    ctx.fillStyle = '#232830'
    ctx.fillRect(20, 6, 8, 3) // barrel
    ctx.fillRect(7, 10, 4, 6) // magazine
    ctx.fillRect(2, 9, 4, 5) // grip
    ctx.fillStyle = '#4d5665'
    ctx.fillRect(4, 3, 9, 2) // top rail
  })
}
