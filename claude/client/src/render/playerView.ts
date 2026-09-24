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
  accessoryScale,
  accessoryY,
  animKey,
  BOOT_WIDTH_FRACTION,
  WING_WIDTH_FRACTION,
  GLASSES_WIDTH_FRACTION,
  HAT_WIDTH_FRACTION,
  framesFor,
  parseTint,
  resolveSkin,
  spriteScale,
  type SkinDef,
} from './skins-math'
import {
  bootArt,
  ensureAccessoryTextures,
  ensureBootTexture,
  ensureWingTexture,
  glassesArt,
  hatArt,
  wingArt,
} from './accessoryTextures'
import type { Appearance } from '../ui/skins'
import { bakeTintedAtlas } from './canvasTint'
import { hasWebGL } from './shaders'
import { ThrusterPlume } from './thrusterPlume'
import { plumeOn } from './thrusterPlume-math'

export type { AnimState, AnimInputs }
export { deriveAnimState, facingLeft }

export interface PlayerFlags {
  alive: boolean
  grounded: boolean
  jetpack: boolean
  shield: boolean
  iframes: boolean
  /**
   * T21.02's ironman boots.
   *
   * **A per-frame flag rather than a constructor field, deliberately.** T20.12's
   * accessories are `readonly` with no setter because a skin is chosen once, and
   * `GameScene` destroys and rebuilds a `PlayerView` whenever a remote leaves
   * the sampled set — which is why a hat has to be passed in at construction.
   * Boots are picked up and dropped mid-round, so a constructor field would be
   * stale the moment either happened *and* would vanish on the next rebuild.
   * Going through `setState` means it is re-read every frame from the snapshot
   * byte, and the rebuild problem cannot arise.
   */
  boots: boolean
  /**
   * T21.03's unicorn wings, drawn since T21.34. Per frame for the boots' reason,
   * and off the same move-mods byte, so a remote's wings show as well as yours.
   */
  wings: boolean
  /**
   * T22.04: the match is zero-g. **Required**, for `hatId`'s reason: a scene that
   * forgot it would compile and never draw a plume. With `jetpack` it decides the
   * thruster plume (`thrusterPlume-math.ts::plumeOn`) — there is no thrusting bit
   * on the wire, because bit 2 already is one in space.
   */
  space: boolean
  /**
   * T22.04C: the thrust being applied, px/s², when the scene knows it — **the local
   * player's**, off `Core.thrustAt` (the input the mirror stepped with) — or `null`:
   * a remote's input is not on the wire, so its plume stays on velocity. Required
   * for `space`'s reason: a scene that forgot it would compile and point the local
   * plume off velocity again.
   */
  thrust: { x: number; y: number } | null
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
function ensureAnims(scene: Phaser.Scene, skin: SkinDef, atlas: string): void {
  const states: AnimState[] = ['idle', 'walk', 'jump', 'fall', 'jetpack', 'hurt', 'dead']
  for (const state of states) {
    const key = animKey(skin, state)
    if (scene.anims.exists(key)) continue
    const names = framesFor(skin, state)
    if (names.length === 0) continue
    scene.anims.create({
      key,
      // `atlas`, not `skin.atlas` (T21.37): on Canvas a tinted skin plays its baked copy. The anim
      // key is per skin id and the renderer is fixed for the game, so the two never mix.
      frames: names.map((frame) => ({ key: atlas, frame })),
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
  /** T21.02. Built always, shown per frame — see `PlayerFlags.boots`. */
  private readonly boots: Phaser.GameObjects.Image | null
  /** T21.34. Built always, shown per frame — see `PlayerFlags.wings`. */
  private readonly wings: Phaser.GameObjects.Image | null
  /** T22.04. Built always, shown per frame — see `ThrusterPlume`. */
  private readonly plume: ThrusterPlume
  /** The drawn body's centre, in container units — where the plume's nozzle is measured from. */
  private readonly bodyCentreY: number
  private readonly nameLabel: Phaser.GameObjects.Text
  private readonly skinId: number
  /** §T20.12's accessories. `readonly` like `skinId`, for the same reason. */
  private readonly hatId: number
  private readonly glassesId: number
  private readonly hat: Phaser.GameObjects.Image | null
  private readonly glasses: Phaser.GameObjects.Image | null
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

  /**
   * `hatId` and `glassesId` are **required**, not optional, and that is the guard
   * (T20.12).
   *
   * They inherit `skinId`'s whole problem: this class is destroyed and rebuilt
   * repeatedly during a round — `GameScene` drops every remote absent from the
   * sampled set and reconstructs it on return — and every appearance field is
   * `readonly` with no setter, so a rebuild reads whatever the caller passes at
   * that moment. Optional parameters would let every existing call site compile
   * unchanged and draw a bare head, which is the same defect §B9 already cost a
   * milestone. Required means the compiler names the caller that forgot.
   */
  constructor(scene: Phaser.Scene, skinId: number, hatId: number, glassesId: number) {
    const c = C()
    this.skinId = skinId
    this.hatId = hatId
    this.glassesId = glassesId
    this.skinDef = resolveSkin(skins(), skinId)

    // The registry can resolve while the atlas never loaded — a 404, or a
    // checkout that has not run build-atlas. Both must reach the placeholder,
    // so the test is "is the texture actually here", not "did the JSON parse".
    this.usingAtlas = !!this.skinDef && scene.textures.exists(this.skinDef.atlas)

    const anchorY = this.skinDef?.anchor.y ?? PlayerView.ANCHOR_Y
    if (this.usingAtlas && this.skinDef) {
      // T21.37: a skin's tint is its identity (skin 5 is skin 0's frames in red). WebGL tints in
      // the shader; **Canvas has no sprite tint**, so there the frames come from a copy baked in
      // the tint, or the red Recruit draws as the plain one.
      const tint = parseTint(this.skinDef.tint)
      const webgl = hasWebGL(scene)
      const atlas =
        tint !== undefined && !webgl ? bakeTintedAtlas(scene.textures, this.skinDef.atlas, tint) : this.skinDef.atlas
      ensureAnims(scene, this.skinDef, atlas)
      const first = framesFor(this.skinDef, 'idle')[0]
      this.body = scene.add.sprite(0, 0, atlas, first).setOrigin(0.5, anchorY)
      const h = this.body.height || c.PLAYER_H
      this.body.setScale(spriteScale(h, c.PLAYER_H))
      if (tint !== undefined && webgl) this.body.setTint(tint)
      this.body.play(animKey(this.skinDef, 'idle'), true)
    } else {
      const key = placeholderTexture(scene.textures, skinId, `char_${skinId}_idle`)
      this.body = scene.add.sprite(0, 0, key).setOrigin(0.5, anchorY)
    }

    ensureWeaponTextures(scene.textures)
    // Starts as the generic bar and is replaced by `setWeapon` the moment the
    // HUD knows what is selected — a player holding nothing still needs a hand.
    // **The placeholder bar is gone** (owner, 2026-09-16, from play: *"still
    // seeing the black bar coming out of the character. if irrelevant for your
    // debugging purposes remove it."*). It was never a debug aid — it was the
    // stand-in for a weapon with no art, and since only three weapons have any
    // (`weaponTextures.ts`), it is what every player held all the time.
    //
    // An empty, zero-sized rectangle rather than a `null` weapon: `setState`
    // rotates and scales this every frame and `setWeapon` swaps it by index, so
    // keeping the slot filled is what stops both of them growing a null check
    // each. It draws nothing because it has no size and no fill alpha.
    this.weapon = scene.add.rectangle(0, -c.PLAYER_H * 0.35, 0, 0, 0, 0).setOrigin(0, 0.5)
    this.scene = scene

    this.shieldBubble = scene.add
      .circle(0, -c.PLAYER_H * 0.4, c.PLAYER_H * 0.75, 0x54b6ff, 0.18)
      .setVisible(false)

    this.nameLabel = scene.add
      .text(0, -c.PLAYER_H - 6, '', { fontSize: '9px', color: '#dfe6ee' })
      .setOrigin(0.5, 1)

    // Accessories, over the body and under the label (T20.12). Positioned from
    // the **drawn** height through `accessoryY`, which lives beside
    // `spriteScale` because the two answer the same question — see its comment.
    ensureAccessoryTextures(scene.textures)
    const drawn = this.body.displayHeight || c.PLAYER_H
    const hatDef = hatArt(hatId)
    const glassesDef = glassesArt(glassesId)
    // A hat is anchored by its **bottom** so it perches above the head; the
    // glasses are centred across the face. See `accessoryY` for why the two must
    // not share a band.
    this.hat = hatDef.key
      ? scene.add
          .image(0, accessoryY(drawn, anchorY, 'hat'), hatDef.key)
          .setOrigin(0.5, 1)
          .setScale(accessoryScale(hatDef.w, c.PLAYER_W, HAT_WIDTH_FRACTION))
      : null
    this.glasses = glassesDef.key
      ? scene.add
          .image(0, accessoryY(drawn, anchorY, 'glasses'), glassesDef.key)
          .setOrigin(0.5, 0.5)
          .setScale(accessoryScale(glassesDef.w, c.PLAYER_W, GLASSES_WIDTH_FRACTION))
      : null

    // T21.02's boots, at the feet. Built unconditionally like `shieldBubble`
    // and toggled in `setState`, so picking a pair up mid-round shows them
    // without a rebuild.
    ensureBootTexture(scene.textures)
    const bootDef = bootArt()
    this.boots = bootDef.key
      ? scene.add
          .image(0, accessoryY(drawn, anchorY, 'boots'), bootDef.key)
          .setOrigin(0.5, 1)
          .setScale(accessoryScale(bootDef.w, this.body.displayWidth || c.PLAYER_W, BOOT_WIDTH_FRACTION))
          .setVisible(false)
      : null

    // T21.34's wings, at the shoulders and **behind** the body: the torso covers
    // the middle of the canvas and only the tips past it show, which is what
    // makes them wings on a back rather than a sticker on a chest.
    ensureWingTexture(scene.textures)
    const wingDef = wingArt()
    this.wings = wingDef.key
      ? scene.add
          .image(0, accessoryY(drawn, anchorY, 'wings'), wingDef.key)
          .setOrigin(0.5, 0.5)
          .setScale(accessoryScale(wingDef.w, this.body.displayWidth || c.PLAYER_W, WING_WIDTH_FRACTION))
          .setVisible(false)
      : null

    this.container = scene.add.container(0, 0, [
      this.shieldBubble,
      ...(this.wings ? [this.wings] : []),
      this.body,
      ...(this.boots ? [this.boots] : []),
      ...(this.hat ? [this.hat] : []),
      ...(this.glasses ? [this.glasses] : []),
      this.weapon,
      this.nameLabel,
    ])
    // The sprite hangs from `anchorY`, so its centre is that far above the origin.
    this.bodyCentreY = (0.5 - anchorY) * drawn
    this.plume = new ThrusterPlume(scene, this.container, hasWebGL(scene))
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
    // **The accessories flip with the head** (T20.12). The cap's brim and the
    // crown's points are asymmetric on purpose — that asymmetry is what makes a
    // turn readable — and a hat that kept facing right on a body facing left
    // would be the one thing on screen that never turns around.
    this.hat?.setFlipX(left)
    this.glasses?.setFlipX(left)

    // The weapon rotates to the aim angle and is flipped **vertically** when
    // pointing left, not horizontally — the standard trick for a side-view aimed
    // weapon, otherwise it hangs upside down (`docs/50-sprites-skins.md` §4).
    this.weapon.setRotation(aim)
    this.weapon.setScale(1, left ? -1 : 1)

    this.shieldBubble.setVisible(flags.shield)
    // T21.02. Toggled, never rebuilt.
    this.boots?.setVisible(flags.boots)
    this.boots?.setFlipX(left)
    // T21.34. Toggled, never rebuilt.
    this.wings?.setVisible(flags.wings)
    this.wings?.setFlipX(left)
    // T22.04. Toggled, never rebuilt — against the thrust when the scene knows it
    // (the local player, T22.04C), else off velocity, so it turns with the body.
    this.plume.update(
      plumeOn(flags.alive, flags.jetpack, flags.space),
      flags.thrust,
      vx,
      vy,
      0,
      this.bodyCentreY,
      c.PLAYER_W / 2,
      c.PLAYER_H / 2,
    )

    // i-frames flash; dead is drawn faded rather than removed, so the corpse still
    // reads as a player during the respawn delay.
    const alpha = !flags.alive ? 0.35 : flags.iframes ? (Date.now() % 200 < 100 ? 0.4 : 1) : 1
    this.body.setAlpha(alpha)
    // The accessories fade with the body, or a corpse wears a solid hat.
    this.hat?.setAlpha(alpha)
    this.glasses?.setAlpha(alpha)
    this.boots?.setAlpha(alpha)
    this.wings?.setAlpha(alpha)
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
      // Same as the constructor: a weapon with no art draws nothing at all,
      // rather than the black bar the owner asked to be rid of.
      this.weapon = this.scene.add.rectangle(0, -c.PLAYER_H * 0.35, 0, 0, 0, 0).setOrigin(0, 0.5)
    }
    this.container.addAt(this.weapon, Math.max(0, idx))
  }

  get state(): AnimState {
    return this.animState
  }

  /** T22.04: what the plume drew last frame, for a check to count at both ends. */
  get plumeState(): { drawn: boolean; shader: boolean; dir: { x: number; y: number } } {
    return this.plume.state
  }

  /** T22.04, e2e only (§C2): hide the plume for a same-instant control frame. */
  setPlumeHidden(on: boolean): void {
    this.plume.setHidden(on)
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

  /**
   * Everything about how this player looks, as one value (T20.12).
   *
   * **The rebuild guard reads this, not three fields.** `GameScene` compares what
   * a view is drawing against what `scores` now says and rebuilds on a mismatch;
   * with three separate comparisons the next accessory is added to the map, to
   * the constructor, and forgotten in the `if` — and the symptom is a hat that is
   * correct on first draw and reverts on the next rebuild, which is exactly the
   * failure this task was told to expect.
   */
  get look(): Appearance {
    return { skinId: this.skinId, hatId: this.hatId, glassesId: this.glassesId }
  }

  /**
   * Where the accessories actually landed, in container units (T20.12).
   *
   * **For a check to aim a patch with, and it has to come from here.** `skins.mjs`
   * samples the band a hat occupies; a rect typed into the check would expire the
   * next time `overshoot`, `anchor.y` or the art size moved, and — worse — would
   * go on passing while sampling the wrong strip of a correct picture.
   */
  get accessoryBands(): {
    drawnH: number
    anchorY: number
    hatBottom: number
    hatH: number
    glassesMid: number
    glassesH: number
  } {
    const drawnH = this.body.displayHeight || C().PLAYER_H
    return {
      drawnH,
      anchorY: this.skinDef?.anchor.y ?? PlayerView.ANCHOR_Y,
      hatBottom: this.hat?.y ?? 0,
      hatH: this.hat?.displayHeight ?? 0,
      glassesMid: this.glasses?.y ?? 0,
      glassesH: this.glasses?.displayHeight ?? 0,
    }
  }
}
