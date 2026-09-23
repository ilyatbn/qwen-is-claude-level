# Design thoughts — is the shared-simulation netcode sound? (Opus 5.5, 2026-09-24)

The owner's question: *"each game client also holds a copy of the whole server in wasm and they all sync up with the
backend server? is this a normal solution? … would it work in the long run … should we rethink this?"*

Facts behind this are in `ARCHITECTURE-SURVEY.md` (same date); outside precedent in § 5. Short version first.

## The short answer

**Keep the architecture. It's the standard one, and it's the right one for this game.** But the question starts
from a picture that isn't quite what is built, and the real problems are elsewhere. They are fixable without a
rewrite.

- **The client does not run a copy of the server.** In a real match `World::step` (the actual game) never runs in the
  browser. The browser's WASM does three narrow jobs: it **predicts your own movement** so the jetpack responds
  instantly, it **keeps a copy of the terrain** that it only carves when the server says a carve happened, and it
  **computes a few pure shapes** (the flare ribbon, lava vents) from a seed the server sent. Everything that decides
  anything is on the server: who got hit, how much damage, what exploded, what you picked up. The client sends only
  button presses and aim.
- **That is the textbook design for fast action games.** Valve's Source engine says it in so many words: *"the client
  runs exactly the same code and rules the server will use to process the user commands."* Overwatch, Rocket League,
  Teeworlds/DDNet (the closest 2D cousin) and the Rust `lightyear` library all work this way. Its name is
  *server-authoritative with client-side prediction*. The alternative everyone is trying to avoid is a player's own
  jetpack lagging by a full network round trip.
- **This project does one thing better than most:** the shared code is literally one Rust crate compiled twice.
  Teeworlds and DDNet share their movement code, but DDNet's expanded prediction was built by *copying* server logic
  into the client, and its author calls that duplication the unsolved part.
- **The rest of the design is sound too:**
  - **Determinism:** the "no bit-exact determinism required" stance (`docs/01`) is right, because snapshots correct
    drift.
  - **Terrain:** carving by event, with a sequence number, a periodic checksum and a full resync, is the standard
    hybrid.
  - **Timing:** 60 Hz simulation, 20 Hz snapshots and 100 ms interpolation are exactly Source's defaults.

**Where the pain actually comes from.** The bug history (`ARCHITECTURE-SURVEY.md` § 6) is dominated by one class:
**two sources of truth that have to be kept in step by hand**. There are three places this happens, and the
architecture doesn't require any of them. That is where I would spend effort.

## What I would change, in order of payoff

### 1. The sandbox should run the real game, not a third simulation (biggest)
**Today** the sandbox (`?sandbox=1`) is a hand-written mini-simulation: `GameCore::combat_step` and `weather_step`
copy rules out of `World`. `SandboxScene.ts` is a 1 690-line parallel copy of the 3 594-line `GameScene.ts`, with no
shared base.

**38 of the 87 browser checks run in the sandbox.** Nearly half the visual test suite therefore tests a program
players never run. The history shows the cost:
- T13.01: the real game never redrew carved terrain, because the sandbox had grown the feature first.
- T19.24: lava was lit in the sandbox and dark in matches.
- T22.08B: the flare needed a sandbox-only authority flag.
- The explosion forks recorded in `combat_step`'s own comments.

**The fix is the thing the owner thought already existed.** `World` is pure and already compiles to WASM. So run it
in the browser as a *local server*: the sandbox becomes `World::step` plus an in-process transport feeding the
**same** `GameScene`, through the same codec and events a networked match uses.
- `combat_step`, `weather_step` and `SandboxScene` retire.
- The sandbox's knobs (seed, force weather, give item) become dev commands to that local server. The real server
  already has most of them as `DEV_*` settings.
- Every browser check then tests the real game.
- Solo practice and offline bots come for free.

This is a well-trodden pattern: "listen server" or "local host" in most engines.

**Cost:** a few tasks — an in-process transport, dev commands, porting the sandbox checks. **Payoff:**
- about half the duplicated client code goes;
- a whole bug class goes;
- the test suite starts measuring the thing players get.

### 2. The predictor's inputs should be derived by one function, not plumbed by hand
Every rule `apply_input` reads has to reach the client as a wire bit **plus** a `GameCore` setter. Otherwise the
local player rubber-bands. Each of these was found the hard way:

| What the predictor was missing | Task |
|---|---|
| Damaged-speed multiplier | T20.19 |
| Health truncated to a u8 | T20.21 |
| Gravity | T22.02 |
| Round phase | T21.30 |
| Mounted on a platform | T21.11B |
| Asteroids | T22.11C |

**Fix:** a single Rust function, e.g. `MoveEnv::for_player(&World, id)`, builds *everything* `apply_input` reads. The
server encodes that struct (or the parts that change) and the client decodes it into the same struct. No per-field
setters.
- A new movement rule then has one place to go.
- A test can assert that `apply_input` reads nothing outside `MoveEnv`, which the type system largely enforces
  anyway.
- `JumpState` and `prev_input` (not on the wire today) are part of the same gap.

### 3. One clock
`GameScene` keeps four clocks:
- `ClockSync`, which feeds only the debug HUD;
- the monotonic `ServerClock`;
- `roundTime`, extrapolated locally;
- `serverRoundTime`, the last snapshot's value, truncated to 0.1 s on the wire.

T22.08D/E spent two review rounds on flare timing that came from exactly this. **Fix:** make `ServerClock` the only
clock; every time-based picture (flare, lava, banners, the round timer, day/night) reads it. That's small, and it
removes a class.

### 4. Two real bugs this survey found, worth a task each
- **Inputs are dropped when the frame rate is low.** The fixed-step loop can run up to 15 steps in one frame
  (`MAX_FRAME_DT` 0.25 s), but only the last `INPUT_REDUNDANCY` (3) inputs are sent (`GameScene.ts`, the send after
  the accumulator loop). Below about 20 fps, or after a hitch, the client moves you on inputs the server never
  receives. The server skips integrating those ticks, so slow machines rubber-band constantly.
  **Fix:** send every unacknowledged input, still redundant, capped by `MAX_INPUT_QUEUE`.
- **Snapshot precision:**
  - Positions and velocities are truncated to whole pixels with `as i16`; truncation, not rounding, biases every
    value toward zero.
  - Health is truncated to a u8.
  - Round time is sent in tenths of a second.

  Each has already caused a mirror bug. **Fix:** round instead of truncate, and send positions at 1/8 px fixed-point;
  it is still 2 bytes at these map sizes.

### 5. Information sent to players who shouldn't have it (low priority until it matters)
The snapshot ignores its recipient (`encode_snapshot(world, _for_player, …)`). Every player's position, health,
selected item and heal counts go to everyone, and night-time vision is enforced only by the client. For a casual
6-player browser game this is acceptable today. But it makes **night a visual effect rather than a rule**: anyone
who opens the dev console sees everyone.

**Fix, when it matters:** server-side culling of players beyond the recipient's vision radius (plus a margin) at
night. Valorant's "fog of war" is the reference; it costs under 2 % of a server frame. Do it together with M23's
zoom change, because that task restates the vision radii anyway.

### 6. Transport, later
socket.io over TCP means one lost packet stalls everything behind it for a round trip. That is exactly the "burst"
T22.08E had to make the flare clock survive. On clean connections it's fine.

**Fix, when players are on Wi-Fi or mobile:**
- move snapshots and inputs to **WebTransport datagrams**, which are in all major browsers since Safari 26.4
  (March 2026);
- keep carves, kills and other must-arrive events on a reliable stream.

The netcode layer is already mostly independent of the transport, so this is a contained change. **Not before items
1–4.** Base64 on the wire and the lack of delta snapshots are irrelevant at 6 players.

### 7. Cheap insurance on the shared code
- **Pin the maths library.** Use the `libm` crate explicitly for the ~50 `sin`/`cos`/`atan2` calls in game-core, so
  native and WASM compute identical bits. Today only cosmetic things (the flare ribbon) could differ, but it costs
  nothing.
- **Parity test.** Add one test that runs the pure functions the client derives (flare points, lava vents, the gravity
  field) natively and in WASM and compares them. No wasm-vs-native test exists today.
- **Version check on connect.** Have the client and server exchange a protocol/build hash and refuse a mismatch
  (check whether one exists before adding it).

## What I would *not* do

- **Thin client** (the server sends pictures and the client only draws). It would kill the feel of the jetpack and
  aiming, the core of this game.
- **Deterministic lockstep or rollback** (send only inputs, like RTS or fighting games). It needs bit-exact
  determinism across native and WASM for all 70 000 lines of game-core; every divergence becomes fatal instead of
  self-correcting. Rolling back a per-pixel terrain mask is expensive, and it rules out hiding information from
  players. It is right for fighting games and RTS, wrong here.
- **A rewrite or engine switch for netcode reasons.** Nothing in the evidence points at the architecture itself.
  - The engine change M23 proposes (three.js for the world) is about pictures, not netcode, and doesn't touch any
    of this.
  - That milestone's renderer takes plain data, and that is also what item 1's local server would feed it.

## A note on the process cost

The project's rulebook (CLAUDE.md's "what this project has learned") is long, and most of it guards against "a claim
reported through something other than the thing it claims". A large share of the incidents behind those rules were
the three hand-synchronised pairs above:
- sandbox vs match;
- server rules vs predictor setters;
- server clock vs client clocks.

**Removing the pairs removes the need for the vigilance.** That is the strongest argument for doing items 1–3 before
the game grows further. M23 is about to add another renderer, and a second copy of every picture path is the last
thing this codebase needs.

## Suggested order
1. Item 4: two small bug tasks, now.
2. Item 3: one clock (small).
3. Item 2: `MoveEnv` (medium, pure Rust + codec).
4. Item 1: the sandbox as a local server (a short milestone of its own). Ideally before M23, so M23 builds one
   picture path instead of porting two.
5. Items 5–7 as the game's audience grows.

## Sources
- Valve, Source Multiplayer Networking (quote verified via mirror): https://developer.valvesoftware.com/wiki/Source_Multiplayer_Networking ,
  https://gist.github.com/CoolOppo/fe0586836de3fb2f90f9 ; Lag Compensation: https://developer.valvesoftware.com/wiki/Lag_Compensation
- Gabriel Gambetta: https://www.gabrielgambetta.com/client-side-prediction-server-reconciliation.html ,
  https://www.gabrielgambetta.com/entity-interpolation.html
- Gaffer on Games: https://gafferongames.com/post/snapshot_interpolation/ , https://gafferongames.com/post/state_synchronization/ ,
  https://gafferongames.com/post/floating_point_determinism/ , https://gafferongames.com/post/udp_vs_tcp/
- Overwatch GDC 2017 (from talk summaries): https://www.gdcvault.com/play/1024001/-Overwatch-Gameplay-Architecture-and
- Rocket League GDC 2018 (internals not verified): https://www.gdcvault.com/play/1024972/It-IS-Rocket-Science-The
- Age of Empires lockstep: https://www.gamedeveloper.com/programming/1500-archers-on-a-28-8-network-programming-in-age-of-empires-and-beyond
- GGPO / rollback: https://en.wikipedia.org/wiki/GGPO , https://words.infil.net/w02-netcode-p5.html
- Photon Quantum: https://doc.photonengine.com/quantum/current/quantum-intro
- Teeworlds shared game core: https://github.com/teeworlds/teeworlds/tree/master/src/game ; DDNet prediction duplication:
  https://github.com/ddnet/ddnet/pull/1620 ; DDNet desync detection: https://github.com/ddnet/ddnet/pull/12783
- Hypersomnia (deterministic 2D shooter, browser + native): https://github.com/TeamHypersomnia/Hypersomnia/blob/master/README.md
- Rust: https://github.com/cBournhonesque/lightyear , https://github.com/naia-lib/naia , https://github.com/gschup/ggrs ,
  https://rapier.rs/docs/user_guides/rust/determinism/ , https://github.com/rust-lang/libm
- WebAssembly nondeterminism: https://github.com/WebAssembly/design/blob/main/Nondeterminism.md
- Valorant fog of war: https://www.riotgames.com/en/news/demolishing-wallhacks-valorants-fog-war
- Terrain sync precedents: https://minecraft.wiki/w/Java_Edition_protocol/Packets , https://github.com/tModLoader/tModLoader/wiki/Basic-Netcode
- WebTransport in Safari 26.4: https://webkit.org/blog/17862/webkit-features-for-safari-26-4/ ; https://developer.mozilla.org/en-US/docs/Web/API/WebTransport
