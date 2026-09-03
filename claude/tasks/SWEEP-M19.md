# M19 forward sweeps — hazards found before each task starts

Written by the reviewer/orchestrator pair while the coder worked the preceding task.
**Read your task's section before you start it.** Each entry is `file:line`, the hazard,
and the consequence on the day the task lands. CONFIRMED means somebody read the code;
SUSPECTED means it needs a run, and the settling command is given.

This file records what the *task files themselves* got wrong as well. Reporting a task
defect is a valued outcome here; several are recorded below rather than worked around.

## T19.14 — the join race

- **CONFIRMED — the mechanism is mis-named.** `worldMirror.ts:153-176` fills `players`
  from the **snapshot**, which per `docs/40` §3 is the full roster including self, not a
  delta. `playerCount === 0` therefore means *no snapshot has been applied yet*, not *a
  join has not arrived*. `GameScene.ts:330-338` documents the window: the server starts
  the 20 Hz stream as soon as it seats you, so first snapshots land while `map_init` is
  still decoding and wait in `pendingSnapshot`.
- **CONFIRMED — the literal instruction kills 18 checks.** `enterBattle` has **24 call
  sites in 21 files**; only `e2e-two-clients.mjs:64,65`, `full-round.mjs:89,90` and
  `m10-checkpoint.mjs:118,119` are multi-client. "Wait for a roster with the players in
  it", implemented as *wait for two*, hangs the other 18 forever. Same shape as the
  `standStill` landmine.
- **CONFIRMED — the instrument is stale and overstates the problem.** `harness.mjs:299`
  assigns `d`; the simulating-wait at `:317-324` reads fresh data into locals **without
  reassigning `d`**; `:342-347` reassigns only when `waitPlaying` is true; `:355` then
  logs `d.playerCount`. So on the `waitPlaying:false` path the logged roster is from the
  earliest possible instant. The four checks reporting `0 players` are **exactly** the
  four that pass no `waitPlaying`.
- **Do first:** re-read `d` before `:355`, run `two-clients` ten times logging stale and
  fresh counts. Measure how much of the problem is the log lying before building a wait.
- **Recommended fix:** key the wait to `playerCount >= 1` (the first applied snapshot;
  `lastServerTick > 0` is equivalent and also in the payload), and give multi-client
  callers an **opt-in `expectPlayers: 2`**, the shape `waitPlaying` already has.
- **Task defects:** its Tests section demands the wait be pinned to "the constant that
  governs it" — **no constant governs a network round-trip plus a mask decode**, and
  reading it literally fabricates a tunable (the trap correctly refused in T19.04). Its
  Done-when is a serial loop and **cannot reproduce** the "vite did not report a port
  under sustained browser load" half it is named for.
- `LOBBY_BOT_TIMEOUT` is per-check config (`e2e-two-clients.mjs:42` = 120,
  `lobby-start.mjs:69` = 45, most default), so any bot-aware roster wait is keyed to a
  variable and behaves differently in every caller.

## T19.05 — the shovel

- **CONFIRMED — `melee.rs:341-347` asserts the opposite of the deliverable.** It requires
  every `SPEC` weapon to have `spawn_weight > 0 || crate_weight > 0 || buried_weight > 0`.
  The shovel is deliberately none of those. **Replace, do not delete** — the presence that
  replaces it is "every player spawns holding one, on join and on respawn", already the
  first item in the task's Tests list. Delete it bare and the guard that every *other*
  melee weapon is reachable disappears.
- **CONFIRMED — `melee.rs:351-354` independently decides the placeholder question** the
  task says the `WEAPON_KEYS` test decides. It asserts `registry::def(id).is_some()` for
  `[KNIFE, BAT, WHIP, AXE, HAMMER]` and passes only if retired placeholders are kept.
  Know both exist before choosing.
- **CONFIRMED — `SPEC` (`melee.rs:193-199`) drives four tests**, `:205 :228 :242 :341`.
  `:228` set-matches the whole melee roster and will not tolerate a partial edit.
- **SUPERSEDED by the chosen design — read this before touching `balance.rs`.** The
  prediction below assumed the five weapons would be *deleted*. They are not: both tables
  are id-indexed and removing entries is §B16, so retired weapons stay as **placeholders**
  and `weapons().len()` remains 23. **`balance.rs:260` is therefore untouched and must stay
  untouched** — "fixing" a control that is not broken is exactly the number-that-made-it-pass
  trap. See `HANDOFF-M19.md`'s T19.05 status board.
- **CONFIRMED under deletion only — `balance.rs:260` would fail on landing.** `assert!(weapons().len() >= 20)`
  against 22 today; retire five, add one → 18. The Done-when catches it; **the repair is
  the trap.** Its comment says it is the control against a collapsed arsenal, so lowering
  20 to 18 is "the number that made it pass". Re-derive it as a control.
- **Task omission — four dead procedural art entries, not three.** `itemTextures.ts` has
  `weapon_knife:83`, `weapon_whip:105`, **`weapon_axe:114`**, `weapon_hammer:125`.
  `weapon_bat` does not exist.
- `inventory.test.ts:93` is stale but stays **green** — `tileLabel` is a pure passthrough
  with no registry lookup. Journal note, not a blocker.
- **Task defects:** the Done-when is a filtered two-file vitest run over a change that
  touches three languages; and the 200-seed "no map spawns a shovel" sweep is an
  **absence with no control** — it passes against a build where nothing spawns at all,
  which is the re-weighting risk the task itself warns about two bullets earlier.
- **MISSED BY THIS SWEEP, found on landing** (recorded so the next sweep looks for it):
  `balance.rs::every_weapon_can_be_obtained` is a **second** obtainability assert with the
  same inversion as `melee.rs:341` — the sweep predicted `weapons().len() >= 20` in that
  file and stopped there. And nothing here mentions **bots**: `choose_weapon` and
  `should_fire` read `w.range`/`w.blast_radius`, both of which mean something else for
  `Delivery::Melee`, so issuing a shovel to every player made every bot hold one forever.
  Three bot fixtures also went on passing while measuring a swing, because `give` appends
  to the first *free* slot and slot 0 is now the kit.
- **CLEAR, do not spend time:** `is_auto()` matches `Delivery` variants not ids, so
  arsenal size cannot break it. `FIRE_CUE` is consulted only on projectile spawns and a
  `Melee` weapon spawns nothing — the shovel needs **no** entry. `scripts/` holds exactly
  one retired-weapon reference, `ordnance.mjs:335`, already booked by the task.

## T19.07 → T19.08 — the settings wire, then the screen

- **CONFIRMED — `ROUND_SECONDS_MIN`/`MAX`/`STEP` do not exist anywhere** outside the two
  task files. T19.07 must create them **and expose them in all four places** —
  `constants.rs`, `constants_json` (`game-wasm/src/lib.rs`, the `TELEPORT_*` block at
  `:1060-1066` is the pattern), the `Constants` interface (`client/src/core/index.ts`),
  and any harness reader — or T19.08 cannot render its own bounds on day one.
- **T19.07 must state its three wire keys in the commit message** (`bots`, `start_kit`,
  `round_seconds`). `parseLobbyState` (`client/src/net/lobby.ts:163-183`) snake→camels
  and has **no unknown-key detection**, so a mismatch silently yields defaults.
- **CONFIRMED — task defect: `canChangeSettings` does not exist.** T19.08's Tests name
  it; grep finds it only in the task file. The real function is `ownsSettings`
  (`lobby.ts:288`), with three callers.
- **CONFIRMED — two scale steppers, and the wrong one is the trap.** `stepMenuScale`
  (`MenuScene.ts:382`) is pre-lobby and persists through `saveScale(localStorage, …)`
  (`:195`); `stepScale` (`:393`) is in-lobby, gated on `ownsSettings` at `:395`, and goes
  over the wire. The Notes require the new settings come off the wire, so **`stepScale`
  is the model and `stepMenuScale` reintroduces the stale-local-value bug.**
- **CONFIRMED — the panel needs two stepping behaviours.** `stepIndex`
  (`client/src/ui/menu.ts:113`) **wraps** by design, so Bots and Starting weapons wrap;
  but the timer "ends disabled at each bound", which is **clamp**. Say so in the code or
  the next reader will "fix" the inconsistency.
- **CONFIRMED — `__menu.debug()` is the wrong source for the e2e.** `MenuScene.ts:432`
  returns `{...self.model}` — the local `MenuModel`, not `this.lobby` (`:46`). **For the
  guest it never held these values at all**, so a check reading settings from it is
  meaningless on exactly the half that matters. Read them off the DOM, as `visibleCode`
  (`:440`) and `roster` (`:443`) do, which is what the task asks for anyway.
- **Follow `parseLobbyState`'s optional-field pattern** (`:180-182`): fields **absent**
  rather than defaulted. Unconditional defaults make "an older server sent none"
  indistinguishable from "sent the default", and the required tolerance untestable.
- **CLEAR:** `settingsOwner`/`ownsSettings` already work end-to-end and the host gate is
  live at `MenuScene.ts:327,331-333`. `lobby.mjs:146-147` is a working e2e template that
  already asserts absences with controls (`:138-144`).
- Task defect: Done-when `--run lobby menu` matches 3 of 50 client test files.

## T19.09 — the teleport charge

- **CLEAR — the task's headline worry is unfounded.** The client has **no copy** of
  `TELEPORT_CHARGE`. `client/src/render/pads.ts:110` takes the charge as an argument, its
  docstring says "Nothing here integrates the charge", and `:121-124` records that the arc
  is drawn from the server byte so it stops the instant the server says so.
- **Everything is already pinned to the constant**: `teleport.mjs:211,217,223,439,515`;
  `teleport.rs:232,271,333,349,353,375,402,418`; `world/mod.rs:4738,4857,4894,4944,4975`;
  `codec.rs:762` (`TELEPORT_CHARGE / 2.0`, quantisation relative). Four-place exposure is
  already complete. **Golden hashes are unaffected** — `golden.rs:50-60` digests map
  generation only, and there are no checked-in `.replay` fixtures.
- **SUSPECTED, and the inverse of the task's stated risk: a shorter charge makes
  *accidental* teleports more likely suite-wide.** Any check standing still on a pad
  longer than the new charge now teleports where 2.0 s was survivable, moving the subject
  of its assertions. Precedent is in the tree: `hud-bars.mjs:58` records that T15.01's
  pads "moved the subject of every assertion" and defends with `FIXED_SEED: '4242'` — a
  defence only as good as the seed. Twelve checks call `standStill`, which holds the body
  still by design. Settle with `node scripts/e2e.mjs hud-bars terrain-render teleport`,
  then the full gate.
- **Note:** waits pinned to the constant get *shorter*, so absence assertions weaken —
  `teleport.mjs:211-223` sleeps `TELEPORT_CHARGE * 2500` and then asserts no teleport; that
  window falls from 5.0 s to 3.75 s. Correctly pinned, but the same code proves less after
  the change. Say so rather than letting it pass silently.
- Task defect: the Done-when is crate- and check-scoped and cannot see the hazard above.

## T19.06 — rain that hurts

- **CONFIRMED — `scripts/checks/m5-weather.mjs:125` hardcodes both constants this task
  changes.** `const ceiling = 2 * Math.PI * c.TOXIC_DROP_CARVE_R ** 2 * (8 / 0.4)` — that
  `(8 / 0.4)` is `TOXIC_DURATION / TOXIC_DROP_EVERY` written as literals. After the change
  the true count is `8 / 0.15 ≈ 53` and the ceiling still computes 20. A hardcoded tunable
  in a browser check inside `check.sh`.
  **Repointing it is a three-place change, not a one-liner:** neither constant is exposed.
  `game-wasm/src/lib.rs:995-997` exports only `TOXIC_POISON_DURATION`, `TOXIC_POISON_DPS`,
  `TOXIC_DROP_CARVE_R`, and `client/src/core/index.ts:220-222` mirrors exactly those three.
  Both must be added to `constants_json` **and** the `Constants` interface.
  Whether it actually goes red is SUSPECTED — the poll breaks at the first carve so `dug`
  is sampled early and may stay under the stale ceiling by luck, which is worse. Settle
  with `node scripts/e2e.mjs m5-weather`, reading the printed `${dug} px vs ${ceiling}`.
- **CONFIRMED — task defect: the "share the function" note is wrong and following it
  literally violates §E13.** `explode()` (`weapons/explode.rs:140-206`) has **no roof or
  LOS check at all** — just `let d = (p.pos - at).len(); if d > radius { continue }`, plus
  a `map.carve_circle` at `:148`, falloff damage and `KNOCKBACK_MAX` impulse. Handing it
  `TOXIC_SPLASH_R` = 28 carves a **28 px crater** against a `TOXIC_DROP_CARVE_R` of 6,
  deals instant damage instead of poison, and knocks players around — the one thing
  `docs/13` §3 and `toxic.rs:1-6` say rain must never do. The "roof + radius shape" is a
  **pattern in `meteor.rs:117-131`** (partition by `under_a_roof`, *then* call `explode`),
  not a helper. The genuinely shared thing is `poison_lands`/`under_a_roof`
  (`effects/mod.rs:42`), already shared by `toxic.rs:172` and `meteor.rs:119`.
  Safety net: `world/mod.rs:3879` asserts every carve radius equals `TOXIC_DROP_CARVE_R`,
  so an `explode`-based splash fails — after the fact.
- **CONFIRMED — the roof call site passes the landing point where the parameter means the
  victim.** `world/mod.rs:1319` — `poison_lands(&self.map, at)`. `at` is where the drop
  stopped; the parameter is named `victim`. They coincide **only** because the drop stopped
  on that player. The deliverable says the roof rule applies **per victim**; add the radius
  loop and leave this call alone and the roof is evaluated once at the landing point, with
  every test still green because no current test has two victims at different roof states.
- **CONFIRMED — the terrain-landing branch poisons nobody, and that is where the feature
  lives.** `world/mod.rs:1327-1330` returns early when `victim.is_some()`; the `else` path
  carves and poisons no one. A 20 px player on a 1536 px map means nearly every drop takes
  the terrain path — which is why the effect is dead. Add splash to **both** branches; the
  terrain branch is the one that matters. The comment at `:1308-1310` — *"Whoever it landed
  on, not everyone nearby: a drop is not a blast"* — asserts the opposite of the new
  deliverable. Rewrite it, do not leave it standing.
- **CONFIRMED — the task asks you to check a projectile cap that does not exist.** No
  `MAX_PROJECTILES` in `constants.rs` or `weapons/projectile.rs`. Report its absence rather
  than inventing one. The cost is real but is an **event** cost, not a snapshot cost:
  projectiles are not in the binary snapshot; `world/mod.rs:1202-1215` emits
  `ProjectileMove` for every live projectile every 3rd tick. ~12 drops airborne today →
  ~33 after, i.e. ~240 → ~660 move events/s. Computable exactly; no measurement needed.
- **CLEAR:** `a_drop_that_lands_on_a_player_poisons_them_and_a_bystander_is_untouched`
  (`world/mod.rs:3966`) **survives** — the bystander is 100 px away, comfortably outside a
  28 px splash. Every drop-count test is already pinned to `TOXIC_DURATION /
  TOXIC_DROP_EVERY` (`toxic.rs:243,311`, `world/mod.rs:3860`). `TOXIC_SPLASH_R` is new
  (`docs/75` :361 gives 28.0). `TOXIC_GRENADE_*` is a separate family and shares nothing.
- Stale prose, journal only: `toxic.rs:60`, `hud-bars.mjs:600`, `world/mod.rs:3944` all
  quote the old ~20-drops arithmetic.

## T19.07 — private-game settings, the wire

- **CONFIRMED — the deliverable table and the Notes contradict each other, and one reading
  breaks seven browser checks.** The table says `round_seconds` defaults to `MIN`; the note
  says *"the env var stays as the default"*. `ROUND_SECONDS_MIN` is 240 and `constants.rs:200`
  `ROUND_SECONDS` is also 240, so they agree **only until someone sets the env var**. Seven
  checks set it and derive assertions: `round-end.mjs:38,51` (**20**), `hud-timer.mjs:35,42`
  (**90**), `crates.mjs:57,107` (140), `ordnance.mjs:64`, `ordnance-visible.mjs:56`,
  `quick-throw.mjs:33` (180), `teleport.mjs:57` (300). Default to the constant and all seven
  silently get 240 s rounds — `round-end` fails at *"round never reached 'ended' in 20s"*,
  `hud-timer` at *"never entered its warning state in 70s of a 90s round"*. **Both present as
  timeouts, indistinguishable from the flakes T19.15 exists to remove.** They are safe *iff*
  the setting is scoped to private rooms with the fallback kept at `config.round_seconds`;
  they never become private (`enterBattle` drives `#lobby-start`/`startWithBots`, and nothing
  in `scripts/` calls `set_identity` with `private: true`). **Resolve the contradiction in the
  task file before implementing.**
- **CONFIRMED — `ROUND_SECONDS_MIN`/`_MAX`/`_STEP` do not exist**; they appear only in
  `docs/75-amendments-v7.md:362-364` (240/600/60). Every bounds test the task demands needs
  them in `constants.rs` first — and in all four places, or T19.08 is blocked (see above).
- **CONFIRMED — do not touch `ReplayHeader`.** It is fixed-layout; `REPLAY_VERSION = 2`
  (`replay.rs:48`) and `:553` rejects any other version. `:388-394` carries an explicit
  warning that shifting a field moves `bot_count`, `bot_skill` and `dev_loadout`, and records
  that this has already gone wrong once. Add the three settings as **`ReplayCommand` variants
  (tags 19, 20, 21)**, appended after `SetScale(..) => 18` (`replay.rs:156`). Appended tags
  need no version bump because no existing replay contains them.
- **Task gap — the kit must be granted on **respawn**, and the existing function is not
  called there.** `grant_dev_loadout` (`room.rs:1113-1125`) returns early when
  `self.world.is_none()`, and its comment says its call sites are join and match-start.
  Confirm a respawn call site exists; if not, that is a third caller, not a reuse.
- `BOT_COUNT` is read by **28** files, not the 21 the task claims. The env stays the default
  so none break — recorded so nobody "tidies" on the strength of the lower number.
- **CLEAR:** `replay.rs:746` `every_command_really_is_every_command` is an exhaustive `match`
  *"rather than a count so the compiler names the missing variant"* — three new variants that
  are not listed **will not compile**, so the classification and round-trip paths cannot be
  silently missed. `lobby_state_payload` (`events.rs:441-469`) is already additive. **`SetScale`
  is a complete worked example across all five layers** — `room.rs:95,155,342,742,1490-1499`
  and `replay.rs:93,156,420,632` — copy it term for term.
- Unsettled from source: whether the client lobby reducer tolerates unknown keys strictly or
  loosely. Settle with `npm --prefix client test -- --run lobby` after adding the three
  fields, before wiring any UI.

## T19.10 — fog fills the screen

- **CONFIRMED BLOCKER — `terrain-render.mjs:289` pins the exact depth list and this task
  breaks it.** `const EXPECTED = [-30,-29,-28,-22,-21,-20,0,9,10,19,20,30,38,39,40,50]`,
  compared by `depths.join(',')`. `sceneDepths()` (`SandboxScene.ts:665`,
  `GameScene.ts:1812`) collects every layer with `depth <= DEPTH.lightmap` (50), and
  `weather-visible` runs in the **sandbox** (`window.__game.regenerate('4242','medium')`),
  so the veil must exist there for the pixel acceptance. **Any veil depth ≤ 50 joins that
  list and turns `terrain-render` red on the day this lands** — in a check T19.10 never
  mentions. This is the `standStill` shape exactly. Either place the veil above
  `DEPTH.lightmap` (the 50–60 gap, which `sceneDepths` filters out) or update `EXPECTED`
  deliberately; the task's *"pick the depth deliberately and say why"* should record which.
- **CONFIRMED — `FOG_SCREEN_ALPHA` and `FOG_SCREEN_COLOUR` do not exist in any language.**
  `constants.rs` has only `FOV_FOG_MULT:175`, `FOG_DURATION:665`, `FOG_RAMP:667`. §F11 gives
  0.8 and 0x9AA0A6. Four-place treatment required — `constants.rs`, `constants_json`
  (`game-wasm/src/lib.rs:~973`), the `Constants` interface (`client/src/core/index.ts:207`),
  and the use site. T19.10's Read first names neither middle place.
- **CONFIRMED — the sandbox has two fog paths and the veil must pick the right one.**
  `SandboxScene.ts:616,621` compute `fogMult` from a **boolean** `fogActive`; `:764,768-770`
  use the real strength `w.fog`. `weather_json` already exposes `"fog": f.strength(now)`
  (`game-wasm/src/lib.rs:833-841`). A veil driven by `fogActive` is binary and fails the
  sampled-across-the-ramp unit test — it must read `w.fog`.
- **SUSPECTED — the HUD control patch may not exist in the sandbox.** The task requires *"a
  HUD patch is unchanged between the two frames"*, but `sceneDepths`' own comment says the
  sandbox panel and HUD are *"DOM or per-scene furniture"*. If it is DOM there is no
  in-canvas region to sample. Settle with `node scripts/e2e.mjs weather-visible` plus a
  temporary dump of the top-right region, or check whether `samplePatch` reads page or canvas.
- Not a defect but say it in the header: `weather-visible.mjs:10-12` argues a control *region*
  cannot work for a full-screen cast, and this task adds one. They are consistent — the HUD
  patch works *because* it is excluded from the veil, which is the property under test.
- **CLEAR:** `fog.rs strength()` already implements the `FOG_RAMP` smoothstep both ways
  (`:24-36`) and needs no change.

## T19.11 → T19.12 → T19.13 — the fire chain

- **CONFIRMED — a flame needs a `WeaponDef`, and no task file says so.** `Projectile` requires
  `weapon: WeaponId` (`weapons/projectile.rs:22`) and T19.13 demands `KIND_BY_WEAPON_KEY`
  resolve the flame key. So **T19.11 must append `WEAPON_FLAME` to `WEAPONS`** (append, never
  insert — §B16, `defs.rs:770`), which forces `WEAPON_KEYS` in
  `client/src/render/ordnance-state.ts:92` to gain `'flame'`, enforced by the pinned
  `weaponKeysMatchTheRustRegistry`. **T19.11 is a two-language task, not the Rust-only one it
  reads as.** §F10/§F10.1 and §F11's eleven `FLAME_*` constants never mention a weapon key.
- **CONFIRMED — `every_weapon_digs` (`defs.rs:885-888`) breaks in both directions.** The
  exemption is `matches!(w.delivery, Delivery::Cone { .. }) || MAY_NOT_CARVE.contains(&w.key)`.
  T19.11's flame has continuous DPS so `damage: 0.0` → `assert!(w.damage > 0.0)` fails.
  T19.12 deletes `Delivery::Cone`, removing the flamethrower's only exemption, and §F11
  retires `FLAMETHROWER_DPS` which is currently its `damage` (`defs.rs:565`) → it fails the
  same assert **and** `blast_radius > 0.0`. The test's comment says exemptions are named *"so
  a new weapon cannot silently join them"*, so re-derive deliberately. A `Burst` variant that
  is not `Blast` is the existing escape hatch (`defs.rs:882`) and is probably the honest
  answer for a weapon whose effect is what it leaves behind.
- **CONFIRMED — `BurnZone::Fire` (`defs.rs:166`) is a second enum neither T19.12 nor §F10.2
  names.** It mirrors `burn::BurnKind` so `defs` need not depend on the burn module;
  `world/mod.rs:1557` maps between them. Retire `BurnKind::Fire` alone and a variant survives
  that can no longer be mapped.
- **T19.11 lands a flame with no emitter by design** — T19.12 supplies them. Say in T19.11's
  journal that the production-caller grep is **deferred to T19.12**, or a future reader meets
  the "built, unit-tested and wired to nothing" shape and concludes it was forgotten.
- **CONFIRMED — retiring the molotov's `Burst::Zone` re-opens a documented bug, and nothing
  names it.** `bots/mod.rs:927` `zone_reach` returns `Some(radius + scatter)` only for
  `Burst::Zone`; `stand_off` otherwise falls back to `w.blast_radius`, which is **0.0** for the
  molotov (`defs.rs:654`), giving the `.max(40.0)` floor. The comment at `bots/mod.rs:~630`
  describes exactly this: *"a bot closed to the 40 px floor and stood in the fire it had just
  thrown … molotov self-harm stayed the highest in the arsenal"*. Derive a reach from
  `MOLOTOV_FLAMES` × `MOLOTOV_FLAME_SPEED` spread, or the regression is silent.
- **CONFIRMED — `effects/lava.rs:386` asserts the old afterburn model** (`LAVA_JET_DPS *
  LAVA_JET_DURATION + LAVA_BURN_DPS * LAVA_BURN_DURATION`), applied at `lava.rs:140`. Both are
  T19.12's to rewrite and neither is in its list.
- **Doc gap — §F11's Retired table omits `LAVA_BURN_RADIUS` and `LAVA_BURN_DPS`**, which lose
  their last readers (`burn.rs:68-70`, `defs.rs:664-665`, `lava.rs:140`). `LAVA_BURN_DURATION`
  must **survive** — it is the afterburn window and `effects/scheduler.rs:16` reads it.
- **Task weakness — T19.12's reach assertion is vacuous.** `FLAME_MUZZLE_SPEED × FLAME_LIFE` =
  320 × 5 = **1600 px** as an upper bound against a retired `FLAMETHROWER_RANGE` of 150; with
  `FLAME_GRAVITY_SCALE` 0.35 the real reach is a small fraction of that, so the bound holds
  with the feature deleted. Assert the measured reach against a band instead.
- `ordnance.mjs:321` is the **precondition** (`before.jets === 0`), not just the assertion at
  `:348`. Both die with `Delivery::Cone`. The pre-flight's `hazard_at` line has drifted — it is
  `bots/mod.rs:610` now (T19.04 removed ~50 lines), reading `world.burn.patches()` at `:612`.
- **The two task files disagree about the burning-ground draw.** T19.13 calls `weather.ts`
  `fireGfx` *"the burning-ground draw being removed"*; it is not. `drawFire` (`weather.ts:114`)
  draws vent **embers** plus a per-vent disc at a hardcoded radius 26 (`:154`), and T19.12 says
  the vent telegraph and jet are unchanged. The molotov's burning ground is
  `ordnanceFx.ts:96-97` via `state.hazards`. Both need touching; only one is named.
- **T19.13:** `lightmap-math.ts:85` types hazards as `'lava' | 'burn' | 'meteor'` and
  `HAZARD_RADIUS` (`:93`) is an inline map `{ lava: 150, burn: 90, meteor: 120 }` — a flame kind
  needs both, and `FLAME_RADIUS` (10) is the honest source rather than a fourth inline number.
  `FLAME_MAX_LIVE` 160 lights through `lights()` (`:155`) against today's handful, so the perf
  demand is correct. Its Done-when omits `./scripts/check.sh` where T19.11's and T19.12's
  include it, and its filtered `--run ordnance` cannot see `inventory.test.ts`.
- **CLEAR — the state-hash churn is contained.** `world/mod.rs:2867` folds `burn.hash_into`
  into the world hash, so T19.12 and the flames both change it — but `golden.rs` pins **map
  generation only**, and there are **no committed `.replay` fixtures** (`replay_run` records
  into a tempdir). No golden table needs regenerating for this chain.
- **CLEAR — T19.13's deterministic-flicker requirement is load-bearing and correctly
  specified**: the e2e counts clusters across two frames, so a per-frame re-roll would make it
  a coin flip. Keying to flame id + time is right.
