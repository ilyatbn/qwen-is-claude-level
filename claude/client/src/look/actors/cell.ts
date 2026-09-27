/**
 * T23.12: what one actor's atlas cell holds, and how it is drawn — `f_kit.js::lit()` taken apart so the
 * light can be a shader (T23.13) while the drawing stays the mockup's Canvas2D (`draw.ts`).
 *
 * `lit()` paints, in order: the halo, the contact shadow, a far rim pass, a rim pass, a cool fill pass (each
 * the actor again, offset, in one flat colour — the **rim opts**: accent recoloured, marker/flame/muzzle
 * dropped, as the scene's lambdas do it), then the ink pass. A cell is four images of the actor's box:
 *
 *   under  — halo + shadow, in colour (they do not depend on the light's direction);
 *   mask   — the rim opts' silhouette: R = ink strokes, G = accent strokes, each call adding 64/255 with
 *            `lighter`, so a texel holds the **number** of strokes over it (a translucent pass darkens
 *            where strokes overlap: α = 1 − (1 − a)^n, which a coverage mask cannot give);
 *   ink    — the ink pass exactly as the mockup draws it (`DARK_INK`, the real accent, marker, flame);
 *   extras — only for an actor that has them (`hasExtras`): the fixed-colour parts every pass draws in their own
 *            colours (jet flame, crystal glow, rocket motor, spider eye: `draw.ts::setExtras`), with the rim
 *            opts, **one image per pass, drawn at that pass's offset** (fill, rim, far rim).
 *
 * The shader (`layer.ts`) composites them per pass, sampling the mask at the pass's offset. The silhouette is
 * light-independent, so a cell is redrawn only when the actor's drawing changes (`key`) — except the extras,
 * which are drawn at their offsets rather than resampled: a resampled glow's 8-bit rounding lands on other
 * pixels than the mockup's re-drawn one (measured, F4's crystals: mean ΔE 1.24 on their box resampled). So an
 * actor with extras keys on its pass offsets too (1/8 px), and redraws when its key light turns.
 */
import type { Actor, ActorOpts, Box } from '../scene'
import * as D from './draw'

/** `f_kit.js::DARK_INK` — the ink pass's colour. */
export const DARK_INK = '#07060a'
/** One stroke in the mask adds this much to its channel (four overlapping strokes fill it). */
export const MASK_STEP = 64
/** Px of clear border round each image, so a sample offset past the box reads nothing. */
export const CELL_PAD = 2
/** `lit()`'s contact shadow radius and halo radius, per unit of `size`. */
const SHADOW_R = 11
const HALO_R = 30

export type Role = 'under' | 'mask' | 'ink' | 'extras'

/** The three pass offsets (px): fill, rim, far rim — the order of the extras images. */
export type PassOffsets = [[number, number], [number, number], [number, number]]

/** Does `a` draw anything in a fixed colour in its rim and fill passes (`draw.ts`'s `extras` sites)? */
export function hasExtras(a: Actor): boolean {
  if (!a.lit) return false
  return (a.kind === 'stick' && !!a.opts.jet) || a.kind === 'crystals' || a.kind === 'rocket' || a.kind === 'spider'
}

/** The scene lambdas' rim-pass options (`f_scene.js` / `variant_F4.js`: `rc ? … : …`). */
function rimOpts(a: Actor, accent: string): ActorOpts {
  const o = a.opts
  switch (a.kind) {
    case 'stick': {
      const r: ActorOpts = { ...o, accent, marker: false }
      delete r.flame
      return r
    }
    case 'turret':
      return { ...o, muzzle: false }
    case 'gate':
      return { ...o, accent: 'rgba(0,0,0,0)', inner: 'rgba(0,0,0,0)' }
    default:
      return o
  }
}

/** One `e_style.js` call for `a` with `o`, drawn at (x, y). */
function drawKind(g: D.G, a: Actor, o: ActorOpts, x: number, y: number): void {
  switch (a.kind) {
    case 'stick':
      D.stick(g, x, y, { ...o, flame: o.flame ?? null })
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
  if (a.lit?.halo) {
    const hy = a.y - 14 * size
    const r = HALO_R * size
    b = [Math.min(b[0], a.x - r), Math.min(b[1], hy - r), Math.max(b[2], a.x + r), Math.max(b[3], hy + r)]
  }
  if (a.lit?.shadow) b = [Math.min(b[0], a.x - SHADOW_R * size), b[1], Math.max(b[2], a.x + SHADOW_R * size), b[3]]
  return b
}

/**
 * Everything the drawing depends on — and nothing the light does. The sub-pixel phase of the anchor is part
 * of it (at 1/8 px): the drawing is rasterised at that phase, the quad placed at whole px.
 */
export function cellKey(a: Actor, offs: PassOffsets | null): string {
  const r = actorRect(a)
  const q = (v: number): number => Math.round(v * 8) / 8
  const extra = hasExtras(a) && offs ? offs.map(([x, y]) => [q(x), q(y)]) : null
  return JSON.stringify([a.kind, a.opts, a.lit, r[2] - r[0], r[3] - r[1], q(a.x - r[0]), q(a.y - r[1]), extra])
}

/** The offsets an extras image is drawn at: `cellKey`'s 1/8 px, so the key and the drawing agree. */
export function snapOffsets(offs: PassOffsets): PassOffsets {
  const q = (v: number): number => Math.round(v * 8) / 8
  return offs.map(([x, y]) => [q(x), q(y)]) as PassOffsets
}

/** Draw image `role` of `a` into `g`, whose (0, 0) is the cell rect's top-left; an extras image at `off`. */
export function drawRole(g: D.G, a: Actor, role: Role, off: [number, number] = [0, 0]): void {
  const r = actorRect(a)
  const x = a.x - r[0] + (role === 'extras' ? off[0] : 0)
  const y = a.y - r[1] + (role === 'extras' ? off[1] : 0)
  const lit = a.lit
  g.save()
  g.lineCap = 'round'
  g.lineJoin = 'round'
  try {
    if (role === 'under') {
      if (!lit) return
      if (lit.halo) D.glow(g, x, y - 14 * lit.size, HALO_R * lit.size, lit.halo, 0.22)
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
    if (role === 'extras') {
      if (!lit) return
      D.setInk('rgba(0,0,0,0)')
      drawKind(g, a, rimOpts(a, 'rgba(0,0,0,0)'), x, y)
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
