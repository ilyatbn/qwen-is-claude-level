# M22 — Space: a match played in orbit

**Specified 2026-09-18 at the owner's request, and not started.** *"dont work on it yet just
make it a separate milestone since its probably larger than you think."* It is larger: the
count below is **thirteen tasks**, five of them large, and one of them is a second map
generator. It grew twice on the day it was written — the vortex, then asteroid gravity and the
black hole — and each addition made an earlier task bigger rather than sitting beside it.

Built out of four tasks that were parked in M21 (`T21.05`–`T21.08`) plus everything the owner
added on 2026-09-18. The four originals are superseded, not lost — each task below names the
file it came from, and they were removed from `tasks/parking-lot/` in the same commit that
created this folder, so `git log --diff-filter=D -- tasks/parking-lot` finds them.

## The ask

The M21 half, verbatim, as it was recorded when the originals were written:

> *"gravity: standard, low, none. Low gravity mode makes everything a bit slower (including
> projectiles), it also makes you jump higher and drop slower. Fall damage is much lower
> here."*
>
> *"no gravity mode makes everything basically float in space… In no gravity mode the players
> movement just doesn't stop. If they move in a certain direction, it's constant until they
> hit something. Jumping and even moving now takes jetpack energy."*
>
> *"this mode reshapes the map and how it's generated. Instead of normal, it now creates a thin
> layer of 'land' around the map edges. It can be squared, a circle, or some other shape that
> wraps everyone together. Then you generate tons of tiny islands inside this square but enough
> space to float between them, like stars. You can generate objects anywhere since there's no
> 'up'."*
>
> *"players are now in a spacesuit skin (make one with several colors and have a different
> visor color selection)."*

And the 2026-09-18 additions, verbatim — **three separate messages, each of which grew the
milestone**:

> *"there's no day/light in space but the sun and moon and the earth and stars can be the
> background and should move. there are no clouds or fog or anything like that."*
>
> *"you can use the reuse the wings mechanic for movement in space but add the no-gravity part
> to it. moving in space requires using energy, from the spacesuits thrusters, so add a cool
> animation to it so that if i move down, you can see a burst of energy coming from above the
> player."*
>
> *"there should be new hazards. solar flares (make it a cool shader) burns players touching it
> for N seconds (default to 4). should look like a magnetic solar prominence loop or fiery
> ribbon strand moving at random on the map. radiation. players who dont have a shield are hit
> by radiation taking 1 damage per second. all players have a shield by default in a spacesuit,
> but energy is still a thing so they need to make sure to constantly replenish it with battery
> packs."*

> *"lets add a fun secret. if you make a hole in the outer layer of the map (that wraps the
> boundaries, you can still destroy it obviously), it creates a vortex that sucks you in and
> pops you back out in a random location on the map."*
>
> *"each 'island' (lets make it an asteroid since we're in space) has its own internal gravity.
> it pulls players towards it. they have several levels of gravity, lets say 1-5. its harder to
> escape from them."*
>
> *"add a new hazard. black hole. this is a permanent one and appears randomly at the last
> minute. it will destroy one of the many random 'asteroids' and suck players into it if they
> get close. they die immmediately. if you get within the range of it, you cannot escape."*

A reference image came with it: an asteroid arena — rocky islands floating inside a **closed,
glowing circular boundary**, astronauts on and between them, satellites and a nebula behind.
That picture answers a question the original `T21.07` left open; see the findings.

## What re-reading the four originals changed

The owner asked for a re-check. Eight things moved, and two of them shrink the work.

**1. The gravity chain no longer depends on a parked task.** `T21.05` declared *"Depends on:
T21.04 (the settings pattern)"* — the day/night setting, parked separately and still parked.
The owner has now ruled day/night **out** of space entirely, and the settings *path* it was
going to copy is **`docs/75` §F7's**, which landed — **not T20.07's, which is the flashlight
task and adds no lobby setting** (corrected 2026-09-20, after a builder followed the pointer
and found nothing there). So the dependency is void and nothing in M22 waits on
the parking lot. This was the chain's only external block.

**2. Zero-g movement is most of the way built, because wings shipped.** `T21.06` was written
2026-09-06, before T21.03 existed. Today `jetpack::gravity_scale(state, flying)` **already
returns 0.0 for a flying player**, and its own comment calls that *"the third regime"* and says
why it lives there rather than at the call site. `MoveMods.flying` is already derived, already
on the wire, already read by `prediction.ts`. The owner's *"reuse the wings mechanic"* is
therefore not a suggestion to follow — it is a description of a seam that exists. What is left
is the part wings do **not** do: momentum that never damps, a collision rule, and a fuel cost
on horizontal movement. `T21.06`'s long argument about `GRAVITY = 0` not compiling is still
true and still the reason, but the scale-of-zero path it recommends is now a shipped feature
with tests around it rather than a plan.

**3. The boundary shape is decided: a circle.** `T21.07` said *"square, a circle, or another
wrapping shape — pick one, build one, and say why the others were not"*. The reference image is
a circle with a glowing rim. Build the circle.

**4. Weather is no longer "arguably off" — the owner ruled, and the seam is now free.**
`T21.07` said *"Weather is arguably off in zero-g — say so explicitly"*. The owner: *"there are
no clouds or fog or anything like that"*, plus two hazards that exist **only** here. On
2026-09-16 `EffectScheduler`'s `toxic_enabled` bool became `enabled: [bool; N]`, a per-instance
field that is already hashed and already injected through `with_enabled`. A per-*mode* hazard
table is that field taking its value from the match setting instead of from
`enabled_from_constants()`. The work is a constructor argument, not a redesign.

**5. `BurnField` is the wrong home for a solar flare, and its own first line says so.**
`weapons/burn.rs` opens *"Damaging ground zones"*, and §F12's reasoning is that a fire which
drifted off the ground *"would be a second fire"*. A flare is a ribbon moving through open
space with no ground under it. Either it is a new hazard shape or `BurnField` is generalised
deliberately — **decide before writing, and do not quietly widen a type whose doc comment
argues against it.**

**6. Radiation collides with a shield that already exists.** `PlayerState::shield_active(now)`
ships, driven by the shield-generator *item*, with `SHIELD_DAMAGE_MULT` and `SHIELD_HIT_COST`
against the battery. The owner says *"all players have a shield by default in a spacesuit"*.
So is the suit's shield the same mechanism with a different source, or a second thing that also
answers "is this player shielded"? **That is the field-means-two-things shape**, and it is an
owner question, below.

**7. The golden fixture grows and must be regenerated, not nudged.**
`crates/game-core/tests/golden_hashes.txt` holds **24 data rows** (4 seeds × 3 scales × 2
generators, plus two comment lines — counted, not remembered). A third generator makes it 36.
`T21.07`'s analysis of *why* hashes move is correct and worth reading in full from git: not
shared RNG, which is isolated and pinned by two tests, but the **retry loop** — `report.passed`
comes from `traversal::analyse`, which reads `JUMP_REACH`/`JUMP_HEIGHT`, compile-time consts of
`GRAVITY`. Changing which attempt first passes re-derives every substream.

**8. Battery packs already exist.** `BATTERY_PACK` is item id 6 with `BATTERY_PACK_AMOUNT`.
The owner's *"replenish it with battery packs"* needs no new item — it needs a reason to want
one, which is what radiation supplies.

## What the owner still has to rule on

Carried from `T21.06` where still open, plus the new ones. **None of these block writing the
task files; all of them block the code.**

1. **Contact in zero-g: stop, or bounce?** *"Constant until they hit something"* does not say,
   and the two play completely differently. The reference image shows astronauts standing on
   asteroids, which leans to *stop and stand*, but that is an inference from a picture.
2. **Is the suit shield the shield generator, or a second shield?** See finding 6.
3. **Does low gravity survive as its own mode?** The owner moved `T21.05` here but described
   only space. If low gravity is not wanted, `T22.02` is deleted and `T22.01` offers
   `standard | space`, which is smaller and simpler.
4. **What is `grounded` in zero-g?** `T21.06`'s question 1, unchanged and still the design
   decision the whole model turns on — it gates jumping, friction, fall damage, `ground_snap`,
   step-up and the entire bot movement model.
5. **What do bots do?** `T21.06`'s question 3. A bot with a walking model in zero-g never
   moves, and `balance.rs` would measure that as a game with no fights.
6. **Radiation: everywhere, or in places?** *"players who dont have a shield are hit by
   radiation"* reads as ambient and constant. If it is ambient the mode has a permanent
   energy drain and battery packs become the pacing item; if it is zonal it is a hazard like
   the others. Ambient is the straight reading and is assumed below.
7. **Do players pulled toward an asteroid orient to its surface?** `T22.11`'s question, and the
   expensive one: if they do, every upright-drawn thing is wrong — the walk cycle, the weapon
   flip, the hats, the name labels, the bars. The reference image shows astronauts upright on
   rocks whatever side they are on, so **no** is assumed, and it is a tenth of the work.
8. **The black hole — four rulings**, listed in `T22.12`: every round or sometimes; whether it
   grows; whether it keeps eating; and what it does once the round is over.
9. **The vortex — five smaller rulings**, listed in `T22.10`: whether it catches a player
   wearing wings (the straight answer is yes, but wings were just given the opposite rule for
   pads and platforms); one hole or many; whether a hole heals; whether items and projectiles
   are pulled in; and whether it shows on the minimap, which a *secret* argues against and
   usability argues for.

## Build order

    T22.01 ─┬─ T22.02
            ├─ T22.03 ── T22.04 ─┐
            ├─ T22.05A ─┬─ T22.05B ── T22.07
            │           ├─ T22.10
            │           └─ T22.11 ── T22.12
            ├─ T22.06
            ├─ T22.08
            └─ T22.09

    T22.04 ── T22.11   (the thruster's delta-v is what "harder to escape" is measured against)

- **T22.01 first and alone.** Everything reads the setting.
- **Then five independent branches.** `T22.02`, `T22.03`, `T22.05A`, `T22.06`, `T22.08` and
  `T22.09` need only the setting.
- **`T22.03` and `T22.05A` are the two large ones** and are independent of each other —
  the movement model is observable on an ordinary map, the generator is asserted on map
  properties. `T21.06` and `T21.07` once declared each other and deadlocked; that correction
  is preserved here.
- **The mode is not playable until `T22.03` and `T22.05B` are both in.** A model with nowhere
  to float and a map nobody can traverse are each half a feature.
- **`T22.07` last of the map chain** — spacesuits are the mode's skin and the mode has to exist.
- **`T22.10` needs the rim to exist and shares `T22.05B`'s destination picker**, so it is
  startable after `T22.05A` but not finishable before `T22.05B`.
- **`T22.11` is the other large one and it is not optional.** Asteroid gravity turns "zero-g"
  into "no global gravity, many local wells", which is a different feel and a different physics
  problem — and the seam for it does not exist (`apply_gravity` is a scalar on `vel.y`).
- **Three attractors share one summation** — asteroid wells (`T22.11`), the breach vortex
  (`T22.10`) and the black hole (`T22.12`). Whichever lands first writes it; the other two use
  it. Three loops means the float-order fix, the prediction fix and the cutoff each have to be
  right three times.

## Obligations this milestone carries

- **An amendment is owed and is not written.** `docs/13-weather-effects.md`,
  `docs/14-daynight-visibility.md` and `docs/10-map-generation.md` all describe behaviour this
  milestone overrides in one mode. Per `CLAUDE.md` the coordinator writes it as
  `docs/77-amendments-v9.md` **when the work lands**, not now — and no builder edits `docs/`.
- **`REPLAY_VERSION` moves at least once**, and probably more than once: the setting is
  simulation state, the hazard table is hashed, and the movement model changes every tick.
- **Fall damage.** `docs/20-player-movement.md:235` still refuses fall damage outright and the
  override has been outstanding since T20.11. Space makes it worse, not better: there is no
  fall. Whoever writes the amendment should close both at once.

## Checkpoint

Host a match in space and float between asteroids on your thrusters, watching the plume fire
from the opposite side; run your energy down and drift; take a battery pack and watch the
radiation stop eating you; see a solar flare cross the arena and get out of its way; look up
and see the earth, moved since the round began; blow a hole in the rim and get eaten by what
comes through it; claw your way off a level-5 asteroid on the last of your fuel; and watch a
black hole open in the final minute, take a rock with it, and pull the round to a close.
