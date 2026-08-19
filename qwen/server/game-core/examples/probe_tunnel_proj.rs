//! D39 evidence: do projectiles pass through a 1-tile wall / a player?
//! Swept across 64 sub-tile starting offsets so the result is not an
//! alignment artefact.
use game_core::items::*;
use game_core::map::{Map, Scale};
use game_core::player::DT;
use game_core::protocol::ItemId;
use game_core::tiles::{Tile, TileKind};

fn wall_map(col: u32) -> Map {
    let (w, h) = Scale::Small.dimensions();
    let mut m = Map { seed: 0, scale: Scale::Small, width: w, height: h,
        tiles: vec![Tile::AIR; (w * h) as usize], decor: vec![], spawns: vec![], version: 0 };
    for y in 0..h { m.set_tile(col, y, Tile::new(TileKind::Stone)); }
    m
}

fn main() {
    // Wall 80 px away: inside EVERY weapon range (shotgun is only 260 px,
    // so a distant wall makes it expire before arriving - an artefact).
    let wall_col = 25u32;
    let wall_x = wall_col as f32 * 16.0;
    println!("{:<9} {:>8}  {:>16}  {:>22}", "weapon", "px/tick", "hits 1-tile wall", "hits 12px player");
    for weapon in [ItemId::Pistol, ItemId::Shotgun, ItemId::Rocket, ItemId::Grenade] {
        let speed = game_core::items::def(weapon).projectile_speed.unwrap();
        let map = wall_map(wall_col);
        let open = {
            let (w, h) = Scale::Small.dimensions();
            Map { seed: 0, scale: Scale::Small, width: w, height: h,
                tiles: vec![Tile::AIR; (w * h) as usize], decor: vec![], spawns: vec![], version: 0 }
        };
        let (mut wall_hits, mut player_hits) = (0u32, 0u32);
        for off in 0..64u32 {
            let start_x = 320.0 + off as f32 * 16.0 / 64.0;  // sub-tile sweep
            let y = 320.0;

            // Wall test.
            let mut ids = ItemIdCounter::default();
            let mut shots = fire_weapon(weapon, 0, start_x, y, 0.0, &mut ids);
            let mid = shots.len() / 2;
            let p = &mut shots[mid];
            for _ in 0..200 {
                match step_projectile(p, &map, &[], DT) {
                    ProjectileStep::Flying => {
                        if p.x > wall_x + 32.0 { break; }
                    }
                    ProjectileStep::Impact { x, .. } => {
                        if (x - wall_x).abs() < 24.0 { wall_hits += 1; }
                        break;
                    }
                    ProjectileStep::HitPlayer { .. } => break,
                }
            }

            // Player test: a 12 px target centred on the flight line.
            let target_x = wall_x;
            let mut ids = ItemIdCounter::default();
            let mut shots = fire_weapon(weapon, 0, start_x, y, 0.0, &mut ids);
            let mid = shots.len() / 2;
            let p = &mut shots[mid];
            for _ in 0..200 {
                match step_projectile(p, &open, &[(1, target_x, y)], DT) {
                    ProjectileStep::Flying => { if p.x > target_x + 32.0 { break; } }
                    ProjectileStep::HitPlayer { .. } => { player_hits += 1; break; }
                    ProjectileStep::Impact { .. } => break,
                }
            }
        }
        println!("{:<9} {:>8.1}  {:>13} /64  {:>19} /64",
            format!("{weapon:?}").to_lowercase(), speed * DT, wall_hits, player_hits);
    }
}
