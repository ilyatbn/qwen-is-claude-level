//! T4.10 — end-to-end: two players, one kills the other, both observe it.
//!
//! docs/08 §2 asks for "two fake socket.io clients ... assert both receive
//! snapshots and a kill event when P1's rocket hits P2's position. (Keep it
//! coarse — the fine logic is already covered in game-core.)"
//!
//! This drives the room and tick layer directly rather than over a real
//! socket. See DEVIATIONS.md D43 for why, and what that does and does not
//! cover.

use game_core::map::Scale;
use game_core::protocol::{InputFrame, ItemId, Snapshot};
use game_core::round::{Event, RoundState};

#[path = "../src/rooms.rs"]
mod rooms;
#[path = "../src/tick.rs"]
mod tick;

use rooms::Room;

/// A room with two joined, ready players and a started round.
fn two_player_round(seed: u64) -> Room {
    let mut room = Room::new(1, seed, Scale::Small);
    room.join("sock-p1", "P1").expect("P1 joins");
    room.join("sock-p2", "P2").expect("P2 joins");
    room.set_ready("sock-p1", true);
    room.set_ready("sock-p2", true);
    // Lobby -> Countdown -> Running (3 s = 60 ticks, plus slack for float).
    for _ in 0..70 {
        tick::step_room(&mut room);
        if room.state() == RoundState::Running {
            break;
        }
    }
    assert_eq!(room.state(), RoundState::Running, "the round never started");
    room
}

#[test]
fn two_clients_join_ready_and_start_a_round() {
    let room = two_player_round(1);
    assert_eq!(room.player_count(), 2);
    assert_eq!(room.player_of("sock-p1"), Some(0));
    assert_eq!(room.player_of("sock-p2"), Some(1));
}

#[test]
fn both_clients_receive_snapshots_at_10hz() {
    // docs/08 §2: "assert both receive snapshots". One snapshot is broadcast
    // to the whole room, so "both receive" means it carries both players.
    let mut room = two_player_round(2);
    let mut snapshots = 0;
    let mut ticks = 0;
    for _ in 0..100 {
        ticks += 1;
        if let Some(json) = tick::step_room(&mut room).snapshot {
            let snap: Snapshot = serde_json::from_str(&json).expect("valid snapshot JSON");
            assert_eq!(snap.players.len(), 6, "docs/06 §4: always 6 entries");
            assert!(snap.players[0].alive || snap.players[0].respawn_in_s > 0.0);
            assert!(!snap.players[1].name.is_empty(), "P2 missing from the snapshot");
            snapshots += 1;
        }
    }
    assert_eq!(snapshots, ticks / 2, "snapshots should be 10 Hz against a 20 Hz tick");
}

#[test]
fn p1_rockets_p2_and_both_see_the_kill() {
    // docs/08 §2 / T4.10 step 1: "P1 aims at P2's spawn and fires a rocket
    // (scripted inputs), assert P2 receives a kill event, P1's score +1 in the
    // next snapshot, P2 respawns after 3 s".
    let mut room = two_player_round(3);

    // Arm P1 with a rocket and stand P2 next to them, so the shot is a
    // scripted certainty rather than a marksmanship test.
    room.round.players[0].player.inventory.slots[0] = Some(ItemId::Rocket);
    room.round.players[0].ammo[0] = 6;
    room.round.players[0].player.inventory.selected = 0;
    let shooter = room.round.players[0].player.pos;
    room.round.players[1].player.pos = game_core::Vec2::new(shooter.x + 40.0, shooter.y);
    room.round.players[1].player.health = 30.0;

    // Aim right, hold fire.
    let fire = InputFrame { fire: true, aim: 0.0, ..InputFrame::default() };

    let mut kill: Option<(u8, Option<u8>)> = None;
    let mut explosion = false;
    for _ in 0..40 {
        room.queue_input("sock-p1", fire);
        for event in tick::step_room(&mut room).events {
            match event {
                Event::Kill { victim, killer, .. } => kill = Some((victim, killer)),
                Event::Explosion { .. } => explosion = true,
                _ => {}
            }
        }
        if kill.is_some() {
            break;
        }
    }

    assert!(explosion, "the rocket never detonated");
    let (victim, killer) = kill.expect("P1's rocket did not kill P2");
    assert_eq!(victim, 1, "the wrong player died");
    assert_eq!(killer, Some(0), "P1 was not credited");

    // P1's score is +1 in the next snapshot (docs/06 §4).
    let mut scored = None;
    for _ in 0..4 {
        if let Some(json) = tick::step_room(&mut room).snapshot {
            let snap: Snapshot = serde_json::from_str(&json).unwrap();
            scored = Some(snap.players[0].score);
            break;
        }
    }
    assert_eq!(scored, Some(1), "P1's +1 did not reach the snapshot");

    // P2 respawns after 3 s (docs/03 §2), reported as an event.
    let mut respawned = false;
    for _ in 0..80 {
        for event in tick::step_room(&mut room).events {
            if matches!(event, Event::Respawned { player: 1, .. }) {
                respawned = true;
            }
        }
        if respawned {
            break;
        }
    }
    assert!(respawned, "P2 never respawned after 3 s");
    assert!(room.round.players[1].player.alive);
    assert_eq!(room.round.players[1].player.health, 100.0);
}

#[test]
fn a_disconnect_mid_round_removes_the_player_from_snapshots() {
    // docs/05 §2: "their body is removed and they can't respawn".
    let mut room = two_player_round(4);
    room.leave("sock-p2");
    for _ in 0..10 {
        tick::step_room(&mut room);
    }
    assert_eq!(room.player_count(), 1);
    assert!(!room.round.players[1].player.alive, "a departed player stayed alive");
    assert_eq!(
        room.round.players[1].player.respawn_at_tick, None,
        "a departed player is queued to respawn",
    );
}

#[test]
fn a_seventh_client_is_refused_with_room_full() {
    // docs/05 §2 / docs/06 §2.
    let mut room = Room::new(1, 5, Scale::Small);
    for i in 0..6 {
        room.join(&format!("s{i}"), &format!("p{i}")).unwrap();
    }
    let refused = room.join("s6", "seventh").unwrap_err();
    assert_eq!(refused.code(), "room_full");
}

#[test]
fn a_pinned_seed_reproduces_the_same_round_for_both_clients() {
    // docs/05 §7: WIPGAME_SEED pins every round, which is what makes a
    // reported bug reproducible.
    let a = two_player_round(777);
    let b = two_player_round(777);
    assert_eq!(a.round.map.tiles, b.round.map.tiles);
    assert_eq!(a.round.map.spawns, b.round.map.spawns);
    assert_eq!(a.round.ground, b.round.ground);
}
