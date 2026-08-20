//! Items lying in the world: physics, pickup, TTL and eviction.
//!
//! See `docs/30-items-inventory.md` §5 and `docs/32-item-spawning.md` §6.

use crate::constants::{
    CRATE_DRAG, CRATE_H, CRATE_W, MAX_WORLD_ITEMS, PICKUP_RADIUS, WORLD_ITEM_TTL,
};
use crate::items::inventory::{AddResult, Inventory};
use crate::items::registry::ItemId;
use crate::map::Map;
use crate::math::Vec2;
use crate::physics::body::Body;
use crate::physics::resolve::integrate;

pub type WorldItemId = u32;
pub type PlayerId = u8;

/// Loose items use a small square box; crates use `CRATE_W × CRATE_H`.
pub const ITEM_SIZE: f32 = 16.0;

/// Death drops cannot be picked up for this long, so the killer cannot hoover the
/// corpse and a self-killed player does not get their own loot back on respawn.
pub const DEATH_DROP_LOCK: f32 = 1.0;

#[derive(Copy, Clone, Debug, PartialEq, Eq)]
pub enum SpawnSource {
    Initial,
    Periodic,
    Crate,
    Buried,
    Death,
}

#[derive(Clone, Debug)]
pub struct WorldItem {
    pub id: WorldItemId,
    pub item: ItemId,
    pub count: u8,
    pub pos: Vec2,
    pub vel: Vec2,
    pub grounded: bool,
    pub spawned_at: f32,
    pub pickup_locked_until: f32,
    pub source: SpawnSource,
}

impl WorldItem {
    pub fn is_crate(&self) -> bool {
        self.source == SpawnSource::Crate
    }

    fn size(&self) -> (f32, f32) {
        if self.is_crate() {
            (CRATE_W, CRATE_H)
        } else {
            (ITEM_SIZE, ITEM_SIZE)
        }
    }
}

#[derive(Clone, Debug, Default)]
pub struct WorldItems {
    items: Vec<WorldItem>,
    next_id: WorldItemId,
}

impl WorldItems {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn spawn(
        &mut self,
        item: ItemId,
        count: u8,
        pos: Vec2,
        vel: Vec2,
        source: SpawnSource,
        now: f32,
    ) -> WorldItemId {
        // Ids are never reused: a stale client reference to a recycled id would
        // pick up or despawn the wrong thing.
        let id = self.next_id;
        self.next_id += 1;
        self.items.push(WorldItem {
            id,
            item,
            count,
            pos,
            vel,
            grounded: false,
            spawned_at: now,
            pickup_locked_until: if source == SpawnSource::Death {
                now + DEATH_DROP_LOCK
            } else {
                0.0
            },
            source,
        });
        id
    }

    /// Gravity and terrain collision, through the **same** sub-stepped resolver
    /// players use. A second collision path would eventually let an item fall
    /// through terrain a player cannot walk through.
    pub fn step(&mut self, map: &Map, dt: f32) {
        for it in self.items.iter_mut() {
            // Idle items cost nothing — but only while the ground is still there.
            //
            // Without the re-probe an item whose support is blown away hangs over
            // the crater for the rest of the round, which `docs/32` §4 forbids in
            // as many words: "If a crate would land on a spot that gets carved out
            // from under it, it simply keeps falling." In a game that is entirely
            // explosions, and where items sit on the ground, this fires constantly.
            if it.grounded {
                if Self::supported(map, it) {
                    continue;
                }
                it.grounded = false;
            }
            let (w, h) = it.size();
            let mut body = Body::sized(it.pos, w, h);
            body.vel = it.vel;
            if it.is_crate() {
                // Light horizontal drag, so a crate drifts down rather than
                // keeping its lateral speed forever.
                body.vel.x *= 1.0 - CRATE_DRAG;
            }
            integrate(map, &mut body, 1.0, dt);
            it.pos = body.pos;
            it.vel = body.vel;
            it.grounded = body.grounded;
        }
    }

    /// Is there still solid ground directly under this item's footprint?
    ///
    /// One row below the AABB's bottom edge, across its full width, so an item on
    /// the lip of a new crater falls as soon as its own support goes — not only
    /// when the pixel under its centre does.
    fn supported(map: &Map, it: &WorldItem) -> bool {
        let (w, h) = it.size();
        let y = (it.pos.y + h / 2.0).round() as i32;
        let x0 = (it.pos.x - w / 2.0).round() as i32;
        let x1 = (it.pos.x + w / 2.0).round() as i32 - 1;
        (x0..=x1).any(|x| crate::physics::collide::solid_at(map, x, y))
    }

    /// TTL and `MAX_WORLD_ITEMS` eviction. Returns the despawned ids.
    pub fn cull(&mut self, now: f32) -> Vec<WorldItemId> {
        let mut gone = Vec::new();

        // Crates are exempt from TTL: they are the reward for contesting a drop,
        // and having one time out mid-fight would be maddening.
        self.items.retain(|it| {
            if !it.is_crate() && now - it.spawned_at >= WORLD_ITEM_TTL {
                gone.push(it.id);
                false
            } else {
                true
            }
        });

        while self.items.len() > MAX_WORLD_ITEMS {
            match self.evict_oldest_non_crate() {
                Some(id) => gone.push(id),
                // Everything left is a crate; the cap yields rather than evicting one.
                None => break,
            }
        }

        gone
    }

    /// Free a slot so a caller can spawn without exceeding the cap.
    ///
    /// `cull` enforces `len <= MAX`, which is not the same thing: at exactly the
    /// cap it has nothing to do, and a spawn straight after it lands on MAX + 1.
    /// Callers about to add an item ask for room explicitly.
    pub fn make_room(&mut self) -> Option<WorldItemId> {
        if self.items.len() < MAX_WORLD_ITEMS {
            return None;
        }
        self.evict_oldest_non_crate()
    }

    /// Oldest non-crate first, never a crate. Ties break on id, so eviction is
    /// deterministic and a replay evicts the same item.
    fn evict_oldest_non_crate(&mut self) -> Option<WorldItemId> {
        let i = self
            .items
            .iter()
            .enumerate()
            .filter(|(_, it)| !it.is_crate())
            .min_by(|a, b| {
                a.1.spawned_at
                    .partial_cmp(&b.1.spawned_at)
                    .unwrap_or(std::cmp::Ordering::Equal)
                    .then(a.1.id.cmp(&b.1.id))
            })
            .map(|(i, _)| i)?;
        Some(self.items.remove(i).id)
    }

    /// Resolve pickups.
    ///
    /// **Players must be passed in ascending id order**, and the signature is shaped
    /// to make the caller think about it: two players contacting the same item on
    /// the same tick must always resolve to the same winner, in a live round and in
    /// a replay (`docs/41-server-loop-rooms.md` §2).
    pub fn resolve_pickups(
        &mut self,
        players: &mut [(PlayerId, Vec2, &mut Inventory)],
        now: f32,
    ) -> Vec<(WorldItemId, PlayerId)> {
        debug_assert!(
            players.windows(2).all(|w| w[0].0 < w[1].0),
            "players must be in ascending id order or pickups are nondeterministic"
        );

        let mut taken = Vec::new();
        let r2 = PICKUP_RADIUS * PICKUP_RADIUS;

        for (pid, ppos, inv) in players.iter_mut() {
            for it in self.items.iter_mut() {
                if it.count == 0 || now < it.pickup_locked_until {
                    continue;
                }
                let d = it.pos - *ppos;
                if d.x * d.x + d.y * d.y > r2 {
                    continue;
                }
                match inv.add(it.item, it.count) {
                    AddResult::Added => {
                        it.count = 0;
                        taken.push((it.id, *pid));
                    }
                    // The remainder stays on the ground rather than vanishing.
                    AddResult::Partial(left) => {
                        it.count = left;
                        taken.push((it.id, *pid));
                    }
                    AddResult::Full => {}
                }
            }
        }

        self.items.retain(|it| it.count > 0);
        taken
    }

    pub fn iter(&self) -> impl Iterator<Item = &WorldItem> {
        self.items.iter()
    }

    pub fn len(&self) -> usize {
        self.items.len()
    }

    pub fn is_empty(&self) -> bool {
        self.items.is_empty()
    }

    pub fn get(&self, id: WorldItemId) -> Option<&WorldItem> {
        self.items.iter().find(|it| it.id == id)
    }

    pub fn remove(&mut self, id: WorldItemId) -> Option<WorldItem> {
        let i = self.items.iter().position(|it| it.id == id)?;
        Some(self.items.remove(i))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::constants::MapScale;
    use crate::items::registry::{BAZOOKA, FLASHLIGHT, MEDKIT};
    use crate::map::gen::silhouette::force_borders;
    use crate::map::{CoarseGrid, Map, MapMeta, Mask};

    const W: u32 = 512;
    const H: u32 = 512;

    fn flat_map(floor_y: i32) -> Map {
        let mut mask = Mask::new_empty(W, H);
        for y in floor_y..H as i32 {
            mask.set_run(y, 0, W as i32 - 1);
        }
        force_borders(&mut mask);
        let coarse = CoarseGrid::build(&mask);
        Map::from_parts(mask, coarse, meta())
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
            surface_points: Vec::new(),
            buried_slots: Vec::new(),
            decorations: Vec::new(),
            wind: 0.0,
            traversable_fraction: 1.0,
            largest_component: Vec::new(),
        }
    }

    fn drop_until_rest(w: &mut WorldItems, map: &Map) {
        for _ in 0..600 {
            w.step(map, crate::constants::SIM_DT);
        }
    }

    #[test]
    fn an_item_falls_and_comes_to_rest_on_the_floor() {
        let map = flat_map(400);
        let mut w = WorldItems::new();
        let id = w.spawn(
            MEDKIT,
            1,
            Vec2::new(256.0, 100.0),
            Vec2::ZERO,
            SpawnSource::Initial,
            0.0,
        );
        drop_until_rest(&mut w, &map);
        let it = w.get(id).expect("still there");
        assert!(it.grounded, "item never landed");
        assert!(
            (it.pos.y - (400.0 - ITEM_SIZE / 2.0)).abs() < 2.0,
            "rests at {} not on the floor",
            it.pos.y
        );
    }

    #[test]
    fn a_grounded_item_is_not_stepped_further() {
        let map = flat_map(400);
        let mut w = WorldItems::new();
        let id = w.spawn(
            MEDKIT,
            1,
            Vec2::new(256.0, 100.0),
            Vec2::ZERO,
            SpawnSource::Initial,
            0.0,
        );
        drop_until_rest(&mut w, &map);
        let at_rest = w.get(id).expect("there").pos;
        for _ in 0..100 {
            w.step(&map, crate::constants::SIM_DT);
        }
        // Bit-identical: idle items must cost nothing and must not creep.
        assert_eq!(w.get(id).expect("there").pos, at_rest);
    }

    #[test]
    fn an_item_dropped_over_a_hole_falls_into_it() {
        let mut map = flat_map(400);
        map.carve_circle(256, 400, 60);
        let mut w = WorldItems::new();
        let id = w.spawn(
            MEDKIT,
            1,
            Vec2::new(256.0, 100.0),
            Vec2::ZERO,
            SpawnSource::Initial,
            0.0,
        );
        drop_until_rest(&mut w, &map);
        let it = w.get(id).expect("there");
        assert!(
            it.pos.y > 420.0,
            "settled at {} — did not fall into the hole",
            it.pos.y
        );
    }

    #[test]
    fn an_item_never_passes_through_a_one_pixel_floor() {
        // The sub-step guarantee, re-tested at the item layer.
        let mut mask = Mask::new_empty(W, H);
        mask.set_run(400, 0, W as i32 - 1);
        force_borders(&mut mask);
        let coarse = CoarseGrid::build(&mask);
        let map = Map::from_parts(mask, coarse, meta());

        let mut w = WorldItems::new();
        let id = w.spawn(
            MEDKIT,
            1,
            Vec2::new(256.0, 50.0),
            Vec2::new(0.0, crate::constants::MAX_FALL_SPEED * 10.0),
            SpawnSource::Initial,
            0.0,
        );
        for _ in 0..300 {
            w.step(&map, crate::constants::SIM_DT);
        }
        assert!(
            w.get(id).expect("there").pos.y < 400.0,
            "fell through a 1 px floor"
        );
    }

    #[test]
    fn pickup_happens_inside_the_radius_and_not_outside_it() {
        let map = flat_map(400);
        let mut w = WorldItems::new();
        let pos = Vec2::new(256.0, 380.0);
        w.spawn(MEDKIT, 1, pos, Vec2::ZERO, SpawnSource::Initial, 0.0);
        let _ = &map;

        let mut inv = Inventory::new();
        let far = Vec2::new(pos.x + PICKUP_RADIUS + 1.0, pos.y);
        let mut players = [(0u8, far, &mut inv)];
        assert!(w.resolve_pickups(&mut players, 1.0).is_empty());

        let mut inv2 = Inventory::new();
        let near = Vec2::new(pos.x + PICKUP_RADIUS - 1.0, pos.y);
        let mut players = [(0u8, near, &mut inv2)];
        assert_eq!(w.resolve_pickups(&mut players, 1.0).len(), 1);
        assert_eq!(inv2.count_of(MEDKIT), 1);
    }

    #[test]
    fn the_lower_player_id_always_wins_a_tie() {
        // 100 runs, because this is the class of bug that only appears under load
        // and must be identical in a replay.
        for _ in 0..100 {
            let mut w = WorldItems::new();
            let pos = Vec2::new(256.0, 380.0);
            w.spawn(BAZOOKA, 1, pos, Vec2::ZERO, SpawnSource::Initial, 0.0);
            let mut a = Inventory::new();
            let mut b = Inventory::new();
            let mut players = [
                (2u8, Vec2::new(pos.x - 5.0, pos.y), &mut a),
                (7u8, Vec2::new(pos.x + 5.0, pos.y), &mut b),
            ];
            let taken = w.resolve_pickups(&mut players, 1.0);
            assert_eq!(taken.len(), 1);
            assert_eq!(taken[0].1, 2, "the lower id must win");
            assert_eq!(a.count_of(BAZOOKA), 1);
            assert_eq!(b.count_of(BAZOOKA), 0);
        }
    }

    #[test]
    fn a_full_inventory_leaves_the_item_on_the_ground() {
        let mut w = WorldItems::new();
        let pos = Vec2::new(256.0, 380.0);
        w.spawn(MEDKIT, 1, pos, Vec2::ZERO, SpawnSource::Initial, 0.0);
        let mut inv = Inventory::new();
        for _ in 0..crate::constants::INVENTORY_SLOTS {
            inv.add(FLASHLIGHT, 1);
        }
        let mut players = [(0u8, pos, &mut inv)];
        assert!(w.resolve_pickups(&mut players, 1.0).is_empty());
        assert_eq!(w.len(), 1, "the item must stay in the world");
    }

    #[test]
    fn a_partial_pickup_reduces_the_stack_and_leaves_the_rest() {
        let mut w = WorldItems::new();
        let pos = Vec2::new(256.0, 380.0);
        // Grenades cap at 3 per slot; 7 free slots hold 21, so ask for more.
        w.spawn(
            crate::items::registry::GRENADE,
            9,
            pos,
            Vec2::ZERO,
            SpawnSource::Initial,
            0.0,
        );
        let mut inv = Inventory::new();
        for _ in 0..7 {
            inv.add(FLASHLIGHT, 1);
        }
        let mut players = [(0u8, pos, &mut inv)];
        w.resolve_pickups(&mut players, 1.0);
        assert_eq!(inv.count_of(crate::items::registry::GRENADE), 3);
        assert_eq!(w.len(), 1);
        assert_eq!(w.iter().next().expect("there").count, 6, "the rest stays");
    }

    #[test]
    fn a_death_drop_cannot_be_picked_up_immediately() {
        let mut w = WorldItems::new();
        let pos = Vec2::new(256.0, 380.0);
        w.spawn(MEDKIT, 1, pos, Vec2::ZERO, SpawnSource::Death, 10.0);
        let mut inv = Inventory::new();

        let mut players = [(0u8, pos, &mut inv)];
        assert!(w.resolve_pickups(&mut players, 10.5).is_empty(), "locked");
        let mut players = [(0u8, pos, &mut inv)];
        assert_eq!(w.resolve_pickups(&mut players, 11.1).len(), 1, "unlocked");
    }

    #[test]
    fn ttl_despawns_at_the_deadline_and_not_before() {
        let mut w = WorldItems::new();
        w.spawn(MEDKIT, 1, Vec2::ZERO, Vec2::ZERO, SpawnSource::Initial, 0.0);
        assert!(w.cull(WORLD_ITEM_TTL - 1.0).is_empty());
        assert_eq!(w.cull(WORLD_ITEM_TTL).len(), 1);
        assert!(w.is_empty());
    }

    #[test]
    fn a_crate_is_never_despawned_by_ttl() {
        let mut w = WorldItems::new();
        w.spawn(MEDKIT, 1, Vec2::ZERO, Vec2::ZERO, SpawnSource::Crate, 0.0);
        assert!(w.cull(WORLD_ITEM_TTL * 2.0).is_empty());
        assert_eq!(w.len(), 1);
    }

    #[test]
    fn eviction_takes_the_oldest_non_crate_and_never_a_crate() {
        let mut w = WorldItems::new();
        let crate_id = w.spawn(MEDKIT, 1, Vec2::ZERO, Vec2::ZERO, SpawnSource::Crate, 0.0);
        let oldest = w.spawn(MEDKIT, 1, Vec2::ZERO, Vec2::ZERO, SpawnSource::Initial, 1.0);
        for i in 0..MAX_WORLD_ITEMS {
            w.spawn(
                MEDKIT,
                1,
                Vec2::ZERO,
                Vec2::ZERO,
                SpawnSource::Initial,
                2.0 + i as f32,
            );
        }
        let gone = w.cull(3.0);
        assert!(gone.contains(&oldest), "the oldest non-crate must go first");
        assert!(!gone.contains(&crate_id), "a crate must never be evicted");
        assert!(w.len() <= MAX_WORLD_ITEMS);
        assert!(w.get(crate_id).is_some());
    }

    #[test]
    fn remove_is_idempotent_and_ids_are_never_reused() {
        let mut w = WorldItems::new();
        let a = w.spawn(MEDKIT, 1, Vec2::ZERO, Vec2::ZERO, SpawnSource::Initial, 0.0);
        assert!(w.remove(a).is_some());
        assert!(w.remove(a).is_none());
        let b = w.spawn(MEDKIT, 1, Vec2::ZERO, Vec2::ZERO, SpawnSource::Initial, 0.0);
        assert_ne!(a, b, "ids must never be reused");
    }

    /// `docs/32` §4: a crate whose landing spot is carved out simply keeps falling.
    #[test]
    fn an_item_whose_ground_is_blown_away_falls_again() {
        let mut map = flat_map(400);
        let mut w = WorldItems::new();
        let id = w.spawn(
            MEDKIT,
            1,
            Vec2::new(256.0, 100.0),
            Vec2::ZERO,
            SpawnSource::Initial,
            0.0,
        );
        for _ in 0..600 {
            w.step(&map, crate::constants::SIM_DT);
        }
        let resting = w.get(id).expect("there").pos.y;
        assert!(w.get(id).expect("there").grounded);

        // Blow the ground out from under it.
        map.carve_circle(256, 400, 60);
        for _ in 0..600 {
            w.step(&map, crate::constants::SIM_DT);
        }
        let after = w.get(id).expect("there");
        assert!(
            after.pos.y > resting + 20.0,
            "the item hung over the crater at y {} (was {resting})",
            after.pos.y
        );
        assert!(after.grounded, "it should come to rest on the crater floor");
    }

    #[test]
    fn a_crate_on_a_carved_ledge_falls_too() {
        // Same rule for the 24x24 body, and asserted on the footprint rather than
        // the centre: a crate on the lip of a crater must go when its support does.
        let mut map = flat_map(400);
        let mut w = WorldItems::new();
        let id = w.spawn(
            MEDKIT,
            1,
            Vec2::new(256.0, 300.0),
            Vec2::ZERO,
            SpawnSource::Crate,
            0.0,
        );
        for _ in 0..600 {
            w.step(&map, crate::constants::SIM_DT);
        }
        let resting = w.get(id).expect("there").pos.y;
        map.carve_circle(256, 405, 70);
        for _ in 0..600 {
            w.step(&map, crate::constants::SIM_DT);
        }
        assert!(
            w.get(id).expect("there").pos.y > resting + 20.0,
            "the crate did not fall into the new hole"
        );
    }

    #[test]
    fn an_item_on_untouched_ground_still_costs_nothing() {
        // The re-probe must not reintroduce per-tick work for the common case.
        let map = flat_map(400);
        let mut w = WorldItems::new();
        let id = w.spawn(
            MEDKIT,
            1,
            Vec2::new(256.0, 100.0),
            Vec2::ZERO,
            SpawnSource::Initial,
            0.0,
        );
        for _ in 0..600 {
            w.step(&map, crate::constants::SIM_DT);
        }
        let at_rest = w.get(id).expect("there").pos;
        for _ in 0..600 {
            w.step(&map, crate::constants::SIM_DT);
        }
        assert_eq!(w.get(id).expect("there").pos, at_rest);
    }
}
