//! Pass 6b: stamp destructible scenery into the terrain.
//!
//! `docs/73-amendments-v5.md` §D1, §D3, §D5.
//!
//! The masks themselves live in [`crate::map::objects`], embedded from
//! `assets/objects/masks.bin` at compile time. This module is the *placement*
//! pass: it decides where each one goes and ORs it into the terrain mask.
//!
//! ## Why the position in the pipeline is the whole task
//!
//! ```text
//! … 5 smoothing → 6 cleanup → 6b OBJECTS → 7 validation → 8 metadata
//! ```
//!
//! §D3 gives a reason for each neighbour, and every one of them is a bug that
//! would otherwise ship:
//!
//! - **After smoothing**, or the cellular automaton erodes thin branches and
//!   rounds every object into a blob.
//! - **After cleanup**, or components under `MIN_BLOB_PX` are deleted — which is
//!   most small crystals.
//! - **Before validation**, or an object that seals a cave mouth is never caught
//!   and `docs/10` §7's traversability guarantee becomes a lie.
//! - **Before metadata**, or surface points are extracted from a map without
//!   objects in it — and then items spawn inside trees and players inside rocks.
//!
//! Once stamped, an object **is** terrain: destructible by the same bit-exact
//! `carve_circle`, collidable by the same physics, with no new entity, no damage
//! path and nothing extra on the wire (§D1, §D8).

use crate::constants::{
    MapScale, OBJECT_CLEAR_OF_SPAWN, OBJECT_FOOTPRINT_SUPPORT, OBJECT_MIN_SEPARATION,
    OBJECT_PIXEL_BUDGET, OBJECT_PLACE_ATTEMPTS, OBJECT_SEAT_BAND, SKY_MARGIN, SPAWN_COUNT_MIN,
    WALL_W,
};
use crate::map::objects::{self, ObjectCategory, ObjectMask};
use crate::map::Mask;
use crate::math::Point;
use crate::rng::{chance, range_i32, substream};

use super::surface::is_standable;

/// One object, placed. Carried out of generation so pass 8 can keep spawns clear
/// of them and so the client can draw the art (§D6).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
#[cfg_attr(feature = "serde", derive(serde::Serialize, serde::Deserialize))]
pub struct PlacedObject {
    /// Index into the embedded table — and its position there (§B16).
    pub id: u32,
    /// Top-left of the stamped rectangle, in world pixels.
    pub x: i32,
    pub y: i32,
    pub w: u32,
    pub h: u32,
    /// Mirrored left to right. Exact on a bitmask and free, so 40 rocks are 80
    /// silhouettes (§D4) — stored as a flag rather than a second baked mask.
    pub flip: bool,
}

impl PlacedObject {
    /// The centre, which is what `OBJECT_MIN_SEPARATION` and
    /// `OBJECT_CLEAR_OF_SPAWN` are measured between (§D5).
    pub fn centre(&self) -> Point {
        Point::new(self.x + self.w as i32 / 2, self.y + self.h as i32 / 2)
    }
}

/// Why placement stopped, so a caller can tell the two apart.
///
/// **Two failure modes reported as one number is how a placement bug hides.** A
/// pass that placed 12 of 48 because the budget was full is working; a pass that
/// placed 12 because it could not find anywhere to stand is broken; both look
/// like "12".
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum StopReason {
    /// All `object_count` were placed.
    Complete,
    /// `OBJECT_PIXEL_BUDGET` was reached (§D5).
    BudgetFull,
    /// `OBJECT_PLACE_ATTEMPTS` ran out for one object (`docs/32` §2) — there was
    /// budget left, but nowhere to put anything.
    AttemptsExhausted,
}

/// What pass 6b did.
#[derive(Clone, Debug, PartialEq)]
pub struct Placement {
    pub objects: Vec<PlacedObject>,
    /// Solid pixels the pass actually added — not the objects' own solid counts,
    /// which double-count anything stamped into a hillside.
    pub spent_px: u64,
    pub budget_px: u64,
    pub stop: StopReason,
}

/// Which categories a theme prefers, as sampling weights (§D5).
///
/// Weights rather than a filter: a frost map with no bush at all reads as a
/// different game, and the point of the table is flavour, not exclusion.
fn theme_weights(theme: u8) -> [u16; 4] {
    // Indexed by `ObjectCategory::ALL`: bush, rock, crystal, ruin.
    match theme {
        0 => [6, 3, 1, 2], // grassland favours bushes
        1 => [1, 5, 1, 5], // desert favours rocks and ruins
        _ => [1, 4, 5, 2], // frost favours crystals and rocks
    }
}

/// Would the object at this rectangle stay inside the playable area?
fn inside_world(mask: &Mask, x: i32, y: i32, m: &ObjectMask) -> bool {
    x >= WALL_W as i32
        && y >= SKY_MARGIN as i32
        && x + m.w as i32 <= mask.w as i32 - WALL_W as i32
        && y + m.h as i32 <= mask.h as i32
}

/// OR one object's silhouette into the terrain. Returns the pixels added.
///
/// Counted as **pixels the mask did not already have**, not as the object's own
/// solid count: an object stamped half into a hillside adds only its exposed
/// half, and charging the budget for the buried half would stop placement early
/// for scenery nobody can see.
fn stamp(mask: &mut Mask, p: &PlacedObject, m: &ObjectMask) -> u64 {
    let mut added = 0;
    for oy in 0..m.h {
        for ox in 0..m.w {
            if !m.solid_flipped(ox, oy, p.flip) {
                continue;
            }
            let (wx, wy) = (p.x + ox as i32, p.y + oy as i32);
            if mask.get(wx, wy) {
                continue;
            }
            mask.set(wx, wy);
            added += 1;
        }
    }
    added
}

/// Pass 6b. Places up to `scale.params().object_count` objects and returns them.
///
/// Draws from `substream(seed, "objects")` and nothing else, so tuning any other
/// pass cannot move an object and draining any other stream cannot either
/// (`docs/10` §2).
pub fn stamp_objects(mask: &mut Mask, seed: u64, scale: MapScale, theme: u8) -> Placement {
    let count = scale.params().object_count as usize;
    let table = objects::count();
    let budget_px = ((mask.w as f64) * (mask.h as f64) * OBJECT_PIXEL_BUDGET as f64) as u64;
    let empty = |stop| Placement {
        objects: Vec::new(),
        spent_px: 0,
        budget_px,
        stop,
    };
    if count == 0 || table == 0 {
        return empty(StopReason::Complete);
    }

    let mut rng = substream(seed, "objects");
    let weights = theme_weights(theme);

    // Every id in the table, grouped by the category it belongs to, so a weighted
    // draw picks a category and then a member of it. Built once.
    let mut by_category: [Vec<u32>; 4] = [Vec::new(), Vec::new(), Vec::new(), Vec::new()];
    for id in 0..table as u32 {
        let Some(c) = objects::category(id as usize) else {
            continue;
        };
        by_category[c as usize].push(id);
    }
    if by_category.iter().all(|v| v.is_empty()) {
        return empty(StopReason::Complete);
    }

    let mut spent = 0u64;
    let mut stop = StopReason::Complete;
    let mut placed: Vec<PlacedObject> = Vec::with_capacity(count);

    // Zero the weight of a category the table has none of, or `pick_weighted`
    // keeps choosing an empty bucket and every attempt burns on nothing.
    let weight_values: Vec<u16> = ObjectCategory::ALL
        .iter()
        .map(|c| {
            if by_category[*c as usize].is_empty() {
                0
            } else {
                weights[*c as usize]
            }
        })
        .collect();

    // The smallest thing the table can stamp. When less than this is left, no
    // draw can ever succeed again and the budget is definitively what stopped
    // the pass — a fact about the state, not a tally of which check refused
    // most often. The tally was wrong: on a crowded map nearly every attempt
    // fails the separation test first and never reaches the budget test at all.
    let smallest_px = (0..table)
        .filter_map(objects::mask)
        .map(|m| m.solid_px() as u64)
        .min()
        .unwrap_or(0);

    'objects: for _ in 0..count {
        // Attempts that reached a legal, well-separated site. Reaching the
        // `break` below means none of them placed, and the only thing between a
        // sited attempt and a placement is the budget — so at the break,
        // `sited > 0` *is* "the budget refused everything that fitted".
        let mut sited = 0u32;

        // Rejection sampling, capped, then stop — never loop forever
        // (`docs/32` §2). Running out of room is an ordinary outcome on a heavily
        // carved map, not an error.
        for _ in 0..OBJECT_PLACE_ATTEMPTS {
            let slot = crate::rng::pick_weighted(&mut rng, &weight_values);
            let ids = &by_category[slot];
            if ids.is_empty() {
                continue;
            }
            let id = ids[range_i32(&mut rng, 0, ids.len() as i32 - 1) as usize];
            let Some(m) = objects::mask(id as usize) else {
                continue;
            };

            let Some(anchor) = surface_anchor(mask, &mut rng) else {
                continue;
            };

            // The anchor is a feet line: air at `anchor`, solid at `anchor.y + 1`.
            // T16.01 defines the object's anchor as `(w >> 1, h)` — `y = h` being
            // the ground line it sits *on*, one row below its last.
            //
            // **But a feet line is a player-sized answer.** `is_standable` tests a
            // `PLAYER_W` box at one column, so it says nothing about the ground
            // under the rest of a sprite three player-widths across — which is
            // the mid-air look §E12 is about. `seat` asks the object's own
            // footprint instead, and returns the row its base actually rests on.
            let x = anchor.x - m.w as i32 / 2;
            let Some(base) = seat(mask, x, anchor.y, &m) else {
                continue;
            };
            let y = base + 1 - m.h as i32;
            if !inside_world(mask, x, y, &m) {
                continue;
            }

            let flip = chance(&mut rng, 0.5);
            let candidate = PlacedObject {
                id,
                x,
                y,
                w: m.w,
                h: m.h,
                flip,
            };

            if too_close(&placed, candidate.centre()) {
                continue;
            }

            // Ask before spending: an object that would break the cap is skipped,
            // and the next draw may be a bush that fits where a ruin did not.
            sited += 1;
            if spent + m.solid_px() as u64 > budget_px {
                continue;
            }

            spent += stamp(mask, &candidate, &m);
            placed.push(candidate);
            continue 'objects;
        }
        // Every attempt for this object failed. Why is the difference between
        // "the map is full" and "placement is broken", so it is recorded rather
        // than collapsed into the object count.
        //
        // `smallest_px` is the whole table's smallest mask, so "the remainder is
        // under it" means no draw could ever have fitted. The remainder being
        // *over* it does not prove the opposite — all 200 draws may have been
        // ruins that did not fit while a bush would have — so the budget also
        // claims the run when every attempt that found a spot was refused for
        // room. Without that, a budget-bound run reports `AttemptsExhausted`:
        // the same misreport as the refusal tally this replaced, one level down.
        stop = if budget_px.saturating_sub(spent) < smallest_px || sited > 0 {
            StopReason::BudgetFull
        } else {
            StopReason::AttemptsExhausted
        };
        break;
    }

    Placement {
        objects: placed,
        spent_px: spent,
        budget_px,
        stop,
    }
}

/// What to do when the clearance rule leaves too few candidates to seat spawns.
#[derive(Copy, Clone, Debug, PartialEq, Eq)]
pub enum WhenStarved {
    /// Return the thin set as it is. Validation uses this: too few candidates
    /// **is** the map failing, and `generate_terrain` retries on the next seed.
    Reject,
    /// Return the unfiltered set instead. Pass 8 uses this, and it is reachable
    /// only on the safe preset — if validation passed, at least
    /// `SPAWN_COUNT_MIN` candidates survived. There, a spawn beside a bush beats
    /// five spawns on a six-player map.
    FallBack,
}

/// Component indices whose surface point is `OBJECT_CLEAR_OF_SPAWN` from every
/// object centre (§D5).
///
/// **One function, two callers.** Validation asks with `Reject` and pass 8 asks
/// with `FallBack`; the rule itself — which distance, measured between what — is
/// written once. It was written twice, and the copies already disagreed about
/// the fallback: harmless while both measure centre-to-centre, and a spawn
/// inside a rock on the rarest path the moment one of them starts measuring
/// edge-to-edge (`CLAUDE.md`: share the guard, or share the function).
pub fn clear_of_objects(
    surface: &[Point],
    component: &[usize],
    objects: &[PlacedObject],
    starved: WhenStarved,
) -> Vec<usize> {
    if objects.is_empty() {
        return component.to_vec();
    }
    let min = (OBJECT_CLEAR_OF_SPAWN as i64).pow(2);
    let centres: Vec<Point> = objects.iter().map(|o| o.centre()).collect();
    let kept: Vec<usize> = component
        .iter()
        .copied()
        .filter(|&i| {
            surface.get(i).is_some_and(|p| {
                centres.iter().all(|c| {
                    let (dx, dy) = ((c.x - p.x) as i64, (c.y - p.y) as i64);
                    dx * dx + dy * dy >= min
                })
            })
        })
        .collect();

    if starved == WhenStarved::FallBack && kept.len() < SPAWN_COUNT_MIN {
        component.to_vec()
    } else {
        kept
    }
}

fn too_close(placed: &[PlacedObject], centre: Point) -> bool {
    let min = (OBJECT_MIN_SEPARATION * OBJECT_MIN_SEPARATION) as i64;
    placed.iter().any(|p| {
        let c = p.centre();
        let (dx, dy) = ((c.x - centre.x) as i64, (c.y - centre.y) as i64);
        dx * dx + dy * dy < min
    })
}

/// A surface point to hang an object from, found by column rather than by
/// extracting the whole surface.
///
/// §D5 says "anchored to a surface point". Pass 7a's `extract_surface` is the
/// canonical set, but it runs *after* this pass and costs a full sweep of the
/// map; calling it twice per attempt would roughly double generation. Scanning
/// one random column down to the first standable row asks `is_standable` — the
/// same predicate, the one function that owns this question — for the same
/// answer, at a few hundred reads instead of a few hundred thousand.
///
/// The topmost standable row, so scenery sits on the outer landscape rather than
/// on a cave floor under an overhang.
fn surface_anchor(mask: &Mask, rng: &mut crate::rng::ChaCha8Rng) -> Option<Point> {
    let lo = WALL_W as i32;
    let hi = mask.w as i32 - WALL_W as i32 - 1;
    if hi <= lo {
        return None;
    }
    let x = range_i32(rng, lo, hi);
    for y in SKY_MARGIN as i32..mask.h as i32 - 1 {
        if is_standable(mask, x, y) {
            return Some(Point::new(x, y));
        }
    }
    None
}

/// How close below its base a column's ground must be to count as touching it.
///
/// A seated object's supporting columns have ground one row below the base, so
/// anything past a couple of pixels is a gap you can see.
const SEAT_CONTACT: i32 = 2;

/// Where an object `m` wide, placed with its left edge at `x`, actually rests —
/// or `None` if it would hang (§E12).
///
/// **The whole footprint, not a player-sized box at the centre.** For every
/// column the object covers, this finds the first solid row at or below the
/// candidate feet line, then seats the object at the **median** of those. Half
/// the base ends up buried in the slope and half stands proud, which is how a
/// boulder sits in a hillside — and it is the reason the rule is stated as a
/// median rather than a maximum or a minimum. Seating on the highest ground
/// leaves the low side hanging; seating on the lowest buries the object whole.
///
/// It refuses when fewer than `OBJECT_FOOTPRINT_SUPPORT` of its columns lie
/// within `OBJECT_SEAT_BAND` of that seat: a rock spanning a chasm, or perched
/// across a spike, fails; a rock on a slope passes.
fn seat(mask: &Mask, x: i32, feet: i32, m: &ObjectMask) -> Option<i32> {
    let w = m.w as i32;
    if w <= 0 || x < 0 || x + w > mask.w as i32 {
        return None;
    }
    // How far below the feet line a column may find its ground before the object
    // is considered to be hanging over a hole rather than sitting on a slope.
    let band = ((m.h as f32) * OBJECT_SEAT_BAND).round().max(1.0) as i32;
    let limit = (feet + band).min(mask.h as i32 - 1);

    let mut grounds: Vec<i32> = Vec::with_capacity(w as usize);
    for col in x..(x + w) {
        // Start one row below the feet line: the anchor row itself is air by
        // construction, and a column whose ground is *above* the feet line is a
        // rise the object will bury into, which is allowed.
        let mut g = None;
        for y in (feet + 1 - band).max(0)..=limit {
            if mask.get(col, y) {
                g = Some(y);
                break;
            }
        }
        if let Some(g) = g {
            grounds.push(g);
        }
    }
    // Every column that found ground within the band, out of the full width.
    // Columns that found none are the hanging ones and are counted against it.
    //
    // This is not the same statement as the `contact_fraction` check below. If
    // fewer than `want` columns find ground here, the percentile index clamps to
    // the deepest one and seats the object at the bottom of the band — where
    // `contact_fraction` then passes it, because the ground the search missed
    // sits within `SEAT_CONTACT` of that deeper seat. This gate is what refuses
    // the anchor; the one below checks the seat it chose.
    //
    // Measured: relaxing the gate below alone turns
    // `every_placed_object_rests_on_the_ground_under_it` red. Relaxing **this**
    // one alone left all thirty tests green — its only signal was the golden
    // table moving, which happens on any generation change and would be
    // attributed to something else. `a_footprint_that_mostly_finds_its_ground_
    // outside_the_band_is_refused` is the guard that was missing.
    let supported = grounds.len() as f32 / w as f32;
    if supported < OBJECT_FOOTPRINT_SUPPORT {
        return None;
    }
    grounds.sort_unstable();
    // **Seated at the `OBJECT_FOOTPRINT_SUPPORT` percentile of ground depth**,
    // so that fraction of the base is buried or touching *by construction*.
    //
    // The first version used the median, and the median is the wrong statistic
    // for the rule it was serving: seating halfway means half the base rests in
    // hollows it does not touch, which measured 51 % contact against a 60 %
    // requirement — the rule and its own threshold disagreeing. Taking the
    // percentile the requirement names makes the two the same statement.
    //
    // Deeper than the median also reads better: scenery that sits *in* the
    // ground looks placed, and scenery balanced on the highest point under it
    // looks dropped. That is the burial §E12 permits, chosen deliberately rather
    // than arrived at.
    //
    // **Over the object's full width, not over the columns that found ground.**
    // Taking it over `grounds.len()` meant 60 % of the 85 % that found any
    // ground — 51 % of the base, measured — because a column with no ground
    // under it at all is hanging and has to count against the fraction, not be
    // excluded from the denominator.
    let want = (OBJECT_FOOTPRINT_SUPPORT * w as f32).ceil() as usize;
    let idx = want.saturating_sub(1).min(grounds.len() - 1);
    let base = grounds[idx];
    // The base row sits one above the ground it rests on, matching the anchor
    // convention: `y = h` is the line the object sits *on*, not its last row.
    let seated = base - 1;

    // **Then check the seat that was actually chosen**, rather than trusting the
    // percentile that suggested it. The two can disagree: the ground search is
    // windowed around the *anchor's* feet line, so after seating deeper some
    // columns' ground falls outside the window it was picked from and is
    // misclassified — measured, that left a 105 px rock at 57 % against a 60 %
    // rule. Counting contact at the final position is one statement instead of
    // two that can drift apart.
    if contact_fraction(mask, x, seated, m) < OBJECT_FOOTPRINT_SUPPORT {
        return None;
    }
    Some(seated)
}

/// What fraction of an object's base is buried in, or touching, the terrain when
/// its base row sits at `base` (§E12).
///
/// A column counts if it is **buried** — solid at the base row, so the ground
/// rises through the object — or **resting**, with the first solid within
/// `SEAT_CONTACT` px below. Anything further down is a hollow the object bridges,
/// which is allowed for a minority of its width and is what "partial burial into
/// a slope" means in pixels.
fn contact_fraction(mask: &Mask, x: i32, base: i32, m: &ObjectMask) -> f32 {
    let w = m.w as i32;
    if w <= 0 {
        return 0.0;
    }
    let mut ok = 0;
    for col in x..(x + w) {
        if col < 0 || col >= mask.w as i32 {
            continue;
        }
        // **The rows directly beneath the base**, which this object never
        // occupies — so the same expression means the same thing before and
        // after stamping, and an object cannot hold itself up. Terrain is solid
        // downward, so a rise that buries the object's base also fills the row
        // below it: burial and resting are the one test, not two.
        if ((base + 1).max(0)..=(base + SEAT_CONTACT).min(mask.h as i32 - 1))
            .any(|y| mask.get(col, y))
        {
            ok += 1;
        }
    }
    ok as f32 / w as f32
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::map::gen::surface::extract_surface;
    use crate::map::gen::v2;

    fn flat_map(w: u32, h: u32, ground: i32) -> Mask {
        let mut m = Mask::new_empty(w, h);
        for y in ground..h as i32 {
            m.set_run(y, 0, w as i32 - 1);
        }
        m
    }

    /// The fraction of an object's base that is **touching** ground, recomputed
    /// from the finished map rather than from the placement code.
    ///
    /// Asking `seat` whether `seat` was satisfied is a function checking itself,
    /// so this reads the mask the generator produced — but it took three
    /// attempts to read the right thing:
    ///
    /// - **Proximity, not contact.** Allowing solid anywhere within
    ///   `OBJECT_SEAT_BAND` *below* the base is a 16 px window under a 63 px
    ///   rock, and on ordinary terrain nearly every column has ground within
    ///   16 px of nearly anything. It passed with the seating reverted.
    /// - **The object's own body.** An object *becomes* terrain (§D1), so the
    ///   post-stamp mask reads its own silhouette as the ground it rests on —
    ///   which scored the old player-box anchor at 95 %.
    /// - **Excluding every object.** Measuring against pre-stamp terrain is too
    ///   strict in the other direction: a boulder resting on an earlier boulder
    ///   is resting on terrain, and that is what the generator sees.
    ///
    /// So: the finished mask, asked the one question that cannot be confused —
    /// is there ground in the rows **directly beneath** the object's base, which
    /// the object itself can never occupy. Sharing `contact_fraction` with the
    /// placement rule rather than restating it, because two spellings of "is it
    /// touching" is how the last three attempts disagreed.
    fn supported_fraction(mask: &Mask, p: &PlacedObject, m: &ObjectMask) -> f32 {
        contact_fraction(mask, p.x, p.y + m.h as i32 - 1, m)
    }

    /// §E12: nothing hangs in the air, on any map this generator makes.
    #[test]
    fn every_placed_object_rests_on_the_ground_under_it() {
        let mut checked = 0;
        let mut all: Vec<f32> = Vec::new();
        let mut worst = 1.0f32;
        for seed in [1u64, 4242, 31337] {
            for scale in [MapScale::Small, MapScale::Medium, MapScale::Large] {
                let mut mask = v2::generate_once(seed, &v2::V2Params::default_for(scale)).mask;
                let placed = stamp_objects(&mut mask, seed, scale, 0).objects;
                for p in &placed {
                    let Some(m) = objects::mask(p.id as usize) else {
                        continue;
                    };
                    let f = supported_fraction(&mask, p, &m);
                    worst = worst.min(f);
                    all.push(f);
                    assert!(
                        f >= OBJECT_FOOTPRINT_SUPPORT,
                        "seed {seed} {scale:?}: object {} is {} px wide at ({}, {}) and only \
                         {:.0}% of its base has ground under it — it is hanging",
                        p.id,
                        m.w,
                        p.x,
                        p.y,
                        f * 100.0,
                    );
                    checked += 1;
                }
            }
        }
        // The control. Without it the assertion above passes for a generator
        // that places nothing at all, which is exactly what a too-strict seating
        // rule would produce.
        assert!(
            checked > 100,
            "only {checked} objects were placed across nine maps — the rule is rejecting \
             everything, so 'none of them hangs' means nothing",
        );
        let mut hist = [0usize; 5];
        for f in &all {
            hist[((f * 5.0) as usize).min(4)] += 1;
        }
        let mean: f32 = all.iter().sum::<f32>() / all.len() as f32;
        println!(
            "SEATING {checked} objects, worst {:.0}%, mean {:.0}%, buckets(0-20,..,80-100) {:?}",
            worst * 100.0,
            mean * 100.0,
            hist
        );
    }

    /// §E12's rule is a **fraction**, and it needs one case of each.
    ///
    /// A rule requiring every base column solid rejects the slopes burial is
    /// meant to allow; a rule requiring any permits the hanging it is meant to
    /// forbid. So the pair is the assertion: a slope is seated, an overhang is
    /// refused. Either alone passes for a rule that is wrong in the other
    /// direction — "nothing floats" is satisfied by placing nothing.
    #[test]
    fn a_slope_is_seated_and_an_overhang_is_refused() {
        let m = objects::mask(0).expect("the table has a first object");
        let w = m.w as i32;
        let h = m.h as i32;
        let ground = 300;

        // A slope under the whole footprint: the ground falls away by a quarter
        // of the object's height across its width, which is burial on the high
        // side and contact on the low.
        let mut sloped = Mask::new_empty(1024, 512);
        for col in 0..1024 {
            let drop = ((col - 100) as f32 / w as f32 * (h as f32 * 0.25)).max(0.0) as i32;
            for y in (ground + drop)..512 {
                sloped.set(col, y);
            }
        }
        assert!(
            seat(&sloped, 100, ground - 1, &m).is_some(),
            "a slope falling {} px across the object's {} px was refused — burial into a \
             slope is what §E12 permits",
            (h as f32 * 0.25) as i32,
            w,
        );

        // A ledge that ends under the object: solid for a quarter of the width,
        // then nothing for the rest. This is the mid-air case.
        let mut ledge = Mask::new_empty(1024, 512);
        for col in 100..(100 + w / 4) {
            for y in ground..512 {
                ledge.set(col, y);
            }
        }
        assert!(
            seat(&ledge, 100, ground - 1, &m).is_none(),
            "an object {w} px wide was seated on a ledge only {} px long — that is the \
             hanging §E12 forbids",
            w / 4,
        );
    }

    /// **The width gate's own case**, which nothing else covers.
    ///
    /// `seat` refuses twice: once on the fraction of columns that find ground
    /// *inside the seat band* (`grounds.len() / w`), and once on the contact of
    /// the seat it then chose. Measured, relaxing the second alone turns
    /// `every_placed_object_rests_on_the_ground_under_it` red — but relaxing the
    /// **first** alone left all thirty tests green, and its only signal was the
    /// golden table moving. A table that moves on every generation change is not
    /// a guard: the next relaxation would be attributed to whatever else was in
    /// the commit and ship in silence. This test is that missing guard.
    ///
    /// The case is the one the gate exists for. When fewer than `want` columns
    /// find ground in the band, the percentile index **clamps to the deepest one
    /// found**, seating the object at the bottom of the band instead of on the
    /// surface half its width is resting on — and `contact_fraction` then passes
    /// it, because the ground it missed sits within `SEAT_CONTACT` of that deeper
    /// seat. So the profile is three levels: a shallow majority, a deep sliver
    /// inside the band, and the rest just outside it.
    ///
    /// With the control, because "it was refused" is satisfied by a gate that
    /// refuses everything: the same three levels with the in-band share pushed
    /// over `OBJECT_FOOTPRINT_SUPPORT` is seated.
    #[test]
    fn a_footprint_that_mostly_finds_its_ground_outside_the_band_is_refused() {
        let m = objects::mask(0).expect("the table has a first object");
        let w = m.w as i32;
        let feet = 300;
        let band = ((m.h as f32) * OBJECT_SEAT_BAND).round().max(1.0) as i32;
        let limit = feet + band;
        let deep = (w / 20).max(1);

        // `shallow` columns at the top of the band, `deep` at its very bottom,
        // and the remainder just below the band — outside the ground search
        // entirely, and outside `contact_fraction` too from any seat but the
        // deep one the clamp produces.
        let profile = |shallow: i32| {
            let mut mask = Mask::new_empty(1024, 512);
            for col in 0..1024 {
                let k = col - 100;
                let g = if !(0..w).contains(&k) || k < shallow {
                    feet + 1
                } else if k < shallow + deep {
                    limit
                } else {
                    // The deepest row `contact_fraction` still reaches from a
                    // seat on `limit`: outside the ground search, inside contact.
                    limit + SEAT_CONTACT - 1
                };
                for y in g..512 {
                    mask.set(col, y);
                }
            }
            mask
        };

        let in_band = |shallow: i32| (shallow + deep) as f32 / w as f32;

        let short = w / 2;
        assert!(
            in_band(short) < OBJECT_FOOTPRINT_SUPPORT,
            "the refused case must actually be short of the rule: {:.2} is not under {}",
            in_band(short),
            OBJECT_FOOTPRINT_SUPPORT
        );
        assert!(
            seat(&profile(short), 100, feet, &m).is_none(),
            "only {:.0}% of a {w} px footprint found ground inside the {band} px band and it              was seated anyway — the percentile clamped to the deepest of too few and buried              it, which is what this gate exists to refuse",
            in_band(short) * 100.0,
        );

        // The control. Same terrain, same seat band, enough of the width inside
        // it — so the refusal above is the fraction and not the shape.
        let long = (w as f32 * 0.8) as i32;
        assert!(
            in_band(long) >= OBJECT_FOOTPRINT_SUPPORT,
            "the accepted case must actually satisfy the rule: {:.2} is not at least {}",
            in_band(long),
            OBJECT_FOOTPRINT_SUPPORT
        );
        assert!(
            seat(&profile(long), 100, feet, &m).is_some(),
            "{:.0}% of the footprint found ground inside the band and it was still refused —              the gate is rejecting the shape, not the fraction",
            in_band(long) * 100.0,
        );
    }

    /// §E15's sizes, asserted against the art rather than against a literal.
    ///
    /// The pipeline computes `factor = PLAYER_H * target / mean_opaque_height`,
    /// and `mean_opaque_height` is a property of the **pack**, not of the
    /// constants — so an exact pixel count would pin the art and break the first
    /// time a sprite is replaced. The tolerance is the integer scaler's: each
    /// sprite's height rounds to a whole pixel, so a mean over forty is within
    /// one of the target.
    #[test]
    fn each_category_is_scaled_to_the_height_its_constant_asks_for() {
        use crate::constants::{
            OBJECT_TARGET_PLAYER_H_BUSH, OBJECT_TARGET_PLAYER_H_CRYSTAL,
            OBJECT_TARGET_PLAYER_H_ROCK, OBJECT_TARGET_PLAYER_H_RUIN, PLAYER_H,
        };
        for (cat, target) in [
            (ObjectCategory::Bush, OBJECT_TARGET_PLAYER_H_BUSH),
            (ObjectCategory::Rock, OBJECT_TARGET_PLAYER_H_ROCK),
            (ObjectCategory::Crystal, OBJECT_TARGET_PLAYER_H_CRYSTAL),
            (ObjectCategory::Ruin, OBJECT_TARGET_PLAYER_H_RUIN),
        ] {
            let hs: Vec<f32> = (0..objects::count())
                .filter_map(objects::mask)
                .filter(|m| m.category == cat)
                .map(|m| m.h as f32)
                .collect();
            assert!(!hs.is_empty(), "{cat:?} has no objects in the table");
            let mean = hs.iter().sum::<f32>() / hs.len() as f32;
            let want = PLAYER_H * target;
            assert!(
                (mean - want).abs() <= 1.0,
                "{cat:?} means {mean:.1} px tall against {want:.1} asked for by its \
                 constant ({} sprites)",
                hs.len(),
            );
        }
    }

    #[test]
    fn the_table_is_available_to_this_pass() {
        // The control for every assertion below: with an empty table nothing is
        // ever placed and every "objects respect X" test passes vacuously.
        assert!(objects::count() > 0, "no object masks are embedded");
        for c in ObjectCategory::ALL {
            assert!(
                (0..objects::count()).any(|i| objects::category(i) == Some(c)),
                "no {c:?} in the table"
            );
        }
    }

    #[test]
    fn objects_are_placed_and_add_solid_pixels() {
        let mut mask = flat_map(1024, 512, 400);
        let before = mask.count_solid();
        let placed = stamp_objects(&mut mask, 4242, MapScale::Small, 0).objects;
        assert!(!placed.is_empty(), "nothing was placed on an open map");
        assert!(
            mask.count_solid() > before,
            "objects were placed but the mask did not change"
        );
    }

    #[test]
    fn the_same_seed_places_the_same_objects_twenty_times() {
        let first = {
            let mut m = flat_map(1024, 512, 400);
            let p = stamp_objects(&mut m, 99, MapScale::Small, 1).objects;
            (m.hash(), p)
        };
        for _ in 0..20 {
            let mut m = flat_map(1024, 512, 400);
            let p = stamp_objects(&mut m, 99, MapScale::Small, 1).objects;
            assert_eq!(m.hash(), first.0);
            assert_eq!(p, first.1);
        }
    }

    #[test]
    fn draining_another_substream_does_not_move_an_object() {
        // Sub-stream isolation (`docs/10` §2). Burn a lot of the "items" stream
        // and check that "objects" is untouched.
        let mut m1 = flat_map(1024, 512, 400);
        let a = stamp_objects(&mut m1, 7, MapScale::Small, 0).objects;

        let mut items = substream(7, "items");
        for _ in 0..10_000 {
            let _ = range_i32(&mut items, 0, 1000);
        }

        let mut m2 = flat_map(1024, 512, 400);
        let b = stamp_objects(&mut m2, 7, MapScale::Small, 0).objects;
        assert_eq!(a, b);
        assert_eq!(m1.hash(), m2.hash());
    }

    #[test]
    fn centres_respect_the_minimum_separation() {
        let mut mask = flat_map(2048, 1024, 800);
        let placed = stamp_objects(&mut mask, 31337, MapScale::Large, 1).objects;
        assert!(placed.len() > 1, "need at least two objects to compare");
        for (i, a) in placed.iter().enumerate() {
            for b in &placed[i + 1..] {
                let (ca, cb) = (a.centre(), b.centre());
                let d2 = ((ca.x - cb.x) as i64).pow(2) + ((ca.y - cb.y) as i64).pow(2);
                assert!(
                    d2 >= (OBJECT_MIN_SEPARATION as i64).pow(2),
                    "{ca:?} and {cb:?} are {:.1} px apart",
                    (d2 as f64).sqrt()
                );
            }
        }
    }

    #[test]
    fn the_pixel_budget_is_never_exceeded() {
        let (w, h) = (1024u32, 512u32);
        let mut mask = flat_map(w, h, 400);
        let before = mask.count_solid();
        let p = stamp_objects(&mut mask, 5, MapScale::Large, 1);
        let added = mask.count_solid() - before;
        let cap = (w as f64 * h as f64 * OBJECT_PIXEL_BUDGET as f64) as u64;
        assert!(added <= cap, "added {added} px against a cap of {cap}");
        assert_eq!(p.spent_px, added, "the pass miscounted what it added");
        assert_eq!(p.budget_px, cap);
        assert!(!p.objects.is_empty());
    }

    /// **Neither cap binds in production any more, and that is the point of
    /// driving `stamp_objects` directly here.** Since Small came down to 12 the
    /// pass places its full target on every measured seed (mean 12.0 over 333),
    /// so a test that went through `generate()` would exercise the `Complete`
    /// arm and nothing else. These three drive the pass on hand-built masks
    /// chosen to make each cap the binding one — live code either way, just not
    /// a state a shipping map reaches.
    #[test]
    fn the_budget_is_what_stops_a_crowded_map_not_the_attempt_cap() {
        // The control for the test above, which a pass that placed nothing would
        // also satisfy — and the distinction that matters: a run that stops
        // because the map is full is working, a run that stops because it could
        // not find anywhere to stand is broken, and both look like "placed 12".
        let (w, h) = (1024u32, 512u32);
        let mut mask = flat_map(w, h, 400);
        let p = stamp_objects(&mut mask, 5, MapScale::Large, 1);
        assert!(
            p.objects.len() < MapScale::Large.params().object_count as usize,
            "placed all {} — the budget never bound, so the cap assertion is vacuous",
            p.objects.len()
        );
        assert_eq!(
            p.stop,
            StopReason::BudgetFull,
            "stopped after {} objects and {}/{} px — for the wrong reason",
            p.objects.len(),
            p.spent_px,
            p.budget_px
        );
    }

    /// The third arm, which otherwise appears only at its construction site.
    ///
    /// A map with room in the budget but almost nowhere to stand: a narrow ledge
    /// on an otherwise empty canvas. The budget is 2% of a big canvas and is
    /// never touched; what runs out is places to put things.
    #[test]
    fn nowhere_to_stand_with_budget_to_spare_is_attempts_exhausted() {
        let mut mask = Mask::new_empty(4096, 2048);
        // One short ledge, wide enough for a couple of objects and no more.
        for y in 1000..1010 {
            mask.set_run(y, 2000, 2200);
        }
        let p = stamp_objects(&mut mask, 3, MapScale::Large, 0);
        assert_eq!(
            p.stop,
            StopReason::AttemptsExhausted,
            "placed {} of {} using {}/{} px",
            p.objects.len(),
            MapScale::Large.params().object_count,
            p.spent_px,
            p.budget_px
        );
        assert!(
            p.objects.len() < MapScale::Large.params().object_count as usize,
            "everything fitted, so nothing was exhausted"
        );
        // The control that separates this arm from `BudgetFull`: there was plenty
        // of budget left, so the cap is not what stopped it.
        assert!(
            p.budget_px - p.spent_px > p.budget_px / 2,
            "spent {}/{} — the budget was the real constraint",
            p.spent_px,
            p.budget_px
        );
    }

    #[test]
    fn a_roomy_map_places_every_object_and_says_so() {
        // The other side of the control: given room, the pass completes rather
        // than quietly running out of attempts.
        let mut mask = flat_map(4096, 2048, 1600);
        let p = stamp_objects(&mut mask, 77, MapScale::Small, 0);
        assert_eq!(p.stop, StopReason::Complete, "placed {}", p.objects.len());
        assert_eq!(
            p.objects.len(),
            MapScale::Small.params().object_count as usize
        );
        assert!(p.spent_px < p.budget_px);
    }

    #[test]
    fn a_carve_removes_object_pixels_like_any_terrain() {
        let mut mask = flat_map(1024, 512, 400);
        let placed = stamp_objects(&mut mask, 4242, MapScale::Small, 0).objects;
        let target = placed.first().expect("an object");
        let c = target.centre();

        let solid_before = mask.count_run(c.y, target.x, target.x + target.w as i32 - 1);
        assert!(solid_before > 0, "the object row was empty before carving");

        crate::map::shape::carve_circle_counted(&mut mask, c.x, c.y, 40);
        let solid_after = mask.count_run(c.y, target.x, target.x + target.w as i32 - 1);
        assert!(
            solid_after < solid_before,
            "carving over an object removed nothing"
        );
    }

    #[test]
    fn objects_stay_inside_the_walls_and_out_of_the_sky_band() {
        let mut mask = flat_map(1024, 512, 400);
        for p in stamp_objects(&mut mask, 12, MapScale::Medium, 2).objects {
            assert!(p.x >= WALL_W as i32, "{p:?} crosses the left wall");
            assert!(
                p.x + p.w as i32 <= mask.w as i32 - WALL_W as i32,
                "{p:?} crosses the right wall"
            );
            assert!(p.y >= SKY_MARGIN as i32, "{p:?} is in the sky band");
            assert!(
                p.y + p.h as i32 <= mask.h as i32,
                "{p:?} runs off the bottom"
            );
        }
    }

    #[test]
    fn placement_terminates_on_a_map_with_nowhere_to_stand() {
        // `docs/32` §2: capped, then stop. A solid block has no standable row, so
        // every attempt fails; this must return rather than spin.
        let mut mask = Mask::new_full(512, 256);
        let placed = stamp_objects(&mut mask, 1, MapScale::Small, 0);
        assert!(placed.objects.is_empty());
    }

    /// **The assertion that proves the pass position**, and the one T16.02 names.
    ///
    /// Surface extraction runs *after* 6b, so the surface it produces has to
    /// include rows on top of the objects. Move the pass after pass 9 and this
    /// goes red; move it after cleanup and it stays green while the map quietly
    /// spawns players inside rocks.
    #[test]
    fn surface_points_extracted_afterwards_include_object_tops() {
        let mut mask = flat_map(2048, 1024, 800);
        let before = extract_surface(&mask);
        let placed = stamp_objects(&mut mask, 4242, MapScale::Large, 0).objects;
        let after = extract_surface(&mask);
        assert!(!placed.is_empty());

        // A point that is standable now, was not before, and sits above the old
        // ground line — that is a rock you can stand on.
        let ground = 800;
        let on_top: Vec<&Point> = after
            .iter()
            .filter(|p| p.y < ground - 1 && !before.contains(p))
            .collect();
        assert!(
            !on_top.is_empty(),
            "no new standable point above the ground line: objects are in the mask \
             but the surface was extracted without them"
        );
    }

    /// The control for the test above: without the stamp there is nothing to
    /// stand on, so the property is a property of this pass and not of the map.
    #[test]
    fn without_the_stamp_there_are_no_points_above_the_ground_line() {
        let mask = flat_map(2048, 1024, 800);
        let surface = extract_surface(&mask);
        assert!(
            surface.iter().all(|p| p.y >= 800 - 1),
            "a flat map already has standable ground above its own ground line"
        );
    }

    #[test]
    fn the_generator_runs_the_pass_and_the_borders_still_hold() {
        // The production path, not a fixture: `generate_once` must carry objects.
        let o = v2::generate_once(4242, &v2::V2Params::default_for(MapScale::Small));
        assert!(!o.objects.is_empty(), "the v2 pipeline placed no objects");
        assert!(crate::map::gen::borders_hold(&o.mask), "borders");
    }

    /// The precondition `scripts/checks/objects.mjs` depends on.
    ///
    /// §D6 requires an object crossing a chunk boundary to draw in **both**,
    /// offset. The only assertion that can see that is the browser check, and it
    /// runs on `FIXED_SEED` 4242 at Small — so if generation drifts and that map
    /// stops having a straddling object, the seam requirement silently loses all
    /// coverage. Counted here instead, where the fast gate can see it: seed
    /// 31337 at Small has none, so this is a real property of a real seed and not
    /// a thing every map happens to have.
    #[test]
    fn seed_4242_small_has_an_object_across_a_chunk_seam() {
        let chunk = crate::constants::CHUNK_SIZE as i32;
        let map = crate::map::generate(4242, MapScale::Small);
        let spanning = map
            .meta
            .objects
            .iter()
            .filter(|o| o.x / chunk != (o.x + o.w as i32 - 1) / chunk)
            .count();
        assert!(
            spanning > 0,
            "no object crosses a vertical chunk seam on seed 4242/Small — \
             scripts/checks/objects.mjs can no longer exercise §D6's seam case"
        );
    }

    #[test]
    fn a_theme_shifts_which_categories_appear() {
        // Weighted, not filtered — so this asserts the *mix* moves, not that a
        // category vanishes. Aggregated over seeds: one draw proves nothing.
        let count_ruins = |theme: u8| {
            let mut n = 0;
            for seed in 0..12u64 {
                let mut m = flat_map(2048, 1024, 800);
                for p in stamp_objects(&mut m, seed, MapScale::Large, theme).objects {
                    if objects::category(p.id as usize) == Some(ObjectCategory::Ruin) {
                        n += 1;
                    }
                }
            }
            n
        };
        let grassland = count_ruins(0);
        let desert = count_ruins(1);
        assert!(
            desert > grassland,
            "desert drew {desert} ruins, grassland {grassland}"
        );
    }
}
