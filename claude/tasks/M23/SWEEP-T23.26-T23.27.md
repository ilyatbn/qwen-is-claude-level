# Forward sweep — T23.27 (spectate) and T23.26 (terrain-aware bots)

Code-only, 2026-09-30, at HEAD `4c8fac6`. Every claim below was read at the symbol cited. Nothing was run.

**Build order: T23.27 first, then T23.26 A → D.** T23.26's Done-when needs T23.27's watch mode, and T23.27 is
smaller. It also contains the one spec conflict that needs a coordinator amendment before code (S0).

---

## S0 — Two spec conflicts to amend before either is built (the coordinator's job)

- **`docs/74` §E8: "No spectating. A player is seated or is not."** T23.27 overrides it. It needs a `docs/7N`
  amendment naming §E8 (and saying §E4, "no joining a live match", still holds for spectators, or does not).
- **`docs/74` §E10: "a grid of visited cells is enough; this is not pathfinding"**, plus "Reachability. An item
  behind a wall is not a target." T23.26 is pathfinding, and makes an item behind a thin wall a dig route. The test
  `bots/mod.rs::an_item_behind_solid_rock_is_not_a_target` pins the old rule and will go red, or will have to be
  rewritten, under T23.26 A+B. Amend §E10 first so the builder has authority to change that test.

---

## T23.27 — spectate

### What will contradict the deliverable, server side

1. **A spectator Seat eats a bot seat, and in a full room kicks a bot.** `room.rs::Room::apply` `Command::Join` calls
   `seats.alloc(config.max_players)`, and on `None` calls `kick_newest_bot()`. `Seats::alloc` caps on
   `seats.len()`, bots included. `seat_bots` allocates bots from the same pool. So `make watch`'s "BOT_COUNT=6 (full
   room)" gives **5 bots** if the spectator is a normal Seat. **Seam:** keep the spectator in `Seats` (it needs a
   `PlayerId` for `SessionMap::sid_of`, and `last_seqs` is what drives `events.rs::broadcast_snapshot`), with
   `spectator: bool`, and make `alloc`'s cap count `!spectator` seats only. The id pool (`u8`) is shared, and that
   is fine.
2. **`populate_world` adds every non-bot seat to the world** (`.filter(|s| !s.bot)`). So does the in-match branch of
   `Command::Join` (`world.add_player(id, …)`, plus `grant_dev_loadout`, `grant_start_kit` and `apply_dev_battery`).
   Both need `&& !s.spectator`. **Do not derive this from a second flag.** One `Seat.spectator` bool, read by one
   helper `Seat::has_body()` (`!bot`-agnostic: bots have bodies too), used at both sites. That follows the
   share-the-guard rule.
3. **`human_count()` has three readers that disagree on what a spectator is.** `tick_once` uses it for the lobby's
   `full` (`LOBBY_CAPACITY`) and `everyone_ready` (private), and `round.tick(world, humans, dt)` uses it for the
   restart vote. Decide per reader:
   - `full`: exclude spectators, or a spectator plus 4 humans starts "full".
   - `everyone_ready`: exclude them. `all()` over no humans is true, which is guarded by `humans > 0`.
   - the vote: see item 4.
4. **`make watch` stops after one round.** At `Ended`, `round.rs::restart_wins(humans)` needs `humans > 0 && yes ==
   humans`. With spectators excluded, humans = 0, so `ToLobby`. `return_to_lobby` clears the bots and the world but
   **never re-arms `starts_in`**. `grep -n "starts_in = " room.rs` gives 3 writers: `Join` (the only arming),
   `tick_once`'s countdown, and the start. So a lobby holding only a spectator sits there forever. If spectators
   count as humans instead, the spectator has to vote. **Decide one:** (a) a room whose seated non-bots are all
   spectators restarts at window close (`RoundOutcome::Restart`), or (b) `return_to_lobby` re-arms `starts_in` when
   the room is public. (a) is what "watch" means. Test: a spectator-only room reaches a second `Playing`.
5. **Replay divergence.** `replay.rs::ReplayCommand::Join { name, skin_id }` has no spectate bit, and
   `room.rs::to_command` rebuilds a plain `Command::Join`. A recorded watch session replays with the spectator given
   a body, which changes spawns and physics and breaks `state_hash` from tick 1. **`replay.rs` is not in T23.27's
   Touch only; add it.** This needs a new tag, or a flag on `Join` that keeps old recordings readable (the file's
   rule, as `Unready` got its own tag).
6. **Roster and lobby UI.** `Room::roster()` and `lobby_state()` read `Seats`. A spectator would show as a player
   row in the lobby, on the scoreboard (0 kills) and on the results screen. Filter them, or mark them.
7. **Two meanings of "human".** `registry.rs::RoomEntry.humans` counts sockets (`attach` does `humans += 1`), while
   `Room::human_count` counts non-bot seats. A spectator is a human to the registry and not to the room. That is
   fine for reaping (the room stays alive while watched) and for `quick_match`'s `e.humans >= max_players`. Say so
   at `RoomEntry.humans`, or a later fix will "correct" one to match the other.
8. **Inputs and commands from a spectator.** `Command::Input`, `use_weapon`, `select`, `fire`, `use_item` and votes
   look the id up in the world or seats. With no body, most become no-ops. Assert it in a test: a spectator's
   `fire` is `Err` or a no-op, and never creates a body.
9. **Snapshots need nothing new.** `codec.rs::encode_snapshot` sends health, fuel, the selected weapon, vision,
   battery and move mods for **every** player, and `for_player`'s footer falls back cleanly (`last_simulated_seq`
   `None` → `s.last_seq`, and `last_stepped_buttons` → 0). So `codec.rs` probably needs no change. Remove it from
   Touch only unless a flag is added. **Ammo is not on the wire for remotes** (the `inventory` event goes only to
   the owner), so the HUD shows "weapon, no ammo". Say so in the task.
10. **Tests that count seats or players**: `room.rs::tests::{the_default_config_seats_bots_and_they_occupy_seats,
    a_full_room_of_bots_still_admits_a_human, seats_refuse_past_the_cap}` are the controls to keep. Add spectator
    twins to them (a spectator in a full bot room does **not** kick a bot).

### What will contradict it, client side (`GameScene.ts`, 39 reads of `this.me`)

- **`onMapInit`** (around `this.core.addPlayer(this.me, spawn…)` and `new Predictor(this.core, this.me)`) seats a
  local body in the WASM core. A spectator would have a ghost body that the predictor steps and that local
  projectiles can collide with. Skip `addPlayer`, `Predictor` and `buildLocalView` when spectating.
- **`renderRemotes`**: `localPos = this.predictor?.renderPos ?? { x: 0, y: 0 }`. With no predictor, every remote is
  culled against the map's corner at night. It also uses the local `this.vision` and `this.hasFlashlight`.
- **`update`**: the camera follows `rp` (`this.world.rig.follow(this.watchPoint ?? { x: rp.x, y: rp.y })`).
  `setNightView(nightView(darkness, [{ x: rp.x, y: rp.y, r: fov }]))`. The minimap's `visibleRemotes(me, …)`. `ear()`
  (audio listener and mine visibility). `padUnderfoot(me…)`.
- **Death and HUD**: `victim === this.me` for the overlay, the feel and `noteDeath`. `bars`, `topHud` and `inventory`
  read `mine`. `crosshair.update`.
- **Seam, and it must be one function:** `private viewer(): { x, y, fov, flashlight, id } | null`. It returns the
  local body normally, and in spectate the watched remote's **interpolated** sample (`this.interp.sample(now)`,
  which is what `renderRemotes` draws; the vision byte and flashlight bit come from the snapshot). Every site above
  reads it. **Coordinate with T23.10B F1**, which introduces `seenAt(x,y)` shared by `renderRemotes`, the minimap's
  `visibleRemotes` and `nightUniforms`. Both refactor the same viewpoint, so land `viewer()` as T23.10B's input, or
  build T23.10B first.
- **Tab**: `keydown-TAB` toggles `scoreboardOpen`. Branch it on spectate. `scripts/checks/full-round.mjs` presses Tab
  for the scoreboard in a normal match, and it is the control that normal mode is unchanged.
- **`debug()`**: `player` must be `null` in spectate (not the spawn ghost), and add `watching` plus the camera
  centre. `harness.mjs::enterBattle` waits on `phase` and `serverRoundTime` only, so it works for a spectator.
- **Entry**: `?spectate=1` has to reach the join payload through `MenuScene` (the `e2e=1` branch at
  `devSurface() && …get('e2e')`) and `net/`. `client/src/scenes/MenuScene.ts` is **not in Touch only**; add it.

### Wrong or missing in the task file
- The Touch only list misses `replay.rs`, `round.rs` (the restart rule, item 4), `MenuScene.ts`, and probably
  `registry.rs` (only if item 7 changes code).
- "A room whose humans are all spectators still starts with bots" is true for the **first** round only (item 4).
- "The HUD shows … weapon": there is no ammo on the wire.
- The `spectate` check must assert the spectator's id is absent from `snapshot.players`, as the "no body" leg, with
  the control that an unflagged client's id is present. It must also assert the camera centre is within a body of
  player A, then of B after Tab. Both ends are needed, or "camera moved" passes for a camera that drifts.

### Order
1. Server: `Seat.spectator` + `has_body()`, `alloc` cap, `populate_world`/`Join`, the replay tag, and restart-when-
   watched, with unit tests. 2. `session.rs` parses the flag. 3. Client `viewer()` refactor, with **no behaviour
   change** and the existing checks green. 4. Spectate branch: no body, Tab cycling, the HUD from the snapshot.
   5. `spectate.mjs` and `make watch`.

---

## T23.26 — bots that read the terrain

### What exists (read before designing)
- **Walking model**: `bots/walk.rs::Bot::walk_buttons`, greedy on `move_to.x`. `rise > STEP_UP` gives JUMP.
  `rise > BOT_JETPACK_RISE (120) && fuel > ½` gives JUMP|UP.
- **Aim is the target**: `bots/mod.rs::Bot::think` computes `aim` from `believed` (the goal's position) **after**
  `walk_buttons`. **FIRE is issued only under `Goal::Enemy` and `should_fire`.** So digging needs `walk_buttons` (or
  a nav step) to return an **aim override and a fire request**. Today there is no path for either.
- **Weapon choice** `bots/arms.rs::choose_weapon` re-decides `want_select` every tick from DPS against the target.
  A dig step must override it (shovel slot 0, or a carving weapon), or it will be switched back the next tick.
- **The drive loop is copied about 12 times**: `grep -rn "wants_select()"` finds `room.rs::drive_bots`,
  `bots/mod.rs::run_round_inner`, `explore.rs`/`arms.rs` tests, and 7 in `tests/balance.rs`. FIRE becomes
  `world.fire(id, now)` in each copy (it does in `drive_bots`, where "nothing consumes Input's FIRE bit"). A dig
  that works in the room and not in one harness copy will measure wrong. **Do this first:** extract
  `bots::drive(world, &mut [Bot], now, dt)` in game-core and call it from all of them (share the function). That
  touches `room.rs`, which Touch only allows only "if a new command channel is needed", so widen it.
- **Map access**: `world.map.coarse: CoarseGrid` (8 px cells, `count_at` 0..64, exact, kept up by carve).
  `world.map.mask.get`. `world.carve_seq()` bumps on every carve, and it is the cheap invalidation signal (a bot
  cannot drain `dirty_list`: `think` takes `&World`).
- **Carve protections**: `map/carve.rs` protects pads (indestructible) and clamps the walls. There is **no bedrock**
  ("once §C15 removes the bedrock"), so digging down reaches the void. `STANDARD_VOID_MAX` 0.50 void deaths per bot
  per round in `balance.rs::space_bots_report` will catch that, which is good. Dig edges must be banned within
  `PLAYER_H` of the map floor and over `body_in_the_void`.
- **Physics numbers**: `WALK_SPEED` 150, `JUMP_VELOCITY` 430 → `gen/traversal.rs::JUMP_HEIGHT` about 66 px and
  `JUMP_REACH` about 92 px. `JETPACK_MAX_SPEED` 260, `JETPACK_MAX_FUEL` 5, `DRAIN` 1/s, `REFILL` 0.5/s after
  `REFILL_DELAY` 0.5, `MIN_FUEL_TO_ENGAGE` 0.3, `HOLD_DELAY` 0.18, `GRAVITY_SCALE` 0.35.
  `JETPACK_CLIMB_BUDGET` = `traversal.rs::JETPACK_RANGE` = 780 px. **They are the same formula written twice;
  unify them.**
- **Shovel**: `SHOVEL_REACH` 20, `SHOVEL_CARVE` = PLAYER_H/2 + 2 = 16 (capsule radius), `SHOVEL_COOLDOWN` 0.55.
  `weapons/melee.rs` sweeps the capsule from the mouth (`PLAYER_W/2`) to the tip, so one swing clears about 20 px
  of depth through a 32 px bore, which is taller than `PLAYER_H` 28. **Dig about 20 px / 0.55 s ≈ 36 px/s against
  walk 150**, so a dig cell costs about 4× a walk cell. That ratio is the tunable's basis.
- **Meteors**: `effects/scheduler.rs::EffectScheduler::active()` gives `ActiveEffect { kind, phase: Telegraph |
  … }`, and `meteors_falling(now)`. The telegraph is `EFFECT_TELEGRAPH` (3 s) before the first drop. Meteors spawn
  across the whole width (`meteor.rs::spawn_band`, `LATERAL_MAX` 60 drift), `METEOR_CARVE_R` 50, and fragments carve
  14. Cover depth X should be derived: `METEOR_CARVE_R + METEOR_FRAG_CARVE_R + PLAYER_H/2`, not a literal.

### What will assert the opposite of T23.26 (plan to rewrite, not "fix")
- **`walk.rs::tests::a_winged_bot_in_a_closed_pocket_gives_up_within_a_bound`** asserts `pressed_after == 0` (no
  sideways press after about 5.5 s) for a bot sealed in rock 240 px from an enemy. That is D's scenario 2 with the
  opposite expectation: a digging bot keeps pressing into its tunnel. Restate it: it gives up only when no dig is
  possible (the pocket walled by protected cells), or it digs out.
- **`walk.rs::tests::a_hurt_bot_breaks_contact_and_a_healthy_one_holds_its_ground`** asserts that distance to the
  enemy rises monotonically after `settle` and that it presses away on most ticks. Cover-seeking (C) will walk
  sideways or toward cover, or stand in a dug pocket. Keep it as the **no-cover control** (flat shelf: still runs),
  and add the cover case separately.
- **`bots/mod.rs::an_item_behind_solid_rock_is_not_a_target`** is §E10's reachability rule (S0).
- **The stuck counter trap.** D wants "seconds a bot spends pressing without moving". The walker's stuck test is
  per-tick: `(pos.x - stuck_from).abs() < BOT_STUCK_PX` (6 px) against a walk of 2.5 px a tick. The comment in
  `walk_buttons` says outright that a walking bot "hops every `BOT_STUCK_WINDOW` while it walks, and that is
  load-bearing". **A counter built on `still_for` would count every walking second as stuck**, so the before/after
  table would be meaningless. Measure displacement over `BOT_STUCK_WINDOW`, as the winged branch does, as a
  **separate** counter, and leave the hop's trigger alone until B replaces it. The comment records that moving
  walkers to the window turned the flee test red.
- **The balance baselines that will move**: `SEED_LOS_FLOOR`, `POOLED_DAMAGE_FLOOR` (encounters),
  `WEAPON_WAIT_CEILING_S` (time to arm; nav should improve it), `STANDARD_VOID_MAX` (dig and fall edges could worsen
  it), and `bots/mod.rs::a_round_of_bots_is_a_fight` / `bots_actually_hurt_each_other_over_a_round`. Run the full
  `--ignored` balance suite **before** A for the baseline table (the task asks for before/after of only three
  numbers).
- `the_same_seed_and_world_give_byte_identical_inputs` stays green only if the planner is deterministic (below).

### Recommended nav design (A)
- **Grid**: bot-owned nav cells of 16 px (= `PLAYER_W`, 2×2 coarse cells). Medium 3072×1536 is 192×96 = 18 432
  cells. **Do not cache per bot**: derive cell state on demand from `world.map.coarse` (four `count_at` reads). A
  cell is `Air` (all four 0), `Rock` (any > 0) or `Protected` (a pad or wall column, from `map.meta` and `WALL_W`).
  A body **stands** at cell (x, y) when cells (x, y) and (x, y−1) are Air (28 px is less than 32) and (x, y+1) is
  Rock.
- **Edges and their cost in seconds**, every constant derived:
  - walk ±1 x along standable cells: `16 / WALK_SPEED`;
  - **hop, which the task file lacks**: up to `floor(JUMP_HEIGHT/16)` = 4 rows, `JUMP_REACH` sideways, free of
    fuel, costed as the jump's airtime `2·JUMP_VELOCITY/GRAVITY`. Without it every 20–60 px step is priced as a jet,
    and bots burn fuel on kerbs;
  - fall: any Air column down to a standable cell, `sqrt(2h/GRAVITY)`, never into the void;
  - jet: a straight Air run up or diagonal, `h / JETPACK_MAX_SPEED + JETPACK_HOLD_DELAY`. Its **fuel** is the
    second search dimension: carry `fuel_left` (quantised to 0.25) in the node key, drain `h/JETPACK_MAX_SPEED ·
    JETPACK_DRAIN`, and a standable cell refills at `JETPACK_REFILL` after `REFILL_DELAY` (a "rest" edge that costs
    the refill time). A climb the tank cannot make has no edge. `JETPACK_CLIMB_BUDGET` stays as an upper bound;
  - dig: into a Rock, non-Protected cell, `16 / 20 · SHOVEL_COOLDOWN` (≈ 0.44 s), or cheaper with a carving weapon
    in hand. Barred within `PLAYER_H` of the floor, and inside the weapon's own `BOT_BLAST_GUARD`.
- **Search**: A* with an octile heuristic divided by the fastest edge speed (admissible). A `BinaryHeap` keyed on
  `(Reverse(f_fixed_point_u32), node_index)` for a **total order**, so no float ties and no `HashMap` iteration.
  Visited and parent arrays go in a `Vec` indexed by cell (reused per bot). **The budget is a node count**
  (`BOT_NAV_NODES_PER_TICK`), never `Instant`, which would break replay determinism. The server re-runs bots on
  replay through `Room::tick_once` → `drive_bots`. The search resumes across ticks, and meanwhile the bot keeps
  today's greedy step.
- **Invalidation**: store the path's cells and `carve_seq` at plan time. When `carve_seq` moves, re-check only the
  remaining path cells, which is O(path), not a re-plan. Re-plan when a path cell changed state, when the goal moved
  a cell, or when a waypoint is not reached within `2 × its edge cost`.
- **Space** is out of scope: `space::flies` replaces the buttons wholesale, and wings keep their sweep. Say so in the
  task.

### B/C wiring
- Add `NavStep { buttons, aim: Option<f32>, fire: bool, select: Option<u8> }` from the follower. `think` applies
  `aim` over the target's angle and `fire` outside the `Goal::Enemy` branch, and `choose_weapon` yields to `select`
  while a dig edge is active. Fighting wins: if `should_fire` holds, skip the dig and keep the path.
- Meteors (C): on a meteor `Telegraph` in `effects.active()`, set a `Goal::Cover` (a new goal, not a flag on
  Wander) to the nearest standable cell with ≥ X px of Rock above it, found by the same A* with a goal predicate. If
  none is within N s, dig a pocket: two dig edges into the nearest wall at body height. Drop it when neither
  `meteors_falling` nor the telegraph is active. Frenzy (`self.frenzy`) never takes cover.

### Wrong or missing in the task file
- The hop edge is missing (above). "Steps up to STEP_UP" alone makes 6–66 px rises cost a jet.
- "Seconds pressing without moving" collides with the per-tick hop test (above). Name the new counter's window.
- Touch only omits `room.rs` for the shared drive function and `map/gen/traversal.rs` for the `JETPACK_RANGE`
  duplicate.
- D.4's "≥ X px of rock" needs X derived (above) and a control: the same fixture with no telegraph, where the bot
  does not bury itself.
- The kill-rate floor ("must not fall") needs its seeds, window and run count written down (CLAUDE.md: a
  population claim needs more than one draw).

### Order
0. Amend §E10 (S0). Baseline: the balance `--ignored` report plus µs/tick for 5 bots, pasted.
1. Extract the shared `bots::drive`, with no behaviour change and all bot and balance tests byte-identical.
2. A: `bots/nav.rs` grid, edges and A* (unit tests on carved fixtures: a hop, a jet with a refuel, the tank-limited
   refusal, a dig through a thin wall versus going round a thick one, determinism across two runs).
3. The new window-based stuck counter (a report only).
4. B: the follower plus the `NavStep` wiring, then rewrite the closed-pocket and item-behind-rock tests.
5. C: meteors, then flee-to-cover, keeping the flee test as the no-cover control.
6. D: scenarios and the population table, then the owner watches through T23.27.
