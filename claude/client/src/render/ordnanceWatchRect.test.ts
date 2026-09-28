import { describe, expect, it } from 'vitest'
import { ROUND_PATCH_PX, clampRect } from './ordnanceWatchRect'

describe('clampRect (T23.14F F6)', () => {
  const W = 640
  const H = 360
  const P = ROUND_PATCH_PX
  it('a square inside the canvas is unchanged (control)', () => {
    expect(clampRect([10, 20, P, P], W, H)).toEqual([10, 20, P, P])
  })
  it('a square over an edge is cut to the canvas', () => {
    expect(clampRect([-5, H - 4, P, P], W, H)).toEqual([0, H - 4, P - 5, 4])
    expect(clampRect([W - 3, -P + 2, P, P], W, H)).toEqual([W - 3, 0, 3, 2])
  })
  it('a square wholly off the canvas is none', () => {
    expect(clampRect([-P, 0, P, P], W, H)).toBeNull()
    expect(clampRect([0, H, P, P], W, H)).toBeNull()
  })
})
