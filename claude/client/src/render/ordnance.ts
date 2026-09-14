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
  flameAtRest,
  flameFlicker,
  LOOK,
  OrdnanceState,
  type Light,
  type ProjectileKind,
} from './ordnance-state'
import { DEPTH } from './backdrop'
import { BEAM_FRAGMENT, FLAME_FRAGMENT, hasWebGL } from './shaders'
import { isHighQuality, onHighQualityChange } from '../ui/settings'

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

export class OrdnanceLayer {
  private readonly gfx: Phaser.GameObjects.Graphics
  /** §F10.3 — fire, painted rather than summed. See the constructor. */
  private readonly flameGfx: Phaser.GameObjects.Graphics
  readonly state: OrdnanceState
  /** T21.18: the scene, for building shader quads on demand. */
  private readonly scene: Phaser.Scene
  /** Asked of the renderer once: a canvas fallback must not be handed a shader. */
  private readonly webgl: boolean
  private readonly unsubscribeQuality: () => void
  /** T21.18: one quad per beam painted under High Quality, grown on demand, capped. */
  private readonly beamShaders: Phaser.GameObjects.Shader[] = []
  /** How many beams the last render painted with the shader — read back, not the setting. */
  beamShadersDrawn = 0
  /** T21.18: one quad per flame painted under High Quality, grown on demand, capped. */
  private readonly flameShaders: Phaser.GameObjects.Shader[] = []
  /** How many flames the last render painted with the shader. */
  flameShadersDrawn = 0
  /** Hidden for a check's control frame; `render` honours it for the shader quads too. */
  private hidden = false

  constructor(scene: Phaser.Scene) {
    const c = C()
    // §F2: `BEAM_LIFETIME`, and the field it feeds is the **beam's** now — the
    // five ballistic guns fire objects that fly and are drawn below, with the
    // other projectiles.
    this.state = new OrdnanceState(c.BEAM_LIFETIME, c.PROJECTILE_TRAIL_LEN)
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
    this.webgl = hasWebGL(scene)
    // **Repaint on the change, not on the next update.** A check freezes the scene
    // to photograph one beam in both modes; a frozen scene runs no `update`, so a
    // toggle that waited for one would photograph the old picture twice.
    this.unsubscribeQuality = onHighQualityChange(() => this.render())
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
    const nowMs = performance.now()
    g.clear()
    fg.clear()
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
    //
    // **T21.18: under High Quality the three strokes are one shader quad** — the
    // same tracer, the same life, the same muzzle flash; only the line changes.
    const shaderBeams = this.useBeamShader()
    let painted = 0
    for (const t of this.state.tracers) {
      const k = t.life / t.ttl
      const sh = shaderBeams ? this.beamShader(painted) : null
      if (sh) {
        painted++
        const dx = t.x1 - t.x0
        const dy = t.y1 - t.y0
        const len = Math.max(1, Math.hypot(dx, dy))
        sh.setPosition((t.x0 + t.x1) / 2, (t.y0 + t.y1) / 2)
        sh.setDisplaySize(len, c.BEAM_SHADER_WIDTH)
        sh.setRotation(Math.atan2(dy, dx))
        sh.setUniform('life.value', k)
        // No `time` here: Phaser sets its own every render (Shader.js, 3.90:
        // `uniforms.time.value = renderer.game.loop.getDuration()`), and a value written
        // here was overwritten before it was drawn — found by planting it frozen.
        sh.setUniform('span.value', len / c.BEAM_SHADER_WIDTH)
        sh.setVisible(!this.hidden)
      } else {
        g.lineStyle(c.TRACER_WIDTH * 5, 0xff9a3c, 0.18 * k)
        g.lineBetween(t.x0, t.y0, t.x1, t.y1)
        g.lineStyle(c.TRACER_WIDTH * 2, 0xffe9a0, 0.55 * k)
        g.lineBetween(t.x0, t.y0, t.x1, t.y1)
        g.lineStyle(c.TRACER_WIDTH, 0xffffff, 1.0 * k)
        g.lineBetween(t.x0, t.y0, t.x1, t.y1)
      }

      // Muzzle flash at the origin, biggest at the instant of firing.
      g.fillStyle(0xffd27a, 0.5 * k)
      g.fillCircle(t.x0, t.y0, 7 * k)
      g.fillStyle(0xffffff, 0.85 * k)
      g.fillCircle(t.x0, t.y0, 3 * k)
    }

    // Quads with no beam this frame are hidden, not destroyed: the pool is reused.
    for (let i = painted; i < this.beamShaders.length; i++) this.beamShaders[i]!.setVisible(false)
    this.beamShadersDrawn = painted

    // Trails: a tapering polyline, oldest thinnest.
    let flamesPainted = 0
    for (const p of this.state.projectiles.values()) {
      const look = LOOK[p.kind]
      // §F10.3: **a flame at rest draws no trail.** A tail behind something that
      // is not moving is a smear, and worse, it says the fire is still travelling
      // when it has settled — the exact class of "the picture and the simulation
      // disagree" that M19 exists to fix.
      const resting = p.kind === 'flame' && flameAtRest(p)
      const n = look.trail === 0 || resting ? 0 : p.trail.length
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
        // **T21.18: under High Quality a flame is one shader quad**, centred on the
        // flame's own position — its damage centre — and solid past `FLAME_RADIUS`.
        const sh = shaderBeams ? this.flameShader(flamesPainted) : null
        if (sh) {
          flamesPainted++
          const w = 2 * c.FLAME_RADIUS * c.FLAME_SHADER_SCALE
          sh.setPosition(p.x, p.y)
          sh.setDisplaySize(w, w * c.FLAME_SHADER_ASPECT)
          sh.setUniform('seed.value', (p.id % 97) * 0.6180339887)
          sh.setVisible(!this.hidden)
          continue
        }
        const f = flameFlicker(p.id, nowMs)
        fg.fillStyle(FLAME_EDGE, 0.45 * f)
        fg.fillCircle(p.x, p.y, look.r * 1.15 * f)
        fg.fillStyle(look.colour, 0.95)
        fg.fillCircle(p.x, p.y, look.r * 0.8 * f)
        fg.fillStyle(FLAME_HEART, 0.95)
        fg.fillCircle(p.x, p.y, look.r * 0.38 * f)
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

    for (let i = flamesPainted; i < this.flameShaders.length; i++) this.flameShaders[i]!.setVisible(false)
    this.flameShadersDrawn = flamesPainted

    // Impacts: a flash that collapses fast.
    for (const im of this.state.impacts) {
      const k = im.life / im.ttl
      g.fillStyle(0xfff0c0, 0.55 * k)
      g.fillCircle(im.x, im.y, im.r * (1.15 - 0.5 * k))
      g.lineStyle(2, 0xffd27a, 0.8 * k)
      g.strokeCircle(im.x, im.y, im.r * (1.3 - 0.4 * k))
    }
  }

  /** T21.18: WebGL and High Quality, both — the one place that decides. */
  private useBeamShader(): boolean {
    return this.webgl && isHighQuality()
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

  /** Would a beam drawn now be painted by the shader? For the debug handles. */
  get beamsAreShader(): boolean {
    return this.useBeamShader()
  }

  /** Quad `i` of the pool, built on first use; `null` past `BEAM_SHADER_POOL`. */
  private beamShader(i: number): Phaser.GameObjects.Shader | null {
    const c = C()
    if (i >= c.BEAM_SHADER_POOL) return null
    while (this.beamShaders.length <= i) {
      const base = new Phaser.Display.BaseShader('laserBeam', BEAM_FRAGMENT, undefined, {
        life: { type: '1f', value: 0 },
        span: { type: '1f', value: 1 },
      })
      this.beamShaders.push(
        this.scene.add
          .shader(base, 0, 0, c.BEAM_SHADER_WIDTH, c.BEAM_SHADER_WIDTH)
          .setOrigin(0.5, 0.5)
          .setDepth(DEPTH.particles)
          // No `setBlendMode`: a Phaser `Shader` has none (tsc said so). How it
          // composites is decided by what `BEAM_FRAGMENT` writes, which follows the
          // fog and cloud shaders' convention.
          .setVisible(false),
      )
    }
    return this.beamShaders[i] ?? null
  }

  /** Would a flame drawn now be painted by the shader? The same decider as the beams. */
  get flamesAreShader(): boolean {
    return this.useBeamShader()
  }

  /** Flame quad `i` of the pool, built on first use; `null` past `FLAME_SHADER_POOL`. */
  private flameShader(i: number): Phaser.GameObjects.Shader | null {
    const c = C()
    if (i >= c.FLAME_SHADER_POOL) return null
    while (this.flameShaders.length <= i) {
      const base = new Phaser.Display.BaseShader('flame', FLAME_FRAGMENT, undefined, {
        seed: { type: '1f', value: 0 },
        scale: { type: '1f', value: c.FLAME_SHADER_SCALE },
        aspect: { type: '1f', value: c.FLAME_SHADER_ASPECT },
        base: { type: '1f', value: c.FLAME_SHADER_BASE },
      })
      this.flameShaders.push(
        this.scene.add
          .shader(base, 0, 0, 64, 64)
          // Phaser's origin y is from the top; the flame centre is `base` up from the bottom.
          .setOrigin(0.5, 1 - c.FLAME_SHADER_BASE)
          .setDepth(DEPTH.particles)
          .setVisible(false),
      )
    }
    return this.flameShaders[i] ?? null
  }

  destroy(): void {
    this.flameGfx.destroy()
    this.gfx.destroy()
    for (const s of this.beamShaders) s.destroy()
    this.beamShaders.length = 0
    for (const s of this.flameShaders) s.destroy()
    this.flameShaders.length = 0
    // Or every round leaks a listener, and a setting flip repaints a dead layer.
    this.unsubscribeQuality()
  }
}
