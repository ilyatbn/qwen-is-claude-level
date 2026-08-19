//! Server-side fingerprint of the map a seed produces, for comparison with
//! what a real client decodes from MapData.tiles.
use base64::Engine as _;
use game_core::map::{Map, Scale};

fn fnv1a(bytes: &[u8]) -> u64 {
    let mut h: u64 = 0xcbf2_9ce4_8422_2325;
    for &b in bytes {
        h ^= b as u64;
        h = h.wrapping_mul(0x0000_0100_0000_01b3);
    }
    h
}

fn main() {
    let seed = 4242u64;
    // The client joins BEFORE the round starts, so `joined` carries the
    // Round::new map — generated from the seed with no round-start shuffle.
    let map = Map::generate(seed, Scale::Medium);
    let data = map.to_map_data();
    let bytes = base64::engine::general_purpose::STANDARD.decode(&data.tiles).unwrap();
    let solid = bytes.iter().filter(|&&b| b != 0).count();
    println!("server: seed={seed} scale={} {}x{}", data.scale, data.width, data.height);
    println!("        tiles={} solid={solid} decor={} spawns={}",
        bytes.len(), data.decor.len(), data.spawns.len());
    println!("        fnv1a={:016x}", fnv1a(&bytes));
}
