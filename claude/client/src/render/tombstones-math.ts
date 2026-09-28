/**
 * Tombstone bookkeeping (§B8). Phaser-free (§A8).
 *
 * The whole of this file is "which graves changed", and it exists as its own
 * module for one reason: the diff is the part that can be wrong in a way a
 * screenshot will not show. A grave drawn twice, or one the server evicted and
 * the client kept, looks like a normal graveyard.
 */

export interface TombstoneView {
  id: number
  owner: number
  x: number
  y: number
}

/**
 * What to add and what to remove, given the graves on screen and the graves the
 * server says exist.
 *
 * Positions can change after placement — a grave falls when the ground under it
 * is carved — so an id present in both is *kept*, not skipped, and the caller
 * moves it. Returning it in `add` would rebuild the sprite every tick it fell.
 */
export function diffTombstones(
  drawn: Iterable<number>,
  live: readonly TombstoneView[],
): { add: TombstoneView[]; remove: number[] } {
  const have = new Set(drawn)
  const want = new Set(live.map((t) => t.id))
  return {
    add: live.filter((t) => !have.has(t.id)),
    remove: [...have].filter((id) => !want.has(id)),
  }
}

/** Is this grave close enough to the listener to bother labelling? */
export function withinNameRange(
  t: { x: number; y: number },
  eye: { x: number; y: number },
  range: number,
): boolean {
  const dx = t.x - eye.x
  const dy = t.y - eye.y
  return dx * dx + dy * dy <= range * range
}
