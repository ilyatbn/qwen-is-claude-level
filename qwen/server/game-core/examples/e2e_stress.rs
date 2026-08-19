//! Adversarial end-to-end pass: the interactions unit tests cannot reach.
//!
//! The happy-path harness (`e2e_scenario`) passes 48/48. This one hunts for
//! failures in the seams: realistic-terrain tunnelling, geometry near the
//! floor-penetration margin, long-run stability, resource caps, timer drift,
//! and places where two subsystems each assume the other acted.
//!
//! Reports and continues; fixes nothing.
//!   cargo run -p game-core --example e2e_stress

use game_core::items::*;
use game_core::map::{Map, Scale};
use game_core::physics::PhysicsWorld;
use game_core::player::{player_config::*, InputEdges, Player, DT};
use game_core::protocol::{InputFrame, ItemId};
use game_core::rng::GameRng;
use game_core::tiles::TILE_SIZE;
use game_core::Vec2;

struct R { pass: u32, fails: Vec<String>, notes: Vec<String> }
impl R {
    fn new() -> Self { R { pass: 0, fails: vec![], notes: vec![] } }
    fn check(&mut self, ok: bool, l: &str) {
        if ok { self.pass += 1; println!("    ok    {l}"); }
        else { self.fails.push(l.into()); println!("    FAIL  {l}"); }
    }
    fn note(&mut self, t: &str) { self.notes.push(t.into()); println!("    note  {t}"); }
}

fn main() {
    let mut r = R::new();
    println!("E2E STRESS — hunting for seam failures\n");

    // =======================================================================
    println!("=== A. Projectile tunnelling on REAL generated terrain ===");
    // =======================================================================
    // Not a synthetic wall: fire across actual maps and count shots that end
    // up on the far side of terrain they passed through.
    for weapon in [ItemId::Pistol, ItemId::Rocket] {
        let (mut fired, mut passed_through) = (0u32, 0u32);
        for seed in 0..40u64 {
            let map = Map::generate(seed, Scale::Medium);
            let mut ids = ItemIdCounter::default();
            // Fire horizontally from mid-air across the map at surface height.
            for col in (20..140).step_by(17) {
                let surface = map.surface_row(col);
                if surface >= map.height { continue; }
                let y = surface as f32 * TILE_SIZE - 8.0;
                let x = col as f32 * TILE_SIZE;
                let mut shots = fire_weapon(weapon, 0, x, y, 0.0, &mut ids);
                let p = &mut shots[0];
                fired += 1;
                let mut prev = (p.x, p.y);
                for _ in 0..80 {
                    match step_projectile(p, &map, &[], DT) {
                        ProjectileStep::Flying => {
                            // Did the straight segment cross a solid tile that
                            // the point sample skipped?
                            let steps = 8;
                            for s in 1..steps {
                                let t = s as f32 / steps as f32;
                                let sx = prev.0 + (p.x - prev.0) * t;
                                let sy = prev.1 + (p.y - prev.1) * t;
                                if map.is_solid_at_pixel(sx, sy) {
                                    passed_through += 1;
                                    break;
                                }
                            }
                            prev = (p.x, p.y);
                        }
                        _ => break,
                    }
                }
            }
        }
        let pct = 100.0 * passed_through as f32 / fired as f32;
        println!("  {weapon:?}: {fired} shots, {passed_through} crossed solid terrain undetected ({pct:.1}%)");
        r.note(&format!("{weapon:?} tunnelled through real terrain on {pct:.1}% of shots (D39)"));
    }

    // =======================================================================
    println!("\n=== B. Pickup geometry against the ~1.1 px floor penetration ===");
    // =======================================================================
    // An item sits at a tile centre; a WALKING player's feet sink ~1.1 px into
    // the floor. Does the 16 px radius still reach a surface item reliably?
    let map = Map::generate(7, Scale::Small);
    let world = PhysicsWorld::new(&map);
    let mut reached = 0;
    let mut missed = 0;
    for col in 10..80u32 {
        let surface = map.surface_row(col);
        if surface >= map.height { continue; }
        let centre = Map::tile_center(col, surface);
        let mut p = Player::new(0, "p".into(), Vec2::new(centre.x, surface as f32 * TILE_SIZE - BODY_HALF_HEIGHT));
        // Settle, then walk, so the body is in its penetrating steady state.
        for _ in 0..20 { p.step_tick(&world, &map, &InputFrame::default(), InputEdges::default(), DT); }
        for _ in 0..3 {
            p.step_tick(&world, &map, &InputFrame { right: true, ..InputFrame::default() }, InputEdges::default(), DT);
        }
        let item = GroundItem { id: 0, item: ItemId::Medkit, x: centre.x, y: centre.y, is_crate: false, hidden: false };
        let mut inv = game_core::items::Inventory::new();
        match try_pickup(&mut inv, &item, p.pos.x, p.pos.y) {
            Pickup::Taken { .. } => reached += 1,
            _ => missed += 1,
        }
    }
    println!("  walking player over a surface item: {reached} reached, {missed} missed");
    r.check(missed == 0, "a walking player always reaches an item on the tile they stand on");
    if missed > 0 {
        r.note(&format!("{missed} surface items unreachable while walking — pickup radius vs body geometry"));
    }

    // =======================================================================
    println!("\n=== C. Full 240 s round: 4800 ticks, 6 players, sustained fire ===");
    // =======================================================================
    let seed = 999u64;
    let mut map = Map::generate(seed, Scale::Medium);
    let mut rng = GameRng::new(seed);
    let mut ids = ItemIdCounter::default();
    let mut ground = place_initial(&map, &mut rng, &mut ids);
    let _hidden = place_hidden(&mut map, &mut rng);
    let mut world = PhysicsWorld::new(&map);

    let mut players: Vec<Player> = (0..6u8)
        .filter_map(|id| Player::spawn(&map, id, format!("p{id}")))
        .collect();
    let mut ammo: Vec<[u8; SLOT_COUNT]> = vec![[0; SLOT_COUNT]; 6];
    let mut cds: Vec<Cooldowns> = (0..6).map(|_| Cooldowns::new()).collect();
    // Arm everyone with a rocket so blasts happen constantly.
    for (i, p) in players.iter_mut().enumerate() {
        p.inventory.slots[0] = Some(ItemId::Rocket);
        p.inventory.selected = 0;
        ammo[i][0] = 99; // deliberately over the documented 6
    }
    let mut projectiles: Vec<Projectile> = Vec::new();
    let mut max_projectiles = 0usize;
    let mut total_destroyed = 0usize;
    let mut deaths = 0usize;

    for tick in 0..4800u64 {
        for i in 0..players.len() {
            if !players[i].alive { continue; }
            let frame = InputFrame { right: tick % 40 < 20, jump: tick % 97 == 0, ..InputFrame::default() };
            let edges = InputEdges { jump_pressed: tick % 97 == 0, use_slot_pressed: None };
            players[i].step_tick(&world, &map, &frame, edges, DT);
            players[i].step_timers(DT);
            players[i].facing = (tick as f32 * 0.07 + i as f32).sin();
            let mut player = players[i].clone();
            if let FireResult::Fired(shots) =
                try_fire(&mut player, &mut ammo[i], &mut cds[i], &mut ids, tick, DT)
            {
                projectiles.extend(shots);
            }
            players[i] = player;
        }
        enforce_projectile_cap(&mut projectiles);
        max_projectiles = max_projectiles.max(projectiles.len());

        let snap: Vec<(u8, f32, f32)> = players.iter().filter(|p| p.alive)
            .map(|p| (p.id, p.pos.x, p.pos.y)).collect();
        let mut impacts = vec![];
        for (idx, proj) in projectiles.iter_mut().enumerate() {
            match step_projectile(proj, &map, &snap, DT) {
                ProjectileStep::Flying => {}
                ProjectileStep::Impact { x, y } | ProjectileStep::HitPlayer { x, y, .. } => {
                    impacts.push((idx, x, y));
                }
            }
        }
        let mut destroyed_all = vec![];
        for (idx, x, y) in impacts.iter().rev() {
            let proj = projectiles[*idx];
            if proj.explosive {
                let d = map.apply_blast(*x, *y, proj.radius, proj.damage);
                total_destroyed += d.len();
                destroyed_all.extend(d);
                for p in players.iter_mut().filter(|p| p.alive) {
                    let dist = (p.pos.x - x).hypot(p.pos.y - y);
                    let dmg = Player::blast_damage_at(dist, proj.radius, proj.damage);
                    if dmg > 0.0 && p.apply_damage(dmg) { deaths += 1; }
                }
            }
            projectiles.remove(*idx);
        }
        if !destroyed_all.is_empty() {
            world.rebuild_segments(&map, &destroyed_all);
        }

        // Pickups.
        let mut taken = vec![];
        for (i, p) in players.iter_mut().enumerate() {
            if !p.alive { continue; }
            for (gi, g) in ground.iter().enumerate() {
                if taken.contains(&gi) { continue; }
                if let Pickup::Taken { slot, item } = try_pickup(&mut p.inventory, g, p.pos.x, p.pos.y) {
                    ammo[i][slot] = starting_ammo(item);
                    taken.push(gi);
                }
            }
        }
        taken.sort_unstable();
        for gi in taken.into_iter().rev() { ground.remove(gi); }
    }

    println!("  4800 ticks completed without panic");
    println!("  peak live projectiles: {max_projectiles} (cap {MAX_PROJECTILES})");
    println!("  tiles destroyed: {total_destroyed}, final map.version: {}", map.version);
    println!("  deaths: {deaths}, alive at end: {}", players.iter().filter(|p| p.alive).count());
    println!("  colliders at end: {}", world.collider_count());
    r.check(max_projectiles <= MAX_PROJECTILES, "the projectile cap held over a full round");
    r.check(map.version as usize == total_destroyed, "map.version equals total tiles destroyed");

    let mut sane = true;
    for p in &players {
        if !p.pos.x.is_finite() || !p.pos.y.is_finite() { sane = false; }
        if !p.health.is_finite() || p.health < 0.0 { sane = false; }
        if p.jetpack.fuel < -1e-3 || p.jetpack.fuel > JETPACK_FUEL_MAX + 1e-3 { sane = false; }
    }
    r.check(sane, "all player state finite and in range after 4800 ticks");
    let escaped = players.iter().filter(|p| {
        let (w, h) = map.pixel_size();
        p.pos.x < -100.0 || p.pos.x > w + 100.0 || p.pos.y > h + 200.0
    }).count();
    if escaped > 0 {
        r.note(&format!("{escaped}/6 players ended outside the map bounds"));
    }

    // =======================================================================
    println!("\n=== D. Ammo array vs inventory: who owns the truth? ===");
    // =======================================================================
    // try_fire removes the weapon at ammo 0 but never clears ammo[slot];
    // nothing resets ammo when a NEW item lands in a reused slot.
    let mut p = Player::new(0, "p".into(), Vec2::ZERO);
    p.inventory.slots[0] = Some(ItemId::Pistol);
    p.inventory.selected = 0;
    let mut a = [0u8; SLOT_COUNT];
    a[0] = 1;
    let mut cd = Cooldowns::new();
    let mut i2 = ItemIdCounter::default();
    let _ = try_fire(&mut p, &mut a, &mut cd, &mut i2, 0, DT);
    println!("  after firing the last pistol round: slot={:?} ammo[0]={}", p.inventory.slots[0], a[0]);
    r.check(p.inventory.slots[0].is_none(), "the emptied weapon left the slot");

    // Now a medkit is picked into that slot. Ammo is stale but harmless...
    p.inventory.slots[0] = Some(ItemId::Medkit);
    println!("  a medkit now occupies slot 0; ammo[0]={} (stale from the pistol)", a[0]);
    let can_fire = try_fire(&mut p, &mut a, &mut cd, &mut i2, 100, DT);
    println!("  try_fire with a medkit selected: {can_fire:?}");
    r.check(matches!(can_fire, FireResult::NoWeapon), "a consumable in a reused slot cannot be fired");

    // ...but a WEAPON picked into a reused slot inherits the stale count.
    let mut p2 = Player::new(0, "p".into(), Vec2::ZERO);
    p2.inventory.slots[0] = Some(ItemId::Rocket);
    p2.inventory.selected = 0;
    let mut a2 = [0u8; SLOT_COUNT];
    a2[0] = 30; // stale pistol ammo
    let mut cd2 = Cooldowns::new();
    let fired = try_fire(&mut p2, &mut a2, &mut cd2, &mut i2, 0, DT);
    println!("  rocket in a slot with stale ammo 30: {:?}, ammo now {}", 
        if matches!(fired, FireResult::Fired(_)) { "Fired" } else { "blocked" }, a2[0]);
    r.note("try_fire/try_pickup do not own ammo[] — a caller that fails to reset it inherits stale counts. Round::RoundPlayer now owns and resets it (T4.1); this section checks the RAW API still behaves as documented for any other caller.");

    // =======================================================================
    println!("\n=== E. Ordering hazards nothing enforces ===");
    // =======================================================================
    // E1: blast without rebuild — colliders go stale and a player walks on air.
    let mut m = Map::generate(11, Scale::Small);
    let w_stale = PhysicsWorld::new(&m);
    let col = 40u32;
    let surf = m.surface_row(col);
    let mut walker = Player::new(0, "w".into(), Vec2::new((col as f32 + 0.5) * TILE_SIZE, surf as f32 * TILE_SIZE - BODY_HALF_HEIGHT));
    for _ in 0..10 { walker.step_tick(&w_stale, &m, &InputFrame::default(), InputEdges::default(), DT); }
    let before = walker.pos.y;
    let mut destroyed = vec![];
    for dx in -1i32..=1 {
        for row in surf..(surf + 6).min(m.height) {
            if let Some(e) = m.destroy_tile_deferred((col as i32 + dx) as u32, row) { destroyed.push(e); }
        }
    }
    m.apply_surface_conversion();
    // DELIBERATELY skip world.rebuild_segments.
    for _ in 0..30 { walker.step_tick(&w_stale, &m, &InputFrame::default(), InputEdges::default(), DT); }
    println!("  ground destroyed, colliders NOT rebuilt: player y {before:.0} -> {:.0}", walker.pos.y);
    let floating = (walker.pos.y - before).abs() < 1.0;
    r.note(&format!(
        "skipping rebuild_segments leaves the player {} — the raw API cannot detect a stale collider set. Round::step now always rebuilds (T4.1); this checks the hazard still exists for any other caller.",
        if floating { "STANDING ON AIR" } else { "falling (harmless here)" },
    ));

    // E2: on_ground uses the MAP, collision uses the WORLD — they can disagree.
    let probe_says_ground = walker.on_ground(&m);
    println!("  tile probe says on_ground={probe_says_ground} while colliders are stale");
    if floating && probe_says_ground {
        r.note("tile probe and collider set disagree: probe reads AIR, colliders still solid");
    }

    // =======================================================================
    println!("\n=== F. Timer drift over a long round ===");
    // =======================================================================
    let mut t = Player::new(0, "t".into(), Vec2::ZERO);
    t.apply_shield();
    t.apply_overcharge();
    let mut shield_ended = None;
    let mut oc_ended = None;
    for tick in 0..1000u64 {
        t.step_timers(DT);
        if shield_ended.is_none() && !t.shield.active { shield_ended = Some(tick); }
        if oc_ended.is_none() && !t.overcharge.active { oc_ended = Some(tick); }
    }
    println!("  shield ended at tick {shield_ended:?} (20 s = 400), overcharge at {oc_ended:?} (10 s = 200)");
    r.check(matches!(shield_ended, Some(t) if (399..=402).contains(&t)), "shield expires within a tick of 20 s");
    r.check(matches!(oc_ended, Some(t) if (199..=202).contains(&t)), "overcharge expires within a tick of 10 s");
    r.check(t.max_health == 100.0 && t.health <= 100.0, "overcharge expiry restored max_health");

    // =======================================================================
    println!("\n=== G. Self-damage and the kill-credit gap ===");
    // =======================================================================
    let mut shooter = Player::new(4, "s".into(), Vec2::new(200.0, 200.0));
    shooter.health = 40.0;
    let dmg = Player::blast_damage_at(0.0, 48.0, 60.0);
    let died = shooter.apply_damage(dmg);
    println!("  a player standing on their own rocket blast took {dmg} and died={died}");
    r.check(died, "self-damage can kill (docs/04 §2)");
    r.note("apply_damage still takes no killer — by design. Round::kill carries DamageSource and applies both rules (T4.3); apply_damage owns health only, so weapons, weather and self-damage share one path.");

    // =======================================================================
    println!("\n=== H. Phase 4: a full round through Round::step ===");
    // =======================================================================
    // The five seams above are raw-API hazards. This section drives the whole
    // round through round.rs, which is what owns them now.
    {
        use game_core::round::{Event, Round, RoundState};
        let mut round = Round::new(4242, Scale::Medium);
        for id in 0..6 {
            round.join(format!("p{id}"));
        }
        round.start_round(4242, Scale::Medium);

        let (mut kills, mut respawns, mut crates, mut items, mut destroyed) = (0usize, 0usize, 0usize, 0usize, 0usize);
        let mut snapshots = 0usize;
        for tick in 0..4800u64 {
            let frame = InputFrame {
                right: tick % 40 < 20,
                left: tick % 40 >= 20,
                jump: tick % 61 == 0,
                fire: tick % 11 == 0,
                aim: (tick as f32 * 0.07).sin(),
                ..InputFrame::default()
            };
            let inputs: Vec<(u8, InputFrame)> =
                (0..6u8).map(|id| (id, InputFrame { tick, ..frame })).collect();
            for event in round.step(&inputs) {
                match event {
                    Event::Kill { .. } => kills += 1,
                    Event::Respawned { .. } => respawns += 1,
                    Event::CrateDropped { .. } => crates += 1,
                    Event::ItemSpawned { .. } => items += 1,
                    Event::TileDestroyed { tiles, .. } => destroyed += tiles.len(),
                    _ => {}
                }
            }
            if round.should_broadcast_snapshot() {
                snapshots += 1;
            }
        }

        println!("  4800 ticks: {kills} kills, {respawns} respawns, {crates} crate drops,");
        println!("  {items} items spawned, {destroyed} tiles destroyed, {snapshots} snapshots");
        r.check(round.state == RoundState::Ended, "the round reached Ended at 240 s");
        r.check(crates == 5, "all 5 documented crate drops fired");
        r.check(snapshots == 2400, "snapshots ran at 10 Hz across the whole round");
        r.check(
            round.map.version as usize == destroyed,
            "map.version tracked every destroyed tile",
        );

        let (w, h) = round.map.pixel_size();
        let mut sane = true;
        let mut off_map = 0;
        let mut stale_ammo = 0;
        for rp in &round.players {
            let p = &rp.player;
            if !p.pos.x.is_finite() || !p.pos.y.is_finite() { sane = false; }
            if p.health < 0.0 || !p.health.is_finite() { sane = false; }
            if p.pos.x < -50.0 || p.pos.x > w + 50.0 || p.pos.y > h + 200.0 { off_map += 1; }
            for (slot, held) in p.inventory.slots.iter().enumerate() {
                if let Some(item) = held {
                    let max = starting_ammo(*item);
                    if max > 0 && rp.ammo[slot] > max { stale_ammo += 1; }
                }
            }
        }
        r.check(sane, "all player state finite and in range after a full round");
        r.check(off_map == 0, "no player ended outside the map (was 1/6 before T4.1)");
        r.check(stale_ammo == 0, "no slot holds more ammo than its weapon can carry");

        let json = serde_json::to_string(&round.snapshot()).expect("snapshot serializes");
        let back: game_core::protocol::Snapshot =
            serde_json::from_str(&json).expect("snapshot round-trips");
        r.check(back.players.len() == 6, "the snapshot always carries 6 players");
        r.check(back.map_version == round.map.version, "the snapshot carries the live map version");
    }

    println!("\n\n########## SUMMARY ##########");
    println!("checks passed: {}", r.pass);
    println!("checks FAILED: {}", r.fails.len());
    for f in &r.fails { println!("  FAIL  {f}"); }
    println!("\nfindings ({}):", r.notes.len());
    for n in &r.notes { println!("  - {n}"); }
}
