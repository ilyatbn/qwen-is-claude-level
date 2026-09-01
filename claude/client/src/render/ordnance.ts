/**
 * Drawing for §A3: tracers, projectile trails and impact flashes.
 *
 * All the bookkeeping is in `ordnance-state.ts` (§A8); this file only draws, and
 * feeds `lights()` straight into the lightmap so ordnance is what makes night
 * combat readable.
 */

import Phaser from 'phaser'
import { C } from '../core'
import {
  bulletStreak,
  LOOK,
  OrdnanceState,
  type Light,
  type ProjectileKind,
} from './ordnance-state'
import { DEPTH } from './backdrop'

// The colour and radius tables used to live here as well as in ordnance-state,
// which is two sources of truth for one thing and the exact shape §B16 warns
// about. `LOOK` is the only one now.

export class OrdnanceLayer {
  private readonly gfx: Phaser.GameObjects.Graphics
  readonly state: OrdnanceState

  constructor(scene: Phaser.Scene) {
    const c = C()
    // §F2: `BEAM_LIFETIME`, and the field it feeds is the **beam's** now — the
    // five ballistic guns fire objects that fly and are drawn below, with the
    // other projectiles.
    this.state = new OrdnanceState(c.BEAM_LIFETIME, c.PROJECTILE_TRAIL_LEN)
    // One Graphics, cleared and redrawn: an object per tracer at 10 shots/s would
    // allocate constantly.
    this.gfx = scene.add.graphics().setDepth(DEPTH.particles)
    // Tracers, trails and flashes are all light. ADD makes them read against dark
    // terrain at night, which is exactly where §A3's "all bullets are visible"
    // was failing — a 2 px white line at 0.09 s was almost impossible to find.
    this.gfx.setBlendMode(Phaser.BlendModes.ADD)
  }

  addTracer(x0: number, y0: number, x1: number, y1: number): void {
    this.state.addTracer(x0, y0, x1, y1)
  }

  addProjectile(id: number, kind: ProjectileKind, x: number, y: number): void {
    this.state.addProjectile(id, kind, x, y)
  }

  moveProjectile(id: number, x: number, y: number): void {
    this.state.moveProjectile(id, x, y)
  }

  removeProjectile(id: number): void {
    this.state.removeProjectile(id)
  }

  addImpact(x: number, y: number, r: number, kind = 'blast'): void {
    this.state.addImpact(x, y, r, kind)
  }

  lights(): Light[] {
    return this.state.lights()
  }

  /**
   * How many times this layer has actually **redrawn**, and what the last redraw
   * put on the canvas.
   *
   * e2e only, and it exists to answer a *timing* question, not to be asserted
   * on: `projectilesDrawn` counts the state map, which `syncProjectiles` fills
   * — and that counter read 1 live / 1 drawn for the whole period in which no
   * rocket had ever been drawn in a real game (§A15). A check that freezes the
   * scene to photograph a projectile needs to know the frame on screen was
   * rendered *after* the projectile arrived; nothing else could tell it.
   */
  redraws = 0
  drawnProjectilesLastFrame = 0

  update(dt: number): void {
    this.state.update(dt)
    const g = this.gfx
    const c = C()
    g.clear()
    this.redraws += 1
    this.drawnProjectilesLastFrame = this.state.projectiles.size

    // Beams: a wide warm halo, a bright core, and a muzzle flash.
    //
    // **This path is the two laser weapons now** (§F1/§F2). The ballistic guns
    // fire projectiles that fly, drawn below with the other ordnance; a beam is
    // the one thing left in the game that is instant, and `BEAM_LIFETIME` 0.35 s
    // is how long the afterimage of one hangs there. It was 0.09 s, which is
    // shorter than a screenshot round-trip and about as long as a player's
    // chance of seeing it.
    //
    // Three passes rather than two, all additive: the halo gives it presence
    // against terrain, the core gives it the line, and the muzzle flash marks
    // the shooter. Shooting in the dark should tell everyone where you are.
    for (const t of this.state.tracers) {
      const k = t.life / t.ttl
      g.lineStyle(c.TRACER_WIDTH * 5, 0xff9a3c, 0.18 * k)
      g.lineBetween(t.x0, t.y0, t.x1, t.y1)
      g.lineStyle(c.TRACER_WIDTH * 2, 0xffe9a0, 0.55 * k)
      g.lineBetween(t.x0, t.y0, t.x1, t.y1)
      g.lineStyle(c.TRACER_WIDTH, 0xffffff, 1.0 * k)
      g.lineBetween(t.x0, t.y0, t.x1, t.y1)

      // Muzzle flash at the origin, biggest at the instant of firing.
      g.fillStyle(0xffd27a, 0.5 * k)
      g.fillCircle(t.x0, t.y0, 7 * k)
      g.fillStyle(0xffffff, 0.85 * k)
      g.fillCircle(t.x0, t.y0, 3 * k)
    }

    // Trails: a tapering polyline, oldest thinnest.
    for (const p of this.state.projectiles.values()) {
      const look = LOOK[p.kind]
      const n = look.trail === 0 ? 0 : p.trail.length
      for (let i = 1; i < n; i++) {
        const a = i / n
        g.lineStyle(1 + 2 * a, look.colour, 0.6 * a)
        g.lineBetween(p.trail[i - 1]!.x, p.trail[i - 1]!.y, p.trail[i]!.x, p.trail[i]!.y)
      }

      // §F2: a bullet is a **streak along its velocity**, not a disc.
      //
      // A dot at 850 px/s reads as a flicker and says nothing about where the
      // round is going; a segment reads as a line. Three passes, as the beam
      // has: a halo so it holds against terrain, a core so it reads as a line,
      // and a white centre so it reads as hot.
      if (p.kind === 'bullet') {
        const s = bulletStreak(p, c.BULLET_LENGTH)
        g.lineStyle(c.BULLET_WIDTH * 3, look.colour, 0.35)
        g.lineBetween(s.x0, s.y0, s.x1, s.y1)
        g.lineStyle(c.BULLET_WIDTH, 0xffffff, 1)
        g.lineBetween(s.x0, s.y0, s.x1, s.y1)
        // The head, so a round that has not moved yet is still something rather
        // than a zero-length line.
        g.fillStyle(0xffffff, 1)
        g.fillCircle(p.x, p.y, c.BULLET_WIDTH * 0.6)
        continue
      }

      g.fillStyle(look.colour, 1)
      g.fillCircle(p.x, p.y, look.r)
      // A hot core, so a dot reads as ordnance rather than as a decal — except
      // smoke, which is not hot and should not glow.
      if (p.kind !== 'smoke') {
        g.fillStyle(0xffffff, 0.8)
        g.fillCircle(p.x, p.y, Math.max(1.2, look.r * 0.45))
      }
    }

    // Impacts: a flash that collapses fast.
    for (const im of this.state.impacts) {
      const k = im.life / im.ttl
      g.fillStyle(0xfff0c0, 0.55 * k)
      g.fillCircle(im.x, im.y, im.r * (1.15 - 0.5 * k))
      g.lineStyle(2, 0xffd27a, 0.8 * k)
      g.strokeCircle(im.x, im.y, im.r * (1.3 - 0.4 * k))
    }
  }

  destroy(): void {
    this.gfx.destroy()
  }
}
