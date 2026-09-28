import { describe, expect, it } from 'vitest'
import {
  diffTombstones,
  withinNameRange,
  type TombstoneView,
} from './tombstones-math'

const t = (id: number, x = 0, y = 0): TombstoneView => ({
  id,
  owner: 1,
  x,
  y,
})

describe('diffTombstones', () => {
  it('adds graves the server has and the screen does not', () => {
    const d = diffTombstones([], [t(1), t(2)])
    expect(d.add.map((v) => v.id)).toEqual([1, 2])
    expect(d.remove).toEqual([])
  })

  it('removes graves the server evicted', () => {
    // MAX_TOMBSTONES eviction: a client that keeps drawing one the server
    // forgot is the same leak as an item drawn by nothing, in reverse.
    const d = diffTombstones([1, 2, 3], [t(2), t(3)])
    expect(d.remove).toEqual([1])
    expect(d.add).toEqual([])
  })

  it('keeps a grave that is already drawn rather than re-adding it', () => {
    // A grave falls when its ground is carved, so its position changes while its
    // id does not. Returning it in `add` would rebuild the sprite every tick it
    // was falling — invisible on screen, and wrong.
    const d = diffTombstones([1], [t(1, 500, 900)])
    expect(d.add).toEqual([])
    expect(d.remove).toEqual([])
  })

  it('is stable when nothing changed', () => {
    const d = diffTombstones([1, 2], [t(1), t(2)])
    expect(d.add).toEqual([])
    expect(d.remove).toEqual([])
  })
})

describe('withinNameRange', () => {
  it('includes a grave at the range and excludes one past it', () => {
    expect(withinNameRange({ x: 100, y: 0 }, { x: 0, y: 0 }, 100)).toBe(true)
    expect(withinNameRange({ x: 101, y: 0 }, { x: 0, y: 0 }, 100)).toBe(false)
  })
})
