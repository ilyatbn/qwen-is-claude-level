import { describe, expect, it, beforeEach } from 'vitest'
import {
  FPS_COUNTER_KEY,
  HIGH_QUALITY_KEY,
  isFpsCounter,
  isHighQuality,
  loadSettings,
  onFpsCounterChange,
  onHighQualityChange,
  readFlag,
  resetSettingsForTest,
  setFpsCounter,
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

describe('the FPS counter setting (T21.24)', () => {
  beforeEach(() => resetSettingsForTest())

  it('defaults to off', () => {
    loadSettings(store())
    expect(isFpsCounter()).toBe(false)
  })

  it('is read at boot, which is the half T21.16 shipped without', () => {
    // **The assertion is `loadSettings`, not `setFpsCounter`.** A setting whose
    // setter works and whose loader forgets it reverts to off on every reload,
    // looks exactly like a setting that was never switched on, and passed a gate
    // once already. This is that failure in one line; `fps-counter.mjs` is the
    // same claim through a real reload.
    const s = store({ [FPS_COUNTER_KEY]: '1' })
    loadSettings(s)
    expect(isFpsCounter()).toBe(true)
  })

  it('is stored under its own key, so the two settings cannot be one bit', () => {
    // The control: turning the counter on must leave High Quality alone, or a
    // player who wanted a frame rate has silently bought a shader — and the
    // comparison the counter exists for becomes impossible.
    const s = store()
    setFpsCounter(s, true)
    expect(s.raw.get(FPS_COUNTER_KEY)).toBe('1')
    expect(s.raw.get(HIGH_QUALITY_KEY)).toBeUndefined()
    expect(isHighQuality()).toBe(false)
    // And the other direction.
    setHighQuality(s, true)
    expect(isFpsCounter()).toBe(true)
  })

  it('treats anything a player could type as off', () => {
    for (const junk of ['banana', '', 'true', 'on', '2', '0']) {
      expect(readFlag(store({ [FPS_COUNTER_KEY]: junk }), FPS_COUNTER_KEY), junk).toBe(false)
    }
    expect(readFlag(store({ [FPS_COUNTER_KEY]: '1' }), FPS_COUNTER_KEY)).toBe(true)
  })

  it('tells its own listeners and leaves the other setting alone', () => {
    const fps: boolean[] = []
    const quality: boolean[] = []
    const off = onFpsCounterChange((v) => fps.push(v))
    onHighQualityChange((v) => quality.push(v))
    const s = store()
    setFpsCounter(s, true)
    setFpsCounter(s, false)
    expect(fps).toEqual([true, false])
    // A shared listener set would wake the fog layer to rebuild a shader because
    // somebody asked to see a number.
    expect(quality).toEqual([])
    // Unsubscribing works, or every round leaks one and a flip wakes the dead.
    off()
    setFpsCounter(s, true)
    expect(fps).toEqual([true, false])
  })

  it('survives a browser with storage switched off', () => {
    expect(() => setFpsCounter(hostile, true)).not.toThrow()
    expect(isFpsCounter()).toBe(true)
    expect(readFlag(hostile, FPS_COUNTER_KEY)).toBe(false)
  })
})
