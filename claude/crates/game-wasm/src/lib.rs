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

use game_core::constants::{MapScale, SIM_DT};
use game_core::effects::fog::HeavyFog;
use game_core::effects::lava::LavaBurst;
use game_core::effects::meteor::MeteorShower;
use game_core::effects::toxic::ToxicRain;
use game_core::effects::{EffectKind, EffectPhase, EffectScheduler};
use game_core::items::registry::{self, ItemId, WeaponId};
use game_core::map::{generate, rle, CoarseGrid, Map};
use game_core::math::Vec2;
use game_core::physics::body::Body;
use game_core::player::state::PlayerState;
use game_core::player::{apply_input, Input, JetpackState, JumpState};
use game_core::rng::{substream, ChaCha8Rng};
use game_core::weapons::defs;
use game_core::weapons::explode::{
    explode, fire_hitscan, BlastSource, DamageSource, PlayerHitTarget,
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
    /// Health, inventory, cooldowns. The sandbox needs the whole record so firing
    /// goes through the same validation the server will use.
    stats: PlayerState,
}

#[wasm_bindgen]
pub struct GameCore {
    map: Map,
    players: Vec<LocalPlayer>,
    projectiles: Projectiles,
    rng: ChaCha8Rng,
    weather: Weather,
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
    fog: Option<HeavyFog>,
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

    /// `generate` against a named terrain generator (0 = v1, 1 = v2).
    ///
    /// Local only: a networked round is sent the finished mask in `map_init` and
    /// never rebuilds it from the seed. This exists so the sandbox and preview
    /// scenes — and the renderer's terrain tests — can put either generator's
    /// maps on screen, since v1 still ships behind `MAP_GENERATOR=v1` and a test
    /// that only ever sees the default stops guarding the other one.
    pub fn generate_with(&mut self, seed_lo: u32, seed_hi: u32, scale: u8, generator: u8) {
        let seed = ((seed_hi as u64) << 32) | seed_lo as u64;
        let scale = MapScale::from_u8(scale).unwrap_or(MapScale::Medium);
        let generator = game_core::constants::MapGenerator::from_u8(generator)
            .unwrap_or(game_core::constants::DEFAULT_MAP_GENERATOR);
        self.map = game_core::map::generate_with(seed, scale, generator);
    }

    /// Rebuild the map from a `map_init` RLE payload. Returns false on malformed
    /// input rather than panicking — this decodes untrusted network data.
    pub fn load_mask(&mut self, w: u32, h: u32, rle_bytes: &[u8]) -> bool {
        let Ok(mask) = rle::decode(w, h, rle_bytes) else {
            return false;
        };
        let coarse = CoarseGrid::build(&mask);
        let mut meta = self.map.meta.clone();
        meta.surface_points.clear();
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

    pub fn add_player(&mut self, id: u8, x: f32, y: f32) {
        if self.players.iter().any(|p| p.id == id) {
            return;
        }
        self.players.push(LocalPlayer {
            id,
            body: Body::new(Vec2::new(x, y)),
            jump: JumpState::default(),
            jet: JetpackState::default(),
            stats: PlayerState::new(id, Vec2::new(x, y), 0),
            prev_input: Input::default(),
        });
    }

    pub fn remove_player(&mut self, id: u8) {
        self.players.retain(|p| p.id != id);
    }

    pub fn apply_input(&mut self, id: u8, seq: u32, buttons: u8, aim: u16, dt: f32) {
        let map = &self.map;
        let Some(p) = self.players.iter_mut().find(|p| p.id == id) else {
            return;
        };
        let input = Input::new(seq, buttons, aim);
        let dt = if dt > 0.0 { dt } else { SIM_DT };
        apply_input(
            map,
            &mut p.body,
            &mut p.jump,
            &mut p.jet,
            &input,
            &p.prev_input,
            1.0,
            dt,
        );
        p.prev_input = input;
    }

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
    ) {
        let Some(p) = self.players.iter_mut().find(|p| p.id == id) else {
            return;
        };
        p.body.pos = Vec2::new(x, y);
        p.body.vel = Vec2::new(vx, vy);
        p.body.grounded = grounded;
        p.jet.fuel = fuel;
    }

    /// `[x, y, vx, vy, grounded, fuel, move_state]`, or empty for an unknown id.
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
        ])
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
                serde_json::json!({
                    "id": d.id,
                    "key": d.key,
                    "name": d.name,
                    "sprite": d.sprite,
                    "max_stack": d.max_stack,
                })
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
                let mut targets: Vec<PlayerHitTarget> = Vec::new();
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
            defs::Delivery::Cone { .. } => {
                serde_json::json!({"rejected": "cone_not_in_sandbox", "weapon": wid.0}).to_string()
            }
            defs::Delivery::Placed { .. } => {
                serde_json::json!({"rejected": "placed_not_in_sandbox", "weapon": wid.0})
                    .to_string()
            }
        }
    }

    /// Step projectiles and resolve whatever they hit. Returns JSON events.
    pub fn combat_step(&mut self, now: f32, dt: f32) -> String {
        let boxes: Vec<(u8, game_core::math::Aabb)> = self
            .players
            .iter()
            .filter(|p| p.stats.alive)
            .map(|p| (p.id, p.body.aabb()))
            .collect();
        let wind = self.map.meta.wind;
        let outcomes = self.projectiles.step(&self.map, &boxes, wind, now, dt);

        let mut events = Vec::new();
        for im in outcomes {
            let pid = im.id;
            let (at, _victim) = match im.outcome {
                ProjectileOutcome::Alive => continue,
                ProjectileOutcome::Exploded { at } => (at, None),
                ProjectileOutcome::HitPlayer { at, victim } => (at, Some(victim)),
            };
            // §C21: a drop of toxic rain does **not** explode. It lands and
            // becomes a puddle, and toxic rain leaves the mask byte-identical
            // (`docs/13` §3). Without this the sandbox detonates it as a bazooka
            // — see the fallback below, which treats every projectile as one —
            // so rain would dig craters here while digging nothing in a real
            // game, and `weather-visible` samples the sandbox.
            if game_core::effects::toxic::owns(im.weapon) {
                if let Some(t) = self.weather.toxic.as_mut() {
                    let p = t.land(at, now);
                    events.push(serde_json::json!({
                        "puddle": { "id": p.id, "x": p.pos.x, "y": p.pos.y, "r": p.radius }
                    }));
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
                    let mut targets = [PlayerHitTarget {
                        id: self.players[i].id,
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
                    self.players[i].stats.apply_damage(taken, src, now);
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
    /// 3 fog. The sandbox control for the M5 checkpoint.
    pub fn force_effect(&mut self, kind: u8, now: f32) {
        let kind = match kind {
            0 => EffectKind::ToxicRain,
            1 => EffectKind::MeteorShower,
            2 => EffectKind::LavaBurst,
            _ => EffectKind::HeavyFog,
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
        }
    }

    /// Advance the scheduler and every active effect. Returns the hazards the
    /// client should draw, as JSON.
    pub fn weather_step(&mut self, now: f32, dt: f32) -> String {
        let Some(sched) = self.weather.scheduler.as_mut() else {
            return "{\"active\":[],\"puddles\":[],\"vents\":[],\"fog\":0.0}".to_string();
        };
        sched.tick(now, f32::MAX);

        let toxic_on = sched.is_active(EffectKind::ToxicRain);
        let meteor_on = sched.is_active(EffectKind::MeteorShower);
        let lava_on = sched.is_active(EffectKind::LavaBurst);
        let fog_on = sched.is_active(EffectKind::HeavyFog);

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
                    },
                    "phase": match e.phase {
                        EffectPhase::Telegraph => "telegraph",
                        EffectPhase::Active => "active",
                        EffectPhase::Done => "done",
                    },
                })
            })
            .collect();

        // Every effect damages through the same PlayerHitTarget path a weapon
        // does, so shields and i-frames are handled once rather than per effect.
        let mut puddles = Vec::new();
        if let Some(t) = self.weather.toxic.as_mut() {
            let hits: HitLog = Default::default();
            {
                let mut targets = build_targets(&mut self.players, &hits);
                t.tick(
                    &mut self.projectiles,
                    &self.map,
                    &mut targets,
                    toxic_on,
                    now,
                    dt,
                );
            }
            apply_hits(&mut self.players, &hits.borrow(), now);
            for p in t.puddles() {
                puddles.push(serde_json::json!({"x": p.pos.x, "y": p.pos.y, "r": p.radius}));
            }
        }

        if let Some(m) = self.weather.meteor.as_mut() {
            m.tick(&mut self.projectiles, &self.map, meteor_on, now);
        }

        let mut vents = Vec::new();
        if let Some(l) = self.weather.lava.as_mut() {
            let hits: HitLog = Default::default();
            {
                let mut targets = build_targets(&mut self.players, &hits);
                l.tick(&mut self.map, &mut targets, lava_on, now, dt);
            }
            apply_hits(&mut self.players, &hits.borrow(), now);
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

        serde_json::json!({
            "active": active,
            "puddles": puddles,
            "vents": vents,
            "fog": fog,
        })
        .to_string()
    }
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
        TOMBSTONE_W => c::TOMBSTONE_W,
        TOMBSTONE_H => c::TOMBSTONE_H,
        MAX_TOMBSTONES => c::MAX_TOMBSTONES,
        VIEWPORT_W => c::VIEWPORT_W,
        VIEWPORT_H => c::VIEWPORT_H,
        CHUNK_SIZE => c::CHUNK_SIZE,
        INPUT_REDUNDANCY => c::INPUT_REDUNDANCY,
        MAX_INPUT_QUEUE => c::MAX_INPUT_QUEUE,
        SNAPSHOT_PLAYER_BYTES => c::SNAPSHOT_PLAYER_BYTES,
        SNAPSHOT_HEADER_BYTES => c::SNAPSHOT_HEADER_BYTES,
        SNAPSHOT_FOOTER_BYTES => c::SNAPSHOT_FOOTER_BYTES,
        SNAPSHOT_HZ => c::SNAPSHOT_HZ,
        INTERP_DELAY_MS => c::INTERP_DELAY_MS,
        RECONCILE_EPSILON_PX => c::RECONCILE_EPSILON_PX,
        COARSE_CELL => c::COARSE_CELL,
        BEDROCK_H => c::BEDROCK_H,
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
        CHUNK_REBAKE_BUDGET => c::CHUNK_REBAKE_BUDGET,
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
        MINIMAP_W => c::MINIMAP_W,
        MINIMAP_H => c::MINIMAP_H,
        MINIMAP_ALPHA => c::MINIMAP_ALPHA,
        MINIMAP_REVEAL_R => c::MINIMAP_REVEAL_R,
        AIM_DEADZONE => c::AIM_DEADZONE,
        SUN_RADIUS => c::SUN_RADIUS,
        MOON_RADIUS => c::MOON_RADIUS,
        SKY_BODY_ARC_H => c::SKY_BODY_ARC_H,
        SKY_BODY_PARALLAX => c::SKY_BODY_PARALLAX,
        STAR_COUNT => c::STAR_COUNT,
        STAR_FADE_START => c::STAR_FADE_START,
        NIGHT_DARKNESS => c::NIGHT_DARKNESS,
        FOV_DAY => c::FOV_DAY,
        FOV_NIGHT => c::FOV_NIGHT,
        FOV_FOG_MULT => c::FOV_FOG_MULT,
        FOV_HEALTH_MIN_MULT => c::FOV_HEALTH_MIN_MULT,
        FOV_EDGE_SOFTNESS => c::FOV_EDGE_SOFTNESS,
        FLASHLIGHT_RANGE => c::FLASHLIGHT_RANGE,
        FLASHLIGHT_CONE_DEG => c::FLASHLIGHT_CONE_DEG,
        FLASHLIGHT_AMBIENT_MULT => c::FLASHLIGHT_AMBIENT_MULT,
        BASE_HEALTH => c::BASE_HEALTH,
        RESPAWN_DELAY => c::RESPAWN_DELAY,
        // How close you have to be to take something off the ground. The
        // browser check that walks a player at a crate asserts against it, and
        // a check that hardcodes 20 stays green against a drifted sim (§A19).
        PICKUP_RADIUS => c::PICKUP_RADIUS,
        // §C20's threshold. A browser check that walks and then fires has to
        // know when it has actually stopped, and one carrying its own copy of
        // this number would stay green against a drifted sim (§A19).
        FIRE_MOVE_MAX_SPEED => c::FIRE_MOVE_MAX_SPEED,
        // The fastest a body moves under its own power. A browser check that
        // samples a position on a timer needs it to know how far the subject
        // could have travelled between two samples.
        JETPACK_MAX_SPEED => c::JETPACK_MAX_SPEED,
        LAVA_BURN_RADIUS => c::LAVA_BURN_RADIUS,
        TOXIC_PUDDLE_RADIUS => c::TOXIC_PUDDLE_RADIUS,
        HEALTH_CAP => c::HEALTH_CAP,
        TRACER_LIFETIME => c::TRACER_LIFETIME,
        TRACER_WIDTH => c::TRACER_WIDTH,
        PROJECTILE_TRAIL_LEN => c::PROJECTILE_TRAIL_LEN,
        MUZZLE_OFFSET => c::MUZZLE_OFFSET,
        BAZOOKA_BLAST_RADIUS => c::BAZOOKA_BLAST_RADIUS,
        GRENADE_BLAST_RADIUS => c::GRENADE_BLAST_RADIUS,
        SMG_BLAST_RADIUS => c::SMG_BLAST_RADIUS,
        SMG_RANGE => c::SMG_RANGE,
        // The kill switch, not a tunable: the renderer skips the whole
        // classifier when this is false, so it never pays for a mask it will
        // not draw.
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
        TELEPORT_PADS => c::TELEPORT_PADS,
        PAD_W => c::PAD_W,
        PAD_H => c::PAD_H,
        PAD_TOUCH_SLACK => c::PAD_TOUCH_SLACK,
        TELEPORT_CHARGE => c::TELEPORT_CHARGE,
        TELEPORT_COOLDOWN => c::TELEPORT_COOLDOWN,
        TELEPORT_ARM_DISTANCE => c::TELEPORT_ARM_DISTANCE,
        BATTERY_MAX => c::BATTERY_MAX,
        MAX_HEALS => c::MAX_HEALS,
        QUICK_SLOTS => c::QUICK_SLOTS,
        BACKPACK_SLOTS => c::BACKPACK_SLOTS,
        INVENTORY_SLOTS => c::INVENTORY_SLOTS,
        MEDKIT_HEAL => c::MEDKIT_HEAL,
        MAX_BATTERIES => c::MAX_BATTERIES,
        BATTERY_PACK_AMOUNT => c::BATTERY_PACK_AMOUNT,
        SHIELD_DRAIN => c::SHIELD_DRAIN,
        SHIELD_DURATION => c::SHIELD_DURATION,
        DAY_DURATION => c::DAY_DURATION,
        NIGHT_DURATION => c::NIGHT_DURATION,
        CYCLE_TRANSITION => c::CYCLE_TRANSITION,
        BTN_LEFT => game_core::player::input::button::LEFT,
        BTN_RIGHT => game_core::player::input::button::RIGHT,
        BTN_UP => game_core::player::input::button::UP,
        BTN_DOWN => game_core::player::input::button::DOWN,
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
    use wasm_bindgen_test::wasm_bindgen_test;

    #[wasm_bindgen_test]
    fn generate_sets_the_requested_dimensions() {
        let mut core = GameCore::new();
        core.generate(4242, 0, 1);
        assert_eq!(core.width(), 3072);
        assert_eq!(core.height(), 1536);
        core.generate(4242, 0, 2);
        assert_eq!(core.width(), 4096);
        assert_eq!(core.height(), 2048);
    }

    #[wasm_bindgen_test]
    fn mask_byte_len_covers_every_pixel() {
        let mut core = GameCore::new();
        core.generate(1, 0, 0);
        let bits = core.width() as usize * core.height() as usize;
        assert_eq!(core.mask_byte_len(), bits / 8);
        assert!(!core.mask_ptr().is_null());
    }

    #[wasm_bindgen_test]
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

    #[wasm_bindgen_test]
    fn a_carve_actually_removes_terrain() {
        let mut core = GameCore::new();
        core.generate(4242, 0, 0);
        let (x, y) = (core.width() as i32 / 2, core.height() as i32 - 60);
        assert!(core.solid_at(x, y), "precondition: solid before the carve");
        core.carve(x, y, 20);
        assert!(!core.solid_at(x, y));
    }

    #[wasm_bindgen_test]
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

    #[wasm_bindgen_test]
    fn load_mask_rejects_malformed_bytes_without_panicking() {
        let mut core = GameCore::new();
        assert!(!core.load_mask(256, 256, &[0xFF; 32]));
        assert!(!core.load_mask(256, 256, &[]));
        assert!(!core.load_mask(0, 0, &[0]));
        // A width that is not a multiple of 64 cannot describe a mask.
        assert!(!core.load_mask(100, 100, &[0]));
    }

    #[wasm_bindgen_test]
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

    #[wasm_bindgen_test]
    fn player_state_round_trips() {
        let mut core = GameCore::new();
        core.add_player(2, 0.0, 0.0);
        core.set_player_state(2, 12.5, -3.25, 7.0, -1.5, true, 2.5);
        let s = core.player_state(2);
        assert_eq!(s[0], 12.5);
        assert_eq!(s[1], -3.25);
        assert_eq!(s[2], 7.0);
        assert_eq!(s[3], -1.5);
        assert_eq!(s[4], 1.0);
        assert_eq!(s[5], 2.5);
    }

    #[wasm_bindgen_test]
    fn an_unknown_player_id_is_empty_not_a_panic() {
        let core = GameCore::new();
        assert_eq!(core.player_state(99).len(), 0);
    }

    #[wasm_bindgen_test]
    fn duplicate_add_player_is_ignored() {
        let mut core = GameCore::new();
        core.add_player(1, 10.0, 10.0);
        core.add_player(1, 900.0, 900.0);
        let s = core.player_state(1);
        assert_eq!(s[0], 10.0, "the second add must not move the player");
    }

    #[wasm_bindgen_test]
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

    #[wasm_bindgen_test]
    fn constants_json_carries_the_viewport_and_camera_values() {
        let v: serde_json::Value = serde_json::from_str(&constants_json()).expect("valid json");
        assert_eq!(v["VIEWPORT_W"], 1280);
        assert_eq!(v["VIEWPORT_H"], 720);
        assert_eq!(v["CHUNK_SIZE"], 256);
        assert_eq!(v["CAMERA_ZOOM"], 2.0);
        assert_eq!(v["PLAYER_W"], 16.0);
        assert_eq!(v["PLAYER_H"], 28.0);
    }

    #[wasm_bindgen_test]
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
pub fn core_fov_radius(darkness: f32, fog_mult: f32, health: f32, flashlight_on: bool) -> f32 {
    game_core::world::cycle::fov_radius(darkness, fog_mult, health, flashlight_on)
}

/// The Rust darkness curve (§A13), exposed for the same reason.
#[wasm_bindgen]
pub fn core_darkness_at(u: f32) -> f32 {
    game_core::world::cycle::darkness_at(u)
}

/// Build the `PlayerHitTarget` view the effects damage through.
///
/// Damage is *recorded* rather than applied here: `PlayerState::apply_damage`
/// needs `&mut` on the same players the slice already borrows. Collecting
/// (id, amount) and applying afterwards keeps one damage path — shields,
/// i-frames and death all stay in `PlayerState` rather than being re-implemented
/// per effect.
type HitLog = std::rc::Rc<std::cell::RefCell<Vec<(u8, f32)>>>;

fn build_targets<'a>(players: &'a mut [LocalPlayer], hits: &HitLog) -> Vec<PlayerHitTarget<'a>> {
    players
        .iter_mut()
        .map(|p| {
            let id = p.id;
            let alive = p.stats.alive;
            let pos = p.body.pos;
            let log = hits.clone();
            PlayerHitTarget {
                id,
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
fn apply_hits(players: &mut [LocalPlayer], hits: &[(u8, f32)], now: f32) {
    for (id, amount) in hits {
        if let Some(p) = players.iter_mut().find(|p| p.id == *id) {
            p.stats
                .apply_damage(*amount, DamageSource::Weather(EffectKind::ToxicRain), now);
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
