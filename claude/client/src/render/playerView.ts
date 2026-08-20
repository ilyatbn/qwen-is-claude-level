/**
 * One player on screen: body, weapon and overlays in a container
 * (`docs/50-sprites-skins.md` §3).
 *
 * **Every texture lookup falls back to a generated placeholder** (§8). There is no
 * art until M7, so a hard failure on a missing key would make M3–M6 unrunnable.
 * The fallback logs once per key, so missing art is obvious without being noisy.
 */

import Phaser from 'phaser'
import { C } from '../core'
import { deriveAnimState, facingLeft, type AnimInputs, type AnimState } from './playerView-math'

export type { AnimState, AnimInputs }
export { deriveAnimState, facingLeft }

export interface PlayerFlags {
  alive: boolean
  grounded: boolean
  jetpack: boolean
  shield: boolean
  iframes: boolean
}

/** Skin id → placeholder tint, until `skins.json` lands in T7.03. */
const SKIN_TINTS = [0xff30c0, 0x36c2f0, 0x7ae04a, 0xf0b429, 0xa46bf5, 0xf05a4a]

const warned = new Set<string>()

/**
 * A texture key that is guaranteed to exist. Generates a `PLAYER_W × PLAYER_H`
 * rectangle the first time a key is missing and logs once.
 */
export function placeholderTexture(
  textures: Phaser.Textures.TextureManager,
  skinId: number,
  wantedKey: string,
): string {
  if (textures.exists(wantedKey)) return wantedKey

  if (!warned.has(wantedKey)) {
    warned.add(wantedKey)
    console.warn(`[skins] missing frame "${wantedKey}" — using a placeholder`)
  }

  const key = `__placeholder_player_${skinId}`
  if (!textures.exists(key)) {
    const c = C()
    const tint = SKIN_TINTS[skinId % SKIN_TINTS.length] ?? 0xff30c0
    const tex = textures.createCanvas(key, c.PLAYER_W, c.PLAYER_H)
    const ctx = tex?.getContext()
    if (ctx) {
      ctx.fillStyle = `#${tint.toString(16).padStart(6, '0')}`
      ctx.fillRect(0, 0, c.PLAYER_W, c.PLAYER_H)
      // A darker band at the feet, so facing and ground contact are legible even
      // as a flat rectangle.
      ctx.fillStyle = 'rgba(0,0,0,.35)'
      ctx.fillRect(0, c.PLAYER_H - 4, c.PLAYER_W, 4)
      tex?.refresh()
    }
  }
  return key
}

/** Test seam: the placeholder warning is once *per process*, not per instance. */
export function resetPlaceholderWarnings(): void {
  warned.clear()
}

export class PlayerView {
  readonly container: Phaser.GameObjects.Container
  private readonly body: Phaser.GameObjects.Image
  private readonly weapon: Phaser.GameObjects.Rectangle
  private readonly shieldBubble: Phaser.GameObjects.Arc
  private readonly nameLabel: Phaser.GameObjects.Text
  private readonly skinId: number
  private animState: AnimState = 'idle'

  /** From the skin registry: feet at the bottom of the 16×28 AABB. */
  private static readonly ANCHOR_Y = 0.9

  constructor(scene: Phaser.Scene, skinId: number) {
    const c = C()
    this.skinId = skinId

    const key = placeholderTexture(scene.textures, skinId, `char_${skinId}_idle`)
    this.body = scene.add.image(0, 0, key).setOrigin(0.5, PlayerView.ANCHOR_Y)

    // Placeholder until T7.04 gives weapons real sprites and pivots.
    this.weapon = scene.add.rectangle(0, -c.PLAYER_H * 0.35, 14, 4, 0x2a2f36).setOrigin(0, 0.5)

    this.shieldBubble = scene.add
      .circle(0, -c.PLAYER_H * 0.4, c.PLAYER_H * 0.75, 0x54b6ff, 0.18)
      .setVisible(false)

    this.nameLabel = scene.add
      .text(0, -c.PLAYER_H - 6, '', { fontSize: '9px', color: '#dfe6ee' })
      .setOrigin(0.5, 1)

    this.container = scene.add.container(0, 0, [
      this.shieldBubble,
      this.body,
      this.weapon,
      this.nameLabel,
    ])
  }

  setState(
    x: number,
    y: number,
    vx: number,
    vy: number,
    aim: number,
    flags: PlayerFlags,
  ): void {
    const c = C()
    this.container.setPosition(x, y + c.PLAYER_H / 2)

    const inputs: AnimInputs = {
      alive: flags.alive,
      grounded: flags.grounded,
      jetpack: flags.jetpack,
      vx,
      vy,
    }
    this.animState = deriveAnimState(inputs)

    const left = facingLeft(aim)
    this.body.setFlipX(left)

    // The weapon rotates to the aim angle and is flipped **vertically** when
    // pointing left, not horizontally — the standard trick for a side-view aimed
    // weapon, otherwise it hangs upside down (`docs/50-sprites-skins.md` §4).
    this.weapon.setRotation(aim)
    this.weapon.setScale(1, left ? -1 : 1)

    this.shieldBubble.setVisible(flags.shield)

    // i-frames flash; dead is drawn faded rather than removed, so the corpse still
    // reads as a player during the respawn delay.
    const alpha = !flags.alive ? 0.35 : flags.iframes ? (Date.now() % 200 < 100 ? 0.4 : 1) : 1
    this.body.setAlpha(alpha)
  }

  get state(): AnimState {
    return this.animState
  }

  setName(name: string): void {
    this.nameLabel.setText(name)
  }

  setVisible(v: boolean): void {
    this.container.setVisible(v)
  }

  destroy(): void {
    // `true` destroys the children too; without it the body, weapon and label leak
    // for every player who ever joined.
    this.container.destroy(true)
  }

  get skin(): number {
    return this.skinId
  }
}
