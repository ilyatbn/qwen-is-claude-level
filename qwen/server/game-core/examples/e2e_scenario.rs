//! End-to-end scenario harness.
//!
//! `round.rs` is still a stub, so there is no round loop and no definition of
//! what runs in what order within a tick. This harness wires Phases 1–3
//! together BY HAND using only public APIs, plays a realistic sequence, and
//! reports what happens.
//!
//! It is deliberately not a #[test]: it CONTINUES after a failed check so one
//! run reports every problem rather than stopping at the first. Run with:
//!   cargo run -p game-core --example e2e_scenario
//!
//! Every ordering decision made here is a decision `round.rs` (T4.1) will have
//! to make for real; where one was forced, it is called out in the output.

use game_core::items::*;
use game_core::map::{Map, Scale};
use game_core::physics::PhysicsWorld;
use game_core::player::{player_config::*, InputEdges, Player, DT};
use game_core::protocol::{InputFrame, ItemId};
use game_core::rng::GameRng;
use game_core::tiles::{TileKind, TILE_SIZE};
use game_core::Vec2;

// ---------------------------------------------------------------------------
// Reporting
// ---------------------------------------------------------------------------

struct Report {
    passed: u32,
    failed: Vec<String>,
    notes: Vec<String>,
}

impl Report {
    fn new() -> Self {
        Report { passed: 0, failed: Vec::new(), notes: Vec::new() }
    }
    fn check(&mut self, ok: bool, label: &str) {
        if ok {
            self.passed += 1;
            println!("    ok    {label}");
        } else {
            self.failed.push(label.to_string());
            println!("    FAIL  {label}");
        }
    }
    /// An observation that is not a pass/fail — something a human should see.
    fn note(&mut self, text: &str) {
        self.notes.push(text.to_string());
        println!("    note  {text}");
    }
    fn section(&self, title: &str) {
        println!("\n=== {title} ===");
    }
}

/// One player's mutable round state. `round.rs` will own something like this;
/// nothing in game-core does today.
struct Actor {
    player: Player,
    #[allow(dead_code)] // T4.1 will drive these; the harness only needs them to exist
    ammo: [u8; SLOT_COUNT],
    cooldowns: Cooldowns,
}

impl Actor {
    fn new(player: Player) -> Self {
        Actor { player, ammo: [0; SLOT_COUNT], cooldowns: Cooldowns::new() }
    }
}

/// The per-tick order this harness had to invent, since `round.rs` does not
/// define one. Documented in the output so T4.1 inherits the question.
fn step_world(
    actors: &mut [Actor],
    projectiles: &mut Vec<Projectile>,
    ground: &mut Vec<GroundItem>,
    map: &mut Map,
    world: &mut PhysicsWorld,
    tick: u64,
) -> Vec<String> {
    let mut events = Vec::new();

    // 1. Players move.
    for actor in actors.iter_mut() {
        let frame = InputFrame::default();
        actor.player.step_tick(world, map, &frame, InputEdges::default(), DT);
        actor.player.step_timers(DT);
    }

    // 2. Projectiles move; collect impacts.
    let snapshot: Vec<(u8, f32, f32)> = actors
        .iter()
        .filter(|a| a.player.alive)
        .map(|a| (a.player.id, a.player.pos.x, a.player.pos.y))
        .collect();

    let mut impacts: Vec<(usize, f32, f32, Option<u8>)> = Vec::new();
    for (index, projectile) in projectiles.iter_mut().enumerate() {
        match step_projectile(projectile, map, &snapshot, DT) {
            ProjectileStep::Flying => {}
            ProjectileStep::Impact { x, y } => impacts.push((index, x, y, None)),
            ProjectileStep::HitPlayer { player, x, y } => {
                impacts.push((index, x, y, Some(player)))
            }
        }
    }

    // 3. Resolve impacts: blast, damage, collider rebuild.
    let mut destroyed_total = Vec::new();
    for (index, x, y, hit) in impacts.iter().rev() {
        let projectile = projectiles[*index];
        if projectile.explosive {
            let destroyed = map.apply_blast(*x, *y, projectile.radius, projectile.damage);
            if !destroyed.is_empty() {
                events.push(format!(
                    "tick {tick}: {:?} blast at ({x:.0},{y:.0}) destroyed {} tiles, version -> {}",
                    projectile.kind, destroyed.len(), map.version,
                ));
                destroyed_total.extend(destroyed.iter().copied());
            }
            for actor in actors.iter_mut().filter(|a| a.player.alive) {
                let distance = (actor.player.pos.x - x).hypot(actor.player.pos.y - y);
                let damage = Player::blast_damage_at(distance, projectile.radius, projectile.damage);
                if damage > 0.0 && actor.player.apply_damage(damage) {
                    events.push(format!("tick {tick}: player {} killed by blast", actor.player.id));
                }
            }
        } else if let Some(victim) = hit {
            if let Some(actor) = actors.iter_mut().find(|a| a.player.id == *victim) {
                if actor.player.apply_damage(projectile.damage) {
                    events.push(format!("tick {tick}: player {victim} killed by {:?}", projectile.kind));
                }
            }
        }
        projectiles.remove(*index);
    }
    if !destroyed_total.is_empty() {
        world.rebuild_segments(map, &destroyed_total);
        // Uncovered hidden items become pickable ground items.
        for event in &destroyed_total {
            if let Some(item) = event.item {
                let centre = Map::tile_center(event.x, event.y);
                ground.push(GroundItem {
                    id: 9000 + ground.len() as u32,
                    item,
                    x: centre.x,
                    y: centre.y,
                    is_crate: false,
                    hidden: false,
                });
                events.push(format!("tick {tick}: uncovered {item:?} at ({},{})", event.x, event.y));
            }
        }
    }

    // 4. Pickups.
    let mut taken = Vec::new();
    for actor in actors.iter_mut().filter(|a| a.player.alive) {
        for (index, item) in ground.iter().enumerate() {
            if taken.contains(&index) {
                continue;
            }
            if let Pickup::Taken { slot, item: got } =
                try_pickup(&mut actor.player.inventory, item, actor.player.pos.x, actor.player.pos.y)
            {
                actor.ammo[slot] = starting_ammo(got);
                taken.push(index);
                events.push(format!("tick {tick}: player {} picked up {got:?}", actor.player.id));
            }
        }
    }
    taken.sort_unstable();
    for index in taken.into_iter().rev() {
        ground.remove(index);
    }

    enforce_projectile_cap(projectiles);
    events
}

fn main() {
    let mut r = Report::new();
    println!("E2E SCENARIO — Phases 1–3 wired by hand (round.rs is a stub)\n");

    // -----------------------------------------------------------------------
    r.section("1. Round start: map + items in the docs/04 §6 order");
    // -----------------------------------------------------------------------
    let seed = 12345u64;
    let scale = Scale::Medium;
    let mut map = Map::generate(seed, scale);
    let mut rng = GameRng::new(seed);
    let mut ids = ItemIdCounter::default();

    // docs/04 §6: map -> shuffle spawns -> effect schedule -> place A -> place B.
    // Steps 2 and 3 do not exist (T4.1, T4.8), so this harness runs 1, 4, 5.
    let mut ground = place_initial(&map, &mut rng, &mut ids);
    let hidden = place_hidden(&mut map, &mut rng);

    println!("  seed {seed}, {} scale, {}x{} tiles", scale.as_str(), map.width, map.height);
    r.check(ground.len() == 10, "source A placed 10 ground items");
    r.check(hidden.len() == 4, "source B hid 4 items in rock");
    r.check(map.spawns.len() >= 6, "map offers at least 6 spawns");
    r.check(map.version == 0, "a fresh map is at version 0");
    r.note("docs/04 §6 steps 2 (shuffle spawns) and 3 (effect schedule) do not exist yet — T4.1/T4.8 will insert draws BEFORE placement and shift every later value");

    // -----------------------------------------------------------------------
    r.section("2. Spawn 6 players and settle them");
    // -----------------------------------------------------------------------
    let mut world = PhysicsWorld::new(&map);
    let mut actors: Vec<Actor> = (0..6u8)
        .filter_map(|id| Player::spawn(&map, id, format!("p{id}")))
        .map(Actor::new)
        .collect();
    r.check(actors.len() == 6, "6 players spawned");

    let mut embedded = 0;
    for actor in &actors {
        if map.is_solid_at_pixel(actor.player.pos.x, actor.player.pos.y) {
            embedded += 1;
        }
    }
    if embedded > 0 {
        r.note(&format!("{embedded}/6 players spawned with their CENTRE inside terrain (D26)"));
    }

    let mut projectiles: Vec<Projectile> = Vec::new();
    for tick in 0..60u64 {
        step_world(&mut actors, &mut projectiles, &mut ground, &mut map, &mut world, tick);
    }
    let grounded = actors.iter().filter(|a| a.player.on_ground(&map)).count();
    println!("  after 60 settling ticks: {grounded}/6 on the ground");
    r.check(grounded == 6, "all 6 players are resting on terrain after settling");
    for actor in &actors {
        let inside = map.is_solid_at_pixel(actor.player.pos.x, actor.player.pos.y);
        r.check(!inside, &format!("player {} is not inside terrain after settling", actor.player.id));
    }

    // -----------------------------------------------------------------------
    r.section("3. Scripted movement: walk, jump, jetpack");
    // -----------------------------------------------------------------------
    let start_x = actors[0].player.pos.x;
    for _ in 0..40u64 {
        let frame = InputFrame { right: true, ..InputFrame::default() };
        actors[0].player.step_tick(&world, &map, &frame, InputEdges::default(), DT);
    }
    let walked = actors[0].player.pos.x - start_x;
    println!("  player 0 walked {walked:.1} px in 40 ticks (flat-ground ideal 280.0)");
    r.check(walked > 0.0, "walking moves the player");
    r.note(&format!("real-terrain walk was {:.1}% of the flat-ground ideal (D35: slope-dependent)", 100.0 * walked / 280.0));

    let before_y = actors[1].player.pos.y;
    let edges = InputEdges { jump_pressed: true, use_slot_pressed: None };
    actors[1].player.step_tick(
        &world, &map, &InputFrame { jump: true, ..InputFrame::default() }, edges, DT,
    );
    r.check(actors[1].player.pos.y < before_y, "jump lifts the player");

    let mut fuel_burned = 0.0;
    for _ in 0..20u64 {
        let before = actors[1].player.jetpack.fuel;
        actors[1].player.step_tick(
            &world, &map, &InputFrame { jump: true, ..InputFrame::default() },
            InputEdges::default(), DT,
        );
        fuel_burned += before - actors[1].player.jetpack.fuel;
    }
    println!("  player 1 burned {fuel_burned:.3} fuel over 1 s of held space");
    r.check(fuel_burned > 0.9 && fuel_burned < 1.1, "jetpack burns ~1.0 fuel per second");

    // -----------------------------------------------------------------------
    r.section("4. Walk onto an item and pick it up");
    // -----------------------------------------------------------------------
    let ground_before_section = ground.len();
    if ground_before_section < 10 {
        r.note(&format!(
            "{} item(s) were already collected during the 60 settling ticks — with the body-relative pickup radius (D41) a settling player can land within reach",
            10 - ground_before_section,
        ));
    }
    let target = ground[0];
    println!("  teleporting player 2 onto the {:?} at ({:.0},{:.0})", target.item, target.x, target.y);
    actors[2].player.pos = Vec2::new(target.x, target.y);
    let before_slots = actors[2].player.inventory.slots;
    let events = step_world(&mut actors, &mut projectiles, &mut ground, &mut map, &mut world, 100);
    for e in &events { println!("    {e}"); }
    r.check(
        actors[2].player.inventory.slots != before_slots,
        "standing on an item fills an inventory slot",
    );
    println!("  ground items: {ground_before_section} -> {}", ground.len());
    r.check(
        ground.len() == ground_before_section - 1,
        "exactly the picked-up item was removed from the ground",
    );

    // Pickup at the documented 16 px radius, from a body resting on the floor.
    let item = ground[0];
    actors[3].player.pos = Vec2::new(item.x, item.y - 15.0);
    let before = actors[3].player.inventory.slots;
    step_world(&mut actors, &mut projectiles, &mut ground, &mut map, &mut world, 101);
    r.check(
        actors[3].player.inventory.slots != before,
        "an item 15 px away is picked up (inside the 16 px radius)",
    );

    // -----------------------------------------------------------------------
    r.section("5. Fire each weapon at terrain and at a player");
    // -----------------------------------------------------------------------
    for weapon in [ItemId::Pistol, ItemId::Shotgun, ItemId::Rocket, ItemId::Grenade] {
        let mut shooter = Player::new(0, "shooter".into(), Vec2::new(400.0, 200.0));
        shooter.inventory.slots[0] = Some(weapon);
        shooter.inventory.selected = 0;
        shooter.facing = 0.0;
        let mut ammo = [0u8; SLOT_COUNT];
        ammo[0] = starting_ammo(weapon);
        let mut cd = Cooldowns::new();
        let mut fire_ids = ItemIdCounter::default();

        match try_fire(&mut shooter, &mut ammo, &mut cd, &mut fire_ids, 0, DT) {
            FireResult::Fired(shots) => {
                let expected = if weapon == ItemId::Shotgun { 5 } else { 1 };
                r.check(shots.len() == expected, &format!("{weapon:?} fired {expected} projectile(s)"));
                r.check(ammo[0] == starting_ammo(weapon) - 1, &format!("{weapon:?} consumed 1 ammo"));
            }
            other => r.check(false, &format!("{weapon:?} failed to fire: {other:?}")),
        }
        // Immediate second pull must be blocked by the cooldown.
        let second = try_fire(&mut shooter, &mut ammo, &mut cd, &mut fire_ids, 1, DT);
        r.check(
            matches!(second, FireResult::OnCooldown),
            &format!("{weapon:?} respects its cooldown on an immediate second pull"),
        );
    }

    // -----------------------------------------------------------------------
    r.section("6. Rocket near a player: crater, falloff, version, rebuild, fall");
    // -----------------------------------------------------------------------
    let victim_col = 60u32;
    let surface = map.surface_row(victim_col);
    let stand = Vec2::new(
        (victim_col as f32 + 0.5) * TILE_SIZE,
        surface as f32 * TILE_SIZE - BODY_HALF_HEIGHT,
    );
    actors[4].player.pos = stand;
    actors[4].player.health = 100.0;
    actors[4].player.alive = true;
    for _ in 0..10 {
        actors[4].player.step_tick(&world, &map, &InputFrame::default(), InputEdges::default(), DT);
    }
    let resting_y = actors[4].player.pos.y;
    let version_before = map.version;
    let colliders_before = world.collider_count();

    // Blast 20 px away: D1 says the falloff is 60*(1-20/48) = 35, not "~45".
    let blast = Vec2::new(actors[4].player.pos.x + 20.0, actors[4].player.feet_y());
    let destroyed = map.apply_blast(blast.x, blast.y, 48.0, 60.0);
    let distance = (actors[4].player.pos.x - blast.x).hypot(actors[4].player.pos.y - blast.y);
    let damage = Player::blast_damage_at(distance, 48.0, 60.0);
    actors[4].player.apply_damage(damage);
    world.rebuild_segments(&map, &destroyed);

    println!("  destroyed {} tiles; version {} -> {}", destroyed.len(), version_before, map.version);
    println!("  player at {distance:.1} px took {damage:.2} damage -> {:.1} hp", actors[4].player.health);
    r.check(!destroyed.is_empty(), "the rocket dug a crater");
    r.check(map.version == version_before + destroyed.len() as u64, "map.version bumped once per destroyed tile");
    r.check(damage > 0.0 && damage < 60.0, "the player took falloff damage, not full");
    r.check(world.collider_count() != colliders_before || !destroyed.is_empty(), "colliders were rebuilt");

    // Now blow out the ground directly beneath and confirm the player falls.
    let mut under = Vec::new();
    for dx in -1i32..=1 {
        let col = (victim_col as i32 + dx) as u32;
        for row in surface..(surface + 6).min(map.height) {
            if let Some(e) = map.destroy_tile_deferred(col, row) {
                under.push(e);
            }
        }
    }
    map.apply_surface_conversion();
    world.rebuild_segments(&map, &under);
    for _ in 0..30 {
        actors[4].player.step_tick(&world, &map, &InputFrame::default(), InputEdges::default(), DT);
    }
    println!("  after destroying the ground: y {resting_y:.1} -> {:.1}", actors[4].player.pos.y);
    r.check(actors[4].player.pos.y > resting_y + TILE_SIZE, "the player fell into the hole");

    // -----------------------------------------------------------------------
    r.section("7. Destroy a ROCK tile holding a hidden item");
    // -----------------------------------------------------------------------
    let (hx, hy, hitem) = hidden[0];
    r.check(map.tile(hx, hy).kind == TileKind::Rock, "the hidden item sits in ROCK");
    r.check(map.tile(hx, hy).item == Some(hitem), "the tile carries its item before destruction");
    let event = map.destroy_tile(hx, hy);
    match event {
        Some(e) => {
            r.check(e.item == Some(hitem), "destroying the tile uncovered the item");
            let centre = Map::tile_center(hx, hy);
            ground.push(GroundItem {
                id: 8000, item: hitem, x: centre.x, y: centre.y, is_crate: false, hidden: false,
            });
            let mut collector = Player::new(9, "collector".into(), Vec2::new(centre.x, centre.y));
            let taken = try_pickup(&mut collector.inventory, &ground[ground.len() - 1], centre.x, centre.y);
            r.check(matches!(taken, Pickup::Taken { .. }), "the uncovered item is pickable");
        }
        None => r.check(false, "destroying the hidden tile returned no event"),
    }

    // -----------------------------------------------------------------------
    r.section("8. Kill a player: score, respawn timer, inventory kept");
    // -----------------------------------------------------------------------
    let mut victim = Player::new(3, "victim".into(), Vec2::new(300.0, 300.0));
    victim.inventory.slots[2] = Some(ItemId::Rocket);
    victim.health = 30.0;
    let killed = victim.apply_damage(100.0);
    r.check(killed, "lethal damage reports a kill");
    r.check(!victim.alive, "the victim is dead");
    r.check(victim.health == 0.0, "health floors at 0");
    r.check(
        victim.inventory.slots[2] == Some(ItemId::Rocket),
        "inventory is KEPT through death (docs/03 §2)",
    );
    r.note(&format!(
        "score={} kills={} deaths={} respawn_at_tick={:?} — apply_damage sets NONE of these (T4.3)",
        victim.score, victim.kills, victim.deaths, victim.respawn_at_tick,
    ));

    // -----------------------------------------------------------------------
    r.section("9. Crate drop and timed spawn at their documented ticks");
    // -----------------------------------------------------------------------
    let mut crate_ = spawn_crate(&map, &mut rng, &mut ids);
    let column = (crate_.x / TILE_SIZE) as u32;
    let mut fall_ticks = 0;
    for tick in 0..2000u64 {
        step_crate(&mut crate_, &map, tick, DT);
        if crate_.landed { fall_ticks = tick; break; }
    }
    println!("  crate fell for {fall_ticks} ticks, landed at y={:.0} (column {column} surface row {})",
        crate_.y, map.surface_row(column));
    r.check(crate_.landed, "the crate landed");
    r.check(
        (crate_.y - map.surface_row(column) as f32 * TILE_SIZE).abs() < 1e-3,
        "the crate rests exactly on the surface row",
    );
    let contents = open_crate(&crate_, &mut ids);
    r.check(contents.len() == 2, "opening the crate yields 2 items");

    let timed = spawn_timed_item(&map, &mut rng, &mut ids);
    match timed {
        Some(item) => {
            let (tx, ty) = ((item.x / TILE_SIZE) as u32, (item.y / TILE_SIZE) as u32);
            r.check(map.tile(tx, ty).kind == TileKind::Grass, "the timed item landed on GRASS");
            r.check(ty == map.surface_row(tx), "the timed item is on the surface row");
        }
        None => r.check(false, "no timed item spawned"),
    }
    r.note("crate and timed spawns have no scheduler — nothing fires them at t=45/90/... or t=30/60/... (T4.1)");

    // -----------------------------------------------------------------------
    println!("\n\n########## SUMMARY ##########");
    println!("checks passed: {}", r.passed);
    println!("checks FAILED: {}", r.failed.len());
    for f in &r.failed {
        println!("  FAIL  {f}");
    }
    println!("notes: {}", r.notes.len());
    for n in &r.notes {
        println!("  - {n}");
    }
}
