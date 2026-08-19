//! `effects` — weather, toxic rain, meteors, lava, fog, day/night (docs/02).
//!
//! T4.1 needs [`EffectSchedule`] because docs/04 §6 puts "build effect
//! schedule" at step 3 of the round-start determinism order, before item
//! placement. The scheduler itself is T4.8; day/night is T4.2; the four
//! effects are T4.4–T4.7.

use crate::rng::GameRng;

/// docs/02 §7.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum EffectKind {
    ToxicRain,
    MeteorShower,
    LavaBurst,
    HeavyFog,
}

impl EffectKind {
    /// Wire name (docs/06 §2 `effect_started.kind`). Snake_case per D15.
    pub const fn as_str(self) -> &'static str {
        match self {
            EffectKind::ToxicRain => "toxic_rain",
            EffectKind::MeteorShower => "meteor_shower",
            EffectKind::LavaBurst => "lava_burst",
            EffectKind::HeavyFog => "heavy_fog",
        }
    }
}

/// The precomputed effect timeline for a round (docs/02 §8).
///
/// Built at round start from the round RNG so a seed replays the same
/// timeline. T4.8 fills in the scheduling rules; T4.1 only needs the draw to
/// happen at the right point in the determinism order.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct EffectSchedule {
    pub entries: Vec<(u64, EffectKind)>,
}

impl EffectSchedule {
    /// docs/02 §8. **Stub until T4.8** — it consumes no randomness yet, so the
    /// draw order is unchanged when T4.8 replaces it. That is deliberate: the
    /// placement anchors are re-pinned once, here, rather than twice.
    pub fn build(_rng: &mut GameRng, _round_duration_s: f32) -> Self {
        EffectSchedule::default()
    }
}
