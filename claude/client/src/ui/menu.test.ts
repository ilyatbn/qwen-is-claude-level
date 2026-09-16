import { describe, expect, it } from 'vitest'
import {
  DEFAULT_MODEL,
  loadScale,
  menuReducer,
  saveScale,
  scaleBlurb,
  stepIndex,
  type MenuModel,
  type Screen,
} from './menu'

/**
 * Every screen, and **exhaustive by type**.
 *
 * This was a hand-written array, which meant a new screen was silently untested
 * — the back-reaches-menu test would go on passing while the one screen that
 * could trap you was not in the list. As a `Record<Screen, …>` a missing entry
 * is a compile error, which is the same trick `BACK` in `menu.ts` uses and for
 * the same reason. T20.02's `name` is the screen that found it.
 */
const SCREENS: Record<Screen, true> = {
  menu: true,
  private: true,
  create: true,
  join: true,
  matching: true,
  lobby: true,
  skins: true,
  name: true,
}
const ALL = Object.keys(SCREENS) as Screen[]

describe('menu navigation', () => {
  it('back reaches the menu from every screen — no screen is a trap', () => {
    // **Repeated Back, not one Back.** §E7 nests Host and Join under Private
    // Game, so `create` and `join` step to `private` and then to `menu`. The
    // claim was never "one press" — it is that no screen traps you, and a bound
    // is what turns that into an assertion: a cycle between two nested screens
    // would spin here and fail, which a single-step check could not see.
    for (const screen of ALL) {
      let m: MenuModel = { ...DEFAULT_MODEL, screen }
      let steps = 0
      while (m.screen !== 'menu' && steps < ALL.length) {
        m = menuReducer(m, { type: 'back' })
        steps += 1
      }
      expect(m.screen, `\`${screen}\` never reached the menu in ${ALL.length} presses`).toBe(
        'menu',
      )
    }
  })

  it('the nickname prompt is not a trap either, and Back abandons the join', () => {
    // §T20.02. The prompt stands in front of a join, so its Back is `menu` and
    // not the screen it interrupted: pressing Back has said no to *this* game,
    // which is why `MenuScene` clears the pending intent on any navigation away.
    expect(menuReducer({ ...DEFAULT_MODEL, screen: 'name' }, { type: 'back' }).screen).toBe('menu')
  })

  it('and every nested screen goes up one level, not straight to the top', () => {
    // The control for the loop above: it would also pass if every screen went
    // directly to `menu`, which is the behaviour §E7 replaced.
    expect(menuReducer({ ...DEFAULT_MODEL, screen: 'create' }, { type: 'back' }).screen).toBe(
      'private',
    )
    expect(menuReducer({ ...DEFAULT_MODEL, screen: 'join' }, { type: 'back' }).screen).toBe(
      'private',
    )
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

  it('steps left from the first entry, which is the branch the `+ n` exists for', () => {
    // The browser check clicks next-then-prev, so `prev` always runs from index
    // 1 and never reaches this. Without the `+ n`, JS gives `(0 - 1) % 3 === -1`
    // and `SCALES[-1]` is `undefined` — the stepper breaks on the one press
    // nothing else makes.
    expect(stepIndex(0, -1, 3)).toBe(2)
    expect(stepIndex(2, 1, 3)).toBe(0)
    // The control: an ordinary step, so the wrap assertions above are not the
    // only thing this function is asked for.
    expect(stepIndex(0, 1, 3)).toBe(1)
  })
})

