//! The v1 arsenal: three weapons, three roles.
//!
//! A direct arcing hit, indirect area denial, and sustained chip damage that also
//! tunnels. `Delivery` is the extension seam — clustering, homing, airstrikes and
//! drills all become new variants without changing the firing code's shape
//! (`docs/31-weapons-combat.md` §1, §8).

use crate::constants::{
    AIRBURST_AMMO, FLAME_FRICTION, FLAME_GRAVITY_SCALE, FLAME_LIFE, FLAME_RESTITUTION,
    MOLOTOV_AMMO, SMOKE_AMMO, TOXIC_DROP_SPEED, TOXIC_GRENADE_AMMO,
};
use crate::constants::{
    AIRBURST_FAN, AIRBURST_FUSE, AIRBURST_MUZZLE_SPEED, AIRBURST_PELLETS, AIRBURST_PELLET_CARVE,
    AIRBURST_PELLET_DAMAGE, AIRBURST_PELLET_ENERGY, AIRBURST_PELLET_RANGE, LAVA_BURN_DPS,
    LAVA_BURN_RADIUS, MOLOTOV_BURN_DURATION, MOLOTOV_MUZZLE_SPEED, MOLOTOV_PATCHES,
    MOLOTOV_SCATTER, SMOKE_DURATION, SMOKE_FUSE, SMOKE_MUZZLE_SPEED, SMOKE_RADIUS,
    TOXIC_GRENADE_DPS, TOXIC_GRENADE_DURATION, TOXIC_GRENADE_FUSE, TOXIC_GRENADE_MUZZLE_SPEED,
    TOXIC_GRENADE_RADIUS,
};
use crate::constants::{
    AXE_ARC, AXE_CARVE, AXE_COOLDOWN, AXE_DAMAGE, AXE_KNOCKBACK, AXE_REACH, BAT_ARC, BAT_CARVE,
    BAT_COOLDOWN, BAT_DAMAGE, BAT_KNOCKBACK, BAT_REACH, HAMMER_ARC, HAMMER_CARVE, HAMMER_COOLDOWN,
    HAMMER_DAMAGE, HAMMER_KNOCKBACK, HAMMER_REACH, KNIFE_ARC, KNIFE_CARVE, KNIFE_COOLDOWN,
    KNIFE_DAMAGE, KNIFE_KNOCKBACK, KNIFE_REACH, SHOVEL_ARC, SHOVEL_CARVE, SHOVEL_COOLDOWN,
    SHOVEL_DAMAGE, SHOVEL_KNOCKBACK, SHOVEL_REACH, WHIP_ARC, WHIP_CARVE, WHIP_COOLDOWN,
    WHIP_DAMAGE, WHIP_KNOCKBACK, WHIP_REACH,
};
use crate::constants::{
    BAZOOKA_AMMO, BAZOOKA_BLAST_RADIUS, BAZOOKA_COOLDOWN, BAZOOKA_DAMAGE, BAZOOKA_GRAVITY_SCALE,
    BAZOOKA_MUZZLE_SPEED, BAZOOKA_WIND_SCALE, GRENADE_AMMO, GRENADE_BLAST_RADIUS, GRENADE_COOLDOWN,
    GRENADE_DAMAGE, GRENADE_FRICTION, GRENADE_FUSE, GRENADE_GRAVITY_SCALE, GRENADE_MUZZLE_SPEED,
    GRENADE_RESTITUTION, GRENADE_WIND_SCALE, SMG_AMMO, SMG_BLAST_RADIUS, SMG_COOLDOWN, SMG_DAMAGE,
    SMG_MUZZLE_SPEED, SMG_RANGE, SMG_SPREAD,
};
use crate::constants::{
    DEAGLE_AMMO, DEAGLE_BLAST_RADIUS, DEAGLE_COOLDOWN, DEAGLE_DAMAGE, DEAGLE_MUZZLE_SPEED,
    DEAGLE_RANGE, DEAGLE_SPREAD, MACHINEGUN_AMMO, MACHINEGUN_BLAST_RADIUS, MACHINEGUN_COOLDOWN,
    MACHINEGUN_DAMAGE, MACHINEGUN_MUZZLE_SPEED, MACHINEGUN_RANGE, MACHINEGUN_SPREAD, PISTOL_AMMO,
    PISTOL_BLAST_RADIUS, PISTOL_COOLDOWN, PISTOL_DAMAGE, PISTOL_MUZZLE_SPEED, PISTOL_RANGE,
    PISTOL_SPREAD, REVOLVER_AMMO, REVOLVER_BLAST_RADIUS, REVOLVER_COOLDOWN, REVOLVER_DAMAGE,
    REVOLVER_MUZZLE_SPEED, REVOLVER_RANGE, REVOLVER_SPREAD,
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
    WEAPON_DEAGLE, WEAPON_FLAME, WEAPON_FLAMETHROWER, WEAPON_GRENADE, WEAPON_HAMMER, WEAPON_KNIFE,
    WEAPON_LASER_PISTOL, WEAPON_LASER_SMG, WEAPON_MACHINEGUN, WEAPON_METEOR, WEAPON_METEOR_FRAG,
    WEAPON_MINE, WEAPON_MOLOTOV, WEAPON_PISTOL, WEAPON_REVOLVER, WEAPON_SHOVEL, WEAPON_SMG,
    WEAPON_SMOKE, WEAPON_TOXIC_DROP, WEAPON_TOXIC_GRENADE, WEAPON_WHIP,
};

#[derive(Copy, Clone, Debug, PartialEq)]
pub enum Delivery {
    Projectile {
        fuse: Option<f32>,
        restitution: f32,
        friction: f32,
        explode_on_contact: bool,
    },
    /// An instant ray (§B7). **Energy weapons only, since §F1** — a laser is a
    /// beam and arrives the moment it is fired, which is the one thing that
    /// makes it different from a bullet.
    ///
    /// `auto` lives here as well as on `Bullet` because §F3's automatic set is
    /// the SMG, the machinegun **and the laser SMG** — and the laser SMG is the
    /// one of the three that never became a projectile. Without the field the
    /// spec's own list could not be expressed, and the temptation would be a
    /// special case keyed on the weapon's name, which is the §B16 bug waiting to
    /// happen.
    Hitscan { shots: u8, spread: f32, auto: bool },
    /// A round that **flies** (§F1).
    ///
    /// The ballistic guns were `Hitscan` for six milestones and the report never
    /// stopped being "I cannot see gun projectiles". The cause was upstream of
    /// the renderer: a hitscan shot is a line segment that appears and vanishes
    /// in the same instant, and `ordnance-visible` could only photograph one by
    /// **freezing the frame first**. A check that has to stop time to see a thing
    /// is telling you the player cannot.
    ///
    /// So a bullet is an object: it leaves the muzzle at the def's `muzzle_speed`,
    /// flies **straight** — no gravity, no wind, enforced in the step rather than
    /// trusted to two zeroes in the table — and stops at the first thing it
    /// touches or when it has flown `range`.
    ///
    /// `auto` is the weapon's, not the input's, so a bot holding fire behaves
    /// exactly as a human does (§F3).
    Bullet { spread: f32, auto: bool },
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
    /// It goes out, and that is all (§F10).
    ///
    /// A flame's whole effect happens *while it is alive* — `FLAME_DPS` to
    /// anyone inside it and a `FLAME_SCORCH_R` bite out of the ground it rests
    /// on — so the end of one is not an event, it is an absence. Spelled as a
    /// variant rather than reusing `Blast` with zeroes because `detonate`
    /// matches exhaustively: this way "nothing happens" is a decision somebody
    /// made, and a future burst kind is still a compile error there.
    Flame,
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

    /// Does holding the fire button keep this weapon firing? (§F3)
    ///
    /// One function for one question, matched exhaustively, so a new delivery is
    /// a compile error here rather than a weapon that silently cannot repeat.
    /// The alternative — `matches!(delivery, Bullet { auto: true, .. })` at each
    /// call site — misses the laser SMG, which is the one automatic weapon that
    /// is not a bullet.
    pub fn is_auto(&self) -> bool {
        match self.delivery {
            Delivery::Bullet { auto, .. } | Delivery::Hitscan { auto, .. } => auto,
            Delivery::Projectile { .. }
            | Delivery::Melee { .. }
            | Delivery::Cone { .. }
            | Delivery::Placed { .. } => false,
        }
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
        delivery: Delivery::Bullet {
            spread: SMG_SPREAD,
            auto: true,
        },
        damage: SMG_DAMAGE,
        blast_radius: SMG_BLAST_RADIUS,
        range: SMG_RANGE,
        cooldown: SMG_COOLDOWN,
        muzzle_speed: SMG_MUZZLE_SPEED,
        // Zero because a bullet flies straight, and the step enforces it rather
        // than reading these (§F1). They stay 0.0 so nothing that iterates the
        // table sees a number that would be a lie if it were ever read.
        gravity_scale: 0.0,
        wind_scale: 0.0,
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
            auto: false,
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
            auto: true,
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
    // --- ballistic bullets (§B7, §F1) ---
    //
    // These five were `Hitscan` until §F1. They fly now: same damage, same
    // carve, same spread, but the shot is an object that crosses the map at
    // `muzzle_speed` and can be photographed without stopping time.
    //
    // Appended, never inserted: `def` indexes by array position, and putting a
    // new id in the middle remaps every weapon after it — a laser resolving as a
    // bazooka, with no symptom that looks like an ordering bug (§B16).
    WeaponDef {
        id: WEAPON_PISTOL,
        key: "pistol",
        delivery: Delivery::Bullet {
            spread: PISTOL_SPREAD,
            auto: false,
        },
        damage: PISTOL_DAMAGE,
        blast_radius: PISTOL_BLAST_RADIUS,
        range: PISTOL_RANGE,
        cooldown: PISTOL_COOLDOWN,
        muzzle_speed: PISTOL_MUZZLE_SPEED,
        gravity_scale: 0.0,
        wind_scale: 0.0,
        energy_cost: 0.0,
        burst: Burst::Blast,
    },
    WeaponDef {
        id: WEAPON_REVOLVER,
        key: "revolver",
        delivery: Delivery::Bullet {
            spread: REVOLVER_SPREAD,
            auto: false,
        },
        damage: REVOLVER_DAMAGE,
        blast_radius: REVOLVER_BLAST_RADIUS,
        range: REVOLVER_RANGE,
        cooldown: REVOLVER_COOLDOWN,
        muzzle_speed: REVOLVER_MUZZLE_SPEED,
        gravity_scale: 0.0,
        wind_scale: 0.0,
        energy_cost: 0.0,
        burst: Burst::Blast,
    },
    WeaponDef {
        id: WEAPON_DEAGLE,
        key: "deagle",
        delivery: Delivery::Bullet {
            spread: DEAGLE_SPREAD,
            auto: false,
        },
        damage: DEAGLE_DAMAGE,
        blast_radius: DEAGLE_BLAST_RADIUS,
        range: DEAGLE_RANGE,
        cooldown: DEAGLE_COOLDOWN,
        muzzle_speed: DEAGLE_MUZZLE_SPEED,
        gravity_scale: 0.0,
        wind_scale: 0.0,
        energy_cost: 0.0,
        burst: Burst::Blast,
    },
    WeaponDef {
        id: WEAPON_MACHINEGUN,
        key: "machinegun",
        delivery: Delivery::Bullet {
            spread: MACHINEGUN_SPREAD,
            auto: true,
        },
        damage: MACHINEGUN_DAMAGE,
        blast_radius: MACHINEGUN_BLAST_RADIUS,
        range: MACHINEGUN_RANGE,
        cooldown: MACHINEGUN_COOLDOWN,
        muzzle_speed: MACHINEGUN_MUZZLE_SPEED,
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
            dps: TOXIC_GRENADE_DPS,
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
            // Never fired by a player — `Burst::Pellets` spawns it — so there is
            // no button to hold.
            auto: false,
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
    // A drop of toxic rain (§C21, §E13). It falls and it lands; it does **not**
    // go off. Zero damage and zero blast radius are not "a very small
    // explosion" — `World::detonate` intercepts this weapon before the blast
    // entirely: what it hits it poisons, and what it lands on it takes a
    // `TOXIC_DROP_CARVE_R` bite out of. A meteor's crater is the one thing
    // `docs/13` §3 says toxic rain must never leave, and routing it through
    // `explode` at some small radius is one tuning pass away from becoming one.
    //
    // `wind_scale` 1.0: rain drifts, and it is the one weather projectile where
    // drift is a feature rather than an aiming error.
    WeaponDef {
        id: WEAPON_TOXIC_DROP,
        key: "toxic_drop",
        delivery: Delivery::Projectile {
            fuse: None,
            restitution: 0.0,
            friction: 0.0,
            explode_on_contact: true,
        },
        damage: 0.0,
        blast_radius: 0.0,
        range: 0.0,
        cooldown: 0.0,
        muzzle_speed: TOXIC_DROP_SPEED,
        gravity_scale: 1.0,
        wind_scale: 1.0,
        energy_cost: 0.0,
        burst: Burst::Blast,
    },
    // §F5 — the shovel. **Appended last** (§B16): `WEAPONS[i].id ==
    // WeaponId(i)`, and the client mirrors this order in `WEAPON_KEYS`.
    //
    // The only melee weapon anybody carries — every player spawns holding one —
    // so it is the arsenal's floor rather than one option among five. It digs the
    // widest of any melee weapon because tunnelling is half its job.
    WeaponDef {
        id: WEAPON_SHOVEL,
        key: "shovel",
        delivery: Delivery::Melee {
            reach: SHOVEL_REACH,
            arc: SHOVEL_ARC,
            knockback: SHOVEL_KNOCKBACK,
        },
        damage: SHOVEL_DAMAGE,
        blast_radius: SHOVEL_CARVE,
        range: 0.0,
        cooldown: SHOVEL_COOLDOWN,
        muzzle_speed: 0.0,
        gravity_scale: 0.0,
        wind_scale: 0.0,
        energy_cost: 0.0,
        burst: Burst::Blast,
    },
    // --- F10: one flame ---------------------------------------------------
    //
    // Nothing emits these yet — that is §F10.2, and T19.11's journal says the
    // production-caller grep is deferred there rather than forgotten.
    //
    // It is a `Projectile` with a fuse and no contact explosion, which is a
    // grenade that does not go off: `projectile.rs` already bounces, already
    // rests below `GRENADE_REST_SPEED`, and already ends a projectile on its
    // fuse. A second flight loop for fire would be the §A24 mistake this
    // codebase has paid for twice.
    WeaponDef {
        id: WEAPON_FLAME,
        key: "flame",
        delivery: Delivery::Projectile {
            fuse: Some(FLAME_LIFE),
            restitution: FLAME_RESTITUTION,
            friction: FLAME_FRICTION,
            explode_on_contact: false,
        },
        // **Zero damage and zero blast on purpose.** A flame's damage is
        // continuous — `FLAME_DPS` per second while you are inside it — and it
        // is applied by `weapons::flame`, not by anything that reads these two
        // fields. A non-zero `damage` here would be a number that never runs;
        // a non-zero `blast_radius` would put a crater under every flame that
        // went out.
        damage: 0.0,
        blast_radius: 0.0,
        range: 0.0,
        cooldown: 0.0,
        // The emitters choose the speed — the flamethrower's muzzle speed and a
        // molotov's burst speed are different numbers (§F10.2) — so they spawn
        // with an explicit velocity rather than through `Projectiles::spawn`.
        muzzle_speed: 0.0,
        gravity_scale: FLAME_GRAVITY_SCALE,
        // Fire is not blown about: §F10 does not give it a wind term, and 0.0 is
        // not a tunable (§F1's reasoning about the bullets).
        wind_scale: 0.0,
        energy_cost: 0.0,
        burst: Burst::Flame,
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

    /// The exemption above is only sound while something really does intercept
    /// these before they explode. Assert that, or `every_weapon_digs` becomes a
    /// list of weapons nobody checks.
    #[test]
    fn a_landing_weapon_is_actually_intercepted_before_it_can_explode() {
        // Every name on the exemption list is recognised by the effect that
        // lands it. A weapon that reached `explode` with zero damage and zero
        // radius would carve nothing today and carve as soon as anyone changed
        // the radius — which is the failure the exemption is pretending cannot
        // happen.
        let drop = by_key("toxic_drop").expect("toxic_drop is a weapon");
        assert!(
            crate::effects::toxic::owns(drop.id),
            "toxic_drop is exempted from doing damage but nothing intercepts it, \
             so it will be detonated as an ordinary projectile"
        );
        assert_eq!(
            drop.damage, 0.0,
            "a drop of rain should not hurt on contact"
        );
        assert_eq!(drop.blast_radius, 0.0, "a drop of rain must not carve");
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
        // Weather ordnance that **lands** rather than going off. A toxic drop is
        // a projectile only so that it falls (§C21); `World::detonate` intercepts
        // it before any blast, so damage and a blast radius on its def would
        // describe an explosion that never happens. The bite it does take out of
        // the ground is `TOXIC_DROP_CARVE_R` (§E13) and is applied there, not
        // here — a def-level carve radius is what `explode` reads.
        //
        // Named here rather than skipped by a property, so it cannot be joined
        // silently; and `a_landing_weapon_is_actually_intercepted` below asserts
        // the interception that earns the exemption, so removing that code makes
        // this list wrong and a test red.
        const LANDS_INSTEAD_OF_EXPLODING: &[&str] = &["toxic_drop"];
        for w in WEAPONS {
            if LANDS_INSTEAD_OF_EXPLODING.contains(&w.key) {
                continue;
            }
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
                // §F10. A flame's effect is not on its def at all: it burns
                // `FLAME_DPS` for `FLAME_LIFE` while alive, so the numbers that
                // decide whether it does anything are constants rather than
                // `w.damage` and `w.blast_radius` — which means a *runtime*
                // assertion on them is one the compiler can answer, and clippy
                // says so out loud. The guard is `weapons::flame`'s
                // `const _: () = assert!(...)`, which fails the build instead.
                Burst::Flame => {}
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
        // Chip damage that tunnels: cheap per shot, fast, small carve — and
        // since §F1 a round that flies, held down (`auto`) rather than clicked.
        match smg.delivery {
            Delivery::Bullet { spread, auto } => {
                assert!(spread > 0.0);
                assert!(auto, "the smg is an automatic");
            }
            _ => panic!("the smg must fire bullets"),
        }
        assert!(smg.damage < bazooka.damage / 4.0);
        assert!(smg.cooldown < bazooka.cooldown / 4.0);
        assert!(smg.range > 0.0, "a bullet's life is its range");
        assert!(smg.muzzle_speed > 0.0, "a bullet has to fly");
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
        assert_eq!(s.muzzle_speed, SMG_MUZZLE_SPEED);
        assert_eq!(s.gravity_scale, 0.0, "a bullet flies straight");
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
    use crate::weapons::explode::{HitId, HitTarget};

    /// `docs/71-amendments-v3.md` §B7 and `docs/75` §F1, transcribed.
    /// `(key, dmg, carve, range, cd, spread, ammo, muzzle_speed, auto)`
    #[allow(clippy::type_complexity)]
    const SPEC: &[(&str, f32, f32, f32, f32, f32, u8, f32, bool)] = &[
        ("smg", 8.0, 3.0, 700.0, 0.10, 0.030, 60, 800.0, true),
        ("pistol", 14.0, 3.0, 520.0, 0.28, 0.020, 40, 900.0, false),
        ("revolver", 32.0, 5.0, 700.0, 0.70, 0.010, 12, 1000.0, false),
        ("deagle", 45.0, 6.0, 760.0, 0.85, 0.015, 8, 1050.0, false),
        (
            "machinegun",
            11.0,
            3.0,
            900.0,
            0.09,
            0.045,
            120,
            850.0,
            true,
        ),
    ];

    fn is_ballistic(w: &WeaponDef) -> bool {
        matches!(w.delivery, Delivery::Bullet { .. }) && !w.is_energy()
    }

    /// The table is the test. Every number in §B7 is asserted, **and** the set of
    /// ballistic weapons must be exactly the set the table covers — so adding a
    /// weapon without adding its numbers here is a failure rather than a silent
    /// omission.
    #[test]
    fn every_ballistic_weapon_matches_the_spec_table() {
        for &(key, dmg, carve, range, cd, spread, ammo, speed, auto) in SPEC {
            let w = by_key(key).unwrap_or_else(|| panic!("{key} is not in the weapon table"));
            assert!(is_ballistic(w), "{key} does not fire bullets");
            assert_eq!(w.damage, dmg, "{key} damage");
            assert_eq!(w.blast_radius, carve, "{key} carve radius");
            assert_eq!(w.range, range, "{key} range");
            assert_eq!(w.cooldown, cd, "{key} cooldown");
            assert_eq!(w.muzzle_speed, speed, "{key} muzzle speed");
            assert_eq!(w.gravity_scale, 0.0, "{key} is a bullet: it flies straight");
            assert_eq!(w.wind_scale, 0.0, "{key} is a bullet: no wind");
            assert_eq!(ammo_per_pickup(w.id), ammo, "{key} ammo per pickup");
            match w.delivery {
                Delivery::Bullet { spread: s, auto: a } => {
                    assert_eq!(s, spread, "{key} spread");
                    assert_eq!(a, auto, "{key} auto");
                }
                _ => unreachable!(),
            }
        }

        // §F3: the automatics hit softer than the guns that fire once, and it is
        // an invariant rather than a coincidence of today's numbers — a balance
        // change that inverts it fails here instead of being found in play.
        let worst_semi = SPEC
            .iter()
            .filter(|&&(.., auto)| !auto)
            .map(|&(_, dmg, ..)| dmg)
            .fold(f32::INFINITY, f32::min);
        let best_auto = SPEC
            .iter()
            .filter(|&&(.., auto)| auto)
            .map(|&(_, dmg, ..)| dmg)
            .fold(0.0f32, f32::max);
        assert!(
            best_auto < worst_semi,
            "an automatic hits for {best_auto}, harder than the weakest semi-auto at {worst_semi}"
        );

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

    /// Fire one round and fly it to wherever it stops, through the real path.
    ///
    /// Returns the pixels it removed. A helper that carved directly would test a
    /// path the game does not run.
    fn fire_one(
        map: &mut Map,
        targets: &mut [crate::weapons::explode::HitTarget],
        key: &str,
        from: Vec2,
        aim: f32,
        rng: &mut crate::rng::ChaCha8Rng,
    ) -> (Option<HitId>, u32) {
        use crate::weapons::projectile::{ProjectileOutcome, Projectiles};
        let w = by_key(key).expect("weapon");
        let Delivery::Bullet { spread, .. } = w.delivery else {
            panic!("{key} is not a bullet");
        };
        let a = crate::weapons::bullet::muzzle_angle(rng, aim, spread);
        let mut pr = Projectiles::new();
        pr.spawn(w.id, 0, from, a, 0.0);
        let boxes: Vec<(HitId, crate::math::Aabb)> = targets
            .iter()
            .map(|t| (t.id, crate::math::Aabb::from_center_size(t.pos, t.w, t.h)))
            .collect();
        let max_ticks = ((w.range / w.muzzle_speed) / crate::constants::SIM_DT).ceil() as u32 + 10;
        for i in 0..max_ticks {
            let now = i as f32 * crate::constants::SIM_DT;
            // One round in flight: the first impact is the only impact.
            if let Some(im) = pr
                .step(map, &boxes, &[], 0.0, now, crate::constants::SIM_DT)
                .into_iter()
                .next()
            {
                let (at, victim) = match im.outcome {
                    ProjectileOutcome::Exploded { at } => (at, None),
                    ProjectileOutcome::Hit { at, victim } => (at, Some(victim)),
                    // Ran out of range or left the map: it resolves to nothing.
                    ProjectileOutcome::Spent { .. } | ProjectileOutcome::Voided { .. } => {
                        return (None, 0)
                    }
                    ProjectileOutcome::Alive => unreachable!(),
                };
                let r = crate::weapons::bullet::resolve(
                    map,
                    targets,
                    w,
                    at,
                    victim,
                    crate::weapons::explode::BlastSource::Fired {
                        owner: 0,
                        weapon: w.id,
                    },
                );
                return (
                    r.hit.map(|(id, _)| id),
                    r.carve.as_ref().map_or(0, |c| c.pixels_removed),
                );
            }
        }
        panic!("{key} was still flying after {max_ticks} ticks");
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
                teleport_pads: Vec::new(),
                surface_points: Vec::new(),
                objects: Vec::new(),
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
            for n in 1..=200u32 {
                let mut targets: Vec<HitTarget> = Vec::new();
                fire_one(
                    &mut map,
                    &mut targets,
                    key,
                    Vec2::new(300.0, 256.0),
                    0.0,
                    &mut rng,
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

    /// The spread reaches the **flight**, not just the draw.
    ///
    /// `bullet::muzzle_angle` has its own bound-and-determinism test; this is the
    /// one that would catch a fire path that drew an angle and then spawned along
    /// the un-jittered aim — which is a real shape, because `Projectiles::spawn`
    /// takes an aim and nothing forces the caller to pass the drawn one.
    #[test]
    fn the_spread_reaches_where_the_round_goes() {
        let heading = |seed: u64, key: &str, n: usize| -> Vec<f32> {
            use crate::weapons::projectile::Projectiles;
            let w = by_key(key).expect("weapon");
            let Delivery::Bullet { spread, .. } = w.delivery else {
                panic!("{key} is not a bullet");
            };
            let mut rng = substream(seed, "spread");
            (0..n)
                .map(|_| {
                    let a = crate::weapons::bullet::muzzle_angle(&mut rng, 0.0, spread);
                    let mut pr = Projectiles::new();
                    let id = pr.spawn(w.id, 0, Vec2::new(200.0, 256.0), a, 0.0);
                    let p = pr.get(id).expect("spawned");
                    p.vel.y.atan2(p.vel.x)
                })
                .collect()
        };

        // The laser pistol is the zero-spread weapon in the table — but it is a
        // beam now, so the zero-spread bullet control is the revolver's 0.010:
        // small, and it must still be *applied*.
        let rev = heading(3, "revolver", 200);
        for a in &rev {
            assert!(
                a.abs() <= REVOLVER_SPREAD + 1e-6,
                "revolver strayed to {a} beyond ±{REVOLVER_SPREAD}"
            );
        }

        let mg = heading(11, "machinegun", 1000);
        assert_eq!(mg.len(), 1000);
        for a in &mg {
            assert!(
                a.abs() <= MACHINEGUN_SPREAD + 1e-6,
                "machinegun strayed to {a} beyond ±{MACHINEGUN_SPREAD}"
            );
        }
        // A bound test alone passes for a weapon whose spread silently became
        // zero — or for a fire path that ignored the draw.
        let distinct = mg.iter().filter(|a| a.abs() > 1e-9).count();
        assert!(
            distinct > 900,
            "only {distinct} of 1000 machinegun rounds deviated — the spread is not reaching the flight"
        );
        // And the machinegun spreads wider than the revolver, which is the table.
        let spread_of = |v: &[f32]| v.iter().fold(0.0f32, |m, a| m.max(a.abs()));
        assert!(
            spread_of(&mg) > spread_of(&rev),
            "the machinegun is not spreading wider than the revolver"
        );

        assert_eq!(
            heading(11, "machinegun", 100),
            heading(11, "machinegun", 100)
        );
        assert_ne!(
            heading(12, "machinegun", 100),
            heading(11, "machinegun", 100)
        );
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
                    teleport_pads: Vec::new(),
                    surface_points: Vec::new(),
                    objects: Vec::new(),
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
                let mut targets = vec![HitTarget {
                    id: HitId::Player(1),
                    w: crate::constants::PLAYER_W,
                    h: crate::constants::PLAYER_H,
                    alive: true,
                    pos: Vec2::new(300.0, 256.0),
                    vel: &mut vel,
                    apply_damage: &mut hit_fn,
                }];
                let mut rng = substream(5, "hit");
                let (hit, carved) = fire_one(
                    &mut map,
                    &mut targets,
                    key,
                    Vec2::new(200.0, 256.0),
                    0.0,
                    &mut rng,
                );
                assert_eq!(
                    hit,
                    Some(HitId::Player(1)),
                    "{key} did not hit a player 100 px away in open air"
                );
                assert_eq!(carved, 0, "{key} carved the ground it never reached");
            }
            assert_eq!(dealt, dmg, "{key} dealt {dealt}, expected {dmg}");
        }
    }
}
