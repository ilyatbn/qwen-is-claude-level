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
import { C } from '../core'
import { OrdnanceFxState, fade, type HazardKind } from './ordnanceFx-math'
import { fxFeed, type FxFeed } from '../look/fx/feed'

const SWING_LIFE = 0.15
const JET_LIFE = 0.08

const HAZARD_COLOUR: Record<HazardKind, number> = {
  toxic: 0x7fe04a,
  smoke: 0xb9c0c8,
  other: 0xcccccc,
}

export class OrdnanceFxLayer {
  private readonly gfx: Phaser.GameObjects.Graphics
  readonly state: OrdnanceFxState
  /**
   * T23.18: the scene's effect feed (`look/fx/feed.ts`). While the world renderer draws this scene's effects the smoke
   * and toxic clouds are F's, drawn there from this layer's records (`fx/game.ts::cloudFx`, which retired T21.18's
   * smoke shader quad); otherwise (space until T23.20, no three.js) this layer draws the flat clouds below.
   */
  private readonly feed: FxFeed
  /** Hidden for a check's control frame; `render` honours it for the shader quads too. */
  private hidden = false
  /** What the last `update` was given, so a repaint draws the same instant. */
  private eyeAt = { x: 0, y: 0 }
  private now = 0

  /** T23.10C F5: §B6 — unmissable within `MINE_NEAR`, gone by `MINE_FAR` (constants.rs; were 40 / 300 here and in `feed.ts`). */
  readonly mineNear = C().MINE_NEAR
  readonly mineFar = C().MINE_FAR

  constructor(
    scene: Phaser.Scene,
    readonly armTime: number,
  ) {
    this.state = new OrdnanceFxState(SWING_LIFE, JET_LIFE)
    // Particles: in front of actors, behind the lightmap, so a flame jet is lit
    // by its own light rather than drawn over the darkness.
    this.gfx = scene.add.graphics().setDepth(DEPTH.particles)
    this.feed = fxFeed(scene)
    this.feed.zones = this
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

  moveMine(id: number, x: number, y: number): void {
    this.state.moveMine(id, x, y)
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

  /** T23.18: for the world renderer's mines (`look/fx/feed.ts`): the eye and the clock the last `update` was given. */
  get eye(): { x: number; y: number } {
    return this.eyeAt
  }

  get nowMs(): number {
    return this.now
  }

  /** `eye` is the local player: mine visibility is a function of distance to
   * them, not to the camera centre, because the camera leads the aim. */
  update(dt: number, eye: { x: number; y: number }, now: number): void {
    this.state.update(dt)
    this.eyeAt = eye
    this.now = now
    this.render()
  }

  /**
   * Draw the current state without advancing it — split out of `update` for
   * T21.18, so a High Quality change repaints the same instant.
   */
  render(): void {
    const g = this.gfx
    const eye = this.eyeAt
    const now = this.now
    g.clear()

    // --- ground hazards, underneath everything else --------------------------
    // T23.18: smoke and toxic clouds are F's where the world renderer draws them (`fx/game.ts::cloudFx`); what a
    // player inside can see is the server's either way.
    const worldFx = this.feed.worldDraws
    for (const h of this.state.hazards.values()) {
      const t = fade(h.ttl, h.life)
      const colour = HAZARD_COLOUR[h.kind]
      if (worldFx && h.kind !== 'other') continue
      if (h.kind === 'smoke') {
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

    // --- flame jets ----------------------------------------------------------
    for (const j of worldFx ? [] : this.state.jets) {
      const t = fade(j.ttl, j.life)
      g.fillStyle(0xff8a2a, 0.5 * t)
      g.slice(j.x, j.y, j.range, j.aim - j.arc / 2, j.aim + j.arc / 2, false)
      g.fillPath()
      g.fillStyle(0xffe08a, 0.6 * t)
      g.slice(j.x, j.y, j.range * 0.45, j.aim - j.arc / 2, j.aim + j.arc / 2, false)
      g.fillPath()
    }

    // --- melee arcs ----------------------------------------------------------
    for (const s of worldFx ? [] : this.state.swings) {
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
    for (const m of worldFx ? [] : this.state.mines.values()) {
      const d = Math.hypot(m.x - eye.x, m.y - eye.y)
      const alpha = OrdnanceFxState.mineAlpha(d, this.mineNear, this.mineFar)
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

  /** Show or hide the whole layer, for a check's same-instant control frame (§C2). */
  setVisible(on: boolean): void {
    this.hidden = !on
    this.gfx.setVisible(on)
    this.render()
  }

  get visible(): boolean {
    return !this.hidden
  }

  destroy(): void {
    this.gfx.destroy()
    if (this.feed.zones === this) this.feed.zones = null
  }
}
