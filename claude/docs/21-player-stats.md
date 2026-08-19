# 21 — Player stats, damage, death and scoring

Numbers in `02-constants.md`. All of this is server-authoritative; the client
displays it and predicts nothing about it.

---

## 0. The player record

```rust
pub struct PlayerState {
    pub id: PlayerId,
    pub body: Body,                 // 20-player-movement.md
    pub aim: u16,
    pub health: f32,                // 0 ..= HEALTH_CAP
    pub shield_until: Option<f32>,  // round time the shield expires
    pub jetpack_fuel: f32,
    pub inventory: Inventory,       // 30-items-inventory.md
    pub selected_slot: u8,
    pub flashlight_on: bool,
    pub alive: bool,
    pub respawn_at: f32,
    pub iframes_until: f32,
    pub score: i16,                 // signed — it can go negative
    pub last_damaged_by: Option<(PlayerId, f32)>,   // attacker, round time
    pub skin_id: u16,               // 50-sprites-skins.md
}
```

## 1. Health

Base and maximum-by-default is `BASE_HEALTH` (100). Healing can push past it, up to
`HEALTH_CAP` (150) — this is the "boost it temporarily past 100%" from the brief.

- A medkit heals `MEDKIT_HEAL` (50), clamped to `HEALTH_CAP`.
- **Overheal decays.** While `health > BASE_HEALTH`, it drains at `OVERHEAL_DECAY`
  (2.0) per second until it reaches 100. So a stacked medkit is worth about 25
  seconds of extra buffer, not a permanent upgrade.
- Health never regenerates on its own below 100.
- At `health <= 0` the player dies (§4).

## 2. Shield

Found as a **Shield Generator** item, not owned by default.

- Using it sets `shield_until = round_time + SHIELD_DURATION` (20 s).
- While active, all incoming damage is multiplied by `SHIELD_DAMAGE_MULT` (0.5).
- Using another generator while one is active **replaces** the timer (it does not
  stack duration and does not stack the multiplier). Re-applying at 2 s left gives
  you a fresh 20 s.
- The shield is a flat damage reduction, not a pool — it has no hit points and
  cannot be broken early.
- It applies to *all* damage: weapons, self-inflicted explosions, toxic rain, lava,
  meteors.

Client shows a translucent bubble around the player and a countdown ring on the HUD.

## 3. Movement speed

```
speed_multiplier = lerp(HEALTH_SPEED_MIN, 1.0, clamp(health / BASE_HEALTH, 0, 1))
                 * item_speed_multiplier          // 1.0 in v1; the seam for future items
```

At full health you move at `WALK_SPEED`; at 1 health you move at 75 % of it. The
multiplier scales the walk target speed, not acceleration, so control stays crisp.
Overheal does **not** make you faster — the clamp caps the ratio at 1.0.

This is the hook the brief asked for ("dynamic movement speed, base + affected by
items, health"). `item_speed_multiplier` exists and is always 1.0 in v1 so that
adding a boots item later touches one line.

## 4. Damage, death and respawn

### Applying damage

```rust
fn apply_damage(&mut self, amount: f32, source: DamageSource, now: f32) -> bool
```

1. If `!alive` or `now < iframes_until`, ignore it entirely and return false.
2. Multiply by `SHIELD_DAMAGE_MULT` if the shield is active.
3. Subtract from health.
4. Record `last_damaged_by = (attacker, now)` when the source has an attacker.
5. If `health <= 0`, die.

### Death

- `alive = false`, `health = 0`, `respawn_at = now + RESPAWN_DELAY` (3 s).
- The victim's score changes by `DEATH_POINTS` (−1), **always** — including
  self-kills and deaths to weather, exactly as the brief specifies.
- Kill credit: if the damage came from another player, that player's score changes
  by `KILL_POINTS` (+1). Environmental deaths credit nobody.
- **Assist window**: if the killing blow was environmental but another player
  damaged the victim within the last 5 seconds, that player still gets the kill.
  Otherwise shooting someone off a ledge into lava would reward nobody.
- The victim's inventory is dropped: each stack becomes a `WorldItem` at the death
  position with a small random outward velocity (`32-item-spawning.md`).
- A `death` event is broadcast with victim, attacker (optional), and cause.

### Respawn

At `respawn_at`:
- pick a spawn point from `MapMeta.spawn_points`, preferring the one furthest from
  the nearest living player, requiring at least `SPAWN_MIN_ENEMY_DIST` (384) where
  possible;
- **verify the point is still valid** — the map has been getting blown up, and a
  spawn point may now be mid-air or inside a crater. Re-run the surface test from
  `10-map-generation.md` §7a. If it fails, fall back to the nearest still-valid
  surface point. If none of the six work, use the nearest valid surface point from
  `MapMeta.surface_points`. This check is not optional; skipping it is how players
  end up spawning inside rock late in a round.
- reset `health = BASE_HEALTH`, clear the shield, refill jetpack fuel, clear the
  inventory, `alive = true`, `iframes_until = now + SPAWN_IFRAMES` (2 s);
- flashlight is forced off (the item is gone with the inventory).

During i-frames the player takes no damage and is drawn flashing. They *can* act —
this is not a stun.

## 5. Knockback

Explosions apply an impulse in addition to damage:

```
impulse = KNOCKBACK_MAX * (1 - dist / radius)      // same falloff as damage
vel += normalize(player_pos - explosion_pos) * impulse
```

Knockback applies even during i-frames and even when the shield is up — being
thrown is not damage. It is what makes rocket-jumping possible, and it is how a
player can be launched into a hazard.

Knockback is applied by the server and corrected on the client through normal
reconciliation. The client does not predict it (it cannot know an explosion is
coming), so a hit produces a visible one-frame correction. Acceptable.

## 6. Scoring

| Event | Victim | Attacker |
|---|---|---|
| Killed by another player | −1 | +1 |
| Killed by own weapon | −1 | — |
| Killed by weather | −1 | — |
| Killed by weather within 5 s of player damage | −1 | +1 (assist window) |

Score is a signed `i16` and may go negative. There is no floor at zero — the brief
says a death reduces a point, and a player who only dies should end below zero.

The scoreboard sorts by score descending, then by fewest deaths, then by join
order. Ties at the top are shown as ties; there is no tiebreaker round.

## 7. Testing

- Damage below 0 health kills exactly once — a second damage call on a dead player
  is a no-op and does not double-decrement the score.
- Shield halves damage from every source, and expires exactly at
  `SHIELD_DURATION`.
- Re-applying a shield replaces rather than stacks the timer.
- Overheal decays from 150 to 100 in exactly 25 s and then stops.
- A medkit at 60 health gives 110; at 130 health gives 150, not 180.
- Speed multiplier is 1.0 at 100 health, `HEALTH_SPEED_MIN` at 0, and 1.0 (not
  above) at 150.
- i-frames block damage for exactly `SPAWN_IFRAMES` and do not block knockback.
- A self-kill is −1 to the victim and +0 to everyone.
- The assist window credits a kill at 4.9 s and does not at 5.1 s.
- Respawn never places a player inside solid terrain — test by carving away all six
  spawn points and respawning.
- Death drops every inventory stack as a world item.

## 8. Future work

- Damage-over-time tracked as a status list rather than per-effect ticks, so poison
  and burning can stack and be displayed.
- Armour as a consumable pool distinct from the shield's flat reduction.
- Killstreaks, first-blood bonuses, and per-weapon score weighting.
- Spectate-your-killer during the respawn delay.
