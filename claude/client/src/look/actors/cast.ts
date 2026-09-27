/**
 * T23.14: the scene's cast, gathered for the world renderer. Whatever draws an actor (a `PlayerView` today; the
 * animals and birds when their drawing moves here) registers with its scene and hands over one `Actor` per frame;
 * `worldRenderer.ts::createGameWorld` collects them after the scene's update and passes them to `setActors` — so
 * the scenes do not each keep a second list of who is on screen.
 *
 * And the ground the figures stand on (`groundProbe`): the scenes give their mask's `solidAt` once, and a figure
 * asks it where the ground is under each foot (`pose.ts::walk`).
 */
import type Phaser from 'phaser'
import type { Actor } from '../scene'

export interface CastMember {
  /** This frame's actor, or null (hidden: culled, dead and not drawn). */
  actor(): Actor | null
  /**
   * T23.19A: a prop drawn **behind** every figure — a gate, a turret. The actor layer blends in list order, so this
   * decides who covers whom: a player mounted on a turret stands in front of it.
   */
  back?: boolean
}

const casts = new WeakMap<Phaser.Scene, Set<CastMember>>()
const probes = new WeakMap<Phaser.Scene, (x: number, y: number) => boolean>()

export function joinCast(scene: Phaser.Scene, m: CastMember): () => void {
  let set = casts.get(scene)
  if (!set) casts.set(scene, (set = new Set()))
  set.add(m)
  return () => void set?.delete(m)
}

/** The scene's cast this frame: the props (`back`) first, then everyone else, each in join order (a stable draw order). */
export function castOf(scene: Phaser.Scene): Actor[] {
  const out: Actor[] = []
  const front: Actor[] = []
  for (const m of casts.get(scene) ?? []) {
    const a = m.actor()
    if (a) (m.back ? out : front).push(a)
  }
  for (const a of front) out.push(a)
  return out
}

/** The scene's mask test, world px. */
export function setGroundProbe(scene: Phaser.Scene, solidAt: (x: number, y: number) => boolean): void {
  probes.set(scene, solidAt)
}

/** How far below the feet line (px, + down) the ground is at world x, searched ±`GROUND_SEARCH` px; null if none. */
export const GROUND_SEARCH = 12
export function groundDyAt(scene: Phaser.Scene, x: number, feetY: number): number | null {
  const solid = probes.get(scene)
  if (!solid) return null
  const px = Math.round(x)
  const y0 = Math.round(feetY)
  for (let d = -GROUND_SEARCH; d <= GROUND_SEARCH; d++) {
    if (solid(px, y0 + d) && !solid(px, y0 + d - 1)) return d
  }
  return null
}
