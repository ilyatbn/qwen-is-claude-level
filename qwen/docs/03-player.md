# 03 — Player (movement, jetpack, aim, stats)

All player logic in `game-core/src/player.rs` (+ physics integration in
`physics.rs`). Server-authoritative: the server simulates every player from
input frames.

## 1. Player state

```rust
pub struct Player {
    pub id: u8,                 // 0..=5
    pub name: String,
    pub skin: u8,               // index into skin list (docs/07)
    pub pos: Vec2,              // px, center of body
    pub vel: Vec2,              // px/s (rapier body velocity)
    pub facing: f32,            // aim angle, radians
    pub health: f32,            // 0..=150 (overcharge can exceed 100)
    pub max_health: f32,        // base 100
    pub shield: ShieldState,
    pub jetpack: JetpackState,
    pub inventory: Inventory,   // docs/04 §5
    pub alive: bool,
    pub respawn_at_tick: Option<u64>,
    pub score: i32,
    pub kills: u32,
    pub deaths: u32,
}
pub struct ShieldState { pub active: bool, pub remaining_s: f32 }
pub struct JetpackState { pub fuel: f32 }   // 0..=5.0 seconds
```

## 2. Spawn

- Round start: each player placed at one of `map.spawns` (docs/01 §3.5),
  assigned by player id order (player 0 → spawn[0], ...). Spawns are
  shuffled per round with the round RNG before assignment.
- Always on ground (spawn tiles are surface tiles by construction).
- Respawn (after death): 3 s delay, then placed at the spawn farthest
  (Chebyshev, tile distance) from all living players. Inventory is KEPT.
  Health resets to 100, shield cleared, jetpack fuel full.

## 3. Input frame (sent by client at 20 Hz)

```rust
pub struct InputFrame {
    pub tick: u64,
    pub left: bool,      // A
    pub right: bool,     // D
    pub up: bool,        // W
    pub down: bool,      // S
    pub jump: bool,      // space (edge-triggered by server: rising edge)
    pub aim: f32,        // radians, from client mouse
    pub fire: bool,      // left mouse held
    pub use_slot: Option<u8>,  // inventory slot to use (edge)
}
```

Server applies the latest input frame per tick (missing frames → repeat
last). `jump` and `use_slot` are edge-triggered server-side.

## 4. Movement (ground)

Constants (all in `player_config`):
- `MOVE_SPEED = 140 px/s` (horizontal, ground)
- `AIR_ACCEL = 600 px/s²`, `AIR_MAX = 140 px/s` (air control)
- `GRAVITY = 900 px/s²` (rapier world gravity)
- `JUMP_VY = -330 px/s` (impulse at jump)
- `JUMP_DIR_BIAS = 0.5` (horizontal velocity factor added at jump if A/D held)

Rules:
- On ground (raycast 2 px below feet hits solid): A/D set horizontal
  velocity to ±MOVE_SPEED directly (snappy Worms feel, no accel on ground).
- Jump (rising edge of space, on ground): apply JUMP_VY impulse; if A or D
  held, also set horizontal vel to ±(MOVE_SPEED * JUMP_DIR_BIAS).
- In air: A/D accelerate horizontal vel toward ±AIR_MAX at AIR_ACCEL
  (mid-air direction changes work).
- Ground detection: 2 px downward probe from feet, tile-based (check the
  tile under the feet point is solid) — cheaper than a rapier raycast,
  deterministic.

## 5. Jetpack

- Holding space **while in the air** (jump already consumed) = jetpack:
  - `JETPACK_THRUST = 1100 px/s²` upward while fuel > 0.
  - WASD all work in flight: W adds +300 px/s² up, S +300 down (net down
    can exceed gravity), A/D as air control.
  - Fuel: starts 5.0 s. Burns 1.0 s fuel per second of thrust.
  - Recharge: while NOT thrusting, fuel refills at `0.5 s fuel per second`
    (i.e. 1 s of use costs 2 s of recharge). Capped at 5.0.
- Jetpack cannot start on the ground (space on ground = jump only).
- Snapshot carries `jetpack_fuel: f32` per player.

## 6. Health & shield

- Base health 100. Damage pipeline (single function `apply_damage`):
  1. if shield active: `dmg *= 0.5` (shield reduces damage by 50%).
  2. `health -= dmg`. If health < 0 → death (health shown as 0).
- **Overcharge** (item, docs/04): sets `max_health = 150` for 10 s and
  heals to 150. After expiry, max_health back to 100 (health clamps to 100
  on expiry, no damage).
- **Heal item**: +50 hp, clamped to current max_health.
- **Shield Generator** (item): shield active for 20 s, 50% damage
  reduction. Re-picking while active refreshes to 20 s.
- Death: `alive=false`, score −1, killer +1 (if killer is a player;
  weather kills give no score to anyone), `respawn_at_tick = now + 3 s`.
  Kill event emitted with (victim_id, killer_id or "weather", weapon).

## 7. Field of view (FOV) — dynamic visibility

FOV radius (px) per player, computed per snapshot:

```
base = 420
night_factor:  1.0 (full day) → 0.45 (full night), lerp by day_phase
fog_factor:    1.0, or 0.45 while heavy fog active
health_factor: 1.0 if health >= 50, else 0.7 (low-health vision blur)
fov = base * night_factor * fog_factor * health_factor
if flashlight active: night_factor = 1.0 for this player
```

- Snapshot carries `fov: f32` per player (server computes; client renders
  a darkness mask with a circular hole of this radius around the player).
- FOV is per-player and asymmetric (your fog/night/health affects YOUR view).

## 8. Aim & crosshair

- `aim` is a free angle from the client mouse (server stores it, no
  validation needed for v1).
- Crosshair: client draws a circle of radius 60 px around the player; the
  crosshair sits on that circle at the aim angle (Worms-style). The circle
  is a visual aid only; weapons fire from the player center along `aim`.
- Firing: `fire` held + equipped weapon with ammo → fire on the weapon's
  cooldown (docs/04 §4). Server validates ammo and cooldown.

## 9. Snapshot fields per player

`{ id, name, skin, x, y, facing, health, max_health, shield_remaining,
jetpack_fuel, fov, alive, respawn_in_s, score, weapon: Option<WeaponId>,
ammo: u8 }`
