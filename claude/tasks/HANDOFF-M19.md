# M19 handoff — what is not recoverable from the diff

Written when the T19.01/T19.02 coder was retired at ~690k tokens. Everything here is a
thing the code does not say about itself. The spec is `docs/75-amendments-v7.md`; the
tasks are `tasks/M19/`. This file is the rest.

## Seams, and what must stay in step

- **`weapons/bullet.rs` owns two things.** `muzzle_angle` is the *only* spread draw —
  `Projectiles::spawn` stays RNG-free because the meteor, rain and airburst callers do
  not want a draw. `resolve` is the *only* place a stopped bullet becomes damage or a
  carve.
- **A bullet is not `Burst::Blast`.** `explode` falls off from blast centre to victim
  **centre**, and a body is wider than a pistol's 3 px radius — route a bullet through it
  and every gun deals ~0 damage with every table test still green (§F1, D-62).
- **Four sites decide what a `ProjectileOutcome` means**: `world::detonate`,
  `game-wasm::combat_step`, and two test helpers. All four call `bullet::resolve`. A fifth
  that does not is the fork D-62 is about.
- **`integrate()` in `projectile.rs` is a function only so a test can falsify it.** It
  holds §F1's straight-flight rule. Inline it and the guard becomes unfalsifiable, because
  every shipped bullet already has `gravity_scale`/`wind_scale` of 0.0.
- **`FIRE_CUE` (`GameScene.ts`)** is keyed by weapon **key** through `WEAPON_KEYS`, which
  is pinned to the Rust table. `null` = silent by design (weather); **absent** = a gap,
  and only absent increments `unmappedFireCues`. Exactly the 14 `Projectile`/`Bullet`
  weapons need entries.

## Checks that are timing-sensitive

- **`bullets-visible`**: a screenshot costs ~150 ms, a round crosses the screen in ~475 ms
  at zoom 2. It fires 6 shots and needs >=2 catches. **If it goes flaky, lengthen the
  sampled region — never loosen the movement rule**, which is the only assertion a hitscan
  build cannot pass.
- **`birds`** leads its shot by `dist / SMG_MUZZLE_SPEED`. It was one tick when hitscan
  was instant.
- **`net-smoke`**'s deadline races `LOBBY_BOT_TIMEOUT` (D-59's sibling).
- **`crates`** loses its timing under full-suite load and passes alone (D-59).

## Traps that cost the last agent real time

- **`core.carveCapsule` carves the *client's* mask only.** The server's map is untouched,
  so a round "flying down a carved lane" hits real terrain ~96 px out. Find a clear lane
  with `core.solidAt`; do not make one.
- **Zoom is 2.** An aim point 700 world px away is off-screen, and clamping the mouse
  silently changes the firing angle. Aim ~120 px along the lane.
- `window.__game.debug().drawnProjectiles` is the **drawn** position; the mirror's differs
  (§C7).
- **Absolute brightness is useless where the sky saturates at 255.** Diff per column
  against a control frame, and re-baseline before a control run or craters from earlier
  shots read as signal.
- **The e2e summary prints failures only at the end.** Grepping `FAIL:` mid-run reports 0
  while a check is already red.

## Code that reads wrong and is right

- `a_self_hit_is_reduced_the_same_way_a_blast_is` proves nothing today —
  `SELF_DAMAGE_MULT` is 1.0. The comment says so. It exists so a future non-1.0 value
  cannot land unnoticed. Do not delete it.
- `the_shipped_bullets_fly_flat_through_a_crosswind` **cannot** detect the guard it looks
  like it tests; `the_guard_is_what_keeps_a_bullet_flat_not_the_table` is that test. Both
  are deliberate.
- `LOOK.bullet.r = 2` breaks the `r >= 3` rule on purpose: a bullet's visibility is
  `BULLET_LENGTH`, not its radius.

## Environment

- **A fresh git worktree has no `client/src/core/pkg/`** — it is generated and gitignored,
  so `localInput-math.test.ts` fails to import until `wasm-build` has run *there*. Not a
  defect; it has looked like one twice.
- **`vitest run` does not typecheck.** Five strict-mode errors passed a green client suite
  and were caught only by `tsc`. A green client run is not evidence the client compiles.
- **`node scripts/wasm-build.mjs` fails on roughly alternate runs** (`invalid type:
  sequence, expected a string at line 7 column 11`), and every client test hook runs it
  first. That is T19.15. Until it lands, a red client suite deserves one re-run before you
  believe it — and exactly one.

## Loose ends, standing and unclaimed

- **`game-wasm/src/lib.rs:643`** — the sandbox's *generic* projectile fallback still
  hardcodes a bazooka blast (42 px, 45 damage, `WeaponId(0)`) and hand-derives
  `SelfInflicted` for every non-bullet projectile. Pre-existing, wrong in the same shape
  as the bug T19.01 fixed, deliberately not widened into. **Somebody's next task.**
- **`TRACER_WIDTH` kept its name** while `TRACER_LIFETIME` became `BEAM_LIFETIME`. §F11
  renamed only the one.
- **Bots do not lead a moving target** now that rounds fly. T19.04 re-runs the balance
  harness and should measure it.
- **`GameScene.ts:~1281` — `stepRepeatFire(dt)` is fed the raw, unclamped frame delta**
  while the simulation on the very next line clamps to `Math.min(this.acc + dt, 0.25)`. A
  10 s `dt` — a backgrounded tab refocusing — emits **100 `sendFire()` calls in one
  frame**, 99 refused. Same unbounded-payout shape as T19.03's banking bug, sourced from
  `dt` rather than `since`, and latent in the original `while` loop rather than caused by
  the fix. The codebase has already decided 0.25 s is the most one frame may advance; the
  repeat clock should honour the same ceiling. **One line. Assigned to the coder to take
  immediately after T19.04.**
- `WEAPON_AIRBURST_PELLET` is still `Hitscan` — nine flying bodies per airburst is what
  `burst_pellets` exists to avoid.

## From the T19.04 coder, retiring at ~535k

- **`standStill` is keyed to settling, not to a threshold.** It waited for
  `|vel.x| < FIRE_MOVE_MAX_SPEED`; §F4 retired that constant, so it now releases the keys
  and waits until the velocity **stops changing** (two equal readings, or zero). There is
  no "stopped" constant any more and inventing one would be a tunable nobody chose — that
  is why it is shaped this way, so please do not reintroduce a number. It also **no longer
  throws**: failing to settle used to mean every following shot was refused, and now means
  a slightly noisy measurement. Twelve checks call it.
- **The §F4 balance numbers**: 8 seeds, `SKILL 0.85`, "before" measured in a control
  worktree at `41233a1`, "after" in the working tree — `cargo test -p game-core --release
  --test balance -- --ignored --nocapture`. Per-weapon damage/bot-s rose almost everywhere
  (pistol 1.73→2.32, laser_smg 1.98→2.52); total bot `fires` **fell** in every
  configuration while damage rose in four of six — fewer shots, better ones, because bots
  no longer spend ticks planting. **`density_report` is `#[ignore]`d, so the gate never
  runs it**; it was **red at the base commit** (15.9 of 24 against a 16 floor) and green
  after. That is drift crossing a marginal threshold, **not** a fix, and must not be
  reported as one.
- **The `replay_run` guard rewrite — the piece to re-derive before trusting.**
  `a_perturbed_command_is_localised_to_a_nearby_tick` corrupts 20 late commands and checks
  each divergence is localised to within a `CHECKPOINT_STRIDE`. Two guards sit under the
  loop: a floor (`diverged >= 5`, detection works) and a **straddle** — it required both
  some divergences and some wash-outs, on the reasoning that if every sample goes the same
  way the count has stopped measuring where the boundary is. §F4 deleted the boundary from
  the recording: bots fire while moving, so a corrupted button becomes a shot and a shot
  becomes a terrain difference within a tick or two, and no sampled tick has too little
  round left to compound. Measured — **before 11/20 diverged, 9 washed out (the last nine
  ticks); after 20/20, 0 washed out, and still 20/20 with the window slid to the final 20
  candidates.** So its own advice, "move the window, not the floor", cannot work: it was
  written for a terrain change and this is not one. The guard now fails only on
  `diverged == 0` — the genuinely vacuous outcome, where every assertion above is skipped
  in silence — and prints a note when the wash-out tail is absent. The floor is untouched
  and the localisation assertions now run on 20 divergences instead of 11. Falsified by
  forcing detection to collapse: red. **A reviewer should look at this specifically.**
- **`was_knocked` now has no reader.** Its only callers were the §C20 gate and the bot
  mirror. `knocked_until` is still written by all four throwing paths and folded into the
  state hash, so it was left alone — removing it would change every golden hash for a
  reason unrelated to knockback.
- **`MAX_FRAME_DT` is shared, and the clamp is untested.** The repeat clock and the
  fixed-timestep accumulator now read one named constant in `GameScene`, so they cannot
  drift. But `GameScene` cannot be loaded by vitest (no canvas), so **deleting
  `Math.min(dt, MAX_FRAME_DT)` at the call site leaves every unit test green.** The
  sharing is the guard; the test describes the contract and says so.
- **`backdrop-real` was green in T19.02's and T19.03's gates and is now red alone on an
  idle box** — 11 failed, 216 s, `Test timed out in 5000ms` on tests that take 5–32 s, and
  **identical at the base commit with the working tree stashed**. That combination is the
  useful part: it is not a slow test and not a regression, it is environmental drift on
  this machine. T19.15.
- **Two more turn-eaters.** `cargo test --workspace` saturates the box, so the *next*
  stage's wall-clock assertions run loaded — that is where `in_progress`'s join race and
  `hud-timer`'s redness margin bite. And a doc-comment block above a constant belongs to
  it: cutting a constant by walking backwards over `///` lines swallowed
  `ROOM_EMPTY_TTL`'s comment and left it undocumented.

## From the T19.04 reviewer/repair pass — what the fixes left standing

The task landed green (`cargo test -p game-core && cargo test -p game-server &&
./scripts/check.sh`, EXIT=0). What follows is what does not fit in a journal entry.

- **The balance numbers, re-measured on a clear box, and they reproduce.** 8 seeds,
  `SKILL 0.85`: pistol **2.32** dmg/bot-s, laser_smg **2.52**, revolver 2.60,
  laser_pistol 2.18, machinegun 2.15, deagle 2.12, smg 1.93; bazooka 0.77, grenade 0.42.
  Median **1.77**. These match the previous coder's "after" figures exactly, which is
  worth knowing given that everything *else* they reported was measured against a tree
  that could not pass `cargo test -p game-server`. **`density_report` passes — do not
  report that as a fix.** It was red at the base commit at 15.9 of 24 against a 16 floor;
  distinct coverage now reads 15.2 (Small), 15.2 (Medium), 16.8 (Large). That is drift
  across a marginal threshold, and it will drift back.
- **`balance.rs:275` — `WINDOW: f32 = 25.0` is a wait against a repealed tunable.** Its
  comment says it was lengthened from 10 s *because* §C20 delayed the first shot to
  t≈13 s. §F4 removed that delay. Measured this run: **first contact 1 s** in the shipping
  config, encounters spread **0–43 s** by scale, first weapon pickup **12–14 s**. The test
  runs the window twice, so the over-wait is paid twice. Somebody's next task — the
  numbers to size it are here so nobody has to re-measure.
- **Stale §C20 prose, left standing deliberately.** These assert a repealed gate is live
  and **will mislead the next reader**: `quick-throw.mjs:63,153`, `teleport.mjs:154`,
  `ordnance.mjs:171,485`, `death.mjs:82,282`, `bots/mod.rs:1137`, `world/mod.rs:4539`.
  They were left because none of them changes behaviour and a prose sweep across six
  files is not this task. `bots/mod.rs:1534` was the one that mattered — a control test
  whose whole attribution argument was "§C20 makes an armed bot plant itself rather than
  close" — and its RIGHT assertion is restored and passing. The three mentions in
  `harness.mjs:364,368` and `world/mod.rs:3410` are *history* explaining the repeal and
  should stay.
- **`was_knocked` has no reader and survives on `pub`.** `dead_code` does not fire on a
  public method, so nothing will tell you it is unused. `knocked_until` is still written
  by all four throwing paths and folded into the state hash; removing it would churn
  every golden hash for a reason unrelated to knockback. Carried forward from the
  previous coder, still the right call.
- **`MAX_FRAME_DT` moved into `client/src/input/autoFire.ts`.** That file is *not* new
  and not out of scope — it is tracked, `RepeatFire` has lived there since T19.03
  (`git log -1 -- client/src/input/autoFire.ts` → `73928bc`), and T19.04 has no **Touch
  only** section to be outside of. It had to live somewhere vitest can load: `GameScene` cannot be imported
  without a canvas, so a constant declared there is one no test can reach, and the test
  had declared a third copy of `0.25` and was asserting against itself. The scene and the
  test now import the same exported constant. The clamp at the call site is still
  untestable from vitest — that is stated in the test rather than papered over.
- **The `replay_run` guard has a narrow residual exposure.** It now fails only on
  `diverged == 0`. Drift toward *all* wash-outs is no longer caught at the top: **19 of 20
  uninformative would pass it**, where the old straddle assertion failed that end. The
  `diverged >= 5` floor sits underneath and would catch it well before 19, so the window
  is genuinely narrow — but it is real, it is new, and nobody had written it down.
- **`bullets-visible` is a load flake, and there is no causal path to the fixes.** Red
  inside the full suite, green alone in 20.5 s, green inside the full suite after the
  `standStill` repair — a sequence that on its own cannot tell a repair from a coin flip.
  It is stronger than that: `bullets-visible:60` passes `waitPlaying: true`, so the body
  has stood in the world through a 10 s `WARMUP_SECONDS` before `standStill` at `:143`,
  with no keyboard input in between. It is already grounded and settled when the helper is
  reached, so **`grounded` changed nothing for this check and the new throw cannot fire in
  it**. Neither fix touches it; the redness is load. Do not re-open the question on the
  strength of the timing coincidence. If it recurs, the standing advice above applies —
  lengthen the sampled region and **never** loosen the movement rule, which is the only
  assertion a hitscan build fails.
- **A harness trap that cost this session a red gate read as green.** `./scripts/check.sh
  | tail -80` reports **tail's** exit status, not the gate's — D-64 one layer up, in the
  invocation rather than in the script. Redirect to a file and read `$?` from the gate
  itself.
- **`standStill`'s throw has no retry, and that asymmetry is free to close.** The throw
  sits *inside* the poll loop, so one transient malformed payload is fatal where the old
  body would have polled on to the deadline. No live case exists today — the only null
  window is before `addPlayer`, and `enterBattle` precedes every caller — but the fix is
  to poll past a missing body and throw only if it is **still** missing at the deadline.
  Not done here because it is a behaviour change in a helper twelve checks depend on, and
  it would cost a fresh 20-minute gate to prove. Next task.
- **The no-throw half has a known limit: nothing reads the return value.** A body that
  never settles produces a `standStill: still drifting` line on stdout and nothing that
  fails, so "did a check silently measure a drifting body?" is answerable only by reading
  the log. That absence *is* the sound instrument, though — no such line across a green
  suite is direct evidence no caller hit the deadline. Judge it on that, **not** on the
  wall-clock deltas (teleport +3.3 s, birds −0.6 s, death +0.1 s): one sample each with a
  negative in the set is noise, and cannot resolve a single 4 s timeout either way.
- **Two checks were hand-rolling `grounded` immediately before calling `standStill`.**
  `teleport.mjs:155` loops `for (let w = 0; w < 20 && !(await dbg()).player?.grounded; …)`
  and `:394` runs `await until((d) => d.player?.grounded, 8_000, 'the jump to land')` —
  both directly above a `standStill` call. Checks compensating by hand for the exact term
  the helper was missing is the evidence that `grounded` belongs *in* the helper. Written
  down so nobody later removes those waits as redundant without knowing why they existed.

## IN PROGRESS — T19.15, two of three landed (coder retiring at ~360k)

`TASKS.md` box is **unticked** deliberately. Two deliverables are done and proven; the
third is not, and its task-file framing is wrong.

### Landed 1: the wasm-build coin flip (fixed)

`node scripts/wasm-build.mjs` failing on "roughly alternate runs" with
`invalid type: sequence, expected a string at line 7 column 11` is a **concurrency bug**.

- The document is `client/src/core/pkg/package.json` — wasm-pack's **own output**. It
  re-reads it as `HashMap<String, String>` to merge npm deps
  (`wasm-pack-0.15.0/src/manifest/mod.rs:634`). Line 7 is `  "files": [`, an array where
  that map demands a string, so the parse fails *there* every time it happens at all.
- **A lone build cannot hit it.** `create_pkg_dir` (`command/utils.rs:40`) does
  `remove_file(out_dir/package.json)` and `step_create_dir` runs before `step_create_json`.
  18 serial runs passed; planting deliberately unparseable JSON was silently overwritten,
  `rc=0`. **The old "deleting `pkg/package.json` beforehand changes nothing" finding was a
  no-op duplicating a step wasm-pack already performs** — it looked exculpatory and was not.
- The only window is another process re-creating the file between those two steps. Two
  concurrent builds: **3 of 6 failed**, first attempt, exact error string. It has a second
  face — `Optimizing wasm binaries with wasm-opt... No such file or directory` — one build
  losing the intermediate another replaced. **One cause, two error strings**; triaging them
  separately chases two ghosts.
- Fix: a lock in `wasm-build.mjs`, because four hooks (`predev`, `prebuild`, `pretest`,
  `pretypecheck`) share one out-dir and serialising callers is a guard the fifth forgets.
  It **waits** rather than skipping (a caller needs a fresh `pkg`, and half-written is the
  bug being fixed), records the holder pid, and steals a dead holder's lock so a killed
  process group cannot wedge the repo. Lock lives at `target/.wasm-build.lock` (gitignored).
- **Proof, and how to re-prove it:** 2-way × 5 and 4-way × 3 both gave **0 failures**;
  commenting out only `acquireLock()` restored **3 of 6**. The written Done-when
  (`for i in $(seq 1 20)`) is **serial and passes against the broken tree** — it proves
  nothing about this bug. Any future proof must be concurrent.

### Landed 2: `backdrop-real` (attribution fixed, budget untouched)

Not a budget problem. `distCache` was filled lazily by whichever `it()` asked first, so one
test carried the chamfer against the default 5 s while `beforeAll` already had 120 s. The
memoisation comment claimed "computed once per `build()`" and the code did not do it;
`build()` now calls `distToSolid()` and the comment is true.

**This is not a speed fix and not the cause of any timeout** — measured, the chamfer is
66 ms / 143 ms / 257 ms (Small/Medium/Large 8.4 Mpx), under 1 % of a file whose individual
tests run 20-33 s. The 33 s is the tests' own full-map scans crossing into WASM per pixel:
legitimate work. **No budget was widened.**

**The reported `Test timed out in 5000ms` never reproduced** — not alone idle (42/42,
214.8 s), not alone under 8 CPU spinners (42/42, 317.8 s), not in the full client suite
(50 files / 778 tests green, 213.2 s). Mechanism worth knowing: vitest's timeout is a
timer, and these test bodies are **synchronous**, so the timer cannot fire until the body
returns — which is why 33 s tests pass against a 5 s default.

### NOT landed: `hud-timer` — the task's premise is wrong

**Load is not the variable.** 20 interleaved runs (idle vs 8 CPU spinners), box verified
idle before each and checked for leaked load after each:

```
idle    n=10  dr 40.1 .. 44.9  mean 44.15   0 failures
loaded  n=10  dr 40.0 .. 45.9  mean 44.87   1 failure (at exactly 40.0)
full 41-check e2e suite  n=1   dr 45.1
```

The loaded arm reads **higher** than idle, and the real browser suite — the condition under
which the original "+38.4" was reported — sits at 45.1, above everything. The near-failures
were one in *each* arm. The flake is an intermittent bimodal `after` sample (normally
+2.9..+3.7, twice −1.1 and −2.3) that **reproduces on a completely idle box**. The `before`
reading is rock steady at −41.0..−42.3.

**A repair attempt was made and reverted.** Keying the sample to settled pixels instead of
the `hudTimer.warn` flag **tripled the variance**: `after` swung −4.1..+7.8 and failures
went **1 → 6 of 20**. Reverted per "revert what you cannot explain". Do not re-try that
shape without a theory for why it destabilised the sample.

**For the next agent:** the threshold is `dr > 40` at `hud-timer.mjs:142`, one of four
round numbers added together in T14.01 with no measurement cited (`git log -S"needs +40"`).
It sits on the bottom tail of the real distribution, so it fails ~1 in 20 on an idle box.
Two open questions, in order: *why* is the `after` sample occasionally ~5 low, and only
then what the floor should be. **Do not lower it to a number that merely passes** — that
was explicitly rejected here.

### Standing hazards this task produced

- **I leaked a load generator for 3 h 47 m.** Spinners started inside `LP=$(startload)` — a
  command substitution subshell — reparent to `init` immediately, and the only cleanup was
  a `kill` in a parent that later died. It saturated the box while I asserted it was idle.
  `proc-group.mjs`'s own comment already records this costing three sessions.
  **Check the box before any wall-clock number:** `ps -eo pcpu,args --sort=-pcpu | head`.
- **`setsid` forks**, so `$!` is not the new group leader and `kill -TERM -$!` kills
  nothing; a `trap "kill 0"` ceiling also failed to reap. The design that works is
  `timeout --signal=KILL` **per spinner** — a ceiling that is a property of each process
  needs no parent, session or trap to survive. `scratchpad/loadgen.sh` + `spinner.sh`.
- **Two counting instruments gave opposite wrong answers**: `pgrep -f 'while :'` matched its
  own command line and reported phantom survivors; `comm`-based counting reported zero while
  12 spinners ran at 106 %, because a shebang script's `comm` is `bash`. Caught only by
  printing raw `ps`. A metric with no control is a number.
- **Unreconciled:** `hud-measure.sh` wrote its only line at 13:53:18 and its spinners date
  from 14:08:44 — about fifteen minutes unaccounted for. It does not threaten the alibi
  (every artifact at or before 13:53:18 predates the first spinner under either reading)
  but it is not explained, and it is recorded here rather than smoothed over.

## From T19.14 — what the diff does not say

- **The "join race" did not exist.** The reported `in battle (phase warmup, 0 players)` was
  a stale variable, not a missing join, and every run carrying it **passed**. Measured over
  10 `two-clients` runs: the stale value was 0 in 8, the fresh value was 2 in **10 of 10**,
  at server tick 81–90. Nobody had re-read `d`. The lesson is the task file's, not the
  code's: a symptom quoted from a log line is evidence about the log line until somebody
  checks. **Task defect recorded** — its Tests section also demands the wait be pinned to
  "the constant that governs it", and no constant governs a network round-trip plus a mask
  decode; pinning one would have fabricated a tunable.
- **`expectPlayers` defaults to 1 on purpose.** Every client appears in its own roster, so
  the default is a no-op for the **18** single-client callers — 24 sites, **six** opt-ins —
  and only
  `e2e-two-clients.mjs:64,65`, `full-round.mjs:89,90` and `m10-checkpoint.mjs:118,119` opt
  in to 2. Implementing the task's literal "wait for a roster that has the players in it"
  as *wait for two* would have hung the other eighteen — the `standStill` shape again.
- **`enterBattle`'s return value has no readers.** All 24 call sites discard it (`grep -rn
  "= await enterBattle"` → nothing), so the staleness only ever reached the log. If a
  future caller starts using the return, it is now fresh — that is new, and free.
- **The roster throw names the right cause.** It distinguishes `playerCount === 0` ("no
  snapshot has been applied at all") from a partial roster ("snapshots are arriving, so the
  missing players never joined"). The first draft said the former in both cases and was
  wrong on screen at tick 807 with 2 players — the same false-diagnosis-in-an-error-string
  defect the T19.04 follow-up fixed in `standStill`.
- **`acquireLock`'s wait loop is fully synchronous and cannot be interrupted.** `sleepSync`
  blocks the thread, so the `SIGINT`/`SIGTERM` handlers registered above it never run while
  waiting: `timeout 25 node scripts/wasm-build.mjs` on a held lock ignored SIGTERM and sat
  for the full `LOCK_TIMEOUT_MS` of **10 minutes**. Use `timeout -s KILL` to test it, and
  know that a developer pressing Ctrl-C on a waiting build will appear to be ignored.
  **Not fixed — booked.** It is pre-existing to this task and the fix is a redesign of the
  wait, not a patch.
- **The empty-lock window is now a wait, not a steal**, and it is bounded by the same
  10-minute deadline with its own error naming the cause, or a lock left empty forever by a
  build killed between `openSync(wx)` and `writeSync` would spin until the heat death of
  the repository. Falsified both ways: with the guard, 0 steals and no build starts; with
  only the guard removed, `wasm-build: cleared a stale lock left by pid 0`.
- **The vite half of T19.14 is untouched.** `vite did not report a port within 90 s under
  sustained browser load` was not reproduced and not investigated — the task's own Done-when
  is a serial loop, which is the idle-box case and cannot reproduce a load failure. Booked
  rather than silently dropped.

## T19.05 landed — what the diff does not say

The `IN PROGRESS` section that used to sit here is gone: everything it listed as unfinished
is done. What follows is the part that is not recoverable from the diff.

- **The placeholder design held, and the two *other* obtainability asserts did not.** The
  predecessor found `melee.rs:341`; there is a second, `balance.rs::every_weapon_can_be_obtained`,
  which the sweep did not predict because it predicted `weapons().len()` instead. Both now
  assert the unobtainable set as an **equality** — these six and no others — rather than
  filtering by a property, because "has no weights" is the bug the test exists to catch and
  a predicate excusing it excuses the next one too. `balance.rs` also builds a real world
  and asserts the join grants a shovel, so the "issued" exemption is not a free pass.
- **The shovel broke bot weapon choice, and the task file does not mention bots at all.**
  `choose_weapon` penalises a weapon that "cannot reach the target" using `w.range`, which
  is **0.0 for melee** — the reach lives in `Delivery::Melee`. A 30/0.55 = 54 dps shovel
  therefore outscored every gun in the arsenal from any distance, and `should_fire`'s
  `blast_radius` self-blast guard refused every swing inside 21 px while allowing one at
  300. Both were already wrong for the axe and hammer; §F5 made it universal by issuing one
  to everybody. `has_firable_weapon` also had to stop counting melee, or **no bot ever goes
  shopping for a gun again** — "arm yourself first" is satisfied forever by the starting kit.
- **Three bot fixtures were passing while measuring a swing.** `give` appends to the first
  *free* slot, so slot 0 is the shovel and `give(BAZOOKA)` + `w.fire()` swings. It is silent:
  a swing sets the same FIRE bit. `a_bot_does_throw_a_molotov_from_a_safe_distance` reported
  a throw it never made. `world::wield(w, id, item)` is the companion to `give` and panics
  rather than returning false. **Grep for `give(` before trusting any fixture that fires.**
- **`ordnance`'s mine approach chooses its escape direction from a sub-pixel sign.** The
  mine lands at the player's feet, so `dx` is ±0.5 px of noise: measured, 0.5 px left with
  the axe and 0.1 px right with the shovel, which flipped the escape from `d` to `a` — and
  `a` was into a rise it could not climb. Twelve bursts moved it six pixels and all four
  rockets were then fired from the muzzle, reported as "the stack is empty". **A control run
  with the axe grant restored passed**, which is what says this is the check and not the
  shovel. It now flips direction when the body does not move. Side effect: 74.9 s → 24.6 s.
- **`density_report`'s floors were re-derived, and this one deserves a reviewer.** They were
  absolute counts (12.5/14.5/16.0) against a 24-entry registry in which everything could be
  drawn. §F5 leaves 25 entries of which **six can never be drawn**, so the same absolute
  number demands a much larger share of a pool of 19: Medium measured **13.8 against 14.5**
  with nothing about the spawn machinery changed. They are now the same *fractions* of the
  drawable pool, written as `12.5 / 24.0 * pool` so the derivation is checkable. Measured
  after: Small 14.6, Medium 13.8, Large 15.4 of 19 (77/72/81 %) — against 15.2/15.2/16.8 of
  24 (63/63/70 %) recorded at the base commit. The *share* of what a round can show you went
  **up**; the absolute count fell because five items left the table. It is still ignored, so
  the gate never runs it.
- **`REPLAY_VERSION` is 3 and an old file is refused.** Commands carry `SelectSlot(u8)` and
  no item ids, so retirement looks safe — but zeroing five weights reshuffles every
  `place_initial`/`assign_buried_items` draw, and the header records nothing about the
  registry. `a_v2_header_written_by_hand_still_parses_field_for_field` was pinned to the
  literal 2 and is now `header_bytes(REPLAY_VERSION)`; the byte layout it guards is
  unchanged and every field after the version is still a literal. A new sibling asserts a
  v2 file is rejected, which the existing skew test could not — it only ever tried a version
  *newer* than the build.
- **Not done, deliberately.** `inventory.test.ts:93` still says `tileLabel({key:'axe'})`; it
  is a pure passthrough with no registry lookup, so it stays green and stale (the sweep says
  the same). **The five dead procedural painters must stay** —
  `weapon_knife:83`, `weapon_whip:105`, `weapon_axe:114`, `weapon_bat:117`,
  `weapon_hammer:125`. `itemSprites-math.test.ts`'s "the live registry has art for
  everything" reads the registry, where the five placeholders still resolve, so deleting
  their art fails on five entries. **Both the task file and the sweep were wrong here**:
  the task lists three, the sweep four and says `weapon_bat` does not exist. It does.
- **Death was dropping the shovel, and the deliverable says it cannot be.** `die` returns
  `inventory.drain_all()` and the world scatters those as pickups, so every death minted a
  shovel: the corpse's copy stayed on the ground *and* `respawn` granted a fresh one. The
  200-seed sweep could never have caught it — that asks about the spawn **tables**. The
  exemption is `player::state::STARTING_KIT`, one list read by both `grant_starting_kit`
  and `die`, because "you always have one" and "it cannot be dropped" are one rule.
- **The Done-when is three test binaries short of the blast radius.** It runs
  `--lib shovel` and `--test balance`; the shovel in slot 0 also broke
  `game-core --test combat` (4), `game-core --test world_step` (4) and
  `game-server --lib`/`--test inventory` (5). All the same shape — a fixture that gives a
  weapon and then fires. **`cargo test --workspace` before the gate**, or you find them
  one stage at a time, twenty minutes apart.
- **`try_fire` on an emptied stack now returns the shovel, not `EmptySlot`.** When a stack
  empties the selection moves to the next occupied slot, which is always the kit. That is
  §F5's "floor of the arsenal" made literal and it is asserted in
  `combat::firing_respects_the_cooldown_and_the_ammo_count`, with a control that selects a
  genuinely empty slot so `EmptySlot` is still known to be reachable.
### Two findings from T19.05, booked as **T19.17** and **T19.18**

The crate that could not be picked up on seed 555, and the client that never learns its
inventory. Both are measured, neither is explained, and each has a task file carrying the
numbers and the repro. The short form:

**T19.18 — the lobby client never learns its inventory.** `GameScene.slots` is filled
*only* by the server's `inventory` event (`GameScene.ts:486`), and for a client that
reaches a match through the **menu into a private lobby** it never arrives.
`harness.mjs::selectWeapon` reads exactly that array, so no menu-entered check can select
by name; `m10-checkpoint` presses `Digit2` and says so at the call site.

**Settled, and not intermittent.** Three measurements, the last a probe on both clients in
one run: `selectWeapon`'s own 2 s poll saw `(nothing)`; a 30 s `waitForFunction` timed out;
and the probe printed `host slots = (nothing)` **and** `guest slots = (nothing)` after
30.2 s, in a live match with `DEV_LOADOUT=1`. It is both clients, not just the host, and
the **server** plainly has the loadout — the same check fires and the terrain changes
(`m10-checkpoint.mjs:203`).

**A reporting error to own.** `51c91f6`'s message said the gate was "red on `crates` and on
nothing else". That was an *inference* from the previous gate plus the fixes made since, not
a measured full-gate result; the next gate showed `m10-checkpoint` red as well. It should
have read "red on `crates` in the last measured gate, the rest predicted fixed and
unverified". The gate that finally passed enumerates its last two stages:
**net smoke 25/25 joined, assets ok**, `all checks passed`, EXIT=0.

### `crates` — re-seeded, and what was measured getting there

**Fixed by re-seeding, which is the procedure the check documents for itself.**
`tick_crates` draws the crate's x and its contents from the `"items"` sub-stream
(`spawning.rs:289,295`), and `roll_item` is `pick_weighted(rng, weights(col))` — which calls
`gen_range(0..total)` against the **sum of the column**. §F5 zeroed five weapons, the sum
changed, the number of words each draw consumes changed, and every later draw moved. That
is the reshuffle §F5 asks for, not a break.

Probed on an idle box, one seed at a time: **7** lane blocked at (767, 702), closest 239 px;
**555** reachable, closest approach **0 px**, and never picked up; **99** lane blocked at
(1276, 784) and its crate is never framed in flight; **4242** lane blocked at (1251, 504);
**31337** takes the crate. So `CRATE_SEED` is 31337 (was 4242 → 555 → 7).

**The 555 result is not understood, and it is written down rather than smoothed over.** At
0 px for the full 70 s: crate `{id:11, item:0, source:"Crate", grounded:true}` — item 0 is
`MEDKIT` — with the player at `heals=0 batteries=0` (so `bump` cannot refuse), one shovel and
one molotov in 24 slots (so `Inventory::add` cannot return `Full`), alive at 100 health, and
ground pickups working in the same run. By `items/world.rs:341-381` that pickup should have
happened. **Do not re-seed onto 555 without reading this.** A repair that emptied the
counters with `Q`/`R` while close was tried and **reverted** — it changed nothing, and
CLAUDE.md says revert what you cannot explain. Where to start: nothing in `debug()` exposes
the *server's* copy of the local player, so a check whose whole claim is a distance can only
see one end of it.

- **`SPAWN_IFRAMES` catches melee fixtures.** `add_player` stamps them on every joiner, so a
  swing at `now = 1.0` lands, is logged and deals **zero** — which reads exactly like a
  reach failure. `t1905_shovel::swing_damage` fires at `SPAWN_IFRAMES + 1.0` and says so.


## T19.06 landed — what the diff does not say

**The task file's "share the blast helper" instruction is wrong, and following it would
have been a bug.** §F6's splash is a *poison radius*; `explode`/the blast helper carve
terrain, so sharing it would give every one of 54 drops a 28 px crater and dissolve the map
inside one shower. `World::splash_poison` (immediately above `detonate`) is a plain
distance test that then calls the *shared* `effects::toxic::poison_lands` — the roof rule
is shared, the carving is not. If a later task repeats the instruction, refuse it the same
way.

**The roof rule moved from the drop to the victim, and that is the whole point of the
radius.** §E13 could ask at the landing point because landing point == victim. With
`TOXIC_SPLASH_R` they separate: a drop can land in open sky one pixel outside a cave mouth
and reach a player who is under solid rock. `splash_poison` asks `poison_lands(&self.map,
p.body.pos)` per caught player. The falsifier is
`the_roof_rule_asks_about_the_victim_and_not_about_the_drop` (a slab over the left half,
the drop landing just outside it); swapping the argument back to `at` fails 2 tests.
`TOXIC_SPLASH_R = 0.0` fails 4. Both were falsified at the live binding site.

**54 drops, not 53 — and `ceil`, not truncation.** `TOXIC_DURATION / TOXIC_DROP_EVERY` is
53.33; the scheduler emits 54 (it fires at t=0). `docs/75` says "≈53" and that
approximation is fine, but three call sites had each written the division out and two would
have been off by one. `effects::toxic::drops_per_window()` is now the single source; the
e2e (`m5-weather.mjs`) computes it from `constants_json` rather than the old `(8 / 0.4)`
literal pair.

**The fixture roof had to be thickened, and that is real behaviour, not a test fudge.** The
cave fixture used a 12 px slab. At 54 drops a shower, `TOXIC_DROP_CARVE_R` (6 px) bites dig
straight through it inside one window and the "sheltered" control player lost 30.7 health
to rain arriving through the hole above them. `ROOF_THICKNESS = 40` is named in the fixture
with that measurement written beside it. **A thin roof is no longer cover in the real game
either** — if anyone reports "I sheltered and still got poisoned", this is why, and it is
§F6 working as specified, not a bug.

**Load was measured, and the finding is an absence.** Peak **7** drops airborne (the
scheduler's own ceiling is 10), **140 `ProjectileMove`/s** at `SNAPSHOT_HZ`. Neither is a
concern. But **there is no `MAX_PROJECTILES` anywhere in the workspace** — the task said to
"check the projectile cap"; there is none to check. Toxic rain is bounded only by its own
cadence, and nothing bounds the sum of rain + every player firing. Not booked as a task; it
is a latent ceiling, not a present bug.

**On the pixel acceptance.** §F6 asks for "the health bar is green during the shower and
not green before". It is proved as two measured links rather than one photographed shower:
**shower → poison** in `game-core` against the real scheduler with a sheltered control in
the same run (`a_shower_hurts_the_player_in_the_open_and_never_the_one_under_rock`), and
**poison → green pixels** in `hud-bars.mjs` against a clean frame from an unpoisoned stack.
Photographing a real shower would put a 1-in-15 draw inside the gate (2.67 expected hits is
a Poisson tail, not a certainty) to join two things already proved. The reasoning is
written into `hud-bars.mjs` beside the check so the next reader does not "fix" it.

**A leaked `game-server` was found before this gate**, PGID 557788, ~3 h old, surviving
from an earlier run. It did not fail anything, but check `pgrep -af "vite|game-server"`
before any wall-clock measurement and kill the **group**, not the pid.

## T19.07 landed — what the diff does not say

**Wire keys, for anyone writing the panel (T19.08):** socket events `set_bots`
`{bots: bool}`, `set_start_kit` `{start_kit: "none"|"basic"|"all"}`,
`set_round_seconds` `{round_seconds: number}`; `lobby_state` gains `bots`,
`start_kit`, `round_seconds`, **always present, never omitted** (they have no "absent"
meaning and `parseLobbyState` reads a missing key as a default). Refusals come back on
`lobby_error`, not `join_error` — `set_scale`'s reason: `join_error` is guarded by
`if (settled) return` at the client and a refusal sent after seating is dropped before
anything sees it. `ROUND_SECONDS_MIN`/`_MAX`/`_STEP` now exist in all four places
(`constants.rs`, `constants_json`, the TS `Constants` interface, and a test at the
emitting end).

**The sweep's "CONFIRMED contradiction" in the task file is not one.** The table says
`round_seconds` defaults to `MIN` and the Notes say the env var stays the default;
`docs/75` §F7's own last paragraph settles it — *"the env var stays and becomes the
default for rooms that never set one"*. Implemented that way: the setting writes
`config.round_seconds` exactly as `SetScale` writes `config.map_scale`, so a room that
is never touched reports what the environment gave it. **The seven checks that shorten
a round through `ROUND_SECONDS` are therefore untouched** — verified by the gate, not
by reading. The two numbers agree only because `ROUND_SECONDS == ROUND_SECONDS_MIN` in
the shipped configuration; a deployment that moves one does not move the other, and a
private lobby under `ROUND_SECONDS=20` will honestly report 20 (below `MIN`) until
someone sets it.

**Task gap confirmed, and it was the real bug: there was no respawn call site.**
`grant_dev_loadout` is called from `populate_world`, `seat_bots` and the late-join
path, and nowhere else. `PlayerState::die` drops everything except the issued shovel
(§F5), so a kit granted only at match start silently means *"for your first life"*.
`grant_start_kit` is now called from those three **and** from the `GameEvent::Respawn`
branch of the room's event scan, which until now only logged. Falsified: deleting the
respawn call fails `each_kit_arms_a_player_at_spawn_and_again_after_a_respawn` with
`got [(24, 1)]` — the shovel alone.

**`tick_inline` does not return `Death` or `Respawn`.** The room drains the world's
events into its broadcast path and hands back only what it re-emits — over 900 ticks a
test watching for `Respawn` saw 14 events, all `RoundState`, while the player it was
waiting for had died and come back. Any future test that waits on a world event through
`tick_inline` will wait forever. Watch the state instead: dead-then-alive-at
`BASE_HEALTH` is also the control the assertion needs.

**Two more traps met while writing that test, both worth knowing.** `p.health = 0.0` is
not a death — nothing calls `die`, no inventory is dropped, and the player stays
`alive` on negative health; kill through a blast (`explode_for_test`) so `resolve_deaths`
runs. And `World::set_phase(Playing)` lasts exactly **one tick**: the round controller
rewrites the phase from `round_time` every tick, which is long enough for a blast to
land and not long enough for the death to resolve. Wait for `room.phase()` to reach
`Playing` on its own, bounded by `WARMUP_SECONDS`.

**`cargo test -p game-wasm` runs zero `#[wasm_bindgen_test]`s**, which `lib.rs:1212`
already records — so `constants_json_carries_the_viewport_and_camera_values` has never
run in the gate, and neither would a new one written beside it. The §F7 bounds test is
a plain `#[test]`. **Fourteen** `wasm_bindgen_test`s in that file are in the same position — the count
the gate log's `3 passed` implies and the one T19.19 is booked for;
not booked, but they are not evidence of anything today.

**`registry::is_retired` is now shared, and the shovel is why it has to be a function.**
Zero weights in all three columns names **six** weapons and only five are retired — the
shovel has the same three zeros because it is issued at spawn (§F5). Anything handing
out "every weapon" has to skip the placeholders and keep the shovel. `balance.rs` pins
the predicate to the named five as an equality plus an explicit "the shovel is not
retired".

**`DEV_LOADOUT`'s contents did not change.** Its `give` calls became a `(item, count)`
list handed to the same `give_all` the kits use — one granting path — and the gate's
five sandbox/ordnance checks confirm the list is the same one.

## T19.07 follow-up — the restart divergence, and where a lobby setting must live

**`bots` and `start_kit` began as `Room` fields and that lost them across a restart.**
`restart()` calls `finish_recording()` then `start_recording()` — one file per round,
deliberately, so a single file never carries two seeds and two maps. Round two's header
is therefore rebuilt from `Config`, and its command stream begins at the restart: the
host's `SetBots`/`SetStartKit` are in **round one's** file and nothing re-sends them. A
room replayed from round two came up at the defaults — bots on, kit none — seating bots
the live round never had and arming players differently on tick one.

**The rule this establishes: a lobby setting that changes the simulation goes on
`Config`, not on `Room`.** `Config` is what `ReplayHeader::from_config` reads, and the
header is the only carrier that survives a restart. `SetScale` and `SetRoundSeconds`
already followed it; the two new ones now do. Reversibility is kept the way it was
argued for — `bots_enabled` is its own flag rather than `bot_count` driven to zero, so
"on" restores the count the room was made with.

**Which carrier is authoritative depends on the round, and both are needed.** Round one:
the command wins, because the header was written at construction before a host could
touch anything. Round two onward: the header wins, because the command is in the previous
file. The comment in `room.rs` said "the header is not authoritative for any of them",
which was true for round one and wrong for every round after it.

**`REPLAY_VERSION` is now 4** and `HEADER_BYTES` 45. The two fields are appended after
`dev_loadout` — nothing already in the header moved, which is the failure `write_header`'s
own note records having happened once. A v3 file is two bytes short and is refused;
`a_replay_from_the_previous_version_is_refused_rather_than_replayed` covers that.

**A trap for anyone writing a restart test: `restart()` opens round two's file in
`config.replay_dir`, not in the directory `start_recording` was handed.** A test that
passes a scratch path to `start_recording` alone writes round two into the repository's
`replays/` and then reports "the round never restarted". Set `replay_dir` too.

**Still open, and larger than this fix: round two's file carries no roster.** The `Join`
commands are in round one's file, so replaying a second file alone reproduces a room with
no players. `a_restart_carries_the_private_settings_into_the_second_file` therefore
asserts on the header and on the *effect* (a room rebuilt from it seats no bots, with the
default put back as the control) rather than on a state hash. A full round-two state-hash
replay is not possible today. Not booked — it is a property of the one-file-per-round
design, not a defect in it — but anyone who assumes a restart file is independently
replayable is wrong.

**Stray replay binaries, and the real cause.** Two 45-byte `.replay` files were sitting
untracked in `crates/game-server/replays/`. `.gitignore` had `/replays/` — **anchored**,
so it only ever matched `claude/replays/` — while `config.rs` defaults `replay_dir` to the
relative `"replays"`, which under `cargo test -p game-server` resolves against the crate
root. The ignore is now `replays/` as a belt, but the cause was the `restart` path above:
`Room::replay_dir` remembers the directory `start_recording` was handed and `restart` uses
it. `a_restart_carries_the_private_settings_into_the_second_file` deliberately leaves
`config.replay_dir` at its default so that it is the fix being exercised — putting the old
line back reproduces both symptoms at once: *"the round never restarted"* and a fresh
binary in the repository.

**Correction to a review finding, checked rather than argued.** `bots: p['bots'] !== false`
was called weaker than the type check used for the other two fields. It is not: `!== false`
can only reject `false` itself, so `"false"`, `0`, `null` and `{}` read as `true` under
**both** forms — verified across twelve inputs, zero differ. The typed form is in anyway,
because it is the one that survives the server default becoming `false`; but no test can
separate them, and the new junk assertions say so in the comment rather than pretending to
discriminate. Anything claiming this was a live parsing bug is wrong.

**`the_payload_carries_the_three_private_settings` was renamed and given a real claim.**
Its guest seat was decorative — every assertion passed with the seat deleted, because
`broadcast_lobby_state` sends *one* payload to every socket and a room-level read cannot
prove per-seat delivery. It is now
`the_payload_carries_the_three_private_settings_once_for_the_whole_room` and asserts what
is provable and worth guarding: `settings_owner` names the host and not the guest, both
seats are in the payload, and **no seat entry carries a settings key**. That last one is
the regression T19.08 could introduce — move a setting under a player entry and a guest
sees nothing while the old assertions stayed green.

**A gate red that was mine and was not the code: `checksum` under load.** The follow-up's
first gate failed with `two_clients_agree_on_the_mask_after_a_hundred_carves` — *"expected
the fires to produce carves; got 14"* — and `a_joiner_that_delays_ready_still_gets_every_carve`
at *"got 5"*. **Measured before changing anything**: a worktree at the committed `f474f2d`
and the working tree were run alternately, three times each, whole binary, on an idle box —
**6/6 green, both trees**, plus 3/3 for the failing test alone. The counts in the red run
swung 5 → 14 → 44, which no code defect in a carve path produces.

The load was **self-inflicted**, and the lesson is CLAUDE.md's own: the previous gate had
been stopped mid-run, and the post-kill sweep grepped `vite|game-server|check.sh|node
scripts` — **a pattern that cannot match `cargo` or `rustc`**, which is what a killed
`check.sh` leaves behind. Sweep for `cargo|rustc|node|vite|game-server` before any gate,
and check `uptime`'s 15-minute load, not just the process list: it read 2.96 while the
process table looked clean.

`checksum` is not on the known-flaky list with `bullets-visible`, `hud-timer` and
`night-combat`, and this run is not evidence that it should be — it was measured green
sixteen times on an idle box across two trees.

## T19.08 landed — what the diff does not say

**The panel is one pure function, and that is where the host gate lives.**
`settingsControls(lobby, mySeat, bounds)` returns four rows — map size included, so all
four share one gate and one disabled rule — and `stepSetting(lobby, mySeat, id, delta,
bounds)` returns the next value or `undefined`. `settingsControls` disables *exactly* what
`stepSetting` refuses, by calling it: a screen and a wire that computed "allowed"
separately are two answers to one question, and the older map-size row had its own copy.
`MenuScene` renders rows and sends messages; it decides nothing.

**Two stepping behaviours, on purpose, and the code says so.** `scale`, `bots` and `kit`
**wrap** through `stepIndex`; the timer **clamps**, because §F7 says it "ends disabled at
each bound" and wrapping ten minutes back to four is a different rule. Anyone tidying that
inconsistency away will break the bound test. `bots` has two values, so a wrap in either
direction is a toggle — still `stepIndex`, so "next" has one definition.

**Task defect, as the sweep predicted: `canChangeSettings` does not exist.** The Tests
section names it; the function is `ownsSettings` (`lobby.ts`). Nothing was renamed — the
gate moved into `stepSetting` instead, and the unit test that the task asked for is
`gates all four settings on the host, not just the map size`.

**`MenuScene` no longer declares its own `SCALES`.** It had a second copy of the list that
`net/lobby` exports, beside a comment explaining that a second copy would be a second
answer. `net/lobby` now imports `stepIndex` from `ui/menu`; that is not a runtime cycle,
because `menu.ts` imports `Scale` from `lobby.ts` as a **type**, which is erased.

**`__menu.settings()` reads the DOM, never `debug()`.** `debug()` returns the local
`MenuModel`, which has never held any of these and for a guest holds nothing at all — a
check reading settings from it would be meaningless on exactly the half that matters. An
empty object means no panel, which is what a public lobby must render, and the check
asserts the roster is non-empty in the same breath so the absence is not vacuous.

**Ordering trap in `lobby.mjs`: the public-lobby client must come last.** A quick-matching
third client opens a *second* room, and the check's `health.rooms !== 1` assertion is its
guard against the socket being reopened rather than handed over. Putting the public-panel
block before it turned that assertion red for a reason that had nothing to do with the
handover — a false positive on the check's single most valuable claim.

**A DOM read straight after a press reads the frame before the answer arrives.** Nothing
is applied locally: `step` sends, the room replies with `lobby_state`, and the panel
redraws from that. The first version of the bound walk fired **nine** presses to take one
step, and its "it did not move" read could have landed before the last one did. It now
waits on the value changing, and the after-the-bound read has a settle. Same shape as any
"assert an absence over a network" — the wait has to be long enough for the thing you say
did not happen.

**Both e2e claims were falsified at the live binding site.** Applying the kit locally
instead of sending it: *"the host changed kit and the screen still reads None"* — the
local write is overwritten by the next `lobby_state`, which is itself the proof that the
screen follows the room. Rendering the panel for a public lobby: the §F7 absence fails
with the whole panel printed.

**Done-when scope, minor:** `--run lobby menu` also matches `escapeMenu.test.ts`, and
`node scripts/e2e.mjs lobby` also runs `lobby-start`. Both widen rather than narrow, so
neither hides a failure.

**`m10-checkpoint` has now been red twice in M19, both times inside a full gate, both
times green on an immediate standalone re-run.** First during T19.05 (recorded above);
again on T19.08's gate, failing at *"the two clients in one room disagree"* with two mask
hashes — the two-client carve-agreement assertion, before it ever printed `host carved N
px`. The standalone re-run carved 19246 px and agreed.

**It is deliberately NOT being added to the known-flaky list** with `bullets-visible`,
`hud-timer` and `night-combat`. Two sightings months apart is not a measurement, and that
list is an excuse for a red — putting a carve-agreement check on it would excuse exactly
the class of bug the check exists to catch. What is recorded here instead is the data: two
reds, both under a loaded box, both unreproducible alone. If a third appears, that is the
point to measure it properly — alternate a worktree at the previous commit against the
working tree, N runs each, the way the `checksum` scare above was settled — rather than to
assume either answer.

## The suite-context hypothesis — now three checks, and its main support has been withdrawn

**Named because it may be the real finding behind T19.15 and T19.16, and nobody has
written it down.** Four checks now share exactly one signature: **red inside the full
suite, green standalone.**

- `bullets-visible`, `hud-timer`, `night-combat` — the three carried as "known flaky".
- `m10-checkpoint` — twice in M19, both times inside a full gate, both times green on an
  immediate standalone re-run (see the section above).

**CORRECTION, written by the coordinator after `f0da51c` landed. Read this before using
the section below.** As first written, this hypothesis rested on one load-bearing claim:
that the "load flake" frame was **already falsified** for `hud-timer`, because its failing
sample reproduced on a completely idle box. **T19.15 has since explained that result away,
and it takes the falsification with it.**

`hud-timer` reproduced on an idle box because its metric was a **mean over a moving
rectangle against a moving background** — `#hud-timer` is right-anchored, so the control
frame's "1:29" is 111 px and the warn frame's "0:59" is 121 px, and the extra ten pixels of
sky is worth about 5.4 points of mean redness against a sky that itself drifts −14.7 to
−16.9 over the 30 s between frames. Two confounds, **neither of them load and neither of
them suite context**. `hud-timer` was never a flake of any kind; it was a broken
instrument, and it now reads 27.23 % inside the full suite and standalone alike.

**SECOND CORRECTION, same author, after `5ff8969`. The family widened out of the browser,
and that is decisive.** Three **Rust socket tests** now show the same signature — red in a
workspace run, green 3/3 standalone on the same tree and at `51f6aec`: `checksum.rs`'s two
(*"got 13"* and *"got 5"* against floors of 50 and 6) and `bots.rs::bots_actually_move`
(*"no bot moved in two seconds: [1440.0, 112.0] -> [1440.0, 112.0]"*). None was accommodated
— no `#[ignore]`, no `serial`, no list entry.

**This rules out every browser-specific candidate as the *common* cause.** A Rust socket
test shares none of the browser suite's context: no Chromium profile carried between
checks, no vite instance, no port reuse, no page memory. So the list of candidate variables
below — accumulated profile state, port reuse, an older vite, `pkg/` artefacts — cannot
explain a family that includes `checksum.rs`.

**What the two groups do share is a shape, not a context:** a wall-clock window of a couple
of seconds in which a real server, a real socket and a real client must complete something,
while the machine is doing other work. That is narrower and far more testable than "suite
context", and it points at scheduling pressure on real sockets rather than at anything
about suites. **Rename the hypothesis accordingly when someone takes it**: it is not that
the suite poisons its checks, it is that a short wall-clock window over a real socket is
the thing that fails under concurrency, wherever it appears.

**So the family is three, not four** — `bullets-visible`, `night-combat`, `m10-checkpoint`
— and **nothing currently falsifies the load frame for any of them.** Do not read the
paragraph below as standing evidence against load; it is not. Equally, do not swing back to
"it is load", which is just as unmeasured. The honest position is that the common cause of
the remaining three is **unknown**, the candidate variables below are still unexcluded, and
the experiment below is still the one that would settle it. The old text is kept as
written, immediately below, because it is what T19.15's numbers were read to mean at the
time and the reasoning is worth seeing next to its own retraction.

**Superseded text, retained:** *"The standing frame is 'load flake'. That frame is already
falsified for one of them.* T19.15's own 20-round interleaved distribution on `hud-timer`
measured **idle mean 44.15 against loaded 44.87**, with the two near-failures landing **one
in each arm**, and the failing sample was an anomalous `after` capture that **reproduced on
a completely idle box**. *Load was not the variable there."* — That distribution was real;
what was wrong was reading it as evidence about load rather than about the instrument.

**What a check gets inside the full suite that it does not get alone** — the candidate
variables, none yet excluded: accumulated browser and profile state across checks; port
reuse; a vite or server instance older than the check that is using it; `target/` or
`pkg/` artefacts left by a neighbouring stage; ordering effects; and file-descriptor or
memory pressure, which is not CPU and which `uptime` does not show.

**The measurement that would settle it**, and it is one experiment: run **one** of the
four *inside a full suite on an otherwise idle box*, and again *inside a full suite under
deliberate load*. If both are red, **load is exonerated and the variable is the suite
context itself** — and every fix aimed at load is aimed at a symptom. If only the loaded
arm is red, the frame survives for that check and the `hud-timer` result stays an
exception needing its own explanation.

**Consequence for T19.16, stated and not acted on.** That task is written about vite's
90 s port timeout *under load*. If load is not the variable, T19.16 is scoped to the wrong
half of the problem. **It has not been rewritten and no task has been booked on this** —
the coordinator writes amendments, not a builder. This is the hypothesis, the evidence for
and against, and the experiment; the scoping decision is not mine to make.

## T19.09 landed — what the diff does not say

**The sweep's suspected hazard did not appear, and that is a measured absence, not luck.**
A shorter charge makes an *accidental* teleport likelier for any check that stands a body
still on a pad, and only the full gate can see it. The gate ran green — 41/41 e2e — with
`teleport`, `hud-bars` and `terrain-render` all inside it. If a future change moves
`TELEPORT_CHARGE` again, this is the reason a crate-scoped Done-when is not enough.

**`teleport.mjs:211`'s absence window shrank with the constant, and it was left that way.**
It sleeps `TELEPORT_CHARGE * 2500` and then asserts no teleport happened, so the window
fell from 5.0 s to 3.75 s. It is *correctly* pinned — 2.5 charges is the claim, and 2.5
charges is what it waits — but the same code proves less than it did. Raising the
multiplier to keep the wall-clock window at 5 s would be inventing a number nobody chose,
which is why it was not done. Recorded so nobody reads the shorter wait as a regression.

**The new fixture is counted in ticks on purpose.** `the_charge_lasts_exactly_teleport_charge`
is the only one that pins the *duration* — every other fixture holds for a multiple of the
constant and asks only whether the pad fired, which any charge from one tick to three
seconds satisfies. A first draft compared two accumulated `f32` seconds and failed at
exactly the boundary: `TELEPORT_CHARGE / SIM_DT` is 89.99999 in `f32`, so `floor` gives 89
where arithmetic says 90, and `step`'s own `t + dt` sum lands a hair under 1.5 on the tick
that is due. Ticks with one tick of slack on the far side only. Falsified at the live
binding site (`elapsed >= TELEPORT_CHARGE * 0.5`): red, "fired on tick 46 of 90".

**Four stale "two seconds" comments were repointed** (`constants.rs`, `teleport.rs` ×2,
`pads.ts`, `teleport.mjs`). None changed behaviour; they are listed because a prose sweep
is the kind of thing a reviewer wonders whether was deliberate.

## T19.10 landed — what the diff does not say

**The veil is a suite-wide hazard and it has already bitten once, measured.** §F9's
`FOG_SCREEN_ALPHA` is 0.8, so a full-strength fog multiplies **every** colour difference
in a game frame by 0.2. `crates` runs a 140 s round — two or three effects at
`EFFECT_INTERVAL_MIN` 30 s, one kind in four being fog — and its canopy assertion measured
**66 with no fog and 11-14 under one, three standalone runs out of three**. It is not
intermittent and it was not a load flake; the parachute was still drawn and was 80 % less
visible, which is fog working. **Any future pixel check that runs a round longer than
~35 s is exposed to this.** `teleport` (300 s), `ordnance` and `quick-throw` (180 s) all
passed, but they are one seed away.

**The fix is `WEATHER`, a new `Config` switch in the `DEV_POISONED` family** —
`auto|off|fog|toxic|meteor|lava`, refused rather than defaulted on a typo. `crates` sets
`off` for the same reason it already sets `BOT_COUNT=0`: its subject is a canopy, and it
excludes anything else that can move the pixels it measures. `WeatherMode` lives on
`World`; `Off` skips `EffectScheduler::tick` outright, `Always(kind)` calls the new
`postpone_until` every tick so the scheduler cannot roll one of its own on top.

**`Always` must emit `GameEvent::EffectStart` itself.** `EffectScheduler::force` emits no
`Started` event by design — the sandbox installs effects locally and needs none — but a
networked client learns fog exists from `effect_start` **alone**. Forcing without the event
is a foggy world and a clear screen, which is the divergence §F9 exists to end.
`a_forced_effect_is_announced_and_not_merely_installed` is the guard.

**`WeatherMode` is deliberately not in the replay header**, following `dev_poisoned` and
`dev_start_health`, which are equally simulation-changing and equally absent. A round
recorded under a dev switch is already not reproducible; a version bump per debug flag is
not the rule this codebase set.

**The evidence that `fog-visible` had to exist, and it is the strongest §C0 demonstration
in the tree.** With `GameScene`'s `fog:` argument forced to 0 — the game drawing no fog at
all — **`weather-visible` passed, 1/1**. The sandbox owns a `HeavyFog` and reads its
strength locally; the game has no weather and walks the ramp from an event. Two render
paths, and the sandbox one cannot see the other's bug.

**`fog-visible` costs 139 s and two servers, and the second one is load-bearing.** The
day/night cycle moves fast around dawn: the sky at `roundTime` 2.5 is (109,116,141) and at
15.0 it is (119,167,213). A one-server version taking its control frame from the warmup —
the only fog-free window `WEATHER=fog` leaves — measured a composite error of **16.8**
against a 16 tolerance. The two arms now align on `roundTime` (12.6 vs 13.0), and the error
is **0.6/3.5**. Do not "simplify" it back to one server without re-reading this.

**The acceptance is a composite, not a delta, in both checks.** `assertChanged` passes for
any full-screen cast — the toxic rain's green vignette would pass it. What is asserted is
that each patch lands where an alpha composite of `FOG_SCREEN_COLOUR` at
`FOG_SCREEN_ALPHA × strength` puts it, and separately that the *predicted* move is large
against the run's own measured noise floor. `FOG_SCREEN_ALPHA = 0` fails the second by the
whole distance; commenting out the two `fillRect` lines fails the first at 49.4.

**`weather-visible` freezes the day clock and hands it back.** `setTime` now takes `null`
to resume, shaped like `setParallaxClock`. Freezing was needed because the control and the
foggy frame are ~10 s apart; **not** returning it dropped the toxic cast's own delta from
63 to 23 against a threshold of 16, which is a borrower weakening its neighbour.

**The sandbox HUD control is a bound, not an equality, and the number is derived.** The
strip is `rgba(12,16,22,.82)`, so 18 % of the canvas bleeds through it: a first draft
asserted "unchanged" and failed at 9.5, which is exactly that bleed. It now reads the
opacity off the live element and asserts the patch moved less than `(1-opacity) × world`.
`fog-visible` makes **no** HUD claim — `DEPTH.hud` has one in-canvas occupant in either
scene (the crosshair), so the game's HUD is DOM too and a patch there would restate the
sandbox's claim more weakly. A first draft sampled the bars strip and read 14.9 against a
world that moved 48.2: the strip is 31 % world by area, not a leak.

**Two gate reds that were the box, both measured before being dismissed.**
`game-server --test lobby::leaving_frees_the_seat_and_the_socket_can_join_again` panicked
with `IncompleteResponseFromEngineIo(SendAfterClosing)` — a `rust_socketio` transport race;
alternated against a worktree at `4d58d20`, **8/8 green in both trees** for the whole
binary, and no causal path from a fog diff. And `perf`'s `chunk rebake 4.50 ms exceeds 4`,
which read **2.90 ms** on the next gate. Neither is on any flaky list and neither should be.

## T19.11 landed — what the diff does not say

**Nothing emits a flame, and that is the deliverable.** §F10.2 is T19.12. The
production-caller grep for `weapons::flame` is deferred there and said so in the module
header, so a reader meeting a mechanism with no caller does not conclude it was forgotten.

**Two real defects the task file does not mention, both found by a failing test.**

1. **A flame died on contact with a body.** `Projectiles::step`'s player-AABB loop runs for
   every delivery kind, so the first person a flame touched extinguished it — §F10.1 says
   its only end is `FLAME_LIFE`. The guard is now `ends_only_on_its_timer`, keyed on
   `Burst::BurnsOut` rather than on the weapon id, so the property belongs to "its end is its
   own timer" rather than to one row of the table. Terrain is unaffected: a flame bounces
   there through `explode_on_contact: false`.
2. **The shared overlap test ignores `h`.** `BurnField::tick` asks
   `(pos - patch.pos).len() <= radius + target.w * 0.5` — a circle around the body's
   *centre*, using its half-**width**. That works for it only because `LAVA_BURN_RADIUS` is
   28 and a player's half-height is 14; the extra reach hides the missing term. A flame is
   10 px, a body is 16x28, and a flame **resting at your feet** sits 22 px from your centre
   — 4 px outside its own radius. Fire on the ground would have burned nobody standing in
   it, and every table test would have stayed green. `flame::touching` is circle-vs-box.
   **`BurnField` still has the old formula**; it is not wrong for a 28 px patch, but if a
   small toxic zone is ever added it will be.

**Design decisions worth not re-litigating.**

- **The scorch is derived, not stored.** `interval(now) > interval(now - dt)` against
  `spawned_at`, so there is no `last_scorched_at` field for every other projectile to carry
  and never read. Falsified by scorching every tick: 121 bites in 2 s against 4.
- **`tick` reports every crossing of the timer, empty carve included**, and `World` is
  where "there was rock left" is decided. Filtering inside the module would make "the timer
  fired" and "the ground had pixels" one number — and a flame resting in the hole it has
  already eaten bites nothing, which is how the first draft measured 1 scorch where the
  timer had fired 4 times.
- **The cap runs in `World::step`, before the burn**, not at each emitter: three things
  will make flames and a fourth is the one that forgets. Oldest is lowest id — ids are
  monotonic, so id order *is* spawn order, and `spawned_at` would need a tie-break for the
  two dozen a molotov spawns on one tick. Falsified by dropping the newest instead.
- **`Burst::BurnsOut`'s "it does something" guard is a `const _: () = assert!(...)`**, not a
  line in `every_weapon_digs`. A flame's numbers are constants, so a runtime assertion on
  them is one the compiler folds — clippy rejects it as `assertions_on_constants`. The
  const version fails the build, which is strictly earlier.

**Three fixture traps met, all previously recorded and all met anyway.**
`set_phase(Playing)` lasts one tick **and leaves `round_time` at zero**, so the body is
still inside `SPAWN_IFRAMES` and refuses every point of damage — the first draft of the
warmup control reported that fire burns nobody in a live round. Wait the warmup out for
real. A flame lit at a body's *spawn* position is not lit at the body after ten seconds of
settling. And `FLAME_GRAVITY_SCALE` takes a flame out of its own radius in about a sixth of
a second, so a dps fixture that drops one beside a standing body measures a quarter of what
it should — put it on the floor.

**The bandwidth number T19.11 asks for: 160 flames → 3200 `ProjectileMove`/s, about
50 kB/s** at 16 bytes an entry (`world/mod.rs` emits one per live projectile every third
tick). Printed by `a_full_flame_field_costs_what_the_cap_says_it_does` so a future change to
`FLAME_MAX_LIVE` can be argued about with a figure. The cap looks right.

## T19.12 landed — what the diff does not say

**Task-file contradiction, resolved deliberately.** T19.12's Notes say *"the client will
break on the retired events — that is T19.13's half; leave it compiling, not working, and
say so"*, and its **Done-when runs `./scripts/check.sh`**. Those cannot both hold:
`ordnance.mjs` waited on `d.jets`, a count of `cone` events, and `Delivery::Cone` is gone.
Repaired here, because a red gate is not a deliverable — and because the counter left in
place would have gone *vacuous*, not red, which is worse. `GameEvent::Cone` itself **is**
left standing and unemitted, with a comment saying so, which is the "compiling, not
working" the note asks for; removing the variant, the client's `'cone'` subscription and
`ordnanceFx::addJet` is T19.13's.

**The balance numbers say §F10 was the fix T11.09 was looking for.** T11.09 measured the
flamethrower at 0.37 dmg/bot-s with 0.28 self, and the molotov at 0.46 against 1.68 self —
three times more harm to their user than to anyone else — and concluded the cause was that
a bot's guard reads a *blast radius* and knows nothing about a hazard that lingers. Now:
**flamethrower 1.33 / 0.00, molotov 1.48 / 0.00** (8 seeds, release, `--ignored`). The
zeroes are not a broken instrument — `a_burn_kill_credits_whoever_lit_it` proves flame
attribution, and the bots simply avoid fire now, because `hazard_at` was re-pointed at the
flame field. **That reader was the sweep's warning and it was right**: leave it reading
`world.burn.patches()` and bots stop avoiding fire entirely, with nothing red.

**The flamethrower's measured reach is a finding, and the numbers are here so nobody
re-measures.** Swept over aim angles from a standing body: **0 deg → 53 px, −15 → 52,
−30 → 93, −45 → 509**, against a retired `FLAMETHROWER_RANGE` of **150**. Point-blank it is
a *third* of what it was; lobbed it goes three times further than the cone ever could. That
is §F10's "reach is emergent" working as specified, and it is a real change of character —
worth the coordinator's eye, not a bug to fix in a builder's task. §F10.2's own suggested
bound (`FLAME_MUZZLE_SPEED × FLAME_LIFE` = 1600) is **vacuous** — it holds with the weapon
deleted — so the test asserts a band.

**Two shared bugs, both now fixed once rather than twice.**

1. **A derived periodic timer double-fires on `f32` drift.** `now - dt` is the previous
   tick's `now` only up to rounding, so a boundary landing inside that error is reported on
   two consecutive ticks: measured, a vent at `LAVA_FLAMES_PER_SECOND` 6 emitted **22**
   times in a three-second window instead of 18. `math::fired_this_tick` snaps both ends to
   whole ticks and nudges the index; `flame`'s scorch and the vent's smoulder both use it.
   The flame scorch had the same latent bug and nothing had caught it.
2. **The molotov's bot stand-off had to be re-derived, and the obvious derivation is
   wrong.** `speed × FLAME_LIFE / 2` gives 560 px against a measured crowd spread of about
   100, because a flame spends most of its life *on the ground*. A bot with that number
   refused every throw — `rej_blast_guard` 120 of 120 ticks at a target 260 px away. It is
   now the ballistic range `v² / (GRAVITY × FLAME_GRAVITY_SCALE)`.

**A flame's `Burst` was renamed `Flame` → `BurnsOut`.** It sat beside the new
`Burst::Flames { count, speed }` for about an hour, and singular-versus-plural as the only
thing distinguishing "this projectile *is* a flame" from "this projectile *becomes* flames"
is a mistake nobody catches in review.

**`light_fan` takes a `Fan` struct** because clippy's seven-argument limit bit — but the
reason to keep it is `burn::Zone`'s: `at`, `aim`, `spread` and `speed` are one description
of a burst, and five call sites passing them positionally is five chances to put a spread
where a speed goes.

**The sandbox implements flames rather than rejecting them.** `game-wasm` used to answer
`cone_not_in_sandbox`; flames are projectiles and the sandbox has a projectile list, so
refusing would refuse a weapon that works — and the sandbox is where fire gets looked at.
It also had to learn that a flame's `Exploded` is a **no-op**: left to the generic
fallback, every flame would have detonated as a 42 px bazooka blast and 160 of them would
dissolve the map.

**Three fixtures met the same trap for the third and fourth time.** `playing()` seats
nobody and `set_phase(Playing)` leaves `round_time` at zero, so a body added to it is
inside `SPAWN_IFRAMES` and refuses every point of damage — which reads exactly like "fire
burns nobody". Wait the warmup out for real. It is now written into
`a_molotov_that_lands_on_a_player_still_bursts_and_burns_them` beside the fixture.

## T19.16 landed — the vite deadline was never timing vite

**Reproduced, on the first branch the task offers.** The failure is real, it is not the box,
and it is not vite being slow to bind.

**What the 90 s was actually timing.** `scripts/e2e.mjs` started its shared vite with
`npm --prefix client run dev`, and `client/package.json`'s **`predev` hook runs
`scripts/wasm-build.mjs`**. So the window whose failure message reads *"vite did not report
a port within 90 s"* covered a release Rust build, plus a lock wait, and then vite. Measured
on an idle box with the identical spawn and the identical `matchVitePort` parse:

```
warm, idle                          11.7 s to the port line   (predev 11.6 s, vite 0.1 s)
after touching game-core, idle      12.6 s                    (predev 12.5 s)
under `cargo test --workspace`,
  load average 8.9                  12.8 s                    (predev 12.4 s)
one other wasm build holding
  T19.15's lock                     19.9 s                    (predev 19.8 s)
twelve queued builds                93.3 s                    (predev 93.2 s)
```

**Vite's own contribution is 0.1 s in every row.** The deadline was 99 % a build timer
wearing vite's name, which is why three sessions looked for a slow browser and found nothing.

**The reproduction, through the real path.** T19.15's lock serialises builds and waits up to
**ten minutes**, so every concurrent `wasm-build.mjs` adds one build to the queue in front of
`predev`. With 24 of them queued and then `node scripts/e2e.mjs title`:

```
  FAIL (startup)                    0.0s
  (startup): vite did not report a port within 90 s
```

— with vite never asked to do anything. That is the named, measured load model the task
requires, and it is a load model made of this repository's own build step rather than of
synthetic spinners, so it cannot leak (every process exits on its own).

**The fix moves the wrong work out of the window; no deadline was raised.** `e2e.mjs` now
runs `wasm-build.mjs` itself, synchronously, **before** starting the clock, then starts vite
with `npx vite --strictPort=false` — which runs no npm hooks — exactly as every standalone
check in `harness.mjs` already does. The 90 s is untouched and now bounds a step measured at
0.1 s, so no queue depth can trip it: this is true by construction, not by sampling. Proof
anyway: the same 24-build queue that produced the failure above now gives `1/1 passed` in
66.8 s, against 65.9 s on an idle box.

**Two things a future reader should know.**

- **`vite-url.mjs`'s exported `startVite` has no caller.** Grepped: `shot.mjs` has its own
  local function of the same name, and nothing imports the exported one. It carries the same
  `npm run dev` + 90 s shape, so if it is ever wired up it will bring this bug with it. It is
  the shared `matchVitePort` in that file that everything actually uses, and that is fine.
- **The remaining startup cost is the server, not the client.** `title` takes ~66 s either
  way; `startStack` waits on `cargo run --release -p game-server` becoming healthy, and that
  is where the time goes. Nothing here changed it.

**This is not `hud-timer`'s family.** T19.16's Notes offer them as possibly the same; they
are not. `hud-timer` had no load term at all (T19.15, above). This one has no vite term.

**Three `game-server` socket tests went red in workspace runs this shift and green
standalone, and they are a family worth naming.** All three reds are from logs verified as
this session's by mtime (see the scratchpad trap below). `checksum.rs`'s
`two_clients_agree_on_the_mask_after_a_hundred_carves` ("expected the fires to produce
carves; got 13" against a floor of 50) and `a_joiner_that_delays_ready_still_gets_every_carve`
("got 5" against 6), and `bots.rs`'s `bots_actually_move` ("no bot moved in two seconds:
[1440.0, 112.0] -> [1440.0, 112.0]"). Every one is green 3/3 standalone on the same tree, and
`checksum.rs` is green 3/3 at `51f6aec` too. All three are the same shape: a **wall-clock
window of a couple of seconds** in which a real server, a real socket and a real client have
to make progress. They are not on the four-check e2e flaky list and **nothing was changed to
accommodate them** — but they belong in the same conversation, and a gate that carries a
non-deterministic red is exactly what T19.15 and T19.16 exist to remove. Whoever picks that
up: the discriminating measurement is not "loaded vs idle" (T19.15 showed that arm reads
backwards) but *what else `cargo test --workspace` is doing in the same second*.

**A trap that cost this shift an hour, and it is not in `CLAUDE.md` yet: the scratchpad
already had `gate1.log` … `gate14.log` in it from the previous session.** Redirecting a fresh
gate to `gate4.log` and then reading `tail`/`grep` on it *before that run reaches the same
point* returns **yesterday's run**, complete with its own `EXIT=`, its own summary and its own
red. Three conclusions were drawn from those files before an `ls -l --time-style` showed the
mtimes were the day before — including a "regression" in which two e2e checks had vanished
from the suite (they had not: that log predates the commit that registered them) and an
`m10-checkpoint` failure that was never this tree's. **Timestamp the log or name it after the
commit**, and check `ls -l` before believing a log you did not watch being written.

## T19.15 completed — `hud-timer`'s open question, answered

The two open questions the previous coder left were, in order: *why* is the `after` sample
occasionally ~5 low, and only then what the floor should be. **The first one has an answer,
and it makes the second one moot.**

**The instrument was measuring two things that move.** `dr` was
`mean redness(warn frame) - mean redness(a frame ~30 s earlier)`, over the rect
`#hud-timer` occupies. Both terms drift:

1. **It is not the same rectangle.** The element is `right:14px`, so it is right-anchored
   and its width follows its text. Measured every run: the control frame reads `"1:29"` and
   is **111 px** wide; the warn frame reads `"0:59"` and is **121 px**, because `1` is a
   narrow glyph. The check sampled the before-frame with the first rect and the warn frame
   with `(await rectOf(...)) ?? white` — the second. Ten pixels of extra background is worth
   about **5.4** points of mean redness, and forcing both samples onto the narrow rect
   reproduced the failure **8 runs out of 8** (39.34, 39.44, 39.67, 39.67, 39.67, 39.81,
   39.92, 39.92 against a floor of 40). That is exactly the recorded "`after` normally
   +2.9..+3.7, twice -1.1 and -2.3", to the decimal.
2. **The background moves under it.** The timer sits over the sky, which animates (§A4) and
   walks the day/night curve. Measured on a same-sized patch of pure sky beside the timer,
   over the same 30 s gap: **-14.7 to -16.9**. Where it starts depends on how long the lobby
   lasted before the match, so the drift is not constant between runs either — which is why
   the same box gave 39.3-45.9 on one afternoon and 44.4-48.0 on another.

**The fix is a better instrument, not a different number.** The assertion is now the
**fraction of pixels in the rect whose redness exceeds 100** — derived, not chosen: the warn
colour `#ff3b30` has redness 201, white digits have 0 by construction and the sky measures
about -80, so 100 is the middle of a gap 200 wide. Eight consecutive runs: **0.00% before,
27.21-27.23% after**, and a background control patch beside the timer read **0.00% in both
frames**. The floor is 5% — a fifth of the signal, against a noise floor that is literally
zero. It cannot be moved by the rect changing width, by the sky, or by load, because none of
those puts a pixel above redness 100.

**Two things went in with it.** The check had a control *frame* and no control **region**
(§C2): the sky patch beside the timer is now sampled in both frames and asserted to stay
below the same floor, so "red pixels appeared" cannot pass for a frame that went red
everywhere. And the old mean is still **printed** every run, labelled "logged, not asserted",
so anyone reading a future failure can see both numbers.

**Falsified at the live binding site:** `hud.ts:189` `style.color = warn ? '#ff3b30' :
'#ffffff'` changed to always white. Red: *"0.00% → 0.00% warn-red (needs 5%)"*, with the
timer still reporting `warn` and still going red at 60.5 s — which is the point, because the
DOM half of the check passed while the pixels failed.

**Inside the full suite it now reads the same as standalone**: 0.00% → **27.23%**, against
27.21-27.23% alone. That is the sharpest evidence available that the suite context was never
acting on this check — the old instrument moved with the frame and the new one does not.

**`hud-timer` should come off the known-red-in-suite list once two more gates agree.** It is
one of the four that `HANDOFF-M19.md` lists as red inside the suite and green standalone.
Its cause is now understood and removed, so the honest next step is to watch it rather than
to declare it fixed — one green gate is one draw. The other three (`bullets-visible`,
`night-combat`, `m10-checkpoint`) are untouched by this and the suite-context hypothesis
still stands for them.

**The other two halves were re-proven, not taken on trust.** The written Done-when
(20 serial `wasm-build`s, 5 client suite runs) is green — 20/20 and 5x800 — but it is
serial, and the previous coder is right that it proves nothing about a concurrency bug. The
proof that does: **4-way concurrent x 3 rounds = 12 builds, 0 failures**, against the 3-of-6
the same shape gave with the lock commented out. And the suite ran once under deliberate
load — `cargo test --workspace` alongside it, load average peaking at **11.6** — 800/800 in
267 s. That load model is a bounded real job rather than spinners: it exits on its own, so
it cannot become the 3 h 47 m leak this task already paid for. Checked after: nothing left
running.

**T19.16 should be re-read in this light.** Its Notes say *"`hud-timer` fails ~1 in 20 on an
idle box with the cause unfound"* and offers it as possibly the same family as the vite-port
failure. It is not the same family: this one was a measurement artefact with no load term in
it at all, which is also why the previous coder's 20-run idle/loaded interleave found the
**loaded** arm reading higher.

## T19.13 landed — what the diff does not say

**Task-file defect, and it is the headline.** T19.13's Tests ask for *"cluster count after a
molotov is >= half `MOLOTOV_FLAMES`"* — twelve connected components of hot pixels. That is
**arithmetically impossible**, not a shortfall in the drawing. Measured over two throws on
`FIXED_SEED=4242`: 24 flames settle across **92-108 world px**, so neighbours average ~4 px
apart, while `FLAME_RADIUS` is 10 and a flame is drawn about as wide. They touch whatever
the renderer does; the connected-component count is 2-4 and no drawing can raise it.
Lowering the floor to whatever came out would have been the number-that-made-it-pass trap,
so **the count is reported and not asserted on**, and three assertions counted at both ends
replaced it (see the check's header). The instrument is fine — it reports 0 with nothing
lit — the target was wrong.

**§F10.3 names a dead path.** *"It lights the world through the existing lightmap hazard
path"* — that path is `collectLightSources` (`lightmap-math.ts:112`), and **it has no
production caller**: grepped, the only callers in the tree are its own unit tests.
`GameScene.ts:1498` builds its light list from `OrdnanceState.lights()` and
`OrdnanceFxState.lights()` directly, and the sandbox does not light at all. T19.12 added a
`flame` row to that table and it would have lit nothing; the row is gone and a flame lights
the world through `GLOW` like every other projectile, which is the wired path. Said in the
file so the next reader does not re-add it.

**Two burning-ground draws, and the task names one.** T19.13's Read-first calls `weather.ts`
`fireGfx` *"the burning-ground draw being removed"*; it is not — `drawFire` is vent embers
plus a per-vent disc, and that disc is now `VENT_MOUTH_R` 8 rather than 26, a mouth and not
a fire. The molotov's disc was `ordnanceFx.ts` drawing `state.hazards` of kind `fire`. With
`BurnZone::Fire` retired, **no server narrates a fire hazard at all**, so the whole `'fire'`
`HazardKind` is retired client-side: the disc, its flicker dots, its colour and its light.
`hazardKind('Fire')` now answers `'other'`, and the two spellings are kept in the unit test
as the falsification — if a fire zone ever returns, that test is where it is noticed.

**A real bug the new check found: the cap culled flames in silence.** `enforce_cap` called
`Projectiles::remove` and said nothing, and a client only drops a projectile when a
`ProjectileDespawn` arrives — so **every flame the cap dropped went on burning on every
screen for the rest of the round**. Measured: a full field read **176** live flames on the
client against a cap of 160, and the surplus never came down. `enforce_cap` now returns the
ids it dropped, `World::step_placed` announces each as `DespawnReason::Culled` (a new
variant, for the reason `Spent` is one), and the same field now reads 130-158. The sandbox
discards the ids deliberately — it re-reads `liveProjectiles()` every frame. Counted at both
ends in `delivery.rs`: 40 over the cap, 40 announced.

**Flames are painted, not summed, and that was measured.** The ordnance layer blends `ADD`,
which is right for tracers and wrong for a crowd: ten overlapping oranges sum past white in
every channel, and `shots/fire-crowd.png` showed a fire drawn as two pale bulbs that read as
steam. It was also fooling the check — a saturated centre has `r - b == 0`, so the *hottest*
part of the fire failed the "is this warm" test and only the rims were counted. Flames now
draw on their own `Graphics` with no blend mode, created before the additive one so it sits
underneath at the same depth. Same throw, same threshold: hot pixels **1551 -> 2952**. What
makes a flame read at night is its light (`GLOW`), not its blend mode, and that is unchanged.

**The picture is faithful; the crowd is not scattered — that is the simulation.** 24 flames
settle into **2-4 piles**, not 24 points, because a flame slides downhill on every bounce
(`bounce()` applies `FLAME_FRICTION` to the whole velocity, so a slope accelerates it until
it reaches a flat spot) and nothing keeps two flames apart. Aimed into a valley: 2 spots.
Aimed down-left: 3, of 8/7/9. This is a design observation for the coordinator, not a
rendering bug — a molotov's area denial collapses to a few points, and §F10's picture of a
crowd spreading along the ground is only half delivered. Flame-flame separation, or a static
friction that stops a flame where it lands, would be the change; neither is a builder's.

**Perf, as §F10.3 asks: a full field does not hold 60 fps, and the cost is the drawing.**
On the real server (the sandbox has no flame emitter in its loadout, and granting one there
would move the slots five other checks select from): **16.5 ms/frame quiet, 25.3 ms with
~150 live flames — 40 fps**. With the falsification in place, which drew *one* flame and
kept the same wire traffic, it was 17.9 ms. So it is the per-flame draw and light, not
`ProjectileMove`, that costs. Reported, not capped: `fire-visible` gates only at 50 ms so a
loaded box cannot trip it, and a `FLAME_MAX_LIVE` change is the coordinator's.

**The flame field is deterministic**, which is what lets the check gate on structure:
`FIXED_SEED=4242` with a fixed aim gave byte-identical resting positions across four runs
(4 distinct spots, 108 px). It is pinned to the seed, so a map-generation change will move
it — the failure would read "the crowd did not scatter", which is the honest message.

**`checksum.rs` is wall-clock sensitive and flaked once under load.** The first gate run of
this shift was started at load average 2.69 (decaying from the browser check that had just
finished) and `two_clients_agree_on_the_mask_after_a_hundred_carves` and
`a_joiner_that_delays_ready_still_gets_every_carve` failed with *"expected the fires to
produce carves; got 13"* and *"got 5"* against floors of 50 and 6. Both are green 3/3
standalone on the same tree, green at `51f6aec` 3/3, and green in a full `cargo test
--workspace` on an idle box. **Not added to any known-flaky list** — one observation is not
a population — but they are socket tests that fire 100 times on a 110 ms clock, so they are
candidates. Wait for the load to fall before starting the gate; `until awk '{exit !($1 <
0.6)}' /proc/loadavg; do sleep 15; done` is what this shift used.

**Already done, despite the task file:** T19.13's deliverable list says `ordnance.mjs:348`
and `:364` are repaired here. T19.12 repaired both — `d.jets` is gone and the molotov step
counts `flamesSpawned` against `MOLOTOV_FLAMES`. Nothing to do.

## Where the T19.08 coder handed over (retiring at ~380k; HEAD was `fbcdd87`)

**HEAD is `fbcdd87`. The tree is clean, `git stash` is empty, and the last full gate was
EXIT=0 — 41/41 e2e, net smoke 25/25 joined, assets ok.** The untracked `CLAUDE.md` symlink
at the repository root is not a builder's and should be left alone.

**Landed this shift:** T19.05, T19.06, T19.07 and its restart follow-up, T19.08. **Booked:**
T19.17 (a crate that cannot be picked up), T19.18 (the lobby client never learns its
inventory), T19.19 (fourteen `wasm_bindgen_test`s that no gate has ever run).

**Next is T19.09**, and it is not the one-line constant change it looks like. Its sweep
section is the thing to read first: the risk is not that the client holds a copy of
`TELEPORT_CHARGE` — it does not, and every site is already pinned — but that a **shorter**
charge makes *accidental* teleports more likely across the whole browser suite. Twelve
checks call `standStill`, which holds a body still by design, and `hud-bars.mjs:58` already
records that T15.01's pads "moved the subject of every assertion". Only a full gate can see
that, so budget for one; the Done-when is crate-scoped and cannot. Note also that waits
pinned to the constant get *shorter*, so `teleport.mjs:211-223`'s absence assertion falls
from a 5.0 s window to 3.75 s — correctly pinned, and proving less afterwards. Say so
rather than letting it pass silently.

**Two things this shift learned about the machine, both paid for:** sweep for
`cargo|rustc|node|vite|game-server` before any gate — a pattern without `cargo` cannot see
what a killed `check.sh` leaves behind — and read `uptime`'s load, not just the process
list, because it read 2.96 while the table looked clean. And see the suite-context
hypothesis above before treating any red as a load flake.

## Where the next agent picks up (this coder retiring at ~660k)

**HEAD is `5ff8969`. The tree is clean, `git stash` is empty, and the last full gate was
EXIT=0 — 43/43 e2e, net smoke 25/25 joined, assets ok**, on a log whose mtime was checked
(see the scratchpad trap in the T19.16 section — it is the single most expensive mistake of
this shift). The untracked `CLAUDE.md` symlink at the repository root is not a builder's and
should be left alone.

**Landed this shift:** T19.13 (finished from a predecessor's uncommitted tree), T19.15's
remaining `hud-timer` half, T19.16. Plus the two corrections the coordinator asked for:
`every_weapon_digs`'s exemption comment now names `Flames` rather than the deleted `Cone`,
and the four over-length journal entries (T19.09-T19.12) are compressed to eight lines with
every finding moved here rather than dropped. `Burst::Flame` was corrected to
`Burst::BurnsOut` in two places here as well.

**Next is T19.17** — a crate you cannot pick up, found by T19.05 and "measured and
unexplained" — then T19.18 and T19.19. None was started.

**Three things this shift found that belong to nobody yet:**

1. **The molotov's crowd converges into 2-4 piles rather than scattering** (T19.13 section
   above). The picture is faithful to the simulation; the simulation is what falls short of
   §F10's stated intent, because a flame slides downhill on every bounce and nothing keeps
   two flames apart. This is a design call, not a builder's.
2. **A full flame field does not hold 60 fps** — 20.8-25.3 ms/frame against 16.5 ms quiet —
   and the cost is the per-flame draw and light, not the wire. Reported, not capped.
3. **Three `game-server` socket tests flake in workspace runs and pass standalone.** Named
   in the T19.16 section. They are not on the four-check e2e list and nothing was changed to
   accommodate them.

**And one to watch rather than to trust:** `hud-timer` has been green in three consecutive
gates on the new instrument, reading identically inside the suite and alone. Two more
agreeing gates and it should come off the known-red-in-suite list; one green run is one draw.


## The instrument was the bug — six times in M19, and why they survive

Counted from the journal rather than from memory. Every one of these looked like a defect
in the system and was a defect in the measurement:

1. **`hud-timer`'s moving rectangle** — a mean over a right-anchored element whose width
   follows its text ("1:29" 111 px, "0:59" 121 px), differenced against a sky drifting
   −14.7…−16.9 over the 30 s between frames. Two confounds, neither of them load. This is
   the one that had been blamed on load for a whole milestone.
2. **`fire-visible`, four separate defects in one check (T19.13)** — the sampled rect ran
   into the quick bar and counted the **inventory**; base frames captured before
   `mouse.move` counted the player's **arm**; an absolute threshold scored 11 clusters on
   an **unlit** control frame because this map's terrain is brown; and additive blending
   summed the fire's centre past white, where `r − b` is 0, so the **hottest** pixels
   failed the check's own "is this warm" test.
3. **The vite deadline that never timed vite (T19.16)** — 11.6 s of an 11.7 s window was a
   `predev` Rust build, under an error message naming vite. Vite's own contribution was
   0.1 s in all five measured rows.
4. **`check.sh | tail -80` returning `tail`'s exit status (T19.04)** — the gate's own
   result laundered by a pipe, reporting a red gate as green.
5. **`enterBattle` never reassigning `d` (T19.14)** — "in battle (0 players)" was a stale
   read from before the wait, and the four checks reporting it were exactly the four that
   took that path. Hence that entry's title: *the log was lying*.
6. **`backdrop-real` was attribution, not budget (T19.15)** — the cost was real and charged
   to the wrong `it()`, inside a 5 s default while a 120 s `beforeAll` already existed.

**The through-line is not carelessness.** Every one of these instruments was correct **when
written**, and each was invalidated by something that moved underneath it — a glyph width,
a blend mode, an npm hook, a pipe, a wait added later, a timing block that grew. That is
why they survive: a measurement is written once, passes, and is trusted permanently, while
the thing it measures keeps moving.

**So the rule this milestone actually paid for is not "check your instruments" but: an
instrument is only valid for the code it was written against, and nothing re-validates it.**
Every one of the six was found by somebody changing something else nearby and looking.
**None was found by a test going red.**

## The remaining three flakes are not one population

Profiled after the hypothesis was renamed (a *shape* — a short wall-clock window over a
real socket — rather than a *context*). Wait shapes differ, so one experiment aimed at "the
family" would blur three mechanisms together:

    night-combat     7 bare wall-clock waits, 2 condition polls
    m10-checkpoint   5 bare wall-clock waits, 5 condition polls
    bullets-visible  1 bare wall-clock wait,  0 condition polls

- **`night-combat`** is almost entirely fixed `waitForTimeout`s — 500, 400, 200, 60, 1000,
  400, 400 ms — bare sleeps against nothing. That is the named shape undiluted, and it is
  cheap to settle: replace the seven with condition polls, and either it stops failing or
  the sleeps are exonerated.
- **`m10-checkpoint`** is half condition-polled with generous timeouts (60 s, 90 s, 30 s,
  20 s) plus one bare `sleep(1500)`.
- **`bullets-visible`** has almost no waits: its wall-clock dependence is **inherent to the
  measurement** — a ~150 ms screenshot against a round that crosses the screen in ~475 ms.
  It cannot be fixed by replacing sleeps, because its window *is* the screenshot cost.

**Caveat, stated rather than buried: this is a profile of wait shapes, not a measurement of
failures.** It says where to look; it is not evidence that sleeps cause the reds. And note
that **`bullets-visible` has already had the audit `hud-timer` just got** — brightest-column
rather than a mean, every reading differenced against a control frame, and a control region
the round provably never enters (added after a streak once travelled 219 px across an
earlier "control" that was not one). Its instrument is hardened and it is *still* in the
family. So "audit the instruments" is not the general answer here.

## T19.17 landed — the refusal was correct, and the report was the instrument

**Reproduced first, theorised second, and the first theory was wrong.** The written-up
symptom — "crate `{item:0}`, a MEDKIT, player `heals=0 batteries=0`, so `bump` cannot
refuse" — is a client-side reading of a field the server never sent.

- **The task file's own starting point was a dead end, and it is worth saying so.** It
  points at the distance being measured from one end (the client's predicted position
  against the server's crate) and asks for both. That was measured: a `serverPlayer` field
  was added to `debug()` carrying the snapshot's `p.body.pos`, and over ~430 polls the two
  ends agreed — **client closest 0.1 px, server closest 0.9 px**. The distance was never
  the problem. The field is kept because §A39 wants both ends of any distance claim, but
  it did not find this.
- **What found it was an `eprintln!` inside `resolve_pickups`**, printing the item, its
  count, both positions and both counters whenever a crate was within 60 px. 3863 samples,
  closest **0.17 px**: `crate id=11 item=22 count=2 grounded=true lock=0 heals=0 bat=0`.
  `item 22` is `MOLOTOV`, and `MOLOTOV_AMMO` is 2. The walker picks a molotov stack off the
  ground at poll 8 (`pickups` goes 0 -> 1, `slotsUsed` 1 -> 2) and is at the cap from then
  on; §C24 gives a weapon **one slot, ever**, so `Inventory::add` finds no room to merge
  into, refuses to open a second slot, returns `Full`, and the item stays on the ground.
  That is `items/world.rs:341-381` working exactly as written. The diagnostic was reverted.
- **The client is the defect, and it is player-facing.** `crate_spawn`'s payload is
  `{tick, world_item_id, x, y}` (`docs/40`, and the server matches it). `worldMirror`
  handled `item_spawn` and `crate_spawn` in **one arm** and coerced the missing fields with
  `n(p['item_id'])` = **0** and `n(p['count'], 1)` = 1. Registry id 0 is `MEDKIT`, so
  `labelFor` put the name **"Medkit"** over every supply crate in the game, whatever it
  held. `item` and `count` are now `number | null`; `labelFor` answers "Supply crate" for
  the unknown case. Falsified at the live binding site: restoring the coercion fails both
  new tests (`expected +0 to be null`, `expected 'item null' to be 'Supply crate'`).
- **A genuine wire asymmetry, reported rather than fixed.** The mid-round/reconnect
  catch-up re-sends every live item as `item_spawn` **with `item_id` and `count`**
  (`session.rs:1265`), crates included. So a client that *joins after* a crate lands knows
  its contents and a client that *watched it fall* does not. The unknown case is therefore
  keyed on `item === null` and not on `source === 'Crate'`, so the joiner's copy still names
  what it holds. Whether contents should be public at all is a spec question — `docs/40`
  pins `crate_spawn` to four fields and pins `item_spawn` to seven, and the catch-up reuses
  the second for crates — so it is **the coordinator's**, not a builder's. Nothing was
  invented on the wire.
- **`crates.mjs` was carrying a false claim** ("By `items/world.rs:341-381` that pickup
  should have happened") in the header every future re-seeder would read. Replaced with the
  measurement. Its non-pickup failure line now prints **what the player is carrying**,
  because the client cannot be asked what is in a crate and the bag is the only half of the
  comparison it has. `CRATE_SEED` stays 31337; 555 is a fine seed for the flight and a
  useless one for the pickup, and the header now says which.
- **What a future reader should take from this**: the client's copy of a server-side value
  is evidence about the client. Two independent measurements agreeing (`d.player` and
  `d.serverPlayer` both reading ~0 px) still said nothing about the third number nobody had
  looked at. Print from the layer that owns the state.

**Also folded in from the T19.13 review, at the coordinator's request:**
`tasks/M19/T19.20` books `collectLightSources` — confirmed dead by grep (14 references in
its own test file, 2 in the defining file, zero elsewhere). The exposure named in the task
is not the function: it is the **only** producer of `kind: 'cone'` in the client, so
`lightmap.ts`'s `eraseCone` has no live producer either and **no flashlight cone, local or
remote, lights anything** — against `docs/14` §4, which makes a flashlight at night a
trade. Explosion flashes and `HAZARD_RADIUS` are the other two orphaned sources.
`TASKS.md`'s count is re-derived at 203. And `delivery.rs`'s duplicated `40` is now
`const OVER_CAP`.

## T19.18 landed — the client subscribed one frame too late

**The task file's hypothesis was right and its pointer was not.** It suggested `events.rs`
delivery scoping and "the event being emitted before that client's scene exists". The
scoping is fine (`Scope::Only(player_id)`, and `broadcast_inventories` is called at match
start exactly where it should be, `room.rs:2741`). The window is one frame wide and it is
entirely on the client.

- **The sequence.** `map_init` and `inventory` go out back to back from the same tick.
  `MenuScene` holds the socket and buffers `map_init` in its own handler, then calls
  `scene.start('Game')` — which Phaser defers to the next update. `GameScene.create()`
  registers `conn.on('inventory', …)` there. `inventory` arrived in between, on a
  `Connection` whose only listeners were `MenuScene`'s three. Dropped, with no error.
- **It is every menu-entered client, not just the host.** Measured on all three of
  `m10-checkpoint`'s (`ana`, `bo` in the private lobby, `cy` through quick match); the task
  file recorded two.
- **The fix is a set, not a fourth buffer.** `MenuScene` already hand-buffers `map_init`
  and `lobby_state` through the scene registry, and `GameScene` hand-buffers `snapshot` in
  `pendingSnapshot`. A fourth would be the one the fifth person forgets.
  `LATCHED_EVENTS` in `connection.ts` names the events whose payload is a *current value*
  rather than a change; `connect()` attaches a recorder for each **whether or not anybody
  has subscribed**, which is the whole point, and `on()` replays the last one to a late
  subscriber. `map_init` and `lobby_state` keep their bespoke path because they also drive
  the handover — they are not merely values.
- **The replay is a microtask, deliberately.** Inline, `on()` would run the handler *inside*
  the `create()` that is registering it, with half the scene's fields unbuilt — every caller
  here registers from `create()`. `refreshHud` happens to guard on `!this.hud`, so inline
  would have worked today; that is luck, not a contract. The unit test asserts the handler
  has **not** fired before the first `await`, so the ordering is pinned rather than assumed.
- **Falsified at the live binding site**: deleting the four-line replay in `on()` fails 3 of
  the 5 new `connection.test.ts` tests. The control in the same test is `score` — a change,
  not a value — which must *not* be replayed, so "the latch works" cannot be satisfied by a
  `Connection` that replays everything.
- **`m10-checkpoint` selects by name again** and prints both clients' slots
  (`0:shovel 1:bazooka 2:smg 3:mine 4:flamethrower 5:molotov 6:laser_pistol`). The two ends
  (§A39) are the name the *client* believes it holds and the crater the *server* makes when
  that slot fires: a slot list that disagreed with the server's would carve differently or
  not at all. `Digit2` proved only that a key was pressed.
- **`Connection` had no test file at all** before this. `socket.test.ts` covers `Net`
  (`BootScene`'s transport), which is a different class.

### `m10-checkpoint`'s mask disagreement — a third sighting, and a mechanism to check

**It went red once, standalone, on the first run after this change, and 6/6 green
immediately afterwards** (plus one green before those, so 7 of 8). Recorded rather than
smoothed over, because HANDOFF already carries two sightings inside full gates and says the
third is the point to measure properly.

- **This change is not exonerated by 7 of 8** — a ~1-in-8 event needs far more runs to
  attribute — but it is not implicated either, and the two earlier reds predate it. The
  failing run had already passed `ah.solid < dh.solid`, so the fire path worked and only the
  guest's mask was behind.
- **The mechanism worth testing first**: `MASK_CHECKSUM_INTERVAL` is **5.0 s**, and
  `verifyChecksum` responds to any mismatch with a **full resync** (`worldMirror.ts:264`) —
  which is exactly what a client mid-way through applying a burst of carves looks like. The
  check fires four rockets over ~2.3 s, sleeps a fixed **1500 ms**, and samples the two
  hashes **once**. Whether a checksum lands inside that window is a function of where the
  burst falls in a 5 s cycle, which nothing in the check controls.
- **Deliberately not changed.** Replacing the fixed sleep and single sample with a bounded
  convergence poll is the obvious repair and is probably right — the property the check is
  about is that the two clients *agree*, not that they agree at one arbitrary instant — but
  HANDOFF's own rule is not to touch this family without measuring, and an A/B of that
  change is a task, not a paragraph.
- **What did change is the diagnosis.** The failure line now prints `solid`,
  `carvesApplied`, `pendingCarves` and `resyncs` for both clients. Three reds in M19 have
  each reported two hashes and nothing else, so nobody could tell a dropped carve from a
  resync in flight. On the fourth sighting the log will say which — and a non-zero `resyncs`
  on the guest confirms the mechanism above in one line.

## T19.19 landed — and `m10-checkpoint`'s flake was diagnosed on the way

### The count is thirteen, and the fourteenth is a doc comment

`grep -c '#\[wasm_bindgen_test\]' crates/game-wasm/src/lib.rs` returns **14**. Thirteen are
attributes; the fourteenth is `lib.rs:1322`, a doc comment reading *"A plain `#[test]`, not
`#[wasm_bindgen_test]`"*. The task file, its source note in the T19.07 section above, and
`TASKS.md`'s row all carried the 14. **Task-file defect**, and it is the instrument again:
the number came from a grep that could not tell code from prose. 13 attributes + 3 plain
`#[test]`s = 16 functions, of which the gate ran 3. It now runs **17** (the 16 plus the new
guard).

### Nothing in the crate needs a browser, and that decided the trade

`game-wasm` depends on `wasm-bindgen`, `serde_json`, `game-core` and
`console_error_panic_hook`, and the whole crate mentions neither `js_sys` nor `web_sys` —
grepped, the only hits are the two comments this task wrote. Every method the thirteen call
runs natively. Wiring `wasm-pack test --node` into a ~35 minute gate to buy assertions that
cost nothing natively was the wrong half of T19.19's choice, so it was not done.

**The guard is two-layered, and that is deliberate.** `wasm-bindgen-test` is out of
`Cargo.toml`, so `#[wasm_bindgen_test]` no longer compiles — that is the structural half, and
it means the text-scanning test can only fire if somebody adds the dependency back. It is
kept for exactly that person: it names what will happen (compiles, reports nothing, never
runs) and where the runner would have to go. **Falsified by doing it**: re-adding the
dev-dependency and converting one test back gave `running 16 tests` — the converted test
vanished from the harness *silently*, which is the failure mode itself — and the guard failed
naming line 1529.

### What the thirteen alone covered, which is the answer the task asked for first

`client/src/core/index.test.ts` drives the **real compiled `pkg`** through vitest, in the
gate, and duplicates nine of the thirteen: `generate` dimensions, `meta_json` spawn/surface
points, `solid_at` against a carve, dirty chunks, the RLE round trip, malformed-mask
rejection, player-state round trip, unknown player, and `apply_input` moving a player. It
also covers something the Rust side does not — a view held across WASM heap growth.

**So the wasm target was never untested, and T19.19's stated headline is wrong.** It says
"§A19's whole claim — that a renderer cannot drift from a constant because a test pins the
crossing — rests on a test that does not execute". It does not:
`index.test.ts:21` asserts the **same six values** (`VIEWPORT_W/H`, `CHUNK_SIZE`,
`CAMERA_ZOOM`, `PLAYER_W/H`) through the real wasm and has been running all along. Breaking
`CAMERA_ZOOM => 3.0` was still worth doing as the task's falsification, and the wasm crate's
own assertion now catches it (`left: Number(3.0), right: 2.0`).

**What was genuinely dark**, and is the real exposure this task closes — listed so nobody
later deletes them as redundant:

- `meta_json`'s **`buried_slots`** key. `index.test.ts` checks `spawn_points`,
  `surface_points`, `traversable_fraction` and `wind`, and never this one.
- **The seed's high half.** `Core.generate(seed: bigint)` splits into `lo`/`hi`
  (`index.ts:431`), and every seed the TypeScript suite passes (4242n, 1n, 2n, 31337n) is
  under 2^32 — so `hi` is 0 in all of them and "the high half must matter" was untested.
- **`add_player` ignoring a duplicate id.** Nothing on the TS side adds the same id twice.
- **`set_player_state`'s velocity round-tripping.** TS asserts x, y, grounded and fuel; the
  Rust test is the only one that reads back `vx`/`vy`.
- **Two of `load_mask`'s four malformed inputs** — an empty slice, and a 0x0 mask. TS tries
  the other two.

### `m10-checkpoint` — the fourth sighting, and it was the instrument

The T19.19 gate went red on `m10-checkpoint`'s carve-agreement line. **The diagnostic added
in T19.18 answered it on the first try**, which is the whole argument for adding it:

```
host  solid=1730650 applied=36 pending=0 resyncs=0
guest solid=1730587 applied=37 pending=0 resyncs=0
```

Nothing buffered, nothing resynced, and the **guest one carve ahead** — because
`[await dbg(host), await dbg(guest)]` are two round trips and a carve landed between them.
Not a divergence. Two rounds of repair, and the first one was wrong:

- **Thirty-six carves from four rockets is the tell.** The carve stream never goes quiet,
  because **weather carves**: a toxic drop bites `TOXIC_DROP_CARVE_R` every
  `TOXIC_DROP_EVERY` (0.15 s) for a whole shower (`world/mod.rs:1436`), and meteors do the
  same. `m10-checkpoint` never set `WEATHER`. With `WEATHER: 'off'` the same run reads
  `applied=2`. That also removes a live hazard to the check's *most valuable* claim — "the
  quick-match room is untouched" compares `solid` before and after, and a meteor in that room
  during the window would report a room leak that never happened. Same exclusion `crates`
  makes, for the same reason.
- **The first repair was a loop that polled until the hashes matched, and it was wrong.**
  Falsified by carving the guest's own client mask directly (`core.carve` is client-only —
  the trap already recorded at the top of this file): the check **passed**. A search for
  agreement hands a genuine divergence the whole of `MASK_CHECKSUM_INTERVAL` (5 s) to repair
  itself through a resync and then reports success. Reverted.
- **What landed is a wait for quiescence, not for agreement**: two consecutive samples in
  which neither client's `carvesApplied` moved and neither has anything pending, then the
  same single hash comparison as before. It grants no more settling time than the existing
  `sleep(1500)` did, so the assertion is the one it always was — taken at a defined moment
  instead of a random one. Re-falsified the same way: **red**, with
  `host applied=2 ... guest applied=2` and different hashes, which is the signature of a real
  divergence and is now distinguishable at a glance from the skew signature (unequal counts).
- **Green afterwards**: 3 standalone runs plus the full gate. Combined with T19.18's 6/6,
  `m10-checkpoint` is 10 of 10 since the cause was removed.
- **It should come off the suite-context list once two more gates agree** — the same standard
  `hud-timer` is being held to. Its cause is understood and removed, and the removal is
  falsified; one green gate is still one draw. What is *not* explained is why the two earlier
  reds (T19.05, T19.08) happened only inside full gates: a slower box widens the gap between
  the two `dbg()` round trips, which fits, but nobody measured it and this section is not
  claiming it. **`bullets-visible` and `night-combat` are untouched by this.**

## Where this coder handed over (T19.17–T19.19, retiring at a clean boundary)

**HEAD is `450d44f`. The tree is clean, `git stash` is empty, and the last full gate was
EXIT=0 — 43/43 e2e, net smoke 25/25 joined, assets ok**, on a log whose mtime was checked.
The untracked `CLAUDE.md` symlink at the repository root is not a builder's; it was left
alone. **`tasks/HANDOFF-M19.md` was being edited concurrently by the coordinator during this
shift** (the suite-context section, rewritten around 05:02); everything added here is
appended at the end so nothing of theirs was overwritten, and their edits went in with the
T19.17 commit because git stages whole files.

**Landed:** T19.17, T19.18, T19.19, plus the two things the coordinator asked for mid-shift
(T19.20 booked, `delivery.rs`'s duplicated `40` bound to a const).

**Next is T19.20**, the only unticked row. Read its "Where to start" first: the decision is
not tidying, it is whether flashlight cones, explosion flashes and hazard lights belong in
the game at all — `docs/14` §4 appears to have answered that for the flashlight already, and
whichever way it goes the answer needs pixels rather than a grep.

**Three things this shift found that belong to nobody yet:**

1. **`crate_spawn` and the join catch-up disagree about whether a crate's contents are
   public.** The spawn event carries four fields; the catch-up re-sends the same crate as
   `item_spawn` with `item_id` and `count`. So one client knows what is in a crate and
   another does not, and `docs/40` pins both payloads. A spec question, not a builder's.
2. **`m10-checkpoint` was reading two clients at two instants** and that is fixed, but the
   *same shape* is worth a sweep: any check that compares two clients with two sequential
   `dbg()` calls is exposed the moment something in the world changes continuously. Nobody
   has looked for the others.
3. **The `LATCHED_EVENTS` set has one member.** `map_init` and `lobby_state` still have
   bespoke buffers in `MenuScene` because they drive the scene handover as well as carrying a
   value. If a fourth current-value event appears, it goes in the set — that is what the set
   is for, and the comment says so.

**One method note, because it is what actually solved two of the three.** T19.17 and the
`m10-checkpoint` flake were both diagnosed by printing from **the layer that owns the state**
rather than reasoning about the layer that reports it — an `eprintln!` inside
`resolve_pickups` for one, four already-existing `debug()` fields on the failure line for the
other. Both had been theorised about across multiple sessions from a client-side number that
was itself wrong. Neither took more than one run once the print was in the right place.
