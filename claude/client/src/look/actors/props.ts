/**
 * T23.19A: the map's props — teleport gates and gun-platform turrets — as world-renderer actors, drawn by F's own
 * `draw.ts::gate` / `draw.ts::turret` into the actor atlas and ordered **behind** the figures (`cast.ts`, `back`).
 * Phaser drew them at depth 9 on its canvas, which lies over the world canvas, so they covered every figure: a player
 * mounted on a turret showed only a flame and a name tag (shots/t2314b-match-jet-gpu.png).
 *
 * Sized from the simulation's footprints, so the picture cannot drift from the rock they protect: the gate is drawn
 * `PAD_ART_W` wide (the columns the generator fills under it, T21.28), which is F1's own `s: 1.35` within 2 %;
 * the turret at F1's scale (`s` 1, 32 px across its base) — F1 draws it beside a figure at 1.15, and that proportion
 * is the reference's. Rim light and shadow are F1's (`scenes/F1.ts`: gate `size 1.4`, turret `size 1.2`).
 *
 * Pure: no Phaser, so the node tests read the geometry the layers hand the checks.
 */
import type { Actor } from '../scene'

/** The gate's drawn width at `s` 1: `draw.ts::gate`'s stones sit on radius 16 and reach 3.2 beyond it. */
export const GATE_ART_W = 2 * (16 + 3.2)
/** Its haze window (`gate`'s inner disc): radius 13, centred 18 above the feet — at `s` 1. */
const GATE_WINDOW = { r: 13, dy: -18 }
/** F1's palette (`P.gateAccent` / `P.gateInner`) — the night gate. */
export const GATE_ACCENT = '#f0c060'
const GATE_INNER: [number, number, number, number] = [40, 34, 48, 0.9]
/**
 * The charge: the window fills from F1's dark haze toward this as `teleportCharge` runs (T21.12's rule — a doorway
 * filling in reads at a glance). Pale, as T21.12 found it has to be against a sky; F1's gate light (`P.gate`) is its hue.
 */
const GATE_CHARGED: [number, number, number, number] = [250, 228, 170, 0.95]
/**
 * Charge steps the gate is drawn at. The atlas keys a cell on the drawing, so a continuous fill would redraw the gate
 * every frame of a charge; ten steps is a visible fill and at most ten cells.
 */
export const GATE_CHARGE_STEPS = 10

/** The turret's scale: F1's (`s` default 1). */
export const TURRET_S = 1
/** `draw.ts::turret` at `s` 1: base ±16, housing −21.5 … −12.5 about the pivot 17 up, barrels to 17 along the aim. */
const TURRET_TOP = 17 + 4.5
/** F1's turret aim (rad, up from level) — the platform gun's aim is not on the wire (its rounds are). */
export const TURRET_AIM = 0.22

export function gateScale(padArtW: number): number {
  return padArtW / GATE_ART_W
}

/** The charge the gate is drawn at, stepped: 0 (idle) … 1 (full). */
export function steppedCharge(charge: number): number {
  const t = Math.max(0, Math.min(1, Number.isFinite(charge) ? charge : 0))
  return Math.round(t * GATE_CHARGE_STEPS) / GATE_CHARGE_STEPS
}

function rgba(c: readonly number[]): string {
  return `rgba(${c[0]},${c[1]},${c[2]},${c[3]})`
}

/** The window's colour at stepped charge `t`. */
export function gateInner(t: number): string {
  const k = steppedCharge(t)
  const m = GATE_INNER.map((v, i) => {
    const w = v + (GATE_CHARGED[i]! - v) * k
    return i === 3 ? Math.round(w * 100) / 100 : Math.round(w)
  })
  return rgba(m)
}

/** A gate standing on the feet line at (x, y), its window filled to `charge`. */
export function gateActor(x: number, y: number, padArtW: number, charge: number): Actor {
  return {
    kind: 'gate',
    x,
    y,
    opts: { s: gateScale(padArtW), accent: GATE_ACCENT, inner: gateInner(charge) },
    lit: { size: 1.4, halo: null, shadow: true },
    box: null,
  }
}

/**
 * Where the gate is drawn, relative to its feet line, world px — the shape `PadLayer::portalGeometry` has always
 * handed `teleport.mjs`: the window (the charge indicator) and the stone's own size.
 */
export function gateGeometry(padArtW: number): { dy: number; rx: number; ry: number; gw: number; gh: number } {
  const s = gateScale(padArtW)
  const r = GATE_WINDOW.r * s
  return { dy: GATE_WINDOW.dy * s, rx: r, ry: r, gw: GATE_ART_W * s, gh: (-GATE_WINDOW.dy + GATE_ART_W / 2) * s }
}

/** A turret bolted to the feet line at (x, y), facing `face`. */
export function turretActor(x: number, y: number, face: 1 | -1): Actor {
  return {
    kind: 'turret',
    x,
    y,
    opts: { s: TURRET_S, face, aim: TURRET_AIM },
    lit: { size: 1.2, halo: null, shadow: true },
    box: null,
  }
}

/** The turret's drawn size at `TURRET_S`, world px: its base's width and its height above the feet line (housing top). */
export function turretGeometry(): { w: number; h: number } {
  return { w: 32 * TURRET_S, h: TURRET_TOP * TURRET_S }
}

/**
 * The occupied lamps' place (T21.14's two flanking bars), relative to the feet line, world px: **on the base line,
 * outboard of the tripod's feet** (base ±16). They are Phaser's, over everything, so they must sit where the rider is
 * not — first placed above the housing, they covered 13 % of a mounted figure (`gunner-visible`: 86.6 % shown).
 */
export function turretLamps(): { dy: number; dx: number; w: number; h: number } {
  return { dy: -1.5 * TURRET_S, dx: 20 * TURRET_S, w: 6 * TURRET_S, h: 2.5 * TURRET_S }
}

/** Which way a platform's turret faces: toward the map's middle, so its barrels point into the play. */
export function turretFace(x: number, mapW: number): 1 | -1 {
  return x <= mapW / 2 ? 1 : -1
}

/**
 * The stopgap for the layers still on Phaser's canvas (pickups, graves — T23.19): does a figure whose feet are at
 * (x, y) overlap any of `things` (world px, each a feet-line point with a half width and a height)? A figure that does is
 * drawn through Phaser (`PlayerView.drawSpace`) at the actors' depth, over them, rather than under them.
 */
export function overlapsAny(
  x: number,
  y: number,
  figW: number,
  figH: number,
  things: Iterable<{ x: number; y: number }>,
  halfW: number,
  h: number,
): boolean {
  for (const t of things) {
    if (Math.abs(t.x - x) > figW / 2 + halfW) continue
    // Vertical spans [y - figH, y] and [t.y - h, t.y + h] (an item's anchor is its middle or its feet; both covered).
    if (t.y + h < y - figH || t.y - h > y) continue
    return true
  }
  return false
}

/** The stopgap's other half: does the figure (feet at (x, y)) overlap any of `boxes` (world px, a pickup's label)? */
export function overlapsBoxes(x: number, y: number, figW: number, figH: number, boxes: Iterable<{ x0: number; y0: number; x1: number; y1: number }>): boolean {
  for (const b of boxes) {
    if (x + figW / 2 < b.x0 || x - figW / 2 > b.x1) continue
    if (y < b.y0 || y - figH > b.y1) continue
    return true
  }
  return false
}
