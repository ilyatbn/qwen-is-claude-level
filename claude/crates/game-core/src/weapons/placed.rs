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

use crate::constants::{GravityMode, MINE_H, MINE_W};
use crate::items::registry::WeaponId;
use crate::map::Map;
use crate::math::Vec2;
use crate::physics::body::Body;
use crate::physics::resolve::{integrate, Forces};
use crate::player::state::PlayerId;
use crate::weapons::defs::WeaponDef;
use crate::weapons::explode::{explode, BlastSource, ExplosionResult, HitId, HitTarget};

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
        players: &mut [HitTarget],
        // The match's gravity mode (T22.11A, `M22-RULINGS` R30/R14). Beside
        // `players` because it is the same kind of thing: a property of the
        // world this mine is sitting in, which the mine cannot know.
        gravity: GravityMode,
        now: f32,
        dt: f32,
    ) -> Vec<MineOutcome> {
        for m in &mut self.mines {
            // **The match's gravity setting, not a literal `1.0`**
            // (`M22-RULINGS` R30, R14, R48). Until T22.11A this passed `1.0`
            // and `false` unconditionally, so in a low-gravity match this body
            // fell at twice the speed of the player who dropped it — a bug
            // visible in a shipped mode, not polish. `Forces::falling` is the
            // one place the mode becomes this body's scale **and** its contact
            // rules, so the two cannot drift apart at four call sites.
            integrate(map, &mut m.body, Forces::falling(gravity), dt);
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
                    p.alive
                        && p.id != HitId::Player(m.owner)
                        && (p.pos - m.pos()).len() <= m.trigger_radius
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
    pub fn destroy_in_blast(&mut self, at: Vec2, radius: f32) -> Vec<MineOutcome> {
        let mut gone = Vec::new();
        self.mines.retain(|m| {
            if (m.pos() - at).len() <= radius {
                // A destroyed mine does **not** detonate: chaining would make one
                // rocket into a cascade, and `docs/31` §5 already rules that out
                // for grenades for the same reason. `explosion: None` is what
                // says so.
                gone.push(MineOutcome {
                    id: m.id,
                    reason: MineEnd::Destroyed,
                    at: m.pos(),
                    blast_radius: m.blast_radius,
                    explosion: None,
                });
                false
            } else {
                true
            }
        });
        gone
    }
}

/// T11.07 — proximity mines, wired end to end (§B7).
#[cfg(test)]
mod gravity_modes {
    use super::*;
    use crate::constants::{GravityMode, MapScale, LOW_GRAVITY_SCALE, SIM_DT};
    use crate::map::gen::silhouette::force_borders;
    use crate::map::{CoarseGrid, MapMeta, Mask};
    use crate::weapons::defs;

    fn flat_map() -> Map {
        let (w, h) = (512u32, 512u32);
        let mut mask = Mask::new_empty(w, h);
        for y in 400..h as i32 {
            mask.set_run(y, 0, w as i32 - 1);
        }
        force_borders(&mut mask);
        let meta = MapMeta {
            seed: 1,
            requested_seed: 1,
            attempts: 1,
            used_safe_preset: false,
            scale: MapScale::Small,
            theme: 0,
            spawn_points: Vec::new(),
            teleport_pads: Vec::new(),
            gun_platforms: Vec::new(),
            surface_points: Vec::new(),
            objects: Vec::new(),
            buried_slots: Vec::new(),
            decorations: Vec::new(),
            wind: 0.0,
            traversable_fraction: 1.0,
            asteroids: Vec::new(),
            largest_component: Vec::new(),
            generator: crate::constants::MapGenerator::V1,
        };
        Map::from_parts(mask.clone(), CoarseGrid::build(&mask), meta)
    }

    /// **A mine falls at the match's rate, and in space it hangs where it was
    /// placed** — `M22-RULINGS` R30, R14, R48.
    ///
    /// Until T22.11A this stepper passed a literal `1.0`, so a mine dropped in a
    /// low-gravity match fell at twice the rate of the player who placed it. R14
    /// makes the space case deliberate rather than an accident: *"a mine hanging
    /// in space is a floating proximity mine, which is correct here"* — the lie
    /// `docs/32` §4 rules out is about **ground**, and there is none.
    ///
    /// The `Standard` arm is the control. Without it both other assertions are
    /// satisfied by a stepper that has stopped integrating altogether, which is
    /// the shape of half the bugs in `CLAUDE.md`.
    #[test]
    fn a_mine_falls_by_the_match_gravity_and_hangs_in_space() {
        let def = defs::by_key("mine").expect("the mine weapon");
        let fall = |mode: GravityMode| -> f32 {
            let mut map = flat_map();
            let mut mines = Mines::default();
            let id = mines.place(0, def, Vec2::new(300.0, 40.0), 0.0, 0.0, 1000.0, 0.0);
            for _ in 0..25 {
                mines.step(&mut map, &mut [], mode, 0.0, SIM_DT);
            }
            let m = mines.iter().find(|m| m.id == id).expect("the mine is gone");
            assert!(!m.body.grounded, "precondition: it landed, not a fall");
            m.body.pos.y - 40.0
        };
        let (std, low, space) = (
            fall(GravityMode::Standard),
            fall(GravityMode::Low),
            fall(GravityMode::Space),
        );
        // See `tombstones`' twin for why this is an epsilon and not `assert_eq!`.
        assert!(
            (low - std * LOW_GRAVITY_SCALE).abs() < 0.001,
            "R30: a mine fell {low} px in low gravity against {std} px in \
             standard, which is not the mode's scale"
        );
        assert!(std > 0.0, "control: the fixture cannot see gravity at all");
        assert_eq!(space, 0.0, "R14: a mine drifted in space");
    }
}

#[cfg(test)]
mod t1107 {
    use crate::constants::{
        INVENTORY_SLOTS, MINE_ARM_TIME, MINE_LIFETIME, MINE_TRIGGER_RADIUS, SIM_DT,
    };
    use crate::items::registry::{self, ItemKind, MINE, WEAPON_BAZOOKA};
    use crate::weapons::defs::{self, Delivery};
    use crate::world::{give, GameEvent, RoundPhase, World};

    fn hold(w: &mut World, id: u8, item: u16) -> u8 {
        let slot = (0..INVENTORY_SLOTS as u8)
            .find(|s| {
                w.player(id)
                    .and_then(|p| p.inventory.slot(*s))
                    .is_some_and(|st| st.item == item)
            })
            .expect("slot");
        w.select_slot(id, slot);
        slot
    }

    #[test]
    fn it_matches_the_spec() {
        let w = defs::by_key("mine").expect("mine");
        match w.delivery {
            Delivery::Placed {
                arm_time,
                trigger_radius,
                lifetime,
            } => {
                assert_eq!(arm_time, MINE_ARM_TIME);
                assert_eq!(trigger_radius, MINE_TRIGGER_RADIUS);
                assert_eq!(lifetime, MINE_LIFETIME);
            }
            other => panic!("the mine must be placed: {other:?}"),
        }
        let d = registry::by_key("mine").expect("item");
        assert_eq!(d.kind, ItemKind::Weapon(w.id));
        assert!(d.spawn_weight > 0 || d.crate_weight > 0 || d.buried_weight > 0);
    }

    /// **§B6's destructibility, through a real explosion.**
    ///
    /// `destroy_in_blast` existed from T11.01 with no production caller — only
    /// tests — so a mine was in fact indestructible in a real round and
    /// `MineEnd::Destroyed` was a variant nothing ever constructed. A unit test
    /// on `Mines` could not see that, because it called the function itself
    /// (§A39: count at both ends). This one goes through `World`.
    #[test]
    fn a_real_explosion_destroys_a_mine_and_says_so() {
        let mut w = World::for_test(4242, crate::constants::MapScale::Small);
        w.set_phase(RoundPhase::Playing);
        w.add_player(0, 0, "p".into());
        give(&mut w, 0, MINE, 2);
        hold(&mut w, 0, MINE);
        let _ = w.fire(0, 1.0);
        w.step(SIM_DT);
        assert_eq!(w.mines.len(), 1, "the mine was never placed");
        let _ = w.drain_events();

        // A rocket at the mine's feet. Same world, same blast path everything
        // else uses.
        let at = w.mines.iter().next().expect("mine").pos();
        w.explode_for_test(at, WEAPON_BAZOOKA, 0, 2.0);
        w.step(SIM_DT);

        assert_eq!(w.mines.len(), 0, "an explosion did not destroy the mine");
        let ended: Vec<_> = w
            .drain_events()
            .into_iter()
            .filter_map(|e| match e {
                GameEvent::MineEnded { reason, .. } => Some(reason),
                _ => None,
            })
            .collect();
        assert_eq!(
            ended,
            vec![super::MineEnd::Destroyed],
            "no MineEnded{{Destroyed}} was emitted — the variant is unreachable"
        );
    }

    /// Control for the above: a blast that misses leaves the mine alone. Without
    /// it, "the explosion destroyed the mine" also passes for a build where mines
    /// vanish on their own.
    #[test]
    fn a_blast_that_misses_leaves_the_mine_alone() {
        let mut w = World::for_test(4242, crate::constants::MapScale::Small);
        w.set_phase(RoundPhase::Playing);
        w.add_player(0, 0, "p".into());
        give(&mut w, 0, MINE, 2);
        hold(&mut w, 0, MINE);
        let _ = w.fire(0, 1.0);
        w.step(SIM_DT);
        let at = w.mines.iter().next().expect("mine").pos();
        let far = crate::math::Vec2::new(at.x + 400.0, at.y);
        w.explode_for_test(far, WEAPON_BAZOOKA, 0, 2.0);
        w.step(SIM_DT);
        assert_eq!(w.mines.len(), 1, "a distant blast destroyed the mine");
    }
}
