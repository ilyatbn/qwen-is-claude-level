//! Many rooms in one process (`docs/71-amendments-v3.md` §B1).
//!
//! `docs/41-server-loop-rooms.md` §9 wrote the path down before any of it was
//! built: *"a `RoomRegistry` of `room_id → mpsc::Sender<Command>`, and socket.io
//! rooms for scoping broadcasts. The room task is already isolated, so this is
//! additive."* This is that.
//!
//! ## Scoping is done with the room's own `SessionMap`, not socket.io rooms
//!
//! Each room already owns a [`SessionMap`] listing the sockets seated in it,
//! because per-owner events (`inventory`, `damage`) need it. Broadcasts iterate
//! **that same list**, so there is exactly one answer to "who is in this room"
//! rather than two that can disagree. A socket.io room would be a second source
//! of truth for the same fact, and this project has already paid for that twice
//! (`docs/70-amendments-v2.md` §A24).
//!
//! ## The registry is never iterated to produce game output
//!
//! `HashMap` iteration order is randomly seeded per process (§A11), and this is
//! the largest new surface for that class of bug in the codebase. Every map here
//! is lookup-only; anything that needs an order keeps an explicit `Vec`.

use std::collections::HashMap;
use std::sync::Arc;
use std::time::{Duration, Instant};

use socketioxide::socket::Sid;
use socketioxide::SocketIo;
use tokio::sync::oneshot;

use game_core::constants::{
    MapScale, JOIN_CODE_ALPHABET, JOIN_CODE_LEN, MAX_ROOMS, ROOM_EMPTY_TTL,
};

use crate::config::Config;
use crate::room::RoomHandle;
use crate::session::SessionMap;

pub type RoomId = u32;

/// Six characters from an alphabet with no `I`/`1`/`O`/`0`.
pub type JoinCode = String;

/// Why a room could not be entered. Carried straight into `join_error.reason`,
/// so the client can say something specific rather than "failed".
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum JoinRejection {
    /// No room has that code — mistyped, or the room is gone.
    UnknownCode,
    /// The process is at `MAX_ROOMS` and cannot start another.
    ServerFull,
}

impl JoinRejection {
    pub fn as_str(self) -> &'static str {
        match self {
            JoinRejection::UnknownCode => "unknown_code",
            JoinRejection::ServerFull => "server_full",
        }
    }
}

/// One live room: its task handle, its sockets, and how to stop it.
pub struct RoomEntry {
    pub id: RoomId,
    pub handle: RoomHandle,
    pub sessions: Arc<SessionMap>,
    pub scale: MapScale,
    pub private: bool,
    pub code: Option<JoinCode>,
    /// Sending on this stops the room task. Taken on reap.
    shutdown: Option<oneshot::Sender<()>>,
    /// Humans only. Bots do not keep a room alive (§B1).
    humans: usize,
    /// When the last human left, or `None` while somebody is in it.
    empty_since: Option<Instant>,
}

impl RoomEntry {
    pub fn humans(&self) -> usize {
        self.humans
    }
}

impl std::fmt::Debug for RoomEntry {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("RoomEntry")
            .field("id", &self.id)
            .field("scale", &self.scale)
            .field("private", &self.private)
            .field("code", &self.code)
            .field("humans", &self.humans)
            .finish()
    }
}

/// What quick match decided to do with a waiting player.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum QuickMatch {
    /// Seat them in this existing room.
    Existing(RoomId),
    /// A fresh room was created for them.
    Created(RoomId),
    /// At `MAX_ROOMS` with nothing joinable.
    Full,
}

/// How a room task is created. Injected so tests can drive the registry's
/// lifecycle logic without spawning real 60 Hz tasks — the alternative is a test
/// suite that takes minutes and can only assert on timing.
pub trait RoomSpawner: Send + Sync + 'static {
    fn spawn(
        &self,
        io: &SocketIo,
        config: Arc<Config>,
        sessions: Arc<SessionMap>,
        shutdown: oneshot::Receiver<()>,
        room_id: RoomId,
    ) -> RoomHandle;

    /// A dropped room must stop being counted, or `rooms_over_budget` reports a
    /// room that no longer exists forever.
    fn on_dropped(&self, _room: RoomId) {}
}

/// The real one: a room task per room, ticking at `SIM_HZ`.
pub struct RealSpawner {
    pub metrics: Option<Arc<crate::metrics::Metrics>>,
}

impl RealSpawner {
    fn forget(&self, room: RoomId) {
        if let Some(m) = &self.metrics {
            m.forget_room(room);
        }
    }
}

impl RoomSpawner for RealSpawner {
    fn spawn(
        &self,
        io: &SocketIo,
        config: Arc<Config>,
        sessions: Arc<SessionMap>,
        shutdown: oneshot::Receiver<()>,
        room_id: RoomId,
    ) -> RoomHandle {
        crate::room::spawn_room_with(
            io.clone(),
            config,
            sessions,
            shutdown,
            self.metrics.clone(),
            room_id,
        )
    }

    fn on_dropped(&self, room: RoomId) {
        self.forget(room);
    }
}

pub struct RoomRegistry {
    /// Lookup only — never iterated for output (§A11).
    rooms: HashMap<RoomId, RoomEntry>,
    codes: HashMap<JoinCode, RoomId>,
    /// Which room a socket is seated in. Lookup only.
    sid_room: HashMap<Sid, RoomId>,
    /// Insertion-ordered, because quick match's tie-break must be stable.
    order: Vec<RoomId>,
    next_id: RoomId,
    /// Join codes are cosmetic identifiers, not secrets: they gate nothing a
    /// room's own capacity check does not, and a guessed code lets someone into
    /// a public deathmatch. So this is a splitmix64 counter rather than a CSPRNG
    /// — and deliberately **not** `ChaCha8Rng`, which in this codebase means
    /// "part of the deterministic simulation" (`docs/10` §2). A room code is not.
    rng: u64,
    io: SocketIo,
    base_config: Arc<Config>,
    spawner: Arc<dyn RoomSpawner>,
    /// Kept current so `/healthz` and `/metrics` report what is really running.
    gauge: Option<Arc<std::sync::atomic::AtomicUsize>>,
}

impl RoomRegistry {
    pub fn new(io: SocketIo, base_config: Arc<Config>, spawner: Arc<dyn RoomSpawner>) -> Self {
        // Join codes are cosmetic identifiers, not secrets — they gate nothing a
        // room's own capacity check does not. Seeded from the process start so
        // two servers do not hand out the same first code.
        let seed = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_nanos() as u64)
            .unwrap_or(0x5eed);
        RoomRegistry {
            rooms: HashMap::new(),
            codes: HashMap::new(),
            sid_room: HashMap::new(),
            order: Vec::new(),
            next_id: 1,
            rng: seed | 1,
            io,
            base_config,
            spawner,
            gauge: None,
        }
    }

    /// Report the live room count into this gauge.
    pub fn with_gauge(mut self, gauge: Arc<std::sync::atomic::AtomicUsize>) -> Self {
        gauge.store(0, std::sync::atomic::Ordering::Relaxed);
        self.gauge = Some(gauge);
        self
    }

    fn publish_count(&self) {
        if let Some(g) = &self.gauge {
            g.store(self.rooms.len(), std::sync::atomic::Ordering::Relaxed);
        }
    }

    pub fn len(&self) -> usize {
        self.rooms.len()
    }

    pub fn is_empty(&self) -> bool {
        self.rooms.is_empty()
    }

    /// Room ids in creation order. The explicit `Vec` exists so nothing has to
    /// iterate the `HashMap` (§A11).
    pub fn ids(&self) -> &[RoomId] {
        &self.order
    }

    pub fn get(&self, id: RoomId) -> Option<&RoomEntry> {
        self.rooms.get(&id)
    }

    pub fn by_code(&self, code: &str) -> Option<RoomId> {
        self.codes.get(&normalise_code(code)).copied()
    }

    pub fn room_of(&self, sid: Sid) -> Option<RoomId> {
        self.sid_room.get(&sid).copied()
    }

    /// Create a room. `private` gives it a join code.
    pub fn create(
        &mut self,
        scale: MapScale,
        private: bool,
    ) -> Result<(RoomId, Option<JoinCode>), JoinRejection> {
        if self.rooms.len() >= MAX_ROOMS {
            return Err(JoinRejection::ServerFull);
        }
        let id = self.next_id;
        self.next_id += 1;

        let mut config = (*self.base_config).clone();
        config.map_scale = scale;
        let config = Arc::new(config);

        let sessions = Arc::new(SessionMap::default());
        let (shutdown, rx) = oneshot::channel();
        let handle = self
            .spawner
            .spawn(&self.io, config, sessions.clone(), rx, id);

        let code = if private {
            Some(self.fresh_code())
        } else {
            None
        };
        if let Some(c) = &code {
            self.codes.insert(c.clone(), id);
        }

        self.rooms.insert(
            id,
            RoomEntry {
                id,
                handle,
                sessions,
                scale,
                private,
                code: code.clone(),
                shutdown: Some(shutdown),
                humans: 0,
                // A room with nobody in it yet is already on the clock: a client
                // that asks for a room and then vanishes must not leave one
                // ticking forever.
                empty_since: Some(Instant::now()),
            },
        );
        self.order.push(id);
        self.publish_count();
        tracing::info!(target: "game::round", room = id, ?scale, private, "room created");
        Ok((id, code))
    }

    /// Seat a socket in a room. **Idempotent for the same pair.**
    ///
    /// Genuinely idempotent, not just documented as such: the lobby entry points
    /// attach and then call `seat`, which attaches again, so a naive `humans +=
    /// 1` counted every quick-matched player twice and left the room permanently
    /// non-empty — it could never be reaped.
    pub fn attach(&mut self, sid: Sid, room: RoomId) {
        match self.sid_room.insert(sid, room) {
            // Already here: nothing to count.
            Some(prev) if prev == room => return,
            Some(prev) => self.detach_from(sid, prev),
            None => {}
        }
        if let Some(e) = self.rooms.get_mut(&room) {
            e.humans += 1;
            e.empty_since = None;
        }
    }

    /// Remove a socket from whichever room it was in. Returns that room.
    pub fn detach(&mut self, sid: Sid) -> Option<RoomId> {
        let room = self.sid_room.remove(&sid)?;
        self.detach_from(sid, room);
        Some(room)
    }

    fn detach_from(&mut self, sid: Sid, room: RoomId) {
        if let Some(e) = self.rooms.get_mut(&room) {
            e.sessions.remove_sid(sid);
            e.humans = e.humans.saturating_sub(1);
            if e.humans == 0 {
                // The tick keeps running until reap; what stops immediately is
                // the clock on the room's life. Stopping the world mid-round
                // would break a player reconnecting inside the TTL.
                e.empty_since = Some(Instant::now());
                tracing::info!(
                    target: "game::round", room,
                    ttl_s = ROOM_EMPTY_TTL, "last human left; room is on the clock"
                );
            }
        }
    }

    /// Fill the fullest room that still has space, else create one (§B1).
    ///
    /// Fullest-first so games start sooner and half-empty rooms drain rather
    /// than multiply. Ties break on the lower id, which is why `order` exists.
    pub fn quick_match(&mut self, scale: MapScale, max_players: usize) -> QuickMatch {
        let mut best: Option<(usize, RoomId)> = None;
        for id in &self.order {
            let Some(e) = self.rooms.get(id) else {
                continue;
            };
            if e.private || e.scale != scale || e.humans >= max_players {
                continue;
            }
            let seats = e.humans;
            match best {
                Some((n, _)) if n >= seats => {}
                _ => best = Some((seats, *id)),
            }
        }
        if let Some((_, id)) = best {
            return QuickMatch::Existing(id);
        }
        match self.create(scale, false) {
            Ok((id, _)) => QuickMatch::Created(id),
            Err(_) => QuickMatch::Full,
        }
    }

    /// Drop rooms whose TTL has expired. Returns what was reaped.
    pub fn reap(&mut self, now: Instant) -> Vec<RoomId> {
        let ttl = Duration::from_secs_f32(ROOM_EMPTY_TTL);
        // Collected from `order`, not from the map, so the reap sequence is
        // deterministic (§A11).
        let due: Vec<RoomId> = self
            .order
            .iter()
            .copied()
            .filter(|id| {
                self.rooms
                    .get(id)
                    .and_then(|e| e.empty_since)
                    .is_some_and(|t| now.duration_since(t) >= ttl)
            })
            .collect();
        for id in &due {
            self.drop_room(*id);
        }
        due
    }

    /// Stop and forget a room now, regardless of its TTL.
    pub fn drop_room(&mut self, id: RoomId) -> bool {
        let Some(mut e) = self.rooms.remove(&id) else {
            return false;
        };
        self.order.retain(|r| *r != id);
        if let Some(c) = &e.code {
            self.codes.remove(c);
        }
        self.sid_room.retain(|_, r| *r != id);
        if let Some(tx) = e.shutdown.take() {
            let _ = tx.send(());
        }
        self.spawner.on_dropped(id);
        self.publish_count();
        tracing::info!(target: "game::round", room = id, "room dropped");
        true
    }

    /// Every room handle, for shutdown. Ordered, so a log reads sensibly.
    pub fn handles(&self) -> Vec<(RoomId, RoomHandle)> {
        self.order
            .iter()
            .filter_map(|id| self.rooms.get(id).map(|e| (*id, e.handle.clone())))
            .collect()
    }

    fn fresh_code(&mut self) -> JoinCode {
        // Bounded: 32^6 is 1.07e9 and MAX_ROOMS is single digits, so a collision
        // is vanishingly unlikely — but "unlikely" is not "impossible", and a
        // duplicate code would silently send a player into a stranger's game.
        for _ in 0..64 {
            let c = self.random_code();
            if !self.codes.contains_key(&c) {
                return c;
            }
        }
        // Exhausted: fall back to something that cannot collide.
        format!("R{:05}", self.next_id)
    }

    fn random_code(&mut self) -> JoinCode {
        (0..JOIN_CODE_LEN)
            .map(|_| {
                let i = (self.next_rand() as usize) % JOIN_CODE_ALPHABET.len();
                JOIN_CODE_ALPHABET[i] as char
            })
            .collect()
    }

    /// splitmix64.
    fn next_rand(&mut self) -> u64 {
        self.rng = self.rng.wrapping_add(0x9E37_79B9_7F4A_7C15);
        let mut z = self.rng;
        z = (z ^ (z >> 30)).wrapping_mul(0xBF58_476D_1CE4_E5B9);
        z = (z ^ (z >> 27)).wrapping_mul(0x94D0_49BB_1331_11EB);
        z ^ (z >> 31)
    }
}

/// Upper-case and strip spacing. **No character folding.**
///
/// The obvious thing here is Crockford's fold — `O`→`0`, `I`/`L`→`1` — and it is
/// wrong for this alphabet, which excludes `0`, `1`, `I` and `O` but **includes
/// `L`**. Folding `L` mapped it to a character the alphabet does not contain, so
/// roughly one code in six (`1 - (31/32)^6` ≈ 17 %) could never be looked up at
/// all. It failed intermittently, because it depended on whether the randomly
/// generated code happened to contain an `L` — which is exactly why
/// `every_generated_code_round_trips` generates hundreds rather than one.
///
/// There is nothing left to fold: every character people confuse is already
/// absent from the alphabet, so a code containing one was misread and no
/// substitution can recover it deterministically. Let the lookup miss and tell
/// the player, rather than guessing them into a stranger's game.
pub fn normalise_code(raw: &str) -> String {
    raw.trim()
        .chars()
        .filter(|c| !c.is_whitespace() && !c.is_control())
        .map(|c| c.to_ascii_uppercase())
        .take(JOIN_CODE_LEN * 2)
        .collect()
}

/// Is this a plausible code at all? Cheap rejection before a map lookup, and the
/// thing that keeps a 200-character "code" out of the log.
pub fn code_looks_valid(code: &str) -> bool {
    code.len() == JOIN_CODE_LEN
        && code
            .bytes()
            .all(|b| JOIN_CODE_ALPHABET.contains(&b.to_ascii_uppercase()))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Spawns nothing. The registry's lifecycle logic is what is under test, and
    /// a real room task ticks at 60 Hz and generates a map — minutes of test time
    /// to assert on bookkeeping that does not involve either.
    struct NullSpawner;

    impl RoomSpawner for NullSpawner {
        fn spawn(
            &self,
            _io: &SocketIo,
            _config: Arc<Config>,
            _sessions: Arc<SessionMap>,
            shutdown: oneshot::Receiver<()>,
            _room_id: RoomId,
        ) -> RoomHandle {
            crate::room::RoomHandle::inert(shutdown)
        }
    }

    fn reg() -> RoomRegistry {
        let (_layer, io) = SocketIo::new_layer();
        RoomRegistry::new(io, Arc::new(Config::default()), Arc::new(NullSpawner))
    }

    #[test]
    fn a_code_round_trips_and_an_unknown_one_misses() {
        let mut r = reg();
        let (id, code) = r.create(MapScale::Small, true).expect("created");
        let code = code.expect("private rooms get a code");
        assert_eq!(r.by_code(&code), Some(id));
        assert_eq!(r.by_code(&code.to_lowercase()), Some(id), "case folded");
        assert_eq!(r.by_code("ZZZZZZ"), None);
    }

    #[test]
    fn a_public_room_has_no_code() {
        let mut r = reg();
        let (_, code) = r.create(MapScale::Small, false).expect("created");
        assert!(code.is_none());
    }

    /// The alphabet exists because these are read aloud. A code containing a
    /// character that cannot be distinguished by ear is a support ticket.
    #[test]
    fn codes_are_unique_and_contain_no_ambiguous_characters() {
        let mut r = reg();
        let mut seen = std::collections::HashSet::new();
        for _ in 0..200 {
            let c = r.random_code();
            assert_eq!(c.len(), JOIN_CODE_LEN);
            for ch in c.chars() {
                assert!(
                    !matches!(ch, 'I' | '1' | 'O' | '0'),
                    "ambiguous character {ch} in {c}"
                );
                assert!(
                    JOIN_CODE_ALPHABET.contains(&(ch as u8)),
                    "{ch} not in the alphabet"
                );
            }
            seen.insert(c);
        }
        // 32^6 possibilities: 200 draws colliding at all would mean the RNG is
        // not doing its job.
        assert!(
            seen.len() >= 199,
            "only {} distinct codes in 200",
            seen.len()
        );
    }

    #[test]
    fn max_rooms_refuses_cleanly_rather_than_panicking() {
        let mut r = reg();
        for _ in 0..MAX_ROOMS {
            r.create(MapScale::Small, false).expect("under the cap");
        }
        assert_eq!(r.len(), MAX_ROOMS);
        assert_eq!(
            r.create(MapScale::Small, false),
            Err(JoinRejection::ServerFull)
        );
        assert_eq!(r.len(), MAX_ROOMS, "a refused create must not leak a room");
    }

    #[test]
    fn the_last_human_leaving_starts_the_clock_and_the_room_is_reaped() {
        let mut r = reg();
        let (id, _) = r.create(MapScale::Small, false).expect("created");
        let sid = Sid::new();
        r.attach(sid, id);
        assert_eq!(r.get(id).map(|e| e.humans()), Some(1));

        // Occupied: never reaped, however long.
        let far_future = Instant::now() + Duration::from_secs(3600);
        assert!(r.reap(far_future).is_empty(), "an occupied room was reaped");

        r.detach(sid);
        assert_eq!(r.get(id).map(|e| e.humans()), Some(0));
        // Still inside the TTL.
        assert!(r.reap(Instant::now()).is_empty());
        // Past it.
        assert_eq!(r.reap(far_future), vec![id]);
        assert_eq!(r.len(), 0);
        assert_eq!(r.by_code("whatever"), None);
    }

    /// The control for the test above: without it, "an occupied room is not
    /// reaped" also passes for a registry whose reap never fires at all.
    #[test]
    fn reap_actually_fires_when_it_should() {
        let mut r = reg();
        let (id, _) = r.create(MapScale::Small, false).expect("created");
        // Never attached: a room nobody entered is already on the clock.
        assert_eq!(
            r.reap(Instant::now() + Duration::from_secs(3600)),
            vec![id],
            "an abandoned room must not tick forever"
        );
    }

    #[test]
    fn dropping_a_room_forgets_its_code_and_its_sockets() {
        let mut r = reg();
        let (id, code) = r.create(MapScale::Small, true).expect("created");
        let code = code.expect("private");
        let sid = Sid::new();
        r.attach(sid, id);
        assert_eq!(r.room_of(sid), Some(id));

        assert!(r.drop_room(id));
        assert_eq!(r.by_code(&code), None);
        assert_eq!(r.room_of(sid), None);
        assert!(!r.drop_room(id), "dropping twice must be a no-op");
    }

    #[test]
    fn quick_match_fills_the_fullest_room_with_space() {
        let mut r = reg();
        let (a, _) = r.create(MapScale::Medium, false).expect("a");
        let (b, _) = r.create(MapScale::Medium, false).expect("b");
        // b has two, a has one: b is fuller, so b wins.
        r.attach(Sid::new(), a);
        r.attach(Sid::new(), b);
        r.attach(Sid::new(), b);
        assert_eq!(r.quick_match(MapScale::Medium, 6), QuickMatch::Existing(b));
    }

    #[test]
    fn quick_match_skips_private_rooms_and_the_wrong_scale() {
        let mut r = reg();
        let (p, _) = r.create(MapScale::Medium, true).expect("private");
        r.attach(Sid::new(), p);
        let (s, _) = r.create(MapScale::Small, false).expect("small");
        r.attach(Sid::new(), s);

        // Neither is eligible for a medium public match, so it makes a new one.
        match r.quick_match(MapScale::Medium, 6) {
            QuickMatch::Created(id) => assert!(id != p && id != s),
            other => panic!("expected a fresh room, got {other:?}"),
        }
    }

    #[test]
    fn quick_match_skips_a_full_room() {
        let mut r = reg();
        let (a, _) = r.create(MapScale::Medium, false).expect("a");
        for _ in 0..6 {
            r.attach(Sid::new(), a);
        }
        match r.quick_match(MapScale::Medium, 6) {
            QuickMatch::Created(id) => assert_ne!(id, a),
            other => panic!("expected a fresh room, got {other:?}"),
        }
    }

    #[test]
    fn quick_match_reports_full_rather_than_creating_past_the_cap() {
        let mut r = reg();
        for _ in 0..MAX_ROOMS {
            let (id, _) = r
                .create(MapScale::Small, true)
                .expect("private fills the cap");
            r.attach(Sid::new(), id);
        }
        // Private rooms are never quick-matched into, and the cap blocks a new one.
        assert_eq!(r.quick_match(MapScale::Small, 6), QuickMatch::Full);
    }

    /// Ties must not depend on `HashMap` order (§A11): the same sequence of
    /// operations has to pick the same room every time, in every process.
    #[test]
    fn quick_match_ties_break_on_the_lower_id_deterministically() {
        for _ in 0..20 {
            let mut r = reg();
            let (a, _) = r.create(MapScale::Medium, false).expect("a");
            let (b, _) = r.create(MapScale::Medium, false).expect("b");
            r.attach(Sid::new(), a);
            r.attach(Sid::new(), b);
            assert_eq!(
                r.quick_match(MapScale::Medium, 6),
                QuickMatch::Existing(a),
                "tie must go to the lower id"
            );
        }
    }

    /// The lobby attaches, then `seat` attaches again. If that counts twice the
    /// room never empties and is never reaped — a leak that only shows up on a
    /// server that has been up a while.
    #[test]
    fn attaching_the_same_socket_to_the_same_room_counts_once() {
        let mut r = reg();
        let (id, _) = r.create(MapScale::Small, false).expect("created");
        let sid = Sid::new();
        r.attach(sid, id);
        r.attach(sid, id);
        r.attach(sid, id);
        assert_eq!(r.get(id).map(|e| e.humans()), Some(1));
        r.detach(sid);
        assert_eq!(
            r.get(id).map(|e| e.humans()),
            Some(0),
            "one detach must undo one attach"
        );
    }

    #[test]
    fn attaching_a_socket_twice_moves_it_rather_than_double_counting() {
        let mut r = reg();
        let (a, _) = r.create(MapScale::Small, false).expect("a");
        let (b, _) = r.create(MapScale::Small, false).expect("b");
        let sid = Sid::new();
        r.attach(sid, a);
        r.attach(sid, b);
        assert_eq!(r.room_of(sid), Some(b));
        assert_eq!(r.get(a).map(|e| e.humans()), Some(0));
        assert_eq!(r.get(b).map(|e| e.humans()), Some(1));
    }

    #[test]
    fn a_hundred_create_join_leave_cycles_leak_nothing() {
        let mut r = reg();
        for _ in 0..100 {
            let (id, _) = r.create(MapScale::Small, true).expect("created");
            let sid = Sid::new();
            r.attach(sid, id);
            r.detach(sid);
            r.drop_room(id);
        }
        assert_eq!(r.len(), 0, "rooms leaked");
        assert!(r.ids().is_empty(), "the order vec leaked");
        assert_eq!(r.by_code("ANYTHI"), None);
    }

    #[test]
    fn code_normalisation_upper_cases_and_strips_but_never_folds() {
        assert_eq!(normalise_code(" abc23z "), "ABC23Z");
        assert_eq!(normalise_code("AB C\t23"), "ABC23");
        // `L` is IN the alphabet. Folding it to `1` — the obvious Crockford
        // rule — made one code in six unreachable.
        assert_eq!(normalise_code("abcdlz"), "ABCDLZ");
        assert!(code_looks_valid("ABCDLZ"));
        // The genuinely ambiguous characters are simply absent, so a code
        // containing one was misread and must miss rather than be guessed.
        assert!(!code_looks_valid("ABC0IL"));
        assert!(code_looks_valid("ABC234"));
        assert!(!code_looks_valid(""));
        assert!(!code_looks_valid("ABC2345"));
    }

    /// The regression test for the fold bug, and the reason it is a sweep: the
    /// defect appeared only when a generated code happened to contain an `L`, so
    /// a single sample passed about five times in six.
    #[test]
    fn every_generated_code_round_trips_through_normalisation() {
        let mut r = reg();
        let mut saw_l = false;
        for _ in 0..500 {
            let c = r.random_code();
            saw_l |= c.contains('L');
            assert!(code_looks_valid(&c), "{c} is not a valid code");
            assert_eq!(normalise_code(&c), c, "{c} does not survive normalisation");
            assert_eq!(
                normalise_code(&c.to_lowercase()),
                c,
                "{c} does not survive a lower-case round trip"
            );
        }
        // The control: without an `L` anywhere in the sample, this test would
        // have passed against the bug it exists to catch.
        assert!(
            saw_l,
            "no generated code contained an L, so nothing was proven"
        );
    }

    /// End to end through the registry, which is where the bug actually bit.
    #[test]
    fn a_created_room_is_findable_by_its_own_code_every_time() {
        for _ in 0..100 {
            let mut r = reg();
            let (id, code) = r.create(MapScale::Small, true).expect("created");
            let code = code.expect("private");
            assert_eq!(r.by_code(&code), Some(id), "code {code} did not resolve");
        }
    }

    #[test]
    fn hostile_codes_are_rejected_without_panicking() {
        let cases = [
            "",
            " ",
            "\0\0\0\0\0\0",
            &"A".repeat(10_000),
            "ABC\u{7}23",
            "𝕬𝕭𝕮",
            "../../etc/passwd",
            "%00%00",
        ];
        for c in cases {
            let n = normalise_code(c);
            // The only contract is: it returns, and an invalid code misses.
            if !code_looks_valid(&n) {
                continue;
            }
            let r = reg();
            assert_eq!(r.by_code(&n), None);
        }
    }
}
