//! The v1 arsenal: three weapons, three roles.
//!
//! A direct arcing hit, indirect area denial, and sustained chip damage that also
//! tunnels. `Delivery` is the extension seam — clustering, homing, airstrikes and
//! drills all become new variants without changing the firing code's shape
//! (`docs/31-weapons-combat.md` §1, §8).

use crate::constants::{AIRBURST_AMMO, MOLOTOV_AMMO, SMOKE_AMMO, TOXIC_GRENADE_AMMO};
use crate::constants::{
    AIRBURST_FAN, AIRBURST_FUSE, AIRBURST_MUZZLE_SPEED, AIRBURST_PELLETS, AIRBURST_PELLET_CARVE,
    AIRBURST_PELLET_DAMAGE, AIRBURST_PELLET_ENERGY, AIRBURST_PELLET_RANGE, LAVA_BURN_DPS,
    LAVA_BURN_RADIUS, MOLOTOV_BURN_DURATION, MOLOTOV_MUZZLE_SPEED, MOLOTOV_PATCHES,
    MOLOTOV_SCATTER, SMOKE_DURATION, SMOKE_FUSE, SMOKE_MUZZLE_SPEED, SMOKE_RADIUS, TOXIC_DPS,
    TOXIC_GRENADE_DURATION, TOXIC_GRENADE_FUSE, TOXIC_GRENADE_MUZZLE_SPEED, TOXIC_GRENADE_RADIUS,
};
use crate::constants::{
    AXE_ARC, AXE_CARVE, AXE_COOLDOWN, AXE_DAMAGE, AXE_KNOCKBACK, AXE_REACH, BAT_ARC, BAT_CARVE,
    BAT_COOLDOWN, BAT_DAMAGE, BAT_KNOCKBACK, BAT_REACH, HAMMER_ARC, HAMMER_CARVE, HAMMER_COOLDOWN,
    HAMMER_DAMAGE, HAMMER_KNOCKBACK, HAMMER_REACH, KNIFE_ARC, KNIFE_CARVE, KNIFE_COOLDOWN,
    KNIFE_DAMAGE, KNIFE_KNOCKBACK, KNIFE_REACH, WHIP_ARC, WHIP_CARVE, WHIP_COOLDOWN, WHIP_DAMAGE,
    WHIP_KNOCKBACK, WHIP_REACH,
};
use crate::constants::{
    BAZOOKA_AMMO, BAZOOKA_BLAST_RADIUS, BAZOOKA_COOLDOWN, BAZOOKA_DAMAGE, BAZOOKA_GRAVITY_SCALE,
    BAZOOKA_MUZZLE_SPEED, BAZOOKA_WIND_SCALE, GRENADE_AMMO, GRENADE_BLAST_RADIUS, GRENADE_COOLDOWN,
    GRENADE_DAMAGE, GRENADE_FRICTION, GRENADE_FUSE, GRENADE_GRAVITY_SCALE, GRENADE_MUZZLE_SPEED,
    GRENADE_RESTITUTION, GRENADE_WIND_SCALE, SMG_AMMO, SMG_BLAST_RADIUS, SMG_COOLDOWN, SMG_DAMAGE,
    SMG_GRAVITY_SCALE, SMG_RANGE, SMG_SHOTS, SMG_SPREAD, SMG_WIND_SCALE,
};
use crate::constants::{
    DEAGLE_AMMO, DEAGLE_BLAST_RADIUS, DEAGLE_COOLDOWN, DEAGLE_DAMAGE, DEAGLE_RANGE, DEAGLE_SPREAD,
    MACHINEGUN_AMMO, MACHINEGUN_BLAST_RADIUS, MACHINEGUN_COOLDOWN, MACHINEGUN_DAMAGE,
    MACHINEGUN_RANGE, MACHINEGUN_SPREAD, PISTOL_AMMO, PISTOL_BLAST_RADIUS, PISTOL_COOLDOWN,
    PISTOL_DAMAGE, PISTOL_RANGE, PISTOL_SPREAD, REVOLVER_AMMO, REVOLVER_BLAST_RADIUS,
    REVOLVER_COOLDOWN, REVOLVER_DAMAGE, REVOLVER_RANGE, REVOLVER_SPREAD,
};
use crate::constants::{
    FLAMETHROWER_AMMO, FLAMETHROWER_ARC, FLAMETHROWER_COOLDOWN, FLAMETHROWER_DPS,
    FLAMETHROWER_PARTICLE_LIFE, FLAMETHROWER_RANGE,
};
use crate::constants::{
    LASER_PISTOL_BLAST_RADIUS, LASER_PISTOL_COOLDOWN, LASER_PISTOL_DAMAGE, LASER_PISTOL_ENERGY,
    LASER_PISTOL_RANGE, LASER_PISTOL_SPREAD, LASER_SMG_BLAST_RADIUS, LASER_SMG_COOLDOWN,
    LASER_SMG_DAMAGE, LASER_SMG_ENERGY, LASER_SMG_RANGE, LASER_SMG_SPREAD,
};
use crate::constants::{
    METEOR_CARVE_R, METEOR_DAMAGE, METEOR_FRAG_CARVE_R, METEOR_FRAG_DAMAGE, METEOR_SPEED,
};
use crate::constants::{
    MINE_AMMO, MINE_ARM_TIME, MINE_BLAST_RADIUS, MINE_DAMAGE, MINE_LIFETIME, MINE_TRIGGER_RADIUS,
};
use crate::items::registry::{
    WeaponId, WEAPON_AIRBURST, WEAPON_AIRBURST_PELLET, WEAPON_AXE, WEAPON_BAT, WEAPON_BAZOOKA,
    WEAPON_DEAGLE, WEAPON_FLAMETHROWER, WEAPON_GRENADE, WEAPON_HAMMER, WEAPON_KNIFE,
    WEAPON_LASER_PISTOL, WEAPON_LASER_SMG, WEAPON_MACHINEGUN, WEAPON_METEOR, WEAPON_METEOR_FRAG,
    WEAPON_MINE, WEAPON_MOLOTOV, WEAPON_PISTOL, WEAPON_REVOLVER, WEAPON_SMG, WEAPON_SMOKE,
    WEAPON_TOXIC_GRENADE, WEAPON_WHIP,
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

/// What a projectile *does* when it stops (§B7).
///
/// The four thrown weapons in §B7 all fly identically — the same gravity, the
/// same sub-stepped terrain collision, the same fuse — and differ only in what
/// happens at the end. Encoding that as a field rather than four `Delivery`
/// variants keeps one flight path: a smoke grenade that fell differently from a
/// molotov would be a second projectile simulation to keep in step.
///
/// **`Blast` is not a default anyone can forget.** Every existing weapon names
/// it, and `detonate` matches exhaustively, so a new burst kind is a compile
/// error at the one place that decides what going off means.
#[derive(Copy, Clone, Debug, PartialEq)]
pub enum Burst {
    /// Carve and damage in a radius — bazooka, grenade, mine, meteor.
    Blast,
    /// Fire `count` hitscan rays in a downward fan (§B7). The pellets are energy,
    /// so they pierce shields; the grenade was the ammo, so they cost no battery.
    Pellets {
        count: u32,
        fan: f32,
        pellet: WeaponId,
    },
    /// Leave a damaging ground zone and **touch no terrain**. `patches` scatter
    /// around the impact so a molotov denies an area rather than a point.
    Zone {
        kind: BurnZone,
        radius: f32,
        dps: f32,
        duration: f32,
        patches: u32,
        scatter: f32,
    },
    /// A cloud that blocks vision and does nothing else — the only weapon in the
    /// game with no damage at all.
    Smoke { radius: f32, duration: f32 },
}

/// Mirrors `burn::BurnKind` without `weapons::defs` depending on the burn field's
/// internals; `detonate` maps one to the other.
#[derive(Copy, Clone, Debug, PartialEq, Eq)]
pub enum BurnZone {
    Fire,
    Toxic,
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
    /// What happens when this weapon's projectile stops (§B7).
    pub burst: Burst,
}

impl WeaponDef {
    /// Energy weapons pierce shields and drain the victim's battery (§B5).
    pub fn is_energy(&self) -> bool {
        self.energy_cost > 0.0
    }

    /// Does firing spend a count from the inventory stack?
    ///
    /// Three kinds of ammo, one question. A ballistic weapon spends a round; an
    /// energy weapon spends **battery** (§B5), so its stack *is* the weapon; and
    /// melee spends nothing but time (§B7) — no ammo is the whole reason melee is
    /// the floor of the arsenal rather than a novelty.
    ///
    /// Derived rather than stored, for the reason `energy_cost` is a cost rather
    /// than an `is_energy` flag: a separate `consumes_ammo` field could disagree
    /// with the delivery kind, and this cannot. Without it a knife deleted itself
    /// on its first swing — `max_stack: 1`, consumed, gone.
    pub fn spends_stack(&self) -> bool {
        !self.is_energy() && !matches!(self.delivery, Delivery::Melee { .. })
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
        burst: Burst::Blast,
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
        burst: Burst::Blast,
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
        burst: Burst::Blast,
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
        burst: Burst::Blast,
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
        burst: Burst::Blast,
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
        burst: Burst::Blast,
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
        burst: Burst::Blast,
    },
    // --- ballistic hitscan (§B7) ---
    //
    // Appended, never inserted: `def` indexes by array position, and putting a
    // new id in the middle remaps every weapon after it — a laser resolving as a
    // bazooka, with no symptom that looks like an ordering bug (§B16).
    WeaponDef {
        id: WEAPON_PISTOL,
        key: "pistol",
        delivery: Delivery::Hitscan {
            shots: 1,
            spread: PISTOL_SPREAD,
        },
        damage: PISTOL_DAMAGE,
        blast_radius: PISTOL_BLAST_RADIUS,
        range: PISTOL_RANGE,
        cooldown: PISTOL_COOLDOWN,
        muzzle_speed: 0.0,
        gravity_scale: 0.0,
        wind_scale: 0.0,
        energy_cost: 0.0,
        burst: Burst::Blast,
    },
    WeaponDef {
        id: WEAPON_REVOLVER,
        key: "revolver",
        delivery: Delivery::Hitscan {
            shots: 1,
            spread: REVOLVER_SPREAD,
        },
        damage: REVOLVER_DAMAGE,
        blast_radius: REVOLVER_BLAST_RADIUS,
        range: REVOLVER_RANGE,
        cooldown: REVOLVER_COOLDOWN,
        muzzle_speed: 0.0,
        gravity_scale: 0.0,
        wind_scale: 0.0,
        energy_cost: 0.0,
        burst: Burst::Blast,
    },
    WeaponDef {
        id: WEAPON_DEAGLE,
        key: "deagle",
        delivery: Delivery::Hitscan {
            shots: 1,
            spread: DEAGLE_SPREAD,
        },
        damage: DEAGLE_DAMAGE,
        blast_radius: DEAGLE_BLAST_RADIUS,
        range: DEAGLE_RANGE,
        cooldown: DEAGLE_COOLDOWN,
        muzzle_speed: 0.0,
        gravity_scale: 0.0,
        wind_scale: 0.0,
        energy_cost: 0.0,
        burst: Burst::Blast,
    },
    WeaponDef {
        id: WEAPON_MACHINEGUN,
        key: "machinegun",
        delivery: Delivery::Hitscan {
            shots: 1,
            spread: MACHINEGUN_SPREAD,
        },
        damage: MACHINEGUN_DAMAGE,
        blast_radius: MACHINEGUN_BLAST_RADIUS,
        range: MACHINEGUN_RANGE,
        cooldown: MACHINEGUN_COOLDOWN,
        muzzle_speed: 0.0,
        gravity_scale: 0.0,
        wind_scale: 0.0,
        energy_cost: 0.0,
        burst: Burst::Blast,
    },
    // --- melee (§B7) ---
    //
    // No ammo, cooldown only. `blast_radius` is the carve, so an axe and a
    // hammer dig and a knife does not — the same field, doing the same job it
    // does for a rocket.
    WeaponDef {
        id: WEAPON_KNIFE,
        key: "knife",
        delivery: Delivery::Melee {
            reach: KNIFE_REACH,
            arc: KNIFE_ARC,
            knockback: KNIFE_KNOCKBACK,
        },
        damage: KNIFE_DAMAGE,
        blast_radius: KNIFE_CARVE,
        range: 0.0,
        cooldown: KNIFE_COOLDOWN,
        muzzle_speed: 0.0,
        gravity_scale: 0.0,
        wind_scale: 0.0,
        energy_cost: 0.0,
        burst: Burst::Blast,
    },
    WeaponDef {
        id: WEAPON_BAT,
        key: "bat",
        delivery: Delivery::Melee {
            reach: BAT_REACH,
            arc: BAT_ARC,
            knockback: BAT_KNOCKBACK,
        },
        damage: BAT_DAMAGE,
        blast_radius: BAT_CARVE,
        range: 0.0,
        cooldown: BAT_COOLDOWN,
        muzzle_speed: 0.0,
        gravity_scale: 0.0,
        wind_scale: 0.0,
        energy_cost: 0.0,
        burst: Burst::Blast,
    },
    WeaponDef {
        id: WEAPON_WHIP,
        key: "whip",
        delivery: Delivery::Melee {
            reach: WHIP_REACH,
            arc: WHIP_ARC,
            knockback: WHIP_KNOCKBACK,
        },
        damage: WHIP_DAMAGE,
        blast_radius: WHIP_CARVE,
        range: 0.0,
        cooldown: WHIP_COOLDOWN,
        muzzle_speed: 0.0,
        gravity_scale: 0.0,
        wind_scale: 0.0,
        energy_cost: 0.0,
        burst: Burst::Blast,
    },
    WeaponDef {
        id: WEAPON_AXE,
        key: "axe",
        delivery: Delivery::Melee {
            reach: AXE_REACH,
            arc: AXE_ARC,
            knockback: AXE_KNOCKBACK,
        },
        damage: AXE_DAMAGE,
        blast_radius: AXE_CARVE,
        range: 0.0,
        cooldown: AXE_COOLDOWN,
        muzzle_speed: 0.0,
        gravity_scale: 0.0,
        wind_scale: 0.0,
        energy_cost: 0.0,
        burst: Burst::Blast,
    },
    WeaponDef {
        id: WEAPON_HAMMER,
        key: "hammer",
        delivery: Delivery::Melee {
            reach: HAMMER_REACH,
            arc: HAMMER_ARC,
            knockback: HAMMER_KNOCKBACK,
        },
        damage: HAMMER_DAMAGE,
        blast_radius: HAMMER_CARVE,
        range: 0.0,
        cooldown: HAMMER_COOLDOWN,
        muzzle_speed: 0.0,
        gravity_scale: 0.0,
        wind_scale: 0.0,
        energy_cost: 0.0,
        burst: Burst::Blast,
    },
    // --- cone (§B7) ---
    //
    // `blast_radius` is 0: fire does not dig (§B6), and that is what stops the
    // flamethrower being strictly better than what it competes with. `damage`
    // mirrors the dps so the shared field is meaningful; the cone reads its own.
    WeaponDef {
        id: WEAPON_FLAMETHROWER,
        key: "flamethrower",
        delivery: Delivery::Cone {
            range: FLAMETHROWER_RANGE,
            arc: FLAMETHROWER_ARC,
            dps: FLAMETHROWER_DPS,
            particle_life: FLAMETHROWER_PARTICLE_LIFE,
        },
        damage: FLAMETHROWER_DPS,
        blast_radius: 0.0,
        range: FLAMETHROWER_RANGE,
        cooldown: FLAMETHROWER_COOLDOWN,
        muzzle_speed: 0.0,
        gravity_scale: 0.0,
        wind_scale: 0.0,
        energy_cost: 0.0,
        burst: Burst::Blast,
    },
    // --- placed (§B7) ---
    WeaponDef {
        id: WEAPON_MINE,
        key: "mine",
        delivery: Delivery::Placed {
            arm_time: MINE_ARM_TIME,
            trigger_radius: MINE_TRIGGER_RADIUS,
            lifetime: MINE_LIFETIME,
        },
        damage: MINE_DAMAGE,
        blast_radius: MINE_BLAST_RADIUS,
        range: 0.0,
        cooldown: 0.5,
        muzzle_speed: 0.0,
        gravity_scale: 0.0,
        wind_scale: 0.0,
        energy_cost: 0.0,
        burst: Burst::Blast,
    },
    // --- thrown ordnance (§B7) ---
    //
    // Four grenades that are not the grenade. They share one flight path and
    // differ only in `burst`, which is the whole reason `Burst` is a field: a
    // smoke that fell differently from a molotov would be a second projectile
    // simulation to keep in step.
    //
    // Three of the four leave the terrain **byte-identical**. What they deny is
    // space, not rock — and `Burst::Zone`/`Burst::Smoke` never reach `explode`,
    // so that is structural rather than a radius someone has to remember to zero.
    WeaponDef {
        id: WEAPON_AIRBURST,
        key: "airburst",
        delivery: Delivery::Projectile {
            fuse: Some(AIRBURST_FUSE),
            restitution: 0.0,
            friction: 0.0,
            explode_on_contact: false,
        },
        damage: 0.0,
        blast_radius: 0.0,
        range: 0.0,
        cooldown: GRENADE_COOLDOWN,
        muzzle_speed: AIRBURST_MUZZLE_SPEED,
        gravity_scale: 1.0,
        wind_scale: 0.5,
        energy_cost: 0.0,
        burst: Burst::Pellets {
            count: AIRBURST_PELLETS,
            fan: AIRBURST_FAN,
            pellet: WEAPON_AIRBURST_PELLET,
        },
    },
    WeaponDef {
        id: WEAPON_SMOKE,
        key: "smoke",
        delivery: Delivery::Projectile {
            fuse: Some(SMOKE_FUSE),
            restitution: 0.35,
            friction: 0.8,
            explode_on_contact: false,
        },
        damage: 0.0,
        blast_radius: 0.0,
        range: 0.0,
        cooldown: GRENADE_COOLDOWN,
        muzzle_speed: SMOKE_MUZZLE_SPEED,
        gravity_scale: 1.0,
        wind_scale: 0.5,
        energy_cost: 0.0,
        burst: Burst::Smoke {
            radius: SMOKE_RADIUS,
            duration: SMOKE_DURATION,
        },
    },
    WeaponDef {
        id: WEAPON_MOLOTOV,
        key: "molotov",
        delivery: Delivery::Projectile {
            fuse: None,
            restitution: 0.0,
            friction: 0.0,
            explode_on_contact: true,
        },
        damage: 0.0,
        blast_radius: 0.0,
        range: 0.0,
        cooldown: GRENADE_COOLDOWN,
        muzzle_speed: MOLOTOV_MUZZLE_SPEED,
        gravity_scale: 1.0,
        wind_scale: 0.5,
        energy_cost: 0.0,
        burst: Burst::Zone {
            kind: BurnZone::Fire,
            radius: LAVA_BURN_RADIUS,
            dps: LAVA_BURN_DPS,
            duration: MOLOTOV_BURN_DURATION,
            patches: MOLOTOV_PATCHES,
            scatter: MOLOTOV_SCATTER,
        },
    },
    WeaponDef {
        id: WEAPON_TOXIC_GRENADE,
        key: "toxic_grenade",
        delivery: Delivery::Projectile {
            fuse: Some(TOXIC_GRENADE_FUSE),
            restitution: 0.4,
            friction: 0.75,
            explode_on_contact: false,
        },
        damage: 0.0,
        blast_radius: 0.0,
        range: 0.0,
        cooldown: GRENADE_COOLDOWN,
        muzzle_speed: TOXIC_GRENADE_MUZZLE_SPEED,
        gravity_scale: 1.0,
        wind_scale: 0.5,
        energy_cost: 0.0,
        burst: Burst::Zone {
            kind: BurnZone::Toxic,
            radius: TOXIC_GRENADE_RADIUS,
            dps: TOXIC_DPS,
            duration: TOXIC_GRENADE_DURATION,
            patches: 1,
            scatter: 0.0,
        },
    },
    // An airburst's pellet. Energy, so it pierces shields (§B5) — but its cost is
    // zero: the grenade was the ammo, and charging the thrower battery it never
    // asked for would make an airburst secretly cost two resources.
    WeaponDef {
        id: WEAPON_AIRBURST_PELLET,
        key: "airburst_pellet",
        delivery: Delivery::Hitscan {
            shots: 1,
            spread: 0.0,
        },
        damage: AIRBURST_PELLET_DAMAGE,
        blast_radius: AIRBURST_PELLET_CARVE,
        range: AIRBURST_PELLET_RANGE,
        cooldown: 0.0,
        muzzle_speed: 0.0,
        gravity_scale: 0.0,
        wind_scale: 0.0,
        energy_cost: AIRBURST_PELLET_ENERGY,
        burst: Burst::Blast,
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
        WEAPON_PISTOL => PISTOL_AMMO,
        WEAPON_REVOLVER => REVOLVER_AMMO,
        WEAPON_DEAGLE => DEAGLE_AMMO,
        WEAPON_MACHINEGUN => MACHINEGUN_AMMO,
        WEAPON_FLAMETHROWER => FLAMETHROWER_AMMO,
        WEAPON_MINE => MINE_AMMO,
        WEAPON_AIRBURST => AIRBURST_AMMO,
        WEAPON_SMOKE => SMOKE_AMMO,
        WEAPON_MOLOTOV => MOLOTOV_AMMO,
        WEAPON_TOXIC_GRENADE => TOXIC_GRENADE_AMMO,
        // Energy weapons and weather ordnance: the stack is the weapon, and
        // charge is the ammo (§B5).
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
        // §A3 restated for the delivery kinds §B6 added (see §B18).
        //
        // §A3's claim is about **ordnance**: nothing you *shoot* hits a wall
        // without marking it. Two kinds are exempt by design, and the exemptions
        // are listed by name here so a new weapon cannot silently join them:
        //
        //   - `Melee` — an axe and a hammer dig (that is what makes melee a
        //     tunnelling tool as well as a last resort), a knife and a bat do not.
        //   - `Cone`  — fire does not dig (§B6), which is what stops the
        //     flamethrower being strictly better than what it competes with.
        //
        // This is stricter than the rule it replaces, not looser: the old version
        // passed a weapon that carved and did no damage at all.
        const MAY_NOT_CARVE: &[&str] = &["knife", "bat", "whip"];
        for w in WEAPONS {
            // A weapon whose whole effect is what it *leaves behind* carries its
            // numbers on the burst, not on the def: a smoke grenade with damage
            // and a blast radius would be a grenade. So the rule is "every weapon
            // does something", and `Burst` says what — which is still stricter
            // than the original, because that one passed a weapon with neither
            // damage nor a carve.
            if !matches!(w.burst, Burst::Blast) {
                continue;
            }
            assert!(w.damage > 0.0, "{} does no damage at all", w.key);
            let exempt =
                matches!(w.delivery, Delivery::Cone { .. }) || MAY_NOT_CARVE.contains(&w.key);
            if !exempt {
                assert!(
                    w.blast_radius > 0.0,
                    "{} does not carve, and is not one of the named exemptions",
                    w.key
                );
            }
        }
        // The other half of the rule: a weapon that opted out above must have a
        // burst that actually does something. Without this, `Burst::Zone` with a
        // dps of zero and no patches would pass as "not a blast".
        for w in WEAPONS {
            match w.burst {
                Burst::Blast => {}
                Burst::Pellets { count, .. } => {
                    assert!(count > 0, "{} bursts into nothing", w.key)
                }
                Burst::Zone {
                    dps,
                    radius,
                    patches,
                    ..
                } => assert!(
                    dps > 0.0 && radius > 0.0 && patches > 0,
                    "{} leaves a zone that does nothing",
                    w.key
                ),
                Burst::Smoke { radius, duration } => assert!(
                    radius > 0.0 && duration > 0.0,
                    "{} makes a cloud that is not there",
                    w.key
                ),
            }
        }
        // The exemption list must not outlive its members: a name here that is
        // not a real weapon means someone renamed one and the exemption silently
        // widened to cover nothing.
        for key in MAY_NOT_CARVE {
            let w = by_key(key).unwrap_or_else(|| panic!("{key} is exempt but does not exist"));
            assert!(
                matches!(w.delivery, Delivery::Melee { .. }),
                "{key} is exempt from carving but is not melee"
            );
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

/// T11.03 — the ballistic hitscan arsenal (§B7).
///
/// Kept in its own module so `cargo test -p game-core --lib ballistics` names
/// exactly this work, and so the spec table below sits next to nothing else.
#[cfg(test)]
mod ballistics {
    use super::*;
    use crate::items::registry;
    use crate::map::gen::silhouette::force_borders;
    use crate::map::{CoarseGrid, Map, MapMeta, Mask};
    use crate::math::Vec2;
    use crate::rng::substream;
    use crate::weapons::explode::{fire_hitscan, HitscanHit, PlayerHitTarget};

    /// `docs/71-amendments-v3.md` §B7, transcribed. `(key, dmg, carve, range, cd, spread, ammo)`
    const SPEC: &[(&str, f32, f32, f32, f32, f32, u8)] = &[
        ("smg", 8.0, 3.0, 700.0, 0.10, 0.030, 60),
        ("pistol", 14.0, 3.0, 520.0, 0.28, 0.020, 40),
        ("revolver", 32.0, 5.0, 700.0, 0.70, 0.010, 12),
        ("deagle", 45.0, 6.0, 760.0, 0.85, 0.015, 8),
        ("machinegun", 11.0, 3.0, 900.0, 0.09, 0.045, 120),
    ];

    fn is_ballistic(w: &WeaponDef) -> bool {
        matches!(w.delivery, Delivery::Hitscan { .. }) && !w.is_energy()
    }

    /// The table is the test. Every number in §B7 is asserted, **and** the set of
    /// ballistic weapons must be exactly the set the table covers — so adding a
    /// weapon without adding its numbers here is a failure rather than a silent
    /// omission.
    #[test]
    fn every_ballistic_weapon_matches_the_spec_table() {
        for &(key, dmg, carve, range, cd, spread, ammo) in SPEC {
            let w = by_key(key).unwrap_or_else(|| panic!("{key} is not in the weapon table"));
            assert!(is_ballistic(w), "{key} is not ballistic hitscan");
            assert_eq!(w.damage, dmg, "{key} damage");
            assert_eq!(w.blast_radius, carve, "{key} carve radius");
            assert_eq!(w.range, range, "{key} range");
            assert_eq!(w.cooldown, cd, "{key} cooldown");
            assert_eq!(
                w.gravity_scale, 0.0,
                "{key} is hitscan, not ballistic flight"
            );
            assert_eq!(ammo_per_pickup(w.id), ammo, "{key} ammo per pickup");
            match w.delivery {
                Delivery::Hitscan { spread: s, .. } => assert_eq!(s, spread, "{key} spread"),
                _ => unreachable!(),
            }
        }

        let mut in_table: Vec<&str> = WEAPONS
            .iter()
            .filter(|w| is_ballistic(w))
            .map(|w| w.key)
            .collect();
        let mut in_spec: Vec<&str> = SPEC.iter().map(|&(k, ..)| k).collect();
        in_table.sort_unstable();
        in_spec.sort_unstable();
        assert_eq!(
            in_table, in_spec,
            "a ballistic weapon exists with no numbers in the §B7 table (or vice versa)"
        );
    }

    /// §A3: nothing hits a wall without marking it, and the carve radius is part
    /// of each weapon's identity — a deagle opens a hole a pistol does not.
    #[test]
    fn a_bigger_carve_radius_breaches_a_wall_in_fewer_shots() {
        const W: u32 = 1024;
        const H: u32 = 512;
        fn meta() -> MapMeta {
            MapMeta {
                seed: 1,
                requested_seed: 1,
                attempts: 1,
                used_safe_preset: false,
                scale: crate::constants::MapScale::Small,
                theme: 0,
                spawn_points: Vec::new(),
                surface_points: Vec::new(),
                buried_slots: Vec::new(),
                decorations: Vec::new(),
                wind: 0.0,
                traversable_fraction: 1.0,
                largest_component: Vec::new(),
            }
        }

        // Shots to punch through a 10-px wall, per weapon.
        fn shots_to_breach(key: &str) -> Option<u32> {
            let mut mask = Mask::new_empty(W, H);
            for y in 0..H as i32 {
                for x in 500..510 {
                    mask.set(x, y);
                }
            }
            force_borders(&mut mask);
            let coarse = CoarseGrid::build(&mask);
            let mut map = Map::from_parts(mask, coarse, meta());
            let mut rng = substream(7, "ballistics");
            let w = by_key(key).expect("weapon");
            for n in 1..=200u32 {
                let mut targets: Vec<PlayerHitTarget> = Vec::new();
                fire_hitscan(
                    &mut map,
                    &mut targets,
                    w,
                    0,
                    Vec2::new(300.0, 256.0),
                    0.0,
                    &mut rng,
                    0.0,
                );
                if (500..510).all(|x| !map.mask.get(x, 256)) {
                    return Some(n);
                }
            }
            None
        }

        let pistol = shots_to_breach("pistol").expect("pistol never breached a 10 px wall");
        let deagle = shots_to_breach("deagle").expect("deagle never breached a 10 px wall");
        assert!(
            deagle < pistol,
            "the deagle carves {} px and the pistol {} px, but breached in {deagle} vs {pistol} shots",
            DEAGLE_BLAST_RADIUS,
            PISTOL_BLAST_RADIUS
        );
    }

    /// Zero spread is exactly straight; a spread weapon stays inside its bound and
    /// is reproducible from its seed.
    #[test]
    fn spread_is_bounded_and_deterministic() {
        const W: u32 = 1024;
        const H: u32 = 512;
        fn empty_map() -> Map {
            let mut mask = Mask::new_empty(W, H);
            force_borders(&mut mask);
            let coarse = CoarseGrid::build(&mask);
            Map::from_parts(
                mask,
                coarse,
                MapMeta {
                    seed: 1,
                    requested_seed: 1,
                    attempts: 1,
                    used_safe_preset: false,
                    scale: crate::constants::MapScale::Small,
                    theme: 0,
                    spawn_points: Vec::new(),
                    surface_points: Vec::new(),
                    buried_slots: Vec::new(),
                    decorations: Vec::new(),
                    wind: 0.0,
                    traversable_fraction: 1.0,
                    largest_component: Vec::new(),
                },
            )
        }

        fn angles(key: &str, seed: u64, n: usize) -> Vec<f32> {
            let mut map = empty_map();
            let mut rng = substream(seed, "spread");
            let w = by_key(key).expect("weapon");
            let mut out = Vec::with_capacity(n);
            for _ in 0..n {
                let mut targets: Vec<PlayerHitTarget> = Vec::new();
                let shots = fire_hitscan(
                    &mut map,
                    &mut targets,
                    w,
                    0,
                    Vec2::new(200.0, 256.0),
                    0.0,
                    &mut rng,
                    0.0,
                );
                for s in shots {
                    let d = s.to - s.from;
                    out.push(d.y.atan2(d.x));
                }
            }
            out
        }

        // The laser pistol is the zero-spread weapon in the table; it must be
        // exactly straight, not merely close.
        let straight = angles("laser_pistol", 3, 50);
        assert!(!straight.is_empty());
        for a in &straight {
            assert_eq!(*a, 0.0, "zero spread must be exactly straight, got {a}");
        }

        // A spread weapon: inside its bound, and actually spreading — a bound
        // test alone passes for a weapon whose spread silently became zero.
        let mg = angles("machinegun", 11, 1000);
        assert_eq!(mg.len(), 1000);
        for a in &mg {
            assert!(
                a.abs() <= MACHINEGUN_SPREAD + 1e-6,
                "machinegun strayed to {a} beyond ±{MACHINEGUN_SPREAD}"
            );
        }
        let distinct = mg.iter().filter(|a| a.abs() > 1e-9).count();
        assert!(
            distinct > 900,
            "only {distinct} of 1000 machinegun shots deviated — spread is not being applied"
        );

        // Same seed, same shots.
        assert_eq!(angles("machinegun", 11, 100), angles("machinegun", 11, 100));
        assert_ne!(angles("machinegun", 12, 100), angles("machinegun", 11, 100));
    }

    /// Every new gun is a real, findable, resolvable item — §A39's shape is a
    /// weapon def with no registry entry, or an entry pointing at nothing.
    #[test]
    fn every_ballistic_weapon_is_an_item_you_can_find() {
        for &(key, ..) in SPEC {
            let w = by_key(key).expect("weapon def");
            let item = registry::by_key(key)
                .unwrap_or_else(|| panic!("{key} has a weapon def but is not an item"));
            assert_eq!(
                item.kind,
                registry::ItemKind::Weapon(w.id),
                "{key}'s item does not point at its own weapon"
            );
            assert!(
                item.spawn_weight > 0 || item.crate_weight > 0 || item.buried_weight > 0,
                "{key} can never be obtained from any source"
            );
            assert_eq!(
                item.max_stack,
                ammo_per_pickup(w.id),
                "{key} ammo disagrees"
            );
        }
    }

    #[test]
    fn a_hit_lands_for_every_gun() {
        // Cheapest possible end-to-end: each gun must actually damage a player at
        // point-blank, which no amount of table-checking proves.
        const W: u32 = 1024;
        const H: u32 = 512;
        for &(key, dmg, ..) in SPEC {
            let mut mask = Mask::new_empty(W, H);
            force_borders(&mut mask);
            let coarse = CoarseGrid::build(&mask);
            let mut map = Map::from_parts(
                mask,
                coarse,
                MapMeta {
                    seed: 1,
                    requested_seed: 1,
                    attempts: 1,
                    used_safe_preset: false,
                    scale: crate::constants::MapScale::Small,
                    theme: 0,
                    spawn_points: Vec::new(),
                    surface_points: Vec::new(),
                    buried_slots: Vec::new(),
                    decorations: Vec::new(),
                    wind: 0.0,
                    traversable_fraction: 1.0,
                    largest_component: Vec::new(),
                },
            );
            let mut dealt = 0.0f32;
            let mut vel = Vec2::ZERO;
            {
                let mut hit_fn = |d: f32, _s: crate::weapons::explode::DamageSource| {
                    dealt += d;
                    true
                };
                let mut targets = vec![PlayerHitTarget {
                    id: 1,
                    alive: true,
                    pos: Vec2::new(300.0, 256.0),
                    vel: &mut vel,
                    apply_damage: &mut hit_fn,
                }];
                let mut rng = substream(5, "hit");
                let shots = fire_hitscan(
                    &mut map,
                    &mut targets,
                    by_key(key).expect("weapon"),
                    0,
                    Vec2::new(200.0, 256.0),
                    0.0,
                    &mut rng,
                    0.0,
                );
                assert!(
                    shots
                        .iter()
                        .any(|s| matches!(s.hit, Some(HitscanHit::Player(1)))),
                    "{key} did not hit a player 100 px away in open air"
                );
            }
            assert_eq!(dealt, dmg, "{key} dealt {dealt}, expected {dmg}");
        }
    }
}
