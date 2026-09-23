import { describe, expect, it } from 'vitest'
import { canvasToCss, isOnScreen, worldToCanvas, worldToCss, type Rect } from './feelLayer-math'

/**
 * The real thing: a 1280x720 canvas at CAMERA_ZOOM 2 shows 640x360 of world
 * (§A1), so `worldView` is 640x360 wherever the camera happens to be.
 */
const view: Rect = { x: 1000, y: 500, width: 640, height: 360 }
const CANVAS_W = 1280
const CANVAS_H = 720

describe('worldToCanvas', () => {
  it('maps the visible rectangle onto the canvas corner to corner', () => {
    expect(worldToCanvas({ x: 1000, y: 500 }, view, CANVAS_W, CANVAS_H)).toEqual({ x: 0, y: 0 })
    expect(worldToCanvas({ x: 1640, y: 860 }, view, CANVAS_W, CANVAS_H)).toEqual({
      x: 1280,
      y: 720,
    })
  })

  it('puts the centre of the view at the centre of the canvas', () => {
    expect(worldToCanvas({ x: 1320, y: 680 }, view, CANVAS_W, CANVAS_H)).toEqual({ x: 640, y: 360 })
  })

  /**
   * This is the §A35 regression. At zoom 2 the world is *magnified*: 1 world px
   * is 2 canvas px. An implementation that forgot the zoom would put a point
   * 100 world px from the view origin at canvas x=100 instead of x=200.
   */
  it('applies the zoom implied by the view, which is the bug this file exists for', () => {
    const p = worldToCanvas({ x: 1100, y: 500 }, view, CANVAS_W, CANVAS_H)
    expect(p.x).toBe(200)
    expect(p.x).not.toBe(100)
  })

  it('does not produce NaN for a degenerate view', () => {
    const p = worldToCanvas({ x: 5, y: 5 }, { x: 0, y: 0, width: 0, height: 0 }, CANVAS_W, CANVAS_H)
    expect(Number.isNaN(p.x)).toBe(false)
    expect(p).toEqual({ x: 0, y: 0 })
  })
})

describe('canvasToCss', () => {
  it('is the identity when the canvas is displayed at its own size at the origin', () => {
    const rect = { x: 0, y: 0, width: CANVAS_W, height: CANVAS_H }
    expect(canvasToCss({ x: 300, y: 200 }, rect, CANVAS_W, CANVAS_H)).toEqual({ x: 300, y: 200 })
  })

  /** Scale.FIT letterboxes: a 640x360 display of a 1280x720 canvas, offset. */
  it('accounts for a letterboxed, scaled canvas', () => {
    const rect = { x: 40, y: 100, width: 640, height: 360 }
    expect(canvasToCss({ x: 1280, y: 720 }, rect, CANVAS_W, CANVAS_H)).toEqual({ x: 680, y: 460 })
    expect(canvasToCss({ x: 640, y: 360 }, rect, CANVAS_W, CANVAS_H)).toEqual({ x: 360, y: 280 })
  })
})

describe('worldToCss', () => {
  it('composes both stages', () => {
    const rect = { x: 40, y: 100, width: 640, height: 360 }
    // World centre -> canvas centre -> CSS centre of the displayed rect.
    expect(worldToCss({ x: 1320, y: 680 }, view, rect, CANVAS_W, CANVAS_H)).toEqual({
      x: 360,
      y: 280,
    })
  })
})

describe('isOnScreen', () => {
  it('accepts points inside and rejects points well outside', () => {
    expect(isOnScreen({ x: 1320, y: 680 }, view)).toBe(true)
    expect(isOnScreen({ x: 4000, y: 680 }, view)).toBe(false)
  })

  it('keeps a point just off the edge mounted, so a rising number does not pop', () => {
    expect(isOnScreen({ x: 1000, y: 480 }, view, 64)).toBe(true)
    expect(isOnScreen({ x: 1000, y: 400 }, view, 64)).toBe(false)
  })
})
