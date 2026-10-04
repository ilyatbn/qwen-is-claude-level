//! T24.01 — **the durian tree**: a special spawn on classic-look maps, hung with durian grenades.
//!
//! The owner (2026-10-03): *"we'll add [the durian tree] as a special spawn on maps (not lava)."* Placement is part of
//! the map — seeded, chosen once at generation from the map's own `"durian_trees"` substream (so it moves no other
//! stream and no golden mask), carried by `MapMeta` and `map_init` — and the tree is **scenery**: it stamps nothing
//! into the mask, so bodies, rounds and blasts pass through it as they pass through grass. What it does in play is
//! hang fruit: [`fruit_at`] places each of its `DURIAN_FRUIT` slots, and `World` keeps them filled
//! (`world::durian`).
//!
//! **Where:** never on a space map, never on a volcanic one (*"not lava"* — the look is chosen from the seed before
//! this runs, `meta::world_look_for`). Islands and multilevel take trees like any classic map: a tree stands on a
//! surface point with its whole canopy box in air.

use crate::constants::{
    WorldLook, DURIAN_FRUIT, DURIAN_TREES, DURIAN_TREE_AIR, DURIAN_TREE_CLEARANCE, DURIAN_TREE_H,
    DURIAN_TREE_SPACING, DURIAN_TREE_W,
};
use crate::map::mask::Mask;
use crate::math::{Point, Vec2};
use crate::rng::{shuffle, substream};

/// One tree: its trunk's foot on the feet line, and whether it is drawn mirrored (which mirrors its fruit too).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
#[cfg_attr(feature = "serde", derive(serde::Serialize, serde::Deserialize))]
pub struct DurianTree {
    pub pos: Point,
    pub flip: bool,
}

/// Where each fruit hangs, world px from the trunk's foot (x right, y up as negative): under the canopy's lower
/// branches, the lowest within a walking body's reach (`DURIAN_PICKUP_REACH`), the others a hop higher. Mirrored with
/// the tree. The client draws the branches the fruit hang from at these same offsets (`durianTree.ts`).
pub const FRUIT_AT: [(f32, f32); DURIAN_FRUIT] = [(-40.0, -48.0), (34.0, -66.0), (-6.0, -88.0)];

/// Fruit `slot` of `tree`, world px.
pub fn fruit_at(tree: &DurianTree, slot: usize) -> Vec2 {
    let (dx, dy) = FRUIT_AT[slot % DURIAN_FRUIT];
    let dx = if tree.flip { -dx } else { dx };
    Vec2::new(tree.pos.x as f32 + dx, tree.pos.y as f32 + dy)
}

/// Sample spacing for the canopy's air test, px.
const AIR_STEP: i32 = 6;

/// Is the canopy box over a foot at `p` (`DURIAN_TREE_W` wide, `DURIAN_TREE_H` tall, its bottom 4 px above the feet
/// line so the trunk's own foot may touch rock) inside the map and at least `DURIAN_TREE_AIR` air?
pub fn canopy_clear(mask: &Mask, p: Point) -> bool {
    let (x0, x1) = (p.x - DURIAN_TREE_W / 2, p.x + DURIAN_TREE_W / 2);
    let (y0, y1) = (p.y - DURIAN_TREE_H, p.y - 4);
    if x0 < 0 || y0 < 0 || x1 >= mask.w as i32 || y1 >= mask.h as i32 {
        return false;
    }
    let (mut air, mut all) = (0u32, 0u32);
    for y in (y0..=y1).step_by(AIR_STEP as usize) {
        for x in (x0..=x1).step_by(AIR_STEP as usize) {
            all += 1;
            air += u32::from(!mask.get(x, y));
        }
    }
    all > 0 && air as f32 >= DURIAN_TREE_AIR * all as f32
}

/// Far enough from `q` on either axis (the furniture rule `meta::standing_furniture` uses for pads and platforms).
fn apart(p: Point, q: Point, d: i32) -> bool {
    (p.x - q.x).abs() >= d || (p.y - q.y).abs() >= d
}

/// The map's trees: up to `DURIAN_TREES` on surface points of the walkable set (`largest_component`), each with a
/// clear canopy, `DURIAN_TREE_CLEARANCE` from every spawn, gate and gun platform and `DURIAN_TREE_SPACING` from each
/// other. Candidates are shuffled by the map's `"durian_trees"` substream and taken first-fit, so the same seed
/// always grows the same trees and a map with no room grows fewer (down to none). Empty on space and on any look but
/// classic.
#[allow(clippy::too_many_arguments)]
pub fn choose_trees(
    mask: &Mask,
    surface: &[Point],
    largest_component: &[u32],
    furniture: &[Point],
    requested_seed: u64,
    look: WorldLook,
    space: bool,
) -> Vec<DurianTree> {
    if space || look != WorldLook::Classic {
        return Vec::new();
    }
    let mut rng = substream(requested_seed, "durian_trees");
    let mut order: Vec<u32> = largest_component.to_vec();
    shuffle(&mut rng, &mut order);
    let mut out: Vec<DurianTree> = Vec::new();
    for i in order {
        if out.len() >= DURIAN_TREES {
            break;
        }
        let Some(&p) = surface.get(i as usize) else {
            continue;
        };
        if !furniture
            .iter()
            .all(|&f| apart(p, f, DURIAN_TREE_CLEARANCE))
        {
            continue;
        }
        if !out.iter().all(|t| apart(p, t.pos, DURIAN_TREE_SPACING)) {
            continue;
        }
        if !canopy_clear(mask, p) {
            continue;
        }
        // The draw is made only for a tree that is kept, so a rejected candidate moves nothing after it.
        let flip = crate::rng::chance(&mut rng, 0.5);
        out.push(DurianTree { pos: p, flip });
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::constants::{MapGenerator, MapScale, MapShape, DEFAULT_MAP_GENERATOR};
    use crate::map::meta::generate_full_shaped;

    fn map(seed: u64, generator: MapGenerator, shape: MapShape) -> crate::map::Map {
        generate_full_shaped(seed, MapScale::Small, 0, generator, shape)
    }

    /// Same seed, same trees; classic maps grow them (most of them, over many seeds), volcanic and space never.
    /// The control for "never" is the classic half of the same sweep growing them — a placer that grew nothing would
    /// pass the volcanic half alone.
    #[test]
    fn trees_are_seeded_classic_only_and_never_in_space() {
        let (mut classic, mut with_trees, mut volcanic) = (0, 0, 0);
        for seed in 1u64..=24 {
            let m = map(seed, DEFAULT_MAP_GENERATOR, MapShape::Random);
            let again = map(seed, DEFAULT_MAP_GENERATOR, MapShape::Random);
            assert_eq!(
                m.meta.durian_trees, again.meta.durian_trees,
                "seed {seed}: same seed, other trees"
            );
            assert!(
                m.meta.durian_trees.len() <= DURIAN_TREES,
                "seed {seed}: too many trees"
            );
            match m.meta.look {
                WorldLook::Classic => {
                    classic += 1;
                    with_trees += usize::from(!m.meta.durian_trees.is_empty());
                }
                _ => {
                    volcanic += 1;
                    assert!(
                        m.meta.durian_trees.is_empty(),
                        "seed {seed}: a tree on a volcanic map"
                    );
                }
            }
            let space = map(seed, MapGenerator::Space, MapShape::Random);
            assert!(
                space.meta.durian_trees.is_empty(),
                "seed {seed}: a tree in space"
            );
        }
        assert!(
            classic >= 6 && volcanic >= 6,
            "the sweep needs both looks: {classic} classic, {volcanic} volcanic"
        );
        assert!(
            with_trees * 4 >= classic * 3,
            "only {with_trees} of {classic} classic maps grew a tree"
        );
    }

    /// Every tree stands where the rule says: on a walkable surface point, canopy in air, apart from the furniture and
    /// each other. Over the shapes too (islands and multilevel are classic maps like any other).
    #[test]
    fn every_tree_stands_on_the_surface_with_a_clear_canopy_apart_from_the_furniture() {
        let mut n = 0;
        for shape in [
            MapShape::Random,
            MapShape::Hill,
            MapShape::Islands,
            MapShape::Multilevel,
        ] {
            for seed in 1u64..=10 {
                let m = map(seed, DEFAULT_MAP_GENERATOR, shape);
                let meta = &m.meta;
                let walk: Vec<Point> = meta
                    .largest_component
                    .iter()
                    .map(|&i| meta.surface_points[i as usize])
                    .collect();
                let mut furniture: Vec<Point> = meta.spawn_points.clone();
                furniture.extend(meta.teleport_pads.iter().map(|p| p.pos));
                furniture.extend(meta.gun_platforms.iter().map(|g| g.pos));
                for (k, t) in meta.durian_trees.iter().enumerate() {
                    n += 1;
                    assert!(
                        walk.contains(&t.pos),
                        "{shape:?} {seed}: tree {k} is not on the walkable surface"
                    );
                    assert!(
                        canopy_clear(&m.mask, t.pos),
                        "{shape:?} {seed}: tree {k}'s canopy is in rock"
                    );
                    for f in &furniture {
                        assert!(
                            apart(t.pos, *f, DURIAN_TREE_CLEARANCE),
                            "{shape:?} {seed}: tree {k} on furniture at {f:?}"
                        );
                    }
                    for u in &meta.durian_trees[..k] {
                        assert!(
                            apart(t.pos, u.pos, DURIAN_TREE_SPACING),
                            "{shape:?} {seed}: trees {k} and an earlier one too close"
                        );
                    }
                }
            }
        }
        assert!(
            n >= 10,
            "only {n} trees over 40 maps — the assertions above checked almost nothing"
        );
    }

    /// The canopy test refuses rock: a solid map has no clear canopy anywhere, an empty one has it everywhere inside.
    #[test]
    fn canopy_clear_refuses_rock_and_the_map_edge() {
        let m = Mask::new_empty(512, 512);
        let p = Point { x: 256, y: 400 };
        assert!(canopy_clear(&m, p), "control: an empty map has room");
        assert!(
            !canopy_clear(&m, Point { x: 10, y: 400 }),
            "a canopy past the left edge"
        );
        assert!(
            !canopy_clear(&Mask::new_full(512, 512), p),
            "a canopy inside rock"
        );
    }

    /// Fruit hang under the canopy, mirrored with the tree, the lowest within a walking body's reach.
    #[test]
    fn fruit_hang_under_the_canopy_and_mirror_with_the_tree() {
        use crate::constants::{DURIAN_PICKUP_REACH, PLAYER_H};
        let t = DurianTree {
            pos: Point { x: 500, y: 400 },
            flip: false,
        };
        let f = DurianTree { flip: true, ..t };
        for s in 0..DURIAN_FRUIT {
            let (a, b) = (fruit_at(&t, s), fruit_at(&f, s));
            assert_eq!(a.y, b.y);
            assert_eq!(a.x - 500.0, 500.0 - b.x, "slot {s} is not mirrored");
            assert!(
                a.y < 400.0 && a.y > 400.0 - DURIAN_TREE_H as f32,
                "slot {s} is not under the canopy"
            );
            assert!(
                (a.x - 500.0).abs() < DURIAN_TREE_W as f32 / 2.0,
                "slot {s} is outside the canopy"
            );
        }
        let lowest = (0..DURIAN_FRUIT)
            .map(|s| fruit_at(&t, s).y)
            .fold(f32::MIN, f32::max);
        let walking_centre = 400.0 - PLAYER_H / 2.0;
        assert!(
            walking_centre - lowest <= DURIAN_PICKUP_REACH,
            "the lowest fruit is out of a walking body's reach"
        );
    }
}
