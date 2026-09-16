/**
 * Drawing the ordnance the server already narrates (§A39 #10).
 *
 * `melee`, `cone`, `mine_placed`, `mine_ended` and the three `hazard_spawn`
 * kinds have all been on the wire since T11.05–T11.08 with **nothing
 * subscribing**. The design says why that matters, twice:
 *
 * - §B6: "a mine must be visible at close range — invisible instant death is
 *   not fun; a trap you could have spotted is."
 * - T11.05: "a melee hit you cannot see reads as damage from nowhere."
 *
 * Smoke is the worst of them: the server sends a per-player vision multiplier
 * in the snapshot, so the *effect* is real while nothing on screen explains why
 * you suddenly cannot see. §B21 is the same bug one milestone earlier — fog's
 * formula was always right and nothing tested that the number reached the
 * screen.
 *
 * Arithmetic is in `ordnanceFx-math.ts` (§A8); this file is Phaser.
 */

import Phaser from 'phaser'
import { C } from '../core'
import { DEPTH } from './backdrop'
import { OrdnanceFxState, fade, type FxLight, type HazardKind } from './ordnanceFx-math'
import { SMOKE_FRAGMENT, hasWebGL, rgbToUniform3f } from './shaders'
import { isHighQuality, onHighQualityChange } from '../ui/settings'

const SWING_LIFE = 0.15
const JET_LIFE = 0.08
/** §B6's numbers: unmissable at 40 px, gone by 300. */
const MINE_NEAR = 40
const MINE_FAR = 300

const HAZARD_COLOUR: Record<HazardKind, number> = {
  toxic: 0x7fe04a,
  smoke: 0xb9c0c8,
  other: 0xcccccc,
}

export class OrdnanceFxLayer {
  private readonly gfx: Phaser.GameObjects.Graphics
  readonly state: OrdnanceFxState
  /** T21.18: the scene, for building shader quads on demand. */
  private readonly scene: Phaser.Scene
  private readonly webgl: boolean
  private readonly unsubscribeQuality: () => void
  /** T21.18: one quad per smoke cloud painted under High Quality, grown on demand, capped. */
  private readonly smokeShaders: Phaser.GameObjects.Shader[] = []
  /** How many clouds the last render painted with the shader — read back, not the setting. */
  smokeShadersDrawn = 0
  /** Hidden for a check's control frame; `render` honours it for the shader quads too. */
  private hidden = false
  /** What the last `update` was given, so a repaint draws the same instant. */
  private eye = { x: 0, y: 0 }
  private now = 0

  constructor(
    scene: Phaser.Scene,
    private readonly armTime: number,
  ) {
    this.state = new OrdnanceFxState(SWING_LIFE, JET_LIFE)
    // Particles: in front of actors, behind the lightmap, so a flame jet is lit
    // by its own light rather than drawn over the darkness.
    this.gfx = scene.add.graphics().setDepth(DEPTH.particles)
    this.scene = scene
    this.webgl = hasWebGL(scene)
    // Repaint on the change, not on the next update — `OrdnanceLayer`'s reason: a
    // frozen scene runs no update, and a check photographs one cloud both ways.
    this.unsubscribeQuality = onHighQualityChange(() => this.render())
  }

  addSwing(x: number, y: number, aim: number, reach: number, arc: number, hits: number): void {
    this.state.addSwing(x, y, aim, reach, arc, hits)
  }

  addJet(x: number, y: number, aim: number, range: number, arc: number): void {
    this.state.addJet(x, y, aim, range, arc)
  }

  addMine(id: number, owner: number, x: number, y: number): void {
    this.state.addMine(id, owner, x, y)
  }

  removeMine(id: number): void {
    this.state.removeMine(id)
  }

  addHazard(id: number, kind: HazardKind, x: number, y: number, r: number, duration: number): void {
    this.state.addHazard(id, kind, x, y, r, duration)
  }

  removeHazard(id: number): void {
    if (this.hazardsHeld) this.pendingRemovals.push(id)
    else this.state.removeHazard(id)
  }

  /**
   * e2e only (T21.18): defer `hazard_ended` so a check can photograph one cloud
   * both ways. Measured: under suite load an 8 s cloud ended mid-photographs.
   * Releasing applies every removal that arrived meanwhile.
   */
  holdHazards(on: boolean): void {
    this.hazardsHeld = on
    if (on) return
    for (const id of this.pendingRemovals) this.state.removeHazard(id)
    this.pendingRemovals.length = 0
  }

  get hazardsAreHeld(): boolean {
    return this.hazardsHeld
  }

  private hazardsHeld = false
  private readonly pendingRemovals: number[] = []

  /** Live mine count. The e2e asserts this against the server's (§A39). */
  get mineCount(): number {
    return this.state.mines.size
  }

  get hazardCount(): number {
    return this.state.hazards.size
  }

  lights(): FxLight[] {
    return this.state.lights()
  }

  /** `eye` is the local player: mine visibility is a function of distance to
   * them, not to the camera centre, because the camera leads the aim. */
  update(dt: number, eye: { x: number; y: number }, now: number): void {
    this.state.update(dt)
    this.eye = eye
    this.now = now
    this.render()
  }

  /**
   * Draw the current state without advancing it — split out of `update` for
   * T21.18, so a High Quality change repaints the same instant.
   */
  render(): void {
    const g = this.gfx
    const eye = this.eye
    const now = this.now
    g.clear()

    // --- ground hazards, underneath everything else --------------------------
    // **T21.18: under High Quality a smoke cloud is one shader quad** — same hazard,
    // same fade; what a player inside can see is the server's either way.
    const shaderSmoke = this.useSmokeShader()
    let painted = 0
    for (const h of this.state.hazards.values()) {
      const t = fade(h.ttl, h.life)
      const colour = HAZARD_COLOUR[h.kind]
      if (h.kind === 'smoke') {
        const sh = shaderSmoke ? this.smokeShader(painted) : null
        if (sh) {
          painted++
          const c = C()
          const side = 2 * h.r * c.SMOKE_SHADER_SCALE
          sh.setPosition(h.x, h.y)
          sh.setDisplaySize(side, side)
          sh.setUniform('life.value', t)
          // The id decides the cloud's shape, so it is stable across renders.
          sh.setUniform('seed.value', (h.id % 97) * 0.6180339887)
          sh.setVisible(!this.hidden)
          continue
        }
        // A cloud, not a disc: three offset circles so it reads as volume, and
        // opaque enough that "I cannot see" has a visible cause.
        for (let i = 0; i < 3; i++) {
          const a = now * 0.0004 + i * 2.1
          g.fillStyle(colour, 0.34 * t)
          g.fillCircle(h.x + Math.cos(a) * h.r * 0.22, h.y + Math.sin(a) * h.r * 0.14, h.r * 0.78)
        }
      } else {
        // **The burning-ground disc is gone** (§F10.2/§F10.3). This branch used
        // to have a `fire` arm with its own flickering dots, and it was the
        // decal M19 exists to replace: a circle that damages you while you stand
        // in it says nothing about where the fire is going. A toxic cloud is
        // still a zone, because a zone is what it *is*.
        g.fillStyle(colour, 0.3 * t)
        g.fillCircle(h.x, h.y, h.r)
        g.lineStyle(2, colour, 0.75 * t)
        g.strokeCircle(h.x, h.y, h.r)
      }
    }
    // Quads with no cloud this frame are hidden, not destroyed: the pool is reused.
    for (let i = painted; i < this.smokeShaders.length; i++) this.smokeShaders[i]!.setVisible(false)
    this.smokeShadersDrawn = painted

    // --- flame jets ----------------------------------------------------------
    for (const j of this.state.jets) {
      const t = fade(j.ttl, j.life)
      g.fillStyle(0xff8a2a, 0.5 * t)
      g.slice(j.x, j.y, j.range, j.aim - j.arc / 2, j.aim + j.arc / 2, false)
      g.fillPath()
      g.fillStyle(0xffe08a, 0.6 * t)
      g.slice(j.x, j.y, j.range * 0.45, j.aim - j.arc / 2, j.aim + j.arc / 2, false)
      g.fillPath()
    }

    // --- melee arcs ----------------------------------------------------------
    for (const s of this.state.swings) {
      const t = fade(s.ttl, s.life)
      // A swing that connected is brighter — the feedback that tells you the
      // hit was yours rather than someone else's shot landing at the same time.
      const colour = s.hits > 0 ? 0xffffff : 0xc8d4e0
      g.lineStyle(s.hits > 0 ? 4 : 2, colour, 0.85 * t)
      g.beginPath()
      g.arc(s.x, s.y, s.reach, s.aim - s.arc / 2, s.aim + s.arc / 2, false)
      g.strokePath()
    }

    // --- mines ---------------------------------------------------------------
    for (const m of this.state.mines.values()) {
      const d = Math.hypot(m.x - eye.x, m.y - eye.y)
      const alpha = OrdnanceFxState.mineAlpha(d, MINE_NEAR, MINE_FAR)
      if (alpha <= 0) continue
      const armed = OrdnanceFxState.isArmed(m.age, this.armTime)
      // Big enough, and outlined, to read *over a sprite*: a mine sits at the
      // body centre of whoever placed it, so at the moment of placing it is
      // behind a 32x56 character. §B6 asks for visible at close range, and a
      // marker the placer cannot see is the version of that failure nobody
      // notices until they walk back onto their own mine.
      g.fillStyle(0x11151b, alpha)
      g.fillCircle(m.x, m.y, 7.5)
      g.lineStyle(1.5, 0xf0f4f8, alpha * 0.9)
      g.strokeCircle(m.x, m.y, 7.5)
      // Blinking is the tell, and it only starts once the mine can actually
      // hurt you — a disarmed mine sits still.
      const blink = armed ? 0.55 + 0.45 * Math.sin(now * 0.012) : 0.25
      g.fillStyle(armed ? 0xff4040 : 0xffc040, alpha * blink)
      g.fillCircle(m.x, m.y - 1, 3.4)
    }
  }

  /** T21.18: WebGL and High Quality, both — the one place that decides. */
  private useSmokeShader(): boolean {
    return this.webgl && isHighQuality()
  }

  /** Would a smoke cloud drawn now be painted by the shader? For the debug handles. */
  get smokeIsShader(): boolean {
    return this.useSmokeShader()
  }

  /** Show or hide the whole layer, for a check's same-instant control frame (§C2). */
  setVisible(on: boolean): void {
    this.hidden = !on
    this.gfx.setVisible(on)
    this.render()
  }

  get visible(): boolean {
    return !this.hidden
  }

  /** Quad `i` of the pool, built on first use; `null` past `SMOKE_SHADER_POOL`. */
  private smokeShader(i: number): Phaser.GameObjects.Shader | null {
    const c = C()
    if (i >= c.SMOKE_SHADER_POOL) return null
    while (this.smokeShaders.length <= i) {
      const base = new Phaser.Display.BaseShader('smokeCloud', SMOKE_FRAGMENT, undefined, {
        life: { type: '1f', value: 1 },
        seed: { type: '1f', value: 0 },
        scale: { type: '1f', value: c.SMOKE_SHADER_SCALE },
        tint: { type: '3f', value: rgbToUniform3f(HAZARD_COLOUR.smoke) },
      })
      this.smokeShaders.push(
        this.scene.add
          // A real base size, as the beam's quad has; `setDisplaySize` scales it per cloud.
          .shader(base, 0, 0, 64, 64)
          .setOrigin(0.5, 0.5)
          .setDepth(DEPTH.particles)
          .setVisible(false),
      )
    }
    return this.smokeShaders[i] ?? null
  }

  destroy(): void {
    this.gfx.destroy()
    for (const s of this.smokeShaders) s.destroy()
    this.smokeShaders.length = 0
    this.unsubscribeQuality()
  }
}
