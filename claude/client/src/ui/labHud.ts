/**
 * T23.21B — the look-lab's HUD (R11: the scene description's `hud`, which the mockup draws with
 * `e_style.js::hudE`). **The game's own classes**, fed the picture's values, so `look-hud` compares what a match draws
 * with what the mockup drew: the `Hud` timer, the `Bars` cluster and the quick bar (`InventoryPanel`), in the seat
 * colour the picture names (`accent`, F1's team A).
 *
 * The picture's values, and where each comes from (`hudE`'s own literals): the timer is the scene's `hud.timer`;
 * HP 78 %, EN 100 %, JET 62 %; seven slots `— RKT GUN GRN FLM LSR —` with RKT selected. The slots carry the game's
 * weapon keys for those labels — the lab has no item art, so a tile shows its key, the game's own fallback.
 */
import { C } from '../core'
import type { Hud as HudData } from '../look/scene'
import { Bars } from './bars'
import { energyBar, healthBar, jetpackBar } from './bars-math'
import { Hud } from './hud'
import { InventoryPanel, type SlotView } from './inventory'

/** `hudE`'s bar values, as fractions of each bar. */
export const LAB_BARS = { hp: 0.78, en: 1, jet: 0.62 } as const
/** `hudE`'s slots (`slot(false,'—'), slot(true,'RKT'), …`) as the game's weapon keys; null = an empty slot. */
export const LAB_SLOTS: readonly (string | null)[] = [null, 'bazooka', 'smg', 'grenade', 'flamethrower', 'laser_pistol', null]
export const LAB_SELECTED = 1

/** `m:ss` → seconds (the scene stores the picture's timer as text). */
export function timerSeconds(text: string): number {
  const m = /^(\d+):(\d\d)$/.exec(text)
  if (!m) throw new Error(`look-lab hud: timer "${text}" is not m:ss`)
  return Number(m[1]) * 60 + Number(m[2])
}

/** The mounted HUD; `destroy` takes every element off the page. Needs `Core.init()` first (it reads `C()`). */
export function mountLabHud(doc: Document, hud: HudData): { destroy(): void } {
  const c = C()
  const timer = new Hud(doc)
  timer.update('playing', timerSeconds(hud.timer), 0, c.TIMER_WARN_SECONDS)

  const bars = new Bars(doc)
  bars.update({
    health: healthBar(LAB_BARS.hp * c.BASE_HEALTH, c.BASE_HEALTH, c.HEALTH_CAP),
    energy: energyBar(LAB_BARS.en * c.BATTERY_MAX, c.BATTERY_MAX),
    jetpack: jetpackBar(LAB_BARS.jet * c.JETPACK_MAX_FUEL, c.JETPACK_MAX_FUEL, false),
    consumables: { heals: 0, batteries: 0, maxHeals: c.MAX_HEALS, maxBatteries: c.MAX_BATTERIES },
  })

  const none = (): void => {}
  const inv = new InventoryPanel({ moveItem: none, dropItem: none, toggleBackpack: none, selectSlot: none }, c.QUICK_SLOTS, 0, doc)
  const slots: SlotView[] = LAB_SLOTS.slice(0, c.QUICK_SLOTS).map((key, slot) => ({ slot, key, count: key ? 1 : 0 }))
  inv.update(slots, LAB_SELECTED)
  inv.setAccent(hud.accent)

  return {
    destroy(): void {
      timer.destroy()
      bars.destroy()
      inv.destroy()
    },
  }
}
