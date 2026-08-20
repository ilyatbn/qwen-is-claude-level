//! What does a room actually cost? (`docs/71-amendments-v3.md` §B2)
//!
//! `MAX_ROOMS` was 8 because 8 is a plausible-looking number. §B2 is explicit
//! that it must not stay a guess: a room over budget does not merely run slow,
//! because `MissedTickBehavior::Burst` catches the deficit up in a spike, which
//! is worse than a steady lag.
//!
//! ## What is measured
//!
//! A **full** room, not an idle one: `MAX_PLAYERS` seats filled by bots that
//! fire, weather scheduled, and terrain that has been under fire long enough for
//! the mask to be genuinely chewed up. Anything less measures a room that does
//! not exist in a real round — the mistake §A38 caught, where a 400 ms ceiling
//! written for the chunk bake was being applied to a total that had grown two
//! extra passes since.
//!
//! ## Why there is a load control
//!
//! §A38's other conclusion was that "the bake got slower" was really "the box
//! was busy", proven by a control run under deliberate load where even pure-WASM
//! work with no canvas and no GPU slowed by the same proportion. A tick-time
//! number from a machine also running a build is not a number about the code, so
//! every row here records the load it was taken under, and the suite refuses to
//! draw a conclusion from a run whose control moved.
//!
//! Run it:
//!
//! ```sh
//! cargo test -p game-server --release --test capacity -- --ignored --nocapture
//! ```

use std::time::Instant;

use game_core::bots::Bot;
use game_core::constants::{MapScale, MAX_PLAYERS, SIM_DT, SIM_HZ};
use game_core::player::input::button;
use game_core::world::World;

/// Half of one tick at `SIM_HZ`. §B2 sets the threshold here rather than at the
/// full budget precisely because of the burst catch-up.
fn half_budget_ms() -> f64 {
    1000.0 / SIM_HZ as f64 / 2.0
}

/// A room as it exists in a real round, not an empty one.
///
/// Built directly on `World` rather than through the server, because the
/// question is what the *simulation* costs per tick. The socket layer's cost is
/// a separate measurement and would drown this one in scheduler noise.
struct Room {
    world: World,
    bots: Vec<Bot>,
}

fn full_room(seed: u64, scale: MapScale) -> Room {
    let mut world = World::new(seed, scale);
    let mut bots = Vec::new();
    for i in 0..MAX_PLAYERS {
        let id = i as u8;
        world.add_player(id, 0, format!("p{i}"));
        bots.push(Bot::new(id, seed, i as u32, 0.85));
    }
    Room { world, bots }
}

impl Room {
    /// One tick, exactly as `room.rs::drive_bots` plus `World::step` does it.
    ///
    /// The first version of this file added six players and stepped the world,
    /// which measured six figures standing still: p50 and p99 both rounded to
    /// **0.000 ms** with a max of 11 µs. That is not a room, and §B2 asks for a
    /// full one — bots that fire, weather scheduled, terrain under fire. A
    /// measurement of the idle case would have justified any `MAX_ROOMS` at all.
    fn tick(&mut self) {
        let now = self.world.round_time;
        let mut inputs = Vec::with_capacity(self.bots.len());
        let mut fires = Vec::new();
        let mut uses = Vec::new();
        for bot in &mut self.bots {
            let input = bot.think(&self.world, now, SIM_DT);
            if let Some(slot) = bot.wants_use() {
                uses.push((bot.player, slot));
            }
            if input.buttons & button::FIRE != 0 {
                fires.push(bot.player);
            }
            inputs.push((bot.player, input));
        }
        for (id, input) in inputs {
            self.world.queue_input(id, input);
        }
        for (id, slot) in uses {
            let _ = self.world.use_item(id, slot, now);
        }
        for id in fires {
            let _ = self.world.fire(id, now);
        }
        self.world.step(SIM_DT);
        self.world.drain_events();
    }
}

/// Chew the terrain up and get the round properly under way.
///
/// A pristine mask is the cheapest one to collide against — every coarse cell is
/// uniformly full or empty, so `aabb_overlaps_solid` resolves without touching a
/// bit. Late-round terrain is the expensive case and the one players spend most
/// of a round in.
fn warm_up(r: &mut Room, seconds: f32) {
    let ticks = (seconds / SIM_DT) as u32;
    for _ in 0..ticks {
        r.tick();
    }
}

struct Sample {
    p50_ms: f64,
    p99_ms: f64,
    max_ms: f64,
}

fn percentiles(mut v: Vec<f64>) -> Sample {
    v.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
    let at = |q: f64| v[((v.len() as f64 - 1.0) * q).round() as usize];
    Sample {
        p50_ms: at(0.50),
        p99_ms: at(0.99),
        max_ms: *v.last().unwrap_or(&0.0),
    }
}

/// Tick `rooms` worlds round-robin, as the process actually would, and time each
/// individual `World::step`.
fn measure(rooms: usize, ticks: u32, scale: MapScale) -> Sample {
    let mut rs: Vec<Room> = (0..rooms)
        .map(|i| {
            let mut r = full_room(1000 + i as u64, scale);
            // Past EFFECT_INTERVAL_MIN, so weather is scheduled and the terrain
            // has been under fire for long enough to be genuinely chewed up.
            warm_up(&mut r, 45.0);
            r
        })
        .collect();

    let mut times = Vec::with_capacity(ticks as usize * rooms);
    for _ in 0..ticks {
        for r in rs.iter_mut() {
            let t = Instant::now();
            r.tick();
            times.push(t.elapsed().as_secs_f64() * 1000.0);
        }
    }
    percentiles(times)
}

/// The control: pure arithmetic with no allocation, no I/O and no game state.
///
/// If this moves between runs, the machine changed and the tick numbers taken
/// alongside it are not comparable. It is the same instrument §A38 used to prove
/// the bake had not regressed.
fn control_ms() -> f64 {
    let t = Instant::now();
    let mut acc = 0u64;
    for i in 0..40_000_000u64 {
        acc = acc.wrapping_add(i ^ (acc >> 7)).wrapping_mul(2_654_435_761);
    }
    std::hint::black_box(acc);
    t.elapsed().as_secs_f64() * 1000.0
}

#[test]
#[ignore = "measurement: minutes, and meaningless on a loaded machine"]
fn how_many_rooms_fit() {
    let scale = MapScale::Medium;
    let ticks = 600; // 10 s of simulation per room

    println!("\n=== T10.07: what a room costs ===");
    println!(
        "machine: {} logical cores, {} build, scale {:?}, {} bots/room, {} ticks/room",
        std::thread::available_parallelism()
            .map(|n| n.get())
            .unwrap_or(0),
        if cfg!(debug_assertions) {
            "debug"
        } else {
            "release"
        },
        scale,
        MAX_PLAYERS,
        ticks
    );

    let baseline = control_ms();
    println!("control (idle):        {baseline:.0} ms");

    let half = half_budget_ms();
    println!("\n rooms |    p50 |    p99 |    max | p99 vs half-budget ({half:.2} ms)");
    println!("-------|--------|--------|--------|--------------------");

    let mut viable = 0usize;
    let mut rows = Vec::new();
    // Rough resident cost per room: the mask is 1 bit per pixel and the coarse
    // grid 1 byte per 8x8 cell (`docs/10` §1). Reported because tick time turned
    // out not to be what bounds this, and something has to.
    let (w, h) = match scale {
        MapScale::Small => (2048u64, 1024u64),
        MapScale::Medium => (3072, 1536),
        MapScale::Large => (4096, 2048),
    };
    let mask_kb = (w * h / 8) / 1024;
    let coarse_kb = (w * h / 64) / 1024;
    println!("per-room terrain: mask {mask_kb} KiB + coarse {coarse_kb} KiB");
    for rooms in [1usize, 2, 4, 8, 16, 32, 64, 128] {
        let s = measure(rooms, ticks, scale);
        let ok = s.p99_ms <= half;
        if ok {
            viable = rooms;
        }
        println!(
            "  {rooms:4} | {:6.3} | {:6.3} | {:6.3} | {}",
            s.p50_ms,
            s.p99_ms,
            s.max_ms,
            if ok { "ok" } else { "OVER" }
        );
        rows.push((rooms, s.p99_ms));
    }

    let after = control_ms();
    println!("control (after):       {after:.0} ms");
    let drift = (after - baseline).abs() / baseline.max(1.0);
    println!("control drift:         {:.1} %", drift * 100.0);

    // §A38: a tick time measured while the box was busy is not a number about
    // the code. If the control moved, say so rather than reporting a capacity.
    assert!(
        drift < 0.25,
        "the machine's load changed by {:.0} % during the run, so these numbers \
         are about the box and not about a room. Re-run on an idle machine.",
        drift * 100.0
    );

    println!("\nlargest room count measured with p99 inside half the tick budget: {viable}");
    if let Some((n, p99)) = rows.last() {
        println!(
            "at {n} rooms the p99 is {p99:.3} ms, using {:.2} % of half a tick budget",
            p99 / half * 100.0
        );
    }
    println!(
        "MAX_ROOMS is currently {}\n",
        game_core::constants::MAX_ROOMS
    );

    // The measurement's own sanity: a room must at least fit once.
    assert!(
        viable >= 1,
        "a single room does not fit inside half a tick budget on this machine"
    );
}

/// The cheap, always-on half: one full room must fit in a tick, comfortably.
///
/// `docs/60` §6 budgets 2 ms for 6 players and 20 projectiles. This is the same
/// claim with the rest of a real round attached — weather, items, late-round
/// terrain — and it runs in the normal suite so a regression is caught without
/// anyone remembering to run the ignored benchmark.
#[test]
fn one_full_room_fits_in_a_tick() {
    let mut r = full_room(4242, MapScale::Medium);
    warm_up(&mut r, 10.0);

    let mut times = Vec::with_capacity(300);
    for _ in 0..300 {
        let t = Instant::now();
        r.tick();
        times.push(t.elapsed().as_secs_f64() * 1000.0);
    }
    let s = percentiles(times);

    // Deliberately generous: this runs in debug in the default gate, where
    // everything is several times slower than the release build a server uses.
    // A ceiling that catches a 50x regression and not normal variance is what
    // `docs/60` §6 asks for.
    let ceiling = if cfg!(debug_assertions) { 60.0 } else { 4.0 };
    assert!(
        s.p99_ms < ceiling,
        "a full room's p99 tick is {:.2} ms against a {ceiling} ms ceiling (p50 {:.2}, max {:.2})",
        s.p99_ms,
        s.p50_ms,
        s.max_ms
    );

    // The control: the measurement must actually be measuring something. A
    // world that never advanced would report near-zero and pass the ceiling.
    assert!(
        r.world.tick > 300,
        "the world did not advance: tick {}",
        r.world.tick
    );
    assert!(
        s.p50_ms > 0.0,
        "every tick measured as zero — the clock or the step is not real"
    );
}

/// Rooms must not get more expensive per room as more of them exist.
///
/// They share nothing (`docs/41` §1), so eight rooms should cost eight times one
/// room and no more. A super-linear result would mean something is shared that
/// should not be — the exact thing a registry makes easy to get wrong.
#[test]
#[ignore = "measurement: minutes"]
fn rooms_do_not_get_more_expensive_as_more_are_added() {
    let one = measure(1, 300, MapScale::Small);
    let eight = measure(8, 300, MapScale::Small);
    println!(
        "\nper-room p50: 1 room {:.3} ms, 8 rooms {:.3} ms ({:.2}x)",
        one.p50_ms,
        eight.p50_ms,
        eight.p50_ms / one.p50_ms.max(1e-9)
    );
    assert!(
        eight.p50_ms < one.p50_ms * 3.0,
        "eight rooms cost {:.2}x per room versus one — something is shared",
        eight.p50_ms / one.p50_ms.max(1e-9)
    );
}

/// `MAX_ROOMS` must be justified by the measurement, not by taste.
///
/// This does not re-run the benchmark — it pins the *claim* the constant's doc
/// comment makes, so changing the number without re-measuring is visible in the
/// diff.
#[test]
fn max_rooms_carries_its_basis() {
    let src = include_str!("../../game-core/src/constants.rs");
    let i = src
        .find("pub const MAX_ROOMS")
        .expect("MAX_ROOMS must exist");
    let doc_start = src[..i].rfind("\n\n").unwrap_or(0);
    let doc = &src[doc_start..i];
    // Deliberately checks for *numbers*, not for a mention of the task. The
    // first version accepted "T10.07" — which the placeholder "Provisional
    // until T10.07 measures it" already contained, so it passed against exactly
    // the state it exists to reject.
    let has_timing = doc.contains("ms");
    let has_percentile = doc.contains("p99");
    let has_machine = doc.contains("core");
    assert!(
        has_timing && has_percentile && has_machine,
        "MAX_ROOMS must record the measurement behind it — a p99 in ms and the \
         machine it was taken on (§B2). Doc comment was:\n{doc}"
    );
}
