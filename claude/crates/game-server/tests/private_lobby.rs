//! Private lobbies: a code, settings and ready (`docs/74-amendments-v6.md` §E3).
//!
//! The public rules do not apply here. There is no timeout and no fill-start:
//! a private lobby waits as long as its players do, and starts when every
//! seated human has said yes to the game they are being shown.
//!
//! These drive a `Room` directly rather than a socket, because every rule under
//! test is a room decision — the wire half is `lobby_state.rs`.

use std::sync::Arc;

use game_core::constants::{MapScale, LOBBY_BOT_TIMEOUT, LOBBY_CAPACITY, SIM_DT};
use game_server::config::Config;
use game_server::room::{Command, Room};

fn cfg() -> Arc<Config> {
    Arc::new(Config {
        map_scale: MapScale::Small,
        bot_count: 0,
        ..Config::default()
    })
}

/// A private room, as `create_room` makes one.
fn private_room() -> Room {
    let mut room = Room::new(cfg());
    room.apply_for_test(Command::SetIdentity {
        code: Some("ABC123".into()),
        private: true,
    });
    room
}

fn seat(room: &mut Room, name: &str) -> u8 {
    let (reply, rx) = tokio::sync::oneshot::channel();
    room.apply_for_test(Command::Join {
        name: name.into(),
        skin_id: 0,
        tombstone_skin_id: 0,
        reply,
    });
    rx.blocking_recv().ok().flatten().expect("seated")
}

fn ready(room: &mut Room, id: u8, on: bool) {
    room.apply_for_test(Command::Ready(id, on));
}

fn set_scale(room: &mut Room, by: u8, scale: MapScale) -> Result<(), &'static str> {
    let (reply, rx) = tokio::sync::oneshot::channel();
    room.apply_for_test(Command::SetScale { by, scale, reply });
    rx.blocking_recv().expect("the room answered")
}

/// Tick for `secs`, returning the elapsed seconds when the room asked to start.
///
/// `tick_once`, not `tick_inline`: what is under test is *when the room asks*,
/// and building a world would add the generator's time to every measurement.
fn run(room: &mut Room, secs: f32) -> Option<f32> {
    let ticks = (secs / SIM_DT) as usize;
    for i in 0..ticks {
        room.tick_once(SIM_DT);
        if room.wants_world() {
            return Some(i as f32 * SIM_DT);
        }
    }
    None
}

/// The pair. Neither half means anything alone.
///
/// "One ready does not start" is satisfied by a lobby that never starts at all,
/// which is why the second half runs against the same room: the only thing that
/// changed between the two assertions is the second player's answer.
#[test]
fn a_private_match_starts_only_when_every_human_is_ready() {
    let mut room = private_room();
    let ana = seat(&mut room, "ana");
    let bo = seat(&mut room, "bo");

    ready(&mut room, ana, true);
    assert!(
        run(&mut room, LOBBY_BOT_TIMEOUT * 2.0).is_none(),
        "one player readied and the match started without the other — and it \
         waited out twice the public timeout, so this is not a slow start"
    );

    ready(&mut room, bo, true);
    let at = run(&mut room, 1.0).expect(
        "both players are ready and the match never started — the half above \
         passes for a lobby that never starts, and this is the half that says \
         it does",
    );
    assert!(
        at < 0.5,
        "started {at:.2}s after the last ready, not at once"
    );
}

/// A private lobby has no timeout at all (§E3).
///
/// The public rule is ten seconds from the first seating. This waits three times
/// that with nobody ready.
#[test]
fn a_private_lobby_waits_forever() {
    let mut room = private_room();
    seat(&mut room, "ana");
    assert!(
        run(&mut room, LOBBY_BOT_TIMEOUT * 3.0).is_none(),
        "a private lobby timed out — §E3 says it waits as long as its players do"
    );
}

/// And it does not start on a full house either (§E2's fill rule is public).
///
/// Five people who have not agreed to play are still five people who have not
/// agreed to play.
#[test]
fn a_full_private_lobby_still_waits_for_consent() {
    let mut room = private_room();
    for i in 0..LOBBY_CAPACITY {
        seat(&mut room, &format!("p{i}"));
    }
    assert!(
        run(&mut room, LOBBY_BOT_TIMEOUT * 2.0).is_none(),
        "a private lobby filled to capacity started without anyone readying"
    );
}

/// An empty private lobby does not start itself.
///
/// `all()` over an empty iterator is `true`, so without the human count the
/// consent gate is satisfied by a room nobody is in.
#[test]
fn an_empty_private_lobby_does_not_start_itself() {
    let mut room = private_room();
    assert!(
        run(&mut room, 2.0).is_none(),
        "an empty private lobby started a match with nobody in it"
    );
}

/// A settings change clears every consent, including the changer's own (§E3).
///
/// The control is the start attempt either side: the lobby was one tick from
/// starting before the change and is not after it, which is the difference a
/// cleared flag makes and a merely-reordered roster does not.
#[test]
fn changing_the_map_size_withdraws_everyone_s_consent() {
    let mut room = private_room();
    let ana = seat(&mut room, "ana");
    let bo = seat(&mut room, "bo");
    ready(&mut room, ana, true);
    ready(&mut room, bo, true);

    set_scale(&mut room, ana, MapScale::Large).expect("the host may change the map size");

    assert!(
        run(&mut room, 1.0).is_none(),
        "the match started after a settings change — everyone had agreed to a \
         Small map and was given a Large one"
    );

    ready(&mut room, ana, true);
    ready(&mut room, bo, true);
    assert!(
        run(&mut room, 1.0).is_some(),
        "re-readying after the change did not start the match, so the \
         assertion above passes for a lobby that had simply broken"
    );
}

/// Ready is a toggle, not a latch.
#[test]
fn withdrawing_ready_holds_the_match_back() {
    let mut room = private_room();
    let ana = seat(&mut room, "ana");
    let bo = seat(&mut room, "bo");
    ready(&mut room, ana, true);
    ready(&mut room, bo, true);
    ready(&mut room, bo, false);

    assert!(
        run(&mut room, 1.0).is_none(),
        "bo withdrew and the match started anyway — ready is latching, not toggling"
    );

    ready(&mut room, bo, true);
    assert!(
        run(&mut room, 1.0).is_some(),
        "bo re-readied and the match did not start"
    );
}

/// Succession follows the clock, not the seat number.
///
/// The test above cannot tell `joined_at` from seat-id order, because after the
/// host leaves the survivors happen to be in the same order either way. This is
/// the case that separates them, and it is **reachable in production**:
/// `Seats::alloc` pops a freed id, so a player who joins after the host left
/// takes the host's *low* id with the *latest* timestamp. Ordering by id would
/// hand the newcomer the settings the moment anyone rejoins.
///
/// It matters beyond the room because T17.07 renders the owner, so getting it
/// wrong is a visible bug rather than an internal one.
#[test]
fn a_rejoiner_with_a_recycled_seat_id_does_not_inherit_the_settings() {
    let mut room = private_room();
    let ana = seat(&mut room, "ana");
    // The timestamps have to be distinguishable, and `Instant` is monotonic but
    // two `seat` calls can land inside one tick of the clock's resolution.
    std::thread::sleep(std::time::Duration::from_millis(2));
    let bo = seat(&mut room, "bo");

    room.apply_for_test(Command::Leave(ana));
    std::thread::sleep(std::time::Duration::from_millis(2));
    let carl = seat(&mut room, "carl");

    assert_eq!(
        carl, ana,
        "the freed id was not recycled, so this test is not exercising the case \
         it was written for"
    );

    let owner = room.lobby_state().settings_owner;
    assert_eq!(
        owner,
        Some(bo),
        "the settings went to the player holding the lowest seat id rather than \
         the longest-seated human: carl took ana's recycled id and inherited with it"
    );
    // And the room agrees with what it reports.
    assert!(
        set_scale(&mut room, carl, MapScale::Large).is_err(),
        "carl was refused in `lobby_state` and allowed by the room"
    );
    set_scale(&mut room, bo, MapScale::Large).expect("the longest-seated human did not inherit");
}

/// Withdrawing consent must not make a player droppable.
///
/// `sweep_unready` drops seats that never finished their handshake, and it reads
/// `Seat.ready`. If consent and the handshake latch were one field — as they were
/// until T17.04 — un-readying in a private lobby would arm a thirty-second
/// eviction, which is exactly the timeout §E3 says a private lobby does not have.
///
/// **Written because the falsification found nothing.** Collapsing the two fields
/// back into one passed every other test in this file, so the split was carrying
/// no assertion at all.
#[test]
fn withdrawing_ready_does_not_arm_the_unready_sweep() {
    let mut room = private_room();
    let ana = seat(&mut room, "ana");
    let bo = seat(&mut room, "bo");
    ready(&mut room, ana, true);
    ready(&mut room, bo, true);
    ready(&mut room, bo, false);

    // Zero timeout: everyone who is sweepable at all is swept now. The control
    // is that this is the same call that *would* drop a player who never sent
    // `ready`, asserted below.
    let dropped = room.sweep_unready_for_test(std::time::Duration::ZERO);
    assert!(
        dropped.is_empty(),
        "un-readying armed the sweep: {dropped:?} would be evicted from a lobby \
         §E3 says has no timeout"
    );

    // Control: a seat that never handshook at all *is* swept, so the assertion
    // above is about the toggle and not about a sweep that never fires.
    let never = seat(&mut room, "never");
    let dropped = room.sweep_unready_for_test(std::time::Duration::ZERO);
    assert_eq!(
        dropped,
        vec![never],
        "the sweep did not drop a player who never sent ready, so it proves nothing"
    );
}

/// Only the settings owner may change the map size, and the refusal says so.
#[test]
fn a_guest_cannot_change_the_map_size() {
    let mut room = private_room();
    let ana = seat(&mut room, "ana");
    let bo = seat(&mut room, "bo");

    let refused = set_scale(&mut room, bo, MapScale::Large);
    assert!(refused.is_err(), "a guest changed the host's settings");

    // The control: the same call from the host is allowed, so the refusal above
    // is about *who asked* and not about the room refusing everyone.
    set_scale(&mut room, ana, MapScale::Large).expect("the host was refused their own settings");
}

/// When the host leaves, the lobby and its code survive and the next
/// longest-seated human inherits the settings (§E3).
#[test]
fn the_settings_pass_to_the_longest_seated_when_the_host_leaves() {
    let mut room = private_room();
    let ana = seat(&mut room, "ana");
    let bo = seat(&mut room, "bo");
    let cass = seat(&mut room, "cass");

    // Control: cass cannot change anything while ana is here.
    assert!(
        set_scale(&mut room, cass, MapScale::Large).is_err(),
        "the third-seated player owned the settings while the host was present"
    );

    room.apply_for_test(Command::Leave(ana));

    // bo joined before cass, so bo inherits — not "whoever is first in the vec",
    // which happens to be the same today and would not be after a seat is freed
    // and reused.
    assert!(
        set_scale(&mut room, cass, MapScale::Medium).is_err(),
        "settings passed to the newest player rather than the longest-seated"
    );
    set_scale(&mut room, bo, MapScale::Medium).expect("the longest-seated human did not inherit");

    let state = room.lobby_state();
    assert_eq!(
        state.settings_owner,
        Some(bo),
        "the lobby still names the departed host as its settings owner"
    );
    assert_eq!(
        state.code.as_deref(),
        Some("ABC123"),
        "the join code did not survive the host leaving"
    );
    assert!(
        state.private,
        "the lobby stopped being private when its host left"
    );
}
