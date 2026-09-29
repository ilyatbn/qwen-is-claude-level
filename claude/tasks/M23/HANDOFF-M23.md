# M23 handoff — paused 2026-09-29 at the owner's request

**Where it stands.** Code HEAD `bcc5b30` (T23.11) on `claude_builds`, plus this handoff commit; not pushed at pause.
Nothing running. Last green batch gate: the tree after T23.10 (9548528 + the T23.19F task-file commit) —
**93/93 browser, vitest 1162**, 2011 s. **T23.19F (e3d5064) and T23.11 (bcc5b30) landed after
it and have not had a batch gate** — run the full `./scripts/check.sh` first thing (launcher:
`scratchpad/coordinator-full-gate.sh` style, detached with setsid, wait on the PID, check the log's mtime).

**What the owner sees now.** Lit bevelled rock (F1), fog/bloom/grade, effect lights, stick figures with full
animation and jetpack flame, rim light, F6 weapons (21, R26 readability), new turrets/gates/pickups/graves/animals/
birds/crystals/vents, F-style effects, zoom 1 (4× the map), night view, and the F1-night ↔ F5-moonlit-day blend with
moving moons. Themes/wearables/skins removed (wire unchanged). Cave back wall **off by default** (T23.09A).

## Open tasks (TASKS.md, M23 section), in the order I would run them
1. **Batch gate** on bcc5b30 (see above).
2. **T23.10B** — what the zoom/night review found. **F1 is a fairness bug**: night light pools show where hidden
   players stand (docs/14 §5). F3 is owner-visible (space moon inside the earth). Do this first.
3. **Harsh review of T23.19F + T23.11** (not yet reviewed).
4. **T23.20** space in the new look (world canvas hidden in space today; space keeps old Phaser effects, gates,
   turrets, figures; owed items listed in its file: asteroid standing pose, solar flare/vortex/black hole, F3 Level A).
5. **T23.21** the HUD (HP/EN/JET bars, hotbar are still the old style).
6. **T23.13B** sky/terrain port differs from the mockup on D3D12 (the owner's GPU); **T23.08B** foreground leaves in
   the game (renderer side built, `setOccluders` has no caller).
7. **T23.24** fireflies (owner ask, "for later").
8. **T23.22** picture gates, **T23.23** count both ends (it carries: low-tier fps re-measure, the night checks count,
   perf on both tiers, retired-check fates).
Then `docs/78-amendments-v10.md` (coordinator writes it; owed items are noted in T23.19D/T23.14D/T23.10 journals:
THRUSTER_PLUME_* removal, use_seq on fire/quick_throw, zoom 1 and sight 640/220, BOT_ENGAGE_RANGE, R24–R27).

## Decisions waiting for the owner
- **Cave background**: off (current default), the middle option (dim fog colour inside caves), or back on. Owner
  was shown off-vs-on pictures (`shots/t2309a-*`). Toggle: `?cavewall=1|0`, sandbox "Cave bg" button.
- **Low-tier frame rate**: SwiftShader busy fight is ~50.7 fps mean (48.3–52.2) after T23.11, against the ≥ 50 target
  (T23.18B); the sky costs ~0.6 ms. Accept, or order another low-tier pass. Owner's GPU: 60.
- **Moon bloom over rock** kept (matches the mockup; T23.19C measured it). Reversible if the owner wants crisp rock.
- Standing from M22: battery economy, parked checks' fates, radiation balance.

## Rulings made this stretch (all in `M23-art.md` or the task As-built)
R24 (cave wall: closing(48) + fade; 4 amendments), R25 (thresholds per back end; actor-box set), R26 (weapon
readability over F6 at 1×), R27 (blast age curve passes through F1's still at 12 % — in T23.19D's As-built, **not yet
lifted into M23-art.md**). Owner priority: the character first (done: T23.12–T23.14F).

## Known flaky / parked (tasks/flaky-test.md)
Parked: `inventory-ui`, `thrusters-match` (bell-arm precondition), `teleport` (terrain control patch). Reported, not
parked: `lava-lights` (red in 37-wide batches, green alone), `night-combat`, `two-clients`, `birds` (once each under
load). The socket-handshake family (9 rows) was fixed in T22.00E; T22.00F found a real server bug (double
welcome payload) and fixed it.

## How the work was run (so the next session can resume the same way)
Builder subagents own the box one at a time (browser + cargo); code-only reviewers run alongside with niced vitest
only; the coordinator runs the full gate per batch with no subagents live; task files for review findings are staged
in the scratchpad while a builder runs (a coordinator commit inflates the builder's `--changed` run), then committed.
Reviews found a real defect in nearly every batch — keep them.
