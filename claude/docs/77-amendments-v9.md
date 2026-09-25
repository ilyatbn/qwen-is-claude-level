# 77 — Amendments v9: a match played in orbit

M22. One lobby setting — **gravity: standard, low or space** — and everything the third value
brings with it: a map of floating rock inside a breakable rim, movement that never damps, a
suit battery that radiation eats, solar flares, a vortex behind every hole in the rim, a
black hole in the last minute, and the netcode work those exposed. Most of it is new ground
the originals never described; some of it overrides them, and each override is named at the
point it happens.

Constants introduced or changed here are as authoritative as `02-constants.md` and must be
mirrored in `crates/game-core/src/constants.rs`. **A constant is cited by name**; its value
and its basis live at the constant, and the values quoted below are the ones at the close of
M22 (`REPLAY_VERSION` 26).

**Where the decisions came from.** Every rule below carries its ruling id: `R1`–`R100` are the
coordinator's M22 rulings — `R1`–`R72` in `tasks/M22/M22-RULINGS.md`, `R73`–`R100` in the task
files that `M22-RULINGS.md`'s index points to. Each has a *"Reverse it by"* line naming the one
place to change. **The final audit's finding ids `H1`–`H3` (`T22.14A`) are unrelated to this
document's `§H` numbering**; they are cited here as "`T22.14A` H1".

This document **overrides** `docs/40` §2 (`input`'s queue and its test line) and §3
(`snapshot`'s layout, `map_init`'s layout), `docs/70` §A30, `docs/42` §2, `docs/41` §2–§3 (how a
phase ends; weather damage in `Ended`), `docs/13` §1 and §4 in space and §7 everywhere,
`docs/14` §1 in space, `docs/10` §1.4 and §3 for the space generator, `docs/32`'s crate drop in
space, `docs/76` §G1 (fall damage) in space, and `docs/74` §E10's flame stand-off in standard.
It adds rules that were absent rather than wrong everywhere else.

---

## H1 — The gravity setting

A private-lobby setting on `docs/75` §F7's path, beside bots, start kit and round length:

- **`standard | low | space`** (`GravityMode`), host-only, sent as `set_gravity {gravity}`,
  broadcast as `lobby_state.gravity`; a guest's attempt and an unknown value are refused with
  `lobby_error` (`T22.01`). **No environment spelling**, on purpose, like §F7's other two.
- **It is simulation state**, so it is in the replay header (one byte after `start_kit`,
  `REPLAY_VERSION` 14) and a `SetGravity` command tag (23). It is **not** hashed: it is an input
  like the seed, and a world that ran under another gravity diverges in hashed state.
- **The map generator is derived from it, never chosen beside it** (`R15`): space ⇒
  `MapGenerator::Space`, otherwise the lobby's generator. Gravity is a `World` constructor input
  (`World::with_gravity`) so the derivation happens before the map exists, and the lobby preview
  (`PreviewScene`) runs the same derivation.
- **"Is this space?" has one answer, and it is the map** (`R58`, `R78`, `T22.14A` B3):
  `MapMeta::generator == Space`, read through `Map::space_geometry()`. Every space-only rule —
  weather table, no wildlife, no night, the rim, the void — keys on it. `World::gravity` decides
  only what gravity *is* (the scale, the suit).
- The sandbox reaches the mode with `?gravity=` (`R22`).

## H2 — Low gravity

`LOW_GRAVITY_SCALE` (0.5) multiplies `GRAVITY` — a **scale, never a second `GRAVITY`** (`R3`,
`T22.02`). `map/gen/traversal.rs`'s `JUMP_HEIGHT`/`JUMP_REACH` are compile-time consts of
`GRAVITY` and decide which maps the generator accepts; a runtime scale leaves every map and the
golden table alone, and every scale below 1 makes the player jump higher and further than the
generator assumed — the safe asymmetry.

It reaches **every** reader of `GRAVITY`: the player (`apply_gravity`), both projectile gravity
terms (`projectile.rs::integrate` and the bots' `predict_impact`), the bots' `zone_reach`, meteors
and toxic drops (`R29`: they fall slower and the sky stays fuller — the owner's *"including
projectiles"*), and the four non-player steppers — mines, items, tombstones, animals (`R30`/`R48`:
they passed a literal `1.0`, so a dropped weapon fell twice as fast as its owner).

**Fall damage is lower for free**: impact speed falls as √g and `PlayerState::fall_damage`
subtracts a fixed safe speed first, so many falls do nothing. No extra multiplier.

**Measured and shipped as measured** (`R31`): over 8 seeds low gravity is the most violent mode
— 8.5× the shots and 4.3× the kills of standard, bots only. `LOW_GRAVITY_SCALE` is bracketed
(`constants::tests::low_gravity_carries_its_basis`), not pinned.

## H3 — Movement in space

**Overrides, in space only:** `docs/20` §1–§5 (gravity, landing, walking off a ledge, the jetpack's
engage rule) and `docs/76` §G1 (fall damage).

Space is the wings regime generalised — gravity scale 0, and nothing damps (`T22.03`):

- **Contact stops you, it does not bounce** (`R1`): the velocity *into* the surface is lost, the
  component along it kept. Zero restitution.
- **`grounded` is real and earned from below** (`R4`): the downward probe finding rock grounds
  you whatever your `vel.y`; contact on any other side stops you without grounding you.
  `ground_snap` is off. **Fall damage is off** (there is no fall). Coyote time and the jump buffer
  work as on the ground.
- **A jump costs fuel**: `SPACE_JUMP_FUEL` (= `JETPACK_DRAIN` × `SPACE_JUMP_BURN_SECONDS`); a full
  tank is ten pushes off a rock, three jump-and-return round trips.
- **Thrusters** are the jetpack's one tank and its anisotropic thrust (`JETPACK_THRUST_UP` /
  `_SIDE` / `_DOWN` — **DOWN is the weakest, and every escape guarantee in this document is
  against it**, `R46`). Airborne, any held direction engages; grounded, only a net **upward**
  push does — sideways is legs, down is into the rock (`R42`, narrowed by `T22.03`). A held
  direction costs `JETPACK_DRAIN`; walking on a rock is free. `JETPACK_MIN_FUEL_TO_ENGAGE` is the
  only floor.
- **Thrust ignores health and boots** (`R41`): `mods.speed` is the legs' multiplier; the suit's
  engine does not take it. Walking on a rock still does.
- **Terminal speed is a magnitude**: `SPACE_MAX_SPEED` clamps `|vel|` through `Forces::max_speed`
  (`R10`). `MAX_FALL_SPEED` is not reused.
- **Projectiles fly dead straight** — the gravity scale reaches both projectile terms (`R38`).
- **Up stays up** (`R7`): nobody orients to a rock's surface; every sprite draws upright.

The physics seam that carries it (`R10`, `R44`, `R45`, `R52`): `integrate(map, body, forces, dt)`
with `Forces { gravity_scale, accel, max_speed, zero_g }`, and `apply_input`'s step as
`MoveStep { mods, env: Env { accel, max_speed, gravity } }` — eight parameters, four. **No
`Default` on `Forces`**: a caller must name the field it runs under.

**The plume** (`T22.04`, `T22.04B`, `T22.04C`), drawing only, space only: snapshot bit 2
(`jetpack_active`) *is* "thrusting"; the local player's plume points opposite the thrust input it
was stepped with (`GameCore::thrust_at`), a remote player's opposite its velocity (no input on the
wire). `THRUSTER_PLUME_LENGTH`, `_WIDTH`, `_MIN_SPEED`.

## H4 — The space map

**Overrides `docs/10` §1.4 (`MapMeta`) and §3 (the pipeline) for the space generator, and
`docs/32`'s sky-dropped crates in space.**

- **A third generator, `MapGenerator::Space`** (`R15`), in `MapGenerator::ALL`, so the golden
  table grew 24 → 36 rows by construction.
- **The rim is an ellipse** inscribed in the 2:1 map, inset clear of `SKY_MARGIN` and
  `FLOOR_CRUST` (`R13`, `R34`): drawn as a true circle on the 2:1 minimap. Ordinary destructible
  rock. `SPACE_RIM_THICKNESS` is the nominal disc diameter; the mask delivers 29.75–30 px (a disc
  chain scallops), above the one-minimap-cell floor of 20.48 px on Large. The x-inset derives
  from the centreline (128 px a side), not 112.
- **Outside the rim is void** (`R16`): `SpaceGeometry::in_the_void` — past the rim's outer edge
  by `SPACE_VOID_GRACE` (two ticks at `SPACE_MAX_SPEED`) — is `is_in_the_void`'s space arm, the
  one predicate `step_void` kills on and `resolve_deaths` names `void` from, on all four arcs.
- **Asteroids**: radius uniform on `SPACE_ASTEROID_R_MIN..=_MAX`, a core disc
  (`SPACE_ASTEROID_CORE_FRAC`) plus `SPACE_LUMPS_*` lumps, `SPACE_ASTEROID_GAP_MIN` apart and
  `SPACE_RIM_CLEARANCE` from the rim. **Level** `1..=SPACE_LEVEL_MAX`, monotone in radius with
  `SPACE_LEVEL_JITTER`. `MapMeta::asteroids` (x, y, r, level).
- **Acceptance** (`R17`): `passed` = the rim is closed (a ring walk, not a sample) **and** at least
  `SPAWN_COUNT_MIN` spawn points exist in open space; `traversable_fraction` is 1.0 by
  construction and `largest_component` means "all reachable" — said at the code.
- **Everything is placed in open space** (`R35`, `T22.05B`): spawns, respawns, items and crates
  come from the one picker (`Map::random_body_site`, `map::gen::space::random_open_space`,
  `SPACE_OPEN_SPACE_TRIES`). **Crates do not fall from the sky in space** (`R16`).
- **None of the ground's furniture**: no teleport pads, no gun platforms, no decorations, no
  buried slots, no lava vents — each guarded separately (`R55`). **No wind** (`MapMeta::wind` 0).
- **Only players are pulled; everything else floats where it is put** (`R14`): items, crates,
  mines and tombstones are at gravity scale 0 in space.
- **Nothing lives in space** (`R14`, `R58`, `T22.13`): no birds, beetles or spiders, gated on the
  generator.
- **`MapMeta::generator`** (`T22.14A` B3) is set at generation; it — not the asteroid list, which
  the black hole shrinks — is what `space_geometry()` reads.

**`map_init`, as built** (`docs/40` §3's layout is several amendments stale; this is the whole
of it at `REPLAY_VERSION` 26):

```
u32 magic  u32 width  u32 height  u64 seed  u8 scale  u8 theme
u8  generator        0 v1, 1 v2, 2 space; any other byte refused   (T22.14A B3)
f32 wind  u32 carve_seq
u16 spawn_count        repeat: i16 x, i16 y
u16 pad_count          repeat: i16 x, i16 y
u16 platform_count     repeat: i16 x, i16 y
u16 decoration_count   repeat: u16 kind, i16 x, i16 y, u8 flip|scale_tier<<1
u16 object_count       repeat: u16 id, i16 x, i16 y, u16 w, u16 h, u8 flip
u16 asteroid_count     repeat: i16 x, i16 y, u16 r, u8 level          (T22.05A)
u32 rle_byte_len       [rle payload]
```

The client installs the generator (`GameCore::set_map_generator`) and the asteroids
(`set_asteroids`) **before** `loadMask`. `constants_json` exports `MAP_GENERATOR_MAX`, the bound
both decoders enforce.

## H5 — The sky in space, and no night

**Overrides `docs/14` §1–§2 in space.**

- **`darkness` is 0 on a space map** (`World::darkness`, keyed on the map). The cycle's state is
  still kept (so nothing hashed moves), but **no `phase_change` event** is sent in space — the
  dawn/dusk cue does not play over a sky with no night (`T22.06B` F6).
- **The ground's sky is off**: the day/night gradient, clouds, the fog veil, ambient rain and the
  parallax ridge. **Heavy fog never rolls in space** (§H6).
- **The backdrop**: sun, earth, moon and stars on seeded paths off the **wire's** seed
  (`SPACE_SUN_*`, `SPACE_EARTH_*`, `SPACE_MOON_*`, `SPACE_STAR_*`, `SPACE_BODY_PARALLAX`); they
  move across a round. Drawing only.
- The arena interior is enclosed by the rim, so the cave-backdrop rule would paint it all as a
  cave (`R33`); space has its own backdrop and does not.

## H6 — Weather in space, and where hazard positions come from

**Overrides `docs/13` §1's table in space, and `docs/13` §7 everywhere.**

- **Space's table is meteor showers and solar flares** (`R43`); toxic rain, lava and heavy fog
  never roll there, and the flare never rolls on the ground. The table is chosen **at roll time
  from the map** (`R78`), never from `World::gravity`. A table must have **two live kinds**
  (`R28`: `pick_weighted` on all-zero weights returns index 0, a disabled kind).
- A forced flare (`WEATHER=flare`, `WeatherMode::Always`, the wasm `force_effect`) is refused off a
  space map, and an unknown kind is refused rather than defaulting (`R83`).
- **§7's "clients do not roll their own hazard positions" is withdrawn.** Lava vents and the solar
  flare are drawn from positions the client derives from the effect's seed and clock
  (`LavaClock`, `GameCore::flare_points`) through the same `game-core` function the server
  damages with — one function, not a second roll (`R27` point 4, `R80`, `R85`).

## H7 — Radiation and the suit

**New.** `R2`, `R6`, `R24`–`R26`, `R73`–`R77`.

- **Radiation is ambient and constant in space** (`R6`): `RADIATION_DPS` to health while the suit
  is **not sealed**, while `Playing`.
- **The suit is the shield that already exists** (`R2`, `R26`):
  `PlayerState::shield_active(now, suit)` — the caller supplies the suit bit from
  `GravityMode::wears_suit()`; no field on `PlayerState` says it. Sealed = the battery has charge.
  The suit's seal also takes `SHIELD_DAMAGE_MULT` off weapon damage — a feature (`R2`).
- **The battery is a second health bar that radiation eats first** (`R24`): sealed, radiation
  costs `RADIATION_SHIELD_COST` energy a second instead of health. `BATTERY_MAX` equals
  `BASE_HEALTH`; **the suit starts full, and a respawn refills it**, in space. The shield itself
  still costs nothing per second (T20.08's deletion stands).
- **Battery packs spawn more in space**: `BATTERY_PACK_SPACE_WEIGHT_MULT` on the natural Spawn
  column only; crates unchanged (`R76`).
- **Logged once a second, never once a tick** (`R25`): a hashed accumulator on `PlayerState`
  (`radiation_exposure`, `R74`), `RADIATION_LOG_INTERVAL`, through `apply_damage_log` (so the
  warmup gate applies).
- **Death cause `radiation`** (`R75`): a transient per-tick list of who radiation hit, read by
  `resolve_deaths` after the void check — never re-derived from "space and unsealed", which would
  mislabel a meteor death.
- **On the wire**: snapshot flags **bit 7 = irradiated** (space, alive, not sealed); **bit 3 stays
  the shield generator's alone** — the suit's seal never draws the generator's bubble (`R26`).
  The client shows an edge glow and a HUD line off bit 7 (`T22.09B`).
- **Measured, not tuned** (`T22.09`, `T22.08A`): ~0.7 radiation deaths per player per round over
  8 seeds. Whether that is the balance the owner wants is an open owner decision.

## H8 — Solar flares

**New effect kind `SolarFlare`**, space only (§H6). `R12`, `R27`, `R78`–`R85`, `T22.08A`–`F`.

- **A ribbon that moves**: a prominence loop whose samples are a pure function of (effect seed,
  elapsed time, map size) in `effects/flare.rs` — `SOLAR_FLARE_SAMPLES` points, neighbours never
  farther apart than `SOLAR_FLARE_RIBBON_R`, the loop's centre riding `SOLAR_FLARE_ORBIT` at
  `SOLAR_FLARE_SPEED`. `SOLAR_FLARE_DURATION`, `SOLAR_FLARE_WEIGHT`. Its clock starts at the
  telegraph; contact only while `Active` and only in `Playing`.
- **It burns you for `SOLAR_FLARE_BURN_SECONDS` after contact** at `SOLAR_FLARE_DPS` — a hashed
  `PlayerState::burning_until`, written, not added to (`R27`, `R79`), cleared at death and respawn.
  Logged once a second (`R81`), before radiation's stage so a flare death is never named
  radiation. The burn stage is not `Playing`-gated: a burn caught late finishes after the bell
  (weather damage in `Ended` is then refused by §H12's rule).
- **Through the suit** (`R82`): 32 damage unsealed; sealed, 24 health and 8 energy over the burn
  (four absorbed seconds plus the seal's own radiation cost).
- **No new wire bit** (`R80`): `effect_start {kind: "SolarFlare", seed, duration}` plus the damage
  events; the client draws it off `GameCore::flare_points`. A flare death is a `weather` death.

## H9 — The breach vortex

**New.** `R9`, `R16`, `R19`, `R86`–`R88`, `R97`, `R98`, `T22.10`–`T22.10I`.

- **A hole in the rim is a vortex, not a way out.** Detection runs once per carve call in the two
  public carves (never per stamped disc — `R19`), and reports a breach only when the rim box goes
  **closed → open** (`R87`). A breach within `VORTEX_CAPTURE_R` of a vortex is the same hole.
- **It takes everyone inside `VORTEX_CAPTURE_R`, wings included** (`R9`.1: a vortex happens to
  you; pads and platforms are chosen), ignoring the teleport cooldown (`R86`), and puts them
  down in open space **outside `VORTEX_REACH / 2` of every vortex**, falling back to the site
  farthest from all of them — never skipping (`R86`). Fresh body, jump and jetpack reset,
  **fuel kept** (`R9`).
- **At most `MAX_ACTIVE_VORTICES` pull**; a fourth breach evicts the oldest, which **stops pulling
  and fades but keeps catching** for as long as its hole is open — the round, since a hole never
  heals (`R9`.2–3, `R88`). A hole in the rim never kills.
- **Players only** (`R9`.4, `R14`). **Not on the minimap** (`R9`.5).
- **The pull** is `VORTEX_ACCEL_MAX` at the centre, linear to `VORTEX_REACH`, **inside the capped
  sum of §H10** — so outside the capture radius thrust always escapes (`R97`). The earlier
  "no-escape radius `VORTEX_REACH / 2`" does not exist.
- **Drawn with one line, at the capture radius** (`R98`): inside it you are taken. The swirl is
  decoration, sized off the ring (`VORTEX_SWIRL_OUTER` capture radii) and faded to nothing
  (`VORTEX_SWIRL_FADE_FROM`), with no edge that implies a boundary.
- Events `vortex_open {tick, id, x, y}`, `vortex_close {tick, id}`, `vortex_trip {tick, id,
  vortex, x, y}`, scoped to everyone; live vortices are in the join catch-up.
- `MAX_PENDING_BREACHES` bounds the map's breach queue (a client's map carves and never drains).

## H10 — One field: the wells, the vortices and the black hole

**New.** `R10`, `R11`, `R14`, `R18`/`R46`, `R36`/`R61`, `R47`, `R91`, `R96`, `R97`, `R100`,
`T22.14A` H1.

- **One summation, `world::attractors::env_at`, on both sides** (`R11`): the server's
  `World::apply_inputs` and the wasm `GameCore::apply_input` call the same function with the same
  list in the same order. No second loop, no field math in TypeScript (`GameCore::field_accel_at`
  exists so a check can read it, `R67`).
- **Every attractor falls off linearly to a cutoff** (`R47`), never inverse-square.
- **Asteroid wells** (`R46`, `R47`): `well_strength(level)` = `SPACE_WELL_ACCEL_MAX` × level /
  `SPACE_LEVEL_MAX`, `well_reach(level)` = `SPACE_WELL_REACH_MAX` × level / `SPACE_LEVEL_MAX` (the
  level clamped into the table). `SPACE_WELL_ACCEL_MAX` = `JETPACK_THRUST_DOWN` ×
  `SPACE_WELL_ESCAPE_MARGIN`, so no well anywhere out-pulls the weakest thrust — **DOWN**, because
  the binding case is a player resting on a rock's underside (`R46` overturns `R18`'s UP).
  `SPACE_WELL_REACH_MAX` is `JETPACK_CLIMB_BUDGET`: a full tank always clears the deepest well.
- **The wells and every live vortex's pull are summed and capped together** at
  `SPACE_WELL_ACCEL_MAX` (`R96`, widened by `R97`) — each well was under the weakest thrust,
  their sum was not. **The black hole is added on top, uncapped** (§H11).
- **Inside the black hole's reach, neither the wells nor any vortex pulls** — only the hole
  (`R91`, `T22.14A` H1). A vortex there still *captures*, by radius.
- **A winged player in space feels no field** (`R100`): no well, no vortex pull, **no black-hole
  pull** (with it, 26 of 208 winged flights from one pixel outside the horizon died). Capture and
  the horizon are radii, not fields, and still apply.
- **Only players are pulled** (`R14`).
- **After the bell the black hole stops pulling** (`R8`.4, `black_hole::pulls`); the wells and the
  vortices keep acting on `Ended`'s neutral steps (T21.30 froze input, not physics), and inside the
  hole's reach — where they are muted — nothing pulls at all, so the results screen is still there.
- **The asteroid table is hashed** (`R36`, `R61`: x, y, r and level).

## H11 — The black hole

**New.** `R8`, `R20`, `R21`, `R90`–`R94`, `T22.14A` H2 and L.

- **Every space round, once**, owned by the round controller (`R21`), not the scheduler: the
  arrival is uniform over the last `BLACK_HOLE_WINDOW` s up to `BLACK_HOLE_LATEST` s before the
  bell (on a round too short for the window, the window is scaled, not clipped).
- **Telegraphed** `BLACK_HOLE_TELEGRAPH` s before, at the spot (`R93`): `black_hole_warn {tick, x,
  y, arrives_in}`, then `black_hole {tick, x, y}`; both scoped to everyone and in the join catch-up.
- **It eats one asteroid** on arrival — list, mask and well — **never the last** (a one-rock map
  gets the hole at the arena centre). Fixed size; it never grows (`R8`).
- **The horizon is the rule** (`R90`): `BLACK_HOLE_HORIZON_R`. Inside it you die (death cause
  `black_hole`, `R20`); outside it every thrust escapes, because the pull there is
  `BLACK_HOLE_EDGE_PULL` = `JETPACK_THRUST_DOWN` × `BLACK_HOLE_ESCAPE_MARGIN`. Linear from
  `BLACK_HOLE_ACCEL_MAX` at the centre to 0 at `BLACK_HOLE_REACH`. **The ring drawn at the horizon
  is the whole rule**; no second radius exists.
- **A black-hole death drops nothing** (`R92`). The death is the hole's only while it pulls.
- **Placements keep clear of it from the telegraph on** — respawns, mid-round joins and vortex
  destinations (`World::black_hole_site()`: warned or here, `T22.14A` H2) — and of every vortex's
  `VORTEX_REACH / 2`, live or spent (`T22.14C`); one `placement_clearance` for all three.
- **On the minimap** (`R93`). **Frozen and still drawn after the bell** (`R8`.4).
- **Drawn full size from the arrival frame** (`T22.14A` L): the disc and the ring are the rule and
  kill on arrival; only the decoration swells in (`BLACK_HOLE_GROW_MS`, drawing only).

## H12 — Meteors in space, and weather after the bell

**Overrides `docs/13` §4 in space, and `docs/13` §1 / `docs/41` §3 on weather at round end.**

- **In space a shower starts inside the rim and aims at the rocks** (`R99`): each meteor starts
  `METEOR_SPACE_INSET` (one tick's flight) inside the rim's inner face at a random angle and flies
  at a random asteroid at `METEOR_SPEED`, in a straight line.
- **Weather ordnance that reaches the rim despawns** — past its inner face, or an impact whose
  blast would bite it — without carving, damage or fragments (`projectile_despawn` reason
  `void`). **The rim breaks only from player weapons.** Standard showers are unchanged.
- **Weather damage is refused in `Ended`**, as in Warmup — one rule in `apply_damage_log`
  (`T22.14A` H3 ruling). A player's own ordnance still lands.
- **A shower's `Active` window includes its fall** (`T22.14A` H3): `METEOR_FALL_TIME` =
  2 × `PROJECTILE_MAX_LIFETIME`; meteors drop only in the first `METEOR_DURATION`, so
  `effect_start.duration` for a shower is 26 s and a shower rolled within 29 s of the bell is
  refused by the existing "would still be running at round end" rule.
- **The HUD banner** anchors on `effect_phase` → active and runs `effect_start`'s `duration` (it
  ended `EFFECT_TELEGRAPH` early before); a shower counts its dropping window, then reads
  `CLEARING` until the effect ends (`T22.14C`).

## H13 — The input path: one simulated step per player per tick

**Overrides `docs/40` §2 (`input`'s last paragraph and its §7 test line), `docs/70` §A30 and the
`MAX_INPUT_QUEUE` value in `docs/02` / `docs/41` §2.** `R89`, `T22.10B`–`T22.10G`.

- **Redundancy no longer means "a dropped packet costs nothing"**: every input of a frame is
  sent, in packets of up to `INPUT_REDUNDANCY`.
- **The room's flood guard is `MAX_INPUT_QUEUE` = `MAX_FRAME_TICKS`** = ceil(`MAX_FRAME_DT` ×
  `SIM_HZ`) = 15 inputs per player per tick — one long client frame's worth; the excess newest is
  dropped and logged. It is a flood guard only.
- **Every live player is stepped exactly once every tick** the phase takes input (`R89`): the next
  expected input if it has arrived, else a **stand-in** — the newest received input's held
  buttons and aim under the next seq. Edges are current vs previous, so nothing re-fires;
  `fire`, `use_item` and `select_slot` are commands and are never stood in. The expected seq
  advances one per simulated tick, real or stand-in; an input at or below it is discarded (after
  it has updated the held state). Never two steps in a tick, no standing delay, no hover.
- **A jitter buffer of `INPUT_BACKLOG_TARGET`** (2): future inputs wait; past it the **oldest** are
  dropped and the seq jumps past them. The expected seq *starts* that many behind the newest sent.
  A stand-in claims a seq only within `MAX_FRAME_TICKS` of the newest sent, and never before the
  first. Seq 0 means "number it next" (bots). **Before its first input a player is not stepped
  in `Lobby`/`Warmup`**; in `Playing` it gets a neutral step claiming no seq.
- **The ack is the last *simulated* seq**, real or stand-in (`World::last_simulated_seq`), not the
  last received or consumed.
- The T22.10D/E catch-up credit is withdrawn and was never specified.

## H14 — Rounds are counted in ticks

**Overrides `docs/41` §2–§3 on how a phase ends; adds to `round_state`.** `R94`, `T22.12D`.

- A phase of `s` seconds (`WARMUP_SECONDS`, the round length, `ENDED_SECONDS`) begins on the tick
  `set_phase` runs and is stepped for exactly round(`s` × `SIM_HZ`) ticks — a 240 s round is 14400
  `Playing` ticks (it was 14401: an `f32` sum reaching a float deadline). One rule for Warmup,
  Playing and the Ended vote window.
- **`round_state` carries `ends_tick`** — the last tick stepped in the phase, `null` in `lobby` —
  and `time_left` is derived from it.
- **The round clock is derived from the step count**, not summed: `round_time` at `k` steps is
  `k / SIM_HZ` (plus the dev `DEV_ROUND_CLOCK` origin).
- A client derives the bell from it: seq `ack` ran on tick `snap_tick`, one a tick, so the first
  seq stepped in `Ended` is `ack + ends_tick − snap_tick + 1` (`client/src/net/seqClock.ts`).

## H15 — The snapshot

**Overrides `docs/40` §3's `snapshot` layout and its §7 size line.** The whole layout at the
close of M22:

```
header   SNAPSHOT_HEADER_BYTES = 10
  u32 tick
  f32 round_time        the server's own f32, exact     (T22.14C; was u16 deciseconds, truncated)
  u8  darkness
  u8  player_count
player   SNAPSHOT_PLAYER_BYTES = 28, each
  … x, y, vx, vy as i32 counts of SNAPSHOT_QUANTUM (1/8 px, 1/8 px/s), rounded half away
    from zero (T22.10H; were i16 whole px, truncated) — the rest as docs/70–76 left it
  flags bit 7 = irradiated (§H7); bit 3 = shield generator only
footer   SNAPSHOT_FOOTER_BYTES = 5, per recipient
  u32 last_input_seq    the last seq the server SIMULATED for you (§H13)
  u8  stepped_buttons   the buttons the server stepped you with at that seq —
                        a stand-in's held buttons when it was one; 0 in Ended   (T22.14D)
```

`10 + 28n + 5` bytes: **183 at six players**. `SNAPSHOT_QUANTUM` is exported to the client, and
every check that charges the prediction for wire rounding derives its slack from it. Replays
store inputs, not snapshots, so none of this moved `REPLAY_VERSION`.

## H16 — Prediction and reconciliation

**Overrides `docs/42` §2 and §7.** `T22.10B`–`G`, `T22.12D`/`E`, `T22.14C`, `T22.14D`.

- **The gate compares the prediction *at the acked seq*** — position within
  `RECONCILE_EPSILON_PX` and |Δv| / `SNAPSHOT_HZ` within it, plus move mods, alive and health —
  not the current state. Only position/velocity-visible state triggers a correction; the render
  snap is a correction over 64 px.
- **A correction restores the mirror's movement state at the acked seq** before installing the
  snapshot — previous input, jump buffer, jetpack state, airborne ticks — from a per-seq history
  of `PREDICTION_HISTORY_TICKS` seqs (`GameCore::correct_player_state`; an older ack falls back to
  the current state). **The restored previous input takes the footer's `stepped_buttons`**, so a
  press the server stood in for replays as the server stepped it.
- **The client stands in exactly as the server does** (`Predictor.standIn`), and **its fixed step
  runs on the wall clock** (`performance.now()`), capped per frame at `MAX_FRAME_DT` — a client
  simulating slower than real time disagrees with every stand-in. The first frame elapses 0.
- **The mirror advances a dead player's input stream** as the server does; `alive` false → true
  resets jump, jetpack and airborne ticks as `PlayerState::respawn` does.
- **A pad or vortex arrival (and a dev placement) resets** the prediction's jump buffer, jetpack
  (fuel kept) and airborne ticks — now and in every history copy from the arrival's seq
  (`GameCore::relocate_player`).
- **One seq ↔ tick rule** (`seqClock.ts`): something the server did on tick `t` first changes seq
  `ack + t − snap_tick + 1`. From the bell's seq the prediction steps as `Ended`: **no buttons and
  no black-hole pull** (`GameCore::past_bell`). A vortex pulls for the seqs between its `vortex_open` and
  `vortex_close` ticks, the black hole from its arrival tick, re-derived on every snapshot while
  the phase takes input.
- **In a phase that takes no input** the client keeps no inputs for replay, steps one neutral
  tick per local step as the server does, and reconciles on the snapshot's **tick**; a local body
  behind by more than `MAX_FRAME_TICKS` re-anchors instead of catching up.
- **The round clock** (§7) is never stepped back by a late snapshot; a restart or a lead past one
  `MAX_FRAME_DT` is adopted whole. The death countdown never reads more than `RESPAWN_DELAY`.
- `constants_json` gains `MAX_FRAME_DT`, `MAX_FRAME_TICKS`, `METEOR_DURATION`,
  `SNAPSHOT_QUANTUM` and `MAP_GENERATOR_MAX`.

## H17 — Death causes, the killfeed and the minimap

- **Two new causes**: `radiation` (§H7) and `black_hole` (§H11). A space rim exit is the existing
  `void`. A flare death is `weather`. **Both ends** (`R20`): the server's `cause_name` and the
  client's cause allowlist, which turns any unlisted string into `player` — an unknown murderer.
- **The minimap** shows the black hole and never a vortex; the rim reads as a circle on it.
- Dev-only: `relocate {tick, id, x, y}` (everyone) for the dev placers; `debug_black_hole`
  (`DEV_PROBE=1`); `DEV_START_BATTERY`.

## H18 — Bots

**Overrides `docs/74` §E10's flame stand-off in standard.** `R5`, `R95`, `T22.03B`–`I`, `T22.14B`.

- **Bots fly in space** (`R5`): target selection, aiming and firing are unchanged; a space
  locomotion layer thrusts toward the wanted direction, burns fuel like a player, brakes against
  its own velocity (`BOT_SPACE_*`), and keeps out of hazards through the world's own predicates
  (`black_hole::clearance`, `vortex::pull_clearance` — a live vortex's whole pull —
  `vortex::capture_clearance` for spent ones, `flare::ribbon_touches`, `World::body_in_the_void`),
  closing on a destination inside a keep-out only to its edge. Winged bots in space share the
  escape.
- **Bots throw zone weapons** (`R95`): molotov and toxic grenade scored by damage over their life
  per cooldown; in zero-g a throw must reach its target; `BOT_SPACE_ZONE_REACH` is the measured
  space stand-off. **In standard the flame stand-off doubled** (`BOT_FLAME_REACH_SCALE` 2.0): at 1×
  the thrower took 4.2 hp of its own fire a throw. That is a standard-mode change, confirmed.
- The bots' tunables live in `constants.rs` as `BOT_*`, each with its basis.

## H19 — `REPLAY_VERSION`, 14 → 26

Per `docs/76` §G8, every number names every change it covers. From `replay.rs`'s own notes:

| v | task | what an older recording would silently disagree on |
|---|---|---|
| 14 | T22.01 | the header gained `gravity` (a **layout** change: one byte after `start_kit`); tag 23 `SetGravity` |
| 15 | T22.11B | `state_hash` gained the asteroid table (`R36`/`R61`); space gained its field and terminal speed |
| 16 | T22.09A | `state_hash` gained `radiation_exposure` (`R74`); the suit, radiation and the doubled pack (`R77`) |
| 17 | T22.08A | the scheduler folds five switches; `burning_until`/`burn_exposure` hashed; space rolls meteor/flare, not fog (`R85`) |
| 18 | T22.10F | one step per player per tick: stand-ins, discards, the jitter buffer (`R89`) |
| 19 | T22.10G | the buffer's lead; no step before a player's first input in `Lobby`/`Warmup` |
| 20 | T22.12 | the black hole (a hashed `World::black_hole`) |
| 21 | T22.12C | the hole's pull right-sized, wells muted in its reach, no drop, the telegraph (`R90`–`R93`) |
| 22 | T22.12D | rounds counted in ticks; the clock derived from the step count (`R94`) |
| 23 | T22.03G | the wells' sum capped (`R96`) |
| 24 | T22.03I | the wells and the vortices capped together (`R97`) |
| 25 | T22.14A | no vortex pull inside the hole's reach (H1); placements clear of a telegraphed hole (H2); weather damage refused after the bell and the shower's fall in its window (H3); space meteors (`R99`) |
| 26 | T22.14C | winged players feel no field (`R100`); respawns and joins clear of every vortex |

Only 14 changed the layout; every other bump is the silent-divergence case — no new tag.

## H20 — New and changed constants

| constant | value | basis / ruling |
|---|---|---|
| `LOW_GRAVITY_SCALE` | 0.5 | §H2, `R3`, `R31` |
| `SPACE_JUMP_BURN_SECONDS` / `SPACE_JUMP_FUEL` | 0.5 s / `JETPACK_DRAIN` × it | §H3 |
| `SPACE_MAX_SPEED` | 1350 | §H3, `R10` |
| `SPACE_RIM_THICKNESS`, `SPACE_RIM_CLEARANCE` | 32, 64 | §H4, `R13`, `R34` |
| `SPACE_ASTEROID_R_MIN`/`_MAX`, `_GAP_MIN`, `_CORE_FRAC`, `_TRIES` | 24/64, 80, 0.75, 40 | §H4 |
| `SPACE_LUMPS_MIN`/`_MAX`, `SPACE_LUMP_R_MIN_FRAC`/`_MAX_FRAC` | 2/4, 0.30/0.45 | §H4 |
| `SPACE_LEVEL_MAX`, `SPACE_LEVEL_JITTER` | 5, 0.6 | §H4 |
| `SPACE_SPAWN_GRID`, `SPACE_OPEN_SPACE_TRIES` | 64, 24 | §H4 |
| `SPACE_WELL_ESCAPE_MARGIN`, `SPACE_WELL_ACCEL_MAX`, `SPACE_WELL_REACH_MAX` | 0.75, 675, `JETPACK_CLIMB_BUDGET` | §H10, `R46`, `R47`, `R96` |
| `SPACE_VOID_GRACE` | 2 ticks at `SPACE_MAX_SPEED` (45) | §H4, `R16` |
| `MAX_ACTIVE_VORTICES`, `MAX_PENDING_BREACHES` | 3, 8 | §H9 |
| `VORTEX_CAPTURE_R`, `VORTEX_ACCEL_MAX`, `VORTEX_REACH` | 127, 1800, 4 × capture | §H9 |
| `BLACK_HOLE_WINDOW`, `_LATEST`, `_TELEGRAPH` | 60, 10, 2 s | §H11 |
| `BLACK_HOLE_HORIZON_R`, `_ESCAPE_MARGIN`, `_EDGE_PULL`, `_REACH`, `_ACCEL_MAX` | 64, 0.9, 810, 256, 1080 | §H11, `R90` |
| `RADIATION_DPS`, `RADIATION_SHIELD_COST`, `RADIATION_LOG_INTERVAL` | 1, 1, 1 s | §H7, `R24`, `R25` |
| `BATTERY_PACK_SPACE_WEIGHT_MULT` | 2 | §H7, `R76` |
| `SOLAR_FLARE_BURN_SECONDS`, `_DPS`, `_DURATION`, `_WEIGHT` | 4 s, 8, 12 s, 3 | §H8, `R12`, `R27` |
| `SOLAR_FLARE_RIBBON_R`, `_SPAN`, `_HEIGHT`, `_SAMPLES`, `_SPEED`, `_ORBIT`, `_TURN`, `_GLOW` | 14, 300, 170, 48, 90, 360, 0.35, 34 | §H8 |
| `METEOR_FALL_TIME`, `METEOR_SPACE_INSET` | 2 × `PROJECTILE_MAX_LIFETIME`, `METEOR_SPEED` × `SIM_DT` | §H12 |
| `MAX_FRAME_DT`, `MAX_FRAME_TICKS`, `INPUT_BACKLOG_TARGET` | 0.25 s, 15, 2 | §H13 |
| `MAX_INPUT_QUEUE` | ~~8~~ **`MAX_FRAME_TICKS`** (15) | §H13 |
| `SNAPSHOT_QUANTUM` | 1/8 | §H15 |
| `SNAPSHOT_HEADER_BYTES`, `SNAPSHOT_PLAYER_BYTES`, `SNAPSHOT_FOOTER_BYTES` | ~~8~~ **10**, ~~20~~ **28**, ~~4~~ **5** | §H15 |
| `PREDICTION_HISTORY_TICKS` | 2 × `SIM_HZ` | §H16 |
| `THRUSTER_PLUME_LENGTH`, `_WIDTH`, `_MIN_SPEED` | 1.4 × `PLAYER_H`, `PLAYER_W`, 1 | §H3 |
| `SPACE_SUN_*`, `SPACE_EARTH_*`, `SPACE_MOON_*`, `SPACE_STAR_*`, `SPACE_BODY_PARALLAX` | see `constants.rs` | §H5 |
| `BOT_FLAME_REACH_SCALE`, `BOT_SPACE_ZONE_REACH`, `BOT_SPACE_*` | 2.0, 100, … | §H18, `R95` |

## H21 — What this deliberately does not add

- **Spacesuit cosmetics and a visor picker** (`T22.07`) — superseded by M23's `R9`: wearables are
  removed and every figure in space wears a helmet in the player's own colour.
- **Day/night in space** — ruled out by the owner; `T21.04` stays parked.
- **A bouncing collision, orienting to a rock's surface, a growing black hole** — ruled out by
  `R1`, `R7` and `R8`.
- **Pulling anything but players** (`R14`), and **vortices on the minimap** (`R9`.5).
