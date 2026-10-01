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
