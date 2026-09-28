import { describe, expect, it } from 'vitest'
import { TOMBSTONE_KEY, ensureTombstoneTexture } from './tombstoneTextures'
import { INK } from '../look/actors/draw'

/** A texture manager double: records what was drawn with which fill. */
function fakeTextures() {
  const made = new Map<string, { fills: string[]; rects: number }>()
  return {
    made,
    exists: (k: string) => made.has(k),
    createCanvas: (k: string) => {
      const rec = { fills: [] as string[], rects: 0 }
      made.set(k, rec)
      const ctx = {
        set fillStyle(v: string) {
          rec.fills.push(v)
        },
        clearRect() {},
        beginPath() {},
        arc() {},
        fill() {
          rec.rects++
        },
        fillRect() {
          rec.rects++
        },
      }
      return { getContext: () => ctx, refresh() {} }
    },
  }
}

describe('the tombstone (T23.15: one ink stone)', () => {
  it('draws one texture, in the look\'s ink, once', () => {
    const t = fakeTextures()
    ensureTombstoneTexture(t as unknown as Phaser.Textures.TextureManager)
    ensureTombstoneTexture(t as unknown as Phaser.Textures.TextureManager)
    expect([...t.made.keys()]).toEqual([TOMBSTONE_KEY])
    const rec = t.made.get(TOMBSTONE_KEY)!
    expect(rec.fills).toEqual([INK])
    expect(rec.rects).toBeGreaterThan(0)
  })
})
