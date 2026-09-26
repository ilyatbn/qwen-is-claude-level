# M22 — owner round 2 (2026-09-25): the space mode after playing it

Asked after M22 closed, verbatim:

> - gravity is way way too powerful. i keep being swayed throughout the map constantly. gravity should be like a few
>   pixels around each "asteroid" and its fine to sometimes have no gravity at all and just float in space.
> - when an "asterodid" is destroyed (make like a round core at the center) its gravity pull disappears, a battery is
>   spawned when its destroyed.
> - make some asteroids bigger, 0-20% more mass.
> - the teleports created in the edge of the map when destroyed are way too big. they should be much smaller.
> - black hole gravity pull should be larger.
> - edge of the map should be square around the edges
> - rotate the character to the center of gravity when being pulled towards it so they apear to be standing even if
>   they are on the bottom. when not pulled by gravity they go back to being vertical.
> - drain energy 50% slower.
> task them all under m22 and proceed to implement.

## Coordinator rulings (2026-09-25; each reversible — "Reverse it by" is the constant or the one function named)

- **R101 — wells are short-range.** A well pulls only within a thin band around its asteroid's surface
  (`WELL_SURFACE_BAND`, "a few pixels": default ≈ one body height, `PLAYER_H`), zero beyond; open space between
  asteroids has **no** gravity. Strength inside the band is enough to stand and walk on the rock and to fall back onto
  it after a hop, and stays under the weakest thrust (R46/R96 unchanged: you can always thrust off). The 1–5 levels
  scale strength, not reach. Supersedes R18's reach model and the "wells overlap into fields" behaviour; R96/R97's
  caps stay (they now rarely bind). *Reverse it by:* `WELL_SURFACE_BAND`.
- **R102 — asteroids have a core.** Each asteroid gets a round core at its centre (radius a named fraction of the
  asteroid's radius), drawn distinctly. The core is destructible like rock; when the core's pixels are gone (the
  core is "destroyed" — e.g. ≥ a named fraction carved), the asteroid's well switches off for the rest of the round
  and **one battery pack spawns** at the core's centre. Deterministic, hashed, on the wire (the client mirror stops
  predicting that well; the asteroid list carries `alive`/core state). The black hole eating an asteroid is not a
  core destruction (no battery). *Reverse it by:* the core fraction constants.
- **R103 — some asteroids are bigger.** Each asteroid's size draws a seeded +0–20 % mass (mass ∝ area, so radius
  × √(1 + m), m ∈ [0, 0.2]) on the generator's own sub-stream; the space golden rows move and are regenerated with
  the map sweep (never nudged).
- **R104 — the rim is a rectangle.** The space map's boundary is a square-cornered rectangular band inset from the
  map edges (supersedes the ellipse, T22.05A's "the shape is decided: an ellipse"); void outside it, closure,
  breach detection, spawns, the minimap outline and every rim reader follow. Golden rows move (regenerated).
- **R105 — vortices are much smaller.** Capture radius, reach and drawn size ≈ ¼ of today's (derive from the rim
  hole: a vortex catches around its hole, not a screen-wide disc). R97's escape guarantee restated at the new sizes.
- **R106 — the black hole pulls from further.** `BLACK_HOLE_REACH` ≈ 2× today's; the horizon and the kill stay; R90's
  guarantee (outside the ring you can always escape) still holds — the pull outside the horizon stays ≤ margin ×
  weakest thrust, so a bigger reach means you feel it sooner, not that it traps you.
- **R107 — characters stand on asteroids.** Visual only: when a body is inside a well's band (pulled), its drawn
  figure rotates so its feet point to the pull's direction (smoothed); outside any pull it eases back to upright.
  **Controls stay screen-relative** (the cheap ruling the old R-ruling on orientation chose; rotating controls would
  be a movement-model change). Local and remote players, both render paths; derived from the same field the
  prediction uses (`field_accel_at`), no second copy.
  **T22.19B (coordinator, 2026-09-25): the figure tilts toward asteroid wells only** — not the black hole's pull, not a
  vortex's (T22.19 used the full field, so anyone within the hole's 512 px reach was drawn feet-toward-the-hole with no
  rock under them). Rust's capped wells sum through the same `env_at` (no vortices, the hole present but not pulling),
  winged still zero; **on a rock inside the hole's reach the figure stands upright too**, because R91 mutes the wells
  there. The figure pivots at the **feet contact point** (where the body's box meets the rock), not the box centre; the
  drawing overhangs the axis-aligned hitbox sideways — the accepted cost of "visual only". Names now show over players.
  See `T22.19B-what-the-standing-review-found.md`.
- **R108 — energy drains 50 % slower.** Read as the suit's **EN** bar: `RADIATION_SHIELD_COST` halves (1.0 → 0.5 /s).
  Thruster fuel (JET) is unchanged. Re-run the radiation balance report and write the new numbers here.
  **Measured (T22.18, `gate-t2218-reports-{before,after}.txt`, release, same seeds, before `6d8c7df` → after):**
  `space_radiation_report` (8 seeds × 6 bots × 230 s): radiation deaths **0.25 → 0.12** a player a round; other deaths
  4.38 → 4.02; packs spawned 5.46 → 5.40, picked 4.56 → 4.67; unsealed 8.9 → 8.4 % of alive time.
  `space_bots_report` (`BOTS_SEEDS=24`, natural arm; the after also carries R105/R106): radiation **0.29 → 0.12** a bot
  a round, hole 0.01 → 0.01, void 0 → 0, kills 4.21 → 4.49, trips 0.24 → 0.07, packs 4.86 → 5.48; unsealed
  13.7 → 7.7 % of alive time.

## Tasks
- T22.15 — the field: short-range wells (R101) — `T22.15-short-range-wells.md`
- T22.16 — asteroid cores and the battery (R102) — `T22.16-asteroid-cores.md`
- T22.17 — bigger asteroids and the square rim (R103, R104) — `T22.17-bigger-asteroids-square-rim.md`
- T22.18 — smaller vortices, farther black hole, slower drain (R105, R106, R108) — `T22.18-vortex-black-hole-drain.md`
- T22.19 — standing on asteroids (R107) — `T22.19-standing-on-asteroids.md`
- T22.19B — what the standing review found (R107: wells only, feet pivot, name tags) — `T22.19B-what-the-standing-review-found.md`

Order: T22.17 first (the map shape everything else reads), then T22.15, T22.16, T22.18, T22.19. Each gets a harsh
review; one batch gate at the end; `docs/77` gains a §H22 for this round.
**Done 2026-09-25:** `docs/77` §H22 indexes R101–R108 (R107 written there); each ruling is also in the section it
changes (§H4, §H7, §H9, §H10, §H11, §H19, §H20). `DOCS-77-OWED.md` points 28–38 are marked landed.

# Round 3 (2026-09-26): thrusters and sturdier asteroids

Asked by the owner, verbatim (three messages):

> can you make jetpacks in space less powerful? it creates too much inertia.

> also asteroids should be harder to destroy. i was playing a game, and 2 minutes in, the map was mostly empty. make
> them larger again, and sturdier so they somehow take less damage. the core should be even stronger so it takes a few
> hits to destroy the center of gravity.

> lets also have a couple asteroids be even larger, different darker color (lets say made of iron), and be
> indestructible.

## Coordinator rulings (2026-09-26; each reversible by the named constant — full text in the task files)

- **R109 — gentler space thrust** (`T22.20`): `SPACE_THRUST_SCALE` 0.5 on every space thrust direction; no drag; every
  escape cap derives from `SPACE_THRUST_DOWN` (wells 337.5, vortex 900, hole edge 405 / centre ≈462.9).
- **R109b — the inertia is the top speed** (`T22.20`, built by T22.21's builder): `SPACE_MAX_SPEED` 1350 → 450;
  stopping from top speed 1646 px / 2.47 s → 180 px / 0.83 s.
- **R109c — gentle to accelerate, strong to stop** (`T22.22`; `SPACE_BRAKE_SCALE` 1.0 → 1.1 by `T22.22B` F6): per
  axis, a push against that axis's velocity brakes at the brake scale until zero; stop from 450 under 100 px and 0.5 s
  on every axis (up, the weakest, 98 px / 0.47 s).
- **R110 — bigger asteroids again** (`T22.21`): base radius 30..80 (grown ≤ 88), counts 12/32/62.
- **R111 — sturdier rock** (`T22.21`): asteroid rock carves at radius × `ASTEROID_HARDNESS` 0.5; the rim does not.
- **R112 — a tough core** (`T22.21`): `CORE_HITS` 3, the third destroys it; the glow dims per hit.
- **R112b — only a blast hits a core** (`T22.22B`): a hit needs an unhardened radius ≥ `CORE_HIT_MIN_R` (36, the
  smallest explosive blast); bullets, pellets, flames, fragments, melee and lava never count.
- **R99 amended** (`T22.21`): space meteors aim at a random open point, not at a rock (they were emptying the map).
- **R113 — iron asteroids** (`T22.21`; Small's size and the share cap by `T22.22`, `T22.22B` F4): 2 a map,
  1.5–2 × the largest base radius, indestructible, level 5, no core, never eaten by the hole, drawn dark.
- **R113b — iron stays larger** (`T22.22C`): every iron ≥ `SPACE_IRON_MIN_OVER_ORDINARY` 1.125 × its map's largest
  ordinary rock; Small's band 99..100; share target 0.35 everywhere, per-map bound 0.44 on Small, 0.35 elsewhere.

**Measured, the owner's metric** (`asteroid_rock_report`, 8 seeds, ordinary rock left 2 minutes into a bots round):
Small 23.4 % → 83.1 %, Medium 49.3 % → 90.2 %; iron loses nothing.

## Pending owner decision — the battery economy

Sturdier cores, then R112b (bots mostly fire bullets, which no longer count), mean bots almost never break a core, so
almost no batteries appear: **batteries picked fell 4.5 → 0.8 a bot a round** since T22.21 (R112b alone: 1.43 → 0.79
over 128 seeds). Radiation deaths barely moved: **~0.17 a bot a round** (0.16 with R112b off). A person with a bazooka
still breaks a core in three shots. Nothing was tuned for this; the owner decides whether batteries need another
source (table: `T22.22B-what-the-round-3-review-found.md`, "The battery / radiation economy").

## Tasks
- T22.20 — gentler space thrusters (R109, R109b) — `T22.20-gentler-space-thrusters.md`
- T22.21 — sturdier, bigger asteroids with a tough core, and iron (R110–R113, R99 amended) — `T22.21-sturdier-asteroids.md`
- T22.22 — a strong brake in space, less iron on Small maps (R109c) — `T22.22-brake-and-small-map-iron.md`
- T22.22B — what the round-3 review found (R112b, brake 1.1, per-map iron cap, rock floors) — `T22.22B-what-the-round-3-review-found.md`
- T22.22C — iron stays larger (R113b) — `T22.22C-iron-stays-larger.md`

**Written into `docs/77` 2026-09-26:** §H22's round-3 table indexes R109–R113b; each ruling is also in the section it
changes (§H3, §H4, §H10, §H11, §H12, §H18, §H19, §H20). `DOCS-77-OWED.md` points 39–51 are marked landed.
