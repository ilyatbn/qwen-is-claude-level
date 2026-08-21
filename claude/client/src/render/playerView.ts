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
import {
  deriveAnimState,
  facingLeft,
  walkFrameMs,
  type AnimInputs,
  type AnimState,
} from './playerView-math'
import { skins } from './assets'
import { ensureWeaponTextures, weaponArt } from './weaponTextures'
import {
  animKey,
  framesFor,
  parseTint,
  resolveSkin,
  spriteScale,
  type SkinDef,
} from './skins-math'

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

/**
 * Register one Phaser animation per (skin, state), once per scene.
 *
 * Animations are global to the scene's anim manager, so creating them per
 * PlayerView would either warn on every join or silently keep the first one.
 * The key is derived from the skin id, so two players on the same skin share.
 */
function ensureAnims(scene: Phaser.Scene, skin: SkinDef): void {
  const states: AnimState[] = ['idle', 'walk', 'jump', 'fall', 'jetpack', 'hurt', 'dead']
  for (const state of states) {
    const key = animKey(skin, state)
    if (scene.anims.exists(key)) continue
    const names = framesFor(skin, state)
    if (names.length === 0) continue
    scene.anims.create({
      key,
      frames: names.map((frame) => ({ key: skin.atlas, frame })),
      frameRate: state === 'walk' ? 9 : state === 'jetpack' ? 12 : 1,
      repeat: names.length > 1 ? -1 : 0,
    })
  }
}

export class PlayerView {
  readonly container: Phaser.GameObjects.Container
  private readonly body: Phaser.GameObjects.Sprite
  private weapon: Phaser.GameObjects.Image | Phaser.GameObjects.Rectangle
  private weaponKey = ''
  private readonly shieldBubble: Phaser.GameObjects.Arc
  private readonly nameLabel: Phaser.GameObjects.Text
  private readonly skinId: number
  private animState: AnimState = 'idle'
  private readonly skinDef: SkinDef | null
  /** Null when running on placeholders — every draw path checks it. */
  private readonly usingAtlas: boolean

  /** Fallback anchor when no registry says otherwise. */
  private static readonly ANCHOR_Y = 0.9

  /**
   * Is this drawing real art, or the placeholder box?
   *
   * Exposed because §B12 was exactly this distinction being invisible: the
   * attract bots were routed through this class and still drew rectangles,
   * because the atlas was never loaded. A check that asserts on the picture
   * needs to be able to ask.
   */
  get usesAtlas(): boolean {
    return this.usingAtlas
  }

  /**
   * The atlas frame on screen right now.
   *
   * For the same reason as `usesAtlas`: §B3 asks the skins preview to run the
   * *walk* cycle, because a still frame hides skins that differ only by palette
   * — and "is it animating" is not answerable from the outside without this.
   */
  get currentFrame(): string {
    return String(this.body.frame?.name ?? '')
  }

  private readonly scene: Phaser.Scene

  constructor(scene: Phaser.Scene, skinId: number) {
    const c = C()
    this.skinId = skinId
    this.skinDef = resolveSkin(skins(), skinId)

    // The registry can resolve while the atlas never loaded — a 404, or a
    // checkout that has not run build-atlas. Both must reach the placeholder,
    // so the test is "is the texture actually here", not "did the JSON parse".
    this.usingAtlas = !!this.skinDef && scene.textures.exists(this.skinDef.atlas)

    const anchorY = this.skinDef?.anchor.y ?? PlayerView.ANCHOR_Y
    if (this.usingAtlas && this.skinDef) {
      ensureAnims(scene, this.skinDef)
      const first = framesFor(this.skinDef, 'idle')[0]
      this.body = scene.add.sprite(0, 0, this.skinDef.atlas, first).setOrigin(0.5, anchorY)
      const h = this.body.height || c.PLAYER_H
      this.body.setScale(spriteScale(h, c.PLAYER_H))
      const tint = parseTint(this.skinDef.tint)
      if (tint !== undefined) this.body.setTint(tint)
      this.body.play(animKey(this.skinDef, 'idle'), true)
    } else {
      const key = placeholderTexture(scene.textures, skinId, `char_${skinId}_idle`)
      this.body = scene.add.sprite(0, 0, key).setOrigin(0.5, anchorY)
    }

    ensureWeaponTextures(scene.textures)
    // Starts as the generic bar and is replaced by `setWeapon` the moment the
    // HUD knows what is selected — a player holding nothing still needs a hand.
    this.weapon = scene.add.rectangle(0, -c.PLAYER_H * 0.35, 14, 4, 0x2a2f36).setOrigin(0, 0.5)
    this.scene = scene

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
    const next = deriveAnimState(inputs)
    if (next !== this.animState) {
      this.animState = next
      if (this.usingAtlas && this.skinDef) this.body.play(animKey(this.skinDef, next), true)
    }

    // The walk cycle tracks speed, so a slowed player visibly trudges rather
    // than moon-walking (`docs/50` §3).
    if (this.usingAtlas && this.animState === 'walk' && this.body.anims.currentAnim) {
      const ms = walkFrameMs(vx, C().WALK_SPEED)
      this.body.anims.msPerFrame = ms
    }

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

  /**
   * Swap the held weapon sprite.
   *
   * `docs/50` §4: the sprite rotates around its `pivot` to the aim angle, and
   * `muzzle` is where the flash is drawn — cosmetic, and deliberately
   * independent of the server's `MUZZLE_OFFSET`, so art can be adjusted without
   * touching gameplay.
   */
  setWeapon(key: string): void {
    if (key === this.weaponKey) return
    this.weaponKey = key
    const art = weaponArt(key)
    const c = C()
    const idx = this.container.getIndex(this.weapon)
    this.weapon.destroy()
    if (art && this.scene.textures.exists(art.key)) {
      this.weapon = this.scene.add
        .image(0, -c.PLAYER_H * 0.35, art.key)
        .setOrigin(art.pivot.x, art.pivot.y)
    } else {
      this.weapon = this.scene.add
        .rectangle(0, -c.PLAYER_H * 0.35, 14, 4, 0x2a2f36)
        .setOrigin(0, 0.5)
    }
    this.container.addAt(this.weapon, Math.max(0, idx))
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
