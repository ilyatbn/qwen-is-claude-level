import { beforeAll, describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { C, Core } from '../core'
import {
  backpackGrid,
  isDragWorthSending,
  regionOf,
  tileCount,
  tileLabel,
  wheelSelect,
  type SlotView,
} from './inventory-math'

/**
 * §C10's arithmetic. The **rules** are the server's — `items::inventory::dragging`
 * and `game-server/tests/inventory.rs` own those, because the server is the
 * authority and a second copy here would be a second thing to disagree with. What
 * is tested here is what the client decides for itself: which region a slot is
 * in, what a tile says, where the wheel goes, and which drags are worth sending.
 */
let QUICK = 0
let BACKPACK = 0
let TOTAL = 0

beforeAll(async () => {
  const url = new URL('../core/pkg/game_wasm_bg.wasm', import.meta.url)
  await Core.init(readFileSync(fileURLToPath(url)))
  QUICK = C().QUICK_SLOTS
  BACKPACK = C().BACKPACK_SLOTS
  TOTAL = C().INVENTORY_SLOTS
})

const slots = (filled: number[]): SlotView[] =>
  Array.from({ length: TOTAL }, (_, i) => ({
    slot: i,
    key: filled.includes(i) ? 'bazooka' : null,
    count: filled.includes(i) ? 4 : 0,
  }))

describe('the two regions', () => {
  it('accounts for every slot, from the constants', () => {
    expect(QUICK + BACKPACK).toBe(TOTAL)
    expect(regionOf(0, QUICK)).toBe('quick')
    expect(regionOf(QUICK - 1, QUICK)).toBe('quick')
    expect(regionOf(QUICK, QUICK)).toBe('backpack')
    expect(regionOf(TOTAL - 1, QUICK)).toBe('backpack')
  })

  it('lays the backpack out as two rows, derived not written down', () => {
    const { rows, cols } = backpackGrid(BACKPACK)
    expect(rows).toBe(2)
    expect(rows * cols).toBeGreaterThanOrEqual(BACKPACK)
    // A backpack that grew would still be fully drawn.
    expect(backpackGrid(18)).toEqual({ rows: 2, cols: 9 })
  })
})

describe('isDragWorthSending', () => {
  it('sends a drag from a filled slot to another slot, in either direction', () => {
    const s = slots([0])
    expect(isDragWorthSending(0, QUICK, s, TOTAL)).toBe(true)
    const back = slots([QUICK])
    expect(isDragWorthSending(QUICK, 3, back, TOTAL)).toBe(true)
  })

  it('does not send the ones that cannot do anything', () => {
    const s = slots([0])
    expect(isDragWorthSending(0, 0, s, TOTAL)).toBe(false) // equal
    expect(isDragWorthSending(1, 2, s, TOTAL)).toBe(false) // empty source
    expect(isDragWorthSending(0, TOTAL, s, TOTAL)).toBe(false) // past the end
    expect(isDragWorthSending(-1, 0, s, TOTAL)).toBe(false)
    expect(isDragWorthSending(0.5, 1, s, TOTAL)).toBe(false)
    expect(isDragWorthSending(NaN, 1, s, TOTAL)).toBe(false)
  })

  /**
   * This is a *politeness* check, not a rule: the server validates every one of
   * these itself, and this only avoids sending a message that is certainly a
   * no-op. Asserted so the next reader does not mistake it for the guard.
   */
  it('is not the authority — the server refuses the same set', () => {
    const s = slots([0])
    // A drag the client would send that the server may still refuse (a full
    // destination stack) is fine: the client renders whatever comes back.
    expect(isDragWorthSending(0, 1, s, TOTAL)).toBe(true)
  })
})

describe('tileLabel', () => {
  it('names the item, and shows a count only when there is more than one', () => {
    expect(tileLabel({ slot: 0, key: 'bazooka', count: 4 })).toBe('bazooka x4')
    expect(tileLabel({ slot: 0, key: 'axe', count: 1 })).toBe('axe')
    expect(tileLabel({ slot: 0, key: null, count: 0 })).toBe('')
    expect(tileLabel(undefined)).toBe('')
  })
})

describe('wheelSelect', () => {
  it('walks the quick bar and wraps within it', () => {
    expect(wheelSelect(0, 1, QUICK)).toBe(1)
    expect(wheelSelect(QUICK - 1, 1, QUICK)).toBe(0)
    expect(wheelSelect(0, -1, QUICK)).toBe(QUICK - 1)
  })

  /**
   * §C10: the selection follows the quick bar **only**. Firing acts on the
   * selection, so a wheel that could park the trigger in the backpack would mean
   * shooting with something that is not on the screen — which the server refuses
   * too, so this is the client agreeing rather than the client deciding.
   */
  it('never lands in the backpack, whichever way it is spun', () => {
    for (let i = 0; i < TOTAL * 2; i++) {
      const up = wheelSelect(i % QUICK, 1, QUICK)
      const down = wheelSelect(i % QUICK, -1, QUICK)
      expect(up).toBeLessThan(QUICK)
      expect(down).toBeLessThan(QUICK)
      expect(up).toBeGreaterThanOrEqual(0)
      expect(down).toBeGreaterThanOrEqual(0)
    }
  })
})

describe('tileCount', () => {
  // The tile draws the item now, so the key stops being the label and the count
  // becomes the whole of it. `tileLabel` survives as the no-art fallback.
  it('shows a count only when there is more than one', () => {
    expect(tileCount({ slot: 0, key: 'bazooka', count: 1 })).toBe('')
    expect(tileCount({ slot: 0, key: 'grenade', count: 3 })).toBe('x3')
  })

  it('says nothing about an empty slot', () => {
    expect(tileCount({ slot: 0, key: null, count: 0 })).toBe('')
    expect(tileCount(undefined)).toBe('')
  })

  it('drops the key that tileLabel keeps, which is the whole difference', () => {
    // Without this pair the two functions could quietly become the same one.
    const slot: SlotView = { slot: 0, key: 'bazooka', count: 2 }
    expect(tileLabel(slot)).toContain('bazooka')
    expect(tileCount(slot)).not.toContain('bazooka')
  })
})
