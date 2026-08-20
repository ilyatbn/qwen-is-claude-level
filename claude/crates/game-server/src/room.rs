//! The room task: one tokio task owning one `World` outright.
//!
//! No `Mutex` on game state, no `Arc<RwLock<World>>`, no shared mutable anything.
//! Socket handlers parse a message into a [`Command`] and push it into an mpsc
//! channel; everything else happens here, single-threaded, in a defined order.
//!
//! That is what makes the simulation deterministic given the same command
//! sequence, which is what makes the replay system possible at all
//! (`docs/41-server-loop-rooms.md` §1).

use std::sync::Arc;
use std::time::{Duration, Instant};

use game_core::constants::{MASK_CHECKSUM_INTERVAL, MAX_INPUT_QUEUE, SIM_DT, SIM_HZ, SNAPSHOT_HZ};

use game_core::bots::Bot;
use game_core::player::input::Input;
use game_core::player::state::PlayerId;
use game_core::world::World;
use socketioxide::SocketIo;
use tokio::sync::{mpsc, oneshot};
use tokio::time::{interval, MissedTickBehavior};

use crate::config::Config;
use crate::session::SessionMap;

/// How many commands one tick will drain before getting on with the simulation.
///
/// Bounded so one noisy client cannot starve the tick: the rest wait for the next
/// one, which costs 16 ms, rather than the tick never completing.
const DRAIN_CAP: usize = 256;

/// Ticks behind schedule before the loop complains. `MissedTickBehavior::Burst`
/// catches up silently, so without this a server running slow looks healthy.
const LAG_WARN_TICKS: u32 = 10;

pub enum Command {
    /// Seat a player. The reply carries the assigned id, or `None` when full.
    Join {
        name: String,
        skin_id: u16,
        /// The grave they leave (§B8). Meaningless to the server, carried for
        /// the clients that draw it.
        tombstone_skin_id: u16,
        reply: oneshot::Sender<Option<PlayerId>>,
    },
    Ready(PlayerId),
    Input(PlayerId, Vec<Input>),
    UseItem(PlayerId, u8),
    SelectSlot(PlayerId, u8),
    Fire(PlayerId),
    ToggleFlashlight(PlayerId),
    VoteRestart(PlayerId, bool),
    ResyncMap(PlayerId),
    Leave(PlayerId),
    /// Who is in this room: total seats taken, and how many are bots.
    ///
    /// A separate command rather than an `Inspect`, because `bots` lives on the
    /// `Room` and not on the `World` — the sim has no concept of a bot, which is
    /// the point (§A5: a bug in bots is a bug in the game).
    Status {
        reply: oneshot::Sender<(usize, usize)>,
    },
    /// Test and debug hook: run `f` against the world between ticks.
    Inspect(Box<dyn FnOnce(&mut World) + Send>),
}

/// Hand-written because `Inspect` holds a closure. Kept because a dropped command
/// is logged, and a log line reading `Input(3)` is worth more than `<command>`.
impl std::fmt::Debug for Command {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Command::Join { name, skin_id, .. } => write!(f, "Join({name:?}, skin {skin_id})"),
            Command::Ready(id) => write!(f, "Ready({id})"),
            Command::Input(id, v) => write!(f, "Input({id}, {} inputs)", v.len()),
            Command::UseItem(id, s) => write!(f, "UseItem({id}, slot {s})"),
            Command::SelectSlot(id, s) => write!(f, "SelectSlot({id}, slot {s})"),
            Command::Fire(id) => write!(f, "Fire({id})"),
            Command::ToggleFlashlight(id) => write!(f, "ToggleFlashlight({id})"),
            Command::VoteRestart(id, v) => write!(f, "VoteRestart({id}, {v})"),
            Command::ResyncMap(id) => write!(f, "ResyncMap({id})"),
            Command::Leave(id) => write!(f, "Leave({id})"),
            Command::Status { .. } => f.write_str("Status"),
            Command::Inspect(_) => f.write_str("Inspect"),
        }
    }
}

#[derive(Clone)]
pub struct RoomHandle {
    tx: mpsc::Sender<Command>,
    /// The room task, so shutdown can **wait** for it.
    ///
    /// Without this, signalling shutdown and returning from `main` races the
    /// room: the process exits before the task is scheduled again, and the
    /// replay footer — the thing that makes a recorded round verifiable — is
    /// never written. `docs/41` §7 asks for a clean path precisely so that
    /// `docker compose down` leaves an inspectable file behind.
    task: Arc<tokio::sync::Mutex<Option<tokio::task::JoinHandle<()>>>>,
}

impl RoomHandle {
    /// Fire-and-forget. A full channel drops the command and logs rather than
    /// blocking a socket handler — the client will resend (inputs are held state,
    /// so a lost one costs nothing).
    pub fn send(&self, c: Command) {
        if let Err(e) = self.tx.try_send(c) {
            tracing::debug!(target: "game::net", "room command dropped: {e}");
        }
    }

    /// A handle to nothing, for tests that exercise bookkeeping around rooms
    /// rather than rooms themselves.
    ///
    /// The registry's lifecycle logic — codes, capacity, reaping, quick-match
    /// tie-breaks — has nothing to do with simulation, and a real room task
    /// ticks at 60 Hz and generates a map first. Making those tests spawn one
    /// would cost minutes and would assert on timing rather than on the logic.
    /// The shutdown receiver is held so dropping the handle still stops
    /// whatever the caller wired up.
    #[cfg(test)]
    pub fn inert(shutdown: oneshot::Receiver<()>) -> Self {
        // No task, so this works outside a Tokio runtime: the registry's
        // lifecycle logic is synchronous and its tests should be too.
        // The receiver is dropped, so `send` fails and logs at debug — the same
        // path a real room takes when its channel is gone. Leaking one to make
        // sends succeed would be leaking a channel per test room.
        let (tx, _rx) = mpsc::channel(1);
        drop(shutdown);
        RoomHandle {
            tx,
            task: Arc::new(tokio::sync::Mutex::new(None)),
        }
    }

    /// Seats taken and how many are bots, for the lobby (§B10).
    pub async fn status(&self) -> Option<(usize, usize)> {
        let (tx, rx) = oneshot::channel();
        self.tx.try_send(Command::Status { reply: tx }).ok()?;
        rx.await.ok()
    }

    /// Wait for the room task to finish, up to `grace`.
    ///
    /// Returns whether it stopped in time. A room that does not stop is a bug
    /// worth seeing, so the caller logs rather than ignoring the result.
    pub async fn wait_for_shutdown(&self, grace: Duration) -> bool {
        let mut guard = self.task.lock().await;
        let Some(handle) = guard.take() else {
            return true;
        };
        tokio::time::timeout(grace, handle).await.is_ok()
    }

    /// Await a reply. Used by `join`, which needs the assigned id.
    pub async fn join(
        &self,
        name: String,
        skin_id: u16,
        tombstone_skin_id: u16,
    ) -> Option<PlayerId> {
        let (reply, rx) = oneshot::channel();
        if self
            .tx
            .send(Command::Join {
                name,
                skin_id,
                tombstone_skin_id,
                reply,
            })
            .await
            .is_err()
        {
            return None;
        }
        rx.await.ok().flatten()
    }

    /// Run a closure against the world between ticks and await its result.
    pub async fn inspect<T: Send + 'static>(
        &self,
        f: impl FnOnce(&mut World) -> T + Send + 'static,
    ) -> Option<T> {
        let (tx, rx) = oneshot::channel();
        self.tx
            .send(Command::Inspect(Box::new(move |w| {
                let _ = tx.send(f(w));
            })))
            .await
            .ok()?;
        rx.await.ok()
    }
}

/// Per-player input sequencing, kept beside the world rather than in it —
/// `game-core` has no idea a network exists.
#[derive(Default)]
struct Seats {
    seats: Vec<Seat>,
    /// Freed ids, reused so a long-lived server never exhausts the `u8`
    /// (`docs/40-net-protocol.md` snapshot format has 256 of them).
    free: Vec<PlayerId>,
    next: u16,
}

struct Seat {
    id: PlayerId,
    ready: bool,
    joined_at: Instant,
    last_seq: u32,
    accepted_this_tick: u8,
    dropped_this_tick: u32,
}

impl Seats {
    /// Mark a seat as in-simulation. Used by the join flow when `ready` arrives,
    /// and by bot seating, which has no handshake to wait for.
    fn mark_ready(&mut self, id: PlayerId) {
        if let Some(s) = self.seats.iter_mut().find(|s| s.id == id) {
            s.ready = true;
        }
    }

    fn alloc(&mut self, max: usize) -> Option<PlayerId> {
        if self.seats.len() >= max {
            return None;
        }
        let id = match self.free.pop() {
            Some(id) => id,
            None => {
                if self.next > u8::MAX as u16 {
                    return None;
                }
                let id = self.next as PlayerId;
                self.next += 1;
                id
            }
        };
        self.seats.push(Seat {
            id,
            ready: false,
            joined_at: Instant::now(),
            last_seq: 0,
            accepted_this_tick: 0,
            dropped_this_tick: 0,
        });
        Some(id)
    }

    fn free_seat(&mut self, id: PlayerId) {
        if let Some(i) = self.seats.iter().position(|s| s.id == id) {
            self.seats.remove(i);
            self.free.push(id);
        }
    }

    fn get_mut(&mut self, id: PlayerId) -> Option<&mut Seat> {
        self.seats.iter_mut().find(|s| s.id == id)
    }

    fn begin_tick(&mut self) {
        for s in self.seats.iter_mut() {
            s.accepted_this_tick = 0;
            s.dropped_this_tick = 0;
        }
    }
}

/// Seconds since the epoch, zero-padded so filenames sort chronologically.
///
/// The clock is read *here*, in the caller, and never inside the recorder —
/// `docs/61` §4 is explicit that the replay runner has no clock, and a recorder
/// that stamps itself cannot be asked for the same filename twice in a test.
pub fn stamp_for(_seed: u64) -> String {
    let secs = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |d| d.as_secs());
    format!("{secs:012}")
}

pub struct Room {
    pub world: World,
    seats: Seats,
    config: Arc<Config>,
    lag_warned_at: u32,
    last_checksum_at: f32,
    /// Seated AI players (`docs/70-amendments-v2.md` §A5).
    ///
    /// They hold real `PlayerId`s and appear in `welcome`, `player_join`,
    /// snapshots and the scoreboard. Nothing in the sim knows they are bots —
    /// they push an `Input` through the same path a socket does — so a bug that
    /// affects them affects players.
    bots: Vec<Bot>,
    round: crate::round::RoundController,
    /// Bots are seated newest-last, so kicking to make room for a human takes
    /// the one that has been playing for the shortest time.
    bot_seq: u32,
    /// Present only when `RECORD_REPLAY=1`. A write error disables recording and
    /// logs once rather than taking the round down: losing the debugging aid is
    /// bad, losing the round because the debugging aid failed is worse.
    replay: Option<crate::replay::ReplayWriter>,
    /// So a phase transition can flush the recorder without polling for one.
    last_recorded_phase: game_core::world::RoundPhase,
    /// Drained into `/metrics` by the loop; counted here because this is where
    /// the drop happens.
    pub dropped_inputs: u64,
    /// The seed and secret this room's world was built from, so a restart can
    /// open a fresh replay file for the new round.
    seed: u64,
    buried_secret: u64,
}

impl Room {
    /// Generates the map inline. Use [`Room::new_async`] from a tokio context:
    /// map generation is hundreds of milliseconds of pure CPU and blocks whatever
    /// worker it lands on.
    pub fn new(config: Arc<Config>) -> Self {
        let seed = config.fixed_seed.unwrap_or(0x5EED_1234_ABCD_0001);
        // Buried slots are derived behind a secret that never crosses the wire
        // (`docs/70-amendments-v2.md` §A31). `welcome` carries the seed and
        // `game-core` ships as WASM, so without this a modified client
        // recomputes every slot exactly. `FIXED_SEED` pins the secret too, so
        // "reproduce the bug" still reproduces the whole round.
        let buried_secret = match config.fixed_seed {
            Some(_) => 0,
            None => seed.rotate_left(17) ^ 0x9E37_79B9_7F4A_7C15,
        };
        let mut room = Room {
            world: World::with_buried_secret(seed, config.map_scale, buried_secret),
            seats: Seats::default(),
            config,
            lag_warned_at: 0,
            last_checksum_at: 0.0,
            bots: Vec::new(),
            bot_seq: 0,
            round: crate::round::RoundController::new(seed),
            replay: None,
            last_recorded_phase: game_core::world::RoundPhase::Warmup,
            dropped_inputs: 0,
            seed,
            buried_secret,
        };
        // `ROUND_SECONDS` is an environment override for testing (`docs/41` §5)
        // and it was parsed and then dropped: the world used the constant, so a
        // shortened round never shortened.
        room.world.set_round_seconds(room.config.round_seconds);
        room.seat_bots(seed);
        // `docs/61` §3 row 1: the line a report of "the map was unplayable" maps
        // onto. Without `attempts` and `traversable_fraction` there is nothing to
        // look at but the seed.
        let m = &room.world.map.meta;
        tracing::info!(
            target: "game::map",
            seed = m.seed,
            requested_seed = m.requested_seed,
            attempts = m.attempts,
            used_safe_preset = m.used_safe_preset,
            traversable_fraction = m.traversable_fraction,
            spawns = m.spawn_points.len(),
            surface_points = m.surface_points.len(),
            theme = m.theme,
            "map generated"
        );
        room.debug_dump();
        room
    }

    /// Seat `BOT_COUNT` bots, up to the room's capacity.
    fn seat_bots(&mut self, seed: u64) {
        let want = self.config.bot_count.min(self.config.max_players);
        for _ in 0..want {
            let Some(id) = self.seats.alloc(self.config.max_players) else {
                break;
            };
            let index = self.bot_seq;
            self.bot_seq += 1;
            self.world.add_player(id, 0, format!("Bot {}", index + 1));
            // A bot is ready the moment it is seated. `ready` means "in the
            // simulation", and the handshake it normally gates on — download the
            // map, decode it, render it — does not exist for something with no
            // socket. Without this every bot was dropped by `sweep_unready`
            // exactly READY_TIMEOUT into every round: the roster went
            // [0,1,2,3] -> [3] at t=30s and the game silently became
            // single-player with no deaths and nothing in the log but
            // "dropping: never sent ready".
            self.seats.mark_ready(id);
            self.bots
                .push(Bot::new(id, seed, index, self.config.bot_skill));
            self.grant_dev_loadout(id);
        }
        if !self.bots.is_empty() {
            tracing::info!(
                target: "game::round",
                bots = self.bots.len(),
                skill = self.config.bot_skill,
                "seated bots"
            );
        }
    }

    /// Development only (`DEV_LOADOUT=1`): arm a player at spawn.
    ///
    /// Off by default, because finding your weapons is the game. It exists so an
    /// end-to-end run can demonstrate terrain destruction without first walking
    /// to a crate.
    fn grant_dev_loadout(&mut self, id: PlayerId) {
        if !self.config.dev_loadout {
            return;
        }
        game_core::world::give(&mut self.world, id, game_core::items::registry::BAZOOKA, 4);
        game_core::world::give(&mut self.world, id, game_core::items::registry::SMG, 60);
        // A second rocket stack, in the slot after the smg.
        //
        // `MAX_STACK` for a bazooka is 4, and 4 rockets is not enough to be
        // "armed" for anything that runs longer than a few seconds — T9.06's
        // full round burns them in the first minute. Granted *after* the smg so
        // the slot order stays bazooka / smg / bazooka and nothing that already
        // presses a hotkey has to change.
        game_core::world::give(&mut self.world, id, game_core::items::registry::BAZOOKA, 4);
    }

    /// Free a seat for a human by removing the newest bot.
    ///
    /// A person is never refused a seat because of a bot. Newest rather than
    /// oldest so the bot that has been in the round longest — and is likely
    /// mid-fight with someone — is the last to go.
    fn kick_newest_bot(&mut self) -> bool {
        let Some(bot) = self.bots.pop() else {
            return false;
        };
        tracing::info!(target: "game::round", player = bot.player, "kicked a bot for a human");
        self.world.remove_player(bot.player);
        self.seats.free_seat(bot.player);
        true
    }

    /// Build a room without blocking the runtime.
    ///
    /// `World::new` runs the whole generator — 0.3–1.1 s in release and several
    /// times that in debug — and it was running directly on a tokio worker. With a
    /// small worker pool that starves the socket.io accept and polling tasks, and
    /// the symptom is not "the room is slow to start": it is a client whose
    /// handshake or join round-trip never completes, which looks like a protocol
    /// bug and is not one.
    pub async fn new_async(config: Arc<Config>) -> Self {
        let c = config.clone();
        match tokio::task::spawn_blocking(move || Room::new(c)).await {
            Ok(room) => room,
            // The only way this fails is a panic inside generation, which is a bug
            // worth surfacing rather than papering over with a retry.
            Err(e) => {
                tracing::error!(target: "game::map", "map generation task failed: {e}");
                Room::new(config)
            }
        }
    }

    /// Note the command in the replay, if one is being recorded.
    ///
    /// A write failure drops the recorder and logs once. The alternative — an
    /// error path that can end a live round — trades a real game for a debugging
    /// aid, which is the wrong way round.
    fn note(&mut self, cmd: crate::replay::ReplayCommand) {
        let tick = self.world.tick;
        let Some(w) = self.replay.as_mut() else {
            return;
        };
        if let Err(e) = w.record(tick, &cmd) {
            tracing::error!(target: "game::round", "replay recording stopped: {e}");
            self.replay = None;
        }
    }

    /// Apply one command. Nothing here can panic on client-controlled data: every
    /// index is bounds-checked by the callee and every unknown id is a no-op.
    ///
    /// Commands are recorded **as applied**, not as received: `Input` is noted
    /// after sequence filtering, and a command for an unseated player is not
    /// noted at all. A replay that re-applied rejected input would simulate
    /// something the live round never did.
    fn apply(&mut self, cmd: Command) {
        use crate::replay::ReplayCommand as R;
        match cmd {
            Command::Join {
                name,
                skin_id,
                tombstone_skin_id,
                reply,
            } => {
                let mut id = self.seats.alloc(self.config.max_players);
                if id.is_none() && self.kick_newest_bot() {
                    id = self.seats.alloc(self.config.max_players);
                }
                if let Some(id) = id {
                    self.note(R::Join {
                        name: name.clone(),
                        skin_id,
                    });
                    self.world.add_player(id, skin_id, name);
                    // §B8. Parsed from `join` and, until now, dropped on the
                    // floor — the §A39 shape again, in the join path itself.
                    if let Some(p) = self.world.player_mut(id) {
                        p.tombstone_skin_id = tombstone_skin_id;
                    }
                    self.grant_dev_loadout(id);
                }
                let _ = reply.send(id);
            }
            Command::Ready(id) => {
                if let Some(s) = self.seats.get_mut(id) {
                    s.ready = true;
                    self.note(R::Ready(id));
                }
            }
            Command::Input(id, inputs) => {
                let Some(seat) = self.seats.get_mut(id) else {
                    return;
                };
                let mut accepted = Vec::new();
                for input in inputs {
                    // Duplicates and stale sequences are rejected, which is what
                    // makes INPUT_REDUNDANCY free rather than a source of
                    // double-applied input.
                    if input.seq <= seat.last_seq {
                        continue;
                    }
                    if seat.accepted_this_tick >= MAX_INPUT_QUEUE as u8 {
                        seat.dropped_this_tick += 1;
                        continue;
                    }
                    seat.last_seq = input.seq;
                    seat.accepted_this_tick += 1;
                    accepted.push(input);
                }
                if seat.dropped_this_tick > 0 {
                    let n = seat.dropped_this_tick;
                    self.dropped_inputs += n as u64;
                    tracing::debug!(target: "game::net", player = id, dropped = n, "input queue full");
                }
                if !accepted.is_empty() {
                    self.note(R::Input(id, accepted.clone()));
                    for input in accepted {
                        self.world.queue_input(id, input);
                    }
                }
            }
            Command::UseItem(id, slot) => {
                let now = self.world.round_time;
                self.note(R::UseItem(id, slot));
                if let Err(e) = self.world.use_item(id, slot, now) {
                    tracing::debug!(target: "game::items", player = id, slot, reason = ?e, "use rejected");
                }
            }
            Command::SelectSlot(id, slot) => {
                self.note(R::SelectSlot(id, slot));
                self.world.select_slot(id, slot)
            }
            Command::Fire(id) => {
                let now = self.world.round_time;
                self.note(R::Fire(id));
                // `docs/61` §3 row 6: "my rocket did nothing" has six possible
                // answers and the server already knows which one it was.
                if let Err(e) = self.world.fire(id, now) {
                    tracing::debug!(target: "game::weapons", player = id, reason = ?e, "fire rejected");
                }
            }
            Command::ToggleFlashlight(id) => {
                self.note(R::ToggleFlashlight(id));
                self.world.toggle_flashlight(id)
            }
            Command::VoteRestart(id, v) => {
                self.note(R::VoteRestart(id, v));
                self.round.vote(&self.world, id, v)
            }
            // Not recorded: a resync sends the client a fresh map and changes
            // nothing about the simulation.
            Command::ResyncMap(_) => {}
            Command::Leave(id) => {
                self.note(R::Leave(id));
                self.seats.free_seat(id);
                self.world.remove_player(id);
                self.round.forget(id);
            }
            // Not recorded: reading who is seated changes nothing.
            Command::Status { reply } => {
                let _ = reply.send((self.world.players.len(), self.bots.len()));
            }
            Command::Inspect(f) => f(&mut self.world),
        }
    }

    /// Drop players who connected but never sent `ready`.
    ///
    /// Without this a client that fails to decode the map holds a slot forever,
    /// and on a six-player room that is noticeable (`docs/40` §1).
    fn sweep_unready(&mut self, timeout: Duration) -> Vec<PlayerId> {
        let stale: Vec<PlayerId> = self
            .seats
            .seats
            .iter()
            .filter(|s| !s.ready && s.joined_at.elapsed() > timeout)
            .map(|s| s.id)
            .collect();
        for id in &stale {
            tracing::info!(target: "game::net", player = id, "dropping: never sent ready");
            // Recorded, because this fires on wall-clock elapsed time and a
            // replay has no clock. Without it a replayed round keeps a seat the
            // live round freed, and diverges from there.
            self.note(crate::replay::ReplayCommand::DropUnready(*id));
            self.seats.free_seat(*id);
            self.world.remove_player(*id);
        }
        stale
    }

    pub fn player_count(&self) -> usize {
        self.seats.seats.len()
    }

    /// The last input sequence accepted from each **ready** player, for the
    /// per-recipient `last_input_seq` in their snapshot.
    ///
    /// Ready-gated, and that is load-bearing rather than an optimisation. A
    /// socket.io binary event is two packets — a header naming the attachment
    /// count, then the attachment — and they must not interleave with another
    /// binary event on the same socket. A player is seated before `welcome` is
    /// sent, so without this gate the 20 Hz snapshot stream starts *during* the
    /// join handshake and races the `map_init` attachment. The symptom is not a
    /// dropped snapshot: the client's parser loses sync and **every subsequent
    /// event on that socket vanishes**, which reads as a dead connection.
    ///
    /// It is also just what `docs/40-net-protocol.md` §1 says: a client that has
    /// not sent `ready` is seated but not simulated.
    pub fn last_seqs(&self) -> Vec<(PlayerId, u32)> {
        self.seats
            .seats
            .iter()
            .filter(|s| s.ready)
            .map(|s| (s.id, s.last_seq))
            .collect()
    }

    /// True once per `MASK_CHECKSUM_INTERVAL`.
    pub fn due_for_checksum(&mut self) -> bool {
        if self.world.round_time - self.last_checksum_at < MASK_CHECKSUM_INTERVAL {
            return false;
        }
        self.last_checksum_at = self.world.round_time;
        true
    }

    pub fn ready_count(&self) -> usize {
        self.seats.seats.iter().filter(|s| s.ready).count()
    }

    /// One simulation step plus the bookkeeping around it.
    pub fn tick_once(&mut self, dt: f32) -> Vec<game_core::world::GameEvent> {
        self.seats.begin_tick();
        self.drive_bots(dt);
        self.world.step(dt);

        let connected = self.seats.seats.len();
        let min = self.config.min_players_to_start;
        let (mut events, outcome) = self.round.tick(&mut self.world, connected, min);

        // `docs/61` §3, the rows that only the event stream can answer. These are
        // deliberate diagnostic lines, not verbosity: each one is the thing you
        // grep for when a player says something vague.
        for e in self.world.events_so_far() {
            match e {
                // "I spawned inside a rock" — the chosen point, so it can be
                // compared against the map.
                game_core::world::GameEvent::Respawn { id, x, y, .. } => {
                    tracing::debug!(target: "game::player", player = id, x, y, "respawned");
                }
                // "the item vanished" — TTL or eviction, which are different bugs.
                game_core::world::GameEvent::ItemDespawn { world_item_id, .. } => {
                    tracing::debug!(target: "game::items", world_item = world_item_id, "item despawned");
                }
                // "the weather never fired" — what was rolled and when.
                game_core::world::GameEvent::EffectStart {
                    id, kind, duration, ..
                } => {
                    tracing::info!(
                        target: "game::effects",
                        effect = id,
                        kind = ?kind,
                        duration,
                        round_time = self.world.round_time,
                        "effect telegraphing"
                    );
                }
                _ => {}
            }
        }

        // A state hash every CHECKPOINT_STRIDE ticks, so a failed verification can
        // report *where* it diverged rather than only that it did. Written after
        // the step, so the hash describes the state at the tick it names.
        if self.replay.is_some()
            && self.world.tick > 0
            && self
                .world
                .tick
                .is_multiple_of(crate::replay::CHECKPOINT_STRIDE)
        {
            let cp = crate::replay::ReplayCommand::Checkpoint {
                tick: self.world.tick,
                hash: self.world.state_hash(),
            };
            self.note(cp);
        }

        // Flush on a phase transition, not per command. A round that dies during
        // `Playing` then still has its warmup on disk, and the cost is four
        // flushes a round rather than thousands.
        if self.world.phase != self.last_recorded_phase {
            self.last_recorded_phase = self.world.phase;
            self.flush_recording();
        }

        match outcome {
            crate::round::RoundOutcome::Continue => {}
            crate::round::RoundOutcome::Restart { seed } => {
                events.extend(self.restart(seed));
            }
            crate::round::RoundOutcome::ToLobby => {
                self.world.set_phase(game_core::world::RoundPhase::Lobby);
            }
        }
        events
    }

    /// A new round on a fresh seat list: new map, scores reset, back to Warmup.
    ///
    /// Everyone already seated keeps their seat and gets a fresh `map_init` —
    /// the alternative, dropping every socket, turns a vote into a reconnect
    /// storm.
    /// `DEBUG_DUMP=1`: write `debug/<seed>/{map.png,surface.png,meta.json}`
    /// (`docs/61` §6).
    ///
    /// `surface.png` is the direct visual answer to "why did validation reject
    /// this map?", and is the easiest of the three to forget.
    ///
    /// Off by default — it costs disk and a few hundred milliseconds, and it runs
    /// before `Warmup` ends so it never lands inside a tick.
    fn debug_dump(&self) {
        if !self.config.debug_dump {
            return;
        }
        let dir = std::path::PathBuf::from("debug").join(format!("{:016x}", self.seed));
        if let Err(e) = std::fs::create_dir_all(&dir) {
            tracing::error!(target: "game::map", "DEBUG_DUMP: cannot create {}: {e}", dir.display());
            return;
        }
        match serde_json::to_string_pretty(&self.world.map.meta) {
            Ok(j) => {
                if let Err(e) = std::fs::write(dir.join("meta.json"), j) {
                    tracing::error!(target: "game::map", "DEBUG_DUMP: meta.json: {e}");
                }
            }
            Err(e) => tracing::error!(target: "game::map", "DEBUG_DUMP: meta.json: {e}"),
        }

        #[cfg(feature = "dump-png")]
        {
            if let Err(e) = game_core::map::dump::dump_map(&self.world.map, &dir.join("map.png")) {
                tracing::error!(target: "game::map", "DEBUG_DUMP: map.png: {e}");
            }
            let report = game_core::map::gen::traversal::analyse(
                &self.world.map.mask,
                &self.world.map.meta.surface_points,
            );
            if let Err(e) = game_core::map::dump::dump_surface(
                &self.world.map,
                &report,
                &dir.join("surface.png"),
            ) {
                tracing::error!(target: "game::map", "DEBUG_DUMP: surface.png: {e}");
            }
        }
        #[cfg(not(feature = "dump-png"))]
        // Named, rather than silently writing one file of three: the PNGs are the
        // useful part and their absence must not look like a dump that worked.
        tracing::warn!(
            target: "game::map",
            "DEBUG_DUMP: meta.json only — rebuild with `--features dump-png` for map.png and surface.png"
        );

        tracing::info!(target: "game::map", path = %dir.display(), "DEBUG_DUMP written");
    }

    /// Open a replay file for the current round. No-op unless `RECORD_REPLAY=1`.
    ///
    /// `stamp` comes from the caller because the recorder has no business
    /// reading a clock: a recorder that timestamps itself cannot be asked to
    /// write the same file name twice in a test, and the runner has no clock at
    /// all (`docs/61` §4).
    pub fn start_recording(&mut self, dir: &std::path::Path, stamp: &str) {
        if !self.config.record_replay {
            return;
        }
        let header =
            crate::replay::ReplayHeader::from_config(&self.config, self.seed, self.buried_secret);
        match crate::replay::ReplayWriter::create(dir, stamp, &header) {
            Ok(w) => {
                tracing::info!(
                    target: "game::round",
                    path = %w.path().display(),
                    seed = self.seed,
                    "recording replay"
                );
                self.replay = Some(w);
            }
            Err(e) => {
                tracing::error!(target: "game::round", "could not start replay: {e}");
            }
        }
    }

    /// Close the current replay, writing the footer that makes it verifiable.
    ///
    /// Called on graceful shutdown and on a restart. A round that ends without
    /// this still replays — it just cannot be checked, which is why the footer
    /// is optional in the reader rather than required.
    pub fn finish_recording(&mut self) {
        let Some(w) = self.replay.take() else {
            return;
        };
        let scores: Vec<(PlayerId, i16)> =
            self.world.players.iter().map(|p| (p.id, p.score)).collect();
        match w.finish(&self.world, &scores) {
            Ok(path) => tracing::info!(
                target: "game::round",
                path = %path.display(),
                tick = self.world.tick,
                "replay written"
            ),
            Err(e) => tracing::error!(target: "game::round", "replay footer failed: {e}"),
        }
    }

    /// Flush without closing, so a round killed mid-`Playing` still has its
    /// earlier phases on disk.
    pub fn flush_recording(&mut self) {
        if let Some(w) = self.replay.as_mut() {
            if let Err(e) = w.flush() {
                tracing::error!(target: "game::round", "replay flush failed: {e}");
                self.replay = None;
            }
        }
    }

    /// How many commands the recorder has written.
    ///
    /// Public because the replay tests live in `tests/`, which is a separate
    /// crate and cannot see `#[cfg(test)]` items. Same reason `Command::Inspect`
    /// exists — the alternative is a test that asserts on the file instead of on
    /// the thing that wrote it.
    pub fn recorded_commands(&self) -> u64 {
        self.replay.as_ref().map_or(0, |w| w.commands)
    }

    /// Apply one command directly, bypassing the channel. Test hook.
    pub fn apply_for_test(&mut self, cmd: Command) {
        self.apply(cmd);
    }

    /// Run the unready sweep with an explicit timeout. Test hook: the production
    /// caller passes `READY_TIMEOUT`, and a test that had to wait 30 s to see a
    /// sweep would not be written.
    pub fn sweep_unready_for_test(&mut self, timeout: Duration) -> Vec<PlayerId> {
        self.sweep_unready(timeout)
    }

    /// Reset the per-tick input allowance without stepping the world. Test hook
    /// for measuring what a tick's *commands* cost, separately from what the
    /// simulation costs.
    pub fn begin_tick_for_test(&mut self) {
        self.seats.begin_tick();
    }

    fn restart(&mut self, seed: u64) -> Vec<game_core::world::GameEvent> {
        let buried_secret = match self.config.fixed_seed {
            Some(_) => 0,
            None => seed.rotate_left(17) ^ 0x9E37_79B9_7F4A_7C15,
        };
        // One file per round. A single file spanning a restart would carry two
        // seeds and two maps, and the footer hash could only describe one of them.
        let recording = self.replay.is_some();
        self.finish_recording();
        self.seed = seed;
        self.buried_secret = buried_secret;
        let seated: Vec<(PlayerId, u16)> = self
            .world
            .players
            .iter()
            .map(|p| (p.id, p.skin_id))
            .collect();
        self.world = World::with_buried_secret(seed, self.config.map_scale, buried_secret);
        self.world.set_round_seconds(self.config.round_seconds);
        self.bots.clear();
        for (id, skin) in seated {
            self.world.add_player(id, skin, String::new());
        }
        self.seat_bots(seed);
        self.world.set_phase(game_core::world::RoundPhase::Warmup);
        self.last_checksum_at = 0.0;
        tracing::info!(target: "game::round", seed, "round restarted");
        if recording {
            let dir = std::path::PathBuf::from(self.config.replay_dir.clone());
            self.start_recording(&dir, &stamp_for(seed));
        }
        self.world.drain_events()
    }

    /// Bots think **before** the step, so their input is consumed by the same
    /// tick a human's would be. Queued through `queue_input` like everything
    /// else — there is no bot branch inside `World::step`.
    fn drive_bots(&mut self, dt: f32) {
        if self.bots.is_empty() {
            return;
        }
        let now = self.world.round_time;
        let mut uses: Vec<(PlayerId, u8)> = Vec::new();
        let mut fires: Vec<PlayerId> = Vec::new();
        // Split the borrow: `think` reads the world, so it cannot run while the
        // world is mutably borrowed for `queue_input`.
        let mut inputs: Vec<(PlayerId, game_core::player::input::Input)> =
            Vec::with_capacity(self.bots.len());
        for bot in &mut self.bots {
            let input = bot.think(&self.world, now, dt);
            if let Some(slot) = bot.wants_use() {
                uses.push((bot.player, slot));
            }
            // Firing is a *command*, not a button the sim reads: a human's
            // client sends `fire` alongside its input (`docs/30` §4), and
            // nothing anywhere consumes `Input`'s FIRE bit — `fire_pressed` is
            // derived in `input.rs` and read by no production code. A bot has no
            // client, so the room has to send that command on its behalf, the
            // same way it does for `wants_use`.
            //
            // Without this the bots had never fired a shot: measured at 16,861
            // trigger pulls across five rounds for zero damage and zero
            // cooldown rejections, which is what a fire path that is never
            // reached looks like from the outside.
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
            if let Err(e) = self.world.fire(id, now) {
                tracing::debug!(target: "game::weapons", player = id, reason = ?e, "bot fire rejected");
            }
        }
    }

    /// Test seams. The room owns the controller, and a test that reached in and
    /// constructed its own would be testing a different object than the one the
    /// tick loop drives.
    pub fn vote_for_test(&mut self, id: PlayerId, restart: bool) {
        self.round.vote(&self.world, id, restart);
    }

    pub fn leave_for_test(&mut self, id: PlayerId) {
        self.apply(Command::Leave(id));
    }

    /// How many bots are seated. Used by the integration tests and `/healthz`.
    pub fn bot_count(&self) -> usize {
        self.bots.len()
    }
}

/// How long a seated-but-never-ready client keeps its slot.
///
/// The value lives in `constants.rs` like every other tunable; this is just the
/// `Duration` the sweep wants.
pub const READY_TIMEOUT: Duration =
    Duration::from_millis((game_core::constants::READY_TIMEOUT_SECS * 1000.0) as u64);

/// Spawn the room task. The returned handle is the only way to reach it.
pub fn spawn_room(
    io: SocketIo,
    config: Arc<Config>,
    shutdown: oneshot::Receiver<()>,
) -> RoomHandle {
    spawn_room_with(
        io,
        config,
        Arc::new(SessionMap::default()),
        shutdown,
        None,
        0,
    )
}

/// As [`spawn_room`], but sharing a [`SessionMap`] with the socket layer so events
/// can be delivered to one player rather than broadcast.
pub fn spawn_room_with(
    io: SocketIo,
    config: Arc<Config>,
    sessions: Arc<SessionMap>,
    shutdown: oneshot::Receiver<()>,
    metrics: Option<Arc<crate::metrics::Metrics>>,
    room_id: u32,
) -> RoomHandle {
    let (tx, rx) = mpsc::channel(1024);
    let task = tokio::spawn(run(io, config, sessions, rx, shutdown, metrics, room_id));
    RoomHandle {
        tx,
        task: Arc::new(tokio::sync::Mutex::new(Some(task))),
    }
}

#[allow(clippy::too_many_arguments)]
async fn run(
    io: SocketIo,
    config: Arc<Config>,
    sessions: Arc<SessionMap>,
    mut rx: mpsc::Receiver<Command>,
    mut shutdown: oneshot::Receiver<()>,
    metrics: Option<Arc<crate::metrics::Metrics>>,
    room_id: u32,
) {
    let mut room = Room::new_async(config).await;
    let dir = std::path::PathBuf::from(room.config.replay_dir.clone());
    room.start_recording(&dir, &stamp_for(room.seed));
    let mut ticker = interval(Duration::from_secs_f64(1.0 / SIM_HZ as f64));
    // Burst, so a 50 ms descheduling is caught up rather than silently making the
    // round run slow — round time stays true to wall-clock (`docs/41` §2).
    ticker.set_missed_tick_behavior(MissedTickBehavior::Burst);

    let start = Instant::now();

    loop {
        tokio::select! {
            _ = ticker.tick() => {
                // One span per tick, so every line logged inside the loop carries
                // `room` and `tick` automatically rather than by remembering
                // (`docs/61-logging-debug.md` §2).
                let span = tracing::info_span!("room", room = room_id, tick = room.world.tick + 1);
                let _g = span.enter();

                let tick_started = Instant::now();
                let mut drained = 0;
                while drained < DRAIN_CAP {
                    match rx.try_recv() {
                        Ok(c) => { room.apply(c); drained += 1; }
                        Err(_) => break,
                    }
                }

                // The round controller's own events (periodic `round_state`, and
                // anything a restart produced) come back from `tick_once` and are
                // flushed with the world's, in that order.
                let round_events = room.tick_once(SIM_DT);
                room.sweep_unready(READY_TIMEOUT);

                let mut events = room.world.drain_events();
                events.extend(round_events);
                crate::events::flush_events(&io, &room.world, &sessions, &events);

                // Every third tick: 20 Hz, as SNAPSHOT_HZ says.
                if room.world.tick.is_multiple_of(SIM_HZ / SNAPSHOT_HZ) {
                    let seqs = room.last_seqs();
                    let bytes =
                        crate::events::broadcast_snapshot(&io, &room.world, &sessions, &seqs);
                    if let Some(m) = metrics.as_ref() {
                        m.record_snapshot(bytes);
                    }
                }

                if let Some(m) = metrics.as_ref() {
                    // Measured around the whole tick — drain, step, flush and
                    // snapshot — because that is what has to fit in 16.7 ms.
                    let us = tick_started.elapsed().as_micros().min(u32::MAX as u128) as u32;
                    m.record_tick(us, drained as u32);
                    // Per room as well as process-wide: one room in trouble is
                    // invisible behind seven healthy ones in a shared p99, and
                    // one room in trouble is what an operator needs to see.
                    m.record_room_tick(room_id, us);
                    m.set_players(room.player_count());
                    if room.dropped_inputs > 0 {
                        m.record_inputs_dropped(room.dropped_inputs);
                        room.dropped_inputs = 0;
                    }
                }

                if room.due_for_checksum() {
                    let hash = room.world.map.mask.hash_hex();
                    crate::events::emit_mask_checksum(&io, &sessions, room.world.tick, &hash);
                }

                // Expected tick count from wall-clock, so a slow tick shows up.
                let expected = (start.elapsed().as_secs_f64() * SIM_HZ as f64) as u32;
                let behind = expected.saturating_sub(room.world.tick);
                if behind > LAG_WARN_TICKS && room.world.tick > room.lag_warned_at + SIM_HZ {
                    room.lag_warned_at = room.world.tick;
                    if let Some(m) = metrics.as_ref() {
                        m.record_overrun();
                    }
                    tracing::warn!(target: "game::sim", lagging = behind, "tick overrun");
                }
            }
            _ = &mut shutdown => {
                tracing::info!(target: "game::round", "shutting down");
                crate::events::emit_round_end(&io, &sessions, room.world.tick, "server_shutdown");
                // Before the break, or `docker compose down` truncates exactly
                // the round someone wanted to inspect (`docs/41` §7).
                room.finish_recording();
                break;
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// No bots. These tests are about seat allocation and readiness sweeping,
    /// and `BOT_COUNT` defaults to 3 (§A5) — a room that seats bots is the right
    /// production behaviour and the wrong fixture for counting human seats.
    fn cfg() -> Arc<Config> {
        Arc::new(Config {
            bot_count: 0,
            ..Config::default()
        })
    }

    /// A room with the production bot default, for the seating tests.
    fn cfg_with_bots() -> Arc<Config> {
        Arc::new(Config::default())
    }

    /// The room must turn a bot's FIRE bit into `World::fire`, because nothing
    /// in the sim reads that bit — a human's client sends the command
    /// separately (`docs/30` §4) and a bot has no client.
    ///
    /// This lived in `drive_bots` and was missing for the entire life of the
    /// project. Every bot-side test passed: the bot asked to fire perfectly
    /// well, and the request went nowhere. The fingerprint from outside is
    /// trigger pulls with **zero** cooldown rejections, because a shot that is
    /// never taken never starts a cooldown.
    #[test]
    fn the_room_turns_a_bot_s_fire_button_into_a_shot() {
        let cfg = Arc::new(Config {
            bot_count: 2,
            bot_skill: 1.0,
            map_scale: game_core::constants::MapScale::Small,
            ..Config::default()
        });
        let mut room = Room::new(cfg);
        room.world.set_phase(game_core::world::RoundPhase::Playing);

        // Arm both bots and stand them in a clear line, so the only thing under
        // test is whether the trigger reaches the world.
        let ids: Vec<PlayerId> = room.world.players.iter().map(|p| p.id).collect();
        assert_eq!(ids.len(), 2, "bots were not seated");
        for id in &ids {
            game_core::world::give(&mut room.world, *id, game_core::items::registry::SMG, 60);
        }

        // Stand them 200 px apart on a clear line. Left to wander a 2048x1024
        // map they may simply never meet inside the test's budget, and a test
        // that depends on an encounter is measuring the map, not the wiring.
        let at = {
            let w = &room.world;
            let mut found = None;
            'y: for y in (200..(w.map.mask.h as i32 - 200)).step_by(16) {
                'x: for x in (100..(w.map.mask.w as i32 - 400)).step_by(16) {
                    for s in (0..=260).step_by(4) {
                        if game_core::physics::collide::solid_at(&w.map, x + s, y) {
                            continue 'x;
                        }
                    }
                    found = Some((x as f32, y as f32));
                    break 'y;
                }
            }
            found.expect("no clear 260 px span; the fixture is wrong, not the room")
        };
        if let Some(p) = room.world.player_mut(ids[0]) {
            p.body.pos = game_core::math::Vec2::new(at.0, at.1);
        }
        if let Some(p) = room.world.player_mut(ids[1]) {
            p.body.pos = game_core::math::Vec2::new(at.0 + 200.0, at.1);
        }

        let mut fired = false;
        for _ in 0..600 {
            room.tick_once(1.0 / 60.0);
            if room
                .world
                .players
                .iter()
                .any(|p| p.fire_ready_at > room.world.round_time)
            {
                fired = true;
                break;
            }
        }
        assert!(
            fired,
            "600 ticks of armed bots and not one shot reached the world"
        );
    }

    #[test]
    fn seats_reuse_freed_ids() {
        // The snapshot format has 256 ids; a long-lived server that never reused
        // them would run out.
        let mut s = Seats::default();
        let a = s.alloc(6).expect("first");
        let b = s.alloc(6).expect("second");
        assert_eq!((a, b), (0, 1));
        s.free_seat(a);
        let c = s.alloc(6).expect("after free");
        assert_eq!(c, a, "the freed id must come back");
    }

    #[test]
    fn seats_refuse_past_the_cap() {
        let mut s = Seats::default();
        for _ in 0..6 {
            assert!(s.alloc(6).is_some());
        }
        assert!(s.alloc(6).is_none(), "the 7th must be refused");
    }

    #[test]
    fn stale_inputs_and_duplicates_are_rejected() {
        let mut room = Room::new(cfg());
        let (reply, _rx) = oneshot::channel();
        room.apply(Command::Join {
            name: "a".into(),
            skin_id: 0,
            tombstone_skin_id: 0,
            reply,
        });
        let id = 0;
        room.apply(Command::Input(
            id,
            vec![
                Input::new(1, 0, 0),
                Input::new(2, 0, 0),
                Input::new(3, 0, 0),
            ],
        ));
        assert_eq!(room.seats.get_mut(id).expect("seat").last_seq, 3);

        // Replaying 2 and 3 must change nothing — this is what makes redundancy
        // free rather than double-applied input.
        room.apply(Command::Input(
            id,
            vec![Input::new(2, 0, 0), Input::new(3, 0, 0)],
        ));
        assert_eq!(room.seats.get_mut(id).expect("seat").last_seq, 3);
    }

    #[test]
    fn more_than_max_input_queue_in_one_tick_drops_the_excess() {
        let mut room = Room::new(cfg());
        let (reply, _rx) = oneshot::channel();
        room.apply(Command::Join {
            name: "a".into(),
            skin_id: 0,
            tombstone_skin_id: 0,
            reply,
        });
        room.seats.begin_tick();
        let inputs: Vec<Input> = (1..=20).map(|s| Input::new(s, 0, 0)).collect();
        room.apply(Command::Input(0, inputs));
        let seat = room.seats.get_mut(0).expect("seat");
        assert_eq!(seat.accepted_this_tick, MAX_INPUT_QUEUE as u8);
        assert_eq!(seat.dropped_this_tick, 20 - MAX_INPUT_QUEUE as u32);

        // The counter resets, so the next tick accepts again.
        room.seats.begin_tick();
        assert_eq!(room.seats.get_mut(0).expect("seat").accepted_this_tick, 0);
    }

    #[test]
    fn an_unknown_player_id_is_a_no_op_not_a_panic() {
        let mut room = Room::new(cfg());
        // Every one of these arrives from a socket and must be survivable.
        room.apply(Command::Input(200, vec![Input::new(1, 0, 0)]));
        room.apply(Command::UseItem(200, 99));
        room.apply(Command::SelectSlot(200, 200));
        room.apply(Command::Fire(200));
        room.apply(Command::ToggleFlashlight(200));
        room.apply(Command::Ready(200));
        room.apply(Command::Leave(200));
        let _ = room.tick_once(SIM_DT);
    }

    #[test]
    fn join_seats_a_player_and_leave_frees_the_slot() {
        let mut room = Room::new(cfg());
        let (reply, _rx) = oneshot::channel();
        room.apply(Command::Join {
            name: "a".into(),
            skin_id: 0,
            tombstone_skin_id: 0,
            reply,
        });
        assert_eq!(room.player_count(), 1);
        assert_eq!(room.world.players.len(), 1);
        room.apply(Command::Leave(0));
        assert_eq!(room.player_count(), 0);
        assert_eq!(room.world.players.len(), 0);
    }

    /// Bots are seated at construction and hold real seats.
    #[test]
    fn the_default_config_seats_bots_and_they_occupy_seats() {
        let room = Room::new(cfg_with_bots());
        let bots = room.bot_count();
        assert!(bots > 0, "BOT_COUNT defaults to 0, so §A5 is not in effect");
        assert_eq!(
            room.world.players.len(),
            bots,
            "seated bots are not in the world"
        );
    }

    /// A bot never costs a person a seat.
    #[test]
    fn a_full_room_of_bots_still_admits_a_human() {
        let cfg = Arc::new(Config {
            bot_count: 6,
            max_players: 6,
            ..Config::default()
        });
        let mut room = Room::new(cfg);
        assert_eq!(room.world.players.len(), 6);
        let (reply, _rx) = oneshot::channel();
        room.apply(Command::Join {
            name: "human".into(),
            skin_id: 0,
            tombstone_skin_id: 0,
            reply,
        });
        assert_eq!(room.bot_count(), 5, "no bot was kicked");
        assert_eq!(
            room.world.players.len(),
            6,
            "capacity was exceeded rather than a bot removed"
        );
    }

    #[test]
    fn a_player_who_never_readies_is_dropped() {
        let mut room = Room::new(cfg());
        let (reply, _rx) = oneshot::channel();
        room.apply(Command::Join {
            name: "a".into(),
            skin_id: 0,
            tombstone_skin_id: 0,
            reply,
        });
        // Nothing is dropped while the timeout has not elapsed.
        assert!(room.sweep_unready(Duration::from_secs(30)).is_empty());
        // A zero timeout is "everything unready is stale".
        let dropped = room.sweep_unready(Duration::from_millis(0));
        assert_eq!(dropped, vec![0]);
        assert_eq!(room.player_count(), 0);

        // A ready player is never swept.
        let (reply, _rx) = oneshot::channel();
        room.apply(Command::Join {
            name: "b".into(),
            skin_id: 0,
            tombstone_skin_id: 0,
            reply,
        });
        room.apply(Command::Ready(0));
        assert!(room.sweep_unready(Duration::from_millis(0)).is_empty());
    }
}
