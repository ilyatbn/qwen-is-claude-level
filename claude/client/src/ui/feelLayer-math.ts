/**
 * World → screen, for DOM elements drawn over the canvas (§A8 — no Phaser here).
 *
 * ## Why this exists at all
 *
 * §A35: a Phaser object with `setScrollFactor(0)` is still scaled by camera zoom,
 * so screen-space elements land off-viewport at `CAMERA_ZOOM = 2`. The fix is to
 * draw them somewhere that does not inherit the world camera's zoom — here, the
 * DOM, which this codebase already uses for the HUD strip and the scoreboard.
 *
 * ## Why `worldView` rather than the camera transform
 *
 * Phaser zooms about the camera midpoint, so `(world - scroll) * zoom` is *not*
 * the screen position, and deriving the correct expression by hand is what failed
 * twice before. `camera.worldView` is the visible world rectangle, already
 * computed by the engine at whatever zoom is in force, so mapping through it is
 * correct by construction and stays correct if the transform ever changes.
 *
 * Two stages, because two things scale independently: world → *canvas* pixels
 * (the game's design resolution), then canvas → *CSS* pixels, because
 * `Scale.FIT` letterboxes the canvas inside the window.
 */

export interface Rect {
  x: number
  y: number
  width: number
  height: number
}

export interface Vec2 {
  x: number
  y: number
}

/**
 * World point → canvas pixel, via the camera's visible world rectangle.
 *
 * A degenerate `worldView` (zero width or height, which happens for one frame
 * before the camera is sized) maps everything to the canvas origin rather than
 * producing `NaN` — a `NaN` here silently removes the element from the layout,
 * which looks exactly like the bug §A35 describes.
 */
export function worldToCanvas(p: Vec2, view: Rect, canvasW: number, canvasH: number): Vec2 {
  if (view.width <= 0 || view.height <= 0) return { x: 0, y: 0 }
  return {
    x: ((p.x - view.x) / view.width) * canvasW,
    y: ((p.y - view.y) / view.height) * canvasH,
  }
}

/**
 * Canvas pixel → CSS pixel inside the page.
 *
 * `Scale.FIT` centres the canvas and scales it uniformly, so the CSS rect is the
 * canvas's own bounding box and one multiply plus the offset is the whole mapping.
 */
export function canvasToCss(p: Vec2, canvasRect: Rect, canvasW: number, canvasH: number): Vec2 {
  if (canvasW <= 0 || canvasH <= 0) return { x: canvasRect.x, y: canvasRect.y }
  return {
    x: canvasRect.x + (p.x / canvasW) * canvasRect.width,
    y: canvasRect.y + (p.y / canvasH) * canvasRect.height,
  }
}

/** The two stages together, which is what a caller almost always wants. */
export function worldToCss(
  p: Vec2,
  view: Rect,
  canvasRect: Rect,
  canvasW: number,
  canvasH: number,
): Vec2 {
  return canvasToCss(worldToCanvas(p, view, canvasW, canvasH), canvasRect, canvasW, canvasH)
}

/**
 * Is this world point inside the visible rectangle, with a margin?
 *
 * Damage numbers rise as they fade, so an element that is on-screen *now* may
 * leave; the margin keeps it mounted rather than popping out mid-animation.
 */
export function isOnScreen(p: Vec2, view: Rect, marginPx = 64): boolean {
  return (
    p.x >= view.x - marginPx &&
    p.x <= view.x + view.width + marginPx &&
    p.y >= view.y - marginPx &&
    p.y <= view.y + view.height + marginPx
  )
}
