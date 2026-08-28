import { describe, expect, it } from 'vitest'
import {
  DEFAULT_MODEL,
  loadScale,
  menuReducer,
  saveScale,
  scaleBlurb,
  type MenuModel,
  type Screen,
} from './menu'

const ALL: Screen[] = ['menu', 'create', 'join', 'matching', 'lobby', 'skins']

describe('menu navigation', () => {
  it('back reaches the menu from every screen — no screen is a trap', () => {
    for (const screen of ALL) {
      const m: MenuModel = { ...DEFAULT_MODEL, screen }
      expect(menuReducer(m, { type: 'back' }).screen).toBe('menu')
    }
  })

  it('navigation clears a stale error', () => {
    const m: MenuModel = { ...DEFAULT_MODEL, screen: 'join', error: 'No game with that code.' }
    expect(menuReducer(m, { type: 'go', screen: 'menu' }).error).toBeNull()
    expect(menuReducer(m, { type: 'back' }).error).toBeNull()
  })

  /**
   * The whole point of keeping it: correcting one mistyped character should not
   * mean retyping all six.
   */
  it('a refused join keeps what the player typed', () => {
    let m: MenuModel = { ...DEFAULT_MODEL, screen: 'join' }
    m = menuReducer(m, { type: 'typeCode', code: 'abc234' })
    expect(m.code).toBe('ABC234')
    m = menuReducer(m, { type: 'error', message: 'No game with that code.' })
    expect(m.code).toBe('ABC234')
    expect(m.error).toBe('No game with that code.')
  })

  it('typed codes are upper-cased, stripped and bounded', () => {
    const t = (raw: string) =>
      menuReducer(DEFAULT_MODEL, { type: 'typeCode', code: raw }).code
    expect(t(' ab c2 3z ')).toBe('ABC23Z')
    expect(t('abcdefghijkl')).toBe('ABCDEF')
    expect(t('')).toBe('')
  })

  it('hosting a private room lands in the lobby with the code shown', () => {
    const m = menuReducer(
      { ...DEFAULT_MODEL, screen: 'create' },
      { type: 'hosted', code: 'ABC234' },
    )
    expect(m.screen).toBe('lobby')
    expect(m.hostCode).toBe('ABC234')
  })

  it('the reducer actually moves — the control for the back test', () => {
    // Without this, "back always reaches menu" passes for a reducer that
    // ignores every action and never leaves the menu at all.
    const m = menuReducer(DEFAULT_MODEL, { type: 'go', screen: 'join' })
    expect(m.screen).toBe('join')
    expect(menuReducer(m, { type: 'setScale', scale: 'large' }).scale).toBe('large')
  })
})

describe('map size', () => {
  it('persists and falls back to medium on anything unexpected', () => {
    const store = new Map<string, string>()
    const s = {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, v),
    }
    expect(loadScale(s)).toBe('medium')
    saveScale(s, 'large')
    expect(loadScale(s)).toBe('large')
    store.set('deepcut.scale', 'enormous')
    expect(loadScale(s)).toBe('medium')
  })

  it('every size reads as something, and they differ', () => {
    const all = (['small', 'medium', 'large'] as const).map(scaleBlurb)
    expect(new Set(all).size).toBe(3)
    for (const b of all) expect(b.length).toBeGreaterThan(4)
  })
})

