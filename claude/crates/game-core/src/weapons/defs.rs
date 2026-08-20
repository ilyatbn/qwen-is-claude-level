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
    METEOR_CARVE_R, METEOR_DAMAGE, METEOR_FRAG_CARVE_R, METEOR_FRAG_DAMAGE, METEOR_SPEED,
};
use crate::items::registry::{
    WeaponId, WEAPON_BAZOOKA, WEAPON_GRENADE, WEAPON_METEOR, WEAPON_METEOR_FRAG, WEAPON_SMG,
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
    },
];

pub fn def(id: WeaponId) -> Option<&'static WeaponDef> {
    WEAPONS.get(id.0 as usize)
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
