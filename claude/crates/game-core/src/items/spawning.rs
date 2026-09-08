//! The four sources that put items into the world: initial placement, periodic
//! spawns, supply crates and buried slots.
//!
//! All of it is seeded and reproducible. See `docs/32-item-spawning.md`.

use crate::constants::{
    CRATE_H, CRATE_INTERVAL, CRATE_W, FLOOR_CRUST, ITEM_SPAWN_BATCH_MAX, ITEM_SPAWN_BATCH_MIN,
    ITEM_SPAWN_INTERVAL, SKY_MARGIN, WALL_W,
};
use crate::items::registry::{def, ItemId, ItemKind, WeightColumn};
use crate::items::world::{SpawnSource, WorldItemId, WorldItems};
use crate::map::gen::surface::is_standable;
use crate::map::Map;
use crate::math::{Point, Vec2};
use crate::rng::{pick_weighted, range_i32, substream, ChaCha8Rng};

/// Minimum gap between two initial items.
pub const INITIAL_ITEM_SEPARATION: f32 = 96.0;
/// Nobody starts standing on a bazooka.
pub const INITIAL_SPAWN_EXCLUSION: f32 = 64.0;
const INITIAL_ATTEMPTS: u32 = 200;

/// A periodic spawn should be something to travel to, not a gift.
pub const PERIODIC_PLAYER_DISTANCE: f32 = 200.0;
/// Attempts with the distance preference, then it is dropped.
const PERIODIC_PREFERRED_ATTEMPTS: u32 = 20;
/// Total attempts before the spawn is skipped entirely.
const PERIODIC_ATTEMPTS: u32 = 60;

/// Crates spawn at least this far from either wall.
pub const CRATE_WALL_MARGIN: i32 = 200;

/// Roll an item id from a weight column.
pub fn roll_item(rng: &mut ChaCha8Rng, col: WeightColumn) -> ItemId {
    pick_weighted(rng, &crate::items::registry::weights(col)) as ItemId
}

/// Weapons spawn at a full stack — a single-rocket pickup would make weapons feel
/// worthless. Everything else spawns as one.
pub fn spawn_count(item: ItemId) -> u8 {
    match def(item) {
        Some(d) => match d.kind {
            ItemKind::Weapon(_) => d.max_stack,
            _ => 1,
        },
        None => 1,
    }
}

/// Place the round's starting items.
///
/// **Must run before any periodic or crate roll.** It is the first consumer of the
/// `"items"` sub-stream, and the order of draws defines the stream position for
/// every later spawn (`docs/32-item-spawning.md` §7).
pub fn place_initial(world: &mut WorldItems, map: &Map, seed: u64, now: f32) -> u32 {
    let mut rng = substream(seed, "items");
    let want = map.meta.scale.params().initial_items;
    let surface = &map.meta.surface_points;
    if surface.is_empty() {
        return 0;
    }

    let sep2 = INITIAL_ITEM_SEPARATION * INITIAL_ITEM_SEPARATION;
    let excl2 = INITIAL_SPAWN_EXCLUSION * INITIAL_SPAWN_EXCLUSION;
    let mut placed: Vec<Vec2> = Vec::with_capacity(want as usize);
    let mut forced = 0u32;

    for _ in 0..want {
        let mut chosen: Option<Vec2> = None;
        let mut last = Vec2::ZERO;
        for _ in 0..INITIAL_ATTEMPTS {
            let p = surface[range_i32(&mut rng, 0, surface.len() as i32 - 1) as usize];
            let v = Vec2::new(p.x as f32, p.y as f32);
            last = v;
            if placed.iter().any(|q| (v - *q).len_sq() < sep2) {
                continue;
            }
            if map
                .meta
                .spawn_points
                .iter()
                .any(|s| (v - Vec2::new(s.x as f32, s.y as f32)).len_sq() < excl2)
            {
                continue;
            }
            chosen = Some(v);
            break;
        }
        // Under-placing would be invisible in play and confusing in tests, so a
        // cramped map gets a tight cluster rather than fewer items.
        let v = match chosen {
            Some(v) => v,
            None => {
                forced += 1;
                last
            }
        };
        let item = roll_item(&mut rng, WeightColumn::Spawn);
        world.spawn(
            item,
            spawn_count(item),
            v,
            Vec2::ZERO,
            SpawnSource::Initial,
            now,
        );
        placed.push(v);
    }
    forced
}

/// Roll the item for every buried slot, **at round start**.
///
/// Rolling at reveal time would make the stream's consumption depend on where
/// players happened to shoot, which breaks reproducibility. Uses the `"buried"`
/// stream, not `"items"`, so buried assignment cannot shift the periodic sequence.
pub fn assign_buried_items(map: &Map, seed: u64) -> Vec<ItemId> {
    let mut rng = substream(seed, "buried");
    map.meta
        .buried_slots
        .iter()
        .map(|_| roll_item(&mut rng, WeightColumn::Buried))
        .collect()
}

/// Turn slot ids revealed by a carve into real world items.
///
/// `CarveResult.revealed` feeds this directly. The item appears at the slot's
/// position with zero velocity — possibly mid-air inside the fresh crater, which
/// the normal item physics then drops to the crater floor.
pub fn reveal_buried(
    world: &mut WorldItems,
    map: &Map,
    buried_items: &[ItemId],
    revealed: &[u16],
    now: f32,
) -> Vec<WorldItemId> {
    let mut out = Vec::new();
    for &slot_id in revealed {
        let Some(slot) = map.meta.buried_slots.iter().find(|s| s.id == slot_id) else {
            continue;
        };
        let Some(&item) = buried_items.get(slot_id as usize) else {
            continue;
        };
        out.push(world.spawn(
            item,
            spawn_count(item),
            Vec2::new(slot.pos.x as f32, slot.pos.y as f32),
            Vec2::ZERO,
            SpawnSource::Buried,
            now,
        ));
    }
    out
}

/// Pick a surface point that is **still** valid on the damaged map.
///
/// `map.meta.surface_points` is a snapshot of the pristine map; twenty seconds in,
/// many of those points are mid-air over a crater. Spawning there drops items into
/// the void where they fall to bedrock in a heap — a bug that presents as "items
/// stopped appearing" and is tedious to trace.
pub fn resample_surface(map: &Map, rng: &mut ChaCha8Rng, players: &[Vec2]) -> Option<Point> {
    let surface = &map.meta.surface_points;
    if surface.is_empty() {
        return None;
    }
    let far2 = PERIODIC_PLAYER_DISTANCE * PERIODIC_PLAYER_DISTANCE;

    for attempt in 0..PERIODIC_ATTEMPTS {
        let p = surface[range_i32(rng, 0, surface.len() as i32 - 1) as usize];
        if !is_standable(&map.mask, p.x, p.y) {
            continue;
        }
        // A soft preference: dropped after the first few attempts so it never
        // becomes an additional way to fail.
        if attempt < PERIODIC_PREFERRED_ATTEMPTS {
            let v = Vec2::new(p.x as f32, p.y as f32);
            if players.iter().any(|q| (v - *q).len_sq() < far2) {
                continue;
            }
        }
        return Some(p);
    }
    // Late in a heavily-cratered round there genuinely may be nowhere good, and
    // skipping is the honest outcome.
    None
}

/// Periodic item spawns and supply crates.
pub struct SpawnSchedule {
    rng: ChaCha8Rng,
    next_item_at: f32,
    next_crate_at: f32,
}

impl SpawnSchedule {
    /// See `EffectScheduler::hash_into` — same reasoning, same RNG probe.
    pub fn hash_into(&self, h: &mut blake3::Hasher) {
        h.update(&self.next_item_at.to_le_bytes());
        h.update(&self.next_crate_at.to_le_bytes());
        let mut probe = self.rng.clone();
        h.update(&rand::RngCore::next_u64(&mut probe).to_le_bytes());
    }

    /// `place_initial` must already have run on the same seed, so this continues
    /// the `"items"` stream where that left off.
    pub fn new(seed: u64, round_start: f32, initial_draws: u32) -> Self {
        let mut rng = substream(seed, "items");
        // Fast-forward past the initial placement's draws so the two share one
        // stream in a fixed order.
        for _ in 0..initial_draws {
            let _ = range_i32(&mut rng, 0, 1);
        }
        SpawnSchedule {
            rng,
            next_item_at: round_start + ITEM_SPAWN_INTERVAL,
            next_crate_at: round_start + CRATE_INTERVAL,
        }
    }

    pub fn next_item_at(&self) -> f32 {
        self.next_item_at
    }

    pub fn next_crate_at(&self) -> f32 {
        self.next_crate_at
    }

    /// Called once per tick **during `Playing` only** — the phase gate lives in the
    /// world step (T6.01), not here.
    pub fn tick_items(
        &mut self,
        world: &mut WorldItems,
        map: &Map,
        players: &[Vec2],
        now: f32,
    ) -> Vec<WorldItemId> {
        let mut out = Vec::new();
        if now < self.next_item_at {
            return out;
        }
        // Advance from the previous scheduled time, never from `now`: advancing
        // from `now` lets drift accumulate and the cadence slowly desynchronises
        // from the round clock.
        self.next_item_at += ITEM_SPAWN_INTERVAL;

        let batch = range_i32(
            &mut self.rng,
            ITEM_SPAWN_BATCH_MIN as i32,
            ITEM_SPAWN_BATCH_MAX as i32,
        );
        for _ in 0..batch {
            // Make room before spawning, not after, so the cap is never exceeded.
            world.make_room();
            let Some(p) = resample_surface(map, &mut self.rng, players) else {
                continue;
            };
            let item = roll_item(&mut self.rng, WeightColumn::Spawn);
            out.push(world.spawn(
                item,
                spawn_count(item),
                Vec2::new(p.x as f32, p.y as f32),
                Vec2::ZERO,
                SpawnSource::Periodic,
                now,
            ));
        }
        out
    }

    /// Called once per tick during `Playing`.
    pub fn tick_crates(
        &mut self,
        world: &mut WorldItems,
        map: &Map,
        now: f32,
    ) -> Option<WorldItemId> {
        if now < self.next_crate_at {
            return None;
        }
        self.next_crate_at += CRATE_INTERVAL;

        let lo = WALL_W as i32 + CRATE_WALL_MARGIN;
        let hi = map.mask.w as i32 - WALL_W as i32 - CRATE_WALL_MARGIN;
        if hi <= lo {
            return None;
        }
        let x = range_i32(&mut self.rng, lo, hi);

        // Contents are rolled **at spawn**, not at landing: the spawn tick is
        // deterministic while the landing tick depends on what players have blown
        // up, so rolling late would make the stream's consumption order depend on
        // the fight (`docs/32` §4).
        let item = roll_item(&mut self.rng, WeightColumn::Crate);
        Some(world.spawn(
            item,
            spawn_count(item),
            Vec2::new(x as f32, (SKY_MARGIN / 2) as f32),
            Vec2::ZERO,
            SpawnSource::Crate,
            now,
        ))
    }
}

/// A crate's AABB, exposed so the renderer and tests agree with the physics.
pub fn crate_size() -> (f32, f32) {
    (CRATE_W, CRATE_H)
}

/// The top of the generated floor crust, for tests that build hand-made maps.
///
/// It used to be "the lowest carveable row", which was the same number while the
/// bottom band was indestructible. §C15 split those two meanings: the lowest
/// carveable row is now `h` — there is nothing the carve will not touch — and
/// what a fixture actually wants when it says "the floor" is where generation
/// stops laying rock. That is this.
pub fn floor_limit(map: &Map) -> i32 {
    map.mask.h as i32 - FLOOR_CRUST as i32
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::constants::{MapScale, MAX_WORLD_ITEMS, SIM_DT, WORLD_ITEM_TTL};
    use crate::items::registry::{FLASHLIGHT, ITEMS};
    use crate::map::generate;

    fn medium() -> Map {
        generate(4242, MapScale::Medium)
    }

    // ---------------------------------------------------------------- T4.04

    #[test]
    fn place_initial_produces_exactly_the_scale_count() {
        for scale in MapScale::ALL {
            let map = generate(31337, scale);
            let mut w = WorldItems::new();
            place_initial(&mut w, &map, 31337, 0.0);
            assert_eq!(
                w.len() as u32,
                scale.params().initial_items,
                "{scale:?} placed the wrong number of items"
            );
        }
    }

    #[test]
    fn initial_items_land_on_standable_ground_and_respect_the_spacing() {
        let map = medium();
        let mut w = WorldItems::new();
        let forced = place_initial(&mut w, &map, 4242, 0.0);
        assert_eq!(forced, 0, "a medium map should never force a placement");

        let pts: Vec<Vec2> = w.iter().map(|i| i.pos).collect();
        for p in &pts {
            assert!(
                is_standable(&map.mask, p.x as i32, p.y as i32),
                "item at {p:?} is not on standable ground"
            );
        }
        for (i, a) in pts.iter().enumerate() {
            for b in &pts[i + 1..] {
                let d = (*a - *b).len();
                assert!(
                    d >= INITIAL_ITEM_SEPARATION - 0.01,
                    "two items only {d} px apart"
                );
            }
            for s in &map.meta.spawn_points {
                let d = (*a - Vec2::new(s.x as f32, s.y as f32)).len();
                assert!(
                    d >= INITIAL_SPAWN_EXCLUSION - 0.01,
                    "item {d} px from a spawn"
                );
            }
        }
    }

    #[test]
    fn initial_placement_is_deterministic_and_stream_isolated() {
        let map = medium();
        let layout = |_: u32| {
            let mut w = WorldItems::new();
            place_initial(&mut w, &map, 4242, 0.0);
            w.iter().map(|i| (i.item, i.pos)).collect::<Vec<_>>()
        };
        let first = layout(0);
        for _ in 0..20 {
            assert_eq!(layout(0), first);
        }

        // Draining another sub-stream must not move the item layout.
        let mut weather = substream(4242, "weather");
        for _ in 0..100_000 {
            let _ = range_i32(&mut weather, 0, 1000);
        }
        assert_eq!(layout(0), first);
    }

    #[test]
    fn every_rolled_item_can_actually_spawn_from_its_column() {
        let map = medium();
        let mut w = WorldItems::new();
        place_initial(&mut w, &map, 99, 0.0);
        for it in w.iter() {
            let d = def(it.item).expect("registry entry");
            assert!(d.spawn_weight > 0, "{} has spawn weight 0", d.key);
        }
    }

    #[test]
    fn spawn_count_gives_weapons_a_full_load() {
        for d in ITEMS {
            let n = spawn_count(d.id);
            match d.kind {
                ItemKind::Weapon(_) => assert_eq!(n, d.max_stack, "{} short-changed", d.key),
                _ => assert_eq!(n, 1, "{} should spawn as one", d.key),
            }
        }
    }

    #[test]
    fn the_weighted_roll_matches_the_table_within_two_percent() {
        let mut rng = substream(7, "items");
        const N: usize = 100_000;
        let mut hits = vec![0usize; ITEMS.len()];
        for _ in 0..N {
            hits[roll_item(&mut rng, WeightColumn::Spawn) as usize] += 1;
        }
        let total: f64 = ITEMS.iter().map(|d| d.spawn_weight as f64).sum();
        for (i, d) in ITEMS.iter().enumerate() {
            let want = d.spawn_weight as f64 / total;
            let got = hits[i] as f64 / N as f64;
            assert!(
                (want - got).abs() < 0.02,
                "{}: expected {want:.3}, got {got:.3}",
                d.key
            );
        }
    }

    #[test]
    fn a_tiny_map_does_not_hang_or_panic() {
        let mut map = medium();
        map.meta.surface_points.truncate(3);
        let mut w = WorldItems::new();
        place_initial(&mut w, &map, 1, 0.0);
        assert!(!w.is_empty());
    }

    // ---------------------------------------------------------------- T4.05

    #[test]
    fn nothing_spawns_before_the_first_interval() {
        let map = medium();
        let mut w = WorldItems::new();
        let mut s = SpawnSchedule::new(4242, 0.0, 0);
        assert!(s
            .tick_items(&mut w, &map, &[], ITEM_SPAWN_INTERVAL - 0.1)
            .is_empty());
        assert!(!s
            .tick_items(&mut w, &map, &[], ITEM_SPAWN_INTERVAL)
            .is_empty());
    }

    #[test]
    fn the_batch_size_stays_within_range_and_the_cadence_does_not_drift() {
        let map = medium();
        let mut w = WorldItems::new();
        let mut s = SpawnSchedule::new(4242, 0.0, 0);
        for i in 1..=100 {
            let t = ITEM_SPAWN_INTERVAL * i as f32;
            let n = s.tick_items(&mut w, &map, &[], t).len();
            assert!(
                n <= ITEM_SPAWN_BATCH_MAX as usize,
                "batch of {n} exceeds the maximum"
            );
            // Items are culled as the world fills, so only the cap is asserted.
        }
        // Advancing from the previous scheduled time, never from `now`.
        assert!(
            (s.next_item_at() - (100.0 + 1.0) * ITEM_SPAWN_INTERVAL).abs() < 1e-3,
            "cadence drifted: next at {}",
            s.next_item_at()
        );
    }

    /// **The reason T4.05 exists.**
    #[test]
    fn a_periodic_spawn_lands_on_ground_that_is_still_there() {
        let mut map = medium();
        // Carve away a whole region's worth of surface, so most of the pristine
        // snapshot in MapMeta is now mid-air over a crater.
        //
        // The band is taken from the surface itself rather than from a fixed
        // x window. It was `800 < x < 2000`, which held until pass 6b started
        // stamping scenery and moved where a medium map's standable ground is —
        // a fixture pinned to a coordinate the generator is free to change.
        let mut by_x: Vec<Point> = map.meta.surface_points.clone();
        by_x.sort_by_key(|p| (p.x, p.y));
        let quarter = by_x.len() / 4;
        let victims: Vec<Point> = by_x[quarter..by_x.len() - quarter].to_vec();
        assert!(victims.len() > 20, "need a meaningful region to destroy");
        for p in &victims {
            map.carve_circle(p.x, p.y, 40);
        }

        let mut w = WorldItems::new();
        let mut s = SpawnSchedule::new(4242, 0.0, 0);
        let mut spawned = 0;
        for i in 1..=40 {
            for id in s.tick_items(&mut w, &map, &[], ITEM_SPAWN_INTERVAL * i as f32) {
                let it = w.get(id).expect("just spawned");
                assert!(
                    is_standable(&map.mask, it.pos.x as i32, it.pos.y as i32),
                    "spawned into the void at {:?} — surface was not re-validated",
                    it.pos
                );
                spawned += 1;
            }
        }
        assert!(spawned > 0, "nothing spawned, so nothing was proven");
    }

    #[test]
    fn with_no_valid_surface_left_the_spawn_is_skipped_rather_than_forced() {
        let mut map = medium();
        let pts = map.meta.surface_points.clone();
        for p in &pts {
            map.carve_circle(p.x, p.y, 48);
        }
        let mut w = WorldItems::new();
        let mut s = SpawnSchedule::new(4242, 0.0, 0);
        // No panic, no hang, and nothing dropped into mid-air.
        for i in 1..=20 {
            for id in s.tick_items(&mut w, &map, &[], ITEM_SPAWN_INTERVAL * i as f32) {
                let it = w.get(id).expect("just spawned");
                assert!(is_standable(&map.mask, it.pos.x as i32, it.pos.y as i32));
            }
        }
    }

    #[test]
    fn periodic_spawns_prefer_ground_away_from_players() {
        let map = medium();
        let player = Vec2::new(
            map.meta.spawn_points[0].x as f32,
            map.meta.spawn_points[0].y as f32,
        );
        let mut w = WorldItems::new();
        let mut s = SpawnSchedule::new(11, 0.0, 0);
        let mut dists = Vec::new();
        for i in 1..=100 {
            for id in s.tick_items(&mut w, &map, &[player], ITEM_SPAWN_INTERVAL * i as f32) {
                dists.push((w.get(id).expect("there").pos - player).len());
            }
            w.cull(ITEM_SPAWN_INTERVAL * i as f32);
        }
        assert!(!dists.is_empty());
        let mean = dists.iter().sum::<f32>() / dists.len() as f32;
        assert!(
            mean > PERIODIC_PLAYER_DISTANCE,
            "mean spawn distance only {mean}"
        );
    }

    #[test]
    fn periodic_spawning_is_deterministic() {
        let map = medium();
        let run = || {
            let mut w = WorldItems::new();
            let mut s = SpawnSchedule::new(4242, 0.0, 0);
            for i in 1..=10 {
                s.tick_items(&mut w, &map, &[], ITEM_SPAWN_INTERVAL * i as f32);
            }
            w.iter().map(|i| (i.item, i.pos)).collect::<Vec<_>>()
        };
        let first = run();
        for _ in 0..20 {
            assert_eq!(run(), first);
        }
    }

    #[test]
    fn spawning_at_the_cap_evicts_rather_than_exceeding_it() {
        let map = medium();
        let mut w = WorldItems::new();
        for i in 0..MAX_WORLD_ITEMS {
            w.spawn(
                FLASHLIGHT,
                1,
                Vec2::new(10.0, 10.0),
                Vec2::ZERO,
                SpawnSource::Initial,
                i as f32,
            );
        }
        let mut s = SpawnSchedule::new(4242, 0.0, 0);
        s.tick_items(&mut w, &map, &[], ITEM_SPAWN_INTERVAL);
        assert!(w.len() <= MAX_WORLD_ITEMS, "cap exceeded: {}", w.len());
    }

    // ---------------------------------------------------------------- T4.06

    #[test]
    fn crates_arrive_on_cadence_without_drift() {
        let map = medium();
        let mut w = WorldItems::new();
        let mut s = SpawnSchedule::new(4242, 0.0, 0);
        assert!(s.tick_crates(&mut w, &map, CRATE_INTERVAL - 0.1).is_none());
        assert!(s.tick_crates(&mut w, &map, CRATE_INTERVAL).is_some());
        assert!(s.tick_crates(&mut w, &map, CRATE_INTERVAL + 1.0).is_none());
        for i in 2..=20 {
            assert!(s
                .tick_crates(&mut w, &map, CRATE_INTERVAL * i as f32)
                .is_some());
        }
        assert!((s.next_crate_at() - CRATE_INTERVAL * 21.0).abs() < 1e-3);
    }

    #[test]
    fn crates_spawn_clear_of_the_walls_at_the_right_height() {
        let map = medium();
        let mut w = WorldItems::new();
        let mut s = SpawnSchedule::new(77, 0.0, 0);
        for i in 1..=100 {
            if let Some(id) = s.tick_crates(&mut w, &map, CRATE_INTERVAL * i as f32) {
                let it = w.get(id).expect("there");
                assert!(it.pos.x >= (WALL_W as i32 + CRATE_WALL_MARGIN) as f32);
                assert!(it.pos.x <= (map.mask.w as i32 - WALL_W as i32 - CRATE_WALL_MARGIN) as f32);
                assert_eq!(it.pos.y, (SKY_MARGIN / 2) as f32);
                assert_eq!(it.source, SpawnSource::Crate);
            }
        }
    }

    #[test]
    fn a_crate_falls_and_rests_on_the_terrain() {
        let map = medium();
        let mut w = WorldItems::new();
        let mut s = SpawnSchedule::new(4242, 0.0, 0);
        let id = s
            .tick_crates(&mut w, &map, CRATE_INTERVAL)
            .expect("a crate");
        for _ in 0..2000 {
            w.step(&map, SIM_DT);
        }
        let it = w.get(id).expect("there");
        assert!(it.grounded, "the crate never landed");
        // Resting on the surface, not inside it.
        let (_, ch) = crate_size();
        assert!(
            !crate::physics::collide::aabb_overlaps_solid(
                &map,
                crate::math::Aabb::from_center_size(it.pos, CRATE_W, ch)
            ),
            "the crate came to rest inside terrain"
        );
    }

    #[test]
    fn crate_contents_are_fixed_at_spawn_not_at_landing() {
        let mut map = medium();
        let mut w = WorldItems::new();
        let mut s = SpawnSchedule::new(4242, 0.0, 0);
        let id = s
            .tick_crates(&mut w, &map, CRATE_INTERVAL)
            .expect("a crate");
        let rolled = w.get(id).expect("there").item;

        // Blow the ground out from under it so it falls much further; the contents
        // must not change, or a replay could not reproduce them.
        let x = w.get(id).expect("there").pos.x as i32;
        // Stop the shaft `CRATE_FALL_FLOOR_MARGIN` above the bottom. §C15 made the
        // floor destructible, so a column carved all the way down now drops the
        // crate out of the world and voids it — the test would then fail on a
        // missing crate while saying the contents changed. The margin has to clear
        // the carve radius, or the last bite punches through anyway.
        const CRATE_FALL_FLOOR_MARGIN: i32 = 200;
        let bottom = map.mask.h as i32 - CRATE_FALL_FLOOR_MARGIN;
        for y in (SKY_MARGIN as i32..bottom).step_by(60) {
            map.carve_circle(x, y, 70);
        }
        for _ in 0..3000 {
            w.step(&map, SIM_DT);
        }
        assert_eq!(w.get(id).expect("there").item, rolled);
    }

    #[test]
    fn crate_contents_only_come_from_the_crate_column() {
        let map = medium();
        let mut w = WorldItems::new();
        let mut s = SpawnSchedule::new(5, 0.0, 0);
        for i in 1..=60 {
            if let Some(id) = s.tick_crates(&mut w, &map, CRATE_INTERVAL * i as f32) {
                let d = def(w.get(id).expect("there").item).expect("registry");
                assert!(d.crate_weight > 0, "{} cannot come from a crate", d.key);
            }
        }
    }

    #[test]
    fn crates_survive_ttl_and_the_item_cap() {
        let map = medium();
        let mut w = WorldItems::new();
        let mut s = SpawnSchedule::new(4242, 0.0, 0);
        let id = s
            .tick_crates(&mut w, &map, CRATE_INTERVAL)
            .expect("a crate");
        for i in 0..60 {
            w.spawn(
                FLASHLIGHT,
                1,
                Vec2::new(10.0, 10.0),
                Vec2::ZERO,
                SpawnSource::Initial,
                i as f32,
            );
        }
        w.cull(CRATE_INTERVAL + WORLD_ITEM_TTL * 2.0);
        assert!(w.get(id).is_some(), "the crate was culled");
        assert!(w.len() <= MAX_WORLD_ITEMS);
    }

    // ---------------------------------------------------------------- T4.07

    #[test]
    fn every_buried_slot_gets_an_item_that_can_be_buried() {
        let map = medium();
        let items = assign_buried_items(&map, 4242);
        assert_eq!(items.len(), map.meta.buried_slots.len());
        for &id in &items {
            let d = def(id).expect("registry");
            assert!(d.buried_weight > 0, "{} cannot be buried", d.key);
        }
    }

    #[test]
    fn buried_assignment_is_deterministic() {
        let map = medium();
        let first = assign_buried_items(&map, 4242);
        for _ in 0..20 {
            assert_eq!(assign_buried_items(&map, 4242), first);
        }
    }

    #[test]
    fn the_flashlight_is_the_commonest_buried_item() {
        // A design choice worth protecting: "dig for the flashlight before
        // nightfall" only works if it is genuinely the likeliest find.
        let map = medium();
        let mut hits = vec![0usize; ITEMS.len()];
        for seed in 0..1000u64 {
            for id in assign_buried_items(&map, seed) {
                hits[id as usize] += 1;
            }
        }
        let best = hits
            .iter()
            .enumerate()
            .max_by_key(|(_, &n)| n)
            .map(|(i, _)| i as ItemId)
            .expect("some items");
        assert_eq!(best, FLASHLIGHT, "the flashlight is not the commonest find");

        let total: usize = hits.iter().sum();
        let table: f64 = ITEMS.iter().map(|d| d.buried_weight as f64).sum();
        for (i, d) in ITEMS.iter().enumerate() {
            let want = d.buried_weight as f64 / table;
            let got = hits[i] as f64 / total as f64;
            assert!(
                (want - got).abs() < 0.03,
                "{}: want {want:.3} got {got:.3}",
                d.key
            );
        }
    }

    #[test]
    fn buried_assignment_does_not_shift_the_periodic_sequence() {
        // Different sub-streams, so one cannot disturb the other.
        let map = medium();
        let periodic = || {
            let mut w = WorldItems::new();
            let mut s = SpawnSchedule::new(4242, 0.0, 0);
            for i in 1..=8 {
                s.tick_items(&mut w, &map, &[], ITEM_SPAWN_INTERVAL * i as f32);
            }
            w.iter().map(|i| (i.item, i.pos)).collect::<Vec<_>>()
        };
        let without = periodic();
        let _ = assign_buried_items(&map, 4242);
        assert_eq!(periodic(), without);
    }

    /// **The boundary that makes digging pay.**
    #[test]
    fn a_carve_over_a_slot_reveals_it_and_one_pixel_short_does_not() {
        let mut map = medium();
        let items = assign_buried_items(&map, 4242);
        let slot = map.meta.buried_slots[0].clone();

        // One pixel short: the carve's edge stops just before the slot centre.
        let r = 30;
        let miss = map.carve_circle(slot.pos.x + r + 1, slot.pos.y, r);
        assert!(
            !miss.revealed.contains(&slot.id),
            "a carve that misses by a pixel must reveal nothing"
        );

        let mut w = WorldItems::new();
        assert!(reveal_buried(&mut w, &map, &items, &miss.revealed, 0.0).is_empty());

        // Covering the centre reveals exactly one item, at the slot's position.
        let hit = map.carve_circle(slot.pos.x, slot.pos.y, r);
        assert!(hit.revealed.contains(&slot.id));
        let ids = reveal_buried(&mut w, &map, &items, &hit.revealed, 0.0);
        assert_eq!(ids.len(), 1);
        let it = w.get(ids[0]).expect("revealed");
        assert_eq!(it.source, SpawnSource::Buried);
        assert_eq!(it.pos, Vec2::new(slot.pos.x as f32, slot.pos.y as f32));
        assert_eq!(it.item, items[slot.id as usize]);
    }

    #[test]
    fn carving_the_same_slot_twice_produces_one_item() {
        // Carpet-bombing one spot must not duplicate the loot.
        let mut map = medium();
        let items = assign_buried_items(&map, 4242);
        let slot = map.meta.buried_slots[0].clone();
        let mut w = WorldItems::new();

        let first = map.carve_circle(slot.pos.x, slot.pos.y, 40);
        let a = reveal_buried(&mut w, &map, &items, &first.revealed, 0.0);
        let second = map.carve_circle(slot.pos.x, slot.pos.y, 40);
        let b = reveal_buried(&mut w, &map, &items, &second.revealed, 0.0);
        assert_eq!(a.len(), 1);
        assert!(b.is_empty(), "a second carve re-revealed the slot");
        assert_eq!(w.len(), 1);
    }

    #[test]
    fn revealing_every_slot_produces_exactly_that_many_items() {
        let mut map = medium();
        let items = assign_buried_items(&map, 4242);
        let want = map.meta.buried_slots.len();
        let slots: Vec<Point> = map.meta.buried_slots.iter().map(|s| s.pos).collect();
        let mut w = WorldItems::new();
        for p in slots {
            let res = map.carve_circle(p.x, p.y, 30);
            reveal_buried(&mut w, &map, &items, &res.revealed, 0.0);
        }
        assert_eq!(w.len(), want);
    }

    #[test]
    fn a_revealed_item_falls_to_the_crater_floor() {
        let mut map = medium();
        let items = assign_buried_items(&map, 4242);
        let slot = map.meta.buried_slots[0].clone();
        let mut w = WorldItems::new();
        // A big crater, so the item is genuinely mid-air when it appears.
        let res = map.carve_circle(slot.pos.x, slot.pos.y - 40, 90);
        let ids = reveal_buried(&mut w, &map, &items, &res.revealed, 0.0);
        if ids.is_empty() {
            return; // that carve did not cover this slot; nothing to assert
        }
        let start = w.get(ids[0]).expect("there").pos.y;
        for _ in 0..600 {
            w.step(&map, SIM_DT);
        }
        let it = w.get(ids[0]).expect("there");
        assert!(it.grounded, "the revealed item never settled");
        assert!(it.pos.y >= start, "it should fall, not rise");
    }
}
