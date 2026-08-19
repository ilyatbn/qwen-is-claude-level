# 02 — Map effects (weather, day/night)

All effect logic lives in `game-core/src/effects.rs`. Scheduling is seeded
(§6) so a given seed replays the same effect timeline. Effects are server-
driven; clients only render what snapshots/events tell them.

## 1. Day/night cycle

- Cycle: **60 s day + 60 s night**, with 5 s linear transitions at each
  change. Round starts at day, t=0.
- Phase from round time `t` (seconds): `c = t mod 120`.
  - day: `c < 55` (full) / transition to night `55..60`
  - night: `60 <= c < 115` / transition to day `115..120`
- Night effect: player FOV shrinks (see docs/03 §7). A **flashlight** item
  (docs/04) restores normal FOV for its holder while active.
- Snapshot carries `day_phase: f32` in [0,1] (0 = full day, 1 = full night)
  so clients can lerp the darkness overlay.

## 2. Effect catalog

| Effect | Duration | Damage | Notes |
|---|---|---|---|
| Toxic rain | 8 s | 10 hp/s inside a spot | §3 |
| Meteor shower | 4 s | 60 max blast | §4 |
| Lava burst | 5 s spew + 3 s ground fire | 15 hp/s in fire | §5 |
| Heavy fog | 15 s | none | §6 |

All damage is unshielded base; shields (docs/03 §6) reduce it like any
other damage source.

## 3. Toxic rain

- Trigger: scheduled (weight in §6). On start: pick **5 random spots**
  (RNG) on solid ground (tile center of a random solid tile, not AIR).
- Each spot: radius **40 px**, lasts **4 s** (spots stagger: spot i starts
  at `i*1.2 s` after effect start, so the 8 s window covers all).
- Players whose center is within a spot radius take 10 hp/s (applied per
  tick: `10 * dt`).
- Snapshot carries active spots: `[(x, y, remaining_s)]`.
- Visual: green tinted circle + rain streaks (client).

## 4. Meteor shower

- Trigger: scheduled. On start: pick **3 meteor targets** (RNG) — random
  ground surface points (tile center of a random GRASS/DIRT tile).
- Each meteor: `i*0.8 s` after start, falls from top of screen to target in
  0.6 s (straight line, client animation), then:
  - `apply_blast(cx, cy, radius=48 px, max_damage=60)` (destroys tiles!)
  - emits `meteor_impact` event with (x, y) for client explosion VFX.
- Players within 48 px of impact at impact tick take falloff damage
  (same formula as tile blast, §5 of docs/01), max 60.
- Meteors are NOT projectiles players can shoot; they are weather.

## 5. Lava burst

- Trigger: scheduled. On start: pick **1 burst site** (RNG) on solid ground.
- Phase 1 (0–5 s): the ground "opens": a 3×3 tile area around the site
  becomes AIR (emits tile_destroyed events, no hidden-item spawn for these —
  weather destruction skips item uncovery). Fire spews: per tick, 2 fire
  particles fly from the site in random directions (RNG, 30° spread upward
  ± 120°), speed 150 px/s, live 1 s.
- Fire particle hitting a player: 15 hp/s while overlapping (per tick
  `15 * dt`, min 1 overlap tick = 0.75 hp).
- Phase 2 (5–8 s): ground fire: the 3×3 area (and any tile the fire
  particles touched) burns: players standing on/inside burning tiles take
  15 hp/s. Burning tiles are marked (not destroyed) and visually orange.
- After 8 s: fire gone, area stays dug (holes remain).
- Snapshot carries: `lava_sites: [(x, y, phase, remaining_s)]`.

## 6. Heavy fog

- Trigger: scheduled. Duration **15 s**.
- Effect: player FOV multiplier drops to **0.45** (stacks multiplicatively
  with night per docs/03 §7).
- Snapshot carries `fog_active: bool` + remaining time.
- Visual: client draws a translucent fog layer + shrunk visibility mask.

## 7. Effect state (game-core)

```rust
pub struct EffectState {
    pub active: Vec<ActiveEffect>,   // max 1 concurrent in v1
    pub day_phase: f32,              // 0..1
}
pub struct ActiveEffect {
    pub kind: EffectKind,            // ToxicRain | MeteorShower | LavaBurst | HeavyFog
    pub started_tick: u64,
    pub duration_s: f32,
    pub data: EffectData,            // per-kind payload (spots, targets, sites)
}
```

Rules:
- Only **one** effect active at a time. A new effect cannot start while
  one is active.
- Effects never start in the first 10 s of a round (grace period).
- Damage from effects uses the same damage pipeline as weapons
  (shield reduction applies, can kill, credits "weather" as killer for
  the kill feed).

## 8. Scheduling (seeded)

- At round start, precompute the schedule: a `Vec<(start_tick, EffectKind)>`
  using the round RNG:
  - first effect at `t in [10, 20] s` (RNG).
  - subsequent gaps: `t in [18, 32] s` (RNG).
  - kind: weighted pick — toxic rain 30%, meteor 25%, lava 25%, fog 20%.
  - stop scheduling when `t > round_duration - 15 s` (no effect in the
    last 15 s).
- The schedule is deterministic from the seed → tests can assert the exact
  effect list for a given seed.
