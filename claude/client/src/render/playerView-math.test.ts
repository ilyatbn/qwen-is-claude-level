import { describe, expect, it } from 'vitest'
import { deriveAnimState, facingLeft, walkFrameMs, WALK_ANIM_THRESHOLD } from './playerView-math'

const base = { alive: true, grounded: true, jetpack: false, vx: 0, vy: 0 }

describe('deriveAnimState', () => {
  it('puts dead ahead of everything, including falling', () => {
    // Priority order is the entire content of the function.
    expect(deriveAnimState({ ...base, alive: false, grounded: false, vy: 300 })).toBe('dead')
    expect(deriveAnimState({ ...base, alive: false, jetpack: true })).toBe('dead')
  })

  it('reports jetpack even while grounded', () => {
    expect(deriveAnimState({ ...base, jetpack: true })).toBe('jetpack')
  })

  it('splits airborne into jump and fall by the sign of vy', () => {
    expect(deriveAnimState({ ...base, grounded: false, vy: -1 })).toBe('jump')
    expect(deriveAnimState({ ...base, grounded: false, vy: 1 })).toBe('fall')
    // vy exactly 0 while airborne is the apex: falling, not rising.
    expect(deriveAnimState({ ...base, grounded: false, vy: 0 })).toBe('fall')
  })

  it('walks only above the speed threshold', () => {
    expect(deriveAnimState({ ...base, vx: 50 })).toBe('walk')
    expect(deriveAnimState({ ...base, vx: -50 })).toBe('walk')
    expect(deriveAnimState({ ...base, vx: 5 })).toBe('idle')
    expect(deriveAnimState({ ...base, vx: 0 })).toBe('idle')
  })

  it('treats exactly the threshold as idle', () => {
    // The boundary is asserted explicitly: a `>=` here would make a standing
    // player's legs twitch on rounding noise.
    expect(deriveAnimState({ ...base, vx: WALK_ANIM_THRESHOLD })).toBe('idle')
    expect(deriveAnimState({ ...base, vx: WALK_ANIM_THRESHOLD + 0.001 })).toBe('walk')
  })
})

describe('facingLeft', () => {
  it('flips at exactly ±π/2', () => {
    expect(facingLeft(0)).toBe(false)
    expect(facingLeft(Math.PI)).toBe(true)
    expect(facingLeft(Math.PI / 2 - 0.01)).toBe(false)
    expect(facingLeft(Math.PI / 2 + 0.01)).toBe(true)
    expect(facingLeft(-Math.PI / 2 - 0.01)).toBe(true)
    expect(facingLeft(-Math.PI / 2 + 0.01)).toBe(false)
  })
})

describe('walkFrameMs', () => {
  it('slows the cycle as the player slows', () => {
    const fast = walkFrameMs(150, 150)
    const slow = walkFrameMs(75, 150)
    expect(slow).toBeGreaterThan(fast)
  })

  it('clamps, so a nearly-stopped player does not freeze mid-stride', () => {
    expect(walkFrameMs(0.0001, 150)).toBeLessThanOrEqual(400)
    expect(walkFrameMs(100000, 150)).toBeGreaterThanOrEqual(40)
  })
})
