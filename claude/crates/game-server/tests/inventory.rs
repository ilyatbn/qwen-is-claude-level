//! T14.05 / §C10 — the quick bar, the backpack, and `move_item` as a **command**.
//!
//! The rules themselves are unit-tested in `items::inventory::dragging`. What is
//! here is the thing only a running room can answer: that a `move_item` arriving
//! from a client reaches the world, that the server refuses the ones it should,
//! and that the panel is not a pause.
//!
//! Multi-thread runtime, for the reason `tests/room.rs` records at length: a room
//! task sharing one thread with the test future starves it.

use std::sync::Arc;
use std::time::Duration;

use game_core::constants::{MapScale, BACKPACK_SLOTS, INVENTORY_SLOTS, QUICK_SLOTS};
use game_core::items::registry::{BAZOOKA, GRENADE, SHOVEL};
use game_server::config::Config;
use game_server::room::{spawn_room, Command, RoomHandle};
use socketioxide::SocketIo;
use tokio::sync::oneshot;

/// The first backpack slot, derived rather than written as 8.
const BACKPACK: u8 = QUICK_SLOTS as u8;

/// The first slot a pickup can land in.
///
/// **Not 0 since §F5**: every player is issued a shovel on join, `add` takes the
/// first free slot, and every fixture here that said "slot 0" was reading the
/// starting kit rather than what it had just given. It is 1 because the kit is
/// one item; if the kit grows, this is the single place that follows it, and
/// `a_move_item_command_moves_the_stack_and_the_server_agrees` asserts the
/// bazooka is really here before moving it, so a stale value fails loudly.
const FIRST_FREE: u8 = 1;

fn room() -> (RoomHandle, oneshot::Sender<()>) {
    let config = Arc::new(Config {
        map_scale: MapScale::Small,
        bot_count: 0,
        ..Config::default()
    });
    let (_layer, io) = SocketIo::new_layer();
    let (tx, rx) = oneshot::channel();
    (spawn_room(io, config, rx), tx)
}

async fn settle() {
    tokio::time::sleep(Duration::from_millis(80)).await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_move_item_command_moves_the_stack_and_the_server_agrees() {
    let (room, _shut) = room();
    let id = room.join("ana".into(), 0, 0).await.expect("seated");
    // §E1: a lobby has no world, so an inventory test has to start the match
    // before there is anywhere to put an item.
    assert!(
        room.start_and_wait(id, Duration::from_secs(20)).await,
        "the match never started, so there is no world to hold an inventory"
    );
    room.inspect(move |w| game_core::world::give(w, id, BAZOOKA, 4))
        .await
        .expect("alive");
    settle().await;

    // The control: it starts in the quick bar, so what is asserted below is a
    // move and not a stack that was always there.
    let where_it_was = room
        .inspect(move |w| {
            w.player(id)
                .and_then(|p| p.inventory.slot(FIRST_FREE))
                .map(|s| s.item)
        })
        .await
        .expect("alive");
    assert_eq!(
        where_it_was,
        Some(BAZOOKA),
        "the fixture never armed anyone"
    );

    room.send(Command::MoveItem(id, FIRST_FREE, BACKPACK));
    settle().await;

    let (quick, back) = room
        .inspect(move |w| {
            let p = w.player(id).expect("seated");
            (
                p.inventory.slot(FIRST_FREE).map(|s| s.item),
                p.inventory.slot(BACKPACK).map(|s| (s.item, s.count)),
            )
        })
        .await
        .expect("alive");
    assert_eq!(quick, None, "the quick-bar slot was not emptied");
    assert_eq!(
        back,
        Some((BAZOOKA, 4)),
        "the backpack slot did not receive it"
    );
}

/// Out of range, equal, and empty-source. **Refused, and the room survives** —
/// these indices come off the wire, and `move_item`'s whole job is to be the
/// place that does not trust them.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_malformed_move_is_refused_and_does_not_kill_the_room() {
    let (room, _shut) = room();
    let id = room.join("ana".into(), 0, 0).await.expect("seated");
    // §E1: a lobby has no world, so an inventory test has to start the match
    // before there is anywhere to put an item.
    assert!(
        room.start_and_wait(id, Duration::from_secs(20)).await,
        "the match never started, so there is no world to hold an inventory"
    );
    room.inspect(move |w| game_core::world::give(w, id, BAZOOKA, 4))
        .await
        .expect("alive");
    settle().await;

    for (from, to) in [
        (FIRST_FREE, FIRST_FREE),
        (FIRST_FREE, INVENTORY_SLOTS as u8),
        (INVENTORY_SLOTS as u8, FIRST_FREE),
        // The value `session.rs` substitutes for a missing field, so a client
        // that omits one gets a refusal rather than "slot 0".
        (255, 255),
        (FIRST_FREE, 255),
        (200, 201),
        // An empty source. **Past the starting kit** (§F5): slot 1 holds the
        // bazooka this fixture just gave, and a "move an empty slot" case that
        // moves a real stack tests the opposite of what it says.
        (5, 6),
    ] {
        room.send(Command::MoveItem(id, from, to));
    }
    settle().await;

    // Still alive, and nothing moved.
    let held = room
        .inspect(move |w| {
            let p = w.player(id).expect("seated");
            (
                p.inventory.slot(0).map(|s| (s.item, s.count)),
                p.inventory.slot(FIRST_FREE).map(|s| (s.item, s.count)),
            )
        })
        .await
        .expect("the room died on a malformed move");
    assert_eq!(
        held,
        (Some((SHOVEL, 1)), Some((BAZOOKA, 4))),
        "a refused move still moved something"
    );
}

/// §C10: the selection follows the quick bar, so `select_slot` into the backpack
/// is refused — by the *server*, which is the only opinion that counts.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn select_slot_cannot_reach_the_backpack() {
    let (room, _shut) = room();
    let id = room.join("ana".into(), 0, 0).await.expect("seated");
    // §E1: a lobby has no world, so an inventory test has to start the match
    // before there is anywhere to put an item.
    assert!(
        room.start_and_wait(id, Duration::from_secs(20)).await,
        "the match never started, so there is no world to hold an inventory"
    );
    room.inspect(move |w| game_core::world::give(w, id, BAZOOKA, 4))
        .await
        .expect("alive");
    settle().await;

    room.send(Command::SelectSlot(id, 3));
    settle().await;
    let after_quick = room
        .inspect(move |w| w.player(id).expect("seated").inventory.selected())
        .await
        .expect("alive");
    assert_eq!(after_quick, 3, "a quick-bar select was refused");

    room.send(Command::SelectSlot(id, BACKPACK));
    room.send(Command::SelectSlot(id, (INVENTORY_SLOTS - 1) as u8));
    settle().await;
    let after_backpack = room
        .inspect(move |w| w.player(id).expect("seated").inventory.selected())
        .await
        .expect("alive");
    assert_eq!(
        after_backpack, 3,
        "the selection moved into the backpack, where the player cannot see it"
    );
}

/// §C10: pickups fill the quick bar first, then the backpack.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn what_is_given_fills_the_quick_bar_before_the_backpack() {
    let (room, _shut) = room();
    let id = room.join("ana".into(), 0, 0).await.expect("seated");
    // §E1: a lobby has no world, so an inventory test has to start the match
    // before there is anywhere to put an item.
    assert!(
        room.start_and_wait(id, Duration::from_secs(20)).await,
        "the match never started, so there is no world to hold an inventory"
    );
    room.inspect(move |w| {
        // One weapon per slot: §C24 gives each weapon id exactly one slot, so
        // this is `QUICK_SLOTS` distinct ids and not one big stack.
        for (n, item) in [BAZOOKA, GRENADE].into_iter().enumerate() {
            game_core::world::give(w, id, item, 1 + n as u8);
        }
    })
    .await
    .expect("alive");
    settle().await;

    let (first_two, backpack_used) = room
        .inspect(move |w| {
            let p = w.player(id).expect("seated");
            let first: Vec<_> = (0..3)
                .map(|i| p.inventory.slot(i).map(|s| s.item))
                .collect();
            let used = (QUICK_SLOTS..INVENTORY_SLOTS)
                .filter(|i| p.inventory.slot(*i as u8).is_some())
                .count();
            (first, used)
        })
        .await
        .expect("alive");
    // The shovel is slot 0 on join (§F5), so what "fills the bar first" means is
    // that the two pickups landed immediately behind it and in the order given.
    assert_eq!(first_two, vec![Some(SHOVEL), Some(BAZOOKA), Some(GRENADE)]);
    assert_eq!(
        backpack_used, 0,
        "the backpack was used while the bar had room"
    );
}

/// The panel is an **overlay, not a pause** (§C10, and §B4 before it). Opening it
/// is client-side, so what the server can be asked is the thing that matters: the
/// world keeps ticking regardless of what any client is showing.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn the_world_keeps_ticking_while_the_inventory_is_being_rearranged() {
    let (room, _shut) = room();
    let id = room.join("ana".into(), 0, 0).await.expect("seated");
    // §E1: a lobby has no world, so an inventory test has to start the match
    // before there is anywhere to put an item.
    assert!(
        room.start_and_wait(id, Duration::from_secs(20)).await,
        "the match never started, so there is no world to hold an inventory"
    );
    room.inspect(move |w| game_core::world::give(w, id, BAZOOKA, 4))
        .await
        .expect("alive");
    settle().await;

    let t0 = room.inspect(|w| w.tick).await.expect("alive");
    for i in 0..8u8 {
        room.send(Command::MoveItem(id, i % 2, BACKPACK + i % 3));
        tokio::time::sleep(Duration::from_millis(30)).await;
    }
    let t1 = room.inspect(|w| w.tick).await.expect("alive");
    assert!(
        t1 > t0 + 5,
        "the world advanced only {} ticks while items were being dragged",
        t1 - t0
    );
}

/// The geometry the client lays the panel out from, asserted here so a change to
/// one constant cannot silently disagree with the other two.
#[test]
fn the_bar_and_the_backpack_account_for_every_slot() {
    assert_eq!(QUICK_SLOTS + BACKPACK_SLOTS, INVENTORY_SLOTS);
    assert_eq!(QUICK_SLOTS, 8, "§C10 names the quick bar's size");
    assert_eq!(BACKPACK_SLOTS, 16, "§C10 names the backpack's size");
}
