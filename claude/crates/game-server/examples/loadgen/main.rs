//! `loadgen` — the exploratory load driver (T20.14).
//!
//! Many simulated clients, several matches at once, driven through the **real**
//! server path: one `AppState`, one axum listener, one socket per client, and
//! every join, leave, vote and refresh over the wire the shipping client uses.
//! `tests/rooms.rs` already proved that shape is cheaper and more honest than
//! thirty Chromium instances; this is that shape at scale.
//!
//! ```sh
//! cargo run -p game-server --example loadgen                        # the soak
//! cargo run -p game-server --example loadgen -- --scenario race     # T19.21
//! cargo run -p game-server --example loadgen -- --scenario rejoin   # T20.22
//! cargo run -p game-server --example loadgen -- --scenario ghost    # T20.23
//! cargo run -p game-server --example loadgen -- --plant seat-leak   # a control
//! cargo run -p game-server --example loadgen -- --help
//! ```
//!
//! Exit status is 0 when nothing was found, or — with `--plant` — when the
//! plant **was** found. Findings go to stdout with the numbers behind them.
//!
//! ## Be hardest on the instrument
//!
//! Three checks here carry a control that can declare the check void, and two of
//! them have done so: `disclosure` refuses to claim anything when a lobby seat
//! also received items, and `ghost`'s control arm caught the two arms sharing a
//! room. Each `--plant` is verified against *its own* footprint — the room it
//! touched, the client it silenced — because the soak finds things unplanted and
//! "some finding exists" would have passed for a plant that never fired.
//!
//! **Not in `check.sh`, on purpose.** It is an *example* target, so
//! `cargo test --workspace` builds it and never runs it and `cargo clippy
//! --all-targets` keeps it compiling. A 32-room run has no place in a gate that
//! must stay fast; a driver that stops compiling has no place anywhere. It is an
//! example rather than an `#[ignore]`d test for two reasons: `rust_socketio` is
//! a dev-dependency so a `src/bin` cannot see it, and `scripts/ignored.sh` is a
//! manifest of things that must **pass**, which a bug-hunting driver must not
//! promise.
//!
//! ## Determinism, and its limit
//!
//! Each client's *action sequence* comes from `splitmix64(seed ^ index)`, so
//! `--seed K` replays the same script, and `fixed_seed` pins the maps. What is
//! **not** deterministic is the interleaving — the races this hunts exist only
//! because the interleaving is real. `--scenario` is the answer to that: each
//! scenario drives one mechanism directly and is near-deterministic.
//!
//! ## What it does not simulate
//!
//! No browser: a rendering bug, a scene that never starts, or a client-side
//! state leak between rounds — the `GameScene` half of T20.13 — is invisible
//! here by construction. No packet loss, latency or reordering; loopback only.
//! `input` frames carry noise, so this loads the plumbing, not the simulation.
//! No bots (`bot_count: 0`), because the both-ends count is over names and a bot
//! puts a name in a roster that no client owns. And clients share a process with
//! the server, so a starved client thread and a slow server look alike.
//!
//! **One gap worth naming, because the task asked about it and this does not
//! answer it.** `SessionMap::insert` evicts by `*p != player && *s != sid`, so a
//! recycled `PlayerId` from `Seats::free` silently drops the previous holder's
//! socket mapping (T20.01's second knock-on). Nothing here asserts that an
//! already-seated client *keeps* receiving events, so that eviction would show
//! up only as broadcasts that stop arriving — and no check counts those. The
//! per-client timeline has the data; a check over it does not exist yet.

use std::collections::{BTreeMap, HashMap, HashSet};
use std::net::SocketAddr;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use game_core::constants::{MapScale, MAX_PLAYERS, MAX_ROOMS};
use game_server::registry::RoomId;
use game_server::{app, config::Config, state::AppState};
use serde_json::{json, Value};

// The fixture `tests/` already shares (T20.18), by path rather than by copy:
// `open`'s wait for the namespace handshake is the thing every socket.io caller
// in this repository has had to learn the hard way (`docs/70` §A28).
#[path = "../../tests/common/mod.rs"]
mod common;

/// The four scenarios. Split out because one file carrying the harness *and*
/// every scenario ran to 1500 lines, and `CLAUDE.md` asks that a file heading
/// well past ~250 be split rather than finished.
mod scenarios;

use scenarios::{ghost, race, rejoin, soak};

const EVENTS: &[&str] = &[
    "welcome",
    "join_error",
    "lobby_error",
    "room_created",
    "room_left",
    "lobby_state",
    "round_state",
    "map_init",
    "item_spawn",
    "crate_spawn",
    "player_join",
    "player_leave",
];

/// One received event, **in arrival order**.
///
/// The shared `Inbox` buckets by name, which loses the order — and the whole
/// T19.21 question is what arrived between a `welcome` and the next thing.
struct Rec {
    ms: u64,
    ev: String,
    v: Value,
}

type Log = Arc<Mutex<Vec<Rec>>>;

struct Client {
    idx: usize,
    name: String,
    log: Log,
    /// Join verbs this client actually put on the wire — the other end of
    /// "welcome + join_error", so a dropped verb is a difference between two
    /// counters rather than an absence nobody counted.
    verbs: AtomicUsize,
}

impl Client {
    fn new(idx: usize, name: String) -> Arc<Client> {
        Arc::new(Client {
            idx,
            name,
            log: Arc::default(),
            verbs: AtomicUsize::new(0),
        })
    }
}

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
enum Plant {
    None,
    /// A socket attached to a room it was never seated in — what a verb
    /// returning early after `ctx.attach` leaves behind. Moves the exact value
    /// the check reads (`RoomEntry::humans`).
    SeatLeak,
    /// A room nothing can empty, so `reap` can never take it.
    RoomLeak,
    /// One client that emits nothing. The purest form of the failure this task
    /// names: a load test reporting "no failures" while quietly failing to
    /// drive its clients.
    DeafClient,
}

/// What the plant actually did, so the verdict can look for **that** rather
/// than for "some finding exists".
///
/// **The weak version of this shipped first and is the reason the strong one is
/// here.** `--plant seat-leak` reported "control ok" on a soak whose findings it
/// had contributed nothing to: the soak finds things unplanted, so
/// `!findings.is_empty()` would have passed for a plant that did nothing at all
/// — a control satisfied by the thing it exists to rule out.
#[derive(Default, Debug)]
struct Mark {
    /// The room the plant touched, and what it expects to be said about it.
    room: Option<RoomId>,
    /// The client the plant silenced.
    client: Option<String>,
}

type Marker = Arc<Mutex<Mark>>;

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
enum Scenario {
    Soak,
    /// One socket, two join verbs — the retry the server documents as safe.
    Rejoin,
    /// Joiners fanned across a public lobby's `lobby_bot_timeout` and the map
    /// generation that follows it. T19.21's window, driven directly.
    Race,
    /// A socket that drops during the join handshake, which is what a page
    /// refresh at the wrong moment is.
    Ghost,
}

struct Args {
    clients: usize,
    seconds: u64,
    seed: u64,
    plant: Plant,
    scenario: Scenario,
    verbose: bool,
}

const USAGE: &str = "\
loadgen — the exploratory load driver (T20.14)

  --clients N     simulated clients                (soak 48, race 12, rejoin 1)
  --seconds S     how long the soak runs           (default 45)
  --seed K        the scenario seed and map seed   (default 4242)
  --scenario S    soak | rejoin | race | ghost     (default soak)
  --plant P       none | seat-leak | room-leak | deaf-client
  --verbose       print every room at every sample

Exit 0 means no finding (or, with --plant, that the plant was detected).
";

fn parse_args() -> Args {
    let mut a = Args {
        clients: 0,
        seconds: 45,
        seed: 4242,
        plant: Plant::None,
        scenario: Scenario::Soak,
        verbose: false,
    };
    let argv: Vec<String> = std::env::args().skip(1).collect();
    let bail = |m: String| -> ! {
        eprintln!("{m}\n\n{USAGE}");
        std::process::exit(2)
    };
    let mut i = 0;
    while i < argv.len() {
        let val = argv.get(i + 1).cloned().unwrap_or_default();
        match argv[i].as_str() {
            "--clients" => {
                a.clients = val.parse().unwrap_or(0);
                i += 1;
            }
            "--seconds" => {
                a.seconds = val.parse().unwrap_or(a.seconds);
                i += 1;
            }
            "--seed" => {
                a.seed = val.parse().unwrap_or(a.seed);
                i += 1;
            }
            "--plant" => {
                a.plant = match val.as_str() {
                    "none" => Plant::None,
                    "seat-leak" => Plant::SeatLeak,
                    "room-leak" => Plant::RoomLeak,
                    "deaf-client" => Plant::DeafClient,
                    o => bail(format!("unknown plant: {o}")),
                };
                i += 1;
            }
            "--scenario" => {
                a.scenario = match val.as_str() {
                    "soak" => Scenario::Soak,
                    "rejoin" => Scenario::Rejoin,
                    "race" => Scenario::Race,
                    "ghost" => Scenario::Ghost,
                    o => bail(format!("unknown scenario: {o}")),
                };
                i += 1;
            }
            "--verbose" => a.verbose = true,
            "-h" | "--help" => {
                println!("{USAGE}");
                std::process::exit(0);
            }
            o => bail(format!("unknown option: {o}")),
        }
        i += 1;
    }
    if a.clients == 0 {
        a.clients = match a.scenario {
            Scenario::Soak => 48,
            Scenario::Rejoin => 1,
            Scenario::Race => 12,
            Scenario::Ghost => 4,
        };
    }
    a
}

/// `splitmix64` — the construction `registry.rs` already uses for its seeded
/// choices, for the same reason: a driver whose scenario cannot be replayed
/// describes a failure instead of reproducing it.
struct Rng(u64);

impl Rng {
    fn next(&mut self) -> u64 {
        self.0 = self.0.wrapping_add(0x9E37_79B9_7F4A_7C15);
        let mut z = self.0;
        z = (z ^ (z >> 30)).wrapping_mul(0xBF58_476D_1CE4_E5B9);
        z = (z ^ (z >> 27)).wrapping_mul(0x94D0_49BB_1331_11EB);
        z ^ (z >> 31)
    }
    fn below(&mut self, n: u64) -> u64 {
        self.next() % n
    }
}

// ---------------------------------------------------------------------------
// A simulated client
// ---------------------------------------------------------------------------

fn connect(addr: SocketAddr, log: &Log, t0: Instant) -> rust_socketio::client::Client {
    let mut b = common::builder(addr);
    for ev in EVENTS {
        let (log, name) = (log.clone(), (*ev).to_string());
        b = b.on(
            *ev,
            move |p: rust_socketio::Payload, _: rust_socketio::RawClient| {
                let v = common::text_of(p);
                // `map_init` is a base64 map. Keep its size, drop its body, or a
                // driver holding 32 maps x 48 clients measures its allocator.
                let v = match &v {
                    Value::String(s) if s.len() > 64 => json!({ "len": s.len() }),
                    _ => v,
                };
                if let Ok(mut g) = log.lock() {
                    g.push(Rec {
                        ms: t0.elapsed().as_millis() as u64,
                        ev: name.clone(),
                        v,
                    });
                }
            },
        );
    }
    common::open(b)
}

/// Emit, and do not die if it is refused.
///
/// Not `common::emit_when_ready`, which panics: a driver whose client dies on a
/// refused emit loses every observation that client would have made. A dropped
/// emit surfaces as a verb with no answer, which is the measurement.
fn emit(c: &rust_socketio::client::Client, ev: &str, payload: Value) {
    let _ = c.emit(ev, payload);
}

fn terminals(log: &Log) -> usize {
    log.lock()
        .map(|g| {
            g.iter()
                .filter(|r| r.ev == "welcome" || r.ev == "join_error")
                .count()
        })
        .unwrap_or(0)
}

fn wait_terminal(log: &Log, before: usize, budget: Duration) -> bool {
    let until = Instant::now() + budget;
    while Instant::now() < until {
        if terminals(log) > before {
            return true;
        }
        std::thread::sleep(Duration::from_millis(15));
    }
    false
}

fn last_was_welcome(log: &Log) -> bool {
    log.lock()
        .map(|g| {
            g.iter()
                .rev()
                .find(|r| r.ev == "welcome" || r.ev == "join_error")
                .map(|r| r.ev == "welcome")
                .unwrap_or(false)
        })
        .unwrap_or(false)
}

fn harvest_codes(log: &Log, codes: &Arc<Mutex<Vec<String>>>) {
    let found: Vec<String> = log
        .lock()
        .map(|g| {
            g.iter()
                .filter(|r| r.ev == "room_created")
                .filter_map(|r| r.v.get("code").and_then(|c| c.as_str()).map(String::from))
                .collect()
        })
        .unwrap_or_default();
    if let Ok(mut g) = codes.lock() {
        for c in found {
            if !g.contains(&c) {
                g.push(c);
            }
        }
    }
}

fn noise(rng: &mut Rng) -> String {
    const A: &[u8] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    (0..12).map(|_| A[rng.below(64) as usize] as char).collect()
}

fn nap(d: Duration, deadline: Instant) {
    std::thread::sleep(d.min(deadline.saturating_duration_since(Instant::now())));
}

#[derive(PartialEq, Eq, Clone, Copy)]
enum Where {
    Outside,
    Seated,
}

// ---------------------------------------------------------------------------
// The server side of every count
// ---------------------------------------------------------------------------

/// room -> (humans the registry counts, names the room task seats, private)
type Detail = BTreeMap<RoomId, (usize, Vec<String>, bool)>;

async fn sample(stack: &app::Stack) -> Detail {
    let snapshot: Vec<(RoomId, usize, bool, game_server::room::RoomHandle)> = {
        let r = match stack.registry.lock() {
            Ok(r) => r,
            Err(p) => p.into_inner(),
        };
        r.ids()
            .iter()
            .filter_map(|id| {
                r.get(*id)
                    .map(|e| (*id, e.humans(), e.private, e.handle.clone()))
            })
            .collect()
    };
    let mut detail = Detail::new();
    for (id, humans, private, handle) in snapshot {
        // A room task parked in `spawn_blocking(blueprint)` cannot answer for up
        // to 1.1 s, and that is not a fault. Bound the wait rather than hanging
        // the probe inside the very window this driver exists to sit in.
        let names = match tokio::time::timeout(Duration::from_secs(3), handle.roster()).await {
            Ok(Some(rows)) => rows.into_iter().map(|r| r.1).collect(),
            _ => Vec::new(),
        };
        detail.insert(id, (humans, names, private));
    }
    detail
}

fn dump(label: &str, d: &Detail) {
    for (id, (h, names, private)) in d {
        println!("  {label} room {id}: humans={h} private={private} roster={names:?}");
    }
}

/// Every place the registry's human count and the room task's seat list
/// disagree, and every name seated in more than one room at once.
fn accounting(d: &Detail, out: &mut Vec<String>) {
    let mut name_rooms: HashMap<&str, Vec<RoomId>> = HashMap::new();
    for (id, (humans, names, _)) in d {
        for n in names {
            name_rooms.entry(n.as_str()).or_default().push(*id);
        }
        if *humans != names.len() {
            out.push(format!(
                "seat accounting: room {id} — the registry counts {humans} humans and the room \
                 task seats {} ({names:?})",
                names.len()
            ));
        }
    }
    let mut two: Vec<(&str, &Vec<RoomId>)> = name_rooms
        .iter()
        .filter(|(_, r)| r.len() > 1)
        .map(|(n, r)| (*n, r))
        .collect();
    two.sort();
    for (n, rooms) in two {
        let mut distinct = rooms.clone();
        distinct.sort_unstable();
        distinct.dedup();
        if distinct.len() < rooms.len() {
            out.push(format!(
                "one player, two seats: {n} holds {} seats across rooms {distinct:?}, \
                 including more than one in the same room",
                rooms.len()
            ));
        } else {
            out.push(format!(
                "one player, two seats: {n} holds a seat in each of rooms {distinct:?}"
            ));
        }
    }
}

// ---------------------------------------------------------------------------
// Reading a client's timeline
// ---------------------------------------------------------------------------

/// How many `item_spawn` events carrying `item_id` land in the first
/// [`TRAILER`] events after a `welcome`.
///
/// **This is a window on a sequence, and it only means anything next to a
/// control** — which is why nothing here is a time threshold. `session.rs::seat`
/// emits its catch-up synchronously (`welcome`, `round_state`, `map_init`, then
/// one `item_spawn` per world item), so a seat that landed in a lobby has
/// nothing to disclose.
///
/// **The window is not sound everywhere, and [`disclosure`] says so rather than
/// claiming anyway.** In `--scenario race` the lobby arm reads 0 over 7 seats
/// while the live-world arm reads 19–25, three runs out of three. In the soak it
/// can be dirtied: a lobby seat whose room starts within the next eight events
/// takes the match-start `map_init` and its item broadcast inside the window,
/// and the reading is then not evidence of anything. `disclosure` checks the
/// control first and reports *that* instead of a finding.
///
/// Two earlier cuts of this were wrong and are worth recording. "Any
/// `item_spawn` before the first `map_init`" never fired, because a client
/// seated a heartbeat before a match starts takes the match-start `map_init`
/// broadcast first. "Walk forward while the event is `round_state` or
/// `map_init`" also read zero, because a `lobby_state` broadcast interleaves
/// between the `map_init` and the items — visible in the trailer this now
/// prints beside the count.
const TRAILER: usize = 8;

fn disclosed_items(log: &[Rec], at_ms: u64) -> u64 {
    let Some(i) = log.iter().position(|r| r.ev == "welcome" && r.ms == at_ms) else {
        return 0;
    };
    log[i + 1..]
        .iter()
        .take(TRAILER)
        .filter(|r| r.ev == "item_spawn" && r.v.get("item_id").is_some())
        .count() as u64
}

/// The events that followed a `welcome`, by name, so a phase field is never the
/// only evidence for what a client was told.
///
/// A correct lobby seat is `welcome, round_state` and then whatever the lobby
/// broadcasts. A seat against a live world adds `session.rs::seat`'s catch-up:
/// `map_init`, then `item_spawn`/`tombstone_spawn`, then `inventory`.
fn trailer(log: &[Rec], at_ms: u64, n: usize) -> Vec<String> {
    let Some(i) = log.iter().position(|r| r.ev == "welcome" && r.ms == at_ms) else {
        return Vec::new();
    };
    log[i + 1..].iter().take(n).map(|r| r.ev.clone()).collect()
}

#[derive(Default)]
struct Totals {
    welcomes: usize,
    verbs: usize,
    errors: BTreeMap<String, usize>,
    phases: BTreeMap<String, usize>,
    events: BTreeMap<String, usize>,
    seated_once: HashSet<usize>,
    /// (client, ms, phase) for every `welcome` that was not a lobby.
    non_lobby: Vec<(String, u64, String)>,
    /// (client, ms, items disclosed in the trailer, welcome.phase) for **every**
    /// welcome — the lobby-phase rows are the control for the rest.
    catchup: Vec<(String, u64, u64, String)>,
}

fn tally(clients: &[Arc<Client>]) -> Totals {
    let mut t = Totals::default();
    for c in clients {
        t.verbs += c.verbs.load(Ordering::Relaxed);
        let g = match c.log.lock() {
            Ok(g) => g,
            Err(p) => p.into_inner(),
        };
        for r in g.iter() {
            *t.events.entry(r.ev.clone()).or_default() += 1;
            match r.ev.as_str() {
                "welcome" => {
                    t.welcomes += 1;
                    t.seated_once.insert(c.idx);
                    let ph =
                        r.v.get("phase")
                            .and_then(|p| p.as_str())
                            .unwrap_or("<missing>")
                            .to_string();
                    if ph != "lobby" {
                        t.non_lobby.push((c.name.clone(), r.ms, ph.clone()));
                    }
                    *t.phases.entry(ph).or_default() += 1;
                }
                "join_error" => {
                    let reason =
                        r.v.get("reason")
                            .and_then(|x| x.as_str())
                            .unwrap_or("<none>")
                            .to_string();
                    *t.errors.entry(reason).or_default() += 1;
                }
                _ => {}
            }
        }
        // Every welcome, with what its trailer disclosed — the lobby ones are
        // the control for the others.
        for r in g.iter().filter(|r| r.ev == "welcome") {
            let ph =
                r.v.get("phase")
                    .and_then(|p| p.as_str())
                    .unwrap_or("<missing>")
                    .to_string();
            t.catchup
                .push((c.name.clone(), r.ms, disclosed_items(&g, r.ms), ph));
        }
    }
    t
}

/// The catch-up disclosure, reported **against its control**: how many world
/// items the trailer of a lobby-phase welcome carried, versus a live-world one.
///
/// A count on its own is a number; the pair is the evidence. If the lobby arm is
/// non-zero the instrument is wrong, and that is said instead of a finding.
fn disclosure(t: &Totals, fs: &mut Vec<String>, ns: &mut Vec<String>) {
    let sum = |lobby: bool| -> (usize, u64) {
        let rows = t
            .catchup
            .iter()
            .filter(|(_, _, _, ph)| (ph == "lobby") == lobby);
        (rows.clone().count(), rows.map(|(_, _, n, _)| *n).sum())
    };
    let (n_lobby, items_lobby) = sum(true);
    let (n_live, items_live) = sum(false);
    ns.push(format!(
        "world items disclosed in the {TRAILER} events after a welcome: \
         {items_lobby} over {n_lobby} lobby seat(s) [the control], \
         {items_live} over {n_live} live-world seat(s)"
    ));
    if items_lobby > 0 {
        fs.push(format!(
            "the disclosure control is dirty: {items_lobby} item(s) reached a lobby seat, so a \
             non-zero reading on a live-world seat proves nothing"
        ));
        return;
    }
    for (name, ms, n, ph) in &t.catchup {
        if *n > 0 {
            fs.push(format!(
                "catch-up disclosed {n} world item(s) to {name} at t={ms}ms (phase={ph}) while \
                 every lobby seat in this run was told none — `item_spawn` carries `item_id` \
                 where `crate_spawn` withholds it (T19.21)"
            ));
        }
    }
}

fn summarise(t: &Totals, notes: &mut Vec<String>) {
    notes.push(format!(
        "{} join verbs, {} welcome, {} join_error {:?}",
        t.verbs,
        t.welcomes,
        t.errors.values().sum::<usize>(),
        t.errors
    ));
    notes.push(format!("welcome.phase {:?}", t.phases));
}

// ---------------------------------------------------------------------------

/// The substring a finding must carry for this plant to count as detected.
///
/// Each one names the *specific* thing the plant did — the room it touched, the
/// client it silenced — so a finding about anything else cannot satisfy it.
fn expected_of(p: Plant, mark: &Marker) -> Vec<String> {
    let m = match mark.lock() {
        Ok(m) => (m.room, m.client.clone()),
        Err(e) => {
            let g = e.into_inner();
            (g.room, g.client.clone())
        }
    };
    match p {
        Plant::None => Vec::new(),
        Plant::SeatLeak => {
            m.0.map(|id| vec![format!("seat accounting: room {id} ")])
                .unwrap_or_default()
        }
        Plant::RoomLeak => {
            m.0.map(|id| vec![format!("room {id} humans=")])
                .unwrap_or_default()
        }
        Plant::DeafClient => {
            m.1.map(|n| vec![format!("never received a welcome"), n])
                .unwrap_or_default()
        }
    }
}

#[tokio::main(flavor = "multi_thread", worker_threads = 4)]
async fn main() {
    let args = parse_args();
    let t0 = Instant::now();

    let cfg = Config {
        map_scale: MapScale::Small,
        fixed_seed: Some(args.seed),
        record_replay: false,
        bot_count: 0,
        bots_enabled: false,
        ..Config::default()
    };
    common::assert_seed_is_stated(&cfg);
    let (ttl, lobby_timeout, max_players) =
        (cfg.room_empty_ttl, cfg.lobby_bot_timeout, cfg.max_players);

    let state = AppState::new(cfg);
    let metrics = state.metrics();
    let stack = app::build_stack(state);
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
        .await
        .expect("bind ephemeral port");
    let addr = listener.local_addr().expect("local addr");
    let router = stack.router.clone();
    tokio::spawn(async move {
        let _ = axum::serve(listener, router).await;
    });

    println!(
        "loadgen {:?}: {} clients, seed {}, plant {:?}, addr {addr}",
        args.scenario, args.clients, args.seed, args.plant
    );
    println!(
        "  MAX_ROOMS={MAX_ROOMS} MAX_PLAYERS={MAX_PLAYERS} max_players={max_players} \
         lobby_bot_timeout={lobby_timeout}s room_empty_ttl={ttl}s"
    );

    let mut fs: Vec<String> = Vec::new();
    let mut ns: Vec<String> = Vec::new();
    let mark: Marker = Arc::default();

    match args.scenario {
        Scenario::Soak => {
            soak(
                &args, &stack, addr, t0, ttl, &metrics, &mark, &mut fs, &mut ns,
            )
            .await
        }
        Scenario::Rejoin => rejoin(&args, &stack, addr, t0, max_players, &mut fs, &mut ns).await,
        Scenario::Race => race(&args, &stack, addr, t0, lobby_timeout, &mut fs, &mut ns).await,
        Scenario::Ghost => ghost(&args, &stack, addr, t0, ttl, &mut fs, &mut ns).await,
    }

    println!("\n--- notes ---");
    for n in &ns {
        println!("  {n}");
    }
    println!("\n--- findings ---");
    if fs.is_empty() {
        println!("  none");
    }
    // Deduplicated by class: one race hit forty times is one finding with a
    // count, and forty identical lines hide the second finding under them.
    // Classed by the first few words, not by everything before a colon: the
    // disclosure lines put the colon after a client name, so that key made every
    // one of them its own class and the summary became the list again.
    let class_of = |f: &str| -> String {
        f.split_whitespace()
            .take(4)
            .collect::<Vec<_>>()
            .join(" ")
            .trim_end_matches(':')
            .to_string()
    };
    let mut classes: BTreeMap<String, usize> = BTreeMap::new();
    for f in &fs {
        *classes.entry(class_of(f)).or_default() += 1;
    }
    let mut shown: HashMap<String, usize> = HashMap::new();
    for f in &fs {
        let k = class_of(f);
        let n = shown.entry(k).or_default();
        *n += 1;
        if *n <= 2 {
            println!("  {f}");
        } else if *n == 3 {
            println!("  ... more of the same class");
        }
    }
    println!("\n  classes: {classes:?}");

    // A plant that is not detected is the failure this exits on: an instrument
    // that cannot catch a known fault says nothing when it is quiet.
    //
    // **Verified against the plant's own footprint, not against "some finding
    // exists".** The soak finds things unplanted, so the loose test would have
    // reported "control ok" for a plant that never fired.
    let clean = fs.is_empty();
    let code = match args.plant {
        Plant::None => {
            println!(
                "\nverdict: {}",
                if clean { "clean" } else { "FINDINGS (above)" }
            );
            i32::from(!clean)
        }
        p => {
            let m = match mark.lock() {
                Ok(m) => format!("{m:?}"),
                Err(e) => format!("{:?}", e.into_inner()),
            };
            let want = expected_of(p, &mark);
            // **`all`, not `any`.** `deaf-client` expects two substrings — the
            // sentence and the client's name — and with `any` every finding that
            // merely mentioned that client satisfied the control.
            let hit = !want.is_empty() && fs.iter().any(|f| want.iter().all(|w| f.contains(w)));
            if want.is_empty() {
                println!(
                    "\nverdict: CONTROL FAILED — plant {p:?} never fired, so this run says \
                     nothing about whether the check can catch it"
                );
                1
            } else if hit {
                println!(
                    "\nverdict: control ok — plant {p:?} ({m}) was named by a finding \
                          matching {want:?}"
                );
                0
            } else {
                println!(
                    "\nverdict: CONTROL FAILED — plant {p:?} ({m}) produced no finding matching \
                     {want:?}; the {} finding(s) above are all about something else",
                    fs.len()
                );
                1
            }
        }
    };
    std::process::exit(code);
}
