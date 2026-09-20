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

## R13 — Outside the rim is **void**, and the rim is ordinary rock

*`T22.05A`, which asks what is in the `WALL_W` strips a circle leaves in a rectangle.*

- The rim is a thin annulus of **ordinary destructible mask**. Not `WALL_W`, not bedrock —
  `T22.10` is a whole task about breaking it and the owner said *"you can still destroy it
  obviously"*.
- **Outside the rim there is nothing** — empty mask, the backdrop showing through. Not
  rock. A breach therefore opens onto real emptiness, which is what makes the vortex a
  containment mechanism with something to contain rather than a door into more rock.
- The `WALL_W` columns and the `BEDROCK_H` floor still exist and are still indestructible.
  They sit **outside the circle, in that void**, and a player only ever meets them by
  breaching the rim and out-running a vortex. That is a hard invisible edge and it is
  accepted: `clamp_to_world` already guarantees nobody leaves the world, and R9's vortex is
  what makes it unreachable in practice.
- Asteroid **gravity level correlates with radius**, monotonically, with jitter. A big rock
  with a weak pull reads as broken. `T22.05A` asks for this to be said either way; it is
  said.

**Reverse it by:** the fill step in the space generator — one pass that currently writes
nothing outside the annulus.

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
