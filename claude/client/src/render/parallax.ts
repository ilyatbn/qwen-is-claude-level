/**
 * §C14's living background: mountain silhouettes and drifting clouds.
 *
 * The parallax band at depth −20 that T3.06 deliberately left empty because there
 * was nothing to put in it. All the maths is in `sky-math.ts` (§A8); this file
 * only draws, and it is owned by `SkyLayer` so that every scene with a sky gets
 * it without opting in — the alternative is three scenes and one of them
 * forgetting, which is how twelve mechanisms on this project ended up wired to
 * nothing.
 *
 * ## One draw each, no texture or sprite rebuilt per frame
 *
 * The ridge is baked **white** into a canvas once per seed and drawn as a
 * `TileSprite`, which wraps for free; the phase response is `setTint`, which
 * costs nothing and is guarded so it only fires when the colour moves. The
 * clouds are one soft-blob texture drawn by a fixed pool of `Image`s that are
 * repositioned and re-tinted, never recreated.
 *
 * That is the claim, and it is deliberately narrower than "allocates nothing":
 * `cloudTint` returns a small object each frame and the visible-rect maths is
 * kept in a reused field rather than a fresh literal. What §C14 is protecting is
 * the megapixel canvas and the twelve sprites, and those are built once.
 */

import Phaser from 'phaser'
import { C } from '../core'
import { DEPTH } from './backdrop'
import {
  cloudColourForPhase,
  cloudFrame,
  cloudSpriteTint,
  cloudSprites,
  type CloudSprite,
} from './clouds-math'
import {
  cloudField,
  cloudTint,
  cloudTwinX,
  cloudX,
  mountainProfile,
  skyPhase,
  type Cloud,
} from './sky-math'
import { resolveTheme } from './themes-math'

/** Keys are per-layer and per-seed: a stale texture is a stale mountain range. */
const RIDGE_KEY = (layer: number, seed: number) => `__ridge_${layer}_${seed >>> 0}`
const CLOUD_KEY = '__cloud_blob'
/** The pack's clouds, built by `scripts/build-cloud-atlas.mjs`. */
const CLOUD_ATLAS_KEY = 'clouds'

function mix(a: number, b: number, t: number): number {
  const ch = (sh: number) => {
    const av = (a >> sh) & 255
    const bv = (b >> sh) & 255
    return Math.round(av + (bv - av) * t) & 255
  }
  return (ch(16) << 16) | (ch(8) << 8) | ch(0)
}

/**
 * A soft cloud blob: overlapping radial gradients, white with an alpha falloff so
 * the caller can tint it. Generated once and reused by every cloud.
 */
function cloudTexture(scene: Phaser.Scene): string {
  if (scene.textures.exists(CLOUD_KEY)) return CLOUD_KEY
  const c = C()
  const w = c.CLOUD_TEX_W
  const h = c.CLOUD_TEX_H
  const tex = scene.textures.createCanvas(CLOUD_KEY, w, h)
  const ctx = tex?.getContext()
  if (!ctx || !tex) return CLOUD_KEY

  // Five lobes along the width, biggest in the middle: a single ellipse reads as
  // a smudge, and a cloud is a pile of them.
  //
  // **Radii are fractions of the texture HEIGHT, not its width.** The first
  // version used the width, so on a 256×96 canvas the middle lobe had an 87 px
  // radius in a 96 px-tall box: every lobe was clipped top and bottom and twelve
  // clouds rendered as one pale horizontal wash across the sky. The screenshot
  // is the only reason that was caught — the maths tests were all green.
  const lobes: Array<[number, number, number]> = [
    [0.18, 0.62, 0.3],
    [0.36, 0.5, 0.42],
    [0.54, 0.46, 0.46],
    [0.72, 0.56, 0.36],
    [0.86, 0.66, 0.24],
  ]
  for (const [fx, fy, fr] of lobes) {
    const cx = fx * w
    const cy = fy * h
    const r = fr * h
    const g = ctx.createRadialGradient(cx, cy, 0, cx, cy, r)
    g.addColorStop(0, 'rgba(255,255,255,0.85)')
    g.addColorStop(0.55, 'rgba(255,255,255,0.42)')
    g.addColorStop(1, 'rgba(255,255,255,0)')
    ctx.fillStyle = g
    ctx.fillRect(cx - r, cy - r, r * 2, r * 2)
  }
  tex.refresh()
  // `pixelArt: true` forces NEAREST globally, which stair-steps a gradient this
  // large — the same opt-out the sun's glow needed.
  tex.setFilter(Phaser.Textures.FilterMode.LINEAR)
  return CLOUD_KEY
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
  /** One `Image` per cloud, plus one twin each for the seam at the wrap. */
  private readonly cloudGfx: Phaser.GameObjects.Image[] = []
  private readonly cloudTwins: Phaser.GameObjects.Image[] = []
  private clouds: Cloud[] = []
  /** Which sprite each cloud is — fixed for the round, seeded from the map. */
  private cloudSprites: CloudSprite[] = []
  /** The pack atlas, or null when it did not load (`docs/50` §8). */
  private cloudAtlas: string | null = null
  /** Last colour set drawn, so the texture is swapped only when it changes. */
  private lastCloudColour: string | null = null
  private seed = 0
  private themeId = 0
  private ridgeKeys: string[] = []
  /** Last tint applied, so `setTint` is not called sixty times a second. */
  private lastRidgeTint: number[] = []
  private lastCloudTint = -1
  /** Set by `setVisible(false)`; `update` must not undo it on the next frame. */
  private hidden = false
  /** Reused by `view()`, so the per-frame maths does not allocate a literal. */
  private readonly rect = { left: 0, top: 0, w: 0, h: 0 }
  /**
   * Pins the drift clock, for a check that needs a known layout.
   *
   * Diagnostic seam, like `setZoom`. The cloud spacing is only exactly even at
   * elapsed = 0 — after that the per-cloud `speed` spread makes them drift past
   * each other, which is the point of the spread and not a defect. So an
   * assertion on the smallest gap has to name a moment, or it is asserting on
   * how long the browser check happened to take to get there.
   */
  private clock: number | null = null

  constructor(scene: Phaser.Scene, seed = 0, themeId = 0) {
    this.scene = scene
    const c = C()
    const w = c.VIEWPORT_W
    const h = c.VIEWPORT_H

    // **Checked once, then indexed directly.** Every read below used to carry a
    // `?? 0.2`-shaped fallback, which defends against nothing the type system
    // allows — these are `[f32; MOUNTAIN_LAYERS]` in Rust — while disabling the
    // only signal that would exist if somebody raised `MOUNTAIN_LAYERS` and
    // forgot to extend them: a third ridge would have rendered plausible
    // invented values instead of saying so.
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

    // Far mountains, then clouds, then near mountains: `CLOUD_PARALLAX` (0.14)
    // sits between the two scroll factors, so anything else would put a cloud in
    // front of a ridge it is behind.
    for (let i = 0; i < c.MOUNTAIN_LAYERS; i++) {
      const bandH = Math.round(h * c.MOUNTAIN_HEIGHT_FRAC[i]!)
      const key = ridgeTexture(scene, i, seed, bandH)
      this.ridgeKeys.push(key)
      // Oversized and pinned to the camera for the same reason the gradient is:
      // with scrollFactor 0 the sprite lives in camera space, and at zoom < 1 a
      // viewport-sized one leaves the edges showing the clear colour.
      const ts = scene.add
        .tileSprite(0, 0, w, bandH, key)
        .setOrigin(0, 0)
        .setScrollFactor(0)
        // The **last** layer is the near one and goes in front of the clouds;
        // every earlier one goes behind them. `parallaxFar + i` would have put
        // the near ridge at −21, exactly where the clouds are.
        .setDepth(i === c.MOUNTAIN_LAYERS - 1 ? DEPTH.parallax : DEPTH.parallaxFar + i)
      this.ridges.push(ts)
      this.lastRidgeTint.push(-1)
    }

    const cloudKey = cloudTexture(scene)
    for (let i = 0; i < c.CLOUD_COUNT; i++) {
      const make = () =>
        scene.add
          .image(0, 0, cloudKey)
          .setOrigin(0.5, 0.5)
          .setScrollFactor(0)
          .setDepth(DEPTH.parallaxClouds)
          .setVisible(false)
      this.cloudGfx.push(make())
      this.cloudTwins.push(make())
    }

    // §D0/§C14: the pack's own clouds when the atlas loaded, T15.03's procedural
    // blobs when it did not. Resolved once here rather than per frame — the
    // answer cannot change mid-round, and `docs/50` §8's fallback must not cost
    // a texture lookup twelve times a frame to stay silent.
    this.cloudAtlas = scene.textures.exists(CLOUD_ATLAS_KEY) ? CLOUD_ATLAS_KEY : null
    if (!this.cloudAtlas) {
      // Once. Twelve clouds x 60 fps is how a warning becomes noise nobody reads.
      console.warn(
        `cloud atlas "${CLOUD_ATLAS_KEY}" is not loaded — falling back to procedural blobs`,
      )
    }

    this.setSeed(seed, themeId)
  }

  /**
   * Point the background at a map.
   *
   * Called after every generate, so a regenerate in the sandbox gets the new
   * seed's mountains rather than the previous map's. Rebuilding the ridge
   * textures here and nowhere else is what keeps "a seed always looks the same"
   * true across a regenerate.
   */
  setSeed(seed: number, themeId: number): void {
    const c = C()
    this.seed = seed
    this.themeId = themeId
    // Fractions of the visible rect, resolved to pixels at draw time — see the
    // `Cloud.x` doc for the zoom bug that came of doing it the other way.
    this.cloudSprites = cloudSprites(seed, c.CLOUD_COUNT)
    this.lastCloudColour = null
    this.clouds = cloudField(
      seed,
      c.CLOUD_COUNT,
      c.CLOUD_BAND_TOP,
      c.CLOUD_BAND_BOTTOM,
      c.CLOUD_SCALE_MIN,
      c.CLOUD_SCALE_MAX,
      c.CLOUD_SPEED_SPREAD,
    )
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
  }

  /**
   * The camera-space rectangle a `scrollFactor(0)` object is actually seen in.
   *
   * **Zoom applies to camera-space objects too.** The first version placed the
   * ridge at `VIEWPORT_H * MOUNTAIN_BASE_FRAC` and it drew off the bottom of the
   * frame, because at zoom Z a pinned object only shows the middle `1/Z` of the
   * viewport. `SkyLayer`'s gradient hides the same problem by being four times
   * oversized; a ridge has a horizon line in it and cannot be fudged that way.
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

  /** `skyBottom` is the gradient's own bottom colour, so the haze cannot drift. */
  update(elapsed: number, skyBottom: number, scrollX: number, u: number): void {
    if (this.hidden) return
    const c = C()
    const view = this.view()
    if (this.clock !== null) elapsed = this.clock
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

      // Re-laid out from the visible rect every frame, so the horizon stays put
      // through a zoom change (the sandbox has a zoom control, and the game runs
      // at CAMERA_ZOOM 2).
      const bandH = view.h * c.MOUNTAIN_HEIGHT_FRAC[i]!
      ts.setPosition(view.left, view.top + view.h * c.MOUNTAIN_BASE_FRAC - bandH)
      ts.setSize(view.w, bandH)
    }

    // **One darkening, not two.** `cloudTint` mixes white toward the sky and
    // scales alpha by its luminance — right for T15.03's white blob, wrong on
    // top of a sprite whose colour set already encodes the phase. See
    // `cloudSpriteTint`.
    const { color, alpha } = this.cloudAtlas
      ? cloudSpriteTint(c.CLOUD_ALPHA)
      : cloudTint(u, c.CLOUD_ALPHA, c.CLOUD_SKY_MIX, c.CLOUD_ALPHA_FLOOR)
    // Which colour SET the sprites come from (§C14), on top of which `cloudTint`
    // applies the continuous tint. Two different things: the set is white/grey/
    // black by phase, the tint is the sky's own bottom colour mixed in, and
    // §A13's lesson is that the second must be derived from the sky rather than
    // authored beside it.
    const colour = cloudColourForPhase(skyPhase(u))
    const colourChanged = colour !== this.lastCloudColour
    this.lastCloudColour = colour
    // The wrap span is the width actually on screen, so a cloud leaving the right
    // edge re-enters at the left one however far the camera is zoomed in.
    const span = view.w
    const yScale = view.h / c.VIEWPORT_H
    for (let i = 0; i < this.clouds.length; i++) {
      const cloud = this.clouds[i]!
      const img = this.cloudGfx[i]!
      const twin = this.cloudTwins[i]!
      // Parallax applied here rather than through `scrollFactor`, because the
      // wrap has to happen in the same space the drift does — otherwise the
      // camera moves a cloud out of the span and the twin lands nowhere useful.
      const x =
        ((cloudX(cloud, elapsed, c.CLOUD_DRIFT, span) - scrollX * c.CLOUD_PARALLAX) % span + span) %
        span
      // Apparent size held constant through a zoom, like the ridge band.
      const scale = cloud.scale * yScale
      const y = view.top + cloud.y * view.h
      const halfW = (c.CLOUD_TEX_W / 2) * scale

      // Swap the texture, never the geometry. Every sprite is displayed at the
      // same `CLOUD_TEX_W x CLOUD_TEX_H * scale` the procedural blob was, so
      // `halfW`, the wrap and the parallax below are bit-for-bit T15.03's — this
      // task changes what a cloud looks like and nothing about where it is.
      if (this.cloudAtlas && colourChanged) {
        const frame = cloudFrame(colour, this.cloudSprites[i]!)
        if (this.scene.textures.getFrame(this.cloudAtlas, frame)) {
          img.setTexture(this.cloudAtlas, frame)
          twin.setTexture(this.cloudAtlas, frame)
          img.setDisplaySize(c.CLOUD_TEX_W * scale, c.CLOUD_TEX_H * scale)
          twin.setDisplaySize(c.CLOUD_TEX_W * scale, c.CLOUD_TEX_H * scale)
        }
      }

      img.setVisible(true).setPosition(view.left + x, y).setScale(scale).setAlpha(alpha)
      const tx = cloudTwinX(x, span, halfW)
      if (tx === null) {
        twin.setVisible(false)
      } else {
        twin.setVisible(true).setPosition(view.left + tx, y).setScale(scale).setAlpha(alpha)
      }
      if (color !== this.lastCloudTint) {
        img.setTint(color)
        twin.setTint(color)
      }
    }
    this.lastCloudTint = color
  }

  /**
   * Show or hide the whole band.
   *
   * Exists for `living-sky`'s control frame: the only way to prove a ridge pixel
   * is a ridge and not the gradient behind it is to take the ridge away.
   */
  setVisible(on: boolean): void {
    for (const r of this.ridges) r.setVisible(on)
    for (const g of this.cloudGfx) g.setVisible(on)
    // Twins are only ever shown by `update`, and only for the clouds that
    // straddle an edge this frame. Showing them all here would put a duplicate
    // of every cloud a span away for one frame.
    for (const g of this.cloudTwins) g.setVisible(false)
    this.hidden = !on
  }

  destroy(): void {
    for (const r of this.ridges) r.destroy()
    for (const g of this.cloudGfx) g.destroy()
    for (const g of this.cloudTwins) g.destroy()
    this.ridges.length = 0
    this.cloudGfx.length = 0
    this.cloudTwins.length = 0
    for (const key of this.ridgeKeys) {
      if (this.scene.textures.exists(key)) this.scene.textures.remove(key)
    }
    this.ridgeKeys = []
  }

  /** Pin or release the drift clock. `null` resumes. */
  setClock(t: number | null): void {
    this.clock = t
  }

  /** For the browser check: what is on screen, without reading pixels. */
  debug(): {
    seed: number
    ridges: number
    clouds: number
    visibleClouds: number
    span: number
    /** Where the clouds actually are this frame, in screen-space px, sorted. */
    cloudXs: number[]
    /** The tint Phaser is holding on a cloud sprite, as 0xRRGGBB. */
    cloudTint: number
    cloudAlpha: number
    /** And on the near ridge, for the same reason. */
    ridgeTint: number
    /**
     * Which cloud path is live: the pack atlas, or T15.03's procedural blob.
     *
     * A check comparing the sprite's tint against `cloudTint` is comparing it
     * against the wrong function when the atlas is loaded — the two paths tint
     * differently on purpose (`cloudSpriteTint`), and without this the check
     * cannot tell which one it is looking at.
     */
    cloudAtlas: string | null
    /** The frame each cloud is showing, so a check can see the colour set move. */
    cloudFrames: string[]
  } {
    return {
      seed: this.seed,
      ridges: this.ridges.length,
      clouds: this.clouds.length,
      visibleClouds: this.cloudGfx.filter((g) => g.visible).length,
      span: this.view().w,
      // The **drawn** positions, not the field's own numbers. The zoom bug lived
      // entirely in the gap between those two: the field was evenly spread and
      // the frame was not, and a check reading the field would have agreed with
      // the field.
      cloudXs: this.cloudGfx.map((g) => g.x).sort((a, b) => a - b),
      // Read back off the sprite, not remembered from the last `update`. This
      // is the §A39 "count it at both ends" half: `cloudTint` can be perfectly
      // correct while `setTint` is never called, and every pixel assertion in
      // `living-sky` passes for that build — measured, not assumed.
      cloudTint: this.cloudGfx[0]?.tintTopLeft ?? 0,
      cloudAlpha: this.cloudGfx[0]?.alpha ?? 0,
      ridgeTint: this.ridges[this.ridges.length - 1]?.tintTopLeft ?? 0,
      cloudAtlas: this.cloudAtlas,
      cloudFrames: this.cloudGfx.map((g) => String(g.frame?.name ?? '')),
    }
  }
}
