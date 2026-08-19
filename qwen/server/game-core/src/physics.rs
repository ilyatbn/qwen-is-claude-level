//! `physics` — terrain colliders and the rapier world (docs/00 §5, docs/01 §6).
//!
//! ## Division of responsibility (DEVIATIONS.md D2)
//!
//! T2.6 says to drive players with `world.integrate_forces`, which is not a
//! rapier API, and the exact-value assertions in T2.3–T2.5 (`Δx == 70 px` over
//! 10 ticks, apex 58–63 px, fuel exact to 0.01) are not reproducible through a
//! constraint solver. So:
//!
//! - **Movement is the pure step functions'** (`player::step_*`). They own the
//!   documented numbers and their tests.
//! - **Rapier resolves collisions** against terrain colliders only.
//! - **Ground detection is the 2 px tile probe**, which T2.6 step 3 itself
//!   mandates as "deterministic, doc §4".

use crate::map::Map;
use crate::tiles::TileDestroyed;
use crate::tiles::TILE_SIZE;

/// One horizontal run of solid tiles in a row (docs/01 §6).
///
/// "Solid tiles merged into horizontal AABB segments: scan each row, group
/// consecutive solid tiles into segments; one rapier fixed collider per
/// segment."
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Segment {
    pub row: u32,
    /// First solid tile column, inclusive.
    pub start_x: u32,
    /// Last solid tile column, inclusive.
    pub end_x: u32,
}

impl Segment {
    /// Tile count in this run.
    pub fn len(&self) -> u32 {
        self.end_x - self.start_x + 1
    }

    pub fn is_empty(&self) -> bool {
        false
    }

    /// Half-extents in pixels (docs/01 §6: "half-extents from segment length ×
    /// 16 px").
    pub fn half_extents(&self) -> (f32, f32) {
        (self.len() as f32 * TILE_SIZE / 2.0, TILE_SIZE / 2.0)
    }

    /// Centre of the segment's AABB, in pixels.
    pub fn centre(&self) -> (f32, f32) {
        let x = (self.start_x as f32 + self.len() as f32 / 2.0) * TILE_SIZE;
        let y = (self.row as f32 + 0.5) * TILE_SIZE;
        (x, y)
    }
}

/// Collect the horizontal solid runs of one row (docs/01 §6).
pub fn row_segments(map: &Map, row: u32) -> Vec<Segment> {
    let mut segments = Vec::new();
    let mut start: Option<u32> = None;

    for x in 0..map.width {
        if map.is_solid(x, row) {
            start.get_or_insert(x);
        } else if let Some(s) = start.take() {
            segments.push(Segment {
                row,
                start_x: s,
                end_x: x - 1,
            });
        }
    }
    // A run reaching the right edge is closed here.
    if let Some(s) = start {
        segments.push(Segment {
            row,
            start_x: s,
            end_x: map.width - 1,
        });
    }
    segments
}

/// Every terrain segment in the map, row by row (docs/01 §6).
pub fn all_segments(map: &Map) -> Vec<Segment> {
    (0..map.height).flat_map(|row| row_segments(map, row)).collect()
}

// ---------------------------------------------------------------------------
// Rapier world (T2.6)
// ---------------------------------------------------------------------------

use crate::player::player_config::{BODY_HALF_HEIGHT, BODY_HALF_WIDTH};
use crate::Vec2;
use rapier2d::control::{CharacterLength, KinematicCharacterController};
use rapier2d::prelude::*;

/// Terrain colliders plus rapier's kinematic character controller.
///
/// Rapier's role here is **collision resolution only** (D2). The pure step
/// functions in `player` produce a desired translation for the tick; this
/// resolves that translation against the terrain and reports what actually
/// happened. No rigid-body dynamics, no solver, no gravity — those live in the
/// pure path, where the documented numbers are reproducible.
///
/// Because no dynamics run, the world is in **pixels** rather than rapier's
/// usual metres: there is no mass, force or restitution tuning that a unit
/// scale would affect, and pixels keep the geometry identical to the tile grid.
pub struct PhysicsWorld {
    bodies: RigidBodySet,
    colliders: ColliderSet,
    broad_phase: BroadPhaseBvh,
    narrow_phase: NarrowPhase,
    controller: KinematicCharacterController,
    /// Collider handle per terrain segment, so rebuilds can remove them
    /// row by row (T2.7).
    segment_handles: Vec<(Segment, ColliderHandle)>,
    /// Colliders removed since the last `refresh`, which the broad phase must
    /// be told about explicitly.
    pending_removals: Vec<ColliderHandle>,
    /// Rows recomputed by the most recent [`PhysicsWorld::rebuild_segments`].
    ///
    /// Exists so tests can observe the WORK DONE, not just the result. T2.7
    /// step 2 requires that only affected rows are touched, and comparing
    /// resulting segments cannot show that — rebuilding every row produces
    /// identical segments. Found by injection.
    last_rebuild_rows: usize,
}

/// What one resolved move did.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct MoveResult {
    /// The translation actually applied after collision resolution.
    pub translation: Vec2,
    /// Whether rapier considers the character grounded after the move.
    ///
    /// Advisory only: ground detection for gameplay is the 2 px tile probe
    /// (docs/03 §4, T2.6 step 3 — "deterministic, doc §4").
    pub grounded: bool,
}

impl PhysicsWorld {
    /// Build a world from a map's terrain (docs/01 §6, T2.3 step 1).
    pub fn new(map: &Map) -> Self {
        let mut world = PhysicsWorld {
            bodies: RigidBodySet::new(),
            colliders: ColliderSet::new(),
            broad_phase: BroadPhaseBvh::new(),
            narrow_phase: NarrowPhase::new(),
            controller: KinematicCharacterController {
                // y grows downward in this world, so "up" is -y.
                up: Vector::new(0.0, -1.0),
                offset: CharacterLength::Absolute(0.01),
                slide: true,
                // Autostep and snap-to-ground are deliberately off: movement is
                // the pure path's business, and either would silently move the
                // player in ways the documented numbers do not describe.
                autostep: None,
                snap_to_ground: None,
                ..KinematicCharacterController::default()
            },
            segment_handles: Vec::new(),
            pending_removals: Vec::new(),
            last_rebuild_rows: 0,
        };
        world.insert_segments(&all_segments(map));
        world.refresh();
        world
    }

    /// Insert one fixed collider per segment (docs/01 §6).
    fn insert_segments(&mut self, segments: &[Segment]) {
        for &segment in segments {
            let (hx, hy) = segment.half_extents();
            let (cx, cy) = segment.centre();
            let body = self
                .bodies
                .insert(RigidBodyBuilder::fixed().translation(Vector::new(cx, cy)));
            let handle = self.colliders.insert_with_parent(
                ColliderBuilder::cuboid(hx, hy),
                body,
                &mut self.bodies,
            );
            self.segment_handles.push((segment, handle));
        }
    }

    /// Rebuild the broad-phase acceleration structure after colliders change.
    fn refresh(&mut self) {
        // Signature: (params, colliders, bodies, modified, removed, events).
        // Every collider is treated as modified because rebuilds insert and
        // remove them wholesale (T2.7); the map is static between rebuilds.
        let modified: Vec<ColliderHandle> =
            self.segment_handles.iter().map(|(_, h)| *h).collect();
        let mut events = Vec::new();
        self.broad_phase.update(
            &IntegrationParameters::default(),
            &self.colliders,
            &self.bodies,
            &modified,
            &self.pending_removals,
            &mut events,
        );
        self.pending_removals.clear();
    }

    /// How many rows the most recent rebuild recomputed (T2.7 step 2).
    pub fn last_rebuild_rows(&self) -> usize {
        self.last_rebuild_rows
    }

    /// Number of terrain colliders currently in the world.
    pub fn collider_count(&self) -> usize {
        self.segment_handles.len()
    }

    /// The segments currently backing colliders (T2.7 asserts on these).
    pub fn segments(&self) -> impl Iterator<Item = Segment> + '_ {
        self.segment_handles.iter().map(|(s, _)| *s)
    }

    /// Rebuild colliders for the rows touched by a batch of destructions
    /// (T2.7, docs/01 §6).
    ///
    /// "physics rebuilds only segments that contained any destroyed tile
    /// (recompute contiguous run, remove old collider, insert new ones)."
    ///
    /// Rows are the unit of work: a destroyed tile can split one run into two
    /// or shorten it, and both are recomputed from the map rather than patched.
    /// Rows with no destroyed tile are not touched at all — asserted by
    /// `rebuild_touches_only_affected_rows`.
    pub fn rebuild_segments(&mut self, map: &Map, destroyed: &[TileDestroyed]) {
        if destroyed.is_empty() {
            self.last_rebuild_rows = 0;
            return;
        }

        // Distinct affected rows, sorted — a BTreeSet rather than a HashSet so
        // iteration order is deterministic (docs/00 §2).
        let rows: std::collections::BTreeSet<u32> =
            destroyed.iter().map(|t| t.y).collect();

        // Drop every collider on an affected row.
        let mut kept = Vec::with_capacity(self.segment_handles.len());
        for (segment, handle) in std::mem::take(&mut self.segment_handles) {
            if rows.contains(&segment.row) {
                if let Some(collider) = self.colliders.get(handle) {
                    if let Some(body) = collider.parent() {
                        self.bodies.remove(
                            body,
                            &mut IslandManager::default(),
                            &mut self.colliders,
                            &mut ImpulseJointSet::new(),
                            &mut MultibodyJointSet::new(),
                            true,
                        );
                    }
                }
                self.pending_removals.push(handle);
            } else {
                kept.push((segment, handle));
            }
        }
        self.segment_handles = kept;

        // Recompute those rows from the map and insert the new runs.
        let fresh: Vec<Segment> = rows.iter().flat_map(|&row| row_segments(map, row)).collect();
        self.insert_segments(&fresh);
        self.last_rebuild_rows = rows.len();
        self.refresh();
    }

    /// Move a player body by `desired`, resolved against terrain (T2.6 step 2).
    ///
    /// This is swept: rapier shape-casts the translation rather than teleporting
    /// and testing, so a fast-moving body cannot pass through a thin floor.
    pub fn move_player(&self, centre: Vec2, desired: Vec2, dt: f32) -> MoveResult {
        let query_pipeline = self.broad_phase.as_query_pipeline(
            self.narrow_phase.query_dispatcher(),
            &self.bodies,
            &self.colliders,
            QueryFilter::default(),
        );
        let shape = Cuboid::new(Vector::new(BODY_HALF_WIDTH, BODY_HALF_HEIGHT));
        let pose = Pose::from_translation(Vector::new(centre.x, centre.y));

        let movement = self.controller.move_shape(
            dt,
            &query_pipeline,
            &shape,
            &pose,
            Vector::new(desired.x, desired.y),
            |_| {},
        );

        MoveResult {
            translation: Vec2::new(movement.translation.x, movement.translation.y),
            grounded: movement.grounded,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::map::Scale;
    use crate::tiles::{Tile, TileKind};

    fn blank(scale: Scale) -> Map {
        let (width, height) = scale.dimensions();
        Map {
            seed: 0,
            scale,
            width,
            height,
            tiles: vec![Tile::AIR; (width * height) as usize],
            decor: Vec::new(),
            spawns: Vec::new(),
            version: 0,
        }
    }

    #[test]
    fn row_segments_merges_consecutive_solid_tiles() {
        // docs/01 §6.
        let mut map = blank(Scale::Small);
        for x in 3..=7 {
            map.set_tile(x, 10, Tile::new(TileKind::Stone));
        }
        for x in 20..=21 {
            map.set_tile(x, 10, Tile::new(TileKind::Dirt));
        }
        let segments = row_segments(&map, 10);
        assert_eq!(
            segments,
            vec![
                Segment { row: 10, start_x: 3, end_x: 7 },
                Segment { row: 10, start_x: 20, end_x: 21 },
            ],
        );
        assert_eq!(segments[0].len(), 5);
    }

    #[test]
    fn a_gap_of_one_tile_splits_a_segment() {
        // The case that matters after a blast: one destroyed tile must break
        // the run, or the player walks on air.
        let mut map = blank(Scale::Small);
        for x in 0..10 {
            map.set_tile(x, 5, Tile::new(TileKind::Stone));
        }
        assert_eq!(row_segments(&map, 5).len(), 1);
        map.destroy_tile(4, 5);
        assert_eq!(
            row_segments(&map, 5),
            vec![
                Segment { row: 5, start_x: 0, end_x: 3 },
                Segment { row: 5, start_x: 5, end_x: 9 },
            ],
        );
    }

    #[test]
    fn a_run_reaching_the_right_edge_is_closed() {
        // Off-by-one guard: the loop closes runs when it sees AIR, so a run
        // ending at the last column needs explicit handling.
        let mut map = blank(Scale::Small);
        let last = map.width - 1;
        for x in (last - 3)..=last {
            map.set_tile(x, 7, Tile::new(TileKind::Stone));
        }
        assert_eq!(
            row_segments(&map, 7),
            vec![Segment { row: 7, start_x: last - 3, end_x: last }],
        );
    }

    #[test]
    fn an_empty_row_has_no_segments() {
        let map = blank(Scale::Small);
        assert!(row_segments(&map, 0).is_empty());
    }

    #[test]
    fn segment_geometry_matches_tile_bounds() {
        // docs/01 §6: half-extents from segment length x 16 px.
        let seg = Segment { row: 2, start_x: 4, end_x: 7 };
        assert_eq!(seg.len(), 4);
        assert_eq!(seg.half_extents(), (32.0, 8.0));
        // Centre must sit at the middle of tiles 4..=7 => x 64..128 -> 96.
        assert_eq!(seg.centre(), (96.0, 40.0));
        let (hx, hy) = seg.half_extents();
        let (cx, cy) = seg.centre();
        assert_eq!(cx - hx, 4.0 * TILE_SIZE, "left edge is the first tile's left");
        assert_eq!(cx + hx, 8.0 * TILE_SIZE, "right edge is the last tile's right");
        assert_eq!(cy - hy, 2.0 * TILE_SIZE);
    }

    #[test]
    fn all_segments_covers_every_solid_tile_exactly_once() {
        // The invariant that makes collider rebuild safe: segments partition
        // the solid tiles — no gaps, no double cover.
        let map = Map::generate(3, Scale::Small);
        let mut covered = vec![0u8; (map.width * map.height) as usize];
        for seg in all_segments(&map) {
            for x in seg.start_x..=seg.end_x {
                covered[(seg.row * map.width + x) as usize] += 1;
            }
        }
        for y in 0..map.height {
            for x in 0..map.width {
                let n = covered[(y * map.width + x) as usize];
                let solid = map.is_solid(x, y);
                assert_eq!(
                    n,
                    u8::from(solid),
                    "tile ({x},{y}) solid={solid} covered {n} times",
                );
            }
        }
    }
}

/// T2.6 rapier-integration tests.
#[cfg(test)]
mod rapier_tests {
    use super::*;
    use crate::map::Scale;
    use crate::player::player_config::*;
    use crate::player::{InputEdges, Player, DT};
    use crate::protocol::InputFrame;
    use crate::tiles::{Tile, TileKind};
    use crate::Vec2;

    fn flat_map(floor_row: u32) -> Map {
        let (width, height) = Scale::Small.dimensions();
        let mut map = Map {
            seed: 0,
            scale: Scale::Small,
            width,
            height,
            tiles: vec![Tile::AIR; (width * height) as usize],
            decor: Vec::new(),
            spawns: Vec::new(),
            version: 0,
        };
        for y in floor_row..height {
            for x in 0..width {
                map.set_tile(x, y, Tile::new(TileKind::Stone));
            }
        }
        map
    }

    /// Run one production tick. Calls `Player::step_tick`, the same path
    /// `round.rs` uses — these tests must not have their own physics.
    fn tick(player: &mut Player, world: &PhysicsWorld, map: &Map, jump_held: bool) {
        let frame = InputFrame {
            jump: jump_held,
            ..InputFrame::default()
        };
        player.step_tick(world, map, &frame, InputEdges::default(), DT);
    }

    #[test]
    fn player_falls_and_lands() {
        // docs/08 §1 (physics row) + T2.6 step 4: "spawn 100 px above ground ->
        // within 2 s vel.y ≈ 0 and resting on surface (±1 px)".
        let floor_row = 40;
        let map = flat_map(floor_row);
        let world = PhysicsWorld::new(&map);
        let floor_top = floor_row as f32 * TILE_SIZE;

        let mut player = Player::new(
            0,
            "p".into(),
            Vec2::new(320.0, floor_top - BODY_HALF_HEIGHT - 100.0),
        );

        for _ in 0..40 {
            tick(&mut player, &world, &map, false);
        }

        assert!(
            player.vel.y.abs() < 1.0,
            "vel.y is {} after landing, expected ~0",
            player.vel.y,
        );
        let feet = player.feet_y();
        assert!(
            (feet - floor_top).abs() <= 1.0,
            "feet at {feet}, floor top is {floor_top} — not resting within 1 px",
        );
        assert!(player.on_ground(&map), "landed player is not on the ground");
    }

    #[test]
    fn player_does_not_sink_through_a_floor_it_rests_on() {
        // A resting player must stay put, not creep downward each tick.
        let floor_row = 40;
        let map = flat_map(floor_row);
        let world = PhysicsWorld::new(&map);
        let floor_top = floor_row as f32 * TILE_SIZE;
        let mut player = Player::new(
            0,
            "p".into(),
            Vec2::new(320.0, floor_top - BODY_HALF_HEIGHT),
        );

        for _ in 0..200 {
            tick(&mut player, &world, &map, false);
        }
        assert!(
            (player.feet_y() - floor_top).abs() <= 1.0,
            "player crept to {} over 200 ticks (floor {floor_top})",
            player.feet_y(),
        );
    }

    #[test]
    fn no_tunneling_at_terminal_velocity() {
        // T2.6 Acceptance, restated to be both satisfiable and meaningful.
        //
        // As written it says "terminal velocity cap 900 px/s — assert body
        // never moves > 45 px in one tick". Two problems (DEVIATIONS.md D29):
        // 900 * 0.05 = 45 EXACTLY, so the bound is at the boundary, and with
        // Verlet (required by D28) one tick is 46.125 px, so it is
        // unsatisfiable. And 45 px spans 2.9 tiles, so meeting it would not
        // prevent tunneling anyway.
        //
        // What is asserted instead: the property the acceptance was reaching
        // for — a body falling at terminal velocity does not pass through a
        // one-tile floor.
        let floor_row = 40;
        let map = flat_map(floor_row);
        let world = PhysicsWorld::new(&map);
        let floor_top = floor_row as f32 * TILE_SIZE;

        let mut player = Player::new(0, "p".into(), Vec2::new(320.0, 100.0));
        player.vel.y = TERMINAL_VELOCITY;

        let mut max_step = 0.0f32;
        for _ in 0..80 {
            let before = player.pos.y;
            tick(&mut player, &world, &map, false);
            max_step = max_step.max((player.pos.y - before).abs());
            assert!(
                player.feet_y() <= floor_top + 1.0,
                "player tunneled through the floor: feet at {}, floor {floor_top}",
                player.feet_y(),
            );
        }

        assert!(
            player.vel.y <= TERMINAL_VELOCITY + 1e-3,
            "fall speed exceeded the {TERMINAL_VELOCITY} px/s cap: {}",
            player.vel.y,
        );
        // The real per-tick bound under Verlet, for the record.
        assert!(
            max_step <= 46.2,
            "per-tick displacement {max_step} exceeded the Verlet bound 46.125",
        );
    }

    #[test]
    fn resting_player_does_not_accumulate_fall_velocity() {
        // The collision->velocity rule (D32), guarded.
        //
        // Without zeroing vel.y when terrain blocks the move, a player resting
        // on the ground gains GRAVITY*dt every tick forever. Position never
        // changes — collision keeps stopping it — so nothing looks wrong until
        // the ground is destroyed, at which point they are launched through
        // the map at whatever clamp_fall_speed permits.
        let floor_row = 40;
        let map = flat_map(floor_row);
        let world = PhysicsWorld::new(&map);
        let floor_top = floor_row as f32 * TILE_SIZE;
        let mut player = Player::new(
            0,
            "p".into(),
            Vec2::new(320.0, floor_top - BODY_HALF_HEIGHT),
        );

        for _ in 0..200 {
            tick(&mut player, &world, &map, false);
        }

        assert!(
            player.vel.y.abs() < 1.0,
            "resting player accumulated vel.y = {} over 200 ticks",
            player.vel.y,
        );
        assert!(
            player.vel.y < TERMINAL_VELOCITY * 0.5,
            "vel.y {} is heading for the terminal-velocity cap while standing still",
            player.vel.y,
        );
    }

    #[test]
    fn landing_reports_blocked_y_and_zeroes_velocity() {
        let floor_row = 40;
        let map = flat_map(floor_row);
        let world = PhysicsWorld::new(&map);
        let floor_top = floor_row as f32 * TILE_SIZE;
        let mut player = Player::new(
            0,
            "p".into(),
            Vec2::new(320.0, floor_top - BODY_HALF_HEIGHT - 100.0),
        );

        let mut saw_block = false;
        for _ in 0..40 {
            let frame = InputFrame::default();
            let outcome = player.step_tick(&world, &map, &frame, InputEdges::default(), DT);
            if outcome.blocked_y {
                saw_block = true;
                assert_eq!(player.vel.y, 0.0, "blocked_y did not zero vel.y");
            }
        }
        assert!(saw_block, "a 100 px fall never reported blocked_y");
    }

    #[test]
    fn player_falls_into_hole() {
        // T2.6 step 5: "destroy the 3 tiles under a player -> player falls".
        let floor_row = 40;
        let mut map = flat_map(floor_row);
        let floor_top = floor_row as f32 * TILE_SIZE;
        let col = 20u32;
        let mut player = Player::new(
            0,
            "p".into(),
            Vec2::new((col as f32 + 0.5) * TILE_SIZE, floor_top - BODY_HALF_HEIGHT),
        );

        let world = PhysicsWorld::new(&map);
        for _ in 0..5 {
            tick(&mut player, &world, &map, false);
        }
        let resting_y = player.pos.y;
        assert!(player.on_ground(&map));

        // Dig a shaft wide enough for the 24 px body, all the way down.
        for dx in -1i32..=1 {
            let x = (col as i32 + dx) as u32;
            for y in floor_row..map.height {
                map.destroy_tile_deferred(x, y);
            }
        }
        map.apply_surface_conversion();
        let world = PhysicsWorld::new(&map);

        for _ in 0..20 {
            tick(&mut player, &world, &map, false);
        }
        assert!(
            player.pos.y > resting_y + TILE_SIZE,
            "player did not fall into the hole: {} -> {}",
            resting_y,
            player.pos.y,
        );
    }

    #[test]
    fn horizontal_movement_is_blocked_by_a_wall() {
        // The other half of collision resolution: a body walking into terrain
        // must stop, not pass through.
        let floor_row = 40;
        let mut map = flat_map(floor_row);
        // A wall 3 tiles tall at column 25.
        for y in (floor_row - 3)..floor_row {
            map.set_tile(25, y, Tile::new(TileKind::Stone));
        }
        let world = PhysicsWorld::new(&map);
        let floor_top = floor_row as f32 * TILE_SIZE;
        let mut player = Player::new(
            0,
            "p".into(),
            Vec2::new(20.5 * TILE_SIZE, floor_top - BODY_HALF_HEIGHT),
        );

        for _ in 0..60 {
            let frame = InputFrame {
                right: true,
                ..InputFrame::default()
            };
            player.step_tick(&world, &map, &frame, InputEdges::default(), DT);
        }

        let wall_left = 25.0 * TILE_SIZE;
        assert!(
            player.pos.x + BODY_HALF_WIDTH <= wall_left + 1.0,
            "player at {} passed into the wall at {wall_left}",
            player.pos.x,
        );
    }

    #[test]
    fn world_has_one_collider_per_segment() {
        let map = Map::generate(1, Scale::Small);
        let world = PhysicsWorld::new(&map);
        assert_eq!(world.collider_count(), all_segments(&map).len());
        assert!(world.collider_count() > 0);
    }
}

/// T2.7 collider-rebuild tests.
#[cfg(test)]
mod rebuild_tests {
    use super::*;
    use crate::map::Scale;
    use crate::player::player_config::*;
    use crate::player::{InputEdges, Player, DT};
    use crate::protocol::InputFrame;
    use crate::tiles::{Tile, TileKind};
    use crate::Vec2;

    fn flat_map(floor_row: u32) -> Map {
        let (width, height) = Scale::Small.dimensions();
        let mut map = Map {
            seed: 0,
            scale: Scale::Small,
            width,
            height,
            tiles: vec![Tile::AIR; (width * height) as usize],
            decor: Vec::new(),
            spawns: Vec::new(),
            version: 0,
        };
        for y in floor_row..height {
            for x in 0..width {
                map.set_tile(x, y, Tile::new(TileKind::Stone));
            }
        }
        map
    }

    #[test]
    fn rebuild_splits_a_run_where_a_tile_was_destroyed() {
        let floor_row = 40;
        let mut map = flat_map(floor_row);
        let mut world = PhysicsWorld::new(&map);

        let before: Vec<Segment> = world.segments().filter(|s| s.row == floor_row).collect();
        assert_eq!(before.len(), 1, "a flat floor row is one run");

        let destroyed: Vec<_> = [30u32, 31].iter().filter_map(|&x| map.destroy_tile_deferred(x, floor_row)).collect();
        map.apply_surface_conversion();
        world.rebuild_segments(&map, &destroyed);

        let after: Vec<Segment> = world.segments().filter(|s| s.row == floor_row).collect();
        assert_eq!(after.len(), 2, "destroying a middle tile should split the run");
        assert_eq!(after[0].end_x, 29);
        assert_eq!(after[1].start_x, 32);
    }

    #[test]
    fn rebuild_touches_only_affected_rows() {
        // T2.7 step 2: "Only affected rows are touched (assert in a test:
        // collider count changes only for affected rows)".
        let floor_row = 40;
        let mut map = flat_map(floor_row);
        let mut world = PhysicsWorld::new(&map);

        let untouched_before: Vec<Segment> =
            world.segments().filter(|s| s.row != floor_row).collect();

        let destroyed: Vec<_> = (30..33u32)
            .filter_map(|x| map.destroy_tile_deferred(x, floor_row))
            .collect();
        map.apply_surface_conversion();
        world.rebuild_segments(&map, &destroyed);

        let untouched_after: Vec<Segment> =
            world.segments().filter(|s| s.row != floor_row).collect();
        assert_eq!(
            untouched_before, untouched_after,
            "rows without a destroyed tile must be left alone",
        );

        // Comparing segments is not enough: rebuilding EVERY row yields the
        // same segments, so the assertion above passes either way (found by
        // injection). Assert the work actually done.
        assert_eq!(
            world.last_rebuild_rows(),
            1,
            "destroying tiles in one row rebuilt {} rows",
            world.last_rebuild_rows(),
        );
        assert!(
            world.last_rebuild_rows() < map.height as usize,
            "rebuild touched the whole map",
        );
    }

    #[test]
    fn rebuild_scope_matches_the_distinct_destroyed_rows() {
        let floor_row = 40;
        let mut map = flat_map(floor_row);
        let mut world = PhysicsWorld::new(&map);

        // Destroy tiles across three distinct rows.
        let mut destroyed = Vec::new();
        for row in [floor_row, floor_row + 2, floor_row + 5] {
            if let Some(e) = map.destroy_tile_deferred(30, row) {
                destroyed.push(e);
            }
            // A second tile in the same row must not count twice.
            if let Some(e) = map.destroy_tile_deferred(31, row) {
                destroyed.push(e);
            }
        }
        map.apply_surface_conversion();
        world.rebuild_segments(&map, &destroyed);

        assert_eq!(destroyed.len(), 6, "expected 6 destroyed tiles");
        assert_eq!(
            world.last_rebuild_rows(),
            3,
            "6 tiles across 3 rows should rebuild exactly 3 rows",
        );
    }

    #[test]
    fn rebuild_keeps_colliders_matching_the_map() {
        // The invariant that matters: after any rebuild, the world's segments
        // are exactly what the map says they should be.
        let mut map = Map::generate(5, Scale::Small);
        let mut world = PhysicsWorld::new(&map);

        let centre = Map::tile_center(40, map.surface_row(40));
        let destroyed = map.apply_blast(centre.x, centre.y, 48.0, 500.0);
        assert!(!destroyed.is_empty());
        world.rebuild_segments(&map, &destroyed);

        let mut from_world: Vec<Segment> = world.segments().collect();
        let mut from_map = all_segments(&map);
        from_world.sort_by_key(|s| (s.row, s.start_x));
        from_map.sort_by_key(|s| (s.row, s.start_x));
        assert_eq!(from_world, from_map, "colliders drifted from the map");
    }

    #[test]
    fn blast_under_a_player_makes_them_fall() {
        // T2.7 step 3: "blast under a standing player -> player falls".
        let floor_row = 40;
        let mut map = flat_map(floor_row);
        let mut world = PhysicsWorld::new(&map);
        let floor_top = floor_row as f32 * TILE_SIZE;
        let col = 25u32;
        let mut player = Player::new(
            0,
            "p".into(),
            Vec2::new((col as f32 + 0.5) * TILE_SIZE, floor_top - BODY_HALF_HEIGHT),
        );

        // Production path — no test-local physics.
        let step = |player: &mut Player, world: &PhysicsWorld, map: &Map| {
            player.step_tick(
                world,
                map,
                &InputFrame::default(),
                InputEdges::default(),
                DT,
            );
        };

        for _ in 0..5 {
            step(&mut player, &world, &map);
        }
        let resting = player.pos.y;
        assert!(player.on_ground(&map));

        // Blow a hole through every row beneath the player.
        let mut destroyed = Vec::new();
        for dx in -1i32..=1 {
            let x = (col as i32 + dx) as u32;
            for y in floor_row..map.height {
                if let Some(e) = map.destroy_tile_deferred(x, y) {
                    destroyed.push(e);
                }
            }
        }
        map.apply_surface_conversion();
        world.rebuild_segments(&map, &destroyed);

        for _ in 0..20 {
            step(&mut player, &world, &map);
        }
        assert!(
            player.pos.y > resting + TILE_SIZE,
            "player did not fall after the ground was destroyed: {resting} -> {}",
            player.pos.y,
        );
    }

    #[test]
    fn blast_elsewhere_leaves_collider_count_unchanged() {
        // T2.7 step 3, second half.
        let floor_row = 40;
        let mut map = flat_map(floor_row);
        let mut world = PhysicsWorld::new(&map);
        let before = world.collider_count();

        // Destroy nothing (blast in open sky above the floor).
        let destroyed = map.apply_blast(320.0, 100.0, 48.0, 500.0);
        assert!(destroyed.is_empty(), "sky blast should destroy nothing");
        world.rebuild_segments(&map, &destroyed);

        assert_eq!(world.collider_count(), before);
    }

    #[test]
    fn rebuild_of_a_wide_row_is_fast() {
        // T2.7 Acceptance: "rebuild of a 160-wide row < 1 ms (assert < 5 ms)".
        // Wall-clock, but with a 5x documented margin — same call as D21.
        let floor_row = 60;
        let (width, height) = Scale::Medium.dimensions();
        let mut map = Map {
            seed: 0,
            scale: Scale::Medium,
            width,
            height,
            tiles: vec![Tile::AIR; (width * height) as usize],
            decor: Vec::new(),
            spawns: Vec::new(),
            version: 0,
        };
        for y in floor_row..height {
            for x in 0..width {
                map.set_tile(x, y, Tile::new(TileKind::Stone));
            }
        }
        assert_eq!(map.width, 160);
        let mut world = PhysicsWorld::new(&map);

        let destroyed: Vec<_> = (0..width)
            .step_by(3)
            .filter_map(|x| map.destroy_tile_deferred(x, floor_row))
            .collect();
        map.apply_surface_conversion();

        let start = std::time::Instant::now();
        world.rebuild_segments(&map, &destroyed);
        let elapsed = start.elapsed();

        assert!(
            elapsed.as_millis() < 5,
            "rebuilding a 160-wide row took {elapsed:?}, over the 5 ms bound",
        );
        println!("160-wide row rebuild: {elapsed:?} (doc target < 1 ms)");
    }

    #[test]
    fn rebuilding_with_no_destruction_is_a_noop() {
        let map = flat_map(40);
        let mut world = PhysicsWorld::new(&map);
        let before: Vec<Segment> = world.segments().collect();
        world.rebuild_segments(&map, &[]);
        let after: Vec<Segment> = world.segments().collect();
        assert_eq!(before, after);
    }
}
