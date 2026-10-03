/**
 * T23.35: **where a networked round left the gun, on the body this client draws.** Phaser-free (§A8).
 *
 * `projectile_spawn` says where the server created a round: the shooter's centre on the server, plus `MUZZLE_OFFSET`
 * along the round's own direction (`game-core::weapons::projectile` — `pos: centre + dir · MUZZLE_OFFSET`,
 * `vel: dir · speed`). A client draws a remote ~an interpolation delay behind the server, and itself ahead (predicted),
 * so on a moving body the server's spawn point is not at the drawn gun: a falling gunner's flash hung 87 px from his
 * figure (`effect-lights` §4, measured). The round's direction is exact off the wire, so the gun's tip on the drawn
 * body is the drawn centre plus `MUZZLE_OFFSET` along it — no clock, no extrapolation.
 *
 * Only for a round that left **this owner's gun**: one spawned away from where the server last had its owner (a
 * fragment from a blast, a round whose owner this client has no body for) keeps the server's point.
 *
 * **And for the flash's whole life, not only its first frame.** The flash is listed `MUZZLE_FRAMES` frames; a body
 * falling at 1300 px/s moves ~22 px a frame at 60 fps and far more on a slow one, so a point fixed where the gun was
 * when the event arrived drifted off the figure (163 px measured at a hitch). The scene re-anchors a fresh round's first
 * point to the drawn gun each frame of its flash (`GameScene.anchorMuzzles`).
 */

export interface Pt {
  x: number
  y: number
}

/**
 * How stale the server body we compare against may be, in seconds: the event and the last snapshot can be a few ticks
 * apart, and the owner moves meanwhile. Only the fragment guard reads it — the placement itself has no clock.
 */
export const SPAWN_BODY_LAG_S = 0.25

/**
 * The direction a round left **this owner's gun** in (a unit vector), or `null` when the spawn is not its owner's
 * muzzle — keep the server's point then.
 *
 * - `spawn`, `vel`: the event's `x, y` and `vx, vy`.
 * - `server`: the owner's last server centre and velocity (`null`: unknown).
 */
export function muzzleDir(
  spawn: Pt,
  vel: Pt,
  server: (Pt & { vx: number; vy: number }) | null,
  muzzleOffset: number,
  bodyH: number,
): Pt | null {
  const speed = Math.hypot(vel.x, vel.y)
  if (!server || !(speed > 1e-6)) return null
  const reach = muzzleOffset + bodyH + Math.hypot(server.vx, server.vy) * SPAWN_BODY_LAG_S
  if (Math.hypot(spawn.x - server.x, spawn.y - server.y) > reach) return null
  return { x: vel.x / speed, y: vel.y / speed }
}

/** The gun's tip on a drawn body: its centre plus `muzzleOffset` along `dir` (`muzzleDir`). */
export function gunAt(drawn: Pt, dir: Pt, muzzleOffset: number): Pt {
  return { x: drawn.x + dir.x * muzzleOffset, y: drawn.y + dir.y * muzzleOffset }
}
