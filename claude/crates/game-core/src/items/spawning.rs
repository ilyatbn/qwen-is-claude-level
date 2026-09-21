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
    // **The landscape precondition, kept as one** (T22.05C/F8). On the space
    // path nothing below reads `surface` — `map.random_body_site` draws from
    // open air — so this guard protects the landscape arm of that call, which
    // is the one that indexes `surface_points` directly. It is stated rather
    // than re-keyed because `random_body_site` already returns `None` on an
    // empty pool and the loop treats that as a rejected attempt: keying the
    // guard to the space path would be a second spelling of a check that is
    // already inside the function it guards. It is inert in space today, and a
    // reader should know that is deliberate rather than an oversight.
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
        // **The first point this map yielded, not the origin.** `last` is the
        // cramped-map fallback below, and on a space map an attempt can now
        // yield *nothing* — so seeding it with `Vec2::ZERO` would drop a
        // forced item at the top-left corner of the map, outside the rim, in
        // the void. `None` here means every attempt failed, which is the one
        // case that genuinely has nowhere to put the item.
        let mut last: Option<Vec2> = None;
        for _ in 0..INITIAL_ATTEMPTS {
            // **In space, open air; otherwise the surface** (`M22-RULINGS` R14,
            // `T22.05B`). R14 puts every non-player body at gravity scale 0, so
            // an item rests exactly where it is put — which makes *where it is
            // put* the entire placement rule rather than a starting height.
            //
            // **That tense is load-bearing and it is carried by a named
            // mechanism** (T22.05C/F2): the scale is `GravityMode::Space.scale()`
            // = 0.0, reaching this body through `Forces::falling(mode)` at
            // `items/world.rs::WorldItems::step`, whose `mode` is the round's,
            // passed by `world/mod.rs`. At `6e1ef91` that call passed a literal
            // `1.0` and this sentence was false: measured over 300 ticks on a
            // Medium space map, all 14 initial items fell — up to 1232 px, peak
            // |vel.y| 900 — and every one came to rest on the rim's inner
            // floor. `crates_spawn_inside_the_arena_in_space` now steps the
            // bodies and pins "moved" to that constant, so the sentence cannot
            // go stale again without a test saying so.
            // A surface point would not be *wrong* here since T22.05B filtered
            // the crust out of `surface_points`, but it would stack the round's
            // loot on the handful of asteroid tops the sampler finds standable,
            // and the arena is mostly air. `None` means this map yielded no
            // open point in `SPACE_OPEN_SPACE_TRIES`, and the loop below treats
            // it the way it treats any rejected attempt.
            let Some(p) = map.random_body_site(&mut rng) else {
                continue;
            };
            let v = Vec2::new(p.x as f32, p.y as f32);
            last = Some(v);
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
        let v = match (chosen, last) {
            (Some(v), _) => v,
            (None, Some(v)) => {
                forced += 1;
                v
            }
            // Nowhere at all. Skipping is the honest outcome and it is the same
            // one `resample_surface` already reaches; the count of items placed
            // is the caller's own `world.len()`, not this loop's trip count.
            (None, None) => continue,
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
    // The same landscape precondition as `place_initial`'s, and the same
    // reading (T22.05C/F8): the space path below never touches `surface`.
    let surface = &map.meta.surface_points;
    if surface.is_empty() {
        return None;
    }
    // **In space this is a misnomer and the code says so** (`T22.05B`). There is
    // no surface to re-sample: R14 floats items where they are put, so a
    // periodic spawn goes into open air inside the rim, and `random_open_space`
    // re-checks the *live* mask for exactly the reason this function exists —
    // twenty seconds in, an open point may have rock blown into it, or a rock
    // blown out of one. The name is kept because five callers and a doc page
    // use it; the thing it guarantees is unchanged, which is *a place an item
    // can be that is still valid on the damaged map*.
    let far2 = PERIODIC_PLAYER_DISTANCE * PERIODIC_PLAYER_DISTANCE;

    for attempt in 0..PERIODIC_ATTEMPTS {
        let Some(p) = map.random_body_site(rng) else {
            continue;
        };
        // **`body_fits_at`, not `is_standable`**: the same call under gravity,
        // and in space *"a body fits here in open air"*, which is what the
        // re-check is for — a point that was open twenty seconds ago may have
        // rock blown into it now.
        if !map.body_fits_at(p) {
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

    /// Move both deadlines forward by `by` seconds, for `World::start_clock_at`.
    ///
    /// `new` anchors them at round time 0. Without this, a clock started past
    /// `CRATE_INTERVAL` drops one batch per tick until the schedule catches up.
    pub fn rebase(&mut self, by: f32) {
        self.next_item_at += by;
        self.next_crate_at += by;
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

        // **In space a crate does not come from the sky** (`M22-RULINGS` R16).
        //
        // The drop point below is `y = SKY_MARGIN / 2` = 48 at a random x, and
        // R13 insets the rim's outer edge to exactly `SKY_MARGIN`, so that
        // point is **above the rim's top arc at every x** — outside the
        // boundary, in the void R16 kills in. Under R14 the crate would then
        // hang there for the rest of the round, unreachable, because nothing
        // pulls a non-player body in this mode. So there is no version of the
        // sky drop that works here: it is not that the crate falls wrong, it is
        // that it is spawned somewhere no player may go.
        //
        // It arrives in open air inside the rim instead, from the same picker
        // the items use, and floats there. That is the supply crate this mode
        // has: a thing you fly to rather than a thing you run under.
        //
        // **"Floats there" is `GravityMode::Space.scale()` = 0.0 arriving
        // through `Forces::falling` at `items/world.rs::WorldItems::step`**, and
        // nothing else (T22.05C/F2). Before that argument existed the step
        // passed a literal `1.0` and every crate in this mode slid to the
        // bottom of the ellipse — the first thing a player would have seen
        // here. `crates_spawn_inside_the_arena_in_space` steps them and asserts
        // the effect — no crate moves — with a standard-gravity control on the
        // same map so "nothing moved" cannot be satisfied by a stepper that
        // moves nothing, and pins the constant on a separate line. **Separate
        // on purpose** (`T22.05D`): as one biconditional the two cancelled, and
        // planting the scale to 0.5 left that test green. What reports the
        // constant itself is `constants.rs::every_gravity_mode_has_a_multiplier`.
        //
        // **Reverse it by:** this match.
        let pos = match map.space_geometry() {
            Some(_) => {
                let p = map.random_body_site(&mut self.rng)?;
                Vec2::new(p.x as f32, p.y as f32)
            }
            None => {
                let lo = WALL_W as i32 + CRATE_WALL_MARGIN;
                let hi = map.mask.w as i32 - WALL_W as i32 - CRATE_WALL_MARGIN;
                if hi <= lo {
                    return None;
                }
                let x = range_i32(&mut self.rng, lo, hi);
                Vec2::new(x as f32, (SKY_MARGIN / 2) as f32)
            }
        };

        // Contents are rolled **at spawn**, not at landing: the spawn tick is
        // deterministic while the landing tick depends on what players have blown
        // up, so rolling late would make the stream's consumption order depend on
        // the fight (`docs/32` §4).
        let item = roll_item(&mut self.rng, WeightColumn::Crate);
        Some(world.spawn(
            item,
            spawn_count(item),
            pos,
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
    use crate::constants::{
        GravityMode, MapGenerator, MapScale, MAX_FALL_SPEED, MAX_WORLD_ITEMS, SIM_DT,
        WORLD_ITEM_TTL,
    };
    use crate::items::registry::{FLASHLIGHT, ITEMS};
    use crate::map::gen::surface::is_standable;
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

    // ------------------------------------------------- T22.05B (R14, R16)

    /// **R16: in space a crate does not come from the sky.**
    ///
    /// The drop point every other map uses is `y = SKY_MARGIN / 2` = 48 at a
    /// random x, and R13 insets the rim's outer edge to exactly `SKY_MARGIN` —
    /// so that point is above the rim's top arc at **every** x. Under R14 the
    /// crate would then float there, outside the boundary, for the rest of the
    /// round.
    ///
    /// The control is `crates_spawn_clear_of_the_walls_at_the_right_height`
    /// directly above, which asserts the sky drop is still exactly that on a
    /// landscape map — so this pair says the branch fired *and* that it fired
    /// only here. And the first assertion below is the falsification of this
    /// one written out: the old drop point really is outside the rim.
    #[test]
    fn crates_spawn_inside_the_arena_in_space() {
        for scale in MapScale::ALL {
            let map = crate::map::generate_with(4242, scale, MapGenerator::Space);
            let geo = map.space_geometry().expect("a space map");

            // The falsification, first: where crates used to go is outside.
            assert!(
                !geo.inside((map.mask.w / 2) as f32, (SKY_MARGIN / 2) as f32),
                "{scale:?}: the sky drop is inside the rim after all, so this test proves \
                 nothing"
            );

            let mut w = WorldItems::new();
            let mut s = SpawnSchedule::new(77, 0.0, 0);
            let mut crates = 0;
            for i in 1..=60 {
                let Some(id) = s.tick_crates(&mut w, &map, CRATE_INTERVAL * i as f32) else {
                    continue;
                };
                let it = w.get(id).expect("there");
                crates += 1;
                assert_eq!(it.source, SpawnSource::Crate);
                assert!(
                    geo.inside(it.pos.x, it.pos.y),
                    "{scale:?}: a crate spawned at {:?}, outside the rim",
                    it.pos
                );
                assert_ne!(
                    it.pos.y,
                    (SKY_MARGIN / 2) as f32,
                    "{scale:?}: a crate still came from the sky"
                );
                assert!(
                    !crate::physics::collide::aabb_overlaps_solid(
                        &map,
                        crate::math::Aabb::from_center_size(it.pos, CRATE_W, CRATE_H)
                    ),
                    "{scale:?}: a crate spawned inside rock at {:?}",
                    it.pos
                );
            }
            assert_eq!(crates, 60, "{scale:?}: only {crates} crates arrived");

            // ---------------------------------------------- T22.05C/F2
            //
            // **Where a crate *is* a second later, not only where it was put.**
            // Every assertion above is about the spawn tick, and `tick_crates`'
            // own comment promises the crate "floats there" — an effect nothing
            // measured. At `6e1ef91` it was false: `WorldItems::step` passed a
            // literal `1.0` to `integrate` and all of this mode's loot slid to
            // the bottom of the ellipse.
            //
            // **Two lines, not one biconditional** (`T22.05D`, from `R57`).
            // `T22.05C` wrote this as
            // `assert_eq!(space_moved == 0, GravityMode::Space.scale() == 0.0)`
            // and claimed it reported the mechanism coming apart in *either*
            // direction. Only one of those is true, and it was measured:
            // planting the `Space` arm of `GravityMode::scale` 0.0 → 0.5 makes
            // crates fall, so the left side goes `false` as the right side
            // does, `assert_eq!(false, false)` **passes**, and the test is
            // silent about the constant it names. That is `CLAUDE.md`'s
            // `ITEM_SPAWN_INTERVAL` shape — every term moving with the tunable.
            //
            // Split, each line reports one thing. The pin fires first and names
            // the constant; the effect below then reads as what it says — a
            // stepper that stopped asking the mode while the scale stayed zero,
            // which is the direction the old form really did hold (revert
            // `WorldItems::step` to a literal `1.0` and it goes red).
            // `constants.rs::every_gravity_mode_has_a_multiplier` is the
            // repository-wide cover for the constant, with the pairwise-distinct
            // control this local pin does not repeat.
            //
            // The control is the same 60 crates, same seed, same map, stepped
            // at `Standard`: without it "nothing moved" is satisfied by a
            // stepper that moves nothing, which is the shape this file already
            // records twice.
            let mut ctl = WorldItems::new();
            let mut cs = SpawnSchedule::new(77, 0.0, 0);
            for i in 1..=60 {
                cs.tick_crates(&mut ctl, &map, CRATE_INTERVAL * i as f32);
            }
            assert_eq!(
                ctl.len(),
                w.len(),
                "{scale:?}: the control is not the same set"
            );

            // Long enough for a body to cross the arena at terminal velocity,
            // which bounds any fall inside the rim. Derived, not a round number
            // a tunable could outgrow.
            let steps = ((2.0 * geo.ry / MAX_FALL_SPEED) / SIM_DT).ceil() as i32;
            let before: Vec<Vec2> = w.iter().map(|it| it.pos).collect();
            let ctl_before: Vec<Vec2> = ctl.iter().map(|it| it.pos).collect();
            for _ in 0..steps {
                w.step(&map, GravityMode::Space, SIM_DT);
                ctl.step(&map, GravityMode::Standard, SIM_DT);
            }
            let moved = |now: &WorldItems, then: &[Vec2]| -> usize {
                now.iter()
                    .zip(then)
                    .filter(|(it, p)| (it.pos - **p).len_sq() > 0.25)
                    .count()
            };
            let (space_moved, ctl_moved) = (moved(&w, &before), moved(&ctl, &ctl_before));
            assert!(
                ctl_moved > 0,
                "{scale:?}: control: none of {} crates moved in {steps} steps at \
                 standard gravity, so \"nothing moved in space\" rules nothing out",
                ctl.len()
            );
            // The pin, on its own line where nothing beside it can cancel it.
            assert_eq!(
                GravityMode::Space.scale(),
                0.0,
                "{scale:?}: space is no longer a scale of zero, so the effect \
                 assertion below would blame the stepper for a changed constant \
                 — see `constants.rs::every_gravity_mode_has_a_multiplier`"
            );
            // The effect, with `ctl_moved > 0` above as its presence control.
            assert_eq!(
                space_moved,
                0,
                "{scale:?}: {space_moved} of {} crates moved in {steps} steps while \
                 `GravityMode::Space.scale()` is zero — R14 says a non-player body \
                 floats where it is put, and `Forces::falling` at \
                 `items/world.rs::WorldItems::step` is the one place that is decided",
                w.len()
            );
            // And wherever they ended up, they are still in the arena.
            for it in w.iter() {
                assert!(
                    geo.inside(it.pos.x, it.pos.y),
                    "{scale:?}: a crate left the rim while stepping, at {:?}",
                    it.pos
                );
            }
        }
    }

    /// **R14: the round's items start inside the arena too**, clear of the
    /// spawn points, and not inside a rock.
    ///
    /// The old behaviour is the falsification and it is checked rather than
    /// recalled: before `T22.05B` filtered the surface, `place_initial` drew
    /// from `map.meta.surface_points`, of which the majority were the
    /// full-width floor crust at `y = h - FLOOR_CRUST - 1` — outside the rim.
    /// So the first assertion is that that row is outside, and the rest is
    /// that no item is on it.
    #[test]
    fn initial_items_land_inside_the_arena_in_space() {
        for scale in MapScale::ALL {
            let map = crate::map::generate_with(31337, scale, MapGenerator::Space);
            let geo = map.space_geometry().expect("a space map");
            let crust = (map.mask.h as i32 - FLOOR_CRUST as i32 - 1) as f32;
            assert!(
                !geo.inside((map.mask.w / 2) as f32, crust),
                "{scale:?}: the floor crust is inside the rim, so this test proves nothing"
            );

            let mut w = WorldItems::new();
            place_initial(&mut w, &map, 31337, 0.0);
            assert_eq!(
                w.len() as u32,
                scale.params().initial_items,
                "{scale:?}: wrong item count"
            );
            for it in w.iter() {
                assert!(
                    geo.inside(it.pos.x, it.pos.y),
                    "{scale:?}: an item spawned at {:?}, outside the rim",
                    it.pos
                );
                assert_ne!(it.pos.y, crust, "{scale:?}: an item is on the void crust");
                // **T22.05C/F3: open space, not merely inside the rim.**
                // "Inside" is satisfied by a surface point too — measured:
                // planting `Map::random_body_site`'s space arm to draw from
                // `map.meta.surface_points` left this test green, because every
                // filtered surface point is inside the rim by construction and
                // none is on the crust line. `body_fits_at` is the predicate
                // that names the subject, and the disjointness control below
                // (`the_two_pools_a_space_map_has_are_disjoint`) is what makes
                // it discriminate rather than restate.
                assert!(
                    map.body_fits_at(Point::new(it.pos.x as i32, it.pos.y as i32)),
                    "{scale:?}: item at {:?} is not open space — `random_body_site` \
                     returned a surface point",
                    it.pos
                );
                for sp in &map.meta.spawn_points {
                    let d = (it.pos - Vec2::new(sp.x as f32, sp.y as f32))
                        .len_sq()
                        .sqrt();
                    assert!(
                        d >= INITIAL_SPAWN_EXCLUSION,
                        "{scale:?}: an item is {d:.0} px from a spawn point"
                    );
                }
            }
        }
    }

    /// The periodic spawns follow the same rule, over a whole round's worth.
    ///
    /// **The schedule's two stages are counted separately** (`T22.05D`, from
    /// `R57`), and that — not another assertion inside the loop — is what was
    /// actually wrong here. `T22.05C` added a `body_fits_at` assertion to the
    /// item loop to replace an unhelpful message. Measured: it cannot run.
    /// Plant `Map::random_body_site`'s space arm to draw from
    /// `map.meta.surface_points` and `resample_surface` rejects every draw at
    /// its own `body_fits_at` re-check — which is exactly what
    /// `the_two_pools_a_space_map_has_are_disjoint` below proves it must — so
    /// nothing spawns, the loop body never executes, and the test died on
    /// `seen > 0` saying "no periodic items spawned at all". True, and the
    /// wrong subject. **The defect was always the guard's message.**
    ///
    /// So `fired` counts stage one — the tick was due and `next_item_at`
    /// advanced — and `seen` counts stage two, a draw that survived
    /// `resample_surface` and became an item. Each has its own guard, so
    /// *"every draw was rejected"* and *"the deadline never advanced"* are
    /// different failures with different text — measured, both ways: the first
    /// plant above turns the second guard red at `fired == 40`, and dropping
    /// `tick_items`' `next_item_at += ITEM_SPAWN_INTERVAL` turns the *first*
    /// one red while items still spawn, which is what says `fired` reads the
    /// cadence rather than mirroring `seen`. Deliberately **not** measured by calling
    /// `resample_surface` here: that would restate the function under test
    /// instead of observing the schedule, which is the same defect respelled.
    ///
    /// Its sibling `initial_items_land_inside_the_arena_in_space` needs none of
    /// this — `place_initial` has no `body_fits_at` re-check, so under the same
    /// plant the point is placed and the in-loop assertion does fire.
    #[test]
    fn periodic_items_land_inside_the_arena_in_space() {
        let map = crate::map::generate_with(4242, MapScale::Medium, MapGenerator::Space);
        let geo = map.space_geometry().expect("a space map");
        let mut w = WorldItems::new();
        let mut s = SpawnSchedule::new(4242, 0.0, 0);
        let mut seen = 0usize;
        let mut fired = 0usize;
        for i in 1..=40 {
            let deadline = s.next_item_at();
            let ids = s.tick_items(&mut w, &map, &[], ITEM_SPAWN_INTERVAL * i as f32);
            // Stage one, read off the schedule's own deadline rather than off
            // what came back: the batch loop runs only after this moves.
            if s.next_item_at() > deadline {
                fired += 1;
            }
            for id in ids {
                let it = w.get(id).expect("there");
                seen += 1;
                assert!(
                    geo.inside(it.pos.x, it.pos.y),
                    "a periodic item spawned at {:?}, outside the rim",
                    it.pos
                );
                // T22.05C/F3: open space, not merely inside the rim. Reachable
                // only when stage two produced something — hence the two guards
                // below, which say so when it did not.
                assert!(
                    map.body_fits_at(Point::new(it.pos.x as i32, it.pos.y as i32)),
                    "a periodic item at {:?} is not open space",
                    it.pos
                );
            }
        }
        assert!(
            fired > 0,
            "the schedule's deadline never advanced across 40 intervals of \
             `ITEM_SPAWN_INTERVAL`: `fired` is read off `next_item_at`, so this \
             is a cadence failure in `tick_items` and not a placement failure in \
             `resample_surface` — the guard below is the one that reports those"
        );
        assert!(
            seen > 0,
            "the schedule fired {fired} times and placed nothing: every draw was \
             rejected inside `resample_surface`, at `random_body_site` returning \
             `None` or at the `body_fits_at` re-check just after it. This is not \
             \"the deadline never advanced\" — that is the guard above"
        );
        println!("{seen} periodic items over {fired} firings, all inside the rim");
    }

    /// **T22.05C/F3's control: the two pools a space map has are disjoint.**
    ///
    /// The `body_fits_at` assertions in the two tests above are only worth
    /// writing if a surface point *fails* that predicate — otherwise they
    /// restate "inside the rim" in a second vocabulary and rule nothing out.
    /// So assert the separation once, here, rather than per item.
    ///
    /// Every surface point on a space map is either on an asteroid top or on
    /// the rim's inner face, and `space::is_open_space` refuses both: a rock
    /// within `a.r + PLAYER_H` of its centre, and the rim within
    /// `thickness * 0.5 + body_h` of the centreline. **This test is the thing
    /// that reports either clearance being loosened** — the F3 assertions go
    /// vacuous silently, this one goes red and says why.
    ///
    /// The non-empty check is its own falsification: a generator that shipped
    /// no surface points would satisfy `all(..)` for free.
    #[test]
    fn the_two_pools_a_space_map_has_are_disjoint() {
        for scale in MapScale::ALL {
            for seed in [1u64, 4242, 31337] {
                let map = crate::map::generate_with(seed, scale, MapGenerator::Space);
                assert!(
                    !map.meta.surface_points.is_empty(),
                    "{scale:?}/{seed}: no surface points, so this proves nothing"
                );
                let overlap: Vec<Point> = map
                    .meta
                    .surface_points
                    .iter()
                    .copied()
                    .filter(|p| map.body_fits_at(*p))
                    .collect();
                assert!(
                    overlap.is_empty(),
                    "{scale:?}/{seed}: {} of {} surface points pass `body_fits_at` \
                     (e.g. {:?}), so asserting it on an item rules nothing out",
                    overlap.len(),
                    map.meta.surface_points.len(),
                    overlap.first()
                );
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
            // T22.11A: `WorldItems::step` now takes the match's gravity mode
            // (`M22-RULINGS` R30/R14). Arity only, at a test call site.
            w.step(&map, GravityMode::Standard, SIM_DT);
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
            // T22.11A: arity only, at a test call site. See above.
            w.step(&map, GravityMode::Standard, SIM_DT);
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
            // T22.11A: arity only, at a test call site. See above.
            w.step(&map, GravityMode::Standard, SIM_DT);
        }
        let it = w.get(ids[0]).expect("there");
        assert!(it.grounded, "the revealed item never settled");
        assert!(it.pos.y >= start, "it should fall, not rise");
    }
}
