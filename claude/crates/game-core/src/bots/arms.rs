//! What a bot holds and when it pulls the trigger: its stand-off, the weapon it
//! selects, the throw guards. Split out of `bots/mod.rs` by T22.14B, unchanged.

use super::Bot;
use crate::constants::{
    GravityMode, BATTERY_MAX, BOT_BLAST_GUARD, BOT_CHARGE_BELOW, BOT_FLAME_REACH_SCALE,
    BOT_GUN_HOLD_SHARE, BOT_HAZARD_CLEARANCE, BOT_HEAL_BELOW, BOT_LOB_SWEEP, BOT_LOS_MAX_BLOCKED,
    BOT_LOS_STEP, BOT_OUT_OF_REACH_SCORE, BOT_PREDICT_TICKS, BOT_REFUSED_SCORE, BOT_SPACE_IN_RANGE,
    BOT_SPACE_ZONE_REACH, BOT_STAND_OFF_MIN, BOT_STAND_OFF_SCALE, FLAME_DPS, FLAME_GRAVITY_SCALE,
    FLAME_LIFE, FLAME_RADIUS, GRAVITY, INVENTORY_SLOTS,
};
use crate::items::registry::{def, ItemId, ItemKind};
use crate::math::Vec2;
use crate::weapons::defs::Delivery;
use crate::world::World;

/// **The trap fired, and this is what it caught** (T22.03).
///
/// It used to read `Standard/Low/Space .scale() > 0.0`, as a compile-time trap
/// for the task that makes `GravityMode::Space` answer `0.0`: `zone_reach`
/// **divides** by the match's gravity scale, so a zero there turns a flame
/// stand-off into `inf` and a bot walks to the edge of the world rather than
/// throwing. T22.03 made the change, this line failed to compile, and
/// `zone_reach` grew the bound that makes the division safe — which is exactly
/// the sequence the old comment asked for.
///
/// It is kept, pointed at what now has to stay true: **`GRAVITY` itself is
/// nonzero**, which is the other half of that division and the one no mode can
/// change. **It is deliberately a weaker guard than the one it replaced, and
/// not the guard on `zone_reach`'s value** — `GRAVITY` and
/// `FLAME_GRAVITY_SCALE` are two constants nobody is going to zero, so this
/// line would not notice the `FLAME_LIFE` bound being deleted and `inf`
/// returning. Measured: it does not.
/// Since R95 (T22.03C) no mode can return `inf`: the one whose scale is zero,
/// `GravityMode::Space`, answers `BOT_SPACE_ZONE_REACH` without dividing (T22.03E
/// F2 removed the runtime "finite under every mode" loop, which could no longer
/// fail; `tests::zone_reach_in_space_is_the_measured_stand_off_and_the_lifetime_bound_binds_no_mode`
/// asserts what still can move). `GravityMode::Space` is a *scale* of zero and never a `GRAVITY` of
/// zero — `constants::GravityMode::scale` says why that distinction is load
/// bearing — so if anyone ever reaches for the shortcut, this is where it
/// stops.
const _: () = assert!(
    GRAVITY > 0.0 && FLAME_GRAVITY_SCALE > 0.0,
    "zone_reach divides by GRAVITY * FLAME_GRAVITY_SCALE; zero-g is a zero *scale*, never a zero GRAVITY"
);
/// T23.26D item 3: **the angle to launch an arcing projectile at so it reaches
/// `target`** — the ballistic solution from the weapon's own muzzle speed and gravity
/// (`GRAVITY × gravity_scale × the match's scale`, what `World` steps), checked against
/// the terrain by walking the real flight (`projectile::predict_impact`). The **low arc
/// first, then the high one**; `None` when neither gets there (out of reach, or rock in
/// both ways) — hold fire. `None` too for anything gravity does not bend.
///
/// What "gets there" means depends on how it goes off. One that bursts on contact
/// passes through `target` by construction, so it is enough that no rock is in the way
/// before it. One that bounces and sits on a fuse has to come to rest near it, so its
/// launch is swept (`BOT_LOB_SWEEP`) and walked to the fuse.
pub(super) fn lob_angle(
    world: &World,
    wid: crate::items::registry::WeaponId,
    pos: Vec2,
    target: Vec2,
) -> Option<f32> {
    let w = crate::weapons::defs::def(wid)?;
    let Delivery::Projectile {
        explode_on_contact, ..
    } = w.delivery
    else {
        return None;
    };
    let g = GRAVITY * w.gravity_scale * world.gravity.scale();
    let v = w.muzzle_speed;
    if g <= 0.0 || v <= 0.0 {
        return None;
    }
    let dx = target.x - pos.x;
    let up = pos.y - target.y;
    let run = dx.abs().max(1.0);
    let disc = v.powi(4) - g * (g * run * run + 2.0 * up * v * v);
    if disc < 0.0 {
        return None;
    }
    // Elevation above the horizontal, toward the target; screen angles have y down.
    let screen = |elev: f32| {
        if dx >= 0.0 {
            -elev
        } else {
            std::f32::consts::PI + elev
        }
    };
    // A fused throw is walked to its fuse (a grenade's 3 s is past `BOT_PREDICT_TICKS`,
    // and a walk cut short knows nothing of where it rests).
    let ticks = match w.delivery {
        Delivery::Projectile { fuse: Some(f), .. } => {
            (f / crate::constants::SIM_DT).ceil() as u32 + 1
        }
        _ => BOT_PREDICT_TICKS,
    };
    let land = |a: f32| {
        crate::weapons::projectile::predict_impact(
            &world.map,
            wid,
            pos,
            a,
            world.wind,
            world.gravity,
            ticks,
            crate::constants::SIM_DT,
        )
    };
    let tol = zone_reach(w, world.gravity)
        .unwrap_or(w.blast_radius)
        .max(crate::constants::PLAYER_H);
    if !explode_on_contact {
        // A bounce and a roll carry it on from where it first lands, so no closed form:
        // sweep the launch from a little below level to straight up, `BOT_LOB_SWEEP`
        // steps, and take the low half's best if it rests near enough, else the high's.
        let lo = -std::f32::consts::FRAC_PI_8;
        let hi = std::f32::consts::FRAC_PI_2;
        let mut best = [None::<(f32, f32)>; 2];
        for i in 0..=BOT_LOB_SWEEP {
            let elev = lo + (hi - lo) * i as f32 / BOT_LOB_SWEEP as f32;
            let a = screen(elev);
            let Some(at) = land(a) else { continue };
            let d = (at - target).len();
            let fam = usize::from(elev >= std::f32::consts::FRAC_PI_4);
            if best[fam].is_none_or(|(bd, _)| d < bd) {
                best[fam] = Some((d, a));
            }
        }
        return best
            .into_iter()
            .flatten()
            .find(|(d, _)| *d <= tol)
            .map(|(_, a)| a);
    }
    for elev in [
        (v * v - disc.sqrt()).atan2(g * run),
        (v * v + disc.sqrt()).atan2(g * run),
    ] {
        {
            // It passes through the target by construction: enough that no rock is in
            // the way before it gets there — the parabola walked in half-body steps of
            // run, from the muzzle to the target's column.
            let a = screen(elev);
            let (vx, vy) = (v * a.cos(), v * a.sin());
            let t_end = run / vx.abs().max(1.0);
            let steps = (run / (crate::constants::PLAYER_W * 0.5)).ceil().max(1.0) as u32;
            let muzzle = crate::constants::MUZZLE_OFFSET / v;
            let clear = (1..steps).all(|i| {
                let t = t_end * i as f32 / steps as f32;
                if t < muzzle {
                    return true;
                }
                let p = pos + Vec2::new(vx * t, vy * t + 0.5 * g * t * t);
                !crate::physics::collide::solid_at(&world.map, p.x as i32, p.y as i32)
            });
            if clear {
                return Some(a);
            }
        }
    }
    None
}

/// T23.26D item 3: can an arcing weapon reach `target` from `pos` at all — the
/// ballistic discriminant alone, no terrain (`choose_weapon`'s cheap test; `lob_angle`
/// is the full one). `true` for anything gravity does not bend.
pub(super) fn lob_reaches(
    world: &World,
    w: &crate::weapons::defs::WeaponDef,
    pos: Vec2,
    target: Vec2,
) -> bool {
    if !matches!(w.delivery, Delivery::Projectile { .. }) {
        return true;
    }
    let g = GRAVITY * w.gravity_scale * world.gravity.scale();
    let v = w.muzzle_speed;
    if g <= 0.0 || v <= 0.0 {
        return true;
    }
    let run = (target.x - pos.x).abs().max(1.0);
    let up = pos.y - target.y;
    v.powi(4) - g * (g * run * run + 2.0 * up * v * v) >= 0.0
}

/// T23.26D item 2: **how far a flamethrower's stream reaches**, px: where a level stream
/// has fallen a body's height — flames leave at `FLAME_MUZZLE_SPEED` and fall at
/// `GRAVITY × FLAME_GRAVITY_SCALE`, so `v·√(2·PLAYER_H / g)` ≈ 108 px. The def's `range`
/// is 0 (its damage is its flames'), so before this a bot fired it at anyone in sight.
pub(super) fn stream_reach() -> f32 {
    crate::constants::FLAME_MUZZLE_SPEED
        * (2.0 * crate::constants::PLAYER_H / (GRAVITY * FLAME_GRAVITY_SCALE)).sqrt()
}

/// T23.26D item 2: **what a flamethrower deals one target in its stream**, per second:
/// flames a second (`FLAMETHROWER_FLAMES_PER_SHOT / FLAMETHROWER_COOLDOWN`), each burning
/// `FLAME_DPS` for the time it takes to cross a body and its own radius twice — ≈ 54,
/// a shovel's. Its def's `damage / cooldown` is 0, and scored at 0 it lost to everything.
pub(super) fn stream_dps() -> f32 {
    use crate::constants::{
        FLAMETHROWER_COOLDOWN, FLAMETHROWER_FLAMES_PER_SHOT, FLAME_MUZZLE_SPEED, PLAYER_W,
    };
    FLAME_DPS * FLAMETHROWER_FLAMES_PER_SHOT as f32 / FLAMETHROWER_COOLDOWN
        * (2.0 * FLAME_RADIUS + PLAYER_W)
        / FLAME_MUZZLE_SPEED
}

/// T23.26D: the kinds a weapon's report is broken down by — [`weapon_kind`]'s answers.
pub const WEAPON_KINDS: [&str; 7] = ["melee", "gun", "laser", "flame", "arc", "rocket", "placed"];

/// T23.26D: which of [`WEAPON_KINDS`] an item is, by how it is delivered — `None` for
/// what is not a weapon. Arcs are projectiles gravity bends (grenades, molotovs, the
/// bazooka's rocket); a laser is hitscan that spends charge.
pub fn weapon_kind(item: ItemId) -> Option<usize> {
    let ItemKind::Weapon(wid) = def(item)?.kind else {
        return None;
    };
    let w = crate::weapons::defs::def(wid)?;
    Some(match w.delivery {
        Delivery::Melee { .. } => 0,
        Delivery::Bullet { .. } => 1,
        Delivery::Hitscan { .. } if w.energy_cost > 0.0 => 2,
        Delivery::Hitscan { .. } => 1,
        Delivery::Flames { .. } => 3,
        Delivery::Projectile { .. } if w.gravity_scale > 0.0 => 4,
        Delivery::Projectile { .. } => 5,
        Delivery::Placed { .. } => 6,
    })
}

/// T23.26F: a weapon that is not melee — what an unarmed bot goes to get.
pub(super) fn ranged(item: ItemId) -> bool {
    weapon_kind(item).is_some_and(|k| k != 0)
}

/// T23.26E: **how far a held weapon hits from**, px — a swing's `effective_reach`, a
/// stream's [`stream_reach`], a round's `range`; a weapon with no stated range (thrown and
/// launched rounds) is good to the sight range, `BOT_ENGAGE_RANGE`. `None` for what is not
/// a weapon. The fight measure's band (`movement::Watcher`), one answer for a human and a bot.
pub(super) fn band(item: ItemId) -> Option<f32> {
    let ItemKind::Weapon(wid) = def(item)?.kind else {
        return None;
    };
    let w = crate::weapons::defs::def(wid)?;
    Some(match w.delivery {
        Delivery::Melee { reach, .. } => crate::weapons::melee::effective_reach(reach),
        Delivery::Flames { .. } => stream_reach(),
        _ if w.range > 0.0 => w.range,
        _ => crate::constants::BOT_ENGAGE_RANGE,
    })
}

impl Bot {
    /// Where to hold an enemy from: [`Bot::stand_off`], but **never outside the
    /// selected weapon's range** — `BOT_SPACE_IN_RANGE` of a swing's
    /// `effective_reach` or a gun's `range`. One function for both movement models
    /// (T22.03H): flight had it since T22.03D; the walking model held `dx` at the
    /// 40 px floor, outside the shovel's 28 px reach, and never swung.
    pub(super) fn hold_off(&self, world: &World) -> f32 {
        let range = self
            .selected_weapon(world)
            .and_then(def)
            .and_then(|d| match d.kind {
                ItemKind::Weapon(wid) => crate::weapons::defs::def(wid),
                _ => None,
            })
            .and_then(|w| match w.delivery {
                Delivery::Melee { reach, .. } => {
                    Some(crate::weapons::melee::effective_reach(reach))
                }
                Delivery::Flames { .. } => Some(stream_reach()),
                _ => (w.range > 0.0).then_some(w.range),
            });
        let stand = self.stand_off(world);
        // T23.26D item 2: **a gun holds at range** — `BOT_GUN_HOLD_SHARE` of its reach,
        // never nearer than the stand-off and never past `BOT_SPACE_IN_RANGE` of the
        // reach. Before, every bullet weapon closed to the 40 px floor, and at 40 px a
        // bot's best score was its shovel's (54 dps against a pistol's 50).
        let gun = self
            .selected_weapon(world)
            .and_then(weapon_kind)
            .is_some_and(|k| k == 1 || k == 2);
        range.map_or(stand, |r| {
            let far = r * BOT_SPACE_IN_RANGE;
            if gun {
                (r * BOT_GUN_HOLD_SHARE).clamp(stand.min(far), far)
            } else {
                stand.min(far)
            }
        })
    }

    /// How close to close. Never inside the guard that stops us firing, or the
    /// bot walks to a range where it has forbidden itself to shoot.
    ///
    /// **`blast_radius` alone is the wrong number**, and this is the second place
    /// it was: it is 0 for exactly the `Burst::Zone` weapons — molotov, toxic —
    /// so a bot closed to the 40 px floor and stood in the fire it had just
    /// thrown. `zone_reach` already existed for the throw guard; the approach
    /// used the old number, which is why molotov self-harm stayed the highest in
    /// the arsenal after T11.14's first pass.
    pub(super) fn stand_off(&self, world: &World) -> f32 {
        let w = self
            .selected_weapon(world)
            .and_then(def)
            .and_then(|d| match d.kind {
                ItemKind::Weapon(wid) => crate::weapons::defs::def(wid),
                _ => None,
            });
        let reach = w.map_or(0.0, |w| {
            zone_reach(w, world.gravity).unwrap_or(w.blast_radius)
        });
        (reach * BOT_STAND_OFF_SCALE).max(BOT_STAND_OFF_MIN)
    }

    /// The selected weapon, **if it can actually be fired**.
    ///
    /// "Armed" has to mean "able to shoot", not "holding something
    /// weapon-shaped". Since §B5 an energy weapon with a flat battery is a
    /// paperweight, and a bot that counts it as a weapon stops shopping, walks at
    /// an enemy and never pulls the trigger — which is precisely what happened
    /// when the lasers landed: `ticks_armed 5003, ticks_engaged 0, fires 0`.
    pub(super) fn selected_weapon(&self, world: &World) -> Option<ItemId> {
        let me = world.player(self.player)?;
        let stack = me.inventory.slot(me.inventory.selected())?;
        match def(stack.item)?.kind {
            ItemKind::Weapon(wid) => {
                let cost = crate::weapons::defs::def(wid).map_or(0.0, |w| w.energy_cost);
                (cost <= 0.0 || me.battery >= cost).then_some(stack.item)
            }
            _ => None,
        }
    }

    /// Whether **any** slot holds a weapon that could be fired right now.
    ///
    /// Distinct from `selected_weapon`, which asks about the one in hand, and the
    /// distinction matters at exactly one place: deciding whether to go shopping.
    /// A bot holding a flat laser with a loaded gun two slots over is *armed* —
    /// `choose_weapon` switches it on this same tick — and treating it as unarmed
    /// sent it looking for a weapon it already had. Measured against the laser
    /// fixture, that read as 12583 shots refused for being unarmed against 474
    /// fired.
    ///
    /// **Melee does not count (§F5).** Every player now spawns holding a shovel,
    /// so a slot-counting answer is `true` for every bot for the whole round and
    /// "arm yourself first" stops meaning anything — no bot ever walks to a gun
    /// again. The question this function is asked at its one call site is "do I
    /// need to go shopping?", and the honest answer for someone holding only the
    /// thing everybody is issued is yes. The shovel is still *fired* — it is
    /// `choose_weapon`'s best option inside its reach — it just is not what being
    /// armed means.
    pub(super) fn has_firable_weapon(&self, world: &World) -> bool {
        let Some(me) = world.player(self.player) else {
            return false;
        };
        (0..INVENTORY_SLOTS as u8).any(|slot| {
            me.inventory.slot(slot).is_some_and(|stack| {
                def(stack.item).is_some_and(|d| match d.kind {
                    ItemKind::Weapon(wid) => {
                        let Some(w) = crate::weapons::defs::def(wid) else {
                            return false;
                        };
                        if matches!(w.delivery, Delivery::Melee { .. }) {
                            return false;
                        }
                        w.energy_cost <= 0.0 || me.battery >= w.energy_cost
                    }
                    _ => false,
                })
            })
        })
    }

    pub(super) fn should_fire(
        &mut self,
        world: &World,
        me: &crate::player::state::PlayerState,
        pos: Vec2,
        target: Vec2,
        now: f32,
    ) -> bool {
        // **A rider fires the platform, so judge the platform's gun** (T21.43).
        //
        // `World::fire` sends a mounted player's trigger to the platform, but
        // everything below asks about the *bag*: the rider's own `fire_ready_at`,
        // and the selected weapon's reach. With §F5's shovel in hand that meant a
        // mounted bot refused every target outside a swing, and never fired the
        // machine gun it was sitting on. So a rider asks the platform's questions
        // — its clock (the same guard `fire_platform` uses), its magazine, its
        // range — and line of sight, which is not about the weapon.
        //
        // The clock is asked so a holding bot sends one `fire` per round rather
        // than one per tick with every other one refused; an empty magazine stops
        // it pressing at all, so it does not hold forever at nothing.
        if let Some(plat) = me.mount.mounted {
            if !world.platform_ready(plat, now) {
                self.stats.rej_cooldown += 1;
                return false;
            }
            if world.platform_ammo(plat).unwrap_or(0) == 0 {
                self.stats.rej_unarmed += 1;
                return false;
            }
            if (target - pos).len() > crate::constants::GUN_PLATFORM_RANGE {
                self.stats.rej_range += 1;
                return false;
            }
            if !self.reachable(world, pos, target) {
                self.stats.rej_los += 1;
                return false;
            }
            return true;
        }
        if now < me.fire_ready_at {
            self.stats.rej_cooldown += 1;
            return false;
        }
        let Some(item) = self.selected_weapon(world) else {
            self.stats.rej_unarmed += 1;
            return false;
        };
        let Some(d) = def(item) else {
            self.stats.rej_unarmed += 1;
            return false;
        };
        let ItemKind::Weapon(wid) = d.kind else {
            self.stats.rej_unarmed += 1;
            return false;
        };
        let Some(w) = crate::weapons::defs::def(wid) else {
            self.stats.rej_unarmed += 1;
            return false;
        };

        let dist = (target - pos).len();
        // A weapon that leaves a zone is dangerous well past its blast radius:
        // the fire outlives the explosion and the thrower walks into it. Guard
        // on the zone's own reach, not on `blast_radius`, which is 0 for these.
        // T23.26D item 3: an arcing weapon fires only along a solved arc (`think` aims
        // it, `lob`); none that reaches is a held fire, not a throw at the chord.
        let arcs = matches!(w.delivery, Delivery::Projectile { .. })
            && w.gravity_scale * world.gravity.scale() > 0.0;
        if arcs && self.lob.is_none() {
            self.stats.rej_arc += 1;
            return false;
        }
        // Along a solved arc the landing is the target's (that is what solved means), so
        // of the zone guard only "too close" is left to ask.
        // T99.04 (promo, `DEV_BOT_ARSENAL`): the rotation's bot is reckless — no self-safety
        // refusal (blast guard, too close, landing on itself); reach and sight still hold —
        // a flamethrower sprayed at any range walled a whole shot in fire (measured on film).
        let reckless = self.arsenal.is_some();
        let refusal = match self.lob.filter(|_| arcs) {
            Some(_) => {
                zone_refusal(world, w, wid, pos, target).filter(|r| *r == ZoneRefusal::TooClose)
            }
            None => zone_refusal(world, w, wid, pos, target),
        };
        match refusal.filter(|_| !reckless) {
            Some(ZoneRefusal::TooClose) => {
                self.stats.rej_blast_guard += 1;
                return false;
            }
            Some(ZoneRefusal::Landing) => {
                self.stats.rej_impact_guard += 1;
                return false;
            }
            None => {}
        }
        // **Melee is not a blast and its range is not `range`.** For a swing,
        // `blast_radius` is the carve at the *tip* of the arc — `melee::swing`
        // skips the owner outright, so no swing can ever hurt the swinger — and
        // the distance it can hit from lives in `Delivery::Melee`, leaving
        // `range` at 0.0. Run the two guards below unchanged on a shovel and a
        // bot refuses everything inside 21 px as a self-blast and accepts
        // everything outside 28 px as in range: it swings at air across the map
        // and never at anyone it could actually hit. §F5 made that universal by
        // issuing one to every player. Both are `blast_radius`/`range` meaning a
        // second thing for one delivery kind.
        if let Delivery::Melee { reach, .. } = w.delivery {
            if dist > crate::weapons::melee::effective_reach(reach) {
                self.stats.rej_range += 1;
                return false;
            }
        } else {
            // Never fire at something inside our own blast radius: a bot that
            // rockets its own feet is not a difficulty setting, it is a bug that
            // looks like one.
            if !reckless && w.blast_radius > 0.0 && dist < w.blast_radius * BOT_BLAST_GUARD {
                self.stats.rej_blast_guard += 1;
                return false;
            }
            if w.range > 0.0 && dist > w.range {
                self.stats.rej_range += 1;
                return false;
            }
            // T23.26D: a stream reaches as far as it does, and no further.
            if matches!(w.delivery, Delivery::Flames { .. }) && dist > stream_reach() {
                self.stats.rej_range += 1;
                return false;
            }
        }

        // Line of sight. A weapon that carves 42 px treats a hill as cover to
        // remove rather than a wall to walk around, so the tolerance is
        // generous — but it stays a *count*, not a distance test: a
        // near-the-muzzle guard was measured and refused 87 % of the shots the
        // count allows, because a bot standing on the ground has rock within
        // 28 px of its muzzle almost always.
        if !self.reachable(world, pos, target) {
            self.stats.rej_los += 1;
            return false;
        }
        true
    }

    /// Whether a straight line from `from` to `to` is clear enough to matter.
    ///
    /// **One implementation, two callers**, because a second copy of this rule
    /// would be a second answer to "can I get at that" — and `should_fire` and
    /// item choice would drift apart the first time either was tuned
    /// (`CLAUDE.md`: share the guard, or share the function).
    ///
    /// The tolerance is deliberately generous and it is a **count**, not a
    /// distance: every weapon in this game digs (§A3), so rock between you and a
    /// target is soft cover rather than a wall, and a near-the-muzzle guard was
    /// measured refusing 87 % of the shots this allows. The same generosity is
    /// right for items for a different reason — a bot walks over hills, and a
    /// straight line clips every one of them, so anything stricter would reject
    /// items on the far side of ordinary ground.
    pub(super) fn reachable(&self, world: &World, from: Vec2, to: Vec2) -> bool {
        let dist = (to - from).len();
        let steps = (dist / BOT_LOS_STEP).ceil() as u32;
        let mut blocked = 0u32;
        for i in 1..steps {
            let t = i as f32 / steps as f32;
            let p = from + (to - from) * t;
            if crate::physics::collide::solid_at(&world.map, p.x as i32, p.y as i32) {
                blocked += 1;
                if blocked > BOT_LOS_MAX_BLOCKED {
                    return false;
                }
            }
        }
        true
    }

    /// Pick the best **firable** weapon slot, or `None` to keep the current one.
    ///
    /// "Firable" is the same rule `selected_weapon` uses, so an energy weapon with
    /// a flat battery scores nothing and the bot moves off it — which is the half
    /// that was missing. A weapon out of range still scores, just lower: walking
    /// closer with a bazooka beats standing still with nothing.
    pub(super) fn choose_weapon(
        &self,
        world: &World,
        me: &crate::player::state::PlayerState,
        target: Vec2,
        pos: Vec2,
    ) -> Option<u8> {
        let dist = (target - pos).len();
        let mut best: Option<(f32, u8)> = None;
        // T23.26D item 2 (owner: *"shovels are a last resort when no ranged weapons
        // are available"*): melee is a choice only when nothing ranged in the bag can
        // fire. Scored on dps it won at point blank (a shovel's 54 against a pistol's
        // 50), and holding it shortened `hold_off` to its reach, which closed the bot in
        // further: 55.6 % of fighting ticks with the shovel in hand while a loaded gun
        // sat in the bag (measured, 8 seeds).
        let mut best_ranged: Option<(f32, u8)> = None;
        // T23.26F (`docs/78` §A6, *"stop shoveling"*): and any firable ranged weapon at all,
        // marked down or not, beats the shovel **out of its reach**. A flamethrower or a
        // grenade out of its band scored the shovel's own out-of-reach mark-down and lost the
        // tie to slot 0: 36.6 % of engaged ticks had the shovel in hand with a ranged weapon
        // firable (measured, 8 seeds). The swing is for point blank.
        let mut any_ranged: Option<(f32, u8)> = None;
        let mut melee_reach = 0.0f32;
        // T99.04 (promo): every ranged slot in its band, in slot order, for the rotation.
        let mut band: Vec<u8> = Vec::new();
        for slot in 0..INVENTORY_SLOTS as u8 {
            let Some(stack) = me.inventory.slot(slot) else {
                continue;
            };
            let Some(d) = def(stack.item) else { continue };
            let ItemKind::Weapon(wid) = d.kind else {
                continue;
            };
            let Some(w) = crate::weapons::defs::def(wid) else {
                continue;
            };
            // Can it be fired *right now*? Energy needs charge; everything else
            // needs a stack, which the inventory guarantees by holding it.
            if w.energy_cost > 0.0 && me.battery < w.energy_cost {
                continue;
            }
            // Damage per second is the axis that matters; a weapon that cannot
            // reach the target, or whose blast would catch us, is heavily
            // penalised but not disqualified — it is still better than nothing.
            let dps = match w.delivery {
                Delivery::Flames { .. } => stream_dps(),
                _ => zone_rate(w).unwrap_or(w.damage / w.cooldown.max(0.01)),
            };
            let mut score = dps;
            // How far this weapon can actually hit from. **Melee carries its
            // range in `Delivery`, not in `range`** (§F5): `w.range` is 0.0 for a
            // swing, so before the shovel existed the penalty below never applied
            // to melee and a bot scored a 54 dps shovel above every gun in the
            // game from any distance. It cost nothing while melee was a rare
            // pickup; every player spawning with one made it the default.
            // `effective_reach` because that is the number the hit test uses.
            let reach = match w.delivery {
                Delivery::Melee { reach, .. } => crate::weapons::melee::effective_reach(reach),
                Delivery::Flames { .. } => stream_reach(),
                _ => w.range,
            };
            if reach > 0.0 && dist > reach {
                score *= BOT_OUT_OF_REACH_SCORE;
            }
            // The self-blast penalty, and **not for melee**: a swing's
            // `blast_radius` is the carve at the tip of the arc and `swing` skips
            // the owner, so it can never catch the swinger. `should_fire` makes
            // the same distinction, for the same reason — the two must agree, or
            // a bot selects a weapon it will then refuse to use.
            let self_blast = !matches!(w.delivery, Delivery::Melee { .. });
            if self_blast && w.blast_radius > 0.0 && dist < w.blast_radius * BOT_BLAST_GUARD {
                score *= BOT_REFUSED_SCORE;
            }
            // T22.03C: and a zone weapon `should_fire` would refuse to throw from
            // here — **the same guard, called, not copied** (`zone_refusal`): too
            // close, or the arc lands on us or nowhere. Scored only on the distance
            // at first, bots held a molotov they could not throw for 4.7 % of their
            // lives and standard kills fell 14 % (96 seeds, measured).
            if zone_refusal(world, w, wid, pos, target).is_some() {
                score *= BOT_REFUSED_SCORE;
            }
            // T23.26D: an arc that cannot reach the target at any launch angle.
            if !lob_reaches(world, w, pos, target) {
                score *= BOT_OUT_OF_REACH_SCORE;
            }
            if best.is_none_or(|(bs, _)| score > bs) {
                best = Some((score, slot));
            }
            // In its band: ranged, and nothing above marked it down.
            if let Delivery::Melee { reach, .. } = w.delivery {
                melee_reach = melee_reach.max(crate::weapons::melee::effective_reach(reach));
            } else if any_ranged.is_none_or(|(bs, _)| score > bs) {
                any_ranged = Some((score, slot));
            }
            let in_band = !matches!(w.delivery, Delivery::Melee { .. }) && score >= dps;
            if in_band && best_ranged.is_none_or(|(bs, _)| score > bs) {
                best_ranged = Some((score, slot));
            }
            // T99.04 (promo): the rotation's band is **reach only** — a reckless bot (1000 health
            // in the trailer) fires its rocket at point blank and its flamethrower into its own
            // fire, which every refusal above exists to stop in a real round. Nothing placed:
            // a mine on the ground is not a shot.
            let reaches = reach <= 0.0 || dist <= reach;
            // Nor what leaves a lasting cloud or a carpet of fire (smoke, toxic, molotov): on
            // film three of them walled the whole fight off within seconds (measured).
            let placed = matches!(w.delivery, Delivery::Placed { .. })
                || (!matches!(w.delivery, Delivery::Flames { .. })
                    && zone_reach(w, world.gravity).is_some())
                || w.damage <= 0.0 && !matches!(w.delivery, Delivery::Flames { .. });
            if self.arsenal.is_some()
                && reaches
                && !placed
                && !matches!(w.delivery, Delivery::Melee { .. })
            {
                band.push(slot);
            }
        }
        // T99.04 (promo, `DEV_BOT_ARSENAL`): not the best weapon but the one this bot's
        // turn in the rotation names — still only from the band, so nothing it would
        // refuse to fire or could not reach.
        // By **kind** (gun, laser, flame, arc, rocket), not by slot: five guns in a row would be
        // ten seconds of muzzle flash, and five bots offset by seat over five kinds is every
        // kind at once. Within a kind, the slots take turns too.
        if let (Some(offset), false) = (self.arsenal, band.is_empty()) {
            let turn = (world.round_time / crate::constants::BOT_ARSENAL_ROTATE).max(0.0) as usize;
            let kind_of = |slot: u8| me.inventory.slot(slot).and_then(|s| weapon_kind(s.item));
            let mut kinds: Vec<usize> = band.iter().filter_map(|s| kind_of(*s)).collect();
            kinds.sort_unstable();
            kinds.dedup();
            let mut k = (turn + offset as usize) % kinds.len().max(1);
            // The stream's fire lingers on the ground long after the turn: held every round it
            // carpeted the whole shot (measured on film), so it is one short burst
            // (`BOT_ARSENAL_FLAME_BURST`) on one pass in `BOT_ARSENAL_FLAME_EVERY`.
            let flame = WEAPON_KINDS.iter().position(|n| *n == "flame");
            let into_turn = world
                .round_time
                .rem_euclid(crate::constants::BOT_ARSENAL_ROTATE);
            let flame_pass = (turn / kinds.len().max(1))
                .is_multiple_of(crate::constants::BOT_ARSENAL_FLAME_EVERY);
            if kinds.get(k).copied() == flame
                && !(flame_pass && into_turn < crate::constants::BOT_ARSENAL_FLAME_BURST)
            {
                k = (k + 1) % kinds.len();
            }
            let of_kind: Vec<u8> = band
                .iter()
                .copied()
                .filter(|s| kind_of(*s) == kinds.get(k).copied())
                .collect();
            if let Some(slot) = of_kind
                .get((turn / kinds.len().max(1)) % of_kind.len().max(1))
                .copied()
            {
                return (slot != me.inventory.selected()).then_some(slot);
            }
        }
        // T23.26D item 2: a ranged weapon that can fire from here beats any swing.
        let point_blank = dist <= melee_reach;
        let best = best_ranged.or(any_ranged.filter(|_| !point_blank)).or(best);
        // Only ask for a change: `select_slot` on the slot already held is a
        // no-op, but reporting it every tick makes the intent unreadable.
        best.and_then(|(_, slot)| (slot != me.inventory.selected()).then_some(slot))
    }

    /// **Takes only what it reads.** It used to take `world` and `pos` for a
    /// threat scan that had no reader; keeping them "in case" is how the scan
    /// stayed alive through a review.
    pub(super) fn choose_item(&self, me: &crate::player::state::PlayerState) -> Option<u8> {
        let hurt = me.health < BOT_HEAL_BELOW;

        for slot in 0..INVENTORY_SLOTS as u8 {
            let Some(stack) = me.inventory.slot(slot) else {
                continue;
            };
            let Some(d) = def(stack.item) else { continue };
            match d.kind {
                ItemKind::Heal { .. } if hurt => return Some(slot),
                _ => {}
            }
        }
        // Charge when low (§B5). Without this a bot picks up a battery pack, never
        // uses it, and any energy weapon it is holding stays a paperweight —
        // while both occupy slots a working weapon would fill. That is not
        // hypothetical: adding the battery and the lasers with no rule here took
        // bot rounds from fighting to `ticks_engaged: 0`, because a bot holding an
        // uncharged laser is permanently unarmed and permanently shopping.
        if me.battery <= BATTERY_MAX * BOT_CHARGE_BELOW {
            for slot in 0..INVENTORY_SLOTS as u8 {
                let Some(stack) = me.inventory.slot(slot) else {
                    continue;
                };
                let Some(d) = def(stack.item) else { continue };
                if matches!(d.kind, ItemKind::Battery { .. }) {
                    return Some(slot);
                }
            }
        }
        // **No shield branch** (T20.08), and the decision is worth stating rather
        // than leaving as a deletion. This used to be "am I threatened and is my
        // shield down? then select the generator and use it". Under the new rule
        // a generator protects you **while it is in the bag** and `use_item`
        // refuses it, so the branch was not merely broken by the field going
        // away — it was meaningless: a bot that "used" a generator would spend a
        // decision doing nothing, and selecting it would put an unarmed slot in
        // its hand in the middle of a fight.
        //
        // **A bot with a generator is already shielded**, and the charge branch
        // above is what keeps it that way — the battery is the shield's ammunition
        // now, so "charge when low" is the shield behaviour as well as the laser
        // one. Picking generators up is `wants_item`'s business and is unchanged;
        // there is nothing left to do with one once it is held.
        //
        // **And `threatened` is gone with it.** That comment used to say it was
        // "still read by the caller above"; it was not read anywhere, so what it
        // guarded was a `let _ =` over an O(players) distance scan running on
        // every bot decision tick. `SHIELD_WITHIN` went with it — a constant
        // named for a mechanic that no longer exists is the same shape this
        // commit's parent correctly refused to leave behind for `SHIELD_DURATION`.
        None
    }
}

/// The radius a `Burst::Zone` weapon actually denies, or `None` if it leaves
/// nothing behind.
///
/// `blast_radius` is 0 for these — the zone *is* the weapon — so a guard written
/// against `blast_radius` never fires for exactly the weapons that need one.
pub(super) fn zone_reach(w: &crate::weapons::defs::WeaponDef, gravity: GravityMode) -> Option<f32> {
    match w.burst {
        crate::weapons::defs::Burst::Zone {
            radius, scatter, ..
        } => Some(radius + scatter),
        // §F10.2. **The molotov's reach had to be re-derived or the regression
        // is silent.** It used to be `Burst::Zone`'s `radius + scatter`; a
        // molotov that is now `Burst::Flames` would fall through to
        // `w.blast_radius`, which is **0.0** for it, and `stand_off`'s `.max(40)`
        // floor would put a bot 40 px from a fire it had just thrown. That is
        // exactly the bug the comment on `stand_off` records having already been
        // fixed once.
        //
        // Derived from the burst and the flame's own physics, not from a new
        // constant: flames leave the impact at `speed` into an upward half-turn
        // and fall under `GRAVITY * FLAME_GRAVITY_SCALE`, so the crowd's spread
        // is the ballistic range `v^2 / g` of the fastest of them.
        //
        // `speed * FLAME_LIFE / 2` was the first attempt and it is **wrong by
        // 2.7x** — 560 px against a measured spread of about 100 — because a
        // flame spends most of `FLAME_LIFE` on the ground, not in the air. A bot
        // with that number refused every throw: the blast guard rejected 120
        // ticks out of 120 at a target 260 px away.
        //
        // **And the match's gravity divides it** (T22.02). This is the fourth
        // production reader of `GRAVITY` and the only one that does not
        // integrate: halve gravity and a flame's real ballistic range
        // *doubles*, so a stand-off derived from the unscaled constant puts a
        // bot inside the fire it just threw. The 2.7x paragraph above is what
        // that costs when this number is wrong.
        //
        // **And the flame's own lifetime bounds it** (T22.03). The ballistic
        // range above is `v^2/g`, which goes to `inf` as the match's gravity
        // goes to zero — and `GravityMode::Space` answers exactly `0.0`. A
        // flame that never falls is not a flame with infinite reach: it is one
        // that travels at `speed` until `FLAME_LIFE` expires, so
        // `speed * FLAME_LIFE` is the other bound and the real reach is
        // whichever binds first. Written as a `min` rather than as a zero-g
        // branch, because the lifetime bound is true under **every** gravity —
        // it simply never binds at standard, where the ballistic range is
        // ~99 px against a ~1100 px lifetime range.
        //
        // **The number this produces in space is a finding, not a design.** At
        // `MOLOTOV_FLAME_SPEED` 220 and `FLAME_LIFE` 5 s it is ~1100 px, which
        // is over half the width of a Small map, so a bot carrying a molotov in
        // space keeps a stand-off it can essentially never satisfy and never
        // throws. That is a *behavioural* call and it belongs to
        // `T22.03B — bots in space`, which records it; what belongs here is
        // only that the division is safe and the value is derived.
        //
        // **T22.03C (R95): in space the lifetime bound is not the stand-off.**
        // 1110 px refused every throw inside `BOT_ENGAGE_RANGE`, so a bot held a molotov it
        // could never use. The ruling: not the 137.5 px ring-gap distance, but the
        // stand-off at which a thrower is hit by its own fire **no more often than in
        // standard mode**, measured — `BOT_SPACE_ZONE_REACH`, whose basis is there.
        // A branch on the mode rather than a third `min`: the measured number is a
        // behavioural one for zero-g, and as a `min` it would bind Low gravity too.
        crate::weapons::defs::Burst::Flames { speed, .. } => {
            let ballistic = speed * speed / (GRAVITY * FLAME_GRAVITY_SCALE * gravity.scale());
            let reach = (BOT_FLAME_REACH_SCALE * ballistic).min(speed * FLAME_LIFE) + FLAME_RADIUS;
            Some(if gravity == GravityMode::Space {
                BOT_SPACE_ZONE_REACH
            } else {
                reach
            })
        }
        _ => None,
    }
}

/// Why a zone weapon may not be thrown from `pos` at `target`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum ZoneRefusal {
    /// The target is inside the hazard's reach (+ `BOT_HAZARD_CLEARANCE`).
    TooClose,
    /// The arc lands inside that reach of us, nowhere within `BOT_PREDICT_TICKS`, or
    /// (zero-g) somewhere that never reaches the target.
    Landing,
}

/// **The zone-weapon throw guard, in one place** (T22.03C): `should_fire` refuses on
/// it and `choose_weapon` scores by it, so a bot never selects what it will not
/// throw. `None` for a weapon that leaves no zone, or a throw that is fine.
///
/// A weapon that leaves a zone is dangerous well past its blast radius: the fire
/// outlives the explosion and the thrower walks into it, so the target-distance
/// check uses the zone's own reach, not `blast_radius` (0 for these). And T11.15,
/// §B26: a molotov is ballistic — thrown uphill or into a rise it falls short, onto
/// the thrower — so the arc is walked and the landing asked too. **`None` from
/// `predict_impact` ("still flying after the cap") is a refusal** — not knowing where
/// it lands is not a reason to throw it; R95 rejects reading it as "reaches the
/// target", which in zero-g is a straight flight past a floating enemy.
pub(super) fn zone_refusal(
    world: &World,
    w: &crate::weapons::defs::WeaponDef,
    wid: crate::items::registry::WeaponId,
    pos: Vec2,
    target: Vec2,
) -> Option<ZoneRefusal> {
    zone_refusal_at(world, w, wid, pos, target, (target - pos).angle())
}

/// [`zone_refusal`] for a throw launched at `aim` — the solved arc (T23.26D), not the
/// chord to the target.
pub(super) fn zone_refusal_at(
    world: &World,
    w: &crate::weapons::defs::WeaponDef,
    wid: crate::items::registry::WeaponId,
    pos: Vec2,
    target: Vec2,
    aim: f32,
) -> Option<ZoneRefusal> {
    let reach = zone_reach(w, world.gravity)?;
    if (target - pos).len() < reach + BOT_HAZARD_CLEARANCE {
        return Some(ZoneRefusal::TooClose);
    }
    let landing = crate::weapons::projectile::predict_impact(
        &world.map,
        wid,
        pos,
        aim,
        world.wind,
        world.gravity,
        BOT_PREDICT_TICKS,
        crate::constants::SIM_DT,
    );
    // **In zero-g it must also reach the target.** The flight is a straight line, so
    // a toxic grenade (no contact burst) flies on through the target for its whole
    // fuse (~960 px) and a molotov only bursts on the target if the line passes
    // through its body — "not on me" alone let space bots spend their throws on empty
    // space (space kills −12 %, paired over 96 seeds, measured). Under gravity the
    // arc is not the chord and T11.15's guard is kept as it was.
    let reaches = |at: Vec2| {
        if world.gravity.scale() > 0.0 || (at - target).len() <= reach {
            return true;
        }
        let contact = matches!(
            w.delivery,
            crate::weapons::defs::Delivery::Projectile {
                explode_on_contact: true,
                ..
            }
        );
        let seg = at - pos;
        let t = ((target - pos).dot(seg) / seg.dot(seg).max(f32::EPSILON)).clamp(0.0, 1.0);
        contact && (pos + seg * t - target).len() <= crate::constants::PLAYER_W
    };
    match landing {
        Some(at) if (at - pos).len() >= reach + BOT_HAZARD_CLEARANCE && reaches(at) => None,
        _ => Some(ZoneRefusal::Landing),
    }
}

/// T22.03C (`M22-RULINGS` R95): what a zone weapon is worth to `choose_weapon`, on
/// the same per-trigger-pull axis as `damage / cooldown` — **the damage its hazard
/// can deal one target over the hazard's life**, per cooldown: a molotov's flame
/// `FLAME_DPS × FLAME_LIFE`, a toxic cloud's `dps × duration`. `damage / cooldown`
/// is 0 for both (their harm is the hazard), which is why no bot ever threw one.
/// `None` for everything else, **smoke included**: it deals no damage at all, so
/// area damage over time gives it nothing and it stays unselected (checked, R95).
pub(super) fn zone_rate(w: &crate::weapons::defs::WeaponDef) -> Option<f32> {
    let per_throw = match w.burst {
        crate::weapons::defs::Burst::Flames { .. } => FLAME_DPS * FLAME_LIFE,
        crate::weapons::defs::Burst::Zone { dps, duration, .. } => dps * duration,
        _ => return None,
    };
    Some(per_throw / w.cooldown.max(0.01))
}

#[cfg(test)]
mod tests {
    use super::super::tests::*;
    use super::*;

    /// Where a molotov's target goes: **below** the thrower, 260 px out — a molotov's
    /// level range (`v² / g`, 158 px) is inside its own fire's reach (207 px), so no
    /// level throw is safe and a bot that aims along a real arc (T23.26D) holds it; the
    /// old fixture "threw" 260 px on the level only by aiming the chord from mid-air.
    /// The drop is what the ballistic discriminant needs to reach that far, plus a
    /// body; the air between is carved so the arc is the only question.
    fn molotov_target(w: &mut World, at: Vec2) -> Vec2 {
        let wd =
            crate::weapons::defs::def(crate::items::registry::WEAPON_MOLOTOV).expect("molotov");
        let (v, g, x) = (wd.muzzle_speed, GRAVITY * wd.gravity_scale, 260.0f32);
        let drop = (g * g * x * x - v.powi(4)) / (2.0 * g * v * v) + crate::constants::PLAYER_H;
        let to = Vec2::new(at.x + x, at.y + drop);
        for y in (at.y as i32 - 120)..(to.y as i32 + 40) {
            w.map.mask.clear_run(y, at.x as i32 - 20, to.x as i32 + 40);
        }
        w.map.coarse = crate::map::coarse::CoarseGrid::build(&w.map.mask);
        to
    }

    /// The space fixtures below search "well inside the arena, off the rim": within
    /// this share of the way from the centre to the rim, by the rim predicate's own
    /// `SpaceGeometry::norm` (T22.17 — they carried the ellipse's formula as a copy).
    const WELL_INSIDE: f32 = 0.6;

    /// T22.02 — the flame stand-off follows the match's gravity.
    ///
    /// **This is the reader of `GRAVITY` that does not integrate**, so no
    /// physics test can reach it and nothing else in the fast suite would
    /// report it being left at standard gravity. Halve gravity and a flame's
    /// real ballistic range doubles; a stand-off that did not follow puts a bot
    /// inside the fire it just threw, and the only visible symptom is a
    /// self-damage number with nothing pointing at its cause.
    ///
    /// **Asserted as an inequality and a bracket, not as an equality against
    /// `1.0 / LOW_GRAVITY_SCALE`** — that expression is the implementation, and
    /// a test that writes it out again passes with the implementation wrong in
    /// any way the copy is wrong too. What is claimed here is the *direction*
    /// and that the change is large enough to matter: the molotov's stand-off
    /// has to move by more than its own `FLAME_RADIUS`, or a bot would stand in
    /// the same place under both modes.
    ///
    /// The zone weapon beside it is the control: `Burst::Zone`'s reach is
    /// `radius + scatter` off the table and has nothing ballistic in it, so it
    /// must **not** move — a gravity multiplier applied to the wrong arm of
    /// `zone_reach` would turn that half red.
    #[test]
    fn the_flame_stand_off_follows_the_match_gravity_and_the_zone_one_does_not() {
        let flames = crate::items::registry::def(MOLOTOV)
            .and_then(|d| match d.kind {
                ItemKind::Weapon(wid) => crate::weapons::defs::def(wid),
                _ => None,
            })
            .expect("the molotov's weapon def");
        assert!(
            matches!(flames.burst, crate::weapons::defs::Burst::Flames { .. }),
            "the molotov is no longer a `Burst::Flames` — this test is measuring \
             a different arm of `zone_reach` than the one it names"
        );

        let std = zone_reach(flames, GravityMode::Standard).expect("a flame reach");
        let low = zone_reach(flames, GravityMode::Low).expect("a flame reach");
        assert!(
            low > std + FLAME_RADIUS,
            "the flame stand-off moved from {std:.0} px to {low:.0} px under low \
             gravity — less than a {FLAME_RADIUS} px flame, so a bot stands in \
             the same place in both modes while the fire spreads twice as far"
        );

        // The control, on the other arm of the same function.
        let zone = crate::items::registry::def(crate::items::registry::TOXIC_GRENADE)
            .and_then(|d| match d.kind {
                ItemKind::Weapon(wid) => crate::weapons::defs::def(wid),
                _ => None,
            })
            .expect("the toxic grenade's weapon def");
        assert_eq!(
            zone_reach(zone, GravityMode::Standard),
            zone_reach(zone, GravityMode::Low),
            "a `Burst::Zone` reach is `radius + scatter` off the table and has no \
             ballistic term — gravity must not touch it"
        );
    }

    /// **Space's `zone_reach` is the measured stand-off, and the lifetime bound
    /// binds no shipping mode** (T22.03 review, R44's neighbour; T22.03C, R95;
    /// T22.03E F2).
    ///
    /// Before T22.03C space answered the `speed · FLAME_LIFE` lifetime bound,
    /// 1110 px, which refused every throw inside `BOT_ENGAGE_RANGE`; R95 replaced it with
    /// `BOT_SPACE_ZONE_REACH`, measured. Under gravity the ballistic term
    /// `v²/(GRAVITY · FLAME_GRAVITY_SCALE · scale)` is scaled by
    /// `BOT_FLAME_REACH_SCALE` (the thrower's own-hit measurement) and still halves
    /// with the scale: **Standard 207.6 px, Low 405.1 px, Space 100 px**. The
    /// lifetime `min` binds in no shipping mode now (Low's scaled term is 415 px);
    /// it stays as the finite bound for a future mode whose scale nears zero, and
    /// Low's term staying under it is asserted (the doc's claim).
    #[test]
    fn zone_reach_in_space_is_the_measured_stand_off_and_the_lifetime_bound_binds_no_mode() {
        use crate::constants::{GravityMode, FLAME_LIFE};

        let flames = crate::items::registry::def(MOLOTOV)
            .and_then(|d| match d.kind {
                ItemKind::Weapon(wid) => crate::weapons::defs::def(wid),
                _ => None,
            })
            .expect("the molotov's weapon def");
        let speed = match flames.burst {
            crate::weapons::defs::Burst::Flames { speed, .. } => speed,
            _ => panic!(
                "the molotov is no longer a `Burst::Flames` — this test is \
                 measuring a different arm of `zone_reach`"
            ),
        };
        // (T22.03E F2: a loop over `GravityMode::ALL` asserting every reach finite and
        // under the lifetime bound stood here. It could not fail: the one mode whose
        // scale reaches zero answers a constant, and the others are under the `min` by
        // construction. What can move is asserted below — the lifetime bound itself.)
        let low_ballistic = BOT_FLAME_REACH_SCALE * speed * speed
            / (GRAVITY * FLAME_GRAVITY_SCALE * GravityMode::Low.scale());
        assert!(
            low_ballistic < speed * FLAME_LIFE,
            "low's scaled ballistic term {low_ballistic:.1} px now passes the lifetime bound \
             — the `min` binds a shipping mode, and this doc comment is wrong"
        );
        let std = zone_reach(flames, GravityMode::Standard).expect("a flame reach");
        let low = zone_reach(flames, GravityMode::Low).expect("a flame reach");
        let space = zone_reach(flames, GravityMode::Space).expect("a flame reach");
        assert_eq!(
            space, BOT_SPACE_ZONE_REACH,
            "space: the molotov stand-off is {space} px, not R95's measured one"
        );
        let ballistic = speed * speed / (GRAVITY * FLAME_GRAVITY_SCALE);
        assert!(
            (std - (BOT_FLAME_REACH_SCALE * ballistic + FLAME_RADIUS)).abs() < 0.01 && std < low,
            "standard {std:.2} px is not the scaled ballistic term, or not under low's \
             {low:.2}"
        );
    }

    /// T22.03C (R95): **a zone weapon scores its area damage over time**, so a bot
    /// selects a molotov or a toxic grenade over the out-of-reach shovel (the
    /// arsenal's floor, 54.5 × 0.25), and **smoke scores nothing** — it deals no
    /// damage. Control: `damage / cooldown`, the old score, is 0 for all three.
    #[test]
    fn zone_weapons_score_their_hazard_and_smoke_scores_nothing() {
        use crate::constants::{SHOVEL_COOLDOWN, SHOVEL_DAMAGE};
        use crate::items::registry::{SMOKE, TOXIC_GRENADE};
        let wdef = |item| {
            crate::items::registry::def(item)
                .and_then(|d| match d.kind {
                    ItemKind::Weapon(wid) => crate::weapons::defs::def(wid),
                    _ => None,
                })
                .expect("a weapon def")
        };
        let floor = SHOVEL_DAMAGE / SHOVEL_COOLDOWN * BOT_OUT_OF_REACH_SCORE;
        for item in [MOLOTOV, TOXIC_GRENADE] {
            let w = wdef(item);
            assert_eq!(w.damage, 0.0, "control: {} does damage itself", w.key);
            let rate = zone_rate(w).unwrap_or(0.0);
            assert!(
                rate > floor,
                "{}: scores {rate:.1}, under the out-of-reach shovel's {floor:.1}",
                w.key
            );
        }
        let smoke = wdef(SMOKE);
        assert!(
            zone_rate(smoke).is_none() && smoke.damage == 0.0,
            "smoke scores {:?}",
            zone_rate(smoke)
        );
    }

    /// T22.03C (R95, and the task's Done-when): **a bot holding a molotov in space
    /// throws it** at an enemy between its stand-off and `BOT_ENGAGE_RANGE` — floating in
    /// front of a rock, so the straight zero-g flight bursts on it. With the old
    /// 1110 px lifetime reach every such throw was refused (planted: red). Control:
    /// the same bot with the enemy in open space, nothing behind it — the flight
    /// never lands (`predict_impact` → `None`), which R95 refuses to read as
    /// "reaches".
    #[test]
    fn a_space_bot_throws_a_molotov_at_an_enemy_in_front_of_a_rock() {
        use crate::constants::{MapScale, DEFAULT_MAP_GENERATOR, PLAYER_W};
        let mut w = World::with_gravity(
            SEED,
            MapScale::Small,
            0,
            DEFAULT_MAP_GENERATOR,
            GravityMode::Space,
        );
        w.set_phase(RoundPhase::Playing);
        w.add_player(1, 0, "thrower".into());
        w.add_player(2, 0, "target".into());
        give(&mut w, 1, MOLOTOV, 2);
        wield(&mut w, 1, MOLOTOV);
        let clear = |w: &World, p: Vec2| {
            !crate::physics::collide::aabb_overlaps_solid(
                &w.map,
                crate::physics::body::Body::new(p).aabb(),
            )
        };
        let d = (BOT_SPACE_ZONE_REACH + BOT_HAZARD_CLEARANCE + BOT_ENGAGE_RANGE) * 0.5;
        let wid = crate::items::registry::def(MOLOTOV)
            .and_then(|d| match d.kind {
                ItemKind::Weapon(wid) => Some(wid),
                _ => None,
            })
            .expect("the molotov's weapon id");
        // A target a body's width in front of a rock face to its right, and a
        // thrower `d` to its left along clear air — **and the throw at it lands on
        // that rock** (T22.17). The body-box test alone accepted a rock whose top
        // sat below the throw line: the map moved under R103/R104 and the search's
        // first hit became a graze the molotov flew over (`predict_impact` None, the
        // bot rightly refusing 120 of 120 ticks).
        let lands_by = |from: Vec2, t: Vec2| {
            crate::weapons::projectile::predict_impact(
                &w.map,
                wid,
                from,
                (t - from).angle(),
                w.wind,
                w.gravity,
                BOT_PREDICT_TICKS,
                SIM_DT,
            )
            .is_some_and(|at| (at - t).len() <= PLAYER_W * 4.0)
        };
        let geo = w.map.space_geometry().expect("space");
        let (target, thrower) = (0..w.map.mask.h as i32)
            .step_by(8)
            .flat_map(|y| (0..w.map.mask.w as i32).step_by(8).map(move |x| (x, y)))
            .map(|(x, y)| Vec2::new(x as f32, y as f32))
            .filter(|p| geo.norm(p.x, p.y) < WELL_INSIDE)
            .find_map(|t| {
                let rock = !clear(&w, t + Vec2::new(PLAYER_W * 2.0, 0.0));
                let from = t - Vec2::new(d, 0.0);
                let open = (0..=(d / 4.0) as i32)
                    .all(|k| clear(&w, from + Vec2::new(k as f32 * 4.0, 0.0)));
                (rock && open && lands_by(from, t)).then_some((t, from))
            })
            .expect("a rock face with clear air in front of it");
        let throws = |w: &mut World, from: Vec2, target: Vec2| {
            w.player_mut(1).expect("thrower").body.pos = from;
            w.player_mut(2).expect("target").body.pos = target;
            let mut b = Bot::new(1, SEED, 0, 1.0);
            let fired =
                (0..120).any(|t| b.think(w, t as f32 * SIM_DT, SIM_DT).buttons & button::FIRE != 0);
            (fired, b.stats())
        };
        let (fired, stats) = throws(&mut w, thrower, target);
        assert!(
            fired,
            "never threw at an enemy {d:.0} px off in front of a rock: {stats:?}"
        );
        // Control: an enemy the same distance off with **nothing behind it** — a pair
        // whose throw `predict_impact` says never lands. Searched for, not assumed,
        // and a map with none is a fixture error, not a pass.
        let dirs = [
            Vec2::new(1.0, 0.0),
            Vec2::new(-1.0, 0.0),
            Vec2::new(0.0, 1.0),
            Vec2::new(0.0, -1.0),
        ];
        let (from, to) = (0..w.map.mask.h as i32)
            .step_by(16)
            .flat_map(|y| (0..w.map.mask.w as i32).step_by(16).map(move |x| (x, y)))
            .map(|(x, y)| Vec2::new(x as f32, y as f32))
            .filter(|p| geo.norm(p.x, p.y) < WELL_INSIDE)
            .flat_map(|from| dirs.iter().map(move |&dir| (from, from + dir * d)))
            .find(|&(from, to)| {
                (0..=(d / 4.0) as i32).all(|k| clear(&w, from + (to - from) * (k as f32 * 4.0 / d)))
                    && crate::weapons::projectile::predict_impact(
                        &w.map,
                        wid,
                        from,
                        (to - from).angle(),
                        w.wind,
                        w.gravity,
                        BOT_PREDICT_TICKS,
                        SIM_DT,
                    )
                    .is_none()
            })
            .expect("no pair on this map whose throw flies into open space");
        let (fired, stats) = throws(&mut w, from, to);
        assert!(
            !fired && stats.rej_impact_guard > 0,
            "threw at an enemy in open space, nothing behind it: {stats:?}"
        );
    }

    /// T22.03E F4: **in zero-g a throw must reach its target**, and this is the test
    /// that can see that half of `zone_refusal` (the review planted `reaches` → `true`
    /// and all 41 `bots::` tests stayed green). A toxic grenade has no contact burst:
    /// in zero-g it flies straight on through a floating enemy, bounces off whatever
    /// rock is down the line and goes off where its fuse ends. One throw line, the
    /// enemy moved along it: **far from where the fuse goes off, the bot refuses**
    /// (`rej_impact_guard`); **control: the enemy where it goes off, the bot throws.**
    /// Same aim, same flight, same landing — only whether it reaches the enemy moves.
    #[test]
    fn a_space_bot_throws_a_toxic_grenade_only_where_it_goes_off_near_the_enemy() {
        use crate::constants::{MapScale, DEFAULT_MAP_GENERATOR, PLAYER_W};
        use crate::items::registry::TOXIC_GRENADE;
        let mut w = World::with_gravity(
            SEED,
            MapScale::Small,
            0,
            DEFAULT_MAP_GENERATOR,
            GravityMode::Space,
        );
        w.set_phase(RoundPhase::Playing);
        w.add_player(1, 0, "thrower".into());
        w.add_player(2, 0, "target".into());
        give(&mut w, 1, TOXIC_GRENADE, 2);
        wield(&mut w, 1, TOXIC_GRENADE);
        let (wdef, wid) = crate::items::registry::def(TOXIC_GRENADE)
            .and_then(|d| match d.kind {
                ItemKind::Weapon(wid) => crate::weapons::defs::def(wid).map(|w| (w, wid)),
                _ => None,
            })
            .expect("the toxic grenade's weapon def");
        let reach = zone_reach(wdef, GravityMode::Space).expect("a zone reach");
        let clear = |w: &World, p: Vec2| {
            !crate::physics::collide::aabb_overlaps_solid(
                &w.map,
                crate::physics::body::Body::new(p).aabb(),
            )
        };
        let geo = w.map.space_geometry().expect("space");
        let near_band = reach + BOT_HAZARD_CLEARANCE + PLAYER_W;
        // (from, enemy far from the landing, enemy at the landing): searched for, and
        // a map with none is a fixture error, not a pass.
        let (from, far, at) = (0..w.map.mask.h as i32)
            .step_by(16)
            .flat_map(|y| (0..w.map.mask.w as i32).step_by(16).map(move |x| (x, y)))
            .map(|(x, y)| Vec2::new(x as f32, y as f32))
            .filter(|p| geo.norm(p.x, p.y) < WELL_INSIDE)
            .filter(|&p| clear(&w, p))
            .flat_map(|from| (0..16).map(move |k| (from, k as f32 * std::f32::consts::TAU / 16.0)))
            .find_map(|(from, angle)| {
                let landing = crate::weapons::projectile::predict_impact(
                    &w.map,
                    wid,
                    from,
                    angle,
                    w.wind,
                    w.gravity,
                    BOT_PREDICT_TICKS,
                    SIM_DT,
                )?;
                let dir = Vec2::new(angle.cos(), angle.sin());
                // Enemy spots down the clear part of the line, past the stand-off.
                let spots: Vec<Vec2> = (0..)
                    .map(|k| from + dir * (k as f32 * 4.0))
                    .take_while(|&p| clear(&w, p) && (p - from).len() < BOT_ENGAGE_RANGE * 0.9)
                    .filter(|&p| (p - from).len() >= near_band)
                    .collect();
                let at = spots
                    .iter()
                    .copied()
                    .find(|&p| (p - landing).len() <= reach * 0.5)?;
                let far = spots
                    .iter()
                    .copied()
                    .find(|&p| (p - landing).len() >= reach * 2.0)?;
                ((landing - from).len() >= near_band).then_some((from, far, at))
            })
            .expect("a clear throw line whose grenade goes off on it, with room either side");
        let throws = |w: &mut World, target: Vec2| {
            w.player_mut(1).expect("thrower").body.pos = from;
            w.player_mut(2).expect("target").body.pos = target;
            let mut b = Bot::new(1, SEED, 0, 1.0);
            let fired =
                (0..120).any(|t| b.think(w, t as f32 * SIM_DT, SIM_DT).buttons & button::FIRE != 0);
            (fired, b.stats())
        };
        let (fired, stats) = throws(&mut w, far);
        assert!(
            !fired && stats.rej_impact_guard > 0,
            "threw a toxic grenade that goes off {:.0} px past its enemy: {stats:?}",
            (far - from).len()
        );
        let (fired, stats) = throws(&mut w, at);
        assert!(
            fired,
            "control: never threw at an enemy where the grenade goes off: {stats:?}"
        );
    }

    /// T22.03E F5: **`choose_weapon` does not pick what `should_fire` would refuse to
    /// throw** — the other caller of `zone_refusal`, which nothing asserted directly
    /// (the review's plant of it passed every unit test). A bot with a molotov in
    /// hand and a pistol in the bag, its enemy inside the flame stand-off but out of
    /// a shovel's reach: it selects the pistol, in both modes. Unrefused, the molotov
    /// outscores the pistol (`zone_rate` 66.7 against 50) — the control, asserted.
    #[test]
    fn a_bot_too_close_for_its_molotov_selects_its_pistol() {
        use crate::constants::MapScale;
        for mode in [GravityMode::Standard, GravityMode::Space] {
            let mut w = World::with_gravity(
                SEED,
                MapScale::Small,
                0,
                crate::constants::DEFAULT_MAP_GENERATOR,
                mode,
            );
            w.set_phase(RoundPhase::Playing);
            w.add_player(1, 0, "bot".into());
            give(&mut w, 1, PISTOL, 30);
            give(&mut w, 1, MOLOTOV, 2);
            wield(&mut w, 1, MOLOTOV);
            let wdef = |item| {
                crate::items::registry::def(item)
                    .and_then(|d| match d.kind {
                        ItemKind::Weapon(wid) => crate::weapons::defs::def(wid),
                        _ => None,
                    })
                    .expect("a weapon def")
            };
            let (molotov, pistol) = (wdef(MOLOTOV), wdef(PISTOL));
            assert!(
                zone_rate(molotov).unwrap_or(0.0) > pistol.damage / pistol.cooldown,
                "control: the molotov no longer outscores the pistol unrefused"
            );
            let me = w.player(1).expect("bot").clone();
            let reach = zone_reach(molotov, mode).expect("a flame reach");
            let shovel = crate::weapons::melee::effective_reach(
                match wdef(crate::items::registry::SHOVEL).delivery {
                    crate::weapons::defs::Delivery::Melee { reach, .. } => reach,
                    _ => panic!("the shovel is no longer melee"),
                },
            );
            let dist = (shovel + reach) * 0.5;
            let target = me.body.pos + Vec2::new(dist, 0.0);
            let b = Bot::new(1, SEED, 0, 1.0);
            let pick = b
                .choose_weapon(&w, &me, target, me.body.pos)
                .and_then(|slot| me.inventory.slot(slot))
                .map(|s| s.item);
            assert_eq!(
                pick,
                Some(PISTOL),
                "{mode:?}: enemy {dist:.0} px off, inside the {reach:.0} px flame stand-off"
            );
        }
    }

    /// T99.04: **`DEV_BOT_ARSENAL` rotates the weapon in hand by kind, offset by seat.**
    /// A gun, a laser and a bazooka, the enemy where all three reach. The control is the same
    /// bot with the rotation off: one weapon, whatever the clock says. With it on, every kind
    /// comes round, and two bots seated next to each other never hold the same kind at once.
    #[test]
    fn the_arsenal_rotation_cycles_the_kinds_and_offsets_each_bot() {
        use crate::constants::{MapScale, BOT_ARSENAL_ROTATE};
        use crate::items::registry::{BAZOOKA, LASER_PISTOL};
        let mut w = World::with_gravity(
            SEED,
            MapScale::Small,
            0,
            crate::constants::DEFAULT_MAP_GENERATOR,
            GravityMode::Standard,
        );
        w.set_phase(RoundPhase::Playing);
        w.add_player(1, 0, "bot".into());
        for item in [PISTOL, LASER_PISTOL, BAZOOKA] {
            let max = crate::items::registry::def(item).expect("def").max_stack;
            give(&mut w, 1, item, max);
        }
        if let Some(p) = w.player_mut(1) {
            p.battery = crate::constants::BATTERY_MAX;
        }
        let me = w.player(1).expect("bot").clone();
        let pistol = crate::weapons::defs::def(
            match crate::items::registry::def(PISTOL).expect("def").kind {
                ItemKind::Weapon(wid) => wid,
                _ => panic!("the pistol is not a weapon"),
            },
        )
        .expect("pistol def");
        let target = me.body.pos + Vec2::new(pistol.range * 0.5, 0.0);
        let held = |b: &Bot, w: &World| {
            let slot = b
                .choose_weapon(w, &me, target, me.body.pos)
                .unwrap_or(me.inventory.selected());
            me.inventory.slot(slot).and_then(|s| weapon_kind(s.item))
        };
        let turns = 6;
        let mut plain = std::collections::BTreeSet::new();
        let mut rotated = std::collections::BTreeSet::new();
        for k in 0..turns {
            w.round_time = (k as f32 + 0.5) * BOT_ARSENAL_ROTATE;
            plain.insert(held(&Bot::new(1, SEED, 0, 1.0), &w));
            let (a, b) = (
                held(&Bot::new(1, SEED, 0, 1.0).arsenal(true), &w),
                held(&Bot::new(1, SEED, 1, 1.0).arsenal(true), &w),
            );
            assert_ne!(a, b, "two seats held the same kind at turn {k}");
            rotated.insert(a);
        }
        assert_eq!(
            plain.len(),
            1,
            "the control: a real bot changed weapon with the clock: {plain:?}"
        );
        assert_eq!(
            rotated.len(),
            3,
            "the rotation did not come round to every kind: {rotated:?}"
        );
    }

    /// T99.04: **an arsenal bot with the whole kit fires every kind in turn** — counted off
    /// the shots the world accepted, by the kind in hand. The rotation reaches the backpack
    /// (the flamethrower lands past the quick bar in the full kit) by swapping into the bar,
    /// and fires reckless (the bazooka at 90 px). The control is the same bot, same bag, the
    /// rotation off: it holds what it scores best and never reaches the backpack.
    #[test]
    fn an_arsenal_bot_fires_every_kind_in_its_bag() {
        use super::super::tests::{clear_line, flat_shelf};
        use crate::constants::{BOT_ARSENAL_ROTATE, SIM_DT};
        let kinds_fired = |arsenal: bool| {
            let mut w = World::for_test(SEED, crate::constants::MapScale::Small);
            w.set_phase(RoundPhase::Playing);
            w.add_player(1, 0, "bot".into());
            w.add_player(2, 0, "post".into());
            let at = clear_line(&w);
            let y = flat_shelf(&mut w, at, 400);
            if let Some(p) = w.player_mut(1) {
                p.body.pos = Vec2::new(at.x, y);
            }
            for d in crate::items::registry::live_weapons() {
                give(&mut w, 1, d.id, d.max_stack);
            }
            let mut b = Bot::new(1, SEED, 0, 1.0).arsenal(arsenal);
            let mut fired = std::collections::BTreeSet::new();
            for t in 0..(BOT_ARSENAL_ROTATE * 5.0 / SIM_DT) as u32 {
                let now = t as f32 * SIM_DT;
                w.round_time = now;
                // Full health and a full battery: what is measured is the choice, not attrition.
                if let Some(p) = w.player_mut(1) {
                    p.battery = crate::constants::BATTERY_MAX;
                    p.health = crate::constants::BASE_HEALTH;
                }
                if let Some(p) = w.player_mut(2) {
                    p.body.pos = Vec2::new(at.x + stream_reach() * 0.8, y);
                    p.body.vel = Vec2::ZERO;
                    p.health = crate::constants::BASE_HEALTH;
                }
                let d = crate::bots::drive(&mut w, std::slice::from_mut(&mut b), now, SIM_DT)[0];
                if d.fired.is_some_and(|r| r.is_ok()) {
                    if let Some(k) = d.held.and_then(weapon_kind) {
                        fired.insert(WEAPON_KINDS[k]);
                    }
                }
                w.step(SIM_DT);
                let _ = w.drain_events();
            }
            fired
        };
        let plain = kinds_fired(false);
        let rotated = kinds_fired(true);
        assert!(
            !plain.contains("flame") && plain.len() < rotated.len(),
            "the control: a real bot reached the backpack's flamethrower or as many kinds: {plain:?} vs {rotated:?}"
        );
        for k in ["gun", "laser", "flame", "arc"] {
            assert!(
                rotated.contains(k),
                "the rotation never fired a {k}: {rotated:?}"
            );
        }
    }

    /// T21.43: **a bot riding a gun platform fires it** — a stream at the
    /// platform's cadence, one `fire` per round and none refused — and **stops
    /// pressing when the magazine is empty**, so it neither never fires nor
    /// holds forever at nothing.
    ///
    /// The control is the same bot, the same bag and the same target unmounted:
    /// judged by the bag (§F5's shovel), a target 200 px off is out of reach and
    /// it presses nothing — which was also what a *mounted* bot did before this.
    #[test]
    fn a_bot_riding_a_platform_fires_its_stream_and_stops_when_it_is_empty() {
        use crate::constants::GUN_PLATFORM_FIRE_TICKS;
        use crate::items::registry::WEAPON_PLATFORM_GUN;
        use crate::world::GameEvent;

        let mut w = World::for_test(SEED, MapScale::Small);
        w.set_phase(RoundPhase::Playing);
        w.add_player(0, 0, "bot".into());
        let g = w.map.meta.gun_platforms[0];
        let pos = Vec2::new(g.pos.x as f32, g.pos.y as f32 - PLAYER_H / 2.0);
        {
            let p = w.player_mut(0).expect("seated");
            p.body.pos = pos;
            p.body.vel = Vec2::new(0.0, 0.0);
            p.body.grounded = true;
            // Straight onto the state the mount rule owns: this is a test of the
            // bot's trigger, and `world::platform_gun` mounts by the real rule.
            p.mount.mounted = Some(g.id);
        }
        let mut b = Bot::new(0, SEED, 0, 0.85);
        // A target in open air: the first direction whose line is clear.
        let target = [
            (0.0, -1.0),
            (0.7, -0.7),
            (-0.7, -0.7),
            (1.0, 0.0),
            (-1.0, 0.0),
        ]
        .iter()
        .map(|&(dx, dy)| Vec2::new(pos.x + dx * 200.0, pos.y + dy * 200.0))
        .find(|t| b.reachable(&w, pos, *t))
        .expect("some open air around the platform");

        // (presses, refused, platform rounds) over `ticks`.
        let run = |w: &mut World, b: &mut Bot, ticks: usize| {
            let (mut pressed, mut refused, mut rounds) = (0usize, 0usize, 0usize);
            for _ in 0..ticks {
                let now = w.round_time;
                let me = w.player(0).expect("seated");
                if b.should_fire(w, me, pos, target, now) {
                    pressed += 1;
                    if w.fire(0, now).is_err() {
                        refused += 1;
                    }
                }
                rounds += w
                    .drain_events()
                    .iter()
                    .filter(|e| {
                        matches!(e, GameEvent::ProjectileSpawn { weapon, .. }
                            if *weapon == WEAPON_PLATFORM_GUN)
                    })
                    .count();
                w.step(SIM_DT);
                w.drain_events();
            }
            (pressed, refused, rounds)
        };

        let ticks = 120usize;
        let (pressed, refused, rounds) = run(&mut w, &mut b, ticks);
        let want = ticks / GUN_PLATFORM_FIRE_TICKS as usize;
        assert!(
            rounds.abs_diff(want) <= 1,
            "a riding bot fired {rounds} rounds in {ticks} ticks, not {want} ± 1"
        );
        assert_eq!(
            refused, 0,
            "the bot pressed on {refused} ticks the platform refused"
        );
        assert_eq!(pressed, rounds, "presses and rounds disagree");

        // Empty: it stops pressing at all.
        w.platform_ammo[g.id as usize] = 0;
        let (pressed, _, rounds) = run(&mut w, &mut b, ticks);
        assert_eq!(
            (pressed, rounds),
            (0, 0),
            "a bot held the trigger of an empty platform"
        );

        // The control: refilled, but unmounted — the bag decides, and it cannot reach.
        w.platform_ammo[g.id as usize] = crate::constants::GUN_PLATFORM_AMMO;
        w.player_mut(0).expect("seated").mount.mounted = None;
        // Under the mount time (T22.10F): a silent player is stepped every tick
        // now, and one left standing on the platform mounts it again after
        // `GUN_PLATFORM_MOUNT_TIME` — the fixture's own doing, not the bot's.
        let unmounted = (crate::constants::GUN_PLATFORM_MOUNT_TIME / SIM_DT) as usize / 2;
        let (pressed, _, rounds) = run(&mut w, &mut b, unmounted);
        assert_eq!(
            (pressed, rounds),
            (0, 0),
            "unmounted, the bot fired at a target out of its bag's reach"
        );
    }

    /// **T22.03H: a walking bot with the shovel in hand closes inside its reach and
    /// swings.** The walking model held `dx` at `stand_off`'s 40 px floor, outside
    /// the shovel's 28 px `effective_reach`, so an enemy 36 px off on flat ground was
    /// "arrived at" and every swing refused as out of range (measured in standard
    /// play, 16 seeds: 47 896 shovel range refusals, 21 664 of them at |dx| 24–40 px,
    /// against 73 swings). Armed with a bazooka so it engages rather than shops, and
    /// the bazooka is blast-guarded this close, so the shovel is the only swing.
    /// The control: the same fixture with the enemy already inside the reach swings
    /// — so a red here is the stand-off, not a bot that never swings.
    #[test]
    fn a_walking_bot_with_the_shovel_closes_inside_its_reach_and_swings() {
        use crate::items::registry::SHOVEL;
        let reach = crate::weapons::melee::effective_reach(
            match crate::items::registry::def(SHOVEL)
                .and_then(|d| match d.kind {
                    ItemKind::Weapon(wid) => crate::weapons::defs::def(wid),
                    _ => None,
                })
                .expect("the shovel is a weapon")
                .delivery
            {
                Delivery::Melee { reach, .. } => reach,
                _ => panic!("the shovel is no longer melee"),
            },
        );
        // Swings accepted in 3 s, and the closest the two got.
        let run = |gap: f32| {
            let mut w = world_with(&[1, 2]);
            let at = clear_line(&w);
            let ids: Vec<_> = w.items.iter().map(|i| i.id).collect();
            for id in ids {
                w.items.remove(id);
            }
            let y = flat_shelf(&mut w, at, 240);
            if let Some(p) = w.player_mut(1) {
                p.body.pos = Vec2::new(at.x, y);
            }
            if let Some(p) = w.player_mut(2) {
                p.body.pos = Vec2::new(at.x + gap, y);
            }
            give(&mut w, 1, BAZOOKA, 4);
            let mut b = Bot::new(1, SEED, 0, 1.0);
            let (mut swings, mut closest) = (0u32, f32::MAX);
            for t in 0..180 {
                let now = t as f32 * SIM_DT;
                let d = crate::bots::drive(&mut w, std::slice::from_mut(&mut b), now, SIM_DT)[0];
                if d.held == Some(SHOVEL) && d.fired.is_some_and(|r| r.is_ok()) {
                    swings += 1;
                }
                // The enemy is a post: kept alive and in place.
                if let Some(p) = w.player_mut(2) {
                    p.health = 100.0;
                    p.body.pos.x = at.x + gap;
                }
                w.step(SIM_DT);
                let _ = w.drain_events();
                let (a, c) = (w.player(1).unwrap().body.pos, w.player(2).unwrap().body.pos);
                closest = closest.min((a - c).len());
            }
            (swings, closest)
        };
        let (swings, _) = run(reach * 0.5);
        assert!(
            swings > 0,
            "control: an enemy inside the reach was never swung at"
        );
        // Just outside the reach, and inside `stand_off`'s floor — where it stuck.
        let gap = reach * 1.2;
        let (swings, closest) = run(gap);
        assert!(
            closest <= reach && swings > 0,
            "an enemy {gap:.0} px off (reach {reach:.0} px): closest {closest:.1} px, {swings} \
             swings — the walking stand-off held it out of reach"
        );
    }

    /// A weapon in the bag counts as armed, even when the one in hand is dead.
    ///
    /// `choose_goal` asked `selected_weapon`, so a bot holding a flat laser with
    /// a loaded pistol two slots over was treated as **unarmed** and went
    /// shopping for a weapon it already had. `choose_weapon` switches it on the
    /// same tick, so the shopping trip was pure waste — and once §E10 stopped
    /// unarmed bots from chasing, it became the difference between fighting and
    /// wandering off.
    ///
    /// This exists because the falsification found nothing: reverting the fix on
    /// its own left every test green. The laser fixture only caught it in
    /// combination with the rest of this task, which is not a guard.
    #[test]
    fn a_loaded_gun_in_the_bag_counts_as_armed_even_with_a_dead_one_in_hand() {
        use crate::items::registry::{LASER_PISTOL, PISTOL};

        let setup = |with_spare: bool| {
            let mut w = world_with(&[1, 2]);
            let at = clear_line(&w);
            let y = flat_shelf(&mut w, at, 240);
            let ids: Vec<_> = w.items.iter().map(|i| i.id).collect();
            for id in ids {
                w.items.remove(id);
            }
            if let Some(p) = w.player_mut(1) {
                p.body.pos = Vec2::new(at.x, y);
            }
            if let Some(p) = w.player_mut(2) {
                p.body.pos = Vec2::new(at.x + 120.0, y);
            }
            give(&mut w, 1, LASER_PISTOL, 1);
            if with_spare {
                give(&mut w, 1, PISTOL, 10);
            }
            // The laser in hand, and no charge to fire it: `selected_weapon` is
            // `None` either way, so the two runs differ only by what is in the bag.
            let slot = (0..INVENTORY_SLOTS as u8).find(|s| {
                w.player(1)
                    .and_then(|p| p.inventory.slot(*s))
                    .is_some_and(|st| st.item == LASER_PISTOL)
            });
            if let Some(slot) = slot {
                w.select_slot(1, slot);
            }
            if let Some(p) = w.player_mut(1) {
                p.battery = 0.0;
            }
            // Something on the floor to be tempted by.
            let bait = drop_at(&mut w, MEDKIT, Vec2::new(at.x + 40.0, y));
            let mut b = Bot::new(1, SEED, 0, 0.6);
            b.think(&w, 0.0, SIM_DT);
            assert!(
                b.selected_weapon(&w).is_none(),
                "the fixture armed the bot in hand, so it proves nothing about the bag",
            );
            (b.goal, bait)
        };

        let (with_spare, _) = setup(true);
        assert!(
            matches!(with_spare, Goal::Enemy(2)),
            "a bot with a loaded pistol in the bag went shopping ({with_spare:?}) \
             instead of engaging — it is armed and does not know it",
        );

        // The control: with nothing in the bag it really is unarmed, and then
        // going for the item is correct. Without this the assertion above passes
        // for a bot that always engages.
        let (without, bait) = setup(false);
        assert_eq!(
            without,
            Goal::Item(bait),
            "a genuinely unarmed bot did not go shopping, so the contrast above is \
             not about the spare weapon",
        );
    }

    /// A zone weapon is dangerous well past its blast radius, which is 0.
    #[test]
    fn a_bot_does_not_throw_a_molotov_at_its_own_feet() {
        let mut w = world_with(&[1, 2]);
        give(&mut w, 1, MOLOTOV, 2);
        wield(&mut w, 1, MOLOTOV);
        let at = clear_line(&w);
        if let Some(p) = w.player_mut(1) {
            p.body.pos = at;
        }
        // Well inside the zone's reach (radius + scatter).
        if let Some(p) = w.player_mut(2) {
            p.body.pos = Vec2::new(at.x + 30.0, at.y);
        }
        let mut b = Bot::new(1, SEED, 0, 1.0);
        let mut fired = false;
        for t in 0..60 {
            if b.think(&w, t as f32 * SIM_DT, SIM_DT).buttons & button::FIRE != 0 {
                fired = true;
                break;
            }
        }
        assert!(
            !fired,
            "threw a molotov at a target 30 px away, inside its own zone: {:?}",
            b.stats()
        );
    }

    /// T11.15, §B26 — the guard the distance test cannot express.
    ///
    /// The target is in throwing range (`molotov_target`), which the distance guard is happy with (the
    /// control below is the same geometry and it throws). A wall sits 40 px in
    /// front of the thrower, so the arc lands almost immediately, on them.
    ///
    /// The assertion that matters is not "did not throw" — the old guard could
    /// produce that for the wrong reason. It is that **`rej_impact_guard`**
    /// fired: the refusal came from walking the arc, not from measuring the
    /// target.
    #[test]
    fn a_bot_does_not_throw_a_molotov_into_a_wall_in_front_of_it() {
        let mut w = world_with(&[1, 2]);
        give(&mut w, 1, MOLOTOV, 2);
        wield(&mut w, 1, MOLOTOV);
        let at = clear_line(&w);
        if let Some(p) = w.player_mut(1) {
            p.body.pos = at;
        }
        let to = molotov_target(&mut w, at);
        if let Some(p) = w.player_mut(2) {
            p.body.pos = to;
        }
        // A pillar just ahead: high enough that any throw at the target clips it.
        for dx in 40..52 {
            for dy in -90..40 {
                w.map.fill_circle(at.x as i32 + dx, at.y as i32 + dy, 1);
            }
        }
        let mut b = Bot::new(1, SEED, 0, 1.0);
        let mut fired = false;
        for t in 0..120 {
            if b.think(&w, t as f32 * SIM_DT, SIM_DT).buttons & button::FIRE != 0 {
                fired = true;
                break;
            }
        }
        assert!(
            !fired,
            "threw a molotov into a wall 40 px away: {:?}",
            b.stats()
        );
        // T23.26D: the arc is walked by `lob_angle` now, and a pillar in every arc is
        // its refusal (`rej_arc`) before the zone guard is asked.
        assert!(
            b.stats().rej_impact_guard + b.stats().rej_arc > 0,
            "it refused, but not because of the arc — no arc refusal fired: {:?}",
            b.stats()
        );
    }

    /// The presence beside that absence: far enough away, it does throw.
    #[test]
    fn a_bot_does_throw_a_molotov_from_a_safe_distance() {
        let mut w = world_with(&[1, 2]);
        give(&mut w, 1, MOLOTOV, 2);
        wield(&mut w, 1, MOLOTOV);
        let at = clear_line(&w);
        if let Some(p) = w.player_mut(1) {
            p.body.pos = at;
        }
        let to = molotov_target(&mut w, at);
        if let Some(p) = w.player_mut(2) {
            p.body.pos = to;
        }
        let mut b = Bot::new(1, SEED, 0, 1.0);
        let mut fired = false;
        for t in 0..120 {
            if b.think(&w, t as f32 * SIM_DT, SIM_DT).buttons & button::FIRE != 0 {
                fired = true;
                break;
            }
        }
        assert!(
            fired,
            "never threw a molotov at a target in throwing range: {:?}",
            b.stats()
        );
    }

    /// The other side of the same tick: with the trigger ready, the same bot in
    /// the same place **shoots without stopping** (§F4).
    ///
    /// **This replaces `a_bot_that_can_shoot_stands_still_instead_of_closing`**,
    /// which asserted the opposite and was correct until §C20 was repealed. The
    /// pairing survives: one fixture, one difference, so what changed the
    /// behaviour is not in doubt — the bot presses the same direction as the
    /// test above *and* pulls the trigger, where it used to have to choose.
    #[test]
    fn a_bot_that_can_shoot_fires_without_breaking_stride() {
        let mut w = world_with(&[1, 2]);
        give(&mut w, 1, BAZOOKA, 4);
        wield(&mut w, 1, BAZOOKA);
        let at = clear_line(&w);
        if let Some(p) = w.player_mut(1) {
            p.body.pos = at;
        }
        if let Some(p) = w.player_mut(2) {
            p.body.pos = Vec2::new(at.x + 200.0, at.y);
        }
        let mut b = Bot::new(1, SEED, 0, 1.0);
        let inp = b.think(&w, 0.0, SIM_DT);
        // It still closes on the target: the direction is not sacrificed.
        assert_ne!(
            inp.buttons & button::RIGHT,
            0,
            "the bot stopped walking toward a target 200 px to its right — the \
             planting behaviour §F4 removed is still there"
        );
        // And it takes the shot on the same tick. Without this half a bot that
        // walks and never fires passes, which is the §A26 shape the test it
        // replaces already guarded against.
        assert_ne!(
            inp.buttons & button::FIRE,
            0,
            "the bot walked but did not pull the trigger"
        );
    }

    /// The positive control for the blast-guard test below.
    ///
    /// "A bot does not fire at X" passes against a bot that never fires at
    /// anything — and for the whole life of this project that is exactly what
    /// shipped, because nothing consumed the FIRE bit. An absence needs a
    /// presence beside it.
    #[test]
    fn a_bot_fires_at_an_armed_clear_shot_at_a_sane_range() {
        let mut w = world_with(&[1, 2]);
        give(&mut w, 1, BAZOOKA, 4);
        wield(&mut w, 1, BAZOOKA);
        let at = clear_line(&w);
        if let Some(p) = w.player_mut(1) {
            p.body.pos = at;
        }
        if let Some(p) = w.player_mut(2) {
            p.body.pos = Vec2::new(at.x + 200.0, at.y);
        }
        let mut b = Bot::new(1, SEED, 0, 1.0);
        let mut fired = false;
        for t in 0..30 {
            let inp = b.think(&w, t as f32 * SIM_DT, SIM_DT);
            if inp.buttons & button::FIRE != 0 {
                fired = true;
                break;
            }
        }
        assert!(
            fired,
            "armed, clear line, 200 px away, and never pulled the trigger: {:?}",
            b.stats()
        );
    }

    /// A bot that has closed to a range its own blast guard forbids will stand
    /// there forever. Measured as the largest single rejection reason.
    #[test]
    fn a_bot_holds_at_a_range_it_can_actually_shoot_from() {
        let mut w = world_with(&[1, 2]);
        give(&mut w, 1, BAZOOKA, 4);
        wield(&mut w, 1, BAZOOKA);
        let b = Bot::new(1, SEED, 0, 0.6);
        let stand = b.stand_off(&w);
        let blast = crate::weapons::defs::def(match def(BAZOOKA).map(|d| d.kind) {
            Some(ItemKind::Weapon(wid)) => wid,
            _ => panic!("the bazooka stopped being a weapon"),
        })
        .map_or(0.0, |w| w.blast_radius);
        assert!(
            stand > blast * BOT_BLAST_GUARD,
            "stands at {stand} px inside a {} px blast guard",
            blast * BOT_BLAST_GUARD
        );
    }

    /// A bot that rockets its own feet is a bug that looks like a difficulty
    /// setting.
    #[test]
    fn a_bot_does_not_fire_at_a_target_inside_its_own_blast_radius() {
        let mut w = world_with(&[1, 2]);
        give(&mut w, 1, BAZOOKA, 4);
        wield(&mut w, 1, BAZOOKA);
        let at = clear_line(&w);
        if let Some(p) = w.player_mut(1) {
            p.body.pos = at;
        }
        if let Some(p) = w.player_mut(2) {
            p.body.pos = Vec2::new(at.x + 10.0, at.y); // point blank
        }
        let mut b = Bot::new(1, SEED, 0, 1.0);
        let inp = b.think(&w, 100.0, SIM_DT);
        assert!(
            inp.buttons & button::FIRE == 0,
            "fired a bazooka at a target 10 px away"
        );

        // The control: at a sane range with a clear line it *does* fire, so the
        // assertion above is not satisfied by a bot that never shoots at all.
        if let Some(p) = w.player_mut(2) {
            p.body.pos = Vec2::new(at.x + 200.0, at.y);
        }
        let mut fired = false;
        let mut b2 = Bot::new(1, SEED, 0, 1.0);
        for t in 0..30 {
            let inp = b2.think(&w, 100.0 + t as f32 * SIM_DT, SIM_DT);
            if inp.buttons & button::FIRE != 0 {
                fired = true;
                break;
            }
        }
        assert!(fired, "never fired even at 200 px with a clear line");
    }
}

/// T11.04 — energy weapons, and the bot selection that makes them usable (§B5).
#[cfg(test)]
mod energy {
    use super::*;
    use crate::bots::harness;
    use crate::items::registry::{self, ItemKind, LASER_PISTOL, PISTOL};
    // No `wield` here: these fixtures select their own slots explicitly — a flat
    // laser *in hand* is the whole premise — so §F5's shovel in slot 0 is stepped
    // past by the test itself.
    use crate::world::{give, RoundPhase, World};

    /// Two bots, each **holding a flat laser** with a loaded pistol in the bag.
    ///
    /// The obvious version of this test — "run a round with lasers in the spawn
    /// pool and assert bots engage" — **does not discriminate**: at a spawn
    /// weight of 10 in a pool of fourteen items, most bots never pick a laser up
    /// in 60 s, so it passes whether or not they can use one. Disabling
    /// `wants_select` left it green, which is how I found out (§B11: ask what a
    /// passing assertion rules out).
    ///
    /// This puts the paperweight in their hands instead. Without selection a bot
    /// is stuck on a weapon it cannot fire for the whole round — T11.02's
    /// measured `ticks_engaged: 0` — and with it, it switches and fights.
    #[test]
    fn a_bot_stuck_on_a_flat_laser_still_fights() {
        // **Eight seeds, not one.** It was seed 4242 alone, and pass 6b moved
        // that map: the four bots on it now never get a shot off at all
        // (`fires 0`), which says something about where scenery put them and
        // nothing about weapon selection. Whether four bots find each other in
        // 60 s is a property of the map; whether they can *use* what they are
        // holding is the claim, and a claim about a population needs more than
        // one draw. Same shape as `most_rounds_see_a_bot_fire` above.
        const SEEDS: [u64; 8] = [1, 7, 42, 99, 4242, 31337, 5, 11];
        let rounds: Vec<_> = SEEDS
            .iter()
            .map(|&seed| harness::run_round_holding(seed, 4, 0.85, 60.0, LASER_PISTOL, PISTOL))
            .collect();

        let dealt = rounds.iter().filter(|r| r.damage_dealt > 0.0).count();
        let fires: u32 = rounds.iter().map(|r| r.stats.fires).sum();
        let rej: u32 = rounds.iter().map(|r| r.stats.rej_unarmed).sum();
        assert!(
            dealt >= SEEDS.len() / 2,
            "bots holding an unusable weapon dealt damage in only {dealt} of {} rounds — \
             they are not switching to the loaded gun in their own inventory \
             (fires {fires}, rej_unarmed {rej})",
            SEEDS.len()
        );

        // The control that makes the count above mean something: a bot that
        // never switched would be refused every shot it tried. Plenty of fires
        // and no wall of `rej_unarmed` is what "it switched" looks like.
        assert!(fires > 0, "no bot fired in any round");
        assert!(
            rej < fires,
            "more shots refused as unarmed ({rej}) than fired ({fires}) — \
             the bots are stuck on the laser after all"
        );
    }

    /// The half that was missing: a bot must be able to move **off** a weapon it
    /// cannot fire. An uncharged laser is a paperweight (§B5), and before
    /// `wants_select` the only thing that changed a selection was a stack running
    /// out — which an energy weapon's stack never does.
    #[test]
    fn a_bot_holding_a_flat_laser_switches_to_a_loaded_gun() {
        let mut w = World::for_test(4242, crate::constants::MapScale::Small);
        w.set_phase(RoundPhase::Playing);
        w.add_player(0, 0, "bot".into());
        give(&mut w, 0, LASER_PISTOL, 1);
        give(&mut w, 0, PISTOL, 10);
        // Select the laser, then flatten the battery.
        let laser_slot = (0..crate::constants::INVENTORY_SLOTS as u8)
            .find(|s| {
                w.player(0)
                    .and_then(|p| p.inventory.slot(*s))
                    .is_some_and(|st| st.item == LASER_PISTOL)
            })
            .expect("laser slot");
        w.select_slot(0, laser_slot);
        if let Some(p) = w.player_mut(0) {
            p.battery = 0.0;
        }

        let mut bot = Bot::new(0, 4242, 0, 0.85);
        let _ = bot.think(&w, 1.0, crate::constants::SIM_DT);
        let want = bot.wants_select().expect("a flat laser must not be kept");
        let held = w
            .player(0)
            .and_then(|p| p.inventory.slot(want))
            .expect("chosen slot is empty");
        assert_eq!(
            held.item, PISTOL,
            "the bot stayed on a weapon it cannot fire"
        );

        // Control: charge the battery and the laser becomes a candidate again —
        // otherwise this passes for a bot that simply always avoids lasers.
        if let Some(p) = w.player_mut(0) {
            p.battery = crate::constants::BATTERY_MAX;
        }
        let mut bot2 = Bot::new(0, 4242, 0, 0.85);
        let _ = bot2.think(&w, 1.0, crate::constants::SIM_DT);
        let choice = bot2.wants_select().unwrap_or(laser_slot);
        let item = w
            .player(0)
            .and_then(|p| p.inventory.slot(choice))
            .map(|s| s.item);
        assert!(
            item == Some(LASER_PISTOL) || item == Some(PISTOL),
            "a charged bot chose neither of the two weapons it holds: {item:?}"
        );
    }

    /// §B5 exists only if the items can be found. T11.02 shipped the defs with
    /// every weight at zero because bots could not use them; that is now closed.
    #[test]
    fn the_energy_weapons_are_obtainable() {
        for key in ["laser_pistol", "laser_smg"] {
            let d = registry::by_key(key).unwrap_or_else(|| panic!("{key} is not an item"));
            assert!(
                d.spawn_weight > 0 || d.crate_weight > 0 || d.buried_weight > 0,
                "{key} can never be obtained — §B5's whole branch is dead weight"
            );
            let ItemKind::Weapon(wid) = d.kind else {
                panic!("{key} is not a weapon")
            };
            let w = crate::weapons::defs::def(wid).expect("weapon def");
            assert!(w.is_energy(), "{key} does not cost battery");
        }
        // The battery must be findable too, or the weapons that need it are not.
        let b = registry::by_key("battery_pack").expect("battery pack");
        assert!(b.spawn_weight > 0, "no charge on the ground");
    }
}

#[cfg(test)]
mod bots_already_throw_what_they_carry {
    use super::*;
    use crate::constants::{MapScale, SIM_DT};
    use crate::items::registry::GRENADE;
    // No `wield` here on purpose: this module is about what the bot *asks* to
    // select, so the shovel §F5 puts in slot 0 is part of the question rather
    // than something the fixture should reach past.
    use crate::world::{give, RoundPhase, World};

    /// T14.04 asks whether bots need §C11's quick-throw "or they carry grenades
    /// they never throw", and to **check rather than assume** (§B19). Checked:
    /// they do not.
    ///
    /// `choose_weapon` scans every slot and scores by damage per second, with no
    /// filter on delivery kind — a grenade is scored exactly like a rocket — and
    /// the bot then asks for that slot via `select_slot` and fires it through the
    /// ordinary path. Giving bots a second route to the same act would be two
    /// mechanisms for one job, which is how they drift.
    ///
    /// This test is the evidence, and it is here so that a future change to
    /// `choose_weapon` that starts skipping thrown weapons fails loudly instead of
    /// quietly leaving bots with pockets full of grenades.
    #[test]
    fn a_bot_carrying_only_a_grenade_asks_to_select_it() {
        let mut w = World::for_test(4242, MapScale::Small);
        w.set_phase(RoundPhase::Playing);
        w.add_player(0, 0, "bot".into());
        w.add_player(1, 0, "target".into());
        give(&mut w, 0, GRENADE, 3);
        for _ in 0..120 {
            w.step(SIM_DT);
        }

        // Put the target within reach, so the bot has something to choose *for*.
        let at = w.player(0).expect("bot").body.pos;
        if let Some(t) = w.player_mut(1) {
            t.body.pos = Vec2::new(at.x + 140.0, at.y);
        }

        let mut bot = Bot::new(0, 4242, 0, 1.0);
        let mut asked = None;
        for _ in 0..60 {
            bot.think(&w, w.round_time, SIM_DT);
            if let Some(slot) = bot.wants_select() {
                asked = Some(slot);
                break;
            }
        }

        let held = w
            .player(0)
            .expect("bot")
            .inventory
            .iter()
            .find(|(_, s)| s.item == GRENADE)
            .map(|(slot, _)| slot);
        assert!(held.is_some(), "the fixture never gave the bot a grenade");
        // Either it asked for the grenade's slot, or it was already selected —
        // `choose_weapon` only reports a *change*.
        let selected = w.player(0).expect("bot").inventory.selected();
        assert!(
            asked == held || Some(selected) == held,
            "the bot neither selected nor asked for its grenade: asked {asked:?}, \
             selected {selected}, grenade in {held:?}",
        );
    }
}
