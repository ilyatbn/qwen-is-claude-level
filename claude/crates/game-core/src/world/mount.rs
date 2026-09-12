//! Standing on a gun platform mounts you (T21.11B).
//!
//! `world::teleport`'s sibling, and written against it deliberately: both are
//! "hold a position for a second and something happens", both reset the instant
//! you step off, and both live on the player so the rule is per-player rather
//! than a global flag that would arm every platform for everyone.
//!
//! ## One timer, two directions
//!
//! `held` counts seconds of the current qualifying action and nothing else.
//! While unmounted that action is *standing on the platform in `target`*; while
//! mounted it is *holding jump*. Either one reaching `GUN_PLATFORM_MOUNT_TIME`
//! flips the state and resets the counter, and anything that interrupts it —
//! stepping off, releasing jump, dying — resets it too.
//!
//! A second counter for the dismount was the obvious shape and is the wrong
//! one: two counters are two things to reset, and the reset is where this class
//! of bug lives.
//!
//! ## Why dismount is jump and not right-click
//!
//! The original ask said right-click. `main.ts` suppresses `contextmenu` on the
//! canvas and `ui/inventory.ts` binds it on the panel root *and* on every tile,
//! so a world-level right-click would have had three consumers to not break —
//! and a mounted player cannot move, which leaves `BTN_JUMP` with no other
//! meaning in this state. The task file records the override.

use crate::constants::GUN_PLATFORM_MOUNT_TIME;
use crate::map::meta::GunPlatform;
use crate::math::Vec2;

/// The `mounted` value a **client mirror** records off the wire.
///
/// The snapshot carries one bit — *are you mounted* — and not which platform,
/// because nothing client-side reads the id: `move_mods` asks `is_some()`, and
/// the renderer finds the platform under the player's feet with the same shared
/// `underfoot` the server uses. A mirror therefore knows *that* you are mounted
/// and never *which*, and this constant is that fact written down rather than
/// left as a `0` somebody later mistakes for platform zero.
///
/// `no_real_platform_can_collide_with_the_wire_sentinel` pins the assumption
/// this rests on.
pub const WIRE_MOUNTED: u8 = u8::MAX;

/// One player's relationship with the platforms, for one life.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct MountState {
    /// The platform this player is riding, if any.
    ///
    /// **The only source of "is this player mounted".** Occupancy is derived by
    /// scanning players for this field rather than kept as a second array on the
    /// world — two records of one fact are two records that can disagree, and
    /// this one already has to exist.
    pub mounted: Option<u8>,
    /// The platform being charged toward. Meaningless while `mounted`.
    pub target: Option<u8>,
    /// Seconds held. One counter, both directions — see the module docs.
    pub held: f32,
}

impl Default for MountState {
    fn default() -> Self {
        MountState {
            mounted: None,
            target: None,
            held: 0.0,
        }
    }
}

impl MountState {
    pub fn new() -> Self {
        Self::default()
    }

    // **`progress()` was here and is gone** (T21.14).
    //
    // It returned the hold as `0..=1` and its doc comment said it was "for the
    // client's indicator, the way `TeleportState`'s charge byte is". It was
    // not: no byte carried it, no client read it, and its only caller was its
    // own unit test. A mechanism wired to nothing with a comment asserting the
    // wiring is the shape this project has paid for a dozen times, so it goes
    // rather than sitting here looking done.
    //
    // **The gap it leaves is real and is recorded, not papered over**: a player
    // stands still for `GUN_PLATFORM_MOUNT_TIME` with no feedback at all, where
    // the teleport pad this was modelled on fills a ring. Giving them one needs
    // a snapshot byte and a client that draws it — a wire change, not a
    // one-liner — and that is `T21.14`'s follow-up note.

    /// Whether this player is riding a platform. **The one question
    /// `move_mods` asks**, and the only one a mirror can answer.
    pub fn is_mounted(&self) -> bool {
        self.mounted.is_some()
    }

    /// Make this state agree with the wire's mounted bit (T21.11B).
    ///
    /// Never called server-side: there the mount state *is* the truth. See
    /// [`WIRE_MOUNTED`] for why no id crosses.
    pub fn set_from_wire(&mut self, on: bool) {
        self.mounted = if on { Some(WIRE_MOUNTED) } else { None };
        if !on {
            self.held = 0.0;
            self.target = None;
        }
    }
}

/// What one tick of the mount rule decided.
///
/// Returned rather than applied, so the caller owns the world-level part —
/// whether the platform is already occupied is not something a player's own
/// state can answer, and an API that made the caller re-derive it would be
/// called wrong.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum MountEvent {
    Nothing,
    /// The hold completed while unmounted: mount `id` if it is free.
    WantsMount(u8),
    /// The hold completed while mounted: get off.
    WantsDismount(u8),
}

/// Advance one player's mount state by `dt`.
///
/// `under` is the platform their feet are on, `jump_held` whether they are
/// holding the jump button, and `grounded` whether they are actually standing.
/// **Grounded matters**: `underfoot` is a position test and says nothing about
/// whether the body is resting, so without it a player at the top of a jump
/// whose feet happen to cross the surface line accumulates hold time in mid-air.
pub fn step(
    st: &mut MountState,
    under: Option<u8>,
    jump_held: bool,
    grounded: bool,
    dt: f32,
) -> MountEvent {
    if let Some(id) = st.mounted {
        // **Displaced means dismounted** (T21.14).
        //
        // This branch used to return without ever consulting `under`, so a
        // mounted player thrown clear by a blast stayed mounted: immobile,
        // inventory-locked, and still firing rounds that spawn at the
        // platform's own muzzle — from wherever they landed. Self-knockback
        // made it repeatable rather than an edge case.
        //
        // `under` only, not `grounded`: a mounted body rests on the platform and
        // its `grounded` flag flickers as the solver settles, which would
        // dismount people for standing still. Being somewhere else is the
        // condition that matters, and `underfoot` is the one geometry rule.
        if under != Some(id) {
            st.held = 0.0;
            st.target = None;
            return MountEvent::WantsDismount(id);
        }
        // Mounted: the qualifying action is holding jump.
        if jump_held {
            st.held += dt;
            if st.held >= GUN_PLATFORM_MOUNT_TIME {
                st.held = 0.0;
                return MountEvent::WantsDismount(id);
            }
        } else {
            st.held = 0.0;
        }
        return MountEvent::Nothing;
    }

    // Unmounted: the qualifying action is standing on one platform.
    match under {
        Some(id) if grounded => {
            // **The first tick on a new target counts.** Setting the target and
            // returning without accumulating made mounting take one tick longer
            // than dismounting, for no reason a player could see — and it is the
            // kind of asymmetry that shows up as "the mount timer is wrong"
            // exactly once, at the float boundary, in a test that pins the
            // constant. Stepping onto a platform *is* a tick of standing on it.
            if st.target != Some(id) {
                st.target = Some(id);
                st.held = 0.0;
            }
            st.held += dt;
            if st.held >= GUN_PLATFORM_MOUNT_TIME {
                st.held = 0.0;
                return MountEvent::WantsMount(id);
            }
        }
        _ => {
            st.target = None;
            st.held = 0.0;
        }
    }
    MountEvent::Nothing
}

/// Which platform a body's feet are on, or `None`.
///
/// The **one** geometry rule, shared with the client through
/// `GunPlatform::underfoot` — which is itself shared with `TeleportPad` through
/// `map::meta::footprint`. Three features, one answer to "are you standing on
/// it".
pub fn platform_underfoot(platforms: &[GunPlatform], centre: Vec2) -> Option<u8> {
    platforms.iter().find(|g| g.underfoot(centre)).map(|g| g.id)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::constants::SIM_DT;

    fn hold_for(
        st: &mut MountState,
        seconds: f32,
        under: Option<u8>,
        jump: bool,
    ) -> Vec<MountEvent> {
        let steps = (seconds / SIM_DT).round() as usize;
        (0..steps)
            .map(|_| step(st, under, jump, true, SIM_DT))
            .collect()
    }

    /// Both halves: the full hold mounts, and a shorter one does not.
    #[test]
    fn standing_for_the_mount_time_mounts_and_standing_for_less_does_not() {
        let mut st = MountState::new();
        // Deliberately just under, in ticks, so this cannot pass by rounding.
        let short = hold_for(
            &mut st,
            GUN_PLATFORM_MOUNT_TIME - 4.0 * SIM_DT,
            Some(2),
            false,
        );
        assert!(
            short.iter().all(|e| *e == MountEvent::Nothing),
            "a short stand mounted the player"
        );

        let mut st = MountState::new();
        let full = hold_for(&mut st, GUN_PLATFORM_MOUNT_TIME + SIM_DT, Some(2), false);
        assert!(
            full.contains(&MountEvent::WantsMount(2)),
            "a full stand did not mount: {full:?}"
        );
    }

    #[test]
    fn stepping_off_resets_the_hold() {
        let mut st = MountState::new();
        hold_for(&mut st, GUN_PLATFORM_MOUNT_TIME * 0.9, Some(0), false);
        assert!(st.held > 0.0, "the fixture accumulated nothing");
        step(&mut st, None, false, true, SIM_DT);
        assert_eq!(st.held, 0.0, "stepping off did not reset the hold");
        assert_eq!(st.target, None);
    }

    /// A position test is not a standing test.
    #[test]
    fn a_body_in_the_air_over_a_platform_never_mounts() {
        let mut st = MountState::new();
        let evs: Vec<MountEvent> = (0..(2.0 / SIM_DT) as usize)
            .map(|_| step(&mut st, Some(1), false, false, SIM_DT))
            .collect();
        assert!(
            evs.iter().all(|e| *e == MountEvent::Nothing),
            "a player who never touched the ground mounted anyway"
        );
        // The control: the same hold, grounded, does mount.
        let mut st = MountState::new();
        let evs = hold_for(&mut st, 2.0, Some(1), false);
        assert!(evs.contains(&MountEvent::WantsMount(1)));
    }

    /// Both halves again, in the other direction.
    /// **`under` is `Some(3)` throughout**: a player holding jump to get off is
    /// still standing on the gun. These fixtures passed `None` before T21.14,
    /// which described a mounted player who is not on their platform — a state
    /// that now means *displaced* and dismounts on the spot.
    #[test]
    fn holding_jump_dismounts_and_a_shorter_hold_does_not() {
        let mut st = MountState::new();
        st.mounted = Some(3);
        let short = hold_for(
            &mut st,
            GUN_PLATFORM_MOUNT_TIME - 4.0 * SIM_DT,
            Some(3),
            true,
        );
        assert!(
            short.iter().all(|e| *e == MountEvent::Nothing),
            "a short jump hold dismounted the player"
        );

        let mut st = MountState::new();
        st.mounted = Some(3);
        let full = hold_for(&mut st, GUN_PLATFORM_MOUNT_TIME + SIM_DT, Some(3), true);
        assert!(
            full.contains(&MountEvent::WantsDismount(3)),
            "a full jump hold did not dismount: {full:?}"
        );
    }

    /// T21.14: a blast that moves a mounted player takes them off the gun.
    ///
    /// Both halves — an absence needs a presence — and the second is what says
    /// this is about displacement rather than about mounting being fragile.
    #[test]
    fn being_displaced_dismounts_and_staying_put_does_not() {
        let mut st = MountState::new();
        st.mounted = Some(2);
        // Still on it: nothing happens, however long.
        let stay: Vec<MountEvent> = (0..60)
            .map(|_| step(&mut st, Some(2), false, true, SIM_DT))
            .collect();
        assert!(
            stay.iter().all(|e| *e == MountEvent::Nothing),
            "standing on the platform dismounted the player"
        );
        assert!(st.is_mounted());

        // Thrown clear: off on the very next tick, not after a hold.
        let e = step(&mut st, None, false, true, SIM_DT);
        assert_eq!(e, MountEvent::WantsDismount(2));
        assert_eq!(st.held, 0.0, "a stale hold survived the displacement");
    }

    /// Thrown onto a *different* platform is still off the first one.
    #[test]
    fn being_displaced_onto_another_platform_leaves_the_first() {
        let mut st = MountState::new();
        st.mounted = Some(0);
        assert_eq!(
            step(&mut st, Some(1), false, true, SIM_DT),
            MountEvent::WantsDismount(0)
        );
    }

    #[test]
    fn releasing_jump_resets_the_dismount_hold() {
        let mut st = MountState::new();
        st.mounted = Some(0);
        hold_for(&mut st, GUN_PLATFORM_MOUNT_TIME * 0.9, Some(0), true);
        assert!(st.held > 0.0);
        // Still on the platform, jump released.
        step(&mut st, Some(0), false, true, SIM_DT);
        assert_eq!(st.held, 0.0, "releasing jump did not reset the hold");
        assert!(st.is_mounted(), "releasing jump dismounted them outright");
    }

    /// Moving from one platform to another restarts the hold rather than
    /// carrying it over — otherwise walking a row of them mounts you on the last.
    #[test]
    fn crossing_to_a_second_platform_restarts_the_hold() {
        let mut st = MountState::new();
        hold_for(&mut st, GUN_PLATFORM_MOUNT_TIME * 0.9, Some(0), false);
        let e = step(&mut st, Some(1), false, true, SIM_DT);
        assert_eq!(
            e,
            MountEvent::Nothing,
            "the second platform mounted instantly"
        );
        assert_eq!(st.target, Some(1));
        // Restarted, not zero: the crossing tick is itself a tick of standing on
        // the new platform, which is what keeps mounting and dismounting the
        // same length.
        assert!(
            st.held <= SIM_DT,
            "the hold carried {} s over from the first platform",
            st.held
        );
    }

    /// The sentinel rests on there being no real platform with that id, so it
    /// is asserted rather than assumed — ids are `0..GUN_PLATFORMS`.
    #[test]
    fn no_real_platform_can_collide_with_the_wire_sentinel() {
        assert!(
            (crate::constants::GUN_PLATFORMS as u32) < WIRE_MOUNTED as u32,
            "GUN_PLATFORMS reached the wire sentinel — a mirror would now be \
             indistinguishable from a player on the last platform"
        );
    }

    #[test]
    fn setting_from_the_wire_clears_the_hold_when_it_says_unmounted() {
        let mut st = MountState::new();
        st.mounted = Some(1);
        st.held = 0.5;
        st.target = Some(1);
        st.set_from_wire(false);
        assert!(!st.is_mounted());
        assert_eq!(
            st.held, 0.0,
            "a stale hold survived the wire saying unmounted"
        );
        assert_eq!(st.target, None);
        // The control: the other direction sets it.
        st.set_from_wire(true);
        assert!(st.is_mounted());
    }
}
