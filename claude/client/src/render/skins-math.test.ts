import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { validateRegistry, type SkinRegistry } from './skins-math'

const atRoot = (p: string) => fileURLToPath(new URL(`../../../${p}`, import.meta.url))

function loadRegistry(): SkinRegistry {
  return JSON.parse(readFileSync(atRoot('assets/skins.json'), 'utf8')) as SkinRegistry
}

describe('skins.json, as shipped', () => {
  it('validates', () => {
    expect(validateRegistry(loadRegistry())).toEqual([])
  })
})

describe('validateRegistry', () => {
  it('reports duplicate ids rather than silently picking one', () => {
    const reg = {
      version: 1,
      players: [
        { id: 0, name: 'a', atlas: 'chars', prefix: 'p_', frames: { idle: ['i'] }, anchor: { x: 0.5, y: 0.9 }, tint: null },
        { id: 0, name: 'b', atlas: 'chars', prefix: 'q_', frames: { idle: ['i'] }, anchor: { x: 0.5, y: 0.9 }, tint: null },
      ],
      weapons: [],
    }
    expect(validateRegistry(reg).join()).toMatch(/duplicate player skin id 0/)
  })

  it('reports a registry with no skin 0, because every fallback needs it', () => {
    const reg = {
      version: 1,
      players: [
        { id: 3, name: 'a', atlas: 'chars', prefix: 'p_', frames: { idle: ['i'] }, anchor: { x: 0.5, y: 0.9 }, tint: null },
      ],
      weapons: [],
    }
    expect(validateRegistry(reg).join()).toMatch(/no skin with id 0/)
  })

  it('rejects non-objects without throwing', () => {
    expect(validateRegistry(null).length).toBe(1)
    expect(validateRegistry(42).length).toBe(1)
    expect(validateRegistry({ players: [] }).length).toBeGreaterThan(0)
  })
})
