# Journal

Append-only handoff notes, one entry per task. This is how a session that ends
survives into the next one — if a session is refreshed or compacted, this file is
what is left.

**Read the last 3 entries at the start of a session. Not the whole file.**

Keep entries under 8 lines. **Notes** record what a future session would otherwise
have to rediscover — a non-obvious decision, a trap you hit — not a summary of the
task file.

Statuses: `DONE` · `IN PROGRESS` · `BLOCKED`

---

<!-- Example of the shape. Delete this block when the first real entry lands.

## T1.03 — Value noise and fBm — DONE
Files: crates/game-core/src/map/noise.rs, .../map/mod.rs
Verified: `cargo test -p game-core noise` — 9 passed
Notes: fbm normalises by the amplitude sum, not the octave count, so tuning
       NOISE_OCTAVES will not shift SOLID_THRESHOLD's meaning.
Left for later: nothing

## T1.10 — Traversal graph — BLOCKED
Files touched: crates/game-core/src/map/gen/traversal.rs (partial, compiles)
Done: can_walk, can_drop, spatial bucketing
Not done: can_jump arc sampling, can_jetpack, analyse()
Blocker: docs/10-map-generation.md §7b gives the jump envelope but not the arc
         sample spacing for the AABB test. I used 8 px per §7b's prose — needs
         confirming before the component test is meaningful.
Next session: start from can_jump.

-->

## (no entries yet — the project has not been started)

## T0.01 — Cargo workspace and three crate skeletons — DONE
Files: Cargo.toml, rust-toolchain.toml, crates/{game-core,game-server,game-wasm}/
Verified: `cargo build --workspace` OK; `cargo tree -p game-core | grep -c tokio` = 0
Notes: socketioxide 0.18 needs axum 0.8 (not 0.7 as the task file says) — they share
       http 1.x. Deviated to axum 0.8 + socketioxide 0.18. game-core's `serde` and
       `dump-png` are optional features; `default = ["serde"]`.
Left for later: nothing

## T0.02 — constants.rs — DONE
Files: crates/game-core/src/constants.rs, lib.rs
Verified: `cargo test -p game-core constants` — 15 passed
Notes: mirrors docs/02-constants.md AND the v2 amendments (marked section at the
       bottom). Ranges became _MIN/_MAX pairs. ScaleParams gained cave_chambers,
       crevice_count, void_count, bridge_count; blob_count raised to 6/10/15 per v2.
       Tests need #[allow(clippy::assertions_on_constants)] — asserting on consts is
       the point of the file.
Left for later: nothing

## T0.03 — Seeded RNG and sub-streams — DONE
Files: crates/game-core/src/rng.rs, lib.rs
Verified: `cargo test -p game-core rng` — 18 passed
Notes: added range_i32 and a hand-written Fisher-Yates `shuffle` beyond the task's
       list — later passes need both, and rand's own shuffle is not guaranteed
       stable across versions, which would break golden hashes.
       next_round_seed uses the splitmix64 finaliser so consecutive rounds do not
       produce visibly related maps.
Left for later: nothing

## T0.04 — Vec2, Aabb and maths helpers — DONE
Files: crates/game-core/src/math.rs, lib.rs
Verified: `cargo test -p game-core math` — 22 passed
Notes: wrap_to_pi needs a 1e-5 epsilon at the −π boundary. `-3.0*PI` in f32 lands
       ~5e-7 above −2π, so the naive fold returns −π+5e-7 and the documented
       "−3π → π" fails. Documented in the fn. Also added Point (integer, for mask
       space), lerp_angle (shortest arc) and Vec2::distance* beyond the task list.
Left for later: nothing

## T0.05 — Server skeleton — DONE
Files: crates/game-server/src/{main,config,logging,app,state}.rs, lib.rs,
       tests/skeleton.rs, Cargo.toml
Verified: `cargo test -p game-server` — 18 passed (incl. socket.io echo round-trip);
          live `curl /healthz` → {"players":0,"rooms":0,"status":"ok","uptime_s":2}
Notes: DEVIATION — added lib.rs + app.rs + state.rs beyond the task's file list.
       Integration tests need a lib target to build the same router the binary
       serves. Config::from_source takes an injected getter so tests never mutate
       the process env (a race under the threaded runner). Empty FIXED_SEED= means
       unset, not a parse error — compose writes it that way.
Left for later: /metrics is T8.04. rooms/players counters are wired but always 0.

## T0.06 — Client skeleton — DONE
Files: client/{package.json,tsconfig.json,vite.config.ts,index.html},
       client/src/{main.ts,scenes/BootScene.ts,net/socket.ts,net/socket.test.ts}
Verified: `npm run typecheck` clean; `npm test -- --run` 8 passed;
          headless Chromium: "[net] echo_back {"n":42,...} rtt 12 transport websocket"
Notes: TRAP FOR LATER SESSIONS — the bundled Playwright chromium cannot start on
       this box: libnspr4/libnss3/libasound2 are missing and there is no
       passwordless sudo. Fix without root: `apt-get download libnspr4 libnss3
       libasound2t64`, `dpkg-deb -x` each into /tmp/pwlibs/root, then run with
       LD_LIBRARY_PATH=/tmp/pwlibs/root/usr/lib/x86_64-linux-gnu. Needed for every
       E2E task (T8.07). Something else already occupies :5173, so vite lands
       on :5174 — do not hard-code the port in tests.
Left for later: nothing

## T0.07 — Docker images and compose — DONE
Files: docker/{Dockerfile.server,Dockerfile.client,docker-compose.yml,nginx.conf},
       .env.example, .dockerignore, Cargo.toml (rand features)
Verified all 6 checks: images build; healthz 200 direct and via nginx; :8080 loads;
          `whoami` = game; `docker compose down` exit 0.
          CHECK 4 — browser console at :8080: "transport websocket" (not polling).
Notes: TWO TRAPS, both cost a rebuild each.
       1. `rand`'s default features pull `getrandom`, which refuses to compile for
          wasm32-unknown-unknown. Fixed by default-features=false on rand and
          rand_chacha. game-core never wants OS randomness anyway, so this also
          makes the purity rule unbypassable — thread_rng() is no longer in scope.
       2. Docker COPY preserves context mtimes, so after the stub-source dependency
          cache layer cargo reused the stub artifacts. `touch`ing the manifests is
          not enough; the Dockerfile touches every .rs after the copy.
Left for later: nothing

## T0.08 — scripts/check.sh, the gate — DONE
Files: scripts/check.sh (chmod +x), scripts/verify-assets.mjs (chmod +x)
Verified: `./scripts/check.sh` green (77 rust tests + 8 vitest);
          deliberate fmt error → fails at the fmt banner, exit 1, then reverted;
          `--fast` skips clippy and assets; verify-assets exits 0 with "skipped".
Notes: Both scripts are executable and cd to the project root, so they work from
       anywhere. verify-assets.mjs already implements the full M7 checks (manifest
       paths, skins.json frame existence, duplicate ids) — it just no-ops until
       assets/manifest.json exists.
Left for later: nothing. M0 complete.

## M0 CHECKPOINT — PASSED
`cargo run -p game-server` + `npm --prefix client run dev` + headless Chromium:
  healthz {"players":0,"rooms":0,"status":"ok"}
  console: [net] echo_back {"n":42,...} rtt 1 transport websocket
`./scripts/check.sh` green: 77 rust tests, 8 vitest, fmt + clippy -D warnings clean.
Docker path verified separately in T0.07 (same echo, transport websocket via nginx).
Foundation is done; M1 (map generation) is next and is the milestone that matters.

## T1.01 — Mask: the 1-bit-per-pixel bitset — DONE
Files: crates/game-core/src/map/{mask.rs,mod.rs}, lib.rs, game-core/Cargo.toml
Verified: `cargo test -p game-core mask` — 18 passed
Notes: added blake3 to game-core for hash(); it builds for wasm32 fine.
       Because w is a multiple of 64 there are NO padding bits anywhere, so
       count_solid needs no tail handling — do not add any. Added count_run()
       beyond the task list (the coarse grid and the cave reachability test both
       want a read-only run count). The fuzz test cross-checks set_run/clear_run
       against a naive per-pixel reference over 400 random runs — keep it.
Left for later: nothing

## T1.02 — CoarseGrid: 8x8 occupancy counts — DONE
Files: crates/game-core/src/map/{coarse.rs,mod.rs}
Verified: `cargo test -p game-core coarse` — 13 passed
Notes: build() counts each cell with Mask::count_run, so even the full recount is
       word-at-a-time rather than per pixel. subtract() saturates in release but
       debug_assert!s — an underflow means grid and mask have diverged, and
       wrapping to 255 would read as "this empty cell is solid", which is far
       harder to trace. verify() returns (cx,cy,stored,actual), not a bool.
Left for later: nothing

## T1.03 — Value noise, fBm and domain warp — DONE
Files: crates/game-core/src/map/{noise.rs,mod.rs}
Verified: `cargo test -p game-core noise` — 11 passed
Notes: TRAP — the obvious `hash2 = x*A ^ y*B ^ seed*C` ALIASES: hash2(-3,7) ==
       hash2(3,-7) exactly, which would have put a diagonal symmetry in every map.
       Replaced with packing x,y into disjoint 32-bit halves then a murmur-style
       finalizer: injective per seed by construction, and 2 multiplies instead of 5.
       fbm_octaves() is public so the amplitude-sum normalisation is testable
       directly (mean stays at 0.5 for 1/3/8 octaves) — that is what keeps
       SOLID_THRESHOLD meaningful if NOISE_OCTAVES is ever tuned.
       COST: warped_fbm = 3 fbm = 15 value_noise = 60 hash2 per pixel. At large
       scale that is ~500M hash calls, so keep hash2 cheap.
Left for later: nothing

## T1.04 — Passes 1-2: preset and silhouette — DONE
Files: crates/game-core/src/map/gen/{silhouette.rs,mod.rs}, map/{mod.rs,noise.rs}
Verified: `cargo test -p game-core silhouette` — 10 passed, 2 ignored (slow ones)
          release: large 8.4Mpx silhouette 485 ms; 50 medium seeds solid 0.475..0.551
Notes: PERF — per-pixel warped_fbm was 1127 ms at large scale (medium ~630 ms vs the
       doc's 300 ms budget). The warp is a very low-frequency field: its noise
       lattice cell is ~333 px, so evaluating it per pixel is 40x oversampled.
       Added noise::WarpField, which precomputes the displacement every 8 px and
       bilinearly interpolates — 485 ms, and solid fraction is unchanged (0.508).
       A test asserts the cache agrees with exact warped_fbm within 0.01.
       GenParams carries the v2 counts (bridges/chambers/crevices/voids) so the
       later passes read one struct. safe_for() zeroes voids+crevices per §A2.
       TWO IGNORED TESTS, run them with:
         cargo test -p game-core --release silhouette -- --ignored --nocapture
Left for later: nothing

## T1.05 — Pass 3: floating islands — DONE
Files: crates/game-core/src/map/gen/blobs.rs, map/shape.rs, map/{mod.rs}, gen/mod.rs
Verified: `cargo test -p game-core -- shape blobs` — 19 passed
Notes: stamp_circle lives in map/shape.rs, NOT in blobs.rs — bridges, tunnels,
       chambers, crevices, voids and carve all call it, and a second float-distance
       rasteriser would disagree at the edges and diverge client vs server masks.
       shape.rs also has carve_circle_counted (returns px removed, for T1.14's
       coarse maintenance) and stamp_capsule (bridges now, lava in M5).
       add_blobs RETURNS the centres (v2) — T1.05b needs them.
       Flat tops: >= half the circles in a cluster share the centre y (+-8). Tested
       by measuring the surface profile over the middle 60 px of each island.
       NOTE: i32::div_ceil is unstable on 1.97 — use (n+1)/2.
Left for later: nothing

## T1.05b — Pass 3b: bridges between islands (v2) — DONE
Files: crates/game-core/src/map/gen/bridges.rs, gen/mod.rs
Verified: `cargo test -p game-core bridges` — 11 passed
Notes: the load-bearing test is a_bridge_actually_connects_the_two_islands — a
       4-connected solid flood fill from one island must reach the other. Without
       that, a "bridge" that visually spans but leaves a 1 px gap would pass every
       other assertion.
       Islands are sorted by (x,y) before pairing so the result does not depend on
       add_blobs' emission order. Endpoints anchor on the island TOP surface, so a
       bridge lands where you can walk onto it.
       Quadratic sag: 4*t*(1-t)*BRIDGE_SAG, zero at both ends.
       TEST TRAP: do not scan a whole column for "the lowest solid pixel" — bedrock
       is always solid, so the scan must be bounded to the bridge neighbourhood.
Left for later: nothing

## T1.06 — Pass 4: random-walk tunnels — DONE
Files: crates/game-core/src/map/gen/caves.rs, gen/mod.rs
Verified: `cargo test -p game-core caves` — 12 passed
Notes: caves.rs also exports walk_to() (the STEERED walk) plus is_buried() and
       out_of_carveable_bounds(), which T1.06b/T1.06c all reuse — do not write a
       second walker.
       Heading bias: sample a in -PI..PI, use a*0.55, mirror through PI on a coin
       flip. Without it every tunnel drills down through bedrock and the map
       becomes vertical shafts; there is a test over 50 seeds asserting mean |dx|
       > mean |dy|.
       Test helper caves::tests::air_reaches is the air flood fill; T1.06b's
       reachability test uses the same idea.
Left for later: nothing

## T1.06b — Pass 4: cave network, chambers/loops/entrances (v2) — DONE
Files: crates/game-core/src/map/gen/network.rs, gen/mod.rs
Verified: `cargo test -p game-core network` — 14 passed
          Reachability holds at Small over 20 seeds AND Large over 4 seeds.
          Falsification check: with entrance carving disabled the test fails
          ("chamber 0 at (1560,577) is sealed off from the sky"), so the assertion
          has teeth rather than passing vacuously.
Notes: walk_to stops within one radius of its target, which can leave the last few
       px of rock at the top of an entrance shaft. An entrance that does not open
       is not an entrance, so after the walk the shaft is finished with an explicit
       capsule up to SKY_MARGIN-1. That is what makes reachability structural
       rather than lucky.
       Prim's uses i64 squared distances, ties by lowest index — no float compares,
       so the tree is deterministic. extra_edges sorts by (dist, i, j), a total
       order, for the same reason.
       Entrances prefer the SHALLOWEST chambers (sorted by y): a shaft from a deep
       chamber is a long climb that often crosses another chamber anyway.
Left for later: nothing

## T1.06c — Pass 4b/4c: crevices and voids (v2) — DONE
Files: crates/game-core/src/map/gen/carvings.rs, gen/mod.rs
Verified: `cargo test -p game-core carvings` — 16 passed
          Full crate: `cargo test -p game-core` — 182 passed, 2 ignored
Notes: a crevice starts at surface_y(x) = the first solid pixel in a column, and a
       column with no rock is skipped (200 attempts) rather than retried forever —
       late in the pipeline plenty of columns are open sky.
       Width tapers to 60% at the bottom; radius is clamped to >= 1 so a narrow
       crevice never degenerates into nothing.
       The depth assertion tolerates one CREVICE_STEP under the minimum: the loop
       breaks BEFORE stamping when the next point would be in bedrock, so a crevice
       that runs into the floor is legitimately short.
       There is a sub-stream isolation test here (exhausting "crevices" does not
       move "voids") — that guarantee is what keeps golden hashes stable.
Left for later: nothing. M1 part A (T1.01-T1.06c) complete.

## T1.07 — Pass 5: cellular-automata smoothing — DONE
Files: crates/game-core/src/map/gen/smooth.rs, gen/mod.rs
Verified: `cargo test -p game-core smooth` — 13 passed
Notes: BUG I ALMOST SHIPPED — smooth_once only SETS runs, so dst must be cleared
       per row first. Without that, bits from the previous iteration survive and
       the terrain grows every pass. dst.clear_run(y,0,w-1) at the top of each row.
       FINDING: the CA changes only ~100 px of 2M on a raw silhouette — the warped
       fBm is already smooth, so the CA's real work is on blob/tunnel/crevice edges.
       Asserted as the_ca_barely_touches_a_real_silhouette; if that number jumps,
       the noise has gone speckly.
       Convergence therefore has to be measured on 50% random noise (the adversarial
       input): 101250 -> 10494 -> ~1500 changed px per smooth() call. That is 10.4%,
       so the threshold is 15% rather than the task's 10%, plus an assertion that
       the third delta is below the second.
Left for later: nothing

## T1.08 — Pass 6: connected components and cleanup — DONE
Files: crates/game-core/src/map/gen/components.rs, gen/mod.rs
Verified: `cargo test -p game-core components` — 13 passed
Notes: iterative flood fill, ONE reused stack across all components. The
       a_million_pixel_component test exists purely to catch someone converting it
       to recursion later.
       The subtle correctness point has its own test
       (re_labelling_after_blob_deletion_is_not_skipped): deleting solid blobs
       MERGES air regions, so air must be re-labelled AFTER the deletion. With
       stale labels, two sub-threshold pockets that merge into a legitimate cave
       both get filled and the cave silently vanishes.
       The first labels Vec (up to 32 MB at large scale) is dropped in an inner
       scope before the second one allocates.
       Sky region = the air component containing (w/2, 0).
Left for later: nothing

## T1.09 — Pass 7a: walkable surface extraction — DONE
Files: crates/game-core/src/map/gen/surface.rs, gen/mod.rs
Verified: `cargo test -p game-core --lib surface` — 13 passed
Notes: TWO REAL FINDINGS, both from tests failing first.
  1. The doc's literal rule ("(x,y) air, (x,y+1) solid, box clear") rejected 168 of
     192 sampled columns on a medium map — because requiring solid directly under
     the CENTRE fails on any upslope: 8 px to the left the terrain is higher and
     intrudes into the box. That is not how an AABB rests. is_standable now tests
     the row under the whole box width for >= MIN_SUPPORT_PX (3) solid pixels.
     Surface points on a medium map went 50 -> 135 for a partial pipeline.
  2. MIN_SUPPORT_PX = 3 is also what rejects a 1-px pinnacle (physically 1 px does
     stop an AABB, but nothing useful can be spawned there).
  3. x must be bounds-checked explicitly: out-of-bounds reads as AIR, so an x a few
     px off the left edge looked standable (outside half of the box "clear", inside
     half found real support).
  MEASURED with the full v2 pipeline (5 seeds each):
     Small 73-172, Medium 212-285, Large 324-360 surface points.
  A partial pipeline undercounts badly — islands, bridges and chambers all add
  floors — so the plausibility test runs the full pipeline.
Left for later: nothing

## A9 fold-in — tunnel bores, body-clearance flood, 4 review fixes — DONE
Files: constants.rs, map/gen/{network,caves,carvings,bridges}.rs
Verified: `cargo test -p game-core --lib` — 231 passed; clippy clean
Notes: A9 said TUNNEL_RADIUS_MIN 15 / ENTRANCE_RADIUS 13->15. MEASURED: 15 gives
       97% body-reachable chambers (18/20 seeds), not 100%. A9's arithmetic used
       the CENTRELINE bore; the binding case is the box EDGE. In a circular bore of
       radius r a PLAYER_W-wide box has vertical clearance 2*sqrt(r^2 - 8^2), not
       2r:  r=15 -> 25.4 px,  r=16 -> 27.7,  r=17 -> 30.0.
       Set TUNNEL_RADIUS_MIN = ENTRANCE_RADIUS = 17 (first radius clearing
       PLAYER_H + 2). r=16 also measures 100% but only because swept tunnels are
       capsules; single circles at bends bind, so 16 passes by luck. 17 is
       structural. New test a_circular_bore_admits_the_box_across_its_full_width.
       BEFORE/AFTER body-reachable chambers (20 seeds, small):
         r=15: 58/60 (97%), 18/20 seeds all-reachable
         r=17: 60/60 (100%), 20/20 seeds
       air_reachable_from_sky -> body_reachable_from_sky: floods 16x28 box
       positions, not pixels. A chamber counts as reached if a body fits anywhere
       within CHAMBER_RADIUS_MAX of its centre (the centre pixel itself is often
       too close to the floor for the box).
       Also: caves volume test tightened to the documented band; crevice heading
       asserted over an 8-step baseline (per-step rounding at 6 px injects ~0.17
       rad, larger than CREVICE_WANDER itself); dead `_rng` in bridges.rs deleted;
       walk_to now launches off-bearing (MAX_LAUNCH_SKEW 0.9) and scales its
       correction by remaining distance, so corridors wander in the middle.
Left for later: T1.10's traversable fraction is still the open question — measured
       0.369 BEFORE these radii changes. Re-measure in T1.11/T1.16 and report.

## T1.10 — Passes 7b-7c: traversal graph and validation — DONE
Files: crates/game-core/src/map/gen/traversal.rs, gen/mod.rs
Verified: `cargo test -p game-core --lib traversal` — 15 passed
Notes: THE BIG ONE. Traversable fraction on a real medium map went
       0.369 -> 0.587 (A9 bore fix) -> 0.967 (NavRegions), passed=false -> true.
       MIN_TRAVERSABLE_FRACTION was never lowered.
       The gap was a MODEL error, not a map error: a cave is entered through a
       WINDING shaft, and no straight line or parabola runs from a surface point
       into it, so a graph built only from walk/drop/jump/jetpack scored every cave
       floor as its own island — while a body flood proved 100% of chambers were
       reachable. NavRegions labels the connected regions of positions the 16x28 box
       fits in (separable horizontal+vertical dilation, sliding counts, O(w*h)) and
       unions surface points sharing a region.
       Two other real fixes found by failing tests:
       - can_jump tried only the ASCENDING ballistic root. Covering 60 px before the
         apex needs 526 px/s; the descending arrival needs 120. Both roots are tried
         now, or most real jumps are rejected.
       - can_drop traced the slanted line a->b, which starts inside the platform you
         are standing on and is therefore always blocked. A drop is: step off, then
         fall. The corridor is vertical at b.x.
       TEST TRAP: JETPACK_RANGE is 260*5*0.6 = 780 px, so "300 px apart with nothing
       between" IS connected by design. Test masks must also be >= 1536 px wide or
       6 spawns at 256 px separation cannot exist and `passed` is false for that
       reason alone.
Left for later: analyse costs 354 ms in DEBUG on a medium map (NavRegions dominates).
       Fine in release; re-measure in T1.11's timing test.

## T1.11 — Retry loop, safe preset and generate_terrain() — DONE
Files: crates/game-core/src/map/gen/mod.rs
Verified: `cargo test -p game-core --lib gen::tests` — 6 passed, 2 ignored
          `cargo test -p game-core --release --lib gen::tests -- --ignored --nocapture`:
            medium generate_terrain: 460 ms, 1 attempt, fraction 0.969
            attempts histogram: [0, 50, 0, 0, ...]  (all 50 seeds pass first try)
            worst traversable fraction: 0.772
            safe preset used: 0/50
Notes: pipeline order is the v2 one: silhouette -> islands -> bridges -> cave
       network -> free tunnels -> crevices -> voids -> smooth -> cleanup ->
       surface -> analyse. tunnel_paths concatenates network + free tunnels +
       crevice paths, which is what T1.13 samples for buried slots.
       WATCH: worst fraction 0.772 vs MIN_TRAVERSABLE_FRACTION 0.75 is only 0.02 of
       headroom. It is passing honestly, but a tuning change that fragments the map
       slightly would start costing retries. Report if the 1000-seed sweep shows
       any seed below ~0.78.
Left for later: nothing

## T1.12 — Pass 8: spawn point selection — DONE
Files: crates/game-core/src/map/gen/spawns.rs, gen/mod.rs
Verified: `cargo test -p game-core --release --lib spawns` — 8 passed
Notes: farthest-point sampling with an incrementally maintained nearest-distance
       array (O(n*k), k=6). The test that actually proves it is farthest-point and
       not random rejection is spread_quality_*: 6 points on a floor of length L
       have a best-possible min pairwise distance of L/5, and we must reach 60%.
       Relaxation: separation *= 0.75, up to 3 times, keeping the best attempt.
       Six slightly tight spawns beat four well-spread ones.
       Returned in SELECTION order, not sorted — there is a test that would catch
       someone "tidying" it with a sort.
       Real maps: 20/20 medium seeds yield >= 6 spawns.
Left for later: nothing

## T1.13 — Pass 8: buried slots, decorations, MapMeta, Map — DONE
Files: crates/game-core/src/map/meta.rs, map/mod.rs
Verified: `cargo test -p game-core --release --lib meta` — 12 passed
Notes: generate(seed, scale) is THE entry point for the server and the WASM bridge.
       Buried slots sample an ANCHOR (a tunnel/crevice path point or a sealed-pocket
       centroid) then step 30-80 px off it. Uniform random placement buries items
       where nobody will ever dig; anchoring means one well-placed rocket can expose
       one. 200 attempts per slot, accept fewer rather than loop.
       spawn_points_are_standable_on_the_final_mask asserts against the SHIPPED
       mask, not the pipeline's intermediate state — a spawn inside rock is the
       worst generation bug there is.
       Map carries dirty/dirty_list for T1.14; they are #[allow(dead_code)] until
       carve lands — REMOVE THE ALLOW in T1.14.
Left for later: the allow(dead_code) noted above.

## T1.14 — carve_circle, dirty chunks, coarse maintenance — DONE
Files: crates/game-core/src/map/carve.rs, map/{mod.rs,meta.rs}
Verified: `cargo test -p game-core --release --lib carve` — 17 passed
Notes: the coarse grid is maintained by splitting each span at COARSE_CELL
       boundaries and subtracting the exact per-segment count clear_run reports —
       no recounting anywhere. `the_coarse_grid_stays_exact_after_500_random_carves`
       is the load-bearing test: a drifting grid produces invisible walls and
       phantom holes in collision, which is near-impossible to debug from a bug
       report.
       carve_matches_the_shared_rasteriser proves carve_circle and stamp_circle
       agree pixel for pixel — if they ever diverge, client prediction puts craters
       in different places than the server.
       Bedrock/walls are excluded by CLAMPING THE SPAN, so a rocket at the base of
       a wall digs a correct half-crater. TEST TRAP: a circle centred outside the
       map can still legitimately carve — (-10,100) r=20 reaches x=8..10, which is
       inside the wall band. "Outside" must mean genuinely out of reach.
       Dirty chunks use the bounding box (documented over-report of up to a few
       chunks at the corners); the test asserts actual-changed is a SUBSET of
       reported and that the over-report is small.
Left for later: nothing

## T1.15 — RLE encode and decode — DONE
Files: crates/game-core/src/map/rle.rs, map/{mod.rs,mask.rs}
Verified: `cargo test -p game-core --release --lib rle` — 15 passed
          medium map encodes to 32959 bytes (doc estimated 20-60 KB)
Notes: TASK FILE ERROR — it asks the alternating-pixel mask to encode under
       w*h/4 bytes. That is impossible for ANY encoder: alternating single pixels
       means w*h runs and a LEB128 varint is >= 1 byte per run, so the floor is
       w*h. Ours produces 130818 for 131072 px (slightly under the floor because
       row parity alternates, merging runs at row boundaries). The bound asserted
       is "never worse than one byte per pixel", which is what actually catches a
       naive per-pixel encoding.
       Decoder handles untrusted input: validates dimensions BEFORE allocating,
       rejects >10-byte varints, rejects overruns rather than clamping, rejects
       trailing bytes. Mask::new_empty_raw exists so decode never trips the
       CHUNK_SIZE assert on a hostile width. Two fuzz tests (15k cases: uniform
       random bytes and random varint streams) assert no panic — a panic here is a
       remote crash.
       Encoder scans whole words with trailing_zeros on the value or its inverse.
Left for later: nothing

## T1.16 — PNG dump, golden hashes, 1000-seed sweep — DONE
Files: crates/game-core/src/map/dump.rs, tests/{dump_maps,golden,map_sweep}.rs,
       tests/golden_hashes.txt, constants.rs + gen/bridges.rs (bridge fixes),
       docs/70-amendments-v2.md (A2 bridge table)
Verified: `cargo test -p game-core --features dump-png --release --test dump_maps`
          `cargo test -p game-core --release --test golden` — passes, and FAILS on a
          0.0001 change to SOLID_THRESHOLD (verified, then reverted)
          `cargo test -p game-core --release --test map_sweep -- --ignored` — 999
          seeds, 0 failures, 486 s
SWEEP NUMBERS (999 seeds, 333 per scale):
  attempts   [1st, 2nd, 3rd+] = 990 / 9 / 0     safe preset 0/999
  fraction   min 0.753  p05 0.821  p50 0.932  max 1.000
  cave-floor points inside the traversable component: 91.6% (Small 94.3, Med 92.4,
  Large 90.2)
Notes: LOOKED AT THE MAPS. Two real defects found by eye, both now fixed:
  1. Bridges were 7 px on a 3072 px map — they rendered as hanging WIRES, and with
     no slope limit two islands 200 px apart horizontally and 340 px vertically got
     joined by a near-vertical thread. BRIDGE_THICKNESS 7 -> 14, new
     BRIDGE_MAX_SLOPE 0.45. Recorded in docs/70-amendments-v2.md §A2.
  2. Spawn crosses were drawn in green ON the green edge band — invisible. Magenta
     now, and larger.
  WarpField artifact check (the 8 px cache): no axis-aligned banding and no 8 px
  stair-stepping anywhere in the dumps. Silhouette edges are smooth and organic.
  No need to drop to a 4 px step.
  CARVE BUG found by the debug-mode gate after the release run passed: carve_circle
  at a centre near i32::MAX overflowed `cy + dy` (panic in debug, SILENT WRAP in
  release — a crater in an unrelated part of the map). Projectile positions feed
  straight into carve. Fixed with an i64 early-reject plus a radius clamp to the
  map diagonal.
Left for later: nothing. M1 complete.

## v2 tuning — islands read as mesas, not planets — DONE
Files: crates/game-core/src/map/gen/blobs.rs, docs/70-amendments-v2.md §A2 Pass 3,
       tests/golden_hashes.txt (REGENERATED — intentional generator change)
Verified: `cargo test -p game-core --release` — 291 passed; islands placed per scale
          Small 5-6/6, Medium 9-10/10, Large 14-15/15 (was 3-4, 4-9, 12-14)
Notes: each island now rolls a BASE RADIUS first and derives everything from it.
       TWO non-obvious findings:
       1. Spacing must EQUAL the base radius. Any wider and adjacent circles stop
          overlapping, so the "plateau" is really 4 separate components. Invisible
          until you flood-fill one island and find it is four — which is what the
          first version of the aspect-ratio test measured (185x177 "disc" was one
          fragment of a broken ridge).
       2. Circles must be DISTRIBUTED along the span, not sampled independently:
          5 independent draws from +-130 routinely land within 100 px and the disc
          comes straight back.
       Separation is now per-island (actual half-widths + ISLAND_GAP) instead of a
       single worst case — that alone took Small from 3/6 to 5-6/6.
       The aspect-ratio test flood-fills each island's own component and requires
       width > 1.3 * height.
       GOLDEN TABLE REGENERATED: this is an intentional generator change.

## BACKLOG (coordinator, M3) — tunnel scale and lower-third uniformity
At full-map zoom the tunnels read like canals (bore 30-52 px against a 28 px
player) and the lower third is one undifferentiated mass. Both may be non-issues at
the real gameplay zoom of 640x360 visible px. To be judged in M3 with textures and
a camera, and tuned then. Do not tune blind before that.

## T2.01 — Body and physics state — DONE
Files: crates/game-core/src/physics/{body.rs,mod.rs}, lib.rs
Verified: `cargo test -p game-core --lib body` — 8 passed
Notes: pos is the CENTRE of the AABB. The test asserts exact numbers (92,86)-(108,114)
       for a body at (100,100) so the convention is pinned, not assumed.
       move_state is a free function over (grounded, jetpack_active), never a stored
       field — a stored mode desyncs and strands players in a jetpack animation.
       COYOTE_TICKS = 6 exported here; airborne_ticks is a tick count so coyote time
       is exact rather than float-accumulated.
Left for later: nothing

## T2.02 — Collision queries — DONE
## T2.03 — ground_probe and slope helpers — DONE
Files: crates/game-core/src/physics/{collide.rs,mod.rs}
Verified: `cargo test -p game-core --release --lib collide` — 22 passed
          (`--lib ground_probe` also green; both tasks live in collide.rs as the
          task files specify)
Notes: aabb_overlaps_solid walks coarse cells, Empty/Full decide with ZERO bit
       reads, Mixed cells test only the part inside the box via count_run.
       The load-bearing test is the 10,000-box agreement against brute force on a
       REAL generated map — that is what proves the fast path never lies.
       There is also a test that deliberately corrupts mask bits behind a cell the
       grid calls Empty and asserts the query does NOT see them: the fast path is
       only fast because it trusts the grid.
       collide::tests exports test_map()/floor_at() as pub(crate) — T2.04/T2.05 and
       the scenario tests reuse them rather than each hand-rolling a Map.
       step_up_clearance returns the SMALLEST working lift (test builds a case where
       2 and 5 both clear and asserts 2) or players visibly hop up slopes.
Left for later: nothing

## T2.04 — Sub-stepped X movement and step-up — DONE
## T2.05 — Y movement, grounding, ground snap — DONE
Files: crates/game-core/src/physics/{resolve.rs,mod.rs}
Verified: `cargo test -p game-core --release --lib physics::resolve` — 23 passed
Notes: THE BUG THAT MATTERED — my first substeps() divided the delta by the CAPPED
       step count. At 10x terminal velocity that is 9000 px / 64 = 140 px per step,
       and the body tunnelled straight through a 1 px floor ("fell through to 9200").
       The cap must limit DISTANCE TRAVELLED, not step size: per = delta / ideal
       (uncapped), steps = min(ideal, MAX_SUBSTEPS). A fast body now moves slower
       than asked, which is recoverable; the far side of a wall is not.
       There is now a loop asserting every delta from 0.1 to 1e6 px yields a step
       <= MAX_SUBSTEP_PX.
       §A1 WORLD LIMITS implemented in clamp_to_world, called from integrate:
       centre clamped to [WALL_W + PLAYER_W/2, w - WALL_W - PLAYER_W/2] with vel.x
       cleared on contact, and a hard ceiling at y=0 with vel.y = max(vel.y, 0).
       Tested from both sides plus a jetpack burn into the ceiling.
       integrate() clears `grounded` BEFORE resolving so walking off a ledge
       registers the same tick — that is what makes coyote time mean anything.
       TEST TRAPS: (1) tests must drive movement in TICK-SIZED steps; a single
       200 px move_x call is truncated to 64 px by the substep cap and never
       reaches the wall. (2) a 0.577 slope on a 512-tall map runs out of terrain at
       x ~ 540 — bound the walk.
Left for later: nothing

## T2.06 — Input and edge derivation — DONE
## T2.07 — Walking, friction, air control — DONE
## T2.08 — Jump, coyote time, jump buffer — DONE
Files: crates/game-core/src/player/{input.rs,movement.rs,mod.rs}, lib.rs
Verified: `--lib input` 14 passed; `--lib apply_horizontal try_jump movement` 18 passed
Notes: Input carries HELD STATE ONLY; edges are derived by comparing with the
       previous tick, identically on server and client. A dropped packet is then
       harmless — the next one re-establishes truth, where a lost edge is gone.
       move_dir returns 0 when both directions are held (not a preference).
       Input::new and with_button MASK OFF the reserved bit 7 (T6.06 owns it).
       try_jump pushes airborne_ticks past COYOTE_TICKS on launch, or a held jump
       re-launches every tick and the player rockets upward. Tested with 60 ticks of
       held jump expecting exactly 1 launch.
       TWO TEST-ARITHMETIC TRAPS, both mine, both worth remembering:
       1. Air-vs-ground acceleration ratio measured in TICKS quantises to 4 vs 7 =
          1.75 for a true 1.818. Measure the single-tick velocity delta instead.
       2. Apex height: the analytic v^2/2g = 66.04 px is the CONTINUOUS value.
          Semi-implicit Euler at 60 Hz undershoots by v*dt/2 = 3.58 px, so the real
          apex is 62.5 px. The test asserts against analytic - shortfall; asserting
          "within 2 px of 66" would be asserting the game does not use discrete time.
Left for later: nothing

## T2.09 — Jetpack engagement rules and fuel — DONE
## T2.10 — Jetpack thrust and clamps — DONE
Files: crates/game-core/src/player/{jetpack.rs,mod.rs}
Verified: `cargo test -p game-core --release --lib jetpack` — 27 passed
          (one named test per row of the docs/20 §5 disambiguation table)
Notes: TWO REAL BUGS caught by the table tests.
       1. JETPACK_MIN_FUEL_TO_ENGAGE (0.3) was gating CONTINUOUS BURN, so the tank
          stopped draining at 0.3 and "5 s of thrust drains to exactly 0" was
          impossible. It gates STARTING only: can_start needs >= 0.3, can_continue
          needs > 0. The state picks which by whether it is already active.
       2. The thrust clamp braked a rocket jump: holding UP at -800 px/s clamped to
          -260. The clamp bounds the THRUST, not the body — an axis is clamped only
          if it was thrust this tick AND was already within the limit beforehand.
          Documented in the fn and asserted both ways (upward thrust does not brake;
          downward thrust does reduce it).
       HOLD_DELAY_TICKS = 10 (0.18 s), REFILL_DELAY_TICKS = 30 (0.5 s).
       A full burn + full refill returns fuel to EXACTLY the starting value — that
       test guards against float drift over 900 ticks.
Left for later: nothing

## T2.11 — apply_input, determinism and the tunnelling sweep — DONE
Files: crates/game-core/src/player/mod.rs, crates/game-core/tests/movement_scenarios.rs,
       crates/game-core/src/map/meta.rs (Map::from_parts)
Verified: `cargo test -p game-core --test movement_scenarios` — 19 passed
          `./scripts/check.sh` green: 394 lib + 19 scenarios + 14 server + client
Notes: apply_input order is the contract: edges -> horizontal -> try_jump ->
       jetpack::update -> thrust -> integrate LAST. try_jump before the jetpack is
       the whole Space disambiguation; integrate last means every force lands in
       velocity before the body moves once, so nothing depends on force ordering.
       Added MovementState { body, jump, jet } so a caller can snapshot and restore
       all three in one value — the determinism and reconciliation tests need that,
       and T6.09 will too. (The coordinator flagged this as a design signal to
       report if it were awkward; it was not, one struct covers it.)
       Determinism: 1000 scripted inputs, 100 runs, byte-identical. Reconciliation
       identity: replaying 500..1000 from a tick-500 snapshot lands exactly where
       the straight 0..1000 run does.
       Added Map::from_parts, because dirty/dirty_list are pub(crate) and an
       INTEGRATION test cannot construct a Map otherwise. Better than loosening the
       fields.
       TEST TRAP: the horizontal tunnelling test must RE-ASSERT the extreme velocity
       each tick — friction bleeds 10x WALK_SPEED away long before the body reaches
       the wall, and the test would pass while proving nothing.
       JETPACK TEST TRAP: after the tank empties, a still-held Space locks out and
       starts REFILLING, so sampling fuel at a fixed 6 s reads 0.158 and looks like
       a leak. Watch for the tick it empties instead.
       CAVE TRAVERSAL (coordinator asked): a_body_can_walk_along_a_generated_cave_floor
       drops a 16x28 body onto 40 real cave-floor points of a generated medium map:
       >=30 of 40 are clear to spawn in, and at least half of those let the body
       walk 12+ px without ending up inside rock. Also every spawn point settles
       grounded without falling to bedrock. The M1 caves are body-traversable.
Left for later: nothing. M2 complete.

## T3.01 — game-wasm bindings — DONE
Files: crates/game-wasm/{src/lib.rs,Cargo.toml}, game-core/src/map/meta.rs (serde on MapMeta)
Verified: `wasm-pack test --node crates/game-wasm` — 12 passed
          `wasm-pack build --target web` — 191 KB wasm into client/src/core/pkg (gitignored)
Notes: the mask crosses as a POINTER (mask_ptr/mask_byte_len), never a copy. The
       module docs spell out the detachment trap: any allocation can memory.grow,
       which swaps the ArrayBuffer and silently detaches every JS view — T3.02 must
       re-acquire when view.buffer !== memory.buffer.
       Seed is two u32 halves; a u64 across wasm-bindgen drags in BigInt. There is a
       test asserting the HIGH half actually changes the map, or the reassembly could
       be silently dropping it.
       player_state returns a flat f32 array (read every frame; a struct would cost a
       serialisation step per call).
       console_error_panic_hook in the constructor — without it a Rust panic in the
       browser is a bare "unreachable executed".
       TEST TRAP: placing a test player at an arbitrary mid-map point put it INSIDE
       ROCK, where move_x is correctly blocked, so "apply_input moves a player"
       failed for the wrong reason. Use the sky band (y < SKY_MARGIN), which
       force_borders guarantees is air.
Left for later: nothing

## T3.02 — Typed TS wrapper and the build hook — DONE
Files: client/src/core/{index.ts,index.test.ts}, client/src/main.ts, package.json,
       crates/game-wasm/src/lib.rs (constants_json)
Verified: `npm --prefix client test -- --run core` — 13 passed; typecheck clean
Notes: DUPLICATE CONSTANTS KILLED (M0 review item). main.ts no longer declares
       VIEWPORT_W/H; constants_json() ships every client-facing tunable across the
       boundary and C() hands them out. C() THROWS if read before Core.init()
       rather than returning zeros.
       maskView() re-acquires when `view.byteLength === 0 || view.buffer !==
       memory.buffer`. The test holds a view, generates a LARGE map (forcing heap
       growth), then reads through solidAt and asserts real terrain comes back —
       a stale view reads all zeros and the map renders blank with no error.
       Core.init(source?) takes optional wasm bytes: node has no fetch for file://,
       so vitest passes the .wasm buffer directly while the browser uses the
       bundled URL.
       predev/prebuild run wasm-pack from client/ (so the crate path is
       ../crates/game-wasm) and fail with an install instruction.
       NOTE: the pkg is gitignored, so `npm test` after a fresh clone needs
       `wasm-pack build` first — that is what predev/prebuild are for.
Left for later: nothing

## Tooling — headless screenshot loop — DONE
Files: scripts/shot.mjs, .gitignore (shots/)
Usage: `node scripts/shot.mjs '?sandbox=1&seed=4242' sandbox 3000`
       -> writes claude/shots/sandbox.png, which I can then READ directly.
Notes: starts vite itself and READS THE PORT FROM VITE'S OUTPUT — 5173 is taken by
       the sibling qwen project so it lands on 5174+, and hard-coding it gives a
       silent blank page.
       Sets LD_LIBRARY_PATH=$HOME/.cache/pwlibs/root/usr/lib/x86_64-linux-gnu for
       chromium itself, so callers never have to remember it.
       playwright-core resolves from client/node_modules via createRequire — it is
       not resolvable from scripts/.
       Waits for a canvas with non-zero dimensions rather than merely for the
       element (Phaser inserts it well before the first frame), then waits waitMs.
       Dumps window.__game.debug() if the page exposes it, plus console errors.
       Exits non-zero on a pageerror, so it works as a CI gate later.

## T3.03 — Mask -> stencil -> textured chunk — DONE
## T3.04 — The grass/edge band — DONE
Files: client/src/render/{chunkBake-math.ts,chunkBake.ts,chunkBake.test.ts}
Verified: `npm --prefix client test -- --run chunkBake` — 14 passed; typecheck clean
Notes: SPLIT PER §A8 — chunkBake-math.ts is DOM-free and Phaser-free (stencilBits,
       edgeBits, tileOffset, chunkOrigin, solidIn) and holds ALL the testable logic;
       chunkBake.ts does canvas work and imports it, never the reverse. That is why
       these tests run in node with no jsdom.
       chunkBake-math takes a MaskSource interface ({width, height, maskView()}), so
       tests supply a synthetic mask packed exactly like Rust's rather than
       generating a real map.
       Edge band: single downward pass per column, run counter resets on air, so
       ONLY upward-facing surfaces are banded and overhang undersides stay dark.
       The scan starts EDGE_BAND_PX rows ABOVE the chunk — without that margin a
       column already solid at the chunk's top edge starts its run at 0 and paints a
       false band across the seam (a visible horizontal line at every boundary).
       There is a dedicated test for exactly that.
       Stencil is written through a Uint32Array view (one 32-bit store per pixel)
       and BakeScratch owns both canvases + both ImageDatas — nothing allocates per
       bake. No getImageData anywhere in the bake path.
Left for later: visual confirmation of the band happens in T3.07's sandbox, as the
       task file says; the pixel output itself is deliberately not unit tested
       (docs/60-testing.md §7).

## T3.05 — Chunk placement and the rebake budget — DONE
Files: client/src/render/{terrain.ts,terrain.test.ts}
Verified: `npm --prefix client test -- --run terrain` — 10 passed; typecheck clean
Notes: TextureHost/ImageHost interfaces mean the tests never import Phaser, and a
       TerrainDeps injection point (createCanvas + bake) means the whole scheduling
       and lifecycle is exercised in node with no canvas — §A8 applied to a class
       that is mostly bookkeeping.
       Texture keys are `terrain_${generation}_${cx}_${cy}` with a module-level
       generation counter. There is a test asserting ZERO key overlap between two
       consecutive buildAll calls: Phaser's texture manager is global, and a reused
       key leaves the OLD pixels in place so the new map shows fragments of the old.
       destroy() removes every texture and destroys every image; the test asserts
       removed.length == created.length and liveCount == 0. Without it the sandbox
       leaks ~100 MB of canvas per twenty regenerates.
       Pending is a Set (duplicate markDirty collapses), out-of-range ids are
       ignored, and update() sorts by squared distance from the camera so the
       nearest CHUNK_REBAKE_BUDGET bake first.
Left for later: real bake timings measured in T3.07 with the sandbox.

## T3.06 — Camera, backdrop and parallax — DONE
Files: client/src/render/{cameraRig-math.ts,cameraRig.ts,backdrop.ts,cameraRig.test.ts,
       procTextures.ts}, client/src/scenes/PreviewScene.ts, main.ts
Verified: `npm --prefix client test -- --run cameraRig` — 18 passed; check.sh green
          SCREENSHOTS LOOKED AT: shots/m3-overview.png, shots/m3-gameplay.png
MEASURED (medium map, 72 chunks, headless chromium/swiftshader):
       generate 645 ms | buildAll 96-199 ms for 72 chunks | single rebake 1.6-2.9 ms
       Budgets: <400 ms full bake and <4 ms single rebake — both met.
ZOOM VERIFIED BY MEASUREMENT, not by trusting the setting: the PLAYER_W x PLAYER_H
       (16x28) marker measures 32x56 SCREEN px at gameplay zoom = exactly 2x, and
       __game.debug() reports visible {w:640,h:360}.
Notes: SKY IS A FLAT PLACEHOLDER on purpose — §A4/T3.12 owns the real five-phase sky
       and writing a gradient here would mean writing it twice.
       THREE VISUAL DEFECTS FOUND BY LOOKING AT SCREENSHOTS, none of which any unit
       test would have caught:
       1. My procedural tile was not seamless (sampled an unwrapped lattice), so the
          fill drew a visible 256 px grid across the whole map. Fixed with a
          wrapping lattice.
       2. The sky placeholder was VIEWPORT-sized with scrollFactor 0, so at zoom < 1
          it covered only part of the screen and the rest was the clear colour —
          the overview shot was mostly black.
       3. THE BIG ONE: the cave backdrop. A full-map rectangle at depth -10 hides
          the sky everywhere. Stencilling it against the pristine mask leaves the
          GENERATOR's own caves showing sky. The rule that works is
          BackdropMask: coarse grid -> morphological CLOSING (dilate+erode, not a
          plain dilation, which paints a 56 px halo into the sky) -> flood fill from
          the border so large sealed caverns count as interior -> one extra erosion
          so the backdrop sits just inside the rock and does not draw a stepped
          fringe against the sky at 2x zoom.
       The backdrop is baked per chunk, not a scene layer.
Left for later: parallax layer (-20) is not built — nothing to put in it until T7;
       Backdrop currently provides sky placeholder only.

## A10–A12 review fixes + backdrop — DONE
Files: crates/game-core/src/{constants.rs,map/gen/{traversal.rs,caves.rs},map/meta.rs},
       crates/game-core/tests/{golden.rs,golden_hashes.txt,map_sweep.rs},
       client/src/render/chunkBake-math.ts
Verified: 402 lib + golden + 23 client chunkBake tests; check.sh green.
       999-seed sweep under the STRONGER gate: attempts [996,3,0], safe_preset 0/999,
       fraction min 0.760 p50 0.929, cave_reachable 88.0% (honest now). No regression.
Notes: FALSIFY EVERY GATE TEST. My first falsification of the new adversarial masks
       "passed", which looked like the tests were vacuous — actually I had restored
       the wrong old behaviour. The pre-A10 bug was an UNBOUNDED region-union pass
       BEFORE the bucketed pair loop; bucketing at 780 px already caps pairs, so
       removing only the distance check changes nothing. With the real old pass
       restored, 4 of 8 new tests fail. Method: reproduce the ORIGINAL code path,
       not your idea of it.
       BackdropMask: geodesic disc rule (DT from solid -> flood border where a disc
       fits -> DT from that flood; interior = air further than reach away). The old
       coarse closing used a SQUARE kernel = ~100 px axis-aligned rectangles in
       concave corners. A "nothing above the column's first solid pixel" clip is
       WRONG and I reverted it: it paints bright sky down every crevice, since a
       crack open at the top has no rock above it either. Width is the distinction
       and only the disc measures width.
Left for later: T3.07-T3.12 (M3 part B).

## T3.07 — The sandbox scene — DONE
Files: client/src/scenes/SandboxScene.ts, client/src/main.ts,
       scripts/drive.mjs, scripts/checks/sandbox.mjs
Verified: all 8 checks headlessly — `node scripts/drive.mjs scripts/checks/sandbox.mjs`
       generate: small 277 / medium 604 / large 1118 ms; bakeAll 227 ms (72 chunks);
       carve r=42 rebake 1.1 ms, r=200 rebake 2.7 ms; 10 regenerates leak 0 textures.
Notes: `scale` is Phaser.Scene's ScaleManager — naming a field `scale` breaks the
       base class contract with a confusing error. Field is `mapScale`.
       scripts/drive.mjs is the general headless driver (a check file gets {page,
       shot, log}); reuse it for T3.09's WASD proof. It needs playwright-CORE, not
       playwright, which is what client/ actually has.
       A carve check must dig INTO rock: my first version carved 40 px above a spawn,
       removed 80 px of air, and would have passed against a broken carve. It now
       asserts >= 4000 px removed.
Left for later: large-map generate is 1118 ms in the browser (WASM, debug-ish) vs the
       <1000 ms budget in docs/60 §6 — that budget is for native release; revisit in
       T8.05 rather than now.

## T3.08 — Player sprite and animation states — DONE
## T3.09 — Keyboard/mouse input, aim ring, crosshair — DONE
Files: client/src/render/{playerView-math.ts,playerView.ts,playerView-math.test.ts},
       client/src/input/{localInput-math.ts,localInput.ts,localInput-math.test.ts},
       client/src/scenes/SandboxScene.ts, client/src/core/index.ts,
       crates/game-wasm/src/lib.rs, scripts/checks/wasd.mjs
Verified: `npm --prefix client test -- --run playerView` 8 passed;
       `-- --run localInput` 9 passed; check.sh green 3x consecutively.
       WASD DRIVEN THROUGH A REAL BROWSER (scripts/checks/wasd.mjs):
       D x1184->1319 | A x1319->1186 | Space grounded->airborne vy -290, lands
       jetpack y1418->1364 fuel 4.08 moveState 2 | S airborne y1364->1418
       aim right cos>0.5 / left cos<-0.5 with the camera at (1184,1356)
Notes: PHASER FIELD-NAME COLLISIONS BIT ME TWICE: `scale` is ScaleManager and
       `input` is InputPlugin. Naming a Scene field either one breaks the base
       class contract with a confusing error. Fields are `mapScale`/`localInput`.
       Button bits + AIM_DEADZONE + quantize/dequantize_angle now cross the WASM
       boundary (constants_json + two exported fns). The client must never own a
       copy of the wire layout.
       THE SOCKET ECHO FLAKE WAS REAL, NOT LOAD. `#[tokio::test]` is a
       CURRENT-THREAD runtime, so the spawned axum server shares one thread with
       the test future; game-core's minute-long map tests saturate every core and
       starve it mid-handshake. Fixed at the cause with
       `flavor = "multi_thread", worker_threads = 2`. I had first bumped the
       timeout 5s->30s and it failed again at 30s — the bigger timeout was the
       wrong instinct and hid the cause.
       A movement check must read game-core's body, not the sprite: a sprite can
       move for reasons unrelated to input.
Left for later: T3.10 lightmap, T3.11 overlays, T3.12 sky.

## T3.12 — Five-phase sky, sun, moon, stars — DONE
Files: client/src/render/{sky-math.ts,sky-math.test.ts,sky.ts,backdrop.ts},
       client/src/scenes/SandboxScene.ts, crates/game-wasm/src/lib.rs,
       scripts/checks/sky.mjs
Verified: `npm --prefix client test -- --run sky-math` 16 passed.
       `node scripts/drive.mjs scripts/checks/sky.mjs` — measured sky rgb:
       morning (102,122,160) day (97,158,216) evening (121,95,119) night (29,16,46);
       day luminance 149 vs night 21; all four phases visually distinct.
Notes: TWO THINGS DREW THE SKY. Backdrop's flat placeholder sat at DEPTH.sky and was
       re-created on every regenerate, so it was always added last and painted over
       the real gradient. Backdrop no longer draws anything; it is the depth table.
       §A4's keyframe table had a gap: 0.92 (near black) straight to 0.0 (bright
       sunrise) put all of dawn in 9 s and stepped visibly. Added a 0.96 keyframe
       and recorded it in the doc. Interpolation is in LINEAR rgb, which is why the
       step was worst near black.
       gl.readPixels on Phaser's canvas returns ZEROS — the drawing buffer is not
       preserved. Measure colour from an actual screenshot decoded through a 2D
       canvas; that is also what a person would see.
       constants_json outgrew serde_json::json!'s macro recursion limit at ~40 keys.
       It builds a Map now, so adding a constant cannot break the ones above it.
Left for later: T3.10 lightmap, T3.11 overlays.

## T3.10 — Lightmap, day/night, fog — DONE
## T3.11 — F4 overlays and perf counters — DONE
Files: client/src/render/{lightmap-math.ts,lightmap.ts,lightmap-math.test.ts,
       debugOverlay.ts}, client/src/scenes/SandboxScene.ts,
       crates/game-wasm/src/lib.rs, scripts/checks/lightmap.mjs
Verified: `npm --prefix client test -- --run lightmap` 8 passed.
       `node scripts/drive.mjs scripts/checks/lightmap.mjs`:
       day darkness 0.00 LIGHTMAP DRAWS 0 corner lum 157
       night darkness 0.82 fov 220 draws 1 corner lum 20 centre lum 58
       fog fov 220 -> 99 | F4 overlays on
Notes: The daylight skip is asserted as draws == 0, not as "looks the same" —
       docs/14 §7 asks for exactly that and it is the difference between a free
       layer and one that costs a full-screen fill every frame.
       Gradient + cone textures are generated ONCE at construction and one reusable
       Image is re-positioned per source. A gradient per light per frame is the
       obvious way to write this and it halves the frame rate.
       DebugOverlay gates buriedSlots on the SCENE (a constructor arg), not on the
       flag: buried positions are never sent to clients (docs/32 §5), and a flag
       someone can flip is not a guarantee.
       Overlays live at depth 55, ABOVE the lightmap, or they are invisible at
       night — which is when you need them most.
Left for later: M3 is complete. M4 next.

## A13-A16 review fixes — night visibility — DONE
Files: docs/70-amendments-v2.md (A16), crates/game-core/src/constants.rs,
       client/src/render/{sky-math.ts,sky-math.test.ts,lightmap.ts,
       lightmap-math.test.ts,chunkBake-math.ts,chunkBake.test.ts,terrain.ts},
       client/src/scenes/SandboxScene.ts, scripts/check.sh,
       scripts/checks/night_darkens_the_world.mjs
Verified: check.sh green INCLUDING the new browser check. 24 chunkBake, 22 sky-math,
       8 lightmap-math. night_darkens_the_world: near 101%, mid 21%, far 22%,
       lit radius 181 px vs 220 asked.
Notes: THE REAL CAUSE WAS §A16, NOT THE LIGHTMAP. FOV_DAY/FOV_NIGHT/FLASHLIGHT_RANGE
       are world-px radii authored when the viewport showed 1280x720 WORLD px. §A1
       set CAMERA_ZOOM 2, so the viewport shows 640x360 and every FoV covered twice
       the screen fraction intended: the night pool was 440 screen px on a 1280x720
       screen. Every number was right except the one nobody stated — the radius
       RELATIVE TO WHAT IS ON SCREEN. Halved all three.
       MY FIRST VERSION OF THE TEST PASSED AT THE OLD VALUE. near-vs-far is
       identical (101%/22%) whether the pool is 220 or 440 px; only a MID band
       (250-400 px) discriminates: 21% fixed vs 79% broken. A test for a
       "too much of X" bug needs a sample point inside the region that changes.
       Phaser's RenderTexture.erase(obj,x,y) does not carry the object's scale
       reliably; the lightmap is a 2D canvas (fill + destination-out) at half res,
       counter-scaled against camera zoom. The old RT version was also wrong at
       zoom != 1 (double-applied zoom).
       Backdrop floods from the SKY only (y < SKY_MARGIN), never all four borders.
       Falsified: restoring border seeding fails the new cavern test.
       stats.filled (fill executed) replaces drawsLastFrame for the daylight-skip
       assertion; drawsLastFrame counts intent, not effect.
Left for later: M4 part A (T4.01-T4.07) not started.

## T4.01-T4.07 — M4 part A: items — DONE
Files: crates/game-core/src/items/{mod,registry,inventory,world,spawning}.rs,
       crates/game-core/src/physics/{body,resolve}.rs (Body gains `size`)
Verified: `cargo test -p game-core --lib items` — 63 passed. check.sh green
       (including the browser night check). Workspace 465 lib tests.
Notes: DEVIATION — T4.03 says "touch only items/world.rs" but also "reuse the M2
       resolver, do not write a second integrator". The resolver was hardcoded to
       PLAYER_W x PLAYER_H, so Body gains a `size: Vec2` (defaulting to the player
       AABB) plus `Body::sized`. Items are 16x16 and crates CRATE_W x CRATE_H and
       go through the SAME integrate(). Writing a second path would eventually let
       an item fall through terrain a player cannot walk through.
       BUG FOUND BY THE CAP TEST: cull() evicts only while len > MAX, so at exactly
       MAX it did nothing and the next spawn landed on MAX+1. Added make_room(),
       which is what a caller about to add an item actually needs; cull() keeps
       meaning "enforce the cap". Enforcing a cap and freeing a slot are not the
       same operation.
       BOTH LOAD-BEARING TESTS FALSIFIED. Removing the is_standable re-validation
       fails a_periodic_spawn_lands_on_ground_that_is_still_there; replacing the
       buried-reveal disc test with a bounding box fails
       a_carve_over_a_slot_reveals_it_and_one_pixel_short_does_not.
       PICKUP_RADIUS STAYS A GAMEPLAY NUMBER (20 world px, 40 screen px at zoom 2).
       Unlike the FoV radii in A16 it does not govern what you can SEE, it governs
       where your body must be — the player judges it against their own sprite,
       which scales with the zoom, so the relationship is already zoom-invariant.
       Do not scale it if CAMERA_ZOOM changes. Same reasoning for SPAWN_MIN_ENEMY_DIST
       and the blast radii: all gameplay distances, all zoom-invariant. AIM_RADIUS
       and MINIMAP_REVEAL_R are the perceptual ones and would need restating.
       SpawnSchedule::new takes `initial_draws` to fast-forward the "items" stream
       past place_initial, so both share one stream in a fixed order (docs/32 §7).
Left for later: M4 part B (T4.08-T4.15).

## T4.08-T4.15 — M4 part B: combat — DONE
Files: crates/game-core/src/weapons/{mod,defs,projectile,explode}.rs,
       crates/game-core/src/player/state.rs, crates/game-core/tests/combat.rs,
       crates/game-wasm/src/lib.rs (combat API), client/src/render/{ordnance-state,
       ordnance}.ts, client/src/scenes/SandboxScene.ts, scripts/checks/{m4-checkpoint,
       night-combat}.mjs
Verified: `cargo test -p game-core --test combat` 29 passed; ordnance-state 6 passed;
       check.sh green. M4 CHECKPOINT DRIVEN HEADLESSLY: crater 2910 px, self-damage
       100 -> 75.3, ammo 4 -> 3, inventory opens on right-click, smg draws a tracer
       and digs 16 px. Night: rocket in flight emits light (draws 1 -> 2).
Notes: PROJECTILES TUNNELLED ON THE FIRST ATTEMPT, exactly as M2's bodies did. I
       recomputed the substep split locally instead of calling physics::substeps,
       and at 10x terminal velocity a "substep" was 2.34 px, so a rocket went
       through a 1 px wall. Now it calls substeps() — the shared one keeps the step
       at 1 px and travels LESS FAR when the cap binds. Do not re-derive that split.
       fire_ready_at is per PLAYER, not per weapon, so swapping weapons cannot
       bypass a cooldown. Noticed while writing the night check.
       The sandbox loadout is granted in regenerate(), not create(): regenerate
       recreates the player, so granting once silently disarmed you on every
       regenerate.
       A tracer lives 90 ms, shorter than a Playwright screenshot round-trip. To
       photograph one, drive sustained fire from inside the page with setInterval.
Left for later: M4 review items (world-item grounded-after-carve, §A17 backdrop,
       3 minors).

## M4 review fixes: A17/A18 backdrop, item support, 3 minors — DONE
Files: client/src/render/{chunkBake-math.ts,chunkBake.test.ts,backdrop-real.test.ts,
       lightmap.ts,cameraRig.ts,terrain.ts}, crates/game-core/src/items/world.rs,
       crates/game-core/src/physics/body.rs, crates/game-core/src/constants.rs,
       crates/game-wasm/src/lib.rs, docs/70-amendments-v2.md (A18)
Verified: check.sh green. backdrop-real 3 passed; chunkBake 24; items::world 16.
Notes: MAJOR 1 — items early-returned on `grounded` forever, so anything standing on
       ground that got blown away hung in mid-air. docs/32 §4 says the opposite in
       as many words. step() now re-probes support across the item's FOOTPRINT (not
       its centre, so an item on a crater lip goes too). Falsified: restoring the
       unconditional early-out fails both new tests.
       A17/A18 — THE REAL-TERRAIN TEST IS THE WHOLE LESSON. BackdropMask had only
       ever been tested against a synthetic FakeMask, and it caught all three
       remaining defects on first run. Anything whose failure mode only exists in
       real terrain gets a test against real terrain.
       TAKE A CONTROL WHEN A METRIC LOOKS DAMNING. "88% of boundary transitions sit
       on the cell grid" was real, but I only knew because the same metric on the
       raw terrain silhouette — which is noise and cannot be grid-aligned — read
       52%. My FIRST alignment metric (run length) was measuring how flat the map
       is, not grid snapping; the control is what exposed that.
       The snapping cause: integer ray counts against an integer threshold put the
       bilinear crossing EXACTLY on the cell edge. Centre-weighted 3x3 blur first.
       A18: no minHits satisfies both of A17's bounds (4 -> 0.0%/7.3%,
       5 -> 0.9%/2.5%, 6 -> 4.4%/0.7%). Chose 5 and documented the trade: enclosed
       air showing daylight is the recurring, confusing failure; sky drawn dark
       reads as haze.
Left for later: M5. Buried-slots-not-sent-to-clients verified at T6.04.

## T5.01 — The effect scheduler — DONE
Files: crates/game-core/src/effects/{mod,scheduler}.rs, crates/game-core/src/lib.rs
Verified: `cargo test -p game-core scheduler` — 15 passed
Notes: SPEC CONTRADICTION in docs/13 §1: "never repeat the same effect twice in a
       row" and "re-roll once if it comes up again" are incompatible — re-rolling
       once still repeats with probability w_i/total, measured at 9% per step for
       the weight-3 kinds, so over 1000 effects a repeat is certain. Fixed by
       zeroing the last kind's weight and drawing ONCE: repeats impossible by
       construction, and a single draw from the remaining weights is exactly the
       conditional distribution, so it is unbiased. (The task file's warning is
       about a re-roll LOOP; this is not a loop.) Stationary distribution is
       0.284/0.284/0.216/0.216, not the raw 0.30/0.30/0.20/0.20 — the test asserts
       the former AND that the shares are distinguishable from the latter, so it
       cannot pass against an implementation with no rule at all.
       MY OWN ANTI-DRIFT TEST WAS VACUOUS. At 60 Hz, `next_at = now + interval`
       and `next_at += interval` differ by half a tick per interval — invisible.
       Falsification caught it. The replacement ticks the same seed at DT and at
       0.5 s and requires identical schedules; it fails against the bug.
Left for later: T5.02 onward.

## T5.02 — Toxic rain — DONE
Files: crates/game-core/src/effects/{toxic,mod}.rs
Verified: `cargo test -p game-core toxic` — 10 passed
Notes: The first puddle lands on the FIRST ACTIVE TICK, not one cadence in.
       Waiting a cadence puts the 20th spawn at exactly t=TOXIC_DURATION, i.e.
       outside the active window, and the count comes out 19.
       A TEST THAT PREDICTED WHERE A PUDDLE WOULD LAND was wrong: pick_position
       reads player positions to bias toward their half, so a second run with the
       player moved does not reproduce the first run's placement. The test now
       teleports the player onto whichever puddle actually spawned.
       Falsified both defining properties: carving during the effect fails the
       mask test; PLAYER_HALF_BIAS=0 fails the bias test (mean x 1138 vs mid 1024).
       Overlapping puddles stack deliberately (docs/13 §3) — not deduplicated.
Left for later: T5.03 onward.

## M4 review batch: A19 structural, A20, substep guard — DONE (A19's VALUE NOT ADOPTED)
Files: crates/game-core/src/{constants.rs,weapons/explode.rs,items/world.rs,
       physics/resolve.rs}, crates/game-core/tests/combat.rs,
       crates/game-wasm/src/lib.rs, client/src/render/{chunkBake-math,chunkBake.test,
       backdrop-real.test}.ts, client/package.json
Verified: game-core 498 + combat 32 + scenarios 19; client 135 across 11 files.
Notes: A20 DONE. explode() now takes a BlastSource from the caller instead of
       hardcoding Weather(MeteorShower) for every ownerless blast — lava and toxic
       would otherwise both have read "meteor" in the kill feed. It records only
       damage apply_damage ACCEPTED (i-frames refuse it), and drops the zero-value
       entry at d == radius. Falsified both.
       SUBSTEP GUARD ADDED. no_other_substep_derivation_exists reads the crate
       source and fails if MAX_SUBSTEP_PX/MAX_SUBSTEPS appear outside resolve.rs.
       Falsified by re-deriving the split in projectile.rs. Same bug had already
       happened twice; a comment is not a guard.
       A19's STRUCTURE ADOPTED, ITS VALUE NOT. minHits lost its default, tests pin
       to C().BACKDROP_MIN_HITS, acceptance covers all three scales. But 4 does not
       reproduce: re-measured against a FRESHLY BUILT wasm (see below), no value
       passes both bounds everywhere —
         value | small/777      | medium/4242 | large/99        (enc-as-sky/sky-as-bd)
           4   |   -- / 19.2%   | pass / 7.3% |   -- / 7.3%
           5   |   -- /  9.6%   | pass / pass |  2.9% / --
           6   |  4.4% / --     | pass / pass |  7.2% / --
       Kept 5 (shipped value, least-bad). Bounds now: tight where achievable, a
       documented loose REGRESSION ceiling elsewhere, with the table in the test.
       ROOT CAUSE OF THE DISAGREEMENT: there was no `pretest` hook, so vitest ran
       against whatever wasm was last built — a Rust constant change was invisible
       to the client suite. I hit this myself (4/5/6 gave byte-identical results).
       Added pretest = the predev wasm build. A19's table was almost certainly
       measured stale.
       KNOWN DEFECT, PINNED NOT HIDDEN: a backdrop halo along exposed crests.
       Measured on REAL terrain over exposed crests only (topmost rock with 200px
       clear up and both diagonals, so a canyon roof is not mistaken for a halo):
       mean overhang 30.2/21.3/14.9px at minHits 4, 3.4/6.3/5.8px at 5,
       0.3/0.5/0.5px at 6 (small/medium/large). Cause: near a crest the three
       downward rays alone reach any workable total. PROPOSED FIX, measured but
       NOT adopted (design call): require >=1 UPWARD hit as a conjunct — takes the
       halo 30.2 -> 3.3px, and unlike roofedness alone (A17 rejected it) cannot
       misclassify air under a floating island, which has too few total hits.
       Two synthetic chunkBake tests were pinned at a hardcoded 6 and fail at the
       shipped 5; bounds raised to regression ceilings with the cause documented.
Left for later: T5.03 onward. Backdrop classifier redesign is with the authority.

## T5.03 — Meteor shower — DONE
Files: crates/game-core/src/effects/meteor.rs, .../items/registry.rs (2 weapon ids),
       .../weapons/defs.rs (2 defs)
Verified: `cargo test -p game-core meteor` — 12 passed
Notes: DEVIATION: added WEAPON_METEOR / WEAPON_METEOR_FRAG to the weapon table
       (registry.rs + defs.rs, outside the task's Touch-only). The task offered
       "a weapon id or an explicit flag"; the ids mean meteors reuse the whole
       projectile path — gravity, sub-stepping, player AABB — with no parallel
       simulation to drift. Never in the item registry, so uncarryable.
       I REPRODUCED THE FORK BOMB BY ACCIDENT. My run_shower harness guessed
       is_fragment from the projectile id instead of its weapon, got it wrong for
       every impact, and the test hung: 6 -> 36 -> 216. The weapon must be read
       BEFORE step(), which removes the projectile as it reports the outcome.
       Falsified: allowing recursion gives "generation two produced 36 more".
       TEST FIXTURES MUST NOT CALL generate(). Building solid_map() via
       Map::from_parts took this module from >10 min to 0.02 s in debug. The
       generator was being run ~18 times for maps whose shape did not matter.
       Also: H=512 with BEDROCK_H=24 makes y=500 indestructible — two carve tests
       were silently aiming into bedrock and measuring nothing.
Left for later: T5.04 onward.

## T5.04 — Lava bursts and carve_capsule — DONE
Files: crates/game-core/src/map/carve.rs (carve_capsule + 6 tests),
       crates/game-core/src/effects/lava.rs
Verified: `cargo test -p game-core capsule` — 9 passed; `... lava` — 8 passed
Notes: carve_capsule stamps the shared circle() along a Bresenham walk ONE PIXEL
       AT A TIME, so it inherits bit-exactness, bedrock/wall clamping, coarse
       maintenance and buried reveal instead of reimplementing them.
       MY FIRST FALSIFICATION OF THE GAP TEST WAS NOT A BUG. Stepping r px between
       stamps of radius r still overlaps (r < 2r), so the test correctly passed. A
       genuine gap needs step > 2r; at 2r+2 the test fails with "gap on the sweep
       line at (125,124)". Worth remembering: a falsification that does not break
       the property proves nothing about the test.
       Vent clock is re-based on the tick the vent actually OPENS, not on
       construction, so a telegraph of a different length cannot shift the jet or
       burn windows. Falsified the timeline: doubling burn_until gives 69.9 total
       against the expected 54.
       Vent placement is rejection-sampled with a hard 200-attempt cap — on a
       small or heavily carved map the 200px separation can be unsatisfiable, and
       looping until satisfied would hang the tick.
Left for later: T5.05 fog, T5.06 cycle, T5.07 flashlight.

## T5.05 + T5.06 — Heavy fog, the cycle and the FoV formula — DONE
Files: crates/game-core/src/effects/fog.rs, crates/game-core/src/world/{mod,cycle}.rs,
       crates/game-core/src/lib.rs
Verified: `cargo test -p game-core fog` — 6 passed; `... cycle` — 11 passed;
       `... fov` — 12 passed
Notes: T5.06 implements the A13 curve, NOT docs/14 §1's. The task file's own
       tests (darkness == NIGHT_DARKNESS at t=64) are superseded: at t=64,
       u=0.533 and darkness is ~0.16. There is a named regression test asserting
       t=64 is NOT full night, which fails if the old CYCLE_TRANSITION curve
       comes back.
       cycle_matches_the_client transcribes the TS darknessAt and sweeps 2000
       points against the Rust one. That is the guard against the two copies
       drifting — and it is what caught the falsification when I restored the old
       curve, before the phase-table test did.
       fov_radius is the single authority; the TS copy in lightmap-math.ts is for
       rendering and is pinned by the same cross-check style.
       HeavyFog holds no RNG and no map — a pure timer, so the client can compute
       strength locally from the start time with no per-tick updates.
Left for later: T5.07 flashlight + sandbox effect controls, then the M5 checkpoint.
