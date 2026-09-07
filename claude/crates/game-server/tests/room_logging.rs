//! `docs/61-logging-debug.md` §2: every line logged inside the room loop carries
//! `room` and `tick`, set once per tick by a span rather than by remembering.
//!
//! This lives in its own test binary on purpose. Observing the **real** task's
//! spans needs `set_global_default`, which can only be called once per process —
//! and a thread-local `with_default` does not reach a `tokio::spawn`ed task on
//! another worker thread, so a test using one silently observes nothing and
//! passes for the wrong reason.

use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use game_server::config::Config;
use game_server::room::spawn_room;
use socketioxide::SocketIo;
use tokio::sync::oneshot;
use tracing_subscriber::layer::SubscriberExt;

mod common;

#[derive(Default)]
struct Captured {
    fields: Mutex<Vec<(String, String)>>,
    spans: AtomicUsize,
}

struct Capture(Arc<Captured>);

impl<S> tracing_subscriber::Layer<S> for Capture
where
    S: tracing::Subscriber + for<'a> tracing_subscriber::registry::LookupSpan<'a>,
{
    fn on_new_span(
        &self,
        attrs: &tracing::span::Attributes<'_>,
        _id: &tracing::Id,
        _ctx: tracing_subscriber::layer::Context<'_, S>,
    ) {
        if attrs.metadata().name() != "room" {
            return;
        }
        struct V(Arc<Captured>);
        impl tracing::field::Visit for V {
            fn record_debug(&mut self, f: &tracing::field::Field, v: &dyn std::fmt::Debug) {
                self.0
                    .fields
                    .lock()
                    .expect("poisoned")
                    .push((f.name().to_string(), format!("{v:?}")));
            }
        }
        attrs.record(&mut V(self.0.clone()));
        self.0.spans.fetch_add(1, Ordering::Relaxed);
    }
}

/// Small, not the shipped Large default: see the note in `tests/room.rs`.
fn test_config() -> Config {
    common::test_config()
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn every_tick_span_carries_room_and_tick() {
    let cap = Arc::new(Captured::default());
    let sub = tracing_subscriber::registry().with(Capture(cap.clone()));
    tracing::subscriber::set_global_default(sub).expect("only test in this binary");

    let (_layer, io) = SocketIo::new_layer();
    let (_tx, rx) = oneshot::channel();
    let handle = spawn_room(io, Arc::new(test_config()), rx);

    // Wait for the room to be live before measuring: a fixed sleep would time the
    // startup rather than the tick loop.
    //
    // §E1: this read `inspect(|w| w.tick)`, which answers `None` for a room that
    // is a **lobby** — and this one never starts a match, so `unwrap_or(0)` read
    // 0 forever. The loop burned its full 10 s waiting on a condition that could
    // not become true, and `ticks` below was therefore always 0: the failure
    // message has read "over 0 ticks" ever since. The `spans > 3` assertion is on
    // a different quantity and still discriminated, so it passed correctly while
    // its own diagnostic lied — which is `f1d2d2a`'s finding, recurring.
    //
    // The lobby's clock is the right witness and needs no match: it advances as
    // soon as the room task is running, which is exactly what "live" means here.
    for _ in 0..200 {
        if handle.join_info().await.map(|i| i.tick).unwrap_or(0) > 0 {
            break;
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    let before = handle.join_info().await.map(|i| i.tick).unwrap_or(0);
    assert!(
        before > 0,
        "the room never started ticking, so the span count below measures nothing"
    );
    cap.fields.lock().expect("poisoned").clear();
    cap.spans.store(0, Ordering::Relaxed);

    tokio::time::sleep(Duration::from_millis(250)).await;
    let ticks = handle
        .join_info()
        .await
        .map(|i| i.tick)
        .unwrap_or(0)
        .saturating_sub(before);

    let spans = cap.spans.load(Ordering::Relaxed);
    assert!(
        spans > 3,
        "expected a span per tick, saw {spans} over {ticks} ticks"
    );

    let fields = cap.fields.lock().expect("poisoned");
    let names: Vec<&str> = fields.iter().map(|(k, _)| k.as_str()).collect();
    assert!(names.contains(&"room"), "no `room` field: {names:?}");
    assert!(names.contains(&"tick"), "no `tick` field: {names:?}");

    // And `tick` is live rather than a constant someone hard-coded.
    let ticks: Vec<&String> = fields
        .iter()
        .filter(|(k, _)| k == "tick")
        .map(|(_, v)| v)
        .collect();
    assert!(ticks.len() > 3);
    assert_ne!(
        ticks.first(),
        ticks.last(),
        "tick never advanced across spans: {ticks:?}"
    );
}

/// **The seed is stated, not inherited** (T20.18/T20.20).
#[test]
fn the_fixture_states_its_seed() {
    common::assert_seed_is_stated(&test_config());
}
