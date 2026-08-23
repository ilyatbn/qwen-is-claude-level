/**
 * Value noise on a wrapping lattice — **one implementation, two callers**.
 *
 * This was private to `procTextures.ts`, which needs a seamless rock tile. T15.03
 * needs the same noise for a mountain ridge that repeats without a seam, and
 * `docs/70` §A24 is explicit that the answer to "I need noise over here too" is
 * to share the function, not to write a second one that agrees with the first
 * until somebody changes one of them.
 *
 * Phaser-free and DOM-free (§A8), so both the tile tests and the sky tests can
 * import it under node.
 */

/** Deterministic hash → 0..1, same shape as the Rust lattice noise. */
export function hash01(x: number, y: number, seed: number): number {
  let h = (x * 374761393 + y * 668265263 + seed * 1274126177) | 0
  h = (h ^ (h >>> 13)) * 1274126177
  h = h ^ (h >>> 16)
  return ((h >>> 0) % 65536) / 65536
}

/**
 * Value noise on a lattice that **wraps** after `cells` steps.
 *
 * The wrap is the whole point. Sampling an unwrapped lattice gives a tile whose
 * left edge does not match its right, and tiling it across the map draws a visible
 * grid — which is exactly what the first preview screenshot showed. The mountain
 * ridge wants it for the same reason: a parallax layer scrolls forever, so its
 * profile has to meet itself.
 */
export function wrappedNoise(
  x: number,
  y: number,
  cells: number,
  size: number,
  seed: number,
): number {
  const fx = (x / size) * cells
  const fy = (y / size) * cells
  const x0 = Math.floor(fx)
  const y0 = Math.floor(fy)
  const tx = fx - x0
  const ty = fy - y0
  const s = (t: number) => t * t * (3 - 2 * t)
  const w = (n: number) => ((n % cells) + cells) % cells

  const a = hash01(w(x0), w(y0), seed)
  const b = hash01(w(x0 + 1), w(y0), seed)
  const c = hash01(w(x0), w(y0 + 1), seed)
  const d = hash01(w(x0 + 1), w(y0 + 1), seed)
  const top = a + (b - a) * s(tx)
  const bot = c + (d - c) * s(tx)
  return top + (bot - top) * s(ty)
}

/**
 * A stable 32-bit seed for one client-side subsystem — **FNV-1a 32**, not Rust's.
 *
 * The tag *scheme* is borrowed from `game_core::rng::substream`: two subsystems
 * seeded from one map seed must not draw the same numbers, which is the whole
 * reason that function exists (`docs/10` §2). The hash is **not** the same one.
 * `rng.rs` uses the 64-bit FNV-1a basis and prime; this uses the 32-bit pair, and
 * `fnv1a64(tag) & 0xFFFFFFFF` is not `fnv1a32(tag)` for any interesting tag.
 *
 * That is deliberate and it is safe only because every caller is **client-side
 * decoration** — a mountain ridge and a cloud scatter, which no server ever sees
 * and no two clients ever have to agree about. Do not reach for this where the
 * client and the server must produce the same numbers: it will disagree, quietly.
 * The name says `client` for that reason.
 */
export function clientTagSeed(seed: number, tag: string): number {
  let h = 0x811c9dc5 >>> 0
  for (let i = 0; i < tag.length; i++) {
    h = (h ^ tag.charCodeAt(i)) >>> 0
    h = Math.imul(h, 0x01000193) >>> 0
  }
  return ((seed | 0) ^ h) | 0
}
