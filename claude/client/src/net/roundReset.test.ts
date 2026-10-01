import { describe, expect, it } from 'vitest'
import { RoundReset } from './roundReset'

describe('RoundReset (T23.28): one call resets every registered holder', () => {
  it('runs every holder, in order, and counts the run', () => {
    const r = new RoundReset()
    const seen: string[] = []
    r.register('mirror', () => seen.push('mirror'))
    r.register('scene', () => seen.push('scene'))
    expect(seen).toEqual([]) // the control: registering resets nothing
    expect(r.run()).toEqual(['mirror', 'scene'])
    expect(seen).toEqual(['mirror', 'scene'])
    expect(r.runs).toBe(1)
  })

  it('refuses a name registered twice — a holder built twice would be reset once', () => {
    const r = new RoundReset()
    r.register('mirror', () => {})
    expect(() => r.register('mirror', () => {})).toThrow(/twice/)
  })
})
