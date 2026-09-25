//! `game-wasm` — the WebAssembly boundary.
//!
//! A thin `wasm-bindgen` shim over `game-core`. It holds **no game logic of its
//! own**; anything that looks like a rule belongs in `game-core` so the server runs
//! the identical code. See `docs/01-architecture.md`.
//!
//! # The mask is a pointer, never a copy
//!
//! [`GameCore::mask_ptr`] hands JS the address of the mask inside WASM linear
//! memory so the client can build one `Uint8Array` view and re-read it. Copying a
//! 1 MiB mask across the boundary on every chunk bake would dominate the frame
//! budget.
//!
//! **That view is invalidated whenever WASM memory grows.** Any allocation can
//! trigger a `memory.grow`, which swaps the underlying `ArrayBuffer` and detaches
//! every existing view — reads then throw or silently return zeros, and the map
//! renders blank. In practice `generate` and `load_mask` are the calls that
//! reallocate, but the safe rule is for the TS wrapper to re-acquire the view
//! whenever `view.buffer !== memory.buffer`. T3.02 does this inside its accessor so
//! no caller has to remember.

use game_core::constants::{GravityMode, MapScale, SIM_DT};
use game_core::effects::flare::SolarFlare;
use game_core::effects::fog::HeavyFog;
use game_core::effects::lava::LavaBurst;
use game_core::effects::meteor::MeteorShower;
use game_core::effects::toxic::ToxicRain;
use game_core::effects::{EffectKind, EffectPhase, EffectScheduler, WeatherTable};
use game_core::items::registry::{self, ItemId, ItemKind, WeaponId};
use game_core::map::{generate, rle, CoarseGrid, Map};
use game_core::math::Vec2;
use game_core::physics::body::Body;
use game_core::player::state::PlayerState;
use game_core::player::{apply_input, Input, JetpackState, JumpState, MoveStep};
use game_core::rng::{substream, ChaCha8Rng};
use game_core::weapons::defs;
use game_core::weapons::explode::{
    explode, fire_hitscan, BlastSource, DamageSource, HitId, HitTarget,
};
use game_core::weapons::projectile::{ProjectileOutcome, Projectiles};
use wasm_bindgen::prelude::*;

/// One locally-simulated player: the body plus the two bits of movement state
/// `apply_input` needs.
struct LocalPlayer {
    id: u8,
    body: Body,
    jump: JumpState,
    jet: JetpackState,
    prev_input: Input,
    /// T22.14C HIGH-1: the movement state **after** each applied seq, oldest first —
    /// what [`GameCore::correct_player_state`] restores at the ack before it installs
    /// the snapshot. At most `PREDICTION_HISTORY_TICKS`; a replay overwrites from its
    /// first seq on.
    history: std::collections::VecDeque<(u32, Moved)>,
    /// Health, inventory, cooldowns. The sandbox needs the whole record so firing
    /// goes through the same validation the server will use.
    stats: PlayerState,
}

/// Everything `apply_input` carries from one seq to the next that the snapshot does
/// not (T22.14C HIGH-1). The body whole — the wire's position, velocity and grounded
/// flag are overwritten after the restore; `airborne_ticks` (coyote time) is not on it.
#[derive(Clone, Copy)]
struct Moved {
    body: Body,
    jump: JumpState,
    jet: JetpackState,
    prev_input: Input,
}

impl LocalPlayer {
    /// Record the state after `seq` — a replay of `seq` replaces it and every later one.
    fn remember(&mut self, seq: u32) {
        while self.history.back().is_some_and(|(s, _)| *s >= seq) {
            self.history.pop_back();
        }
        if self.history.len() >= game_core::constants::PREDICTION_HISTORY_TICKS {
            self.history.pop_front();
        }
        self.history.push_back((
            seq,
            Moved {
                body: self.body,
                jump: self.jump,
                jet: self.jet,
                prev_input: self.prev_input,
            },
        ));
    }
}

#[wasm_bindgen]
pub struct GameCore {
    map: Map,
    players: Vec<LocalPlayer>,
    projectiles: Projectiles,
    rng: ChaCha8Rng,
    weather: Weather,
    /// The round phase the server last announced (T21.30). Read only through
    /// `RoundPhase::accepts_input` — the server's own rule — so the mirror
    /// stops walking the local body at the moment the server stops. `Playing`
    /// until told otherwise, which is what the sandbox, which is never told,
    /// always was.
    phase: game_core::world::RoundPhase,
    /// Which gravity the match is played under (T22.02).
    ///
    /// **`apply_input` reads it, so the mirror must be told it.** The rule
    /// `set_player_state`'s doc states — *"everything `apply_input` reads must
    /// be identical on both sides"* — is what makes this a field rather than
    /// something the client could leave at the default: a low-gravity match
    /// predicted at standard gravity rubber-bands on the first jump.
    ///
    /// **It cannot ride `move_mods`.** That byte is derived from the
    /// *inventory* — boots, wings, a mount — and is per-player; gravity is a
    /// property of the match. `set_phase` is the precedent and this is its
    /// shape: a per-match constant, announced once, stored once.
    ///
    /// `Standard` until told otherwise, which is what the sandbox — never told
    /// — always was.
    gravity: GravityMode,
    /// T22.10: the live breach vortices' centres, in the server's opening order —
    /// the list `env_at` chains after the asteroids. Filled by [`GameCore::set_vortices`]
    /// from `vortex_open` / `vortex_close`; empty on a client told nothing, which
    /// predicts no pull while the server pulls — the rubber-band `set_asteroids`'s
    /// doc describes, for this list.
    vortices: Vec<Vec2>,
    /// T22.12: the black hole, once `black_hole` announced it — chained after the
    /// vortices by `env_at`, gated on `phase` by `black_hole::pulls` exactly as
    /// the server gates it. `None` on a client told nothing, which predicts no pull
    /// while the server pulls: the rubber-band this field exists to prevent.
    black_hole: Option<Vec2>,
    /// T22.12C F5: the first input seq the server steps after the bell
    /// (`black_hole::bell_seq`, set by [`GameCore::set_bell`] each snapshot from the
    /// round clock). From it on, the prediction does not pull toward the hole —
    /// the server stopped on its `Ended` tick, and `ended` arrives a trip later.
    /// `None` before a `Playing` round clock is known.
    bell_seq: Option<u32>,
}

/// The sandbox's weather, driven by `weather_step`.
///
/// M6 moves this into `World` on the server; the shape is deliberately the same
/// so the move is a relocation rather than a rewrite. Hazard positions are
/// already produced here and handed out as data, which is what the server will
/// broadcast — clients never roll their own (`docs/13-weather-effects.md` §7).
#[derive(Default)]
struct Weather {
    scheduler: Option<EffectScheduler>,
    toxic: Option<ToxicRain>,
    meteor: Option<MeteorShower>,
    lava: Option<LavaBurst>,
    /// Which seed `lava` was built from, so `lava_vents` rebuilds only when the
    /// server announces a different burst (T19.24).
    lava_seed: Option<u64>,
    fog: Option<HeavyFog>,
    /// T22.08A: the sandbox's flare and the clock it started at.
    flare: Option<(f32, SolarFlare)>,
    /// Which seed `flare_cache` was built from, and the flare — `flare_points`
    /// is called every frame and the seed alone decides the shape.
    flare_cache: Option<(u64, SolarFlare)>,
    forced: Option<(EffectKind, f32)>,
}

impl Default for GameCore {
    fn default() -> Self {
        Self::new()
    }
}

#[wasm_bindgen]
impl GameCore {
    #[wasm_bindgen(constructor)]
    pub fn new() -> GameCore {
        // Without this a Rust panic surfaces as bare `unreachable executed`, with
        // no file, line or message.
        console_error_panic_hook::set_once();
        GameCore {
            map: generate(1, MapScale::Small),
            players: Vec::new(),
            projectiles: Projectiles::new(),
            rng: substream(1, "wasm"),
            weather: Weather::default(),
            phase: game_core::world::RoundPhase::Playing,
            gravity: GravityMode::Standard,
            vortices: Vec::new(),
            black_hole: None,
            bell_seq: None,
        }
    }

    /// The phase string off `round_state`/`welcome` (T21.30). Returns whether it
    /// was a phase this build knows; an unknown one leaves the old phase in place.
    pub fn set_phase(&mut self, phase: &str) -> bool {
        match game_core::world::RoundPhase::parse(phase) {
            Some(p) => {
                self.phase = p;
                true
            }
            None => false,
        }
    }

    /// Does the phase the server last announced take input? (T22.10E F-3)
    ///
    /// **`RoundPhase::accepts_input`, the server's own rule**, read by the
    /// client's `Predictor`: while it is false the server drops every input and
    /// steps each body a neutral tick, so the predictor stops keeping inputs for
    /// replay and keys its reconciliation on the server tick instead. A second
    /// spelling of the rule in TypeScript would be a second answer.
    pub fn accepts_input(&self) -> bool {
        self.phase.accepts_input()
    }

    /// The gravity spelling off `lobby_state` (T22.02). Returns whether it was
    /// a mode this build knows; an unknown one leaves the old mode in place.
    ///
    /// **Refuse rather than clamp**, which is `GravityMode::parse`'s own rule
    /// (§E6): a client silently falling back to `Standard` on a spelling it did
    /// not recognise would predict a low-gravity match at full gravity and look
    /// exactly like a netcode bug.
    ///
    /// **It does not re-generate the map**, and for a locally generated one
    /// that is the remaining order trap: set the mode *before* you generate, or
    /// use [`GameCore::generate_for_gravity`], which is the two in one call. A
    /// networked client is not exposed to it — it is handed the server's mask
    /// by `load_mask` after this — and regenerating here would throw that mask
    /// away on the lobby's own message.
    pub fn set_gravity(&mut self, gravity: &str) -> bool {
        match GravityMode::parse(gravity) {
            Some(g) => {
                self.gravity = g;
                true
            }
            None => false,
        }
    }

    /// The seed arrives as two `u32`s: a `u64` across the wasm-bindgen boundary
    /// pulls in BigInt handling that is more trouble than it is worth.
    pub fn generate(&mut self, seed_lo: u32, seed_hi: u32, scale: u8) {
        self.generate_with(
            seed_lo,
            seed_hi,
            scale,
            game_core::constants::DEFAULT_MAP_GENERATOR.to_u8(),
        );
    }

    /// `generate` against a named terrain generator (0 = v1, 1 = v2, 2 = space)
    /// — **the byte is a request, and the gravity decides** (`M22-RULINGS` R15).
    ///
    /// Local only: a networked round is sent the finished mask in `map_init` and
    /// never rebuilds it from the seed. This exists so the sandbox and preview
    /// scenes — and the renderer's terrain tests — can put either generator's
    /// maps on screen, since v1 still ships behind `MAP_GENERATOR=v1` and a test
    /// that only ever sees the default stops guarding the other one.
    ///
    /// **Byte 2 is not a third thing you may ask for.** It used to be: this
    /// method called `from_u8` and handed the result straight to
    /// `map::generate_with`, so `generate_with(.., 2)` built a space map under
    /// standard gravity and `generate_with(.., 1)` built a landscape under
    /// space gravity — both of them the state R15 forbids, reachable in one
    /// public call each while the TypeScript doc said passing `Space` here
    /// *"gets you the default generator back, deliberately"*. It does now:
    /// every generator this core produces goes through
    /// `MapGenerator::for_gravity` against the mode this core is set to, which
    /// is the one derivation, and [`GameCore::generate_for_gravity`] is that
    /// same call with the mode set first so the two cannot be ordered wrongly.
    pub fn generate_with(&mut self, seed_lo: u32, seed_hi: u32, scale: u8, generator: u8) {
        let seed = ((seed_hi as u64) << 32) | seed_lo as u64;
        let scale = MapScale::from_u8(scale).unwrap_or(MapScale::Medium);
        let chosen = game_core::constants::MapGenerator::from_u8(generator)
            .unwrap_or(game_core::constants::DEFAULT_MAP_GENERATOR);
        let generator = game_core::constants::MapGenerator::for_gravity(self.gravity, chosen);
        self.map = game_core::map::generate_with(seed, scale, generator);
    }

    /// `generate_with` under a named gravity, **deriving the generator from it**
    /// (`T22.05A`, `M22-RULINGS` R15). Returns whether the spelling was one this
    /// build knows.
    ///
    /// One call rather than `set_gravity` then `generate`, and that is the
    /// point: the two-call form has an order, and calling it the wrong way
    /// round leaves a normal map under space gravity — players falling off
    /// rocks that are not there. Make the correct use the only use (§A24).
    ///
    /// **`PreviewScene` needs this or the lobby lies.** A networked round is
    /// sent the finished mask in `map_init`, but the preview a host looks at
    /// *while choosing the mode* runs the generator locally; without the mode it
    /// shows a landscape to someone who has just picked space. That is the same
    /// shape as the T19.24 client-side-vents bug.
    ///
    /// Refuse rather than clamp, which is `GravityMode::parse`'s own rule (§E6):
    /// generating nothing is recoverable, and quietly generating the wrong map
    /// is the bug this method exists to prevent.
    pub fn generate_for_gravity(
        &mut self,
        seed_lo: u32,
        seed_hi: u32,
        scale: u8,
        generator: u8,
        gravity: &str,
    ) -> bool {
        let Some(g) = GravityMode::parse(gravity) else {
            return false;
        };
        self.gravity = g;
        // The mode first, then the ordinary call: `generate_with` applies
        // `for_gravity` itself, so deriving here too would be the second copy
        // of the one derivation R15 exists to prevent.
        self.generate_with(seed_lo, seed_hi, scale, generator);
        true
    }

    /// Rebuild the map from a `map_init` RLE payload. Returns false on malformed
    /// input rather than panicking — this decodes untrusted network data.
    pub fn load_mask(&mut self, w: u32, h: u32, rle_bytes: &[u8]) -> bool {
        let Ok(mask) = rle::decode(w, h, rle_bytes) else {
            return false;
        };
        let coarse = CoarseGrid::build(&mask);
        let mut meta = self.map.meta.clone();
        // **Re-extracted, not cleared** (T19.24). This was `.clear()`, and
        // `LavaBurst::new` reads `map.meta.surface_points` and *nothing else* to
        // choose where the ground opens — so a networked client derived **zero
        // vents from any seed**, which is why handing it the server's seed alone
        // would have fixed nothing. Proved rather than argued:
        // `effects/lava.rs::t19_24_client_side_vents`.
        //
        // Here rather than lazily when a lava effect starts, and that timing is
        // load-bearing: the server picks its vents from the surface as it was at
        // *generation*, and this mask is the one that arrived. The two agree only
        // while nothing has been carved, which is true at `map_init` and false a
        // minute later — the third test in that module pins exactly that.
        //
        // **It costs, and the number is measured rather than waved at**:
        // `--release`, this box, `load_mask` end to end against the extraction
        // alone — Small 7.7 ms / 6.8, Medium 20.3 / 15.8, Large 34.7 / 29.8. So
        // the scan is ~90 % of the call and makes `map_init` roughly ten times
        // dearer than the decode it used to be. Paid once per match, inside the
        // beat where the map is being installed anyway, which is why it is here
        // and not on a lava burst mid-fight.
        //
        // **Through `gen::surface_for`, not `extract_surface`** (`T22.05B`).
        // The two differ on exactly one generator: a space map's surface is the
        // arena's, and `extract_surface` also returns the full-width floor
        // crust, which on that map lies *outside* the rim in the band R16 makes
        // lethal. The server filters it out at generation; a client that
        // re-admitted it here would put lava vents and every debug readout on
        // the void crust, and the two copies of `surface_points` would be
        // different sets — which is the failure T19.24 was, in the other
        // direction.
        //
        // The generator is **the map's own** (T22.14A B3): `map_init` carries it and
        // `set_map_generator` installs it before this call (`worldMirror.applyMapInit`).
        // It was derived here from the gravity this core was set to (R15's
        // derivation, the server's too), which held only while `lobby_state` came
        // first; the map now says what it is whichever order they arrive in.
        meta.surface_points = game_core::map::gen::surface_for(meta.generator, &mask);
        self.map = Map::from_parts(mask, coarse, meta);
        true
    }

    /// Install the round's teleport pads, from `map_init`.
    ///
    /// **Not cosmetic, and not optional.** §C5 makes pads indestructible, which
    /// means `carve_circle` refuses pixels inside them — and the client runs the
    /// *same* `carve_circle` on its own copy of the mask. A client that does not
    /// know where the pads are digs holes the server refused, and the two masks
    /// diverge by a pad-shaped patch per carve.
    ///
    /// That is not a hypothetical: `two_clients_agree_on_the_mask_after_a_hundred_
    /// carves` failed with "clients agreed with each other but not with the
    /// server" the moment pads landed, which is precisely the failure it exists
    /// to produce.
    ///
    /// `xs`/`ys` are parallel arrays because wasm-bindgen has no cheap way to
    /// pass a slice of structs; the id is the index, as on the wire.
    pub fn set_teleport_pads(&mut self, xs: &[i32], ys: &[i32]) {
        let n = xs.len().min(ys.len());
        self.map.meta.teleport_pads = (0..n)
            .map(|i| game_core::map::meta::TeleportPad {
                id: i as u8,
                pos: game_core::math::Point::new(xs[i], ys[i]),
            })
            .collect();
    }

    /// Where this core thinks the pads are, as `[x0, y0, x1, y1, …]`.
    ///
    /// For the mask-agreement checks: a client that silently kept an empty list
    /// would carve differently from the server and every count on both sides
    /// would still match.
    pub fn teleport_pads(&self) -> Vec<i32> {
        self.map
            .meta
            .teleport_pads
            .iter()
            .flat_map(|p| [p.pos.x, p.pos.y])
            .collect()
    }

    /// Mount or unmount a player, **through the wire's own decode path**
    /// (T21.11B).
    ///
    /// Sandbox and mirror only. It builds the `move_mod_bits` byte the server
    /// would have sent and hands it to `set_move_mod_bits`, so this control
    /// exercises exactly the code a real snapshot exercises rather than opening
    /// a second route into the same field — the `giveBoots` precedent, which
    /// grants an item rather than setting a flag.
    ///
    /// Returns the effect read back through the shared rule, not an
    /// acknowledgement that the ask happened.
    pub fn set_mounted(&mut self, id: u8, on: bool) -> bool {
        let Some(p) = self.players.iter_mut().find(|p| p.id == id) else {
            return false;
        };
        let bits = p.stats.move_mod_bits();
        let want = if on {
            bits | game_core::player::state::MOVE_MOD_MOUNTED
        } else {
            bits & !game_core::player::state::MOVE_MOD_MOUNTED
        };
        p.stats.set_move_mod_bits(want);
        p.stats.move_mods().mounted
    }

    /// T21.11's emplacements, the pads' twin and for the identical reason.
    ///
    /// `carve_circle` refuses to clear a platform's rect, so a client that never
    /// learned where the platforms are digs holes the server does not and the two
    /// masks drift by a platform-shaped patch per carve. That is not a
    /// hypothetical for pads — it is the failure `two_clients_agree_on_the_mask_
    /// after_a_hundred_carves` actually produced the moment pads landed — and
    /// nothing about platforms makes them immune to it.
    pub fn set_gun_platforms(&mut self, xs: &[i32], ys: &[i32]) {
        let n = xs.len().min(ys.len());
        self.map.meta.gun_platforms = (0..n)
            .map(|i| game_core::map::meta::GunPlatform {
                id: i as u8,
                pos: game_core::math::Point::new(xs[i], ys[i]),
            })
            .collect();
    }

    /// Where this core thinks the platforms are, as `[x0, y0, x1, y1, …]`.
    pub fn gun_platforms(&self) -> Vec<i32> {
        self.map
            .meta
            .gun_platforms
            .iter()
            .flat_map(|g| [g.pos.x, g.pos.y])
            .collect()
    }

    /// Install the round's asteroids, from `map_init` (`T22.11C`, `M22-RULINGS`
    /// R49 and R11).
    ///
    /// **The pads' and platforms' third sibling, and the one that decides where
    /// the player ends up rather than what the mask looks like.** Since
    /// `T22.11B` a space player's acceleration is
    /// `world::attractors::env_at(map, gravity, pos)`, which reads
    /// `map.meta.asteroids` and nothing else. `GameCore::new()` generates on the
    /// **standard** generator, so until this is called a networked client's table
    /// is *empty* — not stale, empty — and it predicts against a field of exactly
    /// zero everywhere while the server pulls the body toward a rock. That is a
    /// rubber-band on every frame a player spends inside a well.
    ///
    /// **Nothing here sorts, and that is the contract.** `field_at` sums in
    /// iteration order and float addition is not associative, so the two sides
    /// must sum the *same list in the same order*. The order is
    /// `map::gen::space::place_asteroids`' — `MapMeta.asteroids` is a `Vec`,
    /// `codec.rs::encode_map_init` writes it as a sequence, `decode_map_init_parts`
    /// pushes in read order, `client/src/net/codec.ts` does the same, and the
    /// index loop below preserves it. A sort anywhere on that path is a
    /// divergence, which is why there is none.
    ///
    /// **Order against `set_gravity` does not matter, unlike `load_mask`'s.**
    /// `load_mask` derives its surface re-extraction from the mode this core is
    /// already set to, so a `map_init` that arrived before `lobby_state` gets the
    /// standard generator's surface. This setter reads no mode at all: it installs
    /// the table, and `env_at` consults `self.gravity` at the tick, so a later
    /// `set_gravity("space")` brings the field live with the rocks already in
    /// place. `map_init_before_lobby_state_still_predicts_the_field` asserts both
    /// halves — identical prediction either way round, and the surface that does
    /// differ.
    ///
    /// Parallel arrays for the reason `set_teleport_pads` gives: wasm-bindgen has
    /// no cheap way to pass a slice of structs. There is no `asteroids()` twin of
    /// [`GameCore::teleport_pads`] because `meta_json` already serialises the whole
    /// `MapMeta` — `Core.meta.asteroids` in `client/src/core/index.ts` is the
    /// readback, and the browser check reads it there.
    /// T22.14A B3: which generator made the map `map_init` carries (`MapGenerator`'s
    /// byte) — the one answer to *"is this a space map?"* (`Map::space_geometry`),
    /// which was the asteroid list being non-empty until the black hole could eat
    /// rocks. **Before `load_mask`**, which derives the surface from it.
    /// `WorldMirror.applyMapInit` is the one production caller. `false` for a byte
    /// that names no generator (nothing changes).
    pub fn set_map_generator(&mut self, generator: u8) -> bool {
        match game_core::constants::MapGenerator::from_u8(generator) {
            Some(g) => {
                self.map.meta.generator = g;
                true
            }
            None => false,
        }
    }

    pub fn set_asteroids(&mut self, xs: &[i32], ys: &[i32], rs: &[i32], levels: &[u8]) {
        let n = xs.len().min(ys.len()).min(rs.len()).min(levels.len());
        self.map.meta.asteroids = (0..n)
            .map(|i| game_core::map::meta::Asteroid {
                x: xs[i],
                y: ys[i],
                r: rs[i],
                level: levels[i],
            })
            .collect();
    }

    /// T22.10: the live vortices, as the server holds them — centres in **opening
    /// order**, which is the order `env_at` sums them in on the server. Parallel
    /// arrays for `set_asteroids`' reason. The client keeps the list in the order
    /// `vortex_open` arrived and drops on `vortex_close`; it never sorts.
    pub fn set_vortices(&mut self, xs: &[f32], ys: &[f32]) {
        let n = xs.len().min(ys.len());
        self.vortices = (0..n).map(|i| Vec2::new(xs[i], ys[i])).collect();
    }

    /// T22.12: the black hole the server announced (`black_hole`), or none — a new
    /// match's mirror clears it. `WorldMirror` is the one production caller.
    pub fn set_black_hole(&mut self, present: bool, x: f32, y: f32) {
        self.black_hole = present.then(|| Vec2::new(x, y));
    }

    /// T22.12C F5: where the bell falls in **input seqs** — from a `Playing`
    /// `round_state`'s integer `ends_tick` (T22.12D, R94) and a snapshot (`ack` ran
    /// on `snap_tick`), through `black_hole::bell_seq`, the one derivation. Called
    /// by `GameScene` on every snapshot before the reconcile replays, so a replayed
    /// input past the bell is stepped as the server stepped it: without the pull.
    pub fn set_bell(&mut self, ends_tick: u32, ack: u32, snap_tick: u32) {
        self.bell_seq = Some(game_core::world::black_hole::bell_seq(
            ends_tick, ack, snap_tick,
        ));
    }

    /// No bell known (a new round, the lobby, warmup).
    pub fn clear_bell(&mut self) {
        self.bell_seq = None;
    }

    /// The summed gravity field at a world point, px/s², as `[ax, ay]`.
    ///
    /// **A readback, in the sense [`GameCore::teleport_pads`] is one**: nothing
    /// in the game reads it, and `scripts/checks/asteroid-gravity.mjs` does. That
    /// check has to know which way a body will be pulled *before* it has moved,
    /// so it can photograph the patch of frame the body is about to enter and
    /// the patch on the opposite side as its control. Deriving that in JavaScript
    /// would be a second spelling of `field_at`'s summation — the one thing R11
    /// exists to prevent — so it is asked of the core instead.
    ///
    /// **Through `env_at`, not `field_at`.** That is the composition both sides
    /// already call, so the answer includes the gravity mode: on a standard or
    /// low-gravity map it is `[0, 0]` however many rocks the meta holds, which is
    /// what makes the check's control frame (`set_asteroids` with an empty list)
    /// assert the *effect* rather than the ask.
    pub fn field_accel_at(&self, x: f32, y: f32) -> Box<[f32]> {
        let env = game_core::world::attractors::env_at(
            &self.map,
            self.gravity,
            &self.vortices,
            self.black_hole,
            game_core::world::black_hole::pulls(self.phase),
            Vec2::new(x, y),
        );
        Box::new([env.accel.x, env.accel.y])
    }

    // ---- terrain access -------------------------------------------------

    /// Address of the mask words in WASM memory. See the module docs: the view JS
    /// builds over this is detached by any heap growth.
    pub fn mask_ptr(&self) -> *const u8 {
        self.map.mask.words().as_ptr() as *const u8
    }

    pub fn mask_byte_len(&self) -> usize {
        self.map.mask.words().len() * 8
    }

    pub fn width(&self) -> u32 {
        self.map.mask.w
    }

    pub fn height(&self) -> u32 {
        self.map.mask.h
    }

    pub fn chunks_x(&self) -> u32 {
        self.map.chunks_x()
    }

    pub fn chunks_y(&self) -> u32 {
        self.map.chunks_y()
    }

    pub fn solid_at(&self, x: i32, y: i32) -> bool {
        self.map.mask.get(x, y)
    }

    pub fn carve(&mut self, cx: i32, cy: i32, r: i32) {
        self.map.carve_circle(cx, cy, r);
    }

    /// A swept-circle carve, for lava channels.
    ///
    /// Exposed separately from `carve` because replaying a capsule as a circle
    /// produces a *different mask*, and the whole reason carves cross the wire
    /// instead of the mask is that they reproduce bit-for-bit
    /// (`docs/11-map-destruction.md` §6).
    pub fn carve_capsule(&mut self, x0: i32, y0: i32, x1: i32, y1: i32, r: i32) {
        self.map.carve_capsule(x0, y0, x1, y1, r);
    }

    /// Chunk indices (`cy * chunks_x + cx`), clearing the set.
    pub fn take_dirty_chunks(&mut self) -> Vec<u32> {
        self.map.drain_dirty()
    }

    // ---- local player prediction ----------------------------------------

    /// Seat a player — **in space, in a full suit** (T22.09B, review of
    /// T22.09A F11). The server issues the suit at join and respawn
    /// (`World::issue_suit`); without it here a sandbox player in space started
    /// flat and irradiated while a real one starts sealed, so the sandbox showed
    /// the radiation feedback a real player never sees at spawn. Keyed off this
    /// core's mode at the moment of joining, as the server's is — set it first
    /// (`generate_for_gravity` does); `set_gravity` later does not re-issue one,
    /// exactly as changing the lobby setting does not refill a seated player.
    pub fn add_player(&mut self, id: u8, x: f32, y: f32) {
        if self.players.iter().any(|p| p.id == id) {
            return;
        }
        let mut stats = PlayerState::new(id, Vec2::new(x, y), 0);
        game_core::world::World::issue_suit(self.gravity, &mut stats);
        self.players.push(LocalPlayer {
            id,
            body: Body::new(Vec2::new(x, y)),
            jump: JumpState::default(),
            jet: JetpackState::default(),
            stats,
            prev_input: Input::default(),
            history: std::collections::VecDeque::new(),
        });
    }

    pub fn remove_player(&mut self, id: u8) {
        self.players.retain(|p| p.id != id);
    }

    /// One predicted tick, running **the server's own `apply_input`** — including
    /// the server's own speed multiplier (T20.19).
    ///
    /// **This argument was the literal `1.0` for fifteen milestones, and the
    /// server's is `PlayerState::speed_multiplier()`** (`world/mod.rs::apply_inputs`).
    /// That lerps `HEALTH_SPEED_MIN` → 1.0 by `health / BASE_HEALTH`, so a player
    /// on low health was *predicted* at full walking speed and *simulated* up to
    /// 25 % slower. `RECONCILE_EPSILON_PX` is 2 px, which a 25 % speed error
    /// crosses in a couple of frames — so a hurt player rubber-banded on every
    /// frame they moved, for as long as they stayed hurt, and it could not
    /// self-correct because `set_player_state` never carried health either.
    ///
    /// The rule is not *"the client must know everything"* — darkness is exempt
    /// because nothing predicts darkness. It is: **everything `apply_input` reads
    /// must be identical on both sides.** Health became non-exempt the moment it
    /// fed `speed_multiplier()` inside `apply_input`.
    pub fn apply_input(&mut self, id: u8, seq: u32, buttons: u8, aim: u16, dt: f32) {
        let map = &self.map;
        // Copied out before the `&mut` borrow of the player, for the reason
        // `World::apply_inputs` copies it: it is the world's setting, not the
        // player's.
        let gravity = self.gravity;
        let vortices = &self.vortices;
        // T22.12: the server's gate, the server's function (R8.4 — frozen at `Ended`),
        // and T22.12C F5: frozen from the bell's seq on, which the server stepped in
        // `Ended` before this client heard so.
        let hole = self.black_hole;
        let hole_pulls = game_core::world::black_hole::pulls(self.phase)
            && self.bell_seq.is_none_or(|b| seq < b);
        let Some(p) = self.players.iter_mut().find(|p| p.id == id) else {
            return;
        };
        // **T21.30, the server's rule and not a copy of it.** Once the round is
        // over `World::apply_inputs` integrates a neutral input instead of what
        // was held, so the mirror does the same — gravity still runs, nothing
        // the player presses does.
        let buttons = if self.phase.accepts_input() {
            buttons
        } else {
            0
        };
        let input = Input::new(seq, buttons, aim);
        // **The gate the server has and this did not** (T20.21).
        // `world/mod.rs::apply_inputs` runs `if !self.players[idx].alive
        // { continue; }` *before* it computes `speed`, so a dead player on the
        // server does not move. Nothing here did, `set_player_state` never set
        // `alive`, and `GameScene` pushes input every frame — so a dead local
        // player holding a direction was predicted walking at **full** magnitude
        // while the server held them still. The same rubber-band T20.19 fixed,
        // without the 25 % discount.
        //
        // **Here rather than in `physics::apply_input`, and rather than in
        // `GameScene`.** This function is the mirror's counterpart of
        // `apply_inputs`: the layer that owns the player list and decides whose
        // input is worth a tick. `physics::apply_input` is the shared leaf and
        // neither side gates there, so putting it in the leaf would change the
        // server too. Putting it in `GameScene` would leave the guard one caller
        // away from the state it protects, where the next caller of
        // `Predictor::pushInput` drops it — share the guard, or share the
        // function.
        //
        // T22.14C HIGH-1: **dead, the tick still happens to the input stream** — the
        // server's words (`World::apply_inputs`): `prev_input` advances and the body
        // does not move. This returned before it, so a JUMP pressed while dead and
        // held through the respawn read as a fresh press against the last input
        // before death: a phantom jump the server never made.
        // (Only while the phase takes input: in `Ended` the server steps the living
        // alone, so a dead player's stream stands still there.)
        if !p.stats.alive {
            if self.phase.accepts_input() {
                p.prev_input = input;
                p.remember(seq);
            }
            return;
        }
        let dt = if dt > 0.0 { dt } else { SIM_DT };
        // **`PlayerState::move_mods`, the same function the server calls**
        // (T21.02). Not a struct the mirror assembles itself: the whole reason
        // this argument stopped being an `f32` is that a bare number is
        // something a caller can invent, and both of the last two rubber-band
        // bugs were the mirror inventing one.
        let mods = p.stats.move_mods();
        // **The mirror calls the function the server calls** (T22.11A, filled at
        // T22.11B, `M22-RULINGS` R10 and R11). Same rule as `move_mods` above: a
        // value the mirror can invent is a value the mirror will invent
        // differently, which is what both of the last two rubber-band bugs were.
        // `attractors::env_at` is the one composition, so there is no second
        // spelling for the two to disagree about.
        //
        // **And what it reads is now filled, which was R49's gap** (`T22.11C`).
        // `GameCore::new()` generates on the *standard* generator, so until that
        // task a networked client's `map.meta.asteroids` was empty — not stale,
        // empty — and this line predicted against no field at all. The table
        // arrives in `map_init` and is installed by
        // `worldMirror.ts::applyMapInit` through [`GameCore::set_asteroids`],
        // beside `setTeleportPads`; wiring this call at T22.11B is what made that
        // a one-line change rather than a second design.
        let env = game_core::world::attractors::env_at(
            map, gravity, vortices, hole, hole_pulls, p.body.pos,
        );
        apply_input(
            map,
            &mut p.body,
            &mut p.jump,
            &mut p.jet,
            &input,
            &p.prev_input,
            MoveStep { mods, env },
            dt,
        );
        p.prev_input = input;
        p.remember(seq);
    }

    /// Overwrite a mirrored body from an authoritative snapshot.
    ///
    /// **`health` is here because `apply_input` reads it** (T20.19). It is not a
    /// display value — `GameScene` already had `mine.health` off the wire for the
    /// HUD — it is the input to `speed_multiplier()`, so without it the mirror
    /// predicts at a speed the server is not running and the reconciler corrects
    /// every frame.
    #[allow(clippy::too_many_arguments)]
    pub fn set_player_state(
        &mut self,
        id: u8,
        x: f32,
        y: f32,
        vx: f32,
        vy: f32,
        grounded: bool,
        fuel: f32,
        health: f32,
        alive: bool,
        move_mods: u8,
    ) {
        let Some(p) = self.players.iter_mut().find(|p| p.id == id) else {
            return;
        };
        // T22.14C HIGH-1: **a respawn is `PlayerState::respawn`'s reset**, which the
        // mirror never ran — a fresh body (airborne ticks 0), the jump buffer and the
        // jetpack cleared (the tank is the wire's, below). A jetpack lit at death stayed
        // lit into the next life: a phantom thrust. `prev_input` is not reset, as the
        // server does not: its dead ticks carried the stream (`apply_input`).
        if !p.stats.alive && alive {
            p.body = Body::new(Vec2::new(x, y));
            p.jump = JumpState::default();
            p.jet = JetpackState::default();
        }
        p.body.pos = Vec2::new(x, y);
        p.body.vel = Vec2::new(vx, vy);
        p.body.grounded = grounded;
        p.jet.fuel = fuel;
        p.stats.health = health;
        // **`alive` is here for the same reason `health` is** (T20.21): not a
        // display value — `GameScene` reads the flag off the wire for the death
        // overlay already — but an input to `apply_input`, which now refuses to
        // move a dead body exactly as `apply_inputs` does. It is bit 0 of the
        // snapshot's flags and has been on the wire since M6; nothing carried it
        // across this boundary.
        p.stats.alive = alive;
        // **T21.02, and it is here for the same reason `health` and `alive`
        // are** — `apply_input` reads it. `move_mods` feeds
        // `PlayerState::move_mods()`, which scales the walk target and the jump
        // launch, so a mirror that does not know a player is wearing boots
        // predicts them at half speed and a third of the height.
        //
        // **It is written into the inventory, not into a field beside it.**
        // `move_mods()` derives from the inventory on both sides, so this makes
        // the mirror answer the *same* question the server answered rather than
        // storing a second answer that could disagree — the third flag that
        // `shield_until` and `flashlight_on` were both deleted for.
        p.stats.set_move_mod_bits(move_mods);
    }

    /// **A reconcile's correction** (T22.14C HIGH-1): the movement state this mirror
    /// had after seq `ack` — previous input, jump buffer, jetpack, airborne ticks —
    /// restored, then the snapshot installed over it ([`GameCore::set_player_state`]).
    ///
    /// `set_player_state` alone left all of those at the **newest** applied seq, so
    /// the replay's first input compared its edges against the last one pushed: a
    /// jump pressed inside the pending window, still held at the newest input, lost
    /// its edge on every correction (43 px in the vitest that found it). The server
    /// stepped that seq from its own state at the ack, which is this copy.
    ///
    /// Copies before `ack` are dropped; with no copy of `ack` (older than
    /// `PREDICTION_HISTORY_TICKS`, or never applied here) the current state stands,
    /// as before. `Predictor.reconcile` is the one production caller; the results
    /// screen's re-anchor and `relocate` are not corrections at an ack and call
    /// `set_player_state`.
    #[allow(clippy::too_many_arguments)]
    pub fn correct_player_state(
        &mut self,
        id: u8,
        ack: u32,
        x: f32,
        y: f32,
        vx: f32,
        vy: f32,
        grounded: bool,
        fuel: f32,
        health: f32,
        alive: bool,
        move_mods: u8,
    ) {
        if let Some(p) = self.players.iter_mut().find(|p| p.id == id) {
            while p.history.front().is_some_and(|(s, _)| *s < ack) {
                p.history.pop_front();
            }
            if let Some(&(_, m)) = p.history.front().filter(|(s, _)| *s == ack) {
                p.body = m.body;
                p.jump = m.jump;
                p.jet = m.jet;
                p.prev_input = m.prev_input;
            }
        }
        self.set_player_state(id, x, y, vx, vy, grounded, fuel, health, alive, move_mods);
    }

    /// `[x, y, vx, vy, grounded, fuel, move_state, landing_impact, health,
    /// alive, move_mods]`, or empty for an unknown id.
    ///
    /// **`health` is the ninth element** (T20.19), and it is here so the array
    /// round-trips everything `set_player_state` accepts: a reader that could set
    /// health but not read it back would have no way to check the mirror learned
    /// what the snapshot told it.
    ///
    /// **`landing_impact` is the eighth element and it exists because `vy` cannot
    /// do its job** (T20.11). `move_y` zeroes `vel.y` before it grounds the body,
    /// so on the one frame a client cares about — the frame it landed — `vy` is
    /// exactly 0. `GameScene` and `SandboxScene` both scaled their landing sound
    /// by `Math.abs(vy) / MAX_FALL_SPEED`, which has therefore been the constant
    /// 0.25 floor since M6: a step off a kerb and a fall from a jetpack burn have
    /// sounded identical for fifteen milestones.
    ///
    /// A flat `f32` array rather than a struct: crossing the boundary with a struct
    /// costs a serialisation step per call, and this is read every frame.
    pub fn player_state(&self, id: u8) -> Box<[f32]> {
        let Some(p) = self.players.iter().find(|p| p.id == id) else {
            return Box::new([]);
        };
        let state = match game_core::physics::body::move_state(&p.body, p.jet.active) {
            game_core::physics::body::MoveState::Grounded => 0.0,
            game_core::physics::body::MoveState::Airborne => 1.0,
            game_core::physics::body::MoveState::Jetpack => 2.0,
        };
        Box::new([
            p.body.pos.x,
            p.body.pos.y,
            p.body.vel.x,
            p.body.vel.y,
            if p.body.grounded { 1.0 } else { 0.0 },
            p.jet.fuel,
            state,
            p.body.landing_impact,
            p.stats.health,
            // **The tenth element, and it round-trips what `set_player_state`
            // now accepts** (T20.21) — for the same reason `health` is the
            // ninth: a setter with no matching reader gives a caller no way to
            // check the mirror learned what the snapshot told it, and this one
            // decides whether `apply_input` moves the body at all.
            if p.stats.alive { 1.0 } else { 0.0 },
            // **The eleventh, and it round-trips what `set_player_state` now
            // accepts** (T21.02) — for the reason `health` and `alive` are the
            // ninth and tenth. `prediction.ts` reads it back to answer "have
            // this player's passives changed since the last snapshot", which is
            // what lets a *non-positional* input to `apply_input` stop being
            // gated behind a *positional* epsilon.
            p.stats.move_mod_bits() as f32,
        ])
    }

    /// T22.04C: the thrust the mirror last stepped this player with, px/s² as
    /// `[ax, ay]` — **`jetpack::thrust_delta` of the input `apply_input` consumed**
    /// (`prev_input`, the neutral one once the round is over), and `[0, 0]` while the
    /// pack is not firing. The plume points against it, so braking draws the exhaust
    /// on the side the push comes from, not opposite the travel.
    ///
    /// **Asked of the core rather than read off the keyboard** (R11): the buttons →
    /// thrust mapping, with its unequal axes (`JETPACK_THRUST_UP` 2200 against
    /// `JETPACK_THRUST_DOWN` 900), is Rust's, and a second spelling in TypeScript would
    /// point a diagonal plume somewhere the body is not being pushed. Only the local
    /// player has one: a remote's input is not on the wire, so its plume stays on
    /// velocity (T22.04C).
    pub fn thrust_at(&self, id: u8) -> Box<[f32]> {
        let Some(p) = self.players.iter().find(|p| p.id == id) else {
            return Box::new([0.0, 0.0]);
        };
        if !p.jet.active {
            return Box::new([0.0, 0.0]);
        }
        let (x, y) = game_core::player::jetpack::thrust_delta(&p.prev_input, 1.0);
        Box::new([x, y])
    }

    /// Put charge in a player's battery. Sandbox only, like `give` (T20.08).
    ///
    /// Through `PlayerState::add_battery`, so `BATTERY_MAX`'s clamp applies here
    /// exactly as it does to a pack picked up in a real round.
    pub fn add_battery(&mut self, id: u8, amount: f32) {
        if let Some(p) = self.players.iter_mut().find(|p| p.id == id) {
            p.stats.add_battery(amount);
        }
    }

    /// Is damage against this player being reduced right now? (T20.08)
    ///
    /// A dedicated call rather than one more float on `player_state`: that array
    /// is length-checked on the TS side and every reader indexes it
    /// positionally, so growing it is a change with more blast radius than a
    /// boolean deserves.
    ///
    /// **It calls `PlayerState::shield_active`, it does not restate it.** The
    /// sandbox draws the same bubble the networked client draws from bit 3, and
    /// the two must not be able to disagree — a second copy of "holds a generator
    /// and has charge" in TypeScript is exactly the divergence `docs/01` exists to
    /// prevent.
    ///
    /// **`suit = false`, as bit 3's encoder passes it** (T22.09A, `M22-RULINGS`
    /// R26): this draws the generator's bubble, and the suit does not wear one.
    /// The suit's seal is [`GameCore::irradiated`].
    ///
    /// **`now` is the caller's sim clock** (R26's "fix the lie", T22.09B).
    /// This passed a literal `0.0`: inert while the predicate ignores its clock,
    /// and wrong the first day it does not. The sandbox passes its `simTime`.
    pub fn shield_active(&self, id: u8, now: f32) -> bool {
        self.players
            .iter()
            .find(|p| p.id == id)
            .is_some_and(|p| p.stats.shield_active(now, false))
    }

    /// Is space's radiation getting through to this player? (T22.09A, R6.)
    ///
    /// **It calls `PlayerState::irradiated`, the function snapshot bit 7 is
    /// encoded from**, with this core's mode for the suit — so the sandbox and a
    /// networked client cannot disagree about when to show it. The sandbox has
    /// no `World::step`, so radiation never *damages* here; this is the
    /// feedback's input only (T22.09B). `now` for `shield_active`'s reason.
    pub fn irradiated(&self, id: u8, now: f32) -> bool {
        self.players
            .iter()
            .find(|p| p.id == id)
            .is_some_and(|p| p.stats.irradiated(now, self.gravity.wears_suit()))
    }

    // ---- metadata --------------------------------------------------------

    /// JSON, because this is called once per round and the cost is irrelevant.
    /// Put items in a player's inventory. Sandbox only — the real game finds them.
    pub fn give(&mut self, id: u8, item: u16, count: u8) {
        if let Some(p) = self.players.iter_mut().find(|p| p.id == id) {
            p.stats.inventory.add(item as ItemId, count);
        }
    }

    pub fn select_slot(&mut self, id: u8, slot: u8) {
        if let Some(p) = self.players.iter_mut().find(|p| p.id == id) {
            p.stats.inventory.select(slot);
        }
    }

    /// The item registry as `[{id, key, sprite, max_stack}]`.
    ///
    /// `ItemDef.sprite` has been populated since T4.01 and nothing could read
    /// it, because the wire carries only a numeric `item_id`. Exported rather
    /// than duplicated client-side, so an item's art and its definition cannot
    /// drift apart (the M0 review's finding 4, in a new place).
    pub fn item_registry_json(&self) -> String {
        let items: Vec<serde_json::Value> = registry::ITEMS
            .iter()
            .map(|d| {
                let mut v = serde_json::json!({
                    "id": d.id,
                    "key": d.key,
                    "name": d.name,
                    "sprite": d.sprite,
                    "max_stack": d.max_stack,
                });
                // §F3: the client times its repeat from the weapon's own cadence,
                // so the cadence travels with the registry rather than being
                // copied into TypeScript. A copy of five cooldowns is the second
                // source of truth `CLAUDE.md` warns about, and it drifts silently
                // — nothing fails when a constant moves and the copy does not.
                //
                // **Present only for weapons.** A medkit has no cooldown and is
                // not automatic; emitting `0` and `false` for it would be an
                // answer to a question it was never asked, and the first caller
                // to read `cooldown === 0` as "repeat as fast as you like" would
                // be right to.
                if let ItemKind::Weapon(wid) = d.kind {
                    if let Some(w) = defs::def(wid) {
                        v["auto"] = serde_json::json!(w.is_auto());
                        v["cooldown"] = serde_json::json!(w.cooldown);
                    }
                }
                v
            })
            .collect();
        serde_json::to_string(&items).unwrap_or_else(|_| "[]".into())
    }

    pub fn inventory_json(&self, id: u8) -> String {
        let Some(p) = self.players.iter().find(|p| p.id == id) else {
            return "null".into();
        };
        let slots: Vec<serde_json::Value> = (0..game_core::constants::INVENTORY_SLOTS)
            .map(|i| match p.stats.inventory.slot(i as u8) {
                Some(s) => serde_json::json!({
                    "item": s.item,
                    "count": s.count,
                    "key": registry::def(s.item).map(|d| d.key).unwrap_or(""),
                }),
                None => serde_json::Value::Null,
            })
            .collect();
        serde_json::json!({
            "slots": slots,
            "selected": p.stats.inventory.selected(),
            "health": p.stats.health,
            "alive": p.stats.alive,
            "score": p.stats.score,
        })
        .to_string()
    }

    /// Fire the selected weapon. Returns a JSON event, or `{"rejected":...}`.
    ///
    /// Goes through `PlayerState::try_fire`, so the sandbox exercises the same
    /// validation order (kind, cooldown, ammo) the server will.
    pub fn fire(&mut self, id: u8, now: f32) -> String {
        let Some(idx) = self.players.iter().position(|p| p.id == id) else {
            return "{\"rejected\":\"no_player\"}".into();
        };
        let aim = game_core::math::dequantize_angle(self.players[idx].prev_input.aim);
        let centre = self.players[idx].body.pos;

        let wid = match self.players[idx].stats.try_fire(now) {
            Ok(w) => w,
            Err(e) => return format!("{{\"rejected\":\"{e:?}\"}}"),
        };
        let Some(w) = defs::def(wid) else {
            return "{\"rejected\":\"no_weapon\"}".into();
        };

        match w.delivery {
            defs::Delivery::Hitscan { .. } => {
                let mut shots_json = Vec::new();
                let map = &mut self.map;
                let mut rng = self.rng.clone();
                let mut targets: Vec<HitTarget> = Vec::new();
                let shots = fire_hitscan(map, &mut targets, w, id, centre, aim, &mut rng, now);
                self.rng = rng;
                for s in shots {
                    shots_json.push(serde_json::json!({
                        "x0": s.from.x, "y0": s.from.y, "x1": s.to.x, "y1": s.to.y,
                        "hit": format!("{:?}", s.hit),
                    }));
                }
                serde_json::json!({ "hitscan": shots_json, "weapon": wid.0 }).to_string()
            }
            // §F1: a bullet is a projectile, and the sandbox flies it exactly as
            // a rocket — same spawn, same step, same JSON. The spread is drawn
            // here for the same reason the server draws it at its fire site.
            defs::Delivery::Bullet { spread, .. } => {
                let a = game_core::weapons::bullet::muzzle_angle(&mut self.rng, aim, spread);
                let pid = self.projectiles.spawn(wid, id, centre, a, now);
                let p = self.projectiles.get(pid).map(|p| (p.pos.x, p.pos.y));
                serde_json::json!({
                    "projectile": { "id": pid, "weapon": wid.0, "key": w.key,
                                    "x": p.map(|q| q.0), "y": p.map(|q| q.1) }
                })
                .to_string()
            }
            defs::Delivery::Projectile { .. } => {
                let pid = self.projectiles.spawn(wid, id, centre, aim, now);
                let p = self.projectiles.get(pid).map(|p| (p.pos.x, p.pos.y));
                serde_json::json!({
                    "projectile": { "id": pid, "weapon": wid.0, "key": w.key,
                                    "x": p.map(|q| q.0), "y": p.map(|q| q.1) }
                })
                .to_string()
            }
            // §B6's three kinds are simulated by the *server*; the sandbox's
            // local fire path does not carry them yet, and each is wired by the
            // task that owns its client rendering (T11.05 melee, T11.06 cone,
            // T11.07 placed).
            //
            // This is an explicit rejection rather than a `_ => {}` arm on
            // purpose: a catch-all compiles and makes the weapon silently do
            // nothing, which is exactly how five mechanisms in this project were
            // built and never wired. A named rejection shows up in the sandbox
            // instead of looking like a weapon that misfired.
            defs::Delivery::Melee { .. } => {
                serde_json::json!({"rejected": "melee_not_in_sandbox", "weapon": wid.0}).to_string()
            }
            // §F10.2. **Implemented rather than rejected**, unlike melee and
            // placed: flames are projectiles, and the sandbox already has a
            // projectile list, so refusing here would be refusing a weapon that
            // works — and the sandbox is where the fire is looked at.
            defs::Delivery::Flames {
                count,
                speed,
                spread,
            } => {
                let muzzle = centre
                    + game_core::math::Vec2::new(aim.cos(), aim.sin())
                        * game_core::constants::MUZZLE_OFFSET;
                let mut rng = self.rng.clone();
                let ids = game_core::weapons::flame::light_fan(
                    &mut self.projectiles,
                    id,
                    game_core::weapons::flame::Fan {
                        at: muzzle,
                        aim,
                        spread,
                        speed,
                        count,
                    },
                    &mut rng,
                    now,
                );
                self.rng = rng;
                serde_json::json!({"flames": ids}).to_string()
            }
            defs::Delivery::Placed { .. } => {
                serde_json::json!({"rejected": "placed_not_in_sandbox", "weapon": wid.0})
                    .to_string()
            }
        }
    }

    /// Step projectiles and resolve whatever they hit. Returns JSON events.
    pub fn combat_step(&mut self, now: f32, dt: f32) -> String {
        let boxes: Vec<(HitId, game_core::math::Aabb)> = self
            .players
            .iter()
            .filter(|p| p.stats.alive)
            .map(|p| (HitId::Player(p.id), p.body.aabb()))
            .collect();
        let wind = self.map.meta.wind;
        // §F10, before the step for the same reason `World::step_placed` does it
        // there: a field over the cap must not get one more tick of damage.
        // The dropped ids are discarded here and that is not an oversight: the
        // sandbox re-reads `liveProjectiles()` every frame rather than following
        // a spawn/despawn stream, so a flame the cap removes is gone from the
        // next read. The networked path has to announce them, and does.
        let _culled = game_core::weapons::flame::enforce_cap(&mut self.projectiles);
        {
            let hits: HitLog = Default::default();
            {
                let mut targets = build_targets(&mut self.players, &hits);
                game_core::weapons::flame::tick(
                    &self.projectiles,
                    &mut self.map,
                    &mut targets,
                    now,
                    dt,
                );
            }
            apply_hits(
                &mut self.players,
                &hits.borrow(),
                now,
                self.gravity.wears_suit(),
            );
        }
        // The sandbox has no birds, so the bullet-only slice is empty here.
        let outcomes = self
            .projectiles
            .step(&self.map, &boxes, &[], wind, self.gravity, now, dt);
        // R99 (T22.14A), `World::step_projectiles`' rule through the one predicate: in
        // space, weather ordnance that reaches the rim is gone without going off —
        // airborne past the inner face here, an impact whose blast would bite the rim
        // below — so the sandbox's shower does not break the rim either.
        let rim = self.map.space_geometry();
        if let Some(geo) = rim {
            let gone: Vec<_> = self
                .projectiles
                .iter()
                .filter(|p| MeteorShower::owns(p.weapon))
                .filter(|p| game_core::effects::meteor::reaches_rim(&geo, p.pos, 0.0))
                .map(|p| p.id)
                .collect();
            for id in gone {
                self.projectiles.remove(id);
            }
        }

        let mut events = Vec::new();
        for im in outcomes {
            let pid = im.id;
            if let (
                Some(geo),
                ProjectileOutcome::Exploded { at } | ProjectileOutcome::Hit { at, .. },
            ) = (rim, &im.outcome)
            {
                let blast = if MeteorShower::is_fragment(im.weapon) {
                    game_core::constants::METEOR_FRAG_CARVE_R
                } else {
                    game_core::constants::METEOR_CARVE_R
                };
                if MeteorShower::owns(im.weapon)
                    && game_core::effects::meteor::reaches_rim(&geo, *at, blast)
                {
                    continue;
                }
            }
            let (at, victim) = match im.outcome {
                // Out of the world (§C15): gone, and it detonates nothing. The
                // local sim has no event stream to despawn it on — `step`
                // already removed it — so there is nothing further to do.
                // A spent bullet (§F1) is the same story as a voided one: gone,
                // and it resolves to nothing.
                ProjectileOutcome::Alive
                | ProjectileOutcome::Voided { .. }
                | ProjectileOutcome::Spent { .. } => continue,
                ProjectileOutcome::Exploded { at } => (at, None),
                ProjectileOutcome::Hit { at, victim } => (at, victim.player()),
            };
            // §C21/§E13: a drop of toxic rain does **not** explode. It poisons
            // whoever it landed on and takes a bullet-sized bite out of anything
            // else (`docs/13` §3 — never a crater). Without this the sandbox
            // detonates it as a bazooka — see the fallback below, which treats
            // every projectile as one — so rain would dig craters here while
            // digging pinholes in a real game, and `weather-visible` samples the
            // sandbox.
            //
            // The same two rules as `World::detonate`, because this is the same
            // decision: `poison_lands` is the shared roof test, not a second copy
            // of one.
            if game_core::effects::toxic::owns(im.weapon) {
                // §F6: a drop **splashes**, and the roof is asked of each victim
                // rather than of the landing point — the same two rules
                // `World::splash_poison` runs, because this is the second place
                // that decides what a landed drop means and the sandbox is where
                // `weather-visible` photographs the rain. A copy that kept
                // §E13's point test would make the sandbox a game where standing
                // in the rain is safe.
                let r2 =
                    game_core::constants::TOXIC_SPLASH_R * game_core::constants::TOXIC_SPLASH_R;
                for p in self.players.iter_mut() {
                    if !p.stats.alive || (p.body.pos - at).len_sq() > r2 {
                        continue;
                    }
                    if !game_core::effects::toxic::poison_lands(&self.map, p.body.pos) {
                        continue;
                    }
                    p.stats.poison(now);
                    events.push(serde_json::json!({
                        "poisoned": { "id": p.id, "until": p.stats.poisoned_until }
                    }));
                }
                if victim.is_some() {
                    // Landed on a body: the ground it never reached keeps its
                    // pixels. The splash above has already run.
                    continue;
                }
                let r = game_core::constants::TOXIC_DROP_CARVE_R.round() as i32;
                self.map
                    .carve_circle(at.x.round() as i32, at.y.round() as i32, r);
                continue;
            }
            // §F10. A flame that has burned out **goes out**. Left to the
            // fallback below it would detonate as a bazooka — 42 px and 45
            // damage — so every flame in the sandbox would end in a crater, and
            // 160 of them would dissolve the map. Same shape as the toxic drop
            // above: the second place that decides what an outcome means is the
            // second place that has to know.
            if game_core::weapons::flame::is_flame(im.weapon) {
                continue;
            }
            // §F10.2. A molotov bursts into a crowd, here as in `World::detonate`
            // — up and outward from the impact, through the one `light_fan`.
            if let Some(w) = defs::def(im.weapon) {
                if let defs::Burst::Flames { count, speed } = w.burst {
                    let mut rng = self.rng.clone();
                    let ids = game_core::weapons::flame::light_fan(
                        &mut self.projectiles,
                        im.owner,
                        game_core::weapons::flame::Fan {
                            at,
                            aim: -std::f32::consts::FRAC_PI_2,
                            spread: std::f32::consts::FRAC_PI_2,
                            speed,
                            count,
                        },
                        &mut rng,
                        now,
                    );
                    self.rng = rng;
                    events.push(serde_json::json!({ "flames": ids }));
                    continue;
                }
            }
            // §F1: a bullet stops, it does not go off — and this is the second
            // place that decides what an outcome means, so it is the second place
            // that has to know.
            //
            // Left to the fallback below, a pistol round resolved as a **bazooka
            // blast**: 42 px and 45 damage, hardcoded, for every projectile. A
            // round stops ~8 px from the body's centre, well inside 42, so the
            // sandbox dealt ~36 damage and rocket knockback for a 14-damage gun
            // and attributed it to `SelfInflicted { weapon: 0 }`.
            //
            // `bullet::resolve` is called rather than reimplemented: one damage
            // path, and the reason `game-core` has one is that two of them drift
            // (§A24). The victim is the only target that can matter — `resolve`
            // damages the body it was handed and nobody else — so a one-element
            // slice is the whole target list, and terrain passes an empty one.
            if let Some(w) =
                defs::def(im.weapon).filter(|w| game_core::weapons::bullet::is_bullet(w))
            {
                let source = BlastSource::Fired {
                    owner: im.owner,
                    weapon: im.weapon,
                };
                match victim.and_then(|v| self.players.iter().position(|p| p.id == v)) {
                    Some(i) => {
                        let (before, pos, alive) = {
                            let p = &self.players[i];
                            (p.stats.health, p.body.pos, p.stats.alive)
                        };
                        let mut vel = self.players[i].body.vel;
                        let mut taken = 0.0f32;
                        // The source `resolve` computed, captured rather than
                        // re-derived. `BlastSource::for_victim` is the one place
                        // that decides who gets the kill credit; a second copy of
                        // that rule here would be the same shape as the damage
                        // fork this branch exists to remove.
                        let mut src: Option<DamageSource> = None;
                        let hit_id = game_core::weapons::explode::HitId::Player(self.players[i].id);
                        {
                            let mut cb = |d: f32, s: DamageSource| {
                                taken += d;
                                src = Some(s);
                                true
                            };
                            let mut targets = [HitTarget {
                                id: hit_id,
                                w: game_core::constants::PLAYER_W,
                                h: game_core::constants::PLAYER_H,
                                pos,
                                vel: &mut vel,
                                alive,
                                apply_damage: &mut cb,
                            }];
                            game_core::weapons::bullet::resolve(
                                &mut self.map,
                                &mut targets,
                                w,
                                at,
                                Some(hit_id),
                                source,
                            );
                        }
                        self.players[i].body.vel = vel;
                        if let (true, Some(src)) = (taken > 0.0, src) {
                            self.players[i].stats.apply_damage(
                                taken,
                                src,
                                now,
                                self.gravity.wears_suit(),
                            );
                            events.push(serde_json::json!({
                                "bullet": { "id": pid, "x": at.x, "y": at.y,
                                            "hit": self.players[i].id, "damage": taken,
                                            "health_before": before,
                                            "health_after": self.players[i].stats.health }
                            }));
                        }
                    }
                    None => {
                        let mut targets: [HitTarget; 0] = [];
                        game_core::weapons::bullet::resolve(
                            &mut self.map,
                            &mut targets,
                            w,
                            at,
                            None,
                            source,
                        );
                        events.push(serde_json::json!({
                            "bullet": { "id": pid, "x": at.x, "y": at.y,
                                        "r": w.blast_radius }
                        }));
                    }
                }
                continue;
            }
            // Every other projectile explodes: contact, fuse or lifetime.
            let (radius, damage, weapon) = (
                game_core::constants::BAZOOKA_BLAST_RADIUS,
                game_core::constants::BAZOOKA_DAMAGE,
                WeaponId(0),
            );
            let mut hits_json = Vec::new();
            for i in 0..self.players.len() {
                let (before, pos, alive) = {
                    let p = &self.players[i];
                    (p.stats.health, p.body.pos, p.stats.alive)
                };
                let mut vel = self.players[i].body.vel;
                let mut taken = 0.0f32;
                {
                    let mut cb = |d: f32, _s: DamageSource| {
                        taken += d;
                        true
                    };
                    let mut targets = [HitTarget {
                        id: game_core::weapons::explode::HitId::Player(self.players[i].id),
                        w: game_core::constants::PLAYER_W,
                        h: game_core::constants::PLAYER_H,
                        pos,
                        vel: &mut vel,
                        alive,
                        apply_damage: &mut cb,
                    }];
                    explode(
                        &mut self.map,
                        &mut targets,
                        at,
                        radius,
                        damage,
                        BlastSource::Fired { owner: 0, weapon },
                    );
                }
                self.players[i].body.vel = vel;
                if taken > 0.0 {
                    let src = DamageSource::SelfInflicted { weapon };
                    self.players[i]
                        .stats
                        .apply_damage(taken, src, now, self.gravity.wears_suit());
                    hits_json.push(serde_json::json!({
                        "id": self.players[i].id,
                        "damage": taken,
                        "health_before": before,
                        "health_after": self.players[i].stats.health,
                    }));
                }
            }
            events.push(serde_json::json!({
                "explosion": { "id": pid, "x": at.x, "y": at.y, "r": radius, "hits": hits_json }
            }));
        }
        serde_json::json!(events).to_string()
    }

    /// Live projectiles, for the renderer.
    pub fn projectiles_json(&self) -> String {
        let v: Vec<serde_json::Value> = self
            .projectiles
            .iter()
            .map(|p| {
                serde_json::json!({
                    "id": p.id,
                    "key": defs::def(p.weapon).map(|w| w.key).unwrap_or("bazooka"),
                    "x": p.pos.x, "y": p.pos.y,
                })
            })
            .collect();
        serde_json::json!(v).to_string()
    }

    pub fn meta_json(&self) -> String {
        serde_json::to_string(&self.map.meta).unwrap_or_else(|_| "{}".to_string())
    }

    /// Solid pixel count — the honest way to ask "did that effect change the
    /// map", rather than inferring it from an event.
    pub fn count_solid(&self) -> f64 {
        // f64 rather than u32: a large map has more than 4 billion... no, but a
        // u64 across the boundary drags in BigInt, and f64 is exact to 2^53.
        self.map.mask.count_solid() as f64
    }

    pub fn mask_hash(&self) -> Box<[u8]> {
        Box::new(self.map.mask.hash())
    }

    /// RLE of the current mask, for tests and for the future replay path.
    pub fn mask_rle(&self) -> Box<[u8]> {
        rle::encode(&self.map.mask).into_boxed_slice()
    }

    // --- weather (M5) ---------------------------------------------------

    /// Force an effect to begin its telegraph now: 0 toxic, 1 meteor, 2 lava,
    /// 3 fog, 4 solar flare. The sandbox control for the M5 checkpoint.
    ///
    /// **A switched-off kind does nothing** (`0` toxic since T21.39, `2` lava since
    /// 2026-09-16): the sandbox is
    /// not a way round the owner's ruling. **Nor does a flare off a space map**
    /// (R83, the roll's own key, `WeatherTable::of`), **nor an unknown number** —
    /// this used to read `_ => HeavyFog`, so any typo forced fog.
    pub fn force_effect(&mut self, kind: u8, now: f32) {
        if kind == 0 && !game_core::constants::TOXIC_RAIN_ENABLED {
            return;
        }
        if kind == 2 && !game_core::constants::LAVA_ENABLED {
            return;
        }
        let kind = match kind {
            0 => EffectKind::ToxicRain,
            1 => EffectKind::MeteorShower,
            2 => EffectKind::LavaBurst,
            3 => EffectKind::HeavyFog,
            4 if WeatherTable::of(&self.map) == WeatherTable::Space => EffectKind::SolarFlare,
            _ => return,
        };
        let seed = self.map.meta.seed;
        let sched = self
            .weather
            .scheduler
            .get_or_insert_with(|| EffectScheduler::new(seed, now));
        sched.force(kind, now);
        self.weather.forced = Some((kind, now));
        match kind {
            EffectKind::ToxicRain => self.weather.toxic = Some(ToxicRain::new(seed, now)),
            EffectKind::MeteorShower => self.weather.meteor = Some(MeteorShower::new(seed, now)),
            EffectKind::LavaBurst => self.weather.lava = Some(LavaBurst::new(seed, &self.map, now)),
            EffectKind::HeavyFog => self.weather.fog = Some(HeavyFog::new(now)),
            EffectKind::SolarFlare => {
                let (w, h) = (self.map.mask.w as f32, self.map.mask.h as f32);
                self.weather.flare = Some((now, SolarFlare::new(seed, w, h)));
            }
        }
    }

    /// Advance the scheduler and every active effect. Returns the hazards the
    /// client should draw, as JSON.
    pub fn weather_step(&mut self, now: f32, dt: f32) -> String {
        let Some(sched) = self.weather.scheduler.as_mut() else {
            // `flare` too (T22.08E F3): every shape this returns carries every key.
            return "{\"active\":[],\"vents\":[],\"fog\":0.0,\"flare\":null}".to_string();
        };
        sched.tick(now, f32::MAX, WeatherTable::of(&self.map));

        let toxic_on = sched.is_active(EffectKind::ToxicRain);
        // T22.14A H3: the spawn window — the world's own test.
        let meteor_on = sched.meteors_falling(now);
        let lava_on = sched.is_active(EffectKind::LavaBurst);
        let fog_on = sched.is_active(EffectKind::HeavyFog);
        let flare_on = sched.is_active(EffectKind::SolarFlare);
        let flare_listed = sched
            .active()
            .iter()
            .any(|e| e.kind == EffectKind::SolarFlare);

        let active: Vec<serde_json::Value> = sched
            .active()
            .iter()
            .map(|e| {
                serde_json::json!({
                    "id": e.id,
                    "kind": match e.kind {
                        EffectKind::ToxicRain => "toxic",
                        EffectKind::MeteorShower => "meteor",
                        EffectKind::LavaBurst => "lava",
                        EffectKind::HeavyFog => "fog",
                        EffectKind::SolarFlare => "flare",
                    },
                    "phase": match e.phase {
                        EffectPhase::Telegraph => "telegraph",
                        EffectPhase::Active => "active",
                        EffectPhase::Done => "done",
                    },
                })
            })
            .collect();

        // Every effect damages through the same HitTarget path a weapon
        // does, so shields and i-frames are handled once rather than per effect.
        if let Some(t) = self.weather.toxic.as_mut() {
            let living: Vec<f32> = self
                .players
                .iter()
                .filter(|p| p.stats.alive)
                .map(|p| p.body.pos.x)
                .collect();
            t.tick(&mut self.projectiles, &self.map, &living, toxic_on, now);
        }

        // §E13's poison, ticked here rather than in the effect: it outlives the
        // shower, so an effect the scheduler is free to drop cannot own it.
        //
        // **Through `apply_damage`, not `health -=`.** The comment above this
        // block says every effect damages through the same path so that shields
        // and i-frames are handled once, and the first version of this made
        // poison the one that did not — a raw subtraction, fifteen lines under
        // that sentence. Three consequences, and only the first is cosmetic:
        // a shielded player would have taken full damage here while the server
        // halved it, a spawning player would have taken it through i-frames, and
        // `health` could have crossed zero with `alive` still true, because
        // `apply_damage` is where the death, the score and the respawn timer are
        // decided. A corpse walking in the local sim, in exactly the builds
        // `hud-bars` photographs.
        //
        // `apply_hits` exists for this and is what every other effect here uses;
        // poison has no `HitTarget` to go through because nothing is hit, so it
        // calls the same stats method that closure ends at.
        let poison = game_core::constants::TOXIC_POISON_DPS * dt;
        for p in self.players.iter_mut() {
            if p.stats.alive && p.stats.poisoned(now) {
                p.stats.apply_damage(
                    poison,
                    DamageSource::Weather(EffectKind::ToxicRain),
                    now,
                    self.gravity.wears_suit(),
                );
            }
        }

        if let Some(m) = self.weather.meteor.as_mut() {
            m.tick(&mut self.projectiles, &self.map, meteor_on, now);
        }

        // T22.08A: the flare, through the **same** `PlayerState` methods the
        // server's `World::step` uses — the touch writes the deadline, and the
        // burn logs once a second through `apply_damage` like the poison above.
        if let Some((start, f)) = self.weather.flare.as_ref() {
            if flare_on {
                for p in self.players.iter_mut().filter(|p| p.stats.alive) {
                    if f.touches(now - start, p.body.pos, p.body.size.x, p.body.size.y) {
                        p.stats.burn(now);
                    }
                }
            }
        }
        for p in self.players.iter_mut() {
            if !p.stats.alive {
                continue;
            }
            if let Some(amount) = p.stats.burn_tick(now, dt) {
                p.stats.apply_damage(
                    amount,
                    DamageSource::Weather(EffectKind::SolarFlare),
                    now,
                    self.gravity.wears_suit(),
                );
            }
        }

        let mut vents = Vec::new();
        if let Some(l) = self.weather.lava.as_mut() {
            let hits: HitLog = Default::default();
            {
                let mut targets = build_targets(&mut self.players, &hits);
                l.tick(&mut self.map, &mut targets, lava_on, now, dt);
            }
            apply_hits(
                &mut self.players,
                &hits.borrow(),
                now,
                self.gravity.wears_suit(),
            );
            for v in l.vents() {
                vents.push(serde_json::json!({
                    "x": v.pos.x, "y": v.pos.y, "lean": v.lean,
                    "jetting": now < v.jet_until, "burning": now >= v.jet_until && now < v.burn_until,
                }));
            }
        }

        let fog = match self.weather.fog.as_ref() {
            Some(f) if fog_on => f.strength(now),
            _ => 0.0,
        };

        // T22.08B: the sandbox's flare as a **query**, the shape a match's
        // `effect_start` gives — seed halves and the effect's own clock — so the
        // sandbox draws through `flare_points`/`flare_touches` exactly as
        // `GameScene` does, and a check here exercises the match's drawing path.
        // Present while the scheduler still lists a flare, telegraph included.
        let flare = match self.weather.flare.as_ref() {
            Some((start, _)) if flare_listed => serde_json::json!({
                "lo": (self.map.meta.seed & 0xffff_ffff) as u32,
                "hi": (self.map.meta.seed >> 32) as u32,
                "elapsed": now - start,
            }),
            _ => serde_json::Value::Null,
        };

        serde_json::json!({
            "active": active,
            "vents": vents,
            "fog": fog,
            "flare": flare,
        })
        .to_string()
    }
}

impl GameCore {
    /// The server-announced flare for this seed, built once and cached — the one
    /// flare `flare_points` draws and `flare_touches` tests, so the two cannot be
    /// two different ribbons.
    fn flare_for(&mut self, seed_lo: u32, seed_hi: u32) -> &SolarFlare {
        let seed = ((seed_hi as u64) << 32) | seed_lo as u64;
        let (w, h) = (self.map.mask.w as f32, self.map.mask.h as f32);
        let cache = &mut self.weather.flare_cache;
        // One construction site (T22.08D F7): a stale entry is dropped, and the one
        // `get_or_insert_with` builds whatever is missing. The first cut rebuilt a
        // stale entry here *and* carried a second constructor in `get_or_insert_with`
        // that could never run.
        if cache.as_ref().is_some_and(|(s, _)| *s != seed) {
            *cache = None;
        }
        &cache
            .get_or_insert_with(|| (seed, SolarFlare::new(seed, w, h)))
            .1
    }
}

/// Where a **server-announced** lava burst opens the ground, and what each vent
/// is doing `elapsed` seconds in.
///
/// This is `fog_strength`'s seam applied to the one effect that needs the map.
/// A real match runs the weather on the server and tells the client only that an
/// effect started, with which seed and when (`effect_start` carries all three) —
/// so there is **no scheduler here and no local simulation**. `weather_step` is
/// the sandbox's path: it owns a scheduler, ticks the effect, carves and deals
/// damage. This one derives presentation and touches nothing.
///
/// Returns the same shape `weather_step` puts in its `"vents"` array, so
/// `WeatherLayer.update` consumes it unchanged.
///
/// **The seed alone was never enough.** `LavaBurst::new` reads
/// `map.meta.surface_points`, which `load_mask` used to clear — see the note
/// there and `effects/lava.rs::t19_24_client_side_vents`, whose control shows a
/// pre-fix client deriving nothing however good its seed.
///
/// Cached on the seed because the constructor rejection-samples up to 200 times
/// and this is called every frame; the same seed rebuilds nothing.
#[wasm_bindgen]
impl GameCore {
    /// T22.08A (`R80`): a server-announced flare's ribbon, `elapsed` seconds after
    /// its `effect_start`, as `[x0, y0, x1, y1, …]` world px — **the points the
    /// server damages with**, `SolarFlare::points_at` on this client's map size.
    /// Cached on the seed: called every frame, and the seed alone decides the
    /// shape. Empty before a map is loaded is not a case: the core always has one.
    pub fn flare_points(&mut self, seed_lo: u32, seed_hi: u32, elapsed: f32) -> Vec<f32> {
        self.flare_for(seed_lo, seed_hi)
            .points_at(elapsed)
            .iter()
            .flat_map(|p| [p.x, p.y])
            .collect()
    }

    /// Is a flare's ribbon lit — there, and burning — `elapsed` seconds after its
    /// `effect_start`? `SolarFlare::lit`, the window the server touches in
    /// (T22.08C F1): the effect's `Active` phase runs `SOLAR_FLARE_BURN_SECONDS`
    /// past it, so the phase alone would draw a ribbon for four seconds after it
    /// stopped burning anyone.
    pub fn flare_lit(elapsed: f32) -> bool {
        SolarFlare::lit(elapsed)
    }

    /// Does a server-announced flare touch a `w × h` box centred on `(x, y)`,
    /// `elapsed` seconds after its `effect_start`? **The server's contact test**,
    /// `SolarFlare::touches` — `lit` included — on the same cached flare
    /// `flare_points` draws. The client uses it to show who is burning (T22.08B):
    /// burning is not on the wire (`R80`, the flags byte is full), and this is the
    /// rule that writes it on the server, not a second one in TypeScript.
    #[allow(clippy::too_many_arguments)]
    pub fn flare_touches(
        &mut self,
        seed_lo: u32,
        seed_hi: u32,
        elapsed: f32,
        x: f32,
        y: f32,
        w: f32,
        h: f32,
    ) -> bool {
        self.flare_for(seed_lo, seed_hi)
            .touches(elapsed, Vec2::new(x, y), w, h)
    }

    pub fn lava_vents(&mut self, seed_lo: u32, seed_hi: u32, elapsed: f32) -> String {
        let seed = ((seed_hi as u64) << 32) | seed_lo as u64;
        if self.weather.lava_seed != Some(seed) {
            // Built at t = 0 so `elapsed` is the whole clock: the server's `now`
            // and the client's are different numbers for the same instant, and
            // only the offset from the effect's own start is shared.
            self.weather.lava = Some(LavaBurst::new(seed, &self.map, 0.0));
            self.weather.lava_seed = Some(seed);
        }
        let Some(l) = self.weather.lava.as_ref() else {
            return "[]".to_string();
        };
        let vents: Vec<serde_json::Value> = l
            .vents()
            .iter()
            .map(|v| {
                serde_json::json!({
                    "x": v.pos.x, "y": v.pos.y, "lean": v.lean,
                    "jetting": elapsed < v.jet_until,
                    "burning": elapsed >= v.jet_until && elapsed < v.burn_until,
                })
            })
            .collect();
        serde_json::json!(vents).to_string()
    }
}

/// §F9's fog strength, `seconds_since_the_effect_started` → `0.0..=1.0`.
///
/// **The networked client has no `HeavyFog`.** The sandbox reads `weather_json`'s
/// `"fog"` off its own local world; a real match runs the weather on the server
/// and the client learns only that an effect started, and when. `fog.rs`'s own
/// header says the ramp is a pure timer *so that* the client can compute it
/// locally — this is that seam, and it is a Rust call rather than a smoothstep
/// rewritten in TypeScript so the veil and `fov_multiplier` cannot drift apart.
///
/// A fresh `HeavyFog` at t = 0 is the whole state, so no handle is needed.
/// T21.26: how hard the **ambient** rain is falling, `0.0..=1.0`.
///
/// A pure function of the map seed and the round clock (`world/ambient.rs`), so a
/// networked client evaluates it for itself exactly as it does the day/night
/// cycle — nothing is broadcast, nothing is simulated, and two clients on one seed
/// agree by construction. The seed is split because `wasm_bindgen` has no `u64`.
#[wasm_bindgen]
pub fn ambient_rain(seed_lo: u32, seed_hi: u32, round_time: f32) -> f32 {
    let seed = ((seed_hi as u64) << 32) | seed_lo as u64;
    game_core::world::ambient::ambient_rain_at(seed, round_time)
}

#[wasm_bindgen]
pub fn fog_strength(elapsed: f32) -> f32 {
    HeavyFog::new(0.0).strength(elapsed)
}

/// Every tunable the client needs, as JSON.
///
/// The client must never re-declare one of these. A literal in TypeScript that
/// shadows a Rust constant is exactly the drift the shared-core architecture exists
/// to prevent (`docs/01-architecture.md`), and `client/src/main.ts` had two of them
/// — VIEWPORT_W and VIEWPORT_H — from M0.
#[wasm_bindgen]
pub fn constants_json() -> String {
    use game_core::constants as c;
    // Built into a Map rather than one big `json!` literal: `json!` expands
    // recursively once per key and blew the macro recursion limit as this list
    // grew. A Map also keeps each value's expansion independent, so adding a
    // constant can never break the ones above it.
    let mut m = serde_json::Map::new();
    macro_rules! put {
        ($($name:ident => $value:expr),* $(,)?) => {
            $( m.insert(stringify!($name).to_string(), serde_json::json!($value)); )*
        };
    }
    put! {
        // The mine's arming tell is drawn client-side (§B6: "visible at close
        // range and subtle at distance"), so the client needs the same number
        // the sim arms on rather than a second copy of it.
        MINE_ARM_TIME => c::MINE_ARM_TIME,
        // T20.10's ground animals. The client draws them at exactly the hit box
        // the sim tests against, so the sizes cross the boundary rather than
        // being spelled in `animals-math.ts`.
        SPIDER_W => c::SPIDER_W,
        SPIDER_H => c::SPIDER_H,
        BEETLE_W => c::BEETLE_W,
        BEETLE_H => c::BEETLE_H,
        ANIMAL_MAX => c::ANIMAL_MAX,
        ANIMAL_INTERVAL => c::ANIMAL_INTERVAL,
        // §C6 x §C21: what the weather layer divides the **live** drop count by
        // to get the emitter's density (T20.05). Exported rather than spelled in
        // `weather.ts` — the client had a 260-droplet sheet on a seed of its own
        // and the number it should have been derived from was in Rust all along.
        TOXIC_DROPS_IN_FLIGHT => c::TOXIC_DROPS_IN_FLIGHT,
        // T21.39: the sandbox hides its Toxic button off this.
        TOXIC_RAIN_ENABLED => c::TOXIC_RAIN_ENABLED,
        LAVA_ENABLED => c::LAVA_ENABLED,
        AMBIENT_RAIN_WINDOW => c::AMBIENT_RAIN_WINDOW,
        AMBIENT_RAIN_CHANCE => c::AMBIENT_RAIN_CHANCE,
        AMBIENT_RAIN_MIN => c::AMBIENT_RAIN_MIN,
        AMBIENT_RAIN_MAX => c::AMBIENT_RAIN_MAX,
        AMBIENT_RAIN_RAMP => c::AMBIENT_RAIN_RAMP,
        AMBIENT_RAIN_DROPS => c::AMBIENT_RAIN_DROPS,
        AMBIENT_RAIN_COLOUR => c::AMBIENT_RAIN_COLOUR,
        AMBIENT_RAIN_FALL_MIN => c::AMBIENT_RAIN_FALL_MIN,
        AMBIENT_RAIN_FALL_MAX => c::AMBIENT_RAIN_FALL_MAX,
        AMBIENT_RAIN_STREAK_MIN => c::AMBIENT_RAIN_STREAK_MIN,
        AMBIENT_RAIN_STREAK_MAX => c::AMBIENT_RAIN_STREAK_MAX,
        AMBIENT_RAIN_WIDTH => c::AMBIENT_RAIN_WIDTH,
        AMBIENT_RAIN_SPAWN_DEPTH => c::AMBIENT_RAIN_SPAWN_DEPTH,
        AMBIENT_RAIN_STAGGER => c::AMBIENT_RAIN_STAGGER,
        CLOUD_RAIN_DARKEN => c::CLOUD_RAIN_DARKEN,
        CLOUD_RAIN_GREY => c::CLOUD_RAIN_GREY,
        TOXIC_STREAK_LEN => c::TOXIC_STREAK_LEN,
        TOXIC_STREAK_WIDTH => c::TOXIC_STREAK_WIDTH,
        TOXIC_STREAK_ALPHA => c::TOXIC_STREAK_ALPHA,
        TOXIC_CAST_ALPHA => c::TOXIC_CAST_ALPHA,
        TOXIC_CAST_RAMP => c::TOXIC_CAST_RAMP,
        TOXIC_DECK_SPACING => c::TOXIC_DECK_SPACING,
        TOXIC_CLOUD_TINT => c::TOXIC_CLOUD_TINT,
        AMBIENT_RAIN_ALPHA => c::AMBIENT_RAIN_ALPHA,
        TOMBSTONE_W => c::TOMBSTONE_W,
        TOMBSTONE_H => c::TOMBSTONE_H,
        MAX_TOMBSTONES => c::MAX_TOMBSTONES,
        VIEWPORT_W => c::VIEWPORT_W,
        VIEWPORT_H => c::VIEWPORT_H,
        CHUNK_SIZE => c::CHUNK_SIZE,
        INPUT_REDUNDANCY => c::INPUT_REDUNDANCY,
        MAX_INPUT_QUEUE => c::MAX_INPUT_QUEUE,
        // T22.10D: the client's frame ceiling, which now sizes the server's input
        // intake (`MAX_FRAME_TICKS`) — `constants-parity.test.ts` pins
        // `autoFire.ts::MAX_FRAME_DT` to it.
        MAX_FRAME_DT => c::MAX_FRAME_DT,
        SNAPSHOT_PLAYER_BYTES => c::SNAPSHOT_PLAYER_BYTES,
        SNAPSHOT_HEADER_BYTES => c::SNAPSHOT_HEADER_BYTES,
        SNAPSHOT_FOOTER_BYTES => c::SNAPSHOT_FOOTER_BYTES,
        // T22.10H: position/velocity quantum — `codec.ts::decodeSnapshot` multiplies
        // by it, and check tolerances that charge for the wire's rounding derive from it.
        SNAPSHOT_QUANTUM => c::SNAPSHOT_QUANTUM,
        SNAPSHOT_HZ => c::SNAPSHOT_HZ,
        INTERP_DELAY_MS => c::INTERP_DELAY_MS,
        RECONCILE_EPSILON_PX => c::RECONCILE_EPSILON_PX,
        COARSE_CELL => c::COARSE_CELL,
        BEDROCK_H => c::BEDROCK_H,
        // §C15's destructible floor. Exported beside `BEDROCK_H` because the two
        // now answer different questions and a client that wants "where does the
        // ground start" wants this one — `BEDROCK_H` is 0.
        FLOOR_CRUST => c::FLOOR_CRUST,
        WALL_W => c::WALL_W,
        SKY_MARGIN => c::SKY_MARGIN,
        PLAYER_W => c::PLAYER_W,
        PLAYER_H => c::PLAYER_H,
        // The walk animation's reference speed, so a slowed player trudges.
        // Exported rather than duplicated client-side (M0 review, finding 4).
        WALK_SPEED => c::WALK_SPEED,
        // Terminal velocity, as the reference for how hard a landing sounds
        // (T9.01). Exported for the same reason WALK_SPEED is: the alternative
        // is a second copy of the number on the client.
        MAX_FALL_SPEED => c::MAX_FALL_SPEED,
        EDGE_BAND_PX => c::EDGE_BAND_PX,
        // Physics the client already draws with, and which a check needs to
        // predict where a bird's drop can be: without them a fixture has to
        // spell the numbers, which is the thing `CLAUDE.md` forbids.
        GRAVITY => c::GRAVITY,
        // T22.02. Exported so a client fixture can say "half as far" without
        // writing 0.5 — a literal in TypeScript that shadows a Rust constant is
        // the drift this boundary exists to prevent.
        LOW_GRAVITY_SCALE => c::LOW_GRAVITY_SCALE,
        BIRD_DROP_VELOCITY => c::BIRD_DROP_VELOCITY,
        CHUNK_REBAKE_BUDGET => c::CHUNK_REBAKE_BUDGET,
        CHUNK_REBAKE_MS => c::CHUNK_REBAKE_MS,
        PARALLAX_FACTOR => c::PARALLAX_FACTOR,
        CAMERA_LERP => c::CAMERA_LERP,
        CAMERA_ZOOM => c::CAMERA_ZOOM,
        CAMERA_DEADZONE_W => c::CAMERA_DEADZONE_W,
        CAMERA_DEADZONE_H => c::CAMERA_DEADZONE_H,
        CAMERA_LOOKAHEAD => c::CAMERA_LOOKAHEAD,
        CAMERA_LOOKAHEAD_LERP => c::CAMERA_LOOKAHEAD_LERP,
        SIM_DT => c::SIM_DT,
        SIM_HZ => c::SIM_HZ,
        AIM_RADIUS => c::AIM_RADIUS,
        JETPACK_MAX_FUEL => c::JETPACK_MAX_FUEL,
        // §C26's three numbers. The readout exists so the refill curve can be
        // read off the screen, and the check that asserts the curve has to pin
        // to these rather than carry its own copies (§A19) — a fixture holding
        // 0.5 stays green against an implementation that has drifted to 0.4.
        JETPACK_DRAIN => c::JETPACK_DRAIN,
        JETPACK_REFILL => c::JETPACK_REFILL,
        JETPACK_REFILL_DELAY => c::JETPACK_REFILL_DELAY,
        // `T22.05B`: the space arena's rim thickness, for the browser check
        // that asserts the minimap draws the mode's boundary. The check needs a
        // row range in minimap cells, which is `SKY_MARGIN` to
        // `SKY_MARGIN + SPACE_RIM_THICKNESS` divided by the cell height — and a
        // literal 32 in TypeScript is exactly the shadow of a Rust constant
        // this boundary exists to prevent (§A19).
        SPACE_RIM_THICKNESS => c::SPACE_RIM_THICKNESS,
        MINIMAP_W => c::MINIMAP_W,
        MINIMAP_H => c::MINIMAP_H,
        MINIMAP_ALPHA => c::MINIMAP_ALPHA,
        MINIMAP_REVEAL_R => c::MINIMAP_REVEAL_R,
        MINIMAP_CRATE_PERIOD => c::MINIMAP_CRATE_PERIOD,
        MINIMAP_CRATE_ON => c::MINIMAP_CRATE_ON,
        MINIMAP_CRATE_COLOUR => c::MINIMAP_CRATE_COLOUR,
        MINIMAP_CRATE_DOT => c::MINIMAP_CRATE_DOT,
        AIM_DEADZONE => c::AIM_DEADZONE,
        SUN_RADIUS => c::SUN_RADIUS,
        MOON_RADIUS => c::MOON_RADIUS,
        SKY_BODY_ARC_H => c::SKY_BODY_ARC_H,
        SKY_BODY_PARALLAX => c::SKY_BODY_PARALLAX,
        STAR_COUNT => c::STAR_COUNT,
        STAR_FADE_START => c::STAR_FADE_START,
        // T22.06: the space backdrop.
        SPACE_EARTH_RADIUS => c::SPACE_EARTH_RADIUS,
        SPACE_MOON_RADIUS => c::SPACE_MOON_RADIUS,
        SPACE_SUN_RADIUS => c::SPACE_SUN_RADIUS,
        SPACE_SUN_GLOW => c::SPACE_SUN_GLOW,
        SPACE_SUN_PATH_RX => c::SPACE_SUN_PATH_RX,
        SPACE_SUN_PATH_RY => c::SPACE_SUN_PATH_RY,
        SPACE_EARTH_PATH_RX => c::SPACE_EARTH_PATH_RX,
        SPACE_EARTH_PATH_RY => c::SPACE_EARTH_PATH_RY,
        SPACE_SUN_PERIOD => c::SPACE_SUN_PERIOD,
        SPACE_EARTH_PERIOD => c::SPACE_EARTH_PERIOD,
        SPACE_MOON_PERIOD => c::SPACE_MOON_PERIOD,
        SPACE_MOON_ORBIT => c::SPACE_MOON_ORBIT,
        SPACE_MOON_TILT => c::SPACE_MOON_TILT,
        SPACE_STAR_DRIFT => c::SPACE_STAR_DRIFT,
        SPACE_STAR_COUNT => c::SPACE_STAR_COUNT,
        SPACE_BODY_PARALLAX => c::SPACE_BODY_PARALLAX,
        SPACE_STAR_PARALLAX => c::SPACE_STAR_PARALLAX,
        // §C14's living background. The arrays cross as JSON arrays — `json!`
        // handles `[f32; N]` — so the client reads one definition of the scroll
        // factors rather than keeping a second copy beside them.
        MOUNTAIN_LAYERS => c::MOUNTAIN_LAYERS,
        MOUNTAIN_PARALLAX => c::MOUNTAIN_PARALLAX,
        MOUNTAIN_HEIGHT_FRAC => c::MOUNTAIN_HEIGHT_FRAC,
        MOUNTAIN_BASE_FRAC => c::MOUNTAIN_BASE_FRAC,
        MOUNTAIN_TITLE_BASE_FRAC => c::MOUNTAIN_TITLE_BASE_FRAC,
        MOUNTAIN_FOOT_FADE => c::MOUNTAIN_FOOT_FADE,
        SKY_HORIZON_FRAC => c::SKY_HORIZON_FRAC,
        MOUNTAIN_HAZE => c::MOUNTAIN_HAZE,
        MOUNTAIN_CELLS => c::MOUNTAIN_CELLS,
        MOUNTAIN_OCTAVES => c::MOUNTAIN_OCTAVES,
        CLOUD_DRIFT => c::CLOUD_DRIFT,
        CLOUD_WIND_GAIN => c::CLOUD_WIND_GAIN,
        CLOUD_SPACING => c::CLOUD_SPACING,
        CLOUD_W_MIN => c::CLOUD_W_MIN,
        CLOUD_W_MAX => c::CLOUD_W_MAX,
        CLOUD_ASPECT_MIN => c::CLOUD_ASPECT_MIN,
        CLOUD_ASPECT_MAX => c::CLOUD_ASPECT_MAX,
        CLOUD_LOBES_MIN => c::CLOUD_LOBES_MIN,
        CLOUD_LOBES_MAX => c::CLOUD_LOBES_MAX,
        CLOUD_SPEED_MIN => c::CLOUD_SPEED_MIN,
        CLOUD_SPEED_MAX => c::CLOUD_SPEED_MAX,
        CLOUD_BRIGHT_MIN => c::CLOUD_BRIGHT_MIN,
        CLOUD_BRIGHT_MAX => c::CLOUD_BRIGHT_MAX,
        CLOUD_TINT_COOL => c::CLOUD_TINT_COOL,
        CLOUD_TINT_WARM => c::CLOUD_TINT_WARM,
        CLOUD_OPACITY_MIN => c::CLOUD_OPACITY_MIN,
        CLOUD_OPACITY_MAX => c::CLOUD_OPACITY_MAX,
        CLOUD_ALTITUDE_MIN => c::CLOUD_ALTITUDE_MIN,
        CLOUD_ALTITUDE_MAX => c::CLOUD_ALTITUDE_MAX,
        CLOUD_FLOOR_WINDOW => c::CLOUD_FLOOR_WINDOW,
        CLOUD_FLOOR_SMOOTH => c::CLOUD_FLOOR_SMOOTH,
        CLOUD_FLOOR_STEP => c::CLOUD_FLOOR_STEP,
        CLOUD_TOP_MIN => c::CLOUD_TOP_MIN,
        CLOUD_RINGS => c::CLOUD_RINGS,
        CLOUD_RINGS_HQ => c::CLOUD_RINGS_HQ,
        CLOUD_TITLE_FLOOR_FRAC => c::CLOUD_TITLE_FLOOR_FRAC,
        CLOUD_ALPHA => c::CLOUD_ALPHA,
        CLOUD_SKY_MIX => c::CLOUD_SKY_MIX,
        CLOUD_ALPHA_FLOOR => c::CLOUD_ALPHA_FLOOR,
        RIDGE_TEX_W => c::RIDGE_TEX_W,
        MOUNTAIN_INK => c::MOUNTAIN_INK,
        NIGHT_DARKNESS => c::NIGHT_DARKNESS,
        FOV_DAY => c::FOV_DAY,
        FOV_NIGHT => c::FOV_NIGHT,
        FOV_FOG_MULT => c::FOV_FOG_MULT,
        // §F9's veil. The client draws the fill and needs both halves; the
        // *strength* it multiplies them by comes from `fog_strength` below, not
        // from a second smoothstep written in TypeScript.
        FOG_SCREEN_ALPHA => c::FOG_SCREEN_ALPHA,
        FOG_SCREEN_COLOUR => c::FOG_SCREEN_COLOUR,
        FOG_DURATION => c::FOG_DURATION,
        FOG_RAMP => c::FOG_RAMP,
        FOV_HEALTH_MIN_MULT => c::FOV_HEALTH_MIN_MULT,
        FOV_EDGE_SOFTNESS => c::FOV_EDGE_SOFTNESS,
        FLASHLIGHT_RANGE => c::FLASHLIGHT_RANGE,
        FLASHLIGHT_CONE_DEG => c::FLASHLIGHT_CONE_DEG,
        // T20.07 replaced `FLASHLIGHT_AMBIENT_MULT` (0.65, a trade) with these
        // two: carrying a flashlight widens the night radius and lightens §F9's
        // veil. Both are read by `lightmap-math.ts` and `weather-math.ts`, which
        // are the live copies — `cycle.rs::fov_radius` has no production caller.
        FLASHLIGHT_FOV_MULT => c::FLASHLIGHT_FOV_MULT,
        FLASHLIGHT_FOG_VEIL_MULT => c::FLASHLIGHT_FOG_VEIL_MULT,
        BASE_HEALTH => c::BASE_HEALTH,
        // How long an environmental death still credits a recent attacker
        // (`docs/21` §4). Exported for §C15's browser check, which has to wait
        // the window out to observe a *pure* void death — a fixture carrying its
        // own 5.0 would go quietly wrong the day this moves (§A19).
        ASSIST_WINDOW => game_core::player::state::ASSIST_WINDOW,
        RESPAWN_DELAY => c::RESPAWN_DELAY,
        // How close you have to be to take something off the ground. The
        // browser check that walks a player at a crate asserts against it, and
        // a check that hardcodes 20 stays green against a drifted sim (§A19).
        PICKUP_RADIUS => c::PICKUP_RADIUS,
        // The fastest a body moves under its own power. A browser check that
        // samples a position on a timer needs it to know how far the subject
        // could have travelled between two samples.
        JETPACK_MAX_SPEED => c::JETPACK_MAX_SPEED,
        // §F10.2 retired `LAVA_BURN_RADIUS` with the disc it sized. The client
        // drew a hazard light at it; a vent's afterburn is flames now, and each
        // one lights the map itself.
        FLAME_RADIUS => c::FLAME_RADIUS,
        FLAME_LIFE => c::FLAME_LIFE,
        MOLOTOV_FLAMES => c::MOLOTOV_FLAMES,
        // §F10.3's worst case: `fire-visible` lays down a full field and reports
        // what it costs to draw and to light. A browser check carrying its own
        // copy of the cap is §A19 — it would go on measuring 160 the day the cap
        // moved, and report a full field it never built.
        FLAME_MAX_LIVE => c::FLAME_MAX_LIVE,
        TOXIC_POISON_DURATION => c::TOXIC_POISON_DURATION,
        TOXIC_POISON_DPS => c::TOXIC_POISON_DPS,
        TOXIC_DROP_CARVE_R => c::TOXIC_DROP_CARVE_R,
        // §F6. `m5-weather` bounds how much ground a shower may remove, and the
        // bound is `drops × π·r²` — it had `(8 / 0.4)` written into it as two
        // literals, so the day the cadence moved it went on checking a ceiling
        // for a shower a third the size. A browser check carrying its own copy
        // of a tunable is §A19; these are the two it needs to compute the number
        // itself.
        TOXIC_DURATION => c::TOXIC_DURATION,
        TOXIC_DROP_EVERY => c::TOXIC_DROP_EVERY,
        TOXIC_SPLASH_R => c::TOXIC_SPLASH_R,
        HEALTH_CAP => c::HEALTH_CAP,
        // §F2: the beam's life, and the bullet streak's shape. `TRACER_LIFETIME`
        // is retired — that path is the two lasers now.
        BEAM_LIFETIME => c::BEAM_LIFETIME,
        BEAM_SHADER_WIDTH => c::BEAM_SHADER_WIDTH,
        BEAM_SHADER_POOL => c::BEAM_SHADER_POOL,
        FLAME_SHADER_SCALE => c::FLAME_SHADER_SCALE,
        FLAME_SHADER_ASPECT => c::FLAME_SHADER_ASPECT,
        FLAME_SHADER_BASE => c::FLAME_SHADER_BASE,
        FLAME_SHADER_POOL => c::FLAME_SHADER_POOL,
        BLAST_SHADER_LIFE => c::BLAST_SHADER_LIFE,
        BLAST_SHADER_SCALE => c::BLAST_SHADER_SCALE,
        BLAST_SHADER_POOL => c::BLAST_SHADER_POOL,
        // T21.18: `smoke-shader` sizes its patches from the cloud and reports the
        // multiplier a player inside it gets, rather than carrying copies.
        SMOKE_RADIUS => c::SMOKE_RADIUS,
        FOV_SMOKE_MULT => c::FOV_SMOKE_MULT,
        SMOKE_SHADER_SCALE => c::SMOKE_SHADER_SCALE,
        // T22.04: the thruster plume's size, so `thrusters` aims its patches off it.
        THRUSTER_PLUME_LENGTH => c::THRUSTER_PLUME_LENGTH,
        THRUSTER_PLUME_WIDTH => c::THRUSTER_PLUME_WIDTH,
        THRUSTER_PLUME_MIN_SPEED => c::THRUSTER_PLUME_MIN_SPEED,
        // T22.09B: the radiation glow pulses once per damage entry.
        RADIATION_LOG_INTERVAL => c::RADIATION_LOG_INTERVAL,
        // T22.08B: the flare's painted size and its burn, drawing only — the ribbon's
        // position is `flare_points`, never re-derived from these.
        // T22.10B: the vortex's drawing radii — what takes you, and where thrust
        // stops winning. Drawing only: the pull is `env_at`, never these in TS.
        VORTEX_CAPTURE_R => c::VORTEX_CAPTURE_R,
        VORTEX_REACH => c::VORTEX_REACH,
        BLACK_HOLE_HORIZON_R => c::BLACK_HOLE_HORIZON_R,
        BLACK_HOLE_REACH => c::BLACK_HOLE_REACH,
        // T22.12C R93: how long the telegraph lasts before the hole opens.
        BLACK_HOLE_TELEGRAPH => c::BLACK_HOLE_TELEGRAPH,
        SOLAR_FLARE_RIBBON_R => c::SOLAR_FLARE_RIBBON_R,
        SOLAR_FLARE_GLOW => c::SOLAR_FLARE_GLOW,
        SOLAR_FLARE_SPAN => c::SOLAR_FLARE_SPAN,
        SOLAR_FLARE_HEIGHT => c::SOLAR_FLARE_HEIGHT,
        SOLAR_FLARE_SAMPLES => c::SOLAR_FLARE_SAMPLES as f32,
        SOLAR_FLARE_BURN_SECONDS => c::SOLAR_FLARE_BURN_SECONDS,
        SOLAR_FLARE_CONFIRM_SECONDS => c::SOLAR_FLARE_CONFIRM_SECONDS,
        EFFECT_TELEGRAPH => c::EFFECT_TELEGRAPH,
        SMOKE_SHADER_POOL => c::SMOKE_SHADER_POOL,
        BULLET_LENGTH => c::BULLET_LENGTH,
        BULLET_WIDTH => c::BULLET_WIDTH,
        TRACER_WIDTH => c::TRACER_WIDTH,
        PROJECTILE_TRAIL_LEN => c::PROJECTILE_TRAIL_LEN,
        MUZZLE_OFFSET => c::MUZZLE_OFFSET,
        BAZOOKA_BLAST_RADIUS => c::BAZOOKA_BLAST_RADIUS,
        // `two-clients` fires the bazooka and needs both of these to fire it
        // *deliberately*: the cadence so every shot is accepted rather than
        // refused on cooldown, and the stack size so the shot count is a number
        // it chose. It slept 250 ms against a 900 ms cooldown, so nine of its
        // twelve calls were silently refused and it destroyed whatever three
        // rockets happened to reach.
        BAZOOKA_COOLDOWN => c::BAZOOKA_COOLDOWN,
        BAZOOKA_AMMO => c::BAZOOKA_AMMO as f32,
        GRENADE_BLAST_RADIUS => c::GRENADE_BLAST_RADIUS,
        SMG_BLAST_RADIUS => c::SMG_BLAST_RADIUS,
        SMG_RANGE => c::SMG_RANGE,
        // §F3: `ordnance` holds the button for a second and checks the shot
        // count against the weapon's own cadence. Without this the check
        // computed `1.0 / undefined` and asserted against **NaN** — every
        // comparison false, so it failed loudly rather than passing silently,
        // which is the only reason it was caught (`CLAUDE.md`: an assertion on a
        // field that does not exist cannot fail).
        SMG_COOLDOWN => c::SMG_COOLDOWN,
        // §F1: a bullet flies, so anything that aims at a moving target has to
        // lead it by the flight time. `birds` did exactly one tick of lead when
        // the round was hitscan and instant; a fixture that keeps that number
        // now aims where the bird *was* (§A19 — a wait, or a lead, hardcoded
        // against a tunable is a fixture that expires).
        SMG_MUZZLE_SPEED => c::SMG_MUZZLE_SPEED,
        // The kill switch, not a tunable: the renderer skips the whole
        // classifier when this is false, so it never pays for a mask it will
        // not draw.
        // §C16. The client draws birds at the size a bullet hits them at, so
        // these cross rather than being copied into the renderer (§A19).
        // The two rewards, by registry id. Exported for the same reason
        // `ASSIST_WINDOW` was (§A19): a browser check asserting "a metal bird
        // drops a battery" must not carry its own copy of `6`.
        ITEM_MEDKIT => game_core::items::registry::MEDKIT,
        ITEM_BATTERY_PACK => game_core::items::registry::BATTERY_PACK,
        BIRD_W => c::BIRD_W,
        BIRD_H => c::BIRD_H,
        BIRD_MAX => c::BIRD_MAX,
        BIRD_INTERVAL => c::BIRD_INTERVAL,
        BIRD_SPEED => c::BIRD_SPEED,
        BIRD_METAL_HEALTH => c::BIRD_METAL_HEALTH,
        CAVE_BACKDROP => c::CAVE_BACKDROP,
        BACKDROP_RAYS => c::BACKDROP_RAYS,
        BACKDROP_RAY_LEN => c::BACKDROP_RAY_LEN,
        BACKDROP_MIN_HITS => c::BACKDROP_MIN_HITS,
        BACKDROP_MIN_UP => c::BACKDROP_MIN_UP,
        BACKDROP_MAX_DIST_TO_SOLID => c::BACKDROP_MAX_DIST_TO_SOLID,
        BACKDROP_MIN_ROOF => c::BACKDROP_MIN_ROOF,
        TIMER_WARN_SECONDS => c::TIMER_WARN_SECONDS,
        // §C5. The client draws the pads and fills the charge indicator, so it
        // needs the same geometry and the same two seconds the sim uses — a
        // renderer carrying its own 40 and its own 2.0 would keep drawing the
        // old pad after either was tuned (§A19).
        // T22.01. **The gravity spellings themselves**, not a tunable — the one
        // mechanism that pins `lobby.ts`'s `GRAVITIES` to `GravityMode::ALL`.
        // Without it the two lists agreed by comment only, and a drift on the
        // third value would reach a player as `lobby_error: unknown gravity`
        // with nothing red first. `lobby.test.ts` asserts the two are equal;
        // this is the end of that assertion that Rust owns.
        GRAVITY_MODES => c::GravityMode::ALL.iter().map(|g| g.as_str()).collect::<Vec<_>>(),
        // §F7. The private-lobby panel draws its own bounds and its own step;
        // a stepper carrying a local 240/600/60 would keep offering the old
        // range after any of them was tuned (§A19).
        ROUND_SECONDS_MIN => c::ROUND_SECONDS_MIN,
        ROUND_SECONDS_MAX => c::ROUND_SECONDS_MAX,
        ROUND_SECONDS_STEP => c::ROUND_SECONDS_STEP,
        TELEPORT_PADS => c::TELEPORT_PADS,
        PAD_W => c::PAD_W,
        PAD_H => c::PAD_H,
        // T21.28: the gate's drawn width, which the generator fills ground under.
        PAD_ART_W => c::PAD_ART_W,
        PAD_TOUCH_SLACK => c::PAD_TOUCH_SLACK,
        TELEPORT_CHARGE => c::TELEPORT_CHARGE,
        TELEPORT_COOLDOWN => c::TELEPORT_COOLDOWN,
        TELEPORT_ARM_DISTANCE => c::TELEPORT_ARM_DISTANCE,
        // T21.11: the renderer sizes the turret from the footprint, so the
        // picture cannot drift from the rock `carve_circle` protects.
        GUN_PLATFORMS => c::GUN_PLATFORMS,
        GUN_PLATFORM_W => c::GUN_PLATFORM_W,
        GUN_PLATFORM_H => c::GUN_PLATFORM_H,
        // T21.43: the cadence the client repeats `fire` at while a mounted
        // player holds the button — the platform's clock, not a TS copy of it.
        GUN_PLATFORM_FIRE_INTERVAL => c::GUN_PLATFORM_FIRE_INTERVAL,
        BATTERY_MAX => c::BATTERY_MAX,
        MAX_HEALS => c::MAX_HEALS,
        QUICK_SLOTS => c::QUICK_SLOTS,
        BACKPACK_SLOTS => c::BACKPACK_SLOTS,
        INVENTORY_SLOTS => c::INVENTORY_SLOTS,
        MEDKIT_HEAL => c::MEDKIT_HEAL,
        MAX_BATTERIES => c::MAX_BATTERIES,
        BATTERY_PACK_AMOUNT => c::BATTERY_PACK_AMOUNT,
        // `SHIELD_DRAIN` and `SHIELD_DURATION` are gone (T20.08) — the shield is
        // held and pays per hit, so there is no per-second cost and no window.
        // `SHIELD_HIT_COST` is what the client needs instead: the HUD reads the
        // battery as a count of absorptions rather than a fraction of a timer.
        SHIELD_HIT_COST => c::SHIELD_HIT_COST,
        DAY_DURATION => c::DAY_DURATION,
        NIGHT_DURATION => c::NIGHT_DURATION,
        CYCLE_TRANSITION => c::CYCLE_TRANSITION,
        BTN_LEFT => game_core::player::input::button::LEFT,
        BTN_RIGHT => game_core::player::input::button::RIGHT,
        BTN_UP => game_core::player::input::button::UP,
        BTN_DOWN => game_core::player::button::DOWN,
        BTN_JUMP => game_core::player::input::button::JUMP,
        BTN_FIRE => game_core::player::input::button::FIRE,
        BTN_FLASHLIGHT => game_core::player::input::button::FLASHLIGHT,
    }
    serde_json::Value::Object(m).to_string()
}

/// Angle → wire word. The server dequantises with the Rust version, so a
/// TypeScript reimplementation that rounds differently would put every shot a
/// fraction off. One implementation, called from both sides.
#[wasm_bindgen]
pub fn quantize_angle(a: f32) -> u16 {
    game_core::math::quantize_angle(a)
}

#[wasm_bindgen]
pub fn dequantize_angle(q: u16) -> f32 {
    game_core::math::dequantize_angle(q)
}

#[cfg(test)]
mod tests {
    use super::*;
    use game_core::constants::{
        BASE_HEALTH, HEALTH_SPEED_MIN, PLAYER_H, PLAYER_W, RECONCILE_EPSILON_PX, SKY_MARGIN,
        WALK_SPEED,
    };

    /// **Every test in this crate is a plain `#[test]`, and that is the fix for
    /// T19.19.**
    ///
    /// Thirteen of them were `#[wasm_bindgen_test]`, which `cargo test -p
    /// game-wasm` compiles and never runs — the gate log's `3 passed` against
    /// sixteen test functions. They had not executed since M3.
    ///
    /// **Nothing here needs a browser.** The crate depends on `wasm-bindgen`,
    /// `serde_json` and `game-core` and mentions neither `js_sys` nor `web_sys`
    /// anywhere, so every method these call runs natively. Wiring `wasm-pack
    /// test --node` into a ~35 minute gate to buy assertions that cost nothing
    /// natively was the wrong half of T19.19's choice.
    ///
    /// **The wasm target is exercised, and not from here.**
    /// `client/src/core/index.test.ts` drives the real compiled `pkg` through
    /// vitest and duplicates nine of the thirteen outright. What it does *not*
    /// cover — the assertions that were genuinely dark, listed so nobody deletes
    /// them as redundant — is `meta_json`'s `buried_slots` key, the seed's
    /// **high half** mattering (every TypeScript seed is under 2^32, so `hi` is
    /// 0 in all of them), `add_player` ignoring a duplicate id,
    /// `set_player_state`'s **velocity** round-tripping, and two of
    /// `load_mask`'s four malformed inputs (an empty slice, and 0x0).
    ///
    /// `wasm-bindgen-test` is out of `Cargo.toml`, so a future
    /// `#[wasm_bindgen_test]` here does not compile. The test below is the
    /// second half of that guard, for the day somebody adds the dependency back.
    #[test]
    fn no_test_in_this_crate_is_invisible_to_the_gate() {
        // The needle is split so this assertion does not match its own source.
        let needle = concat!("#[wasm_bindgen", "_test]");
        let src = include_str!("lib.rs");
        // Doc comments discuss the attribute in prose; only an attribute on its
        // own line is one the compiler acts on.
        let offenders: Vec<usize> = src
            .lines()
            .enumerate()
            .filter(|(_, l)| l.trim_start().starts_with(needle))
            .map(|(i, _)| i + 1)
            .collect();
        assert!(
            offenders.is_empty(),
            "`cargo test --workspace` runs no {needle} — the gate has no wasm runner \
             (`scripts/check.sh`). A test written with that attribute compiles, reports \
             nothing and is never executed, which is how thirteen of them sat dark from \
             M3 to M19. Make these plain `#[test]`s, or wire a runner into the gate and \
             delete this guard. Lines: {offenders:?}"
        );
    }

    /// §F3 — `item_registry_json` really emits the cadence, for every item.
    ///
    /// **The test that was missing.** The TypeScript side asserts `auto` and
    /// `cooldown` against a re-derivation of the same Rust *source*, so it
    /// protects the weapon table and says nothing about the emitter: handing
    /// every item — the medkit included — a bazooka's values left all twelve of
    /// those tests green. This is the only thing in the gate that reads what the
    /// function actually produces, and it matters under `--fast`, where the
    /// browser check that would notice does not run at all.
    ///
    /// Exhaustive rather than spot-checked, because the failure it exists for is
    /// a *blanket* — one wrong value applied to everything. Checking only the SMG
    /// would pass a build that gave the SMG's cadence to a medkit.
    #[test]
    fn the_registry_json_carries_each_weapons_own_cadence_and_nothing_elses() {
        let core = GameCore::new();
        let json = core.item_registry_json();
        let items: Vec<serde_json::Value> =
            serde_json::from_str(&json).expect("item_registry_json is not valid JSON");
        assert_eq!(
            items.len(),
            registry::ITEMS.len(),
            "the registry lost items"
        );

        let mut weapons_seen = 0;
        let mut others_seen = 0;
        for (v, d) in items.iter().zip(registry::ITEMS.iter()) {
            assert_eq!(
                v["key"].as_str(),
                Some(d.key),
                "items came out in a different order"
            );
            match d.kind {
                ItemKind::Weapon(wid) => {
                    let w = defs::def(wid).expect("a weapon item with no weapon def");
                    weapons_seen += 1;
                    assert_eq!(
                        v["auto"].as_bool(),
                        Some(w.is_auto()),
                        "{}: `auto` on the wire disagrees with its WeaponDef",
                        d.key
                    );
                    let cooldown = v["cooldown"].as_f64().unwrap_or(f64::NAN) as f32;
                    assert!(
                        (cooldown - w.cooldown).abs() < 1e-6,
                        "{}: cooldown on the wire is {cooldown}, the def says {}",
                        d.key,
                        w.cooldown
                    );
                }
                _ => {
                    others_seen += 1;
                    // **Absent, not false-and-zero.** A medkit is not a weapon
                    // that happens not to repeat; the question does not apply to
                    // it, and emitting `0` invites a caller to read it as "repeat
                    // as fast as you like".
                    assert!(
                        v.get("auto").is_none() && v.get("cooldown").is_none(),
                        "{} is not a weapon but carries a firing cadence",
                        d.key
                    );
                }
            }
        }
        // The control on the loop itself: a zip that silently matched nothing
        // would satisfy every assertion above.
        assert!(
            weapons_seen > 0 && others_seen > 0,
            "the sweep saw no weapons or no non-weapons"
        );
    }

    /// T22.08A (`R80`, `R83`): **the sandbox forces a flare only on a space map**
    /// and refuses a kind number it does not know (it used to force fog), and
    /// **`flare_points` is the server's ribbon**, `SolarFlare::points_at` on this
    /// core's map — the points the client draws are the points that damage.
    #[test]
    fn a_flare_is_forced_only_on_a_space_map_and_draws_the_servers_points() {
        use game_core::effects::flare::SolarFlare;
        let mut ground = GameCore::new();
        ground.generate(4242, 0, 0);
        ground.force_effect(4, 0.0);
        assert!(
            ground.weather.flare.is_none(),
            "a standard map forced a flare"
        );
        ground.force_effect(200, 0.0);
        assert!(
            ground.weather.forced.is_none(),
            "an unknown kind forced {:?}",
            ground.weather.forced
        );

        let mut space = GameCore::new();
        assert!(space.generate_for_gravity(4242, 0, 0, 0, GravityMode::Space.as_str()));
        space.force_effect(4, 0.0);
        assert!(
            space.weather.flare.is_some(),
            "control: a space map refused the flare"
        );

        let seed: u64 = 0x0123_4567_89ab_cdef;
        let (w, h) = (space.map.mask.w as f32, space.map.mask.h as f32);
        let want: Vec<f32> = SolarFlare::new(seed, w, h)
            .points_at(5.25)
            .iter()
            .flat_map(|p| [p.x, p.y])
            .collect();
        let got = space.flare_points(seed as u32, (seed >> 32) as u32, 5.25);
        assert_eq!(got.len(), want.len());
        assert_eq!(got, want, "flare_points is not the server's ribbon");
        assert_ne!(
            space.flare_points(seed as u32 ^ 1, (seed >> 32) as u32, 5.25),
            want,
            "control: another seed drew the same ribbon"
        );
    }

    /// T22.04C: **`thrust_at` is the thrust of the input the mirror stepped with**,
    /// so a braking body reports the push, not its travel: a player drifting right who
    /// holds LEFT is still moving right and reports `(-JETPACK_THRUST_SIDE, 0)`. The
    /// unequal axes come through (UP + RIGHT is `(SIDE, -UP)`, not a 45° diagonal), and
    /// nothing held reports zero — the control, and the plume's velocity fallback.
    #[test]
    fn thrust_at_is_the_stepped_inputs_thrust_not_the_velocity() {
        use game_core::constants::{JETPACK_THRUST_SIDE, JETPACK_THRUST_UP, PLAYER_H};
        use game_core::player::input::button;
        let mut core = GameCore::new();
        assert!(core.generate_for_gravity(4242, 0, 0, 0, GravityMode::Space.as_str()));
        // Open air, three bodies clear every way.
        let clear = |c: &GameCore, x: f32, y: f32| {
            let pad = 3.0 * PLAYER_H;
            (0..=12).all(|i| {
                (0..=12).all(|j| {
                    let px = x - pad + i as f32 * pad / 6.0;
                    let py = y - pad + j as f32 * pad / 6.0;
                    !game_core::physics::collide::solid_at(&c.map, px as i32, py as i32)
                })
            })
        };
        let (w, h) = (core.map.mask.w as f32, core.map.mask.h as f32);
        let at = (1..20)
            .flat_map(|i| (1..20).map(move |j| (w * i as f32 / 20.0, h * j as f32 / 20.0)))
            .find(|&(x, y)| clear(&core, x, y))
            .expect("open air on the space map");
        core.add_player(1, at.0, at.1);
        core.set_player_state(1, at.0, at.1, 200.0, 0.0, false, 5.0, 100.0, true, 0);
        let mut seq = 0;
        let mut step = |core: &mut GameCore, buttons: u8| {
            seq += 1;
            core.apply_input(1, seq, buttons, 0, SIM_DT);
        };
        for _ in 0..3 {
            step(&mut core, button::LEFT);
        }
        let vx = core.player_state(1)[2];
        assert!(vx > 0.0 && vx < 200.0, "not braking: vx {vx}");
        assert_eq!(
            &*core.thrust_at(1),
            &[-JETPACK_THRUST_SIDE, 0.0],
            "braking (vx {vx}) reported the travel, not the push"
        );
        step(&mut core, button::UP | button::RIGHT);
        assert_eq!(
            &*core.thrust_at(1),
            &[JETPACK_THRUST_SIDE, -JETPACK_THRUST_UP]
        );
        for _ in 0..3 {
            step(&mut core, 0);
        }
        assert_eq!(
            &*core.thrust_at(1),
            &[0.0, 0.0],
            "control: nothing held, a thrust"
        );
    }

    /// T22.08B: **the sandbox's weather hands out the query a match would**, and
    /// the ribbon that query draws is the one the sandbox touches with —
    /// `flare_points` equals its own flare's points and `flare_touches` its own
    /// flare's `touches`, on the ribbon (true while lit) and in the tail (false).
    /// The control: no flare, no query.
    #[test]
    fn the_sandbox_flare_query_draws_and_touches_its_own_flare() {
        use game_core::constants::{EFFECT_TELEGRAPH, PLAYER_H, PLAYER_W};
        let mut core = GameCore::new();
        assert!(core.generate_for_gravity(4242, 0, 0, 0, GravityMode::Space.as_str()));
        let quiet: serde_json::Value =
            serde_json::from_str(&core.weather_step(0.0, SIM_DT)).expect("json");
        // `get`, not `[..]` (T22.08E F3): indexing a missing key is `Null` too, so the
        // old assertion could not tell `"flare":null` from no key — which is what the
        // no-scheduler early return sent, and the client read as `undefined`.
        assert_eq!(
            quiet.get("flare"),
            Some(&serde_json::Value::Null),
            "a flare query with no flare must be a present null: {quiet}"
        );
        core.force_effect(4, 0.0);
        let t = EFFECT_TELEGRAPH + 2.0;
        let w: serde_json::Value =
            serde_json::from_str(&core.weather_step(t, SIM_DT)).expect("json");
        let q = &w["flare"];
        let (lo, hi) = (
            q["lo"].as_u64().expect("lo") as u32,
            q["hi"].as_u64().expect("hi") as u32,
        );
        let elapsed = q["elapsed"].as_f64().expect("elapsed") as f32;
        let (start, own) = core.weather.flare.clone().expect("forced");
        assert!((elapsed - (t - start)).abs() < 1e-6, "elapsed {elapsed}");
        let want: Vec<f32> = own
            .points_at(elapsed)
            .iter()
            .flat_map(|p| [p.x, p.y])
            .collect();
        assert_eq!(
            core.flare_points(lo, hi, elapsed),
            want,
            "the query draws another ribbon"
        );
        let on = own.points_at(elapsed)[10];
        assert!(core.flare_touches(lo, hi, elapsed, on.x, on.y, PLAYER_W, PLAYER_H));
        let tail = EFFECT_TELEGRAPH + game_core::constants::SOLAR_FLARE_DURATION + 1.0;
        let later = own.points_at(tail)[10];
        assert!(
            !core.flare_touches(lo, hi, tail, later.x, later.y, PLAYER_W, PLAYER_H),
            "the ribbon touched in the burn's tail"
        );
    }

    /// **The sandbox's flare burns through the server's rule**: a player held on
    /// the ribbon through the flare's first active second loses health to it; one
    /// held far away, the control, does not.
    #[test]
    fn the_sandbox_flare_burns_whoever_stands_in_it() {
        use game_core::constants::{EFFECT_TELEGRAPH, SOLAR_FLARE_BURN_SECONDS};
        let mut core = GameCore::new();
        // Standard gravity for the players, a space map for the flare: the
        // sandbox forces by the map (R83), and no suit means no softening here.
        assert!(core.generate_for_gravity(4242, 0, 0, 0, GravityMode::Space.as_str()));
        core.gravity = GravityMode::Standard;
        core.add_player(0, 0.0, 0.0);
        core.add_player(1, 0.0, 0.0);
        core.force_effect(4, 0.0);
        let (start, f) = core.weather.flare.clone().expect("forced");
        let before: Vec<f32> = core.players.iter().map(|p| p.stats.health).collect();
        let dt = 1.0 / 60.0;
        let end = EFFECT_TELEGRAPH + SOLAR_FLARE_BURN_SECONDS + 1.0;
        let mut t = 0.0f32;
        while t < end {
            let on = f.points_at(t - start)[f.points_at(0.0).len() / 2];
            let (w, h) = (core.map.mask.w as f32, core.map.mask.h as f32);
            for (i, at) in [(0usize, on), (1usize, Vec2::new(w - on.x, h - on.y))] {
                let p = &mut core.players[i];
                p.body.pos = at;
                p.body.vel = Vec2::ZERO;
                p.stats.iframes_until = 0.0;
            }
            core.weather_step(t, dt);
            t += dt;
        }
        let lost: Vec<f32> = core
            .players
            .iter()
            .zip(&before)
            .map(|(p, b)| b - p.stats.health)
            .collect();
        assert!(
            lost[0] > 0.0,
            "the player on the ribbon lost nothing: {lost:?}"
        );
        assert_eq!(
            lost[1], 0.0,
            "control: the player across the map lost {}",
            lost[1]
        );
    }

    /// §E13's poison in the **sandbox** core, which is a second damage path.
    ///
    /// Written as a plain `#[test]` when the ones below it were not, because
    /// `cargo test -p game-wasm` ran zero of those. T19.19 converted the other
    /// thirteen; every test in this module runs in the gate now.
    ///
    /// The claim is the one `a_shielded_player_takes_half_and_iframes_take_none`
    /// used to make about puddles, asserted where this build actually broke it:
    /// the first version of `weather_step`'s poison was `p.stats.health -=
    /// poison`, fifteen lines under a comment saying every effect damages through
    /// one path so shields and i-frames are handled once.
    ///
    /// Two players and one poison. The unprotected one is the control — without
    /// it, "the invulnerable player took nothing" is satisfied by a poison that
    /// does nothing at all.
    #[test]
    fn the_sandbox_poison_respects_i_frames() {
        let mut core = GameCore::new();
        core.generate(4242, 0, 0);
        core.add_player(0, 200.0, 200.0);
        core.add_player(1, 260.0, 200.0);
        // A scheduler has to exist or `weather_step` returns before the poison
        // block. Forcing an effect is how the sandbox makes one. Fog, not toxic
        // rain: toxic is switched off (T21.39) and fog deals no damage of its own.
        core.force_effect(3, 0.0);

        let before: Vec<f32> = core.players.iter().map(|p| p.stats.health).collect();
        for p in core.players.iter_mut() {
            p.stats.iframes_until = 0.0;
            p.stats.poison(0.0);
        }
        core.players[1].stats.iframes_until = 10.0;

        let dt = 1.0 / 60.0;
        for i in 0..60 {
            core.weather_step(i as f32 * dt, dt);
        }

        let lost: Vec<f32> = core
            .players
            .iter()
            .enumerate()
            .map(|(i, p)| before[i] - p.stats.health)
            .collect();
        assert!(
            lost[0] > 0.0,
            "the unprotected player lost nothing to a second of poison, so the \
             assertion below would hold for a sandbox that never applies it"
        );
        assert_eq!(
            lost[1], 0.0,
            "an invulnerable player lost {} to poison in the sandbox core",
            lost[1]
        );
    }

    #[test]
    fn generate_sets_the_requested_dimensions() {
        let mut core = GameCore::new();
        core.generate(4242, 0, 1);
        assert_eq!(core.width(), 3072);
        assert_eq!(core.height(), 1536);
        core.generate(4242, 0, 2);
        assert_eq!(core.width(), 4096);
        assert_eq!(core.height(), 2048);
    }

    #[test]
    fn mask_byte_len_covers_every_pixel() {
        let mut core = GameCore::new();
        core.generate(1, 0, 0);
        let bits = core.width() as usize * core.height() as usize;
        assert_eq!(core.mask_byte_len(), bits / 8);
        assert!(!core.mask_ptr().is_null());
    }

    #[test]
    fn carving_dirties_chunks_once() {
        let mut core = GameCore::new();
        core.generate(4242, 0, 0);
        let _ = core.take_dirty_chunks();

        // Carve somewhere guaranteed solid: just above the bedrock, mid-map.
        let (x, y) = (core.width() as i32 / 2, core.height() as i32 - 60);
        core.carve(x, y, 40);
        assert!(!core.take_dirty_chunks().is_empty());
        assert!(core.take_dirty_chunks().is_empty(), "the set must clear");
    }

    #[test]
    fn a_carve_actually_removes_terrain() {
        let mut core = GameCore::new();
        core.generate(4242, 0, 0);
        let (x, y) = (core.width() as i32 / 2, core.height() as i32 - 60);
        assert!(core.solid_at(x, y), "precondition: solid before the carve");
        core.carve(x, y, 20);
        assert!(!core.solid_at(x, y));
    }

    #[test]
    fn load_mask_round_trips_through_rle() {
        let mut core = GameCore::new();
        core.generate(4242, 0, 0);
        let (w, h) = (core.width(), core.height());
        let before = core.mask_hash();
        let bytes = core.mask_rle();

        let mut other = GameCore::new();
        assert!(other.load_mask(w, h, &bytes));
        assert_eq!(other.mask_hash(), before);
    }

    /// **`T22.05B`: the client's re-extracted surface is the server's.**
    ///
    /// `load_mask` re-derives `surface_points` from the arriving mask (T19.24),
    /// and on a space map the mask also carries the full-width floor **crust**,
    /// which lies outside the rim in the band R16 makes lethal. So the call has
    /// to be `gen::surface_for`, keyed on the generator the gravity derives
    /// (R15) — an `extract_surface` here would re-admit the crust on the client
    /// only, and the two copies of `surface_points` would be different sets.
    /// That is T19.24's bug in the other direction, and nothing else in the
    /// tree looks at both copies.
    ///
    /// The control is the same round trip under standard gravity, where the two
    /// derivations *are* the same call — without it this passes for a build
    /// that filtered every map.
    #[test]
    fn load_mask_rederives_the_surface_the_way_the_server_did() {
        for (gravity, generator) in [
            ("space", game_core::constants::MapGenerator::Space),
            ("standard", game_core::constants::DEFAULT_MAP_GENERATOR),
        ] {
            let server = game_core::map::generate_with(
                4242,
                game_core::constants::MapScale::Small,
                generator,
            );
            let bytes = game_core::map::rle::encode(&server.mask);

            let mut client = GameCore::new();
            assert!(client.set_gravity(gravity), "{gravity}: unknown spelling");
            // T22.14A B3: told the map's generator, as `applyMapInit` does first.
            assert!(client.set_map_generator(server.meta.generator.to_u8()));
            assert!(client.load_mask(server.mask.w, server.mask.h, &bytes));

            assert_eq!(
                client.map.meta.surface_points, server.meta.surface_points,
                "{gravity}: the client re-extracted a different surface"
            );
        }

        // And the falsification, written out: on a space map the unfiltered
        // extraction really is a different, larger set — so the equality above
        // is a statement about the branch rather than about two calls that
        // could not differ.
        let space = game_core::map::generate_with(
            4242,
            game_core::constants::MapScale::Small,
            game_core::constants::MapGenerator::Space,
        );
        let unfiltered = game_core::map::gen::surface::extract_surface(&space.mask);
        assert!(
            unfiltered.len() > space.meta.surface_points.len(),
            "the control is gone: `extract_surface` no longer differs from the shipped surface"
        );
    }

    #[test]
    fn load_mask_rejects_malformed_bytes_without_panicking() {
        let mut core = GameCore::new();
        assert!(!core.load_mask(256, 256, &[0xFF; 32]));
        assert!(!core.load_mask(256, 256, &[]));
        assert!(!core.load_mask(0, 0, &[0]));
        // A width that is not a multiple of 64 cannot describe a mask.
        assert!(!core.load_mask(100, 100, &[0]));
    }

    /// T22.09A/B: `irradiated` is the sandbox's bit 7 — a flat suit in space,
    /// with the charged suit and the standard mode as its absences' controls —
    /// and the suit never lights `shield_active`, the bubble's input (R26).
    ///
    /// **A player seated in space starts sealed, as on the server** (review
    /// F11). This test used to seat the player first and switch to space
    /// after, and assert "irradiated" — encoding a sandbox that disagreed with
    /// production, where `issue_suit` fills the suit at join.
    #[test]
    fn a_space_seat_is_sealed_a_flat_suit_is_irradiated_and_no_bubble() {
        use game_core::constants::BATTERY_MAX;
        let now = 12.5;
        let battery = |core: &GameCore| {
            core.players
                .iter()
                .find(|p| p.id == 1)
                .map(|p| p.stats.battery)
        };
        let mut flat = GameCore::new();
        flat.generate(4242, 0, 0);
        flat.add_player(1, 500.0, 40.0);
        assert_eq!(battery(&flat), Some(0.0), "a suit was issued outside space");
        assert!(!flat.irradiated(1, now), "irradiated outside space");

        let mut core = GameCore::new();
        assert!(core.generate_for_gravity(4242, 0, 0, 2, "space"));
        core.add_player(1, 500.0, 40.0);
        assert_eq!(
            battery(&core),
            Some(BATTERY_MAX),
            "seated in space unsuited"
        );
        assert!(!core.irradiated(1, now), "a fresh suit let radiation in");
        core.add_battery(1, -BATTERY_MAX);
        assert!(
            core.irradiated(1, now),
            "a flat suit in space is not irradiated"
        );
        core.add_battery(1, BATTERY_MAX);
        assert!(
            !core.irradiated(1, now),
            "a recharged suit let radiation in"
        );
        assert!(
            !core.shield_active(1, now),
            "the suit drew the generator's bubble"
        );
    }

    #[test]
    fn apply_input_moves_a_player() {
        let mut core = GameCore::new();
        core.generate(4242, 0, 0);
        // The sky band is cleared by force_borders, so this is guaranteed air.
        // An arbitrary mid-map point can land inside rock, where move_x is
        // correctly blocked and the test would fail for the wrong reason.
        core.add_player(1, 500.0, 40.0);
        let before = core.player_state(1);

        // Hold RIGHT for a second.
        for seq in 0..60 {
            core.apply_input(1, seq, 1 << 1, 0, SIM_DT);
        }
        let after = core.player_state(1);
        assert_ne!(after[0], before[0], "the player did not move");
    }

    /// T22.14C HIGH-1: **a respawn is `PlayerState::respawn`'s reset** — the jump
    /// buffer, the jetpack (tank from the wire) and the airborne ticks, which no
    /// snapshot carries. The control: a snapshot that keeps a player alive keeps them.
    #[test]
    fn a_respawn_resets_the_jump_the_jetpack_and_the_airborne_ticks() {
        let lit = |core: &mut GameCore| {
            let p = core.players.iter_mut().find(|p| p.id == 2).unwrap();
            p.jet.active = true;
            p.jet.locked_out = true;
            p.jump.buffered_ticks = 3;
            p.body.airborne_ticks = 40;
        };
        let snap = |core: &mut GameCore, alive: bool| {
            core.set_player_state(2, 10.0, 20.0, 0.0, 0.0, true, 1.5, 100.0, alive, 0);
        };
        let mut core = GameCore::new();
        core.add_player(2, 0.0, 0.0);
        lit(&mut core);
        snap(&mut core, true);
        let p = core.players.iter().find(|p| p.id == 2).unwrap();
        assert!(
            p.jet.active && p.jump.buffered_ticks == 3 && p.body.airborne_ticks == 40,
            "control: an alive → alive snapshot reset the movement state"
        );
        snap(&mut core, false);
        lit(&mut core);
        snap(&mut core, true);
        let p = core.players.iter().find(|p| p.id == 2).unwrap();
        assert!(
            !p.jet.active && !p.jet.locked_out,
            "the jetpack lit at death stayed lit"
        );
        assert_eq!(
            p.jump.buffered_ticks, 0,
            "the jump buffer survived the respawn"
        );
        assert_eq!(
            p.body.airborne_ticks, 0,
            "the airborne ticks survived the respawn"
        );
        assert_eq!(p.jet.fuel, 1.5, "the tank is the wire's");
    }

    #[test]
    fn player_state_round_trips() {
        let mut core = GameCore::new();
        core.add_player(2, 0.0, 0.0);
        // `false`, for the same reason the health is not `BASE_HEALTH`:
        // `add_player` seats a player alive, so `true` would be
        // indistinguishable from the argument being dropped (T20.21).
        core.set_player_state(
            2,
            12.5,
            -3.25,
            7.0,
            -1.5,
            true,
            2.5,
            BASE_HEALTH * 0.5,
            false,
            game_core::player::state::MOVE_MOD_BOOTS,
        );
        let s = core.player_state(2);
        assert_eq!(s[0], 12.5);
        assert_eq!(s[1], -3.25);
        assert_eq!(s[2], 7.0);
        assert_eq!(s[3], -1.5);
        assert_eq!(s[4], 1.0);
        assert_eq!(s[5], 2.5);
        // T20.19: health round-trips too, because `apply_input` reads it. A
        // control on the same call: `add_player` seats a player at BASE_HEALTH,
        // so an assertion that only checked "health is a number" would pass
        // against a `set_player_state` that dropped the argument on the floor.
        assert_eq!(s[8], BASE_HEALTH * 0.5, "the snapshot's health was dropped");
        assert_ne!(s[8], BASE_HEALTH);
        // T20.21: and `alive`, for the same reason — `apply_input` reads it too.
        assert_eq!(s[9], 0.0, "the snapshot's `alive` was dropped");
        // T21.02: and the passives, for the same reason again. The control is
        // the same shape as health's — `add_player` seats a player carrying
        // nothing, so an assertion that only checked "it is a number" would pass
        // against a setter that dropped the argument.
        assert_eq!(
            s[10],
            game_core::player::state::MOVE_MOD_BOOTS as f32,
            "the snapshot's move-mod bits were dropped"
        );
        assert_ne!(s[10], 0.0);
    }

    // --------------------------------------------------------------- T20.19

    /// The held run every fixture below walks: a quarter second at the sim rate.
    const WALK_TICKS: u32 = game_core::constants::SIM_HZ / 4;

    /// How much clear, level ground `walk_both_sides` needs, **computed rather
    /// than typed** (T20.21).
    ///
    /// This was `PLAYER_W as i32 + 96` under a comment saying 96 was "the
    /// furthest a full-speed quarter-second of walking can carry it". That
    /// distance is `WALK_SPEED * WALK_TICKS * SIM_DT` = **37.5 px**, not 96, so
    /// the comment described a derivation the code did not perform and
    /// `CLAUDE.md` forbids the bare literal outright. The shelf needs the body
    /// it starts on, the reach, and half a body of clearance past the end —
    /// `build_shelf` stands the player at `x0 + PLAYER_W`, and a body is placed
    /// by its centre.
    fn shelf_run() -> i32 {
        let reach = WALK_SPEED * WALK_TICKS as f32 * SIM_DT;
        PLAYER_W as i32 + reach.ceil() as i32 + PLAYER_W as i32 / 2
    }

    /// Replace the terrain around mid-map with a **level, clear shelf**, and
    /// return where to stand on it.
    ///
    /// **Built rather than found, and that is the point.** This fixture's first
    /// draft walked from the world's own spawn and reported "the fix does not
    /// work": seed 4242 seats player 1 at x = 16, hard against the left wall on
    /// a slope, where holding RIGHT at `WALK_SPEED` climbs and holding it at
    /// `WALK_SPEED * HEALTH_SPEED_MIN` does not move the body one pixel. A
    /// search of the generated mask then found **no** level, clear stretch this
    /// long anywhere on the map, so there is nothing to walk on that is not a
    /// slope. That is T20.20's defect — a fixture that assumes a direction has
    /// room — and the answer here is to give it room explicitly.
    ///
    /// The walking run's terminal velocity is what checks this worked; see the
    /// control in the test below.
    fn build_shelf(w: &mut game_core::world::World) -> (f32, f32) {
        let mut mask = w.map.mask.clone();
        let top = SKY_MARGIN as i32 + PLAYER_H as i32 * 2;
        let x0 = mask.w as i32 / 2;
        let x1 = x0 + shelf_run();
        for y in 0..top {
            mask.clear_run(y, x0 - 1, x1 + 1);
        }
        for y in top..(top + PLAYER_H as i32) {
            mask.set_run(y, x0 - 1, x1 + 1);
        }
        let coarse = CoarseGrid::build(&mask);
        w.map = Map::from_parts(mask, coarse, w.map.meta.clone());
        (x0 as f32 + PLAYER_W, top as f32 - PLAYER_H)
    }

    struct WalkOutcome {
        server_x: f32,
        client_x: f32,
        server_vx: f32,
        client_vx: f32,
        server_health: f32,
        /// What the snapshot actually carried, so a test can assert the wire
        /// truncated rather than assume it (T20.21).
        wire_health: f32,
        /// The vertical pair, for T21.03: flight is a *y* claim, and the two
        /// sides have to agree on it for the same reason they must on x.
        server_y: f32,
        client_y: f32,
    }

    /// A quarter-second of walking, run on **the server** and on the client
    /// mirror from the same body, on the same mask, at the same health.
    ///
    /// The server side is `game_core::world::World` — the type `game-server`
    /// steps — and not a re-statement of the three lines in
    /// `world/mod.rs::apply_inputs`. A copy of those lines would agree with the
    /// mirror forever, including on the day `apply_inputs` stops passing
    /// `speed_multiplier()`.
    fn walk_both_sides(health: f32, buttons: u8) -> WalkOutcome {
        walk_both_sides_wearing(health, buttons, None, false)
    }

    /// The same run, optionally carrying one of M21's passive items.
    ///
    /// **Every case reuses this fixture rather than getting one of its own** —
    /// the value here is that the mirror is fed through
    /// `encode_snapshot`/`decode_snapshot` and `set_player_state`, and a second
    /// copy would be a second chance to skip one of them.
    ///
    /// The item is granted **after** the settle loop, deliberately: T21.03's
    /// wings fly, so a player wearing them at spawn never lands and the settle
    /// assertion below would be measuring the item rather than the shelf.
    fn walk_both_sides_wearing(
        health: f32,
        buttons: u8,
        item: Option<game_core::items::registry::ItemId>,
        // T21.11B. Not an item, so it cannot ride the `item` argument — the
        // server player is mounted directly and the mirror learns it the same
        // way it learns the passives: off the encoded byte.
        mounted: bool,
    ) -> WalkOutcome {
        let mut w = game_core::world::World::new(4242, MapScale::Small);
        w.add_player(1, 0, String::new());
        let (stand_x, stand_y) = build_shelf(&mut w);
        {
            let p = w.player_mut(1).expect("seated");
            p.body.pos = Vec2::new(stand_x, stand_y);
            p.body.vel = Vec2::ZERO;
        }

        // Settle onto the shelf. **An empty input every tick, not no input at
        // all**: `World::step` integrates a player *inside* `apply_input`, so a
        // player with nothing queued does not fall, and the first draft of this
        // fixture waited ten seconds for a landing that could never happen.
        let mut landed = false;
        for seq in 0..120u32 {
            w.queue_input(1, Input::new(seq, 0, 0));
            w.step(SIM_DT);
            if w.player(1).map(|p| p.body.grounded).unwrap_or(false) {
                landed = true;
                break;
            }
        }
        assert!(landed, "the server player never landed on the shelf");
        if let Some(id) = item {
            game_core::world::give(&mut w, 1, id, 1);
        }
        if mounted {
            // Straight onto the state the mount rule owns, because this fixture
            // is about the **wire**, not about the stand-still timer — that is
            // `world::mount_wiring`'s job, and re-driving it here would make a
            // failure ambiguous between the two.
            //
            // **But a platform has to be under them** (T21.14). Mounting now
            // ends the moment the rider is not `underfoot` their platform —
            // that is the fix for being knocked clear and still firing the gun
            // — so setting `mounted` on a player standing on this fixture's own
            // shelf described a state the simulation immediately undoes, and the
            // mirror never saw a mounted tick. The platform goes where they are.
            let feet = {
                let p = w.player(1).expect("seated");
                game_core::math::Point::new(
                    p.body.pos.x.round() as i32,
                    (p.body.pos.y + game_core::constants::PLAYER_H / 2.0).round() as i32,
                )
            };
            w.map.meta.gun_platforms = vec![game_core::map::meta::GunPlatform { id: 0, pos: feet }];
            w.player_mut(1).expect("seated").mount.mounted = Some(0);
        }

        let mut core = GameCore::new();
        assert!(
            core.load_mask(w.map.mask.w, w.map.mask.h, &rle::encode(&w.map.mask)),
            "the mirror would not take the server's mask"
        );

        w.player_mut(1).expect("seated").health = health;

        // **The mirror's health comes through the real wire** (T20.21).
        //
        // T20.19's version passed `health` straight into `set_player_state`, so
        // both sides held the same `f32` and the fixture could not see
        // `codec.rs`'s `p.health.clamp(0.0, HEALTH_CAP) as u8` — a truncation,
        // not a round. That is why a permanent one-health desync survived a task
        // whose whole subject was health. Encoding and decoding here costs two
        // calls and makes the fixture model what production does; re-implementing
        // `as u8` in the test would prove the test's arithmetic instead of the
        // codec's.
        let bytes = game_server::codec::encode_snapshot(&w, 1, 0);
        let snap = game_server::codec::decode_snapshot(&bytes).expect("the server's own bytes");
        let wire = snap
            .players
            .iter()
            .find(|p| p.id == 1)
            .expect("player 1 is in the snapshot");
        let wire_health = wire.health as f32;
        let wire_alive = wire.flags & 1 != 0;
        // T21.02, and **off the wire for the same reason health is**. Taking it
        // from `w.player(1).move_mod_bits()` would hand both sides the same
        // value by construction and the fixture could never see the encoder or
        // the decoder — which is precisely how a permanent one-health desync
        // survived a task whose whole subject was health.
        let wire_mods = wire.move_mods;

        let p = w.player(1).expect("seated");
        let (pos, vel, grounded, fuel) = (p.body.pos, p.body.vel, p.body.grounded, p.jetpack.fuel);
        core.add_player(1, pos.x, pos.y);
        // The production route: this is what `prediction.ts::reconcile` calls.
        core.set_player_state(
            1,
            pos.x,
            pos.y,
            vel.x,
            vel.y,
            grounded,
            fuel,
            wire_health,
            wire_alive,
            wire_mods,
        );

        for seq in 0..WALK_TICKS {
            w.queue_input(1, Input::new(seq, buttons, 0));
            w.step(SIM_DT);
            core.apply_input(1, seq, buttons, 0, SIM_DT);
        }

        let sp = w.player(1).expect("seated");
        let c = core.player_state(1);
        WalkOutcome {
            server_x: sp.body.pos.x,
            client_x: c[0],
            server_vx: sp.body.vel.x,
            client_vx: c[2],
            server_health: sp.health,
            wire_health,
            server_y: sp.body.pos.y,
            client_y: c[1],
        }
    }

    /// **Prediction agrees with the server across `Playing → Ended`** (T21.30).
    ///
    /// Reported from play: after "Round over" the local body walked on screen.
    /// The server and the mirror hold RIGHT through the transition from the same
    /// body on the same mask; told the phase, the mirror must end where the
    /// server does. **The control is the mirror not told**: it must end
    /// somewhere else, or this test cannot see the phase at all.
    fn hold_right_across_the_round_ending(tell_the_mirror: bool) -> (f32, f32, f32) {
        use game_core::world::RoundPhase;
        let mut w = game_core::world::World::new(4242, MapScale::Small);
        w.set_phase(RoundPhase::Playing);
        w.add_player(1, 0, String::new());
        let (stand_x, stand_y) = build_shelf(&mut w);
        {
            let p = w.player_mut(1).expect("seated");
            p.body.pos = Vec2::new(stand_x, stand_y);
            p.body.vel = Vec2::ZERO;
        }
        for seq in 0..120u32 {
            w.queue_input(1, Input::new(seq, 0, 0));
            w.step(SIM_DT);
            if w.player(1).is_some_and(|p| p.body.grounded) {
                break;
            }
        }
        let mut core = GameCore::new();
        assert!(core.load_mask(w.map.mask.w, w.map.mask.h, &rle::encode(&w.map.mask)));
        let p = w.player(1).expect("seated");
        assert!(
            p.body.grounded,
            "the server player never landed on the shelf"
        );
        let start_x = p.body.pos.x;
        core.add_player(1, p.body.pos.x, p.body.pos.y);
        core.set_player_state(
            1,
            p.body.pos.x,
            p.body.pos.y,
            p.body.vel.x,
            p.body.vel.y,
            p.body.grounded,
            p.jetpack.fuel,
            p.health,
            p.alive,
            p.move_mod_bits(),
        );
        if tell_the_mirror {
            assert!(core.set_phase("playing"));
        }
        let mut seq = 1000u32;
        for half in 0..2 {
            if half == 1 {
                w.set_phase(RoundPhase::Ended);
                if tell_the_mirror {
                    assert!(core.set_phase("ended"));
                }
            }
            for _ in 0..WALK_TICKS {
                seq += 1;
                w.queue_input(
                    1,
                    Input::new(seq, game_core::player::input::button::RIGHT, 0),
                );
                w.step(SIM_DT);
                core.apply_input(1, seq, game_core::player::input::button::RIGHT, 0, SIM_DT);
            }
        }
        (
            start_x,
            w.player(1).expect("seated").body.pos.x,
            core.player_state(1)[0],
        )
    }

    /// **Prediction agrees with the server in space** (T22.03).
    ///
    /// Same shelf, same seed, same held buttons; the only difference is the
    /// match's gravity mode, and the mirror can only learn it from
    /// `GameCore::set_gravity` — the per-match constant, not a wire bit.
    /// **`moveMods` could not carry it**: that byte is inventory-derived, and a
    /// match setting riding it would be a stored second answer to a question
    /// `World::gravity` already answers.
    ///
    /// **Why this mode is the one where mispredicting costs most, and it is not
    /// a guess — it is the difference between the two arms below.** Under
    /// gravity a velocity error is *pulled back*: `apply_horizontal` approaches
    /// a target, so two sides that disagree about `vel.x` converge within about
    /// a sixteenth of a second whatever the error was, and the position error it
    /// caused is bounded. In space nothing approaches anything. A velocity error
    /// `dv` persists exactly, so the position error grows as `dv * t` for as
    /// long as both bodies are still moving — which is why the untold control
    /// below does not merely differ, it *grows* apart, until
    /// `prediction.ts`'s `SNAP_PX` hard-snaps and that reads on screen as
    /// teleporting rather than as rubber-banding.
    ///
    /// **"Without bound" is what an earlier version of this comment said, and
    /// it is false — measured.** Run this fixture at 15, 30, 60, 120, 240, 480
    /// and 960 ticks and the untold gap goes
    /// **46.2 → 45.7 → 97.8 → 469.3 → 676.1 → 676.1 → 676.1 px**: it grows by a
    /// factor of fourteen and then stops dead, because both bodies come to rest
    /// against world clamps — the server at the right wall and the sky, the
    /// mirror elsewhere. The growth is unbounded in the *model* and bounded by
    /// the *arena*, which is a different sentence and the true one. The
    /// assertion below only claims the gap exceeds the epsilon, so it was sound
    /// either way; the prose was not.
    ///
    /// **`JUMP | RIGHT`, held.** A jump is the one gesture whose two arms are
    /// unmistakable: under gravity it arcs and lands, and in space the player
    /// leaves the shelf at `JUMP_VELOCITY` and never comes back. RIGHT then
    /// thrusts them sideways once they are floating, so both axes are live.
    fn hold_jump_and_right_in_space(tell_the_mirror: bool) -> (f32, f32, f32, f32) {
        use game_core::constants::GravityMode;
        use game_core::world::RoundPhase;
        let buttons =
            game_core::player::input::button::JUMP | game_core::player::input::button::RIGHT;

        let mut w = game_core::world::World::new(4242, MapScale::Small);
        w.set_phase(RoundPhase::Playing);
        w.add_player(1, 0, String::new());
        let (stand_x, stand_y) = build_shelf(&mut w);
        {
            let p = w.player_mut(1).expect("seated");
            p.body.pos = Vec2::new(stand_x, stand_y);
            p.body.vel = Vec2::ZERO;
        }
        // Settle under ordinary gravity: with none there is nothing to land the
        // player *with*, so the mode is switched after they are standing —
        // which also makes the shelf, the seed and the start position identical
        // to every other fixture in this module.
        for seq in 0..120u32 {
            w.queue_input(1, Input::new(seq, 0, 0));
            w.step(SIM_DT);
            if w.player(1).is_some_and(|p| p.body.grounded) {
                break;
            }
        }
        assert!(
            w.player(1).is_some_and(|p| p.body.grounded),
            "the server player never landed on the shelf"
        );
        w.gravity = GravityMode::Space;

        let mut core = GameCore::new();
        assert!(core.load_mask(w.map.mask.w, w.map.mask.h, &rle::encode(&w.map.mask)));

        // Through the real wire, for the reason `walk_both_sides_wearing` does
        // it: `set_player_state` is what `prediction.ts::reconcile` calls, and
        // a fixture that handed both sides the same `f32` could never see the
        // codec.
        let bytes = game_server::codec::encode_snapshot(&w, 1, 0);
        let snap = game_server::codec::decode_snapshot(&bytes).expect("the server's own bytes");
        let wire = snap
            .players
            .iter()
            .find(|p| p.id == 1)
            .expect("player 1 is in the snapshot");
        let (wire_health, wire_alive, wire_mods) =
            (wire.health as f32, wire.flags & 1 != 0, wire.move_mods);

        let p = w.player(1).expect("seated");
        core.add_player(1, p.body.pos.x, p.body.pos.y);
        core.set_player_state(
            1,
            p.body.pos.x,
            p.body.pos.y,
            p.body.vel.x,
            p.body.vel.y,
            p.body.grounded,
            p.jetpack.fuel,
            wire_health,
            wire_alive,
            wire_mods,
        );
        assert!(core.set_phase("playing"));
        if tell_the_mirror {
            assert!(core.set_gravity(GravityMode::Space.as_str()));
        }

        let mut seq = 1000u32;
        // Four times `WALK_TICKS`: long enough for the gravity arm to complete
        // an arc and land, which is the whole shape the space arm does not have.
        for _ in 0..(WALK_TICKS * 4) {
            seq += 1;
            w.queue_input(1, Input::new(seq, buttons, 0));
            w.step(SIM_DT);
            core.apply_input(1, seq, buttons, 0, SIM_DT);
        }
        let sp = w.player(1).expect("seated");
        let c = core.player_state(1);
        (sp.body.pos.x, sp.body.pos.y, c[0], c[1])
    }

    /// The mispredicted velocity `diverge_then_reconcile` injects, px/s.
    ///
    /// Big enough that `RECONCILE_EPSILON_PX` cannot swallow it and small enough
    /// that the drift stays clear of the arena's walls; it is the shape of a
    /// knockback, not a knockback constant, so it is local to the fixture.
    const IMPULSE: f32 = 240.0;

    /// What one run of [`diverge_then_reconcile`] measured, in pixels.
    struct Reconciled {
        /// Server-against-mirror gap halfway through the drift, and at the end.
        apart_early: f32,
        apart_late: f32,
        /// The gap immediately after `set_player_state` — the mirror's
        /// `reconcile` entry point.
        apart_after: f32,
        /// And after a further second of identical inputs on both sides.
        apart_after_a_second: f32,
        /// **The velocity error itself**, `server.vel.x - mirror.vel.x`, at the
        /// end of the drift. This is the quantity that decides whether a
        /// misprediction self-corrects, and the position gap is only its
        /// integral.
        vel_error_late: f32,
    }

    /// **A mispredicted impulse, and the reconcile that has to undo it.**
    ///
    /// `T22.03`'s test list asked for *"prediction and server agree after a
    /// mispredicted impulse"* and what shipped ran both sides from identical
    /// state with identical inputs — nothing was ever mispredicted, so
    /// `set_player_state` was never exercised in space at all. This is that
    /// test: a knockback applied to the **server only**, exactly as a rocket the
    /// client has not seen yet would arrive, and then the wire correction.
    ///
    /// The impulse is written straight onto `body.vel` rather than fired from a
    /// weapon on purpose — what is under test is the mirror's response to *an
    /// authoritative velocity it did not predict*, and a weapon would add a
    /// projectile's own prediction question on top of it.
    ///
    /// `carry_velocity` is the control knob: `false` reconciles **position
    /// only**, keeping the mirror's own `vel`, which is what a correction that
    /// dropped the velocity fields would do.
    fn diverge_then_reconcile(space: bool, carry_velocity: bool) -> Reconciled {
        use game_core::constants::GravityMode;
        use game_core::world::RoundPhase;

        // Two seconds. `AIR_DRAG` is 120 px/s², so under standard gravity it
        // needs that long to bleed a 240 px/s error on its own — and a shorter
        // window would report "space does not damp" about a control that had
        // not finished damping either.
        const DRIFT_TICKS: u32 = game_core::constants::SIM_HZ * 2;

        let mut w = game_core::world::World::new(4242, MapScale::Small);
        w.set_phase(RoundPhase::Playing);
        w.add_player(1, 0, String::new());
        let (stand_x, stand_y) = build_shelf(&mut w);
        {
            let p = w.player_mut(1).expect("seated");
            p.body.pos = Vec2::new(stand_x, stand_y);
            p.body.vel = Vec2::ZERO;
        }
        for seq in 0..120u32 {
            w.queue_input(1, Input::new(seq, 0, 0));
            w.step(SIM_DT);
            if w.player(1).is_some_and(|p| p.body.grounded) {
                break;
            }
        }
        assert!(
            w.player(1).is_some_and(|p| p.body.grounded),
            "the server player never landed on the shelf"
        );
        let mode = if space {
            GravityMode::Space
        } else {
            GravityMode::Standard
        };
        w.gravity = mode;

        let mut core = GameCore::new();
        assert!(core.load_mask(w.map.mask.w, w.map.mask.h, &rle::encode(&w.map.mask)));
        assert!(core.set_phase("playing"));
        assert!(core.set_gravity(mode.as_str()));

        // Both sides start from the server's state, **through the real wire**,
        // for the reason `walk_both_sides_wearing` does it: `set_player_state`
        // is what `prediction.ts::reconcile` calls, and a fixture that handed
        // both sides the same `f32` could never see the codec.
        let seed = |core: &mut GameCore, w: &game_core::world::World, vel: Option<(f32, f32)>| {
            let bytes = game_server::codec::encode_snapshot(w, 1, 0);
            let snap = game_server::codec::decode_snapshot(&bytes).expect("the server's own bytes");
            let wire = snap
                .players
                .iter()
                .find(|p| p.id == 1)
                .expect("player 1 is in the snapshot");
            let p = w.player(1).expect("seated");
            let (vx, vy) = vel.unwrap_or((p.body.vel.x, p.body.vel.y));
            core.set_player_state(
                1,
                p.body.pos.x,
                p.body.pos.y,
                vx,
                vy,
                p.body.grounded,
                p.jetpack.fuel,
                wire.health as f32,
                wire.flags & 1 != 0,
                wire.move_mods,
            );
        };
        {
            let p = w.player(1).expect("seated");
            core.add_player(1, p.body.pos.x, p.body.pos.y);
        }
        seed(&mut core, &w, None);

        let gap = |w: &game_core::world::World, core: &GameCore| {
            let sp = w.player(1).expect("seated");
            let c = core.player_state(1);
            ((sp.body.pos.x - c[0]).powi(2) + (sp.body.pos.y - c[1]).powi(2)).sqrt()
        };

        // Get both sides off the shelf with a jump they **both** predict, so
        // the only disagreement below is the impulse.
        let mut seq = 1000u32;
        let jump = game_core::player::input::button::JUMP;
        for t in 0..WALK_TICKS {
            seq += 1;
            let buttons = if t == 0 { jump } else { 0 };
            w.queue_input(1, Input::new(seq, buttons, 0));
            w.step(SIM_DT);
            core.apply_input(1, seq, buttons, 0, SIM_DT);
        }
        let agreed = gap(&w, &core);
        assert!(
            agreed <= RECONCILE_EPSILON_PX,
            "precondition: the two sides were already {agreed:.1} px apart \
             before the impulse, so nothing below is about the impulse"
        );

        // **The misprediction.** Server only.
        w.player_mut(1).expect("seated").body.vel.x += IMPULSE;

        let mut apart_early = 0.0;
        for t in 0..DRIFT_TICKS {
            seq += 1;
            w.queue_input(1, Input::new(seq, 0, 0));
            w.step(SIM_DT);
            core.apply_input(1, seq, 0, 0, SIM_DT);
            if t + 1 == DRIFT_TICKS / 2 {
                apart_early = gap(&w, &core);
            }
        }
        let apart_late = gap(&w, &core);
        let vel_error_late = {
            let sp = w.player(1).expect("seated");
            sp.body.vel.x - core.player_state(1)[2]
        };

        // **Reconcile.**
        let keep = if carry_velocity {
            None
        } else {
            let c = core.player_state(1);
            Some((c[2], c[3]))
        };
        seed(&mut core, &w, keep);
        let apart_after = gap(&w, &core);

        for _ in 0..game_core::constants::SIM_HZ {
            seq += 1;
            w.queue_input(1, Input::new(seq, 0, 0));
            w.step(SIM_DT);
            core.apply_input(1, seq, 0, 0, SIM_DT);
        }

        Reconciled {
            apart_early,
            apart_late,
            apart_after,
            apart_after_a_second: gap(&w, &core),
            vel_error_late,
        }
    }

    /// **Prediction and the server agree again after a mispredicted impulse —
    /// and in space nothing but the reconcile makes that happen** (T22.03).
    ///
    /// Four claims, each red on its own:
    ///
    ///  1. **The error grows.** In space a mispredicted `dv` is never damped, so
    ///     the gap at the end of the drift is larger than at its midpoint. The
    ///     standard-gravity control is the same impulse under `AIR_DRAG`, where
    ///     the velocity error is bled away and the gap stops growing — that is
    ///     the difference the task file called *"the mode where a misprediction
    ///     never self-corrects"*, measured instead of asserted in prose.
    ///  2. **The reconcile closes it**, to inside `RECONCILE_EPSILON_PX`.
    ///  3. **And it stays closed** through a further second of identical inputs.
    ///  4. **Because the correction carries velocity, not just position.** The
    ///     control reconciles position and keeps the mirror's own `vel`; a
    ///     second later it is apart again by more than the epsilon, because
    ///     nothing in this mode bleeds the difference. Under gravity that
    ///     control would quietly pass, which is exactly why it belongs here.
    ///
    /// Measured, px and px/s, over the two-second drift:
    ///
    /// | run | gap at 1 s | gap at 2 s | `dv` at 2 s | after reconcile | +1 s |
    /// |---|---|---|---|---|---|
    /// | space | 240.0 | 480.0 | **240.0** | 0.00 | 0.00 |
    /// | standard-gravity control | 207.4 | 207.4 | **0.0** | 0.00 | 0.00 |
    /// | space, position-only reconcile | 240.0 | 480.0 | 240.0 | 0.00 | **240.00** |
    ///
    /// The space gap is exactly `IMPULSE * t` — 240 px after one second, 480
    /// after two — which is the *"grows as `dv * t`"* sentence the neighbouring
    /// fixture's doc makes, measured rather than reasoned. The control's gap
    /// does **not** shrink; it plateaus, because a position error that has
    /// already happened is not undone by the velocity error going away. That is
    /// why claim 1 is asserted on `dv` and not on the gap.
    #[test]
    fn a_mispredicted_impulse_in_space_survives_until_the_reconcile() {
        let space = diverge_then_reconcile(true, true);
        let ground = diverge_then_reconcile(false, true);
        let no_velocity = diverge_then_reconcile(true, false);

        // **The velocity error is the thing that self-corrects or does not**;
        // the position gap is its integral, and under gravity that integral
        // keeps growing for a while after the error itself has gone. Asserting
        // on the gap alone would report the wrong answer for the control —
        // measured, it grows 131.7 px → 207.4 px there.
        assert!(
            (space.vel_error_late - IMPULSE).abs() < 1.0,
            "space: two seconds after a {IMPULSE} px/s impulse the two sides \
             still disagree about vel.x by {:.1} px/s — it should be the whole \
             impulse, undamped and unrecovered",
            space.vel_error_late
        );
        assert!(
            ground.vel_error_late.abs() < IMPULSE / 10.0,
            "control: under standard gravity the same impulse left a {:.1} px/s \
             velocity error after two seconds, so 'space never damps' is a \
             claim about arithmetic rather than about the mode",
            ground.vel_error_late
        );
        assert!(
            space.apart_late > space.apart_early * 1.5,
            "space: the gap went {:.1} px → {:.1} px over the drift, so the \
             undamped velocity error above is not actually carrying the two \
             sides apart",
            space.apart_early,
            space.apart_late
        );
        assert!(
            space.apart_late > RECONCILE_EPSILON_PX * 10.0,
            "space: the impulse only moved the two sides {:.1} px apart, which \
             is not a misprediction worth reconciling",
            space.apart_late
        );

        assert!(
            space.apart_after <= RECONCILE_EPSILON_PX,
            "space: the reconcile left the mirror {:.1} px from the server, \
             against an epsilon of {RECONCILE_EPSILON_PX}",
            space.apart_after
        );
        assert!(
            space.apart_after_a_second <= RECONCILE_EPSILON_PX,
            "space: a second after the reconcile the mirror is {:.1} px from \
             the server — the correction did not hold",
            space.apart_after_a_second
        );
        assert!(
            no_velocity.apart_after <= RECONCILE_EPSILON_PX,
            "control precondition: the position-only reconcile did not even \
             close the gap ({:.1} px), so what it fails a second later says \
             nothing about velocity",
            no_velocity.apart_after
        );
        assert!(
            no_velocity.apart_after_a_second > RECONCILE_EPSILON_PX,
            "control: a reconcile that corrected position and kept the mirror's \
             own velocity still agreed a second later ({:.1} px). Nothing in \
             this fixture can then see `set_player_state` carrying velocity, \
             which is the clause that matters in a mode with no damping.",
            no_velocity.apart_after_a_second
        );
    }

    #[test]
    fn the_client_predicts_a_space_player_where_the_server_puts_them() {
        let (server_x, server_y, client_x, client_y) = hold_jump_and_right_in_space(true);

        // The control: space actually did something. The same fixture under
        // standard gravity lands the player back on the shelf, so a run that
        // ends far above it is the mode and not the fixture.
        let (_, standard_y, _, _) = {
            use game_core::constants::GravityMode;
            use game_core::world::RoundPhase;
            let buttons =
                game_core::player::input::button::JUMP | game_core::player::input::button::RIGHT;
            let mut w = game_core::world::World::new(4242, MapScale::Small);
            w.set_phase(RoundPhase::Playing);
            w.add_player(1, 0, String::new());
            let (stand_x, stand_y) = build_shelf(&mut w);
            {
                let p = w.player_mut(1).expect("seated");
                p.body.pos = Vec2::new(stand_x, stand_y);
                p.body.vel = Vec2::ZERO;
            }
            for seq in 0..120u32 {
                w.queue_input(1, Input::new(seq, 0, 0));
                w.step(SIM_DT);
                if w.player(1).is_some_and(|p| p.body.grounded) {
                    break;
                }
            }
            assert_eq!(w.gravity, GravityMode::Standard);
            let mut seq = 1000u32;
            for _ in 0..(WALK_TICKS * 4) {
                seq += 1;
                w.queue_input(1, Input::new(seq, buttons, 0));
                w.step(SIM_DT);
            }
            let sp = w.player(1).expect("seated");
            (sp.body.pos.x, sp.body.pos.y, 0.0f32, 0.0f32)
        };
        assert!(
            server_y < standard_y - PLAYER_H,
            "the space run ended at y {server_y:.1} against a standard run's \
             {standard_y:.1} — the mode changed nothing on the server, so the \
             agreement below is about an ordinary jump"
        );

        // The claim, on both axes: RIGHT thrusts sideways while floating, so a
        // mirror that got only the vertical half right would still fail.
        assert!(
            (server_y - client_y).abs() <= RECONCILE_EPSILON_PX
                && (server_x - client_x).abs() <= RECONCILE_EPSILON_PX,
            "the mirror predicted a space player at ({client_x:.1}, {client_y:.1}) \
             where the server put them at ({server_x:.1}, {server_y:.1}), against \
             an epsilon of {RECONCILE_EPSILON_PX}"
        );

        // **The control that matters: a mirror never told the mode.** It must
        // be wrong by far more than the epsilon, or nothing here can see
        // `set_gravity` at all.
        let (server_x, server_y, untold_x, untold_y) = hold_jump_and_right_in_space(false);
        let apart = ((server_y - untold_y).powi(2) + (server_x - untold_x).powi(2)).sqrt();
        assert!(
            apart > RECONCILE_EPSILON_PX,
            "a mirror never told the gravity mode still agreed — \
             ({untold_x:.1}, {untold_y:.1}) against ({server_x:.1}, {server_y:.1}), \
             {apart:.1} px apart"
        );
    }

    // ---- T22.11C: the wire's rocks reach the mirror ----------------------

    /// The seed the space fixtures below build their map from.
    const FIELD_SEED: u64 = 4242;

    /// How long a body is left to fall through the field.
    ///
    /// **One second, and the bound is measured rather than chosen.** At two the
    /// fixture's body reaches a rock and stops — R1's contact rule — and a run
    /// that ends against terrain is measuring the collision, not the well. At one
    /// it is 118 px from where it started and still accelerating.
    const DRIFT_TICKS: u32 = game_core::constants::SIM_HZ;

    /// `worldMirror.ts::applyMapInit`'s call, in Rust.
    ///
    /// The TypeScript wrapper splits the decoded `MapAsteroid[]` into four typed
    /// arrays exactly like this; keeping the split in one place here means the
    /// fixtures below exercise the same shape the client does.
    fn install_asteroids(core: &mut GameCore, rocks: &[game_core::map::meta::Asteroid]) {
        let xs: Vec<i32> = rocks.iter().map(|a| a.x).collect();
        let ys: Vec<i32> = rocks.iter().map(|a| a.y).collect();
        let rs: Vec<i32> = rocks.iter().map(|a| a.r).collect();
        let levels: Vec<u8> = rocks.iter().map(|a| a.level).collect();
        core.set_asteroids(&xs, &ys, &rs, &levels);
    }

    /// A space `World`, and the `GameCore` a networked client holds after
    /// `lobby_state` and `map_init` — **through the real codec**, never a
    /// hand-built list.
    ///
    /// `tell_the_mirror` is the control knob: `false` is the client this project
    /// shipped before `T22.11C`, which decoded the asteroid section and had
    /// nowhere to put it (R49).
    fn space_world_and_mirror(tell_the_mirror: bool) -> (game_core::world::World, GameCore) {
        space_world_and_mirror_at(FIELD_SEED, MapScale::Small, tell_the_mirror)
    }

    /// [`space_world_and_mirror`] on another seed and scale (T22.03G's traced pocket).
    fn space_world_and_mirror_at(
        seed: u64,
        scale: MapScale,
        tell_the_mirror: bool,
    ) -> (game_core::world::World, GameCore) {
        use game_core::world::RoundPhase;
        let mut w = game_core::world::World::with_gravity(
            seed,
            scale,
            0,
            game_core::constants::DEFAULT_MAP_GENERATOR,
            GravityMode::Space,
        );
        w.set_phase(RoundPhase::Playing);
        assert!(
            !w.map.meta.asteroids.is_empty(),
            "the fixture map has no rocks, so every assertion below is vacuous"
        );

        let bytes = game_server::codec::encode_map_init(&w.map);
        let parts =
            game_server::codec::decode_map_init_parts(&bytes).expect("the server's own bytes");

        let mut core = GameCore::new();
        // The order a real client sees: gravity off `lobby_state` first, then the
        // map. `map_init_before_lobby_state_still_predicts_the_field` runs the
        // other one.
        assert!(core.set_gravity(GravityMode::Space.as_str()));
        assert!(core.set_map_generator(parts.generator.to_u8()));
        assert!(core.load_mask(
            parts.mask.w,
            parts.mask.h,
            &game_core::map::rle::encode(&parts.mask)
        ));
        let pad_xs: Vec<i32> = parts.teleport_pads.iter().map(|p| p.pos.x).collect();
        let pad_ys: Vec<i32> = parts.teleport_pads.iter().map(|p| p.pos.y).collect();
        core.set_teleport_pads(&pad_xs, &pad_ys);
        let plat_xs: Vec<i32> = parts.gun_platforms.iter().map(|g| g.pos.x).collect();
        let plat_ys: Vec<i32> = parts.gun_platforms.iter().map(|g| g.pos.y).collect();
        core.set_gun_platforms(&plat_xs, &plat_ys);
        assert!(core.set_phase("playing"));
        if tell_the_mirror {
            install_asteroids(&mut core, &parts.asteroids);
        }
        (w, core)
    }

    /// A feet line inside the strongest rock's well, in open space.
    ///
    /// **The smallest offset that fits, not a round number**: the pull falls off
    /// linearly to zero at `well_reach`, so a point chosen near the edge of the
    /// reach accelerates at almost nothing and a fixture built on one would
    /// report "the two sides agree" about a body that never moved.
    ///
    /// **The direction the body then goes is not this rock's**, and the fixture
    /// does not pretend otherwise: at the point this returns on the seed below,
    /// the summed field is `(-145, +448)` px/s² — the chosen rock pulls left and
    /// two others pull down harder. `field_at` sums *every* rock, which is the
    /// whole of R11, so the caller reads the direction off the field rather than
    /// off the geometry.
    fn start_inside_a_well(w: &game_core::world::World) -> (game_core::map::meta::Asteroid, Vec2) {
        use game_core::math::Point;
        let rock = *w
            .map
            .meta
            .asteroids
            .iter()
            .max_by_key(|a| a.level)
            .expect("checked non-empty by the caller");
        let reach = game_core::world::attractors::well_reach(rock.level);
        let mut d = rock.r as f32 + PLAYER_H;
        while d < reach {
            let p = Point::new(rock.x + d as i32, rock.y);
            if w.map.body_fits_at(p) {
                return (rock, Vec2::new(p.x as f32, p.y as f32));
            }
            d += 2.0;
        }
        panic!(
            "no open-space start inside level-{} rock ({}, {})'s reach of {reach:.0} px",
            rock.level, rock.x, rock.y
        );
    }

    /// What one run of [`drift_in_a_well`] measured.
    struct WellDrift {
        /// Where the body started, and where each side ended.
        start: Vec2,
        server: Vec2,
        mirror: Vec2,
        /// The summed field at `start`, px/s² — the direction the body should go.
        field: Vec2,
    }

    /// Let a body fall toward a rock on both sides, holding **no** buttons.
    ///
    /// No input on purpose: in space nothing else touches an ungrounded body, so
    /// every pixel of the move below is the field. A held direction would put the
    /// walk rule's arithmetic in the middle of the one claim this fixture makes.
    fn drift_in_a_well(tell_the_mirror: bool) -> WellDrift {
        let (mut w, mut core) = space_world_and_mirror(tell_the_mirror);
        let (_, start) = start_inside_a_well(&w);
        // Read off the **server's** map, which is the one that has the rocks in
        // both arms — the untold mirror's field is zero by construction and would
        // make this a direction of `(0, 0)`.
        let field = game_core::world::attractors::field_at(
            game_core::world::attractors::asteroid_attractors(&w.map),
            start,
        );

        w.add_player(1, 0, String::new());
        {
            let p = w.player_mut(1).expect("seated");
            p.body.pos = start;
            p.body.vel = Vec2::ZERO;
        }

        // Through the real wire, the reason `hold_jump_and_right_in_space` gives:
        // `set_player_state` is what `prediction.ts::reconcile` calls, and a
        // fixture handing both sides the same `f32` could never see the codec.
        let bytes = game_server::codec::encode_snapshot(&w, 1, 0);
        let snap = game_server::codec::decode_snapshot(&bytes).expect("the server's own bytes");
        let wire = snap
            .players
            .iter()
            .find(|p| p.id == 1)
            .expect("player 1 is in the snapshot");
        let (wire_health, wire_alive, wire_mods) =
            (wire.health as f32, wire.flags & 1 != 0, wire.move_mods);
        let p = w.player(1).expect("seated");
        core.add_player(1, p.body.pos.x, p.body.pos.y);
        core.set_player_state(
            1,
            p.body.pos.x,
            p.body.pos.y,
            p.body.vel.x,
            p.body.vel.y,
            p.body.grounded,
            p.jetpack.fuel,
            wire_health,
            wire_alive,
            wire_mods,
        );

        let mut seq = 1000u32;
        for _ in 0..DRIFT_TICKS {
            seq += 1;
            w.queue_input(1, Input::new(seq, 0, 0));
            w.step(SIM_DT);
            core.apply_input(1, seq, 0, 0, SIM_DT);
        }
        let sp = w.player(1).expect("seated");
        let c = core.player_state(1);
        WellDrift {
            start,
            server: sp.body.pos,
            mirror: Vec2::new(c[0], c[1]),
            field,
        }
    }

    /// **`M22-RULINGS` R49 and R36 — the wire's rocks reach the mirror, and the
    /// hash R36 built is what says so.**
    ///
    /// Red before green: with `GameCore::set_asteroids` absent there was nowhere
    /// for `decode_map_init_parts`' asteroid section to go, so a networked
    /// client's `map.meta.asteroids` was **empty** — not stale, empty — and this
    /// assertion fails on a table of length 0 against the server's.
    ///
    /// Asserted through `World::state_hash` rather than by comparing the two
    /// `Vec`s, because that is R36's instrument and it covers all four fields the
    /// field summation reads — `level`, `x`, `y` and `r`. A rock installed at the
    /// wrong place, the wrong size or the wrong level is one the determinism guard
    /// this milestone rests on can already see, so this test inherits that reach
    /// instead of picking a tolerance of its own.
    #[test]
    fn set_asteroids_installs_the_wires_rocks_and_the_state_hash_says_so() {
        let build = || {
            game_core::world::World::with_gravity(
                FIELD_SEED,
                MapScale::Small,
                0,
                game_core::constants::DEFAULT_MAP_GENERATOR,
                GravityMode::Space,
            )
        };
        let server = build();
        assert_eq!(
            server.state_hash(),
            build().state_hash(),
            "two identically built space worlds disagree, so nothing below means \
             anything"
        );

        let (_, told) = space_world_and_mirror(true);
        let mut mirrored = build();
        mirrored.map.meta.asteroids = told.map.meta.asteroids.clone();
        assert_eq!(
            server.state_hash(),
            mirrored.state_hash(),
            "the client installed {} rocks off the wire and the server has {} — \
             the two sides are predicting against different fields",
            told.map.meta.asteroids.len(),
            server.map.meta.asteroids.len()
        );

        // The control: a mirror that never got the call. This is the client that
        // shipped before this task, and it must be visible to the same hash, or
        // the assertion above is one nothing could fail.
        let (_, untold) = space_world_and_mirror(false);
        assert!(
            untold.map.meta.asteroids.is_empty(),
            "the untold arm found rocks from somewhere, so it is not the control \
             it claims to be"
        );
        let mut mirrored_untold = build();
        mirrored_untold.map.meta.asteroids = untold.map.meta.asteroids.clone();
        assert_ne!(
            server.state_hash(),
            mirrored_untold.state_hash(),
            "a client with no rocks at all hashes the same as the server"
        );
    }

    /// **The point of `T22.11C`: a body drifting into a well ends where the
    /// server puts it.**
    ///
    /// The control that the fixture is live comes first — the server body has to
    /// have *moved*, and moved toward the rock, or "the two agree" is a statement
    /// about a body nothing touched. Then the claim, then the untold arm, which
    /// is the client that decoded the asteroid section and dropped it.
    #[test]
    fn a_mirror_told_the_rocks_drifts_where_the_server_drifts() {
        let told = drift_in_a_well(true);

        let travelled = told.server - told.start;
        assert!(
            travelled.len() > PLAYER_H,
            "the server body moved {:.1} px in {DRIFT_TICKS} ticks from \
             ({:.0}, {:.0}) — the field is not pulling it anywhere, so the \
             agreement below is vacuous",
            travelled.len(),
            told.start.x,
            told.start.y
        );
        // And it went the way the field pointed, which is what makes the move
        // attributable to the wells rather than to anything else a tick does.
        let along = travelled.x * told.field.x + travelled.y * told.field.y;
        assert!(
            along > 0.0,
            "the body drifted ({:.1}, {:.1}) against a field of ({:.1}, {:.1}) \
             px/s² — something other than the wells moved it",
            travelled.x,
            travelled.y,
            told.field.x,
            told.field.y
        );

        let apart = (told.server - told.mirror).len();
        assert!(
            apart <= RECONCILE_EPSILON_PX,
            "the mirror predicted the drifting body at ({:.1}, {:.1}) where the \
             server put it at ({:.1}, {:.1}), {apart:.1} px apart against an \
             epsilon of {RECONCILE_EPSILON_PX}",
            told.mirror.x,
            told.mirror.y,
            told.server.x,
            told.server.y
        );

        // **The control, and the red half of red-before-green.** A mirror never
        // given the rocks predicts against a field of exactly zero: the body
        // stays where it was put while the server's falls toward the rock.
        let untold = drift_in_a_well(false);
        let untold_apart = (untold.server - untold.mirror).len();
        assert!(
            untold_apart > RECONCILE_EPSILON_PX,
            "a mirror never given the rocks still agreed with the server \
             ({untold_apart:.1} px apart), so nothing here can see \
             `set_asteroids` at all"
        );
        assert!(
            (untold.mirror - untold.start).len() <= RECONCILE_EPSILON_PX,
            "the untold mirror moved to ({:.1}, {:.1}) from ({:.1}, {:.1}) — it \
             has a field from somewhere, and the arm is not the control it claims",
            untold.mirror.x,
            untold.mirror.y,
            untold.start.x,
            untold.start.y
        );
    }

    /// **The seam `load_mask`'s comment names, asserted for the new setter.**
    ///
    /// `load_mask` documents that `set_gravity` arrives off `lobby_state`
    /// *before* `map_init`, and the only test of that ordering calls
    /// `set_gravity` explicitly. `set_asteroids` lands in the same window, so
    /// this says what happens if the two messages are swapped.
    ///
    /// **They are not symmetric, and both halves are asserted.** The setter reads
    /// no mode — it installs the table, and `env_at` consults `self.gravity` at
    /// the tick — so prediction is identical either way round. `load_mask` is
    /// not: it re-extracted the surface through the generator derived from the
    /// mode it was *currently* set to, so a `map_init` that beat `lobby_state`
    /// got the landscape's surface on a space map. **Since T22.14A B3 the map
    /// carries its generator**, and both halves say order does not matter.
    #[test]
    fn map_init_before_lobby_state_still_predicts_the_field() {
        let mut w = game_core::world::World::with_gravity(
            FIELD_SEED,
            MapScale::Small,
            0,
            game_core::constants::DEFAULT_MAP_GENERATOR,
            GravityMode::Space,
        );
        w.set_phase(game_core::world::RoundPhase::Playing);
        let (_, start) = start_inside_a_well(&w);
        let bytes = game_server::codec::encode_map_init(&w.map);
        let parts =
            game_server::codec::decode_map_init_parts(&bytes).expect("the server's own bytes");
        let rle_bytes = game_core::map::rle::encode(&parts.mask);

        let drift = |gravity_first: bool| {
            let mut core = GameCore::new();
            if gravity_first {
                assert!(core.set_gravity(GravityMode::Space.as_str()));
            }
            // T22.14A B3: the map says what it is, first, as `applyMapInit` does.
            assert!(core.set_map_generator(parts.generator.to_u8()));
            assert!(core.load_mask(parts.mask.w, parts.mask.h, &rle_bytes));
            install_asteroids(&mut core, &parts.asteroids);
            if !gravity_first {
                assert!(core.set_gravity(GravityMode::Space.as_str()));
            }
            assert!(core.set_phase("playing"));
            core.add_player(1, start.x, start.y);
            for seq in 0..DRIFT_TICKS {
                core.apply_input(1, seq, 0, 0, SIM_DT);
            }
            let c = core.player_state(1);
            (Vec2::new(c[0], c[1]), core.map.meta.surface_points.len())
        };

        let (ordered, ordered_surface) = drift(true);
        let (swapped, swapped_surface) = drift(false);

        // The control: the run moved at all, so two equal answers are not two
        // copies of the start position.
        assert!(
            (ordered - start).len() > PLAYER_W,
            "neither ordering moved the body, so this test compares two \
             stationary points"
        );
        assert_eq!(
            ordered, swapped,
            "a `map_init` that arrived before `lobby_state` predicted \
             ({:.1}, {:.1}) where the documented order predicted ({:.1}, {:.1})",
            swapped.x, swapped.y, ordered.x, ordered.y
        );

        // **And the half that used to be order-dependent is not** (T22.14A B3):
        // `load_mask` re-extracted the surface through the generator the *mode*
        // implied, so a `map_init` that beat `lobby_state` got the landscape's
        // surface on a space map. `map_init` now carries the generator, so the
        // surface is the map's whichever message came first — and the server's.
        assert_eq!(
            ordered_surface, swapped_surface,
            "`load_mask` re-extracted a different surface when `map_init` beat `lobby_state`"
        );
        assert_eq!(
            ordered_surface,
            w.map.meta.surface_points.len(),
            "not the server's surface"
        );
    }

    /// **T22.10C F4: prediction's real call site pulls as the server does.** The
    /// test above reads `field_accel_at`, which is a readback — planting
    /// `env_at(map, gravity, &[], …)` in `apply_input`, the call prediction
    /// actually makes, left it green. This steps `GameCore::apply_input` and
    /// `World::step` side by side, idle, from 1.5 capture radii inside a live
    /// vortex until the server takes the player, and compares positions
    /// **exactly** every tick. The control: the body really was pulled a long
    /// way, so equal answers are not two copies of the start.
    #[test]
    fn apply_input_near_a_vortex_steps_exactly_as_the_server_does() {
        use game_core::constants::{METEOR_CARVE_R, VORTEX_CAPTURE_R};
        use game_core::player::input::Input;
        use game_core::world::GameEvent;
        let (mut w, mut core) = space_world_and_mirror(true);
        let geo = w.map.space_geometry().expect("space");
        let (tx, ty) = (geo.cx.round() as i32, (geo.cy - geo.ry).round() as i32);
        // Both sides carve the hole: the server's map, and the mirror's from the
        // `carve` event.
        let _ = w.map.carve_circle(tx, ty, METEOR_CARVE_R as i32);
        core.carve(tx, ty, METEOR_CARVE_R as i32);
        w.step(SIM_DT);
        assert_eq!(w.vortices.len(), 1, "control: the breach opened no vortex");
        let v = w.vortices[0].pos;
        core.set_vortices(&[v.x], &[v.y]);

        let start = v + Vec2::new(0.0, 1.5 * VORTEX_CAPTURE_R);
        w.add_player(1, 0, String::new());
        {
            let p = w.player_mut(1).expect("seated");
            p.body = game_core::physics::body::Body::new(start);
        }
        core.add_player(1, start.x, start.y);
        let _ = w.drain_events();

        let (mut seq, mut last, mut tripped) = (1000u32, start, false);
        for tick in 0..240 {
            seq += 1;
            w.queue_input(1, Input::new(seq, 0, 0));
            w.step(SIM_DT);
            core.apply_input(1, seq, 0, 0, SIM_DT);
            if w.drain_events()
                .iter()
                .any(|e| matches!(e, GameEvent::VortexTrip { id: 1, .. }))
            {
                tripped = true;
                break;
            }
            let server = w.player(1).expect("seated").body.pos;
            let c = core.player_state(1);
            assert_eq!(
                (c[0], c[1]),
                (server.x, server.y),
                "tick {tick}: the prediction left the server near a vortex"
            );
            last = server;
        }
        // The control is the trip: from 1.5 capture radii the server only takes the
        // player at the capture radius, so a trip is at least half a radius of pull,
        // every tick of it compared above. (It read `(last - start) > 0.5 R` until
        // T22.03G, and `last` is the tick *before* the trip — so it measured the
        // approach speed: R96's cap on the wells pulling the body away from this
        // vortex, 820 → 658 px/s², brought the trip a tick sooner and `last` to
        // 61.5 px of the 63.5 the old bound asked for.)
        assert!(
            tripped,
            "control: the vortex never took the player ({:?} -> {:?}), so agreement \
             proves nothing",
            start, last
        );
    }

    /// **T22.10: the mirror sums the vortex the server sums**, once told. A breach is
    /// opened on the server world through its own carve and step; the mirror is
    /// handed the list through `set_vortices` and must then report the server's
    /// field **bit-for-bit** — `apply_input` reads the same `env_at` with the same
    /// list, so this is the prediction. The control is the mirror told nothing: it
    /// predicts no vortex while the server pulls, the rubber-band this setter exists
    /// to prevent.
    #[test]
    fn a_mirror_told_the_vortices_predicts_the_servers_pull_and_one_not_told_does_not() {
        use game_core::world::vortex::centres;
        let (mut w, mut core) = space_world_and_mirror(true);
        let geo = w.map.space_geometry().expect("space");
        let (tx, ty) = (geo.cx.round() as i32, (geo.cy - geo.ry).round() as i32);
        let _ = w
            .map
            .carve_circle(tx, ty, game_core::constants::METEOR_CARVE_R as i32);
        w.step(SIM_DT);
        assert_eq!(w.vortices.len(), 1, "control: the breach opened no vortex");
        let v = w.vortices[0].pos;
        let at = v + Vec2::new(0.0, game_core::constants::VORTEX_CAPTURE_R * 1.5);
        let (pulls, n) = centres(&w.vortices);
        let server = game_core::world::attractors::env_at(
            &w.map,
            GravityMode::Space,
            &pulls[..n],
            None,
            false,
            at,
        )
        .accel;

        let untold = core.field_accel_at(at.x, at.y);
        assert!(
            (untold[0] - server.x).abs() + (untold[1] - server.y).abs() > 100.0,
            "control: a mirror told nothing already agrees, so the setter proves nothing"
        );
        core.set_vortices(&[v.x], &[v.y]);
        let told = core.field_accel_at(at.x, at.y);
        assert_eq!((told[0], told[1]), (server.x, server.y));
    }

    /// **R97 (T22.03I): where the vortex and the wells are capped together, the
    /// mirror reports the server's capped pull bit for bit.** The test above probes one
    /// point, where the cap need not bind; this one probes a ring of points out to
    /// three capture radii and compares only those where the raw sum is over the cap —
    /// the control that the cap is what is being compared (at least one such point).
    #[test]
    fn the_mirror_caps_the_vortex_with_the_wells_as_the_server_does() {
        use game_core::constants::{SPACE_WELL_ACCEL_MAX, VORTEX_CAPTURE_R};
        use game_core::world::attractors::{asteroid_attractors, env_at, field_at, Attractor};
        let (mut w, mut core) = space_world_and_mirror(true);
        let geo = w.map.space_geometry().expect("space");
        let (tx, ty) = (geo.cx.round() as i32, (geo.cy - geo.ry).round() as i32);
        let _ = w
            .map
            .carve_circle(tx, ty, game_core::constants::METEOR_CARVE_R as i32);
        w.step(SIM_DT);
        assert_eq!(w.vortices.len(), 1, "control: the breach opened no vortex");
        let v = w.vortices[0].pos;
        core.set_vortices(&[v.x], &[v.y]);
        let mut binding = 0;
        for k in 0..36 {
            for m in [1.2f32, 1.6, 2.0, 2.5, 3.0] {
                let a = (k as f32 * 5.0).to_radians();
                let at = v + Vec2::new(a.cos(), a.sin()) * (m * VORTEX_CAPTURE_R);
                let raw = field_at(
                    asteroid_attractors(&w.map).chain(std::iter::once(Attractor::vortex(v))),
                    at,
                );
                if raw.len() <= SPACE_WELL_ACCEL_MAX {
                    continue;
                }
                binding += 1;
                let server = env_at(&w.map, GravityMode::Space, &[v], None, false, at).accel;
                let told = core.field_accel_at(at.x, at.y);
                assert_eq!((told[0], told[1]), (server.x, server.y), "at {at:?}");
            }
        }
        assert!(binding > 0, "control: the cap bound nowhere on the ring");
    }

    /// **H1 (T22.14A): inside the black hole's reach a vortex does not pull, on the
    /// mirror as on the server** — the mirror told a hole and a vortex whose pull
    /// reaches into the hole's reach reports the hole's pull alone there, exactly the
    /// server's `env_at`; and one probe outside the reach still feels the vortex (the
    /// presence control: the list was told).
    #[test]
    fn the_mirror_mutes_a_vortex_inside_the_black_holes_reach_as_the_server_does() {
        use game_core::constants::{BLACK_HOLE_REACH, VORTEX_REACH};
        use game_core::world::attractors::{env_at, Attractor};
        let (w, mut core) = space_world_and_mirror(true);
        let geo = w.map.space_geometry().expect("space");
        let hole = Vec2::new(geo.cx, geo.cy);
        let v = hole + Vec2::new(BLACK_HOLE_REACH, 0.0);
        core.set_vortices(&[v.x], &[v.y]);
        core.set_black_hole(true, hole.x, hole.y);
        assert!(core.set_phase("playing"));
        let told = |p: Vec2| {
            let a = core.field_accel_at(p.x, p.y);
            Vec2::new(a[0], a[1])
        };
        for d in [0.3f32, 0.5, 0.7, 0.9] {
            let at = hole + Vec2::new(d * BLACK_HOLE_REACH, 0.0);
            assert!(
                (at - v).len() < VORTEX_REACH,
                "premise: the vortex reaches {at:?}"
            );
            let server = env_at(&w.map, GravityMode::Space, &[v], Some(hole), true, at).accel;
            assert_eq!(told(at), server, "at {d} of the reach");
            assert_eq!(
                server,
                Attractor::black_hole(hole).pull_at(at),
                "at {d}: not the hole alone"
            );
        }
        let out = v + Vec2::new(0.25 * VORTEX_REACH, 0.0);
        let server = env_at(&w.map, GravityMode::Space, &[v], Some(hole), true, out).accel;
        let unvortexed = env_at(&w.map, GravityMode::Space, &[], Some(hole), true, out).accel;
        assert_eq!(told(out), server);
        assert_ne!(
            server, unvortexed,
            "control: outside the reach the vortex pulls"
        );
    }

    /// **T22.12: the prediction pulls as the server does near the black hole** —
    /// once the mirror is told what a client is told: the `carve` of the eaten rock,
    /// the asteroid list without it, and `set_black_hole`. `GameCore::apply_input`
    /// and `World::step` side by side, idle, from outside the capture radius until
    /// the horizon takes the player, compared **exactly** every tick. Controls: the
    /// body really was pulled a long way, and a mirror told the carve and the list
    /// but not the hole leaves the server within a few ticks — the rubber-band the
    /// setter exists to prevent. Then R8.4: after the bell both sides stop pulling
    /// together.
    #[test]
    fn apply_input_near_the_black_hole_steps_exactly_as_the_server_does() {
        use game_core::constants::BLACK_HOLE_REACH;
        use game_core::player::input::Input;
        use game_core::world::{GameEvent, RoundPhase};
        let run = |tell_hole: bool, phase_ended: bool| -> (usize, f32, bool) {
            let (mut w, mut core) = space_world_and_mirror(true);
            let geo = w.map.space_geometry().expect("space");
            let hole = w
                .summon_black_hole_near(Vec2::new(geo.cx, geo.cy), w.round_time)
                .expect("summoned");
            for e in w.drain_events() {
                if let GameEvent::Carve { x, y, r, .. } = e {
                    core.carve(x, y, r);
                }
            }
            let bytes = game_server::codec::encode_map_init(&w.map);
            let parts = game_server::codec::decode_map_init_parts(&bytes).expect("own bytes");
            install_asteroids(&mut core, &parts.asteroids);
            if tell_hole {
                core.set_black_hole(true, hole.x, hole.y);
            }
            w.add_player(1, 0, String::new());
            let start = w
                .dev_place_near_black_hole(1, BLACK_HOLE_REACH * 0.75)
                .expect("a clear side");
            core.add_player(1, start.x, start.y);
            if phase_ended {
                w.set_phase(RoundPhase::Ended);
                assert!(core.set_phase("ended"));
            }
            let _ = w.drain_events();
            let (mut seq, mut agreed, mut moved, mut died) = (1000u32, 0usize, 0.0f32, false);
            for _ in 0..240 {
                seq += 1;
                w.queue_input(1, Input::new(seq, 0, 0));
                w.step(SIM_DT);
                core.apply_input(1, seq, 0, 0, SIM_DT);
                if !w.player(1).expect("seated").alive {
                    died = true;
                    break;
                }
                let server = w.player(1).expect("seated").body.pos;
                let c = core.player_state(1);
                if (c[0], c[1]) != (server.x, server.y) {
                    break;
                }
                agreed += 1;
                moved = moved.max((server - start).len());
            }
            (agreed, moved, died)
        };
        let (agreed, moved, died) = run(true, false);
        // The loop stops at the first disagreement, so `died` means the two sides
        // agreed exactly on every tick until the horizon took the player.
        assert!(
            died,
            "the prediction left the server near the hole after {agreed} ticks, before \
             the horizon took the player"
        );
        assert!(
            moved > BLACK_HOLE_REACH * 0.25,
            "control: the body barely moved ({moved:.1} px), so agreement proves nothing"
        );
        let (untold, _, _) = run(false, false);
        assert!(
            untold < agreed,
            "control: a mirror not told the hole agreed as long ({untold} vs {agreed} ticks)"
        );
        // After the bell: neither side pulls toward the hole, so both drift alike
        // for the whole run and nobody dies.
        let (agreed, _, died) = run(true, true);
        assert!(!died, "the hole killed after the bell");
        assert_eq!(agreed, 240, "the mirror left the server after the bell");
    }

    /// **T22.12C F5: the bell, for a body in the pull** — measured, not settled.
    ///
    /// The server stops the hole's pull on its `Ended` tick; a client hears `ended`
    /// a trip later and, until then, predicted the pull on inputs the server stepped
    /// without it. `set_bell` (from a `Playing` round clock and a snapshot, through
    /// `black_hole::bell_seq`) stops the prediction's pull at the right seq. Server
    /// and mirror side by side, idle, in the pull, across the bell; the client
    /// "hears" `ended` `HEARD_AFTER` ticks late. Measured at the moment it hears:
    /// **with the bell seq the two agree exactly; without it they are this far apart**
    /// — the bell correction every player in the pull used to take. The round clock
    /// is sampled twice (at the round's start and half a second before the bell) —
    /// since T22.12D an integer `ends_tick`, which must read the same both times; the
    /// round lengths players choose are `game-core`'s
    /// `round_ticks_tests::the_bell_predicted_at_round_start_is_the_servers`.
    #[test]
    fn the_bell_seq_stops_the_pull_on_the_servers_ended_tick() {
        use game_core::constants::{BLACK_HOLE_REACH, SIM_HZ, SNAPSHOT_QUANTUM};
        use game_core::player::input::Input;
        use game_core::world::{GameEvent, RoundPhase};
        const HEARD_AFTER: u32 = 6;
        const ROUND_S: f32 = 1.5;
        let run = |sample_late: bool, use_bell: bool| -> f32 {
            let (mut w, mut core) = space_world_and_mirror(true);
            w.set_round_seconds(ROUND_S);
            let geo = w.map.space_geometry().expect("space");
            let hole = w
                .summon_black_hole_near(Vec2::new(geo.cx, geo.cy), w.round_time)
                .expect("summoned");
            for e in w.drain_events() {
                if let GameEvent::Carve { x, y, r, .. } = e {
                    core.carve(x, y, r);
                }
            }
            let bytes = game_server::codec::encode_map_init(&w.map);
            let parts = game_server::codec::decode_map_init_parts(&bytes).expect("own bytes");
            install_asteroids(&mut core, &parts.asteroids);
            core.set_black_hole(true, hole.x, hole.y);
            w.add_player(1, 0, String::new());
            let start = w
                .dev_place_near_black_hole(1, BLACK_HOLE_REACH * 0.97)
                .expect("a clear side");
            core.add_player(1, start.x, start.y);
            let _ = w.drain_events();
            // The round clock as a `Playing` `round_state` carries it.
            let mut clock = w.phase_ends_tick().expect("playing");
            let (mut seq, mut ended_at) = (1000u32, None::<u32>);
            loop {
                seq += 1;
                w.queue_input(1, Input::new(seq, 0, 0));
                w.step(SIM_DT);
                if sample_late && w.phase == RoundPhase::Playing && w.phase_time_left() > 0.5 {
                    clock = w.phase_ends_tick().expect("playing");
                }
                if use_bell {
                    // A snapshot of this tick: `seq` ran on it.
                    core.set_bell(clock, seq, w.tick);
                }
                core.apply_input(1, seq, 0, 0, SIM_DT);
                if w.phase == RoundPhase::Ended && ended_at.is_none() {
                    ended_at = Some(w.tick);
                }
                assert!(
                    w.player(1).expect("seated").alive,
                    "the hole took the body before the bell"
                );
                if ended_at.is_some_and(|t| w.tick >= t + HEARD_AFTER) {
                    let server = w.player(1).expect("seated").body.pos;
                    let c = core.player_state(1);
                    return (Vec2::new(c[0], c[1]) - server).len();
                }
                assert!(w.tick < (ROUND_S * 2.0 * SIM_HZ as f32) as u32, "no bell");
            }
        };
        let gated = run(false, true);
        let gated_late = run(true, true);
        let ungated = run(false, false);
        assert!(
            gated <= SNAPSHOT_QUANTUM && gated_late <= SNAPSHOT_QUANTUM,
            "with the bell seq the prediction still left the server at the bell: {gated:.3} / \
             {gated_late:.3} px (the round clock sampled early / late)"
        );
        assert!(
            ungated > 10.0 * SNAPSHOT_QUANTUM,
            "control: without the bell seq the prediction is only {ungated:.3} px off {HEARD_AFTER} \
             ticks after the bell, so this measures nothing"
        );
        eprintln!(
            "bell correction for a body in the pull, heard {HEARD_AFTER} ticks late: \
             {ungated:.2} px without the bell seq, {gated:.3} / {gated_late:.3} px with it"
        );
    }

    /// **R96 (T22.03G): the mirror escapes the traced pocket with the server, tick for
    /// tick.** Seed 451383, (2194, 1235), where three wells summed to (18, −919) px/s²
    /// over the 900 px/s² down thrust: the server (`World::step`) and the mirror
    /// (`GameCore::apply_input`, set through the real snapshot codec) hold DOWN from
    /// rest and agree **exactly** every tick — the cap lives in the one `env_at`
    /// both call, so a clamp on one side only is a rubber band from the first tick.
    /// The presence half: the body really leaves (≥ `PLAYER_H`), so this is not two
    /// sides agreeing about a body the wells still hold — which is what both did
    /// before the cap (0 px).
    #[test]
    fn the_mirror_escapes_the_traced_pocket_with_the_server() {
        const POCKET: Vec2 = Vec2::new(2194.0, 1235.0);
        let (mut w, mut core) =
            space_world_and_mirror_at(451_383, game_core::constants::DEFAULT_MAP_SCALE, true);
        w.add_player(1, 0, String::new());
        {
            let p = w.player_mut(1).expect("seated");
            p.body.pos = POCKET;
            p.body.vel = Vec2::ZERO;
            p.body.grounded = false;
        }
        let bytes = game_server::codec::encode_snapshot(&w, 1, 0);
        let snap = game_server::codec::decode_snapshot(&bytes).expect("the server's own bytes");
        let wire = snap
            .players
            .iter()
            .find(|p| p.id == 1)
            .expect("player 1 is in the snapshot");
        let p = w.player(1).expect("seated");
        core.add_player(1, p.body.pos.x, p.body.pos.y);
        core.set_player_state(
            1,
            p.body.pos.x,
            p.body.pos.y,
            0.0,
            0.0,
            false,
            p.jetpack.fuel,
            wire.health as f32,
            wire.flags & 1 != 0,
            wire.move_mods,
        );
        // Seq 0 on the server — "numbered by the world", stepped on the tick it is
        // queued (R89), so the two sides step the same input on the same tick; a
        // client seq would wait out the jitter buffer's lead first.
        let mut seq = 1000u32;
        use game_core::player::input::button;
        for tick in 0..game_core::constants::SIM_HZ {
            seq += 1;
            w.queue_input(1, Input::new(0, button::DOWN, 0));
            w.step(SIM_DT);
            core.apply_input(1, seq, button::DOWN, 0, SIM_DT);
            let sp = w.player(1).expect("seated").body.pos;
            let c = core.player_state(1);
            assert_eq!(
                (sp.x, sp.y),
                (c[0], c[1]),
                "tick {tick}: the server and the mirror disagree in the pocket"
            );
        }
        let out = w.player(1).expect("seated").body.pos;
        assert!(
            out.y - POCKET.y >= PLAYER_H,
            "a second of DOWN moved the body {:.1} px — still held by the summed wells",
            out.y - POCKET.y
        );
    }

    /// **The readback the browser check steers by** (`T22.11C`, `R63`).
    ///
    /// `scripts/checks/asteroid-gravity.mjs` asks `field_accel_at` which way the
    /// body is about to be pulled and puts its subject patch there and its
    /// control patch opposite. A readback that answered plausibly but wrongly
    /// would aim both patches at nothing and the check would go red for the wrong
    /// reason, so it is pinned here against `wells_at` — the **capped** summation
    /// the server runs (R96/R97; T22.03I F6: it read the raw `field_at` until then,
    /// which agrees only where the cap does not bind) — rather than trusted.
    ///
    /// The `[0, 0]` arms are the two the check depends on: clearing the table is
    /// how it takes the field away for its control frame, and a standard match
    /// must report no field however the meta is filled.
    #[test]
    fn field_accel_at_reports_the_summation_the_server_runs() {
        let (w, core) = space_world_and_mirror(true);
        let (_, start) = start_inside_a_well(&w);
        let server = game_core::world::attractors::wells_at(&w.map, start);
        assert!(
            server.len() > 0.0,
            "the fixture point has no field on the server, so every arm below is \
             comparing zeroes"
        );
        let got = core.field_accel_at(start.x, start.y);
        assert_eq!(
            (got[0], got[1]),
            (server.x, server.y),
            "the mirror reports ({:.3}, {:.3}) px/s² where the server sums \
             ({:.3}, {:.3})",
            got[0],
            got[1],
            server.x,
            server.y
        );

        // Take the rocks away, which is the check's control frame.
        let mut cleared = core;
        cleared.set_asteroids(&[], &[], &[], &[]);
        let none = cleared.field_accel_at(start.x, start.y);
        assert_eq!((none[0], none[1]), (0.0, 0.0));

        // And a standard match reports no field with the table still full —
        // `env_at`'s `Standard | Low` arm, read through this accessor.
        let (_, mut standard) = space_world_and_mirror(true);
        assert!(standard.set_gravity(GravityMode::Standard.as_str()));
        assert!(!standard.map.meta.asteroids.is_empty());
        let off = standard.field_accel_at(start.x, start.y);
        assert_eq!((off[0], off[1]), (0.0, 0.0));
    }

    /// **The control that nothing else moved** (`T22.11C`).
    ///
    /// `worldMirror.ts::applyMapInit` now calls `setAsteroids` on *every*
    /// `map_init`, and a normal map's asteroid section is empty. So an ordinary
    /// match must predict exactly as it did before the call existed — the same
    /// rule R47 and `env_at`'s `Standard | Low` arm carry in `game-core`, checked
    /// here at the wasm seam where the new call actually lands.
    #[test]
    fn a_standard_match_predicts_the_same_with_the_new_call_as_without() {
        let mut w = game_core::world::World::new(FIELD_SEED, MapScale::Small);
        w.set_phase(game_core::world::RoundPhase::Playing);
        w.add_player(1, 0, String::new());
        let (stand_x, stand_y) = build_shelf(&mut w);
        let bytes = game_server::codec::encode_map_init(&w.map);
        let parts =
            game_server::codec::decode_map_init_parts(&bytes).expect("the server's own bytes");
        assert!(
            parts.asteroids.is_empty(),
            "a standard map shipped asteroids, so this control is testing \
             something else entirely"
        );
        let rle_bytes = game_core::map::rle::encode(&parts.mask);

        let walk = |call_the_setter: bool| {
            let mut core = GameCore::new();
            assert!(core.set_gravity(GravityMode::Standard.as_str()));
            assert!(core.load_mask(parts.mask.w, parts.mask.h, &rle_bytes));
            if call_the_setter {
                install_asteroids(&mut core, &parts.asteroids);
            }
            assert!(core.set_phase("playing"));
            core.add_player(1, stand_x, stand_y);
            for seq in 0..WALK_TICKS {
                core.apply_input(1, seq, game_core::player::input::button::RIGHT, 0, SIM_DT);
            }
            let c = core.player_state(1);
            Vec2::new(c[0], c[1])
        };

        let with_call = walk(true);
        let without = walk(false);
        // The control that the walk happened: two identical stationary bodies
        // would satisfy the equality below for a core that ignored input.
        assert!(
            (with_call.x - stand_x).abs() > PLAYER_W,
            "the walk moved the body only {:.1} px, so the comparison below is \
             between two start positions",
            with_call.x - stand_x
        );
        assert_eq!(
            with_call, without,
            "installing an empty asteroid table changed an ordinary match's \
             prediction: ({:.2}, {:.2}) against ({:.2}, {:.2})",
            with_call.x, with_call.y, without.x, without.y
        );
    }

    #[test]
    fn prediction_agrees_with_the_server_across_the_round_ending() {
        let (start, server_x, client_x) = hold_right_across_the_round_ending(true);
        assert!(
            server_x - start > PLAYER_W,
            "the control: the server player only walked {:.1} px while Playing",
            server_x - start
        );
        assert!(
            (server_x - client_x).abs() <= RECONCILE_EPSILON_PX,
            "told the round ended, the mirror put the player at {client_x:.1} and \
             the server at {server_x:.1}"
        );
        let (_, server_x, untold_x) = hold_right_across_the_round_ending(false);
        assert!(
            (server_x - untold_x).abs() > RECONCILE_EPSILON_PX,
            "a mirror never told the phase still agreed ({untold_x:.1} against \
             {server_x:.1}) — this test cannot see the phase"
        );
    }

    /// The client mirror must predict a **mounted** player where the server puts
    /// them (T21.11B).
    ///
    /// **The task file calls this the feature's real risk, and it is the same
    /// bug as T20.19, T21.02 and T21.03 for the third time.** `apply_input`
    /// zeroes the movement direction out of `MoveMods::mounted`, which the
    /// mirror can only learn from the move-mod byte. Without it the client runs
    /// a *walking* body while the server runs a stationary one, and a player who
    /// mounts under fire watches themselves slide off the platform and snap
    /// back — which reads as the netcode breaking, not as a locked gun.
    ///
    /// Three assertions, and the middle one is the control:
    ///
    ///  - the two sides agree inside `RECONCILE_EPSILON_PX`;
    ///  - the mounted server run **did not move**, so the agreement is not
    ///    satisfied by a lockout that does nothing;
    ///  - and the unmounted control on the identical shelf **did** move, so the
    ///    fixture is measuring the lockout rather than a ledge.
    #[test]
    fn the_client_predicts_a_mounted_player_where_the_server_puts_them() {
        let right = game_core::player::input::button::RIGHT;
        let free = walk_both_sides_wearing(BASE_HEALTH, right, None, false);
        let mounted = walk_both_sides_wearing(BASE_HEALTH, right, None, true);

        // The control pair: held right, the free player walks and the mounted
        // one does not.
        assert!(
            free.server_x - free.server_vx.abs() * 0.0 > 0.0 && free.server_vx.abs() > 1.0,
            "the unmounted control never moved ({} px/s), so this measures nothing",
            free.server_vx
        );
        assert!(
            mounted.server_vx.abs() < 1.0,
            "a mounted server player is walking at {} px/s",
            mounted.server_vx
        );

        // The claim. Fails by the whole walk if the bit is dropped anywhere
        // between `move_mod_bits`, the codec, `set_player_state` and
        // `move_mods()`.
        assert!(
            (mounted.server_x - mounted.client_x).abs() <= RECONCILE_EPSILON_PX,
            "the mirror predicted a mounted player at {} where the server put \
             them at {} — {} px apart, against an epsilon of \
             {RECONCILE_EPSILON_PX}",
            mounted.client_x,
            mounted.server_x,
            (mounted.server_x - mounted.client_x).abs(),
        );
    }

    /// The client mirror must predict a **flying** player where the server puts
    /// them (T21.03).
    ///
    /// The same rule as T20.19 and T21.02, on the other axis. `apply_input`
    /// turns gravity off, drives `vel.y` to `WINGS_FLY_SPEED` and refuses the
    /// jump, all out of `MoveMods::flying` — which the mirror can only know from
    /// the move-mod byte. Without it the mirror runs a **falling** body while
    /// the server runs a climbing one, and the two separate at
    /// `2 * WINGS_FLY_SPEED` plus gravity.
    ///
    /// **UP held on both runs** (T21.34). Wings hover with no input now, so a
    /// buttonless winged run would sit on the shelf exactly like the bare one
    /// and the control below could not tell wings from no wings. UP is also
    /// the input the mirror has to read correctly: a mirror that ignored it
    /// would predict a hover while the server climbs.
    #[test]
    fn the_client_predicts_a_flying_player_where_the_server_puts_them() {
        let up = game_core::player::input::button::UP;
        let bare = walk_both_sides_wearing(BASE_HEALTH, up, None, false);
        let winged = walk_both_sides_wearing(
            BASE_HEALTH,
            up,
            Some(game_core::items::registry::UNICORN_WINGS),
            false,
        );

        // The control: the wings were on, and with the same UP they lifted the
        // server's player off a shelf the unwinged control stayed on. Without it
        // the agreement below is satisfied by wings that do nothing at all.
        assert!(
            winged.server_y < bare.server_y - 1.0,
            "the winged server run did not rise: {} against an unwinged {}",
            winged.server_y,
            bare.server_y
        );

        // The claim.
        assert!(
            (winged.server_y - winged.client_y).abs() <= RECONCILE_EPSILON_PX,
            "the mirror predicted a flying player at y {} where the server put \
             them at {} — {} px apart, against an epsilon of \
             {RECONCILE_EPSILON_PX}",
            winged.client_y,
            winged.server_y,
            (winged.server_y - winged.client_y).abs()
        );
    }

    /// The client mirror must predict a **booted** player where the server puts
    /// them (T21.02).
    ///
    /// **This is the assertion the task file calls the one that matters.**
    /// `apply_input` scales the walk target by `PlayerState::move_mods()`, which
    /// reads the inventory, and the mirror's inventory is empty until a snapshot
    /// fills it — so without the move-mod byte on the wire a booted player is
    /// predicted at half the speed the server runs and rubber-bands on every
    /// step. It is T20.19's bug with a bigger multiplier.
    ///
    /// Three assertions, and the middle one is the control:
    ///
    ///  - the two sides agree inside `RECONCILE_EPSILON_PX`;
    ///  - the run **actually used the boots** — the server reached
    ///    `WALK_SPEED * BOOTS_SPEED_MULT`, which an unbooted run cannot. Without
    ///    it the agreement is satisfied by boots that do nothing at all;
    ///  - and it is faster than the unbooted control on the identical shelf, so
    ///    the fixture is measuring the item rather than the map.
    #[test]
    fn the_client_predicts_a_booted_player_where_the_server_puts_them() {
        let right = game_core::player::input::button::RIGHT;
        let bare = walk_both_sides_wearing(BASE_HEALTH, right, None, false);
        let booted = walk_both_sides_wearing(
            BASE_HEALTH,
            right,
            Some(game_core::items::registry::IRONMAN_BOOTS),
            false,
        );

        // The control: the boots were on, and they did something.
        assert!(
            (booted.server_vx - WALK_SPEED * game_core::constants::BOOTS_SPEED_MULT).abs() < 1e-3,
            "the booted server run reached {} of an expected {}",
            booted.server_vx,
            WALK_SPEED * game_core::constants::BOOTS_SPEED_MULT
        );
        assert!(
            booted.server_vx > bare.server_vx,
            "booted {} was no faster than unbooted {}",
            booted.server_vx,
            bare.server_vx
        );

        // The claim. Fails by a whole `BOOTS_SPEED_MULT` if the byte is dropped
        // anywhere between `move_mod_bits`, the codec, `set_player_state` and
        // `move_mods()`.
        assert!(
            (booted.server_x - booted.client_x).abs() <= RECONCILE_EPSILON_PX,
            "the mirror predicted a booted player at {} where the server put \
             them at {} — {} px apart, against an epsilon of \
             {RECONCILE_EPSILON_PX}",
            booted.client_x,
            booted.server_x,
            (booted.server_x - booted.client_x).abs()
        );
        assert!(
            (booted.client_vx - booted.server_vx).abs() < 1e-3,
            "the mirror ran a booted player at {} against the server's {}",
            booted.client_vx,
            booted.server_vx
        );
    }

    /// The client mirror must predict a **hurt** player where the server puts
    /// them (T20.19).
    ///
    /// Before this task the mirror passed a literal `1.0` where the server
    /// passes `speed_multiplier()`, so a player at half health was predicted
    /// 12.5 % fast and `prediction.ts` snapped and replayed every pending input
    /// on every frame they moved.
    #[test]
    fn the_client_predicts_a_hurt_player_where_the_server_puts_them() {
        let right = game_core::player::input::button::RIGHT;

        // The control, and also the fixture's proof that the shelf has room:
        // the run ends at exactly WALK_SPEED, which a body against a wall
        // cannot reach (`move_x` and `clamp_to_world` both zero `vel.x`).
        // Without it every assertion below is satisfied by two bodies that went
        // nowhere together.
        let full = walk_both_sides(BASE_HEALTH, right);
        assert!(
            (full.server_vx - WALK_SPEED).abs() < 1e-3,
            "no room to walk right: the server reached {} of {WALK_SPEED}",
            full.server_vx
        );
        assert!(
            (full.server_x - full.client_x).abs() <= RECONCILE_EPSILON_PX,
            "the healthy control already diverged, so the map or the inputs differ"
        );

        // **The floor, pinned where it is defined** (T20.21).
        //
        // The range check inside the loop below does not do it, whatever its
        // comment used to claim. With `want = WALK_SPEED * (m + (1 - m) * f)`
        // the lower half reduces to `(1 - m) * f > 0`, which is true for
        // **every** `m < 1` and `f > 0` — set `HEALTH_SPEED_MIN` to 0.5 and it
        // still passes. Only the upper bound has teeth (raise the floor to 1.0
        // and `want < WALK_SPEED` fails).
        //
        // **And this pin does not give the low side teeth against the constant
        // either**, measured rather than assumed: it reads `HEALTH_SPEED_MIN`
        // on both halves, so lowering the constant moves both. That is what
        // `CLAUDE.md` requires — a test that hardcoded 0.75 would go stale the
        // day the value is retuned. What it *does* rule out is the thing a
        // range check cannot: an implementation that stops honouring the floor
        // at all. Nothing in the repository can catch a retune of this constant,
        // because its own doc comment states no number to check against.
        let mut dead = PlayerState::new(1, Vec2::ZERO, 0);
        dead.health = 0.0;
        assert_eq!(
            dead.speed_multiplier(),
            HEALTH_SPEED_MIN,
            "the multiplier at zero health is not the floor"
        );

        // Not health 0: that is *death*, and `apply_inputs` skips a dead player
        // — the first run of this loop measured a corpse and read 20 px/s,
        // exactly one tick of WALK_ACCEL. That gap is now closed on the mirror
        // too (T20.21) and `a_dead_player_is_not_predicted_moving` owns it.
        //
        // **`BASE_HEALTH / 3.0` is the one that matters here** (T20.21): the
        // other two are whole numbers, which survive `codec.rs`'s `as u8`
        // unchanged, so a fixture using only those cannot see the truncation —
        // which is exactly how T20.19 shipped a permanent one-health desync.
        // Server health is routinely fractional; a third of full health is the
        // simplest value derived from a constant that cannot be whole.
        for health in [BASE_HEALTH * 0.5, BASE_HEALTH * 0.01, BASE_HEALTH / 3.0] {
            // `speed_multiplier` is the shared rule, so it is the expectation
            // for *both* sides rather than a third copy of the lerp.
            let mut expect = PlayerState::new(1, Vec2::ZERO, 0);
            expect.health = health;
            let want = WALK_SPEED * expect.speed_multiplier();
            // A sanity range, and only its upper half constrains anything — see
            // the floor pin above. Kept because it does still catch an
            // implementation that ignores health or exceeds `WALK_SPEED`.
            assert!(
                want > WALK_SPEED * HEALTH_SPEED_MIN && want < WALK_SPEED,
                "{want} is not between the floor and WALK_SPEED at health {health}"
            );

            let o = walk_both_sides(health, right);
            assert_eq!(o.server_health, health, "health moved mid-run");
            // The control on the crossing: for the fractional case the wire must
            // actually have lost something, or "both sides agree" is a claim
            // about a value the codec never touched.
            if health.fract() != 0.0 {
                assert!(
                    o.wire_health < o.server_health,
                    "the wire carried {} for a server health of {} — nothing was \
                     truncated, so this case proves nothing about the codec",
                    o.wire_health,
                    o.server_health
                );
            }

            // The symptom first, in the units the reconciler works in.
            let drift = (o.server_x - o.client_x).abs();
            assert!(
                drift <= RECONCILE_EPSILON_PX,
                "at health {health} the client finished {drift} px from the server, past \
                 RECONCILE_EPSILON_PX ({RECONCILE_EPSILON_PX}) — `prediction.ts` snaps and \
                 replays every pending input, on every frame"
            );
            // Then the cause, so a failure names it rather than leaving a number.
            assert!(
                (o.server_vx - want).abs() < 1e-3,
                "the server ran at {} not {want} at health {health}",
                o.server_vx
            );
            assert!(
                (o.client_vx - want).abs() < 1e-3,
                "the client predicted {} not {want} at health {health}",
                o.client_vx
            );
        }
    }

    #[test]
    fn an_unknown_player_id_is_empty_not_a_panic() {
        let core = GameCore::new();
        assert_eq!(core.player_state(99).len(), 0);
    }

    #[test]
    fn duplicate_add_player_is_ignored() {
        let mut core = GameCore::new();
        core.add_player(1, 10.0, 10.0);
        core.add_player(1, 900.0, 900.0);
        let s = core.player_state(1);
        assert_eq!(s[0], 10.0, "the second add must not move the player");
    }

    #[test]
    fn meta_json_parses_and_carries_the_map() {
        let mut core = GameCore::new();
        core.generate(4242, 0, 1);
        let json = core.meta_json();
        assert!(json.contains("spawn_points"));
        assert!(json.contains("surface_points"));
        assert!(json.contains("buried_slots"));
        let v: serde_json::Value = serde_json::from_str(&json).expect("valid json");
        assert!(!v["spawn_points"].as_array().expect("array").is_empty());
        assert!(!v["surface_points"].as_array().expect("array").is_empty());
    }

    #[test]
    fn constants_json_carries_the_viewport_and_camera_values() {
        let v: serde_json::Value = serde_json::from_str(&constants_json()).expect("valid json");
        assert_eq!(v["VIEWPORT_W"], 1280);
        assert_eq!(v["VIEWPORT_H"], 720);
        assert_eq!(v["CHUNK_SIZE"], 256);
        assert_eq!(v["CAMERA_ZOOM"], 2.0);
        assert_eq!(v["PLAYER_W"], 16.0);
        assert_eq!(v["PLAYER_H"], 28.0);
    }

    /// §F7's bounds cross to the client, pinned to the constants.
    ///
    /// The panel that steps the round length draws its own range, and a stepper
    /// carrying a local 240/600/60 would keep offering the old one after any of
    /// them moved (§A19). Asserted at the emitting end because a missing key is
    /// `undefined` in the browser and every comparison against it is `false`
    /// forever — a bar that never fails rather than one that passes.
    ///
    /// Written as a plain `#[test]` because the neighbouring `constants_json`
    /// assertion was a `wasm_bindgen_test` and had never run. T19.19 converted
    /// it; both run now, and `no_test_in_this_crate_is_invisible_to_the_gate`
    /// keeps it that way.
    #[test]
    fn constants_json_carries_the_private_round_length_bounds() {
        let v: serde_json::Value = serde_json::from_str(&constants_json()).expect("valid json");
        assert_eq!(
            v["ROUND_SECONDS_MIN"],
            game_core::constants::ROUND_SECONDS_MIN
        );
        assert_eq!(
            v["ROUND_SECONDS_MAX"],
            game_core::constants::ROUND_SECONDS_MAX
        );
        assert_eq!(
            v["ROUND_SECONDS_STEP"],
            game_core::constants::ROUND_SECONDS_STEP
        );
    }

    #[test]
    fn the_seed_is_reassembled_from_two_halves() {
        let mut a = GameCore::new();
        a.generate(0x1234_5678, 0x9ABC_DEF0, 0);
        let mut b = GameCore::new();
        b.generate(0x1234_5678, 0x9ABC_DEF0, 0);
        assert_eq!(a.mask_hash(), b.mask_hash());

        let mut c = GameCore::new();
        c.generate(0x1234_5678, 0, 0);
        assert_ne!(a.mask_hash(), c.mask_hash(), "the high half must matter");
    }
}

/// The Rust FoV formula, exposed so the client can **prove** its TypeScript copy
/// agrees rather than assuming it (`docs/14-daynight-visibility.md` §3, T5.07).
///
/// Not the render path — `fovRadius` in `lightmap-math.ts` is, and calling across
/// the boundary every frame for every light would be wasteful. This exists so a
/// test can sweep both and fail if they diverge, which is the drift the shared-core
/// architecture exists to stop.
#[wasm_bindgen]
pub fn core_fov_radius(darkness: f32, fog_mult: f32, health: f32, has_flashlight: bool) -> f32 {
    game_core::world::cycle::fov_radius(darkness, fog_mult, health, has_flashlight)
}

/// The Rust darkness curve (§A13), exposed for the same reason.
#[wasm_bindgen]
pub fn core_darkness_at(u: f32) -> f32 {
    game_core::world::cycle::darkness_at(u)
}

/// Build the `HitTarget` view the effects damage through.
///
/// Damage is *recorded* rather than applied here: `PlayerState::apply_damage`
/// needs `&mut` on the same players the slice already borrows. Collecting
/// (id, amount) and applying afterwards keeps one damage path — shields,
/// i-frames and death all stay in `PlayerState` rather than being re-implemented
/// per effect.
type HitLog = std::rc::Rc<std::cell::RefCell<Vec<(u8, f32)>>>;

fn build_targets<'a>(players: &'a mut [LocalPlayer], hits: &HitLog) -> Vec<HitTarget<'a>> {
    players
        .iter_mut()
        .map(|p| {
            let id = p.id;
            let alive = p.stats.alive;
            let pos = p.body.pos;
            let log = hits.clone();
            HitTarget {
                id: game_core::weapons::explode::HitId::Player(id),
                w: game_core::constants::PLAYER_W,
                h: game_core::constants::PLAYER_H,
                pos,
                vel: &mut p.body.vel,
                alive,
                apply_damage: Box::leak(Box::new(move |amount: f32, _s: DamageSource| {
                    log.borrow_mut().push((id, amount));
                    true
                })),
            }
        })
        .collect()
}

/// Apply what `build_targets` recorded, through the real stats path.
///
/// `suit` is the core's `GravityMode::wears_suit()` (T22.09A, R2): in space the
/// suit absorbs as the server's does, so the sandbox cannot show a hit the
/// networked game would have softened.
fn apply_hits(players: &mut [LocalPlayer], hits: &[(u8, f32)], now: f32, suit: bool) {
    for (id, amount) in hits {
        if let Some(p) = players.iter_mut().find(|p| p.id == *id) {
            p.stats.apply_damage(
                *amount,
                DamageSource::Weather(EffectKind::ToxicRain),
                now,
                suit,
            );
        }
    }
}

// ---------------------------------------------------------------------------
// Attract mode (`docs/71-amendments-v3.md` §B3)
// ---------------------------------------------------------------------------

/// A whole round running behind the title screen, client-side, with no server.
///
/// This wraps a real [`World`] and real [`Bot`]s rather than `GameCore`'s
/// hand-rolled subset, and it ticks them exactly the way `room.rs::drive_bots`
/// plus `World::step` does. That is the entire point: §B3 wants the title screen
/// to be *"a continuous smoke test of the simulation that anyone can see"*, and a
/// background driven by scripted JS movement would smoke-test nothing. If the
/// bots on the title screen stop fighting, something in `game-core` is broken —
/// and that is visible before anyone opens a test suite.
#[wasm_bindgen]
pub struct AttractCore {
    world: game_core::world::World,
    bots: Vec<game_core::bots::Bot>,
}

#[wasm_bindgen]
impl AttractCore {
    /// A fresh map with `bots` bots fighting on it.
    #[wasm_bindgen(constructor)]
    pub fn new(seed_lo: u32, seed_hi: u32, scale: u8, bots: u32, skill: f32) -> AttractCore {
        console_error_panic_hook::set_once();
        let seed = ((seed_hi as u64) << 32) | seed_lo as u64;
        let scale = MapScale::from_u8(scale).unwrap_or(MapScale::Medium);
        let mut world = game_core::world::World::new(seed, scale);
        let n = bots.min(game_core::constants::MAX_PLAYERS as u32);
        let mut list = Vec::new();
        for i in 0..n {
            let id = i as u8;
            world.add_player(id, (i % 5) as u16, format!("Bot {}", i + 1));
            list.push(game_core::bots::Bot::new(id, seed, i, skill));
        }
        AttractCore { world, bots: list }
    }

    /// One tick. Mirrors `room.rs::drive_bots` — think, queue, use, fire, step.
    ///
    /// Firing is a *command* and not a button the sim reads, so it has to be
    /// sent explicitly; that is the defect that left bots never firing a shot in
    /// the game's history, and reproducing the room's exact sequence here is
    /// what keeps this a faithful smoke test rather than a lookalike.
    ///
    /// **Frozen, and dormant since T18.01.** `AttractCore` lost its only caller
    /// when the title screen stopped running the simulation, so this is a
    /// hand-rolled copy of `drive_bots` that nothing exercises — and a copy
    /// nothing exercises is one that diverges silently. `to_command` and
    /// `wait_for` are the two this project has already paid for.
    ///
    /// T18.02 changed what `think` *decides* (exploration, arming, retreat) and
    /// deliberately did not change the driving sequence, so this needed no edit.
    /// **If the sequence itself ever changes — a new command a bot can ask for,
    /// a different order — edit this with it or delete `AttractCore`.** Do not
    /// leave it half-true.
    pub fn step(&mut self, dt: f32) {
        let now = self.world.round_time;
        let mut inputs = Vec::with_capacity(self.bots.len());
        let mut fires = Vec::new();
        let mut uses = Vec::new();
        for bot in &mut self.bots {
            let input = bot.think(&self.world, now, dt);
            if let Some(slot) = bot.wants_use() {
                uses.push((bot.player, slot));
            }
            if input.buttons & game_core::player::input::button::FIRE != 0 {
                fires.push(bot.player);
            }
            inputs.push((bot.player, input));
        }
        for (id, input) in inputs {
            self.world.queue_input(id, input);
        }
        for (id, slot) in uses {
            let _ = self.world.use_item(id, slot, now);
        }
        for id in fires {
            let _ = self.world.fire(id, now);
        }
        self.world.step(dt);
        // The events are not rendered here — the attract mode is a background,
        // not a game — but they must be drained or the buffer grows for the
        // lifetime of the title screen.
        self.world.drain_events();
    }

    pub fn tick(&self) -> u32 {
        self.world.tick
    }

    pub fn round_time(&self) -> f32 {
        self.world.round_time
    }

    pub fn mask_ptr(&self) -> *const u8 {
        self.world.map.mask.words().as_ptr() as *const u8
    }

    pub fn mask_byte_len(&self) -> usize {
        self.world.map.mask.words().len() * 8
    }

    pub fn width(&self) -> u32 {
        self.world.map.mask.w
    }

    pub fn height(&self) -> u32 {
        self.world.map.mask.h
    }

    pub fn chunks_x(&self) -> u32 {
        self.world.map.mask.w / game_core::constants::CHUNK_SIZE
    }

    pub fn chunks_y(&self) -> u32 {
        self.world.map.mask.h / game_core::constants::CHUNK_SIZE
    }

    pub fn solid_at(&self, x: i32, y: i32) -> bool {
        self.world.map.mask.get(x, y)
    }

    pub fn take_dirty_chunks(&mut self) -> Vec<u32> {
        self.world.map.drain_dirty()
    }

    pub fn meta_json(&self) -> String {
        serde_json::to_string(&self.world.map.meta).unwrap_or_else(|_| "{}".to_string())
    }

    pub fn count_solid(&self) -> f64 {
        self.world.map.mask.count_solid() as f64
    }

    /// Every bot, flattened: `[id, x, y, vx, vy, aim, alive, moveState] * n`.
    ///
    /// One flat array rather than JSON per frame: this runs every frame behind a
    /// menu and must not allocate a string sixty times a second.
    pub fn players(&self) -> Box<[f32]> {
        let mut out = Vec::with_capacity(self.world.players.len() * 8);
        for p in &self.world.players {
            let state = match game_core::physics::body::move_state(&p.body, p.jetpack.active) {
                game_core::physics::body::MoveState::Grounded => 0.0,
                game_core::physics::body::MoveState::Airborne => 1.0,
                game_core::physics::body::MoveState::Jetpack => 2.0,
            };
            out.extend_from_slice(&[
                p.id as f32,
                p.body.pos.x,
                p.body.pos.y,
                p.body.vel.x,
                p.body.vel.y,
                game_core::math::dequantize_angle(p.aim),
                if p.alive { 1.0 } else { 0.0 },
                state,
            ]);
        }
        out.into_boxed_slice()
    }

    /// Where the action is: the living bot nearest to the most recent damage,
    /// falling back to the first living one. The camera follows this.
    pub fn focus(&self) -> Box<[f32]> {
        let p = self
            .world
            .players
            .iter()
            .filter(|p| p.alive)
            .min_by_key(|p| (p.health * 10.0) as i32)
            .or_else(|| self.world.players.first());
        match p {
            Some(p) => Box::new([p.body.pos.x, p.body.pos.y]),
            None => Box::new([0.0, 0.0]),
        }
    }
}

/// T19.24 — the client derives the *server's* vents, through the real entry
/// points.
///
/// `effects/lava.rs::t19_24_client_side_vents` proves the derivation agrees at
/// the library level. This proves it survives the two things that actually stand
/// between the two sides in a match: the mask going over the wire as RLE, and
/// `load_mask` rebuilding the map from it.
#[cfg(test)]
mod t19_24_server_driven_lava {
    use super::*;
    use game_core::constants::MapScale;
    use game_core::effects::lava::LavaBurst;
    use game_core::map::{generate, rle};

    const EFFECT_SEED: u64 = 0x5EED_1A7A;

    fn positions_from_json(json: &str) -> Vec<(i64, i64)> {
        let v: serde_json::Value = serde_json::from_str(json).expect("vents json");
        v.as_array()
            .expect("an array")
            .iter()
            .map(|e| {
                (
                    e["x"].as_f64().expect("x") as i64,
                    e["y"].as_f64().expect("y") as i64,
                )
            })
            .collect()
    }

    #[test]
    fn a_networked_client_derives_the_servers_vents_after_map_init() {
        let server = generate(4242, MapScale::Small);
        let want: Vec<(i64, i64)> = LavaBurst::new(EFFECT_SEED, &server, 0.0)
            .vents()
            .iter()
            .map(|v| (v.pos.x as i64, v.pos.y as i64))
            .collect();
        assert!(
            !want.is_empty(),
            "the server found no vents — this fixture proves nothing"
        );

        // The client's whole knowledge of the map: the RLE payload `map_init`
        // carries, and nothing else.
        let mut core = GameCore::new();
        let payload = rle::encode(&server.mask);
        assert!(
            core.load_mask(server.mask.w, server.mask.h, &payload),
            "load_mask refused a payload the server produced"
        );

        let got = positions_from_json(&core.lava_vents(
            EFFECT_SEED as u32,
            (EFFECT_SEED >> 32) as u32,
            0.0,
        ));
        assert_eq!(
            got, want,
            "the client derived different vents from the seed"
        );
    }

    /// The phases follow `elapsed`, and the control is that they are not all the
    /// same: a function returning `jetting: true` forever would pass a test that
    /// only looked at one instant.
    #[test]
    fn the_phases_advance_with_elapsed() {
        let server = generate(4242, MapScale::Small);
        let mut core = GameCore::new();
        let payload = rle::encode(&server.mask);
        assert!(core.load_mask(server.mask.w, server.mask.h, &payload));

        let phase_at = |core: &mut GameCore, t: f32| -> (usize, usize) {
            let json = core.lava_vents(EFFECT_SEED as u32, (EFFECT_SEED >> 32) as u32, t);
            let v: serde_json::Value = serde_json::from_str(&json).unwrap();
            let a = v.as_array().unwrap();
            (
                a.iter().filter(|e| e["jetting"] == true).count(),
                a.iter().filter(|e| e["burning"] == true).count(),
            )
        };
        let jet = game_core::constants::LAVA_JET_DURATION;
        let burn = game_core::constants::LAVA_BURN_DURATION;

        let (j0, b0) = phase_at(&mut core, 0.0);
        let (j1, b1) = phase_at(&mut core, jet + burn * 0.5);
        let (j2, b2) = phase_at(&mut core, jet + burn + 1.0);
        assert!(j0 > 0 && b0 == 0, "at t=0 every vent should be jetting");
        assert!(j1 == 0 && b1 > 0, "mid-burn every vent should be burning");
        assert!(j2 == 0 && b2 == 0, "past the burn nothing should be active");
    }
}
