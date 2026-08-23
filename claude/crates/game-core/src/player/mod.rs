//! The player: input, movement rules, the jetpack, and `apply_input`.

pub mod input;
pub mod jetpack;
pub mod movement;
pub mod respawn;

pub use input::{button, edges, Input, InputEdges};
pub use jetpack::JetpackState;
pub use movement::{apply_horizontal, try_jump, JumpState};

use crate::map::Map;
use crate::physics::body::Body;
use crate::physics::resolve::integrate;

/// Everything a player's own input does in one tick.
///
/// **Pure.** No randomness, no time source, no logging, no allocation. The client
/// calls this dozens of times per frame during reconciliation replay
/// (`docs/42-netcode-prediction.md` §2), and its purity is the property that makes
/// prediction correct. If anything in the call chain were impure, prediction would
/// silently drift and surface as rubber-banding weeks later.
///
/// The order is part of the contract:
/// 1. derive edges;
/// 2. horizontal acceleration;
/// 3. `try_jump` — **before** the jetpack, so a grounded press is consumed by the
///    jump and the jetpack only sees what is left. That is the whole Space
///    disambiguation;
/// 4. jetpack decision and fuel;
/// 5. jetpack thrust, if engaged;
/// 6. `integrate` **last** — every force lands in velocity first, then the body
///    moves once. Moving between force applications would make the result depend on
///    the order of the forces, which is exactly what diverges between server and
///    client under reordering.
#[allow(clippy::too_many_arguments)]
pub fn apply_input(
    map: &Map,
    body: &mut Body,
    jump: &mut JumpState,
    jet: &mut JetpackState,
    input: &Input,
    prev: &Input,
    speed_multiplier: f32,
    dt: f32,
) {
    let e = edges(input, prev);
    let dir = input.move_dir();

    apply_horizontal(body, dir, speed_multiplier, dt);

    let jumped = try_jump(body, jump, e.jump_pressed, dir);

    jetpack::update(
        jet,
        body,
        input.held(button::JUMP),
        e.jump_pressed,
        jumped,
        dt,
    );

    if jet.active {
        jetpack::apply_thrust(body, input, dt);
    }

    integrate(map, body, jetpack::gravity_scale(jet), dt);
}

/// The complete per-player movement state, so a caller can snapshot and restore it
/// in one value. Prediction (T6.09) and the determinism tests both need this.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct MovementState {
    pub body: Body,
    pub jump: JumpState,
    pub jet: JetpackState,
}

impl MovementState {
    pub fn new(body: Body) -> Self {
        MovementState {
            body,
            jump: JumpState::default(),
            jet: JetpackState::default(),
        }
    }

    pub fn step(&mut self, map: &Map, input: &Input, prev: &Input, speed_multiplier: f32, dt: f32) {
        apply_input(
            map,
            &mut self.body,
            &mut self.jump,
            &mut self.jet,
            input,
            prev,
            speed_multiplier,
            dt,
        );
    }
}
pub mod state;
