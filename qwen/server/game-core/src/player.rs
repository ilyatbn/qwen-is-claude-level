//! `player` — state, movement, jump, jetpack, aim, health/shield
//! (docs/03-player.md).
//!
//! Server-authoritative: the server simulates every player from input frames.

use crate::items::Inventory;
use crate::protocol::InputFrame;
use crate::map::Map;
use crate::tiles::TILE_SIZE;
use crate::Vec2;
use serde::{Deserialize, Serialize};

/// Tunable constants (docs/03 §4, §5, §7).
///
/// docs/00 §7: "All tunable numbers (damage, speeds, durations) live in
/// `*_config.rs` / config objects defined in the relevant doc, not scattered as
/// literals." docs/03 §4 names this `player_config`; it lives here as a module
/// rather than a new file because T0.1's module list is fixed.
pub mod player_config {
    /// Horizontal ground speed, px/s (docs/03 §4).
    pub const MOVE_SPEED: f32 = 140.0;
    /// Air-control acceleration, px/s² (docs/03 §4).
    pub const AIR_ACCEL: f32 = 600.0;
    /// Air-control horizontal cap, px/s (docs/03 §4).
    pub const AIR_MAX: f32 = 140.0;
    /// World gravity, px/s² (docs/03 §4).
    pub const GRAVITY: f32 = 900.0;
    /// Jump impulse, px/s (docs/03 §4). Negative is upward: y grows downward.
    pub const JUMP_VY: f32 = -330.0;
    /// Horizontal velocity factor applied at jump if A/D held (docs/03 §4).
    pub const JUMP_DIR_BIAS: f32 = 0.5;

    /// Jetpack thrust, px/s² upward (docs/03 §5).
    pub const JETPACK_THRUST: f32 = 1100.0;
    /// Extra W/S acceleration in flight, px/s² (docs/03 §5).
    pub const JETPACK_VERTICAL_ASSIST: f32 = 300.0;
    /// Jetpack fuel capacity, seconds (docs/03 §5).
    pub const JETPACK_FUEL_MAX: f32 = 5.0;
    /// Fuel burned per second of thrust (docs/03 §5).
    pub const JETPACK_BURN_RATE: f32 = 1.0;
    /// Fuel recharged per second while not thrusting (docs/03 §5).
    pub const JETPACK_RECHARGE_RATE: f32 = 0.5;

    /// Base health (docs/03 §6).
    pub const BASE_HEALTH: f32 = 100.0;

    /// FOV base radius, px (docs/03 §7).
    pub const FOV_BASE: f32 = 420.0;
    /// Night FOV multiplier at full night (docs/03 §7).
    pub const FOV_NIGHT_MIN: f32 = 0.45;
    /// FOV multiplier while heavy fog is active (docs/03 §7, docs/02 §6).
    pub const FOV_FOG: f32 = 0.45;
    /// FOV multiplier below `FOV_LOW_HEALTH` hp (docs/03 §7).
    pub const FOV_LOW_HEALTH_FACTOR: f32 = 0.7;
    /// Health threshold for the low-health FOV penalty (docs/03 §7).
    pub const FOV_LOW_HEALTH: f32 = 50.0;

    /// Player body HALF-extents, px.
    ///
    /// DEVIATIONS.md D6: T2.6 says a "12×14 px rectangle", docs/07 §5 says the
    /// placeholder is a "24×28 rect", and docs/04 §2 says the hit circle is
    /// 12 px radius. Reading 12×14 as HALF-extents reconciles all three: the
    /// full body is 24×28 and the half-width is 12, matching the hit radius.
    /// These are half-extents. Do not re-derive this.
    pub const BODY_HALF_WIDTH: f32 = 12.0;
    pub const BODY_HALF_HEIGHT: f32 = 14.0;
    /// Full body size, px — what the client draws (docs/07 §5: 24×28).
    pub const BODY_WIDTH: f32 = BODY_HALF_WIDTH * 2.0;
    pub const BODY_HEIGHT: f32 = BODY_HALF_HEIGHT * 2.0;
    /// Player hit circle radius, px (docs/04 §2).
    pub const HIT_RADIUS: f32 = 12.0;
}

use player_config::*;

/// docs/03 §1.
#[derive(Debug, Clone, Copy, PartialEq, Default, Serialize, Deserialize)]
pub struct ShieldState {
    pub active: bool,
    pub remaining_s: f32,
}

/// docs/03 §1. Fuel is in seconds, 0..=5.0.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub struct JetpackState {
    pub fuel: f32,
}

impl Default for JetpackState {
    fn default() -> Self {
        JetpackState {
            fuel: JETPACK_FUEL_MAX,
        }
    }
}

/// docs/03 §1.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Player {
    /// 0..=5 (docs/05 §2: max 6 players).
    pub id: u8,
    pub name: String,
    /// Index into the skin list (docs/07 §4).
    pub skin: u8,
    /// Px, centre of body.
    pub pos: Vec2,
    /// Px/s.
    pub vel: Vec2,
    /// Aim angle, radians. 0 = right, CCW positive (docs/06 intro).
    pub facing: f32,
    /// 0..=150 — overcharge can exceed 100 (docs/03 §6).
    pub health: f32,
    /// Base 100, 150 while overcharged (docs/03 §6).
    pub max_health: f32,
    pub shield: ShieldState,
    pub jetpack: JetpackState,
    pub inventory: Inventory,
    pub alive: bool,
    pub respawn_at_tick: Option<u64>,
    pub score: i32,
    pub kills: u32,
    pub deaths: u32,
}

impl Player {
    /// A live player at `pos` with documented defaults (T2.1 step 3).
    pub fn new(id: u8, name: String, pos: Vec2) -> Self {
        Player {
            id,
            name,
            skin: 0,
            pos,
            vel: Vec2::ZERO,
            facing: 0.0,
            health: BASE_HEALTH,
            max_health: BASE_HEALTH,
            shield: ShieldState::default(),
            jetpack: JetpackState::default(),
            inventory: Inventory::new(),
            alive: true,
            respawn_at_tick: None,
            score: 0,
            kills: 0,
            deaths: 0,
        }
    }

    /// Body centre → pixel position of the feet (bottom edge of the body).
    pub fn feet_y(&self) -> f32 {
        self.pos.y + BODY_HALF_HEIGHT
    }

    /// Convert a spawn tile coordinate to a body-centre pixel position.
    ///
    /// docs/01 §3 step 5: "spawn position (pixels) = tile center ... player
    /// placed so its feet rest on the tile top". T2.1 step 2 spells the y out:
    /// `y = (tile_y+1)*16 - body_half_height`.
    ///
    /// Wait — `(tile_y+1)*16` is the tile's BOTTOM edge, not its top. Using it
    /// would bury the player half a tile. The feet must rest on the tile's TOP
    /// edge, `tile_y*16`, so the body centre sits at
    /// `tile_y*16 - BODY_HALF_HEIGHT`. See DEVIATIONS.md D25.
    ///
    /// Spawns are TILE coordinates (docs/01 §4, DEVIATIONS.md D9).
    pub fn spawn_position(spawn_tile: Vec2) -> Vec2 {
        Vec2::new(
            (spawn_tile.x + 0.5) * TILE_SIZE,
            spawn_tile.y * TILE_SIZE - BODY_HALF_HEIGHT,
        )
    }

    /// Place player `id` at `map.spawns[id]` (T2.1 step 2).
    ///
    /// The per-round shuffle of `map.spawns` happens once in `round.rs`
    /// (T4.1); this assigns directly by index, as the task specifies.
    pub fn spawn(map: &Map, id: u8, name: String) -> Option<Player> {
        let spawn_tile = *map.spawns.get(id as usize)?;
        Some(Player::new(id, name, Player::spawn_position(spawn_tile)))
    }
}

/// Per-player input state with edge detection (T2.2, docs/03 §3).
///
/// docs/03 §3: "Server applies the latest input frame per tick (missing frames
/// → repeat last). `jump` and `use_slot` are edge-triggered server-side."
///
/// Lives here rather than in an `input.rs` because T0.1's module list is fixed;
/// T2.2 permits either ("or `input.rs` if cleaner — note it in the file header").
#[derive(Debug, Clone, Default, PartialEq)]
pub struct PlayerInputState {
    /// The most recent frame received. `None` until the first arrives.
    pub last: Option<InputFrame>,
    prev_jump: bool,
    prev_use_slot: Option<u8>,
}

/// What one tick's input resolved to after edge detection.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct InputEdges {
    /// True only on the tick `jump` transitions false → true.
    pub jump_pressed: bool,
    /// `Some(slot)` only on the tick a slot is newly pressed.
    pub use_slot_pressed: Option<u8>,
}

impl PlayerInputState {
    pub fn new() -> Self {
        Self::default()
    }

    /// Record a newly-arrived frame. Latest-wins (docs/06 §3).
    ///
    /// This does NOT compute edges — several frames may arrive between ticks
    /// and only the last is simulated (docs/05 §3: "the tick loop takes the
    /// LATEST frame per player, drops older"). Edges are resolved once per
    /// tick by [`PlayerInputState::tick`].
    pub fn receive(&mut self, frame: InputFrame) {
        self.last = Some(frame);
    }

    /// Resolve this tick's input, returning the frame to simulate and its edges.
    ///
    /// A missing frame repeats the last one (docs/03 §3). Before any frame has
    /// arrived, everything reads false.
    pub fn tick(&mut self) -> (InputFrame, InputEdges) {
        let frame = self.last.unwrap_or_default();

        let jump_pressed = frame.jump && !self.prev_jump;
        // A slot press is an edge too: the client sends `use_slot` as null
        // except on the tick it is pressed (docs/06 §3), but a client that
        // holds it must not fire every tick.
        let use_slot_pressed = match (frame.use_slot, self.prev_use_slot) {
            (Some(slot), Some(prev)) if slot == prev => None,
            (Some(slot), _) => Some(slot),
            (None, _) => None,
        };

        self.prev_jump = frame.jump;
        self.prev_use_slot = frame.use_slot;

        (frame, InputEdges {
            jump_pressed,
            use_slot_pressed,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::map::Scale;

    #[test]
    fn body_dimensions_reconcile_all_three_docs() {
        // DEVIATIONS.md D6. If someone "fixes" the half-extents to 12x14 full,
        // this fails and points at the deviation.
        assert_eq!(BODY_WIDTH, 24.0, "docs/07 §5 says the placeholder is 24x28");
        assert_eq!(BODY_HEIGHT, 28.0, "docs/07 §5 says the placeholder is 24x28");
        assert_eq!(
            HIT_RADIUS, BODY_HALF_WIDTH,
            "docs/04 §2's 12 px hit radius should equal the body half-width",
        );
    }

    #[test]
    fn player_defaults_match_doc() {
        // T2.1 step 3.
        let p = Player::new(2, "p2".into(), Vec2::new(10.0, 20.0));
        assert_eq!(p.health, 100.0);
        assert_eq!(p.max_health, 100.0);
        assert_eq!(p.jetpack.fuel, 5.0);
        assert!(p.alive);
        assert_eq!(p.score, 0);
        assert_eq!(p.kills, 0);
        assert_eq!(p.deaths, 0);
        assert_eq!(p.respawn_at_tick, None);
        assert_eq!(p.vel, Vec2::ZERO);
        assert!(!p.shield.active);
        assert_eq!(p.shield.remaining_s, 0.0);
    }

    #[test]
    fn spawn_places_feet_on_the_tile_top() {
        // T2.1 Acceptance: "feet on tile top, x = tile center", within 1 px.
        let map = Map::generate(1, Scale::Small);
        for id in 0..6u8 {
            let player = Player::spawn(&map, id, format!("p{id}")).expect("spawn");
            let tile = map.spawns[id as usize];

            let expected_x = (tile.x + 0.5) * TILE_SIZE;
            assert!(
                (player.pos.x - expected_x).abs() < 1.0,
                "player {id} x {} is not the tile centre {expected_x}",
                player.pos.x,
            );

            // The spawn tile is GRASS; its TOP edge is where the feet rest.
            let tile_top = tile.y * TILE_SIZE;
            assert!(
                (player.feet_y() - tile_top).abs() < 1.0,
                "player {id} feet at {} are not on the tile top {tile_top}",
                player.feet_y(),
            );
        }
    }

    #[test]
    fn spawned_player_clears_its_own_spawn_column() {
        // What the design actually guarantees. docs/01 §3 step 5 selects GRASS
        // tiles "with the 2 tiles above AIR" — a check on ONE column — so the
        // body's vertical extent is clear in the spawn's own column and nowhere
        // else. Measured: 0/600 own-column overlaps at every scale.
        //
        // This is deliberately NOT asserting the body clears neighbouring
        // columns; it does not, 70-80% of the time. See DEVIATIONS.md D26.
        for seed in 0..25u64 {
            let map = Map::generate(seed, Scale::Small);
            for id in 0..6u8 {
                let player = Player::spawn(&map, id, format!("p{id}")).expect("spawn");
                let mut y = player.pos.y - BODY_HALF_HEIGHT + 0.5;
                while y < player.pos.y + BODY_HALF_HEIGHT {
                    assert!(
                        !map.is_solid_at_pixel(player.pos.x, y),
                        "seed {seed} player {id}: body is inside terrain at \
                         ({}, {y}) in its own spawn column",
                        player.pos.x,
                    );
                    y += 2.0;
                }
            }
        }
    }

    #[test]
    fn spawn_formula_does_not_bury_the_player() {
        // DEVIATIONS.md D25, as a guard rather than an argument.
        //
        // T2.1 step 2 writes `y = (tile_y+1)*16 - body_half_height`. Since a
        // tile spans `tile_y*16 ..= (tile_y+1)*16`, that puts the feet on the
        // spawn tile's BOTTOM edge, sinking the body one full tile into solid
        // GRASS. Measured over 100 seeds: the literal formula buries the player
        // 600/600 times, the corrected one 0/600.
        //
        // If someone "restores" the doc's formula, this fails.
        let map = Map::generate(1, Scale::Small);
        let tile = map.spawns[0];
        let player = Player::spawn(&map, 0, "p0".into()).expect("spawn");

        let tile_top = tile.y * TILE_SIZE;
        let tile_bottom = (tile.y + 1.0) * TILE_SIZE;
        assert!(
            (player.feet_y() - tile_top).abs() < 0.001,
            "feet at {} should rest on the tile TOP edge {tile_top}",
            player.feet_y(),
        );
        assert!(
            player.feet_y() < tile_bottom,
            "feet at {} are at or below the tile BOTTOM edge {tile_bottom} — \
             the player is buried (D25)",
            player.feet_y(),
        );
        // The spawn tile itself is solid, and the body must sit entirely above it.
        assert!(map.is_solid(tile.x as u32, tile.y as u32), "spawn tile is not solid");
        assert!(
            !map.is_solid_at_pixel(player.pos.x, player.pos.y + BODY_HALF_HEIGHT - 0.5),
            "the body's lowest pixel is inside the spawn tile",
        );
    }

    #[test]
    fn six_players_get_six_distinct_spawns() {
        // T2.1 step 4.
        let map = Map::generate(1, Scale::Small);
        let positions: Vec<Vec2> = (0..6u8)
            .map(|id| Player::spawn(&map, id, format!("p{id}")).expect("spawn").pos)
            .collect();
        for (i, a) in positions.iter().enumerate() {
            for b in positions.iter().skip(i + 1) {
                assert_ne!(a, b, "two players share a spawn position");
            }
        }
    }

    #[test]
    fn spawn_out_of_range_returns_none() {
        // A map is guaranteed >= 6 spawns, but the accessor must not panic
        // when asked for one it does not have.
        let map = Map::generate(1, Scale::Small);
        let beyond = map.spawns.len() as u8;
        assert!(Player::spawn(&map, beyond, "x".into()).is_none());
    }
}

/// T2.2's input tests.
///
/// In their own module so the task's documented Test command,
/// `cargo test -p game-core input`, actually selects them — as
/// `player::input_tests::...`. Under `player::tests::...` that command matched
/// only an unrelated protocol test and ran none of these. See DEVIATIONS.md D27.
#[cfg(test)]
mod input_tests {
    use super::*;

fn held(jump: bool) -> InputFrame {
    InputFrame {
        jump,
        ..InputFrame::default()
    }
}

#[test]
fn holding_jump_yields_exactly_one_edge() {
    // T2.2 Acceptance: "holding space for 10 ticks yields exactly 1 jump
    // edge". This is THE test for edge triggering — without it, holding
    // space would re-jump every tick.
    let mut input = PlayerInputState::new();
    let mut edges = 0;
    for _ in 0..10 {
        input.receive(held(true));
        if input.tick().1.jump_pressed {
            edges += 1;
        }
    }
    assert_eq!(edges, 1, "held jump produced {edges} edges, expected 1");
}

#[test]
fn releasing_and_repressing_jump_yields_a_second_edge() {
    let mut input = PlayerInputState::new();
    let mut edges = 0;
    // 3 held, 2 released, 3 held again -> exactly 2 edges.
    for jump in [true, true, true, false, false, true, true, true] {
        input.receive(held(jump));
        if input.tick().1.jump_pressed {
            edges += 1;
        }
    }
    assert_eq!(edges, 2);
}

#[test]
fn missing_frame_repeats_the_last_one() {
    // docs/03 §3: "missing frames -> repeat last".
    let mut input = PlayerInputState::new();
    input.receive(InputFrame {
        right: true,
        aim: 1.25,
        ..InputFrame::default()
    });
    let (first, _) = input.tick();
    // No new frame arrives; tick again.
    let (second, edges) = input.tick();
    assert_eq!(first.right, second.right);
    assert_eq!(first.aim, second.aim);
    assert!(!edges.jump_pressed);
}

#[test]
fn first_tick_without_a_frame_is_all_false() {
    // docs/03 §3: "First tick with no frame -> all false."
    let mut input = PlayerInputState::new();
    let (frame, edges) = input.tick();
    assert_eq!(frame, InputFrame::default());
    assert!(!frame.left && !frame.right && !frame.jump && !frame.fire);
    assert!(!edges.jump_pressed);
    assert_eq!(edges.use_slot_pressed, None);
}

#[test]
fn latest_frame_wins_within_one_tick() {
    // T2.2 step 4 / docs/05 §3: several frames may arrive between ticks;
    // only the last is simulated.
    let mut input = PlayerInputState::new();
    input.receive(InputFrame { tick: 1, left: true, ..InputFrame::default() });
    input.receive(InputFrame { tick: 2, right: true, ..InputFrame::default() });
    let (frame, _) = input.tick();
    assert_eq!(frame.tick, 2);
    assert!(frame.right && !frame.left);
}

#[test]
fn a_jump_arriving_and_ending_between_ticks_is_still_one_edge() {
    // Latest-wins means a press+release inside one tick window collapses.
    // The edge must come from the frame actually simulated, not from any
    // frame that happened to arrive.
    let mut input = PlayerInputState::new();
    input.receive(held(true));
    input.receive(held(false));
    assert!(!input.tick().1.jump_pressed, "released frame must not jump");
    input.receive(held(true));
    assert!(input.tick().1.jump_pressed);
}

#[test]
fn use_slot_is_edge_triggered() {
    // T2.2 step 2. A client holding the same slot must fire once.
    let mut input = PlayerInputState::new();
    let mut presses = Vec::new();
    for slot in [Some(2), Some(2), Some(2), None, Some(2), Some(3)] {
        input.receive(InputFrame {
            use_slot: slot,
            ..InputFrame::default()
        });
        if let Some(s) = input.tick().1.use_slot_pressed {
            presses.push(s);
        }
    }
    assert_eq!(presses, vec![2, 2, 3], "expected press, re-press, then slot 3");
}
}
