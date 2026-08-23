//! Tombstones (`docs/71-amendments-v3.md` §B8).
//!
//! A grave where you fell, for the rest of the round. No gameplay effect in v1 —
//! it is a marker, and the map remembering where people died is most of the
//! point.
//!
//! Two things about it are deliberate and both are lessons this project already
//! paid for:
//!
//! - **It falls.** A tombstone is a physics body going through the same
//!   sub-stepped resolver players and world items use, so blowing the ground out
//!   from under a grave drops it. The floating-item version of this bug shipped
//!   once already (`docs/32` §4: "if a crate would land on a spot that gets carved
//!   out from under it, it simply keeps falling"), and in a game that is entirely
//!   explosions it fires constantly.
//! - **`TombstoneEffect` has one variant and nothing branches on it.** It is a
//!   seam for revive-here or explode-on-touch later, not a stub layer. A `match`
//!   with one arm that does nothing is worse than no match at all.

use crate::constants::{MAX_TOMBSTONES, TOMBSTONE_H, TOMBSTONE_W};
use crate::map::Map;
use crate::math::Vec2;
use crate::physics::body::Body;
use crate::physics::resolve::integrate;
use crate::player::state::PlayerId;

pub type TombstoneId = u16;

/// What a tombstone does beyond standing there.
///
/// One variant, on purpose (§B8). Revive-here and explode-on-touch are the
/// intended second and third, and adding one is a variant plus its behaviour
/// rather than a schema change.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Default)]
pub enum TombstoneEffect {
    #[default]
    None,
}

#[derive(Clone, Copy, Debug)]
pub struct Tombstone {
    pub id: TombstoneId,
    pub owner: PlayerId,
    pub pos: Vec2,
    pub vel: Vec2,
    pub grounded: bool,
    /// Chosen by the player, meaningless to the server (`docs/50` §1).
    pub skin_id: u16,
    pub effect: TombstoneEffect,
    pub placed_at: f32,
}

#[derive(Default)]
pub struct Tombstones {
    stones: Vec<Tombstone>,
    next_id: TombstoneId,
}

impl Tombstones {
    /// Place a grave. Returns the new stone, and any id evicted to make room.
    ///
    /// The cap is enforced by **freeing a slot** before pushing, not by trimming
    /// afterwards: `while len > MAX` does nothing when `len == MAX`, and the next
    /// push lands on `MAX + 1`. That exact off-by-one shipped in `WorldItems::cull`
    /// and only showed up as "items stop spawning late in a round".
    pub fn place(
        &mut self,
        owner: PlayerId,
        pos: Vec2,
        skin_id: u16,
        now: f32,
    ) -> (Tombstone, Option<TombstoneId>) {
        let evicted = if self.stones.len() >= MAX_TOMBSTONES {
            // Oldest first — the graveyard keeps the recent dead.
            Some(self.stones.remove(0).id)
        } else {
            None
        };
        let id = self.next_id;
        self.next_id = self.next_id.wrapping_add(1);
        let t = Tombstone {
            id,
            owner,
            pos,
            vel: Vec2::ZERO,
            grounded: false,
            skin_id,
            effect: TombstoneEffect::None,
            placed_at: now,
        };
        self.stones.push(t);
        (t, evicted)
    }

    pub fn all(&self) -> &[Tombstone] {
        &self.stones
    }

    pub fn len(&self) -> usize {
        self.stones.len()
    }

    pub fn is_empty(&self) -> bool {
        self.stones.is_empty()
    }

    pub fn clear(&mut self) {
        self.stones.clear();
    }

    /// Gravity and terrain collision, through the **same** resolver players use.
    ///
    /// Idle stones cost nothing, but only while the ground is still there — the
    /// re-probe is what stops a grave hanging over a crater.
    pub fn step(&mut self, map: &Map, dt: f32) {
        for t in self.stones.iter_mut() {
            if t.grounded {
                if supported(map, t) {
                    continue;
                }
                t.grounded = false;
            }
            let mut body = Body::sized(t.pos, TOMBSTONE_W, TOMBSTONE_H);
            body.vel = t.vel;
            integrate(map, &mut body, 1.0, dt);
            t.pos = body.pos;
            t.vel = body.vel;
            t.grounded = body.grounded;
        }
    }

    /// Part of the world hash (§A34): a subsystem hashes **itself**, next to its
    /// own private fields, because a hash written from outside covers what the
    /// author happened to remember.
    pub fn hash_into(&self, h: &mut blake3::Hasher) {
        h.update(&(self.stones.len() as u32).to_le_bytes());
        h.update(&self.next_id.to_le_bytes());
        for t in &self.stones {
            h.update(&t.id.to_le_bytes());
            h.update(&t.owner.to_le_bytes());
            h.update(&t.pos.x.to_le_bytes());
            h.update(&t.pos.y.to_le_bytes());
            h.update(&t.vel.x.to_le_bytes());
            h.update(&t.vel.y.to_le_bytes());
            h.update(&[t.grounded as u8]);
            // `skin_id` is **not** hashed, and that is the same rule
            // `PlayerState.skin_id` follows: the hash covers simulation state, and
            // a cosmetic the server cannot even interpret (`docs/50` §1) is not
            // that. It also keeps the replay format unchanged — replays record
            // what the simulation needs, and a grave's colour is not it.
            h.update(&t.placed_at.to_le_bytes());
        }
    }
}

/// Is there still solid ground under the footprint? Same rule as world items:
/// `.any()` across the base, so a stone on a crater lip keeps standing.
fn supported(map: &Map, t: &Tombstone) -> bool {
    let y = (t.pos.y + TOMBSTONE_H / 2.0).round() as i32;
    let x0 = (t.pos.x - TOMBSTONE_W / 2.0).round() as i32;
    let x1 = (t.pos.x + TOMBSTONE_W / 2.0).round() as i32 - 1;
    (x0..=x1).any(|x| crate::physics::collide::solid_at(map, x, y))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::constants::{MapScale, SIM_DT};
    use crate::map::gen::silhouette::force_borders;
    use crate::map::{CoarseGrid, MapMeta, Mask};

    const W: u32 = 512;
    const H: u32 = 512;

    /// A hand-built floor, not generated terrain.
    ///
    /// §A17 requires real terrain where the failure mode only exists there; a
    /// body falling onto a floor is not that, and a deterministic flat map makes
    /// "fell 5 px" mean something exact.
    fn flat_map() -> Map {
        let mut mask = Mask::new_empty(W, H);
        for y in 300..H as i32 {
            mask.set_run(y, 0, W as i32 - 1);
        }
        force_borders(&mut mask);
        Map::from_parts(mask.clone(), CoarseGrid::build(&mask), meta())
    }

    fn meta() -> MapMeta {
        MapMeta {
            seed: 1,
            requested_seed: 1,
            attempts: 1,
            used_safe_preset: false,
            scale: MapScale::Small,
            theme: 0,
            spawn_points: Vec::new(),
            teleport_pads: Vec::new(),
            surface_points: Vec::new(),
            buried_slots: Vec::new(),
            decorations: Vec::new(),
            wind: 0.0,
            traversable_fraction: 1.0,
            largest_component: Vec::new(),
        }
    }

    /// Drop a stone from `y` and return where it came to rest.
    fn settle(map: &Map, x: f32, y: f32) -> Tombstone {
        let mut ts = Tombstones::default();
        ts.place(0, Vec2::new(x, y), 0, 0.0);
        for _ in 0..600 {
            ts.step(map, SIM_DT);
        }
        ts.all()[0]
    }

    #[test]
    fn a_placed_tombstone_falls_and_comes_to_rest_on_terrain() {
        let map = flat_map();
        let t = settle(&map, 300.0, 100.0);
        assert!(t.grounded, "should have landed, ended at {:?}", t.pos);
        assert!(
            t.pos.y > 100.0,
            "should have fallen from y=100, ended at {:?}",
            t.pos
        );
    }

    #[test]
    fn a_tombstone_whose_ground_is_carved_away_falls() {
        let mut map = flat_map();
        let mut ts = Tombstones::default();
        ts.place(0, Vec2::new(300.0, 100.0), 0, 0.0);
        for _ in 0..600 {
            ts.step(&map, SIM_DT);
        }
        let landed = ts.all()[0].pos.y;
        assert!(ts.all()[0].grounded);

        // Blow out everything under it.
        map.carve_circle(300, (landed + 40.0) as i32, 70);
        for _ in 0..300 {
            ts.step(&map, SIM_DT);
        }
        let after = ts.all()[0].pos.y;
        assert!(
            after > landed + 5.0,
            "a grave over a crater must fall: {landed} -> {after}"
        );
    }

    /// The control for the test above: with the ground intact it must **not**
    /// move. Without this, "it falls when carved" also passes for a stone that
    /// never stops falling.
    #[test]
    fn a_tombstone_on_intact_ground_does_not_drift() {
        let map = flat_map();
        let mut ts = Tombstones::default();
        ts.place(0, Vec2::new(300.0, 100.0), 0, 0.0);
        for _ in 0..600 {
            ts.step(&map, SIM_DT);
        }
        let settled = ts.all()[0].pos;
        for _ in 0..600 {
            ts.step(&map, SIM_DT);
        }
        let after = ts.all()[0].pos;
        assert!(
            (after.y - settled.y).abs() < 0.001 && (after.x - settled.x).abs() < 0.001,
            "an undisturbed grave must not drift: {settled:?} -> {after:?}"
        );
    }

    #[test]
    fn the_cap_evicts_the_oldest_and_never_exceeds_it() {
        let mut ts = Tombstones::default();
        let mut evictions = Vec::new();
        for i in 0..(MAX_TOMBSTONES + 5) {
            let (_, gone) = ts.place(0, Vec2::new(i as f32, 0.0), 0, i as f32);
            if let Some(id) = gone {
                evictions.push(id);
            }
            assert!(
                ts.len() <= MAX_TOMBSTONES,
                "cap exceeded at {i}: {}",
                ts.len()
            );
        }
        assert_eq!(ts.len(), MAX_TOMBSTONES);
        assert_eq!(evictions.len(), 5, "five over the cap, five evicted");
        // Oldest first: the evicted ids are 0..5, and the survivors start at 5.
        assert_eq!(evictions, vec![0, 1, 2, 3, 4]);
        assert_eq!(ts.all()[0].id, 5);
    }

    #[test]
    fn the_hash_covers_position_so_a_falling_grave_changes_it() {
        let map = flat_map();
        let mut ts = Tombstones::default();
        ts.place(0, Vec2::new(300.0, 100.0), 0, 0.0);
        let mut a = blake3::Hasher::new();
        ts.hash_into(&mut a);
        for _ in 0..60 {
            ts.step(&map, SIM_DT);
        }
        let mut b = blake3::Hasher::new();
        ts.hash_into(&mut b);
        assert_ne!(
            a.finalize(),
            b.finalize(),
            "a grave that moved must change the world hash (§A34)"
        );
    }
}
