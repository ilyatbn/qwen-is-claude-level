/**
 * One player on screen (`docs/50-sprites-skins.md` §3), **as M23's stick figure** (T23.14): the body is an actor in
 * the world renderer — `look/actors/figure.ts`, posed per frame by `look/actors/pose.ts` from what this view is
 * told (velocity, aim, flags, the held item) and drawn by code into the actor atlas, rim-lit by the scene's lights.
 * The sprite body, its skins, hats and glasses are gone (R8: wearables are ignored client-side; R15: their art
 * retires with this, its last reader). Boots and wings are items and are drawn on the figure.
 *
 * What stays in Phaser, in the container: the shield bubble, the name tag and the thruster plume (T23.14B).
 * The figure turns with the scene's tilt about its feet like the old body did (T22.19, R107).
 */

import type Phaser from 'phaser'
import { C } from '../core'
import { deriveAnimState, facingLeft, type AnimInputs, type AnimState } from './playerView-math'
import type { Appearance } from '../ui/skins'
import { hasWebGL } from './shaders'
import { ThrusterPlume } from './thrusterPlume'
import { plumeOn } from './thrusterPlume-math'
import { feetOffset, toLocal, uprightLocal } from './standTilt-math'
import type { Actor } from '../look/scene'
import { joinCast, groundDyAt } from '../look/actors/cast'
import { FIGURE_SCALE, newFigureState, stepFigure, trigger, type Action } from '../look/actors/pose'
import { WEAPONS } from '../look/actors/weapons'
import { actorRect, cellKey, drawBaked, type Lighting } from '../look/actors/cell'
import { passes } from '../look/actors/lit'
import { Flat } from '../look/actors/flat'

export type { AnimState, AnimInputs }
export { deriveAnimState, facingLeft }

export interface PlayerFlags {
  alive: boolean
  grounded: boolean
  jetpack: boolean
  shield: boolean
  iframes: boolean
  /** T21.02's ironman boots — per frame, off the move-mods byte (a remote's too). Drawn on the figure's feet. */
  boots: boolean
  /** T21.03's unicorn wings — per frame, off the same byte. Drawn on the figure's back. */
  wings: boolean
  /** T22.04: the match is zero-g (the helmet, the space pose, the plume). Required: a forgotten one would compile. */
  space: boolean
  /** T22.04C: the local player's applied thrust (`Core.thrustAt`), or null — a remote's input is not on the wire. */
  thrust: { x: number; y: number } | null
  /** T22.19 (R107): the figure's turn about its feet, radians, visual only. */
  tilt: number
}

/**
 * R10: the scarf is the player's colour, one per seat (`MAX_PLAYERS` = 6) — F's two (`f_scene.js` teamA/teamB, F4's
 * A/B) first, then four more apart from them in hue and from every effect colour (fire orange, laser teal, the
 * moon's lavender): gold, violet, green, rose. Rim light never tints it (T23.13).
 */
export const SCARF_COLOURS = ['#e8482c', '#18c2b8', '#e8b52c', '#9b6cf0', '#5fd34a', '#f06cb4'] as const
/** F1's `P.halo` — the dark halo a figure gets on the cave wall (T23.13). */
export const DARK_HALO = '120,120,170'

/**
 * **Space draws the figure in Phaser** (T23.14, until T23.20). A space map keeps T22.06's opaque Phaser backdrop and
 * Phaser's rock (the lit terrain and F's sky are not drawn there yet), and the world canvas lies *under* Phaser's —
 * so a figure in the world renderer is hidden in space (seen: `stand-on-asteroid`, 0 figure px). There the figure is
 * drawn by the same code (`cell.ts::drawBaked`, the whole `lit()`) into a canvas texture on the container, keyed on the
 * light by F's moon (`f_scene.js` P.moon; effect lights reach it with T23.20).
 */
const SPACE_MOON = { dx: 0.6, dy: -0.8, rgb: '185,195,245', w: 0.75, fill: '90,80,110' }
/** The space figure's canvas, px, and where its feet sit in it. */
const SPACE_CANVAS = 192
const SPACE_FEET: [number, number] = [96, 132]
let spaceTextures = 0

export class PlayerView {
  readonly container: Phaser.GameObjects.Container
  private readonly shieldBubble: Phaser.GameObjects.Arc
  private readonly plume: ThrusterPlume
  private readonly nameLabel: Phaser.GameObjects.Text
  /** The figure's animation state (`pose.ts`) and what it was last posed as. */
  private readonly fig = newFigureState()
  private drawn: Actor | null = null
  private weaponKey = ''
  private seat = 0
  private readonly leave: () => void
  private lastT = 0
  /** T22.19: the last `setState`, so an e2e pose can redraw the same instant at another tilt. */
  private last: Parameters<PlayerView['setState']> | null = null
  private drawnTilt = 0
  private animState: AnimState = 'idle'
  private readonly skinId: number
  private readonly hatId: number
  private readonly glassesId: number
  private readonly scene: Phaser.Scene
  /** Space only (above): the figure as a Phaser image over a canvas texture, and the key it was last drawn at. */
  private space: { img: Phaser.GameObjects.Image; tex: Phaser.Textures.CanvasTexture; flat: Flat; key: string } | null = null

  /**
   * The appearance ids are still taken (the rebuild guard compares them, `look`) and drawn as nothing (R8).
   */
  constructor(scene: Phaser.Scene, skinId: number, hatId: number, glassesId: number) {
    const c = C()
    this.scene = scene
    this.skinId = skinId
    this.hatId = hatId
    this.glassesId = glassesId
    this.shieldBubble = scene.add.circle(0, -c.PLAYER_H * 0.4, c.PLAYER_H * 0.75, 0x54b6ff, 0.18).setVisible(false)
    this.nameLabel = scene.add.text(0, -c.PLAYER_H - 6, '', { fontSize: '9px', color: '#dfe6ee' }).setOrigin(0.5, 1)
    this.container = scene.add.container(0, 0, [this.shieldBubble, this.nameLabel])
    this.plume = new ThrusterPlume(scene, this.container, hasWebGL(scene))
    this.leave = joinCast(scene, { actor: () => (this.container.visible ? this.drawn : null) })
  }

  /** R10: which seat's scarf colour this player wears. */
  setSeat(seat: number): void {
    this.seat = ((seat % SCARF_COLOURS.length) + SCARF_COLOURS.length) % SCARF_COLOURS.length
  }

  /** T23.14: play an action over the pose — a melee swing, a throw, a hit reaction. */
  act(kind: Action): void {
    trigger(this.fig, kind)
  }

  /** T23.14: this player used item `key` — a melee weapon swings, a thrown one is thrown; a gun changes nothing. */
  firedWith(key: string | null | undefined): void {
    const W = key ? WEAPONS[key] : undefined
    if (W?.melee) this.act('melee')
    else if (W?.thrown) this.act('throw')
  }

  setState(x: number, y: number, vx: number, vy: number, aim: number, flags: PlayerFlags): void {
    const c = C()
    this.last = [x, y, vx, vy, aim, flags]
    const tilt = flags.tilt
    this.drawnTilt = tilt
    // T22.19 (R107): turned about the feet, where the body's box meets the rock (T22.19B F3).
    const feet = feetOffset(tilt, c.PLAYER_W, c.PLAYER_H)
    const fx = x + feet.x
    const fy = y + feet.y
    this.container.setPosition(fx, fy)
    this.container.setRotation(tilt)
    const tag = uprightLocal(tilt, feet, 0, -c.PLAYER_H / 2 - 6)
    this.nameLabel.setPosition(tag.x, tag.y).setRotation(-tilt)
    this.animState = deriveAnimState({ alive: flags.alive, grounded: flags.grounded, jetpack: flags.jetpack, vx, vy })
    this.shieldBubble.setVisible(flags.shield)

    // The figure: posed from the frame's state, in the figure's own frame (aim and motion turned by the tilt).
    const now = this.scene.time.now
    const dt = this.lastT ? Math.min(0.1, Math.max(0, (now - this.lastT) / 1000)) : 1 / 60
    this.lastT = now
    const localAim = aim - tilt
    const vel = toLocal(tilt, vx, vy)
    const upright = Math.abs(tilt) < 1e-3
    const d = stepFigure(this.fig, {
      dt,
      vx: vel.x,
      vy: vel.y,
      aim: localAim,
      alive: flags.alive,
      grounded: flags.grounded,
      jetpack: flags.jetpack,
      space: flags.space,
      thrust: flags.thrust ? toLocal(tilt, flags.thrust.x, flags.thrust.y) : null,
      weapon: this.weaponKey || null,
      boots: flags.boots,
      wings: flags.wings,
      walkSpeed: c.WALK_SPEED,
      s: FIGURE_SCALE,
      ...(upright ? { x: fx, groundDy: (dx: number) => groundDyAt(this.scene, fx + dx, fy) } : {}),
    })
    const accent = SCARF_COLOURS[this.seat]!
    const fig: Actor = {
      kind: 'figure',
      x: fx,
      y: fy,
      opts: { J: d.J, s: FIGURE_SCALE, face: d.face, rot: tilt + d.rot, accent, visor: accent },
      lit: { size: 1, halo: null, shadow: d.shadow && upright, darkHalo: DARK_HALO },
      box: null,
    }
    this.drawn = flags.space ? null : fig
    this.drawSpace(flags.space ? { ...fig, x: SPACE_FEET[0], y: SPACE_FEET[1], opts: { ...fig.opts, rot: d.rot } } : null)

    // T22.04 plume, T22.19 turned into the figure's frame (T23.14B moves it into the world renderer).
    const thrust = flags.thrust ? toLocal(tilt, flags.thrust.x, flags.thrust.y) : null
    this.plume.update(plumeOn(flags.alive, flags.jetpack, flags.space), thrust, vel.x, vel.y, 0, -c.PLAYER_H / 2, c.PLAYER_W / 2, c.PLAYER_H / 2)
  }

  /** Space (above): draw `a` (feet at `SPACE_FEET`, turned only by its pose — the container carries the tilt) or hide it. */
  private drawSpace(a: Actor | null): void {
    if (!a) {
      this.space?.img.setVisible(false)
      return
    }
    if (!this.space) {
      const key = `__figure_space_${++spaceTextures}`
      const tex = this.scene.textures.createCanvas(key, SPACE_CANVAS, SPACE_CANVAS)
      if (!tex) return
      const img = this.scene.add.image(0, 0, key).setOrigin(SPACE_FEET[0] / SPACE_CANVAS, SPACE_FEET[1] / SPACE_CANVAS)
      this.container.addAt(img, 1)
      this.space = { img, tex, flat: new Flat(tex.getContext()), key: '' }
    }
    const s = this.space
    s.img.setVisible(true)
    const ps = passes([], SPACE_MOON, a.x, a.y, a.lit?.size ?? 1)
    const L: Lighting = { offs: [ps.fillOff, ps.off, [ps.off[0] * 1.7, ps.off[1] * 1.7]], rgb: ps.rimRgb, a: ps.a, fill: ps.fillRgb, rim: true }
    const key = cellKey(a, L)
    if (key === s.key) return
    s.key = key
    const g = s.tex.getContext()
    g.clearRect(0, 0, SPACE_CANVAS, SPACE_CANVAS)
    const r = actorRect(a)
    // `drawBaked` draws from the cell rect's corner (`actorRect`): move that corner to the rect's own place, so the
    // feet land on (a.x, a.y) = SPACE_FEET.
    s.flat.save()
    s.flat.translate(r[0], r[1])
    drawBaked(s.flat, a, L)
    s.flat.restore()
    s.tex.refresh()
  }

  /** The held item (a registry key; '' for none): the figure holds its `weapons.ts` model, or nothing. */
  setWeapon(key: string): void {
    this.weaponKey = key
  }

  /** T23.14, e2e: the actor this view hands the world renderer this frame (null before the first `setState`). */
  get figure(): Actor | null {
    return this.drawn
  }

  get state(): AnimState {
    return this.animState
  }

  get tilt(): number {
    return this.drawnTilt
  }

  get drawnAt(): { x: number; y: number } | null {
    return this.last ? { x: this.last[0], y: this.last[1] } : null
  }

  /** T22.19, e2e only: redraw the last `setState` at another tilt (and aim). */
  poseTilt(tilt: number, aim?: number): void {
    if (!this.last) return
    const [x, y, vx, vy, lastAim, flags] = this.last
    this.setState(x, y, vx, vy, aim ?? lastAim, { ...flags, tilt })
  }

  get drawnFeet(): { x: number; y: number } {
    return { x: this.container.x, y: this.container.y }
  }

  get drawnAim(): number | null {
    return this.last ? this.last[4] : null
  }

  setNameVisible(on: boolean): boolean {
    this.nameLabel.setVisible(on)
    return this.nameLabel.visible
  }

  get plumeState(): { drawn: boolean; shader: boolean; dir: { x: number; y: number } } {
    return this.plume.state
  }

  setPlumeHidden(on: boolean): void {
    this.plume.setHidden(on)
  }

  /** The name tag's text — called every frame by `GameScene` (T22.19B F6). */
  setName(name: string): void {
    this.nameLabel.setText(name)
  }

  get nameTag(): { text: string; x: number; y: number; visible: boolean } {
    const m = this.nameLabel.getWorldTransformMatrix()
    return { text: this.nameLabel.text, x: m.tx, y: m.ty, visible: this.container.visible && this.nameLabel.visible }
  }

  setVisible(v: boolean): void {
    this.container.setVisible(v)
  }

  destroy(): void {
    this.leave()
    if (this.space) this.scene.textures.remove(this.space.tex)
    this.container.destroy(true)
  }

  get skin(): number {
    return this.skinId
  }

  /** The appearance the room says (T20.12's rebuild guard) — drawn as nothing since M23 (R8). */
  get look(): Appearance {
    return { skinId: this.skinId, hatId: this.hatId, glassesId: this.glassesId }
  }
}
