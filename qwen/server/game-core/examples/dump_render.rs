//! Dumps map data as plain text for external rendering (visual inspection only).
//! Usage: cargo run -p game-core --example dump_render -- <seed> <scale> [blast_x blast_y]
use game_core::items::{place_hidden, place_initial};
use game_core::map::{Map, Scale};
use game_core::rng::GameRng;
use game_core::tiles::TileKind;

fn main() {
    let a: Vec<String> = std::env::args().collect();
    let seed: u64 = a.get(1).map(|s| s.parse().unwrap()).unwrap_or(1);
    let scale = match a.get(2).map(|s| s.as_str()) {
        Some("medium") => Scale::Medium,
        Some("large") => Scale::Large,
        _ => Scale::Small,
    };
    let mut map = Map::generate(seed, scale);
    let mut rng = GameRng::new(seed);
    let spawns = map.spawns.clone();
    let mut ids = game_core::items::ItemIdCounter::default();
    let ground = place_initial(&map, &mut rng, &mut ids);
    let hidden = place_hidden(&mut map, &mut rng);

    if let (Some(bx), Some(by)) = (a.get(3), a.get(4)) {
        let (bx, by): (f32, f32) = (bx.parse().unwrap(), by.parse().unwrap());
        map.apply_blast(bx, by, 48.0, 60.0);
    }

    println!("META {} {} {} {}", seed, map.width, map.height, map.version);
    for y in 0..map.height {
        let row: String = (0..map.width)
            .map(|x| match map.tile(x, y).kind {
                TileKind::Air => '.',
                TileKind::Grass => 'G',
                TileKind::Dirt => 'D',
                TileKind::Stone => 'S',
                TileKind::Rock => 'R',
            })
            .collect();
        println!("ROW {}", row);
    }
    for s in &spawns { println!("SPAWN {} {}", s.x as i32, s.y as i32); }
    for g in &ground { println!("ITEM {} {} {:?}", g.x as i32, g.y as i32, g.item); }
    for h in &hidden { println!("HIDDEN {} {} {:?}", h.0, h.1, h.2); }
    for d in &map.decor { println!("DECOR {} {} {:?}", d.x, d.y, d.kind); }
}
