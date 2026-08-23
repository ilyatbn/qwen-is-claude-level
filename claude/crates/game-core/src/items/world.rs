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

/// What a pickup may land in: the inventory, or one of §C9's two counters.
///
/// A struct rather than a tuple because it grew from three fields to five and a
/// positional destructure of five is where the next reader puts `heals` where
/// `batteries` goes.
pub struct PickupTarget<'a> {
    pub id: PlayerId,
    pub pos: Vec2,
    pub inventory: &'a mut Inventory,
    pub heals: &'a mut u8,
    pub batteries: &'a mut u8,
}

/// Which counter an item belongs to, if any.
fn counter_for<'a>(
    item: ItemId,
    heals: &'a mut &mut u8,
    batteries: &'a mut &mut u8,
) -> Option<&'a mut u8> {
    match item {
        crate::items::registry::MEDKIT => Some(heals),
        crate::items::registry::BATTERY_PACK => Some(batteries),
        _ => None,
    }
}

/// Increment a counter if it is below its cap. False leaves the item behind.
fn bump(item: ItemId, counter: &mut u8) -> bool {
    let cap = match item {
        crate::items::registry::MEDKIT => crate::constants::MAX_HEALS,
        _ => crate::constants::MAX_BATTERIES,
    };
    if *counter >= cap {
        return false;
    }
    *counter += 1;
    true
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
    ///
    /// Returns the items that **landed on this step**. The caller needs that to
    /// tell anyone watching where the thing came to rest: a crate falls for
    /// several seconds and the landing tick is the only one whose position is
    /// final, so a periodic broadcast that happens to miss it leaves every
    /// observer holding a position the crate has already left. That is exactly
    /// how a crate ends up drawn in mid-air (§C7).
    pub fn step(&mut self, map: &Map, dt: f32) -> Vec<WorldItemId> {
        let mut landed = Vec::new();
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
            // Anything reaching here was airborne at the top of the loop — the
            // grounded-and-still-supported case `continue`d — so `body.grounded`
            // is precisely "it landed on this step".
            it.grounded = body.grounded;
            if it.grounded {
                landed.push(it.id);
            }
        }
        landed
    }

    /// Items still falling. They are the only ones whose position changes, so
    /// they are the only ones worth telling anyone about.
    pub fn airborne(&self) -> impl Iterator<Item = &WorldItem> {
        self.items.iter().filter(|it| !it.grounded)
    }

    /// Is there still solid ground directly under this item's footprint?
    ///
    /// One row below the AABB's bottom edge, across its full width, and `.any()`
    /// — so an item keeps standing while **any** part of its base is supported.
    /// That is strictly more permissive than probing the centre alone: an item on
    /// the lip of a crater stays put, and only one whose support is entirely gone
    /// falls. That is the correct behaviour for a box resting on a ledge, and it
    /// is what the tests pin (support fully removed -> falls 70.2 px; partial
    /// support -> stays).
    ///
    /// The comment here previously claimed the opposite — that the footprint probe
    /// made a lip-resting item fall. It does not, and could not.
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
        players: &mut [PickupTarget<'_>],
        now: f32,
    ) -> Vec<(WorldItemId, PlayerId)> {
        debug_assert!(
            players.windows(2).all(|w| w[0].id < w[1].id),
            "players must be in ascending id order or pickups are nondeterministic"
        );

        let mut taken = Vec::new();
        let r2 = PICKUP_RADIUS * PICKUP_RADIUS;

        for t in players.iter_mut() {
            let PickupTarget {
                id: pid,
                pos: ppos,
                inventory: inv,
                heals,
                batteries,
            } = t;
            for it in self.items.iter_mut() {
                if it.count == 0 || now < it.pickup_locked_until {
                    continue;
                }
                let d = it.pos - *ppos;
                if d.x * d.x + d.y * d.y > r2 {
                    continue;
                }

                // §C9: heals and battery packs are **counters**, not inventory.
                // Routed here rather than in `Inventory::add` because they never
                // reach a slot at all — a guard inside `add` would be a guard on
                // the wrong container.
                //
                // At max the pickup is **refused and the item stays on the
                // ground**, which is the same rule a full inventory gets
                // (`docs/30` §2) and is what makes birds worth shooting when you
                // are already topped up (§C9's own note).
                if let Some(counter) = counter_for(it.item, heals, batteries) {
                    let mut moved = 0u8;
                    while it.count > moved && bump(it.item, counter) {
                        moved += 1;
                    }
                    if moved > 0 {
                        it.count -= moved;
                        taken.push((it.id, *pid));
                    }
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

    /// A one-player pickup target with its own counters, so the fixtures below
    /// read the same as they did before `PickupTarget` grew §C9's two fields.
    pub(super) fn target<'a>(
        id: PlayerId,
        pos: Vec2,
        inv: &'a mut Inventory,
        heals: &'a mut u8,
        batteries: &'a mut u8,
    ) -> PickupTarget<'a> {
        PickupTarget {
            id,
            pos,
            inventory: inv,
            heals,
            batteries,
        }
    }
    use super::*;
    use crate::constants::MapScale;
    use crate::items::registry::{BAZOOKA, FLASHLIGHT, MEDKIT, SHIELD_GENERATOR};
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
            teleport_pads: Vec::new(),
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
        // Not a medkit: since §C9 those go to a counter and never touch an
        // inventory, so `count_of` below would read 0 for a pickup that worked.
        w.spawn(BAZOOKA, 1, pos, Vec2::ZERO, SpawnSource::Initial, 0.0);
        let _ = &map;

        let mut inv = Inventory::new();
        let far = Vec2::new(pos.x + PICKUP_RADIUS + 1.0, pos.y);
        let (mut h, mut bt) = (0u8, 0u8);
        let mut players = [target(0, far, &mut inv, &mut h, &mut bt)];
        assert!(w.resolve_pickups(&mut players, 1.0).is_empty());

        let mut inv2 = Inventory::new();
        let near = Vec2::new(pos.x + PICKUP_RADIUS - 1.0, pos.y);
        let (mut h, mut bt) = (0u8, 0u8);
        let mut players = [target(0, near, &mut inv2, &mut h, &mut bt)];
        assert_eq!(w.resolve_pickups(&mut players, 1.0).len(), 1);
        assert_eq!(inv2.count_of(BAZOOKA), 1);
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
            let (mut ha, mut ba) = (0u8, 0u8);
            let (mut hb, mut bb) = (0u8, 0u8);
            let mut players = [
                target(2, Vec2::new(pos.x - 5.0, pos.y), &mut a, &mut ha, &mut ba),
                target(7, Vec2::new(pos.x + 5.0, pos.y), &mut b, &mut hb, &mut bb),
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
        // **Not a medkit.** Since §C9 a medkit goes to a counter and never sees a
        // slot, so a full inventory has nothing to say about it — this test would
        // have gone on passing while testing the opposite rule.
        w.spawn(BAZOOKA, 1, pos, Vec2::ZERO, SpawnSource::Initial, 0.0);
        let mut inv = Inventory::new();
        for _ in 0..crate::constants::INVENTORY_SLOTS {
            inv.add(FLASHLIGHT, 1);
        }
        let (mut h, mut bt) = (0u8, 0u8);
        let mut players = [target(0, pos, &mut inv, &mut h, &mut bt)];
        assert!(w.resolve_pickups(&mut players, 1.0).is_empty());
        assert_eq!(w.len(), 1, "the item must stay in the world");
    }

    /// §C24, at the layer the player meets: a weapon you already carry **at full
    /// ammo** is refused and stays on the ground.
    ///
    /// `inventory.rs` asserts this as an `AddResult::Full`, which is the enum and
    /// not the outcome. The case that matters here is the new one — a full stack
    /// with **seven free slots** — because under the old rule it would have taken
    /// one of them, and under the new rule the world item must survive. The
    /// existing full-inventory test cannot cover it: there, every slot is
    /// occupied, so a build with no one-slot rule at all passes.
    ///
    /// The control is the second half: a *different* weapon on the same ground,
    /// with the same seven free slots, is taken. Without it "the item stayed"
    /// also passes for a player who can no longer pick anything up.
    #[test]
    fn a_held_weapon_at_full_ammo_is_refused_and_stays_on_the_ground() {
        let mut w = WorldItems::new();
        let pos = Vec2::new(256.0, 380.0);
        let full = crate::items::registry::max_stack(BAZOOKA);
        w.spawn(BAZOOKA, full, pos, Vec2::ZERO, SpawnSource::Initial, 0.0);

        let mut inv = Inventory::new();
        inv.add(BAZOOKA, full);
        assert_eq!(
            inv.count_of(BAZOOKA),
            u32::from(full),
            "the fixture is not full"
        );
        assert!(
            inv.iter().count() < crate::constants::INVENTORY_SLOTS,
            "with no free slots this passes for the old rule too"
        );

        let (mut h, mut bt) = (0u8, 0u8);
        let mut players = [target(0, pos, &mut inv, &mut h, &mut bt)];
        assert!(
            w.resolve_pickups(&mut players, 1.0).is_empty(),
            "a full weapon was picked up again"
        );
        assert_eq!(w.len(), 1, "the refused weapon must stay in the world");
        assert_eq!(
            inv.count_of(BAZOOKA),
            u32::from(full),
            "the refused pickup changed the stack it was refused for"
        );

        // The control: a different weapon on the same ground is accepted.
        let other = crate::items::registry::GRENADE;
        w.spawn(other, 1, pos, Vec2::ZERO, SpawnSource::Initial, 0.0);
        let (mut h, mut bt) = (0u8, 0u8);
        let mut players = [target(0, pos, &mut inv, &mut h, &mut bt)];
        assert_eq!(
            w.resolve_pickups(&mut players, 2.0).len(),
            1,
            "a weapon we do not hold was refused too — this player cannot pick anything up"
        );
        assert_eq!(inv.count_of(other), 1);
    }

    #[test]
    fn a_partial_pickup_reduces_the_stack_and_leaves_the_rest() {
        let mut w = WorldItems::new();
        let pos = Vec2::new(256.0, 380.0);
        // A **consumable that still uses a slot**, deliberately, and for two
        // reasons. §C24 exempts weapons from spilling into a second slot, so a
        // grenade would assert the one-slot break instead — the same numbers by a
        // different mechanism. And since §C9 a medkit does not reach a slot at
        // all: it goes to a counter, so this test would have gone on passing
        // while measuring nothing. A shield generator is neither.
        w.spawn(
            SHIELD_GENERATOR,
            9,
            pos,
            Vec2::ZERO,
            SpawnSource::Initial,
            0.0,
        );
        let mut inv = Inventory::new();
        for _ in 0..(crate::constants::INVENTORY_SLOTS - 1) {
            inv.add(FLASHLIGHT, 1);
        }
        let (mut h, mut bt) = (0u8, 0u8);
        let mut players = [target(0, pos, &mut inv, &mut h, &mut bt)];
        w.resolve_pickups(&mut players, 1.0);
        let stack = crate::items::registry::max_stack(SHIELD_GENERATOR);
        assert_eq!(
            inv.count_of(SHIELD_GENERATOR),
            u32::from(stack),
            "one slot's worth was taken"
        );
        assert_eq!(w.len(), 1);
        assert_eq!(
            w.iter().next().expect("there").count,
            9 - stack,
            "the rest stays"
        );
    }

    #[test]
    fn a_death_drop_cannot_be_picked_up_immediately() {
        let mut w = WorldItems::new();
        let pos = Vec2::new(256.0, 380.0);
        w.spawn(MEDKIT, 1, pos, Vec2::ZERO, SpawnSource::Death, 10.0);
        let mut inv = Inventory::new();

        let (mut h, mut bt) = (0u8, 0u8);
        let mut players = [target(0, pos, &mut inv, &mut h, &mut bt)];
        assert!(w.resolve_pickups(&mut players, 10.5).is_empty(), "locked");
        let (mut h, mut bt) = (0u8, 0u8);
        let mut players = [target(0, pos, &mut inv, &mut h, &mut bt)];
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

#[cfg(test)]
mod consumable_pickups {
    use super::tests::target;
    use super::*;
    use crate::constants::{MAX_BATTERIES, MAX_HEALS};
    use crate::items::registry::{BATTERY_PACK, MEDKIT};

    fn at(pos: Vec2, item: ItemId, count: u8) -> WorldItems {
        let mut w = WorldItems::new();
        w.spawn(item, count, pos, Vec2::ZERO, SpawnSource::Initial, 0.0);
        w
    }

    /// §C9: a heal goes to the counter and never touches a slot.
    #[test]
    fn a_medkit_lands_in_the_counter_not_in_the_inventory() {
        let pos = Vec2::new(100.0, 100.0);
        let mut w = at(pos, MEDKIT, 1);
        let mut inv = Inventory::new();
        let (mut h, mut b) = (0u8, 0u8);
        let mut players = [target(0, pos, &mut inv, &mut h, &mut b)];

        assert_eq!(w.resolve_pickups(&mut players, 1.0).len(), 1);
        assert_eq!(h, 1);
        assert_eq!(inv.count_of(MEDKIT), 0, "a heal took an inventory slot");
        assert_eq!(w.len(), 0, "picked up and still lying in the world");
    }

    #[test]
    fn a_battery_pack_lands_in_its_own_counter() {
        let pos = Vec2::new(100.0, 100.0);
        let mut w = at(pos, BATTERY_PACK, 1);
        let mut inv = Inventory::new();
        let (mut h, mut b) = (0u8, 0u8);
        let mut players = [target(0, pos, &mut inv, &mut h, &mut b)];

        assert_eq!(w.resolve_pickups(&mut players, 1.0).len(), 1);
        assert_eq!((h, b), (0, 1), "a battery pack moved the wrong counter");
        assert_eq!(inv.count_of(BATTERY_PACK), 0);
    }

    /// The rule §C9 shares with a full inventory (`docs/30` §2): **refused, and
    /// the item stays on the ground**. With the control immediately below it, so
    /// this is about the cap and not about pickups never working.
    #[test]
    fn a_pickup_at_max_is_refused_and_the_item_stays() {
        let pos = Vec2::new(100.0, 100.0);
        let mut w = at(pos, MEDKIT, 1);
        let mut inv = Inventory::new();
        let (mut h, mut b) = (MAX_HEALS, 0u8);
        let mut players = [target(0, pos, &mut inv, &mut h, &mut b)];

        assert!(w.resolve_pickups(&mut players, 1.0).is_empty());
        assert_eq!(h, MAX_HEALS, "a refused pickup still moved the counter");
        assert_eq!(
            w.len(),
            1,
            "a refused pickup took the item out of the world"
        );

        // Control: one below the cap, the same item is taken.
        let (mut h2, mut b2) = (MAX_HEALS - 1, 0u8);
        let mut inv2 = Inventory::new();
        let mut players2 = [target(0, pos, &mut inv2, &mut h2, &mut b2)];
        assert_eq!(w.resolve_pickups(&mut players2, 1.0).len(), 1);
        assert_eq!(h2, MAX_HEALS);
        assert_eq!(w.len(), 0);
    }

    /// A stack bigger than the room left: take what fits, leave the rest.
    #[test]
    fn a_partial_stack_fills_the_counter_and_leaves_the_remainder() {
        let pos = Vec2::new(100.0, 100.0);
        let mut w = at(pos, BATTERY_PACK, MAX_BATTERIES + 3);
        let mut inv = Inventory::new();
        let (mut h, mut b) = (0u8, 0u8);
        let mut players = [target(0, pos, &mut inv, &mut h, &mut b)];

        assert_eq!(w.resolve_pickups(&mut players, 1.0).len(), 1);
        assert_eq!(b, MAX_BATTERIES);
        assert_eq!(w.len(), 1, "the remainder must stay in the world");
        assert_eq!(
            w.iter().next().expect("still there").count,
            3,
            "the remainder is wrong, so pickups are being destroyed"
        );
    }
}
