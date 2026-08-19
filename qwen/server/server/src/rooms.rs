//! `rooms` — room/match lifecycle, player join/leave (docs/05 §2).
//!
//! A thin wrapper over `game_core::round::Round`: this file owns socket
//! identity and the input queue, and holds NO game logic (docs/05 §1).

use game_core::map::Scale;
use game_core::protocol::{InputFrame, LobbyPlayer, LobbyState};
use game_core::round::{Event, Round, RoundState};
use std::collections::HashMap;

pub type RoomId = u32;

/// docs/07 §4: "6 skins (player_1..6)".
pub const SKIN_COUNT: usize = 6;
/// docs/07 §4 + T5.3 step 2: "v1: 0/1".
pub const WEAPON_SKIN_COUNT: usize = 2;

/// Why a join was refused (docs/06 §2 `error.code`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum JoinError {
    RoomFull,
    BadName,
}

impl JoinError {
    pub const fn code(self) -> &'static str {
        match self {
            JoinError::RoomFull => "room_full",
            JoinError::BadName => "bad_name",
        }
    }
}

/// One match (docs/05 §2). Room-keyed so scaling later is trivial.
pub struct Room {
    pub id: RoomId,
    pub round: Round,
    /// Socket id -> player id, so a disconnect can find its player.
    sockets: HashMap<String, u8>,
    /// Latest input frame per player — "the tick loop takes the LATEST frame
    /// per player (drops older)" (docs/05 §3).
    pending: HashMap<u8, InputFrame>,
    /// Frames received for a player since the last tick, to log drops.
    received: HashMap<u8, u32>,
}

impl Room {
    pub fn new(id: RoomId, seed: u64, scale: Scale) -> Self {
        Room {
            id,
            round: Round::new(seed, scale),
            sockets: HashMap::new(),
            pending: HashMap::new(),
            received: HashMap::new(),
        }
    }

    /// docs/06 §1: "name 1–12 chars, trimmed; server sanitizes".
    pub fn sanitize_name(raw: &str) -> Result<String, JoinError> {
        let trimmed = raw.trim();
        if trimmed.is_empty() {
            return Err(JoinError::BadName);
        }
        Ok(trimmed.chars().take(12).collect())
    }

    /// Join a socket to this room (docs/05 §2).
    ///
    /// Idempotent per socket. A client that sends `join_room` twice — which
    /// the real client can do, since it joins on every `connect` — used to get
    /// a SECOND player: the first stayed in the roster with `connected = true`
    /// forever, holding one of the six seats, and no disconnect could ever
    /// free it because the socket -> player map only remembers the last one.
    /// Found by a two-client lobby check, where the same player appeared
    /// twice in the roster.
    pub fn join(&mut self, socket: &str, name: &str) -> Result<u8, JoinError> {
        let name = Room::sanitize_name(name)?;
        if let Some(&id) = self.sockets.get(socket) {
            return Ok(id);
        }
        let id = self.round.join(name).ok_or(JoinError::RoomFull)?;
        self.sockets.insert(socket.to_string(), id);
        Ok(id)
    }

    /// docs/05 §2: "player marked gone; if in round, their body is removed and
    /// they can't respawn".
    pub fn leave(&mut self, socket: &str) -> Option<u8> {
        let id = self.sockets.remove(socket)?;
        if let Some(rp) = self.round.players.iter_mut().find(|p| p.player.id == id) {
            rp.connected = false;
            rp.player.alive = false;
            rp.player.respawn_at_tick = None;
        }
        self.pending.remove(&id);
        Some(id)
    }

    pub fn player_of(&self, socket: &str) -> Option<u8> {
        self.sockets.get(socket).copied()
    }

    pub fn set_ready(&mut self, socket: &str, ready: bool) {
        if let Some(id) = self.player_of(socket) {
            self.round.set_ready(id, ready);
        }
    }

    /// Queue an input frame. Latest-wins (docs/05 §3).
    pub fn queue_input(&mut self, socket: &str, frame: InputFrame) {
        if let Some(id) = self.player_of(socket) {
            self.pending.insert(id, frame);
            *self.received.entry(id).or_insert(0) += 1;
        }
    }

    /// Players whose queue held more than one frame this tick, and how many
    /// were dropped — docs/05 §5 logs `[input] P3 dropped N frames`.
    pub fn dropped_frames(&self) -> Vec<(u8, u32)> {
        self.received
            .iter()
            .filter(|(_, &count)| count > 1)
            .map(|(&id, &count)| (id, count - 1))
            .collect()
    }

    /// The lobby roster for `joined` / `lobby_state` (docs/06 §2).
    pub fn lobby_players(&self) -> Vec<LobbyPlayer> {
        self.round
            .players
            .iter()
            .filter(|p| p.connected)
            .map(|p| LobbyPlayer {
                id: p.player.id,
                name: p.player.name.clone(),
                skin: p.player.skin,
                ready: p.ready,
                weapon_skin: p.player.weapon_skin,
            })
            .collect()
    }

    /// The `lobby_state` payload (docs/06 §2).
    ///
    /// `ready` is a fixed `[bool; 6]` indexed by player id, which duplicates
    /// `LobbyPlayer.ready` — the doc's own shape, kept as written (D3's family:
    /// a fixed-cardinality field next to the list it mirrors).
    pub fn lobby_state(&self) -> LobbyState {
        let mut ready = [false; 6];
        for player in self.round.players.iter().filter(|p| p.connected) {
            if let Some(slot) = ready.get_mut(player.player.id as usize) {
                *slot = player.ready;
            }
        }
        LobbyState {
            players: self.lobby_players(),
            ready,
            countdown_in_s: self.countdown_in_s(),
        }
    }

    /// Seconds left of the 3 s countdown, or `None` outside it (docs/05 §2).
    fn countdown_in_s(&self) -> Option<f32> {
        if self.round.state == RoundState::Countdown {
            Some((game_core::round::COUNTDOWN_S - self.round.state_time_s).max(0.0))
        } else {
            None
        }
    }

    /// Set a player's cosmetic skins (docs/07 §4). Out-of-range values are
    /// ignored rather than clamped: a client that sends skin 200 has a bug,
    /// and silently showing it skin 2 would hide that.
    pub fn set_skin(&mut self, socket: &str, skin: Option<u8>, weapon_skin: Option<u8>) {
        let Some(id) = self.player_of(socket) else { return };
        let Some(rp) = self.round.players.iter_mut().find(|p| p.player.id == id) else {
            return;
        };
        if let Some(skin) = skin.filter(|s| (*s as usize) < SKIN_COUNT) {
            rp.player.skin = skin;
        }
        if let Some(weapon_skin) = weapon_skin.filter(|s| (*s as usize) < WEAPON_SKIN_COUNT) {
            rp.player.weapon_skin = weapon_skin;
        }
    }

    /// Advance the room one tick, draining the input queue.
    pub fn step(&mut self) -> Vec<Event> {
        let inputs: Vec<(u8, InputFrame)> = self.pending.drain().collect();
        let events = self.round.step(&inputs);
        self.received.clear();
        events
    }

    pub fn player_count(&self) -> usize {
        self.round.players.iter().filter(|p| p.connected).count()
    }

    pub fn is_empty(&self) -> bool {
        self.player_count() == 0
    }

    /// Restart on a new seed (docs/05 §2), unless `WIPGAME_SEED` pins it.
    pub fn restart(&mut self, seed: u64) -> Vec<Event> {
        let scale = self.round.scale;
        self.round.start_round(seed, scale)
    }

    /// Whether this socket already has a player here (docs/05 §2).
    #[allow(dead_code)]
    pub fn has_socket(&self, socket: &str) -> bool {
        self.sockets.contains_key(socket)
    }

    /// Current round state (docs/05 §2). Used by the integration test and
    /// by lobby broadcasting.
    #[allow(dead_code)]
    pub fn state(&self) -> RoundState {
        self.round.state
    }
}

#[cfg(test)]
mod rooms_tests {

    #[test]
    fn a_socket_that_joins_twice_gets_one_player() {
        // The real client sends join_room on every `connect`. A second body
        // for the same socket is unreachable state: it stays connected
        // forever and occupies one of the six seats (docs/05 §2).
        let mut room = Room::new(1, 7, Scale::Small);
        let first = room.join("sock", "bob").unwrap();
        let second = room.join("sock", "bob").unwrap();
        assert_eq!(first, second);
        assert_eq!(room.player_count(), 1);
        assert_eq!(room.lobby_players().len(), 1);
        // And leaving still frees the seat.
        assert_eq!(room.leave("sock"), Some(first));
        assert_eq!(room.player_count(), 0);
    }

    #[test]
    fn lobby_state_carries_a_ready_flag_per_seat() {
        // docs/06 §2: `ready: [bool; 6]`, indexed by player id.
        let mut room = Room::new(1, 7, Scale::Small);
        let a = room.join("s0", "a").unwrap();
        room.join("s1", "b").unwrap();
        room.set_ready("s0", true);
        let state = room.lobby_state();
        assert_eq!(state.players.len(), 2);
        assert_eq!(state.ready.len(), 6);
        assert!(state.ready[a as usize]);
        assert!(!state.ready[1]);
        // No countdown outside RoundState::Countdown.
        assert_eq!(state.countdown_in_s, None);
    }

    #[test]
    fn out_of_range_skins_are_ignored_not_clamped() {
        // docs/07 §4: 6 player skins, 2 weapon skins. Showing skin 2 for a
        // requested skin 200 would hide the caller's bug.
        let mut room = Room::new(1, 7, Scale::Small);
        room.join("s0", "a").unwrap();
        room.set_skin("s0", Some(3), Some(1));
        assert_eq!(room.lobby_players()[0].skin, 3);
        assert_eq!(room.lobby_players()[0].weapon_skin, 1);
        room.set_skin("s0", Some(200), Some(9));
        assert_eq!(room.lobby_players()[0].skin, 3, "skin 200 must not be applied");
        assert_eq!(room.lobby_players()[0].weapon_skin, 1, "weapon skin 9 must not be applied");
    }
    use super::*;
    use game_core::round::MAX_PLAYERS;

    fn room() -> Room {
        Room::new(1, 42, Scale::Small)
    }

    #[test]
    fn join_assigns_ids_0_to_5() {
        // docs/08 §2: "join assigns ids 0..5".
        let mut r = room();
        for expected in 0..MAX_PLAYERS as u8 {
            let id = r.join(&format!("sock{expected}"), &format!("p{expected}")).unwrap();
            assert_eq!(id, expected);
        }
        assert_eq!(r.player_count(), 6);
    }

    #[test]
    fn the_seventh_joiner_is_rejected_as_room_full() {
        // docs/08 §2 + docs/05 §2.
        let mut r = room();
        for i in 0..6 {
            r.join(&format!("s{i}"), "p").unwrap();
        }
        assert_eq!(r.join("s6", "seventh"), Err(JoinError::RoomFull));
        assert_eq!(JoinError::RoomFull.code(), "room_full");
        assert_eq!(r.player_count(), 6, "the refused joiner was still added");
    }

    #[test]
    fn disconnect_removes_the_player() {
        // docs/08 §2: "disconnect removes player".
        let mut r = room();
        r.join("a", "alice").unwrap();
        r.join("b", "bob").unwrap();
        assert_eq!(r.player_count(), 2);

        assert_eq!(r.leave("a"), Some(0));
        assert_eq!(r.player_count(), 1);
        assert!(!r.round.players[0].connected);
        assert!(!r.round.players[0].player.alive, "a gone player must not stay alive");
        assert_eq!(r.leave("a"), None, "leaving twice");
        assert_eq!(r.leave("unknown"), None);
    }

    #[test]
    fn ready_logic_starts_the_countdown() {
        // docs/08 §2: "ready logic starts countdown".
        let mut r = room();
        r.join("a", "alice").unwrap();
        r.join("b", "bob").unwrap();
        r.step();
        assert_eq!(r.state(), RoundState::Lobby, "started with nobody ready");

        r.set_ready("a", true);
        r.step();
        assert_eq!(r.state(), RoundState::Lobby, "started with one player unready");

        r.set_ready("b", true);
        r.step();
        assert_eq!(r.state(), RoundState::Countdown);
    }

    #[test]
    fn restart_generates_a_new_seed() {
        // docs/08 §2: "restart generates a NEW seed (!= old) unless
        // WIPGAME_SEED set". The room takes the seed from its caller, which is
        // where the env override is applied (main.rs), so this asserts the
        // room honours whatever it is given.
        let mut r = room();
        r.join("a", "alice").unwrap();
        r.round.start_round(1, Scale::Small);
        let first = r.round.map.tiles.clone();
        r.restart(2);
        assert_eq!(r.round.seed, 2);
        assert_ne!(first, r.round.map.tiles, "a new seed reused the old map");
        // Pinning the seed reproduces the map exactly.
        r.restart(1);
        assert_eq!(first, r.round.map.tiles, "the same seed gave a different map");
    }

    #[test]
    fn names_are_trimmed_and_capped_at_12_chars() {
        // docs/06 §1: "name 1-12 chars, trimmed; server sanitizes".
        assert_eq!(Room::sanitize_name("  bob  ").unwrap(), "bob");
        assert_eq!(Room::sanitize_name("averyverylongname").unwrap().chars().count(), 12);
        assert_eq!(Room::sanitize_name("   "), Err(JoinError::BadName));
        assert_eq!(Room::sanitize_name(""), Err(JoinError::BadName));
        assert_eq!(JoinError::BadName.code(), "bad_name");
    }

    #[test]
    fn the_input_queue_is_latest_wins() {
        // docs/05 §3: "the tick loop takes the LATEST frame per player (drops
        // older)".
        let mut r = room();
        r.join("a", "alice").unwrap();
        r.queue_input("a", InputFrame { tick: 1, left: true, ..InputFrame::default() });
        r.queue_input("a", InputFrame { tick: 2, right: true, ..InputFrame::default() });
        r.queue_input("a", InputFrame { tick: 3, jump: true, ..InputFrame::default() });

        assert_eq!(r.dropped_frames(), vec![(0, 2)], "2 of 3 frames were superseded");
        r.step();
        // After a tick the queue is empty, so nothing is reported as dropped.
        assert!(r.dropped_frames().is_empty());
    }

    #[test]
    fn input_from_an_unknown_socket_is_ignored() {
        let mut r = room();
        r.queue_input("ghost", InputFrame::default());
        assert!(r.dropped_frames().is_empty());
        r.step();
    }

    #[test]
    fn an_emptied_room_reports_itself_empty() {
        // docs/05 §2: "if room empty -> room closed".
        let mut r = room();
        r.join("a", "alice").unwrap();
        assert!(!r.is_empty());
        r.leave("a");
        assert!(r.is_empty());
    }

    #[test]
    fn snapshots_broadcast_every_second_tick() {
        // DEVIATIONS.md D12: the deterministic form of T4.9's "10 Hz" — a
        // wall-clock rate assertion would be flaky under load.
        let mut r = room();
        r.join("a", "alice").unwrap();
        r.round.start_round(1, Scale::Small);

        let mut broadcasts = 0;
        for _ in 0..100 {
            if r.round.should_broadcast_snapshot() {
                broadcasts += 1;
            }
            r.step();
        }
        assert_eq!(broadcasts, 50, "100 ticks at 20 Hz should give 50 snapshots (10 Hz)");
    }

    #[test]
    fn a_snapshot_always_carries_six_players() {
        // docs/06 §4: "players: [PlayerSnap; 6] — missing players: alive=false,
        // x=y=0".
        let mut r = room();
        r.join("a", "alice").unwrap();
        r.round.start_round(1, Scale::Small);
        let snap = r.round.snapshot();
        assert_eq!(snap.players.len(), 6);
        assert!(snap.players[0].alive, "the joined player should be alive");
        for absent in &snap.players[1..] {
            assert!(!absent.alive, "an absent player is not marked dead");
            assert_eq!((absent.x, absent.y), (0.0, 0.0));
        }
        assert_eq!(snap.map_version, r.round.map.version);
    }
}
