/**
 * T22.04 — the suit thruster's plume, the pure half (§A8: no Phaser here).
 *
 * The owner: *"moving in space requires using energy, from the spacesuits
 * thrusters, so add a cool animation to it so that if i move down, you can see a
 * burst of energy coming from above the player."*
 *
 * # The one rule: the plume fires from the side opposite the direction of travel
 *
 * Move down, the burst is above you. **Derived from velocity, never stored**: the
 * snapshot already carries `vel.x`/`vel.y` per player, so a direction on the wire
 * would be a second answer that can disagree with the body it is drawn on.
 *
 * **T22.04C: the local player's plume follows the thrust, not the travel.** While
 * *braking* — drifting right and thrusting left — the exhaust points right, where
 * the push comes from, and velocity still says right until the body stops; the
 * same for thrusting up out of a well while still falling onto the rock. So the
 * local player's plume points against the thrust the mirror stepped with
 * ([`exhaustDir`], off `Core.thrustAt`), and falls back to velocity only when no
 * direction is held. **Remote players stay on velocity**: their input is not on
 * the wire (the snapshot carries bit 2, "firing", and the move-mods byte, neither
 * of which says which way), and a direction derived from the change in velocity
 * would need the field subtracted across two interpolated snapshots — a second,
 * noisier answer for a cosmetic.
 *
 * # One plume, not two, when two axes are held
 *
 * One, along the resultant. The suit is one engine in the fiction and one
 * `JetpackState` in the simulation (`player::mod.rs` — *"one thrust path, not
 * two"*), and velocity has one direction; two plumes would need the per-axis
 * input, which a remote player's snapshot does not carry.
 */

/** A 2D direction, unit length. */
export interface Dir {
  x: number
  y: number
}

/**
 * Which way the plume points, as a unit vector: **opposite the velocity**.
 *
 * Below `minSpeed` the velocity has no usable direction, and the plume points
 * **down** — the exhaust of an upward push. That is the only push that can start
 * from rest on a rock (`M22-RULINGS` R42: grounded, only a net upward push
 * engages), and it is the case this fallback exists for: the first frame of a
 * lift-off, before the body has any speed.
 */
export function plumeDir(vx: number, vy: number, minSpeed: number): Dir {
  const speed = Math.hypot(vx, vy)
  if (!(speed > minSpeed)) return { x: 0, y: 1 }
  return { x: -vx / speed, y: -vy / speed }
}

/**
 * T22.04C: which way the plume points given the **thrust** being applied: against
 * it, when there is one — the exhaust of a push leaves the other way, whatever the
 * body is doing — and otherwise [`plumeDir`]'s velocity rule. `thrust` is the
 * local player's (`Core.thrustAt`); a remote passes `null`.
 */
export function exhaustDir(thrust: Dir | null, vx: number, vy: number, minSpeed: number): Dir {
  const mag = thrust ? Math.hypot(thrust.x, thrust.y) : 0
  if (thrust && mag > 0) return { x: -thrust.x / mag, y: -thrust.y / mag }
  return plumeDir(vx, vy, minSpeed)
}

/**
 * How far from the body's centre the plume starts, along `dir`: the edge of the
 * body's ellipse, so a sideways plume is not buried half a body deep in the torso
 * and an upward one does not start at the chin.
 *
 * `halfW`/`halfH` are the hull's semi-axes. The radius of an ellipse along a unit
 * direction is `1 / sqrt((x/a)² + (y/b)²)`.
 */
export function hullRadius(dir: Dir, halfW: number, halfH: number): number {
  const k = (dir.x / halfW) ** 2 + (dir.y / halfH) ** 2
  return k > 0 ? 1 / Math.sqrt(k) : 0
}

/**
 * Should a plume be drawn at all?
 *
 * **Derived from three things the scene already has, and nothing else.** The
 * wire's bit 2 (`jetpack.active`) is exactly "the thrusters are firing" in space:
 * `apply_input` drives the pack with `space::engaging` as its engage input, so it
 * is on while a push is being paid for and off the tick it stops — including the
 * tick after the round ends, when every player is handed a neutral input
 * (T21.30; asserted at the wire in `game-server`'s
 * `the_thruster_bit_is_off_when_idle_and_the_tick_after_the_round_ends`). So there
 * is **no new bit**: a "thrusting" bit beside it would be a second flag for one
 * fact.
 *
 * **Space only.** Under gravity the jetpack's push is up whichever way the body is
 * moving — a controlled descent falls while thrusting up — so a plume pointed off
 * velocity would be backwards there. The shipped jetpack keeps its look.
 */
export function plumeOn(alive: boolean, jetpack: boolean, space: boolean): boolean {
  return alive && jetpack && space
}
