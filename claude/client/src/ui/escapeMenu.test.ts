import { describe, expect, it } from 'vitest'
import { handleEscape, type EscapeState } from './escapeMenu'

/**
 * §C13's stacking rule, which is where key handling on this kind of UI usually
 * breaks. The DOM half — the three buttons and quitting actually leaving the
 * room — is asserted in `scripts/checks/escape-menu.mjs`, on the rendered frame
 * and on the socket.
 *
 * T21.16 added a fourth state: the options panel, which is opened **from** this
 * menu and is therefore always the innermost thing on screen.
 */
const state = (over: Partial<EscapeState> = {}): EscapeState => ({
  inventoryOpen: false,
  menuOpen: false,
  optionsOpen: false,
  ...over,
})

describe('handleEscape', () => {
  it('opens the menu when nothing is up', () => {
    expect(handleEscape(state())).toBe('opened-menu')
  })

  it('closes the menu when the menu is up', () => {
    expect(handleEscape(state({ menuOpen: true }))).toBe('closed-menu')
  })

  /** Innermost first: the backpack was opened last and is what you are reading. */
  it('closes the inventory first when both are up', () => {
    expect(handleEscape(state({ inventoryOpen: true, menuOpen: true }))).toBe('closed-inventory')
  })

  it('closes the inventory rather than opening the menu on top of it', () => {
    expect(handleEscape(state({ inventoryOpen: true }))).toBe('closed-inventory')
  })

  /**
   * Driven as a sequence, because the bug this guards against is not any single
   * press — it is two presses in a row doing the wrong thing between them.
   */
  it('takes two presses to get from inventory-open to menu-open', () => {
    const s = state({ inventoryOpen: true })
    expect(handleEscape(s)).toBe('closed-inventory')
    s.inventoryOpen = false
    expect(handleEscape(s)).toBe('opened-menu')
    s.menuOpen = true
    expect(handleEscape(s)).toBe('closed-menu')
  })
})

describe('handleEscape with the options panel (T21.16)', () => {
  it('closes options first, because it was opened last', () => {
    expect(handleEscape(state({ optionsOpen: true, menuOpen: true }))).toBe('closed-options')
  })

  it('leaves the menu standing when options closes', () => {
    // The action says *what* to close; this pins the ordering that makes a
    // player who opens options and presses Esc land back on the menu rather
    // than two steps out in the round.
    expect(handleEscape(state({ optionsOpen: true, menuOpen: true }))).toBe('closed-options')
    // ...and the very next press then closes the menu.
    expect(handleEscape(state({ optionsOpen: false, menuOpen: true }))).toBe('closed-menu')
  })

  it('beats the inventory too, whatever order they were opened in', () => {
    expect(
      handleEscape(state({ optionsOpen: true, inventoryOpen: true, menuOpen: true })),
    ).toBe('closed-options')
  })

  it('changes nothing when it is shut — the control', () => {
    // Without this, "options wins" is also what a function that always returns
    // 'closed-options' would produce.
    expect(handleEscape(state({ menuOpen: true }))).toBe('closed-menu')
    expect(handleEscape(state())).toBe('opened-menu')
  })
})
