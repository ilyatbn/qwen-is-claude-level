/**
 * Gun platforms on screen (T21.11A).
 *
 * `PadLayer`'s sibling, and deliberately so: a platform is a static seed-placed
 * map feature you activate by standing on it, which is what a teleport pad is,
 * and the two should not have two different render paths to drift apart.
 *
 * ## Drawn procedurally, not sprited
 *
 * No vendored pack has a turret. `docs/51` §5 makes the procedural path the
 * shipping one for anything the packs do not cover, and `weaponTextures.ts` and
 * `itemTextures.ts` are the precedent — a generated silhouette that reads
 * correctly beats a borrowed sprite that does not. The reference art in
 * `tasks/M21/assets/` is a triple-barrelled turret on a splayed tripod;
 * **silhouette only** is what is copied from it.
 *
 * Drawn at native size into a canvas texture once, because the game renders
 * `pixelArt: true` and drawing above native size only blurs under NEAREST.
 *
 * ## Where the geometry comes from
 *
 * `GUN_PLATFORM_W` and `GUN_PLATFORM_H` through the WASM constants, so the
 * picture cannot drift from the footprint `carve_circle` protects. `pos` is a
 * feet line, as everywhere else, and the indestructible rock is the rows below
 * it — the turret is drawn sitting **on** that line, which is what makes the
 * platform look like it has ground under it.
 */

import Phaser from 'phaser'
import { C } from '../core'
import { DEPTH } from './backdrop'

/** Where a platform is, in world pixels. `pos` is a feet line. */
export interface PlatformView {
  id: number
  x: number
  y: number
}

const TEXTURE_KEY = '__gun_platform'

/** Steel, shadowed steel, and the warning stripe that makes it read as a machine. */
// Deliberately light against terrain. Every theme's `fill`/`edge`
// (`themes-math.ts::THEMES`) is a mid-to-dark earth or a pale grey, and a dark
// machine on frost reads as a hole while a dark machine on grassland
// disappears. A bright steel with a hard dark outline reads on all three.
const STEEL = '#8d96a4'
const STEEL_DARK = '#2b3038'
const STEEL_LIGHT = '#c3cbd6'
const STRIPE = '#e8b23c'
const BARREL = '#1b1f26'

/**
 * How much taller than its footprint the art is drawn.
 *
 * The turret stands above the ground it is bolted to, so the texture is taller
 * than `GUN_PLATFORM_H` — that constant is the *rock*, not the machine. Derived
 * from the width so the proportions hold if the footprint is retuned.
 */
const ART_H_FRACTION = 0.95

/**
 * Build the platform texture once per texture manager.
 *
 * Idempotent, like `ensureWeaponTextures`: the scene is rebuilt on every round
 * and re-registering a key Phaser already has is a silent no-op that leaks
 * nothing.
 */
export function ensurePlatformTexture(textures: Phaser.Textures.TextureManager): {
  key: string
  w: number
  h: number
} {
  const c = C()
  const w = Math.max(8, Math.round(c.GUN_PLATFORM_W))
  const h = Math.max(6, Math.round(w * ART_H_FRACTION))
  if (textures.exists(TEXTURE_KEY)) return { key: TEXTURE_KEY, w, h }

  const canvas = textures.createCanvas(TEXTURE_KEY, w, h)
  const ctx = canvas?.getContext()
  if (!canvas || !ctx) return { key: TEXTURE_KEY, w, h }

  const px = (v: number) => Math.round(v)
  const baseH = Math.max(4, Math.round(h * 0.2))
  const baseY = h - baseH
  const cx = w / 2

  // --- the bolted base: a plinth the width of the protected rock -----------
  //
  // Drawn full width and hard-edged, because this is the part that has to read
  // as *ground you cannot destroy*: the rock below it is the footprint
  // `carve_circle` refuses to clear, and a plinth narrower than the rock would
  // make the protection look like a bug.
  ctx.fillStyle = STEEL_DARK
  ctx.fillRect(0, baseY, w, baseH)
  ctx.fillStyle = STEEL
  ctx.fillRect(1, baseY + 1, w - 2, baseH - 2)
  // A hazard stripe along the top of the plinth, so it reads as equipment
  // rather than as a rock at a glance.
  ctx.fillStyle = STRIPE
  for (let x = 2; x < w - 3; x += 8) ctx.fillRect(x, baseY + 1, 4, 2)

  // --- the splayed tripod ---------------------------------------------------
  const legTop = px(h * 0.4)
  ctx.strokeStyle = STEEL_DARK
  ctx.lineWidth = Math.max(3, Math.round(w * 0.09))
  for (const dir of [-1, 1]) {
    ctx.beginPath()
    ctx.moveTo(cx, legTop)
    ctx.lineTo(cx + dir * w * 0.32, baseY)
    ctx.stroke()
  }
  // The centre post, so it is a tripod and not a pair of scissors.
  ctx.beginPath()
  ctx.moveTo(cx, legTop)
  ctx.lineTo(cx, baseY)
  ctx.stroke()

  // --- the housing ----------------------------------------------------------
  const hubW = px(w * 0.5)
  const hubH = px(h * 0.34)
  const hubX = px(cx - hubW * 0.62)
  const hubY = px(legTop - hubH * 0.75)
  ctx.fillStyle = STEEL_DARK
  ctx.fillRect(hubX - 1, hubY - 1, hubW + 2, hubH + 2)
  ctx.fillStyle = STEEL
  ctx.fillRect(hubX, hubY, hubW, hubH)
  ctx.fillStyle = STEEL_LIGHT
  ctx.fillRect(hubX + 1, hubY + 1, hubW - 2, Math.max(2, px(hubH * 0.3)))

  // --- three barrels, which is the whole silhouette -------------------------
  //
  // The reference art is triple-barrelled and that is the one thing a player
  // has to read at 48 px: a turret, pointing somewhere, with more than one
  // muzzle. Thick and dark, so they survive against a pale sky.
  const barrelL = px(w * 0.42)
  const barrelH = Math.max(3, px(h * 0.09))
  const gap = barrelH + 2
  for (let i = -1; i <= 1; i++) {
    const by = px(hubY + hubH * 0.5 + i * gap)
    ctx.fillStyle = BARREL
    ctx.fillRect(hubX + hubW - 2, by, barrelL, barrelH)
    // A muzzle cap, so each barrel ends in something rather than fading out.
    ctx.fillStyle = STEEL_LIGHT
    ctx.fillRect(hubX + hubW - 2 + barrelL - 2, by, 2, barrelH)
  }

  canvas.refresh()
  return { key: TEXTURE_KEY, w, h }
}

/** The lit indicator's colour when somebody is riding the platform. */
const ACTIVE = 0x6fe6ff

/**
 * Which platform a body's feet are on, or `null` (T21.14).
 *
 * Mirrors `GunPlatform::underfoot`, which is itself `map::meta::footprint`
 * shared with `TeleportPad` — one answer to "are you standing on it", at three
 * sites. **Cosmetic only**, exactly like `padUnderfoot`: it decides which lamp
 * lights, never whether anybody is mounted. That is the server's, off the wire.
 */
export function platformUnderfoot(
  platforms: readonly PlatformView[],
  cx: number,
  cy: number,
  playerH: number,
  platformW: number,
): number | null {
  const feet = cy + playerH / 2
  for (const p of platforms) {
    // The y half-width is the pad's touch slack; a rider rests within a pixel or
    // two of the surface line rather than exactly on it.
    if (Math.abs(cx - p.x) <= platformW / 2 && Math.abs(feet - p.y) <= 4) return p.id
  }
  return null
}

/** The half of a player this derivation needs: where they are, and the wire byte. */
export interface RiderView {
  x: number
  y: number
  moveMods: number
}

/**
 * Which platforms have a rider on them (T21.14).
 *
 * **A pure function, shared by every caller**, because the bug this replaces was
 * a lamp lit only by a sandbox debug hook: `GameScene` never called
 * `setOccupied`, so in a real match the one signal distinguishing "mounted" from
 * "frozen" never appeared. A derivation living inside one scene is a derivation
 * the other scene does not have.
 *
 * The two halves come from different places on purpose. **Whether** a player is
 * mounted is the server's, carried by `MOVE_MOD.mounted` — the client cannot
 * derive it, because standing on a platform is not the same as having finished
 * the mount, and an occupied platform refuses a second rider. **Which** platform
 * is geometry, and is not on the wire because it does not need to be: a rider is
 * standing on theirs.
 */
export function occupiedPlatforms(
  riders: Iterable<RiderView>,
  platforms: readonly PlatformView[],
  mountedBit: number,
  playerH: number,
  platformW: number,
): number[] {
  const lit: number[] = []
  if (platforms.length === 0) return lit
  for (const r of riders) {
    if ((r.moveMods & mountedBit) === 0) continue
    const id = platformUnderfoot(platforms, r.x, r.y, playerH, platformW)
    if (id !== null && !lit.includes(id)) lit.push(id)
  }
  return lit
}

interface Entry {
  sprite: Phaser.GameObjects.Image
  /**
   * The occupied indicator: **two bars, one either side of the housing.**
   *
   * Separate objects rather than a tint on the sprite, because the art is
   * already light steel and a multiply tint on light pixels is a change nobody
   * can see. Two rather than one because **the rider stands in the middle of
   * their own machine**: a single centred bar is 16 px of body across 24 px of
   * lamp, so the one person who needs to read it — the one who cannot move and
   * needs to know why — sees least of it. Flanking bars are clear of the body
   * from every angle, and read as "this thing is live" rather than as a stripe.
   */
  lamps: Phaser.GameObjects.Rectangle[]
  view: PlatformView
}

export class PlatformLayer {
  private readonly entries = new Map<number, Entry>()
  private readonly container: Phaser.GameObjects.Container

  constructor(private readonly scene: Phaser.Scene) {
    // The same depth as `PadLayer`, and for the same reason its comment gives:
    // you stand **on** a platform, so the player must draw over it, and sharing
    // `DEPTH.decorations` would let a bush sort in front depending on creation
    // order.
    this.container = scene.add.container(0, 0).setDepth(DEPTH.decorations - 1)
  }

  /** How many platforms are drawn. The e2e counts this against the server's list. */
  get count(): number {
    return this.entries.size
  }

  get ids(): number[] {
    return [...this.entries.keys()]
  }

  /**
   * Where the occupied lamp is, relative to a platform's feet line, in world px
   * — or `null` when nothing is drawn.
   *
   * Read off the object the renderer positioned, for the same reason
   * `PadLayer::portalGeometry` is: a check that recomputes the art's
   * proportions is a second copy of them, and only one of the two is on screen.
   * The first version of `platforms.mjs` sampled the whole barrel band, where
   * the lamp is about a tenth of the area — it measured 2.5 against a threshold
   * of 8 with the lamp plainly lit.
   */
  lampGeometry(): { dy: number; dx: number; w: number; h: number } | null {
    for (const e of this.entries.values()) {
      const l = e.lamps[0]
      if (!l) return null
      // `dx` is the offset of one bar from the platform's centre, so a check can
      // sample a bar rather than the gap between them — which is where the rider
      // stands.
      return { dy: l.y - e.view.y, dx: Math.abs(l.x - e.view.x), w: l.width, h: l.height }
    }
    return null
  }

  /** The platforms as built, for a caller that needs their geometry. */
  get views(): PlatformView[] {
    return [...this.entries.values()].map((e) => e.view)
  }

  /**
   * Which platforms are showing a rider. **Asserted on by the tests, and it
   * reads the objects rather than a remembered set** — a layer that recorded
   * the ask and never touched a lamp would satisfy any check of its own input.
   */
  lampsLit(): number[] {
    return [...this.entries.entries()]
      .filter(([, e]) => e.lamps.some((l) => l.visible))
      .map(([id]) => id)
  }

  /**
   * Which platforms have somebody riding them (T21.11B).
   *
   * **Told, not derived from a timer.** The server owns the mount rule — an
   * occupied platform, a dead player, a hold that reset — and the client draws
   * the answer, the same way `PadLayer` draws the charge byte rather than
   * counting its own. Passing the whole set each frame rather than a delta
   * means a missed message cannot leave a lamp stuck on.
   */
  setOccupied(ids: readonly number[]): void {
    for (const [id, e] of this.entries) {
      const on = ids.includes(id)
      for (const l of e.lamps) l.setVisible(on)
    }
  }

  /**
   * Show or hide the whole layer.
   *
   * **For the pixel check's control frame** (`docs/72` §C2): "the turret is on
   * screen" is only evidence against the same camera, the same map and the same
   * light with the layer gone. Two locations cannot be that control, and neither
   * can two maps.
   */
  setVisible(on: boolean): void {
    this.container.setVisible(on)
  }

  /**
   * Build the sprites. Idempotent — calling it again with the same list changes
   * nothing, so a resync does not stack two turrets per platform.
   */
  build(platforms: readonly PlatformView[]): void {
    for (const [id, e] of this.entries) {
      if (!platforms.some((p) => p.id === id)) {
        e.sprite.destroy()
        for (const l of e.lamps) l.destroy()
        this.entries.delete(id)
      }
    }

    const art = ensurePlatformTexture(this.scene.textures)
    for (const p of platforms) {
      const existing = this.entries.get(p.id)
      if (existing) {
        existing.view = p
        existing.sprite.setPosition(p.x, p.y)
        existing.lamps.forEach((l, i) =>
          l.setPosition(p.x + (i === 0 ? -1 : 1) * art.w * 0.3, p.y - art.h * 0.75),
        )
        continue
      }
      // Origin (0.5, 1): `p.y` is the feet line, so the art sits **on** the
      // ground rather than centred through it.
      const sprite = this.scene.add.image(p.x, p.y, art.key).setOrigin(0.5, 1)
      // Across the housing, which is where a player looks: derived from the
      // art's own proportions so it cannot drift off the machine.
      // **High enough to clear the rider's head** (T21.14). At `0.62` the band
      // spanned 25.8–31.3 px above the feet line while a standing player
      // occupies 0–28 and draws at `DEPTH.actors`, *over* the platform — so 2.2
      // of its 5.5 px sat behind the one person who needs to read it. Measured,
      // not guessed. `0.75` puts it at 31.8–37.2, inside the housing (which
      // spans roughly 23.7–39.3) and clear of a 28 px body.
      const lamps = [-1, 1].map((dir) =>
        this.scene.add
          .rectangle(
            p.x + dir * art.w * 0.3,
            p.y - art.h * 0.75,
            art.w * 0.22,
            Math.max(2, art.h * 0.12),
            ACTIVE,
            0.95,
          )
          .setOrigin(0.5, 0.5)
          .setVisible(false),
      )
      this.container.add([sprite, ...lamps])
      this.entries.set(p.id, { sprite, lamps, view: p })
    }
  }

  destroy(): void {
    for (const e of this.entries.values()) {
      e.sprite.destroy()
      for (const l of e.lamps) l.destroy()
    }
    this.entries.clear()
    this.container.destroy()
  }
}
