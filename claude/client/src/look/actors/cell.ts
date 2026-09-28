/**
 * T23.12: what one actor's atlas cell holds, and how it is drawn — `f_kit.js::lit()` taken apart so the
 * light can be a shader (T23.13) while the drawing stays the mockup's Canvas2D (`draw.ts`).
 *
 * `lit()` paints, in order: the halo, the contact shadow, a far rim pass, a rim pass, a cool fill pass (each
 * the actor again, offset, in one flat colour — the **rim opts**: accent recoloured, marker/flame/muzzle
 * dropped, as the scene's lambdas do it), then the ink pass. A cell is five images of the actor's box:
 *
 *   under  — halo + shadow, in colour (they do not depend on the light's direction);
 *   mask   — the rim opts' silhouette: R = ink strokes, G = accent strokes, each call adding 64/255 with
 *            `lighter`, so a texel holds the **number** of strokes over it (a translucent pass darkens
 *            where strokes overlap: α = 1 − (1 − a)^n, which a coverage mask cannot give);
 *   ink    — the ink pass exactly as the mockup draws it (`DARK_INK`, the real accent, marker, flame).
 *
 * The fixed-colour parts every pass draws in their own colours (jet flame, crystal glow, rocket motor, spider eye:
 * `draw.ts::setExtras`) are left out of the masks; an actor that has them is baked (below).
 *
 * **The mask is drawn once per pass, at that pass's offset** (fill, rim, far rim) — the shader (`layer.ts`)
 * composites them with the pass's colour and alpha, which stay uniforms. Resampling one mask at the offsets
 * instead was measured and is not the same picture: the canvas re-rasterises each pass, and a bilinear shift of a
 * thin shape's edge is not that (F4, rim passes on: mean ΔE 0.37 on the actor boxes resampled — past the actor
 * threshold, 0.176 — birds 1.3, being all edge; a resampled glow 1.24 on the crystals). So a lit actor's cell keys
 * on its pass offsets (1/8 px): it redraws when its key light **turns** (or the actor moves round it), never when
 * the light only brightens, dims or changes colour.
 *
 * **An actor with extras is baked instead** (`drawBaked`): its whole `lit()` — halo, shadow, the passes in their
 * colours, the ink — drawn by the canvas into the ink image, as the mockup draws it. Its glows sit under and over
 * its silhouette in every pass (a crystal's highlight over the shard, a spider's eye over the body) and are
 * translucent over each other; composited from separate 8-bit images they round differently from one canvas —
 * measured on F4 with rim passes on, those four actors were 0.40 mean ΔE on their boxes separated and the rest 0.13.
 * Its key then holds the key light's colour and alpha too, so it also redraws when the light brightens or dims.
 */
import type { Actor, ActorOpts, Box } from '../scene'
import * as D from './draw'
import { LIT } from './lit'
import * as F from './figure'
import { WEAPONS, drawWeapon, held, weaponReach } from './weapons'

/** `f_kit.js::DARK_INK` — the ink pass's colour. */
export const DARK_INK = '#07060a'
/** One stroke in the mask adds this much to its channel (four overlapping strokes fill it). */
export const MASK_STEP = 64
/** Px of clear border round each image, so a sample offset past the box reads nothing. */
export const CELL_PAD = 2
/** `lit()`'s contact shadow radius and halo radius, per unit of `size`. */
const SHADOW_R = 11
const HALO_R = 30
/** `lit()`'s halo opacity at its centre (F's `glow(…, 0.22)`), unless the actor says otherwise (`LitOpts.haloAlpha`). */
export const HALO_A = 0.22

export type Role = 'under' | 'mask' | 'ink'

/** The three pass offsets (px): fill, rim, far rim — the order of the mask images. */
export type PassOffsets = [[number, number], [number, number], [number, number]]

/** One lit actor's passes this frame (`lit.ts::passes`): what a cell may depend on. */
export interface Lighting {
  offs: PassOffsets
  rgb: string
  a: number
  fill: string
  rim: boolean
}

/** Does `a` draw anything in a fixed colour in its rim and fill passes (`draw.ts`'s `extras` sites)? */
export function hasExtras(a: Actor): boolean {
  if (!a.lit) return false
  return (a.kind === 'stick' && !!a.opts.jet) || (a.kind === 'figure' && !!a.opts.J?.jet) || a.kind === 'crystals' || a.kind === 'rocket' || a.kind === 'spider'
}

/** The scene lambdas' rim-pass options (`f_scene.js` / `variant_F4.js`: `rc ? … : …`). */
function rimOpts(a: Actor, accent: string): ActorOpts {
  const o = a.opts
  switch (a.kind) {
    case 'stick': {
      const r: ActorOpts = { ...o, accent, marker: false }
      delete r.flame
      // T23.16: F6's row draws `held(k, rc ?? '#e8482c')` — the rim colour for the weapon's accents too.
      if (o.held) r.heldAccent = accent
      return r
    }
    case 'weapon':
    case 'item':
      // `variant_F6.js`: `Wd.draw(gg, rc ?? '#e8482c')` — a pass's colour drops the accents (`weapons.ts::accentOK`).
      // T23.19: a non-weapon pickup the same way — its one accent is the pass's colour in a pass.
      return { ...o, accent }
    case 'turret':
      return { ...o, muzzle: false }
    case 'gate':
      return { ...o, accent: 'rgba(0,0,0,0)', inner: 'rgba(0,0,0,0)' }
    case 'figure':
      // `variant_F7.js`: `accent: rc ?? o.accent, rim: !!rc` — `figure` drops the visor, weapon accents and flame.
      return { ...o, accent }
    default:
      return o
  }
}

/** One `e_style.js` call for `a` with `o`, drawn at (x, y). */
function drawKind(g: D.G, a: Actor, o: ActorOpts, x: number, y: number): void {
  switch (a.kind) {
    case 'stick': {
      const w = o.held ? held(o.held, o.heldAccent) : null
      D.stick(g, x, y, { ...o, ...(w ? { weapon: w } : {}), flame: o.flame ?? null })
      return
    }
    case 'weapon':
      if (o.key) drawWeapon(g, o.key, x + (o.origin?.[0] ?? 0), y + (o.origin?.[1] ?? 0), o.s ?? 1, o.accent)
      return
    case 'turret':
      D.turret(g, x, y, o)
      return
    case 'gate':
      D.gate(g, x, y, o)
      return
    case 'crystals':
      D.crystals(g, x, y, o)
      return
    case 'beetle':
      D.beetle(g, x, y, o)
      return
    case 'spider':
      D.spider(g, x, y, o)
      return
    case 'bird':
      D.bird(g, x, y, o)
      return
    case 'rocket':
      D.rocket(g, x, y, o.ang ?? 0, o)
      return
    case 'grave':
      D.grave(g, x, y, o)
      return
    case 'item':
      D.item(g, x, y, o)
      return
    case 'figure':
      if (o.J) F.figure(g, x, y, o.J, { s: o.s ?? 1.15, face: o.face ?? 1, rot: o.rot ?? 0, accent: o.accent ?? '#e8482c', rim: o.accent?.startsWith('rgba(') ?? false, visor: o.visor ?? null })
      return
    case 'smoke': {
      // Unlit; its points are mask px — moved by the same offset as (x, y).
      const pts = (o.pts ?? []).map(([px, py]): [number, number] => [px - a.x + x, py - a.y + y])
      D.smoke(g, pts, { rgb: o.rgb, a: o.a, size: o.size, grow: o.grow })
      return
    }
  }
}

/**
 * Cell rects start and span whole multiples of this, px. Chrome dithers Canvas2D gradients (a halo, a shadow, a
 * jet flame) with a pattern fixed to the canvas's pixel grid: the mockup's canvas is the screen, so a cell drawn
 * off that grid's phase dithers differently — measured, a halo 1–4 levels off at every other pixel.
 */
export const CELL_ALIGN = 8

/** The cell's rect in mask px: the actor's measured box (the look-lab) or one estimated from its size. */
export function actorRect(a: Actor): Box {
  const b = a.box ?? estimateBox(a)
  const A = CELL_ALIGN
  const x0 = Math.floor((b[0] - CELL_PAD) / A) * A
  const y0 = Math.floor((b[1] - CELL_PAD) / A) * A
  return [x0, y0, x0 + Math.ceil((b[2] + CELL_PAD - x0) / A) * A, y0 + Math.ceil((b[3] + CELL_PAD - y0) / A) * A]
}

/** A box no drawing of `a` leaves (figure units × scale, plus `lit()`'s halo, shadow and pass offsets). */
export function estimateBox(a: Actor): Box {
  const s = a.opts.s ?? 1
  const size = a.lit?.size ?? 1
  // Longest reach of any kind from its anchor, in figure units (the whip's tip is 36.5 from the shoulder).
  const reach = 44 * s + 2 * 1.15 * size + 2
  let b: Box = [a.x - reach, a.y - reach - 6 * s, a.x + reach, a.y + 6 * s + 2]
  if (a.kind === 'figure') {
    // A figure, from its middle (the hip, 13 up): the head and a helmet within 20, feet within 16, wings 22, and its
    // weapon's muzzle from the shoulder (8.5 above the hip) — the whip's 36.5 is the longest. A square of that
    // radius covers any turn (space thrust, a ragdoll). T23.14: sized per weapon because a 44-unit square for every
    // figure filled the atlas in a 6-player match (resets every few frames, measured).
    const W = a.opts.J?.weapon ? WEAPONS[a.opts.J.weapon] : undefined
    const R = (Math.max(22, W ? Math.hypot(W.muzzle[0], W.muzzle[1]) + 10 : 0) + 2) * s + 2 * 1.15 * size + 2
    // T23.14B: the middle turned with the figure (it turns about its feet; space turns it a whole way round).
    const rot = a.opts.rot ?? 0
    const cx = a.x + 13 * s * Math.sin(rot)
    const cy = a.y - 13 * s * Math.cos(rot)
    b = [cx - R, cy - R, cx + R, cy + R]
  }
  if (a.kind === 'weapon') {
    // T23.16: a weapon alone, from its shoulder-frame origin (`weapons.ts::weaponReach`), plus the rim passes' reach.
    const [x0, y0, x1, y1] = weaponReach(a.opts.key ?? '')
    const m = 2 * 1.15 * size + 2
    const ox = a.x + (a.opts.origin?.[0] ?? 0)
    const oy = a.y + (a.opts.origin?.[1] ?? 0)
    b = [ox + x0 * s - m, oy + y0 * s - m, ox + x1 * s + m, oy + y1 * s + m]
  }
  if (a.kind === 'crystals' && !a.box) {
    // T23.19: the shards (±9, 32 up) and their glow (radius 22 about 8 up) — the default square clipped the glow's
    // lower half in the game, where no measured box is given (a hard-edged blue band across the rock).
    const m = 2 * 1.15 * size + 2
    b = [a.x - 23 * s - m, a.y - 33 * s - m, a.x + 23 * s + m, a.y + 15 * s + m]
  }
  if (a.kind === 'grave' || a.kind === 'item') {
    // T23.19: `draw.ts::grave` (±8 × 18 above its feet) and `item` (±8 about its middle), plus the rim passes' reach.
    const m = 2 * 1.15 * size + 2
    b = a.kind === 'grave' ? [a.x - 9 * s - m, a.y - 17 * s - m, a.x + 9 * s + m, a.y + 3 * s + m] : [a.x - 9 * s - m, a.y - 9 * s - m, a.x + 9 * s + m, a.y + 9 * s + m]
  }
  if (a.kind === 'bird') {
    // T23.19B: `draw.ts::bird` spans ±10 and flaps ±6 about its body (the metal one's fin 4 up), plus the rim passes.
    const m = 2 * 1.15 * size + 2
    b = [a.x - 11 * s - m, a.y - 8 * s - m, a.x + 11 * s + m, a.y + 8 * s + m]
  }
  if (a.lit?.halo) {
    const hy = a.y - 14 * size
    const r = HALO_R * size
    b = [Math.min(b[0], a.x - r), Math.min(b[1], hy - r), Math.max(b[2], a.x + r), Math.max(b[3], hy + r)]
  }
  if (a.lit?.shadow) b = [Math.min(b[0], a.x - SHADOW_R * size), b[1], Math.max(b[2], a.x + SHADOW_R * size), b[3]]
  return b
}

/**
 * **Where an actor stands is part of its drawing, at the mockup's pixel phase — in the game as in the look-lab**
 * (T23.14E F5, reverting T23.14D F13's single cell anchor for the game). A cell is drawn with its actor at the actor's
 * own position mod `CELL_ALIGN` — the sub-pixel fraction included (T23.16: F6 stands its weapons at fractional x, and
 * the mockup's canvas draws them there) — and the layer moves the quad by whole `CELL_ALIGN`s (`layer.ts`).
 *
 * Why one path: at one anchor F4's cast measured 0.2834 mean ΔE on its actor boxes against a gate of 0.1761 (0.1187 at
 * the pixel phase) — Chrome dithers a Canvas2D gradient on a pattern fixed to the canvas's pixel grid — and the anchor
 * bought no measured fps (T23.14D: redraws are pose-driven). So the game draws what the gate measured.
 * `atAnchor(a)` is `a` moved to its cell position; its `box` and a smoke's points move with it.
 */
export function atAnchor(a: Actor): Actor {
  const at = (v: number): number => v - Math.floor(v / CELL_ALIGN) * CELL_ALIGN
  const dx = at(a.x) - a.x
  const dy = at(a.y) - a.y
  if (dx === 0 && dy === 0) return a
  const out: Actor = { ...a, x: a.x + dx, y: a.y + dy, box: a.box ? [a.box[0] + dx, a.box[1] + dy, a.box[2] + dx, a.box[3] + dy] : null }
  if (a.kind === 'smoke' && a.opts.pts) out.opts = { ...a.opts, pts: a.opts.pts.map(([x, y]): [number, number] => [x + dx, y + dy]) }
  return out
}

/**
 * Everything the drawing depends on — and nothing the light does. The key is `a`'s at its cell position
 * (`atAnchor`): the sub-pixel phase to 1/8 px is part of it. The pass offsets are too (the masks are drawn at them).
 */
export function cellKey(actor: Actor, L: Lighting | null): string {
  const a = atAnchor(actor)
  const r = actorRect(a)
  const q = (v: number): number => Math.round(v * 8) / 8
  const offs = a.lit && L ? L.offs.map(([x, y]) => [q(x), q(y)]) : null
  const baked = hasExtras(a) && L ? [L.rgb, Math.round(L.a * 256), L.fill, L.rim] : null
  return JSON.stringify([a.kind, a.opts, a.lit, r[2] - r[0], r[3] - r[1], q(a.x - r[0]), q(a.y - r[1]), offs, baked])
}

/** `lit()` whole, into `g` whose (0, 0) is the cell rect's top-left (an actor with extras — see above). */
export function drawBaked(g: D.G, a: Actor, L: Lighting): void {
  const [far, rim, fill] = [L.offs[2], L.offs[1], L.offs[0]]
  drawRole(g, a, 'under')
  const pass = (ink: string, accent: string, off: [number, number]): void => {
    const r = actorRect(a)
    g.save()
    g.lineCap = 'round'
    g.lineJoin = 'round'
    D.setInk(ink)
    drawKind(g, a, rimOpts(a, accent), a.x - r[0] + off[0], a.y - r[1] + off[1])
    D.setInk(DARK_INK)
    g.restore()
  }
  if (L.rim) {
    pass(`rgba(${L.rgb},${L.a * LIT.farInk})`, `rgba(${L.rgb},${L.a * LIT.farAccent})`, far)
    pass(`rgba(${L.rgb},${L.a})`, `rgba(${L.rgb},${L.a})`, rim)
  }
  pass(`rgba(${L.fill},${LIT.fillAlpha})`, `rgba(${L.fill},${LIT.fillAlpha})`, fill)
  drawRole(g, a, 'ink')
}

/** The offsets a pass is drawn at: `cellKey`'s 1/8 px, so the key and the drawing agree. */
export function snapOffsets(offs: PassOffsets): PassOffsets {
  const q = (v: number): number => Math.round(v * 8) / 8
  return offs.map(([x, y]) => [q(x), q(y)]) as PassOffsets
}

/** Draw image `role` of `a` into `g`, whose (0, 0) is the cell rect's top-left; a pass's mask at `off`. */
export function drawRole(g: D.G, a: Actor, role: Role, off: [number, number] = [0, 0]): void {
  const r = actorRect(a)
  const shifted = role === 'mask'
  const x = a.x - r[0] + (shifted ? off[0] : 0)
  const y = a.y - r[1] + (shifted ? off[1] : 0)
  const lit = a.lit
  g.save()
  g.lineCap = 'round'
  g.lineJoin = 'round'
  try {
    if (role === 'under') {
      if (!lit) return
      if (lit.halo) D.glow(g, x, y - 14 * lit.size, HALO_R * lit.size, lit.halo, lit.haloAlpha ?? HALO_A)
      if (lit.shadow) {
        const R = SHADOW_R * lit.size
        const gr = g.createRadialGradient(x, y, 0, x, y, R)
        gr.addColorStop(0, 'rgba(0,0,0,0.55)')
        gr.addColorStop(1, 'rgba(0,0,0,0)')
        g.translate(x, y)
        g.scale(1, 0.25)
        g.translate(-x, -y)
        g.fillStyle = gr
        g.beginPath()
        g.arc(x, y, R, 0, 7)
        g.fill()
      }
      return
    }
    if (role === 'mask') {
      if (!lit) return
      g.globalCompositeOperation = 'lighter'
      D.setExtras(false)
      D.setInk(`rgb(${MASK_STEP},0,0)`)
      drawKind(g, a, rimOpts(a, `rgba(0,${MASK_STEP},0,1)`), x, y)
      return
    }
    D.setInk(DARK_INK)
    drawKind(g, a, a.opts, x, y)
  } finally {
    D.setExtras(true)
    D.setInk(DARK_INK)
    g.restore()
  }
}
