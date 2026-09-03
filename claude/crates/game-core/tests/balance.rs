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
    MapScale, BATTERY_MAX, BOT_COUNT_DEFAULT, DEFAULT_MAP_SCALE, FOV_DAY, INVENTORY_SLOTS,
    ROUND_SECONDS, SIM_DT, SURFACE_SAMPLE_STEP,
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
}

/// One headless round.
///
/// `hold` puts that item in every bot's hand, sweeps the ground every tick, and
/// gives full battery so an energy weapon is measured charged rather than
/// measured empty. Sweeping removes medkits too, which shortens fights — but it
/// does so identically for every weapon, and leaving them in would let a bot
/// switch to whatever it walked over halfway through the measurement.
fn run(seed: u64, hold: Option<ItemId>, seconds: f32) -> Round {
    // `DEFAULT_MAP_SCALE`, for the same reason as `BOTS`: on Large, 0 of 8 rounds
    // contained a fight at all, so a weapon table measured there is measuring
    // silence.
    let mut w = World::new(seed, DEFAULT_MAP_SCALE);
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
                    DeathCause::Weather | DeathCause::Void => {}
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
            first.iter().sum::<f32>() / first.len().max(1) as f32,
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

/// The acceptance test for T11.16, and it measures the configuration the game
/// actually ships over the round length it actually runs — `ROUND_SECONDS`, not
/// the 150 s the survey uses, because a player experiences the whole round.
///
/// The floors carry a **control**: the pre-fix configuration (Large, 4 players)
/// must *fail* them. Without it these pass for any configuration at all, which
/// is exactly how §B15's assertions passed against nothing.
#[test]
#[ignore = "measurement: minutes in release"]
fn the_shipping_configuration_produces_a_fight() {
    let plrs = BOT_COUNT_DEFAULT + 1;
    let ship: Vec<_> = SEEDS
        .iter()
        .map(|s| encounters(*s, DEFAULT_MAP_SCALE, plrs, ROUND_SECONDS))
        .collect();
    let fought = ship.iter().filter(|r| r.damage > 0.0).count();
    let firsts: Vec<f32> = ship.iter().filter_map(|r| r.first_s).collect();
    let first = firsts.iter().sum::<f32>() / firsts.len().max(1) as f32;
    println!(
        "\n== SHIPPING — {DEFAULT_MAP_SCALE:?}, {plrs} players, {} seeds x {ROUND_SECONDS}s ==\n\
            fought {fought}/{}  1st contact {first:.0}s  seen {}/{}",
        SEEDS.len(),
        ship.len(),
        firsts.len(),
        ship.len(),
    );

    // The control. Large with 4 players is what shipped before this task, and it
    // produced zero fights in eight rounds. If it clears these floors, the
    // floors are measuring nothing.
    let before: Vec<_> = SEEDS
        .iter()
        .map(|s| encounters(*s, MapScale::Large, 4, ROUND_SECONDS))
        .collect();
    let before_fought = before.iter().filter(|r| r.damage > 0.0).count();
    println!(
        "   control (Large, 4 players): fought {before_fought}/{}",
        before.len()
    );

    assert!(
        fought >= 6,
        "{DEFAULT_MAP_SCALE:?} with {plrs} players: only {fought}/{} rounds contained a fight",
        ship.len()
    );
    assert!(
        firsts.len() == ship.len() && first < 45.0,
        "first contact averages {first:.0}s across {}/{} rounds that had one",
        firsts.len(),
        ship.len()
    );
    assert!(
        before_fought < fought,
        "the control ({before_fought}/{}) matched the shipping configuration \
         ({fought}/{}) — these floors do not measure the change",
        before.len(),
        ship.len()
    );
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
