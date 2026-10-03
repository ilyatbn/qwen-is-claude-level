import { describe, it, expect } from 'vitest'
import { gunAt, muzzleDir, SPAWN_BODY_LAG_S } from './muzzle-math'

// Arbitrary geometry; the muzzle and body sizes are parameters here, the scene passes the constants.
const OFF = 18
const H = 40

describe('muzzleDir and gunAt (T23.35)', () => {
  it('puts a moving shooter’s round at his drawn gun, along its own direction', () => {
    // Server: shooter at (100, 100) falling fast, round spawned OFF px right of him. Drawn 87 px higher (interpolated).
    const server = { x: 100, y: 100, vx: 0, vy: 870 }
    const dir = muzzleDir({ x: 100 + OFF, y: 100 }, { x: 900, y: 0 }, server, OFF, H)
    expect(dir).toEqual({ x: 1, y: 0 })
    const drawn = { x: 100, y: 13 }
    const o = gunAt(drawn, dir!, OFF)
    expect(o).toEqual({ x: drawn.x + OFF, y: drawn.y })
  })

  it('keeps the server’s point for a round spawned away from its owner (a fragment) — the control', () => {
    expect(muzzleDir({ x: 400, y: 100 }, { x: 1, y: 0 }, { x: 100, y: 100, vx: 0, vy: 0 }, OFF, H)).toBeNull()
  })

  it('reaches as far as the owner can move in the lag allowance, and no further', () => {
    const v = 600
    const server = { x: 0, y: 0, vx: v, vy: 0 }
    const edge = OFF + H + v * SPAWN_BODY_LAG_S
    expect(muzzleDir({ x: edge - 1, y: 0 }, { x: 1, y: 0 }, server, OFF, H)).not.toBeNull()
    expect(muzzleDir({ x: edge + 1, y: 0 }, { x: 1, y: 0 }, server, OFF, H)).toBeNull()
  })

  it('has no direction with no server body or a round that does not move', () => {
    const spawn = { x: 118, y: 100 }
    expect(muzzleDir(spawn, { x: 1, y: 0 }, null, OFF, H)).toBeNull()
    expect(muzzleDir(spawn, { x: 0, y: 0 }, { x: 100, y: 100, vx: 0, vy: 0 }, OFF, H)).toBeNull()
  })
})
