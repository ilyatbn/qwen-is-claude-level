/**
 * T23.22 — the picture gates' shared legs: one Level A gate per reference (`look-gate-f1` … `-f7`) and the live
 * comparison (`look-live`). Two shapes of Level A exist and each is one function here, so the seven gates cannot drift
 * apart in how they judge (CLAUDE.md: share the guard, or share the function):
 *
 * - `worldGate` — a scene's world (`&only=world`) against the mockup's world, every `look-thresholds.json` metric of
 *   this page's back end (R25), regions + actor boxes, and each must-fail control must fail at least one metric
 *   (`look-gate-f1`/`-f3`'s method; F2 and F5 use it).
 * - `actorGate` — a cast sheet (F4/F6/F7) on its actor boxes, `deltaE_actors` within the back end's actor threshold, in
 *   the reference harness's browser (`actor-atlas` §1 says why), each knob must fail.
 *
 * And `liveBounds`, Level B's bounds (M23-art.md § Verification, T23.22 step 2): per distribution metric, the midpoint
 * of the **spread of the approved looks** (the largest distance among F1, F2, F3 — three owner-approved pictures of one
 * art direction) and the **must-fail control** (F0, today's look, against the reference). R19's rule — floor, smallest
 * control, threshold between — with the floor being "as far as two approved pictures sit apart". A metric whose control
 * does not clear its floor cannot tell F0 from the look and is dropped, by name.
 */
import { writeFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'
import { actorBoxes, areaDelta, boxesDeltaE, compare, failures, loadPng, thresholdsFor } from './look-compare.mjs'
import { HIGH_QUALITY_KEY } from './check-tier.mjs'
import { chromePath, libDir } from './browser-args.mjs'

const root = join(dirname(fileURLToPath(import.meta.url)), '../..')
const require = createRequire(join(root, 'client/package.json'))
const { PNG } = require('pngjs')
export const ref = (p) => join(root, 'tasks/M23/reference', p)
export const RAW = JSON.parse((await import('node:fs')).readFileSync(join(root, 'scripts/lib/look-thresholds.json'), 'utf8'))
/** `render.mjs`'s flags (`actor-atlas.mjs::REFERENCE_ARGS`, repeated here so a lib does not import a check). */
const REFERENCE_ARGS = ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist']

export const decode = (f) => ({ width: f.w, height: f.h, data: Uint8Array.from(Buffer.from(f.rgba, 'base64')), view: f.view })

export function writeFrame(img, name) {
  writeFileSync(join(root, 'shots', name), PNG.sync.write(Object.assign(new PNG({ width: img.width, height: img.height }), { data: Buffer.from(img.data) })))
}

/** `a | b`, 8 px apart, into `shots/<name>`. */
export function sideBySide(a, b, name) {
  const out = new PNG({ width: a.width + b.width + 8, height: Math.max(a.height, b.height) })
  out.data.fill(255)
  for (const [img, x0] of [[a, 0], [b, a.width + 8]]) {
    for (let y = 0; y < img.height; y++) {
      Buffer.from(img.data.buffer, img.data.byteOffset + y * img.width * 4, img.width * 4).copy(out.data, (y * out.width + x0) * 4)
    }
  }
  writeFileSync(join(root, 'shots', name), PNG.sync.write(out))
}

/** Mean and max |Δ| per channel between two same-size frames (levels) — how far a control moved the picture at all. */
export function frameDelta(a, b) {
  let sum = 0
  let max = 0
  let n = 0
  for (let i = 0; i < a.data.length; i += 4) {
    for (let c = 0; c < 3; c++) {
      const d = Math.abs(a.data[i + c] - b.data[i + c])
      sum += d
      if (d > max) max = d
      n++
    }
  }
  return { mean: n ? sum / n : 0, max }
}

/** The look-lab's `scene` with `extra` query, drawn: its frame (the world canvas), what it described, the renderer. */
export async function labScene(page, origin, scene, extra = '') {
  await page.goto(`${origin}/?look=${scene}${extra}`, { waitUntil: 'load' })
  await page.waitForFunction(() => window.__look && (window.__look.ready || window.__look.error) && !!window.__world, null, { timeout: 120_000 })
  const look = await page.evaluate(() => JSON.parse(JSON.stringify(window.__look)))
  if (look.error) throw new Error(`look-lab ${scene}${extra}: ${look.error}`)
  const frame = decode(await page.evaluate(() => window.__world.readFrame()))
  const info = await page.evaluate(() => ({ info: window.__world.info(), lit: window.__world.litTerrain(), atmos: window.__world.atmosphere(), actors: window.__world.actors() }))
  return { look, frame, ...info }
}

/**
 * Level A on a scene's world. `controls`: `{ name, extra }` lab knobs (or another scene: `{ name, scene, extra }`), each
 * of which must fail at least one gating metric. `skips`: metrics printed and not gated (each with its reason at the
 * caller). `areas`: `look-thresholds.json` `boxes` (the moon's `bloomBox` / `bloomHalo`) judged as extra metrics —
 * mean |Δ| over the area, within the set's box threshold — because whole-frame metrics cannot see the bloom (measured
 * by `look-gate-f1`: the mockup's own bloom-off passes every one of them). Returns the problems; logs the table. Full
 * tier, 1280×720.
 */
export async function worldGate({ page, origin, scene, reference, regions, controls, skips = [], areas = [], log, shotName }) {
  const problems = []
  const refImg = loadPng(ref(reference))
  await page.evaluate((k) => localStorage.setItem(k, '1'), HIGH_QUALITY_KEY)
  const full = await labScene(page, origin, scene, '&only=world')
  const TH = thresholdsFor(RAW, full.info.gpu)
  log(`renderer ${JSON.stringify(full.info.gpu)} → the ${TH.backEnd} threshold set (R25)`)
  const i = full.info
  if (i.tier !== 'full' || i.buffer[0] !== 1280 || i.buffer[1] !== 720) throw new Error(`want the full tier at 1280x720, got ${JSON.stringify(i)}`)
  if (!full.lit?.drawn) throw new Error(`${scene}: the lit terrain is not drawn: ${JSON.stringify(full.lit)}`)
  if (full.look.described.actors !== 0) throw new Error(`${scene} only=world still describes ${full.look.described.actors} actors`)
  writeFrame(full.frame, `${shotName}-lab.png`)
  sideBySide(full.frame, refImg, `${shotName}-vs-reference.png`)
  /** The compare metrics plus each area's delta; the thresholds the same way. */
  const judge = (frame) => {
    const m = compare(frame, refImg, { regions })
    const bad = failures(m, TH).filter((k) => !skips.includes(k))
    for (const a of areas) {
      m[a] = areaDelta(frame, refImg, TH.box[a])
      if (m[a] > TH.box[a].threshold) bad.push(a)
    }
    return { m, bad }
  }
  const limits = { ...TH.metrics, ...Object.fromEntries(areas.map((a) => [a, TH.box[a]])) }
  const { m, bad } = judge(full.frame)
  log(`1. Level A — look-lab ${scene} world vs reference/${reference} (full tier, ${Object.keys(limits).length} metrics):`)
  const smallest = {}
  const rows = []
  for (const c of controls) {
    const f = await labScene(page, origin, c.scene ?? scene, `&only=world${c.extra ?? ''}`)
    const { m: cm, bad: cbad } = judge(f.frame)
    rows.push({ name: c.name, cm, cbad, moved: frameDelta(f.frame, full.frame) })
    for (const k of cbad) if (!(k in smallest) || cm[k] < smallest[k].v) smallest[k] = { v: cm[k], name: c.name }
  }
  log(`   ${'metric'.padEnd(15)} ${'value'.padStart(10)}  ${'threshold'.padEnd(10)} ${'floor'.padEnd(6)} smallest failing control`)
  for (const [k, t] of Object.entries(limits)) {
    const s = smallest[k] ? `${smallest[k].name} ${smallest[k].v.toFixed(5)}` : '—'
    log(`   ${k.padEnd(15)} ${m[k].toFixed(5).padStart(10)}  ${String(t.threshold).padEnd(10)} ${String(t.floor).padEnd(6)} ${s}  ${skips.includes(k) ? 'reported' : bad.includes(k) ? 'FAIL' : 'ok'}`)
  }
  if (bad.length) problems.push(`${scene} world outside its thresholds: ${bad.join(', ')}`)
  for (const r of rows) {
    log(`2. control ${r.name}: fails ${r.cbad.length}/${Object.keys(limits).length} (${r.cbad.join(', ') || 'none'}); moved the lab's frame by mean ${r.moved.mean.toFixed(3)}, max ${r.moved.max} levels`)
    if (!r.cbad.length) problems.push(`control ${r.name} passes every threshold — the gate cannot see it`)
  }
  log(`side by side (lab | mockup): shots/${shotName}-vs-reference.png`)
  return { problems, metrics: m, TH }
}

/**
 * Level A on a cast sheet's actor boxes, in the reference harness's browser. `knobs`: lab query fragments that must
 * each fail (`deltaE_actors` over the threshold). `count`: the actors the scene must describe and the renderer lay out.
 * `base`: a query fragment on every render, the subject's and each control's (F4's `&knob=fx-off`: its reference has
 * the fx and text taken out).
 */
export async function actorGate({ origin, scene, reference, knobs, count, take, base = '', log, shotName }) {
  const problems = []
  // `take`: the first n boxes only (F6's 22 grid boxes — its 1× row is `weapons-held`'s to report, not gate).
  const boxes = actorBoxes(scene).slice(0, take ?? Infinity)
  const refImg = loadPng(ref(reference))
  const browser = await (require('playwright-core').chromium).launch({ executablePath: chromePath, env: { ...process.env, LD_LIBRARY_PATH: libDir }, headless: true, args: REFERENCE_ARGS })
  try {
    const own = await browser.newPage({ viewport: { width: 1280, height: 720 }, deviceScaleFactor: 1 })
    await own.goto(`${origin}/?e2e=1`, { waitUntil: 'load' })
    await own.evaluate((k) => localStorage.setItem(k, '1'), HIGH_QUALITY_KEY)
    const on = await labScene(own, origin, scene, `&e2e=1${base}`)
    const TH = thresholdsFor(RAW, on.info.gpu)
    const T = TH.actors
    log(`renderer ${JSON.stringify(on.info.gpu)} → the ${TH.backEnd} set's actor threshold ${T.threshold} (floor ${T.floor ?? 0})`)
    if (TH.backEnd !== 'swiftshader') throw new Error(`${scene}'s cast reference is SwiftShader's; the ${TH.backEnd} set has none`)
    if (on.info.tier !== 'full') throw new Error(`want the full tier, got ${on.info.tier}`)
    if (count !== undefined && (on.look.described.actors !== count || on.actors.quads !== count)) {
      problems.push(`counted: described ${on.look.described.actors}, quads ${on.actors.quads}, want ${count}`)
    }
    const d = boxesDeltaE(on.frame, refImg, boxes)
    const ctl = []
    for (const k of knobs) {
      const c = await labScene(own, origin, scene, `&e2e=1${base}${k}`)
      ctl.push({ k, d: boxesDeltaE(c.frame, refImg, boxes) })
    }
    const least = ctl.filter((c) => c.d > T.threshold).sort((a, b) => a.d - b.d)[0]
    log(`1. Level A — look-lab ${scene} vs reference/${reference} on ${boxes.length} actor boxes:`)
    log(`   deltaE_actors ${d.toFixed(5)}  threshold ${T.threshold}  floor ${T.floor ?? 0}  smallest failing control ${least ? `${least.k} ${least.d.toFixed(5)}` : '—'}  ${d <= T.threshold ? 'ok' : 'FAIL'}`)
    if (!(d <= T.threshold)) problems.push(`${scene}: deltaE_actors ${d.toFixed(5)} > ${T.threshold}`)
    for (const c of ctl) {
      log(`2. control ${c.k}: ${c.d.toFixed(5)} ${c.d > T.threshold ? 'fails, as it must' : 'PASSES — the gate cannot see it'}`)
      if (!(c.d > T.threshold)) problems.push(`control ${c.k} passed (${c.d.toFixed(5)})`)
    }
    writeFrame(on.frame, `${shotName}-lab.png`)
    sideBySide(on.frame, refImg, `${shotName}-vs-reference.png`)
    log(`side by side (lab | mockup): shots/${shotName}-vs-reference.png`)
    return { problems, d, T }
  } finally {
    await browser.close()
  }
}

/** Level B's distribution metrics (`look-compare.mjs::compare`'s, M23-art.md § Verification's list). */
export const LIVE_METRICS = ['lumaW1', 'p5', 'p50', 'p95', 'paletteDE', 'satW1', 'edgeDensity', 'bloomFrac']

/**
 * Level B's bounds against `reference` (a loaded PNG): per metric, floor = the largest distance between two of F1, F2,
 * F3; control = F0 against the reference; bound = their midpoint. `dropped`: metrics whose control does not clear the
 * floor (it cannot be told from an approved look on them).
 */
export function liveBounds(reference) {
  const F = ['F1-night-combat.png', 'F2-volcanic-night.png', 'F3-space.png'].map((n) => loadPng(ref(n)))
  const pairs = [compare(F[0], F[1]), compare(F[0], F[2]), compare(F[1], F[2])]
  const f0 = compare(loadPng(ref('F0-today-same-scene.png')), reference)
  const bounds = {}
  const dropped = []
  for (const k of LIVE_METRICS) {
    const floor = Math.max(...pairs.map((p) => p[k]))
    if (!(f0[k] > floor)) {
      dropped.push(k)
      continue
    }
    bounds[k] = { floor, control: f0[k], bound: (floor + f0[k]) / 2 }
  }
  return { bounds, dropped }
}
