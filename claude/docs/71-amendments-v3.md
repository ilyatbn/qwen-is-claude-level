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

## B11 — What an assertion actually witnesses

T10.03 asked for "assert zero ticks after the scene transition, not that you called
stop". That instruction caught two separate failures, and the second is worth more
than the feature.

**First:** the assertion read `attract?.tickCount ?? 0`. After teardown `attract` is
null, so it compared **0 against 0** and would have passed however the simulation
behaved. Fixed with a scene-level monotonic counter and a control asserting it is
non-zero first.

**Second, and this is the general lesson:** with the counter fixed, deleting the
shutdown handler entirely *still passed* — because **Phaser stops calling `update()`
on a stopped scene regardless.** "No ticks after the transition" is guaranteed by
the engine, not by the teardown code. The assertion was true, the measurement was
sound, and it witnessed nothing about the thing under test.

> Ask what a passing assertion **rules out**. If the property would hold with your
> code deleted, the framework is providing it and your test is watching the
> framework.

What actually witnesses the release is that the **handle is gone**: with both hooks
removed, the test now fails with `still allocated behind the menu (attractTicks 82)`.

This is distinct from §A15 (assert effects, not intentions) and sharper. There the
counter reported an intention. Here the effect was real, measured correctly, and
caused by something other than the code being tested — which no amount of asserting
harder on that number would have revealed. Only deleting the implementation did.

## B12 — The attract mode must show the game, not placeholders

The title screen renders bots as **coloured rectangles** while the game itself has
had character sprites since M7. It is the first thing a player sees, and it is
currently showing the placeholder art that everything else outgrew.

The attract mode wraps a real `World` and real `Bot`s — that part is right, and it
is what makes the title a live smoke test of `game-core` rather than a decoration.
It must render them through the **same sprite path the game uses**, including
facing, animation state and held weapon.

The rule this comes from is general enough to state: **a screen that exists to show
the game must not render it differently from the game.** A separate render path in
the attract mode is a second thing to keep in sync, and the first time it drifts,
the title screen will be advertising a game that no longer looks like that.

## B13 — Every room played the same map

With one room, a hardcoded seed is a harmless placeholder. With many, **every game
on the server plays the same map, and the same map again after a restart** — the
whole generator, 999-seed sweep and all, producing one level in practice.

It was invisible until a second room existed, which is the point: multi-room did
not create this bug, it revealed one that had been shipping since M6. A room's seed
is now mixed from the room id, and the test builds two rooms and compares their
**masks**.

The first version of that test could not fail:

> It tested `mix_seed` directly, so restoring the hardcoded seed left it green. It
> exercised the function but never the **decision to call it**.

That is §B11 again from a new angle — the unit was correct and unused, and testing
the unit says nothing about whether anything reaches it.

## B14 — `room_created` had no subscriber, and the Skins button had no scene

Two more of §A39's five, now eight:

- **Nothing subscribed to `room_created`.** The reducer case existed and was
  unit-tested, `lobby.ts` decoded the event, and no client ever handled it — so
  creating a private game never showed anyone the code, which is the only thing a
  private game is *for*.
- **`MenuScene` has called `scene.start('Skins')` since T10.04 and no such scene was
  ever registered.** Clicking Skins did nothing at all.

The second is the pattern **inverted**: not a mechanism with no consumer, but a
consumer with no mechanism. Both halves were present and plausible in isolation.

The diagnostic that catches it is the same one that keeps working here:

> **Arrive the way a player arrives.** The skins check enters *through the button*
> (`?menu=1`). One that navigated straight to `?skins=1` would have passed the whole
> time — and would have been the obvious way to write it.

## B15 — An assertion on a field that does not exist cannot fail

Two of the M10 checkpoint's own assertions were wrong, and only measuring showed it:

- It compared `debug().seed` between rooms to prove they differed. That field is the
  client's own core placeholder and reads `1` in every room, so **it compared two
  constants**.
- It asserted `debug().tick` advanced. There is no such field, and
  `undefined <= undefined` is `false` forever — so "three rounds are ticking" could
  never fail.

Both passed for a year of nothing. The rule:

> Before trusting an assertion on a debug field, **print it once**. A typo'd or
> absent field yields `undefined`, and every comparison against `undefined` is
> quietly false — which reads exactly like a passing test.

Room identity is the **mask checksum**; ticking is `lastServerTick`. Both are values
the server actually produces.

## B16 — A table indexed by position must say so, or check

`def()` in both the weapon and item registries does `TABLE.get(id as usize)` —
silently assuming array position equals id. Nothing asserted it and nothing
documented it. Inserting the two energy weapons at the front of the weapon table
shifted every lookup after them, so **a laser resolved as a bazooka**, and the only
symptom was a pierce test failing for a reason that looked unrelated to ordering.

Both registries now verify the id they found, and both carry a test that names the
offending entry rather than reporting a mismatch somewhere downstream.

This matters more as the arsenal goes from 3 weapons to 22: the table will be
edited often, and inserting in the middle is the natural thing to do.

> An implicit invariant that holds today is a trap the first time someone edits the
> data. Either encode it (`assert` the id matches the position) or remove the
> assumption (look the id up properly).

Related, and the same commit: the registry-integrity rule *"a weapon has
`max_stack > 1`"* is false for energy weapons, whose stack **is** the weapon. It is
now *"a weapon has ammo, and ammo is a stack or a battery"* — which is **stricter**,
because the old rule silently passed a weapon with neither.

## B17 — The spawn pool cannot simply accumulate

Going from **6 items to 7** measurably perturbed bot behaviour: the seeded spawn
stream reshuffled, and a lethality assertion that had been passing on a lucky draw
started failing. The arsenal is heading to **22**.

Two consequences, both for T11.09:

- **Spawn weights are a budget, not a list.** Adding a weapon with weight 20 to a
  table summing to 100 does not add a weapon; it dilutes every existing one by 17 %.
  A player who used to find a bazooka every 20 s now finds one every 24 s, and the
  bazooka's own weight never changed. The table must be rebalanced as a whole when
  the arsenal lands, and the balance measurement must report **pick rate**, which is
  the number that actually moves.
- **Any test whose fixture depends on the seeded item stream is coupled to the
  registry's contents.** Adding an item is enough to change what spawns where. Tests
  that need a specific loadout should arrange it directly rather than relying on
  what a seed happens to produce — the way `DEV_LOADOUT` already does.

Also recorded, because it is the honest version of a green test: an assertion that
"some kill happens across 5 seeds" was **removed**, not weakened. Its own doc comment
stated that ~8 of 10 rounds have zero kills on a correct build — about a 1-in-3
failure rate by arithmetic. It had been passing because those five seeds happened to
contain a lucky one. The damage floor it sits beside never moved, so lethality was
never in question; only the coin landed differently.

## B18 — A crate-scoped **Done when** cannot see a workspace break

T11.01's Done-when is `cargo test -p game-core`. It passed. The commit left the
**workspace unbuildable**: four new `GameEvent` variants never reached
`scope_of`/`name_of`/`payload_of`, and three new `Delivery` variants never reached
game-wasm's fire path. Verified independently in a clean worktree at that commit:
two compile errors.

The task's own gate was structurally incapable of seeing it, and the failure is
exactly where this project's most common defect lives — a type grew in one crate
and the crates that consume it did not.

`CLAUDE.md` already says to run `./scripts/check.sh` before reporting done. That is
now stated as the rule it always was:

> A **Done when** command proves the task. `./scripts/check.sh` proves the
> repository. A task is not done until **both** pass, and a crate-scoped Done-when
> makes the second one load-bearing rather than ceremonial.

## B19 — Three weapons that were built and could not be used

All three from the same batch, none visible to a unit test:

- **A knife deleted itself on its first swing.** `try_fire` consumed a stack for
  anything that was not an energy weapon, and melee has `max_stack: 1`. §B7 says
  melee is the floor of the arsenal; a weapon that vanishes when used is the most
  complete way to be worthless. Fixed with `WeaponDef::spends_stack()` — **derived**,
  not a fourth flag that can disagree with the other three (§B16).
- **Mines were indestructible in a real round.** `destroy_in_blast` had **no
  production caller** — only tests. §B6's "destructible by explosions, which is what
  stops a map filling up with them" was tested and never enforced. The unit test
  could not see it because *the test itself was the caller*.
- **Bots could not switch weapons at all.** Selection is a command and nothing in
  `Input` carries it, so the only thing that had ever changed a bot's selection was
  the inventory auto-advancing on an empty stack — and an energy weapon's stack never
  empties. Identical in shape to the bots that never fired (§A39 #5).

The pattern is now ten instances deep and its diagnostic has not changed: **grep for
the production callers of anything you build.** A test calling the function is not a
caller.

## B20 — The arsenal has no art, and the test that would catch it uses a fixture

Thirteen new items reference sprite keys absent from `atlas-map.json`. They fall
back to placeholders per `docs/50` §8 — nothing breaks, which is correct behaviour
and is also why nobody noticed. **Every new weapon looks identical on the ground.**

The check that should have caught it (`docs/51` §9: *"every atlas frame referenced
by `skins.json` exists in that atlas's JSON"*) validates against a **fixture**
rather than the live registry, so it cannot see a registry entry that has no art.

> A test that validates data against a copy of that data validates nothing. Point it
> at the registry the game actually loads.

## B21 — Heavy fog has done nothing since M5

`GameScene` hardcoded `fogMult: 1`, and `World::fog_multiplier` had **no caller at
all**. Heavy fog — one of the four weather effects, scheduled, telegraphed,
simulated and tested every round since M5 — has never changed anything a player
could see.

It was found only because smoke needed the same channel, which would have made it
the identical bug one milestone later. Eleventh instance of §A39, and the longest
lived: five milestones of a feature that ran correctly and reached nothing.

The fix is not just a wire-up. Vision is now **per player**, as a sixteenth
snapshot byte (`vision` = fog × smoke), because **smoke is positional**: what you
can see depends on which cloud you are standing in, and no global effect flag can
express that. `SNAPSHOT_PLAYER_BYTES` 15 → 16, snapshot `8 + n*16 + 4`.

Two things this says beyond the bug:

> A weather effect whose only observable is a multiplier nothing reads is
> indistinguishable from one that does not exist. **Every effect needs an assertion
> on what a player experiences**, not on what the simulation computed — the §A15
> rule, applied to gameplay rather than to rendering.

And the reason it survived: fog's tests all assert `fov_radius(...)` returns the
right number, which it always did. The formula was never wrong. **Nothing tested
that the number reached the screen.**

## B22 — Two literals that pinned the wire format to a copy of itself

Adding the vision byte broke two tests that hardcoded the layout: `codec.test.ts`
had `const per = 15`, and the Rust size test had `102`. §A19's rule already covers
this — tests pin to the constants, never to a literal — and it had drifted back in.

Worth stating why it matters more here than as a style point: a fixture that
hardcodes the wire layout can stay **green against a decoder that has drifted**.
The literal agrees with the test's own expectation and neither agrees with the
encoder.

Same session, the same shape one layer out: `cargo test -p game-core --test thrown`
passed while the workspace was broken, because the vision byte reached the encoder
and the TypeScript decoder but not game-server's own Rust decoder — seven codec
tests failing with `TrailingBytes`, one unread byte per player. Exactly §B18, made
again by the session that had just been told about it. **The gate is the only thing
that sees a cross-crate break**, and it is not optional.
