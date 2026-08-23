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
  caveBack: -10,
  terrain: 0,
  decorations: 10,
  worldItems: 20,
  actors: 30,
  particles: 40,
  lightmap: 50,
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
