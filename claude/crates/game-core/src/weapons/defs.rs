//! The v1 arsenal: three weapons, three roles.
//!
//! A direct arcing hit, indirect area denial, and sustained chip damage that also
//! tunnels. `Delivery` is the extension seam — clustering, homing, airstrikes and
//! drills all become new variants without changing the firing code's shape
//! (`docs/31-weapons-combat.md` §1, §8).

use crate::constants::{
    BAZOOKA_AMMO, BAZOOKA_BLAST_RADIUS, BAZOOKA_COOLDOWN, BAZOOKA_DAMAGE, BAZOOKA_GRAVITY_SCALE,
    BAZOOKA_MUZZLE_SPEED, BAZOOKA_WIND_SCALE, GRENADE_AMMO, GRENADE_BLAST_RADIUS, GRENADE_COOLDOWN,
    GRENADE_DAMAGE, GRENADE_FRICTION, GRENADE_FUSE, GRENADE_GRAVITY_SCALE, GRENADE_MUZZLE_SPEED,
    GRENADE_RESTITUTION, GRENADE_WIND_SCALE, SMG_AMMO, SMG_BLAST_RADIUS, SMG_COOLDOWN, SMG_DAMAGE,
    SMG_GRAVITY_SCALE, SMG_RANGE, SMG_SHOTS, SMG_SPREAD, SMG_WIND_SCALE,
};
use crate::constants::{
    LASER_PISTOL_BLAST_RADIUS, LASER_PISTOL_COOLDOWN, LASER_PISTOL_DAMAGE, LASER_PISTOL_ENERGY,
    LASER_PISTOL_RANGE, LASER_PISTOL_SPREAD, LASER_SMG_BLAST_RADIUS, LASER_SMG_COOLDOWN,
    LASER_SMG_DAMAGE, LASER_SMG_ENERGY, LASER_SMG_RANGE, LASER_SMG_SPREAD,
};
use crate::constants::{
    METEOR_CARVE_R, METEOR_DAMAGE, METEOR_FRAG_CARVE_R, METEOR_FRAG_DAMAGE, METEOR_SPEED,
};
use crate::items::registry::{
    WeaponId, WEAPON_BAZOOKA, WEAPON_GRENADE, WEAPON_LASER_PISTOL, WEAPON_LASER_SMG, WEAPON_METEOR,
    WEAPON_METEOR_FRAG, WEAPON_SMG,
};

#[derive(Copy, Clone, Debug, PartialEq)]
pub enum Delivery {
    Projectile {
        fuse: Option<f32>,
        restitution: f32,
        friction: f32,
        explode_on_contact: bool,
    },
    Hitscan {
        shots: u8,
        spread: f32,
    },
    /// An arc swept around the aim angle (§B6). No ammo — a cooldown instead,
    /// which is what makes melee the floor of the arsenal rather than a novelty.
    Melee {
        reach: f32,
        arc: f32,
        knockback: f32,
    },
    /// A sustained cone that damages per tick and leaves burning ground (§B6).
    /// It carves nothing: fire does not dig, and that is what stops it being
    /// strictly better than everything it competes with.
    Cone {
        range: f32,
        arc: f32,
        dps: f32,
        particle_life: f32,
    },
    /// Placed, armed, then triggered by proximity (§B6). Destructible by
    /// explosions, which is what stops a map filling up with them.
    Placed {
        arm_time: f32,
        trigger_radius: f32,
        lifetime: f32,
    },
}

#[derive(Debug)]
pub struct WeaponDef {
    /// Stable — it goes on the wire in `projectile_spawn`.
    pub id: WeaponId,
    pub key: &'static str,
    pub delivery: Delivery,
    pub damage: f32,
    /// Also the carve radius: nothing in this game hits a wall without marking it.
    pub blast_radius: f32,
    /// Hitscan only; projectiles use `PROJECTILE_MAX_LIFETIME`.
    pub range: f32,
    pub cooldown: f32,
    pub muzzle_speed: f32,
    pub gravity_scale: f32,
    pub wind_scale: f32,
    /// Battery spent per shot (§B5). **Zero means ballistic.**
    ///
    /// One field drives three behaviours, which is why it is a cost rather than
    /// an `is_energy` flag: it is the ammo an energy weapon spends, the check
    /// `try_fire` makes instead of a stack count, and the thing that makes a hit
    /// pierce a shield. Three separate flags could disagree; a cost cannot.
    pub energy_cost: f32,
}

impl WeaponDef {
    /// Energy weapons pierce shields and drain the victim's battery (§B5).
    pub fn is_energy(&self) -> bool {
        self.energy_cost > 0.0
    }
}

pub static WEAPONS: &[WeaponDef] = &[
    WeaponDef {
        id: WEAPON_BAZOOKA,
        key: "bazooka",
        delivery: Delivery::Projectile {
            fuse: None,
            restitution: 0.0,
            friction: 0.0,
            explode_on_contact: true,
        },
        damage: BAZOOKA_DAMAGE,
        blast_radius: BAZOOKA_BLAST_RADIUS,
        range: 0.0,
        cooldown: BAZOOKA_COOLDOWN,
        muzzle_speed: BAZOOKA_MUZZLE_SPEED,
        gravity_scale: BAZOOKA_GRAVITY_SCALE,
        wind_scale: BAZOOKA_WIND_SCALE,
        energy_cost: 0.0,
    },
    WeaponDef {
        id: WEAPON_GRENADE,
        key: "grenade",
        delivery: Delivery::Projectile {
            fuse: Some(GRENADE_FUSE),
            restitution: GRENADE_RESTITUTION,
            friction: GRENADE_FRICTION,
            explode_on_contact: false,
        },
        damage: GRENADE_DAMAGE,
        blast_radius: GRENADE_BLAST_RADIUS,
        range: 0.0,
        cooldown: GRENADE_COOLDOWN,
        muzzle_speed: GRENADE_MUZZLE_SPEED,
        gravity_scale: GRENADE_GRAVITY_SCALE,
        wind_scale: GRENADE_WIND_SCALE,
        energy_cost: 0.0,
    },
    WeaponDef {
        id: WEAPON_SMG,
        key: "smg",
        delivery: Delivery::Hitscan {
            shots: SMG_SHOTS,
            spread: SMG_SPREAD,
        },
        damage: SMG_DAMAGE,
        blast_radius: SMG_BLAST_RADIUS,
        range: SMG_RANGE,
        cooldown: SMG_COOLDOWN,
        muzzle_speed: 0.0,
        gravity_scale: SMG_GRAVITY_SCALE,
        wind_scale: SMG_WIND_SCALE,
        energy_cost: 0.0,
    },
    // --- weather ordnance (M5) ---
    //
    // Ordinary projectiles in every respect: they fall under gravity and step
    // against the mask through the same code a rocket does. `explode_on_contact`
    // with no fuse, and wind_scale 0 — a meteor is heavy enough not to drift.
    WeaponDef {
        id: WEAPON_METEOR,
        key: "meteor",
        delivery: Delivery::Projectile {
            fuse: None,
            restitution: 0.0,
            friction: 0.0,
            explode_on_contact: true,
        },
        damage: METEOR_DAMAGE,
        blast_radius: METEOR_CARVE_R,
        range: 0.0,
        cooldown: 0.0,
        muzzle_speed: METEOR_SPEED,
        gravity_scale: 1.0,
        wind_scale: 0.0,
        energy_cost: 0.0,
    },
    WeaponDef {
        id: WEAPON_METEOR_FRAG,
        key: "meteor_fragment",
        delivery: Delivery::Projectile {
            fuse: None,
            restitution: 0.0,
            friction: 0.0,
            explode_on_contact: true,
        },
        damage: METEOR_FRAG_DAMAGE,
        blast_radius: METEOR_FRAG_CARVE_R,
        range: 0.0,
        cooldown: 0.0,
        muzzle_speed: 0.0,
        gravity_scale: 1.0,
        wind_scale: 0.0,
        energy_cost: 0.0,
    },
    // Energy weapons (§B5). No ammo count: `energy_cost` is what they spend, and
    // a laser with no charge is a paperweight.
    WeaponDef {
        id: WEAPON_LASER_PISTOL,
        key: "laser_pistol",
        delivery: Delivery::Hitscan {
            shots: 1,
            spread: LASER_PISTOL_SPREAD,
        },
        damage: LASER_PISTOL_DAMAGE,
        blast_radius: LASER_PISTOL_BLAST_RADIUS,
        range: LASER_PISTOL_RANGE,
        cooldown: LASER_PISTOL_COOLDOWN,
        muzzle_speed: 0.0,
        gravity_scale: 0.0,
        wind_scale: 0.0,
        energy_cost: LASER_PISTOL_ENERGY,
    },
    WeaponDef {
        id: WEAPON_LASER_SMG,
        key: "laser_smg",
        delivery: Delivery::Hitscan {
            shots: 1,
            spread: LASER_SMG_SPREAD,
        },
        damage: LASER_SMG_DAMAGE,
        blast_radius: LASER_SMG_BLAST_RADIUS,
        range: LASER_SMG_RANGE,
        cooldown: LASER_SMG_COOLDOWN,
        muzzle_speed: 0.0,
        gravity_scale: 0.0,
        wind_scale: 0.0,
        energy_cost: LASER_SMG_ENERGY,
    },
];

/// Look a weapon up by id.
///
/// **This indexes by array position**, which silently assumes
/// `WEAPONS[i].id == WeaponId(i)`. Inserting a def anywhere but the end
/// therefore remaps every weapon after it — and the symptom is not a crash, it
/// is a laser resolving as a bazooka. `weapon_ids_match_their_positions` is what
/// makes that a red test rather than a mystery; it exists because inserting two
/// energy weapons at the front of this array is exactly what happened.
pub fn def(id: WeaponId) -> Option<&'static WeaponDef> {
    WEAPONS.get(id.0 as usize).filter(|w| w.id == id)
}

pub fn by_key(key: &str) -> Option<&'static WeaponDef> {
    WEAPONS.iter().find(|w| w.key == key)
}

/// Ammo per pickup, from the item registry — one source of truth, not two.
pub fn ammo_per_pickup(id: WeaponId) -> u8 {
    match id {
        WEAPON_BAZOOKA => BAZOOKA_AMMO,
        WEAPON_GRENADE => GRENADE_AMMO,
        WEAPON_SMG => SMG_AMMO,
        _ => 1,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::items::registry::{self, ItemKind};

    #[test]
    fn ids_are_their_own_index_and_keys_are_unique() {
        for (i, w) in WEAPONS.iter().enumerate() {
            assert_eq!(w.id.0 as usize, i, "{} is not at its own index", w.key);
        }
        let mut keys: Vec<&str> = WEAPONS.iter().map(|w| w.key).collect();
        keys.sort_unstable();
        keys.dedup();
        assert_eq!(keys.len(), WEAPONS.len());
        assert!(def(WeaponId(99)).is_none());
        assert_eq!(by_key("smg").map(|w| w.id), Some(WEAPON_SMG));
    }

    /// `def()` indexes by position, so the table's order *is* the id mapping.
    #[test]
    fn weapon_ids_match_their_positions() {
        for (i, w) in WEAPONS.iter().enumerate() {
            assert_eq!(
                w.id,
                WeaponId(i as u16),
                "{} sits at position {i} but claims id {:?} — every lookup after \
                 it resolves to the wrong weapon",
                w.key,
                w.id
            );
        }
    }

    #[test]
    fn every_weapon_digs() {
        // §A3: nothing in this game hits a wall without marking it.
        for w in WEAPONS {
            assert!(w.blast_radius > 0.0, "{} does not carve", w.key);
        }
    }

    #[test]
    fn the_three_roles_are_distinct() {
        let bazooka = by_key("bazooka").expect("bazooka");
        let grenade = by_key("grenade").expect("grenade");
        let smg = by_key("smg").expect("smg");

        // Direct: explodes on contact, no fuse, no bounce.
        match bazooka.delivery {
            Delivery::Projectile {
                fuse,
                explode_on_contact,
                ..
            } => {
                assert!(explode_on_contact);
                assert_eq!(fuse, None);
            }
            _ => panic!("the bazooka must be a projectile"),
        }
        // Indirect: bounces, fuses in mid-air if it never touches anything.
        match grenade.delivery {
            Delivery::Projectile {
                fuse,
                restitution,
                explode_on_contact,
                ..
            } => {
                assert!(!explode_on_contact);
                assert_eq!(fuse, Some(GRENADE_FUSE));
                assert!(restitution > 0.0);
            }
            _ => panic!("the grenade must be a projectile"),
        }
        // Chip damage that tunnels: cheap per shot, fast, small carve.
        match smg.delivery {
            Delivery::Hitscan { shots, spread } => {
                assert_eq!(shots, SMG_SHOTS);
                assert!(spread > 0.0);
            }
            _ => panic!("the smg must be hitscan"),
        }
        assert!(smg.damage < bazooka.damage / 4.0);
        assert!(smg.cooldown < bazooka.cooldown / 4.0);
        assert!(smg.range > 0.0, "hitscan needs a range");
    }

    #[test]
    fn the_registry_and_the_weapon_table_agree_on_ammo() {
        // Two tables, one truth: a bazooka pickup must give exactly BAZOOKA_AMMO.
        for d in registry::ITEMS {
            if let ItemKind::Weapon(wid) = d.kind {
                assert!(def(wid).is_some(), "{} points at a missing weapon", d.key);
                assert_eq!(
                    d.max_stack,
                    ammo_per_pickup(wid),
                    "{} disagrees with the weapon table on ammo",
                    d.key
                );
            }
        }
    }

    #[test]
    fn values_track_the_constants() {
        let b = by_key("bazooka").expect("bazooka");
        assert_eq!(b.damage, BAZOOKA_DAMAGE);
        assert_eq!(b.blast_radius, BAZOOKA_BLAST_RADIUS);
        assert_eq!(b.muzzle_speed, BAZOOKA_MUZZLE_SPEED);
        let s = by_key("smg").expect("smg");
        assert_eq!(s.damage, SMG_DAMAGE);
        assert_eq!(s.range, SMG_RANGE);
        assert_eq!(s.gravity_scale, 0.0, "hitscan is not ballistic");
    }
}
