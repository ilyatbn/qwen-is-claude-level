# Handoff — Phase 5 (Assets, skins, ops; T5.1–T5.5)

**The build is complete: 47/47 tasks, 56 deviations.** This is the last handoff.

State after this phase: the game boots, joins, renders the server's map, plays a full
round with weather and scoring, shows a lobby with skin selection, and reports kills in a
HUD feed — **entirely on placeholder graphics**, because the three asset packs the design
names do not exist at the URLs it gives.

Commits `8f3a5aa` (the `json!` class fix that preceded T5.1) … `b8c4c6a`, plus `a7e45f0`
(the coordinator's documentation corrections).

---

## Where the code lives

| File | Added this phase |
|---|---|
| `client/src/assets/manifest.ts` | Texture-key ↔ file registry, load-entry expansion, validation. Phaser-free. **New.** |
| `client/src/assets/manifest.json` | The registry itself, docs/07 §2 shape, version 1. **New.** |
| `client/src/assets/placeholders.ts` | A canvas spec for **every** texture key. **New.** |
| `client/src/logic/tileVariant.ts` | `(seed + x + y) % 3`, rewritten for u64 seeds (D51). **New.** |
| `client/src/logic/hudModel.ts` | Round clock, day/night icon, `KillFeed`, `scoreDelta`. **New.** |
| `client/src/logic/preferences.ts` | localStorage index get/set, strict parsing. **New.** |
| `client/src/scenes/BootScene.ts` | Rewritten: placeholders first, then manifest loads, per-key fallback, frame-rect cutting. |
| `client/src/scenes/LobbyScene.ts` | Skin + weapon-skin pickers, roster, countdown. Now actually **started** and wired. |
| `client/src/hud/Hud.ts` | Clock, day/night icon, kill feed, score popups, UI-textured bar fills. |
| `client/src/entities/PlayerSprite.ts` | Body is `player_<skin>`, falling back to the id-coloured rect. |
| `client/src/entities/Terrain.ts` | Tile texture by seed variant. |
| `client/src/main.ts` | Joins on connect; routes `lobby_state`, `player_joined`, `player_left`, `kill`; forwards lobby actions. |
| `server/server/src/rooms.rs` | `lobby_state()`, `set_skin()`, idempotent `join`. |
| `server/server/src/net.rs` | Emits the three lobby events; typed `Joined`. |
| `server/server/src/tick.rs` | `event_payload` — all 13 S→C payloads through their structs. |
| `scripts/wire-coverage.sh` | Every `s2c` constant must have an emit site. **New.** |
| `client/scripts/{event,lobby,log,combat,kill}-check.mjs` | Live checks. **New.** |
| `Dockerfile`, `docker-compose.yml`, `.dockerignore` | Written, **never built** (see below). |
| `assets/` | Ships **empty** apart from a README and a `.gitignore`. |

## Public entry points

| Entry | Contract |
|---|---|
| `loadEntries(manifest)` | manifest → `{key, file, frame?}[]`. A section in placeholder mode contributes nothing. |
| `manifestProblem(manifest)` | `null`, or why the loader refuses it (wrong version, <3 variants). |
| `allTextureKeys()` | Every key the renderer can ask for. **Derived** from the same constants the key functions use — do not hand-maintain it. |
| `placeholderFor(key)` | The canvas spec for a key. Every key in `allTextureKeys()` has one; a test fails if not. |
| `tileVariantIndex(seed, x, y)` | The docs/07 §2 formula, made safe above 2^53 (D51). |
| `KillFeed.add/visible/alpha/prune` | Feed retention (5) and fade (4 s), time passed in. |
| `scoreDelta(kill, playerId)` | Mirrors `Round::kill`: victim −1 always; killer +1 only when a different player. |
| `Room::lobby_state()` | The `lobby_state` payload. Caller must drop the `MutexGuard` before awaiting the emit. |
| `Room::set_skin(socket, skin, weapon_skin)` | Out-of-range values **ignored, not clamped**. |
| `event_payload(event, map_data)` | `Event` → `(wire name, JSON)`. **No wildcard arm** — a new `Event` variant fails to compile until it has a payload. |

---

## Verified vs. not verified

**Read this section before trusting anything above.**

| Claim | Status |
|---|---|
| Client renders the server's map | **Verified** — client's decoded grid fingerprints `19a42d92b118724a`, 5455 solid, byte-identical to the server's independent fingerprint; diverges by exactly 8 after 8 `tile_destroyed` |
| All 19 S→C events have an emit site | **Verified** statically (`wire-coverage.sh`) |
| 9 event types match docs/06 §2 **on the wire** | **Verified** live (`event-check.mjs`) |
| Lobby roster, skin broadcast, join/leave notices | **Verified** live, two clients (`lobby-check.mjs`) |
| `kill` reaches a client | **Verified** live (`combat-check.mjs`) — bots arm themselves and rocket their own feet |
| Runtime `set_log_level` | **Verified** live — 0 DEBUG lines before, 1 after, no restart (`log-check.mjs`) |
| Placeholder fallback on a missing asset | **Verified** over HTTP — present file 200 `image/png`, absent 404 |
| **The Docker image** | **NEVER BUILT.** `docker` is not installed here. The image has never been built, the binary never run in a container, and T5.5's handshake `curl` never executed. |
| **Real Kenney art** | **NEVER LOADED.** All three pack URLs 404. Every texture in the game is a canvas placeholder. |
| Anything rendered by Phaser | **Not machine-verified.** No headless browser; scenes are covered only by `tsc`, the build, and the pure logic behind them (D14). |
| T5.1/T5.2/T5.4 Acceptance ("looks different", "visible and non-blocking") | **Not verified** — visual criteria, no browser |

The honest one-line summary: **the wire is well tested, the pixels are not.**

---

## Deviations this phase

| ID | One line |
|---|---|
| **D11** (updated) | All three Kenney URLs re-attempted verbatim → **404**. Host answers, so they are wrong paths, and "Pixel Adventure 1" is not a Kenney pack at all. `assets/` ships empty; docs/07 §2's placeholder escape hatch carries the whole phase. |
| **D13** (rewritten) | Docker not installed; T5.5's files written, image never built. Step 4 verified live because it needs no container. |
| **D47** | `tile_destroyed.item_uncovered` is singular; one blast uncovers many. First uncovered item ships in the field; every one also gets its own `item_spawned`, which is what the client actually spawns from. |
| **D48** (closed) | `player_joined`, `player_left`, `lobby_state` had **no emit site anywhere** and no task owned them. Wired in T5.3; guarded by `wire-coverage.sh`. |
| **D49** | docs/07 §2 spells the item `shield`; the protocol sends `shield_gen`. Texture keys use the **protocol** id, with an explicit mapping, so a lookup with the id off the wire finds the texture. |
| **D50** | docs/07 §5's placeholder table omits the `decor` and `ui` sections docs/07 §2 declares. Placeholders invented for both; the "every key has one" invariant is now a test. |
| **D51** | `(seed + x + y) % 3` collapses to **one variant for ~99.9% of seeds** — above 2^53 a double's spacing exceeds 1, so `+ x + y` rounds back to `seed`. Implemented as `((seed % 3) + x + y) % 3`. |
| **D52** | `weapon_skin` is unimplementable as specified twice over: a per-player value placed on a room payload, and no C2S message carries it. Put on `LobbyPlayer`; sent as an optional field on `select_skin`. |
| **D53** | Three of Phase 5's five Test commands select **none** of the phase's tests — `npm run build` cannot fail for a wrong variant formula or a mis-sized kill feed. Fourth instance of the pattern. |
| **D54** | The manifest is **bundled, not fetched** (T5.1's own Files list puts it in `src/`). Buys a `tsc`-checked type; costs a client rebuild when the manifest *entry* changes (the file itself still needs none). |

Two bugs found by **running** the lobby check, neither visible from the code, both fixed
in T5.3 and recorded under D48: a socket that sent `join_room` twice got **two players**
(the first orphaned at `connected = true` forever, holding a seat), and **the client never
sent `join_room` at all** — it connected and sat idle until the player happened to click
the name field. Every headless check had passed because each one joins itself.

---

## `scripts/wire-coverage.sh`

**What it guards**: every event named in `protocol.rs`'s `s2c` module has at least one
emit site in `server/server/src`. That is the check that would have caught D46 (map
delivery missing for four phases) and D48 (three lobby events never sent) the day they
appeared.

**Run it**: `./scripts/wire-coverage.sh` — exit 0 if clean. Currently **19 events, 0
disclosed gaps.** Constants are parsed out of `protocol.rs`, so a new event is covered the
moment it exists; nothing to hand-maintain.

**Disclosing a gap**: add the constant to the `ALLOW` map with the task that owns it. It
then prints as a `KNOWN GAP` and stops failing. The array is currently empty, which is the
point — a gap has to be written down to be tolerated.

**Its limits, plainly:**
- It proves an emit site **exists**, not that it is reached, correct, or awaited. D44
  (`BroadcastOperators::emit` returning an unpolled Future) would still have passed it.
- It greps for `s2c::NAME`. An emit that spells the event as a string literal is invisible
  to it.
- It only looks at `server/server/src`. An emitter added elsewhere would read as a gap.
- It says nothing about the **payload**. That is `event_payload`'s 12-arm match plus the
  live `event-check.mjs`.

---

## The four standing rules, consolidated

They were earned one phase at a time and have lived in two different handoffs. All four,
in the order learned:

**1. A test described as guarding an invariant must have been seen to fail when that
invariant is violated.** Otherwise call it coverage, not a guard. *(Phase 1 — the
determinism suite compared two runs of the same binary and could not fail.)*

**2. Fix the instance, then sweep for the class before reporting.** Ask *what else has
this shape?* and *what does this change affect that nothing observes?* — answered with a
script over every candidate, not by inspection. Before each gate: **constant sweep**
(inject every documented constant; any zero failure count is unguarded), **Test-command
sweep** (run each verbatim, count what it selects; any zero means the task is gated on
nothing), **interaction sweep** (for any path promoted or rewired, enumerate the input
dimensions it now covers that its predecessor did not). *(Phase 2 — five review rounds
spent on the same failure.)*

**3. Run a full end-to-end pass at every phase gate, including the live server, and treat
failures as blocking.** Sweeps verify each part against its spec; they cannot find a
defect that exists only when the parts combine, because no part is wrong. *(Phase 3 —
D41, a defect 375 unit tests and 83 injections missed. Extended after D44, invisible to
364 tests because they all stop one layer short of the socket.)*

**4. A ticked box means the numbered steps are implemented in the shipping path** — not
that the Test command is green. **Apply it to tasks already ticked, not only the one in
hand: a new rule's first job is a sweep over prior work.** *(Phase 4 — five tasks ticked
whose mechanics were built and never integrated; then the rule failed to fire a second
time within the same phase, on tasks it had not been pointed backwards at.)*

Rule 4's backwards sweep earned its place again in Phase 5: re-reading the steps of
already-ticked tasks found T5.4 step 3 half-done. Rule 2's constant sweep caught a
self-referential assertion **I had written in this same phase**
(`expect(feed.size).toBe(KILL_FEED_MAX)` — zero failures when the constant changed).

---

## What a future session needs to close the three open items

### D51 — the variant formula above 2^53

Currently mitigated, not resolved: the client reduces `seed % 3` first, which keeps the
arithmetic exact but computes it from a **seed that has already lost precision** in
`JSON.parse`. The client's variant layout is therefore self-consistent and deterministic
per seed, but is not the layout the true `u64` would give.

To close it properly the seed must survive the wire as an exact integer. Either send it as
a **decimal string** in `MapData` (a protocol change — `docs/06 §6`, plus the pins and
`TerrainGrid.seed`) and parse it with `BigInt`, or have the **server** send a small
per-tile variant seed (`seed % 3`) it computes itself. The second is cheaper and keeps
docs/07 §2's "no extra protocol data" spirit — one `u8`, not a per-tile field.

Nothing depends on this being wrong today; it changes only which of three textures a tile
gets.

### D52 — `weapon_skin`

Needs a design decision the docs do not contain: **where does a weapon skin live, and how
is it chosen?** The current implementation (a field on `LobbyPlayer`, an optional field on
`select_skin`) is additive and works, but it is an invention, and docs/06 §1 still does not
describe it. To close it, either add `select_weapon_skin { weapon_skin: u8 }` to docs/06 §1
and implement it, or fold the weapon skin into `select_skin` **in the doc** so the
implementation stops being undocumented. Also unresolved: docs/07 §4 says "1 alternate
texture per weapon (`pistol.png` vs `pistol_alt.png`)", and the manifest has no `_alt`
entries — so the weapon skin is currently stored and broadcast but never rendered.

### T5.5 — Docker

Needs `docker` installed, then:

```bash
docker compose up --build -d && sleep 8 && \
  curl -s 'http://localhost:3001/socket.io/?EIO=4&transport=polling' | head -c 200
```

Expect a socket.io handshake JSON. Two things that build is the **first** to exercise, and
so the two most likely to fail:

1. **The dependency-cache layer.** The Dockerfile builds dummy sources to cache
   dependencies, deletes them, copies the real tree, and `touch`es two files to force a
   rebuild. If cargo skips that rebuild, the image ships a **stub binary that starts and
   does nothing** — check the container actually logs `[net] listening on 0.0.0.0:3001`,
   not merely that it started.
2. **The toolchain floor.** The socket handlers use async closures, stable since Rust
   1.85. The image pins only `rust:1-slim-bookworm` and there is no `rust-toolchain.toml`,
   so the build takes whatever 1.x is current.

Also note `.dockerignore` excludes `assets/` entirely: correct today (the image is the
server binary only, and the client is served separately), and wrong the moment anyone
decides the container should serve the client too.

---

## If you pick this up cold

- **`DEVIATIONS.md` is the deliverable**, not an appendix. 56 entries, each recording a
  place the design could not be followed literally and what was done instead. The code is
  the evidence for it.
- Run `./scripts/test-inventory.sh` and `./scripts/wire-coverage.sh` before believing a
  green suite. The first exists because no test runner can detect a **deleted** test; the
  second because no test suite can detect an event that is **never sent**.
- The live checks in `client/scripts/` need a running server:
  `WIPGAME_SEED=4242 ./target/release/server`. Kill it by port (`fuser -k 3001/tcp`) —
  `pkill -f` matches the shell running the command.
- Tick task checkboxes with a **binary-mode** replacement; a text-mode Python write
  converts CRLF→LF across the whole file.
