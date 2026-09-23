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
 * The paths across the view, as fractions of it: centre and half-extents of an
 * ellipse. **Composition, not tuning** — like `sky-math.ts`'s gradient keyframes they
 * say where on the screen a thing belongs (the sun high, the earth low and large), and
 * `constants.rs` keeps what a player would tune: sizes, periods, drift, parallax.
 */
const SUN_PATH = { cx: 0.5, cy: 0.24, rx: 0.36, ry: 0.1 }
const EARTH_PATH = { cx: 0.5, cy: 0.66, rx: 0.28, ry: 0.08 }

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
  const sun = { fx: SUN_PATH.cx + SUN_PATH.rx * Math.cos(as), fy: SUN_PATH.cy + SUN_PATH.ry * Math.sin(as) }
  const earth = { fx: EARTH_PATH.cx + EARTH_PATH.rx * Math.cos(ae), fy: EARTH_PATH.cy + EARTH_PATH.ry * Math.sin(ae) }
  const moon = {
    dx: c.SPACE_MOON_ORBIT * Math.cos(am),
    dy: c.SPACE_MOON_ORBIT * c.SPACE_MOON_TILT * Math.sin(am),
    front: Math.sin(am) > 0,
  }
  // In camera px, not in fractions: the view is wider than it is tall.
  const sunward = Math.atan2((sun.fy - earth.fy) * viewH, (sun.fx - earth.fx) * viewW)
  return { sun, earth, moon, sunward }
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
