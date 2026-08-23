/**
 * The arithmetic behind §C10's quick bar and backpack.
 *
 * Pure, so `vitest` can drive it under node; the DOM half is `inventory.ts` and
 * the pixels are asserted in the browser check.
 */

/** One slot as the server describes it. */
export interface SlotView {
  slot: number
  key: string | null
  count: number
}

/** Where a slot index lives. */
export type Region = 'quick' | 'backpack'

export function regionOf(slot: number, quickSlots: number): Region {
  return slot < quickSlots ? 'quick' : 'backpack'
}

/**
 * Whether a drag is worth sending to the server at all.
 *
 * The server validates anyway and is the authority — this is not a second copy
 * of the rule, it is not sending a message that is certainly a no-op. The two
 * cannot disagree in a way that matters: a `false` here that the server would
 * have accepted costs a drag, and a `true` the server refuses costs nothing,
 * because the client renders the server's answer either way.
 */
export function isDragWorthSending(
  from: number,
  to: number,
  slots: readonly SlotView[],
  total: number,
): boolean {
  if (!Number.isInteger(from) || !Number.isInteger(to)) return false
  if (from < 0 || to < 0 || from >= total || to >= total) return false
  if (from === to) return false
  return Boolean(slots[from]?.key)
}

/**
 * Grid geometry for the backpack panel: two rows of `BACKPACK_SLOTS / 2`.
 *
 * §C10 says "two more rows", so the columns are derived from the constant rather
 * than written down — a backpack that grew to 18 would otherwise render 16 tiles
 * and lose two.
 */
export function backpackGrid(backpackSlots: number): { rows: number; cols: number } {
  const rows = 2
  return { rows, cols: Math.ceil(backpackSlots / rows) }
}

/**
 * The label a tile shows: the item key and its count, or nothing.
 *
 * A count of 1 shows no number. A tile reading "bazooka x1" next to one reading
 * "grenade x3" makes the 1 look like a quantity worth noticing; it is the
 * default.
 */
export function tileLabel(slot: SlotView | undefined): string {
  if (!slot?.key) return ''
  return slot.count > 1 ? `${slot.key} x${slot.count}` : slot.key
}

/**
 * Which quick-bar slot a wheel notch selects, wrapping.
 *
 * Wraps within the **bar**, never into the backpack: firing acts on the
 * selection, and a wheel that could park the trigger on something off-screen is
 * the same defect `Inventory::select` refuses server-side.
 */
export function wheelSelect(current: number, delta: number, quickSlots: number): number {
  if (quickSlots <= 0) return current
  const step = delta > 0 ? 1 : -1
  return (((current + step) % quickSlots) + quickSlots) % quickSlots
}
