import { describe, expect, it } from 'vitest'
import {
  cleanName,
  cycle,
  DEFAULT_CHOICE,
  loadChoice,
  loadIdentity,
  MAX_NAME,
  nameOrNull,
  NAME_KEY,
  readId,
  saveChoice,
  saveName,
  SKIN_KEY,
  storedName,
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

// T20.02 — the identity a lobby verb sends, and the question the prompt asks.
describe('the stored identity', () => {
  it('says nothing is stored when nothing is, so the prompt appears once', () => {
    expect(storedName(store())).toBeNull()
    // A key holding only blanks or only strippable characters is a key holding
    // nothing: `cleanName` would silently turn each of these into "Player", and
    // a player who was never asked would be called Player forever.
    for (const raw of ['', '   ', '<>', ' <<>> ', '\t']) {
      expect(storedName(store({ [NAME_KEY]: raw }))).toBeNull()
    }
    // The control: `<b>` is **not** empty — it strips to "b", a name a player can
    // have. A predicate that answered null here would prompt somebody who has
    // already chosen.
    expect(storedName(store({ [NAME_KEY]: '<b>' }))).toBe('b')
  })

  it('never asks again once a name is stored — including the default, typed', () => {
    expect(storedName(store({ [NAME_KEY]: 'ana' }))).toBe('ana')
    // The literal default, deliberately: a player who types "Player" has chosen
    // a name, and a prompt keyed on "is it the default" would nag them forever.
    expect(storedName(store({ [NAME_KEY]: DEFAULT_CHOICE.name }))).toBe(DEFAULT_CHOICE.name)
  })

  it('asks and accepts by the same rule, so neither can pass what the other refuses', () => {
    // The prompt's validation is `nameOrNull` on what was typed; its trigger is
    // `nameOrNull` on what is stored. If they were two predicates, a box could
    // accept a name that left `storedName` null and prompt on every join.
    for (const raw of ['', '   ', '<>', 'ana', '  bo  ', '<b>', 'x'.repeat(40)]) {
      const typed = nameOrNull(raw)
      const stored = storedName(store({ [NAME_KEY]: raw }))
      expect(stored).toEqual(typed)
    }
  })

  // **One test, three fields**: `NaN` on the wire is as much a defect as `<b>`.
  // `MenuScene.identity()` used to read all three keys raw, so every one of
  // these reached `identityPayload` exactly as stored.
  it('survives junk in all three keys', () => {
    const junk = store({ [NAME_KEY]: '  <>  ', [SKIN_KEY]: 'banana', [STONE_KEY]: 'NaN' })
    const id = loadIdentity(junk)
    expect(id.name).toBe(DEFAULT_CHOICE.name)
    expect(id.skinId).toBe(0)
    expect(id.tombstoneSkinId).toBe(0)
    // Not merely "falsy": `Number("banana")` is `NaN`, which `JSON.stringify`
    // puts on the wire as `null` and which this client hands to its own atlas.
    // `NaN === 0` is false, so the assertions above already exclude it — this
    // says so out loud because it is the failure being guarded.
    expect(Number.isInteger(id.skinId)).toBe(true)
    expect(Number.isInteger(id.tombstoneSkinId)).toBe(true)
  })

  it('strips markup rather than refusing it, and the stripped name is what is sent', () => {
    // `<b>ana</b>` is a name a player can type into the Skins field, and the
    // menu, the results screen and the death overlay all build HTML. Every one
    // of them escapes as well — this is the storage-boundary layer, not the
    // guard.
    expect(loadIdentity(store({ [NAME_KEY]: '<b>ana</b>' })).name).toBe('bana/b')
  })

  it('passes a stored identity through unchanged, so the guards above are not a floor', () => {
    const good = store({ [NAME_KEY]: 'ana', [SKIN_KEY]: '7', [STONE_KEY]: '3' })
    expect(loadIdentity(good)).toEqual({ name: 'ana', skinId: 7, tombstoneSkinId: 3 })
  })

  it('does not need a skin count, and does not invent one', () => {
    // The menu has no atlas. `loadChoice` would clamp 7 to 0 against a registry
    // of 5; `loadIdentity` must not, because the server clamps to u16::MAX and
    // every client lookup falls back — an id past the end draws the fallback
    // skin, where 0 would silently draw a *different real* one.
    const s = store({ [SKIN_KEY]: '7' })
    expect(loadChoice(s, 5, 5).skinId).toBe(0)
    expect(loadIdentity(s).skinId).toBe(7)
  })

  it('stores a name without disturbing the ids', () => {
    const s = store({ [SKIN_KEY]: '4', [STONE_KEY]: '2' })
    saveName(s, '  bo  ')
    expect(storedName(s)).toBe('bo')
    expect(s.raw.get(SKIN_KEY)).toBe('4')
    expect(s.raw.get(STONE_KEY)).toBe('2')
  })

  it('normalises a junk id on the way through rather than writing it back', () => {
    const s = store({ [SKIN_KEY]: 'banana' })
    saveName(s, 'ana')
    expect(s.raw.get(SKIN_KEY)).toBe('0')
  })
})
