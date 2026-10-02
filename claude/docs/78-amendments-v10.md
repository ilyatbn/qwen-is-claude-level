# 78 — Amendments v10: M23 (the art refactor) and the owner's 2026-09-30 asks

Written by the coordinator (authorised 2026-09-08). Overrides are named where they happen. **Still owed here** from
M23's journals (T23.19D, T23.14D, T23.10): `THRUSTER_PLUME_*` removal, `use_seq` on fire/quick_throw, zoom 1 with
sight 640/220, `BOT_ENGAGE_RANGE`, rulings R24–R27. Those sections are added as the milestone closes; the two below
are needed now because tasks are built against them.

## A1 — Spectating (overrides `docs/74` §E8, "No spectating")

**Owner, 2026-09-30:** *"simulate a game with bots only … let me switch the camera between them (like a spectate
mode) with tab."*

- A client may join **as a spectator**: it holds a seat (so it receives what a player receives) but **has no body**
  — it is not in the world, does not count toward the room's player cap or a round's outcome, and its inputs and
  commands do nothing.
- A room whose only non-bot seats are spectators is **watched**: it starts with bots as a lobby does, and when a round
  ends it **restarts on its own** — there is nobody to vote, and a watched room exists to keep playing.
- `docs/74` §E4 (no joining a live match) is **unchanged for players**; a spectator may join at any time, since it
  changes nothing in the match.
- The spectator chooses whom to watch; **Tab / Shift+Tab** step through the living players. Tab keeps the scoreboard
  in a normal match.
- Replays record a spectator's join distinctly, so a recorded watched match replays identically.
Task: `T23.27`.

## A2 — Bots route through the terrain (overrides `docs/74` §E10's "this is not pathfinding" and "an item behind a wall is not a target")

**Owner, 2026-09-30:** *"they lack terrain awareness. they get stuck on high walls and in caves … aware they can
jetpack above them or through open space … know that they can dig if there's an easier or faster way through a map,
or to hide from incoming players or meteors."*

- Bots **plan routes**: walking, hopping, falling, jetpacking (within what the tank allows) and **digging**, each
  priced in seconds from the movement and tool constants. Exploration's coverage grid (§E10) still chooses *where* to
  explore; the route decides *how to get there*.
- **Reachability is a route, not a line of sight.** An item or enemy behind rock is a target when a route to it —
  digging included — costs less than a bound; a line of sight is still required to *shoot*.
- **Cover.** ~~A bot takes cover under rock from an announced or falling meteor shower~~ (struck 2026-10-01, see
  §A3), and a hurt bot breaks contact
  toward cover (digging in if none is near) rather than only away; it re-engages once healed. §E10's retreat stands
  where no cover is reachable. Frenzied bots (`DEV_BOT_FRENZY`) never take cover.
- Unchanged: everything in `game-core`, deterministic, seeded; the search's per-tick work is bounded by a **count**,
  never by a clock.
Task: `T23.26`.

## A3 — Bots dodge meteors on the move; the jetpack is a tank (narrows §A2)

**Owner, 2026-10-01:** *"if you taught them to hide i dont like it they should still be moving and attempting to dodge
meteors (not always succeeding) … they should know to wait to recharge it a bit or go a different direction or give up
and maybe find a teleport to use."*

- During a meteor shower a bot **keeps its goal** and steers away from predicted impacts, with a skill-scaled lag so
  some are hit. It does not hide or dig in because of a shower.
- A bot never presses the jetpack for a climb its tank cannot finish: it waits on safe ground to refuel, takes
  another route, or gives the goal up. **Teleport gates are routes** a bot may take.
- A bot with wings hunts and shops with them; hovering without a goal is a defect.
Task: `T23.26C`.

## A4 — A round starts when everyone has it loaded (extends `docs/40`'s events)

**Owner, 2026-10-01:** *"it should first load fully, and only then the players should see it and the round should start."*

- A restart sends **`new_round`** (new wire event, added to `docs/40`'s list by this section), then the map, every
  seat's inventory, the ground items and the bots — the same as a first round. Clients drop every per-round thing on
  `new_round`.
- Every seat's `ready` is cleared when a map goes out; the room does not step (no clock, no movement, no bots) until
  **every seated body** is ready, bounded by `READY_TIMEOUT`. Spectators never hold a round. Clients load behind a
  cover and lift it when the round starts.
- A respawn sends the player's inventory.
Task: `T23.28`.

## A5 — Map shapes (a lobby setting)

**Owner, 2026-10-01:** *"change the map generator to have map shapes. the current map generator is fine but i want to
make it more diverse and also simpler for bots to play. lets call the current one "random"."* Reference silhouettes:
`tasks/M23/map-shapes/*.png` (black = rock, grey = open space). Every shape is still generated per seed.

A lobby setting **map shape**, beside gravity, for standard and low gravity (space keeps its own map):
- **Random** — today's generator, unchanged (its golden tables must not move). The default.
- **Hill** — less random: mostly flat ground with a few hills of varying size; still some floating islands.
- **Mostly flat** — an almost flat ground (gentle undulation only); items, objects and islands as usual.
- **Multilevel** — two levels, each a hilly-or-flat ground: an upper band of rock with sky above it, an open gap below
  it, and a lower ground. **No islands.** Teleport pads are **paired across levels**: a pad on the bottom always sends
  you to the top, and a top pad to the bottom. Players may also dig between levels. **Meteor showers hit the top level
  only**; the **bottom level gets drifting toxic clouds** instead (the existing toxic hazard, passing through).
- **Islands** — no ground: only floating islands, high in the clouds; fall off and you die. **No meteor showers** on
  this shape (the owner will choose a replacement). It **looks** high up: a sea of cloud below the islands, the sky
  around and beneath them.
The shape is in `MapMeta`, `map_init` and the replay header; every client and bot reads it from there.
Task: `T23.30`.

## A6 — Bots seek open ground and each other (sharpens §A2–§A3)

**Owner, 2026-10-01:** *"lets make them stop shoveling … their top priority is to find as much open ground and each
other. make them even more open space aware by calculating the best path to places outside of caves so they find each
other better and battle more."*
- A bot's standing priority is **open ground and finding enemies**: exploration and routing aim at open, sky-exposed
  ground, and a bot in a cave or enclosed pocket routes **out** to it.
- **Melee is a last resort**: a bot with no ranged weapon goes to get one (or avoids close fights) rather than closing to
  swing; it swings only when cornered at point blank or when no ranged weapon exists anywhere it can reach.
- Digging is for when no open route exists (§A2), never a fighting style.
Task: `T23.26F`.

## A7 — World looks: classic and volcanic, picked at random per map (overrides `M23-art.md` R5 for this purpose)

**Owner, 2026-10-02:** *"do the volcanic textures … it should alternate between current and volcanic at random on map
load. might add some more setups later so keep it open."* References: `tasks/M23/reference/F2-volcanic-night.png` (the
in-game look), `mapideas/volcanic.jpg` and `mapideas/volcanic2.jpg` (the background idea and the small alien creatures).

- A **world look** is chosen per map, at random from the map's seed (so every client and a replay agree), and carried
  in `MapMeta` / `map_init`. Looks are an **open list**: `Classic` (today's F1/F5 look) and `Volcanic` now; adding one
  later is adding an entry, not a new mechanism.
- A look is **render-only plus fauna**: palettes for the day/night blend (T23.11), terrain albedo/cracks, sky and
  background layers, fog/haze colour, ambient particles, and which animals live there. It never changes collision,
  the mask, objects' shapes or anything the simulation reads — R5's rule that the theme must not stamp collision holds.
- **Volcanic**: F2's palette — near-black rock with glowing lava cracks, red-orange haze, drifting embers; a background
  of a smoking volcano with lava rivers and ash cloud, ringed planets in a dark sky, red mist at the horizon
  (`mapideas/`); its animals are small alien creatures in the style of the references — a three-legged tripod walker
  and an octopus-like crawler — drawn as ink silhouettes like the stick figures.
Task: `T23.31`.

## A8 — A look may choose its disasters (narrows §A7's "render-only")

**Owner, 2026-10-02 (parked):** volcanic maps replace heavy fog with **volcanic ash** (a passing dark cloud that blinds
those inside it) and meteor showers with **lava bursts** (meteor mechanics, lava rocks that set fire instead of
exploding), with the background volcano erupting as the warning.
- §A7's "a look is render-only" holds for terrain, collision and objects. A look **may** swap which environmental
  effects the scheduler rolls; the server already knows the look (it picks it from the seed), so the simulation stays
  deterministic and every client agrees.
Task: `tasks/parking-lot/T23.33-volcanic-disasters.md` (after `T23.31`).
