/** T23.14F F6: the read rects of `ordnanceWatch.ts`, kept out of its Phaser import so they can be unit-tested. */
/** The side of the square read around a round, canvas px. */
export const ROUND_PATCH_PX = 24

export type Rect = readonly [number, number, number, number]

/** `r` cut to a `w`×`h` canvas; null when nothing of it is on the canvas. */
export function clampRect([x, y, w, h]: Rect, cw: number, ch: number): Rect | null {
  const x0 = Math.max(0, x)
  const y0 = Math.max(0, y)
  const x1 = Math.min(cw, x + w)
  const y1 = Math.min(ch, y + h)
  return x1 > x0 && y1 > y0 ? [x0, y0, x1 - x0, y1 - y0] : null
}
