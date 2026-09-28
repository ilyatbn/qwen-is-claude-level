/**
 * T23.16: every weapon a player can hold has a model — counted at both ends: the registry's weapon items
 * (`crates/game-core/src/items/registry.rs`, read off its source) against the model table (`weapons.ts::WEAPONS`) and
 * the class lists the icons and `weapons-held` read (`FIREARMS`, `MELEE_THROWN`).
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { ICON_SPRITES, iconWeapon, pickupScale, PICKUP_BOX, PICKUP_S } from './icons'
import { FIREARMS, MELEE_THROWN, WEAPONS, held, weaponReach } from './weapons'

const crates = join(dirname(fileURLToPath(import.meta.url)), '../../../../crates/game-core/src')
const registry = readFileSync(join(crates, 'items/registry.rs'), 'utf8')
const defs = readFileSync(join(crates, 'weapons/defs.rs'), 'utf8')

/** `ItemDef { … key: "k", … kind: ItemKind::Weapon(…), … sprite: "s", … }` → the weapon items, key and sprite. */
function registryWeapons(): { key: string; sprite: string }[] {
  const out: { key: string; sprite: string }[] = []
  for (const block of registry.split('ItemDef {').slice(1)) {
    const key = block.match(/\bkey: "(\w+)"/)?.[1]
    const kind = block.match(/\bkind: ItemKind::(\w+)/)?.[1]
    const sprite = block.match(/\bsprite: "(\w+)"/)?.[1]
    if (key && sprite && kind === 'Weapon') out.push({ key, sprite })
  }
  return out
}

/** `weapons/defs.rs`: each weapon's key and its delivery (`Delivery::Melee`, …). */
function deliveries(): Map<string, string> {
  const m = new Map<string, string>()
  for (const [, key, d] of defs.matchAll(/key: "(\w+)",\s*delivery: Delivery::(\w+)/g)) m.set(key!, d!)
  return m
}

describe('the arsenal (T23.16)', () => {
  const reg = registryWeapons()

  it('reads 21 weapon items off the registry, and the reading has a control', () => {
    // 21: `M23-INVENTORY.md` § 4's 27 weapon ids less meteor, the four sub-munitions and the platform gun, none of
    // which is an item. The control: the registry has non-weapon items this reading must not count.
    expect(reg.length).toBe(21)
    expect(registry.match(/kind: ItemKind::Utility/g)?.length).toBeGreaterThan(0)
  })

  it('has one model per registry weapon, and none besides', () => {
    const models = Object.keys(WEAPONS).sort()
    expect(models).toEqual(reg.map((r) => r.key).sort())
  })

  it('splits the models into firearms and melee/thrown, each weapon in exactly one', () => {
    const all = [...FIREARMS, ...MELEE_THROWN]
    expect(new Set(all).size).toBe(all.length)
    expect([...all].sort()).toEqual(Object.keys(WEAPONS).sort())
    expect(FIREARMS.length).toBe(9)
    expect(MELEE_THROWN.length).toBe(12)
  })

  it("agrees with the simulation's deliveries: a firearm neither swings nor is thrown; a melee weapon swings", () => {
    const d = deliveries()
    for (const k of FIREARMS) {
      expect(WEAPONS[k]!.melee, k).toBeFalsy()
      expect(WEAPONS[k]!.thrown, k).toBeFalsy()
      expect(d.get(k), k).not.toBe('Melee')
    }
    for (const k of MELEE_THROWN) {
      expect(!!WEAPONS[k]!.melee || !!WEAPONS[k]!.thrown, k).toBe(true)
      expect(WEAPONS[k]!.melee ?? false, k).toBe(d.get(k) === 'Melee')
    }
  })

  it('gives every firearm a muzzle ahead of its grips and inside its drawn reach', () => {
    for (const k of FIREARMS) {
      const W = WEAPONS[k]!
      const [x0, y0, x1, y1] = weaponReach(k)
      for (const g of W.grips) expect(W.muzzle[0], k).toBeGreaterThan(g[0])
      expect(W.muzzle[0] >= x0 && W.muzzle[0] <= x1 && W.muzzle[1] >= y0 && W.muzzle[1] <= y1, k).toBe(true)
      expect(held(k), k).not.toBeNull()
    }
    expect(held('platform_gun')).toBeNull()
  })

  it('draws an icon for every weapon from its model, keyed by the registry sprite (T23.17: all 21)', () => {
    expect(Object.keys(ICON_SPRITES).sort()).toEqual(reg.map((r) => r.sprite).sort())
    for (const r of reg) expect(iconWeapon(r.sprite), r.key).toBe(r.key)
    // The control: a non-weapon item's sprite draws no weapon.
    expect(iconWeapon('item_battery')).toBeNull()
  })

  it('leaves the four sub-munitions, the meteor and the platform gun without a model — and names them (T23.17)', () => {
    // `weapons/defs.rs` holds every WeaponId; each is a held model or one of these, never both, never neither.
    const d = [...deliveries().keys()]
    expect(d.length).toBe(27)
    const unheld = d.filter((k) => !WEAPONS[k]).sort()
    expect(unheld).toEqual(['airburst_pellet', 'flame', 'meteor', 'meteor_fragment', 'platform_gun', 'toxic_drop'])
    expect(d.filter((k) => WEAPONS[k]).sort()).toEqual(Object.keys(WEAPONS).sort())
  })

  it('fits a pickup to its box by length, and keeps a small one at full scale', () => {
    expect(pickupScale(10, 8)).toBe(PICKUP_S)
    expect(pickupScale(PICKUP_BOX[0] * 2, 8)).toBeCloseTo(PICKUP_S / 2)
    expect(pickupScale(10, PICKUP_BOX[1] * 4)).toBeCloseTo(PICKUP_S / 4)
  })
})
