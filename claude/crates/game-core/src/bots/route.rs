//! T23.26 B — following a planned route (`docs/78` §A2): when to plan, when to plan
//! again, and the buttons, aim and trigger that make each step.
//!
//! The planner (`nav.rs`) answers *how to get there*; exploration and the goal still
//! answer *where*. A route is followed step by step — walk and hop on the legs, hold
//! the pack on a jet step and let go on a ledge to refuel, swing the shovel at the rock
//! of a dig step — and abandoned for a new plan when the goal moves, the terrain under
//! the remaining steps changes, or a step takes more than twice its price.
//!
//! While a search is still running, or found nothing, the walking model's greedy step
//! drives as it always did: the route is an improvement on it, never a precondition.

use super::nav::{Grid, Move, Progress, Search, Step, Want};
use crate::constants::{
    GravityMode, BOT_FLEE_COST_MAX, BOT_FLEE_GAIN, BOT_HIDE_COST_MAX, BOT_HIDE_KEEP_OFF,
    BOT_NAV_CELL, BOT_NAV_COST_MAX, BOT_NAV_FUEL_STEP, BOT_NAV_NODES_MAX, BOT_NAV_NODES_PER_TICK,
    BOT_NAV_RETRY, BOT_NAV_STEP_SLACK, BOT_STUCK_PX, BOT_STUCK_WINDOW, BOT_WANDER_ARRIVED,
    JETPACK_DRAIN, JETPACK_MAX_SPEED, JETPACK_MIN_FUEL_TO_ENGAGE, WALK_SPEED,
};
use crate::items::registry::SHOVEL;
use crate::math::Vec2;
use crate::player::input::button;
use crate::player::state::PlayerState;
use crate::world::World;

/// What a route step asks of the bot this tick, beside its movement buttons.
#[derive(Copy, Clone, Debug, Default, PartialEq)]
pub(super) struct NavStep {
    pub buttons: u8,
    /// Aim here instead of at the goal (a dig step's rock).
    pub aim: Option<Vec2>,
    /// Swing: the shovel is in hand, ready, and the step's rock is still there.
    pub fire: bool,
    /// The slot to hold for this step (the shovel's, while digging).
    pub select: Option<u8>,
    /// The swing is the stuck response at a lip, not a planned dig step.
    pub unstick: bool,
    /// The step's kind (T23.26C: the still counter's cause).
    pub how: Move,
}

/// Where a route goes: what the planner was asked, and the point it was asked about
/// (so a moving goal can be told from a still one).
#[derive(Copy, Clone, Debug, PartialEq)]
pub(super) struct Target {
    pub want: Want,
    pub at: Vec2,
    /// T23.26E: may the route dig? `false` asks for an **open** route only — walking,
    /// hopping, falling, the pack and pads — which a fight asks for first (`enemy_target`).
    pub dig: bool,
}

/// Where the planner runs: under gravity, not riding a platform — on legs or (T23.26C
/// item 3) on wings. Space has its own flying model (`space::steer`), a rider the
/// platform.
pub(super) fn navigates(world: &World, me: &PlayerState) -> bool {
    world.gravity != GravityMode::Space && me.mount.mounted.is_none()
}

/// The cell a point is in.
fn cell_of(p: Vec2) -> (i32, i32) {
    (
        (p.x / BOT_NAV_CELL).floor() as i32,
        (p.y / BOT_NAV_CELL).floor() as i32,
    )
}

/// An item on the ground: a node beside its cell (`PICKUP_RADIUS` is over a cell). One
/// sunk a cell under the floor is "arrived at" and not picked up; `Bot::navigate` gives
/// such an item up (T23.26C — asking for a node within the pickup's reach instead, so the
/// route dug down to it, measured more void deaths: 0.45 a bot a round against 0.32).
pub(super) fn item_target(at: Vec2) -> Target {
    let (x, y) = cell_of(at);
    Target {
        want: Want::Near {
            x,
            y,
            r: 1,
            sight: None,
        },
        at,
        dig: true,
    }
}

/// A wander point: anywhere within `BOT_WANDER_ARRIVED` of it.
pub(super) fn wander_target(at: Vec2) -> Target {
    let (x, y) = cell_of(at);
    Target {
        want: Want::Near {
            x,
            y,
            r: (BOT_WANDER_ARRIVED / BOT_NAV_CELL) as i32,
            sight: None,
        },
        at,
        dig: true,
    }
}

/// Out of `from`'s line of sight, standing — where a hurt bot breaks contact to (§A2).
pub(super) fn hide_target(from: Vec2) -> Target {
    Target {
        want: Want::Hide { from },
        at: from,
        dig: true,
    }
}

/// T23.26C item 7: somewhere standing, out of `from`'s sight and `BOT_FLEE_GAIN` further
/// from it than `pos` is — where a hurt bot runs (or flies) to first. Never dug to: a
/// bot that has to dig to get away is cornered, and digs in (`hide_target`) instead.
pub(super) fn away_target(from: Vec2, pos: Vec2) -> Target {
    Target {
        want: Want::Away {
            from,
            beyond: (pos - from).len() + BOT_FLEE_GAIN,
        },
        at: from,
        dig: false,
    }
}

/// An enemy behind rock: a node within `hold` of it with a clear line to it — where the
/// fight can start. T23.26E (owner: *"they should always prefer open grounds"*): asked
/// with `dig` false first — a bot regains its line **over open ground** and tunnels at an
/// enemy only when no open route exists (`Bot::navigate`).
pub(super) fn enemy_target(at: Vec2, hold: f32, dig: bool) -> Target {
    let (x, y) = cell_of(at);
    Target {
        want: Want::Near {
            x,
            y,
            r: (hold / BOT_NAV_CELL).ceil().max(1.0) as i32,
            sight: Some(at),
        },
        at,
        dig,
    }
}

#[derive(Default)]
pub(super) struct Route {
    search: Option<(Search, Target)>,
    path: Vec<Step>,
    /// Index of the next step to reach.
    next: usize,
    /// What `path` leads to.
    target: Option<Target>,
    /// `World::carve_seq` when `path` was last checked against the terrain.
    carve_seq: u32,
    /// Seconds spent on the current step.
    on_step: f32,
    /// Targets the planner found no route to, and until when each is not asked about
    /// again — so an unreachable goal costs one search a `BOT_NAV_RETRY`, not one a tick.
    /// A list, not the last one: an unreachable item, then an unreachable wander cell,
    /// would otherwise un-refuse the item and the goal would flap between the two.
    failed: Vec<(Target, f32)>,
    /// Seconds the body has been on this step without moving `BOT_STUCK_PX`, and where
    /// it is measured from: a lip the grid calls air (a sliver a swing left), or a ledge's
    /// edge holding up a body the plan has falling.
    stalled: f32,
    stall_at: Vec2,
    /// The point last tick's step aimed at. **A swing uses the aim the body already
    /// has** — `World::fire` reads the player's aim, which the queued input only sets in
    /// the step after — so a dig swings only once the aim has been held for a tick.
    /// Without this the first swing went along the old aim: a slash at the floor
    /// toward the goal, measured, that left the bot on a slope it could not walk off.
    last_aim: Option<Vec2>,
    /// T23.26C: plans dropped because the tank held less than a jet step expected.
    pub tank_replans: u32,
    /// Tests only: the tank rule planted out (`Bot::without_tank_rule`).
    pub tank_rule_off: bool,
    /// Where the body was last tick (a teleport is a jump in it).
    last_pos: Vec2,
}

impl Route {
    pub fn clear(&mut self) {
        self.search = None;
        self.path.clear();
        self.next = 0;
        self.target = None;
        self.last_aim = None;
    }

    /// Was `t` refused by the planner within `BOT_NAV_RETRY`?
    pub fn refused(&self, t: &Target, now: f32) -> bool {
        self.failed
            .iter()
            .any(|(f, until)| now < *until && same_target(f, t))
    }

    /// Seconds the current route was priced at (0 with none) — what a wander target is
    /// given before it is abandoned.
    pub fn planned_s(&self) -> f32 {
        if self.target.is_none() {
            return 0.0;
        }
        self.path.iter().map(|s| s.cost).sum()
    }

    /// The route to `t` was followed to its end.
    pub fn finished(&self, t: &Target) -> bool {
        self.target.is_some_and(|r| same_target(&r, t)) && self.next >= self.path.len()
    }

    /// The route is live and has steps left.
    pub fn following(&self) -> bool {
        self.target.is_some() && self.next < self.path.len()
    }

    /// This tick's step toward `target`, or `None` to let the greedy model drive (a
    /// search still running, no route, or the route done).
    #[allow(clippy::too_many_arguments)]
    pub fn step(
        &mut self,
        world: &World,
        me: &PlayerState,
        target: Target,
        can_dig: bool,
        now: f32,
        dt: f32,
        replans: &mut u32,
    ) -> Option<NavStep> {
        let pos = me.body.pos;
        let grid = Grid::new(&world.map);
        // A body that moved further than any step in one tick was teleported (or thrown by
        // a vortex, or respawned): a pad sends you to a random other one, and the plan
        // may not be where it landed. Plan again from here.
        if (pos - self.last_pos).len() > 8.0 * BOT_NAV_CELL {
            self.clear();
        }
        self.last_pos = pos;

        // A new goal, or the goal moved off the end of the route: plan again.
        if !self.target.is_some_and(|t| same_target(&t, &target)) && !self.searching_for(&target) {
            self.clear();
            if self.refused(&target, now) {
                return None;
            }
            let fuel = me.jetpack.fuel;
            // Cover from an enemy has to be *near* (§A2: "digging in if none is near"):
            // a hurt bot under fire does not cross the map to hide.
            let bound = match target.want {
                Want::Hide { .. } => BOT_HIDE_COST_MAX,
                Want::Away { .. } => BOT_FLEE_COST_MAX,
                _ => BOT_NAV_COST_MAX,
            };
            let s = Search::new(&world.map, pos, fuel, target.want, BOT_NAV_NODES_MAX, bound);
            let mut s = s?;
            if me.move_mods().flying {
                s.flying();
            }
            s.dig = can_dig && target.dig;
            if let Want::Hide { from: p } | Want::Away { from: p, .. } = target.want {
                s.avoid = Some((p, (pos - p).len() * BOT_HIDE_KEEP_OFF));
            }
            if let Want::Away { from: p, .. } = target.want {
                s.side = Some((p, pos - p));
            }
            self.search = Some((s, target));
            *replans += 1;
        }

        // Advance a running search; adopt what it found.
        if let Some((s, t)) = self.search.as_mut() {
            match s.run(&world.map, BOT_NAV_NODES_PER_TICK) {
                Progress::Searching => return None,
                Progress::NoRoute => {
                    let t = *t;
                    self.refuse(t, now);
                    return None;
                }
                Progress::Found(path) => {
                    self.target = Some(*t);
                    self.path = path;
                    self.next = 1;
                    self.on_step = 0.0;
                    self.carve_seq = world.carve_seq();
                    self.search = None;
                }
            }
        }
        if !self.following() {
            // In cover, and still? A hiding place the enemy has walked round is not cover
            // any more: plan again (`nav::satisfies`). And a run that got away is run
            // again while the enemy is still in sight range: each leg wants
            // `BOT_FLEE_GAIN` more, so a hurt bot keeps going until contact is broken
            // rather than standing at the end of its first leg (T23.26C item 7).
            if let (Some(t), Some((x, y))) = (self.target, grid.locate(pos)) {
                let stale = match t.want {
                    Want::Hide { .. } => !super::nav::satisfies(&grid, target.want, x, y),
                    Want::Away { .. } => true,
                    Want::Near { .. } => false,
                };
                if stale {
                    self.clear();
                }
            }
            return None;
        }

        // The terrain moved under the route: check what is left of it, cell by cell.
        if world.carve_seq() != self.carve_seq {
            self.carve_seq = world.carve_seq();
            if !self.path[self.next..].iter().all(|s| still_good(&grid, s)) {
                self.clear();
                return None;
            }
        }

        // Where the body is, against the route: on the next step's cell → advance;
        // further along it (a fall that took two cells at once) → skip ahead.
        let here = grid.locate(pos);
        if let Some(h) = here {
            if let Some(k) = (self.next..self.path.len().min(self.next + 4))
                .find(|&k| (self.path[k].x, self.path[k].y) == h && arrived(&self.path[k], me))
            {
                self.next = k + 1;
                self.on_step = 0.0;
                self.stalled = 0.0;
                self.stall_at = pos;
            }
        }
        if !self.following() {
            return None;
        }
        self.on_step += dt;
        let s = self.path[self.next];
        if self.on_step > 2.0 * s.cost + BOT_NAV_STEP_SLACK {
            // A step that took twice its price is a plan the world disagrees with.
            self.clear();
            return None;
        }
        // **The jetpack is a tank** (T23.26C item 4, `docs/78` §A3). The plan priced every
        // jet against the fuel it expected the bot to hold here; a body that holds less —
        // physics is not the plan, and a fight or a dodge burns fuel the plan never saw —
        // does not press on a climb it cannot finish. It stands (on the ground the pack
        // refills) and plans again from what the tank holds: the new plan rests here
        // first, or goes another way, or finds nothing and the goal is given up
        // (`refused`). In the air it plans again only once the shortfall is a second.
        let burns = matches!(s.how, Move::Jet)
            || (s.how == Move::Dig && s.fuel < self.path[self.next - 1].fuel);
        if burns && !self.tank_rule_off {
            let expected = self.path[self.next - 1].fuel;
            let slack = if me.body.grounded {
                BOT_NAV_FUEL_STEP
            } else {
                JETPACK_DRAIN
            };
            if me.jetpack.fuel + slack < expected {
                self.tank_replans += 1;
                self.clear();
                return Some(NavStep::default());
            }
        }
        let mut out = self.buttons(&grid, me, s, here, now);
        // **Stuck on a step: swing at it, hop, and lean in.** A cell may hold
        // `BOT_NAV_AIR_PX` of rock, and a sliver of it standing up is a wall to a body; a
        // body the plan has falling can sit on a ledge's corner. Not moving for
        // `BOT_STUCK_WINDOW` on any step but a rest is either.
        if matches!(s.how, Move::Rest | Move::Teleport)
            || (pos - self.stall_at).len() >= BOT_STUCK_PX
        {
            self.stalled = 0.0;
            self.stall_at = pos;
        } else {
            self.stalled += dt;
        }
        if self.stalled > BOT_STUCK_WINDOW && out.aim.is_none() {
            out.unstick = true;
            let at = Grid::centre(s.x, s.y);
            let slot = shovel_slot(me);
            out.aim = Some(at);
            out.select = slot.filter(|sl| *sl != me.inventory.selected());
            out.fire = can_dig && slot == Some(me.inventory.selected()) && now >= me.fire_ready_at;
            if me.body.grounded {
                out.buttons |= button::JUMP;
            }
            let dx = at.x - pos.x;
            if dx.abs() > 1.0 {
                out.buttons |= if dx > 0.0 {
                    button::RIGHT
                } else {
                    button::LEFT
                };
            }
        }
        let held = self
            .last_aim
            .zip(out.aim)
            .is_some_and(|(a, b)| (a - b).len() < 1.0);
        out.fire &= held;
        self.last_aim = out.aim;
        Some(out)
    }

    /// Refuse `t` for `BOT_NAV_RETRY`, as a search that found nothing does — for a route
    /// that ended without its goal (T23.26C: an item a node's reach short).
    pub fn refuse(&mut self, t: Target, now: f32) {
        self.failed.retain(|(_, until)| now < *until);
        if self.failed.len() >= REFUSED_KEPT {
            self.failed.remove(0);
        }
        self.failed.push((t, now + BOT_NAV_RETRY));
        self.clear();
    }

    fn searching_for(&self, t: &Target) -> bool {
        self.search
            .as_ref()
            .is_some_and(|(_, st)| same_target(st, t))
    }

    fn buttons(
        &self,
        grid: &Grid,
        me: &PlayerState,
        s: Step,
        here: Option<(i32, i32)>,
        now: f32,
    ) -> NavStep {
        let pos = me.body.pos;
        let goal = Grid::centre(s.x, s.y);
        let dx = goal.x - pos.x;
        // Across: full press until within a quarter cell. **Up or down a column: centre
        // on it**, by velocity, because a node is a body wide and a body one pixel off a
        // shaft's middle catches its lip and hovers there (measured: a tank burned dry at
        // 1 px off).
        let vertical = here.is_some_and(|(hx, _)| hx == s.x);
        let toward = if vertical {
            let want = (dx * CENTRE_GAIN).clamp(-WALK_SPEED, WALK_SPEED);
            let dv = want - me.body.vel.x;
            if dv > CENTRE_DEADBAND {
                button::RIGHT
            } else if dv < -CENTRE_DEADBAND {
                button::LEFT
            } else {
                0
            }
        } else if dx > SNAP {
            button::RIGHT
        } else if dx < -SNAP {
            button::LEFT
        } else {
            0
        };
        // Feet row against the step's: positive when the step is higher.
        let rise = here.map_or(0, |(_, y)| y - s.y);
        let mut out = NavStep {
            how: s.how,
            ..NavStep::default()
        };
        match s.how {
            Move::Start => {}
            Move::Walk => {
                out.buttons = toward;
                if rise > 0 && me.body.grounded {
                    out.buttons |= button::JUMP;
                }
            }
            Move::Hop => {
                out.buttons = toward;
                if me.body.grounded && rise > 0 {
                    out.buttons |= button::JUMP;
                }
            }
            Move::Fall => out.buttons = toward,
            Move::Fly => {
                // Both axes at once. Sideways **by velocity**, as a column is centred on:
                // wings steer through air control, and a full press overshoots a node and
                // swings back (measured: ±1.5 cells round a node for seconds). Up or down
                // by the row the body is located in, which is what arriving tests — a
                // node's centre sits 3 px above where the row changes.
                let want = (dx * CENTRE_GAIN).clamp(-WALK_SPEED, WALK_SPEED);
                let dv = want - me.body.vel.x;
                out.buttons = if dv > CENTRE_DEADBAND {
                    button::RIGHT
                } else if dv < -CENTRE_DEADBAND {
                    button::LEFT
                } else {
                    0
                };
                match here.map(|(_, y)| y.cmp(&s.y)) {
                    Some(std::cmp::Ordering::Greater) => out.buttons |= button::UP,
                    Some(std::cmp::Ordering::Less) => out.buttons |= button::DOWN,
                    _ => {}
                }
            }
            Move::Jet => {
                out.buttons = toward | button::JUMP;
                // Hold the step's height by velocity, as a column is centred on: thrust up
                // while rising slower than the gap asks, and let the pack's gentler gravity
                // settle the rest. A height switch (up under it, off over it) bobbed a body
                // a cell either side of a level jet, and it never arrived.
                let want =
                    ((goal.y - pos.y) * CENTRE_GAIN).clamp(-JETPACK_MAX_SPEED, JETPACK_MAX_SPEED);
                if me.body.vel.y > want + CENTRE_DEADBAND {
                    out.buttons |= button::UP;
                }
            }
            Move::Rest | Move::Teleport => {}
            Move::Dig => {
                let rock = dig_rock(grid, s, here);
                match rock {
                    Some(at) => {
                        out.aim = Some(at);
                        let slot = shovel_slot(me);
                        out.select = slot.filter(|sl| *sl != me.inventory.selected());
                        out.fire = slot == Some(me.inventory.selected()) && now >= me.fire_ready_at;
                        // Lean into a face; hover under a ceiling; nothing to hold over a
                        // floor being dug out from under us.
                        if s.y == here.map_or(s.y, |h| h.1) {
                            out.buttons = toward;
                        } else if rise > 0 {
                            out.buttons = button::JUMP | button::UP;
                        }
                    }
                    // Dug out: it is an ordinary move now.
                    None => {
                        out.buttons = toward;
                        if rise > 0 {
                            out.buttons |= button::JUMP | button::UP;
                        }
                    }
                }
            }
        }
        // Never hover a tank dry: below what starting the pack needs, let go and land.
        if out.buttons & button::UP != 0 && me.jetpack.fuel < JETPACK_MIN_FUEL_TO_ENGAGE * 0.5 {
            out.buttons &= !(button::UP | button::JUMP);
        }
        out
    }
}

/// Centring on a column: the sideways speed wanted per px off its middle, /s, and the
/// speed error tolerated before pressing, px/s: a tenth of a second to close the gap,
/// and a deadband under what 1 px off asks for, so a body a pixel off still moves.
const CENTRE_GAIN: f32 = 10.0;
const CENTRE_DEADBAND: f32 = 5.0;

/// Unreachable targets remembered at once (`Route::failed`).
const REFUSED_KEPT: usize = 8;

/// How near a body's centre must be to a step's column before it stops pressing
/// toward it: a quarter cell.
const SNAP: f32 = BOT_NAV_CELL * 0.25;

/// A step is reached when the body is in its cell — and a rest step only once the tank
/// holds what the plan expected.
fn arrived(s: &Step, me: &PlayerState) -> bool {
    match s.how {
        Move::Rest => me.jetpack.fuel >= s.fuel - BOT_NAV_FUEL_STEP,
        _ => true,
    }
}

/// Two targets name the same goal when they ask the same kind of question about points
/// within the goal's own radius (a cell at least) of each other.
fn same_target(a: &Target, b: &Target) -> bool {
    if a.dig != b.dig {
        return false;
    }
    match (a.want, b.want) {
        (Want::Near { r: ra, .. }, Want::Near { r: rb, .. }) => {
            ra == rb && (a.at - b.at).len() <= (ra.max(1) as f32) * BOT_NAV_CELL
        }
        (Want::Hide { .. }, Want::Hide { .. }) | (Want::Away { .. }, Want::Away { .. }) => true,
        _ => false,
    }
}

/// Is a remaining step still possible after a carve? A move into a node needs the node
/// (a dig step needs only that nothing hard appeared); a walk or a hop needs its ground.
fn still_good(g: &Grid, s: &Step) -> bool {
    match s.how {
        Move::Dig => true,
        Move::Walk | Move::Hop | Move::Rest | Move::Teleport => g.stands(s.x, s.y),
        _ => g.node(s.x, s.y),
    }
}

/// The point to swing at for a dig step, or `None` once its node is all air. **Across,
/// the node's middle**, whichever of its cells is rock: the bore is a node tall, and a
/// swing at one cell's centre is a diagonal that digs the floor out from under the bot
/// (measured: a staircase down where a tunnel was planned). Up or down, the cell being
/// opened, straight above or below.
fn dig_rock(g: &Grid, s: Step, here: Option<(i32, i32)>) -> Option<Vec2> {
    use super::nav::Cell;
    let feet = g.cell(s.x, s.y) == Cell::Rock;
    let head = g.cell(s.x, s.y - 1) == Cell::Rock;
    if !feet && !head {
        return None;
    }
    let c = Grid::centre(s.x, s.y);
    let half = BOT_NAV_CELL * 0.5;
    Some(match here {
        Some((hx, hy)) if hx == s.x && s.y < hy => Vec2::new(c.x, c.y - half),
        Some((hx, hy)) if hx == s.x && s.y > hy => Vec2::new(c.x, c.y + half),
        _ => c,
    })
}

/// The bag slot holding the shovel, if any.
pub(super) fn shovel_slot(me: &PlayerState) -> Option<u8> {
    (0..crate::constants::INVENTORY_SLOTS as u8)
        .find(|&s| me.inventory.slot(s).is_some_and(|st| st.item == SHOVEL))
}
