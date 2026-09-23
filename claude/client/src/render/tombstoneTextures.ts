/**
 * Tombstone art (`docs/71-amendments-v3.md` §B8), drawn procedurally.
 *
 * Same reasoning as `weaponTextures.ts`: none of the vendored Kenney packs has
 * a grave marker, and `docs/51` §5's procedural fallback is the shipping path
 * for anything they do not cover. Picking a terrain tile that vaguely reads as
 * a headstone is the mistake §A32 already caught here — two decor frames turned
 * out to be 98 % opaque terrain tiles standing on the ground — and
 * `verify-assets` now rejects it.
 *
 * Five markers, chosen to differ in **silhouette** rather than in palette. A
 * skin picker whose options differ only by colour is a picker with one option,
 * and at 14 × 18 world px the outline is all the player can read.
 *
 * Drawn at native size: the game renders `pixelArt`, so these scale up crisply
 * and drawing them larger would only blur under NEAREST.
 */

import Phaser from 'phaser'

export interface TombstoneArt {
  id: number
  key: string
  name: string
}

const W = 14
const H = 18

/** Ids are the wire values (`tombstone_skin_id`), so this order is not cosmetic. */
export const TOMBSTONE_ART: TombstoneArt[] = [
  { id: 0, key: '__tombstone_0', name: 'Headstone' },
  { id: 1, key: '__tombstone_1', name: 'Cross' },
  { id: 2, key: '__tombstone_2', name: 'Obelisk' },
  { id: 3, key: '__tombstone_3', name: 'Cracked slab' },
  { id: 4, key: '__tombstone_4', name: 'Cairn' },
]

/** Art for a tombstone skin id, falling back to id 0 (`docs/50` §8). */
export function tombstoneArt(skinId: number): TombstoneArt {
  return TOMBSTONE_ART[skinId] ?? TOMBSTONE_ART[0]!
}

type Ctx = CanvasRenderingContext2D

const STONE = '#8d949c'
const STONE_DARK = '#5f666e'
const STONE_LIGHT = '#b6bcc2'
const EARTH = '#4a3f34'

function draw(
  textures: Phaser.Textures.TextureManager,
  key: string,
  paint: (ctx: Ctx) => void,
): void {
  if (textures.exists(key)) return
  const tex = textures.createCanvas(key, W, H)
  const ctx = tex?.getContext()
  if (!ctx) return
  ctx.clearRect(0, 0, W, H)
  paint(ctx)
  // Every marker stands on a sliver of turned earth, which is what stops them
  // reading as objects floating a pixel above the ground.
  ctx.fillStyle = EARTH
  ctx.fillRect(1, H - 2, W - 2, 2)
  tex?.refresh()
}

/**
 * Generate every tombstone texture once. Idempotent — `createCanvas` is skipped
 * when the key exists, so the menu and the game share one set rather than
 * leaking a parallel one per scene.
 */
export function ensureTombstoneTextures(textures: Phaser.Textures.TextureManager): void {
  // 0 — Headstone: the round-topped slab everyone pictures. The default, so it
  // has to be the most legible silhouette of the five.
  draw(textures, TOMBSTONE_ART[0]!.key, (ctx) => {
    ctx.fillStyle = STONE
    ctx.beginPath()
    ctx.arc(7, 6, 5, Math.PI, 0)
    ctx.fill()
    ctx.fillRect(2, 6, 10, 10)
    ctx.fillStyle = STONE_LIGHT
    ctx.fillRect(3, 7, 2, 8) // lit edge
    ctx.fillStyle = STONE_DARK
    ctx.fillRect(9, 7, 2, 8) // shaded edge
    ctx.fillRect(5, 9, 4, 1) // an inscription mark, not letters — 4 px of text
    ctx.fillRect(5, 11, 4, 1) //   would be noise at this size
  })

  // 1 — Cross: the only one whose silhouette is not a solid block, which is what
  // makes it readable at a glance next to the others.
  draw(textures, TOMBSTONE_ART[1]!.key, (ctx) => {
    ctx.fillStyle = STONE
    ctx.fillRect(5, 1, 4, 15) // upright
    ctx.fillRect(1, 5, 12, 3) // arms
    ctx.fillStyle = STONE_LIGHT
    ctx.fillRect(5, 1, 1, 15)
    ctx.fillRect(1, 5, 12, 1)
    ctx.fillStyle = STONE_DARK
    ctx.fillRect(8, 2, 1, 14)
  })

  // 2 — Obelisk: tall and tapered, so it reads as *taller* than the rest even
  // though every marker is the same 18 px box.
  draw(textures, TOMBSTONE_ART[2]!.key, (ctx) => {
    ctx.fillStyle = STONE
    ctx.beginPath()
    ctx.moveTo(7, 0)
    ctx.lineTo(10, 5)
    ctx.lineTo(10, 16)
    ctx.lineTo(4, 16)
    ctx.lineTo(4, 5)
    ctx.closePath()
    ctx.fill()
    ctx.fillStyle = STONE_LIGHT
    ctx.fillRect(5, 5, 2, 11)
    ctx.fillStyle = STONE_DARK
    ctx.fillRect(8, 5, 2, 11)
    ctx.fillStyle = STONE_DARK
    ctx.fillRect(3, 15, 8, 2) // plinth
  })

  // 3 — Cracked slab: leaning, with a broken corner. The one that reads as an
  // *old* grave, so a long round's graveyard has variety in it.
  draw(textures, TOMBSTONE_ART[3]!.key, (ctx) => {
    ctx.save()
    ctx.translate(7, 16)
    ctx.rotate(-0.14)
    ctx.translate(-7, -16)
    ctx.fillStyle = STONE
    ctx.fillRect(3, 4, 9, 12)
    ctx.fillStyle = STONE_LIGHT
    ctx.fillRect(3, 4, 2, 12)
    ctx.fillStyle = STONE_DARK
    ctx.fillRect(10, 5, 2, 11)
    // The break: a notch out of the top-right, and a crack running down.
    ctx.clearRect(9, 4, 3, 3)
    ctx.fillStyle = STONE_DARK
    ctx.fillRect(6, 7, 1, 4)
    ctx.fillRect(7, 11, 1, 3)
    ctx.restore()
  })

  // 4 — Cairn: stacked stones, no slab at all. The furthest from the others in
  // outline, which is what earns it a slot in a five-option picker.
  draw(textures, TOMBSTONE_ART[4]!.key, (ctx) => {
    const stones: [number, number, number, number][] = [
      [2, 12, 10, 4],
      [3, 8, 8, 4],
      [4, 5, 6, 3],
      [5, 2, 4, 3],
    ]
    for (const [x, y, w, h] of stones) {
      ctx.fillStyle = STONE
      ctx.fillRect(x, y, w, h)
      ctx.fillStyle = STONE_LIGHT
      ctx.fillRect(x, y, w, 1)
      ctx.fillStyle = STONE_DARK
      ctx.fillRect(x, y + h - 1, w, 1)
    }
  })
}
