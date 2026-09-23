// The shared "map": a per-pixel solid mask (exactly what the sim owns), plus
// everything a renderer can DERIVE from it without changing it: distance fields,
// surface orientation, and a painted albedo. Nothing here feeds back into the mask.
export const W = 1280, H = 720

// ---------- noise ----------
function hash(x, y, s) {
  let h = (x * 374761393 + y * 668265263 + s * 144665) | 0
  h = Math.imul(h ^ (h >>> 13), 1274126177)
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296
}
export function vnoise(x, y, s = 0) {
  const xi = Math.floor(x), yi = Math.floor(y), xf = x - xi, yf = y - yi
  const u = xf * xf * (3 - 2 * xf), v = yf * yf * (3 - 2 * yf)
  const a = hash(xi, yi, s), b = hash(xi + 1, yi, s), c = hash(xi, yi + 1, s), d = hash(xi + 1, yi + 1, s)
  return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v
}
export function fbm(x, y, oct = 5, s = 0) {
  let t = 0, a = 0.5, f = 1, n = 0
  for (let i = 0; i < oct; i++) { t += a * vnoise(x * f, y * f, s + i * 17); n += a; a *= 0.5; f *= 2.03 }
  return t / n
}
export function cell2(x, y, s = 0) { // worley F1, F2, and the id of the F1 site
  const xi = Math.floor(x), yi = Math.floor(y); let f1 = 9, f2 = 9, id = 0
  for (let j = -1; j <= 1; j++) for (let i = -1; i <= 1; i++) {
    const px = xi + i + hash(xi + i, yi + j, s), py = yi + j + hash(xi + i, yi + j, s + 9)
    const d = Math.sqrt((px - x) ** 2 + (py - y) ** 2)
    if (d < f1) { f2 = f1; f1 = d; id = hash(xi + i, yi + j, s + 5) } else if (d < f2) f2 = d
  }
  return [f1, f2, id]
}
export function cell(x, y, s = 0) { // worley F1
  const xi = Math.floor(x), yi = Math.floor(y); let best = 9
  for (let j = -1; j <= 1; j++) for (let i = -1; i <= 1; i++) {
    const px = xi + i + hash(xi + i, yi + j, s), py = yi + j + hash(xi + i, yi + j, s + 9)
    const d = (px - x) ** 2 + (py - y) ** 2; if (d < best) best = d
  }
  return Math.sqrt(best)
}

// ---------- mask ----------
function profile(x, pts) {
  for (let i = 0; i < pts.length - 1; i++) {
    const [x0, y0] = pts[i], [x1, y1] = pts[i + 1]
    if (x >= x0 && x <= x1) { const t = (x - x0) / (x1 - x0); const s = t * t * (3 - 2 * t); return y0 + (y1 - y0) * s }
  }
  return pts[pts.length - 1][1]
}

/**
 * spec: { ground: [[x,y]...], blobs: [{x,y,rx,ry,noise}], carve: [{x,y,r}|{tunnel:[[x,y]...],r}], scorch: [{x,y,r}] }
 */
export function buildMask(spec) {
  const solid = new Uint8Array(W * H), back = new Uint8Array(W * H)
  const inCarve = (x, y) => {
    for (const c of spec.carve || []) {
      if (c.tunnel) {
        for (let i = 0; i < c.tunnel.length - 1; i++) {
          const [ax, ay] = c.tunnel[i], [bx, by] = c.tunnel[i + 1]
          const dx = bx - ax, dy = by - ay; const t = Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / (dx * dx + dy * dy)))
          const r = c.r + (fbm(x * 0.05, y * 0.05, 2, 31) - 0.5) * 10
          if ((x - ax - dx * t) ** 2 + (y - ay - dy * t) ** 2 < r * r) return true
        }
      } else {
        const r = c.r + (fbm(x * 0.06, y * 0.06, 2, 41) - 0.5) * 8
        if ((x - c.x) ** 2 + (y - c.y) ** 2 < r * r) return true
      }
    }
    return false
  }
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    let s = false
    if (spec.ground) {
      const gy = profile(x, spec.ground) + (fbm(x * 0.012, 3.1, 4, 5) - 0.5) * 46 + (fbm(x * 0.06, y * 0.02, 3, 6) - 0.5) * 14
      s = y > gy
    }
    if (spec.rim) { const R = spec.rim; const e = ((x - R.cx) / R.rx) ** 2 + ((y - R.cy) / R.ry) ** 2; if (e > 1 + (fbm(x * 0.01, y * 0.01, 4, 8) - 0.5) * 0.12) s = true }
    for (const b of spec.blobs || []) {
      const nx = (x - b.x) / b.rx, ny = (y - b.y) / b.ry
      const ang = Math.atan2(ny, nx)
      const rr = 1 + (fbm(Math.cos(ang) * 1.6 + b.x, Math.sin(ang) * 1.6 + b.y, 4, 7) - 0.5) * (b.noise ?? 0.7)
      let e = nx * nx + ny * ny
      if (b.flatTop && ny < -0.35) e = nx * nx + (ny * 0.35 / -ny) ** 2 + (ny + 0.35) ** 2 * 0.2 // flat-ish top
      if (e < rr * rr) s = true
    }
    if (s && inCarve(x, y)) { s = false; back[y * W + x] = 1 }
    solid[y * W + x] = s ? 1 : 0
  }
  return { solid, back, spec }
}

// ---------- exact euclidean distance transform (Felzenszwalb) ----------
function edt1d(f, n, d, v, z) {
  let k = 0; v[0] = 0; z[0] = -1e20; z[1] = 1e20
  for (let q = 1; q < n; q++) {
    let s = ((f[q] + q * q) - (f[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k])
    while (s <= z[k]) { k--; s = ((f[q] + q * q) - (f[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k]) }
    k++; v[k] = q; z[k] = s; z[k + 1] = 1e20
  }
  k = 0
  for (let q = 0; q < n; q++) { while (z[k + 1] < q) k++; d[q] = (q - v[k]) ** 2 + f[v[k]] }
}
/** distance (px) from each pixel where pred is true to the nearest pixel where it is false */
export function edt(pred) {
  const INF = 1e10, g = new Float64Array(W * H)
  for (let i = 0; i < W * H; i++) g[i] = pred(i) ? INF : 0
  const n = Math.max(W, H), f = new Float64Array(n), d = new Float64Array(n), v = new Int32Array(n), z = new Float64Array(n + 1)
  for (let x = 0; x < W; x++) { for (let y = 0; y < H; y++) f[y] = g[y * W + x]; edt1d(f, H, d, v, z); for (let y = 0; y < H; y++) g[y * W + x] = d[y] }
  for (let y = 0; y < H; y++) { for (let x = 0; x < W; x++) f[x] = g[y * W + x]; edt1d(f, W, d, v, z); for (let x = 0; x < W; x++) g[y * W + x] = d[x] }
  const out = new Float32Array(W * H); for (let i = 0; i < W * H; i++) out[i] = Math.sqrt(g[i]); return out
}

// ---------- palette themes ----------
export const THEMES = {
  meadow: {
    grass: [[86, 140, 52], [124, 170, 60]], soil: [[92, 62, 40], [70, 46, 32]],
    rock: [[122, 106, 90], [106, 94, 84], [134, 118, 98], [98, 88, 80]], pebble: [150, 138, 120],
    back: [[58, 50, 46], [44, 38, 36]], scorch: [26, 20, 18],
  },
  dusk: {
    grass: [[52, 70, 58], [74, 92, 70]], soil: [[70, 52, 44], [56, 42, 36]],
    rock: [[112, 96, 88], [96, 84, 80], [124, 108, 96], [88, 78, 76]], pebble: [140, 126, 116],
    back: [[52, 46, 48], [40, 36, 40]], scorch: [20, 16, 16], boulders: 0.8,
  },
  volcanic: {
    grass: [[60, 54, 52], [80, 70, 64]], soil: [[54, 44, 42], [42, 36, 36]], noGrass: true,
    rock: [[64, 60, 62], [48, 46, 50], [78, 72, 72], [40, 38, 42]], pebble: [96, 90, 92],
    back: [[34, 30, 32], [26, 24, 26]], scorch: [14, 10, 10], boulders: 0.75,
  },
  asteroid: {
    grass: [[120, 116, 130], [150, 144, 160]], soil: [[92, 86, 100], [76, 70, 84]],
    rock: [[118, 110, 116], [98, 92, 100], [134, 124, 124], [88, 84, 94]], pebble: [160, 150, 150],
    back: [[40, 38, 50], [30, 28, 40]], scorch: [22, 18, 20], ice: [150, 200, 230], noTop: true,
  },
}
const mix = (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t]

/** Everything derived from the mask. dIn: depth into solid; dOut: distance from solid. */
export function derive(m, themeName = 'meadow') {
  const T = THEMES[themeName]
  const { solid, back } = m
  const dIn = edt(i => solid[i] === 1)
  const dOut = edt(i => solid[i] === 0)
  // albedo RGBA (A = 255 solid, 128 backdrop wall, 0 air)
  const albedo = new Uint8ClampedArray(W * H * 4)
  const relief = new Float32Array(W * H)
  const scorch = m.spec.scorch || []
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const i = y * W + x, o = i * 4
    if (solid[i]) {
      const d = dIn[i]
      // inward gradient => which way the nearest surface faces
      const gx = (dIn[i + 1] || 0) - (dIn[i - 1] || 0), gy = (dIn[i + W] || 0) - (dIn[i - W] || 0)
      const gl = Math.hypot(gx, gy) || 1
      const up = gy / gl // 1 when surface is directly above
      const warp = fbm(x * 0.02, y * 0.02, 3, 11)
      // strata
      const band = (y * 0.045 + warp * 3.2 + fbm(x * 0.004, 0, 2, 12) * 4) % 4
      const bi = Math.floor(band), bt = band - bi
      let c = mix(T.rock[bi % 4], T.rock[(bi + 1) % 4], Math.pow(bt, 6))
      const grain = fbm(x * 0.25, y * 0.25, 3, 13)
      c = mix(c, [c[0] * 0.75, c[1] * 0.75, c[2] * 0.78], Math.max(0, grain - 0.45) * 1.8)
      // pebbles / cracks
      // embedded boulders: rounded relief + slightly different stone
      const [b1, b2, bid] = cell2(x * 0.022 + warp * 0.6, y * 0.03 + warp * 0.4, 21)
      const edge = b2 - b1
      let rel = 0
      if (bid > (T.boulders ?? 0.62) && d > 10) {
        const dome = Math.min(1, edge * 2.2)
        rel = Math.sqrt(dome)
        const st = mix([124, 118, 110], [96, 92, 90], hash(Math.floor(bid * 1e4), 3, 4))
        c = mix(c, st, Math.min(1, dome * 4) * 0.85)
        if (dome < 0.12) c = mix(c, [40, 34, 30], (0.12 - dome) * 5)
      }
      // strata ledges
      rel = Math.max(rel, 0.25 * Math.pow(bt, 3) + 0.2 * grain)
      relief[i] = rel
      const cl = cell(x * 0.07, y * 0.07, 14)
      if (cl < 0.22) c = mix(c, T.pebble, (0.22 - cl) * 3.2)
      const crack = cell(x * 0.018 + warp, y * 0.03, 15)
      if (crack > 0.62 && crack < 0.65) c = mix(c, [c[0] * 0.7, c[1] * 0.7, c[2] * 0.7], 0.35)
      // soil & grass on up-facing surfaces
      const soilDepth = 26 + warp * 16
      if (!T.noTop && up > 0.25 && d < soilDepth) {
        const st = Math.min(1, (soilDepth - d) / 8) * Math.min(1, (up - 0.25) * 3)
        c = mix(c, mix(T.soil[0], T.soil[1], grain), st)
      }
      const grassDepth = 5 + fbm(x * 0.3, 0, 2, 16) * 7
      if (!T.noTop && up > 0.35 && d < grassDepth) {
        const gt = Math.min(1, (up - 0.35) * 4)
        const gc = mix(T.grass[0], T.grass[1], fbm(x * 0.1, y * 0.1, 2, 17))
        c = mix(c, gc, gt)
      }
      for (const s of scorch) {
        const r = Math.hypot(x - s.x, y - s.y)
        if (r < s.r) { const t = Math.min(1, (1 - r / s.r) * 2.2) * (0.75 + fbm(x * 0.1, y * 0.1, 3, 18) * 0.35); c = mix(c, T.scorch, Math.min(1, t)) }
      }
      albedo[o] = c[0]; albedo[o + 1] = c[1]; albedo[o + 2] = c[2]; albedo[o + 3] = 255
    } else if (back[i]) {
      const g = fbm(x * 0.03, y * 0.03, 4, 19)
      let c = mix(T.back[0], T.back[1], g)
      const cl = cell(x * 0.05, y * 0.05, 20); if (cl < 0.2) c = mix(c, [c[0] * 1.3, c[1] * 1.3, c[2] * 1.3], 0.5)
      for (const s of scorch) { const r = Math.hypot(x - s.x, y - s.y); if (r < s.r) c = mix(c, T.scorch, Math.min(1, (1 - r / s.r) * 0.9)) }
      albedo[o] = c[0]; albedo[o + 1] = c[1]; albedo[o + 2] = c[2]; albedo[o + 3] = 128
    }
  }
  // grass fringe: blades drawn into AIR above up-facing surfaces (visual only; alpha 200 marks it)
  if (T.grass && themeName !== 'asteroid' && !T.noGrass) for (let x = 0; x < W; x++) for (let y = 1; y < H; y++) {
    const i = y * W + x
    if (!solid[i] || solid[i - W]) continue
    let burnt = false; for (const s of scorch) if (Math.hypot(x - s.x, y - s.y) < s.r) burnt = true
    if (burnt) continue
    const r = hash(x, 7, 99), clump = fbm(x * 0.08, y * 0.02, 2, 98)
    const hb = Math.floor((2 + 11 * r * r * r) * (0.5 + clump))
    for (let k = 1; k <= hb; k++) {
      const j = (y - k) * W + x; if (y - k < 0 || solid[j]) break
      const t = k / (hb + 1)
      const c = mix(T.grass[0], [T.grass[1][0] * 1.25, T.grass[1][1] * 1.2, T.grass[1][2] * 1.1], t)
      albedo[j * 4] = c[0] * 0.9; albedo[j * 4 + 1] = c[1] * 0.9; albedo[j * 4 + 2] = c[2] * 0.9; albedo[j * 4 + 3] = 200
    }
  }
  return { ...m, dIn, dOut, albedo, relief }
}

/** surface points: top of solid at column x, first solid y at or below y0 */
export function groundAt(m, x, y0 = 0) {
  x = Math.round(x)
  for (let y = Math.max(0, Math.round(y0)); y < H; y++) if (m.solid[y * W + x]) return y
  return H
}
