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
  /**
   * The art key, resolved by the layer that already owns the registry.
   *
   * Optional because the wire does not carry it: the `inventory` event sends a
   * registry key, and `ItemDef.sprite` is a different string. `ItemLayer` parses
   * the registry once and answers `spriteForKey`, so this is threaded in rather
   * than re-derived here — a second resolution of one fact is the pattern that
   * produced two `wait_for`s, three `escapeHtml`s and two poison damage paths in
   * this build alone.
   */
  sprite?: string | null
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
 * What a tile puts in its corner once it is drawing art: the count, or nothing.
 *
 * Same rule as `tileLabel` — a lone `x1` reads as a quantity worth noticing —
 * but without the key, because the picture is now saying which item it is. The
 * key survives only in `tileLabel`, which is what a tile with no resolvable art
 * falls back to (`docs/50` §8).
 */
export function tileCount(slot: SlotView | undefined): string {
  if (!slot?.key) return ''
  return slot.count > 1 ? `x${slot.count}` : ''
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
