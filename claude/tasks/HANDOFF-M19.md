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
  the same). The four dead procedural painters (`weapon_knife/whip/axe/hammer`) **must**
  stay: `itemSprites-math.test.ts` reads the live registry, where the five placeholders
  still resolve, so deleting their art fails on five entries.
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
### The one red: `crates`, and everything measured about it

**`crates` is the only check the gate is red on, and it is not a flake — it reproduces on
an idle box, alone, with identical numbers.**

- **Mechanism.** `roll_item` is `pick_weighted(rng, weights(col))`, and `pick_weighted`
  calls `rng.gen_range(0..total)` where `total` is the **sum of the column**. §F5 zeroed
  five weapons, so `total` changed, so the number of words each draw consumes changed, so
  every later draw in the `"items"` sub-stream moved. `tick_crates` shares that stream
  (`spawning.rs:289,295`), so **the crate's x and its contents both moved.** This is
  exactly what §F5 predicted ("removing five entries reshuffles every draw"); it is the
  fixture that has to follow, not the code.
- **The check is built to be re-seeded** — `CRATE_SEED` is an env var and its header
  records three previous re-probes (4242 → 555 → 7) with the procedure. Probed after this
  change: **7** blocked lane at (767, 702); **555** reachable, closest approach **0 px**,
  never picked up; **99** blocked lane at (1276, 784), and its crate is never framed in
  flight. A fourth probe was running at hand-off.
- **The 555 result is not understood and is written down rather than smoothed over.** With
  the player standing **0 px** from the crate for the full 70 s: crate is
  `{id:11, item:0, source:"Crate", grounded:true}` — item 0 is `MEDKIT` — and the player
  had `heals=0 batteries=0` (so `bump` cannot refuse), one shovel and one molotov in 24
  slots (so `Inventory::add` cannot return `Full`), and was alive with 100 health. Ground
  pickups worked in the same run (the molotov appeared in slot 1 mid-walk). By
  `items/world.rs:341-381` that pickup should have happened. Either `debug().player` is
  not the position `resolve_pickups` measures from, or something else is. **A repair that
  makes the counters empty (`Q`/`R` while close) was tried and reverted — it changed
  nothing, and CLAUDE.md says revert what you cannot explain.**
- **Where to start:** print the *server's* player position beside the mirror's crate
  position for one run. `debug().player` is the client's; nothing in `debug()` exposes the
  server's own copy of the local player, which is itself worth fixing — a check whose whole
  claim is a distance cannot verify it from one end.
- **`SPAWN_IFRAMES` catches melee fixtures.** `add_player` stamps them on every joiner, so a
  swing at `now = 1.0` lands, is logged and deals **zero** — which reads exactly like a
  reach failure. `t1905_shovel::swing_damage` fires at `SPAWN_IFRAMES + 1.0` and says so.

