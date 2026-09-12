import { describe, expect, it, beforeEach } from 'vitest'
import {
  HIGH_QUALITY_KEY,
  isHighQuality,
  loadSettings,
  onHighQualityChange,
  readFlag,
  resetSettingsForTest,
  setHighQuality,
  writeFlag,
} from './settings'

/** A `localStorage` stand-in; `vitest` runs in node and has none. */
function store(initial: Record<string, string> = {}) {
  const m = new Map(Object.entries(initial))
  return {
    getItem: (k: string) => m.get(k) ?? null,
    setItem: (k: string, v: string) => void m.set(k, v),
    raw: m,
  }
}

/** A store whose every call throws, as a browser with storage disabled does. */
const hostile = {
  getItem: () => {
    throw new Error('storage disabled')
  },
  setItem: () => {
    throw new Error('storage disabled')
  },
}

describe('settings (T21.16)', () => {
  beforeEach(() => resetSettingsForTest())

  it('defaults to off, which is the whole reason the toggle exists', () => {
    // Shaders need the better graphics mode; this switch is for machines that
    // do not have it. Defaulting to on would make exactly those worse.
    loadSettings(store())
    expect(isHighQuality()).toBe(false)
  })

  it('reads back what it wrote — the control for every test below', () => {
    const s = store()
    setHighQuality(s, true)
    resetSettingsForTest()
    loadSettings(s)
    expect(isHighQuality()).toBe(true)
  })

  it('treats anything a player could type as off', () => {
    for (const junk of ['banana', '', 'true', 'TRUE', '2', '-1', '0']) {
      expect(readFlag(store({ [HIGH_QUALITY_KEY]: junk }), HIGH_QUALITY_KEY), junk).toBe(false)
    }
    // The control: the one value that is on.
    expect(readFlag(store({ [HIGH_QUALITY_KEY]: '1' }), HIGH_QUALITY_KEY)).toBe(true)
  })

  it('survives a browser with storage switched off', () => {
    // Some browsers throw rather than returning null. That is a player who gets
    // the default, not a crash on the way into a match.
    expect(() => readFlag(hostile, HIGH_QUALITY_KEY)).not.toThrow()
    expect(readFlag(hostile, HIGH_QUALITY_KEY)).toBe(false)
    expect(() => writeFlag(hostile, HIGH_QUALITY_KEY, true)).not.toThrow()
    // And the setting still applies for this session, even unpersisted.
    expect(setHighQuality(hostile, true)).toBe(true)
    expect(isHighQuality()).toBe(true)
  })

  it('tells listeners, so the toggle is live rather than needing a restart', () => {
    const seen: boolean[] = []
    const off = onHighQualityChange((v) => seen.push(v))
    const s = store()
    setHighQuality(s, true)
    setHighQuality(s, false)
    expect(seen).toEqual([true, false])
    // Unsubscribing works, or a rebuilt scene leaks a listener per round.
    off()
    setHighQuality(s, true)
    expect(seen).toEqual([true, false])
  })

  it('reports the value in force, not the value asked for', () => {
    // A setter that echoes its argument cannot report a storage failure; this
    // one reads the field back.
    const s = store()
    expect(setHighQuality(s, true)).toBe(isHighQuality())
    expect(s.raw.get(HIGH_QUALITY_KEY)).toBe('1')
  })
})
