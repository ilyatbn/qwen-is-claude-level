import { describe, expect, it } from 'vitest'
import { DEFAULT_MAP_GENERATOR, MapScale, type MapGenerator } from '../core'
import {
  DEFAULT_GRAVITY,
  generateForScene,
  gravityFromUrl,
  type GeneratesMaps,
} from './sceneParams'

/**
 * R22's client work had no test at all: no browser check passed a gravity, no
 * vitest touched either scene, and deleting `params.get('gravity')` from both
 * of them turned nothing red. This is the smallest thing that does.
 */
describe('gravityFromUrl', () => {
  it('reads the mode off the URL', () => {
    expect(gravityFromUrl(new URLSearchParams('?seed=1&gravity=space'))).toBe('space')
    expect(gravityFromUrl(new URLSearchParams('?gravity=low'))).toBe('low')
  })

  it('defaults when the parameter is absent, and the control is that it is not always the default', () => {
    expect(gravityFromUrl(new URLSearchParams('?seed=1&scale=small'))).toBe(DEFAULT_GRAVITY)
    expect(gravityFromUrl(new URLSearchParams(''))).toBe(DEFAULT_GRAVITY)
    // The control. Without it this file passes for a function that ignores the
    // URL entirely, which is exactly the state R22's work shipped in.
    expect(gravityFromUrl(new URLSearchParams('?gravity=space'))).not.toBe(DEFAULT_GRAVITY)
  })
})

/** A `Core` stand-in that records what it was asked for. */
function recorder(accept: boolean): GeneratesMaps & {
  calls: Array<{ how: 'gravity' | 'plain'; generator?: MapGenerator; gravity?: string }>
} {
  const calls: Array<{ how: 'gravity' | 'plain'; generator?: MapGenerator; gravity?: string }> = []
  return {
    calls,
    generateForGravity(_seed, _scale, generator, gravity) {
      calls.push({ how: 'gravity', generator, gravity })
      return accept
    },
    generate() {
      calls.push({ how: 'plain' })
    },
  }
}

describe('generateForScene', () => {
  it('generates through the gravity, at the default generator', () => {
    const core = recorder(true)
    generateForScene(core, 4242n, MapScale.Small, 'space')
    expect(core.calls).toEqual([
      { how: 'gravity', generator: DEFAULT_MAP_GENERATOR, gravity: 'space' },
    ])
  })

  it('falls back to the default map when the spelling is unknown', () => {
    const core = recorder(false)
    generateForScene(core, 4242n, MapScale.Small, 'zero-g')
    expect(core.calls.map((c) => c.how)).toEqual(['gravity', 'plain'])
  })

  it('does not generate twice when the gravity was accepted', () => {
    const core = recorder(true)
    generateForScene(core, 4242n, MapScale.Small, 'standard')
    expect(core.calls.filter((c) => c.how === 'plain')).toEqual([])
  })
})
