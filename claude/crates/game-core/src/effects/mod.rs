//! Weather: the scheduler and the four effects.
//!
//! Every 30–45 seconds the map turns on the players. Effects are seeded,
//! telegraphed and short — they exist to break stalemates and to make cover
//! temporary (`docs/13-weather-effects.md`).
//!
//! Everything here is simulated on the server only. Hazard positions are
//! broadcast explicitly rather than re-rolled by clients, because a client that
//! disagreed about where the lava is would put someone in fire they cannot see
//! (`docs/13-weather-effects.md` §7).

pub mod fog;
pub mod lava;
pub mod meteor;
pub mod scheduler;
pub mod toxic;

pub use scheduler::{active_duration, ActiveEffect, EffectEvent, EffectPhase, EffectScheduler};

// `EffectKind` lives in `weapons::explode` because `DamageSource` needs it and
// `explode` is the lower layer. Re-exported here so effect code reads naturally.
pub use crate::weapons::explode::EffectKind;
