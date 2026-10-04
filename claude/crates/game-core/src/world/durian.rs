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
}
