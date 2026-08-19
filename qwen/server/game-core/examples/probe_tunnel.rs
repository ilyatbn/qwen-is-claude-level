//! Re-run the anti-tunneling battery against the CHANGED collision path.
use game_core::map::{Map, Scale};
use game_core::physics::PhysicsWorld;
use game_core::player::{player_config::*, InputEdges, Player, DT};
use game_core::protocol::InputFrame;
use game_core::tiles::{Tile, TileKind};
use game_core::Vec2;

fn floor_at(rows: &[u32]) -> Map {
    let (w, h) = Scale::Small.dimensions();
    let mut m = Map { seed: 0, scale: Scale::Small, width: w, height: h,
        tiles: vec![Tile::AIR; (w*h) as usize], decor: vec![], spawns: vec![], version: 0 };
    for &r in rows { for x in 0..w { m.set_tile(x, r, Tile::new(TileKind::Stone)); } }
    m
}

fn main() {
    println!("--- 1-tile floor at row 40, body dropped at increasing speeds ---");
    for speed in [45.0f32, 46.125, 100.0, 500.0, 2000.0, 10000.0] {
        let map = floor_at(&[40]);
        let world = PhysicsWorld::new(&map);
        let mut p = Player::new(0, "p".into(), Vec2::new(320.0, 100.0));
        p.vel.y = speed / DT; // px/s that yields `speed` px per tick
        let mut through = false;
        for _ in 0..200 {
            p.step_tick(&world, &map, &InputFrame::default(), InputEdges::default(), DT);
            if p.feet_y() > 640.0 + 2.0 { through = true; break; }
        }
        println!("  {speed:>9.3} px/tick -> tunneled={} feet={:.3} vel.y={:.2}",
            through, p.feet_y(), p.vel.y);
    }

    println!("\n--- 1x1 ledge, high speed ---");
    let (w, h) = Scale::Small.dimensions();
    let mut m = Map { seed: 0, scale: Scale::Small, width: w, height: h,
        tiles: vec![Tile::AIR; (w*h) as usize], decor: vec![], spawns: vec![], version: 0 };
    m.set_tile(20, 40, Tile::new(TileKind::Stone));
    let world = PhysicsWorld::new(&m);
    let mut p = Player::new(0, "p".into(), Vec2::new(20.5*16.0, 100.0));
    p.vel.y = 5000.0 / DT;
    let mut through = false;
    for _ in 0..200 {
        p.step_tick(&world, &m, &InputFrame::default(), InputEdges::default(), DT);
        if p.feet_y() > 640.0 + 2.0 { through = true; break; }
    }
    println!("  ledge: tunneled={through} feet={:.3}", p.feet_y());

    println!("\n--- resting stability on a 1-tile floor (200 ticks) ---");
    let map = floor_at(&[40]);
    let world = PhysicsWorld::new(&map);
    let mut p = Player::new(0, "p".into(), Vec2::new(320.0, 640.0 - BODY_HALF_HEIGHT));
    let y0 = p.pos.y;
    for _ in 0..200 { p.step_tick(&world, &map, &InputFrame::default(), InputEdges::default(), DT); }
    println!("  drift={:.4} px  vel.y={:.4}", p.pos.y - y0, p.vel.y);

    println!("\n--- floor destroyed under a resting player ---");
    let mut map = floor_at(&[40, 45]);
    let mut world = PhysicsWorld::new(&map);
    let mut p = Player::new(0, "p".into(), Vec2::new(320.0, 640.0 - BODY_HALF_HEIGHT));
    for _ in 0..20 { p.step_tick(&world, &map, &InputFrame::default(), InputEdges::default(), DT); }
    let before = p.pos.y;
    let mut destroyed = vec![];
    for x in 0..map.width { if let Some(e) = map.destroy_tile_deferred(x, 40) { destroyed.push(e); } }
    map.apply_surface_conversion();
    world.rebuild_segments(&map, &destroyed);
    for _ in 0..40 { p.step_tick(&world, &map, &InputFrame::default(), InputEdges::default(), DT); }
    println!("  fell {:.2} px, caught at feet={:.3} (row 45 top = {})",
        p.pos.y - before, p.feet_y(), 45*16);
}
