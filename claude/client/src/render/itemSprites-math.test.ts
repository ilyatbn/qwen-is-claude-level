import { describe, expect, it } from 'vitest'
import {
  BOB_AMPLITUDE,
  bobOffset,
  artFor,
  diffItems,
  spriteByRegistryKey,
  spriteKeyFor,
  labelFor,
  parseRegistry,
  withinLabelRange,
  type ItemDefView,
  type WorldItemView,
} from './itemSprites-math'
import { proceduralItemKeys } from './itemTextures'
import { itemRegistryJson, packedFrameKeys } from './__liveRegistry'

const REGISTRY_JSON = JSON.stringify([
  { id: 0, key: 'medkit', name: 'Medkit', sprite: 'item_medkit', max_stack: 3 },
  { id: 3, key: 'bazooka', name: 'Bazooka', sprite: 'weapon_bazooka', max_stack: 4 },
])

const defs: Map<number, ItemDefView> = parseRegistry(REGISTRY_JSON)

function item(over: Partial<WorldItemView> = {}): WorldItemView {
  return { id: 1, item: 0, count: 1, x: 100, y: 200, source: 'Initial', grounded: true, ...over }
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

describe('artFor', () => {
  // The order the world and the inventory tile share. It is written once here
  // because a second copy is how the two would come to disagree about which
  // item looks like what — the failure this project has paid for in
  // `to_command`, two `wait_for`s and three `escapeHtml`s.
  const none = () => false
  const any = () => true

  it('prefers a packed atlas frame over the procedural canvas', () => {
    // Both exist. Packed art wins — docs/51 §5 makes the procedural icon the
    // fallback, not a competitor, and a test that only offered one could not
    // tell which was chosen.
    expect(artFor('weapon_bazooka', any, any)).toEqual({
      kind: 'atlas',
      frame: 'weapon_bazooka',
    })
  })

  it('falls back to the procedural canvas when the atlas lacks the frame', () => {
    // §B20: eighteen v3 items have no packed frame, and without this every one
    // of them was an identical coloured box.
    expect(artFor('weapon_bazooka', none, any)).toEqual({
      kind: 'texture',
      key: 'weapon_bazooka',
    })
  })

  it('resolves to nothing when neither source has it', () => {
    expect(artFor('weapon_bazooka', none, none)).toBeNull()
  })

  it('resolves to nothing for an item with no sprite key at all', () => {
    // An unknown item id reaches here as null, and asking the atlas for a frame
    // named "null" is how a lookup becomes a crash.
    expect(artFor(null, any, any)).toBeNull()
  })
})

describe('spriteKeyFor', () => {
  it('gives the art key without asking whether any art exists', () => {
    // The split `frameFor` could not offer: the inventory holds a registry key
    // and no `WorldItemView`, so it needs the mapping separately from the
    // existence probe.
    expect(spriteKeyFor(item({ item: 3 }), defs)).toBe('weapon_bazooka')
    expect(spriteKeyFor(item({ source: 'Crate', item: 3 }), defs)).toBe('crate')
    expect(spriteKeyFor(item({ item: 99 }), defs)).toBeNull()
  })

  it('world_and_inventory_resolve_an_item_to_the_same_art_key', () => {
    // The guarantee that actually matters, and the reason the two halves were
    // split. The world asks with an item id; the inventory has only the registry
    // key its event carries. If those ever land on different art, a bazooka is
    // one picture on the ground and another in the bag.
    //
    // This replaces a drift test that compared `frameFor` against the function
    // `frameFor` called — true by construction, and moot once nothing called it.
    const byKey = spriteByRegistryKey(defs)
    let checked = 0
    for (const def of defs.values()) {
      expect(byKey.get(def.key)).toBe(spriteKeyFor(item({ item: def.id }), defs))
      checked++
    }
    // Without this the loop above passes on an empty registry.
    expect(checked).toBeGreaterThan(1)
  })

  it('maps every registry entry, so no item silently loses its art', () => {
    const byKey = spriteByRegistryKey(defs)
    expect(byKey.size).toBe(defs.size)
    expect(byKey.get('bazooka')).toBe('weapon_bazooka')
    // An unknown key resolves to nothing rather than to some other item's art.
    expect(byKey.get('no_such_item')).toBeUndefined()
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

  /**
   * T19.17. A crate the client *watched arrive* has no contents on the wire
   * (`crate_spawn` carries `{tick, world_item_id, x, y}`), and the mirror
   * reports that as `null`. It used to report 0, so every crate on the map wore
   * the name of registry item 0 — `Medkit` — whatever it held.
   *
   * The second expectation is the control, and it is the reason this asks
   * `item === null` and not `source === 'Crate'`: the join catch-up re-sends
   * live items as `item_spawn` with the id, so a client that joined late knows
   * the contents of the very same crate and must still name them.
   */
  it('a crate with unknown contents is named as a crate, and a known one names its contents', () => {
    expect(labelFor(item({ source: 'Crate', item: null, count: null }), defs)).toBe(
      'Supply crate',
    )
    expect(labelFor(item({ source: 'Crate', item: 3, count: 4 }), defs)).toBe('Bazooka x4')
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

/**
 * §B20 — every item in the **live** registry resolves to art.
 *
 * The suite above runs against a two-entry fixture, and that is precisely why
 * eighteen v3 items shipped with sprite keys that existed nowhere: a test which
 * validates data against a copy of that data validates nothing. These read the
 * registry the game actually loads and the art it actually has.
 */
describe('the live registry has art for everything', () => {
  const registry: ItemDefView[] = JSON.parse(itemRegistryJson())
  const packed = packedFrameKeys()
  const procedural = new Set(proceduralItemKeys())
  const has = (f: string) => packed.has(f) || procedural.has(f)

  it('is not vacuous — the registry is actually populated', () => {
    // Without this, every assertion below passes for an empty registry.
    expect(registry.length).toBeGreaterThan(15)
  })

  it('resolves every ItemDef.sprite, naming any that do not', () => {
    const missing = registry.filter((d) => !has(d.sprite)).map((d) => `${d.key} -> ${d.sprite}`)
    expect(missing).toEqual([])
  })

  it('gives no two items the same frame', () => {
    // Distinct art that is distinct in name only is the §A32 mistake: it passes
    // every structural check and fails the actual requirement, which is that a
    // player can tell two pickups apart.
    const seen = new Map<string, string>()
    const clashes: string[] = []
    for (const d of registry) {
      const prev = seen.get(d.sprite)
      if (prev) clashes.push(`${prev} and ${d.key} both use ${d.sprite}`)
      else seen.set(d.sprite, d.key)
    }
    expect(clashes).toEqual([])
  })
})
