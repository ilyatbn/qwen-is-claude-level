/**
 * Drawing for §A3: tracers, projectile trails and impact flashes.
 *
 * All the bookkeeping is in `ordnance-state.ts` (§A8); this file only draws, and
 * feeds `lights()` straight into the lightmap so ordnance is what makes night
 * combat readable.
 */

import Phaser from 'phaser'
import { C } from '../core'
import { OrdnanceState, type Light, type ProjectileKind } from './ordnance-state'
import { DEPTH } from './backdrop'

const KIND_COLOR: Record<ProjectileKind, number> = {
  bazooka: 0xffd27a,
  grenade: 0xbfe08a,
  meteor: 0xff9a4a,
  fragment: 0xffb066,
}

export class OrdnanceLayer {
  private readonly gfx: Phaser.GameObjects.Graphics
  readonly state: OrdnanceState

  constructor(scene: Phaser.Scene) {
    const c = C()
    this.state = new OrdnanceState(c.TRACER_LIFETIME, c.PROJECTILE_TRAIL_LEN)
    // One Graphics, cleared and redrawn: an object per tracer at 10 shots/s would
    // allocate constantly.
    this.gfx = scene.add.graphics().setDepth(DEPTH.particles)
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

  update(dt: number): void {
    this.state.update(dt)
    const g = this.gfx
    const c = C()
    g.clear()

    // Tracers: a bright core that fades over TRACER_LIFETIME.
    for (const t of this.state.tracers) {
      const k = t.life / t.ttl
      g.lineStyle(c.TRACER_WIDTH * 2, 0xfff3c0, 0.25 * k)
      g.lineBetween(t.x0, t.y0, t.x1, t.y1)
      g.lineStyle(c.TRACER_WIDTH, 0xffffff, 0.95 * k)
      g.lineBetween(t.x0, t.y0, t.x1, t.y1)
    }

    // Trails: a tapering polyline, oldest thinnest.
    for (const p of this.state.projectiles.values()) {
      const col = KIND_COLOR[p.kind]
      const n = p.trail.length
      for (let i = 1; i < n; i++) {
        const a = i / n
        g.lineStyle(1 + 2 * a, col, 0.6 * a)
        g.lineBetween(p.trail[i - 1]!.x, p.trail[i - 1]!.y, p.trail[i]!.x, p.trail[i]!.y)
      }
      g.fillStyle(col, 1)
      g.fillCircle(p.x, p.y, p.kind === 'meteor' ? 7 : 3)
      g.fillStyle(0xffffff, 0.8)
      g.fillCircle(p.x, p.y, p.kind === 'meteor' ? 3 : 1.4)
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
