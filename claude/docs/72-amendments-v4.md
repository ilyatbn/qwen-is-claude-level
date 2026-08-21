# 72 — Amendments v4: what the player actually sees

Playtest feedback after v3 shipped. This document **overrides** `00`–`62` and
extends `70`/`71` where they conflict.

Constants introduced here are as authoritative as `02-constants.md` and must be
mirrored in `crates/game-core/src/constants.rs` (a `v4` section).

---

## C0 — Four bugs, one cause

The report contains four separate "I cannot see X" bugs: terrain does not change
when destroyed, projectiles are invisible, weather is invisible, crates hang in the
air. They are one defect wearing four hats, and the diagnosis takes one command:

```
grep -c 'rebake\|markDirty\|dirty' client/src/scenes/GameScene.ts   →  0
```

`GameScene` decodes `carve`, applies it to the mask — so collision changes and the
minimap updates — and **never calls `TerrainLayer.markDirty()`**. The renderer is
never told. You walk through a hole you cannot see.

The other three are the same shape at other layers, and the reason is structural:

> **There are two render paths.** `SandboxScene` was built first (M3) and grew every
> feature as it was written. `GameScene` arrived in T6.16 and got `WorldView`, the
> shared stack — which `SandboxScene` does **not** use. So every feature exists twice
> or once-in-the-wrong-place, and the game scene is the one nobody plays in
> development.

The journal recorded this in T9.02 — *"WorldView's docstring claimed the sandbox and
the game build the stack the same way; only GameScene uses it, and the sandbox still
builds it inline. Every addition has to be made twice — this is the second feature
to pay that."* It was noted and never scheduled. It has now cost four bugs in the
shipped game.

### Why 905 tests and 20 e2e specs missed all four

Every assertion about the world asserts on **simulation state** or on **client
bookkeeping**, never on **the rendered frame**:

| what was asserted | what it proves | what it misses |
|---|---|---|
| mask checksums agree between clients | the simulation replicates | nothing is drawn |
| solid-pixel count drops after a rocket | the *mask* changed | the *canvas* did not |
| `items tracked` vs `items drawn` | the item layer runs | terrain, weather, projectiles |
| `lightmap.filled`, `mine draws` | those two layers run | every other layer |

This is §A15 and §B21 for the fifth time — *fog's formula was always right; nothing
tested that the number reached the screen.* The rule was written down three times
and the tests still assert on the number.

**So C2 is not optional and is not a nice-to-have**: the acceptance test for
anything visible is a **sampled pixel in a rendered frame**.

---

## C1 — One render path

`WorldView` becomes the only way a scene builds the world, and it owns the
carve→rebake wiring so no caller can forget it.

- `SandboxScene` migrates onto `WorldView`. Where the sandbox needs something the
  game does not (seed box, scale switcher, weather triggers, overlays), that is a
  **sandbox-only panel over a shared world**, not a second world.
- `WorldView.applyCarve(x, y, r)` applies to the mask **and** marks the chunks dirty.
  Applying a carve without marking dirty must not be reachable from a scene.
- A test asserts the two scenes build the same layer set, in the same depth order
  (`docs/12` §5). Not "both call WorldView" — the **resulting layers**, so a scene
  that adds one inline still fails.

> Any feature that appears on screen is added **once**, to `WorldView`, and both
> scenes get it. A scene that reaches past `WorldView` to draw world content is the
> bug this section exists to prevent.

## C2 — Assert on rendered pixels

Every visible feature gets an acceptance test that **samples the canvas**.

The harness already exists — `night_darkens_the_world.mjs` samples a screenshot
because Phaser does not preserve the WebGL drawing buffer, and `§A16`'s mid-band
lesson applies: sample where the change is, not where it is invisible.

| feature | the assertion |
|---|---|
| terrain destruction | pixels inside a carved circle change from rock to backdrop/sky, **and** the surrounding rock does not |
| projectile | a frame during flight has pixels of the weapon's colour that the frame before does not |
| weather | toxic/meteor/lava each change pixels in their own region during the active phase |
| crate | falls (y decreases over frames), then rests, then disappears on pickup |
| bars, timer, banner | present in the DOM **and** rendered — a hidden element is not a HUD |

Each carries a **control**: a frame where the feature is off must *not* show the
change, or the assertion passes for a canvas that is always different.

---

## C3 — The round ends

`ROUND_SECONDS` elapses and nothing happens. `docs/41` §3's `Ended` phase exists in
the server and the client ignores it.

- On `Ended`: the simulation **freezes** (server already does this), the client stops
  accepting input, and a **results screen** appears over the frozen field.
- It shows the final scoreboard — name, score, kills, deaths — sorted per `docs/21`
  §6, with the local player highlighted, and ties shown as ties.
- Two buttons: **Play again** (sends `vote_restart`, shows the vote count and the
  `ENDED_SECONDS` countdown) and **Exit to title**.
- If the vote carries, a new round starts on a new seed with scores reset. If it does
  not, the client returns to the title.

## C4 — Ordnance is visible

Placeholder art, explicitly temporary, sized and coloured per weapon so you can tell
what is in the air. **Real sprites replace these later without touching the layer.**

| projectile | radius | colour | trail |
|---|---|---|---|
| bazooka rocket | 6 | `#ff8a3d` orange | yes, long |
| grenade | 5 | `#3f7d3f` dark green | yes, short |
| airburst | 5 | `#a77dff` violet | yes |
| smoke | 5 | `#b9bec6` grey | no |
| molotov | 5 | `#ff5a2b` orange-red | yes |
| toxic | 5 | `#7cd44a` toxic green | yes |
| meteor | 8 | `#ff4433` red | yes, long |
| meteor fragment | 3 | `#ff7755` | short |
| mine (placed) | 4 | `#cccc33` blinking | — |
| hitscan tracer | width 2 | per §A3 | fades |

Every projectile is a **light source at night** (§A3) — that already works in the
sandbox and must work in the game.

## C5 — Teleport pads

Respawn currently lands in mid-air and always in the same place. Pads replace ad-hoc
spawn selection and fix both, permanently.

- **`TELEPORT_PADS` (6)** are chosen at generation time from valid, separated surface
  points — the same farthest-point sampling as spawn points (`docs/10` §8).
- A pad is a small **indestructible** platform, `PAD_W` × `PAD_H`. `carve_circle`
  skips it exactly as it skips bedrock. **This is what guarantees a valid respawn
  surface for the whole round**, however much of the map is destroyed — and it makes
  the pads tactically real, because they are the one ground nobody can dig away.
- **Death** → respawn on the pad furthest from the nearest living player.
- **Standing on a pad for `TELEPORT_CHARGE` (2 s) while alive** → teleport to a
  different pad, chosen at random from the others.
- **Arming**: a pad does nothing until the player has moved `TELEPORT_ARM_DISTANCE`
  (32 px) from where they spawned. Spawn and stand still, and nothing happens.
- **`TELEPORT_COOLDOWN` (5 s)** after arriving, so you cannot ping-pong.
- Client: a glowing ring, and a charge indicator that fills over the 2 s.

| Name | Value |
|---|---|
| `TELEPORT_PADS` | 6 |
| `PAD_W` | 40 |
| `PAD_H` | 8 |
| `TELEPORT_CHARGE` | 2.0 |
| `TELEPORT_COOLDOWN` | 5.0 |
| `TELEPORT_ARM_DISTANCE` | 32.0 |

## C6 — Weather you can see

The simulation is correct and tested; none of it reaches the screen.

- **Toxic rain** — green droplets falling across the whole map during the active
  phase, a sickly green vignette, and a bubbling puddle at each hazard with a soft
  glow. Droplets are a particle emitter, not per-drop entities.
- **Meteors** — a bright head with a long tapering tail, drawn as a falling star;
  impact flash, screen shake by distance, and glowing fragments.
- **Lava** — fire **spewing upward from the vent**, spreading and falling back, and
  burning ground left behind that visibly flickers. Additive blending.
- **Fog / smoke** — a drifting layer, already spec'd in §B21's vision channel.

All of them are light sources at night.

## C7 — Crates fall and can be picked up

Two bugs: crates appear in mid-air, and cannot be collected.

- A crate spawns at `y = SKY_MARGIN / 2` and **falls** through the same sub-stepped
  resolver everything else uses (`docs/32` §4), landing on the first solid ground
  below. A crate rendered before it has fallen is the mid-air symptom.
- On landing it becomes a normal `WorldItem` and is picked up on contact like any
  other (`docs/30` §5). "Cannot pick up" means it never became one — check the
  landing transition, and assert the pickup **end to end**, not the landing.
- Falling crates draw a parachute and a beacon (`docs/32` §4) so they are visible
  from across the map, which is the point of them.

## C8 — The HUD

| element | where | behaviour |
|---|---|---|
| Round timer | **top-right**, large, bold | red below `TIMER_WARN_SECONDS` (60) |
| Event banner | **top-centre**, large, red | effect name + its remaining time, during telegraph and active |
| Health bar | bottom-left cluster | red→green, numeric overlay |
| Energy bar | under health | battery (§B5), blue |
| Jetpack bar | under energy | fuel, yellow, drains visibly |
| Heals / batteries | beside the health bar | counters, not inventory slots (§C9) |

The timer wants a real display face, not the default sans — a condensed bold or a
mono. Ship the font with the game; do not fetch it at runtime.

## C9 — Heals and batteries are not inventory

They are consumed constantly and should never compete with a weapon for a slot.

- `heals: u8` (max **2**), `batteries: u8` (max **4**) on `PlayerState`.
- Picking one up increments the counter. **At max, the pickup is refused and the item
  stays on the ground** — the same rule as a full inventory (`docs/30` §2).
- **`Q`** uses a heal (`MEDKIT_HEAL`), **`R`** uses a battery (`BATTERY_PACK_AMOUNT`).
  Both are rejected with no effect at zero.
- They ride in the snapshot: one byte, `heals` in 2 bits and `batteries` in 3.
  `SNAPSHOT_PLAYER_BYTES` 16 → **17**, snapshot `8 + n*17 + 4`. §A19's rule stands —
  the size test pins to the constants.

| Name | Value |
|---|---|
| `MAX_HEALS` | 2 |
| `MAX_BATTERIES` | 4 |

## C10 — Inventory: a quick bar and a backpack

- **Quick bar**: `QUICK_SLOTS` (8) square tiles, centred at the bottom, always
  visible. `1`–`8` and the wheel select; firing and using act on the selection.
- **Right-click** expands **two more rows** — `BACKPACK_SLOTS` (16) — over the quick
  bar. `Esc` or another right-click closes it, and it does **not** pause the round
  (`docs/30` §3).
- **Drag** moves a stack between backpack and quick bar, and reorders within either.
  Drag is client-side intent; the server validates and is the authority, so a
  `move_item { from, to }` message joins the protocol.
- Pickups fill the quick bar first, then the backpack; when both are full the pickup
  is refused as today.

| Name | Value |
|---|---|
| `QUICK_SLOTS` | 8 |
| `BACKPACK_SLOTS` | 16 |

## C11 — Quick-throw

**`E`** throws a grenade-class item from anywhere in the inventory — the first one
found, in a defined order (grenade, molotov, toxic, smoke, airburst) — along the aim
angle, without changing the selected slot. It is rejected with no effect if you have
none.

This is what makes twenty weapons usable: you stop losing fights while opening a
panel.

## C12 — Debug mode

The black aim line and the direction ring are development affordances and are
**off** in a normal game.

- **`F1`** or `?debug=1` toggles debug mode: the aim ring and line, collision boxes,
  chunk bounds, surface points, teleport pads' radii, and the FPS counter.
- The **crosshair stays** in normal play — it is the aiming affordance. The ring and
  the line go.
- Remote players never show an aim ring in either mode (`docs/22` §5).
- **FPS counter**: only if it is genuinely free. Phaser's `game.loop.actualFps` is a
  smoothed average that under-reports for seconds after a stall (§A38) — if it is
  shown, it must be measured from `requestAnimationFrame` deltas, and it is
  debug-only.

## C13 — The escape menu

`Esc` opens a centred menu over the frozen-looking field (the round keeps running —
it is an overlay, not a pause, exactly as §B4 established for the death screen):

- **Resume**
- **Options** — present, disabled, "Coming soon", the same treatment weapon skins get
  in the skins menu (§B3)
- **Quit to title** — leaves the room and returns to the title screen

`Esc` closes it again. It must not swallow the inventory's `Esc` when that is open —
innermost overlay first.

## C14 — A living background

The sky is a gradient, a sun, a moon and stars. It wants depth.

- **Mountain silhouettes**: two parallax layers, generated from the map seed so a seed
  always looks the same, drawn in the theme's palette darkened toward the sky colour
  at distance. Scroll factors below `PARALLAX_FACTOR`.
- **Clouds**: `CLOUD_COUNT` soft blobs drifting slowly across the sky layer, tinted by
  the current sky phase (§A4) and lit warm at dawn and dusk. They wrap.
- Both sit behind the terrain and above the gradient, and cost one draw each — no
  per-frame allocation.

| Name | Value |
|---|---|
| `CLOUD_COUNT` | 12 |
| `CLOUD_DRIFT` | 6.0 (px/s) |
| `MOUNTAIN_LAYERS` | 2 |
| `MOUNTAIN_PARALLAX` | 0.10, 0.20 |

## C15 — The floor can be dug through, and below it is death

Today `BEDROCK_H` (24) is indestructible, so the bottom of the map is a wall you
bump into.

- The bedrock band becomes a **destructible crust**, `FLOOR_CRUST` (16), and below the
  map is **void**.
- A body whose top edge passes `y = h` **dies immediately**, attributed to
  `DamageSource::Void`. Score is `DEATH_POINTS` as for any death (`docs/21` §6).
- Projectiles and world items that pass `y = h` despawn.
- The **walls stay indestructible** (`WALL_W`) — you cannot leave sideways, and §A1's
  hard world limits are unchanged on x.
- **Teleport pads are indestructible (§C5), which is what keeps this survivable**: a
  map dug through to the void still has six guaranteed standing spots.
- Map generation is unaffected except that the traversal validator must treat the
  void as a hazard rather than a wall — falling into it is a legitimate way to die,
  not a validation failure.

| Name | Value |
|---|---|
| `FLOOR_CRUST` | 16 |
| `BEDROCK_H` | 0 (was 24) |

## C16 — Birds

Ambient life that is also a reason to shoot at the sky.

- Birds spawn every `BIRD_INTERVAL`, up to `BIRD_MAX` alive, and fly across the map on
  a gentle sine path, despawning at the far edge.
- A **normal bird** killed drops a **heal**. A **metal bird** — `BIRD_METAL_CHANCE`,
  visually distinct, slower, tougher — drops a **battery**.
- They are server-simulated and seeded from `substream(seed, "birds")`, because they
  drop items and items are gameplay. They take damage from anything.
- The drop falls to the ground as a normal `WorldItem`, and is refused if the finder
  is already at `MAX_HEALS` / `MAX_BATTERIES` (§C9) — so birds are worth shooting when
  you need one and not otherwise.

| Name | Value |
|---|---|
| `BIRD_INTERVAL` | 18.0 |
| `BIRD_MAX` | 4 |
| `BIRD_SPEED` | 70.0 |
| `BIRD_HEALTH` | 1.0 |
| `BIRD_METAL_HEALTH` | 25.0 |
| `BIRD_METAL_CHANCE` | 0.25 |

## C17 — The dev surface is compiled out, not gated

`?sandbox=1`, `?e2e=1`, `?preview=1`, `?game=1`, `?menu=1`, `?skins=1` and the
`window.__game` handle are all reachable by anyone who types them into the address
bar. Measured on the shipped bundle:

| string in `client/dist/assets/*.js` | occurrences |
|---|---|
| `__game` | 3 |
| `sandbox` | 2 |
| `toggleOverlays` | 1 |
| `regenerate` | 7 |

`import.meta.env` appears **nowhere** in the source, so nothing is gated at build
time today. `docs/60` §5 explicitly kept the sandbox "in the build after M6 as a
debugging tool, behind a `?sandbox=1` flag" — that decision is now reversed for
production builds.

### The choice, and why

Two options were on the table: a **server-side toggle the client queries**, or
**removal at production build**. Removal wins on both counts, which is unusual
enough to state:

- **Simpler.** `import.meta.env.DEV` is statically replaced by Vite with `true` or
  `false`, so `if (import.meta.env.DEV) { … }` is dead-code eliminated. No new
  message, no server state, no round trip, nothing to get out of sync.
- **Stronger.** A server toggle still *ships the code*; a modified client flips the
  flag and has the sandbox back. Code that is not in the bundle cannot be enabled by
  any means.

> The dev surface is **absent** from a production build, not disabled in one.

### What is removed

The dev scenes (`Sandbox`, `Preview`, `Boot`), every scene-selection query
parameter, `window.__game`, the debug overlays, the aim ring and direction line
(§C12), and the FPS counter.

What stays is what a player uses: Title → Menu → Lobby → Game, the Esc menu, the
HUD, the inventory.

### The escape hatch, and its default

`vite build --mode e2e` sets a flag that re-enables the handle, for a check that
must drive a **production** bundle. Plain `vite build` — what `make build` and
`docker/Dockerfile.client` run — has none of it. The suite today drives the dev
server, so this hatch is for future use and must not become the default by
accident.

### The acceptance test greps the artifact

This is the §A15 rule applied to a build: **assert on the bundle, not on the
intention.** A test that checks "the code is inside an `if (DEV)` block" passes for
a build where the eliminator did not run.

- The default production bundle contains **none** of the strings in the table above.
- **Control**: an `--mode e2e` bundle *does* contain them — otherwise the grep also
  passes for a build that produced nothing.
- Loading the production bundle with `?sandbox=1` gives the normal title screen.

### Server-side dev flags are already the right shape

`DEV_LOADOUT`, `DEV_START_HEALTH`, `FIXED_SEED`, `RECORD_REPLAY` and `DEBUG_DUMP`
are **server environment variables**. A client cannot set them, they default off,
and they stay exactly as they are. The distinction worth keeping: a dev flag the
*server* owns is fine; a dev flag the *client* can name is not.

## C18 — No battle exists until players ask for one

**This corrects §B10 and `MIN_PLAYERS_TO_START`, and it is a design error of mine.**

`app.rs:109` creates a room at **server startup**, unconditionally. It seats
`BOT_COUNT_DEFAULT` (5) bots and begins ticking — generating a map, running timers,
spawning items, scoring. So a player who connects always lands in a battle already
in progress, which is exactly what was reported.

§B10 made it worse by reasoning that *"nobody ever waits"* was the goal. Nobody
waiting is only good if there is something to wait **for**. A room that is already
mid-round when you arrive is not a game you joined; it is a game you interrupted.

### The rule

> A room is created **on demand** — by `create_room` or by quick match — and it does
> **nothing** until a battle starts. No timers, no scoring, no item spawns, no
> weather, no bots.
>
> The map is generated when the room is created, so players in the lobby can see
> what they are about to play. Generating it is the *only* work a `Lobby` room does.

### Phases

`Lobby` gains real behaviour rather than being a state the server passes through:

| phase | ticking | what exists |
|---|---|---|
| `Lobby` | **no sim** | the map, the roster, the join code |
| `Warmup` | yes | players spawned, no damage (`docs/41` §3, unchanged) |
| `Playing` | yes | everything |
| `Ended` | frozen | the results screen (§C3) |

A room drops back to `Lobby` — not to a fresh round — when it empties of humans, and
is reaped after `ROOM_EMPTY_TTL` as §B1 already says.

### Starting

`MIN_PLAYERS_TO_START` becomes **2**, and it counts **humans**.

That alone would kill solo play, which §A5 exists to make possible. So the lobby also
offers **"Start with bots"**, which any player in the room may press:

- **2+ humans present** → the round starts automatically after a short
  `LOBBY_COUNTDOWN` (5 s), visible to everyone, so nobody is dropped in mid-sentence.
- **1 human who presses "Start with bots"** → bots are seated to fill the room and the
  round starts. This is the solo path, and it is now a **choice** rather than the
  default that produced the bug.

Bots are seated **when a round starts**, never before, and never in a `Lobby` room.

| Name | Value |
|---|---|
| `MIN_PLAYERS_TO_START` | 2 (was 1; now counts humans only) |
| `LOBBY_COUNTDOWN` | 5.0 |

**No bootstrap room.** The server starts with an empty registry, and `/healthz`
reporting `rooms 0, players 0` on a fresh server is correct, not a fault.

## C19 — Melee hits what is in front of you

Melee reach is measured from the player **centre**, so `axe` at 40 reaches 2.5
player-widths — it connects with someone who is visibly not adjacent.

T11.09 raised these reaches (knife 26→36, axe 30→40, hammer 28→38) because melee was
below half the arsenal's median damage, and hit rate tracked reach almost exactly.
So this is a real trade and the numbers must be re-measured, not just lowered:

> Reach becomes **`PLAYER_W / 2 + weapon_reach`** — measured from the body edge, not
> the centre, so the number in the table means "how far in front of me".

New values, all "immediate proximity": `knife` 12, `bat` 16, `whip` 44 (the whip is
*supposed* to reach), `axe` 16, `hammer` 14.

Compensate with **arc and cooldown, not reach** — a wider sweep and a faster swing
keep melee viable without letting it connect at a distance. Then **re-run T11.09's
balance harness and report** what it did to melee's damage share; if melee falls back
below half the median, say so with the numbers rather than quietly restoring reach.

## C20 — You cannot fire while moving

Firing, throwing and swinging are all refused while the player is moving under their
own power. Standing still to shoot is the Worms convention and it makes positioning a
decision rather than a formality.

- Refused when `|vel.x| > FIRE_MOVE_MAX_SPEED` **or** a movement key is held this
  tick — the key check matters, or you can fire during the single tick between
  releasing a key and friction taking effect.
- Being *knocked* around does not stop you firing: this is about your own movement.
  Check the input, not just the velocity.
- **It applies to bots too.** They currently fire while walking; they must stop, or
  they become strictly worse than a human at the same skill and every balance number
  in §B7 shifts. Re-run the balance harness.

| Name | Value |
|---|---|
| `FIRE_MOVE_MAX_SPEED` | 8.0 |

## C21 — Toxic rain falls from the sky

Puddles currently spawn directly on surface points, which means they appear
**underground inside caves** — rain that fell through a roof.

> A toxic drop is a **projectile**, spawned from a cloud at `y = SKY_MARGIN`, falling
> under gravity, forming its puddle **where it lands**. Whatever it lands on is the
> only place a puddle can be.

That fixes the underground bug by construction — a drop cannot reach a cave floor
without an opening — and it makes the rain visible, because drops are drawn by the
same layer as every other projectile (§C4).

Twenty drops over `TOXIC_DURATION` at `TOXIC_PUDDLE_EVERY` is not a load concern. The
telegraph is the cloud arriving.

## C22 — Meteors are visible for long enough to dodge

`docs/13` §4 already says meteors *are* ordinary projectiles, and only their
explosions are visible. That is the §C4 render gap again, not a simulation change.

They must be visible **and dodgeable**: spawned at `y = -32` with `METEOR_SPEED` 700,
a meteor crosses a 1536 px map in about two seconds. The telegraph shadows
(`docs/13` §4) mark where the first ones land, and the falling star itself must be
drawn from spawn, not from impact.

## C23 — Gun projectiles are still invisible

T13.03 shipped visible ordnance with a passing pixel test, and guns are still not
visible in play. **Find out which class is missing before changing anything** — a
bazooka rocket is a projectile, a pistol shot is a hitscan tracer, and they take
different paths. One of:

- the tracer path never reaches `GameScene` (the §C0 shape a third time);
- tracers are drawn but are too brief to see at 0.09 s;
- the projectile path covers weapon fire and not server-spawned projectiles.

The T13.03 pixel test passing while the player cannot see them means **the test is
sampling something the player is not looking at**. Fix the test as well as the bug.

## C24 — A weapon occupies one slot, ever

Picking up a weapon you already carry currently takes a second slot once the first
stack is full. It should **refill** instead.

> A given weapon id appears **at most once** in the inventory. A pickup of a weapon
> already held tops its ammo up to `max_stack`; if it is already full, the pickup is
> refused and the item stays on the ground (`docs/30` §2's rule for a full
> inventory).

With 20 weapons and 24 slots this is the difference between a loadout and a hoard.

## C25 — The results countdown counts down

The `ENDED_SECONDS` countdown on the results screen is static. It must tick, driven
by the server's round time like every other timer (§B4) — a local stopwatch drifts,
and this one has a vote deadline attached to it.

## C26 — Show the jetpack number

Fuel refill behaviour is hard to judge from a bar alone. Add a numeric readout beside
the jetpack bar (§C8) showing current fuel to one decimal, and **verify the refill
against the spec while you are there**: `JETPACK_DRAIN` 1.0/s while thrusting,
`JETPACK_REFILL_DELAY` 0.5 s of no thrust, then `JETPACK_REFILL` 0.5/s — so a full
5 s burn takes 10 s to recover. If the observed curve disagrees with those constants,
that is a bug; report the measured numbers.
