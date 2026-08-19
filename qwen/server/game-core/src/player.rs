//! `player` — state, movement, jump, jetpack, aim, health/shield
//! (docs/03-player.md).
//!
//! Server-authoritative: the server simulates every player from input frames.

use crate::items::Inventory;
use crate::protocol::InputFrame;
use crate::map::Map;
use crate::physics::PhysicsWorld;
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

    /// Terminal fall speed, px/s (T2.6 Acceptance: "terminal velocity cap
    /// 900 px/s"). Equal to GRAVITY numerically, which is coincidence.
    pub const TERMINAL_VELOCITY: f32 = 900.0;
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

/// T2.1's spawn and player-state tests.
///
/// Named `spawn_tests` so T2.1's documented Test command,
/// `cargo test -p game-core player::spawn`, selects them. Under the generic
/// `tests` it matched nothing and exited 0 — see DEVIATIONS.md D27.
#[cfg(test)]
mod spawn_tests {
    use super::*;
    use crate::map::Scale;

    #[test]
    fn set_aim_stores_the_angle_unvalidated() {
        // docs/03 §8: "server stores it, no validation needed for v1".
        let mut p = Player::new(0, "p".into(), Vec2::ZERO);
        for angle in [0.0, 1.5, -2.0, 100.0, -100.0] {
            p.set_aim(angle);
            assert_eq!(p.facing, angle, "aim {angle} was altered");
        }
    }

    #[test]
    fn set_aim_rejects_non_finite_angles() {
        // Not validation of RANGE (the doc declines that), but a NaN facing
        // would poison every projectile spawned from it in T3.8 and would
        // serialize as null in the snapshot.
        let mut p = Player::new(0, "p".into(), Vec2::ZERO);
        p.set_aim(1.0);
        for bad in [f32::NAN, f32::INFINITY, f32::NEG_INFINITY] {
            p.set_aim(bad);
            assert_eq!(p.facing, 1.0, "non-finite aim {bad} was stored");
        }
    }

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

/// Fixed simulation timestep, seconds (docs/00 §2: 20 Hz).
pub const DT: f32 = 0.05;

impl Player {
    /// Ground probe: is the tile 2 px below the feet solid? (docs/03 §4)
    ///
    /// "Ground detection: 2 px downward probe from feet, tile-based (check the
    /// tile under the feet point is solid) — cheaper than a rapier raycast,
    /// deterministic."
    ///
    /// Samples both lower corners as well as the centre, because the body is
    /// wider than a tile (D6): standing with one corner over a ledge is still
    /// standing.
    pub fn on_ground(&self, map: &Map) -> bool {
        let probe_y = self.feet_y() + 2.0;
        [
            self.pos.x - BODY_HALF_WIDTH + 0.5,
            self.pos.x,
            self.pos.x + BODY_HALF_WIDTH - 0.5,
        ]
        .iter()
        .any(|&x| map.is_solid_at_pixel(x, probe_y))
    }

    /// Which way A/D is steering: -1, 0 or +1. Both keys held is no input.
    pub fn input_direction(left: bool, right: bool) -> f32 {
        match (left, right) {
            (true, false) => -1.0,
            (false, true) => 1.0,
            _ => 0.0,
        }
    }

    /// Horizontal step for one tick (docs/03 §4, T2.3 step 3).
    ///
    /// On ground, A/D **set** velocity directly — "snappy Worms feel, no accel
    /// on ground" — and the returned acceleration is zero. In air they return
    /// ±AIR_ACCEL, which [`Player::integrate`] applies.
    pub fn step_horizontal(&mut self, left: bool, right: bool, on_ground: bool) -> f32 {
        let direction = Player::input_direction(left, right);

        if on_ground {
            self.vel.x = direction * MOVE_SPEED;
            return 0.0;
        }
        if direction == 0.0 {
            // docs/03 §4 / T2.4 step 2: no air drag in v1 — keep vel.x.
            return 0.0;
        }
        direction * AIR_ACCEL
    }

    /// Cap air-control speed at ±AIR_MAX (docs/03 §4), applied after
    /// integration since that is where velocity is updated.
    ///
    /// Only limits speed the player is actively accelerating toward; a velocity
    /// already above the cap from another source (a jetpack boost, a blast) is
    /// left alone rather than being silently braked.
    pub fn clamp_air_speed(&mut self, direction: f32, previous_vx: f32) {
        if direction > 0.0 && self.vel.x > AIR_MAX {
            self.vel.x = AIR_MAX.max(previous_vx.min(self.vel.x));
        } else if direction < 0.0 && self.vel.x < -AIR_MAX {
            self.vel.x = (-AIR_MAX).min(previous_vx.max(self.vel.x));
        }
    }

    /// Field-of-view radius in px (docs/03 §7, T2.10 step 1).
    ///
    /// ```text
    /// base = 420
    /// night_factor:  1.0 (full day) -> 0.45 (full night), lerp by day_phase
    /// fog_factor:    1.0, or 0.45 while heavy fog active
    /// health_factor: 1.0 if health >= 50, else 0.7
    /// fov = base * night_factor * fog_factor * health_factor
    /// if flashlight active: night_factor = 1.0 for this player
    /// ```
    ///
    /// A free function rather than a method, because the client mirrors it in
    /// `client/src/logic/fov.ts` and the two are pinned to a shared fixture —
    /// see DEVIATIONS.md D31.
    pub fn compute_fov(day_phase: f32, fog_active: bool, health: f32, flashlight: bool) -> f32 {
        let night_factor = if flashlight {
            // "if flashlight active: night_factor = 1.0 for this player"
            1.0
        } else {
            // Lerp 1.0 -> 0.45 by day_phase.
            1.0 + (FOV_NIGHT_MIN - 1.0) * day_phase.clamp(0.0, 1.0)
        };
        let fog_factor = if fog_active { FOV_FOG } else { 1.0 };
        let health_factor = if health >= FOV_LOW_HEALTH {
            1.0
        } else {
            FOV_LOW_HEALTH_FACTOR
        };
        FOV_BASE * night_factor * fog_factor * health_factor
    }

    /// Store the aim angle from an input frame (docs/03 §8, T2.8 step 1).
    ///
    /// "`aim` is a free angle from the client mouse (server stores it, no
    /// validation needed for v1)." Non-finite values are rejected rather than
    /// stored, since a NaN facing would poison every projectile spawned from
    /// it (T3.8) and propagate into snapshots.
    pub fn set_aim(&mut self, aim: f32) {
        if aim.is_finite() {
            self.facing = aim;
        }
    }

    /// Terminal fall speed, px/s (T2.6 Acceptance).
    ///
    /// Clamped after the velocity update so a long fall cannot accelerate
    /// without bound.
    pub fn clamp_fall_speed(&mut self) {
        if self.vel.y > TERMINAL_VELOCITY {
            self.vel.y = TERMINAL_VELOCITY;
        }
    }

    /// Apply a jump on the rising edge of space, if grounded (docs/03 §4).
    ///
    /// "Jump (rising edge of space, on ground): apply JUMP_VY impulse; if A or
    /// D held, also set horizontal vel to ±(MOVE_SPEED * JUMP_DIR_BIAS)."
    ///
    /// Returns whether the jump fired, so the caller knows the tick is
    /// airborne and must not also run jetpack thrust (docs/03 §5: "Jetpack
    /// cannot start on the ground").
    pub fn step_jump(&mut self, jump_pressed: bool, left: bool, right: bool, on_ground: bool) -> bool {
        if !(jump_pressed && on_ground) {
            return false;
        }
        self.vel.y = JUMP_VY;
        let direction = Player::input_direction(left, right);
        if direction != 0.0 {
            self.vel.x = direction * MOVE_SPEED * JUMP_DIR_BIAS;
        }
        true
    }

    /// Jetpack step for one tick (docs/03 §5, T2.5).
    ///
    /// Active iff **in the air**, space held, and fuel remains — "Jetpack
    /// cannot start on the ground (space on ground = jump only)". Returns the
    /// vertical acceleration the jetpack contributes, which the caller adds to
    /// gravity before integrating.
    ///
    /// W/S add ±JETPACK_VERTICAL_ASSIST while thrusting: "WASD all work in
    /// flight: W adds +300 px/s² up, S +300 down (net down can exceed
    /// gravity)".
    ///
    /// Fuel: burns JETPACK_BURN_RATE per second while thrusting, recharges
    /// JETPACK_RECHARGE_RATE per second while not, capped at JETPACK_FUEL_MAX.
    pub fn step_jetpack(
        &mut self,
        jump_held: bool,
        up: bool,
        down: bool,
        on_ground: bool,
        dt: f32,
    ) -> f32 {
        let thrusting = jump_held && !on_ground && self.jetpack.fuel > 0.0;

        if !thrusting {
            // docs/03 §5: recharge while NOT thrusting, capped.
            self.jetpack.fuel =
                (self.jetpack.fuel + JETPACK_RECHARGE_RATE * dt).min(JETPACK_FUEL_MAX);
            return 0.0;
        }

        // Burn, floored at zero — a partial tick of fuel still thrusts.
        self.jetpack.fuel = (self.jetpack.fuel - JETPACK_BURN_RATE * dt).max(0.0);

        // Negative is upward (y grows downward).
        let mut accel = -JETPACK_THRUST;
        if up {
            accel -= JETPACK_VERTICAL_ASSIST;
        }
        if down {
            accel += JETPACK_VERTICAL_ASSIST;
        }
        accel
    }

    /// Integrate one tick under constant acceleration (T2.3 step 4).
    ///
    /// Velocity Verlet: `x += v*dt + ½·a·dt²`, then `v += a·dt`.
    ///
    /// The integrator is NOT arbitrary here — see DEVIATIONS.md D28. T2.4
    /// asserts a jump apex of 58–63 px from `JUMP_VY = -330` and
    /// `GRAVITY = 900`. At the documented 20 Hz tick, semi-implicit Euler
    /// yields 52.5 px and explicit Euler 69.0 px; both fail. Verlet yields
    /// 60.375 px, matching the continuous `v²/2g = 60.5` the doc's "≈ 60.5 px"
    /// is quoting. Only this integrator satisfies the documented assertion.
    ///
    /// The pure path: rapier resolves collisions afterwards (D2).
    pub fn integrate(&mut self, accel: Vec2, dt: f32) {
        self.pos = self.pos + self.vel * dt + accel * (0.5 * dt * dt);
        self.vel = self.vel + accel * dt;
    }
}

/// What one simulated tick did, for callers that need to react to it
/// (round.rs emits events from these; the client renders them).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct TickOutcome {
    /// Ground state at the START of the tick, from the 2 px tile probe.
    pub on_ground: bool,
    pub jumped: bool,
    pub jetpack_active: bool,
    /// Terrain stopped the horizontal move.
    pub blocked_x: bool,
    /// Terrain stopped the vertical move — i.e. the player landed or hit a
    /// ceiling.
    pub blocked_y: bool,
}

impl Player {
    /// Simulate one tick: probe → jump → jetpack → horizontal → integrate →
    /// clamp → resolve against terrain.
    ///
    /// **This is the production per-tick sequence.** `round.rs` (T4.1) calls it
    /// once per player per tick; the physics tests call it too, so they
    /// exercise shipped code rather than a parallel implementation.
    ///
    /// Order matters and follows docs/03: ground state is sampled once at the
    /// top with the tile probe (§4) and reused, so a jump and the horizontal
    /// rule cannot disagree about whether the player was standing. The jetpack
    /// needs no "did we just jump" special case — `step_jetpack` already
    /// requires `!on_ground`, and the probe says grounded on a jump tick (§5:
    /// "Jetpack cannot start on the ground").
    ///
    /// The final step is the ONLY place rapier's output re-enters pure state,
    /// and it does so through one scalar rule — see [`Player::apply_collision`]
    /// and DEVIATIONS.md D32.
    pub fn step_tick(
        &mut self,
        world: &PhysicsWorld,
        map: &Map,
        frame: &InputFrame,
        edges: InputEdges,
        dt: f32,
    ) -> TickOutcome {
        let on_ground = self.on_ground(map);
        self.set_aim(frame.aim);

        // ORDER IS LOAD-BEARING. `step_horizontal` SETS vel.x directly when
        // grounded (docs/03 §4: "A/D set horizontal velocity to ±MOVE_SPEED
        // directly"), and `step_jump` then OVERRIDES it with the directional
        // bias ("if A or D held, also set horizontal vel to
        // ±(MOVE_SPEED * JUMP_DIR_BIAS)"). Jump must come last of the three or
        // the ground rule overwrites the bias and a directional jump launches
        // at full ground speed — 140 px/s instead of the documented 70.
        // See DEVIATIONS.md D33.
        let accel_x = self.step_horizontal(frame.left, frame.right, on_ground);
        let jet_accel = self.step_jetpack(frame.jump, frame.up, frame.down, on_ground, dt);
        let jumped = self.step_jump(edges.jump_pressed, frame.left, frame.right, on_ground);

        let previous_vx = self.vel.x;
        let before = self.pos;
        self.integrate(Vec2::new(accel_x, GRAVITY + jet_accel), dt);

        if !on_ground {
            self.clamp_air_speed(Player::input_direction(frame.left, frame.right), previous_vx);
        }
        self.clamp_fall_speed();

        let desired = self.pos - before;
        let (blocked_x, blocked_y) = self.apply_collision(world, before, desired, dt);

        TickOutcome {
            on_ground,
            jumped,
            jetpack_active: jet_accel != 0.0,
            blocked_x,
            blocked_y,
        }
    }

    /// Resolve a desired translation against terrain and fold the result back
    /// into position and velocity.
    ///
    /// Returns `(blocked_x, blocked_y)`.
    ///
    /// **The velocity rule is load-bearing and undocumented in docs/03** — see
    /// DEVIATIONS.md D32. When terrain stops motion along an axis, the velocity
    /// along that axis is spent and must be zeroed. Without it a player resting
    /// on the ground accumulates downward velocity every tick forever: the
    /// position never changes (collision keeps stopping it) while `vel.y` grows
    /// without bound, so the first tile destroyed underneath launches them
    /// through the map, and `clamp_fall_speed` merely caps how fast.
    ///
    /// This is also the single point at which rapier's output re-enters pure
    /// simulation state: one comparison per axis, on a value rapier already
    /// computed. Nothing else rapier produces is stored.
    pub fn apply_collision(
        &mut self,
        world: &PhysicsWorld,
        before: Vec2,
        desired: Vec2,
        dt: f32,
    ) -> (bool, bool) {
        // Axes are resolved SEPARATELY, in two shape-casts. A single combined
        // cast loses horizontal motion entirely when the body is a hair above
        // the floor and the move has any downward component: the controller
        // spends its whole budget resolving the vertical contact and returns
        // zero horizontal. Measured before this change: a player walking on
        // flat ground travelled 56 px per 10 ticks instead of the documented
        // 70 — a silent 20% speed loss. See DEVIATIONS.md D34.
        //
        // Splitting also makes "which axis was blocked" exact rather than
        // inferred from a combined translation, which is what D32's rule needs.
        // Each call is still a swept cast, so D29's anti-tunneling property is
        // unaffected.
        const EPSILON: f32 = 1e-4;

        let horizontal = world.move_player(before, Vec2::new(desired.x, 0.0), dt);
        let after_x = before + Vec2::new(horizontal.translation.x, 0.0);

        let vertical = world.move_player(after_x, Vec2::new(0.0, desired.y), dt);
        self.pos = after_x + Vec2::new(0.0, vertical.translation.y);

        // "Stopped short" rather than "moved zero": a slide along a wall still
        // travels, but not as far as asked.
        let blocked_x = horizontal.translation.x.abs() + EPSILON < desired.x.abs();
        let blocked_y = vertical.translation.y.abs() + EPSILON < desired.y.abs();

        if blocked_x {
            self.vel.x = 0.0;
        }
        if blocked_y {
            self.vel.y = 0.0;
        }
        (blocked_x, blocked_y)
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

/// T2.3–T2.5 movement tests.
///
/// Named `movement_tests` so the tasks' documented Test commands
/// (`cargo test -p game-core movement`, `... jump`, `... jetpack`) select them
/// — see DEVIATIONS.md D27 for why that is not automatic.
#[cfg(test)]
mod movement_tests {
    use super::*;
    use crate::map::Scale;
    use crate::tiles::{Tile, TileKind};

    /// A flat floor across the whole map, with its surface at row `floor_row`.
    fn flat_map(floor_row: u32) -> Map {
        let (width, height) = Scale::Small.dimensions();
        let mut map = Map {
            seed: 0,
            scale: Scale::Small,
            width,
            height,
            tiles: vec![Tile::AIR; (width * height) as usize],
            decor: Vec::new(),
            spawns: Vec::new(),
            version: 0,
        };
        for y in floor_row..height {
            for x in 0..width {
                map.set_tile(x, y, Tile::new(TileKind::Stone));
            }
        }
        map
    }

    /// A player standing on the floor of `map` at tile column `col`.
    fn standing(map: &Map, col: u32, floor_row: u32) -> Player {
        let pos = Vec2::new(
            (col as f32 + 0.5) * TILE_SIZE,
            floor_row as f32 * TILE_SIZE - BODY_HALF_HEIGHT,
        );
        Player::new(0, "p".into(), pos)
    }

    #[test]
    fn player_walks_on_ground() {
        // docs/08 §1 (physics row) + T2.3 Acceptance: "movement speed is
        // exactly 140 px/s (assert Δx over 10 ticks = 70 px)".
        //
        // 140 px/s * 10 ticks * 0.05 s = 70 px exactly.
        let floor_row = 40;
        let map = flat_map(floor_row);
        let mut player = standing(&map, 20, floor_row);
        let start_x = player.pos.x;
        let start_y = player.pos.y;

        for _ in 0..10 {
            let on_ground = player.on_ground(&map);
            assert!(on_ground, "player left the ground while walking");
            let ax = player.step_horizontal(false, true, on_ground);
            player.integrate(Vec2::new(ax, 0.0), DT);
        }

        let dx = player.pos.x - start_x;
        assert!(
            (dx - 70.0).abs() < 1e-4,
            "Δx over 10 ticks was {dx}, expected exactly 70",
        );
        assert_eq!(player.vel.x, 140.0, "docs/03 §4: MOVE_SPEED is 140 px/s");
        assert_eq!(player.pos.y, start_y, "walking must not change height");
    }

    #[test]
    fn walking_left_mirrors_walking_right() {
        let floor_row = 40;
        let map = flat_map(floor_row);
        let mut player = standing(&map, 20, floor_row);
        let start_x = player.pos.x;
        for _ in 0..10 {
            let g = player.on_ground(&map);
            let ax = player.step_horizontal(true, false, g);
            player.integrate(Vec2::new(ax, 0.0), DT);
        }
        assert!((player.pos.x - start_x + 70.0).abs() < 1e-4);
        assert_eq!(player.vel.x, -140.0);
    }

    #[test]
    fn no_input_stops_instantly_on_ground() {
        // docs/03 §4: "neither → 0", no ground friction model.
        let floor_row = 40;
        let map = flat_map(floor_row);
        let mut player = standing(&map, 20, floor_row);
        player.vel.x = MOVE_SPEED;
        player.step_horizontal(false, false, true);
        assert_eq!(player.vel.x, 0.0);
        // Both keys held is also "no input", not a tie broken arbitrarily.
        player.vel.x = MOVE_SPEED;
        player.step_horizontal(true, true, true);
        assert_eq!(player.vel.x, 0.0);
    }

    #[test]
    fn walking_off_a_cliff_leaves_the_ground() {
        // T2.3 step 5: "walking off a cliff → next tick on_ground false".
        let floor_row = 40;
        let mut map = flat_map(floor_row);
        // Remove the floor beyond column 30 to make a cliff edge.
        for y in floor_row..map.height {
            for x in 31..map.width {
                map.set_tile(x, y, Tile::AIR);
            }
        }
        let mut player = standing(&map, 28, floor_row);
        assert!(player.on_ground(&map), "should start on solid ground");

        let mut left_ground = false;
        for _ in 0..40 {
            let g = player.on_ground(&map);
            let ax = player.step_horizontal(false, true, g);
            player.integrate(Vec2::new(ax, 0.0), DT);
            if !player.on_ground(&map) {
                left_ground = true;
                break;
            }
        }
        assert!(left_ground, "player never left the ground walking off a cliff");
    }

    #[test]
    fn ground_probe_is_two_pixels() {
        // docs/03 §4: the probe is 2 px below the feet. Lifting the player
        // 3 px off the floor must read as airborne, 1 px as grounded.
        let floor_row = 40;
        let map = flat_map(floor_row);
        let mut player = standing(&map, 20, floor_row);
        assert!(player.on_ground(&map));

        player.pos.y -= 1.0;
        assert!(player.on_ground(&map), "1 px above the floor is still grounded");

        player.pos.y -= 2.5;
        assert!(!player.on_ground(&map), "3.5 px above the floor is airborne");
    }

    #[test]
    fn air_control_accelerates_toward_the_cap() {
        // docs/03 §4: in air, A/D accelerate toward ±AIR_MAX at AIR_ACCEL.
        let map = flat_map(40);
        let mut player = standing(&map, 20, 40);
        player.pos.y -= 200.0; // airborne
        assert!(!player.on_ground(&map));

        let ax = player.step_horizontal(false, true, false);
        player.integrate(Vec2::new(ax, 0.0), DT);
        // Literal from docs/03 §4: AIR_ACCEL 600 px/s^2 * 0.05 s = 30 px/s.
        // Asserting against AIR_ACCEL itself would move both sides together
        // and constrain nothing (found by injection: 600 -> 700 failed 0 tests).
        assert!(
            (player.vel.x - 30.0).abs() < 1e-4,
            "one tick of air control gave {} px/s, expected 30 (600 * 0.05)",
            player.vel.x,
        );

        // Accelerating for many ticks must stop at the cap, not overshoot.
        for _ in 0..100 {
            let prev = player.vel.x;
            let ax = player.step_horizontal(false, true, false);
            player.integrate(Vec2::new(ax, 0.0), DT);
            player.clamp_air_speed(1.0, prev);
        }
        // Literal from docs/03 §4: AIR_MAX = 140 px/s.
        assert!(
            (player.vel.x - 140.0).abs() < 1e-4,
            "air control settled at {} px/s, expected the documented cap 140",
            player.vel.x,
        );
    }

    #[test]
    fn air_control_reverses_direction() {
        // T2.4 step 4: "mid-air A flips direction within 1 tick" — the sign of
        // acceleration must flip immediately even at full speed.
        let map = flat_map(40);
        let mut player = standing(&map, 20, 40);
        player.pos.y -= 200.0;
        player.vel.x = AIR_MAX;
        let ax = player.step_horizontal(true, false, false);
        player.integrate(Vec2::new(ax, 0.0), DT);
        assert!(
            player.vel.x < AIR_MAX,
            "holding left at full right speed must decelerate immediately",
        );
    }

    #[test]
    fn no_air_drag_without_input() {
        // docs/03 §4 / T2.4 step 2: "else keeps vel.x (no air drag in v1)".
        let map = flat_map(40);
        let mut player = standing(&map, 20, 40);
        player.pos.y -= 200.0;
        player.vel.x = 123.0;
        for _ in 0..20 {
            let ax = player.step_horizontal(false, false, false);
            player.integrate(Vec2::new(ax, 0.0), DT);
        }
        assert_eq!(player.vel.x, 123.0, "air velocity decayed without input");
    }
}

/// T2.4 jump tests.
#[cfg(test)]
mod jump_tests {
    use super::*;
    use crate::map::Scale;
    use crate::tiles::{Tile, TileKind};

    fn flat_map(floor_row: u32) -> Map {
        let (width, height) = Scale::Small.dimensions();
        let mut map = Map {
            seed: 0,
            scale: Scale::Small,
            width,
            height,
            tiles: vec![Tile::AIR; (width * height) as usize],
            decor: Vec::new(),
            spawns: Vec::new(),
            version: 0,
        };
        for y in floor_row..height {
            for x in 0..width {
                map.set_tile(x, y, Tile::new(TileKind::Stone));
            }
        }
        map
    }

    fn standing(map: &Map, col: u32, floor_row: u32) -> Player {
        let _ = map;
        Player::new(
            0,
            "p".into(),
            Vec2::new(
                (col as f32 + 0.5) * TILE_SIZE,
                floor_row as f32 * TILE_SIZE - BODY_HALF_HEIGHT,
            ),
        )
    }

    /// Simulate a jump and return (apex height above start, ticks to land).
    fn simulate_jump(left: bool, right: bool) -> (f32, u32, Player) {
        let floor_row = 40;
        let map = flat_map(floor_row);
        let mut player = standing(&map, 20, floor_row);
        let start_y = player.pos.y;

        let on_ground = player.on_ground(&map);
        player.step_jump(true, left, right, on_ground);

        let mut apex = 0.0f32;
        let mut ticks = 0u32;
        for tick in 1..200u32 {
            let grounded = player.on_ground(&map);
            let ax = player.step_horizontal(left, right, grounded);
            player.integrate(Vec2::new(ax, GRAVITY), DT);
            apex = apex.max(start_y - player.pos.y);
            // Landed: back at or below the starting height, moving downward.
            if player.pos.y >= start_y && player.vel.y > 0.0 {
                player.pos.y = start_y;
                player.vel.y = 0.0;
                ticks = tick;
                break;
            }
        }
        (apex, ticks, player)
    }

    #[test]
    fn jump_arc() {
        // docs/08 §1 (physics row) + T2.4 Acceptance: "standing jump height
        // ≈ 60 px (assert 58–63)".
        //
        // The doc's "apex ≈ 330²/(2*900) ≈ 60.5 px" is the CONTINUOUS result.
        // At the documented 20 Hz tick only velocity Verlet reproduces it —
        // semi-implicit Euler gives 52.5 px and explicit Euler 69.0 px, both
        // outside the asserted range. See DEVIATIONS.md D28.
        let (apex, ticks, _) = simulate_jump(false, false);
        assert!(
            (58.0..=63.0).contains(&apex),
            "jump apex {apex} px is outside the documented 58–63 range",
        );
        assert!(
            (apex - 60.5).abs() <= 2.0,
            "apex {apex} is not within 2 px of the doc's 60.5",
        );
        assert!(ticks > 0, "player never landed");
    }

    #[test]
    fn jump_returns_to_the_ground() {
        // A jump that never lands would still satisfy an apex assertion.
        let (_, ticks, player) = simulate_jump(false, false);
        // 2 * v / g = 2*330/900 = 0.733 s = ~15 ticks.
        assert!(
            (12..=18).contains(&ticks),
            "landed after {ticks} ticks, expected ~15 (2*330/900 = 0.73 s)",
        );
        assert_eq!(player.vel.y, 0.0);
    }

    #[test]
    fn jump_with_direction_held_applies_the_bias() {
        // T2.4 step 1: "if A/D held vel.x = ±70 (140 * 0.5 bias)".
        let floor_row = 40;
        let map = flat_map(floor_row);
        let mut player = standing(&map, 20, floor_row);
        let on_ground = player.on_ground(&map);

        assert!(player.step_jump(true, false, true, on_ground));
        assert_eq!(player.vel.y, -330.0, "docs/03 §4: JUMP_VY is -330 px/s");
        assert!(
            (player.vel.x - 70.0).abs() < 1e-4,
            "jump bias gave vel.x {}, expected 70",
            player.vel.x,
        );

        let mut player = standing(&map, 20, floor_row);
        player.step_jump(true, true, false, true);
        assert!((player.vel.x + 70.0).abs() < 1e-4);
    }

    #[test]
    fn jump_without_direction_keeps_horizontal_velocity() {
        // The bias applies only "if A or D held" (docs/03 §4).
        let map = flat_map(40);
        let mut player = standing(&map, 20, 40);
        player.vel.x = 123.0;
        player.step_jump(true, false, false, true);
        assert_eq!(player.vel.x, 123.0);
        assert_eq!(player.vel.y, -330.0);
    }

    #[test]
    fn jump_does_nothing_in_the_air() {
        // docs/03 §4: jump requires the rising edge AND being on ground.
        let map = flat_map(40);
        let mut player = standing(&map, 20, 40);
        player.pos.y -= 200.0;
        player.vel.y = 50.0;
        assert!(!player.step_jump(true, false, false, false));
        assert_eq!(player.vel.y, 50.0, "an airborne jump changed velocity");
    }

    #[test]
    fn jump_does_nothing_without_an_edge() {
        let map = flat_map(40);
        let mut player = standing(&map, 20, 40);
        assert!(!player.step_jump(false, false, false, true));
        assert_eq!(player.vel.y, 0.0);
    }

    #[test]
    fn directional_jump_travels_further_than_a_standing_one() {
        // The observable consequence of JUMP_DIR_BIAS.
        let (_, _, standing_player) = simulate_jump(false, false);
        let (_, _, moving_player) = simulate_jump(false, true);
        assert!(
            moving_player.pos.x > standing_player.pos.x,
            "a directional jump should cover ground",
        );
    }

    #[test]
    fn mid_air_direction_change_takes_effect_within_one_tick() {
        // T2.4 step 4: "mid-air A flips direction within 1 tick".
        let map = flat_map(40);
        let mut player = standing(&map, 20, 40);
        player.step_jump(true, false, true, true);
        // Airborne now; hold the opposite direction for one tick.
        player.pos.y -= 50.0;
        let before = player.vel.x;
        let ax = player.step_horizontal(true, false, false);
        player.integrate(Vec2::new(ax, GRAVITY), DT);
        assert!(
            player.vel.x < before,
            "holding A mid-air did not decelerate: {before} -> {}",
            player.vel.x,
        );
    }
}

/// T2.5 jetpack tests.
#[cfg(test)]
mod jetpack_tests {
    use super::*;
    use crate::map::Scale;
    use crate::tiles::{Tile, TileKind};

    fn flat_map(floor_row: u32) -> Map {
        let (width, height) = Scale::Small.dimensions();
        let mut map = Map {
            seed: 0,
            scale: Scale::Small,
            width,
            height,
            tiles: vec![Tile::AIR; (width * height) as usize],
            decor: Vec::new(),
            spawns: Vec::new(),
            version: 0,
        };
        for y in floor_row..height {
            for x in 0..width {
                map.set_tile(x, y, Tile::new(TileKind::Stone));
            }
        }
        map
    }

    fn airborne() -> Player {
        Player::new(0, "p".into(), Vec2::new(320.0, 200.0))
    }

    #[test]
    fn jetpack_rises_and_fuel_drains() {
        // docs/08 §1 (physics row) + T2.5 step 5: "1 s thrust -> fuel 4.0, net
        // upward velocity".
        let mut player = airborne();
        let start_y = player.pos.y;

        for _ in 0..20 {
            let jet = player.step_jetpack(true, false, false, false, DT);
            player.integrate(Vec2::new(0.0, GRAVITY + jet), DT);
        }

        assert!(
            (player.jetpack.fuel - 4.0).abs() < 0.01,
            "after 1 s of thrust fuel is {}, expected 4.0",
            player.jetpack.fuel,
        );
        assert!(
            player.vel.y < 0.0,
            "1 s of thrust should leave net upward velocity, got {}",
            player.vel.y,
        );
        assert!(player.pos.y < start_y, "player did not rise");

        // T2.5 step 2: net acceleration is 1100 up vs 900 gravity = 200 up.
        // After 1 s that is 200 px/s upward.
        assert!(
            (player.vel.y + 200.0).abs() < 1e-3,
            "net vertical velocity after 1 s is {}, expected -200",
            player.vel.y,
        );
    }

    #[test]
    fn jetpack_recharge_rate() {
        // docs/08 §1 + T2.5 step 5: "2 s idle -> +1.0 fuel, capped at 5.0".
        let mut player = airborne();
        player.jetpack.fuel = 2.0;

        for _ in 0..40 {
            let jet = player.step_jetpack(false, false, false, false, DT);
            assert_eq!(jet, 0.0, "no thrust means no acceleration");
            player.integrate(Vec2::new(0.0, GRAVITY + jet), DT);
        }

        assert!(
            (player.jetpack.fuel - 3.0).abs() < 0.01,
            "2 s idle from 2.0 gave {}, expected 3.0",
            player.jetpack.fuel,
        );
    }

    #[test]
    fn fuel_is_capped_at_five() {
        let mut player = airborne();
        player.jetpack.fuel = 4.9;
        for _ in 0..200 {
            player.step_jetpack(false, false, false, false, DT);
        }
        assert_eq!(player.jetpack.fuel, 5.0, "docs/03 §5: fuel caps at 5.0 s");
    }

    #[test]
    fn jetpack_does_not_start_on_the_ground() {
        // docs/03 §5: "Jetpack cannot start on the ground (space on ground =
        // jump only)".
        let map = flat_map(40);
        let mut player = Player::new(
            0,
            "p".into(),
            Vec2::new(320.0, 40.0 * TILE_SIZE - BODY_HALF_HEIGHT),
        );
        assert!(player.on_ground(&map));

        let accel = player.step_jetpack(true, false, false, true, DT);
        assert_eq!(accel, 0.0, "jetpack thrusted while grounded");
        // And it recharges rather than burning.
        assert!(player.jetpack.fuel >= 5.0 - 1e-6);
    }

    #[test]
    fn empty_tank_produces_no_thrust() {
        let mut player = airborne();
        player.jetpack.fuel = 0.0;
        let accel = player.step_jetpack(true, false, false, false, DT);
        assert_eq!(accel, 0.0, "thrust on an empty tank");
    }

    #[test]
    fn fuel_never_goes_negative() {
        let mut player = airborne();
        player.jetpack.fuel = 0.02;
        for _ in 0..10 {
            player.step_jetpack(true, false, false, false, DT);
        }
        assert!(player.jetpack.fuel >= 0.0, "fuel went negative");
    }

    #[test]
    fn w_and_s_assist_in_flight() {
        // docs/03 §5: "W adds +300 px/s² up, S +300 down (net down can exceed
        // gravity)".
        let mut base = airborne();
        let plain = base.step_jetpack(true, false, false, false, DT);

        // Literals from docs/03 §5, NOT the constants under test. Comparing
        // against JETPACK_VERTICAL_ASSIST would make this self-referential:
        // changing the constant would move both sides and the test would pass.
        // (Found exactly that way — the injection 300 -> 500 failed 0 tests.)
        assert!(
            (plain + 1100.0).abs() < 1e-3,
            "plain thrust is {plain}, docs/03 §5 says 1100 px/s² up",
        );

        let mut up_player = airborne();
        let with_up = up_player.step_jetpack(true, true, false, false, DT);
        assert!(
            (with_up + 1400.0).abs() < 1e-3,
            "W thrust is {with_up}, expected -(1100 + 300)",
        );

        let mut down_player = airborne();
        let with_down = down_player.step_jetpack(true, false, true, false, DT);
        assert!(
            (with_down + 800.0).abs() < 1e-3,
            "S thrust is {with_down}, expected -(1100 - 300)",
        );

        // "net down can exceed gravity": thrust 1100 up, S 300 down, gravity
        // 900 down => 1100 - 300 - 900 = -100, still net up. With W and S both
        // held they cancel.
        let mut both = airborne();
        let with_both = both.step_jetpack(true, true, true, false, DT);
        assert!((with_both - plain).abs() < 1e-3, "W and S should cancel");
    }

    #[test]
    fn fuel_math_is_exact_over_a_ten_second_sequence() {
        // T2.5 Acceptance: "fuel math exact to 0.01 over a 10 s scripted
        // sequence". Scripted: 2 s thrust, 3 s idle, 1 s thrust, 4 s idle.
        let mut player = airborne();
        let script = [(2.0, true), (3.0, false), (1.0, true), (4.0, false)];

        let mut expected = JETPACK_FUEL_MAX;
        for (seconds, thrusting) in script {
            let ticks = (seconds / DT).round() as u32;
            for _ in 0..ticks {
                player.step_jetpack(thrusting, false, false, false, DT);
            }
            expected = if thrusting {
                (expected - JETPACK_BURN_RATE * seconds).max(0.0)
            } else {
                (expected + JETPACK_RECHARGE_RATE * seconds).min(JETPACK_FUEL_MAX)
            };
        }

        // 5.0 -2.0 = 3.0; +1.5 = 4.5; -1.0 = 3.5; +2.0 = 5.0 (capped).
        assert!(
            (player.jetpack.fuel - expected).abs() < 0.01,
            "scripted fuel is {}, expected {expected}",
            player.jetpack.fuel,
        );
        assert!((expected - 5.0).abs() < 1e-6, "script arithmetic drifted");
    }
}

/// T2.10 FOV tests.
#[cfg(test)]
mod fov_tests {
    use super::*;

    /// The canonical cases. This table is ALSO emitted as a JSON fixture by
    /// `examples/fov_vectors.rs` and asserted by the client's `fov.test.ts`,
    /// so both implementations are pinned to one source of truth (D31).
    ///
    /// `(day_phase, fog, health, flashlight, expected_fov)`
    pub const FOV_VECTORS: [(f32, bool, f32, bool, f32); 12] = [
        // Full day, healthy, no fog: the base radius.
        (0.0, false, 100.0, false, 420.0),
        // Full night: 420 * 0.45.
        (1.0, false, 100.0, false, 189.0),
        // Half-way to night: night_factor = 1 - 0.55*0.5 = 0.725.
        (0.5, false, 100.0, false, 304.5),
        // Fog by day: 420 * 0.45 (T4.7 asserts exactly this).
        (0.0, true, 100.0, false, 189.0),
        // Low health by day: 420 * 0.7.
        (0.0, false, 49.0, false, 294.0),
        // Exactly 50 hp is NOT low (docs/03 §7 says "health >= 50").
        (0.0, false, 50.0, false, 420.0),
        // Night + fog: 420 * 0.45 * 0.45.
        (1.0, true, 100.0, false, 85.05),
        // Night + low health: 420 * 0.45 * 0.7.
        (1.0, false, 10.0, false, 132.3),
        // All three: 420 * 0.45 * 0.45 * 0.7.
        (1.0, true, 10.0, false, 59.535),
        // Flashlight cancels night entirely.
        (1.0, false, 100.0, true, 420.0),
        // Flashlight does NOT cancel fog or low health.
        (1.0, true, 100.0, true, 189.0),
        (1.0, false, 10.0, true, 294.0),
    ];

    #[test]
    fn fov_night_fog_lowhealth() {
        // docs/08 §1 (player row): "assert exact values for given inputs".
        for (day_phase, fog, health, flashlight, expected) in FOV_VECTORS {
            let actual = Player::compute_fov(day_phase, fog, health, flashlight);
            assert!(
                (actual - expected).abs() < 1e-3,
                "fov(day_phase={day_phase}, fog={fog}, health={health}, \
                 flashlight={flashlight}) = {actual}, expected {expected}",
            );
        }
    }

    #[test]
    fn fov_flashlight_restores_night() {
        // docs/08 §1 (player row).
        let without = Player::compute_fov(1.0, false, 100.0, false);
        let with = Player::compute_fov(1.0, false, 100.0, true);
        assert!((without - 189.0).abs() < 1e-3);
        assert!((with - 420.0).abs() < 1e-3, "docs/03 §7: base FOV is 420 px");
        assert!(with > without, "flashlight must widen the view at night");

        // T2.10 Acceptance: "at full night without flashlight, a player 400 px
        // away is invisible; with flashlight, visible."
        assert!(without < 400.0, "400 px should be outside night FOV");
        assert!(with > 400.0, "400 px should be inside flashlight FOV");
    }

    #[test]
    fn fov_is_monotonic_in_day_phase() {
        // Night closes in gradually; no jumps or reversals.
        let mut previous = f32::INFINITY;
        for step in 0..=100 {
            let phase = step as f32 / 100.0;
            let fov = Player::compute_fov(phase, false, 100.0, false);
            assert!(fov <= previous + 1e-4, "fov increased at day_phase {phase}");
            previous = fov;
        }
    }

    #[test]
    fn fov_clamps_day_phase_to_its_documented_range() {
        // day_phase is documented as 0..1 (docs/02 §1). Out-of-range input must
        // not produce a negative or runaway radius.
        assert_eq!(
            Player::compute_fov(-5.0, false, 100.0, false),
            Player::compute_fov(0.0, false, 100.0, false),
        );
        assert_eq!(
            Player::compute_fov(5.0, false, 100.0, false),
            Player::compute_fov(1.0, false, 100.0, false),
        );
        assert!(Player::compute_fov(99.0, true, 1.0, false) > 0.0);
    }

    #[test]
    fn low_health_threshold_is_exactly_50() {
        // docs/03 §7: "health_factor: 1.0 if health >= 50, else 0.7".
        assert_eq!(Player::compute_fov(0.0, false, 50.0, false), 420.0);
        assert!(Player::compute_fov(0.0, false, 49.999, false) < 420.0);
    }
}
