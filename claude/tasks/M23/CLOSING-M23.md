# M23 — closing summary (builder H, 2026-10-03)

**Headline: the game now looks like the owner's pictures.** Every reference (F1 night, F2 volcanic, F3 space, F4 cast,
F5 moonlit day, F6 weapons, F7 poses) is reproduced through the game's own renderer within measured thresholds, each with
a control that must fail; the live game, staged on four maps by night and day, sits inside the bounds the approved
pictures set. The simulation's golden tables did not move in M23. Full gate result: see the last JOURNAL entry.

## What shipped
- **The art** (T23.00–T23.21B, T23.24): three.js world renderer under Phaser on WebGL2, two tiers; stepped hazy sky,
  stars and moons; terrain fields in Rust (`game-wasm`, render-only); lit, painted rock with per-map pattern; fog,
  foreground leaves and the post chain; effects that light the world; zoom 1 (4× the map) and F1's night view; night
  ↔ moonlit-day blend; code-drawn rim-lit stick figures with scarves in seat colour; every weapon remodelled (F6); new
  effects, furniture, HUD; space in F3's look; fireflies. Themes and wearables gone from the client.
- **Beyond the art** (docs/78 §A1–A11): spectate a bots-only match and `make watch` (T23.27/B/C); bots that route,
  jet, dig, dodge, use every weapon and seek each other (T23.26–26F); map shapes (T23.30); the volcanic world, a
  random look per map (T23.31); a clean round restart behind a load cover (T23.28/29); Space flies up (T23.32); crate
  rain with its own cap and one tombstone per player (T23.36, §A11); the black hole swallows everything (T23.38).
- **The gates** (T23.22): `look-gate-f1…f7` + `look-live`; table in `T23.22-the-picture-gates.md`.
- **The count** (T23.23): 58 old pixel checks (the inventory said 51 — it missed 7), each retired with a replacement,
  rewritten, or kept; table in `T23.23-count-both-ends.md`.

## Owner decisions this milestone
- **D-75** the cave back wall stays off for good. **D-76** low-end (SwiftShader) frame rate is reported, not gated.
- **D-77** (coordinator) the day is gated like the night; who is seen is not capped by render slots.
- Standing owner rules: Space flies up; bot test games never on Random maps.

## Parked (flaky-test.md; `flaky: true`, 10)
`bullets-visible`, `fire-visible`, `fog-visible`, `hud-timer`, `inventory-ui`, `teleport`, `thrusters-match` (bell arm),
`solar-flare-match`, `two-clients`, `m10-checkpoint`. Six of these are old pixel checks, so they assert nothing in the
gate today. `round-over` was **un-parked** (the check raced the new map's paint, not the vote — fixed, plant red).
28 `#[ignore]` Rust tests (`scripts/ignored.sh`).

## Known gaps (for the coordinator)
1. **Low-tier frame rate**: the SwiftShader busy fight is 39.4 fps (49.2 at T23.10, same script, now committed as
   `scripts/busy-fight.mjs`); the whole drop is T23.08B's foreground leaves (`HIDE=fg` → 48). Real GPU: 59–60 on both
   tiers. Under D-76 this is not owed; likely fix if wanted: draw the leaves' quad over their spots only.
2. **Leaf clumps by day** sit as large dark shapes mid-screen at zoom 1 (`shots/look-live-day-7.png`) — a look question.
3. **A restart builds the new world inside the room task** (`room.rs::open_round`), stalling the room ~2–3 s on a Large
   map; the first round generates off-task (`generate_world_task`). Harmless on the results screen, but against the
   room's own rule.
4. **Level B is coarse**: its bounds come from the F1/F2/F3 spread, so a frame with grade, bloom and fog hidden fails only
   edge density. Level A is the real gate.
5. **F5's paletteDE** is reported, not gated (k-means unstable on that frame); **F2 has no bloom control** (nothing in
   F2's world blooms — measured 0 levels).
6. **The items atlas** still packs three item frames the drawn icons replaced, and `crate_open`, which nothing reads
   (the atlas itself is the no-WebGL2 fallback and stays). `assets/vendor/README.md` still says `objects.png` ships.
7. **One replay bound loosened in M23**: `a_perturbed_command_is_localised_to_a_nearby_tick`'s margin `SIM_HZ` → `2×`
   (T23.26F/T23.32, measured and explained at the code).
8. Owed from earlier tasks: T23.37 item 2's owner re-record; T99.03 awaits the owner's notes; T23.33 (volcanic
   disasters) and T23.34 (ice world) parked.
