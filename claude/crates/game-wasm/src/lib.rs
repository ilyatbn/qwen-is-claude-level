//! `game-wasm` — the WebAssembly boundary.
//!
//! A thin `wasm-bindgen` shim over `game-core`. It holds **no game logic of its
//! own**; anything that looks like a rule belongs in `game-core` so the server runs
//! the identical code. See `docs/01-architecture.md`.
//!
//! # The mask is a pointer, never a copy
//!
//! [`GameCore::mask_ptr`] hands JS the address of the mask inside WASM linear
//! memory so the client can build one `Uint8Array` view and re-read it. Copying a
//! 1 MiB mask across the boundary on every chunk bake would dominate the frame
//! budget.
//!
//! **That view is invalidated whenever WASM memory grows.** Any allocation can
//! trigger a `memory.grow`, which swaps the underlying `ArrayBuffer` and detaches
//! every existing view — reads then throw or silently return zeros, and the map
//! renders blank. In practice `generate` and `load_mask` are the calls that
//! reallocate, but the safe rule is for the TS wrapper to re-acquire the view
//! whenever `view.buffer !== memory.buffer`. T3.02 does this inside its accessor so
//! no caller has to remember.

use game_core::constants::{MapScale, SIM_DT};
use game_core::map::{generate, rle, CoarseGrid, Map};
use game_core::math::Vec2;
use game_core::physics::body::Body;
use game_core::player::{apply_input, Input, JetpackState, JumpState};
use wasm_bindgen::prelude::*;

/// One locally-simulated player: the body plus the two bits of movement state
/// `apply_input` needs.
struct LocalPlayer {
    id: u8,
    body: Body,
    jump: JumpState,
    jet: JetpackState,
    prev_input: Input,
}

#[wasm_bindgen]
pub struct GameCore {
    map: Map,
    players: Vec<LocalPlayer>,
}

impl Default for GameCore {
    fn default() -> Self {
        Self::new()
    }
}

#[wasm_bindgen]
impl GameCore {
    #[wasm_bindgen(constructor)]
    pub fn new() -> GameCore {
        // Without this a Rust panic surfaces as bare `unreachable executed`, with
        // no file, line or message.
        console_error_panic_hook::set_once();
        GameCore {
            map: generate(1, MapScale::Small),
            players: Vec::new(),
        }
    }

    /// The seed arrives as two `u32`s: a `u64` across the wasm-bindgen boundary
    /// pulls in BigInt handling that is more trouble than it is worth.
    pub fn generate(&mut self, seed_lo: u32, seed_hi: u32, scale: u8) {
        let seed = ((seed_hi as u64) << 32) | seed_lo as u64;
        let scale = MapScale::from_u8(scale).unwrap_or(MapScale::Medium);
        self.map = generate(seed, scale);
    }

    /// Rebuild the map from a `map_init` RLE payload. Returns false on malformed
    /// input rather than panicking — this decodes untrusted network data.
    pub fn load_mask(&mut self, w: u32, h: u32, rle_bytes: &[u8]) -> bool {
        let Ok(mask) = rle::decode(w, h, rle_bytes) else {
            return false;
        };
        let coarse = CoarseGrid::build(&mask);
        let mut meta = self.map.meta.clone();
        meta.surface_points.clear();
        self.map = Map::from_parts(mask, coarse, meta);
        true
    }

    // ---- terrain access -------------------------------------------------

    /// Address of the mask words in WASM memory. See the module docs: the view JS
    /// builds over this is detached by any heap growth.
    pub fn mask_ptr(&self) -> *const u8 {
        self.map.mask.words().as_ptr() as *const u8
    }

    pub fn mask_byte_len(&self) -> usize {
        self.map.mask.words().len() * 8
    }

    pub fn width(&self) -> u32 {
        self.map.mask.w
    }

    pub fn height(&self) -> u32 {
        self.map.mask.h
    }

    pub fn chunks_x(&self) -> u32 {
        self.map.chunks_x()
    }

    pub fn chunks_y(&self) -> u32 {
        self.map.chunks_y()
    }

    pub fn solid_at(&self, x: i32, y: i32) -> bool {
        self.map.mask.get(x, y)
    }

    pub fn carve(&mut self, cx: i32, cy: i32, r: i32) {
        self.map.carve_circle(cx, cy, r);
    }

    /// Chunk indices (`cy * chunks_x + cx`), clearing the set.
    pub fn take_dirty_chunks(&mut self) -> Vec<u32> {
        self.map.drain_dirty()
    }

    // ---- local player prediction ----------------------------------------

    pub fn add_player(&mut self, id: u8, x: f32, y: f32) {
        if self.players.iter().any(|p| p.id == id) {
            return;
        }
        self.players.push(LocalPlayer {
            id,
            body: Body::new(Vec2::new(x, y)),
            jump: JumpState::default(),
            jet: JetpackState::default(),
            prev_input: Input::default(),
        });
    }

    pub fn remove_player(&mut self, id: u8) {
        self.players.retain(|p| p.id != id);
    }

    pub fn apply_input(&mut self, id: u8, seq: u32, buttons: u8, aim: u16, dt: f32) {
        let map = &self.map;
        let Some(p) = self.players.iter_mut().find(|p| p.id == id) else {
            return;
        };
        let input = Input::new(seq, buttons, aim);
        let dt = if dt > 0.0 { dt } else { SIM_DT };
        apply_input(
            map,
            &mut p.body,
            &mut p.jump,
            &mut p.jet,
            &input,
            &p.prev_input,
            1.0,
            dt,
        );
        p.prev_input = input;
    }

    #[allow(clippy::too_many_arguments)]
    pub fn set_player_state(
        &mut self,
        id: u8,
        x: f32,
        y: f32,
        vx: f32,
        vy: f32,
        grounded: bool,
        fuel: f32,
    ) {
        let Some(p) = self.players.iter_mut().find(|p| p.id == id) else {
            return;
        };
        p.body.pos = Vec2::new(x, y);
        p.body.vel = Vec2::new(vx, vy);
        p.body.grounded = grounded;
        p.jet.fuel = fuel;
    }

    /// `[x, y, vx, vy, grounded, fuel, move_state]`, or empty for an unknown id.
    ///
    /// A flat `f32` array rather than a struct: crossing the boundary with a struct
    /// costs a serialisation step per call, and this is read every frame.
    pub fn player_state(&self, id: u8) -> Box<[f32]> {
        let Some(p) = self.players.iter().find(|p| p.id == id) else {
            return Box::new([]);
        };
        let state = match game_core::physics::body::move_state(&p.body, p.jet.active) {
            game_core::physics::body::MoveState::Grounded => 0.0,
            game_core::physics::body::MoveState::Airborne => 1.0,
            game_core::physics::body::MoveState::Jetpack => 2.0,
        };
        Box::new([
            p.body.pos.x,
            p.body.pos.y,
            p.body.vel.x,
            p.body.vel.y,
            if p.body.grounded { 1.0 } else { 0.0 },
            p.jet.fuel,
            state,
        ])
    }

    // ---- metadata --------------------------------------------------------

    /// JSON, because this is called once per round and the cost is irrelevant.
    pub fn meta_json(&self) -> String {
        serde_json::to_string(&self.map.meta).unwrap_or_else(|_| "{}".to_string())
    }

    pub fn mask_hash(&self) -> Box<[u8]> {
        Box::new(self.map.mask.hash())
    }

    /// RLE of the current mask, for tests and for the future replay path.
    pub fn mask_rle(&self) -> Box<[u8]> {
        rle::encode(&self.map.mask).into_boxed_slice()
    }
}

/// Every tunable the client needs, as JSON.
///
/// The client must never re-declare one of these. A literal in TypeScript that
/// shadows a Rust constant is exactly the drift the shared-core architecture exists
/// to prevent (`docs/01-architecture.md`), and `client/src/main.ts` had two of them
/// — VIEWPORT_W and VIEWPORT_H — from M0.
#[wasm_bindgen]
pub fn constants_json() -> String {
    use game_core::constants as c;
    serde_json::json!({
        "VIEWPORT_W": c::VIEWPORT_W,
        "VIEWPORT_H": c::VIEWPORT_H,
        "CHUNK_SIZE": c::CHUNK_SIZE,
        "COARSE_CELL": c::COARSE_CELL,
        "BEDROCK_H": c::BEDROCK_H,
        "WALL_W": c::WALL_W,
        "SKY_MARGIN": c::SKY_MARGIN,
        "PLAYER_W": c::PLAYER_W,
        "PLAYER_H": c::PLAYER_H,
        "EDGE_BAND_PX": c::EDGE_BAND_PX,
        "CHUNK_REBAKE_BUDGET": c::CHUNK_REBAKE_BUDGET,
        "PARALLAX_FACTOR": c::PARALLAX_FACTOR,
        "CAMERA_LERP": c::CAMERA_LERP,
        "CAMERA_ZOOM": c::CAMERA_ZOOM,
        "CAMERA_DEADZONE_W": c::CAMERA_DEADZONE_W,
        "CAMERA_DEADZONE_H": c::CAMERA_DEADZONE_H,
        "CAMERA_LOOKAHEAD": c::CAMERA_LOOKAHEAD,
        "CAMERA_LOOKAHEAD_LERP": c::CAMERA_LOOKAHEAD_LERP,
        "SIM_DT": c::SIM_DT,
        "SIM_HZ": c::SIM_HZ,
        "AIM_RADIUS": c::AIM_RADIUS,
        "JETPACK_MAX_FUEL": c::JETPACK_MAX_FUEL,
        "MINIMAP_W": c::MINIMAP_W,
        "MINIMAP_H": c::MINIMAP_H,
        "AIM_DEADZONE": c::AIM_DEADZONE,
        // Button bits, so the client never re-declares the wire layout. A
        // TypeScript copy of these is exactly the drift this boundary exists to
        // prevent — see crates/game-core/src/player/input.rs.
        "BTN_LEFT": game_core::player::input::button::LEFT,
        "BTN_RIGHT": game_core::player::input::button::RIGHT,
        "BTN_UP": game_core::player::input::button::UP,
        "BTN_DOWN": game_core::player::input::button::DOWN,
        "BTN_JUMP": game_core::player::input::button::JUMP,
        "BTN_FIRE": game_core::player::input::button::FIRE,
        "BTN_FLASHLIGHT": game_core::player::input::button::FLASHLIGHT,
    })
    .to_string()
}

/// Angle → wire word. The server dequantises with the Rust version, so a
/// TypeScript reimplementation that rounds differently would put every shot a
/// fraction off. One implementation, called from both sides.
#[wasm_bindgen]
pub fn quantize_angle(a: f32) -> u16 {
    game_core::math::quantize_angle(a)
}

#[wasm_bindgen]
pub fn dequantize_angle(q: u16) -> f32 {
    game_core::math::dequantize_angle(q)
}

#[cfg(test)]
mod tests {
    use super::*;
    use wasm_bindgen_test::wasm_bindgen_test;

    #[wasm_bindgen_test]
    fn generate_sets_the_requested_dimensions() {
        let mut core = GameCore::new();
        core.generate(4242, 0, 1);
        assert_eq!(core.width(), 3072);
        assert_eq!(core.height(), 1536);
        core.generate(4242, 0, 2);
        assert_eq!(core.width(), 4096);
        assert_eq!(core.height(), 2048);
    }

    #[wasm_bindgen_test]
    fn mask_byte_len_covers_every_pixel() {
        let mut core = GameCore::new();
        core.generate(1, 0, 0);
        let bits = core.width() as usize * core.height() as usize;
        assert_eq!(core.mask_byte_len(), bits / 8);
        assert!(!core.mask_ptr().is_null());
    }

    #[wasm_bindgen_test]
    fn carving_dirties_chunks_once() {
        let mut core = GameCore::new();
        core.generate(4242, 0, 0);
        let _ = core.take_dirty_chunks();

        // Carve somewhere guaranteed solid: just above the bedrock, mid-map.
        let (x, y) = (core.width() as i32 / 2, core.height() as i32 - 60);
        core.carve(x, y, 40);
        assert!(!core.take_dirty_chunks().is_empty());
        assert!(core.take_dirty_chunks().is_empty(), "the set must clear");
    }

    #[wasm_bindgen_test]
    fn a_carve_actually_removes_terrain() {
        let mut core = GameCore::new();
        core.generate(4242, 0, 0);
        let (x, y) = (core.width() as i32 / 2, core.height() as i32 - 60);
        assert!(core.solid_at(x, y), "precondition: solid before the carve");
        core.carve(x, y, 20);
        assert!(!core.solid_at(x, y));
    }

    #[wasm_bindgen_test]
    fn load_mask_round_trips_through_rle() {
        let mut core = GameCore::new();
        core.generate(4242, 0, 0);
        let (w, h) = (core.width(), core.height());
        let before = core.mask_hash();
        let bytes = core.mask_rle();

        let mut other = GameCore::new();
        assert!(other.load_mask(w, h, &bytes));
        assert_eq!(other.mask_hash(), before);
    }

    #[wasm_bindgen_test]
    fn load_mask_rejects_malformed_bytes_without_panicking() {
        let mut core = GameCore::new();
        assert!(!core.load_mask(256, 256, &[0xFF; 32]));
        assert!(!core.load_mask(256, 256, &[]));
        assert!(!core.load_mask(0, 0, &[0]));
        // A width that is not a multiple of 64 cannot describe a mask.
        assert!(!core.load_mask(100, 100, &[0]));
    }

    #[wasm_bindgen_test]
    fn apply_input_moves_a_player() {
        let mut core = GameCore::new();
        core.generate(4242, 0, 0);
        // The sky band is cleared by force_borders, so this is guaranteed air.
        // An arbitrary mid-map point can land inside rock, where move_x is
        // correctly blocked and the test would fail for the wrong reason.
        core.add_player(1, 500.0, 40.0);
        let before = core.player_state(1);

        // Hold RIGHT for a second.
        for seq in 0..60 {
            core.apply_input(1, seq, 1 << 1, 0, SIM_DT);
        }
        let after = core.player_state(1);
        assert_ne!(after[0], before[0], "the player did not move");
    }

    #[wasm_bindgen_test]
    fn player_state_round_trips() {
        let mut core = GameCore::new();
        core.add_player(2, 0.0, 0.0);
        core.set_player_state(2, 12.5, -3.25, 7.0, -1.5, true, 2.5);
        let s = core.player_state(2);
        assert_eq!(s[0], 12.5);
        assert_eq!(s[1], -3.25);
        assert_eq!(s[2], 7.0);
        assert_eq!(s[3], -1.5);
        assert_eq!(s[4], 1.0);
        assert_eq!(s[5], 2.5);
    }

    #[wasm_bindgen_test]
    fn an_unknown_player_id_is_empty_not_a_panic() {
        let core = GameCore::new();
        assert_eq!(core.player_state(99).len(), 0);
    }

    #[wasm_bindgen_test]
    fn duplicate_add_player_is_ignored() {
        let mut core = GameCore::new();
        core.add_player(1, 10.0, 10.0);
        core.add_player(1, 900.0, 900.0);
        let s = core.player_state(1);
        assert_eq!(s[0], 10.0, "the second add must not move the player");
    }

    #[wasm_bindgen_test]
    fn meta_json_parses_and_carries_the_map() {
        let mut core = GameCore::new();
        core.generate(4242, 0, 1);
        let json = core.meta_json();
        assert!(json.contains("spawn_points"));
        assert!(json.contains("surface_points"));
        assert!(json.contains("buried_slots"));
        let v: serde_json::Value = serde_json::from_str(&json).expect("valid json");
        assert!(!v["spawn_points"].as_array().expect("array").is_empty());
        assert!(!v["surface_points"].as_array().expect("array").is_empty());
    }

    #[wasm_bindgen_test]
    fn constants_json_carries_the_viewport_and_camera_values() {
        let v: serde_json::Value = serde_json::from_str(&constants_json()).expect("valid json");
        assert_eq!(v["VIEWPORT_W"], 1280);
        assert_eq!(v["VIEWPORT_H"], 720);
        assert_eq!(v["CHUNK_SIZE"], 256);
        assert_eq!(v["CAMERA_ZOOM"], 2.0);
        assert_eq!(v["PLAYER_W"], 16.0);
        assert_eq!(v["PLAYER_H"], 28.0);
    }

    #[wasm_bindgen_test]
    fn the_seed_is_reassembled_from_two_halves() {
        let mut a = GameCore::new();
        a.generate(0x1234_5678, 0x9ABC_DEF0, 0);
        let mut b = GameCore::new();
        b.generate(0x1234_5678, 0x9ABC_DEF0, 0);
        assert_eq!(a.mask_hash(), b.mask_hash());

        let mut c = GameCore::new();
        c.generate(0x1234_5678, 0, 0);
        assert_ne!(a.mask_hash(), c.mask_hash(), "the high half must matter");
    }
}
