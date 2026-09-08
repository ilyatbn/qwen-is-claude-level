//! The 8-slot stacking inventory. Purely a container.
//!
//! No validation of *what* an item is here — "you cannot fire a medkit" lives in
//! the use path, which needs the registry and the player state. See
//! `docs/30-items-inventory.md` §2.

use crate::constants::{INVENTORY_SLOTS, QUICK_SLOTS};
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

    /// Move or merge a stack between two slots (§C10's drag).
    ///
    /// **The server is the authority**: the client shows the intent, this decides.
    /// It parses attacker-controlled indices, so every one of them is checked and
    /// none of them indexes without a bound.
    ///
    /// - out of range, or `from == to`, or an empty source: refused, nothing moves;
    /// - empty destination: the stack moves whole;
    /// - same item: merged up to `max_stack`, and **whatever does not fit stays
    ///   behind** rather than being destroyed;
    /// - different item: swapped, which is what a drag onto an occupied tile
    ///   means to anyone who has used an inventory before.
    pub fn move_stack(&mut self, from: u8, to: u8) -> bool {
        let (f, t) = (from as usize, to as usize);
        if f >= INVENTORY_SLOTS || t >= INVENTORY_SLOTS || f == t {
            return false;
        }
        let Some(src) = self.slots[f] else {
            return false;
        };
        match self.slots[t] {
            None => {
                self.slots[t] = Some(src);
                self.slots[f] = None;
            }
            Some(mut dst) if dst.item == src.item => {
                let cap = max_stack(src.item);
                if dst.count >= cap {
                    // Nothing would move, so this is not a move. Reported as
                    // refused rather than as a no-op success: the caller emits an
                    // `inventory` event on success, and an event for a change
                    // that did not happen is a lie the client then renders.
                    return false;
                }
                let take = (cap - dst.count).min(src.count);
                dst.count += take;
                self.slots[t] = Some(dst);
                let left = src.count - take;
                self.slots[f] = if left == 0 {
                    None
                } else {
                    Some(Stack {
                        item: src.item,
                        count: left,
                    })
                };
            }
            Some(dst) => {
                self.slots[t] = Some(src);
                self.slots[f] = Some(dst);
            }
        }
        // A selection left on a slot that just emptied fires into nothing.
        if self.slots[self.selected as usize].is_none() {
            self.select_next_non_empty();
        }
        true
    }

    /// Take a whole stack out of one slot (T20.09's drop).
    ///
    /// **Whole, not partial.** A drop that split a stack would need a count on
    /// the wire and a rule for what a client may claim about it; §C24 already
    /// makes a weapon one slot ever, so "drop the tile" is the gesture and the
    /// tile is the unit.
    ///
    /// Bounds and emptiness are decided here rather than by the caller, the way
    /// `move_stack` decides them — the client shows intent, this decides — and
    /// the selection is moved off a slot this empties for the same reason
    /// `move_stack` does it: a selection on an empty slot fires into nothing.
    pub fn take_slot(&mut self, slot: u8) -> Option<Stack> {
        let i = slot as usize;
        if i >= INVENTORY_SLOTS {
            return None;
        }
        let taken = self.slots[i].take()?;
        if self.slots[self.selected as usize].is_none() {
            self.select_next_non_empty();
        }
        Some(taken)
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

    /// Select a **quick-bar** slot. Refuses anything else (§C10).
    ///
    /// Firing and using act on the selection, so a selection that could sit in
    /// the backpack would mean shooting with something that is not on the screen.
    /// The bound is `QUICK_SLOTS`, not `INVENTORY_SLOTS`: with 24 slots those are
    /// no longer the same number, and the old check would have let a `select_slot`
    /// from a modified client point anywhere.
    pub fn select(&mut self, slot: u8) -> bool {
        if (slot as usize) < QUICK_SLOTS {
            self.selected = slot;
            true
        } else {
            false
        }
    }

    /// Move selection to the next occupied **quick-bar** slot, wrapping. Stays
    /// put if the bar is empty.
    ///
    /// Bounded by `QUICK_SLOTS` for the same reason `select` is: this runs when a
    /// stack empties, and letting it wander into the backpack would put the
    /// trigger on something the player cannot see.
    pub fn select_next_non_empty(&mut self) {
        for step in 1..=QUICK_SLOTS {
            let idx = (self.selected as usize + step) % QUICK_SLOTS;
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
        // Fill all but one slot, leaving one free for medkits (cap 3).
        //
        // Pinned to `INVENTORY_SLOTS` rather than to 7: §C10 took the inventory
        // from 8 slots to 24, and a fixture carrying its own copy of the size
        // stops filling it (§A19). This one failed loudly, which is the point.
        for _ in 0..INVENTORY_SLOTS - 1 {
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
        for _ in 0..INVENTORY_SLOTS - 1 {
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

#[cfg(test)]
mod pickup_does_not_disturb_what_is_held {
    use super::*;
    use crate::items::registry::{AXE, BAZOOKA, FLAMETHROWER, MEDKIT, MINE, MOLOTOV, SMG};

    /// Written while chasing a live defect: a player's **bazooka stack vanishes**
    /// from a full loadout mid-round, alive, having fired nothing and moved
    /// nowhere. `scripts/checks/ordnance.mjs` reproduces it about one run in
    /// three, on both map generators, and the server's own `inventory` payload is
    /// positional — so the empty slot 1 the client renders is a genuinely empty
    /// slot 0 on the server.
    ///
    /// This rules `add` out: the loadout survives every pickup, including ones
    /// that fill the inventory. The remaining suspect is `consume` via
    /// `try_fire`, which spends **the selected slot** — see the journal.
    #[test]
    fn a_pickup_never_removes_a_held_stack() {
        let mut inv = Inventory::new();
        let loadout = [
            (BAZOOKA, 4u8),
            (SMG, 60),
            (MINE, 2),
            (AXE, 1),
            (FLAMETHROWER, 200),
            (MOLOTOV, 2),
        ];
        for (item, n) in loadout {
            inv.add(item, n);
        }

        // Fill the two remaining slots, then keep picking up past full.
        for _ in 0..6 {
            inv.add(MEDKIT, 1);
            inv.add(crate::items::registry::BATTERY_PACK, 1);
        }

        for (i, (item, n)) in loadout.iter().enumerate() {
            let held = inv.slot(i as u8);
            assert_eq!(
                held.map(|s| (s.item, s.count)),
                Some((*item, *n)),
                "slot {i} was {held:?}, not the {n} of item {item} it started with",
            );
        }
    }
}

#[cfg(test)]
mod dragging {
    use super::*;
    use crate::constants::{BACKPACK_SLOTS, QUICK_SLOTS};
    use crate::items::registry::{BAZOOKA, GRENADE, MEDKIT, SHIELD_GENERATOR};

    /// The first backpack slot. Derived, so the geometry cannot drift from the
    /// constants the client lays the panel out from.
    const BACKPACK: u8 = QUICK_SLOTS as u8;

    #[test]
    fn a_stack_moves_to_an_empty_slot_in_either_direction() {
        let mut inv = Inventory::new();
        inv.add(BAZOOKA, 4);
        assert!(inv.move_stack(0, BACKPACK), "quick bar → backpack");
        assert_eq!(inv.slot(0), None);
        assert_eq!(inv.slot(BACKPACK).map(|s| s.item), Some(BAZOOKA));

        assert!(inv.move_stack(BACKPACK, 3), "backpack → quick bar");
        assert_eq!(inv.slot(BACKPACK), None);
        assert_eq!(inv.slot(3).map(|s| (s.item, s.count)), Some((BAZOOKA, 4)));
    }

    #[test]
    fn a_drag_onto_a_different_item_swaps_them() {
        let mut inv = Inventory::new();
        inv.add(BAZOOKA, 4);
        inv.add(GRENADE, 2);
        assert!(inv.move_stack(0, 1));
        assert_eq!(inv.slot(0).map(|s| s.item), Some(GRENADE));
        assert_eq!(inv.slot(1).map(|s| s.item), Some(BAZOOKA));
    }

    /// §C10: merging respects `max_stack`, and the remainder stays behind rather
    /// than being destroyed.
    #[test]
    fn merging_onto_a_partial_stack_respects_max_stack() {
        let cap = max_stack(MEDKIT);
        let mut inv = Inventory::new();
        // Two partial stacks of the same item, in different regions.
        inv.slots[0] = Some(Stack {
            item: MEDKIT,
            count: cap,
        });
        inv.slots[BACKPACK as usize] = Some(Stack {
            item: MEDKIT,
            count: cap - 1,
        });
        // Drag the full one onto the partial one: exactly one fits.
        assert!(inv.move_stack(0, BACKPACK));
        assert_eq!(inv.slot(BACKPACK).map(|s| s.count), Some(cap));
        assert_eq!(
            inv.slot(0).map(|s| s.count),
            Some(cap - 1),
            "the remainder was destroyed"
        );
        // And onto a stack that is already full: refused, nothing moves.
        let before: Vec<_> = (0..INVENTORY_SLOTS).map(|i| inv.slot(i as u8)).collect();
        inv.slots[1] = Some(Stack {
            item: MEDKIT,
            count: cap,
        });
        assert!(!inv.move_stack(1, BACKPACK));
        assert_eq!(inv.slot(1).map(|s| s.count), Some(cap));
        let after: Vec<_> = (0..INVENTORY_SLOTS)
            .map(|i| inv.slot(i as u8))
            .collect::<Vec<_>>();
        assert_eq!(after[BACKPACK as usize], before[BACKPACK as usize]);
    }

    /// Attacker-controlled indices. Refused, and **without a panic** — this is
    /// the one function in the inventory that parses untrusted input.
    #[test]
    fn out_of_range_equal_and_empty_moves_are_refused_without_panicking() {
        let mut inv = Inventory::new();
        inv.add(BAZOOKA, 4);
        for (from, to) in [
            (0u8, 0u8),                 // equal
            (0, INVENTORY_SLOTS as u8), // just past the end
            (INVENTORY_SLOTS as u8, 0), // ...the other way
            (255, 255),                 // the "missing field" value
            (0, 200),                   // wildly out of range
            (1, 2),                     // empty source
        ] {
            assert!(!inv.move_stack(from, to), "{from} → {to} was accepted");
        }
        // Nothing moved at all.
        assert_eq!(inv.slot(0).map(|s| (s.item, s.count)), Some((BAZOOKA, 4)));
    }

    /// Fuzzed, because "every index is checked" is a claim about *all* of them.
    #[test]
    fn no_pair_of_indices_can_panic_or_lose_an_item() {
        let mut rng = crate::rng::substream(4242, "drag-fuzz");
        let mut inv = Inventory::new();
        inv.add(BAZOOKA, 4);
        inv.add(GRENADE, 3);
        inv.add(MEDKIT, 2);
        inv.add(SHIELD_GENERATOR, 2);
        let total = |i: &Inventory| -> u32 {
            [BAZOOKA, GRENADE, MEDKIT, SHIELD_GENERATOR]
                .iter()
                .map(|it| i.count_of(*it))
                .sum()
        };
        let before = total(&inv);
        for _ in 0..20_000 {
            let from = crate::rng::range_u32(&mut rng, 0, 300) as u8;
            let to = crate::rng::range_u32(&mut rng, 0, 300) as u8;
            inv.move_stack(from, to);
            // The invariant that matters: dragging never creates or destroys.
            assert_eq!(total(&inv), before, "a drag changed the total item count");
        }
    }

    /// §C10: the selection follows the quick bar only.
    #[test]
    fn a_backpack_slot_cannot_be_selected() {
        let mut inv = Inventory::new();
        for i in 0..QUICK_SLOTS {
            assert!(inv.select(i as u8), "quick slot {i} was refused");
        }
        for i in QUICK_SLOTS..QUICK_SLOTS + BACKPACK_SLOTS {
            assert!(!inv.select(i as u8), "backpack slot {i} was selected");
        }
        // ...and the refusal left the selection where it was.
        assert_eq!(inv.selected(), (QUICK_SLOTS - 1) as u8);
    }

    /// And the auto-advance stays in the bar too, which is the path a player hits
    /// without ever touching a key.
    #[test]
    fn the_auto_advance_never_lands_in_the_backpack() {
        let mut inv = Inventory::new();
        // Only the backpack has anything in it.
        inv.slots[BACKPACK as usize] = Some(Stack {
            item: BAZOOKA,
            count: 1,
        });
        inv.selected = 0;
        inv.select_next_non_empty();
        assert!(
            (inv.selected() as usize) < QUICK_SLOTS,
            "the selection wandered to slot {}",
            inv.selected()
        );
    }
}
