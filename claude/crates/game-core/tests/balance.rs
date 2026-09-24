//! T11.09 — balance the arsenal by measurement (`docs/71-amendments-v3.md` §B7).
//!
//! Twenty weapons cannot be balanced by inspection, and §B7's table says so: it
//! is a starting point, not a result.
//!
//! **Two instruments, because one metric cannot answer both questions.**
//!
//! - **In the hand.** Every bot starts holding weapon X, on the same seeds at the
//!   same skill, with the ground swept of items every tick. Exposure is then
//!   identical for every weapon and the whole round's damage is X's, so no
//!   per-weapon attribution is needed on the damage event — which is just as
//!   well, because `GameEvent::Damage` does not carry a weapon. Answers *is this
//!   weapon worth holding*.
//! - **In the pool.** Natural rounds, joining `ItemSpawn` → `ItemPickup` on
//!   `world_item_id` to count pickups per item. Answers *does it ever reach a
//!   hand*. The task's own warning is the reason this is separate: a weapon that
//!   spawns rarely shows few kills for reasons that have nothing to do with
//!   balance.
//!
//! Both aggregate across seeds. §B17 caught a population claim made from one
//! draw, and this file is nothing but population claims — measured over eight
//! seeds, damage per round was `191/0/644/0/401/31/210/0`, so a single seed
//! reports either a massacre or a stalemate with equal confidence.

use std::collections::BTreeMap;

use game_core::bots::Bot;
use game_core::constants::{
    GravityMode, MapScale, BATTERY_MAX, BOT_COUNT_DEFAULT, BOT_SPACE_FUEL_RESERVE,
    DEFAULT_MAP_SCALE, FOV_DAY, INVENTORY_SLOTS, MAX_WORLD_ITEMS, PLAYER_H, ROUND_SECONDS, SIM_DT,
    SURFACE_SAMPLE_STEP, WORLD_ITEM_TTL,
};
use game_core::items::registry::{ItemDef, ItemId, ItemKind, ITEMS, PISTOL};
use game_core::math::Vec2;
use game_core::player::input::button;
use game_core::player::state::DeathCause;
use game_core::weapons::defs::def;
use game_core::world::{give, GameEvent, RoundPhase, World};

/// Seeds for every population claim in this file. Eight, because five of eight
/// rounds contain a fight at all (§B17) and a smaller sample reports the empty
/// ones as a balance finding.
const SEEDS: [u64; 8] = [1, 7, 42, 99, 4242, 12345, 31337, 8675309];

/// The shipping seat count — `BOT_COUNT_DEFAULT` bots plus one human — not an
/// arbitrary four. T11.16 measured every per-weapon number as tracking encounter
/// rate, so a table measured at a player count the game does not ship is a table
/// about a different game (§A19, applied to seats rather than to scale).
const BOTS: usize = BOT_COUNT_DEFAULT + 1;
const SKILL: f32 = 0.85;
/// Long enough for several engagements, short enough that 20 weapons × 8 seeds
/// finishes in minutes. The absolute number does not matter — every weapon gets
/// the same one, and the comparison is the point.
const HOLD_SECONDS: f32 = 30.0;
/// The pool measurement needs a full round: periodic spawns are on a 20 s
/// interval, so a short round measures the initial placement and nothing else.
const POOL_SECONDS: f32 = 150.0;

#[derive(Debug, Default, Clone)]
struct Round {
    damage: f32,
    self_damage: f32,
    combat_deaths: u32,
    self_deaths: u32,
    fires: u32,
    ticks_armed: u32,
    /// item id → times picked up. `BTreeMap` and not `HashMap`: this is printed
    /// and compared, and `HashMap` order is randomly seeded per process (§A11).
    picks: BTreeMap<u16, u32>,
    spawned: BTreeMap<u16, u32>,
    /// §B24. Walkable ground covered by a lingering hazard, in px-seconds:
    /// surface points inside a patch x the ground each point stands for x dt.
    ///
    /// Restricted to *walkable* surface on purpose — a molotov burning the
    /// inside of a cliff has denied nobody anything, and area alone would score
    /// it identically to one thrown across a walkway.
    denied_px_s: f32,
    /// Bot-seconds spent with smoke cutting a bot's vision. Smoke denies sight,
    /// not ground, so counting it in `denied_px_s` would report the wrong thing
    /// about the one weapon §B7 says has no damage at all.
    blinded_s: f32,
    /// Ticks an enemy spent walking out of, or refusing to walk into, a hazard
    /// this weapon laid.
    deflect: u32,
    /// Throws refused because the **target** was inside our own reach, and
    /// throws refused because the walked **arc** landed on us (T11.15).
    ///
    /// Both are driven by `bots::zone_reach`, which is the fourth production
    /// reader of `GRAVITY` and the one that does not integrate. They are here
    /// because a stand-off derived from the wrong gravity does not show up as a
    /// missing throw — it shows up as a bot throwing and then standing in the
    /// fire, which reads as a self-damage number with no cause attached.
    rej_blast_guard: u32,
    rej_impact_guard: u32,
}

/// One headless round.
///
/// `hold` puts that item in every bot's hand, sweeps the ground every tick, and
/// gives full battery so an energy weapon is measured charged rather than
/// measured empty. Sweeping removes medkits too, which shortens fights — but it
/// does so identically for every weapon, and leaving them in would let a bot
/// switch to whatever it walked over halfway through the measurement.
fn run(seed: u64, hold: Option<ItemId>, seconds: f32) -> Round {
    run_under(seed, hold, seconds, GravityMode::Standard)
}

/// The same round under a chosen gravity mode (T22.02).
///
/// **The fixture is what was missing, and its absence was invisible.** Before
/// this parameter nothing in this file could construct a low-gravity world, so
/// the `--ignored` clause of T22.02's own Done-when passed before any of the
/// work was done — it was measuring the shipped game twice and calling the
/// agreement a result.
fn run_under(seed: u64, hold: Option<ItemId>, seconds: f32, gravity: GravityMode) -> Round {
    // `DEFAULT_MAP_SCALE`, for the same reason as `BOTS`: on Large, 0 of 8 rounds
    // contained a fight at all, so a weapon table measured there is measuring
    // silence.
    let mut w = World::new(seed, DEFAULT_MAP_SCALE);
    // **Set before the first `step` and never again.** It is the host's lobby
    // choice, which `room.rs` applies at construction; a mode changed mid-round
    // would be measuring two games.
    w.gravity = gravity;
    w.set_phase(RoundPhase::Playing);

    let mut bots = Vec::new();
    for i in 0..BOTS {
        let id = i as u8;
        w.add_player(id, 0, format!("Bot {i}"));
        if let Some(item) = hold {
            give(&mut w, id, item, 60);
            let slot = (0..INVENTORY_SLOTS as u8).find(|s| {
                w.player(id)
                    .and_then(|p| p.inventory.slot(*s))
                    .is_some_and(|st| st.item == item)
            });
            if let Some(slot) = slot {
                w.select_slot(id, slot);
            }
            if let Some(p) = w.player_mut(id) {
                p.battery = BATTERY_MAX;
            }
        }
        bots.push(Bot::new(id, seed, i as u32, SKILL));
    }
    let _ = w.drain_events();

    let mut r = Round::default();
    // world_item_id → item_id, so a pickup can be attributed to what it was.
    // `ItemPickup` carries only the world item id.
    let mut what: BTreeMap<u32, u16> = BTreeMap::new();

    let ticks = (seconds / SIM_DT) as u32;
    for t in 0..ticks {
        let now = t as f32 * SIM_DT;
        if hold.is_some() {
            let ids: Vec<_> = w.items.iter().map(|i| i.id).collect();
            for id in ids {
                w.items.remove(id);
            }
        }
        for b in bots.iter_mut() {
            let inp = b.think(&w, now, SIM_DT);
            w.queue_input(b.player, inp);
            if let Some(slot) = b.wants_select() {
                w.select_slot(b.player, slot);
            }
            if inp.buttons & button::FIRE != 0 {
                let _ = w.fire(b.player, now);
            }
            if let Some(slot) = b.wants_use() {
                let _ = w.use_item(b.player, slot, now);
            }
        }
        w.step(SIM_DT);

        // Denial, measured from the world rather than from a damage event —
        // that is the whole point of §B24. Guarded on `is_empty` so the 17
        // weapons that light nothing pay nothing for the measurement.
        if !w.burn.is_empty() {
            let mut covered = 0u32;
            for pt in &w.map.meta.surface_points {
                let at = Vec2::new(pt.x as f32, pt.y as f32);
                if w.burn
                    .patches()
                    .iter()
                    .any(|p| (p.pos - at).len() <= p.radius)
                {
                    covered += 1;
                }
            }
            r.denied_px_s += covered as f32 * SURFACE_SAMPLE_STEP as f32 * SIM_DT;
        }
        if !w.smoke.is_empty() {
            for b in &bots {
                if let Some(p) = w.player(b.player).filter(|p| p.alive) {
                    if w.smoke.multiplier_at(p.body.pos, now) < 1.0 {
                        r.blinded_s += SIM_DT;
                    }
                }
            }
        }

        for e in w.drain_events() {
            match e {
                GameEvent::Death { cause, .. } => match cause {
                    DeathCause::Player(_) => r.combat_deaths += 1,
                    DeathCause::SelfInflicted => r.self_deaths += 1,
                    DeathCause::Weather
                    | DeathCause::Void
                    | DeathCause::Radiation
                    | DeathCause::BlackHole => {}
                },
                GameEvent::Damage {
                    amount,
                    attacker,
                    victim,
                    ..
                } => {
                    // Damage *dealt to someone else*. Counting `attacker.is_some()`
                    // folds in self-damage, and the two weapons that looked
                    // strongest on the first run were mostly setting their own
                    // thrower on fire — molotov 2.14 dmg/bot-s alongside 13
                    // self-kills. An instrument that cannot tell "hit the enemy"
                    // from "hit myself" reports a liability as a strength.
                    match attacker {
                        Some(a) if a != victim => r.damage += amount,
                        Some(_) => r.self_damage += amount,
                        None => {}
                    }
                }
                GameEvent::ItemSpawn {
                    world_item_id,
                    item_id,
                    ..
                } => {
                    what.insert(world_item_id, item_id);
                    *r.spawned.entry(item_id).or_default() += 1;
                }
                GameEvent::ItemPickup { world_item_id, .. } => {
                    if let Some(item) = what.get(&world_item_id) {
                        *r.picks.entry(*item).or_default() += 1;
                    }
                }
                _ => {}
            }
        }
    }
    for b in &bots {
        let s = b.stats();
        r.fires += s.fires;
        r.ticks_armed += s.ticks_armed;
        r.deflect += s.ticks_hazard_evaded + s.ticks_hazard_blocked;
        r.rej_blast_guard += s.rej_blast_guard;
        r.rej_impact_guard += s.rej_impact_guard;
    }
    r
}

fn weapons() -> Vec<&'static ItemDef> {
    ITEMS
        .iter()
        .filter(|d| matches!(d.kind, ItemKind::Weapon(_)))
        .collect()
}

fn median(mut v: Vec<f32>) -> f32 {
    if v.is_empty() {
        return 0.0;
    }
    v.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
    v[v.len() / 2]
}

/// Every weapon must be reachable by *some* route. A weight of zero in all three
/// columns is a weapon nothing can ever give you, which is a registry bug and not
/// a balance result.
///
/// **§F5 gave this two exceptions, and they are named rather than derived.** A
/// predicate — "unless it is melee", "unless its weights are zero" — would excuse
/// the next weapon that acquires the same shape by accident, which is precisely
/// the bug this test exists to catch. So the unobtainable set is asserted as an
/// *equality*: these six and no others.
///
/// - **Retired**: knife, bat, whip, axe and hammer are kept as placeholders
///   because `ITEMS` is indexed by id and deleting five entries renumbers every
///   id above them (§B16, the bug where a laser resolved as a bazooka). They are
///   deliberately unreachable.
/// - **Issued**: everybody spawns holding a shovel, so a ground spawn would be
///   litter. That exemption is only honest if the issue actually happens, which
///   is why it is asserted here as well as in
///   `melee::t1905_shovel::every_player_spawns_holding_a_shovel` — without it,
///   "the shovel needs no weights" excuses a weapon nobody can ever hold.
#[test]
fn every_weapon_is_obtainable_unless_it_is_issued_or_retired() {
    const RETIRED: [&str; 5] = ["knife", "bat", "whip", "axe", "hammer"];
    const ISSUED: [&str; 1] = ["shovel"];

    let mut orphans: Vec<_> = weapons()
        .iter()
        .filter(|d| d.spawn_weight == 0 && d.crate_weight == 0 && d.buried_weight == 0)
        .map(|d| d.key)
        .collect();
    // `registry::is_retired` is the predicate §F7's `all` kit skips on, and this
    // is the equality that pins it: five retired, and the shovel — which has the
    // same three zero columns — is **not** one of them. Without this the kit
    // could quietly stop handing out the shovel, or start handing out an axe,
    // and the only test that would notice is one written next year.
    let mut retired: Vec<_> = weapons()
        .iter()
        .filter(|d| game_core::items::registry::is_retired(d))
        .map(|d| d.key)
        .collect();
    retired.sort_unstable();
    let mut want = RETIRED.to_vec();
    want.sort_unstable();
    assert_eq!(
        retired, want,
        "`is_retired` names a different set than RETIRED"
    );
    assert!(
        !retired.contains(&"shovel"),
        "the issued shovel has three zero columns too and must not read as retired"
    );
    orphans.sort_unstable();
    let mut expected: Vec<&str> = RETIRED.iter().chain(ISSUED.iter()).copied().collect();
    expected.sort_unstable();
    assert_eq!(
        orphans, expected,
        "the set of weapons with no way into a player's hands changed"
    );

    // The issued half, at the live binding site: a player who joins is holding
    // one. `World::new` + `add_player` is the production route, not
    // `PlayerState::new` — the tree this landed in had `respawn` granting the kit
    // and the join not, and only the join is checked here.
    let mut w = World::new(4242, MapScale::Small);
    w.set_phase(RoundPhase::Playing);
    w.add_player(0, 0, "ana".into());
    let holds = |key: &str| {
        let id = ITEMS.iter().find(|d| d.key == key).map(|d| d.id);
        (0..INVENTORY_SLOTS as u8).any(|s| {
            w.player(0)
                .and_then(|p| p.inventory.slot(s))
                .map(|st| st.item)
                == id
        })
    };
    for key in ISSUED {
        assert!(
            holds(key),
            "{key} is exempt from the weights but is not issued"
        );
    }
    for key in RETIRED {
        assert!(
            !holds(key),
            "{key} is retired but a fresh player is holding one"
        );
    }

    // Control: without this the assertion above passes for an empty arsenal.
    assert!(
        weapons().len() >= 20,
        "expected the full arsenal, found {}",
        weapons().len()
    );
}

/// The measurement is reproducible. The sim is deterministic, so this is exact
/// rather than within a tolerance — and an exact match is a stronger claim.
#[test]
fn the_measurement_is_reproducible() {
    // Held, not natural: a bot starts empty and takes longer than this to find
    // a weapon, so a pool round of a few seconds fires nothing and the
    // comparison would be between two empty rounds. The control below caught
    // exactly that.
    //
    // The window was 10 s until §C20. Standing still to shoot means a bot has to
    // reach its enemy, land and settle before the first trigger pull lands, and
    // measured on this seed the first shot now arrives at **t≈13 s** (0 by 10 s,
    // 2 by 15 s, 17 by 20 s). The control below went red at 10 s, correctly: it
    // was comparing two rounds in which nothing happened. Lengthened to cover
    // the delay the gate introduces rather than removed — a determinism test
    // needs a window in which something is determined.
    const WINDOW: f32 = 25.0;
    let a = run(SEEDS[0], Some(PISTOL), WINDOW);
    let b = run(SEEDS[0], Some(PISTOL), WINDOW);
    assert_eq!(a.damage.to_bits(), b.damage.to_bits(), "damage drifted");
    assert_eq!(a.combat_deaths, b.combat_deaths);
    assert_eq!(a.picks, b.picks);
    // Control: the run has to have done something, or equality is vacuous.
    assert!(
        a.fires > 0,
        "no shots fired — the comparison proves nothing"
    );
}

/// T22.02 — what half gravity does to the numbers this file exists to measure.
///
/// `cargo test -p game-core --release --test balance -- --ignored --nocapture`
///
/// **Three things move and they move for different reasons**, which is why this
/// reports all three side by side rather than one summary figure:
///
/// - **The bots' flame stand-off.** `bots::zone_reach` derives it as the
///   ballistic range `v^2 / (g * FLAME_GRAVITY_SCALE * k)`, so halving gravity
///   doubles it. That radius drives both throw guards, and a stand-off computed
///   at the wrong gravity does not show up as a missing throw — it shows up as
///   a bot throwing and then walking into its own fire.
/// - **Self-damage.** Which is that same failure, measured at the victim.
/// - **The encounter rate.** Floatier jumps change where bots get to and how
///   long they are in the air, so `fought`, `fires` and `dmg` all move.
///
/// **The reach column is printed and not asserted, on purpose.** The only way
/// to assert it from an integration test is to write the expression out again,
/// and an expression asserted against a copy of itself reports nothing. What is
/// asserted is the *effect*: the measured game has to differ, and the
/// standard-gravity arm beside it is what says the instrument can see anything
/// at all.
///
/// **Measured, so the label is not a guess:** with the multiplier deleted from
/// `bots::zone_reach`, the printed stand-off line does **not** move — it is the
/// basis, evaluated here, not a reading of the function — while the molotov row
/// moves from `81 fires / 5 refused / 67 self-damage` to
/// `112 / 2 / 89` over the same eight seeds. The bots throw 38 % more and burn
/// themselves a third more, and the `natural` and `pistol` rows stay
/// byte-identical, which is what says the effect is the flame arm and not the
/// weather.
#[test]
#[ignore = "measurement: minutes in release"]
fn low_gravity_report() {
    use game_core::constants::{FLAME_GRAVITY_SCALE, FLAME_RADIUS, GRAVITY};
    use game_core::items::registry::{def as item_def, MOLOTOV};
    use game_core::weapons::defs::Burst;

    // The same expression `bots::zone_reach` evaluates, on the molotov's own
    // `Burst::Flames { speed }` off the registry — not a literal.
    let flame_speed = item_def(MOLOTOV)
        .and_then(|d| match d.kind {
            ItemKind::Weapon(wid) => def(wid),
            _ => None,
        })
        .and_then(|w| match w.burst {
            Burst::Flames { speed, .. } => Some(speed),
            _ => None,
        })
        .unwrap_or(0.0);
    let reach =
        |k: f32| flame_speed * flame_speed / (GRAVITY * FLAME_GRAVITY_SCALE * k) + FLAME_RADIUS;

    println!(
        "\n== LOW GRAVITY — {} seeds, gravity scale {} ==",
        SEEDS.len(),
        GravityMode::Low.scale()
    );
    println!(
        "   molotov flame stand-off: {:.0} px standard -> {:.0} px low  \
         (zone_reach's basis: v^2 / (g * {FLAME_GRAVITY_SCALE} * k), v = {flame_speed:.0})",
        reach(GravityMode::Standard.scale()),
        reach(GravityMode::Low.scale())
    );

    // Three arms. A natural round for the encounter rate; a molotov in every
    // hand for the self-damage the stand-off decides; a pistol for the control
    // — it lights nothing, so its guard counters must stay at zero whatever
    // gravity does, and a column that moved there would mean the counters are
    // measuring something other than the zone guards.
    let arms: [(&str, Option<ItemId>, f32); 3] = [
        ("natural", None, POOL_SECONDS),
        ("molotov", Some(MOLOTOV), HOLD_SECONDS),
        ("pistol", Some(PISTOL), HOLD_SECONDS),
    ];

    println!(
        "\n{:<10}{:<10}{:>9}{:>9}{:>9}{:>9}{:>9}{:>9}",
        "arm", "gravity", "dmg", "self", "kills", "selfkil", "fires", "rejzone"
    );
    let mut totals: Vec<(String, f32, f32, u32, u32)> = Vec::new();
    for (label, hold, seconds) in arms {
        for gravity in [GravityMode::Standard, GravityMode::Low] {
            let rs: Vec<Round> = SEEDS
                .iter()
                .map(|&s| run_under(s, hold, seconds, gravity))
                .collect();
            let sum = |f: fn(&Round) -> f32| rs.iter().map(f).sum::<f32>();
            let sumu = |f: fn(&Round) -> u32| rs.iter().map(f).sum::<u32>();
            let dmg = sum(|r| r.damage);
            let selfd = sum(|r| r.self_damage);
            let kills = sumu(|r| r.combat_deaths);
            let selfk = sumu(|r| r.self_deaths);
            let fires = sumu(|r| r.fires);
            let rej = sumu(|r| r.rej_blast_guard + r.rej_impact_guard);
            println!(
                "{label:<10}{:<10}{dmg:>9.0}{selfd:>9.0}{kills:>9}{selfk:>9}{fires:>9}{rej:>9}",
                format!("{gravity:?}")
            );
            totals.push((format!("{label}/{gravity:?}"), dmg, selfd, fires, rej));
        }
    }

    // The control first: without damage anywhere, "the numbers moved" and "the
    // numbers did not move" are the same reading.
    let fought: f32 = totals.iter().map(|t| t.1).sum();
    assert!(
        fought > 0.0,
        "no damage was dealt in any arm under either gravity — the measurement \
         is blind and every comparison below it is between two silences"
    );

    // And the claim: half gravity is a different game. Asserted across every
    // arm at once rather than on one column, because which column moves most is
    // a balance finding and this is only the wiring claim.
    let std_arm: Vec<_> = totals
        .iter()
        .filter(|t| t.0.ends_with("Standard"))
        .collect();
    let low_arm: Vec<_> = totals.iter().filter(|t| t.0.ends_with("Low")).collect();
    let moved = std_arm
        .iter()
        .zip(low_arm.iter())
        .any(|(a, b)| a.1 != b.1 || a.2 != b.2 || a.3 != b.3 || a.4 != b.4);
    assert!(
        moved,
        "every measured number is identical under standard and low gravity \
         across {} seeds and three arms — `World::gravity` reaches nothing the \
         bots or the weapons can feel",
        SEEDS.len()
    );
}

/// One natural space round's radiation economy (T22.09A), for
/// `space_radiation_report`.
#[derive(Debug, Default, Clone)]
struct SpaceRound {
    radiation_deaths: u32,
    other_deaths: u32,
    radiation_damage: f32,
    packs_spawned: u32,
    packs_picked: u32,
    /// Alive player-seconds, and how many of them were unsealed.
    alive_s: f32,
    unsealed_s: f32,
}

/// A natural round on a **generated** space map (`World::with_gravity`, so the
/// asteroids, rim and field are the shipping ones), bots at the shipping seat
/// count, `Playing` for `seconds`.
fn run_space(seed: u64, seconds: f32) -> SpaceRound {
    use game_core::constants::DEFAULT_MAP_GENERATOR;
    use game_core::items::registry::BATTERY_PACK;
    let mut w = World::with_gravity(
        seed,
        DEFAULT_MAP_SCALE,
        0,
        DEFAULT_MAP_GENERATOR,
        GravityMode::Space,
    );
    w.set_phase(RoundPhase::Playing);
    let mut bots = Vec::new();
    for i in 0..BOTS {
        let id = i as u8;
        w.add_player(id, 0, format!("Bot {i}"));
        bots.push(Bot::new(id, seed, i as u32, SKILL));
    }
    // The initial placement's packs, which were spawned before anyone could
    // hear about them: counted off the ground rather than off an event.
    let mut r = SpaceRound {
        packs_spawned: w.items.iter().filter(|i| i.item == BATTERY_PACK).count() as u32,
        ..Default::default()
    };
    let mut what: BTreeMap<u32, u16> = w.items.iter().map(|i| (i.id, i.item)).collect();
    let _ = w.drain_events();
    for t in 0..(seconds / SIM_DT) as u32 {
        let now = t as f32 * SIM_DT;
        for b in bots.iter_mut() {
            let inp = b.think(&w, now, SIM_DT);
            w.queue_input(b.player, inp);
            if let Some(slot) = b.wants_select() {
                w.select_slot(b.player, slot);
            }
            if inp.buttons & button::FIRE != 0 {
                let _ = w.fire(b.player, now);
            }
            if let Some(slot) = b.wants_use() {
                let _ = w.use_item(b.player, slot, now);
            }
        }
        w.step(SIM_DT);
        let now = w.round_time;
        for p in w.players.iter().filter(|p| p.alive) {
            r.alive_s += SIM_DT;
            if p.irradiated(now, true) {
                r.unsealed_s += SIM_DT;
            }
        }
        for e in w.drain_events() {
            match e {
                GameEvent::Death { cause, .. } => match cause {
                    DeathCause::Radiation => r.radiation_deaths += 1,
                    _ => r.other_deaths += 1,
                },
                GameEvent::Damage {
                    amount,
                    cause: DeathCause::Radiation,
                    ..
                } => r.radiation_damage += amount,
                GameEvent::ItemSpawn {
                    world_item_id,
                    item_id,
                    ..
                } => {
                    what.insert(world_item_id, item_id);
                    if item_id == BATTERY_PACK {
                        r.packs_spawned += 1;
                    }
                }
                GameEvent::ItemPickup { world_item_id, .. }
                    if what.get(&world_item_id) == Some(&BATTERY_PACK) =>
                {
                    r.packs_picked += 1;
                }
                _ => {}
            }
        }
    }
    r
}

/// **T22.09A — the measurement `M22-RULINGS` R24 owes.** R24's four numbers
/// (`RADIATION_DPS`, `RADIATION_SHIELD_COST`, a full suit at spawn and on
/// respawn, the pack's doubled space weight) came from arithmetic: *"a player
/// who ignores batteries dies of radiation about twice a round; a player who
/// picks up two or three does not."* This runs the shipping round — `ROUND_
/// SECONDS` less the warmup, bots at the shipping seat count, generated space
/// maps — over the eight seeds and prints what the economy actually does.
///
/// `cargo test -p game-core --release --test balance space_radiation_report -- --ignored --nocapture`
#[test]
#[ignore = "measurement: 0.8 s in release, measured"]
fn space_radiation_report() {
    use game_core::constants::{RADIATION_DPS, RADIATION_SHIELD_COST, WARMUP_SECONDS};
    let seconds = ROUND_SECONDS - WARMUP_SECONDS;
    println!(
        "\n== SPACE RADIATION — {} seeds x {BOTS} bots x {seconds} s, {RADIATION_DPS} dps, \
         seal {RADIATION_SHIELD_COST}/s ==",
        SEEDS.len()
    );
    println!(
        "{:>9}{:>8}{:>8}{:>9}{:>8}{:>8}{:>10}",
        "seed", "raddie", "other", "raddmg", "packs", "picked", "unsealed"
    );
    let rs: Vec<SpaceRound> = SEEDS
        .iter()
        .map(|&s| {
            let r = run_space(s, seconds);
            println!(
                "{s:>9}{:>8}{:>8}{:>9.0}{:>8}{:>8}{:>9.1}%",
                r.radiation_deaths,
                r.other_deaths,
                r.radiation_damage,
                r.packs_spawned,
                r.packs_picked,
                100.0 * r.unsealed_s / r.alive_s.max(f32::EPSILON)
            );
            r
        })
        .collect();
    let n = (SEEDS.len() * BOTS) as f32;
    let sum = |f: fn(&SpaceRound) -> f32| rs.iter().map(f).sum::<f32>();
    let rad = sum(|r| r.radiation_deaths as f32);
    let unsealed = sum(|r| r.unsealed_s) / sum(|r| r.alive_s);
    println!(
        "per player per round: {:.2} radiation deaths, {:.2} other deaths, {:.2} packs spawned, \
         {:.2} picked; unsealed {:.1}% of alive time",
        rad / n,
        sum(|r| r.other_deaths as f32) / n,
        sum(|r| r.packs_spawned as f32) / n,
        sum(|r| r.packs_picked as f32) / n,
        100.0 * unsealed
    );
    // The control: a report that saw no sealed time or no unsealed time is
    // measuring one half of the economy and calling it the whole.
    assert!(
        sum(|r| r.alive_s) > 0.0 && unsealed > 0.0 && unsealed < 1.0,
        "the round saw only one side of the seal (unsealed {unsealed}) — blind"
    );
}

/// One whole round of bots under `gravity` (T22.03B): **what they die of, and whether
/// they fight** — the before/after instrument for bots in space. Deaths by cause,
/// a flare's burn told from other weather by the `effect` of the victim's last
/// weather damage (`Weather` names both), trigger pulls the bots asked for, shots
/// the world took (`fire` returned `Ok`), player-caused deaths, and damage between
/// players.
#[derive(Debug, Default, Clone)]
struct BotRound {
    black_hole: u32,
    void: u32,
    radiation: u32,
    flare: u32,
    weather: u32,
    player: u32,
    selfd: u32,
    /// T22.03C: damage a bot did to itself — `Damage` events attributed to the
    /// victim (`DeathCause::SelfInflicted`: its own blasts and fires, **and falls**,
    /// which the event does not tell apart; the before/after compare like with like).
    self_dmg: f32,
    /// ...of it, taken **inside the bot's own fire or cloud** (a flame it owns, or a
    /// burn patch it lit, within `PLAYER_H` of its body) — the thrower's own-hit
    /// count R95 compares across modes; and the self-kills that ended there.
    zone_self_dmg: f32,
    zone_self_hits: u32,
    zone_self_kills: u32,
    wanted: u32,
    shots: u32,
    player_dmg: f32,
    vortex_trips: u32,
    packs_picked: u32,
    /// Alive bot-ticks, and of them: tank below `JETPACK_MIN_FUEL_TO_ENGAGE`
    /// (dry), grounded, unsealed (radiation getting through); and the speed sum.
    alive: u32,
    dry: u32,
    grounded: u32,
    unsealed: u32,
    speed: f32,
    /// Distinct (bot, 256 px cell) pairs visited — how much of the map they cover.
    cells: u32,
    /// Thrown zone weapons (the molotov's flames, toxic's cloud): alive ticks a bot
    /// held one selected, and shots taken with one.
    zone_held: u32,
    zone_shots: u32,
    /// ...of them, molotovs (`Burst::Flames`) — a bot picks toxic grenades up too.
    flame_shots: u32,
    /// T22.03D, the review's definitions of a bot **pinned against rock**: alive
    /// ticks airborne (not grounded) and slower than `PINNED_SPEED` (`still_air`);
    /// of them, touching rock (the body's box grown by a pixel overlaps solid) at
    /// any fuel (`pinned_any`), and touching rock **at the fuel reserve**
    /// (`pinned`: under `BOT_SPACE_FUEL_RESERVE + PINNED_AT_RESERVE`). Runs are
    /// consecutive pinned ticks of one bot: the longest, and how many reach
    /// `PINNED_RUN_S`. **Winged bots are left out** (their own regime, the walking
    /// model's buttons in every mode) and counted in `pinned_wings`.
    still_air: u32,
    pinned: u32,
    pinned_any: u32,
    longest: u32,
    longest_any: u32,
    runs: u32,
    runs_any: u32,
    /// ...and a winged bot airborne, still and touching rock: not counted above.
    pinned_wings: u32,
}

/// T22.03D's instrument: slower than this, px/s, is "not moving" (the review's).
const PINNED_SPEED: f32 = 20.0;
/// "At the reserve": within this much fuel above `BOT_SPACE_FUEL_RESERVE`, s of
/// burn — the review's pinned bots sat at 1.49–1.51 (`gate-review2203b-stuck.txt`).
const PINNED_AT_RESERVE: f32 = 0.1;
/// A pinned run this long is a bot out of the round, s (the review's cut).
const PINNED_RUN_S: f32 = 10.0;

/// A generated map under `gravity`, the shipping seat count, `Playing` for the whole
/// `ROUND_SECONDS` — so a space round reaches its last minute and the black hole.
///
/// `hold`: every bot starts with 60 of it, selected — the thrown-weapon arm, since
/// nobody in a natural round ever holds a zone weapon (measured: 0.0 % of alive time
/// in both modes), so a natural round cannot see whether a bot throws one.
fn run_bots(seed: u64, gravity: GravityMode, hold: Option<ItemId>) -> BotRound {
    use game_core::constants::DEFAULT_MAP_GENERATOR;
    use game_core::constants::JETPACK_MIN_FUEL_TO_ENGAGE;
    use game_core::items::registry::{def as def_item, BATTERY_PACK};
    use game_core::weapons::explode::EffectKind;
    let mut w = World::with_gravity(seed, DEFAULT_MAP_SCALE, 0, DEFAULT_MAP_GENERATOR, gravity);
    w.set_phase(RoundPhase::Playing);
    let mut bots = Vec::new();
    for i in 0..BOTS {
        let id = i as u8;
        w.add_player(id, 0, format!("Bot {i}"));
        if let Some(item) = hold {
            give(&mut w, id, item, 60);
            if let Some(slot) = (0..INVENTORY_SLOTS as u8).find(|s| {
                w.player(id)
                    .and_then(|p| p.inventory.slot(*s))
                    .is_some_and(|st| st.item == item)
            }) {
                w.select_slot(id, slot);
            }
        }
        bots.push(Bot::new(id, seed, i as u32, SKILL));
    }
    let mut what: BTreeMap<u32, u16> = w.items.iter().map(|i| (i.id, i.item)).collect();
    let mut last_weather: BTreeMap<u8, Option<EffectKind>> = BTreeMap::new();
    let _ = w.drain_events();
    let mut r = BotRound::default();
    let mut cells = std::collections::BTreeSet::new();
    // Per player: the current pinned run (at the reserve, any fuel), in ticks.
    let mut run: BTreeMap<u8, (u32, u32)> = BTreeMap::new();
    let mut last_btn: BTreeMap<u8, u8> = BTreeMap::new();
    let run_ticks = (PINNED_RUN_S / SIM_DT).round() as u32;
    while w.phase == RoundPhase::Playing {
        let now = w.round_time;
        for b in bots.iter_mut() {
            let inp = b.think(&w, now, SIM_DT);
            last_btn.insert(b.player, inp.buttons);
            w.queue_input(b.player, inp);
            if let Some(slot) = b.wants_select() {
                w.select_slot(b.player, slot);
            }
            let burst = w
                .player(b.player)
                .filter(|p| p.alive)
                .and_then(|p| p.inventory.slot(p.inventory.selected()))
                .and_then(|st| def_item(st.item))
                .and_then(|d| match d.kind {
                    ItemKind::Weapon(wid) => def(wid),
                    _ => None,
                })
                .map(|wd| wd.burst);
            let flames = matches!(burst, Some(game_core::weapons::defs::Burst::Flames { .. }));
            let zone =
                flames || matches!(burst, Some(game_core::weapons::defs::Burst::Zone { .. }));
            r.zone_held += u32::from(zone);
            if inp.buttons & button::FIRE != 0 {
                r.wanted += 1;
                if w.fire(b.player, now).is_ok() {
                    r.shots += 1;
                    r.zone_shots += u32::from(zone);
                    r.flame_shots += u32::from(flames);
                }
            }
            if let Some(slot) = b.wants_use() {
                let _ = w.use_item(b.player, slot, now);
            }
        }
        w.step(SIM_DT);
        let suit = w.gravity == GravityMode::Space;
        for p in w.players.iter().filter(|p| p.alive) {
            r.alive += 1;
            r.dry += u32::from(p.jetpack.fuel < JETPACK_MIN_FUEL_TO_ENGAGE);
            r.grounded += u32::from(p.body.grounded);
            r.unsealed += u32::from(p.irradiated(w.round_time, suit));
            r.speed += p.body.vel.len();
            cells.insert((p.id, p.body.pos.x as i32 / 256, p.body.pos.y as i32 / 256));
            // Wings are their own regime in every mode (`space::flies`), and a winged
            // bot pinned against rock is the walking model's, counted apart.
            let winged = p.move_mods().flying;
            let still = !p.body.grounded && p.body.vel.len() < PINNED_SPEED;
            r.pinned_wings += u32::from(still && winged && touches(&w, p));
            let still = still && !winged;
            let touching = still && touches(&w, p);
            let at_reserve = p.jetpack.fuel < BOT_SPACE_FUEL_RESERVE + PINNED_AT_RESERVE;
            r.still_air += u32::from(still);
            r.pinned_any += u32::from(touching);
            r.pinned += u32::from(touching && at_reserve);
            let cur = run.entry(p.id).or_default();
            let step = |n: &mut u32, on: bool, longest: &mut u32, runs: &mut u32| {
                if on {
                    *n += 1;
                    *longest = (*longest).max(*n);
                    *runs += u32::from(*n == run_ticks);
                } else {
                    *n = 0;
                }
            };
            step(
                &mut cur.0,
                touching && at_reserve,
                &mut r.longest,
                &mut r.runs,
            );
            step(&mut cur.1, touching, &mut r.longest_any, &mut r.runs_any);
        }
        // A dead bot's run ends.
        for p in w.players.iter().filter(|p| !p.alive) {
            run.insert(p.id, (0, 0));
        }
        // Is `v` inside its own fire or cloud right now?
        let in_own = |w: &World, v: u8| {
            let Some(at) = w.player(v).map(|p| p.body.pos) else {
                return false;
            };
            let near = |c: Vec2, r: f32| (c - at).len() < r + PLAYER_H;
            w.projectiles.iter().any(|f| {
                f.owner == v
                    && game_core::weapons::flame::is_flame(f.weapon)
                    && near(f.pos, game_core::constants::FLAME_RADIUS)
            }) || w.burn.patches().iter().any(|b| {
                matches!(b.source, game_core::weapons::explode::DamageSource::Player { id, .. } if id == v)
                    && near(b.pos, b.radius)
            })
        };
        for e in w.drain_events() {
            match e {
                GameEvent::Death {
                    cause: DeathCause::SelfInflicted,
                    victim,
                    ..
                } if in_own(&w, victim) => {
                    r.selfd += 1;
                    r.zone_self_kills += 1;
                }
                GameEvent::Death { cause, victim, .. } => match cause {
                    DeathCause::BlackHole => r.black_hole += 1,
                    DeathCause::Void => r.void += 1,
                    DeathCause::Radiation => r.radiation += 1,
                    DeathCause::Weather => {
                        if last_weather.get(&victim) == Some(&Some(EffectKind::SolarFlare)) {
                            r.flare += 1
                        } else {
                            r.weather += 1
                        }
                    }
                    DeathCause::Player(_) => r.player += 1,
                    DeathCause::SelfInflicted => r.selfd += 1,
                },
                GameEvent::Damage {
                    victim,
                    amount,
                    attacker,
                    cause,
                    effect,
                    ..
                } => {
                    if cause == DeathCause::Weather {
                        last_weather.insert(victim, effect);
                    }
                    if matches!(cause, DeathCause::Player(_)) && attacker != Some(victim) {
                        r.player_dmg += amount;
                    }
                    if cause == DeathCause::SelfInflicted {
                        r.self_dmg += amount;
                        if in_own(&w, victim) {
                            if std::env::var("ZDBG").is_ok() && r.zone_self_hits % 10 == 0 {
                                let p = w.player(victim).unwrap();
                                let fl: Vec<_> = w
                                    .projectiles
                                    .iter()
                                    .filter(|f| {
                                        f.owner == victim
                                            && game_core::weapons::flame::is_flame(f.weapon)
                                    })
                                    .map(|f| {
                                        (
                                            (f.pos.x - p.body.pos.x) as i32,
                                            (f.pos.y - p.body.pos.y) as i32,
                                        )
                                    })
                                    .take(6)
                                    .collect();
                                eprintln!("Z seed {seed} {gravity:?} p{victim} t{:.1} pos {:.0},{:.0} vel {:.0},{:.0} g{} hp {:.0} amt {amount:.1} btn {:08b} flames {fl:?}", w.round_time, p.body.pos.x, p.body.pos.y, p.body.vel.x, p.body.vel.y, p.body.grounded as u8, p.health, last_btn.get(&victim).copied().unwrap_or(0));
                            }
                            r.zone_self_dmg += amount;
                            r.zone_self_hits += 1;
                        }
                    }
                }
                GameEvent::VortexTrip { .. } => r.vortex_trips += 1,
                GameEvent::ItemSpawn {
                    world_item_id,
                    item_id,
                    ..
                } => {
                    what.insert(world_item_id, item_id);
                }
                GameEvent::ItemPickup { world_item_id, .. }
                    if what.get(&world_item_id) == Some(&BATTERY_PACK) =>
                {
                    r.packs_picked += 1;
                }
                _ => {}
            }
        }
    }
    r.cells = cells.len() as u32;
    r
}

/// The body's box grown by a pixel overlaps rock: touching it.
fn touches(w: &World, p: &game_core::player::state::PlayerState) -> bool {
    game_core::physics::collide::aabb_overlaps_solid(
        &w.map,
        game_core::math::Aabb::from_center_size(
            p.body.pos,
            p.body.size.x + 2.0,
            p.body.size.y + 2.0,
        ),
    )
}

fn total_runs(rs: &[BotRound], f: fn(&BotRound) -> u32) -> u32 {
    rs.iter().map(f).sum()
}

/// **T22.03B — bots in space, measured.** Per bot per round, over `SEEDS`, a whole
/// shipping round each: deaths by cause, trigger pulls wanted and taken, player
/// deaths (kills) and damage. The standard-gravity arm is the control on the same
/// instrument: a space arm that reads like it is a space game with fights in it.
///
/// `cargo test -p game-core --release --test balance space_bots_report -- --ignored --nocapture`
#[test]
#[ignore = "measurement: ~1 min in release"]
fn space_bots_report() {
    // `BOTS_SEEDS=n` runs n seeds instead of `SEEDS` — the deaths this counts are
    // rare events, and eight rounds decide a one-in-forty difference by a coin.
    let seeds: Vec<u64> = std::env::var("BOTS_SEEDS")
        .ok()
        .and_then(|n| n.parse::<u64>().ok())
        .map_or(SEEDS.to_vec(), |n| (1..=n).map(|i| i * 7919).collect());
    println!(
        "\n== BOTS BY MODE — {} seeds x {BOTS} bots x {ROUND_SECONDS} s, per bot per round ==",
        seeds.len()
    );
    println!(
        "{:>9}{:>7}{:>7}{:>7}{:>7}{:>7}{:>7}{:>7}{:>8}{:>8}{:>8}{:>7}{:>7}",
        "mode",
        "hole",
        "void",
        "rad",
        "flare",
        "wthr",
        "kills",
        "self",
        "wanted",
        "shots",
        "dmg",
        "trips",
        "packs"
    );
    use game_core::items::registry::{MOLOTOV, TOXIC_GRENADE};
    let mut arms = Vec::new();
    for (hold, gravity) in [
        (None, GravityMode::Standard),
        (None, GravityMode::Space),
        (Some(MOLOTOV), GravityMode::Standard),
        (Some(MOLOTOV), GravityMode::Space),
        (Some(TOXIC_GRENADE), GravityMode::Standard),
        (Some(TOXIC_GRENADE), GravityMode::Space),
    ] {
        // `BOTS_NATURAL=1`: only the two natural arms (a long seed count's cost).
        if hold.is_some() && std::env::var("BOTS_NATURAL").is_ok() {
            continue;
        }
        let rs: Vec<BotRound> = seeds.iter().map(|&s| run_bots(s, gravity, hold)).collect();
        if let Some(item) = hold {
            println!(
                "  -- every bot starts holding {} --",
                game_core::items::registry::def(item).map_or("?", |d| d.key)
            );
        }
        let n = (seeds.len() * BOTS) as f32;
        let per = |f: fn(&BotRound) -> f32| rs.iter().map(f).sum::<f32>() / n;
        println!(
            "{:>9}{:>7.2}{:>7.2}{:>7.2}{:>7.2}{:>7.2}{:>7.2}{:>7.2}{:>8.0}{:>8.0}{:>8.0}{:>7.2}{:>7.2}",
            format!("{gravity:?}"),
            per(|r| r.black_hole as f32),
            per(|r| r.void as f32),
            per(|r| r.radiation as f32),
            per(|r| r.flare as f32),
            per(|r| r.weather as f32),
            per(|r| r.player as f32),
            per(|r| r.selfd as f32),
            per(|r| r.wanted as f32),
            per(|r| r.shots as f32),
            per(|r| r.player_dmg),
            per(|r| r.vortex_trips as f32),
            per(|r| r.packs_picked as f32),
        );
        let ticks = |f: fn(&BotRound) -> u32| {
            100.0 * rs.iter().map(|r| f(r) as f32).sum::<f32>()
                / rs.iter().map(|r| r.alive as f32).sum::<f32>().max(1.0)
        };
        println!(
            "          of alive time: dry {:.1}% grounded {:.1}% unsealed {:.1}%, mean speed {:.0} px/s, \
             {:.1} cells a bot",
            ticks(|r| r.dry),
            ticks(|r| r.grounded),
            ticks(|r| r.unsealed),
            rs.iter().map(|r| r.speed).sum::<f32>() / rs.iter().map(|r| r.alive as f32).sum::<f32>(),
            per(|r| r.cells as f32)
        );
        println!(
            "          zone weapons: held {:.1}% of alive time, {:.2} throws a bot; self-damage \
             {:.1} a bot a round, {:.1} of it in its own fire/cloud ({:.2} hits a throw), \
             {:.3} self-kills there",
            ticks(|r| r.zone_held),
            per(|r| r.zone_shots as f32),
            per(|r| r.self_dmg),
            per(|r| r.zone_self_dmg),
            rs.iter().map(|r| r.zone_self_hits).sum::<u32>() as f32
                / rs.iter().map(|r| r.zone_shots).sum::<u32>().max(1) as f32,
            per(|r| r.zone_self_kills as f32)
        );
        let secs = |t: u32| t as f32 * SIM_DT;
        println!(
            "          pinned (T22.03D): airborne & still {:.1}%, against rock at the reserve {:.1}% \
             (runs >= {PINNED_RUN_S} s: {}, longest {:.0} s), against rock at any fuel {:.1}% \
             (runs: {}, longest {:.0} s); winged bots against rock {:.1}%",
            ticks(|r| r.still_air),
            ticks(|r| r.pinned),
            total_runs(&rs, |r| r.runs),
            secs(rs.iter().map(|r| r.longest).max().unwrap_or(0)),
            ticks(|r| r.pinned_any),
            total_runs(&rs, |r| r.runs_any),
            secs(rs.iter().map(|r| r.longest_any).max().unwrap_or(0)),
            ticks(|r| r.pinned_wings),
        );
        if std::env::var("BOTS_PER_SEED").is_ok() {
            for (s, r) in seeds.iter().zip(&rs) {
                println!("    seed {s:>8}: {r:?}");
            }
        }
        arms.push(rs);
    }
    // The control: the standard arm must show a fight, or the instrument is blind.
    let total = |arm: &[BotRound], f: fn(&BotRound) -> u32| arm.iter().map(f).sum::<u32>();
    assert!(
        total(&arms[0], |r| r.shots) > 0,
        "no shot taken under standard gravity — the harness is blind"
    );
    // T22.03B's claims, on the natural space arm: **a fight** (at least the standard
    // control's player kills), **not a hazard course** (the environment kills fewer than
    // the players), and **the black hole rare** — under one death in two rounds. At
    // `888ee4c`, before bots flew, it took 8 in 8 rounds (and 0.18 a bot a round over 32).
    let space = &arms[1];
    let kills = total(space, |r| r.player);
    let env = total(space, |r| {
        r.black_hole + r.void + r.radiation + r.flare + r.weather
    });
    // T22.03D F2: **the fight floor is the space number, not standard's.** Standard's
    // 0.27 a bot a round was a floor space cleared five times over, so it caught only a
    // space arm with no fight at all. `SPACE_KILLS_FLOOR` is 0.6 of the measured value
    // (4.35 a bot a round over 8 seeds, 4.02 over 32); the plants it catches are in
    // T22.03D's As built.
    // Every claim is checked and all failures reported together, so a red run names
    // each thing that moved rather than only the first.
    let mut failed: Vec<String> = Vec::new();
    let n_bots = (seeds.len() * BOTS) as f32;
    if (kills as f32) < SPACE_KILLS_FLOOR * n_bots {
        failed.push(format!(
            "{kills} player kills, {:.2} a bot a round, under the floor {SPACE_KILLS_FLOOR}",
            kills as f32 / n_bots
        ));
    }
    if env >= kills {
        failed.push(format!("the environment killed {env}, the players {kills}"));
    }
    let hole = total(space, |r| r.black_hole) as usize;
    if 2 * hole >= seeds.len() {
        failed.push(format!(
            "{hole} black-hole deaths in {} rounds",
            seeds.len()
        ));
    }
    // T22.03D F1: **not pinned against rock.** At the fuel reserve (the review's
    // definition, the hysteresis's) under `PINNED_RESERVE_MAX` of alive time and no run
    // of `PINNED_RUN_S`; at any fuel under `PINNED_ANY_MAX` and no run twice that long.
    // At `d741b3d` (8 seeds): 58.9 % and 118 runs at the reserve, 62.9 % and a 199 s
    // run at any fuel. The any-fuel share cannot go to zero and should not: a bot
    // holding its stand-off on a rock face is "still and touching" too, and standard
    // bots measure 11–13 % on the same instrument.
    let share = |arm: &[BotRound], f: fn(&BotRound) -> u32| {
        total(arm, f) as f32 / total(arm, |r| r.alive).max(1) as f32
    };
    let longest = |f: fn(&BotRound) -> u32| space.iter().map(f).max().unwrap_or(0) as f32 * SIM_DT;
    let pinned = share(space, |r| r.pinned);
    if pinned >= PINNED_RESERVE_MAX || total(space, |r| r.runs) > 0 {
        failed.push(format!(
            "pinned against rock at the fuel reserve {:.1} % of alive time (bound {:.0} %), {} \
             runs of {PINNED_RUN_S} s, longest {:.0} s",
            100.0 * pinned,
            100.0 * PINNED_RESERVE_MAX,
            total(space, |r| r.runs),
            longest(|r| r.longest)
        ));
    }
    // At any fuel the **tail is a rate, not a maximum** (T22.03C): the longest run is
    // one draw from the tail and moved 13 → 49 s with the seed count (and 48 s at
    // `cb63610` over 96 seeds, before T22.03C touched anything) — a bot a vortex holds
    // against rock burns its tank to nothing and stays. Runs of `PINNED_RUN_S` a bot a
    // round: 2.4–2.5 at `d741b3d`, 0.02–0.04 after, bound `PINNED_ANY_RUNS_MAX`.
    let any = share(space, |r| r.pinned_any);
    let any_runs = total(space, |r| r.runs_any) as f32 / n_bots;
    if any >= PINNED_ANY_MAX || any_runs > PINNED_ANY_RUNS_MAX {
        failed.push(format!(
            "pinned against rock at any fuel {:.1} % (bound {:.0} %; standard {:.1} % on the \
             same instrument), {any_runs:.3} runs of {PINNED_RUN_S} s a bot a round (bound \
             {PINNED_ANY_RUNS_MAX}), longest {:.0} s",
            100.0 * any,
            100.0 * PINNED_ANY_MAX,
            100.0 * share(&arms[0], |r| r.pinned_any),
            longest(|r| r.longest_any),
        ));
    }
    // T22.03C (R95): **zone weapons are thrown in both modes** (the natural arms), a
    // thrower is hit by its own fire **no more often a throw in space than in
    // standard** (the molotov arms, where there are throws enough to divide by — the
    // criterion `BOT_SPACE_ZONE_REACH` was picked by), and space bots kill themselves
    // no more often than standard ones (the natural arms, the same run's control).
    for (arm, name) in [(&arms[0], "standard"), (space, "space")] {
        if total(arm, |r| r.zone_shots) == 0 {
            failed.push(format!("{name}: no zone weapon thrown in a natural round"));
        }
    }
    let own_hit = |arm: &[BotRound]| {
        arm.iter().map(|r| r.zone_self_dmg).sum::<f32>()
            / total(arm, |r| r.zone_shots).max(1) as f32
    };
    // (`BOTS_NATURAL` runs no molotov arms, and so checks nothing here.)
    let held = |i: usize| arms.get(i).map(Vec::as_slice).unwrap_or(&[]);
    let (std_hit, space_hit) = (own_hit(held(2)), own_hit(held(3)));
    // And the molotov itself is thrown in space — toxic grenades alone keep the natural
    // arm's count above zero (planted: the 1110 px reach back, and only this fired).
    if arms.len() > 3 && total(held(3), |r| r.flame_shots) == 0 {
        failed.push("molotov arm: no molotov thrown in space".to_string());
    }
    if arms.len() > 3 && (total(held(2), |r| r.zone_shots) == 0 || space_hit > std_hit) {
        failed.push(format!(
            "molotov arms: the thrower takes {space_hit:.2} hp of its own fire a throw in space \
             against {std_hit:.2} in standard ({} standard throws)",
            total(held(2), |r| r.zone_shots)
        ));
    }
    if total(space, |r| r.selfd) > total(&arms[0], |r| r.selfd) {
        failed.push(format!(
            "self-kills: {} in space, {} in standard",
            total(space, |r| r.selfd),
            total(&arms[0], |r| r.selfd)
        ));
    }
    assert!(failed.is_empty(), "space: {}", failed.join("; "));
}

/// T22.03D F2: player kills a bot a round the natural space arm must reach — 0.6 of
/// the measured 4.35 (8 seeds) / 4.02 (32) after T22.03D; 1.52 / 1.82 before it.
const SPACE_KILLS_FLOOR: f32 = 2.4;
/// T22.03D F1: the share of alive time a space bot may spend pinned against rock at
/// the fuel reserve — measured 3.5–4.0 % after, 51–59 % before.
const PINNED_RESERVE_MAX: f32 = 0.05;
/// T22.03D F1: the same at any fuel — measured 13–16 % after, 58–63 % before; the
/// bound is ~1.3× after and a third of before.
const PINNED_ANY_MAX: f32 = 0.2;
/// T22.03D F1 (as rewritten by T22.03C): any-fuel pinned runs of `PINNED_RUN_S` a bot
/// a round — measured 0.02–0.04 after (8 and 32 seeds), 2.4–2.5 before; the no-detour
/// plant 1.25.
const PINNED_ANY_RUNS_MAX: f32 = 0.1;

/// The full report. `cargo test -p game-core --release --test balance -- --ignored --nocapture`
#[test]
#[ignore = "measurement: minutes in release"]
fn balance_report() {
    let ws = weapons();
    println!(
        "\n== IN THE HAND — {} weapons x {} seeds x {BOTS} bots x {HOLD_SECONDS}s ==",
        ws.len(),
        SEEDS.len()
    );
    println!("   ground swept every tick, battery full; damage is per bot-second");
    println!(
        "\n{:<16}{:>10}{:>10}{:>8}{:>7}{:>8}{:>9}{:>11}{:>9}{:>9}",
        "weapon",
        "dmg/bot-s",
        "self/bot-s",
        "kills",
        "self",
        "fires",
        "dmg/pick",
        "denied px-s",
        "blind s",
        "deflect"
    );

    let bot_seconds = BOTS as f32 * HOLD_SECONDS * SEEDS.len() as f32;
    let mut rows = Vec::new();
    for d in &ws {
        let rounds: Vec<_> = SEEDS
            .iter()
            .map(|s| run(*s, Some(d.id), HOLD_SECONDS))
            .collect();
        let dmg: f32 = rounds.iter().map(|r| r.damage).sum();
        let selfd: f32 = rounds.iter().map(|r| r.self_damage).sum();
        let kills: u32 = rounds.iter().map(|r| r.combat_deaths).sum();
        let selfk: u32 = rounds.iter().map(|r| r.self_deaths).sum();
        let fires: u32 = rounds.iter().map(|r| r.fires).sum();
        let dps = dmg / bot_seconds;
        let sdps = selfd / bot_seconds;
        // Damage a full pickup can ever deal: `max_stack` shots times the def's
        // damage. dps alone makes a burst weapon look dominant while hiding that
        // it runs dry — a deagle carries 8 rounds and a pistol 40.
        let per_pick = match d.kind {
            ItemKind::Weapon(w) => def(w).map_or(0.0, |x| x.damage) * d.max_stack as f32,
            _ => 0.0,
        };
        let denied: f32 = rounds.iter().map(|r| r.denied_px_s).sum();
        let blind: f32 = rounds.iter().map(|r| r.blinded_s).sum();
        let deflect: u32 = rounds.iter().map(|r| r.deflect).sum();
        println!(
            "{:<16}{dps:>10.2}{sdps:>10.2}{kills:>8}{selfk:>7}{fires:>8}{per_pick:>9.0}\
             {denied:>11.0}{blind:>9.1}{deflect:>9}",
            d.key
        );
        let harmless =
            matches!(d.kind, ItemKind::Weapon(w) if def(w).is_some_and(|x| x.damage == 0.0));
        // A zone weapon is one whose payload lingers: it is judged on denial,
        // not on damage (§B24). Detected from what it actually did in the
        // measurement rather than from a flag on the def, so a new zone weapon
        // is classified correctly without anyone remembering to mark it.
        let zone = denied > 0.0 || blind > 0.0;
        // Can this weapon hurt its own user? Compared *within its class*, because
        // a hitscan gun structurally cannot: 14 of 20 sit at exactly 0.00, so an
        // arsenal-wide median of self-harm is 0.00 — a threshold nothing that
        // self-harms can ever be below, which made §B24's first criterion
        // unmeetable by construction.
        //
        // `blast_radius` is the wrong structural test: it doubles as the *carve*
        // radius, so an axe (10) and the smg (3) read as explosive. The class is
        // therefore "weapons that demonstrably hurt their user in the
        // measurement" — not circular, because the question is whether this one
        // is an outlier *among those that do it at all*.
        let can_self_harm = sdps > 0.0;
        rows.push((
            d.key,
            dps,
            fires,
            harmless,
            sdps,
            denied,
            blind,
            deflect,
            zone,
            can_self_harm,
        ));
    }

    // A weapon with zero damage in its def is not an outlier, it is smoke
    // (§B7: "the only one with no damage at all"). Judging it against a damage
    // median reports a weapon working exactly as specified as the worst in the
    // game, which is how a report loses the reader's trust.
    // Zone weapons are excluded from the damage median for the same reason
    // smoke already was: a weapon that works by keeping people off ground
    // damages nobody when it works, so scoring it against a damage median
    // reports success as failure (§B24).
    let med = median(
        rows.iter()
            .filter(|r| !r.3 && !r.8)
            .map(|r| r.1)
            .collect::<Vec<_>>(),
    );
    let peers: Vec<f32> = rows.iter().filter(|r| r.9).map(|r| r.4).collect();
    let med_self = median(peers.clone());
    println!("\n   median dmg/bot-s  = {med:.2}  (direct-damage weapons only)");
    println!(
        "   median self/bot-s = {med_self:.2}  (over the {} weapons that CAN hurt their user)",
        peers.len()
    );
    let mut outliers = Vec::new();
    for (key, dps, fires, harmless, sdps, denied, blind, deflect, zone, can_self_harm) in &rows {
        if *fires == 0 {
            outliers.push(format!("{key}: never fired"));
            continue;
        }
        if *zone {
            // §B24's criteria: self-harm ordinary for its kind, denial real.
            if *can_self_harm && *sdps > med_self {
                outliers.push(format!(
                    "{key}: self {sdps:.2} above the {med_self:.2} median of weapons that can"
                ));
            }
            if *denied <= 0.0 && *blind <= 0.0 {
                outliers.push(format!("{key}: a zone weapon that denied nothing"));
            }
            // Deflections are how ground denial is *felt*. A weapon that denies
            // sight rather than ground moves nobody by design — requiring it to
            // would report smoke, working exactly as §B7 specifies, as broken.
            if *denied > 0.0 && *deflect == 0 {
                outliers.push(format!("{key}: denied ground but moved nobody"));
            }
            continue;
        }
        if *harmless {
            continue;
        }
        if *dps > med * 2.0 {
            outliers.push(format!("{key}: {dps:.2} = {:.1}x median", dps / med));
        } else if *dps < med * 0.5 {
            outliers.push(format!("{key}: {dps:.2} = {:.2}x median", dps / med));
        }
    }
    if outliers.is_empty() {
        println!("   no weapon outside [0.5x, 2x] median");
    } else {
        println!("   OUTLIERS ({}):", outliers.len());
        for o in &outliers {
            println!("     {o}");
        }
    }

    println!(
        "\n== IN THE POOL — {} seeds x {POOL_SECONDS}s, natural spawning ==",
        SEEDS.len()
    );
    let pool: Vec<_> = SEEDS.iter().map(|s| run(*s, None, POOL_SECONDS)).collect();
    let total_w: u32 = ITEMS.iter().map(|d| d.spawn_weight as u32).sum();
    let picked_total: u32 = pool.iter().flat_map(|r| r.picks.values()).sum();
    println!("   {picked_total} pickups over {} rounds\n", pool.len());
    println!(
        "{:<16}{:>8}{:>10}{:>9}{:>9}",
        "item", "weight", "weight %", "spawned", "picked"
    );
    let mut unobtained = Vec::new();
    for d in ITEMS {
        let spawned: u32 = pool
            .iter()
            .map(|r| *r.spawned.get(&d.id).unwrap_or(&0))
            .sum();
        let picked: u32 = pool.iter().map(|r| *r.picks.get(&d.id).unwrap_or(&0)).sum();
        println!(
            "{:<16}{:>8}{:>9.1}%{spawned:>9}{picked:>9}",
            d.key,
            d.spawn_weight,
            100.0 * d.spawn_weight as f32 / total_w as f32,
        );
        if spawned == 0 {
            unobtained.push(d.key);
        }
    }
    if unobtained.is_empty() {
        println!("\n   every item spawned at least once");
    } else {
        println!("\n   NEVER SPAWNED ({}): {unobtained:?}", unobtained.len());
        println!("   a weapon nobody can pick up is a spawn-weight bug, not a balance result");
    }
}

// ---------------------------------------------------------------------------
// T11.13 — density (`docs/71-amendments-v3.md` §B17, `tasks/M11/T11.13`)
// ---------------------------------------------------------------------------

/// Distinct item **types** a round shows you, plus the things that bound it.
///
/// Density is not weight (§B17). Weights decide *which* item; `initial_items`
/// and `ITEM_SPAWN_INTERVAL` decide *how many*, and no weight change can make a
/// round show you more of a 24-item registry than it spawns.
///
/// `evicted` is the reason this cannot simply be turned up: `MAX_WORLD_ITEMS`
/// evicts the **oldest non-crate** first, so past a point a higher rate deletes
/// what spawned two minutes ago instead of adding to it — churn, not density.
#[derive(Debug, Default)]
struct Density {
    distinct: usize,
    spawned: u32,
    /// Items on the ground before the clock starts — `initial_items`, which is
    /// per scale (8 / 14 / 20) and which `ITEM_SPAWN_INTERVAL` does not touch.
    initial: u32,
    /// Items the **periodic stream** produced during the round. Split from
    /// `spawned` by T20.26: a floor on the total is carried by the initial
    /// placement, which is exactly why `mean_spawn > 10.0` survived the interval
    /// being tripled.
    periodic: u32,
    live_peak: usize,
    evicted: u32,
    first_weapon_s: Option<f32>,
}

fn density(seed: u64, seconds: f32, scale: MapScale) -> Density {
    let mut w = World::new(seed, scale);
    w.set_phase(RoundPhase::Playing);
    for i in 0..BOTS {
        w.add_player(i as u8, 0, format!("Bot {i}"));
    }
    let mut bots: Vec<_> = (0..BOTS)
        .map(|i| Bot::new(i as u8, seed, i as u32, SKILL))
        .collect();
    let _ = w.drain_events();

    let mut d = Density::default();
    let mut seen: std::collections::BTreeSet<u16> = Default::default();
    // Initial placement runs inside `World::new`, before any event buffer
    // exists (the same fact that made T9.03's initial items unannounced), so
    // counting spawn *events* misses it entirely and undercounts a round's
    // variety by the whole initial batch. Read the world instead.
    for it in w.items.iter() {
        seen.insert(it.item);
        d.spawned += 1;
        d.initial += 1;
    }
    let ticks = (seconds / SIM_DT) as u32;
    for t in 0..ticks {
        let now = t as f32 * SIM_DT;
        for b in bots.iter_mut() {
            let inp = b.think(&w, now, SIM_DT);
            w.queue_input(b.player, inp);
            if let Some(slot) = b.wants_select() {
                w.select_slot(b.player, slot);
            }
            if inp.buttons & button::FIRE != 0 {
                let _ = w.fire(b.player, now);
            }
        }
        w.step(SIM_DT);
        d.live_peak = d.live_peak.max(w.items.iter().count());
        for e in w.drain_events() {
            match e {
                GameEvent::ItemSpawn { item_id, .. } => {
                    seen.insert(item_id);
                    d.spawned += 1;
                    d.periodic += 1;
                    if d.first_weapon_s.is_none()
                        && ITEMS
                            .iter()
                            .any(|x| x.id == item_id && matches!(x.kind, ItemKind::Weapon(_)))
                    {
                        d.first_weapon_s = Some(now);
                    }
                }
                GameEvent::ItemDespawn { .. } => d.evicted += 1,
                _ => {}
            }
        }
    }
    d.distinct = seen.len();
    d
}

/// `cargo test -p game-core --release --test balance -- --ignored --nocapture`
#[test]
#[ignore = "measurement: minutes in release"]
fn density_report() {
    // **The pool, not the registry.** §F5 leaves six entries that can never be
    // drawn — five retired melee placeholders (kept because `ITEMS` is
    // id-indexed and deleting them renumbers everything above, §B16) and the
    // shovel, which everybody is issued at spawn. A round cannot show you an
    // item that has no weight in any column, so a "distinct of `ITEMS.len()`"
    // reading now has an unreachable ceiling.
    let pool = ITEMS
        .iter()
        .filter(|d| d.spawn_weight > 0 || d.crate_weight > 0 || d.buried_weight > 0)
        .count();
    println!("\n== DENSITY — {} seeds x {POOL_SECONDS}s ==", SEEDS.len());
    println!(
        "   registry holds {} item types, {pool} of them drawable",
        ITEMS.len()
    );
    assert!(
        pool >= 15,
        "only {pool} items can spawn at all — the measurement below is about a \
         collapsed table, not about density"
    );
    // Every scale the game can ship, not just the fast one. §A19: a threshold
    // measured on one scale is tuned to that scale, and `DEFAULT_MAP_SCALE` is
    // Large — measuring only Small would tune the number where it does not
    // matter and leave it unmeasured where it does.
    // Floors, not exact values: the seeded spawn stream reshuffles whenever the
    // registry changes (§B17), so pinning a number here would make adding an
    // item a test failure. These are the T11.09 baselines the tuning had to beat
    // — Small 51%, Medium 58%, Large 64% of a 24-item registry.
    //
    // **Re-derived by §F5, and it is the denominator that moved.** The three
    // numbers were absolute counts — 12.5, 14.5 and 16.0 — set against a
    // 24-entry registry in which every entry could be drawn. §F5 takes five
    // weapons out of the draw and adds a sixth that is issued rather than found,
    // so the same absolute count now demands a much larger share of a pool of
    // 19: Medium measured 13.8 against a floor of 14.5 the moment the weights
    // were zeroed, with nothing about the spawn machinery changed. Holding the
    // absolute number would have been a floor that tracks the size of the
    // registry rather than the health of a round.
    //
    // So they are held as the **same fractions of the drawable pool**, written
    // as the original count over the original pool so the derivation is visible
    // rather than a decimal nobody can check. Measured after this change:
    // Small 14.6, Medium 13.8, Large 15.4 of 19.
    const DERIVED_FROM_POOL: f32 = 24.0;
    let share = |old: f32| old / DERIVED_FROM_POOL * pool as f32;
    let floors = [
        (MapScale::Small, share(12.5)),
        (MapScale::Medium, share(14.5)),
        (MapScale::Large, share(16.0)),
    ];
    for (scale, floor) in floors {
        let ds: Vec<_> = SEEDS
            .iter()
            .map(|s| density(*s, POOL_SECONDS, scale))
            .collect();
        let mean_distinct = ds.iter().map(|d| d.distinct).sum::<usize>() as f32 / ds.len() as f32;
        let mean_spawn = ds.iter().map(|d| d.spawned).sum::<u32>() as f32 / ds.len() as f32;
        let peak = ds.iter().map(|d| d.live_peak).max().unwrap_or(0);
        let evict: u32 = ds.iter().map(|d| d.evicted).sum();
        let first: Vec<f32> = ds.iter().filter_map(|d| d.first_weapon_s).collect();
        println!(
            "\n   {scale:?}: distinct {mean_distinct:.1}/{} ({:.0}%)  spawns {mean_spawn:.1}  \
             peak live {peak}/{}  despawns {evict}  1st weapon {:.0}s",
            pool,
            100.0 * mean_distinct / pool as f32,
            game_core::constants::MAX_WORLD_ITEMS,
            // `sum / len.max(1)` printed **0 s** for a round in which no
            // weapon ever spawned — the healthiest possible number for the worst
            // possible outcome (T20.26). `NaN` prints as `NaN` and cannot be
            // mistaken for a good reading.
            if first.is_empty() {
                f32::NAN
            } else {
                first.iter().sum::<f32>() / first.len() as f32
            },
        );
        assert!(
            mean_distinct >= floor,
            "{scale:?}: a round shows {mean_distinct:.1} of {pool} drawable item types, below \
             the {floor:.1} that is T11.09's share of the pool — density regressed"
        );
        // Density is turnover, not accumulation. If raising the rate ever pushes
        // the live count into `MAX_WORLD_ITEMS`, the cap starts evicting the
        // oldest non-crate item and a higher rate deletes what spawned two
        // minutes ago instead of adding to it — churn that looks like density.
        assert!(
            peak < game_core::constants::MAX_WORLD_ITEMS,
            "{scale:?}: {peak} items alive against a cap of {} — eviction is now routine",
            game_core::constants::MAX_WORLD_ITEMS
        );
        // Control: without this, both assertions above pass for a round that
        // spawned nothing at all.
        assert!(
            mean_spawn > 10.0,
            "{scale:?}: only {mean_spawn:.1} spawns — the measurement proves nothing"
        );
    }
}

// ---------------------------------------------------------------------------
// T11.16 — encounter rate (§B27)
// ---------------------------------------------------------------------------

/// One round's encounter record.
///
/// Two measures, not one, and the gap between them is the point: `near` counts
/// ticks where a pair is within sight *range*, `los` counts ticks where the line
/// between them is also clear. If `near` is high and `los` is low, terrain is
/// what keeps players apart; if both are low, distance is. Tuning the wrong one
/// of those does nothing, which is why the decomposition comes before the lever.
#[derive(Debug, Default, Clone)]
struct Encounters {
    first_s: Option<f32>,
    /// Rising edges of "at least one pair in sight with a clear line", not
    /// ticks — a pair standing together for ten seconds is one encounter, and
    /// counting ticks would score a stalemate as the healthiest round measured.
    starts: u32,
    near_ticks: u32,
    los_ticks: u32,
    ticks: u32,
    damage: f32,
    /// The links after "can see each other". A high `near` with zero `damage`
    /// is a different problem from never meeting, and only these tell them
    /// apart.
    fires: u32,
    ticks_armed: u32,
}

fn clear_line(w: &World, a: Vec2, b: Vec2) -> bool {
    let dist = (b - a).len();
    let steps = (dist / 8.0).ceil() as u32;
    let mut blocked = 0u32;
    for i in 1..steps {
        let t = i as f32 / steps as f32;
        let p = a + (b - a) * t;
        if game_core::physics::collide::solid_at(&w.map, p.x as i32, p.y as i32) {
            blocked += 1;
            // Same tolerance the bot's own firing check uses. A weapon that
            // carves treats a thin rise as cover to remove, so a couple of
            // samples of rock is not "cannot see each other".
            if blocked > 24 {
                return false;
            }
        }
    }
    true
}

/// A normal round: real item spawns, no forced loadout, no ground sweep. The
/// balance harness sweeps and arms because it is isolating one weapon; this is
/// measuring the game as it ships, so it must not.
fn encounters(seed: u64, scale: MapScale, bot_count: usize, seconds: f32) -> Encounters {
    let mut w = World::new(seed, scale);
    w.set_phase(RoundPhase::Playing);
    let mut bots = Vec::new();
    for i in 0..bot_count {
        let id = i as u8;
        w.add_player(id, 0, format!("Bot {i}"));
        bots.push(Bot::new(id, seed, i as u32, SKILL));
    }
    let _ = w.drain_events();

    let mut r = Encounters::default();
    let mut engaged = false;
    r.ticks = (seconds / SIM_DT) as u32;
    for t in 0..r.ticks {
        let now = t as f32 * SIM_DT;
        for b in bots.iter_mut() {
            let inp = b.think(&w, now, SIM_DT);
            w.queue_input(b.player, inp);
            if let Some(slot) = b.wants_select() {
                w.select_slot(b.player, slot);
            }
            if inp.buttons & button::FIRE != 0 {
                let _ = w.fire(b.player, now);
            }
            if let Some(slot) = b.wants_use() {
                let _ = w.use_item(b.player, slot, now);
            }
        }
        w.step(SIM_DT);

        let live: Vec<Vec2> = bots
            .iter()
            .filter_map(|b| w.player(b.player).filter(|p| p.alive).map(|p| p.body.pos))
            .collect();
        let mut near = false;
        let mut los = false;
        for i in 0..live.len() {
            for j in (i + 1)..live.len() {
                if (live[i] - live[j]).len() <= FOV_DAY {
                    near = true;
                    if clear_line(&w, live[i], live[j]) {
                        los = true;
                    }
                }
            }
        }
        if near {
            r.near_ticks += 1;
        }
        if los {
            r.los_ticks += 1;
            if !engaged {
                r.starts += 1;
                engaged = true;
                r.first_s.get_or_insert(now);
            }
        } else {
            engaged = false;
        }

        for e in w.drain_events() {
            if let GameEvent::Damage {
                amount,
                attacker: Some(a),
                victim,
                ..
            } = e
            {
                if a != victim {
                    r.damage += amount;
                }
            }
        }
    }
    for b in &bots {
        let st = b.stats();
        r.fires += st.fires;
        r.ticks_armed += st.ticks_armed;
    }
    r
}

// ---------------------------------------------------------------------------
// T20.16 — the acceptance test, and the control that has to fail it
// ---------------------------------------------------------------------------

/// The control configuration: the shipping map, with **two seats**.
///
/// **One axis, and the axis is seats.** The control this replaced was `Large`
/// with 4 players against a shipping `Medium` with 6 — two axes at once, so it
/// could never say which one the floors were sensitive to (T20.16).
///
/// Two seats is one pair; the shipping six is fifteen. Every meeting in this
/// simulation is a pair meeting, so the shipping configuration has fifteen times
/// the opportunities — and that is the whole sentence. It is not a tuned number:
/// **2 is the smallest seat count at which combat is possible at all**, so it is
/// the structural floor of this axis rather than a value chosen to make a
/// margin work.
const CONTROL_SEATS: usize = 2;

/// Per seed, the share of the round with two live players in each other's sight
/// **and** a clear line between them.
///
/// **Measured at `177108b`, `--release`, 8 seeds x `ROUND_SECONDS`:** the
/// shipping configuration's *worst* seed is **49.7 %** and its best is 100 %, so
/// this floor of 10 % carries a **5.0x margin on the worst draw**. The control
/// reads **0.0 % on all eight seeds**, and the retired `Large`-4 control read
/// 0.0 % on five of eight with a pooled 14.4 %.
///
/// Per seed rather than pooled, because the claim is *"no round is a walk in an
/// empty park"*, and a pooled share is satisfied by two seeds of stalemate. Two
/// shipping seeds sit at 98.6 % and 100 % — one pair that met and never
/// separated — and a pooled number would let those two carry six dead ones.
const SEED_LOS_FLOOR: f32 = 10.0;

/// Damage dealt between players, summed over every seed.
///
/// **Measured at `177108b`, `--release`:** shipping **2117** against this floor
/// of 1000, a **2.1x margin**; the control totals **27** (78x below shipping)
/// and the retired `Large`-4 control totalled 411.
///
/// Pooled, because this one *is* a population claim about the configuration and
/// not about any round: some rounds end in a chase and some in a brawl, and a
/// per-seed damage floor would be a claim about pacing that nobody has made.
const POOLED_DAMAGE_FLOOR: f32 = 1000.0;

/// What the floors say, and which of them a configuration fails.
///
/// Returned rather than asserted, so **the same function judges the shipping
/// configuration and the control**. That is the whole point of a control: the
/// floors must be the identical floors, or "the control fails them" is a claim
/// about two different tests (`CLAUDE.md`: share the guard, or share the
/// function).
fn floor_failures(rs: &[Encounters]) -> Vec<String> {
    // `zip` truncates to the shorter side without saying so, and this function's
    // whole output is "which seeds failed" — a caller that passed six rounds
    // would get a clean bill for eight seeds. Count both ends.
    assert_eq!(
        rs.len(),
        SEEDS.len(),
        "floor_failures was given {} rounds for {} seeds — the per-seed floor \
         would silently skip the difference",
        rs.len(),
        SEEDS.len()
    );
    let mut out = Vec::new();
    for (seed, r) in SEEDS.iter().zip(rs) {
        let los = 100.0 * r.los_ticks as f32 / r.ticks.max(1) as f32;
        if los < SEED_LOS_FLOOR {
            out.push(format!(
                "seed {seed}: {los:.1}% of the round in sight, under the {SEED_LOS_FLOOR:.0}% floor"
            ));
        }
    }
    let dmg: f32 = rs.iter().map(|r| r.damage).sum();
    if dmg < POOLED_DAMAGE_FLOOR {
        out.push(format!(
            "pooled damage {dmg:.0} over {} seeds, under the {POOLED_DAMAGE_FLOOR:.0} floor",
            rs.len()
        ));
    }
    out
}

/// One line of report, and the margin each floor is currently clearing.
///
/// **Criterion 3 of T20.16: the margin is printed, not merely asserted**, so a
/// run of `scripts/ignored.sh` shows a floor being approached rather than the
/// next person discovering it exhausted. `capacity.rs::max_rooms_carries_its_basis`
/// is the same idea pointed at a constant's doc comment; this points it at the
/// running measurement.
fn report(label: &str, rs: &[Encounters]) {
    let per_seed: Vec<f32> = rs
        .iter()
        .map(|r| 100.0 * r.los_ticks as f32 / r.ticks.max(1) as f32)
        .collect();
    let worst = per_seed.iter().copied().fold(f32::INFINITY, f32::min);
    let pooled_dmg: f32 = rs.iter().map(|r| r.damage).sum();
    let starts: u32 = rs.iter().map(|r| r.starts).sum();
    // `fought` is printed and **not asserted on**, and T20.16 is why. It counts
    // seeds with any damage at all, and "any" includes a single point of splash
    // from a hazard nobody saw: the two-seat control scores **4/8 on it while
    // producing zero encounters across all eight seeds**. A statistic that
    // saturates on trace damage cannot separate a fight from an empty map, which
    // is how the retired control sat at 6/8 against a shipping 7/8 and was read
    // as a one-seed margin rather than as a broken instrument.
    let fought = rs.iter().filter(|r| r.damage > 0.0).count();
    println!(
        "\n== {label} — {} seeds x {ROUND_SECONDS}s ==\n   \
         worst-seed sight {worst:.1}% (floor {SEED_LOS_FLOOR:.0}%, margin {:.1}x)  \
         pooled damage {pooled_dmg:.0} (floor {POOLED_DAMAGE_FLOOR:.0}, margin {:.1}x)\n   \
         encounters {starts}   fought {fought}/{} (reported, never asserted — see `report`)",
        rs.len(),
        worst / SEED_LOS_FLOOR,
        pooled_dmg / POOLED_DAMAGE_FLOOR,
        rs.len(),
    );
}

/// The acceptance test for T11.16, re-shaped by T20.16, measuring the
/// configuration the game actually ships over the round length it actually runs.
///
/// **What changed, and why the old shape could not be repaired by picking a new
/// number.** The floors were `fought >= 6`, `first < 45.0`, and
/// `before_fought < fought` against a `Large`-4 control.
///
/// - `fought` counts seeds with **any** damage, so it saturates: see `report`.
/// - `first < 45.0` was satisfied by a measured **1.3 s** — a factor of 34 — so
///   it asserted almost nothing (T20.17). It is not carried over. What it was
///   reaching for, *"they find each other"*, is said by `SEED_LOS_FLOOR` and
///   said per seed, which is strictly harder: the retired control passed
///   `first < 45.0` on the seeds it met at all and fails the sight floor on
///   **seven of eight**.
/// - `before_fought < fought` compared **6 to 7** across configurations
///   differing on two axes, so it could not attribute the difference and had one
///   seed of margin. It was tripped once inside M20 by animals, untripped again
///   by something later in the same milestone, and the shipping side then moved
///   7/8 -> 8/8 between two commits of ordinary work.
///
/// The replacement asserts the same floors against both configurations and
/// requires the control to **fail** them — which is what a control is for, and
/// what keeps the floors from passing for any configuration at all.
///
/// **Falsified at the production binding site, and the old shape was run beside
/// it.** Planting `FOV_DAY` 320 -> 80 in `constants.rs` — a sight regression, the
/// kind of drift this file exists to catch:
///
/// - this test goes red **on the thing that regressed**: *"seed 7: 5.7 % of the
///   round in sight, under the 10 % floor"*, and names seed 4242 too;
/// - the old floors, evaluated on the same planted build, go red **only on
///   `before_fought < fought`** — `fought` still read 7/8 and passed its `>= 6`,
///   and mean first contact moved 1.3 s -> 4.2 s and still passed `< 45.0`.
///
/// So the old test would have failed, through the one comparison T20.16 calls
/// unsound and by the coincidence that the control moved with it, while both of
/// its substantive floors watched a fourfold regression and reported nothing.
/// That is the difference the reshaping buys, and it is measured rather than
/// argued.
///
/// **What this test does not cover, stated so nobody infers it:** spawn density.
/// Planting `ITEM_SPAWN_INTERVAL` 14 -> 42 leaves this test green (worst-seed
/// sight 63.3 %, pooled damage 2676) and it should — this measures whether
/// players meet, not what is on the ground. `density_report` owns the variety
/// half of that claim and `the_spawn_stream_beats_the_wait_it_replaced` owns the
/// rate half — T20.26 booked the second because the first could not see the
/// plant.
#[test]
#[ignore = "measurement: 3.7 s in release, measured (T20.17 clocked the old shape at 6.7 s)"]
fn the_shipping_configuration_produces_a_fight() {
    let plrs = BOT_COUNT_DEFAULT + 1;
    let ship: Vec<_> = SEEDS
        .iter()
        .map(|s| encounters(*s, DEFAULT_MAP_SCALE, plrs, ROUND_SECONDS))
        .collect();
    report(
        &format!("SHIPPING — {DEFAULT_MAP_SCALE:?}, {plrs} seats"),
        &ship,
    );

    let control: Vec<_> = SEEDS
        .iter()
        .map(|s| encounters(*s, DEFAULT_MAP_SCALE, CONTROL_SEATS, ROUND_SECONDS))
        .collect();
    report(
        &format!("CONTROL — {DEFAULT_MAP_SCALE:?}, {CONTROL_SEATS} seats (one pair, not fifteen)"),
        &control,
    );

    let ship_failed = floor_failures(&ship);
    assert!(
        ship_failed.is_empty(),
        "the shipping configuration missed its floors:\n  {}",
        ship_failed.join("\n  ")
    );

    // The control. **Not `control_x < ship_x`** — that is a comparison of two
    // numbers and it passed at 6 versus 7. This asserts that the floors
    // themselves reject the control, so a floor lowered far enough to be
    // meaningless goes red here rather than going quiet.
    let control_failed = floor_failures(&control);
    assert!(
        !control_failed.is_empty(),
        "the {CONTROL_SEATS}-seat control cleared every floor the shipping \
         configuration cleared — the floors do not measure the change"
    );
    // And it must fail *structurally*, not by one seed: a control that scrapes
    // under one floor on one seed is the marginal shape all over again.
    // Measured: **9 failures** — all eight seeds under the sight floor, plus the
    // pooled damage floor.
    assert!(
        control_failed.len() > SEEDS.len(),
        "the control failed only {} of the {} floor checks ({:?}) — a control \
         that barely fails is the marginal control T20.16 replaced",
        control_failed.len(),
        SEEDS.len() + 1,
        control_failed
    );
}

/// The floors must carry the measurement that justifies them.
///
/// **Gate-resident on purpose, and it buys less than it looks like.** T20.17's
/// finding was that a doc comment can drift while the code stays put, and a
/// companion test pinned to a comment stays green through exactly that. So this
/// does **not** stand in for running the measurement — `scripts/ignored.sh` is
/// the only thing that does. What it buys is that the numbers above cannot be
/// silently deleted or replaced by a bare value, which is the state the retired
/// control was in: its margin lived in a comment that had been wrong for nine
/// milestones and nothing read it.
///
/// Checks for **numbers and a margin**, not for a token: `capacity.rs`'s first
/// version accepted the string `"T10.07"` that the placeholder already
/// contained, and so passed against precisely the state it existed to reject.
#[test]
fn the_balance_floors_record_their_basis() {
    let src = include_str!("balance.rs");
    for name in [
        "SEED_LOS_FLOOR",
        "POOLED_DAMAGE_FLOOR",
        // T20.26. Its basis is a quotation rather than a fresh measurement, and
        // `the_wait_ceiling_is_still_the_one_the_constant_records` guards the
        // quotation itself; this guards that the numbers behind it are written
        // down here rather than left to the reader to go and find.
        "WEAPON_WAIT_CEILING_S",
    ] {
        let decl = format!("const {name}");
        let i = src
            .find(&decl)
            .unwrap_or_else(|| panic!("{name} must exist — this test cannot find what it guards"));
        let doc_start = src[..i].rfind("\n\n").unwrap_or(0);
        let doc = &src[doc_start..i];
        let digits = doc.chars().filter(char::is_ascii_digit).count();
        assert!(
            doc.contains("Measured"),
            "{name} must record where its number came from. Doc was:\n{doc}"
        );
        assert!(
            doc.contains("margin") || doc.contains('x'),
            "{name} must record the margin it currently clears, so erosion is \
             visible before exhaustion. Doc was:\n{doc}"
        );
        assert!(
            digits >= 6,
            "{name}'s basis has only {digits} digits in it — a measurement is \
             numbers, not a promise of numbers. Doc was:\n{doc}"
        );
    }
}

#[test]
#[ignore = "measurement: minutes in release"]
fn encounter_report() {
    println!(
        "\n== ENCOUNTERS — {} seeds x {POOL_SECONDS}s, sight {FOV_DAY:.0}px ==",
        SEEDS.len()
    );
    println!("   shipping config is {DEFAULT_MAP_SCALE:?} with {BOT_COUNT_DEFAULT} bots + 1 human");
    println!(
        "\n   {:<8} {:>5}  {:>6}  {:>7}  {:>7}  {:>7}  {:>6}  {:>6}  {:>6}  {:>7}",
        "scale", "plrs", "fought", "1st", "gap", "near%", "los%", "armed%", "fires", "dmg"
    );

    for scale in [MapScale::Small, MapScale::Medium, MapScale::Large] {
        for plrs in [4usize, 6] {
            let rs: Vec<_> = SEEDS
                .iter()
                .map(|s| encounters(*s, scale, plrs, POOL_SECONDS))
                .collect();
            let fought = rs.iter().filter(|r| r.damage > 0.0).count();
            let firsts: Vec<f32> = rs.iter().filter_map(|r| r.first_s).collect();
            let first = if firsts.is_empty() {
                f32::NAN
            } else {
                firsts.iter().sum::<f32>() / firsts.len() as f32
            };
            let starts: u32 = rs.iter().map(|r| r.starts).sum();
            let secs = POOL_SECONDS * rs.len() as f32;
            let gap = if starts == 0 {
                f32::INFINITY
            } else {
                secs / starts as f32
            };
            let ticks: u32 = rs.iter().map(|r| r.ticks).sum();
            let near = 100.0 * rs.iter().map(|r| r.near_ticks).sum::<u32>() as f32 / ticks as f32;
            let los = 100.0 * rs.iter().map(|r| r.los_ticks).sum::<u32>() as f32 / ticks as f32;
            let armed = 100.0 * rs.iter().map(|r| r.ticks_armed).sum::<u32>() as f32
                / (ticks * plrs as u32) as f32;
            let fires = rs.iter().map(|r| r.fires).sum::<u32>() as f32 / rs.len() as f32;
            let dmg = rs.iter().map(|r| r.damage).sum::<f32>() / rs.len() as f32;
            println!(
                "   {:<8} {plrs:>5}  {fought:>3}/{}  {first:>6.0}s  {gap:>6.1}s  {near:>6.1}%  \
                 {los:>5.1}%  {armed:>5.1}%  {fires:>6.0}  {dmg:>6.0}",
                format!("{scale:?}"),
                rs.len(),
            );
        }
    }
}

// ---------------------------------------------------------------------------
// T20.06 — standing population (`tasks/M20/T20.06`)
// ---------------------------------------------------------------------------

/// How much of a round each item is **on the ground for**, and what removes it.
///
/// **The instrument T20.06 says does not exist, and it did not.** The share
/// tables in this file and in `melee.rs` measure `roll_item` — no map, no clock,
/// no TTL, no cap — and every remaining candidate cause acts *after* the draw:
/// `WORLD_ITEM_TTL` evaporates a ground item after 70 s and `MAX_WORLD_ITEMS`
/// evicts the oldest non-crate. A draw-share instrument is blind to both and
/// cannot separate volume from either.
///
/// So: **item-seconds**, which is the quantity a player's "I have never seen
/// any" is actually about. An item that spawns and is picked up in two seconds
/// and one that lies untouched for seventy are one draw each and thirty-five
/// times apart in how often anybody walks past one.
///
/// The three removals are counted **separately**, because they say different
/// things and the world's own `ItemDespawn` event carries neither a reason nor
/// an item id — it cannot tell them apart, so this reconstructs them from the
/// item table each tick. Merging them is how "churn that measures like density"
/// (`ITEM_SPAWN_INTERVAL`'s own doc comment) hides.
#[derive(Debug, Default, Clone)]
struct Population {
    /// item id -> seconds that item spent lying in the world, summed over copies.
    alive_s: BTreeMap<ItemId, f64>,
    spawned: BTreeMap<ItemId, u32>,
    picked: BTreeMap<ItemId, u32>,
    /// Removed by `WORLD_ITEM_TTL`.
    expired: BTreeMap<ItemId, u32>,
    /// Removed by neither a pickup nor the TTL: the `MAX_WORLD_ITEMS` cap, a
    /// blast, or falling out of the bottom of the map (§C15).
    ///
    /// **Not "evicted", because those three are not the same thing** and the
    /// world does not say which: `ItemDespawn` carries no reason and no item id.
    /// What separates them here is `live_peak` — the cap can only fire at
    /// `MAX_WORLD_ITEMS` live, so a peak well under it rules eviction out for the
    /// whole run, and what is left is the void and the blasts.
    removed_other: BTreeMap<ItemId, u32>,
    live_peak: usize,
}

fn bump_map<K: Ord>(m: &mut BTreeMap<K, u32>, k: K) {
    *m.entry(k).or_default() += 1;
}

fn population(seed: u64, seconds: f32, scale: MapScale) -> Population {
    let mut w = World::new(seed, scale);
    w.set_phase(RoundPhase::Playing);
    for i in 0..BOTS {
        w.add_player(i as u8, 0, format!("Bot {i}"));
    }
    let mut bots: Vec<_> = (0..BOTS)
        .map(|i| Bot::new(i as u8, seed, i as u32, SKILL))
        .collect();
    let _ = w.drain_events();

    let mut p = Population::default();
    // Initial placement happens inside `World::new`, before any event buffer
    // exists, so it is read off the table rather than counted from events — the
    // same fact `density` records above.
    let mut live: BTreeMap<game_core::items::world::WorldItemId, (ItemId, f32)> = BTreeMap::new();
    for it in w.items.iter() {
        bump_map(&mut p.spawned, it.item);
        live.insert(it.id, (it.item, it.spawned_at));
    }

    let ticks = (seconds / SIM_DT) as u32;
    for t in 0..ticks {
        let now = t as f32 * SIM_DT;
        for b in bots.iter_mut() {
            let inp = b.think(&w, now, SIM_DT);
            w.queue_input(b.player, inp);
            if let Some(slot) = b.wants_select() {
                w.select_slot(b.player, slot);
            }
            if inp.buttons & button::FIRE != 0 {
                let _ = w.fire(b.player, now);
            }
        }
        w.step(SIM_DT);

        // Who was picked up this tick, so a pickup is not attributed to the cap.
        let mut picked_ids = Vec::new();
        for e in w.drain_events() {
            if let GameEvent::ItemPickup { world_item_id, .. } = e {
                picked_ids.push(world_item_id);
            }
        }

        let mut now_live: BTreeMap<game_core::items::world::WorldItemId, (ItemId, f32)> =
            BTreeMap::new();
        for it in w.items.iter() {
            now_live.insert(it.id, (it.item, it.spawned_at));
            *p.alive_s.entry(it.item).or_default() += SIM_DT as f64;
            if !live.contains_key(&it.id) {
                bump_map(&mut p.spawned, it.item);
            }
        }
        p.live_peak = p.live_peak.max(now_live.len());

        for (id, (item, spawned_at)) in &live {
            if now_live.contains_key(id) {
                continue;
            }
            if picked_ids.contains(id) {
                bump_map(&mut p.picked, *item);
            } else if now - *spawned_at >= WORLD_ITEM_TTL {
                // The same test `cull` applies, evaluated on the same clock.
                bump_map(&mut p.expired, *item);
            } else {
                // Not picked up and not old enough to time out.
                bump_map(&mut p.removed_other, *item);
            }
        }
        live = now_live;
    }
    p
}

/// `cargo test -p game-core --release --test balance -- --ignored --nocapture`
///
/// **Reported: "spawn more battery packs. They are useful but I've never seen
/// any so far."** T20.06's four candidate causes are (1) the pickup is invisible
/// on the HUD, (2) volume, (3) `WORLD_ITEM_TTL`, (4) `MAX_WORLD_ITEMS`. This
/// separates 2, 3 and 4; cause 1 is settled on the screen, in
/// `scripts/checks/hud-bars.mjs`.
#[test]
#[ignore = "measurement: minutes in release"]
fn item_population_report() {
    println!(
        "\n== POPULATION — {} seeds x {POOL_SECONDS}s ==",
        SEEDS.len()
    );
    let battery = game_core::items::registry::BATTERY_PACK;
    for scale in [MapScale::Small, MapScale::Medium, MapScale::Large] {
        let ps: Vec<_> = SEEDS
            .iter()
            .map(|s| population(*s, POOL_SECONDS, scale))
            .collect();
        let n = ps.len() as f64;
        let mean = |f: &dyn Fn(&Population) -> f64| ps.iter().map(f).sum::<f64>() / n;
        let per_item = |m: &dyn Fn(&Population) -> &BTreeMap<ItemId, u32>, id: ItemId| {
            ps.iter()
                .map(|p| *m(p).get(&id).unwrap_or(&0) as f64)
                .sum::<f64>()
                / n
        };

        // Every item, ranked by how long it is on the ground — the number the
        // report exists for. Printed rather than asserted: it is a description
        // of the round, and a floor per item would pin the whole table.
        let mut rows: Vec<(ItemId, f64)> = ITEMS
            .iter()
            .map(|d| {
                (
                    d.id,
                    ps.iter()
                        .map(|p| *p.alive_s.get(&d.id).unwrap_or(&0.0))
                        .sum::<f64>()
                        / n,
                )
            })
            .filter(|(_, s)| *s > 0.0)
            .collect();
        rows.sort_by(|a, b| b.1.partial_cmp(&a.1).unwrap_or(std::cmp::Ordering::Equal));
        let total: f64 = rows.iter().map(|r| r.1).sum();

        println!(
            "\n   {scale:?}: peak live {}/{}   total item-seconds {:.0}",
            ps.iter().map(|p| p.live_peak).max().unwrap_or(0),
            MAX_WORLD_ITEMS,
            total,
        );
        println!(
            "     {:<16} {:>9} {:>7} {:>7} {:>7} {:>7}",
            "item", "item-s", "%", "spawns", "picked", "expired"
        );
        for (id, s) in rows.iter().take(8) {
            let name = ITEMS
                .iter()
                .find(|d| d.id == *id)
                .map(|d| d.key)
                .unwrap_or("?");
            println!(
                "     {:<16} {:>9.0} {:>6.1}% {:>7.1} {:>7.1} {:>7.1}",
                name,
                s,
                100.0 * s / total,
                per_item(&|p| &p.spawned, *id),
                per_item(&|p| &p.picked, *id),
                per_item(&|p| &p.expired, *id),
            );
        }
        let bs = ps
            .iter()
            .map(|p| *p.alive_s.get(&battery).unwrap_or(&0.0))
            .sum::<f64>()
            / n;
        println!(
            "     battery_pack: {:.0} item-s ({:.1}% of the ground), {:.1} spawned, \
             {:.1} picked up, {:.1} expired, {:.1} otherwise removed",
            bs,
            100.0 * bs / total,
            per_item(&|p| &p.spawned, battery),
            per_item(&|p| &p.picked, battery),
            per_item(&|p| &p.expired, battery),
            per_item(&|p| &p.removed_other, battery),
        );

        // **Cause 4, asserted rather than assumed.** `ITEM_SPAWN_INTERVAL`'s doc
        // comment says the live count is "well clear" of the cap; this is that
        // claim as a test, on the same run that produces the table.
        let peak = ps.iter().map(|p| p.live_peak).max().unwrap_or(0);
        assert!(
            peak < MAX_WORLD_ITEMS,
            "{scale:?}: {peak} items alive against a cap of {MAX_WORLD_ITEMS} — eviction is \
             routine, and a higher spawn rate would delete old items rather than add new ones"
        );
        // Reported, not asserted: with the peak that far under the cap these are
        // items that fell into the void or were destroyed by a blast, and both
        // are the game working. A floor on them would be a floor on how much the
        // bots blow up.
        let other: f64 = mean(&|p| p.removed_other.values().sum::<u32>() as f64);
        println!(
            "     {other:.1} items per round removed by neither pickup nor TTL — void or \
             blast, since the cap never fires at a peak of {peak}/{MAX_WORLD_ITEMS}"
        );
    }
}

// ---------------------------------------------------------------------------
// T20.26 — the rate floor, and the control that has to fail it
// ---------------------------------------------------------------------------

/// The wait `ITEM_SPAWN_INTERVAL`'s own doc comment says T11.13 tuned **away
/// from**, per scale.
///
/// **Quoted, not chosen.** These are the *before* column of the table in
/// `constants.rs` above `ITEM_SPAWN_INTERVAL` — `Small 18 s -> 13 s`,
/// `Medium 20 s -> 14 s`, `Large 23 s -> 16 s` — so the claim asserted here is
/// the one the repository already makes about itself: **the tuning that took the
/// spawn interval from 20.0 to 14.0 must still be delivering what it was
/// recorded as delivering.** Nothing here was picked because it is where today's
/// number sits; today's numbers are 13.0 / 12.6 / 13.4, which is 1.4x-1.7x of
/// margin, and they are printed beside the ceiling every run. Measured at
/// `722dbf7`, `--release`, 8 seeds x `POOL_SECONDS`; under the plant this task
/// exists for (`ITEM_SPAWN_INTERVAL` 14 -> 42) the same three read
/// 26.3 / 30.9 / 40.3 and every scale goes red.
///
/// **The table's *after* column has drifted, and that is deliberately not
/// asserted on.** It records 13 / 14 / 16 s and today reads 13.0 / 12.6 / 13.4 —
/// Medium and Large are *better* than T11.13 measured, most likely because §F5
/// took five weapons out of the draw and changed what a batch can contain. That
/// column is a historical record of what a past measurement found, not a live
/// claim, so it is left alone rather than quietly rewritten; the *before* column
/// is the bound because a high-water mark does not go stale.
///
/// `the_wait_ceiling_is_still_the_one_the_constant_records` reads that table back
/// out of `constants.rs` and fails if it stops saying so, because a citation
/// nothing re-validates is the thing this milestone kept finding.
const WEAPON_WAIT_CEILING_S: [(MapScale, f32); 3] = [
    (MapScale::Small, 18.0),
    (MapScale::Medium, 20.0),
    (MapScale::Large, 23.0),
];

/// The control: the world **before the stream has run**.
///
/// One sentence: *at zero elapsed time every item on the ground is the initial
/// placement, so anything the initial placement alone can satisfy is not a
/// measurement of rate.*
///
/// **That is not a hypothetical failure, it is the one in the file.**
/// `density_report`'s vacuity control is `mean_spawn > 10.0` against a total that
/// includes the initial placement, and `initial_items` is **8 / 14 / 20** by
/// scale — so at Medium and Large that control is already satisfied at t = 0,
/// before a single periodic spawn. It is why tripling `ITEM_SPAWN_INTERVAL` was
/// invisible: a control satisfied by the eroded value is not a control.
const CONTROL_SECONDS: f32 = 0.0;

/// The pooled opening wait per scale, and the seeds that had no spawned weapon
/// at all.
fn opening_wait(scale: MapScale, seconds: f32) -> (f32, usize, f32, f32) {
    let ds: Vec<_> = SEEDS.iter().map(|s| density(*s, seconds, scale)).collect();
    let waits: Vec<f32> = ds.iter().filter_map(|d| d.first_weapon_s).collect();
    let mean = if waits.is_empty() {
        f32::INFINITY
    } else {
        waits.iter().sum::<f32>() / waits.len() as f32
    };
    let initial = ds.iter().map(|d| d.initial).sum::<u32>() as f32 / ds.len() as f32;
    let periodic = ds.iter().map(|d| d.periodic).sum::<u32>() as f32 / ds.len() as f32;
    (mean, SEEDS.len() - waits.len(), initial, periodic)
}

/// How long the periodic stream makes a player wait for a weapon.
///
/// **`density_report` floors variety; this floors rate, and they are different
/// axes.** Tripling `ITEM_SPAWN_INTERVAL` costs Medium **8 %** of its distinct
/// types (12.6 -> 11.6 of a 19-item pool, because 26 spawns still covers most of
/// a small pool) and **145 %** of its opening wait (12.6 s -> 30.9 s). The
/// variety floor could not see it; this does.
///
/// **Pooled, not per seed, and the data decided that.** One Small seed opens at
/// 28 s today — its first batch happened to contain no weapon — which is
/// variance in *which* item the weights drew, not in how often the stream runs.
/// A per-seed ceiling would be red today at Small for a reason that has nothing
/// to do with rate. (`the_shipping_configuration_produces_a_fight` goes the other
/// way, per seed, for the opposite reason: there the seeds separate cleanly.)
///
/// **Why the *opening* wait and not a later one.** Measured: a mid-round version
/// of this statistic — "a player arriving at the halfway mark waits N seconds" —
/// **does not track the constant at all.** Planting 14 -> 42 moves it from
/// 8.3 / 7.5 / 7.6 s to 7.5 / 7.4 / 11.3 s, because by mid-round `ItemSpawn` is
/// also being emitted by opened crates and by death drops, and those swamp the
/// periodic stream. The opening wait is clean precisely because it is early:
/// nobody has died and no crate has landed yet. That idea was built, measured,
/// and thrown away rather than shipped as a second floor that looked like
/// coverage.
///
/// **What this does not cover, stated so nobody infers it.** A stream that runs
/// on time and then stops mid-round: the opening wait would be healthy and the
/// second half starved, and the measurement above is why no honest statistic for
/// it is offered here. Also uncovered: `ITEM_SPAWN_BATCH_MAX` 2 -> 1, measured at
/// 13.0 / 15.2 / 18.7 s — a ~20 % supply cut that stays inside every margin. A
/// floor that redded on it would have to sit within 20 % of today's value, which
/// is a fitted number wearing a basis.
#[test]
#[ignore = "measurement: 8 s in release, measured"]
fn the_spawn_stream_beats_the_wait_it_replaced() {
    println!(
        "\n== SPAWN RATE — {} seeds x {POOL_SECONDS}s ==",
        SEEDS.len()
    );
    let mut failures: Vec<String> = Vec::new();
    let mut control_failures: Vec<String> = Vec::new();

    for (scale, ceiling) in WEAPON_WAIT_CEILING_S {
        let (wait, missing, initial, periodic) = opening_wait(scale, POOL_SECONDS);
        let (c_wait, c_missing, c_initial, c_periodic) = opening_wait(scale, CONTROL_SECONDS);
        let say = |w: f32| {
            if w.is_finite() {
                format!("{w:.1}s")
            } else {
                "never".to_string()
            }
        };
        println!(
            "   {:<7} opening wait {} vs the {ceiling:.0}s it was tuned away from (margin \
             {:.2}x, {missing}/{} seeds saw no spawned weapon)\n   {:<7} on the ground: initial \
             {initial:.0} + periodic {periodic:.1}   |   control at t=0: wait {}, initial \
             {c_initial:.0} + periodic {c_periodic:.0}",
            format!("{scale:?}"),
            say(wait),
            ceiling / wait,
            SEEDS.len(),
            "",
            say(c_wait),
        );
        if missing > 0 {
            failures.push(format!(
                "{scale:?}: {missing} of {} seeds never saw the stream produce a weapon",
                SEEDS.len()
            ));
        }
        if wait > ceiling {
            failures.push(format!(
                "{scale:?}: opening wait {wait:.1}s is past the {ceiling:.0}s that \
                 `ITEM_SPAWN_INTERVAL`'s doc records T11.13 as having tuned away from"
            ));
        }
        // The control has to fail the *same* check, or "it fails" is a claim
        // about a different test (share the guard, or share the function).
        if c_missing > 0 || c_wait > ceiling {
            control_failures.push(format!(
                "{scale:?}: wait {}, {c_missing} seeds with no spawned weapon",
                say(c_wait)
            ));
        }
        // And the thing the control exists to show: the incumbent vacuity
        // control reads the total, and the initial placement alone clears it.
        if c_initial > 10.0 {
            println!(
                "   {:<7} ...and `density_report`'s `mean_spawn > 10.0` is already satisfied \
                 here, at t=0, by {c_initial:.0} initial items alone",
                "",
            );
        }
    }

    assert!(
        failures.is_empty(),
        "the spawn stream regressed past the wait it was tuned to replace:\n  {}",
        failures.join("\n  ")
    );
    assert_eq!(
        control_failures.len(),
        WEAPON_WAIT_CEILING_S.len(),
        "the t=0 control failed at only {} of {} scales ({control_failures:?}) — a floor that \
         the initial placement can satisfy is not a floor on rate",
        control_failures.len(),
        WEAPON_WAIT_CEILING_S.len()
    );
}

/// The ceiling above is a quotation, so it is read back from the source it
/// quotes.
///
/// `capacity.rs::max_rooms_carries_its_basis`'s technique, pointed at a citation
/// this file *depends on*: if the table above `ITEM_SPAWN_INTERVAL` is rewritten,
/// `WEAPON_WAIT_CEILING_S` stops being a quotation and becomes three numbers
/// somebody typed. Gate-resident, because that can happen in any commit.
///
/// It checks for the **numbers**, not for the words: `capacity.rs`'s first cut
/// accepted a token its own placeholder already contained.
#[test]
fn the_wait_ceiling_is_still_the_one_the_constant_records() {
    let src = include_str!("../src/constants.rs");
    let i = src
        .find("pub const ITEM_SPAWN_INTERVAL")
        .expect("ITEM_SPAWN_INTERVAL must exist — this test cannot find what it quotes");
    let doc_start = src[..i].rfind("\n\n").unwrap_or(0);
    let doc = &src[doc_start..i];
    assert!(
        doc.contains("1st weapon"),
        "the doc no longer records a first-weapon column, so WEAPON_WAIT_CEILING_S is a \
         quotation of nothing. Doc was:\n{doc}"
    );
    for (scale, ceiling) in WEAPON_WAIT_CEILING_S {
        let needle = format!("{ceiling:.0} s");
        assert!(
            doc.contains(&needle),
            "WEAPON_WAIT_CEILING_S says {scale:?} was tuned away from `{needle}`, and \
             ITEM_SPAWN_INTERVAL's doc no longer contains that number. Either the tuning was \
             re-measured — in which case re-derive the ceiling — or the citation rotted. \
             Doc was:\n{doc}"
        );
    }
}
