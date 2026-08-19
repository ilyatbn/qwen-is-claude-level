//! `items` — catalog, placement, pickup, use, inventory (docs/04-items.md).
//!
//! T2.1 needs [`Inventory`] because `Player` embeds it (docs/03 §1). The
//! catalog (T3.1), placement (T3.2–T3.5), pickup (T3.6) and weapons (T3.8)
//! arrive in Phase 3.

use crate::protocol::ItemId;
use serde::{Deserialize, Serialize};

/// Inventory slot count (docs/04 §5: "6 slots, each holds 1 item").
pub const SLOT_COUNT: usize = 6;

/// A player's inventory (docs/04 §5).
///
/// Pickup, use and the flashlight rule land in T3.6/T3.7; this is the state
/// `Player` carries from T2.1 onward.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Inventory {
    /// docs/04 §5: `slots: [Option<ItemId>; 6]`.
    pub slots: [Option<ItemId>; SLOT_COUNT],
    /// Index of the selected slot, 0..=5.
    pub selected: u8,
}

impl Default for Inventory {
    fn default() -> Self {
        Inventory {
            slots: [None; SLOT_COUNT],
            selected: 0,
        }
    }
}

impl Inventory {
    pub fn new() -> Self {
        Self::default()
    }

    /// The item in the selected slot, if any.
    pub fn selected_item(&self) -> Option<ItemId> {
        self.slots.get(self.selected as usize).copied().flatten()
    }

    /// Index of the first free slot (docs/04 §5: "fill first free slot").
    pub fn first_free_slot(&self) -> Option<usize> {
        self.slots.iter().position(|slot| slot.is_none())
    }

    /// Whether any slot is free.
    pub fn has_free_slot(&self) -> bool {
        self.first_free_slot().is_some()
    }

    /// Whether the inventory already holds `item`.
    pub fn contains(&self, item: ItemId) -> bool {
        self.slots.iter().any(|slot| *slot == Some(item))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn inventory_starts_empty_with_six_slots() {
        // docs/04 §5.
        let inv = Inventory::new();
        assert_eq!(inv.slots.len(), SLOT_COUNT);
        assert!(inv.slots.iter().all(|s| s.is_none()));
        assert_eq!(inv.selected, 0);
        assert_eq!(inv.selected_item(), None);
        assert_eq!(inv.first_free_slot(), Some(0));
        assert!(inv.has_free_slot());
    }

    #[test]
    fn first_free_slot_skips_filled_slots() {
        let mut inv = Inventory::new();
        inv.slots[0] = Some(ItemId::Pistol);
        inv.slots[1] = Some(ItemId::Medkit);
        assert_eq!(inv.first_free_slot(), Some(2));
        assert!(inv.contains(ItemId::Pistol));
        assert!(!inv.contains(ItemId::Rocket));
    }

    #[test]
    fn full_inventory_reports_no_free_slot() {
        let mut inv = Inventory::new();
        inv.slots = [Some(ItemId::Pistol); SLOT_COUNT];
        assert_eq!(inv.first_free_slot(), None);
        assert!(!inv.has_free_slot());
    }

    #[test]
    fn selected_item_is_bounds_safe() {
        // A selected index past the end must read as empty, not panic.
        let mut inv = Inventory::new();
        inv.slots[0] = Some(ItemId::Rocket);
        inv.selected = 99;
        assert_eq!(inv.selected_item(), None);
    }
}
