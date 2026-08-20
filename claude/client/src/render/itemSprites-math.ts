/**
 * World-item presentation, the arithmetic half (§A8 — no Phaser here).
 *
 * World items were tracked by `WorldMirror` from T6.08 and **drawn by nothing**,
 * so in the real game a medkit on the ground was invisible. That is a gameplay
 * bug wearing a cosmetic costume: you cannot go and get what you cannot see.
 *
 * Item art is keyed by `ItemDef.sprite`, which the registry has carried since
 * T4.01 and which nothing could read until `item_registry_json()` exported it —
 * the wire only carries a numeric `item_id`.
 */

export interface ItemDefView {
  id: number
  key: string
  name: string
  sprite: string
  max_stack: number
}

export interface WorldItemView {
  id: number
  item: number
  count: number
  x: number
  y: number
  source: string
}

/** Bob amplitude in world px, and the period in seconds. */
export const BOB_AMPLITUDE = 3
export const BOB_PERIOD = 1.6
/** Within this many world px, an item shows its name (`docs/30` §5). */
export const LABEL_RANGE = 110

/**
 * Vertical offset for the gentle bob.
 *
 * Phase is derived from the item id, so two items lying side by side are not
 * locked in step — a row of pickups pulsing in unison reads as a UI element
 * rather than as objects in the world.
 */
export function bobOffset(id: number, t: number): number {
  const phase = (id % 16) / 16
  return Math.sin((t / BOB_PERIOD + phase) * Math.PI * 2) * BOB_AMPLITUDE
}

/** Crates fall with a parachute and land as an ordinary pickup (`docs/32` §4). */
export function isFallingCrate(item: WorldItemView, grounded: boolean): boolean {
  return item.source === 'Crate' && !grounded
}

export function frameFor(
  item: WorldItemView,
  defs: Map<number, ItemDefView>,
  hasFrame: (f: string) => boolean,
): string | null {
  if (item.source === 'Crate') {
    if (hasFrame('crate')) return 'crate'
    return null
  }
  const def = defs.get(item.item)
  if (!def) return null
  return hasFrame(def.sprite) ? def.sprite : null
}

export function labelFor(
  item: WorldItemView,
  defs: Map<number, ItemDefView>,
): string {
  const def = defs.get(item.item)
  const name = def?.name ?? `item ${item.item}`
  return item.count > 1 ? `${name} x${item.count}` : name
}

/** Items close enough to the listener to be worth labelling. */
export function withinLabelRange(
  item: WorldItemView,
  player: { x: number; y: number },
  range = LABEL_RANGE,
): boolean {
  return Math.hypot(item.x - player.x, item.y - player.y) <= range
}

/** Parse `item_registry_json()` into a lookup, tolerating anything malformed. */
export function parseRegistry(json: string): Map<number, ItemDefView> {
  const out = new Map<number, ItemDefView>()
  try {
    const arr = JSON.parse(json) as unknown
    if (!Array.isArray(arr)) return out
    for (const raw of arr) {
      const d = raw as Partial<ItemDefView>
      if (typeof d.id !== 'number' || typeof d.sprite !== 'string') continue
      out.set(d.id, {
        id: d.id,
        key: String(d.key ?? ''),
        name: String(d.name ?? d.key ?? `item ${d.id}`),
        sprite: d.sprite,
        max_stack: Number(d.max_stack ?? 1),
      })
    }
  } catch {
    // A broken registry means placeholder boxes, not a broken game.
  }
  return out
}

/**
 * Reconcile a live item set against what is already on screen.
 *
 * Returns the ids to add, keep and remove — so the renderer never rebuilds the
 * whole layer on a set that mostly did not change, and a picked-up item leaves
 * exactly when the server says it did.
 */
export function diffItems(
  current: Iterable<number>,
  live: WorldItemView[],
): { add: number[]; remove: number[] } {
  const now = new Set(live.map((i) => i.id))
  const had = new Set(current)
  const add: number[] = []
  const remove: number[] = []
  for (const id of now) if (!had.has(id)) add.push(id)
  for (const id of had) if (!now.has(id)) remove.push(id)
  return { add, remove }
}
