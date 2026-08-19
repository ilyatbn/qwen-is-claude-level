//! D42 correction: does tile hp accumulate across blasts?
use game_core::map::{Map, Scale};
use game_core::tiles::{Tile, TileKind};

fn solid(kind: TileKind) -> Map {
    let (w, h) = Scale::Small.dimensions();
    Map { seed: 0, scale: Scale::Small, width: w, height: h,
        tiles: vec![Tile::new(kind); (w * h) as usize],
        decor: vec![], spawns: vec![], version: 0 }
}

fn main() {
    for (kind, hp) in [(TileKind::Rock, 80.0f32), (TileKind::Stone, 60.0)] {
        println!("--- {kind:?} ({hp} hp) ---");
        for (weapon, dmg, radius) in [("rocket", 60.0f32, 48.0), ("grenade", 45.0, 40.0)] {
            let mut m = solid(kind);
            let c = Map::tile_center(20, 20);
            let mut shots = 0;
            for i in 1..=5 {
                let d = m.apply_blast(c.x, c.y, radius, dmg);
                let t = m.tile(20, 20);
                println!("  {weapon} #{i}: centre kind={:?} hp={:.1}  destroyed_this_blast={}",
                    t.kind, t.hp, d.len());
                if t.kind == TileKind::Air { shots = i; break; }
            }
            if shots > 0 { println!("  -> {kind:?} destroyed by {shots} direct {weapon} hit(s)"); }
            else { println!("  -> NOT destroyed by 5 {weapon} hits"); }
        }
    }
    // Crater size of ONE rocket underground (all-STONE).
    let mut m = solid(TileKind::Stone);
    let c = Map::tile_center(30, 30);
    let d = m.apply_blast(c.x, c.y, 48.0, 60.0);
    println!("\none rocket in uniform STONE: {} tiles destroyed", d.len());

    // On a REAL map at depth, neighbours may be DIRT/GRASS and die too.
    for depth in [2u32, 6, 12] {
        let mut rm = Map::generate(5, Scale::Medium);
        let col = 60u32;
        let row = rm.surface_row(col) + depth;
        let rc = Map::tile_center(col, row);
        let rd = rm.apply_blast(rc.x, rc.y, 48.0, 60.0);
        let kinds: Vec<String> = rd.iter().map(|e| format!("{:?}", e.kind)).collect();
        println!("  real map, {depth} tiles below surface: {} destroyed {:?}", rd.len(), kinds);
    }
}
