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
import { DEPTH } from './backdrop'
import { OrdnanceFxState, fade, type FxLight, type HazardKind } from './ordnanceFx-math'

const SWING_LIFE = 0.15
const JET_LIFE = 0.08
/** §B6's numbers: unmissable at 40 px, gone by 300. */
const MINE_NEAR = 40
const MINE_FAR = 300

const HAZARD_COLOUR: Record<HazardKind, number> = {
  fire: 0xff7a1a,
  toxic: 0x7fe04a,
  smoke: 0xb9c0c8,
  other: 0xcccccc,
}

export class OrdnanceFxLayer {
  private readonly gfx: Phaser.GameObjects.Graphics
  readonly state: OrdnanceFxState

  constructor(
    scene: Phaser.Scene,
    private readonly armTime: number,
  ) {
    this.state = new OrdnanceFxState(SWING_LIFE, JET_LIFE)
    // Particles: in front of actors, behind the lightmap, so a flame jet is lit
    // by its own light rather than drawn over the darkness.
    this.gfx = scene.add.graphics().setDepth(DEPTH.particles)
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
    this.state.removeHazard(id)
  }

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
    const g = this.gfx
    g.clear()

    // --- ground hazards, underneath everything else --------------------------
    for (const h of this.state.hazards.values()) {
      const t = fade(h.ttl, h.life)
      const colour = HAZARD_COLOUR[h.kind]
      if (h.kind === 'smoke') {
        // A cloud, not a disc: three offset circles so it reads as volume, and
        // opaque enough that "I cannot see" has a visible cause.
        for (let i = 0; i < 3; i++) {
          const a = now * 0.0004 + i * 2.1
          g.fillStyle(colour, 0.34 * t)
          g.fillCircle(h.x + Math.cos(a) * h.r * 0.22, h.y + Math.sin(a) * h.r * 0.14, h.r * 0.78)
        }
      } else {
        g.fillStyle(colour, (h.kind === 'fire' ? 0.4 : 0.3) * t)
        g.fillCircle(h.x, h.y, h.r)
        g.lineStyle(2, colour, 0.75 * t)
        g.strokeCircle(h.x, h.y, h.r)
        if (h.kind === 'fire') {
          // Flicker, so burning ground does not read as a painted decal.
          for (let i = 0; i < 4; i++) {
            const a = now * 0.006 + i * 1.57
            g.fillStyle(0xffd070, 0.5 * t)
            g.fillCircle(h.x + Math.cos(a) * h.r * 0.5, h.y + Math.sin(a) * h.r * 0.5, 3)
          }
        }
      }
    }

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

  destroy(): void {
    this.gfx.destroy()
  }
}
