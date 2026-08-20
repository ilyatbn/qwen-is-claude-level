//! The 8-slot stacking inventory. Purely a container.
//!
//! No validation of *what* an item is here — "you cannot fire a medkit" lives in
//! the use path, which needs the registry and the player state. See
//! `docs/30-items-inventory.md` §2.

use crate::constants::INVENTORY_SLOTS;
use crate::items::registry::{max_stack, ItemId};

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub struct Stack {
    pub item: ItemId,
    pub count: u8,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum AddResult {
    Added,
    /// Carries the leftover. The caller must leave that many on the ground — a
    /// bare `bool` here would silently destroy items.
    Partial(u8),
    Full,
}

#[derive(Clone, Debug)]
pub struct Inventory {
    slots: [Option<Stack>; INVENTORY_SLOTS],
    selected: u8,
}

impl Default for Inventory {
    fn default() -> Self {
        Inventory {
            slots: [None; INVENTORY_SLOTS],
            selected: 0,
        }
    }
}

impl Inventory {
    pub fn new() -> Self {
        Self::default()
    }

    /// Merge into existing stacks first, then take free slots.
    ///
    /// The doc's example is the contract: with `max_stack` 3, adding 2 then 2 gives
    /// a stack of 3 and a stack of 1 — not a stack of 4, and not two of 2.
    pub fn add(&mut self, item: ItemId, count: u8) -> AddResult {
        if count == 0 {
            return AddResult::Added;
        }
        let cap = max_stack(item);
        let mut left = count;

        for slot in self.slots.iter_mut() {
            if left == 0 {
                break;
            }
            if let Some(s) = slot {
                if s.item == item && s.count < cap {
                    let room = cap - s.count;
                    let take = room.min(left);
                    s.count += take;
                    left -= take;
                }
            }
        }

        for slot in self.slots.iter_mut() {
            if left == 0 {
                break;
            }
            if slot.is_none() {
                let take = cap.min(left);
                *slot = Some(Stack { item, count: take });
                left -= take;
            }
        }

        match left {
            0 => AddResult::Added,
            n if n == count => AddResult::Full,
            n => AddResult::Partial(n),
        }
    }

    /// Remove `n` from a slot. Clears the slot at 0 and re-selects.
    pub fn consume(&mut self, slot: u8, n: u8) -> bool {
        let Some(cell) = self.slots.get_mut(slot as usize) else {
            return false;
        };
        let Some(stack) = cell else { return false };
        if n == 0 || stack.count < n {
            return false;
        }
        stack.count -= n;
        if stack.count == 0 {
            *cell = None;
            // A selection left dangling on an empty slot makes firing silently do
            // nothing, which reads as a bug to the player.
            if self.selected == slot {
                self.select_next_non_empty();
            }
        }
        true
    }

    /// Fold the inventory into a world hash. Private slots, so it lives here.
    pub fn hash_into(&self, h: &mut blake3::Hasher) {
        for s in &self.slots {
            match s {
                Some(st) => h.update(&[1, st.count]).update(&st.item.to_le_bytes()),
                None => h.update(&[0u8]),
            };
        }
        h.update(&[self.selected]);
    }

    pub fn slot(&self, slot: u8) -> Option<Stack> {
        self.slots.get(slot as usize).copied().flatten()
    }

    pub fn selected(&self) -> u8 {
        self.selected
    }

    pub fn selected_stack(&self) -> Option<Stack> {
        self.slot(self.selected)
    }

    pub fn select(&mut self, slot: u8) -> bool {
        if (slot as usize) < INVENTORY_SLOTS {
            self.selected = slot;
            true
        } else {
            false
        }
    }

    /// Move selection to the next occupied slot, wrapping. Stays put if the
    /// inventory is empty.
    pub fn select_next_non_empty(&mut self) {
        for step in 1..=INVENTORY_SLOTS {
            let idx = (self.selected as usize + step) % INVENTORY_SLOTS;
            if self.slots[idx].is_some() {
                self.selected = idx as u8;
                return;
            }
        }
    }

    pub fn count_of(&self, item: ItemId) -> u32 {
        self.slots
            .iter()
            .flatten()
            .filter(|s| s.item == item)
            .map(|s| s.count as u32)
            .sum()
    }

    /// True when no stack has room and no slot is free.
    pub fn is_full_for(&self, item: ItemId) -> bool {
        let cap = max_stack(item);
        !self.slots.iter().any(|s| match s {
            None => true,
            Some(st) => st.item == item && st.count < cap,
        })
    }

    /// One `Stack` per occupied slot, then clear. For death drops.
    pub fn drain_all(&mut self) -> Vec<Stack> {
        let out: Vec<Stack> = self.slots.iter().flatten().copied().collect();
        self.clear();
        out
    }

    pub fn clear(&mut self) {
        self.slots = [None; INVENTORY_SLOTS];
        self.selected = 0;
    }

    pub fn iter(&self) -> impl Iterator<Item = (u8, Stack)> + '_ {
        self.slots
            .iter()
            .enumerate()
            .filter_map(|(i, s)| s.map(|st| (i as u8, st)))
    }

    pub fn is_empty(&self) -> bool {
        self.slots.iter().all(|s| s.is_none())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::items::registry::{BAZOOKA, GRENADE, MEDKIT, SMG};

    #[test]
    fn a_new_inventory_is_empty() {
        let inv = Inventory::new();
        assert!(inv.is_empty());
        assert_eq!(inv.selected(), 0);
        assert_eq!(inv.selected_stack(), None);
    }

    #[test]
    fn add_takes_slot_zero_first() {
        let mut inv = Inventory::new();
        assert_eq!(inv.add(MEDKIT, 1), AddResult::Added);
        assert_eq!(
            inv.slot(0),
            Some(Stack {
                item: MEDKIT,
                count: 1
            })
        );
    }

    #[test]
    fn merging_fills_the_existing_stack_before_opening_a_new_one() {
        // The doc's example: max_stack 3, add 2 then 2 -> 3 and 1.
        let mut inv = Inventory::new();
        inv.add(GRENADE, 2);
        inv.add(GRENADE, 2);
        assert_eq!(
            inv.slot(0),
            Some(Stack {
                item: GRENADE,
                count: 3
            })
        );
        assert_eq!(
            inv.slot(1),
            Some(Stack {
                item: GRENADE,
                count: 1
            })
        );
    }

    #[test]
    fn adding_beyond_max_stack_spills_into_more_slots() {
        let mut inv = Inventory::new();
        assert_eq!(inv.add(GRENADE, 7), AddResult::Added);
        assert_eq!(inv.slot(0).map(|s| s.count), Some(3));
        assert_eq!(inv.slot(1).map(|s| s.count), Some(3));
        assert_eq!(inv.slot(2).map(|s| s.count), Some(1));
    }

    #[test]
    fn a_full_inventory_refuses_and_changes_nothing() {
        let mut inv = Inventory::new();
        // Eight slots of a max_stack-1 item fills it completely.
        for _ in 0..INVENTORY_SLOTS {
            inv.add(crate::items::registry::FLASHLIGHT, 1);
        }
        let before = inv.clone();
        assert_eq!(inv.add(MEDKIT, 1), AddResult::Full);
        assert_eq!(
            before.iter().collect::<Vec<_>>(),
            inv.iter().collect::<Vec<_>>()
        );
    }

    #[test]
    fn a_partial_add_reports_the_exact_leftover() {
        let mut inv = Inventory::new();
        // Fill seven slots, leaving one free for grenades (cap 3).
        for _ in 0..7 {
            inv.add(crate::items::registry::FLASHLIGHT, 1);
        }
        // One free slot holds 3; asking for 5 must leave 2 behind, not drop them.
        assert_eq!(inv.add(GRENADE, 5), AddResult::Partial(2));
        assert_eq!(inv.count_of(GRENADE), 3);
    }

    #[test]
    fn consume_decrements_and_clears() {
        let mut inv = Inventory::new();
        inv.add(BAZOOKA, 2);
        assert!(inv.consume(0, 1));
        assert_eq!(inv.slot(0).map(|s| s.count), Some(1));
        assert!(inv.consume(0, 1));
        assert_eq!(inv.slot(0), None);
    }

    #[test]
    fn consume_rejects_empty_slots_and_over_consumption() {
        let mut inv = Inventory::new();
        assert!(!inv.consume(0, 1));
        inv.add(BAZOOKA, 2);
        assert!(!inv.consume(0, 3), "cannot take more than the stack holds");
        assert_eq!(inv.slot(0).map(|s| s.count), Some(2));
        assert!(!inv.consume(99, 1), "out-of-range slot");
    }

    #[test]
    fn emptying_the_selected_slot_moves_selection_to_the_next_occupied_one() {
        let mut inv = Inventory::new();
        inv.add(BAZOOKA, 1);
        inv.add(MEDKIT, 1);
        inv.select(0);
        inv.consume(0, 1);
        assert_eq!(inv.selected(), 1);
        assert_eq!(inv.selected_stack().map(|s| s.item), Some(MEDKIT));
    }

    #[test]
    fn emptying_the_last_item_leaves_a_valid_selection() {
        let mut inv = Inventory::new();
        inv.add(BAZOOKA, 1);
        inv.select(0);
        inv.consume(0, 1);
        assert!((inv.selected() as usize) < INVENTORY_SLOTS);
        assert_eq!(inv.selected_stack(), None);
    }

    #[test]
    fn select_is_bounds_checked() {
        let mut inv = Inventory::new();
        assert!(inv.select(7));
        assert!(!inv.select(INVENTORY_SLOTS as u8));
    }

    #[test]
    fn count_of_sums_across_stacks() {
        let mut inv = Inventory::new();
        inv.add(GRENADE, 5);
        assert_eq!(inv.count_of(GRENADE), 5);
        assert_eq!(inv.count_of(MEDKIT), 0);
    }

    #[test]
    fn is_full_for_is_false_while_any_stack_has_room() {
        let mut inv = Inventory::new();
        inv.add(GRENADE, 1);
        assert!(!inv.is_full_for(GRENADE));
        for _ in 0..7 {
            inv.add(crate::items::registry::FLASHLIGHT, 1);
        }
        // Slot 0 still has a grenade stack with room.
        assert!(!inv.is_full_for(GRENADE));
        assert!(inv.is_full_for(MEDKIT), "no free slot and no medkit stack");
    }

    #[test]
    fn drain_all_empties_and_round_trips() {
        let mut inv = Inventory::new();
        inv.add(GRENADE, 4);
        inv.add(MEDKIT, 2);
        inv.add(SMG, 30);
        let drained = inv.drain_all();
        assert!(inv.is_empty());
        assert_eq!(drained.len(), 4, "one stack per occupied slot");

        let mut again = Inventory::new();
        for s in &drained {
            again.add(s.item, s.count);
        }
        assert_eq!(again.count_of(GRENADE), 4);
        assert_eq!(again.count_of(MEDKIT), 2);
        assert_eq!(again.count_of(SMG), 30);
    }
}
