# 75 — Amendments v7: bullets you can see, and a game you can debug

M19. Nine items, and seven of them are the same complaint said seven ways: **the
simulation is right and the player cannot tell.** A tracer that lives 0.09 s, a fog that
only shrinks a lightmap radius, a poison that lands on nobody, a firing gate that turns
every click into silence — each one passes its test and each one reads as a broken game.

Constants introduced here are as authoritative as `02-constants.md` and must be mirrored
in `crates/game-core/src/constants.rs` (a `v7` section).

This document **overrides** `docs/72` §C20 and §C23, `docs/74` §E13, `docs/31` §1 and
`docs/30` §3 where they disagree. Each override is named at the point it happens.

---

## F1 — A bullet is a thing that flies

**This overrides `docs/72` §C23 and `docs/31` §1.** §C23 assumed the fix for "gun
projectiles are invisible" was a rendering fix. Three milestones of rendering work later
they are still invisible, and the reason is upstream of the renderer: **a hitscan shot
does not exist for long enough to be seen.** It is a line segment that appears and
vanishes in the same instant, and `ordnance-visible` can only photograph one by *freezing
the frame first* — which is the check telling us, in writing, that a player cannot see it.

> **Ballistic guns fire a projectile that travels.** A bullet leaves the muzzle at the
> weapon's `muzzle_speed`, flies in a **straight line** — no gravity, no wind — and stops
> at the first thing it touches or when it has flown `range` px.

A new delivery, because the flight rules genuinely differ from a grenade's:

```rust
Delivery::Bullet { spread: f32, auto: bool }
```

`muzzle_speed`, `range`, `damage` and `blast_radius` (the carve it leaves) are the
existing `WeaponDef` fields and keep their meanings. `gravity_scale` and `wind_scale` are
**0.0 for every bullet** and that is what "straight line" means — the player's model of a
gun is a line from the barrel to the thing they are pointing at, and an arc they cannot
predict is indistinguishable from a miss.

- **`Delivery::Hitscan` is retired for ballistic weapons.** Pistol, revolver, deagle,
  machinegun and SMG become `Bullet`.
- **The laser weapons keep `Hitscan`**, and that is the whole point of them: a laser is
  an instant beam and a bullet is not. Two delivery kinds that *look* different is a
  design, where two that look identical was a bug. (§F2 gives the beam a life a person
  can see.)
- A bullet uses the shared projectile step (`weapons/projectile.rs`) — the same
  sub-stepped terrain and player collision every other projectile uses, so it cannot
  tunnel through a thin wall at 900 px/s. **Share the function** (`CLAUDE.md`): a second
  flight loop is a second set of tunnelling bugs.
- `spread` applies at the muzzle, once, as it does today.
- Damage, shields, attribution and the carve all go through `detonate` unchanged. A
  bullet is a projectile whose burst is a very small `Blast`.

**Ammo is unchanged**: a bullet spends a round from the stack when it is fired, not when
it lands. A shot in flight is already paid for.

## F2 — You can see what you fired, without freezing the game

The client already draws projectiles (`ordnance.ts`). Bullets arrive as
`projectile_spawn` / `projectile_move` / `projectile_despawn` like every other projectile,
so most of this is a `LOOK` entry — but three things are specified rather than left to
taste, because "draw it" is what was done last time:

- **A bullet is drawn as a short bright streak along its velocity**, `BULLET_LENGTH` long
  and `BULLET_WIDTH` wide, not as a round dot. A dot at 850 px/s reads as a flicker; a
  streak reads as a direction, which is the information a player actually needs.
- **Automatic fire must read as a stream.** Ten bullets in the air on one line is the
  picture (see the reference image in the M19 brief) — so the trail is short and the
  streaks do not merge into a solid bar.
- **The beam is not a bullet.** `TRACER_LIFETIME` goes from 0.09 s to
  `BEAM_LIFETIME` 0.35 s, because that path now serves the laser weapons only, and the
  measured reason it was invisible was that it lived for five frames.

**The acceptance is a moving bullet in a real game, photographed without `freeze`.** Two
frames a fixed interval apart, the same shot, and the streak has *moved* — that is the
one assertion a hitscan implementation cannot pass, and it is why the old check could not
have caught this. `ordnance-visible` keeps its beam half, on a laser weapon.

## F3 — Automatics: hold the button, empty the clip

> **Holding fire on an automatic weapon keeps firing at the weapon's cooldown until the
> button is released or the stack is empty.** Every other weapon fires once per press.

`auto: true` on the `Bullet` delivery is what distinguishes them: SMG and machinegun,
plus `LASER_SMG` on the beam path. It is a property of the weapon and not of the input,
so a bot holding fire behaves identically to a human doing it.

The client is where the repeat lives — the server already refuses a shot inside
`fire_ready_at` and that gate does not move. For the client to time the repeat it needs
to know the cadence, so **`item_registry_json` gains `auto` and `cooldown`** from the
weapon def. It is one table with one source, and a TypeScript copy of five cooldowns
would be the second source `CLAUDE.md` warns about.

**Automatics hit softer than the guns that fire once.** Today's numbers already satisfy
this — 8–11 per shot against 14–45 — and it becomes an invariant with a test rather than
a coincidence: *every automatic's per-shot damage is below every semi-automatic's.* A
balance change that inverts it should fail a check, not be discovered in play.

## F4 — You fire while moving. §C20 is repealed.

**This overrides `docs/72` §C20 in full.** "You cannot fire while moving" was the Worms
convention applied to a game with a jetpack, and in play it means most clicks do nothing
and the player cannot tell why — no sound, no message, no feedback of any kind. It has
been reported three times.

> **Firing, throwing and swinging are allowed always** — standing, walking, running,
> falling, mid-jump and mid-jetpack. Cooldown and ammo are the only gates.

- `moving_under_own_power` and `UseError::Moving` are **deleted**, not bypassed. A gate
  left in place behind a flag is a gate someone re-enables.
- `FIRE_MOVE_MAX_SPEED` is retired.
- The bot mirror of the gate (`bots/mod.rs`, two sites that copy it "term for term")
  goes with it. Bots that stop to shoot were compensating for a rule that no longer
  exists.
- Every test that asserts `Err(UseError::Moving)` is asserting the removed design.
  Delete them and **replace them with the opposite claim**: a player at full run fires,
  and a player in mid-air fires. An absence needs a presence (`CLAUDE.md`).

### F4.1 — Both mouse buttons fire

**This overrides `docs/30` §3.** Right-click currently opens the backpack. The reported
expectation is that *clicking fires* — either button, at any time — and a right-click
that opens a panel in the middle of a firefight is the same class of defect as a click
that silently does nothing.

- **Left button and right button both fire.** Identically: there is no secondary fire.
- **The backpack moves to `Tab`.** It keeps every other behaviour §C10 gave it — a
  toggle, client-side, sends nothing, does not pause the round.
- The escape menu and the quick bar are untouched.

## F5 — The shovel, and the end of the melee cabinet

> **Every player spawns holding a shovel, and it is the only melee weapon in the game.**

- The shovel **hits opponents and digs through the map**: a `Melee` delivery with
  `SHOVEL_CARVE`, in the shape the axe and hammer already have.
- It has **no ammo and cannot be dropped or lost** — it is the floor of the arsenal
  (`docs/71` §B6), and a floor you can fall through is not one. It occupies the first
  quick-bar slot at spawn.
- **Knife, baseball bat, whip, axe and hammer are retired**: removed from the registry,
  from the weapon table, from the spawn and crate tables, and from the constants. Five
  weapons that differ by twenty percent on four numbers are not five decisions.
- The shovel needs art at both ends — a world sprite and an inventory tile — through the
  §E14 path that already resolves both from one sprite key.

**Ids are retired, never reused, and never renumbered.** `WeaponId` and `ItemId` are
positional — `WEAPONS[i].id == WeaponId(i)` — and the client mirrors that order in
`WEAPON_KEYS`. Deleting five weapons out of the middle of that table renumbers everything
after them, which is §B16 exactly: the bug where a laser resolved as a bazooka. The five
ids stay dead and the shovel takes the **next free id** at the end of the table. If the
positional invariant cannot survive holes, the table keeps a `Retired` placeholder and
says so — the pinned test decides, not the eye.

The redistribution matters: those five carried real `spawn_weight`, `crate_weight` and
`buried_weight`, and deleting them silently re-weights every other item on the map. The
shovel is **not** a ground spawn (everyone has one), so their weight goes to the guns and
grenades that remain, and the item-density sweep is re-run and reported.

## F6 — Rain that falls on you hurts

**This overrides `docs/74` §E13's numbers, not its design.** §E13's mechanism is right
and shipped: a drop is a projectile, what it hits it poisons, a roof protects you. In
play it does nothing, and the arithmetic says why — a drop every 0.4 s scattered across a
1536 px map, landing on a 20 px-wide player, for 6 total damage. **A player can stand in
toxic rain for its full 8 seconds and statistically never be hit.**

Three changes, all numbers:

- **A drop splashes.** Anything within `TOXIC_SPLASH_R` of where it lands is poisoned,
  not only the body the projectile point intersected. Rain lands *around* you.
- **`TOXIC_DROP_EVERY` 0.4 → 0.15.** Roughly 53 drops over `TOXIC_DURATION` instead of
  20.
- **`TOXIC_POISON_DPS` 2.0 → 6.0.** A hit costs 18 health over 3 s: enough to be a
  reason to move, well short of the meteor shower's.

The roof rule, the reset-not-stack rule and the green health bar are unchanged.

**The acceptance is a player who stands in it and loses health** — measured over a full
shower on a fixed seed, from a real match, with a control player under a roof who does
not. The existing unit tests hit the player deliberately; that is why they passed while
the rain did nothing.

## F7 — A private game is where you debug the game

Private lobbies have one setting (map size, §E3). Three more, and their reason is stated
plainly: **there is no way to reproduce anything.** Waiting four minutes for a round with
bots you did not want and a weapon you have to find is why defects get reported as "still
broken" rather than as a repro.

| Setting | Values | Default |
|---|---|---|
| Bots | Enabled / Disabled | Enabled |
| Starting weapons | None / Basic / All | None |
| Round timer | `ROUND_SECONDS_MIN`..`ROUND_SECONDS_MAX`, in `ROUND_SECONDS_STEP` steps | `ROUND_SECONDS_MIN` (4 min) |

- **None** is the shipped game: the shovel and nothing else (§F5).
- **Basic**: the shovel, one handgun with `PISTOL_AMMO`, and 2 grenades.
- **All**: the shovel, every weapon in the game at `max_stack`, and a full battery.
- **Bots: Disabled** means a private match starts and runs with no bots at all, however
  few humans are seated.

They follow §E3's existing rules exactly, and reuse its machinery rather than growing a
second one: **the host owns them**, they may be changed at any time before the start,
**and any change clears every ready flag** — the same `SetScale` path, the same
`note_lobby_change`, the same replay record. A settings change that is not recorded makes
a replay describe a different match than the one played (§E1.2's lesson, which this
would repeat).

**`round_seconds` becomes the room's, not the process's.** It is a `Config` field today,
read from the environment; the lobby's value overrides it for that room. The env var
stays and becomes the default for rooms that never set one — a check that shortens a
round must keep working.

Public lobbies are unchanged and get no settings panel.

## F8 — The teleport charge is 1.5 seconds

`TELEPORT_CHARGE` 2.0 → 1.5. Two seconds standing still on a lit pad in a game where
everyone can now shoot you while running (§F4) is a long time. Nothing else about the
pads changes; `TELEPORT_COOLDOWN` stays at 5.0.

## F9 — Fog you can actually see

Heavy fog is currently a multiplier on the lightmap's FoV radius, which in **daylight**
is close to invisible — and daylight is when fog is supposed to matter (`docs/13` §6).
The formula has been correct for six milestones with nothing carrying it to the screen,
which is the exact shape `CLAUDE.md` records under *assert on effects, not intentions*.

> **Fog is a grey screen-space veil.** A full-screen `FOG_SCREEN_COLOUR` fill at
> `FOG_SCREEN_ALPHA` × `strength(now)`, drawn over the world and under the HUD, scrolling
> with nothing.

- It reduces the visibility of **everything** — terrain, players, ordnance, sky. Anything
  it excludes is a thing that becomes *more* visible in fog, which is backwards.
- It ramps with the existing `strength()`, so it inherits `FOG_RAMP` and cannot pop.
- The FoV multiplier stays as well: at night the two compound, which is the design
  §E13-era work already assumed.
- **The HUD is above it.** Fog is weather, not a disability — the same rule the death
  overlay follows.

**Acceptance is pixels**: the same frame with and without fog, sampled over the world,
differs by the alpha the constant names, with a control frame taken before the effect
starts.

## F10 — Constants

New:

| Name | Value | Notes |
|---|---|---|
| `PISTOL_MUZZLE_SPEED` | 900 | px/s (§F1) |
| `REVOLVER_MUZZLE_SPEED` | 1000 | " |
| `DEAGLE_MUZZLE_SPEED` | 1050 | " |
| `MACHINEGUN_MUZZLE_SPEED` | 850 | " |
| `SMG_MUZZLE_SPEED` | 800 | " |
| `BULLET_LENGTH` | 10.0 | drawn streak, px (§F2) |
| `BULLET_WIDTH` | 2.0 | " |
| `BEAM_LIFETIME` | 0.35 | seconds; replaces `TRACER_LIFETIME`'s value on the laser path (§F2) |
| `SHOVEL_DAMAGE` | 30.0 | (§F5) |
| `SHOVEL_CARVE` | 14.0 | it digs |
| `SHOVEL_REACH` | 20.0 | " |
| `SHOVEL_ARC` | 1.2 | radians |
| `SHOVEL_COOLDOWN` | 0.55 | seconds |
| `SHOVEL_KNOCKBACK` | 150.0 | " |
| `TOXIC_SPLASH_R` | 28.0 | px around a landed drop (§F6) |
| `ROUND_SECONDS_MIN` | 240.0 | private timer floor and default (§F7) |
| `ROUND_SECONDS_MAX` | 600.0 | ceiling |
| `ROUND_SECONDS_STEP` | 60.0 | the step the host's arrows take |
| `FOG_SCREEN_ALPHA` | 0.8 | at full strength (§F9) |
| `FOG_SCREEN_COLOUR` | 0x9AA0A6 | grey |

Changed:

| Name | From | To | Notes |
|---|---|---|---|
| `TOXIC_DROP_EVERY` | 0.4 | 0.15 | ≈53 drops a shower (§F6) |
| `TOXIC_POISON_DPS` | 2.0 | 6.0 | 18 health a hit (§F6) |
| `TELEPORT_CHARGE` | 2.0 | 1.5 | (§F8) |
| `TRACER_LIFETIME` | 0.09 | `BEAM_LIFETIME` 0.35 | lasers only now (§F2) |

Retired:

| Name | Why |
|---|---|
| `FIRE_MOVE_MAX_SPEED` | §C20 is repealed (§F4) |
| `KNIFE_*`, `BAT_*`, `WHIP_*`, `AXE_*`, `HAMMER_*` | one melee weapon (§F5) |
| `SMG_SHOTS` | a bullet weapon fires one bullet; multi-pellet is the airburst's job (§F1) |
| `SMG_GRAVITY_SCALE`, `SMG_WIND_SCALE` | a bullet flies straight, and 0.0 is not a tunable (§F1) |

## F11 — What this deliberately does not add

- **No reload.** The stack is the clip; when it is empty the weapon is empty.
- **No secondary fire.** Both mouse buttons do the same thing (§F4.1), and a game where
  they differ is a game where the reported bug — "I click and nothing happens" — comes
  back wearing a different hat.
- **No bullet drop, no ricochet, no penetration.** A bullet stops at the first thing it
  touches. Every one of those is a new flight rule and §F1's whole claim is that the
  flight rule is now simple enough to predict.
- **No settings on public lobbies** (§F7). A public match is the game as shipped.
