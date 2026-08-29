# 74 — Amendments v6: lobbies, and the things that are wrong

Two unrelated bodies of work. **M17** replaces matchmaking: a lobby becomes a real place
you sit in, with a roster you can see, and a match is created only when the lobby says
go. **M18** is a list of defects and small features, each independent of the others.

Constants introduced here are as authoritative as `02-constants.md` and must be mirrored
in `crates/game-core/src/constants.rs` (a `v6` section).

This document **overrides** `docs/72` §C18, `docs/71` §B10 and `docs/41` §4 where they
disagree. Each override is named at the point it happens.

---

# Part one — M17, lobbies and queues

## E1 — A lobby is a room that has no world yet

Today a room generates its map in its constructor (`room.rs:455`) and the client is
thrown straight into `GameScene`, where a DOM panel says "Lobby" over a world the player
is already standing in. That is why the lobby reads as a five-second flicker: it is not a
place, it is an overlay on a match that has already begun.

> **A lobby is a room in `RoundPhase::Lobby`, and a room in `Lobby` has no `World`.**
> The map, the round timer, the weather schedule and the item spawns come into existence
> at the moment the match starts, not when the room is made.

Three things follow, and all three are the point:

- **A private lobby can change its settings.** Map size is adjustable precisely because
  no map exists to contradict it. This is the whole reason for the ordering.
- **Making a lobby is instant.** `docs/71` §B2 measured room *creation* at 0.6–1.1 s and
  ticking at nearly nothing; that cost moves to match start, where a player expects a
  loading beat anyway.
- **`map_init` is no longer sent at join.** It is sent when the match starts, to everyone
  seated at that moment. `docs/40` §3's ordering — `welcome`, then `map_init` — holds
  within a match; it is simply later.

**This overrides `docs/72` §C18** where §C18 says a `Lobby` room "holds a map, a roster
and a code". It holds a roster, a code and its settings. It does not hold a map.

§C18's actual principle — *no battle exists until players ask for one* — is unchanged and
is strengthened: now not even the map exists.

### E1.1 — The seat is the identity, and the world is built from it

Today a joining player's identity lands on the world: `Command::Join` calls
`world.add_player(id, skin_id, name)`, `roster()` reads skin, tombstone skin and score
back off `world.players`, and `Seats` holds only a name and a ready flag. With no world in
`Lobby` there is nowhere to put a skin.

> **`Seats` is the single source of seat identity** — seat id, name, skin, tombstone skin,
> ready, bot. The world's player list is **created from** `Seats` at match start.

Everything else is derived from it and nothing is maintained in parallel. `CLAUDE.md`:
*derive, do not add a fourth flag — three flags can disagree.* Three rosters on one wire
is the same bug with a different spelling.

`tick` and `round_time` are the **room's**, not the world's. A lobby's `tick` advances
(`docs/72` §C18-clarified) and its `round_time` is zero. Whatever carried them off the
world needs another source, and that source is the room.

### E1.2 — A replay is a room's life, not a round

One clock, and it is the room's. The world **continues** the lobby's tick count rather
than restarting at zero, because a clock that goes backwards at match start makes every
command stamp and every checkpoint ambiguous the moment a lobby lasts longer than a tick.

It follows that **a replay records the lobby too**. That is not incidental: the joins
that happened in the lobby are part of what happened, and a replay that skips them
rebuilds an empty roster — measured, it seated the human after the bots and diverged at
tick 600. Ordering is content.

> **A replay file is the life of a room, not the duration of a round.** Its tick count is
> not a round length and never was safe to read as one.

The cost is a bare increment per idle tick — a ten-minute lobby is 36,000 of them.
`ReplayHeader` carries no tick count, so nothing downstream misreads the longer file.

## E2 — Public lobbies

**Quick Game joins the open public lobby, or makes one.** There is still no queue, and
`docs/71` §B10 was right that a queue is worse than a room list — but the selection rule
changes, because "fullest room with space" was written when rooms were matches.

| | rule |
|---|---|
| pick | the **fullest public lobby in `Lobby` phase** with a free seat |
| tie | lowest room id, as today (`registry.rs` `order`) |
| none | create one |
| never | a lobby whose match has started (§E4), or a private lobby |

**Fill to `LOBBY_CAPACITY`, then start.** When the fifth player is seated the match starts
immediately — no countdown, because everybody who is coming has arrived.

**The bot timeout.** From the moment the **first** player is seated, a public lobby runs a
`LOBBY_BOT_TIMEOUT` clock. When it expires the empty seats are filled with bots and the
match starts. The clock does not reset when someone joins: a player who has waited ten
seconds is not made to wait twenty because a second player arrived.

`MIN_PLAYERS_TO_START` is retired for public lobbies. One human plus four bots after ten
seconds is a game; two humans and an infinite wait is not. **This overrides `docs/72`
§C18's raising of `MIN_PLAYERS_TO_START` to 2**, and retires `LOBBY_COUNTDOWN`.

## E3 — Private lobbies

**Host or join.** Hosting mints a code (`JOIN_CODE_LEN`, `JOIN_CODE_ALPHABET` — unchanged)
and opens an empty private lobby. Joining takes a code.

- **No timeout, ever.** A private lobby waits as long as its players do.
- **Everyone must be ready.** The match starts when every seated human has set ready and
  there is at least one of them. Ready is a toggle; it clears when the settings change,
  because a player agreed to the game they were shown.
- **The host owns the settings.** Map size only, for now, and it may be changed at any
  time before the start.
- **There is no host after the host leaves.** The lobby does not close; the code stays
  valid; settings ownership passes to the longest-seated remaining human. A lobby dies
  when it is empty (§E5) and for no other reason.
- **Bots are opt-in**, through the existing `start_with_bots` verb, which becomes the
  manual form of §E2's timeout rather than a separate mechanism.

## E4 — A live match is closed

**Once a match has started, nobody new is seated.** A join attempt against a room whose
phase is past `Lobby` is refused with `join_error { reason: "in_progress" }`, and quick
match skips such rooms rather than seating into them.

**This overrides `docs/41` §4**, which allowed joining mid-round and specified the
damaged-map catch-up for it. The catch-up code is not deleted — a player who *drops* and
reconnects to a match they were already seated in still needs it, and that is the seam
this leaves open deliberately.

Rationale, stated so it is not re-litigated: a five-slot deathmatch that fills in ten
seconds has no need for a joiner who arrives to a map already half dug out, with no
weapons and everyone else armed.

## E5 — A lobby or a match dies when its humans leave

**Bots are not occupants.** The reaper (`registry.rs` `reap`, `ROOM_EMPTY_TTL`) counts
humans only. A room with five bots and no humans is empty and is reaped.

That single rule serves both cases the coordinator named:

- A lobby everybody left closes.
- A match everybody left closes, however many bots are still fighting in it.
- **A test driving one real client can watch five bots for as long as it stays
  connected**, because it is the human holding the room open.

`MAX_PLAYERS` (6) remains the hard seat cap. `LOBBY_CAPACITY` (5) is the *fill target* —
what a lobby shows and what §E2 fills to. A development override may seat bots up to
`MAX_PLAYERS`, so `BOT_COUNT=5` alongside one human is a full six-seat game and needs no
new concept.

## E6 — The lobby on the wire

One new server→client message, replacing the dead `room_list` that nothing subscribes to
(`docs/71` §B14 found `room_created` in the same state; this is that finding's twin).

**`lobby_state`** — sent to every seated socket whenever the lobby changes: a player
joins or leaves, someone readies, the settings change, or the bot timeout ticks a whole
second.

| field | meaning |
|---|---|
| `code` | the join code, or absent for a public lobby |
| `private` | bool |
| `capacity` | `LOBBY_CAPACITY` |
| `scale` | the map size the match will use |
| `settings_owner` | seat id of the player who may change settings, or absent |
| `starts_in` | seconds until the bot timeout fires; absent when there is no timeout |
| `players` | `[{ seat, name, skin_id, ready, bot }]` |

Client→server verbs: `ready { on: bool }` (existing, meaning tightened), and
`set_scale { scale }` (new, refused unless the sender is `settings_owner`).

`room_list` is deleted. It has never had a subscriber.

**`welcome` loses `scale` and `players`.** Both are now said better by `lobby_state`, and
keeping them would put two sources of truth on one wire — `welcome.scale` is *provisional*
the moment §E3 lets a host change it, and the client currently reads that stale copy.
`welcome` keeps what is true at the instant of seating and never changes afterwards: who
you are, which room, and its capacity. This is the `room_list` finding (`docs/71` §B14)
applied to the message replacing it, before it can bite rather than after.

**The client is not in `GameScene` while any of this is happening.** The lobby is a menu
screen holding the socket; `map_init` is what moves it to the game.

## E7 — The front end

**The game is called SHRED.** The title is set in a display face chosen for it, not the
body font, and the tagline is removed.

**The menu is two buttons and a settings row.**

```
            SHRED

     [ Quick Game ]
     [ Private Game ]         →  [ Host ]  [ Join ]
     [ Skins ]

     Map size    ‹  SMALL  ›
```

- **Quick Game** — straight into a public lobby (§E2), no options. Quick matches
  **randomise** their settings, so the stepper does not apply to them.
- **Private Game** — then Host or Join. Host opens a lobby and shows the code; Join asks
  for one.
- **Map size is a stepper, not three buttons.** `‹ SMALL ›`, wrapping through the
  `MapScale::ALL` order, starting at Small. It is the first of a settings row that will
  grow, so it is built as a row of settings rather than as one control.

## E8 — What this deliberately does not add

- **No Redis, and no second process.** The registry already *is* the lobby directory:
  rooms, codes, insertion order, a TTL reaper. Redis buys one thing — a directory shared
  across processes — and `docs/62` §7 puts a router with sticky sessions *before* it.
  Adding a store with no second reader is a mechanism wired to nothing, which is a
  failure this project has recorded twelve times. **What flips this:** wanting lobbies to
  survive a restart, or wanting a second server. Neither is asked for.
- **No accounts, no persistence, no lobby browser.** You take the lobby quick match gives
  you, or you use a code.
- **No spectating.** A player is seated or is not.
- **No rejoining a live match you were never in** (§E4). Reconnecting to one you *were*
  in is left open and unimplemented.

---

# Part two — M18, UI and defects

## E9 — The title screen does not run the game

`TitleScene` runs a real `World` with real bots through `AttractCore`, at
`ATTRACT_HZ` 20 while advancing `SIM_DT` (1/60) per step — so the simulation runs at
**one third of real time**. `WARMUP_SECONDS` is 10 *simulated* seconds, which arrives at
about **30 seconds of wall clock**, and at that instant damage un-gates, the weather
scheduler starts, item spawns start and teleports start, all together. At 45 s the scene
tears the world down and rebuilds it from inside `update()`; if that throws, the DOM is
already removed, so there is no button, and a throw inside `update()` stops Phaser's
frame loop, so nothing can be clicked afterwards either.

> **The title screen must not run the simulation.** It draws a decorative background that
> needs no `World`, no WASM core and no server, and it must not be able to take the menu
> down with it.

What it draws is not specified here beyond: seeded, cheap, and self-contained. The
requirement is that the menu keeps working — for as long as anyone leaves it open.

`AttractCore` and `Core.attract()` are not deleted; they lose their only caller and that
is recorded rather than hidden.

## E10 — Bots that explore, arm themselves and run

Today (`bots/mod.rs:381`) a bot picks the nearest enemy in FOV, else the nearest item by
straight-line distance, else `Wander` — a branch its own comment calls near-dead. It has
no path, no map awareness beyond a line-of-sight test, and **no retreat**: at low health
it uses a medkit if it has one and keeps closing.

Four changes:

- **Explore.** A bot with no target moves toward parts of the map it has not seen, rather
  than to a random spawn point. Coverage is per-bot and coarse — a grid of visited cells
  is enough; this is not pathfinding.
- **Arm yourself first.** An unarmed or poorly-armed bot prefers weapons over engagement.
  The existing `choose_weapon` scoring stands; what changes is that *acquiring* one
  outranks chasing.
- **Retreat.** Below `BOT_FLEE_HEALTH`, a bot breaks contact — moves away from the
  nearest enemy, and prefers cover and distance over a heal it does not have. It may
  return once healed.
- **Reachability.** An item behind a wall is not a target. The straight-line item choice
  gets the same line-of-sight test the enemy choice already has.

Everything stays inside `game-core` and stays deterministic: seeded RNG only, no wall
clock, no ambient randomness.

## E11 — Clouds are bigger and vary in brightness

**They are also drawn at the wrong size today** — but not in the direction this section
first assumed. `parallax.ts` sets a display size and then calls `setScale` on the same
sprite, which overrides it, so a cloud draws at its **native atlas frame** scaled while
the wrap-twin's `halfW` still assumes `CLOUD_TEX_W`. Measured: 120 frames, width min 33 /
median 104 / max 288 against a `CLOUD_TEX_W` of 220.

### E11.1 — The frame is authoritative, not the constant

Forcing `CLOUD_TEX_W` would not be a fix. It is a **per-cloud change spanning 8.7×** —
0.76× for the widest frame, 6.67× for the narrowest — and it is **lossy**: the pack ships
8 shapes × **5 sizes**, seeded per cloud, and those five variants are the only thing
making a small cloud small. Flattening every frame to one width leaves `CLOUD_SCALE_MIN..MAX`
as the sole source of variety, a 2.3× spread replacing an 8.7× one. That discards art
that T16.04 deliberately selected.

> **The drawn frame is the authority for a sprite cloud's size, and `halfW` must be
> derived from it.** `CLOUD_TEX_W` / `CLOUD_TEX_H` remain the *procedural blob's* size —
> they describe the fallback, not the sprite path.

So the bug is `halfW`: a **6.7× error in the wrap offset** for the narrowest frames, which
is why the seam is wrong today in both directions. And `parallax.ts:369-370`'s claim that
the sprites are drawn at *"the same `CLOUD_TEX_W x CLOUD_TEX_H * scale` the procedural blob
was, so `halfW`, the wrap and the parallax below are bit-for-bit T15.03's"* is **false**,
and it reassures a reader checking exactly the thing that is broken.

The asymmetry that makes the override always win is worth recording: `setDisplaySize` runs
**only on a colour-set change**, `setScale` runs **every frame**.

With the frame authoritative, §E15's `CLOUD_SCALE_MIN`/`MAX` change is what "about 30%
bigger" means, and it applies on top of the frame's own size — which is what the section
intended before the measurement.

- **About 30% bigger**, expressed as a change to `CLOUD_SCALE_MIN` / `CLOUD_SCALE_MAX`.
- **Per-cloud brightness.** Every cloud in the sky is currently the same colour set at the
  same flat alpha. Each cloud gets its own brightness and alpha, seeded from the map seed,
  within a band — some darker, some lighter, so the sky has depth.
- `CLOUD_SKY_MIX` and `CLOUD_ALPHA_FLOOR` are dead on the atlas path and either regain a
  caller or are deleted. Do not leave them as constants nothing reads.

## E12 — Rocks and bushes sit on the ground

**50% bigger**: `OBJECT_TARGET_PLAYER_H_ROCK` and `OBJECT_TARGET_PLAYER_H_BUSH` rise by
half. Crystals and ruins are unchanged.

**And they must not float.** `surface_anchor` picks one column and tests
`is_standable`, which examines a player-width box at that column only. A sprite far wider
than a player, placed on a peak or a slope, has its centre supported and its outer base
columns over air — which is exactly the mid-air look being reported, and it gets worse
with a bigger sprite.

> **Anchor on the sprite's own footprint, not on a player-sized box.** A candidate site is
> only usable if the terrain under the object's base is solid across enough of the
> object's width; and the object is seated so that its base meets that terrain rather than
> hanging above it.

Partial burial into a slope is correct and desirable. Hanging in air is not.

## E13 — Toxic rain poisons on hit

Toxic rain currently lands as **puddles** — a circle on the ground that hurts anything
standing in it for `TOXIC_PUDDLE_LIFE` seconds. In practice nobody has ever seen one.

> **Puddles are removed. A toxic drop is a projectile, and what it hits, it poisons.**

Modelled on the meteor, which is the same shape of thing:

- **On hitting a player**: poison for `TOXIC_POISON_DURATION`, dealing
  `TOXIC_POISON_DPS`. A second hit **resets the timer**; it does not stack.
- **A roof protects you.** A drop must not reach a player with solid terrain above them —
  the same reasoning the meteor shower needs and, as it turns out, also does not have.
  Both get it.
- **On hitting terrain**: a small carve, the size a bullet makes, not a meteor's crater.
- **The health bar goes green** for the duration, using the existing `healthBar` colour
  path. This is the first per-player status the UI has shown; there is no per-player
  status field on `PlayerState` today, and one is needed.

The scheduler, the telegraph and the rain visuals are unchanged.

## E14 — Inventory tiles show the item

An inventory tile renders `tile.textContent = tileLabel(slot)` — the registry key as a
string, wrapped in a 46 px box. The same item on the map is a sprite: an atlas frame if
one exists, else a procedural 16×16 canvas from `itemTextures.ts`, keyed on
`ItemDef.sprite`.

> **The tile draws the same art the world draws**, resolved through the same key, with the
> same fallback order. The text stays only where art cannot be resolved at all.

`SlotView` carries `slot`, `key` and `count` and will need the sprite key too.

---

## E15 — Constants

New:

| Name | Value | Notes |
|---|---|---|
| `LOBBY_CAPACITY` | 5 | fill target; `MAX_PLAYERS` 6 is still the seat cap (§E5). Lands in T17.02 — §E6's `capacity` field needs it |
| `LOBBY_BOT_TIMEOUT` | 10.0 | public only, from the first seating, does not reset (§E2). Lands in T17.02 — §E6's `starts_in` and its throttle test cannot exist without it; T17.03 supplies what happens at zero |
| `BOT_FLEE_HEALTH` | 35 | break contact below this (§E10) |
| `BOT_EXPLORE_CELL` | 256 | coverage grid, map pixels (§E10) |
| `TOXIC_POISON_DURATION` | 3.0 | seconds, resets on re-hit (§E13) |
| `TOXIC_POISON_DPS` | 2.0 | health per second (§E13) |
| `TOXIC_DROP_CARVE_R` | 6 | bullet-sized (§E13) |
| `CLOUD_BRIGHT_MIN` / `_MAX` | per T18.03's measurement | the band §E11 asks for and did not name. The top is **1.0**: a tint cannot brighten past the art's own white, so the variation is a range of *shadow* |
| `CLOUD_ALPHA_MIN` / `_MAX` | per T18.03's measurement | as above |

Changed:

| Name | From | To | Notes |
|---|---|---|---|
| `OBJECT_TARGET_PLAYER_H_ROCK` | 1.5 | 2.25 | +50% (§E12) |
| `OBJECT_TARGET_PLAYER_H_BUSH` | 1.0 | 1.5 | +50% (§E12) |
| `CLOUD_SCALE_MIN` | 0.42 | 0.55 | ≈ +30% (§E11) |
| `CLOUD_SCALE_MAX` | 0.95 | 1.24 | ≈ +30% (§E11) |

Retired:

| Name | Why |
|---|---|
| `LOBBY_COUNTDOWN` | there is no countdown; there is a fill rule and a timeout (§E2) |
| `MIN_PLAYERS_TO_START` | retired for public lobbies (§E2); private uses ready (§E3) |
| `TOXIC_PUDDLE_EVERY` | puddles are gone (§E13) |
| `TOXIC_PUDDLE_RADIUS` | " |
| `TOXIC_PUDDLE_LIFE` | " |
| `TOXIC_DPS` | replaced by `TOXIC_POISON_DPS` (§E13) |

§E11 asked for per-cloud brightness "within a band" and named no band; the four constants
above close that gap. All four draws are taken for **every** cloud in a fixed order, so
adding them cannot shift the shape and size picks that precede them — a conditional draw
would have moved every seed's sky.

`OBJECT_TARGET_PLAYER_H_ROCK` at 2.25 makes a mean rock 63 px against a 28 px player.
`docs/73` §D5's counts were measured at the old sizes and the 999-seed sweep is what
decides whether they still hold — a bigger object eats more of `OBJECT_PIXEL_BUDGET`, so
expect fewer objects per map, and if traversability degrades that is a finding and not a
threshold to lower.
