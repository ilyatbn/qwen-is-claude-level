# 71 — Amendments v3: menus, the arsenal, and tombstones

A third round of design, requested after v2 shipped. This document **overrides**
`00`–`62` and extends `70-amendments-v2.md` where they conflict. Everything not
mentioned here stands as written.

Constants introduced here are as authoritative as `02-constants.md` and must be
mirrored in `crates/game-core/src/constants.rs` (a `v3` section) exactly as below.

---

## B1 — Multiple concurrent rooms

`41-server-loop-rooms.md` §9 already wrote the path down: *"a `RoomRegistry` of
`room_id → mpsc::Sender<Command>`, and socket.io rooms for scoping broadcasts. The
room task is already isolated, so this is additive."* This is that, built.

```rust
pub struct RoomRegistry {
    rooms: HashMap<RoomId, RoomHandle>,   // lookup only — never iterated for output
    codes: HashMap<JoinCode, RoomId>,
    queue: Vec<Waiting>,                  // quick-match, ordered by join time
}
```

- **`RoomId`** is a `u32`, monotonic per process. **`JoinCode`** is 6 characters
  from `ABCDEFGHJKLMNPQRSTUVWXYZ23456789` — no `I`/`1`/`O`/`0`, because people read
  these aloud.
- Every broadcast is scoped to the socket.io room `room:<id>`. A broadcast that
  reaches another game is the multi-room equivalent of the inventory leak in
  `30-items-inventory.md` §6, and is tested the same way: **assert the negative.**
- **Never iterate the registry to produce game output.** `HashMap` iteration order
  is randomly seeded per process (§A11), and this is the single largest new surface
  for that class of bug.

### Lifecycle

| | |
|---|---|
| Created | on `create_private`, or by quick-match when no room has space |
| Destroyed | `ROOM_EMPTY_TTL` after its last **human** leaves — bots do not keep a room alive |
| Capped | `MAX_ROOMS`, measured not guessed — see B2 |

A room whose last human leaves stops ticking immediately and is dropped after the
TTL; it does not keep simulating an empty world for four minutes.

| Name | Value | Notes |
|---|---|---|
| `MAX_ROOMS` | 8 | provisional — B2 replaces it with a measured value |
| `ROOM_EMPTY_TTL` | 30.0 | seconds after the last human leaves |
| `JOIN_CODE_LEN` | 6 | |
| `QUEUE_WAIT_BEFORE_BOTS` | 20.0 | quick-match seats bots and starts rather than waiting forever |

### Quick match

Fill the **fullest room that still has space** (so games start sooner and empty
rooms drain), otherwise create one. After `QUEUE_WAIT_BEFORE_BOTS` a waiting player
is seated into a fresh room with bots rather than left staring at a spinner — the
same reasoning as `MIN_PLAYERS_TO_START = 1`.

## B2 — Measure the cost of a room before allowing eight

The tick budget in `60-testing.md` §6 is *"6 players + 20 projectiles, one tick,
under 2 ms"*. That was never measured with weather running, a full arsenal in
flight, and several rooms competing for cores — and §A38 already caught this
project comparing a growing total against a ceiling written for one of its parts.

So `MAX_ROOMS` is **not** a guess:

> Measure a full room — 6 players, bots firing, weather active, late-round terrain —
> for tick p50 and p99, at 1, 2, 4 and 8 concurrent rooms. Set `MAX_ROOMS` from
> where p99 crosses **half** the 16.67 ms tick budget, and write the numbers and
> the machine into the constant's doc comment.

A room over budget does not just run slow: `MissedTickBehavior::Burst` makes it
catch up in a spike, which is worse. `/metrics` gains `rooms_active`,
`tick_p99_ms_max_over_rooms` and `rooms_over_budget`.

## B3 — Scenes and the shape of the front end

```
Boot ──▶ Title ──▶ Menu ──┬──▶ Lobby ──▶ Game ──▶ Scoreboard ──▶ Menu
                          └──▶ Skins
```

- **Title** — the game's name, a **Start Game** button, and behind it a live
  **attract mode**: a real generated map with bots fighting each other. It runs
  entirely client-side in WASM against `game-core`, exactly as the sandbox does, so
  it costs the server nothing and cannot fail because a server is down. It is also
  a continuous smoke test of the simulation that anyone can see.
- **Menu** — map size (small / medium / large), then **Create private** (shows the
  join code), **Join private** (enter a code), or **Quick match**.
- **Skins** — pick a character skin and a tombstone skin. Weapon skins are shown
  **greyed out with "Coming soon"**, because `50-sprites-skins.md` §1 deliberately
  keeps weapon skins off the wire. Selection persists in `localStorage`.
- **Death overlay** — see B4.
- Every screen is reachable with the keyboard, and `Esc` always goes back one step.

## B4 — Death, and the respawn timer

`21-player-stats.md` §4 sets `RESPAWN_DELAY` to 3.0. It becomes **5.0**, with an
on-screen countdown, per the brief.

- The overlay shows the countdown, who killed you and with what, and the scoreboard.
- **It is an overlay, not a pause.** The round keeps running behind it, and the
  camera stays where you died so you watch the fight continue — consistent with
  `30-items-inventory.md` §3, where opening the inventory does not pause anything.
- At zero you respawn at a re-validated spawn point (`21-player-stats.md` §4 — the
  re-validation is not optional, the map has been under fire).

| Name | Value |
|---|---|
| `RESPAWN_DELAY` | 5.0 (was 3.0) |

## B5 — The battery, and why lasers are different

A single resource shared by shields and energy weapons, so every laser shot is a
shield you are not going to have.

```rust
pub battery: f32,   // 0 ..= BATTERY_MAX
```

- Picked up as a **battery pack** item. It is the only ammo energy weapons use, so
  a laser with no battery is a paperweight.
- **The shield generator draws from it**: activating costs nothing up front, and an
  active shield drains `SHIELD_DRAIN` per second. The shield ends early when the
  battery is empty. `SHIELD_DURATION` remains its maximum.
- **Energy weapons cost battery per shot** instead of a stack count.
- **Against a shielded target, energy weapons pierce**: incoming damage is
  multiplied by `LASER_SHIELD_MULT` (0.85) rather than `SHIELD_DAMAGE_MULT` (0.5),
  and the hit drains `LASER_BATTERY_DRAIN` from the victim's battery — which cuts
  the shield's remaining life directly.

That is the whole mechanic: energy weapons are the answer to a turtling opponent,
and using them costs you your own defence. It needs no new UI beyond a battery bar.

| Name | Value |
|---|---|
| `BATTERY_MAX` | 100.0 |
| `BATTERY_PACK_AMOUNT` | 50.0 |
| `SHIELD_DRAIN` | 2.0 | per second while the shield is up |
| `LASER_SHIELD_MULT` | 0.85 |
| `LASER_BATTERY_DRAIN` | 8.0 | per hit, from the victim |

## B6 — Delivery kinds

`31-weapons-combat.md`'s `Delivery` enum grows. Its existing two are unchanged.

```rust
pub enum Delivery {
    Projectile { fuse, restitution, friction, explode_on_contact },   // unchanged
    Hitscan { shots, spread },                                        // unchanged
    Melee { reach: f32, arc: f32, knockback: f32 },
    Cone { range: f32, arc: f32, dps: f32, particle_life: f32 },
    Placed { arm_time: f32, trigger_radius: f32, lifetime: f32 },
}
```

- **Melee** sweeps an arc centred on the aim angle, hits every player whose AABB
  intersects it, and **carves** its `blast_radius` — an axe digs. No ammo; it has a
  cooldown instead. It is the answer to running out of everything, and it must
  never be worthless.
- **Cone** (flamethrower) applies `dps` to anything inside the cone each tick and
  leaves burning ground, reusing the lava-burn hazard from
  `13-weather-effects.md` §5. It carves nothing — fire does not dig.
- **Placed** (mine) arms after `arm_time`, then detonates when a player other than
  the owner comes within `trigger_radius`. It despawns at `lifetime`. It is
  destructible by explosions, which is what stops a map filling up with them.

## B7 — The arsenal

Existing three unchanged: `bazooka`, `grenade`, `smg`.

### Ballistic hitscan

| key | dmg | carve | range | cd | spread | ammo |
|---|---|---|---|---|---|---|
| `pistol` | 14 | 3 | 520 | 0.28 | 0.020 | 40 |
| `revolver` | 32 | 5 | 700 | 0.70 | 0.010 | 12 |
| `deagle` | 45 | 6 | 760 | 0.85 | 0.015 | 8 |
| `machinegun` | 11 | 3 | 900 | 0.09 | 0.045 | 120 |

### Energy hitscan — ammo is battery, not a stack

| key | dmg | carve | range | cd | spread | battery/shot |
|---|---|---|---|---|---|---|
| `laser_pistol` | 22 | 4 | 900 | 0.35 | 0.000 | 6 |
| `laser_smg` | 9 | 2 | 1000 | 0.08 | 0.020 | 2 |

### Melee — no ammo, cooldown only

| key | dmg | carve | reach | arc | cd | knockback |
|---|---|---|---|---|---|---|
| `knife` | 35 | 0 | 26 | 1.0 | 0.35 | 60 |
| `bat` | 28 | 0 | 34 | 1.4 | 0.55 | 260 |
| `whip` | 22 | 0 | 58 | 0.8 | 0.60 | 120 |
| `axe` | 55 | 10 | 30 | 1.2 | 0.90 | 140 |
| `hammer` | 70 | 16 | 28 | 1.1 | 1.20 | 340 |

### Cone

| key | dps | range | arc | cd | ammo | burn |
|---|---|---|---|---|---|---|
| `flamethrower` | 14 | 150 | 0.55 | 0.05 | 200 | leaves `LAVA_BURN_*` ground fire |

### Thrown and placed

| key | behaviour |
|---|---|
| `mine` | `Placed`, arm 1.0 s, trigger 36, lifetime 90, dmg 60, blast 48. Ammo 2. |
| `airburst` | Projectile, no contact detonation; bursts at apex or 1.2 s, firing `AIRBURST_PELLETS` (9) energy pellets in a downward fan, 12 dmg / carve 4 each. Ammo 2. |
| `smoke` | Projectile, 1.5 s fuse, then a cloud of radius 110 for 8 s. **No damage.** Anyone inside or sighting through it has FoV multiplied by `FOV_SMOKE_MULT`. |
| `molotov` | Projectile, shatters on contact, scatters 6 fire patches; each burns `LAVA_BURN_DPS` for 5 s over `LAVA_BURN_RADIUS`. Ammo 2. |
| `toxic_grenade` | Projectile, 2 s fuse, leaves a radioactive zone radius 90 for 8 s at `TOXIC_DPS`. **No terrain damage**, exactly as toxic rain (`13` §3). Ammo 2. |

| Name | Value |
|---|---|
| `AIRBURST_PELLETS` | 9 |
| `AIRBURST_FAN` | 0.9 | radians, downward |
| `FOV_SMOKE_MULT` | 0.35 |
| `SMOKE_RADIUS` | 110 |
| `SMOKE_DURATION` | 8.0 |
| `MINE_ARM_TIME` | 1.0 |
| `MINE_TRIGGER_RADIUS` | 36 |
| `MINE_LIFETIME` | 90.0 |

### Balance is measured, not asserted

Twenty-two weapons cannot be balanced by inspection. `T11.09` runs headless bot
rounds and reports **damage per second in the hand**, **kills per pickup** and
**pick rate** per weapon. A weapon more than 2× the median on any of those, or
below half, is reported with its numbers — the same discipline §A19 imposed on
thresholds. The table above is a starting point, not a result.

## B8 — Tombstones

When a player dies, a tombstone is placed at the death position and stays for the
rest of the round.

```rust
pub struct Tombstone {
    pub id: TombstoneId,
    pub owner: PlayerId,
    pub pos: Vec2,
    pub skin_id: u16,
    pub effect: TombstoneEffect,   // v1: always None
    pub placed_at: f32,
}
pub enum TombstoneEffect { None }
```

- It is a **physics body** (`Body::sized`, 14 × 18) so it falls if the ground under
  it is destroyed, exactly as world items do — a tombstone hanging over a crater is
  the same lie `docs/32` §4 rules out for crates.
- It has **no collision with players** and no gameplay effect in v1.
- `tombstone_skin_id` joins `skin_id` on the wire: one `u16` in `join`, echoed in
  `welcome` and `player_join`. The server does not know what any id looks like
  (`50-sprites-skins.md` §1).
- The `effect` field exists so revive-here, explode-on-touch and similar are a
  registry entry later rather than a schema change. **It is not a stub layer** —
  it is one enum with one variant, and nothing branches on it in v1.
- Capped at `MAX_TOMBSTONES` per room, oldest removed first, so a long round with
  many deaths does not accumulate unbounded entities.

| Name | Value |
|---|---|
| `TOMBSTONE_W` | 14 |
| `TOMBSTONE_H` | 18 |
| `MAX_TOMBSTONES` | 32 |

## B9 — Protocol additions

All additive; nothing existing changes shape.

| direction | event | payload |
|---|---|---|
| c→s | `create_room` | `{ scale, private: bool }` → `room_created { room_id, code }` |
| c→s | `join_room` | `{ code }` → `welcome`, or `join_error { reason }` |
| c→s | `quick_match` | `{ scale }` → `welcome` when seated |
| c→s | `leave_room` | — |
| s→c | `room_list` | quick-match status: `{ waiting, eta_s }` |
| s→c | `tombstone_spawn` | `{ tick, id, owner, x, y, skin_id }` |
| s→c | `tombstone_despawn` | `{ tick, id }` |

`join` gains `tombstone_skin_id: u16`. The snapshot player block gains **one byte**
for `battery` (quantised `battery / BATTERY_MAX * 255`), taking it from 15 to
**16 bytes** and the snapshot to `8 + n*16 + 4` — 104 bytes at six players, still
far inside the budget in `40-net-protocol.md` §4. §A25's rule stands: the size test
pins to the constants, never to a literal.

## B10 — There is no queue, and that is better

§B1 specified a quick-match **queue** with `QUEUE_WAIT_BEFORE_BOTS`: wait for other
players, then seat bots and start. Building it revealed the queue is unnecessary,
and the constant went unused.

The pieces already in place do the job:

- quick match fills **the fullest room that still has space**, so a second
  quick-matcher lands in the first one's room by construction — which is what the
  queue was for;
- `MIN_PLAYERS_TO_START` is 1 and bots fill the room from the start, so nobody ever
  waits;
- a human joining a full room **kicks the newest bot** (T6.15), so a person is never
  refused a seat and every human arrival displaces an AI.

Together those give the queue's intended outcome — play together if you arrive
together, never wait alone — without a waiting state to be stuck in. A queue would
only add a screen that can hang.

So: **`QUEUE_WAIT_BEFORE_BOTS` is removed**, and `room_list` stops reporting
`waiting`/`eta_s`, which were structurally always zero. It reports what is true
instead: the room's player count, its capacity, and how many of those are bots — so
"3/6, two of them bots" is visible before the round starts, which is more useful
than an ETA that was never going to be non-zero.

The general point, and it is the fifth time on this project: **a design written
before the code exists can specify machinery the code turns out not to need.**
§A19, §A32, §A37 and §A38 were all numbers that did not survive measurement; this
is a mechanism that did not survive implementation. Deleting it is the result, not
a shortcut around it.

### B2 — corrected

**Tick cost does not bound `MAX_ROOMS`, and §B2 asked the wrong question.** It
specified "set `MAX_ROOMS` where p99 crosses half the 16.67 ms budget". It never
crosses. Measured on 16 cores, release, medium maps, 6 firing bots per room, after
a 45 s warm-up:

| rooms | p50 | p99 | max |
|---|---|---|---|
| 1 | 0.002 | 0.004 | 0.009 ms |
| 8 | 0.002 | 0.009 | 0.051 |
| 32 | 0.002 | 0.008 | 0.541 |
| 128 | 0.003 | 0.010 | 0.518 |

At **128 rooms** p99 is using **0.12 % of half a tick budget**, and per-room cost is
flat (8 rooms costs 1.01× per room versus 1). Control drift 1.5 %, so the box was
genuinely idle — the §A38 lesson applied.

`MAX_ROOMS` is **32**, and the constant's doc comment carries the table plus what
actually bounds it:

- **Memory**: terrain is ~648 KiB per medium room, ~1.2 MiB per large.
- **Room creation**, at **0.6–1.1 s**, is the expensive operation — not ticking. A
  burst of players creating private rooms is the load worth worrying about, and it
  is why generation runs off the tick thread.
- **Not measured, and stated as such**: the socket layer at 192 concurrent clients,
  and memory under real load rather than by arithmetic.

The interesting part is not the number. It is that **the instrument was broken
before the code was**, twice:

> The first measurement measured six players **standing still** — no bots thinking,
> no firing, no weather. p50 and p99 both rounded to 0.000 ms and max was 11 µs. It
> would have justified any `MAX_ROOMS` whatsoever.

> `max_rooms_carries_its_basis` asserted the doc comment mentions "T10.07" — which
> the placeholder *"Provisional until T10.07 measures it"* already contained. **The
> test passed against exactly the state it exists to reject.**

Both are the §A15 failure — asserting an intention rather than an effect — and the
second is its purest form yet: a test whose subject and whose sentinel were the
same string.

`/metrics` reports the three fields **per room**, not process-wide, because a
process-wide p99 hides one sick room behind seven healthy ones, and
`MissedTickBehavior::Burst` makes a sick room spike rather than degrade.
