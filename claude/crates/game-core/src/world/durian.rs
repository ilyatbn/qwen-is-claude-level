//! T24.01 — **the durian trees' fruit**: each tree (`map::durian`) keeps `DURIAN_FRUIT` slots filled with a hanging
//! durian grenade, and a picked one grows back after `DURIAN_REGROW`.
//!
//! A fruit **is a world item** (`SpawnSource::Tree`): it hangs (no physics, no TTL, outside the ground cap) and is
//! taken by the ordinary pickup — `would_take`, stacks, `item_pickup` — within the canopy's reach. So everything an
//! item already has (the wire, a joiner's catch-up, bots wanting it) a fruit has without a second path; this module
//! only decides **when a slot grows**. Deterministic: the clock is the round's, nothing is drawn from an RNG.

use super::{GameEvent, World};
use crate::constants::{DURIAN_FRUIT, DURIAN_REGROW};
use crate::items::registry::DURIAN_GRENADE;
use crate::items::world::{SpawnSource, WorldItemId};
use crate::map::durian::{fruit_at, DurianTree};

/// One fruit slot of one tree: the item hanging there, or when the next one grows.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct FruitSlot {
    pub tree: u8,
    pub slot: u8,
    pub item: Option<WorldItemId>,
    /// Round time the slot grows again; `NEG_INFINITY` at round start, so every slot grows on the first step.
    pub regrow_at: f32,
}

/// Every slot of every tree, empty and due — `World::new`'s initial state.
pub fn slots_for(trees: &[DurianTree]) -> Vec<FruitSlot> {
    (0..trees.len())
        .flat_map(|t| {
            (0..DURIAN_FRUIT).map(move |s| FruitSlot {
                tree: t as u8,
                slot: s as u8,
                item: None,
                regrow_at: f32::NEG_INFINITY,
            })
        })
        .collect()
}

impl World {
    /// Step the trees: a slot whose fruit was taken starts its `DURIAN_REGROW`; a due empty slot grows a fruit,
    /// announced as an `ItemSpawn` like any other item. Runs in every phase, so the fruit hang from the first step.
    pub(crate) fn step_durian_trees(&mut self, now: f32) {
        for i in 0..self.durian.len() {
            let s = self.durian[i];
            match s.item {
                Some(id) if self.items.get(id).is_some() => {}
                Some(_) => {
                    self.durian[i].item = None;
                    self.durian[i].regrow_at = now + DURIAN_REGROW;
                }
                None if now >= s.regrow_at => {
                    let Some(tree) = self.map.meta.durian_trees.get(s.tree as usize) else {
                        continue;
                    };
                    let pos = fruit_at(tree, s.slot as usize);
                    let id = self.items.spawn(
                        DURIAN_GRENADE,
                        1,
                        pos,
                        crate::math::Vec2::ZERO,
                        SpawnSource::Tree,
                        now,
                    );
                    self.durian[i].item = Some(id);
                    let tick = self.tick;
                    self.events.push(GameEvent::ItemSpawn {
                        tick,
                        world_item_id: id,
                        item_id: DURIAN_GRENADE,
                        count: 1,
                        x: pos.x,
                        y: pos.y,
                        source: SpawnSource::Tree,
                    });
                }
                None => {}
            }
        }
    }

    /// The fruit slots (dev and tests): each one's tree, slot, hanging item and regrow time.
    pub fn durian_slots(&self) -> &[FruitSlot] {
        &self.durian
    }
}

#[cfg(test)]
mod tests {
    use crate::constants::{MapScale, DURIAN_FRUIT, DURIAN_REGROW, SIM_DT};
    use crate::items::registry::DURIAN_GRENADE;
    use crate::items::world::SpawnSource;
    use crate::map::durian::fruit_at;
    use crate::math::Vec2;
    use crate::world::{GameEvent, RoundPhase, World};

    /// A classic seed whose Small map grows at least one tree.
    fn world_with_trees() -> World {
        for seed in 1u64..=40 {
            let w = World::new(seed, MapScale::Small);
            if !w.map.meta.durian_trees.is_empty() {
                return w;
            }
        }
        panic!("no seed in 1..=40 grew a durian tree")
    }

    fn hanging(w: &World) -> usize {
        w.items.iter().filter(|it| it.is_hanging()).count()
    }

    /// Both ends: the fruit the world holds and the `ItemSpawn`s it announced are the same count, each at its slot,
    /// and they hang — a second of steps moves none of them (the control is that the world's other items may fall).
    #[test]
    fn every_slot_grows_a_hanging_fruit_on_the_first_step_and_it_stays_put() {
        let mut w = world_with_trees();
        let want = w.map.meta.durian_trees.len() * DURIAN_FRUIT;
        assert_eq!(
            hanging(&w),
            0,
            "control: nothing hangs before the first step"
        );
        w.step(SIM_DT);
        let spawned: Vec<(f32, f32)> = w
            .drain_events()
            .iter()
            .filter_map(|e| match e {
                GameEvent::ItemSpawn {
                    item_id,
                    x,
                    y,
                    source: SpawnSource::Tree,
                    ..
                } if *item_id == DURIAN_GRENADE => Some((*x, *y)),
                _ => None,
            })
            .collect();
        assert_eq!(hanging(&w), want, "the world holds a fruit a slot");
        assert_eq!(spawned.len(), want, "and announced each one");
        for (t, tree) in w.map.meta.durian_trees.iter().enumerate() {
            for s in 0..DURIAN_FRUIT {
                let p = fruit_at(tree, s);
                assert!(
                    spawned.contains(&(p.x, p.y)),
                    "tree {t} slot {s} did not grow at {p:?}"
                );
            }
        }
        let before: Vec<Vec2> = w
            .items
            .iter()
            .filter(|i| i.is_hanging())
            .map(|i| i.pos)
            .collect();
        for _ in 0..(1.0 / SIM_DT) as u32 {
            w.step(SIM_DT);
        }
        let after: Vec<Vec2> = w
            .items
            .iter()
            .filter(|i| i.is_hanging())
            .map(|i| i.pos)
            .collect();
        assert_eq!(before, after, "a hanging fruit moved");
    }

    /// Both ends of a pickup: a body walking under the lowest fruit takes it — the item leaves the world, the
    /// grenade arrives in the bag, and `ItemPickup` names that item and that player. The control is a second body
    /// beside the trunk but outside the canopy's reach, which takes nothing.
    #[test]
    fn a_body_passing_under_the_canopy_takes_the_lowest_fruit_and_one_beside_it_does_not() {
        use crate::constants::{DURIAN_PICKUP_REACH, PLAYER_H, SPAWN_IFRAMES};
        let mut w = world_with_trees();
        w.add_player(0, 0, "ana".into());
        w.add_player(1, 0, "bo".into());
        while w.phase != RoundPhase::Playing || w.round_time <= SPAWN_IFRAMES {
            w.step(SIM_DT);
        }
        let tree = w.map.meta.durian_trees[0];
        let lowest = (0..DURIAN_FRUIT)
            .max_by(|a, b| fruit_at(&tree, *a).y.total_cmp(&fruit_at(&tree, *b).y))
            .expect("a slot");
        let fruit = fruit_at(&tree, lowest);
        let slot = w
            .durian_slots()
            .iter()
            .position(|s| s.tree == 0 && s.slot as usize == lowest)
            .expect("slot");
        let id = w.durian_slots()[slot].item.expect("the fruit hangs");
        let under = Vec2::new(fruit.x, tree.pos.y as f32 - PLAYER_H / 2.0);
        let beside = Vec2::new(fruit.x + 3.0 * DURIAN_PICKUP_REACH, under.y);
        let _ = w.drain_events();
        let mut picked = Vec::new();
        for _ in 0..5 {
            for (pid, at) in [(0u8, under), (1u8, beside)] {
                if let Some(p) = w.player_mut(pid) {
                    p.body.pos = at;
                    p.body.vel = Vec2::ZERO;
                }
            }
            w.step(SIM_DT);
            picked.extend(w.drain_events().into_iter().filter_map(|e| match e {
                GameEvent::ItemPickup {
                    world_item_id,
                    player_id,
                    ..
                } => Some((world_item_id, player_id)),
                _ => None,
            }));
        }
        assert_eq!(picked, vec![(id, 0)], "the pickup heard: {picked:?}");
        assert!(w.items.get(id).is_none(), "the fruit is still on the tree");
        let held = |pid: u8| {
            w.player(pid)
                .map(|p| p.inventory.count_of(DURIAN_GRENADE))
                .unwrap_or(0)
        };
        assert_eq!(held(0), 1, "the grenade did not reach the bag");
        assert_eq!(
            held(1),
            0,
            "control: a body outside the canopy's reach took one"
        );
    }

    /// Picked: the slot empties, and grows back after `DURIAN_REGROW` — not a tick before (the control).
    #[test]
    fn a_taken_fruit_grows_back_after_the_regrow_time_and_not_before() {
        let mut w = world_with_trees();
        w.set_phase(RoundPhase::Playing);
        w.step(SIM_DT);
        let id = w.durian_slots()[0].item.expect("slot 0 grew");
        w.items.remove(id);
        w.step(SIM_DT);
        let taken_at = w.round_time;
        assert_eq!(
            w.durian_slots()[0].item,
            None,
            "the slot did not notice its fruit was gone"
        );
        assert!((w.durian_slots()[0].regrow_at - (taken_at + DURIAN_REGROW)).abs() < 1e-3);
        while w.round_time + SIM_DT < taken_at + DURIAN_REGROW - SIM_DT {
            w.step(SIM_DT);
            assert_eq!(
                w.durian_slots()[0].item,
                None,
                "grew back early at {}",
                w.round_time
            );
        }
        for _ in 0..3 {
            w.step(SIM_DT);
        }
        let back = w.durian_slots()[0].item.expect("slot 0 never grew back");
        assert_ne!(back, id, "a new fruit, a new id");
        assert!(w.items.get(back).is_some_and(|it| it.is_hanging()));
    }

    // ---------------------------------------------------------------- T24.01 task 4: the alien cow

    use crate::constants::{
        COW_CLEAR, COW_FLEE_SPEED, COW_HEALTH, COW_LEASH, COW_SPEED, COW_THINK_EVERY,
    };
    use crate::world::animals::AnimalKind;

    fn cows(w: &World) -> Vec<(u32, Vec2, Option<Vec2>)> {
        w.animals
            .iter()
            .filter(|a| a.kind == AnimalKind::Cow)
            .map(|a| (a.id, a.pos(), a.home))
            .collect()
    }

    fn playing_with_trees() -> World {
        let mut w = world_with_trees();
        w.set_phase(RoundPhase::Playing);
        let _ = w.drain_events();
        w
    }

    /// Both ends: one cow per tree on the first playing tick — the world holds them and announced each
    /// (`AnimalSpawn` kind 2) — each by its own tree. The control for "by its tree" is that the trees are far apart
    /// (`DURIAN_TREE_SPACING`), so a cow placed by the wrong tree fails it.
    #[test]
    fn a_cow_grazes_by_each_tree_from_the_first_playing_tick() {
        let mut w = playing_with_trees();
        assert!(
            cows(&w).is_empty(),
            "control: no cow before the round steps"
        );
        w.step(SIM_DT);
        let heard = w
            .drain_events()
            .iter()
            .filter(|e| matches!(e, GameEvent::AnimalSpawn { kind: 2, .. }))
            .count();
        let c = cows(&w);
        assert_eq!(c.len(), w.map.meta.durian_trees.len(), "a cow a tree");
        assert_eq!(heard, c.len(), "each cow announced");
        for (id, at, home) in &c {
            let home = home.expect("a cow has a home");
            assert!(w
                .map
                .meta
                .durian_trees
                .iter()
                .any(|t| t.pos.x as f32 == home.x && t.pos.y as f32 == home.y));
            let off = (at.x - home.x).abs();
            assert!(
                (COW_CLEAR..=COW_LEASH).contains(&off)
                    || w.map
                        .meta
                        .durian_trees
                        .iter()
                        .any(|t| t.pos.x as f32 == at.x),
                "cow {id} starts {off} px from its tree, outside its band beside it"
            );
        }
        // Never twice: a minute on, still one a tree.
        for _ in 0..(60.0 / SIM_DT) as u32 {
            w.step(SIM_DT);
        }
        assert_eq!(cows(&w).len(), w.map.meta.durian_trees.len());
    }

    /// It ambles but stays beside its tree: over two minutes of day each cow moves (the control — a cow that never moved
    /// passes the leash alone), is never further from its trunk than the leash plus one choice's walk, and never nearer
    /// than `COW_CLEAR` (not under the canopy — the owner's "fully visible").
    #[test]
    fn a_cow_ambles_and_stays_by_its_tree() {
        let mut w = playing_with_trees();
        w.step(SIM_DT);
        let start: Vec<Vec2> = cows(&w).iter().map(|c| c.1).collect();
        let mut moved = vec![0.0f32; start.len()];
        let bound = COW_LEASH + COW_SPEED * COW_THINK_EVERY + 1.0;
        for _ in 0..(120.0 / SIM_DT) as u32 {
            w.step(SIM_DT);
            if w.last_day_phase == crate::world::DayPhase::Night {
                break;
            }
            for (k, (_, at, home)) in cows(&w).iter().enumerate() {
                let home = home.expect("home");
                assert!(
                    (at.x - home.x).abs() <= bound,
                    "a cow wandered {} px from its tree (bound {bound})",
                    at.x - home.x
                );
                // The owner's "fully visible": it never walks in under its tree (a tick's step of slack).
                if (start[k].x - home.x).abs() >= COW_CLEAR {
                    assert!(
                        (at.x - home.x).abs() >= COW_CLEAR - COW_SPEED * SIM_DT - 0.5,
                        "a cow walked in under its tree: {} px from the trunk",
                        at.x - home.x
                    );
                }
                moved[k] = moved[k].max((at.x - start[k].x).abs());
            }
        }
        // The control is the population's, not each cow's: a cow on a ledge its own length wide stands where it is
        // (its ledge guard turns it back both ways), and that is a cow, not a bug.
        assert!(
            moved.iter().any(|m| *m > 4.0),
            "a cow never moved: {moved:?}"
        );
    }

    /// At night it sleeps — not a px in thirty seconds — and by day the same cows move (the control).
    #[test]
    fn a_cow_sleeps_at_night_and_moves_by_day() {
        let m = world_with_trees().map;
        let homes: Vec<(Vec2, f32)> = m
            .meta
            .durian_trees
            .iter()
            .map(|t| (Vec2::new(t.pos.x as f32, t.pos.y as f32), 1.0))
            .collect();
        let run = |night: bool| -> f32 {
            let mut a = crate::world::animals::Animals::new(3).with_cow_homes(homes.clone());
            a.tick_at_night(
                &m,
                true,
                crate::constants::GravityMode::Standard,
                night,
                0.0,
                SIM_DT,
            );
            for i in 0..60 {
                a.tick_at_night(
                    &m,
                    true,
                    crate::constants::GravityMode::Standard,
                    night,
                    i as f32 * SIM_DT,
                    SIM_DT,
                );
            }
            let x0: Vec<f32> = a
                .iter()
                .filter(|c| c.kind == AnimalKind::Cow)
                .map(|c| c.pos().x)
                .collect();
            for i in 60..(30.0 / SIM_DT) as u32 {
                a.tick_at_night(
                    &m,
                    true,
                    crate::constants::GravityMode::Standard,
                    night,
                    i as f32 * SIM_DT,
                    SIM_DT,
                );
            }
            a.iter()
                .filter(|c| c.kind == AnimalKind::Cow)
                .zip(&x0)
                .map(|(c, x)| (c.pos().x - x).abs())
                .sum()
        };
        assert_eq!(run(true), 0.0, "a cow moved at night");
        assert!(run(false) > 1.0, "control: by day the cows never moved");
    }

    /// Hurt, it flees away from the shooter at `COW_FLEE_SPEED`; killed, it drops a durian grenade.
    #[test]
    fn a_hurt_cow_flees_from_the_shooter_and_a_dead_one_drops_a_durian() {
        let mut w = playing_with_trees();
        w.add_player(0, 0, "ana".into());
        w.step(SIM_DT);
        let (id, at, _) = cows(&w)[0];
        if let Some(p) = w.player_mut(0) {
            p.body.pos = Vec2::new(at.x - 60.0, at.y);
        }
        let now = w.round_time;
        w.resolve_animal_kills(&[(id, 1.0)], now);
        let x0 = w.animals.get(id).map(|a| a.pos().x).expect("alive");
        for _ in 0..30 {
            if let Some(p) = w.player_mut(0) {
                p.body.pos = Vec2::new(at.x - 60.0, at.y);
            }
            w.step(SIM_DT);
        }
        let x1 = w.animals.get(id).map(|a| a.pos().x).expect("alive");
        let v = (x1 - x0) / (30.0 * SIM_DT);
        assert!(
            v > COW_SPEED,
            "it did not flee away from the shooter on its right: {v} px/s"
        );
        assert!(v <= COW_FLEE_SPEED + 1.0);
        let _ = w.drain_events();
        let now = w.round_time;
        w.resolve_animal_kills(&[(id, COW_HEALTH)], now);
        let drops: Vec<_> = w
            .drain_events()
            .into_iter()
            .filter(
                |e| matches!(e, GameEvent::ItemSpawn { item_id, .. } if *item_id == DURIAN_GRENADE),
            )
            .collect();
        assert!(w.animals.get(id).is_none(), "the cow survived its health");
        assert_eq!(drops.len(), 1, "a dead cow dropped {} durians", drops.len());
    }

    /// No tree, no cow: a volcanic map and a space map grow neither.
    #[test]
    fn no_cow_without_a_tree() {
        let volcanic = (1u64..=40)
            .map(|s| World::new(s, MapScale::Small))
            .find(|w| w.map.meta.look != crate::constants::WorldLook::Classic)
            .expect("a volcanic seed");
        let mut w = volcanic;
        w.set_phase(RoundPhase::Playing);
        for _ in 0..10 {
            w.step(SIM_DT);
        }
        assert!(cows(&w).is_empty(), "a cow on a volcanic map");
    }

    /// Beside its tree on every map, not just one: over 30 seeds every cow starts in its band (`COW_CLEAR`–`COW_LEASH`
    /// from the trunk) — the fallback to the trunk's foot, under the canopy, is never taken. A population claim, so a
    /// population: at least ten cows must be looked at.
    #[test]
    fn every_cow_starts_beside_its_tree_over_many_seeds() {
        let mut seen = 0;
        for seed in 1u64..=30 {
            let mut w = World::new(seed, MapScale::Small);
            w.set_phase(RoundPhase::Playing);
            w.step(SIM_DT);
            for (id, at, home) in cows(&w) {
                let off = (at.x - home.expect("home").x).abs();
                assert!(
                    (COW_CLEAR..=COW_LEASH).contains(&off),
                    "seed {seed}: cow {id} starts {off} px from its trunk"
                );
                seen += 1;
            }
        }
        assert!(seen >= 10, "only {seen} cows over 30 seeds");
    }
}
