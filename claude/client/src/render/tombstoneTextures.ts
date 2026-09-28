/**
 * The grave marker (`docs/71-amendments-v3.md` §B8), drawn procedurally — **one ink stone** (T23.15, R8).
 *
 * The tombstone picker went with the wearables: every grave is the same round-topped headstone, drawn in the look's
 * ink (`look/actors/draw.ts::INK`, the figures' line colour) so it belongs to the world the stick figures stand in.
 * The wire still carries `tombstone_skin_id` (the server and replays are unchanged); nothing here reads it.
 */

import Phaser from 'phaser'
import { INK } from '../look/actors/draw'

/** The one tombstone texture's key. */
export const TOMBSTONE_KEY = '__tombstone_ink'

const W = 14
const H = 18

/**
 * Generate the tombstone texture once. Idempotent — `createCanvas` is skipped when the key exists, so every scene
 * shares one rather than leaking a copy per scene.
 */
export function ensureTombstoneTexture(textures: Phaser.Textures.TextureManager): void {
  if (textures.exists(TOMBSTONE_KEY)) return
  const tex = textures.createCanvas(TOMBSTONE_KEY, W, H)
  const ctx = tex?.getContext()
  if (!ctx) return
  ctx.clearRect(0, 0, W, H)
  ctx.fillStyle = INK
  ctx.beginPath()
  ctx.arc(7, 6, 5, Math.PI, 0)
  ctx.fill()
  ctx.fillRect(2, 6, 10, 10)
  // The ground line it stands on, a pixel wider each side: it reads as planted, not floating.
  ctx.fillRect(0, H - 2, W, 2)
  tex?.refresh()
}
