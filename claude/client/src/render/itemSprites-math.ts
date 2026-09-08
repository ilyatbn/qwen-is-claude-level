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
  /**
   * Does holding fire keep this weapon firing? (§F3)
   *
   * **Absent for anything that is not a weapon**, and that is the point: a
   * medkit is not "not automatic", it is a thing the question was never asked
   * of. Emitting `false`/`0` for it would invite the first caller who reads a
   * zero cooldown as "repeat as fast as you like".
   */
  auto?: boolean
  /** Seconds between shots, from the weapon def. Absent for non-weapons. */
  cooldown?: number
}

export interface WorldItemView {
  id: number
  /**
   * The registry id, or `null` when the server has not said which — which is
   * every crate the client watched arrive (`crate_spawn` carries no `item_id`).
   * See the same field on `net/worldMirror`'s `WorldItemView` for why this is
   * nullable and what it cost when it was not.
   */
  item: number | null
  /** Stack size, or `null` when the server has not said. */
  count: number | null
  x: number
  y: number
  source: string
  /**
   * Has it come to rest? Nothing tracked this before T13.05, which is why
   * `isFallingCrate` sat here for three milestones taking an argument no caller
   * could supply — and why crates were drawn hanging in the sky (§C7).
   */
  grounded: boolean
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

/**
 * A falling item does not bob. It is being carried by gravity, and adding a
 * sine wave to that reads as the sprite being loose from the thing it draws.
 */
export function bobFor(item: WorldItemView, id: number, t: number): number {
  return item.grounded ? bobOffset(id, t) : 0
}

/**
 * Beacon brightness, 0..1, pulsing once a second.
 *
 * A constant glow is a decal; the pulse is what carries across a map (`docs/32`
 * §4 — the crate is meant to *pull players together*, so it has to be findable
 * from off screen).
 */
export function beaconPulse(t: number): number {
  return 0.35 + 0.3 * (0.5 + 0.5 * Math.sin(t * Math.PI * 2))
}

/**
 * The art key for a world item, before asking whether any art exists under it.
 *
 * This was `frameFor`, which answered "the frame, if the atlas has it" — one
 * function doing the mapping and the existence probe together. The inventory
 * needs the mapping alone and has no `WorldItemView` to ask with, so the two
 * halves are separate now: this, and `artFor` below.
 *
 * `frameFor` itself was **deleted rather than kept**. Once `spawn` moved to
 * `artFor` its only importer was its own test, so it was nine assertions
 * guarding code nothing called while reading as live to the next person —
 * `describeRoom`'s situation in T17.02, and answered the same way. It was three
 * lines composing the two functions that remain; anyone who wants it back can
 * write it again in less time than reading this took.
 */
export function spriteKeyFor(
  item: WorldItemView,
  defs: Map<number, ItemDefView>,
): string | null {
  if (item.source === 'Crate') return 'crate'
  if (item.item === null) return null
  return defs.get(item.item)?.sprite ?? null
}

/**
 * `registry key → art key`, for the half of the game that holds the first and
 * needs the second.
 *
 * The world asks `spriteKeyFor` with an item id; the inventory has only the
 * registry key the `inventory` event carries. **Both must land on the same art
 * key or a bazooka is one picture on the ground and another in the bag** —
 * which is what `world_and_inventory_resolve_an_item_to_the_same_art_key`
 * asserts, and it is the guarantee the deleted `frameFor` drift test used to
 * stand in for. That test compared a function against the function it called;
 * this compares the two paths that actually exist.
 */
export function spriteByRegistryKey(defs: Map<number, ItemDefView>): Map<string, string> {
  const out = new Map<string, string>()
  for (const d of defs.values()) if (d.key) out.set(d.key, d.sprite)
  return out
}

/** What automatic fire needs to know about one weapon (§F3). */
export interface FireProfile {
  auto: boolean
  cooldown: number
}

/**
 * `registry key → its firing cadence`, for §F3's hold-to-repeat.
 *
 * Built from the same parsed registry the art mapping is, and for the same
 * reason: this is the one place `item_registry_json()` is read, so it is the one
 * place a mapping off it is derived. A copy of five cooldowns in TypeScript is a
 * second source of truth that fails silently — nothing goes red when a constant
 * moves and the copy does not.
 *
 * **Only entries the registry gave a cadence for**, so a non-weapon is absent
 * rather than present-and-zero.
 */
export function fireProfileByRegistryKey(
  defs: Map<number, ItemDefView>,
): Map<string, FireProfile> {
  const out = new Map<string, FireProfile>()
  for (const d of defs.values()) {
    if (!d.key || typeof d.cooldown !== 'number') continue
    out.set(d.key, { auto: d.auto === true, cooldown: d.cooldown })
  }
  return out
}

/** Where an item's art comes from, or nothing at all. */
export type ItemArt =
  | { kind: 'atlas'; frame: string }
  | { kind: 'texture'; key: string }
  | null

/**
 * The fallback order, written once: packed atlas frame, else the procedural
 * canvas `ensureItemTextures` registered under the same key, else nothing.
 *
 * `docs/50` §8 and `docs/51` §5 — the procedural icon is the fallback, *not* a
 * competitor to packed art. Eighteen v3 items have no packed frame (§B20).
 *
 * Both the world sprite and the inventory tile resolve through this. They used
 * to be one path and a text label; when the tile started drawing art, the
 * alternative was a second copy of these three lines, and a second copy is how
 * the two would come to disagree about which item looks like what.
 */
export function artFor(
  sprite: string | null,
  hasAtlasFrame: (f: string) => boolean,
  hasTexture: (k: string) => boolean,
): ItemArt {
  if (!sprite) return null
  if (hasAtlasFrame(sprite)) return { kind: 'atlas', frame: sprite }
  if (hasTexture(sprite)) return { kind: 'texture', key: sprite }
  return null
}

/**
 * The name that floats over an item on the ground (`docs/30` §5).
 *
 * **A crate is labelled by what it is, not by what is in it.** `crate_spawn`
 * does not carry the contents, and the old body read `defs.get(item.item)` with
 * `item` defaulted to 0 — so every supply crate on the map wore the name of
 * registry item 0, `Medkit`, whatever it actually held. That mislabelling is
 * also what sent T19.17 looking for a broken pickup path: the crate on seed 555
 * held two molotovs and was refused by §C24 exactly as specified.
 *
 * The unknown case is asked as `item === null` rather than as
 * `source === 'Crate'` so that the *joiner's* copy of the same crate — which
 * does carry an id, from the `item_spawn` catch-up — still names its contents.
 */
export function labelFor(
  item: WorldItemView,
  defs: Map<number, ItemDefView>,
): string {
  if (item.item === null) return item.source === 'Crate' ? 'Supply crate' : 'Item'
  const def = defs.get(item.item)
  const name = def?.name ?? `item ${item.item}`
  return item.count !== null && item.count > 1 ? `${name} x${item.count}` : name
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
      const view: ItemDefView = {
        id: d.id,
        key: String(d.key ?? ''),
        name: String(d.name ?? d.key ?? `item ${d.id}`),
        sprite: d.sprite,
        max_stack: Number(d.max_stack ?? 1),
      }
      // Carried through only when the registry actually said so, so "no cadence"
      // stays distinguishable from "a cadence of zero".
      if (typeof d.auto === 'boolean') view.auto = d.auto
      if (typeof d.cooldown === 'number') view.cooldown = d.cooldown
      out.set(d.id, view)
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
