//! The item registry: a compile-time table, not a data file.
//!
//! With six items a `static` array turns typos into compile errors and needs no
//! parser and no error handling. `ItemDef` is the seam — when the count justifies
//! RON or JSON, nothing outside this file changes.
//!
//! See `docs/30-items-inventory.md` §1.

use crate::constants::{BAZOOKA_AMMO, GRENADE_AMMO, MEDKIT_HEAL, SHIELD_DURATION, SMG_AMMO};

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

#[derive(Copy, Clone, Debug, PartialEq, Eq)]
pub enum UtilityId {
    Flashlight,
}

#[derive(Copy, Clone, Debug, PartialEq)]
pub enum ItemKind {
    Weapon(WeaponId),
    Heal { amount: f32 },
    Shield { duration: f32 },
    Utility(UtilityId),
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
];

/// Direct index — ids are exactly `0..ITEMS.len()`, which a test asserts.
pub fn def(id: ItemId) -> Option<&'static ItemDef> {
    ITEMS.get(id as usize)
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
                ItemKind::Weapon(_) => {
                    assert!(d.max_stack > 1, "{} is a weapon with no ammo depth", d.key)
                }
                _ => assert!(d.max_stack <= 3),
            }
        }
    }
}
