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
