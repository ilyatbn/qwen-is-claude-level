# 76 — Amendments v8: what M20 changed under the spec

M20. Eight items, and most of them are the same complaint: **the code moved and the spec
did not.** Each one below was found by building or measuring, not by reading — which is why
they are amendments rather than corrections.

Constants introduced or changed here are as authoritative as `02-constants.md` and must be
mirrored in `crates/game-core/src/constants.rs`.

This document **overrides** `docs/20` §9, `docs/14` §4, `docs/75` §F5 and §F11's shovel row,
and adds rules to `docs/40` and `docs/60` that were absent rather than wrong. Each override is
named at the point it happens.

---

## G1 — Fall damage exists

**Overrides `docs/20`'s "Fall damage — deliberately absent in v1 so the jetpack stays
forgiving."**

Fall damage was built in M20 on the coordinator's 2026-09-04 ruling, and `docs/20` was never
amended to match — so for a milestone the spec refused a shipped feature. Anyone reading
`docs/20` alone would have called it a bug.

- A landing above `FALL_SAFE_SPEED` costs `(impact - FALL_SAFE_SPEED) * FALL_DAMAGE_PER_SPEED`.
- The free drop height is `FALL_SAFE_SPEED² / (2 × GRAVITY)` = **82 px**, about three player
  heights: a ledge you can see is a ledge you can take.
- A player thrown by an explosion is exempt for `KNOCKBACK_FIRE_GRACE`, so a rocket jump is
  not taxed twice.

### G1.1 — And it is half what it was

`FALL_DAMAGE_PER_SPEED` is **0.075**, halved from 0.15 on 2026-09-07 because it was too
aggressive in play. A terminal-velocity landing now costs **31.5** of `BASE_HEALTH` 100 rather
than 63, so the deepest fall in the game is survivable from under two-thirds health.

`FALL_SAFE_SPEED` is untouched — only the slope past the threshold moved, so short falls feel
exactly as they did.

| constant | value | |
|---|---|---|
| `FALL_SAFE_SPEED` | 480.0 | unchanged |
| `FALL_DAMAGE_PER_SPEED` | **0.075** | was 0.15 |

## G2 — The flashlight is passive, and nobody else can see it

**Overrides `docs/14` §4's first and last bullets.** Both were still describing a design the
code had left.

- **There is no toggle.** T20.07 made the flashlight a passive inventory item: carrying it *is*
  the decision. `F` is now Fire, and `toggle_flashlight` no longer exists on the wire. §4's
  "Toggled with `F` … sends `toggle_flashlight` to the server" is withdrawn.
- **It is not visible to other players.** §4's beacon clause — *"Your cone is drawn in
  everyone's lightmap … Long sightlines at the cost of being seen first"* — is **withdrawn on
  the game designer's ruling of 2026-09-08**: *"leave it as is. this is as intented."*

The flashlight is therefore a straight upgrade: a longer view for whoever finds one, with no
tell. That is a deliberate departure from the original trade, not an oversight, and the cone
machinery built for the beacon is deleted rather than disabled (T19.20).

**What survives from §4 is less than §4 describes, and an earlier draft of this section got it
wrong in both directions.** Corrected after the deletion landed:

- **There is no cone on screen at all**, not even for the carrier. The only cone the client
  ever built lived inside the never-called path deleted by T19.20, so §4's cone was never
  rendered for anybody. `FLASHLIGHT_RANGE` (260) and `FLASHLIGHT_CONE_DEG` (55) are now
  defined, bridged through wasm, typed in TS, and **read by nothing**. They are left in place
  for now; retiring them is a separate change and should be booked, not folded in.
- **The ambient radius is widened, not reduced.** §4 and the old `FLASHLIGHT_AMBIENT_MULT`
  (0.65) *shrank* your ambient sight in exchange for the cone. With no cone, that trade had
  nothing on the other side of it, so T20.07 replaced it with `FLASHLIGHT_FOV_MULT` = **1.5**.
  Carrying a flashlight now simply lets you see half again as far.

So the shipped flashlight is: **a wider view, no cone, no toggle, no tell, and no fuel cost.**
That is the whole of it, and it is what the game does today.

## G3 — The shovel digs a hole you can walk into

**Overrides `docs/75` §F5 and its `SHOVEL_CARVE` row.**

Two defects reported from play, one cause:

- The carve was a circle placed at the **tip** of the swing, leaving a lip of untouched ground
  between the player and the hole they had just dug — a room you could see into and not enter.
  It is now a **capsule swept from the swinger's body edge to the tip**, so there is no gap.
  The sweep starts at the edge rather than the centre, so a swing still opens the wall it is
  aimed at without dropping the swinger through the floor.
- One dig now clears a **player-height** opening along its whole length, not only at its widest
  point.

| constant | value | |
|---|---|---|
| `SHOVEL_CARVE` | **`PLAYER_H / 2 + 2` = 16.0** | was 14.0; sized to clear `PLAYER_H + 4` |

At 14 the opening was exactly `PLAYER_H` at its best point and caught on any slope.

**This applies to every carving melee weapon** — the axe and hammer share the code path. Knife,
bat and whip carve nothing and are unaffected.

## G4 — What the join catch-up may tell you

**New. `docs/40` had no rule for the catch-up at all**, which is how the leak below survived.

A socket seated into a room that already has a world is sent the state it missed: the map, the
items on the ground, and the graves. That catch-up **must disclose no more than watching would
have.**

- **A crate's contents are withheld.** The catch-up announces an unopened crate with position
  only — the same shape `crate_spawn` has — never `item_id` or `count`. Watching a crate land
  tells you nothing about what is in it, and arriving late must not tell you more.
- Ordinary ground items keep their `item_id`: a player who walks in can see them, so a joiner
  may too.

`SpawnSource::Crate` means exactly one thing: **this world item is an unopened crate.** It is
not a provenance marker for items that came out of one.

## G5 — Ignored tests are part of the suite

**New. `docs/60-testing.md` did not mention them**, and thirteen tests went unrun for nine
milestones because nothing said they should be.

- A test marked `#[ignore]` is **still owned**. Measurements that print and cannot fail are
  reports; everything else is a guard, and a guard that never runs is not a guard.
- **`scripts/ignored.sh` runs all of them** in release with a recorded expectation per test,
  and fails on any deviation in either direction. It is not in `check.sh` — it needs a release
  build the gate does not make — so it is a ritual, and saying so is part of the rule.
- **`scripts/verify-repo.mjs` is the mechanical half** and runs in the gate's always-on
  section: every `#[ignore]` must appear in the manifest and vice versa, so the ignored set
  cannot grow silently again.
- **Classify by whether a test can fail, never by counting assertions.** The broadest
  correctness claim in the repository fails through `panic!` and has no `assert` in it at all.

## G6 — What a constant's value is measured against

**New, and it is the lesson M20 paid most for.**

Every test here pins its numbers to the constants, exactly as `02-constants.md` requires. The
consequence, measured: **changing a constant's value breaks nothing.** Tripling
`ITEM_SPAWN_INTERVAL` leaves all 1296 gate tests passing *and* every ignored measurement
passing, because every assertion moves with it.

So a tunable whose **value** matters — not merely its consistency — needs one assertion of a
different kind:

- against a **golden**, the way the map mask table catches every terrain parameter; or
- against a **quoted basis** the repository already states about itself, the way the spawn-rate
  floor asserts the opening wait against the numbers `ITEM_SPAWN_INTERVAL`'s own doc records it
  as having tuned away from.

A floor chosen because it sits near today's value is a fitted number wearing a basis. Quote
something, or measure something; do not fit.

## G7 — Rooms are freed on every path out

**Clarifies `docs/41`.** Three ways a room could be held forever, all fixed in M20:

- A socket dropping **mid-join** left the room's human count raised with nothing able to lower
  it, so the room could never be reaped. Freeing a socket's seat, session row and registry
  count is now one function, called both by the disconnect handler and by the join path itself.
- A **room hop** freed the seat in the room you arrived at and not the one you left.
- The room-health metric was a lifetime high-water mark that could only climb, so a server that
  recovered still read as overloaded. It now ages over a trailing window.

**Room capacity is not the binding limit.** Measured at 48 clients: the table saturates at
`MAX_ROOMS` with **zero humans in it**, while thousands of joins are refused. What binds is how
long an empty room is held, not how many rooms there are — raising `MAX_ROOMS` buys more empty
rooms. That is an open question, not a decision made here.

## G8 — The replay version is a compatibility record, not a changelog

**Clarifies `docs/41`'s replay section.**

`REPLAY_VERSION` is bumped when an old recording would **load, run, and silently disagree** —
not when a new command tag is added, which leaves old files replaying byte for byte.

One bump may cover several breaks in the same unreleased window, and should: bumping twice
would reject every recording twice over for what is one break in compatibility. **But the
version's note must name every change it covers.** Version 6 carries two — the fall-damage
retune above, and a movement change from flooring health before the speed multiplier — and a
note that named only the first would send the next person debugging a divergence looking in
the wrong place.
