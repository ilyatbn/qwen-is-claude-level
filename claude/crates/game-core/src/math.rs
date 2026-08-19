//! Small maths types shared by physics, map generation and the wire format.
//!
//! Two things here carry more weight than their size suggests:
//!
//! - [`Aabb::pixel_bounds`] decides how the float world maps onto the integer mask.
//!   Getting it wrong shifts collision by a pixel everywhere.
//! - [`isqrt`] is exact integer arithmetic because it rasterises circles, and the
//!   bit-identical carve guarantee (`docs/11-map-destruction.md` §2) depends on it
//!   giving the same answer on every platform.

use std::ops::{Add, AddAssign, Div, Mul, Neg, Sub, SubAssign};

pub const TAU: f32 = std::f32::consts::TAU;
pub const PI: f32 = std::f32::consts::PI;

// ---------------------------------------------------------------------------
// Vec2
// ---------------------------------------------------------------------------

#[derive(Copy, Clone, Debug, Default, PartialEq)]
#[cfg_attr(feature = "serde", derive(serde::Serialize, serde::Deserialize))]
pub struct Vec2 {
    pub x: f32,
    pub y: f32,
}

impl Vec2 {
    pub const ZERO: Vec2 = Vec2 { x: 0.0, y: 0.0 };

    pub const fn new(x: f32, y: f32) -> Self {
        Vec2 { x, y }
    }

    pub fn len(self) -> f32 {
        self.len_sq().sqrt()
    }

    pub fn len_sq(self) -> f32 {
        self.x * self.x + self.y * self.y
    }

    /// A zero vector normalises to zero, never NaN. NaN positions propagate
    /// silently and are miserable to debug.
    pub fn normalized(self) -> Vec2 {
        let l = self.len();
        if l <= f32::EPSILON {
            Vec2::ZERO
        } else {
            Vec2::new(self.x / l, self.y / l)
        }
    }

    pub fn dot(self, o: Vec2) -> f32 {
        self.x * o.x + self.y * o.y
    }

    /// Screen convention: +y is down, so this matches `docs/22-aiming-crosshair.md`.
    pub fn from_angle(a: f32) -> Vec2 {
        Vec2::new(a.cos(), a.sin())
    }

    pub fn angle(self) -> f32 {
        self.y.atan2(self.x)
    }

    pub fn clamp_len(self, max: f32) -> Vec2 {
        let l = self.len();
        if l <= max || l <= f32::EPSILON {
            self
        } else {
            self * (max / l)
        }
    }

    pub fn distance(self, o: Vec2) -> f32 {
        (self - o).len()
    }

    pub fn distance_sq(self, o: Vec2) -> f32 {
        (self - o).len_sq()
    }

    pub fn is_finite(self) -> bool {
        self.x.is_finite() && self.y.is_finite()
    }
}

impl Add for Vec2 {
    type Output = Vec2;
    fn add(self, o: Vec2) -> Vec2 {
        Vec2::new(self.x + o.x, self.y + o.y)
    }
}
impl Sub for Vec2 {
    type Output = Vec2;
    fn sub(self, o: Vec2) -> Vec2 {
        Vec2::new(self.x - o.x, self.y - o.y)
    }
}
impl Mul<f32> for Vec2 {
    type Output = Vec2;
    fn mul(self, s: f32) -> Vec2 {
        Vec2::new(self.x * s, self.y * s)
    }
}
impl Div<f32> for Vec2 {
    type Output = Vec2;
    fn div(self, s: f32) -> Vec2 {
        Vec2::new(self.x / s, self.y / s)
    }
}
impl Neg for Vec2 {
    type Output = Vec2;
    fn neg(self) -> Vec2 {
        Vec2::new(-self.x, -self.y)
    }
}
impl AddAssign for Vec2 {
    fn add_assign(&mut self, o: Vec2) {
        self.x += o.x;
        self.y += o.y;
    }
}
impl SubAssign for Vec2 {
    fn sub_assign(&mut self, o: Vec2) {
        self.x -= o.x;
        self.y -= o.y;
    }
}

/// Integer point, for mask-space work where floats would invite rounding drift.
#[derive(Copy, Clone, Debug, Default, PartialEq, Eq, Hash)]
#[cfg_attr(feature = "serde", derive(serde::Serialize, serde::Deserialize))]
pub struct Point {
    pub x: i32,
    pub y: i32,
}

impl Point {
    pub const fn new(x: i32, y: i32) -> Self {
        Point { x, y }
    }
    pub fn to_vec2(self) -> Vec2 {
        Vec2::new(self.x as f32, self.y as f32)
    }
    pub fn distance_sq(self, o: Point) -> i64 {
        let dx = (self.x - o.x) as i64;
        let dy = (self.y - o.y) as i64;
        dx * dx + dy * dy
    }
}

impl From<Vec2> for Point {
    fn from(v: Vec2) -> Point {
        Point::new(v.x.floor() as i32, v.y.floor() as i32)
    }
}

// ---------------------------------------------------------------------------
// Aabb
// ---------------------------------------------------------------------------

/// Axis-aligned box stored by centre and half-extents.
#[derive(Copy, Clone, Debug, PartialEq)]
pub struct Aabb {
    pub center: Vec2,
    pub half: Vec2,
}

impl Aabb {
    pub fn from_center_size(center: Vec2, w: f32, h: f32) -> Self {
        Aabb {
            center,
            half: Vec2::new(w * 0.5, h * 0.5),
        }
    }

    pub fn min(self) -> Vec2 {
        self.center - self.half
    }

    pub fn max(self) -> Vec2 {
        self.center + self.half
    }

    pub fn width(self) -> f32 {
        self.half.x * 2.0
    }

    pub fn height(self) -> f32 {
        self.half.y * 2.0
    }

    pub fn contains_point(self, p: Vec2) -> bool {
        let mn = self.min();
        let mx = self.max();
        p.x >= mn.x && p.x <= mx.x && p.y >= mn.y && p.y <= mx.y
    }

    /// Boxes touching exactly at an edge do **not** overlap. A resting body's
    /// bottom edge coincides with the ground's top edge every tick; counting that
    /// as an overlap makes it sink.
    pub fn overlaps(self, o: Aabb) -> bool {
        let (a0, a1) = (self.min(), self.max());
        let (b0, b1) = (o.min(), o.max());
        a0.x < b1.x && a1.x > b0.x && a0.y < b1.y && a1.y > b0.y
    }

    /// Inclusive integer pixel bounds `(x0, y0, x1, y1)` for mask iteration:
    /// `floor(min)` to `ceil(max) - 1`.
    pub fn pixel_bounds(self) -> (i32, i32, i32, i32) {
        let mn = self.min();
        let mx = self.max();
        (
            mn.x.floor() as i32,
            mn.y.floor() as i32,
            (mx.x.ceil() as i32) - 1,
            (mx.y.ceil() as i32) - 1,
        )
    }

    pub fn translated(self, d: Vec2) -> Aabb {
        Aabb {
            center: self.center + d,
            half: self.half,
        }
    }
}

// ---------------------------------------------------------------------------
// Scalar helpers
// ---------------------------------------------------------------------------

/// Move `current` toward `target` by at most `max_delta`, never overshooting.
/// Every movement rule in `docs/20-player-movement.md` §3 is written in terms of it.
pub fn approach(current: f32, target: f32, max_delta: f32) -> f32 {
    let d = target - current;
    let m = max_delta.abs();
    if d.abs() <= m {
        target
    } else {
        current + d.signum() * m
    }
}

pub fn lerp(a: f32, b: f32, t: f32) -> f32 {
    a + (b - a) * t
}

pub fn clamp01(v: f32) -> f32 {
    v.clamp(0.0, 1.0)
}

/// 3t² − 2t³, with `t` clamped to 0..1.
pub fn smoothstep(t: f32) -> f32 {
    let t = clamp01(t);
    t * t * (3.0 - 2.0 * t)
}

/// Into `(−π, π]`.
///
/// The lower bound is exclusive, so anything landing on −π folds up to +π — they
/// are the same direction, and the half-open convention has to pick one. The fold
/// uses a small epsilon because inputs like `-3.0 * PI` do not survive f32 rounding
/// exactly: they land a fraction of a micro-radian *above* −2π, which puts the
/// result at −π + 5e-7 rather than at −π. Snapping that band costs 1e-5 rad of
/// precision, two orders of magnitude below the wire quantisation in
/// `docs/22-aiming-crosshair.md` §2.
pub fn wrap_to_pi(a: f32) -> f32 {
    const BOUNDARY_EPS: f32 = 1e-5;
    let mut a = (a + PI).rem_euclid(TAU) - PI;
    if a <= -PI + BOUNDARY_EPS {
        a += TAU;
    }
    a
}

/// Angle → `u16`, wrapping, so there is no special handling at the ±π boundary
/// (`docs/22-aiming-crosshair.md` §2).
pub fn quantize_angle(a: f32) -> u16 {
    let turns = a / TAU;
    let frac = turns - turns.floor();
    // Round-to-nearest, then wrap 65536 back to 0.
    ((frac * 65536.0).round() as i64 & 0xFFFF) as u16
}

pub fn dequantize_angle(q: u16) -> f32 {
    (q as f32 / 65536.0) * TAU
}

/// Shortest-arc interpolation between two angles, in radians.
pub fn lerp_angle(from: f32, to: f32, t: f32) -> f32 {
    from + wrap_to_pi(to - from) * t
}

/// Exact integer square root — never `(n as f32).sqrt() as i32`. Circle spans are
/// built from this, and a platform-dependent rounding difference would break the
/// bit-identical carve guarantee. Negative input returns 0.
pub fn isqrt(n: i32) -> i32 {
    if n <= 0 {
        return 0;
    }
    let n = n as u32;
    // Newton's method from a power-of-two seed; converges in a handful of steps.
    let mut x = 1u32 << ((32 - n.leading_zeros()).div_ceil(2));
    loop {
        let y = (x + n / x) / 2;
        if y >= x {
            break;
        }
        x = y;
    }
    x as i32
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn approach_never_overshoots() {
        assert_eq!(approach(0.0, 10.0, 3.0), 3.0);
        assert_eq!(approach(0.0, 10.0, 100.0), 10.0);
        assert_eq!(approach(10.0, 0.0, 3.0), 7.0);
        assert_eq!(approach(10.0, 0.0, 100.0), 0.0);
        assert_eq!(approach(-5.0, 5.0, 2.0), -3.0);
        assert_eq!(approach(5.0, 5.0, 2.0), 5.0);
        // A negative max_delta is treated as its magnitude, not as a reversal.
        assert_eq!(approach(0.0, 10.0, -3.0), 3.0);
    }

    #[test]
    fn approach_reaches_the_target_exactly() {
        let mut v = 0.0f32;
        for _ in 0..1000 {
            v = approach(v, 7.5, 0.1);
        }
        assert_eq!(v, 7.5);
    }

    #[test]
    fn lerp_endpoints() {
        assert_eq!(lerp(3.0, 9.0, 0.0), 3.0);
        assert_eq!(lerp(3.0, 9.0, 1.0), 9.0);
        assert_eq!(lerp(3.0, 9.0, 0.5), 6.0);
    }

    #[test]
    fn smoothstep_endpoints_and_monotonicity() {
        assert_eq!(smoothstep(0.0), 0.0);
        assert_eq!(smoothstep(1.0), 1.0);
        assert!((smoothstep(0.5) - 0.5).abs() < 1e-6);
        assert_eq!(smoothstep(-1.0), 0.0);
        assert_eq!(smoothstep(2.0), 1.0);
        let mut prev = -1.0;
        for i in 0..=100 {
            let v = smoothstep(i as f32 / 100.0);
            assert!(v >= prev, "not monotonic at {i}");
            prev = v;
        }
    }

    #[test]
    fn wrap_to_pi_folds_multiples_of_tau() {
        assert!((wrap_to_pi(0.0)).abs() < 1e-6);
        assert!((wrap_to_pi(3.0 * PI) - PI).abs() < 1e-5);
        assert!((wrap_to_pi(-3.0 * PI) - PI).abs() < 1e-5);
        assert!((wrap_to_pi(PI) - PI).abs() < 1e-6);
        assert!((wrap_to_pi(TAU)).abs() < 1e-5);
        for i in -50..50 {
            let a = i as f32 * 0.37;
            let w = wrap_to_pi(a);
            assert!(w > -PI - 1e-6 && w <= PI + 1e-6, "{a} -> {w}");
        }
    }

    #[test]
    fn quantize_angle_round_trips_for_all_65536_values() {
        for q in 0..=u16::MAX {
            assert_eq!(quantize_angle(dequantize_angle(q)), q, "q = {q}");
        }
    }

    #[test]
    fn dequantize_of_quantize_is_within_tolerance() {
        let mut a = -10.0f32;
        while a < 10.0 {
            let round = dequantize_angle(quantize_angle(a));
            let err = wrap_to_pi(round - a).abs();
            assert!(err < 1e-4, "angle {a}: error {err}");
            a += 0.013;
        }
    }

    #[test]
    fn quantize_wraps_at_tau() {
        assert_eq!(quantize_angle(0.0), quantize_angle(TAU));
        assert_eq!(quantize_angle(0.0), quantize_angle(-TAU));
        assert_eq!(quantize_angle(0.1), quantize_angle(0.1 + TAU));
    }

    #[test]
    fn from_angle_and_angle_round_trip() {
        let mut a = -PI + 0.001;
        while a < PI {
            let back = Vec2::from_angle(a).angle();
            assert!(wrap_to_pi(back - a).abs() < 1e-5, "{a} -> {back}");
            a += 0.01;
        }
    }

    #[test]
    fn lerp_angle_takes_the_short_way() {
        // 350° to 10° must pass through 0°, not 180°.
        let from = 350f32.to_radians();
        let to = 10f32.to_radians();
        let mid = wrap_to_pi(lerp_angle(from, to, 0.5));
        assert!(mid.abs() < 1e-5, "midpoint was {} deg", mid.to_degrees());
    }

    #[test]
    fn normalized_zero_is_zero_not_nan() {
        let n = Vec2::ZERO.normalized();
        assert_eq!(n, Vec2::ZERO);
        assert!(n.is_finite());
    }

    #[test]
    fn normalized_has_unit_length() {
        for i in 1..100 {
            let v = Vec2::new(i as f32 * 0.7, i as f32 * -1.3);
            assert!((v.normalized().len() - 1.0).abs() < 1e-5);
        }
    }

    #[test]
    fn clamp_len_leaves_shorter_vectors_untouched() {
        let v = Vec2::new(3.0, 4.0); // length 5
        assert_eq!(v.clamp_len(10.0), v);
        let c = v.clamp_len(2.5);
        assert!((c.len() - 2.5).abs() < 1e-5);
        assert!((c.angle() - v.angle()).abs() < 1e-5);
        assert_eq!(Vec2::ZERO.clamp_len(1.0), Vec2::ZERO);
    }

    #[test]
    fn vec2_operators() {
        let a = Vec2::new(1.0, 2.0);
        let b = Vec2::new(4.0, 8.0);
        assert_eq!(a + b, Vec2::new(5.0, 10.0));
        assert_eq!(b - a, Vec2::new(3.0, 6.0));
        assert_eq!(a * 3.0, Vec2::new(3.0, 6.0));
        assert_eq!(b / 2.0, Vec2::new(2.0, 4.0));
        assert_eq!(-a, Vec2::new(-1.0, -2.0));
        assert_eq!(a.dot(b), 4.0 + 16.0);
        let mut c = a;
        c += b;
        assert_eq!(c, Vec2::new(5.0, 10.0));
        c -= b;
        assert_eq!(c, a);
    }

    #[test]
    fn isqrt_matches_floating_point_floor() {
        for n in 0..100_000 {
            let expected = (n as f64).sqrt().floor() as i32;
            assert_eq!(isqrt(n), expected, "isqrt({n})");
        }
    }

    #[test]
    fn isqrt_handles_edges() {
        assert_eq!(isqrt(-5), 0);
        assert_eq!(isqrt(0), 0);
        assert_eq!(isqrt(1), 1);
        assert_eq!(isqrt(i32::MAX), 46340);
    }

    #[test]
    fn pixel_bounds_of_the_player_box() {
        let b = Aabb::from_center_size(Vec2::new(100.0, 100.0), 16.0, 28.0);
        assert_eq!(b.pixel_bounds(), (92, 86, 107, 113));
    }

    #[test]
    fn pixel_bounds_on_fractional_positions() {
        let b = Aabb::from_center_size(Vec2::new(100.5, 100.5), 16.0, 28.0);
        // min = (92.5, 86.5) -> floor (92, 86); max = (108.5, 114.5) -> ceil-1 (108, 114)
        assert_eq!(b.pixel_bounds(), (92, 86, 108, 114));
    }

    #[test]
    fn aabb_edges_and_containment() {
        let b = Aabb::from_center_size(Vec2::new(0.0, 0.0), 10.0, 6.0);
        assert_eq!(b.min(), Vec2::new(-5.0, -3.0));
        assert_eq!(b.max(), Vec2::new(5.0, 3.0));
        assert_eq!(b.width(), 10.0);
        assert_eq!(b.height(), 6.0);
        assert!(b.contains_point(Vec2::ZERO));
        assert!(b.contains_point(Vec2::new(5.0, 3.0)));
        assert!(!b.contains_point(Vec2::new(5.1, 0.0)));
    }

    #[test]
    fn touching_boxes_do_not_overlap() {
        let a = Aabb::from_center_size(Vec2::new(0.0, 0.0), 10.0, 10.0);
        let b = Aabb::from_center_size(Vec2::new(10.0, 0.0), 10.0, 10.0);
        assert!(!a.overlaps(b), "boxes touching at x = 5 must not overlap");
        let c = Aabb::from_center_size(Vec2::new(9.9, 0.0), 10.0, 10.0);
        assert!(a.overlaps(c));
        let d = Aabb::from_center_size(Vec2::new(0.0, 10.0), 10.0, 10.0);
        assert!(!a.overlaps(d));
    }

    #[test]
    fn translated_moves_the_centre_only() {
        let a = Aabb::from_center_size(Vec2::new(1.0, 2.0), 10.0, 6.0);
        let t = a.translated(Vec2::new(3.0, -1.0));
        assert_eq!(t.center, Vec2::new(4.0, 1.0));
        assert_eq!(t.half, a.half);
    }

    #[test]
    fn point_conversions_floor() {
        assert_eq!(Point::from(Vec2::new(3.9, -0.1)), Point::new(3, -1));
        assert_eq!(Point::new(3, 4).to_vec2(), Vec2::new(3.0, 4.0));
        assert_eq!(Point::new(0, 0).distance_sq(Point::new(3, 4)), 25);
    }
}
