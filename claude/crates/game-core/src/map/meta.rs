//! Pass 8: buried slots, decorations, `MapMeta`, and the complete [`Map`].
//!
//! [`generate`] is the whole pipeline and the only entry point the server and the
//! WASM bridge need.
//!
//! See `docs/10-map-generation.md` §1.4, §Pass 8.

use crate::constants::{
    MapGenerator, MapScale, BURIED_ATTEMPTS, BURIED_CLEARANCE, BURIED_OFFSET_MAX,
    BURIED_OFFSET_MIN, BURIED_SEPARATION, GUN_PLATFORMS, GUN_PLATFORM_H,
    GUN_PLATFORM_PAD_CLEARANCE, GUN_PLATFORM_SPAWN_CLEARANCE, GUN_PLATFORM_W, PAD_ART_W, PAD_H,
    PAD_W, PLAYER_H, PLAYER_W, STANDING_GROUND_FILL_DEPTH, TELEPORT_PADS, TELEPORT_PADS_MIN,
    WIND_MAX,
};
use crate::constants::{DECOR_BASE_W, DECOR_GROUND_SLACK};
use crate::map::gen::components::SealedPocket;
use crate::map::gen::objects::{
    clear_of_objects, column_gap, fill_column, PlacedObject, WhenStarved,
};
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

/// One of `MapGenerator::Space`'s rocks (`T22.05A`, `M22-RULINGS` R13).
///
/// *"Asteroid", not "island"* — the owner renamed them on 2026-09-18 and the
/// word is load-bearing, because they are no longer inert scenery.
///
/// `r` is the **bounding** radius, not the core disc's: the stamped silhouette
/// is lumpy but every solid pixel of it is inside `r` of `(x, y)`. That is what
/// lets `r` be the one number rocks are spaced by, reach is measured by, and
/// `T22.11` sizes a gravity well from.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
#[cfg_attr(feature = "serde", derive(serde::Serialize, serde::Deserialize))]
pub struct Asteroid {
    /// Centre, world px.
    pub x: i32,
    pub y: i32,
    /// Bounding radius, px.
    pub r: i32,
    /// Gravity level, `1..=SPACE_LEVEL_MAX`. Monotone in `r`, with jitter.
    ///
    /// **Generated here and shipped**, because the client predicts against it
    /// (`T22.11` owns what the number does). It is part of the hashed map: the
    /// mask carries the rock's *shape*, and nothing but this field carries its
    /// *pull*, so a digest that skipped it would let the whole level assignment
    /// change with every golden row still green.
    pub level: u8,
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
    /// `MapGenerator::Space`'s rocks. **Empty for every other generator**, which
    /// is how a space map is told apart from a normal one downstream without a
    /// second flag to keep in sync.
    pub asteroids: Vec<Asteroid>,
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
    // T22.10: where carves opened the space rim, maintained by carve, drained by
    // `World::step_vortices`. Bounded (`MAX_PENDING_BREACHES`): a client's map carves
    // too and nothing there drains it.
    pub(crate) breaches: Vec<(i32, i32)>,
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
            breaches: Vec::new(),
        }
    }

    pub fn chunks_x(&self) -> u32 {
        self.mask.chunks_x()
    }
    pub fn chunks_y(&self) -> u32 {
        self.mask.chunks_y()
    }

    /// The arena's boundary, **when this is a space map** (`T22.05B`).
    ///
    /// `Some` is the whole of *"this round is in space"* for anything holding a
    /// `&Map`, and it hands the caller the geometry it was about to build
    /// anyway rather than a boolean it would have to act on. That is `items`,
    /// today: R14 takes crates off the sky drop and items off the ground, and
    /// both need somewhere inside the rim to put the thing.
    ///
    /// **Derived from `meta.asteroids`, which is the discriminator that field's
    /// own doc already names** — *"Empty for every other generator, which is
    /// how a space map is told apart from a normal one downstream without a
    /// second flag to keep in sync"*. It is sound in both directions: v1 and v2
    /// never fill it, and no space map ships without rocks, because
    /// `rocks_are_within_reach` returns `false` for an empty scatter and
    /// `analyse_space` folds that into `passed` — so a rockless space map fails
    /// every attempt, falls to the safe preset, and the safe preset asks for
    /// `max(count/2, 4)`.
    ///
    /// **And it is now sound on a networked client too** (`T22.11C`, R49; the
    /// caveat `T22.05B`'s review filed as F6 is closed). `T22.05C` recorded here
    /// that the claim held server-side only, because `meta.asteroids` on a
    /// client was whatever the core last generated locally — empty, in practice,
    /// since `GameCore::new()` runs the standard generator — and
    /// `worldMirror.ts::applyMapInit` had no third setter to call beside
    /// `setTeleportPads` and `setGunPlatforms`. It has one:
    /// `GameCore::set_asteroids`, wired at that line and pinned by
    /// `worldMirror.test.ts::the rocks from map_init put a field under the
    /// client`.
    ///
    /// A `MapMeta.generator` field would be the more direct spelling and is the
    /// obvious next step if a third consumer appears; it was not worth the
    /// twenty struct literals in fixtures for one.
    pub fn space_geometry(&self) -> Option<crate::map::gen::space::SpaceGeometry> {
        (!self.meta.asteroids.is_empty())
            .then(|| crate::map::gen::space::SpaceGeometry::for_dims(self.mask.w, self.mask.h))
    }

    /// Is `p` — a **feet line**, as every point in this project that names a
    /// player position is — somewhere a player body can be put on this map?
    ///
    /// **The one place the two meanings of "a spawn is still valid" are
    /// reconciled** (`T22.05B`). Under gravity it is `is_standable`: a box that
    /// fits, with rock under it. In space it is `space::body_fits`: a box that
    /// fits, inside the rim, clear of every rock — *with no rock under it*,
    /// because you do not land to spawn (R17).
    ///
    /// **Why this is not cosmetic.** `World::spawn_for` and
    /// `player::state::choose_respawn` both filter `MapMeta.spawn_points`
    /// through the standable test before using one, and an open-space point
    /// fails it by definition — `is_standable` demands `MIN_SUPPORT_PX` of rock
    /// directly beneath. Left alone, every space spawn this task chooses would
    /// be rejected at the moment of use and both callers would fall through to
    /// their surface fallback, landing players on asteroid tops instead. The
    /// points would still be generated, shipped, validated and golden-hashed,
    /// and nothing would have reported that they were never used:
    /// `the_shipped_spawn_points_are_the_ones_a_space_round_uses` is the test
    /// that would.
    pub fn body_fits_at(&self, p: Point) -> bool {
        match self.space_geometry() {
            Some(geo) => {
                crate::map::gen::space::body_fits(&self.mask, &geo, &self.meta.asteroids, p)
            }
            None => crate::map::gen::surface::is_standable(&self.mask, p.x, p.y),
        }
    }

    /// One point a player body or an item may be put at, drawn at random, or
    /// `None` when this map has nowhere.
    ///
    /// The **fallback** half of `body_fits_at`, and shared for the same reason:
    /// the respawn fallback, the round's initial items, the periodic item
    /// spawns and the supply crates all ask *"somewhere on this map, please"*,
    /// and in space the answer is open air rather than a surface point (R14,
    /// R16).
    ///
    /// **The landscape arm draws exactly once, as its callers always did** —
    /// one index into `surface_points`, no re-check — because those callers sit
    /// on the `"items"` stream and a second draw here would shift every
    /// subsequent item on every existing map. Callers that want the point
    /// re-validated against the damaged mask call `body_fits_at` on the result,
    /// which is what `resample_surface` and `choose_respawn` do.
    pub fn random_body_site(&self, rng: &mut ChaCha8Rng) -> Option<Point> {
        match self.space_geometry() {
            Some(geo) => crate::map::gen::space::random_open_space(
                &self.mask,
                &geo,
                &self.meta.asteroids,
                rng,
            ),
            None if self.meta.surface_points.is_empty() => None,
            None => Some(
                self.meta.surface_points
                    [range_i32(rng, 0, self.meta.surface_points.len() as i32 - 1) as usize],
            ),
        }
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
    generate_full_with(requested_seed, scale, buried_secret, generator, true)
}

/// `generate_full`, with T21.28's ground fill switchable — `false` only for the
/// tests' control, which is the same choices with the bug left in.
pub(crate) fn generate_full_with(
    requested_seed: u64,
    scale: MapScale,
    buried_secret: u64,
    generator: MapGenerator,
    fill: bool,
) -> Map {
    let outcome = generate_terrain_with(requested_seed, scale, generator);
    let params = scale.params();
    let objects = outcome.objects.clone();
    let asteroids = outcome.asteroids.clone();

    let theme = theme_for(requested_seed);

    // **`T22.05B`: the one derived fact the rest of pass 8 branches on.**
    //
    // Derived from the generator, which R15 derives from the gravity mode, so
    // there is one source of truth and no way for a lobby to ask for a space
    // map with landscape furniture in it. Everything below that reads it is a
    // *ruling*, made here and reversible here; the reasons are at each site.
    let space = generator == MapGenerator::Space;

    // **Ruling: no wind in a vacuum.** `MapMeta.wind` is read by
    // `effects/weather.rs` and the client's rain and cloud drift, and a wind
    // speed in space is a physical claim the mode contradicts. Zero rather than
    // absent, because `wind` is an `f32` every consumer already multiplies by.
    // The draw is skipped, not discarded: `rng::substream` builds a fresh
    // generator per tag, so not drawing from `"wind"` cannot move any other
    // stream.
    //
    // **Reverse it by:** this one expression.
    let wind = if space {
        0.0
    } else {
        range_f32(&mut substream(requested_seed, "wind"), -WIND_MAX, WIND_MAX)
    };

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

    // **Ruling: in space the generator chooses, and pass 8 ships what it chose.**
    //
    // `choose_spawns` picks from the traversal component of a *surface*, and in
    // space there is no ground line to walk — a spawn is a point in open air
    // inside the rim (R17). `space::choose_space_spawns` picks those, through
    // the same farthest-point sampler, and `analyse_space` has already passed
    // judgement on this exact list, so the verdict and the shipped field are
    // one value rather than two measurements of different things (R35).
    //
    // **Reverse it by:** this match.
    let spawn_points = if space {
        outcome.spawn_points.clone()
    } else {
        choose_spawns(
            &outcome.mask,
            &outcome.surface,
            &clear,
            outcome.seed,
            crate::constants::SPAWN_COUNT_MIN.max(crate::constants::MAX_PLAYERS),
        )
    };

    // Pads come from the same sampler as the spawns, on their own sub-stream, so
    // that adding them cannot move a spawn point (asserted in `pads_do_not_move_
    // the_spawn_points`).
    // **T21.28: on ground, or refused.** A pad is chosen only where every column
    // of the gate's *drawn* base has ground within `STANDING_GROUND_FILL_DEPTH`
    // — deeper is a cliff edge, and propping a gate over it on a pillar is the
    // wrong fix — and where the ground the fill will add cannot reach into a
    // spawn's body. A filter over candidates, drawing no randomness, so the
    // `"pads"` stream is untouched.
    //
    // **T21.40: and never anywhere else.** T21.28 fell back to unseated tiers when
    // the seated ones could not reach the count, which left 544 of 8916 pads and
    // platforms perched over drops on 284 of 999 sweep maps. The owner, 2026-09-15:
    // *"just place them somewhere else then like a floating island or just dont
    // place any more if there's no proper space"*. So the tiers are both seated:
    // the main traversable ground first, then **every** surface point clear of
    // objects — floating islands and unreached ledges included — for the
    // shortfall. Main ground first is the builder's call (reversible): a map that
    // could already seat its pads keeps them where they were. What cannot be
    // seated is not placed, and fewer than `TELEPORT_PADS_MIN` becomes none.
    let everywhere: Vec<usize> = (0..outcome.surface.len()).collect();
    let clear_anywhere = clear_of_objects(
        &outcome.surface,
        &everywhere,
        &objects,
        WhenStarved::FallBack,
    );
    let bodies: Vec<Point> = spawn_points.clone();
    // **Ruling: no teleport pads and no gun platforms in space.**
    //
    // Both are *standing* furniture. `TeleportPad::underfoot` and
    // `GunPlatform::underfoot` are the only ways either is used, and both ask
    // where a player's feet are; `standing_candidates` + `stands_on_ground`
    // then refuse anywhere the drawn base is not sitting on rock, and
    // `a_network_or_none` zeroes a pad count under `TELEPORT_PADS_MIN`. So the
    // sampler would have returned almost nothing anyway (T22.05B's task file
    // predicted zero) — but *almost nothing by accident* is the thing to avoid,
    // because what it actually returned today was **six pads on the floor
    // crust, outside the rim, in the void** (R35).
    //
    // **T22.05C measured that rather than reasoning about it**, because
    // T22.05B's review was right that "the sampler would have returned almost
    // nothing anyway" argues *against* the guard doing anything. Each guard
    // flipped to `if false` on its own (not the `space` binding, which moves
    // all five at once and says nothing about which), seed 4242,
    // Small/Medium/Large:
    //
    // | guard off | what a space map then ships |
    // |---|---|
    // | `teleport_pads` | **6 / 6 / 6** pads |
    // | `gun_platforms` | **3 / 3 / 3** platforms |
    // | `decorations`   | **3 / 6 / 10** props |
    // | `buried_slots`  | **1 / 7 / 10** slots — the number already quoted below |
    //
    // With every guard on it is 0 / 0 / 0, and
    // `a_space_map_ships_none_of_the_furniture_that_needs_a_ground` goes red
    // for each of the four in turn. None of these guards is decoration.
    //
    // And the fill is not hypothetical either: `surface_points` on Medium goes
    // **69 → 75** with only the pads guard off and **69 → 72** with only the
    // platforms guard off, which is `fill_standing_ground` adding rock and the
    // surface being re-derived from it — pixels outside a rock's bounding
    // radius, which is exactly what `stamp_asteroid`'s invariant forbids.
    //
    // The decisive reason is not the sampler, it is `fill_standing_ground`.
    // T21.28 fills rock under every pad and platform it places, and the only
    // seatable ground in space is an asteroid top — so seating a gate there
    // would add pixels **outside that rock's bounding radius**, which is the
    // one invariant `stamp_asteroid` maintains and which `place_asteroids`,
    // `rocks_are_within_reach` and `T22.11`'s gravity wells all reason in. A
    // teleport network is not worth silently changing what a rock's radius
    // means.
    //
    // Consequence, stated rather than left to be found: `filled` below is
    // therefore always 0 on a space map, so `gen::reanalyse`'s space arm is
    // unreachable *by construction* here rather than merely unexercised (R32).
    // `no_ground_is_filled_on_a_space_map` asserts that, and
    // `the_space_verdict_survives_a_refill` exercises the arm directly.
    //
    // **Reverse it by:** these two `if space` guards — and then read
    // `stamp_asteroid`'s doc before believing the fill is harmless.
    let teleport_pads = if space {
        Vec::new()
    } else {
        let seated_main = standing_candidates(
            &outcome.mask,
            &outcome.surface,
            &clear,
            PAD_ART_W,
            &bodies,
            &[],
        );
        let seated_anywhere = standing_candidates(
            &outcome.mask,
            &outcome.surface,
            &clear_anywhere,
            PAD_ART_W,
            &bodies,
            &[],
        );
        let chosen = seat_then_top_up(
            &outcome.surface,
            &[&seated_main, &seated_anywhere],
            TELEPORT_PADS,
            |c| {
                choose_pads(&outcome.mask, &outcome.surface, c, outcome.seed)
                    .into_iter()
                    .map(|p| p.pos)
                    .collect()
            },
        );
        a_network_or_none(chosen)
            .into_iter()
            .enumerate()
            .map(|(i, pos)| TeleportPad { id: i as u8, pos })
            .collect::<Vec<_>>()
    };

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
    let clear_of_pads = |pool: &[usize]| -> Vec<usize> {
        pool.iter()
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
            .collect()
    };
    let (main_clear_of_pads, anywhere_clear_of_pads) =
        (clear_of_pads(&clear), clear_of_pads(&clear_anywhere));
    // The same rule for the platforms, whose drawn base is `GUN_PLATFORM_W`
    // (`platforms.ts` builds the texture that wide). Neither a spawn nor a pad
    // may be buried by a platform's fill, and no pad's fill may bury the platform.
    let pad_feet: Vec<(Point, i32)> = teleport_pads.iter().map(|p| (p.pos, PAD_ART_W)).collect();
    let mut platform_bodies = bodies.clone();
    platform_bodies.extend(teleport_pads.iter().map(|p| p.pos));
    let gun_platforms = if space {
        Vec::new()
    } else {
        // T21.40: seated or not placed, main ground first, then anywhere — the pads'
        // rule. A map short of `GUN_PLATFORMS` seats fewer, down to none.
        let seated_main = standing_candidates(
            &outcome.mask,
            &outcome.surface,
            &main_clear_of_pads,
            GUN_PLATFORM_W,
            &platform_bodies,
            &pad_feet,
        );
        let seated_anywhere = standing_candidates(
            &outcome.mask,
            &outcome.surface,
            &anywhere_clear_of_pads,
            GUN_PLATFORM_W,
            &platform_bodies,
            &pad_feet,
        );
        let chosen = seat_then_top_up(
            &outcome.surface,
            &[&seated_main, &seated_anywhere],
            GUN_PLATFORMS,
            |c| {
                choose_gun_platforms(&outcome.mask, &outcome.surface, c, outcome.seed)
                    .into_iter()
                    .map(|g| g.pos)
                    .collect()
            },
        );
        chosen
            .into_iter()
            .enumerate()
            .map(|(i, pos)| GunPlatform { id: i as u8, pos })
            .collect::<Vec<_>>()
    };

    // **Ruling: no buried items in space, and this is a skip rather than an
    // empty call.**
    //
    // The task file says buried slots are *"empty by construction"* because
    // `choose_buried_slots` consumes `sealed_pockets` and `tunnel_paths`, which
    // only the cave and crevice passes produce. That is half true and the other
    // half is a live bug: with both lists empty the function takes its
    // `anchors.is_empty()` branch, which is **uniform random placement over the
    // whole map** — the branch its own doc exists to reject (*"Uniform random
    // placement buries things where nobody will ever dig"*). Measured before
    // this guard: 1 / 7 / 10 slots on Small / Medium / Large, scattered
    // anywhere in the mask, including inside the rim's rock and the void crust.
    //
    // The third job of `components::cleanup` is what supplies the anchors, and
    // the space pipeline skips that pass on purpose (see `space.rs`'s header).
    // So: no anchors, no slots. Digging is not a strategy in a mode with no
    // ground to dig.
    //
    // **Reverse it by:** this guard — and give the space generator something to
    // anchor on first, or it will be the uniform branch again.
    let buried_slots = if space {
        Vec::new()
    } else {
        choose_buried_slots(
            &outcome.mask,
            &outcome.sealed_pockets,
            &outcome.tunnel_paths,
            outcome.seed ^ buried_secret,
            params.buried_slots as usize,
        )
    };

    // **T21.28: the ground under every standing thing, after every choice.** Last,
    // so it cannot move a spawn, a pad, a platform, a buried slot or an object —
    // `the_fill_moves_no_spawn_pad_platform_or_object` holds that.
    let mut mask = outcome.mask;
    let mut filled = 0u64;
    if fill {
        for p in &teleport_pads {
            filled += fill_standing_ground(&mut mask, p.pos, PAD_ART_W);
        }
        for g in &gun_platforms {
            filled += fill_standing_ground(&mut mask, g.pos, GUN_PLATFORM_W);
        }
    }

    // **And the surface is re-derived from the filled mask.** It was extracted
    // before the fill, and the fill both removes air where a point on a slope
    // beside a gate kept its body box and adds support where there was none — so
    // lava vents, respawn's fallback and bots, which read the points as places a
    // body fits, would be reading the unfilled map. The same two calls both
    // generators make (`extract_surface`, then `traversal::analyse`), so
    // `surface_points_match_the_final_mask` holds by construction rather than by a
    // second rule. Skipped when nothing was added, which leaves an unfilled map
    // exactly as it was.
    let (surface_points, report) = if filled > 0 {
        // **Through `surface_for`, not `extract_surface`.** T22.05B: a space
        // map's surface is the arena's, and `extract_surface` also returns the
        // full-width floor crust outside the rim. Same reasoning as
        // `reanalyse` below, same `match`, deliberately adjacent to it.
        let surface = crate::map::gen::surface_for(outcome.generator, &mask);
        // **Through `reanalyse`, not `traversal::analyse`.** The space generator
        // has its own verdict (R17), and re-running the walking one here would
        // silently replace it with a number about a game nobody is playing —
        // the outcome's report would say one thing and `MapMeta` another.
        let report = crate::map::gen::reanalyse(
            outcome.generator,
            &mask,
            &surface,
            &objects,
            &asteroids,
            &spawn_points,
        );
        (surface, report)
    } else {
        (outcome.surface, outcome.report)
    };
    let traversable_fraction = report.traversable_fraction;
    let largest_component: Vec<u32> = report.largest_component.iter().map(|&i| i as u32).collect();
    // **Ruling: no decorations in space.**
    //
    // Decorations are grass, rocks and bones anchored to a ground line, and
    // `decoration_seated` is a *downward* test — rock within `DECOR_GROUND_SLACK`
    // under every column of the drawn base. There is no up-vector to draw them
    // against on an asteroid, and the owner has reported floating scenery twice
    // (T21.21, T21.28). The count is derived from `surface.len()` too, so
    // leaving it on would have scaled the mode's scenery off the arena's
    // standable rock, which is not a quantity anyone chose.
    //
    // Note this is a *ruling*, not a consequence of the surface filter: the
    // filtered surface still has seated points on asteroid tops, so without
    // this guard a space map would ship props standing on rocks. **T22.05C
    // wrote the number down**, because that sentence was a measurement nobody
    // had taken: with only this guard flipped to `if false`, seed 4242 ships
    // **3 / 6 / 10** decorations on Small / Medium / Large — on the filtered
    // arena surface, with the crust already gone. The guard is the whole
    // reason there are none.
    //
    // **Reverse it by:** this guard. The art would need an orientation first —
    // `T22.06`'s territory, not this task's.
    let decorations = if space {
        Vec::new()
    } else {
        choose_decorations(&mask, &surface_points, outcome.seed, theme)
    };

    let coarse = CoarseGrid::build(&mask);
    let chunk_count = (mask.chunks_x() * mask.chunks_y()) as usize;

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
            surface_points,
            objects,
            asteroids,
            buried_slots,
            decorations,
            wind,
            traversable_fraction,
            largest_component,
        },
        mask,
        coarse,
        dirty: vec![false; chunk_count],
        dirty_list: Vec::new(),
        breaches: Vec::new(),
    }
}

/// The columns a thing drawn `drawn_w` wide, centred on `pos`, stands on (T21.28).
///
/// `pads.ts` and `platforms.ts` both draw with origin (0.5, 1) at the feet line,
/// so the sprite covers `[pos.x - w/2, pos.x - w/2 + w)` — the same columns
/// `footprint::rect` uses for the protected rock, widened to the picture.
fn drawn_columns(pos: Point, drawn_w: i32) -> std::ops::Range<i32> {
    let x0 = pos.x - drawn_w / 2;
    x0..x0 + drawn_w
}

/// Whether every column of a drawn base has ground within
/// `STANDING_GROUND_FILL_DEPTH` below the feet line (T21.28).
pub fn stands_on_ground(mask: &Mask, pos: Point, drawn_w: i32) -> bool {
    drawn_columns(pos, drawn_w).all(|col| {
        column_gap(mask, col, pos.y + 1, STANDING_GROUND_FILL_DEPTH) <= STANDING_GROUND_FILL_DEPTH
    })
}

/// T21.28: extend the ground up to meet a pad's or a platform's **drawn** base.
///
/// Reported from play with a screenshot of a gate on a slope: *"a couple pixels
/// are touching it in the center but the rest are in the air"*, and *"same for
/// all other objects you place on the map"*. For every column of the drawn base,
/// fill straight down from the row under the feet line to the first solid pixel,
/// within `STANDING_GROUND_FILL_DEPTH` — `objects.rs::fill_column`, the rule the
/// scenery fill (T21.21) uses, shared rather than copied. Never upward, never into
/// the sprite's own box, never into a wall; flat ground gains nothing. Returns the
/// pixels added. Draws no randomness.
pub fn fill_standing_ground(mask: &mut Mask, pos: Point, drawn_w: i32) -> u64 {
    drawn_columns(pos, drawn_w)
        .map(|col| fill_column(mask, col, pos.y + 1, STANDING_GROUND_FILL_DEPTH))
        .sum()
}

/// Choose `count` standing spots, **as many as possible from the first tier** (T21.28).
///
/// `tiers` are candidate sets from strictest to loosest: on ground and safe, safe
/// only, anything. The sampler (`choose`, the thing's own sub-stream) runs on the
/// strictest tier; if it seats fewer than `count` — farthest-point sampling over a
/// handful of grounded points often seats four of six — the shortfall is **topped
/// up** from the next tier by farthest-point from what is already chosen, rather
/// than throwing the grounded ones away and re-drawing everything from the loose
/// set. That all-or-nothing first version left 835 of 8934 pads and platforms
/// perched over a drop across the 1000-seed sweep, on 288 maps. The top-up draws
/// no randomness, so the sub-streams are untouched.
///
/// **T21.40: every tier is seated, and there is no last resort.** T21.28 ended with
/// a whole re-draw from an unseated tier when the top-up fell short, which is where
/// every perched gate came from. The owner, 2026-09-15: *"just dont place any more if
/// there's no proper space"*. So a shortfall stays a shortfall: this returns up to
/// `count`, possibly none.
fn seat_then_top_up<'a>(
    surface: &[Point],
    tiers: &[&'a [usize]],
    count: usize,
    choose: impl Fn(&'a [usize]) -> Vec<Point>,
) -> Vec<Point> {
    // The sampler's own most-relaxed separation, which the pad and platform
    // tests hold every pair to; a top-up closer than this would be the sampler's
    // rule broken by the code sitting next to it.
    let floor = crate::constants::SPAWN_MIN_SEPARATION
        * crate::map::gen::spawns::RELAX_FACTOR
            .powi(crate::map::gen::spawns::MAX_RELAXATIONS as i32);
    let floor_sq = (floor * floor) as i64;
    let mut chosen: Vec<Point> = Vec::new();
    for &tier in tiers {
        if chosen.len() >= count {
            break;
        }
        if chosen.is_empty() {
            chosen = choose(tier);
            continue;
        }
        while chosen.len() < count {
            let next = tier
                .iter()
                .filter_map(|&i| surface.get(i).copied())
                .map(|p| {
                    (
                        p,
                        chosen
                            .iter()
                            .map(|c| c.distance_sq(p))
                            .min()
                            .unwrap_or(i64::MAX),
                    )
                })
                .filter(|(_, d)| *d >= floor_sq)
                .max_by_key(|(_, d)| *d);
            match next {
                Some((p, _)) => chosen.push(p),
                None => break,
            }
        }
    }
    chosen.truncate(count);
    chosen
}

/// Pads, or none: fewer than `TELEPORT_PADS_MIN` is none (T21.40).
///
/// A pad sends you to any *other* pad (`world/teleport.rs::destination`), so a lone
/// pad charges and goes nowhere. The owner's *"just dont place any more if there's no
/// proper space"* applies to the network as a whole: a map that can seat one gets
/// none, and its players respawn through `respawn.rs`'s spawn-point fallback.
fn a_network_or_none(mut pads: Vec<Point>) -> Vec<Point> {
    if pads.len() < TELEPORT_PADS_MIN {
        pads.clear();
    }
    pads
}

/// Could the ground `fill_standing_ground` adds under a thing at `pos` reach into
/// the body box of someone standing at `body`?
///
/// Geometry, not a trial fill: the fill is confined to the drawn columns and the
/// `STANDING_GROUND_FILL_DEPTH` rows under the feet line, so overlap with that
/// rectangle is a conservative "maybe" — a body box of `PLAYER_W` plus a pixel
/// each side, and twice `PLAYER_H` tall to cover `is_standable`'s head clearance.
fn fill_reaches(pos: Point, drawn_w: i32, body: Point) -> bool {
    let cols = drawn_columns(pos, drawn_w);
    let half = (PLAYER_W / 2.0).ceil() as i32 + 1;
    let (fill_top, fill_bottom) = (pos.y + 1, pos.y + STANDING_GROUND_FILL_DEPTH);
    let (body_top, body_bottom) = (body.y - 2 * PLAYER_H as i32, body.y);
    cols.start < body.x + half
        && body.x - half < cols.end
        && fill_top <= body_bottom
        && body_top <= fill_bottom
}

/// Candidates (indices into `surface`) where a thing drawn `drawn_w` wide may go
/// (T21.28): its fill buries none of `bodies`, no fill already decided among
/// `others` reaches it, and it stands on ground (T21.40: always — there is no
/// unseated tier any more, so the flag that allowed one is gone).
fn standing_candidates(
    mask: &Mask,
    surface: &[Point],
    component: &[usize],
    drawn_w: i32,
    bodies: &[Point],
    others: &[(Point, i32)],
) -> Vec<usize> {
    component
        .iter()
        .copied()
        .filter(|&i| {
            surface.get(i).is_some_and(|p| {
                bodies.iter().all(|b| !fill_reaches(*p, drawn_w, *b))
                    && others.iter().all(|(o, w)| !fill_reaches(*o, *w, *p))
                    && stands_on_ground(mask, *p, drawn_w)
            })
        })
        .collect()
}

/// Up to `TELEPORT_PADS` well-separated, standable pads (§C5), from `component`.
///
/// The same farthest-point sampling as spawn points — §C5 asks for exactly that
/// — through the shared `choose_separated`, on the `"pads"` sub-stream.
///
/// **T21.40: fewer is allowed, and so is none.** This used to say a map short of
/// `TELEPORT_PADS` was "a generation failure worth seeing", pinned by a six-pads
/// test. The owner overruled that on 2026-09-15: *"Gates on steep peaks? Too wide?
/// Just place them somewhere else then like a floating island or just dont place
/// any more if there's no proper space"*. `generate_full_with` hands this only
/// candidates where the gate's drawn base is seated — the main ground first, then
/// any surface point, islands included — tops up the shortfall from the same
/// seated set, places what that yields, and places none when that is fewer than
/// `TELEPORT_PADS_MIN` (`a_network_or_none`). The tests are
/// `every_placed_pad_and_platform_is_seated`, `a_map_short_of_seated_ground_gets_fewer`
/// and `a_map_has_no_pads_or_a_network_never_one`; the sweep reports how often
/// maps fall short.
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
/// **T21.40: like the pads, seated or not placed.** `generate_full_with` offers only
/// seated candidates (main ground, then anywhere), so a map with no proper space
/// gets fewer than `GUN_PLATFORMS`, down to none. A platform has no pairing rule:
/// one alone is still a turret.
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
pub fn choose_decorations(mask: &Mask, surface: &[Point], seed: u64, theme: u8) -> Vec<Decoration> {
    choose_decorations_with(mask, surface, seed, theme, true)
}

/// Whether a decoration anchored at `p` has rock within `DECOR_GROUND_SLACK` under
/// every column of the widest base any decoration can draw (T21.28).
pub fn decoration_seated(mask: &Mask, p: Point) -> bool {
    let x0 = p.x - DECOR_BASE_W / 2;
    (x0..x0 + DECOR_BASE_W)
        .all(|col| column_gap(mask, col, p.y + 1, DECOR_GROUND_SLACK) <= DECOR_GROUND_SLACK)
}

/// `choose_decorations`, with the T21.28 seat filter switchable — `false` only for
/// the tests' control.
///
/// **Seated spots only** (coordinator's ruling): the client draws a decoration only
/// when rock sits under every column of its drawn base, and choosing from the whole
/// surface let it drop 56 of 96 across nine maps, one map keeping a single prop. So
/// the candidates are the surface points where even the widest base is seated. The
/// count still comes from the whole surface, so density is unchanged; the unfiltered
/// set is used only when no point is seated at all, and the sweep counts those maps.
pub(crate) fn choose_decorations_with(
    mask: &Mask,
    surface: &[Point],
    seed: u64,
    theme: u8,
    seat: bool,
) -> Vec<Decoration> {
    let mut rng = substream(seed, "decor");
    let want = (surface.len() / DECOR_PER_SURFACE).min(DECOR_MAX);
    let mut decorations = Vec::with_capacity(want);
    let seated: Vec<Point> = if seat {
        surface
            .iter()
            .copied()
            .filter(|p| decoration_seated(mask, *p))
            .collect()
    } else {
        Vec::new()
    };
    let pool: &[Point] = if seated.is_empty() { surface } else { &seated };
    if pool.is_empty() {
        return decorations;
    }

    for _ in 0..want {
        let p = pool[range_i32(&mut rng, 0, pool.len() as i32 - 1) as usize];
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

/// T21.28 — decorations are chosen where their base is seated.
#[cfg(test)]
mod seated_decorations {
    use super::*;

    const SEEDS: [u64; 3] = [1, 4242, 31337];

    /// Every decoration's widest possible base has rock within the slack, on
    /// several maps at every scale; the **control** is the same maps chosen without
    /// the filter, which must show unseated ones or this proves nothing.
    #[test]
    fn every_decoration_is_chosen_where_its_base_is_seated() {
        // [without the filter, with it]
        let (mut chosen, mut unseated) = ([0usize; 2], [0usize; 2]);
        for seed in SEEDS {
            for scale in MapScale::ALL {
                let map = generate(seed, scale);
                for (i, seat) in [false, true].into_iter().enumerate() {
                    let decor = if seat {
                        map.meta.decorations.clone()
                    } else {
                        choose_decorations_with(
                            &map.mask,
                            &map.meta.surface_points,
                            map.meta.seed,
                            map.meta.theme,
                            false,
                        )
                    };
                    chosen[i] += decor.len();
                    // Measured here, column by column, not through `decoration_seated`.
                    unseated[i] += decor
                        .iter()
                        .filter(|d| {
                            let x0 = d.pos.x - DECOR_BASE_W / 2;
                            !(x0..x0 + DECOR_BASE_W).all(|col| {
                                (d.pos.y + 1..=d.pos.y + 1 + DECOR_GROUND_SLACK)
                                    .any(|y| map.mask.get(col, y))
                            })
                        })
                        .count();
                }
            }
        }
        println!(
            "T21.28 DECOR without the filter: {} chosen, {} unseated; with it: {} chosen, {} unseated",
            chosen[0], unseated[0], chosen[1], unseated[1]
        );
        assert!(
            unseated[0] > 0,
            "without the filter nothing is unseated — the control proves nothing"
        );
        assert_eq!(
            unseated[1], 0,
            "{} decorations were chosen unseated",
            unseated[1]
        );
        assert_eq!(
            chosen[0], chosen[1],
            "the filter changed how many decorations a map gets"
        );
    }
}

/// T21.28 — everything placed on the map stands on ground.
#[cfg(test)]
mod standing_ground {
    use super::*;
    use crate::constants::DEFAULT_MAP_GENERATOR;
    use crate::map::gen::surface::is_standable;

    const SEEDS: [u64; 3] = [1, 4242, 31337];

    /// The air under each column of a drawn base, uncapped — counted here rather
    /// than through `column_gap`, so the test measures the finished mask at the
    /// other end from the code that fills it.
    fn gaps(mask: &Mask, pos: Point, w: i32) -> Vec<i32> {
        drawn_columns(pos, w)
            .map(|col| {
                let mut d = 0;
                while pos.y + 1 + d < mask.h as i32 && !mask.get(col, pos.y + 1 + d) {
                    d += 1;
                }
                d
            })
            .collect()
    }

    fn standing(map: &Map) -> Vec<(Point, i32)> {
        map.meta
            .teleport_pads
            .iter()
            .map(|p| (p.pos, PAD_ART_W))
            .chain(
                map.meta
                    .gun_platforms
                    .iter()
                    .map(|g| (g.pos, GUN_PLATFORM_W)),
            )
            .collect()
    }

    /// Every column of every pad's and platform's drawn base has ground under it,
    /// on several seeds at every scale; the **control** is the same maps with the
    /// fill off, which must show hanging columns or this proves nothing.
    #[test]
    fn every_pad_and_platform_has_ground_under_its_whole_drawn_base() {
        // [without fill, with fill]
        let (mut things, mut columns, mut hanging, mut perched) = ([0; 2], [0; 2], [0; 2], [0; 2]);
        for seed in SEEDS {
            for scale in MapScale::ALL {
                for (i, fill) in [false, true].into_iter().enumerate() {
                    // The fill arm goes through `generate_with` — the entry point the game
                    // calls — so turning the fill off at its live call site turns this red;
                    // only the control reaches past it.
                    let map = if fill {
                        generate_with(seed, scale, DEFAULT_MAP_GENERATOR)
                    } else {
                        generate_full_with(seed, scale, 0, DEFAULT_MAP_GENERATOR, false)
                    };
                    for (pos, w) in standing(&map) {
                        things[i] += 1;
                        let g = gaps(&map.mask, pos, w);
                        columns[i] += g.len();
                        hanging[i] += g
                            .iter()
                            .filter(|d| **d > 0 && **d <= STANDING_GROUND_FILL_DEPTH)
                            .count();
                        perched[i] += g.iter().any(|d| *d > STANDING_GROUND_FILL_DEPTH) as usize;
                    }
                }
            }
        }
        println!(
            "T21.28 without fill: {} things, {} columns, {} hanging within reach, {} perched past it; \
             with fill: {} things, {} columns, {} hanging, {} perched",
            things[0], columns[0], hanging[0], perched[0], things[1], columns[1], hanging[1], perched[1]
        );
        assert!(
            hanging[0] > 0,
            "without the fill no column hangs — the bug is not reproduced, so the next line proves nothing"
        );
        assert_eq!(
            hanging[1], 0,
            "{} drawn base columns still hang within the fill's reach",
            hanging[1]
        );
        assert_eq!(
            perched[0], perched[1],
            "the fill changed which things are perched — it moved a choice"
        );
    }

    fn flat(ground: i32) -> Mask {
        let mut m = Mask::new_empty(1024, 512);
        for y in ground..512 {
            m.set_run(y, 0, 1023);
        }
        m
    }

    /// A pad or platform already on level ground gains **nothing**.
    #[test]
    fn a_pad_or_platform_on_flat_ground_gains_nothing() {
        for w in [PAD_ART_W, GUN_PLATFORM_W] {
            let mut m = flat(300);
            let pos = Point::new(512, 299);
            assert!(stands_on_ground(&m, pos, w));
            assert_eq!(
                fill_standing_ground(&mut m, pos, w),
                0,
                "width {w} gained ground on flat terrain"
            );
        }
    }

    /// The fill closes a gap under the base exactly and touches nothing at or
    /// above the feet line — never upward, never into the sprite's own box — and a
    /// gap deeper than the reach is left alone and refused (the control that the
    /// bound is real).
    #[test]
    fn the_fill_closes_the_gap_below_the_base_and_nothing_above_it() {
        let ground = 300;
        let pos = Point::new(512, ground - 1);
        let notch_cols = 10;
        let above = |m: &Mask| {
            let mut n = 0;
            for y in 0..=pos.y {
                for col in drawn_columns(pos, PAD_ART_W) {
                    n += m.get(col, y) as usize;
                }
            }
            n
        };
        for (gap, reach) in [
            (STANDING_GROUND_FILL_DEPTH / 2, true),
            (STANDING_GROUND_FILL_DEPTH + 5, false),
        ] {
            let mut m = flat(ground);
            // A slope's worth of air under the right-hand end of the drawn base,
            // outside the 40 px pad strip — the overhang the report is about.
            let x0 = pos.x + PAD_ART_W / 2 - notch_cols;
            for y in ground..ground + gap {
                for x in x0..x0 + notch_cols {
                    m.clear(x, y);
                }
            }
            let before = above(&m);
            assert_eq!(stands_on_ground(&m, pos, PAD_ART_W), reach);
            let added = fill_standing_ground(&mut m, pos, PAD_ART_W);
            assert_eq!(
                above(&m),
                before,
                "gap {gap}: the fill rose to or above the feet line"
            );
            if reach {
                assert_eq!(
                    added as i32,
                    notch_cols * gap,
                    "gap {gap}: not exactly the gap"
                );
                assert!(
                    gaps(&m, pos, PAD_ART_W).iter().all(|d| *d == 0),
                    "a column still hangs"
                );
            } else {
                assert_eq!(
                    added, 0,
                    "gap {gap}: the fill reached past STANDING_GROUND_FILL_DEPTH"
                );
            }
        }
    }

    /// The fill draws no randomness and runs after every choice, so a map with it
    /// and without it chooses the same spawns, pads, platforms and objects.
    #[test]
    fn the_fill_moves_no_spawn_pad_platform_or_object() {
        let mut differs = 0;
        for seed in SEEDS {
            for scale in MapScale::ALL {
                let with = generate_full_with(seed, scale, 0, DEFAULT_MAP_GENERATOR, true);
                let without = generate_full_with(seed, scale, 0, DEFAULT_MAP_GENERATOR, false);
                assert_eq!(
                    with.meta.spawn_points, without.meta.spawn_points,
                    "{seed} {scale:?}"
                );
                assert_eq!(
                    with.meta.teleport_pads, without.meta.teleport_pads,
                    "{seed} {scale:?}"
                );
                assert_eq!(
                    with.meta.gun_platforms, without.meta.gun_platforms,
                    "{seed} {scale:?}"
                );
                assert_eq!(with.meta.objects, without.meta.objects, "{seed} {scale:?}");
                differs += (with.mask.hash_hex() != without.mask.hash_hex()) as usize;
            }
        }
        // The control: the switch reaches the mask, or the equalities above are
        // comparing two copies of one map.
        assert!(
            differs > 0,
            "the fill changed no mask — the switch does nothing"
        );
    }

    /// The coordinator's condition: nothing a body is placed on is buried by the
    /// fill — every spawn and every surface point still fits a player.
    #[test]
    fn no_spawn_or_surface_point_is_buried_by_the_fill() {
        for seed in SEEDS {
            for scale in MapScale::ALL {
                let map = generate(seed, scale);
                assert!(
                    !map.meta.surface_points.is_empty(),
                    "{seed} {scale:?}: no surface points to check"
                );
                for s in &map.meta.spawn_points {
                    assert!(
                        is_standable(&map.mask, s.x, s.y),
                        "{seed} {scale:?}: spawn {s:?} buried"
                    );
                }
                for p in &map.meta.surface_points {
                    assert!(
                        is_standable(&map.mask, p.x, p.y),
                        "{seed} {scale:?}: surface {p:?} buried"
                    );
                }
                for &i in &map.meta.largest_component {
                    assert!(
                        (i as usize) < map.meta.surface_points.len(),
                        "component index {i} out of range"
                    );
                }
            }
        }
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
                // T21.40: a map places only the pads it can seat, so the full set is
                // no longer the contract; these four seeds still seat one, and a
                // filter that starved the chooser would show here as fewer.
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
    use crate::constants::{
        DEFAULT_MAP_GENERATOR, OBJECT_CLEAR_OF_SPAWN, SPAWN_COUNT_MIN, WIND_MAX,
    };
    use crate::map::gen::surface::extract_surface;

    /// **T22.05B's rulings, every one of them, with the landscape as control.**
    ///
    /// The four seated-furniture passes and the wind are *off* in space, and
    /// each of those is a decision rather than a starvation. The control half
    /// is what makes the test worth running: without it *"a space map has no
    /// pads"* is satisfied by a build where nothing anywhere has pads, which
    /// is exactly how the `asteroid_tops_are_standable` assertion R35 found
    /// managed to be green for a generator that stamped no asteroids.
    ///
    /// The landscape numbers are asserted as **non-zero**, not as fixed
    /// counts — T21.40 lets a map short of seated ground ship fewer, down to
    /// none, and pinning six pads here would be re-litigating that ruling in
    /// the wrong file. Medium/4242 is a map that has them; if it ever stops,
    /// this test says so rather than passing quietly.
    ///
    /// ## What this test reports, measured per guard (T22.05C)
    ///
    /// The control rules out *"nothing anywhere has pads"*. It does **not**,
    /// on its own, rule out *"the guard does nothing"* — and T22.05B's own
    /// justification for three of the five argued that the sampler would have
    /// returned nothing anyway. So each guard in `generate_full_with` was
    /// flipped to `if false` **separately** (flipping the `space` binding
    /// moves all five and tells you nothing about which), and this test went
    /// **red for every one of them**, at seed 4242:
    ///
    /// `teleport_pads` 6/6/6 · `gun_platforms` 3/3/3 · `decorations` 3/6/10 ·
    /// `buried_slots` 1/7/10, on Small/Medium/Large. `wind` is a `range_f32`
    /// draw over ±`WIND_MAX` and is ~never exactly zero.
    ///
    /// That is the claim this test carries: **deleting any one of the five
    /// guards makes it fail**, rather than merely "a space map has none of
    /// these today".
    #[test]
    fn a_space_map_ships_none_of_the_furniture_that_needs_a_ground() {
        for scale in MapScale::ALL {
            let space = generate_with(4242, scale, MapGenerator::Space);
            assert!(
                space.meta.teleport_pads.is_empty(),
                "{scale:?}: {} pads on a space map",
                space.meta.teleport_pads.len()
            );
            assert!(
                space.meta.gun_platforms.is_empty(),
                "{scale:?}: {} gun platforms on a space map",
                space.meta.gun_platforms.len()
            );
            assert!(
                space.meta.buried_slots.is_empty(),
                "{scale:?}: {} buried slots on a space map — `choose_buried_slots`' uniform \
                 branch is running again",
                space.meta.buried_slots.len()
            );
            assert!(
                space.meta.decorations.is_empty(),
                "{scale:?}: {} decorations on a space map",
                space.meta.decorations.len()
            );
            assert_eq!(space.meta.wind, 0.0, "{scale:?}: wind in a vacuum");
        }

        // The control: all five are things a landscape map really does ship.
        //
        // **Across seeds, not on one**, and the reason is T21.40: a map short
        // of seated ground ships fewer pads and platforms, down to none, so
        // any single seed can legitimately have zero of one of them —
        // Medium/4242 has no gun platforms, which is how this control first
        // fired. What is *not* legitimate is the whole generator producing
        // none, and that is what this measures.
        let mut land = [0usize; 4];
        let mut winds = 0usize;
        let seeds: [u64; 8] = [1, 7, 99, 4242, 31337, 555, 8080, 12345];
        for seed in seeds {
            let m = generate_with(seed, MapScale::Medium, DEFAULT_MAP_GENERATOR).meta;
            land[0] += m.teleport_pads.len();
            land[1] += m.gun_platforms.len();
            land[2] += m.buried_slots.len();
            land[3] += m.decorations.len();
            assert!(m.wind.abs() <= WIND_MAX, "control: wind out of band");
            if m.wind != 0.0 {
                winds += 1;
            }
        }
        println!(
            "control over {} landscape seeds: {} pads, {} platforms, {} buried, {} decorations, \
             {winds} with wind",
            seeds.len(),
            land[0],
            land[1],
            land[2],
            land[3]
        );
        assert!(land[0] > 0, "control: no pads anywhere");
        assert!(land[1] > 0, "control: no gun platforms anywhere");
        assert!(land[2] > 0, "control: no buried slots anywhere");
        assert!(land[3] > 0, "control: no decorations anywhere");
        assert!(winds > 0, "control: no wind anywhere");
    }

    /// **The deliverable, as an assertion: nothing a space map places is
    /// outside the boundary, and nothing sits on a spawn.**
    ///
    /// `MapMeta` field by field, over several seeds and every scale. The four
    /// empty collections are ruled empty above and asserted there; this walks
    /// the ones that *do* carry positions and checks each against the rim — so
    /// if a later task turns one of those rulings around, this is what says the
    /// new placement has to respect the boundary too.
    ///
    /// **Its own falsification is built in**: the loop counts what it actually
    /// examined and refuses to pass having examined nothing, which is what an
    /// all-empty `MapMeta` would otherwise let it do.
    #[test]
    fn every_thing_a_space_map_places_is_inside_the_rim() {
        let mut checked = 0usize;
        for scale in MapScale::ALL {
            for seed in [1u64, 4242, 31337] {
                let map = generate_with(seed, scale, MapGenerator::Space);
                let geo = map.space_geometry().expect("a space map");
                let at = |p: Point| geo.inside(p.x as f32, p.y as f32);

                for p in &map.meta.spawn_points {
                    assert!(at(*p), "{scale:?}/{seed}: spawn {p:?} outside the rim");
                    checked += 1;
                }
                for p in &map.meta.surface_points {
                    assert!(at(*p), "{scale:?}/{seed}: surface {p:?} outside the rim");
                    checked += 1;
                }
                // The rocks, by their **bounding radius**, not their centres:
                // a centre inside the rim with lumps through it is the failure
                // `no_asteroid_pixel_touches_the_rim` reads off the mask, and
                // this is the cheap metadata-side statement of the same thing.
                for a in &map.meta.asteroids {
                    assert!(
                        at(Point::new(a.x, a.y)),
                        "{scale:?}/{seed}: rock centre ({}, {}) outside the rim",
                        a.x,
                        a.y
                    );
                    checked += 1;
                    // And clear of every spawn by a body, which is the other
                    // half of the deliverable: nothing intersects a spawn.
                    for sp in &map.meta.spawn_points {
                        let (dx, dy) = ((a.x - sp.x) as f32, (a.y - sp.y) as f32);
                        let gap = (dx * dx + dy * dy).sqrt() - a.r as f32;
                        assert!(
                            gap >= PLAYER_H,
                            "{scale:?}/{seed}: a rock is {gap:.0} px from spawn {sp:?}, inside \
                             the {PLAYER_H:.0} px body clearance"
                        );
                    }
                }
                for p in &map.meta.teleport_pads {
                    assert!(at(p.pos), "{scale:?}/{seed}: pad outside the rim");
                    checked += 1;
                }
                for g in &map.meta.gun_platforms {
                    assert!(at(g.pos), "{scale:?}/{seed}: platform outside the rim");
                    checked += 1;
                }
                for b in &map.meta.buried_slots {
                    assert!(at(b.pos), "{scale:?}/{seed}: buried slot outside the rim");
                    checked += 1;
                }
                for d in &map.meta.decorations {
                    assert!(at(d.pos), "{scale:?}/{seed}: decoration outside the rim");
                    checked += 1;
                }
                for o in &map.meta.objects {
                    assert!(
                        at(Point::new(o.x, o.y)),
                        "{scale:?}/{seed}: object outside the rim"
                    );
                    checked += 1;
                }
            }
        }
        println!("{checked} placed positions checked against the rim");
        assert!(
            checked > 0,
            "nothing was checked: every collection in `MapMeta` is empty, so this test \
             cannot see a thing placed outside the rim"
        );
    }

    /// **R32, half one: the ground fill never runs on a space map, and now it
    /// cannot.**
    ///
    /// `T22.05A` measured pass 8 filling ground on 0 of 900 space maps and
    /// asked `T22.05B` to fire the `reanalyse` guard that fact leaves inert.
    /// What this task did instead made it *structurally* zero: the fill loops
    /// over the pads and the platforms, and this mode ships neither. That is a
    /// stronger statement than the measurement, and it is the honest one — so
    /// it is asserted here rather than left as a sentence in a report, and the
    /// guard is exercised directly by the test below.
    ///
    /// `generate_full_with(.., fill)` is the switch T21.28 left for its own
    /// control: with `fill = true` and `fill = false` producing the same mask,
    /// nothing was filled.
    #[test]
    fn no_ground_is_filled_on_a_space_map() {
        for scale in MapScale::ALL {
            let filled = generate_full_with(4242, scale, 0, MapGenerator::Space, true);
            let unfilled = generate_full_with(4242, scale, 0, MapGenerator::Space, false);
            assert_eq!(
                filled.mask.hash(),
                unfilled.mask.hash(),
                "{scale:?}: pass 8 changed a space map's mask"
            );
        }
        // The control: on a landscape map the switch really does change the
        // mask, so the equality above is a fact about space and not about a
        // flag that does nothing.
        let scale = MapScale::Medium;
        let a = generate_full_with(4242, scale, 0, DEFAULT_MAP_GENERATOR, true);
        let b = generate_full_with(4242, scale, 0, DEFAULT_MAP_GENERATOR, false);
        assert_ne!(
            a.mask.hash(),
            b.mask.hash(),
            "control: the fill switch changed nothing on a landscape map either"
        );
    }

    /// **R32, half two: the guard itself, fired.**
    ///
    /// `gen::reanalyse` exists so that pass 8's re-derivation cannot swap a
    /// space map's verdict for a walking one. The branch is unreachable in
    /// production (see above), which is precisely why it needs a fixture: *an
    /// unexercised branch is the problem; the guard is not.*
    ///
    /// The fixture is a real space map with real ground filled into it —
    /// `fill_standing_ground` at a spawn point's feet, the same call pass 8
    /// makes — and the assertions are the three things the guard buys:
    ///
    /// 1. the space verdict survives: `traversable_fraction` is still 1.0 and
    ///    `passed` is still true;
    /// 2. `largest_component` still indexes the whole surface;
    /// 3. **the control** — `traversal::analyse` over the *same* inputs returns
    ///    something different. Without that third one the test passes for a
    ///    `reanalyse` that dispatches to the walking predicate and happens to
    ///    agree, which is the only way this guard can fail.
    #[test]
    fn the_space_verdict_survives_a_refill() {
        let scale = MapScale::Medium;
        let map = generate_with(4242, scale, MapGenerator::Space);
        let mut mask = map.mask.clone();

        // Fill ground under a hand-placed pad, the way pass 8 fills it under a
        // real one. This is the mask change the guard exists to survive.
        //
        // **The position is chosen so the fill can happen at all**, which is
        // the fiddly half of this fixture: `fill_column` adds nothing when the
        // gap to the rock below is 0 (a surface point is already seated) and
        // nothing when it exceeds `STANDING_GROUND_FILL_DEPTH` (open air, the
        // cliff-edge case T21.28 refuses). A spawn point is the second of
        // those, so the pad goes half a fill depth **above** an asteroid's
        // standable top — the ledge T21.28 was written for.
        let seat = *map
            .meta
            .surface_points
            .first()
            .expect("a space map has a surface");
        let pad = Point::new(seat.x, seat.y - STANDING_GROUND_FILL_DEPTH / 2);
        let filled: u64 = fill_standing_ground(&mut mask, pad, PAD_ART_W);
        assert!(
            filled > 0,
            "the fixture filled nothing, so it cannot exercise the branch"
        );

        let surface = crate::map::gen::surface_for(MapGenerator::Space, &mask);
        let report = crate::map::gen::reanalyse(
            MapGenerator::Space,
            &mask,
            &surface,
            &[],
            &map.meta.asteroids,
            &map.meta.spawn_points,
        );
        println!(
            "filled {filled} px; space verdict passed={} fraction={} component={} of {}",
            report.passed,
            report.traversable_fraction,
            report.largest_component.len(),
            surface.len()
        );
        assert!(
            report.passed,
            "the space verdict did not survive the refill"
        );
        assert_eq!(report.traversable_fraction, 1.0);
        assert_eq!(report.largest_component.len(), surface.len());

        // ------------------------------------------------------------------
        // The control, and it took two attempts to find one that discriminates.
        //
        // **The obvious control does not work, and that is a finding rather
        // than an inconvenience.** Over this same filled mask and arena
        // surface, `traversal::analyse` reports `passed = true,
        // traversable_fraction = 1.000` — *identical* to the space verdict.
        // R17 warned about exactly this (*"a scatter of asteroids within one
        // jetpack budget of each other could score surprisingly well"*) and
        // T22.05B's surface filter sharpened it: with the floor crust gone,
        // what is left is 71 points on rocks that are all within one climb of
        // each other, which is what `NavRegions` calls fully connected. So on
        // a **healthy** space map the two predicates are indistinguishable and
        // no assertion over one can see the guard.
        //
        // Where they differ is the clauses `traversal::analyse` does not have:
        // the rim's closure and the spawn count. So the control is a space map
        // with a hole punched in its rim — the hole `T22.10` will make — where
        // the space verdict must **fail** and the walking one still passes.
        // That is a difference only the dispatch can produce.
        let mut broken = mask.clone();
        let geo = crate::map::gen::space::SpaceGeometry::for_dims(broken.w, broken.h);
        let removed = crate::map::shape::carve_circle_counted(
            &mut broken,
            geo.cx.round() as i32,
            (geo.cy - geo.ry).round() as i32,
            (geo.thickness as i32) / 2 + 2,
        );
        assert!(removed > 0, "the control carved nothing");
        let broken_surface = crate::map::gen::surface_for(MapGenerator::Space, &broken);
        let broken_space = crate::map::gen::reanalyse(
            MapGenerator::Space,
            &broken,
            &broken_surface,
            &[],
            &map.meta.asteroids,
            &map.meta.spawn_points,
        );
        let broken_walking = crate::map::gen::traversal::analyse(&broken, &broken_surface, &[]);
        println!(
            "rim holed by {removed} px: space passed={} fraction={}, walking passed={} \
             fraction={:.3}",
            broken_space.passed,
            broken_space.traversable_fraction,
            broken_walking.passed,
            broken_walking.traversable_fraction
        );
        assert!(
            !broken_space.passed,
            "control: the space verdict passed a map with a hole in its rim"
        );
        assert!(
            broken_walking.passed,
            "control: the walking predicate also refused the holed map, so `reanalyse` \
             dispatching to it would be invisible here"
        );
    }

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

    /// T21.40 fixture: maps the 1000-seed sweep found short of `TELEPORT_PADS` after
    /// the fallback was removed — the maps where T21.28 perched a pad or platform.
    /// Taken from the sweep's "first maps short" lines (sweep seeds are
    /// `i * 2654435761 + 17`), one per scale plus Medium's three-pad map.
    const SHORT: [(u64, MapScale); 4] = [
        (621_137_968_091, MapScale::Small),
        (42_470_972_193, MapScale::Medium),
        (34_507_664_910, MapScale::Medium),
        (583_975_867_437, MapScale::Large),
    ];

    fn worst_gap(mask: &Mask, pos: Point, w: i32) -> i32 {
        drawn_columns(pos, w)
            .map(|col| {
                let mut d = 0;
                while pos.y + 1 + d < mask.h as i32 && !mask.get(col, pos.y + 1 + d) {
                    d += 1;
                }
                d
            })
            .max()
            .unwrap_or(0)
    }

    /// **The owner's rule (T21.40): nothing placed unseated.** Every pad and platform
    /// on the short maps and on ordinary ones has ground under every drawn column —
    /// zero air after the fill, never a drop past its reach. The short maps are the
    /// ones where T21.28's fallback perched things, so restoring the fallback turns
    /// this red; the control is that those maps really place something.
    #[test]
    fn every_placed_pad_and_platform_is_seated() {
        let mut maps: Vec<(u64, MapScale)> = SHORT.to_vec();
        for seed in [4242u64, 31337] {
            maps.extend(MapScale::ALL.iter().map(|s| (seed, *s)));
        }
        let (mut placed, mut unseated) = (0usize, Vec::new());
        for (seed, scale) in maps {
            let map = generate(seed, scale);
            for (pos, w) in map
                .meta
                .teleport_pads
                .iter()
                .map(|p| (p.pos, PAD_ART_W))
                .chain(
                    map.meta
                        .gun_platforms
                        .iter()
                        .map(|g| (g.pos, GUN_PLATFORM_W)),
                )
            {
                placed += 1;
                let worst = worst_gap(&map.mask, pos, w);
                if worst > 0 {
                    unseated.push(format!("{scale:?}/{seed}: {pos:?} over {worst} px of air"));
                }
            }
        }
        assert!(placed > 0, "nothing was placed, so 'all seated' is vacuous");
        assert!(
            unseated.is_empty(),
            "{} unseated: {unseated:?}",
            unseated.len()
        );
    }

    /// Fewer than the target is allowed — and happens: on every `SHORT` map the pads
    /// are under `TELEPORT_PADS`, and the ordinary maps are the control that the
    /// chooser still seats a full set where there is room.
    #[test]
    fn a_map_short_of_seated_ground_gets_fewer() {
        use crate::constants::TELEPORT_PADS;
        assert!(
            !SHORT.is_empty(),
            "no short maps named — the fixture measures nothing"
        );
        for (seed, scale) in SHORT {
            let n = generate(seed, scale).meta.teleport_pads.len();
            assert!(
                n < TELEPORT_PADS,
                "{scale:?}/{seed}: {n} pads — not short any more"
            );
        }
        let full = generate(4242, MapScale::Medium).meta.teleport_pads.len();
        assert_eq!(full, TELEPORT_PADS, "the control map lost pads");
    }

    /// 0 or at least `TELEPORT_PADS_MIN`, never a lone pad. The rule, unit-tested at
    /// `a_network_or_none` with the presence control (two survive) beside the absence
    /// (one does not), and held on real maps including the short ones.
    #[test]
    fn a_map_has_no_pads_or_a_network_never_one() {
        let p = |n: usize| {
            (0..n)
                .map(|i| Point::new(i as i32 * 500, 100))
                .collect::<Vec<_>>()
        };
        assert!(a_network_or_none(p(1)).is_empty(), "a lone pad survived");
        assert_eq!(
            a_network_or_none(p(TELEPORT_PADS_MIN)).len(),
            TELEPORT_PADS_MIN
        );
        assert!(a_network_or_none(p(0)).is_empty());
        let mut maps: Vec<(u64, MapScale)> = SHORT.to_vec();
        maps.push((4242, MapScale::Small));
        for (seed, scale) in maps {
            let n = generate(seed, scale).meta.teleport_pads.len();
            assert!(
                n == 0 || n >= TELEPORT_PADS_MIN,
                "{scale:?}/{seed}: {n} pads"
            );
        }
    }

    #[test]
    fn placed_teleport_pads_are_separated_and_standable() {
        use crate::constants::{SPAWN_MIN_SEPARATION, TELEPORT_PADS};
        for scale in MapScale::ALL {
            // Two seeds, not four. A population claim needs more than one draw
            // (`CLAUDE.md`) and this is every scale, which is what §A19 asks
            // for; the other two seeds cost 14 s of CPU beside the socket suite
            // and bought no new failure mode.
            for seed in [4242u64, 31337] {
                let map = generate(seed, scale);
                let pads = &map.meta.teleport_pads;
                // T21.40: up to `TELEPORT_PADS`; how many is the tests above.
                assert!(
                    pads.len() <= TELEPORT_PADS,
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
            // T21.40: the map's own pad count, which may be under `TELEPORT_PADS`;
            // the control is that it has some, or "all survived" is vacuous.
            let placed = map.meta.teleport_pads.len();
            assert!(
                placed >= crate::constants::TELEPORT_PADS_MIN,
                "{scale:?}: no pads to survive"
            );
            assert!(placed <= TELEPORT_PADS);
            assert_eq!(
                standing, placed,
                "{scale:?}: only {standing} of {placed} pads left standing"
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
                // T21.40: seated or not placed, so none is allowed too.
                assert!(
                    plats.len() <= GUN_PLATFORMS,
                    "{scale:?}/{seed}: {} platforms, expected 0..={GUN_PLATFORMS}",
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
            // 31337, not 4242: T21.40 seats platforms or places none, and 4242 Medium's
            // three were all perched (after the pad and spawn clearances it has three
            // candidates, none seated), so it now has none.
            let mut map = generate(31337, scale);
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
        let mut map = generate(31337, MapScale::Medium); // T21.40: 4242 Medium seats no platform
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
        let mut map = generate(31337, MapScale::Medium); // T21.40: 4242 Medium seats no platform
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
        // T21.40: one map may seat none (4242 Medium does), so the control is the
        // population: across these maps the clearance must leave platforms to check.
        let mut checked = 0;
        for scale in MapScale::ALL {
            for seed in [0u64, 1, 4242, 31337] {
                let map = generate(seed, scale);
                checked += map.meta.gun_platforms.len();
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
        assert!(
            checked > 0,
            "no map seated a platform, so 'none on a spawn' is vacuous"
        );
    }

    #[test]
    fn gun_platform_footprints_never_overlap_a_pad_footprint() {
        // T21.40: the population control, as in the spawn test above.
        let mut checked = 0;
        for scale in MapScale::ALL {
            for seed in [4242u64, 31337, 11] {
                let map = generate(seed, scale);
                // T21.40: a map may seat none; the population control is below.
                checked += map.meta.gun_platforms.len();
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
        assert!(
            checked > 0,
            "no map seated a platform, so 'no overlap' is vacuous"
        );
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
        let map = generate(31337, MapScale::Medium); // T21.40: 4242 Medium seats no platform
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
