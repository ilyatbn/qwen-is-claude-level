//! `game-core` — the pure deterministic simulation crate.
//!
//! Rules (docs/00-architecture.md §7):
//! - ZERO dependencies on async/IO/network crates.
//! - All randomness flows through [`rng::GameRng`] (docs/00 §4).
//! - The tick number is the only clock; nothing here reads a wall clock.

pub mod effects;
pub mod items;
pub mod map;
pub mod physics;
pub mod player;
pub mod protocol;
pub mod rng;
pub mod round;
pub mod tiles;

use serde::{Deserialize, Serialize};

/// Minimal 2-D vector.
///
/// docs/01-map.md §4 (`spawns: Vec<Vec2>`) and docs/03-player.md §1
/// (`pos`/`vel`) both use `Vec2`, but the design never defines it and lists no
/// math module — see DEVIATIONS.md D8.
#[derive(Debug, Clone, Copy, PartialEq, Default, Serialize, Deserialize)]
pub struct Vec2 {
    pub x: f32,
    pub y: f32,
}

impl Vec2 {
    pub const ZERO: Vec2 = Vec2 { x: 0.0, y: 0.0 };

    pub const fn new(x: f32, y: f32) -> Self {
        Vec2 { x, y }
    }

    pub fn length(self) -> f32 {
        (self.x * self.x + self.y * self.y).sqrt()
    }

    pub fn distance_to(self, other: Vec2) -> f32 {
        (self - other).length()
    }
}

impl std::ops::Add for Vec2 {
    type Output = Vec2;
    fn add(self, rhs: Vec2) -> Vec2 {
        Vec2::new(self.x + rhs.x, self.y + rhs.y)
    }
}

impl std::ops::Sub for Vec2 {
    type Output = Vec2;
    fn sub(self, rhs: Vec2) -> Vec2 {
        Vec2::new(self.x - rhs.x, self.y - rhs.y)
    }
}

impl std::ops::Mul<f32> for Vec2 {
    type Output = Vec2;
    fn mul(self, rhs: f32) -> Vec2 {
        Vec2::new(self.x * rhs, self.y * rhs)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn vec2_math() {
        let a = Vec2::new(3.0, 4.0);
        assert_eq!(a.length(), 5.0);
        assert_eq!(a + Vec2::new(1.0, 1.0), Vec2::new(4.0, 5.0));
        assert_eq!(a - Vec2::new(3.0, 4.0), Vec2::ZERO);
        assert_eq!(a * 2.0, Vec2::new(6.0, 8.0));
        assert_eq!(Vec2::ZERO.distance_to(Vec2::new(0.0, 2.0)), 2.0);
    }
}
