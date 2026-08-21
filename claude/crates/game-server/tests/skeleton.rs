//! The process starts and answers `/healthz`. Everything runs on an ephemeral port
//! so the suite is safe to run alongside a dev server.
//!
//! The M0 echo round-trip lived here and is gone: T6.03 replaced the echo handler
//! with the real join flow, and the transport is now proven by `tests/join.rs`
//! doing something the game actually needs.

use std::net::SocketAddr;
use std::time::Duration;

use game_server::{app, config::Config, state::AppState};

/// Start the real router on an ephemeral port. Returns the bound address; the
/// server task is detached and dies with the test process.
async fn spawn_server() -> SocketAddr {
    let state = AppState::new(Config::default());
    let (router, _io) = app::build(state);
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
        .await
        .expect("bind ephemeral port");
    let addr = listener.local_addr().expect("local addr");
    tokio::spawn(async move {
        let _ = axum::serve(listener, router).await;
    });
    // Give the accept loop a moment to be polled at least once.
    tokio::time::sleep(Duration::from_millis(50)).await;
    addr
}

#[tokio::test]
async fn healthz_returns_ok_with_the_documented_keys() {
    let addr = spawn_server().await;
    let url = format!("http://{addr}/healthz");

    let resp = reqwest::get(&url).await.expect("GET /healthz");
    assert_eq!(resp.status(), 200);

    let body: serde_json::Value = resp.json().await.expect("json body");
    assert_eq!(body["status"], "ok");
    for key in ["status", "uptime_s", "rooms", "players"] {
        assert!(body.get(key).is_some(), "missing key `{key}` in {body}");
    }
    assert_eq!(body["rooms"], 0);
    assert_eq!(body["players"], 0);
}

#[tokio::test]
async fn unknown_routes_are_404_not_a_panic() {
    let addr = spawn_server().await;
    let resp = reqwest::get(format!("http://{addr}/nope"))
        .await
        .expect("GET /nope");
    assert_eq!(resp.status(), 404);
}

#[test]
fn default_config_matches_the_documented_defaults() {
    // Guards against a default drifting without the docs following.
    //
    // These pin to the **constants**, not to literals. `min_players_to_start`
    // was a literal `1` and §C18 changed it to 2 (a room now waits for a second
    // human rather than starting a battle nobody asked for); a literal turns a
    // deliberate spec change into a mystery failure in an unrelated file, and
    // CLAUDE.md's "never hardcode a tunable in a test" exists for exactly this.
    let c = Config::default();
    assert_eq!(c.bind_addr.to_string(), "0.0.0.0:3000");
    assert_eq!(c.max_players, game_core::constants::MAX_PLAYERS);
    assert_eq!(
        c.min_players_to_start,
        game_core::constants::MIN_PLAYERS_TO_START
    );
    assert_eq!(c.round_seconds, game_core::constants::ROUND_SECONDS);
}
