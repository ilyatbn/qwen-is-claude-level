# 13 — Weather and map effects

Every 30–45 seconds the map turns on the players. Effects are server-authoritative,
seeded, telegraphed, and short. They exist to break stalemates and to make cover
temporary.

Numbers in `02-constants.md`. Runs inside `game-core`, driven by `World::step`.

---

## 1. The scheduler

```rust
pub struct EffectScheduler {
    rng: ChaCha8Rng,              // substream(seed, "weather")
    next_at: f32,                 // round time of the next roll
    active: Vec<ActiveEffect>,    // usually 0 or 1, but overlap is allowed
}
```

At round start, `next_at = rand(EFFECT_INTERVAL_MIN, EFFECT_INTERVAL_MAX)`. When
round time passes `next_at`, pick an effect by weight, start it in the
**telegraph** phase, and schedule the next roll.

| Effect | Weight | Why |
|---|---|---|
| `ToxicRain` | 3 | area denial, mild |
| `MeteorShower` | 3 | the big terrain-changer |
| `LavaBurst` | 2 | punishes camping in holes |
| `HeavyFog` | 2 | pure visibility, no damage |

Never repeat the same effect twice in a row — re-roll once if it comes up again.

Effects do not fire during `Warmup` or after `ROUND_SECONDS`. The last effect is
suppressed if it would still be running at round end.

## 2. Effect lifecycle

Every effect is the same three-phase state machine:

```
  Telegraph (EFFECT_TELEGRAPH = 3 s)  ──▶  Active (per-effect)  ──▶  Cleanup
       │                                        │
   warning banner,                       spawns hazards,
   sky tint shift,                       hazards damage players
   audio cue                             and/or carve terrain
```

Telegraph is not decoration — three seconds is exactly enough to get out of the
open, so being caught is a decision, not bad luck.

Events on the wire (`40-net-protocol.md`):

- `effect_start { id, kind, phase: "telegraph", seed, duration }`
- `effect_phase { id, phase: "active" }`
- `effect_end   { id }`

Individual hazards spawned during the active phase are broadcast as they occur —
the client does not simulate them independently, because they carve terrain and
must match exactly.

## 3. Toxic rain

Radioactive puddles land at random points and linger.

- Duration `TOXIC_DURATION` (8 s).
- Every `TOXIC_PUDDLE_EVERY` (0.4 s), pick a random *surface point* from
  `MapMeta.surface_points` (weighted toward the currently occupied half of the map,
  so it is not wasted on empty terrain) and spawn a puddle there.
- A puddle is a circle of radius `TOXIC_PUDDLE_RADIUS` (40) living
  `TOXIC_PUDDLE_LIFE` (3 s), dealing `TOXIC_DPS` (6) per second to any player whose
  AABB overlaps it.
- **No terrain damage.** Toxic rain is about denying space, not reshaping the map.

Client: green droplet particles falling from the sky over the whole map during the
active phase, a sickly green vignette, and a bubbling puddle sprite with a soft
glow at each spawn point.

## 4. Meteor shower

The heavy one. Reshapes the map more than any weapon.

- Duration `METEOR_DURATION` (10 s).
- Every `METEOR_EVERY` (0.5 s), spawn a meteor at a random x, y = `-32`, with
  downward speed `METEOR_SPEED` (700) and a small random lateral velocity.
- Meteors are ordinary projectiles (`31-weapons-combat.md`) — they fall under
  gravity and step against the mask.
- On impact:
  - `carve_circle(r = METEOR_CARVE_R (50))`;
  - `METEOR_DAMAGE` (55) with linear falloff over that radius;
  - spawn `METEOR_FRAGMENTS` (6) fragment projectiles with speeds in
    `METEOR_FRAG_SPEED` (320–520) at angles spread across the upward hemisphere.
- A fragment on impact carves `METEOR_FRAG_CARVE_R` (14) and deals
  `METEOR_FRAG_DAMAGE` (18) with falloff. Fragments do not spawn more fragments.

The telegraph shows shadows tracking across the ground where the first meteors will
land, so the warning is spatial rather than just a banner.

Client: fireball sprites with trails, impact flash, screen shake scaled by
distance, dust plumes, glowing ember fragments.

## 5. Lava burst

Punishes players who have dug themselves a hole.

- Pick `LAVA_VENTS_MIN..=LAVA_VENTS_MAX` (3–6) surface points, spread out.
- Telegraph: the ground at each vent glows and cracks.
- On activation, each vent:
  - carves a channel downward — `carve_capsule` from the vent point to 3 ×
    `LAVA_CHANNEL_R` below it, radius `LAVA_CHANNEL_R` (24);
  - emits a jet for `LAVA_JET_DURATION` (3 s). The jet is a cone from the vent,
    aimed upward with a random lean of up to 30°, height ~180 px. Any player inside
    takes `LAVA_JET_DPS` (10) per second.
- When the jet stops, it leaves burning ground: a circle of radius
  `LAVA_BURN_RADIUS` (28) at the vent dealing `LAVA_BURN_DPS` (8) per second for
  `LAVA_BURN_DURATION` (3 s), then it goes out.

Total lifetime per vent: 3 s telegraph + 3 s jet + 3 s burn.

Client: orange crack decals during telegraph, a particle jet with additive
blending, embers, heat-haze, and a fading scorch decal afterwards.

## 6. Heavy fog

No damage. Pure visibility pressure, and the only effect that changes daytime
combat.

- Duration `FOG_DURATION` (15 s), with `FOG_RAMP` (2 s) fade in and out.
- While active, every player's FoV radius is multiplied by `FOV_FOG_MULT` (0.45).
  See `14-daynight-visibility.md` §3.
- Stacks multiplicatively with night, which makes a foggy night genuinely blind and
  makes the flashlight briefly the most valuable item on the map.

Client: a scrolling fog sprite layer at low alpha above the terrain, plus the FoV
change in the lightmap. The fog layer scrolls slowly and independently of the
camera so it feels like weather rather than a filter.

## 7. Authority and replication

Effects are simulated **only** on the server. Hazard spawns are broadcast as
events with explicit positions. Clients do not roll their own hazard positions —
if they did, a divergence would mean one player standing in lava they cannot see.

The `seed` in `effect_start` exists purely so clients can randomise *cosmetic*
details (particle jitter, sprite variants) consistently across all viewers.

## 8. Testing

Headless, deterministic, no rendering:

- The scheduler produces the same sequence of `(time, kind)` pairs for a given seed.
- No effect is scheduled during warmup or in the last `duration` seconds of a round.
- The same effect never fires twice consecutively.
- Toxic rain spawns exactly `TOXIC_DURATION / TOXIC_PUDDLE_EVERY` puddles.
- A player standing in a puddle for its full life loses
  `TOXIC_DPS * TOXIC_PUDDLE_LIFE` health, within a tick's tolerance.
- A meteor impact carves 50 px and spawns exactly 6 fragments.
- Fragments do not recurse.
- A lava vent's total damage window is 6 s (jet + burn).
- Fog changes FoV by exactly `FOV_FOG_MULT` at full strength and returns it to
  baseline after `FOG_DURATION`.
- No effect can damage a player during `SPAWN_IFRAMES`.

## 9. Future work

- Wind gusts that change `MapMeta.wind` mid-round and visibly bend projectiles.
- Earthquakes that carve horizontal fissures.
- Acid rain that *does* damage terrain slowly, dissolving the map from above.
- Effect intensity scaling with remaining round time, so the last minute is chaos.
