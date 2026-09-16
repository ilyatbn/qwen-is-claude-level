import { describe, expect, it } from 'vitest'
import { multiplyTint, tintedKey } from './canvasTint'

const TINT = 0xff8a7a
const TR = (TINT >> 16) & 255
const TG = (TINT >> 8) & 255
const TB = TINT & 255

describe('multiplyTint', () => {
  it('turns white into the tint and leaves black black, keeping alpha', () => {
    const d = new Uint8ClampedArray([255, 255, 255, 200, 0, 0, 0, 255])
    multiplyTint(d, TINT)
    expect([...d]).toEqual([TR, TG, TB, 200, 0, 0, 0, 255])
  })

  it('scales each channel by its own tint channel, as the WebGL tint does', () => {
    const d = new Uint8ClampedArray([100, 100, 100, 0])
    multiplyTint(d, TINT)
    expect([...d]).toEqual([
      Math.round((100 * TR) / 255),
      Math.round((100 * TG) / 255),
      Math.round((100 * TB) / 255),
      0,
    ])
    // The control: a white tint is the identity.
    const e = new Uint8ClampedArray([12, 34, 56, 78])
    multiplyTint(e, 0xffffff)
    expect([...e]).toEqual([12, 34, 56, 78])
  })
})

describe('tintedKey', () => {
  it('is distinct per tint and pads the hex', () => {
    expect(tintedKey('chars', TINT)).not.toBe(tintedKey('chars', 0x00ff00))
    expect(tintedKey('chars', 0x00ff00)).toBe('chars__tint_00ff00')
  })
})
