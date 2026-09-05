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
use crate::replay::ReplayCommand;
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
    /// Ready, or no longer ready (§E3).
    ///
    /// A toggle, not a latch: a private lobby starts when every seated human is
    /// ready, so un-readying has to be able to hold the match back. The `bool`
    /// matches `VoteRestart`, the codebase's other yes/no command.
    ///
    /// **The serialised form does not carry the bool.** `ReplayCommand::Ready`
    /// is tag 2 followed by one byte, and every recorded file written before
    /// today says so; widening it would let an old file pass the version check
    /// and then read one byte short for the rest of the round. Un-readying is
    /// `ReplayCommand::Unready`, a new tag, which old files simply never
    /// contain. Same reasoning that kept `min_players_to_start`'s header slot.
    Ready(PlayerId, bool),
    Input(PlayerId, Vec<Input>),
    UseItem(PlayerId, u8),
    SelectSlot(PlayerId, u8),
    /// `Q` and `R` (§C9). Slotless: the counters are not inventory.
    UseHeal(PlayerId),
    UseBatteryPack(PlayerId),
    /// `E` (§C11): throw the first grenade-class item, wherever it is.
    QuickThrow(PlayerId),
    /// §C10's drag. Both indices are attacker-controlled and both are checked.
    MoveItem(PlayerId, u8, u8),
    /// T20.09: put one slot's stack on the ground at the player's feet.
    DropItem(PlayerId, u8),
    Fire(PlayerId),
    ToggleFlashlight(PlayerId),
    VoteRestart(PlayerId, bool),
    ResyncMap(PlayerId),
    Leave(PlayerId),
    /// "Start with bots" from the lobby (§C18) — the solo path.
    StartWithBots(PlayerId),
    /// Who is in this room: total seats taken, and how many are bots.
    ///
    /// A separate command rather than an `Inspect`, because `bots` lives on the
    /// `Room` and not on the `World` — the sim has no concept of a bot, which is
    /// the point (§A5: a bug in bots is a bug in the game).
    /// The roster with names, for `welcome`. A read: not recorded.
    Roster {
        reply: oneshot::Sender<Vec<RosterRow>>,
    },
    Status {
        reply: oneshot::Sender<(usize, usize)>,
    },
    /// Change the map size the match will use (§E3).
    ///
    /// Refused unless the sender is the `settings_owner`; the reply says which,
    /// because a silent no-op is indistinguishable from a lost message at the
    /// client (§E6).
    SetScale {
        by: PlayerId,
        scale: game_core::constants::MapScale,
        reply: oneshot::Sender<Result<(), &'static str>>,
    },
    /// The three §F7 settings a **private** lobby's host may change, alongside
    /// `SetScale` and behaving exactly like it: host-only, refused with a reason
    /// (§E6), recorded in the replay, and clearing every ready flag.
    ///
    /// Three commands rather than one `SetSetting(key, value)` because the
    /// values have three different types and a single command would carry them
    /// as strings — moving the parse from the socket boundary, where a bad value
    /// can still be refused with a reason, into the room, where it cannot.
    SetBots {
        by: PlayerId,
        on: bool,
        reply: oneshot::Sender<Result<(), &'static str>>,
    },
    SetStartKit {
        by: PlayerId,
        kit: game_core::constants::StartKit,
        reply: oneshot::Sender<Result<(), &'static str>>,
    },
    SetRoundSeconds {
        by: PlayerId,
        seconds: f32,
        reply: oneshot::Sender<Result<(), &'static str>>,
    },
    /// Tell the room who it is: its join code, and whether it is private.
    ///
    /// The registry owns identity — it mints codes and keeps the `code -> id`
    /// map — but `lobby_state` is emitted from the room task, which has no
    /// registry. Sent once, immediately after `spawn`, before anyone can be
    /// seated. A command rather than a constructor argument because the code is
    /// minted *after* the spawn and reordering that would push both through the
    /// `Spawner` trait and its test doubles.
    SetIdentity {
        code: Option<String>,
        private: bool,
    },
    /// Read the lobby, for the join handshake and for tests.
    LobbyRead {
        reply: oneshot::Sender<LobbyState>,
    },
    /// Everything the join handshake needs, in **either** state.
    ///
    /// `Inspect` cannot answer it: a lobby has no world, so the closure is
    /// dropped and the caller sees `None` — which reads as "the room is gone"
    /// and is not. §E1 made a world-less room the normal case, so the join path
    /// needs a read that does not assume one.
    JoinInfo {
        reply: oneshot::Sender<JoinInfo>,
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
            Command::Ready(id, on) => write!(f, "Ready({id}, {on})"),
            Command::Input(id, v) => write!(f, "Input({id}, {} inputs)", v.len()),
            Command::UseItem(id, s) => write!(f, "UseItem({id}, slot {s})"),
            Command::SelectSlot(id, s) => write!(f, "SelectSlot({id}, slot {s})"),
            Command::UseHeal(id) => write!(f, "UseHeal({id})"),
            Command::UseBatteryPack(id) => write!(f, "UseBatteryPack({id})"),
            Command::QuickThrow(id) => write!(f, "QuickThrow({id})"),
            Command::MoveItem(id, a, b) => write!(f, "MoveItem({id}, {a} -> {b})"),
            Command::DropItem(id, slot) => write!(f, "DropItem({id}, {slot})"),
            Command::Fire(id) => write!(f, "Fire({id})"),
            Command::ToggleFlashlight(id) => write!(f, "ToggleFlashlight({id})"),
            Command::VoteRestart(id, v) => write!(f, "VoteRestart({id}, {v})"),
            Command::ResyncMap(id) => write!(f, "ResyncMap({id})"),
            Command::Leave(id) => write!(f, "Leave({id})"),
            Command::StartWithBots(id) => write!(f, "StartWithBots({id})"),
            Command::Roster { .. } => f.write_str("Roster"),
            Command::Status { .. } => f.write_str("Status"),
            Command::JoinInfo { .. } => f.write_str("JoinInfo"),
            Command::SetIdentity { code, private } => {
                write!(f, "SetIdentity({code:?}, private {private})")
            }
            Command::SetScale { by, scale, .. } => write!(f, "SetScale({by}, {scale:?})"),
            Command::SetBots { by, on, .. } => write!(f, "SetBots({by}, {on})"),
            Command::SetStartKit { by, kit, .. } => write!(f, "SetStartKit({by}, {kit:?})"),
            Command::SetRoundSeconds { by, seconds, .. } => {
                write!(f, "SetRoundSeconds({by}, {seconds})")
            }
            Command::LobbyRead { .. } => f.write_str("LobbyRead"),
            Command::Inspect(_) => f.write_str("Inspect"),
        }
    }
}

#[derive(Clone)]
pub struct RoomHandle {
    tx: mpsc::Sender<Command>,
    /// Whether a match is running **right now** (§E2/§E4).
    ///
    /// Read by `quick_match`, which cannot await a reply while holding the
    /// registry lock, and by the seat path's §E4 refusal.
    ///
    /// **Owned by `Room`**, which sets it in `install_world` and clears it in
    /// `return_to_lobby`. It used to be set by the room task and never cleared
    /// at all — so a room whose round ended and returned to the lobby stayed
    /// "started" for the rest of its life: quick match skipped it forever and
    /// §E4 refused every join with `in_progress`, for a room sitting in `Lobby`
    /// with players in it. One bit with one owner, because the two answers to
    /// "is a match running" had already drifted apart.
    ///
    /// An `AtomicBool` rather than a `Command`: the answer is one bit, the
    /// reader is inside a lock, and a bit that is read stale for one tick is a
    /// player seated into a match that has just begun — which is the thing being
    /// prevented.
    started: Arc<std::sync::atomic::AtomicBool>,
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
            started: Arc::new(std::sync::atomic::AtomicBool::new(false)),
            task: Arc::new(tokio::sync::Mutex::new(None)),
        }
    }

    /// Has this room's match begun? Closed to quick match once true (§E2/§E4).
    pub fn has_started(&self) -> bool {
        self.started.load(std::sync::atomic::Ordering::Relaxed)
    }

    /// Mark this room started, without running a match. Test seam for the
    /// registry's "quick match skips a started match" claim (§E2/§E4): it flips
    /// the same bit `install_world` sets, at the site `quick_match` reads.
    pub fn mark_started_for_test(&self) {
        self.started
            .store(true, std::sync::atomic::Ordering::Relaxed);
    }

    /// Seats taken and how many are bots, for the lobby (§B10).
    /// The roster with names, as `welcome` needs it.
    pub async fn roster(&self) -> Option<Vec<RosterRow>> {
        let (tx, rx) = oneshot::channel();
        self.tx.send(Command::Roster { reply: tx }).await.ok()?;
        rx.await.ok()
    }

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

    /// Ask this room to start its match, and wait until it has a world.
    ///
    /// The solo path (`start_with_bots`, §C18) plus the wait §E1 introduced:
    /// the room asks for a world on the tick and the room task builds it on a
    /// blocking thread, so "started" is not true the instant the command lands.
    /// A test that asserts on a world has to wait for one, and waiting on the
    /// condition rather than a sleep is what stops it expiring the next time the
    /// generator gets slower.
    pub async fn start_and_wait(&self, id: PlayerId, budget: Duration) -> bool {
        if self.tx.send(Command::StartWithBots(id)).await.is_err() {
            return false;
        }
        let deadline = Instant::now() + budget;
        while Instant::now() < deadline {
            if self.inspect(|w| w.tick).await.is_some() {
                return true;
            }
            tokio::time::sleep(Duration::from_millis(25)).await;
        }
        false
    }

    /// Tell the room its identity. Fire-and-forget: sent once, before seating.
    pub fn set_identity(&self, code: Option<String>, private: bool) {
        let _ = self.tx.try_send(Command::SetIdentity { code, private });
    }

    /// Change the map size, as `by`. `Err` names why it was refused (§E6).
    pub async fn set_scale(
        &self,
        by: PlayerId,
        scale: game_core::constants::MapScale,
    ) -> Result<(), &'static str> {
        let (tx, rx) = oneshot::channel();
        if self
            .tx
            .send(Command::SetScale {
                by,
                scale,
                reply: tx,
            })
            .await
            .is_err()
        {
            return Err("the room is gone");
        }
        rx.await.unwrap_or(Err("the room is gone"))
    }

    /// Turn bots on or off for this private lobby, as `by` (§F7).
    pub async fn set_bots(&self, by: PlayerId, on: bool) -> Result<(), &'static str> {
        let (tx, rx) = oneshot::channel();
        if self
            .tx
            .send(Command::SetBots { by, on, reply: tx })
            .await
            .is_err()
        {
            return Err("the room is gone");
        }
        rx.await.unwrap_or(Err("the room is gone"))
    }

    /// Choose what every player spawns holding, as `by` (§F7).
    pub async fn set_start_kit(
        &self,
        by: PlayerId,
        kit: game_core::constants::StartKit,
    ) -> Result<(), &'static str> {
        let (tx, rx) = oneshot::channel();
        if self
            .tx
            .send(Command::SetStartKit { by, kit, reply: tx })
            .await
            .is_err()
        {
            return Err("the room is gone");
        }
        rx.await.unwrap_or(Err("the room is gone"))
    }

    /// Set the round length, as `by` (§F7). Out of range is refused, not clamped.
    pub async fn set_round_seconds(&self, by: PlayerId, seconds: f32) -> Result<(), &'static str> {
        let (tx, rx) = oneshot::channel();
        if self
            .tx
            .send(Command::SetRoundSeconds {
                by,
                seconds,
                reply: tx,
            })
            .await
            .is_err()
        {
            return Err("the room is gone");
        }
        rx.await.unwrap_or(Err("the room is gone"))
    }

    /// This room's lobby, for the join handshake and for tests.
    pub async fn lobby_state(&self) -> Option<LobbyState> {
        let (tx, rx) = oneshot::channel();
        self.tx.send(Command::LobbyRead { reply: tx }).await.ok()?;
        rx.await.ok()
    }

    /// Read the join handshake's inputs. Works in a lobby, where `inspect` cannot.
    pub async fn join_info(&self) -> Option<JoinInfo> {
        let (tx, rx) = oneshot::channel();
        self.tx.send(Command::JoinInfo { reply: tx }).await.ok()?;
        rx.await.ok()
    }
}

/// What the join handshake reads off a room, whether or not it has a world.
///
/// `map` is `None` in a lobby, and that is the whole point: §E1 sends `map_init`
/// when the match starts, not when a player sits down.
pub struct JoinInfo {
    pub tick: u32,
    pub round_time: f32,
    pub phase: String,
    pub time_left: f32,
    pub seed: u64,
    pub scale: game_core::constants::MapScale,
    pub map: Option<Vec<u8>>,
    /// The lobby, in the **same** read (§E6).
    ///
    /// Not a second round-trip: the room task does not drain commands while it
    /// awaits map generation, so a second `await` in the seat path stalls for
    /// the whole generator — measured, `map_init` then missed a 15 s budget
    /// while carves flowed past on other sockets.
    pub lobby: LobbyState,
}

/// One seat, as a lobby shows it (§E6).
pub struct LobbySeat {
    pub seat: PlayerId,
    pub name: String,
    pub skin_id: u16,
    pub ready: bool,
    pub bot: bool,
}

/// What a client sitting in a lobby is shown (§E6).
///
/// `players` is **derived from `Seats`** — §E1.1's single source — not built
/// beside it. There is no world to read a roster off in a lobby, and building a
/// third list here is the shape `welcome.players` and `room_list` already took
/// twice.
pub struct LobbyState {
    pub code: Option<String>,
    pub private: bool,
    pub capacity: usize,
    pub scale: game_core::constants::MapScale,
    /// §F7's three settings, carried here for the reason `scale` is: every seat
    /// has to see what the host chose, not just the host who chose it.
    pub bots: bool,
    pub start_kit: game_core::constants::StartKit,
    /// The room's round length **including** the environment default, so a seat
    /// reading this never sees a value the match will not use.
    pub round_seconds: f32,
    pub settings_owner: Option<PlayerId>,
    pub starts_in: Option<f32>,
    pub players: Vec<LobbySeat>,
}

/// One row of the roster a client needs to render other players:
/// `(id, name, skin, tombstone skin, score)`.
///
/// Named because it crosses three layers — the room, the command channel and
/// the `welcome` payload — and a bare tuple at each of them is three places to
/// get the order wrong.
pub type RosterRow = (PlayerId, String, u16, u16, i16);

/// The display name of the `index`-th bot seated in a room.
///
/// One function, because two places need the same answer and they used to
/// disagree by construction: `seat_bots` formatted it and `seated_bots` — which
/// announces them to the clients — had nowhere to read it back from. `World`
/// takes a name in `add_player` and drops it, and the `welcome` roster carries
/// no name either, so `player_join` is a client's only source for one.
fn bot_name(index: usize) -> String {
    format!("Bot {}", index + 1)
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
    /// The display name this player joined under.
    ///
    /// Kept here because `World::add_player` takes a name and **drops it**
    /// (`_name`) — `game-core` has no use for one. Nothing else retained it
    /// either, so the only place a name ever appeared was the `player_join`
    /// broadcast, which goes to everyone *except* the player who joined. The
    /// consequences were both visible: your own row on the scoreboard read
    /// `p0`, and anyone who joined a room already in progress saw every player
    /// already in it as `p1`, `p2`, `p3` forever, because `welcome`'s roster
    /// carried ids and skins and no names.
    name: String,
    /// The skin and grave this seat joined with.
    ///
    /// Kept here for the same reason `name` is, and now for a second one: a
    /// lobby has no world to put them in (§E1), so they wait on the seat until
    /// the match starts and `populate_world` adds everyone at once.
    skin_id: u16,
    tombstone_skin_id: u16,
    /// Bots are seated in the same table as humans and must be distinguishable
    /// without consulting `Room::bots` — `human_count` used to subtract one list
    /// length from another, which is a derived answer that two lists can
    /// disagree about (CLAUDE.md: "derive, do not add a fourth flag" cuts both
    /// ways — this is the flag that removes a disagreement, not one that adds).
    bot: bool,
    /// Handshake finished, and therefore simulated.
    ///
    /// Set once when `ready` first arrives and **never cleared**: it is what
    /// `sweep_unready` and `ready_ids` read, so clearing it would drop a player
    /// from the simulation and then from the room.
    ready: bool,
    /// §E3's consent: "I agree to start the game I am being shown."
    ///
    /// **A second field, because `ready` already meant two things and this would
    /// have been a third.** A private lobby starts when every human consents, so
    /// consent has to be revocable — and revoking `ready` would make the player
    /// eligible for `sweep_unready` thirty seconds later, which is precisely the
    /// timeout §E3 says a private lobby does not have. `CLAUDE.md`: a field that
    /// means two things is a bug waiting for the first caller that wants one of
    /// them, and T17.04 is that caller.
    consent: bool,
    joined_at: Instant,
    last_seq: u32,
    accepted_this_tick: u8,
    dropped_this_tick: u32,
}

impl Seats {
    /// The name a seat joined under, if it is still seated.
    fn name_of(&self, id: PlayerId) -> Option<String> {
        self.seats
            .iter()
            .find(|s| s.id == id)
            .map(|s| s.name.clone())
    }

    /// Record the display name a seat joined under.
    fn set_name(&mut self, id: PlayerId, name: &str) {
        if let Some(s) = self.seats.iter_mut().find(|s| s.id == id) {
            s.name = name.to_string();
        }
    }

    /// Record who a seat is, for a world that does not exist yet (§E1).
    fn set_identity(&mut self, id: PlayerId, name: &str, skin_id: u16, tombstone_skin_id: u16) {
        if let Some(s) = self.seats.iter_mut().find(|s| s.id == id) {
            s.name = name.to_string();
            s.skin_id = skin_id;
            s.tombstone_skin_id = tombstone_skin_id;
        }
    }

    /// Mark a seat as held by a bot, so `human_count` is a filter and not a
    /// subtraction of two list lengths.
    fn mark_bot(&mut self, id: PlayerId) {
        if let Some(s) = self.seats.iter_mut().find(|s| s.id == id) {
            s.bot = true;
        }
    }

    /// Mark a seat as in-simulation. Used by the join flow when `ready` arrives,
    /// and by bot seating, which has no handshake to wait for.
    fn mark_ready(&mut self, id: PlayerId) {
        if let Some(s) = self.seats.iter_mut().find(|s| s.id == id) {
            s.ready = true;
            // A bot is always willing. §E3's gate filters bots out, so this
            // changes nothing today — it is set so that the day the filter is
            // relaxed, a bot does not silently hold a lobby closed forever.
            s.consent = true;
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
            // Filled by `set_name` the moment the caller knows it: `alloc` is
            // reached from the bot path and the join path alike, and only the
            // latter has a name to give.
            name: String::new(),
            skin_id: 0,
            tombstone_skin_id: 0,
            bot: false,
            ready: false,
            consent: false,
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
    /// The world, once there is a match. **`None` while this room is a lobby**
    /// (`docs/74-amendments-v6.md` §E1).
    ///
    /// A lobby holds a roster, a code and its settings and nothing else. The map,
    /// the round clock, the weather schedule and the item spawns come into
    /// existence when the match starts — which is what lets a private lobby offer
    /// map size as a setting at all, because there is no map yet to contradict.
    ///
    /// This is an `Option` rather than two types because every command handler,
    /// the metrics and the replay writer already read a room and would otherwise
    /// each need both spellings. Asking for a world in a lobby is `None` — an
    /// answer, not a panic.
    world: Option<World>,
    /// The clock, while there is no world to hold it.
    ///
    /// `docs/72` §C18-clarified: a lobby room must keep advancing `tick` even
    /// with no round, and §C27 records a determinism test that could not tell a
    /// round from an empty lobby. The world's `tick` continues from here when the
    /// match starts, so the sequence a client sees never goes backwards.
    lobby_tick: u32,
    /// This room's join code, and whether it is private (§E6). Set by the
    /// registry through `SetIdentity` right after the task is spawned.
    code: Option<String>,
    private: bool,
    /// Seconds until a public lobby fills its seats with bots (§E2).
    ///
    /// `None` until the **first** player is seated, and `None` forever in a
    /// private lobby, which has no timeout. It does not reset when others join.
    starts_in: Option<f32>,
    /// The whole second last announced, so `starts_in` is not broadcast 60x a
    /// second. The same throttle `round.rs` uses on `RoundState`, and for the
    /// same reason: the UI shows `ceil(left)`, so every tick in between is an
    /// identical-looking message to every client.
    starts_in_shown: Option<i32>,
    /// Something a client can see about this lobby changed, and has not been
    /// sent yet. Set by join, leave, ready, a settings change, and the timeout
    /// crossing a second; cleared by `take_lobby_update`.
    lobby_dirty: bool,
    /// Set when the start condition fires and cleared when the world arrives.
    ///
    /// The generator is 0.3–1.1 s of pure CPU and the tick loop is 16.7 ms, so
    /// `tick_once` cannot generate. It raises this instead; [`Room::wants_world`]
    /// is how the async loop notices, and [`Room::install_world`] is how the
    /// answer comes back.
    starting: bool,
    /// Shared with `RoomHandle::has_started`; see the field there for why the
    /// room owns it rather than the task.
    started: Arc<std::sync::atomic::AtomicBool>,
    seats: Seats,
    config: Arc<Config>,
    /// When the map went out, and therefore when the handshake became due.
    ///
    /// `sweep_unready` measures against `max(joined_at, this)`. **`joined_at`
    /// alone is wrong and it shipped that way**: a player who waits out a lobby
    /// longer than `READY_TIMEOUT` is already stale on the tick the world is
    /// installed, so the sweep drops them *before* `map_init` can reach the
    /// browser, let alone be decoded. Measured against
    /// `scripts/checks/lobby-start.mjs` (`LOBBY_BOT_TIMEOUT=45`): the round
    /// starts with `players 1 -> 3` — three bots and the human gone, one tick
    /// after the map it was waiting for. `None` while the room is a lobby, which
    /// is also the guard that keeps the sweep out of one.
    world_installed_at: Option<Instant>,
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
    /// The directory `start_recording` was handed, so `restart` can open round
    /// two's file **in the same place**.
    ///
    /// It used to rebuild the path from `config.replay_dir` instead, which is a
    /// different answer whenever the caller passed anything else: a test handing
    /// over a tempdir got round one in the tempdir and round two written into
    /// the repository's `crates/game-server/replays/`, where two stray binaries
    /// were found. `start_recording(dir, ..)` takes a directory and its sibling
    /// ignored it — "return what the caller needs", from the other side.
    replay_dir: Option<std::path::PathBuf>,
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

/// One random base per process, so restarting the server does not replay the
/// same maps. `game-server` is where impurity belongs — `game-core` never sees
/// this, it receives a `u64` like any other seed.
fn session_base() -> u64 {
    use std::sync::OnceLock;
    static BASE: OnceLock<u64> = OnceLock::new();
    *BASE.get_or_init(|| {
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_nanos() as u64)
            .unwrap_or(0x5EED_1234_ABCD_0001)
            // Nanos differ in their low bits and barely at all in their high
            // ones; the finaliser spreads that across the whole word so two
            // rooms created in the same millisecond do not get similar seeds.
            .wrapping_mul(0x9E37_79B9_7F4A_7C15)
    })
}

/// Mix a base and a room id into a seed. Murmur3's finaliser: cheap, and it
/// avoids the diagonal-symmetry class of collision §M1 already paid for.
fn mix_seed(base: u64, room_id: u32) -> u64 {
    let mut x = base ^ (u64::from(room_id).wrapping_mul(0xD6E8_FEB8_6659_FD93));
    x ^= x >> 33;
    x = x.wrapping_mul(0xFF51_AFD7_ED55_8CCD);
    x ^= x >> 33;
    x = x.wrapping_mul(0xC4CE_B9FE_1A85_EC53);
    x ^ (x >> 33)
}

/// Is `seconds` a legal §F7 round length?
///
/// **Refused, never clamped** (`docs/61` §3): the server already knows which of
/// the answers it was, and a clamp turns a client bug into a match nobody asked
/// for. Integer arithmetic rather than a float remainder because
/// `ROUND_SECONDS_MIN`/`_MAX`/`_STEP` are whole seconds and `240.0 % 60.0` is
/// not reliably zero.
pub fn validate_round_seconds(seconds: f32) -> Result<f32, &'static str> {
    use game_core::constants::{ROUND_SECONDS_MAX, ROUND_SECONDS_MIN, ROUND_SECONDS_STEP};
    if !seconds.is_finite() || seconds.fract() != 0.0 {
        return Err("the round length must be a whole number of seconds");
    }
    if !(ROUND_SECONDS_MIN..=ROUND_SECONDS_MAX).contains(&seconds) {
        return Err("the round length is out of range");
    }
    if (seconds as i32 - ROUND_SECONDS_MIN as i32) % ROUND_SECONDS_STEP as i32 != 0 {
        return Err("the round length is not a whole number of steps");
    }
    Ok(seconds)
}

/// A recorded command, turned back into one the room can apply.
///
/// **In the library, not in the `replay` binary, because a test cannot import a
/// binary** — so `tests/replay_run.rs` grew a second copy, and that copy had
/// already drifted: it was missing `SetScale` the moment the tag existed, which
/// is how a replay test could pass while the runner it stands in for diverged.
/// One implementation, two callers (`CLAUDE.md`).
pub fn to_command(c: &ReplayCommand) -> Command {
    match c {
        ReplayCommand::Join { name, skin_id } => {
            // The reply goes nowhere: the runner has no socket waiting on an id,
            // and seat allocation is deterministic from the command order, so the
            // replayed room assigns the same id the live one did.
            let (reply, _rx) = tokio::sync::oneshot::channel();
            Command::Join {
                name: name.clone(),
                skin_id: *skin_id,
                // Not recorded, and not needed: a grave's skin is cosmetic and
                // is excluded from `state_hash` for the same reason
                // `PlayerState.skin_id` is. A replay reproduces the simulation,
                // not the palette.
                tombstone_skin_id: 0,
                reply,
            }
        }
        ReplayCommand::Ready(id) => Command::Ready(*id, true),
        ReplayCommand::Unready(id) => Command::Ready(*id, false),
        // The reply goes nowhere: a replay has no socket to refuse to. The
        // room's own owner check still runs, so a recorded change made by
        // somebody who was the host then is applied now for the same reason.
        ReplayCommand::SetScale(id, scale) => Command::SetScale {
            by: *id,
            scale: *scale,
            reply: tokio::sync::oneshot::channel().0,
        },
        ReplayCommand::SetBots(id, on) => Command::SetBots {
            by: *id,
            on: *on,
            reply: tokio::sync::oneshot::channel().0,
        },
        ReplayCommand::SetStartKit(id, kit) => Command::SetStartKit {
            by: *id,
            kit: *kit,
            reply: tokio::sync::oneshot::channel().0,
        },
        ReplayCommand::SetRoundSeconds(id, secs) => Command::SetRoundSeconds {
            by: *id,
            seconds: *secs,
            reply: tokio::sync::oneshot::channel().0,
        },
        ReplayCommand::Input(id, v) => Command::Input(*id, v.clone()),
        ReplayCommand::UseItem(id, s) => Command::UseItem(*id, *s),
        ReplayCommand::SelectSlot(id, s) => Command::SelectSlot(*id, *s),
        ReplayCommand::UseHeal(id) => Command::UseHeal(*id),
        ReplayCommand::UseBatteryPack(id) => Command::UseBatteryPack(*id),
        ReplayCommand::QuickThrow(id) => Command::QuickThrow(*id),
        ReplayCommand::MoveItem(id, f, t) => Command::MoveItem(*id, *f, *t),
        ReplayCommand::DropItem(id, slot) => Command::DropItem(*id, *slot),
        ReplayCommand::Fire(id) => Command::Fire(*id),
        ReplayCommand::ToggleFlashlight(id) => Command::ToggleFlashlight(*id),
        ReplayCommand::VoteRestart(id, v) => Command::VoteRestart(*id, *v),
        // A sweep and a leave have the same effect on the world; the distinction
        // is only in why it happened, which the recorder keeps for the reader.
        ReplayCommand::Leave(id) | ReplayCommand::DropUnready(id) => Command::Leave(*id),
        // §C18. Named rather than folded into a catch-all: a `_ =>` here would
        // silently drop the command that *starts the round*, and the replay
        // would sit in an empty lobby and diverge on tick one.
        ReplayCommand::StartWithBots(id) => Command::StartWithBots(*id),
        // Unreachable: filtered out before this is called, because a checkpoint
        // is an observation rather than an input. Mapping it to a no-op command
        // would be a quiet lie about what the file contains.
        ReplayCommand::Checkpoint { .. } => unreachable!("checkpoints are not commands"),
    }
}

impl Room {
    /// Generates the map inline. Use [`Room::new_async`] from a tokio context:
    /// map generation is hundreds of milliseconds of pure CPU and blocks whatever
    /// worker it lands on.
    pub fn new(config: Arc<Config>) -> Self {
        Self::new_in_room(config, 0)
    }

    /// As [`Room::new`], but seeded for a specific room.
    ///
    /// Every room used to take the same hardcoded seed, so with more than one
    /// room every game on the server was played on an identical map — and after
    /// a restart, on that same map again. The 999-seed sweep was generating one
    /// map in practice. Found by the M10 checkpoint, which asserted two rooms
    /// differ and discovered they do not.
    ///
    /// `FIXED_SEED` still pins it exactly, because that is what it is for
    /// (`docs/41` §5: "reproduce the bug"). Without it the seed mixes a
    /// per-process base — so maps vary between rooms *and* between runs, while
    /// staying reproducible within a run given the room id.
    /// Point this room's "a match is running" bit at the handle's.
    ///
    /// `RoomHandle` is built before `run` constructs the `Room`, so the shared
    /// allocation is made there and adopted here — one `AtomicBool` with one
    /// owner writing it and the registry reading it.
    pub fn adopt_started_flag(&mut self, flag: Arc<std::sync::atomic::AtomicBool>) {
        flag.store(self.world.is_some(), std::sync::atomic::Ordering::Relaxed);
        self.started = flag;
    }

    pub fn new_in_room(config: Arc<Config>, room_id: u32) -> Self {
        let seed = match config.fixed_seed {
            Some(s) => s,
            None => mix_seed(session_base(), room_id),
        };
        // Buried slots are derived behind a secret that never crosses the wire
        // (`docs/70-amendments-v2.md` §A31). `welcome` carries the seed and
        // `game-core` ships as WASM, so without this a modified client
        // recomputes every slot exactly. `FIXED_SEED` pins the secret too, so
        // "reproduce the bug" still reproduces the whole round.
        let buried_secret = match config.fixed_seed {
            Some(_) => 0,
            None => seed.rotate_left(17) ^ 0x9E37_79B9_7F4A_7C15,
        };
        // §E1: **no map is generated here.** A room is born a lobby, and a lobby
        // has no world. `docs/71` §B2 measured generation at 0.3–1.1 s and
        // ticking at nearly nothing; that cost now falls at match start, where a
        // player expects a loading beat, instead of on the click that made the
        // lobby.
        Room {
            world: None,
            lobby_tick: 0,
            code: None,
            private: false,
            starts_in: None,
            starts_in_shown: None,
            // A freshly built lobby is worth announcing to the first socket that
            // is seated in it, and `seat` sends it directly. Nothing is seated
            // yet, so there is nothing to broadcast to.
            lobby_dirty: false,
            starting: false,
            started: Arc::new(std::sync::atomic::AtomicBool::new(false)),
            seats: Seats::default(),
            config,
            world_installed_at: None,
            lag_warned_at: 0,
            last_checksum_at: 0.0,
            bots: Vec::new(),
            bot_seq: 0,
            round: crate::round::RoundController::new(seed),
            replay: None,
            replay_dir: None,
            last_recorded_phase: game_core::world::RoundPhase::Lobby,
            dropped_inputs: 0,
            seed,
            buried_secret,
        }
    }

    /// Build this room's world. Pure CPU, hundreds of milliseconds, no `self`
    /// borrow held across it — so the caller can put it on a blocking thread.
    ///
    /// The seed rule is unchanged (`docs/71` §B13): `mix_seed(session_base(),
    /// room_id)` per room, fixed at construction, so two lobbies never play the
    /// same map and `FIXED_SEED` still pins one exactly.
    pub fn generate_world(&self) -> World {
        (self.generate_world_task())()
    }

    /// A closure that builds this room's world, owning everything it needs.
    ///
    /// Returned rather than generating in place because the caller puts it on a
    /// blocking thread and a `&self` borrow cannot cross that boundary.
    ///
    /// [`Room::generate_world`] calls this immediately, so there is **one**
    /// implementation of "build this room's map" and the inline path and the
    /// blocking path cannot drift apart (CLAUDE.md: share the guard, or share
    /// the function). They did, briefly, and the second copy was already missing
    /// a log line.
    pub fn generate_world_task(&self) -> impl FnOnce() -> World + Send + 'static {
        let seed = self.seed;
        let secret = self.buried_secret;
        let scale = self.config.map_scale;
        let generator = self.config.map_generator;
        let round_seconds = self.config.round_seconds;
        let weather_mode = self.config.weather_mode;
        move || {
            let mut world = World::with_generator(seed, scale, secret, generator);
            // `ROUND_SECONDS` is an environment override for testing (`docs/41`
            // §5) and it was parsed and then dropped: the world used the
            // constant, so a shortened round never shortened.
            world.set_round_seconds(round_seconds);
            world.weather_mode = weather_mode;
            world.set_phase(game_core::world::RoundPhase::Lobby);
            let _ = world.drain_events();
            // `docs/61` §3 row 1: the line a report of "the map was unplayable"
            // maps onto. Without `attempts` and `traversable_fraction` there is
            // nothing to look at but the seed.
            let m = &world.map.meta;
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
            world
        }
    }

    /// Has the start condition fired and the world not arrived yet?
    ///
    /// The async loop polls this rather than the room calling out, because
    /// `tick_once` runs inside a 16.7 ms budget and generation does not fit in
    /// one.
    pub fn wants_world(&self) -> bool {
        self.starting && self.world.is_none()
    }

    /// Install a generated world and begin the round. The one place a match
    /// starts.
    ///
    /// Everyone already seated is added here: a lobby seat is a promise of a
    /// player, and this is where the promise is kept. Bots come after, so a
    /// human who joined during generation still gets a seat ahead of them.
    pub fn install_world(&mut self, mut world: World) {
        // §E2/§E4: a match is running from this instant. Set here rather than
        // in the room task, so the bit and the world it describes move together.
        self.started
            .store(true, std::sync::atomic::Ordering::Relaxed);
        // **One clock.** The world continues the count the lobby was keeping.
        //
        // The alternative — start the world at 0 — makes the room's `tick` go
        // backwards at match start, and a replay stamps its commands with the
        // room's tick. Two clocks over one room's life is a field that means two
        // things, and the recorded stamps become ambiguous the moment a lobby
        // lasts more than a tick.
        //
        // The consequence is that **a replay must replay the lobby too**: how
        // long a room waited is part of what it recorded, not an unrecorded
        // variable to be skipped. `simulate`/`resimulate` drive `tick_inline`
        // from room construction for exactly that reason — and the state hash
        // diverged at the first checkpoint until they did, because a replay that
        // skipped the lobby seated its human *after* the bots instead of before.
        world.tick = self.lobby_tick;
        self.world = Some(world);
        // The handshake is due from **here**, not from when each player sat
        // down: this is the tick `map_init` goes out on, and the timeout is the
        // window to decode it.
        self.world_installed_at = Some(Instant::now());
        self.starting = false;
        self.populate_world();
        self.debug_dump();
        self.begin_round();
    }

    /// Add every seated human to the freshly built world.
    fn populate_world(&mut self) {
        let seated: Vec<(PlayerId, String, u16, u16)> = self
            .seats
            .seats
            .iter()
            .filter(|s| !s.bot)
            .map(|s| (s.id, s.name.clone(), s.skin_id, s.tombstone_skin_id))
            .collect();
        let Some(world) = self.world.as_mut() else {
            return;
        };
        for (id, name, skin_id, tombstone_skin_id) in &seated {
            world.add_player(*id, *skin_id, name.clone());
            if let Some(p) = world.player_mut(*id) {
                p.tombstone_skin_id = *tombstone_skin_id;
            }
        }
        for (id, _, _, _) in &seated {
            self.grant_dev_loadout(*id);
            self.grant_start_kit(*id);
        }
    }

    /// The world, once a match is running. `None` in a lobby (§E1).
    pub fn world(&self) -> Option<&World> {
        self.world.as_ref()
    }

    /// The world, once a match is running. `None` in a lobby (§E1).
    pub fn world_mut(&mut self) -> Option<&mut World> {
        self.world.as_mut()
    }

    /// Mark the lobby as changed, so the next tick broadcasts it.
    ///
    /// A flag rather than an emit at each call site: the room task owns the
    /// socket handles, and `apply` runs inside a drain loop that can process a
    /// join and a leave in the same tick. One broadcast per tick is what a
    /// client needs, and it is one message rather than two.
    fn note_lobby_change(&mut self) {
        self.lobby_dirty = true;
    }

    /// What a lobby looks like from outside (§E6).
    ///
    /// Reads `Seats` and nothing else for the roster: §E1.1 made it the source of
    /// seat identity, and this is the read that proves it — a lobby has no world
    /// to build a player list from.
    pub fn lobby_state(&self) -> LobbyState {
        LobbyState {
            code: self.code.clone(),
            private: self.private,
            capacity: game_core::constants::LOBBY_CAPACITY,
            scale: self.config.map_scale,
            bots: self.config.bots_enabled,
            start_kit: self.config.start_kit,
            // Read off the config, exactly as `scale` is: `SetRoundSeconds`
            // writes it there, so an untouched room reports the environment's
            // value and a set room reports the host's, with no third field that
            // can disagree with either.
            round_seconds: self.config.round_seconds,
            settings_owner: self.settings_owner(),
            starts_in: self.starts_in,
            players: self
                .seats
                .seats
                .iter()
                .map(|s| LobbySeat {
                    seat: s.id,
                    name: s.name.clone(),
                    skin_id: s.skin_id,
                    // The consent flag, not the handshake latch: "ready" on
                    // screen is the tick-box a player pressed, and §E3 starts
                    // the match on it.
                    ready: s.consent,
                    bot: s.bot,
                })
                .collect(),
        }
    }

    /// Who may change the settings: the longest-seated human (§E3).
    ///
    /// Derived rather than stored, so it cannot disagree with the roster: when
    /// the host leaves the answer moves on its own and there is no second flag
    /// to update (§E3).
    ///
    /// Keyed on `joined_at`, not on position in the vec. Position happens to be
    /// seating order today — `alloc` pushes and `free_seat` removes by index —
    /// but that is an accident of the container, and "longest-seated" is the
    /// rule. `Seat` already carries the timestamp.
    fn settings_owner(&self) -> Option<PlayerId> {
        self.seats
            .seats
            .iter()
            .filter(|s| !s.bot)
            .min_by_key(|s| s.joined_at)
            .map(|s| s.id)
    }

    /// Take the pending lobby broadcast, if the lobby changed this tick.
    ///
    /// `None` once a match is running: §E6's message describes a lobby, and a
    /// client that has a map is past needing it.
    pub fn take_lobby_update(&mut self) -> Option<LobbyState> {
        if !self.lobby_dirty || self.world.is_some() {
            self.lobby_dirty = false;
            return None;
        }
        self.lobby_dirty = false;
        Some(self.lobby_state())
    }

    /// The tick this room is on, world or not.
    ///
    /// A lobby's clock runs (`docs/72` §C18-clarified); this is the one place
    /// that answers "which tick" without caring which of the two is holding it.
    pub fn tick(&self) -> u32 {
        match self.world.as_ref() {
            Some(w) => w.tick,
            None => self.lobby_tick,
        }
    }

    /// The phase this room is in. A room with no world is a lobby, by definition.
    pub fn phase(&self) -> game_core::world::RoundPhase {
        match self.world.as_ref() {
            Some(w) => w.phase,
            None => game_core::world::RoundPhase::Lobby,
        }
    }

    /// Seat `BOT_COUNT` bots, up to the room's capacity.
    ///
    fn seat_bots(&mut self, seed: u64) {
        // §F7: "no bots at all when off". The gate is here rather than at the
        // two call sites because a third caller is what would reintroduce them.
        // §E3's start rule is untouched — a bot-less private lobby still starts
        // when every seated human is ready, and does not fall back to bots.
        if !self.config.bots_enabled {
            return;
        }
        let want = self.config.bot_count.min(self.config.max_players);
        for _ in 0..want {
            let Some(id) = self.seats.alloc(self.config.max_players) else {
                break;
            };
            let index = self.bot_seq;
            self.bot_seq += 1;
            let name = bot_name(index as usize);
            self.seats.set_name(id, &name);
            self.seats.mark_bot(id);
            if let Some(world) = self.world.as_mut() {
                world.add_player(id, 0, name);
            }
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
            self.grant_start_kit(id);
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
        // A lobby has no world to arm anyone in. `populate_world` calls this
        // again for every seat the moment the match starts, so nothing is lost
        // by returning here — the loadout lands when there is somewhere to put
        // it.
        if self.world.is_none() {
            return;
        }
        // Independent of the loadout: a check may want one without the other.
        if self.config.dev_start_health > 0.0 {
            if let Some(w) = self.world.as_mut() {
                if let Some(p) = w.player_mut(id) {
                    p.health = self.config.dev_start_health;
                }
            }
        }
        // Also independent, and also not gated on the loadout: §C8's bar colour
        // is what this is for, and it has nothing to do with weapons.
        if self.config.dev_poisoned {
            let now = self.world.as_ref().map(|w| w.round_time).unwrap_or(0.0);
            if let Some(w) = self.world.as_mut() {
                if let Some(p) = w.player_mut(id) {
                    p.poison(now);
                }
            }
        }
        if !self.config.dev_loadout {
            return;
        }
        // A full battery, because §B5 made the energy pool a *resource*: an energy
        // weapon with no charge is a paperweight, and a dev loadout that grants
        // the weapons and none of their ammunition arms nobody. It is also what
        // makes §C8's energy bar show anything at all — `hud-bars` sampled it and
        // found the empty track, which is a true reading of a bar with nothing
        // in it.
        if let Some(w) = self.world.as_mut() {
            if let Some(p) = w.player_mut(id) {
                p.battery = game_core::constants::BATTERY_MAX;
                // Heals too, and as a **counter** rather than through `give`:
                // §C9 took heals out of the inventory, so `give(MEDKIT)` would
                // occupy a quick-bar slot — shifting every slot index a check
                // depends on — and still leave `Q` with nothing to spend.
                //
                // `void` is why they are here: it digs beside the player with a
                // rocket, then asks the *void* to kill them. On 1 run in 8 the
                // blast or the fall finished them a few pixels above the line,
                // the server correctly credited the rocket, and the fixture had
                // competed with itself for its own kill.
                p.heals = game_core::constants::MAX_HEALS;
            }
        }
        // The dev list as `(item, count)` pairs, so it is handed out by the same
        // `give_all` §F7's starting kits use. One granting path: a second one
        // would be the place a rule earned here (§C24's refusal of a full stack,
        // the missing-world guard) is dropped.
        let items = [
            (game_core::items::registry::BAZOOKA, 4),
            (game_core::items::registry::SMG, 60),
            // There used to be a **second** bazooka stack here, because `MAX_STACK`
            // for a bazooka is 4 and four rockets is not enough to be "armed" for
            // anything longer than a few seconds — T9.06's full round burns them in
            // the first minute.
            //
            // §C24 ended that: a weapon occupies one slot ever, and a pickup of a
            // weapon already held at full ammo is *refused*. The second grant became
            // a silent no-op, and removing it is the honest version — but the
            // consequence is real and is not a fixture detail: **`DEV_LOADOUT` now
            // arms a player with 4 rockets, not 8.** Anything that assumed eight is
            // now measuring a shorter fight.
            //
            // It also moved every slot after the smg by one, which is §B16 — the
            // comment that used to sit here promised "appended, never inserted, so
            // the hotkeys other checks press stay put", and that invariant was true
            // right up until it was not. `ordnance` pressed Digit5 for the axe, got
            // the flamethrower, and reported a missing melee *render*. Browser
            // checks now select by weapon name (`harness.mjs::selectWeapon`), so the
            // order here is free to change again.
            //
            // These four give T11.10 a mine to place, a swing to see, a jet to spray
            // and a hazard to stand in.
            (game_core::items::registry::MINE, 2),
            // **No melee grant.** §F5 retired the axe to an unobtainable placeholder
            // and issues every player a shovel at spawn, so the swing `ordnance`
            // looks for is already in slot 0 — `give(AXE)` would hand out a weapon
            // no round can contain.
            (game_core::items::registry::FLAMETHROWER, 200),
            (game_core::items::registry::MOLOTOV, 2),
            // §F1 made the five ballistic guns projectiles, which leaves the two
            // energy weapons as the only things in the game that still fire a
            // **beam** — and `ordnance-visible` exists to prove a beam is drawn.
            // Without one in the loadout that half of the check has nothing to point
            // at. The battery above is what makes it fire; a laser with no charge is
            // a paperweight (§B5).
            (game_core::items::registry::LASER_PISTOL, 1),
        ];
        self.give_all(id, &items);
    }

    /// Hand `id` a list of `(item, count)` pairs.
    ///
    /// The one place items are put into a player's inventory at spawn, shared by
    /// the `DEV_LOADOUT` switch and §F7's starting kits. Silently does nothing
    /// in a lobby, which is the same answer `grant_dev_loadout` gives and for
    /// the same reason: there is no world to put anything in yet, and the caller
    /// runs again at match start.
    fn give_all(&mut self, id: PlayerId, items: &[(game_core::items::registry::ItemId, u8)]) {
        let Some(world) = self.world.as_mut() else {
            return;
        };
        for (item, count) in items {
            game_core::world::give(world, id, *item, *count);
        }
    }

    /// What each §F7 kit contains.
    ///
    /// Derived from the registry rather than listed, for `All`: a weapon added
    /// to `ITEMS` next milestone joins the kit without anyone remembering to
    /// come back here, and `registry::is_retired` is the one place that knows a
    /// zero-weight weapon may be a placeholder (five of them) or the issued
    /// shovel (one).
    fn kit_items(
        kit: game_core::constants::StartKit,
    ) -> Vec<(game_core::items::registry::ItemId, u8)> {
        use game_core::constants::StartKit;
        match kit {
            // Not empty by accident: §F5 issues a shovel in `PlayerState::new`,
            // so "none" already means "the shovel and nothing else" without this
            // function granting anything.
            StartKit::None => Vec::new(),
            StartKit::Basic => vec![
                (
                    game_core::items::registry::PISTOL,
                    game_core::constants::PISTOL_AMMO,
                ),
                (
                    game_core::items::registry::GRENADE,
                    game_core::constants::START_KIT_GRENADES,
                ),
            ],
            StartKit::All => game_core::items::registry::live_weapons()
                .into_iter()
                .map(|d| (d.id, d.max_stack))
                .collect(),
        }
    }

    /// Arm `id` with this room's starting kit (§F7).
    ///
    /// Called at match start, at a join into a running match, **and on every
    /// respawn** — the third one is not optional: `PlayerState::die` drops
    /// everything except the issued shovel (§F5), so a player who died with a
    /// `basic` kit would come back holding only the shovel and the setting would
    /// silently mean "for your first life".
    ///
    /// Deliberately not `grant_dev_loadout`: that is a development switch, off
    /// by default, and folding the two would make a lobby setting turn on
    /// `dev_start_health` and `dev_poisoned` with it.
    fn grant_start_kit(&mut self, id: PlayerId) {
        let kit = self.config.start_kit;
        if matches!(kit, game_core::constants::StartKit::None) {
            return;
        }
        self.give_all(id, &Self::kit_items(kit));
        // §B5: an energy weapon with no charge is a paperweight, so the kit that
        // grants every weapon grants what fires them. `basic` is two ballistic
        // items and needs none.
        if matches!(kit, game_core::constants::StartKit::All) {
            if let Some(w) = self.world.as_mut() {
                if let Some(p) = w.player_mut(id) {
                    p.battery = game_core::constants::BATTERY_MAX;
                }
            }
        }
    }

    /// May `by` change a **private** lobby setting right now (§F7)?
    ///
    /// One guard, three callers, in the order the errors matter: a public lobby
    /// is refused before the host check, so a non-host on a public lobby is told
    /// the true reason rather than one that would stop being true if they became
    /// host. §F7: "no settings on public lobbies. A public match is the game as
    /// shipped."
    fn check_settings_change(&self, by: PlayerId) -> Result<(), &'static str> {
        if self.world.is_some() {
            Err("the match has already started")
        } else if !self.private {
            Err("settings can only be changed in a private game")
        } else if self.settings_owner() != Some(by) {
            Err("only the host can change the settings")
        } else {
            Ok(())
        }
    }

    /// §E3: everyone agreed to the game they were shown, so a settings change
    /// clears every ready flag — including the changer's — and announces the
    /// lobby. Shared, because a fourth setting that forgot half of it would look
    /// exactly like one that worked.
    fn settings_changed(&mut self) {
        for st in self.seats.seats.iter_mut() {
            st.consent = false;
        }
        self.note_lobby_change();
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
        if let Some(world) = self.world.as_mut() {
            world.remove_player(bot.player);
        }
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
    pub async fn new_async(config: Arc<Config>, room_id: u32) -> Self {
        let c = config.clone();
        match tokio::task::spawn_blocking(move || Room::new_in_room(c, room_id)).await {
            Ok(room) => room,
            // The only way this fails is a panic inside generation, which is a bug
            // worth surfacing rather than papering over with a retry.
            Err(e) => {
                tracing::error!(target: "game::map", "map generation task failed: {e}");
                Room::new_in_room(config, room_id)
            }
        }
    }

    /// Note the command in the replay, if one is being recorded.
    ///
    /// A write failure drops the recorder and logs once. The alternative — an
    /// error path that can end a live round — trades a real game for a debugging
    /// aid, which is the wrong way round.
    fn note(&mut self, cmd: crate::replay::ReplayCommand) {
        let tick = self.tick();
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
                    // §E1: the seat is the roster now. A lobby has no world to
                    // put a player in, so who they are waits here until
                    // `populate_world` adds everyone at match start. A player who
                    // joins a running match is still added immediately, below.
                    self.seats
                        .set_identity(id, &name, skin_id, tombstone_skin_id);
                    self.note_lobby_change();
                    // §E2: the bot timeout runs from the **first** seating and
                    // does not reset. A private lobby never gets one (§E3).
                    if !self.private && self.starts_in.is_none() && self.world.is_none() {
                        // From the config, not the constant: a browser check has to be
                        // able to raise it, because at 10 s a cold page cannot reach
                        // `ready` before the lobby it means to observe is over.
                        self.starts_in = Some(self.config.lobby_bot_timeout);
                    }
                    if let Some(world) = self.world.as_mut() {
                        world.add_player(id, skin_id, name);
                        // §B8. Parsed from `join` and, until now, dropped on the
                        // floor — the §A39 shape again, in the join path itself.
                        if let Some(p) = world.player_mut(id) {
                            p.tombstone_skin_id = tombstone_skin_id;
                        }
                        self.grant_dev_loadout(id);
                        self.grant_start_kit(id);
                    }
                }
                let _ = reply.send(id);
            }
            Command::Ready(id, on) => {
                if let Some(s) = self.seats.get_mut(id) {
                    // The latch only ever goes up: this socket has finished its
                    // handshake and stays simulated whether or not it later
                    // withdraws consent.
                    s.ready = true;
                    s.consent = on;
                    // Tag 2 means "ready"; un-readying is its own tag, so the
                    // recorded stream stays readable by anything that could
                    // read it yesterday. A replay that dropped the un-ready
                    // would start a private match early and diverge on tick 1.
                    self.note(if on { R::Ready(id) } else { R::Unready(id) });
                    self.note_lobby_change();
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
                    // Input in a lobby has nowhere to go. Dropping it is the
                    // answer, not an omission: there is no world to move in.
                    if let Some(world) = self.world.as_mut() {
                        for input in accepted {
                            world.queue_input(id, input);
                        }
                    }
                }
            }
            Command::UseItem(id, slot) => {
                self.note(R::UseItem(id, slot));
                if let Some(world) = self.world.as_mut() {
                    let now = world.round_time;
                    if let Err(e) = world.use_item(id, slot, now) {
                        tracing::debug!(target: "game::items", player = id, slot, reason = ?e, "use rejected");
                    }
                }
            }
            Command::SelectSlot(id, slot) => {
                self.note(R::SelectSlot(id, slot));
                if let Some(world) = self.world.as_mut() {
                    world.select_slot(id, slot)
                }
            }
            Command::UseHeal(id) => {
                self.note(R::UseHeal(id));
                if let Some(world) = self.world.as_mut() {
                    if let Err(e) = world.use_heal(id) {
                        tracing::debug!(target: "game::items", player = id, reason = ?e, "heal rejected");
                    }
                }
            }
            Command::UseBatteryPack(id) => {
                self.note(R::UseBatteryPack(id));
                if let Some(world) = self.world.as_mut() {
                    if let Err(e) = world.use_battery_pack(id) {
                        tracing::debug!(target: "game::items", player = id, reason = ?e, "battery rejected");
                    }
                }
            }
            Command::QuickThrow(id) => {
                self.note(R::QuickThrow(id));
                if let Some(world) = self.world.as_mut() {
                    let now = world.round_time;
                    if let Err(e) = world.quick_throw(id, now) {
                        tracing::debug!(target: "game::weapons", player = id, reason = ?e, "quick throw rejected");
                    }
                }
            }
            Command::MoveItem(id, from, to) => {
                self.note(R::MoveItem(id, from, to));
                if let Some(world) = self.world.as_mut() {
                    if !world.move_item(id, from, to) {
                        tracing::debug!(target: "game::items", player = id, from, to, "move refused");
                    }
                }
            }
            Command::DropItem(id, slot) => {
                // Recorded before it is applied, like every other command here:
                // it changes the simulation — an item leaves an inventory and
                // appears in the world — so a replay that skipped it diverges on
                // the next pickup.
                self.note(R::DropItem(id, slot));
                if let Some(world) = self.world.as_mut() {
                    if !world.drop_item(id, slot) {
                        tracing::debug!(target: "game::items", player = id, slot, "drop refused");
                    }
                }
            }
            Command::Fire(id) => {
                self.note(R::Fire(id));
                if let Some(world) = self.world.as_mut() {
                    let now = world.round_time;
                    // `docs/61` §3 row 6: "my rocket did nothing" has six possible
                    // answers and the server already knows which one it was.
                    if let Err(e) = world.fire(id, now) {
                        tracing::debug!(target: "game::weapons", player = id, reason = ?e, "fire rejected");
                    }
                }
            }
            Command::ToggleFlashlight(id) => {
                self.note(R::ToggleFlashlight(id));
                if let Some(world) = self.world.as_mut() {
                    world.toggle_flashlight(id)
                }
            }
            Command::VoteRestart(id, v) => {
                self.note(R::VoteRestart(id, v));
                if let Some(world) = self.world.as_ref() {
                    self.round.vote(world, id, v)
                }
            }
            // Not recorded: a resync sends the client a fresh map and changes
            // nothing about the simulation.
            Command::ResyncMap(_) => {}
            Command::Leave(id) => {
                self.note(R::Leave(id));
                self.seats.free_seat(id);
                self.note_lobby_change();
                if let Some(world) = self.world.as_mut() {
                    world.remove_player(id);
                }
                self.round.forget(id);
                // §C18: a room that has lost its last human goes back to
                // **The reaper owns this event, and nothing else does** (§E5).
                //
                // This used to call `return_to_lobby`, which destroys the world
                // immediately. The registry says the opposite on the very same
                // condition (`detach_from`): "the tick keeps running until
                // reap... stopping the world mid-round would break a player
                // reconnecting inside the TTL". The room's handler ran first, so
                // that comment described an intent the code did not deliver —
                // and it sat directly on the seam §E4 leaves open on purpose.
                //
                // One mechanism for one event: the room keeps ticking, the
                // registry starts its clock, and `ROOM_EMPTY_TTL` later the whole
                // room goes. The cost is bots simulating in an abandoned room for
                // at most that TTL, bounded by `MAX_ROOMS` — cheap and finite,
                // and it is what makes reconnection reachable later rather than
                // more closed.
            }
            Command::StartWithBots(id) => {
                self.note(R::StartWithBots(id));
                self.request_start();
            }
            // Not recorded: reading who is seated changes nothing.
            Command::Roster { reply } => {
                let _ = reply.send(self.roster());
            }
            Command::Status { reply } => {
                let seated = self
                    .world
                    .as_ref()
                    .map_or(self.seats.seats.len(), |w| w.players.len());
                let _ = reply.send((seated, self.bots.len()));
            }
            // A lobby has no world to inspect. The closure is dropped, which is
            // the honest answer — running it against a world that does not exist
            // is the panic this `Option` is here to prevent.
            // Not recorded: reading a lobby changes nothing.
            Command::LobbyRead { reply } => {
                let _ = reply.send(self.lobby_state());
            }
            // **Recorded**, and the reason is a divergence this task created.
            // The replay header writes `scale` when the room is *constructed*
            // (`replay.rs`), and T17.01 moved world generation to match *start*
            // — so between those two moments the host can now change the map and
            // the header stops describing what was built. The runner applies
            // commands into a real `Room`, so replaying the change is what makes
            // the regenerated map the one that was played.
            Command::SetScale { by, scale, reply } => {
                let answer = if self.world.is_some() {
                    Err("the match has already started")
                } else if self.settings_owner() != Some(by) {
                    Err("only the host can change the settings")
                } else {
                    let mut config = (*self.config).clone();
                    config.map_scale = scale;
                    self.config = Arc::new(config);
                    self.note(R::SetScale(by, scale));
                    // §E3: everyone agreed to the game they were shown, so a
                    // settings change clears every ready flag — including the
                    // changer's. T17.04 asserts that. It is no longer "the one
                    // place a setting moves" — §F7 added three more — so the
                    // clearing is `settings_changed`, shared by all four.
                    self.settings_changed();
                    Ok(())
                };
                let _ = reply.send(answer);
            }
            // The three §F7 settings. **Recorded**, for the reason `SetScale`
            // is: each one changes what the match is built from, and a replay
            // that skipped it would build a different match (§E1.2).
            //
            // **Which of the header and the command is authoritative depends
            // on which round you are replaying, and both carriers are needed.**
            // Within round one the command wins: the header was written when the
            // room was constructed, before a host could touch anything, so it
            // describes the room's birth and the stream describes the match.
            // From round two it is the reverse — `restart()` writes a *fresh*
            // header and a fresh file, and the change the host made in the lobby
            // is in the previous file, so the header is the **only** carrier. All
            // three therefore live on `Config`, which is what the header is built
            // from. `bots` and `start_kit` were `Room` fields first and round two
            // replayed at the defaults; see `config.rs`.
            Command::SetBots { by, on, reply } => {
                let answer = self.check_settings_change(by).map(|()| {
                    let mut config = (*self.config).clone();
                    config.bots_enabled = on;
                    self.config = Arc::new(config);
                    self.note(R::SetBots(by, on));
                    self.settings_changed();
                });
                let _ = reply.send(answer);
            }
            Command::SetStartKit { by, kit, reply } => {
                let answer = self.check_settings_change(by).map(|()| {
                    let mut config = (*self.config).clone();
                    config.start_kit = kit;
                    self.config = Arc::new(config);
                    self.note(R::SetStartKit(by, kit));
                    self.settings_changed();
                });
                let _ = reply.send(answer);
            }
            Command::SetRoundSeconds { by, seconds, reply } => {
                let answer = self
                    .check_settings_change(by)
                    .and_then(|()| validate_round_seconds(seconds))
                    .map(|seconds| {
                        let mut config = (*self.config).clone();
                        config.round_seconds = seconds;
                        self.config = Arc::new(config);
                        self.note(R::SetRoundSeconds(by, seconds));
                        self.settings_changed();
                    });
                let _ = reply.send(answer);
            }
            // Not recorded: identity is registry bookkeeping, not simulation.
            Command::SetIdentity { code, private } => {
                self.code = code;
                self.private = private;
            }
            Command::JoinInfo { reply } => {
                let info = JoinInfo {
                    tick: self.tick(),
                    round_time: self.world.as_ref().map_or(0.0, |w| w.round_time),
                    phase: self.phase().as_str().to_string(),
                    // A lobby's round has not started, so it has no time left to
                    // report. `INFINITY` is what the round controller already
                    // emits for "not counting" (`round.rs`), so the client needs
                    // no second spelling.
                    time_left: self
                        .world
                        .as_ref()
                        .map_or(f32::INFINITY, |w| w.phase_time_left()),
                    seed: self.seed,
                    scale: self.config.map_scale,
                    map: self
                        .world
                        .as_ref()
                        .map(|w| crate::codec::encode_map_init_at(&w.map, w.carve_seq())),
                    lobby: self.lobby_state(),
                };
                let _ = reply.send(info);
            }
            Command::Inspect(f) => {
                if let Some(world) = self.world.as_mut() {
                    f(world)
                }
            }
        }
    }

    /// Drop players who connected but never sent `ready`.
    ///
    /// Without this a client that fails to decode the map holds a slot forever,
    /// and on a six-player room that is noticeable (`docs/40` §1).
    ///
    /// **Never in a lobby** — the room has to have a world (T20.01).
    ///
    /// `docs/74` §E3: *"No timeout, ever. A private lobby waits as long as its
    /// players do."* A thirty-second eviction is precisely that timeout, and it
    /// was firing: `Seat.ready` is the handshake latch set only by
    /// `Command::Ready`, the only `ready` a private-lobby client sends is the
    /// tick-box it may never press, and so the **host** was swept out of its own
    /// lobby at t=30 s. `settings_owner()` is the longest-seated human and then
    /// answered `None`, which is how every arrow came back *"only the host can
    /// change the settings"* while the screen still drew them enabled, because
    /// the sweep told nobody.
    ///
    /// **The scope is `world.is_some()`, and not §E3's "private" — measured.**
    /// The ruling said "a started match, **or a non-private room**", on the
    /// finding that a public lobby cannot reach 30 s: `starts_in` is set to
    /// `LOBBY_BOT_TIMEOUT` (10.0) the moment the first player is seated. That is
    /// true at the shipped configuration and false wherever the override exists
    /// — `scripts/checks/lobby-start.mjs` runs `LOBBY_BOT_TIMEOUT=45`, and there
    /// the public branch is reachable and **wrong**: measured at the base commit,
    /// the sole human is swept at t=30 s and the round starts at t=42.7 s with
    /// `3 players`, all of them bots. It passed only because the socket kept its
    /// `SessionMap` entry and went on receiving a match it had no seat in.
    ///
    /// So the public branch was never a case the sweep was built for; it was the
    /// same bug with no §E3 clause to name it. What is left is exactly what the
    /// paragraph above describes: *"a client that fails to decode the map"* — a
    /// client that has been **sent** one. `a_player_who_never_readies_is_dropped`
    /// and `withdrawing_ready_does_not_arm_the_unready_sweep` are that case and
    /// still fire.
    fn sweep_unready(&mut self, timeout: Duration) -> Vec<PlayerId> {
        // `None` exactly when there is no world, which is the guard above in one
        // value rather than two that can disagree.
        let Some(sent) = self.world_installed_at else {
            return Vec::new();
        };
        let stale: Vec<PlayerId> = self
            .seats
            .seats
            .iter()
            // `max(joined_at, sent)`: whichever came later is when this seat was
            // last asked for something. A late joiner is measured from its own
            // arrival; everybody who waited out the lobby is measured from the
            // map.
            .filter(|s| !s.ready && s.joined_at.max(sent).elapsed() > timeout)
            .map(|s| s.id)
            .collect();
        for id in &stale {
            tracing::info!(target: "game::net", player = id, "dropping: never sent ready");
            // Recorded, because this fires on wall-clock elapsed time and a
            // replay has no clock. Without it a replayed round keeps a seat the
            // live round freed, and diverges from there.
            self.note(crate::replay::ReplayCommand::DropUnready(*id));
            self.seats.free_seat(*id);
            if let Some(world) = self.world.as_mut() {
                world.remove_player(*id);
            }
            // The third divergence from `Leave`, and there is no reason for it:
            // a seat that is gone cannot hold a restart vote, and leaving one
            // behind means a two-player room can sit waiting on a vote from a
            // player who is not in it.
            self.round.forget(*id);
        }
        // **No `note_lobby_change()` here, and that is deliberate.** It would
        // read as the notification this sweep was missing and be a no-op:
        // `take_lobby_update()` answers `None` whenever there is a world (§E6 —
        // the message describes a lobby), and after the guard above the sweep
        // only ever runs when there is one. What actually tells the other
        // clients is the `player_leave` the call site broadcasts.
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
        // A lobby has no mask to checksum. Returning `false` rather than
        // checksumming an absent map is the whole reason this reads the world
        // through an `Option`.
        let Some(now) = self.world.as_ref().map(|w| w.round_time) else {
            return false;
        };
        if now - self.last_checksum_at < MASK_CHECKSUM_INTERVAL {
            return false;
        }
        self.last_checksum_at = now;
        true
    }

    pub fn ready_count(&self) -> usize {
        self.seats.seats.iter().filter(|s| s.ready).count()
    }

    /// Seats that are not bots.
    ///
    /// `seats.len()` counts bots, and using it as the start condition is what
    /// let a room start itself with nobody in it (§C18).
    pub fn human_count(&self) -> usize {
        self.seats.seats.iter().filter(|s| !s.bot).count()
    }

    /// Seat bots and enter `Warmup`. The one place a round begins.
    fn begin_round(&mut self) {
        self.seat_bots(self.seed);
        if let Some(world) = self.world.as_mut() {
            world.set_phase(game_core::world::RoundPhase::Warmup);
        }
        tracing::info!(
            target: "game::round",
            humans = self.human_count(),
            bots = self.bots.len(),
            "round starting"
        );
    }

    /// Return to `Lobby` and clear the bots.
    ///
    /// A `Lobby` room has no bots (§C18), so leaving them seated would give the
    /// next `human_count()` the wrong answer and let an empty room restart
    /// itself — the original bug, one layer along.
    fn return_to_lobby(&mut self) {
        for b in std::mem::take(&mut self.bots) {
            self.seats.free_seat(b.player);
            if let Some(world) = self.world.as_mut() {
                world.remove_player(b.player);
            }
        }
        // §E1: back to a lobby means back to having no world. The next match
        // generates a fresh one, which is what makes a changed map size take
        // effect and what stops a second round replaying the first one's map.
        self.lobby_tick = self.world.as_ref().map_or(self.lobby_tick, |w| w.tick);
        self.world = None;
        // Beside the assignment, for the reason `restart` gives about
        // `self.started`: there are three writes to `self.world` and each one has
        // to leave this agreeing with it, or `sweep_unready` measures a lobby
        // against a map that is no longer on anybody's screen.
        self.world_installed_at = None;
        self.starting = false;
        // No world, no match: the room is joinable again. Without this a room
        // whose round ended sat in `Lobby` refusing every join with
        // `in_progress` until the reaper took it.
        self.started
            .store(false, std::sync::atomic::Ordering::Relaxed);
    }

    /// The bots currently seated, as `(id, name, skin, tombstone skin)`.
    ///
    /// For the announcement the room task makes when a round begins — see
    /// `events::emit_player_join`. It returns what the caller needs rather than
    /// exposing `bots` and making every caller reach into the world for the
    /// name (CLAUDE.md: "return what the caller needs").
    pub fn seated_bots(&self) -> Vec<(PlayerId, String, u16, u16)> {
        self.bots
            .iter()
            .filter_map(|b| {
                // Read back off the seat, not recomputed. Two functions
                // formatting the same name independently is the shape that
                // drifts the moment either changes (CLAUDE.md: "share the
                // guard, or share the function").
                // The same fallback `roster` uses, not `?`. Dropping a nameless
                // bot here would silently announce fewer players than the
                // snapshot carries — two paths answering one question two ways
                // is the drift `bot_name` was introduced to end.
                let name = self
                    .seats
                    .name_of(b.player)
                    .unwrap_or_else(|| format!("p{}", b.player));
                self.world
                    .as_ref()
                    .and_then(|w| w.player(b.player))
                    .map(|p| (b.player, name, p.skin_id, p.tombstone_skin_id))
            })
            .collect()
    }

    /// The whole roster as the clients need to render it: id, name, skin,
    /// tombstone skin, score.
    ///
    /// `welcome` used to build this straight off `World::players`, which knows
    /// no names — so a joining client was told who was there but not what any
    /// of them were called, including itself.
    pub fn roster(&self) -> Vec<RosterRow> {
        // §E1: in a lobby the seats *are* the roster — there is no world to read
        // one off. `welcome` is sent to a player sitting in a lobby now, so this
        // is the path that answers "who else is here" before a match exists.
        let Some(world) = self.world.as_ref() else {
            return self
                .seats
                .seats
                .iter()
                .map(|s| (s.id, s.name.clone(), s.skin_id, s.tombstone_skin_id, 0))
                .collect();
        };
        world
            .players
            .iter()
            .map(|p| {
                (
                    p.id,
                    self.seats
                        .name_of(p.id)
                        .unwrap_or_else(|| format!("p{}", p.id)),
                    p.skin_id,
                    p.tombstone_skin_id,
                    p.score,
                )
            })
            .collect()
    }

    /// A player pressed "Start with bots".
    pub fn request_start(&mut self) {
        if self.phase() == game_core::world::RoundPhase::Lobby {
            self.round.request_start();
        }
    }

    /// One simulation step plus the bookkeeping around it.
    pub fn tick_once(&mut self, dt: f32) -> Vec<game_core::world::GameEvent> {
        self.seats.begin_tick();

        // §E1: a lobby has no world at all — no map, no round clock, no weather
        // schedule, no item spawns. Only the clock and the start condition run.
        let humans = self.human_count();
        let connected = self.seats.seats.len();

        if self.world.is_none() {
            // The clock runs; nothing else does (`docs/72` §C18-clarified, and
            // §C27's determinism test which could not tell a round from an empty
            // lobby).
            self.lobby_tick += 1;
            let tick = self.lobby_tick;

            // §E2's bot timeout, counted down here and **announced once per
            // whole second**, not sixty times a second. The UI shows `ceil`, so
            // every tick in between is an identical-looking message to every
            // client — the throttle `round.rs` already applies to `RoundState`.
            //
            // It runs from the **first** seating and does not reset when others
            // join: a player who has waited ten seconds is not made to wait
            // twenty because a second player arrived. A resetting timer is the
            // bug §E2 exists to prevent, so the countdown is started once, in
            // `Command::Join`, and only ever decremented here.
            let mut timed_out = false;
            if let Some(left) = self.starts_in {
                let left = (left - dt).max(0.0);
                self.starts_in = Some(left);
                timed_out = left <= 0.0;
                let shown = left.ceil() as i32;
                if self.starts_in_shown != Some(shown) {
                    self.starts_in_shown = Some(shown);
                    self.note_lobby_change();
                }
            }

            let (events, outcome) = self.round.tick_lobby(tick, dt);
            // §E2's start rule, in one place because all three of its inputs
            // live here and none of them live on the round controller.
            //
            // **Full starts immediately** — no countdown, because everyone who
            // is coming has arrived. `MIN_PLAYERS_TO_START` and
            // `LOBBY_COUNTDOWN` are retired: one human plus four bots after ten
            // seconds is a game, and two humans waiting forever is not.
            // **Both fill and timeout are public rules** (§E2). A private
            // lobby has neither: §E3 gives it one rule of its own, and a
            // private lobby that filled to five would otherwise start on top of
            // players who had not readied — the exact consent the ready gate
            // exists to ask for.
            let full = !self.private && humans >= game_core::constants::LOBBY_CAPACITY;

            // §E3: a private lobby starts when every seated human is ready.
            //
            // `all()` over an empty iterator is `true`, so the human count is
            // not a nicety — without it an empty private lobby starts itself
            // the tick it is created, with nobody in it.
            let everyone_ready = self.private
                && humans > 0
                && self
                    .seats
                    .seats
                    .iter()
                    .filter(|s| !s.bot)
                    .all(|s| s.consent);

            if outcome == crate::round::RoundOutcome::Start || full || timed_out || everyone_ready {
                // Not `begin_round` — there is nothing to begin yet. The world
                // has to be built first, and that is 0.3–1.1 s of CPU which
                // cannot happen inside a 16.7 ms tick. `run` picks this up.
                self.starting = true;
                // Stop counting: the match is starting, and a countdown that
                // kept running would keep marking the lobby dirty.
                self.starts_in = None;
            }
            return events;
        }

        self.drive_bots(dt);
        let poisoned = self.config.dev_poisoned;
        let Some(world) = self.world.as_mut() else {
            return Vec::new();
        };
        // Development only (§E13). **Held**, not stamped once at spawn: the
        // status lasts `TOXIC_POISON_DURATION` — three seconds — and a browser
        // check that has to reach the frame inside that window is a race. It
        // still costs `TOXIC_POISON_DPS`, so a player left in it does eventually
        // drop below the point where §C8's bar goes red, which is the rule
        // working rather than the knob failing.
        if poisoned {
            let now = world.round_time;
            for p in world.players.iter_mut() {
                p.poison(now);
            }
        }
        world.step(dt);

        let (mut events, outcome) = self.round.tick(world, connected, dt);

        // `docs/61` §3, the rows that only the event stream can answer. These are
        // deliberate diagnostic lines, not verbosity: each one is the thing you
        // grep for when a player says something vague.
        let round_time = self.world.as_ref().map_or(0.0, |w| w.round_time);
        // §F7's kit has to be re-granted here: `PlayerState::die` drops
        // everything but the issued shovel, so without this the setting would
        // mean "for your first life only". Collected rather than granted inside
        // the loop because the loop holds the event list.
        let mut respawned: Vec<PlayerId> = Vec::new();
        for e in self
            .world
            .as_ref()
            .map(|w| w.events_so_far())
            .unwrap_or_default()
        {
            match e {
                // "I spawned inside a rock" — the chosen point, so it can be
                // compared against the map.
                game_core::world::GameEvent::Respawn { id, x, y, .. } => {
                    tracing::debug!(target: "game::player", player = id, x, y, "respawned");
                    respawned.push(*id);
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
                        round_time,
                        "effect telegraphing"
                    );
                }
                _ => {}
            }
        }
        for id in respawned {
            self.grant_start_kit(id);
        }

        // A state hash every CHECKPOINT_STRIDE ticks, so a failed verification can
        // report *where* it diverged rather than only that it did. Written after
        // the step, so the hash describes the state at the tick it names.
        let checkpoint = self.world.as_ref().and_then(|w| {
            (w.tick > 0 && w.tick.is_multiple_of(crate::replay::CHECKPOINT_STRIDE)).then(|| {
                crate::replay::ReplayCommand::Checkpoint {
                    tick: w.tick,
                    hash: w.state_hash(),
                }
            })
        });
        if self.replay.is_some() {
            if let Some(cp) = checkpoint {
                self.note(cp);
            }
        }

        // Flush on a phase transition, not per command. A round that dies during
        // `Playing` then still has its warmup on disk, and the cost is four
        // flushes a round rather than thousands.
        if self.phase() != self.last_recorded_phase {
            self.last_recorded_phase = self.phase();
            self.flush_recording();
        }

        match outcome {
            crate::round::RoundOutcome::Continue => {}
            // Only reachable from `Lobby`, which returned above.
            crate::round::RoundOutcome::Start => {}
            crate::round::RoundOutcome::Restart { seed } => {
                events.extend(self.restart(seed));
            }
            crate::round::RoundOutcome::ToLobby => {
                self.return_to_lobby();
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
        let Some(world) = self.world.as_ref() else {
            return;
        };
        match serde_json::to_string_pretty(&world.map.meta) {
            Ok(j) => {
                if let Err(e) = std::fs::write(dir.join("meta.json"), j) {
                    tracing::error!(target: "game::map", "DEBUG_DUMP: meta.json: {e}");
                }
            }
            Err(e) => tracing::error!(target: "game::map", "DEBUG_DUMP: meta.json: {e}"),
        }

        #[cfg(feature = "dump-png")]
        {
            if let Err(e) = game_core::map::dump::dump_map(&world.map, &dir.join("map.png")) {
                tracing::error!(target: "game::map", "DEBUG_DUMP: map.png: {e}");
            }
            let report = game_core::map::gen::traversal::analyse(
                &world.map.mask,
                &world.map.meta.surface_points,
                &world.map.meta.objects,
            );
            if let Err(e) =
                game_core::map::dump::dump_surface(&world.map, &report, &dir.join("surface.png"))
            {
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
        self.replay_dir = Some(dir.to_path_buf());
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
        // A lobby has no world, so a recorder opened for one has no round to
        // close. Dropping it without a footer is right: there is nothing to
        // verify, and writing a footer that describes no simulation would make
        // the reader's "verified" mean less than it does.
        let Some(world) = self.world.as_ref() else {
            return;
        };
        let scores: Vec<(PlayerId, i16)> = world.players.iter().map(|p| (p.id, p.score)).collect();
        match w.finish(world, &scores) {
            Ok(path) => tracing::info!(
                target: "game::round",
                path = %path.display(),
                tick = world.tick,
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

    /// Backdate a seat's join time. Test hook, for the same reason
    /// `sweep_unready_for_test` exists: the alternative is a test that sleeps for
    /// `READY_TIMEOUT`. Unlike a shorter timeout, this can age one clock and
    /// leave the other alone, which is what the map-versus-seat window needs.
    pub fn age_seat_for_test(&mut self, id: PlayerId, by: Duration) {
        if let Some(s) = self.seats.get_mut(id) {
            s.joined_at -= by;
        }
    }

    /// Backdate when the map went out. The companion to `age_seat_for_test`.
    pub fn age_world_for_test(&mut self, by: Duration) {
        self.world_installed_at = self.world_installed_at.map(|t| t - by);
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
        // §E1.1: the seats are the roster. A restart used to copy the old
        // world's player list into the new one, which meant the identity of a
        // player survived only as long as a world did.
        let mut world = World::with_generator(
            seed,
            self.config.map_scale,
            buried_secret,
            self.config.map_generator,
        );
        world.set_round_seconds(self.config.round_seconds);
        // Both construction sites, or a `WEATHER=off` room gets its weather back
        // the moment the round restarts — which is the shape `set_round_seconds`
        // was already fixed for once (§E4).
        world.weather_mode = self.config.weather_mode;
        self.world = Some(world);
        // A restart sends a fresh `map_init`, so the handshake window restarts
        // with it — see the field's own comment.
        self.world_installed_at = Some(Instant::now());
        // §E2/§E4, unconditionally. There are three assignments to `self.world`
        // and every one of them must leave the bit agreeing with it, or
        // `has_started` describes a room that no longer exists.
        //
        // Correct without this **only** because `RoundOutcome::Restart` cannot
        // be produced without a world — an invariant that lives in `round.rs`,
        // not here. Leaning on a neighbour's invariant for a gate that decides
        // who may join is how the bit came to be set-once-never-cleared in the
        // first place.
        self.started
            .store(true, std::sync::atomic::Ordering::Relaxed);
        self.bots.clear();
        // Bot seats are freed here rather than carried: `seat_bots` below
        // allocates fresh ones, and a bot seat that outlived its `Bot` would be
        // a seat nothing drives.
        let bot_seats: Vec<PlayerId> = self
            .seats
            .seats
            .iter()
            .filter(|s| s.bot)
            .map(|s| s.id)
            .collect();
        for id in bot_seats {
            self.seats.free_seat(id);
        }
        self.populate_world();
        self.seat_bots(seed);
        if let Some(world) = self.world.as_mut() {
            world.set_phase(game_core::world::RoundPhase::Warmup);
        }
        self.last_checksum_at = 0.0;
        tracing::info!(target: "game::round", seed, "round restarted");
        if recording {
            // The directory round one was recorded into, not `config.replay_dir`
            // — see the field. The fallback is only reachable if `restart` ran
            // without a prior `start_recording`, which cannot happen because
            // `recording` is read off the live writer.
            let dir = self
                .replay_dir
                .clone()
                .unwrap_or_else(|| std::path::PathBuf::from(self.config.replay_dir.clone()));
            self.start_recording(&dir, &stamp_for(seed));
        }
        self.world
            .as_mut()
            .map(|w| w.drain_events())
            .unwrap_or_default()
    }

    /// Bots think **before** the step, so their input is consumed by the same
    /// tick a human's would be. Queued through `queue_input` like everything
    /// else — there is no bot branch inside `World::step`.
    fn drive_bots(&mut self, dt: f32) {
        if self.bots.is_empty() {
            return;
        }
        let Some(world) = self.world.as_ref() else {
            return;
        };
        let now = world.round_time;
        let mut uses: Vec<(PlayerId, u8)> = Vec::new();
        let mut selects: Vec<(PlayerId, u8)> = Vec::new();
        let mut fires: Vec<PlayerId> = Vec::new();
        // Split the borrow: `think` reads the world, so it cannot run while the
        // world is mutably borrowed for `queue_input`.
        let mut inputs: Vec<(PlayerId, game_core::player::input::Input)> =
            Vec::with_capacity(self.bots.len());
        for bot in &mut self.bots {
            let input = bot.think(world, now, dt);
            if let Some(slot) = bot.wants_use() {
                uses.push((bot.player, slot));
            }
            // Selection is a command too (`docs/30` §4), for the same reason
            // firing is: nothing in `Input` carries it. Without this the only
            // thing that ever changed a bot's selection was the inventory
            // auto-advancing on an empty stack, so a bot could not switch to a
            // better weapon or away from an uncharged energy one.
            if let Some(slot) = bot.wants_select() {
                selects.push((bot.player, slot));
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
        let Some(world) = self.world.as_mut() else {
            return;
        };
        for (id, input) in inputs {
            world.queue_input(id, input);
        }
        // Select before use and before fire: a bot that just picked up a better
        // weapon should fire *that* one this tick, not next tick.
        for (id, slot) in selects {
            world.select_slot(id, slot);
        }
        for (id, slot) in uses {
            let _ = world.use_item(id, slot, now);
        }
        for id in fires {
            if let Err(e) = world.fire(id, now) {
                tracing::debug!(target: "game::weapons", player = id, reason = ?e, "bot fire rejected");
            }
        }
    }

    /// Drive one tick, building the world inline if the tick asked for one.
    ///
    /// The production loop generates on a blocking thread instead (§E1: 0.3–1.1 s
    /// does not fit in a 16.7 ms tick). Both paths call the same
    /// `wants_world` / `generate_world` / `install_world` trio — only the thread
    /// that pays differs — so this is not a second implementation of starting a
    /// match. A test that had to stand up a tokio runtime and a `spawn_blocking`
    /// to watch a lobby start would not be written.
    pub fn tick_inline(&mut self, dt: f32) -> Vec<game_core::world::GameEvent> {
        let mut events = self.tick_once(dt);
        if self.wants_world() {
            let world = self.generate_world();
            self.install_world(world);
            if let Some(w) = self.world.as_mut() {
                events.extend(w.drain_events());
            }
        }
        events
    }

    /// The world, for a test that has started a match.
    ///
    /// **A test seam, and it panics.** Production reads the world through
    /// [`Room::world`], which returns `None` in a lobby — that is the answer §E1
    /// requires. A *test* that asserts on a world it never started is a broken
    /// test, and a panic naming the line is the fastest way to say so.
    pub fn world_for_test(&mut self) -> &mut World {
        self.world
            .as_mut()
            .expect("this test asserts on a world but never started a match")
    }

    /// Test seams. The room owns the controller, and a test that reached in and
    /// constructed its own would be testing a different object than the one the
    /// tick loop drives.
    pub fn vote_for_test(&mut self, id: PlayerId, restart: bool) {
        if let Some(world) = self.world.as_ref() {
            self.round.vote(world, id, restart);
        }
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
    let started = Arc::new(std::sync::atomic::AtomicBool::new(false));
    let task = tokio::spawn(run(
        io,
        config,
        sessions,
        rx,
        shutdown,
        metrics,
        room_id,
        started.clone(),
    ));
    RoomHandle {
        tx,
        started,
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
    started: Arc<std::sync::atomic::AtomicBool>,
) {
    // §E1: instant. No map is generated until the lobby says go, so this is a
    // struct allocation rather than `docs/71` §B2's 0.3–1.1 s of generator.
    let mut room = Room::new_in_room(config, room_id);
    room.adopt_started_flag(started);
    // At construction, as it always was — **not** at match start.
    //
    // I moved it to match start first, reasoning that a file describing a lobby
    // has no round in it. That is true and it is the wrong trade: the lobby is
    // where `Join` lands, so a recorder that opens after it produces a file whose
    // replay rebuilds an empty roster and diverges immediately. §E1 made the
    // lobby part of what a room does, so it is part of what a room records.
    //
    // A room that never starts leaves a file with no footer, which is the honest
    // outcome: there is no simulation to verify.
    let dir = std::path::PathBuf::from(room.config.replay_dir.clone());
    room.start_recording(&dir, &stamp_for(room.seed));
    let mut ticker = interval(Duration::from_secs_f64(1.0 / SIM_HZ as f64));
    // Burst, so a 50 ms descheduling is caught up rather than silently making the
    // round run slow — round time stays true to wall-clock (`docs/41` §2).
    ticker.set_missed_tick_behavior(MissedTickBehavior::Burst);

    // Wall-clock baseline for the lag check. §C18: it is **re-based when the
    // round starts**, because a room now waits in `Lobby` without ticking — and
    // measuring expected ticks from task start made every room that waited
    // report a permanent overrun (`lagging=608` after a ten-second lobby),
    // which would spam the log and make `tick_overruns` useless.
    let mut start = Instant::now();
    let mut was_lobby = true;

    loop {
        tokio::select! {
            _ = ticker.tick() => {
                // One span per tick, so every line logged inside the loop carries
                // `room` and `tick` automatically rather than by remembering
                // (`docs/61-logging-debug.md` §2).
                let span = tracing::info_span!("room", room = room_id, tick = room.tick() + 1);
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

                // §E1: the tick asked for a world and cannot build one — the
                // generator is 0.3–1.1 s and this loop has 16.7 ms. Off the tick
                // loop, on a blocking thread, exactly as `docs/41` §1 requires
                // and for the same reason `new_async` existed.
                let mut generated_this_tick = false;
                if room.wants_world() {
                    generated_this_tick = true;
                    let started_at = Instant::now();
                    let blueprint = room.generate_world_task();
                    let world = match tokio::task::spawn_blocking(blueprint).await {
                        Ok(w) => w,
                        // A panic inside generation is a bug worth surfacing.
                        // The lobby keeps waiting rather than the room dying.
                        Err(e) => {
                            tracing::error!(target: "game::map", "map generation failed: {e}");
                            continue;
                        }
                    };
                    tracing::info!(
                        target: "game::map",
                        ms = started_at.elapsed().as_millis() as u64,
                        "world generated for match start"
                    );
                    // Sets the §E2/§E4 bit itself, before the map goes out, so
                    // no socket can be seated into a match that is already
                    // handing out its map.
                    room.install_world(world);
                    // §E1: everyone seated gets the map now. They joined a lobby
                    // and were sent `welcome` without one; this is the message
                    // that turns a lobby screen into a game.
                    if let Some(world) = room.world() {
                        let bytes =
                            crate::codec::encode_map_init_at(&world.map, world.carve_seq());
                        crate::events::broadcast_map_init(&io, &sessions, &bytes);
                        // And what they are holding. The loadout is granted by
                        // `populate_world` a moment ago, and `inventory`
                        // describes *changes* — so without this a player seated
                        // in a lobby is armed on the server and empty on screen.
                        crate::events::broadcast_inventories(&io, &sessions, world);
                    }
                }

                let in_lobby = room.phase() == game_core::world::RoundPhase::Lobby;
                if was_lobby && !in_lobby {
                    start = Instant::now();
                    // The round just began, which is when `begin_round` seats
                    // the bots — with humans already connected. Their `welcome`
                    // was sent to an empty lobby, so this is the only thing that
                    // ever tells them who they are playing against.
                    for (id, name, skin, grave) in room.seated_bots() {
                        crate::events::emit_player_join(
                            &io,
                            &sessions,
                            room.tick(),
                            id,
                            &name,
                            skin,
                            grave,
                        );
                    }
                }
                was_lobby = in_lobby;
                for id in room.sweep_unready(READY_TIMEOUT) {
                    // The socket-layer half of leaving, which the sweep never
                    // did — see `session::release_swept_socket` for what it is
                    // and what it deliberately is not (the registry's `humans`
                    // count is unreachable from here, so the "room is never
                    // reaped" knock-on is **not** fixed).
                    if let Some(sid) = crate::session::release_swept_socket(&sessions, id) {
                        // A match sends no `lobby_state` (`take_lobby_update`
                        // returns `None` once there is a world), so during a
                        // round this is the only thing that tells the other
                        // clients the player is gone.
                        crate::session::broadcast_except(
                            &io,
                            &sessions,
                            sid,
                            "player_leave",
                            &serde_json::json!({ "id": id, "reason": "unready" }),
                        );
                    }
                }

                // §E6: one lobby broadcast per tick, when something changed.
                if let Some(state) = room.take_lobby_update() {
                    crate::events::broadcast_lobby_state(&io, &sessions, &state);
                }

                // A lobby has no world to drain or to broadcast. The round
                // controller's own events still flush — that is how a client
                // watching a lobby learns anything at all.
                let mut events = room
                    .world_mut()
                    .map(|w| w.drain_events())
                    .unwrap_or_default();
                events.extend(round_events);
                if let Some(world) = room.world() {
                    crate::events::flush_events(&io, world, &sessions, &events);
                } else {
                    crate::events::flush_lobby_events(&io, &sessions, room.seed, &events);
                }

                // Every third tick: 20 Hz, as SNAPSHOT_HZ says.
                if room.tick().is_multiple_of(SIM_HZ / SNAPSHOT_HZ) {
                    let seqs = room.last_seqs();
                    if let Some(world) = room.world() {
                        let bytes =
                            crate::events::broadcast_snapshot(&io, world, &sessions, &seqs);
                        if let Some(m) = metrics.as_ref() {
                            m.record_snapshot(bytes);
                        }
                    }
                }

                // **Not the tick that built the map.** §E1 moved generation to
                // match start, and it is awaited inside this arm — so
                // `tick_started.elapsed()` on that one tick is the generator's
                // 0.3-1.1 s, not the simulation's. Recording it marked a healthy
                // server as over budget on every round it started. The generation
                // cost is logged on its own line above, where it means something.
                if let Some(m) = metrics.as_ref().filter(|_| !generated_this_tick) {
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
                    if let Some(world) = room.world() {
                        let hash = world.map.mask.hash_hex();
                        let tick = world.tick;
                        crate::events::emit_mask_checksum(&io, &sessions, tick, &hash);
                    }
                }

                // Expected tick count from wall-clock, so a slow tick shows up.
                let expected = (start.elapsed().as_secs_f64() * SIM_HZ as f64) as u32;
                let behind = expected.saturating_sub(room.tick());
                if behind > LAG_WARN_TICKS && room.tick() > room.lag_warned_at + SIM_HZ {
                    room.lag_warned_at = room.tick();
                    if let Some(m) = metrics.as_ref() {
                        m.record_overrun();
                    }
                    tracing::warn!(target: "game::sim", lagging = behind, "tick overrun");
                }
            }
            _ = &mut shutdown => {
                tracing::info!(target: "game::round", "shutting down");
                crate::events::emit_round_end(&io, &sessions, room.tick(), "server_shutdown");
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
    /// Every room used to take the same hardcoded seed, so with more than one
    /// room every game on the server ran on an identical map. The M10 checkpoint
    /// found it by asserting two rooms differ.
    #[test]
    fn each_room_gets_its_own_seed() {
        let base = 0x1234_5678_9ABC_DEF0;
        let seeds: Vec<u64> = (0..64).map(|id| mix_seed(base, id)).collect();
        let unique: std::collections::HashSet<u64> = seeds.iter().copied().collect();
        assert_eq!(unique.len(), seeds.len(), "two rooms share a seed");
        // Adjacent ids must not give adjacent seeds: the generator's sub-streams
        // are derived from this, and neighbouring seeds would make neighbouring
        // rooms look alike even without colliding.
        for w in seeds.windows(2) {
            let d = w[0].abs_diff(w[1]);
            assert!(
                d > 1_000_000,
                "rooms {:x} and {:x} are too close",
                w[0],
                w[1]
            );
        }
    }

    /// The live binding site: two rooms built the way `run` builds them, with no
    /// `FIXED_SEED`, must produce different maps.
    ///
    /// Testing `mix_seed` alone does not do it — the first version of this test
    /// passed with the old hardcoded seed restored, because it never exercised
    /// the decision about whether to call `mix_seed` at all (§B11: ask what a
    /// passing assertion rules out).
    #[test]
    fn two_rooms_with_no_fixed_seed_get_different_maps() {
        let c = cfg();
        // §E1: a lobby has no map, so the maps under comparison are the ones
        // each room *would* build. The seed rule this guards (`docs/71` §B13) is
        // fixed at construction and unchanged by the move.
        let a = Room::new_in_room(c.clone(), 0).generate_world();
        let b = Room::new_in_room(c, 1).generate_world();
        assert_ne!(
            a.map.mask.hash(),
            b.map.mask.hash(),
            "every room is playing the same map"
        );
    }

    /// `FIXED_SEED` is how a bug gets reproduced (`docs/41` §5), so it has to
    /// beat the per-room mixing entirely.
    #[test]
    fn fixed_seed_pins_every_room_to_the_same_map() {
        let c = Arc::new(Config {
            bot_count: 0,
            fixed_seed: Some(4242),
            ..Config::default()
        });
        let a = Room::new_in_room(c.clone(), 0).generate_world();
        let b = Room::new_in_room(c, 7).generate_world();
        assert_eq!(a.map.mask.hash(), b.map.mask.hash());
    }

    #[test]
    fn the_room_turns_a_bot_s_fire_button_into_a_shot() {
        let cfg = Arc::new(Config {
            bot_count: 2,
            bot_skill: 1.0,
            map_scale: game_core::constants::MapScale::Small,
            ..Config::default()
        });
        let mut room = Room::new(cfg);
        // §C18: bots are seated when a round starts, not at construction, so a
        // test that wants bots has to start one.
        room.request_start();
        room.tick_inline(game_core::constants::SIM_DT);
        room.world_for_test()
            .set_phase(game_core::world::RoundPhase::Playing);

        // Arm both bots and stand them in a clear line, so the only thing under
        // test is whether the trigger reaches the world.
        let ids: Vec<PlayerId> = room.world_for_test().players.iter().map(|p| p.id).collect();
        assert_eq!(ids.len(), 2, "bots were not seated");
        for id in &ids {
            game_core::world::give(
                room.world_for_test(),
                *id,
                game_core::items::registry::SMG,
                60,
            );
        }

        // Stand them 200 px apart on a clear line. Left to wander a 2048x1024
        // map they may simply never meet inside the test's budget, and a test
        // that depends on an encounter is measuring the map, not the wiring.
        let at = {
            let w = &*room.world_for_test();
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
        if let Some(p) = room.world_for_test().player_mut(ids[0]) {
            p.body.pos = game_core::math::Vec2::new(at.0, at.1);
        }
        if let Some(p) = room.world_for_test().player_mut(ids[1]) {
            p.body.pos = game_core::math::Vec2::new(at.0 + 200.0, at.1);
        }

        let mut fired = false;
        for _ in 0..600 {
            room.tick_inline(1.0 / 60.0);
            let now = room.world_for_test().round_time;
            if room
                .world_for_test()
                .players
                .iter()
                .any(|p| p.fire_ready_at > now)
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
        room.apply(Command::Ready(200, true));
        room.apply(Command::Leave(200));
        let _ = room.tick_inline(SIM_DT);
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
        // §E1.1: the seat is the roster. In a lobby there is no world for a
        // player to be in, so this is the only place the join is recorded — and
        // it has to be, or the match would start with nobody in it.
        assert_eq!(room.player_count(), 1);
        assert!(
            room.world().is_none(),
            "a lobby built a world to hold one joining player"
        );

        // The presence control, and the §E1.1 assertion proper: the world is
        // *created from* the seats. Without it, "the seat holds the player" also
        // passes for a room that never carries them into the match.
        let w = room.generate_world();
        room.install_world(w);
        assert_eq!(
            room.world_for_test().players.len(),
            1,
            "the match started without the player who was seated in the lobby"
        );

        room.apply(Command::Leave(0));
        assert_eq!(room.player_count(), 0);
        // **Inverted at T17.06, deliberately.** This used to assert the world
        // was gone: the last human leaving called `return_to_lobby`, which
        // dropped it on the spot. §E5 makes the reaper the only answer to that
        // event, so the world now stands until `ROOM_EMPTY_TTL` takes the whole
        // room — which is what the registry's own comment always claimed and
        // could not deliver while two mechanisms raced on one condition.
        //
        // Kept rather than deleted because it now guards the ruling: re-adding
        // the `return_to_lobby` call turns this red.
        assert!(
            room.world().is_some(),
            "the world was torn down when the last human left: something is \
             answering that event besides the reaper (§E5)"
        );
    }

    /// Bots are seated **when a round starts** (§C18) and hold real seats.
    ///
    /// They used to be seated at construction, which is how a room created at
    /// server startup was already a battle before anyone connected.
    #[test]
    fn the_default_config_seats_bots_and_they_occupy_seats() {
        let mut room = Room::new(cfg_with_bots());
        assert_eq!(
            room.bot_count(),
            0,
            "bots were seated before the round started"
        );
        room.request_start();
        room.tick_inline(game_core::constants::SIM_DT);
        let bots = room.bot_count();
        assert!(bots > 0, "BOT_COUNT defaults to 0, so §A5 is not in effect");
        assert_eq!(
            room.world_for_test().players.len(),
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
        room.request_start();
        room.tick_inline(game_core::constants::SIM_DT);
        assert_eq!(room.world_for_test().players.len(), 6);
        let (reply, _rx) = oneshot::channel();
        room.apply(Command::Join {
            name: "human".into(),
            skin_id: 0,
            tombstone_skin_id: 0,
            reply,
        });
        assert_eq!(room.bot_count(), 5, "no bot was kicked");
        assert_eq!(
            room.world_for_test().players.len(),
            6,
            "capacity was exceeded rather than a bot removed"
        );
    }

    /// The case `sweep_unready` exists for, and after T20.01 the only one it
    /// still covers: a client that has been sent a map and never comes back.
    ///
    /// **The room has to be in a match.** T20.01 scoped the sweep to
    /// `world.is_some()` — a lobby has sent nothing that a client could have
    /// failed to decode, and the version of this test that ran on a bare
    /// `Room::new` was asserting the eviction `docs/74` §E3 forbids.
    #[test]
    fn a_player_who_never_readies_is_dropped() {
        let mut room = Room::new(cfg());
        // §E1 splits "ask for a world" from "build one"; `tick_inline` does both.
        room.request_start();
        room.tick_inline(SIM_DT);
        assert!(
            room.world().is_some(),
            "the match never started, so the sweep below is being asked about a lobby"
        );

        let (reply, _rx) = oneshot::channel();
        room.apply(Command::Join {
            name: "a".into(),
            skin_id: 0,
            tombstone_skin_id: 0,
            reply,
        });
        let a = room.player_count() - 1;
        // Nothing is dropped while the timeout has not elapsed. `READY_TIMEOUT`
        // rather than a literal 30 s: it is derived from `READY_TIMEOUT_SECS` in
        // this very file, and a fixture pinned to a copy of a tunable goes green
        // against a drifted one.
        assert!(room.sweep_unready(READY_TIMEOUT).is_empty());
        // A zero timeout is "everything unready is stale".
        let dropped = room.sweep_unready(Duration::from_millis(0));
        assert_eq!(dropped.len(), 1, "the unready human was not swept");
        assert_eq!(room.player_count(), a, "the seat was not freed");

        // A ready player is never swept.
        let (reply, rx) = oneshot::channel();
        room.apply(Command::Join {
            name: "b".into(),
            skin_id: 0,
            tombstone_skin_id: 0,
            reply,
        });
        let b = rx.blocking_recv().ok().flatten().expect("seated");
        room.apply(Command::Ready(b, true));
        assert!(room.sweep_unready(Duration::from_millis(0)).is_empty());
    }

    /// **The window runs from the map, not from the seat.**
    ///
    /// The bug this is written against was invisible until the lobby lasted
    /// longer than `READY_TIMEOUT`: `joined_at.elapsed()` for a player who sat in
    /// a lobby for 45 s is already 45 s on the tick the world is installed, so
    /// the sweep dropped them on that same tick — before `map_init` could reach
    /// the browser, let alone be decoded. Measured against
    /// `scripts/checks/lobby-start.mjs` (`LOBBY_BOT_TIMEOUT=45`, `BOT_COUNT=3`):
    /// the gauge went `players 1 -> 3` as the round began, three bots and no
    /// human, and the client sat in a lobby forever.
    ///
    /// Fabricating a 45-second-old seat rather than waiting for one: the seat's
    /// clock is `Instant`, so the test moves the room's stamp instead —
    /// `joined_at` is already far older than the freshly installed world, which
    /// is precisely the shape that was broken.
    #[test]
    fn the_handshake_window_starts_when_the_map_does_not_when_the_seat_did() {
        let mut room = Room::new(cfg());
        let (reply, rx) = oneshot::channel();
        room.apply(Command::Join {
            name: "waited".into(),
            skin_id: 0,
            tombstone_skin_id: 0,
            reply,
        });
        let waited = rx.blocking_recv().ok().flatten().expect("seated");
        room.request_start();
        room.tick_inline(SIM_DT);

        // A timeout of `READY_TIMEOUT` against a seat that has existed for a
        // fraction of a second and a map that is a fraction of a second old.
        assert!(
            room.sweep_unready(READY_TIMEOUT).is_empty(),
            "the player was swept on the tick their map was sent"
        );

        // Now age the *seat* past the timeout while the map stays fresh. That is
        // the long-lobby case, and nothing about it should be sweepable.
        room.age_seat_for_test(waited, READY_TIMEOUT * 2);
        assert!(
            room.sweep_unready(READY_TIMEOUT).is_empty(),
            "a seat older than READY_TIMEOUT was swept although its map is new"
        );

        // The control: age the **map** too, and the same call drops them. Without
        // it this passes for a sweep that has stopped firing.
        room.age_world_for_test(READY_TIMEOUT * 2);
        assert_eq!(
            room.sweep_unready(READY_TIMEOUT).len(),
            1,
            "the sweep no longer fires at all, so the two claims above are vacuous"
        );
    }

    /// The other half, and the reported bug: **a lobby is never swept.**
    ///
    /// `private_lobby.rs` owns the §E3 (private) case in full. This one is the
    /// **public** lobby, which the ruling left in scope on the finding that it
    /// cannot reach 30 s — true at the shipped `LOBBY_BOT_TIMEOUT` of 10 s, and
    /// false under the override `scripts/checks/lobby-start.mjs` uses (45 s),
    /// where the base commit swept the only human and then ran a round of three
    /// bots at t=42.7 s with that human still watching from outside it.
    #[test]
    fn a_lobby_is_never_swept_however_long_it_has_waited() {
        let mut room = Room::new(cfg());
        let (reply, _rx) = oneshot::channel();
        room.apply(Command::Join {
            name: "waiting".into(),
            skin_id: 0,
            tombstone_skin_id: 0,
            reply,
        });
        assert!(
            room.world().is_none(),
            "this must be a lobby to mean anything"
        );
        assert!(
            room.sweep_unready(Duration::from_millis(0)).is_empty(),
            "a player waiting in a lobby was swept out of it"
        );
        assert_eq!(room.player_count(), 1, "the lobby lost its only seat");

        // The control: the same room, the same seat, once the match has started.
        // Without it this passes for a sweep that no longer fires at all.
        room.request_start();
        room.tick_inline(SIM_DT);
        assert_eq!(
            room.sweep_unready(Duration::from_millis(0)).len(),
            1,
            "the sweep no longer fires in a match either, so the claim above is vacuous"
        );
    }
}
