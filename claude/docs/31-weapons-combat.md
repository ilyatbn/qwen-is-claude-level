# 31 — Weapons and combat

Weapons are the main way to hurt players and the main way to reshape the map. Both
matter equally — digging a hole under someone is as valid as hitting them.

Numbers in `02-constants.md`. Terrain edits go through `11-map-destruction.md`.

---

## 1. Weapon definitions

```rust
pub struct WeaponDef {
    pub id: WeaponId,
    pub key: &'static str,
    pub delivery: Delivery,
    pub damage: f32,
    pub blast_radius: f32,     // also the carve radius
    pub range: f32,            // hitscan only; projectiles use PROJECTILE_MAX_LIFETIME
    pub cooldown: f32,
    pub muzzle_speed: f32,     // projectiles only
    pub gravity_scale: f32,
    pub wind_scale: f32,
}

pub enum Delivery {
    Projectile { fuse: Option<f32>, restitution: f32, friction: f32, explode_on_contact: bool },
    Hitscan { shots: u8, spread: f32 },
}
```

### v1 arsenal

| | `bazooka` | `grenade` | `smg` |
|---|---|---|---|
| Delivery | projectile, explodes on contact | projectile, 3.0 s fuse, bounces | hitscan |
| Damage | 45 | 40 | 8 per shot |
| Blast / carve radius | 42 | 36 | 3 |
| Muzzle speed | 620 | 480 | — |
| Range | — | — | 700 |
| Cooldown | 0.9 s | 0.9 s | 0.10 s (10/s) |
| Gravity scale | 1.0 | 1.0 | 0 |
| Wind scale | 1.0 | 0.5 | 0 |
| Restitution / friction | — | 0.45 / 0.75 | — |
| Spread | 0 | 0 | 0.03 rad |
| Ammo per pickup | 4 | 3 | 60 |

Three weapons cover three distinct roles: a direct arcing hit, an indirect
area-denial throw, and sustained chip damage that also tunnels through thin walls.
Everything else is future work.

## 2. Firing

Left mouse button, on the selected slot. The server validates
(`30-items-inventory.md` §4), then:

```
origin = player_center + dir(aim) * MUZZLE_OFFSET   // 18 px, so you don't shoot yourself
```

The muzzle offset matters: without it, a bazooka fired into the ground at your feet
spawns inside your own hitbox and explodes immediately. If the offset point is
already inside solid terrain, the projectile spawns at the player centre and
explodes on its first step, which is the correct punishment for firing into a wall.

The firing player is **not** immune to their own explosion (`SELF_DAMAGE_MULT` =
1.0). Rocket-jumping works, and it costs health.

## 3. Projectiles

```rust
pub struct Projectile {
    pub id: ProjectileId,
    pub weapon: WeaponId,
    pub owner: PlayerId,
    pub pos: Vec2,
    pub vel: Vec2,
    pub spawned_at: f32,
    pub fuse_at: Option<f32>,
}
```

Each tick:

1. `vel.y += GRAVITY * gravity_scale * dt`
2. `vel.x += wind * wind_scale * dt` — `wind` is `MapMeta.wind`, rolled per round,
   `|wind| <= WIND_MAX` (90). It is shown on the HUD as an arrow, because a wind
   you cannot see is just noise.
3. Sub-step the movement at `MAX_SUBSTEP_PX`, exactly as players do. At each
   sub-step, test in this order:
   - **solid terrain** at the new point;
   - **player AABB** overlap, excluding the owner during the first 3 ticks (so the
     muzzle offset is not needed twice).
4. On contact:
   - `explode_on_contact` → explode here;
   - otherwise (grenade) → bounce.
5. If `fuse_at` has passed, explode wherever it is — including in mid-air.
6. After `PROJECTILE_MAX_LIFETIME` (8 s) it explodes, so nothing leaks.

### Bouncing

On contact, estimate the surface normal from the mask by sampling the 8 neighbours
in a small radius and taking the negated gradient of solid density. Then:

```
vn      = dot(vel, n)
vel     = vel - n * (1 + restitution) * vn      // reflect and damp
vel    *= friction                              // tangential loss
```

If the resulting speed is below ~30 px/s and the grenade is resting on ground, stop
it and let it sit until the fuse expires. A grenade that jitters forever on a slope
is the classic bug here — the speed threshold is what prevents it.

## 4. Hitscan

For each of `shots`:
1. Jitter the aim angle by `±spread`.
2. March the ray in 1-px steps out to `range` (700).
3. The first solid pixel or player AABB hit ends the ray.
4. On a player: `damage`, no knockback (the SMG is chip damage, not displacement).
5. On terrain: `carve_circle(hit, blast_radius = 3)`.

A 3-px carve per bullet means sustained SMG fire genuinely tunnels through a thin
wall — slowly, and loudly. That is a feature.

Hitscan is resolved on the tick the input arrives, against the **server's** current
world state. There is no lag compensation in v1 (see §8).

## 5. Explosions

One function, used by weapons, meteors and anything else that goes bang:

```rust
pub fn explode(world: &mut World, at: Vec2, radius: f32, damage: f32,
               owner: Option<PlayerId>, now: f32) -> ExplosionResult
```

1. `map.carve_circle(at.x, at.y, radius)` — terrain first, so revealed buried items
   are part of the same event.
2. For every living player whose AABB centre is within `radius`:
   ```
   t   = 1 - dist / radius              // linear falloff, clamped to [0,1]
   dmg = damage * t
   imp = KNOCKBACK_MAX * t
   ```
   Apply damage via `PlayerState::apply_damage` (shield and i-frames handled there),
   and add the impulse to velocity (always applied, even through i-frames —
   `21-player-stats.md` §5).
3. Emit an `explosion` event with position, radius and a cosmetic kind, plus any
   `item_spawn` events for buried slots the carve revealed.

Explosions do not chain. A grenade caught in another explosion is destroyed
silently rather than detonating — chain reactions are fun but make the tick
non-terminating in the worst case.

Damage uses distance to the player **centre**, not the nearest AABB point. It is
simpler, symmetric, and the difference is at most 8 px.

## 6. Kill attribution

Every damage carries a `DamageSource`:

```rust
pub enum DamageSource {
    Player { id: PlayerId, weapon: WeaponId },
    SelfInflicted { weapon: WeaponId },
    Weather(EffectKind),
}
```

`SelfInflicted` is produced when `owner == victim`, and is what makes a rocket-jump
death cost you a point without giving anyone else one (`21-player-stats.md` §6).

## 7. Testing

- A bazooka fired at a wall 100 px away explodes within one tick of the expected
  flight time.
- An explosion at the exact centre of a player deals full `damage`; at the radius
  edge it deals ~0; beyond it, nothing.
- Knockback direction points away from the epicentre; a player directly above takes
  a purely upward impulse.
- A player standing on their own grenade takes full self damage and is credited
  −1 with no kill awarded to anyone.
- A grenade dropped on flat ground comes to rest within 2 s and does not jitter.
- A grenade fired into a corner bounces out rather than sticking or tunnelling.
- A grenade's fuse fires in mid-air if it never touches anything.
- SMG: 60 rounds at 10/s empties the stack in 6 s; each round carves 3 px; a 10-px
  wall is breached after a predictable number of hits.
- A projectile never passes through a 1-px wall at any speed (the sub-step
  guarantee, re-tested at the projectile layer).
- Projectiles despawn at `PROJECTILE_MAX_LIFETIME` even with gravity 0.
- An explosion overlapping a buried slot emits both `explosion` and `item_spawn`.
- Firing does not damage the owner during the first 3 ticks of flight.

## 8. Future work

- **Lag compensation** — rewinding player positions by the shooter's RTT for
  hitscan. Not in v1: at 8 damage a shot, a missed SMG bullet is cheap, and rewind
  needs a position history ring buffer plus careful interaction with destructible
  terrain (the wall you were behind may no longer exist in the rewound state).
- Charge-up power for arcing weapons.
- Clustering, homing, airstrikes, drills, mines — the registry and `Delivery` enum
  are shaped to absorb them.
- Per-weapon carve shapes (`carve_capsule` for a drill, a cone for a shotgun).
- Chain reactions, with an explicit depth limit.
