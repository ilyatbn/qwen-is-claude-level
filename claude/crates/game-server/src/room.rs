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
            Command::Inspect(_) => f.write_str("Inspect"),
        }
    }
}

#[derive(Clone)]
pub struct RoomHandle {
    tx: mpsc::Sender<Command>,
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

    /// Await a reply. Used by `join`, which needs the assigned id.
    pub async fn join(&self, name: String, skin_id: u16) -> Option<PlayerId> {
        let (reply, rx) = oneshot::channel();
        if self
            .tx
            .send(Command::Join {
                name,
                skin_id,
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

pub struct Room {
    pub world: World,
    seats: Seats,
    config: Arc<Config>,
    lag_warned_at: u32,
    last_checksum_at: f32,
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
        Room {
            world: World::with_buried_secret(seed, config.map_scale, buried_secret),
            seats: Seats::default(),
            config,
            lag_warned_at: 0,
            last_checksum_at: 0.0,
        }
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

    /// Apply one command. Nothing here can panic on client-controlled data: every
    /// index is bounds-checked by the callee and every unknown id is a no-op.
    fn apply(&mut self, cmd: Command) {
        match cmd {
            Command::Join {
                name,
                skin_id,
                reply,
            } => {
                let id = self.seats.alloc(self.config.max_players);
                if let Some(id) = id {
                    self.world.add_player(id, skin_id, name);
                }
                let _ = reply.send(id);
            }
            Command::Ready(id) => {
                if let Some(s) = self.seats.get_mut(id) {
                    s.ready = true;
                }
            }
            Command::Input(id, inputs) => {
                let Some(seat) = self.seats.get_mut(id) else {
                    return;
                };
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
                    self.world.queue_input(id, input);
                }
                if seat.dropped_this_tick > 0 {
                    let n = seat.dropped_this_tick;
                    tracing::debug!(target: "game::net", player = id, dropped = n, "input queue full");
                }
            }
            Command::UseItem(id, slot) => {
                let now = self.world.round_time;
                let _ = self.world.use_item(id, slot, now);
            }
            Command::SelectSlot(id, slot) => self.world.select_slot(id, slot),
            Command::Fire(id) => {
                let now = self.world.round_time;
                let _ = self.world.fire(id, now);
            }
            Command::ToggleFlashlight(id) => self.world.toggle_flashlight(id),
            Command::VoteRestart(_, _) => {}
            Command::ResyncMap(_) => {}
            Command::Leave(id) => {
                self.seats.free_seat(id);
                self.world.remove_player(id);
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
    pub fn tick_once(&mut self, dt: f32) {
        self.seats.begin_tick();
        self.world.step(dt);
    }
}

/// How long a seated-but-never-ready client keeps its slot.
pub const READY_TIMEOUT: Duration = Duration::from_secs(30);

/// Spawn the room task. The returned handle is the only way to reach it.
pub fn spawn_room(
    io: SocketIo,
    config: Arc<Config>,
    shutdown: oneshot::Receiver<()>,
) -> RoomHandle {
    spawn_room_with(io, config, Arc::new(SessionMap::default()), shutdown)
}

/// As [`spawn_room`], but sharing a [`SessionMap`] with the socket layer so events
/// can be delivered to one player rather than broadcast.
pub fn spawn_room_with(
    io: SocketIo,
    config: Arc<Config>,
    sessions: Arc<SessionMap>,
    shutdown: oneshot::Receiver<()>,
) -> RoomHandle {
    let (tx, rx) = mpsc::channel(1024);
    tokio::spawn(run(io, config, sessions, rx, shutdown));
    RoomHandle { tx }
}

async fn run(
    io: SocketIo,
    config: Arc<Config>,
    sessions: Arc<SessionMap>,
    mut rx: mpsc::Receiver<Command>,
    mut shutdown: oneshot::Receiver<()>,
) {
    let mut room = Room::new_async(config).await;
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
                let span = tracing::info_span!("room", room = 0, tick = room.world.tick + 1);
                let _g = span.enter();

                let mut drained = 0;
                while drained < DRAIN_CAP {
                    match rx.try_recv() {
                        Ok(c) => { room.apply(c); drained += 1; }
                        Err(_) => break,
                    }
                }

                room.tick_once(SIM_DT);
                room.sweep_unready(READY_TIMEOUT);

                let events = room.world.drain_events();
                crate::events::flush_events(&io, &room.world, &sessions, &events);

                // Every third tick: 20 Hz, as SNAPSHOT_HZ says.
                if room.world.tick.is_multiple_of(SIM_HZ / SNAPSHOT_HZ) {
                    let seqs = room.last_seqs();
                    crate::events::broadcast_snapshot(&io, &room.world, &sessions, &seqs);
                }

                if room.due_for_checksum() {
                    let hash = room.world.map.mask.hash_hex();
                    crate::events::emit_mask_checksum(&io, room.world.tick, &hash);
                }

                // Expected tick count from wall-clock, so a slow tick shows up.
                let expected = (start.elapsed().as_secs_f64() * SIM_HZ as f64) as u32;
                let behind = expected.saturating_sub(room.world.tick);
                if behind > LAG_WARN_TICKS && room.world.tick > room.lag_warned_at + SIM_HZ {
                    room.lag_warned_at = room.world.tick;
                    tracing::warn!(target: "game::sim", lagging = behind, "tick overrun");
                }
            }
            _ = &mut shutdown => {
                tracing::info!(target: "game::round", "shutting down");
                crate::events::emit_round_end(&io, room.world.tick, "server_shutdown");
                break;
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn cfg() -> Arc<Config> {
        Arc::new(Config::default())
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
        room.tick_once(SIM_DT);
    }

    #[test]
    fn join_seats_a_player_and_leave_frees_the_slot() {
        let mut room = Room::new(cfg());
        let (reply, _rx) = oneshot::channel();
        room.apply(Command::Join {
            name: "a".into(),
            skin_id: 0,
            reply,
        });
        assert_eq!(room.player_count(), 1);
        assert_eq!(room.world.players.len(), 1);
        room.apply(Command::Leave(0));
        assert_eq!(room.player_count(), 0);
        assert_eq!(room.world.players.len(), 0);
    }

    #[test]
    fn a_player_who_never_readies_is_dropped() {
        let mut room = Room::new(cfg());
        let (reply, _rx) = oneshot::channel();
        room.apply(Command::Join {
            name: "a".into(),
            skin_id: 0,
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
            reply,
        });
        room.apply(Command::Ready(0));
        assert!(room.sweep_unready(Duration::from_millis(0)).is_empty());
    }
}
