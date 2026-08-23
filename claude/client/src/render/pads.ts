/**
 * Teleport pads on screen (`docs/72-amendments-v4.md` §C5).
 *
 * A ring on the ground for every pad, and an arc that fills over
 * `TELEPORT_CHARGE` on the one the local player is charging. Both are drawn from
 * numbers the simulation owns: the geometry comes from `PAD_W`/`PAD_H` through
 * the WASM constants, and the fill comes from the snapshot's `teleportCharge`
 * byte — **not** from a timer this file runs.
 *
 * That last point is the whole design of this file. The client could watch its
 * own feet and count two seconds, and it would be wrong the moment the player is
 * unarmed, on cooldown, or a pixel off the pad — three rules that live in
 * `world::teleport` and would have to be copied here to get the indicator right.
 * A byte on the wire is cheaper than three guards that drift.
 *
 * §A39: a pad you cannot see is a pad nobody stands on. `teleport.mjs` asserts
 * the ring from **rendered pixels**, against a control frame with no pad in it.
 */

import Phaser from 'phaser'
import { C } from '../core'
import { DEPTH } from './backdrop'

/** Where a pad is, in world pixels. `pos` is a feet line, as everywhere else. */
export interface PadView {
  id: number
  x: number
  y: number
}

/** The ring's colour, and the charge arc's. */
const RING = 0x59d2ff
const CHARGE = 0xffe066

interface Entry {
  ring: Phaser.GameObjects.Ellipse
  glow: Phaser.GameObjects.Ellipse
  arc: Phaser.GameObjects.Graphics
  view: PadView
}

export class PadLayer {
  private readonly entries = new Map<number, Entry>()
  private readonly container: Phaser.GameObjects.Container
  private pulse = 0

  constructor(private readonly scene: Phaser.Scene) {
    // Above the terrain and below the actors: you stand **on** a pad, so the
    // player must draw over it. Sharing `DEPTH.decorations` would let a bush
    // sort in front of the ring depending on creation order.
    this.container = scene.add.container(0, 0).setDepth(DEPTH.decorations - 1)
  }

  /** How many pads are drawn. The e2e counts this against the server's list. */
  get count(): number {
    return this.entries.size
  }

  get ids(): number[] {
    return [...this.entries.keys()]
  }

  /**
   * Build the rings. Idempotent — calling it again with the same list changes
   * nothing, so a resync does not stack two rings per pad.
   */
  build(pads: readonly PadView[]): void {
    for (const [id, e] of this.entries) {
      if (!pads.some((p) => p.id === id)) {
        e.ring.destroy()
        e.glow.destroy()
        e.arc.destroy()
        this.entries.delete(id)
      }
    }

    const c = C()
    for (const p of pads) {
      const existing = this.entries.get(p.id)
      if (existing) {
        existing.view = p
        existing.ring.setPosition(p.x, p.y)
        existing.glow.setPosition(p.x, p.y)
        existing.arc.setPosition(p.x, p.y)
        continue
      }

      // A flat ellipse, not a circle: the pad is a patch of ground seen from the
      // side, and a circle reads as a ball sitting on it.
      const glow = this.scene.add
        .ellipse(p.x, p.y, c.PAD_W * 1.35, c.PAD_H * 2.4, RING, 0.16)
        .setOrigin(0.5, 0.5)
      const ring = this.scene.add
        .ellipse(p.x, p.y, c.PAD_W, c.PAD_H * 1.6)
        .setOrigin(0.5, 0.5)
        .setStrokeStyle(2, RING, 0.95)
      const arc = this.scene.add.graphics({ x: p.x, y: p.y })

      this.container.add([glow, ring, arc])
      this.entries.set(p.id, { ring, glow, arc, view: p })
    }
  }

  /**
   * Per frame. `charge` is the local player's `0..1`, and `padId` the pad they
   * are on, or `null` for neither.
   *
   * `dtMs` drives the idle pulse only. Nothing here integrates the charge.
   */
  update(dtMs: number, padId: number | null, charge: number): void {
    this.pulse = (this.pulse + dtMs / 1000) % 1
    const breathe = 0.55 + 0.25 * Math.sin(this.pulse * Math.PI * 2)
    const c = C()

    for (const [id, e] of this.entries) {
      e.glow.setAlpha(0.1 + 0.08 * breathe)
      e.ring.setStrokeStyle(2, RING, 0.6 + 0.35 * breathe)

      e.arc.clear()
      if (id !== padId || charge <= 0) continue

      // The arc fills clockwise from the top over `TELEPORT_CHARGE` seconds. It
      // is drawn from the byte, so it stops the instant the server says the
      // charge stopped — stepping off the pad clears it on the next snapshot
      // rather than after this file notices.
      const rx = (c.PAD_W / 2) * 1.15
      const ry = c.PAD_H * 1.1
      e.arc.lineStyle(3, CHARGE, 0.95)
      e.arc.beginPath()
      const start = -Math.PI / 2
      const end = start + Math.PI * 2 * Math.min(1, charge)
      const steps = Math.max(2, Math.ceil(24 * Math.min(1, charge)))
      for (let i = 0; i <= steps; i++) {
        const a = start + ((end - start) * i) / steps
        const x = Math.cos(a) * rx
        const y = Math.sin(a) * ry
        if (i === 0) e.arc.moveTo(x, y)
        else e.arc.lineTo(x, y)
      }
      e.arc.strokePath()
    }
  }

  destroy(): void {
    for (const e of this.entries.values()) {
      e.ring.destroy()
      e.glow.destroy()
      e.arc.destroy()
    }
    this.entries.clear()
    this.container.destroy()
  }
}

/**
 * Which pad a body is standing on, or `null`.
 *
 * Mirrors `TeleportPad::underfoot` — feet against the surface line, within half a
 * pad width, with `PAD_TOUCH_SLACK` of tolerance. **Cosmetic only**: it decides
 * which ring to draw the arc on, never whether a teleport happens, so a
 * disagreement with the server costs a frame of the arc on the wrong ring and
 * nothing else. The charge value itself is always the server's.
 */
export function padUnderfoot(pads: readonly PadView[], cx: number, cy: number): number | null {
  const c = C()
  const feet = cy + c.PLAYER_H / 2
  for (const p of pads) {
    if (Math.abs(cx - p.x) <= c.PAD_W / 2 && Math.abs(feet - p.y) <= c.PAD_TOUCH_SLACK) {
      return p.id
    }
  }
  return null
}
