import { describe, expect, it } from 'vitest'
import {
  BOB_AMPLITUDE,
  bobOffset,
  diffItems,
  frameFor,
  labelFor,
  parseRegistry,
  withinLabelRange,
  type ItemDefView,
  type WorldItemView,
} from './itemSprites-math'

const REGISTRY_JSON = JSON.stringify([
  { id: 0, key: 'medkit', name: 'Medkit', sprite: 'item_medkit', max_stack: 3 },
  { id: 3, key: 'bazooka', name: 'Bazooka', sprite: 'weapon_bazooka', max_stack: 4 },
])

const defs: Map<number, ItemDefView> = parseRegistry(REGISTRY_JSON)
const all = () => true

function item(over: Partial<WorldItemView> = {}): WorldItemView {
  return { id: 1, item: 0, count: 1, x: 100, y: 200, source: 'Initial', ...over }
}

describe('parseRegistry', () => {
  it('indexes by id and keeps the sprite key', () => {
    expect(defs.get(0)?.sprite).toBe('item_medkit')
    expect(defs.get(3)?.key).toBe('bazooka')
  })

  it('survives malformed input rather than taking the game down', () => {
    // This parses data that arrived across the WASM boundary; the rule from the
    // decoder fuzzing in M6 applies just as much here.
    for (const bad of ['', 'null', '{}', '[', 'not json', '[1,2,3]', '[{"id":"x"}]']) {
      expect(() => parseRegistry(bad)).not.toThrow()
    }
    expect(parseRegistry('[{"id":1}]').size).toBe(0) // no sprite: unusable
  })
})

describe('bobOffset', () => {
  it('stays within the stated amplitude', () => {
    for (let t = 0; t < 6; t += 0.05) {
      expect(Math.abs(bobOffset(3, t))).toBeLessThanOrEqual(BOB_AMPLITUDE + 1e-9)
    }
  })

  it('gives different items different phases', () => {
    // A row of pickups pulsing in unison reads as a UI element, not as objects
    // lying in the world.
    const a = bobOffset(0, 0)
    const b = bobOffset(4, 0)
    expect(a).not.toBeCloseTo(b, 3)
  })

  it('is periodic and continuous', () => {
    expect(bobOffset(1, 0)).toBeCloseTo(bobOffset(1, 1.6), 6)
    let prev = bobOffset(1, 0)
    for (let t = 0.01; t < 3; t += 0.01) {
      const v = bobOffset(1, t)
      expect(Math.abs(v - prev)).toBeLessThan(0.5)
      prev = v
    }
  })
})

describe('frameFor', () => {
  it('resolves an item to its registry sprite', () => {
    expect(frameFor(item({ item: 0 }), defs, all)).toBe('item_medkit')
    expect(frameFor(item({ item: 3 }), defs, all)).toBe('weapon_bazooka')
  })

  it('draws a crate as a crate regardless of its contents', () => {
    // docs/32 §4: what is inside is rolled at spawn and is not shown.
    expect(frameFor(item({ source: 'Crate', item: 3 }), defs, all)).toBe('crate')
  })

  it('returns null for an unknown item, so the caller can fall back', () => {
    expect(frameFor(item({ item: 99 }), defs, all)).toBeNull()
  })

  it('returns null when the atlas lacks the frame', () => {
    // The fallback path docs/50 §8 requires: no art must still boot.
    expect(frameFor(item({ item: 0 }), defs, () => false)).toBeNull()
  })
})

describe('labelFor', () => {
  it('shows the name, and the count only when it is a stack', () => {
    expect(labelFor(item({ item: 0, count: 1 }), defs)).toBe('Medkit')
    expect(labelFor(item({ item: 3, count: 4 }), defs)).toBe('Bazooka x4')
  })

  it('names an unknown item by id rather than showing "undefined"', () => {
    expect(labelFor(item({ item: 42 }), defs)).toBe('item 42')
  })
})

describe('withinLabelRange', () => {
  it('is true nearby and false far away', () => {
    expect(withinLabelRange(item({ x: 100, y: 200 }), { x: 120, y: 200 })).toBe(true)
    expect(withinLabelRange(item({ x: 100, y: 200 }), { x: 900, y: 200 })).toBe(false)
  })

  it('measures true distance, not horizontal offset', () => {
    expect(withinLabelRange(item({ x: 100, y: 200 }), { x: 100, y: 900 })).toBe(false)
  })
})

describe('diffItems', () => {
  it('reports only what changed', () => {
    const live = [item({ id: 1 }), item({ id: 2 })]
    expect(diffItems([1], live)).toEqual({ add: [2], remove: [] })
    expect(diffItems([1, 2, 3], live)).toEqual({ add: [], remove: [3] })
    expect(diffItems([], [])).toEqual({ add: [], remove: [] })
  })

  it('does not churn when nothing changed', () => {
    // Rebuilding every frame would restart the bob on every item, every frame —
    // which looks like nothing moving at all.
    const live = [item({ id: 1 }), item({ id: 2 })]
    expect(diffItems([1, 2], live)).toEqual({ add: [], remove: [] })
  })

  it('removes a picked-up item exactly when the server drops it', () => {
    expect(diffItems([7], [])).toEqual({ add: [], remove: [7] })
  })
})
