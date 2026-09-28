/**
 * T23.03: the arithmetic of the world renderer, apart from three.js so it can be tested.
 *
 * The world space is the mockup's (`mockup-src/kit.js::orthoCam` / `wy`): mask px, x right,
 * **y up**, world y = `H − maskY` where `H` is the mask's height. Phaser's camera and the
 * scene description are y down; this is the one place the flip happens.
 */
import type { Light, ViewRect } from './scene'

/** R14: the full tier is the pictures; the low tier renders the world canvas and its target at half resolution without MSAA (the mockup's `scale 2`). */
export type QualityTier = 'full' | 'low'

/** The world canvas's drawing buffer (and so its post target) as a fraction of the display, per tier. */
export const TIER_SCALE: Record<QualityTier, number> = { full: 1, low: 0.5 }
/** MSAA samples on the half-float target, per tier (`kit.js::post`: `samples: scale === 1 ? 4 : 0`). */
export const TIER_SAMPLES: Record<QualityTier, number> = { full: 4, low: 0 }

export interface OrthoBounds {
  left: number
  right: number
  top: number
  bottom: number
}

/** The ortho camera that shows `view` (y down) of a mask `maskH` rows tall, in y-up world space. */
export function orthoFromView(view: ViewRect, maskH: number): OrthoBounds {
  return { left: view.x, right: view.x + view.w, top: maskH - view.y, bottom: maskH - (view.y + view.h) }
}

/** A mask-px point (y down) in world space (y up): `kit.js::wy`. */
export function toWorld(x: number, y: number, maskH: number): { x: number; y: number } {
  return { x, y: maskH - y }
}

/**
 * T23.03B / R18: the world canvas's drawing buffer — **Phaser's game resolution** (`gameW × gameH`,
 * the size of Phaser's own drawing buffer) times the tier's scale, at least 1. Never the CSS box
 * times `devicePixelRatio`: the pictures are drawn at `setPixelRatio(1)` on 1280×720, so an effect
 * sized in buffer px (bloom radius, MSAA, blur taps) only matches them at this size. Equivalently
 * R18's pixel ratio `gameW / cssW × TIER_SCALE` on a canvas shown `cssW` wide — computed as the
 * buffer itself, so a fractional CSS width cannot floor 1280 to 1279.
 */
export function bufferFor(gameW: number, gameH: number, tier: QualityTier): { w: number; h: number } {
  const k = TIER_SCALE[tier]
  return { w: Math.max(1, Math.round(gameW * k)), h: Math.max(1, Math.round(gameH * k)) }
}

/**
 * T23.03B (F1): the one definition of "the same view". The redraw skip uses it, and
 * `world-canvas` asserts every frame that Phaser's `worldView` and the view last drawn pass it —
 * a skip that forgot one field (the review planted `y`) then shows as a frame where they differ.
 */
export function sameView(a: ViewRect | null, b: ViewRect | null): boolean {
  return a !== null && b !== null && a.x === b.x && a.y === b.y && a.w === b.w && a.h === b.h
}

/**
 * T23.03B (F3): must this frame be drawn? An unchanged view of an unchanged, **unanimated**
 * scene is an unchanged picture, and the canvas keeps showing the last one (measured: drawing
 * every frame cost SwiftShader 60 → 51 fps in a match). Anything animated — T23.04's stars —
 * draws every frame, or it freezes.
 */
export function mustDraw(s: { dirty: boolean; animated: boolean; last: ViewRect | null; view: ViewRect }): boolean {
  return s.dirty || s.animated || !sameView(s.last, s.view)
}

/** `0xRRGGBB` read as **linear** components, the way `e_style.js::hex` does (`setHex(h, LinearSRGBColorSpace)`). */
export function hexLinear(h: number): [number, number, number] {
  return [((h >> 16) & 255) / 255, ((h >> 8) & 255) / 255, (h & 255) / 255]
}

/**
 * T23.09A (owner, 2026-09-27, ruling pending): whether the game draws the lit terrain's **cave wall** (the
 * `back` branch: generator landform + R24's fade). Off by default in matches and the sandbox — carved and
 * cave air shows what is behind the rock, like open air — so the owner can judge the look without it;
 * `?cavewall=1` (or the sandbox's "Cave bg" button) turns it back on. The look-lab always draws F1's walls
 * (Level A): a known lab/game difference until the owner rules.
 */
export const CAVE_WALL_DEFAULT = false

/** `?cavewall=1|0` on the page's URL, else `CAVE_WALL_DEFAULT`. */
export function caveWallFromUrl(search: string): boolean {
  const v = new URLSearchParams(search).get('cavewall')
  return v === null ? CAVE_WALL_DEFAULT : v === '1' || v === 'true' || v === 'on'
}

/**
 * T23.11 (dev): `&hour=<t>[,<u>]` pins the hour the world renderer draws — the palettes' blend at `t` (0 moonlit day,
 * 1 night) and the moons at cycle position `u` (absent: the pictures' places) — whatever the scene's clock says. The
 * browser checks calibrated on a still F1 sky (every one before T23.11: F1's look at every hour, nothing in the sky
 * moving) name `&hour=1`; the scene's darkness, and so its night view, still follows its own clock. `null`: not pinned.
 */
export function hourFromUrl(search: string): { t: number; u: number | null } | null {
  const v = new URLSearchParams(search).get('hour')
  if (v === null) return null
  const [t, u] = v.split(',').map(Number)
  if (!(t !== undefined && t >= 0 && t <= 1)) return null
  return { t, u: u !== undefined && Number.isFinite(u) ? u : null }
}

/**
 * T23.10 (R7): the night view a scene hands the world renderer — its `darkness` (0 … `NIGHT_DARKNESS`, the server's
 * byte; 0 in space) and the circles its player sees in (world px: centre and `fovRadius`), and the share of each
 * radius that is the soft edge (`FOV_EDGE_SOFTNESS`, the lightmap's).
 */
export interface NightView {
  darkness: number
  nightDarkness: number
  soft: number
  circles: readonly { x: number; y: number; r: number }[]
}

/**
 * How much of the scene's light is kept outside sight at full night. F1 is night everywhere, lit only by its moon and
 * effects; this is what "outside your sight" adds: the rock, sky and figures there at under a third of their light, a
 * blast still bright. Stated against the retired lightmap's MULTIPLY at `NIGHT_DARKNESS` 0.82 over `0x000818` (kept
 * 18 % of the light, as black): here 30 % is kept and the rest goes to the night palette, not to black.
 */
export const NIGHT_VIEW_KEEP = 0.3
/**
 * Where the dark goes: a tint of F1's darkest sky (`P.bg.skyTop`, 0x080a12, read linear as the mockup reads it) at
 * `NIGHT_VIEW_TINT` of its strength. At full strength it is brighter than F1's night rock before the tone map (the
 * first run: the rock outside sight came out *brighter*, 18.8 → 33.6), so the fade would lift the dark instead of
 * deepening it; at 15 % it tints the fade blue without lighting anything.
 */
export const NIGHT_VIEW_TINT = 0.15
export const NIGHT_VIEW_FLOOR: [number, number, number] = hexLinear(0x080a12).map((v) => v * NIGHT_VIEW_TINT) as [number, number, number]

/**
 * The night view's uniforms for a frame drawn of `view` (world px) into a `buf`-sized drawing buffer. Null: none.
 * **Lit by effect lights** (R7): after the sight circles, the frame's effect lights (`lights`, the brightest first, as
 * many as fit `maxCircles`) each see their own radius, fading over the whole of it — a blast, a burning vent, a gate
 * lights what is round it out there in the dark, as F1's lights do.
 */
export function nightUniforms(
  v: NightView | null,
  view: ViewRect,
  buf: { w: number; h: number },
  lights: readonly Light[] = [],
  maxCircles = Infinity,
): { k: number; floor: [number, number, number]; circles: { x: number; y: number; inner: number; outer: number }[] } | null {
  if (!v || !(v.nightDarkness > 0)) return null
  const t = Math.max(0, Math.min(1, v.darkness / v.nightDarkness))
  const k = (1 - NIGHT_VIEW_KEEP) * t
  if (!(k > 0)) return null
  const sx = buf.w / view.w
  const sy = buf.h / view.h
  const at = (x: number, y: number, inner: number, outer: number): { x: number; y: number; inner: number; outer: number } => ({
    x: (x - view.x) * sx,
    // gl_FragCoord runs bottom up.
    y: buf.h - (y - view.y) * sy,
    inner: inner * sx,
    outer: outer * sx,
  })
  const circles = v.circles.map((c) => at(c.x, c.y, c.r * (1 - v.soft), c.r))
  const lit = [...lights].filter((l) => l.i > 0 && l.r > 0).sort((a, b) => b.i - a.i)
  for (const l of lit) {
    if (circles.length >= maxCircles) break
    circles.push(at(l.x, l.y, 0, l.r))
  }
  return { k, floor: NIGHT_VIEW_FLOOR, circles: circles.slice(0, maxCircles) }
}
