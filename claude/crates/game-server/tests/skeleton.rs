//! M0 integration tests: the process starts, answers `/healthz`, and the socket.io
//! transport round-trips. Everything runs on an ephemeral port so the suite is safe
//! to run in parallel with a dev server.

use std::net::SocketAddr;
use std::sync::mpsc;
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

/// The one that matters: a real socket.io client completes the handshake and gets
/// its payload back. If this passes, the transport works end to end.
/// A **multi-thread** runtime, unlike the other tests here, and that is load-bearing.
///
/// `#[tokio::test]` gives a current-thread runtime, so the spawned axum server
/// shares one thread with the test future. A socket.io handshake is several round
/// trips, and when `cargo test --workspace` runs game-core's minute-long map
/// generation tests on every core, that single thread is starved long enough for
/// the handshake to time out. The test then fails for reasons that have nothing to
/// do with the transport. Giving the server real workers fixes it at the cause; a
/// bigger timeout only hides it and teaches people to re-run the gate.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn socket_io_echo_round_trips() {
    use rust_socketio::{ClientBuilder, Payload, RawClient};

    let addr = spawn_server().await;
    let url = format!("http://{addr}");

    let (tx, rx) = mpsc::channel::<serde_json::Value>();

    // rust_socketio 0.6 is blocking, so the whole client lives on a blocking thread.
    let handle = tokio::task::spawn_blocking(move || {
        let callback = move |payload: Payload, _: RawClient| {
            let v = match payload {
                Payload::Text(values) => values.first().cloned().unwrap_or(serde_json::Value::Null),
                #[allow(deprecated)]
                Payload::String(s) => {
                    serde_json::from_str(&s).unwrap_or(serde_json::Value::String(s))
                }
                Payload::Binary(_) => serde_json::Value::Null,
            };
            let _ = tx.send(v);
        };

        let client = ClientBuilder::new(url)
            .namespace("/")
            .on("echo_back", callback)
            .connect()
            .expect("socket.io connect");

        client
            .emit("echo", serde_json::json!({ "n": 42 }))
            .expect("emit echo");

        let received = rx
            // Generous, because this bounds a hang rather than asserting latency.
            .recv_timeout(Duration::from_secs(10))
            .expect("echo_back within 10 s");

        let _ = client.disconnect();
        received
    });

    let received = handle.await.expect("client thread");
    assert_eq!(
        received["n"], 42,
        "echo_back must carry the same payload, got {received}"
    );
}

#[test]
fn default_config_matches_the_documented_defaults() {
    // Guards against a default drifting without the docs following.
    let c = Config::default();
    assert_eq!(c.bind_addr.to_string(), "0.0.0.0:3000");
    assert_eq!(c.max_players, 6);
    assert_eq!(c.min_players_to_start, 1);
    assert_eq!(c.round_seconds, 240.0);
}
