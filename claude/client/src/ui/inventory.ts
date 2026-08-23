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
  tileLabel,
  wheelSelect,
  type SlotView,
} from './inventory-math'

export interface InventoryDeps {
  /** Send the drag. The server validates and answers with `inventory`. */
  moveItem(from: number, to: number): void
  /** Select a quick-bar slot. */
  selectSlot(slot: number): void
}

const TILE = 46

export class InventoryPanel {
  readonly root: HTMLDivElement
  readonly bar: HTMLDivElement
  readonly backpack: HTMLDivElement
  private readonly tiles: HTMLDivElement[] = []
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

  /** Render the server's answer. One-way: this never writes back. */
  update(slots: readonly SlotView[], selected: number): void {
    this.slots = slots.map((s) => ({ ...s }))
    this.selected = selected
    for (let i = 0; i < this.tiles.length; i++) {
      const tile = this.tiles[i]!
      const slot = slots[i]
      tile.textContent = tileLabel(slot)
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

export { backpackGrid, isDragWorthSending, regionOf, tileLabel, wheelSelect }
export type { SlotView }
