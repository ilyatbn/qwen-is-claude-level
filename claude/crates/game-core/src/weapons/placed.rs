//! Placed delivery — proximity mines (`docs/71-amendments-v3.md` §B6, §B7).
//!
//! A mine arms after `arm_time`, detonates when a player **other than the owner**
//! comes within `trigger_radius`, despawns at `lifetime`, and is destroyed by a
//! nearby explosion without detonating.
//!
//! Two rules that are gameplay, not implementation detail:
//!
//! - **It ignores its owner's approach**, or laying one is suicide. But it *does*
//!   damage the owner when it goes off — standing on your own mine is your
//!   problem, exactly as standing on your own grenade is (`docs/31` §2).
//! - **Explosions destroy it.** That is what stops a map filling with mines and
//!   makes clearing a chokepoint a real play.

use crate::items::registry::WeaponId;
use crate::map::Map;
use crate::math::Vec2;
use crate::physics::body::Body;
use crate::physics::resolve::integrate;
use crate::player::state::PlayerId;
use crate::weapons::defs::WeaponDef;
use crate::weapons::explode::{explode, BlastSource, ExplosionResult, PlayerHitTarget};

pub type MineId = u32;

#[derive(Debug, Clone)]
pub struct Mine {
    pub id: MineId,
    pub owner: PlayerId,
    pub weapon: WeaponId,
    pub body: Body,
    pub armed_at: f32,
    pub expires_at: f32,
    pub trigger_radius: f32,
    pub damage: f32,
    pub blast_radius: f32,
}

impl Mine {
    pub fn is_armed(&self, now: f32) -> bool {
        now >= self.armed_at
    }
    pub fn pos(&self) -> Vec2 {
        self.body.pos
    }
}

/// Why a mine left the world, so the client can tell a bang from a timeout.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MineEnd {
    Detonated,
    Expired,
    Destroyed,
}

/// What the caller needs to know about a mine that is already gone.
///
/// `step` removes the mine before it returns, so handing back only an id would
/// leave the caller unable to emit the carve event for the blast it just caused
/// — the §A24 trap this project has already paid for with projectiles. The
/// position and radius come with it.
#[derive(Debug)]
pub struct MineOutcome {
    pub id: MineId,
    pub reason: MineEnd,
    pub at: Vec2,
    pub blast_radius: f32,
    pub explosion: Option<ExplosionResult>,
}

#[derive(Debug, Default)]
pub struct Mines {
    mines: Vec<Mine>,
    next_id: MineId,
}

/// A mine's own collision box. Small enough to sit in a doorway.
const MINE_W: f32 = 10.0;
const MINE_H: f32 = 6.0;

impl Mines {
    pub fn len(&self) -> usize {
        self.mines.len()
    }
    pub fn is_empty(&self) -> bool {
        self.mines.is_empty()
    }
    pub fn iter(&self) -> impl Iterator<Item = &Mine> {
        self.mines.iter()
    }

    /// Place one. `def` supplies damage and blast radius; the `Placed` timings
    /// come from the delivery.
    #[allow(clippy::too_many_arguments)]
    pub fn place(
        &mut self,
        owner: PlayerId,
        def: &WeaponDef,
        at: Vec2,
        arm_time: f32,
        trigger_radius: f32,
        lifetime: f32,
        now: f32,
    ) -> MineId {
        let id = self.next_id;
        self.next_id += 1;
        self.mines.push(Mine {
            id,
            owner,
            weapon: def.id,
            body: Body::sized(at, MINE_W, MINE_H),
            armed_at: now + arm_time,
            expires_at: now + lifetime,
            trigger_radius,
            damage: def.damage,
            blast_radius: def.blast_radius,
        });
        id
    }

    /// Advance every mine: fall, then check triggers and lifetimes.
    ///
    /// Falling matters for the same reason it matters for world items — a mine
    /// hanging in the air over a crater is the lie `docs/32` §4 rules out, and
    /// this project has already shipped that bug once.
    pub fn step(
        &mut self,
        map: &mut Map,
        players: &mut [PlayerHitTarget],
        now: f32,
        dt: f32,
    ) -> Vec<MineOutcome> {
        for m in &mut self.mines {
            integrate(map, &mut m.body, 1.0, dt);
        }

        let mut ended = Vec::new();
        let mut i = 0;
        while i < self.mines.len() {
            let m = self.mines[i].clone();

            if now >= m.expires_at {
                self.mines.remove(i);
                ended.push(MineOutcome {
                    id: m.id,
                    reason: MineEnd::Expired,
                    at: m.pos(),
                    blast_radius: m.blast_radius,
                    explosion: None,
                });
                continue;
            }

            let triggered = m.is_armed(now)
                && players.iter().any(|p| {
                    // The owner's own approach never sets it off. Their presence
                    // in the blast when someone *else* sets it off is another
                    // matter, and `explode` handles that.
                    p.alive && p.id != m.owner && (p.pos - m.pos()).len() <= m.trigger_radius
                });

            if triggered {
                self.mines.remove(i);
                let result = explode(
                    map,
                    players,
                    m.pos(),
                    m.blast_radius,
                    m.damage,
                    BlastSource::Fired {
                        owner: m.owner,
                        weapon: m.weapon,
                    },
                );
                ended.push(MineOutcome {
                    id: m.id,
                    reason: MineEnd::Detonated,
                    at: m.pos(),
                    blast_radius: m.blast_radius,
                    explosion: Some(result),
                });
                continue;
            }

            i += 1;
        }
        ended
    }

    /// Hash every mine into a replay's state hash.
    ///
    /// Next to the fields rather than written from `state_hash`, per §A34: a
    /// hash composed from outside covers what its author happened to remember,
    /// and mines are simulation state — one armed a tick earlier changes who
    /// dies.
    pub fn hash_into(&self, h: &mut blake3::Hasher) {
        h.update(&(self.mines.len() as u32).to_le_bytes());
        for m in &self.mines {
            h.update(&m.id.to_le_bytes());
            h.update(&[m.owner]);
            h.update(&m.weapon.0.to_le_bytes());
            h.update(&m.body.pos.x.to_le_bytes());
            h.update(&m.body.pos.y.to_le_bytes());
            h.update(&m.body.vel.x.to_le_bytes());
            h.update(&m.body.vel.y.to_le_bytes());
            h.update(&[m.body.grounded as u8]);
            h.update(&m.armed_at.to_le_bytes());
            h.update(&m.expires_at.to_le_bytes());
        }
        // The id counter, not just the mines: two worlds holding identical mines
        // but about to allocate different ids are not the same state.
        h.update(&self.next_id.to_le_bytes());
    }

    /// Destroy every mine caught in a blast, **without** detonating it.
    ///
    /// `docs/31` §5: explosions do not chain. A grenade caught in a blast is
    /// destroyed silently, and a mine is no different — chaining is fun and makes
    /// the tick non-terminating in the worst case.
    pub fn destroy_in_blast(&mut self, at: Vec2, radius: f32) -> Vec<MineId> {
        let mut gone = Vec::new();
        self.mines.retain(|m| {
            if (m.pos() - at).len() <= radius {
                gone.push(m.id);
                false
            } else {
                true
            }
        });
        gone
    }
}
