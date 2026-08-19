//! Probe interactions through the PRODUCTION tick that the old test helper
//! never exercised. The helper only ever ran jetpack -> horizontal.
use game_core::map::{Map, Scale};
use game_core::physics::PhysicsWorld;
use game_core::player::{player_config::*, InputEdges, Player, DT};
use game_core::protocol::InputFrame;
use game_core::tiles::{Tile, TileKind};
use game_core::Vec2;

fn flat(floor_row: u32) -> Map {
    let (width, height) = Scale::Small.dimensions();
    let mut m = Map { seed: 0, scale: Scale::Small, width, height,
        tiles: vec![Tile::AIR; (width * height) as usize],
        decor: vec![], spawns: vec![], version: 0 };
    for y in floor_row..height { for x in 0..width { m.set_tile(x, y, Tile::new(TileKind::Stone)); } }
    m
}

fn settled(map: &Map, world: &PhysicsWorld, floor_row: u32) -> Player {
    let mut p = Player::new(0, "p".into(),
        Vec2::new(320.0, floor_row as f32 * 16.0 - BODY_HALF_HEIGHT));
    for _ in 0..40 {
        p.step_tick(world, map, &InputFrame::default(), InputEdges::default(), DT);
    }
    p
}

fn main() {
    let floor_row = 40;
    let map = flat(floor_row);
    let world = PhysicsWorld::new(&map);

    // --- 1. directional jump: docs/03 §4 requires vel.x = 140 * 0.5 = 70 ---
    let mut p = settled(&map, &world, floor_row);
    let frame = InputFrame { right: true, jump: true, ..InputFrame::default() };
    let edges = InputEdges { jump_pressed: true, use_slot_pressed: None };
    let out = p.step_tick(&world, &map, &frame, edges, DT);
    println!("jump+right      vel.x = {:>7.2}  (docs/03 §4: 70.0)   jumped={}", p.vel.x, out.jumped);

    let mut p = settled(&map, &world, floor_row);
    let frame = InputFrame { left: true, jump: true, ..InputFrame::default() };
    let out = p.step_tick(&world, &map, &frame, edges, DT);
    println!("jump+left       vel.x = {:>7.2}  (docs/03 §4: -70.0)  jumped={}", p.vel.x, out.jumped);

    // --- 2. plain jump: vel.y must be JUMP_VY before gravity ---
    let mut p = settled(&map, &world, floor_row);
    let frame = InputFrame { jump: true, ..InputFrame::default() };
    p.step_tick(&world, &map, &frame, edges, DT);
    println!("jump (no dir)   vel.y = {:>7.2}  (JUMP_VY -330 + gravity*dt = -285)", p.vel.y);

    // --- 3. jump + jetpack same tick: jetpack must NOT fire on the ground ---
    let mut p = settled(&map, &world, floor_row);
    let frame = InputFrame { jump: true, up: true, ..InputFrame::default() };
    let out = p.step_tick(&world, &map, &frame, edges, DT);
    println!("jump+W same tick jetpack_active={} fuel={:.3} (must be false / 5.000)",
        out.jetpack_active, p.jetpack.fuel);

    // --- 4. jump into a low ceiling ---
    let mut ceil_map = flat(floor_row);
    for x in 0..ceil_map.width { ceil_map.set_tile(x, floor_row - 3, Tile::new(TileKind::Stone)); }
    let ceil_world = PhysicsWorld::new(&ceil_map);
    let mut p = settled(&ceil_map, &ceil_world, floor_row);
    let frame = InputFrame { jump: true, ..InputFrame::default() };
    p.step_tick(&ceil_world, &ceil_map, &frame, edges, DT);
    let mut hit = false;
    for _ in 0..10 {
        let o = p.step_tick(&ceil_world, &ceil_map, &InputFrame::default(), InputEdges::default(), DT);
        if o.blocked_y { hit = true; }
    }
    println!("jump to ceiling blocked_y seen={hit} vel.y={:.2} (must be >= 0 after bonk)", p.vel.y);

    // --- 5. airborne jetpack through step_tick ---
    let mut p = settled(&map, &world, floor_row);
    let frame = InputFrame { jump: true, ..InputFrame::default() };
    p.step_tick(&world, &map, &frame, edges, DT);  // jump
    let held = InputFrame { jump: true, ..InputFrame::default() };
    let mut burned = 0.0f32;
    for _ in 0..10 {
        let before = p.jetpack.fuel;
        p.step_tick(&world, &map, &held, InputEdges::default(), DT);
        burned += before - p.jetpack.fuel;
    }
    println!("airborne jet    fuel burned over 10 ticks = {burned:.3} (expect 0.500)");
}
