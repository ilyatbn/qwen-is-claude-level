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
