/**
 * Turning `tasks/M21/assets/gate.png` into a usable sprite (T21.12).
 *
 * Pure functions over RGBA, so the interesting part — which pixels become
 * transparent — is testable in node without a canvas or a browser. The script
 * that reads and writes PNGs is `scripts/build-gate-sprite.mjs`.
 *
 * ## Why a flood fill and not a threshold
 *
 * The source is **fully opaque with a white background** — measured: 328 090
 * opaque pixels, zero transparent, zero partial. A global "white becomes
 * transparent" pass is the obvious approach and it is wrong: the stone has white
 * highlights, and a threshold punches holes straight through the ring.
 *
 * A flood fill from the **borders** removes only white that is connected to the
 * outside, so an enclosed highlight survives however bright it is.
 *
 * ## Two fills, not one
 *
 * The ring's interior is also white and must also go, or the portal is a white
 * disc instead of a hole you can see the world through. It is a *separate*
 * region — the stone ring separates it from the background — so it needs its own
 * seed. That is the second fill, and it is where the charge effect is drawn.
 */

/** `true` when a pixel is background-white: bright and not very saturated. */
export function isBackdrop(r, g, b, threshold) {
  const min = Math.min(r, g, b)
  const max = Math.max(r, g, b)
  // Near-grey as well as bright: a saturated pale colour is paint, not paper.
  return min >= threshold && max - min <= 12
}

/**
 * Flood fill transparency from a set of seeds, 4-connected.
 *
 * Returns the number of pixels cleared, so a caller can assert it did something
 * — a fill that matched nothing and a fill that worked are otherwise the same
 * silent success.
 */
export function clearConnected(rgba, w, h, seeds, threshold) {
  const seen = new Uint8Array(w * h)
  const stack = []
  // The bounding box of what this fill cleared. The portal's effect is drawn
  // into it, and **deriving it from the fill is the point**: the fill already
  // knows exactly which pixels are the hole, so a hand-measured centre and
  // radius would be a second answer that drifts the first time the art moves.
  let minX = w
  let minY = h
  let maxX = -1
  let maxY = -1
  for (const [sx, sy] of seeds) {
    if (sx < 0 || sy < 0 || sx >= w || sy >= h) continue
    stack.push(sy * w + sx)
  }
  let cleared = 0
  while (stack.length) {
    const p = stack.pop()
    if (seen[p]) continue
    seen[p] = 1
    const i = p << 2
    if (rgba[i + 3] === 0) continue
    if (!isBackdrop(rgba[i], rgba[i + 1], rgba[i + 2], threshold)) continue
    rgba[i + 3] = 0
    cleared++
    const x = p % w
    const y = (p / w) | 0
    if (x < minX) minX = x
    if (x > maxX) maxX = x
    if (y < minY) minY = y
    if (y > maxY) maxY = y
    if (x > 0) stack.push(p - 1)
    if (x < w - 1) stack.push(p + 1)
    if (y > 0) stack.push(p - w)
    if (y < h - 1) stack.push(p + w)
  }
  return { cleared, box: maxX < 0 ? null : { x0: minX, y0: minY, x1: maxX, y1: maxY } }
}

/** Every border pixel, as fill seeds. */
export function borderSeeds(w, h) {
  const seeds = []
  for (let x = 0; x < w; x++) {
    seeds.push([x, 0], [x, h - 1])
  }
  for (let y = 0; y < h; y++) {
    seeds.push([0, y], [w - 1, y])
  }
  return seeds
}

/**
 * Cut the background and the portal out of an opaque source.
 *
 * `interiorSeed` is where the ring's hole is — the image centre for this art.
 * Returns both counts so the build can report, and a test can assert, that each
 * fill actually removed something.
 */
export function cutBackdrop(rgba, w, h, { threshold = 236, interiorSeed } = {}) {
  const outside = clearConnected(rgba, w, h, borderSeeds(w, h), threshold)
  const seed = interiorSeed ?? [w >> 1, h >> 1]
  const interior = clearConnected(rgba, w, h, [seed], threshold)
  return {
    outside: outside.cleared,
    interior: interior.cleared,
    // Normalised, so it survives the downscale that happens after this — a box
    // in source pixels would be wrong by the scale factor at the one place it
    // is used.
    portal: interior.box && {
      cx: (interior.box.x0 + interior.box.x1 + 1) / 2 / w,
      cy: (interior.box.y0 + interior.box.y1 + 1) / 2 / h,
      rx: (interior.box.x1 - interior.box.x0 + 1) / 2 / w,
      ry: (interior.box.y1 - interior.box.y0 + 1) / 2 / h,
    },
  }
}

/**
 * Premultiplied box downscale.
 *
 * The same filter `build-atlas.mjs` uses, and premultiplied for the same reason
 * its comment gives: without it, transparent black drags every soft edge toward
 * black — which here would leave a dark halo around the whole gate.
 */
export function downscaleRgba(rgba, w, h, dstW, dstH) {
  const out = new Uint8Array(dstW * dstH * 4)
  const sx = w / dstW
  const sy = h / dstH
  for (let y = 0; y < dstH; y++) {
    for (let x = 0; x < dstW; x++) {
      let r = 0
      let g = 0
      let b = 0
      let a = 0
      let n = 0
      const x0 = Math.floor(x * sx)
      const x1 = Math.min(w, Math.ceil((x + 1) * sx))
      const y0 = Math.floor(y * sy)
      const y1 = Math.min(h, Math.ceil((y + 1) * sy))
      for (let yy = y0; yy < y1; yy++) {
        for (let xx = x0; xx < x1; xx++) {
          const i = (w * yy + xx) << 2
          const av = rgba[i + 3] / 255
          r += rgba[i] * av
          g += rgba[i + 1] * av
          b += rgba[i + 2] * av
          a += rgba[i + 3]
          n++
        }
      }
      const o = (dstW * y + x) << 2
      const alpha = a / n
      const un = alpha > 0 ? 255 / alpha : 0
      out[o] = Math.min(255, Math.round((r / n) * un))
      out[o + 1] = Math.min(255, Math.round((g / n) * un))
      out[o + 2] = Math.min(255, Math.round((b / n) * un))
      out[o + 3] = Math.round(alpha)
    }
  }
  return out
}

/**
 * Does a portal region look like the hole in a ring, rather than some other
 * enclosed white the fill happened to find?
 *
 * **A pure function so it can be exercised.** It started life inline in
 * `build-gate-sprite.mjs`, where the only reachable failure on the shipped art
 * is `interior === 0` — so the shape check could never run and was decoration
 * with a comment. Here it takes both a good region and a bad one in a test.
 *
 * Two properties, and neither is arbitrary: the hole is a large fraction of the
 * sprite (a rune or a highlight is not), and it is horizontally centred (the
 * arch is symmetric, so a fill that escaped sideways or seeded the wrong region
 * shows up as an off-centre box).
 */
export function portalLooksLikeARing(portal, { minRadius = 0.15, maxOffCentre = 0.12 } = {}) {
  if (!portal) return { ok: false, why: 'no region at all' }
  if (portal.rx < minRadius || portal.ry < minRadius) {
    return {
      ok: false,
      why: `too small to be the ring (rx ${portal.rx.toFixed(3)}, ry ${portal.ry.toFixed(3)}, ` +
        `min ${minRadius}) — the interior seed is probably not in the hole`,
    }
  }
  if (Math.abs(portal.cx - 0.5) > maxOffCentre) {
    return {
      ok: false,
      why: `off-centre (cx ${portal.cx.toFixed(3)}) — the fill escaped the ring or ` +
        `seeded the wrong region`,
    }
  }
  return { ok: true, why: '' }
}

/** Alpha statistics, for the build's report and the tests' assertions. */
export function alphaStats(rgba) {
  let clear = 0
  let opaque = 0
  let partial = 0
  for (let i = 3; i < rgba.length; i += 4) {
    const a = rgba[i]
    if (a === 0) clear++
    else if (a === 255) opaque++
    else partial++
  }
  return { clear, opaque, partial }
}
