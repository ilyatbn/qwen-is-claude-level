# M23 — Alien invasion: the first team match (parked)

> **Renumbered M22 → M23 on 2026-09-18.** The owner asked for the space work to be M22 and
> this file already held that number, parked and unscheduled since 2026-09-15. Nothing depends
> on the old number: it is not in `TASKS.md`, no task cites it, and `grep -rn "M22" tasks/ docs/`
> found only this file and the parking README. Renumbering the parked one was therefore the
> cheaper of the two moves. **The content below is unchanged.**

**Parked on arrival** (owner, 2026-09-15): specified here so picking it up costs nothing, not
scheduled. Nothing below is in `TASKS.md`'s build order; `tasks/parking-lot/README.md` lists it.

## The ask, verbatim

> "alien invasion match" special random event (happens once in a while at the start of the
> match, completely random, say one in 20 games, but can be enabled as a game mode same as no
> gravity) where you start the match and there's a popup message: "you must now work together
> to protect the earth". the whole game aliens drop from the sky constantly. they kill all
> players (which are now in a team) while also having a primary goal. the core of the map has
> a beating heart (lower level of the map, in the center). if the aliens manage to shoot or dig
> their way to it, the team loses. … teams are important for the future anyway since we will
> have team vs team later on.

## What exists today, and what does not (surveyed 2026-09-15, read-only)

| needed | today |
|---|---|
| a match mode chosen like "no gravity" | **No gravity is not built** — its specs are `tasks/M22/` since 2026-09-18 (they were
`T21.05`–`T21.07`, parked). What *is* built is the private-lobby settings path (`room.rs` `Command::SetScale / SetBots / SetStartKit / SetRoundSeconds`: host-only, `ReplayCommand` tags, `lobby_state`, a row in `client/src/net/lobby.ts`). Invasion is **a new setting on that path**, which is the path no-gravity was specified to use too |
| a 1-in-20 random roll | the seeded-roll pattern exists: `rng::substream(seed, tag)`, e.g. `meta.rs::theme_for`. A new `"invasion"` tag |
| teams | **none** — no team, ally or friendly-fire concept anywhere (core, server, wire, scoreboard). Self-damage is deliberate (`explode.rs`, `melee.rs`) |
| a team loss | **round end is time only**: `World::step` calls `set_phase(Ended)` at `phase_time_left() <= 0`. A heart loss is a second trigger at the same place |
| aliens | **no hostile non-player entity.** Bots are players producing an `Input` (`bots/mod.rs`). **Animals** (`world/animals.rs`) are the template: real `Body` through `physics::resolve::integrate`, health, `apply_damage`, hashed, `AnimalSpawn/Move/Despawn` events — but **no damage path from an animal to a player exists** |
| things falling from the sky | crates (`SpawnSchedule::tick_crates`), meteors (`MeteorShower::tick`, owner `u8::MAX` into the shared projectile pool), toxic drops |
| a structure with health | **none.** Pads and gun platforms are indestructible with no HP (`TeleportPad::rect` / `GunPlatform::rect` are clipped out of every carve) |
| the popup | the banner only knows weather effects (`effect_start` → `hud.ts::bannerText`). **No free-text announcement exists** |

## Rules that bind every task here

- **Teams first, invasion second.** The owner named team-vs-team as the future; a team concept
  bolted onto the invasion ("aliens vs everyone") would have to be torn out for it. `Team` is a
  general property of a player; invasion is its first user.
- **The heart is simulation, not decoration.** Where it is, how much it can take and what
  reaches it decide who wins. Its picture is the client's; its health and its loss are
  `game-core`'s.
- **Every new world field goes in `World::state_hash`, and the mode goes in the replay header**
  — a round replayed without knowing it was an invasion diverges silently. Expect
  `REPLAY_VERSION` to move (T22.01 and T22.02 at least; batch them if they land together).
- **Measure balance before choosing numbers.** "Aliens drop constantly" with no cap is a
  bandwidth problem before it is a gameplay one (`FLAME_MAX_LIVE` exists for the same reason).
  Every rate is a constant with a measured basis, not a guess.
- **The popup is not a gameplay rule and must not be the only signal.** A player who closes it,
  or joins mid-round, still needs to know: banner, HUD heart bar, results screen.

## The split (nine tasks, in order)

Each is roughly one file and ~250 lines; the first three are useful even if invasion is never
finished.

1. **T22.01 — Teams in the simulation.** `PlayerState` gains a team (derived at seat time, not
   stored as a fourth flag beside existing state); the damage path refuses same-team damage
   except to yourself (the self-damage rule stays); kill credit and scoring learn teams;
   scoreboard and results group by team. Wire: a team byte on the roster, not per snapshot.
   Deathmatch = every player alone, so **nothing a player sees today changes** — that is the
   test. Foundation for team-vs-team.
2. **T22.02 — The match mode, and the roll.** `MatchMode { Deathmatch, Invasion }` as the next
   setting on the lobby settings path (host-only in private rooms, replay tag, header field,
   lobby row). Public rooms roll it at match start on the `"invasion"` sub-stream against
   `INVASION_ODDS` (20). Invasion seats every human and bot on one team. **Open question for
   the owner:** does a private room also roll when its host has left the setting on
   "Deathmatch", or only public rooms?
3. **T22.03 — The heart.** Placed at the horizontal centre, `HEART_DEPTH` above `FLOOR_CRUST`,
   on its own sub-stream so it cannot move a pad, platform or spawn; a cavity carved around it
   at generation so it is *reachable* by digging (the brief says aliens dig to it — so it must
   **not** be clipped out of carves the way pads are). `Heart { pos, health }` in `World`,
   hashed; `HitId::Heart` so shots and blasts that reach it damage it. Golden masks move —
   regenerate with the seed sweep, never nudge. Absent in deathmatch.
4. **T22.04 — Aliens: the body.** `world/aliens.rs` on the animals template: spawn from the sky
   band on a ramping `ALIEN_DROP_INTERVAL` schedule, capped at `ALIEN_MAX_LIVE`; fall, land,
   walk; health; `HitId::Alien` so every weapon hurts them; `AlienSpawn/Move/Despawn` events;
   hashed. No brain yet — they walk toward the heart's column.
5. **T22.05 — Aliens: the brain, the gun and the shovel.** A pure `think` that picks a target —
   the nearest player inside `ALIEN_AGGRO_RADIUS`, else the heart — and acts: fires through
   `Projectiles::spawn_raw` with a non-player owner (the meteor precedent), and digs toward the
   heart with `carve_circle` at `ALIEN_DIG_RATE`. **This is the first thing in the game that
   damages a player without being a player**: kill feed, death cause text (`deathOverlay`) and
   scoring all need an "alien" cause, or a death reads as "killed by nobody".
6. **T22.06 — Winning and losing.** Heart health 0 → `set_phase(Ended)` with a team-loss
   outcome; the timer running out → the team wins. `RoundOutcome` carries it; the results
   screen says "Earth saved" / "Earth lost". **Respawns stay as today** unless the owner rules
   otherwise — ask before inventing a lives system.
7. **T22.07 — The client: popup, aliens, beating heart.** A new announcement event (not a fake
   weather effect) shows "You must now work together to protect the earth" at match start and to
   mid-round joiners; alien drawing; a heart that pulses in time with a beat and quickens as
   its health falls; HUD heart bar; minimap heart marker. Pixel checks for each, with controls.
8. **T22.08 — Bots join the team.** Bot target selection filters by team, and in invasion bots
   hunt aliens and fall back toward the heart when aliens are digging. Without this, bots in an
   invasion shoot their own team or stand idle.
9. **T22.09 — Balance, measured.** Across seeds and player counts (1 human + bots, 4, 8): how
   long the heart lasts, how many aliens are live, bandwidth per second. Tune the constants
   against those numbers and record the basis beside each constant. A mode where the heart
   always falls in 40 s, or never falls, is not a mode.

## Questions the owner should rule on before T22.02 starts

- Does the 1-in-20 roll apply to private rooms, or only public matchmaking?
- Do players respawn normally during an invasion, or is there a shared lives pool?
- Does score still exist in an invasion (kills of aliens), or only the team result?
- Can the team damage the heart themselves (a stray rocket)? The simple answer — yes, the heart
  is simulation and a rocket is a rocket — makes griefing possible in public rooms.

## Done when (for the milestone)

A public match can roll an invasion; a private host can pick it; everyone is one team; the
popup, heart bar and results say so; aliens drop, fight and dig; the heart falling ends the
round as a loss and the clock running out ends it as a win; bots fight aliens, not each other;
and the balance numbers are recorded against the constants they chose.
