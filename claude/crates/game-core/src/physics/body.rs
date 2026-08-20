//! The player body: pure kinematics, nothing else.
//!
//! **Position is the CENTRE of the AABB**, not the top-left. Every other file in
//! the project assumes this. Half the collision bugs in a project like this come
//! from two files disagreeing about the anchor, so it is stated once here and never
//! re-decided.
//!
//! See `docs/20-player-movement.md` §1, §6.

use crate::constants::{COYOTE_TIME, PLAYER_H, PLAYER_W, SIM_HZ};
use crate::math::{Aabb, Vec2};

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Body {
    /// Centre of the AABB, in world pixels.
    pub pos: Vec2,
    pub vel: Vec2,
    pub grounded: bool,
    /// Ticks since last grounded; 0 while grounded. A tick count rather than a
    /// float timer, so coyote time is exact and frame-rate independent.
    pub airborne_ticks: u32,
    /// AABB width and height. Defaults to the player's `PLAYER_W × PLAYER_H`.
    ///
    /// Carried on the body so world items (16×16) and crates (`CRATE_W × CRATE_H`)
    /// go through **this** resolver rather than a second one. An item that falls
    /// through terrain a player cannot walk through is a confusing bug, and two
    /// collision paths guarantee it eventually.
    pub size: Vec2,
}

/// Coyote window in ticks: 0.10 s × 60 Hz = 6.
pub const COYOTE_TICKS: u32 = (COYOTE_TIME * SIM_HZ as f32) as u32;

impl Body {
    pub fn new(pos: Vec2) -> Self {
        Body {
            pos,
            vel: Vec2::ZERO,
            grounded: false,
            airborne_ticks: 0,
            size: Vec2::new(PLAYER_W, PLAYER_H),
        }
    }

    /// A body with a non-player AABB — world items and crates.
    pub fn sized(pos: Vec2, w: f32, h: f32) -> Self {
        Body {
            size: Vec2::new(w, h),
            ..Body::new(pos)
        }
    }

    #[inline]
    pub fn aabb(&self) -> Aabb {
        Aabb::from_center_size(self.pos, self.size.x, self.size.y)
    }

    // Sized from `self.size`, not from PLAYER_H. `Body` became polymorphic when
    // world items started using it, and a 16x16 item asking for `feet_y()` would
    // otherwise get a 14 px offset instead of 8 — silently, and only in whichever
    // M5/M6 caller asked first.
    #[inline]
    pub fn feet_y(&self) -> f32 {
        self.pos.y + self.size.y / 2.0
    }

    #[inline]
    pub fn head_y(&self) -> f32 {
        self.pos.y - self.size.y / 2.0
    }

    /// A jump still works for this long after walking off a ledge.
    #[inline]
    pub fn in_coyote_time(&self) -> bool {
        self.airborne_ticks <= COYOTE_TICKS
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum MoveState {
    Grounded,
    Airborne,
    Jetpack,
}

/// Derived every tick, **never stored**.
///
/// A stored mode gets out of sync with `grounded` and produces players permanently
/// stuck in a jetpack animation they cannot leave. Deriving it makes that class of
/// bug impossible.
#[inline]
pub fn move_state(body: &Body, jetpack_active: bool) -> MoveState {
    if jetpack_active {
        MoveState::Jetpack
    } else if body.grounded {
        MoveState::Grounded
    } else {
        MoveState::Airborne
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_aabb_is_centred_on_pos() {
        // Pins the centre-anchor convention with exact numbers, for a 16x28 box.
        let b = Body::new(Vec2::new(100.0, 100.0));
        assert_eq!(b.aabb().min(), Vec2::new(92.0, 86.0));
        assert_eq!(b.aabb().max(), Vec2::new(108.0, 114.0));
    }

    #[test]
    fn feet_and_head() {
        let b = Body::new(Vec2::new(0.0, 100.0));
        assert_eq!(b.feet_y(), 100.0 + PLAYER_H / 2.0);
        assert_eq!(b.head_y(), 100.0 - PLAYER_H / 2.0);
        assert_eq!(b.feet_y() - b.head_y(), PLAYER_H);
    }

    #[test]
    fn coyote_window_boundaries() {
        assert_eq!(COYOTE_TICKS, 6, "0.10 s at 60 Hz");
        let mut b = Body::new(Vec2::ZERO);

        b.airborne_ticks = 0;
        assert!(b.in_coyote_time());
        b.airborne_ticks = COYOTE_TICKS;
        assert!(b.in_coyote_time(), "the boundary tick is still inside");
        b.airborne_ticks = COYOTE_TICKS + 1;
        assert!(!b.in_coyote_time());
    }

    #[test]
    fn move_state_is_derived_from_grounded_and_jetpack() {
        let mut b = Body::new(Vec2::ZERO);

        b.grounded = true;
        assert_eq!(move_state(&b, false), MoveState::Grounded);
        // Jetpack wins even while grounded — you can lift off from the floor.
        assert_eq!(move_state(&b, true), MoveState::Jetpack);

        b.grounded = false;
        assert_eq!(move_state(&b, false), MoveState::Airborne);
        assert_eq!(move_state(&b, true), MoveState::Jetpack);
    }

    #[test]
    fn body_is_copy_and_comparable() {
        // Prediction (T6.09) keeps snapshots of these and compares them.
        let a = Body::new(Vec2::new(1.0, 2.0));
        let b = a;
        assert_eq!(a, b);

        let mut c = a;
        c.vel.x += 1.0;
        assert_ne!(a, c);
        // `a` still usable: Copy, not moved.
        assert_eq!(a.pos, Vec2::new(1.0, 2.0));
    }

    #[test]
    fn a_new_body_starts_at_rest_and_airborne() {
        let b = Body::new(Vec2::new(5.0, 5.0));
        assert_eq!(b.vel, Vec2::ZERO);
        assert!(!b.grounded, "grounding must be established by the resolver");
        assert_eq!(b.airborne_ticks, 0);
    }
}

#[cfg(test)]
mod size_tests {
    use super::*;
    use crate::constants::{PLAYER_H, PLAYER_W};

    #[test]
    fn the_helpers_follow_the_body_size_not_the_players() {
        let player = Body::new(Vec2::new(100.0, 100.0));
        assert_eq!(player.feet_y(), 100.0 + PLAYER_H / 2.0);
        assert_eq!(player.aabb().width(), PLAYER_W);

        // A world item is 16x16: its feet are 8 px below centre, not 14.
        let item = Body::sized(Vec2::new(100.0, 100.0), 16.0, 16.0);
        assert_eq!(item.feet_y(), 108.0);
        assert_eq!(item.head_y(), 92.0);
        assert_eq!(item.aabb().width(), 16.0);
        assert_eq!(item.aabb().height(), 16.0);
    }
}
