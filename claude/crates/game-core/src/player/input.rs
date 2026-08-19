//! Player input, and the edges derived from it.
//!
//! The wire format carries **held state only** — no edge flags. Edges are derived
//! here, identically on the server and in the client's predictor. That is what makes
//! a dropped input packet harmless: the next packet re-establishes the full truth,
//! whereas a lost edge would be gone forever.
//!
//! See `docs/20-player-movement.md` §7 and `docs/40-net-protocol.md` §2.

use crate::math::dequantize_angle;

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct Input {
    pub seq: u32,
    /// Packed held state; see [`button`].
    pub buttons: u8,
    /// Quantised aim angle (`docs/22-aiming-crosshair.md` §2).
    pub aim: u16,
}

pub mod button {
    pub const LEFT: u8 = 1 << 0;
    pub const RIGHT: u8 = 1 << 1;
    pub const UP: u8 = 1 << 2;
    pub const DOWN: u8 = 1 << 3;
    pub const JUMP: u8 = 1 << 4;
    pub const FIRE: u8 = 1 << 5;
    pub const FLASHLIGHT: u8 = 1 << 6;
    /// Bit 7 is reserved. T6.06 packs this struct onto the wire and the layout is
    /// fixed in `docs/40-net-protocol.md` — do not use it.
    pub const RESERVED: u8 = 1 << 7;

    /// Every button this version defines, for tests and debug rendering.
    pub const ALL: [u8; 7] = [LEFT, RIGHT, UP, DOWN, JUMP, FIRE, FLASHLIGHT];
}

impl Input {
    pub fn new(seq: u32, buttons: u8, aim: u16) -> Self {
        // The reserved bit never survives construction.
        Input {
            seq,
            buttons: buttons & !button::RESERVED,
            aim,
        }
    }

    #[inline]
    pub fn held(&self, b: u8) -> bool {
        self.buttons & b != 0
    }

    #[inline]
    pub fn aim_angle(&self) -> f32 {
        dequantize_angle(self.aim)
    }

    /// `-1`, `0` or `+1`.
    ///
    /// Zero when both directions are held. Preferring one silently produces a
    /// player who drifts when both keys are down, which feels broken; zero is the
    /// honest answer.
    #[inline]
    pub fn move_dir(&self) -> f32 {
        match (self.held(button::LEFT), self.held(button::RIGHT)) {
            (true, false) => -1.0,
            (false, true) => 1.0,
            _ => 0.0,
        }
    }

    pub fn with_button(mut self, b: u8) -> Self {
        self.buttons |= b & !button::RESERVED;
        self
    }
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct InputEdges {
    pub jump_pressed: bool,
    pub jump_released: bool,
    pub fire_pressed: bool,
    pub flashlight_pressed: bool,
}

/// Edges from comparing this tick's held state against the previous tick's.
pub fn edges(current: &Input, previous: &Input) -> InputEdges {
    let pressed = |b: u8| current.held(b) && !previous.held(b);
    InputEdges {
        jump_pressed: pressed(button::JUMP),
        jump_released: !current.held(button::JUMP) && previous.held(button::JUMP),
        fire_pressed: pressed(button::FIRE),
        flashlight_pressed: pressed(button::FLASHLIGHT),
    }
}

#[cfg(test)]
mod tests {
    use super::button::*;
    use super::*;
    use crate::math::{quantize_angle, wrap_to_pi};

    #[test]
    fn held_reports_each_button_independently() {
        for b in ALL {
            let i = Input::new(0, b, 0);
            assert!(i.held(b), "button {b:#b} not held");
            for other in ALL {
                if other != b {
                    assert!(!i.held(other), "{other:#b} falsely held with {b:#b}");
                }
            }
        }
    }

    #[test]
    fn move_dir_covers_all_four_combinations() {
        assert_eq!(Input::new(0, LEFT, 0).move_dir(), -1.0);
        assert_eq!(Input::new(0, RIGHT, 0).move_dir(), 1.0);
        assert_eq!(Input::new(0, 0, 0).move_dir(), 0.0);
        assert_eq!(
            Input::new(0, LEFT | RIGHT, 0).move_dir(),
            0.0,
            "both directions held must be zero, not a preference"
        );
    }

    #[test]
    fn aim_angle_round_trips() {
        let mut a = -3.0f32;
        while a < 3.0 {
            let i = Input::new(0, 0, quantize_angle(a));
            assert!(
                wrap_to_pi(i.aim_angle() - a).abs() < 1e-4,
                "angle {a} came back as {}",
                i.aim_angle()
            );
            a += 0.017;
        }
    }

    #[test]
    fn a_held_button_is_not_a_press() {
        let prev = Input::new(0, JUMP, 0);
        let cur = Input::new(1, JUMP, 0);
        let e = edges(&cur, &prev);
        assert!(!e.jump_pressed, "holding is not pressing");
        assert!(!e.jump_released);
    }

    #[test]
    fn a_new_button_is_a_press() {
        let prev = Input::new(0, 0, 0);
        let cur = Input::new(1, JUMP, 0);
        assert!(edges(&cur, &prev).jump_pressed);
    }

    #[test]
    fn a_dropped_button_is_a_release() {
        let prev = Input::new(0, JUMP, 0);
        let cur = Input::new(1, 0, 0);
        let e = edges(&cur, &prev);
        assert!(e.jump_released);
        assert!(!e.jump_pressed);
    }

    #[test]
    fn fire_and_flashlight_edges_are_independent() {
        let prev = Input::new(0, JUMP, 0);
        let cur = Input::new(1, JUMP | FIRE | FLASHLIGHT, 0);
        let e = edges(&cur, &prev);
        assert!(e.fire_pressed);
        assert!(e.flashlight_pressed);
        assert!(!e.jump_pressed, "jump was already held");
    }

    #[test]
    fn the_first_tick_reports_a_press_for_everything_held() {
        // Against a Default previous input, which is what the predictor's ring
        // buffer starts with.
        let cur = Input::new(1, JUMP | FIRE | FLASHLIGHT, 0);
        let e = edges(&cur, &Input::default());
        assert!(e.jump_pressed && e.fire_pressed && e.flashlight_pressed);
    }

    #[test]
    fn default_is_empty() {
        let d = Input::default();
        assert_eq!(d.seq, 0);
        assert_eq!(d.buttons, 0);
        assert_eq!(d.aim, 0);
        for b in ALL {
            assert!(!d.held(b));
        }
    }

    #[test]
    fn the_reserved_bit_is_never_set_by_a_constructor() {
        assert_eq!(Input::new(0, 0xFF, 0).buttons & RESERVED, 0);
        assert_eq!(
            Input::default().with_button(0xFF).buttons & RESERVED,
            0,
            "with_button must mask it too"
        );
        // And it does not eat any real button.
        let all: u8 = ALL.iter().fold(0, |a, b| a | b);
        assert_eq!(Input::new(0, 0xFF, 0).buttons, all);
    }

    #[test]
    fn input_is_copy_and_comparable() {
        let a = Input::new(3, JUMP, 42);
        let b = a;
        assert_eq!(a, b);
        assert_eq!(a.seq, 3);
    }
}
