# 20 — Player movement

Movement lives in `game-core/src/physics/` and `game-core/src/player/`. It is a
pure function of `(state, input, map, dt)` — no I/O, no ambient randomness — which
is what lets the server run it as the authority and the browser run the identical
compiled code as a predictor.

Numbers in `02-constants.md`.

---

## 1. The body

An axis-aligned box, `PLAYER_W` × `PLAYER_H` (16 × 28), positioned by its **centre**.

```rust
pub struct Body {
    pub pos: Vec2,      // centre, world px
    pub vel: Vec2,      // px/s
    pub grounded: bool,
    pub ground_ticks: u32,   // ticks since last grounded, for coyote time
}
```

No rotation. Boxes are chosen over circles because the step-up/slope logic below is
much easier to reason about and to test with a flat bottom edge.

## 2. Collision against the mask

Three primitives, all in `physics/collide.rs`:

```rust
fn solid_at(map: &Map, x: i32, y: i32) -> bool;
fn aabb_overlaps_solid(map: &Map, aabb: Aabb) -> bool;
fn ground_probe(map: &Map, aabb: Aabb, max_depth: i32) -> Option<i32>;  // px to snap down
```

`aabb_overlaps_solid` uses the coarse grid first (`10-map-generation.md` §1.2): walk
the 8×8 cells the box overlaps, skip cells with count 0, return `true` immediately
on any fully-solid cell, and only test bits in partially-filled cells. On typical
terrain this resolves without touching a single bit most of the time.

### Sub-stepping

Movement is never applied in one jump. The desired displacement is split so that
**no step exceeds `MAX_SUBSTEP_PX` (1.0 px)**, capped at `MAX_SUBSTEPS` (64):

```
steps = ceil(|delta| / MAX_SUBSTEP_PX).min(MAX_SUBSTEPS)
for each step: move by delta/steps, resolve collisions
```

This is why tunnelling is impossible regardless of tick rate or speed: a body can
never skip over a 1-pixel wall, because it never moves more than a pixel at a time.
It is also why the tick rate is a tuning decision rather than a correctness one.

### Resolving one sub-step

Axes are resolved separately, X first:

**X axis.** Move the box by `dx`. If it now overlaps solid:
1. Try lifting it by 1..=`STEP_UP` (6) px. If some lift clears the overlap, accept
   the move at that height — the player has walked up a slope or a small ledge.
2. Otherwise, undo the X move and set `vel.x = 0` — it is a wall.

**Y axis.** Move the box by `dy`. If it now overlaps solid:
1. Undo the Y move, set `vel.y = 0`.
2. If the movement was downward, set `grounded = true`.
3. If it was upward, the player hit a ceiling. Nothing more to do.

**Ground snapping.** After both axes, if the player *was* grounded, is not
overlapping anything, and `vel.y >= 0`, probe up to `STEP_DOWN` (8) px below. If
solid is found, snap down and stay grounded. Without this, walking down any slope
turns into a series of tiny falls, which looks and feels broken.

**Slope limit** falls out for free: a slope steeper than `STEP_UP` per pixel of
horizontal travel cannot be climbed, because the lift will not clear the overlap.
At 1-px sub-steps that means anything steeper than about 80° is a wall.

## 3. Walking (A / D)

Grounded, with a direction held:
```
target = dir * WALK_SPEED * speed_multiplier      // see 21-player-stats.md §3
vel.x  = approach(vel.x, target, WALK_ACCEL * dt)
```
Grounded, nothing held:
```
vel.x = approach(vel.x, 0, GROUND_FRICTION * dt)
```
Airborne, direction held:
```
vel.x = approach(vel.x, target, WALK_ACCEL * AIR_ACCEL_FACTOR * dt)
```
Airborne, nothing held: `approach(vel.x, 0, AIR_DRAG * dt)` — a light drag, so you
keep most of your momentum but are not on rails.

`approach(current, target, max_delta)` is a clamped move toward the target; it is
one helper used everywhere and worth its own test.

Gravity every tick when not grounded:
`vel.y = min(vel.y + GRAVITY * gravity_scale * dt, MAX_FALL_SPEED)`.

## 4. Jumping (Space)

The brief's requirements, restated as rules:

- **A standing jump goes straight up.** No direction held at takeoff → only
  `vel.y = -JUMP_VELOCITY`, `vel.x` untouched (and it is ~0 because you are standing).
- **Jumping while moving carries you in that direction.** A direction held at
  takeoff adds `JUMP_H_BOOST` (60) to `vel.x` in that direction, on top of your
  current walking speed.
- **Mid-air direction is changeable.** Air control (§3) is live for the whole
  flight, so holding the opposite key mid-jump genuinely reverses you — it just
  takes a moment, because it accelerates rather than teleports.

Apex height is `JUMP_VELOCITY² / (2 · GRAVITY)` ≈ 66 px ≈ 2.3 player heights.

Two quality-of-life buffers, both standard and both cheap:

- **Coyote time** (`COYOTE_TIME`, 0.10 s): a jump still works for 6 ticks after
  walking off a ledge.
- **Jump buffer** (`JUMP_BUFFER`, 0.12 s): a jump pressed just before landing fires
  on touchdown instead of being swallowed.

## 5. The jetpack (hold Space)

Space is both jump and jetpack, so the disambiguation must be explicit. These
rules are exhaustive:

| Situation | Result |
|---|---|
| Space **pressed** while grounded (or within coyote time) | Jump. Jetpack does not engage yet. |
| Space **still held** `JETPACK_HOLD_DELAY` (0.18 s) after that jump, and fuel ≥ `JETPACK_MIN_FUEL_TO_ENGAGE` | Jetpack engages — a jump flows into flight |
| Space **pressed** while airborne and not in coyote time | Jetpack engages immediately, if fuel allows |
| Space released | Jetpack disengages instantly |
| Fuel hits 0 | Jetpack disengages; cannot re-engage until fuel ≥ `JETPACK_MIN_FUEL_TO_ENGAGE` (0.3) |

The 0.18 s delay is what stops a normal jump from becoming an accidental hop into
flight while still letting a deliberate hold flow smoothly into it.

### While thrusting

- Gravity is scaled by `JETPACK_GRAVITY_SCALE` (0.35) — you still fall without input.
- `W` applies `JETPACK_THRUST_UP` (2200) upward. This is the main lift.
- `A` / `D` apply `JETPACK_THRUST_SIDE` (1100) laterally.
- `S` applies `JETPACK_THRUST_DOWN` (900) downward, for fast descents.
- Speed is clamped to `JETPACK_MAX_SPEED` (260) in each axis.

So full WASD directional flight, exactly as the brief asks. Holding Space with no
WASD gives a slow controlled hover-descent, which is the useful default.

### Fuel

```
thrusting:  fuel -= JETPACK_DRAIN * dt              // 1.0/s  → 5.0 s of flight
idle:       after JETPACK_REFILL_DELAY (0.5 s),
            fuel += JETPACK_REFILL * dt             // 0.5/s  → 2 s per 1 s used
```
`fuel` is clamped to `[0, JETPACK_MAX_FUEL]`. A full 5-second burn therefore takes
10 seconds to recover, matching the brief. Refill runs whether or not you are on
the ground — there is no landing requirement.

## 6. Movement states

```
        ┌──────────┐  no ground   ┌──────────┐
        │ Grounded │─────────────▶│ Airborne │
        └──────────┘              └──────────┘
             ▲  │ jump                 │  ▲
             │  └─────────────────────▶│  │ space released
      landed │                         ▼  │ or fuel empty
             │                    ┌──────────┐
             └────────────────────│ Jetpack  │
                     landed       └──────────┘
```

The state is derived each tick, not stored as a mutable mode — `grounded` plus
`jetpack_active` fully determine it, which removes a whole class of stuck-state
bugs.

## 7. Input

```rust
pub struct Input {
    pub seq: u32,
    pub left: bool, pub right: bool, pub up: bool, pub down: bool,
    pub jump: bool,          // space, held state (not edge)
    pub fire: bool,          // LMB
    pub aim: u16,            // quantised angle, see 22-aiming-crosshair.md
}
```

Held state, not edges. Edges (`jump_pressed`) are derived by comparing against the
previous tick's input, inside `game-core`. This makes the wire format stateless and
makes a dropped packet harmless — the next one re-establishes the truth.

The whole thing packs into 3 bytes plus the sequence number.

`apply_input(&mut PlayerState, &Input, &prev: Input, &Map, dt)` is the single entry
point. The server calls it from the tick loop; the client calls it for prediction.
Same function, same binary logic.

## 8. Testing

All headless, against small hand-built masks (a flat floor, a 6-px step, a 20-px
wall, a 45° ramp, a 1-px spike):

- Standing on flat ground: position is stable for 600 ticks, `grounded` stays true,
  the body neither sinks nor jitters.
- Walking into a 6-px step climbs it; walking into a 7-px step does not.
- Walking into a 20-px wall stops the body and zeroes `vel.x`.
- Walking down a 30° slope keeps `grounded == true` for the whole descent — no
  airborne frames.
- Jump apex is within 2 px of `JUMP_VELOCITY² / (2·GRAVITY)`.
- A standing jump ends within 2 px of where it started, horizontally.
- A running jump travels further than a standing jump.
- Holding the opposite direction mid-air reverses horizontal velocity within
  `WALK_SPEED / (WALK_ACCEL · AIR_ACCEL_FACTOR)` seconds.
- Coyote time: a jump 5 ticks after leaving a ledge works; 12 ticks after does not.
- Jetpack: 5.0 s of held thrust drains fuel to exactly 0; 10.0 s idle refills to
  exactly 5.0; refill does not begin during the first 0.5 s.
- Jetpack does not engage from a grounded press until 0.18 s have passed.
- **No tunnelling**: a body moving at 10× `MAX_FALL_SPEED` at a 1-px-thick wall is
  stopped by it. Run this for every axis and both directions.
- `apply_input` is pure: the same inputs from the same state produce byte-identical
  results, 1000 times.

## 9. Future work

- Rope/grapple, which needs a constraint solver — a real addition, not a tweak.
- Crouching (a shorter AABB), for squeezing into tunnels.
- Wall sliding and wall jumps.
- Knockback interacting with the jetpack (currently knockback just adds velocity).
- Fall damage — deliberately absent in v1 so the jetpack stays forgiving.
