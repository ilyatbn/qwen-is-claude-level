//! T23.30 B — **drifting toxic clouds**, Multilevel's bottom-level weather (`docs/78` §A5:
//! "meteor showers hit the top level only; the bottom level gets drifting toxic clouds
//! instead — the existing toxic hazard, passing through").
//!
//! Rides on the meteor shower: while it drops meteors on the top level,
//! `TOXIC_DRIFT_CLOUDS` clouds drift sideways through the gap, hovering
//! `TOXIC_DRIFT_HOVER` over the lower ground, and every `TOXIC_DRIFT_EVERY` each lays
//! a toxic grenade patch (`BurnField`, `HazardKind::Toxic`) where it is — **the existing
//! hazard**: it damages whoever stands in it, it is hashed with the rest of the burn
//! field, and the client already draws it. A cloud that drifts off one side comes back
//! in at the other. Its own RNG sub-stream, so the meteors' draws do not move.

use crate::constants::{
    TOXIC_DRIFT_CLOUDS, TOXIC_DRIFT_EVERY, TOXIC_DRIFT_HOVER, TOXIC_DRIFT_SPEED, WALL_W,
};
use crate::map::Map;
use crate::math::Vec2;
use crate::rng::{chance, range_f32, substream, ChaCha8Rng};

pub struct DriftClouds {
    rng: ChaCha8Rng,
    /// Cloud x positions; empty until the first active tick.
    xs: Vec<f32>,
    /// +1 drifting right, −1 left — one wind for all of them.
    dir: f32,
    next_lay: Option<f32>,
}

impl DriftClouds {
    pub fn new(seed: u64) -> Self {
        Self {
            rng: substream(seed, "toxic-drift"),
            xs: Vec::new(),
            dir: 1.0,
            next_lay: None,
        }
    }

    /// Move the clouds and return where a patch is laid this tick (none while
    /// `active` is false). `divide` is the map's level line (`MapShape::level_divide`).
    pub fn tick(&mut self, map: &Map, divide: i32, active: bool, now: f32, dt: f32) -> Vec<Vec2> {
        if !active {
            return Vec::new();
        }
        let (lo, hi) = (WALL_W as f32, map.mask.w as f32 - WALL_W as f32);
        if self.xs.is_empty() {
            self.dir = if chance(&mut self.rng, 0.5) {
                1.0
            } else {
                -1.0
            };
            self.xs = (0..TOXIC_DRIFT_CLOUDS)
                .map(|_| range_f32(&mut self.rng, lo, hi))
                .collect();
        }
        for x in &mut self.xs {
            *x += self.dir * TOXIC_DRIFT_SPEED * dt;
            if *x > hi {
                *x = lo;
            } else if *x < lo {
                *x = hi;
            }
        }
        let mut next = self.next_lay.unwrap_or(now);
        let mut out = Vec::new();
        while now >= next {
            out.extend(self.xs.iter().filter_map(|&x| {
                lower_ground(map, x as i32, divide).map(|g| Vec2::new(x, g - TOXIC_DRIFT_HOVER))
            }));
            next += TOXIC_DRIFT_EVERY;
        }
        self.next_lay = Some(next);
        out
    }
}

/// The lower level's ground at column `x`: **from the bottom up**, the first air — so
/// a crater in the band or a shaft through it cannot pass for the gap. `None` when that
/// ground (less the hover) is not below the level line: no lower level here.
pub fn lower_ground(map: &Map, x: i32, divide: i32) -> Option<f32> {
    let mut y = map.mask.h as i32 - 1;
    while y >= 0 && map.mask.get(x, y) {
        y -= 1;
    }
    let ground = (y + 1) as f32;
    (ground - TOXIC_DRIFT_HOVER > divide as f32).then_some(ground)
}
