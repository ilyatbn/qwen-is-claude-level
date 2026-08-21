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
use game_core::constants::{MapScale, BATTERY_MAX, INVENTORY_SLOTS, SIM_DT};
use game_core::items::registry::{ItemDef, ItemId, ItemKind, ITEMS, PISTOL};
use game_core::player::input::button;
use game_core::player::state::DeathCause;
use game_core::weapons::defs::def;
use game_core::world::{give, GameEvent, RoundPhase, World};

/// Seeds for every population claim in this file. Eight, because five of eight
/// rounds contain a fight at all (§B17) and a smaller sample reports the empty
/// ones as a balance finding.
const SEEDS: [u64; 8] = [1, 7, 42, 99, 4242, 12345, 31337, 8675309];

const BOTS: usize = 4;
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
}

/// One headless round.
///
/// `hold` puts that item in every bot's hand, sweeps the ground every tick, and
/// gives full battery so an energy weapon is measured charged rather than
/// measured empty. Sweeping removes medkits too, which shortens fights — but it
/// does so identically for every weapon, and leaving them in would let a bot
/// switch to whatever it walked over halfway through the measurement.
fn run(seed: u64, hold: Option<ItemId>, seconds: f32) -> Round {
    let mut w = World::new(seed, MapScale::Small);
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
        for e in w.drain_events() {
            match e {
                GameEvent::Death { cause, .. } => match cause {
                    DeathCause::Player(_) => r.combat_deaths += 1,
                    DeathCause::SelfInflicted => r.self_deaths += 1,
                    DeathCause::Weather => {}
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

/// Every weapon must be obtainable *somehow*. Cheap and structural: a weight of
/// zero in all three columns is a weapon nothing can ever give you, which is a
/// registry bug and not a balance result.
#[test]
fn every_weapon_can_be_obtained() {
    let orphans: Vec<_> = weapons()
        .iter()
        .filter(|d| d.spawn_weight == 0 && d.crate_weight == 0 && d.buried_weight == 0)
        .map(|d| d.key)
        .collect();
    assert!(
        orphans.is_empty(),
        "weapons with no way into a player's hands: {orphans:?}"
    );
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
    // a weapon, so a pool round of ten seconds fires nothing and the comparison
    // would be between two empty rounds. The control below caught exactly that.
    let a = run(SEEDS[0], Some(PISTOL), 10.0);
    let b = run(SEEDS[0], Some(PISTOL), 10.0);
    assert_eq!(a.damage.to_bits(), b.damage.to_bits(), "damage drifted");
    assert_eq!(a.combat_deaths, b.combat_deaths);
    assert_eq!(a.picks, b.picks);
    // Control: the run has to have done something, or equality is vacuous.
    assert!(
        a.fires > 0,
        "no shots fired — the comparison proves nothing"
    );
}

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
        "\n{:<16}{:>10}{:>10}{:>8}{:>7}{:>8}{:>9}",
        "weapon", "dmg/bot-s", "self/bot-s", "kills", "self", "fires", "dmg/pick"
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
        println!(
            "{:<16}{dps:>10.2}{sdps:>10.2}{kills:>8}{selfk:>7}{fires:>8}{per_pick:>9.0}",
            d.key
        );
        let harmless =
            matches!(d.kind, ItemKind::Weapon(w) if def(w).is_some_and(|x| x.damage == 0.0));
        rows.push((d.key, dps, fires, harmless));
    }

    // A weapon with zero damage in its def is not an outlier, it is smoke
    // (§B7: "the only one with no damage at all"). Judging it against a damage
    // median reports a weapon working exactly as specified as the worst in the
    // game, which is how a report loses the reader's trust.
    let med = median(
        rows.iter()
            .filter(|r| !r.3)
            .map(|r| r.1)
            .collect::<Vec<_>>(),
    );
    println!("\n   median dmg/bot-s = {med:.2}  (excluding no-damage utility weapons)");
    let mut outliers = Vec::new();
    for (key, dps, fires, harmless) in &rows {
        if *harmless {
            continue;
        }
        if *fires == 0 {
            outliers.push(format!("{key}: never fired"));
        } else if *dps > med * 2.0 {
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
