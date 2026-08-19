/**
 * Camera clamp maths (T1.10 step 1), kept pure so it can be unit tested
 * without Phaser (D10). `GameScene` delegates its bounds to Phaser's
 * `setBounds`, which applies exactly this rule; this module exists so the
 * behaviour is asserted rather than assumed.
 */

/** A camera viewport clamped to map bounds. */
export interface Viewport {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * Clamp a camera scroll position to the map (docs/01 §1: bounds are
 * `(width*16, height*16)`).
 *
 * If the viewport is larger than the map on an axis, the map is centred on
 * that axis rather than jammed to one edge.
 */
export function clampCamera(
  scrollX: number,
  scrollY: number,
  viewWidth: number,
  viewHeight: number,
  mapWidth: number,
  mapHeight: number,
): { x: number; y: number } {
  const clampAxis = (scroll: number, view: number, map: number): number => {
    if (view >= map) {
      return (map - view) / 2;
    }
    return Math.min(Math.max(scroll, 0), map - view);
  };
  return {
    x: clampAxis(scrollX, viewWidth, mapWidth),
    y: clampAxis(scrollY, viewHeight, mapHeight),
  };
}
