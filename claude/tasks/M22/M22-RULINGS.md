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
4. **At round end it freezes** — **and the analogy this originally used was wrong.** T21.30
   froze *input* and **deliberately kept physics running**; its own comment says *"once the
   round is over, input does nothing — but gravity does"*, and `World::apply_inputs` in
   `Ended` substitutes a neutral `Input` and runs it through the same `apply_input`. **So an
   attractor applied on that path keeps pulling in `Ended` by default.** The one place to gate
   it is the `Env` construction in `World::apply_inputs` — zero the `accel` when
   `!self.phase.accepts_input()` — not `set_phase`, and not inside the black hole's own code.
   It stays **drawn**, because a hazard that vanishes on the results screen reads as a
   rendering bug; and since `World::step` calls `step_weather` only `if playing`, **"it stays
   drawn" needs its own channel** — a snapshot field or a sticky client event, not the
   scheduler.

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

### How `Forces` reaches `apply_input` — REVISED 2026-09-20, because the first version could not be built

The attractor sweep found that **this ruling's central sentence was false**: *"every existing
caller passes the moral equivalent of `Forces::gravity(1.0)`"*. Four of `integrate`'s five
production callers do. **The fifth, `player::apply_input`, does not receive a gravity scale —
it computes one**, on its last line:
`integrate(map, body, jetpack::gravity_scale(jet, mods.flying), dt)`. So `accel` and
`max_speed` have to arrive as new **inputs to `apply_input`**, which is the one function in the
tree that has written down a refusal to grow:

> `// Eight, and the allow stays (T21.02). MoveMods **replaced** an argument rather than
> // adding one — the count is what it was — and the struct is what stops the next modifier
> // making it nine.`

**The ruling: honour that comment rather than spend it.** `apply_input`'s `mods: MoveMods`
parameter becomes `step: MoveStep { mods: MoveMods, env: Env }`, where
`Env { accel: Vec2, max_speed: Option<f32> }`. **One parameter replaces one parameter and the
count stays eight** — which is exactly the move the comment blesses, done a second time for
the same reason.

- `PlayerState::move_mods()` stays a **pure derivation** returning `MoveMods`, untouched. That
  property is what T20.19 and T21.02 paid for and it is not spent here.
- The two call sites — `world/mod.rs::World::apply_inputs` and
  `game-wasm/src/lib.rs::GameCore::apply_input` — build the `MoveStep`. They are the two
  places that can see both a player and the world.
- `apply_input` composes `Forces { gravity_scale: jetpack::gravity_scale(jet, mods.flying),
  accel: env.accel, max_speed: env.max_speed }` at its one `integrate` line.
- **Rejected: a ninth argument** (spends the comment), **folding into `MoveMods`** (gives
  `move_mods()` arguments and dissolves the single-derivation property), and **passing a
  `Forces` that `apply_input` partly overwrites** (makes `gravity_scale` mean two things —
  the rule this ruling cites to justify itself).

**AMENDED 2026-09-21 — `T22.02` took the ninth argument, and I ratify it as temporary.**
This ruling forbade `MoveStep` before `T22.11` *and* rejected a ninth argument, which left
`T22.02` no third option; it took the ninth and wrote a 14-line justification pointing here.
That was the right call in the box I had drawn, and it was made by a builder that was killed
before it could file a report, so it goes on the record as a decision rather than staying a
code comment. **The ninth argument is sanctioned as a temporary state and `T22.11` must
reabsorb it into `MoveStep`** — one parameter replacing two, putting the count back to eight.
If `T22.11` lands and the count is still nine, that is a finding.

### `max_speed` on `|vel|` has three live interactions, and one is a documented refusal

- **`jetpack::apply_thrust` clamps per axis, deliberately**, to `JETPACK_MAX_SPEED` = 260, and
  its comment refuses the magnitude clamp in as many words: *"Per axis, not by vector
  magnitude: a magnitude clamp makes diagonal flight slower on each axis than straight flight,
  which reads as the controls fighting you."* Diagonal thrust reaches ≈368. **A space
  `max_speed` below 368 silently re-introduces the complaint that comment exists to refuse.**
  Pick above it, or say why this mode differs.
- **Knockback is deliberately unclamped upward** — `apply_gravity`'s doc: *"Upward velocity is
  not clamped, so a strong knockback still launches properly."* A magnitude clamp clamps
  upward too, so `KNOCKBACK_MAX` (320) and `HAMMER_KNOCKBACK` (340) now interact with it.
- **`substeps` already imposes an implicit cap**: `MAX_SUBSTEPS` 64 × `MAX_SUBSTEP_PX` 1 px at
  60 Hz ≈ 3840 px/s per axis, and the module doc calls it *"a correctness guarantee, not an
  optimisation"*. A `max_speed` above that is inert.
- `physics/resolve.rs::no_tunnelling_at_ten_times_terminal_velocity_through_integrate` drives
  `vel.y = 9000` and `vel.x = ±5000` through `integrate`, so **`Forces::gravity(1.0)` must
  carry `max_speed: None`** or that test goes red — and it is one of the controls.
  **DISPROVEN 2026-09-22 by `R50` — measured, not argued. This bullet is wrong and is kept only so the correction has something to attach to.** `Forces::gravity` carrying `max_speed: Some(MAX_FALL_SPEED)` leaves **1062/1062 passing**: `apply_gravity` has already clamped `vel.y` to 900, so the magnitude clamp is an exact no-op on the scalar path and this test never sees the fast body it is named for. It also asserts a **distance**, and an **upper** bound, which a speed clamp can only help. `T22.11B` wrote its own guards instead — `space_clamps_a_bodys_speed_on_the_vector_path` and `the_space_terminal_speed_is_not_inert_against_the_substep_cap`, both named at `Forces::max_speed`.

**And `a_resting_body_is_bit_identical_after_600_ticks` is this ruling's control test and it
already exists** — an exact `assert_eq!` on position with no epsilon. If the refactor is
bit-identical for the four non-player callers, it passes untouched.

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

### The three plumbing paths this needs, none of which any task file costed

**The summation function is the easy half.** Both sides must feed it the *same list*, and
today the client cannot build any of the three:

| source | on the wire today? | what it needs |
|---|---|---|
| asteroid wells | **no** — `codec.rs::encode_map_init` writes magic/w/h/seed/scale/theme/wind/carve_seq/spawns/pads/platforms/decorations/objects/RLE | a new section, a `decode_map_init_parts` field, a `worldMirror.ts::applyMapInit` line, a `core/index.ts` wrapper and a `GameCore::set_asteroids` — **the `set_teleport_pads`/`set_gun_platforms` precedent, four layers** |
| breach vortex | **no** — created at runtime from a carve, and the client's carve mirror is driven by server events, so it cannot derive them in lockstep | an event plus a setter |
| black hole | **no** — arrival is a seeded server roll | an event plus a setter |

**And `MapMeta` is the wrong home for the levels, twice over.**

1. **`GameCore::load_mask` clones the meta the core already held** — which, on a networked
   client, is whatever `GameCore::new()` generated, a Small map at seed 1. Anything the server
   puts in `MapMeta` arrives on the client as **stale meta from an unrelated map**. That is
   exactly why pads and platforms needed explicit setters, and it is the T19.24 shape again.
2. **`World::state_hash` hashes `self.map.mask.hash()` and nothing from `MapMeta`.** Levels
   stored there are **not** in the state hash, so a level that drifted between the two sides
   is invisible to the determinism guard this whole milestone rests on. Hold them in `World`,
   or hash the contribution explicitly and say you did.

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

### Three things the minimap argument needs in order to hold

*Added 2026-09-20 from the client sweep. The conclusion stands; two of its supports were
thinner than written and one is a constraint that has to be honoured or the ruling buys
nothing.*

1. **The inset must preserve the 2:1 ratio or the minimap circle is lost.** Insetting
   `SKY_MARGIN` (96) at the top and `FLOOR_CRUST` (16) at the bottom gives
   `ry = (h − 112)/2`. To keep `rx/ry = 2` the **x-inset must be exactly 112 px per side** —
   the *total* y-inset, not half of it. Any other x-inset makes it an ellipse on the minimap
   too, which is the one thing this ruling was bought for. Derive it; do not pick it.
2. **The rim must be at least `mapW / MINIMAP_W` px thick** — 10.24 px on Small, 15.36 on
   Medium, **20.48 on Large**. `Minimap::resampleTerrain` point-samples `core.solidAt` once
   per cell, so a rim thinner than one cell aliases into a broken dashed ring or vanishes.
   *"A thin layer of land"* has a floor and this is it.
3. **The honest correction: the minimap is an explored mask.** `Minimap::draw` paints
   unexplored cells flat and reveals only within `MINIMAP_REVEAL_R` = 260 world px of where
   you have been. So the circle exists only where a player has already flown, and *"the only
   place the arena's shape is ever visible"* is true late in a round rather than always. **The
   ruling still stands** — the ellipse keeps the whole arena and the circle appears where a
   shape can appear at all — but its reason is weaker than it was stated, and a reader should
   know that rather than discover it.

Also, for whoever writes the pixel check: **the minimap is a fixed-position DOM overlay**, not
part of the game canvas, so `getImageData` on the canvas will not see it. `page.screenshot()`
will.

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

## R16 — In space the void is **outside the rim**, and crates stop spawning from the sky

*Raised by the sweep. Two edge-of-the-world behaviours that fire wrongly, and they have
opposite answers.*

**REVISED 2026-09-20 — the original covered one of four arcs.** It said the vortex must catch
a breaching player before they cross `mask.h`. That is the **bottom** arc only. Breach the
left, right or top rim and `clamp_to_world` pins the player at x = 16 or y = 14 with velocity
zeroed inward — **alive, outside the rim, in empty mask, with no global gravity and nothing to
push them back.** A permanently exiled living player, with no death cause, no message and no
timer, for the rest of the round. That is worse than the death the original was preventing.

**The ruling: in space, the void is *outside the rim*, not *below the map*.**
`world/mod.rs::is_in_the_void` gains a space arm that tests the boundary ellipse, and
`step_void` keeps reading that same predicate — which it already does, for the reason its own
comment gives: *"the same test `step_void` kills on, so `resolve_deaths` can name the cause
without a flag to keep in sync … Derive, do not add a fourth flag."*

One predicate change covers all four arcs, reuses `DeathCause::Void` and its whole existing
feed/overlay/score path, and needs no new cause. **Give it a grace band** — a margin outside
the rim before it fires — so the vortex has room to do its job, and state that margin against
the drift speed it was derived from.

**The consequence `T22.10` carries:** the vortex must capture inside that grace band. Its
capture radius has to exceed the rim thickness plus the band, stated as a number with its
basis. A vortex that is merely *near* the hole lets people die through the feature designed to
stop exactly that.

Minor correction to the original: `tick_crates` spawns across
`WALL_W + CRATE_WALL_MARGIN … w − WALL_W − CRATE_WALL_MARGIN`, not the literal full width. The
conclusion is unaffected — `y = SKY_MARGIN/2` = 48 is above an ellipse inset clear of
`SKY_MARGIN` = 96 at **every** x, so every crate still spawns outside the rim.

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

## R18 — Asteroid levels are derived from `JETPACK_CLIMB_BUDGET`, not from a delta-v

**SUPERSEDED IN PART 2026-09-21 by `R46`.** The ceiling inequality below is stated against `JETPACK_THRUST_UP` = 2200. That is the pack's strongest axis; the binding direction is **down**, at `JETPACK_THRUST_DOWN` = 900, for a player on the underside of a rock. Read `R46` for the inequality that replaces it. Everything else in this ruling stands.

*`T22.11` says the five levels derive from the thruster's delta-v. **The thruster does not
produce a delta-v.***

`jetpack::apply_thrust` clamps each axis to `JETPACK_MAX_SPEED` = 260 whenever the pre-thrust
speed on that axis was within it. **It is a speed governor, not an impulse budget** — from
rest you cannot exceed 260 px/s on an axis however long you burn. So *"level n costs roughly
k(n) fuel to leave from the surface"* is not a quantity this thruster has.

**The two quantities it does have, and both are already in the tree:**

1. **A distance budget, and it is already a named constant with its basis in its doc comment**
   — `JETPACK_CLIMB_BUDGET = JETPACK_MAX_SPEED * JETPACK_MAX_FUEL * 0.6` = **780 px**,
   documented as *"the furthest a player can climb in one unbroken effort"* and already
   consumed by `map/gen/traversal.rs::analyse`. **That is the measured basis `T22.11` asks for
   and does not name.** It is also the same number `R17` warns governs whether a scatter of
   asteroids scores well on the existing traversability predicate — one constant, both
   questions.
2. **An acceleration ceiling.** If a well's acceleration at the surface reaches
   `JETPACK_THRUST_UP` = 2200 px/s², the player cannot move outward **at any fuel level**.
   That is `T22.11`'s *"maximum well against maximum thrust"* guard stated correctly: **a
   **— WRONG CONSTANT, see `R46` (2026-09-21). The pack is anisotropic: up 2200, sideways 1100, **down 900**. The binding case is a player on a rock's **underside**, so the ceiling is against `JETPACK_THRUST_DOWN`. A well of 1500 px/s² passes this bullet as written and still traps that player forever. `T22.11B` implemented R46's form and measured the worst case at 647.31 px/s² against 900.**
   comparison of accelerations, not of delta-v.** Assert it.

**Reverse it by:** the level → pull table's derivation, one function with the basis in its
doc comment the way `capacity.rs::max_rooms_carries_its_basis` does it.

## R19 — Breach detection lives in `Map::circle` and must de-duplicate per carve

*The chokepoint ruling is right. The census justifying it was wrong, and the correction adds a
requirement.*

**`Map::circle` really is the single chokepoint** — `carve_circle`, `fill_circle` and
`carve_capsule` all funnel through it, and no production code writes `mask.set`/`mask.clear`
outside `map/gen/`. So `T22.10`'s ruling stands.

**But there are seven production carve sites, not five, and the one the task file builds its
rhetoric on does not exist.** `world/tombstones.rs` does not carve in production — its only
`carve_circle` is in a test that carves the ground *away* to see whether a stone falls, the
opposite of a tombstone carving. The real list: `weapons/explode.rs` (two),
`weapons/bullet.rs`, `weapons/flame.rs`, **`weapons/melee.rs`** (the dig path, `carve_capsule`),
**`effects/lava.rs`** (channels, `carve_capsule`), and **`world/mod.rs::detonate`** (the toxic
drop's bite). Three were missed, and **two of the three missed ones are the capsule paths.**

**That is the new requirement.** `carve_capsule` stamps `circle` **once per Bresenham pixel**
— verified, it collects centres and calls `self.circle` for each. So a breach detector inside
`circle` fires **N times for one shovel swing or one lava channel**. *"A breach makes **a**
vortex"* needs de-duplication at the carve-call level, not at the circle level, or those two
paths spawn a vortex per pixel.

`fill_circle` has **zero** production callers, so `R9`'s point 3 is safe as written.

**Reverse it by:** the de-dup guard is one accumulator on the `CarveResult` the capsule path
already folds.

## R20 — A new death cause has two ends and the client end fails silently

*`T22.12` wants a named death cause. Count the thing at both ends.*

**Rust end**, `player/state.rs::DeathCause` has four arms — `Player`, `SelfInflicted`,
`Weather`, `Void` — and a fifth must be added at: the enum; `PlayerState::killer`;
`world/mod.rs::resolve_deaths`; `world/mod.rs::apply_damage_log`;
`game-server/src/events.rs::cause_name`; `bots/mod.rs`; `tests/balance.rs`.

**There is no channel that carries a cause into `resolve_deaths`**, and that is deliberate:
`Void` works by `step_void` zeroing health and `resolve_deaths` **re-deriving** the cause from
`is_in_the_void(p)`. The horizon kill follows that shape — a pass plus a predicate read one
pass later — or it goes through `DamageSource`. It cannot simply "pass a cause".

**Client end, and this is where it dies quietly.** `GameScene`'s `death` handler narrows the
wire string against an allowlist and **anything unrecognised becomes `'player'`**. A new
`"black_hole"` therefore renders as `"? → ana (black_hole)"` — an unknown murderer, which is
the exact bug `killfeed-state.test.ts` records having already been fixed once, for `void`.
Sites: `ui/killfeed-state.ts::DeathCause` and `::killLine`, **the `GameScene` allowlist**,
`ui/deathOverlay-math.ts::causeText` and `::weatherName`, `ui/feelLayer.ts::kill`, and the
`death` / `void` browser checks.

**And report this pre-existing defect, do not fix it here:**
`deathOverlay-math.ts::weatherName` has arms for `'toxicrain'`, `'meteorshower'`,
`'lavaburst'` and `'selfinflicted'` that **the server can never send** — `cause_name` emits
only four strings and there is no `by` field on the wire to carry an effect kind. Four
unreachable arms, and no `'heavyfog'` arm at all. That is the count-both-ends failure already
in the tree, at the exact end `T22.12` is about to extend.

**Reverse it by:** one enum arm and one allowlist entry; the point of this ruling is that it
is *two* edits and the second one is silent.

## R21 — The black hole belongs to the round controller, not the scheduler

*`T22.12` asks. The code answers, and more strongly than the task states.*

**The scheduler does not merely lack a permanent lifecycle — it forbids one.** `tick`'s start
gate is `if now + EFFECT_TELEGRAPH + active_duration(kind) <= round_ends_at`, and a permanent
effect has no finite duration, so that guard can never admit it. The comment beside it says
why: *"an effect that outlives the round would kill someone after the scoreboard is up."*
Then `self.active.retain(|e| e.phase != EffectPhase::Done)` requires an end.

**And the cost is an order of magnitude apart.** A fifth `EffectKind` touches, in production
only: `game-wasm/src/lib.rs` (18 sites), `effects/scheduler.rs` (10), `world/mod.rs` (9),
`game-server/src/config.rs` (4), plus `effects/meteor.rs`, `effects/lava.rs`, and TypeScript
string comparisons in `render/weather-math.ts` and `ui/hud.ts`. Against that, the round
controller is: two `World` fields, one line in `World::step`, one `state_hash` contribution,
one line in the exhaustive destructure, one event. **`World::round_ends_at()` is already
computed and is the T-minus clock.**

**Reverse it by:** it is two fields on `World`; moving it into the scheduler is the larger
change in both directions.

## R22 — `SandboxScene` takes a `?gravity=` parameter

*Without this, five of `T22.06`'s eight checks cannot reach the mode they are supposed to
assert about, and `T22.04`'s pixel work has nowhere cheap to live.*

`SandboxScene` reads only `seed` and `scale` from the URL and its exposed
`regenerate(seed?, scale?)` has no mode argument, so **every sandbox check is structurally
incapable of seeing a space map.** And gravity deliberately has no environment spelling
(`config.rs`: *"§F7's two lobby settings — and T22.01's gravity — have no environment spelling
on purpose"*), so a standalone check cannot start a space round by env either; the only route
is driving the private-lobby UI.

**Give `SandboxScene` a `?gravity=` URL parameter and a mode argument on `regenerate`.** It is
cheap, it unlocks the five sandbox checks, and it makes every rendered-pixel assertion in
`T22.04`, `T22.06`, `T22.08` and `T22.11` tractable. **Whichever task lands first writes it**
— the same rule as `R11`'s attractor list.

**Note for every M22 client task:** `scripts/lib/affected.mjs` says *"A client source file
selects every browser check."* and `/^assets\//` is in its `EVERYTHING` set. So
`./scripts/check.sh --changed` is effectively the full browser suite for any task touching
client sources — **the per-task economy does not apply to those, and the coordinator should
expect the time.**

**Reverse it by:** one `params.get('gravity')` and one argument.

## R23 — `T22.07`'s Done-when is already green, and `PlayerView` takes an `Appearance`

*Two smaller findings from the client sweep, ruled so they are not rediscovered.*

**The Done-when passes today and would pass for a build that never ran the new check.**
`scripts/e2e.mjs`'s filter is a **substring** match, and `skins` matches two live checks —
`skins` and `skins-ingame` — both already in the default suite. **Anchor it with `=` to a new
distinct name** (`node scripts/e2e.mjs =spacesuit`), or the Done-when reports the success of
work nobody did. Note also that `npm --prefix client test -- --run skins playerView` filters
to `playerView-math.test.ts`; **there is no `playerView.test.ts`**, so the half of `PlayerView`
the task changes has no vitest file behind that filter.

**`PlayerView`'s constructor takes an `Appearance`, not six positional arguments.** It is
already `(scene, skinId, hatId, glassesId)`; suit and visor make six, and `ui/skins.ts` has
already written down that this is the reason a thing becomes an object. `sameAppearance` then
carries all five fields, **which is its stated purpose** — *"the next accessory cannot be
added to the map and the constructor and forgotten in the `if`"*. This task is that guard's
first real test; do not make it the guard's first miss.

**One correction the task file needs:** `tombstone_skin_id` reaches `player_join` but **not
`lobby_state`** — `room.rs::LobbySeat` carries `skin_id`, `hat_id`, `glasses_id` and no
tombstone. If the visor must be visible **in the lobby**, the precedent is `hat_id`/
`glasses_id`, not the tombstone.

**And the chosen skin comes back for free**, provided the mode override lives at render time:
nothing in `GameScene` ever writes cosmetic storage — `saveChoice`'s only production callers
are in `SkinsScene`. Override at `GameScene::lookOf` or in the `PlayerView` constructor, never
in storage or in `this.scores`. The test is still worth writing, because `lookOf` is exactly
where a coder would be tempted to mutate.

## R24 — The suit battery is a second health bar that radiation eats first

*The hazard sweep did the arithmetic `T22.09` only gestured at, and the answer is that the
mode as ruled is unsurvivable by roughly 17×. This ruling is the fix, and it is a **design**,
not a patch.*

**What was wrong, all measured:**

- **Nobody spawns with a battery.** `PlayerState::new` sets `battery: 0.0` and `STARTING_KIT`
  is `[SHOVEL]`. Under `R2` — *the suit, while the battery has charge* — **every player in
  space is unshielded from the first tick**, and dies of radiation in 100 seconds.
- **The per-second shield drain does not exist and must not be re-added.** T20.08 **deleted**
  `SHIELD_DURATION` and `SHIELD_DRAIN`, deliberately, and `constants.rs` says so at the
  gravestone. `SHIELD_HIT_COST` is **1.0 per hit taken, nothing per second** — a *pool*, not a
  timer, and its doc comment says *"`BATTERY_MAX` of 100 buys a hundred absorptions"*.
  `T22.09`'s deliverable *"energy drains, so the shield is not free"* would reverse a shipped,
  documented decision. **It does not get to.**
- **The economy does not exist either.** `BATTERY_PACK`'s spawn weight is 14 of 241 (5.81 %)
  and 18 of 271 in crates (6.64 %). A 240 s round on Medium yields **2.69 packs for the whole
  lobby — 22.4 energy per player** — and **43 % of rounds start with no pack on the map at
  all**.

**The ruling, and the exchange rate is the design:**

| | |
|---|---|
| `RADIATION_DPS` | **1.0** — the owner's number, to *health*, when unsealed |
| `RADIATION_SHIELD_COST` | **1.0 energy per second**, to *battery*, when sealed |
| suit battery at spawn, in space | **`BATTERY_MAX`** (100), and **restored on respawn** |
| `BATTERY_PACK` spawn weight in space | **doubled** (14 → 28, ≈ 11 %) |

**One energy buys one damage avoided, and `BATTERY_MAX` equals `BASE_HEALTH`.** So the suit
battery is *literally* a second health bar, and radiation eats it first. A full suit is 100
seconds of grace; a battery pack is 50 seconds more; at zero the suit fails and radiation
starts on you at the same rate. **That is one sentence a player can learn by dying once**, and
it needs no new tuning vocabulary.

**The pressure it produces**, at 230 s of play (240 − warmup) and a fresh suit per life: a
player who ignores batteries dies of radiation about **twice a round**; a player who picks up
two or three does not. That is a hazard, not a clock nobody can beat — which is what 1 dps
against a 0.0 starting battery was.

**Respawn restoring the suit is what stops the death spiral** — without it, the first
radiation death guarantees the second.

**These four numbers are a starting point with a stated basis, not a measurement.** They come
from a sweep's arithmetic, not from a run. **`T22.09` owes a `balance.rs`-shaped measurement
over 8 seeds and must report it**, and must move the numbers if the measurement disagrees. The
basis goes in the constants' doc comments.

**Reverse it by:** four constants, and the space arm of the spawn-weight table.

## R25 — Radiation logs one damage entry per second, never one per tick

*`R6` said ambient and constant. At 60 Hz that is a catastrophe nobody costed.*

`SIM_HZ` is 60. If radiation follows the toxic-poison shape — one `DamageLog` entry per tick
per affected player — then `apply_damage_log` emits a `GameEvent::Damage` per player per tick:
**360 events a second at `MAX_PLAYERS`, for the whole round.** On the client each one drives
`feel.damageTaken` (a floating damage number reading `0.0167`), `vignette.hit` (a red hit
vignette retriggered 60×/s, i.e. permanent) and **`audio.spatial('hit', …)` — a hit sound
sixty times a second, forever** — plus a `Scope::Pair` wire message on top of
`SNAPSHOT_HZ` = 20.

The precedent has the same shape but is bounded: `TOXIC_POISON_DURATION` is 3.0 s and only for
players actually rained on. `R6` makes it unbounded and universal, which is what makes the
difference.

**Accumulate and emit on whole seconds** — one entry per second per player. It still goes
through `apply_damage_log`, because that is where the warmup gate lives and *"a subtraction
from `health` inside the player would be the one damage source in the game that skipped it"*.

**Reverse it by:** the accumulator, one field and one comparison.

## R26 — `shield_active` takes the suit as an argument, and the suit does not draw the bubble

*`R2`'s "Reverse it by" line priced this as one place. It is not one place, and the sweep
found a third consequence the ruling did not see.*

**`PlayerState` has no route to the game mode.** `shield_active(&self, now)` is
`self.battery > 0.0 && self.holds_shield_generator()`; there is no `mode`, no `in_space`, and
`World.gravity` is read by **nothing** in production. So `R2`'s second source needs either a
new `PlayerState` field — **the exact shape that struct's own comment rejects**: *"**No
`shield_until`** (T20.08) … A field beside them would be a third answer that can disagree"* —
or the mode reaching the predicate.

**The ruling: the caller supplies the mode bit.** `shield_active(&self, now, suit: bool)`,
with `suit` passed by the three production call sites that *do* know the world —
`net/codec.rs`'s encode, `state.rs::apply_damage`, and `game-wasm/src/lib.rs::shield_active`.
One predicate, two sources, **and no fourth flag on `PlayerState`**. `R2`'s verdict stands;
its price was wrong.

**And the suit does not draw the shield generator's bubble.** `codec.rs` sets flags bit 3 from
`shield_active` and `playerView.ts` shows `shieldBubble` from it — so under `R2` as written,
**every player in space wears a shield bubble for the entire round**. That bubble means *"I am
carrying a shield generator"*, which is tactical information, and it would come to mean
nothing. The suit's seal gets its **own** quieter feedback — and that feedback is what
`T22.09`'s *"a player can tell it is happening"* requirement is asking for anyway, so this
costs the task nothing and saves the bubble.

**While you are there, fix the lie:** `game-wasm/src/lib.rs::shield_active` calls
`p.stats.shield_active(0.0)` — a hardcoded `now`. Inert today because `now` is unused; a
landmine the moment the predicate wants a clock.

**Reverse it by:** one argument and one flag bit.

## R27 — `R12` is right for a reason it did not give, and the flare's model is **poison**, not burn

*Two corrections to `R12`, one of which reverses its evidence while keeping its verdict.*

**1. `BurnField` does not hold the shared burn-duration model, and has not since §F10.2.**
`R12` and `T22.08` both say *"`FLAME`, molotov and lava already share it"* and locate it in
`burn.rs`. **All three left that file.** `burn.rs`'s own header says so: *"**§F10.2 took the
fire out of it.** All three of those are flames now … What is left here is the **toxic
grenade's cloud**"*, and `BurnKind` has exactly one arm. The shared thing is
`weapons::flame::light_fan` with `FLAME_LIFE`, and it is not in `burn.rs` at all. The §F12
sentence is also mis-quoted: its subject is a **toxic zone**, not a fire.

**2. The model the owner actually described is `poisoned_until`, and neither file names it.**
*"Burns players touching it for N seconds"* is a **per-player status that persists after you
leave** — which is `PlayerState::poison()` / `::poisoned(now)`, whose doc comment already
states the rule the flare wants: *"Writing the deadline is the whole rule. Adding to it would
stack."* Copy that. `BurnField::tick`'s overlap test is explicitly disqualified anyway — its
own comment says the centre-plus-half-width circle *"is **not** safe for anything small"*, and
a ribbon is small. `flame::touching` is the right shape test.

**3. The decisive argument for a new type is the wire, not the doc comment** — and it is not
reversible by editing a comment, which the doc-comment argument is.
**`GameEvent::HazardSpawn { id, kind, x, y, r, duration }` and `HazardEnded { id }` are the
whole hazard channel. There is no move event** — `grep -rn "HazardMove\|hazard_move"` over
`crates/` and `client/src` returns **0**. And `ordnanceFx-math.ts`'s hazard update loop decays
`ttl` and **never moves `x`/`y`**. A moving hazard cannot be expressed. Also
`ordnanceFx-math.ts::hazardKind` maps to `'toxic' | 'smoke' | 'other'`, so a new kind
**silently becomes `'other'` and draws as a neutral disc** — `R20`'s client-end-fails-silently
shape at a second site.

**4. So the flare's position must be a pure function of (effect seed, elapsed time)**,
evaluated in `game-core` and **re-derived in TypeScript** — the `render/weather-math.ts::LavaClock`
precedent, whose doc records that until it existed *"the networked client drew none of it — no
vent, no mouth, no ember, and no light during the jet, which is the only phase that damages
you."* That is `T22.08`'s open prediction question, answered by the code.

**5. `R12` set a duration and no damage rate.** *"Burns for 4 seconds"* is not a number of
damage. **`SOLAR_FLARE_DPS` = 8.0**, so a full burn is 32 — about a third of a health bar,
dodgeable, and survivable alongside `R24`'s radiation. Basis in the doc comment, measured and
reported like `R24`'s.

**Reverse it by:** `effects/flare.rs` is one file; the verdict does not change, only its
justification.

## R28 — The scheduler's per-mode seam does **not** exist yet, and its alternation guard goes quietly blind

*The milestone brief called this *"a constructor argument, not a redesign"*. That was half
right and the missing half is real work.*

**What is true:** `enabled: [bool; KINDS.len()]` is a per-instance field and it **is** already
hashed — `hash_into` folds it.

**What is not:** `with_enabled` is **private with zero production callers** — the only
production constructor is `EffectScheduler::new(seed, round_start)`, which hard-calls
`enabled_from_constants()` and takes no mode. Both of `with_enabled`'s other call sites are
tests. And `World.gravity` is read by **nothing** in production. So a per-mode hazard table
needs a new public constructor **and** the mode threaded from `World` — required work, in
whichever task lands first.

**And the guard that is supposed to protect the table goes silently green.**
`two_live_kinds_alternate` opens `if live.len() != 2 { return; }` — so the moment a space
table has three live kinds it **asserts nothing at all**, with no failure and no signal.
`a_draw_is_always_possible` reads the same constants table and is equally blind to a space
one. **Whichever task writes the space table owes both of them a space arm.**

**A pre-existing defect to report, not to fix:** a table with **one** live kind is a live bug.
`roll_kind` zeroes the last-run kind, so a one-kind table reaches `pick_weighted` with all
weights zero — and `rng.rs::pick_weighted` does **not** panic there, it `return 0`s, which is
`KINDS[0]` = **`ToxicRain`, a kind that is switched off**. `a_draw_is_always_possible`'s doc
comment calls this *"the panic this rules out"*; **there is no panic**, there is a silently
wrong hazard. **So a space table must have at least two live kinds**, and that is a constraint
on the design, not a detail.

**Reverse it by:** the new constructor is one function; the guards' space arms are one
parameter each.

## R29 — Meteors and toxic drops **do** fall slower in low gravity, and the load guard must track it

*Raised by `T22.02`'s review: meteors and toxic-rain drops are projectiles, so they go through
`Projectiles::step` and were scaled in production — but nobody recorded a decision.*

**Keep it, because it is the owner's own sentence.** *"Low gravity mode makes everything a bit
slower (including projectiles)"* — a meteor is a projectile. Meteor showers falling ~41 %
slower and the sky staying fuller is the feature, not a leak.

**But the guard that bounds the load cannot see it.**
`world/mod.rs::a_shower_keeps_a_bounded_number_of_drops_in_the_air` computes its airborne
ceiling from the **unscaled** `GRAVITY`, and its stated purpose is a *load* claim — a
`ProjectileMove`-per-second bill, with the note that *"there is no projectile cap to check"*.
Under half gravity flight time grows toward √2, so the real peak and the event bill grow ~40 %
and the guard is blind to it. **It must take the mode**, or it guards only the mode nobody is
worried about.

Same for `a_meteor_falls_exactly_as_fast_as_gravity_and_its_speed_imply`: it stays green
because it runs at `Standard` only, and its whole documented derivation is now a
standard-gravity-only statement with nothing saying so. Say so.

**Reverse it by:** the `gravity_scale` argument at `Projectiles::step`'s meteor and drop call
sites.

## R30 — In low gravity, loot falls at full speed while you float, and that is `T22.11`'s to fix

*`GravityMode::scale`'s doc says every `GRAVITY` reader multiplies by it *"so 'which gravity is
this match under' has exactly one answer"*, and the next paragraph says four of them do not.
Both sentences cannot be true.*

The four are `Mines::step`, `WorldItems::step`, `Tombstones::step` and `Animals::tick`
(`R10`). **The second sentence is the true one**, and the player-visible consequence is that
**in a low-gravity match a dropped weapon and a tombstone fall twice as fast as the person who
dropped them.**

**Leaving them was correct** — `R10` assigns those four signature changes to `T22.11`, and
`R14` already rules what they do in space. **But the stated reason is wrong and must be
fixed**: the doc says their signatures *"cannot see the match setting (`(map, …, dt)`)"*,
which is a description rather than a reason — this very commit widened `Projectiles::step`'s
signature for exactly that. **The honest sentence is "`R10` assigns these to `T22.11`."**

**And `T22.11` now owes low gravity as well as space**: when it threads the mode into those
four, it must scale them under `Low`, not only zero them under `Space`.

**Reverse it by:** one scale argument per call site, in `T22.11`.

## R31 — Low gravity is the **most violent** mode in the game, and it ships that way

*Measured, not guessed: `low_gravity_report` over 8 seeds, the `natural` arm —*

| arm | dmg | self | kills | fires |
|---|---|---|---|---|
| natural, Standard | 1248 | 457 | 9 | 182 |
| natural, **Low** | 4446 | 633 | **39** | **1548** |

**8.5× the shots fired and 4.3× the kills.** It is not `zone_reach` — that row is byte-identical
under a `zone_reach` plant — it is pure physics: floatier bots meet each other far more often.

The owner asked for *"everything a bit slower"* and the measurement says the opposite about
the **pace of fighting**. **Both are true and neither is a bug**: things *move* slower and
arc further, and because they arc further, fights start more often. **Ship it and tell the
owner**, rather than quietly retuning a number the owner never saw.

**Two honest caveats on the measurement**: it is **bots only**, and bots are not people; and
the `natural` arm is the no-weapon-pickups configuration, which is the one where floatiness
dominates. A human lobby may move much less.

**Reverse it by:** `LOW_GRAVITY_SCALE`. The review established the live bracket is
`0.161 < k ≤ ~0.658`, so there is room to move it to 0.6 without any test objecting —
which is also the reason to say out loud that the value is **bounded, not pinned**.

## R32 — The inert `reanalyse` guard stays, and `T22.05B` owes it a test that fires it

*`T22.05A` built a guard, falsified it, found it proved nothing, and reported that rather than
dressing it up. This is the ruling it asked for.*

`meta.rs::generate_full_with` re-derives the surface and the report whenever pass 8's ground
fill added pixels, and did so through `traversal::analyse` **unconditionally** — which on a
space map would silently replace the space verdict with a walking number, leaving
`outcome.report.passed` and `MapMeta.traversable_fraction` disagreeing. `gen::reanalyse`
dispatches on the generator instead.

**Reverting it changes no output**, because over **900 space maps (300 seeds × 3 scales) pass
8 fills ground on exactly 0 of them** — a pad on a lumpy asteroid top already has rock beneath
it, so `fill_standing_ground` adds nothing and the `if filled > 0` branch never opens.

**Keep it. An unexercised branch is the problem; the guard is not.** It is correct, it is one
call site, and it closes the moment `T22.05B` reseats pads or `T22.11` reshapes rocks — at
which point nothing else in the tree would report its absence.

**But "correct and never run" is how a guard rots**, so: **`T22.05B` owes it a test that
forces `filled > 0`** on a space map and asserts the space verdict survives. A fixture is
fine; the branch being unreachable in production is exactly why it needs one in a test.

**Reverse it by:** one call site in `generate_full_with`.

## R33 — A closed rim means the client paints the whole arena as a cave, and that is `T22.06`'s

*The largest finding of `T22.05A`, and it is about a task that has not started.*

The terrain renderer decides whether to paint the **cave backdrop** from whether air is
reachable by a flood from the sky. **A closed rim means none of the arena's interior air is.**
Measured at seed 4242: inside the rim, **0 of 1 098 496 / 2 819 018 / 5 312 965 px are
sky-reachable — 1.0000 enclosed on every scale.** Over the whole map it is 0.590 / 0.654 /
0.684, because the band outside the rim and the sky above it are open — **and the whole-map
number is the misleading one**, which is why both are recorded.

Neither piece is wrong. `T22.05A`'s rim is closed by design and its `rim_is_closed` test
asserts the same fact from the other side; the renderer's rule is right for every map that
existed before. **The consequence was simply written down nowhere: unless space gets its own
backdrop, the client paints the entire playfield as a cave.**

**This is `T22.06`'s** — the space backdrop — **not `T22.04`'s**, which is thrusters.
`T22.05A`'s report assigned it to T22.04 twice; corrected here.

**And a second, quieter one for the same task:**
`client/src/render/backdrop-real.suite.ts::DEEP_WINDOW` is keyed by `MapGenerator.V1` and
`.V2` with **no `Space` entry**. It is not an exhaustive `Record`, so it typechecks today and
anyone adding a space case gets `undefined` rather than a compile error.

**Reverse it by:** nothing yet — this ruling only says where the work lives.

## R34 — Correcting the rim's numbers, which I put into the record without running them

*`T22.05A`'s review re-ran every numeric claim in the commit. All of them reproduced **except
the two about the rim's thickness** — and those two are what the rim's shape was chosen on.
I repeated both in the journal. I had not run either.*

**The measured thinnest rim is 29.75–30.00 px, not 32.00.** From the builder's own unmodified
test, which I ran:

```
Small: thinnest rim 30.00 px at 117 deg
Medium: thinnest rim 29.75 px at 113 deg
Large: thinnest rim 29.75 px at 114 deg
```

32 is the value of `SPACE_RIM_THICKNESS` — a constant, not a measurement. `space.rs`'s own doc
claims *"Measured off the mask, not asserted against the constant"*, and the number beside it
is the constant.

**And the 30 px is a design property, not rasterisation noise.** `stamp_rim` steps in **ellipse
parameter**, not arc length, and on a 2:1 ellipse arc speed varies 2:1 — so a nominal 8 px
spacing peaks at 10.38 px at the top and bottom, and a chain of radius-16 discs at that spacing
scallops to 30.27 px. Predicted 30.27, measured 29.75–30.00, **at 113–117°, exactly where the
prediction puts it.** So *"a chain of discs of radius `thickness/2` is uniformly `thickness`
thick by construction"* is false as written.

**The `~0.80×` annulus figure matches no construction.** Brute-forced, the natural inset
ellipse is **0.945×** at worst, and the doc's own sentence is internally inconsistent — 0.80 ×
24 = 19.2, not the *"~22 px"* it then states, and 22 is the 0.949× figure. At the shipped
nominal 32 that annulus measures **30.24 px**, i.e. **thicker** than what the disc chain
actually produces.

**Nothing is broken and the geometry does not change.** 29.75 clears the 20.48 px
`mapW / MINIMAP_W` floor by 45 %. And stepping in arc length instead gives 30.98 — still not
32, because **a disc chain is never uniformly `thickness` thick.** The real spread across every
candidate construction is ≈ 0.7 px. **So the fix is the record and the doc comment, not the
rim.**

**One more the review found and the record does not have:** R13 says the x-inset is 112 px.
What was built derives from the **centreline**, giving **128 px** per side. The centreline is
exactly 2:1 on every scale; the outer edge is 1.965 and the inner 2.038, so the annulus the
minimap draws is out of round by ~16 px on each edge. **That is inherent to a constant-thickness
rim on an ellipse, it is the right call, and it was simply undocumented.**

**Reverse it by:** nothing — this ruling only corrects numbers.

## R35 — Every spawn on a space map is outside the arena, and that is `T22.05B`'s red-before-green

*`T22.05A`'s acceptance predicate validates a quantity the map does not ship.*

`analyse_space`'s spawn clause counts `open_space_candidates(...)` and **throws the list away**.
What ships in `MapMeta.spawn_points` comes from `meta.rs::generate_full_with`'s `choose_spawns`
over `outcome.surface` — and measured through the real pipeline, **all 6 spawn points and all 6
teleport pads sit at `y = h − FLOOR_CRUST − 1`, on the full-width floor crust, outside the rim
ellipse, in the band `generate_once`'s own comment calls the void.**

Surface composition at seed 4242 says why: `Small 148 = crust 84, asteroid 14, rim 37, other
13`. The crust outnumbers the asteroids **6:1**, so `choose_spawns` finds it first.

**Two consequences:**

1. **A space match is currently unplayable** — everyone spawns outside the boundary. `T22.05B`
   owns spawns and this is its whole first paragraph, so nothing is out of order; it just is
   not written down anywhere that the map ships this way today.
2. **`asteroid_tops_are_standable` asserts `!o.surface.is_empty()`**, which the floor crust
   satisfies 6:1 on its own. **It would pass for a generator that stamped no asteroids at
   all.** Its name states a claim its body does not test.

**`T22.05B`'s red-before-green is to move `analyse_space`'s spawn clause onto
`MapMeta.spawn_points`.** It is red today on all three scales — which is the point, and which
is exactly what a Done-when that can report its own violation looks like.

**Reverse it by:** one clause in `analyse_space`.

## R36 — Asteroid levels are not in the state hash, and `T22.11` must put them there

*`R11` said: hold them in `World`, or hash the contribution explicitly **and say you did**.
`T22.05A` did neither and reported neither.*

The levels went into `MapMeta`. `World::state_hash` hashes `self.map.mask.hash()` and nothing
from the meta. **That is correct today and wrong the moment `T22.11` lands**: `level` is in the
golden meta digest, so *generation* drift is caught, but once `level` drives physics a level
that differs between server and client is invisible to the determinism guard the whole
milestone rests on.

`replay.rs`'s own note argues gravity is safe to leave unhashed because *"a world that ran
under a different gravity diverges in `players`, which is hashed"*. **That argument does not
apply to a field nothing reads yet** — and it starts applying, for the wrong reason, the moment
something does.

**`T22.11` owes this explicitly**, as its own red-before-green: make a level differ between the
two sides and show the state hash notices.

**Reverse it by:** one contribution in `World::state_hash`.

## R37 — The `objects` rebake budget moves to `perf`, which already carries the right flags

*A third wall-clock assertion has now decided a gate on load. Same family as `T22.00B`/`T22.00C`,
different shape.*

`scripts/checks/objects.mjs` asserts `median single-chunk rebake ≤ 4 ms over 40 samples`. In a
`--changed` run it read **4.20 ms** and failed; alone on the same tree immediately afterwards,
**0.80 ms median, 2.30 max**. And the six gate logs already in the tree say this was always
marginal — **four of six prior runs already exceeded the 4 ms budget on their *max***, and the
check only gates the median, so under `e2e.mjs --jobs` the median walks into the max's old range.

**Do not set `flaky: true` on `objects`.** That disables the **whole** check — eight real pixel
assertions including *"carve took the art with it"* and the seam test — to silence one timing
line. The builder declined to do it and was right to.

**The ruling: move the rebake budget into `scripts/checks/perf.mjs`**, which is already
`serial: true` **and** `flaky: true` — the check that exists for wall-clock budgets. That is not
weakening the assertion; it is putting it where assertions of its kind already live, and it
leaves `objects`' eight pixel assertions gating on every run.

**Added to `T22.00C`'s scope**, which is already the task for wall-clock assertions.

**Reverse it by:** one assertion, back in `objects.mjs`.

**AMENDED 2026-09-25 (M22 close-out).** `perf` is `flaky: true`, so once the budget moved there **nothing gated it** —
the move traded a load flake for no coverage. It is now its own check, `scripts/checks/chunk-rebake.mjs`
(`serial: true`, not parked), the same instrument, 40 samples and median bound: green alone at 1.40 ms median / 1.90
max (`gate-closeout-chunk-rebake.txt`); a 6 ms busy-wait planted in `terrain.ts`'s bake loop reds it at 7.10 ms
(`gate-closeout-chunk-rebake-plant.txt`). If it reds under load it goes to `flaky-test.md` with its numbers, not back
into a parked check.

## R38 — Projectiles fly perfectly straight in space, and that is kept

*`T22.03` flagged it as a real balance change no ruling names. It is.*

`GravityMode::Space.scale()` is `0.0`, which reaches **both** of `weapons/projectile.rs`'s
gravity terms. So in space a grenade, a rocket and a molotov all fly **dead straight, forever**
— as accurate as a bullet, and with none of the arc that makes lobbed weapons a skill.

**Keep it.** It is what "no gravity" means, it is consistent with every other body in the mode,
and a grenade that arcs in a vacuum would be the thing a player asks about. The skill the arc
provided is replaced by the fact that **you** are also drifting while you aim.

**Say it to the owner rather than burying it**, because it is a genuine change to how weapons
feel and nobody asked for it in those words.

**Reverse it by:** a non-zero projectile gravity scale in space, independent of the player's —
the two already come from different call sites.

## R39 — `body.airborne_ticks` is unhashed and is **not** a derived value

*Found by `T22.03`, pre-existing, and my own task file had it backwards.*

`T22.03`'s task file told the builder that *"`body.airborne_ticks` and `body.landing_impact` are
already unhashed, as per-tick derived values"*. **`landing_impact` genuinely is. `airborne_ticks`
is not** — it is a running counter carried across ticks, and it gates `in_coyote_time()`, which
gates `try_jump`'s `can_launch` **and** `jetpack::update`'s hold-delay branch.
`grep -c airborne_ticks crates/game-core/src/world/mod.rs` → **0**.

So **two worlds can agree on every hashed field at a checkpoint and disagree on
`airborne_ticks`** — leaving one able to coyote-jump and the other not, invisibly, with the
replay green. The sentence in my task file would have talked the next builder out of looking.

**It is pre-existing and it is not M22's to fix inside a feature task** — hashing a new field
moves every historical checkpoint and probably `REPLAY_VERSION`. **`T22.00D` owns it.**

**Reverse it by:** one contribution in `World::state_hash`'s per-player fold.

## R40 — Four parked socket flakes share one harness, and the harness is the suspect

*Three of them are in `game-server/tests/lobby.rs`; the fourth is in `integration.rs`.*

All four fail on a websocket handshake — `AlreadyClosed`, or `waited N s for 'welcome', saw 0` —
all pass standalone in under a second, and a **different member fails each time**. `CLAUDE.md`
names that pattern exactly: *"'the failure moves' is evidence against one broken test, not
evidence for load. Before concluding 'load', ask what the failing tests share."* They share the
lobby harness.

And it names the trap on top of it: the last time this reasoning ran here, the plausible shared
cause was wrong and the real one was `test_config`'s inherited `fixed_seed: None`. **So
instrument the harness before fixing it.**

**Not M22's**, and parking a fourth is the wrong direction — each park removes real coverage
(one of them is the only test that a seventh client is refused *over the wire*). **`T22.00E`
owns it.**

**Reverse it by:** unparking the four, which is the point.

## R41 — Thrust is the suit's engine, not your legs: it ignores health and boots

*`T22.03`'s review found `mods.speed` has **exactly one production reader** —
`apply_horizontal` — and T22.03 skips it while floating. So in space a player at 1 HP moves as
fast as a healthy one, and Ironman boots' speed bonus does nothing. No ruling named it.*

**Ruled: correct, and say so at the code.** `PlayerState::speed_multiplier` folds
`HEALTH_SPEED_MIN` (the low-health slowdown) and `BOOTS_SPEED_MULT` — both of which are about
**legs**. A thruster does not care how injured you are or what is on your feet.

So: **thrust does not take `mods.speed`; walking on a rock still does.** Two consequences,
both accepted and both worth stating out loud because nobody asked for them:

- **Low health does not slow you in space.** That is a small buff in the mode where mobility is
  everything, and it is the honest physics.
- **Boots are worse in space than on the ground** — they still help you walk a rock, and buy
  nothing while you drift. The review called the jump *"a free delta-v upgrade, unpriced"*;
  **measured, that is half right and the other half is the interesting half.** The *launch* is
  unpriced — the same `SPACE_JUMP_FUEL` buys 645 px/s instead of 430 — but **the return leg is
  priced**, because arresting 645 costs 0.717 s of thrust where 430 costs 0.478. Over a whole
  tank boots are a **nerf**: **2 jump-and-return round trips against a bare player's 3.**
  So boots buff one-way rock-to-rock hops, where `R1` stops you for free, and cost you anything
  you have to come back from. Both numbers are asserted.

**This needs a test**, or it is a decision nothing re-validates: assert a 1-HP and a full-HP
player thrust identically in space and differently on the ground.

**Reverse it by:** passing `mods.speed` into `jetpack::apply_thrust`, which has never taken one.

## R42 — Thrusters work while grounded, and the sub-fuel weld is a bug

*The review measured the fuel decision that plays worst.*

`space::floating` requires `!body.grounded`, so **a grounded player's held direction never
engages the pack — at any fuel level.** Measured: 1 s of UP held on a rock lifts **0.00 px on a
full tank**. And between 0 and `SPACE_JUMP_FUEL` a player is **welded to the rock**: UP is
inert, JUMP is refused, and there is no feedback at all.

Worse, **standard gravity is more generous** — `jetpack::update`'s `body.grounded` arm lets a
grounded player engage the pack once the hold delay elapses. Space currently gives a grounded
player *strictly less* mobility than gravity does, which is not what `R4`'s *"an ordinary
grounded player"* reads as.

**Ruled: a held direction engages the thrusters whether grounded or not.** What `grounded`
gates is the **walking model** and **fall damage**, not engagement. Holding UP on a rock lifts
you, which is the natural zero-g gesture and the one a player will try first.

That also dissolves the weld: with engagement available, `JETPACK_MIN_FUEL_TO_ENGAGE` (0.3) is
the only floor, and `N13` measured that a dry player recovers in **1.1 s** because refill has no
grounded requirement.

**NARROWED by `T22.03`'s fix pass, and correctly.** Taken literally, this ruling contradicts
`R4`: a grounded player holding RIGHT would **both** walk *and* thrust at
`JETPACK_THRUST_SIDE`, accelerating past `WALK_SPEED` while standing — and it would **charge
for walking**, which `R4` rules free and a shipped test asserts. So:

- **airborne** — any axis engages;
- **grounded** — only a net **upward** push engages. Sideways is legs; downward is into the
  rock and buys nothing.

All three of this ruling's invariants still hold: `grounded` no longer gates engagement, UP on
a rock lifts you (**246.78 px on a full tank, and 246.78 px at 0.40 fuel** — measured), and the
weld is gone.

**Reverse it by:** `dy < 0.0` → `dx != 0.0 || dy != 0.0` in `space::engaging`, or the
`!body.grounded` term this ruling originally named.

## R43 — Space's hazard table is **solar flares and meteor showers**

*Forced by `R28`: a table with one live kind reaches `pick_weighted` with all-zero weights,
which returns `KINDS[0]` — `ToxicRain`, a kind that is switched off. Solar flares alone would
be that table.*

**Meteor showers stay live in space, and they are the right second kind** — meteoroids in orbit
are the thing that is *actually* out there, they reuse a shipped hazard rather than inventing
one, and they give `R28`'s two-live-kinds requirement a real answer instead of a filler.

**Off in space:** toxic rain (already off globally), lava bursts (already off, and there is no
ground to open), heavy fog (there is no atmosphere to fog).

**And this makes `R29`'s load guard load-bearing in a way nobody had costed.**
`world/mod.rs::a_shower_keeps_a_bounded_number_of_drops_in_the_air` loops Standard and Low, and
its window and ceiling both divide by `gravity.scale()` — **at scale 0 they are `inf`/NaN, so
Space cannot be added without a formula change.** Worse, **Space is the worst case for the exact
quantity it bounds**: with no acceleration a drop falls at a constant `TOXIC_DROP_SPEED`, so
flight time is `d / v`, longer than either measured mode — more drops airborne, more
`ProjectileMove` on the wire.

**`T22.08` owns the space arm of that guard**, with the constant-speed formula, and it is its
red-before-green.

**Reverse it by:** the space row of the `enabled` table.

## R44 — `integrate`'s fifth argument is the **second** sanctioned temporary

*`R10`'s amendment named `apply_input`'s ninth argument and nothing else, so the only thing
anyone would check is that count.*

`integrate` is now `(map, body, gravity_scale, zero_g, dt)` — five. `T22.03` had to add it
because **`gravity_scale` cannot carry the contact rule**: verified, `jetpack::gravity_scale`
returns `0.0` for a flying player **under ordinary gravity**, and wings must keep the ordinary
rules. There is no existing value that distinguishes them.

**`T22.11` folds `zero_g` into `Forces`/`Env` along with the ninth argument.** If `T22.11`
lands and `integrate` is still at five, that is a finding, exactly as a nine-argument
`apply_input` would be.

**Reverse it by:** `T22.11`'s `Forces` absorbing it.

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

## R45 — `T22.11` is three tasks, and the seam lands first, bit-identical

**Scouted read-only 2026-09-21; the measurements are in the scout report, and I take its
recommendation.** `T22.11` as specified is **15 files** and **12 production call sites**.
`CLAUDE.md`'s *"a task is ~one file and ~250 lines; heading well past that means it needs
splitting"* is not a close call here. Split:

- **`T22.11A` — the seam, and no behaviour.** R10's `Forces` and `Env`/`MoveStep`; `integrate`
  5 → **4** parameters; `apply_input` 9 → **8**; the four non-player steppers take the mode,
  which is where **R30**'s live bug is fixed (see R48). No wells. The control is
  `resolve::a_resting_body_is_bit_identical_after_600_ticks` plus the golden table, both
  untouched — this task is a refactor that changes no pixel.
- **`T22.11B` — the field.** `world/attractors.rs` (R11), the level→pull relation with its
  basis in the doc comment, the falloff and cutoff (R47), the space terminal speed, the escape
  ceiling assertion (R46), and `World::state_hash`'s asteroid contribution (R36's
  red-before-green).
- **`T22.11C` — the client.** `GameCore::set_asteroids`, the `core/index.ts` wrapper, the
  `worldMirror.ts::applyMapInit` line, and the prediction-agreement test.

**Shape (c) — the struct — is ruled, and the deciding reason is not argument count.** Under
both rejected shapes a new caller passing `Vec2::ZERO` gets a legal, silent *"no field"* that
nothing in the tree reports — which is the shape of the twelve mechanisms this project has
built and wired to nothing. Under (c) a caller must name a `Forces`.

**The one way to reintroduce that silent failure is a `Default`**, and it is forbidden here for
the reason `MoveMods::NONE`'s doc comment already gives four files away: *"a `Default` is what
a caller reaches for when it does not know what to pass."* A `Default` would also void R10's
nominated control, which passes for a build where `accel` is never read.

**Reverse it by:** landing `T22.11` as one task.

## R46 — The escape ceiling is `JETPACK_THRUST_DOWN`, not `JETPACK_THRUST_UP`. **This overturns R18.**

**R18 and `T22.11`'s task file both state the guard against `JETPACK_THRUST_UP` = 2200.** That
is the pack's *strongest* axis. The thruster is anisotropic — measured at
`jetpack::thrust_delta`: up 2200, sideways 1100, **down 900**.

So the binding direction is a player resting on the **underside** of a rock, who must push
*downward* to leave it and has 900 px/s² to do it with. **A well of 1500 px/s² at the surface
passes R18's assertion as written and still traps that player forever** — with, in the task
file's own words, *"no cause on screen and no message"*. The guard was named *"escape is
possible"* and tested *"escape is possible from the top"*: a claim reported through something
other than the thing it claims, which is this milestone's signature defect, in my own ruling.

**The ruling.** With `d_min(r) = SPACE_ASTEROID_CORE_FRAC * r + PLAYER_H / 2.0` — the closest a
live player body's centre can sit to a rock's centre —

    max over n <= SPACE_LEVEL_MAX, r <= SPACE_ASTEROID_R_MAX  of  a(n, r, d_min(r))
        <  JETPACK_THRUST_DOWN

scoped to asteroids, so `T22.12`'s black hole keeps the inverse assertion.

If the owner ever prefers the weaker guarantee — *you can always escape upward* — that is a
legitimate call, but it must then be **written at the code that the underside of a rock is a
trap**, because nothing else in the tree would say so.

**Reverse it by:** the constant in the ceiling assertion in `constants.rs`.

## R47 — The wells fall off **linearly to a cutoff**, not as inverse-square

Arithmetic, done by the scout and re-checked here rather than remembered. Pin an inverse-square
well to R46's ceiling at the smallest rock that can reach level 5 (`r = 54`, so
`d_min = 0.75*54 + 14 = 54.5`):

    k(5)  <  900 * 54.5^2  =  2 673 225 px^3/s^2

That same well, one climb budget out at 780 px, delivers `2 673 225 / 780^2` = **4.4 px/s²** —
against an 1100 px/s² sideways thruster, which is nothing. **An inverse-square field pinned to
an escapable ceiling is either brutal at the surface or imperceptible at range; there is no
setting where it is both.**

So: `a(d) = a_surf(n) * max(0, 1 - d / R(n))`. Three things follow, and all three are why this
is the ruling:
1. `a_surf(n)` **is** the quantity R46's inequality bounds — the guard and the tunable are the
   same number, so the table cannot drift away from its own assertion.
2. `R(n) <= JETPACK_CLIMB_BUDGET` gives R18 the measured basis it asked for, stated as a
   sentence a player can feel: *a full tank always clears the well's influence.*
3. The acceleration reaches zero **continuously** at `R(n)`, which dissolves the task file's own
   objection to a cutoff — *"a well with a hard edge is a wall you fall off."*

**Reverse it by:** the falloff expression in `world/attractors.rs`.

## R48 — `T22.11A` carries R30's fix, and R30 is a bug in a **shipped** mode

R30 is filed as *"scale non-player bodies under `Low`"*, which reads like polish. It is not.
Measured: `Mines::step`, `WorldItems::step`, `Tombstones::step` and `Animals::tick` each pass a
**literal `1.0`** to `integrate`. `GravityMode::Low.scale()` is `LOW_GRAVITY_SCALE` = 0.5. So in
a low-gravity match **a dropped weapon falls at twice the speed of the player who dropped it**,
and low gravity has been playable since `T22.02` landed.

It is R10's signature change that fixes it, so it belongs to `T22.11A` and not to a later task
— but it is the only part of `T22.11A` that is *not* behaviour-neutral, and its test is the one
assertion in that task that must be red first.

**Reverse it by:** the four literals.

## R49 — R11's plumbing table is stale in `T22.11`'s favour, and `T22.05A` is why

R11 costs the asteroid-levels wire at **four layers** and says they are *"not on the wire
today"*. Measured 2026-09-21, that is no longer true: `T22.05A` shipped
`game-server/src/codec.rs::encode_map_init`'s asteroid section, `decode_map_init_parts`'s read
into `parts.asteroids` (pinned by `codec.rs::map_init_round_trips_every_asteroid_and_its_level`),
and `client/src/net/codec.ts`'s decode.

**Three layers remain**, all in `T22.11C`: `GameCore::set_asteroids`, the `core/index.ts`
wrapper, and one line in `worldMirror.ts::applyMapInit` — which already calls `setTeleportPads`
and `setGunPlatforms` two lines above, so the precedent is its own neighbour.

**And the client's position is worse than R11 states, which matters for the red-before-green.**
R11 says the client holds *stale* meta. `GameCore::new()` is `generate(1, MapScale::Small)` on
the **standard** generator, whose `meta.asteroids` is **empty**. A networked client today would
predict against a field of exactly zero everywhere — not a wrong field, *no* field. That is a
sharper and easier failure to write a test for.

**Reverse it by:** nothing — this is a correction of fact, not a choice.

## R50 — The tripwire R10, R45 and the scout all named **does not work**, and `T22.11B` must bring its own

**Measured by `T22.11A`'s builder at the live binding site, and it overturns a claim three
documents made — including two of mine.** R10 nominated
`resolve::no_tunnelling_at_ten_times_terminal_velocity_through_integrate` as *the* existing
test that would catch a `max_speed` leaking onto the standard-gravity path; R45 repeated it;
the T22.11A task file repeated it again as "Hazard 1"; the scout repeated it a fourth time.

It does not:

- `Forces::gravity` carrying `max_speed: Some(MAX_FALL_SPEED)` → **1062 passed, 0 failed.**
  `apply_gravity` has already clamped `vel.y` to 900 by the time any magnitude clamp runs, so
  on the scalar path the clamp is an exact no-op. **The test never sees 9000 px/s; it sees 900.**
- At `Some(MAX_FALL_SPEED / 2.0)` → 1 failed, and it was
  `resolve::a_landing_reports_the_speed_it_was_falling_at` — **not** the tripwire. The tripwire
  asserts `feet_y() <= 301.0`, an **upper** bound on distance, and a speed clamp can only make a
  body travel *less*.
- The obvious repair — adding `assert!(b.grounded)` as the missing presence-control — **was tried
  and reverted**, because it fails on the honest build too: the same `apply_gravity` clamp means
  the body travels 15 px/tick and cannot reach the floor in 10 ticks.

Four documents asserted a guard nobody had run. It is `CLAUDE.md`'s *"a proposed guard is a
claim, and it needs the same falsification as the code it guards"* — now missed **four** times
in this milestone from three roles, and twice by me in the same ruling chain. The scout also
conflated two tests: `vel.x = ±5000` lives in `the_body_cannot_leave_the_world_sideways`.

**The ruling.** `T22.11B` may **not** cite this test as cover for its `max_speed`. It writes its
own, and that test must drive a body **on the vector path** — where no `vel.y` clamp has already
run — past the mode's terminal speed, and assert a **lower** bound is not exceeded. The
measurement is recorded at `Forces::max_speed`'s doc comment, which is where the next reader
will look.

**The deeper reason this was missable, and the one to carry forward:** a test named for a
*speed* asserted a *distance*, and an upper bound at that. Every one of the four of us read the
name and none of us read the assertion.

**Reverse it by:** nothing. This is a measurement, not a choice.

## R51 — Eight parameters trip clippy at seven, so the `#[allow]` stays; the count is the ruling, not the attribute

`T22.11A`'s Done-when, **which I wrote**, ended with `grep -c 'too_many_arguments' … # expect 0`.
It cannot hold: clippy's threshold is 7, `apply_input` is legitimately at 8, and there is no
`clippy.toml`. The builder measured it (`warning: this function has too many arguments (8/7)`),
**declined to game the Done-when**, and reported it — which is the right call twice over.

R10 already quoted the prior comment approvingly — *"Eight, and the allow stays (T21.02)"* — so
the attribute staying is consistent with the ruling that produced it. **What R10 and R44 rule is
the parameter count: eight and four. Both are met.** A `clippy.toml` with
`too-many-arguments-threshold = 8` would be a one-line alternative; it is not worth widening a
workspace-wide lint to satisfy a grep I wrote badly.

**Reverse it by:** adding `clippy.toml`.

## R52 — `Env` carries `gravity`, and `876cb9d` does not compile alone

Two consequences of `T22.11A` worth recording so nobody re-derives them:

**`Env { accel, max_speed, gravity }`.** R10 spells `Env { accel, max_speed }` *and* requires
`MoveStep` to absorb `mods` **and** `gravity` (9 − 2 + 1 = 8). Three fields do not fit two
two-field structs, so one spelling had to gain a field. `gravity` went to `Env` — it is what the
*world* does, where `mods` is what the *player* carries — leaving `MoveStep` exactly as R10
spells it. `Forces` also gained `zero_g`, which R44 requires and which cannot be derived, since
T21.03's wings pass scale 0.0 under ordinary gravity.

**Commit `876cb9d` does not compile on its own.** `game-core` would not build without three
arity fixes in `items/spawning.rs`, a file assigned to `T22.05C`. The builder made them rather
than leave the tree broken for both agents — the right call — but they land in `T22.05C`'s
commit, so `876cb9d` is green only once that one is in. **This is the cost of splitting by file
across two concurrent agents when a signature change crosses the boundary**, and it is mine: I
drew the line. Next time the signature-change task owns every file that calls it, and the other
task waits or takes a different slice.

**Reverse it by:** nothing — a record, not a choice.

## R53 — `--changed` **is** the full gate for any `game-core` task, and the per-task economy assumed otherwise

Raised by `T22.05C`'s builder, and it is the most consequential thing either builder said.
`scripts/affected.mjs` maps **every** path under `crates/game-core/src/**` to *"all e2e and
client (the wasm is in every page)"* — **58 checks**. That is true and it is not a bug: the wasm
really is on every page, so a `game-core` change really can break any of them.

But `CLAUDE.md`'s economy — *"the Done-when per task, `--changed` per task, the full gate once
per batch by the coordinator"* — was set to stop a builder running the ~40-minute gate thirteen
times to land nine tasks. **For a `game-core` task, `--changed` and the full gate are the same
forty minutes**, so the rule as written buys nothing for most of this milestone's work, and both
builders today independently declined to run it, each giving the same correct reason: the other
agent was editing the tree, and `CLAUDE.md` says a browser run under those conditions is
worthless.

**The ruling, for the rest of M22.** A builder whose change is confined to `crates/` runs the
**non-browser** half of `--changed` — fmt, clippy, `cargo test` for the affected crates *and
their dependents*, client typecheck, client vitest, `verify-repo`, plus **any single e2e check
`affected.mjs` maps to a file it actually touched** — and says so in its report with the exit
codes, exactly as both did today. **The 58-check sweep belongs to the coordinator's batch gate
and to nobody else.** That keeps the dependents rule, which is the part that has twice caught a
commit breaking the workspace build, and drops only the part that cannot be run correctly by
two concurrent agents anyway.

**What this costs, stated so it is not discovered later:** between batch gates, a `game-core`
change is unprotected against browser regressions. That is already true in practice — nobody has
been running the sweep per task — this just stops pretending otherwise. **The mitigation is that
the batch gate must actually run, on an idle box, before the milestone closes.**

**Reverse it by:** this paragraph.

## R54 — Two agents cannot share `TASKS.md` and `JOURNAL.md`, and the pathspec rule does not help

**It happened twice today, in opposite directions.** `CLAUDE.md`'s pathspec rule
(`git commit -F - -- <paths>`) protects you from staging another agent's *files*. It does
nothing about a shared *file*: both builders appended to `tasks/JOURNAL.md` and ticked
`tasks/TASKS.md`, and whoever committed first carried the other's lines under their own message.
Both spotted it and both said where their lines went, which is the only reason it is harmless.

**The ruling.** When two builders run concurrently, **neither writes `JOURNAL.md` or
`TASKS.md`.** Each ends its report with the journal entry it wants and the row it wants ticked,
and **the coordinator appends both** — which is also the only way the two entries end up in a
sensible order rather than whichever order the commits happened to land. The commit each builder
makes is its own source files and its own task file, nothing else.

**Reverse it by:** this paragraph. Single-builder batches are unaffected.

## R55 — F1's answer: all five guards are live, and the review's worry was wrong

For the record, since `R32`/`R35`'s reasoning now rests on it. Each guard flipped **separately**
to `if false` at `meta.rs::generate_full_with`, seed 4242, Small/Medium/Large:

| guard off | a space map then ships |
|---|---|
| `teleport_pads` | **6 / 6 / 6** |
| `gun_platforms` | **3 / 3 / 3** |
| `decorations` | **3 / 6 / 10** |
| `buried_slots` | **1 / 7 / 10** — matching the number already in the ruling |
| none off | 0 / 0 / 0 |

So the review's hypothesis — that this commit removed the ground those samplers were finding,
so the guards might be decoration — is **refuted**: the filtered arena surface still seats all
three. The test now carries the claim *"deleting any one of the five makes me fail"* instead of
*"a space map has none of these today"*, which is the difference between a guard and an
observation.

**One measurement nobody asked for and it is the best thing in the task:** with only the pads
guard off, Medium's `surface_points` goes **69 → 75**; with only the platforms guard off,
**69 → 72**. That is `fill_standing_ground` adding rock *outside* an asteroid's bounding radius —
which `stamp_asteroid`'s invariant forbids. The pads ruling's central argument had been an
assertion; it now has a number.

**Reverse it by:** nothing — a measurement.

## R56 — "and the golden table" was never a control for a physics refactor, and I wrote it three times

R10 nominated, R45 repeated, and `T22.11A`'s task file and commit message both asserted, that the
controls for a behaviour-neutral physics refactor were
`resolve::a_resting_body_is_bit_identical_after_600_ticks` **and the golden table**.

`crates/game-core/tests/golden.rs` hashes **map masks**. `integrate` cannot move a map mask. So
"the golden table did not move" is true, was true before the commit, and is **evidence of nothing
about it**. That is a claim reported through something other than the thing it claims — the
second time in two days that a control of mine could not see its own subject (`R50` was the
first, and both were in the same chain of rulings).

**What the tree actually has, measured by the reviewer:** exactly **one** cross-build bit-identity
anchor, `a_resting_body_is_bit_identical_after_600_ticks` — one body, flat floor, standard
gravity, settled, peak `vel.y` ≈ 23 px/s, **never sub-stepping and never airborne**. Every other
determinism assertion (`movement_scenarios::the_same_inputs_from_the_same_state_are_byte_identical_every_time`,
`::replaying_from_a_midpoint_reaches_the_same_state_as_running_straight_through`,
`world_step::the_same_seed_and_inputs_give_the_same_state_hash_after_1000_ticks`, the
`delivery.rs` pair) compares **the same build against itself** and cannot detect a refactor
changing physics. There is no stored golden of world state.

**So these paths changed shape in `T22.11A` with nothing pinning them across builds:**
sub-stepping (`substeps`, which fires above 1 px/tick), `clamp_to_world`, the knockback path
(`weapons/explode.rs` and `weapons/melee.rs` write `body.vel` outside `integrate`), wings at
`gravity_scale == 0.0` under `Standard`, and the jetpack.

Severity is genuinely low and the reason is worth keeping: the new line is
`body.vel += forces.accel * dt` with `accel == Vec2::ZERO` everywhere, i.e. `x + 0.0`, exact for
every finite float **except** `-0.0` → `+0.0`; and the reviewer checked that nothing can see that
difference (`move_x`/`move_y` both open with `if dx == 0.0 { return }`, and `-0.0 == 0.0`; no
`signum` or `is_sign_negative` on a velocity anywhere in `physics/`, `player/` or
`items/world.rs`). **The risk is low and the evidence was thin — those are different statements,
and I published the second as the first.**

**The ruling.** Nothing cites the golden table as a control for a physics change again. A
literal-position golden written now is pinned to today's code and cannot retroactively confirm
`T22.11A`; only a run against `876cb9d^` could. `T22.11B` is told not to inherit a belief that
bit-identity was measured broadly, because it was not.

**Reverse it by:** nothing — a correction of fact.

## R57 — Two of `T22.05C`'s remedies do not do what their comments say

Found by the second review. Both are the class the task was written to close, which is why they
are worth a ruling rather than a quiet fix.

**(a) The biconditional passes in the direction it claims to catch.**
`items/spawning.rs::crates_spawn_inside_the_arena_in_space` asserts
`assert_eq!(space_moved == 0, GravityMode::Space.scale() == 0.0, …)`, and its comment claims it
*"reports the mechanism coming apart in **either** direction — a stepper that stops reading the
mode, or a scale that stops being zero."* Plant `Space.scale()` 0.0 → 0.5: the right side becomes
`false`, crates fall so `space_moved > 0` and the left side becomes `false` too, and
`assert_eq!(false, false)` **passes**. It is `CLAUDE.md`'s measured `ITEM_SPAWN_INTERVAL` shape
exactly — every term moved with the constant. The first direction does hold. The repository is
still covered, by `constants.rs::every_gravity_mode_has_a_multiplier`, so this is a **wrong
sentence beside working code**. Fix: split the effect (`assert_eq!(space_moved, 0, …)`, keeping
its existing `ctl_moved > 0` presence control) from the pin, and narrow the comment to the
direction that holds.

**(b) An assertion behind a guard that fires first.**
`periodic_items_land_inside_the_arena_in_space` gained a `body_fits_at` assertion **inside** its
item loop, to replace a message the commit correctly diagnosed as unhelpful. Under the very plant
it was written for — `random_body_site`'s space arm drawing from `surface_points` —
`resample_surface` rejects every draw at its own `body_fits_at` re-check (which is what the new
disjointness test proves), so nothing spawns, `seen` stays 0, **the loop body never executes**,
and the test still dies on `assert!(seen > 0, "no periodic items spawned at all")`. The defect was
always the guard's *message*, and adding an assertion behind it changes nothing. Its sibling
`initial_items_land_inside_the_arena_in_space` **does** improve, because `place_initial` has no
re-check. Fix: instrument the schedule's two stages separately, so *"fired N times and every draw
was rejected"* reads differently from *"never fired"* — and not by calling `resample_surface`,
which would restate the function under test.

**Reverse it by:** the two sites named.

## R58 — `R14`'s "no animals in space" row was never implemented and has no owner. Assigning it.

`R14`'s table gives `world/animals.rs::Animals::tick` → **"no animals at all in space"**, and adds
*"this also answers the `birds.rs` row"*. Measured by the reviewer: `world/mod.rs::step_animals`
passes `playing` as `active` with **no mode test**; grepping `Space` and `Generator` in
`world/animals.rs` returns only `T22.11A`'s new test plus one unrelated comment, and
`world/birds.rs` returns **nothing at all** — the grep exits 1. **CORRECTED 2026-09-22 by `T22.13`'s builder, who re-ran all three claims before starting, as `R60` requires.** This ruling said *“one unrelated comment”*; there is none. I had restated the reviewer's measurement without re-running it, in the same commit as `R60`, whose subject is that a restated measurement is not a measurement. Immaterial to the work and exactly the habit `CLAUDE.md` names: *“a status line is a measurement, and it is only valid at the moment it was taken.”* **Nothing suppresses either.**

So today a space round spawns beetles and spiders, which stand on the rim and on asteroid tops in
a vacuum. `T22.11A` correctly read the ruling down to *"a spawning rule and not this stepper's"*
and said so at the code — which was right, and left the ruling orphaned, because `R45` gave
`T22.11A` only the four signature changes and neither `T22.11B` nor `T22.11C` mentions animals.

**Assigned to `T22.13`.** One hazard, from the reviewer and worth obeying: **gate on the
generator, which `R15` derives from the mode, not on `self.gravity`** — otherwise the two can come
apart, which is the failure `R15` exists to prevent.

**Reverse it by:** the task assignment.

## R59 — `R52`'s wording about `876cb9d` is one word too strong

`R52` says `game-core` *"would not build"* without the arity fixes. Measured: all three missing
call sites are inside `#[cfg(test)] mod tests` in `items/spawning.rs`. So at `876cb9d`,
**`cargo build -p game-core` succeeds and `cargo test -p game-core` fails to compile.** Everything
else in `R52` stands, and the distinction is worth the word to whoever bisects through that
commit.

**Reverse it by:** nothing — a correction.

## R60 — Overturning a ruling is not done until every site that repeats it is annotated

`T22.11B`'s builder, asked to report text contradicting `R46`/`R47`/`R50`, found **five live
sites** still asserting the disproven claims — including **`R10` in this file**, unannotated,
while `R18` two screens away had carried a `SUPERSEDED IN PART` banner since the day it was
overturned. I wrote both. The scout report repeated the tripwire claim **four times**, and
`tasks/DECISIONS.md` still summarised R18's ceiling against the wrong constant.

`CLAUDE.md` already has the instrument and I did not use it: *"before rewording a rule,
`grep -rn "<old phrase>" tasks/ CLAUDE.md"*. I applied that discipline to the ruling I was
editing and not to the ones that cited it. **The failure mode is specific: the overturned ruling
gets its banner, and every document that repeated it keeps asserting it with no banner at all** —
and a builder reads the task file, not the rulings file.

Swept 2026-09-22, all five annotated rather than deleted, so the correction has something to
attach to: `R10`'s tripwire bullet, `R18`'s point 2 inline, `T22.11A`'s Hazard 1,
`T22.11-asteroid-gravity-wells.md`'s R18 point 2, `DECISIONS.md`'s R18 summary, and a
dated-artifact banner on `T22.11-SCOUT.md` naming its own five repetitions.

**The ruling, and it is procedural: when a ruling is overturned, the same commit greps for every
site that repeats it and annotates each one.** A supersession banner on the original is the
cheapest half and it is not the job.

**Reverse it by:** this paragraph.

## R61 — `REPLAY_VERSION` 14 → 15 is ratified

`T22.11B` bumped it, and the reasoning is right. `World::state_hash` now covers the asteroid
table, so **every checkpoint hash in a space recording moves**, and a v14 space recording replayed
against the new field lands players in different positions. `replay.rs`'s own policy bumped 13 for
exactly this shape. No committed fixtures are invalidated — `recordings/` is gitignored and
nothing reads it.

The builder hashed `x`, `y` and `r` as well as `level`, because `world::attractors` reads all four
and the mask carries a rock's *shape* but neither its centre nor its bounding radius. That is the
correct set: hashing only `level` would have left a displaced rock invisible to the guard, which is
the failure R36 exists to catch.

**Reverse it by:** the constant.

## R62 — `world/attractors.rs` at 889 lines does not need splitting

Flagged by its own builder rather than left for me to find, which is the behaviour this project
wants. The number breaks down as **65 lines of non-comment production code**, 147 of module and
item docs, and 676 of tests.

`CLAUDE.md`'s *"a task is ~one file and ~250 lines"* is a limit on **how much work one assignment
carries**, not on how much evidence a file may hold. 65 lines of production code is a small module;
splitting it would put the tests somewhere other than beside the code they test, which this project
requires (*"Rust tests live in the same file under `#[cfg(test)] mod tests`"*). One module, one
public surface, and the ratio is the argument.

**Where this stops being true:** if `T22.10`'s vortex and `T22.12`'s black hole each add production
code to it, the 65 will not stay 65. Revisit at that point, and split by attractor kind if at all.

**Reverse it by:** this paragraph.

## R63 — Nothing asserts the wells on rendered pixels, and `T22.11C` owns it

`T22.11`'s Done-when named `node scripts/e2e.mjs asteroid-gravity`. Measured by the builder:
`grep -rn "asteroid" scripts/` returns **0**. The check does not exist and never did, so that
Done-when would have failed with *"unknown check"* rather than a failing assertion — a different
signal, and one nobody had filed.

This matters more here than the usual missing-check case. `CLAUDE.md`: **for anything visible,
assert on rendered pixels** (`docs/72` §C2), with a control region and a control frame — *"four 'I
cannot see it' bugs shipped past 905 tests because every assertion checked simulation state."* The
wells are now proven in Rust from nine angles and **not once on screen**. A field that is correct
in the simulation and invisible to the player is precisely the shape that rule was written for.

**Assigned to `T22.11C`**, which is the client task and already has to prove prediction agrees with
the server.

**Reverse it by:** the task assignment.

## R64 — The remedy-falsification rule worked **forwards** for the first time, in a builder's hands

Worth a ruling because `CLAUDE.md`'s *"a proposed guard is a claim, and it needs the same
falsification as the code it guards"* has been invoked four times this milestone and **every one was
after the fact**, in a review, against someone else's work.

`T22.05D` — the task whose entire subject was two comments claiming more than their assertions
carried — wrote a third one. Its first cadence-guard message said *"…so nothing below this line ran
and the placement guard rules nothing out."* Then it planted the bug that guard was for (dropping
`tick_items`' deadline advance) and **items still spawned**, so `seen > 0` and the sentence was
false. It rewrote the message to claim only what is true, and reported the near-miss as *"the same
class as the two defects this task closes."*

**Two things follow and both are the ruling.** First: the rule pays for itself at the moment of
writing, not only in review, and it caught a defect that three reviews of adjacent code had not.
Second, and sharper: **the near-miss happened inside the fix for exactly that defect**, by an agent
holding the taxonomy in front of it. That is evidence the failure is not carelessness but the
default shape of the sentence a person writes next to an assertion they just made — which is why it
needs an instrument rather than attention.

**How to apply:** when a task's deliverable is a guard or a message, plant the bug it names and read
what it prints, not merely whether it fires.

**Reverse it by:** nothing — a record.

## R65 — A builder running browser checks and a builder planting falsifications cannot share a box, and the *"tree moved"* signature is now ambiguous

**My scheduling error, twice over in one batch.**

`T22.13`'s `animals` and `birds` e2e runs failed with `Cannot read properties of undefined (reading
'debug')` — `CLAUDE.md`'s *"the tree moved"* signature — and it was **literally true**: `pgrep`
caught `T22.11C` mid-run with a deliberate `// FALSIFICATION` patched into
`crates/game-wasm/src/lib.rs`, on the **shared vite at :5173**. `T22.13` diagnosed it, waited on the
PID, confirmed the plant was gone and re-ran to 2/2, with an unrelated check passing as its control.
That is the right handling of a problem it should never have been handed.

`CLAUDE.md` already says *"nobody edits anything under `claude/` while a gate runs"*, and I had read
that as being about the coordinator's batch gate. **A falsification plant is an edit, and a builder's
own e2e check is a gate** — the rule covers this exactly and I scheduled against it.

**The ruling:** a batch may contain at most one builder that runs browser checks **or** at most one
that plants falsifications in crate code, not both. Three builders on disjoint *files* is still one
shared vite and one shared wasm build.

**And the second half, which is the durable finding.** `T22.11C` also recorded that negating
`field_accel_at` produced the **same** `Cannot read properties of undefined (reading 'debug')` — not
from a moved tree, but because a lying field drives the body off the map and `window.__game` goes
away. **So that signature now has at least two causes**, and `CLAUDE.md` says reading it wrongly
costs the next thirty-five minutes. Anyone meeting it must check `pgrep` *and* whether the subject
could have destroyed the page, before concluding either.

**Reverse it by:** the batching rule above.

## R66 — `scripts/checks/asteroid-gravity.mjs` at 578 lines does not need splitting

Flagged by its own builder. 578 lines, **359 of them code**; `minimap.mjs` next door is 494. Same
reasoning as `R62`: the ~250 guidance limits how much work one assignment carries, not how much
rationale a file may hold, and here the non-code half is the reason each of five guards exists — a
camera clamp that put a patch on the fps readout, a crosshair that travels with the body, a day cycle
that moved a patch 32.5 px with the body provably still. **That commentary is the most valuable part
of the file**, because every line of it is a wrong version of this check that someone already wrote.

**Reverse it by:** this paragraph.

## R67 — `GameCore::field_accel_at` is ratified, and it is `R11`'s rule doing its job

New API, added unasked, and correctly. The pixel check must know which way the field points **before
the body moves** — otherwise the direction is derived from the motion it is meant to be evidence
about. The only alternative was summing the falloff in JavaScript, which is **the second spelling
`R11` exists to prevent**, and both prior rubber-band bugs in this project were a mirror inventing a
value the core already had.

Pinned by `field_accel_at_reports_the_summation_the_server_runs`, including the two `[0,0]` arms the
browser check depends on. No `asteroids()` twin was added, because `meta_json` already serialises
`MapMeta` and a second accessor would be a second answer.

**Reverse it by:** deleting the accessor and giving the check a geometric approximation instead —
which would be worse for the reason above.

## R68 — `R40`'s socket family has a sixth member, and it is still recorded rather than parked

`game-server/tests/checksum.rs::two_clients_agree_on_the_mask_after_a_hundred_carves`, `saw []`,
the same empty-inbox handshake as the other five. Filed in `tasks/flaky-test.md` and **not
`#[ignore]`d**, per `R40` — parking a sixth is the wrong direction and `T22.00E` owns the harness.

Two things make this row better evidence than the earlier ones, and both were the builder's doing:
it **neutralised its own change** and re-ran, watched the failure *move* to a different test, and
only then stopped suspecting itself; and it asked what the failures share before saying "load",
which `CLAUDE.md` requires because *"the failure moves"* is evidence against one broken test, not
evidence for load. The shared thing is a wall-clock deadline on a socket handshake, and every red in
this batch overlapped a concurrent builder's gate while the run with no overlap was 1553/0.

**The cost, stated plainly:** this one guards the carve-determinism agreement between two clients,
which is the guarantee the whole project rests on, and it is now unreliable exactly when the box is
busy — which is when a gate runs.

**Reverse it by:** `T22.00E`.

## R69 — The old shader instrument would have **passed a browser that had stopped rendering**

The single best measurement of this milestone, and it came from an arm I asked for as a
formality. `T22.00F` killed `requestAnimationFrame` in the High-Quality arm of each check and read
what the **old** form would have reported: **1.9 %, 2.4 %, 5.2 %, and fog drift 12.07 — every one
of them above its floor.**

So the two-frame wall-clock instrument does not merely fail at random. **With the page dead and
nothing drawn at all, it reports "the shader animates" and passes.** The noise it was sampling was
never the shader; it was whatever the compositor happened to do between two `sleep`s. That also
explains the shape of `smoke-shader`'s history — the same condition can land on either side, so it
produced *false sightings* rather than a consistent failure, which is far more expensive.

`CLAUDE.md`'s rule is *"ask what a passing assertion rules out"*. The honest answer for the old
form is **nothing at all**: it would have passed with the feature deleted *and* with the renderer
switched off. All four now carry the page-not-drawing arm as a distinct red with its own message.

**Reverse it by:** nothing — a measurement.

## R70 — `fog-visible`'s red was **not** load, and I said it was. It reads two clocks.

**Correcting myself twice.** `T22.00F`'s task file — mine — told its builder that the
0.783-against-0.794 red belonged to `fog-shader` and to check whether it was the same wall-clock
defect. It is not in `fog-shader` at all (`grep -n FOG_SCREEN_ALPHA scripts/checks/fog-shader.mjs`
→ nothing); it is `fog-visible.mjs`'s. And earlier I told the owner that gate's four failures were
**load**, on the evidence that all four re-ran green on an idle box.

That evidence was real and the conclusion was too broad. **Re-running green does not make a
marginal instrument sound**, and this one has a defect that load merely exposes:

- `fogStrength` is `self.fog.strength(self.roundTime)` — computed **live at the `debug()` call**;
- `fogAlpha` returns `weather.ts::lastFogAlpha` — written at the **last drawn frame**;
- they are compared at a tolerance of **0.01**, and the poll breaks at `s.s >= 0.99`, deliberately
  **while the ramp is still climbing**.

One value from now, one from the last frame that rendered, on a moving quantity. At the 13–20 fps
these gate logs show, one frame of `FOG_RAMP` is worth several times 0.01. The tree's own logs read
0.785, 0.798 and the 0.783 that failed — it passes when the skew happens to be small.

**The builder refused its task's premise and measured instead**, which is the behaviour that makes
a wrong task file cheap rather than expensive. `T22.00F`'s own instrument does **not** fix this —
it is not a two-frame sample of a drifting shader, it is one sample of two quantities off two
clocks — and it said so rather than applying the fix it had in hand. Filed as `T22.00G`.

**The lesson for me:** *"the failures re-ran green, so it was load"* is the same shape as *"the
failure moves, so no single test is broken"*, which `CLAUDE.md` already records as wrong. **Ask
what the failing checks share before crediting the box.**

**Reverse it by:** nothing — a correction.

## R71 — `T22.00C` is narrowed to the shared helper, and the duplication got worse on purpose

`T22.00F` did the work `T22.00C` had surveyed — all four checks converted, **no threshold moved** —
which leaves exactly one thing from that file undone: the helper. There are now **five** copies of
`advanceFrames` (measured, one per shader check), where `T22.00C` had argued *share the guard, or
share the function*.

The builder did that deliberately and reported it: `T22.00F`'s **Touch only** forbade both
`harness.mjs` and `smoke-shader.mjs`, so a partial lift would have left **two spellings** of the
instrument instead of one, which is worse than five copies of one spelling. **Following the live
task file over the tidier instinct was right**, and the diff came in at 484 lines against my ~120
estimate as a direct result — worth knowing when I next size one of these.

`T22.00C` now says: lift all five into `scripts/lib/harness.mjs` and delete the copies.

**Reverse it by:** closing `T22.00C` as superseded and accepting five copies.

## R72 — The batch gate is ~45 s slower, and that is the price of the instrument

`beams-shader` 21.9 s → 37 s, `fog-shader` 33 s → 62 s, about **+45 s** across the four. Stated
here so it is not later mistaken for a regression, and accepted: 45 seconds against an instrument
that `R69` shows would pass a dead renderer is not a trade worth thinking about twice.

**Reverse it by:** nothing.

# What this milestone owes when it lands

`docs/77-amendments-v9.md`, written by me, covering: the gravity setting (`docs/` does not
describe it), space's override of `docs/13` weather, `docs/14` day/night and `docs/10` map
generation, radiation, the flare, the vortex, the wells, the black hole — **and the fall
damage override at `docs/20-player-movement.md:235`**, outstanding since T20.11 and closed
in the same pass.

**Written 2026-09-25: [`docs/77-amendments-v9.md`](../../docs/77-amendments-v9.md)** (§H1–§H21), with the
superseded values struck in `docs/02`, `docs/13` §7, `docs/20` (fall damage → `docs/76` §G1), `docs/40`, `docs/42`
and `docs/70` §A30.

# Index — the rulings recorded in task files (`R73`–`R100`, and the final audit's addenda)

`R1`–`R72` are above. From `R73` on, the coordinator's rulings were recorded in the "As ruled" section
of the task that built them; the full text, and each one's *Reverse it by*, is there. One line each.
`docs/77-amendments-v9.md` states the resulting rules.

| id | ruling | full text |
|---|---|---|
| R73 | radiation split into a Rust end and a client end | [T22.09](T22.09-radiation-and-the-shield-economy.md) |
| R74 | the per-second radiation accumulator is a hashed `PlayerState` field (`R25` outranks "no new fields") | [T22.09](T22.09-radiation-and-the-shield-economy.md) |
| R75 | the radiation death cause is a transient per-tick list on `World`, never re-derived from "space and unsealed" | [T22.09](T22.09-radiation-and-the-shield-economy.md) |
| R76 | the battery pack's doubling is on the natural Spawn column only; crates unchanged | [T22.09](T22.09-radiation-and-the-shield-economy.md) |
| R77 | `REPLAY_VERSION` 15 → 16 for radiation | [T22.09](T22.09-radiation-and-the-shield-economy.md) |
| R78 | the per-mode weather table is derived at roll time, keyed on the map, never on `World::gravity` (overrides `R28`'s constructor) | [T22.08](T22.08-solar-flares.md) |
| R79 | a hashed `PlayerState::burning_until`, written not added, cleared at death and respawn | [T22.08](T22.08-solar-flares.md) |
| R80 | no new wire bit for the flare: drawn from `GameCore::flare_points` and the damage events | [T22.08](T22.08-solar-flares.md) |
| R81 | the flare's burn is logged once a second, before radiation's stage | [T22.08](T22.08-solar-flares.md) |
| R82 | the suit softens the flare per `R2`; the basis states both totals | [T22.08](T22.08-solar-flares.md) |
| R83 | forced flares are refused off a space map; `WEATHER=flare`; unknown kinds refused | [T22.08](T22.08-solar-flares.md) |
| R84 | `R43`'s load guard re-pointed to a meteor-in-space peak guard | [T22.08](T22.08-solar-flares.md) |
| R85 | `REPLAY_VERSION` 16 → 17; `docs/13` §7 reported for `docs/77` | [T22.08](T22.08-solar-flares.md) |
| R86 | a vortex's destination is outside `VORTEX_REACH / 2` of every vortex; capture ignores the cooldown; fallback farthest, never skip | [T22.10](T22.10-the-breach-vortex.md) |
| R87 | a breach is reported only on closed → open of the rim box | [T22.10](T22.10-the-breach-vortex.md) |
| R88 | an evicted vortex stops pulling and fades but keeps catching | [T22.10](T22.10-the-breach-vortex.md) |
| R89 | one simulated step per player per tick — stand-ins, a jitter buffer, the ack is the last simulated seq; the catch-up credit deleted | [T22.10F](T22.10F-a-silent-player-hangs-in-the-air.md) |
| R90 | the black hole's pull at the horizon is `JETPACK_THRUST_DOWN` × 0.9: outside the ring every thrust escapes, inside it you die | [T22.12](T22.12-the-black-hole.md) |
| R91 | within the hole's reach the asteroid wells do not pull (widened by `T22.14A` H1 to the vortices) | [T22.12](T22.12-the-black-hole.md) |
| R92 | a black-hole death drops nothing | [T22.12](T22.12-the-black-hole.md) |
| R93 | a 2 s telegraph at the arrival spot, and the hole on the minimap | [T22.12](T22.12-the-black-hole.md) |
| R94 | every round phase is counted in ticks; `round_state` carries `ends_tick` | [T22.12](T22.12-the-black-hole.md) |
| R95 | bots may select zone weapons, scored by damage over time; the space reach measured against standard's own-hit rate | [T22.03C](T22.03C-bots-throw-what-burns.md) |
| R96 | the summed asteroid wells are capped at `SPACE_WELL_ACCEL_MAX` | [T22.03G](T22.03G-wells-that-outpull-the-thrust.md) |
| R97 | the wells and every live vortex's pull are capped together; outside the capture radius escape is always possible | [T22.03I](T22.03I-what-the-cap-review-found.md) |
| R98 | the vortex's one drawn line is the capture ring; the swirl marks no boundary | [T22.10I](T22.10I-the-ring-marks-the-capture.md) |
| R99 | in space meteors start inside the rim and fly at the asteroids; weather ordnance reaching the rim despawns uncarved | [T22.14A](T22.14A-what-the-final-audit-found-hazards.md) (addenda) |
| H3 | weather damage is refused in `Ended`; a shower's `active_duration` includes its fall | [T22.14A](T22.14A-what-the-final-audit-found-hazards.md) (addenda) |
| R100 | a winged player in space feels no field — wells, vortex pull, black-hole pull; capture and the horizon still apply | [T22.14C](T22.14C-what-the-final-audit-found-netcode.md) |

Two confirmations without new ids, both in [T22.14B](T22.14B-what-the-final-audit-found-bots.md)'s "As ruled":
`R95`'s reading and `BOT_FLAME_REACH_SCALE` 2.0 in standard; `T22.03I`'s "no carve-out inside the capture radius".
