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
 * own feet and count the charge down, and it would be wrong the moment the player is
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
// **Type-only, and that is load-bearing.** `pads.ts` uses `Phaser` only in type
// positions, so TypeScript elides the import and this module stays runnable in
// node — which is what lets `pads.test.ts` drive `padUnderfoot` under
// `environment: 'node'`. A *value* import of `./assets` (which touches
// `Phaser.Loader` at runtime) broke collection outright with `window is not
// defined`. The portal region is injected by the caller instead.
import type { ImageRegion } from './assets'

/**
 * The gate image's texture key, as `build-gate-sprite.mjs` registers it.
 *
 * **Every lookup falls back** (`docs/50` §8): with no image on disk the pad
 * still draws its ring, because the game must boot with no art at all. That is
 * not defensive padding — it is what let this project run from M3 to M6 before a
 * single PNG existed, and a pad you cannot see is a pad nobody stands on (§A39).
 */
export const GATE_KEY = 'gate'

/** Where a pad is, in world pixels. `pos` is a feet line, as everywhere else. */
export interface PadView {
  id: number
  x: number
  y: number
}

/** The ring's colour, and the portal's. */
const RING = 0x59d2ff
/**
 * T21.12's charge effect: the portal **fills blue** as the charge runs.
 *
 * It replaces a yellow arc drawn around the ring. Blue because the gate's own
 * rune glow is blue and a second accent colour on one object reads as two
 * objects; filling rather than tracing because the thing being charged is a
 * doorway, and a doorway that is filling in is legible at 64 px in a way a 3 px
 * arc is not.
 *
 * **Pale, not sky-coloured.** The first version was `0x6fd8ff`, which is within
 * a few points of the sky the portal frames — so a charging gate against open
 * sky moved the sampled region by 8.6 against a threshold of 8, and a player
 * looking at it saw blue fill in on blue. The colour is now much lighter than
 * any sky the cycle produces, which is what makes it read as *lit* rather than
 * as a slightly different patch of background.
 */
const CHARGE = 0xdff6ff

interface Entry {
  ring: Phaser.GameObjects.Ellipse
  glow: Phaser.GameObjects.Ellipse
  arc: Phaser.GameObjects.Graphics
  /** The gate sprite, or `null` when no art loaded (`docs/50` §8). */
  gate: Phaser.GameObjects.Image | null
  /** The portal fill. Sits behind the gate, so the arch frames it. */
  fill: Phaser.GameObjects.Ellipse | null
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
    //
    // **T21.12 asked whether a tall arch still belongs back here, and it does.**
    // A gate is something you stand *inside*, so the tempting answer is to draw
    // it over the player — but a player hidden behind scenery is a worse bug
    // than an arch that does not overlap them, and the pad is the one piece of
    // scenery a player is guaranteed to be standing in. Behind the actors, and
    // the portal fill behind the arch, so the stone always frames the glow.
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
  build(pads: readonly PadView[], gatePortal: ImageRegion | null = null): void {
    for (const [id, e] of this.entries) {
      if (!pads.some((p) => p.id === id)) {
        e.ring.destroy()
        e.glow.destroy()
        e.arc.destroy()
        e.gate?.destroy()
        e.fill?.destroy()
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
        existing.gate?.setPosition(p.x, p.y)
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

      // --- T21.12: the gate, when its art is on disk -----------------------
      //
      // `p.y` is a feet line, so origin (0.5, 1) stands the arch **on** the pad
      // rather than centring it through the ground — the same anchoring the gun
      // platform uses, and the reason its brick base reads as sitting on the
      // indestructible rock `TeleportPad::rect` protects.
      let gate: Phaser.GameObjects.Image | null = null
      let fill: Phaser.GameObjects.Ellipse | null = null
      if (this.scene.textures.exists(GATE_KEY)) {
        const src = this.scene.textures.get(GATE_KEY).getSourceImage()
        const gw = (src.width as number) || c.PAD_W
        const gh = (src.height as number) || c.PAD_W
        const portal = gatePortal
        if (portal) {
          // Behind the gate and sized from the region the build derived, so the
          // fill lands inside the arch instead of over it.
          fill = this.scene.add
            .ellipse(
              p.x + (portal.cx - 0.5) * gw,
              p.y - gh + portal.cy * gh,
              portal.rx * 2 * gw,
              portal.ry * 2 * gh,
              CHARGE,
              // **Fill alpha 1, visibility driven by the object's alpha.**
              // Phaser multiplies the two, so a fill created at 0 is invisible
              // at every charge level however the object's alpha moves — which
              // is exactly what shipped first, and what `teleport.mjs` caught:
              // "the pad's pixels changed by only 1.0 while the charge went
              // 0 -> 100%". A fix that changes the code without changing the
              // picture looks exactly like a fix that worked.
              1,
            )
            .setOrigin(0.5, 0.5)
            .setAlpha(0)
          this.container.add(fill)
        }
        gate = this.scene.add.image(p.x, p.y, GATE_KEY).setOrigin(0.5, 1)
        this.container.add(gate)
        // The ring and its glow are the **fallback**, not a second decoration:
        // with a gate standing here they would draw a second pad through its
        // base. Hidden rather than skipped so the objects stay uniform and
        // `count`/`ids` — which the e2e asserts on — mean the same thing either
        // way.
        glow.setVisible(false)
        ring.setVisible(false)
      }

      this.container.add([glow, ring, arc])
      this.entries.set(p.id, { ring, glow, arc, gate, fill, view: p })
    }
  }

  /**
   * Show or hide the whole layer — **for the pixel check's control frame**
   * (`docs/72` §C2, T21.12).
   *
   * "The gate is on screen" is only evidence against the same camera, the same
   * map and the same light with the layer gone. Two pads cannot be that
   * control, and neither can two maps.
   */
  setVisible(on: boolean): void {
    this.container.setVisible(on)
  }

  /** Whether the layer is drawn. Read back so a check asserts the effect. */
  get visible(): boolean {
    return this.container.visible
  }

  /**
   * How many pads are **showing** a gate sprite rather than the fallback ring.
   *
   * Visibility, not existence. `e.gate !== null` counts a gate created with
   * `visible: false` — an arch nobody can see — which is exactly the state the
   * rest of this file's assertions are written to catch.
   */
  get gatesDrawn(): number {
    return [...this.entries.values()].filter((e) => e.gate?.visible === true).length
  }

  /**
   * Where the charge indicator actually is, relative to a pad's feet line, in
   * world px — or `null` when no gate is drawn and the fallback ring is the
   * indicator.
   *
   * **Exported because a check that samples the wrong rect is a check that
   * measures nothing.** `teleport.mjs` sampled a rect on the feet line, which is
   * where the old charge arc was drawn; the gate's portal sits most of a sprite
   * height above it, so the same rect would have gone on passing while
   * photographing a brick base that never changes. Read off the object the
   * renderer actually positioned, not recomputed from the manifest — the two
   * could disagree, and only one of them is on screen.
   */
  portalGeometry(): {
    dy: number
    rx: number
    ry: number
    gw: number
    gh: number
  } | null {
    for (const e of this.entries.values()) {
      if (!e.fill || !e.gate) continue
      return {
        dy: e.fill.y - e.view.y,
        rx: e.fill.width / 2,
        ry: e.fill.height / 2,
        // **The arch's own size, not the portal's.** A check asking "is the gate
        // drawn" must sample the *stone*: the portal is a hole, so hiding the
        // layer barely changes the pixels inside it — measured at 3.4 against a
        // threshold of 8, on a frame where the arch plainly vanished.
        gw: e.gate.displayWidth,
        gh: e.gate.displayHeight,
      }
    }
    return null
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

      // --- T21.12: the gate's portal fills blue as the charge runs ---------
      //
      // **Driven by the byte, like the arc it replaces.** This file's header
      // explains why and it has not changed: the client could count its own
      // charge and would be wrong the moment the player is unarmed, on cooldown
      // or a pixel off the pad — three rules that live in `world::teleport`. A
      // byte on the wire is cheaper than three guards that drift.
      if (e.fill) {
        const t = id === padId ? Math.max(0, Math.min(1, charge)) : 0
        // Alpha and size together: a fill that only faded in would read as the
        // gate glowing, and one that only grew would pop at 0. Never fully
        // opaque — you have to see what you are about to be thrown into.
        e.fill.setAlpha(t * 0.9)
        e.fill.setScale(0.25 + 0.75 * t)
      }

      e.arc.clear()
      // The arc is the **fallback** indicator, for a client with no gate art
      // (`docs/50` §8). With a gate standing here the portal fill is the
      // indicator, and drawing both would trace a second ring through the stone.
      if (e.gate) continue
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
      e.gate?.destroy()
      e.fill?.destroy()
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
