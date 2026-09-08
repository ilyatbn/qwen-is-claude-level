//! The four scenarios `loadgen` can run.
//!
//! Each drives one mechanism and reports against a control of its own; the
//! harness they share — the simulated client, the registry probe, the
//! both-ends accounting and the report — lives in `main.rs`.
//!
//! Private items in the crate root are visible to this module, so nothing here
//! needs a wider visibility than the binary already has.

use std::net::SocketAddr;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use game_core::constants::{MapScale, MAX_ROOMS};
use game_server::app;
use game_server::registry::RoomId;
use serde_json::{json, Value};

use crate::{
    accounting, connect, disclosure, dump, emit, harvest_codes, last_was_welcome, nap, noise,
    sample, summarise, tally, terminals, trailer, wait_terminal, Args, Client, Detail, Marker,
    Plant, Rng, Where,
};

/// The soak script: join, host, hop, vote, refresh, idle. Weighted, not uniform
/// — a population that leaves as often as it joins never lets a match start.
fn soak_client(
    addr: SocketAddr,
    c: Arc<Client>,
    seed: u64,
    deadline: Instant,
    codes: Arc<Mutex<Vec<String>>>,
    deaf: bool,
    t0: Instant,
) {
    let mut rng = Rng(seed ^ (c.idx as u64).wrapping_mul(0x2545_F491_4F6C_DD1D));
    let mut sock = connect(addr, &c.log, t0);
    let mut state = Where::Outside;

    while Instant::now() < deadline {
        if deaf {
            nap(Duration::from_millis(200), deadline);
            continue;
        }
        match state {
            Where::Outside => {
                let before = terminals(&c.log);
                let roll = rng.below(100);
                c.verbs.fetch_add(1, Ordering::Relaxed);
                if roll < 60 {
                    emit(&sock, "quick_match", json!({ "name": c.name }));
                } else if roll < 80 {
                    emit(
                        &sock,
                        "create_room",
                        json!({ "name": c.name, "private": true }),
                    );
                } else {
                    // A code somebody else minted, or a wrong one — both happen:
                    // players mistype codes and rooms are reaped under them.
                    let code = codes
                        .lock()
                        .ok()
                        .and_then(|g| {
                            (!g.is_empty()).then(|| g[rng.below(g.len() as u64) as usize].clone())
                        })
                        .unwrap_or_else(|| "ZZZZZZ".to_string());
                    emit(&sock, "join_room", json!({ "name": c.name, "code": code }));
                }
                if wait_terminal(&c.log, before, Duration::from_secs(5)) && last_was_welcome(&c.log)
                {
                    harvest_codes(&c.log, &codes);
                    state = Where::Seated;
                }
                nap(Duration::from_millis(80 + rng.below(220)), deadline);
            }
            Where::Seated => {
                let roll = rng.below(100);
                if roll < 34 {
                    // Idle. The T20.01 shape: sit in a lobby and touch nothing.
                    nap(Duration::from_millis(400 + rng.below(900)), deadline);
                } else if roll < 50 {
                    emit(&sock, "ready", json!({ "ready": true }));
                } else if roll < 62 {
                    emit(&sock, "start_with_bots", json!({}));
                } else if roll < 74 {
                    emit(&sock, "input", Value::String(noise(&mut rng)));
                } else if roll < 82 {
                    emit(&sock, "vote_restart", json!({ "restart": true }));
                } else if roll < 92 {
                    // Exit to title, then quick-match again — the T20.13 shape.
                    emit(&sock, "leave_room", json!({}));
                    std::thread::sleep(Duration::from_millis(80));
                    state = Where::Outside;
                } else {
                    // Refresh.
                    sock.disconnect().ok();
                    std::thread::sleep(Duration::from_millis(120));
                    sock = connect(addr, &c.log, t0);
                    state = Where::Outside;
                }
                nap(Duration::from_millis(60 + rng.below(240)), deadline);
            }
        }
    }
    sock.disconnect().ok();
}
// ---------------------------------------------------------------------------
// Scenario: soak
// ---------------------------------------------------------------------------

#[allow(clippy::too_many_arguments)]
pub async fn soak(
    args: &Args,
    stack: &app::Stack,
    addr: SocketAddr,
    t0: Instant,
    ttl: f32,
    metrics: &Arc<game_server::metrics::Metrics>,
    mark: &Marker,
    fs: &mut Vec<String>,
    ns: &mut Vec<String>,
) {
    let codes: Arc<Mutex<Vec<String>>> = Arc::default();
    // Under `sanitise_name`'s 16-char cap and unique, so a name is a usable key
    // into a roster.
    let clients: Vec<Arc<Client>> = (0..args.clients)
        .map(|i| Client::new(i, format!("L{i:03}")))
        .collect();
    let deadline = Instant::now() + Duration::from_secs(args.seconds);

    let peak = Arc::new(AtomicUsize::new(0));
    let taken = Arc::new(AtomicUsize::new(0));
    let sampler = {
        let (peak, taken, reg) = (peak.clone(), taken.clone(), stack.registry.clone());
        tokio::spawn(async move {
            while Instant::now() < deadline {
                let live = match reg.lock() {
                    Ok(r) => r.len(),
                    Err(p) => p.into_inner().len(),
                };
                peak.fetch_max(live, Ordering::Relaxed);
                taken.fetch_add(1, Ordering::Relaxed);
                tokio::time::sleep(Duration::from_millis(250)).await;
            }
        })
    };

    if args.plant == Plant::DeafClient {
        if let Ok(mut m) = mark.lock() {
            m.client = clients.first().map(|c| c.name.clone());
        }
    }
    if matches!(args.plant, Plant::SeatLeak | Plant::RoomLeak) {
        let (reg, io, plant, mark) = (
            stack.registry.clone(),
            stack.io.clone(),
            args.plant,
            mark.clone(),
        );
        tokio::spawn(async move {
            // Late enough that rooms exist.
            tokio::time::sleep(Duration::from_secs(4)).await;
            // **A synthetic `Sid`, not a live client's.**
            //
            // The first cut borrowed a real socket's id, and the strengthened
            // verdict caught it: the client it belonged to kept playing, and its
            // next join verb called `ctx.attach`, whose implicit detach undid
            // the plant. A leak that heals itself is not a control. This id
            // belongs to no socket, so nothing will ever detach it — which is
            // exactly the shape of the defect being modelled.
            let _ = &io;
            let sid = socketioxide::socket::Sid::new();
            let mut r = match reg.lock() {
                Ok(r) => r,
                Err(p) => p.into_inner(),
            };
            let planted = if plant == Plant::SeatLeak {
                // A stray socket attached to a room it was never seated in —
                // what a verb returning early after `ctx.attach` leaves behind.
                //
                // **On a room of its own, and that is not fastidiousness.** The
                // first version attached to `ids().last()`, a room real clients
                // were using, and the control failed on about one run in three:
                // the soak's own seat-orphan defect drifts `humans` *down* while
                // this drifts it *up*, and one counter cannot show both — the
                // two cancelled and the accounting check saw nothing to report.
                // A control that a second live defect can silence gates nothing.
                // Private, so `quick_match` can never seat anyone here (§E3),
                // and no code is ever handed out.
                r.create(MapScale::Small, true).ok().map(|(id, _)| {
                    r.attach(sid, id);
                    eprintln!("PLANT seat-leak: a stray socket attached to fresh room {id}");
                    id
                })
            } else {
                r.create(MapScale::Small, false).ok().map(|(id, _)| {
                    r.attach(sid, id);
                    eprintln!("PLANT room-leak: room {id} holds a socket that never leaves");
                    id
                })
            };
            if let Ok(mut m) = mark.lock() {
                m.room = planted;
            }
        });
    }

    let mut handles = Vec::new();
    for c in &clients {
        let (c, codes, seed) = (c.clone(), codes.clone(), args.seed);
        let deaf = args.plant == Plant::DeafClient && c.idx == 0;
        handles.push(tokio::task::spawn_blocking(move || {
            soak_client(addr, c, seed, deadline, codes, deaf, t0);
        }));
        // Staggered, or every handshake lands on one tick and the run measures
        // the thundering herd instead of the game.
        tokio::time::sleep(Duration::from_millis(20)).await;
    }

    tokio::time::sleep(deadline.saturating_duration_since(Instant::now()) / 2).await;
    let mid = sample(stack).await;

    for h in handles {
        let _ = h.await;
    }
    let _ = sampler.await;
    // `on_disconnect` is an async handler; reading before it runs measures the
    // probe rather than the server.
    tokio::time::sleep(Duration::from_secs(2)).await;
    let after = sample(stack).await;

    let t = tally(&clients);
    let elapsed = t0.elapsed().as_secs_f32();

    // ---- every client played, and every verb was answered.
    if t.welcomes == 0 {
        fs.push("no client was ever seated: the driver measured nothing".into());
    }
    let never: Vec<&str> = clients
        .iter()
        .filter(|c| !t.seated_once.contains(&c.idx))
        .map(|c| c.name.as_str())
        .collect();
    if !never.is_empty() {
        fs.push(format!(
            "clients that never received a welcome: {} of {} ({never:?}) — a run that reports \
             nothing about them is not a clean run",
            never.len(),
            clients.len()
        ));
    }
    let answered = t.welcomes + t.errors.values().sum::<usize>();
    if answered < t.verbs {
        fs.push(format!(
            "unanswered join verbs: {} of {} went out and {answered} came back",
            t.verbs - answered,
            t.verbs
        ));
    }

    // ---- §E4, at both of its observables.
    for (name, ms, ph) in &t.non_lobby {
        fs.push(format!(
            "seated against a live world: {name} welcome.phase={ph} at t={ms}ms (§E4, and the \
             catch-up's own comment, say a seat can only land in a lobby)"
        ));
    }
    disclosure(&t, fs, ns);

    accounting(&after, fs);

    // ---- nothing outlives the run.
    let held: Vec<String> = after
        .iter()
        .filter(|(_, (h, names, _))| *h > 0 || !names.is_empty())
        .map(|(id, (h, names, _))| format!("room {id} humans={h} roster={names:?}"))
        .collect();
    if !held.is_empty() {
        fs.push(format!(
            "orphaned seats: every client has disconnected and {} room(s) still hold one: \
             {held:?}",
            held.len()
        ));
    }
    let (freed, left) = {
        let mut r = match stack.registry.lock() {
            Ok(r) => r,
            Err(p) => p.into_inner(),
        };
        let n = r.reap(Instant::now() + Duration::from_secs_f32(ttl + 1.0));
        (n.len(), r.len())
    };
    if left != 0 {
        fs.push(format!(
            "room leak: {left} room(s) survive a reap past the {ttl}s TTL, so nothing can ever \
             free them"
        ));
    }

    // ---- the cap.
    let peak = peak.load(Ordering::Relaxed);
    if peak > MAX_ROOMS {
        fs.push(format!(
            "cap: {peak} rooms live at once, over MAX_ROOMS={MAX_ROOMS}"
        ));
    }
    let full = t.errors.get("server_full").copied().unwrap_or(0);
    if full > 0 && peak < MAX_ROOMS {
        fs.push(format!(
            "cap: {full} `server_full` refusals while the peak was {peak}/{MAX_ROOMS}"
        ));
    }

    ns.push(format!("{elapsed:.1}s, {} clients", clients.len()));
    summarise(&t, ns);
    ns.push(format!(
        "rooms: peak {peak}/{MAX_ROOMS} over {} samples; {} mid-run, {} at the end; reap freed \
         {freed}, {left} left",
        taken.load(Ordering::Relaxed),
        mid.len(),
        after.len()
    ));
    ns.push(format!(
        "throughput {:.1} join verbs/s, {:.0} events/s; events {:?}",
        t.verbs as f32 / elapsed,
        t.events.values().sum::<usize>() as f32 / elapsed,
        t.events
    ));
    // **Now a trailing window, so it is comparable between runs** (T20.25 fixed
    // it). It used to be `max` over the room's whole life with nothing resetting
    // or decaying it, which climbed with the number of samples taken and made
    // this line meaningless across runs of different lengths — the reading this
    // scenario originally could not use. It now covers the last `RING` ticks or
    // so, the same span as `tick_p99_ms`.
    //
    // Still a *worst*, not a rate: it answers "did any room come near the budget
    // recently". `capacity.rs::rooms_do_not_get_more_expensive_as_more_are_added`
    // is what answers whether per-room cost grows with the room count, and it is
    // `#[ignore]`d — run it through `scripts/ignored.sh`.
    //
    // **Read after the reap above, which is now a problem** (T20.25). Dropping a
    // room calls `metrics::forget_room`, so once T20.22 and T20.23 made these
    // rooms actually reapable this line started reading an empty map and
    // printing `0.00 ms, 0 over` — indistinguishable from a server that was
    // healthy. It read 6.90-8.69 ms when it was written because the leaks kept
    // the rooms alive. Sample it before the reap, or say "no rooms" distinctly.
    let (worst_ms, over) = metrics.room_health();
    ns.push(format!(
        "worst room tick {worst_ms:.2} ms of a {:.2} ms budget in the trailing window; \
         {over} room(s) over half it",
        1000.0 / f64::from(game_core::constants::SIM_HZ)
    ));
    if args.verbose {
        dump("mid", &mid);
        dump("after", &after);
    }
}

// ---------------------------------------------------------------------------
// Scenario: rejoin — one socket, three rooms
// ---------------------------------------------------------------------------

/// One client, three phases, and **the first phase is the control.**
///
/// *Phase 1, the control:* `quick_match` twice on one socket. The server
/// documents this as safe — *"a second join on one socket is ignored, not a
/// second player: a client that retries must not consume two seats"* — and
/// `tests/rooms.rs::emit_until` depends on it. It must report nothing; if it
/// reports something, nothing below can be believed.
///
/// *Phase 2, the subject:* `create_room` from that same seated socket, which is
/// what a player does who leaves a lobby by hosting rather than by pressing
/// Exit. It mints a **different** room, so `ctx.attach` moves the socket — and
/// `RoomRegistry::detach_from` is the only leave path that does not send
/// `Command::Leave` to the room it is leaving.
///
/// *Phase 3, the bill:* hop out of that private room too, then send
/// `max_players` fresh players in by its code. A private lobby never gets a
/// countdown (§E3), so nothing can start under the measurement — which is what
/// went wrong the first time this was written against a public room: the
/// countdown fired mid-probe and `quick_match` minted a second room, and the
/// check read that as the ghost's doing.
///
/// One client throughout phases 1–3, so there is no interleaving to blame.
#[allow(clippy::too_many_arguments)]
pub async fn rejoin(
    args: &Args,
    stack: &app::Stack,
    addr: SocketAddr,
    t0: Instant,
    max_players: usize,
    fs: &mut Vec<String>,
    ns: &mut Vec<String>,
) {
    let c = Client::new(0, "R000".into());

    // Phases 1-3 on one socket, so the socket is never re-handshaken between
    // them and every hop is a hop rather than a fresh arrival.
    let name = c.name.clone();
    let (c2, log) = (c.clone(), c.log.clone());
    let sock = tokio::task::spawn_blocking(move || {
        let sock = connect(addr, &log, t0);
        let go = |ev: &str, payload: Value| {
            let before = terminals(&log);
            emit(&sock, ev, payload);
            c2.verbs.fetch_add(1, Ordering::Relaxed);
            wait_terminal(&log, before, Duration::from_secs(5));
            std::thread::sleep(Duration::from_millis(300));
        };
        go("quick_match", json!({ "name": name }));
        go("quick_match", json!({ "name": name }));
        sock
    })
    .await
    .expect("client thread");

    let retried = sample(stack).await;
    let mut control: Vec<String> = Vec::new();
    accounting(&retried, &mut control);
    if !control.is_empty() {
        fs.push(format!(
            "the control itself is dirty: a plain retry on one socket already reports \
             {control:?}, so nothing this scenario says about a hop can be believed"
        ));
    }

    // Phase 2 and 3: host a private room, then hop out of it too.
    let (c2, log, name) = (c.clone(), c.log.clone(), c.name.clone());
    let sock = tokio::task::spawn_blocking(move || {
        let go = |ev: &str, payload: Value| {
            let before = terminals(&log);
            emit(&sock, ev, payload);
            c2.verbs.fetch_add(1, Ordering::Relaxed);
            wait_terminal(&log, before, Duration::from_secs(5));
            std::thread::sleep(Duration::from_millis(400));
        };
        go("create_room", json!({ "name": name, "private": true }));
        go("quick_match", json!({ "name": name }));
        sock
    })
    .await
    .expect("client thread");

    let hopped = sample(stack).await;
    accounting(&hopped, fs);

    // ---- what the orphan costs, measured rather than reasoned.
    //
    // A name in a roster is a curiosity; a seat a live player cannot have is the
    // bill. `max_players` fresh players go in by the code of the private room
    // the hopper abandoned. If its seat came back, all of them fit.  Pinned to
    // `max_players`, so this cannot pass against a retuned capacity.
    let codes: Arc<Mutex<Vec<String>>> = Arc::default();
    harvest_codes(&c.log, &codes);
    let code = codes
        .lock()
        .ok()
        .and_then(|g| g.first().cloned())
        .unwrap_or_default();
    let ghost_room: Vec<RoomId> = hopped
        .iter()
        .filter(|(_, (_, names, private))| *private && names.iter().any(|n| n == &c.name))
        .map(|(id, _)| *id)
        .collect();

    // Without a code the probes all get `unknown_code` and the capacity check
    // silently measures nothing — the shape of failure this whole file is about.
    if code.is_empty() || ghost_room.is_empty() {
        fs.push(format!(
            "the capacity probe could not run: code {code:?}, abandoned private room \
             {ghost_room:?} — this run says nothing about what the orphan costs"
        ));
    }
    let probes: Vec<Arc<Client>> = (0..max_players)
        .map(|i| Client::new(10 + i, format!("P{i:03}")))
        .collect();
    let mut socks = Vec::new();
    for p in &probes {
        let (p, log, code) = (p.clone(), p.log.clone(), code.clone());
        socks.push(
            tokio::task::spawn_blocking(move || {
                let s = connect(addr, &log, t0);
                emit(&s, "join_room", json!({ "name": p.name, "code": code }));
                p.verbs.fetch_add(1, Ordering::Relaxed);
                wait_terminal(&log, 0, Duration::from_secs(5));
                s
            })
            .await
            .expect("probe thread"),
        );
    }
    let pt = tally(&probes);
    let after_probe = sample(stack).await;
    let refused_full = pt.errors.get("full").copied().unwrap_or(0);
    if refused_full > 0 {
        fs.push(format!(
            "capacity: {refused_full} of {max_players} fresh players were refused `full` from \
             private room {ghost_room:?}, whose only other occupant left it — the orphaned seat \
             is charged against max_players={max_players}"
        ));
    }
    ns.push(format!(
        "capacity probe: {max_players} `join_room {code}` -> {} seated, {} refused {:?}",
        pt.welcomes,
        pt.errors.values().sum::<usize>(),
        pt.errors
    ));

    // Disconnect everything: the only thing that frees a seat.
    let mut all = socks;
    all.push(sock);
    for s in all {
        let _ = tokio::task::spawn_blocking(move || {
            s.disconnect().ok();
        })
        .await;
    }
    tokio::time::sleep(Duration::from_secs(2)).await;
    let gone = sample(stack).await;
    let orphans: Vec<String> = gone
        .iter()
        .filter(|(_, (h, names, _))| *h > 0 || !names.is_empty())
        .map(|(id, (h, names, _))| format!("room {id} humans={h} roster={names:?}"))
        .collect();
    if !orphans.is_empty() {
        // Deliberately not "the room leaks": `humans` did reach zero, so the TTL
        // will take it. What survives is the *seat*, for the room's whole life.
        fs.push(format!(
            "orphaned seats: every client has disconnected and {orphans:?} remain — seats held \
             by nobody, for the rest of those rooms' lives"
        ));
    }

    summarise(&tally(std::slice::from_ref(&c)), ns);
    ns.push(format!("{} room(s) exist at the end", gone.len()));
    let _ = args;
    dump("after the retry (control)", &retried);
    dump("after the two hops", &hopped);
    dump("after the capacity probe", &after_probe);
    dump("after disconnect", &gone);
}

// ---------------------------------------------------------------------------
// Scenario: race — T19.21's window, driven directly
// ---------------------------------------------------------------------------

/// A public lobby's `lobby_bot_timeout` fires the start on a known tick, and the
/// map generator then parks the room task for 0.3–1.1 s. Joiners fanned across
/// that boundary straddle the window on purpose.
///
/// **The controls are the two arms.** A joiner landing before the countdown ends
/// must be told `welcome.phase=lobby`; one landing after `install_world` must be
/// refused `in_progress`. A run producing only one of those is not straddling
/// anything, and this says so rather than reporting a rate.
pub async fn race(
    args: &Args,
    stack: &app::Stack,
    addr: SocketAddr,
    t0: Instant,
    lobby_timeout: f32,
    fs: &mut Vec<String>,
    ns: &mut Vec<String>,
) {
    // The host takes one seat in a public lobby, which starts its countdown.
    let host = Client::new(0, "HOST".into());
    let (h2, hlog) = (host.clone(), host.log.clone());
    let hostsock = tokio::task::spawn_blocking(move || {
        let s = connect(addr, &hlog, t0);
        emit(&s, "quick_match", json!({ "name": h2.name }));
        h2.verbs.fetch_add(1, Ordering::Relaxed);
        wait_terminal(&hlog, 0, Duration::from_secs(5));
        s
    })
    .await
    .expect("host thread");
    let countdown = Instant::now();

    // Fanned across [timeout - 1 s, timeout + 2 s]: wide enough that the early
    // ones are the `lobby` control and the late ones the `in_progress` one, and
    // pinned to the config value rather than to a literal.
    const SPAN_MS: u64 = 3_000;
    const LEAD: Duration = Duration::from_secs(1);
    let first = Duration::from_secs_f32(lobby_timeout).saturating_sub(LEAD);
    let step = SPAN_MS / args.clients.max(1) as u64;

    let joiners: Vec<Arc<Client>> = (0..args.clients)
        .map(|i| Client::new(i + 1, format!("J{i:03}")))
        .collect();
    let mut handles = Vec::new();
    for (i, j) in joiners.iter().enumerate() {
        let at = countdown + first + Duration::from_millis(step * i as u64);
        let (j, log) = (j.clone(), j.log.clone());
        handles.push(tokio::task::spawn_blocking(move || {
            // Connect first: the handshake is milliseconds but it is not free,
            // and a joiner that spends the window connecting never enters it.
            let s = connect(addr, &log, t0);
            let now = Instant::now();
            if at > now {
                std::thread::sleep(at - now);
            }
            emit(&s, "quick_match", json!({ "name": j.name }));
            j.verbs.fetch_add(1, Ordering::Relaxed);
            wait_terminal(&log, 0, Duration::from_secs(6));
            std::thread::sleep(Duration::from_millis(400));
            s.disconnect().ok();
        }));
    }
    for h in handles {
        let _ = h.await;
    }

    let t = tally(&joiners);
    let refused = t.errors.get("in_progress").copied().unwrap_or(0);
    let in_lobby = t.phases.get("lobby").copied().unwrap_or(0);
    let end = sample(stack).await;

    // **First: did every joiner get an answer at all?**
    //
    // This check exists because the scenario printed `verdict: clean` on a box
    // at load average 13 where five of twelve joiners were never answered — a
    // run that measured almost nothing, reported as a run that found nothing.
    // Exactly the shape this task's notes name.
    let answered = t.welcomes + t.errors.values().sum::<usize>();
    if answered < joiners.len() {
        fs.push(format!(
            "the run measured nothing about {} of {} joiners: they emitted `quick_match` and \
             received neither `welcome` nor `join_error` inside the wait. Re-run on an idle \
             box; a verdict from this run is not a verdict about the server",
            joiners.len() - answered,
            joiners.len()
        ));
    }

    // **Then: did the fan straddle the boundary?**
    //
    // The control is the `lobby` arm, and it is *not* the `in_progress` one: the
    // first cut required a refusal and would have called every run inconclusive,
    // because `quick_match` does not refuse a started room — it skips it and
    // mints another, so `in_progress` is only ever reached by `join_room` with a
    // code.
    //
    // What proves the lobby stopped accepting *during* the fan is that a second
    // room exists at the end: the host's room is the only one that existed when
    // the fan began, and another can only appear once `quick_match` started
    // skipping it. A single room means every joiner landed before the start and
    // the run says nothing. (The earlier proxy — "at least one lobby seat after
    // the first" — was not a measurement of anything; it read the same on a run
    // where nothing started.)
    let rooms = end.len();
    if in_lobby == 0 || rooms < 2 {
        fs.push(format!(
            "the fan did not straddle the window: {in_lobby} seated in a lobby, {refused} \
             refused `in_progress`, {} seated against a live world, and {rooms} room(s) exist \
             at the end — the host's lobby never stopped accepting during the fan, so this \
             run proves nothing either way",
            t.non_lobby.len()
        ));
    }
    for (name, ms, ph) in &t.non_lobby {
        let tr = joiners
            .iter()
            .find(|j| &j.name == name)
            .map(|j| match j.log.lock() {
                Ok(g) => trailer(&g, *ms, 8),
                Err(p) => trailer(&p.into_inner(), *ms, 8),
            })
            .unwrap_or_default();
        fs.push(format!(
            "seated against a live world: {name} welcome.phase={ph} at t={ms}ms, then {tr:?} — \
             the §E4 guard is a bare atomic read taken outside the room task, so it is not \
             serialised with `install_world`"
        ));
    }
    disclosure(&t, fs, ns);

    ns.push(format!(
        "{} joiners fanned over {SPAN_MS} ms centred on lobby_bot_timeout={lobby_timeout}s",
        joiners.len()
    ));
    summarise(&t, ns);

    if args.verbose {
        dump("end", &end);
    }
    let _ = tokio::task::spawn_blocking(move || {
        hostsock.disconnect().ok();
    })
    .await;
}

// ---------------------------------------------------------------------------
// Scenario: ghost — a socket that drops during the join handshake
// ---------------------------------------------------------------------------

/// `session.rs`'s `on_disconnect` calls `ctx.detach` **inside**
/// `if let Some(id) = sessions.remove_sid(socket.id)`, and `seat` puts the
/// socket into that map only after `room.join(...).await` has come back from the
/// room task. So a socket that drops in between is attached to a room that has
/// no record of it, and nothing will ever decrement the room's `humans`.
///
/// A room whose `humans` never reaches zero never gets an `empty_since`, and
/// `reap` filters on exactly that. At `MAX_ROOMS` each such room is a permanent
/// subtraction from the server's capacity.
///
/// **The control is the second arm.** The same clients, doing the same join and
/// then disconnecting *after* the welcome, must leave nothing behind — without
/// it, "the ghosts leaked" is equally consistent with a server that leaks on
/// every disconnect.
///
/// **Both arms use `create_room`, so every client gets a room of its own.** The
/// first cut used `quick_match` and the two arms landed in the same lobby, so
/// the ghosts' leak was charged to the control's room and the scenario
/// correctly refused to conclude anything. Isolation is what makes the pair a
/// pair.
pub async fn ghost(
    args: &Args,
    stack: &app::Stack,
    addr: SocketAddr,
    t0: Instant,
    ttl: f32,
    fs: &mut Vec<String>,
    ns: &mut Vec<String>,
) {
    // `see_it_through == false` is the subject: drop without waiting for
    // `welcome`, which is what a refresh at the wrong moment is.
    async fn arm(
        addr: SocketAddr,
        t0: Instant,
        n: usize,
        prefix: char,
        see_it_through: bool,
    ) -> Vec<Arc<Client>> {
        let cs: Vec<Arc<Client>> = (0..n)
            .map(|i| Client::new(i, format!("{prefix}{i:03}")))
            .collect();
        for c in &cs {
            let (c, log) = (c.clone(), c.log.clone());
            tokio::task::spawn_blocking(move || {
                let s = connect(addr, &log, t0);
                emit(
                    &s,
                    "create_room",
                    json!({ "name": c.name, "private": true }),
                );
                c.verbs.fetch_add(1, Ordering::Relaxed);
                if see_it_through {
                    wait_terminal(&log, 0, Duration::from_secs(5));
                    std::thread::sleep(Duration::from_millis(200));
                }
                // `room.join` is a command round-trip through a task ticking at
                // SIM_HZ, so a drop taken straight after the emit lands inside
                // it.
                s.disconnect().ok();
            })
            .await
            .expect("ghost thread");
        }
        cs
    }

    let controls = arm(addr, t0, args.clients, 'H', true).await;
    tokio::time::sleep(Duration::from_secs(2)).await;
    let after_control = sample(stack).await;

    let ghosts = arm(addr, t0, args.clients, 'G', false).await;
    tokio::time::sleep(Duration::from_secs(2)).await;
    let end = sample(stack).await;

    // A room is "still held" when its human count has not returned to zero: that
    // is the exact field `reap` tests, so it is the exact field to count.
    let held = |d: &Detail| -> Vec<String> {
        d.iter()
            .filter(|(_, (h, _, _))| *h > 0)
            .map(|(id, (h, names, _))| format!("room {id} humans={h} roster={names:?}"))
            .collect::<Vec<_>>()
    };
    let control_held = held(&after_control);
    let end_held = held(&end);

    let (freed, left) = {
        let mut r = match stack.registry.lock() {
            Ok(r) => r,
            Err(p) => p.into_inner(),
        };
        let n = r.reap(Instant::now() + Duration::from_secs_f32(ttl + 1.0));
        (n.len(), r.len())
    };

    if !control_held.is_empty() {
        fs.push(format!(
            "the control is dirty: {} client(s) that saw their `welcome` before disconnecting \
             still left {control_held:?}, so the mid-handshake arm proves nothing",
            controls.len()
        ));
    } else if !end_held.is_empty() {
        fs.push(format!(
            "unreapable rooms: {} of {} sockets that dropped mid-handshake left a room counting \
             a human nobody can account for ({end_held:?}), while all {} that saw their \
             `welcome` first left theirs at zero — `on_disconnect` detaches only inside \
             `if let Some(id) = sessions.remove_sid(..)`, and `seat` inserts into that map only \
             after `room.join` returns",
            end_held.len(),
            ghosts.len(),
            controls.len()
        ));
    }
    if left != 0 {
        fs.push(format!(
            "room leak: {left} room(s) survive a reap past the {ttl}s TTL, so nothing can ever \
             free them; at MAX_ROOMS={MAX_ROOMS} each is permanent lost capacity"
        ));
    }

    ns.push(format!(
        "{} sockets saw their welcome before disconnecting (the control), then {} dropped \
         mid-handshake; every client hosted its own private room",
        controls.len(),
        ghosts.len()
    ));
    ns.push(format!(
        "reap past the TTL freed {freed} room(s), {left} left"
    ));
    summarise(&tally(&ghosts), ns);
    dump("after the control arm", &after_control);
    dump("after the mid-handshake drops", &end);
}
