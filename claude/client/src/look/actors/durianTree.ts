/**
 * T24.01: **the durian tree and its glowing fruit**, for the world renderer. The tree is scenery the server placed
 * (`map_init`'s trees, `map::durian`); its fruit are world items (`source === 'Tree'`) the item layer draws through
 * [`fruitActor`] — the durian grenade's model with a **pulsing green halo** — and each lights the rock round it
 * ([`fruitLights`], capped like the crystals' statics so a grove cannot take every light slot). Cosmetic (R3):
 * nothing here is read by the simulation.
 */
import type Phaser from 'phaser'
import type { Actor, Light, RgbString } from '../scene'
import type { LightSpec } from '../effectLights'
import { joinCast } from './cast'
import { VIEW_MARGIN, nearView, pickupActor } from './furniture'

/**
 * Where each fruit hangs, px from the trunk's foot — `game-core/src/map/durian.rs::FRUIT_AT`, mirrored here for the
 * drawing's branches (`durianTree.test.ts` reads the Rust table and holds this to it).
 */
export const FRUIT_AT: readonly [number, number][] = [[-40, -48], [34, -66], [-6, -88]]

/** The fruit's glow (the reference sheet's green halo), and its light: a small, low point light, as a crystal's. */
export const DURIAN_GLOW: RgbString = '110,255,140'
export const DURIAN_LIGHT: LightSpec = { z: 14, r: 80, rgb: DURIAN_GLOW, i: 1.0 }
/**
 * At most this many fruit lights a frame — two trees' worth (`DURIAN_TREES` × `DURIAN_FRUIT`). The renderer has a
 * handful of point-light slots (`TERRAIN_LIGHTS`), ranked by intensity × coverage; a pulsing grove must leave room for
 * the fight's own lights, as the crystals' static lights do.
 */
export const DURIAN_LIGHTS_MAX = 6
/** One pulse every `DURIAN_PULSE_S` seconds, drawn in `DURIAN_PULSE_STEPS` steps (a halo is baked into its atlas cell:
 *  a step is a cell, a continuous pulse would redraw every fruit every frame). Low between peaks, never out. */
export const DURIAN_PULSE_S = 1.6
export const DURIAN_PULSE_STEPS = 6
export const DURIAN_PULSE_MIN = 0.45
/** The halo round a hanging fruit: `lit()`'s size (its radius is 30 × this) and its opacity at the pulse's peak. */
export const FRUIT_HALO_SIZE = 0.55
export const FRUIT_HALO_A = 0.6
/** A hanging fruit is drawn this many times a ground pickup's size: on the tree it is the reason to go there, and at a
 *  pickup's size it read as a dark dot under the glow (`shots/t2401-tree1-day.png`, first GPU run). */
export const FRUIT_SCALE = 1.6

/** The pulse (`DURIAN_PULSE_MIN` … 1) at `t` seconds for a fruit offset by `phase` (0–1), quantised to its steps. */
export function durianPulse(t: number, phase = 0): number {
  const u = (((t / DURIAN_PULSE_S + phase) % 1) + 1) % 1
  const q = Math.floor(u * DURIAN_PULSE_STEPS) / DURIAN_PULSE_STEPS
  const wave = 0.5 + 0.5 * Math.cos(q * Math.PI * 2)
  return DURIAN_PULSE_MIN + (1 - DURIAN_PULSE_MIN) * wave
}

/** A fruit's phase from its world item id, so a tree's three do not pulse as one. */
export function fruitPhase(id: number): number {
  return ((id * 0.618034) % 1 + 1) % 1
}

/** A tree on the map (`map_init`): its foot and its mirror. */
export interface DurianTreeView {
  x: number
  y: number
  flip: boolean
}

/** The tree as an actor: drawn about its foot, lit by the scene's moon and effects like every prop, no halo. */
export function durianTreeActor(t: DurianTreeView): Actor {
  return {
    kind: 'durianTree',
    x: t.x,
    y: t.y,
    opts: { s: 1, face: t.flip ? -1 : 1, seed: (Math.round(t.x) * 31 + Math.round(t.y)) & 0xffff, fruit: FRUIT_AT.map(([x, y]) => [x, y]) },
    lit: { size: 2, halo: null, shadow: false },
    box: null,
  }
}

/** A hanging fruit of registry sprite `sprite` at (x, y): its pickup drawing with the green halo at `pulse`. */
export function fruitActor(sprite: string, x: number, y: number, pulse: number): Actor {
  const a = pickupActor(sprite, x, y)
  const o = a.opts
  const opts = { ...o, s: (o.s ?? 1) * FRUIT_SCALE, ...(o.origin ? { origin: [o.origin[0] * FRUIT_SCALE, o.origin[1] * FRUIT_SCALE] as [number, number] } : {}) }
  return { ...a, opts, lit: { size: FRUIT_HALO_SIZE, halo: DURIAN_GLOW, haloAlpha: FRUIT_HALO_A * pulse, shadow: false } }
}

/** This frame's fruit lights: one per hanging fruit at its pulse, the brightest `DURIAN_LIGHTS_MAX`. */
export function fruitLights(fruit: Iterable<{ id: number; x: number; y: number }>, t: number): Light[] {
  const out: Light[] = []
  for (const f of fruit) {
    const k = durianPulse(t, fruitPhase(f.id))
    out.push({ x: f.x, y: f.y, z: DURIAN_LIGHT.z, r: DURIAN_LIGHT.r, rgb: DURIAN_LIGHT.rgb, i: DURIAN_LIGHT.i * k })
  }
  return out.sort((a, b) => b.i - a.i).slice(0, DURIAN_LIGHTS_MAX)
}

/** The map's trees into the scene's cast, behind the figures, each drawn while near the view and `on()`. */
export function joinDurianTrees(scene: Phaser.Scene, trees: readonly DurianTreeView[], on: () => boolean): () => void {
  const view = scene.cameras.main.worldView
  const leaves = trees.map((t) => {
    const a = durianTreeActor(t)
    return joinCast(scene, { back: true, actor: () => (on() && nearView(view, a.x, a.y - 80, VIEW_MARGIN + 80) ? a : null) })
  })
  return () => {
    for (const l of leaves) l()
  }
}
