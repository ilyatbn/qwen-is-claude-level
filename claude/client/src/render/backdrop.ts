/**
 * Depth table and theme colours.
 *
 * **The sky belongs to `SkyLayer`** (`docs/70-amendments-v2.md` §A4). This file used
 * to draw a flat placeholder at `DEPTH.sky`; once the real sky arrived the two sat
 * at the same depth and the placeholder — re-created on every regenerate, therefore
 * always added last — silently painted over the gradient. Two things drawing the
 * sky is one too many.
 *
 * The **cave backdrop is what makes destruction read correctly**: without it a
 * crater punched through a hillside shows sky through it and the map looks like
 * paper rather than rock. It is baked into each chunk, not drawn here.
 */


export interface ThemeColors {
  skyPlaceholder: number
  caveBack: number
}

export const DEFAULT_THEME: ThemeColors = {
  skyPlaceholder: 0x9cc7e8,
  caveBack: 0x241f1a,
}

/** Depths from `docs/12-map-render.md` §5. */
export const DEPTH = {
  sky: -30,
  /**
   * §C14's living background, inside the −20 band `docs/12` §5 reserves.
   *
   * Three depths rather than one because the clouds sit **between** the two
   * mountain layers: `CLOUD_PARALLAX` (0.14) is between the ridges' 0.10 and
   * 0.20, and a cloud drawn in front of a ridge it scrolls behind reads as a
   * mistake immediately.
   */
  parallaxFar: -22,
  parallaxClouds: -21,
  parallax: -20,
  /**
   * Birds (§C16), **behind the terrain**.
   *
   * That is what §C16's "no collision with terrain" looks like on screen: a bird
   * crossing a mesa slides behind it instead of gliding through it. It also means
   * the altitude band can sit where players can see it rather than in the 96 px
   * of guaranteed-clear sky at the top of the world, which at CAMERA_ZOOM 2 is
   * never on screen.
   */
  birds: -19,
  caveBack: -10,
  terrain: 0,
  decorations: 10,
  worldItems: 20,
  actors: 30,
  particles: 40,
  lightmap: 50,
  /**
   * §F9's heavy-fog veil — **above** the lightmap and below the HUD.
   *
   * Two reasons, and the second is a landmine that has already been paid for
   * once elsewhere.
   *
   * *Above the lightmap* because §F9's acceptance is that the frame moves toward
   * the grey **by the alpha the constant names**. The lightmap is a MULTIPLY
   * pass; under it, the measured delta is the alpha times whatever the night
   * curve happens to be, and the acceptance stops being pinnable to a constant.
   * The FoV multiplier still compounds — it shrinks the lit circle underneath,
   * which is the "at night the two compound" §F9 asks for.
   *
   * *Below the HUD* because fog is weather, not a disability — the same rule the
   * death overlay follows.
   *
   * And the gap it sits in is load-bearing: `sceneDepths()` collects every layer
   * at `depth <= DEPTH.lightmap`, and `terrain-render.mjs` compares that list to
   * an exact string. Anything in 0..50 joins it. 55 is in the 50–60 gap, so the
   * layer-parity check keeps meaning what it meant.
   */
  fog: 55,
  hud: 60,
} as const

export class Backdrop {
  private readonly objects: Array<{ destroy(): void }> = []

  constructor(scene: Phaser.Scene, theme: ThemeColors, mapW: number, mapH: number) {
    // Nothing to draw: the sky is SkyLayer's and the cave backdrop is baked into
    // each chunk, masked by `BackdropMask`. A full-map rectangle at depth -10 would
    // hide the sky everywhere, which is what the very first preview screenshot
    // showed. The class stays as the home of the depth table and theme colours.
    void scene
    void theme
    void mapW
    void mapH
  }

  destroy(): void {
    for (const o of this.objects) o.destroy()
    this.objects.length = 0
  }
}
