import { describe, expect, it } from 'vitest'
import { cleanName, DEFAULT_NAME, loadName, MAX_NAME, nameOrNull, NAME_KEY, saveName, storedName } from './profile'

/** A `localStorage` double. Deliberately holds strings, like the real one. */
function store(seed: Record<string, string> = {}) {
  const map = new Map(Object.entries(seed))
  return {
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => void map.set(k, v),
    raw: map,
  }
}

describe('cleanName', () => {
  it('clamps to the length the server accepts', () => {
    expect(cleanName('x'.repeat(40))).toHaveLength(MAX_NAME)
  })

  it('never yields an empty name', () => {
    for (const raw of ['', '   ', '<>', '<<>>']) expect(cleanName(raw)).toBe(DEFAULT_NAME)
  })

  it('strips angle brackets, because the menu builds HTML', () => {
    expect(cleanName('<b>ana</b>')).toBe('bana/b')
  })

  it('keeps an ordinary name unchanged', () => {
    expect(cleanName('  ana  ')).toBe('ana')
  })
})

describe('the stored name', () => {
  it('says nothing is stored when nothing is, so the prompt appears once', () => {
    expect(storedName(store())).toBeNull()
    for (const raw of ['', '   ', '<>', ' <<>> ', '\t']) expect(storedName(store({ [NAME_KEY]: raw }))).toBeNull()
    // The control: `<b>` strips to "b", a name a player can have.
    expect(storedName(store({ [NAME_KEY]: '<b>' }))).toBe('b')
  })

  it('never asks again once a name is stored — including the default, typed', () => {
    expect(storedName(store({ [NAME_KEY]: 'ana' }))).toBe('ana')
    expect(storedName(store({ [NAME_KEY]: DEFAULT_NAME }))).toBe(DEFAULT_NAME)
  })

  it('asks and accepts by the same rule, so neither can pass what the other refuses', () => {
    for (const raw of ['', '   ', '<>', 'ana', '  bo  ', '<b>', 'x'.repeat(40)]) {
      expect(storedName(store({ [NAME_KEY]: raw }))).toEqual(nameOrNull(raw))
    }
  })

  it('joins as the stored name, else the default', () => {
    expect(loadName(store({ [NAME_KEY]: 'ana' }))).toBe('ana')
    expect(loadName(store({ [NAME_KEY]: '  <>  ' }))).toBe(DEFAULT_NAME)
    expect(loadName(store())).toBe(DEFAULT_NAME)
  })

  it('saves the cleaned name, not the raw one, and reads it back', () => {
    const s = store()
    saveName(s, '  <script>  ')
    expect(s.raw.get(NAME_KEY)).toBe('script')
    expect(loadName(s)).toBe('script')
  })
})
