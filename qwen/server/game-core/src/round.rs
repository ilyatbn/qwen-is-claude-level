//! `round` — round state machine, scoring, respawn, scheduler (docs/05 §2).
//!
//! `Round::step` is the single game-core entry point (docs/05 §1). It owns
//! everything a round needs, which is deliberate: the post-Phase-3 end-to-end
//! pass found five seams where two subsystems each assumed the other acted, and
//! all five were "nobody owns this". They are owned here:
//!
//! | Seam | Owner |
//! |---|---|
//! | `ammo[]` inherited stale counts | [`RoundPlayer::ammo`], reset on pickup |
//! | stale colliders after destruction | [`Round::step`] always rebuilds |
//! | players leaving the map | [`Round::enforce_bounds`] |
//! | `apply_damage` had no killer | [`DamageSource`] |
//! | no crate/timed scheduler | [`Round::run_spawn_schedule`] |

use crate::effects::EffectSchedule;
use crate::items::*;
use crate::map::{Map, Scale};
use crate::physics::PhysicsWorld;
use crate::player::{player_config::*, Player, PlayerInputState, DT};
use crate::protocol::{
    FogState, GroundItemSnap, InputFrame, ItemId, PlayerSnap, ProjectileSnap, Snapshot,
};
use crate::rng::GameRng;
use crate::tiles::{TileDestroyed, TILE_SIZE};
use crate::Vec2;

/// Round length, seconds (docs/05 §2: "Round (240 s = 4 min)").
pub const ROUND_DURATION_S: f32 = 240.0;
/// Countdown before a round starts, seconds (docs/05 §2).
pub const COUNTDOWN_S: f32 = 3.0;
/// Post-round scoreboard, seconds (docs/05 §2: "RoundEnd (scores, 10 s)").
pub const ROUND_END_S: f32 = 10.0;
/// Respawn delay, seconds (docs/03 §2, §6).
pub const RESPAWN_DELAY_S: f32 = 3.0;
/// Maximum players in a room (docs/05 §2).
pub const MAX_PLAYERS: usize = 6;

/// docs/05 §2 room lifecycle.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RoundState {
    Lobby,
    Countdown,
    Running,
    Ended,
}

/// Who caused damage — the missing argument that made docs/04 §2's "no kill
/// credit for self" and docs/03 §6's "weather kills give no score to anyone"
/// inexpressible before T4.3.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DamageSource {
    /// A projectile or blast owned by a player.
    Player(u8),
    /// Weather (docs/02). Scores nobody.
    Weather,
}

/// Events broadcast immediately, not via snapshot (docs/05 §4).
#[derive(Debug, Clone, PartialEq)]
pub enum Event {
    RoundStarted { seed: u64, scale: Scale },
    RoundEnded,
    TileDestroyed { tiles: Vec<TileDestroyed>, version: u64 },
    ItemSpawned { item: ItemId, x: f32, y: f32, is_crate: bool },
    ItemPicked { player: u8, item: ItemId },
    CrateDropped { x: f32 },
    ProjectileFired { id: u32, owner: u8, kind: ItemId, x: f32, y: f32, angle: f32 },
    Explosion { x: f32, y: f32, radius: f32 },
    Kill { victim: u8, killer: Option<u8>, weapon: &'static str },
    Respawned { player: u8, x: f32, y: f32 },
}

/// Per-player round state. `Player` holds simulation state; this holds the
/// bookkeeping a round needs alongside it.
#[derive(Debug, Clone)]
pub struct RoundPlayer {
    pub player: Player,
    /// Ammo per inventory slot (docs/06 §4 carries it as a parallel array).
    ///
    /// Owned here and **reset on pickup** from `starting_ammo`. Before T4.1
    /// nothing owned it, so a weapon landing in a reused slot inherited
    /// whatever count was left there — found by the E2E stress harness.
    pub ammo: [u8; SLOT_COUNT],
    pub cooldowns: Cooldowns,
    pub input: PlayerInputState,
    pub connected: bool,
    pub ready: bool,
}

impl RoundPlayer {
    fn new(player: Player) -> Self {
        RoundPlayer {
            player,
            ammo: [0; SLOT_COUNT],
            cooldowns: Cooldowns::new(),
            input: PlayerInputState::new(),
            connected: true,
            ready: false,
        }
    }
}

/// A whole round (docs/05 §1).
pub struct Round {
    pub state: RoundState,
    pub seed: u64,
    pub scale: Scale,
    pub map: Map,
    pub world: PhysicsWorld,
    pub players: Vec<RoundPlayer>,
    pub ground: Vec<GroundItem>,
    pub crates: Vec<Crate>,
    pub projectiles: Vec<Projectile>,
    pub schedule: EffectSchedule,
    rng: GameRng,
    ids: ItemIdCounter,
    /// Ticks elapsed in the current state.
    pub tick: u64,
    /// Seconds elapsed in the current state.
    pub state_time_s: f32,
    /// Source-C / source-D spawns already fired, so each fires once.
    crates_dropped: usize,
    timed_spawned: usize,
}

impl Round {
    /// Create an empty lobby.
    pub fn new(seed: u64, scale: Scale) -> Self {
        let map = Map::generate(seed, scale);
        let world = PhysicsWorld::new(&map);
        Round {
            state: RoundState::Lobby,
            seed,
            scale,
            map,
            world,
            players: Vec::new(),
            ground: Vec::new(),
            crates: Vec::new(),
            projectiles: Vec::new(),
            schedule: EffectSchedule::default(),
            rng: GameRng::new(seed),
            ids: ItemIdCounter::default(),
            tick: 0,
            state_time_s: 0.0,
            crates_dropped: 0,
            timed_spawned: 0,
        }
    }

    /// Add a player to the lobby (docs/05 §2). Returns their id, or `None`
    /// when the room is full — the 7th joiner gets `error{room_full}`.
    pub fn join(&mut self, name: String) -> Option<u8> {
        if self.players.len() >= MAX_PLAYERS {
            return None;
        }
        let id = self.players.len() as u8;
        let spawn = self
            .map
            .spawns
            .get(id as usize)
            .copied()
            .unwrap_or(Vec2::ZERO);
        let player = Player::new(id, name, Player::spawn_position(spawn));
        self.players.push(RoundPlayer::new(player));
        Some(id)
    }

    /// Mark a player ready (docs/05 §2).
    pub fn set_ready(&mut self, id: u8, ready: bool) {
        if let Some(p) = self.players.iter_mut().find(|p| p.player.id == id) {
            p.ready = ready;
        }
    }

    /// docs/05 §2: "all present players ready OR 6 players joined -> 3 s countdown".
    pub fn should_start_countdown(&self) -> bool {
        let present: Vec<&RoundPlayer> = self.players.iter().filter(|p| p.connected).collect();
        if present.is_empty() {
            return false;
        }
        present.len() >= MAX_PLAYERS || present.iter().all(|p| p.ready)
    }

    /// Begin the round proper (T4.1 step 2), in the docs/04 §6 determinism
    /// order: generate map -> shuffle spawns -> build effect schedule ->
    /// place A -> place B.
    pub fn start_round(&mut self, seed: u64, scale: Scale) -> Vec<Event> {
        self.seed = seed;
        self.scale = scale;
        self.rng = GameRng::new(seed);
        self.ids = ItemIdCounter::default();

        // 1. Map.
        self.map = Map::generate(seed, scale);
        // 2. Shuffle spawns (docs/03 §2: "Spawns are shuffled per round with
        //    the round RNG before assignment").
        let mut spawns = self.map.spawns.clone();
        self.rng.shuffle(&mut spawns);
        self.map.spawns = spawns;
        // 3. Effect schedule (docs/02 §8). T4.8 fills it in.
        self.schedule = EffectSchedule::build(&mut self.rng, ROUND_DURATION_S);
        // 4/5. Items.
        self.ground = place_initial(&self.map, &mut self.rng, &mut self.ids);
        let _hidden = place_hidden(&mut self.map, &mut self.rng);

        self.world = PhysicsWorld::new(&self.map);
        self.crates.clear();
        self.projectiles.clear();
        self.crates_dropped = 0;
        self.timed_spawned = 0;
        self.tick = 0;
        self.state_time_s = 0.0;
        self.state = RoundState::Running;

        // Place players at their (shuffled) spawns, resetting round state.
        for (index, rp) in self.players.iter_mut().enumerate() {
            let spawn = self.map.spawns.get(index).copied().unwrap_or(Vec2::ZERO);
            let id = rp.player.id;
            let name = rp.player.name.clone();
            let skin = rp.player.skin;
            rp.player = Player::new(id, name, Player::spawn_position(spawn));
            rp.player.skin = skin;
            rp.ammo = [0; SLOT_COUNT];
            rp.cooldowns.reset();
        }

        vec![Event::RoundStarted { seed, scale }]
    }

    /// Seconds elapsed in the running round.
    pub fn round_time_s(&self) -> f32 {
        self.state_time_s
    }

    /// Advance one tick (docs/05 §1). The single game-core entry point.
    pub fn step(&mut self, inputs: &[(u8, InputFrame)]) -> Vec<Event> {
        let mut events = Vec::new();
        for (id, frame) in inputs {
            if let Some(rp) = self.players.iter_mut().find(|p| p.player.id == *id) {
                rp.input.receive(*frame);
            }
        }

        match self.state {
            RoundState::Lobby => {
                if self.should_start_countdown() {
                    self.state = RoundState::Countdown;
                    self.state_time_s = 0.0;
                }
            }
            RoundState::Countdown => {
                self.state_time_s += DT;
                if self.state_time_s >= COUNTDOWN_S {
                    let seed = self.seed;
                    let scale = self.scale;
                    events.extend(self.start_round(seed, scale));
                }
            }
            RoundState::Running => {
                events.extend(self.step_running());
                self.state_time_s += DT;
                self.tick += 1;
                if self.state_time_s >= ROUND_DURATION_S {
                    self.state = RoundState::Ended;
                    self.state_time_s = 0.0;
                    events.push(Event::RoundEnded);
                }
            }
            RoundState::Ended => {
                self.state_time_s += DT;
            }
        }
        events
    }

    fn step_running(&mut self) -> Vec<Event> {
        let mut events = Vec::new();
        let tick = self.tick;

        // --- players ---
        for index in 0..self.players.len() {
            if !self.players[index].player.alive {
                self.try_respawn(index, tick, &mut events);
                continue;
            }
            let (frame, edges) = self.players[index].input.tick();
            let mut player = self.players[index].player.clone();
            player.step_tick(&self.world, &self.map, &frame, edges, DT);
            player.step_timers(DT);
            self.players[index].player = player;

            if let Some(slot) = edges.use_slot_pressed {
                let mut p = self.players[index].player.clone();
                let outcome = use_slot(&mut p, slot as usize);
                if matches!(outcome, UseOutcome::Consumed(_)) {
                    self.players[index].ammo[slot as usize] = 0;
                }
                self.players[index].player = p;
            }

            if frame.fire {
                let mut p = self.players[index].player.clone();
                let mut ammo = self.players[index].ammo;
                let mut cds = self.players[index].cooldowns.clone();
                if let FireResult::Fired(shots) =
                    try_fire(&mut p, &mut ammo, &mut cds, &mut self.ids, tick, DT)
                {
                    for shot in &shots {
                        events.push(Event::ProjectileFired {
                            id: shot.id, owner: shot.owner, kind: shot.kind,
                            x: shot.x, y: shot.y, angle: p.facing,
                        });
                    }
                    self.projectiles.extend(shots);
                }
                self.players[index].player = p;
                self.players[index].ammo = ammo;
                self.players[index].cooldowns = cds;
            }
        }

        self.enforce_bounds(&mut events);
        events.extend(self.step_projectiles());
        events.extend(self.step_crates());
        events.extend(self.run_spawn_schedule());
        events.extend(self.collect_pickups());
        enforce_projectile_cap(&mut self.projectiles);
        events
    }

    /// Players cannot leave the world (E2E finding: one of six ended outside
    /// the map after a full round, with nothing to catch it).
    ///
    /// Falling out of the bottom is lethal — the map has no floor, and the
    /// alternative is a player accelerating forever off-screen. Sideways is
    /// clamped, since the map's vertical edges are walls in spirit.
    fn enforce_bounds(&mut self, events: &mut Vec<Event>) {
        let (width, height) = self.map.pixel_size();
        for index in 0..self.players.len() {
            if !self.players[index].player.alive {
                continue;
            }
            let pos = self.players[index].player.pos;
            if pos.y > height + BODY_HEIGHT {
                let victim = self.players[index].player.id;
                self.kill(index, DamageSource::Weather, "void", events);
                let _ = victim;
                continue;
            }
            let clamped_x = pos.x.clamp(BODY_HALF_WIDTH, width - BODY_HALF_WIDTH);
            if clamped_x != pos.x {
                self.players[index].player.pos.x = clamped_x;
                self.players[index].player.vel.x = 0.0;
            }
        }
    }

    fn step_projectiles(&mut self) -> Vec<Event> {
        let mut events = Vec::new();
        let snapshot: Vec<(u8, f32, f32)> = self
            .players
            .iter()
            .filter(|p| p.player.alive)
            .map(|p| (p.player.id, p.player.pos.x, p.player.pos.y))
            .collect();

        let mut resolved: Vec<(usize, f32, f32, Option<u8>)> = Vec::new();
        for (index, projectile) in self.projectiles.iter_mut().enumerate() {
            match step_projectile(projectile, &self.map, &snapshot, DT) {
                ProjectileStep::Flying => {}
                ProjectileStep::Impact { x, y } => resolved.push((index, x, y, None)),
                ProjectileStep::HitPlayer { player, x, y } => {
                    resolved.push((index, x, y, Some(player)))
                }
            }
        }

        let mut destroyed_all: Vec<TileDestroyed> = Vec::new();
        for (index, x, y, hit) in resolved.iter().rev() {
            let projectile = self.projectiles[*index];
            let weapon = weapon_name(projectile.kind);
            if projectile.explosive {
                let destroyed = self.map.apply_blast(*x, *y, projectile.radius, projectile.damage);
                events.push(Event::Explosion { x: *x, y: *y, radius: projectile.radius });
                if !destroyed.is_empty() {
                    events.push(Event::TileDestroyed {
                        tiles: destroyed.clone(),
                        version: self.map.version,
                    });
                    destroyed_all.extend(destroyed);
                }
                for pi in 0..self.players.len() {
                    if !self.players[pi].player.alive {
                        continue;
                    }
                    let p = self.players[pi].player.pos;
                    let distance = (p.x - x).hypot(p.y - y);
                    let damage =
                        Player::blast_damage_at(distance, projectile.radius, projectile.damage);
                    if damage > 0.0
                        && self.players[pi].player.apply_damage(damage)
                    {
                        self.kill(pi, DamageSource::Player(projectile.owner), weapon, &mut events);
                    }
                }
            } else if let Some(victim) = hit {
                if let Some(pi) = self.players.iter().position(|p| p.player.id == *victim) {
                    if self.players[pi].player.apply_damage(projectile.damage) {
                        self.kill(pi, DamageSource::Player(projectile.owner), weapon, &mut events);
                    }
                }
            }
            self.projectiles.remove(*index);
        }

        // Colliders ALWAYS rebuild after destruction — the E2E harness showed a
        // skipped rebuild leaves a player standing on air with nothing to
        // detect it.
        if !destroyed_all.is_empty() {
            self.world.rebuild_segments(&self.map, &destroyed_all);
            for event in &destroyed_all {
                if let Some(item) = event.item {
                    let centre = Map::tile_center(event.x, event.y);
                    self.ground.push(GroundItem {
                        id: self.ids.next(),
                        item,
                        x: centre.x,
                        y: centre.y,
                        is_crate: false,
                        hidden: false,
                    });
                    events.push(Event::ItemSpawned {
                        item, x: centre.x, y: centre.y, is_crate: false,
                    });
                }
            }
        }
        events
    }

    fn step_crates(&mut self) -> Vec<Event> {
        let mut events = Vec::new();
        let tick = self.tick;
        for index in 0..self.crates.len() {
            let mut c = self.crates[index];
            step_crate(&mut c, &self.map, tick, DT);
            self.crates[index] = c;
        }
        // Opened by a player, or expired.
        let mut opened: Vec<usize> = Vec::new();
        for (index, c) in self.crates.iter().enumerate() {
            let reached = self
                .players
                .iter()
                .any(|p| p.player.alive && player_reaches_crate(c, p.player.pos.x, p.player.pos.y));
            let expired = c.expires_tick.is_some_and(|t| tick >= t);
            if reached || expired {
                opened.push(index);
            }
        }
        for index in opened.into_iter().rev() {
            let c = self.crates[index];
            for item in open_crate(&c, &mut self.ids) {
                events.push(Event::ItemSpawned {
                    item: item.item, x: item.x, y: item.y, is_crate: false,
                });
                self.ground.push(item);
            }
            self.crates.remove(index);
        }
        events
    }

    /// Source-C and source-D timers (docs/04 §3 rows C and D).
    ///
    /// Nothing fired these before T4.1 — the E2E harness reported both sources
    /// as implemented but unreachable.
    fn run_spawn_schedule(&mut self) -> Vec<Event> {
        let mut events = Vec::new();
        let now = self.state_time_s;

        while self.crates_dropped < CRATE_DROP_TIMES_S.len()
            && now >= CRATE_DROP_TIMES_S[self.crates_dropped]
        {
            let c = spawn_crate(&self.map, &mut self.rng, &mut self.ids);
            events.push(Event::CrateDropped { x: c.x });
            self.crates.push(c);
            self.crates_dropped += 1;
        }

        let times = source_d_times(ROUND_DURATION_S);
        while self.timed_spawned < times.len() && now >= times[self.timed_spawned] {
            if let Some(item) = spawn_timed_item(&self.map, &mut self.rng, &mut self.ids) {
                events.push(Event::ItemSpawned {
                    item: item.item, x: item.x, y: item.y, is_crate: false,
                });
                self.ground.push(item);
            }
            self.timed_spawned += 1;
        }
        events
    }

    fn collect_pickups(&mut self) -> Vec<Event> {
        let mut events = Vec::new();
        let mut taken: Vec<usize> = Vec::new();
        for pi in 0..self.players.len() {
            if !self.players[pi].player.alive {
                continue;
            }
            let (px, py) = (self.players[pi].player.pos.x, self.players[pi].player.pos.y);
            for (gi, item) in self.ground.iter().enumerate() {
                if taken.contains(&gi) {
                    continue;
                }
                let mut inventory = self.players[pi].player.inventory.clone();
                if let Pickup::Taken { slot, item: got } = try_pickup(&mut inventory, item, px, py) {
                    self.players[pi].player.inventory = inventory;
                    // Ammo is RESET here, never inherited (E2E finding).
                    self.players[pi].ammo[slot] = starting_ammo(got);
                    taken.push(gi);
                    events.push(Event::ItemPicked { player: self.players[pi].player.id, item: got });
                }
            }
        }
        taken.sort_unstable();
        for gi in taken.into_iter().rev() {
            self.ground.remove(gi);
        }
        events
    }

    /// Kill pipeline (docs/03 §6, T4.3).
    fn kill(&mut self, victim_index: usize, source: DamageSource, weapon: &'static str, events: &mut Vec<Event>) {
        let victim_id = self.players[victim_index].player.id;
        self.players[victim_index].player.alive = false;
        self.players[victim_index].player.health = 0.0;
        self.players[victim_index].player.deaths += 1;
        self.players[victim_index].player.score -= 1;
        self.players[victim_index].player.respawn_at_tick =
            Some(self.tick + (RESPAWN_DELAY_S / DT) as u64);

        // docs/03 §6: killer +1, but only when the killer is another player.
        // "weather kills give no score to anyone", and self-kills score nobody.
        let killer = match source {
            DamageSource::Player(id) if id != victim_id => {
                if let Some(k) = self.players.iter_mut().find(|p| p.player.id == id) {
                    k.player.kills += 1;
                    k.player.score += 1;
                }
                Some(id)
            }
            DamageSource::Player(id) => Some(id),
            DamageSource::Weather => None,
        };
        events.push(Event::Kill { victim: victim_id, killer, weapon });
    }

    fn try_respawn(&mut self, index: usize, tick: u64, events: &mut Vec<Event>) {
        let Some(at) = self.players[index].player.respawn_at_tick else {
            return;
        };
        if tick < at {
            return;
        }
        let spawn = self.farthest_spawn_from_living(index);
        let rp = &mut self.players[index];
        // docs/03 §2: health 100, shield cleared, jetpack full, inventory KEPT.
        rp.player.pos = Player::spawn_position(spawn);
        rp.player.vel = Vec2::ZERO;
        rp.player.health = BASE_HEALTH;
        rp.player.max_health = BASE_HEALTH;
        rp.player.shield = Default::default();
        rp.player.overcharge = Default::default();
        rp.player.jetpack.fuel = JETPACK_FUEL_MAX;
        rp.player.alive = true;
        rp.player.respawn_at_tick = None;
        rp.cooldowns.reset();
        events.push(Event::Respawned {
            player: rp.player.id,
            x: rp.player.pos.x,
            y: rp.player.pos.y,
        });
    }

    /// docs/03 §2: "placed at the spawn farthest (Chebyshev, tile distance)
    /// from all living players".
    fn farthest_spawn_from_living(&self, respawning: usize) -> Vec2 {
        let living: Vec<Vec2> = self
            .players
            .iter()
            .enumerate()
            .filter(|(i, p)| *i != respawning && p.player.alive)
            .map(|(_, p)| Vec2::new(p.player.pos.x / TILE_SIZE, p.player.pos.y / TILE_SIZE))
            .collect();

        let mut best = self.map.spawns.first().copied().unwrap_or(Vec2::ZERO);
        let mut best_score = f32::NEG_INFINITY;
        for spawn in &self.map.spawns {
            let score = living
                .iter()
                .map(|l| (spawn.x - l.x).abs().max((spawn.y - l.y).abs()))
                .fold(f32::INFINITY, f32::min);
            let score = if living.is_empty() { 0.0 } else { score };
            if score > best_score {
                best_score = score;
                best = *spawn;
            }
        }
        best
    }

    /// Build the wire snapshot for this tick (docs/06 §4).
    ///
    /// `players` is always 6 entries — missing players are present with
    /// `alive=false, x=y=0` (docs/06 §4), which the fixed `[PlayerSnap; 6]`
    /// type makes unrepresentable-if-wrong.
    pub fn snapshot(&self) -> Snapshot {
        let blank = |id: u8| PlayerSnap {
            id, name: String::new(), skin: 0, x: 0.0, y: 0.0, facing: 0.0,
            health: 0.0, max_health: BASE_HEALTH, shield_remaining: 0.0,
            jetpack_fuel: 0.0, fov: 0.0, alive: false, respawn_in_s: 0.0,
            score: 0, slots: [None, None, None, None, None, None],
            selected: 0, ammo: [0; SLOT_COUNT],
        };

        let day_phase = crate::effects::day_phase(self.state_time_s);
        let players: [PlayerSnap; 6] = std::array::from_fn(|index| {
            let Some(rp) = self.players.get(index) else {
                return blank(index as u8);
            };
            let p = &rp.player;
            let respawn_in_s = p
                .respawn_at_tick
                .map(|at| at.saturating_sub(self.tick) as f32 * DT)
                .unwrap_or(0.0);
            PlayerSnap {
                id: p.id,
                name: p.name.clone(),
                skin: p.skin,
                x: p.pos.x,
                y: p.pos.y,
                facing: p.facing,
                health: p.health,
                max_health: p.max_health,
                shield_remaining: p.shield.remaining_s,
                jetpack_fuel: p.jetpack.fuel,
                fov: Player::compute_fov(
                    day_phase, false, p.health,
                    p.inventory.contains(ItemId::Flashlight),
                ),
                alive: p.alive,
                respawn_in_s,
                score: p.score,
                slots: std::array::from_fn(|s| {
                    p.inventory.slots[s].map(|i| i.as_str().to_string())
                }),
                selected: p.inventory.selected,
                ammo: rp.ammo,
            }
        });

        Snapshot {
            tick: self.tick,
            round_time_s: self.state_time_s,
            day_phase,
            fog: FogState { active: false, remaining_s: 0.0 },
            effect: None,
            map_version: self.map.version,
            players,
            items: self
                .ground
                .iter()
                .map(|g| GroundItemSnap {
                    item: g.item.as_str().to_string(), x: g.x, y: g.y, is_crate: false,
                })
                .chain(self.crates.iter().map(|c| GroundItemSnap {
                    item: "crate".to_string(), x: c.x, y: c.y, is_crate: true,
                }))
                .collect(),
            projectiles: self
                .projectiles
                .iter()
                .map(|p| ProjectileSnap {
                    id: p.id, kind: p.kind.as_str().to_string(), x: p.x, y: p.y,
                })
                .collect(),
        }
    }

    /// docs/00 §2: "Snapshots: 10 Hz (every 2nd tick)".
    ///
    /// DEVIATIONS.md D12: T4.9's Acceptance asks for a wall-clock rate check,
    /// which is flaky under load. This is the deterministic invariant that
    /// "10 Hz" means given a fixed 20 Hz tick.
    pub fn should_broadcast_snapshot(&self) -> bool {
        self.tick % 2 == 0
    }

    /// Scores for `round_ended` (docs/06 §2).
    pub fn scores(&self) -> Vec<(u8, String, i32, u32, u32)> {
        self.players
            .iter()
            .map(|p| {
                (p.player.id, p.player.name.clone(), p.player.score, p.player.kills, p.player.deaths)
            })
            .collect()
    }
}

/// Wire name for a weapon (docs/06 §2 `kill.weapon`).
fn weapon_name(kind: ItemId) -> &'static str {
    kind.as_str()
}

/// T4.1 round state-machine tests.
#[cfg(test)]
mod round_tests {
    use super::*;

    fn lobby_with(players: usize) -> Round {
        let mut round = Round::new(1, Scale::Small);
        for id in 0..players {
            round.join(format!("p{id}"));
        }
        round
    }

    fn ready_all(round: &mut Round) {
        let ids: Vec<u8> = round.players.iter().map(|p| p.player.id).collect();
        for id in ids {
            round.set_ready(id, true);
        }
    }

    #[test]
    fn round_state_machine_full_cycle() {
        // docs/08 §1 (round row) + T4.1 Acceptance: "a 6-player fake lobby
        // reaches Running after exactly 3 s of countdown ticks".
        let mut round = lobby_with(6);
        assert_eq!(round.state, RoundState::Lobby);

        // 6 players joined is itself enough to start (docs/05 §2).
        round.step(&[]);
        assert_eq!(round.state, RoundState::Countdown, "6 players should start the countdown");

        // 3 s = 60 ticks. The exact tick is subject to float accumulation
        // (adding 0.05 sixty times does not land exactly on 3.0), so assert
        // still-counting just before and Running just after, as with the
        // shield and fuse timers.
        for tick in 0..59 {
            round.step(&[]);
            assert_eq!(round.state, RoundState::Countdown, "left countdown early at tick {tick}");
        }
        let mut events = Vec::new();
        for _ in 0..2 {
            events.extend(round.step(&[]));
            if round.state == RoundState::Running {
                break;
            }
        }
        assert_eq!(round.state, RoundState::Running, "countdown did not end by 3.05 s");
        assert!(
            events.iter().any(|e| matches!(e, Event::RoundStarted { .. })),
            "entering Running did not emit RoundStarted",
        );
    }

    #[test]
    fn round_240s() {
        // docs/08 §1 (round row): the round lasts 240 s.
        let mut round = lobby_with(6);
        round.start_round(1, Scale::Small);
        assert_eq!(round.state, RoundState::Running);

        // 240 s = 4800 ticks.
        for _ in 0..4799 {
            round.step(&[]);
        }
        assert_eq!(round.state, RoundState::Running, "the round ended early");
        let mut events = Vec::new();
        for _ in 0..3 {
            events.extend(round.step(&[]));
            if round.state == RoundState::Ended {
                break;
            }
        }
        assert_eq!(round.state, RoundState::Ended, "the round did not end at 240 s");
        assert!(events.iter().any(|e| matches!(e, Event::RoundEnded)));
        assert!(
            (round.tick as f32 * DT - 240.0).abs() < 0.2,
            "the round ran for {} s, expected ~240",
            round.tick as f32 * DT,
        );
    }

    #[test]
    fn restart_new_seed() {
        // docs/08 §1 (round row) + T4.1 step 3: "restart -> NEW seed".
        let mut round = lobby_with(2);
        round.start_round(1, Scale::Small);
        let first = round.map.tiles.clone();
        round.start_round(2, Scale::Small);
        assert_ne!(first, round.map.tiles, "restarting with a new seed reused the map");
        assert_eq!(round.seed, 2);
        // A restart resets round progress.
        assert_eq!(round.tick, 0);
        assert_eq!(round.state_time_s, 0.0);
    }

    #[test]
    fn max_6_players() {
        // docs/08 §1 (round row) + docs/05 §2: "Max 6 players; 7th joiner gets
        // error { code: room_full }".
        let mut round = Round::new(1, Scale::Small);
        for id in 0..6 {
            assert_eq!(round.join(format!("p{id}")), Some(id as u8), "player {id} should join");
        }
        assert_eq!(round.join("seventh".into()), None, "the 7th joiner must be refused");
        assert_eq!(round.players.len(), 6);
    }

    #[test]
    fn a_partial_lobby_waits_for_everyone_to_be_ready() {
        // docs/05 §2: "all present players ready OR 6 players joined".
        let mut round = lobby_with(3);
        round.step(&[]);
        assert_eq!(round.state, RoundState::Lobby, "an unready lobby started anyway");

        round.set_ready(0, true);
        round.set_ready(1, true);
        round.step(&[]);
        assert_eq!(round.state, RoundState::Lobby, "started with one player unready");

        ready_all(&mut round);
        round.step(&[]);
        assert_eq!(round.state, RoundState::Countdown);
    }

    #[test]
    fn an_empty_lobby_never_starts() {
        let mut round = Round::new(1, Scale::Small);
        for _ in 0..100 {
            round.step(&[]);
        }
        assert_eq!(round.state, RoundState::Lobby);
    }

    #[test]
    fn start_round_follows_the_documented_determinism_order() {
        // docs/04 §6: map -> shuffle spawns -> effect schedule -> place A ->
        // place B. Reconstructed by hand; a different order or draw count
        // gives a different result.
        let mut round = lobby_with(6);
        round.start_round(5, Scale::Small);

        let mut rng = GameRng::new(5);
        let mut map = Map::generate(5, Scale::Small);
        let mut spawns = map.spawns.clone();
        rng.shuffle(&mut spawns);
        map.spawns = spawns;
        let _schedule = EffectSchedule::build(&mut rng, ROUND_DURATION_S);
        let mut ids = ItemIdCounter::default();
        let ground = place_initial(&map, &mut rng, &mut ids);
        let hidden = place_hidden(&mut map, &mut rng);

        assert_eq!(round.map.spawns, map.spawns, "spawn shuffle differs");
        assert_eq!(round.ground, ground, "source-A placement differs");
        assert_eq!(round.map.tiles, map.tiles, "source-B placement differs");
        assert_eq!(hidden.len(), 4);
    }

    // --- the five seams the E2E stress harness found ---

    #[test]
    fn ammo_is_reset_on_pickup_not_inherited() {
        // E2E finding: nothing owned ammo[], so a weapon landing in a reused
        // slot inherited whatever count was left there.
        let mut round = lobby_with(1);
        round.start_round(1, Scale::Small);
        round.players[0].ammo[0] = 99;
        let pos = round.players[0].player.pos;
        round.ground.push(GroundItem {
            id: 1, item: ItemId::Rocket, x: pos.x, y: pos.y, is_crate: false, hidden: false,
        });
        round.step(&[]);
        assert_eq!(round.players[0].player.inventory.slots[0], Some(ItemId::Rocket));
        assert_eq!(
            round.players[0].ammo[0], 6,
            "picking up a rocket must set ammo to its documented 6, not inherit 99",
        );
    }

    #[test]
    fn a_player_falling_out_of_the_world_is_killed_not_lost() {
        // E2E finding: one of six players ended outside the map with nothing
        // to catch it.
        let mut round = lobby_with(1);
        round.start_round(1, Scale::Small);
        let (_, height) = round.map.pixel_size();
        round.players[0].player.pos.y = height + 500.0;
        round.step(&[]);
        assert!(!round.players[0].player.alive, "a player below the map survived");
        assert_eq!(round.players[0].player.deaths, 1);
    }

    #[test]
    fn weather_kills_score_nobody() {
        // docs/03 §6: "weather kills give no score to anyone".
        let mut round = lobby_with(2);
        round.start_round(1, Scale::Small);
        let mut events = Vec::new();
        round.kill(0, DamageSource::Weather, "lava", &mut events);
        assert_eq!(round.players[0].player.score, -1, "the victim loses a point");
        assert_eq!(round.players[0].player.deaths, 1);
        assert_eq!(round.players[1].player.score, 0, "another player gained a point");
        assert!(
            matches!(events[0], Event::Kill { killer: None, .. }),
            "a weather kill must report no killer",
        );
    }

    #[test]
    fn a_self_kill_credits_nobody() {
        // docs/04 §2: "Projectile hitting its owner: allowed (self-damage), no
        // kill credit."
        let mut round = lobby_with(2);
        round.start_round(1, Scale::Small);
        let victim = round.players[0].player.id;
        let mut events = Vec::new();
        round.kill(0, DamageSource::Player(victim), "rocket", &mut events);
        assert_eq!(round.players[0].player.score, -1);
        assert_eq!(round.players[0].player.kills, 0, "a self-kill counted as a kill");
    }

    #[test]
    fn a_player_kill_scores_both_sides() {
        // docs/03 §6: victim -1, killer +1.
        let mut round = lobby_with(2);
        round.start_round(1, Scale::Small);
        let killer = round.players[1].player.id;
        let mut events = Vec::new();
        round.kill(0, DamageSource::Player(killer), "rocket", &mut events);
        assert_eq!(round.players[0].player.score, -1);
        assert_eq!(round.players[0].player.deaths, 1);
        assert_eq!(round.players[1].player.score, 1);
        assert_eq!(round.players[1].player.kills, 1);
        assert!(matches!(events[0], Event::Kill { killer: Some(k), .. } if k == killer));
    }

    #[test]
    fn crates_and_timed_items_fire_on_their_documented_schedule() {
        // E2E finding: both sources were implemented but nothing fired them.
        // docs/04 §3: crates at t=45/90/135/180/225, timed items every 30 s.
        let mut round = lobby_with(1);
        round.start_round(1, Scale::Small);

        let mut crate_drops = 0;
        let mut timed_items = 0;
        // Run to t=100 s (2000 ticks): expect crates at 45 and 90, timed at
        // 30, 60 and 90.
        for _ in 0..2000 {
            for event in round.step(&[]) {
                match event {
                    Event::CrateDropped { .. } => crate_drops += 1,
                    Event::ItemSpawned { is_crate: false, .. } => timed_items += 1,
                    _ => {}
                }
            }
        }
        assert_eq!(crate_drops, 2, "expected crate drops at t=45 and t=90");
        assert!(
            timed_items >= 3,
            "expected at least 3 timed spawns by t=100, saw {timed_items}",
        );
    }

    #[test]
    fn colliders_are_rebuilt_when_a_blast_destroys_ground() {
        // E2E finding: skipping rebuild_segments leaves a player standing on
        // air with nothing to detect it. The only way to observe the rebuild
        // is a player who should FALL and does.
        let mut round = lobby_with(1);
        round.start_round(3, Scale::Small);

        // Settle the player on their spawn.
        for _ in 0..30 {
            round.step(&[]);
        }
        let resting_y = round.players[0].player.pos.y;
        assert!(round.players[0].player.on_ground(&round.map), "player did not settle");

        // A rocket detonating in the ground beneath them, delivered through
        // Round::step so the whole pipeline runs.
        let feet = round.players[0].player.feet_y();
        let x = round.players[0].player.pos.x;
        round.projectiles.push(Projectile {
            id: 1,
            owner: 0,
            kind: ItemId::Rocket,
            x,
            y: feet + 4.0,
            vx: 0.0,
            vy: 400.0,
            remaining_range: 900.0,
            fuse_s: f32::INFINITY,
            damage: 60.0,
            radius: 48.0,
            explosive: true,
            bounces_left: 0,
        });
        // Make the player immune to their own blast so the fall is the signal.
        round.players[0].player.health = 1000.0;
        round.players[0].player.max_health = 1000.0;

        let mut destroyed_any = false;
        for _ in 0..40 {
            for event in round.step(&[]) {
                if matches!(event, Event::TileDestroyed { .. }) {
                    destroyed_any = true;
                }
            }
        }
        assert!(destroyed_any, "the rocket destroyed no tiles");
        assert!(
            round.players[0].player.pos.y > resting_y + TILE_SIZE,
            "the player did not fall through the destroyed ground: {resting_y} -> {} \
             (colliders were probably not rebuilt)",
            round.players[0].player.pos.y,
        );
    }

    #[test]
    fn respawn_after_3s_keeps_inventory() {
        // docs/08 §1 (player row) + docs/03 §2: "3 s delay ... Inventory is
        // KEPT. Health resets to 100, shield cleared, jetpack fuel full."
        let mut round = lobby_with(2);
        round.start_round(1, Scale::Small);
        round.players[0].player.inventory.slots[2] = Some(ItemId::Rocket);
        round.players[0].player.jetpack.fuel = 1.0;
        round.players[0].player.apply_shield();

        let mut events = Vec::new();
        round.kill(0, DamageSource::Player(1), "rocket", &mut events);
        assert!(!round.players[0].player.alive);

        // 3 s = 60 ticks, and respawn is checked against the tick counter at
        // the START of a step, so the 61st step is the first that can see it.
        for _ in 0..59 {
            round.step(&[]);
            assert!(!round.players[0].player.alive, "respawned early");
        }
        for _ in 0..3 {
            round.step(&[]);
        }
        assert!(round.players[0].player.alive, "did not respawn after 3 s");
        assert_eq!(
            round.players[0].player.inventory.slots[2], Some(ItemId::Rocket),
            "inventory was cleared on respawn",
        );
        assert_eq!(round.players[0].player.health, 100.0);
        assert_eq!(round.players[0].player.jetpack.fuel, 5.0, "jetpack not refilled");
        assert!(!round.players[0].player.shield.active, "shield not cleared");
    }

    #[test]
    fn death_scores_kill_and_death() {
        // docs/08 §1 (player row). The doc-named test for the basic case.
        let mut round = lobby_with(2);
        round.start_round(1, Scale::Small);
        let mut events = Vec::new();
        round.kill(0, DamageSource::Player(1), "rocket", &mut events);

        assert_eq!(round.players[0].player.deaths, 1, "the victim records a death");
        assert_eq!(round.players[0].player.kills, 0, "the victim records no kill");
        assert_eq!(round.players[1].player.kills, 1, "the killer records a kill");
        assert_eq!(round.players[1].player.deaths, 0, "the killer records no death");
    }

    #[test]
    fn weather_kill_no_score() {
        // docs/08 §1 (player row) — the doc-named test.
        let mut round = lobby_with(3);
        round.start_round(1, Scale::Small);
        let before: Vec<i32> = round.players.iter().map(|p| p.player.score).collect();
        let mut events = Vec::new();
        round.kill(1, DamageSource::Weather, "lava", &mut events);

        assert_eq!(round.players[1].player.score, before[1] - 1, "victim -1");
        assert_eq!(round.players[0].player.score, before[0], "bystander scored");
        assert_eq!(round.players[2].player.score, before[2], "bystander scored");
        assert!(round.players.iter().all(|p| p.player.kills == 0), "weather credited a kill");
    }

    #[test]
    fn respawn_uses_the_spawn_farthest_from_living_players() {
        // docs/03 §2: "placed at the spawn farthest (Chebyshev, tile distance)
        // from all living players".
        let mut round = lobby_with(3);
        round.start_round(4, Scale::Medium);
        assert!(round.map.spawns.len() >= 3);

        // Park the two survivors on the FIRST spawn so it is the worst choice.
        let crowded = round.map.spawns[0];
        let crowded_px = Player::spawn_position(crowded);
        for index in [1usize, 2] {
            round.players[index].player.pos = crowded_px;
            round.players[index].player.alive = true;
        }

        let mut events = Vec::new();
        round.kill(0, DamageSource::Player(1), "rocket", &mut events);
        for _ in 0..70 {
            round.step(&[]);
        }
        assert!(round.players[0].player.alive, "did not respawn");

        // The chosen spawn must not be the crowded one, and must be at least
        // as far from the survivors as any other spawn.
        let respawn = round.players[0].player.pos;
        let dist = |a: Vec2, b: Vec2| {
            ((a.x - b.x) / TILE_SIZE).abs().max(((a.y - b.y) / TILE_SIZE).abs())
        };
        let chosen = dist(respawn, crowded_px);
        let best = round
            .map
            .spawns
            .iter()
            .map(|s| dist(Player::spawn_position(*s), crowded_px))
            .fold(0.0f32, f32::max);
        assert!(
            (chosen - best).abs() < 1e-3,
            "respawned {chosen} tiles from the survivors; the farthest spawn is {best}",
        );
    }

    #[test]
    fn score_kill_plus_death_minus() {
        // docs/08 §1 (round row) + T4.3 step 4: "3 kills 2 deaths -> +1".
        let mut round = lobby_with(2);
        round.start_round(1, Scale::Small);
        let mut events = Vec::new();
        for _ in 0..3 {
            round.kill(1, DamageSource::Player(0), "pistol", &mut events);
            round.players[1].player.alive = true;
        }
        for _ in 0..2 {
            round.kill(0, DamageSource::Player(1), "pistol", &mut events);
            round.players[0].player.alive = true;
        }
        assert_eq!(round.players[0].player.kills, 3);
        assert_eq!(round.players[0].player.deaths, 2);
        assert_eq!(round.players[0].player.score, 1, "3 kills - 2 deaths = +1");
    }

    #[test]
    fn a_full_round_runs_without_panic_and_leaves_sane_state() {
        // The interaction test round.rs exists to make possible.
        let mut round = lobby_with(6);
        round.start_round(777, Scale::Medium);
        for tick in 0..4800u64 {
            let frame = InputFrame {
                right: tick % 40 < 20,
                left: tick % 40 >= 20,
                jump: tick % 71 == 0,
                fire: tick % 13 == 0,
                aim: (tick as f32 * 0.05).sin(),
                ..InputFrame::default()
            };
            let inputs: Vec<(u8, InputFrame)> =
                (0..6u8).map(|id| (id, InputFrame { tick, ..frame })).collect();
            round.step(&inputs);
        }
        assert_eq!(round.state, RoundState::Ended);
        for rp in &round.players {
            assert!(rp.player.pos.x.is_finite() && rp.player.pos.y.is_finite());
            assert!(rp.player.health >= 0.0 && rp.player.health.is_finite());
            assert!(rp.player.jetpack.fuel >= -1e-3);
        }
        assert!(round.projectiles.len() <= MAX_PROJECTILES);
        assert_eq!(round.map.version as usize, round.map.version as usize);
    }
}
