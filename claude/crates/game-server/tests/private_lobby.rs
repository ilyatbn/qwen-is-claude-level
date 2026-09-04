//! Private lobbies: a code, settings and ready (`docs/74-amendments-v6.md` §E3).
//!
//! The public rules do not apply here. There is no timeout and no fill-start:
//! a private lobby waits as long as its players do, and starts when every
//! seated human has said yes to the game they are being shown.
//!
//! These drive a `Room` directly rather than a socket, because every rule under
//! test is a room decision — the wire half is `lobby_state.rs`.

use std::sync::Arc;

use game_core::constants::{
    MapScale, StartKit, BASE_HEALTH, INVENTORY_SLOTS, LOBBY_BOT_TIMEOUT, LOBBY_CAPACITY,
    PISTOL_AMMO, RESPAWN_DELAY, ROUND_SECONDS, ROUND_SECONDS_MAX, ROUND_SECONDS_MIN,
    ROUND_SECONDS_STEP, SIM_DT, START_KIT_GRENADES, WARMUP_SECONDS,
};
use game_core::items::registry::WEAPON_BAZOOKA;
use game_core::world::RoundPhase;
use game_server::config::Config;
use game_server::room::{Command, Room};

fn cfg() -> Arc<Config> {
    Arc::new(Config {
        map_scale: MapScale::Small,
        bot_count: 0,
        ..Config::default()
    })
}

/// A room as quick match makes one: no code, not private, so §E2's public rules
/// apply — including the unready sweep, which §E3 keeps out of a private lobby.
fn public_room() -> Room {
    Room::new(cfg())
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
/// until T17.04 — un-readying would arm a thirty-second eviction on a player who
/// is sitting right there.
///
/// **Written because the falsification found nothing.** Collapsing the two fields
/// back into one passed every other test in this file, so the split was carrying
/// no assertion at all.
///
/// **It runs on a started public room, and that is T20.01's doing.** It used to
/// sit in a private lobby — but the sweep no longer fires in *any* lobby, so both
/// halves would pass for a room whose sweep is simply switched off, and
/// collapsing the two fields would once again prove nothing. Falsified the way
/// the doc comment above demands: with `s.ready = on` in `Command::Ready` this is
/// **red**; on a private lobby, with the same collapse, it was green.
#[test]
fn withdrawing_ready_does_not_arm_the_unready_sweep() {
    let mut room = public_room();
    let ana = seat(&mut room, "ana");
    let bo = seat(&mut room, "bo");
    ready(&mut room, ana, true);
    ready(&mut room, bo, true);
    ready(&mut room, bo, false);
    // The sweep only runs once there is a map to have failed to decode (T20.01).
    room.request_start();
    room.tick_inline(SIM_DT);
    assert!(
        room.world_for_test().players.len() >= 2,
        "the match never started, so the sweep below never runs and proves nothing"
    );

    // Zero timeout: everyone who is sweepable at all is swept now. The control
    // is that this is the same call that *would* drop a player who never sent
    // `ready`, asserted below.
    let dropped = room.sweep_unready_for_test(std::time::Duration::ZERO);
    assert!(
        dropped.is_empty(),
        "un-readying armed the sweep: {dropped:?} would be evicted for having \
         changed their mind about a game that has not started"
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

/// §E3, `docs/74:110`: **"No timeout, ever. A private lobby waits as long as its
/// players do."**
///
/// The bug this is written against, in the words it was reported in: *"about 30 s
/// to a minute into hosting a private match, the host stops being able to change
/// the settings"*. `settings_owner()` is the longest-seated human and is not
/// time-based; what changed at 30 s was the **seat list**. The host never sends
/// `ready` — the only one a private lobby has is the tick-box — so `sweep_unready`
/// evicted them from their own lobby and the owner became `None`.
///
/// **The scope that landed is wider than §E3 asks for**: the sweep does not run
/// in *any* lobby, private or public. Measured — see `room.rs::sweep_unready`'s
/// doc comment and `a_lobby_is_never_swept_however_long_it_has_waited`.
///
/// A zero timeout rather than a real 30 s wait: the production caller passes
/// `READY_TIMEOUT`, and *"even a timeout of zero sweeps nobody"* is strictly
/// stronger than *"the shipped one does not"*. The wall-clock half — a browser
/// that actually sits past `READY_TIMEOUT_SECS` and then moves a setting — is
/// `scripts/checks/lobby.mjs`.
#[test]
fn a_private_lobby_is_never_swept_and_the_host_keeps_the_settings() {
    let mut room = private_room();
    let ana = seat(&mut room, "ana");
    let bo = seat(&mut room, "bo");

    // Nobody has handshaken, and the timeout is zero: this is the harshest form
    // of the sweep there is.
    let dropped = room.sweep_unready_for_test(std::time::Duration::ZERO);
    assert!(
        dropped.is_empty(),
        "§E3 says a private lobby has no timeout and {dropped:?} was evicted from one"
    );
    assert_eq!(
        room.lobby_state().players.len(),
        2,
        "the private lobby lost a seat to the sweep"
    );

    // The reported symptom, asserted directly: the host can still change a
    // setting, and the room still names them as the owner.
    assert_eq!(room.lobby_state().settings_owner, Some(ana));
    set_scale(&mut room, ana, MapScale::Large)
        .expect("the host was refused their own settings after the sweep ran");
    // And it is still *only* the host: a sweep that spared everybody must not
    // have handed the settings to the guest as well.
    assert!(
        set_scale(&mut room, bo, MapScale::Medium).is_err(),
        "the guest inherited the settings"
    );

    // **The control.** This asserts an absence, and an absence needs a presence:
    // the same call, on a room that has a map out. Without it the test above
    // passes for a sweep that has stopped working at all.
    let mut started = public_room();
    let never = seat(&mut started, "never");
    started.request_start();
    started.tick_inline(SIM_DT);
    assert_eq!(
        started.sweep_unready_for_test(std::time::Duration::ZERO),
        vec![never],
        "the sweep dropped nobody in a running match either, so the claim above is vacuous"
    );
}

/// A private lobby that has **started** is swept like anything else.
///
/// The scope §E3 buys is "a private lobby", not "a private room forever": once
/// the map is on the wire, a client that never decodes it is exactly the case
/// `sweep_unready` was built for, private or not.
#[test]
fn a_private_match_that_has_started_is_swept_again() {
    let mut room = private_room();
    let ana = seat(&mut room, "ana");
    ready(&mut room, ana, true);
    let ghost = seat(&mut room, "ghost");
    ready(&mut room, ghost, true);

    // §E3 starts a private match when every seated human consents. `tick_inline`
    // asks for a world and builds one, the way the room task does across a tick
    // and a blocking thread.
    for _ in 0..3 {
        room.tick_inline(SIM_DT);
        if room.world_for_test().players.len() == 2 {
            break;
        }
    }
    assert_eq!(
        room.world_for_test().players.len(),
        2,
        "the private match never started, so the sweep below is being asked about a lobby"
    );

    // Now a seat that never handshakes. In a lobby §E3 protects it; in a match
    // nothing does.
    let late = seat(&mut room, "late");
    assert_eq!(
        room.sweep_unready_for_test(std::time::Duration::ZERO),
        vec![late],
        "a started private match stopped sweeping a client that never decoded its map"
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

// ---------------------------------------------------------------------------
// §F7 — the three private-lobby settings
// ---------------------------------------------------------------------------

fn set_bots(room: &mut Room, by: u8, on: bool) -> Result<(), &'static str> {
    let (reply, rx) = tokio::sync::oneshot::channel();
    room.apply_for_test(Command::SetBots { by, on, reply });
    rx.blocking_recv().expect("the room answered")
}

fn set_kit(room: &mut Room, by: u8, kit: StartKit) -> Result<(), &'static str> {
    let (reply, rx) = tokio::sync::oneshot::channel();
    room.apply_for_test(Command::SetStartKit { by, kit, reply });
    rx.blocking_recv().expect("the room answered")
}

fn set_round_seconds(room: &mut Room, by: u8, seconds: f32) -> Result<(), &'static str> {
    let (reply, rx) = tokio::sync::oneshot::channel();
    room.apply_for_test(Command::SetRoundSeconds { by, seconds, reply });
    rx.blocking_recv().expect("the room answered")
}

/// A room with a world, so inventories and the round clock can be read.
///
/// `tick_inline` rather than `tick_once`: §E1 split "ask for a world" from
/// "build one", and every §F7 claim below is about what the built world holds.
fn start(room: &mut Room) {
    for _ in 0..2 {
        let _ = room.tick_inline(SIM_DT);
    }
    assert!(
        room.lobby_state().players.iter().any(|_| true),
        "the room emptied itself before the match started"
    );
}

/// Each setting: the host moves it, every seat sees it, every ready flag clears.
///
/// The ready half is asserted **after** setting both players ready, so a lobby
/// that never sets the flag at all cannot pass — and the control is the
/// non-host, who is refused and changes nothing.
#[test]
fn the_host_moves_each_setting_and_every_ready_flag_clears() {
    for (name, apply) in [
        (
            "bots",
            (&|r: &mut Room, by: u8| set_bots(r, by, false)) as &dyn Fn(&mut Room, u8) -> _,
        ),
        ("start_kit", &|r: &mut Room, by: u8| {
            set_kit(r, by, StartKit::Basic)
        }),
        ("round_seconds", &|r: &mut Room, by: u8| {
            set_round_seconds(r, by, ROUND_SECONDS_MIN + ROUND_SECONDS_STEP)
        }),
    ] {
        let mut room = private_room();
        let ana = seat(&mut room, "ana");
        let bo = seat(&mut room, "bo");
        ready(&mut room, ana, true);
        ready(&mut room, bo, true);
        assert!(
            room.lobby_state().players.iter().all(|p| p.ready),
            "{name}: the control failed — both players were set ready and the \
             lobby does not show it, so 'the flags cleared' below proves nothing"
        );

        // The control, first: a non-host is refused and nothing moves.
        let before = room.lobby_state();
        assert_eq!(
            apply(&mut room, bo),
            Err("only the host can change the settings"),
            "{name}: a non-host changed a setting"
        );
        let after = room.lobby_state();
        assert_eq!(
            (after.bots, after.start_kit, after.round_seconds),
            (before.bots, before.start_kit, before.round_seconds),
            "{name}: the refusal still moved the setting"
        );
        assert!(
            after.players.iter().all(|p| p.ready),
            "{name}: a refused change cleared the ready flags"
        );

        assert_eq!(
            apply(&mut room, ana),
            Ok(()),
            "{name}: the host was refused"
        );
        let s = room.lobby_state();
        match name {
            "bots" => assert!(!s.bots, "bots did not move"),
            "start_kit" => assert_eq!(s.start_kit, StartKit::Basic, "start_kit did not move"),
            _ => assert_eq!(
                s.round_seconds,
                ROUND_SECONDS_MIN + ROUND_SECONDS_STEP,
                "round_seconds did not move"
            ),
        }
        assert!(
            s.players.iter().all(|p| !p.ready),
            "{name}: §E3 — a settings change must clear every ready flag, \
             including the changer's"
        );
    }
}

/// Bots off means no bots, and stays that way. Control: the same room with bots
/// on seats them.
///
/// Without the control this passes against a build whose bots never spawn at
/// all, which is exactly the shape §F7 is trying to make optional.
#[test]
fn bots_off_seats_none_and_bots_on_seats_them() {
    let with_bots = Arc::new(Config {
        map_scale: MapScale::Small,
        bot_count: 3,
        ..Config::default()
    });

    let mut off = Room::new(with_bots.clone());
    off.apply_for_test(Command::SetIdentity {
        code: Some("ABC123".into()),
        private: true,
    });
    let ana = seat(&mut off, "ana");
    assert_eq!(set_bots(&mut off, ana, false), Ok(()));
    ready(&mut off, ana, true);
    start(&mut off);
    // 30 s of real ticks: a bot seated late would still be caught.
    for _ in 0..(30.0 / SIM_DT) as usize {
        let _ = off.tick_inline(SIM_DT);
    }
    assert_eq!(
        off.lobby_state().players.iter().filter(|p| p.bot).count(),
        0,
        "bots were off and the room seated some anyway"
    );

    let mut on = Room::new(with_bots);
    on.apply_for_test(Command::SetIdentity {
        code: Some("ABC124".into()),
        private: true,
    });
    let ana = seat(&mut on, "ana");
    ready(&mut on, ana, true);
    start(&mut on);
    assert_eq!(
        on.lobby_state().players.iter().filter(|p| p.bot).count(),
        3,
        "the control failed: bots are on by default and the room seated none, \
         so 'zero bots when off' above is not evidence of anything"
    );
}

/// What each kit puts in a player's hands, at spawn **and** after a respawn.
///
/// The respawn half is the one that matters: `PlayerState::die` drops
/// everything except the issued shovel, so a kit granted only at match start
/// would silently mean "for your first life".
#[test]
fn each_kit_arms_a_player_at_spawn_and_again_after_a_respawn() {
    for kit in StartKit::ALL {
        let mut room = private_room();
        let ana = seat(&mut room, "ana");
        assert_eq!(set_kit(&mut room, ana, kit), Ok(()));
        ready(&mut room, ana, true);
        start(&mut room);

        let held = |room: &Room| -> Vec<(u16, u8)> {
            let w = room.world().expect("the match started");
            (0..INVENTORY_SLOTS as u8)
                .filter_map(|s| w.player(ana).and_then(|p| p.inventory.slot(s)))
                .map(|st| (st.item, st.count))
                .collect()
        };

        let at_spawn = held(&room);
        assert_kit(kit, &at_spawn, "at spawn");

        // Kill and respawn through the **real** path: a blast, resolved by
        // `detonate`, during `Playing`. Writing `health = 0.0` looks like a
        // death and is not one — nothing calls `die`, no `Respawn` is emitted,
        // and the inventory is never dropped, so the assertion below would be
        // reading the kit that was still sitting there from spawn.
        // Wait for the **round controller** to reach `Playing` rather than
        // writing the phase: it rewrites `World::phase` from `round_time` on
        // every tick, so a hand-set phase lasts exactly one tick — long enough
        // for the blast to land and not long enough for `resolve_deaths` to run,
        // which is a player on -44 health who is still alive. Bounded by
        // `WARMUP_SECONDS`, not by a hardcoded wait.
        let mut playing = false;
        for _ in 0..((WARMUP_SECONDS * 2.0) / SIM_DT) as usize {
            let _ = room.tick_inline(SIM_DT);
            if room.phase() == RoundPhase::Playing {
                playing = true;
                break;
            }
        }
        assert!(playing, "{kit:?}: the round never left warmup");
        let at = {
            let p = room
                .world_mut()
                .and_then(|w| w.player_mut(ana))
                .expect("seated");
            p.health = 1.0;
            p.body.pos
        };
        let now = room.world().expect("a world").round_time;
        room.world_mut()
            .expect("a world")
            .explode_for_test(at, WEAPON_BAZOOKA, u8::MAX, now);
        // **Watched through health, not through the event stream.** `Respawn`
        // never reaches `tick_inline`'s return — the room drains the world's
        // events into its broadcast path and hands back only what it re-emits —
        // so a test waiting on the event waits forever while the respawn it is
        // waiting for happens under it.
        //
        // Dead-then-alive is also the control the assertion needs: "they are on
        // full health holding the kit" is satisfied by a blast that missed.
        let vitals = |room: &Room| {
            room.world()
                .and_then(|w| w.player(ana))
                .map(|p| (p.alive, p.health))
                .expect("seated")
        };
        let mut saw_dead = false;
        let mut respawned = false;
        for _ in 0..(RESPAWN_DELAY * 3.0 / SIM_DT) as usize {
            let _ = room.tick_inline(SIM_DT);
            let (alive, health) = vitals(&room);
            if !alive {
                saw_dead = true;
            } else if saw_dead && health == BASE_HEALTH {
                respawned = true;
                break;
            }
        }
        assert!(saw_dead, "{kit:?}: the blast never killed them");
        assert!(respawned, "{kit:?}: the player never came back");
        assert_kit(kit, &held(&room), "after a respawn");
    }
}

/// The shared expectation, so the spawn and respawn halves cannot drift.
fn assert_kit(kit: StartKit, held: &[(u16, u8)], when: &str) {
    let shovel = game_core::items::registry::SHOVEL;
    let has = |id: u16| held.iter().find(|(i, _)| *i == id).map(|(_, n)| *n);
    assert!(
        has(shovel).is_some(),
        "{kit:?} {when}: §F5 issues a shovel to everyone and it is not there"
    );
    match kit {
        StartKit::None => assert_eq!(
            held.len(),
            1,
            "{kit:?} {when}: 'none' is the shovel and nothing else, got {held:?}"
        ),
        StartKit::Basic => {
            assert_eq!(
                held.len(),
                3,
                "{kit:?} {when}: expected the shovel, a pistol and grenades, got {held:?}"
            );
            assert_eq!(
                has(game_core::items::registry::PISTOL),
                Some(PISTOL_AMMO),
                "{kit:?} {when}: the pistol's ammo is not PISTOL_AMMO"
            );
            assert_eq!(
                has(game_core::items::registry::GRENADE),
                Some(START_KIT_GRENADES),
                "{kit:?} {when}: the grenade count is not START_KIT_GRENADES"
            );
        }
        StartKit::All => {
            for d in game_core::items::registry::live_weapons() {
                assert_eq!(
                    has(d.id),
                    Some(d.max_stack),
                    "{kit:?} {when}: {} is missing or short of max_stack",
                    d.key
                );
            }
            // The other half: the retired placeholders stay unreachable.
            for d in game_core::items::registry::ITEMS.iter() {
                if game_core::items::registry::is_retired(d) {
                    assert_eq!(
                        has(d.id),
                        None,
                        "{kit:?} {when}: {} is retired and was handed out",
                        d.key
                    );
                }
            }
        }
    }
}

/// The bounds are refused, not clamped (`docs/61` §3), and a legal value is
/// honoured by the round clock rather than only by the lobby.
#[test]
fn round_seconds_is_bounded_and_reaches_the_round_clock() {
    let mut room = private_room();
    let ana = seat(&mut room, "ana");

    for (bad, why) in [
        (ROUND_SECONDS_MIN - ROUND_SECONDS_STEP, "below the minimum"),
        (ROUND_SECONDS_MAX + ROUND_SECONDS_STEP, "above the maximum"),
        (ROUND_SECONDS_MIN + 1.0, "off the step"),
    ] {
        assert!(
            set_round_seconds(&mut room, ana, bad).is_err(),
            "{bad} is {why} and was accepted"
        );
        assert_eq!(
            room.lobby_state().round_seconds,
            ROUND_SECONDS,
            "{bad} was refused but the setting moved anyway"
        );
    }
    assert_eq!(
        set_round_seconds(&mut room, ana, ROUND_SECONDS_MAX),
        Ok(()),
        "the control failed: the maximum itself must be accepted, or the \
         refusals above are satisfied by a room that refuses everything"
    );

    // And the room's round is actually that long.
    assert_eq!(set_round_seconds(&mut room, ana, ROUND_SECONDS_MIN), Ok(()));
    ready(&mut room, ana, true);
    start(&mut room);
    let len = room.world().expect("the match started").round_seconds();
    assert_eq!(
        len, ROUND_SECONDS_MIN,
        "the lobby's round length never reached the world"
    );
}

/// §F7: "no settings on public lobbies. A public match is the game as shipped."
#[test]
fn a_public_lobby_refuses_all_three_settings() {
    let mut room = Room::new(cfg());
    let ana = seat(&mut room, "ana");
    assert_eq!(
        room.lobby_state().settings_owner,
        Some(ana),
        "the control failed: this player is not the settings owner, so the \
         refusals below could be about the host check instead"
    );
    let want = Err("settings can only be changed in a private game");
    assert_eq!(set_bots(&mut room, ana, false), want);
    assert_eq!(set_kit(&mut room, ana, StartKit::All), want);
    assert_eq!(set_round_seconds(&mut room, ana, ROUND_SECONDS_MAX), want);
}
