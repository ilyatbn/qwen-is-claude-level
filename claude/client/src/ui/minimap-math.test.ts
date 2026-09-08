import { describe, expect, it } from 'vitest'
import {
  ExploredMask,
  radiusToCells,
  visibleRemotes,
  worldToCell,
  worldToMinimap,
  type MinimapGeometry,
} from './minimap-math'

/** MINIMAP_W/H against a large map, which is the default scale (§A1). */
const g: MinimapGeometry = { mapW: 4096, mapH: 2048, w: 200, h: 100 }

describe('worldToCell', () => {
  it('is exact at both corners', () => {
    expect(worldToCell(0, 0, g)).toEqual({ x: 0, y: 0 })
    // The far corner maps one past the last cell; callers clamp to w-1.
    expect(worldToCell(4096, 2048, g)).toEqual({ x: 200, y: 100 })
    expect(worldToCell(4095, 2047, g)).toEqual({ x: 199, y: 99 })
  })

  it('puts the middle of the world in the middle of the minimap', () => {
    expect(worldToCell(2048, 1024, g)).toEqual({ x: 100, y: 50 })
  })

  it('keeps the aspect ratio, so the map is not stretched', () => {
    // 4096/200 = 20.48 world px per cell across; 2048/100 = 20.48 down.
    const a = worldToMinimap(2048, 0, g)
    const b = worldToMinimap(0, 1024, g)
    expect(a.x).toBeCloseTo(100)
    expect(b.y).toBeCloseTo(50)
  })
})

describe('radiusToCells', () => {
  it('converts MINIMAP_REVEAL_R into cells', () => {
    // 260 world px on a 4096-wide map at 200 cells = 12.7 -> 13.
    expect(radiusToCells(260, g)).toBe(13)
  })

  it('never rounds a real radius down to nothing', () => {
    expect(radiusToCells(1, g)).toBe(1)
    expect(radiusToCells(0, g)).toBe(1)
  })
})

describe('ExploredMask', () => {
  it('reveals a disc of about the right area', () => {
    const m = new ExploredMask(200, 100)
    const painted = m.revealCells(100, 50, 10)
    // pi*r^2 = 314; integer span fill lands close.
    expect(painted).toBeGreaterThan(280)
    expect(painted).toBeLessThan(350)
    expect(m.at(100, 50)).toBe(255)
    expect(m.at(100, 61)).toBe(0) // just outside r=10
  })

  it('is idempotent — revealing the same disc twice paints nothing new', () => {
    const m = new ExploredMask(200, 100)
    const first = m.revealCells(50, 50, 8)
    const second = m.revealCells(50, 50, 8)
    expect(first).toBeGreaterThan(0)
    expect(second).toBe(0)
    expect(m.exploredCount).toBe(first)
  })

  it('only ever grows — a later reveal elsewhere never unsets an earlier one', () => {
    const m = new ExploredMask(200, 100)
    m.revealCells(20, 20, 6)
    const after = m.exploredCount
    m.revealCells(150, 80, 6)
    expect(m.exploredCount).toBeGreaterThan(after)
    expect(m.at(20, 20)).toBe(255)
  })

  it('clips at the edges instead of wrapping onto the next row', () => {
    const m = new ExploredMask(200, 100)
    m.revealCells(0, 50, 5)
    // A wrap would light cells at the right-hand end of the same rows.
    expect(m.at(199, 50)).toBe(0)
    expect(m.at(199, 49)).toBe(0)
    expect(m.at(0, 50)).toBe(255)
  })

  it('does not panic or paint on a negative radius', () => {
    const m = new ExploredMask(200, 100)
    expect(m.revealCells(10, 10, -3)).toBe(0)
    expect(m.exploredCount).toBe(0)
  })
})

describe('visibleRemotes', () => {
  const me = { x: 1000, y: 1000 }

  it('shows a player inside the FoV', () => {
    expect(visibleRemotes(me, [{ x: 1100, y: 1000 }], 220)).toHaveLength(1)
  })

  /**
   * §A6, and the reason this function exists: the minimap must not leak a
   * position the screen is not already giving you.
   */
  it('hides a player outside the FoV', () => {
    expect(visibleRemotes(me, [{ x: 1400, y: 1000 }], 220)).toHaveLength(0)
  })

  it('is exact at the boundary', () => {
    expect(visibleRemotes(me, [{ x: 1220, y: 1000 }], 220)).toHaveLength(1)
    expect(visibleRemotes(me, [{ x: 1221, y: 1000 }], 220)).toHaveLength(0)
  })

  it('shrinks what it shows when the FoV shrinks, which is what night does', () => {
    const others = [
      { x: 1100, y: 1000 },
      { x: 1300, y: 1000 },
      { x: 1600, y: 1000 },
    ]
    expect(visibleRemotes(me, others, 640)).toHaveLength(3)
    expect(visibleRemotes(me, others, 220)).toHaveLength(1)
  })
})
