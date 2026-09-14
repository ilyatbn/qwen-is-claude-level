/**
 * §C14's living background: mountain silhouettes, and clouds when the machine
 * can paint them.
 *
 * The parallax band at depth −20 that T3.06 deliberately left empty because there
 * was nothing to put in it. All the maths is in `sky-math.ts` (§A8); this file
 * only draws, and it is owned by `SkyLayer` so that every scene with a sky gets
 * it without opting in — the alternative is three scenes and one of them
 * forgetting, which is how twelve mechanisms on this project ended up wired to
 * nothing.
 *
 * ## The clouds changed shape in T21.18, and the sky got emptier
 *
 * Until T21.18 the clouds were **real sprite artwork**: an atlas of 120 frames
 * in three colour sets, drawn by a pool of twelve `Image`s plus a wrap twin
 * each, tinted per cloud and per phase. The coordinator did not like them — *"i
 * dont really like the current clouds so disable them and make them shaders too
 * if High Quality is enabled."*
 *
 * So that whole path is gone, and **with High Quality off this layer now draws
 * no clouds at all.** That is a deliberate visible loss, not a fallback for a
 * weak machine: the sprites were not wanted in either mode. `CLOUD_FRAGMENT` is
 * the replacement and it needs WebGL, so a canvas-only browser gets the same
 * empty sky the toggle-off path gets.
 *
 * What survives untouched: `CLOUD_BAND_TOP`/`CLOUD_BAND_BOTTOM` still say where
 * clouds live, `CLOUD_DRIFT` and `CLOUD_PARALLAX` still say how fast they cross
 * and how much the camera moves them, and `cloudTint` still says what colour and
 * what opacity the phase asks for. The shader is handed those numbers rather
 * than re-deciding them, so the sky's response to the time of day is the one
 * `sky-math.test.ts` already covers.
 *
 * ## One draw each, no texture rebuilt per frame
 *
 * The ridge is baked **white** into a canvas once per seed and drawn as a
 * `TileSprite`, which wraps for free; the phase response is `setTint`, which
 * costs nothing and is guarded so it only fires when the colour moves. The
 * clouds are one quad with uniforms written to it.
 *
 * That is the claim, and it is deliberately narrower than "allocates nothing":
 * `cloudTint` returns a small object each frame and the visible-rect maths is
 * kept in a reused field rather than a fresh literal. What §C14 is protecting is
 * the megapixel canvas, and that is built once.
 */

import Phaser from 'phaser'
import { ridgeLayout, type RidgeLayout } from './parallax-math'
import { C } from '../core'
import { DEPTH } from './backdrop'
import { cloudTint, mountainProfile } from './sky-math'
import { CLOUD_FRAGMENT, hasWebGL, rgbToUniform3f } from './shaders'
import { isHighQuality, onHighQualityChange } from '../ui/settings'
import { resolveTheme } from './themes-math'

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
   * Pins the drift clock, for a check that needs a known picture.
   *
   * Diagnostic seam, like `setZoom`. **Every moving quantity the cloud shader
   * receives is derived from `elapsed`**, so pinning this freezes the sky
   * completely — which is what lets `clouds-shader` measure "this patch changed
   * because the clouds moved" against a control where it must not have. A
   * shader reading its own `time` uniform would have no such control.
   */
  private clock: number | null = null

  /**
   * The High Quality clouds, or `null` on a machine with no WebGL.
   *
   * **There is no other cloud path** since T21.18 — see the file header. A
   * canvas-only browser gets an empty sky, which is the same sky the toggle-off
   * path gives every machine.
   */
  private cloudShader: Phaser.GameObjects.Shader | null = null
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
      if (i === c.MOUNTAIN_LAYERS - 1) {
        this.skirt = scene.add.graphics().setScrollFactor(0).setDepth(ts.depth).setVisible(false)
      }
      this.lastRidgeTint.push(-1)
    }

    // --- T21.18: the clouds, and only when the machine and the player both
    // --- want them.
    //
    // Asked of the renderer rather than assumed from the config: `Phaser.AUTO`
    // decides at boot, and a canvas fallback handed a shader draws nothing while
    // reporting success. The quad is sized and placed in `update`, from the same
    // visible rect the ridges use — a `scrollFactor(0)` object still lives in
    // camera space, and at zoom 2 that is half the viewport.
    if (hasWebGL(scene)) {
      const base = new Phaser.Display.BaseShader('cloudBand', CLOUD_FRAGMENT, undefined, {
        alpha: { type: '1f', value: 0 },
        offset: { type: '1f', value: 0 },
        evolve: { type: '1f', value: 0 },
        seed: { type: '1f', value: 0 },
        // **`{x, y, z}`, not an array** — see `rgbToUniform3f`. An array binds
        // three `undefined`s and the clouds come out black with no error.
        tint: { type: '3f', value: rgbToUniform3f(0xffffff) },
      })
      this.cloudShader = scene.add
        .shader(base, 0, 0, w, Math.round(h * (c.CLOUD_BAND_BOTTOM - c.CLOUD_BAND_TOP)))
        .setOrigin(0, 0)
        .setScrollFactor(0)
        .setDepth(DEPTH.parallaxClouds)
        .setVisible(false)
    }
    // A live toggle: a setting that needs a restart is one the player flips,
    // sees nothing, and flips back (T21.16).
    this.unsubscribeQuality = onHighQualityChange(() => this.applyQuality())

    // No map yet: the title never gets one, and a scene gives it with its seed.
    this.setSeed(seed, themeId, 0)
    this.applyQuality()
  }

  /**
   * Is the shader path in use right now?
   *
   * **All three halves matter.** The setting can be on where WebGL is not, and
   * the whole band can be hidden for a check's control frame — and in either
   * case there is nothing else to fall back to.
   */
  private useShader(): boolean {
    return this.cloudShader !== null && isHighQuality() && !this.hidden
  }

  /**
   * Show or hide the clouds to match the setting, **now**.
   *
   * Applied here rather than left to the next frame, for the reason
   * `WeatherLayer.applyQuality` is: `cloudsAreShader` reads the object's own
   * visibility, so a toggle that waited for `update` would tell whoever just
   * flipped it the old answer — a wrong read for a check, and a frame of
   * flicker for a player.
   */
  private applyQuality(): void {
    this.cloudShader?.setVisible(this.useShader())
  }

  /**
   * Are the clouds actually being painted?
   *
   * Read off the object rather than off the setting, because the setting can be
   * on where WebGL is not. That is the honest answer and the one a check needs.
   */
  get cloudsAreShader(): boolean {
    return this.cloudShader?.visible ?? false
  }

  /**
   * Point the background at a map.
   *
   * Called after every generate, so a regenerate in the sandbox gets the new
   * seed's mountains rather than the previous map's. Rebuilding the ridge
   * textures here and nowhere else is what keeps "a seed always looks the same"
   * true across a regenerate.
   */
  setSeed(seed: number, themeId: number, mapH: number): void {
    const c = C()
    this.seed = seed
    this.themeId = themeId
    // T21.20: required, not defaulted — 0 is the title's screen layout, so a scene
    // that forgot to pass its map would silently float the mountains again.
    this.mapH = mapH
    // One seed, one sky: the shader offsets its noise by the seed, so a
    // regenerate gets a different cloudscape and the same seed gets the same
    // one — the claim `living-sky` makes of the ridge, now true of the clouds
    // for the same reason and by the same route.
    this.cloudShader?.setUniform('seed.value', (seed >>> 0) % 997)
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
    const z = this.scene.cameras.main.zoom || 1
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

      // **T21.20: anchored to the world when there is a map** — `parallax-math.ts`
      // has the rule and its tests. It was laid out against the visible rect, which
      // is why the skyline rode with the camera and halved at `CAMERA_ZOOM` 2.
      // `ridgeLayout` answers in viewport px; this object is `scrollFactor(0)`, so it
      // lives in camera space, where the screen's top row is `view.top` and a
      // viewport px is 1/zoom of a unit. Width and the horizontal tile offset are
      // unchanged: it still parallaxes sideways at `MOUNTAIN_PARALLAX`.
      const lay = this.layout(i)
      ts.setPosition(view.left, view.top + lay.top / z)
      ts.setSize(view.w, lay.h / z)
      if (this.skirt && i === this.ridges.length - 1) {
        // Camera space: one unit is one world px here, because the ridge is world-sized.
        const top = view.top + (lay.top + lay.h) / z
        const h = c.MOUNTAIN_FOOT_FADE
        const onScreen = top < view.top + view.h && top + h > view.top
        this.skirt.clear()
        this.skirt.setVisible(lay.worldBase !== null && onScreen && !this.hidden)
        this.skirtY = top
        this.skirtH = h
        if (this.skirt.visible) {
          // Opaque at the base, transparent at the bottom of the fade.
          this.skirt.fillGradientStyle(tint, tint, tint, tint, 1, 1, 0, 0)
          this.skirt.fillRect(view.left, top, view.w, h)
        }
      }
    }

    // --- the clouds (T21.18) ------------------------------------------------
    //
    // `cloudTint` is unchanged and still decides the colour and the opacity for
    // this point in the day: the shader is handed its answer rather than
    // re-deciding it in GLSL, so the sky's phase response stays the one
    // `sky-math.test.ts` covers and there is only one place it can be wrong.
    const { color, alpha } = cloudTint(u, c.CLOUD_ALPHA, c.CLOUD_SKY_MIX, c.CLOUD_ALPHA_FLOOR)
    const sh = this.cloudShader
    if (sh && this.useShader()) {
      // The band, in the rect that is actually on screen. Same derivation as the
      // ridge above and for the same reason: a `scrollFactor(0)` object is in
      // camera space and zoom shrinks that.
      const bandTop = view.top + view.h * c.CLOUD_BAND_TOP
      const bandH = view.h * (c.CLOUD_BAND_BOTTOM - c.CLOUD_BAND_TOP)
      sh.setPosition(view.left, bandTop)
      // `setSize`, not `setDisplaySize`. The latter scales the quad and leaves
      // the `resolution` uniform — which Phaser fills from `width`/`height` —
      // describing the size it was built at, so the field would be sampled
      // against one rectangle and drawn into another.
      sh.setSize(view.w, bandH)

      // **One number for everything that moves it horizontally**, in band
      // widths: `CLOUD_DRIFT` px/s of its own drift, plus `CLOUD_PARALLAX` of
      // the camera's scroll. Both are the constants the sprites used, so a
      // cloud crosses the sky at the speed it always did and the camera moves it
      // by as much as it always did.
      const span = view.w
      sh.setUniform('offset.value', (elapsed * c.CLOUD_DRIFT - scrollX * c.CLOUD_PARALLAX) / span)
      // The wall clock, in seconds, for the shapes themselves: a deck that only
      // slides reads as wallpaper. How slowly it reshapes is a GLSL constant
      // inside the shader, beside the rest of the look — the same place
      // `FOG_FRAGMENT` keeps its own.
      //
      // **Also derived from `elapsed`**, so `setClock` freezes the whole effect
      // and a check gets a real control frame.
      sh.setUniform('evolve.value', elapsed)
      sh.setUniform('alpha.value', alpha)
      sh.setUniform('tint.value', rgbToUniform3f(color))
    }
  }

  /**
   * Show or hide the whole band.
   *
   * Exists for `living-sky`'s control frame: the only way to prove a ridge pixel
   * is a ridge and not the gradient behind it is to take the ridge away.
   */
  setVisible(on: boolean): void {
    for (const r of this.ridges) r.setVisible(on)
    if (!on) this.skirt?.setVisible(false)
    // **The latch is set before the clouds are asked.** `useShader` reads it, so
    // setting it afterwards would show the shader for exactly as long as it took
    // to reach the next line — and `cloudsAreShader`, which a check reads
    // immediately, would answer from that gap.
    this.hidden = !on
    this.applyQuality()
  }

  destroy(): void {
    for (const r of this.ridges) r.destroy()
    this.skirt?.destroy()
    this.skirt = null
    this.ridges.length = 0
    this.cloudShader?.destroy()
    this.cloudShader = null
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

  /** Pin or release the drift clock. `null` resumes. */
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
    /**
     * Are the clouds being painted right now?
     *
     * Read off the shader object, not off the setting (§A39's both-ends rule in
     * its smallest form): the setting can be on where WebGL is not, and since
     * T21.18 there is no sprite fallback to take over — the answer is then
     * honestly "no clouds", and a check told otherwise would go looking for
     * pixels that cannot exist.
     */
    shaderClouds: boolean
    /**
     * Where the cloud band is on screen, in client pixels.
     *
     * Converted here for the reason the cloud boxes used to be: these are
     * `scrollFactor(0)` objects living in camera space, and at `CAMERA_ZOOM` 2
     * the visible rect is 640 wide against a 1280 px viewport. A check that
     * clipped a screenshot with the raw numbers would sample the wrong part of
     * the sky.
     */
    cloudBand: { x: number; y: number; w: number; h: number }
    /**
     * T21.20: where the **near** ridge is — viewport px, plus its world base and
     * height (`null` on the title) — from the same `ridgeLayout` call `update`
     * places it with, and the sprite's own camera-space rect beside it, so a check
     * can see the formula and the object disagree.
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
    const sy = c.VIEWPORT_H / v.h
    return {
      seed: this.seed,
      ridges: this.ridges.length,
      span: v.w,
      ridgeTint: this.ridges[this.ridges.length - 1]?.tintTopLeft ?? 0,
      shaderClouds: this.cloudsAreShader,
      cloudBand: {
        x: 0,
        y: v.h * c.CLOUD_BAND_TOP * sy,
        w: c.VIEWPORT_W,
        h: v.h * (c.CLOUD_BAND_BOTTOM - c.CLOUD_BAND_TOP) * sy,
      },
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
