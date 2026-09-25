// T23.02 — `look-compare`: how far a rendered frame is from an M23 reference picture.
//
//   node scripts/lib/look-compare.mjs <reference.png> <candidate.png> [--regions map.png] [--json]
//
// Every metric is a **distance** (0 = identical, larger = further), so every threshold in
// `look-thresholds.json` is a maximum. Thresholds are measured, never picked (M23-art.md
// § Verification): each sits between the noise floor (the mockup rendered twice) and the
// smallest must-fail control, and both numbers are written beside it.
//
// FLIP: wrapped only if `python3 -c "import flip_evaluator"` succeeds. It does not on this box
// (2026-09-25), so the report says "not computed" — a FLIP number is never printed that was
// not computed.

import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '../..')
const { PNG } = createRequire(join(root, 'client/package.json'))('pngjs')

/** Region ids in a region-map PNG's red channel (`reference/controls/regions-*.png`). */
export const REGIONS = { 1: 'sky', 2: 'terrain', 3: 'cave', 4: 'actors' }
/**
 * The bloom threshold on the *output* image. The mockup blooms linear HDR luminance above
 * 0.7 (`variant_F1.js` bloom[2]) before ACES at exposure 1.1: ACES(0.77) ≈ 0.55 linear ≈ 0.77
 * sRGB ≈ 196. A pixel this bright on screen is one the bloom pass fed on.
 */
export const BLOOM_LUMA = 196
/** Sobel magnitude (luma levels) above which a pixel counts as an edge. */
export const EDGE_SOBEL = 48

export function loadPng(path) {
  const p = PNG.sync.read(readFileSync(path))
  return { width: p.width, height: p.height, data: p.data }
}

const luma = (d, i) => 0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2]
const lin = c => ((c /= 255) <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4)

/** sRGB 8-bit → CIE Lab (D65). */
export function lab(r, g, b) {
  const R = lin(r), G = lin(g), B = lin(b)
  const f = t => (t > 216 / 24389 ? Math.cbrt(t) : (24389 / 27 * t + 16) / 116)
  const x = f((0.4124 * R + 0.3576 * G + 0.1805 * B) / 0.95047)
  const y = f(0.2126 * R + 0.7152 * G + 0.0722 * B)
  const z = f((0.0193 * R + 0.1192 * G + 0.9505 * B) / 1.08883)
  return [116 * y - 16, 500 * (x - y), 200 * (y - z)]
}

/** CIEDE2000 (Sharma, Wu & Dalal 2005). */
export function deltaE2000([L1, a1, b1], [L2, a2, b2]) {
  const rad = Math.PI / 180
  const C1 = Math.hypot(a1, b1), C2 = Math.hypot(a2, b2), Cb = (C1 + C2) / 2
  const G = 0.5 * (1 - Math.sqrt(Cb ** 7 / (Cb ** 7 + 25 ** 7)))
  const ap1 = (1 + G) * a1, ap2 = (1 + G) * a2
  const Cp1 = Math.hypot(ap1, b1), Cp2 = Math.hypot(ap2, b2)
  const hue = (b, a) => (b === 0 && a === 0 ? 0 : (Math.atan2(b, a) / rad + 360) % 360)
  const hp1 = hue(b1, ap1), hp2 = hue(b2, ap2)
  const dL = L2 - L1, dC = Cp2 - Cp1
  let dh = 0
  if (Cp1 * Cp2 !== 0) { dh = hp2 - hp1; if (dh > 180) dh -= 360; else if (dh < -180) dh += 360 }
  const dH = 2 * Math.sqrt(Cp1 * Cp2) * Math.sin((dh / 2) * rad)
  const Lb = (L1 + L2) / 2, Cpb = (Cp1 + Cp2) / 2
  let hb = hp1 + hp2
  if (Cp1 * Cp2 !== 0) hb = Math.abs(hp1 - hp2) <= 180 ? hb / 2 : (hb < 360 ? (hb + 360) / 2 : (hb - 360) / 2)
  const T = 1 - 0.17 * Math.cos((hb - 30) * rad) + 0.24 * Math.cos(2 * hb * rad) + 0.32 * Math.cos((3 * hb + 6) * rad) - 0.2 * Math.cos((4 * hb - 63) * rad)
  const SL = 1 + (0.015 * (Lb - 50) ** 2) / Math.sqrt(20 + (Lb - 50) ** 2), SC = 1 + 0.045 * Cpb, SH = 1 + 0.015 * Cpb * T
  const RT = -2 * Math.sqrt(Cpb ** 7 / (Cpb ** 7 + 25 ** 7)) * Math.sin(60 * Math.exp(-(((hb - 275) / 25) ** 2)) * rad)
  return Math.sqrt((dL / SL) ** 2 + (dC / SC) ** 2 + (dH / SH) ** 2 + RT * (dC / SC) * (dH / SH))
}

/** Luminance at ½ scale (2×2 box), the SSIM input. */
function halfLuma(img) {
  const w = img.width >> 1, h = img.height >> 1, out = new Float64Array(w * h)
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    let s = 0
    for (const [dx, dy] of [[0, 0], [1, 0], [0, 1], [1, 1]]) s += luma(img.data, ((2 * y + dy) * img.width + 2 * x + dx) * 4)
    out[y * w + x] = s / 4
  }
  return { w, h, v: out }
}

/** Separable 11-tap Gaussian (σ 1.5), clamped edges. */
function blur({ w, h, v }) {
  const k = []; let ks = 0
  for (let i = -5; i <= 5; i++) { k.push(Math.exp(-(i * i) / (2 * 1.5 * 1.5))); ks += k[k.length - 1] }
  const t = new Float64Array(w * h), o = new Float64Array(w * h)
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    let s = 0; for (let i = -5; i <= 5; i++) s += k[i + 5] * v[y * w + Math.min(w - 1, Math.max(0, x + i))]; t[y * w + x] = s / ks
  }
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    let s = 0; for (let i = -5; i <= 5; i++) s += k[i + 5] * t[Math.min(h - 1, Math.max(0, y + i)) * w + x]; o[y * w + x] = s / ks
  }
  return o
}

/** Mean SSIM (Wang et al. 2004, K1 .01, K2 .03, L 255) on ½-scale luminance. */
export function ssim(a, b) {
  const A = halfLuma(a), B = halfLuma(b), n = A.v.length
  const prod = (x, y) => ({ w: A.w, h: A.h, v: x.map((q, i) => q * y[i]) })
  const ma = blur(A), mb = blur(B), saa = blur(prod(A.v, A.v)), sbb = blur(prod(B.v, B.v)), sab = blur(prod(A.v, B.v))
  const C1 = (0.01 * 255) ** 2, C2 = (0.03 * 255) ** 2
  let s = 0
  for (let i = 0; i < n; i++) {
    const va = saa[i] - ma[i] ** 2, vb = sbb[i] - mb[i] ** 2, cov = sab[i] - ma[i] * mb[i]
    s += ((2 * ma[i] * mb[i] + C1) * (2 * cov + C2)) / ((ma[i] ** 2 + mb[i] ** 2 + C1) * (va + vb + C2))
  }
  return s / n
}

/** Per-image statistics that do not need the other image. */
function stats(img) {
  const { width: w, height: h, data: d } = img, n = w * h
  const lumaHist = new Float64Array(256), satHist = new Float64Array(32), Y = new Float64Array(n)
  let bright = 0, edges = 0
  for (let i = 0; i < n; i++) {
    const o = i * 4, y = luma(d, o); Y[i] = y
    lumaHist[Math.min(255, Math.round(y))]++
    const mx = Math.max(d[o], d[o + 1], d[o + 2]), mn = Math.min(d[o], d[o + 1], d[o + 2])
    satHist[Math.min(31, Math.floor((mx === 0 ? 0 : (mx - mn) / mx) * 32))]++
    if (y >= BLOOM_LUMA) bright++
  }
  for (let y = 1; y < h - 1; y++) for (let x = 1; x < w - 1; x++) {
    const p = (dx, dy) => Y[(y + dy) * w + x + dx]
    const gx = p(1, -1) + 2 * p(1, 0) + p(1, 1) - p(-1, -1) - 2 * p(-1, 0) - p(-1, 1)
    const gy = p(-1, 1) + 2 * p(0, 1) + p(1, 1) - p(-1, -1) - 2 * p(0, -1) - p(1, -1)
    if (Math.hypot(gx, gy) > EDGE_SOBEL) edges++
  }
  const pct = q => { let c = 0; for (let v = 0; v < 256; v++) { c += lumaHist[v]; if (c >= q * n) return v } return 255 }
  return { n, lumaHist, satHist, p5: pct(0.05), p50: pct(0.5), p95: pct(0.95), bloomFrac: bright / n, edgeDensity: edges / (n - 2 * w - 2 * h + 4), palette: palette(img) }
}

/** Earth mover's distance between two histograms, in bins (normalised by bin count). */
function wasserstein(ha, hb) {
  const sa = ha.reduce((s, v) => s + v, 0), sb = hb.reduce((s, v) => s + v, 0)
  let ca = 0, cb = 0, d = 0
  for (let i = 0; i < ha.length; i++) { ca += ha[i] / sa; cb += hb[i] / sb; d += Math.abs(ca - cb) }
  return d / ha.length
}

/** 8-colour k-means in Lab over every 7th pixel, deterministic (luminance-quantile seeds, 24 rounds). */
export function palette(img, k = 8) {
  const pts = []
  for (let i = 0; i < img.width * img.height; i += 7) pts.push(lab(img.data[i * 4], img.data[i * 4 + 1], img.data[i * 4 + 2]))
  const sorted = [...pts].sort((p, q) => p[0] - q[0])
  let cs = Array.from({ length: k }, (_, j) => sorted[Math.floor(((j + 0.5) / k) * sorted.length)].slice())
  let counts = new Array(k).fill(0)
  for (let round = 0; round < 24; round++) {
    const sum = cs.map(() => [0, 0, 0]); counts = new Array(k).fill(0)
    for (const p of pts) {
      let best = 0, bd = Infinity
      for (let j = 0; j < k; j++) { const dd = (p[0] - cs[j][0]) ** 2 + (p[1] - cs[j][1]) ** 2 + (p[2] - cs[j][2]) ** 2; if (dd < bd) { bd = dd; best = j } }
      counts[best]++; sum[best][0] += p[0]; sum[best][1] += p[1]; sum[best][2] += p[2]
    }
    cs = cs.map((c, j) => (counts[j] ? sum[j].map(s => s / counts[j]) : c))
  }
  return cs.map((c, j) => ({ lab: c, w: counts[j] / pts.length }))
}

/** Population-weighted mean ΔE2000 from each palette colour to the nearest in the other, both ways. */
function paletteDistance(pa, pb) {
  const one = (x, y) => x.reduce((s, c) => s + c.w * Math.min(...y.map(o => deltaE2000(c.lab, o.lab))), 0)
  return (one(pa, pb) + one(pb, pa)) / 2
}

/** Mean ΔE2000 over all pixels, and per region of `regions` (a region-map image, red = id). */
function regionDeltaE(a, b, regions) {
  const sums = { all: 0 }, counts = { all: 0 }
  for (let i = 0; i < a.width * a.height; i++) {
    const o = i * 4
    if (a.data[o] === b.data[o] && a.data[o + 1] === b.data[o + 1] && a.data[o + 2] === b.data[o + 2]) {
      sums.all += 0
    } else {
      const e = deltaE2000(lab(a.data[o], a.data[o + 1], a.data[o + 2]), lab(b.data[o], b.data[o + 1], b.data[o + 2]))
      sums.all += e
      if (regions) { const r = REGIONS[regions.data[o]]; if (r) sums[r] = (sums[r] ?? 0) + e }
    }
    counts.all++
    if (regions) { const r = REGIONS[regions.data[o]]; if (r) counts[r] = (counts[r] ?? 0) + 1 }
  }
  const out = {}
  for (const r of Object.keys(counts)) out[r] = (sums[r] ?? 0) / counts[r]
  return out
}

function flipAvailable() {
  const r = spawnSync('python3', ['-c', 'import flip_evaluator'], { stdio: 'ignore' })
  return r.status === 0
}

/**
 * Every metric, as a distance. `flip` is `null` with a reason when not computed; T23.02 does
 * not wrap the evaluator until it is installed, so today it is always null.
 */
export function compare(a, b, { regions = null } = {}) {
  if (a.width !== b.width || a.height !== b.height) throw new Error(`size mismatch ${a.width}x${a.height} vs ${b.width}x${b.height}`)
  const sa = stats(a), sb = stats(b), de = regionDeltaE(a, b, regions)
  const m = {
    dssim: 1 - ssim(a, b),
    deltaE: de.all,
    lumaW1: wasserstein(sa.lumaHist, sb.lumaHist),
    p5: Math.abs(sa.p5 - sb.p5),
    p50: Math.abs(sa.p50 - sb.p50),
    p95: Math.abs(sa.p95 - sb.p95),
    paletteDE: paletteDistance(sa.palette, sb.palette),
    satW1: wasserstein(sa.satHist, sb.satHist),
    edgeDensity: Math.abs(sa.edgeDensity - sb.edgeDensity),
    bloomFrac: Math.abs(sa.bloomFrac - sb.bloomFrac),
  }
  for (const r of Object.values(REGIONS)) if (de[r] !== undefined) m[`deltaE_${r}`] = de[r]
  m.flip = null
  m.flipNote = flipAvailable() ? 'flip_evaluator is installed but not wrapped yet: not computed' : 'flip_evaluator not installed: not computed'
  return m
}

/** Which retained metrics exceed their threshold. `thresholds.metrics[name].threshold` is a max. */
export function failures(metrics, thresholds) {
  return Object.entries(thresholds.metrics).filter(([k, t]) => metrics[k] > t.threshold).map(([k]) => k)
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2)
  const ri = args.indexOf('--regions')
  const regions = ri >= 0 ? loadPng(args.splice(ri, 2)[1]) : null
  const json = args.includes('--json')
  const [ra, rb] = args.filter(x => !x.startsWith('--'))
  const m = compare(loadPng(ra), loadPng(rb), { regions })
  const th = JSON.parse(readFileSync(join(root, 'scripts/lib/look-thresholds.json'), 'utf8'))
  const bad = failures(m, th)
  if (json) console.log(JSON.stringify({ metrics: m, failures: bad }, null, 1))
  else {
    for (const [k, v] of Object.entries(m)) if (typeof v === 'number') console.log(`${k.padEnd(14)} ${v.toFixed(5).padStart(12)}${th.metrics[k] ? `  max ${th.metrics[k].threshold}${bad.includes(k) ? '  FAIL' : ''}` : ''}`)
    console.log(`flip           ${m.flipNote}`)
    console.log(bad.length ? `FAIL: ${bad.join(', ')}` : 'PASS')
  }
  process.exit(bad.length ? 1 : 0)
}
