# M20 handoff — what the diff does not say

`tasks/HANDOFF-M19.md` is still live and everything in it still applies; this file is M20's
continuation of it. The spec is `docs/70`–`75`, and the tasks are `tasks/M20/`.

## T20.01 landed — the host was not losing permission, it was losing its seat

**The task file was amended three times while this was being built, and the last draft is
the one that landed** — with one deliberate widening, agreed by the coordinator mid-shift.
What follows is the part that is not recoverable from the diff.

### The scope is `world_installed_at.is_some()`, not §E3's "private"

The ruling scoped the sweep to *"a started match, **or a non-private room**"*, on the
finding that a public lobby cannot reach 30 s: `starts_in` is set to `LOBBY_BOT_TIMEOUT`
(10.0) the moment the first player is seated, and §E2 says it does not reset. That is true
at the shipped configuration. It is **false wherever the override exists**, and there the
public branch is not merely reachable, it is the same bug with no §E3 clause to name it:
`scripts/checks/lobby-start.mjs` runs `LOBBY_BOT_TIMEOUT=45`.

**Measured at the base commit, in a stash-clean tree**: the sole human is swept at t=30 s
and the round starts at t=42.7 s reporting `3 players` — with `BOT_COUNT=3`, that is three
bots and no human. So the sweep is scoped to "there is a map out", which is what its own doc
comment always said it was for (*"a client that fails to decode the map"* is a client that
has been **sent** one) and needs no §E3 at all.

### `lobby-start` has been green on a ghost, and the fix is what exposed it

This is the part worth carrying forward. At the base commit the check passed **because** the
human had been swept:

- `sweep_unready` freed the seat and pushed its id onto `Seats::free`.
- `seat_bots` at match start allocated from that free list, so **a bot took the human's id**.
- `SessionMap` still mapped that id to the human's socket, because the sweep never did the
  socket-layer half of leaving — so `broadcast_snapshot` sent that bot's frames to the
  browser.
- The check read `d.playerCount = 3` off `mirror.players` and called it "it seated bots".

The count was real and the seat behind it was not. The moment the sweep does the
`SessionMap` half the ruling asks for, that socket stops receiving anything and the check
**hangs** — which is how the ghost was found. It now reads `4 players` (one human, three
bots) and asserts `d.me >= 0 && d.player` as well, because a count alone was exactly what
the ghost satisfied.

Its `playerCount` read also had to become a wait rather than an instantaneous sample:
`phase` arrives on `round_state`, which is broadcast to every socket, while `playerCount`
needs `map_init` → `ready` → a snapshot. The phase flips one broadcast before the roster can
exist. That race was invisible while the ghost's snapshots were already flowing.

### The window runs from the map, not from the seat — and this half was not in any draft

Scoping the sweep to "there is a world" is **not sufficient**, and the failure it leaves is
worse than the one it fixes. `sweep_unready` measured `joined_at.elapsed()`, so a player who
waits out a lobby longer than `READY_TIMEOUT` is already stale on the tick the world is
installed: the sweep drops them on that same tick, before `map_init` can reach the browser.
Measured against `lobby-start` again: the gauge went `players 1 -> 3` as the round began.

`Room::world_installed_at` is now the stamp and the sweep measures
`max(joined_at, world_installed_at)` — whichever came later is when that seat was last asked
for something, so a late joiner is measured from its own arrival and everybody who waited out
the lobby is measured from the map. It is `None` exactly when there is no world, which is why
it *is* the lobby guard rather than a second value beside one.

**There are three writes to `self.world`** (`install_world`, `return_to_lobby`, `restart`)
and each has to leave the stamp agreeing with it. `room.rs` already records that hazard for
`self.started`; this is the same hazard with a second value, and it is handled the same way —
a line beside each assignment with a comment saying so. A fourth write that forgets it will
either sweep a lobby or never sweep at all.

### What was **not** done, and must not be claimed

- **`ctx.detach` is not called and the "room is never reaped" knock-on is not fixed.** Every
  `ctx.detach` is in the socket layer (`session.rs:496, 961, 1011, 1056, 1072`) and
  `room::run` holds `io` and an `Arc<SessionMap>` and no registry handle — `registry.rs:292`
  says so in as many words (*"the room task has no registry"*). The reachable half is
  `sid_of` → `remove_sid`, which is `session::release_swept_socket`.
- **`note_lobby_change()` is deliberately absent from the sweep.** `take_lobby_update()`
  answers `None` whenever there is a world (§E6: the message describes a lobby) and the sweep
  now only runs when there is one, so the call would be a no-op that *reads* as the
  notification the sweep was missing. The coordinator withdrew the matching Tests bullet
  (*"a `lobby_state` reflecting it is broadcast, asserted on the client's view"*) — it cannot
  have a test under this scope. What lands instead is the `player_leave` broadcast at the
  call site, plus `release_swept_socket`, unit-tested in both directions.

### Tests that moved, and why moving them was the point

`private_lobby.rs::withdrawing_ready_does_not_arm_the_unready_sweep` and
`room.rs::a_player_who_never_readies_is_dropped` both ran on **lobbies**. Once a lobby is
never swept, both pass for a room whose sweep is switched off — and the first one's whole
stated purpose is to stop `ready` and `consent` being collapsed back into one field.
Falsified to prove the move was necessary: with `s.ready = on` at `room.rs`'s
`Command::Ready`, the test is **red** on a started room and was **green** on a private lobby.
Both now run on started rooms. `replay.rs::an_unready_sweep_is_recorded_because_a_replay_has_no_clock`
had to start its match for the same reason.

### Two instrument defects in one check, and only one is fixed here

`lobby-start.mjs:201` reads `window.__game.constants().LOBBY_BOT_TIMEOUT`, which is **not in
`constants_json`** — it is `undefined`, `(undefined + 8) * 1000` is `NaN`, and the
`waitForFunction` therefore has no deadline at all. That is `CLAUDE.md`'s *"an assertion on a
field that does not exist cannot fail"* in its other form, and it is why the hang above sat
for eight minutes instead of failing in eighteen seconds. **Booked as T20.15 and deliberately
not fixed here** — the coordinator's ruling is that the deliverable is the *grep* (any
`constants().X` in `scripts/` where `X` is absent from `constants_json`), not the one site.

### Smaller things

- **`round.forget(id)` is now called by the sweep.** It was the third divergence from
  `Leave`, beyond the two the task named: a swept player kept its restart vote, so a
  two-player room could sit waiting on a vote from somebody who was not in it.
- **`joinErrorMessage` and `lobbyErrorMessage` are different functions on purpose**, and the
  unit test's last case is the control that says so — if one were the other under a new name,
  every other assertion in that block would still pass. `lobbyErrorMessage` is mostly a
  pass-through because every `lobby_error` reason the server sends is already a sentence
  written for a player, unlike `join_error`'s wire enums. A table here would be a second copy
  of the server's wording, and the copy is what goes stale.
- **`lobby.mjs` now sits out `READY_TIMEOUT_SECS` for real**, pinned through
  `scripts/lib/rust-constants.mjs` (there is no browser constant for it, and `__menu` has no
  `constants()`). The clock starts when the host is seated, not when the wait begins, so most
  of the thirty seconds is work the check was doing anyway — measured cost of the whole check
  40.0 s.
- **A `game-server` red that was the box.** `reap::a_full_refusal_does_not_leave_a_phantom_occupant`
  failed once inside a full `cargo test -p game-server` and was green 3/3 standalone and on
  the next two full runs. It is the family HANDOFF-M19 names in the T19.16 section — a short
  wall-clock window over a real socket, under concurrency. Nothing was changed to accommodate
  it and it is not on any list.

## T20.03 landed — promotion already worked; nothing on screen said so

**Almost everything the report asks for was already true, and the task file says so.**
`settings_owner()` is derived per call, both departure paths (`leave_room` and disconnect)
free the seat and rebroadcast, and `the_settings_pass_to_the_longest_seated_when_the_host_leaves`
already pinned the ordering. What was missing was one boolean on a roster row and a marker on
the screen.

- **`RosterRow.host` is derived, never stored.** `settings_owner` has no `host` flag beside it
  on the server precisely because two flags can disagree about who the host is; a field here
  would be the third copy. It is `s.private && p.seat === s.settingsOwner`.
- **Private lobbies only, and that is not a presentation choice.** `settings_owner()` derives
  on every room and `events.rs` emits it for public lobbies too, but `check_settings_change`
  refuses a public lobby **before** it looks at the owner. On a Quick game the field means
  "longest-seated human" and nothing more, so a crown there names somebody who owns nothing
  and cannot be given anything. The settings *panel* was already gated this way; the roster
  was not. Both halves are asserted in `lobby.mjs` — absent on `cass`'s public lobby, present
  on `dan`'s private one.
- **The marker is in the row's *text*, not only in its class.** `__menu.roster()` reads
  `textContent`, so a CSS-only crown would be invisible to the only check that can prove it
  moves. Falsified by deleting `${host}` from the rendered string: **two reds**,
  `["dan","eve"]` before and `["eve"]` after.
- **The server test that was missing is about the *telling*, not the promotion.**
  `settings_owner()` is computed per call, so every server-side assertion about it passes
  whether or not a client was ever sent the new answer.
  `the_promotion_is_broadcast_and_not_merely_derivable` drains the queue first (or the joins'
  own pending update satisfies it for free) and then asserts `take_lobby_update()` produces a
  payload naming the new host. Falsified by commenting out `note_lobby_change()` in the
  `Leave` arm: red.
- **The T20.01 path is confirmed by absence, and that is the honest form.** "Promotion
  survives the sweep" no longer has a live case: the sweep cannot reach a lobby at all, so it
  cannot promote anybody. `private_lobby.rs::a_private_lobby_is_never_swept_and_the_host_keeps_the_settings`
  asserts the host still owns the settings after the harshest sweep there is, which is that
  claim in the only form it still has.
- **`ROOM_EMPTY_TTL` was not touched, and here is the measurement the task asked for.**
  "Close the lobby" already works: the registry stamps `empty_since` on the last detach and
  `reap` drops the room after `room_empty_ttl`, noticed every `ROOM_REAP_INTERVAL` — so a room
  lives at most `ROOM_EMPTY_TTL + ROOM_REAP_INTERVAL` = **32 s** after the last human leaves.
  `reap.rs::an_abandoned_lobby_is_reaped_before_it_ever_starts` watches a real socket create a
  private room, disconnect, and the room disappear — at `TTL_S = 1.0` from **config**, which
  `registry.rs:430-433` says exists so a test need not sleep for the shipped value. 30 s is
  the right meaning: it is the reconnection window §E4 leaves open, and shortening it would
  close that seam for a lobby nobody is waiting on. No constant changed.
- **One warning in the log that is not a failure.** `room_left emit failed: … Closed` appears
  when `dan` presses Leave: `leaveLobby` sends `leave_room` and closes the socket, and the
  server's `room_left` reply races the close. Pre-existing shape, unrelated to this task, and
  named here so the next reader does not chase it.

## T20.02 landed — there was no "dude", and the bug was one function with four copies

**The default is `Player`, not "dude"** — nothing in the repo ever called anybody that. The
real defect is the one the task file names: `MenuScene.identity()` re-spelled all three
`deepcut.*` keys and read them **raw**, bypassing `loadChoice`, `cleanName` and `readId`.
That is the live binding site for all four lobby verbs, so a stored `"   "` reached the wire
as a name the server refuses and a stored `"banana"` reached it as `Number("banana")` —
`NaN`, which `JSON.stringify` sends as `null` and which **this client then hands to its own
atlas**. The server degrades safely; the client does not.

### The two open decisions, and how they were settled

**"Route it through `loadChoice`" is not executable, and the way out is `loadIdentity`.**
`loadChoice` needs a skin count, `SkinsScene` gets it from `skins()?.players.length` *after
the atlas loads*, and `MenuScene` imports no registry at all. Giving the menu the atlas
lookup would make the menu wait on an image to know its own name, so the split is the other
way: `loadIdentity(store)` is `loadChoice(store, Infinity, Infinity)` — the same function
with the **bound** removed, because the bound is the only part the atlas is needed for.
Unbounded is safe at both ends and neither end is an accident: the server clamps to
`u16::MAX` and never validates an id against a list (`docs/50` §1), and every client lookup
falls back for an id past the end. What is *not* safe is `NaN`, and `readId` stops that with
or without a count. There is a test for exactly this: `loadChoice(s, 5, 5).skinId` is 0 for a
stored `7` and `loadIdentity(s).skinId` is 7 — clamping to 0 would silently draw a
**different real skin** where falling back draws the fallback.

**The dev path stays dev-only for the name and joins the shared path for the id.** Eight
browser checks name their client through `?name=`; routing that through `localStorage` would
make the URL inert and every one of them anonymous, and a check that set `deepcut.name` and
one that passed `?name=` would then disagree about which wins. The **skin** has no competing
parameter, so `GameScene.ts:935`'s `Number(localStorage.getItem('deepcut.skin') ?? 0)` — the
same `NaN` bug, on the same key — now reads `loadIdentity(localStorage).skinId`. A valid
stored id passes through unchanged, so no fixture moves.

**Who owns `<>`, since the task asks:** every HTML sink, through `escapeHtml` —
`results.ts`, `deathOverlay.ts`, `MenuScene`'s roster, and now `SkinsScene`'s name input.
`sanitise_name` on the server strips control characters and neither brackets nor quotes, and
`cleanName` strips brackets and **not quotes** — so reading `cleanName` as the injection
guard is a mistake. **A real hole was found and closed on the way:**
`SkinsScene.ts:189` interpolated `value="${this.choice.name}"` into `innerHTML` unescaped,
and a name containing `"` breaks out of the attribute. It is self-inflicted (the name is the
player's own storage) rather than an attack surface, and it is still an injection.

### The prompt

**One gate, in `enterLobby`, in front of all three verbs.** `quickMatch`, `createRoom` and
`joinByCode` all converge there, so a guard in each would be three copies of one rule and the
fourth entry point would forget it. The interrupted join is remembered on the **scene** as
`{ intent, screen }` — on the scene because `MenuModel` is the Phaser-free half and a
`LobbyIntent` is a wire payload, and *with its screen* so resuming does not have to know
which verb was pressed.

**`nameOrNull` is one predicate answering three questions** — is a name stored (the trigger),
is what was just typed a name (the prompt's own validation), and what do we send. They must
not be allowed to disagree: a prompt that appears for a name the game would have accepted, or
a box that accepts one the game then replaces with `Player`, is worse than no prompt.
`cleanName` and `storedName` are that function with two different endings.

**A player who types `Player` is never asked again**, deliberately: the test is "is the key
present and non-blank", not "is it the default". And `<b>` is **not** blank — it strips to
`b`, a name somebody can have — which is asserted as the control beside the blank cases.

### Two things worth knowing

- **`ui/menu.test.ts`'s `ALL` was a hand-written array and is now `Record<Screen, true>`.**
  A screen added without a row was silently untested — the "back reaches the menu from every
  screen" test would go on passing while the one screen that could trap you was not in the
  list. `name` is the screen that found it. Same trick `BACK` in `menu.ts` already uses.
- **`lobby.mjs`'s `openAtMenu` takes a second argument now**, `seed`, so one client can
  arrive with nothing stored. The `deepcut.name` literal is still spelled out there — the
  keys did not change in this task precisely because three browser fixtures spell them out,
  and a rename that missed them would seed a value nobody reads while every "the roster names
  the player" assertion went on passing against the default.

## T20.04 landed — the id was known everywhere and drawn nowhere

The task file's diagnosis is exact and needs no restating. What follows is what the
diff does not say.

### The three writers, and why `skinId` is required rather than optional

`scores` had three writers in three idioms — `lobby_state` **merges**, `player_join`
**clobbers**, `score` **reconstructs field by field from a two-field payload** — and `score`
fires on every kill. `skinId?: number` compiles at all three and resets everybody to Recruit
on the next death; required means the compiler names the writer you forgot. That is the whole
reason the field is not optional, and it is worth not "tidying".

**Recorded, not fixed, as the task asks:** the merge/clobber split is *already* a live defect
for **scores**. `player_join` writes `score: 0` unconditionally, so a `player_join` arriving
after a `score` event resets that player's tally — the same shape `:493-507`'s own comment
records being found once before (T9.06).

### The client half

`PlayerView.skinId` is `private readonly` and consumed in the constructor: there is **no
setter**. So "what if a remote is drawn before its `player_join` arrives" has no free answer —
either the view is rebuilt when the skin becomes known, or a body drawn one frame early stays
Recruit until it next leaves the sampled set. `renderRemotes` already destroys and rebuilds
routinely, so the shape is: read `scores.get(id)?.skinId ?? 0` **at the construction site**,
and rebuild when the drawn skin and the wanted one disagree. The local body gets the same
treatment through `buildLocalView`/`syncLocalSkin` — and note the local seat has **no
`player_join` of its own** (that event is broadcast to everybody except the joiner), so
`lobby_state` is the only thing that ever names this client's own skin.

`SandboxScene.ts:153` was the third hardcoded `0` and is **fixed**, not left: it is the one
scene you look at your own character in outside a match.

### The harness seam: a query parameter, not `addInitScript`

`openClient` navigates to the **dev path**, where the skin is read at scene create — the
frame after `goto` — so the `page.evaluate(localStorage.setItem)` pattern `lobby.mjs` uses
runs too late and both clients come up skin 0 with their frames matching. `openClient` already
threads `query` through *before* `goto`, `GameScene` already reads `name` from the same
params, and `addInitScript` appears nowhere in `scripts/`. So `?skin=` it is, parsed through
`readId` (a `NaN` here would be the T20.02 bug again) and winning over storage for the same
reason `?name=` does: on that path the URL **is** the identity.

### The check took four versions, and three of them passed with the bug restored

**This is the part worth reading.** Each version was killed only by actually running the
falsification — putting `new PlayerView(this, 0)` back at the remote construction site — and
watching the pixel assertion go green anyway.

1. **A background patch 60 px above the head is not the background *behind* the body.** Two
   bodies on different ground differ by **36.7** with both on skin 0, against 90.1 with one
   on skin 4. It was measuring position.
2. **A remote is drawn from the interpolation buffer** (§C7). Framing bo with the position
   *bo's own page* reports lands off the sprite: measured, that rect caught 36 % as much body
   as the local player's did. `debug().drawnPlayers` now reports where each body is **drawn**,
   as its centre — the same distinction `birdsDrawnAt` and `drawnItems` already make.
3. **A fixed 16x16 screen rect is a stamp on a 32x56 sprite.** How much sprite it contains
   varies per body, and the inequality below needs that share to be a property of the sprite:
   two bodies on the **same** skin gave 101.8 and 33.6 for body-versus-ground. The rect is now
   `PLAYER_W x PLAYER_H` scaled by the live camera.
4. **A sprite is mirrored by its owner's aim.** Each page's pointer is moved to the same
   screen point, so all three face the same way. This alone took the same-skin control from
   13.8 to **2.1**.

**What makes the final version an assertion rather than a threshold** is `setActorsVisible`, a
new e2e-only hook beside `setBirdsVisible` and for its stated reason. Each rect is read twice
in one frozen frame — bodies drawn, bodies hidden — so the ground behind each body is
*measured*. A rect is `α·sprite + (1−α)·ground`, so two rects of **identical** sprites differ
by `(1−α)(groundA − groundB)`, strictly less than the ground difference; two different sprites
have no such bound. "The bodies differ by more than the ground does" is therefore a property
only different skins can have. `cy` wears ana's skin and asserts the other half: identical
sprites must **fail** that bar.

Measured, with the fix: bodies **61.0** against ground 26.9 (2.3x), control 2.1 against 32.3.
With the bug: bodies **0.6** against ground 28.5.

`setActorsVisible` only holds while the scene is frozen — `renderRemotes` rewrites every
remote's visibility every frame — and the doc comment says so.

### Two smaller things

- **`skins-ingame` does not walk anybody anywhere.** The obvious way to get two bodies into
  one frame is an approach loop; measured, ana closed 240 px of 1544 in sixty seconds of a
  held key with jetpack hops, because the ground between two spawn points is not a corridor.
  `__game.watch(x, y)` — `crates`'s hook for photographing a falling crate — frames each body
  in turn with one camera instead. What that gives up against a single shot is ~200 ms
  between two screenshots of a world in which every body is standing still.
- **It asserts daylight first.** `renderRemotes` culls a remote outside the local player's
  field of view at night (`docs/14` §5), and a culled body is an invisible one — which reads
  exactly like the bug.

## T20.06 landed — the table was never the problem, and now there is an instrument that says so

**Every one of the four candidate causes is now settled by measurement rather than by
argument**, and three of them are settled by an instrument that did not exist. The report is
`balance.rs::item_population_report`, run as
`cargo test -p game-core --release --test balance -- --ignored --nocapture`.

### The measurement, 8 seeds x 3 scales

```
   Small:  peak live 15/40   battery_pack 104 item-s (9.1% of the ground)  2.0 spawned  0.4 picked  0.0 expired
   Medium: peak live 20/40   battery_pack 113 item-s (7.5%)                2.2 spawned  0.5 picked  0.0 expired
   Large:  peak live 22/40   battery_pack 140 item-s (7.4%)                3.5 spawned  1.5 picked  0.0 expired
```

- **Cause 2 (volume) — dead.** A battery pack is **2nd of 19** by time on the ground on Small
  and 5th on Medium and Large. Only the medkit beats it everywhere. No weight change can make
  it more present than the item that is already ahead of it, and the task's own warning
  applies: raising the rate produces churn that measures like density.
- **Cause 3 (`WORLD_ITEM_TTL`) — dead.** `expired` is **0.0 at every scale for every item.**
  Nothing times out at all in a 150 s round, because the bots pick things up or blow them up
  first. The 70 s TTL is not what a player is failing to see.
- **Cause 4 (`MAX_WORLD_ITEMS`) — dead**, and now asserted rather than described:
  `live_peak` is 15/20/22 against a cap of 40, and the report fails if it ever reaches it.
  `ITEM_SPAWN_INTERVAL`'s doc comment claimed "well clear of the cap"; that claim is a test now.

**Item-seconds is the quantity the complaint is actually about.** An item that spawns and is
picked up in two seconds and one that lies untouched for seventy are one draw each and
thirty-five times apart in how often anybody walks past one. The share tables in this file and
in `melee.rs` measure `roll_item` — no map, no clock, no TTL, no cap — so they are blind to
everything that happens after the draw.

**One limit, stated rather than buried:** the `picked` column is **bots** picking things up,
not a player. It measures bot appetite, not human perception, and it should not be read as
"players ignore batteries". What it *is* good for is the comparison — batteries are picked up
at 20 % of their spawns on Small against the pistol's 44 % and the flashlight's 58 %, by the
same bots on the same runs.

### So it is cause 1, and two things were free to check on the way

- **The item is drawn distinctly.** `assets/atlas/items.json` has **no `item_battery` frame**
  — only 8 frames, and the battery is not among them — so it falls back per `docs/50` §8. But
  the fallback is not a blank: `render/itemTextures.ts:27` paints one procedurally, a dark
  body with a green charge bar. "It has no art" is not the cause.
- **What picking one up got you was one digit.** `⚡ 0 R` becoming `⚡ 1 R`, 13 px monospace, at
  the edge of the screen, and `♥`/`⚡` are the only things distinguishing the two rows.

### The fix, and why it is pips

`MAX_HEALS` (2) and `MAX_BATTERIES` (4) rows of 9 px blocks, filled when held and a dark
socket when not, with the digit kept beside them. It is a change a rect mean can see — the
task's own constraint, and the reason a bigger digit was not an option — and the row's
**length is the cap**, which the digit never showed and which `bump` silently enforces when
it refuses a fifth pack.

**Recorded, not acted on:** `BATTERY_PACK` carries `max_stack: 3` in the registry while the
pickup path routes it to a counter capped at `MAX_BATTERIES = 4`. The item is *defined*
inventory-shaped and *behaves* as a counter, and the two numbers disagree about how many you
can hold. The pip row now shows the one the game actually enforces.

### The pixel check took four versions, and the control is free

`DEV_LOADOUT` grants `heals = MAX_HEALS` and **no** batteries, so the same HUD in the same
frame holds one full row and one empty one — same font, same place, same lighting, one
variable. Getting a valid comparison out of that took three corrections, each caught by
forcing every pip to the empty style and watching the assertion pass anyway:

1. the whole **row** dilutes the pips with an icon, a digit and a key letter (13.2);
2. the whole **pips container** still differs because `MAX_HEALS` is 2 and `MAX_BATTERIES` is
   4, so the two rects are different widths — **9.6 apart with nothing lit at all**;
3. one pip against one pip *still* read 9.6, because a socket drawn at
   `rgba(255,255,255,.10)` is the world showing through it and the two rows sit over
   different parts of the world.

The socket is opaque now — for the player as much as for the check, since a translucent
socket over bright sky is invisible — and filled and empty are the same 9 px box, so the row
does not jitter as it fills. Measured: **201.3 lit, 0.3 with every pip forced empty.**

### A defect this shift introduced and removed

The first `PipRow.set` rewrote `cssText` on six elements **every frame**, where the counter it
replaced wrote one `textContent`. It now returns early unless the count or the cap changed.
Found by asking what could make `night-combat` and `perf` — both frame-time sensitive — go red
on a tree whose only client change is a HUD row; the answer did not exculpate the change, so
it was fixed. See the gate section below for why that turned out not to be the cause.

### Five gates, four reds, and a green baseline in the middle

Worth writing down because it cost two hours and the conclusion is *not* "the box was tired".

| gate | tree | result |
|---|---|---|
| 1 | T20.06 | red — `backdrop-real`, `[vitest-worker]: Timeout calling "onTaskUpdate"` |
| 2 | T20.06 | red — `night-combat`, "only 2 lights" |
| 3 | T20.06 (before the per-frame fix) | red — `night-combat` + `perf` 4.10 ms vs 4 |
| 4 | T20.06 (after it) | red — `checksum::two_clients_agree…`, "got 49" against a floor of 50 |
| 5 | **`fc7f276`, stashed** | **green** |
| 6 | T20.06 | **green** — 44/44, 25/25, assets ok |

Every red is on the wall-clock-margin list `HANDOFF-M19` already keeps, and each was measured
standalone on an idle box: `backdrop-real` **51/51 with an identical 217.7 s duration** (so the
work completed and only the worker's RPC report timed out — its test bodies are synchronous
and cannot service RPC for 12 s at a stretch), `night-combat` **3/3 with `lights: 3`**, and
`checksum` **3/3**. Gate 4's red is the decisive one: `checksum` is a Rust socket test with no
browser and no client code in it at all, and **nothing in this task's six files can reach it**.

The baseline green at gate 5 is one draw and does not clear the box either. What the sequence
supports is narrow and worth keeping: **a long session degrades this machine for exactly the
family of checks that live on a two-second wall-clock margin**, the reds move around within
that family rather than repeating, and a single red gate on one of them is not evidence about
the tree. Five gates earlier the same night, on progressively larger trees, were green.

## T20.09 landed — five layers, and the two decisions the task asked for

The command follows `MoveItem` term for term: `inventory.ts` handler →
`connection.ts`'s `sendRaw` → `session.rs` socket handler (`unwrap_or(255)`, so a missing
field is a refusal rather than a default of 0 — and slot 0 is where the starting kit lives)
→ `Command::DropItem` → `World::drop_item` beside `move_item` → `GameEvent::Inventory` +
`ItemSpawn`. What follows is what the diff does not say.

### `REPLAY_VERSION` did **not** move, and the reasoning is the repo's own

Tag 22. `replay.rs`'s doc comment gives the policy across all three prior bumps: bump when
the **header layout** changes (v2, v4) or when an old file *"would load, run, and diverge
silently"* (v3). A new tag does neither — the header is untouched and a v4 file simply
contains no tag-22 commands, so it replays byte for byte. Bumping "to be safe" would reject
every recording anyone already has, because `decode` refuses any version mismatch outright.
`every_command_really_is_every_command`'s count moved 21 → 22 and the `match` beside it made
the addition a compile error, which is what it is for.

**T20.07 and T20.08 are the opposite case and must not copy this.** Both delete a field that
is in the state hash, so an old file would load and diverge — that is the v3 precedent, and
they share **one** bump between them rather than taking one each.

### Two decisions the task said to settle rather than discover

**The gesture's geometry.** Tiles were `pointer-events: auto` and the root `none`, so with a
drop on the tiles the meaning changed *inside the panel*: on a tile it drops, and in the 4 px
gap between two tiles or on the backpack's 6 px padding it fell through to the canvas and
**closed the backpack**. Two outcomes four pixels apart, on a panel the player is aiming at.
Delegating from the root — the other option the task offers — cannot work: `pointer-events:
none` means the root is not an event target at all, so a click in a gap never reaches it to be
delegated. So the root takes the events **while open** and owns its own close gesture, which
is the same `toggleBackpack` the canvas calls rather than a second copy of it. Only while
open, because the reason the root was `none` is real: it is as wide as the bar and a
transparent block over the play field would swallow shots meant for it.

**The lock.** `DROP_PICKUP_LOCK = 1.5` is in `constants.rs`, **not** beside `DEATH_DROP_LOCK`
in `items/world.rs` where a new constant would naturally have gone — that one is a
pre-existing violation of "every numeric tunable lives in `constants.rs`" (`STARTING_KIT` in
`player/state.rs` is the same class), and putting a second one next to it would replicate the
violation rather than notice it. Longer than `DEATH_DROP_LOCK` and for a different reason: a
death lock stops the *killer* hoovering a corpse, this one has to outlast the player walking
away from what they put down.

### Smaller things

- **`SpawnSource::Dropped` needs no client change**, and that was checked rather than
  assumed: every client read of `source` is a `=== 'Crate'` comparison and the parse is
  untyped with a fallback, so a new variant draws as an ordinary item.
- **The starting kit is refused through `STARTING_KIT`**, never by naming the shovel. Writing
  `item == SHOVEL` is identical today and divergent the day the kit grows, which §F7's `all`
  start kit makes live. `drop_item` also **reads the slot before taking it**: refusing after
  the stack is out of the inventory means putting it back, and the put-back is the step a
  later edit forgets.
- **A drop falls straight down with no velocity**, unlike a death scatter. A death throws a
  pile apart so it is readable; a drop is a placement, and an item that skittered away from
  where you put it would be a worse gesture than the one that did nothing.
- **`contextmenu` is suppressed on the panel root**, because `main.ts` suppresses it on
  `game.canvas` and `#game` and the panel is appended to `body` — so a right-click on a tile
  bubbles tile → `#inventory` → `body` and passes through neither. The existing checks were
  structurally unable to see it: they right-click at a hardcoded viewport centre, which lands
  on the canvas where suppression already worked.
- **`round.forget`-shaped trap avoided in the check.** The kit-refusal assertion first
  compared `worldItems` before and after — and went red, because `ITEM_SPAWN_INTERVAL` keeps
  adding to the world and the window has a wait in it. It compares the **bag** now, which
  only this client changes. The same mistake had already been made and fixed in the Rust
  test, where `items.len()` read 9.
- **The starting kit is not always in the quick bar.** The drag steps earlier in
  `inventory-ui` move things, and a backpack tile is `display:none` while the bag is shut,
  which Playwright refuses to click. The check opens the bag the way a player would.

### Out of scope and done anyway: `night-combat`'s light sample (T19.22)

**Say so plainly: this is T19.22's file, not T20.09's.** It went red in **three** of this
shift's gates with "gunfire emits only 2 lights" and green 3/3 standalone, and it blocks every
remaining task, so it was repaired rather than worked around.

The defect is the documented one. `night-combat.mjs` starts an interval firing an smg every
40 ms, waits **400 ms bare**, waits for `projectiles > 0`, waits **another 400 ms bare**, and
then samples `ordnance().lights` **once**, requiring 3. How many rounds are alive at one
instant of a continuous stream is a lottery: 3 on an idle box, 2 under gate load. The sleep is
now a `waitForFunction` on `lights >= 3` with the **threshold untouched** — a client that
genuinely emits fewer never satisfies the poll and fails below with the same message and the
same number. It is not a weakening; it is a window in which to observe the condition.

**And it exposed something T19.22 should know.** On the very run that passed, the later
`during sustained fire` read printed `lights: 2` — so the true count oscillates between 2 and
3 against a floor of 3. The sampling is fixed; the **margin** is thin, and re-deriving that
floor is still T19.22's question.

## T20.13 landed — the server was never the subject, and Phaser kills the loop on one throw

The reporter's guess (*"maybe the backend tries to start 2 matches at the same time"*) is wrong,
and so was the in-flight diff's own header, which said the bug *"does not reproduce"*. It
reproduces. It is one client-side defect with two visible halves, and both halves are now
asserted in `scripts/checks/rematch.mjs`, each falsified at the live binding site.

### The mechanism, in the order it has to be read

1. **Phaser constructs a `Scene` once and `create()`s it on every `scene.start('Game')`.** So
   every `GameScene` field with a `= value` initializer is initialised **once for the life of
   the tab** — about thirty of them.
2. `update()` guards on `this.ready && this.world && this.predictor`. After an exit, `ready` is
   still `true` and `world` still points at a `WorldView` whose camera Phaser has destroyed, so
   `CameraRig.update` → `Camera.clampX` throws `Cannot read properties of null (reading 'x')`.
3. **`RequestAnimationFrame.step` calls `_this.callback(time)` and only then re-arms itself**
   (`client/node_modules/.vite/deps/phaser.js`, the `RequestAnimationFrame` class). One throw
   out of `update` means `requestAnimationFrame` is never called again: **the render loop is
   dead for the life of the page.** That is *"an empty screen… but if I refresh the stuck page
   it starts fine"* — a refresh builds a new `Scene`.
4. `create()` is `async` and **Phaser does not await it**, so `update()` also runs against the
   stale fields during `loadAssetManifest`/`runLoader`. Any reset placed after those awaits
   would leave the window open.
5. `scores` is one of those fields, the Tab scoreboard and `ResultsScreen` are both fed from it,
   the `lobby_state` handler **seeds rather than overwrites**, and the only removal is
   `dropRemote` on a `player_leave` — **the path where the *other* player leaves.** So the
   previous room's players ride into the next match's roster. That is *"they both appear on the
   list"*, literally, and the coordinator's reopening of it was correct.

**Measured, both directions.** With `resetForNewRound()` in place `rematch` is green; with the
five field-clears removed it fails on `pageerror` with the `Camera.clampX` stack, and with only
`this.scores.clear()` replaced by a no-op mention it fails with
`the leaver's new match lists a player from the room she left: ["ana","bo"]`.

### The instrument that was the bug, and it was in the in-flight check

`started()` polls `debug().phase`. **That field is written by the websocket handler, which runs
on the event loop and knows nothing about rendering** — so on a page whose render loop was dead
it read `playing` while the canvas held its last frame. Measured: in the falsification run
`the player who left and quick-matched is in a running round` printed **ok** on the broken
build. `rematch.mjs` therefore asserts on **pixels**: a 320x240 patch of the leaver's canvas
before and after 600 ms of held `d`, with **bo's canvas over the same window as the control**
(if his frame is frozen too, the box stalled and the leaver's frame proves nothing). The
discriminator is the digest, not the mean — a dead loop produces two byte-identical frames,
which is why the small means (0.7 vs 15.4 in one run) never decide anything.

### The fix is one list, not five more hand-written nulls

`GameScene.resetForNewRound()` is called from the **top of `create()`, before its first
`await`**, and from `SHUTDOWN`. The teardown keeps its `destroy()` calls — only the teardown
knows the objects are going away — and no longer nulls seven fields by hand while leaving
twenty-three. `observed` moved to a module-level `freshObserved()` factory so the sixty-line
literal has one copy.

`client/src/scenes/gameScene-reset.test.ts` is the guard: it walks the source for every
`private` field declaration and fails if one is named neither in `resetForNewRound` nor in an
exemption table that carries a reason per name (the `!` fields `create()` rebuilds; the `Mixer`
and its unlock closure, which keep decoded buffers on purpose; `RepeatFire`, which self-heals on
the first frame the button is not held). It includes its own falsification — a synthetic
`private carriedOver = 0` is caught and named.

**`FogClock.clear()` is new** and is not a synonym for `end()`: `end` is the *event* and
refuses an id that is not this fog's, which is the rule the class exists to hold. A scene
discarding a round has no `effect_end` and no id to quote. Without it a fog running at the
final whistle veiled the **next** match. Tested with `f.end(-1)` as the control that shows the
refusal is real.

### `?game=1` had the same defect and its check could not see it

`ScenePlugin.start` queues a stop of the current scene and a start of the key; **a missing key
makes the stop happen and the start do nothing, leaving no running scene at all.** Silent. No
warning, no exception. `?menu=1` shipped `[Menu, Skins, Game]` and `?game=1` shipped `[Game]`
alone, and `GameScene` has two `scene.start('Title')` callers.

`escape-menu.mjs` reaches the game through `?e2e=1&game=1`, clicks `#escape-quit` and asserted
`document.querySelector('canvas') !== null`. **Phaser's canvas belongs to the `Game`, not to a
`Scene`, and outlives every scene** — so it was green over exactly the blank page it was written
to catch. It now waits for `#start-game`, the title screen's own button.

Rather than patch two lists, `main.ts` declares `SCENE_GRAPH` (who starts whom) and
`closeOverStarts()` appends every reachable scene to any dev list; additions go on the **end**,
because Phaser starts the array's first scene and only adds the rest, so each flag still lands
where it says. `client/src/scene-graph.test.ts` walks `src/scenes/*Scene.ts` for
`scene.start('X')` and fails if the table has fallen behind — with comments stripped first,
because `GameScene`'s own prose says the words `scene.start('Game')` and made the scene an edge
to itself.

### `restart_wins` ignoring `connected` is intended, and now says so

The doc's first line claimed *"Majority of **connected** players"* while the body is a majority
of the votes **cast** and discards the argument. The second paragraph and
`non_voters_abstain_rather_than_veto` (two yes of six connected, asserted to restart) both
describe the shipped behaviour, so the first line was the stale half and is corrected. The
parameter stays: it is what lets that test *say* "six connected". The consequence the task asked
to state: **one remaining player can restart a round for a room everyone else has left.** That
is intended — and requiring a majority of connected would not change it (one yes of one
connected still wins), it would only turn silence into a veto in the many-player case, which is
what the rule exists to avoid.

### `deepcut.name` had three hand-spelled copies; now it has none

`scripts/lib/client-keys.mjs` reads the `*_KEY` exports out of `client/src/ui/skins.ts` — the
same argument `rust-constants.mjs` makes about tunables. It **throws** on a name that is not
exported, because a reader returning `undefined` would leave `localStorage.setItem(undefined, …)`
succeeding forever and every "the roster names the player" assertion passing against the default
name. `lobby.mjs`, `m10-checkpoint.mjs` and `rematch.mjs` all go through it.

### Two rooms is correct, and is asserted as such

`quick_match` skips `e.private || e.handle.has_started() || e.humans >= max_players`, and room #1
is `has_started()` for the whole of its 20 s `Ended` window and again the moment it restarts. So
the sequence yields two rooms by design; `rematch.mjs` asserts `health.rooms === 2` so a change
that silently merged them is noticed, not because two rooms is a fault. `/healthz`'s `players` is
**not** used: it is a gauge every room overwrites on its own tick, so with two rooms it is
whichever ticked last.

### ⚠ Found on this path and **not fixed** — a phantom `tick overrun`, once a second, forever

`rematch` logs `WARN game::sim: tick overrun lagging=2987` once a second from the moment the
restarted room is about a second old, and it never stops. It is not load. The mechanism is
complete:

- `room.rs:2954` computes `expected` from `start.elapsed()`, and `start` is re-based only at
  `was_lobby && !in_lobby` (`:2852`) — the Lobby→round transition.
- `begin_round` carries the tick across that boundary (`room.rs:1087`, `world.tick =
  self.lobby_tick`). **`Room::restart` does not**: it installs a `World::with_generator` at tick
  0 (`:2510-2515`) and nothing re-bases `start`.
- So after a restart `expected` counts from the *first* round's start while `room.tick()` counts
  from 0. 2987 ticks ÷ `SIM_HZ` 60 = 49.8 s = `ROUND_SECONDS 20 + WARMUP 10 + ENDED 20`, exactly
  the elapsed round. `lag_warned_at` is 0 because round 1 was healthy, so the once-a-second
  throttle arms at tick 61 and fires forever after.

**Effect: `tick_overruns` and the `game::sim` warning are permanently wrong for any room that
has replayed** — an operational instrument that will lie to T20.14's load test. Left alone
deliberately: the obvious one-line fix (give `restart` the `world.tick = self.lobby_tick` line
`begin_round` already has) changes the tick numbers written into replay recordings, and
"measure before changing" says that needs its own task with `replay_run.rs` in front of it.
**Booking it is recommended.**

### Smaller things

- **Four `?.click()` calls became `mustClick`** (Playwright's `page.click`). A silent no-op on a
  missing `#quick` cost the whole of the next 120 s timeout and then reported "never got a
  match" about a click that never happened.
- **Two bare sleeps are gone.** The 300 ms between the replay vote and the exit is now a wait on
  `.results-again[disabled]` — `ResultsScreen` disables the button and relabels it `Voted` when
  the vote is sent, so the check waits on the **effect**; the 400 ms before `#quick` is what
  `mustClick` already waits for.
- **`?skins=1` and the player list also go through `closeOverStarts`.** The player list is still
  spelled in full — it is the shipped path and should not depend on the table being right; the
  closure is a no-op over it, and stays one only while the table is complete.


## T20.15 landed — and the task's first option is the one that had to be refused

The defect is as reported: `scripts/checks/lobby-start.mjs` built a `waitForFunction` timeout
from `constants().LOBBY_BOT_TIMEOUT`, which is not in `constants_json`. `undefined`, then
`(undefined + 8) * 1000` → `NaN`, and **Playwright treats a `NaN` timeout as no deadline** —
so the wait could not fail when the thing it waited for never happened.

### Exporting the constant would have made the check red, for the wrong reason

The task offered two repairs and named the four-place export first. **It is wrong at this
site.** `lobby-start.mjs` spawns its own server with `LOBBY_BOT_TIMEOUT=45` (its own comment
says why: at the shipped 10 s a cold page has not reached `ready` before §E2 fires, so the
lobby cannot be observed at all). `constants_json` would have handed back the shipped **10.0**,
giving an 18 s deadline against an event **45 s** away. Measured in this shift's run: *"a solo
lobby started itself after ~44.5s"*.

So the deadline comes from the value that actually governs it. `LOBBY_BOT_TIMEOUT_S` is
declared once and feeds both the env block and the wait — it is the check's own configuration,
not a shipped tunable, and reading it from `constants.rs` would be reading the number this
check exists to *replace*. `LOBBY_BOT_TIMEOUT` is deliberately **not** added to
`constants_json`: a constant exported for one caller that must not use it is a mechanism wired
to nothing.

### The grep was the deliverable, and it found three more

Every `window.__game.constants().NAME` in `scripts/`, against `constants_json`:

- `LOBBY_BOT_TIMEOUT` — the known site, the only genuinely missing name.
- **`GRAVITY`, `BIRD_DROP_VELOCITY`, `CHUNK_REBAKE_MS` are in `constants_json` and were not in
  the `Constants` interface.** So a browser check could read them and TypeScript could not —
  the same drift one layer up, and the direction that produces the next `undefined`. Added.
- Nothing in the interface was missing from the table.

### Three guards, at the three seams, each falsified at its live site

1. **The read.** `strictConstants()` (`client/src/core/index.ts`) returns a `Proxy` over `C()`
   that throws on a `SCREAMING_CASE` key that is not there. Both dev handles —
   `GameScene.exposeDebugHandle` and `SandboxScene` — return it instead of `C()`, and the test
   asserts that from the source, because *a test calling `strictConstants` is not a caller*.
   Only SCREAMING_CASE keys are policed: `JSON.stringify` asks for `toJSON`, promise resolution
   asks for `then`, and Playwright's serialiser walks the object.
2. **The arithmetic.** `scripts/lib/deadline.mjs`'s `deadlineMs(seconds, label)` throws unless
   `seconds` is a positive finite number, and names the wait. It survives a deadline derived
   from anything else — an env override, a response body, a parsed log line — which the read
   guard does not.
3. **The tables.** `constants-parity.test.ts` asserts `constants_json` and the `Constants`
   interface are the same set **in both directions**, and that no `.mjs` reads a constant that
   is not in the table. Falsified by deleting `GRAVITY` from the interface and by putting
   `return C()` back in `GameScene`'s handle; both go red and name what they caught.

The control the task asked for is in the same file: the same read on plain `C()` is `undefined`
and silent, and `undefined + 8` is asserted to be `NaN` — the defect itself, kept as the thing
the guard is measured against.

## T20.05 landed — the ruling holds, and the number that joins the two rains is measured

Both `docs/72` clauses stay satisfied. §C6 keeps its particle emitter — the pool is still a
fixed 260 screen-space droplets on seed 4242, and it is still `setScrollFactor(0)`. §C21 gets
a rain whose **visible density is the rain that actually falls on you**: `WeatherLayer.setToxic`
takes a live drop count instead of a boolean, and `RainField` draws that share of the pool.

### Constraint (a): the naive figure was 37x out, and the real one was measured

The task's SUSPECTED ~7 is right, and it now rests on a measurement rather than on
`TOXIC_DROP_SPEED`'s *"roughly a second of visible descent"*.
`toxic_drops_in_flight_matches_what_a_shower_actually_puts_in_the_air` (`world/mod.rs`) runs a
forced shower on three seeds x three scales and records the peak count of live
`WEAPON_TOXIC_DROP` projectiles: **6 on small, 7 on medium, 9-10 on large**, mean 3.9/4.3/5.8
while it is raining. `TOXIC_DROPS_IN_FLIGHT = 7.0` is asserted to sit **inside that band**
rather than pinned to one draw — a constant pinned to seed 4242's maximum would be a fact
about seed 4242. Falsified at 20: the test names the band.

Not `TOXIC_DURATION / TOXIC_DROP_EVERY` = 54, which the Deliverable quotes: that is the
cumulative count for a whole shower, against a *live* on-screen figure.

### The second thing that test proves, and the design that rests on it

**A shower never has a frame with no drop in the air** — asserted directly, across every
seed and scale. That is what lets the client derive *"is it raining"* from `liveDrops > 0`
instead of carrying a separate `active` flag, and deriving it is strictly better: the sheet
now stops when the **last drop lands** rather than when the server's effect phase flips.
`TOXIC_DROP_EVERY` (0.15 s) against a descent of about a second is what buys that; if the
cadence ever grows past the descent the test goes red before the sheet strobes.

### `density` and `intensity` are two scalars, deliberately

`intensity` is *whether* — it ramps the fade and drives the green vignette. `density` is *how
hard* — it drives the count. One field for both would make a shower fading in at full rate
indistinguishable from one fully present and nearly dry, which is the "a field that means two
things" rule. Both ride the same 1.5 s ramp, so a drop landing does not pop 37 droplets off
the screen; `RainField.update`'s `density` argument is **required**, not defaulted, because a
default of 1 is exactly the old bug and would let an unwired caller compile and reproduce it.

### Constraint (c) and the BLOCKER: the count comes from `WorldView`, and both sites read it

`WorldView.liveToxicDrops` counts `drop`-kind projectiles in the ordnance layer that
`syncProjectiles` already fills, so neither scene computes it. `worldView.update`'s weather
block reads it; `SandboxScene` reads it too, because that scene calls `world.update(...)` with
no `dt` and so skips the shared block entirely. `toxicActive` is **gone** from the weather
parameter — it came from the effect lifecycle while the damage came from the projectile
stream, which is the whole defect.

### The BLOCKER was real, and the answer was a check that is not a sandbox check

Every weather assertion in this tree drives `?sandbox=1` — `weather-visible.mjs` and
`m5-weather.mjs` both. **So nothing could see the shared `WorldView` path**, which is the §C0
shape that hid a broken `ordnance.update` for three milestones. Under the new derivation the
game path depends on six hops nobody had ever asserted end to end (server spawn →
`announce_projectiles` → `projectile_spawn` → mirror → `syncProjectiles` → `WEAPON_KEYS[23]` →
`KIND_BY_WEAPON_KEY`), **and every one of them fails to a count of zero, which now reads as a
dry sky rather than an error.**

`scripts/checks/toxic-rain-game.mjs` walks it in a real round under `WEATHER=toxic`, with a dry
control before the shower. It passed first time — 1 real drop, density 0.14, then 196 of 260
droplets a ramp later — and the falsification (removing `setToxic` from the shared block)
turns it red on both halves while `weather-visible` stays green. That pair is the evidence
that the two scenes are now wired the same way.

### Where the assertions are, and why two of them

`weather-visible.mjs` asserts the **derivation exactly** (`toxicDensityAsked === live / full`)
and, separately, that the drawn count is a slice of the pool. The first is exact because it
reads the pre-ramp target; the drawn count lags by design and is the wrong thing to compare a
formula against. The pixel assertion is untouched and still passes: the sky delta moved from
~63 to **44.5** against a 4.9 noise floor, because the vignette stays on `intensity`.

`weather-visible.mjs:293`'s fragility, which the task predicted, did not materialise — the
drawn count is 229 of 260 at the sample point, not 0. The reason is the ramp: `density` is a
smoothed average of the live count, not the instantaneous one.

### Smaller things

- `EmberField.update(dt, gravity)` had picked up a stray third argument in the test file from a
  bulk edit; corrected.
- The `Constants` interface gained `TOXIC_DROPS_IN_FLIGHT`, and **T20.15's parity test caught
  the missing `constants_json` entry before any check ran** — the guard doing its job on the
  next task after it landed.

## T20.07 landed — a spec clause reversed, and `REPLAY_VERSION` moved once for two tasks

### ⚠ THE THING THE NEXT CODER MUST READ: `REPLAY_VERSION` is now 5

**T20.08 must NOT bump it again.** The bump is recorded in `replay.rs`'s doc comment as
covering both tasks, and it names the trap: T20.09 added a *command* in the same window and
correctly did not bump, because a new tag leaves an old file replaying byte for byte.
Same-sounding question, opposite answers. If T20.08 lands after this, it deletes
`shield_until` from the same hashed block and rides this bump.

### The reversal, and what it is not

`docs/72` §C13 specifies the trade — the flashlight *shrinks* ambient sight and buys a cone —
and the coordinator asked for the opposite. **`docs/` is untouched**; the override is recorded
in the task file, in `constants.rs`, and in `cycle.rs`'s and `lightmap-math.ts`'s doc comments.

- **`FLASHLIGHT_AMBIENT_MULT` (0.65) → `FLASHLIGHT_FOV_MULT` (1.5)**, applied only where
  `night > 0`. A torch at noon is not a telescope, and an unconditional 1.5x would make the
  flashlight the strongest item in the game during the phase it is least needed.
- **`FLASHLIGHT_FOG_VEIL_MULT` = 0.8**, and the choice is argued in its doc comment. The brief
  said *"20 % more visible"*, which is three pictures. `alpha − 0.2` **inverts**: at a light
  fog of alpha 0.15 a flashlight erases the effect and below that goes negative. The
  transmitted-light reading (alpha 0.8 → 0.76) is defensible in optics and **unassertable
  here** — `fog-visible` measures a sky delta of ~48 for a full veil, so 0.04 of alpha is ~2.4
  units against a measured noise floor of 5.4. A rule nobody can measure breaks quietly.
  Multiplicative also keeps the benefit proportional as the fog's own ramp climbs.

### The four dead mechanisms, and what happened to each

1. **Six hardcoded `flashlightOn: false`** — two in `GameScene`, **four in `SandboxScene`**.
   All six now read a real value. That split is why the falsification is split: `night-combat`
   drives the sandbox, `fog-visible` drives `GameScene`, and fixing one pair would leave the
   other check staring at unchanged literals. **Named, per the task's instruction**: the
   sandbox falsification broke `SandboxScene`'s lightmap site (the `lastFov` branch), giving
   `110.0 -> 110.0, not 165.0`; the `GameScene` one broke the `world.update(...)` weather
   argument, giving `filled at 0.800, not 0.640` plus both pixel patches.
2. **`FLAG.flashlight` had no production reader.** `GameScene` now reads bit 4 into
   `hasFlashlight`, beside `shieldOn` and `poisoned`, and never predicts it.
3. **`collectLightSources` still has no production caller** — left alone, as the task says, so
   T19.20 is not duplicated. **The cone is kept, deliberately**: the brief adds a passive
   radius and says nothing about removing the cone, and deleting it in passing would be a
   design change beyond it. **The consequence needs a decision from whoever wires it**: a
   carried flashlight now emits a cone that cannot be switched off. That is recorded on
   `PlayerLight.hasFlashlight` where T19.20 will read it.
4. **The toggle path is deleted**: `Player::flashlight_on`, `World::toggle_flashlight`,
   `Command::ToggleFlashlight`, `ReplayCommand::ToggleFlashlight` (tag 7), the
   `toggle_flashlight` socket handler and `Connection.sendToggleFlashlight`. `use_item` on a
   `Utility` is now `Err(UseError::WrongKind)` rather than a silent `Ok` — a no-op success
   would tell the client the press landed.

**`button::FLASHLIGHT` and `flashlight_pressed` are deliberately left**, and this is a
reported gap rather than an oversight: they are a bit in the **input bitfield**, removing one
renumbers the rest, and `docs/40` §3 describes that layout. That is a wire change a builder
should not make unilaterally. Nothing sets the bit (`keydown-F` is bound to `sendFire`), so it
is inert — **worth booking**.

### Tag 7 is a hole, not a reuse

`every_command_really_is_every_command` now expects 21 tags and **asserts 7 is absent**, with
the reason: renumbering would make every later command's encoding depend on this one's
removal, for nothing, and no file that could contain a 7 gets past the version check.

### `DEV_FLASHLIGHT=1`, and why a knob rather than the dev loadout

The flashlight is the **commonest buried item by design** — "dig for it before nightfall" is a
strategy `registry.rs` protects with a weight — so a check that waited for one to be dug up
would be waiting on the generator and the shovel. Adding it to `DEV_LOADOUT` would have given
every existing check a torch and changed their night radius. So it is a sibling of
`DEV_POISONED`: off by default (asserted), applied independently of `dev_loadout`, in the
startup summary, and **not in the replay header** — only `dev_loadout` is recorded there, and
adding a field is a header layout change with its own version consequence.

### An instrument defect found and fixed on the way

**`SandboxScene`'s `debug().fov` recomputed `fovRadius` itself** — a third copy of the
formula, and an *intention*: it would have reported a widened radius from a scene whose
lightmap was still rendering the old one, and it silently ignored `fovOverride`. It reports
`lastFov`, the radius the lightmap actually drew with, so `night-combat`'s assertion is about
the effect. That change is what makes the sandbox falsification meaningful — against the old
handle, breaking the render site would have left the number green.

### Numbers, for the next person who touches these constants

Night radius `110.0 → 165.0` with a torch; day radius `320.0` unchanged (the control). The
veil fills at `0.640` against `0.800`, and the pixels move `48.1 → 38.1` (sky) and
`35.3 → 27.9` (ground) against predictions of 9.6 and 7.1 of removed travel.

**One assertion was deliberately dropped as a coin flip.** A first draft failed when
`gap <= noiseFloor`; the ground gap is 7.4 against a noise floor that runs 4.9-5.6, which is a
gate that fails on a draw. The two-sided comparison against the predicted gap is both stronger
and stable — a flashlight that does nothing gives a gap of 0 and fails by the whole distance,
which is what the falsification measured (0.6 and 0.3 against 9.5 and 7.0).
