//! D35/D36 evidence: ground speed on sloped terrain, and step climbing.
use game_core::map::{Map, Scale};
use game_core::physics::PhysicsWorld;
use game_core::player::{player_config::*, InputEdges, Player, DT};
use game_core::protocol::InputFrame;
use game_core::tiles::{Tile, TileKind};
use game_core::Vec2;

/// Terrain whose surface row steps by `rise` tiles every `run` columns.
/// Positive `rise` = downhill to the right.
fn staircase(base_row: u32, rise: i32, run: u32) -> Map {
    let (w, h) = Scale::Small.dimensions();
    let mut m = Map { seed: 0, scale: Scale::Small, width: w, height: h,
        tiles: vec![Tile::AIR; (w*h) as usize], decor: vec![], spawns: vec![], version: 0 };
    for x in 0..w {
        let steps = (x / run.max(1)) as i32;
        let row = (base_row as i32 + steps * rise).clamp(4, h as i32 - 1) as u32;
        for y in row..h { m.set_tile(x, y, Tile::new(TileKind::Stone)); }
    }
    m
}

fn settled(map: &Map, world: &PhysicsWorld, x: f32) -> Player {
    let col = (x / 16.0) as u32;
    let surf = map.surface_row(col);
    let mut p = Player::new(0, "p".into(),
        Vec2::new(x, surf as f32 * 16.0 - BODY_HALF_HEIGHT - 1.0));
    for _ in 0..60 { p.step_tick(world, map, &InputFrame::default(), InputEdges::default(), DT); }
    p
}

fn walk(map: &Map, world: &PhysicsWorld, ticks: u32) -> (f32, u32, f32, f32) {
    let mut p = settled(map, world, 320.0);
    let start = p.pos.x;
    let frame = InputFrame { right: true, ..InputFrame::default() };
    let (mut air, mut maxv, mut maxpen) = (0u32, 0.0f32, 0.0f32);
    for _ in 0..ticks {
        let out = p.step_tick(world, map, &frame, InputEdges::default(), DT);
        if !out.on_ground { air += 1; }
        maxv = maxv.max(p.vel.x.abs());
        let col = (p.pos.x / 16.0) as u32;
        let surf = map.surface_row(col) as f32 * 16.0;
        maxpen = maxpen.max(p.feet_y() - surf);
    }
    (p.pos.x - start, air, maxv, maxpen)
}

fn main() {
    println!("--- D35: ground speed vs slope (10 ticks, expect 70.000 px) ---");
    println!("{:<26} {:>9} {:>9} {:>8} {:>8}", "terrain", "dx/10tk", "px/tick", "air", "max|vx|");
    for (label, rise, run) in [
        ("flat", 0, 1u32),
        ("downhill 1 tile / 4 cols", 1, 4),
        ("downhill 1 tile / 2 cols", 1, 2),
        ("downhill 1 tile / 1 col", 1, 1),
        ("uphill 1 tile / 4 cols", -1, 4),
        ("uphill 1 tile / 2 cols", -1, 2),
        ("uphill 1 tile / 1 col", -1, 1),
    ] {
        let m = staircase(40, rise, run);
        let w = PhysicsWorld::new(&m);
        let (dx, air, maxv, _) = walk(&m, &w, 10);
        println!("{label:<26} {dx:>9.3} {:>9.4} {air:>6}/10 {maxv:>8.1}", dx / 10.0);
    }

    println!("\n--- D35: long traverse on 1-tile-per-2-col downhill (200 ticks) ---");
    let m = staircase(20, 1, 2);
    let w = PhysicsWorld::new(&m);
    let (dx, air, _, _) = walk(&m, &w, 200);
    println!("  dx={dx:.2} vs flat-expected 1400.00  ratio={:.4}  airborne={air}/200", dx / 1400.0);

    println!("\n--- D36: can a player walk up a step? ---");
    for rise in [1u32, 2, 3] {
        let (wd, h) = Scale::Small.dimensions();
        let mut m = Map { seed: 0, scale: Scale::Small, width: wd, height: h,
            tiles: vec![Tile::AIR; (wd*h) as usize], decor: vec![], spawns: vec![], version: 0 };
        for x in 0..wd {
            let row = if x < 25 { 40 } else { 40 - rise };
            for y in row..h { m.set_tile(x, y, Tile::new(TileKind::Stone)); }
        }
        let w = PhysicsWorld::new(&m);
        let mut p = settled(&m, &w, 320.0);
        let frame = InputFrame { right: true, ..InputFrame::default() };
        for _ in 0..80 { p.step_tick(&w, &m, &frame, InputEdges::default(), DT); }
        println!("  rise {} tile ({} px): reached x={:.1}, step edge at {:.1} -> {}",
            rise, rise*16, p.pos.x, 25.0*16.0,
            if p.pos.x + BODY_HALF_WIDTH >= 25.0*16.0 - 0.5 && p.pos.x < 25.0*16.0 { "BLOCKED" } else { "cleared" });
    }
    // With jumping.
    let (wd, h) = Scale::Small.dimensions();
    let mut m = Map { seed: 0, scale: Scale::Small, width: wd, height: h,
        tiles: vec![Tile::AIR; (wd*h) as usize], decor: vec![], spawns: vec![], version: 0 };
    for x in 0..wd {
        let row = if x < 25 { 40 } else { 39 };
        for y in row..h { m.set_tile(x, y, Tile::new(TileKind::Stone)); }
    }
    let w = PhysicsWorld::new(&m);
    let mut p = settled(&m, &w, 320.0);
    for i in 0..80 {
        let jump = i % 20 == 0;
        let f = InputFrame { right: true, jump, ..InputFrame::default() };
        let e = InputEdges { jump_pressed: jump, use_slot_pressed: None };
        p.step_tick(&w, &m, &f, e, DT);
    }
    println!("  rise 1 tile WITH jumping: reached x={:.1} -> {}", p.pos.x,
        if p.pos.x > 25.0*16.0 { "CLEARED" } else { "blocked" });

    println!("\n--- penetration while walking on flat ground ---");
    let m = staircase(40, 0, 1);
    let w = PhysicsWorld::new(&m);
    let (dx, _, _, pen) = walk(&m, &w, 120);
    println!("  120 ticks: dx={dx:.3} (expect 840.000)  max penetration={pen:.3} px");
}
