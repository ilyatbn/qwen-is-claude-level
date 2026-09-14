/**
 * T21.20 — where the background ridge is drawn, as arithmetic (no Phaser here).
 *
 * ## One cause, two symptoms
 *
 * Reported from play: *"the background mountains are very small and are in the
 * air."* Both came from laying the ridge out against the camera's **visible
 * rect**. Positioned at a fraction of it, the ridge rode with the camera while the
 * terrain stayed put — climb, and the skyline detached from the ground. Sized at a
 * fraction of it, the ridge was half the intended size at `CAMERA_ZOOM` 2, because
 * the camera sees half as much world.
 *
 * ## The rule now
 *
 * With a map, the ridge base is a **world** height (`MOUNTAIN_BASE_FRAC` of the
 * map) and the ridge a **world** size (`MOUNTAIN_HEIGHT_FRAC` of `VIEWPORT_H`, in
 * world px). Vertically it moves exactly with the terrain; horizontally it still
 * parallaxes at `MOUNTAIN_PARALLAX`, which `ParallaxLayer` applies as a tile offset.
 *
 * Without a map — the title screen — there is no world to anchor to, and the old
 * screen layout stands (`MOUNTAIN_TITLE_BASE_FRAC`).
 */

export interface RidgeLayout {
  /** Top edge on screen, viewport px (0 is the top of the canvas). */
  top: number
  /** Height on screen, viewport px. */
  h: number
  /** World y of the base, or `null` on the title where there is no world. */
  worldBase: number | null
  /** Height in world px, or `null` on the title. */
  worldH: number | null
}

export interface RidgeInput {
  /** The map's height in world px, or 0 when there is no map (the title). */
  mapH: number
  baseFrac: number
  titleBaseFrac: number
  heightFrac: number
  viewportH: number
  /** The camera's `worldView.y`: the world row at the top of the screen. */
  viewY: number
  zoom: number
}

/** Where one ridge layer sits, on screen and in the world. */
export function ridgeLayout(o: RidgeInput): RidgeLayout {
  if (o.mapH > 0) {
    const worldH = o.viewportH * o.heightFrac
    const worldBase = o.mapH * o.baseFrac
    return {
      top: (worldBase - worldH - o.viewY) * o.zoom,
      h: worldH * o.zoom,
      worldBase,
      worldH,
    }
  }
  // The title: camera space, the pre-T21.20 layout, at the title's zoom of 1.
  const h = o.viewportH * o.heightFrac
  return { top: o.viewportH * o.titleBaseFrac - h, h, worldBase: null, worldH: null }
}

/**
 * The layout T21.20 replaced — kept **only** as the unit tests' control.
 *
 * A property test that "the ridge stays put against the ground" is satisfied by
 * any function that ignores the camera, including a broken one; the control is
 * that this, the shipped behaviour the report describes, fails the same test.
 * Not exported to anything but the test: grep `screenAnchoredRidgeForTest`.
 */
export function screenAnchoredRidgeForTest(o: RidgeInput): RidgeLayout {
  const viewH = o.viewportH / o.zoom
  const h = viewH * o.heightFrac * o.zoom
  return { top: (viewH * o.titleBaseFrac) * o.zoom - h, h, worldBase: null, worldH: null }
}
