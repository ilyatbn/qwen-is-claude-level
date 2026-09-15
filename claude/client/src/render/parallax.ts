/**
 * §C14's living background: mountain silhouettes, and the clouds.
 *
 * The parallax band at depth −20 that T3.06 deliberately left empty because there
 * was nothing to put in it. The ridge maths is in `sky-math.ts` and
 * `parallax-math.ts`, the cloud maths in `clouds-math.ts` (§A8); this file only
 * draws, and it is owned by `SkyLayer` so that every scene with a sky gets it
 * without opting in.
 *
 * ## The clouds, third time (T21.31)
 *
 * Sprites until T21.18, then a band-shaped shader (`CLOUD_FRAGMENT`) drawn only
 * with High Quality on and only on WebGL. The owner plays with High Quality off on
 * Phaser's **Canvas** renderer, so his sky had no clouds at all, and what he took
 * for them was the far ridge. His report: *"they do not move and are honestly too
 * large. should have smaller clouds in different shapes and sizes and colors."*
 *
 * So the shader is gone and the clouds are **world objects**: one `Graphics` of
 * filled circles, which every renderer draws. `clouds-math.ts` has what each one is
 * and where; High Quality only paints each lobe with more, fainter rings
 * (`CLOUD_RINGS_HQ`), which softens the edge and changes nothing else. They sit
 * at `DEPTH.parallaxClouds`, behind the terrain, so a cave never shows one — and
 * `clouds-math`'s sky floor keeps every one of them out of the rock anyway.
 *
 * ## One draw each, no texture rebuilt per frame
 *
 * The ridge is baked **white** into a canvas once per seed and drawn as a
 * `TileSprite`; the phase response is a guarded `setTint`. The clouds are
 * re-filled each frame, **only the ones the camera can see** — three or four at
 * `CAMERA_ZOOM` 2 — which is a few dozen circles.
 */

import Phaser from 'phaser'
import { ridgeLayout, type RidgeLayout } from './parallax-math'
import { C } from '../core'
import { DEPTH } from './backdrop'
import { cloudTint, mountainProfile } from './sky-math'
import {
  cloudCentreX,
  cloudField,
  cloudVelocity,
  columnTops,
  flatFloor,
  mulColor,
  placeCloud,
  skyFloor,
  type Cloud,
  type CloudBox,
  type SkyFloor,
} from './clouds-math'
import { isHighQuality, onHighQualityChange } from '../ui/settings'
import { resolveTheme } from './themes-math'

/** What the sky needs to know about the map: its size, its rock and its wind. */
export interface SkyGround {
  width: number
  height: number
  solidAt(x: number, y: number): boolean
  /** `MapMeta::wind`, px/s² — the round's, so every client drifts one way. */
  wind: number
}

/** Keys are per-layer and per-seed: a stale texture is a stale mountain range. */
const RIDGE_KEY = (layer: number, seed: number) => `__ridge_${layer}_${seed >>> 0}`

function mix(a: number, b: number, t: number): number {
  const ch = (sh: number) => {
    const av = (a >> sh) & 255
    const bv = (b >> sh) & 255
    return Math.round(av + (bv - av) * t) & 255
  }
  return (ch(16) << 16) | (ch(8) << 8) | ch(0)
}

/**
 * Bake one layer's ridge as a white silhouette, wrapping over `RIDGE_TEX_W`.
 *
 * White so the caller can tint it per frame: the alternative is re-baking the
 * canvas every time the sky colour moves, which at 120 s per day is several
 * times a second for a texture a megapixel across.
 */
function ridgeTexture(scene: Phaser.Scene, layer: number, seed: number, height: number): string {
  const key = RIDGE_KEY(layer, seed)
  if (scene.textures.exists(key)) return key
  const c = C()
  const w = c.RIDGE_TEX_W
  const tex = scene.textures.createCanvas(key, w, height)
  const ctx = tex?.getContext()
  if (!ctx || !tex) return key

  const profile = mountainProfile(seed, layer, w, c.MOUNTAIN_CELLS, c.MOUNTAIN_OCTAVES)
  ctx.clearRect(0, 0, w, height)
  ctx.fillStyle = '#ffffff'
  ctx.beginPath()
  ctx.moveTo(0, height)
  for (let x = 0; x < w; x++) {
    ctx.lineTo(x, height - profile[x]! * height)
  }
  ctx.lineTo(w - 1, height)
  ctx.closePath()
  ctx.fill()
  tex.refresh()
  return key
}

export class ParallaxLayer {
  private readonly scene: Phaser.Scene
  private readonly ridges: Phaser.GameObjects.TileSprite[] = []
  /**
   * T21.20: the near ridge's **foot** — a fade from its tint to nothing over
   * `MOUNTAIN_FOOT_FADE` world px below its base — or `null` until built.
   *
   * World-anchored, the base is a world row, and wherever the ground dips below it
   * the sprite ended in a straight line with sky under it (seen in `living-sky`'s
   * carved frame). The first fix was a solid rectangle to the bottom of the screen,
   * and it was worse: below the base it filled the entire sky with mountain colour
   * (seen in `skins-ingame`'s frames). A short fade softens the edge and leaves the
   * sky beneath. One Graphics at the near ridge's depth, so the layer set does not
   * change; not drawn on the title, which keeps its old picture.
   */
  private skirt: Phaser.GameObjects.Graphics | null = null
  private skirtY = 0
  private skirtH = 0
  private seed = 0
  private themeId = 0
  private ridgeKeys: string[] = []
  /** Last tint applied, so `setTint` is not called sixty times a second. */
  private lastRidgeTint: number[] = []
  /** Set by `setVisible(false)`; `update` must not undo it on the next frame. */
  private hidden = false
  /** Reused by `view()`, so the per-frame maths does not allocate a literal. */
  private readonly rect = { left: 0, top: 0, w: 0, h: 0 }
  /**
   * Pins the cloud clock, for a check that needs a known picture.
   *
   * Diagnostic seam, like `setZoom`. **Every moving quantity of a cloud is derived
   * from this clock**, so pinning it freezes the sky completely — which is what
   * lets `clouds` measure "this patch changed because the cloud moved" against a
   * control where it must not have.
   */
  private clock: number | null = null

  // --- T21.31: the clouds -------------------------------------------------
  /** World space (scroll factor 1): rain falls from under these. */
  private readonly cloudGfx: Phaser.GameObjects.Graphics
  private clouds: Cloud[] = []
  /** T21.31: the sickly deck along `SKY_MARGIN` a toxic shower's drops leave from. */
  private toxicDeck: Cloud[] = []
  /** Every placed ambient cloud over the view's columns — what the rain falls from. */
  private overhead: CloudBox[] = []
  /** `0..1` shades from the weather: how grey the clouds are, how visible the deck is. */
  private rainShade = 0
  private toxicShade = 0
  private floor: SkyFloor
  private mapW: number
  private wind = 0
  /**
   * Hides the clouds and nothing else, for a check's control frame.
   *
   * **Separate from `hidden`**, which takes the ridges away too: `living-sky`
   * measures the ridges against a strip of open sky, and `clouds` measures a cloud
   * against the same frame without it — one latch serving both would make each
   * check's control include the other's subject.
   */
  private cloudsHidden = false
  /** The clouds drawn on the last frame, world px — what a check and the rain read. */
  private drawn: CloudBox[] = []
  private lastRings = 0
  /** The last clock and phase drawn, so a High Quality flip can repaint at once. */
  private lastT = 0
  private lastU = 0
  private readonly unsubscribeQuality: () => void
  /** T21.20: the map's height in world px, or 0 with no map (the title). */
  private mapH = 0

  constructor(scene: Phaser.Scene, seed = 0, themeId = 0) {
    this.scene = scene
    const c = C()
    const w = c.VIEWPORT_W
    const h = c.VIEWPORT_H

    // **Checked once, then indexed directly.** Every read below used to carry a
    // `?? 0.2`-shaped fallback, which defends against nothing the type system
    // allows — these are `[f32; MOUNTAIN_LAYERS]` in Rust — while disabling the
    // only signal that would exist if somebody raised `MOUNTAIN_LAYERS` and
    // forgot to extend them.
    for (const [name, arr] of [
      ['MOUNTAIN_PARALLAX', c.MOUNTAIN_PARALLAX],
      ['MOUNTAIN_HEIGHT_FRAC', c.MOUNTAIN_HEIGHT_FRAC],
      ['MOUNTAIN_HAZE', c.MOUNTAIN_HAZE],
    ] as const) {
      if (arr.length !== c.MOUNTAIN_LAYERS) {
        throw new Error(
          `${name} has ${arr.length} entries but MOUNTAIN_LAYERS is ${c.MOUNTAIN_LAYERS}`,
        )
      }
    }

    for (let i = 0; i < c.MOUNTAIN_LAYERS; i++) {
      const bandH = Math.round(h * c.MOUNTAIN_HEIGHT_FRAC[i]!)
      const key = ridgeTexture(scene, i, seed, bandH)
      this.ridgeKeys.push(key)
      const ts = scene.add
        .tileSprite(0, 0, w, bandH, key)
        .setOrigin(0, 0)
        .setScrollFactor(0)
        // The **last** layer is the near one; every earlier one goes behind the
        // clouds' depth. `parallaxFar + i` would have put the near ridge at −21.
        .setDepth(i === c.MOUNTAIN_LAYERS - 1 ? DEPTH.parallax : DEPTH.parallaxFar + i)
      this.ridges.push(ts)
      if (i === c.MOUNTAIN_LAYERS - 1) {
        this.skirt = scene.add.graphics().setScrollFactor(0).setDepth(ts.depth).setVisible(false)
      }
      this.lastRidgeTint.push(-1)
    }

    // At the clouds' own depth, which the layer-set pins in `terrain-render` and
    // `two-clients` already list: behind the terrain, so no cave shows a cloud.
    this.cloudGfx = scene.add.graphics().setDepth(DEPTH.parallaxClouds)
    this.floor = flatFloor(h * c.CLOUD_TITLE_FLOOR_FRAC)
    this.mapW = w
    // A live toggle: a setting that needs a restart is one the player flips, sees
    // nothing, and flips back (T21.16). Repainted now, so `cloudRings` read straight
    // after the flip answers with the new picture.
    this.unsubscribeQuality = onHighQualityChange(() => this.drawClouds(this.lastT, this.lastU))

    // No map yet: the title never gets one, and a scene gives it with its seed.
    this.setSeed(seed, themeId, null)
  }

  /**
   * Point the background at a map.
   *
   * Called after every generate, so a regenerate in the sandbox gets the new
   * seed's mountains and clouds rather than the previous map's. `ground` is `null`
   * on the title, which has no map: its clouds sit on a flat floor in screen space.
   */
  setSeed(seed: number, themeId: number, ground: SkyGround | null): void {
    const c = C()
    this.seed = seed
    this.themeId = themeId
    // T21.20: 0 is the title's screen layout.
    this.mapH = ground?.height ?? 0
    for (let i = 0; i < this.ridges.length; i++) {
      const bandH = Math.round(c.VIEWPORT_H * c.MOUNTAIN_HEIGHT_FRAC[i]!)
      const key = ridgeTexture(this.scene, i, seed, bandH)
      if (key !== this.ridgeKeys[i]) {
        const old = this.ridgeKeys[i]
        this.ridges[i]!.setTexture(key)
        this.ridgeKeys[i] = key
        // Phaser's texture manager is global; a ridge left behind is a leak of a
        // megapixel canvas per regenerate (T3.05's lesson, in a new place).
        if (old && old !== key && this.scene.textures.exists(old)) this.scene.textures.remove(old)
      }
    }

    // T21.31. The floor is measured once per map: the terrain only loses rock, so a
    // floor that cleared the rock at generate still clears it after any crater.
    if (ground) {
      const step = c.CLOUD_FLOOR_STEP
      this.floor = skyFloor(columnTops(ground.width, ground.height, step, (x, y) => ground.solidAt(x, y)), step, c)
      this.mapW = ground.width
      this.wind = ground.wind
    } else {
      this.floor = flatFloor(c.VIEWPORT_H * c.CLOUD_TITLE_FLOOR_FRAC)
      this.mapW = c.VIEWPORT_W
      this.wind = 0
    }
    this.clouds = cloudField(seed, this.mapW, c)
    // A second field on its own seed, packed tighter: a shower's drops leave from
    // anywhere along the map, so the deck must be continuous where the clouds are not.
    this.toxicDeck = cloudField((seed ^ 0x70c1c) >>> 0, this.mapW, { ...c, CLOUD_SPACING: c.TOXIC_DECK_SPACING })
  }

  /**
   * T21.31: the weather's two shades, `0..1` — the ambient rain greys the clouds it
   * falls from, and a toxic shower fades its deck in with the cast.
   */
  setWeatherShade(ambient: number, toxic: number): void {
    this.rainShade = Math.max(0, Math.min(1, ambient))
    this.toxicShade = Math.max(0, Math.min(1, toxic))
  }

  /**
   * T21.31: the clouds rain may fall from this frame — every placed cloud over the
   * view's columns, **including those above the top of the view**, or a player standing
   * under a cloud they cannot see would stand in a dry sky.
   */
  rainClouds(): readonly CloudBox[] {
    return this.overhead
  }

  /**
   * The camera-space rectangle a `scrollFactor(0)` object is actually seen in.
   *
   * **Zoom applies to camera-space objects too.** At zoom Z a pinned object only
   * shows the middle `1/Z` of the viewport.
   */
  private view(): { left: number; top: number; w: number; h: number } {
    const c = C()
    const z = this.scene.cameras.main.zoom || 1
    const v = this.rect
    v.w = c.VIEWPORT_W / z
    v.h = c.VIEWPORT_H / z
    v.left = c.VIEWPORT_W / 2 - v.w / 2
    v.top = c.VIEWPORT_H / 2 - v.h / 2
    return v
  }

  /**
   * `clock` is the round's time in seconds, so every client drifts the same clouds
   * to the same place. `skyBottom` is the gradient's own bottom colour.
   */
  update(clock: number, skyBottom: number, scrollX: number, u: number): void {
    if (this.hidden) return
    const c = C()
    const view = this.view()
    const z = this.scene.cameras.main.zoom || 1
    const theme = resolveTheme(this.themeId)
    // The theme's rock, well darkened: a silhouette is what the land looks like
    // with no light on it, not the land at half brightness.
    const ink = mix((theme.fill.r << 16) | (theme.fill.g << 8) | theme.fill.b, 0x000000, c.MOUNTAIN_INK)

    for (let i = 0; i < this.ridges.length; i++) {
      const ts = this.ridges[i]!
      // Aerial perspective: the far layer is washed further toward the sky.
      const tint = mix(ink, skyBottom, c.MOUNTAIN_HAZE[i]!)
      if (tint !== this.lastRidgeTint[i]) {
        ts.setTint(tint)
        this.lastRidgeTint[i] = tint
      }
      ts.tilePositionX = scrollX * c.MOUNTAIN_PARALLAX[i]!

      // **T21.20: anchored to the world when there is a map** — `parallax-math.ts`
      // has the rule and its tests.
      const lay = this.layout(i)
      ts.setPosition(view.left, view.top + lay.top / z)
      ts.setSize(view.w, lay.h / z)
      if (this.skirt && i === this.ridges.length - 1) {
        const top = view.top + (lay.top + lay.h) / z
        const h = c.MOUNTAIN_FOOT_FADE
        const onScreen = top < view.top + view.h && top + h > view.top
        this.skirt.clear()
        this.skirt.setVisible(lay.worldBase !== null && onScreen && !this.hidden)
        this.skirtY = top
        this.skirtH = h
        if (this.skirt.visible) {
          this.skirt.fillGradientStyle(tint, tint, tint, tint, 1, 1, 0, 0)
          this.skirt.fillRect(view.left, top, view.w, h)
        }
      }
    }

    this.drawClouds(this.clock ?? clock, u)
  }

  /**
   * Fill the clouds the camera can see.
   *
   * `cloudTint` still decides the phase's colour and opacity; each cloud multiplies
   * its own tint and opacity into that, so the time of day moves every cloud and the
   * clouds still differ from one another.
   */
  private drawClouds(t: number, u: number): void {
    const c = C()
    this.lastT = t
    this.lastU = u
    const g = this.cloudGfx
    g.clear()
    this.drawn = []
    this.overhead = []
    const wv = this.scene.cameras.main.worldView
    // **The rain's clouds are placed whether or not the clouds are shown**: hiding
    // them for a control frame must not stop the rain it is being compared against.
    for (let i = 0; i < this.clouds.length; i++) {
      const b = placeCloud(this.clouds[i]!, i, t, this.wind, this.mapW, this.floor, c)
      if (b.visible && b.left <= wv.right && b.left + b.w >= wv.x && b.top <= wv.bottom) this.overhead.push(b)
    }
    const on = !this.hidden && !this.cloudsHidden
    g.setVisible(on)
    if (!on) return
    const rings = isHighQuality() ? c.CLOUD_RINGS_HQ : c.CLOUD_RINGS
    this.lastRings = rings
    const phase = cloudTint(u, c.CLOUD_ALPHA, c.CLOUD_SKY_MIX, c.CLOUD_ALPHA_FLOOR)
    const paint = (cloud: Cloud, b: CloudBox, colour: number, alpha: number) => {
      const a = alpha / rings
      g.fillStyle(colour, a)
      // Outer ring at the lobe's full radius, each further ring smaller: the
      // alpha piles up toward the middle, which is the soft edge.
      for (let k = 0; k < rings; k++) {
        const shrink = 1 - (0.45 * k) / rings
        for (const l of cloud.lobes) g.fillCircle(b.left + l.cx, b.top + l.cy, l.r * shrink)
      }
    }
    const onScreen = (b: CloudBox) => b.left <= wv.right && b.left + b.w >= wv.x && b.top <= wv.bottom && b.top + b.h >= wv.y
    for (const b of this.overhead) {
      if (!onScreen(b)) continue
      const cloud = this.clouds[b.index]!
      this.drawn.push(b)
      const lit = mulColor(phase.color, cloud.tint)
      paint(cloud, b, mix(lit, mulColor(phase.color, c.CLOUD_RAIN_GREY), c.CLOUD_RAIN_DARKEN * this.rainShade), phase.alpha * cloud.opacity)
    }
    // The toxic deck: its base on `SKY_MARGIN`, where `toxic.rs` releases every drop.
    if (this.toxicShade > 0.02) {
      const tint = mulColor(phase.color, c.TOXIC_CLOUD_TINT)
      for (let i = 0; i < this.toxicDeck.length; i++) {
        const cloud = this.toxicDeck[i]!
        const cx = cloudCentreX(cloud, t, this.wind, this.mapW, c)
        const b: CloudBox = {
          index: i,
          left: cx - cloud.w / 2,
          top: Math.max(c.CLOUD_TOP_MIN, c.SKY_MARGIN - cloud.h),
          w: cloud.w,
          h: cloud.h,
          visible: true,
        }
        if (!onScreen(b)) continue
        paint(cloud, b, tint, phase.alpha * this.toxicShade)
      }
    }
  }

  /**
   * Where every cloud is at clock `t`, world px — drawn or not, on screen or not.
   * For the checks that sweep a round's worth of sky for rock.
   */
  cloudsAt(t: number): CloudBox[] {
    const c = C()
    return this.clouds.map((cl, i) => placeCloud(cl, i, t, this.wind, this.mapW, this.floor, c))
  }

  /** The clouds drawn on the last frame, world px. */
  get drawnClouds(): readonly CloudBox[] {
    return this.drawn
  }

  /** Hide or show the clouds alone, for a check's control frame. Read back off the object. */
  setCloudsVisible(on: boolean): { visible: boolean } {
    this.cloudsHidden = !on
    this.drawClouds(this.lastT, this.lastU)
    return { visible: this.cloudGfx.visible }
  }

  /**
   * Show or hide the whole band — ridges, their foot and the clouds.
   *
   * Exists for `living-sky`'s control frame: the only way to prove a ridge pixel
   * is a ridge and not the gradient behind it is to take the ridge away.
   */
  setVisible(on: boolean): void {
    for (const r of this.ridges) r.setVisible(on)
    if (!on) this.skirt?.setVisible(false)
    // **The latch is set before the clouds are repainted**, which reads it.
    this.hidden = !on
    this.drawClouds(this.lastT, this.lastU)
  }

  destroy(): void {
    for (const r of this.ridges) r.destroy()
    this.skirt?.destroy()
    this.skirt = null
    this.ridges.length = 0
    this.cloudGfx.destroy()
    // Or every round leaks a listener, and a setting flip wakes the dead ones.
    this.unsubscribeQuality()
    for (const key of this.ridgeKeys) {
      if (this.scene.textures.exists(key)) this.scene.textures.remove(key)
    }
    this.ridgeKeys = []
  }

  /** Where ridge `i` sits right now — the one source for `update` and `debug`. */
  private layout(i: number): RidgeLayout {
    const c = C()
    const cam = this.scene.cameras.main
    return ridgeLayout({
      mapH: this.mapH,
      baseFrac: c.MOUNTAIN_BASE_FRAC,
      titleBaseFrac: c.MOUNTAIN_TITLE_BASE_FRAC,
      heightFrac: c.MOUNTAIN_HEIGHT_FRAC[i]!,
      viewportH: c.VIEWPORT_H,
      viewY: cam.worldView.y,
      zoom: cam.zoom || 1,
    })
  }

  /** Pin or release the cloud clock. `null` resumes the round's. */
  setClock(t: number | null): void {
    this.clock = t
  }

  /** For the browser check: what is on screen, without reading pixels. */
  debug(): {
    seed: number
    ridges: number
    span: number
    /** The tint Phaser is holding on the near ridge, as 0xRRGGBB. */
    ridgeTint: number
    /** Which renderer is drawing, off the game — the clouds must exist on both. */
    renderer: 'webgl' | 'canvas'
    /** The round's clouds, and how many of them the last frame drew. */
    clouds: number
    cloudsDrawn: number
    /** Rings per lobe on the last frame: `CLOUD_RINGS`, or `CLOUD_RINGS_HQ` with High Quality. */
    cloudRings: number
    /** Whether `setCloudsVisible(false)` is hiding them. */
    cloudsHidden: boolean
    /** The drawn clouds, world px, with their speed along x so a check can predict a drift. */
    cloudBoxes: Array<CloudBox & { vx: number; tint: number }>
    /** Every cloud's make-up, for the variety a check reads beside the pixels. */
    cloudField: Array<{ w: number; h: number; lobes: number; tint: number; opacity: number; vx: number }>
    /**
     * T21.20: where the **near** ridge is — viewport px, plus its world base and
     * height (`null` on the title) — from the same `ridgeLayout` call `update`
     * places it with, and the sprite's own camera-space rect beside it.
     */
    ridge: RidgeLayout & { spriteY: number; spriteH: number }
    /** Whether `setVisible(false)` has hidden the band (a check's control frame). */
    hidden: boolean
    /** T21.20's foot under the near ridge, camera space: `null` if never built. */
    skirt: { y: number; h: number; visible: boolean } | null
    /** The camera-space rect that fills the screen, so a check can convert. */
    view: { left: number; top: number; w: number; h: number }
  } {
    const v = this.view()
    const c = C()
    return {
      seed: this.seed,
      ridges: this.ridges.length,
      span: v.w,
      ridgeTint: this.ridges[this.ridges.length - 1]?.tintTopLeft ?? 0,
      renderer: this.scene.game.renderer.type === Phaser.WEBGL ? 'webgl' : 'canvas',
      clouds: this.clouds.length,
      cloudsDrawn: this.drawn.length,
      cloudRings: this.lastRings,
      cloudsHidden: this.cloudsHidden,
      cloudBoxes: this.drawn.map((b) => ({
        ...b,
        vx: cloudVelocity(this.clouds[b.index]!, this.wind, c),
        tint: this.clouds[b.index]!.tint,
      })),
      cloudField: this.clouds.map((cl) => ({
        w: cl.w,
        h: cl.h,
        lobes: cl.lobes.length,
        tint: cl.tint,
        opacity: cl.opacity,
        vx: cloudVelocity(cl, this.wind, c),
      })),
      ridge: {
        ...this.layout(this.ridges.length - 1),
        spriteY: this.ridges[this.ridges.length - 1]?.y ?? 0,
        spriteH: this.ridges[this.ridges.length - 1]?.height ?? 0,
      },
      hidden: this.hidden,
      skirt: this.skirt
        ? { y: this.skirtY, h: this.skirtH, visible: this.skirt.visible }
        : null,
      view: { left: v.left, top: v.top, w: v.w, h: v.h },
    }
  }
}
