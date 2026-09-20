# M22 — the coordinator's rulings

**Made 2026-09-20, by me, on the owner's instruction:** *"lets do m22. be creative. run
subagent coders and harsh reviewers for CRs. loop till its perfect. make your own decisions."*

`M22-space.md` lists nine things it said the owner owed a ruling on. All nine are ruled
here, plus the four design calls the task files left to whoever picked them up. **Every one
is reversible and none is written into `docs/`** — each carries a "Reverse it by" line
naming the one place to change.

**Builders: read this file after your task file and before you write code.** Where a task
file says *"owner question N"* or *"decide before writing"*, the answer is below and it is
binding. Where this file is silent, the task file wins.

---

## R1 — Contact in zero-g: you **stop**, and you can stand

*Milestone question 1 · `T22.03`*

A body that hits something loses the velocity component **into** the surface and keeps the
component **along** it. Zero restitution, no bounce. Tangential motion survives, so grazing
a rock sends you sliding along it rather than pinning you to it.

**Why not bounce.** Nothing damps in this mode, so a bouncing body never loses energy: one
shove and a player pinballs between asteroids for the rest of the round with no way to stop
and no way to aim. "Constant until they hit something" is the owner's sentence and *stop* is
its straight reading. The reference image is astronauts **standing on rocks**, which bounce
cannot produce.

**This costs zero lines, and that is the trap.** `resolve.rs::move_x` already zeroes only
`vel.x` on a wall and `move_y` only `vel.y` on a floor or ceiling — which *is* this rule. So
a test named *"a collision stops you along the normal and preserves the tangential"* passes
today, under standard gravity, **with the new code deleted**. It tests the framework. This
ruling is a decision to record, not a feature to build; the test that earns its keep is the
**no-damping** one.

**Reverse it by:** the contact branch in `physics/resolve.rs` — the same two lines that
already zero `vel.x` in `move_x` and `vel.y` in `move_y`. A restitution coefficient of 0.0
is what those lines are; a bounce is that constant nonzero.

## R2 — The suit shield **is** the shield that already exists

*Milestone question 2 · `T22.09`*

Option **(a)**. `PlayerState::shield_active(now)` keeps meaning exactly one thing — *is a
shield up* — and gains a second **source**: the spacesuit, in space, while the battery has
charge. One predicate, two ways to satisfy it.

The two consequences the task file names are both accepted deliberately:

- a shield generator picked up in a normal match also grants radiation immunity in a mode
  that has no radiation — harmless, and it is what "one predicate" means;
- the suit's shield multiplies incoming weapon damage by `SHIELD_DAMAGE_MULT` — **and that
  is a feature, not a side effect.** A spacesuit that softens a hit is the right reading of
  a spacesuit, and it gives the energy economy a second reason to matter. Say it in the
  code so the next reader does not file it as a bug.

**This is the field-means-two-things rule applied, not ignored.** (b) is the shape that rule
warns about: `shield_active` would answer *"does damage get multiplied"* and *"am I safe
from radiation"* and the two would be free to disagree.

**Reverse it by:** `PlayerState::shield_active` — split it into `shield_absorbs()` and
`shield_seals()` and give the suit only the second.

## R3 — Low gravity **stays**, and it is built third

*Milestone question 3 · `T22.02`*

Keep it. The owner asked for *"gravity: standard, low, none"* in the original brief and
never withdrew it; it is ~200 lines; and it is the cheap mode that makes the setting a
*setting* rather than a boolean with a long name.

`T22.01`'s enum is `standard | low | space`, as written.

**It is scheduled early on purpose.** `T22.02` walks the gravity-scale seam — including the
finding that `projectile.rs` has **two copies** of the gravity term — before `T22.11`
rewrites that area. Landing it after `T22.11` means walking it twice.

**Reverse it by:** deleting `T22.02` and dropping `Low` from the enum in `constants.rs`.
The setting round-trip, the lobby row and the replay header are all `T22.01`'s and do not
change.

## R4 — `grounded` in zero-g is **real, and earned by contact from below**

*Milestone question 4 · `T22.03`*

- `grounded` becomes true when the downward probe finds a blocking overlap — the same probe
  as today, **minus** today's requirement that `vel.y` be strictly positive. A player who
  drifts *sideways* onto the top of an asteroid lands on it.
- Contact on any **other** side stops you (R1) but does **not** ground you. You are held
  against a wall, not standing on a floor.
- `ground_snap` is **off** in space: it exists to keep a walker glued to a downhill slope,
  and there is no walking downhill here.
- Fall damage is **off** in space. There is no fall. `T22.03` does not get to invent impact
  damage as the collision rule — that is a separate feature and nobody asked for it.
- Coyote time and the jump buffer keep working, because a grounded player on an asteroid is
  an ordinary grounded player.

**Why not "always false".** It is one line, and it costs the mode everything that makes the
reference image true: standing, walking on a rock you landed on, jumping off it. A player
who can never be grounded can never do anything but drift.

**Why not "true on any contact".** Then a player held against the underside of a rock is
"standing" on it, walks along it upside down, and every upright-drawn thing is wrong — which
is R7's expensive problem arriving through the back door.

**Reverse it by:** the `grounded` branch in `move_y` and the space arm of the `ground_snap`
call in `integrate`.

## R5 — Bots fly, and it is in scope

*Milestone question 5 · `T22.03`*

Bots get a space locomotion layer. **Target selection, aiming and firing are untouched** —
only the part that turns "I want to be over there" into inputs changes: thrust toward the
desired direction, burn fuel like a player, stop thrusting when the velocity already points
where they want to go, and thrust *against* their own velocity when it does not.

**Not optional.** `balance.rs` measures a mode where bots are inert as a game with no
fights, and a mode nobody can playtest alone is a mode nobody playtests.

**If it makes `T22.03` exceed one file and ~250 lines, split it** into `T22.03B — bots in
space` and say so, per the scope rule. Do not finish at 800 lines.

**Reverse it by:** the space arm in `bots/mod.rs`'s movement step.

## R6 — Radiation is **ambient and constant**

*Milestone question 6 · `T22.09`*

Everywhere, all the time, 1 damage per second to an unshielded player. The straight reading
of *"players who dont have a shield are hit by radiation"*.

This makes the suit's battery the pacing clock of the whole mode and battery packs the item
you actually want, which is what the owner described. Zonal radiation would be a fourth
thing to dodge and the mode already has three.

**It is not silent.** A health bar that drifts down for no visible reason is T21.25's
finding restated. Ship the feedback with the damage, and assert it on rendered pixels.

**Reverse it by:** the predicate that decides who takes the tick — a zone test in place of
`true`.

## R7 — Players do **not** orient to an asteroid's surface

*Milestone question 7 · `T22.11` · the expensive one*

Up stays up. Screen-space "down" is unchanged, every sprite draws upright, the walk cycle,
the weapon flip, the hats, the labels and the bars are all untouched. Asteroid wells are a
**force**, not a frame of reference.

The reference image is every astronaut upright on a rock whatever side of it they are on.
That is the picture and it is also a tenth of the work.

**Reverse it by:** nothing, yet — and that is the point. If this is ever reversed it is a
rendering project of its own, not an edit; `T22.11` must therefore not bake "down is +y"
into the *physics*, only into the *drawing*.

## R8 — The black hole: every round, fixed size, one asteroid, frozen at the end

*Milestone question 8 · `T22.12`*

1. **Every round, random timing.** It arrives at a seeded random moment inside the last
   minute, in space, always. A closing pressure players can plan around beats a surprise
   that half the rounds never see — and "never arrives this round" is indistinguishable, to
   a player, from a bug.
2. **It does not grow.** One radius, one horizon, fixed at arrival. Growth makes the
   inescapability assertion time-dependent and the horizon a moving target for no gain that
   eating an asteroid does not already deliver.
3. **It eats exactly one asteroid, on arrival, and never again.** Keeps `T22.12`'s own test
   honest — *"exactly one asteroid is gone afterwards"* — and keeps the well bookkeeping to
   a single removal.
4. **At round end it freezes.** `Ended` stops the pull and the horizon, the way T21.30
   froze input; it stays **drawn**, because a hazard that vanishes on the results screen
   reads as a rendering bug. A corpse does not get dragged through the scoreboard.

**Reverse it by:** four separate places, deliberately — the arrival roll, the radius
constant, the eat-once guard, and the `Ended` arm. None of them is the other.

## R9 — The vortex: catches everyone, up to three, permanent, players only, off the minimap

*Milestone question 9 · `T22.10`*

1. **It catches a player wearing wings.** Yes, everyone. Wings refuse pads and platforms
   because those are things you *choose to use*; a vortex is a thing that happens to you.
   Say that distinction in the code beside the wings exemption, or the next reader reads
   an inconsistency.
2. **Many holes, at most three live vortices.** `MAX_ACTIVE_VORTICES = 3`; a fourth breach
   replaces the oldest, which stops pulling and fades. One-at-a-time is cheaper and duller;
   unbounded is a rim that is entirely mouth by the last minute.
3. **A hole never heals.** The cap in (2) is what keeps late rounds sane, so healing has no
   job left to do. `fill_circle` stays what its doc says it is — tests and tools.
4. **Players only.** Items, crates, tombstones and projectiles are not pulled. A rocket
   that curves into a vortex is a balance change nobody asked for, and items sucked off the
   map is loot deletion. Visually it is a *player* vortex and that is a consistent story.
5. **Not on the minimap.** It is a secret; the owner used that word. It is unmistakable in
   the world — a player who has seen one once knows what a breach does.

**Also, not listed as a question but owed an answer:** **fuel survives the trip**, exactly
as it does on a teleport pad, and for the identical recorded reason — a reset tank *"turned
every pad into a refuelling station"*, and in a mode where fuel is the whole economy that is
worse here, not better.

**Reverse it by:** (1) the wings check at the capture test; (2) `MAX_ACTIVE_VORTICES`;
(3) a heal timer, which does not exist; (4) the capture predicate's entity filter; (5) the
minimap draw list.

---

# The four design calls the task files left open

## R10 — Gravity becomes a `Forces` value, not a second argument and not a second function

*`T22.11` calls this "the single largest design call in M22". It is.*

`apply_gravity(body, gravity_scale, dt)` cannot express *"towards that point"*, and the
task file's two options — a `Vec2` **beside** the scalar, or a vector **replacing** it —
are both wrong in the way the rules here already name. A `Vec2` beside the scalar means two
things answer *"what accelerates this body"*. Replacing the scalar touches every caller
including standard gravity and deletes the clamp semantics that `MAX_FALL_SPEED` has.

**The ruling: one struct, one seam.**

```rust
pub struct Forces {
    pub gravity_scale: f32,   // the scalar path, unchanged, vel.y only
    pub accel: Vec2,          // the summed field, nothing today, wells tomorrow
    pub max_speed: Option<f32>, // the mode's terminal SPEED, |vel|, not vel.y
}
```

- `integrate(map, body, forces, dt)`. Every existing caller passes the moral equivalent of
  `Forces::gravity(1.0)` and behaves **bit-identically** — that is the control test.
- `apply_gravity` keeps its early return, its `vel.y`, its `MAX_FALL_SPEED` and its tests.
  The field is applied **beside** it, in `integrate`, on a path the early return does not
  skip. That is finding 3 in `T22.11` answered.
- `max_speed` clamps the **magnitude** of `vel`, which `MAX_FALL_SPEED` does not and
  cannot. It is `None` everywhere but space. `MAX_FALL_SPEED` is not reused and not
  renamed.

**"What accelerates this body" has exactly one answer and it is the `Forces` value.**

**`T22.11` introduces `Forces`, and nobody before it does.** `T22.02` and `T22.03` are
batch 2 and walk the existing scalar seam; a coder who brings `Forces` forward pre-empts the
task that owns it and makes the merge a rewrite of a rewrite. R3's "low gravity walks the
seam before T22.11 rewrites it" means exactly that.

**The cost that is invisible from `resolve.rs`.** `integrate` has five production callers and
four of them are not players: `weapons/placed.rs::Mines::step`, `items/world.rs::WorldItems::step`,
`world/tombstones.rs::Tombstones::step`, `world/animals.rs::Animals::tick` — each passing a
literal `1.0`, and **none of them can see the match setting today**; their signatures are
`(map, …, dt)`. That is four signature changes propagating up to `World::step`, and it is the
real cost of this ruling. **R14 rules what each of them does, so they are four mechanical
edits and not four design calls.** `apply_gravity` itself has exactly one production caller
(`integrate`), so its early return survives untouched — the cheapest part of this.

**Reverse it by:** `Forces` is one type with one construction site per mode; collapsing it
back to a scalar is deleting two fields.

## R11 — One attractor list, in `world/attractors.rs`, and `T22.11` writes it

*Three attractors share one summation: `T22.11`'s wells, `T22.10`'s vortex, `T22.12`'s hole.*

- **`T22.11` lands first and owns the file.** `T22.10` and `T22.12` push entries into the
  same list and write no loop of their own. **`T22.11` is therefore scheduled before
  `T22.10`**, which changes `M22-space.md`'s build order — that file allows either order
  and does not say which, and this makes the ownership unambiguous.
- One `Attractor { pos, strength, cutoff, kind }`, one sum, **iterated in a stable sorted
  order** — never a `HashMap`, for the reason `World::players` already gives — producing the
  `Forces::accel` of R10.
- The float-order fix, the prediction fix and the cutoff are written **once**.
- `kind` is what lets `T22.11`'s escape guarantee be scoped to `Kind::Asteroid` while
  `T22.12`'s horizon carries the inverse assertion. That scoping is the whole reason the
  two tasks do not contradict each other — see `T22.12`.

**Reverse it by:** it is one file with one public function; a second loop is what this
prevents, so reversing it means writing one.

## R12 — A solar flare is a **new hazard shape**, and `BurnField` is not widened

*`T22.08`, which says "decide before writing".*

New type, `effects/flare.rs`. `weapons/burn.rs` keeps its first line — *"Damaging ground
zones"* — and keeps meaning it.

**What is reused is the burn *duration* model, and only that**: *"burns for N seconds after
you touch it"* is the same shape as the flamethrower's lingering damage, and `FLAME`,
molotov and lava already share it. Lift that into something both call, or call the existing
one; do **not** move the ribbon into the ground-zone type to get at it.

`N = 4`, `SOLAR_FLARE_BURN_SECONDS`, in `constants.rs`, and — per the `ITEM_SPAWN_INTERVAL`
lesson — **the constant's value needs an assertion against a measured basis**, not only
tests pinned to it. Four seconds of burn against `BASE_HEALTH` is a stateable fraction of a
health bar; state it in the doc comment and assert the relation.

**Reverse it by:** `effects/flare.rs` is one file and one `KINDS` row.

## R13 — The rim is an **ellipse**, inset, of ordinary destructible rock, and outside it is void

*Revised 2026-09-20 after the T22.05A/B forward sweep. **The original ruling said "circle" and
was written on a wrong premise** — it assumed a circle in a roughly square map. It is not.*

**Every map is 2:1.** `MAP_SMALL_W/H = 2048/1024`, `MEDIUM 3072/1536`, `LARGE 4096/2048` —
measured, not remembered. A true circle is limited by the short axis, so r = h/2, and it
leaves **w − h px of dead map**: 1024 px on Small, **2048 px on Large — half the arena**, which
the camera pans over and the minimap draws empty. The original text said the circle leaves
`WALL_W` strips of 8 px. It is out by a factor of 64 and in the wrong direction.

**The ruling: an ellipse inscribed in the map rect, inset from the borders.** And the reason
is not a compromise, it is better than the circle:

- **The minimap is `MINIMAP_W = 200` × `MINIMAP_H = 100` — also 2:1.** An ellipse inscribed in
  a 2:1 map therefore **draws as a true circle on the minimap**, and the minimap is the only
  place the arena's shape is ever visible: the camera viewport is a small fraction of the map,
  so from inside you see an arc of rim and never a shape. **The owner's circle appears exactly
  where a circle can be seen**, and the arena is not half empty to buy it.
- The owner's own sentence offers the latitude: *"It can be squared, a circle, or some other
  shape that wraps everyone together."* **Wrapping everyone together is the requirement**; the
  reference image is how it was illustrated.
- **Inset it**, clear of `SKY_MARGIN` (96) at the top and `FLOOR_CRUST` (16) at the bottom.
  A full-height ellipse collides with `silhouette::force_borders`, which forces the sky band
  empty and the floor-crust band solid full-width, and `borders_hold` is asserted by
  `gen/mod.rs::every_scale_produces_the_right_dimensions_with_borders_intact`, the identically
  named test in `gen/v2/mod.rs`, and `tests/map_sweep.rs::thousand_seed_playability_sweep`.
  **Insetting keeps all three green and untouched**; disabling `force_borders` costs three
  amended tests to buy nothing.

**The rest of R13 stands:**

- The rim is **ordinary destructible mask**. Not `WALL_W`, not bedrock — `T22.10` is a whole
  task about breaking it.
- **Outside the rim there is nothing** — empty mask, the backdrop showing through. That is
  what makes the vortex a containment mechanism with something to contain.
- Asteroid **gravity level correlates with radius**, monotonically, with jitter.

**Two corrections to what the original R13 claimed about the world's edges**, both verified:

- **`BEDROCK_H` is `0`.** There is no indestructible floor; §C15 removed it. `Map::circle`'s
  bottom clamp `h - BEDROCK_H` is inert and `carve_circle`'s doc sentence *"Bedrock and the
  side walls are never touched"* is half-stale. The only indestructible border is the 8 px
  `WALL_W` side band below `SKY_MARGIN`. **Report that stale doc comment; do not fix it here.**
- **`clamp_to_world` has no bottom clamp** — it clamps x to the `WALL_W` bands and the **top**
  to `y >= half_h`, and nothing downward. So R13's original *"`clamp_to_world` already
  guarantees nobody leaves the world"* was **false**. What is below is `R16`.

**Reverse it by:** the rim-rasterising step in the space generator — one ellipse equation.
A circle is that equation with `rx = ry = h/2`.

## R14 — In space, only players are pulled. Everything else floats where it is put.

*Raised by the T22.02/T22.03 forward sweep, which found four judgement calls hiding behind
R10. Ruled here so `T22.11` inherits four mechanical edits instead.*

**The wells, the vortex and the black hole pull players and nothing else.** The owner's own
sentence is *"it pulls **players** towards it"*. Projectiles, items, crates, tombstones and
mines are not attracted — a rocket curving around a rock is a balance change nobody asked
for, and loot drifting into a rock is loot deletion.

**And every non-player body is at gravity scale 0 in space**, so it comes to rest where it
is put:

| body | in space | why |
|---|---|---|
| `weapons/placed.rs::Mines::step` | floats where placed | a mine hanging in space is a **floating proximity mine**, which is correct here. Its doc comment argues mines must fall because *"a mine hanging in the air over a crater is the lie `docs/32` §4 rules out"* — that lie is about **ground**, and there is none |
| `items/world.rs::WorldItems::step` | floats where dropped | `T22.05B` must therefore spawn items in open space, which it owes anyway |
| `items/spawning.rs` crates | float; no fall, no `is_falling_crate` | a crate falling to a floor that does not exist is the same bug |
| `world/tombstones.rs::Tombstones::step` | spawns at the death position and stays | a marker drifting where you died is the right picture, and it keeps the carve deterministic |
| `world/animals.rs::Animals::tick` | **no animals at all in space** | birds, beetles and spiders in a vacuum. This also answers the `birds.rs` row of `T22.05B`'s table |

**Reverse it by:** one scale value per call site, and the attractor list's entity filter —
the same filter R9 point 4 names.

## R15 — The space map is a third `MapGenerator`, **derived** from the mode, never chosen beside it

*Raised by the sweep: the two routes have opposite consequences for golden coverage, and the
task file assumed a branching mechanism that does not exist.*

**First, the mechanism the task file named is wrong.** *"Reached the way `MapScale` already
branches the existing one"* — `MapScale` branches nothing; it is a size/parameter table
(`constants.rs::MapScale::params`). The thing that branches generators is `MapGenerator`, at
exactly one site: `map/gen/mod.rs::generate_terrain_with`'s
`match generator { V1 => …, V2 => … }`.

**The ruling, in two halves that must both hold:**

1. **`MapGenerator::Space` is a real third variant and joins `MapGenerator::ALL`.**
   `tests/golden.rs::cases()` iterates `MapGenerator::ALL` × 4 seeds × `MapScale::ALL`, so the
   table grows **24 → 36 automatically** and `tests/dump_maps.rs` follows. That is the free
   coverage. **The alternative — a `GravityMode::Space` branch inside the existing generator —
   gains `cases()` nothing, so the space map would ship with zero golden coverage while
   `T22.05A`'s "most important test" (*existing hashes unchanged when the mode is off*) stayed
   green for a build where the generator was never called.** That is the
   assertion-that-rules-out-nothing shape, and it is why this half is not negotiable.
2. **It is *derived* from the gravity mode, never selected beside it.** The room computes
   `generator = if gravity == Space { MapGenerator::Space } else { <the lobby's choice> }`.
   One source of truth. **Two independent fields would let a lobby pick "space gravity" and
   "generator V2" and get a normal map in orbit** — *derive, do not add a fourth flag*, and
   this is that rule at the largest scale in the milestone.

**The plumbing this needs, which no task file costed.** Gravity does not reach map generation
at all today: `game-server/src/room.rs::generate_world_task` builds the world first and
assigns `world.gravity` **afterwards**. `World::with_generator` → `World::build` →
`map::generate_full` has no gravity parameter anywhere. **`T22.05A` makes gravity a
constructor input** so the derivation happens before the map exists. That is a signature change
through the `World` constructors and it belongs in `T22.05A`'s size estimate.

**And the lobby preview runs the generator client-side.** `client/src/scenes/PreviewScene.ts`
calls `core.generate(seed, scale)` directly — the networked round does not (it uses
`loadMask`), but the **preview a host looks at while choosing the mode does**. A host who
picks space and is shown a normal map is a visible lie, and it is the same shape as the T19.24
bug `T22.05B` already quotes. `PreviewScene` needs the mode.

**Reverse it by:** the one `match` in `generate_terrain_with`, and the one derivation line in
`room.rs`.

## R16 — The void still kills in space, and crates must stop spawning from the sky

*Raised by the sweep. Two edge-of-the-world behaviours that fire wrongly, and they have
opposite answers.*

**The void kill stays.** `world/mod.rs::step_void` kills at `head_y > map.mask.h` and
`is_in_the_void` names the cause. With no bottom clamp (R13), that is the **only** thing
between a player who breached the rim and an infinite drift, and it already has an attributed
death cause — which is more than most of this milestone starts with. Keep it, in every mode.

**The consequence is `T22.10`'s to carry:** the vortex must capture a breaching player
*before* they cross `mask.h`, so **its capture radius has to exceed the rim's thickness plus
the inset**, and that budget must be stated in `T22.10` as a number with the drift speed it
was derived from. A vortex that is merely near the hole lets people fall out of the world
through the feature designed to stop exactly that.

**Crates must not spawn from the sky in space.** `items/spawning.rs::SpawnSchedule::tick_crates`
spawns at a random x across the **full map width** at `y = SKY_MARGIN / 2`. Under R13 that
point is **above the rim's top arc at every x**, so in space **every crate spawns outside the
boundary**, and under R14 (non-player bodies float where they are put) it then hangs there
forever, unreachable. In space, crates come from `T22.05B`'s open-space picker like everything
else — the same function, for the reason R14 and `T22.10` both already give.

**Reverse it by:** the `tick_crates` spawn-point expression, one branch.

## R17 — The acceptance predicate replaces the verdict, not the report

*`T22.05A` says its own acceptance predicate is a deliverable. This is its shape.*

`traversal::analyse` returns `TraversalReport { total_points, largest_component,
traversable_fraction, passed }`, and `passed` is
`traversable_fraction >= MIN_TRAVERSABLE_FRACTION && enough_spawns`. **`generate_full_with`
and `MapMeta` consume that struct**, so the space pipeline keeps its shape and replaces only
what fills it.

- **`passed`** = the rim is **closed** — an 8-connected ring walk over the mask, not a sample
  — **and** at least `SPAWN_COUNT_MIN` candidate points exist at `SPAWN_MIN_SEPARATION`,
  drawn from **open space**, not from standable ground.
- **`traversable_fraction` = 1.0 by construction**, because everything is reachable under
  thrust. **Say that at the code**, or `map_sweep`'s cross-check between the fraction and
  `largest_component.len()` fires and reads as a generator bug.
- **`largest_component`** = every index, and a comment saying it now means *"all reachable"*.
  **That is a field-means-two-things risk and it is flagged rather than swallowed** — it is
  accepted here only because the alternative is a second report type that `MapMeta` cannot
  hold.

**Do not skip the replacement and hope.** If nothing replaces the verdict, all 12 attempts
(`MAX_GEN_ATTEMPTS`) fail, the safe preset runs, and the map that ships is the **safe-preset
map** with `used_safe_preset = true` — silently, because `map_sweep` is `#[ignore]`d and
nothing routine reports it.

**One correction to the task file's framing**, verified: the existing predicate is **not**
walk-only. `can_jetpack` and the `NavRegions` flood edges are in the disjunction. A scatter of
asteroids within one jetpack budget of each other **could score surprisingly well** — so
*measure what the existing predicate says about a space map before asserting it is
meaningless*. And `surface_points` will **not** be empty: asteroid tops are standable, so
`extract_surface` finds them.

**Reverse it by:** one function, the space arm of the verdict.

---

# Build order, as scheduled

    T22.01                                    batch 1, alone
    T22.02  T22.03  T22.05A                   batch 2  (serial: 02 and 03 share the seam)
    T22.04  T22.05B  T22.06                   batch 3
    T22.08  T22.09  T22.11                    batch 4
    T22.10  T22.12  T22.07                    batch 5

**`T22.11` before `T22.10`** — R11. Everything else follows `M22-space.md`.

**The full gate runs once per batch, by me, not once per task** (`CLAUDE.md`, set
2026-09-14 by the owner). Per task: the **Done when** command, then
`./scripts/check.sh --changed`.

# What this milestone owes when it lands

`docs/77-amendments-v9.md`, written by me, covering: the gravity setting (`docs/` does not
describe it), space's override of `docs/13` weather, `docs/14` day/night and `docs/10` map
generation, radiation, the flare, the vortex, the wells, the black hole — **and the fall
damage override at `docs/20-player-movement.md:235`**, outstanding since T20.11 and closed
in the same pass.
