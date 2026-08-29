/**
 * §C10's inventory: an always-visible quick bar, and a backpack behind
 * right-click.
 *
 * DOM, like every other screen-space element (§A35), and **an overlay, not a
 * pause** — opening it changes nothing about the round, exactly as §B4
 * established for the death screen. Nothing here touches the simulation: a drag
 * emits `move_item` and then waits to be told what happened, because the server
 * is the authority (§C10) and a client that moved its own tiles first would show
 * a state the server never had for as long as the round trip takes.
 */

import {
  backpackGrid,
  isDragWorthSending,
  regionOf,
  tileCount,
  tileLabel,
  wheelSelect,
  type SlotView,
} from './inventory-math'

export interface InventoryDeps {
  /** Send the drag. The server validates and answers with `inventory`. */
  moveItem(from: number, to: number): void
  /** Select a quick-bar slot. */
  selectSlot(slot: number): void
  /**
   * The art for a sprite key, as a data URL, or `null` if none resolves.
   *
   * Injected rather than reached for, because this panel is DOM and the art
   * lives in Phaser's texture manager. `GameScene` supplies it over the same
   * textures `ItemLayer` draws from, resolved through the same `artFor` order —
   * so the tile and the world agree by construction instead of by two painter
   * tables that happen to match. `ensureItemTextures` stays where it is, called
   * once from `ItemLayer`'s constructor; nothing here rebuilds it.
   *
   * Absent in tests and wherever there is no renderer, which is what makes the
   * text fallback below reachable under `environment: 'node'`.
   */
  artUrl?(sprite: string): string | null
}

const TILE = 46

export class InventoryPanel {
  readonly root: HTMLDivElement
  readonly bar: HTMLDivElement
  readonly backpack: HTMLDivElement
  private readonly tiles: HTMLDivElement[] = []
  private readonly arts: HTMLElement[] = []
  private readonly texts: HTMLElement[] = []
  /**
   * Resolved data URLs, by sprite key.
   *
   * `update` runs on every `inventory` event, and re-encoding a texture to
   * base64 each time is work for an answer that cannot change: the textures are
   * registered once at construction. `null` is cached too, so an item with no
   * art does not re-ask on every event either.
   */
  private readonly artCache = new Map<string, string | null>()
  private readonly warned = new Set<string>()
  private slots: SlotView[] = []
  private selected = 0
  private open = false
  private dragFrom: number | null = null

  constructor(
    private readonly deps: InventoryDeps,
    private readonly quickSlots: number,
    backpackSlots: number,
    doc: Document = document,
  ) {
    const total = quickSlots + backpackSlots

    this.root = doc.createElement('div')
    this.root.id = 'inventory'
    // Centred at the bottom, above the HUD strip. `pointer-events` is on the
    // tiles, not the container: the container spans the width of the bar and a
    // transparent block over the play field would swallow clicks meant for it.
    this.root.style.cssText =
      // 34 px clears `#game-hud`, the full-width text strip pinned to bottom:0.
      'position:fixed;left:50%;bottom:34px;transform:translateX(-50%);z-index:13;' +
      'pointer-events:none;display:flex;flex-direction:column;align-items:center;gap:6px;'

    this.backpack = doc.createElement('div')
    this.backpack.id = 'inventory-backpack'
    const { cols } = backpackGrid(backpackSlots)
    this.backpack.style.cssText =
      `display:none;grid-template-columns:repeat(${cols}, ${TILE}px);gap:4px;` +
      'padding:6px;border-radius:6px;background:rgba(8,10,16,.82);' +
      'border:1px solid rgba(255,255,255,.18);'
    this.root.appendChild(this.backpack)

    this.bar = doc.createElement('div')
    this.bar.id = 'inventory-bar'
    this.bar.style.cssText = `display:grid;grid-template-columns:repeat(${quickSlots}, ${TILE}px);gap:4px;`
    this.root.appendChild(this.bar)

    for (let i = 0; i < total; i++) {
      const tile = doc.createElement('div')
      tile.dataset['slot'] = String(i)
      tile.draggable = true
      tile.style.cssText =
        `width:${TILE}px;height:${TILE}px;box-sizing:border-box;pointer-events:auto;` +
        'border:2px solid rgba(255,255,255,.22);border-radius:5px;' +
        'background:rgba(8,10,16,.72);position:relative;overflow:hidden;' +
        'font:600 9px/1.1 ui-monospace,SFMono-Regular,Menlo,monospace;color:#e9edf5;' +
        'display:flex;align-items:flex-end;padding:3px;text-shadow:0 1px 2px #000;' +
        'cursor:grab;user-select:none;'

      // Two layers, because `textContent` on the tile would wipe the art. The
      // art fills the tile and the text sits over it — a count in the corner
      // when there is art, the item key when there is not.
      const art = doc.createElement('i')
      art.dataset['art'] = '0'
      // `pixelated`: the source is 16 px in a 46 px box, and the browser's
      // default smoothing turns pixel art into a smear.
      art.style.cssText =
        'position:absolute;inset:3px;background-repeat:no-repeat;' +
        'background-position:center;background-size:contain;' +
        'image-rendering:pixelated;pointer-events:none;'
      tile.appendChild(art)

      const text = doc.createElement('b')
      text.style.cssText = 'position:relative;font-weight:600;word-break:break-all;'
      tile.appendChild(text)
      this.arts.push(art)
      this.texts.push(text)

      // Drag is client-side **intent** only: the tiles do not move here.
      tile.addEventListener('dragstart', (e) => {
        this.dragFrom = i
        e.dataTransfer?.setData('text/plain', String(i))
      })
      tile.addEventListener('dragover', (e) => e.preventDefault())
      tile.addEventListener('drop', (e) => {
        e.preventDefault()
        const raw = e.dataTransfer?.getData('text/plain')
        const from = raw !== undefined && raw !== '' ? Number(raw) : this.dragFrom
        this.dragFrom = null
        if (from === null || from === undefined) return
        if (!isDragWorthSending(from, i, this.slots, total)) return
        this.deps.moveItem(from, i)
      })
      // Click a quick-bar tile to select it; the backpack cannot be selected
      // (§C10), and the tile says so by not responding.
      tile.addEventListener('click', () => {
        if (regionOf(i, quickSlots) === 'quick') this.deps.selectSlot(i)
      })

      this.tiles.push(tile)
      ;(i < quickSlots ? this.bar : this.backpack).appendChild(tile)
    }

    doc.body.appendChild(this.root)
  }

  /** `true` while the backpack is showing. */
  get isOpen(): boolean {
    return this.open
  }

  /** Right-click, and `Esc`, both toggle. Returns the new state. */
  toggle(open = !this.open): boolean {
    this.open = open
    this.backpack.style.display = open ? 'grid' : 'none'
    return this.open
  }

  /** The wheel selects within the bar (§C10). */
  wheel(delta: number): void {
    this.deps.selectSlot(wheelSelect(this.selected, delta, this.quickSlots))
  }

  /**
   * The art for a slot, cached, warning once when nothing resolves.
   *
   * **Named for the cache, not for the resolution** — `artFor` is the shared
   * order in `itemSprites-math.ts` and this only calls through to it via
   * `deps.artUrl`. Two same-named functions inside one feature is what gets
   * "simplified" into one wrongly later, even when, as here, one of them is
   * plainly a wrapper.
   *
   * `docs/50` §8: the game starts with no art, and every fallback logs once —
   * `ItemLayer` warns per item id for the same reason, and per *sprite key* here
   * because that is what failed to resolve.
   *
   * **A cached `null` cannot go stale, and there is one thing it can cost.**
   * The procedural table is registered synchronously by `ensureItemTextures` in
   * `ItemLayer`'s constructor, before any tile renders, so a sprite the table
   * covers always resolves and a `null` can only belong to a sprite neither
   * source will ever hold. The atlas is the one asynchronous source: if it
   * arrives *after* the first inventory render, a sprite that has both is
   * pinned to its procedural answer for the session and never upgrades to the
   * packed frame. That is a quality ceiling, not staleness — the tile still
   * draws the right item — and it is why this cache is keyed on the sprite and
   * not on the slot.
   */
  private cachedArtUrl(slot: SlotView | undefined): string | null {
    const sprite = slot?.sprite ?? null
    if (!sprite || !this.deps.artUrl) return null
    const hit = this.artCache.get(sprite)
    if (hit !== undefined) return hit
    const url = this.deps.artUrl(sprite) ?? null
    this.artCache.set(sprite, url)
    if (!url && !this.warned.has(sprite)) {
      this.warned.add(sprite)
      console.info(`[inventory] no art for "${sprite}" — showing its name`)
    }
    return url
  }

  /** Render the server's answer. One-way: this never writes back. */
  update(slots: readonly SlotView[], selected: number): void {
    this.slots = slots.map((s) => ({ ...s }))
    this.selected = selected
    for (let i = 0; i < this.tiles.length; i++) {
      const tile = this.tiles[i]!
      const slot = slots[i]
      const url = this.cachedArtUrl(slot)
      const art = this.arts[i]!
      art.style.backgroundImage = url ? `url("${url}")` : ''
      art.dataset['art'] = url ? '1' : '0'
      // The picture says which item it is, so the text is only the count. With
      // no art the key comes back — that is the fallback, not a second style.
      this.texts[i]!.textContent = url ? tileCount(slot) : tileLabel(slot)
      const isSelected = i === selected && regionOf(i, this.quickSlots) === 'quick'
      tile.style.borderColor = isSelected ? '#ffd23f' : 'rgba(255,255,255,.22)'
      tile.style.background = slot?.key ? 'rgba(30,38,56,.86)' : 'rgba(8,10,16,.72)'
      tile.dataset['filled'] = slot?.key ? '1' : '0'
      tile.dataset['selected'] = isSelected ? '1' : '0'
    }
  }

  destroy(): void {
    this.root.remove()
  }
}

export { backpackGrid, isDragWorthSending, regionOf, tileCount, tileLabel, wheelSelect }
export type { SlotView }
