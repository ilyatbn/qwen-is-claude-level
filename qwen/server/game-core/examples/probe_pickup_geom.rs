//! Why can a player standing on a surface tile not pick up the item on it?
use game_core::items::*;
use game_core::map::{Map, Scale};
use game_core::player::player_config::*;
use game_core::tiles::TILE_SIZE;

fn main() {
    let surface_row = 40u32;
    let col = 20u32;

    // docs/04 §3 row A: "place item at tile center".
    let item = Map::tile_center(col, surface_row);
    // docs/01 §3 step 5 + D25: feet rest on the tile TOP edge.
    let player_y = surface_row as f32 * TILE_SIZE - BODY_HALF_HEIGHT;
    let player_x = (col as f32 + 0.5) * TILE_SIZE;

    println!("tile row {surface_row}: top edge y = {}", surface_row as f32 * TILE_SIZE);
    println!("  item at tile CENTRE      y = {:.1}", item.y);
    println!("  player CENTRE (feet on top) y = {:.1}  (body half-height {BODY_HALF_HEIGHT})", player_y);
    let dy = (item.y - player_y).abs();
    println!("  vertical separation      = {dy:.1} px");
    println!("  PICKUP_RADIUS            = {PICKUP_RADIUS} px");
    println!("  reachable?               = {}", dy <= PICKUP_RADIUS);
    println!();
    println!("  the gap is exactly BODY_HALF_HEIGHT + TILE_SIZE/2 = {} + {} = {}",
        BODY_HALF_HEIGHT, TILE_SIZE / 2.0, BODY_HALF_HEIGHT + TILE_SIZE / 2.0);
    println!();

    // What DOES reach it?
    println!("what a player would need to reach a surface-tile-centre item:");
    println!("  pickup radius >= {:.1} px  (currently {PICKUP_RADIUS})", dy);
    println!("  or item placed at the tile TOP instead of centre -> dy = {:.1}", BODY_HALF_HEIGHT);
    println!();

    // Crates land ON the tile top, not the centre — check those.
    let crate_y = surface_row as f32 * TILE_SIZE;
    println!("a landed CRATE sits at the tile TOP: y = {crate_y:.1}, dy = {:.1} -> reachable = {}",
        (crate_y - player_y).abs(), (crate_y - player_y).abs() <= PICKUP_RADIUS);
    println!();

    // Real map sweep: how many source-A items are reachable by a standing player?
    let mut reachable = 0;
    let mut total = 0;
    for seed in 0..50u64 {
        let map = Map::generate(seed, Scale::Medium);
        let mut rng = game_core::rng::GameRng::new(seed);
        let mut ids = ItemIdCounter::default();
        for g in place_initial(&map, &mut rng, &mut ids) {
            total += 1;
            let ty = (g.y / TILE_SIZE) as u32;
            let py = ty as f32 * TILE_SIZE - BODY_HALF_HEIGHT;
            let mut inv = Inventory::new();
            if matches!(try_pickup(&mut inv, &g, g.x, py), Pickup::Taken { .. }) {
                reachable += 1;
            }
        }
    }
    println!("source-A items reachable by a player standing on their tile: {reachable}/{total}");
}
