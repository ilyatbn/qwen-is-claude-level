//! The item registry: a compile-time table, not a data file.
//!
//! With six items a `static` array turns typos into compile errors and needs no
//! parser and no error handling. `ItemDef` is the seam — when the count justifies
//! RON or JSON, nothing outside this file changes.
//!
//! See `docs/30-items-inventory.md` §1.

use crate::constants::{
    BATTERY_PACK_AMOUNT, BAZOOKA_AMMO, DEAGLE_AMMO, GRENADE_AMMO, MACHINEGUN_AMMO, MEDKIT_HEAL,
    PISTOL_AMMO, REVOLVER_AMMO, SHIELD_DURATION, SMG_AMMO,
};

pub type ItemId = u16;

/// Forward declaration until T4.08 gives weapons behaviour.
///
/// A newtype rather than a stub enum: T4.08 can give it variants or an index into
/// its own table without any call site here changing, and a bare `u16` would let a
/// weapon id and an item id be swapped silently.
#[derive(Copy, Clone, Debug, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct WeaponId(pub u16);

pub const WEAPON_BAZOOKA: WeaponId = WeaponId(0);
pub const WEAPON_GRENADE: WeaponId = WeaponId(1);
pub const WEAPON_SMG: WeaponId = WeaponId(2);
/// Weather ordnance. Not carryable and never in the item registry — they exist so
/// meteors reuse the projectile simulation (gravity, sub-stepped terrain
/// collision, player AABB tests) rather than growing a parallel one that drifts
/// (`docs/13-weather-effects.md` §4).
pub const WEAPON_METEOR: WeaponId = WeaponId(3);
pub const WEAPON_METEOR_FRAG: WeaponId = WeaponId(4);
pub const WEAPON_LASER_PISTOL: WeaponId = WeaponId(5);
pub const WEAPON_LASER_SMG: WeaponId = WeaponId(6);
/// Ballistic hitscan (§B7). **Appended, never inserted** — `defs::def` indexes by
/// array position, so a new id in the middle remaps every weapon after it.
pub const WEAPON_PISTOL: WeaponId = WeaponId(7);
pub const WEAPON_REVOLVER: WeaponId = WeaponId(8);
pub const WEAPON_DEAGLE: WeaponId = WeaponId(9);
pub const WEAPON_MACHINEGUN: WeaponId = WeaponId(10);

#[derive(Copy, Clone, Debug, PartialEq, Eq)]
pub enum UtilityId {
    Flashlight,
}

#[derive(Copy, Clone, Debug, PartialEq)]
pub enum ItemKind {
    Weapon(WeaponId),
    Heal {
        amount: f32,
    },
    Shield {
        duration: f32,
    },
    Utility(UtilityId),
    /// Charge for shields and energy weapons (§B5).
    Battery {
        amount: f32,
    },
}

#[derive(Debug)]
pub struct ItemDef {
    /// Stable and never reused: it goes on the wire in snapshots and `item_spawn`.
    pub id: ItemId,
    pub key: &'static str,
    pub name: &'static str,
    pub kind: ItemKind,
    /// For weapons this is ammo — a second bazooka gives 8 rockets in one slot.
    pub max_stack: u8,
    pub sprite: &'static str,
    pub spawn_weight: u16,
    pub crate_weight: u16,
    pub buried_weight: u16,
}

pub const MEDKIT: ItemId = 0;
pub const SHIELD_GENERATOR: ItemId = 1;
pub const FLASHLIGHT: ItemId = 2;
/// §B5. Ids are stable and never reused, so this goes after the weapons.
pub const BATTERY_PACK: ItemId = 6;
pub const LASER_PISTOL: ItemId = 7;
pub const LASER_SMG: ItemId = 8;
pub const PISTOL: ItemId = 9;
pub const REVOLVER: ItemId = 10;
pub const DEAGLE: ItemId = 11;
pub const MACHINEGUN: ItemId = 12;
pub const BAZOOKA: ItemId = 3;
pub const GRENADE: ItemId = 4;
pub const SMG: ItemId = 5;

/// The v1 arsenal, transcribed from `docs/30-items-inventory.md` §1.
///
/// `flashlight` carries the **highest buried weight in the table**, deliberately:
/// the item you most need at night is the one you have to dig for, which makes
/// "dig for the flashlight before nightfall" a real strategy without a tutorial
/// ever saying so. A test protects that ordering from an accidental edit.
pub static ITEMS: &[ItemDef] = &[
    ItemDef {
        id: MEDKIT,
        key: "medkit",
        name: "Medkit",
        kind: ItemKind::Heal {
            amount: MEDKIT_HEAL,
        },
        max_stack: 3,
        sprite: "item_medkit",
        spawn_weight: 30,
        crate_weight: 25,
        buried_weight: 20,
    },
    ItemDef {
        id: SHIELD_GENERATOR,
        key: "shield_generator",
        name: "Shield Generator",
        kind: ItemKind::Shield {
            duration: SHIELD_DURATION,
        },
        max_stack: 2,
        sprite: "item_shield",
        spawn_weight: 12,
        crate_weight: 18,
        buried_weight: 15,
    },
    ItemDef {
        id: FLASHLIGHT,
        key: "flashlight",
        name: "Flashlight",
        kind: ItemKind::Utility(UtilityId::Flashlight),
        max_stack: 1,
        sprite: "item_flashlight",
        spawn_weight: 8,
        crate_weight: 12,
        buried_weight: 25,
    },
    ItemDef {
        id: BAZOOKA,
        key: "bazooka",
        name: "Bazooka",
        kind: ItemKind::Weapon(WEAPON_BAZOOKA),
        max_stack: BAZOOKA_AMMO,
        sprite: "weapon_bazooka",
        spawn_weight: 22,
        crate_weight: 20,
        buried_weight: 15,
    },
    ItemDef {
        id: GRENADE,
        key: "grenade",
        name: "Grenade",
        kind: ItemKind::Weapon(WEAPON_GRENADE),
        max_stack: GRENADE_AMMO,
        sprite: "weapon_grenade",
        spawn_weight: 20,
        crate_weight: 15,
        buried_weight: 15,
    },
    ItemDef {
        id: SMG,
        key: "smg",
        name: "SMG",
        kind: ItemKind::Weapon(WEAPON_SMG),
        max_stack: SMG_AMMO,
        sprite: "weapon_smg",
        spawn_weight: 8,
        crate_weight: 10,
        buried_weight: 10,
    },
    ItemDef {
        id: BATTERY_PACK,
        key: "battery_pack",
        name: "Battery Pack",
        kind: ItemKind::Battery {
            amount: BATTERY_PACK_AMOUNT,
        },
        max_stack: 3,
        sprite: "item_battery",
        // Weighted like the shield generator it feeds: it is the same resource,
        // and a map where lasers are common but charge is rare would make the
        // whole energy branch of the arsenal dead weight.
        spawn_weight: 14,
        crate_weight: 18,
        buried_weight: 12,
    },
    // The energy weapons the battery exists for (§B5).
    //
    // **Every weight is 0: they do not spawn yet, and T11.04 turns them on.**
    // Not a placeholder — a measured decision. Bots choose a weapon only when a
    // stack empties, so they can neither switch *to* a laser nor away from an
    // uncharged one; with these in the pool a bot ends up permanently holding a
    // paperweight, permanently "unarmed", and permanently shopping. Measured:
    // lasers in the pool give `ticks_engaged: 0` over 36,000 ticks, and the same
    // run with only the battery pack added fights normally. Shipping them now
    // would mean shipping an item class the AI cannot use, so the defs (which is
    // what §B5 needs to be testable) land here and the *items* wait for T11.04
    // to give bots weapon selection.
    //
    // `max_stack` is 1 because the stack is the weapon itself: ammo is charge.
    ItemDef {
        id: LASER_PISTOL,
        key: "laser_pistol",
        name: "Laser Pistol",
        kind: ItemKind::Weapon(WEAPON_LASER_PISTOL),
        max_stack: 1,
        sprite: "weapon_laser_pistol",
        spawn_weight: 0,
        crate_weight: 0,
        buried_weight: 0,
    },
    ItemDef {
        id: LASER_SMG,
        key: "laser_smg",
        name: "Laser SMG",
        kind: ItemKind::Weapon(WEAPON_LASER_SMG),
        max_stack: 1,
        sprite: "weapon_laser_smg",
        spawn_weight: 0,
        crate_weight: 0,
        buried_weight: 0,
    },
    // Ballistic sidearms and automatics (§B7). Bots already handle stack-ammo
    // hitscan — it is what the smg is — so unlike the lasers these spawn from
    // the day they land.
    //
    // These weights are **provisional and will move**: §B17 says the pool is a
    // budget, not a list, and adding four items to a table summing to ~114
    // dilutes every existing entry by roughly a quarter without any existing
    // weight changing. T11.09 rebalances the whole table from measured pick
    // rates. They are deliberately modest so the dilution is small until then.
    ItemDef {
        id: PISTOL,
        key: "pistol",
        name: "Pistol",
        kind: ItemKind::Weapon(WEAPON_PISTOL),
        max_stack: PISTOL_AMMO,
        sprite: "weapon_pistol",
        // The commonest gun on the map: it is the thing you find when you find
        // nothing else, which is what makes running dry a state you can leave.
        spawn_weight: 18,
        crate_weight: 8,
        buried_weight: 10,
    },
    ItemDef {
        id: REVOLVER,
        key: "revolver",
        name: "Revolver",
        kind: ItemKind::Weapon(WEAPON_REVOLVER),
        max_stack: REVOLVER_AMMO,
        sprite: "weapon_revolver",
        spawn_weight: 10,
        crate_weight: 12,
        buried_weight: 10,
    },
    ItemDef {
        id: DEAGLE,
        key: "deagle",
        name: "Desert Eagle",
        kind: ItemKind::Weapon(WEAPON_DEAGLE),
        max_stack: DEAGLE_AMMO,
        sprite: "weapon_deagle",
        // Eight shots at 45 damage is two kills if every one lands. Rare on the
        // ground, likelier in a crate — a crate is contested, and this is worth
        // contesting.
        spawn_weight: 6,
        crate_weight: 14,
        buried_weight: 8,
    },
    ItemDef {
        id: MACHINEGUN,
        key: "machinegun",
        name: "Machine Gun",
        kind: ItemKind::Weapon(WEAPON_MACHINEGUN),
        max_stack: MACHINEGUN_AMMO,
        sprite: "weapon_machinegun",
        spawn_weight: 8,
        crate_weight: 12,
        buried_weight: 8,
    },
];

/// Direct index — ids are exactly `0..ITEMS.len()`, which a test asserts.
/// Look an item up by id.
///
/// **Indexes by array position**, so this table's order *is* the id mapping —
/// the same trap `weapons::defs::def` carries. Inserting anywhere but the end
/// remaps every item after it, and the symptom is a battery pack resolving as a
/// shield generator rather than anything that looks like a bug.
/// `item_ids_match_their_positions` turns that into a red test.
pub fn def(id: ItemId) -> Option<&'static ItemDef> {
    ITEMS.get(id as usize).filter(|d| d.id == id)
}

pub fn by_key(key: &str) -> Option<&'static ItemDef> {
    ITEMS.iter().find(|d| d.key == key)
}

pub fn max_stack(id: ItemId) -> u8 {
    def(id).map_or(1, |d| d.max_stack)
}

#[derive(Copy, Clone, Debug, PartialEq, Eq)]
pub enum WeightColumn {
    Spawn,
    Crate,
    Buried,
}

/// Weights for one column, parallel to `ITEMS`.
///
/// Three columns rather than one so crates can skew toward weapons and buried slots
/// toward the flashlight without a second table.
pub fn weights(col: WeightColumn) -> Vec<u16> {
    ITEMS
        .iter()
        .map(|d| match col {
            WeightColumn::Spawn => d.spawn_weight,
            WeightColumn::Crate => d.crate_weight,
            WeightColumn::Buried => d.buried_weight,
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashSet;

    #[test]
    fn ids_are_unique_and_exactly_zero_to_len() {
        // The direct-index fast path in `def` depends on this, so it is asserted
        // rather than assumed.
        let ids: HashSet<ItemId> = ITEMS.iter().map(|d| d.id).collect();
        assert_eq!(ids.len(), ITEMS.len(), "duplicate item id");
        for (i, d) in ITEMS.iter().enumerate() {
            assert_eq!(d.id as usize, i, "{} is not at its own index", d.key);
        }
    }

    #[test]
    fn keys_and_sprites_are_unique_and_non_empty() {
        let keys: HashSet<&str> = ITEMS.iter().map(|d| d.key).collect();
        assert_eq!(keys.len(), ITEMS.len(), "duplicate key");
        for d in ITEMS {
            assert!(!d.key.is_empty());
            assert!(!d.sprite.is_empty(), "{} has no sprite", d.key);
            assert!(!d.name.is_empty());
            assert!(d.max_stack >= 1, "{} cannot be stacked at all", d.key);
        }
    }

    #[test]
    fn def_and_by_key_resolve() {
        for (i, d) in ITEMS.iter().enumerate() {
            assert_eq!(def(i as ItemId).map(|x| x.key), Some(d.key));
        }
        assert!(def(999).is_none());
        assert_eq!(by_key("bazooka").map(|d| d.id), Some(BAZOOKA));
        assert!(by_key("nope").is_none());
    }

    #[test]
    fn every_column_can_produce_something() {
        for col in [
            WeightColumn::Spawn,
            WeightColumn::Crate,
            WeightColumn::Buried,
        ] {
            let w = weights(col);
            assert_eq!(w.len(), ITEMS.len());
            assert!(
                w.iter().any(|&x| x > 0),
                "{col:?} can never produce an item — that spawn source is dead"
            );
        }
    }

    #[test]
    fn effects_track_the_constants_not_literals() {
        // Asserting against the constants means a tuning change cannot silently
        // desync the registry from `docs/02-constants.md`.
        match def(MEDKIT).map(|d| d.kind) {
            Some(ItemKind::Heal { amount }) => assert_eq!(amount, MEDKIT_HEAL),
            other => panic!("medkit is not a heal: {other:?}"),
        }
        match def(SHIELD_GENERATOR).map(|d| d.kind) {
            Some(ItemKind::Shield { duration }) => assert_eq!(duration, SHIELD_DURATION),
            other => panic!("shield generator is not a shield: {other:?}"),
        }
        assert_eq!(max_stack(BAZOOKA), BAZOOKA_AMMO);
    }

    /// `def()` indexes by position, so this table's order *is* the id mapping.
    /// Inserting in the middle remaps every item after it.
    #[test]
    fn item_ids_match_their_positions() {
        for (i, d) in ITEMS.iter().enumerate() {
            assert_eq!(
                d.id, i as ItemId,
                "{} sits at position {i} but claims id {} — every lookup after it \
                 resolves to the wrong item",
                d.key, d.id
            );
        }
        assert_eq!(max_stack(GRENADE), GRENADE_AMMO);
        assert_eq!(max_stack(SMG), SMG_AMMO);
    }

    #[test]
    fn the_flashlight_is_the_most_buried_item() {
        // A deliberate design choice (`docs/32` §5), protected from an accidental
        // weight edit: "dig for the flashlight before nightfall" only works if it
        // is genuinely the likeliest thing to be down there.
        let fl = def(FLASHLIGHT).expect("flashlight exists").buried_weight;
        for d in ITEMS {
            if d.id == FLASHLIGHT {
                continue;
            }
            assert!(
                d.buried_weight < fl,
                "{} has buried weight {} >= the flashlight's {fl}",
                d.key,
                d.buried_weight
            );
        }
    }

    #[test]
    fn weapons_carry_ammo_and_consumables_do_not() {
        for d in ITEMS {
            match d.kind {
                // A weapon must have *ammo*, and since §B5 there are two kinds:
                // a stack you spend, or a battery you spend. The rule is now
                // "one of the two", which is stricter than the old
                // `max_stack > 1` — that would pass a weapon with neither, and
                // an energy weapon legitimately has a stack of exactly 1 because
                // the stack *is* the weapon and the ammo is charge.
                ItemKind::Weapon(wid) => {
                    let energy = crate::weapons::defs::def(wid).is_some_and(|w| w.is_energy());
                    assert!(
                        d.max_stack > 1 || energy,
                        "{} is a weapon with neither ammo depth nor an energy cost",
                        d.key
                    );
                    if energy {
                        assert_eq!(
                            d.max_stack, 1,
                            "{} spends charge, so its stack is the weapon itself",
                            d.key
                        );
                    }
                }
                _ => assert!(d.max_stack <= 3),
            }
        }
    }
}
