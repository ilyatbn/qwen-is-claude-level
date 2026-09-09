//! The item registry: a compile-time table, not a data file.
//!
//! With six items a `static` array turns typos into compile errors and needs no
//! parser and no error handling. `ItemDef` is the seam — when the count justifies
//! RON or JSON, nothing outside this file changes.
//!
//! See `docs/30-items-inventory.md` §1.

use crate::constants::{
    AIRBURST_AMMO, BATTERY_PACK_AMOUNT, BAZOOKA_AMMO, DEAGLE_AMMO, FLAMETHROWER_AMMO, GRENADE_AMMO,
    MACHINEGUN_AMMO, MEDKIT_HEAL, MINE_AMMO, MOLOTOV_AMMO, PISTOL_AMMO, REVOLVER_AMMO, SMG_AMMO,
    SMOKE_AMMO, TOXIC_GRENADE_AMMO,
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
/// Melee (§B7). Appended, never inserted (§B16).
pub const WEAPON_KNIFE: WeaponId = WeaponId(11);
pub const WEAPON_BAT: WeaponId = WeaponId(12);
pub const WEAPON_WHIP: WeaponId = WeaponId(13);
pub const WEAPON_AXE: WeaponId = WeaponId(14);
pub const WEAPON_HAMMER: WeaponId = WeaponId(15);
pub const WEAPON_FLAMETHROWER: WeaponId = WeaponId(16);
pub const WEAPON_MINE: WeaponId = WeaponId(17);
/// Thrown ordnance (§B7). Appended, never inserted (§B16).
pub const WEAPON_AIRBURST: WeaponId = WeaponId(18);
pub const WEAPON_SMOKE: WeaponId = WeaponId(19);
pub const WEAPON_MOLOTOV: WeaponId = WeaponId(20);
pub const WEAPON_TOXIC_GRENADE: WeaponId = WeaponId(21);
/// An airburst's pellet. Not carryable and never in the item registry — the same
/// arrangement meteors have: it exists so pellets reuse the hitscan resolution
/// rather than growing a parallel one that drifts.
pub const WEAPON_AIRBURST_PELLET: WeaponId = WeaponId(22);
/// A falling drop of toxic rain (§C21). Not carryable and never in the item
/// registry, for the same reason as the meteor: puddles used to be placed
/// straight onto a surface point, which put them **inside caves** — rain that
/// fell through a roof. A drop that has to fall there cannot reach a cave floor
/// without an opening, so the bug is fixed by construction. Reusing the
/// projectile simulation is what makes that free, and it is what makes the rain
/// visible (§C4).
///
/// **Appended, never inserted** (§B16): `defs::def` indexes by array position.
pub const WEAPON_TOXIC_DROP: WeaponId = WeaponId(23);

/// §F5. Appended, never inserted — `WEAPONS[i].id == WeaponId(i)` and the client
/// mirrors that order in `WEAPON_KEYS` (§B16).
pub const WEAPON_SHOVEL: WeaponId = WeaponId(24);

/// One flame (§F10). **A weapon, and never an item** — like the meteor, the
/// airburst pellet and the toxic drop, it exists so that fire can use the shared
/// projectile step; nobody carries one and nothing spawns one on the ground.
///
/// It needs a `WeaponId` at all because `Projectile` carries one
/// (`weapons/projectile.rs`), which is also what gets it onto the wire and into
/// the client's `WEAPON_KEYS` so it can be drawn (§F10.3). Neither task file
/// says so; it falls out of a flame being a projectile.
///
/// **Appended, never inserted** (§B16).
pub const WEAPON_FLAME: WeaponId = WeaponId(25);

#[derive(Copy, Clone, Debug, PartialEq, Eq)]
pub enum UtilityId {
    Flashlight,
    /// T21.01. **A `Utility`, not a kind of its own**, because `Utility` is
    /// already the passive family: `use_item` refuses every one of them, and
    /// carrying one is the whole of using it. A fourth `ItemKind` per effect
    /// item would be a list by another name, and T21.09 sorts the backpack **by
    /// kind**.
    VampireFangs,
    /// T21.02. Passive like the rest: held, never used, never selected.
    IronmanBoots,
    /// T21.03. **Dropping is the only off switch** — see `WINGS_FLY_SPEED`.
    UnicornWings,
}

#[derive(Copy, Clone, Debug, PartialEq)]
pub enum ItemKind {
    Weapon(WeaponId),
    Heal {
        amount: f32,
    },
    /// A shield generator. **No payload** (T20.08): it used to carry the
    /// `duration` a use would set, and there is no use and no timer — carrying one
    /// is what protects you, and the cost is `SHIELD_HIT_COST` per hit.
    Shield,
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
pub const KNIFE: ItemId = 13;
pub const BAT: ItemId = 14;
pub const WHIP: ItemId = 15;
pub const AXE: ItemId = 16;
pub const HAMMER: ItemId = 17;
pub const FLAMETHROWER: ItemId = 18;
pub const MINE: ItemId = 19;
pub const AIRBURST: ItemId = 20;
pub const SMOKE: ItemId = 21;
pub const MOLOTOV: ItemId = 22;
pub const TOXIC_GRENADE: ItemId = 23;
/// §F5. `ITEMS` is indexed by id (`registry::def` is `ITEMS.get(id as usize)`),
/// so this is appended at index 24 and nothing before it may move.
pub const SHOVEL: ItemId = 24;
/// M21's effect items. **Appended, never inserted** (§B16) — `def` is
/// `ITEMS.get(id as usize)`, so a middle insertion remaps every id above it.
pub const VAMPIRE_FANGS: ItemId = 25;
pub const IRONMAN_BOOTS: ItemId = 26;
pub const UNICORN_WINGS: ItemId = 27;
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
        kind: ItemKind::Shield,
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
    // These shipped in T11.02 with every weight at **zero**, and that was a
    // measured decision rather than a placeholder: bots chose a weapon only when
    // a stack ran out, and an energy weapon's stack never does — so a bot that
    // picked one up held a paperweight for the rest of the round and read
    // `ticks_engaged: 0` over 36,000 ticks. T11.04 gave bots `wants_select`,
    // which is what lets them move *off* an uncharged laser, so the items are
    // now live.
    //
    // Weighted below their ballistic counterparts because they cost a resource
    // that also buys shields: a laser found without charge is worth less than a
    // pistol found with ammo, and the weights should say so.
    //
    // `max_stack` is 1 because the stack is the weapon itself: ammo is charge.
    ItemDef {
        id: LASER_PISTOL,
        key: "laser_pistol",
        name: "Laser Pistol",
        kind: ItemKind::Weapon(WEAPON_LASER_PISTOL),
        max_stack: 1,
        sprite: "weapon_laser_pistol",
        spawn_weight: 10,
        crate_weight: 14,
        buried_weight: 12,
    },
    ItemDef {
        id: LASER_SMG,
        key: "laser_smg",
        name: "Laser SMG",
        kind: ItemKind::Weapon(WEAPON_LASER_SMG),
        max_stack: 1,
        sprite: "weapon_laser_smg",
        spawn_weight: 8,
        crate_weight: 10,
        buried_weight: 8,
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
        spawn_weight: 8,
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
    // **Retired (§F5): knife, bat, whip, axe and hammer.**
    //
    // All three weights are zero, so no map places them, no crate holds them and
    // nothing digs them up — they are unobtainable. They are **not deleted**,
    // because `ITEMS` is indexed by id (`registry::def` is `ITEMS.get(id as
    // usize)`) and `WEAPONS[i].id == WeaponId(i)`: removing five entries
    // renumbers every id above them, which is §B16 — the bug where a laser
    // resolved as a bazooka. The task anticipated this ("if the table cannot hold
    // holes then keep an explicit retired placeholder — the pinned test
    // decides"), and the pinned tests decide for placeholders.
    //
    // Their constants and art therefore stay too: a placeholder that still
    // resolves needs stats and a sprite. Retirement here means **unobtainable**,
    // not absent.
    //
    // Melee (§B7). **No ammo** — `max_stack` is 1 and it is never spent, because
    // a weapon with a cooldown and no magazine is the floor of the arsenal: it is
    // what you still have when you have nothing, and it must never be worthless.
    //
    // Weighted high on the ground and low in crates: finding a knife should be
    // common and unexciting, while a crate should hold something you crossed the
    // map for.
    ItemDef {
        id: KNIFE,
        key: "knife",
        name: "Knife",
        kind: ItemKind::Weapon(WEAPON_KNIFE),
        max_stack: 1,
        sprite: "weapon_knife",
        spawn_weight: 0,
        crate_weight: 0,
        buried_weight: 0,
    },
    ItemDef {
        id: BAT,
        key: "bat",
        name: "Baseball Bat",
        kind: ItemKind::Weapon(WEAPON_BAT),
        max_stack: 1,
        sprite: "weapon_bat",
        spawn_weight: 0,
        crate_weight: 0,
        buried_weight: 0,
    },
    ItemDef {
        id: WHIP,
        key: "whip",
        name: "Whip",
        kind: ItemKind::Weapon(WEAPON_WHIP),
        max_stack: 1,
        sprite: "weapon_whip",
        spawn_weight: 0,
        crate_weight: 0,
        buried_weight: 0,
    },
    ItemDef {
        id: AXE,
        key: "axe",
        name: "Axe",
        kind: ItemKind::Weapon(WEAPON_AXE),
        max_stack: 1,
        sprite: "weapon_axe",
        // Digs 10 px a swing, so it is a tunnelling tool as well as a weapon —
        // which is why it is worth burying.
        spawn_weight: 0,
        crate_weight: 0,
        buried_weight: 0,
    },
    ItemDef {
        id: HAMMER,
        key: "hammer",
        name: "Sledgehammer",
        kind: ItemKind::Weapon(WEAPON_HAMMER),
        max_stack: 1,
        sprite: "weapon_hammer",
        spawn_weight: 0,
        crate_weight: 0,
        buried_weight: 0,
    },
    // Area denial (§B7). Rare on the ground and likelier in a crate: burning
    // ground shapes where people can walk for seconds afterwards, which is worth
    // contesting a crate for.
    ItemDef {
        id: FLAMETHROWER,
        key: "flamethrower",
        name: "Flamethrower",
        kind: ItemKind::Weapon(WEAPON_FLAMETHROWER),
        max_stack: FLAMETHROWER_AMMO,
        sprite: "weapon_flamethrower",
        spawn_weight: 8,
        crate_weight: 12,
        buried_weight: 6,
    },
    // A trap, not a spray (§B7). Two per pickup, and it must be *visible* at
    // close range — invisible instant death is not fun; a trap you could have
    // spotted is.
    ItemDef {
        id: MINE,
        key: "mine",
        name: "Proximity Mine",
        kind: ItemKind::Weapon(WEAPON_MINE),
        max_stack: MINE_AMMO,
        sprite: "weapon_mine",
        spawn_weight: 8,
        crate_weight: 10,
        buried_weight: 6,
    },
    // Thrown ordnance (§B7). Three of the four do no terrain damage at all —
    // they deny space rather than reshaping the map, which is what makes them
    // different from the grenade rather than variants of it.
    ItemDef {
        id: AIRBURST,
        key: "airburst",
        name: "Airburst Grenade",
        kind: ItemKind::Weapon(WEAPON_AIRBURST),
        max_stack: AIRBURST_AMMO,
        sprite: "weapon_airburst",
        spawn_weight: 8,
        crate_weight: 11,
        buried_weight: 7,
    },
    ItemDef {
        id: SMOKE,
        key: "smoke",
        name: "Smoke Grenade",
        kind: ItemKind::Weapon(WEAPON_SMOKE),
        max_stack: SMOKE_AMMO,
        sprite: "weapon_smoke",
        spawn_weight: 9,
        crate_weight: 9,
        buried_weight: 7,
    },
    ItemDef {
        id: MOLOTOV,
        key: "molotov",
        name: "Molotov",
        kind: ItemKind::Weapon(WEAPON_MOLOTOV),
        max_stack: MOLOTOV_AMMO,
        sprite: "weapon_molotov",
        spawn_weight: 9,
        crate_weight: 10,
        buried_weight: 7,
    },
    ItemDef {
        id: TOXIC_GRENADE,
        key: "toxic_grenade",
        name: "Toxic Grenade",
        kind: ItemKind::Weapon(WEAPON_TOXIC_GRENADE),
        max_stack: TOXIC_GRENADE_AMMO,
        sprite: "weapon_toxic",
        spawn_weight: 8,
        crate_weight: 10,
        buried_weight: 7,
    },
    // §F5. Appended at index 24; `registry::def` is `ITEMS.get(id as usize)`.
    //
    // **All three weights are zero and that is the point.** Everybody spawns
    // holding one, so a shovel on the ground would be litter — and the 200-seed
    // sweep asserts no map ever places it.
    ItemDef {
        id: SHOVEL,
        key: "shovel",
        name: "Shovel",
        kind: ItemKind::Weapon(WEAPON_SHOVEL),
        max_stack: 1,
        sprite: "weapon_shovel",
        spawn_weight: 0,
        crate_weight: 0,
        buried_weight: 0,
    },
    // T21.01. Rare, and rarer still in a crate: it is the strongest of the
    // passives against an aggressive player and it costs nothing to hold, so
    // finding one should be an event. Buried weight stays **below** the
    // flashlight's, which `the_flashlight_is_the_most_buried_item` protects
    // deliberately.
    ItemDef {
        id: VAMPIRE_FANGS,
        key: "vampire_fangs",
        name: "Vampire Fangs",
        kind: ItemKind::Utility(UtilityId::VampireFangs),
        // One pair is a pair. A stack of fangs would imply stacking lifesteal,
        // which the brief does not ask for and `steal_life` does not read.
        max_stack: 1,
        sprite: "item_vampire_fangs",
        spawn_weight: 6,
        crate_weight: 8,
        buried_weight: 10,
    },
    // T21.02. Weighted with the fangs: the effect items are meant to be found
    // occasionally, not carried every round.
    ItemDef {
        id: IRONMAN_BOOTS,
        key: "ironman_boots",
        name: "Ironman Boots",
        kind: ItemKind::Utility(UtilityId::IronmanBoots),
        max_stack: 1,
        sprite: "item_ironman_boots",
        spawn_weight: 6,
        crate_weight: 8,
        buried_weight: 10,
    },
    // T21.03. Rarer than the other two: constant flight with no fuel is the
    // strongest movement item in the game, and a round where several players
    // are airborne is a different game from the one the maps were built for.
    ItemDef {
        id: UNICORN_WINGS,
        key: "unicorn_wings",
        name: "Unicorn Wings",
        kind: ItemKind::Utility(UtilityId::UnicornWings),
        max_stack: 1,
        sprite: "item_unicorn_wings",
        spawn_weight: 3,
        crate_weight: 5,
        buried_weight: 6,
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

/// Is this item a weapon?
///
/// §C24 makes weapons the one item class that occupies **one slot, ever**: a
/// pickup of a weapon already held refills it rather than opening a second
/// stack. Consumables are counters and keep the generic merge rule of
/// `docs/30` §2, so the two need telling apart at the one place that decides —
/// `Inventory::add`.
pub fn is_weapon(id: ItemId) -> bool {
    matches!(def(id), Some(d) if matches!(d.kind, ItemKind::Weapon(_)))
}

/// Is this item **passive** — worn rather than wielded (T21.09)?
///
/// A passive item is one there is no verb for: `use_item` refuses it with
/// `WrongKind` and `try_fire_slot` refuses it too, so carrying it *is* using it.
/// That is exactly the class for which a backpack slot is as good as a quick-bar
/// slot, and it is why `Inventory::add` can prefer the backpack for these
/// without taking anything away from the player.
///
/// **Derived from the kind, with no list** (T21.09): a roster of "effect items"
/// would go stale the first time somebody adds a sixth, and the three M21 items
/// are `Utility` precisely so they need no entry anywhere. The match is
/// exhaustive on purpose — a new `ItemKind` will not compile until someone says
/// which side of this it falls on.
pub fn is_passive(id: ItemId) -> bool {
    let Some(d) = def(id) else { return false };
    match d.kind {
        // Held, never used: the shield generator (T20.08) and every utility
        // (T20.07, T21.01-03).
        ItemKind::Shield | ItemKind::Utility(_) => true,
        // All three have a verb — fire, use, use — so all three want the bar.
        ItemKind::Weapon(_) | ItemKind::Heal { .. } | ItemKind::Battery { .. } => false,
    }
}

/// A weapon nobody can find and nobody is issued: a placeholder kept only
/// because `ITEMS` is indexed by id and deleting an entry renumbers every id
/// above it (§B16, the bug where a laser resolved as a bazooka).
///
/// **Zero weights alone are not enough**, and that is the whole reason this is a
/// function. §F5's shovel also has three zero columns — it is issued at spawn
/// instead of spawning on the ground — so "no weights" names six weapons and
/// only five of them are retired. Anything handing out "every weapon" (§F7's
/// `all` kit) has to skip the placeholders and keep the shovel, and a second
/// copy of that rule is a second place to get it wrong.
pub fn is_retired(d: &ItemDef) -> bool {
    matches!(d.kind, ItemKind::Weapon(_))
        && d.spawn_weight == 0
        && d.crate_weight == 0
        && d.buried_weight == 0
        && !crate::player::state::STARTING_KIT.contains(&d.id)
}

/// The item that grants a given passive utility, if any (T21.02).
///
/// Scanned out of `ITEMS` by **kind**, so it needs no second list and stays
/// right the day two items grant the same utility (it answers with the first,
/// which is the one the wire will round-trip). The only caller is the client
/// mirror's `set_move_mod_bits`, which has to turn a wire bit back into the
/// inventory the shared rule reads.
pub fn item_for_utility(u: UtilityId) -> Option<ItemId> {
    ITEMS
        .iter()
        .find(|d| d.kind == ItemKind::Utility(u))
        .map(|d| d.id)
}

/// Every weapon a player can legitimately end up holding, retired placeholders
/// excluded. The order is `ITEMS` order, which is id order (§B16).
pub fn live_weapons() -> Vec<&'static ItemDef> {
    ITEMS
        .iter()
        .filter(|d| matches!(d.kind, ItemKind::Weapon(_)) && !is_retired(d))
        .collect()
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
            Some(ItemKind::Shield) => {}
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
                // What a weapon spends, in one rule that cannot disagree with
                // the game.
                //
                // This invariant has now been restated twice, because each new
                // delivery kind added a way to pay for a shot:
                //   - ballistic — a **stack** you spend, so `max_stack > 1`;
                //   - energy    — a **battery** (§B5), so the stack *is* the
                //                 weapon and `max_stack == 1`;
                //   - melee     — **nothing but time** (§B7), no ammo at all.
                //
                // The original was `max_stack > 1`, which passed a weapon with
                // neither. Rather than grow a third special case here, this asks
                // `WeaponDef::spends_stack()` — the same predicate `try_fire`
                // uses to decide whether to consume — so the registry's idea of
                // ammo and the sim's cannot drift apart.
                ItemKind::Weapon(wid) => {
                    let w = crate::weapons::defs::def(wid);
                    let spends_stack = w.is_none_or(|w| w.spends_stack());
                    if spends_stack {
                        assert!(
                            d.max_stack > 1,
                            "{} spends a stack per shot but carries only one",
                            d.key
                        );
                    } else {
                        assert_eq!(
                            d.max_stack, 1,
                            "{} does not spend a stack, so its stack is the weapon itself",
                            d.key
                        );
                    }
                }
                _ => assert!(d.max_stack <= 3),
            }
        }
    }
}
