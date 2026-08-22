//! The 8-slot stacking inventory. Purely a container.
//!
//! No validation of *what* an item is here — "you cannot fire a medkit" lives in
//! the use path, which needs the registry and the player state. See
//! `docs/30-items-inventory.md` §2.

use crate::constants::INVENTORY_SLOTS;
use crate::items::registry::{is_weapon, max_stack, ItemId};

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
    /// The doc's example is the contract for a **consumable**: with `max_stack` 3,
    /// adding 2 then 2 gives a stack of 3 and a stack of 1 — not a stack of 4, and
    /// not two of 2 (`docs/30` §2).
    ///
    /// A **weapon** is the exception (§C24): a given weapon id occupies one slot,
    /// ever. Picking one up that you already hold tops its ammo to `max_stack`
    /// and whatever will not fit stays on the ground; if it is already full the
    /// pickup is refused outright. With 20 weapons and 24 slots that is the
    /// difference between a loadout and a hoard.
    ///
    /// The distinction lives here rather than in the pickup path because `add` is
    /// the *only* way anything reaches a slot — `resolve_pickups`, `give` and the
    /// battery grant all come through it. A guard in the caller would be one the
    /// next caller forgets.
    pub fn add(&mut self, item: ItemId, count: u8) -> AddResult {
        if count == 0 {
            return AddResult::Added;
        }
        let cap = max_stack(item);
        // §C24: one slot per weapon id, ever.
        let one_slot = is_weapon(item);
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

        // A weapon already held has had its one and only slot topped up above.
        // Anything left over stays on the ground rather than opening a second.
        let already_held = self.slots.iter().flatten().any(|s| s.item == item);
        if !(one_slot && already_held) {
            for slot in self.slots.iter_mut() {
                if left == 0 {
                    break;
                }
                if slot.is_none() {
                    let take = cap.min(left);
                    *slot = Some(Stack { item, count: take });
                    left -= take;
                    // One free slot is all a weapon ever gets, even on the very
                    // first pickup: a crate holding more than `max_stack` must
                    // not seat two stacks in one go.
                    if one_slot {
                        break;
                    }
                }
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

    /// True when this item cannot be taken at all.
    ///
    /// For a weapon already held that is the held stack being full, **free slots
    /// or not** (§C24) — the free slot is not somewhere a second stack of it can
    /// go. Reading this as "there is space somewhere" would make it disagree with
    /// what `add` actually does, and a field that means two things is a bug
    /// waiting for the first caller that wants the other one.
    pub fn is_full_for(&self, item: ItemId) -> bool {
        let cap = max_stack(item);
        if is_weapon(item) {
            if let Some(held) = self.slots.iter().flatten().find(|s| s.item == item) {
                return held.count >= cap;
            }
        }
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
    use crate::items::registry::{BAZOOKA, GRENADE, MEDKIT, SHIELD_GENERATOR, SMG};

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

    /// `docs/30` §2's example, on a **consumable**.
    ///
    /// It used to use a grenade, which is a weapon — and §C24 exempts weapons
    /// from exactly this rule, so the assertion would have been testing the
    /// opposite of what it claims. A medkit has the same `max_stack` of 3 and is
    /// a counter, so the doc's example survives unchanged.
    #[test]
    fn merging_fills_the_existing_stack_before_opening_a_new_one() {
        // The doc's example: max_stack 3, add 2 then 2 -> 3 and 1.
        let mut inv = Inventory::new();
        inv.add(MEDKIT, 2);
        inv.add(MEDKIT, 2);
        assert_eq!(
            inv.slot(0),
            Some(Stack {
                item: MEDKIT,
                count: 3
            })
        );
        assert_eq!(
            inv.slot(1),
            Some(Stack {
                item: MEDKIT,
                count: 1
            })
        );
    }

    /// The control for §C24: a **consumable** still spills across slots.
    ///
    /// Without this, "a weapon never takes a second slot" is also satisfied by a
    /// build that never opens a second slot for anything, which would silently
    /// throw away every medkit past the third.
    #[test]
    fn adding_beyond_max_stack_spills_into_more_slots() {
        let mut inv = Inventory::new();
        assert_eq!(inv.add(MEDKIT, 7), AddResult::Added);
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
        // Fill seven slots, leaving one free for medkits (cap 3).
        for _ in 0..7 {
            inv.add(crate::items::registry::FLASHLIGHT, 1);
        }
        // One free slot holds 3; asking for 5 must leave 2 behind, not drop them.
        assert_eq!(inv.add(MEDKIT, 5), AddResult::Partial(2));
        assert_eq!(inv.count_of(MEDKIT), 3);
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
        inv.add(MEDKIT, 5);
        assert_eq!(inv.count_of(MEDKIT), 5);
        assert_eq!(inv.count_of(GRENADE), 0);
    }

    #[test]
    fn is_full_for_is_false_while_any_stack_has_room() {
        let mut inv = Inventory::new();
        inv.add(MEDKIT, 1);
        assert!(!inv.is_full_for(MEDKIT));
        for _ in 0..7 {
            inv.add(crate::items::registry::FLASHLIGHT, 1);
        }
        // Slot 0 still has a medkit stack with room.
        assert!(!inv.is_full_for(MEDKIT));
        assert!(
            inv.is_full_for(SHIELD_GENERATOR),
            "no free slot and no shield stack"
        );
    }

    /// §C24 changes what "full" means for a weapon: a topped-up stack is full
    /// even with slots to spare, because a second stack of it is not somewhere
    /// the pickup can go.
    #[test]
    fn is_full_for_a_held_weapon_ignores_free_slots() {
        let mut inv = Inventory::new();
        inv.add(GRENADE, max_stack(GRENADE));
        assert!(!inv.is_empty());
        assert!(
            inv.is_full_for(GRENADE),
            "a full grenade stack with seven free slots still cannot take more"
        );
        // The control: one short, and it can.
        let mut inv = Inventory::new();
        inv.add(GRENADE, max_stack(GRENADE) - 1);
        assert!(!inv.is_full_for(GRENADE));
    }

    #[test]
    fn drain_all_empties_and_round_trips() {
        let mut inv = Inventory::new();
        inv.add(MEDKIT, 4);
        inv.add(SHIELD_GENERATOR, 2);
        inv.add(SMG, 30);
        let drained = inv.drain_all();
        assert!(inv.is_empty());
        assert_eq!(drained.len(), 4, "one stack per occupied slot");

        let mut again = Inventory::new();
        for s in &drained {
            again.add(s.item, s.count);
        }
        assert_eq!(again.count_of(MEDKIT), 4);
        assert_eq!(again.count_of(SHIELD_GENERATOR), 2);
        assert_eq!(again.count_of(SMG), 30);
    }

    // ---------------------------------------------------------------------
    // T13.06.7 / §C24 — a weapon occupies one slot, ever
    // ---------------------------------------------------------------------

    /// The bug, as reported: a second bazooka took a second slot once the first
    /// stack was full. It must **refill** the one you hold.
    #[test]
    fn picking_up_a_held_weapon_refills_it_and_creates_no_second_slot() {
        let cap = max_stack(BAZOOKA);
        let mut inv = Inventory::new();
        inv.add(BAZOOKA, cap);
        // Spend most of it, the way firing does.
        assert!(inv.consume(0, cap - 1));
        assert_eq!(inv.slot(0).map(|s| s.count), Some(1));

        assert_eq!(inv.add(BAZOOKA, cap), AddResult::Partial(1));
        assert_eq!(
            inv.slot(0).map(|s| s.count),
            Some(cap),
            "the held stack was not topped up to max_stack"
        );
        assert_eq!(
            inv.iter().filter(|(_, st)| st.item == BAZOOKA).count(),
            1,
            "a second bazooka slot was opened: {:?}",
            inv.iter().collect::<Vec<_>>()
        );
        assert_eq!(inv.count_of(BAZOOKA), cap as u32);
    }

    /// Refused at full ammo, with the control that a *different* weapon is
    /// accepted from the identical inventory.
    ///
    /// Without that control, "the pickup was refused" also passes for an
    /// inventory that refuses everything — which is a worse bug than the hoard.
    #[test]
    fn a_full_weapon_is_refused_and_a_different_weapon_is_accepted() {
        let mut inv = Inventory::new();
        inv.add(BAZOOKA, max_stack(BAZOOKA));
        let before = inv.clone();

        assert_eq!(
            inv.add(BAZOOKA, max_stack(BAZOOKA)),
            AddResult::Full,
            "a full weapon must be refused so the world item stays on the ground"
        );
        assert_eq!(
            before.iter().collect::<Vec<_>>(),
            inv.iter().collect::<Vec<_>>(),
            "a refused pickup changed the inventory"
        );

        // The control, from the same state: a different weapon is taken.
        assert_eq!(inv.add(SMG, max_stack(SMG)), AddResult::Added);
        assert_eq!(inv.count_of(SMG), max_stack(SMG) as u32);
        assert_eq!(inv.count_of(BAZOOKA), max_stack(BAZOOKA) as u32);
    }

    /// The invariant itself, over a long random pickup sequence.
    ///
    /// Seeded `ChaCha8Rng` — `game-core` is pure, and a property that only holds
    /// on one hand-picked order is not the property (§A19/§A11). Consumables are
    /// mixed in on purpose: they are the class that *may* hold several slots, so
    /// this also proves the rule is not being applied to everything.
    #[test]
    fn no_two_slots_ever_hold_the_same_weapon_over_a_long_random_sequence() {
        use crate::rng::{range_u32, substream};
        let pool = [BAZOOKA, GRENADE, SMG, MEDKIT, SHIELD_GENERATOR];
        let mut saw_a_consumable_in_two_slots = false;

        for seed in 0..8u64 {
            let mut rng = substream(seed, "inventory-c24");
            let mut inv = Inventory::new();
            for _ in 0..400 {
                let item = pool[range_u32(&mut rng, 0, pool.len() as u32 - 1) as usize];
                if range_u32(&mut rng, 0, 3) == 0 {
                    // Sometimes spend instead, so stacks are not simply saturated.
                    let slot = range_u32(&mut rng, 0, INVENTORY_SLOTS as u32 - 1) as u8;
                    if let Some(st) = inv.slot(slot) {
                        inv.consume(slot, range_u32(&mut rng, 1, st.count as u32) as u8);
                    }
                    continue;
                }
                let n = range_u32(&mut rng, 1, 8) as u8;
                inv.add(item, n);

                for w in [BAZOOKA, GRENADE, SMG] {
                    let slots = inv.iter().filter(|(_, st)| st.item == w).count();
                    assert!(
                        slots <= 1,
                        "seed {seed}: weapon {w} occupies {slots} slots: {:?}",
                        inv.iter().collect::<Vec<_>>()
                    );
                }
                if inv.iter().filter(|(_, st)| st.item == MEDKIT).count() > 1 {
                    saw_a_consumable_in_two_slots = true;
                }
            }
        }
        // The control: the sequence really was long enough to open second slots.
        // Without it the assertion above passes for a run that never got near
        // the condition it is guarding.
        assert!(
            saw_a_consumable_in_two_slots,
            "no consumable ever reached two slots, so the weapon assertion proved nothing"
        );
    }

    /// Death drops one stack per weapon held, not two (§C24's last line).
    ///
    /// Asserted on the drained stacks, which is what `PlayerState::die` hands to
    /// the world as ground items.
    #[test]
    fn death_drops_one_stack_per_weapon_held() {
        let mut inv = Inventory::new();
        // Fill the bazooka, spend it down, refill it — the exact sequence that
        // used to leave two stacks behind.
        inv.add(BAZOOKA, max_stack(BAZOOKA));
        inv.consume(0, max_stack(BAZOOKA) - 1);
        inv.add(BAZOOKA, max_stack(BAZOOKA));
        inv.add(SMG, max_stack(SMG));
        inv.add(MEDKIT, 1);

        let drained = inv.drain_all();
        for w in [BAZOOKA, SMG] {
            assert_eq!(
                drained.iter().filter(|s| s.item == w).count(),
                1,
                "weapon {w} dropped {} stacks: {drained:?}",
                drained.iter().filter(|s| s.item == w).count()
            );
        }
        assert_eq!(
            drained.iter().find(|s| s.item == BAZOOKA).map(|s| s.count),
            Some(max_stack(BAZOOKA)),
            "the dropped stack is not the refilled one"
        );
        assert!(inv.is_empty());
    }
}
