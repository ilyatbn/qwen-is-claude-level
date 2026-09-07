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

## T5.07 — Flashlight, light sources and the M5 checkpoint — DONE
Files: client/src/render/{lightmap-math.ts,lightmap-math.test.ts},
       client/src/core/index.ts, client/src/scenes/SandboxScene.ts,
       crates/game-wasm/src/lib.rs, scripts/checks/m5-weather.mjs
Verified: `npm --prefix client test -- --run lightmap-math` — 19 passed;
       `node scripts/checks/m5-weather.mjs` — 15/15 checks; check.sh green
       (146 client tests, full Rust workspace).
Notes: fovRadius now takes fogMult (a number), not fogActive (a boolean). Fog
       ramps over FOG_RAMP, and a boolean snapped the whole field of view between
       two values at the ramp edges.
       THE RUST FoV IS NOW CROSS-CHECKED FROM THE CLIENT. core_fov_radius and
       core_darkness_at are exposed from wasm purely so a test can sweep 150
       combinations against the TS copies and fail on drift. Falsified: changing
       the TS flashlight multiplier to 0.75 fails it. This is the guard docs/01
       asks for and it did not exist before.
       Remote players' flashlight cones are in collectLightSources and have their
       own named test — omitting them silently removes the entire trade that
       makes the item a decision.
       THE SANDBOX NEEDS TWO CLOCKS. The day/night slider FREEZES roundTime so a
       phase can be inspected; the scheduler's double-tick guard then correctly
       refuses to advance and every forced effect telegraphed forever. weatherTime
       always advances. In a real round they are one clock — noted at the seam.
       A SCREENSHOT THAT DOES NOT CONTAIN ITS SUBJECT IS NOT EVIDENCE. The first
       lava run photographed an empty hillside while three vents erupted
       off-screen; the check now moves the player to a hazard before shooting.
       Also: the checkpoint tracks the effect ID it forced, not the kind — the
       real scheduler runs alongside and may roll the same kind, which is legal
       overlap (docs/13 §1), and my first version failed on it.
Left for later: M6. Backdrop halo + classifier redesign still with the authority.

## A21: the backdrop conjunct, and tracer visibility — DONE
Files: crates/game-core/src/constants.rs, crates/game-wasm/src/lib.rs,
       client/src/core/index.ts, client/src/render/{chunkBake-math,terrain,
       ordnance,ordnance-state}.ts + their tests, scripts/checks/night-combat.mjs
Verified: chunkBake 24 + backdrop-real 9 + ordnance-state 7; check.sh green (147
       client tests). night-combat.mjs exit 0.
Notes: BACKDROP_MIN_HITS 4 + new BACKDROP_MIN_UP 0.5. Full table, fresh wasm,
       all three scales (enc-as-sky / sky-as-backdrop / crest halo):
         4/0.5  0.00/16.42/3.3   1.42/5.86/4.7   2.49/7.18/3.9
         4/1.0  0.01/14.97/0.7   2.76/5.41/1.8   3.65/6.84/1.4
         5/1.0  0.02/ 9.20/0.7   2.78/2.36/1.3   4.74/2.43/0.9
         6/any  0.31/ 2.69/0.3   4.43/0.73/0.5   7.25/0.47/0.5
       No row passes both bounds everywhere, so per A21 took the milder failure:
       4/0.5 has the lowest worst-case enclosed-as-sky (2.49%). Residual
       sky-as-backdrop is air under a floating island's FLANK, reached by a
       DIAGONAL upward ray while the column overhead is clear — worst at small
       scale, which packs six islands into a small sky.
       THE TWO SYNTHETIC HALO TESTS ARE BACK AT THEIR ORIGINAL BOUNDS (4px, 40px)
       rather than the ceilings I pinned last session: measured 4px and 17px with
       the conjunct, against 13px and 143px without. A ceiling around a fixed bug
       guards nothing. Falsified: removing the conjunct gives 37px and 177px.
       TRACERS WERE NEVER FAILING TO DRAW. They render at DEPTH.particles 40,
       above terrain — but the lightmap MULTIPLIES at depth 50, so at darkness
       0.82 a white line became ~RGB 46 against RGB 20 terrain. The fix is that a
       tracer LIGHTS ITS OWN PATH (6 samples along the segment) plus a brighter
       muzzle light, so the beam carves its own hole instead of being dimmed by
       the dark it is meant to be visible in. Proof: shots/night-tracer-proof.png,
       13521 near-white px, lightmap draws 9.
       A 0.09s tracer is shorter than a screenshot round-trip, so the check
       froze decay (holdTracers, debug-only) before capturing — third instance
       now of "the screenshot did not contain its subject".
       PROJECTILE SIZE DOES NOT REPRODUCE: drawn in WORLD space at r=3 (bazooka,
       6px across) and r=7 (meteor) against a 16x28 player, so it scales with
       CAMERA_ZOOM correctly and is if anything small. Left alone.
Left for later: M6 part A.

## T6.01 — World::step, the ordered tick — DONE
Files: crates/game-core/src/world/mod.rs, tests/world_step.rs,
       weapons/{projectile,explode}.rs, map/carve.rs, effects/meteor.rs,
       tests/combat.rs, game-wasm/src/lib.rs, client/src/render/chunkBake-math.ts
Verified: `cargo test -p game-core --test world_step --release` — 17 passed;
       full crate 542+32+19+17 passed, clippy -D warnings clean.
Notes: SPAWN PLACEMENT WAS ORDER-DEPENDENT and the spec's own test caught it.
       add_player used choose_respawn, which avoids already-seated players, so a
       lobby filling 1,2,3 diverged from one filling 3,2,1 — a replay would
       reproduce a different round. Before Playing, the spawn is now keyed by
       PLAYER ID into MapMeta.spawn_points (farthest-point sampled, >= MAX_PLAYERS
       of them, so still well separated). Mid-round joins keep choose_respawn:
       that IS order-dependent and correctly so, since a join is an input to the
       round, recorded with its tick.
       THE WARMUP DAMAGE GATE DID NOT EXIST, and my first test PASSED against a
       build with no gate at all — SPAWN_IFRAMES refuses all damage for 2 s, so
       the test proved nothing. It now outlasts the i-frames and has a control
       half (a_rocket_at_your_own_feet_hurts_you) asserting damage DOES land while
       Playing. Without the control, "warmup does no damage" is satisfied by a
       build that does no damage ever. The gate itself is one early-return in
       apply_damage_log, which every damage source funnels through.
       Falsified: reversed pickup order fails the tie test; order-dependent spawn
       fails the hash test; removing the gate fails warmup and not the control.
       Projectiles::step now returns `Impact { id, weapon, owner, outcome }` — it
       removes the projectile before returning, so looking the weapon up
       afterwards is impossible and every caller had to snapshot it. That trap
       already produced a fork bomb in M5. Two call sites got simpler.
       carve_capsule clamps endpoints in i64 BEFORE (x1-x0).abs(), which panicked
       in debug and silently collapsed the sweep in release on i32::MIN. Also
       bounds the Bresenham cost by construction (was 103 ms for a far endpoint).
Left for later: stamp_capsule (float, r/2 steps) and Map::carve_capsule (integer,
       1 px) are still two capsule geometries. Unifying changes generated maps, so
       it needs its own commit plus a golden regeneration and a sweep re-run.

## T6.02 — Room task, command channel and tick loop — DONE
Files: crates/game-server/src/{room,events,lib}.rs, tests/{room,room_logging}.rs,
       crates/game-core/src/{player/state,world/mod}.rs, tests/{world_step,combat}.rs
Verified: `cargo test -p game-server --test room` — 7 passed; `--test room_logging`
       1 passed; lib 21; workspace green, clippy -D warnings clean.
Notes: SPAWN POINTS ARE FEET LINES, NOT BODY CENTRES, and World got it wrong.
       is_standable(x,y) means "the box whose BOTTOM EDGE is at y fits", so
       Body::new(spawn_point) buries the lower half in rock. The player is alive,
       grounded and at a plausible position — and simply cannot move, because
       every horizontal step already overlaps solid and step-up cannot clear it.
       Nothing but asking them to walk detects it. choose_respawn now returns a
       CENTRE (surface_to_centre does the conversion, documented at the seam);
       the M4 respawn test had been compensating by hand, which is what let the
       convention stay implicit. Falsified both ways.
       MY TEST WAS WRONG BEFORE THE CODE WAS, twice. Asserting on vel.x 200 ms
       after the last input reads 0 whether or not input arrived — GROUND_FRICTION
       zeroes it in ~0.1 s; displacement is the honest observable. And the span
       test measured a fixed 250 ms window that was almost entirely World::new
       generating the map, so it saw one tick and one span; it now waits for the
       room to be live first.
       THE LOGGING TEST NEEDS ITS OWN BINARY. Observing the real task's spans
       needs set_global_default (once per process); a thread-local with_default
       does not reach a tokio::spawn'd task on another worker, so it observes
       nothing and passes for the wrong reason.
       RoomHandle::inspect(closure) is the test seam — the world is reachable only
       through the channel, so tests never hold a reference to it.
Left for later: Room::new generates the map inline, blocking a tokio worker for
       ~0.6 s at startup (longer in debug). Fine before the loop starts, but
       spawn_blocking would be tidier. T6.03 wires real sockets to Command.

## T6.04 + T6.05 + T6.06 — the binary codecs — DONE
Files: crates/game-server/src/codec.rs, client/src/net/codec.ts + codec.test.ts,
       crates/game-core/src/constants.rs, crates/game-wasm/src/lib.rs,
       client/src/core/index.ts
Verified: `cargo test -p game-server --lib codec` — 20 passed;
       `npm test -- --run src/net/codec.test.ts` — 20 passed.
Notes: docs/40 §3's SNAPSHOT BLOCK IS INTERNALLY INCONSISTENT, twice, and the
       field lists win over the totals. The header list (u32 tick, u16
       round_time_ds, u8 darkness, u8 player_count) sums to 8 while the doc
       totals it as 9; the per-player list (u8 id, 4x i16, u16 aim, 4x u8) sums
       to 15 while the doc and SNAPSHOT_PLAYER_BYTES say 14. Hitting 14 means
       dropping a field the client needs — velocities are required to extrapolate
       through a dropped snapshot (docs/42 §4) and aim is fixed at u16 by
       docs/22 §2. SNAPSHOT_PLAYER_BYTES is now 15, with SNAPSHOT_HEADER_BYTES
       and SNAPSHOT_FOOTER_BYTES beside it, and the size tests assert against the
       constants rather than literals so the two cannot drift. A six-player
       snapshot is 102 bytes, not 97: 2.0 KB/s down at 20 Hz, well inside the
       docs/40 §4 budget. THIS NEEDS A DOC AMENDMENT — I cannot edit docs/.
       THE ANTI-WALLHACK TEST IS REAL: it searches the whole map_init payload for
       each buried slot's packed (x,y) and fails if any appears. Falsified by
       appending the slots — "buried slot Point { x: 524, y: 557 } is recoverable".
       `npx vitest` BYPASSES THE pretest HOOK, so it silently tested a stale wasm
       and every new constant read NaN. Use `npm test --`. Same §A22 trap, new
       guise: a freshness hook only covers the entry points that trigger it.
       The client fuzz test asserts the thrown error is a CodecError specifically
       — a TypeError from an unchecked index or a RangeError from a huge
       allocation is the bug it exists to catch, and `expect(...).toThrow()`
       would accept both.
Left for later: T6.03 (join flow) and T6.07 (event scoping) are the two unticked
       M6 boxes. T6.07's `inventory` reaches only its owner and `damage` only the
       victim and attacker — events.rs currently broadcasts nothing at all, it is
       a skeleton with a flush() that drops events on the floor.

## M6 part A — IN PROGRESS (T6.03 and T6.07 remain)
Done and committed: T6.01 (4c831ef), T6.02 (047cc17), T6.04+T6.05+T6.06 (cec9b9e).
Not started: T6.03 join/ready/welcome, T6.07 event emission and delivery scoping.
On disk: compiles, `./scripts/check.sh` green, working tree clean, 77/101 ticked.

Next session starts at T6.03. What is already in place for it:
  - `RoomHandle::join(name, skin_id) -> Option<PlayerId>` awaits the seat and
    returns None when full; `Command::Ready/Leave` are wired; ids are reused from
    a free list; unready seats are swept after READY_TIMEOUT (30 s).
  - `codec::encode_map_init` is ready to send after `welcome`.
  - `app.rs` still has the M0 echo handler on the namespace — T6.03 replaces it.
  - `session.rs` does not exist yet.
T6.07's `events.rs` is a SKELETON: `flush()` takes the events and drops them on
the floor. Nothing is broadcast yet, so no client can see a carve. The scoping
rules are the point of the task — `inventory` to its owner only, `damage` to the
victim and attacker only, everything else to everyone.

Two things carried forward that nothing checks yet:
  - buried slots must not reach a client before reveal. The map_init half is
    tested (see cec9b9e); the event half needs T6.07.
  - SNAPSHOT_PLAYER_BYTES is 15 in constants.rs against 14 in docs/02 and
    docs/40 §3. Needs a doc amendment from the authority.

## T6.03 + T6.07 — join flow and event scoping — IN PROGRESS
Files: crates/game-server/src/{session,events,room,app,codec,main,lib}.rs,
       tests/{join,skeleton}.rs
Verified: `cargo test -p game-server` — 57 lib + 7 room + 1 room_logging + 3
       skeleton, all green, 1 ignored. clippy -D warnings and fmt clean.
NOT TICKED: the end-to-end join test is ~50% flaky, so neither box is done.

RAW BINARY ATTACHMENTS DO NOT SURVIVE THIS STACK. docs/40 §3 specifies map_init
and snapshot as socket.io binary attachments. A payload containing 0x1e —
engine.io's packet separator — corrupts the stream: the client then receives
NOTHING further on that socket, not even later plain-text events, so it reads as
a dead connection rather than a dropped message. A real Small map's map_init is
13,491 bytes containing 48 separator bytes, so this is not an edge case, it is
every map. Isolated repro: vec![7u8; 13433] arrives fine, the real bytes do not,
and vec![0x1e; 64] loses even the text event sent before it. Forcing
websocket-only fails identically, so it is not the polling transport alone.
Both payloads are now base64 text (codec::b64_encode, with the reasoning in its
doc comment). Costs a third: map_init ~13KB -> ~18KB once per round, a six-player
snapshot 102 -> 136 bytes (2.7 KB/s at 20 Hz), both far inside docs/40 §4.
THIS NEEDS A DOC AMENDMENT — I cannot edit docs/.

Two other real bugs fixed on the way:
  - Room::new generated the map on a tokio worker (the flagged issue). Now
    Room::new_async via spawn_blocking. The symptom was not "slow startup": it
    was a client whose join round-trip never completed.
  - Snapshots were sent to seated-but-not-ready players, so the 20 Hz binary
    stream started DURING the join handshake and raced the map_init attachment.
    last_seqs() is now ready-gated, which is what docs/40 §1 says anyway.

THE REMAINING FLAKE, and what is already ruled out. `tests/join.rs` fails ~50% on
"never received welcome within 15s" with an empty inbox. Ruled out: map
generation blocking a worker (fixed); the fixture racing the room (it now polls
until the room is ticking rather than sleeping 400 ms); snapshot/map_init
interleaving (fixed); raw binary (fixed); two servers in one process (verified
fine). Also: all seven original tests passed individually and interfered when run
together, in parallel AND with --test-threads=1, which is why they were
consolidated into one sequential test — a round is sequential anyway.
The test is #[ignore]d with that explanation and IS falsifiable: making
`inventory` broadcast instead of Scope::Only makes it fail.
Run: cargo test -p game-server --test join -- --ignored

Also: M0's echo handler and its test are gone — T6.03 replaced the handler, and
the transport is now proven by the join flow doing something the game needs.
Left for later: the flake; then T6.08-T6.15.

## T6.03 + T6.07 — join flow and event scoping — DONE
Files: crates/game-server/tests/join.rs, scripts/net-smoke.mjs, scripts/check.sh
Verified: `cargo test -p game-server --test join` — 1 passed, **12/12 consecutive
       runs green** (was 1-in-4); `node scripts/net-smoke.mjs 25` — 25/25 joined,
       map_init 17,912 b64 bytes.
Notes: THE FLAKE WAS THE TEST CLIENT, NOT THE SERVER. Establishing that took one
       experiment, and it is the technique worth keeping: run the client that
       actually SHIPS against the same server. node's socket.io-client joined
       100/100 while rust_socketio managed 1-in-4, which located the bug in the
       harness after four server-side hypotheses had been (correctly) eliminated.
       Root cause: `ClientBuilder::connect()` returns when engine.io is up, but
       the socket.io namespace CONNECT is still in flight, and the `join` emitted
       on the next line is dropped WITH NO ERROR. socket.io-client buffers emits
       until connected; rust_socketio does not. `connect()` now blocks on the
       `open` callback.
       A browser probe through the vite proxy fails with
       ERR_BLOCKED_BY_LOCAL_NETWORK_ACCESS_CHECKS when the page is served by
       Playwright's route interception — a harness artifact of the intercepted
       origin, not a product bug. Use node's socket.io-client (same library, no
       display, no proxy, no LNA exemption) — that is what scripts/net-smoke.mjs
       does, and it is now in the gate.
Left for later: the seven original sub-tests are still consolidated into one
       sequential test. Their mutual interference was most likely the same
       connect-race; worth re-splitting if granularity is ever wanted.
       WHY THE #[ignore] WAS CORRECT, AND WHAT RETIRED IT — read this before
       citing it as precedent. It was a HOLDING POSITION, not a verdict, and it
       was allowed only because all four of these held at once:
         1. the test was known-good — falsifiable, and it caught a real bug
            (making `inventory` broadcast instead of Scope::Only fails it);
         2. the failure was in the harness's reliability, not in an assertion
            anyone doubted, and the assertions themselves had passed;
         3. the ignore carried its full diagnosis and the exact command to run
            it, plus every hypothesis already eliminated, so the next session
            started from evidence rather than from scratch;
         4. the boxes were NOT ticked. An ignored test means the task is not
            done. That is the part that makes the rest defensible.
       It was retired one session later by fixing the cause (rust_socketio's
       connect-race), not by loosening the test. An #[ignore] that survives more
       than a session or two has stopped being a holding position and become a
       deleted test that still costs compile time. It is never a licence to
       ignore a test that fails because the code is wrong — that is a red gate,
       and a red gate stops the milestone.

## T6.08 — client net layer — DONE
Files: client/src/net/{connection,worldMirror}.ts + worldMirror.test.ts,
       crates/game-wasm/src/lib.rs, client/src/core/index.ts
Verified: `npm --prefix client test -- --run worldMirror` — 14 passed; typecheck clean.
Notes: THE CLIENT COULD NOT APPLY carve_capsule AT ALL. T5.04 added it to
       game-core but never exposed it through game-wasm, so every lava vent would
       have desynced the mask — invisible until T6.11's checksum started firing.
       Added `carve_capsule` to the wasm shim and `carveCapsule` to Core.
       `connect()` resolves on `welcome`, not on the socket opening: "connected"
       is not "in the game", and a caller that conflates them races the handshake
       the same way A28's harness did.
       MY OWN TEST CARVED EMPTY SKY. Two mask-agreement tests hardcoded (300,300),
       which on a Small map is above the terrain — the carve removed nothing, the
       hash did not move, and the tests failed while the code was right. Same
       species as A22's empty-hillside screenshot. `solidPoint()` now finds rock,
       and the capsule test asserts countSolid actually dropped, so a no-op
       binding cannot pass it.
Left for later: T6.09 prediction is next.

## T6.09 + T6.10 — prediction, reconciliation, interpolation — DONE
Files: client/src/net/{prediction,interpolation}.ts + their .test.ts
Verified: `npm --prefix client test -- --run prediction` — 10 passed;
       `... --run interpolation` — 19 passed; typecheck clean.
Notes: THE RECONCILIATION IDENTITY IS TESTED AGAINST TWO REAL CORES, not a fake.
       One plays the server (applies inputs 1..4), the client predicts 1..12, is
       nudged 40 px off, reconciles at lastInputSeq=4 and replays 5..12; the
       server then applies 5..12 itself. Both land on the same x/y/vx/vy to 4dp.
       A stubbed applyInput would make that trivially true, which is why it uses
       the wasm.
       RENDER SMOOTHING IS FRAME-RATE INDEPENDENT (1 - exp(-k*dt), not a fixed
       per-frame lerp). A fixed lerp corrects ~3x faster at 144 Hz than at 50 Hz,
       so the same correction would feel different per display. Tested by
       comparing 6 steps at 1/60 against 3 at 1/30.
       The naive-aim-lerp falsification is in the file: the same 350°->10° pair
       through a plain lerp lands at 180°, which is the weapon-spin bug.
Left for later: T6.11 checksum is next; the resync path exists client-side
       (WorldMirror.onResyncNeeded) and the server has a resync_map handler.

## T6.11 + review batch (A30, ready-gating, emit ordering) — DONE
Files: crates/game-core/src/world/mod.rs, crates/game-core/tests/world_step.rs,
       crates/game-server/src/{events,session,codec}.rs,
       crates/game-server/tests/checksum.rs
Verified: `cargo test -p game-server --test checksum` — 3 passed (the two-client
       agreement runs 100 real SMG fires and takes 14 s); full game-server suite
       57+3+1+7+1+3 all green; `cargo test -p game-core --test world_step` — 22 passed.
Notes: A30 — a tick now applies EXACTLY ONE input per player, surplus to a
       bounded backlog. MY FIRST TEST FOR IT PASSED AGAINST THE BUG: measuring
       over 60 ticks, both rates walk into the same wall and report the same
       distance. Measured over a SINGLE TICK it is unambiguous — falsified at
       0.5500 px vs 0.1833 px. Sample where the bug is visible.
       EMIT IS NOT ASYNC. `SocketRef::emit` returns Result, not a Future, so the
       `tokio::spawn` per batch was unnecessary — and it was the sole cause of
       cross-tick reordering. All four emit paths are inline now; the ordering
       claim in flush_events' doc comment is finally true. Fifth wrong rationale
       comment on this project.
       Broadcasts are gated on SessionMap::ready, so a mid-round joiner no longer
       drops carves during its map_init and eats a resync two seconds later.
       codec gained `decode_map_init_mask` — encode_map_init had no inverse, so
       nothing could prove it round-trips and the agreement test would have had
       to parse the format a second time.
Left for later: A31 (buried_secret) not done. T6.12-T6.15 remain.

## A31 — buried slots behind a secret — DONE
Files: crates/game-core/src/map/{meta,mod}.rs, crates/game-core/src/world/mod.rs,
       crates/game-server/src/room.rs, crates/game-core/tests/world_step.rs
Verified: `cargo test --workspace` — 543+32+19+24+57+... all green, including the
       golden tables, which is the point: the secret defaults to 0 so nothing
       existing moved.
Notes: buried slots were hidden from an honest client, not from the wire — the
       seed is in `welcome` and game-core ships as WASM, so a modified client
       called choose_buried_slots itself and got all ten. Now derived from
       `seed ^ buried_secret`, rolled per round on the server, never sent.
       FIXED_SEED pins the secret to 0 as well, so "reproduce the bug" still
       reproduces the whole round rather than a map with different loot.
       The test asserts the terrain hash and spawn points are UNCHANGED by the
       secret — it must feed the buried stream only, or every golden breaks.

## T6.14 + T6.15 — bots — DONE
Files: crates/game-core/src/bots/mod.rs, crates/game-core/src/lib.rs,
       crates/game-server/src/room.rs, crates/game-server/tests/bots.rs,
       crates/game-server/tests/room.rs
Verified: `cargo test -p game-core --lib bots` — 7 passed;
       `cargo test -p game-server --test bots` — 4 passed; whole workspace green.
Notes: A bot produces an Input and nothing else, so there is NO bot branch inside
       World::step — it queues through queue_input like a socket does. That is
       what makes bots a test of the real game rather than a parallel one.
       Belief LAGS the truth by the reaction time rather than the aim being
       jittered after the fact: a weak bot shoots where you WERE, which reads as
       slow instead of as randomly inaccurate.
       TWO OF MY BOT TESTS WERE WRONG, both by measuring terrain instead of the
       bot. An unarmed bot correctly prefers an item to an enemy, so "walks
       toward a target" was measuring shopping; and a firing-line test at
       arbitrary coordinates measures whatever the generator put in the way.
       `clear_line()` finds 260 px of air first — the same fix as the client's
       solidPoint().
       Config::default() now seats 3 bots, which broke four existing tests that
       counted seats. They were right to break: the fixtures wanted a bot-free
       room, so cfg() sets bot_count 0 and bot seating has its own suite.
Left for later: T6.12 round state and T6.13 integration tests are the two
       remaining M6 boxes.

## T6.12 — round state, votes and the scoreboard — DONE
Files: crates/game-server/src/{round,room,lib}.rs, crates/game-server/tests/round.rs,
       crates/game-core/src/world/mod.rs, client/src/ui/scoreboard{,.test}.ts
Verified: `cargo test -p game-server --test round` — 7 passed; `--lib round` — 8 passed;
       `npm --prefix client test -- --run scoreboard` — 11 passed.
Notes: ROUND_SECONDS WAS PARSED AND THEN DROPPED. Config read it, the world used
       the constant, so `ROUND_SECONDS=5` produced a 240-second round — a test
       asserting on phase transitions would have HUNG rather than failed, which
       is why nobody noticed. World::set_round_seconds now carries it.
       Non-voters abstain: the majority is of votes CAST, not of players
       connected. Silence as a veto is how a lobby dies. The test has the control
       (an actual majority of NO still loses) so it cannot pass by always
       restarting.
       Rank is assigned by VALUE, not array position — two players on equal score
       and deaths are both 1st and the next is 3rd. Displaying them as 1st and
       2nd is a different claim than the game makes (docs/21 §6).
       votes live in a BTreeMap, not a HashMap: it is iterated to count, and A11
       already cost this project one order-dependent bug.
Left for later: T6.16 (Game scene) then T6.13.

## T6.16 — the Game scene, and the M6 checkpoint — DONE
Files: client/src/scenes/GameScene.ts, client/src/render/worldView.ts,
       client/src/net/{connection,worldMirror,codec}.ts, client/src/main.ts,
       client/vite.config.ts, scripts/e2e-two-clients.mjs,
       crates/game-{core,server}/src/... (carve_seq in map_init, DEV_LOADOUT)
Verified: `node scripts/e2e-two-clients.mjs` — two clients, same map, remote seen
       moving 193 px, 4860 px of terrain removed IN BOTH, matching checksum,
       late joiner agrees, **0 resyncs**, 0 page errors. Shots in shots/m6-*.png.
Notes: THE CHECKPOINT EARNED ITS KEEP TWICE.
       1. Connection coerced every payload to Record<string,unknown>, so the two
          payloads that are plain STRINGS — map_init and snapshot, both base64
          (A27) — arrived as {}. The client ignored every map and every snapshot
          while looking perfectly healthy: connected, seated, no errors. Handlers
          now receive the payload as sent.
       2. EVERY CARVE CAUSED A FULL MAP RESEND. The world increments carve_seq
          before emitting, so the first carve is seq 1, and a client reset its
          expectation to 0 on map_init — buffered it, timed out at 2 s, refetched
          the whole map, reset to 0 again. map_init now carries the carve_seq the
          mask is current as of, which is also what lets a MID-ROUND joiner pick
          up the stream. Resyncs went 1 -> 0 per client.
       Also: mask_checksum arriving before map_init made the client resync in a
       loop it could never win (the core still held its constructed map), so
       verifyChecksum returns early until a map has landed.
       WorldView extracts the terrain/backdrop/camera stack so Sandbox and Game
       build it identically — two render paths is how the sandbox stops
       predicting what the game does.
       DEV_LOADOUT=1 (default OFF) arms players at spawn. Finding weapons is the
       design; a checkpoint that must demonstrate destruction cannot start by
       walking to a crate.
Noticed, not fixed: at Small scale the backdrop covers noticeably more sky than
       at Large — A19 measured 16.4% sky-as-backdrop at small vs 7.2% at large,
       and the e2e uses Small for speed. The default is Large. Residual 8-px
       stair-stepping on backdrop/sky edges is still visible (the ~2x-chance
       grid snapping the M5 review measured).
Left for later: T6.13 integration tests is the last M6 box.

## T6.13 — multi-client integration tests — DONE
Files: crates/game-server/tests/integration.rs, crates/game-server/tests/bots.rs,
       crates/game-server/src/room.rs, crates/game-core/src/constants.rs,
       client/src/net/codec.test.ts
Verified: `cargo test -p game-server --test integration -- --test-threads=1` — 4 passed;
       `./scripts/check.sh` — EXIT=0, all checks passed.
Notes: The suite covers only what nothing else does — capacity refusal OVER THE
       WIRE, disconnect propagation, snapshot cadence/size, input ack, malformed
       payload tolerance. A header table records which existing suite owns each
       of docs/41 §8's other claims; duplicating them costs minutes and buys zero.
       NEARLY SHIPPED A DUPLICATE MECHANISM. The ready timeout looked missing
       because session.rs never mentions ready expiry — it is in room.rs
       (sweep_unready, every tick, already tested both directions with a control).
       My second copy broke tests/bots.rs by shifting the seating race. Grep the
       layer that OWNS the state, not the layer you happen to be reading. Only
       READY_TIMEOUT_SECS moving to constants.rs survived.
       TWO PRE-EXISTING FLAKES, both the same race, both found by running a
       baseline more than once. bots.rs `a_human_is_never_refused...` failed 3/5
       on an UNTOUCHED tree: it disconnected the human then asserted on
       players.len(), racing its own Leave. My own malformed-input test had it
       too — passed alone, failed under the loaded workspace run. Both fixed by
       PARKING the client until the assertion has run, not by widening a sleep.
       My first "baseline passed" was a single lucky sample. One run is not
       evidence; that is the same lesson this project keeps re-learning.
       map_init's TS test fixture was 4 bytes short — T6.16 added carve_seq to
       the encoder and the decoder but not the fixture, and a hardcoded offset 26
       then poked the wrong field. Offset is now derived. The real path was
       always fine (checkpoint: 0 resyncs); only the fixture was stale.
Left for later: M7 (T7.01-T7.05) is next. M6 is complete.

## T7.01–T7.05 — assets, atlases, skins, weapons, themes — DONE
Files: scripts/{fetch-assets.sh,build-atlas.mjs,verify-assets.mjs,shot.mjs},
       assets/{atlas-map.json,skins.json,atlas/*,manifest.json},
       client/src/render/{assets,skins-math,themes-math,weaponTextures,playerView,
       procTextures,worldView}.ts, client/src/scenes/{Sandbox,Game}Scene.ts,
       client/vite.config.ts, crates/game-wasm/src/lib.rs
Verified: `./scripts/fetch-assets.sh && ls assets/vendor/kenney/*/LICENSE.txt | wc -l`
       — 4; `./scripts/check.sh` — EXIT=0, all checks passed (249 client tests).
Notes: THE PLAYER IS A CHARACTER NOW, not a magenta box. 5 Kenney variants x 10
       poses = 50 frames, which is exactly the prefix scheme docs/50 §2 predicted:
       five skins, five registry entries, no new art.
       THREE BUGS IN MY OWN FETCH SCRIPT, all found by running it:
       1. `head -1` in a pipeline under `set -o pipefail` — head closes the pipe,
          grep dies of SIGPIPE, and a SUCCESSFUL extraction reports as failed.
          It printed "no .zip link found", which is indistinguishable from the
          site having restructured. Take the first line in bash, not with head.
       2. fail_with_manual_instructions returned 1 but callers ignored it, so
          every failure path fell through and "ok ()" printed for a pack that
          did not exist.
       3. `unzip` is NOT INSTALLED on this box, and my error message blamed a
          truncated download — sending the reader to the network instead of
          their PATH. Falls back to python's zipfile now and says which is
          missing.
       vendor/ is gitignored (A29, 24MB fetched vs a 12MB budget); atlases are
       committed. fx particles ship at 512x512 and made a 2048x4096 atlas, over
       docs/51 §7's cap — downscaled to 128 with a PREMULTIPLIED box filter,
       because averaging straight RGBA drags every soft edge toward black.
       DEVIATION: docs/51 §4 names free-tex-packer-core; used pngjs + a 40-line
       shelf packer instead. Smaller dep, and frame names come from atlas-map.json
       rather than being derived from a path.
       DEVIATION: weapons are drawn procedurally (weaponTextures.ts) — Kenney has
       no side-view bazooka/grenade/SMG at a usable size. skins.json records this
       as `atlas: null` rather than deleting the entries, so muzzle/pivot survive
       and verify-assets skips them deliberately instead of by omission.
       `playwright-core` was installed but NEVER IN package.json, so my `npm i -D`
       pruned it and shot.mjs died. Now a recorded devDependency.
       ASYNC create() IS NOT AWAITED BY PHASER. Loading art made create() async and
       update() started running against an undefined core on frame 1. Both scenes
       now guard on a `ready` flag set at the end of create().
       WALK_SPEED now crosses the WASM boundary rather than being duplicated
       client-side (the M0 review's finding 4, applied rather than repeated).
Left for later: M8. Noticed, not fixed: at theme 2 (frost) the sky shows large
       angular lighter-grey regions that may be backdrop misclassification rather
       than terrain — see shots/m7-theme-4242.png, top-right and right edge.

## A32 — measured, and change 1 NOT adopted — DONE (partial, by evidence)
Files: client/src/render/themes-math.ts, client/src/render/themes-math.test.ts
Verified: `./scripts/check.sh` — EXIT=0. Ray-length table measured at 5 values x
       3 scales (15 rows) before changing anything.
Notes: A32 CHANGE 1 (BACKDROP_RAY_LEN 320->160) IS NOT ADOPTED. The stated
       expectation — "sky-as-backdrop falls sharply while enclosed-as-sky barely
       moves" — is FALSE. Measured, enclosed-as-sky/sky-as-backdrop:
         small  160 5.63/0.90  200 1.67/2.60  240 0.43/7.16  320 0.00/16.42
         medium 160 13.70/0.46 200 7.96/1.40  240 4.58/2.42  320 1.42/5.86
         large  160 10.85/0.11 200 7.79/1.04  240 5.35/2.75  320 2.49/7.18
       A clean monotonic trade, and no value satisfies both bounds at all scales.
       At 160 the RECURRING failure (daylight inside a cavern) gets 5-10x WORSE.
       Reason the expectation fails: "a cave wall is close by definition" is true
       of tunnels, not of the features that dominate — voids are 140-310px across,
       so the middle of one is >160px from every wall and reads as sky.
       320 is the value that keeps enclosed-as-sky inside its bound at every
       scale (0.00/1.42/2.49 vs 2/2/3), which is the failure A18 ranked worse.
       A32'S PREMISE IS ALSO WRONG: frost's backdrop is NOT lighter than its sky.
       Sampled from shots/m7-theme-4242.png — backdrop lum 43, sky lum 106. What
       I reported as "angular lighter regions in the sky" is the terrain FILL
       (lum 120): frost's rock is light, so islands read bright against a dark
       backdrop. I had my own sample points inverted when I first read the image.
       A32 CHANGE 2 IS ADOPTED and is the useful half: every theme's backdrop must
       be darker than its daytime sky by >30 lum. Measured margins grassland 171,
       desert 140, frost 142. Falsified — a bright frost backdrop fails it.
Left for later: M8 (T8.01-T8.08) not started.

## T8.01 — Replay recorder — DONE
Files: crates/game-server/src/replay.rs (new), room.rs, lib.rs,
       crates/game-server/tests/replay.rs (new)
Verified: `cargo test -p game-server --test replay` — 11 passed;
       `cargo test -p game-server --lib replay` — 13 passed.
Notes: ReplayCommand is NOT a mirror of Command. Two differences carry weight:
       Join/Inspect can't be recorded (oneshot sender, closure), and
       DropUnready exists because sweep_unready fires on WALL-CLOCK elapsed
       time — a replay has no clock, so without recording its effect a
       replayed round keeps a seat the live round freed and diverges there.
       Commands recorded AS APPLIED: Input is noted after seq filtering, so a
       replay never re-simulates input the live round rejected.
       docs/61 §4's "a few hundred KB" size estimate is WRONG and not close:
       240s x 60Hz x 6 players = 86,400 accepted inputs x 14 bytes = 1.21 MB.
       It omitted the player count and the input rate. Delta-encoding the tick
       gives 0.95 MB; the Input payload alone is 0.60 MB, so no framing change
       reaches the estimate. Test bound is 2 MB, with a 500 KB floor so it
       cannot pass by recording nothing. NEEDS AN AMENDMENT.
       My tag-uniqueness test was wrong before the code was — it deduped by
       value, and every_command() carries two VoteRestarts on purpose.
Left for later: T8.02 (the runner) is next and is the payoff.

## T8.02 — Headless replay binary — DONE
Files: crates/game-server/src/bin/replay.rs (new), replay.rs, room.rs, main.rs,
       config.rs, Cargo.toml, docker/Dockerfile.server,
       crates/game-core/src/world/mod.rs, effects/scheduler.rs,
       items/{spawning,inventory}.rs, crates/game-server/tests/replay_run.rs
Verified: `cargo test -p game-server --test replay_run` — 14 passed.
       End to end: real server, RECORD_REPLAY=1, SIGTERM, then
       `./target/release/replay <file>` — "VERIFIED — matches the footer",
       1068 ticks of 3 bots, EXIT=0. ./scripts/check.sh green.
Notes: TWO REAL BUGS, both found by falsifying rather than by a failing test.
       1. state_hash COVERED ALMOST NOTHING. Its doc said "every mutable piece
          of simulation state"; it hashed mask+tick+round_time+player pos/vel/
          health/score/alive and item/projectile positions. A probe leaking
          SystemTime into world.wind every tick REPLAYED GREEN. Unhashed:
          wind, carve_seq, phase, all timers (shield/iframes/respawn/cooldown),
          jetpack + jump state, aim, inventories, buried items, the effect
          scheduler, the spawn schedule, and every RNG stream position. Now
          hashed, with subsystems providing hash_into() so the obligation sits
          next to the private fields. RNG streams are hashed by CLONING AND
          DRAWING, which captures stream POSITION — two schedulers with
          identical visible fields but different draw counts are not equal.
          Pinned by the_hash_is_sensitive_to_every_field_a_tick_can_change.
       2. SIGTERM NEVER WROTE THE FOOTER. main returned as soon as axum
          stopped, so the room task was never scheduled again — exactly the
          `docker compose down` case docs/41 §7 exists for. Every unit test
          passed because they call finish_recording() directly. main now
          signals and WAITS (SHUTDOWN_GRACE 3s). Control: SIGKILL must leave
          no footer, and it must be a SUBPROCESS test — in-process the room is
          scheduled the instant the oneshot fires, so an in-process "don't
          wait" case writes the footer anyway and proves nothing.
       Header is flushed on create, so a SIGKILLed round still names its seed.
       Checkpoints (a state hash every 600 ticks) are recorded so a mismatch
       reports WHERE it diverged; the footer alone can only say THAT it did.
       Two binaries now, so Cargo.toml needs default-run and the Dockerfile's
       stub layer needs a stub for EVERY [[bin]] or the dep layer fails.
       REPLAY_DIR is configurable (was hardcoded "replays").
Left for later: T8.03-T8.08. docs/61 §4's replay size estimate needs an
       amendment (see T8.01 entry).

## T8.07 — End-to-end suite — DONE
Files: scripts/e2e.mjs (new), scripts/check.sh
Verified: `node scripts/e2e.mjs` — 9/9 passed in ~137 s (sandbox, wasd, sky,
       lightmap, night_darkens_the_world, m4-checkpoint, night-combat,
       m5-weather, two-clients). `./scripts/check.sh` green with it in the gate.
Notes: The checks already existed; only ONE of them ran in the gate. This is
       the suite that runs the rest. One vite + one Chromium for all of them,
       so the whole suite costs about what a single check used to.
       DEVIATION: not @playwright/test. drive.mjs already solves the two hard
       parts (reading vite's port from its own output, LD_LIBRARY_PATH to
       ~/.cache/pwlibs), and a second runner means a second place for those
       workarounds to drift. The task asked for a suite that runs in the gate,
       not for a particular runner.
       A STANDALONE SCRIPT IN THE LIST KILLED THE SUITE. m5-weather.mjs is not
       a check module — it launches its own vite and browser and calls
       process.exit. Imported, its body ran and exited 0 MID-SUITE, so the
       summary never printed and any earlier failure would have been hidden
       while the gate went green. Standalone entries now run as subprocesses,
       and a non-module in the module path is a clear error naming the fix.
       Falsified: breaking the wasd threshold gives FAIL wasd / ok sky, exit 1,
       and shots/FAILED-wasd.png. A check that writes no screenshot also fails
       — on this box the picture is the only way a failure is seen.
       check.sh had two nested identical `if [ "$FAST" -eq 0 ]` blocks with
       mismatched indentation. Balanced, but the next person adding a check
       would have got it wrong. Now one block.
Left for later: T8.03 (F3 HUD), T8.04 (/metrics — not implemented at all),
       T8.05 (perf + docs), T8.06 (minimap), T8.08 (game feel).

## T8.04 — /metrics, DEBUG_DUMP and the log audit — DONE
Files: crates/game-server/src/metrics.rs (new), app.rs, state.rs, room.rs,
       events.rs, lib.rs, crates/game-core/src/world/mod.rs
Verified: `cargo test -p game-server --lib metrics` — 4 passed. Live server:
       /metrics gives rooms 1, players 2, ticks 560, p50 0.02ms, p99 0.05ms;
       a real client join gives snapshot_bytes_per_s 314 over 61 snapshots.
       DEBUG_DUMP=1 wrote map.png + surface.png + meta.json. check.sh green.
Notes: THE AUDIT IS THE FINDING. Five of docs/61 §3's seven diagnostic lines
       DID NOT EXIST. Only the tick-overrun line and a map-generation-FAILURE
       line were there. Added: game::map generation summary (attempts,
       traversable_fraction, used_safe_preset — the "unplayable map" line),
       game::weapons fire rejection with the reason (world.fire's Result was
       being discarded with `let _ =`, so the server knew exactly why and threw
       it away), game::items use rejection and despawn, game::player respawn
       point, game::effects roll. Only carve-seq gaps remain client-side.
       TWO SOURCES OF TRUTH FOR ONE NUMBER: /healthz read AppState.rooms and
       .players, which NOTHING EVER INCREMENTED — a healthy server with two
       players reported players 0. Both endpoints now read the metrics
       registry, and rooms is set at build_stack.
       The tick ring is 1024 samples (~17 s) ON PURPOSE: percentiles describe
       NOW. A lifetime histogram lets a healthy first minute hide a bad one,
       which is the opposite of what "why does it feel bad" needs. Pinned by
       the_ring_forgets_old_samples.
       World::events_so_far() added so the server can log from events and
       still flush them to clients — draining to log would mean the log and
       the wire could not both see the same event.
       DEBUG_DUMP writes meta.json always and the PNGs only with --features
       dump-png, and SAYS SO at warn when the feature is absent: one file of
       three, silently, would look like a dump that worked.
Left for later: T8.03 (F3 HUD), T8.05 (perf + docs), T8.06 (minimap),
       T8.08 (game feel). Nothing is blocked; each is independent.

## T8.08 — Game feel — PARTIAL (model done and tested; rendering NOT done)
Files: client/src/render/feel-math.ts (+test), client/src/ui/killfeed-state.ts (+test)
Verified: `npm --prefix client test -- --run feel-math killfeed-state` — 22 passed.
       typecheck clean. THE BOX IS NOT TICKED.
Done: the pure model — trauma (squared curve, distance + blast-radius scaled,
       decays to 0, capped at 1), floating damage numbers, damage vignette,
       hit markers, phase banner, kill feed (evicts past 5, expires at 6 s,
       self-kills and weather deaths read differently from a normal kill).
NOT done: the Phaser layer that draws any of it. I wrote it, wired it into
       SandboxScene, and the numbers were all correct while NOTHING APPEARED
       ON SCREEN — feelProbe showed trauma 0.79, one damage number, vignette
       0.11, health 100->75, and the frame showed only the crater.
       Cause: a `scrollFactor(0)` object is STILL scaled by camera zoom, so
       every screen-space element was drawn off-viewport at zoom 2. This is
       the §A16 class of bug again — correct in world units, wrong relative to
       what is on screen. I probed it with two test rects (setPosition(0,0),
       and mid-(w/2)/z with scale 1/z) and NEITHER was visible, so my model of
       the transform is wrong and guessing further was not converging.
       THE ANSWER IS ALREADY IN THIS CODEBASE: the existing HUD strip and
       scoreboard are DOM elements, not Phaser objects. Screen-space UI here
       should be DOM (world->screen is then just (x - scrollX) * zoom, with no
       Phaser zoom quirk), or a second camera at zoom 1. Do that rather than
       re-deriving the Phaser transform.
       I reverted the scene wiring and deleted the non-rendering Phaser files
       rather than commit a feature whose acceptance criterion is "does it
       look good" while it looks like nothing.
Two traps that cost a debugging round each, both the same shape: in the
       sandbox, BOTH `regenerate()` AND `place()` wipe the dev loadout —
       `place` removes and re-adds the player, which resets the inventory. A
       check that sets up its own state must re-grant or avoid both.
Left for later: T8.03, T8.05, T8.06, and T8.08's rendering.

## T8.08 — Game feel — DONE
Files: client/src/ui/feelLayer.ts (new), feelLayer-math.ts (+test, new),
       render/feel-math.ts, render/cameraRig-math.ts, cameraRig.test.ts,
       scenes/SandboxScene.ts, scenes/GameScene.ts, scripts/checks/feel.mjs (new)
Verified: `node scripts/e2e.mjs feel` — ok. check.sh --fast green, 279 client tests.
Notes: DRAWN IN THE DOM, per §A35 — a scrollFactor(0) Phaser object is still
       scaled by camera zoom. The HUD and scoreboard were already DOM for the
       same reason; this is that answer applied consistently, not a third
       attempt at the Phaser transform. Positions map through worldToCss, which
       goes via camera.worldView rather than re-deriving the engine transform.
       A SECOND Trauma EXISTED. feel-math had its own, while cameraRig-math's
       is the one wired to the camera — §A24 duplication. Deleted feel-math's;
       its genuinely-new part (distance + blast-radius scaling) moved to
       cameraRig-math as traumaFromExplosion(), beside the class that owns
       trauma, plus roll(). Tests moved with it.
       MY FIRST TWO ATTEMPTS AT THE CHECK PASSED AGAINST THE BUG. (1) A single
       sample at 700 ms read vignette 0 — it decays in 0.55 s. Fixed by polling
       for the peak and snapshotting the DOM while nodes are still mounted.
       (2) "Inside the viewport" does not discriminate: with the zoom dropped
       from the mapping the number moved 638,526 -> 309,248 and stayed on
       screen, so the assertion passed. The check now derives the expected
       screen position independently (worldView + canvas rect, its own
       arithmetic) and asserts proximity — falsified at 469 px away.
Left for later: T8.03, T8.05, T8.06.

## T8.06 — Explored-terrain minimap — DONE
Files: client/src/ui/minimap-math.ts (+test, new), ui/minimap.ts (new),
       scenes/GameScene.ts, scenes/SandboxScene.ts, core/index.ts,
       crates/game-wasm/src/lib.rs, scripts/checks/minimap.mjs (new)
Verified: `npm --prefix client test -- --run minimap-math` — 14 passed.
       `node scripts/e2e.mjs minimap` — ok. 695/20000 cells at start, 903 after
       walking right, 950 after walking back (never shrinks).
Notes: A DOM <canvas>, not a Phaser object — §A35 again, and the minimap IS a
       per-pixel image so a 2D context is the right tool anyway.
       MINIMAP_ALPHA and MINIMAP_REVEAL_R were in constants.rs but were NOT
       crossing the WASM boundary — the constants bridge is opt-in per name, so
       a constant can exist and still be unreachable from the client. Added.
       Both scenes pass the SAME `fov` the lightmap uses rather than
       recomputing it: two copies of that number would let the minimap and the
       screen disagree about who is visible, which is exactly what §A6 forbids.
       Falsified: revealing the whole map at once fails with
       "20000/20000 cells explored before moving — the map is being given away".
Left for later: T8.03, T8.05.

## T8.03 — F3 debug HUD — DONE
Files: client/src/ui/debugHud-math.ts (+test, new), ui/debugHud.ts (new),
       scenes/GameScene.ts, crates/game-server/src/session.rs,
       scripts/e2e-two-clients.mjs
Verified: `npm --prefix client test -- --run debugHud-math` — 15 passed.
       `node scripts/e2e-two-clients.mjs` — HUD reports 20.0 snapshots/s against
       a 20 Hz server and 59.3 inputs/s against a 60 Hz sim. shots/m6-debug-hud.png.
Notes: RTT WAS HARDCODED TO ZERO. `clock.addSample(..., 0)` — ClockSync had the
       machinery and nothing ever fed it, so the HUD's headline number was a
       constant on every connection. docs/42 §7 says rtt comes from "socket.io's
       own ping/pong", but the client library does not surface that measurement.
       Added a `ping_rtt`/`pong_rtt` echo (client timestamp, server echoes it
       back, one message a second). NEEDS AN AMENDMENT — it is a protocol
       addition not in docs/40 §2.
       Falsified: with the server not answering, the check fails with "rtt is
       not being measured — no pong_rtt was ever received".
       DEVIATION from the task's single-file deliverable: the rate/jitter/loss
       arithmetic is in debugHud-math.ts per §A8, which overrides the task file.
       Rates use a 3 s trailing window for the same reason the server's tick ring
       is 1024 samples: a session average lets a healthy first minute hide a bad
       minute. A rate meter that divides by the observed span rather than the
       window reports one event as an infinite rate — tested.
       The panel is DOM (§A35); the two ghosts are Phaser objects ON PURPOSE,
       because they mark WORLD positions and should scale with zoom.
Left for later: T8.05.

## T8.05 — Performance pass and run documentation — DONE
Files: RUNNING.md (new), scripts/checks/perf.mjs (new), scripts/e2e.mjs,
       client/src/scenes/GameScene.ts, SandboxScene.ts, scripts/e2e-two-clients.mjs
Verified: `node scripts/e2e.mjs perf` — ok. Numbers below.
Notes: THE fps 36 QUESTION IS ANSWERED, AND IT WAS THE INSTRUMENT. Measured by
       rAF frame times the game runs 59.9 fps (p50 16.70 ms, p99 17.70 ms), and
       THE FEEL LAYER COSTS 0.00 ms/frame — measured with it on and off, since a
       number with no control is not evidence. Phaser's `actualFps` is a smoothed
       average that under-reports for seconds after a stall: 42 just after a
       regenerate (which stalls ~0.9 s for generate + full bake), still 54 four
       seconds later, while the real frame time was 16.7 ms throughout. The check
       logs it and deliberately does NOT assert on it — asserting on a counter
       the same check just proved unreliable is the §A15 mistake.
       A SINGLE SAMPLE OF THE FULL BAKE DECIDES NOTHING: 250–428 ms across runs
       with no code change, against a 400 ms ceiling. Now judged on the median of
       five (280–296 ms). Software rendering; real hardware is faster.
       WRITING THE DOC FOUND A REAL GAP. I wrote the controls table from the spec
       and then checked it against the code: E, 1–8, wheel, Tab and right-click
       were NOT BOUND in the multiplayer scene. `Connection.sendUseItem` and
       `sendSelectSlot` existed since T6.08 and nothing called them, so a medkit,
       a shield and THE FLASHLIGHT were unusable in the real game — the flashlight
       being the item the whole night design turns on. Same shape as the missing
       Game scene: mechanisms built, never wired to the thing that runs them.
       Now bound, with the inventory strip and panel in the HUD, and asserted in
       e2e-two-clients (the HUD must *change*, since a binding wired to nothing
       looks identical from outside).
Ceilings (docs/60 §6): medium generate median 618 ms (<1000); full 72-chunk bake
       median 296 ms (<400); chunk rebake 0.00 ms (<4); carve 0.30 ms.
Left for later: nothing in M8. Decorations, item sprites and the frost contrast
       assertion remain as noted improvements, not tasks.

## Bot seats were swept 30 s into every round — FIXED
Files: crates/game-server/src/room.rs, tests/replay.rs
Verified: `cargo test -p game-server --test replay bots_survive` — ok; falsified
       by reverting, which reproduces the exact production symptom
       (`left: [0,1,2,3]  right: [3]`).
Notes: FOUND BY PLAYING IT, NOT BY A TEST. Driving a real round and polling the
       roster: [0,1,2,3] at t=25s, [3] at t=30s, and single-player from then on.
       `seat_bots` allocated seats with `ready: false`; `sweep_unready` drops any
       unready seat after READY_TIMEOUT (30 s, docs/40 §1). Bots have no socket,
       so they can never send `ready` — every bot was dropped exactly 30 s in.
       Nothing looked wrong: ZERO deaths, no errors, phase still "playing", and
       the only log line was "dropping: never sent ready", which reads as correct
       behaviour. A one-player deathmatch with three seated bots is the symptom.
       `ready` means "in the simulation", and the handshake it gates on — download
       the map, decode it, render it — does not exist for something with no
       socket. Bots are marked ready at seat time.
       The test's control is the second half: a human who never readies MUST
       still be swept, so it cannot pass by disabling the sweep.

## HUD lines collapsed into one — FIXED
Files: client/src/scenes/GameScene.ts
Verified: hud box 66px tall for 3 lines (was one unreadable run). shots/play2-ui.png.
Notes: MY OWN DEFECT, FROM THIS SESSION, AND ONLY A SCREENSHOT FOUND IT. I joined
       the strip, the inventory panel and the scoreboard with "\n" into
       textContent — and HTML does not honour newlines without `white-space:pre`.
       The console log printed three lines (textContent HAS the newlines), so
       every readout said it was correct while the screen showed
       "3:54 | HP 100 smg x60 1:— [2:smg x60] 3:— ... =1 p0:0 · =1 p1:0 ...".
       Same shape as §A15: the model was right and the render was not.

## T9.01 — Audio — DONE
Files: client/src/audio/{mixer,mixer.test,sfx}.ts, assets/audio-map.json,
       scripts/build-audio.mjs, scripts/checks/audio.mjs, scenes, fetch-assets.sh
Verified: `npm --prefix client test -- --run mixer` — 29 passed;
       `node scripts/e2e.mjs audio` — ok (23 samples, context unlocks, walking
       gives footsteps, firing gives fire_bazooka+explode, master 0 gives zero).
Notes: THE CHECK ASSERTS ON EFFECTS, NOT INTENT. Chromium with no audio device
       still runs every line of the mixer and returns from play(), so "a sound
       played" has to mean "a voice started with gain > 0" — the mixer returns
       the applied gain precisely so that is observable (§A15). The control is
       master volume 0 starting *nothing*: without it, the check passes against
       a build that plays unconditionally.
       Falsified four mixer tests at the live binding site (cap removed, curve
       made linear, jitter switched to Math.random, spatial using dx only) —
       each fails exactly the test that names it. Falsified the e2e check by
       feeding the mixer no cues: "walking produced no footstep cue".
       `place()` WIPED THE LOADOUT and every caller had to remember to re-grant
       — the trap the T8.08 journal entry recorded. Fixed at the source (§A24)
       rather than in the caller, which is what cost two debugging rounds.
       DEVIATIONS: (1) added `hold(cue,on)` for sustained cues — a jetpack fired
       as a one-shot every tick stutters; jetpack and lava loop and are stopped
       with a 30 ms ramp, because cutting a waveform mid-cycle clicks.
       (2) exported MAX_FALL_SPEED across the WASM boundary so landing volume
       scales by fall speed rather than a second copy of the number client-side.
       Sound set: 17 cues / 23 files / 655 kB, four CC0 Kenney packs.
Left for later: T9.02.

## T9.02 — Draw the decorations — DONE
Files: client/src/render/{decorations,decorations-math,decorations-math.test}.ts,
       worldView.ts, scenes/SandboxScene.ts, assets/atlas-map.json,
       scripts/build-atlas.mjs, scripts/checks/decorations.mjs, scripts/e2e.mjs
Verified: `npm --prefix client test -- --run decorations-math` — 19 passed;
       `node scripts/e2e.mjs decorations` — ok, 35 of 35 drawn, 5 in the viewport,
       carving removes them. Falsified twice (nothing placed; destroyedBy never
       reports a hit) — each fails the test that names it.
Notes: I REPEATED A BUG THE GENERATOR ALREADY DOCUMENTS. My first support test
       was `solidAt(x, y+1)` — the single pixel under the anchor — and it drew
       10 of 35. `is_standable` in map/gen/surface.rs tests support ACROSS THE
       BODY WIDTH, and its comment records why: on a slope the box rests on the
       highest ground beneath it and the centre column is air, measured at 168 of
       192 sampled columns rejected. Decorations are anchored to those same
       surface points. Fixed by using surface.rs's own numbers (HALF_W 8,
       MIN_SUPPORT_PX 3) rather than a similar-looking guess: 35 of 35.
       MY FIRST FALSIFICATION HIT THE WRONG LINE, AGAIN. Disabling the compaction
       branch still showed 35->34, because the sprite is destroyed before it.
       Re-aimed at destroyedBy and it went red properly.
       MY FIRST SCREENSHOT CONTAINED NO DECORATIONS (§A22) — an empty snowfield
       while 35 props stood elsewhere. The check now frames one and asserts a
       count inside the viewport before it shoots.
       build-atlas.mjs REWROTE THE WHOLE MANIFEST and emptied manifest.audio on
       every atlas rebuild — two writers to one file, each assuming it owned all
       of it (§A24). It merges now, and both build orders were verified.
Left for later: T9.03. NOTED: WorldView's docstring claimed the sandbox and the
       game build the stack the same way; only GameScene uses it, and the sandbox
       still builds it inline. Every addition has to be made twice — this is the
       second feature to pay that. Comment corrected to say what is true;
       migrating the sandbox deserves its own task.

## T9.03 — Item, crate and pickup sprites — DONE
Files: client/src/render/{itemSprites,itemSprites-math,itemSprites-math.test}.ts,
       core/index.ts, crates/game-wasm/src/lib.rs, crates/game-server/src/session.rs,
       assets/atlas-map.json, scripts/e2e-two-clients.mjs, scenes/GameScene.ts
Verified: `npm --prefix client test -- --run itemSprites-math` — 16 passed;
       `node scripts/e2e.mjs two-clients` — items: 8 drawn of 8 tracked.
       Falsified by skipping the layer update: "8 world items exist and 0 are
       drawn", exit 1.
Notes: THIS WAS NOT A COSMETIC TASK. World items were tracked by WorldMirror
       from T6.08 and drawn by NOTHING — a medkit on the ground was invisible in
       the real game. Items are the reason to move (docs/30) and an invisible
       reason to move is no reason at all.
       WORSE: the initial 8-20 items were never announced to anyone. place_initial
       runs inside World::new, before any event buffer exists, so no item_spawn
       was ever emitted for them — the server had them and no client could know.
       Fixed by sending the existing item list per socket on join, which also
       covers the mid-round joiner docs/41 §4 explicitly supports.
       The e2e assertion is deliberately TWO numbers, tracked vs drawn, because
       they were silently different for three milestones; asserting only "the
       server spawned items" would have passed the whole time.
       ItemDef.sprite has been populated since T4.01 and was unreadable by the
       client — the wire carries only a numeric item_id. Exported the registry
       through item_registry_json() rather than duplicating six entries.
Left for later: T9.04.

## T9.04 — Theme contrast, and one capsule rasteriser — DONE
Files: crates/game-core/src/map/{shape,carve}.rs, tests/golden_hashes.txt,
       client/src/render/{themes-math,themes-math.test,sky-math,sky}.ts,
       scripts/verify-assets.mjs, scripts/checks/m9-checkpoint.mjs
Verified: `cargo test -p game-core --lib map::carve` — 26 passed incl. the new
       stamping-vs-carving equality; `npm test -- --run themes-math` — 9 passed;
       999-seed sweep re-run below. Gate green: 771 Rust + 375 client tests.
Notes: THE FROST PALETTE BRIEF DID NOT SURVIVE MEASUREMENT, and I did not change
       the palette. Judged on LUMINANCE frost looks worst (worst gap 5.3 against
       grassland 7.1 and desert 9.8) — but sky luminance sweeps the whole range
       twice a day, so it MUST cross fixed terrain luminance at dusk and dawn;
       that is a property of having a day cycle, not a palette defect. Judged on
       COLOUR DISTANCE, which is what decides whether you can see the boundary,
       frost is comfortably the BEST at 18.4 against 7.1 and 7.9. The assertion
       is now colour distance across all 18 sky keyframes, floor 6, chosen from
       the measured values. Falsified two ways: swapping the metric back to
       luminance fails it, and dropping a keyframe fails the table-agreement test.
       ONE CAPSULE PATH NOW. shape::{clamp_capsule, walk_capsule} are shared, so
       stamp_capsule and Map::carve_capsule walk identically; a new test asserts
       carving from a full mask leaves exactly the inverse of stamping into an
       empty one over 8 endpoint/radius cases. Falsified by restoring the float
       r/2 walk: "(61,51) disagrees for capsule (60,60)-(300,60) r=9".
       CONSEQUENCES THIS TASK OWNED: 5 of 12 golden mask hashes changed
       (GOLDEN_UPDATE=1, intentional) — and every META hash is UNCHANGED, so
       spawns, buried slots and component sizes were not perturbed. 999-seed
       sweep is IDENTICAL to before: attempts [0,996,3,0,0], safe_preset 0,
       fraction min 0.760 p50 0.929, cave_reachable 88.0%.
       TWO VISUAL DEFECTS FOUND BY LOOKING: decor_3/decor_8 were tile_0097 and
       tile_0140, which are 98% and 99% OPAQUE — terrain tiles, not props, and
       they rendered as flat green and brown squares standing on the ground.
       verify-assets now fails any decor frame over 90% opaque, so picking a tile
       by eye off a numbered contact sheet cannot silently ship again. And the
       sun/moon glows were flat-alpha circles, which draw a hard-edged pale ring;
       they are radial-gradient textures now (LINEAR, since pixelArt forces
       NEAREST globally — the same fix the half-res lightmap needed).
       I ALSO WALKED INTO A DOCUMENTED TRAP: my first checkpoint luminance probe
       drawImage'd the live WebGL canvas and read 0.0 everywhere. Phaser does not
       preserve the drawing buffer; night_darkens_the_world.mjs already samples a
       screenshot instead. I wrote a second way to read pixels rather than using
       the one that worked.
Left for later: nothing in M9.

## T9.05 — Bound the backdrop by distance to rock — DONE
Files: client/src/render/{chunkBake-math,backdrop-real.test}.ts, terrain.ts,
       chunkBake.test.ts, crates/game-core/src/constants.rs, game-wasm/src/lib.rs,
       client/src/core/index.ts, scripts/vite-url.mjs (new),
       scripts/{e2e,shot,drive,e2e-two-clients}.mjs, scripts/checks/m5-weather.mjs
Verified: `npm test -- --run backdrop-real` — 15 passed; `node scripts/e2e.mjs
       decorations` — ok. Falsified at the live binding site (disabled the conjunct
       in chunkBake-math.ts): 190 and 643 violations, worst 202 and 269 px.
Notes: §A37'S AGGREGATE PREDICTION WAS WRONG AND I MEASURED BEFORE IMPLEMENTING.
       It predicted sky-as-backdrop would fall "well below 1 %". Measured, the
       false positives sit 45-160 px from rock (p50 ~100) and OVERLAP genuinely
       enclosed air (p90 63-69), so no distance cut separates the populations:
       16.42/5.86/7.18 % -> 16.42/5.26/6.71 %. Every cut that moves it meaningfully
       makes enclosed-as-sky worse by more (medium at 80 px: 5.86->1.68 but
       1.42->8.39). Same monotonic trade §A32 found with ray length.
       WHAT IT DOES BUY, and why I kept it: the FAR TAIL. Deepest backdrop pixel
       204->168 px (medium), 196->165 (large), and the four pixels the parent
       sampled from the shipped frame as backdrop-coloured (35,29,24) are now sky
       (109,168,225). The island underside is still backdrop. A fringe hugging a
       cliff reads as shadow; a blob 180 px from anything reads as a glitch, and
       the aggregate share cannot tell them apart. New test asserts the guarantee
       directly (nothing beyond the bound is backdrop) with a control that the
       far-air population is non-empty; a sibling asserts deep void interiors are
       STILL backdrop, since a distance bound is exactly what could cause the
       failure §A18 ranks worst.
       FIVE COPIES OF ONE PARSE, ALL BROKEN (§A24). The gate hung 90 s for me and
       passed for the previous session with no code change between: vite prints
       `localhost:<ESC>[1m5174`, so `/localhost:(\d+)/` cannot match, and whether
       it colourises depends on the INHERITED environment — a shell exporting
       FORCE_COLOR makes it colour through a pipe. e2e.mjs, shot.mjs, drive.mjs,
       e2e-two-clients.mjs and checks/m5-weather.mjs had each written this by hand.
       Now one `matchVitePort` in scripts/vite-url.mjs. This was not my defect and
       it was blocking my Done-when.
       PERF IS FAILING AND IT IS NOT MINE — A/B'd rather than assumed. With the
       conjunct fully disabled the bake median is 435 ms; with it, 425 ms; ceiling
       400. Samples swing 293-455 within a single run. I then made my own cost
       ~0 anyway by scattering from the existing per-pixel `solid` array instead
       of gathering through the `isSolid` closure. I did NOT touch the ceiling.
Left for later: the perf ceiling (pre-existing, bimodal samples suggest a
       systematic effect not noise); §A37's aggregate claim needs correcting in
       the doc; one ~40x20 screen-px backdrop patch remains at bottom-left of
       m9-grassland-day.png, within the accepted residual.

## T9.06 — Play a full round — DONE
Files: scripts/checks/full-round.mjs (new), scripts/e2e.mjs,
       client/src/scenes/GameScene.ts, crates/game-server/src/{events,room}.rs
Verified: `node scripts/e2e.mjs full-round` — all 13 assertions ok, three times
       running. 150 s round + 10 s warmup, 2 clients + 3 bots, ~161k px destroyed,
       3 weather effects telegraph→active→end, darkness 0.00→0.82, masks agree,
       0 resyncs, max tick lag 3.
Notes: THE SCENE RECORDS, THE CHECK DOES NOT POLL. The things worth asserting are
       events and most are brief — a telegraph is 3 s, a death instantaneous — so
       `GameScene.observed` accumulates them as they arrive. A once-a-second
       sample would miss them and pass on a round where nothing happened.
       THREE DEFECTS, none reachable by a unit test:
       (1) `effect_phase` serialised the enum's Debug (`"Active"`) while
       `effect_start` hardcoded `"telegraph"` — the SAME FIELD in two casings
       depending on which event carried it, against docs/40 §3. No unit test
       compared two events' encodings to each other. Now `effect_phase_name`,
       with a test that falsifies at the live binding site.
       (2) THE `score` HANDLER DISCARDED ITS PAYLOAD and only re-rendered a map
       written by `welcome`/`player_join`, both of which set 0 — so the
       scoreboard read 0 for everyone all round however many kills happened, and
       the HUD refreshed faithfully to show it. Caught by reconciling the
       scoreboard against the deaths the check had watched.
       (3) `Inventory` is pushed on pickup/use/death and NEVER ON JOIN, and
       `give()` pushes nothing — so with DEV_LOADOUT the HUD says "(empty)" while
       you hold 4 rockets. Same class as T9.03's un-announced initial items.
       REPORTED, NOT FIXED: it needs the join path, which is outside this task.
       Self-kill is scripted rather than left to bots: two trial rounds gave 0
       and 1 deaths, so "at least one death" from combat is a coin flip and a
       flaky gate teaches people to re-run it (§A28). Self-damage is a real
       mechanic (SELF_DAMAGE_MULT 1.0). It needed three fixes to be reliable —
       drive with the smg so rockets survive (hitscan cannot hurt its owner),
       step onto fresh ground between shots (each blast deepens the crater so the
       next detonates further below you: 12 dmg/shot standing still vs 25), and
       DEV_LOADOUT grants a second rocket stack because 4 is not "armed".
Left for later: T9.07; the inventory-on-join defect above.

## T9.07 — The bake regression — DONE
Files: client/src/render/{chunkBake-math,terrain}.ts, scenes/SandboxScene.ts,
       scripts/checks/perf.mjs, docs/70-amendments-v2.md (§A38)
Verified: `node scripts/e2e.mjs perf` ok — 72-chunk bake median 96 ms (ceiling
       400), backdrop 212 (500), round-start total 308 (800), 59.9 fps.
Notes: IT WAS NOT A CODE REGRESSION AND THE CEILING MEASURED THE WRONG QUANTITY.
       Splitting buildAll: chunk bake 84-102 ms, backdrop classification 176-237,
       total 264-330. docs/60 §6's 400 ms is on "a full 72-chunk bake" — that part
       sits at a QUARTER of its ceiling. Two thirds of the total is the backdrop
       pass, which did not exist when the number was written and grew through
       §A17/§A21/§A37.
       THE BIMODALITY WAS THE BOX, PROVED BY A CONTROL. Under a deliberate 8-core
       load every pass rose together INCLUDING generateMs (627-665 -> 694-744),
       which is pure WASM with no canvas and no GPU — nothing done to the bake can
       slow that down. The 280-296 recorded two sessions ago and the 427 measured
       in the next are the same code on a differently-loaded box.
       Optimisation kept but not overclaimed: the ray loop indexed `solid` through
       a closure, up to 47 M calls per build, while the pass directly below it
       already carried a note that direct indexing beats closure calls ~10x. Same
       arithmetic (bit-identical: §A19 shares reproduce at 16.4/5.3/6.7). A/B'd in
       one load window: median 299->295, max 402->330. It removes the tail only.
       Ceiling NOT relaxed: pointed at the chunk bake, which is what it described.
       Two new ones set from measurement with their basis written down.
       TRAP, twice on this project now: `pkill -f "while :"` matches its own shell
       (as `pkill -f vite` did). Kill by pid or use a pattern that cannot match.
Left for later: the inventory-on-join defect from T9.06.
       FOLLOW-UP (T9.06): the weather screenshot fired on "a hazard has been
       announced somewhere", and produced a frame with no weather in it — the
       §A22 trap. Gated on the hazard being within the 640x360 viewport and
       renamed `round-3-hazard-nearby`, because even then it cannot promise a
       LIVE hazard: a meteor impact is instantaneous and a puddle lives 3 s
       against a 1 s poll. That weather ran is asserted from the effect
       lifecycle, never from the picture.

## T9.09 — Bots that carry a round — DONE
Files: crates/game-core/src/bots/mod.rs, crates/game-server/src/room.rs
Verified: `cargo test -p game-core --lib bots` — 11 passed, 1 ignored;
       `cargo test -p game-server --lib` — 86 passed. Measurement:
       `cargo test -p game-core --release --lib bots::lethality -- --ignored --nocapture`.
Notes: NOT A TUNING PROBLEM. THE BOTS HAD NEVER FIRED A SHOT.
       `drive_bots` queued the input and applied `wants_use` and never called
       `world.fire`. Firing is a COMMAND, not a button the sim reads — a human's
       client sends `fire` separately (docs/30 §4) — and `fire_pressed` is
       derived in input.rs and read by NO production code. So the whole
       `should_fire` chain (LOS, blast guard, range) has been dead code since
       T6.14. Fourth mechanism-never-wired defect on this project.
       THE FINGERPRINT WAS IN THE COUNTERS: 16,861 trigger pulls, 0 damage, and
       `rej_cooldown: 0` — a shot that is never taken never starts a cooldown.
       Instrumented BotStats first (§ measure before tuning) rather than guessing.
       Kill chain per round, 4 bots, 150 s, 10 seeds, before -> after:
         damage 0 -> 114 (skill .6) / 143 (.85); rounds with a kill 0/10 -> 2/10.
       Two further measurement-led fixes: MAX_BLOCKED_SAMPLES 12 -> 24 (every
       weapon digs, so a hill is soft cover; LOS rejections 5307 -> 26), and a
       stand-off of max(blast*2, 40) because a flat 40 px walked bazooka bots
       INSIDE their own 63 px blast guard, where the rule that stops them
       suiciding also stopped them shooting (largest rejection reason, 8469).
       TWO OF MY OWN IDEAS MEASURED WORSE AND WERE REVERTED: a near-the-muzzle
       LOS guard (fires 159 -> 20; a bot standing on the ground has rock within
       28 px of its muzzle nearly always), and weapon-preferring shopping.
       The Wander branch is very nearly DEAD CODE: choose_goal only reaches it
       when the map holds no items at all. Replacing its random spawn point with
       "walk toward the nearest player" changed every counter by exactly zero.
       Noted in place rather than left as a comment describing what never runs.
       ACCEPTANCE ASSERTS DAMAGE, NOT DEATHS, AND THAT IS A FINDING. 8 of 10
       rounds still contain zero combat deaths at EVERY skill level, because
       four players with a 320 px sight radius on a 2048x1024 map mostly never
       meet (engagement 4 % of ticks). "median deaths >= 1" fails on a correct
       build; "median >= 0" passes on the broken one. Damage separates them.
       Sight radius was checked for fairness and left alone: a human at screen
       centre sees ~367 px to the corner, so 320 is not blinder than a person.
       BOT_SKILL barely moves lethality (82/114/143/105 damage at 0/.6/.85/1) —
       its effect on kills is close to noise, reported not tuned.
Left for later: T9.08. Encounter rate is a density problem — fewer/closer
       spawns, more bots, or a smaller default map — and is a design call.

## T9.08 — Announce the state that existed before the client — DONE
Files: crates/game-server/src/session.rs, tests/integration.rs
Verified: `cargo test -p game-server --test integration -- --test-threads=1` —
       6 passed. Falsified by not emitting: both new tests go red.
Notes: TWO OF THE THREE WERE ALREADY FIXED, and checking beat assuming — the
       initial world items are sent per socket on join (T9.03) and the score
       table rides in `welcome`'s `players` array (read by the client since
       T9.06's fix). Only `inventory` was still missing.
       The negative test is the point: "a joiner never receives another
       player's inventory" passes against a server that sends no inventory at
       all, which is the build it exists to catch. It only means something
       beside the positive control asserting the owner does get exactly one.
       Sent per socket after `map_init`, owner-scoped like every other
       `inventory` (docs/30 §6), never broadcast.
Left for later: nothing in M9.
       FOLLOW-UP: the join-flow scoping test could not fail. It counted bo's
       TOTAL inventory events and expected 0 — a valid proxy only while nobody
       received one on join, so T9.08 broke it. Rewritten as a DELTA around
       ana's action, which is the property the rule actually claims. Then the
       leak falsification STILL passed: bo never sent `ready`, and T9.06 gates
       flush_events on readiness, so no broadcast could ever reach it. With bo
       readied, changing scope_of to Everyone fails properly. A scoping test on
       an unready socket asserts nothing.

## FINDING (open) — the join window drops carves, exposed by T9.09
Where: crates/game-server/src/{session,room}.rs, `flush_events` readiness gate.
Symptom: `node scripts/e2e.mjs full-round` FAILS on "map resyncs during the
       round: 1-2 per client". Everything else in that check passes: 7-9 deaths
       (6-8 from combat), 3 weather effects, darkness 0->0.82, masks agree,
       165k px destroyed, 0 page errors.
Mechanism: `map_init` is encoded at JOIN with carve_seq = N, but events only
       flush to READY sockets. Every carve between those two moments is dropped
       for that client, so its first delivered carve is M+1 while it expects
       N+1 — a permanent gap, resolved as a full resync 2 s later (docs/42 §6).
       The window has always been open. It was invisible until T9.09 made the
       bots actually fire and a round went from ~1 carve to hundreds.
DO NOT REPEAT: re-sending `map_init` when `ready` is processed makes it WORSE
       (resyncs 1 -> 4, measured). The second map_init resets nextCarveSeq
       while carves are still in flight and opens a fresh gap. Reverted.
Likely correct fix, NOT attempted: separate "ready for events" from "ready for
       snapshots". The snapshot gate is what T6.16 actually needed (the 20 Hz
       stream beat map_init mid-handshake). Carves can be delivered from join
       onward because the client ALREADY buffers them by seq and drains on
       map_init, dropping seq <= N as duplicates — so no gap can form.

## T9.10 — Close the join-window carve gap — DONE
Files: crates/game-core/src/constants.rs, crates/game-server/src/{session,events}.rs,
       crates/game-server/tests/checksum.rs
Verified: `cargo test -p game-server` — 91 lib + 4 bots + 4 checksum + 6 integration
       + 1 join + 12 replay + 14 replay_run, 0 failed. `node scripts/e2e.mjs
       full-round` — **ok, "no map resyncs"** (before: "ana 0, bo 1"), 8 deaths
       all from combat, 168k px destroyed, masks agree, EXIT=0.
Notes: READINESS FOR EVENTS AND FOR SNAPSHOTS ARE DIFFERENT THINGS (§A40). The
       snapshot gate stays on `ready` and is load-bearing — the 20 Hz binary
       stream must not race `map_init` on the same socket. Broadcasts now gate on
       *map delivery* instead: `Delivery::{Queueing,Overflowed,Live}` per socket.
       Events arriving before `map_init` is emitted are HELD, not dropped, and
       flushed in order right after it. Carves already baked into that mask carry
       seq <= N and the client discards them as duplicates, so replaying the whole
       queue is safe — that is why holding beats filtering.
       QUEUEING AND GOING LIVE DECIDE UNDER ONE LOCK. Marking "mapped" after the
       emit and letting flush_events check a flag has a window between encoding
       the mask (seq N) and setting the flag: carves in it are seq > N and would
       be skipped, which is the same gap in a smaller window. `queue_or_emit` and
       `go_live` share the `delivery` lock, so an event either lands in the queue
       that `go_live` drains or is emitted after the drain. Never both, never
       neither.
       Overflow is deliberate (JOIN_EVENT_QUEUE_MAX 4096): drop the queue and send
       a fresh map_init, rather than replay a stream with a hole in it. A client
       that never sends `ready` holds a seat for READY_TIMEOUT_SECS.
       FALSIFIED TWICE AT THE LIVE BINDING SITE: making queue_or_emit drop instead
       of hold fails 3 unit tests by name; restoring the old `is_ready` gate in
       flush_events fails the new integration test with the mask hashes differing
       ("the late-ready joiner's mask diverged from the server's").
       The integration test asserts the PROPERTY, not a count: no hole in the seq
       range, and the replayed mask hash equals the server's. Its control is
       `carves2.len() >= 10` — without carves in the window it would pass against
       a server that drops every one of them.
Left for later: nothing in M9.

## T10.01 — RoomRegistry: many rooms in one process — DONE
Files: crates/game-server/src/{registry,app,session,events,room,state}.rs,
       crates/game-server/tests/rooms.rs, crates/game-core/src/constants.rs (v3 block)
Verified: `cargo test -p game-server --test rooms` — 6 passed; full server suite
       174 passed / 0 failed; fmt + clippy -D warnings clean.
Notes: SCOPING USES THE ROOM'S OWN SessionMap, NOT socket.io rooms. Each room
       already owns the list that backs per-owner delivery, so broadcasts iterate
       that same list and there is one answer to "who is in this room" instead of
       two that can disagree (§A24). Every `io.sockets()` in an output path is
       gone: flush_events, broadcast_except, emit_round_end, emit_mask_checksum.
       FALSIFIED AT THE LIVE BINDING SITE: restoring `io.sockets()` in
       broadcast_except fails with "ana was told about a join in another room,
       left: 1, right: 0". The negative test carries its control —
       `two_clients_in_one_room_do_hear_each_other` — because "neither hears the
       other" also passes for a server whose broadcast is broken entirely.
       MY OWN TEST HELPER HAD THE §A11 BUG IT WAS WRITTEN TO CATCH. It took
       `.last()` of `io.sockets()` to find the newest socket; that collection has
       no defined order, so it picked wrong about a third of the time and seated
       the second client in the first one's room. Set difference against a
       pre-connect snapshot instead. Flaky 1-in-3 -> 6/6.
       A REAL BUG THE SWEEP FOUND: normalise_code folded 'L' -> '1' (Crockford's
       rule), but the alphabet EXCLUDES 0/1/I/O and INCLUDES L — so ~17% of
       generated codes could never be looked up. The single-code test passed
       five times in six. Fixed by not folding at all (every confusable
       character is already absent, so a code containing one was misread and no
       substitution recovers it), plus a 500-code round-trip sweep whose control
       asserts an 'L' actually appeared in the sample.
       /healthz reported a hardcoded `rooms: 1`. The registry publishes into the
       same gauge now — the two-sources-of-truth trap /healthz was already caught
       by once.
       Stack::shutdown is a relay: rooms belong to the registry, so signalling it
       drops them all, and main still waits on the handles so the replay footer
       is written (`docs/41` §7, asserted by two tests).
       emit_to (inventory/damage) is DELIBERATELY UNGATED and now says so in the
       code: broadcasts gate on map delivery (§A40), snapshots on `ready`, and a
       third unwritten rule is how the original join gap survived four
       milestones. Scoped events are JSON (no binary interleave), carry no
       ordering token, and are re-sent at join anyway (T9.08).
Left for later: T10.02 wires the lobby messages; until then a socket joins the
       default room and tests move it via the registry directly. JOIN_EVENT_QUEUE
       overflow is still only asserted at the seam, never through a real socket.

## T10.02 — Lobby protocol: create, join by code, quick match — DONE
Files: crates/game-server/src/{session,registry}.rs, tests/lobby.rs,
       client/src/net/{lobby,lobby.test}.ts
Verified: `cargo test -p game-server --test lobby` — 5 passed;
       `npm --prefix client test -- --run lobby` — 16 passed;
       workspace 815 passed / 0 failed; fmt + clippy -D warnings clean.
Notes: ONE SEATING PATH, FOUR ENTRY POINTS. Extracted the join handler's body
       into `seat()`; create_room / join_room / quick_match choose a room and
       then call it. Four copies would have meant four copies of the name
       validation, the map encode, the join-window flush AND the world-state
       catch-up — and the catch-up alone is three things that were each missing
       once (initial items, scores, inventory: §A39).
       A REAL BUG THE TEST CAUGHT: `attach` was documented "idempotent for the
       same pair" and was not. The lobby attaches, then seat() attaches again,
       so every quick-matched player counted twice — the room's human count
       never reached 0 and it could never be reaped. Caught by asserting the OLD
       room shows 0 humans after leave_room, not by asserting the new one works.
       FALSIFIED AT THE LIVE BINDING SITE: making join_room ignore the code and
       use the default room fails 2 of 5 with "a bad code seated somebody:
       welcomes 1" and "same code, different worlds".
       The e2e test reads the join code OFF THE WIRE (`room_created.code`) and
       types it into the second client, so it proves what a player can actually
       do rather than what the registry knows.
       Hostile codes are rejected before any lookup: normalise_code bounds its
       own output and code_looks_valid gates it, so a 5000-byte "code" never
       reaches a map or a log line. Seven malformed joins -> seven join_errors,
       zero welcomes.
       The client half is Phaser-free (§A8) and shares the alphabet with the
       server, with a test asserting every server-generatable code passes the
       client check — and a control asserting an 'L' appeared in the sample,
       since that is the character the server bug turned on.
Left for later: T10.07 (measure MAX_ROOMS), T10.03 title/attract, T10.04 menu.
       `room_list` currently reports waiting:0 eta_s:0 — quick match seats
       immediately, so there is no queue to report yet; QUEUE_WAIT_BEFORE_BOTS
       is unused until a real queue exists.

## M10 — IN PROGRESS (T10.01, T10.02 done; T10.07/T10.03/T10.04/T10.06/T12.01/T10.05 remain)
State on disk: clean, workspace 815 Rust + 397 client tests pass, fmt + clippy
       -D warnings clean. Multi-room works end to end over real sockets.
Next, in the order the coordinator set: T10.07 (measure MAX_ROOMS before
       anything is built on top of a guessed 8) -> T10.03 title/attract ->
       T10.04 start menu -> T10.06 death overlay -> T12.01 tombstones ->
       T10.05 skins menu (which needs T12.01's tombstone skins).
Carried, for whoever takes T10.07: `/metrics` still lacks §B2's
       rooms_active / tick_p99_ms_max_over_rooms / rooms_over_budget — they are
       T10.07's deliverable. `/healthz` already reports the live count via the
       registry gauge.
Carried, unrelated to M10: JOIN_EVENT_QUEUE overflow is asserted at the seam
       but never driven through a real socket (needs 4096 broadcasts inside one
       join window), and `full-round` is opt-in, so multi-room interactions will
       not be caught by the default gate.

## T10.07 — Measure what a room costs — DONE
Files: crates/game-server/tests/capacity.rs (new), crates/game-core/src/constants.rs,
       crates/game-server/src/{metrics,room,registry}.rs, tests/rooms.rs, tests/checksum.rs
Verified: `cargo test -p game-server --release --test capacity -- --ignored
       --nocapture` (table below); game-server suite 183 passed / 0 failed;
       clippy -D warnings clean.
Notes: THE BRIEF'S PREMISE WAS WRONG AND THE MEASUREMENT SAYS SO. §B2 asked for
       the room count where tick p99 crosses half the 16.67 ms budget. It never
       crosses. 16 cores, release, medium, 6 firing bots/room, 45 s warm-up:
         1 room   p50 0.002  p99 0.004  max 0.009
         8 rooms  p50 0.002  p99 0.009  max 0.051
         32 rooms p50 0.002  p99 0.008  max 0.541
         128      p50 0.003  p99 0.010  max 0.518
       At 128 rooms p99 uses 0.12% of half a budget; per-room cost is flat
       (8 rooms = 1.01x per room vs 1). Control drift 1.5%, so the box was idle
       and these are numbers about the code (§A38).
       MAX_ROOMS 8 -> 32, and the doc comment carries the table, what actually
       bounds it (terrain 648 KiB/room medium, ~1.2 MiB large; room CREATION at
       0.6-1.1 s is the expensive operation, not ticking) AND what was NOT
       measured (the socket layer at 192 concurrent clients; memory under real
       load rather than by arithmetic).
       MY FIRST VERSION MEASURED SIX PLAYERS STANDING STILL — p50 and p99 both
       rounded to 0.000 ms, max 11 us. `full_room` added plain players and
       stepped the world; no bots thinking, no firing, no weather. It would have
       justified any MAX_ROOMS at all. Now it drives bots exactly as
       room.rs::drive_bots does and warms up past EFFECT_INTERVAL_MIN.
       `max_rooms_carries_its_basis` ALSO PASSED FOR THE WRONG REASON at first:
       it checked the doc mentions "T10.07", which the placeholder "Provisional
       until T10.07 measures it" already contained. It requires a p99, a ms
       figure and the machine now, and fails against the placeholder.
       /metrics gains rooms_active, tick_p99_ms_max_over_rooms, rooms_over_budget
       (§B2). Per-room worst tick is tracked separately because the process-wide
       p99 averages one sick room behind seven healthy ones — and Burst makes a
       sick room spike rather than degrade. A dropped room is forgotten, or it
       is reported over budget forever.
Left for later / HONEST GAP: `checksum::a_joiner_that_delays_ready_still_gets_
       every_carve` failed ~1 in 4 while three cargo builds shared the box. It
       waited a FIXED 1200 ms after `ready` and read whatever had arrived, so a
       late carve under load reads as mask divergence. Changed to wait for the
       stream to SETTLE (8 x 50 ms with nothing new). That is strictly better
       regardless — a fixed sleep over an accumulating buffer is a latent flake
       by construction — BUT I COULD NOT FALSIFY IT: under synthetic 8-core busy
       loops the OLD version also passes 4/4, so I never reproduced the failure
       on demand and cannot claim the fix is proven. Bisect was inconclusive for
       the same reason: 0/17 clean at three earlier commits, 2/8 failures at
       HEAD, which is p~0.06 and not decisive. If it recurs, the reproducer is
       real concurrent cargo builds (I/O + memory pressure), not busy loops.

## M10 — IN PROGRESS (T10.01, T10.02, T10.07 + B10 done; T10.03/T10.04/T10.06/T12.01/T10.05 remain)
State on disk: clean, game-server 183 passed / 0 failed, clippy -D warnings
       clean, fmt clean. Multi-room works end to end over real sockets; the
       lobby has create / join-by-code / quick-match / leave.
Next in order: T10.03 title + attract mode -> T10.04 start menu -> T10.06 death
       overlay -> T12.01 tombstones -> T10.05 skins menu (needs T12.01's
       tombstone skins).
For whoever takes T10.03: the attract mode runs game-core in WASM client-side
       with no server, so reuse SandboxScene's local stepping and the T6.14 bot
       controller. §A15 applies to "stop it when the scene is not visible" —
       assert zero ticks after the transition, not that stop() was called.

## T10.03 + T10.04 — Title with a live attract mode, and the Start menu — DONE
Files: crates/game-wasm/src/lib.rs (AttractCore), client/src/core/{attract,index}.ts,
       client/src/scenes/{TitleScene,MenuScene}.ts, client/src/ui/{menu,menu.test}.ts,
       client/index.html, client/src/main.ts, client/package.json,
       scripts/checks/title.mjs, scripts/e2e.mjs, scripts/{e2e-two-clients,checks/full-round}.mjs
Verified: `node scripts/e2e.mjs title` — ok; `npm test -- --run menu` — 10 passed;
       full e2e 16/16; client 407 tests / 28 files; typecheck, fmt, clippy clean.
Notes: THE ATTRACT MODE WRAPS A REAL `World` AND REAL `Bot`s, not GameCore's
       prediction subset — AttractCore ticks think/queue/use/fire/step exactly as
       room.rs::drive_bots does. That is what makes the title screen a smoke test
       of game-core (§B3) rather than a pretty background: a JS-scripted
       background would smoke-test nothing. `Bot::think` needs world.items and
       world.round_time, which GameCore does not have, so a `World` was the only
       honest option.
       "STOPPING IT ACTUALLY STOPS IT" PASSED FOR THE WRONG REASON FIRST. debug()
       read `attract?.tickCount ?? 0`, and after teardown attract is null — so
       the assertion compared 0 against 0 and would have passed however the sim
       behaved. Fixed to a scene-level monotonic counter, plus a control that it
       is non-zero beforehand.
       THEN THE FALSIFICATION FAILED TO FALSIFY: deleting the SHUTDOWN handler
       still passed, because Phaser stops calling update() on a stopped scene
       regardless — "no ticks" is guaranteed by the engine, not by teardown. The
       assertion that actually witnesses the release is `attractTicks === -1`
       (the handle is gone). With both hooks removed it fails properly: "still
       allocated behind the menu (attractTicks 82)".
       §A22 AGAIN, IN THE ONE ENTRY POINT IT MISSED: predev/prebuild/pretest all
       rebuild the wasm; `typecheck` had no hook, so it read a stale pkg and
       reported AttractCore missing. Added pretypecheck.
       THE E2E HARNESS HARDCODED `window.__game` as its readiness condition, so
       it was silently un-runnable for any screen that is not the sandbox. A
       check now declares its own `ready`.
       I BROKE two-clients AND full-round by changing what the default URL shows.
       Both now use `?game=1`, which skips the title: they predate the front end
       and exist to drive a round, not to click through a menu.
       The e2e reads the join code from the DOM (`#host-code`), so it proves what
       a player can see rather than what the socket knows.
       Screenshots looked at: title.png (four bot markers fighting across a
       generated map, evening sky, cave network visible), menu.png, menu-join.png.
Left for later: T10.06 death overlay -> T12.01 tombstones -> T10.05 skins menu.
       MenuScene.setSocket() has NO CALLER yet — the menu emits nothing until the
       app wires a socket into it, which is the §A39 shape and is deliberate here
       only because T10.06 is the task that owns the app-level wiring. If it is
       still uncalled after T10.06, that is a bug.
       The attract camera zoom (0.75) is a presentation number for that scene,
       not a gameplay one; the game's CAMERA_ZOOM is untouched.

## M10 — IN PROGRESS (T10.01, T10.02, T10.07, T10.03, T10.04 + B10 done; T10.06/T12.01/T10.05 remain)
State on disk: clean. Client 407 tests / 28 files, game-server 183, e2e 16/16
       (title included), typecheck + fmt + clippy -D warnings all clean.
A player now meets: title with a live bot fight behind it -> Start Game menu
       (map size, quick match, create/join private, skins) -> lobby.
Next: T10.06 death overlay -> T12.01 tombstones -> T10.05 skins menu.
       T10.06 owns the app-level socket wiring, so MenuScene.setSocket() gets its
       first caller there. The countdown must come from the server's respawn_at,
       not a local timer, or it disagrees with when you actually respawn; and it
       is an overlay, not a pause — assert the world behind it kept ticking.

## T10.06 — Death overlay — IN PROGRESS, BOX NOT TICKED
Files: client/src/ui/{deathOverlay,deathOverlay-math,deathOverlay-math.test}.ts,
       client/src/scenes/GameScene.ts, client/src/net/connection.ts,
       client/src/input/localInput.ts, client/index.html,
       crates/game-core/src/constants.rs, crates/game-server/src/events.rs,
       crates/game-wasm/src/lib.rs, client/src/core/index.ts
Verified: `npm test -- --run deathOverlay` — 11 passed. Gate green otherwise:
       client 418 tests, game-server 183, game-core 559, e2e 16/16, fmt +
       clippy + typecheck clean.
NOT VERIFIED, AND THIS IS WHY THE BOX IS UNTICKED: the overlay has never been
       seen to appear in a running game. Its logic is unit-tested and its
       wiring reads correct (death handler -> DeathOverlay.died, update() calls
       death.update every frame, respawn clears it), but no end-to-end check
       drives it.
What was tried, so the next session does not repeat it:
  1. Kill the local player with their own rocket. Health never moved off 100
     across 40 paced shots. Firing itself works in that harness — the same
     script already asserts terrain removal — so the shots are landing
     somewhere other than the player's feet.
  2. `LocalInput.forceAim` did not survive to the input packet: `sample()`
     recomputes aim from the pointer every frame. Added an `aimLocked` flag
     (kept — it is correct either way). Health still did not move.
  3. Ruled out warmup: added a wait for phase === 'playing' first (§docs/41 §3
     applies no damage during Warmup). No change.
  4. Fed the client a synthetic `death` payload through a new
     `Connection.emitLocal` (runs the real handlers, skips only the wire). The
     overlay still did not raise, and I ran out of budget diagnosing it. The
     e2e block was REMOVED rather than left red — `two-clients` is green.
Next step I would take: check whether GameScene.update() early-returns before
       the `death.update` call in the state the check reaches, and whether
       `debug().roundTime` is populated at that moment (the countdown falls
       back to round_time + RESPAWN_DELAY if respawn_at is not finite).
Landed and sound regardless: RESPAWN_DELAY 3.0 -> 5.0 (§B4, and it is the
       constant here most likely to want playtesting); `death` now carries
       `respawn_at` and `round_time` so a client counts down against the
       server's clock instead of a local stopwatch started on arrival;
       `Connection.emitLocal`; `LocalInput` aim lock.
MenuScene.setSocket IS GONE, and that closes the note I left. The menu records
       a `lobbyIntent` in the registry and `Connection.connect` performs it —
       two sockets would mean two seats, and a `join` after a `quick_match` is
       a double join. `?game=1` leaves the intent undefined and a plain `join`
       happens, which is what every check written before the menu expects.

## T10.06 — Death overlay — DONE
Files: scripts/checks/death.mjs (new), scripts/e2e.mjs,
       crates/game-core/src/player/state.rs, crates/game-core/src/world/mod.rs,
       crates/game-core/tests/world_step.rs
Verified: `node scripts/checks/death.mjs` — 9/9 ok (overlay appears, countdown
       4.2s falling to 2.9, cause "You killed yourself", round kept running
       behind it, cleared on respawn at 100 health). `--test world_step` 26 passed.
Notes: THE PREVIOUS SESSION'S DEAD END #4 WAS THE DESIGN WORKING. A synthetic
       `death` event can never raise the overlay: `DeathOverlay.update` takes
       `dead` from the SNAPSHOT's alive flag (§B4), so an injected event the
       server never agreed with is correctly ignored. Only a real death works.
       The i-frames hypothesis was WRONG — round_time is not reset on phase
       change, so join-time i-frames expire long before Playing. What worked is
       full-round's own selfKill technique: select the rocket slot, aim below
       mid-screen, step onto fresh ground between shots.
       REAL BUG THE CHECK FOUND ON ITS FIRST RUN: a rocket at your own feet
       reported "Killed by weather". apply_damage recorded last_damaged_by only
       for DamageSource::Player, so resolve_deaths saw no recent attacker and
       fell through to Weather. SCORING HID IT — a self-kill and a weather death
       are both -1 with no credit (docs/21 §6) — so only the cause was wrong and
       nothing read the cause until this overlay did. The existing unit test
       could not have caught it: it passes DeathCause::SelfInflicted into
       killer() as its INPUT, handing the function the answer.
       a_respawned_player_is_not_buried_either WAS ALREADY RED at 5013031
       (verified by stashing): it waited `60 * 4` ticks against a RESPAWN_DELAY
       that §B4 moved to 5.0. The wait is derived from the constant now — a wait
       hardcoded against a tunable is a test that expires.
Left for later: T12.01 tombstones, T10.05 skins menu, the M10 checkpoint.

## T12.01 — Tombstones — DONE
Files: crates/game-core/src/world/{tombstones.rs,mod.rs}, player/state.rs,
       crates/game-server/src/{room,session,events,config}.rs, bin/replay.rs,
       client/src/render/{tombstones,tombstones-math,tombstones-math.test}.ts,
       client/src/net/worldMirror.ts, client/src/scenes/GameScene.ts,
       crates/game-wasm/src/lib.rs, scripts/checks/death.mjs
Verified: `--lib tombstones` 5 passed; `--test world_step` 28 passed;
       `--test integration a_mid_round_joiner` passed; `--run tombstones-math`
       8 passed; `node scripts/checks/death.mjs` ok 3/3 consecutive runs.
Notes: WIRED AT FOUR LEVELS BECAUSE UNIT TESTS CANNOT CATCH WIRING (§A39, now
       six times). Tombstones' own tests would all pass if the death path never
       called place(); the world test covers that; the integration test covers
       the join announce; the e2e covers the client actually drawing them.
       THREE WIRING GAPS FOUND, each by the next level up:
       1. `tombstone_skin_id` was parsed from `join` and dropped on the floor.
       2. the client had a `tombstone_spawn` handler in WorldMirror and no
          subscription in GameScene — the e2e said "0 graves" while the server
          held one. §A39 one layer down: a handler with no subscription.
       3. `skin_id` must NOT be in state_hash (PlayerState.skin_id is not
          either) — hashing it would have forced a replay format change for a
          cosmetic the server cannot interpret.
       The cap frees a slot BEFORE pushing: `while len > MAX` does nothing at
       len == MAX and the next push lands on MAX+1 — the WorldItems::cull
       off-by-one. Sabotaging >= back to > reproduces it exactly.
       DEV_START_HEALTH added (sibling of DEV_LOADOUT, dev-only, default off):
       a rocket at your own feet gets weaker every shot because each blast
       deepens the crater, so 8 rockets against 100 health killed on some runs
       and left 22 on others. A coin-flip gate gates nothing (§A28). Only the
       STARTING health is arranged; the kill is a real rocket resolved by the
       server with real attribution.
Left for later: T10.05 skins menu, the M10 checkpoint.

## T10.05 — Skins menu — DONE
Files: client/src/ui/{skins,skins.test}.ts, scenes/SkinsScene.ts,
       render/{tombstoneTextures,tombstoneTextures.test}.ts, render/tombstones.ts,
       render/playerView.ts, main.ts, index.html, assets/skins.json,
       scripts/checks/skins.mjs, scripts/e2e.mjs
Verified: `--run skins` 16 passed; `--run tombstoneTextures` 6 passed;
       `node scripts/e2e.mjs skins` ok (6 characters, 5 tombstones, preview
       cycles 3 frames, weapons shown 3 and disabled, choice survives Esc).
       Full client suite 448 passed / 32 files.
Notes: THE SKINS BUTTON WAS A CALLER WITH NO CALLEE — MenuScene has called
       `scene.start('Skins')` since T10.04 and no such scene was ever
       registered, so clicking it did nothing. §A39 inverted, seventh time.
       The check therefore arrives THROUGH the menu button (`?menu=1`), not at
       `?skins=1`: a check that types the URL would have passed all along.
       TOMBSTONE ART IS PROCEDURAL, like weapons. No Kenney pack ships a grave
       marker, and picking a terrain tile by eye is the §A32 mistake that
       verify-assets now rejects. Five markers differing in SILHOUETTE, not
       palette — at 14x18 the outline is all a player can read, and a picker
       whose options differ only by colour has one option.
       skins.json and tombstoneTextures.ts are two files describing one thing
       (§A24). Rather than plumb one through the other for five entries the
       duplication is CHECKED — that is T10.05's "stops the registry and the art
       drifting apart" test. Falsified: renaming a marker in the art alone fails it.
       MY OWN TEST CAUGHT MY OWN BUG BEFORE IT SHIPPED: `Number('0x2')` is 2, so
       a hand-edited `deepcut.skin` of "0x2" resolved to skin 2. readId now
       requires `String(n) === raw`, making the round-trip the definition.
       PREVIEW ANIMATION IS ASSERTED, NOT ASKED FOR: §B3 wants the walk cycle
       because a still frame hides skins differing only by palette, and a stalled
       animation looks identical to a running one from the caller. The check
       samples the frame 8 times and requires >= 2 distinct. Falsified by setting
       PREVIEW_VX to 0: "only ever showed character_player_idle".
       Also fixed the death overlay covering mid-screen (flagged last session):
       it was `justify-content: center`, putting the scoreboard over the fight it
       exists to let you watch. Top-anchored now.
Left for later: the M10 checkpoint, then M11.

## M10 checkpoint — DONE
Files: scripts/checks/m10-checkpoint.mjs (new), scripts/e2e.mjs,
       crates/game-server/src/room.rs, client/src/scenes/GameScene.ts
Verified: `node scripts/checks/m10-checkpoint.mjs` ok — host creates a private
       room and reads the code OFF THE SCREEN, guest joins by it, a third
       quick-matches into a different room, all three tick (582/585/54 ->
       675/678/147), the host's 4264 px crater appears in the guest's mask with
       an identical checksum, and the third room is untouched.
Notes: TWO REAL BUGS ON THE FIRST RUN, both invisible to every unit test.
       1. NOTHING SUBSCRIBED TO `room_created`. The reducer case existed and was
          unit-tested, `net/lobby.ts` decoded the event, and no client code ever
          handled it — so creating a private game never showed anyone the code,
          which is the only thing a private game is for. §A39, eighth time.
          GameScene now shows a banner during warmup and keeps the code in the
          HUD strip after, and the check reads it from the DOM.
       2. EVERY ROOM SHARED ONE HARDCODED SEED (`0x5EED_1234_ABCD_0001`). With
          one room that was a placeholder; with many it means every game on the
          server is played on an identical map, and the same map again after a
          restart. The 999-seed sweep was generating one map in practice. Seeds
          now mix a per-process base with the room id; FIXED_SEED still pins
          everything, because that is what it is for (docs/41 §5).
       MY FIRST UNIT TEST FOR THAT FIX COULD NOT FAIL: it tested `mix_seed`
       directly, so restoring the hardcoded seed left it green — it never
       exercised the decision about whether to CALL mix_seed. The live-binding
       version builds two rooms and compares masks, and does go red.
       MY FIRST TWO CHECKPOINT ASSERTIONS WERE ALSO WRONG, and measuring is what
       showed it: `debug().seed` is the CLIENT's core placeholder (it reads 1 in
       every room, so comparing it compared two constants), and `debug().tick`
       does not exist, so `undefined <= undefined` is false forever. Room
       identity is the mask checksum; ticking is `lastServerTick`.
Left for later: M11 (the arsenal), M12 is done.

## T11.01 — Melee, cone and placed delivery — DONE
Files: crates/game-core/src/weapons/{melee,cone,placed,burn,defs,mod,projectile}.rs,
       world/mod.rs, crates/game-core/tests/delivery.rs
Verified: `cargo test -p game-core --test delivery` — 17 passed; full crate 661
       passed / 5 ignored, golden table unchanged.
Notes: THE COMPILER FOUND THE WIRING FOR ME. Adding three Delivery variants made
       two matches non-exhaustive — `world::fire` and `projectile::step` — which
       is every place that decides what a weapon does. Named both rather than
       adding `_ =>`: a catch-all would have compiled and silently made melee do
       nothing, which is §A39's shape and the reason five mechanisms here were
       built and never wired.
       ONE FIRE SYSTEM, NOT THREE. `weapons/burn.rs` is a shared BurnField using
       the LAVA_BURN_* numbers; the flamethrower's trail, molotov patches and
       lava's afterburn are the same disc-that-damages. Writing a second per
       weapon is the §A24 mistake.
       I ALMOST ADDED A SECOND `for_victim`. melee.rs originally carried its own
       `to_damage_source` with identical logic to explode.rs's private
       `for_victim`. Made that pub(crate) instead — two copies of attribution is
       how a self-kill starts reporting "weather" again.
       §A24 APPLIED BEFORE THE BUG: `Mines::step` removes a mine and then needs
       to report the carve its blast caused, so it returns MineOutcome carrying
       pos and radius rather than an id to something already freed — the exact
       trap projectiles hit in M5.
       THE state_hash TRIPWIRE FIRED, as designed: `E0027: pattern does not
       mention fields burn, mines`. Both are simulation state (an armed mine
       changes who dies), so both hash themselves via hash_into next to their
       own fields per §A34, including Mines' next_id — two worlds with identical
       mines about to allocate different ids are not the same state.
       Falsified four ways at the live binding site: dropping melee's LOS check,
       ignoring arm_time, letting a mine trigger on its owner (each fails only
       the test that names it), and making the cone's map `&mut` — that last one
       is a COMPILE error, which is stronger than a red test: `&Map` makes fire
       structurally unable to dig.
Left for later: T11.02 battery, then T11.03-T11.09.

## T11.02 — The battery, shields and shield-piercing — DONE
Files: crates/game-core/src/{constants.rs, player/state.rs, items/registry.rs,
       weapons/defs.rs, bots/mod.rs}
Verified: `cargo test -p game-core --lib battery` — 8 passed; full crate 671
       passed / 5 ignored, EXIT=0, golden table unchanged.
Notes: ONE FIELD, THREE BEHAVIOURS. `WeaponDef.energy_cost` is the ammo an
       energy weapon spends, the check try_fire makes instead of a stack count,
       and what makes a hit pierce a shield. Three separate flags could
       disagree; a cost cannot. The pierce rule lives in apply_damage beside the
       shield rule it modifies and reads the weapon out of the DamageSource the
       caller already passes — so still exactly one damage path (§A24) and no
       caller has to remember a "this was a laser" flag.
       TWO REGISTRIES INDEX BY ARRAY POSITION AND NEITHER SAID SO. `def()` in
       both weapons and items does `TABLE.get(id as usize)`, silently assuming
       position == id. I inserted the lasers at the front and every weapon
       lookup shifted — a laser resolved as a bazooka, and the only symptom was
       a pierce test failing for the wrong reason. Both now `.filter(|d| d.id ==
       id)` and both have `*_ids_match_their_positions`, which names the
       offending entry. Falsified by re-inserting at the front.
       AN INVARIANT RESTATED, NOT WEAKENED: "a weapon has max_stack > 1" is
       false for energy weapons, whose stack IS the weapon. Now "a weapon has
       ammo, and ammo is a stack or a battery" — stricter, because the old rule
       passed a weapon with neither.
       THE LASER ITEMS DO NOT SPAWN YET, and that is measured. Bots pick a
       weapon only when a stack empties, so they can neither switch to a laser
       nor away from an uncharged one: with lasers in the pool, `ticks_engaged:
       0` over 36,000 ticks; the identical run with only the battery pack fights
       normally. The defs land here because §B5 is untestable without one; the
       ITEMS wait for T11.04 to give bots weapon selection. I also made
       `selected_weapon` mean "able to fire" (armed 5003 -> 3503) and taught
       bots to charge — both correct and neither sufficient.
       A COIN-FLIP ASSERTION REMOVED, and its own doc comment was the evidence:
       `a_round_of_bots_is_a_fight` asserted "some kill across 5 seeds" while
       documenting that ~8 of 10 rounds have zero kills on a correct build —
       about a 1-in-3 failure rate by arithmetic. It passed only because those
       five seeds held a lucky one, and adding ONE item reshuffled the seeded
       spawn stream. Damage stayed above the floor throughout, so lethality never
       changed; only the coin landed differently (§A28).
Left for later: T11.03 ballistics, then T11.04-T11.09.

## T11.03 — Handguns and automatics — DONE
Files: crates/game-core/src/{constants.rs, items/registry.rs, weapons/defs.rs},
       crates/game-server/src/events.rs, crates/game-wasm/src/lib.rs
Verified: `cargo test -p game-core --lib ballistics` — 5 passed; full crate
       EXIT=0, golden table unchanged.
Notes: T11.01 LEFT THE WORKSPACE UNBUILDABLE AND NOBODY NOTICED. Its Done-when is
       `cargo test -p game-core` — crate-scoped — so the four new GameEvent
       variants never reaching `scope_of`/`name_of`/`payload_of`, and the three
       new Delivery variants never reaching game-wasm's fire path, went unseen:
       4 compile errors at HEAD, confirmed by `git stash`. A crate-scoped
       Done-when cannot see a workspace break; only ./scripts/check.sh can.
       Fixed by naming every arm — and game-wasm's sandbox fire path returns an
       explicit `melee_not_in_sandbox` rejection rather than a `_ => {}`, because
       a catch-all compiles and makes the weapon silently do nothing (§A39).
       THE SPEC TABLE IS THE TEST. `SPEC` transcribes §B7 and the test asserts
       the set of ballistic weapons EQUALS the set the table covers, so adding a
       weapon without numbers fails rather than being silently uncovered.
       Falsified three ways at the live binding site: machinegun spread -> 0 fails
       the "spread is not being applied" count (a bound test alone passes for a
       weapon whose spread became zero); deagle carve 6 -> 3 fails BOTH the table
       and the behavioural breach-comparison; dropping pistol from SPEC fails the
       exhaustiveness assertion by name.
       Weights are provisional per §B17 and T11.09 rebalances the whole table.
Left for later: T11.04 energy (bot weapon selection is written, not yet tested).

## T11.04 — Energy weapons — DONE
Files: crates/game-core/src/{bots/mod.rs, items/registry.rs},
       crates/game-server/src/room.rs
Verified: `cargo test -p game-core --lib energy` — 5 passed.
Notes: THE BLOCKER WAS SELECTION, AND IT IS A COMMAND. Nothing in `Input` carries
       a slot change (`docs/30` §4), so the only thing that had EVER changed a
       bot's selection was the inventory auto-advancing on an empty stack — and
       an energy weapon's stack never empties. Added `Bot::wants_select`, applied
       by room.rs AND by the test harness. The harness mattering is the point:
       it already carried a comment saying a harness that skips `fire` "measures
       a game nobody plays", and it was skipping selection for the same reason.
       MY FIRST TEST DID NOT DISCRIMINATE AND THE FALSIFICATION IS HOW I KNEW.
       "Run a round with lasers in the pool and assert bots engage" passed with
       `wants_select` disabled: at spawn weight 10 in a fourteen-item pool, most
       bots never pick one up inside 60 s, so the assertion was about the spawn
       table rather than about selection (§B11 — ask what a pass rules out).
       Replaced with `run_round_holding`, which puts a FLAT laser in every bot's
       selected slot and a loaded pistol in the bag. Falsified: disabling
       selection gives "four bots holding an unusable weapon dealt no damage in
       60 s (fires 8, rej_unarmed 0)", restored gives damage > 0.
       Laser weights are now non-zero (10/14/12 and 6/10/8) — below their
       ballistic counterparts, because a laser found without charge is worth less
       than a pistol found with ammo and the weights should say so.
Left for later: T11.05 melee weapons.

## T11.05 — Knife, bat, whip, axe, hammer — DONE
Files: crates/game-core/src/{constants.rs, items/registry.rs,
       weapons/{defs,melee}.rs, player/state.rs}
Verified: `cargo test -p game-core --lib t1105` — 5 passed; `--lib weapons::defs`
       — 11 passed.
Notes: A KNIFE DELETED ITSELF ON ITS FIRST SWING, and I found it by asking what
       `try_fire` does before writing the test. It consumed a stack for anything
       that was not an energy weapon; melee has `max_stack: 1`; measured probe:
       `knife count after one swing = None`. §B7 says melee never runs out and is
       the floor of the arsenal — a weapon that vanishes when used is the most
       complete way to be worthless. Fixed with `WeaponDef::spends_stack()`,
       DERIVED from the def rather than a third flag, for the same reason
       `energy_cost` is a cost rather than an `is_energy` flag: a stored
       `consumes_ammo` could disagree with the delivery kind and this cannot.
       Falsified by restoring the old rule: "knife was consumed by swinging it 20
       times".
       ITS CONTROL IS A PISTOL IN THE SAME HARNESS. "Melee is never consumed"
       also passes for a build where nothing is ever consumed, so the sibling test
       asserts a 3-round pistol runs dry over 10 shots.
       §A3 RESTATED, NOT WEAKENED (see §B18 request below). `every_weapon_digs`
       asserted every weapon carves, and §B7 gives knife/bat/whip carve 0 while
       §B6 says fire does not dig. It now asserts every weapon does DAMAGE, and
       every non-exempt weapon carves, with the exemptions listed BY NAME and a
       second assertion that each named exemption is a real melee weapon — so a
       rename cannot silently widen the exemption to cover nothing. Stricter than
       the rule it replaces, which passed a weapon that carved and did no damage.
Left for later: T11.06 flamethrower, T11.07 mines, T11.08 grenades, T11.09 balance.

## T11.06 — Flamethrower — DONE
Files: crates/game-core/src/{constants.rs, items/registry.rs,
       weapons/{defs,cone}.rs}
Verified: `cargo test -p game-core --lib t1106` — 4 passed.
Notes: THE CONE PLUMBING ALREADY EXISTED (T11.01), so this is defs + item + the
       tests that pin §B7. One fire system, not two: the trail is the shared
       LAVA_BURN_* hazard (§A24).
       A TEST OF MINE PASSED FOR THE WRONG REASON AND I KEPT IT ANYWAY, RELABELLED.
       `spraying_leaves_the_terrain_byte_identical` stays green when the
       flamethrower is given blast_radius 8.0 — because `spray` takes `&Map` and
       is STRUCTURALLY unable to dig, exactly as T11.01 intended. So what it
       witnesses is the type signature, not the weapon def. That is a stronger
       guarantee than a test (a compile error beats a red run), but the comment
       now says so, and the assertion that actually guards the radius is
       `it_matches_the_spec_and_does_not_dig`, which does go red. §B11: ask what
       a passing assertion rules out — and when the answer is "the framework
       provides it", say that rather than deleting the test.
       THE AMMO INVARIANT NEEDED ITS THIRD RESTATEMENT. Melee has NEITHER a stack
       nor a battery, so `weapons_carry_ammo_and_consumables_do_not` failed on the
       whole melee row. It now asks `WeaponDef::spends_stack()` — the same
       predicate `try_fire` uses — instead of growing a third special case, so
       the registry's idea of ammo and the sim's cannot drift. Falsified by giving
       the knife max_stack 4.
Left for later: T11.07 mines, T11.08 grenades, T11.09 balance.

## T11.07 — Proximity mines — DONE
Files: crates/game-core/src/{constants.rs, items/registry.rs,
       weapons/{defs,placed}.rs, world/mod.rs}, tests/delivery.rs
Verified: `cargo test -p game-core --lib t1107` — 3 passed.
Notes: MINES WERE INDESTRUCTIBLE IN A REAL ROUND. §B6 says a mine is destructible
       by explosions — "which is what stops a map filling up with them" — and
       `destroy_in_blast` had NO PRODUCTION CALLER: only tests. So the rule was
       tested and never enforced, and `MineEnd::Destroyed` was a variant nothing
       ever constructed. Ninth instance of §A39, and the unit test could not see
       it because it CALLED THE FUNCTION ITSELF. Wired into `emit_blast`, which
       is the single choke point every blast already goes through, and
       `destroy_in_blast` now returns `MineOutcome` so the reason travels with it.
       A destroyed mine does not detonate (`explosion: None`) — chaining would
       turn one rocket into a cascade, which `docs/31` §5 already forbids.
       ADDED `World::explode_for_test` rather than let the test reach past
       `detonate`. A test that drives a different path than the game runs is how
       `destroy_in_blast` sat uncalled while its unit test stayed green.
       Falsified by disabling the new call: "an explosion did not destroy the
       mine". Control: a blast 400 px away leaves it standing.

## §B17 IN THE WILD — bots_actually_hurt_each_other_over_a_round
       Adding eleven items across T11.03–T11.06 reshuffled the seeded spawn
       stream and turned SEED 99 into a round where four bots never meet
       (`engaged 0, fires 0, damage 0`, but `pickups 8` — they shopped, they just
       never found each other). Measured across eight seeds: damage
       191/0/644/0/401/31/210/0 — five of eight fight.
       The test asserted a POPULATION claim from a SINGLE draw, which is exactly
       how `a_round_of_bots_is_a_fight` became a coin flip before it was removed.
       It now aggregates over eight seeds and requires damage > 0 overall, a
       trigger pulled in half the rounds, and blood drawn in at least three —
       stricter than one lucky seed, and immune to a spawn reshuffle. Falsified
       by disabling the harness's fire call.
       STILL OPEN, not mine to fix here: bots meet rarely on a 2048x1024 map with
       a 320 px sight radius. That is the encounter-rate item an earlier session
       flagged, and it is a design call (fewer/closer spawns, more bots, or a
       smaller default map), not a bot bug.

## NOTED, NOT FIXED — the new arsenal has no art
       T11.02–T11.07 added thirteen items whose `sprite` keys do not exist in
       `assets/atlas-map.json`, which holds only the original six
       (item_medkit/shield/flashlight, weapon_bazooka/grenade/smg). Per
       `docs/50` §8 each falls back to a placeholder and logs once, so nothing
       breaks — but every new weapon looks identical on the ground, in a game
       whose whole loop is finding weapons. The client test that would catch it
       uses a fixture rather than the live registry (`itemSprites-math.test.ts`),
       so it stays green: §A39's shape again, in the test rather than the code.
       This is art work, not core work — it belongs with T7.02's atlas builder,
       and it needs its own task. Listed here so it is not discovered by a player.

## T11.08 GROUNDWORK — read this before starting it
       `BurnField` is ALREADY the right abstraction for the toxic grenade's
       zone. `light_for(pos, radius, dps, duration, source)` is a general
       "damaging ground zone": per-patch radius, rate, life and attribution, one
       tick loop, one hash, overlapping patches stacking. A toxic zone is that
       with different numbers, and the ONLY real difference is how the client
       draws it (green, not orange).
       So T11.08 should add a `kind` to `BurnPatch` (Fire | Toxic) rather than a
       second field with a second damage loop — §A24, and the same call T11.06
       already made when the flamethrower reused the lava burn instead of writing
       its own fire. `effects/toxic.rs`'s `ToxicRain` is NOT reusable for this:
       it is a scheduler with its own cadence and RNG stream, not a zone
       container.
       Remaining in T11.08: airburst (bursts at apex or 1.2 s into AIRBURST_PELLETS
       energy pellets — they interact with shields per §B5), smoke (no damage at
       all, and its FOV_SMOKE_MULT crosses into the client's FoV formula, which
       has a Rust/TS cross-check that will need extending), molotov (BurnField,
       6 patches), toxic_grenade (BurnField with the new kind, and the mask must
       come out BYTE-IDENTICAL — no terrain damage, same assertion toxic rain
       carries).

## NOT DONE, AND IT IS MINE — the ordnance the server sends has no client
       T11.05-T11.07 landed the SIMULATION of melee, the flamethrower and mines
       and their Done-when commands pass. Their client rendering did not land, so
       `game-server` now emits four events NOTHING subscribes to: `melee`,
       `cone`, `mine_placed`, `mine_ended`. Verified by grepping both ends.
       That is §A39's shape, the tenth instance on this project, and this time I
       created three of them with the pattern fully documented in front of me.
       It matters because the design says so in as many words: §B6 — "a mine must
       be VISIBLE at close range — invisible instant death is not fun; a trap you
       could have spotted is" — and T11.05's notes, "a melee hit you cannot see
       reads as damage from nowhere".
       Written up as **T11.10** with the count-at-both-ends test whose absence let
       it ship: client live-mine count 0 -> 1 -> 0 asserted against the server's.
       The sandbox path is honest about it already (`melee_not_in_sandbox` etc.
       rather than a silent no-op), so the gap shows there rather than looking
       like a misfire.

## FLAKE, NOT A REGRESSION — lobby::a_second_client_joins_a_private_room_by_its_code
       Failed once inside `cargo test --workspace` and passes 3/3 standalone. At
       that moment I had two workspace cargo runs AND a clippy sharing the box —
       my own contention. Same signature the T10.07 entry records for socket
       tests under real concurrent cargo builds (and the coordinator hit the vite
       version of this too). Not investigated further; recorded so the next
       session does not read it as new.

## T11.08 — Airburst, smoke, molotov, toxic — DONE
Files: weapons/{smoke,burn,defs,projectile}.rs, world/mod.rs, items/registry.rs,
       constants.rs, game-server/{codec,events}.rs, client/{net/codec,scenes/GameScene}.ts,
       tests/thrown.rs
Verified: `cargo test -p game-core --test thrown` — 14 passed; game-core lib 598;
       clippy -D warnings clean; client codec 20 passed.
Notes: `Burst` IS A FIELD ON THE DEF, NOT FOUR DELIVERY VARIANTS. All four fly
       identically and differ only in what happens when they stop; a smoke that
       fell differently from a molotov would be a second projectile simulation to
       keep in step. `detonate` matches it exhaustively, so a new burst kind is a
       compile error at the one place that decides what going off means.
       SMOKE IS ITS OWN FIELD, NOT A BurnField WITH dps 0. The journal's guidance
       to add a `kind` to BurnPatch was right for TOXIC (done: BurnKind::Fire |
       Toxic, one tick loop, one hash). Smoke is different in kind: it is read by
       the FoV formula and never by the damage path, so folding it in would mean a
       damage loop iterating clouds forever to apply nothing.
       THREE BUGS THE TESTS FOUND, TWO OF THEM REAL:
       1. MOLOTOV_SCATTER was 46 against LAVA_BURN_RADIUS 28, so the six patches
          sat on a ring with an UNBURNT HOLE AT THE IMPACT POINT — a molotov that
          lands on you does nothing. Found by the control half of the smoke test
          ("fire should burn", 100 -> 100). Scatter is now 24, below the radius,
          and the constant's doc says why it must stay there.
       2. THE APEX BURST MISSED A CEILING. Detecting the vel.y sign change never
          fires when the grenade clips rock on the way up, because the bounce sets
          velocity to ZERO rather than crossing through it — so it fell and landed
          as a dud, the exact failure §B7 names. Now `Projectile::rose` plus
          "first tick not rising", which covers apex and ceiling alike.
       3. A test point inside rock produced zero-length pellet rays. Mine, not the
          code's.
       §A39 CAUGHT BEFORE IT SHIPPED, NOT AFTER: `GameScene` hardcoded `fogMult: 1`
       and `World::fog_multiplier` had NO CALLER AT ALL — heavy fog has been
       simulated every round since M5 and changed nothing anyone could see. Smoke
       would have been the same bug one milestone later, since it uses that
       channel. Fixed by a sixteenth snapshot byte, `vision` = fog x smoke,
       computed per player because smoke is POSITIONAL: what you can see depends
       on which cloud you stand in, so a global effect flag cannot express it.
       SNAPSHOT_PLAYER_BYTES 15 -> 16, 108 bytes for six players.
       THE PELLET NEEDED TWO OF energy_cost's THREE BEHAVIOURS (§B16): pierce yes,
       charge no. It works because pellets are fired by `burst_pellets`, never by
       `try_fire`, which is the only place battery is spent — and
       `an_airburst_costs_the_thrower_no_battery` guards the day someone routes
       them through the normal path. Its control asserts the pellet really is
       energy, or the claim is vacuous.
       `codec.test.ts` hardcoded `const per = 15`. Now pinned to the constant
       (§A19) — a fixture that hardcodes the wire layout can stay GREEN against a
       drifted decoder, which is the failure worth preventing.
       every_weapon_digs RESTATED, NOT WEAKENED: a weapon whose whole effect is
       what it leaves behind carries its numbers on the burst, so the rule is now
       "a Blast weapon damages and carves, and every other burst must actually do
       something" — which rejects a Zone with dps 0, where the old rule only ever
       looked at damage.
Left for later: T11.10 (the four hazard kinds are counted by GameScene and DRAWN BY
       NOTHING — task file updated to cover them), T11.11, T11.09.

## T11.10 — Draw the ordnance the server already sends — DONE
Files: client/src/render/{ordnanceFx,ordnanceFx-math,ordnanceFx-math.test}.ts,
       scenes/GameScene.ts, crates/game-wasm/src/lib.rs, client/src/core/index.ts,
       crates/game-server/src/room.rs, scripts/checks/ordnance.mjs, scripts/e2e.mjs
Verified: `--run ordnanceFx-math` 16 passed; `node scripts/e2e.mjs ordnance` ok on
       3 consecutive runs; gate GATE_EXIT=0, 896 rust tests, e2e 20/20.
Notes: THE COUNT-AT-BOTH-ENDS ASSERTION IS THE TASK. Client live mines vs the
       server's own narration (placed − ended). Falsified by deleting only the
       DRAW half and keeping the counters: "server 1−0=1, client draws 0". One
       number — "the server placed a mine" — passes for the whole period the bug
       existed.
       MY CHECK WAS FLAKY AT ~1-IN-3 AND THE CAUSE WAS A DESIGN FEATURE:
       `fire_ready_at` is per PLAYER, not per weapon (deliberate, so swapping
       cannot bypass a cooldown), so firing right after another weapon is
       rejected silently. Fixed with `fireUntil`, which retries on the EFFECT
       rather than the attempt. §A28 — a gate that fails on a coin flip gates
       nothing, so this was fixed rather than accepted.
       I THEN MADE THE CHECK DO PLATFORMING AND IT WALKED INTO A WALL (x=16) AND
       OFF A LEDGE (mine 200 px overhead). None of it was needed: the fx layer is
       at DEPTH.particles, above DEPTH.actors, so a mine at your feet already
       draws over your own sprite. Deleted all the walking.
       ORDER MATTERS BETWEEN SECTIONS: rocketing your own feet to destroy the
       mine costs health and craters the ground, so it must come last. Placing a
       mine costs nothing, so place-and-photograph goes early, before the molotov
       fire that otherwise fills the frame (§A22).
       §B15 IN MY OWN LOG LINE: printed `burnt.hazards` (top-level) where the
       counter is `observed.hazards`, and it rendered "server announced
       undefined". Now asserted, with a guard that a non-number is a failure.
       Mine marker is drawn bold and outlined because it sits at the BODY CENTRE
       of whoever placed it — a marker the placer cannot see is §B6's "visible at
       close range" failing in the one frame where it matters.
Left for later: T11.11 (arsenal art), T11.09 (balance).

## T11.11 — Art for the arsenal — DONE
Files: client/src/render/{itemTextures,itemSprites,itemSprites-math.test,__liveRegistry}.ts
Verified: `--run itemSprites-math` 19 passed; gate GATE_EXIT=0, 896 rust tests,
       e2e 20/20; two-clients "items: 8 drawn of 8 tracked".
Notes: THE GAP WAS 18, NOT THE 13 §B20 ESTIMATED — measured against the live
       registry rather than counted by hand. battery_pack, four ballistic, two
       energy, five melee, flamethrower, mine and four thrown.
       THE OLD TEST USED A TWO-ENTRY FIXTURE. That is the whole of §B20: a test
       validating data against a copy of that data validates nothing. The new
       block reads `registry.rs` and `atlas-map.json` — the same two files the
       game reads — and its first assertion is that the registry is populated,
       or every check below it passes for an empty list.
       DISTINCT BY SILHOUETTE, NOT PALETTE: a revolver has a cylinder, a whip is
       the only curve, a mine is a squat dome, a molotov is the only thing with a
       neck. At 16 px on the ground the outline is all a player can read — the
       same conclusion T10.05 reached for tombstones, and the §A32 mistake in
       reverse (differently-named, near-identical art passes every structural
       check and fails the actual requirement).
       `itemSprites.spawn` only ever looked in the ATLAS, so a procedural texture
       could not be found however well it was drawn. Packed art still wins;
       procedural is the `docs/51` §5 fallback, not a competitor.
       Falsified by deleting the whip painter: "expected [ 'whip -> weapon_whip' ]
       to deeply equal []" — it names the item, not just a count.
Left for later: T11.09 (balance).

## T11.09 — Balance the arsenal by measurement — DONE
Files: crates/game-core/tests/balance.rs (new), src/constants.rs,
       src/items/registry.rs, src/weapons/melee.rs, docs/71-amendments-v3.md,
       scripts/e2e-two-clients.mjs, scripts/e2e.mjs
Verified: `cargo test -p game-core --release --test balance -- --ignored
       --nocapture` — 20 weapons x 8 seeds x 4 bots x 30 s = 960 bot-seconds each;
       outliers 6 -> 1. Gate GATE_EXIT=0.
Notes: MY INSTRUMENT WAS WRONG BEFORE THE ARSENAL WAS. Counting
       `attacker.is_some()` folds in SELF-damage, so molotov (2.14) and toxic
       (2.38) came top of the table. Corrected to `attacker != victim` they read
       0.46 dealt / 1.68 self and 0.60 / 1.79 — three times more harm to their
       user than to anyone else. It reported a liability as the game's strongest
       weapon, in the one row a reader looks at first.
       ONE CHANGE, WITH A CONTROL THAT WAS ALREADY IN THE DATA. Four melee
       weapons sat under half the median; the whip did not. Same delivery kind,
       same bots, same maps — reach is the only systematic difference and it
       predicted hit rate almost exactly (26/28/30 -> 0.47/0.26/0.38 %, whip 58
       -> 3.0 %). Reaches to 36/40/40/38, whip UNTOUCHED at 58. After: knife
       0.47->0.80, axe 0.23->1.26, hammer 0.15->0.73, and WHIP 1.10 -> 1.10.
       The unchanged control reading identically is what makes it a measurement
       rather than a reshuffle.
       A SECOND CHANGE MEASURED WORSE AND WAS REVERTED. Flamethrower range
       150->200 gave 0.37->0.30 dealt with self-damage 0.28->0.44. Fire leaves
       burning ground and its user walks into it — the same root cause as
       molotov and toxic. The bot blast-guard checks a blast RADIUS and knows
       nothing about a hazard that lingers, so more reach only spreads more fire
       to stand in. A bot-AI gap, not a weapon-balance one; tuning the weapon
       would have treated the symptom.
       deagle 2.06 (2.0x) LEFT ALONE: dps cannot see capacity. 8 rounds = 360
       damage per pickup vs pistol 560, machinegun 1320. Added a `dmg/pick`
       column so the trade is visible instead of inferred. smoke excluded from
       the median — §B7 says it has no damage, so judging it against a damage
       median reports a correct weapon as the worst in the game.
       Spawn floor 5/6/7 -> 8; every item now spawns at least once (was
       `hammer: 0`).
       THE E2E SCRIPTS WERE LEAKING VITE. `npm run dev` forks vite as a
       GRANDCHILD and both scripts killed only the direct child — ten orphans
       were accumulating, which IS the "loaded box" blamed for three flakes.
       Now `detached: true` + `process.kill(-pid)`. Also replaced the fixed
       1500 ms sleeps in two-clients with `settle()`, which waits for the masks
       to stop changing: a fixed sleep over an accumulating buffer passes idle
       and fails loaded, so waiting on the effect makes load irrelevant instead
       of moving the threshold.
THE GATE IS RED, AND IT IS NOT THIS TASK — CONTROLLED. `two-clients` fails
       inside a full suite run and passes standalone (3/3) and through the suite
       path alone. The previous three sightings blamed CPU contention; that is
       WRONG. The repro is deterministic and cheap:
       `node scripts/e2e.mjs m5-weather two-clients` fails every time,
       `node scripts/e2e.mjs two-clients` passes. `ordnance` fails the same way
       when placed straight after m5-weather. Symptom is EXACTLY 0.0 px moved and
       0 px of terrain destroyed while the map decodes and items draw — the
       client's fixed-timestep loop is not advancing, not running slowly.
       Leading hypothesis: Chromium throttles rAF on non-foreground pages, and a
       standalone spec opens contexts while the suite holds its own page open.
       ATTRIBUTION CONTROLLED: `git stash` of this session's two script edits,
       rerun, still fails. Written up as T11.12 with the repro and three
       candidate fixes, rather than left as a fourth "flaky" sighting.
Left for later: item DENSITY, not weights — ~12-15 spawns per round against 24
       item types means a round shows you about half the arsenal. If "tons of
       weapons" should be felt in a single round, INITIAL_ITEMS and
       ITEM_SPAWN_INTERVAL are the levers, and both are outside this task.

## T11.12 — One spec breaks the next one — DONE
Files: scripts/proc-group.mjs (new), scripts/e2e.mjs, scripts/e2e-two-clients.mjs,
       scripts/checks/{m5-weather,ordnance,death,full-round,m10-checkpoint}.mjs,
       scripts/{shot,drive,net-smoke}.mjs
Verified: `node scripts/e2e.mjs m5-weather ordnance two-clients death` — 4/4, no
       leaks. LOAD CONTROL: two-clients under 14 busy loops FAILED at load 9.91
       before the fix (`selecting slot 2 changed nothing`), PASSED at load 28.18
       after it — nearly 3x heavier than the load that broke it.
Notes: THE TASK FILE'S HYPOTHESIS WAS WRONG AND I DISPROVED IT FIRST. Two
       concurrent browsers, both pages visible, both hasFocus true, both rAF
       advancing (314 and 180 frames), BOTH moved 221.4 px. Not rAF throttling,
       not backgrounding. The "deterministic repro" then PASSED on a clean box —
       the only thing I changed was killing 4 orphaned vite and 2 chrome first.
       THE PREVIOUS SESSION'S ATTRIBUTION CONTROL WAS INVALID: `git stash` of its
       own edits does not kill orphans already running, so it measured a loaded
       box and concluded its leak fix had not worked. The three earlier
       "contention" sightings were right about the cause; the load was
       self-inflicted and accumulating.
       MECHANISM: leaked processes -> loaded box -> the client steps fewer fixed
       timestep ticks per wall-clock second -> every assertion that measures over
       a WALL-CLOCK WINDOW becomes a coin flip. The movement check survived (it
       polls); the slot-select check did not (fixed 250 ms). Load is the
       mechanism; fixed-duration waits are the vulnerability.
       FIVE scripts hand-wrote `child.kill()` over a grandchild. `npx vite`,
       `npm run dev` and `cargo run` all fork the process holding the port, so
       the wrapper is reaped and the server orphaned. One shared
       `scripts/proc-group.mjs` now, so it cannot be written a sixth time.
       THE GUARD: e2e.mjs samples stray pids before and after and fails on any it
       created (§A39, count at both ends). It found MY OWN false positive twice —
       it counted the suite's own vite (killed by the exit handler that runs
       after) and a chromium still winding down from browser.close(). Fixed by
       shutting down first and re-sampling after a grace window: a process that
       exits on its own was never leaked.
       I ALSO MADE THE BUG I WAS SENT TO FIX. My load generators were
       `timeout 240 bash -c 'while :; done'`; killing the `timeout` parents
       orphaned 32 busy loops permanently and pushed the box to load 31.5, which
       then contaminated the very next measurement.
Left for later: T11.14, T11.13 — not started.

## T11.14 — Bots walk into their own fire — IN PROGRESS (mechanism works, criterion not met)
Files: crates/game-core/src/bots/mod.rs
Verified: `cargo test -p game-core --lib bots` — 18 passed. Falsified both halves
       at the live binding site: disabling the movement override fails only
       `a_bot_steps_out_of_fire`; disabling the throw guard fails only
       `a_bot_does_not_throw_a_molotov_at_its_own_feet`. Both controls
       (`..._does_not_walk_away`, `..._does_throw_from_a_safe_distance`) stay
       green in each case, so neither absence passes for a bot that never moves
       or never throws.
Notes: Two gaps, both perception not mechanics: `hazard_at` reads the existing
       `BurnField` (no second hazard registry), and only within FOV_DAY — a bot
       reacting to fire it cannot see would be cheating (§A5).
       `zone_reach` guards on radius+scatter, because `blast_radius` is 0 for
       exactly the weapons that needed a guard: a rule written against
       blast_radius never fires for a Burst::Zone weapon.
       SELF-HARM FELL AS INTENDED, AND THE STATED ACCEPTANCE CRITERION IS NOT
       MET. 20 weapons x 8 seeds x 4 bots x 30 s:
         molotov  self 1.68 -> 0.95 (-43%), dealt 0.46 -> 0.14
         toxic    self 1.79 -> 0.60 (-66%), dealt 0.60 -> 0.05
         flame    self 0.28 -> 0.32,        dealt 0.37 -> 0.36
       "Self-damage below damage dealt" is still false, and the RATIO got worse
       (molotov 0.27 -> 0.15). Fires are unchanged (71 -> 73), so bots throw as
       often and land less.
       WHY, AND IT MAY BE THE INSTRUMENT AGAIN: both sides now avoid the fire.
       A zone weapon that successfully denies space damages nobody, and
       damage-per-bot-second cannot see denied space — the same blind spot that
       forced smoke to be excluded from the median in T11.09. The harness also
       arms each bot with ONE weapon all round, so a molotov-only bot that must
       hold >94 px and flees any fire has no follow-up. Before claiming the fix
       works or the weapons are bad, the metric needs to measure area denial
       (time an enemy is kept off ground, or forced repositioning).
Left for later: decide the metric, then re-judge. T11.13 not started.

## T11.14 — Bots walk into their own fire — STILL IN PROGRESS (measures built, one outlier left)
Files: crates/game-core/src/bots/mod.rs, crates/game-core/tests/balance.rs
Verified: `cargo test -p game-core --lib bots` — 19 passed. Gate GATE_EXIT=0,
       903 rust tests, e2e 20/20.
Notes: BUILT §B24'S MEASURES. denied-ground-seconds counts surface points inside a
       patch x the ground each stands for x dt — walkable only, because a molotov
       burning the inside of a cliff has denied nobody anything and raw area would
       score it the same. Smoke gets `blind s` instead: it denies sight, not
       ground, so folding it into denial reports the wrong thing about the one
       weapon §B7 says has no damage. Deflections count only hazards an ENEMY lit
       (`Hazard.lit_by`) — a bot fleeing its own fire has denied nobody anything,
       and counting it would score a weapon highest exactly when it hurts its user
       most, which is the mistake T11.09's first instrument made.
       §B24'S SELF-HARM CRITERION WAS ALSO UNMEETABLE AS WRITTEN. "Below the
       arsenal median" — 14 of 20 weapons are hitscan and sit at exactly 0.00, so
       the median is 0.00 and nothing that self-harms can be below it. And
       `blast_radius` is the wrong structural test for "can hurt its user": it
       doubles as the CARVE radius, so an axe (10) and the smg (3) read as
       explosive. The class is now "weapons that demonstrably hurt their user in
       the measurement" — median 0.68 over 6.
       A SECOND PLACE `blast_radius` WAS THE WRONG NUMBER. `stand_off` used it,
       and it is 0 for exactly the Burst::Zone weapons, so a bot closed to the
       40 px floor and stood in the fire it had just thrown. `zone_reach` already
       existed for the throw guard. Fixed -> molotov denial 6515->8507, deflect
       305->774, dealt 0.14->0.25, fires 73->111.
       SELF/BOT-S ROSE (0.95 -> 1.54) AND THAT IS A RATE ARTEFACT: per throw it is
       flat (0.0130 -> 0.0139), and toxic IMPROVED per throw (0.0072 -> 0.0052).
       The metric conflates "dangerous per use" with "used more".
       NOT TICKED. Final: flamethrower 0.32 and toxic 0.68 now meet §B24; molotov
       1.54 is still the arsenal's only outlier. RESIDUAL CAUSE, evidenced: the
       throw guard tests `dist` to the TARGET (`dist < reach + HAZARD_CLEARANCE`),
       not where the projectile will land. A molotov is ballistic — thrown uphill
       or into terrain it falls short, onto the thrower, and no target-distance
       guard can see that. Needs impact prediction; its own task.
       I ALSO SILENTLY DISABLED AN EXISTING TEST. My inserted `#[test]` stole the
       attribute belonging to `a_bot_steps_out_of_fire`; `cargo test --lib bots`
       reported "19 passed" while a T11.14 falsification test had left the run.
       Only clippy's `never used` under -D warnings caught it. A test count going
       UP is not evidence no test was removed.
Left for later: molotov impact prediction. T11.13 done below.

## T11.13 — Item density — DONE
Files: crates/game-core/src/constants.rs, crates/game-core/tests/balance.rs
Verified: `cargo test -p game-core --release --test balance -- --ignored --nocapture`
       — density_report passes its floors. Gate GATE_EXIT=0, 903 rust, e2e 20/20.
Notes: MEASURED AT EVERY SCALE (§A19), and the shipping one was not the problem
       the task described: Small 51% / Medium 58% / LARGE 64% of a 24-item
       registry. The "about half the arsenal" figure was Small-scale;
       DEFAULT_MAP_SCALE is Large.
       MY OWN INSTRUMENT UNDERCOUNTED FIRST. Initial placement runs inside
       World::new before any event buffer exists (the same fact behind T9.03's
       unannounced items), so counting spawn EVENTS missed the whole initial
       batch: 10.2 distinct became 12.2 once read from the world.
       TURNOVER, NOT ACCUMULATION. Raising the rate alone pushes live items into
       MAX_WORLD_ITEMS, where eviction deletes what spawned two minutes ago —
       churn that measures like density. ITEM_SPAWN_INTERVAL 20->14 PAIRED WITH
       WORLD_ITEM_TTL 90->70: distinct 51/58/64% -> 57/64/70%, peak live 14/22/27
       -> 14/20/27 (flat or LOWER), first weapon 18/20/23s -> 13/14/16s.
       Floors asserted per scale, not exact values — the seeded spawn stream
       reshuffles whenever the registry changes (§B17), so pinning a number would
       make adding an item a test failure. Each floor carries a control
       (`mean_spawn > 10`) or it passes for a round that spawned nothing.
       Falsified by restoring both constants: fails with "Small: a round shows
       12.2 of 24 item types, below the 12.5 this task raised it to".
Left for later: nothing in T11.13.

## T11.16 — Make players meet — DONE
Files: crates/game-core/src/constants.rs, crates/game-core/tests/balance.rs,
       crates/game-server/src/config.rs, scripts/checks/death.mjs,
       crates/game-server/tests/checksum.rs
Verified: `cargo test -p game-core --release --test balance -- --ignored` — 4 passed.
       Shipping config over a real 240 s round: fought 7/8, 1st contact 24s,
       seen 8/8. Control (the old Large + 4): fought 1/8.
Notes: THE SHIPPING CONFIG HAD NEVER BEEN MEASURED. The "5 of 8 seeds contain a
       fight" figure came from the balance harness, which hardcodes Small + 4
       bots. The game shipped Large with BOT_COUNT_DEFAULT 3 — where the survey
       reads 0/8 fought, 8.6% of ticks with anyone in sight.
       THE DECOMPOSITION DECIDED THE LEVER. `near%` and `los%` track each other
       everywhere (8.6/8.5, 66.5/64.6), so terrain is NOT what keeps players
       apart — distance is; and `armed%` is flat at 28-43% across every config,
       so it is not item scarcity either. Damage tracks near% directly. Without
       those two columns the obvious move would have been item density, which
       T11.13 had just moved and which the data says is not the constraint.
       DEFAULT_MAP_SCALE Large -> Medium and BOT_COUNT_DEFAULT 3 -> 5, both with
       the table in their doc comments. Medium is still 4.8 x 4.3 screens at
       CAMERA_ZOOM 2, so §A1's "explore, don't survey" survives; Large stays
       behind MAP_SCALE=large. Falsified by restoring both: fought 1/8, 1st
       contact 142s, seen 5/8 — FAILED.
       THE BALANCE HARNESS NOW USES THE SHIPPING CONFIG TOO (BOT_COUNT_DEFAULT+1
       seats, DEFAULT_MAP_SCALE). Every per-weapon number moved: median dmg/bot-s
       1.03 -> 1.00, knife 0.80 -> 0.61, bazooka 0.75 -> 1.00. A table measured
       at a player count the game does not ship is a table about another game.
       TWO TESTS PINNED TO THE OLD DEFAULTS AS LITERALS (§B22): config's
       "documented defaults" test asserted MapScale::Large and bot_count 3, and
       reported a deliberate change as a failure. Both read the constants now.
       AND ONE HARDCODED CARVE COORDINATE: checksum.rs carved at (300,700),
       which is open sky on Medium — both hashes then matched and the test failed
       claiming the mask hash is insensitive, when nothing had been carved. The
       T11.10 entry records the identical trap at (300,300). It locates rock now.
Left for later: `mine` is a new low outlier at 0.20 = 0.20x median. Mines need
       traffic and the shipping map has less of it than the old harness implied.

## T11.15 — Bots aim thrown weapons at where they land — DONE
Files: crates/game-core/src/weapons/projectile.rs, crates/game-core/src/bots/mod.rs,
       crates/game-core/tests/thrown.rs
Verified: `cargo test -p game-core --lib bots` — 20 passed.
       molotov self/bot-s 1.32 -> 0.23, toxic 0.63 -> 0.34, class median 0.34.
Notes: `docs/22` §6's client trajectory preview WAS NEVER BUILT, so there was no
       shared implementation to reuse. What is shared instead is everything that
       decides where a projectile goes: a real `Projectile`, M2's `substeps`, the
       same `bounce`, the same resting rule, the same fuse and apex checks in the
       same order. `prediction_agrees_with_the_simulation` is the contract — a
       predictor that disagrees is worse than none, because the bot refuses safe
       throws and takes unsafe ones with equal confidence.
       MY FIRST PREDICTOR IGNORED BOUNCING and the agreement test caught it in
       under a minute: smoke predicted 44.4 px from where it landed. Smoke and
       toxic have fuses and bounce; first contact is not the impact.
       THEN THE TEST ITSELF WAS CONTAMINATED. It stood the thrower at the throw
       origin, and a toxic grenade arced up, bounced, fell back and was removed
       by hitting THEM — 42 px from where the arc ends. That is the scenario the
       feature exists to prevent, but it is not what the predictor claims: it
       models terrain only, because a body in the way can only make the hazard
       land sooner, which is the safe direction to be wrong in.
       Falsified twice at the live binding site: ignoring bounces -> 44.4 px vs a
       15.8 px tolerance; removing the guard from `should_fire` -> the wall test
       fails. That test asserts `rej_impact_guard > 0` rather than just "did not
       throw", because the old distance guard could produce the same silence.
Left for later: nothing in T11.15.

## T11.14 — Bots walk into their own fire — DONE (criterion met)
Files: crates/game-core/tests/balance.rs (numbers only)
Verified: `cargo test -p game-core --release --test balance -- --ignored` — 4 passed.
Notes: TICKED ON §B24'S CRITERIA, NOT THE ORIGINAL ONE. "Self-damage below damage
       dealt" was withdrawn because both sides now avoid the fire and a zone
       weapon that denies space successfully damages nobody. On the replacement
       measures, all three zone weapons pass: self-harm at or below the 0.34
       class median (molotov 0.23, toxic 0.34, flamethrower 0.14), denial
       materially non-zero (7151 / 18511 / 1997 px-s of walkable ground), and
       deflections real (968 / 772 / 1708).
       The mechanism landed in the previous session; what unblocked the box was
       T11.15 removing the residual cause, exactly as that session predicted.
Left for later: nothing.

## T13.02 — Assert on rendered pixels — DONE
Files: scripts/checks/pixels.mjs (new), scripts/e2e.mjs
Verified: `node scripts/e2e.mjs pixels` — ok. Gate: 905 rust, e2e 21/21, EXIT=0.
Notes: DONE BEFORE T13.01, not after — T13.01's own Done-when is
       `e2e.mjs terrain-render`, a pixel spec, so the task list inverts the
       dependency. Building the harness first is the only order that works.
       The self-test's value is the three NEGATIVE cases: assertChanged must
       fail on an identical pair, fail when the control also moved, and refuse
       a missing control outright. A harness that cannot report "no change" is
       the §A15 failure it exists to prevent, so it proves it can.
       Samples carry a digest as well as a mean: two arrangements with the same
       mean (mirrored gradients) must not read as identical, and the test pins
       that at lum 127.5 for both.
Left for later: T13.01 uses this; further specs in T13.03-T13.06.

## T13.01 — One render path, and the rebake nobody wired — DONE
Files: client/src/render/worldView.ts, scenes/{SandboxScene,GameScene}.ts,
       client/src/render/worldView-math.test.ts, scripts/checks/terrain-render.mjs
Verified: `npm test -- --run worldView` 4 passed; `e2e.mjs terrain-render` ok —
       crater changed 96.9, control held 3.0. Full e2e 22/22, rust 905.
Notes: THE FIX IS A DRAIN, NOT A CALL. `update()` now empties the core's dirty
       set every frame, so it does not matter who carved or whether they
       remembered — GameScene needed NO change to start rebaking. Adding
       `markDirty` to the game scene would have been a third caller who can
       forget, and forgetting was the bug.
       SandboxScene migrated onto WorldView: ~50 lines of inline stack deleted.
       MY OWN TEST WOULD HAVE PASSED AGAINST THE BUG. Falsifying the drain left
       the crater region moving 15.5 — decorations are removed by a different
       path and their disappearance alone cleared my minDelta of 10. Raised to
       40 (real: 96.9, falsified: 16.4) and re-falsified both ways.
       THE SECOND-CARVE TARGET WAS IN OPEN AIR at first: `target.x + 140`
       carved nothing, and the failure read as "the renderer dropped a carve".
       It locates solid rock now — the T11.10/checksum.rs trap, third time.
       The layer-parity control had to be derived from both crater positions;
       a control chosen before you know where the subject is, is not a control.
Left for later: cross-scene layer parity asserts the sandbox set only — `?game=1`
       cannot build a world without a server, so the two-scene comparison belongs
       in a check that runs one. Deferred to the M13 milestone verification.

## T13.03 — Missiles, grenades and bullets you can see — DONE
Files: client/src/render/{ordnance-state,ordnance,worldView}.ts + test,
       scenes/{GameScene,SandboxScene}.ts, scripts/checks/ordnance-visible.mjs
Verified: `e2e.mjs ordnance-visible` ok — core 1 alive / layer 1 drawn, patch
       changed 24.5, control 0.0. Gate: 905 rust, e2e 23/23, EXIT=0.
Notes: THIRTEENTH §A39. `OrdnanceLayer.addProjectile` existed, the mirror had
       tracked projectiles since T6.08, and nothing called one from the other.
       WorldView owns the layer now and `syncProjectiles` DIFFS against the
       authoritative live list rather than replaying add/remove events, so a
       missed despawn self-corrects instead of leaving a rocket in the air —
       the sandbox's old loop never removed anything at all.
       TWO COLOUR TABLES existed (KIND_COLOR in ordnance.ts, and the new LOOK);
       collapsed to one. Two sources of truth for one thing is §B16's shape.
       WEAPON_KEYS mirrors the positional Rust registry and is PINNED to
       defs.rs by a test — falsified by swapping two entries. §B16 is the bug
       where that assumption was silent and a laser resolved as a bazooka.
       The both-ends count is what catches the original bug: falsifying the
       sync gives "1 alive and 0 drawn" before any pixel is examined.
Left for later: T13.04 weather, T13.05 crates, T13.06 round end.

## M13 — IN PROGRESS (3 of 6) — handoff
Done: T13.02 (pixel harness), T13.01 (one render path + the rebake), T13.03
       (visible ordnance). Tree clean, gate green: 905 rust, e2e 23/23.
Remaining: T13.04 weather-visible, T13.05 crates, T13.06 round-end.
Context the next session needs:
  - `scripts/checks/pixels.mjs` is the harness: samplePatch / assertChanged.
    assertChanged REFUSES to run without a control, so pass one.
  - Frame the subject by reading its real position from `__game`, then converting
    with `debug().worldView` + `.zoom`. Offsetting by a guess put a carve in open
    air and a control inside a blast, twice, in one session.
  - Set a pixel threshold by FALSIFYING first. Mine was 10 and the falsified build
    still scored 15.5, so it would have passed against the bug. Real 96.9.
  - Add both-ends counters to the debug handle (`projectilesLive/Drawn` is the
    pattern). It caught the ordnance bug before any pixel was sampled.
  - Cross-scene layer parity is still only asserted for the sandbox: `?game=1`
    cannot build a world without a server. Worth a standalone check that runs one.

## T13.04 — Weather you can see — DONE
Files: client/src/render/{weather,weather-math}.ts + test, worldView.ts,
       scenes/{GameScene,SandboxScene}.ts, scripts/checks/weather-visible.mjs
Verified: `--run weather-math` 9 passed; `e2e.mjs weather-visible` ok — 260 drops
       drawn, sky changed 42.0 against a 4.4 noise floor, lava 210 embers from
       3 jetting vents. Gate: 905 rust, e2e 24/24, EXIT=0.
Notes: §B21 AGAIN — the sim was right and nothing reached the screen. Puddles
       were drawn as discs and the RAIN never was, so an 8 s downpour looked
       like a few green circles.
       EMITTERS, NOT ENTITIES: a fixed pool of drops that wrap, so a downpour
       costs what a drizzle costs. Tested by running 10 s of rain and asserting
       the pool size never changes.
       THE FIRST VERSION MEASURED 36.6 AND THE DROPS WERE INVISIBLE. The
       vignette was created second at the same depth, so it drew OVER the rain
       and washed it out — the delta was real and it was entirely the green
       cast. Only looking at the screenshot caught it; the number went 36.6 ->
       42.2 while the picture changed completely.
       The check derives its threshold from a measured NOISE FLOOR (two dry
       frames, ~4.4) rather than a constant: the sky animates, so zero is wrong
       and any fixed number is a guess.
Left for later: meteors ride T13.03's projectile path (r=8, trail 14) and are
       not separately asserted. The game passes [] for vents — lava embers are
       exercised through the sandbox only.

## T13.05 — Crates fall, land, and can be picked up — DONE
Files: crates/game-core/src/{items/world.rs,world/mod.rs}, game-server/src/{events,session}.rs,
       client/src/{net/worldMirror.ts,render/itemSprites{,-math}.ts,render/worldView.ts,
       scenes/GameScene.ts}, scripts/checks/crates.mjs, e2e.mjs, e2e-two-clients.mjs,
       scripts/checks/terrain-render.mjs
Verified: `--lib crate` 15 passed; `e2e.mjs crates` ok — fell 558 px over 53 samples,
       drawn position agrees with the server, canopy 90.7/80.1 vs sky (floor 45.0,
       control 10.9), picked up and undrawn at both ends. Gate: 910 rust, e2e 25/25.
Notes: TWO REPORTED BUGS, ONE CAUSE, AND NOT IN THE SIMULATION. Sampling first
       showed crates already fell correctly and were already pickupable. What did
       not exist was any way to learn a crate had MOVED since it was created:
       `ItemSpawn` carries the creation position, which for a crate is the sky. So
       every client drew it at y=48 forever and "cannot pick it up" meant "cannot
       pick it up THERE". New `ItemMove` event — at SNAPSHOT_HZ while airborne, and
       ALWAYS on landing, off the cadence, because the resting position is the only
       one that lasts and a periodic emit hits it only by luck.
       THE LAYER-PARITY CHECK EARNED ITS KEEP. `ItemLayer` was built in GameScene
       alone, so its parachute Graphics at depth 19 existed in one scene and not
       the shared stack — §C0 restarting inside the milestone that exists to end
       it. WorldView owns the item layer now; the sandbox gets an empty one, which
       is the correct outcome. Falsified by moving the depth to 18: both checks go
       red naming the difference.
Left for later: TWO OrdnanceLayer instances live in GameScene (its own for tracers
       and impacts, WorldView's for projectiles). Same depth, so the depth-set
       parity check cannot see it. Not touched — out of scope for a crates task and
       T13.03's verified behaviour rides on it.

## T13.06 — The round ends — DONE
Files: client/src/ui/{results-math,results-math.test,results}.ts, scenes/GameScene.ts,
       client/index.html (styles), scripts/checks/round-end.mjs, scripts/e2e.mjs
Verified: `--run results` 10 passed; `e2e.mjs round-end` ok — control (absent while
       playing), screen up at `ended`, all 3 players listed, input stopped
       1702 -> 1702 while holding a key, both buttons, voting registers.
Notes: THE FIRST VERSION PASSED EVERY ASSERTION AND WAS INVISIBLE. `.results-screen`
       existed in the DOM, both buttons existed, voting registered — and no CSS for
       it existed, so the screenshot showed the field and nothing else. The check now
       asserts VISIBILITY (laid-out box, not display:none/hidden, opacity > 0.1), not
       presence. §C2's "a hidden element is not a HUD", learned again.
       MY FALSIFICATION WAS ALSO A NO-OP FIRST: I injected `display: none` at the
       START of the rule, where the rule's own later `display: flex` overrides it.
       The check stayed green and I nearly concluded it could not fail. Appending
       `display: none !important` after the rule fails it properly.
       TWO SPEC/IMPL DEFECTS FOUND, NEITHER FIXED (both outside Touch only):
       (1) `round_state` carries phase/time_left/seed and NO vote data, so a client
       cannot show a tally. My first draft rendered `${votesFor}/${connected}` from a
       `votes_for` field that does not exist — `Number(undefined ?? 0)` is 0, so it
       would have shown a confident `0/4` forever and never failed (§B15). The line
       states the rule instead.
       (2) `round.rs::restart_wins` takes `connected`, does `let _ = connected;` and
       returns `yes * 2 > cast` — a majority of those who VOTED. Its own doc comment
       says "Majority of connected players", and `docs/41` §3 says both "majority of
       connected" AND "non-voters abstain", which cannot both hold — the same shape
       as §A23's "never repeat / re-roll once". The code picked the sane reading.
Left for later: `leave_room` (§B9) has no client method; Exit closes the socket,
       which the server already treats as leaving (`docs/40` §6). T14.06 owns the
       quit path and `connection.ts`. Also: `deathOverlay.ts` has a private
       `escapeHtml`; `results-math.ts` now exports one. Two escapers is §A24's shape.

## T13.06.1 — No battle exists until players ask for one — DONE
Files: crates/game-core/src/constants.rs, game-server/src/{app,main,room,round,replay,session,
       config}.rs, src/bin/replay.rs, tests/{lobby,integration,replay,replay_run,bots,checksum,
       join,rooms}.rs, client/src/{net/connection.ts,scenes/GameScene.ts},
       scripts/checks/lobby-start.mjs, scripts/e2e.mjs
Verified: `--test lobby` 11 passed; `e2e.mjs lobby-start` ok — rooms 0 on a fresh
       server, arrives in a lobby with a map and tick 0->0, one human waits past
       2x the countdown, "Start with bots" -> warmup, 4 players, panel clears.
       Falsified: restoring the bootstrap room fails the first two assertions.
Notes: A ROOM IS BORN IN LOBBY AND SEATS NO BOTS. `begin_round` is the one place
       a round starts, so bots cannot be seated by a second path.
       MY OWN ROUND.RS TESTS COULD NOT TELL HUMANS FROM SEATS — they pass
       humans==connected, so falsifying `humans` to `connected` left all 23
       green. The distinction only exists where bots hold seats, so the real
       test is at the Room level: last human leaves a running round -> back to
       Lobby, with 3 bots still seated. That one falsifies properly.
       AND `test_config()` SETS bot_count 0, so every lobby test passed against
       a build that seats bots at construction — the bug itself. Added
       `a_lobby_room_has_no_bots` with bot_count 4; it goes red on that build.
       THE LAG WARNING WENT PERMANENTLY WRONG: `expected` ticks came from task
       start, so a room that waited 10 s in a lobby reported `lagging=608`
       forever and poisoned `tick_overruns`. Re-based when the round starts.
       A JOINING CLIENT WAS NEVER TOLD ITS PHASE: a Lobby room does not tick, so
       it broadcasts no `round_state`, and the lobby panel never appeared. §A39
       again — `seat()` now sends `round_state` like it sends `inventory`.
       THE 10 s HANDSHAKE BUDGET EXPIRED WITH THIS CHANGE. `join` now CREATES
       the room, and creating one generates a map (§B2: 0.6-1.1 s idle). The
       old budget was sized for a world where the room already existed. Raised
       to 30 s, and both halves of the control measured: at load 16 the 10 s
       budget fails 3-4 of 11; at load 43 the 30 s budget passes 11/11. My
       first control ran at load 9 and PASSED, so the hypothesis was unproven
       until the load was raised — reported as unproven until it was not.
Left for later: `join` now means quick match, so "room full" is a property of a
       *specific* room; integration's capacity test joins by code instead.
       `record_tick` still runs for a Lobby room, recording ~0 us ticks that
       flatter the p50/p99; the loop really is running, so it is arguable, but
       it is worth a deliberate decision.
       Bots still fire while walking (T13.06.3). Touched outside Touch only:
       main.rs and bin/replay.rs (compile breaks from the Command/Replay enums),
       and 6 test files whose harness waited for a tick a lobby never produces.

## T13.06.1 (follow-up) — the replay suite hung, and it was the CPU burner — DONE
Files: game-core/src/world/mod.rs, game-server/src/{room,bin/replay}.rs,
       tests/{replay_run,lobby,room,round,skeleton}.rs
Verified: `cargo test --workspace` 921 passed EXIT=0; fmt + clippy -D warnings clean.
Notes: §C18 froze `world.tick` — it is incremented inside `step()`, and a Lobby
       room does not step. Every replay loop is `while tick < until`, so a
       recording with a lobby in it SPINS AT 100% CPU FOREVER. That is the
       runaway the coordinator found eating the player's machine.
       `World::tick_idle()` advances the clock without simulating. §C18 says a
       lobby does not *simulate*; `tick` is a clock, not a step count. The
       "does not tick" test now asserts `round_time == 0.0`, which is STRICTER —
       round_time advances only inside step(), whereas tick advances in both.
       Reported as a spec reading, not a doc edit.
       MY FIRST FALSIFICATION PASSED. I changed two things (clock + fixture) and
       falsified only the clock; the fixture carried it. Falsifying the other
       axis passed too — so the test could not tell a real round from 1400 idle
       lobby ticks, and would have passed against any build. Added a non-vacuity
       assert (phase != Lobby); with both reverted it now names the reason in
       1.34 s instead of hanging.
       STALL GUARDS in the runner and the test loop turn any future frozen clock
       into a named error rather than a silent spin.
       FOUR MORE HARNESSES ASSUMED A ROOM IS ALREADY FIGHTING: room.rs (one
       human never moves), round.rs x3 (a room "starts in Warmup"), skeleton.rs
       (min_players_to_start pinned to a literal 1). cargo stops after a failing
       target, so each fix revealed the next — 859 -> 896 -> 911 -> 918 -> 921.
Left for later: the browser suite is still 22/27 (T13.06.1's reopen); T13.06.11
       reaper; T13.06.2-.9. The 5 e2e failures are NOT all lobby-entry — `crates`
       walks at a crate 300 px above it on a ledge, and `death` shows the alive
       flag going false with the overlay never appearing.

## T13.06.1 (reopened) — one `enterBattle`, and five checks that were not all lobby bugs — DONE
Files: scripts/checks/harness.mjs (new), scripts/checks/{crates,death,ordnance,round-end,
       full-round,m10-checkpoint,lobby-start}.mjs, scripts/e2e-two-clients.mjs
Verified: see the e2e tally at the end of this entry.
Notes: 731 lines deleted, 193 added. Eight checks each hand-wrote the same ninety
       lines of stack setup; five broke on one lobby change. `startStack` +
       `enterBattle(page, {press, waitPlaying})`. No check sets
       MIN_PLAYERS_TO_START any more — that was the split (3 did, 5 did not).
       ONLY TWO OF THE FIVE WERE LOBBY-ENTRY. `death` reported "health 40->40,
       overlay never appeared" — the round had simply never started. `crates` was
       a real fixture failure: the crate landed 300 px up a ledge, so the walker
       now FLIES (every player has a jetpack; tuning the seed would have been
       tuning the symptom).
Left for later: T13.06.6's tracer half, T13.06.10.

## T13.06.11 — the room reaper has a caller — DONE
Files: game-server/src/{app,registry,config}.rs, game-core/src/constants.rs,
       game-server/tests/rooms.rs
Verified: `cargo test -p game-server --test rooms` 9 passed; `e2e lobby-start` ok.
Notes: A sweep on ROOM_REAP_INTERVAL (2 s) holding a **Weak** registry ref, so a
       test's Stack dropping ends the loop instead of leaking one per server.
       FALSIFIED: with the reap call removed the end-to-end test names the reason
       — "room 1 outlived its TTL: nothing in the running server calls reap()".
       Neither test calls `reap`; a test that calls the function is not a caller.
SPEC GAP (report, not fix): `ROOM_EMPTY_TTL` is now a server env var — needed so
       the end-to-end test observes a real reap instead of sleeping 30 s — and
       `docs/41` §5's environment table does not list it.

## T13.06.2 — melee reach from the body edge, and the measurement it owes — DONE
Files: game-core/src/{constants.rs, weapons/melee.rs, world/mod.rs}
Verified: `cargo test -p game-core --lib melee` 9 passed; balance harness below.
Notes: `melee::effective_reach()` = PLAYER_W/2 + table reach, applied ONCE in
       `world/mod.rs`. The first version added it inside `swing`, which left the
       broadcast `Carve` and the drawn arc measuring from the centre: the server
       dug 8 px from where it said it dug, so EVERY axe swing diverged every
       client's mask and forced a full resync. `two-clients` could not see it —
       both clients agreed with each other while both disagreed with the server.
BALANCE, 8 seeds x 6 bots x 30 s, dmg/bot-s:
                    knife  bat  whip   axe  hammer  median
  T11.09 baseline    0.80 0.88  1.10  1.26   0.73   ~1.00
  fire gate only     0.41 0.80  0.73  0.57   0.58    0.77
  gate + C19 reach   0.36 0.21  0.69  0.19   0.10    0.69
       So §C19's reach cut puts **bat, axe and hammer back below half the
       median** — the exact shortfall T11.09 measured and fixed. The whip, whose
       reach moved least, is the control (0.73 -> 0.69).
       §C19's prescribed compensation (wider arc, faster swing) WAS TRIED and
       MEASURED WORSE — knife 0.36 -> 0.15 on *more* swings, which nothing about
       a wider arc explains — so it is reverted and recorded in `constants.rs`.
       Reported rather than tuned away, as the task asks.

## T13.06.3 — you cannot fire while moving — DONE
Files: game-core/src/{constants.rs, world/mod.rs, player/state.rs, bots/mod.rs,
       weapons/{explode,melee}.rs}
Verified: `cargo test -p game-core --lib fire_gate` 8 passed.
Notes: §C20 CONTRADICTS ITSELF — refuse above FIRE_MOVE_MAX_SPEED, *and*
       knockback must not stop you firing, when knockback IS velocity. First
       resolution used `grounded`, and it made the gate COSMETIC: hold D to
       WALK_SPEED, jump, release D, fire at 150 px/s — and bots are airborne
       40-90 % of ticks. Worse, the test written to validate it hand-set
       `vel.x = KNOCKBACK_MAX; grounded = false`, which is byte-identical to
       jump-and-shoot, so it could not have failed.
       Now provenance: `PlayerState::knocked_until`, KNOCKBACK_FIRE_GRACE 0.6,
       stamped by ONE `World::note_knocked` from a new `knocked` list on
       ExplosionResult/MeleeResult (four impulse paths, one guard). The key term
       is checked FIRST, so a blast does not buy 0.6 s of run-and-gun.
       `knocked_until` IS IN `state_hash` — it decides whether a projectile
       spawns, and §A34 is exactly about unhashed timers.
       Bots mirror it and now drop JUMP/UP so they actually land. Measured:
       refusals 910/1063 -> 454, and `button::DOWN` was inert (its only consumer
       needs JUMP held) so it was removed rather than left looking load-bearing.
       `the_measurement_is_reproducible` went red at its 10 s window because the
       first shot now lands at t~13 s; widened to 25 s, control kept.
SPEC GAP (report, not fix): §C20's two bullets cannot both hold literally. The
       `knocked_until` exemption is a reading, not a doc edit.

## T13.06.4 / T13.06.5 / half of T13.06.6 — one defect, three symptoms — DONE
Files: game-core/src/{world/mod.rs, effects/{toxic,meteor}.rs, weapons/{defs,explode}.rs,
       items/registry.rs, constants.rs}, game-server/src/events.rs,
       game-wasm/src/lib.rs, client/src/{net/worldMirror.ts, scenes/GameScene.ts,
       render/ordnance-state.ts}
Verified: `cargo test -p game-core --lib toxic` and `--lib meteor` pass; workspace 639.
Notes: NOTHING EVER ADVANCED A PROJECTILE'S POSITION ON THE CLIENT. `worldMirror`
       stored x,y at `projectile_spawn`; there was no `projectile_move`,
       projectiles are absent from snapshots, and nothing integrated vx/vy — so
       `syncProjectiles` redrew every projectile at its muzzle for its whole
       life. Meteors spawn at y=-32, above the map, hence "only the explosion is
       visible". This is §C7's crate bug one layer over: `item_move` was added
       for items and nothing equivalent existed for projectiles.
       AND IT IS WHY T13.03's PIXEL TEST PASSED: `SandboxScene` reads live
       positions from the core each frame, so the sandbox does not have the bug.
       The test samples a different, working source (§C23 candidate 3).
       Falsified by disabling the emit: "meteor 0 was announced at y=-32 and its
       position was broadcast 0 time(s)".
       Two more, both pre-existing: weather effects anchored their cadence at the
       TELEGRAPH and dumped a 3 s catch-up burst on their first active tick (28
       drops, not 20); and meteor impact fragments have never been announced to
       any client since M5.
SPEC DEFECT (report, not fix): T13.06.5's ">=1.5 s dodge window" comes from
       §C22's "700 px/s crosses 1536 px in about two seconds", which assumes
       CONSTANT SPEED — `docs/13` §4 says meteors fall under gravity in the same
       paragraph. Measured, seed 4242, medium, 20 flights: min 0.38, median 0.55,
       max 1.02 s. Unreachable without changing METEOR_SPEED, GRAVITY or the
       spawn height, all fixed by `docs/13`.

## T13.06.7 / T13.06.8 / T13.06.9 — DONE
Files: game-core/src/items/{inventory,registry,world}.rs, game-core/tests/combat.rs,
       client/src/ui/results-math.ts, client/src/scenes/GameScene.ts,
       client/src/net/codec.ts, scripts/checks/{round-end,hud-bars}.mjs,
       scripts/wasm-build.mjs
Verified: `--lib inventory` 20 passed; `npm test -- --run results` 15 passed;
       `--lib jetpack` 27 passed; e2e round-end and hud-bars ok.
Notes: .7 — the one-slot rule lives in `Inventory::add`, the only route into a
       slot. Six tests were asserting the multi-slot rule THROUGH `GRENADE`,
       which is a weapon and therefore the class §C24 exempts; re-based onto
       consumables so `docs/30` §2 stays covered and becomes the control.
       `tests/combat.rs` also encoded the old rule and was missed by the
       crate-scoped Done-when.
       .8 — `round.rs` emits `round_state` from four places and the `Ended`
       branch is not one of them, so the client rendered one number for the whole
       window. Now a DEADLINE recomputed against the server clock (§B4/T10.06).
       The same frozen field also drove the Warmup banner. AND: `Room::restart`
       assigns a fresh World, so tick and round_time both reset — the client
       corrected against the dead round's anchor and showed "Warmup — 0:00" for
       the whole of round two. No check drives a second round; unit-tested now.
       .9 — MEASURED FIRST, and the sim is correct: burn 5.0->0.0 in exactly
       300 ticks, refill starts at 0.5167 s (one tick late, `>` not `>=`), slope
       0.5000/s, full at 10.5 s, no landing gate. So the readout is the fix and
       the feel is a tuning question about the three constants.
THREE BUGS FOUND ON THE WAY, all pre-existing:
       `wasm-build.mjs` had `--out-dir` relative, which `wasm-pack` resolves
       against the CRATE dir — builds landed in `crates/game-wasm/client/...`
       while the client imported a package last written **Aug 21**. It fails
       silently: a valid older package is still there. THE BROWSER SUITE HAD BEEN
       RUNNING ON PRE-SESSION WASM. Fixed, plus a post-build mtime check that
       exits non-zero.
       Jetpack fuel was DEQUANTISED TWICE — `codec.ts` converts, and GameScene
       divided by 255 again at the readout *and* at `predictor.reconcile`, so the
       predicted body ran dry instantly and mispredicted position for the whole
       of every burn.
       `npm run typecheck` was red while `vitest --run` passed: consts declared
       in one `describe` and used from another transpile fine and do not typecheck.

## T13.06.1 (finishing) — what the suite caught that no unit test could
Files: scripts/checks/{harness,crates,death,ordnance}.mjs, client/src/scenes/GameScene.ts,
       crates/game-wasm/src/lib.rs, client/src/core/index.ts, game-server/src/room.rs
Notes: THREE OF THIS SESSION'S OWN CHANGES BROKE BROWSER CHECKS IN WAYS THAT READ
       AS UNRELATED BUGS. All three are now fixed at the shared layer.
       1. §C20 refuses a shot from a moving player, and three checks walk then
          fire. `ordnance` reported "timed out waiting for a melee swing to
          arrive" (reads as a missing subscription) and `death` took 103 s
          instead of 30 — long enough for the weather to kill first, so it
          reported `cause "Killed by weather"` (reads as an attribution bug).
          Fixed with ONE `harness.mjs::standStill`, which waits on the body's own
          velocity against FIRE_MOVE_MAX_SPEED rather than sleeping.
          `death` also drops to DEV_START_HEALTH 20 so one rocket kills inside
          the 30 s before EFFECT_INTERVAL_MIN — there is no way to turn weather
          off, and the fixture had to fit inside it.
       2. §C24 COLLAPSED THE DEV LOADOUT. The second bazooka grant is now a
          silent no-op (the first stack is already at max_stack), so every slot
          after the smg moved by one: `ordnance` pressed Digit5 for the axe and
          got the flamethrower. Its own comment promised "appended, never
          inserted, so the hotkeys stay put" — §B16, an implicit invariant that
          was true until it was not. `debug()` now reports `slots`, and
          `harness.mjs::selectWeapon(page, 'axe')` selects BY NAME and fails
          loudly if the weapon is not held. The no-op grant is removed and the
          consequence recorded: **DEV_LOADOUT now arms 4 rockets, not 8.**
       3. `crates`' pixel control was wrong THREE WAYS, and its own guard caught
          each one rather than reporting a canopy: ±200 px hardcoded is rock when
          the crate falls down a shaft (delta 186); mask-probed offsets are empty
          but unequally lit, because the lightmap is radial about the PLAYER
          (112); equal-radius offsets are equally lit but land 1000 px apart in a
          vertically graded sky (236). Replaced with a TEMPORAL control — the
          same rect, the same pinned camera, half a second later once the crate
          has fallen out of it, plus a quiet rect sampled in both frames as the
          noise term. Canopy 80.2 against a drift of 2.8, which is the same 80-91
          band the original falsification (every parachute draw call deleted:
          16-27) established.
       `crates` also could not tell a pickup from an EXPIRY — it broke out of its
       loop on "no longer in mirrorItems", which a timed-out crate satisfies
       exactly as well — and read "stops being drawn" in the same frame the
       mirror dropped it, which a correct client fails by one frame. Both fixed;
       the pickup tolerance is now derived from the poll interval and
       JETPACK_MAX_SPEED rather than being a number read off one run.

## T13.06.6 — gun projectiles: nothing has ever drawn them in a real game — DONE
Files: client/src/scenes/GameScene.ts, scripts/checks/ordnance-visible.mjs, scripts/e2e.mjs
Verified: `node scripts/e2e.mjs ordnance-visible` 1/1; client typecheck + 507 tests.
Notes: MEASURED FIRST, on the unmodified code, per §C23's instruction:
         kind              server  layer  pixels
         hitscan (smg)       1       1     13.7  vs floor 4.0 — visible
         projectile (bazooka)1       1      0.0  vs floor 4.0 — NEVER DRAWN
       So `TRACER_LIFETIME` 0.09 s is NOT the problem — candidate 2 is false, and
       tracers were fine all along. The defect is candidate 1 (the §C0 shape) but
       for PROJECTILES: `WorldView.update(near, dt = 0, weather?)` gates its
       ordnance work on `dt > 0`, and `GameScene` called it with ONE argument. So
       `WorldView.ordnance.update()` never ran in a real round, and that layer's
       `Graphics` is only filled inside `update()`. **No rocket, grenade or
       meteor has ever been drawn in an actual game.**
       `SandboxScene` calls `this.world.ordnance.update(dt)` itself — which is
       exactly why T13.03's pixel test passed while a player saw nothing.
       THE BOTH-ENDS COUNTERS READ 1 LIVE / 1 DRAWN THE WHOLE TIME, because
       `projectilesDrawn` counts the layer's state map, which `syncProjectiles`
       fills faithfully. §A15 in its purest form: only pixels could catch this.
       The second `OrdnanceLayer` is deleted — real duplication, which existed
       precisely because the shared one was unreachable.
       FALSIFIED: restoring the `dt = 0` call leaves both both-ends assertions
       GREEN and drives both pixel assertions to exactly 0.0. Passing runs read
       tracer 21.4 and rocket 17.8-26.5. No overlap.
Left for later: `game-wasm`'s `fire` still re-implements the `Delivery` match and
       its impact loop treats every projectile as a bazooka. Thirteen browser
       checks run on `?sandbox=1` and certify a scene the player never plays —
       that has now hidden a real bug twice. Needs its own task: the sandbox's
       API is JSON events returned from `fire()`, and `game-wasm` cannot depend
       on `game-server`'s serialisers without inverting the dependency.

## T13.06.10 — the gate's flake is a lost message, not a busy box — DONE
Files: crates/game-server/tests/{lobby,rooms}.rs
Verified: `./scripts/check.sh` (below). Reproduction measured, not assumed.
Notes: REPRODUCTION RATE, `cargo test -p game-server`, 10 runs each:
         before                              1/10 failed, mean 83.0 s
         first attempt (retry every 1.5 s)  10/10 failed, mean 55.6 s
         after                               0/10 failed, mean 77.0 s
       plus 15 further clean runs. Not slower — slightly faster.
       THE DIAGNOSIS IS NOT WHAT THE TASK ASSUMED. The failure is always
       `waited 30 s for 1 welcome, saw 0 (inbox: EMPTY)` — not one event of any
       kind, on a socket whose `open` had already fired. Thirty seconds of
       silence is not a loaded box; the emit was never delivered. §A28 records
       the mechanism, and waiting for `open` narrows the window without closing
       it. Wall-clock margins say the same: across a full workspace run the worst
       real wait used 24 % of its budget, so the budget was never the constraint.
       So this took the task's THIRD option (wait on the effect with an adaptive
       bound), not its first. `emit_until` re-emits `join` until `welcome`
       arrives — safe because the server defines it so ("a second join on one
       socket is ignored, not a second player").
       I MADE IT WORSE FIRST, and the measurement caught it: retrying every
       1.5 s is UNDER the 1.7-1.9 s a healthy `welcome` actually takes, so every
       healthy run double-joined — 1/10 became 10/10. The server's duplicate
       guard is only set once `room.join()` completes, so a retry inside that
       window is not deduplicated at all. Retry is now budget/3, floored at 5 s.
       0/25 IS NOT EVIDENCE THE FIX WORKS: the retry never fired once in those
       25 runs, so the rate says the flake did not recur, not that it is fixed.
       At that rate nobody can run enough iterations to tell the two apart. So
       the mechanism is proven directly instead —
       `a_join_that_is_never_delivered_is_retried_until_it_is` sends the first
       emit to an event with no handler, and asserts BOTH that the retry
       recovers it and that exactly one seat is taken.
       FALSIFIED: with the retry removed that test fails with
       `emitted join 1 time(s) over 30 s and never saw welcome (inbox: empty)` —
       the identical message as the real flake.
       `wait_for` is also a real wall-clock deadline now. `for _ in 0..200 {
       sleep(50) }` counts ITERATIONS, so under load the budget silently
       stretched and the number in the failure message was a fiction.

## MAP_GENERATOR_V2 — the landscape generator (out of band, user request)

- Not a task file. The maps read as one cave system: v1 thresholds a warped fBm
  field over the whole canvas, so it puts as much rock in the sky as air
  underground, its floating islands are perforated too, and the renderer's
  enclosure test quite correctly paints the lot brown.
- **v2** builds the ground from a 1D height profile — fBm hills, terraced ledges,
  flat-topped mesas, canyons cut to the bedrock — fills below the line, then hangs
  solid islands in the sky and cuts one or two caves with shafts to the surface.
  Open sky is a pixel's default state. `crates/game-core/src/map/gen/v2/`.
- Both ship. `MAP_GENERATOR=v1|v2`, default v2 (RUNNING.md §5.1), in the replay
  header (version 1 -> 2), and in the golden table, which now pins **both** — a
  table that only pinned the default stopped guarding the other the moment the
  default moved. All 12 v1 mask hashes are byte-identical; only v1's *meta*
  digests changed, from the `is_standable` fix below.
- **Two real bugs fell out, both pre-existing and both surfaced by the new
  geometry.** The top of the map's own side wall was a standable ledge, and a
  spawn landed on it with half the player outside the world: `is_standable` now
  requires the whole body box in bounds. And `BackdropMask` could not tell
  "inside a cavern" from "outside a cliff" — the up-diagonal rays hit the cliff,
  so `BACKDROP_MIN_UP` was satisfied by the same rock that made the point plainly
  outdoors. `BACKDROP_MIN_ROOF` asks the vertical column instead. Open sky drawn
  as backdrop, v1: 16.42/5.86/7.18 % -> 0.9/0.1/0.1 %; v2: 2.3/8.1/2.0 % -> 0.0.
  §A17's two bounds now both hold at every scale on both generators, which §A21
  recorded as impossible.
- Five e2e specs were reading fixtures, not the game. `wasd` aimed 200 px from
  the screen *centre* and called a correct -71 degrees wrong once the camera
  clamped; `sky` sampled a strip that is sky on the old map and rock on this one;
  `m5-weather` read puddles 0.6 s in, and a drop now falls 880 px not 200;
  `crates` needed a crate with clear air under it AND one our walker can reach.
  All four now pick by content or derive from the map. `ordnance` and `crates`
  were also load coin-flips — a fixed 400 ms settle spent the 4-rocket budget on
  a busy box, and a 160 ms camera settle doubled the noise floor it is measured
  against. Both now wait on the effect.
- ./scripts/check.sh green, 28/28 e2e.

## T14.01 — the round timer and the event banner (§C8)

- `client/src/ui/hud.ts`: the timer top-right in a shipped condensed face
  (`assets/fonts/kenney-future-narrow.ttf`, from the vendored Kenney UI pack — no
  runtime fetch, `docs/51` §5), red below `TIMER_WARN_SECONDS` (60); the banner
  top-centre, red, naming the effect and counting it down through **telegraph and
  active**, because the telegraph is the warning.
- Both server-driven. The timer runs off `phaseEndsAt`, the same deadline §C25
  gave the results screen; the banner's countdown runs off `serverRoundTime` and
  the `duration` in `effect_start`. Fed from the **effect-lifecycle loop**, not
  from `cueFor`: that is subscribed to `effect_start` alone, so a banner wired
  there would go up on the telegraph and never come down.
- 26 unit tests on the arithmetic; `scripts/checks/hud-timer.mjs` asserts the rest
  on **pixels** with controls — not-red before the boundary, red after, the
  banner's own rect red while up and not once it has cleared — and cross-checks
  the digits against `round_state.time_left`.
- The check's first version compared the timer against `ROUND_SECONDS -
  serverRoundTime` and reported it 9 s fast. `serverRoundTime` is the world clock
  and has been running since the lobby, so that subtraction is short by the whole
  warmup: the instrument was the bug (§A25).

## OPEN DEFECT — a held weapon stack disappears

Found while repairing `ordnance`, **not caused by any change in this session**:
it reproduces on `MAP_GENERATOR=v1` too (2 of 4 runs), and only became frequent
because the repaired fixture now runs 30–37 s instead of 18 s.

- Symptom: mid-round, the player's **bazooka stack is gone** — slot 1 empty, every
  other slot untouched with its counts preserved. The player is alive, has died 0
  times, has fired no rockets and has not moved since the last read.
- The server is the one that lost it. `GameEvent::Inventory` is positional —
  index i ↔ slot i, `null` for empty — so the client's empty slot 1 is a genuinely
  empty slot 0 on the server.
- `Inventory::add` is ruled out: `a_pickup_never_removes_a_held_stack` fills the
  loadout and then picks up past full, and every stack survives.
  `resolve_pickups` only ever calls `add`. `use_item` refuses `ItemKind::Weapon`
  before it consumes.
- What is left is `Inventory::consume` via `try_fire`, which spends **the
  selected slot**. Four rockets is exactly the stack size. Correlated: the failing
  runs have picked up extra items (medkit, grenade, airburst) and are at or near
  8/8 slots.
- `ordnance` now fails with this diagnosis rather than with `"bazooka" is not in
  the inventory`, which is a true statement that says nothing.


## T14.02 — health, energy and jetpack bars (§C8)

- `client/src/ui/bars.ts` + `bars-math.ts`: the bottom-left cluster. Health runs
  red→green over a track that is **`HEALTH_CAP` wide**, so a full bar and an
  overhealed one are visibly different — a track that saturates at `BASE_HEALTH`
  reads "full" at 100 and at 150, which is the one distinction §C8 asks for.
  Overheal is its own gold band. Energy is blue, jetpack yellow, and the jetpack
  dims through `JETPACK_REFILL_DELAY` so the flat half-second is not read as a
  broken bar. The shield is a **ring above the cluster**, not part of the health
  bar: it is a timer, not a pool (`docs/21` §2), and §B5's payoff is that the
  battery ends it early, so the ring takes whichever of the two runs out first.
- **`SNAPSHOT_PLAYER_BYTES` 16 → 17: the battery.** A spec gap, reported rather
  than absorbed — §C8 asks for the energy bar and §C9 budgets 16 → 17 for its own
  byte (heals/batteries counters), and neither says how the *pool* reaches the
  client. It cannot be derived: it is spent by the shield tick and by energy
  weapons, both server-side. T14.03 therefore takes 18.
- `DEV_LOADOUT` now grants a full battery. It handed out energy weapons and none
  of their ammunition, so §B5's weapons were paperweights and §C8's bar was
  empty — `hud-bars` sampled it and correctly found the bare track.
- 13 unit tests on the arithmetic pinned to the constants; `hud-bars` extended
  with the cluster's own pixels: the energy bar renders blue and the jetpack
  yellow with the health bar as the control, health reads the snapshot, and a
  2.5 s burn moves both the fill and the pixels.
- `./scripts/check.sh` green, 29/29 e2e.

## T14.03 — heals and batteries leave the inventory (§C9)

- `heals` (max 2) and `batteries` (max 4) on `PlayerState`, counters beside the
  health bar. Pickups are routed in `resolve_pickups` and never reach a slot; at
  max the pickup is **refused and the item stays on the ground**, the same rule a
  full inventory gets. `Q` heals `MEDKIT_HEAL`, `R` adds `BATTERY_PACK_AMOUNT`,
  both rejected with no effect at zero and both slotless — nothing an attacker
  can point out of range.
- **`SNAPSHOT_PLAYER_BYTES` 17 → 18**, not §C9's 17: T14.02's battery byte took
  17. Every combination of the packed byte round-trips (4 x 8, not a sample), and
  the size test pins to the constants.
- Death takes them, deliberately (§C9 asks for the decision): everything else you
  carry lands where you fell and can be taken by whoever killed you, and a pair of
  consumables that survived death would be the only thing a kill does not put back
  into play.
- Three existing tests were asserting inventory rules **through a medkit**, which
  since §C9 never reaches a slot. They now use a bazooka or a shield generator and
  say why; one of them would have gone on passing while measuring the opposite.
- **The open defect from T14.01 is fixed.** `die` empties the inventory and pushed
  no `Inventory` event, so the owner's client rendered the pre-death loadout until
  some later pickup corrected it — measured at five seconds, and the e2e harness
  looks a weapon's slot up in that view before pressing its hotkey. Falsified:
  with the push removed the new test fails with "the player died and was never
  told their inventory had gone".
- Also §A34: `battery` was never in the state hash, and nor were the two new
  counters. All three change the simulation, so a replay could diverge with every
  checkpoint agreeing.

## T14.04 — quick-throw with E (§C11)

- `E` throws the first grenade-class item — grenade, molotov, toxic, smoke,
  airburst — from wherever it is, without moving the selection. `try_fire` split
  into `try_fire_slot` and `World::fire` into `fire_from_slot`, so the throw takes
  the same validation in the same order and **shares `fire_ready_at`**: it cannot
  be used to sidestep a cooldown, and a test asserts the cooldown in both
  directions.
- `E` was `use_item`; that moves to `G`. Not a doc'd binding, and it is written
  down: §C10 names no use key, §C9 took the heals and batteries out of the
  inventory, and the shield generator is the one remaining `use_item` target.
- **Bots: checked, not assumed** (§B19). `choose_weapon` already scans every slot
  and scores by damage per second with no filter on delivery kind, so a bot picks
  a grenade and throws it through the ordinary path. A second route would be two
  mechanisms for one job; there is a test instead, so a future change that starts
  skipping thrown weapons fails loudly.
- `scripts/checks/quick-throw.mjs` drives the real key through the real socket —
  the unit tests cannot tell a wired keybinding from an unwired one (§A15).
- `./scripts/check.sh` green, 30/30 e2e.

## T14.05 — quick bar and backpack (§C10)

- `INVENTORY_SLOTS` **8 → 24** = `QUICK_SLOTS` (8) + `BACKPACK_SLOTS` (16), in that
  order, so "pickups fill the quick bar first" falls out of `Inventory::add`
  filling slots by index rather than being a second rule that can disagree.
- `Inventory::select` and `select_next_non_empty` are bounded by **`QUICK_SLOTS`**,
  not `INVENTORY_SLOTS`. With 24 slots those stopped being the same number, and
  the old bound would have let a `select_slot` from a modified client park the
  trigger on something the player cannot see.
- `move_stack` / `move_item` — the drag. Client shows intent, **server decides**:
  out of range, `from == to` and an empty source are refused; an empty
  destination moves; the same item merges to `max_stack` with the remainder left
  behind; a different item swaps. Fuzzed 20 000 index pairs asserting the total
  item count never changes.
- `client/src/ui/inventory.ts`: tiles, right-click for the backpack, HTML5 drag.
  Nothing moves locally — the tiles are rendered from the server's `inventory`
  event and nothing else.
- The old text strip carried health, the held item and the whole inventory. §C8
  and §C10 own all three now, and printing them again put a second, worse HUD
  across the bottom of the frame (`shots/inventory-open.png`). It keeps the join
  code, which nothing else shows.

## T14.06 — the escape menu (§C13)

- Resume / Options (present, disabled, `tabIndex -1`) / Quit to title, over a
  round that keeps running. `handleEscape` owns the stacking rule — innermost
  overlay first — and is unit-tested as a sequence, because the bug is never one
  press, it is two in a row.
- **Quit sends `leave_room` and closes the socket**, not just a scene change: the
  seat would stay taken and the room would never reap (§B14). Asserted from the
  server's own `/metrics` player count, which is the only opinion that counts.

## T14.07 — debug mode (§C12)

- `F1` or `?debug=1`, off by default, and it **owns the T3.11 overlays** — one
  toggle, not two. The aim ring goes in normal play and the crosshair stays;
  `Crosshair::setRingVisible` is separate from `setVisible` so a corpse's
  crosshair does not reappear with debug mode.
- FPS from `requestAnimationFrame` deltas, **median of a 30-frame window**, never
  `game.loop.actualFps` (§A38). Fed known deltas in the unit tests, including a
  single 200 ms stall that a mean would report as 48 fps.
- The state survives a scene change via `sessionStorage`; `initialEnabled` is the
  decision and is unit-tested, because a browser check can only reach it by
  reloading the page, which drops the seat and tests the browser.

## Spawns prefer ground you can walk on

Not a task: found because two browser checks reported "held D and moved 0 px".
`is_standable` says a body fits; it says nothing about being able to leave, so a
spawn could be a crevice you can stand, aim and fire in and not move — which a
player reads as the controls being broken. `choose_spawns` now prefers points
with `SPAWN_WALK_CLEARANCE` of standable ground **both** ways, falling back to
the unfiltered set when that cannot fill the quota (count-based, not size-based:
forty clustered roomy points pass any "enough candidates" test and still yield
five).

Six fixtures were asserting on where the player happened to stand and are now
asserting on the game: `sandbox` probes the mask for buried rock instead of
assuming 60 px below a spawn; `ordnance-visible` aims relative to the player and
picks its noise control by content (the sky animates, terrain does not);
`debug-mode` compares peak walking speed rather than distance and walks back the
way it came; `wasd`'s jetpack descent had a 5 px bound against a 5.3 px reading;
`two-clients` walks whichever way has room; `ordnance` throws its molotov clear
and leaves while it is in the air.

`./scripts/check.sh` green, 33/33 e2e.

## T14.08 — the dev surface is compiled out

`__DEV_SURFACE__` is a vite `define`, so by build time it is the literal `false`
and every `if (devSurface())` body is eliminated. The dev scenes are behind
**dynamic** imports inside that branch — a top-level import keeps the module in
the graph however the branch folds — and the production build now emits one chunk
where the e2e build emits four.

`no-dev-surface.mjs` greps the artifact, because a test asserting the code sits
inside an `if (DEV)` block passes for a build where the eliminator never ran. Its
control caught its own first version: `preview=1`, `boot=1` and `skins=1` are in
no bundle, minified or not (`q.get("preview")==="1"`), and the bare words are
worse — Phaser says `boot` 91 times and `skins` is a player feature. Those
parameters are asserted by loading the production bundle with each one and
looking at what comes up. Falsified by flipping the define to `true`: ten
assertions fail.

`./scripts/check.sh` green, the whole e2e suite included. M14 is complete.

## Not a task — the cave backdrop is off, behind `CAVE_BACKDROP`

Asked for directly: get rid of the cave backgrounds, toggled. `CAVE_BACKDROP`
(constants.rs, mirrored through WASM) ships **false**; `TerrainRenderer` then skips
building `BackdropMask` at all and hands `bakeChunk` no backdrop. Nothing was
deleted — the classifier and `backdrop-real.test.ts` are untouched; the constant
decides only whether the renderer asks for one.

The decision lives in one method, `bakeLayers()`, because that is where it becomes
pixels: a test asserting the *field* would pass for a renderer that read it and
drew the backdrop anyway. A module-level `setCaveBackdropDefault` carries the
sandbox's **Cave bg** button across a Regenerate — the first version set the flag on
the live renderer and the next Regenerate silently put the backdrop back.

`perf` now measures both sides: OFF median 0.0 ms (the pass is skipped, not fast),
ON median 252 ms against its 500 ceiling — `0 < 500` would have passed for an
arbitrarily slow classifier. Screenshots in `shots/caveback-{off,on}.png`.
`./scripts/check.sh` green, 34/34 e2e.

## T15.01 — teleport pads

Six indestructible pads per map, from the same `choose_separated` sampler as the
spawn points on its own `"pads"` sub-stream. `carve_circle` splits each row's span
around any pad crossing it, and because `carve_line`/`fill_circle` funnel through
the same `circle()`, no second path can drop the guard. Respawn picks the pad
furthest from the nearest living player; `step_teleports` charges, arms and fires.
`SNAPSHOT_PLAYER_BYTES` 18 → 19 for the teleport state, which is in `state_hash`.

The reviewer caught the one that mattered: `pads_do_not_move_the_spawn_points`
drained a **local** `substream(seed, "pads")` and re-generated — which cannot fail,
because `generate` is deterministic however the streams are named, including the
`"spawns"` typo the test existed to catch. Replaced with an assertion that the pads
and the spawns do not land on the same points; falsified by renaming the stream.

Two more from the review: the per-row `vec![(x0, x1)]` in `carve_circle` allocated
on every row of every carve (400 for an r=200) — now a `[_; TELEPORT_PADS + 1]`
array; and `step_teleports` no longer `mem::take`s the pads out of the map, which
left `carve_circle` unable to see them for the duration of the tick. `pads.ts`'s
duplicate `padUnderfoot` is now pinned at both edges (`pads.test.ts`).

`cargo test -p game-core --lib teleport` 18/18, `node scripts/e2e.mjs teleport` ok.
Full gate deferred to the M15 checkpoint.

## T15.02 — the floor is destructible, and below it is death

`BEDROCK_H` 24 → 0 with a destructible `FLOOR_CRUST` of 16. Generation sites moved
to `FLOOR_CRUST`, destruction sites kept `BEDROCK_H` — one number had been answering
two questions. The 999-seed sweep's attempt distribution is **identical** before and
after (`[0, 989, 10, 0, 0]`, safe_preset 0); traversability moved 0.1–0.3 points,
which is an 8 px thinner floor. Golden table regenerated deliberately, 24 of 24.

**Deviation from the task, upheld on review:** no `DamageSource::Void`. The void
cannot go through `apply_damage_log` — the warmup gate returns early (and you can
dig during warmup), i-frames return false, and above all the shield multiplies by
`SHIELD_DAMAGE_MULT`, so no finite amount is guaranteed to kill at `HEALTH_CAP` and
a shielded player would fall forever. `DeathCause::Void` is the analogue, with
`DamageSource::Weather → DeathCause::Weather` as precedent.

`CAVE_FLOOR_KEEPOUT` 24 keeps v1's cave network bit-identical, so the golden churn
is attributable to `force_borders` alone. It exists because
`tunnels_are_meaningfully_horizontal` broke at the thinner crust — **that assertion
had a 2.6 % margin before anyone touched it.** Deterministic, so not a coin flip,
but brittle: it wants a margin and its measured values logged. Not fixed here.

The review caught the kill feed's fix missing from the *other* death UI: the overlay
read "Killed by void" for `RESPAWN_DELAY` seconds. `scripts/checks/void.mjs` now
asserts the sentence from the frame — and catches it when the arm is removed.

## T15.03 — mountains and clouds

Two seeded ridge layers at 0.10/0.20 and twelve drifting clouds, tinted from
`skyColors` rather than a second palette (§A13). `noise-math.ts` shares one value
noise with `procTextures` (§A24).

**The clouds folded in half at the zoom the game actually runs at.** The field was
built over a 1280 px span and wrapped over `VIEWPORT_W / zoom`; at `CAMERA_ZOOM` 2
twelve clouds collapsed into six pairs — measured gaps `69, 23, 48, 113, 20, 99, 2,
70, 2, 72, 54`, now `35, 57, 60, 36, 36, 62, 46, 90, 49, 36, 64`. `y` was scaled and
`x` was modulo'd; the asymmetry was the bug. `living-sky` ran at zoom 1 — the one
zoom the game never uses — and now measures at 2, 0.75 and 1, off the drawn sprites.
It pins the drift clock, because unpinned the gap read 11.4 px against a 13.3 floor:
a gate failing on how long the machine took.

The review predicted constant-white `cloudTint` would trip `addNight >= addNoon`. It
does not — measured, white adds 26.3 at noon against 19.1 at night, still ordered.
So it was a real §A15 hole, closed with a both-ends check that reads `tintTopLeft`
back off the sprite: "cloudTint says #d5ebf7 and the sprite is holding #ffffff".

## T15.04 — birds

§C16 says birds take damage from anything, and eleven places damage things. Rather
than a bird slice each must remember to pass, birds ride in the same
`Vec<HitTarget>` players travel in, built by the one `hit_targets` every damage path
already calls — blast, ray, swing, cone, mine, lava and meteor hit them without
knowing they exist. That meant `PlayerHitTarget` → `HitTarget` with
`HitId::Player | Bird` across 28 sites; the sum type made the compiler enumerate
them, and a bare `u8` would have been read as a player id by `resolve_deaths`, the
score and the kill feed. `HitTarget` also gained `w`/`h`, because `fire_hitscan`
marched against a hardcoded `PLAYER_W × PLAYER_H` and a bird is 20×14.

"Above all terrain" put birds off-screen: the generator clamps the tallest rock to
`SKY_MARGIN` 96 while the median surface sits at y=575–1160, and at `CAMERA_ZOOM` 2
the camera shows ±180 px. The band is derived from the map's median column-top,
computed once so a map later dug to the void cannot move it.

Two fake pixel assertions, both caught by falsifying: one compared the same rect
across frames the camera had moved between; the other compared the bird's rect
against sky beside it and **passed at 40.7 with the layer drawing nothing**, because
the rect held terrain and the sky did not — it was measuring the skyline. It now
compares one rect before and after the bird leaves it and asserts the camera held
still rather than assuming it.

Review found three siblings the refactor missed — `burn.rs`, `lava.rs`, `toxic.rs`
still sized targets as `PLAYER_W × PLAYER_H` on a slice that now holds birds.
Unreachable today (ground hazards, sky band) and fixed anyway: it goes live the
moment anything flies lower.

**Two pre-existing defects found on the way.** `e2e-two-clients.mjs:66` compared the
two clients' `debug().seed` — the *client's local* core, which in a networked round
never generates the map, so both reported the same constant and the assertion was
`x !== x`, sitting directly above the `maskChecksum` that does have teeth. The round
seed from `welcome` is now exposed and compared, with a guard against an empty one.
And `two-clients`' `GAME_LAYERS` parity list had been missing T15.03's `-22, -21,
-20` since that task landed — T15.03 updated `terrain-render`'s copy of the same
assertion and not this one.

## M15 checkpoint — two fixtures the milestone exposed

The gate came back 36/38. Neither failure was a game bug, and neither fixture was
sound before M15 touched it.

`ordnance-visible` reported "no patch of solid rock on the frame". 29.4 % of the
frame was solid. Its control search skipped anything within **320 world px** of the
player — but at `CAMERA_ZOOM` 2 the visible world rect is 640×360, so that disc ate
88 % of the search space and left 55 candidates to find a fully-solid 60 px square
among. T15.02's regenerated terrain moved the sliver that remained onto sky. The
exclusion is now the *firing corridor* rather than a disc (everything is fired to
the right, so rock on the left is equally static and there is far more of it), sizes
fall back 60 → 44 → 32 — a smaller patch is a noisier control, which raises
`floor = controlDelta * 3`, so the fallback can only make the check stricter — and a
failure now prints the solid fraction, the view rect and why each candidate lost.

`hud-bars` failed in the gate and passed on re-run: the coin flip CLAUDE.md says
gates nothing. It took its "before" reading after a screenshot and three assertion
blocks, and a full refill from 2.16 takes 6.6–6.8 s, so it sometimes read `5 -> 5`
and reported "did not refill" about a tank that had refilled perfectly. The rise is
now sampled from the instant of release over a window derived from
`JETPACK_REFILL_DELAY + (max - low) / JETPACK_REFILL`. Bounded at 18 s, because the
obvious falsification (`JETPACK_REFILL = 0`) makes that window infinite and would
hang instead of failing.

Also recorded: the suite's stray-process guard counts *any* new browser as a leak,
so a concurrent probe makes an otherwise-green run exit 1.

## A real bug the checkpoint found: a teleport refilled the jetpack

`fire_pads` (T15.01) reset the jetpack alongside the body, and
`JetpackState::default()` sets `fuel: JETPACK_MAX_FUEL` — so **every teleport handed
out a full tank** and every pad was a refuelling station. §C5 says nothing about
fuel, and the pads are already the one ground nobody can dig away. Fuel now survives
the trip; `active`, `locked_out` and the tick counters still reset, because arriving
mid-thrust or still locked out from a tank you emptied elsewhere is arriving in a
state you did not choose. Falsified: restoring the plain reset gives *arrived with 5
of 5 after leaving with 1.25*.

`hud-bars` performs the recipe by accident — holding `Space` jumps first, clearing
`TELEPORT_ARM_DISTANCE`, which arms the pad the player is standing on, and the hold
then outlasts `TELEPORT_CHARGE`. It reproduced ~40 % under load and 0/10 in
isolation, which is why it read as a flake. The T15.01 review did not catch it and
neither did 19 lib tests; the tightened refill assertion did.

The instrument was also wrong and is fixed: it measured a simulation rate with a
wall clock. It now times in `lastServerTick`, checks the largest **single step**
against what the ticks between two samples allow — an average cannot tell "too fast"
from "reissued" — and expresses slack as wire quanta (`JETPACK_MAX_FUEL / 255`)
rather than a typed tolerance. It also stopped spinning: 440 `page.evaluate` calls
in 6.7 s was starving the thread it was measuring.

Two more fixtures, both map-dependent: `debug-mode`'s first run could start against
a wall (its vacuity guard fired correctly, `60 px/s`), and now probes the mask for
headroom at torso and head height and holds whichever side has more. `teleport`
threw inside `samplePatch` on an off-frame control rect; the control is now found by
content and returned as a **world** point, because the player jumps between the two
frames and a frozen screen rect covered different rock — `the control patch moved by
184.8`, five runs in six.

## The off-pad respawn was the fixture — and it hid a missing assertion

`teleport.mjs` reported an off-pad respawn 1-in-5, which §C5 forbids. It was not a
game bug: `until()` reports a failure on timeout and then **returns null while
execution continues**, so the 30 s respawn wait expired, the grounded-wait was
skipped, and the next `dbg()` read the player *while still dead*. `(716, 503)` was
the corpse. Two messages, one cause, and the second blamed §C5. `until()` now
reports what it was looking at when it gave up, and the position assertion only runs
when a respawn actually happened.

What was genuinely missing: `resolve_deaths` called `choose_respawn_pad(..).pos` and
**discarded `.pad`**. `respawn.rs` has a test that the chooser never falls back on a
carved map — but it calls the chooser directly, which proves the function returns a
pad, not that the thing wired into the round asks for one. The `docs/21` §4 fallback
would have fired in production in silence. T15.01 asked for this assertion in as
many words and it did not exist at the production level.

`World::respawn_fallbacks` counts it, and `a_real_round_never_respawns_off_a_pad`
asserts it stays zero — checked inside the loop, because the counter is the cause and
the landing position is only the symptom, with `score == 50 * DEATH_POINTS` as the
control so "no fallback fired" cannot be the truth about an empty loop. Falsified two
ways: clearing the pads fires the counter, and blinding the counter *as well* still
trips the position assertion.

A second flake fell out of the same runs: frame A was taken before the arming jump,
so the jump, the landing, `standStill` and the camera settle all sat between A and B
— five to eight seconds of §A4 lighting drift on a pixel-for-pixel comparison, read
as `the control patch moved by 55.1`. Frame A is taken immediately before the
sampling window now; the property it needs is "the indicator is not drawn yet", not
"unarmed". Control delta is 0.0 on every run since.

## quick-throw and ordnance: both fixtures, one of them hiding a burning player

`quick-throw` reported "the server never had one in the air" and "E is falling
through to fire" — both blaming production, and both were **one death**. Probed at
the exact read the assertion uses, the failing run returned `slots = null x24,
deaths = 1`: `die()` had cleared the inventory, so nothing was "spent". The aim was
a hardcoded screen point — already the second attempt, carrying a comment about
molotovs at your own feet being fatal — and T15.02's regenerated maps put rock in
front of it. The bottle detonated at the player's feet, laid a fire zone, and
`standStill` held them in it. Roughly one run in four.

The fix that mattered was the instrument: it asserts on a **cumulative**
`projectileSpawns` counter now, not a live count, because a molotov's whole life can
fall between two polls — one run showed `spawns 0 → 1` where the live poll caught
nothing. The aim is probed from the mask along the longest clear lane, and the check
walks clear *while the bottle is airborne*, polling during the walk rather than
after it.

`ordnance` was its own documented signature: `DEV_LOADOUT` grants 4 rockets,
premature retries burn them, and `selectWeapon` then throws something that reads
like a broken loadout. Two earlier fixes bought patience; no wait is long enough on
every box. `fireUntil` is ammo-aware — running dry is a finding, not an exception.

That left a real 1-in-6: a bazooka rocket is ballistic and lands short of the mine,
with only the blast radius rescuing it. The cause was not the aim but the *firing
position* — shot one is fired standing on the mine, and **a rocket at your own feet
throws you** (`docs/21` §5), so every later shot came from wherever the blast had
put the player. `fireUntil` gained an `approach` step that walks back onto the mine
between shots, thresholded on `BAZOOKA_BLAST_RADIUS` from the constants table rather
than a copy of 42. It does not fail when it cannot arrive — a mine across a chasm is
a map fact — and the ammo guard still bounds the spend. 8/8, and across all eight the
mine died to the *first* rocket.

## T16.01 — PNG to terrain mask: the build pipeline (v5)

Pack-mean scale: one exact `num/den` per category, measured from the heights of the
sprites actually selected and applied to each sprite's own bounds, so the spread
inside a pack survives. Ruins lands at 1.462 (84/57.5), not §D4's 1.24, because §D0's
mean averages four contact sheets that are not objects — derived, not corrected for.
§D2's "integer factor" is impossible against §D4's fractional table; sampling is
integer-only rational NN instead. Five spec defects found and logged in
`tasks/DECISIONS.md`, which is new: Ilya went dark mid-run and asked for decisions to
be recorded rather than blocked on. Known limits: the blob format is spelled in both
the JS and Rust readers, and four tests plus `--check`'s source verification are
skipped on a clone without `../sprite_packs`, so the Done-when passes there without
reading a single PNG. e2e deferred to the end of M16 per D-07.

## T16.02 — Stamp objects into the map (v5)

Pass 6b between cleanup and validation (§D3). Objects become terrain: no entity, no
damage path, nothing new on the wire. Spawn clearance moved into `traversal.rs:272`,
so a blanketed map fails validation and **retries** instead of pass 8 quietly shipping
five spawns. §D5's counts are wrong for two scales of three — Small 18 → 12, Large
48 → 36, both measured over 333 seeds with the tables inline in `constants.rs`. The
sweep was clean at `dd3820a` and is clean again: `[0, 909, 83, 7, 0]`, safe_preset 0.
Objects push the traversable tail down (Large 0.783 → 0.751); the floor is held by the
sweep's assertions, not by the generator — the safe preset returns without re-checking
(`v2/mod.rs:146`), which predates M16. `masks.bin` is v2: 24-byte records with a
category byte, so a v1 blob is rejected, not misread. The 24 changed mask hashes are
what prove 6b ran; `meta_digest` hashes `objects.len()` unconditionally, so its 24
would have moved either way. Six fixtures broke that had nothing to do with objects —
all six hardcoded a fact about a generated world. Four were caught only by their own
vacuity guards. e2e deferred per D-07.

## T16.03 — Draw objects, clipped by the mask (v5)

Objects were on no wire at all, so `map_init` gained a section — §D8 says otherwise and
an amendment is owed, but §D6 needs a chunk→object index and deriving it client-side
would break §D2's "only the server stamps". The bake now reads fill → objects →
`destination-in`, which is what `docs/12` §2 said all along: the old
stencil-then-`source-in` clips one layer and cannot clip two. Frames are `obj_<id>`, so
the renderer draws from the wire id with no manifest fetch in front of the art. Two
instrument fixes: `CHUNK_REBAKE_MS` (§6 stated 4 ms and nothing mirrored it), and
`lastBakeMs`, which timed a whole frame's four chunks while its name said one — now max
single bake, with the old quantity kept as `frameBakeMs`. **Nothing that runs today
covers the bake**: vitest is `environment:'node'` with no canvas, and
`chunkBake.test.ts` never imports `chunkBake` — those tests pass with `bakeChunk`
deleted. The payoff lives in `scripts/checks/objects.mjs`, written and never executed;
its seam step was a `skip-reported-as-pass` and is now a `fail`, with the precondition
guarded in `cargo test`. e2e deferred per D-07.

## T16.04 — The clouds pack belongs in the sky (v5)

T16.04 says three shape families; there are **eight** — `Shape1`–`Shape8` × 5 sizes ×
3 colours = 120, plus 5 `Lightning` = §D0's 125. Reading it as three would have thrown
away five-eighths of the pack. New `scripts/build-cloud-atlas.mjs`, not an extension of
`build-object-masks.mjs`: the sky keeps soft alpha, trims at α>0 and produces no mask,
and merging them would be one script with a boolean that changes what it means.
`cloudTint` was written for a single white blob — it mixes toward the sky colour and
scales alpha by luminance — so applying it over a phase-picked black sprite darkens
twice. The sprite path uses `cloudSpriteTint`; the blob path is untouched and
`sky-math.ts` is byte-identical to `9031e62`. **The cost: sprite clouds no longer pick
up the sky's warmth at dawn** — three colour sets are coarser than a continuous mix, and
a blend needs tunables no doc specifies, so an amendment is owed rather than a number
invented. The shape pick has its own `'cloud-shapes'` seed tag and all twelve clouds'
x/y/scale/speed are pinned against `9031e62`. `storm` and `Lightning` both have no
caller, declared rather than discovered. **The unit half proves no pixels**:
`ParallaxLayer` needs a `Phaser.Scene` and cannot be built under vitest, so a green run
of `clouds-math.test.ts` does not mean the sky changed colour. The tint and visibility
assertions are in `scripts/checks/living-sky.mjs`, written and never run.

## T16.05 — Record where the art came from (v5)

`assets/vendor/README.md` **was never tracked** — `assets/vendor/` is gitignored (§A29)
and `git ls-files` on it returned nothing, so the licensing record `docs/51` §8 asks for
existed on one machine and nowhere else. The ignore now excludes the contents, not the
directory, because git does not descend into an excluded directory and the obvious
one-line negation would have looked like a fix and done nothing. Provenance for the five
sprite packs is recorded with the owner's licence quoted verbatim, fetch dates from this
box, and the source URL written as **unknown** rather than invented. `verify-assets.mjs`
derives its required-pack list from `assets/objects/manifest.json` **union**
`assets/manifest.json`'s `vendorPacks`, so the cloud atlas — a second pipeline with no
object manifest behind it — is covered too; it names each unaccounted pack and the file
that requires it, and rejects a row whose cells are blank. Row scanning is scoped to the
sprite-pack section so a CC0 Kenney row cannot vouch for a same-named sprite pack. Two
gaps recorded rather than gated on: no pack carries a `LICENSE.txt`, and §8's "CC0 only"
line does not admit this licence class — both are owed amendments, both are in the
README where an auditor will read them. e2e deferred per D-07.

## M16 — the e2e sweep, and what it cost

`./scripts/check.sh` green end to end: fmt, clippy `-D warnings`, 1115 rust tests, tsc,
714 client tests, **all 39 e2e checks**, net smoke 25/25, assets. Ilya deferred the
browser until every task was done (D-07); this is that run and the repairs it forced.

**Eleven regressions. Every one a fixture. Not one line of product code changed to fix
them.** Baselined at `f1d2d2a` with the six pre-existing `scripts/checks/` edits applied
on top, so M16 was the only variable — all eleven passed there. The single deliberate
product change is `setObjects`, a performance fix carrying its own test that is red on
`5d14aef` (`expected 32 to be 2`), plus the dev-surface accessors the repairs needed.

The cause, in one sentence: **coordinate and situation assumptions that stopped
holding.** `objects`, `birds` and `void` sampled or aimed in the wrong space;
`terrain-render`, `night-combat`, `sky`, `living-sky` and `crates` assumed a situation
the map no longer granted; `quick-throw` and `ordnance` assumed a premise they never
checked.

**§D1 is proven** — carve half an object and its art goes with it: carved half 11.6,
untouched half 0.2, ground-noise control 0.00, a 55× ratio. Rebake median 0.90 ms, max
1.50 ms against `docs/60` §6's 4 ms.

Twice the obvious diagnosis was wrong and only measuring caught it. `terrain-render`
looked like the composite rewrite or a rebake backlog; reverting `chunkBake.ts` still
failed and `pending` read 0 — it was the target selection. `ordnance` looked exactly like
`night-combat`'s obstructed lane; the probe read `blocked: false` every shot — the
approach had a maximum distance and no minimum and walked the player **onto** the mine,
where a rocket detonates on the muzzle.

The sharpest number: `birds` passed at **20.9 standalone and 2.7 in the suite on
identical code** — under load the gap between the state poll and the screenshot widened
until the bird had left its own patch. It now toggles the layer inside one frozen frame,
which has no second instant to disagree with. On a frozen frame the control is no longer
a noise floor but a **determinism self-test**: it reads ~0.1, `objects` measured 0.00
with a different instrument, and any non-zero value means something is genuinely moving.

Findings recorded in `tasks/DECISIONS.md`: D-36 the sweep, D-37 vertical self-excavation
is bounded by self-damage (~four rockets, mines inert to their owner, a self-dug shaft's
death credited to the rocket not the void — an amendment owed against `docs/21` §5),
D-38 measuring beats the obvious diagnosis, D-39 three harness traps, D-40 the frame
moves now because cloud sprites drift where the procedural blob was flatter.

## T17.01 — A lobby is a room without a world (v6)

`Room.world` is an `Option`; a lobby holds seats, a code and settings, and the map is
built on a blocking thread at match start. `RoundController::tick` splits — the lobby
half takes no world at all. **`inspect` answering `None` IS the §E1 signal**, which seven
fixtures had spelled as "the room is dead": `join.rs`'s readiness loop was
`unwrap_or(0) > 0` on it, a condition that can never be true in a lobby, so it had
stopped waiting for anything and burned its full budget every run. §E1.1: `Seats` is the
single source of seat identity and the world's player list is built from it, because with
no world there was nowhere to put a skin. §E1.2: one monotonic room clock, so **a replay
replays the lobby too** — the alternative makes `room.tick()` run backwards at match
start, which makes every command stamp and checkpoint ambiguous; skipping the lobby
seated the human after the bots and diverged at tick 600. The tick that generates a map
is excluded from `record_tick`; measuring it marked a healthy server over budget on every
round start. Known limit: `spawn_blocking` protects the runtime and other rooms, but this
room's own loop does pause for its generation and nothing measures that. `room.rs` grew
~927 lines against a ~250 guide, flagged after the fact rather than before — the miss was
the silence, not the size. `game-core` is untouched: the whole change is in `game-server`.

## T17.02 — The lobby on the wire (v6)

`lobby_state` replaces `room_list`, whose producer was its only live half — it had never
had a subscriber. `welcome` loses `scale` (a host can change it under a copy taken at
seating) and `players` (the roster is `Seats`, §E1.1); `GameScene` seeds the scoreboard
from `lobby_state` instead, or every player renders as `p1`. `set_scale` refuses through a
new `lobby_error`, because `connection.ts` drops `join_error` after the handshake settles
— a refusal that looks correct server-side and is silent at the client. `starts_in`
throttles to whole seconds: 599 updates without the guard, 12 with.

**The regression this task introduced, and the measurement that found it.**
`broadcast_lobby_state` routed through `queue_or_emit`, which for a socket still in its
join window pushes into a bounded queue; a lobby broadcasts on every join, leave, ready
and whole second, so it spent the capacity carves need. Overflow makes `go_live` fail,
the server resends `map_init` at a later `carve_seq`, and the client replays carves
against the earlier mask. `checksum` went 12.5% → 33%. Emitting `lobby_state` directly,
never queued, took it back to 17.5% — indistinguishable from baseline (p ≈ 0.75), with
the `:307` mode gone entirely (21% → 0/40).

**Three sampling lessons, all paid for here.** A 9-run clean streak read the tail of a
1-in-3. A 16-run baseline read 6% where 40 runs read 12.5%. And "`:307` only happens on
the new tree" was N=16 talking — it occurs 3/40 at baseline. The elevation was real; the
exclusivity was not.

`lobby.test.ts` was a **binary file**: one raw NUL in a hostile-input fixture made `grep`
skip it entirely and `git diff` report `Bin, 0 insertions, 0 deletions` — so "nothing
weakened" was unverifiable on the file this task rewrites most. Rewritten as escapes;
`grep -c expect` went from nothing to 55, and the next grep found two test cases every
prior audit had silently skipped.

## checksum — the fixture read the client and the server at different instants

Not a task; a gate repair before T17.03, because a flake that fires once in eight makes
every gate after it untrustworthy.

Three failure modes, all pre-existing, all **one mechanism**. `replay()` applied every
carve against `m[0]`, so a resent `map_init` — sent when the join-window queue overflows
— left the fixture comparing a full carve stream to a superseded mask. `carve_seq` was
**parsed and discarded**, which is exactly what made a resend invisible to everything
that decodes a `map_init`; it is on `MapInitParts` now and `replay` skips what is already
baked. Counts compare over the window both clients were live for —
`base = max(min(sa), min(sb))` — because per-client filtering alone leaves two clients
that overflowed at different sequences disagreeing on the count.

The larger defect was temporal. The settle loop waited for the client's stream to go
*quiet*, and **quiet is not finished**: a projectile still in flight lands after it, so
the server holds a carve the client's snapshot does not. Instrumented, run 8 of 25:
`client at seq 116, server at seq 117` — exactly one carve behind. The reads are aligned
now, waiting for the client to *reach* the server's sequence on a bounded deadline, which
asserts strictly more than before and cannot pass by looking early.

| assertion | baseline | after T17.02 | now |
|---|---|---|---|
| `:287` count mismatch | 1/40 | 4/40 | 0/40 |
| `:307` client vs server | 3/40 | 0/40 | 0/40 |
| `:624` late joiner | 1/40 | 3/40 | 0/40 |

0/40 bounds the rate below roughly 7% at 95%, not at zero — and three of these modes were
invisible for sixteen consecutive runs, so the claim is "three mechanisms closed, each
with a measured before-rate", not "the flake is gone".

## T17.03 — Public lobbies: fill to five, or bots after ten seconds (v6)

A lobby starts when it fills to `LOBBY_CAPACITY`, or when `LOBBY_BOT_TIMEOUT` expires
from the **first** seating — it never resets, and the test asserts the *time*, not the
fact: falsified by making the timer reset on join, it starts at **17.98 s against a
message predicting 18**. `LOBBY_COUNTDOWN` and `MIN_PLAYERS_TO_START` retired across
sixteen sites in five categories. The replay header **keeps its slot, written as 0** —
bumping `REPLAY_VERSION` would invalidate every recorded file to drop a dead `u16` — and
a **hand-written v2 header** now guards the layout, with distinct sentinel values per
field so a two-byte shift yields wrong values rather than coincidentally equal ones. That
suite had never had a file it did not write itself.

Three tests in this task were vacuous and each was caught differently. The
differ-control found one in the coder's own work: `RoomRegistry::new` seeds from the
**wall clock**, so "same seed, same scale" was comparing two different seeds and passing
two runs in three — a determinism test not testing determinism. And **T17.01 moved the
world to match start without moving inventory with it** — players armed on the server and
empty on screen, surfaced two tasks later by a fixture belonging to neither. Two tests
were then written for that fix and **both passed with the fix deleted**; the coder deleted
its own and kept the pre-existing one that fails hard without it, on the grounds that a
second test going green when its subject is gone is worse than no second test, because it
makes the next reader believe the fix is double-covered.

`quick_match` no longer filters on scale — §E7 randomises it, so filtering would split
every lobby by map size. Closing started matches to quick match broke **six fixtures
across five files**, all the same shape: a harness that started its room before its
clients connected, so every client was skipped into a different lobby while the test
inspected the original. That is §E4 arriving two tasks early, and it is the right
breakage.

## T17.04 — Private lobbies: a code, settings and ready (v6)

A private lobby has neither public rule: no timeout, and no fill-start, because five
people who have not agreed to play are still five people who have not agreed to play. It
starts when every seated human consents — and `all()` over an empty iterator is `true`,
so the human count is what stops an empty lobby starting itself.

**`Seat.ready` meant three things**: handshake-complete, simulated, and now consent. And
`sweep_unready` reads it — so un-readying would have armed a 30-second eviction from a
lobby §E3 says has no timeout. Consent is its own field; `ready` stays a latch that only
goes up. **That split was carrying no assertion at all** — collapsing the two fields back
into one passed all eight tests written for the feature, and the ninth exists because the
falsification found nothing. Its control is a **zero** sweep timeout, so "nobody was
dropped" cannot be explained by the clock not elapsing.

**Succession follows the clock, not the seat number.** `Seats::alloc` pops a freed id, so
a rejoiner holds a **recycled low id with the latest timestamp** — and ordering by id
would hand them the host's settings. One test of ten catches it; the other nine stay
green.

**A replay divergence this task would otherwise have created.** The header writes `scale`
at construction, T17.01 moved generation to match start, and §E3 lets the host change
scale in between — so a replay rebuilt the wrong map and diverged on tick 1. `SetScale`
is recorded as a new tag; the guard asserts on **the map's own dimensions**, because a
body containing the command only proves it was written. Tag 2 is unchanged in number and
width: un-readying is a new tag, since widening tag 2 would let every existing file pass
the version check and then read one byte short for the rest of the round.

**`every_command()` was not every command** — five tags had never been round-tripped,
while the guard that should have caught it pinned **11 against an enum of 16** with a
message still saying 10. It is now an exhaustive `match` with no catch-all, which
contains no assertion at all — the compiler is the assertion — with the count moved
beside it, because a number far from what it counts is a number nobody updates.

## T17.05 — A live match is closed (v6)

§E4 closes joins **by phase, not by verb**, so the refusal lives in the one function
`join`, `create_room`, `join_room` and `quick_match` all reach — T17.03 had gated quick
match alone, and `join_room` by code walked straight past it into a running match. It
reads the same `has_started` bit quick match reads, because `has_started` is set at
`install_world` while `phase()` derives from the world's own state, and **two answers to
that question drift through the window between them**.

**Counting seats at both ends found a leak older than this task.** Every verb attaches
before the seat path runs and attach increments the human count, so `full` and `bad_name`
had been leaving phantom occupants that consume capacity and hold a room against the
reaper. All three refusals detach now; `in_progress` refuses **before** `room.join`, so it
never reaches the allocator (D-50).

**The mid-round joiner is gone, and with it the reachable caller for all three
world-gated catch-ups** — `map_init`, `item_spawn` and `tombstone_spawn`. They are
declared dormant at their sites and kept, because §E4 leaves reconnection open on purpose
and reconnection needs exactly them. `encode_map_init_at` is **not** dormant: it keeps
three callers, including `resync_map`, which serves an already-seated client and is not a
join. The graves test is **deleted rather than re-pointed a third time** — the only route
to that code is one the server refuses to create, and a test exercising a path production
cannot take asserts nothing about production.

Two client-side tests could not fail. `joinErrorMessage` had no `in_progress` case, so the
browser would have shown *"Could not join (in_progress)."* — and the test that should have
caught it asserted `not.toBe(reason)`, which the fallback passes trivially because it
*embeds* the token rather than equalling it. Strengthened to exclude the fallback's exact
shape, since the obvious stronger form is too strong the other way: *"That game is full."*
legitimately contains "full".

## T17.06 — Lobbies and matches die when their humans leave (v6)

**The rule was already true, and this asserts it rather than building it.**
`RoomEntry.humans` is keyed on socket id and a bot has no socket, so bots can never be
occupants. Adding a filtering rule would have created a *second source of truth for
occupancy* — the registry diff is 13 insertions, 2 deletions and zero non-comment lines.

**Two mechanisms answered "the last human left", and one was lying.** The registry's
comment said the world is left standing so a player can reconnect inside the TTL, while
`Room` destroyed it on the same condition and ran first. §E5 makes the reaper the only
answer; the comment is now true. The `room.rs` unit test asserting the old behaviour is
**inverted rather than deleted** — it asserts the world *survives*, so re-adding the call
goes red. A deletion removes coverage; an inversion turns the old assertion into a
regression guard.

**Found while tracing it: `started` was set at match start and never cleared.** So a room
whose round ended with the restart vote failing — players still seated — sat in `Lobby`
refusing **every** join with `in_progress` until it was reaped, and quick match skipped it
forever. `Room` owns that bit now, and all three `self.world` assignments store it;
`restart` was leaning on an invariant that lives in `round.rs`, which is how the bit came
to be set-once-never-cleared in the first place. That last change has **no falsification**
and is not claimed as one — it is a consistency fix.

**The shutdown assertion needed two corrections.** Its first version used
`inspect(...).is_none()`, which cannot tell a stopped task from a **lobby** — §E1's own
signal. It asserts on the clock now. And the obvious falsification does not discriminate:
deleting `let _ = tx.send(())` leaves every test green, because a dropped oneshot sender
resolves its receiver just as a send does. Only `mem::forget(tx)` keeps the task alive —
observed `Some(353) → Some(384)`, *ticking where nothing can reach it*. Both are written
beside the assertion, along with the **three** `mem::forget`s on live sockets that read as
oversights and are load-bearing.

## T17.07 — The lobby screen holds the socket (v6)

`MenuScene` built `matching` and `lobby` DOM and called `scene.start('Game')` in the same
frame, so both were torn down before rendering — the lobby a player saw was a panel in
`GameScene` drawn over a world they were already standing in. The menu owns the socket now
and **hands it over**; `GameScene` adopts it rather than constructing a second.

**That last part was written and not received.** Three registry keys had no reader,
`GameScene` still opened its own connection with **no intent** — which falls through to
quick match — so both clients of one private lobby abandoned it and landed together in a
new public room. Every roster assertion passed, because two clients in one *wrong* room
see each other perfectly well. The first attempt at a discriminating assertion was itself
vacuous: `debug().seed` is the local core's seed and the check pins `FIXED_SEED`, so it
reads identically in two different rooms. **What catches it is counting rooms on the
server**, and that is permanent in `lobby.mjs` now, falsified by restoring
`new Connection()`.

Two more fell out. Handing the socket over left the **scoreboard empty** — `lobby_state`
seeds it since T17.02, and that message now arrives at the *menu*; the last one is replayed
through `emitLocal` before `map_init`, roster first, because the world must not start
before the scoreboard knows who is in it. And `enterBattle` clicked `#lobby-start`, a
deleted button, in the **shared harness every check uses**; it emits the verb now, still as
a throw rather than a silent skip.

`escapeHtml` had reached **three implementations** — byte-identical, but on a security
function divergence is a hole rather than a wrong number. One survives, the exported and
tested one. The unescaped `m.error` interpolation is closed: it carries the one
network-derived string in the lobby, harmless while every reason is a fixed literal and
live the first time one echoes something a player typed.

**Declared coverage loss:** "you arrive in a lobby" is no longer observable from a browser
— a cold page takes longer to load than `LOBBY_BOT_TIMEOUT`, measured at `~0.0s` of
waiting — so that claim lives only in `public_lobby.rs`. T17.08 makes the timeout
config-driven to get it back. And `lobby-start` was **already red at `1f7f0b4`**, asserting
a solo player never starts, which §E2 retired at T17.03.

## T17.08 — SHRED, and a menu that steps (v6)  ·  M17 complete

Title is SHRED in the display face, tagline gone; `installFont` and `DISPLAY_STACK` come
from `hud.ts`, so there is one `@font-face` and one fallback stack. Quick Game takes no
options because quick match randomises — the stepper lives on Private Game and in the
lobby, sharing `stepIndex`, which also fixes `(i + d) % n` for negative `d`. That is the
duplication pattern done right, and the opposite of `escapeHtml`'s three copies.

**T17.07's diagnosis was wrong, and only instrumenting found it.** I ruled that
`LOBBY_BOT_TIMEOUT` should be config-driven to restore the lost browser claim. It is —
`config.rs`, env, `.env`/`.env.example`/compose, `docs/41` §5 — **and raising it to 45 s
did not restore the claim.** The server had 45 seconds and never force-started. The check
was **waiting on the wrong gate**: `ready` is true only once the world exists, and under
§E1 the world is built at *match start*, so a `ready` gate blocks until the lobby is over
and then reports what follows it. T17.07's measured "~0.0 s of waiting" was never a
timeout problem — the timeout had already fired during the wait. Waiting on the **seat**
instead: `arrived in a lobby (phase lobby)`, `nothing simulating (round time 0 → 0)`,
`started itself after ~45.7s`. The config change was necessary and not sufficient, and
would have shipped as the fix.

The same check read `mapW` for *"the map is there behind it"* — that is the **client's
local core**, alive from scene construction, so it could never have said anything about a
lobby. Corrected to say what it measures.

**The HUD font has been shipping since T14 with no provenance row at all.** `docs/51` §8
asks for one and nothing checked, because T16.05's gate only looked at sprite packs. It is
in `vendorPacks` now with a `## Fonts` section, and the section scoping generalised — the
Kenney-row guard survives, verified empirically at zero rows in scope.

The font assertion is three assertions, not one: `document.fonts.check` (the face loaded),
computed `fontFamily` (applied to the title), and advance-width 264 px against the body's
210 px (actually used). Advance-width alone could be fooled by a fallback that also
differs from `serif`; (1) is what closes that.

## T18.01 — The title screen stops after thirty seconds (v6)

The attract sim stepped `ATTRACT_HZ` 20 times a second while advancing `SIM_DT`, so it
ran at **one third of real time**: warmup ended at ~30 s wall clock — un-gating damage,
starting the weather scheduler, item spawns and teleports together — and at 45 s it
rebuilt its world from inside `update()`, where a throw removes the DOM **and** stops
Phaser's loop. The picture vanishing and the button dying were one failure, not two.

§E9 does not fix the timestep: the background is the game's own sky now — seeded, needing
no `World`, no core and no server — and the **UI is built first and unconditionally**,
with everything decorative inside a guard that catches, says so once, and stops.
`Core.attract`, `Attract` and `AttractCore` lose their only caller and are declared
dormant **where a reader meets them**, per T17.05's precedent.

**Falsifying with the bug restored found a weak assertion.** `frames` still advanced —
**1187 against 3660** — because Phaser keeps calling a scene that throws, at a third of
the rate. A `>` counter test passes for a loop the defect has crippled. The **click** is
the acceptance criterion; the counter is a diagnostic that says how badly. The pixel check
needed `freeze` for the same class of reason: the sky twinkles and drifts, so two samples
differ whether or not a backdrop exists, and its own control caught that on the first run.

**And the first version shipped `__title` in the production bundle.** Guarding the call
site was not enough — *a class method is reachable from the prototype, so the bundler
keeps it however the call site is guarded; what it deletes is a block behind a `false`
literal*. The guard has to be **inside** the method. `__menu` had shipped the same way
since T17.07, and `no-dev-surface` passed both, because its `FORBIDDEN` list predated both
handles. **The check whose purpose is enforcing §C17 was blind to the two newest
violations of it** — the list is the deeper failure, so anything writing to `window` now
belongs in it the moment it is written.

## T18.02 — Bots that explore, arm themselves and run (v6)

`Wander` **became** exploration rather than sitting beside it — a per-bot bitset of visited
cells, head for the nearest unmarked one, mark it seen on arrival or on giving up. Not
pathfinding, and the doc says so. `spawn_points` is now consulted nowhere in the file.
`Coverage` is allocated **once per bot**, lazily, because `Bot::new` has no world to size
it from; `think()` still allocates nothing per tick, and byte-identical inputs still holds
over its full 600 ticks.

**Coverage, measured at `9a19b2d` before the change** because the old model could not be
re-measured afterwards — five bots, skill 0.85, 120 simulated seconds:
`11→21`, `18→24`, `24→24`. **Two better, one tied**, and the assertion is per-case `>=`
with the **total** strictly `>`. Not `>` on all three quietly relaxed later: two wins and
a draw is not three wins, and the doc comment says so. A separate vacuity control derives
its floor from the setup — one cell per bot — so the comparison cannot be satisfied by a
too-low before-number.

**The `balance.rs` fallout was a real bug, not a moved premise.** `choose_goal` asked
`selected_weapon` — *the one in hand* — so a bot holding a flat laser with a loaded pistol
two slots over counted as **unarmed** and went shopping for a weapon it already had:
**12583 shots refused against 474 fired**. `has_firable_weapon` asks every slot. The three
surviving `selected_weapon` callers are each correctly about the held weapon — a stat, a
stand-off range, and what you fire.

**And that fix was unguarded.** Reverting it left every test green; the laser fixture
caught it only *in combination* with the rest of the task, which is not a guard. Verified:
with the revert, the new test fails alone with 795 filtered out while the laser fixture
**passes**.

Four fixture faults were made and measured out, all the same shape — `clear_line` finds
clear **air**, so both players fell and a distance between two falling bodies says nothing
about who walked. Retreat's healthy control asserts the bot **holds its ground**: at 120 px
it is already at a bazooka's stand-off, so asserting it closed would assert against §C20.
`AttractCore::step` is a hand-rolled mirror of `drive_bots` with no caller since T18.01 —
explicitly **frozen**, naming `to_command` and `wait_for` as the two this project has
already paid for.

## T18.03 — Clouds are bigger and vary in brightness (v6)

**The frame is authoritative (§E11.1), and the bug was `halfW`.** Measured: 120 atlas
frames, width 33–288 against `CLOUD_TEX_W`'s 220 — so forcing the constant would have
been a per-cloud change spanning **8.7×** that discarded the pack's five seeded size
variants. `halfW` derives from the drawn width now: it had assumed the constant, a **6.7×
error in the wrap offset** for the narrowest frames, which is why the seam was wrong in
both directions. The asymmetry that hid it: `setDisplaySize` ran only on a colour-set
change, `setScale` ran every frame. The comment claiming the sprites were drawn
*"bit-for-bit T15.03's"* was reassuring a reader about exactly the broken thing.

Drawn width, seed 4242, shipped picker against shipped atlas: **mean 97.8 → 127.8 px,
+30.7%** — §E15's numbers stand as written, once something reads them.

**Two vacuous tests, both found by falsifying.** The seam check first sampled a strip
centred on where the twin *said* it was — true however wrong `halfW` is, and green with
the fix reverted. Rewritten to predict from the drawn box, it **still** could not fail,
because a single pinned clock held no disagreement (D-29). It sweeps 16 drift moments now
and fails loudly if none straddles an edge. A third fault on the way: a screen-pixel strip
built from **camera-space** coordinates, 640 against a 1280 viewport — the conversion
happens once at the source now, so no check handles two spaces, which is `objects.mjs`'s
lesson from M16.

Brightness is a **grey multiplier within** the phase's colour set, never across it, so a
black cloud cannot come out white at midnight; the band's ceiling is 1.0 because a tint
cannot brighten past the art's own white — the variation is a range of shadow. All four
draws are unconditional and in fixed order, asserted directly, because a conditional draw
would consume two `rnd()` instead of four and shift every shape from the second cloud on.
`CLOUD_SKY_MIX` and `CLOUD_ALPHA_FLOOR` are **kept** — they are the procedural fallback's,
live code with tests, and `sky-math` is zero-diff.

**Found while verifying, not ours:** `rooms.rs:751` compares `/healthz`'s `AtomicUsize`
gauge against a registry read taken under the mutex two lines above — two representations
of "how many rooms", updated at different moments, across an HTTP round trip. A race by
construction, load-sensitive, and it will cost the M18 sweep a run.

## T18.04 — rocks and bushes are bigger, and sit on the ground

Scale is **per category to a target player-height** (`OBJECT_TARGET_PLAYER_H_BUSH` 1.5,
`_ROCK` 2.25), so widths now reach 197 px. Seating is a **percentile of ground depth over
the object's full width**, not the centre column: the anchor's feet line was one column's
opinion of where the ground is. `contact_fraction` reads the rows *directly beneath* the
base — rows the object can never occupy — so burial and resting are one test and
self-support is impossible; four earlier measurements each read a different thing (a ±16 px
band, the object's own silhouette, pre-stamp terrain, own-pixel exclusion).

**The sweep decided the counts**, not the threshold: Small 12→**9**, Medium 30→**28**,
Large 36 unchanged. `fraction min` Small 0.762 / Medium 0.835 / **Large 0.754** — above the
0.75 floor and above D-23's 0.751. All 24 golden mask rows moved, 12 per generator.

**Found by falsifying the two seating gates one at a time:** gate B goes red, **gate A was
green under every test** — its only signal was the golden table, which moves anyway.
`a_footprint_that_mostly_finds_its_ground_outside_the_band_is_refused` is that missing guard
(D-56). `replay_run` gains a straddle guard: 0 or 20 of 20 both fail loudly, because a floor
cannot tell a moved boundary from a broken feature.

**Finding (D-57):** §D5 spells `OBJECT_MIN_SEPARATION` 64 *between centres*, so nothing
lies — but 64 was calibrated when a median rock was ~50 px and §E12 makes it ~75, max 197.
Measured, nine maps: **27 of 3132 pairs overlap by box, worst 50 px**. Not a correctness
defect; a §D5 value question.

## T18.05 — Toxic rain poisons on hit (v6)

Puddles are gone — `TOXIC_PUDDLE_EVERY/_RADIUS/_LIFE` and `TOXIC_DPS` deleted along with
`Puddle`, `land()`, `circle_overlaps_aabb`, `HazardKind::Puddle`, the wasm export, the
`WeatherState` field and the sandbox renderer. **Two of those deletions were traps.**
`TOXIC_DPS` **meant two things**: `defs.rs` reads it for the toxic grenade's burn zone, a
§B7 weapon §E15 never mentions, so retiring it as written would have cut that weapon from
6 dps to 2 **in silence**, with the test that pins it "fixed" to match. It is
`TOXIC_GRENADE_DPS` now. And `TOXIC_PUDDLE_EVERY` was the **drop cadence**, not a puddle
property — `TOXIC_DROP_EVERY`, 0.4 unchanged.

**The roof rule is one function used twice**, and the meteor half was load-bearing: the
shower had **no occlusion test at all**, and `explode` damages by radius through terrain —
*"a meteor dealt 21.999998 through solid rock to a player under a roof"*. It is asked
**before** `explode`, because the blast carves: a meteor that opened the ceiling first
would find open sky above everyone it had just buried.

**Reset versus stack is asserted on the total only**, second hit at half the duration —
inside the window, since a hit after expiry gives both models the same answer. Falsified by
making `poison()` add: 11.97 against 9 for reset and 12 for stack.

**Two findings that were one story.** The only test asserting weather damage respects
shield and i-frames went with the puddle mechanism it happened to use — and the same diff
added a **second damage path** that ignored both, fifteen lines under a comment saying every
effect damages through one path so shields and i-frames are handled once. Worse than
cosmetic: `apply_damage` is also where `stats.deaths`, the killer's score and
`DamageOutcome::Died` are produced, so a raw subtraction could cross zero with `alive` still
true — a corpse walking, in exactly the `e2e` builds `hud-bars` photographs. Both call sites
route through `apply_damage` now, and the successor test asserts **through the poison path
end to end** rather than by calling `apply_damage` directly, so it fails if poison ever
stops using it. **The rule was true by construction, stopped being asserted, and stopped
being true in the same change** — which is why "it survives by construction" is not a reason
to let an assertion go.

Two untracked probe files were running in the suite with **four `it()` blocks and zero
`expect()`** — `__spike` recurring.

## T18.06 — Inventory tiles show the item (v6)  ·  M18 complete

The tile drew `tile.textContent = tileLabel(slot)` — the raw registry key in a 46 px box —
while the same item on the map was a sprite. `artFor()` is now the fallback order written
**once** — atlas frame, else the procedural canvas under the same key, else nothing — and
both `ItemLayer.spawn` and the tile resolve through it. `spawn` had expressed that order as
two `frameFor` calls with different probes.

`spriteKeyFor` splits *which art key* from *does art exist under it*, because the inventory
holds a **registry key** and art is keyed by `ItemDef.sprite` — a different string, and the
tile has no `WorldItemView` to ask with. `ensureItemTextures` is untouched and still called
only from `ItemLayer`'s constructor; the panel takes an injected `artUrl`, so there is no
second painter table.

**`frameFor` then had no production caller** — imported by one file, its own test — so it
was **dead code kept alive by nine assertions, including the drift test written to guard
it**. Deleted, `describeRoom`'s answer for `describeRoom`'s reason: three lines composing
two functions that remain, not a subsystem anyone would revive. And **what replaced the
drift test is stronger**: it had compared `frameFor` against the function `frameFor` called
— true by construction — where the guarantee that matters is that the **two paths that
exist** agree. `world_and_inventory_resolve_an_item_to_the_same_art_key` asks with an item
id on one side and a registry key on the other, with a `checked > 1` control because the
loop passes on an empty registry. *If those diverge, a bazooka is one picture on the ground
and another in the bag.*

**The byte floor is the assertion worth keeping.** `bytes > 100`, not the observed 295: a
URL being set is *intent*, and a 1×1 transparent PNG (~70 bytes) would satisfy it while
rendering nothing — the exact failure this task exists to fix. The pixel comparison is on
**digest not mean**, and the control is the **empty tile's own art layer in the same frame**.

**Two limits recorded rather than left implicit.** The art cache cannot poison — the
procedural table is registered synchronously before any tile renders, so a cached `null`
belongs only to a sprite neither source will ever hold — but if the atlas arrives *after*
the first inventory render, that sprite is pinned to its procedural answer for the session:
a quality ceiling, not staleness. And **the tile and the world can diverge in
*presentation*** — scale, tint, crop — while resolving identically; §E14's claim is about
resolution and that is what is tested.

## M18 sweep repairs — six fixtures, no product code

The M18 boundary sweep ran 191 assertions and six checks red. **Five were T18.04's**, all
deterministic, and **`crates` was not a regression at all** — 7 green runs against the
sweep's single red, a check that loses its timing under a forty-check suite (D-58's
discipline on the browser side). T18.04 shipped them because **its gate was Rust-only**,
which is the second cost of one missing `npm --prefix client test` (D-59).

**Four were one sentence: bigger objects changed the terrain under the player.**
`terrain-render` scored crater sites off `surface_points`, and **object tops are surface
points now**, so most candidates were a thin silhouette in open air and the rockiest fell
to 37% — it searches the on-screen region directly. `audio`'s log said it outright,
`cues after walking: land, land` — the player *falling*, not walking; and teleporting it
somewhere better was **worse**, because a position that satisfies a mask scan is not one
the physics accepts. `objects` was not a frozen-frame problem at all: the determinism probe
read 0.00, and the real cause was `leftRect` pinned to the object's **top** while the carve
sits at `y + h/2` — **for `h > w` they never overlap**, and §E12 scales by height. The
carved half moves 34.1× the untouched one again.

**`birds` was terrain too, and my "measurement bug" reading was half right.** The bird was
**buried in rock — 121 of 121 samples solid in an 80 px box** — and `patchFitsIn` only ever
asked whether it was inside the viewport. ***In frame is not the same as visible.***
The measurement half is real as well: `changedBetween` returned `[1280..-1]x[720..-1]`, an
**inverted empty rectangle**, and the companion assertion reported the bird at the exact
viewport centre — **defaults standing in for values never computed**. It returns
`{n:0, box:null}` now and fails saying there is no drawn position.

**`void` cost two rounds and taught the most.** A **D-29 violation** — `fail()` records and
returns, so `ok digging beside the player: column x=undefined` printed anyway — meant
**every later message about the shaft described shots that were never fired**, and sent two
of us hunting a bazooka that spawns and never detonates. It does not exist: a control shot
fired sideways carved 1032 px of solid, and the "aim at own feet" probe was inside
`AIM_DEADZONE`, so it fired sideways into a chasm where the void correctly despawned it.
Three of the probes used to chase it were themselves broken — a target box with 0 solid
before the shot, a census keyed on constants that do not exist reading `0 → 0`, and an aim
field that is `undefined` comparing nothing to nothing. *Only measuring an effect gave a
true answer.* The real defect was mundane: the dig site is 136 px away and the check
searched one body width.

Two rules this milestone adds, both about **a measurement taken at a moment that looks like
the end and is not**:
- **Releasing the key is not arriving.** The player crosses the target airborne and slides
  another 33 px after key-up — the difference between 44 px short and 0.5 px. Sibling to
  the checksum repair's *quiet is not finished*.
- **A test's own deadline is a claim about the system's timers.** `net-smoke` waited 10 s
  for a map while `LOBBY_BOT_TIMEOUT` was 10 s — 25 independent even-money races, which is
  why it failed 13 then 5. And its joins are **strictly sequential** (`await` inside the
  loop), so no lobby ever filled and every client waited out the timer alone. When a
  feature introduces a timer, every generous fixture deadline becomes a coin flip silently,
  and reports it as the feature failing.

## T19.01 — bullets fly, and a bullet is not a small blast

**§F1 as written did not survive contact.** "A projectile whose burst is a very small
`Blast`" deals **zero damage**: `explode` measures falloff centre-to-centre, a round stops
*inside* the body ~8 px from centre, and the guns' radii are 3–6. The coder deviated to a
`bullet::resolve` — full damage to the body it stopped on — and the doc was amended to
match (D-62). The spec was wrong and the builder was right.

**Then the deviation was applied in one of the two crates that decide what an impact
means**, and `game-wasm` kept exploding. Not zero damage, as the review first read it: the
sandbox fallback hardcodes a **bazooka's** 42/45 for every projectile, so a 14-damage
pistol dealt ~45 with rocket knockback, credited to weapon 0 — a defect older than this
task (D-63). The rule: when you fork a shared path on purpose, grep the *other*
implementations of the same decision before calling it done.

**Two tests were vacuous and are now not.** The owner-grace test survived deleting the
guard — `MUZZLE_OFFSET` 18 clears the 14 px half-body, so a round always spawns outside
its owner and the test pinned the offset. It spawns *inside* now. The straight-flight test
survived deleting the guard too, because the table is already 0.0; `integrate()` is
extracted so a bullet can be flown with gravity 1.0 and the guard is the only thing
keeping it flat. Both verified red-then-green twice, once by each agent.

**And every thrown weapon has launched with the bazooka roar** since the cue was written:
`String(p['weapon']) === 'grenade'` against a wire that carries a numeric id has never
once been true. Keyed through `WEAPON_KEYS` now, with weather explicitly silent so the
unmapped counter is assertable at zero.

Gate: `check.sh --fast` EXIT=0 (36 Rust suites, game-core lib 815, combat 37; client 49
files / 754 tests), clippy clean. **Browser suite deliberately not run** — T19.01 breaks
`ordnance-visible`'s hitscan half by design and T19.02 repairs it; the full gate runs at
the pair boundary (D-61).

## T19.02 — you can see a bullet, and three fixtures that never measured what they claimed

**The moving-streak assertion is the deliverable, not the drawing.** `bullets-visible`
samples the same lane twice ~300 ms apart with the game *running* — no `freeze` — and
requires the streak to have moved. That is the one assertion a hitscan build cannot pass,
and the old check could only photograph a tracer by freezing the frame first, which is the
check telling us in writing that a player could not see it.

**It was still too weak twice over.** First-to-last comparison proves "drawn in ≥2
places": the reviewer froze the drawn position after four updates and it **passed**. It
requires motion between *consecutive* samples now — and the falsification for that had to
be built carefully, because stalling after 4 moves is caught by the old rule too and
proves nothing about the change. Stalling after **12** gives `706 → 500 → 492 → 492 → 492`,
which the old rule passes at 214 px of first-to-last travel and the new rule fails.

**`two-clients` was the interesting one, and both of us were wrong about it.** The review
called it a T19.01 regression from a control worktree: 6/6 green pre-bullet in a tight
8272–10240 px band, 2 zeroes at HEAD. The coder probed instead of repairing and found the
fixture never did what it said: `BAZOOKA_COOLDOWN` 0.9 s against a 0.25 s loop meant **9 of
12 shots were silently refused**, so a 4-rocket stack never emptied and **the SMG was never
fired at all** — §F1 could not have reached it by the path described. It also **never
aimed**: Playwright leaves the mouse at the top-left, so twelve rockets went up-and-left
and hitting terrain was luck of the spawn point. A latent flake, older than M19.

Repairing it exposed a **second** pass-by-luck in the same file: it pressed `Digit2` and
asserted only that the selection *changed*. The quick bar is one-indexed, so that selects
slot 1 — it passed because selection happened to start at 0, and it failed against a
perfectly-behaving client the moment the stack emptied properly. Both ends are counted
now: shots fired against rockets that left the muzzle, so a refused shot is a finding
rather than a smaller crater.

**Full gate GATE_EXIT=0** — fmt, clippy, workspace, typecheck, client 49 files / 761
tests, **e2e 41/41**, **net smoke 25/25**, assets. Net-smoke and the asset check ran for
the first time this milestone (D-64: `set -e` had been exiting at e2e). `two-clients`
5/5 green at 5983–13044 px; `bullets-visible` green under full-suite load.

## T19.03 — hold to empty the clip, and a flag the spec could not express

**§F3 named `laser_smg` as automatic and `laser_smg` is `Hitscan`**, which had no `auto`
field — the set the spec asked for was inexpressible. The flag lives on both deliveries
now, behind one exhaustive `WeaponDef::is_auto()`, because keying a repeat off a weapon
*key* or off "is it a projectile" is §B16. It also bought the check its control: the laser
**pistol** is the same delivery as the laser SMG and differs in exactly this flag.

**A blocked hold banked unlimited cadence.** `since += dt` ran *before* the blocked
checks, so holding fire for 3 s on a spent SMG — or a non-auto weapon, or nothing selected
— and then switching without releasing fired **30 shots in a single frame**, all but one
refused by `fire_ready_at`. That is the flood §F3 forbids, arriving faster than the 60
msg/s it names. `since` clamps to one cooldown while blocked and shots per frame are
bounded by `floor(dt / cooldown) + 1` — derived from elapsed time, so a genuinely long
frame still pays what the wall clock earned. The test that pins the *other* half: a
blocked hold of 1.5 cooldowns then an unblock fires exactly **1** immediately, so a lazy
`since = 0` fix fails it.

**The two registry tests could not see a total break of this task's deliverable.** They
re-derive the answer by parsing the Rust source, which protects the table and leaves the
**emitter** bare — handing every item a bazooka's `auto` and `cooldown` left all twelve
green (D-67). There was no Rust test of `item_registry_json` at all. There is now, and it
is exhaustive rather than spot-checked, because the failure mode is a blanket.

**Two instrument findings.** One of the coder's own tests was vacuous — removing the
release reset stayed green, because the rising edge already zeroes the clock — so the dead
line went and the test was rewritten around ten taps. And **`vitest run` does not
typecheck**: five strict-mode errors passed the suite and were caught only by `tsc`. A
green client suite is not evidence the client compiles.

Gate: `--fast` EXIT=0 (50 files / 777 tests), clippy clean, `e2e ordnance inventory-ui`
3/3 — smg 6 rounds at ~10/s ideal, laser pistol exactly 1, right button 0 with a left
control at 3.

## T19.04 — §C20 repealed, and a falsification left in the tree

**No pre-existing green-gate claim for T19.04 can be true**: a forced detection-collapse
(`perturbed[*at] = *buttons;`) in `replay_run` fails `cargo test -p game-server` outright.
Restored — 20/20 diverge. **Defusing the `standStill` landmine deleted its tripwire**: the
retired constant was its liveness probe too, so `?? 0` read a dead page as settled. Throws
again; settling needs `grounded`. **My instrument lied** — `check.sh | tail -80` reports
tail's status. Two of five new tests were vacuous on a stall; four `100.0` vs `WALK_SPEED`
150 — pinned, falsified live. **`bullets-visible` red then green under load, but settled
before `standStill` — no causal path, a load flake.** EXIT=0; 2366 Rust, 778 client, 41/41.

## T19.15 — the wasm-build coin flip is a race; hud-timer's premise is wrong (PARTIAL)

**`wasm-pack` parses the `package.json` it just generated** as `HashMap<String,String>`
(`manifest/mod.rs:634`) and line 7 of that file is `"files": [`, so any read fails exactly
there. `create_pkg_dir` deletes it first, so a lone build *cannot* fail — 18 serial runs
did not, and the old "deleting it changes nothing" was a no-op duplicating wasm-pack's own
step. Two builds sharing one out-dir do fail: 3/6, plus a second face (`wasm-opt` ENOENT)
reading as a different bug. A lock in `wasm-build.mjs` gives 0/22; cutting only
`acquireLock()` restores 3/6. **`backdrop-real` was attribution, not budget** — the chamfer
(66/143/257 ms) was paid in a 5 s `it()` while a 120 s `beforeAll` already existed.
**`hud-timer` is NOT fixed and the task's premise is wrong**: load is not the variable
(idle 44.15, loaded 44.87, full suite 45.1; near-failures one in each arm), a repair
attempt tripled the variance and was reverted. Box left unticked.

## T19.14 — there is no join race; the log was lying (PARTIAL: roster half)

**`in battle (… 0 players)` is a stale read.** `enterBattle` never reassigned `d` after the
simulating-wait, so the `waitPlaying:false` path logged a roster captured before it — and
those four checks are exactly the four reporting it. Over 10 runs stale was **0 in 8**,
fresh **2 in 10 of 10**, all green. `players` comes from the snapshot — the full roster
including self — so empty means *no snapshot yet*. Now waits on `playerCount >=
expectPlayers` (default 1: a no-op for **18** of 24 sites, **six** opt in to 2) and throws
loudly; falsified with `expectPlayers: 3`. **10/10.** **Vite half not done — booked T19.16.**

## T19.05 — the shovel, and the end of the melee cabinet

**Retired, not deleted** — both tables are id-indexed, so the five keep their ids at zero
weight and the shovel takes 24. **Bots held it forever**: melee carries its range in
`Delivery`, so `choose_weapon`/`should_fire` scored a 54 dps shovel above every gun at any
distance — and three fixtures went on passing while swinging one (`world::wield` now
exists). **`die` dropped it**, so every death minted a second; one `STARTING_KIT` list
serves the grant and the exemption. **`crates` moved**: zeroing five weights changed the
column sum, so `gen_range` consumption shifted and the shared `"items"` stream re-dealt the
crate — re-seeded 7 → 31337 after five probes. EXIT=0, 41/41. Rest in `HANDOFF-M19.md`.

## T19.06 — rain that falls on you hurts

**0.26 expected hits a shower, before**: 20 drops (8.0/0.4) uniform over a 1536 px map
against a 20 px body, 6 damage a hit. After: 54 drops × a 76 px target (20 + 2×28) =
**2.67**, at 18 a hit. **The task says to share the blast helper — sharing it carves a 28 px
crater per drop**; `splash_poison` is a distance test beside `poison_lands` instead. **The
roof is now asked per victim**, since a radius stops the two coinciding. `drops_per_window()`
needs `ceil`: 8.0/0.15 truncates to 53, reality 54, and three sites each had the arithmetic.
A 12 px fixture roof is no longer cover at 54 drops, so `ROOF_THICKNESS` is a named 40 —
measurement in the handoff, with the load numbers and the missing projectile cap.

## T19.07 — private-game settings: the wire, and the match that honours them

Wire keys `bots` / `start_kit` / `round_seconds`; replay tags **19, 20, 21 appended** — the
header is fixed-layout and untouched. **The sweep's "contradiction" is not one**: §F7's last
paragraph says the env var stays the default, so the setting writes `config.round_seconds`
the way `SetScale` writes `map_scale` and the seven `ROUND_SECONDS` checks are untouched.
**The task gap was real — nothing granted a kit on respawn.** `die` drops everything but the
issued shovel, so a match-start-only grant means "for your first life"; deleting the new call
leaves `[(24, 1)]`. `tick_inline` never returns `Death`/`Respawn`, and `cargo test -p
game-wasm` runs **zero** `wasm_bindgen_test`s — both in the handoff. EXIT=0, 41/41, 25/25.

## T19.07 follow-up — a lobby setting belongs on `Config`, not on `Room`

**`bots` and `start_kit` were lost across a round restart**: `restart()` writes a *new*
header, and the host's `SetBots`/`SetStartKit` sit in round one's file, so round two
replayed bots-on kit-none — bots the live round never seated. Both moved to `Config`,
which is what `from_config` reads; `bots_enabled` stays its own flag so "off" is
reversible. `REPLAY_VERSION` 3 → 4, two bytes **appended**, `HEADER_BYTES` 45. **`restart` rebuilt the
path from `config.replay_dir` instead of the directory `start_recording` was given** — two
stray `.replay` binaries in the crate root, missed by an anchored `/replays/`;
`Room::replay_dir` fixes it. T19.19 booked. EXIT=0, 41/41, net smoke 25/25, assets ok.

## T19.08 — the private lobby's settings panel

**One pure function owns both halves.** `settingsControls` computes each arrow's disabled
state by *calling* `stepSetting`, so the screen cannot disable one set while the wire
refuses another — the failure that looks exactly like a working panel. A matrix test
asserts that equivalence over every seat, timer value, kit and direction, with a control
that both answers occur; breaking the link reddens two tests. **Enum settings wrap, the
timer clamps** (§F7's "ends disabled at each bound"), said in the code so it is not tidied
away. **Task defect: `canChangeSettings` does not exist** — it is `ownsSettings`, moved
inside `stepSetting`. EXIT=0, 41/41, 25/25, assets ok.

## T19.09 — the teleport charge is 1.5 seconds

`TELEPORT_CHARGE` 2.0 → 1.5 (§F8). The sweep was right that the task's stated worry is
unfounded — the client has no copy, all 28 read sites were already pinned — and right that
the real risk was the inverse, so the gate was the deliverable: **a shorter fuse teleported
nobody by accident**. Added `the_charge_lasts_exactly_teleport_charge`, the only fixture
pinning the *duration* rather than "it fired eventually"; falsified at the live binding site
(red at tick 46 of 90), counted in **ticks** because both clocks are accumulated `f32`s.
Four stale "two seconds" comments repointed. `teleport.mjs:211` noted, not fixed — HANDOFF.
EXIT=0, 41/41, net smoke 25/25, assets ok.

## T19.10 — fog fills the screen

A grey screen-space veil at `FOG_SCREEN_ALPHA × strength()`, `DEPTH.fog = 55` — the 50–60
gap the sweep named, so `terrain-render`'s pinned depth list is untouched, and above the
lightmap so the acceptance is the alpha rather than alpha × the night curve. Acceptance is
an **alpha composite**, not a delta: error 0.6/2.0 (sandbox), 0.6/3.5 (game). The strength
comes from Rust through WASM (`fog_strength`), never a second smoothstep. **The veil broke
`crates`**, measured 3/3 — fixed by the new `WEATHER` switch, which is also what makes
`fog-visible` possible at all (HANDOFF). Falsified: `weather-visible` stayed green, §C0 live.
EXIT=0, 42/42, net smoke 25/25, assets ok.

## T19.11 — fire is an object

`WEAPON_FLAME` (id 25, appended) is a `Delivery::Projectile` with a fuse, no contact
explosion and a new `Burst::BurnsOut` — a grenade that does not go off — so it bounces,
rests and expires on the **shared** step. `weapons/flame.rs` holds only the continuous burn,
the scorch timer (derived from `spawned_at`, no new field) and the global cap. Three things
the task file does not mention, one of them a bug it would have shipped: a flame needs a
`WeaponId` (two languages); `Projectiles::step` stopped every projectile on a body, so a
flame died on the person it lit; `BurnField`'s overlap test ignores `h` — all three in
HANDOFF. Nothing emits a flame yet; that grep is T19.12's. EXIT=0, 42/42, 25/25, assets ok.

## T19.12 — what lights a fire

Three emitters, one `light_fan`: the flamethrower's `Delivery::Flames` (replacing
`Delivery::Cone`, deleted with `cone.rs`), the molotov's `Burst::Flames` (replacing
`Burst::Zone { Fire }`), and a vent's afterburn. `BurnKind::Fire` is retired; `BurnField`
holds the toxic cloud alone. **The balance harness says §F10 was the fix T11.09 wanted**:
flamethrower 0.37 → **1.33** dmg/bot-s, molotov 0.46 → **1.48**, self-damage 1.68/1.79 →
**0.00** — `hazard_at` can now see fire, the reader that had to be re-pointed or bots walk
into flames with every test green. The measured reach, and two shared bugs found (a derived
timer double-firing on `f32` drift; the stand-off re-derived) — HANDOFF. EXIT=0, 42/42.

## T19.13 — flames on screen

A flame is drawn per object — a flickering blob keyed to id + time, no trail once it rests
— on its **own non-additive Graphics**: ten overlapping oranges summed past white, so fire
read as steam *and* hid from the check (a saturated centre has `r-b = 0`; hot pixels 1551 →
2952 once painted). Both burning-ground draws go, and the `'fire'` `HazardKind` with them.
**Task defect: the ≥12 clusters asked for is arithmetically impossible** — 24 flames over
~100 px with `FLAME_RADIUS` 10 touch — so `fire-visible` counts at both ends instead, and
found a real bug: the cap culled flames **in silence**, 176 live on the client against 160.
Falsified by drawing the disc §F10 replaced. EXIT=0, 43/43, net smoke 25/25, assets ok.

## T19.15 — the `hud-timer` sample was a moving rectangle

The last open half. `dr` differenced the mean redness of **two different rectangles** —
`#hud-timer` is right-anchored, so "1:29" measures 111 px and "0:59" measures 121 — against
a sky that drifts −15..−17 over the 30 s between the two frames. Forcing both samples onto
the narrow rect reproduced the failure **8 of 8** (39.3–39.9 against a floor of 40), which
is the recorded "the `after` sample is occasionally ~5 low", exactly. Replaced by the
**fraction of pixels above redness 100** — 0.00% → 27.2%, spread 0.02 over 8 runs — plus the
control **region** §C2 asks for and this check never had. Falsified at `hud.ts:189`. 20/20
wasm, 12 concurrent, 5×800 suite + 800 at load 11.6. EXIT=0, 43/43, 25/25, assets ok.

## T19.16 — the vite deadline was never timing vite

`e2e.mjs` started vite with `npm run dev`, whose **`predev` hook is the wasm build** — so
the 90 s window whose message says "vite did not report a port" was timing a release Rust
build, then a lock wait, then vite. Measured on the identical spawn: **11.7 s to the port
line, 11.6 of it `predev` and 0.1 s vite**; 19.9 s with one other build holding T19.15's
lock; 93.3 s with twelve queued. **Reproduced through the real path**: 24 queued builds, then
`e2e.mjs title` → the exact string, with vite never asked to do anything. The build now runs
*before* the clock and vite starts with hook-free `npx vite`, so the untouched 90 s bounds a
0.1 s step. Same queue: 1/1 in 66.8 s. EXIT=0, 43/43, 25/25, assets ok.

## T19.17 — the crate you cannot pick up is a crate you may not pick up

Reproduced on 555 (crate 11, ~430 polls, closest 0.1 px), then measured **inside
`resolve_pickups`**: 3863 samples with the server's own `p.body.pos` under 60 px and **0.17 px**
at the closest, so both ends are inside `PICKUP_RADIUS`. The crate holds `item 22 x2` — **two
molotovs**, not a medkit — and the walker is already at `MOLOTOV_AMMO` (2) from a ground
pickup, so §C24's one-slot-per-weapon rule makes `add` return `Full` and the item correctly
stays on the ground. **The "MEDKIT, heals=0" was the instrument**: `crate_spawn` carries no
`item_id` and the mirror coerced the absent field to `0`, which is `MEDKIT` — so every crate
was also labelled "Medkit" on screen. Now `null`; falsified both ends. EXIT=0, 43/43, 25/25.

## T19.18 — the client subscribed a frame after its own inventory arrived

`broadcast_inventories` fires at match start immediately after `map_init`, and `map_init` is
what moves a client out of `MenuScene`; `GameScene` registers `on('inventory')` in `create()`,
a frame later. So the one `inventory` a menu-entered client gets for its first life landed on
a socket with no listener — `debug().slots` all-null for the round, on **every** such client.
`Connection` now latches current-value events (a **set**, not a fourth bespoke buffer beside
`pendingMapInit`/`pendingLobbyState`/`pendingSnapshot`) and replays the last one to a late
subscriber on a **microtask**, so no scene is re-entered mid-`create()`. `m10-checkpoint`
selects by name again; the crater is the second end. EXIT=0, 43/43, 25/25, assets ok.

## T19.19 — thirteen, not fourteen, and none of them needed a browser

`grep -c` says 14 because `lib.rs:1322` spells the attribute in a **doc comment**; there are
13. The crate mentions neither `js_sys` nor `web_sys`, so all 13 run natively: converted to
`#[test]`, `wasm-bindgen-test` dropped from `Cargo.toml` so the attribute no longer compiles,
and `no_test_in_this_crate_is_invisible_to_the_gate` scans the source for whoever adds it
back. **3 passed → 17 passed.** Nine are duplicated by `client/src/core/index.test.ts`, which
drives the real `pkg` in the gate — including `constants_json`'s six values, so §A19's
crossing was pinned after all. Genuinely dark: `buried_slots`, the seed's **high half**,
duplicate `add_player`, `set_player_state`'s velocity, two `load_mask` rejections. EXIT=0.

## T20.01 — the host was not losing permission, it was losing its seat

`settings_owner()` is derived from the seat list, so the 30 s failure was `sweep_unready`
freeing the host's seat — `docs/74:110` forbids it, and public lobbies had the same eviction
with no §E3 clause to name it. The sweep now runs only where a map has gone out, windowed
from `map_init`, **not** `joined_at`. **`lobby-start` was green on a ghost**: the swept
human's id was recycled to a bot whose snapshots kept flowing down the human's socket —
`3 players`, all bots. It reads 4 now. Plus `lobbyErrorMessage` and the `SessionMap` half of
leaving; `ctx.detach` is unreachable from the room task and untouched.
EXIT=0, 43/43, 25/25, assets ok. Full entry in `tasks/HANDOFF-M20.md`.

## T20.03 — promotion already worked; nothing on screen said so

`settings_owner()` is derived per call and both departure paths already rebroadcast, so the
report's "promote the next player" was true and **invisible**. `RosterRow.host` derives off
`settingsOwner` — no fourth flag — and is **private only**, because `check_settings_change`
refuses a public lobby before it looks at the owner. The marker is in the row's **text**, so
the browser check reads `textContent` and deleting it goes red twice; the server test that
was missing is about the *telling*, and fails when `Leave`'s `note_lobby_change()` goes.
`ROOM_EMPTY_TTL` untouched: measured, an emptied lobby closes within `TTL + REAP_INTERVAL`.
EXIT=0, 43/43, 25/25, assets ok. Full entry in `tasks/HANDOFF-M20.md`.

## T20.02 — there is no "dude"; there were four copies of one read

The default is `Player`; the defect was `MenuScene.identity()` re-spelling the three
`deepcut.*` keys and reading them **raw** — the live binding site for all four lobby verbs.
A stored `"  "` went out as a name the server refuses; `"banana"` as `Number("banana")` =
`NaN`, which `JSON.stringify` sends as `null`. `loadIdentity` is `loadChoice` with the bound
removed, not the menu growing an atlas dependency. The prompt is **one gate in `enterLobby`**
in front of all three verbs, and `nameOrNull` answers three questions that must not disagree.
Found on the way: `SkinsScene` interpolated the name into an HTML attribute unescaped.
EXIT=0, 43/43, 25/25, assets ok. Full entry in `tasks/HANDOFF-M20.md`.

## T20.04 — the id was known everywhere and drawn nowhere

Menu, storage, wire, seat and both re-broadcasts all worked; `GameScene` discarded `skin_id`
in three writers and built every body with `new PlayerView(this, 0)`. `skinId` is now
**required** on the `scores` value type so the compiler names the writer you forget, and the
id is read at the **construction site** because `PlayerView` has no setter. The check took
**four versions and three of them passed with the bug restored** — a patch above the head is
not the background behind the body, a remote is drawn from the interpolation buffer, a 16x16
stamp has a per-body sprite share, and a sprite is mirrored by its owner's aim. Final form:
**61.0 vs ground 26.9 with the fix, 0.6 with the bug.** EXIT=0, 44/44, 25/25, assets ok.

## T20.06 — the table was never the problem, and now an instrument says so

`item_population_report` (8 seeds x 3 scales) is the standing-population measurement T20.06
says does not exist, and it settles three of the four causes: a battery pack is **2nd of 19**
by time on the ground on Small; **`expired` is 0.0 everywhere**, so `WORLD_ITEM_TTL` removes
nothing; `live_peak` is 15/20/22 against a cap of 40. Item-seconds is the quantity the
complaint is about — a draw share is blind to everything after the draw. The atlas has **no**
`item_battery` frame, so the fix is pips rather than the icon; the pixel check took four
versions, three of them passing with every pip forced empty, and reads **201.3 lit vs 0.3**.
EXIT=0, 44/44, 25/25, assets ok — on the sixth gate; the reds are in `tasks/HANDOFF-M20.md`.

## T20.09 — five layers, and the gesture settled rather than discovered

`DropItem` follows `MoveItem` term for term through handler → sender → socket → command →
`World::drop_item` → `Inventory` + `ItemSpawn`. Tag **22 and no `REPLAY_VERSION` bump**: a v4
file simply has no tag-22 commands and replays byte for byte, while a bump would reject every
existing recording. Tiles were `pointer-events:auto` over a `none` root, so a drop on tiles
made the gesture mean two things four pixels apart — the root takes events **while open** now
and shares `toggleBackpack`. `DROP_PICKUP_LOCK` goes in `constants.rs`; the kit is refused
through `STARTING_KIT`, falsified red both ways. Out of scope: `night-combat` polls now.
EXIT=0, 44/44, 25/25, assets ok. Full entry in `tasks/HANDOFF-M20.md`.

## T20.13 — the server was never the subject; one throw kills Phaser's render loop

Phaser builds a `Scene` **once** and `create()`s it per `scene.start`, so ~30 `GameScene`
fields outlive a round — `update`'s three guards among them, so an exit drives a destroyed
camera and throws, and `RequestAnimationFrame.step` calls its callback *before* re-arming:
**one** throw ends rendering for the life of the page. `resetForNewRound()` is one list,
called before `create()`'s first await and from SHUTDOWN, guarded by a source-walking test.
`?game=1` had the sibling defect, fixed structurally (`SCENE_GRAPH` + `closeOverStarts`).
`rematch.mjs` asserts **pixels**: `debug().phase` read `playing` over a dead loop.
EXIT=0, 45/45, 840/840, 25/25, assets ok. `Room::restart`'s lag baseline: see HANDOFF.

## T20.15 — the grep found three more seams, and exporting the constant was the wrong fix

`lobby-start.mjs` read `constants().LOBBY_BOT_TIMEOUT`, which is not in `constants_json`:
`undefined`, then `NaN`, then a `waitForFunction` with **no deadline**. **The task's first
option does not survive contact** — the check spawns its server with `LOBBY_BOT_TIMEOUT=45`,
so the export would hand back the shipped 10.0 and set an 18 s deadline against an event 45 s
away. One name feeds both the env block and the wait. The grep also found three constants the
`Constants` interface never declared. Three guards, each falsified at its live site — but
**the timeout assertion is a substitution**, and `tasks/HANDOFF-M20.md` says what it does not
hold. EXIT=0 first run, 45/45, 853/853, 25/25, assets ok.

## T20.05 — one rain, and the number that joins them was measured

The ruling holds without a rule change: §C6 keeps its particle emitter, §C21's projectiles
decide how much of it is drawn. `setToxic` takes a **live drop count**, and whether it is
raining is derived from the same number, so the sheet stops when the last drop **lands**.
`TOXIC_DROPS_IN_FLIGHT = 7` is **measured**, not the task's suspected figure: three seeds x
three scales put a shower's peak at 6..=10, and the same test proves a shower never has an
empty frame. `density` is separate from `intensity` — one is how hard, the other is whether.
**The BLOCKER was real**: every weather assertion drives `?sandbox=1`, so `toxic-rain-game`
walks the six hops in a real round. EXIT=0 first run, 46/46, 859/859, 25/25, assets ok.

## T20.07 — six literals, four dead mechanisms, and a spec clause reversed

**`docs/72` §C13 is reversed and `docs/` is untouched**: the flashlight is passive, so
`FLASHLIGHT_AMBIENT_MULT` becomes `FLASHLIGHT_FOV_MULT` 1.5 gated on `night > 0`, and
`FLASHLIGHT_FOG_VEIL_MULT` 0.8 lightens §F9's veil — chosen over two alternatives, one of
them a rule nobody can measure. All **six** `flashlightOn: false` literals are gone, four in
`SandboxScene`, which is why the falsification is split across two named checks.
`Player::flashlight_on` is **deleted** and bit 4 derived at the encode site, so
**`REPLAY_VERSION` 4 → 5 and T20.08 must not bump again**. `DEV_FLASHLIGHT=1` is the switch.
EXIT=0 first run, 46/46, 859/859, 25/25, assets ok. The rest is in `tasks/HANDOFF-M20.md`.

## T20.08 — a pool, not a timer, and the bubble nobody could see on themselves

**`docs/21` §2/§4 reversed, `docs/` untouched**: `shield_until` is deleted, `shield_active`
is derived as "holds a generator and has charge", and `SHIELD_DURATION`/`SHIELD_DRAIN` are
gone rather than left as tunables nothing reads. **It rode T20.07's `REPLAY_VERSION` 5.** The
bit-3 problem is settled by **partial payment**. **A flat per-hit charge was wrong and
measured so**: poison is `DPS * dt` every tick, so 3 s of it billed 180 energy for 4.5 damage
stopped and left the reduction at 14 % against a promised 25 %. **Found on the way**:
`shield: false` for the *local* player in both scenes — the bubble never drew on your own
body. Pixels 9.9 vs 1.3. EXIT=0 first run, 46/46, 856/856, 25/25, assets ok.

## T20.12 — five hats, three glasses, and a second identity payload nobody had noticed

New fields following `tombstone_skin_id` term for term — **and not in the replay**, which is
what that precedent actually decided. One deviation: `Look { … }` groups the **argument list**
so `join` does not take six positionals, every id keeping its own name and JSON key. The
predicted trap was real and is closed with `Appearance` plus **one** `sameAppearance` call.
**Found on the way**: `Connection.connect` built its own join payload beside
`identityPayload` — accessories on the menu path, dropped on `?game=1`, silently. The art is
procedural. **The picture was wrong twice and the screenshot is what said so.** Pixels: head
+43.5 vs 0.0, hats 26.7 apart, face +102.2. EXIT=0, 46/46, 875/875, 25/25, assets ok.

## T20.10 — a third entity class, and the seam closed by deleting it

**No doc governs ground animals**; flagged for an amendment, `docs/` untouched. The warned
BLOCKER is not the enum: `hit_targets`/`targets` split players-then-birds at `players.len()`
with nothing enforcing it. Not split three ways — **collapsed**: to `targets` a bird and an
animal are both "a non-player whose velocity goes to a scratch", so one split remains and a
`debug_assert` at each end counts the scratches. Loot shares the **function**, keeping
`make_room()`-before-`spawn`. Own substream, hashed with velocity. **The gate caught folding
animals into `setBirdsVisible`** — 981x403 against a bird's 40x28. Pixels 34.9 vs 0.0.
EXIT=0, 47/47, 881/881, 25/25, assets ok. M20's twelve entries compressed to 8; see HANDOFF.

## M20 tidy-up — six review findings, and a control with one seed of margin left

**Two comments were false.** `world/mod.rs` cited a `battery` case in the hash-sensitivity
list that did not exist (added, falsified); `bots/mod.rs` said `threatened` was "still read by
the caller above" when nothing read it — a dead O(players) scan per bot tick, gone with
`SHIELD_WITHIN`. `accessoryTextures`' falsification tested `Set`; it mutates the real source
now. The parity scanner sees ~115 aliased reads, not 11, and `flashlight_pressed` is kept as
a documented reserved bit. **`balance.rs` settled by A/B at `9bcc655`**: shipping 7/8 both
sides, the Large-4 control 6/8 → 7/8 so its guard fires — 1/8 at T11.16, so nine ignored
milestones ate the margin, T20.10 spent the last seed. EXIT=0, 47/47, 882/882, 25/25, assets ok.

## T20.11 — the impact is destroyed inside `move_y`, and `docs/20` §9 still refuses it

**`docs/20` §9 still refuses fall damage** (`:235`); built on the 2026-09-04 ruling, no
override in `docs/70`–`75`, **`docs/` untouched and the amendment outstanding**. `integrate`
**returns** the impact, captured before `move_y` zeroes `vel.y`; the naive `grounded &&
vel.y > 0` is false on every landing and true on every downhill step, and both halves are
pinned. Exemption is `was_knocked` reused unchanged — 0.457 s arc < 0.6 s grace, a `const _`
assert; credit defers to a live claim. **The landing sound has been the 0.25 floor since
M6** — falsified live at 0.250 against 0.561/0.894, and the check reads that floor from the
page. Two `game-server` reds were D-58. EXIT=0, 47/47, 886/886, 25/25, assets ok.

## T20.19 — the mirror passed a literal `1.0` where the server passes `speed_multiplier()`

Both baseline rows **unmoved at HEAD** — read at the two symbols, never off `grep -c health`,
which is 2 in `core/index.ts` and 15 in `game-wasm` and misleads in opposite directions.
**Route 1**: health rides `snap.state` through `setPlayerState`, so `prediction.ts` is
untouched and the value arrives with the position it must agree with. `player_state` grew to
nine; the TS decode is centralised and names fields, so the sweep found one raw read and one
length check, both moved. Tests assert **reconciliation convergence**, not the multiplier:
`corrections == 0` over 40 frames, a presence control reaching exactly `WALK_SPEED`, and a
staged pre-fix control that must still be correcting in the second half. `roomFor(dir)` was
needed — RIGHT from seed 4242 walks 41 px into a wall — which is T20.20's defect, hit twice.
Health 0 is death, not slow: the first run measured a corpse at one tick of `WALK_ACCEL`.
Committed by the coordinator; the coder and reviewer died on the session limit mid-gate.
EXIT=0, 47/47, 873/878, 25/25, assets ok.

## T20.19 — review corrections (the gate line was wrong, and two desyncs survive)

**`53/53` was fabricated and the gate printed `47/47`.** I counted `===` headers in my own grep
output — `cargo fmt`, `clippy`, `typecheck`, `e2e summary`, `net smoke`, `assets` — instead of
browser checks. `e2e.mjs` holds 48 `CHECKS`, one `optIn`, so a green run cannot print anything
but 47. Lines containing a string counted as the things it names, in the entry claiming the gate
was re-verified. `873/873` also hid 5 ignored; it is `873/878`. Both corrected above.
**T20.21 booked** for what the review found in the code: health truncates to `u8` on the wire, so
the mirror sits up to 1.0 health low forever — 0.375 px/s, a correction every 5.33 s against
0.107 s before T20.19, a 50× win with a permanent floor — and the mirror has no `alive` while
`apply_inputs` gates on it, so a dead player is predicted walking. Neither is a regression; both
break the rule T20.19 set. No T20.19 test crosses the codec, which is why neither was caught.

## T20.20 — the flake was a fixture, and so were the other three

**Settling experiment first, and the budget coincidence is exonerated:** `rooms.rs::BUDGET_MS`
at `25_000` vs `10_000`, 7 runs against 6 — both arms' only failures were in `replay_run.rs`,
which does not read it, and `WAIT_MARGIN` over **277 waits** shows the worst using 17 % of
budget. `commands_sent_between_ticks` now probes both directions (`room_for`, ported from
`audio.mjs::roomFor`) on a **pinned seed**: the probe alone still failed 1 run in 16, one spawn
in sixteen having 5 px of room. `a_player_spawned_against_the_wall_is_still_walked` reproduces
*"from 2032 to 2032"* on demand. Three more D-58 entries had mechanisms too; table now empty.
Done-when 20/20. EXIT=0, 47/47, 1288/1301 rust, 890/890 client, 25/25, assets ok.

## T20.18 — one fixture, and a gate that could not outlive its own deliverable

`tests/common/mod.rs` holds `connect`, `test_config`, `emit_when_ready`. **The seven `connect`
copies had not drifted** — four inbox-shaped, three also feeding an mpsc channel, identical
otherwise — so nothing had to win, and `connect_logging_snapshots` extends
`builder`/`subscribe`/`open` rather than copying them. `emit_when_ready` retries **only**
`IllegalActionBeforeOpen`; budgets stay per file via `budget_past`. **Two findings:**
`lobby.rs::two_lobbies_..._get_different_maps` was living off the inherited `fixed_seed: None`;
and **Done-when (2) greps the source, so it reads 0 for all eight after the consolidation it
mandates** — replaced by `assert_seed_is_stated`: 8 red on one break in the fixture, 7 on one
in `connect`. EXIT=0, 47/47, 1296/1309 rust, 890/890 client, 25/25, assets ok.

## T20.17 — the thirteen unrun tests, run

`scripts/ignored.sh` runs all thirteen and **asserts a recorded verdict per test**;
`scripts/verify-repo.mjs` is in the gate's always-on half and fails if an `#[ignore]` is ever
added without being named there, or if a `TASKS.md` task link stops resolving (235, floor 50).
**All thirteen pass — including `the_shipping_configuration_produces_a_fight`, recorded as
knowingly red.** Control back to 6/8 against shipping 7/8, measured twice, no assertion
touched; margin is one seed, so T20.16 still owns it. Whole suite is **352 s**, not the
"minutes each" the ignore reasons claim. Ten of thirteen are guards; two the survey called
reports carry failable assertions. Planted `ITEM_SPAWN_INTERVAL` 14→42: **1296 gate tests pass**
and the ignored suite names it. EXIT=0, 47/47, 1296/1309 rust, 890/890 client, 25/25, assets ok.

## Fall damage halved, at the coordinator's instruction — and the replay version with it

`FALL_DAMAGE_PER_SPEED` 0.15 → **0.075**. The coefficient rather than `FALL_SAFE_SPEED`, so
the free drop height stays 82 px and short falls are unchanged; only the slope past the
threshold moved. A terminal-velocity landing costs **31.5** of `BASE_HEALTH` 100, not 63.
**`REPLAY_VERSION` 5 → 6**, which its own policy demands: no layout change and no new tag, but
a v5 recording containing any fall would load, run and disagree at the first state hash after
the landing. `HEAD` checked as that note requires — nothing else bumped since 5, one bump for
one break. No test hardcoded a fall value, so nothing needed re-pinning. **`docs/20:235` still
refuses fall damage outright** (*"deliberately absent in v1"*); that gap opened at T20.11 and
the amendment is still outstanding — this retune only changes a number inside it.
EXIT=0, 47/47, 1296 passed / 13 ignored rust, 890/890 client, 25/25, assets ok.

## Shovel: the dig left a lip you could not walk through, and a hole exactly your height

Reported from play. The melee carve was a circle dropped at the **tip**, so its near face sat
at `reach - blast_radius` while the body edge is at `PLAYER_W / 2` — a few px of untouched
ground between your feet and the opening you had just dug. Now a **capsule swept from the body
edge to the tip**, so there is no gap; starting at the edge rather than `origin` keeps the rule
the old comment protected — a swing opens the wall it is aimed at, it does not drop the swinger
through the floor. `SHOVEL_CARVE` is now `PLAYER_H * 0.5 + 2.0` (16, was 14): one click clears
`PLAYER_H + 4`, and being a capsule it holds that height along the whole length rather than at
one point. Falsified — restore the circle and both dig tests red, naming the lip; the knife
control stays green, which is right. `a_shovel_swing_digs_a_wall_...` caught the shape change
on its own and now derives a capsule's area. **`docs/75` still tables `carve` 14 and the melee
`SPEC` mirrors it; the amendment is outstanding.** Applies to axe and hammer too — one path, no
new flag. game-core 1002/1002, fmt and clippy clean; full gate deferred by instruction.

## T20.21 — the mirror's last two disagreements, and a red that is not mine

`speed_multiplier()` reads `health.floor()`: the wire sends `as u8`, a **truncation**, so the
mirror sat 0.375 px/s slow forever — a correction every 5.33 s. Flooring makes the two equal by
construction, not by precision. `apply_input` gates on `alive` and `set_player_state` carries
it, in the mirror's counterpart of `apply_inputs` rather than the shared leaf or `GameScene` —
share the guard. **`walk_both_sides` crosses the real codec now** (`game-server` dev-deps into
`game-wasm`), fractional health plus a control that the wire truncated; without the floor it
reads *"the client predicted 124.875 not 125"*. Floor pinned, `SHELF_RUN` computed. 18/18 wasm,
1002/1002 core, 891/891 client. **Not green:** `checksum.rs::two_clients_agree...` is red at
`f874cec` twice with my changes removed — not this task's, and it is the architecture's claim.

## The shovel capsule desynced every client, and `checksum.rs` could never have seen it

`f874cec` made `melee::swing` carve a **capsule** while `World::fire` still published
`Carve { x: tip, y: tip, r }` — a circle. The server dug one shape and every client applied
another; `two_clients_agree_on_the_mask_after_a_hundred_carves` caught it, which is the
assertion `checksum.rs` calls the architecture's foundation. Fixed at the seam: `MeleeResult`
returns `carve_shape`, the capsule it actually dug, and `fire` publishes `CarveCapsule` from
those numbers rather than deriving its own — *return what the caller needs*.
**The harness was the deeper find.** It subscribed to `"carve"` alone, so both clients missed
every capsule carve *equally*, which is exactly why they agreed with each other. **Lava has
been the game's only capsule carve for nine milestones and this test never covered it.**
`carves()` merges both names in `seq` order (one shared counter) and `replay` picks the shape
from the fields, not the name. Falsified: publish a circle for a capsule and it reds again.
checksum 6/6, game-server otherwise green, game-core 1002/1002, clippy clean.
**Open and not mine:** `replay_run::a_perturbed_command_is_localised_to_a_nearby_tick` — 0 of
20 perturbations diverge. Reproduced at `f03ab6f` with my files stashed; handed to T20.21.

## T20.14 — the whole thing at once: 48 clients, four scenarios, three planted controls

`examples/loadgen/` drives real sockets at one in-process server; an **example** target, so the
gate builds it and never runs it. **T19.21 reached at both observables, 3/3 runs**: 5 of 12
joiners fanned across `lobby_bot_timeout` got `welcome.phase=warmup`, and the catch-up disclosed
19–25 `item_spawn`s carrying `item_id` against a control of **0 over 7 lobby seats**. Booked, not
fixed: T20.22 (a room hop orphans the seat behind you — 1 client, no concurrency), T20.23 (a
refresh mid-join makes a room unreapable, **4/4 against a control of 0/4**), T20.24 (48 clients
sit at `MAX_ROOMS` 32/32 refusing 8367 joins while the worst room tick used half its budget).
**Two instrument bugs of my own, both caught by their own controls, both recorded at the code.**
Full gate deferred by instruction; `replay_run::a_perturbed_command…` red and already journalled.

## T20.21 follow-up — the perturbation fixture was measuring a corpse

`a_perturbed_command_is_localised_to_a_nearby_tick` read 0/20 because **every recorded input
belongs to player 0** (1400 commands, all hers; bots never emit `ReplayCommand::Input`) and she
is dead from tick 1348, while the window was ticks 1372–1391. `apply_inputs` skips a dead
player, so the flip was a no-op by construction — the coordinator's hypothesis, confirmed at the
code. `record_a_round` now **returns `last_alive`** and the window is anchored a `SIM_HZ` margin
before it instead of a hand-slid offset from the end of the file, which is what D-24 predicted
would keep breaking. Measured: margin 0 → 5/20 (on the floor), SIM_HZ/2 → 19/20, **SIM_HZ →
20/20**, 2·SIM_HZ → 19/20. Two stale comment measurements withdrawn. 279/279 game-server.
