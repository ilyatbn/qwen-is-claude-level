/**
 * The Start Game menu's pure half (`docs/71-amendments-v3.md` §B3).
 *
 * Phaser-free (§A8), so the navigation — which is where the bugs live — is
 * testable without a browser. A menu you can get stuck in is the failure mode,
 * and that is a property of the state machine, not of the pixels.
 */
import type { Scale } from '../net/lobby'

export type Screen = 'menu' | 'private' | 'create' | 'join' | 'matching' | 'lobby' | 'skins'

export interface MenuModel {
  screen: Screen
  scale: Scale
  /** What the player has typed, already upper-cased. */
  code: string
  /** Set from `join_error`; cleared on any navigation. */
  error: string | null
  /** The code to show after creating a private room. */
  hostCode: string | null
}

export const DEFAULT_MODEL: MenuModel = {
  screen: 'menu',
  scale: 'medium',
  code: '',
  error: null,
  hostCode: null,
}

export type MenuAction =
  | { type: 'setScale'; scale: Scale }
  | { type: 'go'; screen: Screen }
  | { type: 'typeCode'; code: string }
  | { type: 'error'; message: string }
  | { type: 'hosted'; code: string }
  | { type: 'back' }

/**
 * `Esc` always goes back one step, from anywhere (§B3).
 *
 * Written as a table rather than as a chain of conditionals so "where does back
 * go from here" is answerable by reading one line, and so a new screen that
 * forgets to define it is a type error.
 */
const BACK: Record<Screen, Screen> = {
  menu: 'menu',
  // §E7: Private Game is a step, so Back from Host or Join returns to it rather
  // than skipping to the top. `Screen` is exhaustive here by type, which is why
  // adding a screen without deciding its Back is a compile error.
  private: 'menu',
  create: 'private',
  join: 'private',
  matching: 'menu',
  lobby: 'menu',
  skins: 'menu',
}

export function menuReducer(m: MenuModel, a: MenuAction): MenuModel {
  switch (a.type) {
    case 'setScale':
      return { ...m, scale: a.scale }
    case 'go':
      // Navigation clears the error: a stale "no game with that code" hanging
      // over the next screen reads as a new failure.
      return { ...m, screen: a.screen, error: null }
    case 'typeCode':
      return { ...m, code: a.code.replace(/\s+/g, '').toUpperCase().slice(0, 6) }
    case 'error':
      // Deliberately keeps `code`: a refused join must not clear what the player
      // typed, or correcting one character means retyping all six.
      return { ...m, error: a.message }
    case 'hosted':
      return { ...m, screen: 'lobby', hostCode: a.code, error: null }
    case 'back':
      return { ...m, screen: BACK[m.screen], error: null }
  }
}

/** Persisted so the last choice survives a reload. */
const SCALE_KEY = 'deepcut.scale'

export function loadScale(store: Pick<Storage, 'getItem'>): Scale {
  const v = store.getItem(SCALE_KEY)
  return v === 'small' || v === 'medium' || v === 'large' ? v : 'medium'
}

export function saveScale(store: Pick<Storage, 'setItem'>, s: Scale): void {
  store.setItem(SCALE_KEY, s)
}

/** How a map size reads to someone who has not played yet. */
export function scaleBlurb(s: Scale): string {
  switch (s) {
    case 'small':
      return 'Small — fast, close-quarters'
    case 'medium':
      return 'Medium — the default'
    case 'large':
      return 'Large — slow, exploratory'
  }
}



/**
 * Step an index, wrapping in both directions (§E7).
 *
 * One line, and it exists so the menu's stepper and the lobby's cannot disagree
 * about what "next" means. `(i + d) % n` is wrong for negative `d` in JS, which
 * is the bug this removes rather than duplicates.
 */
export function stepIndex(i: number, delta: number, n: number): number {
  return (((i + delta) % n) + n) % n
}
