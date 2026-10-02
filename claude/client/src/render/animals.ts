/**
 * Drawing the ground animals (T20.10).
 *
 * `BirdLayer`'s shape, with three differences that matter:
 *
 *  - **Depth `actors`, not `birds`.** A bird is drawn *behind* the terrain, which
 *    is what §C16's "no collision" looks like on screen. An animal stands on the
 *    ground and collides with it, so drawing it behind would put a spider inside
 *    the hill it is sitting on.
 *  - **Facing comes from the wire.** A bird's direction is its travel; a beetle
 *    turns and a spider rests between hops, where "moved right since last frame"
 *    flips the sprite every time it stops.
 *  - **Legs, not wings.** Same per-id phase trick, so a row of them is not a
 *    chorus line.
 *
 * Arithmetic is in `animals-math.ts` (§A8); this file is Phaser. No atlas entry
 * exists, and `docs/50` §8 says a missing texture falls back rather than breaks —
 * so, like the birds, the body is primitives rather than a placeholder box.
 */
import Phaser from 'phaser'
import { DEPTH } from './backdrop'
import { BEETLE, bodyColor, bodySize, legPhase, mixedFauna } from './animals-math'
import type { AnimalView } from '../net/worldMirror'
import { joinCast } from '../look/actors/cast'
import { followWorldDraws, fxFeed } from '../look/fx/feed'
import { VIEW_MARGIN, animalActor, nearView } from '../look/actors/furniture'

/** T23.31: a volcanic creature's stride, ms — the crawler (spider's kind, index 0) scuttles, the tripod (1) stalks. */
const GAIT_PERIOD_MS = [360, 900]

interface Entry {
  id: number
  root: Phaser.GameObjects.Container
  body: Phaser.GameObjects.Ellipse
  legs: Phaser.GameObjects.Rectangle[]
  kind: number
  right: boolean
  /** T23.31: the walk cycle's phase (0–1), advanced only while it moves; where it was, and when, to tell. */
  gait: number
  lastX: number
  lastMs: number
  /** T23.19: its place in the world renderer's cast, while `useWorld` holds. */
  leave: (() => void) | null
}

export class AnimalLayer {
  private readonly container: Phaser.GameObjects.Container
  private readonly entries = new Map<number, Entry>()
  private readonly seen = new Set<number>()
  /** T23.19: the animals are the world renderer's — F4's beetle and spider, rim-lit, behind the figures (not in space). */
  private worldOn = false
  /** T99.04 (promo): every world's creatures at once (`mixedFauna`), whatever this world's look. */
  private faunaMix = false
  /** T23.19D F1: world or Phaser follows the drawer's own flag (`fx/feed.ts::followWorldDraws`). */
  private readonly unfollow: () => void

  constructor(private readonly scene: Phaser.Scene) {
    this.container = scene.add.container(0, 0).setDepth(DEPTH.actors)
    this.unfollow = followWorldDraws(scene, (on) => this.useWorld(on))
  }

  /** T23.19: draw the animals in the world renderer (`on`), or as Phaser's shapes — whatever the drawer says (T23.19D). */
  private useWorld(on: boolean): void {
    this.worldOn = on
    for (const e of this.entries.values()) this.place(e)
  }

  get drawsInWorld(): boolean {
    return this.worldOn
  }

  private place(e: Entry): void {
    e.root.setVisible(!this.worldOn)
    if (this.worldOn && !e.leave) {
      const view = this.scene.cameras.main.worldView
      const { w, h } = bodySize(e.kind)
      e.leave = joinCast(this.scene, {
        back: true,
        actor: () => {
          const { x, y } = e.root
          if (!this.container.visible || !nearView(view, x, y, VIEW_MARGIN)) return null
          const feed = fxFeed(this.scene)
          const fauna = this.faunaMix ? mixedFauna(e.id) : feed.fauna
          return animalActor(e.kind, Math.round(x), Math.round(y), e.right, w, h, feed.night, fauna, e.gait)
        },
      })
    } else if (!this.worldOn && e.leave) {
      e.leave()
      e.leave = null
    }
  }

  /** Ids currently drawn. A check asserts on this, not on intent (§A15). */
  get ids(): number[] {
    return [...this.entries.keys()]
  }

  get count(): number {
    return this.entries.size
  }

  /** T99.04 (promo): draw alternate animals as the other world's creatures. */
  setFaunaMix(on: boolean): void {
    this.faunaMix = on
  }

  /** Show or hide the whole layer, for a check's control frame (§C2). */
  setVisible(on: boolean): void {
    this.container.setVisible(on)
  }

  /**
   * Where each animal is **drawn**, as opposed to where the mirror says it is.
   *
   * The reason `BirdLayer.drawn` exists, and it applies harder here: a check that
   * computes a patch from mirror coordinates and then screenshots is comparing
   * two different instants, and a hopping spider can leave the patch between
   * them.
   */
  get drawn(): Array<{ id: number; x: number; y: number; kind: number }> {
    return [...this.entries.entries()].map(([id, e]) => ({
      id,
      x: e.root.x,
      y: e.root.y,
      kind: e.kind,
    }))
  }

  /** Reconcile against the mirror and animate. Diffed, not rebuilt. */
  update(animals: Iterable<AnimalView>, nowMs: number): void {
    this.seen.clear()
    const seen = this.seen
    for (const a of animals) {
      seen.add(a.id)
      let e = this.entries.get(a.id)
      if (!e || e.kind !== a.kind) {
        e?.root.destroy()
        e?.leave?.()
        e = this.make(a)
        this.entries.set(a.id, e)
        this.place(e)
      }
      e.right = a.right
      // T23.31: a creature walks only while it moves (a stride of `GAIT_PERIOD_MS`), and stands still otherwise.
      const dt = Math.max(0, Math.min(100, nowMs - e.lastMs))
      if (Math.abs(a.x - e.lastX) > 0.05) e.gait = (e.gait + dt / GAIT_PERIOD_MS[a.kind === BEETLE ? 1 : 0]!) % 1
      e.lastX = a.x
      e.lastMs = nowMs
      e.root.setPosition(a.x, a.y)
      e.root.setScale(a.right ? 1 : -1, 1)

      const swing = legPhase(nowMs, a.id, a.kind)
      const { h } = bodySize(a.kind)
      e.legs.forEach((leg, i) => {
        const dir = i % 2 === 0 ? 1 : -1
        leg.setY(h * 0.35 + swing * dir * h * 0.12)
      })
    }
    for (const [id, e] of this.entries) {
      if (!seen.has(id)) {
        e.root.destroy()
        e.leave?.()
        this.entries.delete(id)
      }
    }
  }

  private make(a: AnimalView): Entry {
    const { w, h } = bodySize(a.kind)
    const colour = bodyColor(a.kind)
    const root = this.scene.add.container(a.x, a.y)
    // A beetle is a wide low dome; a spider is a small body with long legs. The
    // silhouettes have to differ, not the palette.
    const body =
      a.kind === BEETLE
        ? this.scene.add.ellipse(0, 0, w * 0.9, h * 0.8, colour)
        : this.scene.add.ellipse(0, -h * 0.1, w * 0.5, h * 0.55, colour)
    const legCount = a.kind === BEETLE ? 4 : 6
    const legs: Phaser.GameObjects.Rectangle[] = []
    for (let i = 0; i < legCount; i++) {
      const t = i / (legCount - 1)
      const x = -w * 0.45 + t * w * 0.9
      const len = a.kind === BEETLE ? h * 0.35 : h * 0.7
      legs.push(this.scene.add.rectangle(x, h * 0.35, 1.5, len, colour))
    }
    root.add([...legs, body])
    this.container.add(root)
    return { id: a.id, root, body, legs, kind: a.kind, right: a.right, gait: (a.id * 0.37) % 1, lastX: a.x, lastMs: 0, leave: null }
  }

  destroy(): void {
    this.unfollow()
    for (const e of this.entries.values()) {
      e.root.destroy()
      e.leave?.()
    }
    this.entries.clear()
    this.container.destroy()
  }
}
