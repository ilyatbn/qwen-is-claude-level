import { describe, expect, it } from 'vitest'
import {
  cleanName,
  cycle,
  DEFAULT_CHOICE,
  loadChoice,
  MAX_NAME,
  NAME_KEY,
  readId,
  saveChoice,
  SKIN_KEY,
  STONE_KEY,
  weaponSlots,
} from './skins'

/** A `localStorage` double. Deliberately holds strings, like the real one. */
function store(seed: Record<string, string> = {}) {
  const map = new Map(Object.entries(seed))
  return {
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => void map.set(k, v),
    raw: map,
  }
}

describe('readId', () => {
  it('reads a stored id', () => {
    expect(readId(store({ [SKIN_KEY]: '3' }), SKIN_KEY, 5)).toBe(3)
  })

  it('falls back to 0 for anything not a usable id', () => {
    // localStorage holds strings a user can edit, so every one of these is
    // reachable without a bug anywhere in the client.
    for (const raw of ['banana', '', '-1', '2.5', 'NaN', '1e9', ' ', '0x2']) {
      expect(readId(store({ [SKIN_KEY]: raw }), SKIN_KEY, 5)).toBe(0)
    }
  })

  it('falls back when the id is past the end of the registry', () => {
    // An id of 5 in a 5-skin registry is as unusable as "banana": it would
    // arrive at the atlas as a missing frame.
    expect(readId(store({ [SKIN_KEY]: '5' }), SKIN_KEY, 5)).toBe(0)
    expect(readId(store({ [SKIN_KEY]: '4' }), SKIN_KEY, 5)).toBe(4)
  })

  it('falls back when nothing is stored at all', () => {
    expect(readId(store(), SKIN_KEY, 5)).toBe(0)
  })
})

describe('cleanName', () => {
  it('clamps to the length the server accepts', () => {
    expect(cleanName('x'.repeat(40))).toHaveLength(MAX_NAME)
  })

  it('never yields an empty name', () => {
    // The server rejects an empty name (docs/40 §2), and the player would see
    // a join error with no way to diagnose it.
    for (const raw of ['', '   ', '<>', '<<>>']) {
      expect(cleanName(raw)).toBe(DEFAULT_CHOICE.name)
    }
  })

  it('strips angle brackets, because the menu builds HTML', () => {
    expect(cleanName('<b>ana</b>')).toBe('bana/b')
  })

  it('keeps an ordinary name unchanged', () => {
    expect(cleanName('  ana  ')).toBe('ana')
  })
})

describe('loadChoice / saveChoice', () => {
  it('round-trips through storage', () => {
    const s = store()
    saveChoice(s, { name: 'ana', skinId: 2, tombstoneSkinId: 3 })
    expect(loadChoice(s, 5, 5)).toEqual({ name: 'ana', skinId: 2, tombstoneSkinId: 3 })
  })

  it('saves the cleaned name, not the raw one', () => {
    // Otherwise the stored value differs from what every later read produces,
    // and the menu shows one name while the server is sent another.
    const s = store()
    saveChoice(s, { name: '  <script>  ', skinId: 0, tombstoneSkinId: 0 })
    expect(s.raw.get(NAME_KEY)).toBe('script')
  })

  it('survives a registry that shrank under a stored id', () => {
    // Removing a skin must not brick the menu for whoever had it selected.
    const s = store({ [SKIN_KEY]: '4', [STONE_KEY]: '4' })
    expect(loadChoice(s, 2, 2)).toEqual({ name: 'Player', skinId: 0, tombstoneSkinId: 0 })
  })
})

describe('cycle', () => {
  it('wraps in both directions', () => {
    expect(cycle(4, 1, 5)).toBe(0)
    expect(cycle(0, -1, 5)).toBe(4)
    expect(cycle(2, 1, 5)).toBe(3)
  })

  it('is safe on an empty registry', () => {
    // Reachable with no art at all, which docs/50 §8 requires the game to survive.
    expect(cycle(0, 1, 0)).toBe(0)
    expect(cycle(3, -1, 0)).toBe(0)
  })

  it('handles a delta larger than the list', () => {
    expect(cycle(0, 7, 5)).toBe(2)
    expect(cycle(0, -7, 5)).toBe(3)
  })
})

describe('weaponSlots', () => {
  it('labels every key it is given', () => {
    // The list comes from the real arsenal so the "Coming soon" section cannot
    // drift from it — a weapon added to the registry and missing here is a
    // visible gap, which is why the section is shown at all.
    expect(weaponSlots(['bazooka', 'laser_smg'])).toEqual([
      { weaponKey: 'bazooka', label: 'Bazooka' },
      { weaponKey: 'laser_smg', label: 'Laser Smg' },
    ])
  })

  it('is empty for an empty arsenal rather than throwing', () => {
    expect(weaponSlots([])).toEqual([])
  })
})
