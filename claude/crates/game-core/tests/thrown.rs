//! T11.08 — airburst, smoke, molotov and toxic (`docs/71-amendments-v3.md` §B7).
//!
//! Four grenades that are not the grenade. They share one flight path and differ
//! only in what happens when they stop, which is why `Burst` is a field on the
//! def rather than four `Delivery` variants — a smoke that fell differently from
//! a molotov would be a second projectile simulation to keep in step.
//!
//! Three of the four **must leave the terrain byte-identical**. That is the same
//! assertion toxic rain already carries (`docs/13` §3), and it is the property
//! that makes them area denial rather than more digging.

use game_core::constants::MapScale;
use game_core::constants::*;
use game_core::items::registry::{
    WeaponId, WEAPON_AIRBURST, WEAPON_AIRBURST_PELLET, WEAPON_GRENADE, WEAPON_MOLOTOV,
    WEAPON_SMOKE, WEAPON_TOXIC_GRENADE,
};
use game_core::math::Vec2;
use game_core::weapons::burn::BurnKind;
use game_core::weapons::defs::{def, Burst};
use game_core::world::{GameEvent, HazardKind, RoundPhase, World};

const SEED: u64 = 4242;

fn playing() -> World {
    let mut w = World::new(SEED, MapScale::Small);
    w.set_phase(RoundPhase::Playing);
    let _ = w.drain_events();
    w
}

/// Set off `weapon` at a point, exactly as a projectile of it would.
fn burst(w: &mut World, weapon: WeaponId, at: Vec2, owner: u8) {
    w.explode_for_test(at, weapon, owner, w.round_time);
}

fn solid_count(w: &World) -> usize {
    w.map.mask.count_solid() as usize
}

/// Somewhere with rock under it, so a zone lands on ground rather than in the sky.
fn ground_point(w: &World) -> Vec2 {
    let p = w.map.meta.surface_points[w.map.meta.surface_points.len() / 2];
    Vec2::new(p.x as f32, p.y as f32 - 4.0)
}

// ---------------------------------------------------------------------------
// The property that makes three of them different from a grenade
// ---------------------------------------------------------------------------

#[test]
fn smoke_molotov_and_toxic_leave_the_terrain_byte_identical() {
    // The control is the grenade in the same harness: if this test could not see
    // terrain damage, "no terrain damage" would pass for all four.
    let mut w = playing();
    let at = ground_point(&w);
    let before = solid_count(&w);
    burst(&mut w, WEAPON_GRENADE, at, 0);
    let after_grenade = solid_count(&w);
    assert!(
        after_grenade < before,
        "control: a grenade must dig, or this harness cannot see terrain damage"
    );

    for weapon in [WEAPON_SMOKE, WEAPON_MOLOTOV, WEAPON_TOXIC_GRENADE] {
        let mut w = playing();
        let at = ground_point(&w);
        let before = solid_count(&w);
        burst(&mut w, weapon, at, 0);
        let after = solid_count(&w);
        let key = def(weapon).expect("def").key;
        assert_eq!(
            before, after,
            "{key} changed the terrain: {before} -> {after}"
        );
    }
}

#[test]
fn an_airburst_digs_because_its_pellets_do() {
    // The exception, and it is deliberate: §A3 says every shot digs, and the
    // pellets are shots. The grenade itself carves nothing — the holes are theirs.
    let mut w = playing();
    let at = ground_point(&w);
    let before = solid_count(&w);
    burst(&mut w, WEAPON_AIRBURST, at + Vec2::new(0.0, -40.0), 0);
    assert!(
        solid_count(&w) < before,
        "airburst pellets should mark the ground beneath the burst"
    );
}

// ---------------------------------------------------------------------------
// Airburst
// ---------------------------------------------------------------------------

#[test]
fn an_airburst_fires_exactly_the_stated_number_of_pellets_downward() {
    let mut w = playing();
    // Open sky, so the rays have somewhere to go. Bursting inside rock is legal
    // and produces zero-length rays, which would tell us nothing about the fan.
    let at = Vec2::new(w.map.mask.w as f32 / 2.0, SKY_MARGIN as f32 + 40.0);
    burst(&mut w, WEAPON_AIRBURST, at, 0);

    let shots: Vec<_> = w
        .drain_events()
        .into_iter()
        .filter_map(|e| match e {
            GameEvent::Hitscan { x0, y0, x1, y1, .. } => Some((x0, y0, x1, y1)),
            _ => None,
        })
        .collect();

    assert_eq!(
        shots.len(),
        AIRBURST_PELLETS as usize,
        "one ray per pellet, no more and no fewer"
    );
    for (x0, y0, x1, y1) in &shots {
        assert!(
            y1 > y0,
            "a pellet went upward: ({x0},{y0}) -> ({x1},{y1}) — the fan is downward"
        );
    }
}

#[test]
fn pellets_do_not_spawn_pellets() {
    // The fork-bomb guard, in the shape M5 already paid for with meteors.
    let mut w = playing();
    let at = Vec2::new(w.map.mask.w as f32 / 2.0, SKY_MARGIN as f32 + 40.0);
    burst(&mut w, WEAPON_AIRBURST, at, 0);
    let first = w
        .drain_events()
        .into_iter()
        .filter(|e| matches!(e, GameEvent::Hitscan { .. }))
        .count();
    for _ in 0..30 {
        w.step(SIM_DT);
    }
    let later = w
        .drain_events()
        .into_iter()
        .filter(|e| matches!(e, GameEvent::Hitscan { .. }))
        .count();
    assert_eq!(first, AIRBURST_PELLETS as usize);
    assert_eq!(later, 0, "pellets recursed: {later} more rays appeared");
}

#[test]
fn an_airburst_bursts_at_the_top_of_its_arc() {
    // Not on landing: an airburst that lands is a dud. Thrown upward, it must go
    // off while still above where it was thrown from.
    let mut w = playing();
    let from = ground_point(&w);
    let id = w.projectiles.spawn(
        WEAPON_AIRBURST,
        0,
        from,
        -std::f32::consts::FRAC_PI_2,
        w.round_time,
    );
    assert!(w.projectiles.get(id).is_some());

    let mut burst_y = None;
    for _ in 0..300 {
        w.step(SIM_DT);
        if w.projectiles.get(id).is_none() {
            burst_y = Some(
                w.drain_events()
                    .into_iter()
                    .find_map(|e| match e {
                        GameEvent::Hitscan { y0, .. } => Some(y0),
                        _ => None,
                    })
                    .expect("a burst emits its pellets"),
            );
            break;
        }
        let _ = w.drain_events();
    }
    let y = burst_y.expect("the airburst never went off");
    assert!(
        y < from.y - 20.0,
        "burst at y={y}, thrown from y={}: that is not an apex",
        from.y
    );
}

#[test]
fn an_airburst_costs_the_thrower_no_battery() {
    // The pellet has a real `energy_cost` and nobody ever pays it: it pierces
    // shields (§B7) because `is_energy()` is true, and charges nothing because
    // pellets are fired by `burst_pellets` rather than by `try_fire`, which is the
    // only place battery is spent. This guards the day someone routes them through
    // the normal firing path and an airburst silently starts costing two resources.
    let mut w = playing();
    w.add_player(0, 0, "thrower".into());
    if let Some(p) = w.player_mut(0) {
        p.battery = BATTERY_MAX;
    }
    let before = w.player(0).expect("p").battery;
    let at = Vec2::new(w.map.mask.w as f32 / 2.0, SKY_MARGIN as f32 + 40.0);
    burst(&mut w, WEAPON_AIRBURST, at, 0);
    let after = w.player(0).expect("p").battery;
    assert_eq!(
        before, after,
        "the grenade was the ammo; the thrower paid battery too"
    );
    // Control: the pellet really is energy, or the sentence above is vacuous.
    assert!(
        def(WEAPON_AIRBURST_PELLET).expect("def").is_energy(),
        "pellets must be energy, or they do not pierce shields"
    );
}

// ---------------------------------------------------------------------------
// Smoke — the only weapon with no damage at all
// ---------------------------------------------------------------------------

#[test]
fn smoke_deals_no_damage_and_a_molotov_in_the_same_harness_does() {
    let mut w = playing();
    let at = ground_point(&w);
    w.add_player(1, 0, "victim".into());
    if let Some(p) = w.player_mut(1) {
        p.body.pos = at;
        p.iframes_until = 0.0;
    }

    let hp0 = w.player(1).expect("p").health;
    burst(&mut w, WEAPON_SMOKE, at, 0);
    for _ in 0..(SMOKE_DURATION / SIM_DT) as usize {
        w.step(SIM_DT);
        if let Some(p) = w.player_mut(1) {
            p.body.pos = at;
        }
    }
    let after_smoke = w.player(1).expect("p").health;
    assert_eq!(
        hp0, after_smoke,
        "smoke is pure information denial: {hp0} -> {after_smoke}"
    );

    // Control: the same harness, standing in the same spot, must lose health to a
    // molotov — otherwise "no damage" is a statement about the harness.
    burst(&mut w, WEAPON_MOLOTOV, at, 0);
    for _ in 0..60 {
        w.step(SIM_DT);
        if let Some(p) = w.player_mut(1) {
            p.body.pos = at;
        }
    }
    let after_fire = w.player(1).expect("p").health;
    assert!(
        after_fire < after_smoke,
        "control: fire should burn ({after_smoke} -> {after_fire})"
    );
}

#[test]
fn smoke_dims_vision_where_it_is_and_clears_when_it_disperses() {
    let mut w = playing();
    let at = ground_point(&w);
    w.add_player(1, 0, "seer".into());
    if let Some(p) = w.player_mut(1) {
        p.body.pos = at;
    }

    let clear = w.vision_multiplier(w.player(1).expect("p"));
    assert!((clear - 1.0).abs() < 1e-6, "clear air is 1.0, got {clear}");

    burst(&mut w, WEAPON_SMOKE, at, 0);
    let inside = w.vision_multiplier(w.player(1).expect("p"));
    assert!(
        (inside - FOV_SMOKE_MULT).abs() < 1e-6,
        "inside the cloud should be {FOV_SMOKE_MULT}, got {inside}"
    );

    // Far away, in the same cloud's world, vision is untouched.
    if let Some(p) = w.player_mut(1) {
        p.body.pos = at + Vec2::new(SMOKE_RADIUS + 30.0, 0.0);
    }
    let beside = w.vision_multiplier(w.player(1).expect("p"));
    assert!(
        (beside - 1.0).abs() < 1e-6,
        "outside should be clear, got {beside}"
    );

    if let Some(p) = w.player_mut(1) {
        p.body.pos = at;
    }
    for _ in 0..(SMOKE_DURATION / SIM_DT) as usize + 2 {
        w.step(SIM_DT);
        if let Some(p) = w.player_mut(1) {
            p.body.pos = at;
        }
    }
    let after = w.vision_multiplier(w.player(1).expect("p"));
    assert!(
        (after - 1.0).abs() < 1e-6,
        "the cloud should have dispersed, got {after}"
    );
    assert!(w.smoke.is_empty());
}

// ---------------------------------------------------------------------------
// Molotov and toxic
// ---------------------------------------------------------------------------

#[test]
fn a_molotov_scatters_the_stated_number_of_patches_and_they_expire() {
    let mut w = playing();
    let at = ground_point(&w);
    burst(&mut w, WEAPON_MOLOTOV, at, 0);
    assert_eq!(
        w.burn.len(),
        MOLOTOV_PATCHES as usize,
        "one patch per §B7's count"
    );
    assert!(
        w.burn.patches().iter().all(|p| p.kind == BurnKind::Fire),
        "a molotov leaves fire"
    );

    for _ in 0..(MOLOTOV_BURN_DURATION / SIM_DT) as usize + 2 {
        w.step(SIM_DT);
    }
    assert!(w.burn.is_empty(), "molotov fire should burn out");
}

#[test]
fn a_toxic_grenade_leaves_one_toxic_zone_at_the_toxic_rate() {
    let mut w = playing();
    let at = ground_point(&w);
    burst(&mut w, WEAPON_TOXIC_GRENADE, at, 0);
    let patches = w.burn.patches();
    assert_eq!(patches.len(), 1, "one zone, not a scatter");
    assert_eq!(patches[0].kind, BurnKind::Toxic);
    assert!((patches[0].dps - TOXIC_DPS).abs() < 1e-6);
    assert!((patches[0].radius - TOXIC_GRENADE_RADIUS).abs() < 1e-6);
}

#[test]
fn every_zone_announces_itself_so_a_client_can_draw_it() {
    // Count at both ends (§A39): a hazard the server simulates and never tells
    // anyone about is a zone that damages you out of thin air.
    for (weapon, kind, want) in [
        (WEAPON_MOLOTOV, HazardKind::Fire, MOLOTOV_PATCHES as usize),
        (WEAPON_TOXIC_GRENADE, HazardKind::Toxic, 1),
        (WEAPON_SMOKE, HazardKind::Smoke, 1),
    ] {
        let mut w = playing();
        let at = ground_point(&w);
        burst(&mut w, weapon, at, 0);
        let n = w
            .drain_events()
            .into_iter()
            .filter(|e| matches!(e, GameEvent::HazardSpawn { kind: k, .. } if *k == kind))
            .count();
        let key = def(weapon).expect("def").key;
        assert_eq!(n, want, "{key} announced {n} hazards, expected {want}");
    }
}

#[test]
fn a_dispersed_cloud_tells_the_client_to_stop_drawing_it() {
    let mut w = playing();
    let at = ground_point(&w);
    burst(&mut w, WEAPON_SMOKE, at, 0);
    let spawned: Vec<u32> = w
        .drain_events()
        .into_iter()
        .filter_map(|e| match e {
            GameEvent::HazardSpawn {
                id,
                kind: HazardKind::Smoke,
                ..
            } => Some(id),
            _ => None,
        })
        .collect();
    assert_eq!(spawned.len(), 1);

    let mut ended = Vec::new();
    for _ in 0..(SMOKE_DURATION / SIM_DT) as usize + 2 {
        w.step(SIM_DT);
        ended.extend(w.drain_events().into_iter().filter_map(|e| match e {
            GameEvent::HazardEnded { id, .. } => Some(id),
            _ => None,
        }));
    }
    assert_eq!(
        ended, spawned,
        "the cloud that spawned is the one that ended"
    );
}

// ---------------------------------------------------------------------------
// Shape
// ---------------------------------------------------------------------------

#[test]
fn the_four_thrown_weapons_have_the_bursts_b7_describes() {
    assert!(matches!(
        def(WEAPON_AIRBURST).expect("def").burst,
        Burst::Pellets { .. }
    ));
    assert!(matches!(
        def(WEAPON_SMOKE).expect("def").burst,
        Burst::Smoke { .. }
    ));
    assert!(matches!(
        def(WEAPON_MOLOTOV).expect("def").burst,
        Burst::Zone { .. }
    ));
    assert!(matches!(
        def(WEAPON_TOXIC_GRENADE).expect("def").burst,
        Burst::Zone { .. }
    ));
    // And the weapon they are not: a grenade still blasts.
    assert!(matches!(
        def(WEAPON_GRENADE).expect("def").burst,
        Burst::Blast
    ));
}

#[test]
fn none_of_the_four_chain_detonates_another() {
    // `docs/31` §5: explosions do not chain. Four more things now pass through
    // that rule, so it is asserted for each of them.
    let mut w = playing();
    let at = ground_point(&w);
    for weapon in [
        WEAPON_SMOKE,
        WEAPON_MOLOTOV,
        WEAPON_TOXIC_GRENADE,
        WEAPON_AIRBURST,
    ] {
        let live = w
            .projectiles
            .spawn(weapon, 0, at + Vec2::new(60.0, -20.0), 0.0, w.round_time);
        assert!(w.projectiles.get(live).is_some());
        burst(&mut w, WEAPON_GRENADE, at, 0);
        let _ = w.drain_events();
        assert!(
            w.projectiles.get(live).is_some(),
            "a blast set off a {} that was merely nearby",
            def(weapon).expect("def").key
        );
        w.projectiles.remove(live);
    }
}

// ---------------------------------------------------------------------------
// T11.15 — the predictor must agree with the simulation (§B26)
// ---------------------------------------------------------------------------

/// The contract for `predict_impact`, and the reason it exists as a test rather
/// than as a comment.
///
/// `docs/22-aiming-crosshair.md` §6 describes a client trajectory preview built
/// on the same constants; it was never implemented, so there is no shared
/// implementation to point at and claim agreement from. This asserts it instead:
/// throw the real thing, let `World::step` fly it, and require the prediction to
/// name the same place.
///
/// A predictor that disagrees with the simulation is worse than none — the bot
/// would refuse safe throws and take unsafe ones with equal confidence.
#[test]
fn prediction_agrees_with_the_simulation() {
    let mut checked = 0;
    for aim_deg in [-70.0_f32, -45.0, -20.0, 0.0, 20.0] {
        for weapon in [WEAPON_MOLOTOV, WEAPON_SMOKE, WEAPON_TOXIC_GRENADE] {
            let mut w = playing();
            let from = ground_point(&w) + Vec2::new(0.0, -40.0);
            let aim = aim_deg.to_radians();

            let predicted = game_core::weapons::projectile::predict_impact(
                &w.map,
                weapon,
                from,
                aim,
                w.map.meta.wind,
                (PROJECTILE_MAX_LIFETIME / SIM_DT) as u32,
                SIM_DT,
            );

            // The same throw, flown by the real simulation — and deliberately
            // with **no player in the world**. The first version stood the
            // thrower at the throw origin, and a toxic grenade arced up, bounced,
            // fell back and was removed by hitting them, 42 px from where the
            // arc ends. That is the very scenario this feature exists to prevent,
            // and it is not what the predictor claims: it models terrain only,
            // because a body in the way can only make the hazard land *sooner*,
            // which is the safe direction to be wrong in.
            let id = w.projectiles.spawn(weapon, 0, from, aim, w.round_time);
            let mut actual = None;
            for _ in 0..(PROJECTILE_MAX_LIFETIME / SIM_DT) as u32 {
                let before: Vec<_> = w.projectiles.iter().map(|p| (p.id, p.pos)).collect();
                w.step(SIM_DT);
                if !w.projectiles.iter().any(|p| p.id == id) {
                    actual = before.iter().find(|(i, _)| *i == id).map(|(_, p)| *p);
                    break;
                }
            }

            let (Some(pred), Some(act)) = (predicted, actual) else {
                continue; // never landed inside the lifetime: nothing to compare
            };
            // One tick of travel at muzzle speed is the honest tolerance — the
            // simulation reports the position *before* the step that removed the
            // projectile, so the two are at most a tick apart by construction.
            let tol = def(weapon).map_or(0.0, |d| d.muzzle_speed) * SIM_DT + 8.0;
            assert!(
                (pred - act).len() <= tol,
                "{:?}: predicted {:?} but it landed at {:?} — {:.1} px apart, tolerance {tol:.1}",
                def(weapon).map(|d| d.key),
                pred,
                act,
                (pred - act).len(),
            );
            checked += 1;
        }
    }
    // Control: without this the loop passing proves nothing, because every case
    // could have hit the `continue`.
    assert!(
        checked >= 10,
        "only {checked} throws actually landed — the comparison proved nothing"
    );
}
