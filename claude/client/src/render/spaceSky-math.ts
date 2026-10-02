/**
 * T22.06 — the pure half of the space backdrop: where the sun, the earth, the moon
 * and the stars are at a moment of the round, and what the planets look like.
 *
 * The owner's sentence: *"there's no day/light in space but the sun and moon and the
 * earth and stars can be the background and should move."* So **movement is the
 * feature**, and it has its own driver here, decoupled from the day cycle: the
 * ground sky's `bodyPositions` never shows the sun and the moon together and stops
 * them both when `cycleU` stops, and its `starAlpha` is zero whenever darkness is —
 * which space pins at zero (`sceneDarkness`). Nothing here reads either.
 *
 * Everything is a function of **the map seed and the round's clock**, so a seed looks
 * like itself and two players in one round see one sky. Phaser-free (§A8).
 */

import { clientTagSeed, hash01, wrappedNoise } from './noise-math'

/** The space backdrop's tunables, a subset of `C()` (`constants.rs` has the bases). */
export interface SpaceSkyTuning {
  SPACE_SUN_PATH_RX: number
  SPACE_SUN_PATH_RY: number
  SPACE_EARTH_PATH_RX: number
  SPACE_EARTH_PATH_RY: number
  SPACE_EARTH_PERIOD: number
  SPACE_SUN_PERIOD: number
  SPACE_MOON_PERIOD: number
  SPACE_MOON_ORBIT: number
  SPACE_MOON_TILT: number
  SPACE_STAR_DRIFT: number
}

/** The gradient behind everything: black overhead, a faint blue toward the bottom. */
export const SPACE_SKY_TOP = 0x010208
export const SPACE_SKY_BOTTOM = 0x0a1030

/**
 * The centres of the paths across the view, as fractions of it. **Composition, not
 * tuning** — like `sky-math.ts`'s gradient keyframes they say where on the screen a
 * thing belongs (the sun high, the earth low and large). The half-extents are
 * `SPACE_*_PATH_RX/RY` in `constants.rs` (T22.06B F5): with the periods beside them
 * they are the bodies' speed, which is a tunable.
 */
const SUN_PATH = { cx: 0.5, cy: 0.24 }
const EARTH_PATH = { cx: 0.5, cy: 0.66 }

/** Per-seed phases, so each map's sky starts from its own arrangement. */
export interface SpaceSkySeed {
  sun: number
  earth: number
  moon: number
}

export function spaceSkySeed(seed: number): SpaceSkySeed {
  const turn = (tag: string) => hash01(1, 2, clientTagSeed(seed, tag)) * Math.PI * 2
  return { sun: turn('space-sun'), earth: turn('space-earth'), moon: turn('space-moon') }
}

export interface SpaceBodies {
  /** Fractions of the visible view, for the sun and the earth; camera px offsets for the moon. */
  sun: { fx: number; fy: number }
  earth: { fx: number; fy: number }
  /** Camera px from the earth's centre, and whether it is on the near side of its orbit. */
  moon: { dx: number; dy: number; front: boolean }
  /** Radians, the direction from the earth toward the sun: where its lit side faces. */
  sunward: number
}

/**
 * Where the bodies are at round time `t` — sun and earth on their own slow ellipses
 * across the view, the moon on a tilted ring around the earth.
 *
 * The earth starts opposite the sun on its path (`+ π`), so a round opens with the
 * two apart; their periods differ, so over a long round the sun can pass behind the
 * planet, which is an eclipse and reads as one.
 */
export function spaceBodies(
  t: number,
  s: SpaceSkySeed,
  c: SpaceSkyTuning,
  viewW: number,
  viewH: number,
): SpaceBodies {
  const TAU = Math.PI * 2
  const as = s.sun + (TAU * t) / c.SPACE_SUN_PERIOD
  const ae = s.earth + Math.PI + (TAU * t) / c.SPACE_EARTH_PERIOD
  const am = s.moon + (TAU * t) / c.SPACE_MOON_PERIOD
  const sun = { fx: SUN_PATH.cx + c.SPACE_SUN_PATH_RX * Math.cos(as), fy: SUN_PATH.cy + c.SPACE_SUN_PATH_RY * Math.sin(as) }
  const earth = {
    fx: EARTH_PATH.cx + c.SPACE_EARTH_PATH_RX * Math.cos(ae),
    fy: EARTH_PATH.cy + c.SPACE_EARTH_PATH_RY * Math.sin(ae),
  }
  const moon = {
    dx: c.SPACE_MOON_ORBIT * Math.cos(am),
    dy: c.SPACE_MOON_ORBIT * c.SPACE_MOON_TILT * Math.sin(am),
    front: Math.sin(am) > 0,
  }
  // In camera px, not in fractions: the view is wider than it is tall.
  const sunward = Math.atan2((sun.fy - earth.fy) * viewH, (sun.fx - earth.fx) * viewW)
  return { sun, earth, moon, sunward }
}

/**
 * T23.20 — **F3's composition** for the same motion. In the new look the earth is F3's giant stepped planet arc and
 * the moon its smaller arc (`look/space.ts`), so a body's place is its arc's **apex** (the top of its limb) and the
 * sun is F3's distant star. Each body keeps T22.06's path, speed and phase (`spaceBodies`); only the path's centre
 * moves to where F3 draws it — composition, as `SUN_PATH`/`EARTH_PATH` are: the star high and left of centre, the
 * planet's limb high on the right with the planet filling the lower right, the moon circling a place down and
 * left of the planet (`F3_MOON_FROM_EARTH`) (`variant_F3.js`: star (150, 60), planet apex (980, 130), moon apex (240, 330)).
 */
export const F3_SUN_PATH = { cx: 0.45, cy: 0.17 }
export const F3_EARTH_PATH = { cx: 0.6, cy: 0.2 }
/**
 * The moon's apex from the planet's, frame px — the centre the moon's T22.06 orbit circles in the new look. F3 draws
 * it at (240 − 980, 330 − 130) = (−740, +200) for one still; with the planet swinging ±`SPACE_EARTH_PATH_RX` of the
 * frame and the orbit ±`SPACE_MOON_ORBIT` on top, that put the moon off the left edge most of a round (measured in
 * `space-sky`: off screen at the second moment). Moved in to (−460, +210): F3's side and drop, on screen most of the time.
 */
export const F3_MOON_FROM_EARTH: readonly [number, number] = [-460, 210]

/** Where each body is drawn this frame in the new look, frame px (the sun's centre, each arc's apex). */
export interface SpaceScreen {
  sun: [number, number]
  earth: [number, number]
  /** Always drawn in front of the planet: the new look composites the moon's arc after the planet's (T22.06's `front` is not drawn). */
  moon: [number, number]
}

/**
 * `spaceBodies` in F3's composition, on a `frameW × frameH` frame at camera `zoom`, every body moved by `pan` (frame
 * px: the camera's distance from the map's centre × zoom × −`SPACE_BODY_PARALLAX`, which the scene supplies — T22.06's
 * parallax, unchanged). The moon's orbit is in camera px, so it is scaled by the zoom like everything else.
 */
export function spaceScreen(b: SpaceBodies, frameW: number, frameH: number, zoom: number, pan: [number, number]): SpaceScreen {
  const at = (fx: number, fy: number, c: { cx: number; cy: number }, p: { cx: number; cy: number }): [number, number] => [
    (fx - p.cx + c.cx) * frameW + pan[0],
    (fy - p.cy + c.cy) * frameH + pan[1],
  ]
  const sun = at(b.sun.fx, b.sun.fy, F3_SUN_PATH, SUN_PATH)
  const earth = at(b.earth.fx, b.earth.fy, F3_EARTH_PATH, EARTH_PATH)
  const moon: [number, number] = [earth[0] + F3_MOON_FROM_EARTH[0] + b.moon.dx * zoom, earth[1] + F3_MOON_FROM_EARTH[1] + b.moon.dy * zoom]
  return { sun, earth, moon }
}

export interface SpaceStar {
  /** `0..1` of the field. */
  u: number
  v: number
  /** Base brightness. */
  b: number
  /** Packed RGB: most white, some blue, a few warm. */
  color: number
  /** Twinkle phase. */
  phase: number
  /** 1 or 2 px: a handful of bright stars read as nearer than the dust. */
  size: number
}

/** A seeded star field over the unit square. */
export function spaceStars(seed: number, count: number): SpaceStar[] {
  let h = clientTagSeed(seed, 'space-stars') >>> 0 || 0x5eed
  const rnd = () => {
    h ^= h << 13
    h >>>= 0
    h ^= h >> 17
    h ^= h << 5
    h >>>= 0
    return h / 0x100000000
  }
  const out: SpaceStar[] = []
  for (let i = 0; i < count; i++) {
    const tint = rnd()
    out.push({
      u: rnd(),
      v: rnd(),
      b: 0.3 + 0.7 * rnd() * rnd(),
      color: tint < 0.72 ? 0xffffff : tint < 0.9 ? 0xbcd4ff : 0xffe2b0,
      phase: rnd() * Math.PI * 2,
      size: rnd() < 0.06 ? 2 : 1,
    })
  }
  return out
}

/** `a mod m` into `[0, m)`. */
function wrap(a: number, m: number): number {
  return ((a % m) + m) % m
}

/**
 * One star's place in the view at round time `t`, camera px from the view's corner.
 *
 * The field drifts left at `SPACE_STAR_DRIFT` and shifts by the camera's scroll times
 * `parallax`, both wrapped into the view: stars are laid out in camera space, so they
 * cover any camera position with no field larger than the screen. `scrollX`/`scrollY`
 * must be the camera's **live** scroll — the `living-sky` trap is reading last frame's.
 */
export function starAt(
  s: SpaceStar,
  t: number,
  drift: number,
  scrollX: number,
  scrollY: number,
  parallax: number,
  viewW: number,
  viewH: number,
): { x: number; y: number; a: number } {
  return {
    x: wrap(s.u * viewW - drift * t - scrollX * parallax, viewW),
    y: wrap(s.v * viewH - scrollY * parallax, viewH),
    // Twinkle on the round's clock, not the browser's: a frozen round is a frozen sky.
    a: s.b * (0.72 + 0.28 * Math.sin(t * 1.9 + s.phase)),
  }
}

/** RGBA pixels for a disc of radius `r`, drawn by `shade(nx, ny)` with `nx, ny` in `-1..1`. */
function disc(r: number, shade: (nx: number, ny: number) => [number, number, number, number]): Uint8ClampedArray {
  const size = Math.ceil(r * 2)
  const out = new Uint8ClampedArray(size * size * 4)
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const nx = (x + 0.5 - r) / r
      const ny = (y + 0.5 - r) / r
      if (nx * nx + ny * ny > 1) continue
      const [cr, cg, cb, ca] = shade(nx, ny)
      const i = (y * size + x) * 4
      out[i] = cr
      out[i + 1] = cg
      out[i + 2] = cb
      out[i + 3] = ca
    }
  }
  return out
}

/** Limb darkening: a sphere is dimmer at its edge than at its middle. */
function limb(nx: number, ny: number): number {
  return 0.62 + 0.38 * Math.sqrt(Math.max(0, 1 - nx * nx - ny * ny))
}

/**
 * The earth: ocean, seeded continents, ice caps and cloud, `2r × 2r` RGBA.
 *
 * Unlit — the terminator is `shadowPixels`, rotated each frame to face away from the
 * sun, so this is baked once per seed and never again.
 */
export function earthPixels(seed: number, r: number): Uint8ClampedArray {
  const land = clientTagSeed(seed, 'earth-land')
  const cloud = clientTagSeed(seed, 'earth-cloud')
  const fbm = (x: number, y: number, s: number) =>
    wrappedNoise(x, y, 4, 2, s) * 0.6 + wrappedNoise(x, y, 8, 2, s + 17) * 0.3 + wrappedNoise(x, y, 16, 2, s + 31) * 0.1
  return disc(r, (nx, ny) => {
    const k = limb(nx, ny)
    // Sampled on the sphere's surface rather than the flat disc, so continents
    // bunch up toward the limb the way a globe's do.
    const z = Math.sqrt(Math.max(0, 1 - nx * nx - ny * ny))
    const sx = 1 + nx / (1 + z * 0.6)
    const sy = 1 + ny / (1 + z * 0.6)
    let c: [number, number, number] = [0x1f, 0x5f, 0xb8]
    const h = fbm(sx, sy, land)
    if (h > 0.56) c = h > 0.66 ? [0x9c, 0x8a, 0x55] : [0x3f, 0x8f, 0x4a]
    if (Math.abs(ny) > 0.84) c = [0xe8, 0xf0, 0xff]
    if (fbm(sx + 0.37, sy * 1.6, cloud) > 0.6) c = [0xf4, 0xf7, 0xff]
    return [c[0] * k, c[1] * k, c[2] * k, 255]
  })
}

/** The moon: grey, pocked with seeded craters, `2r × 2r` RGBA. */
export function moonPixels(seed: number, r: number): Uint8ClampedArray {
  const s = clientTagSeed(seed, 'moon')
  return disc(r, (nx, ny) => {
    const k = limb(nx, ny)
    const n = wrappedNoise(1 + nx, 1 + ny, 6, 2, s)
    const g = n > 0.62 ? 0x8a : n < 0.3 ? 0xb4 : 0xc6
    return [g * k, g * k, (g + 8) * k, 255]
  })
}

/**
 * The night side: a disc of radius `r` whose **left** half is dark, with a soft
 * terminator. Drawn over a planet and rotated by `sunward`, it lights the half that
 * faces the sun. `2r × 2r` RGBA.
 */
export function shadowPixels(r: number, darkest: number): Uint8ClampedArray {
  return disc(r, (nx) => {
    const t = Math.max(0, Math.min(1, (0.25 - nx) / 0.5))
    return [2, 4, 12, 255 * darkest * t * t * (3 - 2 * t)]
  })
}
