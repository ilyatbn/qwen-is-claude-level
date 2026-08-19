# 14 — Day/night cycle and visibility

A full day passes every two minutes, so a four-minute round contains two nights.
Night is not cosmetic: without a flashlight you can see roughly a third as far,
which turns the map from an arena into a place you have to feel your way around.

Cycle state is server-authoritative. Rendering is client-side.

---

## 1. The cycle

```
  0s        60s              120s       180s             240s
  |──── day ───|──── night ────|──── day ───|──── night ────|
       ^dawn        ^dusk           ^dawn        ^dusk
   8s transitions inside each phase boundary
```

`DAY_DURATION` and `NIGHT_DURATION` are both 60 s; `CYCLE_TRANSITION` (8 s) is the
ramp, split evenly across the boundary (4 s before, 4 s after).

```rust
pub struct CycleState { pub phase: Phase, pub darkness: f32 }  // darkness 0.0 ..= NIGHT_DARKNESS
```

`darkness` is a single scalar, computed from round time with a smoothstep across
each transition. The server sends it in the snapshot header (one byte, quantised);
the client also computes it locally from round time and uses the server value only
to correct drift. It never needs to be interpolated specially — it changes slowly.

A round always starts in **day**, so the first 60 seconds are a fair fight and
players have time to find a flashlight before the first night.

## 2. What night actually changes

| | Day | Night |
|---|---|---|
| FoV radius | `FOV_DAY` (640) | `FOV_NIGHT` (220) |
| Screen darkness | 0.0 | `NIGHT_DARKNESS` (0.82) |
| Terrain visible outside FoV | yes, fully lit | no, only the silhouette against the sky |
| Other players visible | anywhere on screen | only inside your FoV or lit by something |

Explosions, lava, burning ground and meteors emit light, so combat gives away
position at night. That is intentional: shooting in the dark tells everyone where
you are.

## 3. Field of view

One formula, used by both the client (to render) and the server (later, for
visibility culling):

```
fov = lerp(FOV_DAY, FOV_NIGHT, darkness / NIGHT_DARKNESS)
    * (fog_active ? FOV_FOG_MULT : 1.0)
    * lerp(FOV_HEALTH_MIN_MULT, 1.0, clamp(health / BASE_HEALTH, 0, 1))
    * (flashlight_on ? FLASHLIGHT_AMBIENT_MULT : 1.0)
```

So the three modifiers the brief asked for — night, fog, health — are all
multiplicative on a single radius:

- **Night** interpolates the base radius from 640 down to 220.
- **Fog** multiplies by 0.45, and stacks with night. A foggy night is ~99 px of
  visibility, which is about three player-heights. This is the scariest the game
  gets, and it lasts 15 seconds.
- **Health** multiplies by 0.80 → 1.0. A nearly-dead player literally cannot see
  as well, which compounds the disadvantage and encourages disengaging.
- **Flashlight** *reduces* your ambient radius to 0.65 while giving you a long
  cone. It is a trade, not a pure upgrade.

The FoV edge is not a hard circle. The outer `FOV_EDGE_SOFTNESS` (35 %) of the
radius is a gradient, so vision fades out instead of ending at a line.

## 4. The flashlight

An inventory item (`30-items-inventory.md`), not a default ability — the brief is
explicit that it must be found.

- Toggled with `F`, or by selecting it in the inventory. Toggling sends
  `toggle_flashlight` to the server, which mirrors the state to everyone.
- Emits a cone of `FLASHLIGHT_CONE_DEG` (55°) and `FLASHLIGHT_RANGE` (520) along
  the player's **aim** direction — so aiming and looking are the same act.
- Costs no fuel and never runs out in v1.
- **Visible to other players.** Your cone is drawn in everyone's lightmap, so a
  flashlight at night is a beacon. Long sightlines at the cost of being seen first.

## 5. Rendering: the lightmap

One full-screen `RenderTexture` at depth 50, redrawn every frame:

1. `fill(#000818, darkness)` — the night colour from `theme.json`, at the current
   darkness. At `darkness == 0` the whole step is skipped and the layer is hidden.
2. **Erase** light sources into it, using a radial-gradient sprite drawn with
   `BlendModes.ERASE`:
   - the local player's FoV circle at the computed radius;
   - the local player's flashlight cone, if on (a pre-rendered cone texture,
     rotated to the aim angle);
   - every other visible player's flashlight cone;
   - every dynamic light: explosions (bright, ~0.2 s decay), lava jets and burning
     ground, meteors in flight, item glints.
3. Draw the result over the scene with `BlendModes.MULTIPLY`.

Keep one reusable radial-gradient texture and one cone texture, generated once at
boot; do not build gradients per frame.

**Culling other players.** A remote player whose position is outside your FoV and
not inside any light is simply not rendered. This is a *client-side* decision in
v1 — the server still sends everyone's position, so a modified client could see
through the dark. Accepted for v1 and noted in §8.

## 6. Server responsibilities

The server owns the clock, nothing more, in v1:

- computes `darkness` from round time and includes it in each snapshot header;
- broadcasts `phase_change { phase, at_tick }` on each day↔night flip so clients can
  fire audio and UI cues without polling;
- tracks each player's `flashlight_on` flag and mirrors it in the snapshot flags
  byte;
- applies the FoV formula only where it affects gameplay, which in v1 is nowhere —
  FoV does not change hit registration or damage. It is purely perceptual.

## 7. Testing

- `darkness` at t=0 is 0.0; at t=60+4 it is `NIGHT_DARKNESS`; the transition is
  monotonic and continuous across each boundary (no jump larger than one tick's
  worth of change).
- A 240 s round contains exactly two day phases and two night phases.
- The FoV formula: day/full health/no fog → `FOV_DAY`; full night → `FOV_NIGHT`;
  full night + fog → `FOV_NIGHT * 0.45`; 1 health → an extra `FOV_HEALTH_MIN_MULT`.
- Toggling the flashlight shrinks ambient FoV by exactly `FLASHLIGHT_AMBIENT_MULT`.
- Flashlight state survives death and respawn (the item is kept), but the light is
  forced off while dead.
- Client-side: the lightmap is skipped entirely when `darkness == 0` and no fog is
  active — verify the render call count is zero in daylight.

## 8. Future work

- **Server-side visibility culling**: filter each recipient's snapshot with this
  same FoV formula. Closes the see-in-the-dark cheat and cuts bandwidth. The
  formula is already shared code, so this is mostly plumbing.
- Line-of-sight occlusion by terrain (raycast the mask so you cannot see through a
  wall). Deliberately excluded from v1 — it is a large per-frame cost and the FoV
  circle already does most of the work.
- Moon phases varying `NIGHT_DARKNESS` per round, seeded.
- Flares as a throwable that lights an area for everyone.
