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
