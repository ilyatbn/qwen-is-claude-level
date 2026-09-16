//! Smoke clouds (`docs/71-amendments-v3.md` §B7).
//!
//! The only weapon in the game with no damage at all. It is pure information
//! denial, and it stacks with night the way fog does (`docs/14` §3).
//!
//! **Deliberately not a `BurnField` with `dps: 0`.** `BurnField` is a *damaging*
//! ground zone: its tick loop walks every player against every patch, and its
//! whole reason to exist is applying damage. A smoke cloud is consulted by the
//! field-of-view formula and never by the damage path, so folding it in would
//! mean a damage loop iterating clouds forever to apply nothing, and a
//! `BurnKind::Smoke` that lies about what the container is. Same shape, different
//! question — so a separate field, and no damage code to get wrong.

use crate::constants::FOV_SMOKE_MULT;
use crate::math::Vec2;

#[derive(Debug, Clone, Copy)]
pub struct SmokeCloud {
    pub id: u32,
    pub pos: Vec2,
    pub radius: f32,
    pub until: f32,
}

#[derive(Debug, Default)]
pub struct SmokeField {
    clouds: Vec<SmokeCloud>,
}

impl SmokeField {
    pub fn clouds(&self) -> &[SmokeCloud] {
        &self.clouds
    }

    pub fn len(&self) -> usize {
        self.clouds.len()
    }

    pub fn is_empty(&self) -> bool {
        self.clouds.is_empty()
    }

    /// The id comes from the caller so smoke and burn zones share **one** hazard
    /// id space. Two counters would let a cloud and a fire claim the same id, and
    /// the client would stop drawing the wrong one.
    pub fn add(&mut self, id: u32, pos: Vec2, radius: f32, duration: f32, now: f32) {
        self.clouds.push(SmokeCloud {
            id,
            pos,
            radius,
            until: now + duration,
        });
    }

    /// Drop the clouds that have dispersed. Returns their ids so the client can
    /// stop drawing them — a cloud that vanishes server-side and lingers on screen
    /// is worse than one that never appeared, because you will trust it.
    pub fn expire(&mut self, now: f32) -> Vec<u32> {
        let gone: Vec<u32> = self
            .clouds
            .iter()
            .filter(|c| now >= c.until)
            .map(|c| c.id)
            .collect();
        self.clouds.retain(|c| now < c.until);
        gone
    }

    /// The vision multiplier for someone standing at `pos`.
    ///
    /// Multiplicative across overlapping clouds, like every other FoV modifier
    /// (`docs/14` §3) — two smokes are worse than one, and it composes with fog
    /// and night without a special case.
    pub fn multiplier_at(&self, pos: Vec2, now: f32) -> f32 {
        let mut m = 1.0;
        for c in &self.clouds {
            if now < c.until && (pos - c.pos).len() <= c.radius {
                m *= FOV_SMOKE_MULT;
            }
        }
        m
    }

    /// Hash the clouds (§A34). Smoke is state: a cloud that should have dispersed
    /// changes what a replayed round can see.
    pub fn hash_into(&self, h: &mut blake3::Hasher) {
        h.update(&(self.clouds.len() as u32).to_le_bytes());
        for c in &self.clouds {
            h.update(&c.id.to_le_bytes());
            h.update(&c.pos.x.to_le_bytes());
            h.update(&c.pos.y.to_le_bytes());
            h.update(&c.radius.to_le_bytes());
            h.update(&c.until.to_le_bytes());
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::constants::{SMOKE_DURATION, SMOKE_RADIUS};

    #[test]
    fn a_cloud_dims_vision_inside_it_and_not_outside() {
        let mut f = SmokeField::default();
        f.add(
            0,
            Vec2::new(100.0, 100.0),
            SMOKE_RADIUS,
            SMOKE_DURATION,
            0.0,
        );

        let inside = f.multiplier_at(Vec2::new(100.0, 100.0), 1.0);
        let edge = f.multiplier_at(Vec2::new(100.0 + SMOKE_RADIUS, 100.0), 1.0);
        let outside = f.multiplier_at(Vec2::new(100.0 + SMOKE_RADIUS + 1.0, 100.0), 1.0);

        assert!((inside - FOV_SMOKE_MULT).abs() < 1e-6, "{inside}");
        assert!(
            (edge - FOV_SMOKE_MULT).abs() < 1e-6,
            "edge should count: {edge}"
        );
        assert!((outside - 1.0).abs() < 1e-6, "{outside}");
    }

    #[test]
    fn overlapping_clouds_stack_multiplicatively() {
        let mut f = SmokeField::default();
        f.add(
            0,
            Vec2::new(100.0, 100.0),
            SMOKE_RADIUS,
            SMOKE_DURATION,
            0.0,
        );
        f.add(
            1,
            Vec2::new(110.0, 100.0),
            SMOKE_RADIUS,
            SMOKE_DURATION,
            0.0,
        );
        let m = f.multiplier_at(Vec2::new(105.0, 100.0), 1.0);
        assert!(
            (m - FOV_SMOKE_MULT * FOV_SMOKE_MULT).abs() < 1e-6,
            "two clouds should be worse than one: {m}"
        );
    }

    #[test]
    fn a_cloud_disperses_and_reports_itself_gone() {
        let mut f = SmokeField::default();
        let id = 7;
        f.add(id, Vec2::new(0.0, 0.0), SMOKE_RADIUS, SMOKE_DURATION, 0.0);

        assert!(f.expire(SMOKE_DURATION - 0.01).is_empty(), "still burning");
        assert!((f.multiplier_at(Vec2::ZERO, SMOKE_DURATION - 0.01) - FOV_SMOKE_MULT).abs() < 1e-6);

        assert_eq!(f.expire(SMOKE_DURATION), vec![id]);
        assert!(f.is_empty());
        assert!((f.multiplier_at(Vec2::ZERO, SMOKE_DURATION) - 1.0).abs() < 1e-6);
    }
}
