/**
 * Drawing for §A3: tracers, projectile trails and impact flashes.
 *
 * All the bookkeeping is in `ordnance-state.ts` (§A8); this file only draws. The
 * light it casts is built from the same records by `look/effectLights.ts` (T23.09).
 */

import Phaser from 'phaser'
import { C } from '../core'
import {
  bulletStreak,
  flameAtRest,
  flameDiscs,
  flameFlicker,
  LOOK,
  OrdnanceState,
  type ProjectileKind,
} from './ordnance-state'
import { DEPTH } from './backdrop'
import { ensureItemTextures } from './itemTextures'
import { ICON_UNIT_PX, spriteOf } from '../look/actors/icons'
import { FIGURE_SCALE } from '../look/actors/pose'
import { fxFeed, type FxFeed } from '../look/fx/feed'
import { joinCast } from '../look/actors/cast'
import type { Actor } from '../look/scene'

// The colour and radius tables used to live here as well as in ordnance-state,
// which is two sources of truth for one thing and the exact shape §B16 warns
// about. `LOOK` is the only one now.

/**
 * The two colours a flame is *not* drawn in `LOOK`.
 *
 * `LOOK.flame.colour` is the body, and it is the one shared with the trail and
 * with anything else that asks what a flame looks like. These two only exist
 * inside the blob: a dark red edge, so a flame has a silhouette against bright
 * terrain rather than dissolving into it, and a yellow heart, so it reads as
 * burning rather than as a coloured dot. Deliberately **not** near-white: white
 * is what an overlapping crowd used to sum to, and it is the thing that made a
 * fire look like steam.
 */
const FLAME_EDGE = 0xc0350a
const FLAME_HEART = 0xffd23c

/**
 * T23.17 (R12): a thrown weapon in flight is **the weapon** — its held model's icon (`look/actors/icons.ts`), at the
 * size it has in the hand (`FIGURE_SCALE` figure units), tumbling — not a dot. By projectile kind, the weapon key.
 */
const THROWN_KEY: Partial<Record<ProjectileKind, string>> = {
  grenade: 'grenade',
  airburst: 'airburst',
  smoke: 'smoke',
  molotov: 'molotov',
  toxic: 'toxic_grenade',
  durian: 'durian_grenade',
}
/**
 * How far a thrown weapon turns per px it travels (rad/px): about a turn every 60 px, so a lob reads as thrown, not
 * fired — and one that has come to rest on the ground lies still (the turn is travel, not time).
 */
const TUMBLE_RAD_PER_PX = 0.1

export class OrdnanceLayer {
  private readonly gfx: Phaser.GameObjects.Graphics
  /** §F10.3 — fire, painted rather than summed. See the constructor. */
  private readonly flameGfx: Phaser.GameObjects.Graphics
  readonly state: OrdnanceState
  /** The scene, for the thrown weapons' images. */
  private readonly scene: Phaser.Scene
  /**
   * T23.18: each rocket in flight is F1's rocket (`draw.ts::rocket`, ink with its motor), a member of the scene's cast
   * while the world renderer draws the effects — its motor glow and smoke trail are `fx/game.ts::rocketFx`. By id: the
   * member's leave function.
   */
  private readonly rockets = new Map<number, () => void>()
  /**
   * T23.18: the scene's effect feed (`look/fx/feed.ts`). While the world renderer draws this scene's effects
   * (`worldDraws`) the blasts and flames are F's, drawn there from this layer's records, and this layer draws none of
   * them; otherwise (space until T23.20, no three.js) it draws the flat picture below.
   */
  private readonly feed: FxFeed
  /** Hidden for a check's control frame; `render` honours it for the shader quads too. */
  private hidden = false
  /** T23.17: the thrown weapons in flight, one image each, pooled (hidden when unused). */
  private readonly thrown: Phaser.GameObjects.Image[] = []
  /** How many thrown weapons the last render drew, and as which icon — for the checks. */
  thrownDrawn: { id: number; sprite: string; x: number; y: number }[] = []
  /** T23.17: each thrown weapon's turn so far and where it was last drawn (its travel turns it). */
  private readonly tumble = new Map<number, { x: number; y: number; a: number }>()

  constructor(scene: Phaser.Scene) {
    const c = C()
    // §F2: `BEAM_LIFETIME`, and the field it feeds is the **beam's** now — the
    // five ballistic guns fire objects that fly and are drawn below, with the
    // other projectiles.
    this.state = new OrdnanceState(c.BEAM_LIFETIME, c.PROJECTILE_TRAIL_LEN)
    // T21.18: record every explosion for the painted blast, whatever the setting now —
    // turning High Quality on mid-blast then paints the blast already in progress.
    this.state.blastLife = c.BLAST_SHADER_LIFE
    this.feed = fxFeed(scene)
    this.feed.ordnance = this
    // §F10.3: **flames get their own Graphics, and it is not additive.**
    //
    // Created first, so it sits under the additive layer at the same depth. This
    // is a measured change, not a preference: a molotov drops `MOLOTOV_FLAMES`
    // objects into about 100 px of ground, so ten of them overlap — and under
    // ADD ten overlapping oranges sum past white in every channel. The crop in
    // `shots/fire-crowd.png` showed it: a fire drawn as two pale bulbs, which
    // reads as steam. Worse for the check than for the eye — a saturated centre
    // has `r - b == 0`, so the whitest part of the fire failed `fire-visible`'s
    // own "is this warm" test and only the rims were being counted.
    //
    // Painted rather than summed, a crowd stays the colour of fire however deep
    // it stacks. What makes a flame read at night is its **light** (`GLOW`), not
    // its blend mode, and that path is unchanged.
    this.flameGfx = scene.add.graphics().setDepth(DEPTH.particles)
    // One Graphics, cleared and redrawn: an object per tracer at 10 shots/s would
    // allocate constantly.
    this.gfx = scene.add.graphics().setDepth(DEPTH.particles)
    // Tracers, trails and flashes are all light. ADD makes them read against dark
    // terrain at night, which is exactly where §A3's "all bullets are visible"
    // was failing — a 2 px white line at 0.09 s was almost impossible to find.
    this.gfx.setBlendMode(Phaser.BlendModes.ADD)
    this.scene = scene
    // The icons a thrown weapon flies as (idempotent: the item layer draws the same set).
    ensureItemTextures(scene.textures)
  }

  /** `FLAME_RADIUS`, for the fire the world renderer draws from this layer's flames (`fx/game.ts::flameFx`). */
  get flameRadius(): number {
    return C().FLAME_RADIUS
  }

  /** `BULLET_LENGTH`, for a round's streak (`fx/game.ts::bulletFx`). */
  get bulletLength(): number {
    return C().BULLET_LENGTH
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

  /**
   * The flat flames' flicker clock, in ms — advanced by `update`, **not** read from
   * `performance.now()` in `render`.
   *
   * T21.36: `render` is "draw the current state without advancing it", and a High
   * Quality flip repaints a frozen scene through it. With the wall clock there, every
   * repaint drew the flat fire at a new flicker; that was invisible while the discs were
   * ~8 px, and once they were sized to cover `FLAME_RADIUS` it moved `fire-shader`'s
   * exact-restore reading to 1.1 and 2.5 against a limit of 1 in two of three runs.
   */
  private flickerMs = 0

  update(dt: number): void {
    this.state.update(dt)
    this.flickerMs += dt * 1000
    this.render()
  }

  /**
   * Draw the current state without advancing it.
   *
   * Split out of `update` for T21.18, so a High Quality change repaints the same
   * instant — the same beams at the same life — rather than the next one.
   */
  render(): void {
    const g = this.gfx
    const fg = this.flameGfx
    const c = C()
    const nowMs = this.flickerMs
    g.clear()
    fg.clear()
    this.redraws += 1
    this.drawnProjectilesLastFrame = this.state.projectiles.size

    // T23.18: while the world renderer draws this scene's effects (`look/fx/feed.ts::worldDraws`), every beam, round,
    // rocket, flame, blast and ember is F's, drawn there from these records — this layer draws only the thrown weapons,
    // which fly as themselves (T23.17). Otherwise (space until T23.20; no three.js) the flat picture below.
    const worldFx = this.feed.worldDraws

    // Beams: a wide warm halo, a bright core, and a muzzle flash (the flat path; T21.18's beam shader retired, T23.18).
    //
    // **This path is the two laser weapons now** (§F1/§F2). The ballistic guns
    // fire projectiles that fly, drawn below with the other ordnance; a beam is
    // the one thing left in the game that is instant, and `BEAM_LIFETIME` 0.35 s
    // is how long the afterimage of one hangs there.
    for (const t of worldFx ? [] : this.state.tracers) {
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
    const thrown: { id: number; sprite: string; x: number; y: number }[] = []
    for (const p of this.state.projectiles.values()) {
      const look = LOOK[p.kind]
      if (worldFx && !THROWN_KEY[p.kind]) continue
      // §F10.3: **a flame at rest draws no trail.** A tail behind something that
      // is not moving is a smear, and worse, it says the fire is still travelling
      // when it has settled — the exact class of "the picture and the simulation
      // disagree" that M19 exists to fix.
      const resting = p.kind === 'flame' && (flameAtRest(p) || worldFx)
      const n = look.trail === 0 || resting || worldFx ? 0 : p.trail.length
      // A flame's trail belongs on the flame layer, or a moving flame is a
      // painted head behind an additive tail and the two do not look like one
      // object.
      const tg = p.kind === 'flame' ? fg : g
      for (let i = 1; i < n; i++) {
        const a = i / n
        tg.lineStyle(1 + 2 * a, look.colour, 0.6 * a)
        tg.lineBetween(p.trail[i - 1]!.x, p.trail[i - 1]!.y, p.trail[i]!.x, p.trail[i]!.y)
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

      // §F10.3: a flame is a flickering warm blob, and **it does not fade as it
      // settles**. A resting flame still burns for the rest of `FLAME_LIFE`, so
      // dimming one would put "the fire is over" on the screen while the damage
      // continues — the divergence this milestone is about, in miniature.
      //
      // Three passes, so one flame reads as fire and not as a dot: a soft red
      // edge, the orange body, and a yellow heart. Drawn on `flameGfx` — see the
      // constructor for why that layer is not additive.
      if (p.kind === 'flame') {
        // T23.18: F's fire, drawn by the world renderer from this record (`fx/game.ts::flameFx`).
        if (worldFx) continue
        // T21.36: sized from the burn radius, so the body covers every point that burns.
        const f = flameFlicker(p.id, nowMs)
        const disc = flameDiscs(c.FLAME_RADIUS, f)
        fg.fillStyle(FLAME_EDGE, 0.45 * f)
        fg.fillCircle(p.x, p.y, disc.rim)
        fg.fillStyle(look.colour, 0.95)
        fg.fillCircle(p.x, p.y, disc.body)
        fg.fillStyle(FLAME_HEART, 0.95)
        fg.fillCircle(p.x, p.y, disc.heart)
        continue
      }

      // T23.17: a thrown weapon flies as itself (`THROWN_KEY`), after its trail.
      const key = THROWN_KEY[p.kind]
      const sprite = key ? spriteOf(key) : null
      const unit = sprite ? ICON_UNIT_PX.get(sprite) : undefined
      if (sprite && unit && this.scene.textures.exists(sprite)) {
        const im = this.thrownImage(thrown.length)
        const t = this.tumble.get(p.id) ?? { x: p.x, y: p.y, a: p.id * 2.39 }
        t.a += Math.hypot(p.x - t.x, p.y - t.y) * TUMBLE_RAD_PER_PX
        t.x = p.x
        t.y = p.y
        this.tumble.set(p.id, t)
        im.setTexture(sprite)
          .setScale(FIGURE_SCALE / unit)
          .setPosition(p.x, p.y)
          .setRotation(t.a)
          .setVisible(!this.hidden)
        thrown.push({ id: p.id, sprite, x: p.x, y: p.y })
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

    this.syncRockets(worldFx)
    for (let i = thrown.length; i < this.thrown.length; i++) this.thrown[i]!.setVisible(false)
    this.thrownDrawn = thrown
    if (this.tumble.size > thrown.length) for (const id of this.tumble.keys()) if (!thrown.some((d) => d.id === id)) this.tumble.delete(id)

    // Impacts: a flash that collapses fast — where the world renderer does not draw F's explosion from the blast
    // records (T23.18: `fx/game.ts::blastFx`, which retired T21.18's painted blast quad).
    for (const im of worldFx ? [] : this.state.impacts) {
      const k = im.life / im.ttl
      g.fillStyle(0xfff0c0, 0.55 * k)
      g.fillCircle(im.x, im.y, im.r * (1.15 - 0.5 * k))
      g.lineStyle(2, 0xffd27a, 0.8 * k)
      g.strokeCircle(im.x, im.y, im.r * (1.3 - 0.4 * k))
    }
  }

  /**
   * Show or hide the whole layer, **for a check's control frame** (§C2): the painted
   * beam against the same frozen instant with nothing of this layer on it. Repaints,
   * so it works on a frozen scene, and the latch survives the next render.
   */
  setVisible(on: boolean): void {
    this.hidden = !on
    this.gfx.setVisible(on)
    this.flameGfx.setVisible(on)
    this.render()
  }

  get visible(): boolean {
    return !this.hidden
  }

  /** T23.18: one cast member per rocket in flight while the world draws the effects; none otherwise. */
  private syncRockets(worldFx: boolean): void {
    for (const [id, leave] of this.rockets) {
      const p = this.state.projectiles.get(id)
      if (!worldFx || !p || p.kind !== 'bazooka') {
        leave()
        this.rockets.delete(id)
      }
    }
    if (!worldFx) return
    for (const p of this.state.projectiles.values()) {
      if (p.kind !== 'bazooka' || this.rockets.has(p.id)) continue
      const id = p.id
      this.rockets.set(id, joinCast(this.scene, { actor: () => this.rocketActor(id) }))
    }
  }

  /** A rocket as F1 draws it: `S.rocket(g, x, y, atan2(−dy, dx))` along its last step (mask y down). */
  private rocketActor(id: number): Actor | null {
    const p = this.state.projectiles.get(id)
    if (!p || this.hidden) return null
    const prev = p.trail.length >= 2 ? p.trail[p.trail.length - 2]! : null
    const ang = prev && (p.x !== prev.x || p.y !== prev.y) ? Math.atan2(-(p.y - prev.y), p.x - prev.x) : 0
    return { kind: 'rocket', x: p.x, y: p.y, opts: { ang }, lit: { size: 1, halo: null, shadow: false }, box: null }
  }

  /** How many rockets are cast members now (a check counts both ends). */
  get rocketsCast(): number {
    return this.rockets.size
  }

  /** T23.17: image `i` of the thrown-weapon pool, built on first use (normal blend: ink is not light). */
  private thrownImage(i: number): Phaser.GameObjects.Image {
    while (this.thrown.length <= i) this.thrown.push(this.scene.add.image(0, 0, '__DEFAULT').setDepth(DEPTH.particles).setVisible(false))
    return this.thrown[i]!
  }

  destroy(): void {
    for (const im of this.thrown) im.destroy()
    this.thrown.length = 0
    this.flameGfx.destroy()
    this.gfx.destroy()
    if (this.feed.ordnance === this) this.feed.ordnance = null
    for (const leave of this.rockets.values()) leave()
    this.rockets.clear()
  }
}
