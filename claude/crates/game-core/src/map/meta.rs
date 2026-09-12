//! Pass 8: buried slots, decorations, `MapMeta`, and the complete [`Map`].
//!
//! [`generate`] is the whole pipeline and the only entry point the server and the
//! WASM bridge need.
//!
//! See `docs/10-map-generation.md` §1.4, §Pass 8.

use crate::constants::{
    MapGenerator, MapScale, BURIED_ATTEMPTS, BURIED_CLEARANCE, BURIED_OFFSET_MAX,
    BURIED_OFFSET_MIN, BURIED_SEPARATION, GUN_PLATFORMS, GUN_PLATFORM_H,
    GUN_PLATFORM_PAD_CLEARANCE, GUN_PLATFORM_SPAWN_CLEARANCE, GUN_PLATFORM_W, PAD_H, PAD_W,
    TELEPORT_PADS, WIND_MAX,
};
use crate::map::gen::components::SealedPocket;
use crate::map::gen::objects::{clear_of_objects, PlacedObject, WhenStarved};
use crate::map::gen::{
    generate_terrain_with,
    spawns::{choose_separated, choose_spawns},
};
use crate::map::{CoarseGrid, Mask};
use crate::math::Point;
use crate::rng::{range_f32, range_i32, substream, ChaCha8Rng};

/// Roughly one decoration per this many surface points.
const DECOR_PER_SURFACE: usize = 10;
const DECOR_MAX: usize = 200;
/// Decoration kinds available per theme.
const DECOR_KINDS: u16 = 6;

pub const THEME_COUNT: u8 = 3;

/// The theme a requested seed rolls.
///
/// Shared, not copied: pass 6b needs it *before* pass 8 runs (§D5 weights the
/// object categories by theme), and a second copy of this line would drift the
/// first time either moved. It keys off `requested_seed` rather than the attempt
/// seed, so a map that retried still gets scenery matching its own terrain.
pub fn theme_for(requested_seed: u64) -> u8 {
    (substream(requested_seed, "theme").next_u64_compat() % THEME_COUNT as u64) as u8
}

/// An indestructible standing spot (`docs/72-amendments-v4.md` §C5).
///
/// ## A pad is a **protected region of terrain**, not rock added to the mask
///
/// `pos` is a surface point — a feet line — so the ground holding it up is the
/// row *below*, and [`TeleportPad::rect`] is those `PAD_H` rows across `PAD_W`
/// columns. `carve_circle` refuses to clear anything inside that rect.
///
/// That is enough to make the guarantee §C5 wants, and the argument is worth
/// writing down because it is the whole reason pads exist:
///
/// - `is_standable` needs the body box above `pos` to be air, the row at `pos.y +
///   1` to hold at least `MIN_SUPPORT_PX` solid pixels *within the body width*,
///   and head clearance straight up.
/// - Carving only ever removes pixels, so the air conditions can never be
///   falsified by destruction.
/// - The support row within the body box (16 px, centred) lies wholly inside the
///   pad rect (40 px, centred), so destruction cannot falsify it either.
///
/// So a pad that is standable at generation is standable for the whole round,
/// however much of the map is destroyed — which is what makes §C15's diggable
/// floor survivable.
///
/// **Stamping solid rock instead would change every generated mask** and oblige a
/// golden-table regeneration and a re-run of the 999-seed sweep (the T9.04 /
/// T15.02 procedure). It would also buy nothing: the guarantee above already
/// holds, and the pad is drawn by the client, not by the terrain.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
#[cfg_attr(feature = "serde", derive(serde::Serialize, serde::Deserialize))]
pub struct TeleportPad {
    pub id: u8,
    /// The feet line, as for every other surface point.
    pub pos: Point,
}

/// The three questions a **protected standing spot** answers, in one place.
///
/// A teleport pad (§C5) and a gun platform (T21.11) are the same shape at
/// different sizes: a surface point, a rect of indestructible rock below it, and
/// a test for whether a body's feet are on it. They had one copy each for about
/// an hour, which is exactly the arrangement `CLAUDE.md` names — *share the
/// guard, or share the function* — and the copy that would have drifted first is
/// `rect`, because whether it is inclusive is invisible until somebody digs one
/// row out from under a pad.
///
/// Free functions rather than a trait: there are two callers, both of which know
/// their own dimensions at compile time, and a trait would buy dynamic dispatch
/// nobody wants in `carve_circle`'s inner loop.
mod footprint {
    use crate::math::{Point, Vec2};

    /// Inclusive `(x0, y0, x1, y1)` of the protected rock, in mask coordinates.
    ///
    /// `pos` is a feet line, so the rock starts on the row **below** it and runs
    /// `h` rows down, `w` columns wide and centred.
    pub fn rect(pos: Point, w: i32, h: i32) -> (i32, i32, i32, i32) {
        let half = w / 2;
        (pos.x - half, pos.y + 1, pos.x + half - 1, pos.y + h)
    }

    pub fn covers(pos: Point, w: i32, h: i32, x: i32, y: i32) -> bool {
        let (x0, y0, x1, y1) = rect(pos, w, h);
        x >= x0 && x <= x1 && y >= y0 && y <= y1
    }

    /// Whether a body centred at `centre` is standing on this footprint.
    ///
    /// The feet, not the centre: this is ground, and the test that matters is
    /// whether the bottom of the body box is resting on it. Tolerant by
    /// `PAD_TOUCH_SLACK` in y because a grounded body's feet sit within a pixel
    /// or so of the surface line rather than exactly on it, and a body walking a
    /// slope onto it arrives a pixel or two high.
    pub fn underfoot(pos: Point, w: i32, centre: Vec2) -> bool {
        let half = w as f32 / 2.0;
        let feet = centre.y + crate::constants::PLAYER_H / 2.0;
        (centre.x - pos.x as f32).abs() <= half
            && (feet - pos.y as f32).abs() <= crate::constants::PAD_TOUCH_SLACK
    }
}

impl TeleportPad {
    /// Inclusive `(x0, y0, x1, y1)` of the protected rock, in mask coordinates.
    ///
    /// One definition, read by `carve_circle`, by the client renderer through the
    /// wire format, and by the tests. Two would eventually disagree about whether
    /// the rect is inclusive, and the failure would be a pad you can dig one row
    /// out from under.
    pub fn rect(&self) -> (i32, i32, i32, i32) {
        footprint::rect(self.pos, PAD_W, PAD_H)
    }

    /// Whether `(x, y)` is inside the protected rock.
    pub fn covers(&self, x: i32, y: i32) -> bool {
        footprint::covers(self.pos, PAD_W, PAD_H, x, y)
    }

    /// Whether a body centred at `(x, y)` is standing on this pad.
    pub fn underfoot(&self, centre: crate::math::Vec2) -> bool {
        footprint::underfoot(self.pos, PAD_W, centre)
    }
}

/// A static gun emplacement (T21.11).
///
/// **`TeleportPad`'s sibling, deliberately** — same sampler, same protected-rock
/// rule, same wire shape — because "a thing on the map you activate by standing
/// on it" is solved there and a second mechanism would be a second thing to get
/// wrong. The differences are the footprint size and the RNG sub-stream.
///
/// **Position only.** Ammo is world state that mutates and belongs in the state
/// hash; `MapMeta` is generation output that never changes after the map is
/// built. Putting the magazine here would make a replay's header disagree with
/// its own command stream the first time anybody fired.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
#[cfg_attr(feature = "serde", derive(serde::Serialize, serde::Deserialize))]
pub struct GunPlatform {
    pub id: u8,
    /// The feet line, as for every other surface point.
    pub pos: Point,
}

impl GunPlatform {
    /// Inclusive `(x0, y0, x1, y1)` of the indestructible rock beneath it.
    pub fn rect(&self) -> (i32, i32, i32, i32) {
        footprint::rect(self.pos, GUN_PLATFORM_W, GUN_PLATFORM_H)
    }

    pub fn covers(&self, x: i32, y: i32) -> bool {
        footprint::covers(self.pos, GUN_PLATFORM_W, GUN_PLATFORM_H, x, y)
    }

    /// Whether a body centred at `centre` is standing on this platform.
    ///
    /// T21.11B's mount test is this and a timer; there is no second geometry
    /// rule anywhere.
    pub fn underfoot(&self, centre: crate::math::Vec2) -> bool {
        footprint::underfoot(self.pos, GUN_PLATFORM_W, centre)
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
#[cfg_attr(feature = "serde", derive(serde::Serialize, serde::Deserialize))]
pub struct BuriedSlot {
    pub id: u16,
    pub pos: Point,
    pub revealed: bool,
}

#[derive(Clone, Debug, PartialEq, Eq)]
#[cfg_attr(feature = "serde", derive(serde::Serialize, serde::Deserialize))]
pub struct Decoration {
    pub kind: u16,
    pub pos: Point,
    pub flip: bool,
    pub scale_tier: u8,
}

#[derive(Clone, Debug, PartialEq)]
#[cfg_attr(feature = "serde", derive(serde::Serialize, serde::Deserialize))]
pub struct MapMeta {
    pub seed: u64,
    pub requested_seed: u64,
    pub attempts: u8,
    pub used_safe_preset: bool,
    pub scale: MapScale,
    pub theme: u8,
    pub spawn_points: Vec<Point>,
    /// The indestructible standing spots (§C5). Ids are their index.
    pub teleport_pads: Vec<TeleportPad>,
    /// The gun emplacements (T21.11). Ids are their index, as for pads.
    ///
    /// Placement only — the magazine is `World` state, because it mutates.
    pub gun_platforms: Vec<GunPlatform>,
    pub surface_points: Vec<Point>,
    /// Scenery stamped into the terrain at pass 6b (§D5).
    ///
    /// The mask already carries the *collision*; this carries which sprite is
    /// where, which is what the client needs to draw the art (§D6). No per-object
    /// state, no health, nothing that ticks — §D8.
    pub objects: Vec<PlacedObject>,
    pub buried_slots: Vec<BuriedSlot>,
    pub decorations: Vec<Decoration>,
    pub wind: f32,
    pub traversable_fraction: f32,
    /// Indices into `surface_points` forming the validated strongly connected set.
    ///
    /// Shipped because nothing downstream can otherwise tell "every cave is
    /// reachable" from "every cave is sealed" — a caller with no component to test
    /// against has to pass every index, and gets back the surface fraction under
    /// another name. See `docs/70` §A10.
    pub largest_component: Vec<u32>,
}

/// Mask, coarse index and metadata together, plus the dirty-chunk set that carve
/// (T1.14) maintains.
#[derive(Clone, Debug)]
pub struct Map {
    pub mask: Mask,
    pub coarse: CoarseGrid,
    pub meta: MapMeta,
    // Maintained by carve (`map::carve`), drained by the client renderer.
    pub(crate) dirty: Vec<bool>,
    pub(crate) dirty_list: Vec<u32>,
}

impl Map {
    /// Assemble a map from parts, sizing the dirty set from the mask.
    ///
    /// Public because the dirty set is `pub(crate)` — integration tests and the
    /// future replay/WASM paths need to build a `Map` around a hand-made or decoded
    /// mask without reaching into private fields.
    pub fn from_parts(mask: Mask, coarse: CoarseGrid, meta: MapMeta) -> Self {
        let chunks = (mask.chunks_x() * mask.chunks_y()) as usize;
        Map {
            mask,
            coarse,
            meta,
            dirty: vec![false; chunks],
            dirty_list: Vec::new(),
        }
    }

    pub fn chunks_x(&self) -> u32 {
        self.mask.chunks_x()
    }
    pub fn chunks_y(&self) -> u32 {
        self.mask.chunks_y()
    }
}

/// The full pipeline: terrain, spawns, buried slots, decorations, coarse grid.
///
/// Buried slots come from the default (zero) secret. Use `generate_with_secret`
/// on a live server so a modified client cannot recompute them (`docs/70` §A31).
pub fn generate(requested_seed: u64, scale: MapScale) -> Map {
    generate_with_secret(requested_seed, scale, 0)
}

/// As `generate`, against a named generator rather than `DEFAULT_MAP_GENERATOR`.
pub fn generate_with(requested_seed: u64, scale: MapScale, generator: MapGenerator) -> Map {
    generate_full(requested_seed, scale, 0, generator)
}

/// As `generate`, with a per-round `buried_secret` that never crosses the wire.
///
/// Every buried slot is currently derivable by anyone holding the seed, and the
/// seed is in `welcome` — `game-core` ships as WASM, so a modified client can
/// call the same function and get all ten exactly. Hiding them from an honest
/// client is not hiding them.
///
/// The secret defaults to 0 so golden tables, the seed sweep and every existing
/// test are unaffected; only the server rolls a real one, and it goes in the
/// replay header so a round stays reproducible.
pub fn generate_with_secret(requested_seed: u64, scale: MapScale, buried_secret: u64) -> Map {
    generate_full(
        requested_seed,
        scale,
        buried_secret,
        crate::constants::DEFAULT_MAP_GENERATOR,
    )
}

/// The one implementation the three entry points above delegate to.
///
/// Written once rather than three times because everything after `generate_terrain`
/// — spawns, buried slots, decorations, the coarse grid — is generator-agnostic,
/// and a second copy of it would drift (`CLAUDE.md`: share the guard, or share the
/// function).
pub fn generate_full(
    requested_seed: u64,
    scale: MapScale,
    buried_secret: u64,
    generator: MapGenerator,
) -> Map {
    let outcome = generate_terrain_with(requested_seed, scale, generator);
    let params = scale.params();
    let objects = outcome.objects.clone();

    let theme = theme_for(requested_seed);
    let wind = range_f32(&mut substream(requested_seed, "wind"), -WIND_MAX, WIND_MAX);

    // §D5 keeps spawns and pads `OBJECT_CLEAR_OF_SPAWN` from an object centre.
    //
    // Enforced **here**, not at stamp time: pass 6b runs before pass 8, so when
    // the objects went down no spawn existed to avoid — and §D3 requires that
    // order, because a spawn chosen from a surface without objects in it is a
    // spawn inside a rock.
    //
    // The *component index list* is filtered, not `surface`: `largest_component`
    // holds indices into `surface`, and filtering the points would silently
    // renumber them. `MapMeta.largest_component` keeps the unfiltered set — the
    // sweep measures cave reachability against it (§A10).
    let clear = clear_of_objects(
        &outcome.surface,
        &outcome.report.largest_component,
        &objects,
        WhenStarved::FallBack,
    );

    let spawn_points = choose_spawns(
        &outcome.mask,
        &outcome.surface,
        &clear,
        outcome.seed,
        crate::constants::SPAWN_COUNT_MIN.max(crate::constants::MAX_PLAYERS),
    );

    // Pads come from the same sampler as the spawns, on their own sub-stream, so
    // that adding them cannot move a spawn point (asserted in `pads_do_not_move_
    // the_spawn_points`).
    let teleport_pads = choose_pads(&outcome.mask, &outcome.surface, &clear, outcome.seed);

    // And the gun platforms, on a **third** sub-stream — but not for the reason
    // this comment used to give.
    //
    // It claimed a shared tag would "consume the pads' draws and move every
    // pad". That is **false**, and `rng::substream` is why: it builds a *fresh*
    // `ChaCha8Rng` from `seed ^ fnv1a64(tag)`, so two consumers naming the same
    // tag get two independent generators with the same start. Neither advances
    // the other. (The comment also cited a test that was never written.)
    //
    // What a separate tag actually buys is **decorrelation**: on `"pads"` the
    // platform draw would start from the pads' exact RNG state over the same
    // candidates and pick the same points — which is the seed-4242 collision,
    // a platform sitting on a pad. `platforms_are_decorrelated_from_the_pads`
    // asserts that against the production sampler, and goes red on a shared tag.
    // The `clear_of_pads` filter below then guarantees the separation outright;
    // the tag is what keeps the two draws from agreeing in the first place.
    //
    // And **clear of the pads**, which the sub-stream alone does not buy: both
    // draws are farthest-point sampling over the same surface points, so they
    // converge on the same extremes however they are seeded. Seed 4242 put a
    // platform exactly on a pad, and a tile that is both mount-on-stand and
    // teleport-on-stand is a conflict rather than a coincidence.
    // **And clear of the spawn points, which the first version missed.**
    //
    // Measured, not supposed: over 40 seeds x 3 scales the unfiltered sampler
    // put a platform within a footprint of a spawn **78 times**, including
    // exact coincidences. A player then spawns standing on a gun platform,
    // does not move, and is mounted a second later without touching anything —
    // movement gone, inventory out of reach, their own weapon replaced by the
    // turret. It surfaced as a 1-in-6 flake in `e2e-two-clients`, which fires a
    // bazooka from wherever the player spawned and sometimes counted four
    // volleys instead of four rockets.
    //
    // Same rule as the pads, same constant: these are all "somewhere a player
    // stands", and two of them on one tile is a conflict however it arises.
    // Two clearances, because they answer two different questions — see
    // `GUN_PLATFORM_SPAWN_CLEARANCE`. Using the pad's number for both starved
    // the sampler and left a map with two platforms instead of three.
    let clear_of_pads: Vec<usize> = clear
        .iter()
        .copied()
        .filter(|&i| {
            outcome.surface.get(i).is_some_and(|p| {
                let off_pads = teleport_pads.iter().all(|pad| {
                    (p.x - pad.pos.x).abs() >= GUN_PLATFORM_PAD_CLEARANCE
                        || (p.y - pad.pos.y).abs() >= GUN_PLATFORM_PAD_CLEARANCE
                });
                let off_spawns = spawn_points.iter().all(|sp| {
                    (p.x - sp.x).abs() >= GUN_PLATFORM_SPAWN_CLEARANCE
                        || (p.y - sp.y).abs() >= GUN_PLATFORM_SPAWN_CLEARANCE
                });
                off_pads && off_spawns
            })
        })
        .collect();
    let gun_platforms = choose_gun_platforms(
        &outcome.mask,
        &outcome.surface,
        &clear_of_pads,
        outcome.seed,
    );

    let buried_slots = choose_buried_slots(
        &outcome.mask,
        &outcome.sealed_pockets,
        &outcome.tunnel_paths,
        outcome.seed ^ buried_secret,
        params.buried_slots as usize,
    );

    let decorations = choose_decorations(&outcome.surface, outcome.seed, theme);

    let coarse = CoarseGrid::build(&outcome.mask);
    let chunk_count = (outcome.mask.chunks_x() * outcome.mask.chunks_y()) as usize;

    Map {
        meta: MapMeta {
            seed: outcome.seed,
            requested_seed: outcome.requested_seed,
            attempts: outcome.attempts,
            used_safe_preset: outcome.used_safe_preset,
            scale,
            theme,
            spawn_points,
            teleport_pads,
            gun_platforms,
            surface_points: outcome.surface,
            objects,
            buried_slots,
            decorations,
            wind,
            traversable_fraction: outcome.report.traversable_fraction,
            largest_component: outcome
                .report
                .largest_component
                .iter()
                .map(|&i| i as u32)
                .collect(),
        },
        mask: outcome.mask,
        coarse,
        dirty: vec![false; chunk_count],
        dirty_list: Vec::new(),
    }
}

/// `TELEPORT_PADS` well-separated, standable pads (§C5).
///
/// The same farthest-point sampling as spawn points — §C5 asks for exactly that
/// — through the shared `choose_separated`, on the `"pads"` sub-stream.
///
/// The count is not relaxed downward the way spawns are. `choose_separated` will
/// return fewer than asked on a map with nowhere to put them, and that is a
/// generation failure worth seeing rather than papering over: `six_pads_on_every_
/// scale` is the test, and if it ever fires the answer is in the generator, not
/// here.
pub fn choose_pads(
    mask: &Mask,
    surface: &[Point],
    component: &[usize],
    seed: u64,
) -> Vec<TeleportPad> {
    choose_separated(mask, surface, component, seed, "pads", TELEPORT_PADS)
        .into_iter()
        .enumerate()
        .map(|(i, pos)| TeleportPad { id: i as u8, pos })
        .collect()
}

/// `GUN_PLATFORMS` well-separated, standable emplacements (T21.11).
///
/// `choose_pads`' sibling, through the same shared sampler, on the
/// `"gun_platforms"` sub-stream. The stream name is the whole of the difference
/// and it is the load-bearing part: `choose_separated`'s contract is that a
/// caller with its own stream cannot perturb another's, which is what lets this
/// feature be added without regenerating the golden table.
///
/// Like the pads, the count is **not** relaxed downward. Fewer than
/// `GUN_PLATFORMS` on a map means the generator produced somewhere with nowhere
/// to stand, and that is worth seeing rather than papering over.
pub fn choose_gun_platforms(
    mask: &Mask,
    surface: &[Point],
    component: &[usize],
    seed: u64,
) -> Vec<GunPlatform> {
    choose_separated(
        mask,
        surface,
        component,
        seed,
        "gun_platforms",
        GUN_PLATFORMS,
    )
    .into_iter()
    .enumerate()
    .map(|(i, pos)| GunPlatform { id: i as u8, pos })
    .collect()
}

/// Points inside solid rock, biased toward tunnels and pockets.
///
/// Uniform random placement buries things where nobody will ever dig. Sampling
/// near a tunnel or a sealed pocket and stepping 30–80 px off it means a single
/// well-placed rocket can expose one, which is what makes digging a strategy
/// rather than a lottery.
pub fn choose_buried_slots(
    mask: &Mask,
    pockets: &[SealedPocket],
    tunnels: &[Vec<Point>],
    seed: u64,
    count: usize,
) -> Vec<BuriedSlot> {
    let mut rng = substream(seed, "buried");
    let mut anchors: Vec<Point> = Vec::new();
    for path in tunnels {
        anchors.extend(path.iter().copied());
    }
    anchors.extend(pockets.iter().map(|p| p.centroid));

    let sep_sq = (BURIED_SEPARATION as i64).pow(2);
    let mut slots: Vec<BuriedSlot> = Vec::with_capacity(count);

    for _ in 0..count {
        for _ in 0..BURIED_ATTEMPTS {
            let candidate = if anchors.is_empty() {
                Point::new(
                    range_i32(&mut rng, 0, mask.w as i32 - 1),
                    range_i32(&mut rng, 0, mask.h as i32 - 1),
                )
            } else {
                let a = anchors[range_i32(&mut rng, 0, anchors.len() as i32 - 1) as usize];
                let angle = range_f32(&mut rng, -crate::math::PI, crate::math::PI);
                let dist = range_i32(&mut rng, BURIED_OFFSET_MIN, BURIED_OFFSET_MAX) as f32;
                Point::new(
                    a.x + (angle.cos() * dist).round() as i32,
                    a.y + (angle.sin() * dist).round() as i32,
                )
            };

            if !crate::map::gen::caves::is_buried(mask, candidate, BURIED_CLEARANCE) {
                continue;
            }
            if slots.iter().any(|s| s.pos.distance_sq(candidate) < sep_sq) {
                continue;
            }

            slots.push(BuriedSlot {
                id: slots.len() as u16,
                pos: candidate,
                revealed: false,
            });
            break;
        }
    }

    slots
}

/// Cosmetic props anchored to the surface. Purely visual — a client may skip them.
pub fn choose_decorations(surface: &[Point], seed: u64, theme: u8) -> Vec<Decoration> {
    let mut rng = substream(seed, "decor");
    let want = (surface.len() / DECOR_PER_SURFACE).min(DECOR_MAX);
    let mut decorations = Vec::with_capacity(want);

    for _ in 0..want {
        let p = surface[range_i32(&mut rng, 0, surface.len() as i32 - 1) as usize];
        decorations.push(Decoration {
            // Kinds are per-theme; a theme with no art for a kind just skips it.
            kind: (theme as u16 * DECOR_KINDS)
                + range_i32(&mut rng, 0, DECOR_KINDS as i32 - 1) as u16,
            pos: p,
            flip: crate::rng::chance(&mut rng, 0.5),
            scale_tier: range_i32(&mut rng, 0, 2) as u8,
        });
    }

    decorations
}

/// `rand::RngCore::next_u64` under a name that does not collide with the trait
/// import in callers.
trait NextU64Compat {
    fn next_u64_compat(&mut self) -> u64;
}
impl NextU64Compat for ChaCha8Rng {
    fn next_u64_compat(&mut self) -> u64 {
        use rand::RngCore;
        self.next_u64()
    }
}

#[cfg(test)]
mod tests {
    /// **You can stand on a rock** — the assertion that proves the pass position.
    ///
    /// Not "the object has a solid top row": `is_standable` also wants body-box
    /// air, `MIN_SUPPORT_PX` below and `HEAD_CLEARANCE` above, so a bush stamped
    /// under an overhang has a solid top and is still not standable. And not a
    /// re-extraction inside the test either — this reads `meta.surface_points`,
    /// the real pass-7a output, which is the thing spawns and items consume.
    ///
    /// Aggregated across seeds and scales: one map proves nothing.
    #[test]
    fn some_object_top_is_a_real_surface_point() {
        let mut standable_tops = 0usize;
        let mut maps_with_one = 0usize;
        let mut maps = 0usize;

        for scale in MapScale::ALL {
            for seed in [1u64, 4242, 31337, 8123491234] {
                let map = generate(seed, scale);
                maps += 1;
                let mut here = 0usize;
                for o in &map.meta.objects {
                    // Any surface point standing on this object's footprint and
                    // above the row its base sits on.
                    let base = o.y + o.h as i32;
                    let hits = map
                        .meta
                        .surface_points
                        .iter()
                        .filter(|p| {
                            p.x >= o.x && p.x < o.x + o.w as i32 && p.y < base && p.y >= o.y - 1
                        })
                        .count();
                    here += hits;
                }
                standable_tops += here;
                if here > 0 {
                    maps_with_one += 1;
                }
            }
        }

        println!(
            "object tops in surface_points: {standable_tops} across {maps} maps; \
             {maps_with_one}/{maps} maps had at least one"
        );
        assert!(
            maps_with_one * 2 >= maps,
            "only {maps_with_one} of {maps} maps had a standable object top — \
             surface extraction is not seeing the objects"
        );
    }

    /// The control for the test above: with an empty object list there is
    /// nothing to stand on and every object-top assertion passes for free.
    #[test]
    fn a_real_map_has_objects_on_it_at_all() {
        let map = generate(4242, MapScale::Small);
        assert!(
            !map.meta.objects.is_empty(),
            "no objects at all — every object-top assertion is vacuous"
        );
    }

    #[test]
    fn no_spawn_or_pad_sits_within_the_object_clearance() {
        let mut checked = 0usize;
        for scale in MapScale::ALL {
            for seed in [1u64, 4242, 31337] {
                let map = generate(seed, scale);
                // The distance is written out here rather than borrowed from
                // `clear_of_objects`: this is the oracle, and a test that checks
                // a function against itself checks nothing.
                let min = (OBJECT_CLEAR_OF_SPAWN as i64).pow(2);
                let points = map
                    .meta
                    .spawn_points
                    .iter()
                    .chain(map.meta.teleport_pads.iter().map(|p| &p.pos));
                for p in points {
                    for o in &map.meta.objects {
                        let c = o.centre();
                        let d2 = ((c.x - p.x) as i64).pow(2) + ((c.y - p.y) as i64).pow(2);
                        assert!(
                            d2 >= min,
                            "{scale:?}/{seed}: spawn {p:?} is {:.0} px from object {c:?}",
                            (d2 as f64).sqrt()
                        );
                        checked += 1;
                    }
                }
            }
        }
        // The control: the loop above is satisfied by a map with no spawns and by
        // a map with no objects. It has to have compared something.
        assert!(checked > 0, "nothing was compared");
    }

    /// The clearance test's real control.
    ///
    /// Filtering the candidate pool is what enforces the clearance, so that test
    /// also passes if the filter merely leaves the chooser fewer candidates —
    /// or none. This asserts the chooser still seats a full set of spawns and
    /// pads afterwards, which is the thing that would actually break.
    #[test]
    fn the_object_filter_still_leaves_enough_room_to_seat_every_spawn_and_pad() {
        for scale in MapScale::ALL {
            for seed in [1u64, 4242, 31337, 8123491234] {
                let map = generate(seed, scale);
                assert!(
                    map.meta.spawn_points.len() >= crate::constants::SPAWN_COUNT_MIN,
                    "{scale:?}/{seed}: only {} spawns after the object filter",
                    map.meta.spawn_points.len()
                );
                assert_eq!(
                    map.meta.teleport_pads.len(),
                    TELEPORT_PADS,
                    "{scale:?}/{seed}: pads after the object filter"
                );
            }
        }
    }

    #[test]
    fn the_filter_actually_removes_candidates() {
        // Otherwise `clear_of_objects` could be the identity and every assertion
        // above would still pass.
        let outcome = crate::map::gen::generate_terrain(4242, MapScale::Medium);
        assert!(!outcome.objects.is_empty());
        let clear = clear_of_objects(
            &outcome.surface,
            &outcome.report.largest_component,
            &outcome.objects,
            WhenStarved::FallBack,
        );
        assert!(
            clear.len() < outcome.report.largest_component.len(),
            "the object filter removed nothing: {} of {}",
            clear.len(),
            outcome.report.largest_component.len()
        );
    }

    #[test]
    fn the_filter_falls_back_rather_than_starving_the_chooser() {
        // A pathological case: every surface point covered. Returning an empty
        // pool would leave a map with no spawns, which is worse than a spawn
        // beside a bush.
        let surface = vec![Point::new(100, 100), Point::new(120, 100)];
        let component = vec![0usize, 1];
        let blanket = vec![PlacedObject {
            id: 0,
            x: 90,
            y: 90,
            w: 40,
            h: 20,
            flip: false,
        }];
        let clear = clear_of_objects(&surface, &component, &blanket, WhenStarved::FallBack);
        assert_eq!(
            clear, component,
            "the pool was starved instead of falling back"
        );
    }

    use super::*;
    use crate::constants::{OBJECT_CLEAR_OF_SPAWN, SPAWN_COUNT_MIN, WIND_MAX};
    use crate::map::gen::surface::extract_surface;

    #[test]
    fn determinism_of_the_whole_pipeline() {
        let first = generate(4242, MapScale::Small);
        for _ in 0..20 {
            let again = generate(4242, MapScale::Small);
            assert_eq!(again.mask.hash(), first.mask.hash());
            assert_eq!(again.meta.spawn_points, first.meta.spawn_points);
            // §C5. Here rather than in a test of its own: this loop already
            // generates the map twenty times, and a second twenty-generation
            // test cost 40 s of CPU running beside the socket suite — enough
            // load to turn the timing-sensitive lobby tests into coin flips
            // (`CLAUDE.md`: a loaded box makes every wall-clock assertion one).
            assert_eq!(again.meta.teleport_pads, first.meta.teleport_pads);
            assert_eq!(again.meta.buried_slots, first.meta.buried_slots);
            assert_eq!(again.meta.decorations, first.meta.decorations);
            assert_eq!(again.meta.theme, first.meta.theme);
            assert_eq!(again.meta.wind, first.meta.wind);
        }
    }

    #[test]
    fn sub_stream_isolation_at_the_top_level() {
        // The property the whole seeding design rests on, tested where it matters:
        // draining an unrelated stream must not change the map.
        let before = generate(777, MapScale::Small);

        let mut items = substream(777, "items");
        for _ in 0..10_000 {
            let _ = range_i32(&mut items, 0, 1000);
        }
        let mut weather = substream(777, "weather");
        for _ in 0..10_000 {
            let _ = range_i32(&mut weather, 0, 1000);
        }

        let after = generate(777, MapScale::Small);
        assert_eq!(before.mask.hash(), after.mask.hash());
        assert_eq!(before.meta.spawn_points, after.meta.spawn_points);
        assert_eq!(before.meta.buried_slots, after.meta.buried_slots);
    }

    #[test]
    fn buried_slots_are_genuinely_buried_and_separated() {
        let map = generate(31337, MapScale::Medium);
        let slots = &map.meta.buried_slots;
        assert!(!slots.is_empty(), "no buried slots placed");

        for s in slots {
            assert!(map.mask.get(s.pos.x, s.pos.y), "slot {s:?} is not in rock");
            // Walk the whole ray, not just the endpoint. Asserting the same five
            // pixels `is_buried` samples cannot catch a slot lying against a tunnel
            // wall with solid rock again 24 px beyond it — which is exactly the bug
            // this test was written to prevent (`docs/70` §A12).
            for d in 1..=BURIED_CLEARANCE {
                for (dx, dy) in [(-d, 0), (d, 0), (0, -d), (0, d)] {
                    assert!(
                        map.mask.get(s.pos.x + dx, s.pos.y + dy),
                        "slot {:?} has air {d} px away at ({dx},{dy}) — not buried",
                        s.pos
                    );
                }
            }
            assert!(!s.revealed, "slots must start unrevealed");
        }

        for (i, a) in slots.iter().enumerate() {
            for b in &slots[i + 1..] {
                let d = (a.pos.distance_sq(b.pos) as f64).sqrt();
                assert!(
                    d >= BURIED_SEPARATION as f64,
                    "slots {:?} and {:?} are {d:.0} px apart",
                    a.pos,
                    b.pos
                );
            }
        }
    }

    #[test]
    fn slot_ids_are_their_index() {
        let map = generate(11, MapScale::Small);
        for (i, s) in map.meta.buried_slots.iter().enumerate() {
            assert_eq!(s.id as usize, i);
        }
    }

    #[test]
    fn most_buried_slots_get_placed_on_real_maps() {
        let mut total = 0usize;
        let mut wanted = 0usize;
        for seed in 0..20u64 {
            let map = generate(seed * 313 + 7, MapScale::Medium);
            total += map.meta.buried_slots.len();
            wanted += MapScale::Medium.params().buried_slots as usize;
        }
        assert!(
            total * 2 >= wanted,
            "only {total} of {wanted} buried slots placed across 20 maps"
        );
    }

    #[test]
    fn decorations_sit_on_surface_points() {
        let map = generate(99, MapScale::Small);
        assert!(!map.meta.decorations.is_empty());
        for d in &map.meta.decorations {
            assert!(
                map.meta.surface_points.contains(&d.pos),
                "decoration at {:?} is not on a surface point",
                d.pos
            );
            assert!(d.scale_tier <= 2);
        }
        assert!(map.meta.decorations.len() <= DECOR_MAX);
    }

    #[test]
    fn wind_and_theme_are_in_range() {
        for seed in 0..30u64 {
            let map = generate(seed * 17, MapScale::Small);
            assert!(
                map.meta.wind.abs() <= WIND_MAX,
                "wind {} exceeds {WIND_MAX}",
                map.meta.wind
            );
            assert!(map.meta.theme < THEME_COUNT, "theme {}", map.meta.theme);
        }
    }

    #[test]
    fn themes_actually_vary_across_seeds() {
        let mut seen = std::collections::HashSet::new();
        for seed in 0..40u64 {
            seen.insert(generate(seed * 101 + 3, MapScale::Small).meta.theme);
        }
        assert!(
            seen.len() > 1,
            "every seed produced the same theme: {seen:?}"
        );
    }

    #[test]
    fn surface_points_match_the_final_mask() {
        let map = generate(4242, MapScale::Small);
        assert!(!map.meta.surface_points.is_empty());
        assert_eq!(map.meta.surface_points, extract_surface(&map.mask));
    }

    #[test]
    fn the_coarse_grid_matches_the_generated_mask() {
        for scale in MapScale::ALL {
            let map = generate(5, scale);
            assert_eq!(map.coarse.verify(&map.mask), Ok(()), "{scale:?}");
        }
    }

    #[test]
    fn every_scale_produces_a_usable_map() {
        for scale in MapScale::ALL {
            let map = generate(2024, scale);
            let p = scale.params();
            assert_eq!((map.mask.w, map.mask.h), (p.width, p.height), "{scale:?}");
            assert!(
                map.meta.spawn_points.len() >= SPAWN_COUNT_MIN,
                "{scale:?}: only {} spawns",
                map.meta.spawn_points.len()
            );
            assert!(!map.meta.surface_points.is_empty(), "{scale:?}");
            assert_eq!(
                map.dirty.len(),
                (map.chunks_x() * map.chunks_y()) as usize,
                "{scale:?} dirty set size"
            );
        }
    }

    // ---------------------------------------------------------------- §C5 pads

    #[test]
    fn six_teleport_pads_on_every_scale_separated_and_standable() {
        use crate::constants::{SPAWN_MIN_SEPARATION, TELEPORT_PADS};
        for scale in MapScale::ALL {
            // Two seeds, not four. A population claim needs more than one draw
            // (`CLAUDE.md`) and this is every scale, which is what §A19 asks
            // for; the other two seeds cost 14 s of CPU beside the socket suite
            // and bought no new failure mode.
            for seed in [4242u64, 31337] {
                let map = generate(seed, scale);
                let pads = &map.meta.teleport_pads;
                assert_eq!(
                    pads.len(),
                    TELEPORT_PADS,
                    "{scale:?}/{seed}: {} pads",
                    pads.len()
                );
                for p in pads {
                    assert!(
                        crate::map::gen::surface::is_standable(&map.mask, p.pos.x, p.pos.y),
                        "{scale:?}/{seed}: pad {:?} is not standable",
                        p.pos
                    );
                }
                // The same separation the sampler enforces for spawns — relaxed
                // the same way, so this pins the relaxed floor rather than the
                // ideal one.
                let floor = SPAWN_MIN_SEPARATION
                    * crate::map::gen::spawns::RELAX_FACTOR
                        .powi(crate::map::gen::spawns::MAX_RELAXATIONS as i32);
                for (i, a) in pads.iter().enumerate() {
                    for b in &pads[i + 1..] {
                        let d = (a.pos.distance_sq(b.pos) as f64).sqrt();
                        assert!(
                            d >= floor as f64,
                            "{scale:?}/{seed}: pads {:?} and {:?} are {d:.0} px apart",
                            a.pos,
                            b.pos
                        );
                    }
                }
            }
        }
    }

    #[test]
    fn pad_ids_are_their_index() {
        let map = generate(11, MapScale::Small);
        for (i, p) in map.meta.teleport_pads.iter().enumerate() {
            assert_eq!(p.id as usize, i);
        }
    }

    /// §C5's indestructibility, **measured at every scale** — §A19's lesson is
    /// that a single-scale measurement is a number, not a property.
    ///
    /// The control is the second half: the same carve one pad-width to the side
    /// removes plenty, so "removed nothing" is about the pad and not about a
    /// carve that was never going to do anything.
    #[test]
    fn a_carve_over_a_pad_removes_nothing() {
        use crate::constants::PAD_W;
        for scale in MapScale::ALL {
            let mut map = generate(4242, scale);
            let pads = map.meta.teleport_pads.clone();
            assert!(!pads.is_empty(), "{scale:?}: no pads to test");

            for pad in &pads {
                let (x0, y0, x1, y1) = pad.rect();
                let before: u32 = (y0..=y1).map(|y| map.mask.count_run(y, x0, x1)).sum();
                // Centred on the pad, wide enough to swallow the whole rect.
                let r = map.carve_circle(pad.pos.x, pad.pos.y + PAD_W, PAD_W * 2);
                let after: u32 = (y0..=y1).map(|y| map.mask.count_run(y, x0, x1)).sum();
                assert_eq!(
                    before,
                    after,
                    "{scale:?}: a carve took {} px out of pad {} ({:?}); {} removed overall",
                    before as i64 - after as i64,
                    pad.id,
                    pad.pos,
                    r.pixels_removed
                );
            }
        }
    }

    /// The control for the test above.
    #[test]
    fn the_same_carve_beside_a_pad_removes_plenty() {
        use crate::constants::PAD_W;
        let mut map = generate(4242, MapScale::Medium);
        let pad = map.meta.teleport_pads[0];
        // Four pad-widths to the side: clear of the rect, still in the ground.
        let mut removed = 0;
        for dir in [-1, 1] {
            let mut m = map.clone();
            removed += m
                .carve_circle(pad.pos.x + dir * PAD_W * 4, pad.pos.y + PAD_W, PAD_W * 2)
                .pixels_removed;
        }
        assert!(
            removed > 0,
            "the control carve removed nothing either, so the pad test proves nothing"
        );
        // And the pad is still whole after the real one.
        map.carve_circle(pad.pos.x, pad.pos.y + PAD_W, PAD_W * 2);
        assert!(crate::map::gen::surface::is_standable(
            &map.mask, pad.pos.x, pad.pos.y
        ));
    }

    /// The whole reason pads exist: a map dug to pieces still has six of them.
    #[test]
    fn every_pad_survives_a_map_carved_to_pieces() {
        use crate::constants::TELEPORT_PADS;
        for scale in MapScale::ALL {
            let mut map = generate(8123, scale);
            let (w, h) = (map.mask.w as i32, map.mask.h as i32);
            let before = map.mask.count_solid();
            let mut y = 0;
            while y < h {
                let mut x = 0;
                while x < w {
                    map.carve_circle(x, y, 90);
                    x += 120;
                }
                y += 120;
            }
            assert!(
                map.mask.count_solid() * 2 < before,
                "{scale:?}: the fixture barely destroyed anything"
            );

            let standing = map
                .meta
                .teleport_pads
                .iter()
                .filter(|p| crate::map::gen::surface::is_standable(&map.mask, p.pos.x, p.pos.y))
                .count();
            assert_eq!(
                standing, TELEPORT_PADS,
                "{scale:?}: only {standing} pads left standing"
            );
        }
    }

    // ------------------------------------------------- T21.11 gun platforms

    #[test]
    fn gun_platforms_on_every_scale_separated_and_standable() {
        use crate::constants::{GUN_PLATFORMS, SPAWN_MIN_SEPARATION};
        for scale in MapScale::ALL {
            // Two seeds and every scale, the shape the pad test settled on: a
            // population claim needs more than one draw, and four seeds bought
            // no new failure mode there either.
            for seed in [4242u64, 31337] {
                let plats = &generate(seed, scale).meta.gun_platforms;
                // **"Up to 3", which is the coordinator's own wording.**
                //
                // Clearing the candidates of pads *and* spawns (T21.14) can
                // leave a cramped map unable to seat three well-separated
                // points. Measured over 30 seeds x 3 scales: 88 maps get three,
                // one gets two, one gets one — and none gets a platform on a
                // spawn, which is the defect that clearance exists to prevent.
                // Fewer platforms is a lesser map; a platform under a spawning
                // player is a player mounted without touching anything.
                assert!(
                    !plats.is_empty() && plats.len() <= GUN_PLATFORMS,
                    "{scale:?}/{seed}: {} platforms, expected 1..={GUN_PLATFORMS}",
                    plats.len()
                );
                let map = generate(seed, scale);
                for g in plats {
                    assert!(
                        crate::map::gen::surface::is_standable(&map.mask, g.pos.x, g.pos.y),
                        "{scale:?}/{seed}: platform {:?} is not standable",
                        g.pos
                    );
                }
                let floor = SPAWN_MIN_SEPARATION
                    * crate::map::gen::spawns::RELAX_FACTOR
                        .powi(crate::map::gen::spawns::MAX_RELAXATIONS as i32);
                for (i, a) in plats.iter().enumerate() {
                    for b in &plats[i + 1..] {
                        let d = (a.pos.distance_sq(b.pos) as f64).sqrt();
                        assert!(
                            d >= floor as f64,
                            "{scale:?}/{seed}: platforms {:?} and {:?} are {d:.0} px apart",
                            a.pos,
                            b.pos
                        );
                    }
                }
            }
        }
    }

    #[test]
    fn gun_platform_ids_are_their_index() {
        let map = generate(11, MapScale::Small);
        for (i, g) in map.meta.gun_platforms.iter().enumerate() {
            assert_eq!(g.id as usize, i);
        }
    }

    /// Platforms draw from their **own** sub-stream — not the pads', not the
    /// spawns'.
    ///
    /// Same argument as `pads_and_spawns_draw_from_different_sub_streams`, and
    /// the same trap avoided: re-deriving a local `substream(seed,
    /// "gun_platforms")` and comparing would assert only that `generate` is
    /// deterministic, which it is however the streams are named. What actually
    /// fails is comparing the *results*: `choose_separated` is the same sampler
    /// over the same surface points, so a shared stream name makes the platforms
    /// land exactly on the pads.
    /// The separate sub-stream, asserted **through the production sampler**.
    ///
    /// Two earlier attempts at this were hollow and both were caught by running
    /// the mutation rather than reasoning about it (T21.14):
    ///
    ///  - `gun_platforms_draw_from_their_own_sub_stream` asserts platforms are
    ///    not pads, which `clear_of_pads` guarantees on its own — green with the
    ///    tag renamed to `"pads"`;
    ///  - a replacement that re-derived both lists with *literal* tag names
    ///    asserted a property of `choose_separated` and never touched
    ///    `choose_gun_platforms` at all — also green.
    ///
    /// This one calls the real `choose_gun_platforms` over the **unfiltered**
    /// component, which is the input the pads themselves got. On a shared tag
    /// the two draws start from the same RNG state over the same candidates and
    /// agree; on separate tags they do not.
    #[test]
    fn platforms_are_decorrelated_from_the_pads() {
        for seed in [4242u64, 31337, 11] {
            let map = generate(seed, MapScale::Medium);
            let component: Vec<usize> = map
                .meta
                .largest_component
                .iter()
                .map(|&i| i as usize)
                .collect();
            assert!(
                !component.is_empty(),
                "seed {seed}: no component, so this asserts nothing"
            );
            let pads = choose_pads(
                &map.mask,
                &map.meta.surface_points,
                &component,
                map.meta.seed,
            );
            let plats = choose_gun_platforms(
                &map.mask,
                &map.meta.surface_points,
                &component,
                map.meta.seed,
            );
            assert!(
                !pads.is_empty() && !plats.is_empty(),
                "seed {seed}: empty draw"
            );
            let pad_pts: Vec<Point> = pads.iter().map(|p| p.pos).collect();
            let plat_pts: Vec<Point> = plats.iter().map(|g| g.pos).collect();
            let n = plat_pts.len().min(pad_pts.len());
            assert_ne!(
                plat_pts[..n],
                pad_pts[..n],
                "seed {seed}: the platform draw agrees with the pad draw over the same \
                 candidates — they are sharing a sub-stream tag"
            );
        }
    }

    #[test]
    fn gun_platforms_draw_from_their_own_sub_stream() {
        let map = generate(31337, MapScale::Medium);
        let plats: Vec<Point> = map.meta.gun_platforms.iter().map(|g| g.pos).collect();
        let pads: Vec<Point> = map.meta.teleport_pads.iter().map(|p| p.pos).collect();
        assert_eq!(plats.len(), crate::constants::GUN_PLATFORMS);
        // Prefixes, because the two lists are different lengths: a shared stream
        // makes the shorter one a prefix of the longer, which `assert_ne` on the
        // whole vectors would not catch.
        let n = plats.len().min(pads.len());
        assert_ne!(
            plats[..n],
            pads[..n],
            "the platforms landed on the pads — they are sharing a sub-stream"
        );
        assert_ne!(
            plats[..n],
            map.meta.spawn_points[..n],
            "the platforms landed on the spawn points — they are sharing a sub-stream"
        );
    }

    #[test]
    fn the_same_seed_gives_the_same_gun_platforms() {
        let map = generate(31337, MapScale::Medium);
        let again = generate(31337, MapScale::Medium);
        assert_eq!(map.meta.gun_platforms, again.meta.gun_platforms);
    }

    /// The coordinator's *"a couple pixels of ground you cannot destroy under
    /// it"*, measured at every scale — §A19's lesson that a single-scale
    /// measurement is a number, not a property.
    #[test]
    fn a_carve_over_a_gun_platform_removes_nothing() {
        use crate::constants::GUN_PLATFORM_W;
        for scale in MapScale::ALL {
            let mut map = generate(4242, scale);
            let plats = map.meta.gun_platforms.clone();
            assert!(!plats.is_empty(), "{scale:?}: no platforms to test");

            for g in &plats {
                let (x0, y0, x1, y1) = g.rect();
                let before: u32 = (y0..=y1).map(|y| map.mask.count_run(y, x0, x1)).sum();
                let r = map.carve_circle(g.pos.x, g.pos.y + GUN_PLATFORM_W, GUN_PLATFORM_W * 2);
                let after: u32 = (y0..=y1).map(|y| map.mask.count_run(y, x0, x1)).sum();
                assert_eq!(
                    before,
                    after,
                    "{scale:?}: a carve took {} px out of platform {} ({:?}); {} removed overall",
                    before as i64 - after as i64,
                    g.id,
                    g.pos,
                    r.pixels_removed
                );
            }
        }
    }

    /// The control: the same carve clear of the rect removes plenty, so
    /// "removed nothing" is about the platform and not about a carve that was
    /// never going to do anything.
    #[test]
    fn the_same_carve_beside_a_gun_platform_removes_plenty() {
        use crate::constants::GUN_PLATFORM_W;
        let mut map = generate(4242, MapScale::Medium);
        let g = map.meta.gun_platforms[0];
        let mut removed = 0;
        for dir in [-1, 1] {
            let mut m = map.clone();
            removed += m
                .carve_circle(
                    g.pos.x + dir * GUN_PLATFORM_W * 4,
                    g.pos.y + GUN_PLATFORM_W,
                    GUN_PLATFORM_W * 2,
                )
                .pixels_removed;
        }
        assert!(
            removed > 0,
            "the control carve removed nothing either, so the platform test proves nothing"
        );
        map.carve_circle(g.pos.x, g.pos.y + GUN_PLATFORM_W, GUN_PLATFORM_W * 2);
        assert!(crate::map::gen::surface::is_standable(
            &map.mask, g.pos.x, g.pos.y
        ));
    }

    /// The `solid` exemption, asserted rather than assumed.
    ///
    /// Protection is refused for a **carve** only. A `fill_circle` inside the
    /// rect cannot break the standability guarantee — it only adds rock — and
    /// refusing it would make the footprint a hole nothing could ever fill.
    #[test]
    fn a_fill_inside_a_gun_platform_still_adds_rock() {
        use crate::constants::GUN_PLATFORM_W;
        let mut map = generate(4242, MapScale::Medium);
        let g = map.meta.gun_platforms[0];
        // Carve a hole well above the platform first, so there is somewhere for
        // a fill to put rock back. The rect itself is already solid.
        let (cx, cy) = (g.pos.x, g.pos.y - GUN_PLATFORM_W);
        map.carve_circle(cx, cy, GUN_PLATFORM_W);
        let before = map.mask.count_solid();
        map.fill_circle(cx, cy, GUN_PLATFORM_W);
        assert!(
            map.mask.count_solid() > before,
            "a fill added nothing, so the solid exemption is untested"
        );
    }

    /// Platforms and pads are separate features and their **footprints** must
    /// not overlap.
    ///
    /// Asserted on the rects rather than on the positions, because the rects are
    /// what the conflict is about: two stand-to-activate features whose
    /// protected rock intersects are two activations competing for one tile.
    /// Positions differing by a pixel would pass a `assert_ne!` on `pos` and
    /// still be the bug.
    /// **A platform must not be placed where a player spawns** (T21.14).
    ///
    /// Measured before it was fixed: over 40 seeds x 3 scales the sampler put a
    /// platform within a footprint of a spawn **78 times**, including exact
    /// coincidences. A player spawning on one stands still, mounts a second
    /// later without touching anything, and finds their movement gone, their
    /// inventory unreachable and their weapon replaced by the turret. It
    /// reached the gate as a 1-in-6 flake in `e2e-two-clients`.
    ///
    /// Asserted on the **footprint**, not on equal positions, for the same
    /// reason the pad test is: two features a pixel apart are still the bug.
    #[test]
    fn gun_platforms_are_never_placed_on_a_spawn_point() {
        use crate::constants::GUN_PLATFORM_SPAWN_CLEARANCE;
        for scale in MapScale::ALL {
            for seed in [0u64, 1, 4242, 31337] {
                let map = generate(seed, scale);
                assert!(
                    !map.meta.gun_platforms.is_empty(),
                    "{scale:?}/{seed}: clearing the spawns left no platforms at all"
                );
                for g in &map.meta.gun_platforms {
                    for sp in &map.meta.spawn_points {
                        let clear = (g.pos.x - sp.x).abs() >= GUN_PLATFORM_SPAWN_CLEARANCE
                            || (g.pos.y - sp.y).abs() >= GUN_PLATFORM_SPAWN_CLEARANCE;
                        assert!(
                            clear,
                            "{scale:?}/{seed}: platform {} at {:?} is on spawn {:?} — \
                             a player spawning there is mounted without touching anything",
                            g.id, g.pos, sp
                        );
                    }
                }
            }
        }
    }

    #[test]
    fn gun_platform_footprints_never_overlap_a_pad_footprint() {
        for scale in MapScale::ALL {
            for seed in [4242u64, 31337, 11] {
                let map = generate(seed, scale);
                assert!(
                    !map.meta.gun_platforms.is_empty(),
                    "{scale:?}/{seed}: clearing the pads left no platforms at all"
                );
                for g in &map.meta.gun_platforms {
                    let (gx0, gy0, gx1, gy1) = g.rect();
                    for p in &map.meta.teleport_pads {
                        let (px0, py0, px1, py1) = p.rect();
                        let overlap = gx0 <= px1 && px0 <= gx1 && gy0 <= py1 && py0 <= gy1;
                        assert!(
                            !overlap,
                            "{scale:?}/{seed}: platform {} {:?} overlaps pad {} {:?}",
                            g.id, g.pos, p.id, p.pos
                        );
                    }
                }
            }
        }
    }

    /// The whole reason the footprint is protected: a map dug to pieces still
    /// has every platform standing.
    #[test]
    fn every_gun_platform_survives_a_map_carved_to_pieces() {
        for scale in MapScale::ALL {
            let mut map = generate(8123, scale);
            let (w, h) = (map.mask.w as i32, map.mask.h as i32);
            let before = map.mask.count_solid();
            let mut y = 0;
            while y < h {
                let mut x = 0;
                while x < w {
                    map.carve_circle(x, y, 90);
                    x += 120;
                }
                y += 120;
            }
            assert!(
                map.mask.count_solid() * 2 < before,
                "{scale:?}: the fixture barely destroyed anything"
            );
            let want = map.meta.gun_platforms.len();
            let standing = map
                .meta
                .gun_platforms
                .iter()
                .filter(|g| crate::map::gen::surface::is_standable(&map.mask, g.pos.x, g.pos.y))
                .count();
            assert!(want > 0, "{scale:?}: the map has no platforms to test");
            assert_eq!(
                standing, want,
                "{scale:?}: only {standing} of {want} platforms left standing"
            );
        }
    }

    /// `underfoot` is the one geometry rule, shared with the pad through
    /// `footprint`. T21.11B's mount test is this plus a timer.
    #[test]
    fn a_body_standing_on_a_gun_platform_is_underfoot_and_one_beside_it_is_not() {
        use crate::constants::{GUN_PLATFORM_W, PLAYER_H};
        let map = generate(4242, MapScale::Medium);
        let g = map.meta.gun_platforms[0];
        let centre = crate::math::Vec2::new(g.pos.x as f32, g.pos.y as f32 - PLAYER_H / 2.0);
        assert!(
            g.underfoot(centre),
            "a body on the platform is not underfoot"
        );
        let beside = crate::math::Vec2::new(
            g.pos.x as f32 + GUN_PLATFORM_W as f32,
            g.pos.y as f32 - PLAYER_H / 2.0,
        );
        assert!(
            !g.underfoot(beside),
            "a body a full width away is underfoot"
        );
    }

    /// Pads draw from their own sub-stream, not the spawn points'.
    ///
    /// **The obvious version of this test cannot fail.** Draining a *local*
    /// `substream(seed, "pads")` and re-generating asserts nothing: `generate` is
    /// deterministic by construction, so both sides match however the streams are
    /// named — including if `choose_pads` passed `"spawns"`, which is the bug the
    /// test exists for. It would have been a determinism test wearing an
    /// isolation test's name (CLAUDE.md: ask what a passing assertion rules out).
    ///
    /// What does fail is comparing the two *results*: `choose_separated` is the
    /// same sampler over the same surface points, so a shared stream name makes
    /// the pads land exactly on the spawn points.
    #[test]
    fn pads_and_spawns_draw_from_different_sub_streams() {
        let map = generate(31337, MapScale::Medium);
        let pads: Vec<Point> = map.meta.teleport_pads.iter().map(|p| p.pos).collect();
        assert_eq!(pads.len(), TELEPORT_PADS);
        assert_ne!(
            pads, map.meta.spawn_points,
            "the pads landed on the spawn points — they are sharing a sub-stream"
        );
    }

    /// The control for the test above, and the determinism the task asks for:
    /// the same seed twice gives the same pads.
    #[test]
    fn the_same_seed_gives_the_same_pads() {
        let map = generate(31337, MapScale::Medium);
        let again = generate(31337, MapScale::Medium);
        assert_eq!(map.meta.spawn_points, again.meta.spawn_points);
        assert_eq!(map.meta.teleport_pads, again.meta.teleport_pads);
    }

    #[test]
    fn spawn_points_are_standable_on_the_final_mask() {
        // A spawn inside rock is the single worst generation bug, so assert it
        // against the mask that actually ships rather than trusting the pipeline.
        let map = generate(8123, MapScale::Medium);
        for s in &map.meta.spawn_points {
            assert!(
                crate::map::gen::surface::is_standable(&map.mask, s.x, s.y),
                "spawn {s:?} is not standable"
            );
        }
    }
}
