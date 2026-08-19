//! Destroyed-tile counts for a fixed blast on a uniform DIRT map.
//! Used to pick a discriminating assertion for D22.
use game_core::map::{Map, Scale};
use game_core::tiles::{Tile, TileKind};

fn uniform(kind: TileKind) -> Map {
    let (width, height) = Scale::Small.dimensions();
    Map {
        seed: 0,
        scale: Scale::Small,
        width,
        height,
        tiles: vec![Tile::new(kind); (width * height) as usize],
        decor: Vec::new(),
        spawns: Vec::new(),
        version: 0,
    }
}

fn main() {
    let center = Map::tile_center(20, 20);
    println!("blast r=48 at tile (20,20) on uniform DIRT (30 hp), GRASS=20 hp");
    for max_damage in [25.0f32, 35.0, 45.0, 55.0, 65.0] {
        let mut map = uniform(TileKind::Dirt);
        let destroyed = map.apply_blast(center.x, center.y, 48.0, max_damage);
        let air = map.tiles.iter().filter(|t| t.kind == TileKind::Air).count();
        println!(
            "  max_damage={max_damage:<5} destroyed={:<3} air_tiles={air:<3} version={}",
            destroyed.len(),
            map.version
        );
    }
}
