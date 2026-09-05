/**
 * The terrain render stack: backdrop, chunk container, chunk renderer, camera.
 *
 * Extracted so the sandbox and the game build it the *same* way. Two divergent
 * render paths is how the sandbox stops predicting what the game does — and the
 * sandbox is the tool everything after M3 is debugged with, so the moment it
 * renders differently it starts lying.
 *
 * Both scenes now build through this class. They did not until T13.01, and the
 * cost of that was four shipped bugs: `GameScene` applied carves to the mask and
 * never told the renderer, so collision changed, the minimap changed, and the
 * terrain art did not. You walked through a hole you could not see.
 *
 * The fix is not "call `markDirty` from the game scene too" — that is a third
 * caller who can forget, and the bug was a caller forgetting. **`update()` drains
 * the core's dirty set every frame**, so it does not matter who carved, or how, or
 * whether they remembered: the core records what changed and the render stack
 * bakes it. Forgetting is no longer reachable.
 */

import Phaser from 'phaser'
import type { Core } from '../core'
import { TerrainRenderer } from './terrain'
import { CameraRig } from './cameraRig'
import { Backdrop, DEFAULT_THEME, DEPTH } from './backdrop'
import { resolveTheme } from '../render/themes-math'
import { makeBackTexture, makeEdgeTexture, makeFillTexture } from './procTextures'
import { DecorationLayer } from './decorations'
import { fromMeta } from './decorations-math'
import { ItemLayer } from './itemSprites'
import { PadLayer, type PadView } from './pads'
import { OrdnanceLayer } from './ordnance'
import { WeatherLayer, type VentView } from './weather'
import { KIND_BY_WEAPON_KEY, WEAPON_KEYS, type ProjectileKind } from './ordnance-state'

export interface WorldViewTimings {
  buildAllMs: number
  lastRebakeMs: number
}

export class WorldView {
  readonly terrain: TerrainRenderer
  readonly rig: CameraRig
  readonly decorations: DecorationLayer
  /**
   * Ordnance in flight. Owned here rather than per-scene for the reason the whole
   * class exists: the layer already existed and the game never called
   * `addProjectile`, so nothing was ever drawn. A scene that has a world gets
   * projectiles in it without opting in.
   */
  readonly ordnance: OrdnanceLayer
  /** Rain, embers and burning ground. Shared, so both scenes show the weather. */
  readonly weather: WeatherLayer
  /**
   * Pickups, crates, parachutes and beacons.
   *
   * Owned here for the reason the layer-parity check caught: `ItemLayer` builds a
   * second Graphics for the parachutes at `worldItems - 1`, and while the layer
   * lived in `GameScene` alone that depth existed in one scene and not the shared
   * stack — §C0 starting again, in the very milestone that exists to end it. A
   * scene that has a world gets items in it without opting in, even if its world
   * never spawns one.
   */
  readonly items: ItemLayer
  /**
   * §C5's teleport pads.
   *
   * **In the shared stack, not in `GameScene`.** It was built in the scene first
   * and `two-clients` caught it in as many words: "a layer added to one scene and
   * not the shared stack is §C0 starting again". The sandbox and the preview show
   * the same world, so they show the same pads — and the pads they show come from
   * `core.meta`, which those scenes have because they generate locally.
   */
  readonly pads: PadLayer
  readonly timings: WorldViewTimings = { buildAllMs: 0, lastRebakeMs: 0 }

  private readonly backdrop: Backdrop
  private readonly container: Phaser.GameObjects.Container
  private readonly core: Core
  private readonly tracked = new Map<number, ProjectileKind>()
  private readonly weaponKeys: string[]

  /**
   * Building tears nothing down: the caller owns the lifetime. Phaser's texture
   * manager is global, so a rebuilt view over a reused key keeps the previous
   * map's pixels — call `destroy()` before constructing another (T3.05).
   */
  constructor(scene: Phaser.Scene, core: Core, weaponKeys: string[] = WEAPON_KEYS) {
    const { width: mapW, height: mapH } = core
    this.core = core

    this.backdrop = new Backdrop(scene, DEFAULT_THEME, mapW, mapH)
    this.container = scene.add.container(0, 0).setDepth(DEPTH.terrain)

    // Seeded from the map, so a seed always looks the same (`docs/12` §4).
    const theme = resolveTheme(core.meta.theme)
    this.terrain = new TerrainRenderer(
      scene.textures,
      {
        add: (x, y, key) => {
          const img = scene.add.image(x, y, key)
          this.container.add(img)
          return img
        },
      },
      core,
      makeFillTexture(256, theme),
      makeEdgeTexture(256, theme),
      undefined,
      makeBackTexture(256, theme),
    )

    const t0 = performance.now()
    this.terrain.buildAll()
    this.timings.buildAllMs = performance.now() - t0

    // Generation marks every touched chunk dirty. `buildAll` has just baked all
    // of them, so drain and discard — otherwise the first `update()` re-bakes a
    // map that is already correct, which reads as a stutter on the first frame.
    this.core.takeDirtyChunks()

    this.rig = new CameraRig(scene.cameras.main, mapW, mapH)

    // Props last, so they are placed against the mask the chunks were baked
    // from. Built here rather than in each scene for the same reason the rest of
    // this class exists: two render paths that differ are two render paths that
    // drift.
    this.decorations = new DecorationLayer(scene)
    this.decorations.build(fromMeta(core.meta.decorations), (x, y) => core.solidAt(x, y))

    this.ordnance = new OrdnanceLayer(scene)
    this.weather = new WeatherLayer(scene)
    this.items = new ItemLayer(scene)
    this.pads = new PadLayer(scene)
    // A locally generated map already knows its pads; a networked one is told by
    // `map_init` and `GameScene` calls `pads.build` again with the wire's list.
    this.pads.build(
      core.meta.teleport_pads.map((p): PadView => ({ id: p.id, x: p.pos.x, y: p.pos.y })),
    )
    this.weaponKeys = weaponKeys
  }

  /**
   * Carve the mask **and** show it. One call, so a caller cannot do half of it.
   *
   * Returns the number of props removed. Callers that carve through some other
   * path are still covered — `update()` drains the core's dirty set regardless —
   * but they lose the decoration removal, which needs the carve's position.
   */
  applyCarve(x: number, y: number, r: number): number {
    this.core.carve(x, y, r)
    this.drainDirty()
    return this.decorations.onCarve(x, y, r)
  }

  /**
   * The swept-circle carve (lava channels). Distinct from `applyCarve` for the
   * same reason `Core.carveCapsule` is distinct from `Core.carve`: replaying a
   * capsule as a circle produces a different mask, and a client whose mask differs
   * from the server's gets shot through walls it can still see.
   */
  applyCarveCapsule(x0: number, y0: number, x1: number, y1: number, r: number): number {
    this.core.carveCapsule(x0, y0, x1, y1, r)
    this.drainDirty()
    // The swept region, approximated by its midpoint and half-length, is enough
    // for props: they are cosmetic, and over-removing one is invisible where
    // leaving one floating over a channel is not.
    const mx = (x0 + x1) / 2
    const my = (y0 + y1) / 2
    const reach = Math.hypot(x1 - x0, y1 - y0) / 2 + r
    return this.decorations.onCarve(mx, my, reach)
  }

  /**
   * A carve landed somewhere else. Re-bakes are handled by `update()`; this
   * removes the props that were standing on what just left.
   */
  onCarve(x: number, y: number, r: number): number {
    return this.decorations.onCarve(x, y, r)
  }

  /**
   * Move the core's dirty set into the render queue.
   *
   * `take_dirty_chunks` is a *drain*: the core accumulates, someone empties it.
   * Nobody emptied it in the game scene, which is the whole of §C0. Doing it here,
   * every frame, means the guarantee does not depend on any caller remembering.
   */
  private drainDirty(): void {
    this.terrain.markDirty(this.core.takeDirtyChunks())
  }

  /**
   * Reconcile the drawn projectiles with the ones the server says are alive.
   *
   * A diff rather than a stream of add/remove calls: the authority is the list,
   * so a missed `projectile_despawn` self-corrects on the next frame instead of
   * leaving a rocket hanging in the air forever. `drawnProjectiles` is exposed so
   * a check can count at both ends (§A39) — "the server has 3" and "3 are drawn"
   * were silently different numbers for four milestones.
   */
  syncProjectiles(
    live: Iterable<{ id: number; x: number; y: number; weapon?: number; key?: string }>,
  ): void {
    const seen = new Set<number>()
    for (const p of live) {
      seen.add(p.id)
      // Two callers, two identifiers: the game carries the numeric weapon id off
      // the wire, the sandbox simulates locally and already has the key.
      const kind =
        p.key !== undefined ? (KIND_BY_WEAPON_KEY[p.key] ?? 'fragment') : this.kindOf(p.weapon ?? -1)
      if (!this.tracked.has(p.id)) {
        this.tracked.set(p.id, kind)
        this.ordnance.addProjectile(p.id, kind, p.x, p.y)
      }
      this.ordnance.moveProjectile(p.id, p.x, p.y)
    }
    for (const id of [...this.tracked.keys()]) {
      if (seen.has(id)) continue
      this.tracked.delete(id)
      this.ordnance.removeProjectile(id)
    }
  }

  /**
   * How many projectiles the **layer** holds. For counting at both ends.
   *
   * Deliberately not `this.tracked.size`: that is a set this class fills in the
   * same loop, so it reports intent rather than effect (§A15) — if the layer ever
   * failed to take one, the counter would still say it had. Ask the layer.
   */
  get drawnProjectiles(): number {
    return this.ordnance.state.projectiles.size
  }

  /**
   * Weapon id to how its projectile looks.
   *
   * Resolved through the registry's **keys**, not by trusting the numeric id to
   * mean anything: the table is positional and §B16 is the bug where that was
   * assumed silently and a laser resolved as a bazooka. An unknown weapon draws as
   * a fragment rather than not drawing — an invisible projectile is the bug this
   * task exists to fix, so the fallback must still be visible.
   */
  private kindOf(weapon: number): ProjectileKind {
    const key = this.weaponKeys[weapon]
    if (key === undefined) return 'fragment'
    return KIND_BY_WEAPON_KEY[key] ?? 'fragment'
  }

  /** Re-bake the chunks a carve dirtied, within the per-frame budget. */
  /**
   * Toxic drops in the air **right now**, from the layer that already tracks them.
   *
   * `syncProjectiles` puts every projectile the server (or the sandbox's local
   * world) reports into `ordnance`, and `toxic_drop` maps to the `drop` kind — so
   * the count the weather emitter needs is already here and neither scene has to
   * carry it. That matters because the two scenes wire the weather differently:
   * `SandboxScene` calls `weather.setToxic` itself, and a count passed in by the
   * caller would have to be computed twice, identically, forever (T20.05).
   */
  get liveToxicDrops(): number {
    let n = 0
    for (const p of this.ordnance.state.projectiles.values()) if (p.kind === 'drop') n++
    return n
  }

  update(
    near: { x: number; y: number },
    dt = 0,
    weather?: { vents: VentView[]; fallScale: number; fog: number; hasFlashlight: boolean },
  ): void {
    if (dt > 0) this.ordnance.update(dt)
    if (dt > 0 && weather) {
      // **Not a `toxicActive` boolean** (T20.05). The flag came from the effect
      // lifecycle and the drops came from the projectile stream, and the emitter
      // believed the first while the damage came from the second. One source now,
      // and it is the one the player is actually standing under.
      this.weather.setToxic(this.liveToxicDrops)
      // `fog` is required, not optional: both scenes have a fog strength to give
      // and the whole of §F9 is that one of them never passed it on. A default
      // here would let the next scene silently draw no fog and still typecheck.
      // `hasFlashlight` is required rather than optional, for the reason `fog`
      // above is: both scenes know whether the local player is carrying one, and
      // §F9's whole history here is one scene silently passing nothing (T20.07).
      this.weather.update(
        dt,
        weather.vents,
        weather.fallScale,
        weather.fog,
        weather.hasFlashlight,
      )
    }
    this.drainDirty()
    const pendingBefore = this.terrain.stats.pending
    const t0 = performance.now()
    this.terrain.update(near)
    if (pendingBefore > 0) this.timings.lastRebakeMs = performance.now() - t0
  }

  /** Bake everything now — used after a full mask load, where a budgeted
   *  drip would show the map filling in chunk by chunk. */
  flush(near: { x: number; y: number }): void {
    this.drainDirty()
    let guard = 0
    while (this.terrain.stats.pending > 0 && guard++ < 4096) this.terrain.update(near)
  }

  destroy(): void {
    this.tracked.clear()
    this.items.destroy()
    this.weather.destroy()
    this.ordnance.destroy()
    this.decorations.destroy()
    this.pads.destroy()
    this.terrain.destroy()
    this.backdrop.destroy()
    this.container.destroy()
  }
}
